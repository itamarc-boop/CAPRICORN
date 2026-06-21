"""Map a saved Explorium `enrich-business` response into the company-record
shape that tools/score_company.py expects.

The Explorium MCP wraps its response as `[{"type": "text", "text": "<json>"}]`,
and the inner JSON holds `enrichment_results.firmographics` as a JSON-encoded
string whose `data` is a list of `{business_id, data: {...}}`.

This tool is defensive about input shape — it accepts:
  * the raw MCP envelope,
  * the unwrapped `{"enrichment_results": {...}}` object,
  * a bare `{"data": [...]}` firmographics blob,
  * or a plain list of firmographics records.

Employee/revenue ranges are converted to a representative integer midpoint so
score_company.py can apply its numeric gates and bands.

Usage:
    python tools/explorium_to_record.py .tmp/enriched.json > .tmp/records.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List

# Explorium employee-count buckets -> representative midpoint.
EMP_RANGE_TO_MIDPOINT = {
    "1-10": 5, "11-50": 30, "51-200": 125, "201-500": 350,
    "501-1000": 750, "1001-5000": 3000, "5001-10000": 7500, "10001+": 15000,
}

# Explorium revenue buckets -> representative USD midpoint.
REVENUE_RANGE_TO_USD = {
    "0-500K": 250_000, "500K-1M": 750_000, "1M-5M": 3_000_000,
    "5M-10M": 7_500_000, "10M-25M": 17_500_000, "25M-75M": 50_000_000,
    "75M-200M": 137_500_000, "200M-500M": 350_000_000, "500M-1B": 750_000_000,
    "1B-10B": 5_000_000_000, "10B-100B": 55_000_000_000,
    "100B-1T": 550_000_000_000, "1T-10T": 5_000_000_000_000, "10T+": 10_000_000_000_000,
}

# Firmographics field names vary slightly across enrichment versions — try each.
EMP_KEYS = ("number_of_employees_range", "company_size", "employee_range")
REV_KEYS = ("revenue_range", "annual_revenue_range", "company_revenue",
            "yearly_revenue_range", "revenue")


def firmographics_records(raw_text: str) -> List[Dict[str, Any]]:
    """Pull the list of firmographics records out of whatever shape the file is."""
    obj: Any = json.loads(raw_text)

    # MCP text envelope: [{"type": "text", "text": "<json>"}]
    if (isinstance(obj, list) and obj and isinstance(obj[0], dict)
            and obj[0].get("type") == "text"):
        obj = json.loads(obj[0]["text"])

    # enrich-business inner object: {"enrichment_results": {"firmographics": "<json>"}}
    if isinstance(obj, dict) and "enrichment_results" in obj:
        firm = obj["enrichment_results"].get("firmographics")
        if isinstance(firm, str):
            firm = json.loads(firm)
        return (firm or {}).get("data") or []

    # bare firmographics blob: {"data": [...]}
    if isinstance(obj, dict) and "data" in obj:
        return obj["data"] or []

    # already a plain list of records
    if isinstance(obj, list):
        return obj

    return []


def _midpoint_revenue(value: Any) -> Any:
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        return REVENUE_RANGE_TO_USD.get(value.strip())
    return None


def to_record(rec: Dict[str, Any]) -> Dict[str, Any]:
    """Convert one firmographics record to a score_company.py company record."""
    data = rec.get("data") if isinstance(rec.get("data"), dict) else rec
    bid = (rec.get("business_id") or rec.get("explorium_business_id")
           or data.get("business_id") or data.get("explorium_business_id"))

    emp_range = next((data.get(k) for k in EMP_KEYS if data.get(k)), None)
    rev_raw = next((data.get(k) for k in REV_KEYS if data.get(k)), None)

    employee_count = (EMP_RANGE_TO_MIDPOINT.get(emp_range)
                      if isinstance(emp_range, str) else emp_range)

    return {
        "explorium_business_id": bid,
        "name": data.get("name") or data.get("company_name"),
        "website": data.get("website") or data.get("domain"),
        # score_company scans industry + description text for industry + business type
        "industry": (data.get("linkedin_industry_category")
                     or data.get("naics_description") or data.get("industry")),
        "description": data.get("business_description") or data.get("description"),
        "business_type": None,  # inferred by score_company from the text blob
        "employee_count": employee_count,
        "employee_count_range": emp_range,
        "revenue_usd": _midpoint_revenue(rev_raw),
        "revenue_range": rev_raw if isinstance(rev_raw, str) else None,
        "country": data.get("country_name") or data.get("country"),
        "city": data.get("city_name") or data.get("city"),
        "region": data.get("region_name"),
        "street": data.get("street"),
        "zip_code": data.get("zip_code"),
        # Explorium firmographics deliver the company page as `linkedin_profile`
        # (fixed 2026-06-11 — the old keys never matched, so the column shipped empty)
        "linkedin_url": (data.get("linkedin_profile") or data.get("linkedin")
                         or data.get("company_linkedin_url")),
        "naics": data.get("naics"),
        "naics_description": data.get("naics_description"),
        # filled in workflow step 7 by research_company_website.py
        "website_research": None,
    }


def convert(raw_text: str) -> List[Dict[str, Any]]:
    return [to_record(r) for r in firmographics_records(raw_text)]


_DEMO = json.dumps([{"type": "text", "text": json.dumps({
    "enrichment_results": {"firmographics": json.dumps({"data": [
        {"business_id": "abc123", "data": {
            "name": "Iberia Pet Foods S.L.", "website": "iberiapet.es",
            "linkedin_industry_category": "animal feed manufacturing",
            "naics_description": "Dog and Cat Food Manufacturing",
            "business_description": "Manufacturer and wholesaler of private-label pet food.",
            "number_of_employees_range": "51-200", "revenue_range": "25M-75M",
            "country_name": "Spain", "city_name": "Valencia", "region_name": "Valencia"}},
    ]})}})}])


if __name__ == "__main__":
    if len(sys.argv) > 1:
        records = convert(Path(sys.argv[1]).read_text())
    else:
        print("No input file given — running the built-in demo envelope.\n",
              file=sys.stderr)
        records = convert(_DEMO)
    print(json.dumps(records, indent=2, ensure_ascii=False))
