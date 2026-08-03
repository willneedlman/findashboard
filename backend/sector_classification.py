from __future__ import annotations

import json
import logging
import os

import finnhub
import fmp
from cache import get_info
from disk_cache import disk_get, disk_set

_log = logging.getLogger(__name__)
_CACHE_TTL = 30 * 86400
_INVALID = {"", "n/a", "na", "none", "null", "unknown", "unclassified", "not available"}

_CURATED: dict[str, tuple[str, str]] = {
    "JOBY": ("Industrials", "eVTOL & Advanced Air Mobility"),
    "MSTR": ("Technology", "Bitcoin Treasury & Software"),
    "NBIS": ("Technology", "AI Infrastructure"),
    "OWL": ("Financial Services", "Alternative Asset Management"),
    "RVI": ("Real Estate", "Retail Real Estate"),
    "SMR": ("Industrials", "Advanced Nuclear"),
    "SNDK": ("Technology", "Data Storage"),
    "TSLL": ("Consumer Cyclical", "Leveraged EV Equity"),
}


def _load_seed() -> dict:
    try:
        path = os.path.join(os.path.dirname(__file__), "data", "us_fundamentals.json")
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except Exception as exc:
        _log.warning("sector seed load failed: %s", exc)
        return {}


_SEED = _load_seed()


def _clean(value) -> str | None:
    text = str(value or "").strip()
    return None if text.lower() in _INVALID else text


def _result(symbol: str, company_name, sector, industry, source: str) -> dict:
    broad = _clean(sector)
    detail = _clean(industry)
    if not detail:
        detail = broad
    if not broad:
        broad = "Other Public Equity"
    if not detail:
        detail = "Other Public Equity"
    return {
        "symbol": symbol,
        "companyName": _clean(company_name),
        "sector": broad,
        "industry": detail,
        "classification": detail,
        "source": source,
    }


def classify_security(ticker: str) -> dict:
    symbol = ticker.strip().upper().replace(".", "-")
    cache_key = f"portfolio:sector:v2:{symbol}"
    cached = disk_get(cache_key)
    if isinstance(cached, dict) and _clean(cached.get("classification")):
        return cached

    curated = _CURATED.get(symbol)
    seed = _SEED.get(symbol) or {}
    if curated:
        row = _result(symbol, seed.get("companyName"), curated[0], curated[1], "curated")
        disk_set(cache_key, row, ttl=_CACHE_TTL)
        return row

    company_name = None
    broad = None
    detail = None
    sources: list[str] = []

    def merge(candidate: dict, source: str) -> bool:
        nonlocal company_name, broad, detail
        before = (broad, detail)
        company_name = company_name or _clean(candidate.get("companyName") or candidate.get("shortName") or candidate.get("longName"))
        broad = broad or _clean(candidate.get("sector"))
        detail = detail or _clean(candidate.get("industry") or candidate.get("finnhubIndustry"))
        if (broad, detail) != before:
            sources.append(source)
        return bool(broad and detail)

    complete = merge(seed, "fundamentals seed") if seed else False
    if not complete:
        try:
            complete = merge(finnhub.get_profile(symbol) or {}, "Finnhub")
        except Exception as exc:
            _log.info("Finnhub sector fallback failed for %s: %s", symbol, exc)
    if not complete and fmp.available():
        try:
            complete = merge(fmp.get_profile(symbol) or {}, "FMP")
        except Exception as exc:
            _log.info("FMP sector fallback failed for %s: %s", symbol, exc)
    if not complete:
        try:
            merge(get_info(symbol) or {}, "Yahoo Finance")
        except Exception as exc:
            _log.info("Yahoo sector fallback failed for %s: %s", symbol, exc)

    lowered = (company_name or "").lower()
    if not broad and any(term in lowered for term in ("fund", "etf", "trust", "index")):
        broad = "Diversified Fund"
    if not detail and broad == "Diversified Fund":
        detail = "Diversified Fund"

    row = _result(symbol, company_name, broad, detail, " + ".join(sources) or "fallback")
    disk_set(cache_key, row, ttl=_CACHE_TTL)
    return row
