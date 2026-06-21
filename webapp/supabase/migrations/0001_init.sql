-- Capricorn Lead-Ops webapp initial schema (Phase 2 v1).
-- Run via: supabase db push  (with supabase CLI), or paste in the Supabase
-- SQL editor. Idempotent: safe to re-run.

-- ─────────────────────────────────────────────────────────────────
-- Extensions
-- ─────────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────
-- Allowlist (2 users for v1)
-- ─────────────────────────────────────────────────────────────────
create table if not exists app_users (
  email       text primary key,
  role        text not null check (role in ('admin', 'client')),
  created_at  timestamptz not null default now()
);

insert into app_users (email, role) values
  ('admin@capricorn.local', 'admin'),          -- placeholder admin; replace with real
  ('client@capricorn.example', 'client')       -- placeholder client; replace with real
on conflict (email) do nothing;

-- ─────────────────────────────────────────────────────────────────
-- Leads — upserted from .tmp/leads_*.json by tools/sync_leads_to_supabase.py
-- ─────────────────────────────────────────────────────────────────
create table if not exists leads (
  id                   uuid primary key default gen_random_uuid(),
  business_id          text unique,                 -- Explorium business_id (preferred dedup key)
  company_name         text not null,
  website              text,
  industry             text,
  country              text,
  city                 text,
  employee_count       text,
  estimated_revenue    text,
  description          text,
  linkedin_company_page text,
  icp_tier             text check (icp_tier in ('Tier 1', 'Tier 2', 'Tier 3') or icp_tier is null),
  icp_score            int,
  deal_probability     numeric,
  judge_pattern        text,
  judge_reason         text,
  what_to_sell_gaps    text,
  needs_human_check    text,
  contact_name         text,
  contact_title        text,
  contact_email        text,
  contact_linkedin_url text,
  contact_phone        text,
  iteration            int,
  status               text not null default 'new' check (status in ('new','sent','replied','archived')),
  notes                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index if not exists leads_status_idx       on leads (status);
create index if not exists leads_country_tier_idx on leads (country, icp_tier);
create index if not exists leads_iteration_idx    on leads (iteration);

-- ─────────────────────────────────────────────────────────────────
-- Templates — markdown with {{var}} placeholders
-- ─────────────────────────────────────────────────────────────────
create table if not exists templates (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  subject_template  text not null,
  body_template     text not null,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────
-- Email log — one row per email actually sent through the app
-- ─────────────────────────────────────────────────────────────────
create table if not exists email_log (
  id                uuid primary key default gen_random_uuid(),
  lead_id           uuid references leads(id) on delete set null,
  template_id       uuid references templates(id) on delete set null,
  sent_by           uuid references auth.users(id),
  from_email        text,
  to_email          text,
  subject           text,
  body              text,
  gmail_message_id  text,
  sent_at           timestamptz not null default now()
);
create index if not exists email_log_lead_idx on email_log (lead_id);

-- ─────────────────────────────────────────────────────────────────
-- Integrations — Gmail (and future) OAuth tokens, one row per mailbox
-- ─────────────────────────────────────────────────────────────────
create table if not exists integrations (
  id                 uuid primary key default gen_random_uuid(),
  provider           text not null,
  account_email      text not null,
  access_token       text not null,
  refresh_token      text,
  scope              text,
  token_expires_at   timestamptz,
  owner_user_id      uuid references auth.users(id),
  last_used_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (provider, account_email)
);

-- ─────────────────────────────────────────────────────────────────
-- updated_at triggers
-- ─────────────────────────────────────────────────────────────────
create or replace function touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_leads_updated_at on leads;
create trigger trg_leads_updated_at before update on leads
  for each row execute function touch_updated_at();

drop trigger if exists trg_templates_updated_at on templates;
create trigger trg_templates_updated_at before update on templates
  for each row execute function touch_updated_at();

drop trigger if exists trg_integrations_updated_at on integrations;
create trigger trg_integrations_updated_at before update on integrations
  for each row execute function touch_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- Realtime — push leads + email_log changes to the dashboard
-- ─────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'leads'
  ) then
    alter publication supabase_realtime add table leads;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'email_log'
  ) then
    alter publication supabase_realtime add table email_log;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────
-- Row-Level Security
-- Admin + client see and write. Service role bypasses RLS automatically.
-- ─────────────────────────────────────────────────────────────────
alter table leads        enable row level security;
alter table templates    enable row level security;
alter table email_log    enable row level security;
alter table integrations enable row level security;
alter table app_users    enable row level security;

-- Helper: is the signed-in user on the allowlist?
create or replace function is_allowed_user()
returns boolean as $$
  select exists (
    select 1 from app_users
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$ language sql stable;

-- leads: allowlisted users full access
drop policy if exists "leads_select_allowed" on leads;
create policy "leads_select_allowed" on leads
  for select using (is_allowed_user());
drop policy if exists "leads_update_allowed" on leads;
create policy "leads_update_allowed" on leads
  for update using (is_allowed_user()) with check (is_allowed_user());

-- templates: allowlisted users full CRUD
drop policy if exists "templates_all_allowed" on templates;
create policy "templates_all_allowed" on templates
  for all using (is_allowed_user()) with check (is_allowed_user());

-- email_log: read-only for allowlisted users; service role inserts
drop policy if exists "email_log_select_allowed" on email_log;
create policy "email_log_select_allowed" on email_log
  for select using (is_allowed_user());

-- integrations: allowlisted users see all rows (so admin can see client's
-- Gmail connection status); writes happen via server routes using the
-- service role.
drop policy if exists "integrations_select_allowed" on integrations;
create policy "integrations_select_allowed" on integrations
  for select using (is_allowed_user());

-- app_users: read-only to allowlisted users (so the UI can check role)
drop policy if exists "app_users_select_allowed" on app_users;
create policy "app_users_select_allowed" on app_users
  for select using (is_allowed_user());
