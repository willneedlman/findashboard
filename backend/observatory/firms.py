"""NASA FIRMS — VIIRS thermal anomalies as a flaring and industrial-heat gauge.

Gas flares and running smelters are hot enough to register as persistent thermal
anomalies in VIIRS. Summing fire radiant power (FRP, in megawatts) inside a fixed
polygon gives a daily index that tracks activity without anyone reporting it: the
same trick behind a "Permian gas flaring — 143.9 MW" headline.

What this is not: FRP is not production. A flare burns gas that was not captured,
so a rising flare signal can mean more drilling or worse takeaway capacity, and
the two are indistinguishable from orbit. The caption on every station built from
this module has to say so.

Requires FIRMS_MAP_KEY, free and instant from
https://firms.modaps.eosdis.nasa.gov/api/map_key/ . Absent the key every call
degrades to an empty series with a stated reason rather than a fabricated one.
"""
from __future__ import annotations

import csv
import io
import logging
import os
import statistics
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

_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"
_AVAIL = "https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv"
_TIMEOUT = 45
_CACHE_TTL = 6 * 3600

# NRT VIIRS at 375m. SNPP and NOAA-20 fly the same instrument on different orbits,
# so querying both roughly doubles daily revisit.
SOURCES = ("VIIRS_SNPP_NRT", "VIIRS_NOAA20_NRT")

# FIRMS caps a single request at 5 days and rejects anything wider outright.
_MAX_SPAN = 5

# Persistent industrial heat sits at high confidence; dropping low-confidence
# detections keeps transient false positives out of a series meant to be read as
# a level.
_MIN_CONFIDENCE = {"n", "h"}

# Thick cloud blocks VIIRS thermal detection, so an obscured day returns a handful
# of detections (or none) and a correspondingly tiny FRP. Recorded as a level that
# reads as "flaring collapsed", which is the same conflation this package exists to
# prevent, one layer down at the sensor rather than the feed.
#
# A day carrying under this share of the field's own median detection count is
# treated as a partial view rather than a reading: the field did not go quiet, the
# satellite could not see it. This is the thermal analogue of the Sentinel-2 cloud
# limit in copernicus.py.
_PARTIAL_VIEW_RATIO = 0.25

# The ratio test needs a stable baseline to mean anything. A field that genuinely
# flares very little has a median of one or two detections, where "25% of median"
# is noise and a zero is a real zero. Below this the filter stands down.
_MIN_BASELINE_DETECTIONS = 8


def available() -> bool:
    return bool(os.getenv("FIRMS_MAP_KEY", "").strip())


def data_availability(source: str) -> tuple[date, date] | None:
    """The archive window FIRMS actually holds for a product.

    Worth one request: a date before the archive begins is not a coverage gap,
    it is a period the feed never covered, and asking for it just burns
    round-trips on guaranteed failures.
    """
    key = os.getenv("FIRMS_MAP_KEY", "").strip()
    if not key:
        return None
    cache_key = f"firms_avail_{source}"
    cached = disk_get(cache_key)
    if cached:
        return date.fromisoformat(cached[0]), date.fromisoformat(cached[1])
    try:
        r = requests.get(f"{_AVAIL}/{key}/{source}", timeout=_TIMEOUT)
        r.raise_for_status()
        rows = list(csv.DictReader(io.StringIO(r.text.strip())))
    except Exception as e:                            # noqa: BLE001 — availability is advisory
        _log.warning("FIRMS availability lookup failed for %s: %s", source, e)
        return None
    for row in rows:
        try:
            span = (date.fromisoformat(row["min_date"]), date.fromisoformat(row["max_date"]))
        except (KeyError, ValueError):
            continue
        disk_set(cache_key, [span[0].isoformat(), span[1].isoformat()], ttl=_CACHE_TTL)
        return span
    return None


def _fetch_window(key: str, source: str, bbox: str, start: date, span: int) -> list[dict]:
    url = f"{_BASE}/{key}/{source}/{bbox}/{span}/{start.isoformat()}"
    r = requests.get(url, timeout=_TIMEOUT)
    r.raise_for_status()
    text = r.text.strip()
    if not text or text.lower().startswith("invalid") or text.lower().startswith("error"):
        raise RuntimeError(text[:160] or "empty FIRMS response")
    return list(csv.DictReader(io.StringIO(text)))


