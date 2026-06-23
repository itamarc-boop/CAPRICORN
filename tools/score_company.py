"""ICP scoring engine for Capricorn's market-analysis pipeline.

Deterministic. Given a company record it applies the hard gates, then the
100-point ICP score, then tier caps, then assigns a tier. No AI judgement,
no API calls — so the same input always yields the same output.

LOCKED v2 (2026-06, after iteration-3 feedback) — see
``workflows/icp_scoring_model.md``. The model is built around the client's two
conclusions: (A) the best customers IMPORT container volume ("LO MEJOR SON LOS
IMPORTADORES"), and (B) selling OWN brands qualifies a company ("ALGO QUE
CALIFICA MUCHO ES QUE VENDA SUS MARCAS PROPIAS"). Both axes are scored from
the quote-backed ``evidence`` block produced by ``tools/extract_evidence.py``
— never from keyword co-occurrence. The ONLY path to Tier 1 is quoted
evidence of both imports and own brand plus core catalog fit; anything
unknown caps the tier and flags what's missing for human review.

Company record (dict) — expected keys (all optional, missing == unknown):
    name                  str
    website               str
    industry / sector     str   free-text industry tag
    description           str
    business_type         str | list[str]   e.g. "distributor" or ["manufacturer"]
    employee_count        int
    revenue_usd           number   annual revenue in USD
    country               str
    city                  str
    linkedin_url          str
    is_exclusively_retail bool   set by enrichment when known
    is_government         bool
    is_cosmetic_packaging bool
    website_research      dict   output of research_company_website (fetch + site_status)
    evidence              dict   output of extract_evidence.py (imports / own_brand /
                                 manufacturer / catalog_fit / volume_signals, quote-backed)

Usage:
    from tools.score_company import score_company, sort_companies
    result = score_company(company_dict)

Run directly to see worked examples:
    python tools/score_company.py
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

_LABELS_PATH = Path(__file__).resolve().parent.parent / "feedback" / "iteration_1_labels.json"

# ---------------------------------------------------------------------------
# Locked configuration — see workflows/icp_scoring_model.md
# ---------------------------------------------------------------------------

# v2: the old INDUSTRY_TOKENS / BUSINESS_TYPE_WORDS / KEYWORD_FAMILIES
# criteria are gone. They scored keyword co-occurrence — which delivered food
# distributors as "foodservice disposables", a coco-substrate factory as
# "agriculture", and gave manufacturers the same +10 as importers. Product fit
# is now judged by the LLM evidence extractor (catalog_fit on the company's
# CORE business) and importer-vs-manufacturer is a quote-backed evidence axis.

# business_model values from extract_evidence.py that suggest a distribution
# motion (used only for partial credit when imports are unverified).
DISTRIBUTION_BUSINESS_MODELS = {"importer", "distributor"}

# Target countries (lower-cased) with their priority.
TARGET_COUNTRIES: Dict[str, str] = {
    "spain": "High",
    "united kingdom": "High", "uk": "High", "great britain": "High",
    "italy": "High",
    "israel": "High",
    "germany": "Medium-High",
    "switzerland": "Medium",
    "romania": "Medium",
    "greece": "Medium",
}

# Opt-in override for one-off test geographies (e.g. a Mexico pilot). The
# locked 8-country model is unchanged unless EXTRA_TARGET_COUNTRIES is set,
# e.g. EXTRA_TARGET_COUNTRIES="mexico:Medium,portugal:Medium".
import os as _os
for _entry in filter(None, _os.environ.get("EXTRA_TARGET_COUNTRIES", "").split(",")):
    _name, _, _prio = _entry.partition(":")
    TARGET_COUNTRIES[_name.strip().lower()] = (_prio.strip() or "Medium")
COUNTRY_PRIORITY_RANK = {"High": 0, "Medium-High": 1, "Medium": 2}

# Named top retailers that are always excluded ("ALDI, Carrefour, LIDL, etc.").
# Extend as new ones are encountered.
TOP_RETAILERS = {
    "aldi", "carrefour", "lidl", "tesco", "walmart", "kaufland", "rewe",
    "edeka", "auchan", "mercadona", "sainsbury's", "sainsburys", "asda",
    "costco", "ahold", "leclerc", "intermarche", "metro ag",
}

# Out-of-scope industries (calibration 2026-05-20): keyword discovery surfaces
# agencies, software, hospitality, finance, etc. — service firms that merely
# mention ICP product words. Matched as substrings against the industry tag.
OUT_OF_SCOPE_INDUSTRY = [
    "advertising", "marketing services", "digital marketing", "public relations",
    "market research", "design services",
    "software", "saas", "information technology", "it services",
    "computer software", "internet publishing", "technology, information",
    "hospitality", "hotels", "restaurants", "travel arrangements", "leisure",
    "food and beverage services",
    "financial services", "banking", "insurance", "investment management",
    "capital markets", "corporate finance", "accounting", "venture capital",
    "management consulting", "business consulting",
    "staffing and recruiting", "human resources services",
    "media production", "broadcast media", "online media", "publishing",
    "entertainment", "music",
    "certification", "professional training and coaching",
    "education", "higher education", "law practice", "legal services",
    "real estate", "hospital", "wellness and fitness",
    "machinery manufacturing", "industrial machinery",
]

# Score thresholds
TIER_1_MIN = 70
TIER_2_MIN = 45
TIER_3_MIN = 25

# Display bands per tier. The raw 0-100 sum (total_score) is frozen BEFORE the
# evidence caps + BDR-judge override can lower the tier, so a high-scoring
# company can land in a lower tier (e.g. a manufacturer scoring 97 on evidence
# that the judge correctly downgrades to Tier 3). Showing 97 next to "Tier 3" on
# a client row looks broken, so the DISPLAYED score is clamped into the final
# tier's band. The true sum stays in total_score for internal sort/audit.
_TIER_BANDS = {
    "Tier 1": (TIER_1_MIN, 100),
    "Tier 2": (TIER_2_MIN, TIER_1_MIN - 1),
    "Tier 3": (TIER_3_MIN, TIER_2_MIN - 1),
}


def _display_score(total, tier):
    """Clamp the raw score into the final tier's band so they never contradict."""
    band = _TIER_BANDS.get(tier or "")
    if not band:
        return total
    lo, hi = band
    return min(max(total, lo), hi)

