"""Build the 13F holdings database from SEC's quarterly bulk datasets.

Why bulk rather than crawling EDGAR: one 99MB download carries every filer for a
quarter, about 10,700 of them, where crawling gave twenty and took minutes per
manager. It also removes the per-manager rate limit entirely, because there is
nothing left to fetch at read time.

Run it when SEC publishes a new quarter:

    python scripts/build_13f_db.py            # the two newest quarters
    python scripts/build_13f_db.py --quarters 4

The output is bounded on purpose. Production runs on a 1GB machine, so this
aggregates each filing to one row per CUSIP before it lands (Berkshire's 89
rows become 29), keeps only whole-share equity lines, and drops positions under
a floor that would round to nothing in any view.
"""
from __future__ import annotations

import argparse
import csv
import io
import os
import re
import sqlite3
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
INDEX = "https://www.sec.gov/data-research/sec-markets-data/form-13f-data-sets"
DB_PATH = Path(__file__).resolve().parents[1] / "data" / "thirteenf.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS filers (
    id        INTEGER PRIMARY KEY,
    accession TEXT UNIQUE NOT NULL,
    cik       TEXT NOT NULL,
    name      TEXT NOT NULL,
    period    TEXT NOT NULL,
    amended   INTEGER NOT NULL DEFAULT 0,
    filed     TEXT,
    total     REAL NOT NULL DEFAULT 0,
    positions INTEGER NOT NULL DEFAULT 0,
    truncated INTEGER NOT NULL DEFAULT 0,
    -- A manager can file an original and several amendments for one quarter:
    -- Vanguard filed three for 2026-03-31, one of them a partial restatement
    -- covering $47B of a $3,996B book. Reading them all shows the same fund
    -- several times, so exactly one filing per manager per quarter is marked
    -- canonical, and it is the one reporting the largest book, which is the
    -- complete statement rather than a partial amendment to it.
    canonical INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS filers_cik    ON filers(cik, period DESC);
CREATE INDEX IF NOT EXISTS filers_period ON filers(period DESC, total DESC);
CREATE INDEX IF NOT EXISTS filers_name   ON filers(name COLLATE NOCASE);

-- One row per security rather than per position. The issuer name repeats across
-- every filer that holds it, so 2.2M copies collapse to about 25k. ticker is
-- filled in once by the resolver and shared by every view afterwards.
CREATE TABLE IF NOT EXISTS securities (
    cusip  TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    class  TEXT,
    ticker TEXT
) WITHOUT ROWID;

