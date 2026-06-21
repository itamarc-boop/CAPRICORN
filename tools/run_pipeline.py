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

Delivery is the Google Sheet ONLY. By product decision this worker does NOT sync
into the companies/contacts CRM tables (that is the webapp's job) — it just
reports the run row and ships the sheet.

NOTE: every Explorium fetch/enrich call and every Anthropic call here spends
real credits/USD. Budgets are scaled to --target and capped per env var.
"""
from __future__ import annotations

import argparse
import json
import os
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

from explorium_api import ExploriumClient, country_to_code  # noqa: E402


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
DISCOVER_MULTIPLIER = 6
ENRICH_MULTIPLIER = 4
MAX_DISCOVER = 600
MAX_ENRICH = 250


# ---------------------------------------------------------------------------
# Run-status reporting (Supabase pipeline_runs)
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
    print(f"Country '{country_norm}' -> {code}  (target {target} qualified)")

    # Extend the locked target-country gate for this geography only; the locked 8
    # are unaffected. score_company reads this at IMPORT time, so it must be set
    # before any score subprocess runs.
    env = dict(os.environ)
    env["EXTRA_TARGET_COUNTRIES"] = f"{country_norm.lower()}:Medium"
    # Budget caps scaled to target.
    env["EVIDENCE_EXTRACT_USD_BUDGET"] = f"{max(1.5, target * 0.08):.2f}"
    env["BDR_JUDGE_USD_BUDGET"] = f"{max(2.0, target * 0.12):.2f}"
    env["WEB_VERIFY_USD_BUDGET"] = f"{max(1.0, target * 0.06):.2f}"

    client = ExploriumClient()
    keywords = ISRAEL_KEYWORDS if is_israel else VERTICAL_KEYWORDS
    base_filters: Dict[str, Any] = {
        "country_code": {"values": [code]},
        "company_size": {"values": COMPANY_SIZE_BUCKETS},
        "website_keywords": {"values": keywords},
    }

    explorium_credits = 0  # rough: enriched companies + enriched prospects

    # --- 1. size the market (free, best-effort) -----------------------------
    discovered_estimate = 0
    try:
        discovered_estimate = client.stats(base_filters)
        print(f"[stats] estimated market size: {discovered_estimate}")
    except Exception as exc:  # noqa: BLE001 — sizing must not fail the run
        print(f"[stats] sizing failed (continuing): {exc}")

    # --- 2. discover --------------------------------------------------------
    reporter.update(stage="discovering companies")
    discover_size = min(MAX_DISCOVER, max(target * DISCOVER_MULTIPLIER, target))
    discovered = client.fetch_businesses(base_filters, size=discover_size,
                                         page_size=100)
    print(f"[discover] fetched {len(discovered)} businesses "
          f"(requested {discover_size})")
    discovered_path = work / "discovered.json"
    _dump(discovered_path, discovered)
    reporter.update(discovered_count=len(discovered))
    if not discovered:
        raise RuntimeError(
            f"discovery returned 0 businesses for {country_norm} ({code}) — "
            "check keywords/filters/credits before retrying.")

    # --- 3. dedup against prior runs (filter mode) --------------------------
    dedup_path = work / "to_enrich.json"
    proc = _run([sys.executable, str(TOOLS / "dedup_companies.py"),
                 str(discovered_path)], "dedup")
    deduped = json.loads(proc.stdout) if proc.stdout.strip() else []
    _dump(dedup_path, deduped)
    print(f"[dedup] {len(deduped)} survive after removing already-seen")
    if not deduped:
        raise RuntimeError("all discovered companies were already delivered "
                           "in prior runs (seen_companies.json) — nothing new.")

    # --- 4. enrich firmographics (credit spend) -----------------------------
    reporter.update(stage="enriching companies")
    enrich_cap = min(MAX_ENRICH, max(target * ENRICH_MULTIPLIER, target))
    to_enrich = deduped[:enrich_cap]
    enrich_ids = [r.get("business_id") for r in to_enrich
                  if r.get("business_id")]
    print(f"[enrich] enriching {len(enrich_ids)} companies "
          f"(cap {enrich_cap})")
    enriched_data = client.enrich_businesses(enrich_ids)
    explorium_credits += len(enriched_data)
    firmographics_path = work / "firmographics.json"
    _dump(firmographics_path, {"data": enriched_data})
    reporter.update(enriched_count=len(enriched_data))
    if not enriched_data:
        raise RuntimeError("firmographics enrich returned no data.")

    # --- 5. map firmographics -> score records ------------------------------
    records_path = work / "records.json"
    proc = _run([sys.executable, str(TOOLS / "explorium_to_record.py"),
                 str(firmographics_path)], "mapping records")
    records = json.loads(proc.stdout)
    _dump(records_path, records)
    print(f"[map] {len(records)} records")

    # --- 6. website research (free; tolerate the >25% failure exit) ---------
    reporter.update(stage="researching websites")
    researched_path = work / "researched.json"
    _run([sys.executable, str(TOOLS / "research_company_website.py"),
          "--records", str(records_path), "--out", str(researched_path)],
         "researching websites", allow_nonzero=True)
    if not researched_path.exists():
        raise RuntimeError("research step produced no output file — hard fail "
                            "(network or input problem).")
    print(f"[research] researched records written; partial failures tolerated "
          f"(output present).")

    # --- 7. evidence extraction (Anthropic API) -----------------------------
    reporter.update(stage="extracting evidence")
    evidence_path = work / "evidence.json"
    _run([sys.executable, str(TOOLS / "extract_evidence.py"),
          "--records", str(researched_path), "--out", str(evidence_path)],
         "extracting evidence", env=env)

    # --- 8. provisional score -----------------------------------------------
    reporter.update(stage="scoring")
    scored_path = work / "scored.json"
    _run_score(evidence_path, scored_path, env, "scoring (provisional)")

    # --- 9. UK importer lookup (UK only), then re-score ---------------------
    current_scored = scored_path
    if is_uk:
        uk_path = work / "records_uk.json"
        _run([sys.executable, str(TOOLS / "uk_importers_lookup.py"),
              "--records", str(scored_path), "--out", str(uk_path)],
             "uk importer lookup", allow_nonzero=True)
        if uk_path.exists():
            uk_scored = work / "scored_uk.json"
            _run_score(uk_path, uk_scored, env, "scoring (post-UK)")
            current_scored = uk_scored

    # --- 10. web-search verification on the shortlist, then re-score --------
    verified_path = work / "verified.json"
    _run([sys.executable, str(TOOLS / "verify_import_evidence.py"),
          "--records", str(current_scored), "--out", str(verified_path)],
         "verifying import evidence", env=env)
    scored_after_verify = work / "scored_verified.json"
    _run_score(verified_path, scored_after_verify, env,
               "scoring (post-verify)")

    # --- 11. fetch prospects for qualifying companies (credit spend) --------
    reporter.update(stage="finding contacts")
    scored_records = _load(scored_after_verify)
    qualified = [r for r in scored_records
                 if (r.get("score") or {}).get("qualified")]
    qualified_ids = [r.get("explorium_business_id") for r in qualified
                     if r.get("explorium_business_id")]
    print(f"[prospects] {len(qualified)} qualifying companies before judge; "
          f"fetching contacts for {len(qualified_ids)}")
    prospects_raw_path = work / "prospects_raw.json"
    if qualified_ids:
        prospects = client.fetch_prospects(
            qualified_ids, job_levels=PROSPECT_JOB_LEVELS,
            job_departments=PROSPECT_JOB_DEPARTMENTS, size=1000)
        # Fallback: if the seniority/department filters return nothing, retry
        # unfiltered (SOP: European SMEs rarely tag a procurement department).
        if not prospects:
            print("[prospects] filtered fetch empty — retrying with "
                  "business_id only")
            prospects = client.fetch_prospects(qualified_ids, size=1000)
    else:
        prospects = []
    _dump(prospects_raw_path, prospects)
    print(f"[prospects] fetched {len(prospects)} prospect records")

    # --- 12. pick the best contacts deterministically -----------------------
    picked_path = work / "picked.json"
    if prospects:
        _run([sys.executable, str(TOOLS / "pick_prospects.py"),
              "--prospects", str(prospects_raw_path),
              "--companies", str(scored_after_verify),
              "--out", str(picked_path)], "picking prospects")
        picked = _load(picked_path)
    else:
        picked = []
        _dump(picked_path, picked)
    print(f"[pick] {len(picked)} picked prospects")

    # --- 13. enrich contacts + profiles, merge onto picked contacts ---------
    reporter.update(stage="enriching contacts")
    contacts_by_biz: Dict[str, List[Dict[str, Any]]] = {}
    if picked:
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
            contact = {
                "business_id": bid,
                "full_name": pr.get("full_name") or p.get("full_name") or "",
                "job_title": pr.get("job_title") or p.get("job_title") or "",
                "linkedin_url": pr.get("linkedin_url") or "",
                "email": ci.get("email") or "",
                "phone": ci.get("phone") or "",
            }
            contacts_by_biz.setdefault(str(bid), []).append(contact)
    contacts_path = work / "contacts.json"
    _dump(contacts_path, contacts_by_biz)
    print(f"[contacts] merged contacts for {len(contacts_by_biz)} companies")

    # --- 14. BDR judge, then re-score to fold the verdict -------------------
    reporter.update(stage="judging")
    judged_path = work / "judged.json"
    _run([sys.executable, str(TOOLS / "bdr_judge.py"),
          "--candidates", str(scored_after_verify), "--out", str(judged_path)],
         "judging", env=env)
    scored_final = work / "scored_final.json"
    _run_score(judged_path, scored_final, env, "scoring (post-judge)")

    # --- 15. pre-ship structural audit (hard gate) --------------------------
    reporter.update(stage="judging")
    proc = _run([sys.executable, str(TOOLS / "eval_against_labels.py"),
                 "--preship", str(scored_final)],
                "pre-ship audit", allow_nonzero=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "pre-ship audit FAILED — refusing to ship this batch. "
            f"Audit output:\n{(proc.stdout or '').strip()[-1500:]}")
    print("[preship] audit PASSED")

    # --- 16. build the final lead rows --------------------------------------
    reporter.update(stage="building sheet")
    out_base = work / "leads"
    _run([sys.executable, str(TOOLS / "build_lead_rows.py"),
          "--companies", str(scored_final),
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
    from export_to_sheets import export_leads_to_sheets  # noqa: E402
    delivery_emails = [e.strip() for e in
                       (os.getenv("DELIVERY_SHEET_EMAILS") or "").split(",")
                       if e.strip()]
    title = (f"Capricorn leads — {country_norm.title()} — "
             f"{qualified_count} leads")
    sheet = export_leads_to_sheets(rows, title, delivery_emails or None)
    print(f"[sheet] {sheet.get('sheet_url')}")

    # rough Anthropic spend estimate (caps are the worst case)
    anthropic_usd = round(
        float(env["EVIDENCE_EXTRACT_USD_BUDGET"])
        + float(env["BDR_JUDGE_USD_BUDGET"])
        + float(env["WEB_VERIFY_USD_BUDGET"]), 2)

    reporter.update(
        status="succeeded",
        stage="done",
        sheet_url=sheet.get("sheet_url"),
        sheet_id=sheet.get("sheet_id"),
        leads_delivered=leads_delivered,
        qualified_count=qualified_count,
        discovered_count=len(discovered),
        enriched_count=len(enriched_data),
        explorium_credits=explorium_credits,
        anthropic_usd=anthropic_usd,
        finished_at=_now(),
    )
    print(f"\nDONE — {leads_delivered} leads, {qualified_count} companies, "
          f"~{explorium_credits} Explorium credits. Sheet: "
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
