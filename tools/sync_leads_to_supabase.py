"""Sync a .tmp/leads_*.json file to the Capricorn webapp's Supabase database.

Phase 2.5 schema (webapp/supabase/migrations/0002_companies_contacts.sql):
one `companies` row per company, 1-N `contacts` rows per company.

Company match key: `business_id` if present, else (normalized name, country).
Contact match key (within a company): bare email, else normalized LinkedIn
URL, else lowercased full name.

Preservation rules (so re-syncing never clobbers client work):
  - companies.status / notes / status_changed_at are NEVER written
  - contacts are never deleted; manual contacts are left alone
  - a name-matched company that gains a business_id gets it attached

Requires `webapp/.env.local` with NEXT_PUBLIC_SUPABASE_URL and
SUPABASE_SERVICE_ROLE_KEY (repo-root .env works as fallback).

Usage:
    python3 tools/sync_leads_to_supabase.py .tmp/leads_2026-05-27_iter2_v2.json --iteration 2
    python3 tools/sync_leads_to_supabase.py .tmp/leads_2026-06-11_mexico_test.json --batch-label mexico_test
    python3 tools/sync_leads_to_supabase.py <file> --iteration 4 --dry-run
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent

COMPANY_COLUMNS = [
    "business_id", "company_name", "website", "industry", "country", "city",
    "employee_count", "estimated_revenue", "description", "linkedin_company_page",
    "icp_tier", "icp_score", "deal_probability", "business_model",
    "judge_pattern", "judge_reason", "import_evidence", "own_brand_evidence",
    "third_party_brands", "evidence_urls", "what_to_sell_gaps",
    "needs_human_check", "iteration", "batch_label",
]

_EMAIL_LABEL_RE = re.compile(r"\s*\(([^)]*)\)\s*$")


def _load_env() -> None:
    load_dotenv(ROOT / "webapp" / ".env.local")
    load_dotenv(ROOT / ".env")


def _supabase_client():
    try:
        from supabase import create_client  # type: ignore
    except ImportError:
        sys.exit("supabase-py not installed. Run: pip install supabase python-dotenv")
    import os
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY "
                 "(set in webapp/.env.local or repo-root .env).")
    return create_client(url, key)


# ─── normalization helpers (must mirror the SQL in 0002) ────────────────────

def _name_key(name: str) -> str:
    return (name or "").strip().lower()


def _country_key(country: Optional[str]) -> str:
    return (country or "").strip().lower()


def _linkedin_key(url: Optional[str]) -> Optional[str]:
    if not url:
        return None
    key = re.sub(r"^https?://(www\.)?|/+$", "", url.strip().lower())
    return key or None


def _parse_email(raw: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
    """'mario@x.com (SMTP-verified)' -> ('mario@x.com', 'smtp-verified')."""
    if not raw:
        return None, None
    raw = raw.strip()
    label = None
    m = _EMAIL_LABEL_RE.search(raw)
    if m:
        label = m.group(1).strip().lower() or None
        raw = _EMAIL_LABEL_RE.sub("", raw).strip()
    email = raw.lower() or None
    if email and "@" not in email:
        # Things like "(LinkedIn only)" leave no address behind.
        return None, label
    return email, label


def _str_or_none(v: Any) -> Optional[str]:
    if v is None or v == "":
        return None
    return str(v)


# ─── row mapping ────────────────────────────────────────────────────────────

def _row_to_company(row: Dict[str, Any], iteration: Optional[int],
                    batch_label: Optional[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {
        "business_id": row.get("explorium_business_id") or row.get("business_id"),
        "company_name": row.get("company_name") or row.get("name"),
        "website": row.get("website"),
        "industry": row.get("industry"),
        "country": (row.get("country") or "").strip() or None,
        "city": row.get("city"),
        "employee_count": _str_or_none(row.get("employee_count")),
        "estimated_revenue": _str_or_none(row.get("estimated_revenue")),
        "description": row.get("description"),
        "linkedin_company_page": row.get("linkedin_company_page"),
        "icp_tier": row.get("icp_tier"),
        "icp_score": row.get("icp_score"),
        "deal_probability": row.get("deal_probability"),
        "business_model": row.get("business_model"),
        "judge_pattern": row.get("judge_pattern"),
        "judge_reason": row.get("judge_reason"),
        "import_evidence": row.get("import_evidence"),
        "own_brand_evidence": row.get("own_brand_evidence"),
        "third_party_brands": row.get("third_party_brands"),
        "evidence_urls": row.get("evidence_urls"),
        "what_to_sell_gaps": row.get("what_to_sell_gaps"),
        "needs_human_check": row.get("needs_human_check"),
    }
    if iteration is not None:
        out["iteration"] = iteration
    if batch_label is not None:
        out["batch_label"] = batch_label
    return {k: v for k, v in out.items() if k in COMPANY_COLUMNS}


def _row_to_contact(row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    email, label = _parse_email(row.get("contact_email"))
    contact = {
        "full_name": _str_or_none((row.get("contact_name") or "").strip()),
        "title": _str_or_none((row.get("contact_title") or "").strip()),
        "email": email,
        "email_label": label,
        "linkedin_url": _str_or_none((row.get("contact_linkedin_url") or "").strip()),
        "phone": _str_or_none((row.get("contact_phone") or "").strip()),
    }
    if not (contact["full_name"] or contact["email"] or contact["linkedin_url"]):
        return None
    return contact


def _company_group_key(company: Dict[str, Any]) -> str:
    if company.get("business_id"):
        return f"bid:{company['business_id']}"
    return f"name:{_name_key(company.get('company_name') or '')}|{_country_key(company.get('country'))}"


# ─── matching against existing DB rows ──────────────────────────────────────

def _match_contact(existing: List[Dict[str, Any]],
                   contact: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if contact.get("email"):
        for ex in existing:
            if (ex.get("email") or "").lower() == contact["email"]:
                return ex
    lk = _linkedin_key(contact.get("linkedin_url"))
    if lk:
        for ex in existing:
            if _linkedin_key(ex.get("linkedin_url")) == lk:
                return ex
    if contact.get("full_name"):
        name = contact["full_name"].lower()
        for ex in existing:
            if (ex.get("full_name") or "").strip().lower() == name:
                return ex
    return None


def sync(json_path: Path, iteration: Optional[int], batch_label: Optional[str],
         dry_run: bool) -> None:
    rows = json.loads(json_path.read_text())
    if not isinstance(rows, list):
        sys.exit(f"{json_path} must contain a JSON array of lead rows")

    # Group contact rows by company.
    groups: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        company = _row_to_company(row, iteration, batch_label)
        if not company.get("company_name"):
            continue
        key = _company_group_key(company)
        grp = groups.setdefault(key, {"company": company, "contacts": []})
        # Prefer the most filled-in company payload (later rows are identical
        # under the old builder, so this is belt-and-braces).
        for k, v in company.items():
            if grp["company"].get(k) in (None, "") and v not in (None, ""):
                grp["company"][k] = v
        contact = _row_to_contact(row)
        if contact:
            grp["contacts"].append(contact)

    print(f"Read {len(rows)} contact rows from {json_path.name} -> "
          f"{len(groups)} companies "
          f"(iteration={iteration}, batch_label={batch_label}).", file=sys.stderr)

    if dry_run:
        for grp in groups.values():
            c = grp["company"]
            print(f"  {c['company_name']} [{c.get('country')}] "
                  f"{c.get('icp_tier')} -> {len(grp['contacts'])} contact(s)",
                  file=sys.stderr)

    sb = None if dry_run else _supabase_client()

    # Fetch existing companies once for matching.
    existing_by_bid: Dict[str, Dict[str, Any]] = {}
    existing_by_name: Dict[Tuple[str, str], Dict[str, Any]] = {}
    if sb:
        # PostgREST caps responses at 1000 rows by default — paginate.
        offset = 0
        while True:
            res = sb.table("companies").select(
                "id, business_id, company_name, country"
            ).range(offset, offset + 999).execute()
            page = res.data or []
            for ex in page:
                if ex.get("business_id"):
                    existing_by_bid[ex["business_id"]] = ex
                existing_by_name[(_name_key(ex["company_name"]),
                                  _country_key(ex.get("country")))] = ex
            if len(page) < 1000:
                break
            offset += 1000

    stats = {"companies_inserted": 0, "companies_updated": 0,
             "contacts_inserted": 0, "contacts_updated": 0,
             "contacts_skipped_manual": 0}

    for grp in groups.values():
        company = grp["company"]
        bid = company.get("business_id")
        match = existing_by_bid.get(bid) if bid else None
        if match is None:
            match = existing_by_name.get(
                (_name_key(company["company_name"]), _country_key(company.get("country"))))

        if dry_run:
            stats["companies_updated" if match else "companies_inserted"] += 1
            stats["contacts_inserted"] += len(grp["contacts"])
            continue

        if match:
            # Update firmographics only — status/notes live in the DB.
            # Only send non-None values so a sparse re-sync never NULLs out
            # columns that are already populated (e.g. judge_pattern).
            payload = {k: v for k, v in company.items()
                       if k != "business_id" and v is not None}
            if bid and not match.get("business_id"):
                payload["business_id"] = bid
            sb.table("companies").update(payload).eq("id", match["id"]).execute()
            company_id = match["id"]
            stats["companies_updated"] += 1
        else:
            res = sb.table("companies").insert(company).execute()
            company_id = res.data[0]["id"]
            existing_by_name[(_name_key(company["company_name"]),
                              _country_key(company.get("country")))] = res.data[0]
            stats["companies_inserted"] += 1

        # Contacts: match within the company; never delete.
        ex_res = sb.table("contacts").select("*").eq("company_id", company_id).execute()
        existing_contacts = ex_res.data or []
        has_primary = any(c.get("is_primary") for c in existing_contacts)

        # Prefer giving is_primary to a contact with an email.
        ordered = sorted(grp["contacts"], key=lambda c: c.get("email") is None)
        for idx, contact in enumerate(ordered):
            matched = _match_contact(existing_contacts, contact)
            if matched:
                if matched.get("source") == "manual":
                    # Manual contacts are left alone (still counts as matched,
                    # so no duplicate insert happens).
                    stats["contacts_skipped_manual"] += 1
                else:
                    patch = {k: v for k, v in contact.items() if v is not None}
                    sb.table("contacts").update(patch).eq("id", matched["id"]).execute()
                    stats["contacts_updated"] += 1
            else:
                payload = dict(contact)
                payload["company_id"] = company_id
                payload["source"] = "pipeline"
                if not has_primary and idx == 0:
                    payload["is_primary"] = True
                    has_primary = True
                res = sb.table("contacts").insert(payload).execute()
                existing_contacts.append(res.data[0])
                stats["contacts_inserted"] += 1

        # Post-pass: a company should never end the run with zero primary
        # contacts (e.g. the first ordered contact matched an existing
        # non-primary row). existing_contacts includes newly inserted rows.
        if existing_contacts and not any(c.get("is_primary") for c in existing_contacts):
            best = next((c for c in existing_contacts if c.get("email")),
                        existing_contacts[0])
            sb.table("contacts").update({"is_primary": True}).eq("id", best["id"]).execute()

    print(("DRY RUN — planned: " if dry_run else "Done: ") +
          f"{stats['companies_inserted']} companies inserted, "
          f"{stats['companies_updated']} updated; "
          f"{stats['contacts_inserted']} contacts inserted, "
          f"{stats['contacts_updated']} updated, "
          f"{stats['contacts_skipped_manual']} manual skipped.", file=sys.stderr)


if __name__ == "__main__":
    _load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("json_path", help="Path to a .tmp/leads_*.json file")
    ap.add_argument("--iteration", type=int, default=None,
                    help="Iteration number to tag these companies with")
    ap.add_argument("--batch-label", default=None,
                    help="Free-form batch tag (e.g. mexico_test) for one-off runs")
    ap.add_argument("--dry-run", action="store_true",
                    help="Print planned changes; don't write to Supabase")
    args = ap.parse_args()

    if args.iteration is None and args.batch_label is None:
        sys.exit("Provide --iteration and/or --batch-label so the batch is identifiable.")

    sync(Path(args.json_path), args.iteration, args.batch_label, args.dry_run)
