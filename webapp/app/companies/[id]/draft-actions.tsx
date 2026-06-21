'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DRAFT_LANGUAGES, type Contact } from '@/lib/db/types';

/**
 * AI draft generation, mounted on the company page (anchor #draft).
 * Picks one contact + template + language, POSTs /api/drafts/generate
 * for that single contact, then refreshes the route so the Activity
 * timeline and Engagement numbers pick up the new draft.
 */

type TemplateOption = { id: string; name: string };

type GenerateResult = { contact_id: string; draft_id?: string; error?: string };

type Notice = { kind: 'ok' } | { kind: 'error'; message: string };

export default function DraftActions({
  contacts,
  templates,
}: {
  companyId: string;
  contacts: Contact[];
  templates: TemplateOption[];
}) {
  const router = useRouter();

  // Default recipient: primary contact with an email, else any contact
  // with an email, else force an explicit choice.
  const defaultContact =
    contacts.find((c) => c.is_primary && c.email) ??
    contacts.find((c) => Boolean(c.email)) ??
    null;

  const [contactId, setContactId] = useState<string>(defaultContact?.id ?? '');
  const [templateId, setTemplateId] = useState<string>(templates[0]?.id ?? '');
  const [language, setLanguage] = useState<string>('en');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (templates.length === 0) {
    return (
      <p className="text-[13px]" style={{ color: 'var(--ink-4)' }}>
        No templates yet:{' '}
        <Link href="/templates" className="link-soft">create one</Link>{' '}
        to start generating drafts.
      </p>
    );
  }

  if (contacts.length === 0) {
    return (
      <p className="text-[13px]" style={{ color: 'var(--ink-4)' }}>
        Add a contact first.
      </p>
    );
  }

  const canGenerate = Boolean(contactId && templateId) && !busy;

  async function onGenerate() {
    if (!contactId || !templateId || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/drafts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: templateId,
          contact_ids: [contactId],
          language,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        results?: GenerateResult[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        setNotice({
          kind: 'error',
          message:
            data.error === 'anthropic_not_configured'
              ? "AI drafting isn't configured: ANTHROPIC_API_KEY missing."
              : data.detail || data.error || 'Draft generation failed.',
        });
        return;
      }
      const first = data.results?.[0];
      if (first?.draft_id) {
        setNotice({ kind: 'ok' });
        router.refresh();
      } else {
        setNotice({ kind: 'error', message: first?.error ?? 'Draft generation failed.' });
      }
    } catch (e) {
      setNotice({ kind: 'error', message: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 text-[13px]">
      <div>
        <FieldLabel htmlFor="draft-contact">Contact</FieldLabel>
        <select
          id="draft-contact"
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
          className="w-full rounded px-2.5 py-1.5 text-[13px] border"
          style={{ borderColor: 'var(--line-strong)' }}
        >
          {!defaultContact && (
            <option value="" disabled>
              Select a contact…
            </option>
          )}
          {contacts.map((c) => (
            <option key={c.id} value={c.id} disabled={!c.email}>
              {`${c.full_name || 'Unnamed contact'} · ${c.email || 'no email'}`}
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <div>
          <FieldLabel htmlFor="draft-template">Template</FieldLabel>
          <select
            id="draft-template"
            value={templateId}
            onChange={(e) => setTemplateId(e.target.value)}
            className="w-full rounded px-2.5 py-1.5 text-[13px] border"
            style={{ borderColor: 'var(--line-strong)' }}
          >
            {templates.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
        <div>
          <FieldLabel htmlFor="draft-language">Language</FieldLabel>
          <select
            id="draft-language"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="w-full rounded px-2.5 py-1.5 text-[13px] border"
            style={{ borderColor: 'var(--line-strong)' }}
          >
            {DRAFT_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>
      </div>

      <button
        type="button"
        className="btn-primary w-full text-[13px]"
        disabled={!canGenerate}
        onClick={() => void onGenerate()}
      >
        {busy ? 'Generating…' : 'Generate draft'}
      </button>

      {busy && (
        <p className="text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
          Writing with AI. This usually takes 5–10 seconds.
        </p>
      )}

      {notice &&
        (notice.kind === 'ok' ? (
          <div
            className="rise-in text-[12.5px] rounded px-3 py-2"
            style={{ background: 'var(--ok-bg)', color: 'var(--ok-ink)' }}
          >
            Draft created. Review it in{' '}
            <Link href="/drafts" className="link-soft">Drafts →</Link>
          </div>
        ) : (
          <div
            className="rise-in text-[12.5px] rounded px-3 py-2"
            style={{ background: 'var(--warn-bg)', color: 'var(--warn-ink)' }}
          >
            {notice.message}
          </div>
        ))}
    </div>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-[10.5px] uppercase tracking-wider mb-1"
      style={{ color: 'var(--ink-4)' }}
    >
      {children}
    </label>
  );
}
