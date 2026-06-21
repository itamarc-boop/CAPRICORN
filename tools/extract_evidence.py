"""LLM evidence extraction over researched company records (Haiku 4.5).

Replaces the English-regex gate detection that failed iteration 3: company
sites are in Spanish/Italian/German/Hebrew, so ~25 English patterns resolved
almost everything to "unknown". This tool reads the page text fetched by
``research_company_website.py --records`` plus the Explorium description and
extracts a structured, QUOTE-BACKED evidence block per company:

  * imports        — does the company import / buy goods abroad to sell?
  * own_brand      — does it sell under brand name(s) it owns?
  * manufacturer   — does it operate its own production?
  * third_party_brands, core_products, core_business_summary
  * catalog_fit    — is its CORE business one of Capricorn's verticals?
  * volume_signals — warehouse size, branches, SKU counts, export markets...

THE INVARIANT (iteration-3 lesson, Textil Villa de Pego): a yes/no verdict
without a verbatim quote is rewritten to "unknown" by deterministic
post-validation. A wide product range is NOT import evidence. The scoring
engine and BDR judge treat these verdicts as the source of truth for the
importer + own-brand ICP axes.

Cost: one Haiku call per company, cached system prompt, ~$0.01-0.02/company.
Dead sites are skipped (no spend). Unreachable sites are extracted from the
Explorium description only.

Usage:
    python3 tools/extract_evidence.py \
        --records .tmp/records_with_research.json \
        --out .tmp/records_with_evidence.json [--budget 1.50]

Env:
    ANTHROPIC_API_KEY              required
    EVIDENCE_EXTRACT_USD_BUDGET    default 1.50; abort if exceeded
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_MODEL = "claude-haiku-4-5"
DEFAULT_BUDGET_USD = 1.50
PAGES_CHAR_CAP = 30_000   # total page text per company fed to the model

PRICING_USD_PER_MTOK = {
    "claude-haiku-4-5":  {"input": 1.00, "cache_write": 1.25, "cache_read": 0.10, "output": 5.00},
    "claude-sonnet-4-6": {"input": 3.00, "cache_write": 3.75, "cache_read": 0.30, "output": 15.00},
}

# Canonical catalog summary, aligned 2026-06-11 with the client's original
# BDR brief (50+ years, 1M+ SKUs). bdr_judge.py uses this as its fallback too.
# NOTE: geomembranes and geosynthetic clay liners are NOT in the catalog —
# the construction line is membranes/underlay/geotextiles/wool only (the
# client's IL TELONE comment confirmed geomembranes "no calzan").
CAPRICORN_CATALOG = """\
Capricorn is a 50+ year global sourcing company moving 20,000+ containers/year
and 1M+ SKUs from China and Vietnam, and acts as an NPD partner scanning the
Asian supplier market. Verticals and example SKUs:
- foodservice-disposables: bagasse/kraft/PLA/paper cups, PP and PET cups,
  wooden/PP/PS cutlery, paper/plastic/aluminum trays, deli containers,
  takeaway packaging, paper plates, airfryer paper, PVC cling film, napkins,
  tissue napkins, paper hand towels, jumbo roll towels, paper straws
- pet-food: dental snacks, soft bites, biscuits, wet food pouches/cans, lick
  treats, soups, yogurts, cat litter, pet pads, pet packaging and promo items
- cosmetics: hair care (shampoo, conditioner, styling, masks), skin care
  (face/hand/foot masks, creams, serums, sunscreen), makeup (powders,
  foundation, BB cream, blush), nail polish, makeup-remover and baby wipes,
  cosmetic packaging and valves
- wipes: wet wipes (baby, makeup remover, personal care), nonwoven cloths
- membranes-geotextiles: breathable membranes (incl. reflective),
  thermal-radiation insulation, reflective vapor barrier, synthetic roofing
  underlay, woven/nonwoven geotextiles in PP and PET, rock wool, glass wool
  (NO geomembranes, NO geosynthetic clay liners — not in catalog)
- agriculture: layflat hoses, planters, anti-hail nets, olive nets, shade
  nets, films (grape covers, PO coating, bubble film, air duct, mulch),
  grow bags, drip irrigation tapes, thermal blankets
