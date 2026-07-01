"""GitHub Actions worker entrypoint for the Capricorn lead-discovery pipeline.

This is the HEADLESS orchestrator. There is no MCP in CI, so it talks to
Explorium through ``tools/explorium_api.ExploriumClient`` and chains the
existing deterministic tools (research, evidence, scoring, judge, eval, sheet
build) exactly the way ``workflows/find_capricorn_leads.md`` describes.

Driven by::

    python tools/run_pipeline.py --run-id <uuid> --country "<name>" --target <int>

Intermediate JSON for one run lives under ``.tmp/runs/<run_id or 'manual'>/`` so
concurrent runs never collide. Progress + the final outcome are reported to the
``pipeline_runs`` Supabase table (by ``id``) when ``--run-id`` is given and
Supabase credentials are present; reporting failures never crash the run.

Delivery is twofold: the Google Sheet (for QA / sharing) AND a sync of the
qualified leads into the companies/contacts CRM tables, so discovered leads show
up in the webapp immediately and the client can act on them without the operator.
The CRM sync is NON-BLOCKING — a sync failure never fails an otherwise-good run
(the sheet is already delivered); it just records crm_synced=False on the run row.

NOTE: every Explorium fetch/enrich call and every Anthropic call here spends
real credits/USD. Budgets are scaled to --target and capped per env var.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"
sys.path.insert(0, str(TOOLS))

from explorium_api import ExploriumClient, ExploriumError, country_to_code  # noqa: E402


# ---------------------------------------------------------------------------
# Discovery configuration (mirrors workflows/find_capricorn_leads.md)
# ---------------------------------------------------------------------------

# Per-vertical website_keywords, OR'd together in one discovery call. Importer /
# distributor / wholesale language is preferred over generic category names —
# the gates and BDR judge penalise pure DTC producers.
VERTICAL_KEYWORDS: List[str] = [
    # Foodservice disposables
    "foodservice disposables", "disposable tableware", "disposable cutlery",
    "paper cups", "takeaway packaging", "catering disposables",
    "disposable packaging importer", "disposable packaging distributor",
    # Pet food
    "pet food importer", "pet food distributor", "dog food", "cat food",
    "pet treats", "pet care products distributor",
    # Cosmetics
    "cosmetics importer", "cosmetics distributor", "personal care distributor",
    "private label cosmetics", "beauty products importer", "skincare wholesale",
    # Wipes
    "wet wipes", "baby wipes", "nonwoven wipes", "wipes importer",
    "wipes distributor",
    # Membranes & geotextiles
    "geotextile", "geomembrane", "geosynthetics", "waterproofing membrane",
    "breathable membrane", "roofing underlay", "rock wool insulation",
    "glass wool insulation",
    # Agriculture (physical inputs only — never generic "agriculture")
    "agrotextiles", "agricultural plastics", "agricultural film", "mulch film",
    "anti-hail nets", "shade nets", "olive nets", "drip irrigation tape",
    "greenhouse supplies", "grow bags", "layflat hose",
    # Cleaning supplies
    "cleaning products", "detergents", "cleaning supplies", "janitorial products",
    "cleaning supplies distributor", "janitorial products distributor",
]

# Israel is an importer-intent special case: skip the generic per-vertical sets
# and search importer-intent terms combined with product categories. The
# Israeli agri-manufacturing scene is a poor hunting ground; the target is the
# smaller segment of IMPORTERS bringing physical goods into Israel from Asia.
ISRAEL_KEYWORDS: List[str] = [
    "importer", "official importer", "import and distribution",
    "יבואן",          # importer
    "יבוא",                # import
    "יבוא ושיווק",  # import & marketing
    "agricultural plastics", "irrigation accessories", "agricultural film",
    "greenhouse equipment supplier", "irrigation supplies",
]

# company_size buckets covering the ICP 10-1,000 range; 1-10 and 1001+ are hard
# gate territory and excluded from discovery.
COMPANY_SIZE_BUCKETS = ["11-50", "51-200", "201-500", "501-1000"]

# Title/seniority filters favouring the buyer personas pick_prospects ranks
# highest: procurement/sourcing/buyer/purchasing + MD/CEO/commercial.
PROSPECT_JOB_LEVELS = ["director", "manager", "owner", "cxo", "vp", "partner"]
PROSPECT_JOB_DEPARTMENTS = [
    "operations", "general_management", "sales", "finance",
    "engineering", "marketing",
]

# Funnel ratios (SOP: discover ~target x4-6, gates+scoring drop most). Capped to
# keep credit spend bounded on a single run.
ENRICH_MULTIPLIER = 4
MAX_ENRICH = 250

# Loop-to-target: keep pulling NEW companies through the funnel in batches until
# the requested number of leads is delivered, the discoverable pool is exhausted,
# or this many companies have been enriched (the per-run cost ceiling).
# COST NOTE: BOTH discovery (/businesses) and the prospect search (/prospects)
# are billed PER RECORD returned — they are NOT free (assuming they were, and
# fetching 600 companies up front to use ~15, was the #1 cost driver). So we
# (a) fetch businesses one page at a time, only when a round needs more, and stop
# the instant the target is met, and (b) fetch only a few prospect candidates per
# delivered company. Enrichment is the per-company cost; we cap the run on
# companies enriched. Override with the DISCOVER_ENRICH_CAP env var.
DELIVER_ENRICH_CAP = 120
MIN_BATCH = 15

# Prospect search is billed per record; pick_prospects keeps <=2 contacts per
# company, so a few candidates each is plenty. size = companies * PER_COMPANY,
# capped by PROSPECT_FETCH_CAP.
PROSPECT_PER_COMPANY = 6
PROSPECT_FETCH_CAP = 200

# HARD per-run safety ceilings (belt-and-suspenders over the lazy funnel) so a
# single run — or a client clicking Run with a big target — can never blow the
# credit budget again. Both overridable by env (MAX_DISCOVER_FETCH /
# RUN_MAX_TARGET).
MAX_DISCOVER_FETCH = 200   # max business records discovery may fetch per run
RUN_MAX_TARGET = 25        # clamp the requested target before any spend
MIN_DISCOVER_PAGE = 10     # smallest page to fall back to when Explorium says
                           # we've paged past a query's actual matching set


# ---------------------------------------------------------------------------
# Run-status reporting (Supabase pipeline_runs)
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _slug(s: str) -> str:
    """lowercase, non-alphanumeric -> '-', collapse + trim dashes.

    MUST stay in sync with slug() in
    webapp/app/api/discovery/run/route.ts, so the batch_label computed here
    matches the one the webapp already wrote to the pipeline_runs row (and the
    one the Discover success CTA links to: /companies?batch=<batch_label>)."""
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


class RunReporter:
    """Patches the pipeline_runs row by id. No-op when run_id is empty or
    Supabase creds are missing; never raises (reporting must not crash a run)."""

    def __init__(self, run_id: str):
        self.run_id = (run_id or "").strip()
        self.client = None
        if not self.run_id:
            return
        try:
            from supabase import create_client  # type: ignore
            url = (os.getenv("NEXT_PUBLIC_SUPABASE_URL")
                   or os.getenv("SUPABASE_URL"))
            key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
            if url and key:
                self.client = create_client(url, key)
            else:
                print("[reporter] Supabase creds missing — status reporting "
                      "disabled for this run.")
        except Exception as exc:  # noqa: BLE001
            print(f"[reporter] could not init Supabase client: {exc}")
            self.client = None

    def update(self, **fields: Any) -> None:
        if not self.client or not self.run_id:
            return
        try:
            self.client.table("pipeline_runs").update(fields).eq(
                "id", self.run_id).execute()
        except Exception as exc:  # noqa: BLE001 — never crash the run
            print(f"[reporter] update failed (ignored): {exc}")


# ---------------------------------------------------------------------------
# Subprocess + scoring helpers
# ---------------------------------------------------------------------------

def _run(cmd: List[str], stage: str, *, allow_nonzero: bool = False,
         env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess:
    """Run a tool subprocess, streaming nothing back but raising a readable
    error tagged with the pipeline stage on non-zero exit (unless allowed)."""
    print(f"\n=== [{stage}] {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=str(ROOT), env=env, text=True,
                          capture_output=True)
    if proc.stdout:
        print(proc.stdout)
    if proc.stderr:
        print(proc.stderr, file=sys.stderr)
    if proc.returncode != 0 and not allow_nonzero:
        raise RuntimeError(
            f"stage '{stage}' failed (exit {proc.returncode}): "
            f"{(proc.stderr or proc.stdout or '').strip()[:500]}")
    return proc


# Inline scorer: imports score_company AFTER the env is set, so the module-level
# EXTRA_TARGET_COUNTRIES override is honoured. Reads a records JSON, attaches the
# score dict to each record as `score`, writes the result.
_SCORE_SCRIPT = """
import json, sys
sys.path.insert(0, %r)
from score_company import score_company
records = json.loads(open(sys.argv[1], encoding='utf-8').read())
for rec in records:
    rec['score'] = score_company(rec)
