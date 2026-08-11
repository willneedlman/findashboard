"""Ingestion script for WRDS CRSP (CIZ) survivorship-bias-free backtesting data.

Reads three manually exported WRDS CRSP CIZ CSV files:
  data/wrds_crsp_membership.csv  — "S&P 500 Index Constituents": INDNO, MbrStartDt,
                                    MbrEndDt, PERMNO + a redundant daily panel we ignore
  data/wrds_crsp_delisting.csv   — "Delisting Information": one row per delisted PERMNO
  data/wrds_crsp_daily.csv       — "Daily Stock File": the ENTIRE CRSP universe (tens
                                    of millions of rows, ~7GB), not just S&P 500 names

Builds three compact tables in data/crsp.db:
  crsp_membership(permno, mbr_start, mbr_end)         — unique S&P 500 membership stints
  crsp_delisting(permno PRIMARY KEY, delisting_dt, action_type, reason_type,
                 delisting_ret, retmiss_type, next_dt, next_prc)
  crsp_daily(permno, date, prc, ret, shrout, ticker)  — daily file filtered down to only
                 permnos that were EVER an S&P 500 member, since the raw file spans the
                 whole CRSP universe and most of it is irrelevant here

The daily file is streamed row-by-row with plain csv.reader (not pandas / DictReader)
and batch-inserted, since at ~7GB it cannot be loaded into memory whole.
"""
from __future__ import annotations

import csv
import logging
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("ingest_crsp")

_DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data"))
_DEFAULT_MEMBERSHIP_CSV = os.path.join(_DATA_DIR, "wrds_crsp_membership.csv")
_DEFAULT_DELISTING_CSV = os.path.join(_DATA_DIR, "wrds_crsp_delisting.csv")
_DEFAULT_DAILY_CSV = os.path.join(_DATA_DIR, "wrds_crsp_daily.csv")
_DEFAULT_DB_PATH = os.path.join(_DATA_DIR, "crsp.db")

_BATCH = 50_000


def _num(v: str | None) -> float | None:
    if v is None:
        return None
    v = v.strip()
    if not v or v.upper() in ("NA", "."):
        return None
    try:
        f = float(v)
        return f if f == f else None          # drop NaN
    except ValueError:
        return None


