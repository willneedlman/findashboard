"""Alpha Vantage daily-history client — last-resort fallback for cache.get_history
when yfinance is contended AND FMP is unavailable/empty.

Free-tier caveats (why this is a genuine last resort, logged on every use):
  - 25 requests/DAY, 5/minute. Exhausts almost immediately under load.
  - outputsize=full is premium, so we request "compact" — only the last ~100
    trading days (~5 months). Deeper history is unavailable on the free key.
  - TIME_SERIES_DAILY is UNADJUSTED (split/dividend adjustment is premium), so
    Close here differs from yfinance's adjusted Close on names with recent splits.

Returns the same shape as cache.get_history: a tz-naive DatetimeIndex frame with
Open/High/Low/Close/Volume columns, ascending — so every existing consumer works
unchanged.
"""
import os
import logging

import pandas as pd
import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

logger = logging.getLogger(__name__)

_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_TIMEOUT = 20
_COLUMNS = ["Open", "High", "Low", "Close", "Volume"]


def available() -> bool:
    key = os.getenv("ALPHAVANTAGE_API_KEY", "")
    return bool(key and key not in ("", "your_key_here"))


def get_history_df(symbol: str, start: str | None = None, end: str | None = None) -> pd.DataFrame:
    """Daily OHLCV for `symbol` between start/end (YYYY-MM-DD, inclusive). Returns
    an empty DataFrame on any failure — never raises into the caller."""
    if not available():
        return pd.DataFrame()
    sym = (symbol or "").strip().upper()
    if not sym:
        return pd.DataFrame()
    logger.info("alphavantage history fallback for %s (unadjusted, compact ~100d, 25/day cap)", sym)
    try:
        resp = requests.get(
            "https://www.alphavantage.co/query",
            params={
                "function": "TIME_SERIES_DAILY",
                "symbol": sym,
                "outputsize": "compact",   # "full" is premium-gated on the free tier
                "apikey": os.environ["ALPHAVANTAGE_API_KEY"],
            },
            headers=_UA,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        payload = resp.json()
    except Exception as e:
        logger.warning("alphavantage fetch failed for %s: %s", sym, e)
        return pd.DataFrame()

    series = payload.get("Time Series (Daily)")
    if not isinstance(series, dict) or not series:
        # AV returns {"Note": ...} on throttle and {"Information": ...} on cap hit.
        note = payload.get("Note") or payload.get("Information") or payload.get("Error Message")
        if note:
            logger.warning("alphavantage no data for %s: %s", sym, str(note)[:160])
        return pd.DataFrame()

    rows = []
    for date_str, bar in series.items():
        try:
            rows.append((
                pd.Timestamp(date_str),
                float(bar["1. open"]), float(bar["2. high"]),
                float(bar["3. low"]), float(bar["4. close"]),
                float(bar["5. volume"]),
            ))
        except (KeyError, ValueError):
            continue
    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows, columns=["Date", *_COLUMNS]).set_index("Date").sort_index()
    if start:
        df = df[df.index >= pd.Timestamp(start)]
    if end:
        df = df[df.index <= pd.Timestamp(end)]
    return df
