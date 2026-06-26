"""Grade the BDR judge against the client's annotated labels.

Reads `feedback/iteration_<N>_labels.json` (or all of them), finds each labelled
company in a pool of scored candidates, runs the judge (or reads a pre-judged
file), and reports:

  - T1 precision and recall (the single number that has to not regress)
  - Confusion matrix across {reject, t1, t2, t3}
  - Per-vertical breakdown
  - Every disagreement with the judge's reason — so we can tune the playbook

This is the regression gate. Run it before every delivery.

Usage:
    # Judge fresh (default) — calls the LLM:
    python3 tools/eval_against_labels.py --candidates .tmp/scored_run4_final12.json

    # Or score a pre-judged file (no API call):
    python3 tools/eval_against_labels.py --judged .tmp/judged.json

    # Eval over the full union of all scored_*.json files:
    python3 tools/eval_against_labels.py --candidates-glob '.tmp/scored_*.json'
"""
from __future__ import annotations

import argparse
import glob
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ROOT = Path(__file__).resolve().parent.parent
FEEDBACK_DIR = ROOT / "feedback"
VERDICTS = ["t1", "t2", "t3", "reject"]


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------

def load_all_labels() -> List[Dict[str, Any]]:
    labels: List[Dict[str, Any]] = []
    for path in sorted(FEEDBACK_DIR.glob("iteration_*_labels.json")):
        doc = json.loads(path.read_text())
        labels.extend(doc.get("labels", []))
    return labels


def _norm(name: str) -> str:
    """Normalize for matching: client-typed label names rarely match vendor
    record names exactly ('and' vs '&', legal suffixes, subtitle dashes)."""
    import re
    n = (name or "").strip().lower().replace("&", " and ")
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = re.sub(r"\b(s\.?l\.?|sl|sa|srl|spa|gmbh|ltd|limited|group|grupo|and|und)\b",
               " ", n)
    return re.sub(r"\s+", " ", n).strip()


def load_candidates(paths: List[Path]) -> Dict[str, Dict[str, Any]]:
    """Build a name -> record dict, last-wins on duplicates."""
    out: Dict[str, Dict[str, Any]] = {}
    for path in paths:
        for rec in json.loads(path.read_text()):
            if rec.get("name"):
                out[_norm(rec["name"])] = rec
    return out


def find_candidate(key: str, candidates: Dict[str, Dict[str, Any]]
                   ) -> Optional[Dict[str, Any]]:
    """Exact -> containment -> token-overlap (Jaccard >= 0.5) match."""
    if key in candidates:
        return candidates[key]
    for k, rec in candidates.items():
        if key and (key in k or k in key):
            return rec
    tokens = set(key.split())
    best, best_j = None, 0.0
    for k, rec in candidates.items():
        kt = set(k.split())
        j = len(tokens & kt) / len(tokens | kt) if tokens | kt else 0.0
        if j > best_j:
            best, best_j = rec, j
    return best if best_j >= 0.5 else None


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def confusion_matrix(pairs: List[Tuple[str, str]]) -> Dict[str, Dict[str, int]]:
    """pairs: (actual_label, predicted_verdict). Both normalised to lowercase."""
    matrix: Dict[str, Dict[str, int]] = {v: {p: 0 for p in VERDICTS}
                                         for v in VERDICTS}
    for actual, pred in pairs:
        if actual in matrix and pred in matrix[actual]:
            matrix[actual][pred] += 1
    return matrix


def t1_precision_recall(pairs: List[Tuple[str, str]]) -> Tuple[float, float, int, int, int]:
    """Returns (precision, recall, true_pos, false_pos, false_neg).

    With zero t1 predictions, precision is vacuously 1.0 — the gate protects
    against FALSE t1 promises; predicting no t1s makes no false promises
    (recall reports the cost separately).
    """
    tp = sum(1 for a, p in pairs if a == "t1" and p == "t1")
    fp = sum(1 for a, p in pairs if a != "t1" and p == "t1")
    fn = sum(1 for a, p in pairs if a == "t1" and p != "t1")
    prec = tp / (tp + fp) if (tp + fp) else 1.0
    rec = tp / (tp + fn) if (tp + fn) else 0.0
    return prec, rec, tp, fp, fn


# ---------------------------------------------------------------------------
# Eval
# ---------------------------------------------------------------------------