_MILLION = 1_000_000

# Iteration-1-feedback-driven negative keywords (loaded from the labels file so
# the playbook + gate stay in sync). Matched as case-insensitive substrings
# against the company's combined industry/NAICS/description text.
def _load_blacklist_keywords() -> List[str]:
    try:
        return json.loads(_LABELS_PATH.read_text()).get("blacklist_keywords", [])
    except FileNotFoundError:
        return []
    except json.JSONDecodeError:
        return []

BLACKLIST_KEYWORDS: List[str] = [k.lower() for k in _load_blacklist_keywords()]

# Verdict from the BDR judge → tier name. The judge can override the
# deterministic tier; "reject" drops the company even if it would have scored.
_JUDGE_TIER = {"t1": "Tier 1", "t2": "Tier 2", "t3": "Tier 3", "reject": None}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _norm(value: Any) -> str:
    return str(value or "").strip().lower()


def _text_blob(company: Dict[str, Any]) -> str:
    """All free-text fields of a company joined and lower-cased."""
    parts = [company.get("name"), company.get("industry"),
             company.get("sector"), company.get("description")]
    bt = company.get("business_type")
    parts.extend(bt if isinstance(bt, (list, tuple)) else [bt])
    return " ".join(_norm(p) for p in parts if p)


def _evidence(company: Dict[str, Any]) -> Dict[str, Any]:
    """The extract_evidence.py block, or an all-unknown stand-in."""
    return company.get("evidence") or {}


def _axis_verdict(company: Dict[str, Any], axis: str) -> str:
    frag = _evidence(company).get(axis) or {}
    v = _norm(frag.get("verdict"))
    return v if v in ("yes", "no") else "unknown"


