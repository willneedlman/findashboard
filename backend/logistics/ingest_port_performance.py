"""Build ``data/port_performance.db`` from Dewey Ocean Port Performance feeds.

Downloads every current partition, keeps a two-year daily history plus the
complete monthly history, and materializes the latest import/export view used
by the energy-flows map.  It is an offline refresh job, never a request-path
dependency.

    cd backend
    DEWEY_API_KEY=... python -m logistics.ingest_port_performance
"""
from __future__ import annotations

import argparse
import csv
import gzip
import logging
import os
import sqlite3
import tempfile
from datetime import date, timedelta

import requests

from logistics.ingest_veridion import _load_env


log = logging.getLogger("ingest_port_performance")
_DB_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "port_performance.db"))
PRODUCTS = {
    "import": "https://api.deweydata.io/api/v1/external/data/prj_fh44evt9__fldr_cugex376kgybkg9p7",
    "export": "https://api.deweydata.io/api/v1/external/data/prj_fh44evt9__fldr_fqhh3d3atnekuxdht",
    "monthly": "https://api.deweydata.io/api/v1/external/data/prj_fh44evt9__fldr_rm3fzkhy3n3gpcpfd",
}


def _num(value):
    try:
        value = float(value)
        return value if value == value else None
    except (TypeError, ValueError):
        return None


def _text(row, *names):
    for name in names:
        value = str(row.get(name) or "").strip()
        if value:
            return value
    return None


def _port_id(row):
    code = _text(row, "PORT_UNLOCODE")
    if code:
        return code.upper()
    name, country = _text(row, "PORT_NAME"), _text(row, "PORT_COUNTRY_ISO", "PORT_COUNTRY")
    return f"{(country or 'XX').upper()}:{(name or 'unknown').upper()}"


def _files(url: str, key: str) -> list[dict]:
    out, page, pages = [], 1, 1
    while page <= pages:
        response = requests.get(url, headers={"X-API-KEY": key}, params={"page": page}, timeout=60)
        response.raise_for_status()
        blob = response.json()
        out.extend(blob.get("download_links") or [])
        pages = int(blob.get("total_pages") or 1)
        page += 1
    return out


def _download(link: str, key: str) -> str:
    last = None
    for attempt in range(4):
        try:
            response = requests.get(link, headers={"X-API-KEY": key}, timeout=300)
            if response.status_code != 200:
                raise RuntimeError(f"HTTP {response.status_code}")
            fd, path = tempfile.mkstemp(suffix=".csv.gz")
            with os.fdopen(fd, "wb") as handle:
                handle.write(response.content)
            return path
        except Exception as exc:
            last = exc
            if attempt < 3:
                import time
                time.sleep(2 ** attempt)
    raise RuntimeError(f"download failed after retries: {last}")


def _init(conn: sqlite3.Connection):
    conn.executescript("""
        DROP TABLE IF EXISTS daily_performance;
        DROP TABLE IF EXISTS monthly_performance;
        DROP TABLE IF EXISTS port_latest;
        DROP TABLE IF EXISTS metadata;
        CREATE TABLE daily_performance (
          port_id TEXT, name TEXT, country TEXT, latitude REAL, longitude REAL,
          event_date TEXT, direction TEXT, performance_hours REAL, change_pct REAL,
          flag TEXT, teu REAL, vessels REAL, PRIMARY KEY (port_id, event_date, direction)
        );
        CREATE TABLE monthly_performance (
          port_id TEXT, month TEXT, performance_hours REAL, vessels REAL, teu REAL,
          PRIMARY KEY (port_id, month)
        );
        CREATE TABLE port_latest (
          port_id TEXT PRIMARY KEY, name TEXT, country TEXT, latitude REAL, longitude REAL,
          latest_date TEXT, import_performance_hours REAL, import_change_pct REAL, import_flag TEXT, import_teu REAL,
          export_performance_hours REAL, export_change_pct REAL, export_flag TEXT, export_teu REAL,
          monthly_performance_hours REAL, monthly_vessels REAL, monthly_teu REAL
        );
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    """)


def _daily_row(row: dict, direction: str):
    event_date = _text(row, "EVENT_DT")
    name, lat, lon = _text(row, "PORT_NAME"), _num(row.get("PORT_LATITUDE")), _num(row.get("PORT_LONGITUDE"))
    if not event_date or not name or lat is None or lon is None:
        return None
    teu = _num(row.get("TEU_GTOT" if direction == "import" else "TEU_GTIN"))
    return (_port_id(row), name, _text(row, "PORT_COUNTRY_ISO", "PORT_COUNTRY"), lat, lon, event_date, direction,
            _num(row.get("SEVEN_DAY_PERFORMANCE")), _num(row.get("PERFORMANCE_CHANGE")),
            _text(row, "PERFORMANCE_CHANGE_FLAG"), teu, _num(row.get("N_VES_BERTH")))


def _monthly_row(row: dict):
    month, name = _text(row, "PERFORMANCE_MONTH"), _text(row, "PORT_NAME")
    lat, lon = _num(row.get("PORT_LATITUDE")), _num(row.get("PORT_LONGITUDE"))
    if not month or not name or lat is None or lon is None:
        return None
    return (_port_id(row), month, _num(row.get("MONTHLY_PERFORMANCE_HRS")),
            _num(row.get("N_VES_BERTH")), _num(row.get("TEU_CTNR_BERTH")))


