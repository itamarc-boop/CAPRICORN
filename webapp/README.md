# Capricorn Lead-Ops Web App

CRM-lite for the Capricorn lead-gen pipeline. The Capricorn client signs in with Google and works the pipeline self-serve: browse companies by country, generate AI-personalized email drafts from templates, review and approve them in a queue, then batch-send from the connected Gmail mailbox at about one email per minute. Funnel status per company (`new → contacted → replied → meeting → won / not_interested → archived`); `contacted` flips automatically on the first send.

This is Phase 2.5 of the project. Phase 1 is the Python pipeline in the parent repo (`tools/`, `workflows/`); it writes lead JSON files to `.tmp/`. The sync script loads those into Supabase as `companies` + `contacts` (1-N per company).

## Pages

- `/` — Countries hub: per-country rollups (tiers, funnel statuses), drill into a market
- `/companies` — filterable companies table; select rows → "Generate N drafts" (template + language)
- `/companies/<id>` — company detail: evidence, contacts, drafts, email history, funnel status, one-off send
- `/drafts` — approval queue: edit/approve/reject/regenerate drafts, then "Send approved" to start the queue
- `/templates`, `/integrations` — unchanged from v1

## Stack

- Next.js 16 (App Router) + React 19 + Tailwind v4 + TypeScript
- Supabase Postgres + Auth (Google OAuth) + Realtime
- `googleapis` for the Gmail send flow (scope: `gmail.send` only)
- Vercel for hosting

## What you need from outside this repo

You will create three external resources. All free at our scale.

1. **A Supabase project** (separate from any Oktopost project)
2. **A Google Cloud OAuth client** (Web type) for the Gmail send flow
3. **A Google OAuth client for Supabase Auth** (different OAuth client, or the same one with extra redirect URIs)

Detailed steps below.

---

## One-time setup

### 1. Create a Supabase project

1. Go to https://supabase.com → New project → name it `capricorn-leadops`, pick a region near the client (eu-central-1 if EU client, us-east-1 if Americas).
2. Once it's ACTIVE_HEALTHY, go to **Settings → API**. Copy:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `Project API keys → anon` (or `publishable`) → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `Project API keys → service_role` → `SUPABASE_SERVICE_ROLE_KEY` (keep secret; never commit)

### 2. Apply the schema

Two options:

**A) Via the Supabase SQL editor (no CLI needed):**
1. Open the SQL Editor in the Supabase dashboard.
2. Paste the contents of `supabase/migrations/0001_init.sql` and run, then `supabase/migrations/0002_companies_contacts.sql` and run.
3. Paste the contents of `supabase/seed.sql` and run (creates a starter template).
4. Edit the `app_users` row for `client@capricorn.example` to the real Capricorn client email:
   ```sql
   update app_users set email = '<real-client-email>' where email = 'client@capricorn.example';
   ```

**B) Via the Supabase CLI:**
```bash
brew install supabase/tap/supabase
supabase link --project-ref <your-project-ref>
supabase db push   # applies migrations/0001_init.sql
psql "$(supabase db remote query-url)" < supabase/seed.sql
```

### 3. Configure Supabase Auth → Google provider