def _site_status(company: Dict[str, Any]) -> str:
    research = company.get("website_research") or {}
    status = _norm(research.get("site_status"))
    if status in ("ok", "dead", "unreachable"):
        return status
    return "ok" if research.get("ok") else "unknown"


# ---------------------------------------------------------------------------
# Stage 0 — hard gates
# ---------------------------------------------------------------------------

def _check_gates(company: Dict[str, Any]) -> Tuple[List[str], List[str]]:
    """Return (drop_reasons, flags). Non-empty drop_reasons == company dropped."""
    drop_reasons: List[str] = []
    flags: List[str] = []
    blob = _text_blob(company)
    industry = _norm(company.get("industry"))

    # Size gates
    emp = company.get("employee_count")
    if emp is None:
        flags.append("employee count unknown — size gate not applied")
    elif emp < 10:
        drop_reasons.append(f"under 10 employees ({emp})")
    elif emp > 2000:
        drop_reasons.append(f"over 2,000 employees ({emp})")

    # Named top retailer
    name = _norm(company.get("name"))
    name_words = set(re.findall(r"[a-z']+", name))
    for retailer in TOP_RETAILERS:
        if (" " in retailer and retailer in name) or \
           (" " not in retailer and retailer in name_words):
            drop_reasons.append(f"named top retailer ({retailer})")
            break

    # Exclusively-retail company
    if company.get("is_exclusively_retail") is True:
        drop_reasons.append("exclusively-retail company")
    else:
        bt = company.get("business_type")
        bt_set = {_norm(x) for x in (bt if isinstance(bt, (list, tuple)) else [bt]) if x}
        if bt_set and bt_set <= {"retailer", "retail"}:
            drop_reasons.append("exclusively-retail company (business type)")

    # Government body
    if company.get("is_government") is True or \
            industry in ("government", "public administration", "public sector"):
        drop_reasons.append("government body")

    # Pure cosmetic-packaging company
    if company.get("is_cosmetic_packaging") is True or \
            "cosmetic packaging" in industry or "cosmetics packaging" in industry:
        drop_reasons.append("pure cosmetic-packaging company")
    elif "cosmetic packaging" in blob or "cosmetics packaging" in blob:
        flags.append("mentions 'cosmetic packaging' — confirm it is not a pure "
                     "cosmetic-packaging company (excluded)")

    # Out-of-scope industry — service firms that merely mention ICP words
    industry_text = " ".join(_norm(company.get(k)) for k in
                             ("industry", "sector", "naics_description"))
    out_of_scope = next((s for s in OUT_OF_SCOPE_INDUSTRY if s in industry_text), None)
    if out_of_scope:
        drop_reasons.append(f"out-of-scope industry ('{out_of_scope}')")

    # Iteration-1 negative-keyword blacklist (agrochemicals, fragrance,
    # ingredient suppliers, contract manufacturers, cattle feed, construction
    # chemistry, ...) — the BDR judge would reject these anyway; drop early.
    blacklist_text = industry_text + " " + _norm(company.get("description"))
    blacklisted = next((k for k in BLACKLIST_KEYWORDS if k in blacklist_text), None)
    if blacklisted:
        drop_reasons.append(f"blacklisted keyword ('{blacklisted}')")

    # Target-country gate — Explorium's country filter leaks; a company outside
    # all 8 ICP countries is not a Capricorn lead.
    country = _norm(company.get("country"))
    if not country:
        flags.append("country unknown — target-country gate not applied")
    elif country not in TARGET_COUNTRIES:
        drop_reasons.append(
            f"outside the 8 target countries ({company.get('country')})")

    # Dead website — iteration 3 delivered a company whose domain didn't
    # resolve ("Me aparece como inexistente su página web").
    if _site_status(company) == "dead":
        drop_reasons.append("website unreachable (dead site)")

    # Pure manufacturer with confirmed no-import motion. Client iteration-3:
    # "Fábrica full, no importan nada" / "waste of time". imports == "no" is
    # quote-backed (extract_evidence enforces that); unknown only caps the
    # tier (see _apply_tier_caps), it never drops.
    if _axis_verdict(company, "manufacturer") == "yes" and \
            _axis_verdict(company, "imports") == "no":
        drop_reasons.append("pure manufacturer, no import motion")

    # v2: the old warehouse and private-label-only HARD gates are demoted.
    # Warehouse never resolved from public sites (always "unknown") and
    # volume_signals supersedes it; third-party-brand resellers are now a
    # Tier-3 cap (Harpo precedent: "podría ser interesante", not a drop) with
    # the judge deciding reject for global-brand distributors.
    research = company.get("website_research") or {}
    if _norm(research.get("warehouse")) == "no":
        flags.append("site says no warehouse / drop-ship — confirm fulfilment "
                     "model before contacting")

    return drop_reasons, flags


