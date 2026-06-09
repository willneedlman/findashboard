"""
Massive.com API client (formerly Polygon.io, rebranded Oct 2025).
Base URL: https://api.massive.com
Auth:     Authorization: Bearer <key>

Free tier covers: historical OHLCV aggs for stocks/options/forex/crypto,
                  reference data (ticker details, options contracts).
Real-time snapshots and futures real-time require a paid plan.
"""

import os
import requests
from cachetools import TTLCache
import threading

_KEY  = os.getenv("MASSIVE_API_KEY", "")
_BASE = "https://api.massive.com"

_cache      = TTLCache(maxsize=500, ttl=900)   # 15 min
_cache_lock = threading.Lock()


def available() -> bool:
    return bool(_KEY)


def _get(path: str, params: dict | None = None) -> dict:
    with _cache_lock:
        cache_key = path + str(sorted((params or {}).items()))
        if cache_key in _cache:
            return _cache[cache_key]

    resp = requests.get(
        f"{_BASE}{path}",
        headers={"Authorization": f"Bearer {_KEY}"},
        params=params or {},
        timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()

    with _cache_lock:
        _cache[cache_key] = data
    return data


# ── Stocks ────────────────────────────────────────────────────────────────────

def get_aggs(ticker: str, from_date: str, to_date: str,
             multiplier: int = 1, timespan: str = "day",
             adjusted: bool = True) -> list[dict]:
    """OHLCV bars for a stock. Returns list of {t, o, h, l, c, v, vw}."""
    data = _get(
        f"/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from_date}/{to_date}",
        {"adjusted": str(adjusted).lower(), "sort": "asc", "limit": 5000},
    )
    return data.get("results") or []


def get_ticker_details(ticker: str) -> dict:
    """Company/ticker reference data — name, market cap, description, etc."""
    data = _get(f"/v3/reference/tickers/{ticker}")
    return data.get("results") or {}


def get_snapshot(ticker: str) -> dict | None:
    """Real-time snapshot (requires paid plan — returns None on free tier)."""
    try:
        data = _get(f"/v2/snapshot/locale/us/markets/stocks/tickers/{ticker}")
        return data.get("ticker")
    except Exception:
        return None


def get_previous_close(ticker: str) -> dict | None:
    """Previous day OHLCV for a stock ticker."""
    data = _get(f"/v2/aggs/ticker/{ticker}/prev", {"adjusted": "true"})
    results = data.get("results") or []
    return results[0] if results else None


# ── Options ───────────────────────────────────────────────────────────────────

def get_options_contracts(underlying: str, expiration_date_gte: str | None = None,
                          contract_type: str | None = None, limit: int = 250) -> list[dict]:
    """List options contracts for an underlying. Free tier accessible."""
    params: dict = {"underlying_ticker": underlying, "limit": limit, "sort": "expiration_date"}
    if expiration_date_gte:
        params["expiration_date.gte"] = expiration_date_gte
    if contract_type:
        params["contract_type"] = contract_type
    data = _get("/v3/reference/options/contracts", params)
    return data.get("results") or []


def get_options_aggs(contract_ticker: str, from_date: str, to_date: str) -> list[dict]:
    """Historical OHLCV for a specific options contract (e.g. O:AAPL260619C00300000)."""
    data = _get(
        f"/v2/aggs/ticker/{contract_ticker}/range/1/day/{from_date}/{to_date}",
        {"adjusted": "true", "sort": "asc", "limit": 365},
    )
    return data.get("results") or []


# ── Forex ─────────────────────────────────────────────────────────────────────

def get_forex_aggs(pair: str, from_date: str, to_date: str,
                   multiplier: int = 1, timespan: str = "day") -> list[dict]:
    """OHLCV for a forex pair. Ticker format: C:EURUSD"""
    ticker = pair if pair.startswith("C:") else f"C:{pair.replace('/', '').upper()}"
    data = _get(
        f"/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from_date}/{to_date}",
        {"sort": "asc", "limit": 5000},
    )
    return data.get("results") or []


def get_forex_last(from_currency: str, to_currency: str) -> dict | None:
    """Most recent forex quote (requires paid plan on real-time)."""
    try:
        data = _get(f"/v1/last_quote/currencies/{from_currency}/{to_currency}")
        return data.get("last")
    except Exception:
        return None


def get_currency_conversion(from_currency: str, to_currency: str, amount: float = 1.0) -> dict | None:
    """Real-time currency conversion rate."""
    try:
        data = _get(f"/v1/conversion/{from_currency}/{to_currency}", {"amount": amount, "precision": 6})
        return data
    except Exception:
        return None


# ── Crypto ────────────────────────────────────────────────────────────────────

def get_crypto_aggs(pair: str, from_date: str, to_date: str,
                    multiplier: int = 1, timespan: str = "day") -> list[dict]:
    """OHLCV for a crypto pair. Ticker format: X:BTCUSD"""
    ticker = pair if pair.startswith("X:") else f"X:{pair.replace('-', '').replace('/', '').upper()}"
    data = _get(
        f"/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from_date}/{to_date}",
        {"adjusted": "true", "sort": "asc", "limit": 5000},
    )
    return data.get("results") or []


# ── Indices ───────────────────────────────────────────────────────────────────

def get_index_aggs(ticker: str, from_date: str, to_date: str,
                   multiplier: int = 1, timespan: str = "day") -> list[dict]:
    """OHLCV for an index. Ticker format: I:SPX"""
    t = ticker if ticker.startswith("I:") else f"I:{ticker.lstrip('^')}"
    data = _get(
        f"/v2/aggs/ticker/{t}/range/{multiplier}/{timespan}/{from_date}/{to_date}",
        {"adjusted": "true", "sort": "asc", "limit": 5000},
    )
    return data.get("results") or []


# ── Futures ───────────────────────────────────────────────────────────────────

# Common continuous contract symbols on Massive
FUTURES_SYMBOLS = {
    "ES":  "ES.fut",   # S&P 500 E-mini
    "NQ":  "NQ.fut",   # Nasdaq 100 E-mini
    "YM":  "YM.fut",   # Dow Jones E-mini
    "RTY": "RTY.fut",  # Russell 2000 E-mini
    "GC":  "GC.fut",   # Gold
    "SI":  "SI.fut",   # Silver
    "CL":  "CL.fut",   # Crude Oil WTI
    "NG":  "NG.fut",   # Natural Gas
    "ZB":  "ZB.fut",   # 30Y Treasury Bond
    "ZN":  "ZN.fut",   # 10Y Treasury Note
    "ZC":  "ZC.fut",   # Corn
    "ZW":  "ZW.fut",   # Wheat
}


def get_futures_aggs(symbol: str, from_date: str, to_date: str,
                     multiplier: int = 1, timespan: str = "day") -> list[dict]:
    """OHLCV for a futures contract. Pass root symbol (ES, NQ, GC, CL) or full ticker."""
    ticker = FUTURES_SYMBOLS.get(symbol.upper(), symbol)
    data = _get(
        f"/v2/aggs/ticker/{ticker}/range/{multiplier}/{timespan}/{from_date}/{to_date}",
        {"sort": "asc", "limit": 5000},
    )
    return data.get("results") or []


def get_futures_contracts(product_code: str | None = None, limit: int = 50) -> list[dict]:
    """List active futures contracts."""
    params: dict = {"limit": limit}
    if product_code:
        params["ticker"] = product_code
    try:
        data = _get("/v3/reference/futures/contracts", params)
        return data.get("results") or []
    except Exception:
        return []
