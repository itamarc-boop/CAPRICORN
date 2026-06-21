import { NextRequest, NextResponse } from 'next/server';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServiceSupabase } from '@/lib/supabase/server';
import { getAnthropic } from '@/lib/ai/anthropic';
import {
  buildContactBlock,
  buildSystemPrompt,
  generateDraftRaw,
  type GeneratedDraft,
} from '@/lib/ai/draft';
import type { Company, Contact, EmailDraft, Template } from '@/lib/db/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type DraftWithRelations = EmailDraft & {
  contacts: Contact | null;
  companies: Company | null;
  templates: Template | null;
};

/**
 * POST /api/drafts/regenerate
 * body: { draft_id: string, instruction?: string }
 * Rewrites the draft (same template + evidence, previous draft appended to the
 * user block, optional revision instruction) and resets the row to status
 * 'draft' with the new subject/body.
 * → 200 { ok: true, draft_id }
 * → 403 forbidden | 400 missing_fields | 404 draft_not_found
 * → 409 { error: 'template_missing' } | 500 { error: 'anthropic_not_configured' }
 */
export async function POST(req: NextRequest) {
  try {
    await requireAppUser();
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  const draftId = typeof payload.draft_id === 'string' ? payload.draft_id : '';
  const instruction =
    typeof payload.instruction === 'string' ? payload.instruction.trim() : '';
  if (!draftId) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  // Fail fast before any DB writes when the API key is missing.
  try {
    getAnthropic();
  } catch {
    return NextResponse.json({ error: 'anthropic_not_configured' }, { status: 500 });
  }

  const svc = getServiceSupabase();

  const { data, error: fetchErr } = await svc
    .from('email_drafts')
    .select('*, contacts(*), companies(*), templates(*)')
    .eq('id', draftId)
    .maybeSingle();
  if (fetchErr) {
    return NextResponse.json({ error: 'db_error', detail: fetchErr.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'draft_not_found' }, { status: 404 });
  }

  const draft = data as DraftWithRelations;
  if (draft.status === 'sending' || draft.status === 'sent') {
    return NextResponse.json(
      { error: 'invalid_status', message: 'This draft has already been sent or is sending.' },
      { status: 409 }
    );
  }
  const template = draft.templates;
  if (!template) {
    return NextResponse.json({ error: 'template_missing' }, { status: 409 });
  }
  const contact = draft.contacts;
  const company = draft.companies;
  if (!contact || !company) {
    return NextResponse.json({ error: 'contact_missing' }, { status: 409 });
  }

  // Rebuild the same prompts, then append the previous draft (and the
  // optional revision instruction) to the user block.
  const systemPrompt = buildSystemPrompt(template, draft.language);
  let userBlock = buildContactBlock(company, contact);
  userBlock += `\n\nPREVIOUS DRAFT (rewrite it):\nSubject: ${draft.subject}\n${draft.body}`;
  if (instruction) {
    userBlock += `\nREVISION INSTRUCTION FROM THE USER: ${instruction}`;
  }

  let gen: GeneratedDraft;
  try {
    gen = await generateDraftRaw(systemPrompt, userBlock);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: 'generation_failed', detail: msg.slice(0, 200) },
      { status: 502 }
    );
  }

  // Compare-and-swap on the status read at fetch time: if the tick (or anyone
  // else) changed the draft mid-generation, don't clobber it. Resets ALL queue
  // fields so a regenerated draft never carries stale scheduling state.
  const { data: updated, error: updateErr } = await svc
    .from('email_drafts')
    .update({
      subject: gen.subject,
      body: gen.body,
      status: 'draft',
      error: null,
      scheduled_at: null,
      approved_at: null,
      approved_by: null,
      sending_started_at: null,
      send_attempts: 0,
      model: gen.model,
      gen_input_tokens: gen.inputTokens,
      gen_output_tokens: gen.outputTokens,
    })
    .eq('id', draftId)
    .eq('status', draft.status)
    .select('id');
  if (updateErr) {
    return NextResponse.json({ error: 'db_error', detail: updateErr.message }, { status: 500 });
  }
  if (!updated || updated.length === 0) {
    return NextResponse.json({ error: 'draft_changed' }, { status: 409 });
  }

  return NextResponse.json({ ok: true, draft_id: draftId });
}
