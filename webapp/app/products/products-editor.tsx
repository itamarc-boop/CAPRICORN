'use client';

import { useCallback, useState } from 'react';
import { getBrowserSupabase } from '@/lib/supabase/browser';

export type Product = {
  id: string;
  name: string;
  keywords: string;
  active: boolean;
  sort: number;
};

export default function ProductsEditor({ initial }: { initial: Product[] }) {
  const [products, setProducts] = useState<Product[]>(initial);
  const [newName, setNewName] = useState('');
  const [newKeywords, setNewKeywords] = useState('');
  const [adding, setAdding] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    const { data } = await getBrowserSupabase()
      .from('discovery_products')
      .select('id, name, keywords, active, sort')
      .order('sort')
      .order('created_at');
    if (data) setProducts(data as Product[]);
  }, []);

  async function addProduct() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    setError(null);
    const maxSort = products.reduce((m, p) => Math.max(m, p.sort), 0);
    const { error: err } = await getBrowserSupabase()
      .from('discovery_products')
      .insert({ name, keywords: newKeywords.trim(), active: true, sort: maxSort + 1 });
    setAdding(false);
    if (err) {
      setError(err.message);
      return;
    }
    setNewName('');
    setNewKeywords('');
    await refetch();
  }

  async function suggestKeywords() {
    const name = newName.trim();
    if (!name) {
      setError('Type the product name first, then I can suggest search terms.');
      return;
    }
    setSuggesting(true);
    setError(null);
    try {
      const res = await fetch('/api/products/suggest-keywords', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (res.ok && data.keywords) {
        setNewKeywords((cur) => (cur.trim() ? `${cur.trim()}, ${data.keywords}` : data.keywords));
      } else {
        setError(data.error || 'Could not suggest search terms.');
      }
    } catch {
      setError('Network error while suggesting search terms.');
    } finally {
      setSuggesting(false);
    }
  }

  async function saveField(id: string, patch: Partial<Product>) {
    const { error: err } = await getBrowserSupabase()
      .from('discovery_products')
      .update(patch)
      .eq('id', id);
    if (err) setError(err.message);
  }

  async function removeProduct(id: string, name: string) {
    if (!confirm(`Remove "${name}"? Future runs will stop searching for it.`)) return;
    setError(null);
    const { error: err } = await getBrowserSupabase()
      .from('discovery_products')
      .delete()
      .eq('id', id);
    if (err) {
      setError(err.message);
      return;
    }
    setProducts((cur) => cur.filter((p) => p.id !== id));
  }

  function patchLocal(id: string, patch: Partial<Product>) {
    setProducts((cur) => cur.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }

  return (
    <div>
      {error && (
        <div
          className="mb-4 rounded px-3 py-2 text-[12.5px]"
          style={{ background: 'var(--warn-bg)', color: 'var(--warn-ink)' }}
        >
          {error}
        </div>
      )}

      {/* Add a product */}
      <div className="card-soft p-4 mb-6">
        <div className="section-head mb-4">
          <h2 className="section-title">Add a product</h2>
        </div>
        <div className="space-y-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Reusable coffee cups"
            className="w-full rounded-md px-3 py-2 text-[13px] border"
            style={{ borderColor: 'var(--line)' }}
          />
          <div className="flex items-start gap-2">
            <textarea
              value={newKeywords}
              onChange={(e) => setNewKeywords(e.target.value)}
              placeholder="Search terms, comma-separated, or let AI suggest them"
              rows={2}
              className="flex-1 rounded-md px-3 py-2 text-[13px] border resize-y"
              style={{ borderColor: 'var(--line)' }}
            />
            <button
              type="button"
              onClick={suggestKeywords}
              disabled={suggesting}
              className="btn-ghost text-[12.5px] whitespace-nowrap"
            >
              {suggesting ? 'Thinking…' : 'Suggest search terms'}
            </button>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-[11.5px]" style={{ color: 'var(--ink-3)' }}>
              Search terms are what we match against importers and distributors. Keep them specific.
            </p>
            <button
              type="button"
              onClick={addProduct}
              disabled={adding || !newName.trim()}
              className="btn-primary text-[13px]"
            >
              {adding ? 'Adding…' : 'Add product'}
            </button>
          </div>
        </div>
      </div>

      {/* Existing products */}
      <div className="space-y-3">
        {products.length === 0 && (
          <p className="empty-note">
            No products yet. Add what you sell above and the next run will search for it.
          </p>
        )}
        {products.map((p) => (
          <div key={p.id} className="card-soft p-4" style={{ opacity: p.active ? 1 : 0.55 }}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <input
                value={p.name}
                onChange={(e) => patchLocal(p.id, { name: e.target.value })}
                onBlur={(e) => saveField(p.id, { name: e.target.value.trim() })}
                className="flex-1 font-medium text-[14px] bg-transparent outline-none"
                style={{ color: 'var(--navy-deep)' }}
              />
              <div className="flex items-center gap-3 shrink-0">
                <label className="flex items-center gap-1.5 text-[12px] cursor-pointer" style={{ color: 'var(--ink-3)' }}>
                  <input
                    type="checkbox"
                    checked={p.active}
                    onChange={(e) => {
                      patchLocal(p.id, { active: e.target.checked });
                      void saveField(p.id, { active: e.target.checked });
                    }}
                  />
                  Active
                </label>
                <button
                  type="button"
                  onClick={() => removeProduct(p.id, p.name)}
                  className="btn-unlink"
                >
                  Remove
                </button>
              </div>
            </div>
            <textarea
              value={p.keywords}
              onChange={(e) => patchLocal(p.id, { keywords: e.target.value })}
              onBlur={(e) => saveField(p.id, { keywords: e.target.value.trim() })}
              rows={2}
              className="w-full rounded-md px-3 py-2 text-[12.5px] border resize-y"
              style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
