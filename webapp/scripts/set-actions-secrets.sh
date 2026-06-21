#!/usr/bin/env bash
# Load the GitHub Actions secrets the discovery worker needs, reading the API
# keys from the local env files and the Google service-account JSON from a path.
# Run AFTER the repo exists and gh is authed to the right account.
#   bash webapp/scripts/set-actions-secrets.sh <owner/repo> <google-sa.json> [delivery-emails]
set -euo pipefail
REPO="${1:?Usage: set-actions-secrets.sh <owner/repo> <google-sa.json> [emails]}"
GOOGLE_JSON="${2:?Need path to the Google service-account JSON file}"
EMAILS="${3:-}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENVROOT="$ROOT/.env"; ENVWEB="$ROOT/webapp/.env.local"

val() { # val KEY FILE  -> prints the unquoted value or empty
  grep -E "^$1=" "$2" 2>/dev/null | head -1 | sed -E "s/^$1=//; s/^[\"']//; s/[\"']\$//"
}

EXPLORIUM="$(val EXPLORIUM_API_KEY "$ENVROOT")"
ANTHROPIC="$(val ANTHROPIC_API_KEY "$ENVROOT")"; [ -z "$ANTHROPIC" ] && ANTHROPIC="$(val ANTHROPIC_API_KEY "$ENVWEB")"
SUPA_URL="$(val NEXT_PUBLIC_SUPABASE_URL "$ENVWEB")"; [ -z "$SUPA_URL" ] && SUPA_URL="$(val SUPABASE_URL "$ENVROOT")"
SUPA_KEY="$(val SUPABASE_SERVICE_ROLE_KEY "$ENVWEB")"; [ -z "$SUPA_KEY" ] && SUPA_KEY="$(val SUPABASE_SERVICE_ROLE_KEY "$ENVROOT")"

[ -z "$EXPLORIUM" ] && { echo "EXPLORIUM_API_KEY not found in .env"; exit 1; }
[ -z "$ANTHROPIC" ] && { echo "ANTHROPIC_API_KEY not found"; exit 1; }
[ -z "$SUPA_URL" ] && { echo "Supabase URL not found"; exit 1; }
[ -z "$SUPA_KEY" ] && { echo "SUPABASE_SERVICE_ROLE_KEY not found"; exit 1; }
[ -f "$GOOGLE_JSON" ] || { echo "Google JSON not found at $GOOGLE_JSON"; exit 1; }

gh secret set EXPLORIUM_API_KEY        -R "$REPO" -b "$EXPLORIUM"
gh secret set ANTHROPIC_API_KEY        -R "$REPO" -b "$ANTHROPIC"
gh secret set SUPABASE_URL             -R "$REPO" -b "$SUPA_URL"
gh secret set SUPABASE_SERVICE_ROLE_KEY -R "$REPO" -b "$SUPA_KEY"
gh secret set GOOGLE_SERVICE_ACCOUNT_JSON -R "$REPO" < "$GOOGLE_JSON"
[ -n "$EMAILS" ] && gh secret set DELIVERY_SHEET_EMAILS -R "$REPO" -b "$EMAILS"

echo "Done. Secrets set on $REPO:"
gh secret list -R "$REPO"
