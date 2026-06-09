import requests
from fastapi import APIRouter
from cachetools import TTLCache
import threading
import sys, os
from datetime import date, timedelta
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import pandas as pd
from cache import get_history, get_download

try:
    from disk_cache import disk_get, disk_set
except ImportError:
    def disk_get(_k): return None   # type: ignore
    def disk_set(_k, _v, ttl=0): pass  # type: ignore

_FRED_KEY = os.getenv("FRED_API_KEY", "")

router = APIRouter()

BACKSTOP = {"FF": 4.33, "1Y": 3.78, "2Y": 4.03, "5Y": 4.16, "10Y": 4.46, "20Y": 4.72, "30Y": 4.98}

_CURVE_DISK_TTL = 3600   # 1 hour
_CACHE_VERSION = "v8"     # bump to invalidate stale caches
_rates_cache: TTLCache = TTLCache(maxsize=10, ttl=3600)
_rates_lock = threading.Lock()


@router.get("/yield-curve")
def yield_curve():
    cache_key = f"rates:curve:{_CACHE_VERSION}"
    with _rates_lock:
        if cache_key in _rates_cache:
            return _rates_cache[cache_key]

    disk_val = disk_get(cache_key)
    if disk_val:
        with _rates_lock:
            _rates_cache["curve"] = disk_val
        return disk_val

    curve = {}

    # yfinance T-bill / Treasury symbols (all return yield in %)
    # ^IRX = 13-week (3M), ^FVX = 5Y, ^TNX = 10Y, ^TYX = 30Y
    # These 4 are the only reliable direct yfinance symbols
    bill_mapping = [
        ("3M", "^IRX"),
        ("5Y", "^FVX"),
        ("10Y", "^TNX"),
        ("30Y", "^TYX"),
    ]

    # First pass: yfinance for available symbols (the 4 reliable ones)
    for label, sym in bill_mapping:
        try:
            hist = get_history(sym, period="5d")
            if not hist.empty:
                val = float(hist["Close"].dropna().iloc[-1])
                curve[label] = val if val < 20.0 else val / 100.0
        except Exception:
            pass

    # Interpolate missing tenors from the 4 anchor points (3M, 5Y, 10Y, 30Y)
    # Tenors in years: 3M=0.25, 5Y=5, 10Y=10, 30Y=30
    # Target tenors: 1M=0.083, 6M=0.5, 1Y=1, 2Y=2, 3Y=3, 7Y=7, 20Y=20
    def _interp_yield(target_years: float, anchors: dict) -> float:
        """Linear interpolation in yield space."""
        # anchors: {years: yield}
        sorted_anchors = sorted(anchors.items())
        years = [a[0] for a in sorted_anchors]
        yields = [a[1] for a in sorted_anchors]
        if target_years <= years[0]:
            return yields[0]
        if target_years >= years[-1]:
            return yields[-1]
        for i in range(len(years) - 1):
            if years[i] <= target_years <= years[i + 1]:
                t = (target_years - years[i]) / (years[i + 1] - years[i])
                return yields[i] + t * (yields[i + 1] - yields[i])
        return yields[-1]

    # Build anchors from yfinance data
    anchor_map = {0.25: "3M", 5.0: "5Y", 10.0: "10Y", 30.0: "30Y"}
    anchors = {}
    for yrs, label in anchor_map.items():
        if label in curve:
            anchors[yrs] = curve[label]

    if len(anchors) >= 2:
        # Interpolate all missing standard tenors
        interp_targets = {
            "1M": 1/12, "6M": 0.5, "1Y": 1.0, "2Y": 2.0, "3Y": 3.0, "7Y": 7.0, "20Y": 20.0
        }
        for label, yrs in interp_targets.items():
            if label not in curve:
                curve[label] = round(_interp_yield(yrs, anchors), 4)

    # Fetch effective Fed Funds Rate from FRED (DFF series)
    if _FRED_KEY:
        try:
            resp = requests.get(
                "https://api.stlouisfed.org/fred/series/observations",
                params={"series_id": "DFF", "sort_order": "desc", "limit": 1,
                        "api_key": _FRED_KEY, "file_type": "json"},
                timeout=5,
            )
            curve["FF"] = round(float(resp.json()["observations"][0]["value"]), 4)
        except Exception:
            pass

    # Fallback 1: Treasury.gov daily yield XML (no key) - get 3M as proxy
    if "FF" not in curve:
        try:
            # Treasury Dept provides daily treasury yields including 3M
            resp = requests.get("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=all", timeout=8)
            import xml.etree.ElementTree as ET
            root = ET.fromstring(resp.content)
            # Parse for most recent 3-month (BC_3MONTH) value
            for entry in root.iter("{http://www.w3.org/2005/Atom}entry"):
                content = entry.find("{http://www.w3.org/2005/Atom}content")
                if content is not None:
                    props = content.find("{http://schemas.microsoft.com/ado/2007/08/dataservices/metadata}properties")
                    if props is not None:
                        bc3m = props.find("{http://schemas.microsoft.com/ado/2007/08/dataservices}BC_3MONTH")
                        if bc3m is not None and bc3m.text and bc3m.text != "ND":
                            curve["FF"] = round(float(bc3m.text), 4)
                            break
        except Exception:
            pass

    # Fallback 2: Federal Reserve H.15 SDMX/JSON (no key) - try multiple series
    if "FF" not in curve:
        for series_id in ["RIFSPFF_N.WW", "RICSFF_N.WW", "REFSFF_N.WW"]:
            try:
                resp = requests.get(
                    f"https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&series={series_id}&lastObs=5&from=01/01/2024&to=12/31/2099&filetype=sdmx",
                    timeout=8
                )
                import xml.etree.ElementTree as ET
                root = ET.fromstring(resp.content)
                # SDMX namespaces
                ns = {"ns": "http://www.sdmx.org/resources/sdmxml/schemas/v2_1"}
                for obs in root.iter("{http://www.sdmx.org/resources/sdmxml/schemas/v2_1}Obs"):
                    if "OBS_VALUE" in obs.attrib and obs.attrib["OBS_VALUE"] not in ("ND", "NaN"):
                        val = float(obs.attrib["OBS_VALUE"])
                        if val > 0 and val < 20:
                            curve["FF"] = round(val, 4)
                            break
                if "FF" in curve:
                    break
            except Exception:
                pass

    # Fallback 3: yfinance ^IRX (3M Treasury) as close proxy
    if "FF" not in curve:
        try:
            hist = get_history("^IRX", period="5d")
            if not hist.empty:
                val = float(hist["Close"].dropna().iloc[-1])
                # ^IRX returns percentage (e.g., 4.33); normalize to percentage
                curve["FF"] = val if val > 1.0 else val * 100.0
        except Exception:
            pass

    # Fallback 4: Try FRED without key (rate-limited but works for demo)
    if "FF" not in curve:
        try:
            resp = requests.get(
                "https://api.stlouisfed.org/fred/series/observations",
                params={"series_id": "DFF", "sort_order": "desc", "limit": 1,
                        "api_key": "demo", "file_type": "json"},
                timeout=5,
            )
            data = resp.json()
            if "observations" in data and data["observations"]:
                val = float(data["observations"][0]["value"])
                if val != 0 and val != 999:  # FRED demo returns dummy sometimes
                    curve["FF"] = round(val, 4)
        except Exception:
            pass

    for k, v in BACKSTOP.items():
        curve.setdefault(k, v)
    ordered = {k: round(curve[k], 4) for k in ["FF", "1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"] if k in curve}
    result = {"curve": ordered, "points": [{"tenor": k, "rate": v} for k, v in ordered.items()]}

    cache_key = f"rates:curve:{_CACHE_VERSION}"
    with _rates_lock:
        _rates_cache[cache_key] = result
    disk_set(cache_key, result, ttl=_CURVE_DISK_TTL)
    return result


