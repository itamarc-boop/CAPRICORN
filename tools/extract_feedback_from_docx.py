"""Parse client-annotated Iteration-N-Report.docx into a labels JSON skeleton.

The client writes per-company comments directly into the delivered report. This
script reads the .docx (no python-docx dependency — just zipfile + xml), walks
the table of companies, and emits one label record per company with a best-guess
verdict + pattern. The human is expected to verify the output before merging
into ``feedback/iteration_<N>_labels.json``.

Heuristics (best effort; verify by hand):
- "NO RELEVANTE" in the comment  -> reject
- "no va en T1" / "no son T1" / "viene harto más abajo" -> t3
- A standalone ✅ with no caveat                       -> t1
- ✅ with a "pero no va en T1" / "no T1" caveat        -> t2
- "más o menos" / "no es mi prioridad"                  -> t3
- Anything else                                          -> needs_review

Pattern tags are guessed from substring matches against the master pattern map
in ``feedback/iteration_1_labels.json`` (loaded if present); unknown patterns
are emitted as ``"unclassified"``.

Usage:
    python3 tools/extract_feedback_from_docx.py \
        --docx Iteration-2-Report.docx --iteration 2 \
        > feedback/iteration_2_labels.skeleton.json
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# Markers in the comment text that pin a verdict.
REJECT_MARKERS = ["no relevante", "pérdida de tiempo", "no vendemos", "no tienen overlap"]
T3_MARKERS = [
    "no va en t1", "no son t1", "no es t1", "no es mi prioridad",
    "más o menos", "mas o menos", "viene harto más abajo", "viene harto mas abajo",
    "no parece ser un typical", "solo envases imagino", "no creo que sean t1",
]
T2_MARKERS = [
    "tiene productos que le puedo vender, pero no mucha variedad",
    "hong kong", "asia sourcing", "sourcing team",
    "no venden a wholesalers",
    "muy buen target",
]


def _docx_paragraphs(path: Path) -> List[str]:
    """Return the document's paragraphs as plain text, in order."""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml")
    root = ET.fromstring(xml)
    paragraphs: List[str] = []
    for para in root.iter(W_NS + "p"):
        text = "".join(t.text or "" for t in para.iter(W_NS + "t"))
        if text.strip():
            paragraphs.append(text.strip())
    return paragraphs


def _classify_verdict(comment: str, has_checkmark: bool) -> str:
    c = comment.lower()
    if any(m in c for m in REJECT_MARKERS):
        return "reject"
    if any(m in c for m in T3_MARKERS):
        return "t3"
    if any(m in c for m in T2_MARKERS):
        return "t2"
    if has_checkmark and not comment.replace("✅", "").strip():
        return "t1"
    if has_checkmark:
        return "t2"
    return "needs_review"


def _guess_pattern(comment: str, patterns: Dict[str, str]) -> str:
    c = comment.lower()
    # Order matters — most specific first.
    keyword_to_pattern = [
        ("químicos agrícolas", "agrochemicals-wrong-supply-chain"),
        ("agrochemic", "agrochemicals-wrong-supply-chain"),
        ("biológico y de pest control", "biological-pest-control-not-physical-inputs"),
        ("ganado", "animal-feed-not-pet-food"),
        ("químicos de construcción", "construction-chemicals-wrong-supply-chain"),
        ("ingredient supplier", "ingredient-supplier-not-finished-goods"),
        ("solo venden lo que producen", "dtc-only-own-brand"),
        ("no tienen su marca propia", "no-own-brand-reseller"),
        ("son mi competencia", "direct-competitor"),
        ("ultra-premium", "ultra-premium-anti-commodity"),
        ("anti-commodity", "ultra-premium-anti-commodity"),
        ("fragancias", "out-of-product-fragrance"),
        ("eu made", "eu-made-proud-producer"),
        ("hong kong", "has-asia-sourcing-already"),
        ("no venden a wholesalers", "no-wholesaler-channel"),
        ("clínicos", "medical-clinical-not-consumer"),
        ("mar muerto", "native-ingredient-only"),
        ("typical volumen importer", "not-volume-importer"),
        ("typical volume importer", "not-volume-importer"),
        ("hay un gap", "producer-with-resale-gap"),
        ("productor de cosméticos", "cosmetics-pure-producer-slow-cycle"),
        ("fábrica de vasos", "producer-non-priority"),
    ]
    for needle, tag in keyword_to_pattern:
        if needle in c:
            return tag
    return "confirmed-good-fit" if comment.strip().startswith("✅") else "unclassified"


