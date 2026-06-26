import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';
import { DRAFT_LIST_SELECT } from '@/lib/db/types';
import DraftsQueue, { type QueueDraft } from './drafts-queue';

export const dynamic = 'force-dynamic';

export default async function DraftsPage() {
  await requireAppUser();
  const supabase = await getServerSupabase();
  const { data: drafts, error } = await supabase
    .from('email_drafts')
    .select(DRAFT_LIST_SELECT)
    .order('created_at', { ascending: false });

  if (error) {
    return (
      <div
        className="rounded p-4 text-[13px]"
        style={{ background: 'var(--danger-bg)', color: 'var(--danger-ink)' }}
      >
        Failed to load drafts: {error.message}
      </div>
    );
  }

  const rows = (drafts ?? []) as unknown as QueueDraft[];
  const toReviewCount = rows.filter((d) => d.status === 'draft').length;
  const approvedCount = rows.filter((d) => d.status === 'approved').length;
  const sentCount = rows.filter((d) => d.status === 'sent').length;

  return (
    <div>
      <div
        className="flex items-end justify-between mb-8 pb-5 border-b"
        style={{ borderColor: 'var(--line)' }}
      >
        <div>
          <div className="micro-label mb-2">Outreach</div>
          <h1
            className="font-display text-[40px] leading-none"
            style={{ color: 'var(--navy-deep)' }}
          >
            Drafts
          </h1>
          <p className="mt-3 text-[13px]" style={{ color: 'var(--ink-3)' }}>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{toReviewCount}</span> to review
            <span className="mx-2" style={{ color: 'var(--ink-4)' }}>·</span>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{approvedCount}</span> queued
            <span className="mx-2" style={{ color: 'var(--ink-4)' }}>·</span>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{sentCount}</span> sent
          </p>
        </div>
      </div>
      <DraftsQueue initialDrafts={rows} />
    </div>
  );
}