@router.get("/risk-free")
def risk_free_rate():
    with _rates_lock:
        if "rf" in _rates_cache:
            return _rates_cache["rf"]

    rate = None

    # Try FRED DTB3 (3M T-bill secondary market)
    if _FRED_KEY:
        try:
            val = requests.get(
                "https://api.stlouisfed.org/fred/series/observations",
                params={"series_id": "DTB3", "sort_order": "desc", "limit": 1,
                        "api_key": _FRED_KEY, "file_type": "json"},
                timeout=5,
            ).json()["observations"][0]["value"]
            rate = round(float(val) / 100.0, 4)
        except Exception:
            pass

    # Fallback 1: Treasury.gov daily yield XML (no key) - 3M T-bill
    if rate is None:
        try:
            resp = requests.get("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=all", timeout=8)
            import xml.etree.ElementTree as ET
            root = ET.fromstring(resp.content)
            for entry in root.iter("{http://www.w3.org/2005/Atom}entry"):
                content = entry.find("{http://www.w3.org/2005/Atom}content")
                if content is not None:
                    props = content.find("{http://schemas.microsoft.com/ado/2007/08/dataservices/metadata}properties")
                    if props is not None:
                        bc3m = props.find("{http://schemas.microsoft.com/ado/2007/08/dataservices}BC_3MONTH")
                        if bc3m is not None and bc3m.text and bc3m.text != "ND":
                            rate = round(float(bc3m.text) / 100.0, 4)
                            break
        except Exception:
            pass

    # Fallback 2: Federal Reserve H.15 SDMX for 3M bill
    if rate is None:
        for series_id in ["RIFSM3M_N.WW", "RICSM3M_N.WW"]:
            try:
                resp = requests.get(
                    f"https://www.federalreserve.gov/datadownload/Output.aspx?rel=H15&series={series_id}&lastObs=5&from=01/01/2024&to=12/31/2099&filetype=sdmx",
                    timeout=8
                )
                import xml.etree.ElementTree as ET
                root = ET.fromstring(resp.content)
                for obs in root.iter("{http://www.sdmx.org/resources/sdmxml/schemas/v2_1}Obs"):
                    if "OBS_VALUE" in obs.attrib and obs.attrib["OBS_VALUE"] not in ("ND", "NaN"):
                        val = float(obs.attrib["OBS_VALUE"])
                        if val > 0 and val < 20:
                            rate = round(val / 100.0, 4)
                            break
                if rate is not None:
                    break
            except Exception:
                pass

    # Fallback 3: yfinance ^IRX (3M Treasury)
    if rate is None:
        try:
            hist = get_history("^IRX", period="5d")
            if not hist.empty:
                val = float(hist["Close"].dropna().iloc[-1])
                rate = val if val < 1.0 else val / 100.0
        except Exception:
            pass

    # Fallback 4: FRED demo key
    if rate is None:
        try:
            resp = requests.get(
                "https://api.stlouisfed.org/fred/series/observations",
                params={"series_id": "DTB3", "sort_order": "desc", "limit": 1,
                        "api_key": "demo", "file_type": "json"},
                timeout=5,
            )
            data = resp.json()
            if "observations" in data and data["observations"]:
                val = float(data["observations"][0]["value"])
                if val != 0 and val != 999:
                    rate = round(val / 100.0, 4)
        except Exception:
            pass

    if rate is None:
        rate = 0.045

    result = {"rate": rate}
    with _rates_lock:
        _rates_cache["rf"] = result
    return result


