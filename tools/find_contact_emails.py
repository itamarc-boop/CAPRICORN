"""Find and verify missing contact emails. Free — no API keys.

Three layers, cheapest first:
1. HARVEST: regex-scan the page text we already fetched (website_research.pages
   in the companies file) plus a live fetch of common contact/legal pages, for
   any @company-domain addresses. Personal addresses reveal the company's email
   pattern; generic ones (info@, ventas@) become the company fallback email.
2. PATTERN: infer the pattern (first / first.last / f.last / firstlast) from
   every known-good address at the domain (our enriched contacts + harvested),
   then generate candidates for each contact who has a name but no email.
   Handles diacritics, "(nickname)" in the first name, and Spanish compound
   surnames (first surname is the email surname).
3. VERIFY (SMTP): resolve the domain's MX, open one polite connection, detect
   catch-all (random localpart accepted -> can't verify mailboxes), then RCPT
   each candidate. 250 on a non-catch-all server = valid; 5xx = rejected.
   Null sender (MAIL FROM:<>) per RFC verification practice; one connection
   per domain; short timeouts.

Labels written into the contact 'email' field, honest per client style:
   "addr (SMTP-verified)"  "addr (catch-all)"  "addr (best guess, unverified)"
A company-level fallback like info@ goes into contact['company_email'].

Usage:
    python3 tools/find_contact_emails.py \
        --companies .tmp/iter4_judged.json --contacts .tmp/iter4_contacts.json \
        --out .tmp/iter4_contacts.json
"""
from __future__ import annotations

import argparse
import json
import random
import re
import smtplib
import socket
import string
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from research_company_website import _fetch  # noqa: E402  (same UA/timeouts)

GENERIC_LOCALPARTS = {
    "info", "contact", "contacto", "ventas", "sales", "hello", "hola", "admin",
    "office", "enquiries", "inquiries", "mail", "comercial", "pedidos",
    "atencioncliente", "administracion", "rrhh", "marketing", "export", "hr",
    "support", "soporte", "compras", "purchasing", "accounts", "billing",
    "webmaster", "noreply", "no-reply", "privacy", "legal", "gdpr", "lopd",
}
CONTACT_PATHS = ["contact", "contact-us", "contacto", "contacta", "contactos",
                 "aviso-legal", "legal", "privacy-policy", "politica-privacidad",
                 "impressum", "about", "about-us", "quienes-somos", "empresa"]
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
SMTP_TIMEOUT = 15
# A real, MX-backed HELO name and sender. Many mail servers (Mimecast, IONOS,
# cPanel) reject the RFC null sender <> outright as anti-spam, which makes them
# look unverifiable. A sender on a domain with valid DNS passes their check; we
# only ever issue RCPT (never DATA), so no mail is sent.
HELO_NAME = "oktopost.com"
PROBE_SENDER = "revopsadmin@oktopost.com"


def _norm_token(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z]", "", s.lower())


def name_parts(full_name: str) -> Tuple[List[str], List[str]]:
    """Return (first-name candidates, surname candidates).

    'Manandita (Nancy) Kainth' -> firsts [nancy, manandita], lasts [kainth]
    'Marc Ceron Castello'      -> firsts [marc], lasts [ceron, castello]
    """
    nick = None
    m = re.search(r"\(([^)]+)\)", full_name)
    if m:
        nick = m.group(1)
        full_name = re.sub(r"\([^)]*\)", " ", full_name)
    tokens = [_norm_token(t) for t in full_name.split() if _norm_token(t)]
    tokens = [t for t in tokens if len(t) > 1]
    if not tokens:
        return [], []
    firsts = [tokens[0]]
    if nick and _norm_token(nick) and _norm_token(nick) != tokens[0]:
        firsts.insert(0, _norm_token(nick))
    lasts = tokens[1:] or tokens[:1]
    return firsts, lasts


PATTERNS = ["first", "first.last", "f.last", "firstlast", "flast", "last",
            "first_last", "first.l"]


def apply_pattern(pattern: str, first: str, last: str) -> Optional[str]:
    if not first:
        return None
    table = {
        "first": first,
        "first.last": f"{first}.{last}" if last else None,
        "f.last": f"{first[0]}.{last}" if last else None,
        "firstlast": f"{first}{last}" if last else None,
        "flast": f"{first[0]}{last}" if last else None,
        "last": last or None,
        "first_last": f"{first}_{last}" if last else None,
        "first.l": f"{first}.{last[0]}" if last else None,
    }
    return table.get(pattern)


