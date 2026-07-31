"""Last known price including pre- and post-market trading.

The regular-session daily bar stops moving the moment the close prints, so
anything reading only that bar reports yesterday's number all evening and all
night. A portfolio and its option marks both want the extended-hours print
instead. It does not have to be current to the second — only current to the last
trade that actually happened — so these reads are cached generously rather than
polled.

Session boundaries (including holidays and early closes) come from market_hours;
this module only adds the fetch.
"""
from __future__ import annotations
import logging

from cache import cached, _run_yf
from market_hours import is_market_open

logger = logging.getLogger(__name__)


def _bars(sym: str):
    import yfinance as yf
    return yf.Ticker(sym).history(period="1d", interval="1m", prepost=True)


# 10 minutes: long enough that a portfolio page left open overnight costs almost
# nothing, short enough that a pre-market move shows up while you are watching.
# The fetch goes through cache._run_yf so it respects the same yfinance
# concurrency guard as every other price read.
@cached(ttl=600, maxsize=512)
def extended_quote(sym: str) -> dict:
    """{'price', 'as_of'} from the latest pre/post bar, or price None."""
    empty = {"price": None, "as_of": None}
    sym = (sym or "").strip().upper()
    if not sym:
        return empty
    try:
        bars = _run_yf(f"prepost {sym}", lambda: _bars(sym))
    except Exception as e:
        logger.debug("extended quote %s unavailable: %s", sym, e)
        return empty
    if bars is None or getattr(bars, "empty", True) or "Close" not in bars:
        return empty
    closes = bars["Close"].dropna()
    if closes.empty:
        return empty
    stamp = closes.index[-1]
    return {
        "price": float(closes.iloc[-1]),
        "as_of": stamp.isoformat() if hasattr(stamp, "isoformat") else None,
    }


def extended_spot(sym: str) -> float | None:
    """Extended-hours price, but only while the regular session is shut. During
    regular hours the daily bar already tracks the live price, so callers should
    keep using it rather than paying for a second fetch."""
    if is_market_open():
        return None
    return extended_quote(sym).get("price")
