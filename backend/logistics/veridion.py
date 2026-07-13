"""Dewey Data — Veridion firmographics/products ingestion client + reader.

Two clearly separated layers:

* **Client** (`get_file_list` / `stream_partition`) — talks to Dewey's bulk file
  API (the Amplify v3 contract: ``X-API-KEY`` header, ``?page=`` pagination, a
  ``download_links[]`` array of 24h-valid csv/csv.gz URLs). Uses ``requests`` +
  streamed-to-disk downloads + chunked pandas reads. Called ONLY by the offline
  ETL (`ingest_veridion.py`) — never from the request path.

* **Reader** (`query_nodes` / `nodes_geojson` / `facets`) — stdlib-sqlite reads
  over the bounded, pre-built ``data/veridion_nodes.db``. This is what the API
  serves: no network, no pandas, no download — safe on the 1GB prod VM, which
  has OOM'd before. If the DB is absent it degrades to an empty result.

The real Veridion column names were unseen at build time (subscription key was
rejected), so ingestion is schema-flexible: source columns are matched to our
canonical fields through an alias table.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import time

import requests

logger = logging.getLogger("veridion")

# Dewey "Data Endpoint" URLs copied from the product subscription pages.
PRODUCTS = {
    "firmographics": "https://api.deweydata.io/api/v1/external/data/prj_bfaaxdr7__fldr_jeu767ks7xsjqw8qb",
    "products":      "https://api.deweydata.io/api/v1/external/data/prj_bfaaxdr7__fldr_d39fpxftx3n4uiyyo",
    "services":      "https://api.deweydata.io/api/v1/external/data/prj_bfaaxdr7__fldr_k3c7z3hnjfxqmb3kj",
}

# Bounded, pre-built DB the API reads. Path is repo-root/data regardless of cwd.
_DB_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "data", "veridion_nodes.db")
)

_COLUMNS = ("company_name", "latitude", "longitude", "company_industry", "product_names")

# Real Veridion firmographics (company-core-profiles) source columns we read. Parquet
# is columnar, so restricting to these ~9 of 41 columns makes ingestion far cheaper.
# _naics is carried only so the ETL can filter to manufacturers; it is not stored.
_SRC_COLS = ["LEGAL_NAME", "OPERATIONAL_NAME", "COMMERCIAL_NAMES", "LATITUDE", "LONGITUDE",
             "MAIN_INDUSTRY", "BUSINESS_CATEGORY", "CORE_OFFERINGS", "NAICS_2022"]


def _clean_offerings(v) -> "str | None":
    """CORE_OFFERINGS ships as a JSON array string; render it as a short readable
    '; '-joined list. Falls back to the raw (truncated) value if it isn't JSON."""
    import json
    if v is None:
        return None
    s = str(v).strip()
    if not s or s.lower() == "nan":
        return None
    try:
        arr = json.loads(s)
        if isinstance(arr, list):
            items = [str(x).strip() for x in arr if str(x).strip()]
            return "; ".join(items[:8]) or None
    except Exception:
        pass
    return s[:200]


def _key() -> "str | None":
    return os.getenv("DEWEY_API_KEY")


# ── Client (offline ETL only) ────────────────────────────────────────────────
def get_file_list(product_url: str, start_date: "str | None" = None,
                  end_date: "str | None" = None, timeout: int = 30) -> list:
    """Every partition's download descriptor for a product, across all pages.
    Returns a list of ``{link, file_name, file_extension, file_size_bytes, ...}``
    or ``[]`` on any failure (logged), so callers never crash."""
    key = _key()
    if not key:
        logger.error("DEWEY_API_KEY not set; cannot list Veridion files")
        return []
    files: list = []
    page, total_pages = 1, 1
    while page <= total_pages:
        params = {"page": page}
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
        try:
            r = requests.get(product_url, headers={"X-API-KEY": key}, params=params, timeout=timeout)
        except Exception as e:
            logger.error("Veridion file-list page %s request failed: %s", page, e)
            break
        if r.status_code != 200:
            logger.error("Veridion file-list page %s HTTP %s: %s", page, r.status_code, r.text[:200])
            break
        try:
            d = r.json()
        except Exception as e:
            logger.error("Veridion file-list page %s bad JSON: %s", page, e)
            break
        files.extend(d.get("download_links") or [])
        total_pages = int(d.get("total_pages") or 1)
        page += 1
    logger.info("Veridion file-list: %s files across %s page(s)", len(files), total_pages)
    return files