def run_eval(labels: List[Dict[str, Any]],
             candidates: Dict[str, Dict[str, Any]],
             judged: Optional[Dict[str, Dict[str, Any]]] = None,
             *, model: str = "claude-sonnet-4-6",
             budget_usd: float = 2.0,
             few_shot_seed: int = 7,
             exclude_few_shot: bool = True) -> Dict[str, Any]:
    """Returns a structured report.

    If `judged` is None, runs the BDR judge live on candidates that match a
    label. Otherwise reads verdicts from `judged` (name -> record-with-judgment).

    De-contamination: the BDR judge embeds up to FEW_SHOT_COUNT labelled
    companies (name + their correct verdict) in its few-shot prompt, so grading
    the judge on those same companies is answer leakage that inflates the
    metric. By default we exclude any label whose company is in the few-shot
    block the judge uses (same `few_shot_seed`) and score only the HELD-OUT
    remainder — the few-shot pool is the de-facto train split. Pass
    exclude_few_shot=False to score everything (contaminated; for debugging).
    """
    few_shot_names: set = set()
    if exclude_few_shot:
        try:
            from bdr_judge import load_playbook as _load_pb
            from bdr_judge import sample_examples as _sample
            few_shot_names = {_norm(e.get("company", ""))
                              for e in _sample(_load_pb(), seed=few_shot_seed)}
        except Exception as exc:  # noqa: BLE001 — never break eval on this
            print(f"[eval] few-shot exclusion unavailable ({exc}); scoring ALL "
                  "labels — metric may be contaminated.", file=sys.stderr)

    total_label_count = len(labels)
    few_shot_excluded = [l for l in labels
                         if _norm(l["company"]) in few_shot_names]
    labels = [l for l in labels if _norm(l["company"]) not in few_shot_names]
    if few_shot_excluded:
        print(f"[eval] held-out: scoring {len(labels)} labels; excluded "
              f"{len(few_shot_excluded)} that appear in the judge's few-shot "
              f"block (seed={few_shot_seed}).", file=sys.stderr)

    matched: List[Dict[str, Any]] = []
    missing: List[str] = []
    for label in labels:
        key = _norm(label["company"])
        cand = find_candidate(key, judged) if judged else None
        if cand is None:
            cand = find_candidate(key, candidates)
        if not cand:
            missing.append(label["company"])
            continue
        matched.append({"label": label, "candidate": cand})

    if judged is None:
        # Judge fresh — import lazily so this script also works offline.
        from bdr_judge import judge_all
        to_judge = [m["candidate"] for m in matched]
        judge_all(to_judge, model=model, budget_usd=budget_usd)

    pairs: List[Tuple[str, str, Dict[str, Any]]] = []
    for m in matched:
        actual = m["label"]["verdict"]
        judgment = m["candidate"].get("bdr_judgment") or {}
        pred = (judgment.get("verdict") or "").lower()
        pairs.append((actual, pred, m))

    flat_pairs = [(a, p) for a, p, _ in pairs]
    prec, rec, tp, fp, fn = t1_precision_recall(flat_pairs)
    matrix = confusion_matrix(flat_pairs)
    disagreements = [{
        "company": m["label"]["company"],
        "vertical": m["label"]["vertical"],
        "actual": a, "predicted": p,
        "judge_reason": (m["candidate"].get("bdr_judgment") or {}).get("reason", ""),
        "judge_pattern": (m["candidate"].get("bdr_judgment") or {}).get("matched_pattern", ""),
        "client_pattern": m["label"]["pattern"],
        "client_comment": m["label"]["client_comment"],
    } for a, p, m in pairs if a != p]

    per_vertical = defaultdict(lambda: {"n": 0, "agree": 0})
    for a, p, m in pairs:
        v = m["label"]["vertical"]
        per_vertical[v]["n"] += 1
        if a == p:
            per_vertical[v]["agree"] += 1

    return {
        "total_labels": total_label_count,
        "few_shot_excluded": len(few_shot_excluded),
        "held_out_labels": len(labels),
        "matched": len(matched),
        "missing_from_candidates": missing,
        "t1_precision": round(prec, 3),
        "t1_recall": round(rec, 3),
        "t1_true_positives": tp,
        "t1_false_positives": fp,
        "t1_false_negatives": fn,
        "confusion_matrix": matrix,
        "per_vertical": {k: dict(v) for k, v in per_vertical.items()},
        "disagreements": disagreements,
    }


# ---------------------------------------------------------------------------
# Pre-ship structural audit (label-independent)
# ---------------------------------------------------------------------------

_JUDGE_TIER = {"t1": "Tier 1", "t2": "Tier 2", "t3": "Tier 3"}


def _final_tier(rec: Dict[str, Any]) -> Optional[str]:
    """Tier the lead would ship with: judge verdict wins, else score tier."""
    verdict = ((rec.get("bdr_judgment") or {}).get("verdict") or "").lower()
    if verdict == "reject":
        return None
    if verdict in _JUDGE_TIER:
        return _JUDGE_TIER[verdict]
    score = rec.get("score") or {}
    return score.get("tier") if score.get("gate_passed") else None


