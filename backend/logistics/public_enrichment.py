"""Free, attributable public-record evidence for Supply Chain Map companies.

This module deliberately keeps legal-entity and filing records separate from the
Veridion similarity graph.  Neither public record proves a supplier, customer,
or transaction relationship.
"""
from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import requests

try:
    from disk_cache import disk_get, disk_set
except ImportError:  # pragma: no cover
    def disk_get(_key): return None
    def disk_set(_key, _value, ttl=0): pass

logger = logging.getLogger(__name__)
_SEC_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_TIMEOUT = 10


def _normalise(value: str) -> str:
    value = re.sub(r"[^a-z0-9 ]", " ", value.lower())
    value = re.sub(r"\b(incorporated|inc|corporation|corp|company|co|ltd|limited|plc|sa|nv|ag|holdings?|group|the)\b", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _source(id_: str, label: str, status: str, **values) -> dict:
    return {"id": id_, "label": label, "status": status, "checked_at": datetime.now(timezone.utc).date().isoformat(), **values}


def _sec_cik(ticker: str) -> str | None:
    cache_key = f"public_evidence:sec_cik:v1:{ticker}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached or None
    try:
        data = requests.get("https://www.sec.gov/files/company_tickers.json", headers=_SEC_UA, timeout=_TIMEOUT).json()
        cik = next((str(row["cik_str"]).zfill(10) for row in data.values() if str(row.get("ticker", "")).upper() == ticker), None)
        disk_set(cache_key, cik or "", ttl=7 * 24 * 3600)
        return cik
    except Exception as exc:
        logger.warning("public evidence SEC CIK lookup failed for %s: %s", ticker, exc)
        return None


def _sec_record(ticker: str) -> dict:
    cik = _sec_cik(ticker)
    if not cik:
        return _source("sec", "SEC EDGAR", "unavailable", message="No SEC registrant found for this ticker.")
    try:
        data = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json", headers=_SEC_UA, timeout=_TIMEOUT).json()
        recent = data.get("filings", {}).get("recent", {})
        filing = next((
            {"form": form, "date": date, "accession": accession, "document": document}
            for form, date, accession, document in zip(
                recent.get("form", []), recent.get("filingDate", []), recent.get("accessionNumber", []), recent.get("primaryDocument", [])
            ) if form in {"10-K", "20-F", "40-F"} and document
        ), None)
        filing_url = None
        if filing:
            filing_url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{filing['accession'].replace('-', '')}/{filing['document']}"
        return _source("sec", "SEC EDGAR", "available", as_of=filing.get("date") if filing else None, url=filing_url, facts={
            "registrant": data.get("name"),
            "sic": data.get("sicDescription") or data.get("sic"),
            "incorporation": data.get("stateOfIncorporationDescription") or data.get("stateOfIncorporation"),
            "annual_filing": f"{filing['form']} filed {filing['date']}" if filing else "Annual filing unavailable",
        })
    except Exception as exc:
        logger.warning("public evidence SEC record failed for %s: %s", ticker, exc)
        return _source("sec", "SEC EDGAR", "unavailable", message="SEC EDGAR is temporarily unavailable.")


def _gleif_record(company_name: str) -> dict:
    if not company_name:
        return _source("gleif", "GLEIF Legal Entity Identifier", "unavailable", message="Company name unavailable for legal-entity lookup.")
    try:
        response = requests.get(
            "https://api.gleif.org/api/v1/lei-records",
            params={"filter[entity.legalName]": company_name, "page[size]": 10},
            timeout=_TIMEOUT,
        )
        response.raise_for_status()
        candidates = response.json().get("data", [])
        match = next((item for item in candidates if _normalise(item.get("attributes", {}).get("entity", {}).get("legalName", {}).get("name", "")) == _normalise(company_name)), candidates[0] if candidates else None)
        if not match:
            return _source("gleif", "GLEIF Legal Entity Identifier", "unavailable", message="No matching legal-entity record found.")
        attrs = match.get("attributes", {})
        entity = attrs.get("entity", {})
        registration = attrs.get("registration", {})
        address = entity.get("headquartersAddress", {})
        return _source("gleif", "GLEIF Legal Entity Identifier", "available", as_of=registration.get("lastUpdateDate", "")[:10] or None, url=f"https://search.gleif.org/#/record/{attrs.get('lei')}", facts={
            "legal_name": entity.get("legalName", {}).get("name"),
            "lei": attrs.get("lei"),
            "jurisdiction": entity.get("jurisdiction"),
            "headquarters": ", ".join(filter(None, [address.get("city"), address.get("country")])),
            "record_status": registration.get("status"),
        })
    except Exception as exc:
        logger.warning("public evidence GLEIF record failed for %s: %s", company_name, exc)
        return _source("gleif", "GLEIF Legal Entity Identifier", "unavailable", message="GLEIF is temporarily unavailable.")


def _usaspending_record(company_name: str) -> dict:
    """Identify a federal-award recipient; this is evidence of government sales only."""
    try:
        response = requests.post(
            "https://api.usaspending.gov/api/v2/autocomplete/recipient/",
            json={"search_text": company_name},
            timeout=6,
        )
        response.raise_for_status()
        results = response.json().get("results", [])
        match = next((
            item for item in results
            if _normalise(str(item.get("recipient_name") or item.get("title") or item.get("name") or "")) == _normalise(company_name)
        ), None)
        if not match:
            return _source("usaspending", "USAspending.gov", "unavailable", message="No matching federal-award recipient found.")
        recipient = str(match.get("recipient_name") or match.get("title") or match.get("name") or company_name)
        uei = match.get("uei") or match.get("hash") or match.get("id")
        return _source("usaspending", "USAspending.gov", "available", url="https://www.usaspending.gov/search", facts={
            "recipient": recipient,
            "uei": str(uei) if uei else None,
            "evidence": "Listed federal-award recipient; this indicates government sales, not commercial buyers.",
        })
    except Exception as exc:
        logger.warning("public evidence USAspending record failed for %s: %s", company_name, exc)
        return _source("usaspending", "USAspending.gov", "unavailable", message="USAspending.gov did not respond; no government-buyer data is shown.")


def get_public_company_evidence(ticker: str, company_name: str = "") -> dict:
    """Return cached, source-labelled public evidence for one listed company."""
    symbol = ticker.strip().upper()
    cache_key = f"public_evidence:v3:{symbol}:{_normalise(company_name)}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached
    if company_name:
        with ThreadPoolExecutor(max_workers=3) as pool:
            sec_future = pool.submit(_sec_record, symbol)
            gleif_future = pool.submit(_gleif_record, company_name)
            usaspending_future = pool.submit(_usaspending_record, company_name)
            sec = sec_future.result()
            gleif = gleif_future.result()
            usaspending = usaspending_future.result()
        entity_name = company_name
    else:
        sec = _sec_record(symbol)
        entity_name = sec.get("facts", {}).get("registrant") or symbol
        with ThreadPoolExecutor(max_workers=2) as pool:
            gleif = pool.submit(_gleif_record, entity_name).result()
            usaspending = pool.submit(_usaspending_record, entity_name).result()
    payload = {
        "ticker": symbol,
        "company_name": entity_name,
        "sources": [sec, gleif, usaspending],
        "disclaimer": "Public filings and entity records identify the company; they do not establish supplier, buyer, or transaction relationships.",
    }
    disk_set(cache_key, payload, ttl=24 * 3600)
    return payload
