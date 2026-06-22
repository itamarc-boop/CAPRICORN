"""Export Capricorn lead rows to a two-tab Google Sheet (the client deliverable).

Consumes the exact JSON written by tools/build_lead_rows.py: a JSON array of
per-contact lead-row dicts. Builds one spreadsheet with two tabs:

  * "Leads"           — the clean delivery view (firmographics + best contact).
  * "Decision detail" — every Leads column plus the evidence/judgment columns so
                        the client can verify a tier in 30 seconds.

Auth is a Google **service account**. Provide it one of two ways:
  * GOOGLE_SERVICE_ACCOUNT_JSON   raw service-account JSON string (preferred; this
                                  is what the GitHub Actions worker passes).
  * GOOGLE_APPLICATION_CREDENTIALS  path to a service-account JSON file (fallback).

Sharing:
  * DELIVERY_SHEET_EMAILS  optional comma list. Each address gets writer access
                           (no email notification). If empty, an "anyone with the
                           link can view" permission is added so the URL works.

CLI:
    python tools/export_to_sheets.py --leads .tmp/leads_2026-06-20.json \
        --title "Capricorn Leads — Spain — 2026-06-20"

On success prints exactly one JSON line to stdout and exits 0:
    {"sheet_url": "...", "sheet_id": "..."}
On any failure prints {"error": "<message>"} to stderr and exits 1.

Importable: the orchestrator calls export_leads_to_sheets(rows, title, emails).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

# ─── column contracts ───────────────────────────────────────────────────────
# Tab 1 "Leads" — clean delivery, in this exact order.
LEADS_COLUMNS = [
    "company_name", "country", "city", "industry", "website",
    "employee_count", "estimated_revenue", "icp_tier", "icp_score",
    "contact_name", "contact_title", "contact_email", "contact_phone",
    "contact_linkedin_url", "linkedin_company_page",
]

# Tab 2 "Decision detail" — every Leads column plus the evidence/judgment fields.
DETAIL_EXTRA_COLUMNS = [
    "deal_probability", "business_model", "import_evidence", "own_brand_evidence",
    "third_party_brands", "evidence_urls", "what_to_sell_gaps", "judge_reason",
    "judge_pattern", "needs_human_check",
]
DETAIL_COLUMNS = LEADS_COLUMNS + DETAIL_EXTRA_COLUMNS

# Human-friendly Title Case header labels. Anything not listed falls back to a
# derived label (underscores -> spaces, sentence case) so adding a column never
# breaks the export.
HEADER_LABELS = {
    "company_name": "Company name",
    "country": "Country",
    "city": "City",
    "industry": "Industry",
    "website": "Website",
    "employee_count": "Employee count",
    "estimated_revenue": "Estimated revenue",
    "icp_tier": "ICP tier",
    "icp_score": "ICP score",
    "contact_name": "Contact name",
    "contact_title": "Contact title",
    "contact_email": "Contact email",
    "contact_phone": "Contact phone",
    "contact_linkedin_url": "Contact LinkedIn URL",
    "linkedin_company_page": "LinkedIn company page",
    "deal_probability": "Deal probability",
    "business_model": "Business model",
    "import_evidence": "Import evidence",
    "own_brand_evidence": "Own brand evidence",
    "third_party_brands": "Third party brands",
    "evidence_urls": "Evidence URLs",
    "what_to_sell_gaps": "What to sell gaps",
    "judge_reason": "Judge reason",
    "judge_pattern": "Judge pattern",
    "needs_human_check": "Needs human check",
}


def _load_env() -> None:
    load_dotenv(ROOT / "webapp" / ".env.local")
    load_dotenv(ROOT / ".env")


def _header_label(field: str) -> str:
    if field in HEADER_LABELS:
        return HEADER_LABELS[field]
    words = field.replace("_", " ").strip()
    return words[:1].upper() + words[1:] if words else field


def _cell(value: Any) -> str:
    """Coerce a row value to a sheet cell string. None/empty -> ''."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (list, tuple)):
        return "; ".join(_cell(v) for v in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def _grid(rows: List[Dict[str, Any]], columns: List[str]) -> List[List[str]]:
    """Header row + one row per lead, using row.get(col, '') for every column."""
    grid = [[_header_label(c) for c in columns]]
    for row in rows:
        grid.append([_cell(row.get(c, "")) for c in columns])
    return grid


# ─── Google auth + service clients ──────────────────────────────────────────

def _credentials():
    # OAuth user credentials (refresh token) take precedence. This is the path
    # used when the org blocks service-account keys: a one-time browser consent
    # (tools/get_google_oauth.py) yields a refresh token, stored as three repo
    # secrets. Sheets are then created in the consenting user's own Drive.
    rt = os.getenv("GOOGLE_OAUTH_REFRESH_TOKEN")
    cid = os.getenv("GOOGLE_OAUTH_CLIENT_ID")
    csec = os.getenv("GOOGLE_OAUTH_CLIENT_SECRET")
    if rt and cid and csec:
        try:
            from google.oauth2.credentials import Credentials  # type: ignore
        except ImportError:
            raise RuntimeError(
                "google-auth not installed. Run: pip install -r requirements.txt")
        return Credentials(
            token=None,
            refresh_token=rt.strip(),
            client_id=cid.strip(),
            client_secret=csec.strip(),
            token_uri="https://oauth2.googleapis.com/token",
            scopes=SCOPES,
        )

    try:
        from google.oauth2 import service_account  # type: ignore
    except ImportError:
        raise RuntimeError(
            "google-auth not installed. Run: pip install -r requirements.txt")

    raw = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
    if raw and raw.strip():
        try:
            info = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: {exc}")
        return service_account.Credentials.from_service_account_info(
            info, scopes=SCOPES)

    path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if path and Path(path).exists():
        return service_account.Credentials.from_service_account_file(
            path, scopes=SCOPES)

    raise RuntimeError(
        "No Google credentials found. Set GOOGLE_OAUTH_REFRESH_TOKEN + "
        "GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET (sign-in flow), or "
        "GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS (service account).")


def _build_services(creds):
    try:
        from googleapiclient.discovery import build  # type: ignore
    except ImportError:
        raise RuntimeError(
            "google-api-python-client not installed. "
            "Run: pip install -r requirements.txt")
    # cache_discovery=False avoids a noisy warning when oauth2client is absent.
    sheets = build("sheets", "v4", credentials=creds, cache_discovery=False)
    drive = build("drive", "v3", credentials=creds, cache_discovery=False)
    return sheets, drive


# ─── spreadsheet construction ───────────────────────────────────────────────

def _create_spreadsheet(sheets, title: str) -> Dict[str, Any]:
    """Create the spreadsheet with both tabs and return its metadata."""
    body = {
        "properties": {"title": title},
        "sheets": [
            {"properties": {"sheetId": 0, "title": "Leads",
                            "index": 0,
                            "gridProperties": {"frozenRowCount": 1}}},
            {"properties": {"sheetId": 1, "title": "Decision detail",
                            "index": 1,
                            "gridProperties": {"frozenRowCount": 1}}},
        ],
    }
    return sheets.spreadsheets().create(
        body=body,
        fields="spreadsheetId,spreadsheetUrl,sheets.properties").execute()


def _write_values(sheets, spreadsheet_id: str,
                  tab: str, grid: List[List[str]]) -> None:
    sheets.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range=f"'{tab}'!A1",
        valueInputOption="USER_ENTERED",
        body={"values": grid},
    ).execute()


