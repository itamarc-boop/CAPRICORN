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

  const products = (data ?? []) as Product[];
  const activeCount = products.filter((p) => p.active).length;

  return (
    <div className="max-w-3xl">
      <div className="flex items-end justify-between mb-8 pb-5 border-b" style={{ borderColor: 'var(--line)' }}>
        <div>
          <div className="micro-label mb-2">Catalog</div>
          <h1 className="font-display text-[40px] leading-none" style={{ color: 'var(--navy-deep)' }}>
            Products
          </h1>
          <p className="mt-3 text-[13px]" style={{ color: 'var(--ink-3)' }}>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{products.length}</span> products
            <span className="mx-2" style={{ color: 'var(--ink-4)' }}>·</span>
            <span className="font-tabular" style={{ color: 'var(--ink)' }}>{activeCount}</span> active in discovery
          </p>
        </div>
      </div>
      <p className="mb-6 text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-3)' }}>
        What you sell. Each run searches for companies that import and distribute these,
        and the research judges every lead on how well it fits your range. Add, edit, or
        switch products off and the next discovery run adapts automatically.
      </p>
      <ProductsEditor initial={products} />
    </div>
  );
}