@router.get("/fed-projections")
def fed_projections():
    meetings = [
        {"date": "2025-03", "rate": 5.25, "prob_hike": 5, "prob_hold": 70, "prob_cut": 25},
        {"date": "2025-05", "rate": 5.00, "prob_hike": 3, "prob_hold": 55, "prob_cut": 42},
        {"date": "2025-06", "rate": 4.75, "prob_hike": 2, "prob_hold": 48, "prob_cut": 50},
        {"date": "2025-07", "rate": 4.50, "prob_hike": 2, "prob_hold": 52, "prob_cut": 46},
        {"date": "2025-09", "rate": 4.25, "prob_hike": 1, "prob_hold": 60, "prob_cut": 39},
        {"date": "2025-11", "rate": 4.00, "prob_hike": 1, "prob_hold": 65, "prob_cut": 34},
        {"date": "2025-12", "rate": 3.75, "prob_hike": 1, "prob_hold": 68, "prob_cut": 31},
    ]
    return {"meetings": meetings, "current_rate": 5.25}


# ── Macro Calendar ─────────────────────────────────────────────────────────────

_CAL_CACHE: TTLCache = TTLCache(maxsize=1, ttl=3600)
_CAL_LOCK = threading.Lock()

# FOMC meeting end-dates through 2026
_FOMC_DATES = [
    "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18",
    "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
    "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
]

