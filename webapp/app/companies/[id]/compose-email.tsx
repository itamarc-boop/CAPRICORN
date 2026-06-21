'use client';
import { useMemo, useState } from 'react';
import { renderEmail } from '@/lib/templates/render';
import type { Company, Contact, Template } from '@/lib/db/types';

const CUSTOM = '__custom__';

/**
 * Free-form compose panel. Template is OPTIONAL (blank email is the first
 * option) and composing works even when no contact has an email — the To
 * field is always editable, and "Custom recipient…" lets the user address
 * anyone.
 *
 * Render rule: switching template or contact while a template is chosen
 * overwrites subject+body from the rendered template (tracked via a
 * `${tplId}:${contactSel}` key). Picking "Blank email" leaves the current
 * text exactly as-is.
 */
export default function ComposeEmail(
  { company, contacts, templates }: { company: Company; contacts: Contact[]; templates: Template[] }
) {
  // Default recipient: primary contact, else first, else custom.
  const defaultContact = contacts.find((c) => c.is_primary) ?? contacts[0] ?? null;

  const [contactSel, setContactSel] = useState<string>(defaultContact?.id ?? CUSTOM);
  const [to, setTo] = useState<string>(defaultContact?.email ?? '');

  const selectedContact = useMemo(
    () => (contactSel === CUSTOM ? null : contacts.find((c) => c.id === contactSel) ?? null),
    [contactSel, contacts]
  );

  const [templateId, setTemplateId] = useState<string>('');
  const tpl = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templateId, templates]
  );

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [renderedFor, setRenderedFor] = useState<string>('');

  // Re-render subject+body whenever the template OR the recipient changes
  // while a template is chosen. Blank ('' templateId) never overwrites.
  const renderKey = tpl ? `${tpl.id}:${contactSel}` : '';
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

  function onContactChange(value: string) {
    setContactSel(value);
    if (value === CUSTOM) {
      setTo('');
    } else {
      const c = contacts.find((x) => x.id === value);
      setTo(c?.email ?? '');
    }
  }

  function onTemplateChange(value: string) {
    setTemplateId(value);
    // Picking Blank leaves text as-is, but reset the render key so
    // re-picking the same template afterwards renders again.
    if (value === '') setRenderedFor('');
  }

  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const canSend = to.includes('@') && subject.trim().length > 0 && body.trim().length > 0;
  const showSaveHint =
    selectedContact !== null && !selectedContact.email && to.trim().length > 0;

  async function onSend() {
    if (!canSend) return;
    setSending(true);
    setResult(null);
    try {
      const res = await fetch('/api/email/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: company.id,
          contact_id: contactSel === CUSTOM ? null : contactSel,
          template_id: tpl?.id ?? null,
          to: to.trim(),
          subject,
          body,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ ok: false, message: data.message || data.detail || data.error || 'Send failed' });
      } else {
        setResult({ ok: true, message: `Sent from ${data.from_email}` });
      }
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-3 text-[13px]">
      <div>
        <FieldLabel>Contact</FieldLabel>
        <select
          value={contactSel}
          onChange={(e) => onContactChange(e.target.value)}
          className="w-full rounded px-2.5 py-1.5 text-[13px] border"
          style={{ borderColor: 'var(--line-strong)' }}
        >
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {`${c.full_name || 'Unnamed contact'} · ${c.email || 'no email'}`}
            </option>
          ))}
          <option value={CUSTOM}>Custom recipient…</option>
        </select>
      </div>

      <div>
        <FieldLabel>To</FieldLabel>
        <input
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="name@company.com"
          className="w-full rounded px-2.5 py-1.5 text-[13px] border"
          style={{ borderColor: 'var(--line-strong)' }}
        />
        {showSaveHint && (
          <p className="mt-1 text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
            Tip: save this address on the contact so it&rsquo;s remembered
          </p>
        )}
      </div>

      <div>
        <FieldLabel>Template</FieldLabel>
        <select
          value={templateId}
          onChange={(e) => onTemplateChange(e.target.value)}
          className="w-full rounded px-2.5 py-1.5 text-[13px] border"
          style={{ borderColor: 'var(--line-strong)' }}
        >
          <option value="">Blank email</option>
          {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        {templates.length === 0 && (
          <p className="mt-1 text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
            No templates yet: <a href="/templates" className="link-soft">create one</a> to reuse copy.
          </p>
        )}
      </div>

      <div>
        <FieldLabel>Subject</FieldLabel>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="w-full rounded px-2.5 py-1.5 text-[13px] border"
          style={{ borderColor: 'var(--line-strong)' }}
        />
      </div>

      <div>
        <FieldLabel>Body</FieldLabel>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={14}
          className="w-full rounded px-3 py-2 text-[12.5px] border leading-relaxed"
          style={{ borderColor: 'var(--line-strong)' }}
        />
      </div>

      <button
        onClick={onSend}
        disabled={sending || !canSend}
        className="btn-primary w-full"
      >
        {sending ? 'Sending…' : 'Send via Gmail'}
      </button>

      {result && (
        <div
          className="rise-in text-[12px] rounded px-2.5 py-2"
          style={{
            background: result.ok ? 'var(--ok-bg)' : 'var(--warn-bg)',
            color: result.ok ? 'var(--ok-ink)' : 'var(--warn-ink)',
          }}
        >
          {result.message}
        </div>
      )}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label
      className="block text-[10.5px] uppercase tracking-wider mb-1"
      style={{ color: 'var(--ink-4)' }}
    >
      {children}
    </label>
  );
}
