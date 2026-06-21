import { NextRequest, NextResponse } from 'next/server';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/gmail/send';
import type { IntegrationRow } from '@/lib/gmail/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  company_id: string;
  /** Null for custom recipients typed into the To field (no contact row). */
  contact_id: string | null;
  template_id: string | null;
  to: string;
  subject: string;
  body: string;
};

/**
 * POST /api/email/send
 * Sends a single email from the connected Capricorn Gmail mailbox and logs it
 * against the company + contact. Does NOT touch company status — a DB trigger
 * on email_log (mark_company_contacted) flips new→contacted on insert, so
 * every send path gets the funnel update for free.
 *
 * v1 assumes a single connected Gmail mailbox — picks the most recently
 * connected one. v2 can add a mailbox selector if multiple are connected.
 */
export async function POST(req: NextRequest) {
  try {
    await requireAppUser();
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let payload: Body;
  try {
    payload = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }
  // contact_id is optional — custom recipients send with contact_id null
  // (email_log.contact_id is nullable).
  if (!payload.company_id || !payload.to || !payload.subject || !payload.body) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  const svc = getServiceSupabase();

  // Pick the connected Gmail mailbox (latest by created_at).
  const { data: integration, error: intErr } = await svc
    .from('integrations')
    .select('*')
    .eq('provider', 'gmail')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (intErr || !integration) {
    return NextResponse.json(
      { error: 'no_gmail_connected', message: 'Connect a Gmail mailbox at /integrations first.' },
      { status: 409 }
    );
  }

  // Send.
  let sent;
  try {
    sent = await sendEmail(integration as IntegrationRow, {
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'send_failed';
    return NextResponse.json(
      { error: 'gmail_send_failed', message: msg, detail: msg },
      { status: 502 }
    );
  }

  // Log via service role so RLS doesn't bite. draft_id stays null — this is
  // the manual-send path; the queue tick logs its own rows with draft_id set.
  const supabase = await getServerSupabase();
  const { data: { user: authUser } } = await supabase.auth.getUser();

  const { error: logErr } = await svc.from('email_log').insert({
    company_id: payload.company_id,
    contact_id: payload.contact_id ?? null,
    draft_id: null,
    template_id: payload.template_id,
    sent_by: authUser?.id ?? null,
    from_email: sent.from_email,
    to_email: payload.to,
    subject: payload.subject,
    body: payload.body,
    gmail_message_id: sent.gmail_message_id,
  });
  if (logErr) {
    // The email went out — the DB trigger never fired, so flip the company
    // new→contacted directly and surface the log failure as a warning.
    await svc
      .from('companies')
      .update({ status: 'contacted' })
      .eq('id', payload.company_id)
      .eq('status', 'new');
    return NextResponse.json({
      ok: true,
      gmail_message_id: sent.gmail_message_id,
      from_email: sent.from_email,
      warning: `email_log insert failed: ${logErr.message}`,
    });
  }

  return NextResponse.json({
    ok: true,
    gmail_message_id: sent.gmail_message_id,
    from_email: sent.from_email,
  });
}
