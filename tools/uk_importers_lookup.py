"""Definitive, FREE UK import evidence from HMRC's monthly importer register.

uktradeinfo.com publishes "Importer details" monthly: every business that
imported goods into the UK that month (non-EU trade + GB-EU above thresholds),
with the 8-digit commodity codes they imported. A name match is hard evidence
of import motion — the killer signal for Capricorn's ICP that company websites
rarely state. Format (tab-separated): YYYYMM, seq, NAME, addr1..5, postcode,
comcode1..N.

Matching is deliberately conservative (exact normalized name, or full token
containment with >= 2 tokens): import evidence must be solid. A NON-match is
NOT negative evidence — the register only covers that month and that trade
scope — so unmatched companies keep imports = unknown.

Run AFTER extract_evidence.py and BEFORE scoring; it only ever UPGRADES
imports from unknown -> yes (never overrides a site-derived verdict).

Usage:
    python3 tools/uk_importers_lookup.py \
        --records .tmp/records_with_evidence.json \
        --out .tmp/records_uk_verified.json [--month 2603] [--refresh]

No API key needed. The monthly file (~5 MB zip) is cached in
.tmp/uk_importers/.
"""
from __future__ import annotations

import argparse
import io
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".tmp" / "uk_importers"
BULK_PAGE = "https://www.uktradeinfo.com/trade-data/latest-bulk-datasets/"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"

UK_COUNTRY_NAMES = {"united kingdom", "uk", "great britain", "england",
                    "scotland", "wales", "northern ireland"}

# Capricorn-relevant HS chapters/headings (4-digit prefixes of the 8-digit
# comcodes). Indicative map — a name match alone is import evidence; a
# comcode hit in these additionally confirms product-fit-relevant imports.
VERTICAL_HS_PREFIXES = {
    "3923": "plastic packaging goods",
    "3924": "plastic tableware/household",
    "3920": "plastic films/sheets",
    "3921": "plastic films/sheets (cellular)",
    "4818": "paper tissues/tableware",
    "4819": "paper packaging",
    "4823": "other paper articles",
    "5603": "nonwovens",
    "5608": "nets",
    "2309": "pet food preparations",
    "3402": "cleaning preparations",
    "9619": "hygiene articles (wipes/pads)",
    "6307": "textile articles incl. cleaning cloths",
}

_SUFFIXES = re.compile(
    r"\b(ltd|limited|plc|llp|llc|co|company|holdings|group|uk|gb|"
    r"international|and|&)\b")


def _norm_name(name: str) -> str:
    n = (name or "").lower().replace("&", " and ")
    n = re.sub(r"[^a-z0-9 ]", " ", n)
    n = _SUFFIXES.sub(" ", n)
    return re.sub(r"\s+", " ", n).strip()


# ---------------------------------------------------------------------------
# Download + parse
# ---------------------------------------------------------------------------

def discover_link(month: Optional[str]) -> Tuple[str, str]:
    """Find the importers zip URL on the bulk-datasets page.

    Returns (url, yymm). `month` like '2603' picks that file if listed;
    otherwise the latest one on the page is used.
    """
    resp = requests.get(BULK_PAGE, headers={"User-Agent": USER_AGENT},
                        timeout=30)
    resp.raise_for_status()
    found = re.findall(r'href="(/media/[^"]+/importers(\d{4})\.zip)"', resp.text)
    if not found:
        raise RuntimeError(f"no importers zip link found on {BULK_PAGE} — "
                           "page layout may have changed")
    if month:
        for path, yymm in found:
            if yymm == month:
                return "https://www.uktradeinfo.com" + path, yymm
        raise RuntimeError(f"month {month} not on the page; available: "
                           f"{[m for _, m in found]}")
    path, yymm = max(found, key=lambda t: t[1])
    return "https://www.uktradeinfo.com" + path, yymm


