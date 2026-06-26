import Link from 'next/link';
import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';
import { COMPANY_STATUSES } from '@/lib/db/types';
import CompaniesTable, { type CompanyRow } from './companies-table';
import type { TemplateOption } from './generate-drafts-bar';

export const dynamic = 'force-dynamic';

const COMPANY_SELECT =
  'id, company_name, country, city, industry, icp_tier, icp_score, deal_probability, status, iteration, batch_label, contacts(id, full_name, title, email, is_primary)';

const TIERS = ['Tier 1', 'Tier 2', 'Tier 3'];

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; tier?: string; status?: string; batch?: string }>;
}) {
  await requireAppUser();
  const sp = await searchParams;
  const supabase = await getServerSupabase();

  const [companiesRes, templatesRes] = await Promise.all([
    supabase
      .from('companies')
      .select(COMPANY_SELECT)
      .order('icp_tier', { ascending: true })
      .order('icp_score', { ascending: false, nullsFirst: false }),
    supabase.from('templates').select('id, name').order('created_at'),
  ]);

  if (companiesRes.error) {
    return (
      <div
        className="rounded p-4 text-[13px]"
        style={{ background: 'var(--danger-bg)', color: 'var(--danger-ink)' }}
      >
        Failed to load companies: {companiesRes.error.message}
      </div>
    );
  }

  const companies = (companiesRes.data ?? []) as unknown as CompanyRow[];
  const templates = (templatesRes.data ?? []) as TemplateOption[];

  if (companies.length === 0) {
    return (
      <div className="card-soft p-10 text-center">
        <h2 className="font-display text-2xl mb-2" style={{ color: 'var(--navy-deep)' }}>
          No companies yet
        </h2>
        <p className="text-[13.5px] mb-6" style={{ color: 'var(--ink-3)' }}>
          Run Discover to find your first leads, then connect Gmail so you can email them.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <Link href="/discover" className="btn-primary text-[13px]">
            Discover your first leads
          </Link>
          <Link href="/integrations" className="btn-ghost text-[13px]">
            Connect Gmail
          </Link>
        </div>
      </div>
    );
  }

  const initialFilters = {
    country: sp.country ?? '',
    tier: sp.tier && TIERS.includes(sp.tier) ? sp.tier : '',
    status:
      sp.status && (COMPANY_STATUSES as readonly string[]).includes(sp.status)
        ? sp.status
        : '',
    batch: sp.batch ?? '',
  };

  // "Download Excel" exports exactly the current URL filter.
  const exportParams = new URLSearchParams();
  for (const [k, v] of Object.entries(initialFilters)) if (v) exportParams.set(k, v);
  const exportHref = `/api/export/xlsx${exportParams.toString() ? `?${exportParams.toString()}` : ''}`;

  return (
    <div>
      <div className="flex items-end justify-between mb-8 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
        <div>
          <div className="micro-label mb-2">Pipeline</div>
          <h1 className="font-display text-[40px] leading-none" style={{ color: 'var(--navy-deep)' }}>
            Companies
          </h1>
          <p className="mt-3 text-[13px]" style={{ color: 'var(--ink-3)' }}>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{companies.length}</span> qualified companies, with contacts and funnel status.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href={exportHref} className="btn-ghost text-[13px] whitespace-nowrap">
            Download Excel
          </a>
        </div>
      </div>
      <CompaniesTable
        key={`${initialFilters.country}|${initialFilters.tier}|${initialFilters.status}|${initialFilters.batch}`}
        initialCompanies={companies}
        templates={templates}
        initialFilters={initialFilters}
      />
    </div>
  );
}