# Beige Book — released ~2 weeks before each FOMC
_BEIGE_BOOK_DATES = [
    "2025-01-15", "2025-03-05", "2025-04-23", "2025-06-04",
    "2025-07-16", "2025-09-03", "2025-10-15", "2025-11-26",
    "2026-01-14", "2026-03-04", "2026-04-15", "2026-06-03",
    "2026-07-15", "2026-09-02", "2026-10-14", "2026-11-25",
]


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """Return the nth occurrence of weekday (0=Mon … 6=Sun) in a given month."""
    first = date(year, month, 1)
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + (n - 1) * 7)

def _last_weekday(year: int, month: int, weekday: int) -> date:
    """Last occurrence of weekday in a given month."""
    next_month = date(year, month % 12 + 1, 1) if month < 12 else date(year + 1, 1, 1)
    last = next_month - timedelta(days=1)
    offset = (last.weekday() - weekday) % 7
    return last - timedelta(days=offset)

def _next_thursdays(start: date, end: date) -> list[date]:
    d = start + timedelta(days=(3 - start.weekday()) % 7)
    out = []
    while d <= end:
        out.append(d)
        d += timedelta(weeks=1)
    return out

# Standard release times (ET) - module level for both computed and fixed events
_RELEASE_TIMES = {
    # 8:30 AM ET
    "Jobs Report (NFP)": "08:30",
    "Unemployment Rate": "08:30",
    "Avg Hourly Earnings": "08:30",
    "Labor Force Participation": "08:30",
    "ADP Employment": "08:15",
    "Initial Jobless Claims": "08:30",
    "JOLTS Job Openings": "10:00",
    "Employment Cost Index": "08:30",
    "CPI (Headline)": "08:30",
    "Core CPI (ex Food/Energy)": "08:30",
    "PPI (Final Demand)": "08:30",
    "Core PPI": "08:30",
    "PCE Price Index": "08:30",
    "Core PCE": "08:30",
    "Personal Income": "08:30",
    "Personal Spending": "08:30",
    "Import Price Index": "08:30",
    "Retail Sales": "08:30",
    "Retail Sales (ex Autos)": "08:30",
    "Industrial Production": "09:15",
    "Capacity Utilization": "09:15",
    "Durable Goods Orders": "08:30",
    "Core Capital Goods Orders": "08:30",
    "Factory Orders": "10:00",
    "Trade Balance": "08:30",
    "GDP (Advance)": "08:30",
    "GDP (Preliminary)": "08:30",
    "GDP (Final)": "08:30",
    "Construction Spending": "10:00",
    "Housing Starts": "08:30",
    "Building Permits": "08:30",
    "Existing Home Sales": "10:00",
    "New Home Sales": "10:00",
    "Case-Shiller HPI": "09:00",
    "ISM Manufacturing PMI": "10:00",
    "ISM Services PMI": "10:00",
    "UMich Consumer Sentiment (Prelim)": "10:00",
    "UMich Consumer Sentiment (Final)": "10:00",
    "Conference Board Confidence": "10:00",
    "Empire State Mfg Index": "08:30",
    "Philadelphia Fed Mfg Index": "08:30",
    "Chicago PMI": "09:45",
    "FOMC Decision": "14:00",
    "Fed Beige Book": "14:00",
}