# ---------------------------------------------------------------------------
# Stage 1 — scoring criteria
# ---------------------------------------------------------------------------

def _import_points(company: Dict[str, Any]) -> Tuple[int, str]:
    """Axis A (30 pts): does the company import / buy volume to sell?"""
    frag = _evidence(company).get("imports") or {}
    verdict = _axis_verdict(company, "imports")
    if verdict == "yes":
        return 30, f"import evidence: \"{str(frag.get('quote'))[:90]}\""
    model = _norm(_evidence(company).get("business_model"))
    if verdict == "unknown" and model in DISTRIBUTION_BUSINESS_MODELS:
        return 10, f"imports unverified, but business model is '{model}'"
    if verdict == "no":
        return 0, "confirmed does not import"
    return 0, "no import evidence"


def _own_brand_points(company: Dict[str, Any]) -> Tuple[int, str]:
    """Axis B (25 pts): does it sell under brand(s) it owns?"""
    ev = _evidence(company)
    frag = ev.get("own_brand") or {}
    verdict = _axis_verdict(company, "own_brand")
    brands = ", ".join((frag.get("brand_names") or [])[:4]) or "unnamed"
    if verdict == "yes" and not ev.get("third_party_brands"):
        return 25, f"own brand(s): {brands}"
    if verdict == "yes":
        return 12, f"own brand(s) ({brands}) but also carries third-party lines"
    if verdict == "no":
        return 0, "no own brand — third-party brand reseller"
    return 0, "own-brand status unknown"


def _catalog_fit_points(company: Dict[str, Any]) -> Tuple[int, str]:
    """Core-business product fit (25 pts) — judged on the CORE business,
    not keyword co-occurrence (iteration-3: food distributors are not
    foodservice-disposables companies)."""
    cf = _evidence(company).get("catalog_fit") or {}
    verdict = _norm(cf.get("verdict"))
    vertical = cf.get("matched_vertical") or "unspecified vertical"
    if verdict == "core":
        return 25, f"core business in {vertical}"
    if verdict == "adjacent":
        return 10, f"adjacent fit only: {str(cf.get('reason'))[:80]}"
    return 0, f"no catalog fit: {str(cf.get('reason'))[:80]}"


def _country_points(company: Dict[str, Any]) -> Tuple[int, str]:
    country = _norm(company.get("country"))
    if country in TARGET_COUNTRIES:
        return 10, f"target country ({company.get('country')})"
    return 0, f"not a target country ({company.get('country') or 'unknown'})"


def _size_points(company: Dict[str, Any]) -> Tuple[int, str]:
    """Employees + revenue, 5 pts each (2 in stretch ranges)."""
    pts = 0
    details: List[str] = []
    emp = company.get("employee_count")
    if emp is None:
        details.append("employees unknown")
    elif 30 <= emp <= 500:
        pts += 5
        details.append(f"{emp} employees (core)")
    elif 10 <= emp < 30 or 500 < emp <= 1000:
        pts += 2
        details.append(f"{emp} employees (stretch)")
    else:
        details.append(f"{emp} employees (outside ranges)")
    rev = company.get("revenue_usd")
    if rev is None:
        details.append("revenue unknown")
    elif 20 * _MILLION <= rev <= 200 * _MILLION:
        pts += 5
        details.append("revenue $20-200M (core)")
    elif 5 * _MILLION <= rev < 20 * _MILLION or 200 * _MILLION < rev <= 400 * _MILLION:
        pts += 2
        details.append("revenue in stretch range")
    else:
        details.append("revenue outside ranges")
    return pts, "; ".join(details)


