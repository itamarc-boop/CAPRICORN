-- Custom send-to address. Lets the user override a draft's recipient so they can
-- send to any address, not only the selected contact's email. Null = use the
-- contact's email (existing behaviour). The contact stays attached for the record
-- and personalization; only the delivery address changes. Idempotent.
alter table email_drafts add column if not exists to_email text;
