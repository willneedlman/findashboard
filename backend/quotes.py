"""Freshest available last price, for the live chart-tick overlay and the paper
engine's position marks.

Source order per symbol:
  - Tradier real-time  — US equities/ETFs/options
  - Binance public API — crypto (XXX-USD), no key, real-time
  - yfinance fast_info — futures (=F), FX (=X), and a catch-all fallback

Short-cached (4s) so a burst of callers — the chart poll plus every position in a
get_account valuation — collapses to one upstream hit per symbol.

Binance: api.binance.com geo-blocks US IPs, and the prod host is US (Fly iad), so
the default base is api.binance.us (covers the major coins). Override with
BINANCE_BASE (e.g. api.binance.com via non-US routing). The /ticker/price market
endpoint needs no key; BINANCE_API_KEY is sent if set (forward-compat) but isn't
required.
"""
import os

from cachetools.func import ttl_cache

_BINANCE_BASE = os.getenv("BINANCE_BASE", "https://api.binance.us").rstrip("/")
_BINANCE_KEY = os.getenv("BINANCE_API_KEY", "")


def _binance_price(sym: str) -> "float | None":
    # Crypto arrives in yfinance form (BTC-USD); Binance quotes in USDT (≈ USD).
    if not sym.endswith("-USD"):
        return None
    pair = sym[:-4] + "USDT"          # BTC-USD -> BTCUSDT
    headers = {"X-MBX-APIKEY": _BINANCE_KEY} if _BINANCE_KEY else {}
    try:
        import requests
        r = requests.get(f"{_BINANCE_BASE}/api/v3/ticker/price",
                         params={"symbol": pair}, headers=headers, timeout=4)
        if r.status_code == 200:
            p = r.json().get("price")
            return float(p) if p and float(p) > 0 else None
    except Exception:
        pass
    return None


@ttl_cache(maxsize=1024, ttl=4)
def live_price(symbol: str) -> "float | None":
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    # Tradier: real-time, but only US equities/ETFs/options.
    try:
        import tradier
        if tradier.available():
            q = tradier.get_quote_live(sym) or {}
            last = q.get("last") or q.get("close")
            if last:
                return float(last)
    except Exception:
        pass
    # Binance: real-time crypto, no key.
    p = _binance_price(sym)
    if p:
        return p
    # yfinance fast_info: futures, FX, and an equity/crypto fallback.
    try:
        import yfinance as yf
        p = getattr(yf.Ticker(sym).fast_info, "last_price", None)
        if p:
            return float(p)
    except Exception:
        pass
    return None
