import { NextRequest, NextResponse } from 'next/server';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Body = {
  company_id?: unknown;
  contact_id?: unknown;
  template_id?: unknown;
  language?: unknown;
  to_email?: unknown;
  subject?: unknown;
  body?: unknown;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/drafts/create
 * Persists a manually-composed (or template-rendered) email as a reviewable
 * draft (status 'draft'). This is the non-AI counterpart to /api/drafts/generate
 * and the foundation of the unified "every email is a reviewable draft" model —
 * the dossier no longer sends without a draft existing first.
 */
export async function POST(req: NextRequest) {
  try {
    await requireAppUser();
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let payload: Body;
  try {
    payload = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  const company_id = typeof payload.company_id === 'string' ? payload.company_id : '';
  const contact_id = typeof payload.contact_id === 'string' ? payload.contact_id : '';
  const template_id = typeof payload.template_id === 'string' && payload.template_id ? payload.template_id : null;
  const language = typeof payload.language === 'string' && payload.language ? payload.language : 'en';
  const subject = typeof payload.subject === 'string' ? payload.subject : '';
  const body = typeof payload.body === 'string' ? payload.body : '';
  // Optional override recipient. Null => send to the contact's email.
  const to_email_raw = typeof payload.to_email === 'string' ? payload.to_email.trim() : '';
  const to_email = to_email_raw || null;

  if (!company_id || !contact_id || !subject.trim() || !body.trim()) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }
  if (to_email && !EMAIL_RE.test(to_email)) {
    return NextResponse.json(
      { error: 'invalid_email', detail: 'That send-to address is not a valid email.' },
      { status: 400 }
    );
  }

  const supabase = await getServerSupabase();
  const { data: { user: authUser } } = await supabase.auth.getUser();

  const svc = getServiceSupabase();
  const { data: inserted, error } = await svc
    .from('email_drafts')
    .insert({
      company_id,
      contact_id,
      template_id,
      language,
      to_email,
      subject,
      body,
      status: 'draft',
      created_by: authUser?.id ?? null,
    })
    .select('id')
    .single();

  if (error || !inserted) {
    return NextResponse.json(
      { error: 'db_error', detail: error?.message ?? 'insert failed' },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, draft_id: inserted.id as string });
}
