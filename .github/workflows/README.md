# CI workflows

## discover.yml - Discovery pipeline

Runs the Capricorn lead-discovery pipeline on a GitHub-hosted runner and reports
progress back to the app.

### What triggers it

- **The app's Run button.** The webapp sends a GitHub `repository_dispatch`
  request with `event_type: "discover"` and a `client_payload` of
  `{ run_id, country, target }`. The workflow listens for that event type and
  starts a run. `run_id` is the `pipeline_runs` row the worker updates.
- **Manual run (testing).** From the GitHub Actions UI, use the "Run workflow"
  button (`workflow_dispatch`). Inputs:
  - `country` (required)
  - `target` (optional, defaults to `25`)
  - `run_id` (optional) - leave blank for an ad-hoc test. With no `run_id` the
    pipeline still runs end to end, it just has no `pipeline_runs` row to report
    into.

Runs are grouped by `run_id` (concurrency) so two discovery runs do not collide
on the shared `.tmp/` files. Runs are not cancelled in progress.

### How it reports progress

The single step runs:

```
python tools/run_pipeline.py --run-id "<id>" --country "<name>" --target "<int>"
```

`run_pipeline.py` (the orchestrator, maintained separately) drives the pipeline
and writes status, stage, progress counters, the delivered Google Sheet URL,
cost figures, and any error straight to the matching row in the `pipeline_runs`
Supabase table using the service role. The Discovery page watches that row over
Supabase Realtime, so the app reflects progress without GitHub knowing anything
about the UI.

### Required secrets

Set these in **Settings -> Secrets and variables -> Actions** for the repo.
Names only below; never commit the values.

| Secret | What it's for | Where it comes from |
| --- | --- | --- |
| `EXPLORIUM_API_KEY` | Business/prospect discovery and enrichment | Explorium account |
| `ANTHROPIC_API_KEY` | Claude calls for scoring and qualification | Anthropic console |
| `SUPABASE_URL` | The Capricorn Supabase project URL | Supabase project settings (API) |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged write access to `pipeline_runs` (bypasses RLS) | Supabase project settings (API). Service role - keep it secret |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Creates and shares the delivery Google Sheet | Google Cloud service-account key, pasted as the raw JSON string |
| `DELIVERY_SHEET_EMAILS` | Optional comma-separated emails the delivered sheet is shared with | Whoever should receive the sheet |
| `GH_RUN_URL` | Not a secret - set automatically by the workflow to this Actions run's URL, for debugging | n/a |

> `GH_RUN_URL` is derived from the run context (`server_url`/`repository`/
> `run_id`), so it does not need to be configured as a secret.

### Notes

- Python 3.11; dependencies install from `requirements.txt` with pip caching.
- Job timeout is 45 minutes.
- The orchestrator reads `SUPABASE_URL` and/or `NEXT_PUBLIC_SUPABASE_URL`; this
  workflow provides `SUPABASE_URL`.
