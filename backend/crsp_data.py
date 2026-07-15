"""Shared CRSP (survivorship-bias-free) data access.

Reads the pre-built data/crsp.db (see backend/logistics/ingest_crsp.py). This
is the single source for point-in-time S&P 500 membership and daily returns
for backtesting, as an explicit opt-in alternative to the live yfinance path
(which only has data for currently-listed tickers and today's index members).

crsp_daily.ret already embeds the realized delisting return on a permno's
final day (verified against WRDS CIZ output for both a routine buyout and an
outright bankruptcy) — no separate merge against crsp_delisting is needed for
the return series itself; crsp_delisting is only used here as metadata for
UI transparency (which names left, when, and why).
"""
from __future__ import annotations

import os
import sqlite3

import pandas as pd

DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "crsp.db"))


def available() -> bool:
    return os.path.exists(DB_PATH)


def _conn() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH)


def point_in_time_members(as_of: str) -> list[dict]:
    """Every permno that was an S&P 500 constituent on `as_of` (YYYY-MM-DD),
    with its most-recently-known ticker/name as of that membership stint."""
    conn = _conn()
    try:
        permno_rows = conn.execute(
            "SELECT DISTINCT permno FROM crsp_membership "
            "WHERE mbr_start <= ? AND (mbr_end >= ? OR mbr_end = '')",
            (as_of, as_of),
        ).fetchall()
        permnos = [r[0] for r in permno_rows]
        if not permnos:
            return []
        placeholders = ",".join("?" * len(permnos))
        # The final row of a delisted name's series (the delisting-realization day)
        # frequently has a blank ticker — exclude those from the "latest" pick or
        # every delisted name's ticker resolves to empty.
        rows = conn.execute(
            f"""
            SELECT c.permno, c.ticker FROM crsp_daily c
            JOIN (
                SELECT permno, MAX(date) AS max_date FROM crsp_daily
                WHERE permno IN ({placeholders}) AND date <= ? AND ticker != ''
                GROUP BY permno
            ) latest ON c.permno = latest.permno AND c.date = latest.max_date AND c.ticker != ''
            """,
            (*permnos, as_of),
        ).fetchall()
        return [{"permno": p, "ticker": t} for p, t in rows if t]
    finally:
        conn.close()


def portfolio_returns(permnos: list[str], start: str, end: str) -> pd.Series:
    """Equal-weighted daily return across the given permnos — a delisted name's
    weight silently redistributes across the remaining survivors from its last
    observed date onward.

    Aggregated directly in SQL (GROUP BY ... AVG) rather than pulled into a wide
    date x permno pandas pivot table: a 500+ name universe pivoted wide
    materializes a large dense matrix (every name x every trading day) just to
    immediately collapse it back to a single per-day mean, which OOM'd the 1GB
    prod VM under concurrent load. SQL's AVG() already skips NULLs the same way
    pandas' skipna mean does, so this returns the identical series while only
    ever holding one row per trading day in memory."""
    if not permnos:
        return pd.Series(dtype=float)
    conn = _conn()
    try:
        placeholders = ",".join("?" * len(permnos))
        # A small number of (permno, date) pairs are duplicated in the WRDS CIZ
        # export (same value repeated) — collapse to one row per permno-day
        # BEFORE averaging across permnos, or a duplicated row silently double-
        # weights that name on that day. SQLite streams both aggregation stages,
        # so this still never materializes more than the final ~N-trading-days
        # result set in Python.
        df = pd.read_sql_query(
            f"""
            SELECT date, AVG(ret) AS ret FROM (
                SELECT permno, date, AVG(ret) AS ret FROM crsp_daily
                WHERE permno IN ({placeholders}) AND date >= ? AND date <= ? AND ret IS NOT NULL
                GROUP BY permno, date
            ) per_name
            GROUP BY date ORDER BY date
            """,
            conn, params=(*permnos, start, end),
        )
    finally:
        conn.close()
    if df.empty:
        return pd.Series(dtype=float)
    return pd.Series(df["ret"].to_numpy(), index=pd.to_datetime(df["date"]))


def delisting_summary(permnos: list[str], start: str, end: str) -> list[dict]:
    """Which of the requested permnos delisted within [start, end], for UI
    transparency — not used for the return math (already embedded above)."""
    if not permnos:
        return []
    conn = _conn()
    try:
        placeholders = ",".join("?" * len(permnos))
        rows = conn.execute(
            f"SELECT permno, delisting_dt, reason_type, delisting_ret FROM crsp_delisting "
            f"WHERE permno IN ({placeholders}) AND delisting_dt >= ? AND delisting_dt <= ?",
            (*permnos, start, end),
        ).fetchall()
        return [
            {"permno": p, "delisting_dt": dt, "reason": reason, "delisting_ret": ret}
            for p, dt, reason, ret in rows
        ]
    finally:
        conn.close()


def tickers_for_permnos(permnos: list[str]) -> dict[str, str]:
    """Latest known ticker per permno, for display."""
    if not permnos:
        return {}
    conn = _conn()
    try:
        placeholders = ",".join("?" * len(permnos))
        # Same blank-ticker-on-the-final-row caveat as point_in_time_members.
        rows = conn.execute(
            f"""
            SELECT c.permno, c.ticker FROM crsp_daily c
            JOIN (
                SELECT permno, MAX(date) AS max_date FROM crsp_daily
                WHERE permno IN ({placeholders}) AND ticker != '' GROUP BY permno
            ) latest ON c.permno = latest.permno AND c.date = latest.max_date AND c.ticker != ''
            """,
            permnos,
        ).fetchall()
        return {p: t for p, t in rows if t}
    finally:
        conn.close()