_CRITERIA = (
    ("import_evidence", _import_points),
    ("own_brand", _own_brand_points),
    ("catalog_fit", _catalog_fit_points),
    ("target_country", _country_points),
    ("size", _size_points),
)


# ---------------------------------------------------------------------------
# Stage 2 — tier caps (where "unknown evidence caps the tier" lives)
# ---------------------------------------------------------------------------

_TIER_RANK = {"Tier 1": 0, "Tier 2": 1, "Tier 3": 2}
_RANK_TIER = {v: k for k, v in _TIER_RANK.items()}


def _apply_tier_caps(company: Dict[str, Any],
                     tier: Optional[str]) -> Tuple[Optional[str], List[str]]:
    """Cap the deterministic tier based on evidence completeness.

    The ONLY path to Tier 1 is quoted evidence of imports AND own brand AND
    core catalog fit. The BDR judge may still promote an evidenced candidate
    afterwards; its own backstop blocks unevidenced t1 verdicts.
    """
    if tier is None:
        return None, []
    caps: List[Tuple[str, str]] = []   # (max_tier, flag text)

    imports_v = _axis_verdict(company, "imports")
    own_brand_v = _axis_verdict(company, "own_brand")
    manufacturer_v = _axis_verdict(company, "manufacturer")
    cf = _norm((_evidence(company).get("catalog_fit") or {}).get("verdict"))

    if _site_status(company) == "unreachable":
        caps.append(("Tier 3", "site unreachable — evidence from vendor "
                               "description only; needs human check"))
    if manufacturer_v == "yes" and imports_v == "unknown":
        caps.append(("Tier 3", "manufacturer with unverified import motion — "
                               "needs human check"))
    if own_brand_v == "no":
        caps.append(("Tier 3", "third-party brand reseller — low priority"))
    if cf == "adjacent":
        caps.append(("Tier 2", "catalog fit is adjacent, not core business"))
    elif cf != "core":
        caps.append(("Tier 3", "no core catalog fit"))
    if imports_v != "yes" or own_brand_v != "yes":
        missing = [axis for axis, v in (("imports", imports_v),
                                        ("own brand", own_brand_v)) if v != "yes"]
        caps.append(("Tier 2", "T1 requires quoted evidence of imports + own "
                               f"brand; missing: {', '.join(missing)} — "
                               "needs human check"))

    earned_rank = _TIER_RANK[tier]
    rank = earned_rank
    flags: List[str] = []
    for max_tier, note in caps:
        cap_rank = _TIER_RANK[max_tier]
        rank = max(rank, cap_rank)
        if cap_rank >= earned_rank:   # cap binds at or below the earned tier
            flags.append(f"tier cap {max_tier}: {note}")
    return _RANK_TIER[rank], flags


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def score_company(company: Dict[str, Any]) -> Dict[str, Any]:
    """Apply gates + scoring + tier to one company record."""
    name = company.get("name", "(unnamed)")
    country = company.get("country")
    priority = TARGET_COUNTRIES.get(_norm(country))
    drop_reasons, flags = _check_gates(company)

    if drop_reasons:
        return {
            "name": name, "gate_passed": False,
            "drop_reasons": drop_reasons, "flags": flags,
            "criterion_scores": {}, "criterion_detail": {},
            "total_score": None, "tier": None, "qualified": False,
            "country": country, "country_priority": priority,
        }

    scores: Dict[str, int] = {}
    detail: Dict[str, str] = {}
    for key, fn in _CRITERIA:
        scores[key], detail[key] = fn(company)
    total = sum(scores.values())

    if total >= TIER_1_MIN:
        deterministic_tier = "Tier 1"
    elif total >= TIER_2_MIN:
        deterministic_tier = "Tier 2"
    elif total >= TIER_3_MIN:
        deterministic_tier = "Tier 3"
    else:
        deterministic_tier = None
        flags.append(f"score {total} below qualifying minimum of {TIER_3_MIN}")

    # Stage 2: evidence-completeness caps. The only path to Tier 1 is quoted
    # evidence of imports + own brand + core catalog fit.
    deterministic_tier, cap_flags = _apply_tier_caps(company, deterministic_tier)
    flags.extend(cap_flags)

    # BDR-judge override: the LLM playbook can downgrade or reject a candidate
    # the deterministic score would have qualified. See workflows/bdr_judge.md.
    final_tier = deterministic_tier
    judgment = company.get("bdr_judgment") or {}
    verdict = (judgment.get("verdict") or "").lower()
    if verdict in _JUDGE_TIER:
        final_tier = _JUDGE_TIER[verdict]
        reason = judgment.get("reason", "")
        if final_tier is None:
            drop_reasons.append(
                f"BDR judge rejected: {judgment.get('matched_pattern', 'none')}"
                + (f" — {reason}" if reason else ""))
        elif final_tier != deterministic_tier:
            flags.append(
                f"BDR judge override: {deterministic_tier} -> {final_tier} "
                f"({judgment.get('matched_pattern', 'none')})")

    if drop_reasons:
        return {
            "name": name, "gate_passed": False,
            "drop_reasons": drop_reasons, "flags": flags,
            "criterion_scores": scores, "criterion_detail": detail,
            "total_score": total, "display_score": total,
            "tier": None, "qualified": False,
            "country": country, "country_priority": priority,
            "deterministic_tier": deterministic_tier,
        }

    return {
        "name": name, "gate_passed": True,
        "drop_reasons": [], "flags": flags,
        "criterion_scores": scores, "criterion_detail": detail,
        "total_score": total, "display_score": _display_score(total, final_tier),
        "tier": final_tier,
        "qualified": final_tier is not None,
        "country": country, "country_priority": priority,
        "deterministic_tier": deterministic_tier,
    }


