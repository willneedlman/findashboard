"""Read the compact RentHub rental-listing serving database."""
from __future__ import annotations

import os
import sqlite3


_DB = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "renthub_snapshot.db"))

_JURISDICTIONS = (
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC",
)


def snapshot(limit: int = 51) -> dict:
    if not os.path.isfile(_DB):
        return {"available": False, "source": "RentHub", "reason": "snapshot not ingested"}
    conn = sqlite3.connect(f"file:{_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        meta = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM metadata")}
        national = dict(conn.execute("SELECT * FROM national LIMIT 1").fetchone() or {})
        observed = [dict(r) for r in conn.execute(
            "SELECT state, listings, median_rent, median_rent_per_sqft, median_rent_1br, median_rent_2br "
            "FROM state_snapshot ORDER BY listings DESC"
        )]
    finally:
        conn.close()
    observed_by_state = {row["state"]: row for row in observed if row["state"] in _JURISDICTIONS}
    missing = [
        {
            "state": state,
            "listings": None,
            "median_rent": None,
            "median_rent_per_sqft": None,
            "median_rent_1br": None,
            "median_rent_2br": None,
        }
        for state in _JURISDICTIONS
        if state not in observed_by_state
    ]
    states = [row for row in observed if row["state"] in observed_by_state] + missing
    states = states[:max(0, min(limit, len(_JURISDICTIONS)))]
    return {
        "available": bool(national),
        "source": "RentHub",
        "as_of": meta.get("as_of"),
        "partitions": int(meta.get("partitions", "0")),
        "state_count": len(_JURISDICTIONS),
        "covered_state_count": len(observed_by_state),
        "national": national,
        "states": states,
    }
