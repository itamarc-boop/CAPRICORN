"""Claude-powered BDR judgment over scored Capricorn candidates.

For every gate-passing candidate the deterministic score produced, ask a
"senior BDR" persona to apply the client's annotated playbook from
``feedback/iteration_<N>_labels.json`` and return a structured verdict
(t1/t2/t3/reject) plus a concrete `what_to_sell` gap list.

The system prompt + playbook + few-shot block are cached (Anthropic ephemeral
prompt cache, 5-minute TTL) so per-candidate calls only pay for the candidate
JSON + the response.

See ``workflows/bdr_judge.md`` for the input/output contract and patterns.

Usage:
    python3 tools/bdr_judge.py --candidates .tmp/scored.json --out .tmp/judged.json
    python3 tools/bdr_judge.py --candidates .tmp/scored.json --out .tmp/judged.json \
        --only-names "Agriplast,KORRES"       # judge a subset (debug)
    python3 tools/bdr_judge.py --candidates .tmp/scored.json --out .tmp/judged.json \
        --model claude-opus-4-7 --budget 5.00 # override defaults

Env:
    ANTHROPIC_API_KEY        required
    BDR_JUDGE_USD_BUDGET     default 2.00; abort if cumulative cost exceeds
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
LABELS = ROOT / "feedback" / "iteration_1_labels.json"
CLAUDE_MD = ROOT / "CLAUDE.md"

DEFAULT_MODEL = "claude-sonnet-4-6"
DEFAULT_BUDGET_USD = 2.00
# One few-shot example per distinct pattern first (≈26 patterns across
# iterations 1+3), then top-up; 14 was truncating pattern coverage.
FEW_SHOT_COUNT = 28

# Pricing per million tokens; refresh if Anthropic publishes new.
PRICING_USD_PER_MTOK = {
    "claude-sonnet-4-6":   {"input": 3.00, "cache_write": 3.75, "cache_read": 0.30, "output": 15.00},
    "claude-opus-4-7":     {"input": 5.00, "cache_write": 6.25, "cache_read": 0.50, "output": 25.00},
    "claude-haiku-4-5":    {"input": 1.00, "cache_write": 1.25, "cache_read": 0.10, "output": 5.00},
}


# ---------------------------------------------------------------------------
# Playbook + few-shot compilation
# ---------------------------------------------------------------------------

def load_playbook() -> Dict[str, Any]:
    """The canonical playbook (patterns/verdicts/notes) lives in
    iteration_1_labels.json; LABELS for few-shot examples are the union of
    every feedback/iteration_*_labels.json (iteration 3 added the
    pure-manufacturer / own-brand / adjacent-category failure modes)."""
    playbook = json.loads(LABELS.read_text())
    all_labels: List[Dict[str, Any]] = []
    for path in sorted((ROOT / "feedback").glob("iteration_*_labels.json")):
        all_labels.extend(json.loads(path.read_text()).get("labels", []))
    playbook["labels"] = all_labels
    return playbook


def sample_examples(playbook: Dict[str, Any], n: int = FEW_SHOT_COUNT,
                    seed: int = 7) -> List[Dict[str, Any]]:
    """Pick few-shot examples covering all verdicts AND all distinct patterns.

    Ensures every pattern that appears in the labels shows up at least once in
    the few-shot block — without that, the judge has to infer patterns from
    overlapping descriptions and starts conflating them. Deterministic by seed.
    """
    rng = random.Random(seed)
    by_pattern: Dict[str, List[Dict[str, Any]]] = {}
    for label in playbook["labels"]:
        by_pattern.setdefault(label["pattern"], []).append(label)
    # One example of each distinct pattern first.
    picked: List[Dict[str, Any]] = []
    seen = set()
    for pattern, items in by_pattern.items():
        choice = rng.choice(items)
        picked.append(choice)
        seen.add(id(choice))
    # Top up to n with the largest verdict buckets so common verdicts dominate.
    remaining = [l for l in playbook["labels"] if id(l) not in seen]
    rng.shuffle(remaining)
    picked.extend(remaining[: max(0, n - len(picked))])
    return picked[:n]


def _catalog_excerpt() -> str:
    """Capricorn's product list. CLAUDE.md used to hold it ('Products
    Capricorn sells') but lost it when it became the agent-instructions file
    — fall back to the canonical constant in extract_evidence.py."""
    if CLAUDE_MD.exists():
        text = CLAUDE_MD.read_text()
        marker = "Products Capricorn sells"
        if marker in text:
            chunk = text.split(marker, 1)[1]
            return marker + chunk.split("## ", 1)[0].strip()
    from extract_evidence import CAPRICORN_CATALOG
    return CAPRICORN_CATALOG


def build_system_prompt(playbook: Dict[str, Any],
                        examples: List[Dict[str, Any]]) -> str:
    return f"""You are a senior BDR for Capricorn, a 50-year global sourcing company that moves \