def _axis_v(rec: Dict[str, Any], axis: str) -> str:
    frag = (rec.get("evidence") or {}).get(axis) or {}
    v = str(frag.get("verdict") or "").lower()
    return v if v in ("yes", "no") else "unknown"


def preship_audit(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Audit the ACTUAL delivery candidates, independent of labels.

    Iteration 3 shipped with its evidence layer 100% crashed and a dead
    website in the list — the labels-only eval couldn't see either. Every
    failure here must block the delivery (exit non-zero).
    """
    failures: List[str] = []
    warnings: List[str] = []

    # Pipeline health: the research + evidence layers must have actually run.
    total = len(records)
    healthy = 0
    for rec in records:
        research = rec.get("website_research") or {}
        ev = rec.get("evidence") or {}
        research_ok = (research.get("site_status") in ("ok", "dead", "unreachable")
                       and "'str' object" not in str(research.get("error")))
        evidence_ok = bool(ev) and not ev.get("extraction_error")
        if research_ok and evidence_ok:
            healthy += 1
    health = healthy / total if total else 0.0
    if health < 0.9:
        failures.append(
            f"pipeline health {health:.0%} (<90%): research/evidence layer "
            f"ran cleanly for only {healthy}/{total} records — DO NOT SHIP, "
            "fix the pipeline and re-run (iteration-3 failure mode)")

    # Client-confirmed rejects + named competitors must never ship again.
    playbook_path = FEEDBACK_DIR / "iteration_1_labels.json"
    playbook = json.loads(playbook_path.read_text()) if playbook_path.exists() else {}
    never_ship = {_norm(e["company"]): f"known reject ({e.get('reason', '')[:60]}...)"
                  for e in playbook.get("known_rejects", [])}
    never_ship.update({_norm(e["company"]): "named competitor"
                       for e in playbook.get("named_competitors", [])})
    for label in load_all_labels():
        if label.get("verdict") == "reject":
            never_ship.setdefault(_norm(label["company"]),
                                  "client labelled reject in a past iteration")

    delivered = [(rec, _final_tier(rec)) for rec in records]
    delivered = [(rec, tier) for rec, tier in delivered if tier]

    for rec, tier in delivered:
        name = rec.get("name", "(unnamed)")
        judgment = rec.get("bdr_judgment") or {}
        ev = rec.get("evidence") or {}

        reason = never_ship.get(_norm(name))
        if reason:
            failures.append(f"{name}: would ship as {tier} but is a {reason}")

        status = (rec.get("website_research") or {}).get("site_status")
        if status == "dead":
            failures.append(f"{name}: would ship as {tier} with a DEAD website "
                            "(client: 'Me aparece como inexistente su página "
                            "web' — never ship these)")
        elif status and status != "ok":
            # unreachable = our scraper was blocked (403/429) or timed out;
            # the site is usually fine for a human visitor. Calibration
            # 2026-06-11: 3 of 4 'unreachable' candidates were live sites
            # behind bot protection. Verify by hand before sending; a site
            # that 5xxs for humans too must be dropped manually.
            warnings.append(f"{name}: ships as {tier} but site_status="
                            f"{status} — open {rec.get('website')} in a "
                            "browser and confirm it loads before sending")

        if tier == "Tier 1":
            for axis in ("imports", "own_brand"):
                frag = ev.get(axis) or {}
                if _axis_v(rec, axis) != "yes" or not (frag.get("quote") or "").strip():
                    failures.append(f"{name}: Tier 1 without quoted {axis} "
                                    "evidence")
            if not judgment.get("evidence_citations"):
                failures.append(f"{name}: Tier 1 without judge "
                                "evidence_citations")
            if (judgment.get("matched_pattern") or "none") == "none":
                failures.append(f"{name}: Tier 1 with matched_pattern 'none'")

        if str(rec.get("country") or "").strip().lower() == "israel" \
                and _axis_v(rec, "imports") != "yes":
            failures.append(f"{name}: Israeli lead without import evidence "
                            f"(would ship as {tier}) — Israel ships verified "
                            "importers only")

        if tier == "Tier 2" and (judgment.get("matched_pattern") or "none") == "none" \
                and not judgment.get("flags"):
            warnings.append(f"{name}: Tier 2 with no matched pattern or flags "
                            "— review manually")

    return {
        "total_records": total,
        "delivery_candidates": len(delivered),
        "pipeline_health": round(health, 3),
        "failures": failures,
        "warnings": warnings,
        "passed": not failures,
    }


def print_preship(report: Dict[str, Any]) -> None:
    print("=" * 72)
    print(f"PRE-SHIP AUDIT: {report['delivery_candidates']} delivery "
          f"candidate(s) out of {report['total_records']} records; "
          f"pipeline health {report['pipeline_health']:.0%}")
    for f in report["failures"]:
        print(f"  FAIL  {f}")
    for w in report["warnings"]:
        print(f"  warn  {w}")
    print("=" * 72)
    print(f"\n  Pre-ship audit: {'PASS' if report['passed'] else 'FAIL — DO NOT SHIP'}")


def print_report(report: Dict[str, Any]) -> None:
    print("=" * 72)
    print(f"Eval: {report['matched']}/{report['total_labels']} labels matched to "
          f"candidates ({len(report['missing_from_candidates'])} missing)")
    if report["missing_from_candidates"]:
        print("  missing:", ", ".join(report["missing_from_candidates"]))
    print(f"\nT1 precision: {report['t1_precision']:.2%}  "
          f"recall: {report['t1_recall']:.2%}  "
          f"(TP={report['t1_true_positives']}, FP={report['t1_false_positives']}, "
          f"FN={report['t1_false_negatives']})")

    print("\nConfusion matrix (rows = actual, columns = predicted):")
    print(f"  {'':>10}" + "".join(f"{v:>8}" for v in VERDICTS))
    for v in VERDICTS:
        row = report["confusion_matrix"][v]
        print(f"  {v:>10}" + "".join(f"{row[c]:>8}" for c in VERDICTS))

    print("\nPer vertical (agreement rate):")
    for v, stats in sorted(report["per_vertical"].items()):
        rate = stats["agree"] / stats["n"] if stats["n"] else 0.0
        print(f"  {v:>26}  {stats['agree']:>3}/{stats['n']:<3}  ({rate:.0%})")

    if report["disagreements"]:
        print(f"\nDisagreements ({len(report['disagreements'])}):")
        for d in report["disagreements"]:
            print(f"  - {d['company']} [{d['vertical']}]: "
                  f"client said '{d['actual']}' ({d['client_pattern']}), "
                  f"judge said '{d['predicted']}' ({d['judge_pattern']})")
            print(f"      judge: {d['judge_reason']}")
            print(f"      client: {d['client_comment'][:120]}...")
    print("=" * 72)

    # Final gate verdict
    gate = report["t1_precision"] >= 0.9
    msg = "PASS" if gate else "FAIL"
    if report["t1_true_positives"] + report["t1_false_positives"] == 0:
        msg += " (no t1 predictions — vacuously no false promises)"
    print(f"\n  T1-precision ≥ 0.9 gate: {msg}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidates", default="",
                        help="JSON list of scored company records to judge from")
    parser.add_argument("--candidates-glob", default="",
                        help="Glob over multiple scored JSON files (union'd)")
    parser.add_argument("--judged", default="",
                        help="Pre-judged JSON list (skip the LLM call)")
    parser.add_argument("--preship", default="",
                        help="Judged delivery-candidates JSON: run the "
                             "label-independent pre-ship structural audit "
                             "(exit non-zero on any failure)")
    parser.add_argument("--model", default="claude-sonnet-4-6")
    parser.add_argument("--budget", type=float, default=2.0)
    parser.add_argument("--report-out", default="",
                        help="Optional path to write the full report as JSON")
    args = parser.parse_args()

    sys.path.insert(0, str(ROOT / "tools"))  # so bdr_judge is importable

    if args.preship:
        records = json.loads(Path(args.preship).read_text())
        preship = preship_audit(records)
        print_preship(preship)
        if args.report_out:
            Path(args.report_out).write_text(
                json.dumps(preship, indent=2, ensure_ascii=False))
        sys.exit(0 if preship["passed"] else 1)

    labels = load_all_labels()
    if not labels:
        sys.exit("No labels found in feedback/iteration_*_labels.json")

    paths: List[Path] = []
    if args.candidates:
        paths.append(Path(args.candidates))
    if args.candidates_glob:
        paths.extend(Path(p) for p in glob.glob(args.candidates_glob))
    if args.judged:
        paths = [Path(args.judged)]
    if not paths:
        sys.exit("Provide --candidates, --candidates-glob, --judged, or --preship.")

    candidates = load_candidates(paths)
    judged = candidates if args.judged else None

    report = run_eval(labels, candidates, judged=judged,
                      model=args.model, budget_usd=args.budget)
    print_report(report)
    if args.report_out:
        Path(args.report_out).write_text(json.dumps(report, indent=2, ensure_ascii=False))
        print(f"\nfull report -> {args.report_out}", file=sys.stderr)
    sys.exit(0 if report["t1_precision"] >= 0.9 else 1)
