/**
 * Microsoft (Outlook) OAuth + token helpers — the Microsoft twin of
 * lib/gmail/oauth.ts. Uses the Microsoft identity platform v2.0 auth-code flow;
 * sending goes through Microsoft Graph (lib/outlook/send.ts).
 *
 * Operator setup is one-time (see OUTLOOK_SETUP.md): register an app at
 * portal.azure.com, add the redirect URI, grant delegated Graph permissions
 * Mail.Send + User.Read + offline_access, create a client secret, then set
 * MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET / MICROSOFT_TENANT /
 * MICROSOFT_OAUTH_REDIRECT_URI. Until those exist the Connect-Outlook UI stays
 * hidden, so nothing in the app changes.
 */

const AUTH_HOST = 'https://login.microsoftonline.com';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// Delegated scopes. offline_access => refresh token; Mail.Send => send as the
// signed-in user; User.Read => read that mailbox's address; openid/email/profile
// for the id token.
export const OUTLOOK_SCOPES = [
  'offline_access',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
  'openid',
  'email',
  'profile',
];

export type OutlookConfig = {
  clientId: string;
  clientSecret: string;
  tenant: string;
  redirectUri: string;
};

/** True once the operator has set the Azure app credentials. Gates the UI. */
export function isOutlookConfigured(): boolean {
  return Boolean(
    process.env.MICROSOFT_CLIENT_ID &&
      process.env.MICROSOFT_CLIENT_SECRET &&
      process.env.MICROSOFT_OAUTH_REDIRECT_URI,
  );
}

export function getOutlookConfig(): OutlookConfig {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_OAUTH_REDIRECT_URI;
  const tenant = process.env.MICROSOFT_TENANT || 'common';
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      'Microsoft OAuth env missing. Set MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, ' +
        'MICROSOFT_OAUTH_REDIRECT_URI (and optionally MICROSOFT_TENANT) in .env.local.',
    );
  }
  return { clientId, clientSecret, tenant, redirectUri };
}

export type OutlookTokens = {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null; // ISO; 60s of headroom subtracted
  scope: string | null;
};

/** Build the Microsoft consent URL. */
export function authUrlForOutlook(state: string): string {
  const cfg = getOutlookConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    redirect_uri: cfg.redirectUri,
    response_mode: 'query',
    scope: OUTLOOK_SCOPES.join(' '),
    state,
    prompt: 'select_account',
  });
  return `${AUTH_HOST}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/authorize?${params.toString()}`;
}

async function tokenRequest(extra: Record<string, string>): Promise<OutlookTokens> {
  const cfg = getOutlookConfig();
  // scope omitted on purpose: code redemption derives it from the code, and the
  // refresh grant defaults to the originally consented scopes — passing it again
  // is a common source of scope-mismatch errors.
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    ...extra,
  });
  const res = await fetch(`${AUTH_HOST}/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !json.access_token) {
    const detail = json.error_description || json.error || `HTTP ${res.status}`;
    throw new Error(`microsoft token request failed: ${detail}`);
  }
  const expiresIn = Number(json.expires_in);
  const expiresAt = Number.isFinite(expiresIn)
    ? new Date(Date.now() + (expiresIn - 60) * 1000).toISOString()
    : null;
  return {
    access_token: String(json.access_token),
    refresh_token: (json.refresh_token as string) ?? null,
    expires_at: expiresAt,
    scope: (json.scope as string) ?? null,
  };
}

export function exchangeCodeForTokens(code: string): Promise<OutlookTokens> {
  return tokenRequest({ grant_type: 'authorization_code', code });
}

export function refreshTokens(refreshToken: string): Promise<OutlookTokens> {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

/** The connected mailbox's address — labels the integration row + the UI. */
export async function fetchOutlookEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${GRAPH}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const me = (await res.json()) as { mail?: string; userPrincipalName?: string };
    return me.mail || me.userPrincipalName || null;
  } catch {
    return null;
  }
}
