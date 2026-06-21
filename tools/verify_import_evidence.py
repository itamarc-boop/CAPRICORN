"""Web-search verification of import / own-brand evidence (shortlist only).

The cheapest evidence comes from the company's own site (extract_evidence.py)
and the free HMRC UK importer register (uk_importers_lookup.py). This tool is
the paid third layer: for companies BLOCKED from Tier 1/2 solely by unknown
imports or own-brand status, run Claude Haiku with the Anthropic server-side
web_search tool (max 3 searches/company, ~$0.01/search + tokens) to look for
external evidence: "official importer of...", customs/trade mentions, brand
ownership.

Selection is deliberately narrow (~10-15 companies per 50-company run):
  * gate-passing candidates whose tier is T1/T2 (deterministic or judged), and
  * imports or own_brand verdict is "unknown".

Merge policy: results only UPGRADE an "unknown" verdict and must carry a
verbatim quote + source URL; a site-derived "no" is never overridden.

Run AFTER uk_importers_lookup.py (which removes UK companies from this paid
shortlist) and BEFORE the final scoring + BDR judge pass.

Usage:
    python3 tools/verify_import_evidence.py \
        --records .tmp/records_scored.json --out .tmp/records_verified.json \
        [--budget 1.00] [--max-companies 15]

Env:
    ANTHROPIC_API_KEY          required
    WEB_VERIFY_USD_BUDGET      default 1.00; abort if exceeded
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_MODEL = "claude-haiku-4-5"
DEFAULT_BUDGET_USD = 1.00
DEFAULT_MAX_COMPANIES = 15
MAX_SEARCHES_PER_COMPANY = 3
USD_PER_SEARCH = 0.01   # $10 / 1,000 searches

PRICING_USD_PER_MTOK = {
    "claude-haiku-4-5":  {"input": 1.00, "cache_write": 1.25, "cache_read": 0.10, "output": 5.00},
    "claude-sonnet-4-6": {"input": 3.00, "cache_write": 3.75, "cache_read": 0.30, "output": 15.00},
}

SYSTEM_PROMPT = """You verify supply-chain facts about ONE company for a lead-qualification pipeline. \
Use web search (you have at most 3 searches) to answer two questions:

(A) Does this company IMPORT goods (buy abroad — especially Asia — to sell), rather than \
producing everything in-house? Good evidence: "official importer of", "we import", customs/trade \
data mentions, importer registries, news/directory pages describing them as importer/distributor.
(B) Does it sell products under its OWN brand(s) (brands it owns, incl. private labels), or only \
third-party brands?

RULES:
1. EVIDENCE OR UNKNOWN. A "yes" or "no" verdict MUST carry a verbatim quote (max 200 chars) from \
a real page plus that page's URL. If your searches don't surface a clear claim, answer "unknown". \
NEVER infer from a wide product range, company size, or industry.
2. Be precise about the LOCAL entity: match company name AND country. A global group's behavior \
elsewhere does not count.
3. Selling TO importers/distributors abroad = exporter, not importer. An overseas factory = \
manufacturing abroad, not importing-to-resell.

