"""Build-time ETL: Open Supply Hub facility exports -> data/supply_chain.db
(facilities table). Read-only serving layer for the Supply Chain Map's
facility list — real, geo-located production sites the companies themselves
(or NGOs/researchers) contributed to Open Supply Hub, not inferred like the
Veridion tag-similarity graph.

  cd backend
  python -m logistics.ingest_facilities --source-dir "/path/to/Supply Chain Data"

Source CSVs are Open Supply Hub (opensupplyhub.org) exports, one company per
file. The export carries no ticker column, so the filename -> ticker map below
is the ground truth for the join; verify it before adding new source files.
Source CSVs are not committed to the repo — only the ingested SQLite rows are.
"""
from __future__ import annotations

import argparse
import csv
import logging
import os
import sqlite3

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("ingest_facilities")

_DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "supply_chain.db"))

_FILE_TICKERS = {
    "HP facilities.csv": "HPQ",
    "Qualcomm facilities.csv": "QCOM",
    "XOM facilities.csv": "XOM",
    "amd facilities.csv": "AMD",
    "dell facilities.csv": "DELL",
    "mattel facilities.csv": "MAT",
    "nike facilities.csv": "NKE",
    "tesla facilities.csv": "TSLA",
    "tsmc facilities.csv": "TSM",
}

_COLS = ["os_id", "ticker", "name", "address", "country_code", "country_name",
         "lat", "lng", "sector", "number_of_workers", "parent_company",
         "processing_type", "product_type", "is_closed", "contribution_date"]


def _init_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS facilities (
            os_id TEXT PRIMARY KEY,
            ticker TEXT NOT NULL,
            name TEXT, address TEXT, country_code TEXT, country_name TEXT,
            lat REAL, lng REAL, sector TEXT, number_of_workers TEXT,
            parent_company TEXT, processing_type TEXT, product_type TEXT,
            is_closed INTEGER, contribution_date TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_facilities_ticker ON facilities(ticker)")


def _as_float(value: str) -> float | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _s(row: dict, key: str) -> str | None:
    """Trimmed string field, or None — source rows carry stray leading/
    trailing whitespace (e.g. " PT. Saimoda Garmindo") that reads oddly once
    this text surfaces as a supplier name in the verified-relationships graph."""
    v = (row.get(key) or "").strip()
    return v or None


def _row_to_tuple(row: dict, ticker: str) -> tuple | None:
    os_id = _s(row, "os_id")
    if not os_id:
        return None
    return (
        os_id, ticker,
        _s(row, "name"), _s(row, "address"),
        _s(row, "country_code"), _s(row, "country_name"),
        _as_float(row.get("lat", "")), _as_float(row.get("lng", "")),
        _s(row, "sector"), _s(row, "number_of_workers"),
        _s(row, "parent_company"), _s(row, "processing_type"),
        _s(row, "product_type"),
        1 if (row.get("is_closed") or "").strip().lower() == "true" else 0,
        _s(row, "contribution_date"),
    )


def ingest(source_dir: str) -> None:
    conn = sqlite3.connect(_DB_PATH)
    try:
        _init_table(conn)
        total = 0
        for filename, ticker in _FILE_TICKERS.items():
            path = os.path.join(source_dir, filename)
            if not os.path.isfile(path):
                log.warning("missing source file, skipping: %s", filename)
                continue
            rows = []
            with open(path, newline="", encoding="utf-8-sig") as fh:
                for raw_row in csv.DictReader(fh):
                    parsed = _row_to_tuple(raw_row, ticker)
                    if parsed:
                        rows.append(parsed)
            conn.executemany(
                f"INSERT OR REPLACE INTO facilities ({','.join(_COLS)}) "
                f"VALUES ({','.join('?' for _ in _COLS)})",
                rows,
            )
            conn.commit()
            log.info("%-24s -> %-6s: %d facilities", filename, ticker, len(rows))
            total += len(rows)
        log.info("done: %d total facilities ingested into %s", total, _DB_PATH)
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source-dir", required=True, help="Directory containing the Open Supply Hub CSV exports")
    args = parser.parse_args()
    ingest(args.source_dir)
