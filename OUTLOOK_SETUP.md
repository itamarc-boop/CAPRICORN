# Connecting Outlook sending (one-time operator setup)

This lets your client send emails from the app through their **Outlook / Microsoft 365**
mailbox, exactly like the Gmail option already works. You do this **once**. Your client never
touches it; afterward they just click **Connect Outlook** in the app and approve.

It is the Microsoft twin of the Google OAuth client you already set up. Free.

**What you'll end up with** (the four values to paste into the app):

| Value | Where it comes from |
|---|---|
| `MICROSOFT_CLIENT_ID` | The app registration's "Application (client) ID" |
| `MICROSOFT_CLIENT_SECRET` | A "client secret" you create (the **Value**, not the ID) |
| `MICROSOFT_TENANT` | `common` (recommended), or your Directory (tenant) ID |
| `MICROSOFT_OAUTH_REDIRECT_URI` | The app's callback URL (below) |

---

## Before you start

You need a Microsoft account to log in to the Azure portal. Your own Microsoft 365 / Outlook
login works fine; your client's IT person could also do this in their account. There's no cost.

Decide your app's callback URL now, because you'll paste it in two places and they must match
exactly:

- **Production:** `https://YOUR-APP-DOMAIN/api/integrations/microsoft/callback`
  (replace `YOUR-APP-DOMAIN` with your live Vercel domain, e.g. `capricorn.vercel.app`)
- **Local testing (optional):** `http://localhost:3000/api/integrations/microsoft/callback`

You can register both; Azure allows several redirect URLs.

---

## Step 1 — Create the app registration

1. Go to **https://portal.azure.com** and sign in.
2. In the top search bar, type **App registrations** and click it.
3. Click **+ New registration**.
4. **Name:** anything, e.g. `Capricorn Lead Ops`.
5. **Supported account types:** choose
   **"Accounts in any organizational directory and personal Microsoft accounts"**.
   (This is the flexible option and lets the client connect regardless of which Microsoft
   account they use. With this choice your tenant value is `common`.)
6. **Redirect URI:** in the dropdown pick **Web**, and paste your **production** callback URL
   from above.
7. Click **Register**.

On the page that opens, **copy the "Application (client) ID"**. That's your
`MICROSOFT_CLIENT_ID`.

> If you chose a single-organization option instead of step 5, also copy the
> **"Directory (tenant) ID"** and use that as `MICROSOFT_TENANT` instead of `common`.

---

## Step 2 — Add the permissions

1. In the left menu of your new app, click **API permissions**.
2. Click **+ Add a permission** → **Microsoft Graph** → **Delegated permissions**.
3. Search for and tick each of these:
   - **Mail.Send**
   - **User.Read** (often already added by default — that's fine)
   - **offline_access**
4. Click **Add permissions**.

That's all the access the app needs: send mail as the signed-in user, read which mailbox it is,
and stay connected. It never reads the inbox.

> Most organizations allow users to approve these themselves. If your client's company blocks
> that, their IT admin clicks **"Grant admin consent for &lt;org&gt;"** on this same page, once.

---

## Step 3 — Create the client secret

1. In the left menu, click **Certificates & secrets**.
2. Under **Client secrets**, click **+ New client secret**.
3. Add a description (e.g. `capricorn`) and an expiry (24 months is fine).
4. Click **Add**.
5. **Immediately copy the secret's "Value"** (not the "Secret ID"). It is shown only once; if
   you navigate away you'll have to make a new one. That's your `MICROSOFT_CLIENT_SECRET`.

> Note the expiry date. When it approaches (e.g. in ~24 months) you'll create a fresh secret
> and update `MICROSOFT_CLIENT_SECRET`, or Outlook sending will stop until you do.

---

## Step 4 — Add the four values to the app

Set these wherever the app reads its environment:

- **Local (`webapp/.env.local`):**
  ```
  MICROSOFT_CLIENT_ID=...the Application (client) ID...
  MICROSOFT_CLIENT_SECRET=...the secret Value...
  MICROSOFT_TENANT=common
  MICROSOFT_OAUTH_REDIRECT_URI=http://localhost:3000/api/integrations/microsoft/callback
  ```
- **Production (Vercel → Project → Settings → Environment Variables):** the same four keys, but
  set `MICROSOFT_OAUTH_REDIRECT_URI` to your **production** callback URL.

The redirect URL here must match **exactly** what you entered in Azure (Step 1.6 / the portal's
**Authentication** page). A trailing-slash or http/https mismatch is the #1 cause of a failed
connect.

Restart the dev server (or redeploy on Vercel) so it picks up the new variables.

---

## Step 5 — Connect and test

1. Open the app, go to **Integrations**. A new **Outlook** card now appears (it stays hidden
   until the four values are set, so nothing looks broken before you're ready).
2. Click **Connect Outlook**, sign in with the Outlook mailbox, and approve.
3. The card now shows **Connected as &lt;address&gt;**.
4. Send one real test: open any company → **Write email** → **Approve & send**. Confirm it
   lands and shows in the mailbox's **Sent** folder.

That's it. From here, Gmail and Outlook both work; whichever mailbox was connected most recently
is the one the app sends from. To switch a client fully to Outlook, just connect Outlook and
don't connect Gmail.

---

## If something goes wrong

- **"Could not connect" with a redirect error** → the `MICROSOFT_OAUTH_REDIRECT_URI` and the
  Azure redirect URL don't match exactly. Fix one to match the other.
- **Approve screen says an admin must consent** → the client's org blocks self-consent; their
  IT admin clicks **Grant admin consent** on the app's API permissions page (Step 2).
- **Sends fail with "authorization expired"** → reconnect Outlook on the Integrations page. If
  it keeps happening, the client secret may have expired (Step 3) — create a new one and update
  `MICROSOFT_CLIENT_SECRET`.