def detect_pattern(local: str, firsts: List[str], lasts: List[str]) -> Optional[str]:
    for pattern in PATTERNS:
        for f in firsts:
            for l in lasts or [""]:
                if apply_pattern(pattern, f, l) == local:
                    return pattern
    return None


# ---------------------------------------------------------------------------
# Layer 1 — harvest
# ---------------------------------------------------------------------------

def harvest_domain_emails(company: Dict, domain: str) -> Set[str]:
    """Emails @domain from already-fetched page text + live contact pages."""
    found: Set[str] = set()
    pages = (company.get("website_research") or {}).get("pages") or []
    blob = " ".join(p.get("text", "") for p in pages)
    base = (company.get("website") or f"https://{domain}").rstrip("/")
    for path in CONTACT_PATHS:
        try:
            html = _fetch(f"{base}/{path}")
            if html:
                blob += " " + html
        except Exception:
            continue
    for email in EMAIL_RE.findall(blob):
        email = email.lower().rstrip(".")
        if email.split("@", 1)[1] == domain:
            found.add(email)
    return found


# ---------------------------------------------------------------------------
# Layer 3 — SMTP verification
# ---------------------------------------------------------------------------

def mx_hosts(domain: str) -> List[str]:
    try:
        out = subprocess.run(["nslookup", "-type=mx", domain],
                             capture_output=True, text=True, timeout=10).stdout
        hosts = []
        for line in out.splitlines():
            if "mail exchanger" in line:
                prio_host = line.split("=")[-1].strip().split()
                if prio_host:
                    hosts.append((int(prio_host[0]) if prio_host[0].isdigit()
                                  else 99, prio_host[-1].rstrip(".")))
        return [h for _, h in sorted(hosts)]
    except Exception:
        return []


