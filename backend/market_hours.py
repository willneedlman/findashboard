"""US equity regular-session check (Eastern Time).

Used to decide when live (Tradier) data is worth fetching. Outside the regular
session the last quote can't improve, so callers should fall back to yfinance or
cached data instead of spending Tradier requests on stale, last-session prices.

A weekday market holiday is not enumerated here and would read as "open"; the
data's own timestamp (its age) still reveals the staleness in that edge case.
"""
import datetime as _dt
from zoneinfo import ZoneInfo

_ET = ZoneInfo("America/New_York")


def is_market_open(now: _dt.datetime | None = None) -> bool:
    et = (now or _dt.datetime.now(_dt.timezone.utc)).astimezone(_ET)
    if et.weekday() >= 5:                       # Saturday / Sunday
        return False
    return _dt.time(9, 30) <= et.time() <= _dt.time(16, 0)
