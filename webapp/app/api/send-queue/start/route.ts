/**
 * POST /api/send-queue/start
 * Stamps scheduled_at on approved drafts so the cron tick can drain them.
 *
 * Body: { draft_ids?: string[] } — absent means all currently 'approved'.
 * Spacing: first draft fires immediately (next tick), each subsequent one
 * 45s after the previous ± up to 15s jitter, in approved_at order, so the
 * outbox doesn't look machine-gunned.
 *
 * Returns: { ok: true, queued: number, estimated_seconds: number }
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServiceSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type Body = { draft_ids?: string[] };

const SPACING_MS = 45_000;
const JITTER_RANGE_MS = 30_000; // ±15s

export async function POST(req: NextRequest) {
  try {
    await requireAppUser();
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let payload: Body = {};
  try {
    payload = (await req.json()) as Body;
  } catch {
    // No/invalid JSON body — treat as "queue all approved".
  }
  const draftIds = Array.isArray(payload.draft_ids) ? payload.draft_ids : undefined;

  const svc = getServiceSupabase();

  let query = svc.from('email_drafts').select('id, approved_at').eq('status', 'approved');
  if (draftIds) query = query.in('id', draftIds);
  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // approved_at ascending, nulls last — oldest approvals go out first.
  const rows = (data ?? []) as Array<{ id: string; approved_at: string | null }>;
  rows.sort((a, b) => {
    if (a.approved_at === null && b.approved_at === null) return 0;
    if (a.approved_at === null) return 1;
    if (b.approved_at === null) return -1;
    return a.approved_at < b.approved_at ? -1 : a.approved_at > b.approved_at ? 1 : 0;
  });

  for (let i = 0; i < rows.length; i++) {
    const jitterMs =
      i === 0 ? 0 : Math.floor(Math.random() * JITTER_RANGE_MS - JITTER_RANGE_MS / 2);
    const scheduledAt = new Date(Date.now() + i * SPACING_MS + jitterMs).toISOString();
    const { error: updateErr } = await svc
      .from('email_drafts')
      .update({ scheduled_at: scheduledAt })
      .eq('id', rows[i].id)
      .eq('status', 'approved'); // don't stamp a draft that was un-approved meanwhile
    if (updateErr) {
      return NextResponse.json(
        { error: `failed to schedule draft ${rows[i].id}: ${updateErr.message}` },
        { status: 500 }
      );
    }
  }

  const n = rows.length;
  // Real drain rate is one email per cron tick (one per minute), regardless of
  // the 45s scheduled_at spacing above.
  return NextResponse.json({
    ok: true,
    queued: n,
    estimated_seconds: n === 0 ? 0 : (n - 1) * 60 + 30,
  });
}
