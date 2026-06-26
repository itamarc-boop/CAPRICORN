-- Capricorn Lead-Ops 0010: stop exposing OAuth tokens to the browser.
--
-- integrations.access_token / refresh_token are long-lived credentials to send
-- mail (and touch Drive) as the connected account. The only RLS policy on the
-- table is integrations_select_allowed (using is_allowed_user()), and Postgres
-- RLS is ROW-level, not column-level — so any allowlisted browser session, with
-- just the publishable/anon key, could
--     supabase.from('integrations').select('access_token, refresh_token')
-- and read the OTHER party's live mailbox credentials (a client↔admin
-- cross-tenant token leak, and a standing liability before the client runs on
-- their own keys).
--
-- Fix: column-level privileges. Revoke the blanket SELECT from the API roles and
-- re-grant SELECT on only the non-secret columns. RLS still decides WHICH rows
-- are visible; this decides WHICH columns. The send paths and OAuth callbacks
-- use the service_role key, which bypasses this and keeps full access, so the
-- app keeps working. The app's reads (integrations page, dashboard probe) only
-- ever select columns in the grant list below.
--
-- Further hardening (deferred — needs app-level key management): encrypt the
-- token columns at rest so a service-role/DB-dump leak doesn't yield usable
-- tokens. Tracked separately.
--
-- Idempotent: safe to re-run. Run via supabase db push or the SQL editor.

revoke select on table integrations from anon, authenticated;

grant select (
  id, provider, account_email, scope, token_expires_at,
  owner_user_id, last_used_at, created_at, updated_at, master_sheet_id
) on table integrations to anon, authenticated;