- cleaning-supplies: cleaning cloths, mop heads, paper hand towels, jumbo
  rolls, garbage bags, household gloves"""

VERTICALS = ["foodservice-disposables", "pet-food", "cosmetics", "wipes",
             "membranes-geotextiles", "agriculture", "cleaning-supplies"]

SYSTEM_PROMPT = f"""You extract verifiable supply-chain evidence about ONE company from its website \
text (any language — Spanish, Italian, German, Hebrew, English...) and a data-vendor description. \
Your output feeds a lead-qualification pipeline for Capricorn.

{CAPRICORN_CATALOG}

THE IDEAL CUSTOMER imports container volume from Asia and sells under its OWN brands. The two \
killer questions are: (A) does this company IMPORT / buy finished goods to sell, or produce \
everything in-house? (B) does it sell its OWN brand(s), or distribute third-party brands?

RULES — read carefully:
1. EVIDENCE OR UNKNOWN. Every "yes" or "no" verdict MUST carry a verbatim quote (max 200 chars) \
from the provided text, in its original language, plus an English gloss and the source URL \
(or "explorium:description" if from the vendor description). No quote -> verdict "unknown". \
NEVER infer.
2. A wide product range is NOT import evidence. Many factories have wide ranges. Distributing \
from one's own warehouse is NOT import evidence (the goods may be locally sourced). Operating an \
overseas factory is MANUFACTURING abroad, not importing-to-resell. Import evidence is an explicit \
claim of buying/bringing goods from abroad to sell: "we import", "official importer", \
"importamos", "importatore", "Importeur", "יבואן", "sourced from Asia", "our suppliers in China", \
named overseas supply partners, customs references.
3. Manufacturer evidence is explicit production: "our factory", "we manufacture", "nuestra \
fábrica", "production lines", "made in our plant". Being called "manufacturer" by an industry \
directory counts only as weak evidence — quote it from the description if that's all there is.
4. own_brand means brands the company OWNS (house brands, private labels they own). \
third_party_brands = brand names visibly carried that belong to OTHER manufacturers — list every \
one you can see (e.g. a pet wholesaler carrying Eukanuba, Pedigree, Hills). A retailer/distributor \
of third-party brands has own_brand "no" ONLY if you can list the third-party brands or quote \
text like "authorized distributor of X" / "the brands we represent".
5. catalog_fit judges the company's CORE business, not keyword co-occurrence:
   - "core" = main business is one of the verticals above (name it in matched_vertical)
   - "adjacent" = relevant products exist but as a side category or near-miss (food distributor \
that also lists some disposables; transit/industrial packaging vs foodservice disposables; \
irrigation PUMPS/MOTORS vs irrigation consumables; growing substrate vs agricultural plastics)
   - "none" = no real overlap
6. volume_signals: quote concrete scale evidence — warehouse m², branch/store counts, SKU counts, \
container/TEU references, export market counts, fleet size. high = clearly moves container-scale \
volume; low = boutique/small.
7. site_language: dominant language of the page text (ISO 639-1).

