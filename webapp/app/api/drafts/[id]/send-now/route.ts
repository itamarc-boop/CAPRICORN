import { NextRequest, NextResponse } from 'next/server';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { getSendingIntegration, sendViaIntegration } from '@/lib/email/send';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * POST /api/drafts/[id]/send-now
 * Immediately sends a single draft (the "Approve & send" / "Send now" inline
 * action). Bypasses the paced send-queue, which is reserved for batches. Marks
 * the draft 'sending' (compare-and-swap so it can't double-send), sends via the
 * connected Gmail, then marks 'sent' and logs to email_log (the email_log
 * trigger flips the company new→contacted). On failure the draft goes 'failed'.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAppUser();
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const svc = getServiceSupabase();

  // Load the draft with its recipient.
  const { data: draft, error: draftErr } = await svc
    .from('email_drafts')
    .select('id, company_id, contact_id, template_id, to_email, subject, body, status, contacts(email)')
    .eq('id', id)
    .maybeSingle();
  if (draftErr) {
    return NextResponse.json({ error: 'db_error', detail: draftErr.message }, { status: 500 });
  }
  if (!draft) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (draft.status === 'sent') {
    return NextResponse.json({ error: 'already_sent' }, { status: 409 });
  }
  if (draft.status === 'sending') {
    return NextResponse.json({ error: 'in_progress' }, { status: 409 });
  }

  // The embedded relation types as an array; normalize to the single contact.
  const contactRel = draft.contacts as unknown as
    | { email: string | null }
    | { email: string | null }[]
    | null;
  const contactEmail = Array.isArray(contactRel)
    ? contactRel[0]?.email ?? null
    : contactRel?.email ?? null;
  // A custom to_email overrides the contact's email when set.
  const override =
    typeof draft.to_email === 'string' && draft.to_email.trim() ? draft.to_email.trim() : null;
  const recipient = override ?? contactEmail;
  if (!recipient) {
    return NextResponse.json(
      { error: 'no_recipient', message: 'No send-to address. Add the contact email or type one.' },
      { status: 422 }
    );
  }

  // Pick the connected mailbox (Gmail or Outlook, latest by created_at).
  const integration = await getSendingIntegration(svc);
  if (!integration) {
    return NextResponse.json(
      {
        error: 'no_mailbox_connected',
        message: 'Connect a Gmail or Outlook mailbox at /integrations first.',
      },
      { status: 409 }
    );
  }

  // Claim the draft so a concurrent click / cron tick can't double-send it.
  const { data: claimed, error: claimErr } = await svc
    .from('email_drafts')
    .update({ status: 'sending', sending_started_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', ['draft', 'approved', 'failed'])
    .select('id');
  if (claimErr) {
    return NextResponse.json({ error: 'db_error', detail: claimErr.message }, { status: 500 });
  }
  if (!claimed || claimed.length === 0) {
    return NextResponse.json({ error: 'in_progress' }, { status: 409 });
  }

  // Send.
  let sent;
  try {
    sent = await sendViaIntegration(integration, {
      to: recipient,
      subject: draft.subject,
      body: draft.body,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'send_failed';
    await svc
      .from('email_drafts')
      .update({ status: 'failed', error: msg.slice(0, 500) })
      .eq('id', id);
    return NextResponse.json({ error: 'send_failed', message: msg, detail: msg }, { status: 502 });
  }

  // Mark sent + log.
  const nowIso = new Date().toISOString();
  const supabase = await getServerSupabase();
  const { data: { user: authUser } } = await supabase.auth.getUser();

  await svc
    .from('email_drafts')
    .update({ status: 'sent', sent_at: nowIso, error: null })
    .eq('id', id);

  await svc.from('email_log').insert({
    company_id: draft.company_id,
    contact_id: draft.contact_id,
    draft_id: draft.id,
    template_id: draft.template_id,
    sent_by: authUser?.id ?? null,
    from_email: sent.from_email,
    to_email: recipient,
    subject: draft.subject,
    body: draft.body,
    gmail_message_id: sent.provider_message_id,
  });

  return NextResponse.json({ ok: true, from_email: sent.from_email });
}