def _format_requests(sheet_id: int, column_count: int) -> List[Dict[str, Any]]:
    """Bold + freeze the header row and auto-resize the columns of one tab."""
    return [
        {  # bold the header row
            "repeatCell": {
                "range": {"sheetId": sheet_id, "startRowIndex": 0,
                          "endRowIndex": 1},
                "cell": {"userEnteredFormat": {
                    "textFormat": {"bold": True}}},
                "fields": "userEnteredFormat.textFormat.bold",
            }
        },
        {  # ensure the header row stays frozen (also set at create time)
            "updateSheetProperties": {
                "properties": {"sheetId": sheet_id,
                               "gridProperties": {"frozenRowCount": 1}},
                "fields": "gridProperties.frozenRowCount",
            }
        },
        {  # auto-resize every column to its content
            "autoResizeDimensions": {
                "dimensions": {"sheetId": sheet_id, "dimension": "COLUMNS",
                               "startIndex": 0, "endIndex": column_count}
            }
        },
    ]


def _apply_formatting(sheets, spreadsheet_id: str,
                      tabs: List[Dict[str, Any]]) -> None:
    requests_body: List[Dict[str, Any]] = []
    for tab in tabs:
        requests_body.extend(
            _format_requests(tab["sheet_id"], tab["column_count"]))
    if requests_body:
        sheets.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": requests_body}).execute()


