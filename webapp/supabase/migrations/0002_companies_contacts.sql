-- Capricorn Lead-Ops Phase 2.5: companies/contacts split + email drafts queue.
-- Run via: supabase db push, or paste in the Supabase SQL editor.
-- Idempotent: safe to re-run. The data-migration section only runs while the
-- old `leads` table still exists (it is renamed to leads_legacy at the end).

-- ─────────────────────────────────────────────────────────────────
-- FIX (carried from 0001): is_allowed_user() was invoker-rights and
-- selected from app_users, whose own select policy calls
-- is_allowed_user() — infinite policy recursion for any authenticated
-- query. SECURITY DEFINER makes the helper read app_users as the
-- table owner (bypassing its RLS), which breaks the cycle for every
-- policy in 0001 and below.
-- ─────────────────────────────────────────────────────────────────
create or replace function is_allowed_user()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from app_users
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ─────────────────────────────────────────────────────────────────
-- companies — one row per company. Dedup key in practice is
-- (name_key, country) because business_id is null on all synced rows.
-- ─────────────────────────────────────────────────────────────────
create table if not exists companies (
  id                    uuid primary key default gen_random_uuid(),
  business_id           text unique,
  company_name          text not null,
  name_key              text generated always as (lower(btrim(company_name))) stored,
  website               text,
  industry              text,
  country               text,
  city                  text,
  employee_count        text,
  estimated_revenue     text,
  description           text,
  linkedin_company_page text,
  icp_tier              text check (icp_tier in ('Tier 1','Tier 2','Tier 3') or icp_tier is null),
  icp_score             int,
  deal_probability      numeric,
  business_model        text,
  judge_pattern         text,
  judge_reason          text,
  import_evidence       text,
  own_brand_evidence    text,
  third_party_brands    text,
  evidence_urls         text,
  what_to_sell_gaps     text,
  needs_human_check     text,
  iteration             int,
  batch_label           text,
  status                text not null default 'new'
    check (status in ('new','contacted','replied','meeting','won','not_interested','archived')),
  status_changed_at     timestamptz not null default now(),
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create unique index if not exists companies_namekey_country_uniq
  on companies (name_key, coalesce(lower(country), ''));
create index if not exists companies_status_idx       on companies (status);
create index if not exists companies_country_tier_idx on companies (country, icp_tier);
create index if not exists companies_iteration_idx    on companies (iteration);

-- ─────────────────────────────────────────────────────────────────
-- contacts — 1-N per company. `email` is the bare lowercase address;
-- the verification label that used to ride inside the string
-- ("mario@x.com (SMTP-verified)") lives in email_label.
-- ─────────────────────────────────────────────────────────────────
create table if not exists contacts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references companies(id) on delete cascade,
  full_name    text,
  title        text,
  email        text,
  email_label  text,
  linkedin_url text,
  linkedin_key text generated always as
    (nullif(regexp_replace(lower(coalesce(linkedin_url, '')),
                           '^https?://(www\.)?|/+$', '', 'g'), '')) stored,
  phone        text,
  is_primary   boolean not null default false,
  source       text not null default 'pipeline' check (source in ('pipeline','manual')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists contacts_company_email_uniq
  on contacts (company_id, lower(email)) where email is not null;
create unique index if not exists contacts_company_linkedin_uniq
  on contacts (company_id, linkedin_key) where linkedin_key is not null and email is null;
create index if not exists contacts_company_idx on contacts (company_id);

-- ─────────────────────────────────────────────────────────────────
-- email_drafts — AI/template drafts; doubles as the send queue.
-- Spacing lives in scheduled_at (stamped by /api/send-queue/start);
-- the cron tick claims one due 'approved' row at a time.
-- ─────────────────────────────────────────────────────────────────
create table if not exists email_drafts (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references companies(id) on delete cascade,
  contact_id          uuid not null references contacts(id) on delete cascade,
  template_id         uuid references templates(id) on delete set null,
  generation_batch_id uuid,
  language            text not null default 'en',
  subject             text not null,
  body                text not null,
  status              text not null default 'draft'
    check (status in ('draft','approved','rejected','sending','sent','failed')),
  error               text,
  send_attempts       int not null default 0,
  scheduled_at        timestamptz,
  sending_started_at  timestamptz,
  approved_at         timestamptz,
  approved_by         uuid references auth.users(id),
  sent_at             timestamptz,
  model               text,
  gen_input_tokens    int,
  gen_output_tokens   int,
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists email_drafts_queue_idx
  on email_drafts (scheduled_at) where status = 'approved';
create index if not exists email_drafts_company_idx on email_drafts (company_id);
create index if not exists email_drafts_status_idx  on email_drafts (status);
create index if not exists email_drafts_batch_idx   on email_drafts (generation_batch_id);

-- ─────────────────────────────────────────────────────────────────
-- email_log — gains company/contact/draft links. lead_id is kept for
-- one release (dropped in 0003 together with leads_legacy).
-- ─────────────────────────────────────────────────────────────────
alter table email_log
  add column if not exists company_id uuid references companies(id) on delete set null,
  add column if not exists contact_id uuid references contacts(id) on delete set null,
  add column if not exists draft_id   uuid references email_drafts(id) on delete set null;
create index if not exists email_log_company_idx on email_log (company_id);
create index if not exists email_log_contact_idx on email_log (contact_id);

-- ─────────────────────────────────────────────────────────────────
-- Triggers
-- ─────────────────────────────────────────────────────────────────
drop trigger if exists trg_companies_updated_at on companies;
create trigger trg_companies_updated_at before update on companies
  for each row execute function touch_updated_at();

drop trigger if exists trg_contacts_updated_at on contacts;
create trigger trg_contacts_updated_at before update on contacts
  for each row execute function touch_updated_at();

drop trigger if exists trg_email_drafts_updated_at on email_drafts;
create trigger trg_email_drafts_updated_at before update on email_drafts
  for each row execute function touch_updated_at();

-- Stamp status_changed_at whenever the funnel status moves.
create or replace function touch_status_changed_at()
returns trigger as $$
begin
  if new.status is distinct from old.status then
    new.status_changed_at = now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_companies_status_changed on companies;
create trigger trg_companies_status_changed before update on companies
  for each row execute function touch_status_changed_at();

-- Auto 'contacted': any logged send escalates a 'new' company. Escalate-only,
-- so a later manual 'replied'/'meeting' is never downgraded. Lives in the DB
-- so every send path (manual route, queue tick) gets it for free.
create or replace function mark_company_contacted()
returns trigger as $$
begin
  if new.company_id is not null then
    update companies
       set status = 'contacted'
     where id = new.company_id and status = 'new';
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_email_log_contacted on email_log;
create trigger trg_email_log_contacted after insert on email_log
  for each row execute function mark_company_contacted();

-- ─────────────────────────────────────────────────────────────────
-- RLS — same allowlist model as 0001. Service role bypasses RLS.
-- ─────────────────────────────────────────────────────────────────
alter table companies    enable row level security;
alter table contacts     enable row level security;
alter table email_drafts enable row level security;

drop policy if exists "companies_select_allowed" on companies;
create policy "companies_select_allowed" on companies
  for select using (is_allowed_user());
drop policy if exists "companies_update_allowed" on companies;
create policy "companies_update_allowed" on companies
  for update using (is_allowed_user()) with check (is_allowed_user());

drop policy if exists "contacts_select_allowed" on contacts;
create policy "contacts_select_allowed" on contacts
  for select using (is_allowed_user());
drop policy if exists "contacts_insert_allowed" on contacts;
create policy "contacts_insert_allowed" on contacts
  for insert with check (is_allowed_user());
drop policy if exists "contacts_update_allowed" on contacts;
create policy "contacts_update_allowed" on contacts
  for update using (is_allowed_user()) with check (is_allowed_user());

drop policy if exists "email_drafts_all_allowed" on email_drafts;
create policy "email_drafts_all_allowed" on email_drafts
  for all using (is_allowed_user()) with check (is_allowed_user());

-- ─────────────────────────────────────────────────────────────────
-- Realtime
-- ─────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'companies') then
    alter publication supabase_realtime add table companies;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'contacts') then
    alter publication supabase_realtime add table contacts;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and tablename = 'email_drafts') then
    alter publication supabase_realtime add table email_drafts;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────
