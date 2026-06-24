/**
 * Send a plain-text email through the connected Outlook mailbox via Microsoft
 * Graph (POST /me/sendMail). The Outlook twin of lib/gmail/send.ts. Refreshes
 * the access token from the stored refresh token when it's expired, and persists
 * the rotated tokens back to the integrations row (same pattern as Gmail's
 * 'tokens' listener).
 */
import { getServiceSupabase } from '@/lib/supabase/server';
import { refreshTokens } from './oauth';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export type OutlookIntegration = {
  id: string;
  account_email: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
};

// Graph sendMail returns 202 with no body, so there is no provider message id.
export type OutlookSendResult = { from_email: string; message_id: string | null };

/** A valid access token, refreshing + persisting if expired/near-expiry. */
async function ensureAccessToken(integration: OutlookIntegration): Promise<string> {
  const expMs = integration.token_expires_at
    ? new Date(integration.token_expires_at).getTime()
    : 0;
  const stillFresh = expMs - Date.now() > 60_000;
  if (stillFresh && integration.access_token) return integration.access_token;

  if (!integration.refresh_token) {
    if (integration.access_token) return integration.access_token; // let Graph 401 if stale
    throw new Error('invalid_grant: Outlook authorization expired - reconnect at /integrations');
  }

  const tokens = await refreshTokens(integration.refresh_token);
  try {
    const svc = getServiceSupabase();
    await svc
      .from('integrations')
      .update({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? integration.refresh_token,
        token_expires_at: tokens.expires_at,
        last_used_at: new Date().toISOString(),
      })
      .eq('id', integration.id);
  } catch {
    // best effort; the send below still uses the fresh token
  }
  return tokens.access_token;
}

export async function sendOutlookMail(
  integration: OutlookIntegration,
  { to, subject, body }: { to: string; subject: string; body: string },
): Promise<OutlookSendResult> {
  // Recipient/subject hardening (mirror the Gmail path).
  const recipient = to.replace(/[\r\n]+/g, ' ').trim();
  if (/\s/.test(recipient) || !recipient.includes('@')) {
    throw new Error('invalid recipient address: ' + to);
  }

  const accessToken = await ensureAccessToken(integration);

  const payload = {
    message: {
      subject: subject.replace(/[\r\n]+/g, ' ').trim(),
      body: { contentType: 'Text', content: body },
      toRecipients: [{ emailAddress: { address: recipient } }],
    },
    saveToSentItems: true,
  };

  const res = await fetch(`${GRAPH}/me/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (res.status !== 202) {
    let detail = `HTTP ${res.status}`;
    try {
      const err = (await res.json()) as { error?: { message?: string } };
      detail = err?.error?.message || detail;
    } catch {
      // no JSON body
    }
    // Normalize auth failures so the queue's invalid_grant classifier catches them.
    if (res.status === 401) detail = `invalid_grant: ${detail}`;
    throw new Error(`outlook send failed: ${detail}`);
  }

  return { from_email: integration.account_email, message_id: null };
}
