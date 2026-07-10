"""Alpaca market-data client — real-time IEX quotes and deep intraday history for
US equities/ETFs.

Env-gated on ALPACA_API_KEY / ALPACA_API_SECRET (set as Fly secrets in prod). When
unset, available() is False and every caller falls back to its prior source
(yfinance / Tradier), so the app runs unchanged without keys.

Scope: US stocks + ETFs only. Index (^GSPC), futures (=F), FX (=X) and crypto
(-USD) symbols are NOT served here — is_equity() screens them out so those callers
keep using yfinance/Binance.

Licensing note: the IEX feed is Alpaca's non-professional/personal tier. Displaying
it publicly is a redistribution use the non-pro license does not cover; this is a
known, accepted trade-off for this deployment, documented here so it is not a
surprise later. Set ALPACA_FEED=sip once a paid/redistribution entitlement exists.
"""
import os
import datetime as _dt

import httpx
import pandas as pd
from cachetools.func import ttl_cache

_KEY = os.getenv("ALPACA_API_KEY", "")
_SECRET = os.getenv("ALPACA_API_SECRET", "")
_FEED = os.getenv("ALPACA_FEED", "iex")           # 'iex' (free/non-pro) | 'sip' (paid)
_DATA_BASE = os.getenv("ALPACA_DATA_BASE", "https://data.alpaca.markets").rstrip("/")
_HEADERS = {"APCA-API-KEY-ID": _KEY, "APCA-API-SECRET-KEY": _SECRET}

_MAX_BARS = 50_000   # hard cap so a wide window can't page forever

# App timeframe token -> Alpaca timeframe string. Alpaca accepts any Min (1-59) and
# Hour (1-23), so the app's odd frames (3m/10m/2h/4h/6h/12h) are native — no resample.
_TF_MAP = {
    "1m": "1Min", "2m": "2Min", "3m": "3Min", "5m": "5Min", "10m": "10Min",
    "15m": "15Min", "30m": "30Min", "1h": "1Hour", "2h": "2Hour", "4h": "4Hour",
    "6h": "6Hour", "12h": "12Hour", "1d": "1Day", "daily": "1Day",
    "1wk": "1Week", "weekly": "1Week", "1mo": "1Month", "monthly": "1Month",
}


def available() -> bool:
    return bool(_KEY and _SECRET)


def is_equity(symbol: str) -> bool:
    """True for plain US equity/ETF tickers Alpaca serves. Screens out the Yahoo
    symbol forms used elsewhere: ^index, =F futures, =X FX, -USD crypto."""
    s = (symbol or "").upper()
    if not s or s.startswith("^") or "=" in s or s.endswith("-USD"):
        return False
    # Equity tickers are letters with an optional dotted/dashed share class (BRK.B).
    core = s.replace(".", "").replace("-", "")
    return core.isalpha() and len(s) <= 8


def to_alpaca_symbol(symbol: str) -> str:
    # Yahoo writes share classes with a dash (BRK-B); Alpaca uses a dot (BRK.B).
    return symbol.strip().upper().replace("-", ".")


def alpaca_timeframe(tf: str) -> "str | None":
    return _TF_MAP.get((tf or "").lower())


def _iso(d) -> str:
    if isinstance(d, str):
        return d
    if isinstance(d, _dt.date) and not isinstance(d, _dt.datetime):
        return d.isoformat()
    return d.isoformat()


def get_bars(symbol: str, tf: str, start, end=None, adjustment: str = "all") -> list:
    """Historical OHLCV bars for one equity. `tf` is an app token (e.g. '5m','1h','1d').
    Returns a list of {t, o, h, l, c, v} (t = ISO8601 string), oldest first, or [] on
    any failure so callers can fall back."""
    if not available() or not is_equity(symbol):
        return []
    atf = alpaca_timeframe(tf)
    if not atf:
        return []
    sym = to_alpaca_symbol(symbol)
    params = {
        "timeframe": atf, "start": _iso(start), "limit": 10_000,
        "adjustment": adjustment, "feed": _FEED, "sort": "asc",
    }
    if end is not None:
        params["end"] = _iso(end)
    out: list = []
    token = None
    try:
        while len(out) < _MAX_BARS:
            if token:
                params["page_token"] = token
            r = httpx.get(f"{_DATA_BASE}/v2/stocks/{sym}/bars", headers=_HEADERS, params=params, timeout=15)
            r.raise_for_status()
            j = r.json()
            out.extend(j.get("bars") or [])
            token = j.get("next_page_token")
            if not token:
                break
    except Exception:
        return []
    return out


def history_df(symbol: str, tf: str, start, end=None) -> "pd.DataFrame":
    """Bars as a yfinance-shaped DataFrame: DatetimeIndex (UTC) with Open/High/Low/
    Close/Volume columns, so it drops straight into the existing /ohlcv and /history
    code paths. Empty DataFrame on failure."""
    bars = get_bars(symbol, tf, start, end)
    if not bars:
        return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"])
    df = pd.DataFrame(bars)
    df["t"] = pd.to_datetime(df["t"], utc=True)
    df = df.set_index("t").rename(columns={"o": "Open", "h": "High", "l": "Low", "c": "Close", "v": "Volume"})
    return df[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])


@ttl_cache(maxsize=512, ttl=4)   # tight cache for the live chart-tick overlay
def get_latest_quote(symbol: str) -> dict:
    """Latest NBBO-ish quote for the live tick. Returns {bid, ask, price} or {} on
    failure. `price` is the mid (or whichever side is present)."""
    if not available() or not is_equity(symbol):
        return {}
    sym = to_alpaca_symbol(symbol)
    try:
        r = httpx.get(f"{_DATA_BASE}/v2/stocks/{sym}/quotes/latest",
                      headers=_HEADERS, params={"feed": _FEED}, timeout=8)
        r.raise_for_status()
        q = (r.json() or {}).get("quote") or {}
    except Exception:
        return {}
    bid, ask = float(q.get("bp") or 0), float(q.get("ap") or 0)
    sides = [x for x in (bid, ask) if x > 0]
    price = round(sum(sides) / len(sides), 4) if sides else 0.0
    return {"bid": bid, "ask": ask, "price": price} if price else {}


@ttl_cache(maxsize=512, ttl=4)
def get_latest_price(symbol: str) -> "float | None":
    """Last trade price for the live tick; falls back to the quote mid."""
    if not available() or not is_equity(symbol):
        return None
    sym = to_alpaca_symbol(symbol)
    try:
        r = httpx.get(f"{_DATA_BASE}/v2/stocks/{sym}/trades/latest",
                      headers=_HEADERS, params={"feed": _FEED}, timeout=8)
        r.raise_for_status()
        p = float(((r.json() or {}).get("trade") or {}).get("p") or 0)
        if p > 0:
            return round(p, 4)
    except Exception:
        pass
    q = get_latest_quote(symbol)
    return q.get("price") or None
