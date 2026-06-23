import { NextRequest, NextResponse } from 'next/server';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { triggerDiscoveryRun } from '@/lib/github/dispatch';
import { isSupportedCountry } from '@/lib/countries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  country?: unknown;
  target_leads?: unknown;
};

const TARGET_MIN = 5;
const TARGET_MAX = 60;
const TARGET_DEFAULT = 25;

/** lowercase, non-alnum -> '-', collapse + trim dashes. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * POST /api/discovery/run
 *
 * Enqueues a discovery run: inserts a pipeline_runs row (status 'queued'), then
 * fires a GitHub repository_dispatch "discover" event so the CI worker picks it
 * up. On a trigger failure the row is flipped to 'failed' and the matching error
 * status is returned to the client (no silent 200s).
 */
export async function POST(req: NextRequest) {
  try {
    await requireAppUser();
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Capture the auth user id for provenance (requested_by).
  const supabase = await getServerSupabase();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  let payload: Body;
  try {
    payload = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'missing_country' }, { status: 400 });
  }

  const country =
    typeof payload.country === 'string' ? payload.country.trim() : '';
  if (!country) {
    return NextResponse.json({ error: 'missing_country' }, { status: 400 });
  }
  // Guard before spending any credits: a country the pipeline can't resolve
  // would only fail deep in a paid run. Mirrors COUNTRY_CODES in explorium_api.py.
  if (!isSupportedCountry(country)) {
    return NextResponse.json({ error: 'unsupported_country' }, { status: 400 });
  }

  // Coerce target_leads to int, clamp to [5,60], default 25.
  let target_leads = TARGET_DEFAULT;
  const raw = payload.target_leads;
  const parsed =
    typeof raw === 'number'
      ? Math.trunc(raw)
      : typeof raw === 'string'
        ? parseInt(raw, 10)
        : NaN;
  if (Number.isFinite(parsed)) {
    target_leads = Math.min(TARGET_MAX, Math.max(TARGET_MIN, parsed));
  }

  const svc = getServiceSupabase();

  // Enqueue the run.
  const { data: run, error: insErr } = await svc
    .from('pipeline_runs')
    .insert({
      country,
      target_leads,
      status: 'queued',
      requested_by: authUser?.id ?? null,
      batch_label: 'discovery_' + slug(country),
    })
    .select('id')
    .single();
  if (insErr || !run) {
    return NextResponse.json(
      { error: 'db_error', detail: insErr?.message ?? 'insert failed' },
      { status: 500 }
    );
  }

  const runId = run.id as string;

  // Fire the CI worker.
  const dispatch = await triggerDiscoveryRun({
    run_id: runId,
    country,
    target: target_leads,
  });

  if (!dispatch.ok) {
    const friendly =
      dispatch.error === 'github_not_configured'
        ? 'Discovery worker is not configured. Set GITHUB_OWNER, GITHUB_REPO and GITHUB_DISPATCH_TOKEN.'
        : `Could not start the discovery worker.${dispatch.detail ? ' ' + dispatch.detail : ''}`;

    // Flip the queued row to failed so it doesn't hang forever.
    await svc
      .from('pipeline_runs')
      .update({
        status: 'failed',
        error: friendly,
        finished_at: new Date().toISOString(),
      })
      .eq('id', runId);

    const httpStatus = dispatch.error === 'github_not_configured' ? 503 : 502;
    return NextResponse.json({ error: dispatch.error }, { status: httpStatus });
  }

  return NextResponse.json({ ok: true, run_id: runId });
}
