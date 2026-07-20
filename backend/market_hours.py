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


def session_label(now: _dt.datetime | None = None) -> str:
    """US equity session bucket, so callers can flag extended-hours data as
    indicative rather than presenting it with the same confidence as a regular
    print. Saturday/Sunday reads "weekend" (distinct from "closed") so callers
    can suppress overnight-gap content outright instead of labeling flat,
    meaningless weekend prints as "indicative" — there's no tape to be thin.
    Note this reads Sunday evening as "weekend" too, even once CME futures
    reopen (~6pm ET) — a holiday and this Sunday-evening sliver are the two
    known gaps in this classifier; a weekday market holiday is not enumerated
    here and would read as "pre-market" or "closed" depending on clock time,
    same caveat as is_market_open above."""
    et = (now or _dt.datetime.now(_dt.timezone.utc)).astimezone(_ET)
    if et.weekday() >= 5:                       # Saturday / Sunday
        return "weekend"
    t = et.time()
    if _dt.time(4, 0) <= t < _dt.time(9, 30):
        return "pre-market"
    if _dt.time(9, 30) <= t <= _dt.time(16, 0):
        return "regular"
    if _dt.time(16, 0) < t < _dt.time(20, 0):
        return "after-hours"
    return "closed"
