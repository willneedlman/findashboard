"""SEC Exhibit 21 (Significant Subsidiaries) parser for the Supply Chain Map's
VERIFIED tier. A company's Exhibit 21 is its own disclosure of what it owns —
deterministic, not inferred like the Veridion tag-similarity graph — so it
folds into VERIFIED rather than sitting behind a separate filter tier.

Reuses the CIK lookup already built for the public-evidence panel
(logistics.public_enrichment._sec_cik) instead of re-fetching the SEC ticker
index a third time.
"""
from __future__ import annotations

import logging
import re

import requests
from bs4 import BeautifulSoup

try:
    from disk_cache import disk_get, disk_set
except ImportError:  # pragma: no cover
    def disk_get(_key): return None
    def disk_set(_key, _value, ttl=0): pass

from logistics.public_enrichment import _sec_cik

logger = logging.getLogger(__name__)
_SEC_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_TIMEOUT = 10

# EDGAR filers name this exhibit inconsistently — "ex21.htm", "ex-21.1.htm",
# "exh_21-10kfy25.htm" have all been observed live. Matches "ex", an optional
# separator, an optional "h", another optional separator, then "21".
_EX21_RE = re.compile(r"ex[_\-]?h?[_\-]?21", re.IGNORECASE)
_HEADER_WORDS = ("name of subsidiary", "jurisdiction", "state or")


def _latest_10k_filing(cik: str) -> dict | None:
    """Most recent 10-K's accession number, filing date, and registrant name."""
    try:
        r = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json", headers=_SEC_UA, timeout=_TIMEOUT)
        r.raise_for_status()
        data = r.json()
        recent = data.get("filings", {}).get("recent", {})
        for form, date, accession in zip(
            recent.get("form", []), recent.get("filingDate", []), recent.get("accessionNumber", []),
        ):
            if form == "10-K":
                return {"accession": accession, "date": date, "registrant": data.get("name")}
    except Exception as exc:
        logger.warning("edgar_exhibit21: submissions fetch failed for CIK %s: %s", cik, exc)
    return None


def _exhibit21_document(cik: str, accession: str) -> str | None:
    """Filename of the Exhibit 21 document within a filing's folder index."""
    accession_nohyphen = accession.replace("-", "")
    try:
        r = requests.get(
            f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_nohyphen}/index.json",
            headers=_SEC_UA, timeout=_TIMEOUT,
        )
        r.raise_for_status()
        for item in r.json().get("directory", {}).get("item", []):
            name = str(item.get("name", ""))
            if _EX21_RE.search(name):
                return name
    except Exception as exc:
        logger.warning("edgar_exhibit21: index fetch failed for CIK %s accession %s: %s", cik, accession, exc)
    return None


def _parse_subsidiaries(html: str) -> list[dict]:
    """Subsidiary name + jurisdiction pairs from an Exhibit 21 HTML table."""
    soup = BeautifulSoup(html, "html.parser")
    out: list[dict] = []
    seen: set[str] = set()
    for row in soup.find_all("tr"):
        cells = [c.get_text(" ", strip=True) for c in row.find_all(["td", "th"])]
        cells = [c for c in cells if c]
        if len(cells) < 2:
            continue
        name, jurisdiction = cells[0], cells[1]
        low_name, low_jur = name.lower(), jurisdiction.lower()
        # Header rows show up mid-table too (e.g. a "Domestic Subsidiaries" /
        # "State or Jurisdiction..." banner row splitting the list in two).
        if not name or any(w in low_name for w in _HEADER_WORDS) or any(w in low_jur for w in _HEADER_WORDS):
            continue
        if re.fullmatch(r"[\d.\s]*", name):   # stray row numbering, no real name
            continue
        key = name.upper()
        if key in seen:
            continue
        seen.add(key)
        out.append({"name": name, "jurisdiction": jurisdiction or None})
    return out


def subsidiaries_for_ticker(ticker: str) -> dict:
    """Cached significant-subsidiary list for a ticker, from its latest 10-K
    Exhibit 21. Never raises — callers get {'available': False} on any
    failure (no CIK match, no 10-K yet, exhibit not found, fetch/parse error)
    and fall back to other sources, same contract as the rest of this module."""
    symbol = (ticker or "").strip().upper()
    cache_key = f"edgar_ex21:v2:{symbol}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached

    empty = {"available": False, "registrant": None, "filing_date": None, "url": None, "subsidiaries": []}
    result = dict(empty)
    try:
        cik = _sec_cik(symbol)
        if cik:
            filing = _latest_10k_filing(cik)
            if filing:
                doc = _exhibit21_document(cik, filing["accession"])
                if doc:
                    accession_nohyphen = filing["accession"].replace("-", "")
                    url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession_nohyphen}/{doc}"
                    r = requests.get(url, headers=_SEC_UA, timeout=_TIMEOUT)
                    r.raise_for_status()
                    subs = _parse_subsidiaries(r.text)
                    result = {
                        "available": bool(subs),
                        "registrant": filing["registrant"],
                        "filing_date": filing["date"],
                        "url": url,
                        "subsidiaries": subs[:60],   # cap the fan-out into the peer graph
                    }
                else:
                    result = {**empty, "registrant": filing["registrant"], "filing_date": filing["date"]}
    except Exception as exc:
        logger.warning("edgar_exhibit21: subsidiary fetch failed for %s: %s", symbol, exc)
        result = dict(empty)

    # Exhibit 21 only changes once a year with the next 10-K — cache generously.
    disk_set(cache_key, result, ttl=30 * 24 * 3600)
    return result
