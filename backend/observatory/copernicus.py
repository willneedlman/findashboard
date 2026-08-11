"""Copernicus acquisition coverage — when a satellite actually looked.

The Copernicus Data Space catalogue is open: no key, no account, no quota
negotiation. This module never downloads imagery. It asks a cheaper and more
useful question — did a satellite pass over this point on this day, and was the
view usable — which is the difference between three statements a chart otherwise
renders identically:

    no observation, no pass          → a coverage gap. Nothing can be said.
    no observation, clear pass       → a real absence. The zero is trustworthy.
    no observation, pass under cloud → a gap, and we can name why.

Sentinel-1 carries radar, so cloud is irrelevant and every pass counts as usable;
that is exactly why it sees ships when optical cannot. Sentinel-2 is optical, so
a pass only counts when cloud over the scene is below the threshold.
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import date, datetime, timedelta, timezone

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

_log = logging.getLogger(__name__)

_ODATA = "https://catalogue.dataspace.copernicus.eu/odata/v1/Products"

SAR = "SENTINEL-1"
OPTICAL = "SENTINEL-2"

# Above this share of the scene under cloud, an optical pass is treated as no
# look at all. Deliberately generous: a 40%-clouded scene may still leave the
# anchorage visible, and calling a usable pass a gap is the more damaging error.
CLOUD_LIMIT = 40.0

_TIMEOUT = 40
_CACHE_TTL = 6 * 3600


def _iso(day: date) -> str:
    return datetime(day.year, day.month, day.day, tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def acquisitions(
    lat: float,
    lon: float,
    *,
    days: int = 90,
    collection: str = SAR,
    as_of: date | None = None,
) -> list[dict]:
    """Every catalogued acquisition intersecting a point, newest first.

    Duplicate processing levels of one overpass (L1C and L2A of the same scene)
    collapse to a single acquisition, because two products from one satellite
    pass are still one look at the ground.
    """
    today = as_of or datetime.now(timezone.utc).date()
    since = today - timedelta(days=days)
    key = f"copernicus_{collection}_{lat:.3f}_{lon:.3f}_{days}_{today.isoformat()}"
    cached = disk_get(key)
    if cached is not None:
        return cached

    params = {
        "$filter": (
            f"Collection/Name eq '{collection}' and "
            f"OData.CSC.Intersects(area=geography'SRID=4326;POINT({lon} {lat})') and "
            f"ContentDate/Start gt {_iso(since)}"
        ),
        "$orderby": "ContentDate/Start desc",
        "$top": 200,
        "$expand": "Attributes",
    }
    try:
        r = requests.get(_ODATA, params=params, timeout=_TIMEOUT)
        r.raise_for_status()
        body = r.json()
    except Exception as e:                            # noqa: BLE001 — coverage is best-effort
        _log.warning("Copernicus %s query failed at %.3f,%.3f: %s", collection, lat, lon, e)
        return []

    seen: dict[tuple[str, str], dict] = {}
    for product in body.get("value", []):
        attrs = {a["Name"]: a.get("Value") for a in (product.get("Attributes") or [])}
        start = (product.get("ContentDate") or {}).get("Start") or ""
        if not start:
            continue
        cloud = attrs.get("cloudCover")
        try:
            cloud = float(cloud) if cloud is not None else None
        except (TypeError, ValueError):
            cloud = None
        # One overpass, keyed by instant and tile, keeps its lowest reported cloud.
        dedupe_key = (start[:19], str(attrs.get("tileId") or attrs.get("orbitNumber") or ""))
        entry = {
            "at": start[:19],
            "day": start[:10],
            "collection": collection,
            "platform": attrs.get("platformShortName") or collection,
            "cloudCover": cloud,
            "orbitDirection": attrs.get("orbitDirection"),
            "usable": True if collection == SAR else (cloud is not None and cloud <= CLOUD_LIMIT),
        }
        prior = seen.get(dedupe_key)
        if prior is None or (
            entry["cloudCover"] is not None
            and (prior["cloudCover"] is None or entry["cloudCover"] < prior["cloudCover"])
        ):
            seen[dedupe_key] = entry

    out = sorted(seen.values(), key=lambda a: a["at"], reverse=True)
    disk_set(key, out, ttl=_CACHE_TTL)
    return out


def coverage_by_day(
    lat: float,
    lon: float,
    *,
    days: int = 90,
    collections: tuple[str, ...] = (SAR, OPTICAL),
    as_of: date | None = None,
) -> dict[str, dict]:
    """Per-day look record: how many passes, how many usable, and the best view."""
    out: dict[str, dict] = {}
    for collection in collections:
        for acq in acquisitions(lat, lon, days=days, collection=collection, as_of=as_of):
            row = out.setdefault(acq["day"], {"passes": 0, "usable": 0, "bestCloud": None, "platforms": []})
            row["passes"] += 1
            if acq["usable"]:
                row["usable"] += 1
            if acq["cloudCover"] is not None:
                row["bestCloud"] = (
                    acq["cloudCover"] if row["bestCloud"] is None
                    else min(row["bestCloud"], acq["cloudCover"])
                )
            if acq["platform"] not in row["platforms"]:
                row["platforms"].append(acq["platform"])
    return out


def attribute_gaps(gaps: list[dict], coverage: dict[str, dict]) -> list[dict]:
    """Label each coverage gap with why the feed went quiet.

    A gap the satellites can explain is a different object from one they cannot.
    'No satellite pass' is a limit of orbit mechanics and nobody's fault; a gap
    with clear passes throughout means the detection pipeline dropped days, which
    is a bug worth surfacing rather than smoothing over.
    """
    out = []
    for gap in gaps:
        start = date.fromisoformat(gap["from"])
        end = date.fromisoformat(gap["to"])
        passes = usable = 0
        clouded = 0
        day = start
        while day <= end:
            row = coverage.get(day.isoformat())
            if row:
                passes += row["passes"]
                usable += row["usable"]
                if row["usable"] == 0 and row["passes"]:
                    clouded += 1
            day += timedelta(days=1)

        if passes == 0:
            reason, detail = "no_pass", "No satellite passed over this point in the window."
        elif usable == 0:
            reason, detail = "cloud", f"{passes} pass(es) in the window, all above the cloud limit."
        elif usable and clouded:
            reason, detail = "partial", f"{usable} usable pass(es), {clouded} day(s) lost to cloud."
        else:
            reason, detail = "unexplained", (
                f"{usable} usable pass(es) in the window but no reading landed. "
                "The look was available; the measurement is missing."
            )
        out.append({**gap, "reason": reason, "detail": detail,
                    "passes": passes, "usablePasses": usable})
    return out


def coverage_summary(coverage: dict[str, dict], *, days: int) -> dict:
    """Headline look-rate for a window, for the freshness strip."""
    look_days = sum(1 for row in coverage.values() if row["usable"] > 0)
    pass_days = len(coverage)
    return {
        "windowDays": days,
        "daysWithPass": pass_days,
        "daysWithUsablePass": look_days,
        "lookRate": round(look_days / days, 3) if days else 0.0,
        "cloudLimit": CLOUD_LIMIT,
        "source": "Copernicus Data Space (open catalogue, no key)",
    }
