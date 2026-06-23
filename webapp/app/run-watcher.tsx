'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getBrowserSupabase } from '@/lib/supabase/browser';
import { titleCase } from '@/lib/db/types';

/* Layout-level watcher: shows a persistent, dismissible banner when a discovery
   run finishes, so the client can start a run and walk around the app. Lives in
   the layout, so it survives navigation. On mount it seeds the "seen" set with
   already-finished runs, so only runs that finish DURING this session notify. */

type Finished = {
  id: string;
  country: string;
  status: 'succeeded' | 'failed';
  qualified_count: number | null;
  batch_label: string | null;
  crm_synced: boolean | null;
  finished_at: string | null;
};

export default function RunWatcher() {
  const [banner, setBanner] = useState<Finished | null>(null);
  const seenRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);

  const scan = useCallback(async () => {
    const supabase = getBrowserSupabase();
    const { data } = await supabase
      .from('pipeline_runs')
      .select('id, country, status, qualified_count, batch_label, crm_synced, finished_at')
      .in('status', ['succeeded', 'failed'])
      .order('finished_at', { ascending: false })
      .limit(20);
    const rows = (data ?? []) as Finished[];
    if (!seededRef.current) {
      // First pass: mark everything already finished as seen (no banner).
      for (const r of rows) seenRef.current.add(r.id);
      seededRef.current = true;
      return;
    }
    const fresh = rows.filter((r) => !seenRef.current.has(r.id));
    if (fresh.length > 0) {
      for (const r of fresh) seenRef.current.add(r.id);
      setBanner(fresh[0]); // most recently finished
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    const channel = supabase
      .channel('run-watcher')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pipeline_runs' }, () => {
        void scan();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [scan]);

  if (!banner) return null;

  const succeeded = banner.status === 'succeeded';
  const count = banner.qualified_count ?? 0;
  const canReview = succeeded && banner.crm_synced === true && !!banner.batch_label;

  return (
    <div
      className="rise-in flex items-center justify-between gap-3 px-6 py-2.5 text-[13px]"
      style={
        succeeded
          ? { background: 'var(--ok-bg)', color: 'var(--ok-ink)' }
          : { background: 'var(--warn-bg)', color: 'var(--warn-ink)' }
      }
      role="status"
    >
      <span className="min-w-0">
        {succeeded ? (
          <>
            <span className="font-medium">{titleCase(banner.country)} run finished</span>
            {canReview ? ` — ${count} new ${count === 1 ? 'company' : 'companies'}` : ' — delivered to the sheet'}
          </>
        ) : (
          <>
            <span className="font-medium">{titleCase(banner.country)} run didn&rsquo;t finish.</span>{' '}
            You can try again.
          </>
        )}
      </span>
      <span className="flex items-center gap-3 shrink-0">
        {canReview ? (
          <Link
            href={`/companies?batch=${encodeURIComponent(banner.batch_label as string)}`}
            className="font-medium underline"
            onClick={() => setBanner(null)}
          >
            Review →
          </Link>
        ) : (
          <Link href="/discover" className="font-medium underline" onClick={() => setBanner(null)}>
            Open Discover →
          </Link>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setBanner(null)}
          className="opacity-70 hover:opacity-100"
        >
          ✕
        </button>
      </span>
    </div>
  );
}
