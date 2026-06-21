-- Capricorn Lead-Ops Phase 3: in-app discovery runs.
-- The webapp enqueues a run (status 'queued') and fires a GitHub Actions
-- workflow; the worker (service role) updates this row through 'running' to
-- 'succeeded'/'failed', writing progress and the Google Sheet URL.
-- Run via: supabase db push, or paste in the Supabase SQL editor. Idempotent.

create table if not exists pipeline_runs (
  id                uuid primary key default gen_random_uuid(),
  country           text not null,
  target_leads      int not null default 25,
  status            text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','cancelled')),
  stage             text,                 -- human-readable current stage
  -- progress counters (filled by the worker as it goes)
  discovered_count  int,
  enriched_count    int,
  qualified_count   int,
  leads_delivered   int,
  -- result
  sheet_url         text,
  sheet_id          text,
  error             text,
  -- cost accounting (worker writes after the run)
  explorium_credits int,
  anthropic_usd     numeric,
  -- provenance / control
  batch_label       text,                 -- e.g. discovery_spain_2026-06-12
  requested_by      uuid references auth.users(id),
  gh_run_url        text,                 -- the GitHub Actions run, for debugging
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists pipeline_runs_status_idx     on pipeline_runs (status);
create index if not exists pipeline_runs_created_at_idx  on pipeline_runs (created_at desc);

-- updated_at trigger (reuse the helper from 0001)
drop trigger if exists trg_pipeline_runs_updated_at on pipeline_runs;
create trigger trg_pipeline_runs_updated_at before update on pipeline_runs
  for each row execute function touch_updated_at();

-- RLS: allowlisted users may read all runs and create new ones; status
-- transitions belong to the worker, which uses the service role (bypasses RLS).
alter table pipeline_runs enable row level security;

drop policy if exists "pipeline_runs_select_allowed" on pipeline_runs;
create policy "pipeline_runs_select_allowed" on pipeline_runs
  for select using (is_allowed_user());

drop policy if exists "pipeline_runs_insert_allowed" on pipeline_runs;
create policy "pipeline_runs_insert_allowed" on pipeline_runs
  for insert with check (is_allowed_user());

-- Realtime: the Discovery page watches runs drain queued -> running -> succeeded.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'pipeline_runs') then
    alter publication supabase_realtime add table pipeline_runs;
  end if;
end $$;
