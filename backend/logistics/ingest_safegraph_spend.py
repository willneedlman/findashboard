"""Build a compact SafeGraph Spend Patterns serving database.

The raw monthly partitions are large, so this streams only the newest month by
default and persists national plus merchant-category aggregates for the app.
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import tempfile
from collections import defaultdict

import requests

from logistics.ingest_veridion import _load_env


URL = "https://api.deweydata.io/api/v1/external/data/prj_fh44evt9__fldr_p3h4tivk4ork4buo6"
DB = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "consumer_spend.db"))
_MONTH = re.compile(r"(20\d{2}-\d{2})")


def _files(key: str) -> list[dict]:
    first = requests.get(URL, headers={"X-API-KEY": key}, timeout=60).json()
    out = list(first.get("download_links") or [])
    for page in range(2, int(first.get("total_pages") or 1) + 1):
        page_data = requests.get(URL, headers={"X-API-KEY": key}, params={"page": page}, timeout=60).json()
        out.extend(page_data.get("download_links") or [])
    return out


def _month(descriptor: dict) -> str | None:
    match = _MONTH.search(str(descriptor.get("file_name") or ""))
    return match.group(1) if match else None


def _download(url: str, key: str) -> str:
    response = requests.get(url, headers={"X-API-KEY": key}, timeout=1_200, stream=True)
    response.raise_for_status()
    fd, path = tempfile.mkstemp(suffix=".parquet")
    with os.fdopen(fd, "wb") as handle:
        for chunk in response.iter_content(chunk_size=1_048_576):
            if chunk:
                handle.write(chunk)
    return path


def _number(value) -> float:
    try:
        value = float(value)
        return value if value == value else 0.0
    except (TypeError, ValueError):
        return 0.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--month", help="ingest a specific YYYY-MM partition instead of the newest one")
    args = parser.parse_args()
    _load_env()
    key = os.getenv("DEWEY_API_KEY")
    if not key:
        raise SystemExit("DEWEY_API_KEY not set")
    files = _files(key)
    months = [month for descriptor in files if (month := _month(descriptor))]
    as_of = args.month or max(months, default=None)
    if not as_of:
        raise SystemExit("no dated SafeGraph partitions found")
    selected = [descriptor for descriptor in files if _month(descriptor) == as_of]
    if not selected:
        raise SystemExit(f"no SafeGraph partitions for {as_of}")

    totals: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0, 0.0])
    for descriptor in selected:
        path = _download(descriptor["link"], key)
        try:
            import pyarrow.parquet as pq
            parquet = pq.ParquetFile(path)
            columns = [column for column in (
                "TOP_CATEGORY", "RAW_TOTAL_SPEND", "RAW_NUM_TRANSACTIONS", "ONLINE_SPEND",
            ) if column in parquet.schema_arrow.names]
            for batch in parquet.iter_batches(batch_size=100_000, columns=columns):
                values = batch.to_pydict()
                for i in range(batch.num_rows):
                    category = str(values.get("TOP_CATEGORY", [None])[i] or "Unclassified").strip() or "Unclassified"
                    spend = _number(values.get("RAW_TOTAL_SPEND", [None])[i])
                    transactions = _number(values.get("RAW_NUM_TRANSACTIONS", [None])[i])
                    online = _number(values.get("ONLINE_SPEND", [None])[i])
                    record = totals[category]
                    record[0] += spend; record[1] += transactions; record[2] += online
        finally:
            os.unlink(path)

    os.makedirs(os.path.dirname(DB), exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.executescript("""
      DROP TABLE IF EXISTS metadata; DROP TABLE IF EXISTS national_month; DROP TABLE IF EXISTS category_month;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE national_month (total_spend REAL, transactions INTEGER, online_spend REAL, spend_change_pct REAL);
      CREATE TABLE category_month (category TEXT PRIMARY KEY, total_spend REAL, transactions INTEGER, online_spend REAL, spend_change_pct REAL);
    """)
    national = [sum(row[index] for row in totals.values()) for index in range(3)]
    total_spend = national[0]
    conn.execute("INSERT INTO national_month VALUES (?,?,?,?)", (total_spend, int(national[1]), national[2], None))
    for category, (spend, transactions, online) in totals.items():
        conn.execute("INSERT INTO category_month VALUES (?,?,?,?,?)", (category, spend, int(transactions), online, None))
    conn.executemany("INSERT INTO metadata VALUES (?,?)", [("as_of", as_of), ("partitions", str(len(selected)))])
    conn.commit(); conn.close()
    print(f"wrote {DB}: {as_of}, {len(selected)} partitions, {len(totals)} categories")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
