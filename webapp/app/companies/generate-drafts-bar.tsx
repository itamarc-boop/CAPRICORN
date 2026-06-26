'use client';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  type Company,
  type Contact,
  type Template,
  DRAFT_LANGUAGES,
} from '@/lib/db/types';

export type TemplateOption = Pick<Template, 'id' | 'name'>;

export type DraftTargetCompany = Pick<Company, 'id' | 'company_name'> & {
  contacts: Pick<Contact, 'id' | 'full_name' | 'title' | 'email' | 'is_primary'>[];
};

type GenerateResult = { contact_id: string; draft_id?: string; error?: string };

const CHUNK_SIZE = 5;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export default function GenerateDraftsBar({
  selectedCompanies,
  templates,
  onDone,
}: {
  selectedCompanies: DraftTargetCompany[];
  templates: TemplateOption[];
  onDone: () => void;
}) {
  const [templateId, setTemplateId] = useState<string>(templates[0]?.id ?? '');
  const [language, setLanguage] = useState<string>('en');
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [created, setCreated] = useState(0);
  const [failed, setFailed] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  // Number of contacts targeted by the current/last run (excludes contacts
  // that already produced a draft in a previous run).
  const [runTotal, setRunTotal] = useState(0);
  // Contact ids that already produced a draft, across runs — so Retry never
  // resubmits contacts that succeeded and creates duplicate drafts.
  const succeededRef = useRef<Set<string>>(new Set());

  // For each selected company: the primary contact with an email, else the
  // first contact with an email. Companies with no emailed contact are skipped.
  const targets = useMemo(() => {
    const contactIds: string[] = [];
    let skipped = 0;
    for (const company of selectedCompanies) {
      const withEmail = company.contacts.filter(ct => ct.email != null && ct.email !== '');
      if (withEmail.length === 0) {
        skipped += 1;
        continue;
      }
      const pick = withEmail.find(ct => ct.is_primary) ?? withEmail[0];
      contactIds.push(pick.id);
    }
    return { contactIds, skipped };
  }, [selectedCompanies]);

  const total = targets.contactIds.length;
  const noTemplates = templates.length === 0;
  const disabled = phase === 'running' || noTemplates || !templateId || total === 0;

  async function run() {
    if (disabled) return;
    // Only submit contacts that have not already produced a draft in a
    // previous run (partial-failure Retry must not duplicate drafts).
    const pendingIds = targets.contactIds.filter(id => !succeededRef.current.has(id));
    setPhase('running');
    setRunTotal(pendingIds.length);
    setCreated(0);
    setFailed(0);
    setLastError(null);

    if (pendingIds.length === 0) {
      setPhase('done');
      return;
    }

    let createdCount = 0;
    let failedCount = 0;
    let errMsg: string | null = null;

    for (const ids of chunk(pendingIds, CHUNK_SIZE)) {
      try {
        const res = await fetch('/api/drafts/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ template_id: templateId, contact_ids: ids, language }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => null) as { error?: string } | null;
          failedCount += ids.length;
          errMsg = payload?.error ?? `request failed (HTTP ${res.status})`;
        } else {
          const payload = await res.json() as { results?: GenerateResult[] };
          for (const r of payload.results ?? []) {
            if (r.draft_id) {
              createdCount += 1;
              succeededRef.current.add(r.contact_id);
            } else {
              failedCount += 1;
              if (r.error) errMsg = r.error;
            }
          }
        }
      } catch (e) {
        failedCount += ids.length;
        errMsg = e instanceof Error ? e.message : 'network error';
      }
      setCreated(createdCount);
      setFailed(failedCount);
      setLastError(errMsg);
    }

    setPhase('done');
  }

  return (
    <div
      className="card-soft fixed bottom-0 inset-x-0 z-40"
      style={{
        borderRadius: 0,
        borderTop: '1px solid var(--line-strong)',
        background: 'var(--surface)',
        boxShadow: '0 -10px 30px rgba(16, 24, 40, 0.08)',
      }}
    >
      <div className="max-w-7xl mx-auto px-6 py-4 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <div className="min-w-[200px]">
          <div className="micro-label">Generate drafts</div>
          <div className="text-[12.5px] mt-0.5" style={{ color: 'var(--ink-2)' }}>
            <span className="font-tabular">{selectedCompanies.length}</span> companies ·{' '}
            <span className="font-tabular">{total}</span> contacts targeted
            {targets.skipped > 0 && (
              <span style={{ color: 'var(--warn-ink)' }}>
                {' '}· <span className="font-tabular">{targets.skipped}</span> skipped (no email)
              </span>
            )}
          </div>
        </div>

        {noTemplates ? (
          <div className="text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
            No templates yet:{' '}
            <Link href="/templates" className="link-soft">create one at /templates</Link> first.
          </div>
        ) : (
          <>
            <select
              value={templateId}
              onChange={e => setTemplateId(e.target.value)}
              disabled={phase === 'running'}
              aria-label="Template"
              className="rounded px-2.5 py-1.5 text-[12.5px] border"
              style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)' }}
            >
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <select
              value={language}
              onChange={e => setLanguage(e.target.value)}
              disabled={phase === 'running'}
              aria-label="Language"
              className="rounded px-2.5 py-1.5 text-[12.5px] border"
              style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)' }}
            >
              {DRAFT_LANGUAGES.map(l => (
                <option key={l.code} value={l.code}>{l.label}</option>
              ))}
            </select>
          </>
        )}

        <div className="ml-auto flex items-center gap-3">
          {phase === 'running' && (
            <span className="font-tabular text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
              {created}/{runTotal} drafted
            </span>
          )}
          {phase === 'done' && (
            <span className="text-[12.5px]" style={{ color: 'var(--ink-2)' }}>
              <span className="font-tabular">{created}</span> drafts created ·{' '}
              <span className="font-tabular">{failed + targets.skipped}</span> failed/skipped
              {' '}
              <Link href="/drafts" className="link-soft">Review in approval queue →</Link>
            </span>
          )}
          <button
            type="button"
            className="btn-primary text-[12.5px]"
            disabled={disabled}
            onClick={run}
          >
            {phase === 'running'
              ? 'Generating…'
              : phase === 'done' && failed > 0
                ? 'Retry'
                : `Generate ${total} draft${total === 1 ? '' : 's'}`}
          </button>
          <button
            type="button"
            className="btn-ghost text-[12.5px]"
            disabled={phase === 'running'}
            onClick={onDone}
          >
            {phase === 'done' ? 'Done' : 'Cancel'}
          </button>
        </div>

        {lastError && phase !== 'running' && (
          <div className="basis-full text-[12px]" style={{ color: 'var(--warn-ink)' }}>
            Last error: {lastError}
          </div>
        )}
      </div>
    </div>
  );
}