def sort_key(result: Dict[str, Any]) -> Tuple[int, int, int]:
    tier_rank = {"Tier 1": 0, "Tier 2": 1, "Tier 3": 2}.get(result.get("tier"), 9)
    prio_rank = COUNTRY_PRIORITY_RANK.get(result.get("country_priority"), 9)
    return (tier_rank, prio_rank, -(result.get("total_score") or 0))


def sort_companies(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Sort scored results: tier, then country priority, then score desc."""
    return sorted(results, key=sort_key)


# ---------------------------------------------------------------------------
# Worked examples
# ---------------------------------------------------------------------------

def _ev(imports="unknown", own_brand="unknown", manufacturer="unknown",
        fit="none", vertical=None, model="unknown", third_party=None,
        iq=None, oq=None, mq=None):
    """Compact evidence-block builder for the worked examples."""
    return {
        "business_model": model,
        "imports": {"verdict": imports, "quote": iq},
        "own_brand": {"verdict": own_brand, "quote": oq, "brand_names": []},
        "manufacturer": {"verdict": manufacturer, "quote": mq},
        "third_party_brands": third_party or [],
        "catalog_fit": {"verdict": fit, "matched_vertical": vertical,
                        "reason": "sample"},
        "volume_signals": {"verdict": "unknown", "quotes": []},
    }


_SAMPLES = [
    {  # clean Tier 1 — quoted imports + own brand + core fit (Leef-like)
        "name": "Iberian Pet Supplies S.L.", "website": "https://example-pet.es",
        "industry": "Pet food", "business_type": ["importer", "distributor"],
        "employee_count": 180, "revenue_usd": 60_000_000, "country": "Spain",
        "description": "Importer and wholesaler of own-brand pet food.",
        "website_research": {"site_status": "ok", "ok": True},
        "evidence": _ev(imports="yes", own_brand="yes", fit="core",
                        vertical="pet-food", model="importer",
                        iq="importamos desde Asia contenedores completos",
                        oq="nuestra marca propia PetIber"),
    },
    {  # Tier 2 — distributor, import status unverified (Green-tech-like)
        "name": "Greenfield Supplies Ltd", "industry": "Landscaping supplies",
        "employee_count": 120, "revenue_usd": 30_000_000,
        "country": "United Kingdom",
        "website_research": {"site_status": "ok", "ok": True},
        "evidence": _ev(own_brand="yes", fit="core", vertical="agriculture",
                        model="distributor", oq="our own GT range"),
    },
    {  # Tier 3 cap — manufacturer, imports unverified (TATAY-like)
        "name": "Plasticos del Sur S.A.", "industry": "Plastics manufacturing",
        "business_type": "manufacturer", "employee_count": 250,
        "revenue_usd": 80_000_000, "country": "Spain",
        "website_research": {"site_status": "ok", "ok": True},
        "evidence": _ev(manufacturer="yes", own_brand="yes", fit="core",
                        vertical="agriculture", model="manufacturer",
                        mq="fabricantes desde 1949", oq="marca propia"),
    },
    {  # gate drop — pure manufacturer, confirmed no imports
        "name": "Fabrica Total SL", "industry": "Plastics manufacturing",
        "employee_count": 300, "revenue_usd": 90_000_000, "country": "Spain",
        "website_research": {"site_status": "ok", "ok": True},
        "evidence": _ev(imports="no", manufacturer="yes", fit="core",
                        vertical="agriculture", model="manufacturer",
                        iq="producimos el 100% en nuestra planta",
                        mq="nuestra fábrica de 40.000 m²"),
    },
    {  # Tier 3 cap — third-party brand reseller with product fit (Harpo-like)
        "name": "MultiBrand Distributors Ltd", "industry": "Cleaning supplies",
        "business_type": "distributor", "employee_count": 120,
        "revenue_usd": 40_000_000, "country": "United Kingdom",
        "website_research": {"site_status": "ok", "ok": True},
        "evidence": _ev(imports="yes", own_brand="no", fit="core",
                        vertical="cleaning-supplies",
                        model="third_party_brand_distributor",
                        third_party=["BrandA", "BrandB"],
                        iq="we import directly", oq="authorized distributor of"),
    },
    {  # gate drop — dead website (Geomembrane Bresciani case)
        "name": "Ghost Membranes Srl", "industry": "Geotextiles",
        "employee_count": 50, "country": "Italy",
        "website_research": {"site_status": "dead", "ok": False,
                             "error": "dns failure"},
        "evidence": None,
    },
    {  # Tier 2 cap — adjacent fit only (RAJAPACK-like would score lower)
        "name": "PackAll GmbH", "industry": "Packaging distribution",
        "employee_count": 200, "revenue_usd": 70_000_000, "country": "Germany",
        "website_research": {"site_status": "ok", "ok": True},
        "evidence": _ev(imports="yes", own_brand="yes", fit="adjacent",
                        model="distributor", iq="wir importieren direkt",
                        oq="unsere Eigenmarke"),
    },
    {  # gated out — too big
        "name": "GlobalCorp Manufacturing", "industry": "Cosmetics",
        "employee_count": 4200, "country": "Germany",
    },
    {  # gated out — out-of-scope industry (keyword-discovery noise)
        "name": "BrightReach Marketing", "industry": "advertising services",
        "description": "We help cosmetics and pet food brands grow their sales.",
        "employee_count": 80, "country": "Spain",
    },
    {  # gated out — outside the 8 target countries
        "name": "Mumbai Cosmetics Pvt Ltd", "industry": "Cosmetics manufacturing",
        "business_type": "manufacturer", "employee_count": 300,
        "revenue_usd": 50_000_000, "country": "India",
    },
]


if __name__ == "__main__":
    results = [score_company(c) for c in _SAMPLES]
    for r in sort_companies(results):
        print("=" * 66)
        print(f"{r['name']}  [{r['country']}]")
        if not r["gate_passed"]:
            print(f"  DROPPED — {'; '.join(r['drop_reasons'])}")
        else:
            print(f"  {r['tier'] or 'below minimum'}   score {r['total_score']}/100")
            for key, pts in r["criterion_scores"].items():
                print(f"    {key:16}{pts:3}   ({r['criterion_detail'][key]})")
        for flag in r["flags"]:
            print(f"  (!) {flag}")
    print("=" * 66)