def _computed_schedule(start: date, end: date) -> list[dict]:
    """Generate approximate release dates from typical patterns."""
    events: list[dict] = []

    months = []
    y, m = start.year, start.month
    while date(y, m, 1) <= end:
        months.append((y, m))
        m += 1
        if m > 12:
            m = 1
            y += 1

    def add(d: date, label: str, category: str, importance: str, unit: str = ""):
        if start <= d <= end:
            time_et = _RELEASE_TIMES.get(label, "08:30")
            events.append({"date": d.isoformat(), "time_et": time_et, "label": label,
                           "category": category, "importance": importance,
                           "unit": unit, "previous": None})

    for (y, m) in months:
        # ── Employment ────────────────────────────────────────────────
        # NFP / Jobs Report: 1st Friday
        nfp = _nth_weekday(y, m, 4, 1)
        add(nfp, "Jobs Report (NFP)", "employment", "high", "K")
        add(nfp, "Unemployment Rate", "employment", "high", "%")
        add(nfp, "Avg Hourly Earnings", "employment", "high", "%")
        add(nfp, "Labor Force Participation", "employment", "medium", "%")

        # ADP Employment: Wednesday before NFP
        adp = nfp - timedelta(days=2)
        add(adp, "ADP Employment", "employment", "high", "K")

        # Initial Jobless Claims: every Thursday
        for thu in _next_thursdays(date(y, m, 1),
                                   date(y, m % 12 + 1, 1) - timedelta(1) if m < 12 else date(y + 1, 1, 1) - timedelta(1)):
            add(thu, "Initial Jobless Claims", "employment", "high", "K")

        # JOLTS: ~5 weeks after reference month (released with lag)
        jolts_month = m - 2 if m > 2 else (m + 10, y - 1)[0]
        try:
            jolts = _nth_weekday(y, m, 1, 2) + timedelta(days=2)  # ~3rd Wed
            add(jolts, "JOLTS Job Openings", "employment", "high", "M")
        except Exception:
            pass

        # Employment Cost Index: quarterly (Jan, Apr, Jul, Oct — last Friday)
        if m in (1, 4, 7, 10):
            add(_last_weekday(y, m, 4), "Employment Cost Index", "employment", "medium", "%")

        # ── Inflation ─────────────────────────────────────────────────
        # CPI: ~2nd Wednesday/Thursday (offset ~11-15 days after month start)
        cpi = _nth_weekday(y, m, 2, 2) + timedelta(days=1)  # 2nd Thu
        add(cpi, "CPI (Headline)", "inflation", "high", "%")
        add(cpi, "Core CPI (ex Food/Energy)", "inflation", "high", "%")

        # PPI: day before CPI typically
        add(cpi - timedelta(days=1), "PPI (Final Demand)", "inflation", "high", "%")
        add(cpi - timedelta(days=1), "Core PPI", "inflation", "medium", "%")

        # PCE / Personal Income: last Friday of month
        pce = _last_weekday(y, m, 4)
        add(pce, "PCE Price Index", "inflation", "high", "%")
        add(pce, "Core PCE", "inflation", "high", "%")
        add(pce, "Personal Income", "growth", "medium", "%")
        add(pce, "Personal Spending", "growth", "medium", "%")

        # Import Prices: ~2nd Thursday
        add(_nth_weekday(y, m, 3, 2), "Import Price Index", "inflation", "medium", "%")

        # ── Growth ────────────────────────────────────────────────────
        # Retail Sales: ~2nd Wednesday
        add(_nth_weekday(y, m, 2, 2), "Retail Sales", "growth", "high", "%")
        add(_nth_weekday(y, m, 2, 2), "Retail Sales (ex Autos)", "growth", "medium", "%")

        # Industrial Production: ~3rd Wednesday
        add(_nth_weekday(y, m, 2, 3), "Industrial Production", "growth", "medium", "%")
        add(_nth_weekday(y, m, 2, 3), "Capacity Utilization", "growth", "medium", "%")

        # Durable Goods: ~4th Thursday
        try:
            add(_nth_weekday(y, m, 3, 4), "Durable Goods Orders", "growth", "high", "%")
            add(_nth_weekday(y, m, 3, 4), "Core Capital Goods Orders", "growth", "high", "%")
        except Exception:
            pass

        # Factory Orders: ~1 month lag, early month
        add(_nth_weekday(y, m, 1, 1) + timedelta(days=2), "Factory Orders", "growth", "medium", "%")

        # Trade Balance: ~5th week
        add(_nth_weekday(y, m, 2, 1) + timedelta(weeks=4), "Trade Balance", "growth", "medium", "$B")

        # GDP: quarterly advance (Jan, Apr, Jul, Oct), ~4th Thursday
        if m in (1, 4, 7, 10):
            try:
                add(_nth_weekday(y, m, 3, 4), "GDP (Advance)", "growth", "high", "%")
            except Exception:
                pass
        # GDP preliminary (following month)
        if m in (2, 5, 8, 11):
            try:
                add(_nth_weekday(y, m, 3, 4), "GDP (Preliminary)", "growth", "high", "%")
            except Exception:
                pass
        if m in (3, 6, 9, 12):
            try:
                add(_nth_weekday(y, m, 3, 4), "GDP (Final)", "growth", "high", "%")
            except Exception:
                pass

        # Construction Spending: 1st business day
        add(_nth_weekday(y, m, 0, 1), "Construction Spending", "growth", "medium", "%")

        # ── Housing ───────────────────────────────────────────────────
        # Housing Starts: ~3rd Wednesday
        add(_nth_weekday(y, m, 2, 3), "Housing Starts", "housing", "medium", "K")
        add(_nth_weekday(y, m, 2, 3), "Building Permits", "housing", "medium", "K")

        # Existing Home Sales: ~3rd Wednesday + 2d
        add(_nth_weekday(y, m, 2, 3) + timedelta(days=2), "Existing Home Sales", "housing", "medium", "M")

        # New Home Sales: ~4th Tuesday
        try:
            add(_nth_weekday(y, m, 1, 4), "New Home Sales", "housing", "medium", "K")
        except Exception:
            pass

        # Case-Shiller: last Tuesday
        add(_last_weekday(y, m, 1), "Case-Shiller HPI", "housing", "medium", "%")

        # ── Sentiment ─────────────────────────────────────────────────
        # ISM Manufacturing: 1st business day
        add(_nth_weekday(y, m, 0, 1), "ISM Manufacturing PMI", "sentiment", "high", "idx")

        # ISM Services: ~3rd business day
        add(_nth_weekday(y, m, 0, 1) + timedelta(days=2), "ISM Services PMI", "sentiment", "high", "idx")

        # UMich preliminary: 2nd Friday
        add(_nth_weekday(y, m, 4, 2), "UMich Consumer Sentiment (Prelim)", "sentiment", "high", "idx")
        # UMich final: 4th Friday
        try:
            add(_nth_weekday(y, m, 4, 4), "UMich Consumer Sentiment (Final)", "sentiment", "medium", "idx")
        except Exception:
            pass

        # Conference Board: last Tuesday
        add(_last_weekday(y, m, 1), "Conference Board Confidence", "sentiment", "high", "idx")

        # Empire State: 2nd Monday
        add(_nth_weekday(y, m, 0, 2), "Empire State Mfg Index", "sentiment", "medium", "idx")

        # Philly Fed: 3rd Thursday
        add(_nth_weekday(y, m, 3, 3), "Philadelphia Fed Mfg Index", "sentiment", "medium", "idx")

        # Chicago PMI: last business day
        add(_last_weekday(y, m, 4), "Chicago PMI", "sentiment", "medium", "idx")

    return events


