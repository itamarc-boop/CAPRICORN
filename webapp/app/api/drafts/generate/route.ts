import { NextRequest, NextResponse } from 'next/server';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase, getServiceSupabase } from '@/lib/supabase/server';
import { getAnthropic } from '@/lib/ai/anthropic';
import { generateDraft, type DraftTemplate } from '@/lib/ai/draft';
import type { Company, Contact } from '@/lib/db/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Server-side cap on contacts per generation batch. Extras are ignored. */
const MAX_CONTACTS_PER_BATCH = 10;
/** How many generation calls run at once. */
const CONCURRENCY = 3;

type GenerateResult = { contact_id: string; draft_id?: string; error?: string };

type ContactWithCompany = Contact & { companies: Company | null };

/** Small fixed-size worker pool; preserves input order in the results array. */
async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * POST /api/drafts/generate
 * body: { template_id: string, contact_ids: string[], language: string }
 * → 200 { results: Array<{ contact_id, draft_id? , error? }> } in input order
 * → 403 { error: 'forbidden' } | 400 { error: 'missing_fields' }
 * → 404 { error: 'template_not_found' } | 500 { error: 'anthropic_not_configured' }
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

  const templateId = typeof payload.template_id === 'string' ? payload.template_id : '';
  const language = typeof payload.language === 'string' ? payload.language : '';
  const contactIdsInput = Array.isArray(payload.contact_ids)
    ? payload.contact_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  if (!templateId || !language || contactIdsInput.length === 0) {
    return NextResponse.json({ error: 'missing_fields' }, { status: 400 });
  }

  // Cap at 10 — extras are silently ignored.
  const contactIds = contactIdsInput.slice(0, MAX_CONTACTS_PER_BATCH);

  // Fail fast (before any DB writes) when the API key is missing.
  try {
    getAnthropic();
  } catch {
    return NextResponse.json({ error: 'anthropic_not_configured' }, { status: 500 });
  }

  // Capture the auth user for created_by.
  const supabase = await getServerSupabase();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  const createdBy = authUser?.id ?? null;

  const svc = getServiceSupabase();

  // Template.
  const { data: template, error: templateErr } = await svc
    .from('templates')
    .select('id, name, subject_template, body_template')
    .eq('id', templateId)
    .maybeSingle();
  if (templateErr) {
    return NextResponse.json({ error: 'db_error', detail: templateErr.message }, { status: 500 });
  }
  if (!template) {
    return NextResponse.json({ error: 'template_not_found' }, { status: 404 });
  }
  const draftTemplate: DraftTemplate = {
    subject_template: template.subject_template,
    body_template: template.body_template,
  };

  // Contacts with their embedded company.
  const { data: contactRows, error: contactsErr } = await svc
    .from('contacts')
    .select('*, companies(*)')
    .in('id', contactIds);
  if (contactsErr) {
    return NextResponse.json({ error: 'db_error', detail: contactsErr.message }, { status: 500 });
  }
  const contactById = new Map<string, ContactWithCompany>(
    ((contactRows ?? []) as ContactWithCompany[]).map((c) => [c.id, c])
  );

  const generationBatchId = crypto.randomUUID();

  const results: GenerateResult[] = await runPool(contactIds, CONCURRENCY, async (contactId) => {
    const contact = contactById.get(contactId);
    if (!contact) return { contact_id: contactId, error: 'contact_not_found' };
    if (!contact.email) return { contact_id: contactId, error: 'no_email' };
    const company = contact.companies;
    if (!company) return { contact_id: contactId, error: 'company_not_found' };

    try {
      const draft = await generateDraft({
        company,
        contact,
        template: draftTemplate,
        language,
      });

      const { data: inserted, error: insertErr } = await svc
        .from('email_drafts')
        .insert({
          company_id: contact.company_id,
          contact_id: contact.id,
          template_id: template.id,
          generation_batch_id: generationBatchId,
          language,
          subject: draft.subject,
          body: draft.body,
          status: 'draft',
          model: draft.model,
          gen_input_tokens: draft.inputTokens,
          gen_output_tokens: draft.outputTokens,
          created_by: createdBy,
        })
        .select('id')
        .single();
      if (insertErr || !inserted) {
        throw new Error(insertErr?.message ?? 'draft_insert_failed');
      }

      return { contact_id: contactId, draft_id: inserted.id as string };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { contact_id: contactId, error: msg.slice(0, 200) };
    }
  });

  return NextResponse.json({ results });
}
