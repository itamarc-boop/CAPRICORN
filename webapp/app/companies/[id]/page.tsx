import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';
import {
  COMPANY_STATUS_LABELS,
  DRAFT_STATUS_STYLES,
  titleCase,
  type Company,
  type Contact,
  type EmailDraft,
  type EmailLogRow,
  type Template,
} from '@/lib/db/types';
import StatusControl from './status-control';
import ContactsPanel from './contacts-panel';
import EmailPanel, { type PanelDraft } from './email-panel';
import WriteEmailButton from './write-email-button';
import { EditableBasics, EditableTier, EditableWebsite, NotesPanel } from './editable-fields';

export const dynamic = 'force-dynamic';

type DraftListItem = Pick<
  EmailDraft,
  'id' | 'contact_id' | 'subject' | 'status' | 'language' | 'created_at' | 'sent_at' | 'error'
>;

/* ────────────────────────────────────────────────────────────────
   Deterministic date formatting — UTC slices of the ISO string,
   never `new Date(...)` locale rendering, so server output is stable.
   ──────────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monD(iso: string | null | undefined): string {
  if (!iso || iso.length < 10) return '—';
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(d) || d < 1) {
    return iso.slice(0, 10);
  }
  return `${MONTHS[m - 1]} ${d}`;
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
}

function externalHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/* ────────────────────────────────────────────────────────────────
   Evidence parsing. Pipeline strings come in the shape
     `yes: "verbatim quote" (english gloss)` | `no: …` | `unverified …`
   We split off the leading verdict token, the quoted excerpt, and
   the parenthetical gloss so the page can typeset them properly.
   ──────────────────────────────────────────────────────────────── */

type ParsedEvidence = {
  verdict: string | null;
  quote: string | null;
  gloss: string | null;
  text: string | null;
};

const VERDICT_TOKENS = new Set([
  'yes', 'no', 'unverified', 'likely', 'unlikely',
  'partial', 'partially', 'maybe', 'mixed', 'unclear', 'unknown',
]);

function parseEvidence(raw: string | null): ParsedEvidence {
  const value = (raw ?? '').trim();
  if (!value) return { verdict: null, quote: null, gloss: null, text: null };

  let verdict: string | null = null;
  let rest = value;
  const lead = value.match(/^([A-Za-z]+)\b\s*[:\-–—]?\s*/);
  if (lead && VERDICT_TOKENS.has(lead[1].toLowerCase())) {
    verdict = lead[1].toLowerCase();
    rest = value.slice(lead[0].length).trim();
  }

  const quoteMatch = rest.match(/["“]([^"”]+)["”]/);
  if (!quoteMatch) {
    return { verdict, quote: null, gloss: null, text: rest || null };
  }
  const after = rest.slice((quoteMatch.index ?? 0) + quoteMatch[0].length);
  const glossMatch = after.match(/\(([^)]+)\)/);
  return {
    verdict,
    quote: quoteMatch[1].trim() || null,
    gloss: glossMatch ? glossMatch[1].trim() : null,
    text: null,
  };
}

function verdictStyle(verdict: string | null): { ink: string; bg: string } {
  if (verdict === 'yes') return { ink: 'var(--ok-ink)', bg: 'var(--ok-bg)' };
  if (verdict === 'no') return { ink: 'var(--warn-ink)', bg: 'var(--warn-bg)' };
  return { ink: 'var(--muted-ink)', bg: 'var(--muted-bg)' };
}

/* ────────────────────────────────────────────────────────────────
   Page
   ──────────────────────────────────────────────────────────────── */

