'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import ConfirmModal from '../confirm-modal';
import {
  DRAFT_LANGUAGES,
  DRAFT_LIST_SELECT,
  DRAFT_STATUSES,
  DRAFT_STATUS_LABELS,
  DRAFT_STATUS_STYLES,
  titleCase,
  type DraftStatus,
  type EmailDraft,
} from '@/lib/db/types';

export type QueueDraft = EmailDraft & {
  contacts: { id: string; full_name: string | null; title: string | null; email: string | null } | null;
  companies: { id: string; company_name: string; country: string | null } | null;
  templates: { id: string; name: string } | null;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Deterministic "Jun 11" from the ISO string (UTC date — no SSR/client drift). */
function fmtDate(iso: string): string {
  const mi = parseInt(iso.slice(5, 7), 10) - 1;
  const day = parseInt(iso.slice(8, 10), 10);
  return `${MONTHS[mi] ?? ''} ${day}`;
}

/** Local "Jun 11, 14:05" — only used inside the expansion (client-only render). */
function fmtDateTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${MONTHS[d.getMonth()] ?? ''} ${d.getDate()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function langLabel(code: string): string {
  return DRAFT_LANGUAGES.find(l => l.code === code)?.label ?? code.toUpperCase();
}

export default function DraftsQueue({ initialDrafts }: { initialDrafts: QueueDraft[] }) {
  const [drafts, setDrafts] = useState<QueueDraft[]>(initialDrafts);

  // Filters
  const [statusFilter, setStatusFilter] = useState<DraftStatus | ''>('');
  const [countryFilter, setCountryFilter] = useState('');
  const [languageFilter, setLanguageFilter] = useState('');

  // Row expansion + edit buffer (kept separate from `drafts` so realtime
  // refetches never clobber in-progress edits).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editSubject, setEditSubject] = useState('');
  const [editBody, setEditBody] = useState('');
  const [instruction, setInstruction] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Action state
  const [busyId, setBusyId] = useState<string | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [topError, setTopError] = useState<string | null>(null);
  const [queueNotice, setQueueNotice] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; label: string } | null>(null);
  // Set only for an *interrupted* failed draft (the send may already have gone
  // out) — requeueing it risks a double-send, so it goes through a confirm.
  const [confirmRequeue, setConfirmRequeue] = useState<string | null>(null);

  // Approver identity — fetched once, used to stamp approved_by on writes.
  const userIdRef = useRef<string | null>(null);
  useEffect(() => {
    void getBrowserSupabase()
      .auth.getUser()
      .then(({ data }) => {
        userIdRef.current = data.user?.id ?? null;
      });
  }, []);

  const refetch = useCallback(async (): Promise<QueueDraft[]> => {
    const supabase = getBrowserSupabase();
    const { data } = await supabase
      .from('email_drafts')
      .select(DRAFT_LIST_SELECT)
      .order('created_at', { ascending: false });
    const rows = (data ?? []) as unknown as QueueDraft[];
    if (data) setDrafts(rows);
    return rows;
  }, []);

  // Realtime: watch the queue drain live (approved → sending → sent) while the
  // cron tick works through it. Apply changes INCREMENTALLY instead of refetching
  // the whole table on every row change: during a drain each send fires several
  // UPDATEs, and a full refetch per event per open tab is O(clients × rows). An
  // UPDATE merges the changed columns into the existing row (its joins are kept,
  // since the payload only carries email_drafts columns); a DELETE drops the row;
  // an INSERT (a draft created elsewhere, missing its joins) falls back to a refetch.
  useEffect(() => {
    const supabase = getBrowserSupabase();
    const channel = supabase
      .channel('drafts-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'email_drafts' },
        (payload) => {
          if (payload.eventType === 'UPDATE') {
            const row = payload.new as Partial<EmailDraft> & { id: string };
            setDrafts((prev) =>
              prev.map((d) => (d.id === row.id ? { ...d, ...row } : d))
            );
          } else if (payload.eventType === 'DELETE') {
            const oldId = (payload.old as { id?: string }).id;
            if (oldId) setDrafts((prev) => prev.filter((d) => d.id !== oldId));
          } else {
            void refetch(); // INSERT — need the joins the payload lacks
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [refetch]);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  // ── Derived data ────────────────────────────────────────────────
  const countries = useMemo(
    () =>
      Array.from(
        new Set(drafts.map(d => d.companies?.country).filter((c): c is string => !!c))
      ).sort(),
    [drafts]
  );
  const languages = useMemo(
    () => Array.from(new Set(drafts.map(d => d.language))).sort(),
    [drafts]
  );

  // Country+language slice — status pill counts stay live against the other filters.
  const countryLangFiltered = useMemo(
    () =>
      drafts.filter(
        d =>
          (!countryFilter || (d.companies?.country ?? '') === countryFilter) &&
          (!languageFilter || d.language === languageFilter)
      ),
    [drafts, countryFilter, languageFilter]
  );

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const s of DRAFT_STATUSES) counts[s] = 0;
    for (const d of countryLangFiltered) counts[d.status] = (counts[d.status] ?? 0) + 1;
    return counts;
  }, [countryLangFiltered]);

  const visible = useMemo(
    () => countryLangFiltered.filter(d => !statusFilter || d.status === statusFilter),
    [countryLangFiltered, statusFilter]
  );

  // Grouped: country → company → drafts (drafts keep created_at desc order).
  const grouped = useMemo(() => {
    const byCountry = new Map<string, QueueDraft[]>();
    for (const d of visible) {
      const key = d.companies?.country ?? '';
      const arr = byCountry.get(key);
      if (arr) arr.push(d);
      else byCountry.set(key, [d]);
    }
    return Array.from(byCountry.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([country, list]) => {
        const byCompany = new Map<string, QueueDraft[]>();
        for (const d of list) {
          const key = d.companies?.company_name ?? '';
          const arr = byCompany.get(key);
          if (arr) arr.push(d);
          else byCompany.set(key, [d]);
        }
        const companies = Array.from(byCompany.entries()).sort((a, b) =>
          a[0].localeCompare(b[0])
        );
        return [country, companies] as const;
      });
  }, [visible]);

  const approvedCount = useMemo(
    () => drafts.filter(d => d.status === 'approved').length,
    [drafts]
  );
  const draftsShownCount = useMemo(
    () => visible.filter(d => d.status === 'draft').length,
    [visible]
  );
  const gmailDisconnected = useMemo(
    () => drafts.some(d => d.status === 'failed' && (d.error ?? '').includes('invalid_grant')),
    [drafts]
  );
  // The queue drains at ~one email per minute (pg_cron, one send per tick).
  const estMinutes = Math.max(1, Math.ceil(approvedCount));

  // ── Actions ─────────────────────────────────────────────────────
  function flashSaved() {
    setSavedFlash(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedFlash(false), 1800);
  }

  async function toggleExpand(d: QueueDraft) {
    if (expandedId === d.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(d.id);
    setEditSubject(d.subject);
    setInstruction('');
    setSavedFlash(false);
    setRowError(null);

    // `body` is omitted from the list query (it's the heaviest column); fetch it
    // on first open and cache it onto the row so re-expanding doesn't refetch.
    let body = d.body;
    if (body == null) {
      const { data } = await getBrowserSupabase()
        .from('email_drafts')
        .select('body')
        .eq('id', d.id)
        .maybeSingle();
      body = (data?.body as string | undefined) ?? '';
      setDrafts((prev) => prev.map((x) => (x.id === d.id ? { ...x, body } : x)));
    }
    setEditBody(body);
  }

  async function saveEdits(id: string) {
    const current = drafts.find(x => x.id === id);
    if (!current) return;
    if (current.subject === editSubject && current.body === editBody) return;
    const supabase = getBrowserSupabase();
    const { error } = await supabase
      .from('email_drafts')
      .update({ subject: editSubject, body: editBody })
      .eq('id', id);
    if (error) {
      setRowError(`Save failed: ${error.message}`);
      return;
    }
    setDrafts(prev =>
      prev.map(x => (x.id === id ? { ...x, subject: editSubject, body: editBody } : x))
    );
    flashSaved();
  }

  async function updateStatus(id: string, expectedFrom: DraftStatus, patch: Partial<EmailDraft>) {
    setBusyId(id);
    setRowError(null);
    const supabase = getBrowserSupabase();
    // Compare-and-swap: only write if the row is still in the expected status,
    // so a stale UI can never revert e.g. a 'sent' draft back to 'draft'.
    const { data, error } = await supabase
      .from('email_drafts')
      .update(patch)
      .eq('id', id)
      .eq('status', expectedFrom)
      .select('id');
    setBusyId(null);
    if (error) {
      setRowError(error.message);
      return;
    }
    if (!data || data.length === 0) {
      setRowError('This draft changed state elsewhere. List refreshed.');
      await refetch();
      return;
    }
    await refetch();
  }

  async function removeDraft(id: string) {
    setBusyId(id);
    setRowError(null);
    const supabase = getBrowserSupabase();
    const { error } = await supabase.from('email_drafts').delete().eq('id', id);
    setBusyId(null);
    setConfirmDelete(null);
    if (error) {
      setRowError(`Delete failed: ${error.message}`);
      return;
    }
    setExpandedId(null);
    setDrafts(prev => prev.filter(x => x.id !== id));
  }

  // Requeue a failed draft for sending. Factored out so both the direct path
  // (genuine failures) and the confirmed path (interrupted, possible-double-send)
  // share the same compare-and-swap.
  async function requeueDraft(id: string) {
    setConfirmRequeue(null);
    await updateStatus(id, 'failed', {
      status: 'approved',
      scheduled_at: new Date().toISOString(),
      error: null,
      send_attempts: 0,
    });
  }

  async function approveAllShown() {
    const ids = visible.filter(d => d.status === 'draft').map(d => d.id);
    if (ids.length === 0) return;
    setTopError(null);
    const supabase = getBrowserSupabase();
    // Single bulk write, guarded so only rows still in 'draft' flip; the
    // refetch below reconciles whatever actually changed.
    const { error } = await supabase
      .from('email_drafts')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: userIdRef.current,
        scheduled_at: null,
        send_attempts: 0,
      })
      .in('id', ids)
      .eq('status', 'draft')
      .select('id');
    if (error) {
      setTopError(`Approve failed: ${error.message}`);
      return;
    }
    await refetch();
  }

  async function regenerate(id: string) {
    setRegenBusy(true);
    setRowError(null);
    try {
      const res = await fetch('/api/drafts/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          draft_id: id,
          ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setRowError(data.error || 'Regenerate failed');
        return;
      }
      const rows = await refetch();
      const fresh = rows.find(x => x.id === id);
      if (fresh) {
        setEditSubject(fresh.subject);
        setEditBody(fresh.body);
      }
      setInstruction('');
    } catch (e) {
      setRowError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setRegenBusy(false);
    }
  }

  async function startQueue() {
    setStarting(true);
    setTopError(null);
    setQueueNotice(null);
    try {
      const res = await fetch('/api/send-queue/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setTopError(data.error || 'Failed to start the send queue');
      } else {
        const mins =
          typeof data.estimated_seconds === 'number'
            ? Math.max(1, Math.ceil(data.estimated_seconds / 60))
            : Math.max(1, Math.ceil(data.queued));
        setQueueNotice(
          `Queued ${data.queued} emails. They will send automatically at about one per minute (~${mins} min).`
        );
        await refetch();
      }
    } catch (e) {
      setTopError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setStarting(false);
      setConfirmOpen(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────
  if (drafts.length === 0) {
    return (
      <p className="empty-note">
        No drafts yet. Generate drafts from the{' '}
        <Link href="/companies" className="link-soft">Companies</Link> page, then review them here.
      </p>
    );
  }

  return (
    <div>
      {gmailDisconnected && (
        <div
          className="rounded px-3.5 py-2.5 mb-4 text-[12.5px]"
          style={{ background: 'var(--warn-bg)', color: 'var(--warn-ink)' }}
        >
          Gmail disconnected: reconnect at{' '}
          <Link href="/integrations" className="link-soft">Integrations</Link>, then requeue the
          failed drafts.
        </div>
      )}

      {queueNotice && (
        <div
          className="rise-in rounded px-3.5 py-2.5 mb-4 text-[12.5px]"
          style={{ background: 'var(--ok-bg)', color: 'var(--ok-ink)' }}
        >
          {queueNotice}
        </div>
      )}

      {topError && (
        <div
          className="rise-in rounded px-3.5 py-2.5 mb-4 text-[12.5px]"
          style={{ background: 'var(--warn-bg)', color: 'var(--warn-ink)' }}
        >
          {topError}
        </div>
      )}

      {/* Header bar: status pills + filters + CTAs */}
      <div className="flex flex-wrap items-center gap-2.5 mb-5">
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterPill
            label="All"
            count={countryLangFiltered.length}
            selected={statusFilter === ''}
            ink="var(--navy-deep)"
            bg="var(--surface-2)"
            onClick={() => setStatusFilter('')}
          />
          {DRAFT_STATUSES.map(s => (
            <FilterPill
              key={s}
              label={DRAFT_STATUS_LABELS[s]}
              count={statusCounts[s] ?? 0}
              selected={statusFilter === s}
              ink={DRAFT_STATUS_STYLES[s].ink}
              bg={DRAFT_STATUS_STYLES[s].bg}
              onClick={() => setStatusFilter(s)}
            />
          ))}
        </div>

        <select
          value={countryFilter}
          onChange={e => setCountryFilter(e.target.value)}
          className="rounded px-2.5 py-1.5 text-[12.5px] border"
          style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)' }}
        >
          <option value="">All countries</option>
          {countries.map(c => (
            <option key={c} value={c}>{titleCase(c)}</option>
          ))}
        </select>

        <select
          value={languageFilter}
          onChange={e => setLanguageFilter(e.target.value)}
          className="rounded px-2.5 py-1.5 text-[12.5px] border"
          style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)' }}
        >
          <option value="">All languages</option>
          {languages.map(l => (
            <option key={l} value={l}>{langLabel(l)}</option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-2">
          {draftsShownCount > 0 && (
            <button
              type="button"
              onClick={() => void approveAllShown()}
              className="btn-ghost text-[13px]"
            >
              Approve all shown ({draftsShownCount})
            </button>
          )}
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={approvedCount === 0 || starting}
            className="btn-primary text-[13px]"
          >
            Send approved ({approvedCount})
          </button>
        </div>
      </div>

      {/* Grouped list: country → company → draft rows */}
      {visible.length === 0 ? (
        <p className="empty-note">
          No drafts match the current filters.
        </p>
      ) : (
        grouped.map(([country, companies]) => (
          <section key={country || 'no-country'} className="mb-6">
            <div className="micro-label mb-2">
              {country ? titleCase(country) : 'No country'}
            </div>
            <div className="card-soft overflow-hidden">
              {companies.map(([companyName, companyDrafts], ci) => (
                <div
                  key={companyName || `unknown-${ci}`}
                  style={{ borderTop: ci > 0 ? '1px solid var(--line)' : 'none' }}
                >
                  <div className="px-4 pt-3 pb-1.5 flex items-baseline gap-2">
                    <span className="text-[13px] font-medium" style={{ color: 'var(--navy-deep)' }}>
                      {companyName || 'Unknown company'}
                    </span>
                    <span className="font-tabular text-[11px]" style={{ color: 'var(--ink-4)' }}>
                      {companyDrafts.length}
                    </span>
                  </div>
                  {companyDrafts.map((d, di) => {
                    const pill = DRAFT_STATUS_STYLES[d.status];
                    const expanded = expandedId === d.id;
                    const readOnly = d.status === 'sending' || d.status === 'sent';
                    return (
                      <div
                        key={d.id}
                        style={{ borderTop: di > 0 ? '1px solid var(--line-soft)' : 'none' }}
                      >
                        <button
                          type="button"
                          onClick={() => void toggleExpand(d)}
                          aria-expanded={expanded}
                          className={`w-full text-left px-4 py-2.5 cursor-pointer ${expanded ? '' : 'row-hover'}`}
                          style={expanded ? { background: 'var(--surface-2)' } : undefined}
                        >
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span
                              aria-hidden
                              className="w-1.5 h-1.5 rounded-full shrink-0"
                              style={{ background: pill.ink }}
                            />
                            <span className="text-[13px]" style={{ color: 'var(--ink)' }}>
                              {d.contacts?.full_name || 'Unknown contact'}
                              {d.contacts?.title && (
                                <span style={{ color: 'var(--ink-3)' }}> · {d.contacts.title}</span>
                              )}
                            </span>
                            <span
                              className="font-tabular text-[12px]"
                              style={{ color: 'var(--ink-2)' }}
                            >
                              {d.contacts?.email ?? '·'}
                            </span>
                            <span className="ml-auto flex flex-wrap items-center gap-2.5">
                              <span className="text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
                                {d.templates?.name ?? 'No template'}
                              </span>
                              <span
                                className="font-tabular text-[11px]"
                                style={{ color: 'var(--ink-4)' }}
                              >
                                {d.language.toUpperCase()}
                              </span>
                              <span
                                className="pill"
                                style={{ color: pill.ink, background: pill.bg }}
                              >
                                {DRAFT_STATUS_LABELS[d.status]}
                              </span>
                              <span
                                className="font-tabular text-[11.5px]"
                                style={{ color: 'var(--ink-4)' }}
                              >
                                {fmtDate(d.created_at)}
                              </span>
                              <Chevron expanded={expanded} />
                            </span>
                          </div>
                          {d.status === 'failed' && d.error && (
                            <div className="mt-1 ml-[18px] text-[12px]" style={{ color: 'var(--warn-ink)' }}>
                              {d.error}
                            </div>
                          )}
                        </button>

                        {expanded && (
                          <div
                            className="px-4 pb-4 pt-3 space-y-3 text-[13px]"
                            style={{
                              background: 'var(--surface-2)',
                              borderTop: '1px solid var(--line-soft)',
                            }}
                          >
                            <div>
                              <FieldLabel>Subject</FieldLabel>
                              {readOnly ? (
                                <div
                                  className="px-2.5 py-1.5 text-[13px] rounded"
                                  style={{
                                    background: 'var(--surface)',
                                    border: '1px solid var(--line)',
                                    color: 'var(--ink-2)',
                                  }}
                                >
                                  {d.subject}
                                </div>
                              ) : (
                                <input
                                  value={editSubject}
                                  onChange={e => setEditSubject(e.target.value)}
                                  onBlur={() => void saveEdits(d.id)}
                                  className="w-full rounded px-2.5 py-1.5 text-[13px] border"
                                  style={{ borderColor: 'var(--line-strong)' }}
                                />
                              )}
                            </div>

                            <div>
                              <FieldLabel>Body</FieldLabel>
                              {readOnly ? (
                                <div
                                  className="whitespace-pre-wrap px-3 py-2 text-[12.5px] rounded leading-relaxed"
                                  style={{
                                    background: 'var(--surface)',
                                    border: '1px solid var(--line)',
                                    color: 'var(--ink-2)',
                                  }}
                                >
                                  {d.body}
                                </div>
                              ) : (
                                <textarea
                                  value={editBody}
                                  onChange={e => setEditBody(e.target.value)}
                                  onBlur={() => void saveEdits(d.id)}
                                  rows={12}
                                  className="w-full rounded px-3 py-2 text-[12.5px] border leading-relaxed"
                                  style={{ borderColor: 'var(--line-strong)' }}
                                />
                              )}
                            </div>

                            {d.status === 'draft' && (
                              <div className="flex flex-wrap items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void updateStatus(d.id, 'draft', {
                                      status: 'approved',
                                      approved_at: new Date().toISOString(),
                                      approved_by: userIdRef.current,
                                      scheduled_at: null,
                                      send_attempts: 0,
                                    })
                                  }
                                  disabled={busyId === d.id}
                                  className="btn-primary text-[13px]"
                                >
                                  Approve
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void updateStatus(d.id, 'draft', { status: 'rejected' })}
                                  disabled={busyId === d.id}
                                  className="btn-ghost text-[13px]"
                                >
                                  Reject
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void regenerate(d.id)}
                                  disabled={regenBusy || busyId === d.id}
                                  className="btn-ghost text-[13px]"
                                >
                                  {regenBusy ? 'Regenerating…' : 'Regenerate'}
                                </button>
                                <input
                                  value={instruction}
                                  onChange={e => setInstruction(e.target.value)}
                                  placeholder="Optional: e.g. shorter, less formal"
                                  className="flex-1 min-w-[220px] rounded px-2.5 py-1.5 text-[12.5px] border"
                                  style={{ borderColor: 'var(--line-strong)' }}
                                />
                              </div>
                            )}

                            {d.status === 'approved' && (
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  onClick={() =>
                                    void updateStatus(d.id, 'approved', {
                                      status: 'draft',
                                      scheduled_at: null,
                                      approved_at: null,
                                      approved_by: null,
                                    })
                                  }
                                  disabled={busyId === d.id}
                                  className="btn-ghost text-[13px]"
                                >
                                  Un-approve
                                </button>
                                {d.scheduled_at && (
                                  <span className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
                                    Scheduled {fmtDateTime(d.scheduled_at)}
                                  </span>
                                )}
                              </div>
                            )}

                            {d.status === 'failed' && (() => {
                              const interrupted = (d.error ?? '').toLowerCase().includes('interrupted');
                              return (
                                <div className="space-y-2">
                                  {interrupted && (
                                    <div className="text-[12px]" style={{ color: 'var(--warn-ink)' }}>
                                      Check the Gmail Sent folder first. This send may already have
                                      gone out.
                                    </div>
                                  )}
                                  <button
                                    type="button"
                                    // Interrupted sends route through a confirm (possible double-send);
                                    // genuine failures requeue directly.
                                    onClick={() =>
                                      interrupted ? setConfirmRequeue(d.id) : void requeueDraft(d.id)
                                    }
                                    disabled={busyId === d.id}
                                    className="btn-primary text-[13px]"
                                  >
                                    Requeue
                                  </button>
                                </div>
                              );
                            })()}

                            {d.status === 'rejected' && (
                              <button
                                type="button"
                                onClick={() => void updateStatus(d.id, 'rejected', { status: 'draft' })}
                                disabled={busyId === d.id}
                                className="btn-ghost text-[13px]"
                              >
                                Restore to draft
                              </button>
                            )}

                            {d.status === 'sending' && (
                              <div className="empty-note">
                                Sending…
                              </div>
                            )}

                            {d.status === 'sent' && (
                              <div className="text-[12px]" style={{ color: 'var(--ok-ink)' }}>
                                Sent {fmtDateTime(d.sent_at)}
                              </div>
                            )}

                            {d.status !== 'sending' && (
                              <div className="pt-2 border-t" style={{ borderColor: 'var(--line)' }}>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setConfirmDelete({
                                      id: d.id,
                                      label: d.contacts?.full_name || d.contacts?.email || 'this contact',
                                    })
                                  }
                                  disabled={busyId === d.id}
                                  className="btn-unlink"
                                >
                                  Delete draft
                                </button>
                              </div>
                            )}

                            {savedFlash && (
                              <div className="text-[12px]" style={{ color: 'var(--ok-ink)' }}>
                                Saved
                              </div>
                            )}
                            {rowError && (
                              <div className="text-[12px]" style={{ color: 'var(--warn-ink)' }}>
                                {rowError}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </section>
        ))
      )}

      {/* Send-queue confirm */}
      <ConfirmModal
        open={confirmOpen}
        title="Send queue"
        confirmLabel={starting ? 'Queueing…' : 'Start sending'}
        onConfirm={() => void startQueue()}
        onCancel={() => setConfirmOpen(false)}
        busy={starting}
      >
        Send {approvedCount} emails from the connected Gmail, going out at about one per
        minute (about {estMinutes} minutes)?
      </ConfirmModal>

      {/* Delete-draft confirm (replaces native confirm()) */}
      <ConfirmModal
        open={confirmDelete !== null}
        title="Delete draft"
        confirmLabel="Delete"
        tone="danger"
        onConfirm={() => confirmDelete && void removeDraft(confirmDelete.id)}
        onCancel={() => setConfirmDelete(null)}
        busy={busyId !== null && confirmDelete?.id === busyId}
      >
        Delete this draft to{' '}
        <span style={{ color: 'var(--ink)' }}>{confirmDelete?.label}</span>? This cannot be undone.
      </ConfirmModal>

      {/* Interrupted-send requeue gate (possible double-send) */}
      <ConfirmModal
        open={confirmRequeue !== null}
        title="Requeue this send?"
        confirmLabel="Requeue anyway"
        tone="danger"
        onConfirm={() => confirmRequeue && void requeueDraft(confirmRequeue)}
        onCancel={() => setConfirmRequeue(null)}
      >
        This send was interrupted and <strong>may already have gone out</strong>. Only requeue if
        you&rsquo;ve checked the Gmail Sent folder and it is <strong>not</strong> there — otherwise
        the prospect gets a duplicate.
      </ConfirmModal>
    </div>
  );
}

function FilterPill({
  label,
  count,
  selected,
  ink,
  bg,
  onClick,
}: {
  label: string;
  count: number;
  selected: boolean;
  ink: string;
  bg: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pill cursor-pointer"
      style={{
        color: ink,
        background: bg,
        ...(selected ? { outline: '1px solid var(--navy)', outlineOffset: '1px' } : {}),
      }}
    >
      {label}
      <span className="font-tabular ml-1.5">{count}</span>
    </button>
  );
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0 transition-transform"
      style={{ color: 'var(--ink-4)', transform: expanded ? 'rotate(180deg)' : 'none' }}
    >
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="micro-label block mb-1">
      {children}
    </label>
  );
}
