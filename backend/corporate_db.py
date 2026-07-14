"""Shared read access to data/corporate.db — WRDS TRACE bond prices, LSEG
insider/institutional ownership, and SDC M&A deals, all populated by the
backend/logistics/ingest_* ETL scripts.

DB_PATH is the single source of truth for the file location (bond_prices.py
and routers/corporate.py both used to compute it independently, which risked
the two drifting apart) and is monkeypatchable in tests so they never touch
the real, already-populated database.
"""
from __future__ import annotations
import logging
import os
import sqlite3

logger = logging.getLogger("backend.corporate_db")

DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "corporate.db"))


def exists() -> bool:
    return os.path.exists(DB_PATH)


def query(sql: str, params: tuple = ()) -> list:
    """Run a read query against corporate.db, returning sqlite3.Row results.
    Returns [] when the DB doesn't exist yet or on any query error — callers
    already treat "no LSEG/WRDS data" as a signal to fall back elsewhere."""
    if not exists():
        return []
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()
    except Exception as e:
        logger.warning("corporate_db query failed: %s | sql=%s", e, sql)
        return []


def query_one(sql: str, params: tuple = ()):
    rows = query(sql, params)
    return rows[0] if rows else None