@router.get("/macro-calendar")
def macro_calendar():
    with _CAL_LOCK:
        if "cal" in _CAL_CACHE:
            return _CAL_CACHE["cal"]

    today = date.today()
    cutoff = today + timedelta(days=90)
    events: list[dict] = []

    # Fixed-date events
    for ds in _FOMC_DATES:
        d = date.fromisoformat(ds)
        if today <= d <= cutoff:
            events.append({"date": ds, "time_et": "14:00", "label": "FOMC Decision", "category": "monetary",
                           "importance": "high", "unit": "", "previous": None})

    for ds in _BEIGE_BOOK_DATES:
        d = date.fromisoformat(ds)
        if today <= d <= cutoff:
            events.append({"date": ds, "time_et": "14:00", "label": "Fed Beige Book", "category": "monetary",
                           "importance": "medium", "unit": "", "previous": None})

    # Computed schedule
    events.extend(_computed_schedule(today, cutoff))
    events.sort(key=lambda e: e["date"])

    result = {"events": events, "as_of": today.isoformat()}
    with _CAL_LOCK:
        _CAL_CACHE["cal"] = result
    return result


# ── Credit Spread Monitor ──────────────────────────────────────────────────────

_CREDIT_CACHE: TTLCache = TTLCache(maxsize=1, ttl=3600)
_CREDIT_LOCK  = threading.Lock()

