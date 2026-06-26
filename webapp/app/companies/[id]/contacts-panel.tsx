'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { isEmail } from '@/lib/email/validate';
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
        <ul className="space-y-0.5">
          {sorted.map((c) =>
            editingId === c.id ? (
              <li
                key={c.id}
                className="rounded-md p-3 -mx-1"
                style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
              >
                <ContactForm
                  initial={toForm(c)}
                  busy={busy}
                  saveLabel="Save"
                  onSave={(form) => saveEdit(c.id, form)}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li
                key={c.id}
                className="row-hover -mx-2 rounded-md px-2 py-2.5 flex items-start gap-3"
              >
                <Avatar name={c.full_name} email={c.email} primary={c.is_primary} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-[13.5px] font-medium truncate"
                      style={{ color: 'var(--ink)' }}
                    >
                      {c.full_name || 'Unnamed contact'}
                    </span>
                    {c.title && (
                      <span
                        className="text-[12.5px] truncate"
                        style={{ color: 'var(--ink-3)' }}
                      >
                        {c.title}
                      </span>
                    )}
                    {c.is_primary && (
                      <span
                        className="text-[10px] uppercase tracking-wider font-semibold shrink-0"
                        style={{ color: 'var(--info-ink)' }}
                      >
                        Primary
                      </span>
                    )}
                    <span className="ml-auto flex items-center gap-0.5 shrink-0">
                      {!c.is_primary && (
                        <IconButton
                          label={`Make ${c.full_name || 'contact'} the primary contact`}
                          onClick={() => void makePrimary(c)}
                          disabled={busy}
                        >
                          <StarIcon />
                        </IconButton>
                      )}
                      <IconButton
                        label={`Edit ${c.full_name || 'contact'}`}
                        onClick={() => {
                          setAdding(false);
                          setEditingId(c.id);
                        }}
                        disabled={busy}
                      >
                        <PencilIcon />
                      </IconButton>
                    </span>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
                    {c.email && (
                      <ContactLink href={`mailto:${c.email}`} icon={<MailIcon />} mono>
                        {c.email}
                      </ContactLink>
                    )}
                    {c.email_label && (
                      <span
                        className="pill text-[10px]"
                        style={{ color: 'var(--muted-ink)', background: 'var(--muted-bg)' }}
                      >
                        {c.email_label}
                      </span>
                    )}
                    {c.phone && (
                      <ContactLink
                        href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}
                        icon={<PhoneIcon />}
                        mono
                      >
                        {c.phone}
                      </ContactLink>
                    )}
                    {c.linkedin_url && (
                      <ContactLink href={c.linkedin_url} icon={<LinkExternalIcon />} external>
                        LinkedIn
                      </ContactLink>
                    )}
                    {!c.email && !c.phone && !c.linkedin_url && (
                      <span className="text-[12px] italic" style={{ color: 'var(--ink-4)' }}>
                        No contact details yet.
                      </span>
                    )}
                  </div>
                </div>
              </li>
            )
          )}
        </ul>
      ) : (
        !adding && (
          <p className="empty-note">No contacts on file for this company.</p>
        )
      )}

      {adding && (
        <div
          className={sorted.length > 0 ? 'mt-2.5 rounded-md p-3 -mx-1' : 'rounded-md p-3 -mx-1'}
          style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
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
            className="inline-flex items-center gap-1.5 text-[12.5px] link-soft"
            disabled={busy}
            onClick={() => {
              setEditingId(null);
              setAdding(true);
              setFeedback(null);
            }}
          >
            <PlusIcon />
            Add contact
          </button>
        ) : (
          <span />
        )}
        {feedback && (
          <span
            aria-live="polite"
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
   Contact-row building blocks
   ──────────────────────────────────────────────────────────────── */

function initialsOf(name: string | null, email: string | null): string {
  const n = (name ?? '').trim();
  if (n) {
    const parts = n.split(/\s+/);
    const two = ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).trim();
    return (two || n[0]).toUpperCase();
  }
  const e = (email ?? '').trim();
  return e ? e[0].toUpperCase() : '?';
}

function Avatar({
  name,
  email,
  primary,
}: {
  name: string | null;
  email: string | null;
  primary: boolean;
}) {
  return (
    <span
      aria-hidden
      className="grid place-items-center rounded-full shrink-0 text-[12px] font-semibold select-none"
      style={{
        width: 34,
        height: 34,
        marginTop: 1,
        background: primary ? 'var(--navy)' : 'var(--surface-2)',
        color: primary ? '#fff' : 'var(--navy-deep)',
        border: primary ? '1px solid var(--navy)' : '1px solid var(--line-strong)',
      }}
    >
      {initialsOf(name, email)}
    </span>
  );
}

function ContactLink({
  href,
  icon,
  children,
  mono,
  external,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  mono?: boolean;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      className="inline-flex items-center gap-1.5 text-[12.5px] link-soft break-all"
    >
      <span aria-hidden className="shrink-0" style={{ color: 'var(--ink-4)' }}>
        {icon}
      </span>
      <span className={mono ? 'font-tabular' : undefined}>{children}</span>
    </a>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid place-items-center rounded-md w-[26px] h-[26px] transition-colors text-[color:var(--ink-4)] hover:text-[color:var(--navy-deep)] hover:bg-[color:var(--surface-2)] disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/* Stroke icons, 14px, matching the side-nav vocabulary. */

const stroke = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function MailIcon() {
  return (
    <svg {...stroke}>
      <rect x="2" y="3.5" width="12" height="9" rx="1.2" />
      <path d="m2.6 4.6 5.4 4 5.4-4" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg {...stroke}>
      <path d="M4.2 2.8h2l1 2.5-1.3.9a7.5 7.5 0 0 0 3.4 3.4l.9-1.3 2.5 1v2a1 1 0 0 1-1.1 1A10 10 0 0 1 3.2 3.9a1 1 0 0 1 1-1.1z" />
    </svg>
  );
}

function LinkExternalIcon() {
  return (
    <svg {...stroke}>
      <path d="M6 3.5H3.7v9h9V10" />
      <path d="M9.2 3.5h3.3v3.3" />
      <path d="M12.5 3.5 7.2 8.8" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg {...stroke}>
      <path d="M8 2.4l1.7 3.5 3.9.5-2.8 2.7.7 3.8L8 11.2 4.5 13l.7-3.8L2.4 6.4l3.9-.5z" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg {...stroke}>
      <path d="M10.8 3l2.2 2.2-7.1 7.1-2.6.4.4-2.6z" />
      <path d="M9.6 4.2l2.2 2.2" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg {...stroke} width={13} height={13}>
      <path d="M8 3.4v9.2M3.4 8h9.2" />
    </svg>
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
    if (email && !isEmail(email)) {
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
            className="w-full rounded border px-2.5 py-1.5 text-[13px]"
            style={{ borderColor: 'var(--line-strong)' }}
          />
        </FormField>
        <FormField label="Title">
          <input
            type="text"
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            placeholder="Purchasing manager"
            className="w-full rounded border px-2.5 py-1.5 text-[13px]"
            style={{ borderColor: 'var(--line-strong)' }}
          />
        </FormField>
        <FormField label="Email" error={emailError}>
          <input
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
            placeholder="jane@company.com"
            className="w-full rounded border px-2.5 py-1.5 text-[13px] font-tabular"
            style={{ borderColor: emailError ? 'var(--warn-ink)' : 'var(--line-strong)' }}
          />
        </FormField>
        <FormField label="Phone">
          <input
            type="tel"
            inputMode="tel"
            autoComplete="off"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
            placeholder="+44 20 …"
            className="w-full rounded border px-2.5 py-1.5 text-[13px] font-tabular"
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
              className="w-full rounded border px-2.5 py-1.5 text-[13px]"
              style={{ borderColor: 'var(--line-strong)' }}
            />
          </FormField>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-primary text-[12px]"
          style={{ padding: '6px 13px' }}
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? 'Saving…' : saveLabel}
        </button>
        <button
          type="button"
          className="btn-ghost text-[12px]"
          style={{ padding: '5px 12px' }}
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
      <span className="micro-label block mb-1">{label}</span>
      {children}
      {error && (
        <span className="block text-[11px] mt-1" style={{ color: 'var(--warn-ink)' }}>
          {error}
        </span>
      )}
    </label>
  );
}
