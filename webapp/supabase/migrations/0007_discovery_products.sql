-- Capricorn Lead-Ops: client-editable product catalog. The client edits what they
-- sell in-app (the discovery_products table); the pipeline reads it at run time to
-- drive BOTH discovery keywords (what Explorium searches) and the judge's
-- catalog-fit. The locked ICP scoring math is untouched. Seeded from the proven
-- vertical keywords so day-one behaviour is identical; the client extends from there.
-- Run via: .tmp/apply_supabase_migration.py, supabase db push, or the SQL editor. Idempotent.

create table if not exists discovery_products (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,                 -- product/category, plain language
  keywords   text not null default '',      -- comma-separated discovery search phrases
  active     boolean not null default true, -- include in discovery + catalog
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table discovery_products enable row level security;
drop policy if exists discovery_products_rw on discovery_products;
create policy discovery_products_rw on discovery_products
  for all using (is_allowed_user()) with check (is_allowed_user());

drop trigger if exists trg_discovery_products_updated_at on discovery_products;
create trigger trg_discovery_products_updated_at before update on discovery_products
  for each row execute function touch_updated_at();

-- Seed ONLY if empty (so re-running is safe and never clobbers client edits).
insert into discovery_products (name, keywords, sort)
select v.name, v.keywords, v.sort
from (values
  ('Foodservice disposables', 'foodservice disposables, disposable tableware, disposable cutlery, paper cups, takeaway packaging, catering disposables, disposable packaging importer, disposable packaging distributor', 1),
  ('Pet food', 'pet food importer, pet food distributor, dog food, cat food, pet treats, pet care products distributor', 2),
  ('Cosmetics', 'cosmetics importer, cosmetics distributor, personal care distributor, private label cosmetics, beauty products importer, skincare wholesale', 3),
  ('Wipes', 'wet wipes, baby wipes, nonwoven wipes, wipes importer, wipes distributor', 4),
  ('Membranes & geotextiles', 'geotextile, geomembrane, geosynthetics, waterproofing membrane, breathable membrane, roofing underlay, rock wool insulation, glass wool insulation', 5),
  ('Agriculture (physical inputs)', 'agrotextiles, agricultural plastics, agricultural film, mulch film, anti-hail nets, shade nets, olive nets, drip irrigation tape, greenhouse supplies, grow bags, layflat hose', 6),
  ('Cleaning supplies', 'cleaning products, detergents, cleaning supplies, janitorial products, cleaning supplies distributor, janitorial products distributor', 7)
) as v(name, keywords, sort)
where not exists (select 1 from discovery_products);
