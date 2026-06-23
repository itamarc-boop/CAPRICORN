"""Merge scored companies + their contacts into the final Capricorn lead rows.

Inputs:
  --companies  JSON list; each item is a company record (from
               explorium_to_record.py, with website_research attached) plus a
               `score` key holding the tools/score_company.py result dict.
  --contacts   JSON; either {business_id: [contact, ...]} or a flat list of
               contacts each carrying `business_id`. Contact fields used:
               full_name, job_title, linkedin_url, email, phone.

Output: one flat row per contact (company fields denormalized); a qualified
company with no contacts still produces one row. Gate-dropped / below-minimum
companies are kept out of the leads and appended to a reject archive
(`.tmp/rejected_archive.json`) — the client asked for rejects to be archived.

Writes <out>.json and <out>.csv.

Usage:
    python tools/build_lead_rows.py --companies .tmp/scored.json \
        --contacts .tmp/contacts.json --out .tmp/leads_2026-05-20
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Tuple

TMP = Path(__file__).resolve().parent.parent / ".tmp"
REJECT_ARCHIVE = TMP / "rejected_archive.json"

# Iteration-4: every lead carries its verbatim evidence so the client can
# verify a Tier 1 in 30 seconds ("Claude dice que importan... sin un claim
# real" must never happen again).
ROW_FIELDS = [
    "company_name", "website", "industry", "employee_count", "estimated_revenue",
    "country", "city", "linkedin_company_page", "description",
    "icp_tier", "icp_score",
    "business_model", "import_evidence", "own_brand_evidence",
    "third_party_brands", "evidence_urls",
    "what_to_sell_gaps", "judge_reason", "needs_human_check",
    "contact_name", "contact_title", "contact_linkedin_url",
    "contact_email", "contact_phone",
]

_EMPTY_CONTACT = {"contact_name": "", "contact_title": "",
                  "contact_linkedin_url": "", "contact_email": "",
                  "contact_phone": ""}


def _contacts_by_business(contacts: Any) -> Dict[str, List[Dict[str, Any]]]:
    if isinstance(contacts, dict):
        return {str(k): v for k, v in contacts.items()}
    by: Dict[str, List[Dict[str, Any]]] = {}
    for c in contacts or []:
        by.setdefault(str(c.get("business_id") or ""), []).append(c)
    return by


def _evidence_summary(fragment: Dict[str, Any]) -> str:
    """'yes: "<quote>"' / 'no: ...' / 'unverified' for a lead-row cell."""
    verdict = str(fragment.get("verdict") or "unknown")
    if verdict == "unknown":
        return "unverified"
    quote = (fragment.get("quote") or "").strip()
    gloss = (fragment.get("quote_en") or "").strip()
    text = f'{verdict}: "{quote[:180]}"' if quote else verdict
    if gloss and gloss.lower() != quote.lower():
        text += f" ({gloss[:120]})"
    return text


def _client_style(value: Any) -> Any:
    """Client-facing style rules (see memory client-report-style): no em
    dashes anywhere, hyphens for numeric ranges. Applied to every text cell
    — LLM-written reasons and score flags otherwise carry em dashes in."""
    if not isinstance(value, str):
        return value
    value = value.replace(" — ", ", ").replace("—", ", ")
    return value.replace("–", "-")


def _company_base(item: Dict[str, Any], score: Dict[str, Any]) -> Dict[str, Any]:
    judgment = item.get("bdr_judgment") or {}
    what_to_sell = judgment.get("what_to_sell") or []
    if isinstance(what_to_sell, list):
        what_to_sell_str = "; ".join(str(s) for s in what_to_sell)
    else:
        what_to_sell_str = str(what_to_sell)
    evidence = item.get("evidence") or {}
    imports = evidence.get("imports") or {}
    own_brand = evidence.get("own_brand") or {}
    brands = own_brand.get("brand_names") or []
    own_brand_text = _evidence_summary(own_brand)
    if brands:
        own_brand_text += f" [brands: {', '.join(str(b) for b in brands[:5])}]"
    urls = sorted({u for u in (imports.get("source_url"),
                               own_brand.get("source_url")) if u})
    return {
        "explorium_business_id": item.get("explorium_business_id") or "",
        "company_name": item.get("name"),
        "website": item.get("website"),
        "industry": item.get("industry"),
        "employee_count": item.get("employee_count_range") or item.get("employee_count"),
        "estimated_revenue": item.get("revenue_range") or item.get("revenue_usd"),
        "country": item.get("country"),
        "city": item.get("city"),
        "linkedin_company_page": item.get("linkedin_url"),
        "description": item.get("description"),
        "icp_tier": score.get("tier"),
        "icp_score": score.get("display_score", score.get("total_score")),
        "business_model": evidence.get("business_model") or "unknown",
        "import_evidence": _evidence_summary(imports),
        "own_brand_evidence": own_brand_text,
        "third_party_brands": "; ".join(
            str(b) for b in (evidence.get("third_party_brands") or [])[:8]),
        "evidence_urls": "; ".join(urls),
        "what_to_sell_gaps": what_to_sell_str,
        "judge_reason": judgment.get("reason", ""),
        "needs_human_check": "; ".join(score.get("flags") or []),
    }


def build(companies: List[Dict[str, Any]],
          contacts: Any) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    by_biz = _contacts_by_business(contacts)
    rows: List[Dict[str, Any]] = []
    rejects: List[Dict[str, Any]] = []

    for item in companies:
        score = item.get("score") or {}
        if not score.get("qualified"):
            reason = "; ".join(score.get("drop_reasons") or [])
            if not reason:
                reason = (f"score {score.get('total_score')} below minimum"
                          if score.get("gate_passed") else "not scored")
            rejects.append({"company_name": item.get("name"),
                            "website": item.get("website"), "reason": reason})
            continue

        base = _company_base(item, score)
        biz_contacts = by_biz.get(str(item.get("explorium_business_id") or ""), [])
        if not biz_contacts:
            rows.append({**base, **_EMPTY_CONTACT})
        for c in biz_contacts:
            email = c.get("email") or ""
            if not email and c.get("company_email"):
                email = f"{c['company_email']} (company inbox)"
            rows.append({**base,
                "contact_name": c.get("full_name") or c.get("name") or "",
                "contact_title": c.get("job_title") or c.get("title") or "",
                "contact_linkedin_url": c.get("linkedin_url") or c.get("linkedin") or "",
                "contact_email": email,
                "contact_phone": c.get("phone") or c.get("phone_number") or "",
            })
    rows = [{k: _client_style(v) for k, v in row.items()} for row in rows]
    return rows, rejects


def archive_rejects(rejects: List[Dict[str, Any]]) -> None:
    if not rejects:
        return
    existing: List[Dict[str, Any]] = []
    if REJECT_ARCHIVE.exists():
        try:
            existing = json.loads(REJECT_ARCHIVE.read_text()) or []
        except json.JSONDecodeError:
            existing = []
    REJECT_ARCHIVE.parent.mkdir(parents=True, exist_ok=True)
    REJECT_ARCHIVE.write_text(
        json.dumps(existing + rejects, indent=2, ensure_ascii=False))


def write_outputs(rows: List[Dict[str, Any]], out: str) -> None:
    out_path = Path(out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.with_suffix(".json").write_text(
        json.dumps(rows, indent=2, ensure_ascii=False))
    with out_path.with_suffix(".csv").open("w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=ROW_FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


_DEMO_COMPANIES = [
    {"explorium_business_id": "abc123", "name": "Iberia Pet Foods S.L.",
     "website": "iberiapet.es", "industry": "animal feed manufacturing",
     "employee_count_range": "51-200", "revenue_range": "25M-75M",
     "country": "Spain", "city": "Valencia", "description": "Private-label pet food.",
     "score": {"qualified": True, "tier": "Tier 1", "total_score": 90,
               "flags": ["warehouse not confirmed — needs human check"]}},
    {"explorium_business_id": "def456", "name": "MultiBrand Distributors Ltd",
     "website": "multibrand.co.uk", "country": "United Kingdom",
     "score": {"qualified": False, "gate_passed": False,
               "drop_reasons": ["sells third-party brands (not private-label only)"]}},
]
_DEMO_CONTACTS = {"abc123": [
    {"full_name": "Ana Ruiz", "job_title": "Procurement Manager",
     "email": "a.ruiz@iberiapet.es", "linkedin_url": "https://linkedin.com/in/anaruiz"}]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--companies")
    parser.add_argument("--contacts")
    parser.add_argument("--out", default=str(TMP / "leads_demo"))
    args = parser.parse_args()

    if args.companies:
        companies = json.loads(Path(args.companies).read_text())
        contacts = json.loads(Path(args.contacts).read_text()) if args.contacts else []
    else:
        print("No --companies given — running the built-in demo.\n", file=sys.stderr)
        companies, contacts = _DEMO_COMPANIES, _DEMO_CONTACTS

    rows, rejects = build(companies, contacts)
    write_outputs(rows, args.out)
    archive_rejects(rejects)
    print(f"build_lead_rows: {len(rows)} lead row(s) -> {args.out}.json/.csv ; "
          f"{len(rejects)} reject(s) archived.", file=sys.stderr)
    print(json.dumps(rows, indent=2, ensure_ascii=False))