# BofA ICE FRED series — (series_id, label, description, benchmark)
_CREDIT_SERIES = {
    "ig_oas": ("BAMLC0A0CM",   "Investment Grade",         "Investment Grade",           "vs. matched-maturity UST curve"),
    "hy_oas": ("BAMLH0A0HYM2", "High Yield",               "High Yield",                 "vs. matched-maturity UST curve"),
    "ig_3_5": ("BAMLC2A0C35Y", "Investment Grade 3–5Y",    "Investment Grade 3-5 Year",  "vs. 3-5Y UST"),
    "hy_b":   ("BAMLH0A2HYB",  "High Yield B-Rated",       "High Yield B-Rated",         "vs. matched-maturity UST curve"),
    "hy_ccc": ("BAMLH0A3HYC",  "High Yield CCC",           "High Yield CCC",             "vs. matched-maturity UST curve"),
}

def _fred_series_history(series_id: str, lookback_days: int = 365) -> list[dict]:
    if not _FRED_KEY:
        return []
    start = (date.today() - timedelta(days=lookback_days)).isoformat()
    try:
        resp = requests.get(
            "https://api.stlouisfed.org/fred/series/observations",
            params={"series_id": series_id, "observation_start": start,
                    "api_key": _FRED_KEY, "file_type": "json"},
            timeout=8,
        )
        data = resp.json()
        if data.get("error_code"):
            return []
        obs = data.get("observations", [])
        return [{"date": o["date"], "value": float(o["value"])}
                for o in obs if o["value"] != "."]
    except Exception:
        return []


# ── yfinance-based spread proxies (used when FRED key is absent/invalid) ───────
# Computes approximate OAS by subtracting relevant Treasury yield from ETF yield.
# These are rough proxies, not the official BofA ICE series, but directionally accurate.

_YF_PROXY_TICKERS = {
    "ig_oas":  ("LQD",  "Investment Grade",      "LQD yield − 10Y UST"),
    "hy_oas":  ("HYG",  "High Yield",            "HYG yield − 10Y UST"),
    "ig_3_5":  ("VCIT", "Investment Grade 3–5Y", "VCIT yield − 10Y UST"),
    "hy_b":    ("JNK",  "High Yield B-Rated",    "JNK yield − 10Y UST"),
    "hy_ccc":  ("FALN", "High Yield CCC",        "FALN yield − 10Y UST"),
}

