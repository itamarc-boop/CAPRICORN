# Workflow: BDR Judge (LLM Tier Override)

**Objective:** After deterministic scoring, run a Claude-powered "senior BDR"
judgment over every gate-passing candidate. The judge applies the client's
qualitative playbook (extracted from his annotated feedback) and returns a
verdict that can keep, downgrade, or reject a company — and pre-populates the
"what Capricorn could sell them" gap analysis on the lead row.

**Why this exists:** The deterministic score in `tools/score_company.py` is
sound for firmographics (size, revenue, geography, industry-keyword match) but
cannot capture business-model and supply-chain judgment. Iteration-1 client
review showed ~40% of T1 leads failed those qualitative checks — agrochemicals
mislabelled as agriculture, DTC-only producers scored as importers, ultra-
premium brands scored as commodity buyers, direct competitors not excluded.

**Status:** v2, 2026-06-10, after Iteration-3 feedback. The judge is now
EVIDENCE-GATED: it reads the quote-backed `evidence` block from
`tools/extract_evidence.py` and may not assert importing or own-brand status
without it. Iteration 3 shipped "Claude dice que importan pq su range es muy
grande, pero sin un claim real" — the client caught it. Two protections:

1. The prompt's hard evidence rules: t1 requires quoted imports + own-brand
   evidence; pure manufacturer with a read site and no import signals =
   reject; absence of evidence (no evidence block / unreachable site) is NOT
   evidence of absence — t3 + verification flag, never reject on suspicion.
2. A deterministic backstop in `judge_all()`: a t1 verdict without
   `imports == yes` AND `own_brand == yes` AND non-empty `evidence_citations`
   is rewritten to t2 with flag `auto-downgraded-t1-missing-evidence`.
   The LLM cannot ship an unevidenced T1 even if it tries.

Few-shot labels load from ALL `feedback/iteration_*_labels.json` files
(FEW_SHOT_COUNT 28, one example per distinct pattern first); the canonical
patterns/verdicts/notes stay in `iteration_1_labels.json`.

---

## Required inputs

| Input | Notes |
|---|---|
| `candidate` | Full company record: firmographics + `website_research` + `score` |
| `playbook` | Compiled from `feedback/iteration_<N>_labels.json` — the `patterns` block plus `global_notes` |
| `examples` | 6–10 few-shot labels sampled to cover both kept and rejected patterns |
| `capricorn_catalog` | The SKU list from CLAUDE.md (foodservice, pet, construction, cosmetic, agricultural) |
| `ANTHROPIC_API_KEY` | In `.env` |

---

## Input contract (per candidate)

```jsonc
{
  "name": "Agriplast",
  "website": "https://agriplast.com/",
  "industry": "plastics manufacturing",
  "naics_description": "Plastics Product Manufacturing",
  "description": "Agriplast manufactures advanced plastic films for agriculture, industry and packaging...",
  "employee_count": 125,
  "employee_count_range": "51-200",
  "revenue_usd": 50000000,
  "revenue_range": "25M-75M",
  "country": "Italy",
  "city": "Vittoria",
  "business_type": "manufacturer",
  "website_research": {
    "warehouse": "yes",
    "private_label_only": "unknown",
    "keyword_families_matched": ["manufacture"],
    "warehouse_evidence": ["..."],
    "private_label_evidence": [],
    "third_party_evidence": []
  },
  "score": {
    "gate_passed": true,
    "tier": "Tier 1",
    "total_score": 85,
    "criterion_detail": { ... }
  }
}
```

---

## Output contract

The judge returns strict JSON, no prose around it:

```jsonc
{
  "verdict": "t1" | "t2" | "t3" | "reject",
  "matched_pattern": "producer-with-resale-gap",   // from the playbook; "none" if novel
  "reason": "One-sentence reason in the client's voice — concrete, not generic.",
  "deal_probability": 0.62,                         // 0..1; how likely a deal closes in 6 months
  "what_to_sell": [
    "Anti-hail nets to complement their plastic-film catalogue (sell-through to their olive/grape growers)",
    "Drip irrigation tape lines they don't currently import",
    "Layflat hose under their existing brand"
  ],
  "evidence_citations": [                            // REQUIRED non-empty for t1 (backstop enforces)
    "importamos desde Asia contenedores completos",
    "nuestra marca propia X"
  ],
  "flags": ["already-has-asia-sourcing"]            // optional extra labels for downstream filtering
}
```

