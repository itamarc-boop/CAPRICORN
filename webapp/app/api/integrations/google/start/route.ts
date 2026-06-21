import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { authUrlForGmailConnect } from '@/lib/gmail/oauth';
import { requireAppUser } from '@/lib/auth/allowlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'capricorn_oauth_state';

/**
 * GET /api/integrations/google/start
 * Build the Google OAuth consent URL, set a CSRF-state cookie, redirect.
 * The Capricorn client clicks this after signing into the app.
 */
export async function GET() {
  try {
    await requireAppUser();  // signed-in + allowlisted
    const state = crypto.randomUUID();
    const url = authUrlForGmailConnect(state);

    const cookieStore = await cookies();
    cookieStore.set(STATE_COOKIE, state, {
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
