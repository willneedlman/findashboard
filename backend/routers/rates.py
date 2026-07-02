import logging
import requests
from fastapi import APIRouter
from cachetools import TTLCache
import threading
import sys, os
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import pandas as pd
from cache import get_history, get_download, get_info, cached

try:
    from disk_cache import disk_get, disk_set
except ImportError:
    def disk_get(_k): return None   # type: ignore
    def disk_set(_k, _v, ttl=0): pass  # type: ignore

_FRED_KEY = os.getenv("FRED_API_KEY", "")
_log = logging.getLogger("rates")

router = APIRouter()

# Background warmer: keeps the curve + Fed-path caches populated so user
# requests rarely pay the cold path. Both TTLs are 1h and the warmer cannot
# force a rebuild before expiry, so a short interval bounds the stale gap:
# worst case one request pays the ~3s parallel rebuild within 20min of expiry.
_WARM_INTERVAL = 20 * 60
_warm_stop = threading.Event()
_warm_thread = None


def _run_curve_warmer():
    # Warms the FRED curve only. The Fed-path build goes through yfinance and
    # its pandas allocations OOM-killed the 512MB prod VM twice when run here
    # (baseline RSS is already ~390MB after the other boot warms); it stays
    # cold-on-demand, ~5s worst case with the capped pool.
    _warm_stop.wait(90)
    while not _warm_stop.is_set():
        try:
            yield_curve()
        except Exception as e:
            _log.warning("curve warm failed: %s", e)
        _warm_stop.wait(_WARM_INTERVAL)


def start_curve_warmer():
    global _warm_thread
    if _warm_thread and _warm_thread.is_alive():
        return
    _warm_thread = threading.Thread(target=_run_curve_warmer, name="rates-warmer", daemon=True)
    _warm_thread.start()


def stop_curve_warmer():
    _warm_stop.set()

BACKSTOP = {"FF": 4.33, "1Y": 3.78, "2Y": 4.03, "5Y": 4.16, "10Y": 4.46, "20Y": 4.72, "30Y": 4.98}

_CURVE_DISK_TTL = 3600   # 1 hour
_CACHE_VERSION = "v12"    # bump to invalidate stale caches (adds the 1D overlay)
_rates_cache: TTLCache = TTLCache(maxsize=10, ttl=3600)
_rates_lock = threading.Lock()

# Authoritative U.S. Treasury daily par yield curve — every standard tenor, no
# interpolation, no API key. Used for the live curve and the 1M/6M overlays.
_TREASURY_TENORS = [
    ("1M", "BC_1MONTH"), ("3M", "BC_3MONTH"), ("6M", "BC_6MONTH"), ("1Y", "BC_1YEAR"),
    ("2Y", "BC_2YEAR"), ("3Y", "BC_3YEAR"), ("5Y", "BC_5YEAR"), ("7Y", "BC_7YEAR"),
    ("10Y", "BC_10YEAR"), ("20Y", "BC_20YEAR"), ("30Y", "BC_30YEAR"),
]
_ATOM = "{http://www.w3.org/2005/Atom}"
_META = "{http://schemas.microsoft.com/ado/2007/08/dataservices/metadata}"
_DSVC = "{http://schemas.microsoft.com/ado/2007/08/dataservices}"


# FRED Treasury constant-maturity series — reliable from datacenter IPs (unlike
# Treasury.gov, which blocks them), with full history for the overlays.
_FRED_CURVE = [
    ("1M", "DGS1MO"), ("3M", "DGS3MO"), ("6M", "DGS6MO"), ("1Y", "DGS1"),
    ("2Y", "DGS2"), ("3Y", "DGS3"), ("5Y", "DGS5"), ("7Y", "DGS7"),
    ("10Y", "DGS10"), ("20Y", "DGS20"), ("30Y", "DGS30"), ("FF", "DFF"),
]


