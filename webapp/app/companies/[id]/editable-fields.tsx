'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { TIER_STYLES, type Company } from '@/lib/db/types';

/**
 * Inline-editable company fields. All writes go through RLS
 * (companies UPDATE policy) via the browser Supabase client.
 *
 * Exports:
 *  - NotesPanel        — sidebar card, autosave-on-blur notes
 *  - EditableWebsite   — value for the Website cell in the field grid
 *  - EditableTier      — value for the Tier cell (manual override select)
 *  - EditableBasics    — body of the "Company description" section
 *                        (description + city)
 */

type BasicsCompany = Pick<
  Company,
  'id' | 'notes' | 'website' | 'city' | 'description' | 'icp_tier'
>;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function SaveNote({ state, error }: { state: SaveState; error: string | null }) {
  if (state === 'idle') return null;
  return (
    <span
      className="text-[11px] shrink-0"
      style={{ color: state === 'error' ? 'var(--warn-ink)' : 'var(--ink-4)' }}
    >
      {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : `Error: ${error ?? 'save failed'}`}
    </span>
  );
}

/** Update a single companies row; returns an error message or null. */
async function updateCompany(
  id: string,
  patch: Partial<Pick<Company, 'notes' | 'website' | 'city' | 'description' | 'icp_tier'>>
): Promise<string | null> {
  const supabase = getBrowserSupabase();
  const { error } = await supabase.from('companies').update(patch).eq('id', id);
  return error ? error.message : null;
}

/* ────────────────────────────────────────────────────────────────
   Notes — sidebar card, autosave on blur when changed.
   ──────────────────────────────────────────────────────────────── */