-- Data migration from the flat `leads` table. Runs once: guarded on the
-- existence of `leads`, which is renamed to leads_legacy at the end.
--
-- Old status -> new funnel: new->new, sent->contacted, replied->replied,
-- archived->archived. Duplicate companies (same name+country, one row per
-- contact under the old model) are merged: most-advanced status wins,
-- notes are concatenated.
-- ─────────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.leads') is null then
    return;
  end if;

  -- 1. Companies: one row per (name_key, country) group. Representative row
  --    (for firmographics) = most recently updated.
  insert into companies (
    business_id, company_name, website, industry, country, city,
    employee_count, estimated_revenue, description, linkedin_company_page,
    icp_tier, icp_score, deal_probability, judge_pattern, judge_reason,
    what_to_sell_gaps, needs_human_check, iteration, status, notes,
    created_at
  )
  select distinct on (grp.name_key, grp.country_key)
    grp.any_business_id,
    l.company_name, l.website, l.industry, l.country, l.city,
    l.employee_count, l.estimated_revenue, l.description, l.linkedin_company_page,
    l.icp_tier, l.icp_score, l.deal_probability, l.judge_pattern, l.judge_reason,
    l.what_to_sell_gaps, l.needs_human_check, l.iteration,
    grp.merged_status, grp.merged_notes,
    grp.min_created_at
  from leads l
  join (
    select
      lower(btrim(company_name))             as name_key,
      coalesce(lower(country), '')           as country_key,
      max(business_id)                       as any_business_id,
      min(created_at)                        as min_created_at,
      (array_agg(
         case status
           when 'sent' then 'contacted'
           when 'replied' then 'replied'
           when 'archived' then 'archived'
           else 'new'
         end
         order by array_position(
           array['replied','contacted','archived','new'],
           case status
             when 'sent' then 'contacted'
             when 'replied' then 'replied'
             when 'archived' then 'archived'
             else 'new'
           end)
       ))[1]                                 as merged_status,
      nullif(string_agg(distinct nullif(btrim(notes), ''), E'\n---\n'), '')
                                             as merged_notes
    from leads
    group by 1, 2
  ) grp
    on lower(btrim(l.company_name)) = grp.name_key
   and coalesce(lower(l.country), '') = grp.country_key
  order by grp.name_key, grp.country_key, l.updated_at desc
  on conflict do nothing;

  -- 2. Contacts: one per lead row that has any contact data. Email labels
  --    like "(SMTP-verified)" are split off into email_label.
  insert into contacts (
    company_id, full_name, title, email, email_label, linkedin_url, phone,
    source, created_at
  )
  -- Dedup key prefers the person's name so the same contact appearing once
  -- with an email and once with only a LinkedIn URL collapses to one row
  -- (the email-bearing source row wins via the order by below).
  select distinct on (c.id, coalesce(nullif(lower(btrim(l.contact_name)), ''), parsed.email, lk.linkedin_key))
    c.id,
    nullif(btrim(l.contact_name), ''),
    nullif(btrim(l.contact_title), ''),
    parsed.email,
    parsed.email_label,
    nullif(btrim(l.contact_linkedin_url), ''),
    nullif(btrim(l.contact_phone), ''),
    'pipeline',
    l.created_at
  from leads l
  join companies c
    on c.name_key = lower(btrim(l.company_name))
   and coalesce(lower(c.country), '') = coalesce(lower(l.country), '')
  cross join lateral (
    select
      nullif(lower(btrim(regexp_replace(coalesce(l.contact_email, ''),
                                        '\s*\([^)]*\)\s*$', ''))), '') as email,
      lower((regexp_match(coalesce(l.contact_email, ''), '\(([^)]+)\)\s*$'))[1])
                                                                       as email_label
  ) parsed
  cross join lateral (
    select nullif(regexp_replace(lower(coalesce(l.contact_linkedin_url, '')),
                                 '^https?://(www\.)?|/+$', '', 'g'), '') as linkedin_key
  ) lk
  where coalesce(btrim(l.contact_name), '') <> ''
     or parsed.email is not null
     or lk.linkedin_key is not null
  order by c.id,
           coalesce(nullif(lower(btrim(l.contact_name)), ''), parsed.email, lk.linkedin_key),
           (parsed.email is not null) desc,
           l.updated_at desc
  on conflict do nothing;

  -- 3. Primary contact: per company, prefer a contact with an email.
  update contacts ct
     set is_primary = true
   where ct.id in (
     select distinct on (company_id) id
     from contacts
     order by company_id, (email is not null) desc, created_at asc
   );

  -- 4. Remap email_log (empty today, but generic): match the lead's company,
  --    then the contact by to_email.
  update email_log el
     set company_id = c.id
    from leads l
    join companies c
      on c.name_key = lower(btrim(l.company_name))
     and coalesce(lower(c.country), '') = coalesce(lower(l.country), '')
   where el.lead_id = l.id and el.company_id is null;

  update email_log el
     set contact_id = ct.id
    from contacts ct
   where el.company_id = ct.company_id
     and ct.email is not null
     and lower(el.to_email) = ct.email
     and el.contact_id is null;

  -- 5. Freeze the old table: read-only legacy until 0003 drops it.
  drop policy if exists "leads_update_allowed" on leads;
  alter table leads rename to leads_legacy;

  if exists (select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and tablename = 'leads_legacy') then
    alter publication supabase_realtime drop table leads_legacy;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────
-- Verification (run manually after applying):
--   select count(*) from leads_legacy;                          -- 52
--   select count(*) from companies;                             -- 45
--   select count(*) from contacts;                              -- ~50 (rows with any contact data, deduped)
--   select count(*) from companies where status <> 'new';       -- 0 (all legacy rows were 'new')
--   select company_id from contacts group by 1
--     having count(*) filter (where is_primary) <> 1;           -- no rows
--   select email from contacts where email like '%(%';          -- no rows (labels stripped)
-- ─────────────────────────────────────────────────────────────────
