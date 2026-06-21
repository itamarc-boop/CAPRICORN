import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Supabase OAuth callback. Exchanges the ?code for a session cookie, then
 * redirects to the home page.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  if (!code) return NextResponse.redirect(new URL('/login', req.url));

  const supabase = await getServerSupabase();
  await supabase.auth.exchangeCodeForSession(code);
  return NextResponse.redirect(new URL('/', req.url));
}
