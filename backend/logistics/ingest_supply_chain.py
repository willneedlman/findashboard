"""Build-time ETL: Veridion firmographics -> data/supply_chain.db (tickered cos).

Extracts the companies that carry a public EXCHANGE_TICKER, with their
fundamentals (revenue, employees, year founded, industry, location, description,
offerings, sourcing/market tags), plus a ticker index for fast symbol lookup.
This is the foundation for the Supply Chain Peers tool (tag-overlap peer
ranking). Runs offline; ships a small read-only DB.

  cd backend
  DEWEY_API_KEY=... python -m logistics.ingest_supply_chain --max-files 96

Only ~0.1% of firmographics rows have a ticker (~35k globally across all 96
files), so the resulting DB is small even at full coverage; the cost is the
download. --max-files bounds it.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from logistics import veridion as V          # noqa: E402
from logistics.ingest_veridion import _load_env  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("ingest_supply_chain")

_DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "supply_chain.db"))

# Firmographics columns we keep for tickered companies.
_COLS = ["VERIDION_ID", "EXCHANGE_TICKER", "LEGAL_NAME", "OPERATIONAL_NAME", "COMMERCIAL_NAMES",
         "REVENUE", "REVENUE_TYPE", "EMPLOYEE_COUNT", "YEAR_FOUNDED", "MAIN_INDUSTRY",
         "BUSINESS_CATEGORY", "COUNTRY_NAME", "CITY", "LATITUDE", "LONGITUDE", "DESCRIPTION",
         "CORE_OFFERINGS", "SUPPLY_CHAIN_FOCUS", "TARGET_MARKETS"]


def _first(row, *names):
    for n in names:
        v = row.get(n)
        if v is not None and str(v).strip() and str(v).strip().lower() != "nan":
            return str(v).strip()
    return None


def _list_str(v) -> "str | None":
    """A JSON-array string ("[\"a\",\"b\"]") -> "a; b"; else the raw value."""
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.lower() == "nan" or s == "[]":
        return None
    try:
        arr = json.loads(s)
        if isinstance(arr, list):
            items = [str(x).strip() for x in arr if str(x).strip()]
            return "; ".join(items) or None
    except Exception:
        pass
    return s


def _parse_tickers(v):
    """EXCHANGE_TICKER '["NYSE:JBL","FRA:JBL"]' -> [(symbol, exchange, full), ...]."""
    if v is None:
        return []
    s = str(v).strip()
    if not s or s.lower() == "nan" or s == "[]":
        return []
    try:
        arr = json.loads(s)
    except Exception:
        arr = [s]
    out = []
    for item in arr if isinstance(arr, list) else [arr]:
        full = str(item).strip()
        if not full:
            continue
        exch, _, sym = full.partition(":")
        out.append((sym.strip() or full, exch.strip() if sym else None, full))
    return out


def _init(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        DROP TABLE IF EXISTS companies;
        DROP TABLE IF EXISTS ticker_index;
        CREATE TABLE companies (
            veridion_id TEXT PRIMARY KEY,
            name TEXT, revenue REAL, revenue_type TEXT, employees INTEGER, year_founded INTEGER,
            main_industry TEXT, business_category TEXT, country TEXT, city TEXT,
            latitude REAL, longitude REAL, description TEXT, core_offerings TEXT,
            supply_chain_focus TEXT, target_markets TEXT, exchange_tickers TEXT
        );
        CREATE TABLE ticker_index (symbol TEXT, exchange TEXT, veridion_id TEXT);
    """)
    conn.commit()


def _index(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE INDEX IF NOT EXISTS idx_ticker_symbol ON ticker_index(symbol)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_company_name ON companies(name)")
    conn.commit()


def _to_num(v):
    try:
        f = float(v)
        return f if f == f else None          # drop NaN
    except (TypeError, ValueError):
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--max-files", type=int, default=None, help="cap partitions processed (omit for all 96)")
    a = ap.parse_args()

    _load_env()
    if not os.getenv("DEWEY_API_KEY"):
        log.error("DEWEY_API_KEY not set — export a valid key first.")
        return 2

    import pyarrow.parquet as pq

    files = V.get_file_list(V.PRODUCTS["firmographics"])
    if not files:
        log.error("No firmographics partitions returned. Nothing written.")
        return 1
    if a.max_files:
        files = files[:a.max_files]
    log.info("Scanning %s firmographics partition(s) for tickered companies -> %s", len(files), _DB_PATH)

    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    conn = sqlite3.connect(_DB_PATH)
    _init(conn)

    companies = 0
    tickers = 0
    try:
        for i, f in enumerate(files):
            fname = f.get("file_name") if isinstance(f, dict) else str(f)
            tmp = V.download_to_tmp(f.get("link") if isinstance(f, dict) else f)
            if not tmp:
                log.warning("skipping partition %s (download failed)", fname)
                continue
            try:
                pf = pq.ParquetFile(tmp)
                cols = [c for c in _COLS if c in set(pf.schema_arrow.names)]
                for batch in pf.iter_batches(batch_size=100_000, columns=cols):
                    df = batch.to_pandas()
                    if "EXCHANGE_TICKER" not in df.columns:
                        continue
                    tickered = df[df["EXCHANGE_TICKER"].astype("string").fillna("").str.strip()
                                  .replace("[]", "").str.len() > 0]
                    for _, row in tickered.iterrows():
                        vid = _first(row, "VERIDION_ID")
                        if not vid:
                            continue
                        parsed = _parse_tickers(row.get("EXCHANGE_TICKER"))
                        try:
                            conn.execute(
                                "INSERT OR REPLACE INTO companies VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                (vid, _first(row, "LEGAL_NAME", "OPERATIONAL_NAME", "COMMERCIAL_NAMES"),
                                 _to_num(row.get("REVENUE")), _first(row, "REVENUE_TYPE"),
                                 _to_num(row.get("EMPLOYEE_COUNT")), _to_num(row.get("YEAR_FOUNDED")),
                                 _first(row, "MAIN_INDUSTRY"), _first(row, "BUSINESS_CATEGORY"),
                                 _first(row, "COUNTRY_NAME"), _first(row, "CITY"),
                                 _to_num(row.get("LATITUDE")), _to_num(row.get("LONGITUDE")),
                                 _first(row, "DESCRIPTION"), _list_str(row.get("CORE_OFFERINGS")),
                                 _list_str(row.get("SUPPLY_CHAIN_FOCUS")), _list_str(row.get("TARGET_MARKETS")),
                                 "; ".join(t[2] for t in parsed)),
                            )
                            companies += 1
                            for sym, exch, full in parsed:
                                conn.execute("INSERT INTO ticker_index VALUES (?,?,?)", (sym.upper(), exch, vid))
                                if exch:
                                    conn.execute("INSERT INTO ticker_index VALUES (?,?,?)", (full.upper(), exch, vid))
                                tickers += 1
                        except sqlite3.Error as e:
                            log.error("write %s failed: %s", vid, e)
            finally:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
            conn.commit()
            log.info("partition %s/%s done — %s companies, %s ticker rows", i + 1, len(files), companies, tickers)
        _index(conn)
        conn.commit()
    finally:
        conn.close()

    log.info("DONE: %s tickered companies, %s ticker index rows -> %s", companies, tickers, _DB_PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
