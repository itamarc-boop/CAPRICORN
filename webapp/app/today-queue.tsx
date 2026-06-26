'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { titleCase } from '@/lib/db/types';

/* The Home "Today" work queue: the actual items needing a decision, with the
   action available inline. Reuses the compare-and-swap write pattern from
   app/drafts/drafts-queue.tsx so a stale UI can never revert a draft's state. */

type DraftItem = {
  id: string;
  subject: string | null;
  status: string;
  company_id: string | null;
  contact_id: string | null;
  created_at: string;
  companies: { company_name: string } | null;
  contacts: { full_name: string | null; email: string | null } | null;
};

type ReplyItem = {
  id: string;
  company_name: string;
  country: string | null;
  status_changed_at: string;
};

const SHOWN = 6;

export default function TodayQueue() {
  const [drafts, setDrafts] = useState<DraftItem[]>([]);
  const [replies, setReplies] = useState<ReplyItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const userIdRef = useRef<string | null>(null);

  useEffect(() => {
    void getBrowserSupabase()
      .auth.getUser()
      .then(({ data }) => {
        userIdRef.current = data.user?.id ?? null;
      });
  }, []);

  const refetch = useCallback(async () => {
    const supabase = getBrowserSupabase();
    const [draftsRes, repliesRes] = await Promise.all([
      supabase
        .from('email_drafts')
        .select(
          'id, subject, status, company_id, contact_id, created_at, companies(company_name), contacts(full_name, email)'
        )
        .in('status', ['draft', 'failed'])
        .order('created_at', { ascending: false }),
      supabase
        .from('companies')
        .select('id, company_name, country, status_changed_at')
        .eq('status', 'replied')
        .order('status_changed_at', { ascending: false }),
    ]);
    setDrafts((draftsRes.data ?? []) as unknown as DraftItem[]);
    setReplies((repliesRes.data ?? []) as unknown as ReplyItem[]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Realtime: the queue reflects approvals/sends/replies as they happen.
  useEffect(() => {
    const supabase = getBrowserSupabase();
    const channel = supabase
      .channel('today-queue')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'email_drafts' }, () => {
        void refetch();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'companies' }, () => {
        void refetch();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [refetch]);

  const toReview = drafts.filter((d) => d.status === 'draft');
  const failed = drafts.filter((d) => d.status === 'failed');

  async function approve(id: string) {
    setBusyId(id);
    setError(null);
    const supabase = getBrowserSupabase();
    const { data, error: err } = await supabase
      .from('email_drafts')
      .update({
        status: 'approved',
        approved_at: new Date().toISOString(),
        approved_by: userIdRef.current,
        scheduled_at: null,
        send_attempts: 0,
      })
      .eq('id', id)
      .eq('status', 'draft')
      .select('id');
    setBusyId(null);
    if (err) {
      setError(err.message);
      return;
    }
    if (!data || data.length === 0) {
      setError('That draft changed elsewhere. Refreshed.');
    }
    await refetch();
  }

  async function requeue(id: string) {
    setBusyId(id);
    setError(null);
    const supabase = getBrowserSupabase();
    const { data, error: err } = await supabase
      .from('email_drafts')
      .update({
        status: 'approved',
        scheduled_at: new Date().toISOString(),
        error: null,
        send_attempts: 0,
      })
      .eq('id', id)
      .eq('status', 'failed')
      .select('id');
    setBusyId(null);
    if (err) {
      setError(err.message);
      return;
    }
    if (!data || data.length === 0) {
      setError('That draft changed elsewhere. Refreshed.');
    }
    await refetch();
  }

  const nothing = loaded && toReview.length === 0 && replies.length === 0 && failed.length === 0;

  return (
    <section className="mb-10">
      <div className="section-head mb-4">
        <h2 className="section-title">Today</h2>
        <Link href="/drafts" className="link-soft text-[12.5px]">
          All drafts →
        </Link>
      </div>

      {error && (
        <div
          className="mb-3 rounded px-3.5 py-2.5 text-[12.5px]"
          style={{ background: 'var(--warn-bg)', color: 'var(--warn-ink)' }}
        >
          {error}
        </div>
      )}

      {nothing ? (
        <div className="card-soft p-6 text-center">
          <p className="text-[13.5px]" style={{ color: 'var(--ink-2)' }}>
            You&rsquo;re all caught up. Nothing waiting for a decision right now.
          </p>
          <Link href="/discover" className="btn-primary text-[13px] inline-block mt-4">
            Get new leads
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Drafts to review — inline Approve */}
          <QueueColumn label="Drafts to review" count={toReview.length} accent="var(--info-ink)">
            {toReview.slice(0, SHOWN).map((d) => (
              <QueueRow key={d.id}>
                <div className="min-w-0">
                  <CompanyLink id={d.company_id} name={d.companies?.company_name} />
                  <div className="text-[11.5px] truncate mt-0.5" style={{ color: 'var(--ink-3)' }}>
                    {d.contacts?.full_name ?? d.contacts?.email ?? 'contact'}
                    {d.subject ? ` · ${d.subject}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void approve(d.id)}
                  disabled={busyId === d.id}
                  className="btn-primary text-[12px] shrink-0"
                >
                  {busyId === d.id ? '…' : 'Approve'}
                </button>
              </QueueRow>
            ))}
            <MoreLink count={toReview.length} />
          </QueueColumn>

          {/* Replies to chase — open the dossier */}
          <QueueColumn label="Replies to chase" count={replies.length} accent="var(--ok-ink)">
            {replies.slice(0, SHOWN).map((r) => (
              <QueueRow key={r.id}>
                <div className="min-w-0">
                  <CompanyLink id={r.id} name={r.company_name} />
                  <div className="text-[11.5px] truncate mt-0.5" style={{ color: 'var(--ink-3)' }}>
                    {r.country ? titleCase(r.country) : ''}
                  </div>
                </div>
                <Link href={`/companies/${r.id}`} className="link-soft text-[12px] shrink-0">
                  Open →
                </Link>
              </QueueRow>
            ))}
            <MoreLink count={replies.length} />
          </QueueColumn>

          {/* Failed sends — inline Requeue */}
          <QueueColumn label="Failed sends" count={failed.length} accent="var(--danger-ink)">
            {failed.slice(0, SHOWN).map((d) => (
              <QueueRow key={d.id}>
                <div className="min-w-0">
                  <CompanyLink id={d.company_id} name={d.companies?.company_name} />
                  <div className="text-[11.5px] truncate mt-0.5" style={{ color: 'var(--ink-3)' }}>
                    {d.subject ?? 'email'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void requeue(d.id)}
                  disabled={busyId === d.id}
                  className="btn-ghost text-[12px] shrink-0"
                >
                  {busyId === d.id ? '…' : 'Requeue'}
                </button>
              </QueueRow>
            ))}
            <MoreLink count={failed.length} />
          </QueueColumn>
        </div>
      )}
    </section>
  );
}

function QueueColumn({
  label,
  count,
  accent,
  children,
}: {
  label: string;
  count: number;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card-soft p-4" style={{ borderTop: `2px solid ${accent}` }}>
      <div className="flex items-baseline justify-between mb-2.5">
        <div className="micro-label flex items-center gap-1.5">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: accent }}
            aria-hidden
          />
          {label}
        </div>
        <div className="font-tabular text-[13px]" style={{ color: 'var(--ink-3)' }}>
          {count}
        </div>
      </div>
      {count === 0 ? (
        <p className="empty-note">Nothing here.</p>
      ) : (
        <ul className="space-y-0.5">{children}</ul>
      )}
    </div>
  );
}

function QueueRow({ children }: { children: React.ReactNode }) {
  return (
    <li className="row-hover -mx-2 flex items-center gap-2 rounded px-2 py-1.5">{children}</li>
  );
}

function CompanyLink({ id, name }: { id: string | null; name: string | null | undefined }) {
  const label = name ?? 'Company';
  if (!id) {
    return (
      <div className="text-[13px] font-medium truncate" style={{ color: 'var(--ink)' }}>
        {label}
      </div>
    );
  }
  return (
    <Link href={`/companies/${id}`} className="link-soft text-[13px] font-medium truncate block">
      {label}
    </Link>
  );
}

function MoreLink({ count }: { count: number }) {
  if (count <= SHOWN) return null;
  return (
    <li className="pt-1">
      <Link href="/drafts" className="link-soft text-[12px]">
        +{count - SHOWN} more →
      </Link>
    </li>
  );
}
