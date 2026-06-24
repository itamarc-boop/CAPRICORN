import { requireAppUser } from '@/lib/auth/allowlist';
import { getServerSupabase } from '@/lib/supabase/server';
import ProductsEditor, { type Product } from './products-editor';

export const dynamic = 'force-dynamic';

export default async function ProductsPage() {
  await requireAppUser();
  const supabase = await getServerSupabase();
  const { data } = await supabase
    .from('discovery_products')
    .select('id, name, keywords, active, sort')
    .order('sort')
    .order('created_at');

  return (
    <div className="max-w-3xl">
      <div className="mb-6 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
        <h1 className="font-display text-[34px] leading-none" style={{ color: 'var(--navy-deep)' }}>
          Products
        </h1>
        <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-3)' }}>
          What you sell. Each run searches for companies that import and distribute these,
          and the research judges every lead on how well it fits your range. Add, edit, or
          switch products off and the next discovery run adapts automatically.
        </p>
      </div>
      <ProductsEditor initial={(data ?? []) as Product[]} />
    </div>
  );
}