def download_to_tmp(url: str, suffix: str = ".parquet", timeout: int = 600, attempts: int = 3) -> "str | None":
    """Stream a partition URL to a temp file (1 MB blocks) with retry/backoff on
    Dewey's flaky pre-signed download host. Returns the temp path, or None on
    failure (caller unlinks the path when done)."""
    import tempfile
    tmp_path = None
    for attempt in range(1, attempts + 1):
        try:
            with requests.get(url, headers={"X-API-KEY": _key()}, stream=True, timeout=timeout) as r:
                r.raise_for_status()
                fd, tmp_path = tempfile.mkstemp(suffix=suffix)
                with os.fdopen(fd, "wb") as fh:
                    for block in r.iter_content(chunk_size=1 << 20):
                        if block:
                            fh.write(block)
            return tmp_path
        except Exception as e:
            logger.warning("Veridion download attempt %s/%s failed: %s", attempt, attempts, e)
            if tmp_path and os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                tmp_path = None
            if attempt == attempts:
                return None
            time.sleep(2 * attempt)
    return None


def stream_partition(link, chunksize: int = 100_000, timeout: int = 600):
    """Yield normalized pandas chunks from one partition. Streams the file to a
    temp path (1 MB blocks) then reads it batched — Veridion ships snappy Parquet,
    read row-group-batched via pyarrow with only the columns we need; a csv/csv.gz
    fallback is kept for other products. Neither the download nor the parse loads
    the whole partition into RAM. On any failure it logs and stops cleanly."""
    import tempfile

    import pandas as pd

    url = link.get("link") if isinstance(link, dict) else link
    fname = link.get("file_name", "") if isinstance(link, dict) else str(url)
    base = str(url).split("?")[0]
    is_parquet = "parquet" in fname.lower() or base.endswith(".parquet")
    gz = fname.endswith(".gz") or base.endswith(".gz")

    suffix = ".parquet" if is_parquet else (".csv.gz" if gz else ".csv")
    tmp_path = None
    try:
        # Dewey's pre-signed download host 500s intermittently; retry with backoff.
        for attempt in range(1, 4):
            try:
                with requests.get(url, headers={"X-API-KEY": _key()}, stream=True, timeout=timeout) as r:
                    r.raise_for_status()
                    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
                    with os.fdopen(fd, "wb") as fh:
                        for block in r.iter_content(chunk_size=1 << 20):
                            if block:
                                fh.write(block)
                break
            except Exception as e:
                logger.warning("Veridion download attempt %s/3 failed (%s): %s", attempt, fname, e)
                if tmp_path and os.path.exists(tmp_path):
                    try:
                        os.unlink(tmp_path)
                    except OSError:
                        pass
                    tmp_path = None
                if attempt == 3:
                    raise
                time.sleep(2 * attempt)

        if is_parquet:
            import pyarrow.parquet as pq
            pf = pq.ParquetFile(tmp_path)
            cols = [c for c in _SRC_COLS if c in set(pf.schema_arrow.names)]
            for batch in pf.iter_batches(batch_size=chunksize, columns=cols or None):
                norm = _normalize(batch.to_pandas())
                if not norm.empty:
                    yield norm
        else:
            comp = "gzip" if gz else "infer"
            for chunk in pd.read_csv(tmp_path, compression=comp, chunksize=chunksize,
                                     low_memory=False, on_bad_lines="skip"):
                norm = _normalize(chunk)
                if not norm.empty:
                    yield norm
    except Exception as e:
        logger.error("Veridion partition failed (%s): %s", fname, e)
        return
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _normalize(df):
    """Map a raw Veridion firmographics frame to our canonical columns; drop rows
    without a geocoded coordinate pair. Column lookup is case-insensitive and
    every field is optional, so a schema drift degrades a field to null rather
    than crashing. Carries a private ``_naics`` column for the ETL's manufacturer
    filter (dropped before storage)."""
    import pandas as pd

    up = {str(c).upper(): c for c in df.columns}

    def col(name):
        return df[up[name]] if name in up else None

    if "LATITUDE" not in up or "LONGITUDE" not in up:
        return df.iloc[0:0]

    name = None
    for n in ("LEGAL_NAME", "OPERATIONAL_NAME", "COMMERCIAL_NAMES"):
        s = col(n)
        if s is not None:
            s = s.astype("string")
            name = s if name is None else name.fillna(s)

    industry = col("MAIN_INDUSTRY")
    if industry is None:
        industry = col("BUSINESS_CATEGORY")
    offerings = col("CORE_OFFERINGS")
    naics = col("NAICS_2022")

    out = pd.DataFrame({
        "company_name":     name,
        "latitude":         pd.to_numeric(col("LATITUDE"), errors="coerce"),
        "longitude":        pd.to_numeric(col("LONGITUDE"), errors="coerce"),
        "company_industry": industry.astype("string") if industry is not None else None,
        "product_names":    offerings.map(_clean_offerings) if offerings is not None else None,
        "_naics":           naics.astype("string") if naics is not None else None,
    })
    return out.dropna(subset=["latitude", "longitude"])


