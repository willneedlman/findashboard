"""Classify 13F filers using their Form ADV registration.

A 13F says what a manager holds and nothing about what kind of firm it is.
Form ADV Item 5.D does: it reports how much of an adviser's regulatory assets
belong to each type of client, so a firm running pooled vehicles is
distinguishable from one running registered funds or private wealth. Every
label here traces to a specific field on a specific filing, because a fund type
guessed from a name is a fabrication with a confident font.

Two limits, both stated in the interface rather than hidden:

  Only 45% of 13F cover pages carry the CRD number this joins on. The rest get
  no label at all, which is the honest outcome.

  The archive runs to 31 December 2024, so an adviser registered after that is
  missing. Registration type rarely changes, so an older filing is still a fair
  description of an older firm; a new one simply has none.

"Quant" is deliberately absent. It is a strategy, and no filing records it.

    python scripts/build_adv_types.py
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import sqlite3
import sys
import zipfile
from datetime import datetime
from pathlib import Path

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
ARCHIVE = "https://www.sec.gov/files/adv-filing-data-20111105-20241231-part1.zip"
MEMBER = "adv-filing-data-20111105-20241231-part1/IA_ADV_Base_A_20111105_20241231.csv"
DB_PATH = Path(__file__).resolve().parents[1] / "data" / "thirteenf.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS advisers (
    crd        TEXT PRIMARY KEY,
    name       TEXT,
    filed      TEXT,
    aum        REAL,
    kind       TEXT,          -- the label shown beside a manager
    basis      TEXT,          -- which Item 5.D client type drove it
    share      REAL           -- that type's share of reported assets
) WITHOUT ROWID;
"""

# Item 5.D.3: assets attributable to each client type. The letters are the
# form's own, so a label can always be traced back to the line that produced it.
CLIENT_TYPES = {
    "5D3a": ("Wealth manager",  "individuals"),
    "5D3b": ("Wealth manager",  "high net worth individuals"),
    "5D3c": ("Institutional",   "banks"),
    "5D3d": ("Asset manager",   "registered investment companies"),
    "5D3e": ("Asset manager",   "business development companies"),
    "5D3f": ("Private fund",    "pooled investment vehicles"),
    "5D3g": ("Institutional",   "pension and profit sharing plans"),
    "5D3h": ("Institutional",   "charitable organisations"),
    "5D3i": ("Institutional",   "state and municipal entities"),
    "5D3j": ("Sub-adviser",     "other investment advisers"),
    "5D3k": ("Institutional",   "insurance companies"),
    "5D3l": ("Institutional",   "sovereign wealth funds"),
    "5D3m": ("Corporate",       "corporations"),
    "5D3n": ("Other",           "other clients"),
}


def num(v) -> float:
    try:
        return float(str(v).replace(",", "").replace("$", "").strip() or 0)
    except ValueError:
        return 0.0


def when(v: str) -> str:
    for fmt in ("%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y"):
        try:
            return datetime.strptime(v.strip(), fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def classify(buckets: dict) -> tuple[str, str, float] | None:
    """The client type holding most of the adviser's assets.

    A share rather than a count: an adviser with a thousand small individual
    accounts and one enormous fund is a fund manager, and counting clients would
    say the opposite.
    """
    total = sum(buckets.values())
    if total <= 0:
        return None
    key = max(buckets, key=lambda k: buckets[k])
    label, basis = CLIENT_TYPES[key]
    return label, basis, buckets[key] / total * 100


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DB_PATH))
    ap.add_argument("--cache", default="", help="A previously downloaded archive zip")
    args = ap.parse_args()

    if args.cache and Path(args.cache).exists():
        blob = Path(args.cache).read_bytes()
        print(f"using {args.cache} ({len(blob)/1e6:.0f}MB)")
    else:
        print(f"fetching {ARCHIVE.rsplit('/', 1)[-1]} (702MB)", flush=True)
        blob = requests.get(ARCHIVE, headers=UA, timeout=1800).content

    z = zipfile.ZipFile(io.BytesIO(blob))
    print("reading Item 5.D from every registered-adviser filing", flush=True)

    # One row per adviser: the most recent filing wins, because an adviser's
    # client mix is a current fact and the archive holds thirteen years of them.
    latest: dict[str, dict] = {}
    seen = 0
    with z.open(MEMBER) as fh:
        for row in csv.DictReader(io.TextIOWrapper(fh, "utf-8", errors="replace")):
            seen += 1
            crd = (row.get("1E1") or "").strip()
            if not crd:
                continue
            filed = when(row.get("DateSubmitted") or "")
            prev = latest.get(crd)
            if prev and prev["filed"] >= filed:
                continue
            # Only the fields that matter, not the row: 243 columns times a
            # hundred thousand advisers would be gigabytes held for no reason.
            latest[crd] = {"name": (row.get("1A") or "").strip(), "filed": filed,
                           "aum": num(row.get("5F2c")),
                           "types": {k: num(row.get(k)) for k in CLIENT_TYPES}}
            if seen % 250_000 == 0:
                print(f"    {seen:,} filings, {len(latest):,} advisers", flush=True)
    print(f"    {seen:,} filings -> {len(latest):,} advisers", flush=True)

    rows, unclassified = [], 0
    for crd, a in latest.items():
        got = classify(a["types"])
        if not got:
            unclassified += 1
            continue
        label, basis, share = got
        rows.append((crd, a["name"], a["filed"], a["aum"], label, basis, round(share, 1)))
    print(f"    {len(rows):,} classified, {unclassified:,} without an Item 5.D breakdown")

    conn = sqlite3.connect(args.out)
    conn.executescript(SCHEMA)
    conn.executemany(
        "INSERT OR REPLACE INTO advisers (crd, name, filed, aum, kind, basis, share)"
        " VALUES (?,?,?,?,?,?,?)", rows)
    conn.commit()

    have = conn.execute(
        "SELECT COUNT(*) FROM filers f JOIN advisers a ON a.crd = f.crd WHERE f.crd IS NOT NULL"
    ).fetchone()[0] if _has_crd(conn) else 0
    print(f"\nstored {len(rows):,} advisers; {have:,} 13F filings now carry a label")
    for kind, n in conn.execute(
            "SELECT kind, COUNT(*) FROM advisers GROUP BY kind ORDER BY COUNT(*) DESC"):
        print(f"    {kind:<16} {n:,}")
    conn.close()


def _has_crd(conn) -> bool:
    return any(r[1] == "crd" for r in conn.execute("PRAGMA table_info(filers)"))


if __name__ == "__main__":
    main()
