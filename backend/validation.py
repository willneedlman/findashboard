import re
import logging
from datetime import date
from fastapi import HTTPException

logger = logging.getLogger(__name__)

# Allows Yahoo symbol forms: equities (AAPL, BRK-B), indices (^GSPC), FX (EURUSD=X),
# futures (GC=F, SI=F, CL=F), and dotted tickers (DX-Y.NYB).
_TICKER_RE = re.compile(r'^[A-Z0-9.\-\^=]{1,20}$')


def validate_ticker(t: str) -> str:
    t = t.strip().upper()
    if not _TICKER_RE.match(t):
        raise HTTPException(400, "Invalid ticker symbol")
    return t


def validate_date(s: str) -> str:
    try:
        date.fromisoformat(s)
    except ValueError:
        raise HTTPException(400, "Invalid date — use YYYY-MM-DD")
    return s


def validate_tickers(tickers: list[str], max_count: int = 20) -> list[str]:
    if len(tickers) > max_count:
        raise HTTPException(400, f"Too many tickers (max {max_count})")
    return [validate_ticker(t) for t in tickers]
