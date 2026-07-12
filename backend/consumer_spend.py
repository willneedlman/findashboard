"""Read the compact SafeGraph Spend Patterns serving database."""
from __future__ import annotations

import os
import sqlite3


_DB = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data", "consumer_spend.db"))


def summary(limit: int = 8) -> dict:
    if not os.path.isfile(_DB):
        return {"available": False, "source": "SafeGraph Spend Patterns", "reason": "snapshot not ingested"}
    conn = sqlite3.connect(f"file:{_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        meta = {r["key"]: r["value"] for r in conn.execute("SELECT key, value FROM metadata")}
        categories = [dict(r) for r in conn.execute(
            "SELECT category, total_spend, transactions, online_spend, spend_change_pct "
            "FROM category_month ORDER BY total_spend DESC LIMIT ?", (limit,)
        )]
        national = dict(conn.execute(
            "SELECT total_spend, transactions, online_spend, spend_change_pct FROM national_month LIMIT 1"
        ).fetchone() or {})
    finally:
        conn.close()
    return {
        "available": bool(national), "source": "SafeGraph Spend Patterns", "as_of": meta.get("as_of"),
        "coverage_note": "Merchant-spend activity, not consumer loan performance.",
        "national": national, "categories": categories,
    }
