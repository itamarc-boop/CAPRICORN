"""Drop companies already delivered in a prior run.

Capricorn has no CRM/database yet, so the "already seen" memory is a local
file: `.tmp/seen_companies.json` — a list of {business_id, domain, name}.

Two modes:

  Filter (default) — read company records from stdin or a file, drop any whose
  business_id, normalized domain, or normalized name is already in
  seen_companies.json, print the survivors:
      python tools/dedup_companies.py < .tmp/discovered.json > .tmp/to_enrich.json

  Register — after a run is delivered, append its companies to the seen file so
  the next run skips them:
      python tools/dedup_companies.py --register < .tmp/leads_2026-05-20.json

Records may use either `business_id`/`explorium_business_id`, `domain`/`website`,
and `name`/`company_name` — both spellings are accepted.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Set, Tuple

SEEN_PATH = Path(__file__).resolve().parent.parent / ".tmp" / "seen_companies.json"


def _norm_domain(value: Any) -> str:
    s = str(value or "").strip().lower()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^www\.", "", s)
    return s.split("/")[0].strip()


def _norm_name(value: Any) -> str:
    s = str(value or "").strip().lower()
    # drop common legal suffixes + punctuation so "Acme S.L." == "Acme"
    s = re.sub(r"[.,]", "", s)
    s = re.sub(r"\b(s\.?l\.?|s\.?a\.?|srl|gmbh|ltd|limited|inc|llc|bv|plc|co)\b",
               "", s)
    return re.sub(r"\s+", " ", s).strip()


def _keys(rec: Dict[str, Any]) -> Tuple[str, str, str]:
    bid = str(rec.get("business_id") or rec.get("explorium_business_id") or "").strip()
    domain = _norm_domain(rec.get("domain") or rec.get("website"))
    name = _norm_name(rec.get("name") or rec.get("company_name"))
    return bid, domain, name


def load_seen() -> List[Dict[str, Any]]:
    if SEEN_PATH.exists():
        try:
            return json.loads(SEEN_PATH.read_text()) or []
        except json.JSONDecodeError:
            return []
    return []


def _seen_sets(seen: List[Dict[str, Any]]) -> Tuple[Set[str], Set[str], Set[str]]:
    bids, domains, names = set(), set(), set()
    for rec in seen:
        bid, domain, name = _keys(rec)
        if bid:
            bids.add(bid)
        if domain:
            domains.add(domain)
        if name:
            names.add(name)
    return bids, domains, names


def filter_records(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    bids, domains, names = _seen_sets(load_seen())
    kept, dropped = [], []
    for rec in records:
        bid, domain, name = _keys(rec)
        hit = ((bid and bid in bids) or (domain and domain in domains)
               or (name and name in names))
        (dropped if hit else kept).append(rec)
    return {"kept": kept, "dropped": dropped}


def register(records: List[Dict[str, Any]]) -> int:
    seen = load_seen()
    bids, domains, names = _seen_sets(seen)
    added = 0
    for rec in records:
        bid, domain, name = _keys(rec)
        if (bid and bid in bids) or (domain and domain in domains):
            continue
        seen.append({"business_id": bid, "domain": domain, "name": name})
        if bid:
            bids.add(bid)
        if domain:
            domains.add(domain)
        added += 1
    SEEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    SEEN_PATH.write_text(json.dumps(seen, indent=2, ensure_ascii=False))
    return added


def _read_input() -> List[Dict[str, Any]]:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    raw = Path(args[0]).read_text() if args else sys.stdin.read()
    data = json.loads(raw)
    return data if isinstance(data, list) else [data]


if __name__ == "__main__":
    records = _read_input()
    if "--register" in sys.argv:
        n = register(records)
        print(f"Registered {n} new companies into {SEEN_PATH.name} "
              f"({len(load_seen())} total).", file=sys.stderr)
    else:
        result = filter_records(records)
        print(f"dedup: {len(result['kept'])} kept, {len(result['dropped'])} "
              f"already-seen dropped.", file=sys.stderr)
        print(json.dumps(result["kept"], indent=2, ensure_ascii=False))
