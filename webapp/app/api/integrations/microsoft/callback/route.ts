import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { exchangeCodeForTokens, fetchOutlookEmail } from '@/lib/outlook/oauth';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { requireAppUser } from '@/lib/auth/allowlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'capricorn_ms_oauth_state';

/**
 * GET /api/integrations/microsoft/callback?code=...&state=...
 * Exchanges the code for tokens, reads the connected mailbox's email via Graph,
 * upserts the integrations row with provider='outlook'.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDesc = url.searchParams.get('error_description');

  const cookieStore = await cookies();
  const stored = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);

  if (error) return redirectWith(req, 'error', errorDesc || error);
  if (!code) return redirectWith(req, 'error', 'missing_code');
  if (!state || !stored || state !== stored) {
    return redirectWith(req, 'error', 'state_mismatch');
  }

  try {
    await requireAppUser();
    const tokens = await exchangeCodeForTokens(code);

    const accountEmail = await fetchOutlookEmail(tokens.access_token);
    if (!accountEmail) return redirectWith(req, 'error', 'no_email');

    const supabase = await getServerSupabase();
    const { data: { user } } = await supabase.auth.getUser();

    const svc = getServiceSupabase();
    const { error: upsertErr } = await svc.from('integrations').upsert(
      {
        provider: 'outlook',
        account_email: accountEmail,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        scope: tokens.scope,
        token_expires_at: tokens.expires_at,
        owner_user_id: user?.id ?? null,
      },
      { onConflict: 'provider,account_email' },
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
