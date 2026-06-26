"""Freshest available last price, for the live chart-tick overlay and the paper
engine's position marks.

Tradier real-time for US equities/ETFs; yfinance fast_info for everything else
(futures =F, crypto -USD, FX, and as an equity fallback). Short-cached (4s) so a
burst of callers — the chart poll plus every position in a get_account valuation —
collapses to one upstream hit per symbol.
"""
from cachetools.func import ttl_cache


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
    # yfinance fast_info: futures, crypto, FX, and an equity fallback.
    try:
        import yfinance as yf
        p = getattr(yf.Ticker(sym).fast_info, "last_price", None)
        if p:
            return float(p)
    except Exception:
        pass
    return None