def radiant_power_series(
    bbox: tuple[float, float, float, float],
    *,
    days: int = 60,
    sources: tuple[str, ...] = SOURCES,
    as_of: date | None = None,
) -> dict:
    """Daily summed FRP inside a bounding box.

    bbox is (west, south, east, north) in degrees.

    Three outcomes, kept distinct:

    - A day whose detections sit at the field's normal level is a reading.
    - A day far below that level was obscured, not quiet. It is held out of
      `points` and listed in `partialViews`, so it can never drag the trailing
      mean toward a collapse that did not happen.
    - Over a field with little baseline flaring the ratio test is meaningless, so
      it stands down and a queried day with no detections is a genuine zero.

    Anything absent from `points` reaches the Pattern Grammar as a coverage gap,
    which is the honest reading of a day nobody could see.
    """
    today = as_of or datetime.now(timezone.utc).date()
    if not available():
        return {
            "points": [],
            "available": False,
            "reason": "FIRMS_MAP_KEY is not set. Get a free key at "
                      "https://firms.modaps.eosdis.nasa.gov/api/map_key/",
            "source": "NASA FIRMS VIIRS",
        }

    key = os.getenv("FIRMS_MAP_KEY", "").strip()
    west, south, east, north = bbox
    bbox_str = f"{west},{south},{east},{north}"
    # v4: earlier entries predate partial-view filtering, so they average obscured
    # days in as if they were levels.
    cache_key = f"firms_v4_{bbox_str}_{days}_{today.isoformat()}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached

    by_day: dict[str, dict] = {}
    covered: set[date] = set()
    errors: list[str] = []
    windows = failed = 0
    archive_start: date | None = None
    for source in sources:
        span_available = data_availability(source)
        start = today - timedelta(days=days)
        if span_available:
            # Clamp to the archive. Requesting before it begins fails every time
            # and would otherwise look like a data gap rather than a range error.
            archive_start = span_available[0] if archive_start is None else min(archive_start, span_available[0])
            start = max(start, span_available[0])
            end = min(today, span_available[1])
        else:
            end = today
        while start <= end:
            span = min(_MAX_SPAN, (end - start).days + 1)
            windows += 1
            try:
                rows = _fetch_window(key, source, bbox_str, start, span)
            except Exception as e:                    # noqa: BLE001 — partial coverage still useful
                failed += 1
                errors.append(f"{source}@{start}: {e}")
                start += timedelta(days=span)
                continue
            # The request succeeded, so every day it spanned was actually asked
            # about. That is what makes a later zero trustworthy rather than a
            # silence, and it is tracked here because FIRMS returns no row at all
            # for a day with nothing burning.
            for offset in range(span):
                covered.add(start + timedelta(days=offset))
            for row in rows:
                day = (row.get("acq_date") or "").strip()
                if not day:
                    continue
                if (row.get("confidence") or "").strip().lower() not in _MIN_CONFIDENCE:
                    continue
                try:
                    frp = float(row.get("frp") or 0.0)
                except (TypeError, ValueError):
                    continue
                entry = by_day.setdefault(day, {"d": day, "v": 0.0, "detections": 0})
                entry["v"] += frp
                entry["detections"] += 1
            start += timedelta(days=span)

    counts = [entry["detections"] for entry in by_day.values()]
    median_detections = statistics.median(counts) if counts else 0.0
    filtering = median_detections >= _MIN_BASELINE_DETECTIONS
    threshold = median_detections * _PARTIAL_VIEW_RATIO if filtering else 0.0

    partial: list[dict] = []
    if filtering:
        # A thin day is dropped rather than averaged in. Its FRP is kept on the
        # partial-view record so the reading is disclosed, not silently deleted.
        for day_iso, entry in sorted(by_day.items()):
            if entry["detections"] < threshold:
                partial.append({"d": day_iso, "detections": entry["detections"],
                                "frp": round(entry["v"], 2)})
        for row in partial:
            by_day.pop(row["d"], None)
        # Zero detections over a field that normally shows dozens is the extreme
        # partial view, not the field going dark. Under a high baseline it can
        # never be read as a confirmed zero.
        seen_partial = {row["d"] for row in partial}
        for day in covered:
            iso = day.isoformat()
            if iso not in by_day and iso not in seen_partial:
                partial.append({"d": iso, "detections": 0, "frp": 0.0})
        partial.sort(key=lambda row: row["d"])
    else:
        # Low-baseline field: the archive was queried and answered "nothing
        # burning", and with no persistent flare to obscure that is a real zero.
        for day in covered:
            by_day.setdefault(day.isoformat(), {"d": day.isoformat(), "v": 0.0, "detections": 0})

    points = [
        {"d": d, "v": round(entry["v"], 2), "detections": entry["detections"]}
        for d, entry in sorted(by_day.items())
    ]
    # A mostly-failed fetch that still returns a point or two is the dangerous
    # case: it looks like a real series and reads as collapsed activity. Say so
    # rather than let a handful of surviving windows stand in for the window.
    degraded = windows > 0 and failed / windows > 0.25
    out = {
        "points": points,
        "available": True,
        "reason": (
            f"{failed} of {windows} FIRMS requests failed; this series is incomplete "
            "and should not be read as a level."
        ) if degraded else None,
        "degraded": degraded,
        "archiveStart": archive_start.isoformat() if archive_start else None,
        "windows": windows,
        "failedWindows": failed,
        "partialViews": partial,
        "medianDetections": median_detections,
        "partialViewThreshold": round(threshold, 2) if filtering else None,
        "partialViewFiltering": filtering,
        "source": "NASA FIRMS VIIRS (SNPP + NOAA-20, 375m NRT)",
        "errors": errors[:4],
    }
    if points and not degraded:
        disk_set(cache_key, out, ttl=_CACHE_TTL)
    return out


