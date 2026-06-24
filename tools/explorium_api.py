"""Importable Explorium REST client for the headless lead-discovery pipeline.

The interactive runs use the Explorium MCP server, but GitHub Actions has no
MCP. This module is the deterministic, importable equivalent: a thin REST client
over https://api.explorium.ai/v1 plus a country-name -> ISO-3166-alpha-2 map.

Endpoints + request/response shapes are from the verified Explorium v1 spec
(see ``tools/run_pipeline.py`` for how each method is wired into the funnel):

  * stats(filters)                 -> POST /v1/businesses/stats            -> int
  * fetch_businesses(filters, ...) -> POST /v1/businesses                  -> [biz]
  * enrich_businesses(ids)         -> POST /v1/businesses/firmographics/bulk_enrich
  * fetch_prospects(ids, ...)      -> POST /v1/prospects                   -> [prospect]
  * enrich_prospect_contacts(ids)  -> POST /v1/prospects/contacts_information/bulk_enrich
  * enrich_prospect_profiles(ids)  -> POST /v1/prospects/profiles/bulk_enrich

Auth: ``EXPLORIUM_API_KEY`` from the environment, sent as the ``api_key`` header
(header names are case-insensitive). All requests send Content-Type and accept
application/json.

Filter fields (verified): ``country_code`` (ISO-2, lowercase),
``company_size`` (e.g. "11-50"/"51-200"/"201-500"/"501-1000"/"1001-5000"),
``website_keywords`` ({"values": [...]}), and ONE of
``linkedin_category``/``naics_category``/``google_category`` per request.
Within a filter values are OR'd; across fields they are AND'd.

NOTE: every method here except ``stats`` spends Explorium credits.
"""
from __future__ import annotations

import os
import time
from typing import Any, Dict, List, Optional

import requests

BASE_URL = "https://api.explorium.ai"
API_VERSION = "v1"

# Tunables for the retry/backoff loop on 429 / 5xx responses.
MAX_RETRIES = 5
BACKOFF_BASE_SECONDS = 1.5
DEFAULT_TIMEOUT = 60
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class ExploriumError(RuntimeError):
    """Raised on a non-retriable Explorium API failure."""

    def __init__(self, status: int, text: str):
        self.status = status
        self.text = text
        super().__init__(f"Explorium API error {status}: {text}")


def _chunked(items: List[Any], size: int) -> List[List[Any]]:
    return [items[i:i + size] for i in range(0, len(items), size)]


