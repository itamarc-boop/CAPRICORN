"""Website research for the two ICP qualifier gates Apollo/Explorium can't answer.

Resolves, as yes / no / unknown:
  * warehouse           — does the company operate a warehouse / dist. centre?
  * private_label_only  — does it sell ONLY its own private-label / plain
                          product, or also third-party brands?
                          (third-party brands == disqualified, per the client)

Also reports which keyword families appear (feeds the 20-pt keyword-match
criterion).

Heuristic and deliberately conservative: when evidence is weak or conflicting
it returns 'unknown' — the scoring engine keeps unknowns and flags them for
human review rather than dropping the company.

Calibration 2026-05-20 (Spain pilot): modern company sites are JS single-page
apps with no crawlable links in their static HTML. So this tool now also
(a) probes a fixed list of common about/company page paths directly, and
(b) extracts meta descriptions, OpenGraph tags and JSON-LD structured data,
which survive even on JS-rendered pages. `merge_research()` lets the caller
fold in the Explorium business description as an extra evidence source.

Update 2026-06 (iteration-3 post-mortem): the regex gates above are now a
FALLBACK signal only — the LLM evidence extractor (tools/extract_evidence.py)
makes the gate decisions from the fetched page text. This tool additionally:
  * classifies ``site_status``: ok / dead (DNS, SSL, refused, 404/410) /
    unreachable (timeout, 5xx, bot-blocked 401/403/429) — iteration 3 shipped
    a company whose domain didn't resolve;
  * returns the fetched ``pages`` [{url, text}] so the extractor reuses the
    same fetch;
  * has a batch CLI that owns the merge with the Explorium description.
    Iteration 3 used an ad-hoc runner that passed the description STRING
    where a dict was required — website_research crashed for 100% of records
    and the run shipped anyway. Batch mode makes that bug class impossible
    and exits non-zero when too much of the run failed.

No paid API — just HTTP requests.

Usage:
    from tools.research_company_website import research_website, analyze_text, merge_research
    result = research_website("https://example.com")

Run directly:
    python tools/research_company_website.py https://example.com   # live fetch
    python tools/research_company_website.py                       # offline demo
    python tools/research_company_website.py \
        --records .tmp/records.json --out .tmp/records_with_research.json
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import re
import socket
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Tuple
from urllib.parse import urljoin, urlparse

import lxml.html
import requests

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
              "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36")
TIMEOUT = 8                   # was 12 — dead/slow sites were the dominant cost
MAX_REDIRECTS = 5             # followed manually so each hop is SSRF-checked
MAX_PAGES = 5                 # was 7 — homepage + common paths carry the signal
MAX_ATTEMPTS = 10             # was 16
PAGE_TEXT_CAP = 6000          # chars kept per page for the LLM extractor
BATCH_FAIL_THRESHOLD = 0.25   # batch mode exits non-zero above this failure rate

# Beyond the homepage, visit pages whose URL/anchor text matches these hints.
PAGE_HINTS = ["about", "company", "who-we-are", "who_we_are", "our-story",
              "product", "brand", "private-label", "private_label",
              "warehouse", "logistic", "distribution", "facilit", "service"]

# Common about/company page paths, probed directly — modern JS homepages have
# no crawlable <a> links in their static HTML. Multilingual (EN/ES/IT/DE).
COMMON_PATHS = [
    "about", "about-us", "company", "who-we-are", "our-company", "our-story",
    "en/about", "en/company", "en/about-us",
    "sobre-nosotros", "quienes-somos", "nosotros", "empresa", "la-empresa",
    "chi-siamo", "azienda", "ueber-uns", "uber-uns", "unternehmen",
]

# --- evidence patterns (plain substring match, lower-cased) ------------------

WAREHOUSE_POSITIVE = [
    "our warehouse", "warehouse facility", "warehousing", "distribution centre",
    "distribution center", "logistics centre", "logistics center",
    "fulfilment centre", "fulfillment center", "storage facility",
    "stocked in our", "from our warehouse", "m² warehouse", "sq m warehouse",
    "square metre warehouse", "distribution hub", "we hold stock",
    "ready to ship from", "our facility in", "our facilities in",
    "logistics center", "centro logistico", "centro logístico", "almacen",
    "almacén", "nave logistica", "magazzino", "lagerhaus", "logistikzentrum",
]
WAREHOUSE_NEGATIVE = [
    "drop-ship only", "dropship only", "drop ship only", "we do not hold stock",
    "we don't hold stock", "no warehouse", "without holding inventory",
    "made to order only", "no stock held",
]

PRIVATE_LABEL_POSITIVE = [
    "private label", "private-label", "own brand", "own-brand", "house brand",
    "we manufacture our own", "our own brand", "white label", "white-label",
    "contract manufactur", "oem/odm", "oem & odm", "oem and odm",
    "plain branded", "unbranded product", "manufacturer of our own",
    "we produce our own", "our private label", "our own products",
    "developed in our own", "our own laboratory", "marca propia",
]
THIRD_PARTY_SIGNALS = [
    "authorised distributor", "authorized distributor", "official distributor of",
    "official distributor for", "brands we carry", "brands we distribute",
    "brands we stock", "we distribute the following", "our brand partners",
    "distributor of leading brands", "exclusive distributor of", "stockist of",
    "official partner of", "we are proud to distribute", "brands we work with",
    "the brands we represent", "distribute and retail", "distributors and retailers",
    "distribuidores y retailers", "multi-brand retailer", "house of brands",
    "official retailer of", "the brands we sell", "selection of korean",
]

# Keyword families for the keyword-match criterion (whole-word match).
KEYWORD_FAMILIES: Dict[str, List[str]] = {
    "import": ["import", "imports", "importer", "importers", "imported",
               "importing", "imports from asia"],
    "distributor": ["distributor", "distributors", "distribution", "distributing"],
    "wholesale": ["wholesale", "wholesaler", "wholesalers", "wholesaling"],
    "manufacture": ["manufacture", "manufactures", "manufacturer",
                    "manufacturers", "manufacturing"],
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _assert_public_url(url: str) -> None:
    """Raise if `url` isn't a plain http(s) URL resolving to a PUBLIC address.

    The `website` we fetch comes straight from Explorium / the company record,
    i.e. it is host-controlled. Without this guard a crafted `website` (or an
    open redirect on a real site) could make the worker fetch an internal
    target — cloud metadata (169.254.169.254), localhost, or RFC1918 hosts —
    and surface the response text back into the evidence (SSRF). We resolve the
    host and reject if ANY resolved IP is non-global. (Residual TOCTOU between
    resolve and connect is accepted for this low-blast-radius CI tool.)
    """
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"blocked non-http(s) URL scheme: {parsed.scheme!r}")
    host = parsed.hostname
    if not host:
        raise ValueError("blocked URL with no host")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    # getaddrinfo raises socket.gaierror for a non-resolving host; let that
    # propagate so the caller classifies it as a dead/unreachable domain.
    for info in socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_reserved or ip.is_multicast:
            raise ValueError(
                f"blocked SSRF: host {host!r} resolves to non-public address {ip}")


def _fetch(url: str) -> str | None:
    """GET a URL; return HTML text, or None if it isn't an HTML page.

    Redirects are followed MANUALLY (allow_redirects=False) so every hop is
    re-validated by _assert_public_url — a public URL cannot 302 into an
    internal target.
    """
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        _assert_public_url(current)
        resp = requests.get(current, headers={"User-Agent": USER_AGENT},
                            timeout=TIMEOUT, allow_redirects=False)
        if resp.is_redirect or resp.is_permanent_redirect:
            location = resp.headers.get("Location")
            if not location:
                break
            current = urljoin(current, location)
            continue
        resp.raise_for_status()
        ctype = resp.headers.get("Content-Type", "").lower()
        if "html" not in ctype and "<html" not in resp.text[:2000].lower():
            return None
        return resp.text
    raise requests.exceptions.TooManyRedirects(
        f"exceeded {MAX_REDIRECTS} redirects from {url}")


def _fetch_homepage(url: str) -> Tuple[str | None, str, str | None]:
    """Fetch the homepage and classify reachability.

    Returns (html, site_status, error). site_status:
      ok          — fetched (html may still be None for non-HTML content)
      dead        — domain/page does not exist: DNS or SSL failure,
                    connection refused, HTTP 404/410
      unreachable — exists but couldn't be read now: timeout or 5xx
                    (after one retry), or bot-blocked (401/403/429)
    """
    last_exc: Exception | None = None
    for attempt in (1, 2):
        try:
            return _fetch(url), "ok", None
        except requests.exceptions.SSLError as exc:
            return None, "dead", f"ssl error: {exc}"
        except requests.exceptions.ConnectionError as exc:
            text = str(exc).lower()
            if any(s in text for s in ("nameresolution", "getaddrinfo",
                                       "name or service not known",
                                       "nodename nor servname")):
                return None, "dead", f"dns failure: {exc}"
            return None, "dead", f"connection failed: {exc}"
        except requests.exceptions.Timeout as exc:
            last_exc = exc          # retry once
        except requests.exceptions.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else 0
            if status in (404, 410):
                return None, "dead", f"homepage returned {status}"
            if status in (401, 403, 429):
                return None, "unreachable", f"blocked with {status} (likely bot protection)"
            if status >= 500:
                last_exc = exc      # retry once
            else:
                return None, "unreachable", f"homepage returned {status}"
        except Exception as exc:    # anything else: don't kill the batch
            return None, "unreachable", f"could not fetch homepage: {exc}"
    return None, "unreachable", f"failed after retry: {last_exc}"


def _page_text(html: str) -> str:
    """Visible text plus signal-bearing text that survives JS-rendered sites:
    meta descriptions, OpenGraph tags, <title>, and JSON-LD structured data."""
    doc = lxml.html.fromstring(html)
    extras: List[str] = []
    for xp in ("//meta[@name='description']/@content",
               "//meta[@property='og:description']/@content",
               "//meta[@property='og:title']/@content",
               "//meta[@name='keywords']/@content",
               "//title/text()"):
        extras += doc.xpath(xp)
    for blob in doc.xpath("//script[@type='application/ld+json']/text()"):
        extras.append(re.sub(r'[{}\[\]"\\]', " ", blob))
    for bad in doc.xpath("//script | //style | //noscript"):
        bad.getparent().remove(bad)
    return _collapse(" ".join(extras) + " " + doc.text_content())


def _candidate_links(html: str, base_url: str) -> List[str]:
    """Same-domain links that look like About / Products / Brands / etc."""
    doc = lxml.html.fromstring(html)
    base_host = urlparse(base_url).netloc.lower()
    found: List[str] = []
    for anchor in doc.xpath("//a[@href]"):
        full = urljoin(base_url, anchor.get("href")).split("#")[0]
        parsed = urlparse(full)
        if parsed.scheme not in ("http", "https"):
            continue
        if parsed.netloc.lower() != base_host:
            continue
        haystack = (parsed.path + " " + _collapse(anchor.text_content())).lower()
        if any(hint in haystack for hint in PAGE_HINTS) and full not in found:
            found.append(full)
    return found


def _evidence(text: str, patterns: List[str], width: int = 70) -> List[str]:
    """Context snippets around the first hit of each pattern."""
    low = text.lower()
    hits: List[str] = []
    for pat in patterns:
        idx = low.find(pat)
        if idx != -1:
            start, end = max(0, idx - width), min(len(text), idx + len(pat) + width)
            hits.append(_collapse(text[start:end]))
    return hits


def _families_in(text: str) -> List[str]:
    low = text.lower()
    return sorted(
        fam for fam, words in KEYWORD_FAMILIES.items()
        if any(re.search(r"\b" + re.escape(w) + r"\b", low) for w in words)
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def analyze_text(text: str) -> Dict[str, object]:
    """Classify warehouse + private-label signals from text.

    Pure function — no network — so it is unit-testable and can be run on the
    Explorium business description as well as on scraped page text.
    """
    wh_pos = _evidence(text, WAREHOUSE_POSITIVE)
    wh_neg = _evidence(text, WAREHOUSE_NEGATIVE)
    if wh_neg:
        warehouse = "no"
    elif wh_pos:
        warehouse = "yes"
    else:
        warehouse = "unknown"  # absence of mention != confirmed no warehouse

    pl_pos = _evidence(text, PRIVATE_LABEL_POSITIVE)
    third_party = _evidence(text, THIRD_PARTY_SIGNALS)
    if third_party:
        # Any third-party reselling signal means the company does NOT sell
        # exclusively its own private label — even if it also has own brands.
        # The client's rule is exclusivity, so this is decisive.
        private_label_only = "no"
    elif pl_pos:
        private_label_only = "yes"
    else:
        private_label_only = "unknown"  # no signal either way -> human check

    return {
        "warehouse": warehouse,
        "warehouse_evidence": wh_pos + wh_neg,
        "private_label_only": private_label_only,
        "private_label_evidence": pl_pos,
        "third_party_evidence": third_party,
        "keyword_families_matched": _families_in(text),
    }


def merge_research(*results: Dict[str, object]) -> Dict[str, object]:
    """Conservatively merge several analyze_text/research_website dicts.

    'no' beats 'yes' beats 'unknown' for both gates — i.e. any disqualifying
    signal (no warehouse / sells third-party brands) wins.
    """
    parts = [r for r in results if r]
    merged: Dict[str, object] = {
        "warehouse": "unknown", "private_label_only": "unknown",
        "keyword_families_matched": [], "warehouse_evidence": [],
        "private_label_evidence": [], "third_party_evidence": [],
        "pages_fetched": [],
    }
    for gate in ("warehouse", "private_label_only"):
        states = [r.get(gate) for r in parts]
        merged[gate] = ("no" if "no" in states
                        else "yes" if "yes" in states else "unknown")
    families: set = set()
    for r in parts:
        families.update(r.get("keyword_families_matched") or [])
        for key in ("warehouse_evidence", "private_label_evidence",
                    "third_party_evidence", "pages_fetched"):
            merged[key] = list(merged[key]) + list(r.get(key) or [])
    merged["keyword_families_matched"] = sorted(families)
    return merged


def research_website(url: str, max_pages: int = MAX_PAGES) -> Dict[str, object]:
    """Fetch a company site, classify reachability, resolve the regex gates,
    and return the fetched page text for the LLM evidence extractor."""
    result: Dict[str, object] = {
        "url": url, "ok": False, "site_status": "dead", "error": None,
        "pages_fetched": [], "pages": [],
        "warehouse": "unknown", "warehouse_evidence": [],
        "private_label_only": "unknown", "private_label_evidence": [],
        "third_party_evidence": [], "keyword_families_matched": [],
    }
    if not url:
        result["error"] = "no url provided"
        return result
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
        result["url"] = url

    home, status, error = _fetch_homepage(url)
    result["site_status"] = status
    result["error"] = error
    if home is None:
        if status == "ok":   # reachable but not an HTML page
            result["site_status"] = "unreachable"
            result["error"] = "homepage is not an HTML page"
        return result

    pages: List[Dict[str, str]] = [
        {"url": url, "text": _page_text(home)[:PAGE_TEXT_CAP]}]
    base = url if url.endswith("/") else url + "/"
    candidates = _candidate_links(home, url) + [base + p for p in COMMON_PATHS]
    seen = {url}
    attempts = 0
    for link in candidates:
        if len(pages) >= max_pages or attempts >= MAX_ATTEMPTS:
            break
        if link in seen:
            continue
        seen.add(link)
        attempts += 1
        try:
            html = _fetch(link)
        except Exception:
            continue
        if html:
            pages.append({"url": link, "text": _page_text(html)[:PAGE_TEXT_CAP]})

    result.update(analyze_text("\n".join(p["text"] for p in pages)))
    result["ok"] = True
    result["pages_fetched"] = [p["url"] for p in pages]
    result["pages"] = pages
    return result


# ---------------------------------------------------------------------------
# Batch mode
# ---------------------------------------------------------------------------

def research_record(record: Dict[str, object]) -> Dict[str, object]:
    """Research one pipeline record IN PLACE: fetch its website, fold in the
    Explorium description as an extra evidence source, attach the result as
    ``record['website_research']``. This is THE supported way to run research
    over records — it owns the merge_research call signature."""
    site = research_website(str(record.get("website") or ""))
    desc = record.get("description")
    desc_signals = analyze_text(desc) if isinstance(desc, str) and desc else None
    merged = merge_research(site, desc_signals) if desc_signals else dict(site)
    # merge_research only merges gate fields — keep the fetch metadata.
    for key in ("url", "ok", "site_status", "error", "pages_fetched", "pages"):
        merged[key] = site.get(key)
    record["website_research"] = merged
    return record


def research_records(records: List[Dict[str, object]],
                     workers: int = 12) -> Dict[str, int]:
    """Research all records in place; return a status summary."""
    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(research_record, records))
    summary = {"total": len(records), "ok": 0, "dead": 0, "unreachable": 0}
    for r in records:
        status = (r.get("website_research") or {}).get("site_status", "unreachable")
        summary[status if status in summary else "unreachable"] += 1
    return summary


# ---------------------------------------------------------------------------
# Demo / offline self-test
# ---------------------------------------------------------------------------

_DEMO_THIRD_PARTY = (
    "About us. We distribute and retail the finest selection of Korean beauty "
    "brands. The brands we carry include several leading household names. All "
    "products are imported and held in our 8,000 m² warehouse before "
    "distribution to wholesale customers."
)
_DEMO_PRIVATE_LABEL = (
    "Founded in 1985, we manufacture our own private label cleaning products "
    "for foodservice clients. As a manufacturer we control production end to "
    "end; our own brand is sold to distributors across Europe."
)


def _main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url", nargs="?", help="single URL to research")
    parser.add_argument("--records", help="JSON list of pipeline records "
                        "(each with 'website' and optional 'description')")
    parser.add_argument("--out", help="output path for the researched records")
    parser.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()

    if args.records:
        if not args.out:
            parser.error("--records requires --out")
        records = json.loads(Path(args.records).read_text())
        summary = research_records(records, workers=args.workers)
        Path(args.out).write_text(
            json.dumps(records, indent=2, ensure_ascii=False))
        failed = summary["dead"] + summary["unreachable"]
        print(f"researched {summary['total']}: ok {summary['ok']}, "
              f"dead {summary['dead']}, unreachable {summary['unreachable']} "
              f"-> {args.out}")
        if summary["total"] and failed / summary["total"] > BATCH_FAIL_THRESHOLD:
            print(f"FAIL: {failed}/{summary['total']} sites unresolved "
                  f"(> {BATCH_FAIL_THRESHOLD:.0%}) — check network before "
                  "trusting this run.", file=sys.stderr)
            return 1
        return 0

    if args.url:
        result = research_website(args.url)
        result.pop("pages", None)  # too noisy for terminal use
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0

    print("Offline demo — analyze_text() on two canned pages:\n")
    for label, text in (("THIRD-PARTY DISTRIBUTOR", _DEMO_THIRD_PARTY),
                        ("PRIVATE-LABEL MANUFACTURER", _DEMO_PRIVATE_LABEL)):
        print("=" * 66)
        print(label)
        print(json.dumps(analyze_text(text), indent=2, ensure_ascii=False))
    print("=" * 66)
    print("\nSingle URL:  python tools/research_company_website.py https://example.com"
          "\nBatch mode:  python tools/research_company_website.py "
          "--records .tmp/records.json --out .tmp/records_with_research.json")
    return 0


if __name__ == "__main__":
    sys.exit(_main())
