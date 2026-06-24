import { NextRequest, NextResponse } from 'next/server';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServiceSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/integrations/disconnect  (form-encoded: id=<integration id>)
 * Removes a connected integration (Gmail / Google Drive / Outlook). Form POST so
 * it works without client JS, matching the sign-out pattern. The mailbox/Drive
 * itself is untouched — this just forgets the token. Reconnect anytime.
 */
export async function POST(req: NextRequest) {
  try {
    await requireAppUser();
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const form = await req.formData();
  const id = form.get('id');
  const back = new URL('/integrations', req.url);

  if (typeof id !== 'string' || !id) {
    back.searchParams.set('status', 'error');
    back.searchParams.set('detail', 'missing_id');
    return NextResponse.redirect(back, 303);
  }

  const svc = getServiceSupabase();
  const { error } = await svc.from('integrations').delete().eq('id', id);
  if (error) {
    back.searchParams.set('status', 'error');
    back.searchParams.set('detail', `disconnect_failed: ${error.message}`);
    return NextResponse.redirect(back, 303);
  }

  back.searchParams.set('status', 'ok');
  back.searchParams.set('detail', 'disconnected');
  return NextResponse.redirect(back, 303);
}
