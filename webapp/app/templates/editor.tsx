'use client';
import { useRef, useState } from 'react';
import { AVAILABLE_VARS } from '@/lib/templates/render';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import ConfirmModal from '../confirm-modal';

type Template = {
  id: string;
  name: string;
  subject_template: string;
  body_template: string;
  created_at?: string;
  updated_at?: string;
};

export default function TemplatesEditor({ initial }: { initial: Template[] }) {
  const [templates, setTemplates] = useState<Template[]>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial[0]?.id ?? null);
  const [draft, setDraft] = useState<Template | null>(initial[0] ?? null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Variable chips: draggable into subject/body (native text drop lands at the
  // drop point), or click to insert at the last caret position.
  const subjectRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const lastFieldRef = useRef<'subject' | 'body'>('body');
  const [dragHover, setDragHover] = useState<'subject' | 'body' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

  function insertVar(name: string) {
    if (!draft) return;
    const token = `{{${name}}}`;
    const field = lastFieldRef.current;
    const el = field === 'subject' ? subjectRef.current : bodyRef.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    setDraft(field === 'subject'
      ? { ...draft, subject_template: next }
      : { ...draft, body_template: next });
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  }

  const dropRing = (field: 'subject' | 'body') =>
    dragHover === field
      ? { borderColor: 'var(--navy)', boxShadow: '0 0 0 3px color-mix(in oklab, var(--navy) 14%, transparent)' }
      : {};

  function select(id: string) {
    setSelectedId(id);
    setDraft(templates.find(t => t.id === id) ?? null);
    setMessage(null);
  }

  function startNew() {
    setSelectedId(null);
    setDraft({
      id: '',
      name: 'New template',
      subject_template: '',
      body_template: '',
    });
    setMessage(null);
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    const supabase = getBrowserSupabase();
    const payload = {
      name: draft.name,
      subject_template: draft.subject_template,
      body_template: draft.body_template,
    };
    let result;
    if (draft.id) {
      result = await supabase.from('templates').update(payload).eq('id', draft.id).select().single();
    } else {
      result = await supabase.from('templates').insert(payload).select().single();
    }
    setSaving(false);
    if (result.error) {
      setMessage(`Error: ${result.error.message}`);
      return;
    }
    const saved = result.data as Template;
    setTemplates(prev => {
      const others = prev.filter(t => t.id !== saved.id);
      return [saved, ...others];
    });
    setSelectedId(saved.id);
    setDraft(saved);
    setMessage('Saved');
  }

  async function deleteTemplate(id: string) {
    setConfirmDelete(null);
    const supabase = getBrowserSupabase();
    const { error } = await supabase.from('templates').delete().eq('id', id);
    if (error) {
      setMessage(`Error: ${error.message}`);
      return;
    }
    setTemplates(prev => prev.filter(t => t.id !== id));
    if (selectedId === id) {
      setSelectedId(null);
      setDraft(null);
    }
    setMessage('Deleted');
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-5 items-start">
      <aside className="lg:col-span-1 space-y-2.5">
        <button onClick={startNew} className="btn-primary w-full text-[13px]">
          New template
        </button>
        <ul className="card-soft overflow-hidden">
          {templates.length === 0 && (
            <li className="px-3.5 py-3 empty-note">No templates yet.</li>
          )}
          {templates.map((t, i) => {
            const active = selectedId === t.id;
            return (
              <li
                key={t.id}
                className="flex items-stretch"
                style={i > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}
              >
                <button
                  onClick={() => select(t.id)}
                  className="row-hover relative flex-1 min-w-0 text-left pl-3.5 pr-2 py-2.5 text-[13px] truncate"
                  style={{
                    background: active ? 'var(--surface-2)' : undefined,
                    color: active ? 'var(--navy-deep)' : 'var(--ink)',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {active && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1.5 bottom-1.5 w-[2px] rounded-full"
                      style={{ background: 'var(--navy)' }}
                    />
                  )}
                  {t.name}
                </button>
                <button
                  onClick={() => setConfirmDelete({ id: t.id, name: t.name })}
                  title={`Delete ${t.name}`}
                  aria-label={`Delete template ${t.name}`}
                  className="btn-unlink px-3 shrink-0"
                  style={{ background: active ? 'var(--surface-2)' : 'transparent' }}
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="lg:col-span-3">
        {!draft ? (
          <div className="card-soft p-8 text-center">
            <p className="text-[13.5px]" style={{ color: 'var(--ink-2)' }}>
              Pick a template on the left, or create a new one.
            </p>
            <button onClick={startNew} className="btn-primary text-[13px] mt-4">
              New template
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 items-start">
            {/* Edit column */}
            <div className="space-y-4 text-[13px]">
              <div>
                <FieldLabel htmlFor="tpl-name">Name</FieldLabel>
                <input
                  id="tpl-name"
                  value={draft.name}
                  onChange={e => setDraft({ ...draft, name: e.target.value })}
                  className="w-full rounded px-3 py-2 text-[13.5px] border"
                  style={{ borderColor: 'var(--line-strong)' }}
                />
              </div>
              <div>
                <FieldLabel htmlFor="tpl-subject">Subject</FieldLabel>
                <input
                  id="tpl-subject"
                  ref={subjectRef}
                  value={draft.subject_template}
                  onChange={e => setDraft({ ...draft, subject_template: e.target.value })}
                  onFocus={() => { lastFieldRef.current = 'subject'; }}
                  onDragEnter={() => setDragHover('subject')}
                  onDragLeave={() => setDragHover(null)}
                  onDrop={() => { setDragHover(null); lastFieldRef.current = 'subject'; }}
                  placeholder="A quick idea for {{company_name}}"
                  className="w-full rounded px-3 py-2 text-[13.5px] border transition-shadow"
                  style={{ borderColor: 'var(--line-strong)', ...dropRing('subject') }}
                />
              </div>
              <div>
                <FieldLabel htmlFor="tpl-body">Body</FieldLabel>
                <textarea
                  id="tpl-body"
                  ref={bodyRef}
                  value={draft.body_template}
                  onChange={e => setDraft({ ...draft, body_template: e.target.value })}
                  onFocus={() => { lastFieldRef.current = 'body'; }}
                  onDragEnter={() => setDragHover('body')}
                  onDragLeave={() => setDragHover(null)}
                  onDrop={() => { setDragHover(null); lastFieldRef.current = 'body'; }}
                  rows={16}
                  placeholder="Hi {{contact_name}}, …"
                  className="w-full rounded px-3 py-2.5 text-[12.5px] border leading-relaxed transition-shadow"
                  style={{ borderColor: 'var(--line-strong)', ...dropRing('body') }}
                />
              </div>

              <div
                className="rounded px-3 py-2.5 text-[11.5px]"
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--line)',
                  color: 'var(--ink-2)',
                }}
              >
                <div className="micro-label mb-1">Variables</div>
                <p className="mb-2 text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
                  Drag a variable into the subject or body, or click to insert it at the cursor.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {AVAILABLE_VARS.map(v => (
                    <button
                      key={v}
                      type="button"
                      draggable
                      onDragStart={e => {
                        e.dataTransfer.setData('text/plain', `{{${v}}}`);
                        e.dataTransfer.effectAllowed = 'copy';
                      }}
                      onClick={() => insertVar(v)}
                      title={`Insert {{${v}}}`}
                      className="font-tabular rounded px-1.5 py-0.5 cursor-grab active:cursor-grabbing select-none transition-colors"
                      style={{
                        background: 'var(--surface)',
                        border: '1px solid var(--line)',
                        color: 'var(--ink-2)',
                      }}
                      onMouseEnter={e => {
                        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--navy)';
                        (e.currentTarget as HTMLButtonElement).style.color = 'var(--navy-deep)';
                      }}
                      onMouseLeave={e => {
                        (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--line)';
                        (e.currentTarget as HTMLButtonElement).style.color = 'var(--ink-2)';
                      }}
                    >
                      {`{{${v}}}`}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2.5 pt-1">
                <button onClick={save} disabled={saving} className="btn-primary">
                  {saving ? 'Saving…' : 'Save template'}
                </button>
                {draft.id && (
                  <button
                    onClick={() => setConfirmDelete({ id: draft.id, name: draft.name })}
                    className="btn-ghost"
                    style={{
                      color: 'var(--danger-ink)',
                      borderColor: 'color-mix(in oklab, var(--danger-ink) 28%, var(--line-strong))',
                    }}
                  >
                    Delete template
                  </button>
                )}
                {message && (
                  <div aria-live="polite" className="text-[12px] ml-1" style={{ color: 'var(--ink-3)' }}>
                    {message}
                  </div>
                )}
              </div>
            </div>

            {/* Preview column */}
            <div className="xl:sticky xl:top-20">
              <TemplatePreview
                name={draft.name}
                subject={draft.subject_template}
                body={draft.body_template}
              />
            </div>
          </div>
        )}
      </section>

      <ConfirmModal
        open={confirmDelete !== null}
        title="Delete template"
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => confirmDelete && void deleteTemplate(confirmDelete.id)}
        onCancel={() => setConfirmDelete(null)}
      >
        Delete template{' '}
        <span style={{ color: 'var(--ink)' }}>&ldquo;{confirmDelete?.name}&rdquo;</span>? This
        cannot be undone, and it&rsquo;s used for future discovery emails.
      </ConfirmModal>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   Live preview: the template rendered like a letter, with {{vars}}
   shown as filled placeholder chips so the user reads the shape of
   the email without sample data.
   ──────────────────────────────────────────────────────────────── */

function VarChip({ name }: { name: string }) {
  return (
    <span
      className="font-tabular rounded px-1 text-[0.86em]"
      style={{ background: 'var(--t1-bg)', color: 'var(--t1-ink)' }}
    >
      {name}
    </span>
  );
}

function withVars(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\{\{(\w+)\}\}/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<VarChip key={key++} name={m[1]} />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function TemplatePreview({
  name,
  subject,
  body,
}: {
  name: string;
  subject: string;
  body: string;
}) {
  return (
    <div className="card-soft overflow-hidden">
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: '1px solid var(--line)', background: 'var(--surface-2)' }}
      >
        <span className="micro-label">Preview</span>
        <span className="font-tabular text-[11px] truncate ml-3" style={{ color: 'var(--ink-4)' }}>
          {name || 'Untitled'}
        </span>
      </div>

      <div className="p-5">
        <div className="pb-3 mb-3" style={{ borderBottom: '1px solid var(--line-soft)' }}>
          <div className="micro-label mb-1">Subject</div>
          <div className="font-display text-[16px] leading-snug" style={{ color: 'var(--navy-deep)' }}>
            {subject.trim() ? (
              withVars(subject)
            ) : (
              <span className="italic text-[14px]" style={{ color: 'var(--ink-4)' }}>
                No subject yet
              </span>
            )}
          </div>
        </div>

        <div
          className="text-[13px] leading-relaxed whitespace-pre-wrap break-words"
          style={{ color: 'var(--ink-2)' }}
        >
          {body.trim() ? (
            withVars(body)
          ) : (
            <span className="italic" style={{ color: 'var(--ink-4)' }}>
              The email body will appear here as you type.
            </span>
          )}
        </div>
      </div>

      <div
        className="px-5 py-2.5 text-[11px]"
        style={{ borderTop: '1px solid var(--line-soft)', background: 'var(--surface-2)', color: 'var(--ink-4)' }}
      >
        Highlighted variables fill with each company&apos;s real data when an email is drafted.
      </div>
    </div>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="micro-label block mb-1.5">
      {children}
    </label>
  );
}
