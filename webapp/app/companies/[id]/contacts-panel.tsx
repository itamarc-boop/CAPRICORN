'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import type { Contact } from '@/lib/db/types';

/**
 * Editable contacts list for the company page. RLS allows contacts
 * SELECT / INSERT / UPDATE only — there is intentionally no delete.
 * After every successful write we update local state and call
 * router.refresh() so server-rendered siblings (compose email,
 * header) pick up the change.
 */

type FormValues = {
  full_name: string;
  title: string;
  email: string;
  phone: string;
  linkedin_url: string;
};

const EMPTY_FORM: FormValues = {
  full_name: '',
  title: '',
  email: '',
  phone: '',
  linkedin_url: '',
};

function toForm(c: Contact): FormValues {
  return {
    full_name: c.full_name ?? '',
    title: c.title ?? '',
    email: c.email ?? '',
    phone: c.phone ?? '',
    linkedin_url: c.linkedin_url ?? '',
  };
}

/** Normalized column patch from form values. Email lowercased/trimmed or null. */
function toPatch(form: FormValues) {
  const email = form.email.trim().toLowerCase();
  return {
    full_name: form.full_name.trim() || null,
    title: form.title.trim() || null,
    email: email || null,
    phone: form.phone.trim() || null,
    linkedin_url: form.linkedin_url.trim() || null,
  };
}

type Feedback = { kind: 'saving' | 'saved' | 'error'; message?: string } | null;