The runner writes this dict back to the candidate under `bdr_judgment`. If
`verdict` is `reject`, the candidate is dropped before the lead-row builder. If
`verdict` is `t1/t2/t3`, the candidate's `score.tier` is overridden with the
judge's verdict; `what_to_sell` populates the lead row's `what_to_sell_gaps`
field; `deal_probability` is emitted as a new column.

---

## Patterns the judge must apply

The playbook (`patterns` block of `feedback/iteration_1_labels.json`) is the
source of truth. The most load-bearing patterns:

| Pattern | Verdict | Trigger |
|---|---|---|
| `agrochemicals-wrong-supply-chain` | reject | Agrochemicals, biostimulants, fertilizer chemistry, pesticides, herbicides, seeds |
| `biological-pest-control-not-physical-inputs` | reject | Biocontrol, biological pest control |
| `animal-feed-not-pet-food` | reject | Cattle/livestock feed, not dog/cat food |
| `construction-chemicals-wrong-supply-chain` | reject | Construction adhesives/sealants/chemistry (not membranes/geotextiles) |
| `out-of-product-fragrance` | reject | Fragrance / perfume / scent house |
| `ingredient-supplier-not-finished-goods` | reject | Cosmetic ingredients, raw materials supplier |
| `no-own-brand-reseller` | reject | Distributes other manufacturers' brands only — Capricorn private label can't slot in |
| `direct-competitor` | reject | Same SKUs, same geography Capricorn already sells into |
| `ultra-premium-anti-commodity` | reject | Explicitly positioned ultra-premium / anti-commodity |
| `medical-clinical-not-consumer` | reject | Clinical/medical product line, not consumer cosmetics |
| `dtc-only-own-brand` | reject | Only sells what it produces, DTC-only |
| `has-asia-sourcing-already` | t2 | Visible Asia sourcing team/office — harder to land, not impossible |
| `no-wholesaler-channel` | t2 | Brand sells only via own channels (no wholesale program) |
| `producer-with-resale-gap` | t2 | Producer with a customer base who could resell complementary SKUs |
| `cosmetics-pure-producer-slow-cycle` | t3 | Cosmetics producer — only packaging/complements; slow close |
| `eu-made-proud-producer` | t3 | "EU Made"/"Made in X" brand identity; Asia-source is incompatible |
| `producer-non-priority` | t3 | Single-line factory; not a buyer priority |
| `native-ingredient-only` | t3 | Brand built on a native ingredient (Dead Sea, regional botanicals) |
| `not-volume-importer` | t3 | Small scale / non-container-volume buyer |
| `confirmed-good-fit` | t1 | Quoted import evidence + own brand + core catalog fit, no blocking pattern |

**Added after Iteration 3 (2026-06-10):**

| Pattern | Verdict | Trigger |
|---|---|---|
| `pure-manufacturer-no-import` | reject | Factory, site read, no import motion ("Fábrica full, no importan nada... waste of time" — TATAY, Metzer, Politiv, Geo&Tex) |
| `group-subsidiary-local-mismatch` | reject | Local entity of a global group fails the test locally (Bunzl UK) |
| `food-distributor-not-disposables` | reject | Distributes FOOD, not disposables (Thomas Ridley, Tok Food) |
| `adjacent-category-mismatch` | reject/t3 | Core business is an adjacent category (RAJAPACK transit packaging, NETTUNO motors, Pelemix substrate); t3 if real consumable overlap exists |
| `third-party-distributor-product-fit` | t3 | Niche third-party brands + product fit (Harpo) — deliver flagged low priority; GLOBAL brands → `no-own-brand-reseller` reject |
| `producer-who-also-imports` | t2 | Manufacturer with VERIFIED import motion |
| `volume-dependent-tier` | t1/t2 | Fit confirmed; tier hinges on volume of relevant SKUs (Green-tech) |
| `claimed-import-without-evidence` | t2 max | Import status unverified — wide range is NOT evidence (Textil Villa de Pego) |
| `dead-website` | reject | Site doesn't resolve (caught deterministically) |