def _create_tables(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS crsp_membership (
            permno TEXT NOT NULL,
            mbr_start TEXT,
            mbr_end TEXT
        );
        CREATE TABLE IF NOT EXISTS crsp_delisting (
            permno TEXT PRIMARY KEY,
            delisting_dt TEXT,
            action_type TEXT,
            reason_type TEXT,
            delisting_ret REAL,
            retmiss_type TEXT,
            next_dt TEXT,
            next_prc REAL
        );
        CREATE TABLE IF NOT EXISTS crsp_daily (
            permno TEXT NOT NULL,
            date TEXT NOT NULL,
            prc REAL,
            ret REAL,
            shrout REAL,
            ticker TEXT
        );
    """)
    conn.execute("DELETE FROM crsp_membership")
    conn.execute("DELETE FROM crsp_delisting")
    conn.execute("DELETE FROM crsp_daily")
    conn.commit()


def _ingest_membership(conn: sqlite3.Connection, csv_path: str) -> set[str]:
    """Loads unique (permno, mbr_start, mbr_end) stints. Returns the set of every
    permno that was ever an S&P 500 member, used to filter the daily file."""
    if not os.path.exists(csv_path):
        log.warning("No CRSP membership file found at %s. Skipping.", csv_path)
        return set()

    log.info("Ingesting CRSP S&P 500 membership from %s", csv_path)
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        idx = {name: i for i, name in enumerate(header)}
        i_permno, i_start, i_end = idx["PERMNO"], idx["MbrStartDt"], idx["MbrEndDt"]

        stints: set[tuple[str, str, str]] = set()
        permnos: set[str] = set()
        for n, row in enumerate(reader, 1):
            permno = row[i_permno].strip()
            if not permno:
                continue
            permnos.add(permno)
            stints.add((permno, row[i_start].strip(), row[i_end].strip()))
            if n % 2_000_000 == 0:
                log.info("  membership: scanned %d rows, %d unique stints so far", n, len(stints))

    rows = list(stints)
    for i in range(0, len(rows), _BATCH):
        conn.executemany(
            "INSERT INTO crsp_membership (permno, mbr_start, mbr_end) VALUES (?, ?, ?)",
            rows[i:i + _BATCH],
        )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_crsp_membership_permno ON crsp_membership(permno)")
    conn.commit()
    log.info("CRSP membership ingestion complete: %d unique stints, %d unique permnos.", len(rows), len(permnos))
    return permnos


def _ingest_delisting(conn: sqlite3.Connection, csv_path: str) -> None:
    if not os.path.exists(csv_path):
        log.warning("No CRSP delisting file found at %s. Skipping.", csv_path)
        return

    log.info("Ingesting CRSP delisting information from %s", csv_path)
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows = []
        for r in reader:
            permno = (r.get("PERMNO") or "").strip()
            if not permno:
                continue
            rows.append((
                permno,
                (r.get("DelistingDt") or "").strip() or None,
                (r.get("DelActionType") or "").strip() or None,
                (r.get("DelReasonType") or "").strip() or None,
                _num(r.get("DelRet")),
                (r.get("DelRetMissType") or "").strip() or None,
                (r.get("DelNextDt") or "").strip() or None,
                _num(r.get("DelNextPrc")),
            ))

    for i in range(0, len(rows), _BATCH):
        conn.executemany(
            "INSERT OR REPLACE INTO crsp_delisting "
            "(permno, delisting_dt, action_type, reason_type, delisting_ret, retmiss_type, next_dt, next_prc) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            rows[i:i + _BATCH],
        )
    conn.commit()
    log.info("CRSP delisting ingestion complete: %d rows.", len(rows))


def _ingest_daily(conn: sqlite3.Connection, csv_path: str, wanted_permnos: set[str]) -> None:
    """Streams the full-universe daily file and keeps only rows for permnos that
    were ever an S&P 500 member (per _ingest_membership). Must not load the whole
    ~7GB file into memory — plain csv.reader + batched inserts only."""
    if not os.path.exists(csv_path):
        log.warning("No CRSP daily file found at %s. Skipping.", csv_path)
        return
    if not wanted_permnos:
        log.warning("No membership permnos loaded — refusing to ingest the daily file "
                    "unfiltered (would load the entire CRSP universe). Run membership ingestion first.")
        return

    log.info("Ingesting CRSP daily stock file from %s (filtered to %d S&P 500-ever permnos)",
              csv_path, len(wanted_permnos))

    batch: list[tuple] = []
    kept = 0
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        idx = {name: i for i, name in enumerate(header)}
        i_permno, i_date = idx["PERMNO"], idx["DlyCalDt"]
        i_prc, i_ret, i_shrout = idx["DlyPrc"], idx["DlyRet"], idx["ShrOut"]
        i_ticker = idx.get("Ticker")

        for n, row in enumerate(reader, 1):
            permno = row[i_permno].strip()
            if permno not in wanted_permnos:
                continue
            batch.append((
                permno,
                row[i_date].strip(),
                _num(row[i_prc]),
                _num(row[i_ret]),
                _num(row[i_shrout]),
                row[i_ticker].strip() if i_ticker is not None else None,
            ))
            kept += 1
            if len(batch) >= _BATCH:
                conn.executemany(
                    "INSERT INTO crsp_daily (permno, date, prc, ret, shrout, ticker) VALUES (?, ?, ?, ?, ?, ?)",
                    batch,
                )
                conn.commit()
                batch = []
            if n % 5_000_000 == 0:
                log.info("  daily: scanned %d rows, kept %d so far", n, kept)

    if batch:
        conn.executemany(
            "INSERT INTO crsp_daily (permno, date, prc, ret, shrout, ticker) VALUES (?, ?, ?, ?, ?, ?)",
            batch,
        )
        conn.commit()

    conn.execute("CREATE INDEX IF NOT EXISTS idx_crsp_daily_permno_date ON crsp_daily(permno, date)")
    conn.commit()
    _record_freshness(conn)
    log.info("CRSP daily ingestion complete: kept %d rows.", kept)


def main(membership_csv: str | None = None, delisting_csv: str | None = None,
         daily_csv: str | None = None, db_path: str | None = None) -> None:
    membership_csv = membership_csv or _DEFAULT_MEMBERSHIP_CSV
    delisting_csv = delisting_csv or _DEFAULT_DELISTING_CSV
    daily_csv = daily_csv or _DEFAULT_DAILY_CSV
    db_path = db_path or _DEFAULT_DB_PATH

    conn = sqlite3.connect(db_path)
    _create_tables(conn)

    permnos = _ingest_membership(conn, membership_csv)
    _ingest_delisting(conn, delisting_csv)
    _ingest_daily(conn, daily_csv, permnos)

    conn.close()
    log.info("CRSP ingestion complete. DB at %s", db_path)


if __name__ == "__main__":
    main()


def _record_freshness(conn) -> None:
    """Stamp the build date so observatory.datasets can report this dataset's age.

    Best-effort: a freshness marker is never worth failing a completed rebuild for.
    """
    try:
        import os, sys
        sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from observatory.datasets import write_metadata
        write_metadata(conn)
    except Exception as e:  # noqa: BLE001
        log.warning("could not record dataset freshness: %s", e)