# ── Reader (request path — stdlib only) ──────────────────────────────────────
def db_available() -> bool:
    return os.path.exists(_DB_PATH)


def _ro_conn() -> "sqlite3.Connection | None":
    if not db_available():
        return None
    try:
        return sqlite3.connect(f"file:{_DB_PATH}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as e:
        logger.error("veridion_nodes.db open failed: %s", e)
        return None


def query_nodes(product_keyword: "str | None" = None, industry: "str | None" = None,
                bbox: "tuple | None" = None, limit: int = 5000) -> list:
    """Nodes matching the filters. ``bbox`` is (south, west, north, east); the
    latitude range predicate is served by idx_latlon so viewport queries stay
    fast and return local density instead of a global sample."""
    conn = _ro_conn()
    if conn is None:
        return []
    try:
        q = ("SELECT company_name, latitude, longitude, company_industry, product_names "
             "FROM supplier_nodes WHERE 1=1")
        args: list = []
        if bbox:
            s, w, n, e = bbox
            q += " AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?"
            args += [s, n, w, e]
        if industry:
            q += " AND company_industry LIKE ?"
            args.append(f"%{industry}%")
        if product_keyword:
            q += " AND product_names LIKE ?"
            args.append(f"%{product_keyword}%")
        q += " LIMIT ?"
        args.append(int(limit))
        rows = conn.execute(q, args).fetchall()
    except sqlite3.Error as e:
        logger.error("supplier_nodes query failed: %s", e)
        return []
    finally:
        conn.close()
    return [dict(zip(_COLUMNS, r)) for r in rows]


def nodes_geojson(product_keyword: "str | None" = None, industry: "str | None" = None,
                  bbox: "tuple | None" = None, limit: int = 5000) -> dict:
    """A GeoJSON FeatureCollection of matching geocoded suppliers. Always valid,
    even before the ETL has been run — ``available`` reports whether the bundled
    DB exists so the UI can show a 'not yet ingested' state instead of breaking."""
    feats = []
    for n in query_nodes(product_keyword, industry, bbox, limit):
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [n["longitude"], n["latitude"]]},
            "properties": {
                "company_name": n["company_name"],
                "company_industry": n["company_industry"],
                "product_names": n["product_names"],
            },
        })
    return {
        "type": "FeatureCollection",
        "features": feats,
        "count": len(feats),
        "available": db_available(),
        "source": "Veridion via Dewey Data",
    }


def facets(limit: int = 300) -> dict:
    """Distinct industry + product tags for the data-driven map filter. Empty
    lists until the DB is built, so the dropdown simply has nothing to show."""
    conn = _ro_conn()
    if conn is None:
        return {"industries": [], "products": [], "available": False}
    try:
        inds = [r[0] for r in conn.execute(
            "SELECT DISTINCT company_industry FROM supplier_nodes "
            "WHERE company_industry IS NOT NULL AND company_industry <> '' ORDER BY 1 LIMIT ?", (limit,))]
        prods = [r[0] for r in conn.execute(
            "SELECT DISTINCT product_names FROM supplier_nodes "
            "WHERE product_names IS NOT NULL AND product_names <> '' ORDER BY 1 LIMIT ?", (limit,))]
    except sqlite3.Error as e:
        logger.error("supplier facets failed: %s", e)
        return {"industries": [], "products": [], "available": True}
    finally:
        conn.close()
    return {"industries": inds, "products": prods, "available": True}
