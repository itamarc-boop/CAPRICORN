# Discovery engine — setup and operation

The in-app **Discover** page lets the client type a country, press Run, and get
a 2-tab Google Sheet of fresh ICP leads. This document is the one-time wiring.

## How it works

1. Client opens **Discover**, types a country + target lead count, confirms the
   estimate, presses Run.
2. The webapp inserts a row in the Supabase `pipeline_runs` table (status
   `queued`) and fires a GitHub `repository_dispatch` event.
3. A **GitHub Actions** workflow (`.github/workflows/discover.yml`) runs
   `python tools/run_pipeline.py`, which: discovers + enriches companies via the
   Explorium REST API, researches sites, extracts quoted evidence, scores against
   the locked ICP model, finds + enriches contacts, runs the BDR judge, passes
   the pre-ship audit, and builds the lead rows.
4. It exports a **Google Sheet** with two tabs (tab 1 = clean contacts + ICP,
   tab 2 = full decision detail) and writes the Sheet URL + status back to the
   `pipeline_runs` row.
5. The Discover page updates live (queued -> running -> succeeded) and shows the
   **Open Google Sheet** button. Delivery is the Sheet only; runs do not auto-import
   into the CRM (you can still sync a run's JSON with `tools/sync_leads_to_supabase.py`
   if you ever want it in the CRM).

## One-time setup

### 1. Apply the migration
Run `webapp/supabase/migrations/0003_pipeline_runs.sql` in the Supabase SQL editor
(or `supabase db push`). Safe to re-run.

### 2. Push the project to GitHub
The worker is GitHub Actions, so the repo must be on GitHub.
```
git init && git add -A && git commit -m "Capricorn lead-ops"
gh repo create capricorn --private --source . --push
```
Note the `<owner>/<repo>` (e.g. `itamar/capricorn`).

### 3. GitHub Actions secrets
Repo → Settings → Secrets and variables → Actions → New repository secret. Add:

| Secret | Value |
|---|---|
| `EXPLORIUM_API_KEY` | from repo-root `.env` |
| `ANTHROPIC_API_KEY` | from repo-root `.env` |
| `SUPABASE_URL` | the Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key (lets the worker update `pipeline_runs`) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the full service-account JSON (see step 4), pasted as one secret |
| `DELIVERY_SHEET_EMAILS` | optional: comma-separated emails to share each Sheet with (the client). If empty, the Sheet becomes link-viewable (anyone with the link). |

### 4. Google service account (for the Sheet)
1. Google Cloud Console → the Capricorn project → enable **Google Sheets API** and **Google Drive API**.
2. IAM & Admin → Service Accounts → create one → Keys → Add key → JSON. Download it.
3. Paste the entire JSON file contents as the `GOOGLE_SERVICE_ACCOUNT_JSON` secret above.
4. If you want the Sheets to live in a shared Drive folder you own, share that folder
   with the service account's email (`...@...iam.gserviceaccount.com`) as Editor.
   Otherwise each Sheet is created in the service account's own Drive and shared per
   `DELIVERY_SHEET_EMAILS` / link.

### 5. Vercel environment (the webapp side)
Project → Settings → Environment Variables. Add the three discovery vars
(also in `webapp/.env.local.example`):

| Var | Value |
|---|---|
| `GITHUB_DISPATCH_TOKEN` | a fine-grained GitHub PAT with **Actions: read and write** on the repo |
| `GITHUB_OWNER` | the repo owner (user or org) |
| `GITHUB_REPO` | the repo name (e.g. `capricorn`) |

Redeploy after adding them.

## Test it once (the one step I could not run for you)

The Explorium REST calls spend your credits, so the final validation is yours.
Easiest path — run the workflow by hand from GitHub before exposing the button:

- GitHub → Actions → **Discovery pipeline** → Run workflow → set `country` (e.g.
  `Portugal`) and `target` (e.g. `10`) and leave `run_id` blank. Watch the logs.
- A blank `run_id` means it runs without reporting to a `pipeline_runs` row (fine
  for a smoke test); it still produces the Google Sheet, whose URL prints at the
  end of the logs.
- If it succeeds, press Run from the app for the full round trip (row updates live
  + Open Google Sheet button).

If discovery returns zero or a step errors, the run row goes `failed` with the
stage in the error text, and the Actions logs show exactly which call failed.

## Cost per run (rough)

~25-35 Explorium credits + ~$0.60-1.00 of Claude per 25 delivered leads. The
Anthropic steps are budget-capped (evidence / web-verify / judge env caps scale
with the target). The confirm screen shows an estimate before each run.

## Notes / known gaps

- Country is free-text; recognized English country names map to ISO codes in
  `tools/explorium_api.py` (`COUNTRY_CODES`, ~80 countries). An unrecognized name
  fails the run with a clear message; add it to that dict if needed.
- The "Decision detail" tab columns `deal_probability` and `judge_pattern` render
  blank until `tools/build_lead_rows.py` is extended to emit them; every other
  decision field (evidence quotes, what-to-sell, judge reason, flags, business
  model, sources) is populated.
- The locked 8-country ICP model is untouched; a typed country is allowed for that
  run via the `EXTRA_TARGET_COUNTRIES` override the orchestrator sets.
