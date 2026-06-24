/**
 * Send-queue tick worker. Called by the cron route (/api/send-queue/tick)
 * with a service-role Supabase client. Each tick does at most one unit of
 * work, in this order:
 *
 *   1. RECOVER — drafts stuck in 'sending' for >5 min (deploy/timeout killed
 *      the worker mid-send) are marked 'failed' so a human can verify the
 *      Gmail Sent folder before requeueing. Recovery short-circuits the tick;
 *      sending resumes on the next one.
 *   2. CLAIM — the single oldest due 'approved' draft is claimed atomically
 *      (status flip guarded by .eq('status','approved'), so concurrent ticks
 *      can't double-send).
 *   3. SEND — via the connected Gmail integration, fetched fresh every tick
 *      so token refresh during long queues is automatic. Success writes
 *      email_log (a DB trigger flips the company new→contacted). Errors are
 *      classified: auth/recipient errors fail permanently; transient errors
 *      requeue with exponential backoff up to 3 attempts.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSendingIntegration, sendViaIntegration } from '@/lib/email/send';
import type { Contact, EmailDraft } from '@/lib/db/types';

export type TickResult = {
  ok: true;
  action: 'idle' | 'recovered' | 'sent' | 'failed' | 'requeued';
  detail?: string;
};

const STUCK_SENDING_MS = 5 * 60_000;
const NO_GMAIL_RETRY_MS = 5 * 60_000;
const TRANSIENT_BASE_BACKOFF_MS = 5 * 60_000;
const MAX_SEND_ATTEMPTS = 3;

export async function runTick(svc: SupabaseClient): Promise<TickResult> {
  const nowIso = new Date().toISOString();

  // ── a. RECOVER: sends interrupted mid-flight (deploy, function timeout).
  const staleIso = new Date(Date.now() - STUCK_SENDING_MS).toISOString();
  const { data: recovered, error: recoverErr } = await svc
    .from('email_drafts')
    .update({
      status: 'failed',
      error:
        'interrupted (deploy/timeout) - verify in the Gmail Sent folder before requeueing',
    })
    .eq('status', 'sending')
    .lt('sending_started_at', staleIso)
    .select('id');
  if (recoverErr) {
    return { ok: true, action: 'idle', detail: `recover query failed: ${recoverErr.message}` };
  }
  if (recovered && recovered.length > 0) {
    return {
      ok: true,
      action: 'recovered',
      detail: `${recovered.length} stuck sends marked failed`,
    };
  }

  // ── b. CLAIM: oldest due approved draft, claimed atomically.
  const { data: due, error: dueErr } = await svc
    .from('email_drafts')
    .select('id')
    .eq('status', 'approved')
    .not('scheduled_at', 'is', null)
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (dueErr) {
    return { ok: true, action: 'idle', detail: `due query failed: ${dueErr.message}` };
  }
  if (!due) return { ok: true, action: 'idle' };

  const { data: claimedRows, error: claimErr } = await svc
    .from('email_drafts')
    .update({ status: 'sending', sending_started_at: nowIso })
    .eq('id', due.id)
    .eq('status', 'approved')
    .select();
  if (claimErr) {
    return { ok: true, action: 'idle', detail: `claim failed: ${claimErr.message}` };
  }
  const draft = (claimedRows?.[0] ?? null) as EmailDraft | null;
  if (!draft) return { ok: true, action: 'idle', detail: 'lost claim race' };

  // Everything after the claim is wrapped so an unexpected throw marks the
  // draft 'failed' instead of leaving it stuck in 'sending'.
  try {
    // ── c. LOAD: contact + latest gmail integration (fresh each tick).
    const { data: contactRow } = await svc
      .from('contacts')
      .select('id, full_name, email')
      .eq('id', draft.contact_id)
      .maybeSingle();
    const contact = contactRow as Pick<Contact, 'id' | 'full_name' | 'email'> | null;

    const integration = await getSendingIntegration(svc);

    if (!contact || !contact.email || contact.email.trim() === '') {
      await svc
        .from('email_drafts')
        .update({ status: 'failed', error: 'contact has no email' })
        .eq('id', draft.id);
      return { ok: true, action: 'failed', detail: 'contact has no email' };
    }

    if (!integration) {
      // Not the draft's fault — park it 5 minutes without burning an attempt.
      await svc
        .from('email_drafts')
        .update({
          status: 'approved',
          sending_started_at: null,
          scheduled_at: new Date(Date.now() + NO_GMAIL_RETRY_MS).toISOString(),
        })
        .eq('id', draft.id);
      return { ok: true, action: 'requeued', detail: 'no mailbox connected' };
    }

    // ── d. SEND.
    try {
      const result = await sendViaIntegration(integration, {
        to: contact.email,
        subject: draft.subject,
        body: draft.body,
      });

      const sentIso = new Date().toISOString();
      await svc
        .from('email_drafts')
        .update({ status: 'sent', sent_at: sentIso, error: null })
        .eq('id', draft.id);

      // The DB trigger on email_log flips the company new→contacted.
      const { error: logErr } = await svc.from('email_log').insert({
        company_id: draft.company_id,
        contact_id: draft.contact_id,
        draft_id: draft.id,
        template_id: draft.template_id,
        sent_by: draft.approved_by ?? draft.created_by,
        from_email: result.from_email,
        to_email: contact.email,
        subject: draft.subject,
        body: draft.body,
        gmail_message_id: result.provider_message_id,
      });
      if (logErr) {
        // The email WAS sent — keep the draft 'sent', note the log failure,
        // and run the trigger's company flip ourselves since it never fired.
        await svc
          .from('email_drafts')
          .update({
            error: `sent; email_log insert failed: ${logErr.message}`.slice(0, 300),
          })
          .eq('id', draft.id);
        await svc
          .from('companies')
          .update({ status: 'contacted' })
          .eq('id', draft.company_id)
          .eq('status', 'new');
        return {
          ok: true,
          action: 'sent',
          detail: `${contact.email} (email_log insert failed: ${logErr.message})`.slice(0, 200),
        };
      }

      return { ok: true, action: 'sent', detail: contact.email };
    } catch (e) {
      // ── e. Classify the send error.
      const message = e instanceof Error ? e.message : String(e);
      return await handleSendError(svc, draft, message);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    try {
      await svc
        .from('email_drafts')
        .update({
          status: 'failed',
          error: `unexpected tick error: ${message}`.slice(0, 300),
        })
        .eq('id', draft.id);
    } catch {
      // best effort — the recovery sweep will catch it if this also failed
    }
    return { ok: true, action: 'failed', detail: message.slice(0, 200) };
  }
}

/**
 * Error taxonomy:
 * - invalid_grant / unauthorized_client → permanent fail with a reconnect hint
 *   (retrying would just burn attempts against a dead refresh token).
 * - invalid recipient / address required → permanent fail (the address itself
 *   is bad; retrying can't fix it).
 * - everything else → transient: exponential backoff (5/10/20 min) up to
 *   3 attempts, then permanent fail.
 */
