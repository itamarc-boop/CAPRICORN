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

  return (
    <div>
      <div className="mb-6 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
        <h1
          className="font-display text-[34px] leading-none"
          style={{ color: 'var(--navy-deep)' }}
        >
          Templates
        </h1>
        <p className="mt-2 text-[12.5px]" style={{ color: 'var(--ink-3)' }}>
          Markdown drafts with <span className="font-tabular">{`{{var}}`}</span> placeholders, used by the lead detail page.
        </p>
      </div>
      <TemplatesEditor initial={templates ?? []} />
    </div>
  );
}
