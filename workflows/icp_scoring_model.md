# ICP Scoring Model — Capricorn Market Analysis (LOCKED v2)

**Status:** locked v2, 2026-06-10, after iteration-3 client feedback.
Implemented by [`tools/score_company.py`](../tools/score_company.py),
[`tools/research_company_website.py`](../tools/research_company_website.py)
and [`tools/extract_evidence.py`](../tools/extract_evidence.py).
v1 (2026-05-20) is recorded in the decision history below.

This is the deterministic qualification model for the lead-generation
pipeline. It implements the client's requirements plus the iteration-3
recalibration.

## The two ICP axes (iteration-3, client's own words)

1. **"LO MEJOR SON LOS IMPORTADORES CON LOS QUE PUEDA VENDER VOLUMEN"** —
   the best customers IMPORT container volume rather than producing
   everything in-house. A pure manufacturer is a reject ("Fábrica full, no
   importan nada... waste of time"), regardless of product overlap.
2. **"ALGO QUE CALIFICA MUCHO A UNA EMPRESA, ES QUE VENDA SUS MARCAS
   PROPIAS"** — selling OWN brands qualifies a company. Distributors of
   third-party global brands (Eukanuba/Pedigree/Hills class) are rejects;
   niche third-party distributors with product fit are Tier 3, low priority.

Both axes are scored ONLY from the quote-backed `evidence` block produced by
`tools/extract_evidence.py` (LLM extraction over fetched site text + the
Explorium description, any language). **A yes/no verdict without a verbatim
quote is rewritten to unknown** — iteration 3's "Claude dice que importan pq
su range es muy grande, pero sin un claim real" can't happen again. A wide
product range is NOT import evidence.

## Decisions on record (v2, 2026-06-10)

1. **Tier model = score bands + evidence caps.** One 0–100 score; the tier is
   the score band, then capped by evidence completeness. The ONLY path to
   Tier 1 is quoted evidence of imports AND own brand AND core catalog fit.
2. **The v1 warehouse and private-label hard gates are demoted.** Warehouse
   never resolved from public sites (`volume_signals` supersedes it; now a
   flag only). Third-party-brand reselling is a Tier-3 cap, not a drop
   (Harpo precedent: "podría ser interesante" — deliver as T3, clearly
   flagged; the BDR judge rejects global-brand distributors).
3. **New hard gates:** dead website (iteration 3 delivered a company whose
   domain doesn't resolve); pure manufacturer with quote-backed "does not
   import".
4. **Qualifying cutoffs unchanged:** Tier 1 ≥ 70, Tier 2 45–69, Tier 3
   25–44, below 25 dropped.
5. **Keyword/industry-token scoring removed.** It scored keyword
   co-occurrence — which delivered food distributors as "foodservice
   disposables" and a coco-substrate factory as "agriculture", and gave
   manufacturers the same credit as importers. Product fit is now the
   extractor's `catalog_fit` judged on the company's CORE business.

## Pipeline position

```
explorium records
  -> research_company_website.py --records   (fetch, site_status, page text)
  -> extract_evidence.py                     (LLM, quote-backed evidence block)
  -> [uk_importers_lookup.py]                (free HMRC import evidence, UK only)
  -> score_company.py                        (this model)
  -> [verify_import_evidence.py]             (web-search upgrades for shortlist)
  -> bdr_judge.py                            (playbook verdict, may promote/reject)
```

## Stage 0 — Hard gates

A company that fails **any** gate is dropped, with a reason, and is not scored.

**Exclusion gates (client doc + Spain-pilot calibration):**

- Exclusively-retail company · Government body · Pure cosmetic-packaging company
- Named top retailer (ALDI, Carrefour, LIDL, …)
- Under 10 / over 2,000 employees
- Out-of-scope industry (agencies, software, hospitality, finance, …)
- Blacklisted keyword (agrochemicals, fragrance, ingredient suppliers, …)
- Outside the 8 target countries

**Exclusion gates (added v2):**

- `site_status == dead` — DNS/SSL failure, connection refused, homepage
  404/410 (Geomembrane Bresciani case)
- `manufacturer == yes` AND `imports == no` — pure manufacturer, quote-backed
  no-import (TATAY case)

## Stage 1 — Score (gate-passers only, 100 points)

| Criterion | Max | Rule |
|---|---|---|
| Import evidence (Axis A) | 30 | 30 — `imports == yes` (quoted) · 10 — unknown but business_model is importer/distributor · 0 — unknown or no |
| Own brand (Axis B) | 25 | 25 — `own_brand == yes` (quoted), no third-party lines · 12 — own brand + also carries third-party lines · 0 — no or unknown |
| Core-business catalog fit | 25 | 25 — `catalog_fit == core` · 10 — `adjacent` · 0 — `none` |
| Target country | 10 | 10 — in a target country · 0 otherwise |
| Size | 10 | 5 — employees 30–500 (2 stretch 10–30 / 500–1,000) + 5 — revenue $20–200M (2 stretch $5–20M / $200–400M) |

**Target countries (with priority):** Spain, UK, Italy, Israel (High);
Germany (Medium-High); Switzerland, Romania, Greece (Medium).

## Stage 2 — Tier from score, then evidence caps

| Score | Tier |
|---|---|
| ≥ 70 | Tier 1 |
| 45–69 | Tier 2 |
| 25–44 | Tier 3 |
| < 25 | dropped, never shown |

**Tier caps (applied after banding; every binding cap adds a flag saying
exactly what evidence is missing):**

| Condition | Cap |
|---|---|
| `imports == yes` AND `own_brand == yes` (both quoted) AND `catalog_fit == core` | Tier 1 eligible — the only path to T1 |
| `imports` or `own_brand` unknown | Tier 2 max + needs human check |
| `catalog_fit == adjacent` | Tier 2 max |
| `catalog_fit == none` | Tier 3 max |
| `manufacturer == yes` AND `imports == unknown` | Tier 3 max + needs human check |
| `own_brand == no` (third-party reseller with fit) | Tier 3 max + "third-party brand reseller — low priority" |
| `site_status == unreachable` (timeout / bot-blocked) | Tier 3 max |

The BDR judge runs after this and may promote an evidenced candidate
(e.g. manufacturer-distributor with quoted import motion + own brand, the
INTERMAS/MONGE class) or reject — but `bdr_judge.py` has a deterministic
backstop: a `t1` verdict without `imports == yes` AND `own_brand == yes` is
rewritten to `t2`. No unevidenced T1 can ship.

Output order: tier, then country priority (High → Medium-High → Medium),
then score descending.

## Edge cases / conventions

- **Unknown firmographic** (employee count, revenue) → criterion scores 0;
  never dropped for missing data. Missing employee count also means the size
  gate cannot be applied — flagged.
- **Missing `evidence` block** (extraction failed) → all axes unknown →
  Tier 2 cap at best, usually Tier 3; the pre-ship audit fails the run if
  the evidence success rate is under 90%.
- The fuzzy exclusions (`exclusively retail`, `government`, `cosmetic
  packaging`) are best set as explicit booleans by the enrichment step; the
  scorer also does a best-effort text check.

## Calibration log

**2026-06-10 — v2, iteration-3 feedback (25 labelled companies):**
- Of 5 delivered T1s the client rejected 4 → rebuilt the model around the
  importer + own-brand axes above.
- Root cause found: iteration 3's ad-hoc research runner crashed for 100% of
  records (`'str' object has no attribute 'get'`) — every gate resolved
  unknown and the run shipped anyway. Research now has a batch CLI that
  exits non-zero on >25% failure, and the pre-ship audit checks evidence
  health ≥ 90%.
- English-only regex detection replaced by multilingual LLM extraction
  (sites are ES/IT/DE/HE).
- Validation on the 25 known answers: zero client-rejects reach T1
  deterministically; Bresciani dropped (dead site); Villa de Pego capped
  T3 with "missing imports evidence" flag.

**2026-05-20 — v1, Spain pilot (10 enriched companies):**
- Added out-of-scope-industry and target-country gates.
- `warehouse` almost always resolves `unknown` → led to the v2 demotion.

## Pending before a live run

- Google OAuth `credentials.json` / `token.json` (output Sheet) — deferred
