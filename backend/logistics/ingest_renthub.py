"""Build a compact current RentHub rental snapshot for the Housing Market tool.

Downloads only the latest available daily snapshot, aggregates it by state and
bedroom count, and writes ``data/renthub_snapshot.db`` for request-path reads.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import tempfile
from collections import defaultdict
from statistics import median

import requests

from logistics.ingest_veridion import _load_env


URL = "https://api.deweydata.io/api/v1/external/data/prj_fh44evt9__fldr_cggezfmh4zsrfevk8"
DB = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "renthub_snapshot.db"))


def _files(key: str) -> list[dict]:
    first = requests.get(URL, headers={"X-API-KEY": key}, timeout=60).json()
    out = list(first.get("download_links") or [])
    for page in range(2, int(first.get("total_pages") or 1) + 1):
        out.extend(requests.get(URL, headers={"X-API-KEY": key}, params={"page": page}, timeout=60).json().get("download_links") or [])
    return out


def _download(url: str, key: str) -> str:
    response = requests.get(url, headers={"X-API-KEY": key}, timeout=600)
    response.raise_for_status()
    fd, path = tempfile.mkstemp(suffix=".parquet")
    with os.fdopen(fd, "wb") as handle:
        handle.write(response.content)
    return path


def _clean(value):
    try:
        value = float(value)
        return value if value == value else None
    except (TypeError, ValueError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--latest-date", help="override the latest YYYY-MM-DD snapshot")
    args = parser.parse_args()
    _load_env()
    key = os.getenv("DEWEY_API_KEY")
    if not key:
        raise SystemExit("DEWEY_API_KEY not set")
    files = _files(key)
    if not files:
        raise SystemExit("Dewey returned no RentHub files")
    as_of = args.latest_date or max(f["file_name"][:10] for f in files)
    selected = [f for f in files if f["file_name"].startswith(as_of)]
    if not selected:
        raise SystemExit(f"no RentHub files for {as_of}")
    by_state: dict[str, dict[str, list[float]]] = defaultdict(lambda: defaultdict(list))
    for descriptor in selected:
        path = _download(descriptor["link"], key)
        try:
            import pyarrow.parquet as pq
            pf = pq.ParquetFile(path)
            cols = [c for c in ("STATE", "RENT_PRICE", "SQFT", "BEDS") if c in pf.schema_arrow.names]
            for batch in pf.iter_batches(batch_size=100_000, columns=cols):
                for row in batch.to_pandas().to_dict("records"):
                    state = str(row.get("STATE") or "").strip().upper()
                    rent, sqft, beds = _clean(row.get("RENT_PRICE")), _clean(row.get("SQFT")), _clean(row.get("BEDS"))
                    if len(state) != 2 or rent is None or not 250 <= rent <= 20_000:
                        continue
                    by_state[state]["rent"].append(rent)
                    if sqft and sqft > 100:
                        by_state[state]["psf"].append(rent / sqft)
                    if beds is not None and beds in (0, 1, 2, 3):
                        by_state[state][f"bed_{int(beds)}"].append(rent)
        finally:
            os.unlink(path)
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    conn = sqlite3.connect(DB)
    conn.executescript("""
      DROP TABLE IF EXISTS metadata; DROP TABLE IF EXISTS national; DROP TABLE IF EXISTS state_snapshot;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE national (listings INTEGER, median_rent REAL, median_rent_per_sqft REAL, median_rent_1br REAL, median_rent_2br REAL);
      CREATE TABLE state_snapshot (state TEXT PRIMARY KEY, listings INTEGER, median_rent REAL, median_rent_per_sqft REAL, median_rent_1br REAL, median_rent_2br REAL);
    """)
    all_rent, all_psf, all_1br, all_2br = [], [], [], []
    for state, values in by_state.items():
        rent, psf = values["rent"], values["psf"]
        one, two = values["bed_1"], values["bed_2"]
        conn.execute("INSERT INTO state_snapshot VALUES (?,?,?,?,?,?)", (state, len(rent), median(rent), median(psf) if psf else None, median(one) if one else None, median(two) if two else None))
        all_rent.extend(rent); all_psf.extend(psf); all_1br.extend(one); all_2br.extend(two)
    conn.execute("INSERT INTO national VALUES (?,?,?,?,?)", (len(all_rent), median(all_rent), median(all_psf) if all_psf else None, median(all_1br) if all_1br else None, median(all_2br) if all_2br else None))
    conn.executemany("INSERT INTO metadata VALUES (?,?)", [("as_of", as_of), ("partitions", str(len(selected)))])
    conn.commit(); conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
