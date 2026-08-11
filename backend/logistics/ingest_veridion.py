"""Build-time ETL: Dewey Veridion partitions -> bounded data/veridion_nodes.db.

Runs OFFLINE (locally or in CI), never in the request path. It streams the
Veridion csv.gz partitions, keeps only geocoded rows (optionally filtered to an
industry substring), and writes a small read-only SQLite the API serves. This is
the memory-safe half of the design: the 1GB prod VM only ever reads the result.

Usage (needs a valid DEWEY_API_KEY in the environment / .env):

    cd backend
    DEWEY_API_KEY=... python -m logistics.ingest_veridion \
        --product firmographics --industry manufactur --max-files 6 --limit 300000

Flags cap the work so a global dataset can't blow up the DB or the run:
  --industry    substring match on the industry column (e.g. "manufactur")
  --max-files   stop after N partitions (omit for all)
  --limit       stop after N written rows (default 500k)
"""
from __future__ import annotations

import argparse
import logging
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from logistics import veridion as V  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("ingest_veridion")


def _load_env() -> None:
    """Load repo-root .env so DEWEY_API_KEY is picked up without a manual export."""
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    path = os.path.join(root, ".env")
    if not os.path.exists(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


def _init_schema(conn: sqlite3.Connection) -> None:
    conn.execute("DROP TABLE IF EXISTS supplier_nodes")
    conn.execute("""
        CREATE TABLE supplier_nodes (
            company_name     TEXT,
            latitude         REAL NOT NULL,
            longitude        REAL NOT NULL,
            company_industry TEXT,
            product_names    TEXT
        )
    """)
    conn.commit()


def _index(conn: sqlite3.Connection) -> None:
    # Spatial index: serves the map's bbox viewport range query. The industry
    # index still helps exact/prefix lookups; product_names is substring-only
    # (LIKE '%x%' can't use a b-tree) so it is intentionally left unindexed.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_latlon   ON supplier_nodes(latitude, longitude)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_industry ON supplier_nodes(company_industry)")
    conn.commit()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--product", default="firmographics", choices=list(V.PRODUCTS))
    ap.add_argument("--industry", default=None, help="substring filter on company_industry (MAIN_INDUSTRY)")
    ap.add_argument("--naics", default=None,
                    help="comma-separated NAICS_2022 leading-digit prefixes, e.g. 31,32,33 for manufacturing")
    ap.add_argument("--max-files", type=int, default=None)
    ap.add_argument("--limit", type=int, default=500_000)
    ap.add_argument("--start-date", default=None)
    ap.add_argument("--end-date", default=None)
    a = ap.parse_args()

    _load_env()
    naics_prefixes = tuple(p.strip() for p in a.naics.split(",")) if a.naics else None

    if not os.getenv("DEWEY_API_KEY"):
        log.error("DEWEY_API_KEY not set — export a valid key before running the ETL.")
        return 2

    files = V.get_file_list(V.PRODUCTS[a.product], a.start_date, a.end_date)
    if not files:
        log.error("No partitions returned (bad key, no subscription, or upstream down). Nothing written.")
        return 1
    if a.max_files:
        files = files[:a.max_files]
    log.info("Ingesting %s partition(s) of '%s' into %s", len(files), a.product, V._DB_PATH)

    os.makedirs(os.path.dirname(V._DB_PATH), exist_ok=True)
    conn = sqlite3.connect(V._DB_PATH)
    _init_schema(conn)

    written = 0
    try:
        for i, f in enumerate(files):
            fname = f.get("file_name") if isinstance(f, dict) else str(f)
            for chunk in V.stream_partition(f):
                if a.industry and "company_industry" in chunk.columns:
                    chunk = chunk[chunk["company_industry"].astype(str)
                                  .str.contains(a.industry, case=False, na=False)]
                if naics_prefixes and "_naics" in chunk.columns:
                    chunk = chunk[chunk["_naics"].astype(str).str.strip()
                                  .str.startswith(naics_prefixes)]
                chunk = chunk.drop(columns=[c for c in ("_naics",) if c in chunk.columns])
                if chunk.empty:
                    continue
                try:
                    chunk.to_sql("supplier_nodes", conn, if_exists="append", index=False)
                except Exception as e:                       # malformed chunk — skip, keep going
                    log.error("write chunk from %s failed: %s", fname, e)
                    continue
                written += len(chunk)
                if written >= a.limit:
                    log.info("row limit %s reached", a.limit)
                    break
            log.info("partition %s/%s done (%s rows total)", i + 1, len(files), written)
            if written >= a.limit:
                break
        _index(conn)
        conn.commit()
        _record_freshness(conn)
    finally:
        conn.close()

    log.info("DONE: wrote %s supplier nodes -> %s", written, V._DB_PATH)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


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