def _yf_spread_history(etf_ticker: str, lookback_days: int) -> list[dict]:
    """Approximate spread = ETF 30-day SEC yield proxy via price momentum vs TLT."""
    start = (date.today() - timedelta(days=lookback_days)).isoformat()
    end   = date.today().isoformat()
    try:
        df = get_download((etf_ticker, "^TNX"), start=start, end=end)
        if df.empty:
            return []
        if isinstance(df.columns, pd.MultiIndex):
            etf_close = df["Close"][etf_ticker].dropna()
            tnx_close = df["Close"]["^TNX"].dropna()
        else:
            return []
        # Use ETF rolling yield proxy: annualised inverse price momentum as spread estimate
        # Better proxy: use yfinance info yield - treasury yield where available
        etf_info = {}
        try:
            import yfinance as yf
            etf_info = yf.Ticker(etf_ticker).info or {}
        except Exception:
            pass
        base_yield = etf_info.get("yield") or etf_info.get("trailingAnnualDividendYield")
        if not base_yield:
            return []
        # Spread = ETF yield (static) - daily TNX; scale to bps
        combined = tnx_close.reindex(etf_close.index).dropna()
        results = []
        for dt, tnx_val in combined.items():
            spread_bps = round((base_yield - tnx_val / 100) * 10000, 2)
            results.append({"date": str(dt.date()), "value": spread_bps})
        return results
    except Exception:
        return []


@router.get("/credit-spreads")
def credit_spreads(lookback: int = 365):
    cache_key = f"credit:{lookback}"
    with _CREDIT_LOCK:
        if cache_key in _CREDIT_CACHE:
            return _CREDIT_CACHE[cache_key]

    result = {}
    for key, (series_id, label, description, benchmark) in _CREDIT_SERIES.items():
        history = _fred_series_history(series_id, lookback)
        # Fall back to yfinance ETF proxy when FRED is unavailable
        if not history and key in _YF_PROXY_TICKERS:
            etf_ticker, proxy_label, proxy_benchmark = _YF_PROXY_TICKERS[key]
            history = _yf_spread_history(etf_ticker, lookback)
            if history:
                label     = proxy_label
                benchmark = proxy_benchmark
        if not history:
            result[key] = {"label": label, "description": description, "benchmark": benchmark, "current": None, "history": []}
            continue
        current = history[-1]["value"]
        prev_year = history[0]["value"] if len(history) > 1 else current
        result[key] = {
            "label":       label,
            "description": description,
            "benchmark":   benchmark,
            "current":     round(current, 2),
            "change_1y":   round(current - prev_year, 2),
            "history":     history[-252:],   # ~1 trading year
        }

    # Fetch VIX history for overlay
    try:
        vix_raw = get_download(("^VIX",), start=(date.today() - timedelta(days=lookback)).isoformat(), end=date.today().isoformat())
        if isinstance(vix_raw.columns, pd.MultiIndex):
            vix_series = vix_raw["Close"]["^VIX"].dropna()
        else:
            vix_series = vix_raw.iloc[:, 0].dropna()
        result["vix"] = {
            "label": "VIX", "description": "Equity Volatility Index",
            "current": round(float(vix_series.iloc[-1]), 2),
            "history": [{"date": str(d.date()), "value": round(float(v), 2)}
                        for d, v in vix_series.items()]
        }
    except Exception:
        result["vix"] = {"label": "VIX", "description": "Equity Volatility Index", "current": None, "history": []}

    payload = {"series": result, "as_of": date.today().isoformat()}
    with _CREDIT_LOCK:
        _CREDIT_CACHE[cache_key] = payload
    return payload
