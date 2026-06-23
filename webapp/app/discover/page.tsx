import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';
import { type PipelineRun } from '@/lib/db/types';
import DiscoveryPanel from './discovery-panel';

export const dynamic = 'force-dynamic';

export default async function DiscoverPage() {
  const appUser = await requireAppUser();
  const supabase = await getServerSupabase();
  const { data: runs, error } = await supabase
    .from('pipeline_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(40);

  if (error) {
    return (
      <div
        className="rounded px-3.5 py-2.5 text-[12.5px]"
        style={{ background: 'var(--warn-bg)', color: 'var(--warn-ink)' }}
      >
        Failed to load discovery runs: {error.message}
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
          Discover leads
        </h1>
        <p className="mt-2 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
          Find new importer and distributor leads in any market. A run takes a few minutes
          and adds new companies to your pipeline that you can email right away.
        </p>
      </div>
      <DiscoveryPanel initialRuns={(runs ?? []) as PipelineRun[]} role={appUser.role} />
    </div>
  );
}
