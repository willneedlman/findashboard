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
