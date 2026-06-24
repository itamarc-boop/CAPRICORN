/**
 * Provider-agnostic send layer. Both send paths (the inline "Send now" route and
 * the paced send-queue tick) call this instead of the Gmail-specific sender, so a
 * client can send through Gmail OR Outlook without either path knowing which.
 * Gmail stays byte-for-byte the same; Outlook activates the moment an
 * provider='outlook' integration is connected.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail as sendGmail } from '@/lib/gmail/send';
import type { IntegrationRow } from '@/lib/gmail/oauth';
import { sendOutlookMail, type OutlookIntegration } from '@/lib/outlook/send';

export type SendingIntegration = {
  id: string;
  provider: string;
  account_email: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  scope: string | null;
};

export type DispatchResult = {
  from_email: string;
  provider: string;
  provider_message_id: string | null; // Gmail message id; null for Outlook (Graph 202)
};

/**
 * The mailbox to send from: the most recently connected Gmail OR Outlook.
 * For a single-provider client this is simply their one connected mailbox; if
 * both are connected, the most recently connected wins.
 */
export async function getSendingIntegration(
  svc: SupabaseClient,
): Promise<SendingIntegration | null> {
  const { data } = await svc
    .from('integrations')
    .select('*')
    .in('provider', ['gmail', 'outlook'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as SendingIntegration | null) ?? null;
}

export async function sendViaIntegration(
  integration: SendingIntegration,
  msg: { to: string; subject: string; body: string },
): Promise<DispatchResult> {
  if (integration.provider === 'outlook') {
    const r = await sendOutlookMail(integration as OutlookIntegration, msg);
    return { from_email: r.from_email, provider: 'outlook', provider_message_id: r.message_id };
  }
  const r = await sendGmail(integration as unknown as IntegrationRow, msg);
  return { from_email: r.from_email, provider: 'gmail', provider_message_id: r.gmail_message_id };
}
