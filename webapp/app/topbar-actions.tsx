'use client';
import { useCallback, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { getBrowserSupabase } from '@/lib/supabase/browser';

/* The two recurring session verbs, surfaced globally (topbar) and echoed on the
   Home header. "Send approved (N)" acts in place: it opens a confirm and fires
   the paced send-queue (/api/send-queue/start) without leaving the page.
   Mirrors startQueue() in app/drafts/drafts-queue.tsx. */

export default function TopbarActions() {
  const [approved, setApproved] = useState(0);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);
  // Unique per instance — rendered in both the topbar and the Home header, and
  // Supabase dedupes channels by name (collision throws on the second .on()).
  const channelId = useId();

  const refetch = useCallback(async () => {
    const supabase = getBrowserSupabase();
    const { count } = await supabase
      .from('email_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'approved');
    setApproved(count ?? 0);
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    const supabase = getBrowserSupabase();
    const channel = supabase
      .channel(`topbar-approved-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'email_drafts' }, () => {
        void refetch();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [refetch, channelId]);

  async function startQueue() {
    setStarting(true);
    setNotice(null);
    try {
      const res = await fetch('/api/send-queue/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setNotice({ kind: 'warn', text: data.error || 'Could not start sending.' });
      } else {
        const mins =
          typeof data.estimated_seconds === 'number'
            ? Math.max(1, Math.ceil(data.estimated_seconds / 60))
            : Math.max(1, Math.ceil(data.queued));
        setNotice({
          kind: 'ok',
          text: `Queued ${data.queued} emails — about one per minute (~${mins} min).`,
        });
        await refetch();
      }
    } catch (e) {
      setNotice({ kind: 'warn', text: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setStarting(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Link href="/discover" className="btn-ghost text-[12.5px] whitespace-nowrap">
        Get new leads
      </Link>
      {approved > 0 && (
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="btn-primary text-[12.5px] whitespace-nowrap"
        >
          Send approved ({approved})
        </button>
      )}

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: 'rgba(15, 46, 58, 0.35)' }}
        >
          <div className="card-soft rise-in w-full max-w-md p-5">
            <div className="micro-label mb-2">Send approved emails</div>
            <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--ink)' }}>
              Send the <span className="font-tabular">{approved}</span> approved{' '}
              {approved === 1 ? 'email' : 'emails'}? They go out automatically at about one per
              minute so they look natural.
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
                onClick={() => void startQueue()}
                disabled={starting}
                className="btn-primary text-[13px]"
              >
                {starting ? 'Starting…' : 'Send them'}
              </button>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <div
          className="rise-in fixed bottom-4 right-4 z-50 max-w-sm rounded px-3.5 py-2.5 text-[12.5px] shadow"
          style={
            notice.kind === 'ok'
              ? { background: 'var(--ok-bg)', color: 'var(--ok-ink)' }
              : { background: 'var(--warn-bg)', color: 'var(--warn-ink)' }
          }
          role="status"
          onClick={() => setNotice(null)}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}