class DomainVerifier:
    """One SMTP session per domain; detects catch-all once."""

    def __init__(self, domain: str):
        self.domain = domain
        self.hosts = mx_hosts(domain)
        self.catch_all: Optional[bool] = None
        self.reachable = bool(self.hosts)

    def _rcpt(self, address: str, _retry: bool = True) -> Optional[bool]:
        """True accepted, False rejected, None unknown/blocked.

        On a 451 greylist, wait and retry once.
        """
        for host in self.hosts[:2]:
            try:
                with smtplib.SMTP(host, 25, local_hostname=HELO_NAME,
                                  timeout=SMTP_TIMEOUT) as s:
                    s.ehlo_or_helo_if_needed()
                    code_m, _ = s.mail(PROBE_SENDER)
                    if code_m >= 400:
                        return None
                    code, _ = s.rcpt(address)
                    if code in (250, 251):
                        return True
                    if code == 451 and _retry:   # greylisting
                        time.sleep(8)
                        return self._rcpt(address, _retry=False)
                    if 500 <= code < 560:
                        return False
                    return None
            except (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError,
                    socket.timeout, OSError):
                continue
            except smtplib.SMTPResponseException as e:
                if e.smtp_code == 451 and _retry:
                    time.sleep(8)
                    return self._rcpt(address, _retry=False)
                if 500 <= e.smtp_code < 560:
                    return False
                return None
        return None

    def is_catch_all(self) -> Optional[bool]:
        if self.catch_all is None and self.reachable:
            probe = ("zx" + "".join(random.choices(string.ascii_lowercase, k=14))
                     + "@" + self.domain)
            self.catch_all = self._rcpt(probe)
            time.sleep(0.5)
        return self.catch_all

    def verify(self, address: str) -> str:
        """'valid' | 'invalid' | 'catch-all' | 'unknown'"""
        if not self.reachable:
            return "unknown"
        ca = self.is_catch_all()
        if ca is True:
            return "catch-all"
        result = self._rcpt(address)
        time.sleep(0.5)
        if result is True:
            return "valid"
        if result is False:
            return "invalid"
        return "unknown"


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def find_emails(companies: List[Dict], contacts: Dict[str, List[Dict]],
                only_qualified: bool = True) -> Dict[str, int]:
    stats = {"resolved": 0, "guessed": 0, "company_fallback": 0, "none": 0}
    by_id = {c["explorium_business_id"]: c for c in companies}

    for biz, people in contacts.items():
        company = by_id.get(biz)
        if company is None:
            continue
        if only_qualified and not (company.get("score") or {}).get("qualified"):
            continue
        needs = [p for p in people if not (p.get("email") or "").strip()]
        if not needs:
            continue
        domain = urlparse(company.get("website") or "").netloc.lower()
        domain = domain.replace("www.", "")
        if not domain:
            continue
        print(f"--- {company.get('name')} ({domain})", file=sys.stderr)

        harvested = harvest_domain_emails(company, domain)
        generic = sorted(e for e in harvested
                         if e.split("@")[0] in GENERIC_LOCALPARTS)
        personal = sorted(harvested - set(generic))
        if harvested:
            print(f"    harvested: {sorted(harvested)}", file=sys.stderr)

        # learn the pattern from every known-good address at this domain
        known_patterns: List[str] = []
        known_addrs = personal[:]
        for p in people:
            addr = (p.get("email") or "").split(" ")[0]
            if addr.endswith("@" + domain):
                known_addrs.append(addr)
        for addr in known_addrs:
            local = addr.split("@")[0]
            firsts, lasts = name_parts(" ".join(local.replace(".", " ")
                                                .replace("_", " ").split()))
            # match against every person we know at the company
            for p in people:
                fs, ls = name_parts(p.get("full_name") or "")
                pat = detect_pattern(local, fs, ls)
                if pat:
                    known_patterns.append(pat)
        # dedupe, keep order
        seen = set()
        known_patterns = [p for p in known_patterns
                          if not (p in seen or seen.add(p))]
        if known_patterns:
            print(f"    pattern(s) learned: {known_patterns}", file=sys.stderr)

        verifier = DomainVerifier(domain)
        for person in needs:
            firsts, lasts = name_parts(person.get("full_name") or "")
            if not firsts:
                continue
            ordered = known_patterns + [p for p in PATTERNS
                                        if p not in known_patterns]
            candidates: List[str] = []
            for pat in ordered:
                for f in firsts:
                    for l in (lasts or [""]):
                        local = apply_pattern(pat, f, l)
                        if local and f"{local}@{domain}" not in candidates:
                            candidates.append(f"{local}@{domain}")
            resolved = False
            catch_all_best: Optional[str] = None
            for i, cand in enumerate(candidates[:10]):
                status = verifier.verify(cand)
                if status == "valid":
                    person["email"] = f"{cand} (SMTP-verified)"
                    person["email_source"] = "pattern + SMTP verification"
                    stats["resolved"] += 1
                    resolved = True
                    print(f"    {person['full_name']}: {cand} VALID",
                          file=sys.stderr)
                    break
                if status == "catch-all" and catch_all_best is None:
                    catch_all_best = cand   # best-pattern guess on catch-all
                    break                   # no point probing more candidates
                if status == "unknown" and i >= 3:
                    break
            if not resolved and catch_all_best and known_patterns:
                person["email"] = f"{catch_all_best} (catch-all, best guess)"
                person["email_source"] = ("company pattern on a catch-all "
                                          "domain — unverifiable by SMTP")
                stats["guessed"] += 1
                print(f"    {person['full_name']}: {catch_all_best} "
                      f"catch-all guess", file=sys.stderr)
            elif not resolved:
                if generic:
                    person["company_email"] = generic[0]
                    stats["company_fallback"] += 1
                    print(f"    {person['full_name']}: no personal email; "
                          f"company {generic[0]}", file=sys.stderr)
                else:
                    stats["none"] += 1
                    print(f"    {person['full_name']}: nothing verifiable",
                          file=sys.stderr)
    return stats


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--companies", required=True)
    parser.add_argument("--contacts", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--all", action="store_true",
                        help="include non-qualified companies too")
    args = parser.parse_args()

    companies = json.loads(Path(args.companies).read_text())
    contacts = json.loads(Path(args.contacts).read_text())
    stats = find_emails(companies, contacts, only_qualified=not args.all)
    Path(args.out).write_text(json.dumps(contacts, indent=2, ensure_ascii=False))
    print(f"\nemail finding: {stats}", file=sys.stderr)
