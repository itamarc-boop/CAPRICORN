import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { authUrlForConnect, type ConnectProvider } from '@/lib/gmail/oauth';
import { requireAppUser } from '@/lib/auth/allowlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'capricorn_oauth_state';

/**
 * GET /api/integrations/google/start?provider=gmail|google_drive
 * Build the Google OAuth consent URL, set a CSRF-state cookie (carrying which
 * provider is being connected), redirect. The client clicks this after sign-in.
 */
export async function GET(req: NextRequest) {
  try {
    await requireAppUser();  // signed-in + allowlisted
    const provider: ConnectProvider =
      new URL(req.url).searchParams.get('provider') === 'google_drive'
        ? 'google_drive'
        : 'gmail';
    const state = crypto.randomUUID();
    const url = authUrlForConnect(state, provider);

    const cookieStore = await cookies();
    // Remember the provider alongside the CSRF state so the callback knows which
    // integration to store.
    cookieStore.set(STATE_COOKIE, `${provider}:${state}`, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600,  // 10 min to complete consent
      secure: process.env.NODE_ENV === 'production',
    });

    return NextResponse.redirect(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'OAuth start failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
