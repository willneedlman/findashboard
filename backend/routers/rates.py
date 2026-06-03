import requests
from fastapi import APIRouter
from cachetools import TTLCache
import threading
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import get_history

_FRED_KEY = os.getenv("FRED_API_KEY", "")

router = APIRouter()

BACKSTOP = {"1Y": 3.78, "2Y": 4.03, "5Y": 4.16, "10Y": 4.46, "20Y": 4.72, "30Y": 4.98}

_rates_cache: TTLCache = TTLCache(maxsize=10, ttl=600)   # 10 min for yield/FRED data
_rates_lock = threading.Lock()


@router.get("/yield-curve")
def yield_curve():
    with _rates_lock:
        if "curve" in _rates_cache:
            return _rates_cache["curve"]

    curve = {}
    mapping = [("1Y", "^IRX"), ("5Y", "^FVX"), ("10Y", "^TNX"), ("30Y", "^TYX")]
    for label, sym in mapping:
        try:
            hist = get_history(sym, period="5d")
            if not hist.empty:
                val = float(hist["Close"].dropna().iloc[-1])
                curve[label] = val if val < 20.0 else val / 100.0
        except Exception:
            pass
    if "1Y" in curve and "5Y" in curve:
        curve["2Y"] = curve["1Y"] * 0.6 + curve["5Y"] * 0.4
    if "10Y" in curve and "30Y" in curve:
        curve["20Y"] = curve["10Y"] * 0.5 + curve["30Y"] * 0.5
    for k, v in BACKSTOP.items():
        curve.setdefault(k, v)
    ordered = {k: round(curve[k], 4) for k in ["1Y", "2Y", "5Y", "10Y", "20Y", "30Y"]}
    result = {"curve": ordered, "points": [{"tenor": k, "rate": v} for k, v in ordered.items()]}

    with _rates_lock:
        _rates_cache["curve"] = result
    return result


@router.get("/risk-free")
def risk_free_rate():
    with _rates_lock:
        if "rf" in _rates_cache:
            return _rates_cache["rf"]
    try:
        val = requests.get(
            "https://api.stlouisfed.org/fred/series/observations",
            params={"series_id": "DTB3", "sort_order": "desc", "limit": 1,
                    "api_key": _FRED_KEY, "file_type": "json"},
            timeout=5,
        ).json()["observations"][0]["value"]
        result = {"rate": round(float(val) / 100.0, 4)}
    except Exception:
        result = {"rate": 0.045}
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