class ExploriumClient:
    """Minimal REST client for the Explorium business/prospect APIs."""

    def __init__(self, api_key: Optional[str] = None,
                 base_url: str = BASE_URL, timeout: int = DEFAULT_TIMEOUT):
        self.api_key = api_key or os.environ.get("EXPLORIUM_API_KEY")
        if not self.api_key:
            raise ExploriumError(0, "EXPLORIUM_API_KEY not set in environment")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = requests.Session()

    # ------------------------------------------------------------------
    # Shared transport
    # ------------------------------------------------------------------
    def _headers(self) -> Dict[str, str]:
        return {
            "api_key": self.api_key,
            "Content-Type": "application/json",
            "accept": "application/json",
        }

    def _url(self, path: str) -> str:
        path = path.lstrip("/")
        if not path.startswith(f"{API_VERSION}/"):
            path = f"{API_VERSION}/{path}"
        return f"{self.base_url}/{path}"

    def _post(self, path: str, body: Dict[str, Any]) -> Dict[str, Any]:
        """POST JSON to ``path`` with retry/backoff on 429 + 5xx.

        Respects a ``Retry-After`` header on 429 when present; otherwise uses
        exponential backoff. Raises ExploriumError on a non-retriable failure
        or after exhausting retries.
        """
        url = self._url(path)
        last_status = 0
        last_text = ""
        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = self.session.post(
                    url, headers=self._headers(), json=body,
                    timeout=self.timeout)
            except requests.RequestException as exc:
                last_status, last_text = 0, str(exc)
                if attempt == MAX_RETRIES:
                    raise ExploriumError(0, str(exc)[:300]) from exc
                time.sleep(BACKOFF_BASE_SECONDS * (2 ** (attempt - 1)))
                continue

            if resp.status_code < 400:
                try:
                    return resp.json()
                except ValueError as exc:
                    raise ExploriumError(resp.status_code,
                                         f"non-JSON response: {exc}") from exc

            last_status, last_text = resp.status_code, resp.text or ""
            if resp.status_code in RETRYABLE_STATUS and attempt < MAX_RETRIES:
                if resp.status_code == 429:
                    retry_after = resp.headers.get("Retry-After")
                    try:
                        delay = float(retry_after) if retry_after else None
                    except (TypeError, ValueError):
                        delay = None
                    if delay is None:
                        delay = BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
                else:
                    delay = BACKOFF_BASE_SECONDS * (2 ** (attempt - 1))
                time.sleep(delay)
                continue
            raise ExploriumError(resp.status_code, last_text[:300])

        raise ExploriumError(last_status, last_text[:300])

    # ------------------------------------------------------------------
    # Businesses
    # ------------------------------------------------------------------
    def stats(self, filters: Dict[str, Any]) -> int:
        """Free market-sizing probe -> total_results (0 on missing field)."""
        resp = self._post("businesses/stats", {"filters": filters})
        return int(resp.get("total_results") or 0)

    def fetch_businesses(self, filters: Dict[str, Any], size: int = 100,
                         page_size: int = 100,
                         exclude: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        """Discover businesses matching ``filters``; paginate up to ``size``.

        Returns the concatenated ``data`` list (each item carries a
        ``business_id``).
        """
        size = max(1, size)
        # Explorium rejects size < page_size; clamp for small targets.
        page_size = max(1, min(page_size, 100, size))
        collected: List[Dict[str, Any]] = []
        page = 1
        total_pages: Optional[int] = None
        while len(collected) < size:
            body = {
                "mode": "full",
                "size": size,
                "page_size": page_size,
                "page": page,
                "filters": filters,
                "exclude": exclude or [],
            }
            resp = self._post("businesses", body)
            data = resp.get("data") or []
            collected.extend(data)
            if total_pages is None:
                total_pages = (resp.get("total_pages")
                               or resp.get("total_page_count"))
            if not data:
                break
            if total_pages is not None and page >= total_pages:
                break
            page += 1
        return collected[:size]

    def fetch_businesses_page(self, filters: Dict[str, Any], page: int = 1,
                              page_size: int = 50,
                              exclude: Optional[List[str]] = None
                              ) -> List[Dict[str, Any]]:
        """Fetch ONE page of businesses (at most ``page_size`` records).

        COST: ``/businesses`` is billed PER RECORD returned (it is NOT free —
        that earlier assumption was the pipeline's #1 cost driver). So the
        orchestrator discovers lazily, one page at a time, only when the funnel
        actually needs more companies, instead of pulling the whole pool up
        front. ``size`` is sent equal to ``page_size`` to satisfy Explorium's
        ``size >= page_size`` rule.
        """
        page_size = max(1, min(page_size, 100))
        body = {
            "mode": "full",
            "size": page_size,
            "page_size": page_size,
            "page": max(1, page),
            "filters": filters,
            "exclude": exclude or [],
        }
        resp = self._post("businesses", body)
        return resp.get("data") or []

    def enrich_businesses(self, business_ids: List[str]) -> List[Dict[str, Any]]:
        """Firmographics bulk-enrich in batches of 50.

        Returns the concatenated ``data`` list (each item is
        ``{"business_id": ..., "data": {..}}``). The caller writes
        ``{"data": <this list>}`` to a file for explorium_to_record.py.
        """
        out: List[Dict[str, Any]] = []
        for batch in _chunked(list(business_ids), 50):
            resp = self._post("businesses/firmographics/bulk_enrich",
                              {"business_ids": batch})
            out.extend(resp.get("data") or [])
        return out

    # ------------------------------------------------------------------
    # Prospects
    # ------------------------------------------------------------------
    def fetch_prospects(self, business_ids: List[str],
                        job_levels: Optional[List[str]] = None,
                        job_departments: Optional[List[str]] = None,
                        size: int = 100,
                        page_size: int = 100) -> List[Dict[str, Any]]:
        """Fetch prospects for the given companies; paginate up to ``size``.

        Returns the concatenated ``data`` list (each item carries
        prospect_id, full_name, job_title, business_id, country_name).
        """
        size = max(1, size)
        # Explorium rejects size < page_size; clamp for small batches.
        page_size = max(1, min(page_size, 100, size))
        filters: Dict[str, Any] = {"business_id": {"values": list(business_ids)}}
        if job_levels:
            filters["job_level"] = {"values": job_levels}
        if job_departments:
            filters["job_department"] = {"values": job_departments}

        collected: List[Dict[str, Any]] = []
        page = 1
        total_pages: Optional[int] = None
        while len(collected) < size:
            body = {
                "mode": "full",
                "size": size,
                "page_size": page_size,
                "page": page,
                "filters": filters,
            }
            resp = self._post("prospects", body)
            data = resp.get("data") or []
            collected.extend(data)
            if total_pages is None:
                total_pages = (resp.get("total_pages")
                               or resp.get("total_page_count"))
            if not data:
                break
            if total_pages is not None and page >= total_pages:
                break
            page += 1
        return collected[:size]

    def enrich_prospect_contacts(self, prospect_ids: List[str]
                                 ) -> Dict[str, Dict[str, Any]]:
        """Bulk-enrich contact info (email + phone) in batches of 50.

        Returns ``{prospect_id: {"email": ..., "phone": ...}}``.
        """
        out: Dict[str, Dict[str, Any]] = {}
        for batch in _chunked(list(prospect_ids), 50):
            resp = self._post("prospects/contacts_information/bulk_enrich",
                              {"prospect_ids": batch})
            for item in resp.get("data") or []:
                pid = item.get("prospect_id")
                data = item.get("data") or {}
                phone = data.get("mobile_phone")
                if not phone:
                    numbers = data.get("phone_numbers") or []
                    if numbers and isinstance(numbers, list):
                        phone = (numbers[0] or {}).get("phone_number")
                out[pid] = {
                    "email": data.get("professions_email"),
                    "phone": phone,
                }
        return out

    def enrich_prospect_profiles(self, prospect_ids: List[str]
                                 ) -> Dict[str, Dict[str, Any]]:
        """Bulk-enrich profile info (linkedin + name/title) in batches of 50.

        Returns ``{prospect_id: {"linkedin_url", "full_name", "job_title"}}``.
        """
        out: Dict[str, Dict[str, Any]] = {}
        for batch in _chunked(list(prospect_ids), 50):
            resp = self._post("prospects/profiles/bulk_enrich",
                              {"prospect_ids": batch})
            for item in resp.get("data") or []:
                pid = item.get("prospect_id")
                data = item.get("data") or {}
                out[pid] = {
                    "linkedin_url": data.get("linkedin"),
                    "full_name": data.get("full_name"),
                    "job_title": data.get("job_title"),
                }
        return out


# ---------------------------------------------------------------------------
# Country name -> ISO-3166-alpha-2 (lowercase). The 8 locked ICP countries
# plus a broad set of common geographies for one-off pilots.
# ---------------------------------------------------------------------------
COUNTRY_CODES: Dict[str, str] = {
    # --- the 8 locked ICP countries (with aliases) ---
    "spain": "es",
    "united kingdom": "gb", "uk": "gb", "great britain": "gb",
    "england": "gb", "scotland": "gb", "wales": "gb",
    "italy": "it",
    "israel": "il",
    "germany": "de",
    "switzerland": "ch",
    "romania": "ro",
    "greece": "gr",
    # --- broad set of common countries ---
    "mexico": "mx",
    "portugal": "pt",
    "france": "fr",
    "netherlands": "nl", "the netherlands": "nl", "holland": "nl",
    "belgium": "be",
    "poland": "pl",
    "united states": "us", "united states of america": "us",
    "usa": "us", "u.s.a.": "us", "u.s.": "us", "america": "us",
    "canada": "ca",
    "brazil": "br",
    "ireland": "ie",
    "austria": "at",
    "sweden": "se",
    "denmark": "dk",
    "norway": "no",
    "finland": "fi",
    "czech republic": "cz", "czechia": "cz",
    "hungary": "hu",
    "turkey": "tr", "turkiye": "tr", "türkiye": "tr",
    "slovakia": "sk",
    "slovenia": "si",
    "croatia": "hr",
    "bulgaria": "bg",
    "serbia": "rs",
    "ukraine": "ua",
    "russia": "ru",
    "estonia": "ee",
    "latvia": "lv",
    "lithuania": "lt",
    "luxembourg": "lu",
    "iceland": "is",
    "cyprus": "cy",
    "malta": "mt",
    "argentina": "ar",
    "chile": "cl",
    "colombia": "co",
    "peru": "pe",
    "uruguay": "uy",
    "australia": "au",
    "new zealand": "nz",
    "japan": "jp",
    "south korea": "kr", "korea": "kr",
    "china": "cn",
    "india": "in",
    "indonesia": "id",
    "singapore": "sg",
    "malaysia": "my",
    "thailand": "th",
    "vietnam": "vn",
    "philippines": "ph",
    "south africa": "za",
    "egypt": "eg",
    "morocco": "ma",
    "saudi arabia": "sa",
    "united arab emirates": "ae", "uae": "ae",
    "qatar": "qa",
}


def country_to_code(name: Optional[str]) -> Optional[str]:
    """Map an English country name to ISO-3166-alpha-2 (lowercase), or None."""
    if not name:
        return None
    return COUNTRY_CODES.get(name.strip().lower())
