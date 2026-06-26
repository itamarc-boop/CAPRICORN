-- Capricorn Lead-Ops 0011: at most one LIVE draft per contact.
--
-- Re-clicking "Generate" (or a double-POST / two open tabs) could insert a
-- second email_draft for a contact while the first is still draft/approved/
-- sending/failed; approving both then double-emails the prospect. The generate
-- route now pre-skips contacts that already have a live draft, but only the DB
-- can guarantee it under a race — this partial unique index is that backstop.
--
-- "Live" = draft/approved/sending/failed (all can still lead to a send or be
-- acted on). sent/rejected are terminal, so a contact CAN get a fresh draft
-- after one is sent or rejected. Rows with contact_id IS NULL (custom to_email,
-- no contact) are exempt — NULLs are distinct in a unique index.
--
-- Idempotent: safe to re-run. Run via supabase db push or the SQL editor.

-- Resolve any PRE-EXISTING duplicates first so the unique index can be built:
-- keep the most recent live draft per contact, demote older ones to 'rejected'.
with ranked as (
  select id,
         row_number() over (
           partition by contact_id
           order by created_at desc, id desc
         ) as rn
  from email_drafts
  where contact_id is not null
    and status in ('draft', 'approved', 'sending', 'failed')
)
update email_drafts d
   set status = 'rejected'
  from ranked r
 where d.id = r.id
   and r.rn > 1;

create unique index if not exists email_drafts_one_live_per_contact
  on email_drafts (contact_id)
  where status in ('draft', 'approved', 'sending', 'failed');
