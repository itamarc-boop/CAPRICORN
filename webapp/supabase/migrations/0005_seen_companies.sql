-- Capricorn Lead-Ops: persistent "already tried" store for loop-to-target discovery.
-- Every company the pipeline enriches + judges (qualified OR rejected) is recorded
-- here, keyed by Explorium business_id, so future runs in any market skip it and
-- never re-spend credits on the same company. Replaces the ephemeral local
-- .tmp/seen_companies.json (which doesn't persist across CI runs).
-- Run via: .tmp/apply_supabase_migration.py, supabase db push, or the SQL editor. Idempotent.

create table if not exists seen_companies (
  business_id   text primary key,            -- Explorium business_id (global)
  country       text not null,               -- discovery country (lowercased name)
  company_name  text,
  verdict       text,                         -- 'qualified' | 'rejected'
  run_id        uuid,                         -- the pipeline_runs row that tried it (nullable)
  created_at    timestamptz not null default now()
);

create index if not exists seen_companies_country_idx on seen_companies (country);

comment on table seen_companies is
  'Every company the discovery pipeline enriched + judged, qualified or rejected, so future runs skip already-tried companies.';