def _share(drive, file_id: str, delivery_emails: List[str]) -> None:
    emails = [e.strip() for e in (delivery_emails or []) if e and e.strip()]
    if emails:
        for email in emails:
            drive.permissions().create(
                fileId=file_id,
                body={"type": "user", "role": "writer", "emailAddress": email},
                sendNotificationEmail=False,
                fields="id",
            ).execute()
    else:
        # No named recipients: make the link viewable so the URL works.
        drive.permissions().create(
            fileId=file_id,
            body={"type": "anyone", "role": "reader"},
            fields="id",
        ).execute()


def export_leads_to_sheets(rows: List[Dict[str, Any]], title: str,
                           delivery_emails: Optional[List[str]] = None
                           ) -> Dict[str, str]:
    """Build the two-tab deliverable spreadsheet and return its URL + id.

    Args:
        rows: list of lead-row dicts (the build_lead_rows.py JSON shape).
        title: spreadsheet title.
        delivery_emails: optional writer recipients; if empty, the link is made
            viewable by anyone with it.

    Returns:
        {"sheet_url": "<spreadsheetUrl>", "sheet_id": "<spreadsheetId>"}
    """
    if not isinstance(rows, list):
        raise RuntimeError("rows must be a JSON array of lead-row dicts")

    creds = _credentials()
    sheets, drive = _build_services(creds)

    created = _create_spreadsheet(sheets, title)
    spreadsheet_id = created["spreadsheetId"]
    spreadsheet_url = created.get("spreadsheetUrl") or (
        f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit")

    # Map tab title -> sheetId from the just-created spreadsheet.
    sheet_ids = {s["properties"]["title"]: s["properties"]["sheetId"]
                 for s in created.get("sheets", [])}

    _write_values(sheets, spreadsheet_id, "Leads",
                  _grid(rows, LEADS_COLUMNS))
    _write_values(sheets, spreadsheet_id, "Decision detail",
                  _grid(rows, DETAIL_COLUMNS))

    _apply_formatting(sheets, spreadsheet_id, [
        {"sheet_id": sheet_ids.get("Leads", 0),
         "column_count": len(LEADS_COLUMNS)},
        {"sheet_id": sheet_ids.get("Decision detail", 1),
         "column_count": len(DETAIL_COLUMNS)},
    ])

    _share(drive, spreadsheet_id, delivery_emails or [])

    return {"sheet_url": spreadsheet_url, "sheet_id": spreadsheet_id}


def _parse_delivery_emails() -> List[str]:
    raw = os.getenv("DELIVERY_SHEET_EMAILS") or ""
    return [e.strip() for e in raw.split(",") if e.strip()]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Export Capricorn lead rows to a two-tab Google Sheet.")
    parser.add_argument("--leads", required=True,
                        help="Path to a build_lead_rows .json (array of rows)")
    parser.add_argument("--title", required=True, help="Spreadsheet title")
    args = parser.parse_args()

    _load_env()

    try:
        rows = json.loads(Path(args.leads).read_text(encoding="utf-8"))
    except FileNotFoundError:
        print(json.dumps({"error": f"leads file not found: {args.leads}"}),
              file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"leads file is not valid JSON: {exc}"}),
              file=sys.stderr)
        return 1

    try:
        result = export_leads_to_sheets(
            rows, args.title, _parse_delivery_emails())
    except Exception as exc:  # noqa: BLE001 — surface any failure as JSON on stderr
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1

    print(json.dumps({"sheet_url": result["sheet_url"],
                      "sheet_id": result["sheet_id"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
