# 11/06/2026 Mexico Test Run

**Objective:** Find 5 companies that sell disposable cutlery in Mexico, with key contacts, using the standard Capricorn lead pipeline (Explorium discovery, website research, evidence extraction, locked ICP scoring, web-search verification, BDR judge, pre-ship audit).

**Scope note:** Mexico is not one of the 8 ICP countries. The locked scoring model was not changed. The run used a one-off opt-in override (`EXTRA_TARGET_COUNTRIES=mexico:Medium`) so Mexican companies could pass the target-country gate for this test only. Default behavior for regular runs is unchanged.

## Funnel

| Stage | Count |
|---|---|
| Matched in Explorium (free probe) | 333 |
| Fetched | 50 |
| Screened plausible and enriched | 20 |
| Ran full pipeline (research, evidence, scoring) | 16 |
| Qualified for delivery | 5 |

All 16 sites researched successfully (100% evidence-layer health). Label regression gate: PASS. Pre-ship audit: PASS.

## The 5 leads

### 1. Packsys — Tier 1 (97/100)
Foodservice and packaging disposables distributor, CDMX, 501-1000 employees, est. revenue 75M-200M USD. The strongest lead of the run and a textbook Capricorn profile.
- Import evidence (quoted): "Importamos productos de diversos paises, entre ellos... Espana, Polonia, Alemania, Suecia, Dinamarca, Taiwan, Corea, China" (packsys.com/pages/nosotros)
- Own brand: Smart Green (ecological disposables line)
- What to sell: wooden and PP cutlery, bagasse plates and bowls, paper cups and straws, takeaway containers, napkins
- Contacts:
  - Mario Mondragon Martinez, Senior Purchasing Specialist, mario@packsys.com (valid), [LinkedIn](https://linkedin.com/in/mario-mondragon-martinez-460938125)
  - Mario Enrique Valdes Ordonez, Foreign Trade & Procurement (imports and customs), LinkedIn only: [profile](https://linkedin.com/in/marioenriquevaldeso)

### 2. GlobalPack — Tier 2 (97/100)
Single-use foodservice products distributor, Zapopan (Guadalajara), 22+ years in business, serves supermarkets and large foodservice users.
- Own brand: Hystark (disposable PPE line)
- Import evidence is suggestive but not conclusive ("access to a wide network of manufacturers worldwide"). The BDR judge downgraded Tier 1 to Tier 2 for that reason and flagged it for human verification.
- Contact: Carlos Lamadrid, Director General, LinkedIn only: [profile](https://linkedin.com/in/carlos-lamadrid-4a4642a8)

### 3. Prolimp — Tier 2 (72/100)
Cleaning products manufacturer and distributor, 201-500 employees, est. revenue 25M-75M USD. Makes its own Prolimp and SIBA chemical lines and distributes 3M, Kimberly Clark and Rubbermaid. Catalog fit is adjacent (cleaning supplies, paper, cloths), not disposable cutlery. Included as the fifth qualifier; the judge sees a complementary-line opportunity, not a core one.
- Contact: Daniel Martinez Cruz, Gerente de Compra (purchasing manager), LinkedIn only: [profile](https://linkedin.com/in/daniel-martinez-cruz-9217a0253)

### 4. Renovapack — Tier 3 (42/100)
Biodegradable disposables specialist (containers, cups, plates, cutlery) serving 500+ restaurants and 250 hotels with 25 distributors across Mexico. Strong cutlery fit, but presents as a producer with no verified import motion, which caps the tier.
- Contact: Mario Alberto Flores, Gerente Comercial, mario@renovapack.com (valid), [LinkedIn](https://linkedin.com/in/marioflorest)

### 5. LAMBI — Tier 3 (27/100)
Disposable hygiene products manufacturer (diapers, wet wipes, feminine care) with own brands, 201-500 employees. Matched on "desechables" but does not sell cutlery; the judge sees a narrow wipes opportunity only if they source externally. Weakest fit of the five.
- Contact: Andres Marcos, Director General, amarcos@lambi.com.mx (valid), [LinkedIn](https://linkedin.com/in/andr%C3%A9s-marcos-42233832)

## Honest read on the result

The user asked for disposable cutlery sellers. Of the 5 qualified leads, Packsys, GlobalPack and Renovapack genuinely sell or distribute disposable cutlery and tableware. Prolimp and LAMBI qualified under the broader ICP (adjacent verticals) but are not cutlery companies. The Mexican pool skews to manufacturers and food distributors; 11 of 16 piped companies were rejected by the gates or the judge (food distributors, pure manufacturers with no import motion, a no-own-brand reseller including Bunzl Mexico, and category mismatches).

## Run economics

- Explorium credits: 32 total (20 company enrichments, 12 contact/profile enrichments; discovery and prospect fetches are free)
- Anthropic API spend: about $0.60 (evidence extraction $0.21, web-search verification $0.18, BDR judge $0.18)
- All 16 companies registered in the dedup store so future runs skip them

## Files

- Leads: `.tmp/leads_2026-06-11_mexico_test.json` / `.csv`
- Full judged records: `.tmp/mx_all_judged.json`
