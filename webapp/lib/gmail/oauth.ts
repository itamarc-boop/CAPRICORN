/**
 * Gmail OAuth helpers. Pattern adapted from the JONAS sibling project's
 * Drive integration — same OAuth2Client + 'tokens' event listener to
 * persist refreshed access tokens back to the integrations row.
 *
 * Scope: gmail.send only (least privilege). We never read messages.
 */
import { google } from 'googleapis';
import type { Credentials, OAuth2Client } from 'google-auth-library';
import { getServiceSupabase } from '@/lib/supabase/server';

export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

export type IntegrationRow = {
  id: string;
  provider: 'gmail';
  account_email: string;
  access_token: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  scope: string | null;
  owner_user_id: string | null;
};

export function getOAuth2Client(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Google OAuth env missing. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_OAUTH_REDIRECT_URI in .env.local.'
    );
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

/**
 * Build the Google consent URL. `prompt: 'consent'` guarantees we get a
 * refresh_token even if the user already granted scopes previously.
 */
export function authUrlForGmailConnect(state: string): string {
  return getOAuth2Client().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: GMAIL_SCOPES,
    state,
    include_granted_scopes: true,
  });
}

/**
 * Build an OAuth2 client primed with the stored tokens and a listener that
 * persists any auto-rotated tokens back to the integrations row.
 */
export function makeAuthedClient(integration: IntegrationRow): OAuth2Client {
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: integration.access_token,
    refresh_token: integration.refresh_token ?? undefined,
    expiry_date: integration.token_expires_at
      ? new Date(integration.token_expires_at).getTime()
      : undefined,
    scope: integration.scope ?? undefined,
  });

  oauth2.on('tokens', async (tokens: Credentials) => {
    try {
      const supabase = getServiceSupabase();
      const patch: Record<string, unknown> = {
        last_used_at: new Date().toISOString(),
      };
      if (tokens.access_token) patch.access_token = tokens.access_token;
      if (tokens.refresh_token) patch.refresh_token = tokens.refresh_token;
      if (tokens.expiry_date) {
        patch.token_expires_at = new Date(tokens.expiry_date).toISOString();
      }
      await supabase.from('integrations').update(patch).eq('id', integration.id);
    } catch {
      // best effort; don't break the calling request
    }
  });
  return oauth2;
}

/**
 * Fetch the connected account's email — used to label the integration row
 * after OAuth callback and to display "Connected as foo@bar.com" in the UI.
 */
export async function fetchAccountEmail(oauth2: OAuth2Client): Promise<string | null> {
  try {
    const oauthApi = google.oauth2({ version: 'v2', auth: oauth2 });
    const me = await oauthApi.userinfo.get();
    return (me.data.email as string | undefined) ?? null;
  } catch {
    return null;
  }
}
