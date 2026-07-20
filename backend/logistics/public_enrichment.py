"""Free, attributable public-record evidence for Supply Chain Map companies.

This module deliberately keeps legal-entity and filing records separate from the
Veridion similarity graph.  Neither public record proves a supplier, customer,
or transaction relationship.
"""
from __future__ import annotations

import logging
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone

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
            "evidence": "Listed federal-award recipient. This indicates government sales, not commercial buyers.",
        })
    except Exception as exc:
        logger.warning("public evidence USAspending record failed for %s: %s", company_name, exc)
        return _source("usaspending", "USAspending.gov", "unavailable", message="USAspending.gov did not respond. No government-buyer data is shown.")


def _most_recent_complete_fiscal_year() -> tuple[str, str]:
    """Federal FY (Oct 1 - Sep 30) start/end dates for the most recently
    *completed* fiscal year as of today."""
    today = date.today()
    fy_end_year = today.year if today.month >= 10 else today.year - 1
    return f"{fy_end_year - 1}-10-01", f"{fy_end_year}-09-30"


def _strip_sec_suffix(company_name: str) -> str:
    """SEC registrant names carry a "/DE", "/MD", ... state-of-incorporation
    suffix to disambiguate ticker collisions (e.g. "QUALCOMM INC/DE") that
    USAspending's recipient names never have — left in place, the exact-ish
    phrase match returns nothing. Verified live: stripping it is the
    difference between a real match and a false negative."""
    return re.sub(r"/[A-Z]{2}$", "", company_name).strip()


def usaspending_agency_awards(company_name: str, limit: int = 5) -> list[dict]:
    """Federal contract $ by awarding agency for the most recent complete
    fiscal year, keyword-matched on the company's name via USAspending's
    `recipient_search_text` filter (NOT `keywords`, which searches award
    descriptions rather than the recipient — verified against the live API).

    This is directional, not a confirmed contractor relationship: there's no
    UEI-based entity resolution here (the public autocomplete endpoint no
    longer reliably returns a UEI — see _usaspending_record above), so a
    generic company name can pick up a same-named but unrelated recipient.
    Near-zero/negative net amounts (contract modifications, deobligations)
    are dropped as noise rather than shown as a "relationship". Cached a
    week — award data for a closed fiscal year doesn't move fast, and this
    endpoint has been observed to time out on large recipients."""
    if not company_name:
        return []
    company_name = _strip_sec_suffix(company_name)
    start, end = _most_recent_complete_fiscal_year()
    cache_key = f"usaspending_agency:v1:{_normalise(company_name)}:{start}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached
    try:
        response = requests.post(
            "https://api.usaspending.gov/api/v2/search/spending_by_category/awarding_agency/",
            json={
                "filters": {
                    "recipient_search_text": [company_name],
                    "time_period": [{"start_date": start, "end_date": end}],
                },
                "limit": limit,
            },
            timeout=_TIMEOUT,
        )
        response.raise_for_status()
        rows = response.json().get("results", [])
    except Exception as exc:
        logger.warning("usaspending agency breakdown failed for %s: %s", company_name, exc)
        return []   # transient failure (incl. timeout) — don't cache, retry next call

    out = []
    for row in rows:
        amount = row.get("amount")
        if amount is None or amount < 1000:
            continue
        out.append({
            "agency": row.get("name"),
            "agency_code": row.get("code"),
            "amount": amount,
            "fiscal_year_start": start,
            "fiscal_year_end": end,
        })
    disk_set(cache_key, out, ttl=7 * 24 * 3600)
    return out


def usaspending_subcontracts(company_name: str, limit: int = 10) -> list[dict]:
    """Federal subcontracts where this company is the SUB-recipient, grouped
    by the prime contractor that hired them, for the most recent complete
    fiscal year. This is the other half of the B2G picture from
    usaspending_agency_awards above: that covers direct-to-agency prime
    awards; this covers work flowing through another company's prime
    contract — the "Prime-to-Subcontractor" relationship structure.

    Uses `spending_level: "subawards"` (not the deprecated `subawards: true`
    flag — verified against the live API, which now rejects the old form's
    field names outright) and `recipient_search_text`, which in subaward mode
    matches the SUB-awardee name, confirmed live against a real prime/sub
    pair. Same caveats as the agency-award function apply (keyword-matched,
    no UEI resolution) plus one more: subaward reporting compliance is
    uneven — primes only have to report subawards over $30k via a separate
    system (FSRS), and not all do. Absence of a row here does not mean no
    subcontract relationship exists. Cached a week, same rationale as above."""
    if not company_name:
        return []
    company_name = _strip_sec_suffix(company_name)
    start, end = _most_recent_complete_fiscal_year()
    cache_key = f"usaspending_subs:v1:{_normalise(company_name)}:{start}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached
    try:
        response = requests.post(
            "https://api.usaspending.gov/api/v2/search/spending_by_award/",
            json={
                "filters": {
                    "recipient_search_text": [company_name],
                    "time_period": [{"start_date": start, "end_date": end}],
                    "award_type_codes": ["A", "B", "C", "D"],   # contracts only, not grants
                },
                "fields": [
                    "Sub-Award ID", "Sub-Awardee Name", "Sub-Award Date", "Sub-Award Amount",
                    "Awarding Agency", "Prime Award ID", "Prime Recipient Name", "Sub-Award Description",
                ],
                "spending_level": "subawards",
                "limit": 100,
            },
            timeout=_TIMEOUT,
        )
        response.raise_for_status()
        rows = response.json().get("results", [])
    except Exception as exc:
        logger.warning("usaspending subcontract search failed for %s: %s", company_name, exc)
        return []   # transient failure (incl. timeout) — don't cache, retry next call

    # Group by prime — a single prime often reports many small sub-awards
    # across the year, and listing each one separately reads as duplicate
    # noise (the exact failure mode fixed in the Supply Chain Map tags).
    by_prime: dict[str, dict] = {}
    for row in rows:
        prime = row.get("Prime Recipient Name")
        amount = row.get("Sub-Award Amount")
        if not prime or amount is None or amount <= 0:
            continue
        entry = by_prime.setdefault(prime, {
            "prime": prime, "total_amount": 0.0, "count": 0, "latest_date": None,
            "agency": row.get("Awarding Agency"), "description": row.get("Sub-Award Description"),
            "fiscal_year_start": start, "fiscal_year_end": end,
        })
        entry["total_amount"] += amount
        entry["count"] += 1
        d = row.get("Sub-Award Date")
        if d and (entry["latest_date"] is None or d > entry["latest_date"]):
            entry["latest_date"] = d
            entry["description"] = row.get("Sub-Award Description") or entry["description"]

    out = sorted(by_prime.values(), key=lambda e: e["total_amount"], reverse=True)[:limit]
    disk_set(cache_key, out, ttl=7 * 24 * 3600)
    return out


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
        "disclaimer": "Public filings and entity records identify the company. They do not establish supplier, buyer, or transaction relationships.",
    }
    disk_set(cache_key, payload, ttl=24 * 3600)
    return payload
