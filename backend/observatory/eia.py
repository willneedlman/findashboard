"""EIA v2 — US energy fundamentals as observation series.

Pairs with the VIIRS flaring gauge. Flaring measures gas that was burned rather
than captured; production measures what came out of the ground. Read together
they separate the two readings a single flare signal cannot: more drilling, or
less capacity to take the gas away.

These series are official statistics, not remote sensing, so they carry a
different failure mode. They are revised, and they publish on a lag of weeks to
months rather than days. The freshness window on each spec reflects the real
publication cadence, so a monthly series is not branded stale for being monthly.

Requires EIA_API_KEY, free and instant from https://www.eia.gov/opendata/register.php
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import date, datetime, timezone

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

_log = logging.getLogger(__name__)

_BASE = "https://api.eia.gov/v2"
_TIMEOUT = 40
_CACHE_TTL = 12 * 3600


def available() -> bool:
    return bool(os.getenv("EIA_API_KEY", "").strip())


def _normalise_period(period: str) -> str:
    """EIA periods come as YYYY, YYYY-MM or YYYY-MM-DD; the grammar wants a day.

    A monthly figure is pinned to the first of its month rather than spread
    across it, because attributing a month's production to any particular day
    would be an interpolation and this module does not make those.
    """
    period = str(period).strip()
    if len(period) == 4:
        return f"{period}-01-01"
    if len(period) == 7:
        return f"{period}-01"
    return period[:10]


def series(
    route: str,
    *,
    facets: dict[str, str] | None = None,
    frequency: str = "monthly",
    length: int = 120,
) -> dict:
    """Fetch one EIA v2 series as grammar-ready points."""
    if not available():
        return {
            "points": [],
            "available": False,
            "reason": "EIA_API_KEY is not set. Get a free key at "
                      "https://www.eia.gov/opendata/register.php",
            "source": "EIA",
        }

    key = os.getenv("EIA_API_KEY", "").strip()
    facets = facets or {}
    cache_key = f"eia_{route}_{frequency}_{length}_{'_'.join(f'{k}={v}' for k, v in sorted(facets.items()))}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached

    params: list[tuple[str, str]] = [
        ("api_key", key),
        ("frequency", frequency),
        ("data[0]", "value"),
        ("sort[0][column]", "period"),
        ("sort[0][direction]", "desc"),
        ("length", str(length)),
    ]
    for facet, value in facets.items():
        params.append((f"facets[{facet}][]", value))

    try:
        r = requests.get(f"{_BASE}/{route.strip('/')}/data/", params=params, timeout=_TIMEOUT)
        r.raise_for_status()
        body = r.json()
    except Exception as e:                            # noqa: BLE001 — fundamentals are best-effort
        _log.warning("EIA %s failed: %s", route, e)
        return {"points": [], "available": True, "reason": f"EIA request failed: {e}", "source": "EIA"}

    rows = (body.get("response") or {}).get("data") or []
    points = []
    for row in rows:
        value = row.get("value")
        period = row.get("period")
        if value is None or period is None:
            continue
        try:
            points.append({"d": _normalise_period(period), "v": float(value)})
        except (TypeError, ValueError):
            continue
    points.sort(key=lambda p: p["d"])

    units = rows[0].get("units") if rows else None
    out = {
        "points": points,
        "available": True,
        "reason": None,
        "units": units,
        "source": "EIA v2",
    }
    if points:
        disk_set(cache_key, out, ttl=_CACHE_TTL)
    return out


# Curated boards. Each entry is one subject with independently-read stations, so
# a production series and a stocks series are never blended into an "energy index".
#
# Units are left to the API. EIA reports monthly totals (MMCF, MBBL), not daily
# rates, and hand-labelling a station "MMcf/d" against an MMCF series would put a
# wrong unit under a right number.
BOARDS: dict[str, dict] = {
    "us_crude": {
        "label": "US crude supply",
        "stations": [
            {
                "key": "production", "label": "Crude production", "kind": "flow", "unit": "MBBL",
                "route": "petroleum/crd/crpdn", "frequency": "monthly",
                "facets": {"duoarea": "NUS", "product": "EPC0", "process": "FPF"},
                "stale_after_days": 120, "interval_days": 30, "window": 3,
                "caption": "US field production of crude oil, monthly total. Official statistic, revised and published on a lag.",
            },
            {
                "key": "stocks", "label": "Crude stocks", "kind": "stock", "unit": "MBBL",
                "route": "petroleum/stoc/wstk", "frequency": "weekly",
                "facets": {"duoarea": "NUS", "product": "EPC0"},
                "stale_after_days": 21, "interval_days": 7, "window": 4,
                "caption": "Commercial crude inventories excluding the SPR.",
            },
        ],
    },
    "us_natgas": {
        "label": "US natural gas",
        "stations": [
            {
                "key": "marketed", "label": "Marketed production", "kind": "flow", "unit": "MMCF",
                "route": "natural-gas/prod/sum", "frequency": "monthly",
                "facets": {"duoarea": "NUS", "process": "VGM"},
                "stale_after_days": 120, "interval_days": 30, "window": 3,
                "caption": "Marketed natural gas production. Gas that reached market, so it already excludes what was flared.",
            },
            {
                "key": "flared", "label": "Vented and flared", "kind": "flow", "unit": "MMCF",
                "route": "natural-gas/prod/sum", "frequency": "monthly",
                "facets": {"duoarea": "NUS", "process": "VGV"},
                # Reported far later than the rest; it is normally stale by design
                # rather than by failure, and the board is expected to say so.
                "stale_after_days": 400, "interval_days": 30, "window": 3,
                "caption": "The official vented-and-flared volume. Measures the same thing the "
                           "satellite flaring board infers, by an unrelated method and on a long "
                           "reporting lag, so the two are worth reading against each other.",
            },
            {
                "key": "storage", "label": "Working gas in storage", "kind": "stock", "unit": "BCF",
                "route": "natural-gas/stor/wkly", "frequency": "weekly",
                "facets": {"duoarea": "R48", "process": "SWO"},
                "stale_after_days": 21, "interval_days": 7, "window": 4,
                "caption": "Working gas held in Lower 48 underground storage.",
            },
        ],
    },
}
