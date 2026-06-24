'use client';
import { useRef, useState } from 'react';
import { AVAILABLE_VARS } from '@/lib/templates/render';
import { getBrowserSupabase } from '@/lib/supabase/browser';

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

  async function deleteTemplate(id: string, name: string) {
    if (!confirm(`Delete template "${name}"? This cannot be undone.`)) return;
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
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
      <aside className="lg:col-span-1 space-y-2.5">
        <button onClick={startNew} className="btn-primary w-full text-[13px]">
          + New template
        </button>
        <ul className="card-soft divide-y" style={{ borderColor: 'var(--line)' }}>
          {templates.map(t => (
            <li key={t.id} className="flex items-stretch">
              <button
                onClick={() => select(t.id)}
                className="flex-1 min-w-0 text-left px-3.5 py-2.5 text-[13px] truncate transition-colors"
                style={{
                  background: selectedId === t.id ? 'var(--surface-2)' : 'transparent',
                  color: 'var(--ink)',
                  fontWeight: selectedId === t.id ? 500 : 400,
                }}
              >
                {t.name}
              </button>
              <button
                onClick={() => void deleteTemplate(t.id, t.name)}
                title={`Delete ${t.name}`}
                aria-label={`Delete template ${t.name}`}
                className="btn-unlink px-3 shrink-0"
                style={{ background: selectedId === t.id ? 'var(--surface-2)' : 'transparent' }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="lg:col-span-3">
        {!draft ? (
          <p className="text-[13px] italic" style={{ color: 'var(--ink-4)' }}>
            Pick a template on the left, or create a new one.
          </p>
        ) : (
          <div className="space-y-4 text-[13px]">
            <div>
              <FieldLabel>Name</FieldLabel>
              <input
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
                className="w-full rounded px-3 py-2 text-[13.5px] border"
                style={{ borderColor: 'var(--line-strong)' }}
              />
            </div>
            <div>
              <FieldLabel>Subject (supports {`{{vars}}`})</FieldLabel>
              <input
                ref={subjectRef}
                value={draft.subject_template}
                onChange={e => setDraft({ ...draft, subject_template: e.target.value })}
                onFocus={() => { lastFieldRef.current = 'subject'; }}
                onDragEnter={() => setDragHover('subject')}
                onDragLeave={() => setDragHover(null)}
                onDrop={() => { setDragHover(null); lastFieldRef.current = 'subject'; }}
                className="w-full rounded px-3 py-2 text-[13.5px] border transition-shadow"
                style={{ borderColor: 'var(--line-strong)', ...dropRing('subject') }}
              />
            </div>
            <div>
              <FieldLabel>Body</FieldLabel>
              <textarea
                ref={bodyRef}
                value={draft.body_template}
                onChange={e => setDraft({ ...draft, body_template: e.target.value })}
                onFocus={() => { lastFieldRef.current = 'body'; }}
                onDragEnter={() => setDragHover('body')}
                onDragLeave={() => setDragHover(null)}
                onDrop={() => { setDragHover(null); lastFieldRef.current = 'body'; }}
                rows={18}
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
              <div
                className="font-medium mb-1 text-[10.5px] uppercase tracking-wider"
                style={{ color: 'var(--ink-4)' }}
              >
                Available variables
              </div>
              <p className="mb-2 text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
                Drag a variable into the subject or body, or click it to insert at the cursor.
                It is replaced with the company&apos;s real data when an email is drafted.
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

            <div className="flex items-center gap-2.5 pt-2">
              <button onClick={save} disabled={saving} className="btn-primary">
                {saving ? 'Saving…' : 'Save'}
              </button>
              {draft.id && (
                <button
                  onClick={() => void deleteTemplate(draft.id, draft.name)}
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
                <div className="text-[12px] ml-1" style={{ color: 'var(--ink-3)' }}>
                  {message}
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label
      className="block text-[10.5px] uppercase tracking-wider mb-1.5"
      style={{ color: 'var(--ink-4)' }}
    >
      {children}
    </label>
  );
}