export function NotesPanel({ company }: { company: BasicsCompany }) {
  const [value, setValue] = useState(company.notes ?? '');
  const [savedValue, setSavedValue] = useState(company.notes ?? '');
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onBlur() {
    if (value === savedValue) return;
    setState('saving');
    setError(null);
    const err = await updateCompany(company.id, {
      notes: value.trim() === '' ? null : value,
    });
    if (err) {
      setState('error');
      setError(err);
      return;
    }
    setSavedValue(value);
    setState('saved');
  }

  return (
    <section className="card-soft p-5">
      <div className="section-head mb-4">
        <h2 className="section-title">Notes</h2>
        <SaveNote state={state} error={error} />
      </div>
      <textarea
        rows={5}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onBlur}
        placeholder="Anything worth remembering about this account…"
        className="w-full rounded border px-2.5 py-2 text-[13px] leading-relaxed resize-y"
        style={{ borderColor: 'var(--line-strong)' }}
      />
      <p className="text-[11px] mt-1.5 leading-snug" style={{ color: 'var(--ink-4)' }}>
        Saves automatically when you click away.
      </p>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────
   Inline text primitive — pencil on hover, Enter/blur saves,
   Esc cancels. Used for website, city and description.
   ──────────────────────────────────────────────────────────────── */

function InlineEditable({
  initial,
  label,
  commit,
  renderDisplay,
  multiline = false,
  placeholder,
}: {
  initial: string;
  label: string;
  commit: (next: string) => Promise<string | null>;
  renderDisplay: (saved: string) => React.ReactNode;
  multiline?: boolean;
  placeholder?: string;
}) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const skipBlur = useRef(false);

  function beginEdit() {
    setDraft(saved);
    setEditing(true);
  }

  function cancel() {
    skipBlur.current = true;
    setDraft(saved);
    setEditing(false);
  }

  async function save() {
    setEditing(false);
    const next = draft.trim();
    if (next === saved) {
      setDraft(saved);
      return;
    }
    setState('saving');
    setError(null);
    const err = await commit(next);
    if (err) {
      setState('error');
      setError(err);
      setDraft(saved);
      return;
    }
    setSaved(next);
    setDraft(next);
    setState('saved');
  }

  function onBlur() {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    void save();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      skipBlur.current = true;
      void save();
    }
  }

  if (editing) {
    return multiline ? (
      <div>
        <textarea
          autoFocus
          rows={5}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label={`Edit ${label}`}
          className="w-full rounded border px-2.5 py-2 text-[13px] leading-relaxed resize-y"
          style={{ borderColor: 'var(--line-strong)' }}
        />
        <p className="text-[11px] mt-1 leading-snug" style={{ color: 'var(--ink-4)' }}>
          Click away to save · Esc to cancel
        </p>
      </div>
    ) : (
      <input
        autoFocus
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={`Edit ${label}`}
        className="w-full rounded border px-2 py-1 text-[13px]"
        style={{ borderColor: 'var(--line-strong)' }}
      />
    );
  }

  const pencil = (
    <button
      type="button"
      onClick={beginEdit}
      aria-label={`Edit ${label}`}
      title={`Edit ${label}`}
      className={`${
        saved ? 'opacity-0 group-hover/edit:opacity-100' : 'opacity-50'
      } focus:opacity-100 transition-opacity text-[11px] leading-none shrink-0`}
      style={{ color: 'var(--ink-4)' }}
    >
      ✎
    </button>
  );

  if (multiline) {
    return (
      <div className="group/edit relative pr-6">
        {renderDisplay(saved)}
        <span className="absolute top-0.5 right-0 flex items-center gap-1.5">
          {pencil}
        </span>
        {state !== 'idle' && (
          <div className="mt-1">
            <SaveNote state={state} error={error} />
          </div>
        )}
      </div>
    );
  }

  return (
    <span className="group/edit inline-flex items-center gap-1.5 max-w-full min-w-0">
      <span className="min-w-0 truncate">{renderDisplay(saved)}</span>
      {pencil}
      <SaveNote state={state} error={error} />
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────
   Website — value for the Website cell in the field grid.
   ──────────────────────────────────────────────────────────────── */

export function EditableWebsite({ company }: { company: BasicsCompany }) {
  const router = useRouter();
  return (
    <InlineEditable
      initial={company.website ?? ''}
      label="website"
      placeholder="https://…"
      commit={async (next) => {
        const err = await updateCompany(company.id, { website: next || null });
        if (!err) router.refresh();
        return err;
      }}
      renderDisplay={(saved) =>
        saved ? (
          <a
            href={saved.startsWith('http') ? saved : `https://${saved}`}
            target="_blank"
            rel="noreferrer"
            className="link-soft text-[13px]"
          >
            {saved.replace(/^https?:\/\//, '')}
          </a>
        ) : (
          <span className="text-[13px]" style={{ color: 'var(--ink-4)' }}>—</span>
        )
      }
    />
  );
}

/* ────────────────────────────────────────────────────────────────
   Tier — manual override select for the Tier cell.
   ──────────────────────────────────────────────────────────────── */

const TIER_OPTIONS = ['Tier 1', 'Tier 2', 'Tier 3'] as const;

export function EditableTier({ company }: { company: BasicsCompany }) {
  const router = useRouter();
  const [tier, setTier] = useState<string | null>(company.icp_tier);
  const [editing, setEditing] = useState(false);
  const [overridden, setOverridden] = useState(false);
  const [state, setState] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);

  async function commit(raw: string) {
    setEditing(false);
    const next = raw === '' ? null : raw;
    if (next === tier) return;
    setState('saving');
    setError(null);
    const err = await updateCompany(company.id, { icp_tier: next });
    if (err) {
      setState('error');
      setError(err);
      return;
    }
    setTier(next);
    setOverridden(true);
    setState('saved');
    router.refresh();
  }

  if (editing) {
    return (
      <div>
        <select
          autoFocus
          value={tier ?? ''}
          onChange={(e) => void commit(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label="Override tier"
          className="w-full rounded border px-2 py-1 text-[13px]"
          style={{ borderColor: 'var(--line-strong)' }}
        >
          {TIER_OPTIONS.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
          <option value="">None</option>
        </select>
        <div className="text-[10.5px] uppercase tracking-wider mt-1" style={{ color: 'var(--warn-ink)' }}>
          manual override
        </div>
      </div>
    );
  }

  const style = tier ? TIER_STYLES[tier] : undefined;
  return (
    <span className="group/edit inline-flex items-center gap-1.5">
      {tier && style ? (
        <span className="pill text-[11px]" style={{ color: style.ink, background: style.bg }}>
          {tier}
        </span>
      ) : (
        <span className="text-[13px]" style={{ color: 'var(--ink-4)' }}>—</span>
      )}
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label="Override tier"
        title="Override tier"
        className={`${
          tier ? 'opacity-0 group-hover/edit:opacity-100' : 'opacity-50'
        } focus:opacity-100 transition-opacity text-[11px] leading-none shrink-0`}
        style={{ color: 'var(--ink-4)' }}
      >
        ✎
      </button>
      {overridden && state !== 'saving' && state !== 'error' && (
        <span className="text-[10.5px] uppercase tracking-wider" style={{ color: 'var(--warn-ink)' }}>
          manual override
        </span>
      )}
      <SaveNote state={state} error={error} />
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────
   Basics — description (multiline) + city, rendered as the body
   of the "Company description" section in the main column.
   ──────────────────────────────────────────────────────────────── */

export function EditableBasics({ company }: { company: BasicsCompany }) {
  const router = useRouter();
  return (
    <div className="space-y-3.5">
      <InlineEditable
        multiline
        initial={company.description ?? ''}
        label="description"
        placeholder="What does this company do?"
        commit={async (next) => {
          const err = await updateCompany(company.id, { description: next || null });
          if (!err) router.refresh();
          return err;
        }}
        renderDisplay={(saved) =>
          saved ? (
            <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
              {saved}
            </p>
          ) : (
            <p className="empty-note">
              No description yet.
            </p>
          )
        }
      />
      <div className="pt-3 border-t" style={{ borderColor: 'var(--line-soft)' }}>
        <div className="text-[10.5px] uppercase tracking-wider mb-1" style={{ color: 'var(--ink-4)' }}>
          City
        </div>
        <div className="text-[13px]" style={{ color: 'var(--ink)' }}>
          <InlineEditable
            initial={company.city ?? ''}
            label="city"
            placeholder="City"
            commit={async (next) => {
              const err = await updateCompany(company.id, { city: next || null });
              if (!err) router.refresh();
              return err;
            }}
            renderDisplay={(saved) =>
              saved ? (
                <span>{saved}</span>
              ) : (
                <span style={{ color: 'var(--ink-4)' }}>—</span>
              )
            }
          />
        </div>
      </div>
    </div>
  );
}
