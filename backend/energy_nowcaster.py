"""AIS-driven real-time nowcasting for the Global Energy Flows tool.

IMF PortWatch (routers/maritime.py) is the authoritative chokepoint-transit source
but lags 3-4 days. This module bridges that gap: it records live tanker/LNG
crossings of energy chokepoints (fed by the aisstream/VesselAPI worker) into a
disk-backed 96h event log, then aggregates them into a per-chokepoint nowcast that
the maritime endpoints merge onto the delayed PortWatch baseline.

Honest scope: AIS carries no deadweight tonnage, so `capacity_est_dwt` is a coarse
hull-displacement PROXY (LOA x beam x draught x block-coefficient x seawater
density), not a manifest figure — surfaced only alongside a confidence tier and a
coverage percentage. Transit COUNTS are the reliable signal; capacity is directional.

Storage is the shared SQLite disk cache (disk_cache), not an in-memory list, so the
log stays off the 1GB-VM heap and survives restarts. The module is deliberately
isolated (no FastAPI / no maritime import) — the router passes in coverage/activity.
"""
from __future__ import annotations

import logging
import sqlite3
import time
from datetime import datetime, timezone

import disk_cache as _dc

logger = logging.getLogger("energy_nowcaster")

WINDOW_S = 96 * 3600                       # trailing nowcast window (96h)

# Block coefficient by cargo class: how "boxy" the hull is. Tankers are full-formed
# (~0.80-0.85); LNG carriers are finer (~0.72-0.76). Displacement ~= L*B*T*Cb*rho.
_CB = {"tanker": 0.82, "lng": 0.74}
_RHO = 1.025                               # seawater density, t/m^3


def _capacity_est(category: str, draught, loa, beam) -> float | None:
    """Coarse laden displacement (tonnes) from static draught + hull dimensions.
    None when any input is missing/zero — the transit is still counted, just
    without a tonnage estimate."""
    try:
        d, l, b = float(draught or 0), float(loa or 0), float(beam or 0)
    except (TypeError, ValueError):
        return None
    if d <= 0 or l <= 0 or b <= 0:
        return None
    cb = _CB.get(category, 0.80)
    return round(l * b * d * cb * _RHO)


def _ensure_table() -> None:
    try:
        with _dc._write_lock:
            c = _dc._conn()
            c.execute(
                "CREATE TABLE IF NOT EXISTS ais_transits "
                "(mmsi TEXT, choke TEXT, ts REAL, category TEXT, dwt_est REAL)"
            )
            c.execute("CREATE INDEX IF NOT EXISTS idx_transits_choke_ts ON ais_transits(choke, ts)")
            c.commit()
    except sqlite3.OperationalError as e:
        logger.warning("ais_transits table init failed: %s", e)


_ensure_table()


def record_transit(mmsi: str, choke: str, category: str,
                   draught=None, loa=None, beam=None, now: float | None = None) -> None:
    """Log one chokepoint crossing by an energy vessel and prune the 96h window.
    Called by the maritime crossing detector on each outside->inside edge; never
    raises into the caller.

    NOTE (documented hook): load-state (laden/ballast) inference is intentionally
    out of scope — AIS static draught is crew-set and unreliable. A future pass can
    derive it here from draught deltas or SOG without changing this signature.
    """
    now = now if now is not None else time.time()
    dwt = _capacity_est(category, draught, loa, beam)
    try:
        with _dc._write_lock:
            c = _dc._conn()
            c.execute(
                "INSERT INTO ais_transits (mmsi, choke, ts, category, dwt_est) VALUES (?, ?, ?, ?, ?)",
                (str(mmsi), choke, now, category, dwt),
            )
            c.execute("DELETE FROM ais_transits WHERE ts < ?", (now - WINDOW_S,))
            c.commit()
    except sqlite3.OperationalError as e:
        logger.warning("record_transit failed for %s@%s: %s", mmsi, choke, e)
        return
    logger.info("nowcast transit: mmsi=%s choke=%s cat=%s dwt_est=%s", mmsi, choke, category, dwt)


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _confidence(covered: bool, connected: bool, calls: int, last_ts: float | None,
                activity: int, now: float) -> str:
    """Tier the nowcast trust: none (no AIS bbox over this chokepoint), stale (feed
    down), then high/medium/low by live activity + event recency."""
    if not covered:
        return "none"
    if not connected:
        return "stale"
    recency_h = (now - last_ts) / 3600 if last_ts else float("inf")
    if activity >= 3 and recency_h < 6:
        return "high"
    if calls > 0 and recency_h < 24:
        return "medium"
    return "low"


def nowcast(baseline_calls_per_day: dict[str, float], choke_ids: list[str],
            covered_ids: set[str], connected: bool,
            activity: dict[str, int] | None = None, now: float | None = None) -> dict[str, dict]:
    """Per-chokepoint live nowcast over the trailing 96h, keyed by chokepoint id.

    baseline_calls_per_day: PortWatch calls/day per chokepoint (for the delta).
    covered_ids: chokepoints that fall under an AIS bounding box.
    connected: AIS worker connection status.
    activity: distinct energy vessels currently near each chokepoint (confidence).
    """
    now = now if now is not None else time.time()
    activity = activity or {}
    since = now - WINDOW_S

    agg: dict[str, tuple] = {}
    try:
        cur = _dc._conn().execute(
            "SELECT choke, COUNT(*), SUM(dwt_est), MAX(ts), COUNT(dwt_est) "
            "FROM ais_transits WHERE ts >= ? GROUP BY choke",
            (since,),
        )
        for choke, cnt, cap, last_ts, cap_cnt in cur.fetchall():
            agg[choke] = (cnt, cap, last_ts, cap_cnt)
    except sqlite3.OperationalError as e:
        logger.warning("nowcast query failed: %s", e)

    out: dict[str, dict] = {}
    for cid in choke_ids:
        cnt, cap, last_ts, cap_cnt = agg.get(cid, (0, None, None, 0))
        raw_rate = cnt / (WINDOW_S / 86400)                 # crossings per day, unrounded
        base = baseline_calls_per_day.get(cid)
        vs = round((raw_rate - base) / base * 100, 1) if base else None   # delta off the raw rate
        out[cid] = {
            "calls_96h": cnt,
            "calls_per_day_live": round(raw_rate, 2),
            "capacity_est_dwt": round(cap) if cap else None,
            "capacity_coverage_pct": round(cap_cnt / cnt * 100) if cnt else None,
            "live_vs_baseline_pct": vs,
            "confidence": _confidence(cid in covered_ids, connected, cnt, last_ts,
                                      activity.get(cid, 0), now),
            "as_of": _iso(last_ts),
        }
    return out
