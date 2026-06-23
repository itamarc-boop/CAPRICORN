# Deploying Capricorn + onboarding your customer

## The short answer (read this first)

**Your customer does almost nothing. They never touch an API, a key, or the Google
Cloud console.** All of that lives in *your* deployment, set up once by you.

The customer's entire setup is two things:
1. You add their email to the allowlist (one SQL line).
2. They open the app, sign in, and click **"Connect a Gmail mailbox"** — one Google
   consent screen, no keys.

That's it. They do **not** connect Drive, do **not** create API keys, do **not** set
up Explorium/Anthropic/GitHub. Discovery runs on *your* keys in *your* GitHub Actions;
the leads land in *their* CRM view inside the app.

---

## Where everything lives (so you know who pays / who owns what)

| Thing | Whose account | Where it's configured | Who pays |
|---|---|---|---|
| Explorium API key | Yours | GitHub Actions secret | You |
| Anthropic (Claude) key | Yours | GitHub Actions secret + Vercel env | You |
| Supabase (DB/auth) | Yours | Vercel env + GitHub Actions secret | You (free tier fine) |
| Google OAuth client (Gmail send) | Yours | Vercel env (`GOOGLE_CLIENT_ID/SECRET`) | Free |
| Google OAuth (Sheets export) | Yours | GitHub Actions secret | Free |
| GitHub repo + Actions (the worker) | Yours | already set up | Free |
| **The customer's Gmail** | **Theirs** | they click "Connect Gmail" in-app | — |

The customer **uses** your Gmail OAuth client to authorize *their own* mailbox — they
don't own or configure it. Sending goes out from their address; they just grant the
`gmail.send` permission once.

---

## Part A — Deploy the app (one-time, you)

Most of this is already done from earlier setup (Supabase project, Google OAuth clients,
GitHub Actions secrets). The remaining work is the **Vercel deploy** + a couple of
cross-checks.

### 1. Supabase (already provisioned)
- Project `xezchcvrelozdipmaaun` exists. Make sure **all** migrations are applied
  (in order): `webapp/supabase/migrations/0001` → `0005`. (0004 = `crm_synced`,
  0005 = `seen_companies` were added recently — both are already applied to the live DB.)
  To apply to a fresh project: paste each `.sql` into the Supabase SQL editor, or
  `node webapp/scripts/apply-migration.mjs`.
- Enable **Authentication → Providers → Google** (for Google sign-in). Email/password
  also works, so this is optional but nicer for the client.

### 2. Deploy to Vercel
From `webapp/`:
```bash
vercel            # first time: link/create the project
vercel --prod     # production deploy
```

Set these **Environment Variables** in the Vercel project (Settings → Environment
Variables) — copy the values from `webapp/.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SERVICE_ROLE_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_OAUTH_REDIRECT_URI        # set to the PRODUCTION url (see step 3)
NEXT_PUBLIC_APP_URL              # your production url, e.g. https://capricorn.vercel.app
ANTHROPIC_API_KEY
CRON_SECRET
GITHUB_DISPATCH_TOKEN            # lets the app trigger discovery runs
GITHUB_OWNER                     # itamarc-boop
GITHUB_REPO                      # CAPRICORN
```
Redeploy (`vercel --prod`) after setting them.

### 3. Point the Gmail OAuth redirect at production
In Google Cloud Console → the Gmail-send OAuth client → **Authorized redirect URIs**,
add:
```
https://<your-prod-domain>/api/integrations/google/callback
```
and set Vercel's `GOOGLE_OAUTH_REDIRECT_URI` to that same URL. (Keep the localhost one
for dev.) If you use Google sign-in too, the Supabase Auth callback URL is already
registered from earlier setup.

> **Heads-up on the Gmail consent screen:** `gmail.send` is a "sensitive" scope. While
> the app is unverified by Google, the customer can still connect — add their email as a
> **Test user** (Google Cloud → OAuth consent screen → Test users) and they'll click
> through a one-time "Google hasn't verified this app → Continue" notice. For one client
> that's fine. (Only needed if you ever go past ~100 users or want to remove that notice
> → submit for Google verification.)

### 4. Wire the send scheduler (pg_cron)
After the first prod deploy, open the Supabase SQL editor, paste
`webapp/supabase/pg_cron_send_queue.sql` with `<APP_URL>` and `<CRON_SECRET>` filled in,
and run it. This makes approved emails actually send (~1/min). Verify:
```sql
select jobname, schedule, active from cron.job;
```

### 5. GitHub Actions (the discovery worker — already set)
Secrets already configured on `itamarc-boop/CAPRICORN`: `EXPLORIUM_API_KEY`,
`ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`GOOGLE_OAUTH_{CLIENT_ID,CLIENT_SECRET,REFRESH_TOKEN}`, `DELIVERY_SHEET_EMAILS`, and the
`MASTER_SHEET_ID` variable. Nothing to change unless you rotate a key.

---

## Part B — Onboard your customer (5 minutes, you + them)

### 1. You: add them to the allowlist
In the Supabase SQL editor:
```sql
insert into app_users (email, role) values ('their-email@company.com', 'client')
on conflict (email) do update set role = 'client';
```
(`role = 'client'` hides operator internals — credits, raw errors — from them.)

### 2. You: share the master leads sheet with them (optional)
Add their email to the `DELIVERY_SHEET_EMAILS` GitHub Actions secret (comma-separated)
so every run shares the sheet with them. **This is optional** — discovered leads now
land directly in their in-app CRM, so the sheet is just a bonus.

### 3. Them: sign in + connect Gmail
- They open your production URL, sign in (Google or email/password).
- They go to **Integrations → "Connect a Gmail mailbox"**, pick their account, and grant
  send permission. Done — they can now send.

### 4. Them: use it
- **Get new leads** → pick a country → Run. Leads appear in **Companies** when it finishes.
- Open a company → **Write email** → Approve & send. Batches send ~1/min.

No Drive, no API keys, no console. Everything technical stayed on your side.

---

## What the customer can and can't do (by design)
- **Can:** discover leads, read dossiers, write/approve/send emails, track the funnel.
- **Can't / doesn't need to:** see your API keys or credit costs, touch Google Cloud,
  manage the pipeline. Discovery spend (Explorium + Claude) is on your accounts.

## Rotating / handing off later
- To move the leads sheet to the customer's own Drive instead of yours, you'd swap the
  Sheets OAuth refresh token for one from their Google account — not needed today.
- To bill the customer for usage, that's a business decision outside the app; the spend
  is visible to you in Explorium + Anthropic dashboards.
