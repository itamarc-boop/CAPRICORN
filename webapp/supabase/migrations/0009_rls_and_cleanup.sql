-- Capricorn Lead-Ops 0009: close two leftover gaps surfaced by the audit.
--
-- 1) seen_companies was the ONLY business table created without Row-Level
--    Security (0005). Under Supabase's default public-schema grants, an
--    RLS-disabled table is reachable with the browser-exposed anon key,
--    bypassing the allowlist — anyone could read the full prospecting list
--    (company names + qualified/rejected verdicts) or delete rows, forcing the
--    pipeline to re-judge (re-bill per record) already-tried companies. Enable
--    RLS + an allowlist SELECT policy. The discovery worker writes with the
--    service role, which bypasses RLS, so the pipeline is unaffected.
--
-- 2) 0002 renamed the flat leads table to leads_legacy and commented that a
--    follow-up migration would drop it and the now-orphaned email_log.lead_id
--    column "in one release". That migration was never written. Do it here:
--    email_log already links via company_id / contact_id / draft_id, so
--    lead_id carries no information (dropping the column also drops its index).
--
-- Run via: supabase db push, .tmp/apply_supabase_migration.py, or the SQL
-- editor. Idempotent: safe to re-run.

-- ── 1. seen_companies RLS ───────────────────────────────────────────────
alter table seen_companies enable row level security;

drop policy if exists "seen_companies_select_allowed" on seen_companies;
create policy "seen_companies_select_allowed" on seen_companies
  for select using (is_allowed_user());

-- ── 2. drop dead legacy cruft ───────────────────────────────────────────
-- Order matters: email_log.lead_id carries a FK (email_log_lead_id_fkey) that
-- references leads_legacy, so the column (and thus the constraint) must go
-- FIRST — otherwise "drop table leads_legacy" fails with a dependency error.
-- We intentionally avoid DROP ... CASCADE so any OTHER unexpected dependent
-- errors loudly instead of being silently dropped.
alter table email_log drop column if exists lead_id;

drop table if exists leads_legacy;
