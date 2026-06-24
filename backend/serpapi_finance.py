"""SerpAPI Google Finance client.

The free SerpAPI plan caps at a few hundred searches per MONTH, so this is not a
live quote source. Every call is gated by a hard monthly budget (persisted on
disk) and cached, the same defensive shape as the FMP free-tier client. When the
budget is spent the client serves cache and returns None rather than spending
calls it does not have.

Query format follows Google Finance:
  equity/ETF  TICKER:EXCHANGE   (AAPL:NASDAQ, GLD:NYSEARCA)
  index       .SYM:INDEXEXCH    (.INX:INDEXSP, .DJI:INDEXDJX)
  fx          BASE-QUOTE        (EUR-USD)
  crypto      COIN-USD          (BTC-USD)
"""
import os
import threading
import datetime as _dt

import requests

from disk_cache import disk_get, disk_set

_API_KEY = os.getenv("SERPAPI_API_KEY", "")
_BASE = "https://serpapi.com/search.json"
_TIMEOUT = 20

# Stay under the free cap (sources report 100-250/mo) with headroom for the
# month-boundary race and any manual probing. Override via env if the plan changes.
_MONTHLY_BUDGET = int(os.getenv("SERPAPI_MONTHLY_BUDGET", "200"))

_lock = threading.Lock()


def available() -> bool:
    return bool(_API_KEY and _API_KEY not in ("", "your_key_here"))


def _usage_key() -> str:
    return f"serpapi:usage:{_dt.date.today().strftime('%Y-%m')}"


def budget_status() -> dict:
    used = int(disk_get(_usage_key()) or 0)
    return {"used": used, "budget": _MONTHLY_BUDGET, "remaining": max(_MONTHLY_BUDGET - used, 0)}


def _consume() -> bool:
    """Reserve one call against this month's budget. False when exhausted."""
    with _lock:
        k = _usage_key()
        used = int(disk_get(k) or 0)
        if used >= _MONTHLY_BUDGET:
            return False
        # Keep the counter ~5 weeks so it self-clears after the month rolls over.
        disk_set(k, used + 1, ttl=35 * 86400)
        return True


def _search(query: str) -> dict | None:
    """Raw Google Finance search. Budget-gated; returns None when spent or on error."""
    if not available() or not _consume():
        return None
    try:
        r = requests.get(
            _BASE,
            params={"engine": "google_finance", "q": query, "api_key": _API_KEY},
            timeout=_TIMEOUT,
        )
        r.raise_for_status()
        d = r.json()
        return d if "error" not in d else None
    except Exception:
        return None


def _normalize(d: dict, query: str) -> dict | None:
    s = (d or {}).get("summary") or {}
    try:
        if s.get("extracted_price") is None:
            return None
        price = float(s["extracted_price"])
        mv = s.get("price_movement") or {}
        down = str(mv.get("movement", "")).lower() == "down"
        pct = float(mv["percentage"]) if mv.get("percentage") is not None else None
        val = float(mv["value"]) if mv.get("value") is not None else None
        if down:
            if pct is not None:
                pct = -abs(pct)
            if val is not None:
                val = -abs(val)
        return {
            "query": query,
            "symbol": s.get("stock") or query,
            "name": s.get("title"),
            "exchange": s.get("exchange"),
            "price": round(price, 4),
            "change_pct": round(pct, 2) if pct is not None else None,
            "change": round(val, 4) if val is not None else None,
            "currency": s.get("currency"),
        }
    except (TypeError, ValueError):
        return None


def quote(query: str, ttl: int = 21600) -> dict | None:
    """Normalized quote for a Google Finance query, disk-cached (default 6h).

    Cache is checked first, so a cached value never spends budget. A miss spends
    one call when budget remains, else returns None.
    """
    ck = f"serpapi:q:{query}"
    cached = disk_get(ck)
    if cached is not None:
        return cached or None

    d = _search(query)
    out = _normalize(d, query) if d else None
    # Cache hits for the full ttl; cache misses briefly so a budget-exhausted or
    # failing query is not retried on every request.
    disk_set(ck, out or {}, ttl=ttl if out else 1800)
    return out


def resolve(symbol: str) -> dict | None:
    """Best-effort quote for a bare symbol, for use only as a fallback when the
    primary (yfinance/finnhub) source has already failed. Google Finance resolves
    most plain tickers without an exchange suffix."""
    return quote(symbol.strip().upper())
