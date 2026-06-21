# Workflow: Find Capricorn Leads (Explorium MCP → scored Google Sheet)

**Objective:** Produce a batch of 20–30 qualified companies matching Capricorn's
ICP, each scored by the locked model and carrying 1–3 contacts, delivered to a
review file (Google Sheet later — deferred until results are good).

**Cadence:** Manual, on-demand. All target countries in one run.

**Status:** v2, 2026-06-10, after iteration-3 client feedback. Discovery
strategy validated against live Explorium statistics probes (see "Discovery
strategy" below). The qualification layers were rebuilt around the
importer + own-brand ICP — see `workflows/icp_scoring_model.md` (LOCKED v2)
and the iteration-3 post-mortem in "Self-improvement notes".

---

## Required inputs

| Input | Default | Notes |
|---|---|---|
| `target_qualified` | `25` | Final count of qualified (Tier 1/2/3) companies wanted |
| `prospects_per_company` | `1–3` | Key contacts per qualifying company |
| `countries` | all 8 ICP countries | ES, GB, IT, IL, DE, CH, RO, GR |
| `pilot_country` | — | If set, run discovery for one country only (first-run validation) |
| `extra_countries` | — | Geographies OUTSIDE the locked 8. Set `EXTRA_TARGET_COUNTRIES="<country>:<priority>,..."` (e.g. `"mexico:Medium"`) in the environment of every `score_company.py` invocation in the run. This extends the target-country gate for that run only; the locked model and default behavior are unchanged. Use LOCAL-LANGUAGE keywords for new geographies (iter-4 + Mexico-test lesson: Spanish keywords took Spain 26→176 candidates and drove the whole Mexico pool). First run in a new country = pilot-size it (5 leads) before scaling. |

The ICP, gates, and scoring are **locked** — see `workflows/icp_scoring_model.md`.
Do not redefine them here. (`extra_countries` extends the gate's country list
per-run; it does not change scoring weights or tier rules.)

---

## Discovery strategy — why keyword-driven

Live probes on Spain (2026-05-20, `fetch-businesses-statistics`, 0 credits):

- **NAICS filtering = poor precision.** Explorium tags many companies only at
  coarse 2–4 digit NAICS levels; 6-digit leaf codes return near-zero for
  soap/detergent, pet food, sanitary paper. Broad codes (`313`, `3261`)
  return thousands of mostly-irrelevant manufacturers.
- **`website_keywords` = high precision.** Capricorn's product language matched
  ~123 on-target companies in Spain alone — plenty, since a run needs only ~25.

So discovery is **keyword-driven**: `website_keywords` (ICP product language) +
firmographic filters. NAICS is used only as an optional secondary signal.
Explorium casts a precise-but-wide net; `tools/score_company.py` does the exact
qualification.

### Per-vertical `website_keywords`

Calibrated 2026-05-27 against Iteration-1 client feedback. **All keyword sets
prefer importer / distributor / wholesale language** ("importer of X",
"distributor of X") over generic category names — the deterministic gates and
the BDR judge later both penalise pure DTC producers.

| Vertical | Keywords |
|---|---|
| Foodservice Disposables | `foodservice disposables`, `disposable tableware`, `disposable cutlery`, `paper cups`, `takeaway packaging`, `catering disposables`, `disposable packaging importer`, `disposable packaging distributor` |
| Pet Food | `pet food importer`, `pet food distributor`, `dog food`, `cat food`, `pet treats`, `pet care products distributor` |
| Cosmetics | `cosmetics importer`, `cosmetics distributor`, `personal care distributor`, `private label cosmetics`, `beauty products importer`, `skincare wholesale` |
| Wipes | `wet wipes`, `baby wipes`, `nonwoven wipes`, `wipes importer`, `wipes distributor` |
| Membranes & Geotextiles | `geotextile`, `geomembrane`, `geosynthetics`, `waterproofing membrane`, `breathable membrane`, `roofing underlay`, `rock wool insulation`, `glass wool insulation` |
| Agriculture | `agrotextiles`, `agricultural plastics`, `agricultural film`, `mulch film`, `anti-hail nets`, `shade nets`, `olive nets`, `drip irrigation tape`, `greenhouse supplies`, `grow bags`, `layflat hose` |
| Cleaning Supplies | `cleaning products`, `detergents`, `cleaning supplies`, `janitorial products`, `cleaning supplies distributor`, `janitorial products distributor` |

`website_keywords` values are OR'd in one call.

### Israel — importer-intent keywords only (rewritten 2026-06-10)

Iteration 3 pulled Israeli agtech MANUFACTURERS (Pelemix, Metzer, A.A.
Politiv — all client-rejected: "Manufacturer... waste of time"). The client's
diagnosis: Israel has a strong agri-tech manufacturing tradition, a poor
hunting ground for Capricorn's ICP; the target is the smaller segment of
IMPORTERS bringing physical goods into Israel from Asia.

For Israel, do NOT use the generic per-vertical keyword sets. Run a separate
`fetch-businesses` call with importer-intent terms combined with product
categories:

- `importer`, `official importer`, `import and distribution`,
  `יבואן` (importer), `יבוא` (import), `יבוא ושיווק` (import & marketing)
- combined with: `agricultural plastics`, `irrigation accessories`,
  `agricultural film`, `greenhouse equipment supplier`, `irrigation supplies`

**Quota rule:** deliver fewer, higher-confidence Israeli leads rather than
backfilling with manufacturers. 2–3 verified importers beat 5 padded leads
(user decision 2026-06-10). Israeli leads must have `imports == yes` evidence
to ship — the pre-ship audit enforces this. Israel + wipes stays excluded
(N.R. Spuntech).

**Agriculture (rewritten 2026-05-27):** The previous list used generic
"agricultural products / agricultural supplies / horticulture products", which
pulled agrochemicals, biostimulants, biocontrol and cattle feed (Timac Agro,
Valagro, BioBee, EW Nutrition — all rejected by client). The new list names
**physical agricultural inputs only** — exactly Capricorn's catalog from
CLAUDE.md. Use these literally; do not add "agriculture" as a standalone term.

### Negative-keyword blacklist (drop at Explorium fetch step)

After `fetch-businesses` returns, drop any company whose `industry`,
`naics_description`, or `description` contains any of the terms in
`feedback/iteration_1_labels.json` `blacklist_keywords` (loaded by
`tools/score_company.py`). This saves enrich credits + LLM cost on cases the
BDR judge will reject anyway:

- Agrochemicals, biostimulants, pesticides, herbicides, biocontrol, fertilizer
  chemistry, seeds
- Fragrance / perfume / scent house
- Cosmetic ingredient suppliers, raw materials suppliers
- Contract manufacturers (the "we only make others' brands" pattern)
- Cattle / livestock feed
- Construction chemicals / adhesives / sealants / coatings

Keep this list in sync with the labels JSON — don't fork it here.

### Firmographic filters (every discovery call)

- `country_code`: the run's countries (ISO Alpha-2)
- `company_size`: `["11-50","51-200","201-500","501-1000"]` — covers the ICP's
  10–1,000 range; `1-10` and `1001+` are excluded (hard gate territory)
- `company_revenue`: `["5M-10M","10M-25M","25M-75M","75M-200M","200M-500M"]` —
  covers the $5–400M ICP span (Explorium buckets don't align exactly; scoring
  refines)
- `has_website`: `true` — required, the website is needed for gate research

---

## Required tools

**Explorium MCP** (`.mcp.json`):
- `mcp__explorium__autocomplete` — only if adding NAICS/linkedin filters; not
  needed for the keyword-driven path. Cache values per session.
- `mcp__explorium__fetch-businesses-statistics` — **0 credits.** Use freely to
  size a query before spending on `fetch-businesses`.
- `mcp__explorium__fetch-businesses` — discovery. Returns business IDs +
  firmographics. `page_size` ≤ 100.
- `mcp__explorium__enrich-business` — `enrichments: ["firmographics"]` (batch up
  to 100 IDs/call). Credit cost — the main spend.
- `mcp__explorium__fetch-prospects` — contacts by `business_id` +
  `job_department` + `job_level`.
- `mcp__explorium__enrich-prospects` — `enrichments: ["contacts","profiles"]`.

**Local Python tools** (`tools/`):
- `research_company_website.py` — site fetch + `site_status`
  (ok/dead/unreachable) + page text for the evidence extractor. **Use the
  batch CLI** (`--records in.json --out out.json`) — never an ad-hoc runner
  (that's how iteration 3 crashed silently). v2 2026-06-10.
- `extract_evidence.py` — Haiku multilingual quote-backed evidence extraction
  (imports / own_brand / manufacturer / catalog_fit / volume_signals). The
  source of truth for the two ICP axes. ~$0.01/company, budget-capped. New
  2026-06-10.
- `uk_importers_lookup.py` — FREE definitive UK import evidence from the
  HMRC monthly importer register (uktradeinfo.com, cached in
  `.tmp/uk_importers/`). Upgrades `imports` unknown→yes with comcodes.
  Non-match is NOT negative evidence. New 2026-06-10.
- `verify_import_evidence.py` — Anthropic web-search verification (~$0.01/
  search + Haiku tokens) for T1/T2 candidates blocked solely by unknown
  imports/own-brand. Runs AFTER the UK lookup (which removes UK names from
  the paid shortlist). Budget-capped. New 2026-06-10.
- `score_company.py` — gates + 100-pt importer/own-brand scoring + tier caps
  + `bdr_judgment` override. LOCKED v2. **Re-run it after the judge** to fold
  the verdict into the final tier.
- `explorium_to_record.py` — maps Explorium firmographics → score-record shape.
- `dedup_companies.py` — drops companies already delivered in a prior run
  (`.tmp/seen_companies.json`) and archives rejects.
- `bdr_judge.py` — Claude "senior BDR" verdict with evidence citations and a
  deterministic T1 backstop (no unevidenced T1 can ship). See
  `workflows/bdr_judge.md`.
- `eval_against_labels.py` — regression gate over
  `feedback/iteration_*_labels.json` (T1-precision ≥ 0.9) PLUS the
  **`--preship` structural audit** (label-independent; checks evidence
  health ≥ 90%, no dead sites, no labelled rejects, Israeli leads have import
  evidence, T1s carry quoted evidence). Both exit non-zero on failure.
- `extract_feedback_from_docx.py` / `extract_feedback_from_xlsx.py` —
  bootstrap a labels JSON from client-annotated feedback (docx or xlsx);
  human verifies before promoting to `feedback/iteration_<N>_labels.json`.
- `build_lead_rows.py` — merges company + contacts + judge into the final
  flat rows, now including the verbatim evidence columns (`business_model`,
  `import_evidence`, `own_brand_evidence`, `third_party_brands`,
  `evidence_urls`) so the client can verify any T1 in 30 seconds.

---

## Execution steps

Files live in `.tmp/`. Run in order.

1. **Preflight.** Confirm `EXPLORIUM_API_KEY` in `.env` and the
   `mcp__explorium__*` tools are loaded.

2. **Size the query (free).** `fetch-businesses-statistics` with the run's
   `country_code` + the firmographic filters + all per-vertical
   `website_keywords` OR'd together. Confirm `total_results` comfortably
   exceeds `target_qualified` (expect ~30–50% to survive gates + scoring).

3. **Discover (credit cost).** `fetch-businesses` with the same filters. Pull
   `size ≈ target_qualified × 4` (gates + scoring drop most). Save business
   IDs + firmographics to `.tmp/discovered.json`.

4. **Dedup.** `python tools/dedup_companies.py < .tmp/discovered.json >
   .tmp/to_enrich.json` — drops companies seen in prior runs.

5. **Enrich firmographics (main credit spend).** `enrich-business` with
   `enrichments: ["firmographics"]`, batched ≤ 100 IDs. Save to
   `.tmp/enriched.json`.

6. **Map to records.** `python tools/explorium_to_record.py .tmp/enriched.json
   > .tmp/records.json` — Explorium shape → `score_company.py` record shape.

7. **Website research (free, batch CLI).**
   `python3 tools/research_company_website.py --records .tmp/records.json
   --out .tmp/records_researched.json`. Fetches each site, classifies
   `site_status` (dead sites will be gate-dropped), captures page text for
   the extractor, and exits non-zero if >25% of the run failed — DO NOT
   continue past a failure (iteration-3 lesson: its research layer crashed
   for 100% of records and nobody noticed).

8. **Evidence extraction (Anthropic API, ~$0.01/company).**
   `python3 tools/extract_evidence.py --records .tmp/records_researched.json
   --out .tmp/records_evidence.json`. Produces the quote-backed `evidence`
   block (imports / own_brand / manufacturer / catalog_fit / volume_signals)
   that the scoring axes and judge run on. Budget cap
   `EVIDENCE_EXTRACT_USD_BUDGET` (default $1.50).

8b. **Provisional score.** Run `score_company.py` over every record (attach
   as `score`). This sets gates, provisional tiers and the evidence caps —
   needed to select the verification shortlist.

8c. **UK importer lookup (free).**
   `python3 tools/uk_importers_lookup.py --records .tmp/records_evidence.json
   --out .tmp/records_uk.json`. Hard import evidence for UK companies from
   the HMRC register; removes them from the paid web-search shortlist.

8d. **Web-search verification (Anthropic API, capped $1).**
   `python3 tools/verify_import_evidence.py --records .tmp/records_uk.json
   --out .tmp/records_verified.json`. Only T1/T2 candidates blocked by
   unknown imports/own-brand; upgrades require a verbatim quote + source URL.
   After this step, **re-run `score_company.py`** so upgraded evidence is
   reflected in points and caps.

9. **Fetch contacts (free).** For each qualified company, do ONE
   `fetch-prospects` call with **only `business_id`** as a filter. No
   `job_department`, no `has_email`, no `job_level` at fetch time.
   - **Why no narrow filters.** Iteration-2 found that European SMEs rarely
     tag a "procurement" department; the buyer is the MD, Geschäftsleiter,
     Commercial Director, or Sourcing Manager listed under a generic
     department. The old filter (`job_department: ["procurement"]` +
     `has_email: true`) missed real buyers at SCHOELLKOPF, Ecocraft,
     Brossta, Vodaland, and Swiss Pet Solution.
   - **Pick contacts deterministically.** Run
     `python tools/pick_prospects.py --prospects .tmp/prospects.json
     --companies .tmp/scored.json > .tmp/prospects_picked.json`. It applies
     a title-priority ladder + country gate:
     1. Procurement / Sourcing / Buyer / Purchasing (highest)
     2. MD / Geschäftsleiter / Managing Director / Owner / Founder / President
     3. Commercial Director / Head of [vertical]
     4. CEO / Director of [domain]
     5. Sales Director / Sales Manager
     6. General Manager / Operations Manager
     7. Country Manager
     8. Account Manager / Supply Chain / Logistics Manager
     9. Finance / Technical / Shift / Warehouse (last-resort only)
   - **Country gate**: drop any prospect whose `country_name` differs from
     the company's country (Iteration-2 caught a Costa Rica CEO at a Greek
     company and an India Shift Manager that way).
   - Cap at 2 prospects per company (the top-ranked, plus a runner-up only
     if also ≥ rank 4).

10. **Enrich contacts (credit cost).** `enrich-prospects` with
    `["contacts","profiles"]` on the picked prospect IDs. Some return no
    email — keep them as LinkedIn-only contacts in the lead file, do not
    drop them. They are still useful for outbound on LinkedIn.

11. **BDR judge (Anthropic API).** `python tools/bdr_judge.py
    --candidates .tmp/records_verified.json --out .tmp/judged.json`. Runs the
    Claude "senior BDR" pass over every gate-passing candidate, applying the
    playbook from `feedback/iteration_1_labels.json` (canonical patterns) with
    few-shot labels from ALL `feedback/iteration_*_labels.json`. Each
    candidate gets a `bdr_judgment` block: `verdict`, `matched_pattern`,
    `reason`, `deal_probability`, `what_to_sell`, `evidence_citations`,
    `flags`. A deterministic backstop rewrites any t1 lacking quoted
    imports + own-brand evidence to t2. Cost cap `BDR_JUDGE_USD_BUDGET`
    (default $2). **After judging, re-run `score_company.py` on the judged
    records** — the scorer folds `bdr_judgment.verdict` into the final tier
    (and drops rejects).

12. **Eval + pre-ship audit (both must pass).**
    - `python tools/eval_against_labels.py --judged .tmp/judged.json` —
      T1-precision ≥ 0.9 against all labelled iterations. If it fails, tune
      the playbook and re-run from step 11.
    - `python tools/eval_against_labels.py --preship .tmp/judged.json` —
      label-independent structural audit of the ACTUAL delivery list:
      evidence-layer health ≥ 90%, no dead/unreachable sites shipping, no
      client-labelled rejects or named competitors, Israeli leads carry
      import evidence, every T1 carries quoted imports + own-brand evidence
      and judge citations. **Exit code non-zero = DO NOT SHIP.** This audit
      would have blocked iteration 3.

13. **Build output.** `python tools/build_lead_rows.py --companies
    .tmp/judged.json --contacts .tmp/contacts.json --out .tmp/leads_<YYYY-MM-DD>`.
    Rows now carry `business_model`, `import_evidence`, `own_brand_evidence`,
    `third_party_brands`, `evidence_urls` — the human pre-send skim is an
    evidence check, not a vibe check.

14. **Report.** Print: discovered → deduped → enriched → judged → delivered
    (by tier) counts; the `⚠ needs human check` flagged companies; top leads;
    any partial failures. Quote the evidence for every T1 in the report.

---

## Credits & cost control

- `fetch-businesses-statistics` is **free** — always size before fetching.
- `fetch-businesses`, `enrich-business`, `fetch-prospects`, `enrich-prospects`
  **cost credits.** `enrich-business` is the biggest line item.
- **First run = pilot one country** (`pilot_country`). Validate the full
  pipeline end-to-end on a small set before scaling to all 8 countries.
- Never re-enrich an already-enriched record. On rate-limit errors, back off
  30s and resume.

---

## Pending before this workflow can run end-to-end

- Build the three `TO BUILD` tools above.
- User go-ahead for the first credit-spending run (pilot country).
- Google Sheets output — deferred; step 11 writes local files until then.

## Self-improvement notes

**Iteration-3 post-mortem (2026-06-10) — read this before every run:**
- **The research layer crashed for 100% of records and the run shipped
  anyway.** An ad-hoc runner (`.tmp/run_research_iter3.py`) passed the
  description STRING where `merge_research` needed a dict; every record got
  `website_research: {ok: false, error: "'str' object has no attribute
  'get'"}`, every gate resolved "unknown", and nothing aborted. Fixes:
  research has a batch CLI that owns the merge and exits non-zero on >25%
  failure; the `--preship` audit fails the run if evidence health < 90%.
  **Never write ad-hoc runners in `.tmp/` for pipeline steps.**
- Of 5 delivered T1s the client rejected 4. Root causes: scoring rewarded
  manufacturers like importers; English-regex gates on ES/IT/DE/HE sites
  always resolved "unknown"; the judge asserted importing without evidence
  ("Claude dice que importan pq su range es muy grande, pero sin un claim
  real"). All three layers rebuilt — see `workflows/icp_scoring_model.md` v2.
- Client's two conclusions now drive the model: importers who buy container
  volume > manufacturers with product overlap; own brands qualify,
  third-party/global brands disqualify (Eukanuba/Pedigree/Hills example).
- Food distributors are NOT foodservice-disposables companies (Thomas
  Ridley, Tok Food); transit packaging ≠ foodservice disposables (RAJAPACK);
  judge the CORE business, not keyword co-occurrence.
- Group subsidiaries are judged as the LOCAL entity (Bunzl: Capricorn client
  in Chile, reject in UK).
- Validation on the 25 known answers: 19-21/25 exact verdict agreement, zero
  false T1s, preship blocks the residual judge-softened labelled rejects.
- Known trade-off (documented, accepted): the stricter manufacturer policy
  rejects Naue-class iteration-1 confirms when their sites show no import
  motion; UK register + web-search verification are the recovery paths for
  genuinely importing manufacturers.
- HMRC UK importer register matching must stay conservative: 2-token names
  containment-matched the wrong company ('green tech' → 'green tech
  automotive'). Exact match for short names; containment needs ≥3 tokens.
- The judge model emits a preamble text block before web-search results —
  parse the LAST text block and extract the outermost {...}.

**Iteration-1 client feedback learnings (2026-05-27):**
- ~40% of T1 leads were misaligned with the client's actual buying motion —
  pure cosmetics producers (slow cycle), DTC-only brands (Lush), ultra-premium
  (Dr. Barbara Sturm), ingredient suppliers (Sharon, Eurofragance), direct
  competitors (N.R. Spuntech), wrong supply chain (Timac/Valagro
  agrochemicals; SCHOMBURG construction chemistry; EW cattle nutrition),
  biological-pest-control (BioBee). All now caught by the BDR judge layer
  + blacklist (see `workflows/bdr_judge.md`).
- Agriculture keywords rewritten to product-name terms (agrotextiles, mulch
  film, anti-hail nets, drip irrigation, layflat hose) and away from generic
  "agriculture / agricultural products" — see the per-vertical table above.
- **Israel + wipes is excluded by policy** — direct competitive overlap with
  N.R. Spuntech. The judge enforces this even if discovery slips through.
- A "confirmed-good-fit" pattern emerges: importer/distributor with reseller
  channel + in-product + in target country (INTERMAS, H-Pack, Naue, MONGE,
  Nice-Pak, Agriplast, Talking Tables). Discovery should bias toward these
  patterns.

**Spain pilot learnings (2026-05-20):**
- Credit costs: `fetch-businesses`, `fetch-prospects` and the `*-statistics`
  tools are **free**. `enrich-business` = 1 credit/company. `enrich-prospects`
  = 2/contact (`contacts`) + 1/contact (`profiles`).
- A single combined `website_keywords` query is noisy — it returns agencies,
  hotels and finance firms that merely mention ICP words, and (in Spain)
  skewed almost entirely to cosmetics. `score_company.py`'s out-of-scope-
  industry gate now drops the non-ICP firms; to also balance verticals, prefer
  **one `fetch-businesses` call per vertical** over one big OR query.
- `country_code` leaks non-target countries — the target-country gate handles
  it, but eyeball results before enriching.
- Enrich only plausible companies — skip obvious non-ICP names/domains before
  paying for `enrich-business`.
- `research_company_website.py` rarely confirms `warehouse` (companies don't
  publish it) — expect that human-check flag on most leads. Feed the Explorium
  business description into the gates via `merge_research()`.

Keep updating: per-vertical keyword hit rates; prospect title-mapping rates.
