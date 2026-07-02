"""Stream & filter NOAA Marine Cadastre daily AIS GeoParquet from Azure.

Standalone analysis utility (heavy geo deps → intentionally NOT wired into the
API image). Reads a day's national broadcast-point file directly from the Azure
blob over HTTP range requests — never downloading the whole file — and returns
only the rows inside a bounding box.

    pip install pyarrow geopandas shapely
    python backend/scripts/fetch_ais_marinecadastre.py 2024_01_01

Note: the real filename convention is lowercase/hyphenated
`ais-YYYY-MM-DD.parquet` under .../marinecadastre/ais2024/ (not the
`AIS_YYYY_MM_DD` form). fsspec's HTTP layer mis-probes this blob, so we use a
small seekable range reader instead.
"""
import io
import sys

import requests
import pyarrow.parquet as pq

BASE = "https://ocmgeodatastor1.blob.core.windows.net/marinecadastre"


class HttpRangeFile(io.RawIOBase):
    """Minimal seekable file over HTTP range requests (for pyarrow footer +
    row-group reads without downloading the whole object)."""
    def __init__(self, url: str):
        self.url = url
        self.pos = 0
        h = requests.head(url, timeout=30)
        h.raise_for_status()
        self.size = int(h.headers["Content-Length"])

    def seekable(self): return True
    def readable(self): return True
    def tell(self): return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else (self.pos + off if whence == 1 else self.size + off)
        return self.pos

    def readinto(self, b):
        n = len(b)
        if self.pos >= self.size or n <= 0:
            return 0
        end = min(self.pos + n, self.size) - 1
        data = requests.get(self.url, headers={"Range": f"bytes={self.pos}-{end}"}, timeout=120).content
        b[:len(data)] = data
        self.pos += len(data)
        return len(data)


def ais_url(date_str: str) -> str:
    """`YYYY_MM_DD` (or `YYYY-MM-DD`) → the daily GeoParquet blob URL."""
    d = date_str.replace("_", "-")
    year = d[:4]
    return f"{BASE}/ais{year}/ais-{d}.parquet"


def fetch_ais_by_date(date_str: str, bbox=None):
    """Return a GeoDataFrame of AIS broadcast points for the given day.

    date_str : 'YYYY_MM_DD' or 'YYYY-MM-DD'
    bbox     : (min_lon, min_lat, max_lon, max_lat) to restrict the area, or None.

    Streams row-group by row-group over HTTP range requests and filters each to
    the bbox, so memory stays bounded and only the needed bytes are fetched.
    """
    import geopandas as gpd
    import pandas as pd

    reader = io.BufferedReader(HttpRangeFile(ais_url(date_str)))
    pf = pq.ParquetFile(reader)
    frames = []
    for i in range(pf.num_row_groups):
        gdf = gpd.GeoDataFrame.from_arrow(pf.read_row_group(i))
        if bbox is not None:
            minx, miny, maxx, maxy = bbox
            gdf = gdf.cx[minx:maxx, miny:maxy]
        if len(gdf):
            frames.append(gdf)
    if not frames:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:4326")
    return gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=frames[0].crs)


if __name__ == "__main__":
    date = sys.argv[1] if len(sys.argv) > 1 else "2024_01_01"
    # default AOI: New York / New Jersey approaches
    box = (-74.3, 40.3, -73.6, 40.8)
    gdf = fetch_ais_by_date(date, bbox=box)
    print(f"{date}  bbox={box}  ->  {len(gdf)} broadcast points")
    if len(gdf):
        cols = [c for c in ("mmsi", "vessel_name", "sog", "cog", "vessel_type") if c in gdf.columns]
        print(gdf[cols].head(5).to_string(index=False))