def load_register(month: Optional[str] = None,
                  refresh: bool = False) -> Tuple[Dict[str, Set[str]], str]:
    """Return ({normalized importer name: {comcodes}}, yymm). Cached on disk."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cached = sorted(CACHE_DIR.glob("importers*.zip"))
    zip_path: Optional[Path] = None
    yymm = month or ""
    if not refresh:
        for p in cached:
            m = re.search(r"importers(\d{4})\.zip", p.name)
            if m and (not month or m.group(1) == month):
                zip_path, yymm = p, m.group(1)
    if zip_path is None:
        url, yymm = discover_link(month)
        zip_path = CACHE_DIR / f"importers{yymm}.zip"
        print(f"  downloading {url} ...", file=sys.stderr)
        resp = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=120)
        resp.raise_for_status()
        zip_path.write_bytes(resp.content)

    register: Dict[str, Set[str]] = {}
    with zipfile.ZipFile(zip_path) as z:
        name = z.namelist()[0]
        with z.open(name) as f:
            for raw in io.TextIOWrapper(f, encoding="latin-1"):
                fields = raw.rstrip("\n").split("\t")
                if len(fields) < 10:
                    continue
                key = _norm_name(fields[2])
                if not key:
                    continue
                codes = {c for c in fields[9:] if re.fullmatch(r"\d{8}", c)}
                register.setdefault(key, set()).update(codes)
    return register, yymm


# ---------------------------------------------------------------------------
# Matching
# ---------------------------------------------------------------------------

def match_company(name: str,
                  register: Dict[str, Set[str]]) -> Optional[Tuple[str, Set[str]]]:
    """Conservative match: exact normalized name, else full token containment.

    Containment requires the SHORTER name to have >= 3 tokens — short generic
    names must match exactly. Calibration 2026-06-10: 'green tech' (2 tokens)
    containment-matched 'green tech automotive', a different company, and
    minted false import evidence. Import evidence must be solid; a missed
    match just stays 'unknown'.
    """
    key = _norm_name(name)
    if not key:
        return None
    if key in register:
        return key, register[key]
    tokens = set(key.split())
    for reg_key, codes in register.items():
        reg_tokens = set(reg_key.split())
        small, large = sorted((tokens, reg_tokens), key=len)
        if len(small) >= 3 and small <= large:
            return reg_key, codes
    return None


def apply_to_records(records: List[dict], register: Dict[str, Set[str]],
                     yymm: str) -> int:
    """Upgrade evidence.imports unknown -> yes for UK matches. Returns count."""
    upgraded = 0
    for rec in records:
        country = str(rec.get("country") or "").strip().lower()
        if country not in UK_COUNTRY_NAMES:
            continue
        ev = rec.get("evidence") or {}
        imports = ev.get("imports") or {}
        verdict = str(imports.get("verdict") or "unknown").lower()
        hit = match_company(rec.get("name") or "", register)
        if hit is None:
            continue
        reg_name, codes = hit
        relevant = sorted({f"{c[:4]} ({VERTICAL_HS_PREFIXES[c[:4]]})"
                           for c in codes if c[:4] in VERTICAL_HS_PREFIXES})
        rec.setdefault("evidence", ev)
        ev["uk_importer_match"] = {
            "register_month": yymm, "matched_name": reg_name,
            "comcodes": sorted(codes), "capricorn_relevant_chapters": relevant,
        }
        if verdict == "unknown":
            sample = ", ".join(sorted(codes)[:6])
            ev["imports"] = {
                "verdict": "yes",
                "quote": (f"HMRC UK Importer register 20{yymm[:2]}-{yymm[2:]}: "
                          f"'{reg_name}' imported under commodity codes "
                          f"{sample}"),
                "quote_en": None,
                "source_url": "https://www.uktradeinfo.com/trade-data/"
                              "latest-bulk-datasets/",
            }
            upgraded += 1
            print(f"  [uk-importers] {rec.get('name'):42} MATCH "
                  f"({len(codes)} comcodes"
                  f"{'; relevant: ' + ', '.join(relevant) if relevant else ''})",
                  file=sys.stderr)
        else:
            print(f"  [uk-importers] {rec.get('name'):42} match noted "
                  f"(imports already '{verdict}')", file=sys.stderr)
    return upgraded


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--records", required=True,
                        help="records JSON (after extract_evidence.py)")
    parser.add_argument("--out", required=True)
    parser.add_argument("--month", default=None,
                        help="register month as YYMM, e.g. 2603 (default: "
                             "latest cached or latest published)")
    parser.add_argument("--refresh", action="store_true",
                        help="force re-download even if cached")
    args = parser.parse_args()

    records = json.loads(Path(args.records).read_text())
    register, yymm = load_register(args.month, refresh=args.refresh)
    print(f"  register 20{yymm[:2]}-{yymm[2:]}: {len(register):,} importers",
          file=sys.stderr)
    upgraded = apply_to_records(records, register, yymm)
    Path(args.out).write_text(json.dumps(records, indent=2, ensure_ascii=False))
    uk = sum(1 for r in records
             if str(r.get('country') or '').lower() in UK_COUNTRY_NAMES)
    print(f"\nchecked {uk} UK record(s), upgraded imports for {upgraded} "
          f"-> {args.out}", file=sys.stderr)