export default function ContactsPanel({
  companyId,
  initialContacts,
}: {
  companyId: string;
  initialContacts: Contact[];
}) {
  const router = useRouter();
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const sorted = [...contacts].sort(
    (a, b) =>
      Number(b.is_primary) - Number(a.is_primary) ||
      a.created_at.localeCompare(b.created_at)
  );

  async function saveEdit(id: string, form: FormValues): Promise<string | null> {
    setBusy(true);
    setFeedback({ kind: 'saving' });
    const patch = toPatch(form);
    const supabase = getBrowserSupabase();
    const { error } = await supabase.from('contacts').update(patch).eq('id', id);
    setBusy(false);
    if (error) {
      setFeedback({ kind: 'error', message: error.message });
      return error.message;
    }
    setContacts((prev) =>
      prev.map((c) =>
        c.id === id ? { ...c, ...patch, updated_at: new Date().toISOString() } : c
      )
    );
    setEditingId(null);
    setFeedback({ kind: 'saved' });
    router.refresh();
    return null;
  }

  async function addContact(form: FormValues): Promise<string | null> {
    setBusy(true);
    setFeedback({ kind: 'saving' });
    const patch = toPatch(form);
    const supabase = getBrowserSupabase();
    const { data, error } = await supabase
      .from('contacts')
      .insert({
        company_id: companyId,
        source: 'manual',
        is_primary: contacts.length === 0,
        ...patch,
      })
      .select('*')
      .single();
    setBusy(false);
    if (error) {
      setFeedback({ kind: 'error', message: error.message });
      return error.message;
    }
    setContacts((prev) => [...prev, data as Contact]);
    setAdding(false);
    setFeedback({ kind: 'saved' });
    router.refresh();
    return null;
  }

  async function makePrimary(target: Contact) {
    setBusy(true);
    setFeedback({ kind: 'saving' });
    const supabase = getBrowserSupabase();
    const current = contacts.find((c) => c.is_primary && c.id !== target.id);
    if (current) {
      const { error } = await supabase
        .from('contacts')
        .update({ is_primary: false })
        .eq('id', current.id);
      if (error) {
        setBusy(false);
        setFeedback({ kind: 'error', message: error.message });
        return;
      }
    }
    const { error } = await supabase
      .from('contacts')
      .update({ is_primary: true })
      .eq('id', target.id);
    setBusy(false);
    if (error) {
      setFeedback({ kind: 'error', message: error.message });
      return;
    }
    setContacts((prev) => prev.map((c) => ({ ...c, is_primary: c.id === target.id })));
    setFeedback({ kind: 'saved' });
    router.refresh();
  }

  return (
    <div>
      {sorted.length > 0 ? (
        <ul className="divide-y" style={{ borderColor: 'var(--line-soft)' }}>
          {sorted.map((c) =>
            editingId === c.id ? (
              <li key={c.id} className="py-3 first:pt-0 last:pb-0">
                <ContactForm
                  initial={toForm(c)}
                  busy={busy}
                  saveLabel="Save"
                  onSave={(form) => saveEdit(c.id, form)}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li key={c.id} className="row-hover -mx-2 px-2 rounded py-3 first:pt-0 last:pb-0 text-[13px] space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium" style={{ color: 'var(--ink)' }}>
                    {c.full_name || 'Unnamed contact'}
                  </span>
                  {c.title && <span style={{ color: 'var(--ink-3)' }}>· {c.title}</span>}
                  {c.is_primary && (
                    <span
                      className="pill text-[10px]"
                      style={{ color: 'var(--info-ink)', background: 'var(--info-bg)' }}
                    >
                      primary
                    </span>
                  )}
                  <span className="ml-auto flex items-center gap-1.5 shrink-0">
                    {!c.is_primary && (
                      <button
                        type="button"
                        className="btn-ghost text-[11px]"
                        style={{ padding: '3px 9px' }}
                        disabled={busy}
                        onClick={() => void makePrimary(c)}
                      >
                        Make primary
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-ghost text-[11px]"
                      style={{ padding: '3px 9px' }}
                      disabled={busy}
                      onClick={() => {
                        setAdding(false);
                        setEditingId(c.id);
                      }}
                    >
                      Edit
                    </button>
                  </span>
                </div>
                {c.email && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="font-tabular text-[12.5px]" style={{ color: 'var(--ink-2)' }}>
                      {c.email}
                    </span>
                    {c.email_label && (
                      <span
                        className="pill text-[10px]"
                        style={{ color: 'var(--muted-ink)', background: 'var(--muted-bg)' }}
                      >
                        {c.email_label}
                      </span>
                    )}
                  </div>
                )}
                {c.linkedin_url && (
                  <div>
                    <a
                      href={c.linkedin_url}
                      target="_blank"
                      rel="noreferrer"
                      className="link-soft text-[12.5px]"
                    >
                      LinkedIn profile →
                    </a>
                  </div>
                )}
                {c.phone && (
                  <div className="font-tabular text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
                    {c.phone}
                  </div>
                )}
              </li>
            )
          )}
        </ul>
      ) : (
        !adding && (
          <p className="empty-note">
            No contacts on file for this company.
          </p>
        )
      )}

      {adding && (
        <div
          className={sorted.length > 0 ? 'pt-3 mt-3 border-t' : ''}
          style={sorted.length > 0 ? { borderColor: 'var(--line-soft)' } : undefined}
        >
          <ContactForm
            initial={EMPTY_FORM}
            busy={busy}
            saveLabel="Add contact"
            onSave={addContact}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      <div className="flex items-center justify-between mt-3.5">
        {!adding ? (
          <button
            type="button"
            className="btn-ghost text-[12px]"
            style={{ padding: '5px 11px' }}
            disabled={busy}
            onClick={() => {
              setEditingId(null);
              setAdding(true);
              setFeedback(null);
            }}
          >
            + Add contact
          </button>
        ) : (
          <span />
        )}
        {feedback && (
          <span
            className="text-[11.5px]"
            style={{
              color: feedback.kind === 'error' ? 'var(--warn-ink)' : 'var(--ink-3)',
            }}
          >
            {feedback.kind === 'saving'
              ? 'Saving…'
              : feedback.kind === 'saved'
                ? 'Saved'
                : `Error: ${feedback.message ?? 'something went wrong'}`}
          </span>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   Inline contact form, shared by edit and add.
   ──────────────────────────────────────────────────────────────── */

function ContactForm({
  initial,
  busy,
  saveLabel,
  onSave,
  onCancel,
}: {
  initial: FormValues;
  busy: boolean;
  saveLabel: string;
  onSave: (form: FormValues) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormValues>(initial);
  const [emailError, setEmailError] = useState<string | null>(null);

  function set<K extends keyof FormValues>(key: K, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (key === 'email') setEmailError(null);
  }

  async function submit() {
    const email = form.email.trim();
    if (email && !email.includes('@')) {
      setEmailError('That does not look like an email address.');
      return;
    }
    await onSave(form);
  }

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <FormField label="Full name">
          <input
            autoFocus
            type="text"
            value={form.full_name}
            onChange={(e) => set('full_name', e.target.value)}
            placeholder="Jane Doe"
            className="w-full rounded border px-2 py-1 text-[13px]"
            style={{ borderColor: 'var(--line-strong)' }}
          />
        </FormField>
        <FormField label="Title">
          <input
            type="text"
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Purchasing manager"
            className="w-full rounded border px-2 py-1 text-[13px]"
            style={{ borderColor: 'var(--line-strong)' }}
          />
        </FormField>
        <FormField label="Email" error={emailError}>
          <input
            type="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            placeholder="jane@company.com"
            className="w-full rounded border px-2 py-1 text-[13px] font-tabular"
            style={{ borderColor: emailError ? 'var(--warn-ink)' : 'var(--line-strong)' }}
          />
        </FormField>
        <FormField label="Phone">
          <input
            type="text"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
            placeholder="+44 20 …"
            className="w-full rounded border px-2 py-1 text-[13px] font-tabular"
            style={{ borderColor: 'var(--line-strong)' }}
          />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="LinkedIn URL">
            <input
              type="text"
              value={form.linkedin_url}
              onChange={(e) => set('linkedin_url', e.target.value)}
              placeholder="https://linkedin.com/in/…"
              className="w-full rounded border px-2 py-1 text-[13px]"
              style={{ borderColor: 'var(--line-strong)' }}
            />
          </FormField>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-primary text-[12px]"
          style={{ padding: '5px 12px' }}
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? 'Saving…' : saveLabel}
        </button>
        <button
          type="button"
          className="btn-ghost text-[12px]"
          style={{ padding: '4px 11px' }}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FormField({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span
        className="block text-[10.5px] uppercase tracking-wider mb-1"
        style={{ color: 'var(--ink-4)' }}
      >
        {label}
      </span>
      {children}
      {error && (
        <span className="block text-[11px] mt-1" style={{ color: 'var(--warn-ink)' }}>
          {error}
        </span>
      )}
    </label>
  );
}
