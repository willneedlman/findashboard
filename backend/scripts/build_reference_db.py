"""Build backend/data/reference.db — a read-only SQLite reference cache sourced from
FactIQ (SEC EDGAR fundamentals + national macro series).

FactIQ is MCP-only, so it cannot be called from the FastAPI runtime. Extraction is a
BUILD-TIME step: Claude Code queries the FactIQ MCP in-session and drops the results as
intermediate JSON under scripts/reference_intermediates/, then this script assembles the
SQLite file from those intermediates. Committing the intermediates keeps the build
reproducible and documents exactly what was pulled. Refresh quarterly by re-running the
FactIQ extraction (regenerating the intermediates) and re-running this script.

The fundamentals table backfills only the SEC-derivable half of the screener seed
(margins, ROE/ROA, leverage, current ratio, revenue/EPS growth, plus name/sector/
industry). Price/market-dependent ratios (peRatio, pbRatio, psRatio, evEbitda, pegRatio,
beta, dividendYield) are NOT here by design — they cannot live in a quarterly snapshot and
stay live via FMP/yfinance.

Intermediate contract:
  reference_intermediates/fund_batch_*.json  -> {"columns": FUND_COLS, "rows": [[...], ...]}
  reference_intermediates/macro_*.json       -> {"series": {...meta...}, "points": [[iso, val], ...]}
Run:  python3 backend/scripts/build_reference_db.py
"""
import glob
import json
import os
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")
INTER = os.path.join(HERE, "reference_intermediates")
DB = os.path.join(DATA, "reference.db")

# Column contract for the fundamentals snapshot — MUST match the extraction query's
# SELECT order exactly. Ratios are computed IN SQL (keeps the returned rows small so more
# names fit under FactIQ's ~4KB result window). Margins/ROE/ROA/growth are percentages;
# TTM = trailing 4 reported quarters, growth is YoY on a TTM basis. Descriptive fields
# (name/sector/industry) are intentionally NOT stored here — the loader merges those from
# the existing Finnhub seed and overrides only these fundamental ratios.
FUND_COLS = [
    "ticker", "lastQuarter", "grossMargin", "operatingMargin", "netMargin",
    "roe", "roa", "debtEquity", "currentRatio", "revenueGrowth", "epsGrowth",
]


def _norm(t: str) -> str:
    return str(t).strip().upper().replace(".", "-")


def _load_fundamentals(cur):
    cur.execute("""
        CREATE TABLE fundamentals (
            ticker TEXT PRIMARY KEY, lastQuarter TEXT,
            grossMargin REAL, operatingMargin REAL, netMargin REAL,
            roe REAL, roa REAL, debtEquity REAL, currentRatio REAL,
            revenueGrowth REAL, epsGrowth REAL
        )""")
    n = 0
    for path in sorted(glob.glob(os.path.join(INTER, "fund_batch_*.json"))):
        # each intermediate is {"columns": [...], "rows": [[...], ...]} copied verbatim
        # from a FactIQ run_sql result (row mode). Column order == FUND_COLS.
        batch = json.load(open(path))
        for row in batch["rows"]:
            r = dict(zip(batch["columns"], row))
            r["ticker"] = _norm(r["ticker"])
            cur.execute(
                f"INSERT OR REPLACE INTO fundamentals ({','.join(FUND_COLS)}) VALUES ({','.join('?' * len(FUND_COLS))})",
                [r.get(c) for c in FUND_COLS])
            n += 1
    return n


def _load_macro(cur):
    cur.execute("""
        CREATE TABLE macro_series (
            series_id TEXT PRIMARY KEY, fred_id TEXT, source_schema TEXT,
            title TEXT, units TEXT, frequency TEXT
        )""")
    cur.execute("""
        CREATE TABLE macro_points (
            series_id TEXT, time TEXT, value REAL,
            PRIMARY KEY (series_id, time)
        )""")
    ns, npts = 0, 0
    for path in sorted(glob.glob(os.path.join(INTER, "macro_*.json"))):
        m = json.load(open(path))
        s = m["series"]
        cur.execute(
            "INSERT OR REPLACE INTO macro_series (series_id, fred_id, source_schema, title, units, frequency) VALUES (?,?,?,?,?,?)",
            [s["series_id"], s.get("fred_id"), s.get("source_schema"), s.get("title"), s.get("units"), s.get("frequency")])
        ns += 1
        for t, v in m["points"]:
            cur.execute("INSERT OR REPLACE INTO macro_points (series_id, time, value) VALUES (?,?,?)",
                        [s["series_id"], t, v])
            npts += 1
    return ns, npts


def main():
    if not os.path.isdir(INTER):
        raise SystemExit(f"no intermediates at {INTER} — run the FactIQ extraction first")
    if os.path.exists(DB):
        os.remove(DB)
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    nf = _load_fundamentals(cur)
    ns, npts = _load_macro(cur)
    cur.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    for k, v in [("source", "FactIQ (SEC EDGAR + national macro)"),
                 ("fundamentals_rows", str(nf)),
                 ("macro_series", str(ns)), ("macro_points", str(npts))]:
        cur.execute("INSERT INTO meta VALUES (?,?)", [k, v])
    conn.commit()
    conn.close()
    print(f"reference.db: {nf} fundamentals, {ns} macro series ({npts} points) -> {DB}")


if __name__ == "__main__":
    main()
