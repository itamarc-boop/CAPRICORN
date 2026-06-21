"""Pick the best 1-2 prospect contacts per company for enrich-prospects.

Calibrated 2026-05-27 after Iteration-2 contact-find issues. See the "Fetch
contacts" step in `workflows/find_capricorn_leads.md` for the rationale.

Input shapes (defensive):
  --prospects  JSON list of Explorium prospect records (output of
               fetch-prospects). Each must have at minimum `business_id`,
               `full_name`, `job_title`. `country_name` is used for the
               country gate when present.
  --companies  JSON list of scored company records (output of score_company
               with `bdr_judgment` attached). Used to look up each company's
               `country` for the country gate.

Output: JSON list of picked prospect records, with two extra fields:
  - `picked_rank`  1-9, lower is better (see TITLE_PRIORITY below)
  - `picked_reason` short string ("strong-buyer-title", "off-country", etc.)

Usage:
    python3 tools/pick_prospects.py --prospects .tmp/prospects.json \
        --companies .tmp/iter2_final.json > .tmp/prospects_picked.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# (regex pattern matched against lower-cased job title, rank). First match wins.
TITLE_PRIORITY: List[Tuple[str, int]] = [
    (r"\b(procurement|sourcing|purchasing|buyer)\b",          1),
    (r"\bgesch.ftsleiter\b",                                  2),  # CH/AT "MD"
    (r"\b(managing director|owner|founder|president)\b",      2),
    (r"\bcommercial director\b",                              3),
    (r"\bhead of (?!finance|hr|legal)",                       3),
    # German "Leiter X" = "Head of X" — but skip "Leiter Finanz/HR/Recht"
    (r"\bleiter\b(?!\s+(finanz|hr|personal|recht))",          3),
    (r"\b(ceo|chief executive)\b",                            4),
    (r"\bdirector of (sales|operations|supply)",              4),
    (r"\b(sales director|head of sales)\b",                   5),
    (r"\bsales manager\b",                                    5),
    (r"\b(general manager|operations manager)\b",             6),
    (r"\bcountry manager\b",                                  7),
    (r"\b(account manager|supply chain|logistics)\b",         8),
    (r"\b(finance|technical|shift|warehouse|accountant)\b",   9),
]

DEFAULT_PICK_MAX = 2
DEFAULT_RUNNER_UP_MAX_RANK = 4   # only add a 2nd contact if it's also strong


def _norm(s: Optional[str]) -> str:
    return (s or "").strip().lower()


def title_rank(title: Optional[str]) -> int:
    t = _norm(title)
    if not t:
        return 9
    for pattern, rank in TITLE_PRIORITY:
        if re.search(pattern, t):
            return rank
    return 9


def pick_for_company(prospects: List[Dict[str, Any]], *,
                     company_country: Optional[str],
                     max_picks: int = DEFAULT_PICK_MAX,
                     runner_up_max_rank: int = DEFAULT_RUNNER_UP_MAX_RANK,
                     ) -> List[Dict[str, Any]]:
    """Return the picked subset of prospects for one company."""
    expected_country = _norm(company_country)
    candidates = []
    for p in prospects:
        rank = title_rank(p.get("job_title"))
        p_country = _norm(p.get("country_name"))
        off_country = bool(expected_country and p_country
                           and p_country != expected_country)
        reason = "strong-buyer-title" if rank <= 4 else \
                 "mid-rank" if rank <= 6 else "last-resort"
        if off_country:
            reason = f"off-country (prospect={p_country}, company={expected_country})"
        candidates.append({**p, "picked_rank": rank, "picked_reason": reason,
                           "_off_country": off_country})
    candidates.sort(key=lambda x: (x["_off_country"], x["picked_rank"]))
    on_country = [c for c in candidates if not c["_off_country"]]
    if not on_country:
        return []  # all off-country — better to mark "no contact found"
    picked = [on_country[0]]
    for cand in on_country[1:max_picks]:
        if cand["picked_rank"] <= runner_up_max_rank:
            picked.append(cand)
    for p in picked:
        p.pop("_off_country", None)
    return picked


def pick_all(prospects: List[Dict[str, Any]],
             companies: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    bid_to_country = {c.get("explorium_business_id") or c.get("business_id"):
                      c.get("country") for c in companies}
    by_biz: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for p in prospects:
        if p.get("business_id"):
            by_biz[p["business_id"]].append(p)
    picked: List[Dict[str, Any]] = []
    for bid, ps in by_biz.items():
        picked.extend(pick_for_company(ps, company_country=bid_to_country.get(bid)))
    return picked


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--prospects", required=True)
    ap.add_argument("--companies", required=True)
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    prospects = json.loads(Path(args.prospects).read_text())
    companies = json.loads(Path(args.companies).read_text())
    picked = pick_all(prospects, companies)

    payload = json.dumps(picked, indent=2, ensure_ascii=False)
    if args.out:
        Path(args.out).write_text(payload)
        print(f"wrote {len(picked)} picked prospect(s) -> {args.out}",
              file=sys.stderr)
    else:
        print(payload)

    # quick summary to stderr
    by_rank: Dict[int, int] = defaultdict(int)
    for p in picked:
        by_rank[p["picked_rank"]] += 1
    print(f"\nPicked: {len(picked)} prospects across {len({p['business_id'] for p in picked})} companies",
          file=sys.stderr)
    print("Rank breakdown (lower = better):", file=sys.stderr)
    for r in sorted(by_rank):
        print(f"  rank {r}: {by_rank[r]}", file=sys.stderr)
