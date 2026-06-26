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

  const runRows = (runs ?? []) as PipelineRun[];
  const activeRuns = runRows.filter(
    (r) => r.status === 'queued' || r.status === 'running',
  ).length;
  const succeededRuns = runRows.filter((r) => r.status === 'succeeded').length;

  return (
    <div>
      <div className="flex items-end justify-between mb-8 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
        <div>
          <div className="micro-label mb-2">Lead Discovery</div>
          <h1 className="font-display text-[40px] leading-none" style={{ color: 'var(--navy-deep)' }}>
            Discover leads
          </h1>
          <p className="mt-3 text-[13px]" style={{ color: 'var(--ink-3)' }}>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{runRows.length}</span> runs
            <span className="mx-2" style={{ color: 'var(--ink-4)' }}>·</span>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{activeRuns}</span> in progress
            <span className="mx-2" style={{ color: 'var(--ink-4)' }}>·</span>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{succeededRuns}</span> delivered
          </p>
        </div>
      </div>
      <DiscoveryPanel initialRuns={runRows} role={appUser.role} />
    </div>
  );
}
