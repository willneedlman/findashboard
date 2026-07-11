"""UN Comtrade public/preview API client — free bilateral trade statistics.

The public preview tier needs no key (``https://comtradeapi.un.org/public/v1``)
and returns, for one reporter + one commodity + one period, every partner
country's trade value and net weight. A subscription key (env ``COMTRADE_KEY``)
is used automatically when present for higher limits. Trade data updates monthly
or annually, so responses are cached 24h. Any failure returns None so the tool
degrades to an empty state rather than erroring.
"""
from __future__ import annotations

import logging
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

logger = logging.getLogger(__name__)

_BASE = "https://comtradeapi.un.org/public/v1"
_TTL = 24 * 3600

# M49 area code -> {name, iso}. Comtrade's preview returns numeric codes only, so
# partner (and reporter) names are resolved from this bundled reference table.
import json
_AREAS: dict = {}
try:
    with open(os.path.join(os.path.dirname(__file__), "data", "comtrade_areas.json")) as _f:
        _AREAS = json.load(_f)
except Exception:                                     # pragma: no cover
    _AREAS = {}


def area_name(code) -> str | None:
    a = _AREAS.get(str(code))
    return a["name"] if a else (str(code) if code is not None else None)


def area_iso(code) -> str | None:
    a = _AREAS.get(str(code))
    return a["iso"] if a else None


def _headers() -> dict:
    key = os.getenv("COMTRADE_KEY")
    return {"Ocp-Apim-Subscription-Key": key} if key else {}


def flows(reporter: str, period: str, cmd: str, flow: str,
          freq: str = "A", cl: str = "HS", typ: str = "C") -> list | None:
    """Every partner's trade rows for one reporter/commodity/period/flow.
    Returns the raw Comtrade rows (each has partnerDesc, primaryValue, netWgt,
    qty, qtyUnitAbbr, ...) or None on failure."""
    ck = f"comtrade:{typ}{freq}{cl}:{reporter}:{period}:{cmd}:{flow}"
    cached = disk_get(ck)
    if cached is not None:
        return cached.get("rows") if cached else None
    try:
        r = requests.get(
            f"{_BASE}/preview/{typ}/{freq}/{cl}",
            params={"reporterCode": reporter, "period": period, "cmdCode": cmd, "flowCode": flow},
            headers=_headers(), timeout=25,
        )
        if r.status_code != 200:
            logger.info("Comtrade flows %s: HTTP %s", ck, r.status_code)
            disk_set(ck, {}, ttl=1800)
            return None
        rows = r.json().get("data") or []
    except Exception as e:
        logger.info("Comtrade flows failed %s: %s", ck, e)
        disk_set(ck, {}, ttl=1800)
        return None
    disk_set(ck, {"rows": rows}, ttl=_TTL)
    return rows


def world_share(reporter: str, period: str, freq: str = "A", typ: str = "C") -> float | None:
    """The reporter's share of world trade for the period (0..1), or None."""
    ck = f"comtrade_ws:{typ}{freq}:{reporter}:{period}"
    cached = disk_get(ck)
    if cached is not None:
        return cached.get("v") if cached else None
    try:
        r = requests.get(
            f"{_BASE}/getWorldShare/{typ}/{freq}",
            params={"reporterCode": reporter, "period": period},
            headers=_headers(), timeout=20,
        )
        if r.status_code != 200:
            disk_set(ck, {}, ttl=1800)
            return None
        data = r.json().get("data") or []
        v = data[0].get("worldShare") if data else None
    except Exception:
        disk_set(ck, {}, ttl=1800)
        return None
    disk_set(ck, {"v": v}, ttl=_TTL)
    return v
