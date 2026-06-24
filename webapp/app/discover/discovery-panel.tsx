'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import {
  RUN_STATUS_LABELS,
  RUN_STATUS_STYLES,
  titleCase,
  type PipelineRun,
} from '@/lib/db/types';
import { COUNTRY_NAMES, isSupportedCountry } from '@/lib/countries';
import type { AppRole } from '@/lib/auth/allowlist';

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Deterministic "Jun 11, 14:05" from the ISO string, sliced as UTC so there
 *  is no SSR/client locale drift. */
function fmtDateTimeUTC(iso: string): string {
  const mi = parseInt(iso.slice(5, 7), 10) - 1;
  const day = parseInt(iso.slice(8, 10), 10);
  const hh = iso.slice(11, 13);
  const mm = iso.slice(14, 16);
  return `${MONTHS[mi] ?? ''} ${day}, ${hh}:${mm}`;
}

/** Pinned estimate formula (kept in sync with the orchestrator brief). */
function estimateCredits(target: number): number {
  return Math.round(target * 1.4) + 5;
}
function estimateDollars(target: number): string {
  return (target * 0.04).toFixed(2);
}

/** Map a raw worker error to plain language for the client. */
function friendlyRunError(raw: string | null): string {
  const e = (raw || '').toLowerCase();
  if (e.includes('not recognized') || e.includes('not supported'))
    return "That country isn't supported yet. Try another market.";
  if (e.includes('422') || e.includes('explorium'))
    return "We couldn't pull companies for that market this time. Try again, or pick another country.";
  if (e.includes('pre-ship audit') || e.includes('refusing to ship'))
    return "This run didn't meet our quality bar, so nothing was delivered. Try again, or pick another market.";
  return 'Something went wrong with this run. Try again.';
}

const TARGET_MIN = 5;
const TARGET_MAX = 60;
const TARGET_STEP = 5;
const TARGET_DEFAULT = 25;

type Notice = { kind: 'ok' | 'warn'; message: string };

