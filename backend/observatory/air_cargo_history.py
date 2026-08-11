"""Accrue a daily history of freighter movements per cargo hub.

`free_ingest.air_cargo()` reports a single settled 24h window. That is enough to
render a map but not to say whether a hub is busier than usual, because there is
nothing to compare against. This module records one sample per hub per day so a
baseline can build, which is the prerequisite for reading the series at all.

The undercount problem is the same one VIIRS has with cloud. OpenSky is
community ADS-B: receiver coverage is uneven and a hub can look quiet because
nobody heard it. So the board applies the same partial-view rule as
observatory.firms — a day far below a hub's own median is held out as a coverage
artifact rather than averaged in as a slow day. That rule needs a median, and a
median needs history, which is what this file exists to produce.

Nothing here backfills. On first run the series is empty and every board built
from it says so; a baseline worth trusting is roughly three weeks away.
"""
from __future__ import annotations

import json
import logging
import os
import statistics
import threading
import time
from datetime import date, datetime, timedelta, timezone

_log = logging.getLogger(__name__)

_PATH = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "..", "data", "air_cargo_history.json"))

# One sample per hub per day. Two years is ample for a seasonal read and keeps
# the file trivially small (a few hundred KB at 30 hubs).
_MAX_DAYS = 730

# Same shape as the FIRMS filter and for the same reason: a hub reporting far
# below its own baseline was probably not heard, rather than genuinely idle.
_PARTIAL_VIEW_RATIO = 0.25
_MIN_BASELINE_MOVES = 8

_lock = threading.Lock()
_thread: threading.Thread | None = None

# A settled 24h window lands roughly twice a day; sampling more often just
# rewrites the same day with the same numbers.
_SAMPLE_INTERVAL_S = 6 * 3600


def _load() -> dict:
    try:
        with open(_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_PATH), exist_ok=True)
        tmp = f"{_PATH}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, separators=(",", ":"))
        os.replace(tmp, _PATH)
    except OSError as e:                              # noqa: BLE001 — history is best-effort
        _log.warning("air cargo history write failed: %s", e)


def record_sample(hubs: list[dict], *, as_of: date | None = None) -> int:
    """Store today's movement count for each hub. Returns hubs recorded.

    Keyed by day, so repeated samples inside one day overwrite rather than
    accumulate — two readings of the same settled window are one observation,
    not two.
    """
    day = (as_of or datetime.now(timezone.utc).date()).isoformat()
    written = 0
    with _lock:
        data = _load()
        for hub in hubs or []:
            icao = str(hub.get("icao") or "").strip().upper()
            moves = hub.get("movements")
            if not icao or moves is None:
                continue
            try:
                moves = float(moves)
            except (TypeError, ValueError):
                continue
            entry = data.setdefault(icao, {"city": hub.get("city") or icao, "days": {}})
            entry["city"] = hub.get("city") or entry.get("city") or icao
            entry["days"][day] = moves
            written += 1

        cutoff = ((as_of or datetime.now(timezone.utc).date()) - timedelta(days=_MAX_DAYS)).isoformat()
        for entry in data.values():
            entry["days"] = {d: v for d, v in entry["days"].items() if d >= cutoff}
        _save(data)
    return written


def hub_series(icao: str) -> dict:
    """Grammar-ready points for one hub, plus the days held out as unheard."""
    with _lock:
        data = _load()
    entry = data.get(icao.strip().upper())
    if not entry:
        return {"icao": icao.upper(), "city": icao.upper(), "points": [],
                "partialViews": [], "medianMoves": 0.0, "partialViewFiltering": False}

    days = sorted(entry.get("days", {}).items())
    values = [v for _, v in days]
    median = statistics.median(values) if values else 0.0
    filtering = median >= _MIN_BASELINE_MOVES
    threshold = median * _PARTIAL_VIEW_RATIO if filtering else 0.0

    points, partial = [], []
    for day, value in days:
        if filtering and value < threshold:
            partial.append({"d": day, "movements": value})
        else:
            points.append({"d": day, "v": value})

    return {
        "icao": icao.strip().upper(),
        "city": entry.get("city") or icao.upper(),
        "points": points,
        "partialViews": partial,
        "medianMoves": median,
        "partialViewThreshold": round(threshold, 2) if filtering else None,
        "partialViewFiltering": filtering,
        "sampledDays": len(days),
    }


def hubs_known() -> list[dict]:
    """Hubs with accrued history, most-sampled first."""
    with _lock:
        data = _load()
    hubs = [
        {"icao": icao, "city": entry.get("city") or icao, "days": len(entry.get("days", {}))}
        for icao, entry in data.items()
    ]
    return sorted(hubs, key=lambda h: (-h["days"], h["icao"]))


def _run_sampler() -> None:
    from logistics import free_ingest

    while True:
        try:
            payload = free_ingest.air_cargo() or {}
            written = record_sample(payload.get("hubs") or [])
            if written:
                _log.info("air cargo history: recorded %d hub(s)", written)
        except Exception as e:                        # noqa: BLE001 — sampler must never die
            _log.warning("air cargo sample failed: %s", e)
        time.sleep(_SAMPLE_INTERVAL_S)


def start_sampler() -> None:
    """Begin accruing daily hub movements. Safe to call more than once."""
    global _thread
    if _thread and _thread.is_alive():
        return
    _thread = threading.Thread(target=_run_sampler, name="air-cargo-history", daemon=True)
    _thread.start()