def _ingest_csv(conn, file_path: str, product: str, cutoff: str, as_of: str):
    table = "monthly_performance" if product == "monthly" else "daily_performance"
    sql = ("INSERT OR REPLACE INTO monthly_performance VALUES (?,?,?,?,?)" if product == "monthly" else
           "INSERT OR REPLACE INTO daily_performance VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    inserted = 0
    with gzip.open(file_path, "rt", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        batch = []
        for raw in reader:
            row = _monthly_row(raw) if product == "monthly" else _daily_row(raw, product)
            if row and (product == "monthly" or cutoff <= row[5] <= as_of):
                batch.append(row)
            if len(batch) >= 5000:
                conn.executemany(sql, batch)
                inserted += len(batch)
                batch.clear()
        if batch:
            conn.executemany(sql, batch)
            inserted += len(batch)
    return inserted


def _materialize_latest(conn):
    conn.execute("""
      INSERT INTO port_latest
      SELECT p.port_id, p.name, p.country, p.latitude, p.longitude,
             MAX(p.event_date),
             MAX(CASE WHEN p.direction='import' AND p.event_date = (SELECT MAX(d.event_date) FROM daily_performance d WHERE d.port_id=p.port_id AND d.direction='import') THEN p.performance_hours END),
             MAX(CASE WHEN p.direction='import' AND p.event_date = (SELECT MAX(d.event_date) FROM daily_performance d WHERE d.port_id=p.port_id AND d.direction='import') THEN p.change_pct END),
             MAX(CASE WHEN p.direction='import' AND p.event_date = (SELECT MAX(d.event_date) FROM daily_performance d WHERE d.port_id=p.port_id AND d.direction='import') THEN p.flag END),
             MAX(CASE WHEN p.direction='import' AND p.event_date = (SELECT MAX(d.event_date) FROM daily_performance d WHERE d.port_id=p.port_id AND d.direction='import') THEN p.teu END),
             MAX(CASE WHEN p.direction='export' AND p.event_date = (SELECT MAX(d.event_date) FROM daily_performance d WHERE d.port_id=p.port_id AND d.direction='export') THEN p.performance_hours END),
             MAX(CASE WHEN p.direction='export' AND p.event_date = (SELECT MAX(d.event_date) FROM daily_performance d WHERE d.port_id=p.port_id AND d.direction='export') THEN p.change_pct END),
             MAX(CASE WHEN p.direction='export' AND p.event_date = (SELECT MAX(d.event_date) FROM daily_performance d WHERE d.port_id=p.port_id AND d.direction='export') THEN p.flag END),
             MAX(CASE WHEN p.direction='export' AND p.event_date = (SELECT MAX(d.event_date) FROM daily_performance d WHERE d.port_id=p.port_id AND d.direction='export') THEN p.teu END),
             (SELECT m.performance_hours FROM monthly_performance m WHERE m.port_id=p.port_id ORDER BY m.month DESC LIMIT 1),
             (SELECT m.vessels FROM monthly_performance m WHERE m.port_id=p.port_id ORDER BY m.month DESC LIMIT 1),
             (SELECT m.teu FROM monthly_performance m WHERE m.port_id=p.port_id ORDER BY m.month DESC LIMIT 1)
      FROM daily_performance p GROUP BY p.port_id
    """)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--max-files", type=int, help="cap each product for a smoke test")
    args = parser.parse_args()
    _load_env()
    key = os.getenv("DEWEY_API_KEY")
    if not key:
        log.error("DEWEY_API_KEY not set")
        return 2
    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    conn = sqlite3.connect(_DB_PATH)
    _init(conn)
    cutoff = (date.today() - timedelta(days=730)).isoformat()
    files_by_product = {product: _files(url, key) for product, url in PRODUCTS.items()}
    published = [str(f.get("modified_at") or "")[:10] for files in files_by_product.values() for f in files]
    source_as_of = max((v for v in published if v), default=date.today().isoformat())
    as_of = min(date.today().isoformat(), source_as_of)
    counts = {}
    try:
        for product, files in files_by_product.items():
            if args.max_files:
                files = files[:args.max_files]
            total = 0
            for index, descriptor in enumerate(files, 1):
                path = _download(descriptor["link"], key)
                try:
                    total += _ingest_csv(conn, path, product, cutoff, as_of)
                    conn.commit()
                finally:
                    os.unlink(path)
                log.info("%s %s/%s", product, index, len(files))
            counts[product] = total
        _materialize_latest(conn)
        conn.execute("CREATE INDEX idx_daily_port_date ON daily_performance(port_id, event_date)")
        conn.execute("INSERT INTO metadata VALUES (?, ?)", ("refresh", date.today().isoformat()))
        conn.execute("INSERT INTO metadata VALUES (?, ?)", ("source_as_of", as_of))
        conn.execute("INSERT INTO metadata VALUES (?, ?)", ("daily_cutoff", cutoff))
        conn.commit()
        log.info("complete: %s", counts)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    raise SystemExit(main())
