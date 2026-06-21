import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  COMPANY_STATUSES,
  COMPANY_STATUS_LABELS,
  COMPANY_STATUS_STYLES,
  TIER_STYLES,
  titleCase,
  type Company,
  type CompanyStatus,
  type EmailLogRow,
} from '@/lib/db/types';

export const dynamic = 'force-dynamic';

/* ── Row slices ──────────────────────────────────────────────────── */

type CompanySlice = Pick<
  Company,
  'id' | 'country' | 'icp_tier' | 'status' | 'company_name' | 'created_at' | 'batch_label' | 'iteration'
>;

type DraftSlice = { id: string; status: string };

type SendSlice = Pick<EmailLogRow, 'id' | 'to_email' | 'subject' | 'sent_at' | 'company_id'>;

const TIERS = ['Tier 1', 'Tier 2', 'Tier 3'] as const;
type Tier = (typeof TIERS)[number];

/** Funnel statuses shown as stat cards (not_interested/archived omitted). */
const FUNNEL_STATUSES: CompanyStatus[] = ['new', 'contacted', 'replied', 'meeting', 'won'];

/* ── Deterministic dates ─────────────────────────────────────────────
   Render UTC month-day straight from the ISO string slice so output
   never depends on server locale or timezone. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthDay(iso: string | null | undefined): string {
  if (!iso || iso.length < 10) return '';
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (!m || !d || m > 12) return '';
  return `${MONTHS[m - 1]} ${d}`;
}

/* ── Country rollups (Markets section) ───────────────────────────── */

type CountryRollup = {
  /** Raw stored country value ('' for null/empty → grouped as Unknown). */
  raw: string;
  display: string;
  total: number;
  byTier: Record<Tier, number>;
  byStatus: Record<CompanyStatus, number>;
};

