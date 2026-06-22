"""One-time helper: run the Google OAuth consent on a machine with a browser
and capture a long-lived refresh token for the Sheets/Drive worker.

Reads the Desktop OAuth client at credentials.json, opens the browser for the
user to click Allow, then writes the result to .tmp/google_oauth.json
(gitignored): {"client_id", "client_secret", "refresh_token"}.

Run:  python tools/get_google_oauth.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Must match the scopes export_to_sheets.py uses.
SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def main() -> int:
    try:
        from google_auth_oauthlib.flow import InstalledAppFlow  # type: ignore
    except ImportError:
        print("google-auth-oauthlib not installed. "
              "Run: pip install google-auth-oauthlib", file=sys.stderr)
        return 1

    client_file = ROOT / "credentials.json"
    if not client_file.exists():
        print(f"Desktop OAuth client not found at {client_file}", file=sys.stderr)
        return 1

    flow = InstalledAppFlow.from_client_secrets_file(str(client_file), scopes=SCOPES)
    # access_type=offline + prompt=consent guarantee a refresh token every time.
    creds = flow.run_local_server(
        port=0, open_browser=True,
        access_type="offline", prompt="consent",
        success_message="Capricorn: sign-in complete. You can close this tab.",
    )

    if not getattr(creds, "refresh_token", None):
        print("ERROR: Google returned no refresh token. Revoke the prior grant "
              "at myaccount.google.com/permissions and retry.", file=sys.stderr)
        return 1

    cfg = flow.client_config
    out = ROOT / ".tmp" / "google_oauth.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "refresh_token": creds.refresh_token,
    }))
    print(f"OK: refresh token captured -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