def _split_into_company_blocks(paragraphs: List[str]) -> List[Dict[str, Any]]:
    """Walk paragraphs, group by company. Each block: name, tier, score, comment."""
    # The report's table renders as: <Company Name> ... <comment> ... <vertical>
    # <Tier N> <score> <contact>. The same column header row "Company / Product area
    # / Tier / Pts / Key contact" repeats per country and bookends each block.
    blocks: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None
    header_seen = False
    for line in paragraphs:
        if line in ("Company", "Product area", "Key contact"):
            header_seen = True
            continue
        if line in ("Tier", "Pts"):
            continue
        # Country header like "Spain (6)" — flush current
        if re.fullmatch(r"[A-Z][A-Za-z ]+ \(\d+\)", line):
            if current:
                blocks.append(current)
                current = None
            continue
        if line == "Summary" or line.startswith("How the system works") or \
                line.startswith("Coverage and data quality") or \
                line.startswith("Most companies also have"):
            if current:
                blocks.append(current)
                current = None
            header_seen = False
            continue
        # Tier line
        m = re.fullmatch(r"T([123])", line)
        if m and current:
            current["tier"] = "Tier " + m.group(1)
            continue
        # Score line
        if line.isdigit() and current and "score" not in current:
            current["score"] = int(line)
            continue
        # New company line: starts with capital letter, isn't a known field label,
        # and (heuristic) we just saw a header or finished a previous block.
        looks_like_company = (
            line[:1].isalpha() and line[:1].isupper()
            and "T1" not in line and "T2" not in line and "T3" not in line
            and not line.endswith(":")
            and len(line) < 80
        )
        if looks_like_company and (current is None or "tier" in current):
            if current:
                blocks.append(current)
            current = {"name": line.replace("✅", "").replace("❌", "").strip(),
                       "has_checkmark": "✅" in line, "comment_lines": []}
            continue
        if current is not None:
            current["comment_lines"].append(line)
    if current:
        blocks.append(current)
    # Filter out spurious blocks (no comment AND no score).
    return [b for b in blocks if b.get("name") and (b.get("comment_lines") or b.get("score"))]


def extract(docx_path: Path, iteration: int,
            patterns: Dict[str, str]) -> List[Dict[str, Any]]:
    paragraphs = _docx_paragraphs(docx_path)
    blocks = _split_into_company_blocks(paragraphs)
    labels: List[Dict[str, Any]] = []
    for b in blocks:
        # Comment = everything between the company name and the vertical/tier rows.
        comment_parts = [p for p in b["comment_lines"]
                         if not re.fullmatch(r"T[123]", p) and not p.isdigit()]
        comment = " ".join(comment_parts).strip()
        verdict = _classify_verdict(comment, b.get("has_checkmark", False))
        pattern = _guess_pattern(comment, patterns) if comment else "confirmed-good-fit"
        labels.append({
            "iteration": iteration,
            "company": b["name"],
            "delivered_tier": b.get("tier"),
            "delivered_score": b.get("score"),
            "verdict": verdict,
            "pattern": pattern,
            "client_comment": comment,
        })
    return labels


def _load_known_patterns() -> Dict[str, str]:
    path = ROOT / "feedback" / "iteration_1_labels.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text()).get("patterns", {})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--docx", required=True, help="Iteration-N-Report.docx")
    parser.add_argument("--iteration", type=int, required=True)
    args = parser.parse_args()

    labels = extract(Path(args.docx), args.iteration, _load_known_patterns())
    needs_review = [l for l in labels if l["verdict"] == "needs_review"]
    print(json.dumps({
        "schema_version": 1,
        "source": f"{Path(args.docx).name} (auto-extracted; HUMAN MUST VERIFY)",
        "labels": labels,
    }, indent=2, ensure_ascii=False))
    print(f"\nextracted {len(labels)} label(s); "
          f"{len(needs_review)} need human verdict review.", file=sys.stderr)