function buildRollups(rows: CompanySlice[]): CountryRollup[] {
  const map = new Map<string, CountryRollup>();

  for (const row of rows) {
    const raw = (row.country ?? '').trim();
    let rollup = map.get(raw);
    if (!rollup) {
      rollup = {
        raw,
        display: raw ? titleCase(raw) : 'Unknown',
        total: 0,
        byTier: { 'Tier 1': 0, 'Tier 2': 0, 'Tier 3': 0 },
        byStatus: {
          new: 0, contacted: 0, replied: 0, meeting: 0,
          won: 0, not_interested: 0, archived: 0,
        },
      };
      map.set(raw, rollup);
    }
    rollup.total += 1;
    if (row.icp_tier && row.icp_tier in rollup.byTier) {
      rollup.byTier[row.icp_tier as Tier] += 1;
    }
    if (row.status in rollup.byStatus) {
      rollup.byStatus[row.status] += 1;
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => b.total - a.total || a.display.localeCompare(b.display),
  );
}

function companiesHref(raw: string, status?: CompanyStatus): string {
  const parts: string[] = [];
  // '' is the Unknown rollup — use the '__unknown__' sentinel so the
  // companies page filters to rows with no country instead of showing all.
  parts.push(`country=${encodeURIComponent(raw || '__unknown__')}`);
  if (status) parts.push(`status=${encodeURIComponent(status)}`);
  return `/companies?${parts.join('&')}`;
}

function TierBar({ byTier }: { byTier: Record<Tier, number> }) {
  const tierTotal = TIERS.reduce((sum, t) => sum + byTier[t], 0);

  return (
    <div className="mt-3">
      <div
        className="flex h-1.5 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--line-soft)' }}
        aria-hidden
      >
        {tierTotal > 0 &&
          TIERS.map((tier) =>
            byTier[tier] > 0 ? (
              <div
                key={tier}
                style={{
                  width: `${(byTier[tier] / tierTotal) * 100}%`,
                  background: TIER_STYLES[tier].bg,
                }}
              />
            ) : null,
          )}
      </div>
      <div
        className="mt-1.5 font-tabular text-[11px] tracking-wider"
        style={{ color: 'var(--ink-4)' }}
      >
        {TIERS.map((tier, i) => (
          <span key={tier}>
            {i > 0 && <span style={{ color: 'var(--ink-4)' }}> · </span>}
            <span style={{ color: TIER_STYLES[tier].ink }}>
              T{i + 1} {byTier[tier]}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function CountryCard({ rollup }: { rollup: CountryRollup }) {
  return (
    <div className="card-soft p-4">
      <div className="flex items-baseline justify-between gap-3">
        <Link
          href={companiesHref(rollup.raw)}
          className="font-display text-[17px] leading-tight hover:underline"
          style={{ color: 'var(--navy-deep)' }}
        >
          {rollup.display}
        </Link>
        <div className="font-tabular text-[13px]" style={{ color: 'var(--ink-3)' }}>
          {rollup.total}
        </div>
      </div>

      <TierBar byTier={rollup.byTier} />

      <div className="mt-3 flex flex-wrap gap-1.5">
        {COMPANY_STATUSES.map((status) =>
          rollup.byStatus[status] > 0 ? (
            <Link key={status} href={companiesHref(rollup.raw, status)}>
              <span
                className="pill"
                style={{
                  color: COMPANY_STATUS_STYLES[status].ink,
                  background: COMPANY_STATUS_STYLES[status].bg,
                }}
              >
                {COMPANY_STATUS_LABELS[status]}{' '}
                <span className="font-tabular ml-1">{rollup.byStatus[status]}</span>
              </span>
            </Link>
          ) : null,
        )}
      </div>
    </div>
  );
}

/* ── Small presentational helpers ────────────────────────────────── */

function MicroLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-[10.5px] uppercase tracking-wider font-semibold"
      style={{ color: 'var(--ink-3)' }}
    >
      {children}
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2 className="font-display text-[20px] leading-none" style={{ color: 'var(--navy-deep)' }}>
      {children}
    </h2>
  );
}

/* ── Page ────────────────────────────────────────────────────────── */

export default async function DashboardPage() {
  await requireAppUser();
  const supabase = await getServerSupabase();

  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [companiesRes, draftsRes, sendsRes, contactsRes] = await Promise.all([
    supabase
      .from('companies')
      .select('id, country, icp_tier, status, company_name, created_at, batch_label, iteration'),
    supabase.from('email_drafts').select('id, status'),
    supabase
      .from('email_log')
      .select('id, to_email, subject, sent_at, company_id')
      .gte('sent_at', sinceIso)
      .order('sent_at', { ascending: false }),
    supabase.from('contacts').select('id'),
  ]);

  if (companiesRes.error) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load companies: {companiesRes.error.message}
      </div>
    );
  }

  const rows = (companiesRes.data ?? []) as CompanySlice[];

  if (rows.length === 0) {
    return (
      <div className="card-soft p-10 text-center">
        <h2 className="font-display text-2xl mb-2" style={{ color: 'var(--navy-deep)' }}>
          No companies yet
        </h2>
        <p className="text-[13.5px] mb-5" style={{ color: 'var(--ink-3)' }}>
          Run the sync script to import your latest leads file.
        </p>
        <pre
          className="font-tabular inline-block text-left text-[12px] px-4 py-3 rounded"
          style={{ background: 'var(--surface-2)', color: 'var(--ink-2)',
                   border: '1px solid var(--line)' }}
        >
          python3 tools/sync_leads_to_supabase.py .tmp/leads_2026-05-27_iter2_v2.json --iteration 2
        </pre>
        <p className="text-[13px] mt-5" style={{ color: 'var(--ink-3)' }}>
          Or <Link href="/integrations" className="link-soft">connect a Gmail mailbox</Link> first.
        </p>
      </div>
    );
  }

  const drafts = (draftsRes.data ?? []) as DraftSlice[];
  const sends = (sendsRes.data ?? []) as SendSlice[];
  const contactsCount = (contactsRes.data ?? []).length;

  const statusCounts: Record<CompanyStatus, number> = {
    new: 0, contacted: 0, replied: 0, meeting: 0,
    won: 0, not_interested: 0, archived: 0,
  };
  for (const row of rows) {
    if (row.status in statusCounts) statusCounts[row.status] += 1;
  }

  const draftCount = drafts.filter((d) => d.status === 'draft').length;
  const approvedCount = drafts.filter((d) => d.status === 'approved').length;

  const companyNameById = new Map(rows.map((r) => [r.id, r.company_name]));

  const recentSends = sends.slice(0, 6);
  const recentlyAdded = [...rows]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, 6);

  const rollups = buildRollups(rows);

  return (
    <div>
      {/* 1 — Header */}
      <div className="flex items-end justify-between mb-6 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
        <div>
          <h1 className="font-display text-[34px] leading-none" style={{ color: 'var(--navy-deep)' }}>
            Dashboard
          </h1>
          <p className="mt-2 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
            Where the pipeline stands right now.
          </p>
        </div>
        <div className="text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
          <Link href="/companies" className="link-soft">All companies →</Link>
        </div>
      </div>

      {/* 2 — Funnel row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {FUNNEL_STATUSES.map((status) => (
          <Link
            key={status}
            href={`/companies?status=${encodeURIComponent(status)}`}
            className="card-soft p-4 block hover:border-[var(--line-strong)]"
          >
            <div
              className="font-tabular text-[28px] leading-none"
              style={{ color: 'var(--navy-deep)' }}
            >
              {statusCounts[status]}
            </div>
            <div className="mt-2.5">
              <span
                className="pill"
                style={{
                  color: COMPANY_STATUS_STYLES[status].ink,
                  background: COMPANY_STATUS_STYLES[status].bg,
                }}
              >
                {COMPANY_STATUS_LABELS[status]}
              </span>
            </div>
          </Link>
        ))}
      </div>

      {/* 3 — Secondary strip */}
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Link href="/drafts" className="card-soft p-4 block hover:border-[var(--line-strong)]">
          <MicroLabel>Drafts to review</MicroLabel>
          <div className="mt-1.5 font-tabular text-[22px] leading-none" style={{ color: 'var(--navy-deep)' }}>
            {draftCount}
          </div>
        </Link>
        <Link href="/drafts" className="card-soft p-4 block hover:border-[var(--line-strong)]">
          <MicroLabel>Approved, queued</MicroLabel>
          <div className="mt-1.5 font-tabular text-[22px] leading-none" style={{ color: 'var(--navy-deep)' }}>
            {approvedCount}
          </div>
        </Link>
        <div className="card-soft p-4">
          <MicroLabel>Emails sent · 7 days</MicroLabel>
          <div className="mt-1.5 font-tabular text-[22px] leading-none" style={{ color: 'var(--navy-deep)' }}>
            {sends.length}
          </div>
        </div>
      </div>
      <p className="mt-2.5 text-[12px]" style={{ color: 'var(--ink-3)' }}>
        <span className="font-tabular">{rows.length}</span> companies
        <span className="mx-1.5" style={{ color: 'var(--ink-4)' }}>·</span>
        <span className="font-tabular">{contactsCount}</span> contacts
      </p>

      {/* 4 — Recent sends / Recently added */}
      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section>
          <SectionHeading>Recent sends</SectionHeading>
          <div className="card-soft mt-3">
            {recentSends.length === 0 ? (
              <p className="p-4 text-[13px] italic" style={{ color: 'var(--ink-3)' }}>
                No emails sent yet. Generate drafts from Companies.
              </p>
            ) : (
              <ul>
                {recentSends.map((send, i) => {
                  const companyName = send.company_id
                    ? companyNameById.get(send.company_id)
                    : undefined;
                  return (
                    <li
                      key={send.id}
                      className="px-4 py-3"
                      style={i > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="min-w-0">
                          <div
                            className="text-[13.5px] font-medium truncate"
                            style={{ color: 'var(--ink)' }}
                          >
                            {send.subject || '(no subject)'}
                          </div>
                          <div className="mt-0.5 text-[12px]" style={{ color: 'var(--ink-3)' }}>
                            {send.company_id && companyName ? (
                              <>
                                <Link href={`/companies/${send.company_id}`} className="link-soft">
                                  {companyName}
                                </Link>
                                <span className="mx-1.5" style={{ color: 'var(--ink-4)' }}>·</span>
                              </>
                            ) : null}
                            <span className="font-tabular">{send.to_email ?? ''}</span>
                          </div>
                        </div>
                        <div
                          className="font-tabular text-[12px] shrink-0"
                          style={{ color: 'var(--ink-4)' }}
                        >
                          {monthDay(send.sent_at)}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section>
          <SectionHeading>Recently added</SectionHeading>
          <div className="card-soft mt-3">
            <ul>
              {recentlyAdded.map((company, i) => {
                const tierStyle = company.icp_tier ? TIER_STYLES[company.icp_tier] : undefined;
                const batchTag =
                  company.batch_label ||
                  (company.iteration != null ? `Iteration ${company.iteration}` : null);
                return (
                  <li
                    key={company.id}
                    className="px-4 py-3"
                    style={i > 0 ? { borderTop: '1px solid var(--line-soft)' } : undefined}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2 min-w-0">
                          <Link
                            href={`/companies/${company.id}`}
                            className="link-soft text-[13.5px] font-medium truncate"
                          >
                            {company.company_name}
                          </Link>
                          {tierStyle ? (
                            <span
                              className="pill shrink-0"
                              style={{ color: tierStyle.ink, background: tierStyle.bg }}
                            >
                              {company.icp_tier}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-[12px]" style={{ color: 'var(--ink-3)' }}>
                          {company.country ? titleCase(company.country) : 'Unknown'}
                          {batchTag ? (
                            <>
                              <span className="mx-1.5" style={{ color: 'var(--ink-4)' }}>·</span>
                              <span style={{ color: 'var(--ink-4)' }}>{batchTag}</span>
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div
                        className="font-tabular text-[12px] shrink-0"
                        style={{ color: 'var(--ink-4)' }}
                      >
                        {monthDay(company.created_at)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      </div>

      {/* 5 — Markets */}
      <div className="mt-10">
        <div className="flex items-end justify-between pb-3 border-b" style={{ borderColor: 'var(--line)' }}>
          <SectionHeading>Markets</SectionHeading>
          <div className="text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
            <span className="font-tabular">{rollups.length}</span> markets
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rollups.map((rollup) => (
            <CountryCard key={rollup.raw || '__unknown__'} rollup={rollup} />
          ))}
        </div>
      </div>
    </div>
  );
}
