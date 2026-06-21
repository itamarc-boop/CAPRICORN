'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { TIER_STYLES } from '@/lib/db/types';

/**
 * Global ⌘K search across companies and contacts. Reads go through RLS via
 * the browser Supabase client. Debounced 250ms, ≥2 chars; stale responses
 * are discarded via a sequence counter.
 */

type CompanyHit = {
  id: string;
  company_name: string;
  country: string | null;
  icp_tier: string | null;
};

type ContactHit = {
  id: string;
  full_name: string | null;
  email: string | null;
  company_id: string;
  companies:
    | { company_name: string | null }
    | { company_name: string | null }[]
    | null;
};

function contactCompanyName(hit: ContactHit): string | null {
  if (!hit.companies) return null;
  if (Array.isArray(hit.companies)) return hit.companies[0]?.company_name ?? null;
  return hit.companies.company_name;
}

export default function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [companies, setCompanies] = useState<CompanyHit[]>([]);
  const [contacts, setContacts] = useState<ContactHit[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const seqRef = useRef(0);

  // ⌘K / Ctrl+K focuses the search input from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Outside click closes the dropdown.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // Debounced parallel search.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setCompanies([]);
      setContacts([]);
      setActiveIdx(-1);
      setOpen(false);
      setLoading(false);
      seqRef.current += 1; // invalidate any in-flight request
      return;
    }
    setLoading(true);
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      try {
        const supabase = getBrowserSupabase();
        // Commas/parens would break the .or() filter grammar — neutralize.
        const safe = q.replace(/[,()]/g, ' ').trim();
        const [companiesRes, contactsRes] = await Promise.all([
          supabase
            .from('companies')
            .select('id, company_name, country, icp_tier')
            .ilike('company_name', `%${q}%`)
            .limit(6),
          supabase
            .from('contacts')
            .select('id, full_name, email, company_id, companies(company_name)')
            .or(`full_name.ilike.%${safe}%,email.ilike.%${safe}%`)
            .limit(6),
        ]);
        if (seq !== seqRef.current) return; // stale — a newer query is running
        setCompanies((companiesRes.data as CompanyHit[] | null) ?? []);
        setContacts((contactsRes.data as unknown as ContactHit[] | null) ?? []);
        setActiveIdx(-1);
        setLoading(false);
        setOpen(true);
      } catch {
        if (seq !== seqRef.current) return;
        setCompanies([]);
        setContacts([]);
        setActiveIdx(-1);
        setLoading(false);
        setOpen(true);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const go = (path: string) => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
    router.push(path);
  };

  // Flattened option order matches render order: companies, then contacts.
  const options = [
    ...companies.map((c) => ({
      id: `gs-opt-company-${c.id}`,
      path: `/companies/${c.id}`,
    })),
    ...contacts.map((p) => ({
      id: `gs-opt-contact-${p.id}`,
      path: `/companies/${p.company_id}`,
    })),
  ];

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    } else if (e.key === 'ArrowDown' && open && options.length > 0) {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % options.length);
    } else if (e.key === 'ArrowUp' && open && options.length > 0) {
      e.preventDefault();
      setActiveIdx((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      const target = activeIdx >= 0 ? options[activeIdx] : options[0];
      if (target) go(target.path);
    }
  };

  const hasResults = companies.length > 0 || contacts.length > 0;

  return (
    <div ref={rootRef} className="relative w-full max-w-md">
      <div className="relative">
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--ink-4)]"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="global-search-results"
          aria-autocomplete="list"
          aria-activedescendant={
            open && activeIdx >= 0 ? options[activeIdx]?.id : undefined
          }
          aria-label="Search companies and contacts"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search companies and contacts…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (query.trim().length >= 2 && hasResults) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          className="w-full rounded-[5px] border border-[color:var(--line-strong)] bg-[color:var(--surface)] py-[6px] pl-9 pr-12 text-[13px]"
        />
        <kbd className="kbd-hint absolute right-2.5 top-1/2 -translate-y-1/2">
          ⌘K
        </kbd>
      </div>

      {open ? (
        <div
          id="global-search-results"
          role="listbox"
          aria-label="Search results"
          className="card-soft rise-in absolute left-0 right-0 top-full z-50 mt-1.5 max-h-[420px] overflow-y-auto py-1"
        >
          {loading && !hasResults ? (
            <p className="px-3 py-2.5 text-[13px] text-[color:var(--ink-3)]">
              Searching…
            </p>
          ) : !hasResults ? (
            <p className="px-3 py-2.5 text-[13px] text-[color:var(--ink-3)]">
              No matches
            </p>
          ) : (
            <>
              {companies.length > 0 ? (
                <div role="group" aria-label="Companies">
                  <p className="micro-label px-3 pb-1 pt-2 text-[color:var(--ink-4)]">
                    Companies
                  </p>
                  {companies.map((c, idx) => {
                    const tier = c.icp_tier ? TIER_STYLES[c.icp_tier] : null;
                    const selected = activeIdx === idx;
                    return (
                      <button
                        key={c.id}
                        id={`gs-opt-company-${c.id}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => go(`/companies/${c.id}`)}
                        className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[color:var(--surface-2)] ${
                          selected ? 'bg-[color:var(--surface-2)]' : ''
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--ink)]">
                          {c.company_name}
                        </span>
                        {c.country ? (
                          <span
                            className="pill shrink-0"
                            style={{
                              color: 'var(--muted-ink)',
                              background: 'var(--muted-bg)',
                            }}
                          >
                            {c.country}
                          </span>
                        ) : null}
                        {c.icp_tier ? (
                          <span
                            className="pill shrink-0"
                            style={{
                              color: tier?.ink ?? 'var(--t3-ink)',
                              background: tier?.bg ?? 'var(--t3-bg)',
                            }}
                          >
                            {c.icp_tier}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {contacts.length > 0 ? (
                <div role="group" aria-label="Contacts">
                  <p className="micro-label px-3 pb-1 pt-2 text-[color:var(--ink-4)]">
                    Contacts
                  </p>
                  {contacts.map((p, idx) => {
                    const companyName = contactCompanyName(p);
                    const selected = activeIdx === companies.length + idx;
                    return (
                      <button
                        key={p.id}
                        id={`gs-opt-contact-${p.id}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => go(`/companies/${p.company_id}`)}
                        className={`flex w-full items-baseline gap-2 px-3 py-2 text-left transition-colors hover:bg-[color:var(--surface-2)] ${
                          selected ? 'bg-[color:var(--surface-2)]' : ''
                        }`}
                      >
                        <span className="min-w-0 truncate text-[13px] text-[color:var(--ink)]">
                          {p.full_name || p.email || 'Unnamed contact'}
                        </span>
                        {p.email && p.full_name ? (
                          <span className="min-w-0 truncate text-[12px] text-[color:var(--ink-4)]">
                            · {p.email}
                          </span>
                        ) : null}
                        {companyName ? (
                          <span className="ml-auto shrink-0 text-[11px] italic text-[color:var(--ink-4)]">
                            {companyName}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
