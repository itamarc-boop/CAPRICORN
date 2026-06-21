import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { getOAuth2Client, fetchAccountEmail } from '@/lib/gmail/oauth';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { requireAppUser } from '@/lib/auth/allowlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'capricorn_oauth_state';

/**
 * GET /api/integrations/google/callback?code=...&state=...
 * Exchanges the code for tokens, fetches the connected mailbox's email,
 * upserts the integrations row. The signed-in user becomes the owner of
 * this integration (admin can also use it to send).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const cookieStore = await cookies();
  const stored = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);

  if (error) return redirectWith(req, 'error', error);
  if (!code) return redirectWith(req, 'error', 'missing_code');
  if (!state || !stored || state !== stored) {
    return redirectWith(req, 'error', 'state_mismatch');
  }

  try {
    await requireAppUser();
    const oauth2 = getOAuth2Client();
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.access_token) return redirectWith(req, 'error', 'no_access_token');
    oauth2.setCredentials(tokens);

    const accountEmail = await fetchAccountEmail(oauth2);
    if (!accountEmail) return redirectWith(req, 'error', 'no_email');

    // Who is connecting — store as owner_user_id so the admin can later see
    // who connected what.
    const supabase = await getServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();

    const svc = getServiceSupabase();
    const { error: upsertErr } = await svc.from('integrations').upsert(
      {
        provider: 'gmail',
        account_email: accountEmail,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        scope: tokens.scope ?? null,
        token_expires_at: tokens.expiry_date
          ? new Date(tokens.expiry_date).toISOString()
          : null,
        owner_user_id: user?.id ?? null,
      },
      { onConflict: 'provider,account_email' }
    );
    if (upsertErr) return redirectWith(req, 'error', `db_${upsertErr.code}`);

    return redirectWith(req, 'ok', accountEmail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'callback_failed';
    return redirectWith(req, 'error', msg);
  }
}

function redirectWith(req: NextRequest, status: 'ok' | 'error', detail: string) {
  const target = new URL('/integrations', req.url);
  target.searchParams.set('status', status);
  target.searchParams.set('detail', detail);
  return NextResponse.redirect(target);
}