OUTPUT: strict JSON only, no prose, no markdown fences:
{
  "imports": {"verdict": "yes"|"no"|"unknown", "quote": "<verbatim or null>", "source_url": "<url or null>"},
  "own_brand": {"verdict": "yes"|"no"|"unknown", "brand_names": [], "quote": "<verbatim or null>", "source_url": "<url or null>"},
  "notes": "<one short sentence>"
}"""


def _norm_verdict(value: Any) -> str:
    v = str(value or "").lower()
    return v if v in ("yes", "no") else "unknown"


def _axis(rec: Dict[str, Any], axis: str) -> str:
    frag = (rec.get("evidence") or {}).get(axis) or {}
    return _norm_verdict(frag.get("verdict"))


def needs_verification(rec: Dict[str, Any]) -> bool:
    """Provisional T1/T2 blocked by unknown imports or own-brand evidence."""
    score = rec.get("score") or {}
    if not score.get("gate_passed"):
        return False
    verdict = ((rec.get("bdr_judgment") or {}).get("verdict") or "").lower()
    if verdict == "reject":
        return False
    tier = {"t1": "Tier 1", "t2": "Tier 2", "t3": "Tier 3"}.get(verdict) \
        or score.get("tier")
    if tier not in ("Tier 1", "Tier 2"):
        return False
    return _axis(rec, "imports") == "unknown" or _axis(rec, "own_brand") == "unknown"


# ---------------------------------------------------------------------------
# Claude call (server-side web_search tool)
# ---------------------------------------------------------------------------

def _cost_usd(model: str, usage: Any) -> float:
    p = PRICING_USD_PER_MTOK.get(model, PRICING_USD_PER_MTOK[DEFAULT_MODEL])
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    cw = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cr = getattr(usage, "cache_read_input_tokens", 0) or 0
    tokens = (inp * p["input"] + cw * p["cache_write"]
              + cr * p["cache_read"] + out * p["output"]) / 1_000_000
    server = getattr(usage, "server_tool_use", None)
    searches = getattr(server, "web_search_requests", 0) or 0
    return tokens + searches * USD_PER_SEARCH


def _parse_json(text: str) -> Dict[str, Any]:
    """Extract the JSON object from model text. The model may emit a preamble
    text block before its searches and wrap the JSON in fences, so parse the
    outermost {...} slice. Citation markup inside quotes is stripped."""
    import re
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise json.JSONDecodeError("no JSON object found", text[:80], 0)
    s = text[start:end + 1]
    s = re.sub(r"</?cite[^>]*>", "", s)
    return json.loads(s)


def verify_one(client: Any, model: str,
               rec: Dict[str, Any]) -> Tuple[Dict[str, Any], float]:
    missing = [a for a in ("imports", "own_brand") if _axis(rec, a) == "unknown"]
    user_msg = (
        f"COMPANY: {rec.get('name')}\n"
        f"COUNTRY: {rec.get('country')}\n"
        f"WEBSITE: {rec.get('website')}\n"
        f"WHAT THEY SELL: {(rec.get('evidence') or {}).get('core_business_summary') or rec.get('description') or ''}\n"
        f"UNVERIFIED: {', '.join(missing)}\n\n"
        "Search the web for evidence and return only the JSON."
    )
    messages: List[Dict[str, Any]] = [{"role": "user", "content": user_msg}]
    cost = 0.0
    for _ in range(3):   # continue through pause_turn at most twice
        resp = client.messages.create(
            model=model,
            max_tokens=2000,
            temperature=0,
            system=[{"type": "text", "text": SYSTEM_PROMPT,
                     "cache_control": {"type": "ephemeral"}}],
            tools=[{"type": "web_search_20250305", "name": "web_search",
                    "max_uses": MAX_SEARCHES_PER_COMPANY}],
            messages=messages,
        )
        cost += _cost_usd(model, resp.usage)
        if resp.stop_reason == "pause_turn":
            messages = [{"role": "user", "content": user_msg},
                        {"role": "assistant", "content": resp.content}]
            continue
        # The JSON lives in the LAST text block (earlier ones are preamble).
        texts = [b.text for b in resp.content if b.type == "text"]
        if not texts:
            raise RuntimeError("no text block in web-search response")
        return _parse_json(texts[-1]), cost
    raise RuntimeError("web search did not complete (repeated pause_turn)")


def merge_fragment(rec: Dict[str, Any], axis: str,
                   found: Dict[str, Any]) -> bool:
    """Upgrade evidence[axis] from unknown using a web-found fragment.

    Requires quote + source_url; never overrides an existing yes/no.
    """
    if _axis(rec, axis) != "unknown":
        return False
    verdict = _norm_verdict(found.get("verdict"))
    quote = (found.get("quote") or "").strip()
    url = (found.get("source_url") or "").strip()
    if verdict == "unknown" or not quote or not url:
        return False
    ev = rec.setdefault("evidence", {})
    fragment = {"verdict": verdict, "quote": quote, "quote_en": None,
                "source_url": url}
    if axis == "own_brand":
        fragment["brand_names"] = found.get("brand_names") or []
    ev[axis] = fragment
    ev.setdefault("extraction_notes", []).append(
        f"{axis}: '{verdict}' added by web-search verification ({url})")
    return True


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def verify_all(records: List[Dict[str, Any]], *, model: str, budget_usd: float,
               max_companies: int) -> int:
    from anthropic import Anthropic
    load_dotenv(ROOT / ".env")
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise RuntimeError("ANTHROPIC_API_KEY not set (add to .env).")
    client = Anthropic()

    shortlist = [r for r in records if needs_verification(r)]
    if len(shortlist) > max_companies:
        print(f"  [web-verify] shortlist {len(shortlist)} > cap "
              f"{max_companies}; verifying the top {max_companies} by score",
              file=sys.stderr)
        shortlist.sort(key=lambda r: -((r.get("score") or {}).get("total_score") or 0))
        shortlist = shortlist[:max_companies]

    cumulative = 0.0
    upgraded = 0
    for rec in shortlist:
        name = rec.get("name", "(unnamed)")
        try:
            found, cost = verify_one(client, model, rec)
        except Exception as e:  # noqa: BLE001
            print(f"  [web-verify] {name}: ERROR {e}", file=sys.stderr)
            continue
        cumulative += cost
        changed = []
        for axis in ("imports", "own_brand"):
            if merge_fragment(rec, axis, found.get(axis) or {}):
                changed.append(f"{axis}={_axis(rec, axis)}")
                upgraded += 1
        print(f"  [web-verify] {name:42} "
              f"{'; '.join(changed) if changed else 'no upgrade'}  "
              f"${cumulative:.4f}", file=sys.stderr)
        if cumulative > budget_usd:
            raise RuntimeError(
                f"web verification hit cost cap (${cumulative:.4f} > "
                f"${budget_usd:.2f}). Re-run with --budget HIGHER or set "
                f"WEB_VERIFY_USD_BUDGET.")
        time.sleep(0.1)
    print(f"  [web-verify] {len(shortlist)} verified, {upgraded} evidence "
          f"upgrade(s), total ${cumulative:.4f}", file=sys.stderr)
    return upgraded


if __name__ == "__main__":
    load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", required=True,
                        help="scored (and ideally judged) records JSON")
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--budget", type=float,
                        default=float(os.getenv("WEB_VERIFY_USD_BUDGET",
                                                DEFAULT_BUDGET_USD)))
    parser.add_argument("--max-companies", type=int,
                        default=DEFAULT_MAX_COMPANIES)
    args = parser.parse_args()

    records = json.loads(Path(args.records).read_text())
    verify_all(records, model=args.model, budget_usd=args.budget,
               max_companies=args.max_companies)
    Path(args.out).write_text(json.dumps(records, indent=2, ensure_ascii=False))
    print(f"\nwrote {len(records)} record(s) -> {args.out}", file=sys.stderr)