The judge MUST pick a pattern if one matches; novel cases use `"none"` and
write the reason. The eval harness will surface every `"none"` so we add new
patterns over time.

---

## Prompt structure (cached prefix)

The runner builds a single message per candidate. The system prompt + playbook +
examples are identical across a run — cache them.

**Cached prefix (system + playbook + capricorn catalog + few-shot):**

> You are a senior BDR for **Capricorn**, a 50-year global sourcing company that
> moves 20,000+ containers/year from China and Vietnam. Capricorn sells to
> **importers and distributors** with reselling channels — not retailers, not
> DTC-only producers, not ingredient suppliers, not competitors.
>
> CAPRICORN CATALOG: [foodservice disposables — bagasse/kraft/PLA cups, cutlery,
> trays, packaging, napkins, straws; pet — dental snacks, wet food, treats, cat
> litter, pads; construction — breathable membranes, geotextiles, rock/glass
> wool; cosmetics — hair/skin care, wipes, packaging, makeup; agriculture —
> layflat hoses, anti-hail nets, films, drip tape, thermal blankets]
>
> EVALUATE one prospect against the playbook below. Output strict JSON matching
> the contract. Be concrete in `what_to_sell` — name specific SKUs the prospect
> could plausibly resell or use, not generic categories.
>
> PLAYBOOK:
> [patterns block from `feedback/iteration_1_labels.json`]
>
> GLOBAL NOTES:
> [global_notes block]
>
> EXAMPLES:
> [6–10 labelled candidates sampled across verdicts]

**Per-candidate suffix:**

> CANDIDATE: [JSON of the input contract]
> Return only the JSON output described in the output contract. No prose.

---

## Execution

1. Load `feedback/iteration_1_labels.json` (and any newer iteration files).
   Compile playbook = `patterns` + `global_notes`. Sample 6–10 examples for the
   few-shot block; pick at least 2 of each verdict.
2. For each candidate, build the prompt and call Claude with prompt-caching on
   the prefix. Default model: `claude-sonnet-4-6` (sonnet handles structured
   judgment at this depth; promote to `claude-opus-4-7` only if eval shows
   sonnet missing nuanced patterns).
3. Parse the JSON response. On parse failure, retry once with `temperature: 0`
   and an explicit "your last response did not parse as JSON" reminder.
4. Attach as `candidate["bdr_judgment"]`.
5. Track cost: cap the run at a configurable `BDR_JUDGE_USD_BUDGET` (default
   `$2.00`). Abort with a clear error if the cap is hit.

---

## When to promote a pattern → deterministic rule

If a pattern fires reliably (10+ correct rejections in the eval against labels)
AND can be detected from cheap upstream signals (industry string, NAICS code,
keyword in description), move it into:
- `tools/score_company.py` `OUT_OF_SCOPE_INDUSTRY` (industry-text match), or
- `feedback/iteration_1_labels.json` `blacklist_keywords` (description-text
  match, applied in the discovery step)

This saves credits and LLM cost on the next run. The judge still catches the
edge cases the rules miss.

---

## Self-improvement loop

After every iteration:
1. Client annotates the new report → produce `feedback/iteration_<N>_labels.json`
   (use `tools/extract_feedback_from_docx.py` for annotated docx or
   `tools/extract_feedback_from_xlsx.py` for spreadsheets; verify by hand
   before promoting the skeleton).
2. Append new patterns discovered to `feedback/iteration_1_labels.json` (the
   master patterns file — keep one canonical patterns dictionary). Add
   client-confirmed never-contact companies to `known_rejects`.
3. Re-run `tools/eval_against_labels.py` over the cumulative label set. The
   T1-precision number must not regress. Also re-run the `--preship` audit on
   the candidate delivery — it independently blocks labelled rejects, dead
   sites, unevidenced T1s, and unhealthy pipeline runs.
4. If a pattern can be promoted to a deterministic rule per the criteria above,
   do it. Document in the workflow's self-improvement notes.
