import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';
import DraftsQueue, { type QueueDraft } from './drafts-queue';

export const dynamic = 'force-dynamic';

export default async function DraftsPage() {
  await requireAppUser();
  const supabase = await getServerSupabase();
  const { data: drafts, error } = await supabase
    .from('email_drafts')
    .select('*, contacts(id, full_name, title, email), companies(id, company_name, country), templates(id, name)')
    .order('created_at', { ascending: false });

  if (error) {
    return (
      <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load drafts: {error.message}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
        <h1
          className="font-display text-[34px] leading-none"
          style={{ color: 'var(--navy-deep)' }}
        >
          Drafts
        </h1>
        <p className="mt-2 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
          Review, approve, then send the queue from the connected Gmail.
        </p>
      </div>
      <DraftsQueue initialDrafts={(drafts ?? []) as unknown as QueueDraft[]} />
    </div>
  );
}
