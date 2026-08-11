"""Freshness of the offline SQLite datasets shipped with the image.

These are built by batch ingests and baked into the container, so nothing about
them refreshes on its own. That is a reasonable design — it keeps a vendor outage
off the request path — but it has one failure mode: a dataset can silently rot
for weeks and every tool that reads it keeps serving the stale numbers with a
confident face. That is exactly what happened to the port performance data, which
went thirty days without a rebuild and was only noticed by accident.

Two dates matter and they are not the same:

    built      when the ingest last ran
    sourceAsOf the newest observation the vendor had at that point

A dataset rebuilt this morning against a vendor that publishes five weeks in
arrears is fresh by the first measure and stale by the second. Both are reported;
neither is inferred from the other.

Where an ingest writes no metadata table, the build date falls back to the file
mtime and `sourceAsOf` is read from the data itself when the table is known. That
is a stopgap: the ingests should write the convention, and the ones that do not
are flagged so the gap is visible rather than papered over.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import date, datetime, timezone

_DATA_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data"))


def _fmt(day: date | None) -> str | None:
    return day.isoformat() if day else None


# Each entry names the tool that would go wrong, so a stale row reads as a
# consequence rather than a filename.
DATASETS: tuple[dict, ...] = (
    {
        "id": "port_performance", "file": "port_performance.db",
        "label": "Ocean port performance", "vendor": "Dewey Data",
        "powers": "Port boards, Dewey port markers on Energy Flows",
        "as_of_sql": "SELECT MAX(event_date) FROM daily_performance WHERE performance_hours IS NOT NULL",
        "rebuild": "python -m logistics.ingest_port_performance",
    },
    {
        "id": "veridion_nodes", "file": "veridion_nodes.db",
        "label": "Supplier nodes", "vendor": "Veridion via Dewey",
        "powers": "Supplier layer on Freight Map",
        "rebuild": "python -m logistics.ingest_veridion",
    },
    {
        "id": "supply_chain", "file": "supply_chain.db",
        "label": "Tickered supply chain", "vendor": "Veridion / SEC",
        "powers": "Supply Chain Peers",
        "rebuild": "python -m logistics.ingest_supply_chain",
    },
    {
        "id": "corporate", "file": "corporate.db",
        "label": "Corporate reference", "vendor": "LSEG via Dewey",
        "powers": "Insider transactions, institutional holdings",
        "rebuild": "python -m logistics.ingest_corporate",
    },
    {
        "id": "crsp", "file": "crsp.db",
        "label": "CRSP daily", "vendor": "CRSP via WRDS",
        "powers": "Index membership, delisting-aware history",
        "rebuild": "python -m logistics.ingest_crsp",
    },
    {
        "id": "consumer_spend", "file": "consumer_spend.db",
        "label": "Consumer spend", "vendor": "SafeGraph via Dewey",
        "powers": "Consumer spend panels",
        "rebuild": "python -m logistics.ingest_safegraph_spend",
    },
    {
        "id": "renthub", "file": "renthub_snapshot.db",
        "label": "Rental listings", "vendor": "RentHub via Dewey",
        "powers": "Housing Market rental section",
        "rebuild": "python -m logistics.ingest_renthub",
    },
)

# Past this a dataset is called out. Deliberately generous: these are batch
# products, and a fortnight-old build is normal rather than broken.
STALE_AFTER_DAYS = 21


def _read_one(spec: dict, today: date) -> dict:
    path = os.path.join(_DATA_DIR, spec["file"])
    row: dict = {
        "id": spec["id"], "label": spec["label"], "vendor": spec["vendor"],
        "powers": spec["powers"], "rebuild": spec["rebuild"], "file": spec["file"],
        "present": os.path.isfile(path),
        "built": None, "sourceAsOf": None, "sizeMb": None,
        "hasMetadataTable": False, "builtAgeDays": None, "stale": None,
    }
    if not row["present"]:
        row["note"] = "Not installed on this deployment."
        return row

    row["sizeMb"] = round(os.path.getsize(path) / (1024 * 1024), 1)
    # mtime is the fallback build date, and it is genuinely weaker: copying the
    # file or rebuilding the image can move it without the data changing.
    row["built"] = _fmt(datetime.fromtimestamp(os.path.getmtime(path), timezone.utc).date())

    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "metadata" in tables:
            row["hasMetadataTable"] = True
            meta = dict(conn.execute("SELECT key, value FROM metadata").fetchall())
            row["built"] = meta.get("refresh") or row["built"]
            row["sourceAsOf"] = meta.get("source_as_of") or meta.get("as_of")
        if not row["sourceAsOf"] and spec.get("as_of_sql"):
            # Its own try: a probe query that fails because the schema moved must
            # not blank the build date and staleness we already established.
            try:
                got = conn.execute(spec["as_of_sql"]).fetchone()
                row["sourceAsOf"] = got[0] if got else None
            except sqlite3.Error as e:
                row["note"] = f"Source as-of probe failed: {e}"
        conn.close()
    except sqlite3.Error as e:
        row["note"] = f"Unreadable: {e}"
        return row

    if not row["hasMetadataTable"]:
        row["note"] = (
            "This ingest writes no metadata table, so the build date is the file "
            "timestamp and the vendor's own as-of date is unknown."
        )

    try:
        built = date.fromisoformat(str(row["built"])[:10])
        row["builtAgeDays"] = (today - built).days
        row["stale"] = row["builtAgeDays"] > STALE_AFTER_DAYS
    except (TypeError, ValueError):
        pass
    return row


def inventory(as_of: date | None = None) -> dict:
    today = as_of or datetime.now(timezone.utc).date()
    rows = [_read_one(spec, today) for spec in DATASETS]
    missing_convention = [r["id"] for r in rows if r["present"] and not r["hasMetadataTable"]]
    return {
        "datasets": rows,
        "staleAfterDays": STALE_AFTER_DAYS,
        "staleCount": sum(1 for r in rows if r.get("stale")),
        "missingMetadataConvention": missing_convention,
        "note": (
            "Built is when the ingest last ran; source as-of is the newest observation "
            "the vendor had. A dataset can be freshly built and still months behind."
        ),
    }


def write_metadata(conn: sqlite3.Connection, *, source_as_of: str | None = None, **extra) -> None:
    """Record the convention from inside an ingest.

    Called at the end of a rebuild so the dataset can answer for its own age
    instead of leaving callers to guess from a file timestamp.
    """
    conn.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)")
    values = {"refresh": datetime.now(timezone.utc).date().isoformat()}
    if source_as_of:
        values["source_as_of"] = str(source_as_of)
    values.update({k: str(v) for k, v in extra.items() if v is not None})
    conn.executemany("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)", values.items())
    conn.commit()