export default async function CompanyDetailPage(
  { params }: { params: Promise<{ id: string }> }
) {
  await requireAppUser();
  const { id } = await params;
  const supabase = await getServerSupabase();

  const [companyRes, contactsRes, templatesRes, emailLogRes, draftsRes] = await Promise.all([
    supabase.from('companies').select('*').eq('id', id).maybeSingle(),
    supabase
      .from('contacts')
      .select('*')
      .eq('company_id', id)
      .order('is_primary', { ascending: false })
      .order('created_at'),
    supabase
      .from('templates')
      .select('id, name, subject_template, body_template')
      .order('created_at'),
    supabase
      .from('email_log')
      .select('*')
      .eq('company_id', id)
      .order('sent_at', { ascending: false }),
    supabase
      .from('email_drafts')
      .select('id, contact_id, to_email, subject, status, language, created_at, sent_at, error')
      .eq('company_id', id)
      .order('created_at', { ascending: false }),
  ]);

  const company = (companyRes.data ?? null) as Company | null;
  if (!company) notFound();

  const contacts = (contactsRes.data ?? []) as Contact[];
  const templates = (templatesRes.data ?? []) as Template[];
  const emailLog = (emailLogRes.data ?? []) as EmailLogRow[];
  const drafts = (draftsRes.data ?? []) as DraftListItem[];

  /* ── Derived display data ───────────────────────────────────── */

  const location = [company.city, titleCase(company.country)].filter(Boolean).join(', ');
  const metaLine = [company.industry, location].filter(Boolean).join(' · ');

  const icpScore = company.icp_score;
  const icpPct = icpScore != null ? Math.max(0, Math.min(100, icpScore)) : null;
  const dealPct =
    company.deal_probability != null ? `${Math.round(company.deal_probability * 100)}%` : '—';
  const sourceLabel =
    company.batch_label ??
    (company.iteration != null ? `Iteration ${company.iteration}` : '—');

  const brandChips = (company.third_party_brands ?? '')
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const evidenceUrls = (company.evidence_urls ?? '')
    .split(';')
    .map((u) => u.trim())
    .filter(Boolean);

  const gapItems = (company.what_to_sell_gaps ?? '')
    .split(';')
    .map((s) => s.trim().replace(/^[-•]\s*/, ''))
    .filter(Boolean);
  const gapsAsChips = gapItems.length > 1 && gapItems.every((g) => g.length <= 80);

  /* ── Activity timeline, assembled server-side ───────────────── */

  type ActivityItem = { key: string; ts: string; dot: string; title: ReactNode; detail?: ReactNode };

  const activity: ActivityItem[] = [];
  for (const e of emailLog) {
    activity.push({
      key: `email-${e.id}`,
      ts: e.sent_at,
      dot: 'var(--ok-ink)',
      title: (
        <>Email sent to <span className="font-tabular">{e.to_email ?? 'unknown recipient'}</span></>
      ),
      detail: e.subject ?? undefined,
    });
  }
  for (const d of drafts) {
    const style = DRAFT_STATUS_STYLES[d.status];
    activity.push({
      key: `draft-${d.id}`,
      ts: d.created_at,
      dot: style.ink,
      title: (
        <>
          Draft{' '}
          <span className="pill text-[10px]" style={{ color: style.ink, background: style.bg }}>
            {d.status}
          </span>
        </>
      ),
      detail: <>{d.subject} · {d.language.toUpperCase()}</>,
    });
  }
  if (company.status !== 'new') {
    activity.push({
      key: 'status',
      ts: company.status_changed_at,
      dot: 'var(--info-ink)',
      title: <>Status: {COMPANY_STATUS_LABELS[company.status]}</>,
    });
  }
  activity.push({
    key: 'imported',
    ts: company.created_at,
    dot: 'var(--muted-ink)',
    title: (
      <>
        Imported from pipeline ·{' '}
        {company.batch_label ??
          (company.iteration != null ? `Iteration ${company.iteration}` : 'Lead pipeline')}
      </>
    ),
  });
  activity.sort((a, b) => b.ts.localeCompare(a.ts));

  /* ── Engagement numbers ──────────────────────────────────────── */

  const emailsSent = emailLog.length;
  const openDrafts = drafts.filter((d) => d.status === 'draft' || d.status === 'approved').length;
  const lastActivityTs =
    [emailLog[0]?.sent_at, drafts[0]?.created_at]
      .filter((t): t is string => Boolean(t))
      .sort()
      .pop() ?? null;

  return (
    <div className="space-y-6">
      {/* ── 1 · Hero ─────────────────────────────────────────── */}
      <header className="card-soft p-6">
        <Link href="/companies" className="text-[12px] link-soft">← Back to companies</Link>

        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 mt-2.5">
          <div className="min-w-0">
            <div className="micro-label mb-2">Company</div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <h1
                className="font-display text-[30px] leading-tight"
                style={{ color: 'var(--navy-deep)' }}
              >
                {company.company_name}
              </h1>
              <EditableTier company={company} />
              {company.needs_human_check && (
                <span
                  className="pill text-[10.5px]"
                  style={{ color: 'var(--warn-ink)', background: 'var(--warn-bg)' }}
                  title={company.needs_human_check}
                >
                  Needs human check
                </span>
              )}
            </div>
            <div className="text-[13px] mt-1" style={{ color: 'var(--ink-3)' }}>
              {metaLine || '—'}
            </div>
            {company.needs_human_check && (
              <p className="text-[12px] mt-1.5 max-w-[64ch]" style={{ color: 'var(--warn-ink)' }}>
                {company.needs_human_check}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <WriteEmailButton />
            {company.website && (
              <a
                href={externalHref(company.website)}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost text-[12px] inline-flex items-center gap-1.5"
                title={`Open ${stripProtocol(company.website)}`}
              >
                <span className="max-w-[160px] truncate">{stripProtocol(company.website)}</span>
                <span aria-hidden style={{ color: 'var(--ink-4)' }}>↗</span>
              </a>
            )}
            {company.linkedin_company_page && (
              <a
                href={externalHref(company.linkedin_company_page)}
                target="_blank"
                rel="noreferrer"
                className="btn-ghost text-[12px] inline-flex items-center gap-1.5"
                title={`Open ${stripProtocol(company.linkedin_company_page)}`}
              >
                <span className="max-w-[160px] truncate">
                  {stripProtocol(company.linkedin_company_page)}
                </span>
                <span aria-hidden style={{ color: 'var(--ink-4)' }}>↗</span>
              </a>
            )}
          </div>
        </div>

        {/* Stat band */}
        <div
          className="mt-6 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px rounded-[5px] overflow-hidden border"
          style={{ borderColor: 'var(--line-soft)', background: 'var(--line-soft)' }}
        >
          <StatCell label="ICP score">
            <div className="stat-num">{icpScore ?? '—'}</div>
            <div className="h-1 rounded-full mt-2" style={{ background: 'var(--line-soft)' }}>
              {icpPct != null && (
                <div
                  className="h-1 rounded-full"
                  style={{ background: 'var(--navy)', width: `${icpPct}%` }}
                />
              )}
            </div>
          </StatCell>
          <StatCell label="Deal probability">
            <div className="stat-num">{dealPct}</div>
          </StatCell>
          <StatCell label="Employees">
            <div className="stat-num" style={{ fontSize: '17px', lineHeight: '1.5' }}>
              {company.employee_count ?? '—'}
            </div>
          </StatCell>
          <StatCell label="Est. revenue">
            <div className="stat-num" style={{ fontSize: '17px', lineHeight: '1.5' }}>
              {company.estimated_revenue ?? '—'}
            </div>
          </StatCell>
          <StatCell label="Business model">
            {company.business_model ? (
              <span
                className="pill text-[10.5px]"
                style={{
                  color: 'var(--muted-ink)',
                  background: 'var(--muted-bg)',
                  textTransform: 'none',
                  letterSpacing: '0.01em',
                }}
              >
                {company.business_model.replace(/_/g, ' ')}
              </span>
            ) : (
              <span className="text-[13px]" style={{ color: 'var(--ink-4)' }}>—</span>
            )}
          </StatCell>
          <StatCell label="Source">
            <div className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
              {sourceLabel}
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--ink-4)' }}>
              Added {monD(company.created_at)}
            </div>
          </StatCell>
        </div>
      </header>

      {/* ── 2 · Main grid ────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-5">
          {/* 3 · Why this is a fit */}
          {company.judge_reason && (
            <Section title="Why this is a fit" subtitle="BDR judge">
              <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
                {company.judge_reason}
              </p>
              {company.judge_pattern && (
                <span
                  className="inline-flex items-center mt-3 rounded px-2 py-0.5 font-tabular text-[10.5px] uppercase tracking-wider"
                  style={{
                    color: 'var(--navy-deep)',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--line)',
                  }}
                >
                  Pattern · {company.judge_pattern}
                </span>
              )}
            </Section>
          )}

          {/* 4 · Evidence */}
          <Section title="Evidence" subtitle="Pipeline research">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              <EvidenceCard label="Imports" raw={company.import_evidence} />
              <EvidenceCard label="Own brands" raw={company.own_brand_evidence} />
            </div>

            {brandChips.length > 0 && (
              <div className="mt-4">
                <div className="micro-label mb-1.5">Third-party brands</div>
                <div className="flex flex-wrap gap-1.5">
                  {brandChips.map((b, i) => (
                    <span
                      key={`${b}-${i}`}
                      className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11.5px]"
                      style={{ color: 'var(--muted-ink)', background: 'var(--muted-bg)' }}
                    >
                      {b}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {evidenceUrls.length > 0 && (
              <div className="mt-4">
                <div className="micro-label mb-1.5">Sources</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {evidenceUrls.map((url) => (
                    <a
                      key={url}
                      href={externalHref(url)}
                      target="_blank"
                      rel="noreferrer"
                      className="link-soft text-[12.5px] break-all"
                    >
                      {stripProtocol(url)}
                    </a>
                  ))}
                </div>
              </div>
            )}
          </Section>

          {/* 5 · What Capricorn could sell them */}
          {company.what_to_sell_gaps && (
            <Section title="What Capricorn could sell them" subtitle="Gap analysis">
              {gapsAsChips ? (
                <div className="flex flex-wrap gap-2">
                  {gapItems.map((g, i) => (
                    <span
                      key={`${g}-${i}`}
                      className="inline-flex items-center rounded-full px-3 py-1 text-[12px] leading-snug"
                      style={{ color: 'var(--t2-ink)', background: 'var(--t2-bg)' }}
                    >
                      {g}
                    </span>
                  ))}
                </div>
              ) : (
                <p
                  className="text-[13.5px] leading-relaxed whitespace-pre-line"
                  style={{ color: 'var(--ink-2)' }}
                >
                  {company.what_to_sell_gaps}
                </p>
              )}
            </Section>
          )}

          {/* 6 · About */}
          <Section title="About">
            <EditableBasics company={company} />
            <div
              className="mt-4 pt-4 border-t grid grid-cols-1 sm:grid-cols-3 gap-3"
              style={{ borderColor: 'var(--line-soft)' }}
            >
              <div className="min-w-0">
                <div className="micro-label mb-1">Website</div>
                <div className="text-[13px]">
                  <EditableWebsite company={company} />
                </div>
              </div>
              <div className="min-w-0">
                <div className="micro-label mb-1">LinkedIn</div>
                {company.linkedin_company_page ? (
                  <a
                    href={externalHref(company.linkedin_company_page)}
                    target="_blank"
                    rel="noreferrer"
                    className="link-soft text-[13px] break-all"
                  >
                    {stripProtocol(company.linkedin_company_page)}
                  </a>
                ) : (
                  <span className="text-[13px]" style={{ color: 'var(--ink-4)' }}>—</span>
                )}
              </div>
              {company.business_id && (
                <div className="min-w-0">
                  <div className="micro-label mb-1">Business ID</div>
                  <div className="font-tabular text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
                    {company.business_id}
                  </div>
                </div>
              )}
            </div>
          </Section>

          {/* 7 · Contacts */}
          <Section title="Contacts" subtitle={contacts.length > 0 ? String(contacts.length) : undefined}>
            <ContactsPanel companyId={company.id} initialContacts={contacts} />
          </Section>

          {/* 8 · Activity */}
          <Section title="Activity" subtitle={activity.length > 0 ? String(activity.length) : undefined}>
            {activity.length > 0 ? (
              <ol className="ml-1 pl-5 border-l space-y-4" style={{ borderColor: 'var(--line)' }}>
                {activity.map((item) => (
                  <li key={item.key} className="relative">
                    <span
                      aria-hidden
                      className="absolute w-2 h-2 rounded-full"
                      style={{
                        left: '-24.5px',
                        top: '6px',
                        background: item.dot,
                        boxShadow: '0 0 0 2px var(--surface)',
                      }}
                    />
                    <div className="flex items-baseline gap-2 text-[13px]">
                      <span className="font-medium min-w-0" style={{ color: 'var(--ink)' }}>
                        {item.title}
                      </span>
                      <span
                        className="ml-auto shrink-0 font-tabular text-[11px]"
                        style={{ color: 'var(--ink-4)' }}
                      >
                        {monD(item.ts)}
                      </span>
                    </div>
                    {item.detail && (
                      <div
                        className="text-[12px] mt-0.5 truncate"
                        style={{ color: 'var(--ink-3)' }}
                      >
                        {item.detail}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="empty-note">
                No activity yet. Generate a draft or send an email.
              </p>
            )}
          </Section>
        </div>

        {/* Right sidebar */}
        <aside className="space-y-5">
          {/* 9 · Engagement */}
          <Section title="Engagement">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="stat-num" style={{ fontSize: '22px' }}>{emailsSent}</div>
                <div className="micro-label mt-1">Emails sent</div>
              </div>
              <div>
                <div className="stat-num" style={{ fontSize: '22px' }}>{openDrafts}</div>
                <div className="micro-label mt-1">Open drafts</div>
              </div>
              <div>
                <div
                  className="font-tabular text-[15px]"
                  style={{ color: 'var(--ink)', lineHeight: '25px' }}
                >
                  {lastActivityTs ? monD(lastActivityTs) : '—'}
                </div>
                <div className="micro-label mt-1">Last activity</div>
              </div>
            </div>
          </Section>

          {/* 10 · Email — write a draft, then approve & send in place */}
          <Section id="email" title="Email">
            <EmailPanel
              company={company}
              contacts={contacts}
              templates={templates}
              initialDrafts={drafts as PanelDraft[]}
            />
          </Section>

          {/* 11 · Funnel status */}
          <Section title="Funnel status">
            <StatusControl companyId={company.id} status={company.status} />
          </Section>

          {/* 12 · Notes */}
          <NotesPanel company={company} />
        </aside>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────
   Presentational helpers (server-side only)
   ──────────────────────────────────────────────────────────────── */

function StatCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-4 py-3 min-w-0" style={{ background: 'var(--surface)' }}>
      <div className="micro-label mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function EvidenceCard({ label, raw }: { label: string; raw: string | null }) {
  const parsed = parseEvidence(raw);
  const style = verdictStyle(parsed.verdict);
  return (
    <div
      className="rounded-[5px] p-4"
      style={{ background: 'var(--surface-2)' }}
    >
      <div className="flex items-center justify-between gap-2 mb-2.5">
        <span className="micro-label">{label}</span>
        <span className="pill text-[10px]" style={{ color: style.ink, background: style.bg }}>
          {parsed.verdict ?? 'unverified'}
        </span>
      </div>
      {parsed.quote ? (
        <blockquote className="pl-3" style={{ borderLeft: '2px solid var(--navy)' }}>
          <p
            className="font-display italic text-[14.5px] leading-relaxed"
            style={{ color: 'var(--ink)' }}
          >
            “{parsed.quote}”
          </p>
          {parsed.gloss && (
            <p className="text-[12px] mt-1" style={{ color: 'var(--ink-3)' }}>
              {parsed.gloss}
            </p>
          )}
        </blockquote>
      ) : parsed.text ? (
        <p className="text-[13px] leading-relaxed" style={{ color: 'var(--ink-2)' }}>
          {parsed.text}
        </p>
      ) : (
        <p className="text-[12.5px] italic" style={{ color: 'var(--ink-4)' }}>
          No evidence captured.
        </p>
      )}
    </div>
  );
}

function Section({
  id,
  title,
  subtitle,
  children,
}: {
  id?: string;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="card-soft p-5 scroll-mt-24">
      <div className="section-head mb-4">
        <h2 className="section-title">{title}</h2>
        {subtitle && (
          <span
            className="text-[10.5px] uppercase tracking-wider"
            style={{ color: 'var(--ink-4)' }}
          >
            {subtitle}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}
