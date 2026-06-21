"""Parse a client-annotated companies.xlsx into a labels JSON skeleton.

Iteration-3 feedback arrived as a spreadsheet instead of an annotated docx:
col A = company name, col B = website, col D = verdict cell (a bare emoji
checkmark/cross OR free prose), col E = comment. Rows with no website in
col B are free-text general conclusions, collected separately as
``general_notes``.

Same contract as extract_feedback_from_docx.py: heuristics produce a
best-guess verdict + pattern per company; a HUMAN MUST VERIFY the skeleton
before promoting it to ``feedback/iteration_<N>_labels.json``.

Usage:
    python3 tools/extract_feedback_from_xlsx.py \
        --xlsx companies.xlsx --iteration 3 \
        --delivered .tmp/iter3_judged_v2.json \
        > feedback/iteration_3_labels.skeleton.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import openpyxl

ROOT = Path(__file__).resolve().parent.parent

CHECK = "✅"   # ✅
CROSS = "❌"   # ❌

# Comment markers that pin a verdict (lowercase substring match).
REJECT_MARKERS = [
    "no relevante", "waste of time", "no importan nada",
    "pérdida de tiempo", "perdida de tiempo",
]
T3_MARKERS = [
    "no prioridad", "no es mi prioridad", "no son prioridad",
    "no hay mucho que venderles", "t2 o t3", "tier 2 o 3",
    "no tan relevante", "se demoraría", "se demoraria",
]
T2_MARKERS = [
    "t1 o t2", "no sé si importarán", "no se si importaran",
    "sin un claim real", "si será importador", "si sera importador",
    "no sé su tamaño", "no se su tamano",
]
T1_MARKERS = ["muy buen fit", "muy buen target"]

DEAD_SITE_MARKERS = ["inexistente su página web", "inexistente su pagina web"]

# Pattern guesses, most specific first.
PATTERN_KEYWORDS = [
    ("inexistente su página", "dead-website"),
    ("inexistente su pagina", "dead-website"),
    ("cliente nuestro en chile", "group-subsidiary-local-mismatch"),
    ("compran a importadores locales", "group-subsidiary-local-mismatch"),
    ("empresa de comida", "food-distributor-not-disposables"),
    ("sustrato de coco", "adjacent-category-mismatch"),
    ("motores", "adjacent-category-mismatch"),
    ("embalajes", "adjacent-category-mismatch"),
    ("no es de las más importantes", "adjacent-category-mismatch"),
    ("no es de las mas importantes", "adjacent-category-mismatch"),
    ("fábrica full", "pure-manufacturer-no-import"),
    ("fabrica full", "pure-manufacturer-no-import"),
    ("estaría entrando a competirle", "pure-manufacturer-no-import"),
    ("estaria entrando a competirle", "pure-manufacturer-no-import"),
    ("manufacturer, sin muchas pistas", "pure-manufacturer-no-import"),
    ("es fábrica", "pure-manufacturer-no-import"),
    ("es fabrica", "pure-manufacturer-no-import"),
    ("dependiendo del volumen", "volume-dependent-tier"),
    ("sin un claim real", "claimed-import-without-evidence"),
    ("no sé si importarán", "claimed-import-without-evidence"),
    ("no se si importaran", "claimed-import-without-evidence"),
    ("si será importador", "claimed-import-without-evidence"),
    ("si sera importador", "claimed-import-without-evidence"),
    ("productor de cosméticos", "cosmetics-pure-producer-slow-cycle"),
    ("productor de cosmeticos", "cosmetics-pure-producer-slow-cycle"),
    ("productores de todo", "producer-non-priority"),
    ("prefieren producir", "producer-non-priority"),
    # third-party brands: fit-qualified vs plain reseller decided below
    ("product fit, pero no tienen private label", "third-party-distributor-product-fit"),
    ("marcas de terceros", "no-own-brand-reseller"),
    ("marcas externas", "no-own-brand-reseller"),
    ("no tienen marca propia", "no-own-brand-reseller"),
    ("venden marcas de terceros", "no-own-brand-reseller"),
]


def _classify_verdict(comment: str, mark: Optional[str]) -> str:
    c = comment.lower()
    if any(m in c for m in DEAD_SITE_MARKERS):
        return "reject"
    if mark == CROSS:
        return "reject"
    if any(m in c for m in REJECT_MARKERS):
        return "reject"
    if any(m in c for m in T3_MARKERS):
        return "t3"
    if any(m in c for m in T2_MARKERS):
        return "t2"
    if mark == CHECK:
        if not c.strip() or any(m in c for m in T1_MARKERS):
            return "t1"
        return "needs_review"
    return "needs_review"


def _guess_pattern(comment: str, verdict: str) -> str:
    c = comment.lower()
    for needle, tag in PATTERN_KEYWORDS:
        if needle in c:
            return tag
    if verdict == "t1":
        return "confirmed-good-fit"
    return "unclassified"


def _norm_name(name: str) -> str:
    n = name.lower().replace("&", " and ")
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = re.sub(
        r"\b(s\.?l\.?|s\.?a\.?|srl|spa|gmbh|ltd|limited|group|grupo|and|und)\b",
        " ", n)
    return re.sub(r"\s+", " ", n).strip()


def _load_delivered(path: Path) -> Dict[str, Dict[str, Any]]:
    """Index delivered records by normalized name for the join."""
    records = json.loads(path.read_text())
    index: Dict[str, Dict[str, Any]] = {}
    for r in records:
        name = r.get("name") or (r.get("score") or {}).get("name") or ""
        if name:
            index[_norm_name(name)] = r
    return index


def _join_delivered(label: Dict[str, Any],
                    index: Dict[str, Dict[str, Any]]) -> None:
    key = _norm_name(label["company"])
    rec = index.get(key)
    if rec is None:  # fuzzy: containment, then token overlap
        for k, r in index.items():
            if key and (key in k or k in key):
                rec = r
                break
    if rec is None and key:
        tokens = set(key.split())
        best, best_j = None, 0.0
        for k, r in index.items():
            kt = set(k.split())
            j = len(tokens & kt) / len(tokens | kt) if tokens | kt else 0.0
            if j > best_j:
                best, best_j = r, j
        if best_j >= 0.5:
            rec = best
    if rec is None:
        label["join"] = "NOT FOUND in delivered records"
        return
    score = rec.get("score") or {}
    label["country"] = (rec.get("country") or "").title() or None
    label["delivered_tier"] = score.get("tier")
    label["delivered_score"] = score.get("total_score")


def extract(xlsx_path: Path, iteration: int,
            delivered: Optional[Path]) -> Dict[str, Any]:
    ws = openpyxl.load_workbook(xlsx_path)["Companies"]
    labels: List[Dict[str, Any]] = []
    general_notes: List[str] = []

    for row in ws.iter_rows(min_row=2, values_only=True):
        cells = [str(v).strip() if v is not None else "" for v in row]
        name, website = cells[0], cells[1]
        if not name:
            continue
        if not website:  # free-text conclusion row
            general_notes.append(name)
            continue
        rest = [c for c in cells[2:] if c]
        mark = None
        comment_parts = []
        for c in rest:
            if c in (CHECK, CROSS):
                mark = c
            else:
                if c.startswith((CHECK, CROSS)):
                    mark = c[0]
                    c = c[1:].strip()
                if c:
                    comment_parts.append(c)
        comment = " ".join(comment_parts).strip()
        verdict = _classify_verdict(comment, mark)
        label = {
            "iteration": iteration,
            "country": None,
            "company": name,
            "vertical": None,
            "delivered_tier": None,
            "delivered_score": None,
            "verdict": verdict,
            "pattern": _guess_pattern(comment, verdict),
            "client_comment": (f"{mark}. {comment}" if mark and comment
                               else mark or comment),
        }
        labels.append(label)

    if delivered:
        index = _load_delivered(delivered)
        for label in labels:
            _join_delivered(label, index)

    return {
        "schema_version": 1,
        "source": f"{xlsx_path.name} (auto-extracted; HUMAN MUST VERIFY)",
        "general_notes": general_notes,
        "labels": labels,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--xlsx", required=True, help="client feedback xlsx")
    parser.add_argument("--iteration", type=int, required=True)
    parser.add_argument("--delivered", help="judged records JSON to join "
                        "country/tier/score from (e.g. .tmp/iter3_judged_v2.json)")
    args = parser.parse_args()

    out = extract(Path(args.xlsx), args.iteration,
                  Path(args.delivered) if args.delivered else None)
    print(json.dumps(out, indent=2, ensure_ascii=False))
    needs = [l for l in out["labels"] if l["verdict"] == "needs_review"]
    print(f"\nextracted {len(out['labels'])} label(s), "
          f"{len(out['general_notes'])} general note(s); "
          f"{len(needs)} need human verdict review.", file=sys.stderr)