def attribute_gaps(gaps: list[dict], series_result: dict) -> list[dict]:
    """Label a flaring gap with why VIIRS produced no usable reading.

    Copernicus coverage must not be used for this. Sentinel-1 and Sentinel-2 fly
    different orbits at different times from SNPP and NOAA-20; a clear radar pass
    says nothing about whether VIIRS could see thermal signal through cloud that
    day. Only FIRMS can explain a FIRMS gap.
    """
    partial_days = {row["d"]: row for row in series_result.get("partialViews") or []}
    out = []
    for gap in gaps:
        start = date.fromisoformat(gap["from"])
        end = date.fromisoformat(gap["to"])
        span = (end - start).days + 1
        obscured = sum(
            1 for offset in range(span)
            if (start + timedelta(days=offset)).isoformat() in partial_days
        )
        if obscured == span:
            reason, detail = "partial_view", (
                f"All {span} day(s) returned detections far below this field's baseline. "
                "The field was obscured, not quiet."
            )
        elif obscured:
            reason, detail = "partial_view", (
                f"{obscured} of {span} day(s) were obscured; the rest returned no reading at all."
            )
        else:
            reason, detail = "no_reading", (
                "VIIRS returned no usable detections and no partial view was recorded "
                "for these days."
            )
        out.append({**gap, "reason": reason, "detail": detail,
                    "obscuredDays": obscured, "gapDays": span})
    return out


# Fixed polygons for the sites worth a standing gauge. Bounding boxes are kept
# tight so an unrelated wildfire outside the field does not enter the series.
SITES: dict[str, dict] = {
    "permian": {
        "label": "Permian Basin — gas flaring",
        "bbox": (-104.6, 31.0, -101.5, 33.0),
        "unit": "MW",
        "caption": "Summed radiant power of flares burning across the Permian. "
                   "Rises when more gas is burned off, which can mean more drilling "
                   "or less capacity to capture it. It is not a production number.",
    },
    "bakken": {
        "label": "Bakken — gas flaring",
        "bbox": (-104.2, 47.4, -102.0, 48.8),
        "unit": "MW",
        "caption": "Summed radiant power of flares across the Bakken. Not a production number.",
    },
    "eagleford": {
        "label": "Eagle Ford — gas flaring",
        "bbox": (-99.5, 27.5, -97.0, 29.4),
        "unit": "MW",
        "caption": "Summed radiant power of flares across the Eagle Ford. Not a production number.",
    },
    "ghawar": {
        "label": "Ghawar — gas flaring",
        "bbox": (48.8, 24.0, 50.2, 26.5),
        "unit": "MW",
        "caption": "Summed radiant power over the Ghawar field. Not a production number.",
    },
}
