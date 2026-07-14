"""Ingestion script for WRDS TRACE (BTDS) corporate bond trade data.

Reads a manually exported WRDS TRACE CSV file (data/wrds_trace.csv),
finds the most recent trade print per CUSIP, and loads it into the
sqlite3 table `wrds_trace` inside data/corporate.db.
"""
from __future__ import annotations

import csv
import logging
import os
import sqlite3
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from corporate_db import DB_PATH as _DEFAULT_DB_PATH

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("ingest_trace_btds")

_DEFAULT_CSV_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "wrds_trace.csv"))

# WRDS/SAS exports commonly render dates as 8-digit YYYYMMDD or SAS-default
# DD-Mon-YYYY; manual re-saves through Excel often land on MM/DD/YYYY. Only
# normalized (ISO) dates sort correctly by plain string comparison, so every
# recognized format is converted to ISO before the "latest trade" comparison —
# an unrecognized format falls back to the raw string rather than crashing.
_DATE_FORMATS = ("%m/%d/%Y", "%d-%b-%Y", "%d%b%Y", "%Y-%m-%d")


def _normalize_trade_date(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return raw
    if raw.isdigit() and len(raw) == 8:
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return raw


def main(csv_path: str | None = None, db_path: str | None = None) -> None:
    csv_path = csv_path or _DEFAULT_CSV_PATH
    db_path = db_path or _DEFAULT_DB_PATH

    if not os.path.exists(csv_path):
        log.warning("No WRDS TRACE CSV export found at %s. Skipping ingest.", csv_path)
        return

    log.info("Ingesting WRDS TRACE from %s", csv_path)

    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS wrds_trace (
            cusip TEXT PRIMARY KEY,
            price REAL,
            trade_date TEXT,
            issuer_name TEXT
        );
    """)
    conn.execute("DELETE FROM wrds_trace")

    # Map CUSIP -> {price, trade_date, issuer_name} (keep latest by trade_date)
    latest_prints: dict[str, dict] = {}

    with open(csv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            cusip = (r.get("cusip") or r.get("Cusip") or r.get("CUSIP") or "").strip().upper()
            if not cusip or len(cusip) != 9:
                continue

            # A missing/renamed price column must not silently ingest as a
            # fake $0.00 mark — skip the row instead of defaulting to "0".
            price_raw = r.get("price") or r.get("prc") or r.get("rptd_pr") or r.get("reported_price")
            if price_raw in (None, ""):
                continue
            try:
                price = float(price_raw)
            except ValueError:
                continue
            if price <= 0:
                continue

            trade_date_raw = (
                r.get("trade_date") or r.get("trd_exctn_dt") or r.get("trd_ex_dt")
                or r.get("date") or r.get("trandate") or ""
            ).strip()
            trade_date = _normalize_trade_date(trade_date_raw)

            issuer_name = (r.get("issuer_name") or r.get("company_name") or r.get("issuer") or r.get("name") or "").strip()

            existing = latest_prints.get(cusip)
            if not existing or trade_date > existing["trade_date"]:
                latest_prints[cusip] = {
                    "price": price,
                    "trade_date": trade_date,
                    "issuer_name": issuer_name
                }

    rows = []
    for cusip, data in latest_prints.items():
        rows.append((cusip, data["price"], data["trade_date"], data["issuer_name"]))

    for i in range(0, len(rows), 50000):
        conn.executemany(
            "INSERT OR REPLACE INTO wrds_trace (cusip, price, trade_date, issuer_name) VALUES (?, ?, ?, ?)",
            rows[i:i+50000]
        )

    conn.commit()
    conn.close()
    log.info("WRDS TRACE ingestion completed. Loaded %d unique bonds.", len(rows))


if __name__ == "__main__":
    main()