export default function DiscoveryPanel({
  initialRuns,
  role,
}: {
  initialRuns: PipelineRun[];
  role: AppRole;
}) {
  const isAdmin = role === 'admin';
  const [runs, setRuns] = useState<PipelineRun[]>(initialRuns);

  // Form state
  const [country, setCountry] = useState('');
  const [target, setTarget] = useState(TARGET_DEFAULT);

  // Flow state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const refetch = useCallback(async () => {
    const supabase = getBrowserSupabase();
    const { data } = await supabase
      .from('pipeline_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(40);
    if (data) setRuns(data as PipelineRun[]);
  }, []);

  // Realtime: watch runs drain queued → running → succeeded live.
  useEffect(() => {
    const supabase = getBrowserSupabase();
    const channel = supabase
      .channel('pipeline-runs')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'pipeline_runs' },
        () => { void refetch(); }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [refetch]);

  const credits = useMemo(() => estimateCredits(target), [target]);
  const dollars = useMemo(() => estimateDollars(target), [target]);

  const countryTrimmed = country.trim();
  const countryValid = isSupportedCountry(countryTrimmed);
  const canRun = countryTrimmed.length > 0 && countryValid;

  function openConfirm() {
    if (!canRun) return;
    setNotice(null);
    setConfirmOpen(true);
  }

  async function startRun() {
    setStarting(true);
    setNotice(null);
    try {
      const res = await fetch('/api/discovery/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country: countryTrimmed, target_leads: target }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        run_id?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        let message = 'Could not start the run, try again.';
        if (data.error === 'github_not_configured') {
          message =
            "The discovery worker isn't connected yet. Ask your admin to finish setup.";
        } else if (data.error === 'unsupported_country') {
          message = "That country isn't supported yet. Pick one from the list.";
        } else if (data.error === 'trigger_failed') {
          message = 'Could not start the worker, try again.';
        } else if (data.error) {
          message = data.error;
        }
        setNotice({ kind: 'warn', message });
        return;
      }
      setNotice({
        kind: 'ok',
        message: 'Run started. It will appear below and update as it goes.',
      });
      setCountry('');
      setTarget(TARGET_DEFAULT);
      await refetch();
    } catch (e) {
      setNotice({
        kind: 'warn',
        message: e instanceof Error ? e.message : 'Network error',
      });
    } finally {
      setStarting(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* ── Run form ──────────────────────────────────────────────── */}
      <div className="card-soft p-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            openConfirm();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div>
              <FieldLabel htmlFor="discover-country">Country</FieldLabel>
              <input
                id="discover-country"
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="e.g. Portugal"
                autoComplete="off"
                list="discover-country-options"
                className="w-full rounded px-2.5 py-1.5 text-[13px] border"
                style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)' }}
              />
              <datalist id="discover-country-options">
                {COUNTRY_NAMES.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div>
              <FieldLabel htmlFor="discover-target">Aim for</FieldLabel>
              <input
                id="discover-target"
                type="number"
                value={target}
                min={TARGET_MIN}
                max={TARGET_MAX}
                step={TARGET_STEP}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (Number.isNaN(n)) {
                    setTarget(TARGET_MIN);
                    return;
                  }
                  setTarget(Math.min(TARGET_MAX, Math.max(TARGET_MIN, n)));
                }}
                className="w-full sm:w-28 rounded px-2.5 py-1.5 text-[13px] border font-tabular"
                style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)' }}
              />
            </div>
            <button
              type="submit"
              disabled={!canRun}
              className="btn-primary text-[13px] whitespace-nowrap"
            >
              Run discovery
            </button>
          </div>
        </form>

        {countryTrimmed.length > 0 && !countryValid && (
          <p className="mt-2 text-[11.5px]" style={{ color: 'var(--warn-ink)' }}>
            That country isn&rsquo;t supported yet — pick one from the list.
          </p>
        )}

        {/* Cost detail is the operator's mental model — admins only. */}
        {isAdmin && (
          <p className="mt-3 text-[12px]" style={{ color: 'var(--ink-3)' }}>
            <span className="micro-label">Rough estimate</span>{' '}
            <span className="ml-1">
              Roughly{' '}
              <span className="font-tabular" style={{ color: 'var(--ink-2)' }}>{credits}</span>{' '}
              Explorium credits and about{' '}
              <span className="font-tabular" style={{ color: 'var(--ink-2)' }}>${dollars}</span>{' '}
              of AI per run
            </span>
          </p>
        )}

        {/* Yield expectations — sets the 'often fewer than your aim' expectation. */}
        <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--ink-3)' }}>
          We discover many companies and deliver only the ones that truly fit, so the
          number delivered is often smaller than your aim — especially in new markets.
        </p>

        {notice && (
          <div
            className="rise-in mt-3 rounded px-3.5 py-2.5 text-[12.5px]"
            style={
              notice.kind === 'ok'
                ? { background: 'var(--ok-bg)', color: 'var(--ok-ink)' }
                : { background: 'var(--warn-bg)', color: 'var(--warn-ink)' }
            }
          >
            {notice.message}
          </div>
        )}
      </div>

      {/* ── Runs list ─────────────────────────────────────────────── */}
      {runs.length === 0 ? (
        <div
          className="card-soft p-5 text-[13px] italic"
          style={{ color: 'var(--ink-4)' }}
        >
          No runs yet. Pick a country above and press Run discovery.
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <RunCard key={run.id} run={run} isAdmin={isAdmin} />
          ))}
        </div>
      )}

      {/* ── Confirm overlay ───────────────────────────────────────── */}
      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: 'rgba(15, 46, 58, 0.35)' }}
        >
          <div className="card-soft rise-in w-full max-w-md p-5">
            <div className="micro-label mb-2">Start discovery</div>
            <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--ink)' }}>
              Find about{' '}
              <span className="font-tabular">{target}</span> leads in{' '}
              <span className="font-display" style={{ color: 'var(--navy-deep)' }}>
                {titleCase(countryTrimmed)}
              </span>
              .
            </p>
            {isAdmin ? (
              <p className="mt-2 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
                Roughly{' '}
                <span className="font-tabular" style={{ color: 'var(--ink-2)' }}>{credits}</span>{' '}
                Explorium credits and about{' '}
                <span className="font-tabular" style={{ color: 'var(--ink-2)' }}>${dollars}</span>{' '}
                of AI per run.
              </p>
            ) : (
              <p className="mt-2 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
                This takes a few minutes. You can keep working while it runs.
              </p>
            )}
            <p className="mt-2 text-[12px]" style={{ color: 'var(--warn-ink)' }}>
              {isAdmin
                ? 'This spends real Explorium credits and AI budget.'
                : 'This starts a real discovery run.'}
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={starting}
                className="btn-ghost text-[13px]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void startRun()}
                disabled={starting}
                className="btn-primary text-[13px]"
              >
                {starting ? 'Starting…' : 'Start run'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RunCard({ run, isAdmin }: { run: PipelineRun; isAdmin: boolean }) {
  const pill = RUN_STATUS_STYLES[run.status];
  const active = run.status === 'queued' || run.status === 'running';
  const reviewCount = run.qualified_count ?? run.leads_delivered ?? 0;

  return (
    <div className="card-soft p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span
          className="font-display text-[16px]"
          style={{ color: 'var(--navy-deep)' }}
        >
          {titleCase(run.country)}
        </span>
        <span className="pill" style={{ color: pill.ink, background: pill.bg }}>
          {RUN_STATUS_LABELS[run.status]}
        </span>
        {/* Raw stage strings are operator detail — admins only. */}
        {isAdmin && run.status === 'running' && run.stage && (
          <span className="text-[12px]" style={{ color: 'var(--ink-3)' }}>
            {run.stage}
          </span>
        )}
        <span
          className="ml-auto font-tabular text-[11.5px]"
          style={{ color: 'var(--ink-4)' }}
        >
          {fmtDateTimeUTC(run.created_at)} UTC
        </span>
      </div>

      {/* Counts (the raw "discovered" pool is the whole 600-company candidate
          set under loop-to-target — confusing next to "1 company", so omit it). */}
      {(run.qualified_count != null || run.leads_delivered != null) && (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
          <Count label="Companies" value={run.qualified_count} />
          <Count label="Contacts" value={run.leads_delivered} />
        </div>
      )}

      {/* Active hint */}
      {active && (
        <div className="mt-3" aria-live="polite">
          <div
            className="skel h-1.5 w-40 rounded-full"
            aria-hidden="true"
          />
          <span className="sr-only">Working…</span>
          <span
            className="ml-0 mt-1 block text-[11.5px] italic"
            style={{ color: 'var(--ink-4)' }}
          >
            {run.status === 'queued' ? 'waiting to start…' : 'working…'}
          </span>
        </div>
      )}

      {/* Success: review the new companies in the CRM and/or open the sheet. */}
      {run.status === 'succeeded' && (
        <>
          {reviewCount === 0 && (
            <p className="mt-3 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
              No companies passed the quality bar this time. Try a larger aim, or another market
              {' '}— yield is often thinner in newer markets.
            </p>
          )}
          {(reviewCount > 0 || run.sheet_url) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {run.crm_synced === true && run.batch_label && reviewCount > 0 && (
                <Link
                  href={`/companies?batch=${encodeURIComponent(run.batch_label)}`}
                  className="btn-primary text-[13px] inline-block"
                >
                  Review {reviewCount} new {reviewCount === 1 ? 'company' : 'companies'}
                </Link>
              )}
              {run.crm_synced === true && run.batch_label && reviewCount > 0 && (
                <a
                  href={`/api/export/xlsx?batch=${encodeURIComponent(run.batch_label)}`}
                  className="btn-ghost text-[13px] inline-block"
                >
                  Download Excel
                </a>
              )}
              {run.sheet_url && (
                <a
                  href={run.sheet_url}
                  target="_blank"
                  rel="noreferrer"
                  className="btn-ghost text-[13px] inline-block"
                >
                  Open Sheet ↗
                </a>
              )}
            </div>
          )}
        </>
      )}

      {/* Sync failed — leads went to the sheet but not the pipeline. */}
      {run.status === 'succeeded' && run.crm_synced === false && (
        <div className="mt-2 text-[12px]" style={{ color: 'var(--warn-ink)' }}>
          These leads were delivered to the sheet but couldn&rsquo;t be added to your
          pipeline automatically. Open the sheet, or run it again.
        </div>
      )}

      {/* Failure — friendly for clients, raw detail for admins. */}
      {run.status === 'failed' && (
        <div className="mt-3 text-[12.5px]" style={{ color: 'var(--warn-ink)' }}>
          {friendlyRunError(run.error)}
          {isAdmin && run.error && (
            <details className="mt-1">
              <summary className="cursor-pointer text-[11.5px]" style={{ color: 'var(--ink-4)' }}>
                Details
              </summary>
              <pre className="mt-1 whitespace-pre-wrap text-[11px]" style={{ color: 'var(--ink-3)' }}>
                {run.error}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function Count({ label, value }: { label: string; value: number | null }) {
  if (value == null) return null;
  return (
    <div>
      <div className="micro-label">{label}</div>
      <div className="font-tabular text-[15px]" style={{ color: 'var(--ink)' }}>
        {value}
      </div>
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
