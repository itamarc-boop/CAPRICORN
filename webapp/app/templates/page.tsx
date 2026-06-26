import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';
import TemplatesEditor from './editor';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  await requireAppUser();
  const supabase = await getServerSupabase();
  const { data: templates } = await supabase
    .from('templates')
    .select('id, name, subject_template, body_template, created_at, updated_at')
    .order('updated_at', { ascending: false });

  const rows = templates ?? [];

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
            Templates
          </h1>
          <p className="mt-3 text-[13px]" style={{ color: 'var(--ink-3)' }}>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{rows.length}</span> saved
            <span className="mx-2" style={{ color: 'var(--ink-4)' }}>·</span>
            Markdown drafts with <span className="font-tabular">{`{{var}}`}</span> placeholders, used by the lead detail page.
          </p>
        </div>
      </div>
      <TemplatesEditor initial={rows} />
    </div>
  );
}
