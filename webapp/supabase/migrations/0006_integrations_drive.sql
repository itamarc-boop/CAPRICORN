-- Capricorn Lead-Ops: let the client connect their OWN Google Drive so discovery
-- sheets are created in THEIR Drive (self-serve, like Gmail). A second OAuth
-- integration with provider 'google_drive' (drive.file + spreadsheets scope)
-- lives in the same integrations table. master_sheet_id remembers the one
-- accumulating "Capricorn Leads" sheet per connected Drive so successive runs
-- append to it instead of creating a new sheet each time.
-- Run via: .tmp/apply_supabase_migration.py, supabase db push, or the SQL editor. Idempotent.

alter table integrations add column if not exists master_sheet_id text;

comment on column integrations.master_sheet_id is
  'For provider=google_drive: the spreadsheet the discovery worker appends each run to (in the connected user''s Drive). Null until the first run creates it.';