-- filer_id rather than the accession string: a 20-character key repeated
-- millions of times is most of what a naive table costs.
CREATE TABLE IF NOT EXISTS positions (
    filer_id INTEGER NOT NULL,
    cusip    TEXT NOT NULL,
    value    REAL NOT NULL,
    shares   REAL NOT NULL,
    calls    REAL NOT NULL DEFAULT 0,
    puts     REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (filer_id, cusip)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS positions_cusip ON positions(cusip, value DESC);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
"""

# Bounds, so the file stays sane on a 1GB machine. Market makers report thousands
# of tiny lines: Simplex Trading files 8,302 positions, and nobody reads past the
# top few hundred of a book. Both bounds are recorded per filer so a truncated
# book can say so rather than pretend to be complete.
VALUE_FLOOR = 100_000
POSITION_CAP = 500

_MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}


def iso(d: str) -> str:
    """SEC writes 31-MAR-2026 in these files and ISO everywhere else."""
    try:
        day, mon, year = d.strip().split("-")
        return f"{year}-{_MONTHS[mon.upper()]:02d}-{int(day):02d}"
    except Exception:
        return d.strip()


def dataset_urls(limit: int) -> list[str]:
    r = requests.get(INDEX, headers=UA, timeout=60)
    r.raise_for_status()
    links = list(dict.fromkeys(re.findall(r'href="([^"]*13f[^"]*\.zip)"', r.text, re.I)))
    return [(u if u.startswith("http") else "https://www.sec.gov" + u) for u in links[:limit]]


def load_quarter(conn: sqlite3.Connection, url: str) -> None:
    name = url.rsplit("/", 1)[-1]
    print(f"  fetching {name}", flush=True)
    blob = requests.get(url, headers=UA, timeout=600).content
    z = zipfile.ZipFile(io.BytesIO(blob))

    def rows(member):
        return csv.DictReader(io.TextIOWrapper(z.open(member), "utf-8", errors="replace"),
                              delimiter="\t")

    subs = {}
    for s in rows("SUBMISSION.tsv"):
        if not s["SUBMISSIONTYPE"].startswith("13F-HR"):
            continue          # 13F-NT is a notice: the holdings are on someone else's filing
        subs[s["ACCESSION_NUMBER"]] = {
            "cik": s["CIK"].lstrip("0") or "0",
            "period": iso(s["PERIODOFREPORT"]),
            "filed": iso(s["FILING_DATE"]),
            "amended": 1 if s["SUBMISSIONTYPE"].endswith("/A") else 0,
        }
    for c in rows("COVERPAGE.tsv"):
        if c["ACCESSION_NUMBER"] in subs:
            subs[c["ACCESSION_NUMBER"]]["name"] = (c.get("FILINGMANAGER_NAME") or "").strip()
    print(f"    {len(subs):,} holdings reports", flush=True)

    # Aggregate before storing. One row per CUSIP per filing is what every view
    # wants, and the raw table is several times larger for no added meaning.
    agg: dict[tuple[str, str], dict] = {}
    kept = skipped = 0
    for t in rows("INFOTABLE.tsv"):
        acc = t["ACCESSION_NUMBER"]
        if acc not in subs:
            continue
        if (t.get("SSHPRNAMTTYPE") or "").strip() != "SH":
            skipped += 1      # PRN is a principal amount, not a share count
            continue
        cusip = (t.get("CUSIP") or "").strip().upper()
        if not cusip:
            continue
        key = (acc, cusip)
        a = agg.get(key)
        if a is None:
            a = agg[key] = {"issuer": (t.get("NAMEOFISSUER") or "").strip()[:80],
                            "class": (t.get("TITLEOFCLASS") or "").strip()[:24],
                            "value": 0.0, "shares": 0.0, "calls": 0.0, "puts": 0.0}
        value = float(t.get("VALUE") or 0)
        shares = float(t.get("SSHPRNAMT") or 0)
        pc = (t.get("PUTCALL") or "").strip().lower()
        # Option lines share an issuer with stock lines and belong in neither the
        # share count nor the position value.
        if pc == "call":
            a["calls"] += shares
        elif pc == "put":
            a["puts"] += shares
        else:
            a["shares"] += shares
            a["value"] += value
        kept += 1
    print(f"    {kept:,} equity lines -> {len(agg):,} positions ({skipped:,} principal rows dropped)",
          flush=True)

    # Rank each filing's positions and keep the top slice above the floor.
    by_filing: dict[str, list] = defaultdict(list)
    for (acc, cusip), a in agg.items():
        if a["value"] < VALUE_FLOOR and not a["calls"] and not a["puts"]:
            continue
        by_filing[acc].append((cusip, a))

    securities: dict[str, tuple] = {}
    filer_rows, position_rows = [], []
    next_id = (conn.execute("SELECT COALESCE(MAX(id), 0) FROM filers").fetchone()[0] or 0) + 1
    existing = dict(conn.execute("SELECT accession, id FROM filers").fetchall())

    for acc, items in by_filing.items():
        s_ = subs[acc]
        items.sort(key=lambda kv: -kv[1]["value"])
        truncated = 1 if len(items) > POSITION_CAP else 0
        total = sum(a["value"] for _, a in items)
        kept_items = items[:POSITION_CAP]
        fid = existing.get(acc)
        if fid is None:
            fid = next_id
            next_id += 1
        filer_rows.append((fid, acc, s_["cik"], s_.get("name") or f"CIK {s_['cik']}",
                           s_["period"], s_["amended"], s_["filed"], total, len(items), truncated))
        for cusip, a in kept_items:
            securities.setdefault(cusip, (cusip, a["issuer"], a["class"]))
            position_rows.append((fid, cusip, a["value"], a["shares"], a["calls"], a["puts"]))

    conn.executemany(
        "INSERT OR REPLACE INTO filers (id, accession, cik, name, period, amended, filed,"
        " total, positions, truncated) VALUES (?,?,?,?,?,?,?,?,?,?)", filer_rows)
    conn.executemany(
        "INSERT OR IGNORE INTO securities (cusip, issuer, class) VALUES (?,?,?)",
        list(securities.values()))
    conn.executemany(
        "INSERT OR REPLACE INTO positions (filer_id, cusip, value, shares, calls, puts)"
        " VALUES (?,?,?,?,?,?)", position_rows)
    conn.commit()
    payload = position_rows
    print(f"    stored {len(payload):,} positions", flush=True)


def resolve_tickers(conn: sqlite3.Connection, top: int) -> None:
    """Fill securities.ticker for the most-held names.

    Done once here rather than per request: SEC identifies securities by CUSIP
    and publishes no ticker map, and the mapping API is rate limited. Resolving
    the top slice by aggregate reported value covers everything anyone searches
    for, and the answer is stored beside the security so no view ever waits.
    """
    import thirteenf
    rows = conn.execute(
        "SELECT s.cusip FROM securities s JOIN positions p ON p.cusip = s.cusip"
        " WHERE s.ticker IS NULL GROUP BY s.cusip ORDER BY SUM(p.value) DESC LIMIT ?",
        (top,)).fetchall()
    cusips = [r[0] for r in rows]
    if not cusips:
        print("  every security already has a ticker")
        return
    print(f"  resolving {len(cusips):,} CUSIPs (keyless mapping runs ~250/min)", flush=True)
    done = 0
    for i in range(0, len(cusips), 100):
        chunk = cusips[i:i + 100]
        found = thirteenf.resolve_cusips(chunk)
        conn.executemany("UPDATE securities SET ticker = ? WHERE cusip = ?",
                         [(t, c) for c, t in found.items()])
        conn.commit()
        done += len(chunk)
        print(f"    {done:,}/{len(cusips):,}", flush=True)
    have = conn.execute("SELECT COUNT(*) FROM securities WHERE ticker IS NOT NULL").fetchone()[0]
    print(f"  {have:,} securities now carry a ticker")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quarters", type=int, default=2,
                    help="How many published quarters to load. Two is the minimum for a diff.")
    ap.add_argument("--out", default=str(DB_PATH))
    ap.add_argument("--tickers", type=int, default=4000,
                    help="How many of the most-held CUSIPs to map to tickers. 0 skips it.")
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(out)
    conn.executescript(SCHEMA)

    urls = dataset_urls(args.quarters)
    print(f"loading {len(urls)} quarter(s) into {out}")
    for u in urls:
        load_quarter(conn, u)

    if args.tickers:
        print("resolving tickers")
        resolve_tickers(conn, args.tickers)

    print("marking one canonical filing per manager per quarter")
    conn.execute("UPDATE filers SET canonical = 0")
    conn.execute(
        "UPDATE filers SET canonical = 1 WHERE id IN ("
        "  SELECT id FROM (SELECT id, ROW_NUMBER() OVER"
        "    (PARTITION BY cik, period ORDER BY total DESC, filed DESC) rn FROM filers)"
        "  WHERE rn = 1)")
    conn.commit()
    dupes = conn.execute(
        "SELECT COUNT(*) FROM (SELECT cik, period FROM filers GROUP BY cik, period HAVING COUNT(*) > 1)"
    ).fetchone()[0]
    print(f"  {dupes:,} manager-quarters had more than one filing")
    conn.execute("CREATE INDEX IF NOT EXISTS filers_canon ON filers(period, canonical, total DESC)")
    conn.commit()

    periods = [r[0] for r in conn.execute(
        "SELECT DISTINCT period FROM filers ORDER BY period DESC").fetchall()]
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('periods', ?)",
                 (",".join(periods),))
    conn.commit()
    conn.execute("VACUUM")
    conn.close()

    mb = out.stat().st_size / 1e6
    print(f"\n{out} is {mb:.0f}MB")
    print("periods:", ", ".join(periods[:8]))


if __name__ == "__main__":
    main()