20,000+ containers per year out of China and Vietnam.

THE ICP (client's iteration-3 calibration — these are his words): Capricorn's best customers \
IMPORT container volume and sell their OWN brands. "LO MEJOR SON LOS IMPORTADORES CON LOS QUE \
PUEDA VENDER VOLUMEN." "ALGO QUE CALIFICA MUCHO A UNA EMPRESA, ES QUE VENDA SUS MARCAS PROPIAS."

THE EVIDENCE RULES — these are hard rules, not guidance:
1. t1 requires the candidate's `evidence` block to show imports = "yes" AND own_brand = "yes", \
both with verbatim quotes. NEVER assert that a company imports without that evidence — iteration \
3 shipped "Claude dice que importan pq su range es muy grande, pero sin un claim real" and the \
client caught it. A wide product range is NOT import evidence. If the evidence is missing, the \
ceiling is t2 and you say exactly what's unverified.
2. A pure manufacturer with no import evidence is a REJECT ("Fábrica full, no importan nada... \
waste of time"). Product overlap does not help — selling to them means competing with their own \
production. A manufacturer WITH quoted import/distribution motion is t2 \
(producer-who-also-imports); promote to t1 only with own brand + strong volume_signals — the \
iteration-1 confirms (INTERMAS, Naue, Nice-Pak, MONGE, H-Pack) all had real motion.
2b. Absence of evidence is NOT evidence of absence. Rejecting a manufacturer for lacking import \
motion requires that the website WAS actually read (evidence block present and site_status \
"ok") and still showed no import/distribution signals (the Metzer/Politiv case). If the \
candidate has no evidence block, or site_status is not "ok" (only the vendor description was \
available), do NOT reject on manufacturer/no-import grounds — give t3 with a \
needs-verification flag instead.
3. Own brands qualify; third-party brands disqualify by degree: distributor of GLOBAL brands \
(Eukanuba/Pedigree/Hills class) = reject (no-own-brand-reseller); distributor of niche \
third-party brands WITH product fit = t3, flagged low priority \
(third-party-distributor-product-fit — Harpo: "podría ser interesante", not a priority).
4. Judge the LOCAL entity, not the global group. Bunzl is Capricorn's client in Chile and a \
REJECT in the UK (buys from local importers, sells third-party brands there).
5. Catalog fit is about the CORE business: a food distributor is not a foodservice-disposables \
company; transit packaging is not foodservice disposables; irrigation motors are not irrigation \
consumables; coco substrate is not agricultural plastics.
6. For confirmed fits, t1 vs t2 hinges on the VOLUME of Capricorn-relevant SKUs they move \
(check volume_signals — the Green-tech rule: "depende del volumen que vendan de los productos \
que ofrece Capricorn").
7. Israel: strong agri-manufacturing tradition, poor hunting ground. An Israeli agriculture \
company with manufacturer evidence and no import evidence is a reject by default; the target \
is importers bringing physical goods into Israel from Asia.
8. Direction of trade matters: a company that sells TO importers/distributors/retail chains \
abroad is a SUPPLIER/EXPORTER — the opposite of Capricorn's customer. Owning an overseas plant \
is production abroad, not import-to-resell motion — if the imports quote only mentions plants \
abroad ("three plants in Israel, one in China"), treat imports as UNVERIFIED even though the \
extractor said "yes". Anchor: Sadovsky (Israeli cleaning-products factory, China plant, sells \
to importers worldwide) — client: "Es fábrica... por ahora no relevante" = REJECT, not \
producer-who-also-imports.
9. If `evidence.business_model` is "third_party_brand_distributor", the ceiling is t3 \
(third-party-distributor-product-fit), and it is a REJECT when the carried brands include \
major/global brands. Incidental own-brand lines do NOT lift this ceiling — the client rejected \
Pedigree Wholesale despite its exclusive house brands ("No tienen marca propia, venden marcas \
de terceros").
10. Reject-vs-t3 calibration (match the client, don't be harsher): use \
adjacent-category-mismatch as REJECT only when there is no real Capricorn-consumable overlap \
(NETTUNO: "venden en su mayoría motores"). When the catalog genuinely includes Capricorn SKUs \
(drip tape, nets, films, stretch wrap) alongside out-of-scope lines, prefer t3 — or t2 if \
product fit is strong and only import evidence is missing. A producer whose production CONSUMES \
Capricorn SKUs is t3, NOT reject — this includes contract/private-label cosmetics manufacturers \
(anchor: COSMEWAX — client: "Podría ser cliente, pero no prioridad" = t3 \
cosmetics-pure-producer-slow-cycle; Capricorn sells them their production inputs: packaging, \
wipes, applicator pads). Reserve pure-manufacturer-no-import (reject) for factories that \
PRODUCE the same finished SKUs Capricorn sells, where selling to them means competing with \
their own production (TATAY, Geo&Tex, Metzer, Politiv).

CAPRICORN CATALOG:
{_catalog_excerpt() or "(catalog not found — assume the full ICP catalog defined in CLAUDE.md)"}

Your job: evaluate ONE prospect company and output strict JSON matching the OUTPUT CONTRACT \
below. No prose around the JSON, no markdown fences.

OUTPUT CONTRACT:
{{
  "verdict": "t1" | "t2" | "t3" | "reject",
  "matched_pattern": "<pattern slug from the playbook below, or 'none'>",
  "reason": "<one specific sentence in the client's voice>",
  "deal_probability": <float 0..1; honesty over optimism>,
  "what_to_sell": ["<concrete SKU or product line from CAPRICORN CATALOG>", ...],
  "evidence_citations": ["<verbatim quote from the evidence block that backs the verdict>", ...],
  "flags": ["<optional extra tag>", ...]
}}

`evidence_citations` is REQUIRED (non-empty) for a t1 verdict: quote the import claim and the \
own-brand claim you are relying on. A t1 without citations will be auto-downgraded to t2 by the \
pipeline.

VERDICT DEFINITIONS:
{json.dumps(playbook["verdicts"], indent=2, ensure_ascii=False)}

PLAYBOOK PATTERNS — pick the slug that best matches; use "none" only if truly novel:
{json.dumps(playbook["patterns"], indent=2, ensure_ascii=False)}

GLOBAL NOTES:
{json.dumps(playbook["global_notes"], indent=2, ensure_ascii=False)}

NAMED COMPETITORS (only ever use the 'direct-competitor' verdict for these):
{json.dumps(playbook.get("named_competitors", []), indent=2, ensure_ascii=False)}

KNOWN REJECTS (always 'reject' regardless of how the firmographics read — \
client has confirmed these are not buyers):
{json.dumps(playbook.get("known_rejects", []), indent=2, ensure_ascii=False)}

TIER CALIBRATION GUIDANCE:
{playbook.get("tier_calibration_guidance", "")}

EXAMPLES (the client's labels from prior iterations):
{json.dumps([{
        "company": e["company"], "country": e.get("country"),
        "vertical": e["vertical"], "verdict": e["verdict"],
        "pattern": e["pattern"], "client_comment": e["client_comment"],
    } for e in examples], indent=2, ensure_ascii=False)}

Be concrete in `what_to_sell`. Name specific SKUs from CAPRICORN CATALOG (e.g. \
"anti-hail nets", "bagasse 500-1000ml bowls with lids", "cat lick treats in stand-up pouches"), \
not generic categories like "agricultural products" or "packaging".
"""


def candidate_user_message(candidate: Dict[str, Any]) -> str:
    # The quote-backed evidence block is small and load-bearing — send it
    # whole. The raw website_research scrape dump is superseded by it; only
    # pass its status fields.
    research = candidate.get("website_research") or {}
    slim = {
        "name": candidate.get("name"),
        "website": candidate.get("website"),
        "industry": candidate.get("industry"),
        "naics_description": candidate.get("naics_description"),
        "business_type": candidate.get("business_type"),
        "description": candidate.get("description"),
        "employee_count": candidate.get("employee_count"),
        "employee_count_range": candidate.get("employee_count_range"),
        "revenue_usd": candidate.get("revenue_usd"),
        "revenue_range": candidate.get("revenue_range"),
        "country": candidate.get("country"),
        "city": candidate.get("city"),
        "site_status": research.get("site_status"),
        "evidence": candidate.get("evidence"),
        "score": candidate.get("score"),
    }
    return ("CANDIDATE:\n"
            + json.dumps(slim, indent=2, ensure_ascii=False, default=str)
            + "\n\nReturn only the JSON described in OUTPUT CONTRACT.")


# ---------------------------------------------------------------------------
# Claude call + cost accounting
# ---------------------------------------------------------------------------

def _parse_response(text: str) -> Dict[str, Any]:
    """Strip optional code fences and parse JSON."""
    s = text.strip()
    if s.startswith("```"):
        s = s.strip("`")
        if s.startswith("json"):
            s = s[4:]
        if "```" in s:
            s = s.split("```", 1)[0]
    return json.loads(s)


def _cost_usd(model: str, usage: Any) -> float:
    # Anthropic's `input_tokens` already excludes cached tokens; cache write
    # and cache read are reported separately. Sum them at their own rates.
    p = PRICING_USD_PER_MTOK.get(model, PRICING_USD_PER_MTOK[DEFAULT_MODEL])
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    cw = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cr = getattr(usage, "cache_read_input_tokens", 0) or 0
    return (inp * p["input"] + cw * p["cache_write"]
            + cr * p["cache_read"] + out * p["output"]) / 1_000_000


def judge_one(client: Any, model: str, system_prompt: str,
              candidate: Dict[str, Any]) -> tuple[Dict[str, Any], float]:
    """Call Claude once for one candidate; retry once on JSON parse failure."""
    user_msg = candidate_user_message(candidate)
    # Opus 4.7 deprecated the temperature parameter; skip it for opus-* models.
    create_kwargs: Dict[str, Any] = dict(
        model=model,
        max_tokens=1024,
        system=[{"type": "text", "text": system_prompt,
                 "cache_control": {"type": "ephemeral"}}],
    )
    if not model.startswith("claude-opus-"):
        create_kwargs["temperature"] = 0
    for attempt in (1, 2):
        resp = client.messages.create(
            **create_kwargs,
            messages=[{"role": "user", "content": [
                {"type": "text", "text": user_msg}]}],
        )
        text = "".join(b.text for b in resp.content if b.type == "text")
        cost = _cost_usd(model, resp.usage)
        try:
            return _parse_response(text), cost
        except json.JSONDecodeError as e:
            if attempt == 2:
                raise RuntimeError(
                    f"Judge response did not parse as JSON after retry. "
                    f"Last response:\n{text}") from e
            # Retry with a stricter user reminder.
            user_msg = (candidate_user_message(candidate)
                        + "\n\nYour previous response did not parse as JSON. "
                          "Return ONLY a JSON object matching OUTPUT CONTRACT.")


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def _axis(candidate: Dict[str, Any], axis: str) -> str:
    frag = (candidate.get("evidence") or {}).get(axis) or {}
    v = str(frag.get("verdict") or "").lower()
    return v if v in ("yes", "no") else "unknown"


def apply_t1_backstop(candidate: Dict[str, Any]) -> bool:
    """Deterministic guard: the LLM cannot ship an unevidenced T1.

    A t1 verdict is rewritten to t2 unless the evidence block shows
    imports == yes AND own_brand == yes (quotes guaranteed upstream by
    extract_evidence post-validation) and the judgment carries citations.
    Returns True if a downgrade happened.
    """
    judgment = candidate.get("bdr_judgment") or {}
    if (judgment.get("verdict") or "").lower() != "t1":
        return False
    missing = [axis for axis in ("imports", "own_brand")
               if _axis(candidate, axis) != "yes"]
    if not judgment.get("evidence_citations"):
        missing.append("evidence_citations")
    if not missing:
        return False
    judgment["verdict"] = "t2"
    judgment.setdefault("flags", []).append("auto-downgraded-t1-missing-evidence")
    judgment["reason"] = (judgment.get("reason", "").rstrip(". ")
                          + f". [auto-downgraded t1->t2: unverified {', '.join(missing)}]")
    return True


def judge_all(candidates: List[Dict[str, Any]], *, model: str,
              budget_usd: float, only_names: Optional[set] = None,
              limit: Optional[int] = None,
              few_shot_seed: int = 7) -> List[Dict[str, Any]]:
    from anthropic import Anthropic
    load_dotenv(ROOT / ".env")
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise RuntimeError("ANTHROPIC_API_KEY not set (add to .env).")
    client = Anthropic()
    playbook = load_playbook()
    examples = sample_examples(playbook, seed=few_shot_seed)
    system_prompt = build_system_prompt(playbook, examples)

    cumulative_cost = 0.0
    done = 0
    for cand in candidates:
        name = cand.get("name", "(unnamed)")
        if only_names and name not in only_names:
            continue
        score = cand.get("score") or {}
        if not score.get("gate_passed"):
            # Don't burn LLM cost on already-gated-out candidates.
            cand["bdr_judgment"] = {"verdict": "reject", "matched_pattern": "none",
                                    "reason": "Gated out before LLM judgment.",
                                    "deal_probability": 0.0,
                                    "what_to_sell": [],
                                    "flags": ["deterministic-gate-drop"]}
            continue
        try:
            judgment, cost = judge_one(client, model, system_prompt, cand)
        except Exception as e:  # noqa: BLE001 — surface and continue
            print(f"  [judge] {name}: ERROR {e}", file=sys.stderr)
            cand["bdr_judgment"] = {"verdict": "needs_review",
                                    "matched_pattern": "none",
                                    "reason": f"judge call failed: {e}",
                                    "deal_probability": None,
                                    "what_to_sell": [], "flags": ["judge-error"]}
            continue
        cand["bdr_judgment"] = judgment
        downgraded = apply_t1_backstop(cand)
        cumulative_cost += cost
        done += 1
        print(f"  [judge] {name:42}  {judgment.get('verdict'):>6}  "
              f"({judgment.get('matched_pattern')})"
              f"{'  [t1 backstop]' if downgraded else ''}  ${cumulative_cost:.4f}",
              file=sys.stderr)
        if cumulative_cost > budget_usd:
            raise RuntimeError(
                f"BDR judge hit cost cap (${cumulative_cost:.4f} > "
                f"${budget_usd:.2f}) after {done} candidates. Bumping the budget? "
                f"Re-run with --budget HIGHER or set BDR_JUDGE_USD_BUDGET.")
        if limit and done >= limit:
            break
        time.sleep(0.1)   # be polite
    return candidates


if __name__ == "__main__":
    load_dotenv(ROOT / ".env")
    if not os.getenv("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not set (add to .env).")

    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", required=True,
                        help="JSON list of scored company records")
    parser.add_argument("--out", required=True, help="Output JSON path")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--budget", type=float,
                        default=float(os.getenv("BDR_JUDGE_USD_BUDGET",
                                                DEFAULT_BUDGET_USD)))
    parser.add_argument("--only-names", default="",
                        help="Comma-separated company names to judge (debug)")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--seed", type=int, default=7,
                        help="Few-shot sampling seed (for stability tests)")
    args = parser.parse_args()

    candidates = json.loads(Path(args.candidates).read_text())
    if not isinstance(candidates, list):
        sys.exit("--candidates must contain a JSON list")
    only = {n.strip() for n in args.only_names.split(",") if n.strip()} or None

    judged = judge_all(candidates, model=args.model, budget_usd=args.budget,
                       only_names=only, limit=args.limit,
                       few_shot_seed=args.seed)
    Path(args.out).write_text(json.dumps(judged, indent=2, ensure_ascii=False))
    print(f"\nwrote {len(judged)} judged record(s) -> {args.out}", file=sys.stderr)
