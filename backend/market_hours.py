"""Holiday-aware US equity session classification in Eastern Time."""
import datetime as _dt
from functools import lru_cache
from zoneinfo import ZoneInfo

_ET = ZoneInfo("America/New_York")


def _observed(day: _dt.date) -> _dt.date:
    if day.weekday() == 5:
        return day - _dt.timedelta(days=1)
    if day.weekday() == 6:
        return day + _dt.timedelta(days=1)
    return day


def _nth_weekday(year: int, month: int, weekday: int, occurrence: int) -> _dt.date:
    first = _dt.date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + _dt.timedelta(days=offset + 7 * (occurrence - 1))


def _last_weekday(year: int, month: int, weekday: int) -> _dt.date:
    if month == 12:
        last = _dt.date(year + 1, 1, 1) - _dt.timedelta(days=1)
    else:
        last = _dt.date(year, month + 1, 1) - _dt.timedelta(days=1)
    return last - _dt.timedelta(days=(last.weekday() - weekday) % 7)


def _easter(year: int) -> _dt.date:
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    ell = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * ell) // 451
    month = (h + ell - 7 * m + 114) // 31
    day = (h + ell - 7 * m + 114) % 31 + 1
    return _dt.date(year, month, day)


@lru_cache(maxsize=16)
def market_holidays(year: int) -> dict[_dt.date, str]:
    holidays = {
        _observed(_dt.date(year, 1, 1)): "New Year's Day",
        _nth_weekday(year, 1, 0, 3): "Martin Luther King Jr. Day",
        _nth_weekday(year, 2, 0, 3): "Presidents Day",
        _easter(year) - _dt.timedelta(days=2): "Good Friday",
        _last_weekday(year, 5, 0): "Memorial Day",
        _observed(_dt.date(year, 6, 19)): "Juneteenth",
        _observed(_dt.date(year, 7, 4)): "Independence Day",
        _nth_weekday(year, 9, 0, 1): "Labor Day",
        _nth_weekday(year, 11, 3, 4): "Thanksgiving",
        _observed(_dt.date(year, 12, 25)): "Christmas Day",
    }
    next_new_year = _observed(_dt.date(year + 1, 1, 1))
    if next_new_year.year == year:
        holidays[next_new_year] = "New Year's Day"
    return holidays


def _early_close(day: _dt.date) -> bool:
    thanksgiving = _nth_weekday(day.year, 11, 3, 4)
    if day == thanksgiving + _dt.timedelta(days=1):
        return True
    if day.month == 7 and day.day == 3 and day.weekday() < 5:
        return True
    return day.month == 12 and day.day == 24 and day.weekday() < 5


def _eastern(now: _dt.datetime | None) -> _dt.datetime:
    return (now or _dt.datetime.now(_dt.timezone.utc)).astimezone(_ET)


def now_et(now: _dt.datetime | None = None) -> _dt.datetime:
    """Exchange-local time — the only clock that decides whether today's session
    has happened yet."""
    return _eastern(now)


def is_market_open(now: _dt.datetime | None = None) -> bool:
    et = _eastern(now)
    if et.weekday() >= 5 or et.date() in market_holidays(et.year):
        return False
    close = _dt.time(13, 0) if _early_close(et.date()) else _dt.time(16, 0)
    return _dt.time(9, 30) <= et.time() < close


def session_label(now: _dt.datetime | None = None) -> str:
    et = _eastern(now)
    if et.weekday() >= 5:
        return "weekend"
    if et.date() in market_holidays(et.year):
        return "holiday"
    t = et.time()
    close = _dt.time(13, 0) if _early_close(et.date()) else _dt.time(16, 0)
    if _dt.time(4, 0) <= t < _dt.time(9, 30):
        return "pre-market"
    if _dt.time(9, 30) <= t < close:
        return "regular"
    if close <= t < _dt.time(20, 0):
        return "after-hours"
    return "closed"


def session_status(now: _dt.datetime | None = None) -> dict:
    et = _eastern(now)
    holiday = market_holidays(et.year).get(et.date())
    return {
        "label": session_label(et),
        "is_open": is_market_open(et),
        "holiday": holiday,
        "early_close": _early_close(et.date()) and holiday is None,
        "as_of": et.isoformat(),
        "timezone": "America/New_York",
    }
