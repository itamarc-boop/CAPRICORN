# Workflow: Expand the ICP — new vertical or new country

**Objective:** Onboard a new industry (vertical) or a new geography into the
lead-gen system in a repeatable way: always ask the client the same intake
questions, then fill the answers into the same system touchpoints, then
validate with a small pilot before scaling.

**When to run:** Whenever the client wants to expand — a new product line /
industry, a new country, or both.

**Status:** v1, 2026-06-11. Created after the Mexico test run and the client's
signal that he wants to expand countries and industries.

---

## Part A — Intake questionnaire

Ask the client these questions verbatim (translate to Spanish if needed).
Do not skip questions; every answer feeds a specific system component
(see Part B). Record the answers in `feedback/intake_<vertical-or-country>_<YYYY-MM-DD>.md`.

### A1. New INDUSTRY / VERTICAL — 7 questions

1. **Product list.** "What exactly do you sell in this category? Please list
   the products the way you would on a price sheet — product names, materials,
   formats/sizes." (Same format as the original BDR brief. This is the most
   important answer; without it the evidence extractor and judge cannot score
   catalog fit and every lead will be rejected.)
2. **Buyer profile.** "Who buys this from you? Importers, distributors,
   wholesalers, manufacturers who also import? Anything different from your
   usual profile (10–1,000 employees, $5–400M revenue, buys container
   volume, sells own brands)?" (Default = existing ICP unless he says
   otherwise.)
3. **Dream examples.** "Name 2–3 real companies that would be perfect
   customers for this category — including any current customers." (These
   become anchor patterns for the judge and a sanity check for discovery.)
4. **Exclusions.** "What looks similar but is wrong? Competitors we must
   never contact, product categories that overlap in keywords but are not
   your business, any country+category combinations to avoid?" (Iteration-1/3
   lessons: agrochemicals ≠ agriculture, transit packaging ≠ foodservice
   disposables, Israel+wipes excluded. New verticals will have their own
   versions of these.)
5. **Local product language.** "What are these products called in the target
   markets' languages?" (If he can't answer, we translate and he confirms.
   Local-language keywords are proven critical — Spain 26→176 candidates,
   the entire Mexico pool.)
6. **Positioning.** "When we find a perfect-fit company, what is your opening
   pitch for this category — price, range, reliability, private label,
   something else?" (Feeds the "How to open:" line on Tier 1 leads.)
7. **Priority countries for this vertical.** "Where do you want these leads
   first?" (A vertical does not have to run in all geographies.)

### A2. New COUNTRY — 5 questions

1. **Priority.** "How important is this market vs the existing ones —
   High / Medium?" (Feeds the gate's priority value.)
2. **Verticals in scope.** "Which of your product categories should we hunt
   for in this country — all, or a subset?"
3. **Known names.** "Do you already have customers, prospects, or known
   competitors there?" (Customers/competitors go to the exclusion list;
   prospects become anchor examples.)
4. **Exclusions.** "Anything to avoid in this market?" (The Israel+wipes
   pattern — ask explicitly.)
5. **Language.** Confirm the local language(s) for keyword sets.

Note: if the country is in the US / Latin America, flag that Panjiva customs
data can verify importers there (see Part C). Panjiva is NOT for Europe —
Europe keeps the existing evidence stack (HMRC register for UK, web-search
verification elsewhere).

---

## Part B — System fill-in checklist

Map the answers to these touchpoints, in this order. Every item is a small,
reviewable change — do them all before the pilot.

| # | Answer | Where it goes |
|---|---|---|
| 1 | Product list (A1.1) | `CAPRICORN_CATALOG` in `tools/extract_evidence.py` — append the new category block. The judge and catalog_fit axis read this. |
| 2 | Product list + local language (A1.1, A1.5) | New keyword row in the per-vertical table in `workflows/find_capricorn_leads.md`. Prefer importer/distributor phrasing ("distribuidor de X") over bare category names. Local language only for non-English markets. |
| 3 | Exclusions (A1.4, A2.4) | `blacklist_keywords` + named exclusions in `feedback/iteration_1_labels.json` (the canonical playbook file). Competitors and country+vertical exclusions are spelled out the way Israel+wipes is. |
| 4 | Dream examples (A1.3, A2.3) | Add as labelled confirms in a new `feedback/intake_*_labels.json` seed file so the judge has at least a few positive anchors before the first feedback round. |
| 5 | Positioning (A1.6) | Note in the intake file; used for "How to open:" lines on T1s in round reports (T1s only, never T2/T3). |
| 6 | New country (A2.1) | `EXTRA_TARGET_COUNTRIES="<country>:<priority>"` on every `score_company.py` invocation of the run. The locked 8-country model is unchanged; this extends the gate per-run. If the client confirms the country is PERMANENT, ask the user before promoting it into `TARGET_COUNTRIES` in `tools/score_company.py` (that edits the locked model and needs an explicit decision). |
| 7 | US/LatAm country | Wire `tools/panjiva_lookup.py` into the run between the provisional score and web verification (replaces the paid web-search step for that country). See Part C. |

## Part B2 — Pilot before scale (mandatory)

1. Run `workflows/find_capricorn_leads.md` with `target_qualified = 5` for the
   new vertical/country only.
2. Both gates must pass (`eval_against_labels.py --judged` and `--preship`).
3. Send the 5-lead pilot to the client for feedback BEFORE scaling. New
   verticals have no labelled history — first-round precision will look like
   iteration 1 did. The pilot is what buys calibration cheaply.
4. Extract his feedback into `feedback/iteration_<N>_labels.json`
   (`extract_feedback_from_docx.py` / `_from_xlsx.py`), re-run the eval,
   then scale.

---

## Part C — Panjiva (US + Latin America only)

Scope decision (user, 2026-06-11): Panjiva is for the US and Latin America
expansion. It does not replace anything in Europe.

Coverage with company-level shipment records: US, Mexico, Brazil, Chile,
Colombia, Ecuador, Peru, Uruguay, Venezuela, Bolivia, Panama, Paraguay (plus
Asia lanes). Mexican records include unredacted USD values — importers can be
ranked by import volume.

**Setup (pending — user has the client's account):**
1. Check whether the subscription includes API access (Bearer token). If yes:
   token goes in `.env` as `PANJIVA_API_TOKEN`. Never anywhere else.
2. If no API: the platform exports search results to CSV/Excel — the tool
   below should accept `--csv` exports as an alternate input.

**To build once access exists:**
- `tools/panjiva_lookup.py` — modeled on `uk_importers_lookup.py`:
  given pipeline records, query the company-search endpoint (consignees,
  filtered by country + optionally HS code) and on a conservative name match
  upgrade `imports` unknown→yes with shipment counts / HS codes / USD value
  as the quoted evidence. Cache responses in `.tmp/panjiva/`. Conservative
  matching rules carry over from the HMRC tool: short names exact-only,
  containment needs ≥3 tokens.
- Phase 2 (separate approval): Panjiva-led discovery — top consignees by
  HS code + country, then Explorium `match-business` + enrich for
  firmographics and contacts.

---

## Self-improvement notes

- Keep the questionnaire stable. If a round reveals a missing question, add it
  here so the NEXT intake catches it — don't improvise per-intake.
- After each new-vertical pilot, record the keyword hit rate and the judge's
  reject patterns in this file.
