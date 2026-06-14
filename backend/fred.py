"""Shared FRED (St. Louis Fed) data helpers, used by the rates and market routers."""
import os
import requests

_FRED_KEY = os.getenv("FRED_API_KEY", "")


def observations(series_id: str, limit: int) -> list[dict]:
    """Latest `limit` observations for a FRED series, ascending by date, with
    missing ('.') values dropped. Returns [] on any failure so callers degrade
    softly rather than erroring."""
    if not _FRED_KEY:
        return []
    try:
        resp = requests.get(
            "https://api.stlouisfed.org/fred/series/observations",
            params={"series_id": series_id, "sort_order": "desc", "limit": limit,
                    "api_key": _FRED_KEY, "file_type": "json"},
            timeout=8,
        )
        obs = resp.json().get("observations", [])
    except Exception:
        return []
    out = []
    for o in obs:
        v = o.get("value")
        if v in (None, ".", ""):
            continue
        try:
            out.append({"date": o["date"], "value": float(v)})
        except (ValueError, KeyError):
            continue
    out.reverse()  # ascending by date
    return out


def yoy(levels: list[dict]) -> list[dict]:
    """Year-over-year % change of a monthly index series (value[t] vs value[t-12])."""
    out = []
    for i in range(12, len(levels)):
        prev = levels[i - 12]["value"]
        if prev:
            out.append({"date": levels[i]["date"],
                        "value": round((levels[i]["value"] / prev - 1) * 100, 2)})
    return out
