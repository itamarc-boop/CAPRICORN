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
  searchParams: Promise<{ country?: string; tier?: string; status?: string }>;
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
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
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
        <p className="text-[13.5px] mb-5" style={{ color: 'var(--ink-3)' }}>
          Run the sync script to import your latest leads file.
        </p>
        <pre
          className="font-tabular inline-block text-left text-[12px] px-4 py-3 rounded"
          style={{ background: 'var(--surface-2)', color: 'var(--ink-2)',
                   border: '1px solid var(--line)' }}
        >
          python3 tools/sync_leads_to_supabase.py .tmp/leads_2026-06-11_iter4.json --iteration 4
        </pre>
        <p className="text-[13px] mt-5" style={{ color: 'var(--ink-3)' }}>
          Or <Link href="/integrations" className="link-soft">connect a Gmail mailbox</Link> first.
        </p>
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
  };

  return (
    <div>
      <div className="flex items-end justify-between mb-6 pb-5 rule-soft border-t-0 border-b border-[color:var(--line)]">
        <div>
          <h1 className="font-display text-[34px] leading-none" style={{ color: 'var(--navy-deep)' }}>
            Companies
          </h1>
          <p className="mt-2 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
            Every qualified company in the pipeline, with contacts and funnel status.
          </p>
        </div>
        <div className="font-tabular text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
          {companies.length} total
        </div>
      </div>
      <CompaniesTable
        key={`${initialFilters.country}|${initialFilters.tier}|${initialFilters.status}`}
        initialCompanies={companies}
        templates={templates}
        initialFilters={initialFilters}
      />
    </div>
  );
}
