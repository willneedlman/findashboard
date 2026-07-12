"""Read the compact RentHub rental-listing serving database."""
from __future__ import annotations

import os
import sqlite3


_DB = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "renthub_snapshot.db"))


def snapshot(limit: int = 12) -> dict:
    if not os.path.isfile(_DB):
        return {"available": False, "source": "RentHub", "reason": "snapshot not ingested"}
    conn = sqlite3.connect(f"file:{_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        meta = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM metadata")}
        national = dict(conn.execute("SELECT * FROM national LIMIT 1").fetchone() or {})
        states = [dict(r) for r in conn.execute(
            "SELECT state, listings, median_rent, median_rent_per_sqft, median_rent_1br, median_rent_2br "
            "FROM state_snapshot ORDER BY listings DESC LIMIT ?", (limit,)
        )]
    finally:
        conn.close()
    return {"available": bool(national), "source": "RentHub", "as_of": meta.get("as_of"), "national": national, "states": states}
