'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { renderEmail } from '@/lib/templates/render';
import {
  DRAFT_LANGUAGES,
  DRAFT_STATUS_LABELS,
  DRAFT_STATUS_STYLES,
  type Company,
  type Contact,
  type DraftStatus,
  type Template,
} from '@/lib/db/types';

/**
 * Unified email panel on the dossier. ONE model: every email is a reviewable
 * draft. Compose (manually or from a template) or write with AI — both save a
 * draft. Then approve / approve & send / reject inline, finishing the whole
 * action without leaving the company. Single "Approve & send" fires immediately
 * (/api/drafts/[id]/send-now); batches still use the paced queue on /drafts.
 *
 * Replaces the old split of ComposeEmail (instant send, no draft) + DraftActions
 * (AI generate only).
 */

export type PanelDraft = {
  id: string;
  contact_id: string | null;
  subject: string;
  status: DraftStatus;
  language: string;
  created_at: string;
  sent_at: string | null;
  error: string | null;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso: string | null): string {
  if (!iso || iso.length < 10) return '';
  const mi = parseInt(iso.slice(5, 7), 10) - 1;
  const day = parseInt(iso.slice(8, 10), 10);
  return `${MONTHS[mi] ?? ''} ${day}`;
}

export default function EmailPanel({
  company,
  contacts,
  templates,
  initialDrafts,
}: {
  company: Company;
  contacts: Contact[];
  templates: Template[];
  initialDrafts: PanelDraft[];
}) {
  const [drafts, setDrafts] = useState<PanelDraft[]>(initialDrafts);
  const userIdRef = useRef<string | null>(null);

  // Compose state.
  const defaultContact =
    contacts.find((c) => c.is_primary && c.email) ??
    contacts.find((c) => Boolean(c.email)) ??
    contacts[0] ??
    null;
  const [contactId, setContactId] = useState<string>(defaultContact?.id ?? '');
  // Default to the first template (not Blank) so "Write with AI" is usable
  // immediately and the body starts from a real draft. Switch to Blank to compose
  // from scratch.
  const [templateId, setTemplateId] = useState<string>(templates[0]?.id ?? '');
  const [language, setLanguage] = useState<string>('en');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [renderedFor, setRenderedFor] = useState('');

  // Action state.
  const [busy, setBusy] = useState<string | null>(null); // 'save' | 'ai' | draftId
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  const contactsById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const selectedContact = contactId ? contactsById.get(contactId) ?? null : null;
  const tpl = useMemo(() => templates.find((t) => t.id === templateId) ?? null, [templateId, templates]);

  useEffect(() => {
    void getBrowserSupabase()
      .auth.getUser()
      .then(({ data }) => {
        userIdRef.current = data.user?.id ?? null;
      });
  }, []);

  const refetch = useCallback(async () => {
    const supabase = getBrowserSupabase();
    const { data } = await supabase
      .from('email_drafts')
      .select('id, contact_id, subject, status, language, created_at, sent_at, error')
      .eq('company_id', company.id)
      .order('created_at', { ascending: false });
    if (data) setDrafts(data as PanelDraft[]);
  }, [company.id]);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    const channel = supabase
      .channel(`email-panel-${company.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'email_drafts', filter: `company_id=eq.${company.id}` },
        () => {
          void refetch();
        }
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [company.id, refetch]);

  // Render subject+body from the template when template/contact changes. Blank
  // template ('') never overwrites the current text. Mirrors ComposeEmail.
  const renderKey = tpl ? `${tpl.id}:${contactId}` : '';
  if (tpl && renderedFor !== renderKey) {
    const { subject: s, body: b } = renderEmail(tpl.subject_template, tpl.body_template, {
      company_name: company.company_name,
      contact_name: selectedContact?.full_name ?? '',
      contact_title: selectedContact?.title ?? '',
      contact_email: selectedContact?.email ?? '',
      industry: company.industry,
      country: company.country,
      city: company.city,
      website: company.website,
      icp_tier: company.icp_tier,
      icp_score: company.icp_score,
      deal_probability: company.deal_probability,
      what_to_sell_gaps: company.what_to_sell_gaps,
      judge_reason: company.judge_reason,
      judge_pattern: company.judge_pattern,
    });
    setSubject(s);
    setBody(b);
    setRenderedFor(renderKey);
  }

  function onTemplateChange(value: string) {
    setTemplateId(value);
    if (value === '') setRenderedFor('');
  }

  const canSave = Boolean(contactId) && subject.trim().length > 0 && body.trim().length > 0;
  const canAI = Boolean(contactId && templateId && selectedContact?.email) && busy === null;
  const showSaveHint = selectedContact !== null && !selectedContact.email;

  async function saveDraft() {
    if (!canSave || busy) return;
    setBusy('save');
    setNotice(null);
    try {
      const res = await fetch('/api/drafts/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: company.id,
          contact_id: contactId,
          template_id: tpl?.id ?? null,
          language,
          subject,
          body,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setNotice({ kind: 'warn', text: data.detail || data.error || 'Could not save the draft.' });
        return;
      }
      setNotice({ kind: 'ok', text: 'Draft saved. Review and send it below.' });
      await refetch();
    } catch (e) {
      setNotice({ kind: 'warn', text: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setBusy(null);
    }
  }

  async function writeWithAI() {
    if (!canAI || busy) return;
    setBusy('ai');
    setNotice(null);
    try {
      const res = await fetch('/api/drafts/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: templateId, contact_ids: [contactId], language }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        results?: Array<{ draft_id?: string; error?: string }>;
        error?: string;
        detail?: string;
      };
      if (!res.ok) {
        setNotice({
          kind: 'warn',
          text:
            data.error === 'anthropic_not_configured'
              ? "AI drafting isn't configured yet."
              : data.detail || data.error || 'AI draft failed.',
        });
        return;
      }
      const first = data.results?.[0];
      if (first?.draft_id) {
        setNotice({ kind: 'ok', text: 'AI draft saved. Review and send it below.' });
        await refetch();
      } else {
        setNotice({ kind: 'warn', text: first?.error ?? 'AI draft failed.' });
      }
    } catch (e) {
      setNotice({ kind: 'warn', text: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setBusy(null);
    }
  }

  // Compare-and-swap status change (mirrors drafts-queue.updateStatus).
  async function updateStatus(id: string, from: DraftStatus, patch: Record<string, unknown>) {
    setBusy(id);
    setNotice(null);
    const supabase = getBrowserSupabase();
    const { data, error } = await supabase
      .from('email_drafts')
      .update(patch)
      .eq('id', id)
      .eq('status', from)
      .select('id');
    setBusy(null);
    if (error) {
      setNotice({ kind: 'warn', text: error.message });
      return;
    }
    if (!data || data.length === 0) {
      setNotice({ kind: 'warn', text: 'That draft changed elsewhere. Refreshed.' });
    }
    await refetch();
  }

  function approve(id: string) {
    return updateStatus(id, 'draft', {
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by: userIdRef.current,
      scheduled_at: null,
      send_attempts: 0,
    });
  }

  async function sendNow(id: string) {
    setBusy(id);
    setNotice(null);
    try {
      const res = await fetch(`/api/drafts/${id}/send-now`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setNotice({
          kind: 'warn',
          text:
            data.message ||
            (data.error === 'no_gmail_connected'
              ? 'Connect a Gmail mailbox first.'
              : data.error === 'no_recipient'
                ? 'This contact has no email. Add one first.'
                : 'Could not send.'),
        });
      } else {
        setNotice({ kind: 'ok', text: `Sent from ${data.from_email}.` });
      }
    } catch (e) {
      setNotice({ kind: 'warn', text: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setBusy(null);
      await refetch();
    }
  }

  return (
    <div className="space-y-4 text-[13px]">
      {/* ── Compose ─────────────────────────────────────────── */}
      {contacts.length === 0 ? (
        <p className="text-[13px]" style={{ color: 'var(--ink-4)' }}>
          Add a contact first to write an email.
        </p>
      ) : (
        <div className="space-y-3">
          <div>
            <FieldLabel htmlFor="compose-contact">Contact</FieldLabel>
            <select
              id="compose-contact"
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
              className="w-full rounded px-2.5 py-1.5 text-[13px] border"
              style={{ borderColor: 'var(--line-strong)' }}
            >
              {contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {`${c.full_name || 'Unnamed contact'} · ${c.email || 'no email'}`}
                </option>
              ))}
            </select>
            {showSaveHint && (
              <p className="mt-1 text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
                This contact has no email — add one on the contact to send.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <FieldLabel htmlFor="compose-template">Template</FieldLabel>
              <select
                id="compose-template"
                value={templateId}
                onChange={(e) => onTemplateChange(e.target.value)}
                className="w-full rounded px-2.5 py-1.5 text-[13px] border"
                style={{ borderColor: 'var(--line-strong)' }}
              >
                <option value="">Blank email</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div>
              <FieldLabel htmlFor="compose-language">Language</FieldLabel>
              <select
                id="compose-language"
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

          <div>
            <FieldLabel htmlFor="compose-subject">Subject</FieldLabel>
            <input
              id="compose-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded px-2.5 py-1.5 text-[13px] border"
              style={{ borderColor: 'var(--line-strong)' }}
            />
          </div>

          <div>
            <FieldLabel htmlFor="compose-body">Body</FieldLabel>
            <textarea
              id="compose-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              className="w-full rounded px-3 py-2 text-[12.5px] border leading-relaxed"
              style={{ borderColor: 'var(--line-strong)' }}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void saveDraft()}
              disabled={!canSave || busy !== null}
              className="btn-primary text-[13px]"
            >
              {busy === 'save' ? 'Saving…' : 'Save draft'}
            </button>
            <button
              type="button"
              onClick={() => void writeWithAI()}
              disabled={!canAI}
              className="btn-ghost text-[13px]"
              title={
                !templateId
                  ? 'Pick a template for AI to write from'
                  : !selectedContact?.email
                    ? 'The contact needs an email'
                    : undefined
              }
            >
              {busy === 'ai' ? 'Writing…' : 'Write with AI'}
            </button>
          </div>
          {templates.length === 0 && (
            <p className="text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
              No templates yet: <Link href="/templates" className="link-soft">create one</Link> to reuse copy or write with AI.
            </p>
          )}
          {templates.length > 0 && !canAI && busy === null && (
            <p className="text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
              {!selectedContact?.email
                ? 'Add an email to the selected contact to write with AI.'
                : !templateId
                  ? 'Pick a template to write with AI.'
                  : ''}
            </p>
          )}
        </div>
      )}

      {notice && (
        <div
          className="rise-in text-[12.5px] rounded px-3 py-2"
          style={
            notice.kind === 'ok'
              ? { background: 'var(--ok-bg)', color: 'var(--ok-ink)' }
              : { background: 'var(--warn-bg)', color: 'var(--warn-ink)' }
          }
        >
          {notice.text}
        </div>
      )}

      {/* ── Drafts for this company ─────────────────────────── */}
      {drafts.length > 0 && (
        <div className="pt-1">
          <div className="micro-label mb-2">Drafts &amp; sends</div>
          <ul className="space-y-2">
            {drafts.map((d) => {
              const style = DRAFT_STATUS_STYLES[d.status];
              const contact = d.contact_id ? contactsById.get(d.contact_id) : null;
              return (
                <li
                  key={d.id}
                  className="rounded border px-3 py-2.5"
                  style={{ borderColor: 'var(--line)', background: 'var(--surface-2)' }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium truncate" style={{ color: 'var(--ink)' }}>
                        {d.subject || '(no subject)'}
                      </div>
                      <div className="text-[11.5px] mt-0.5 truncate" style={{ color: 'var(--ink-3)' }}>
                        {contact?.full_name ?? contact?.email ?? 'contact'} · {d.language.toUpperCase()} ·{' '}
                        {d.status === 'sent' ? `sent ${fmtDate(d.sent_at)}` : fmtDate(d.created_at)}
                      </div>
                    </div>
                    <span className="pill shrink-0" style={{ color: style.ink, background: style.bg }}>
                      {DRAFT_STATUS_LABELS[d.status]}
                    </span>
                  </div>

                  {d.status === 'failed' && d.error && (
                    <p className="text-[11.5px] mt-1.5" style={{ color: 'var(--warn-ink)' }}>
                      {d.error}
                    </p>
                  )}

                  <div className="mt-2 flex flex-wrap gap-2">
                    {d.status === 'draft' && (
                      <>
                        <button
                          type="button"
                          onClick={() => void sendNow(d.id)}
                          disabled={busy === d.id}
                          className="btn-primary text-[12px]"
                        >
                          {busy === d.id ? '…' : 'Approve & send'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void approve(d.id)}
                          disabled={busy === d.id}
                          className="btn-ghost text-[12px]"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => void updateStatus(d.id, 'draft', { status: 'rejected' })}
                          disabled={busy === d.id}
                          className="btn-ghost text-[12px]"
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {d.status === 'approved' && (
                      <>
                        <button
                          type="button"
                          onClick={() => void sendNow(d.id)}
                          disabled={busy === d.id}
                          className="btn-primary text-[12px]"
                        >
                          {busy === d.id ? '…' : 'Send now'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void updateStatus(d.id, 'approved', { status: 'draft', scheduled_at: null })}
                          disabled={busy === d.id}
                          className="btn-ghost text-[12px]"
                        >
                          Unapprove
                        </button>
                      </>
                    )}
                    {d.status === 'failed' && (
                      <button
                        type="button"
                        onClick={() => void sendNow(d.id)}
                        disabled={busy === d.id}
                        className="btn-primary text-[12px]"
                      >
                        {busy === d.id ? '…' : 'Try again'}
                      </button>
                    )}
                    {d.status === 'rejected' && (
                      <button
                        type="button"
                        onClick={() => void updateStatus(d.id, 'rejected', { status: 'draft' })}
                        disabled={busy === d.id}
                        className="btn-ghost text-[12px]"
                      >
                        Restore
                      </button>
                    )}
                    {d.status === 'sending' && (
                      <span className="text-[11.5px] italic" style={{ color: 'var(--ink-4)' }}>
                        sending…
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-[11.5px] mt-2" style={{ color: 'var(--ink-4)' }}>
            Need to send a batch? <Link href="/drafts" className="link-soft">Review all drafts →</Link>
          </p>
        </div>
      )}
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
