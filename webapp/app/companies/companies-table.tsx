'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import {
  type Company,
  type Contact,
  COMPANY_STATUSES,
  COMPANY_STATUS_LABELS,
  COMPANY_STATUS_STYLES,
  TIER_STYLES,
  titleCase,
} from '@/lib/db/types';
import GenerateDraftsBar, { type TemplateOption } from './generate-drafts-bar';

export type CompanyContact = Pick<Contact, 'id' | 'full_name' | 'title' | 'email' | 'is_primary'>;

export type CompanyRow = Pick<
  Company,
  | 'id'
  | 'company_name'
  | 'country'
  | 'city'
  | 'industry'
  | 'icp_tier'
  | 'icp_score'
  | 'deal_probability'
  | 'status'
  | 'iteration'
  | 'batch_label'
> & { contacts: CompanyContact[] };

const COMPANY_SELECT =
  'id, company_name, country, city, industry, icp_tier, icp_score, deal_probability, status, iteration, batch_label, contacts(id, full_name, title, email, is_primary)';

const TIERS = ['Tier 1', 'Tier 2', 'Tier 3'];

function displayContact(contacts: CompanyContact[]): CompanyContact | null {
  if (contacts.length === 0) return null;
  return contacts.find(c => c.is_primary) ?? contacts[0];
}