OUTPUT: strict JSON only, no prose, no markdown fences, exactly this shape:
{{
  "site_language": "<iso code or null>",
  "business_model": "importer" | "distributor" | "manufacturer" | "manufacturer_importer" | "third_party_brand_distributor" | "retailer" | "unknown",
  "imports": {{"verdict": "yes"|"no"|"unknown", "quote": "<verbatim or null>", "quote_en": "<english gloss or null>", "source_url": "<url or 'explorium:description' or null>"}},
  "own_brand": {{"verdict": "yes"|"no"|"unknown", "brand_names": ["<own brands>"], "quote": null, "quote_en": null, "source_url": null}},
  "manufacturer": {{"verdict": "yes"|"no"|"unknown", "quote": null, "quote_en": null, "source_url": null}},
  "third_party_brands": ["<brands carried that belong to others>"],
  "core_products": ["<what they actually sell, 3-8 items>"],
  "core_business_summary": "<one sentence: what is this company's main business>",
  "catalog_fit": {{"verdict": "core"|"adjacent"|"none", "matched_vertical": {json.dumps(VERTICALS)}[i] or null, "reason": "<short>"}},
  "volume_signals": {{"verdict": "high"|"medium"|"low"|"unknown", "quotes": ["<verbatim scale evidence>"]}}
}}"""

EMPTY_FRAGMENT = {"verdict": "unknown", "quote": None, "quote_en": None,
                  "source_url": None}


def empty_evidence(site_status: str, note: Optional[str] = None) -> Dict[str, Any]:
    return {
        "site_status": site_status,
        "site_language": None,
        "business_model": "unknown",
        "imports": dict(EMPTY_FRAGMENT),
        "own_brand": {**EMPTY_FRAGMENT, "brand_names": []},
        "manufacturer": dict(EMPTY_FRAGMENT),
        "third_party_brands": [],
        "core_products": [],
        "core_business_summary": None,
        "catalog_fit": {"verdict": "none", "matched_vertical": None,
                        "reason": note or "no evidence available"},
        "volume_signals": {"verdict": "unknown", "quotes": []},
        "extraction_notes": [note] if note else [],
    }


# ---------------------------------------------------------------------------
# Post-validation: the evidence-or-unknown invariant, enforced in code
# ---------------------------------------------------------------------------

def validate_evidence(ev: Dict[str, Any]) -> List[str]:
    """Rewrite quote-less yes/no verdicts to unknown. Returns audit notes."""
    notes: List[str] = []

    for axis in ("imports", "manufacturer"):
        frag = ev.get(axis) or {}
        if frag.get("verdict") in ("yes", "no") and not (frag.get("quote") or "").strip():
            notes.append(f"{axis}: '{frag.get('verdict')}' had no quote -> unknown")
            ev[axis] = {**EMPTY_FRAGMENT}

    ob = ev.get("own_brand") or {}
    if ob.get("verdict") == "yes" and not (ob.get("quote") or "").strip():
        notes.append("own_brand: 'yes' had no quote -> unknown")
        ev["own_brand"] = {**EMPTY_FRAGMENT, "brand_names": ob.get("brand_names") or []}
    elif ob.get("verdict") == "no" and not (ob.get("quote") or "").strip() \
            and not ev.get("third_party_brands"):
        # 'no own brand' needs either a quote or a visible third-party brand list
        notes.append("own_brand: 'no' had no quote and no third-party brands -> unknown")
        ev["own_brand"] = {**EMPTY_FRAGMENT, "brand_names": []}

    cf = ev.get("catalog_fit") or {}
    if cf.get("verdict") not in ("core", "adjacent", "none"):
        cf["verdict"] = "none"
    if cf.get("matched_vertical") not in VERTICALS:
        cf["matched_vertical"] = None
    ev["catalog_fit"] = cf

    if (ev.get("business_model") not in
            ("importer", "distributor", "manufacturer", "manufacturer_importer",
             "third_party_brand_distributor", "retailer", "unknown")):
        ev["business_model"] = "unknown"

    vs = ev.get("volume_signals") or {}
    if vs.get("verdict") not in ("high", "medium", "low", "unknown"):
        vs["verdict"] = "unknown"
    if vs.get("verdict") in ("high", "medium", "low") and not vs.get("quotes"):
        notes.append(f"volume_signals: '{vs.get('verdict')}' had no quotes -> unknown")
        vs["verdict"] = "unknown"
    ev["volume_signals"] = vs

    ev.setdefault("third_party_brands", [])
    ev.setdefault("core_products", [])
    ev["extraction_notes"] = (ev.get("extraction_notes") or []) + notes
    return notes


# ---------------------------------------------------------------------------
# Claude call
# ---------------------------------------------------------------------------

def _cost_usd(model: str, usage: Any) -> float:
    p = PRICING_USD_PER_MTOK.get(model, PRICING_USD_PER_MTOK[DEFAULT_MODEL])
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    cw = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cr = getattr(usage, "cache_read_input_tokens", 0) or 0
    return (inp * p["input"] + cw * p["cache_write"]
            + cr * p["cache_read"] + out * p["output"]) / 1_000_000


def _parse_response(text: str) -> Dict[str, Any]:
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        if s.startswith("json"):
            s = s[4:]
        if "```" in s:
            s = s.split("```", 1)[0]
    return json.loads(s)


def candidate_message(record: Dict[str, Any]) -> str:
    research = record.get("website_research") or {}
    pages = research.get("pages") or []
    parts = [
        "COMPANY: " + json.dumps({
            "name": record.get("name"),
            "country": record.get("country"),
            "industry": record.get("industry"),
            "naics_description": record.get("naics_description"),
            "business_type": record.get("business_type"),
            "employee_count": record.get("employee_count"),
            "revenue_usd": record.get("revenue_usd"),
            "website": record.get("website"),
        }, ensure_ascii=False, default=str),
        "\nEXPLORIUM DESCRIPTION (source_url: explorium:description):\n"
        + str(record.get("description") or "(none)"),
    ]
    budget = PAGES_CHAR_CAP
    for page in pages:
        if budget <= 0:
            break
        text = (page.get("text") or "")[:budget]
        if not text:
            continue
        parts.append(f"\nPAGE (source_url: {page.get('url')}):\n{text}")
        budget -= len(text)
    parts.append("\nReturn only the JSON described in OUTPUT.")
    return "\n".join(parts)


def extract_one(client: Any, model: str, record: Dict[str, Any]) -> tuple[Dict[str, Any], float]:
    user_msg = candidate_message(record)
    cost = 0.0
    for attempt in (1, 2):
        resp = client.messages.create(
            model=model,
            max_tokens=1500,
            temperature=0,
            system=[{"type": "text", "text": SYSTEM_PROMPT,
                     "cache_control": {"type": "ephemeral"}}],
            messages=[{"role": "user", "content": [
                {"type": "text", "text": user_msg}]}],
        )
        text = "".join(b.text for b in resp.content if b.type == "text")
        cost += _cost_usd(model, resp.usage)
        try:
            return _parse_response(text), cost
        except json.JSONDecodeError as e:
            if attempt == 2:
                raise RuntimeError(
                    f"Evidence response did not parse as JSON after retry:\n{text}") from e
            user_msg += ("\n\nYour previous response did not parse as JSON. "
                         "Return ONLY the JSON object.")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def extract_all(records: List[Dict[str, Any]], *, model: str, budget_usd: float,
                only_names: Optional[set] = None,
                limit: Optional[int] = None) -> List[Dict[str, Any]]:
    from anthropic import Anthropic
    load_dotenv(ROOT / ".env")
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise RuntimeError("ANTHROPIC_API_KEY not set (add to .env).")
    client = Anthropic()

    cumulative = 0.0
    done = 0
    for rec in records:
        name = rec.get("name", "(unnamed)")
        if only_names and name not in only_names:
            continue
        research = rec.get("website_research") or {}
        status = research.get("site_status") or (
            "ok" if research.get("ok") else "unreachable")

        if status == "dead":
            rec["evidence"] = empty_evidence(
                "dead", "site dead — skipped LLM extraction")
            print(f"  [evidence] {name:42} dead site, skipped", file=sys.stderr)
            continue

        try:
            ev, cost = extract_one(client, model, rec)
        except Exception as e:  # noqa: BLE001
            print(f"  [evidence] {name}: ERROR {e}", file=sys.stderr)
            rec["evidence"] = empty_evidence(status, f"extraction failed: {e}")
            rec["evidence"]["extraction_error"] = True
            continue
        ev["site_status"] = status
        if status != "ok":
            ev.setdefault("extraction_notes", []).append(
                "site unreachable — extracted from Explorium description only")
        validate_evidence(ev)
        rec["evidence"] = ev
        cumulative += cost
        done += 1
        print(f"  [evidence] {name:42} model={ev.get('business_model'):28} "
              f"imports={ev['imports']['verdict']:8} own_brand={ev['own_brand']['verdict']:8} "
              f"fit={ev['catalog_fit']['verdict']:9} ${cumulative:.4f}",
              file=sys.stderr)
        if cumulative > budget_usd:
            raise RuntimeError(
                f"Evidence extraction hit cost cap (${cumulative:.4f} > "
                f"${budget_usd:.2f}) after {done} companies. "
                f"Re-run with --budget HIGHER or set EVIDENCE_EXTRACT_USD_BUDGET.")
        if limit and done >= limit:
            break
        time.sleep(0.05)
    return records


if __name__ == "__main__":
    load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", required=True,
                        help="researched records JSON (from "
                             "research_company_website.py --records)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--budget", type=float,
                        default=float(os.getenv("EVIDENCE_EXTRACT_USD_BUDGET",
                                                DEFAULT_BUDGET_USD)))
    parser.add_argument("--only-names", default="")
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    records = json.loads(Path(args.records).read_text())
    if not isinstance(records, list):
        sys.exit("--records must contain a JSON list")
    only = {n.strip() for n in args.only_names.split(",") if n.strip()} or None

    out = extract_all(records, model=args.model, budget_usd=args.budget,
                      only_names=only, limit=args.limit)
    Path(args.out).write_text(json.dumps(out, indent=2, ensure_ascii=False))
    extracted = sum(1 for r in out if r.get("evidence"))
    print(f"\nwrote {len(out)} record(s) ({extracted} with evidence) "
          f"-> {args.out}", file=sys.stderr)
