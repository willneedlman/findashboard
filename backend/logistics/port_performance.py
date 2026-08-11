"""Read the compact Dewey ocean-port performance serving database.

Network access is deliberately confined to ``ingest_port_performance``.  The
request path uses this SQLite reader only, so map interaction stays responsive
and a Dewey outage cannot take the API down.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import date


_DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "port_performance.db"))


def available() -> bool:
    return os.path.isfile(_DB_PATH)


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{_DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _bbox_clause(bbox: str | None) -> tuple[str, list[float]]:
    if not bbox:
        return "", []
    try:
        south, west, north, east = (float(v) for v in bbox.split(","))
    except (TypeError, ValueError):
        return "", []
    return " WHERE latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?", [south, north, west, east]


def latest_ports(bbox: str | None = None, limit: int = 1200) -> dict:
    """Latest import/export snapshot for each port in a viewport."""
    if not available():
        return {"ports": [], "available": False, "source": "Dewey Data"}
    clause, params = _bbox_clause(bbox)
    with _conn() as conn:
        rows = conn.execute(
            "SELECT port_id, name, country, latitude, longitude, latest_date, "
            "import_performance_hours, import_change_pct, import_flag, import_teu, "
            "export_performance_hours, export_change_pct, export_flag, export_teu, "
            "monthly_performance_hours, monthly_vessels, monthly_teu "
            "FROM port_latest" + clause + " ORDER BY latest_date DESC, name LIMIT ?",
            [*params, max(1, min(limit, 2500))],
        ).fetchall()
        meta = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM metadata")}
    return {
        "ports": [dict(r) for r in rows], "available": True, "source": "Dewey Data",
        "refresh": meta.get("refresh"), "source_as_of": meta.get("source_as_of"),
        "frequency": "daily import/export, monthly operating summary",
    }


def history(port_id: str, days: int = 180) -> dict:
    if not available():
        return {"port_id": port_id, "series": [], "available": False, "source": "Dewey Data"}
    days = max(7, min(days, 730))
    cutoff = date.fromordinal(date.today().toordinal() - days).isoformat()
    with _conn() as conn:
        rows = conn.execute(
            "SELECT event_date, direction, performance_hours, change_pct, flag, teu, vessels "
            "FROM daily_performance WHERE port_id = ? AND event_date >= ? ORDER BY event_date, direction",
            (port_id, cutoff),
        ).fetchall()
    return {"port_id": port_id, "series": [dict(r) for r in rows], "available": True, "source": "Dewey Data"}


# Each metric is kept on its own track per direction. Import dwell and export
# dwell answer different questions at the same berth, and TEU against vessel
# count is the pair that separates "more boxes" from "bigger ships" — a
# distinction that disappears the moment they are averaged into a port index.
BOARD_TRACKS: tuple[tuple[str, str, str], ...] = (
    ("import_dwell", "import", "performance_hours"),
    ("import_teu", "import", "teu"),
    ("import_vessels", "import", "vessels"),
    ("export_dwell", "export", "performance_hours"),
    ("export_teu", "export", "teu"),
    ("export_vessels", "export", "vessels"),
)


def board_series(port_id: str, days: int = 180) -> dict:
    """Per-direction daily tracks for one port, shaped for the Pattern Grammar.

    A row missing its metric is left out rather than zero-filled: Dewey reports
    nothing for a day with no berth activity, and a zero dwell time would read as
    a port that cleared instantly instead of one nobody measured.
    """
    if not available():
        return {"port_id": port_id, "tracks": {}, "available": False, "source": "Dewey Data"}
    days = max(7, min(days, 730))
    cutoff = date.fromordinal(date.today().toordinal() - days).isoformat()
    with _conn() as conn:
        rows = conn.execute(
            "SELECT event_date, direction, performance_hours, teu, vessels "
            "FROM daily_performance WHERE port_id = ? AND event_date >= ? "
            "ORDER BY event_date",
            (port_id, cutoff),
        ).fetchall()
        port = conn.execute(
            "SELECT port_id, name, country, latitude, longitude, latest_date "
            "FROM port_latest WHERE port_id = ?", (port_id,),
        ).fetchone()
        meta = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM metadata")}

    tracks: dict[str, list[dict]] = {key: [] for key, _, _ in BOARD_TRACKS}
    for row in rows:
        for key, direction, column in BOARD_TRACKS:
            if row["direction"] != direction:
                continue
            value = row[column]
            if value is None:
                continue
            tracks[key].append({"d": row["event_date"], "v": float(value)})

    return {
        "port_id": port_id,
        "port": dict(port) if port else None,
        "tracks": tracks,
        "available": True,
        "source": "Dewey Data",
    }