open(sys.argv[2], 'w', encoding='utf-8').write(
    json.dumps(records, indent=2, ensure_ascii=False))
n = sum(1 for r in records if (r.get('score') or {}).get('qualified'))
print('scored %%d records, %%d qualified' %% (len(records), n))
""" % str(TOOLS)


def _run_score(in_path: Path, out_path: Path, env: Dict[str, str],
               stage: str) -> None:
    _run([sys.executable, "-c", _SCORE_SCRIPT, str(in_path), str(out_path)],
         stage, env=env)


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _dump(path: Path, data: Any) -> None:
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False))


# ---------------------------------------------------------------------------
# Persistent "already tried" store (Supabase seen_companies). Every company we
# enrich + judge — qualified OR rejected — is recorded here keyed by Explorium
# business_id, so future runs skip it and never re-spend credits on it. Replaces
# the ephemeral local .tmp/seen_companies.json (which doesn't survive CI runs).
# ---------------------------------------------------------------------------

def _supabase():
    """Service-role client, or None when creds are missing (manual runs)."""
    try:
        from supabase import create_client  # type: ignore
        url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
        key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
        if url and key:
            return create_client(url, key)
        print("[seen] Supabase creds missing — cross-run dedup disabled.")
    except Exception as exc:  # noqa: BLE001
        print(f"[seen] could not init Supabase client: {exc}")
    return None


def _load_seen(country_code: str) -> set:
    """business_ids already enriched+judged for this country in prior runs."""
    sb = _supabase()
    if not sb:
        return set()
    seen: set = set()
    try:
        offset = 0
        while True:
            res = (sb.table("seen_companies").select("business_id")
                   .eq("country", country_code)
                   .range(offset, offset + 999).execute())
            page = res.data or []
            for row in page:
                if row.get("business_id"):
                    seen.add(row["business_id"])
            if len(page) < 1000:
                break
            offset += 1000
    except Exception as exc:  # noqa: BLE001 — never fail a run over dedup
        print(f"[seen] load failed (continuing with empty set): {exc}")
    return seen


def _record_seen(tried: List[Dict[str, Any]], country_code: str,
                 run_id: str) -> None:
    """Upsert every enriched+judged company so future runs skip it."""
    sb = _supabase()
    if not sb or not tried:
        return
    rows = [{"business_id": t["business_id"], "country": country_code,
             "company_name": t.get("company_name"), "verdict": t.get("verdict"),
             "run_id": (run_id or None)}
            for t in tried if t.get("business_id")]
    if not rows:
        return
    try:
        sb.table("seen_companies").upsert(rows, on_conflict="business_id").execute()
        print(f"[seen] recorded {len(rows)} companies as tried")
    except Exception as exc:  # noqa: BLE001
        print(f"[seen] record failed (ignored): {exc}")


def _client_drive():
    """The client's connected Google Drive (from the integrations table), or
    (None, None, None) when none is connected — then the export falls back to the
    operator's env credentials. Returns (oauth, master_sheet_id, integration_id),
    where oauth is the {refresh_token, client_id, client_secret} dict that
    export_leads_to_sheets accepts (client_id/secret = the webapp's Google OAuth
    client that authorized the token)."""
    sb = _supabase()
    cid = os.getenv("GOOGLE_CLIENT_ID")
    csec = os.getenv("GOOGLE_CLIENT_SECRET")
    if not sb or not cid or not csec:
        return None, None, None
    try:
        res = (sb.table("integrations")
               .select("id, refresh_token, master_sheet_id")
               .eq("provider", "google_drive")
               .order("created_at", desc=True)
               .limit(1).execute())
        row = (res.data or [None])[0]
        if not row or not row.get("refresh_token"):
            return None, None, None
        oauth = {"refresh_token": row["refresh_token"],
                 "client_id": cid, "client_secret": csec}
        return oauth, row.get("master_sheet_id"), row.get("id")
    except Exception as exc:  # noqa: BLE001 — fall back to operator Drive
        print(f"[drive] client-Drive lookup failed (using operator Drive): {exc}")
        return None, None, None


def _load_products():
    """The client's editable product catalog (discovery_products). Returns
    (keywords, names): a flat deduped discovery-keyword list and the product
    names. Returns (None, None) when unavailable, so callers fall back to the
    hardcoded VERTICAL_KEYWORDS / CAPRICORN_CATALOG (no behaviour change)."""
    sb = _supabase()
    if not sb:
        return None, None
    try:
        res = (sb.table("discovery_products").select("name, keywords")
               .eq("active", True).order("sort").execute())
        rows = res.data or []
        if not rows:
            return None, None
        keywords: List[str] = []
        for r in rows:
            for k in (r.get("keywords") or "").split(","):
                k = k.strip()
                if k and k not in keywords:
                    keywords.append(k)
        names = [r["name"] for r in rows if r.get("name")]
        return (keywords or None), names
    except Exception as exc:  # noqa: BLE001 — fall back to the hardcoded lists
        print(f"[products] load failed (using hardcoded catalog/keywords): {exc}")
        return None, None


def _process_batch(companies: List[Dict[str, Any]], *, work: Path,
                   env: Dict[str, str], is_uk: bool, tag: str, client) -> Any:
    """Run ONE batch through enrich -> research -> evidence -> score -> verify ->
    judge -> re-score. Returns (qualified, tried): the post-judge qualified score
    records, and a {business_id, company_name, verdict} dict for every enriched
    company (so the caller can record them all as seen)."""
    bwork = work / tag
    bwork.mkdir(parents=True, exist_ok=True)

    enrich_ids = [r.get("business_id") for r in companies if r.get("business_id")]
    if not enrich_ids:
        return [], []
    enriched = client.enrich_businesses(enrich_ids)
    if not enriched:
        return [], []
    firmo = bwork / "firmographics.json"
    _dump(firmo, {"data": enriched})

    records = json.loads(_run([sys.executable, str(TOOLS / "explorium_to_record.py"),
                               str(firmo)], f"map [{tag}]").stdout)
    rec_path = bwork / "records.json"
    _dump(rec_path, records)

    res_path = bwork / "researched.json"
    _run([sys.executable, str(TOOLS / "research_company_website.py"),
          "--records", str(rec_path), "--out", str(res_path)],
         f"research [{tag}]", allow_nonzero=True)
    if not res_path.exists():
        raise RuntimeError(f"research produced no output for batch {tag}.")

    ev_path = bwork / "evidence.json"
    _run([sys.executable, str(TOOLS / "extract_evidence.py"),
          "--records", str(res_path), "--out", str(ev_path)],
         f"evidence [{tag}]", env=env)

    scored = bwork / "scored.json"
    _run_score(ev_path, scored, env, f"score [{tag}]")
    current = scored
    if is_uk:
        uk = bwork / "records_uk.json"
        _run([sys.executable, str(TOOLS / "uk_importers_lookup.py"),
              "--records", str(scored), "--out", str(uk)],
             f"uk lookup [{tag}]", allow_nonzero=True)
        if uk.exists():
            uk_scored = bwork / "scored_uk.json"
            _run_score(uk, uk_scored, env, f"score-uk [{tag}]")
            current = uk_scored

    verified = bwork / "verified.json"
    _run([sys.executable, str(TOOLS / "verify_import_evidence.py"),
          "--records", str(current), "--out", str(verified)],
         f"verify [{tag}]", env=env)
    scored_v = bwork / "scored_verified.json"
    _run_score(verified, scored_v, env, f"score-verify [{tag}]")

    judged = bwork / "judged.json"
    _run([sys.executable, str(TOOLS / "bdr_judge.py"),
          "--candidates", str(scored_v), "--out", str(judged)],
         f"judge [{tag}]", env=env)
    final = bwork / "scored_final.json"
    _run_score(judged, final, env, f"score-final [{tag}]")

    records_final = _load(final)
    qualified = [r for r in records_final if (r.get("score") or {}).get("qualified")]
    qual_ids = {r.get("explorium_business_id") for r in qualified}
    tried = [{"business_id": bid,
              "company_name": r.get("company_name") or r.get("name"),
              "verdict": "qualified" if bid in qual_ids else "rejected"}
             for r in records_final
             if (bid := r.get("explorium_business_id"))]
    return qualified, tried


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

def run_pipeline(run_id: str, country: str, target: int) -> None:
    reporter = RunReporter(run_id)
    work = ROOT / ".tmp" / "runs" / (run_id.strip() or "manual")
    work.mkdir(parents=True, exist_ok=True)
    gh_run_url = os.getenv("GH_RUN_URL") or ""

    started_at = _now()
    reporter.update(status="running", stage="sizing market",
                    started_at=started_at, gh_run_url=gh_run_url)

    # --- country resolution -------------------------------------------------
    code = country_to_code(country)
    if not code:
        raise RuntimeError(
            f"Country '{country}' not recognized; use the English country name.")
    country_norm = country.strip()
    is_israel = code == "il"
    is_uk = code == "gb"
    # Tag every synced company with this run's batch so the webapp can filter
    # /companies?batch=<batch_label>. Mirrors route.ts's row insert exactly.
    batch_label = "discovery_" + _slug(country_norm)
    # Clamp the target BEFORE any spend so a client can never request a huge
    # (expensive) run from the webapp.
    max_target = int(os.getenv("RUN_MAX_TARGET", str(RUN_MAX_TARGET)))
    if target > max_target:
        print(f"[budget] target {target} clamped to {max_target} (RUN_MAX_TARGET)")
    target = max(1, min(target, max_target))
    print(f"Country '{country_norm}' -> {code}  (target {target} qualified, "
          f"batch_label={batch_label})")

    # Extend the locked target-country gate for this geography only; the locked 8
    # are unaffected. score_company reads this at IMPORT time, so it must be set
    # before any score subprocess runs.
    env = dict(os.environ)
    env["EXTRA_TARGET_COUNTRIES"] = f"{country_norm.lower()}:Medium"
    # Loop-to-target sizing: each discovery round enriches/judges ~batch_size
    # companies, and the evidence/judge subprocesses run once PER round, so these
    # are per-batch budget ceilings (generous enough not to truncate a batch).
    # Total spend across rounds is bounded by the enrich cap below.
    enrich_cap = int(os.getenv("DISCOVER_ENRICH_CAP", str(DELIVER_ENRICH_CAP)))
    batch_size = max(target * ENRICH_MULTIPLIER, MIN_BATCH)
    # Each discovery page ~= one round's need, so we rarely over-fetch (<=100).
    discover_page_size = min(100, max(batch_size, 20))
    env["EVIDENCE_EXTRACT_USD_BUDGET"] = f"{max(1.5, batch_size * 0.06):.2f}"
    env["BDR_JUDGE_USD_BUDGET"] = f"{max(2.5, batch_size * 0.15):.2f}"
    env["WEB_VERIFY_USD_BUDGET"] = f"{max(1.0, batch_size * 0.06):.2f}"

    client = ExploriumClient()
    keywords = ISRAEL_KEYWORDS if is_israel else VERTICAL_KEYWORDS
    # Editable product catalog: the client's products (discovery_products) drive
    # discovery keywords (non-Israel) AND the judge catalog. Falls back to the
    # hardcoded lists when the table is empty/unreachable (no behaviour change).
    product_keywords, product_names = _load_products()
    if product_keywords and not is_israel:
        keywords = product_keywords
        print(f"[products] {len(keywords)} discovery keywords from "
              f"{len(product_names)} editable products")
    if product_names:
        env["CAPRICORN_EXTRA_PRODUCTS"] = ", ".join(product_names)
    base_filters: Dict[str, Any] = {
        "country_code": {"values": [code]},
        "company_size": {"values": COMPANY_SIZE_BUCKETS},
        "website_keywords": {"values": keywords},
    }

    # Running tally of ENRICHED records (companies + prospects). Discovery and
    # raw-prospect fetches are ALSO billed per record by Explorium; those are
    # added back into the reported total (explorium_billed) at the end so the
    # number shown to the client reflects the real bill, not just enrichment.
    explorium_credits = 0

    # --- 1. size the market (free, best-effort) -----------------------------
    discovered_estimate = 0
    try:
        discovered_estimate = client.stats(base_filters)
        print(f"[stats] estimated market size: {discovered_estimate}")
    except Exception as exc:  # noqa: BLE001 — sizing must not fail the run
        print(f"[stats] sizing failed (continuing): {exc}")

    # HARD per-run discovery ceiling (business records fetched). Bounds the worst
    # case so one run can never run away on credits; also never page past the
    # free market-size estimate. Override with MAX_DISCOVER_FETCH.
    discover_fetch_cap = int(os.getenv("MAX_DISCOVER_FETCH", str(MAX_DISCOVER_FETCH)))
    if discovered_estimate:
        discover_fetch_cap = min(discover_fetch_cap, discovered_estimate)
    print(f"[budget] discovery fetch ceiling: {discover_fetch_cap} records")

    # --- 2. discover + enrich + judge LAZILY until the target is met ---------
    # COST: /businesses is billed PER RECORD returned, so we NEVER fetch the
    # whole pool up front (pulling 600 to use ~15 was the #1 cost driver). We pull
    # ONE page only when a round needs more companies, dedup it against prior
    # runs, and stop the instant the target is met. A target-5 run now fetches
    # ~1-2 pages, not 600.
    reporter.update(stage="discovering companies")
    seen_ids = _load_seen(code)

    delivered: List[Dict[str, Any]] = []
    buffer: List[Dict[str, Any]] = []   # new (post-dedup) companies awaiting a round
    discovered_total = 0                 # records actually fetched (~= credits spent)
    skipped_seen = 0
    enriched_total = 0
    round_idx = 0
    page = 1
    exhausted = False

    while len(delivered) < target and enriched_total < enrich_cap:
        # Top up the buffer to one batch, fetching pages on demand (lazy = cheap),
        # but never past the hard discovery ceiling.
        while (len(buffer) < batch_size and not exhausted
               and discovered_total < discover_fetch_cap):
            try:
                data = client.fetch_businesses_page(
                    base_filters, page=page, page_size=discover_page_size)
            except ExploriumError as exc:
                # Explorium's /businesses fetch returns a HARD 422 ("page_size *
                # page_num exceeds the maximum results size") once we page past a
                # query's ACTUAL matching set. The free stats estimate over-counts,
                # so a restrictive keyword+country query can have far fewer real
                # records than estimated (e.g. UK est. 3,325 but only a few dozen
                # fetchable). Never crash the run on this: if we haven't fetched
                # anything yet, shrink to the minimum page and retry this page to
                # grab whatever few exist; otherwise we've reached the end of the
                # pool — stop and deliver what we have.
                if exc.status == 422 and "maximum results size" in str(exc).lower():
                    if discovered_total == 0 and discover_page_size > MIN_DISCOVER_PAGE:
                        print(f"[discover] Explorium result-size limit at page {page}; "
                              f"retrying with page_size={MIN_DISCOVER_PAGE}.")
                        discover_page_size = MIN_DISCOVER_PAGE
                        continue
                    print(f"[discover] Explorium result-size limit reached at page "
                          f"{page} (fetched {discovered_total}); treating as "
                          "exhausted and delivering what we have.")
                    exhausted = True
                    break
                raise
            page += 1
            discovered_total += len(data)
            if len(data) < discover_page_size:
                exhausted = True
            fresh = [c for c in data
                     if c.get("business_id") and c["business_id"] not in seen_ids]
            skipped_seen += len(data) - len(fresh)
            buffer.extend(fresh)
        reporter.update(discovered_count=discovered_total)
        if not buffer:
            break  # pool exhausted; nothing new left to enrich

        take = min(batch_size, enrich_cap - enriched_total, len(buffer))
        batch = buffer[:take]
        buffer = buffer[take:]
        round_idx += 1
        reporter.update(stage=f"enriching + judging (round {round_idx})")
        print(f"\n=== round {round_idx}: {len(batch)} companies "
              f"(delivered {len(delivered)}/{target}, "
              f"enriched {enriched_total}/{enrich_cap}, "
              f"fetched {discovered_total}) ===")
        qualified, tried = _process_batch(
            batch, work=work, env=env, is_uk=is_uk, tag=f"r{round_idx}",
            client=client)
        enriched_total += len(tried)
        explorium_credits += len(tried)
        delivered.extend(qualified)
        _record_seen(tried, code, run_id)
        reporter.update(enriched_count=enriched_total,
                        qualified_count=len(delivered))
        print(f"[round {round_idx}] +{len(qualified)} qualified "
              f"(total {len(delivered)}/{target}); "
              f"enriched {enriched_total}/{enrich_cap}")

    print(f"[discover] fetched {discovered_total} businesses total "
          f"({skipped_seen} skipped as already-tried in prior runs)")
    if enriched_total == 0:
        raise RuntimeError(
            f"no new companies to enrich for {country_norm} ({code}) — discovery "
            "returned nothing, or every company was already tried in prior runs. "
            "Try a different market or broaden the keywords.")

    stop_reason = ("target met" if len(delivered) >= target
                   else "enrich cap reached" if enriched_total >= enrich_cap
                   else "discovery budget cap" if discovered_total >= discover_fetch_cap
                   else "pool exhausted")
    # Best-scored first for delivery order. Keep ALL qualified — overshooting the
    # target with extra real leads is a bonus, not a problem.
    delivered.sort(key=lambda r: (r.get("score") or {}).get("total_score") or 0,
                   reverse=True)
    print(f"\n[loop] {len(delivered)} qualified after {round_idx} round(s), "
          f"{enriched_total} enriched ({stop_reason}).")
    delivered_path = work / "delivered_scored.json"
    _dump(delivered_path, delivered)

    # --- fetch + pick + enrich contacts for the DELIVERED set ---------------
    contacts_by_biz: Dict[str, List[Dict[str, Any]]] = {}
    prospects_fetched = 0  # raw /prospects records returned (billed per record)
    if delivered:
        reporter.update(stage="finding contacts")
        qualified_ids = [r.get("explorium_business_id") for r in delivered
                         if r.get("explorium_business_id")]
        # job_level only — Explorium's job_department enum rejects values like
        # 'operations'; pick_prospects ranks by title regardless.
        # Billed per record; pick_prospects keeps <=2 per company, so fetch only
        # a handful of candidates each (companies * PER_COMPANY, capped).
        prospect_size = min(max(len(qualified_ids) * PROSPECT_PER_COMPANY, 10),
                            PROSPECT_FETCH_CAP)
        try:
            prospects = client.fetch_prospects(
                qualified_ids, job_levels=PROSPECT_JOB_LEVELS, size=prospect_size)
        except ExploriumError as exc:
            print(f"[prospects] filtered fetch rejected ({exc}); retrying unfiltered")
            prospects = client.fetch_prospects(qualified_ids, size=prospect_size)
        if not prospects:  # European SMEs rarely tag seniority — retry unfiltered
            prospects = client.fetch_prospects(qualified_ids, size=prospect_size)
        prospects_raw_path = work / "prospects_raw.json"
        _dump(prospects_raw_path, prospects)
        prospects_fetched = len(prospects)
        print(f"[prospects] fetched {prospects_fetched} prospect records")

        picked_path = work / "picked.json"
        if prospects:
            _run([sys.executable, str(TOOLS / "pick_prospects.py"),
                  "--prospects", str(prospects_raw_path),
                  "--companies", str(delivered_path),
                  "--out", str(picked_path)], "picking prospects")
            picked = _load(picked_path)
        else:
            picked = []
        print(f"[pick] {len(picked)} picked prospects")

        if picked:
            reporter.update(stage="enriching contacts")
            pids = [p.get("prospect_id") for p in picked if p.get("prospect_id")]
            contact_info = client.enrich_prospect_contacts(pids) if pids else {}
            profiles = client.enrich_prospect_profiles(pids) if pids else {}
            explorium_credits += len(contact_info) + len(profiles)
            for p in picked:
                pid = p.get("prospect_id")
                bid = p.get("business_id")
                if not bid:
                    continue
                ci = contact_info.get(pid, {})
                pr = profiles.get(pid, {})
                contacts_by_biz.setdefault(str(bid), []).append({
                    "business_id": bid,
                    "full_name": pr.get("full_name") or p.get("full_name") or "",
                    "job_title": pr.get("job_title") or p.get("job_title") or "",
                    "linkedin_url": pr.get("linkedin_url") or "",
                    "email": ci.get("email") or "",
                    "phone": ci.get("phone") or "",
                })
    contacts_path = work / "contacts.json"
    _dump(contacts_path, contacts_by_biz)
    print(f"[contacts] merged contacts for {len(contacts_by_biz)} companies")

    # --- pre-ship structural audit (hard gate) ------------------------------
    reporter.update(stage="auditing")
    proc = _run([sys.executable, str(TOOLS / "eval_against_labels.py"),
                 "--preship", str(delivered_path)],
                "pre-ship audit", allow_nonzero=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "pre-ship audit FAILED — refusing to ship this batch. "
            f"Audit output:\n{(proc.stdout or '').strip()[-1500:]}")
    print("[preship] audit PASSED")

    # --- build the final lead rows ------------------------------------------
    reporter.update(stage="building sheet")
    out_base = work / "leads"
    _run([sys.executable, str(TOOLS / "build_lead_rows.py"),
          "--companies", str(delivered_path),
          "--contacts", str(contacts_path),
          "--out", str(out_base)], "building lead rows")
    leads_json = out_base.with_suffix(".json")
    rows = _load(leads_json)
    leads_delivered = len(rows)
    qualified_count = len({(r.get("company_name"), r.get("country"))
                           for r in rows})
    print(f"[build] {leads_delivered} lead rows across {qualified_count} "
          "companies")

    # --- 17. export to Google Sheet (delivery) ------------------------------
    # Into the CLIENT's own Drive if they connected one in the app (self-serve),
    # else the operator's Drive (env GOOGLE_OAUTH_* + MASTER_SHEET_ID). Generic
    # name "Capricorn Leads" so the client always recognises the deliverable;
    # only used when CREATING a new sheet (runs append to the master afterwards).
    from export_to_sheets import export_leads_to_sheets  # noqa: E402
    delivery_emails = [e.strip() for e in
                       (os.getenv("DELIVERY_SHEET_EMAILS") or "").split(",")
                       if e.strip()]
    title = "Capricorn Leads"
    client_oauth, client_master, drive_integration_id = _client_drive()
    if client_oauth:
        sheet = export_leads_to_sheets(rows, title, delivery_emails or None,
                                       spreadsheet_id=client_master,
                                       oauth=client_oauth)
        # Remember the client's master sheet so the next run appends to it.
        if not client_master and sheet.get("sheet_id") and drive_integration_id:
            try:
                _supabase().table("integrations").update(
                    {"master_sheet_id": sheet["sheet_id"]}
                ).eq("id", drive_integration_id).execute()
            except Exception as exc:  # noqa: BLE001
                print(f"[drive] could not save master sheet id: {exc}")
        print(f"[sheet] (client Drive) {sheet.get('sheet_url')}")
    else:
        sheet = export_leads_to_sheets(rows, title, delivery_emails or None,
                                       spreadsheet_id=os.getenv("MASTER_SHEET_ID"))
        print(f"[sheet] {sheet.get('sheet_url')}")

    # --- 17.5 add the qualified leads to the CRM (companies/contacts) --------
    # Non-blocking by design: a sync failure must never fail an otherwise-good
    # run (the sheet is already delivered). We record the outcome on the run row
    # so the UI can show "couldn't add to CRM — retry" instead of a false green.
    # sync() reuses the leads JSON already written to disk at step 16; it upserts
    # firmographics only and never touches client-controlled status/notes.
    reporter.update(stage="adding to CRM")
    try:
        from sync_leads_to_supabase import sync as sync_to_crm  # noqa: E402
        sync_to_crm(leads_json, None, batch_label, False)
        reporter.update(crm_synced=True)
        print(f"[crm] synced {leads_delivered} leads under "
              f"batch_label={batch_label}")
    except Exception as exc:  # noqa: BLE001 — sheet still delivered
        traceback.print_exc()
        reporter.update(crm_synced=False)
        print(f"[crm] sync failed (sheet still delivered): {exc}")

    # rough Anthropic spend estimate (per-batch caps x rounds = worst case)
    anthropic_usd = round((
        float(env["EVIDENCE_EXTRACT_USD_BUDGET"])
        + float(env["BDR_JUDGE_USD_BUDGET"])
        + float(env["WEB_VERIFY_USD_BUDGET"])
    ) * max(1, round_idx), 2)

    # True per-record Explorium bill = every record FETCHED (discovery +
    # raw prospects) PLUS every record ENRICHED (companies + prospect
    # contacts/profiles). The old number counted only enrichment and so
    # materially understated the bill the client pays.
    explorium_billed = discovered_total + prospects_fetched + explorium_credits
    reporter.update(
        status="succeeded",
        stage="done",
        sheet_url=sheet.get("sheet_url"),
        sheet_id=sheet.get("sheet_id"),
        leads_delivered=leads_delivered,
        qualified_count=qualified_count,
        discovered_count=discovered_total,
        enriched_count=enriched_total,
        explorium_credits=explorium_billed,
        anthropic_usd=anthropic_usd,
        finished_at=_now(),
    )
    print(f"\nDONE — {leads_delivered} leads, {qualified_count} companies, "
          f"~{explorium_billed} Explorium records billed "
          f"(discovered {discovered_total}, enriched {enriched_total}, "
          f"prospects fetched {prospects_fetched}). Sheet: "
          f"{sheet.get('sheet_url')}")


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> int:
    # Local runs: load env from webapp/.env.local then root .env. In CI the real
    # env vars are already set and load_dotenv will not override them.
    load_dotenv(ROOT / "webapp" / ".env.local")
    load_dotenv(ROOT / ".env")

    parser = argparse.ArgumentParser(
        description="Headless Capricorn lead-discovery pipeline (CI worker).")
    parser.add_argument("--run-id", default="",
                        help="pipeline_runs row id (may be empty for manual runs)")
    parser.add_argument("--country", required=True,
                        help="English country name (e.g. 'Spain')")
    parser.add_argument("--target", type=int, default=25,
                        help="target number of qualified companies")
    args = parser.parse_args()

    reporter = RunReporter(args.run_id)
    try:
        run_pipeline(args.run_id, args.country, args.target)
        return 0
    except Exception as exc:  # noqa: BLE001 — convert any failure to a failed run
        traceback.print_exc()
        reporter.update(status="failed", error=str(exc)[:500],
                        finished_at=_now())
        return 1


if __name__ == "__main__":
    sys.exit(main())