async function handleSendError(
  svc: SupabaseClient,
  draft: EmailDraft,
  message: string
): Promise<TickResult> {
  const lower = message.toLowerCase();

  if (lower.includes('invalid_grant') || lower.includes('unauthorized_client')) {
    await svc
      .from('email_drafts')
      .update({
        status: 'failed',
        error:
          'Mailbox authorization expired (invalid_grant) - reconnect at /integrations, then requeue',
      })
      .eq('id', draft.id);
    return { ok: true, action: 'failed', detail: 'gmail auth' };
  }

  if (/invalid (to|recipient)|address required/i.test(message)) {
    await svc
      .from('email_drafts')
      .update({ status: 'failed', error: message.slice(0, 300) })
      .eq('id', draft.id);
    return { ok: true, action: 'failed', detail: 'invalid recipient' };
  }

  const attempts = draft.send_attempts;
  if (attempts < MAX_SEND_ATTEMPTS) {
    const backoffMs = TRANSIENT_BASE_BACKOFF_MS * 2 ** attempts;
    await svc
      .from('email_drafts')
      .update({
        status: 'approved',
        sending_started_at: null,
        scheduled_at: new Date(Date.now() + backoffMs).toISOString(),
        send_attempts: attempts + 1,
        error: message,
      })
      .eq('id', draft.id);
    return {
      ok: true,
      action: 'requeued',
      detail: `transient error, attempt ${attempts + 1}/${MAX_SEND_ATTEMPTS}, retry in ${Math.round(backoffMs / 60_000)}min`,
    };
  }

  await svc
    .from('email_drafts')
    .update({ status: 'failed', error: message })
    .eq('id', draft.id);
  return { ok: true, action: 'failed', detail: message.slice(0, 200) };
}