1. In Supabase dashboard: **Authentication → Providers → Google → enable**.
2. Supabase shows the redirect URI it expects (looks like `https://<ref>.supabase.co/auth/v1/callback`). Copy it.
3. In Google Cloud Console (https://console.cloud.google.com):
   - Create a project (or reuse an existing one).
   - **APIs & Services → OAuth consent screen**: configure as "Internal" if you have a Google Workspace org, otherwise "External" with you + the client added as test users.
   - **APIs & Services → Credentials → Create credentials → OAuth client ID**, type "Web application", name "Capricorn Lead Ops Supabase Auth".
   - Add the Supabase callback URI from step 2 as an **Authorized redirect URI**.
   - Save. Copy the `Client ID` and `Client secret`.
4. Back in Supabase → Auth → Google: paste the client ID and client secret. Save.

### 4. Create the Gmail OAuth client (separate from Supabase Auth)

We use a second OAuth client so the Gmail send permission is independent from the sign-in flow.

1. In Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**, type "Web application", name "Capricorn Lead Ops Gmail Send".
2. Add these as **Authorized redirect URIs**:
   - `http://localhost:3000/api/integrations/google/callback` (for local dev)
   - `https://<your-app>.vercel.app/api/integrations/google/callback` (after first Vercel deploy)
3. Save. Copy the `Client ID` and `Client secret` → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
4. Enable the Gmail API: **APIs & Services → Library → Gmail API → Enable**.
5. **OAuth consent screen → Scopes → Add or remove scopes**: add `https://www.googleapis.com/auth/gmail.send` and the basic profile/email scopes.

### 5. Fill in `.env.local`

```bash
cp .env.local.example .env.local
```

Then edit `webapp/.env.local` with the values from steps 1 and 4. The Python sync script also reads this file (or the repo-root `.env`).

### 6. Install dependencies

```bash
cd webapp
pnpm install        # or: npm install
```

### 7. Run locally

```bash
pnpm dev
```

Open http://localhost:3000. Sign in with a Google account that matches a row in `app_users` (yours or the client's). You should see the leads table — empty if you haven't synced yet.

### 8. Sync your first leads from the pipeline

From the repo root:

```bash
pip install supabase python-dotenv    # if not already installed
python3 tools/sync_leads_to_supabase.py .tmp/leads_2026-05-27_iter2_v2.json --iteration 2
```

Refresh the dashboard — the rows should appear without manually refreshing (Supabase Realtime).

### 9. Connect the Capricorn client's Gmail

The Capricorn client signs into the dashboard, goes to `/integrations`, clicks "Connect a Gmail mailbox", and grants the `gmail.send` scope. Tokens land in the `integrations` table.

### 10. Send a test email

Open any company with an emailable contact. In the "Send email" panel, pick a contact + the seeded template, optionally edit subject/body, and click Send. The email goes out from the connected mailbox; the company flips to "contacted" automatically; check the email log on the company page.

### 11. The draft → approve → send loop

1. On `/companies`, check a few rows → the bottom bar appears. Pick a template + language → "Generate N drafts" (uses `ANTHROPIC_API_KEY`, model `claude-sonnet-4-6`, ~1 cent per draft).
2. On `/drafts`, expand each draft to edit, then Approve (or Reject / Regenerate with an instruction).
3. Click "Send approved (N)" — drafts are queued and the scheduler sends ~one per minute. Watch statuses drain live (`approved → sending → sent`).

The scheduler is Supabase pg_cron hitting `POST /api/send-queue/tick` with `Authorization: Bearer $CRON_SECRET` once a minute. Wire it at deploy time with `supabase/pg_cron_send_queue.sql` (fill in the app URL + secret). For local testing, trigger ticks by hand:

```bash
curl -X POST http://localhost:3000/api/send-queue/tick -H "Authorization: Bearer $CRON_SECRET"
```

---

## Deploying to Vercel

```bash
# from webapp/
vercel
# follow prompts. Pick "Other" framework if asked (Next.js auto-detected anyway).
```

Then in the Vercel project Settings → Environment Variables:
- Copy every var from your local `.env.local` (Supabase URL/keys, Google client ID/secret, redirect URI, `ANTHROPIC_API_KEY`, `CRON_SECRET`).
- For `GOOGLE_OAUTH_REDIRECT_URI` use the **production** redirect URI (must match what you registered in Google Cloud step 4).
- For `NEXT_PUBLIC_APP_URL` use your production URL.

Redeploy after setting env vars: `vercel --prod`.

Also update Google Cloud OAuth client redirect URIs to include the production URL (you set this up in step 4 above; just double-check).

After the first production deploy, wire the send-queue scheduler: open the Supabase SQL editor, paste `supabase/pg_cron_send_queue.sql` with `<APP_URL>` and `<CRON_SECRET>` filled in, and run it. Verify with `select jobname, schedule, active from cron.job;`.

---

## Repeating runs

Every time the Python pipeline produces a new `.tmp/leads_*.json` (after each Iteration), run:

```bash
python3 tools/sync_leads_to_supabase.py .tmp/leads_2026-06-XX_iter3.json --iteration 3
```

Re-syncing is safe — the script never writes `status` / `notes`, never deletes contacts, leaves manually added contacts alone, and only overwrites company fields with non-empty values. Use `--batch-label` for one-off runs (e.g. `--batch-label mexico_test`) and `--dry-run` to preview.

## What's NOT in this phase

(Deliberately out of scope, per the client.)
- Reply tracking / open pixels / bounce detection (statuses are flipped manually; sends are logged per contact)
- Email sequences / cadences
- Multi-mailbox selector at send time (uses the most recently connected Gmail)
- Per-row notes editing (the column exists, just no UI yet)
- Pipeline trigger button (still run Python from the CLI)

## Troubleshooting

- **"403 Forbidden: <email> is not on the Capricorn allowlist."** Add the email to `app_users` via SQL Editor.
- **"no_gmail_connected"** when sending. Go to `/integrations` and connect a Gmail mailbox first.
- **OAuth `state_mismatch`** error. Clear cookies for the app, try connecting Gmail again.
- **Leads don't appear after running sync.** Check the script's stderr for errors. Confirm `SUPABASE_SERVICE_ROLE_KEY` is set. Verify in Supabase Table Editor that the rows landed.
- **Realtime doesn't update.** Verify the `leads` table is in the `supabase_realtime` publication (the migration adds it; check `select * from pg_publication_tables where pubname = 'supabase_realtime'`).