def _obs_at_or_before(obs: list, target: str):
    """Value from the latest observation on or before `target` (obs ascending)."""
    chosen = None
    for d, v in obs:
        if d <= target:
            chosen = v
        else:
            break
    return chosen


def _fred_curves():
    """Today's curve plus ~1M and ~6M ago, from FRED. None if no key/data."""
    if not _FRED_KEY:
        return None
    start = (date.today() - timedelta(days=210)).isoformat()
    today_c, d1c, m1, m6 = {}, {}, {}, {}
    asof = ""
    tenors_got = 0

    def fetch(sid: str) -> list[tuple[str, float]]:
        try:
            r = requests.get(
                "https://api.stlouisfed.org/fred/series/observations",
                params={"series_id": sid, "observation_start": start,
                        "api_key": _FRED_KEY, "file_type": "json", "sort_order": "asc"},
                timeout=8,
            )
            return [(o["date"], float(o["value"])) for o in r.json().get("observations", [])
                    if o.get("value") not in (".", "", None)]
        except Exception:
            return []

    # Modest pool: 12-wide bursts of JSON parsing OOM'd the 512MB prod VM.
    with ThreadPoolExecutor(max_workers=4) as ex:
        all_obs = list(ex.map(fetch, [sid for _, sid in _FRED_CURVE]))
    for (label, sid), obs in zip(_FRED_CURVE, all_obs):
        if not obs:
            continue
        if label != "FF":
            tenors_got += 1
        ld, lv = obs[-1]
        today_c[label] = round(lv, 4)
        if ld > asof:
            asof = ld
        ref = date.fromisoformat(ld)
        vd = _obs_at_or_before(obs, (ref - timedelta(days=1)).isoformat())
        v1 = _obs_at_or_before(obs, (ref - timedelta(days=30)).isoformat())
        v6 = _obs_at_or_before(obs, (ref - timedelta(days=182)).isoformat())
        if vd is not None:
            d1c[label] = round(vd, 4)
        if v1 is not None:
            m1[label] = round(v1, 4)
        if v6 is not None:
            m6[label] = round(v6, 4)
    if tenors_got < 5:
        return None
    ref = date.fromisoformat(asof)
    return {
        "today": today_c, "d1": d1c, "m1": m1, "m6": m6, "asof": asof,
        "asof_1d": (ref - timedelta(days=1)).isoformat(),
        "asof_1m": (ref - timedelta(days=30)).isoformat(),
        "asof_6m": (ref - timedelta(days=182)).isoformat(),
    }


def _treasury_year(year: int) -> dict:
    """All daily par-yield curves for a calendar year: {date -> {tenor: yield}}."""
    import xml.etree.ElementTree as ET
    url = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/"
           f"pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value={year}")
    resp = requests.get(url, timeout=10, headers={"User-Agent": "FinanceTerminal research@finterm.io"})
    root = ET.fromstring(resp.content)
    days: dict[str, dict] = {}
    for entry in root.iter(f"{_ATOM}entry"):
        content = entry.find(f"{_ATOM}content")
        props = content.find(f"{_META}properties") if content is not None else None
        if props is None:
            continue
        d_el = props.find(f"{_DSVC}NEW_DATE")
        if d_el is None or not d_el.text:
            continue
        row = {}
        for label, field in _TREASURY_TENORS:
            el = props.find(f"{_DSVC}{field}")
            if el is not None and el.text:
                try:
                    row[label] = round(float(el.text), 4)
                except ValueError:
                    pass
        if row:
            days[d_el.text[:10]] = row
    return days


def _curve_at_or_before(days: dict, target: str) -> dict:
    """The curve from the latest trading day on or before `target` (ISO date)."""
    eligible = [d for d in days if d <= target]
    return days[max(eligible)] if eligible else {}


