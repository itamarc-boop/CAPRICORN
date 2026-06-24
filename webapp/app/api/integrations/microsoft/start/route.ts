import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { authUrlForOutlook, isOutlookConfigured } from '@/lib/outlook/oauth';
import { requireAppUser } from '@/lib/auth/allowlist';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATE_COOKIE = 'capricorn_ms_oauth_state';

/**
 * GET /api/integrations/microsoft/start
 * Build the Microsoft consent URL, set a CSRF-state cookie, redirect. The client
 * clicks this after sign-in. No-ops gracefully (redirects with a friendly note)
 * if the operator hasn't set the Azure app credentials yet.
 */
export async function GET(req: NextRequest) {
  try {
    await requireAppUser();
    if (!isOutlookConfigured()) {
      const target = new URL('/integrations', req.url);
      target.searchParams.set('status', 'error');
      target.searchParams.set('detail', 'outlook_not_enabled');
      return NextResponse.redirect(target);
    }

    const state = crypto.randomUUID();
    const url = authUrlForOutlook(state);

    const cookieStore = await cookies();
    cookieStore.set(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 600, // 10 min to complete consent
      secure: process.env.NODE_ENV === 'production',
    });

    return NextResponse.redirect(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'OAuth start failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