export default function CompaniesTable({
  initialCompanies,
  templates,
  initialFilters,
}: {
  initialCompanies: CompanyRow[];
  templates: TemplateOption[];
  initialFilters: { country: string; tier: string; status: string; batch: string };
}) {
  const [companies, setCompanies] = useState<CompanyRow[]>(initialCompanies);
  const [filterCountry, setFilterCountry] = useState<string>(initialFilters.country);
  const [filterTier, setFilterTier] = useState<string>(initialFilters.tier);
  const [filterStatus, setFilterStatus] = useState<string>(initialFilters.status);
  const filterBatch = initialFilters.batch;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const headerCheckboxRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    const channel = supabase
      .channel('companies-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'companies' },
        async () => {
          const { data } = await supabase
            .from('companies')
            .select(COMPANY_SELECT)
            .order('icp_tier', { ascending: true })
            .order('icp_score', { ascending: false, nullsFirst: false });
          if (data) setCompanies(data as unknown as CompanyRow[]);
        })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const countries = useMemo(
    () => Array.from(new Set(companies.map(c => c.country).filter(Boolean))).sort() as string[],
    [companies]
  );
  const hasUnknownCountry = useMemo(() => companies.some(c => !c.country), [companies]);

  const filtered = companies.filter(c =>
    (!filterCountry ||
      (filterCountry === '__unknown__' ? !c.country : c.country === filterCountry)) &&
    (!filterTier || c.icp_tier === filterTier) &&
    (!filterStatus || c.status === filterStatus) &&
    (!filterBatch || c.batch_label === filterBatch)
  );

  const selectedFilteredCount = filtered.filter(c => selectedIds.has(c.id)).length;
  const allFilteredSelected = filtered.length > 0 && selectedFilteredCount === filtered.length;

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate =
        selectedFilteredCount > 0 && selectedFilteredCount < filtered.length;
    }
  }, [selectedFilteredCount, filtered.length]);

  function toggleAllFiltered() {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const c of filtered) next.delete(c.id);
      } else {
        for (const c of filtered) next.add(c.id);
      }
      return next;
    });
  }

  function toggleOne(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedCompanies = companies.filter(c => selectedIds.has(c.id));

  return (
    <div className={selectedCompanies.length > 0 ? 'pb-32' : ''}>
      <div className="flex flex-wrap items-center gap-2.5 mb-4 text-[12.5px]">
        <FilterSelect value={filterCountry} onChange={setFilterCountry} all="All countries"
                      options={[
                        ...countries.map(c => ({ v: c, l: titleCase(c) })),
                        ...(hasUnknownCountry ? [{ v: '__unknown__', l: 'Unknown' }] : []),
                      ]} />
        <FilterSelect value={filterTier} onChange={setFilterTier} all="All tiers"
                      options={TIERS.map(t => ({ v: t, l: t }))} />
        <FilterSelect value={filterStatus} onChange={setFilterStatus} all="All statuses"
                      options={COMPANY_STATUSES.map(s => ({ v: s, l: COMPANY_STATUS_LABELS[s] }))} />
        {filterBatch && (
          <span
            className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12px]"
            style={{ background: 'var(--info-bg)', color: 'var(--info-ink)' }}
          >
            <span className="micro-label" style={{ color: 'var(--info-ink)' }}>Batch</span>
            <span className="font-tabular">{filterBatch.replace(/^discovery_/, '')}</span>
            <Link href="/companies" aria-label="Clear batch filter" style={{ color: 'var(--info-ink)' }}>
              ✕
            </Link>
          </span>
        )}
        <div className="ml-auto font-tabular" style={{ color: 'var(--ink-3)' }}>
          {selectedIds.size > 0 ? `${selectedIds.size} selected · ` : ''}{filtered.length} shown
        </div>
      </div>

      <div className="card-soft overflow-x-auto">
        <table className="tbl min-w-full">
          <thead>
            <tr>
              <th className="w-8">
                <input
                  ref={headerCheckboxRef}
                  type="checkbox"
                  aria-label="Select all filtered companies"
                  className="size-3.5 align-middle"
                  style={{ accentColor: 'var(--navy-deep)' }}
                  checked={allFilteredSelected}
                  onChange={toggleAllFiltered}
                />
              </th>
              <th>Company</th>
              <th>Country</th>
              <th>Tier</th>
              <th className="text-right">Pts</th>
              <th className="text-right">Deal prob</th>
              <th>Contact</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(c => {
              const tierStyle = c.icp_tier ? TIER_STYLES[c.icp_tier] : null;
              const statusStyle = COMPANY_STATUS_STYLES[c.status];
              const contact = displayContact(c.contacts);
              const extraContacts = c.contacts.length - 1;
              return (
                <tr key={c.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.company_name}`}
                      className="size-3.5 align-middle"
                      style={{ accentColor: 'var(--navy-deep)' }}
                      checked={selectedIds.has(c.id)}
                      onChange={() => toggleOne(c.id)}
                    />
                  </td>
                  <td>
                    <Link href={`/companies/${c.id}`} className="link-soft font-medium">
                      {c.company_name}
                    </Link>
                    {c.industry && (
                      <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
                        {c.industry}
                      </div>
                    )}
                  </td>
                  <td style={{ color: 'var(--ink-2)' }}>{titleCase(c.country)}</td>
                  <td>
                    {tierStyle && (
                      <span className="pill" style={{ color: tierStyle.ink, background: tierStyle.bg }}>
                        {c.icp_tier}
                      </span>
                    )}
                  </td>
                  <td className="font-tabular text-right" style={{ color: 'var(--ink-2)' }}>
                    {c.icp_score ?? '—'}
                  </td>
                  <td className="font-tabular text-right" style={{ color: 'var(--ink-2)' }}>
                    {c.deal_probability != null ? `${Math.round(c.deal_probability * 100)}%` : '—'}
                  </td>
                  <td>
                    {contact ? (
                      <div>
                        <div style={{ color: 'var(--ink)' }}>
                          {contact.full_name ?? contact.email ?? '—'}
                          {extraContacts > 0 && (
                            <span
                              className="pill ml-1.5"
                              style={{ color: 'var(--muted-ink)', background: 'var(--muted-bg)' }}
                            >
                              +{extraContacts}
                            </span>
                          )}
                        </div>
                        {contact.title && (
                          <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--ink-3)' }}>
                            {contact.title}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-[11.5px] italic" style={{ color: 'var(--ink-4)' }}>
                        no contact
                      </span>
                    )}
                  </td>
                  <td>
                    {statusStyle && (
                      <span className="pill" style={{ color: statusStyle.ink, background: statusStyle.bg }}>
                        {COMPANY_STATUS_LABELS[c.status]}
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    <Link href={`/companies/${c.id}`} className="link-soft text-[12px]">
                      Open →
                    </Link>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="text-center py-10">
                  <span className="empty-note">No companies match these filters.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedCompanies.length > 0 && (
        <GenerateDraftsBar
          selectedCompanies={selectedCompanies}
          templates={templates}
          onDone={() => setSelectedIds(new Set())}
        />
      )}
    </div>
  );
}

function FilterSelect({
  value, onChange, options, all,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { v: string; l: string }[];
  all: string;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="rounded px-2.5 py-1.5 text-[12.5px] border"
      style={{ borderColor: 'var(--line-strong)', background: 'var(--surface)' }}
    >
      <option value="">{all}</option>
      {options.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  );
}