def _treasury_curves():
    """Today's live curve plus the curves ~1 month and ~6 months ago.

    Returns {today, m1, m6, asof, asof_1m, asof_6m} or None if Treasury is down.
    """
    try:
        today = date.today()
        days = _treasury_year(today.year)
        # 6 months back can land in the prior calendar year — pull it too.
        if (today - timedelta(days=182)).year < today.year:
            try:
                days = {**_treasury_year(today.year - 1), **days}
            except Exception:
                pass
        if not days:
            return None
        latest = max(days)
        ref = date.fromisoformat(latest)
        c_today = days[latest]
        if len(c_today) < 5:
            return None
        dd = (ref - timedelta(days=1)).isoformat()
        d1 = (ref - timedelta(days=30)).isoformat()
        d6 = (ref - timedelta(days=182)).isoformat()
        return {
            "today": c_today, "d1": _curve_at_or_before(days, dd),
            "m1": _curve_at_or_before(days, d1), "m6": _curve_at_or_before(days, d6),
            "asof": latest,
            "asof_1d": max([d for d in days if d <= dd], default=None),
            "asof_1m": max([d for d in days if d <= d1], default=None),
            "asof_6m": max([d for d in days if d <= d6], default=None),
        }
    except Exception:
        return None


@router.get("/yield-curve")
def yield_curve():
    cache_key = f"rates:curve:{_CACHE_VERSION}"
    with _rates_lock:
        if cache_key in _rates_cache:
            return _rates_cache[cache_key]

    disk_val = disk_get(cache_key)
    if disk_val:
        with _rates_lock:
            _rates_cache[cache_key] = disk_val
        return disk_val

    curve = {}

    # Full accurate curve + history: FRED first (works from datacenter IPs), then
    # the Treasury.gov par-yield XML as a keyless fallback.
    treasury = _fred_curves() or _treasury_curves()
    curve_1d: dict = {}
    curve_1m: dict = {}
    curve_6m: dict = {}
    asof = asof_1d = asof_1m = asof_6m = None
    if treasury:
        curve.update(treasury["today"])
        curve_1d = treasury["d1"]
        curve_1m = treasury["m1"]
        curve_6m = treasury["m6"]
        asof, asof_1d, asof_1m, asof_6m = treasury["asof"], treasury["asof_1d"], treasury["asof_1m"], treasury["asof_6m"]

    # yfinance T-bill / Treasury symbols (all return yield in %) — fallback that
    # fills any tenor Treasury didn't supply (e.g. Treasury unreachable).
    # ^IRX = 13-week (3M), ^FVX = 5Y, ^TNX = 10Y, ^TYX = 30Y
    bill_mapping = [
        ("3M", "^IRX"),
        ("5Y", "^FVX"),
        ("10Y", "^TNX"),
        ("30Y", "^TYX"),
    ]

    # First pass: yfinance for available symbols (the 4 reliable ones)
    for label, sym in bill_mapping:
        if label in curve:
            continue
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
    TENOR_ORDER = ["FF", "1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "20Y", "30Y"]
    order = lambda c: {k: round(c[k], 4) for k in TENOR_ORDER if k in c}
    ordered = order(curve)
    result = {
        "curve": ordered,
        "points": [{"tenor": k, "rate": v} for k, v in ordered.items()],
        "curve_1d": order(curve_1d),   # prior trading day
        "curve_1m": order(curve_1m),   # ~1 month ago (empty if Treasury unavailable)
        "curve_6m": order(curve_6m),   # ~6 months ago
        "asof": asof, "asof_1d": asof_1d, "asof_1m": asof_1m, "asof_6m": asof_6m,
    }

    cache_key = f"rates:curve:{_CACHE_VERSION}"
    if asof:
        # Real curve + overlays — cache for the full hour.
        with _rates_lock:
            _rates_cache[cache_key] = result
        disk_set(cache_key, result, ttl=_CURVE_DISK_TTL)
    else:
        # FRED/Treasury were unreachable on this call (e.g. a cold start) — cache
        # only briefly so the overlays self-heal instead of sticking for an hour.
        disk_set(cache_key, result, ttl=90)
    return result


@router.get("/risk-free")
def risk_free_rate(days: int | None = None):
    # Term-matched rate: interpolate the Treasury curve at the option's tenor so
    # a 2Y LEAP discounts at the 2Y yield and a weekly at the front of the curve,
    # rather than everything using the 3M bill. Falls through to the 3M default
    # if a tenor isn't requested or the curve is unavailable.
    if days and days > 0:
        try:
            curve = yield_curve().get("curve", {})
            anchors = {_FULL_TENOR_YEARS[k]: curve[k] for k in _FULL_TENOR_YEARS if k in curve}
            if len(anchors) >= 2:
                yrs = max(days / 365.0, 1.0 / 365.0)
                return {"rate": round(_interp_point(anchors, yrs) / 100.0, 4),
                        "tenor_years": round(yrs, 4), "source": "treasury-curve"}
        except Exception:
            pass

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




def _fred_latest(series_id: str) -> float | None:
    """Most recent valid observation of a FRED series (handles '.' gaps).
    Tries the keyed endpoint, then the keyless demo endpoint."""
    for keyed in (True, False):
        if keyed and not _FRED_KEY:
            continue
        params = {"series_id": series_id, "sort_order": "desc", "limit": 5, "file_type": "json"}
        if keyed:
            params["api_key"] = _FRED_KEY
        try:
            resp = requests.get("https://api.stlouisfed.org/fred/series/observations",
                                params=params, timeout=5)
            for obs in resp.json().get("observations", []):
                v = obs.get("value")
                if v not in (None, ".", ""):
                    val = float(v)
                    if 0 < val < 25:
                        return round(val, 4)
        except Exception:
            continue
    return None


def _current_ffr() -> float | None:
    """Current effective Fed Funds Rate from FRED (DFF), falling back to the
    front-month ZQ future. None if neither is reachable."""
    val = _fred_latest("DFF")
    if val is not None:
        return val
    try:
        today = date.today()
        sym = f"ZQ{_ZQ_MONTH[today.month]}{str(today.year)[-2:]}=F"
        h = get_history(sym, period="5d")
        if not h.empty:
            return round(100.0 - float(h["Close"].iloc[-1]), 4)
    except Exception:
        pass
    return None


def _zq_implied_rate(meeting: date) -> float | None:
    """Market-implied average funds rate for a meeting's month, from the ZQ
    future (price = 100 - rate). None if the contract has no data."""
    try:
        sym = f"ZQ{_ZQ_MONTH[meeting.month]}{str(meeting.year)[-2:]}=F"
        h = get_history(sym, period="5d")
        if h.empty:
            return None
        return round(100.0 - float(h["Close"].iloc[-1]), 4)
    except Exception:
        return None


def _curve_implied_path(upcoming: list[date], current_rate: float | None) -> list[float] | None:
    """Back out an expected funds-rate path from the Treasury bill curve (FRED).

    The constant-maturity yield y(T) approximates the average expected short rate
    to horizon T, so the forward rate over each inter-meeting window estimates the
    rate the market expects after that meeting. Free and always available when
    FRED is reachable; carries a small term premium so it is an approximation."""
    pts: list[tuple[float, float]] = []
    if current_rate is not None:
        pts.append((0.0, current_rate))
    bills = (("DGS1MO", 1 / 12), ("DGS3MO", 0.25), ("DGS6MO", 0.5), ("DGS1", 1.0), ("DGS2", 2.0))
    with ThreadPoolExecutor(max_workers=3) as ex:
        latest = list(ex.map(_fred_latest, [s for s, _ in bills]))
    for (series, T), y in zip(bills, latest):
        if y is not None:
            pts.append((T, y))
    pts = sorted(set(pts))
    if len(pts) < 2:
        return None

    def y_interp(T: float) -> float:
        if T <= pts[0][0]:
            return pts[0][1]
        if T >= pts[-1][0]:
            return pts[-1][1]
        for (t0, y0), (t1, y1) in zip(pts, pts[1:]):
            if t0 <= T <= t1:
                return y0 + (y1 - y0) * (T - t0) / (t1 - t0)
        return pts[-1][1]

    today = date.today()
    out: list[float] = []
    prev_T = 0.0
    for mtg in upcoming:
        T = max((mtg - today).days / 365.0, prev_T + 1e-6)
        fwd = (y_interp(T) * T - y_interp(prev_T) * prev_T) / (T - prev_T)
        out.append(round(fwd, 4))
        prev_T = T
    return out


@router.get("/fed-projections")
@cached(ttl=3600, maxsize=1)
def fed_projections():
    """Market-implied Fed funds path + per-meeting hike/hold/cut probabilities.

    Layered, all from free data: a Treasury-curve-implied expected path (FRED) is
    the always-available backbone; CME ZQ fed-funds futures override per meeting
    when available for true market-implied pricing. No hardcoded probabilities."""
    today = date.today()
    upcoming = [d for d in (date.fromisoformat(x) for x in _FOMC_DATES) if d >= today][:8]
    current_rate = _current_ffr()
    curve_path = _curve_implied_path(upcoming, current_rate)

    # yfinance holds a pandas frame per call: keep the pool small for memory.
    with ThreadPoolExecutor(max_workers=2) as ex:
        zq_rates = list(ex.map(_zq_implied_rate, upcoming))

    meetings: list[dict] = []
    prev_rate = current_rate
    used_futures = False
    for i, mtg in enumerate(upcoming):
        zq = zq_rates[i]
        if zq is not None:
            implied, src = zq, "futures"
            used_futures = True
        elif curve_path is not None:
            implied, src = curve_path[i], "curve"
        elif prev_rate is not None:
            implied, src = prev_rate, "carry"
        else:
            continue  # no data source at all — skip rather than fabricate

        # Per-meeting move probabilities from the step vs the prior implied rate,
        # scaled to a standard 25bp increment.
        if prev_rate is not None:
            delta = implied - prev_rate
            prob_cut  = max(0.0, min(1.0, -delta / 0.25))
            prob_hike = max(0.0, min(1.0,  delta / 0.25))
            prob_hold = max(0.0, 1.0 - prob_cut - prob_hike)
        else:
            prob_cut = prob_hike = 0.0
            prob_hold = 1.0

        meetings.append({
            "date":      mtg.strftime("%Y-%m"),
            "rate":      round(implied, 2),
            "prob_hike": round(prob_hike * 100),
            "prob_hold": round(prob_hold * 100),
            "prob_cut":  round(prob_cut * 100),
            "source":    src,
        })
        prev_rate = implied

    source = ("CME ZQ futures + FRED curve" if used_futures
              else "FRED Treasury-curve-implied path" if curve_path is not None
              else "unavailable")
    result = {
        "meetings":     meetings,
        "current_rate": round(current_rate, 2) if current_rate is not None else None,
        "source":       source,
    }
    return result


# ── Macro Calendar ─────────────────────────────────────────────────────────────


# FOMC meeting end-dates (2027 dates are estimates until officially confirmed)
_FOMC_DATES = [
    "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18",
    "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
    "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
    "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-16",
    "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08",
]

# ZQ (30-Day Fed Funds futures) month codes — used to build CME contract symbols.
_ZQ_MONTH = {1: 'F', 2: 'G', 3: 'H', 4: 'J', 5: 'K', 6: 'M',
             7: 'N', 8: 'Q', 9: 'U', 10: 'V', 11: 'X', 12: 'Z'}

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
@cached(ttl=3600, maxsize=1)
def macro_calendar():
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
    return result


# ── Credit Spread Monitor ──────────────────────────────────────────────────────


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
        # FRED BofA OAS series are in percent (e.g. 0.84); multiply by 100 → basis points
        return [{"date": o["date"], "value": round(float(o["value"]) * 100, 2)}
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
            etf_info = get_info(etf_ticker) or {}
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
@cached(ttl=3600, maxsize=8)
def credit_spreads(lookback: int = 365):
    result = {}
    for key, (series_id, label, description, benchmark) in _CREDIT_SERIES.items():
        history = _fred_series_history(series_id, lookback)
        using_proxy = False
        # Fall back to yfinance ETF proxy when FRED is unavailable
        if not history and key in _YF_PROXY_TICKERS:
            etf_ticker, proxy_label, proxy_benchmark = _YF_PROXY_TICKERS[key]
            history = _yf_spread_history(etf_ticker, lookback)
            if history:
                label       = proxy_label
                benchmark   = proxy_benchmark
                using_proxy = True
        if not history:
            result[key] = {"label": label, "description": description, "benchmark": benchmark, "current": None, "history": []}
            continue
        current = history[-1]["value"]
        # change_1y is only meaningful with real FRED OAS data; the yf proxy uses a
        # static base yield so all series would show the same TNX drift, not spread changes.
        if using_proxy:
            change_1y = None
        else:
            prev_year = history[0]["value"] if len(history) > 1 else current
            change_1y = round(current - prev_year, 2)
        result[key] = {
            "label":       label,
            "description": description,
            "benchmark":   benchmark,
            "current":     round(current, 2),
            "change_1y":   change_1y,
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
    return payload


# ── Yield Curve History ────────────────────────────────────────────────────────


_YF_ANCHOR_TICKERS = {"3M": ("^IRX", 0.25), "5Y": ("^FVX", 5.0), "10Y": ("^TNX", 10.0), "30Y": ("^TYX", 30.0)}
_FULL_TENOR_YEARS  = {"1M": 1/12, "3M": 0.25, "6M": 0.5, "1Y": 1.0, "2Y": 2.0,
                      "3Y": 3.0,  "5Y": 5.0,  "7Y": 7.0, "10Y": 10.0, "20Y": 20.0, "30Y": 30.0}

def _interp_point(anchors: dict, t: float) -> float:
    """Linear interpolation in yield space at tenor t (years) from {years: rate}.
    Flat extrapolation beyond the shortest/longest anchor."""
    pts = sorted(anchors.items())
    yrs = [p[0] for p in pts]; ylds = [p[1] for p in pts]
    if t <= yrs[0]:  return ylds[0]
    if t >= yrs[-1]: return ylds[-1]
    for i in range(len(yrs) - 1):
        if yrs[i] <= t <= yrs[i + 1]:
            f = (t - yrs[i]) / (yrs[i + 1] - yrs[i])
            return ylds[i] + f * (ylds[i + 1] - ylds[i])
    return ylds[-1]

def _interp_curve(anchors: dict) -> dict:
    """Build full 11-tenor curve from {years: rate} anchors via linear interp."""
    return {label: round(_interp_point(anchors, t), 4) for label, t in _FULL_TENOR_YEARS.items()}

def _curve_at(close: pd.DataFrame, target_date) -> dict:
    """Interpolate full yield curve at/before target_date from anchor closes."""
    anchors: dict[float, float] = {}
    td = pd.Timestamp(target_date).normalize()
    for _lbl, (sym, years) in _YF_ANCHOR_TICKERS.items():
        if sym not in close.columns: continue
        s = close[sym].dropna()
        s = s[s.index.normalize() <= td]
        if s.empty: continue
        val = float(s.iloc[-1])
        anchors[years] = val if val < 20.0 else val / 100.0
    if len(anchors) < 2:
        return {}
    return _interp_curve(anchors)


@router.get("/yield-curve-history")
@cached(ttl=3600, maxsize=1)
def yield_curve_history():
    start = (date.today() - timedelta(days=400)).isoformat()
    end   = date.today().isoformat()
    syms  = tuple(v[0] for v in _YF_ANCHOR_TICKERS.values())

    try:
        raw = get_download(syms, start=start, end=end)
        close = raw["Close"] if isinstance(raw.columns, pd.MultiIndex) else raw
        close = close.ffill()
    except Exception:
        close = pd.DataFrame()

    today  = date.today()
    result = {
        "current": _curve_at(close, today),
        "snapshots": {
            "1M":  _curve_at(close, today - timedelta(days=30)),
            "3M":  _curve_at(close, today - timedelta(days=90)),
            "1Y":  _curve_at(close, today - timedelta(days=365)),
        },
        "spread_history": [],
        "as_of": today.isoformat(),
    }

    # 3M/10Y spread history (key recession signal — inverts before downturns)
    irx = "^IRX"; tnx = "^TNX"
    if not close.empty and irx in close.columns and tnx in close.columns:
        merged = close[[irx, tnx]].dropna()
        for dt, row in merged.iterrows():
            t3m  = float(row[irx]); t3m  = t3m  if t3m  < 20 else t3m  / 100
            t10y = float(row[tnx]); t10y = t10y if t10y < 20 else t10y / 100
            result["spread_history"].append({
                "date":   str(dt.date()),
                "spread": round((t10y - t3m) * 100, 1),
            })
        result["spread_history"] = result["spread_history"][-252:]

    return result


# ── Economy monitor: unemployment + inflation (FRED) ──────────────────────────
_ECON_DISK_TTL = 6 * 3600   # FRED macro series update monthly; 6h is plenty


@router.get("/economy")
def economy():
    """Unemployment + inflation dashboard from FRED: jobless rate, nonfarm payroll
    monthly change, and CPI / Core CPI / PCE year-over-year, each with a 24-month
    trend. Cached on disk (monthly data)."""
    ckey = f"economy:{_CACHE_VERSION}"
    cached_val = disk_get(ckey)
    if cached_val is not None:
        return cached_val

    import fred

    TREND = 24
    last = lambda s: s[-1] if s else None

    unrate = fred.observations("UNRATE", TREND + 2)
    payems = fred.observations("PAYEMS", TREND + 2)
    cpi  = fred.yoy(fred.observations("CPIAUCSL", TREND + 14))
    core = fred.yoy(fred.observations("CPILFESL", TREND + 14))
    pce  = fred.yoy(fred.observations("PCEPI",    TREND + 14))

    # Nonfarm payroll month-over-month change (thousands)
    pay_change = [{"date": payems[i]["date"], "value": round(payems[i]["value"] - payems[i - 1]["value"], 1)}
                  for i in range(1, len(payems))]

    # Merge inflation gauges onto the CPI date spine for a single multi-line chart
    core_map = {s["date"]: s["value"] for s in core}
    pce_map  = {s["date"]: s["value"] for s in pce}
    infl_trend = [{"d": s["date"][:7], "cpi": s["value"],
                   "core": core_map.get(s["date"]), "pce": pce_map.get(s["date"])}
                  for s in cpi[-TREND:]]

    result = {
        "unemployment": {
            "value": (last(unrate) or {}).get("value"),
            "prev":  unrate[-2]["value"] if len(unrate) > 1 else None,
            "date":  (last(unrate) or {}).get("date"),
            "trend": [{"d": s["date"][:7], "v": s["value"]} for s in unrate[-TREND:]],
        },
        "payrolls": {
            "value": (last(pay_change) or {}).get("value"),
            "date":  (last(pay_change) or {}).get("date"),
            "trend": [{"d": s["date"][:7], "v": s["value"]} for s in pay_change[-TREND:]],
        },
        "inflation": {
            "cpi":  (last(cpi)  or {}).get("value"),
            "core": (last(core) or {}).get("value"),
            "pce":  (last(pce)  or {}).get("value"),
            "date": (last(cpi)  or {}).get("date"),
            "trend": infl_trend,
        },
    }
    disk_set(ckey, result, ttl=_ECON_DISK_TTL)
    return result
