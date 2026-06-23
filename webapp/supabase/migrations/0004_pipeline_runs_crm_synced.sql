-- Capricorn Lead-Ops: close the discovery loop.
-- The worker now syncs qualified leads into companies/contacts at the end of a
-- run (in addition to the Google Sheet). This column records whether that CRM
-- sync succeeded, so the UI can lead with "Review N new companies" and flag a
-- "couldn't add to CRM — retry" state instead of a false green when it fails.
--   null  = not attempted (legacy rows, or run failed before the sync step)
--   true  = leads synced into companies/contacts
--   false = sync failed (the Google Sheet was still delivered)
-- Run via: .tmp/apply_supabase_migration.py, supabase db push, or the SQL editor. Idempotent.

alter table pipeline_runs add column if not exists crm_synced boolean;

comment on column pipeline_runs.crm_synced is
  'Whether discovered leads were synced into companies/contacts. null=not attempted, true=synced, false=sync failed (sheet still delivered).';
