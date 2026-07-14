"""Build-time / scheduled ETL: LSEG Insiders + Institutional/Fund Ownership + SDC Deals -> data/corporate.db.

If CSV files are present in data/ (e.g. lseg_insiders.csv, lseg_ownership.csv, sdc_deals.csv),
ingests them. Otherwise, if run with --mock, generates rich, realistic mock data for major tickers.
"""
from __future__ import annotations

import argparse
import csv
import logging
import os
import sqlite3
import sys
import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from corporate_db import DB_PATH as _DB_PATH

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("ingest_corporate")
_CUSIP_CACHE: dict[str, str] = {}
_NAME_TO_TICKER_MAP: dict[str, str] = {}
_CUSIP_TO_TICKER_MAP = {
    "037833": "AAPL",
    "594918": "MSFT",
    "88160R": "TSLA",
    "68389X": "ORCL",
    "007903": "AMD",
    "67066G": "NVDA",
    "466313": "JBL",
    "416515": "HIG",
    "29786A": "ETSY",
    "38259P": "GOOG",
    "38259T": "GOOGL",
    "023135": "AMZN",
    "30303M": "META",
    "64110D": "NFLX"
}


def _clean_name(name: str) -> str:
    if not name:
        return ""
    n = name.lower()
    for sfx in [
        "co., ltd.", "co. ltd.", "ltd.", "inc.", "corp.", "corporation", 
        "incorporated", "company", "co.", "limited", "group", "holdings"
    ]:
        n = n.replace(sfx, "")
    return "".join(c for c in n if c.isalnum()).strip()


def _load_offline_lookups() -> None:
    sc_db = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "supply_chain.db"))
    if not os.path.exists(sc_db):
        return
    try:
        conn = sqlite3.connect(sc_db)
        cursor = conn.cursor()
        rows = cursor.execute("SELECT name, exchange_tickers FROM companies").fetchall()
        for name, tickers in rows:
            if not name or not tickers:
                continue
            t_parts = tickers.split(";")
            for p in t_parts:
                if ":" in p:
                    ticker = p.split(":")[1].strip().upper()
                    if ticker:
                        cleaned = _clean_name(name)
                        if cleaned:
                            _NAME_TO_TICKER_MAP[cleaned] = ticker
                        break
        conn.close()
    except Exception as e:
        log.warning("Offline name-to-ticker lookup initialization failed: %s", e)


def _cusip_to_ticker(cusip: str, name: str | None = None) -> str | None:
    if cusip:
        c6 = cusip.strip()[:6]
        if c6 in _CUSIP_TO_TICKER_MAP:
            return _CUSIP_TO_TICKER_MAP[c6]
            
    if name:
        cleaned = _clean_name(name)
        if cleaned in _NAME_TO_TICKER_MAP:
            return _NAME_TO_TICKER_MAP[cleaned]
            
    return None


def _init(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        DROP TABLE IF EXISTS lseg_insider_transactions;
        DROP TABLE IF EXISTS lseg_insider_returns;
        DROP TABLE IF EXISTS lseg_institutional_holdings;
        DROP TABLE IF EXISTS lseg_ownership_rollup;
        DROP TABLE IF EXISTS sdc_deals;

        CREATE TABLE lseg_insider_transactions (
            ticker TEXT,
            date TEXT,
            insider_name TEXT,
            title TEXT,
            shares INTEGER,
            value REAL,
            txn_classification TEXT,
            is_amendment INTEGER,
            is_form144 INTEGER,
            is_10b51 INTEGER
        );

        CREATE TABLE lseg_insider_returns (
            ticker TEXT,
            txn_type TEXT,
            avg_return_3m REAL,
            avg_return_6m REAL,
            avg_return_12m REAL
        );

        CREATE TABLE lseg_institutional_holdings (
            ticker TEXT,
            holder_name TEXT,
            shares INTEGER,
            value REAL,
            pct_out REAL,
            date TEXT,
            change_shares INTEGER,
            holder_type TEXT,
            investment_style TEXT
        );

        CREATE TABLE lseg_ownership_rollup (
            ticker TEXT PRIMARY KEY,
            passive_pct REAL,
            active_pct REAL,
            insider_pct REAL
        );

        CREATE TABLE sdc_deals (
            deal_id TEXT PRIMARY KEY,
            date_announced TEXT,
            date_completed TEXT,
            acquirer_ticker TEXT,
            acquirer_name TEXT,
            target_ticker TEXT,
            target_name TEXT,
            deal_value REAL,
            deal_terms TEXT,
            deal_status TEXT
        );

        CREATE INDEX idx_insider_ticker ON lseg_insider_transactions(ticker);
        CREATE INDEX idx_inst_ticker ON lseg_institutional_holdings(ticker);
        CREATE INDEX idx_deals_acquirer ON sdc_deals(acquirer_ticker);
        CREATE INDEX idx_deals_target ON sdc_deals(target_ticker);
    """)
    conn.commit()


def _populate_mock_data(conn: sqlite3.Connection) -> None:
    log.info("Populating corporate database with rich mock data...")
    # Mock data for: AAPL, MSFT, TSLA, ORCL, AMD, JBL, HIG, NVDA
    insiders = [
        # Ticker, Date, Name, Title, Shares, Value, Class, Amendment, Form144, 10b51
        ("AAPL", "2026-07-10", "Tim Cook", "CEO", 50000, 11200000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("AAPL", "2026-07-08", "Luca Maestri", "CFO", 12000, 2680000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("AAPL", "2026-06-15", "Arthur Levinson", "Director", 5000, 1100000, "Discretionary Buy", 0, 0, 0),
        ("AAPL", "2026-06-01", "Deirdre O'Brien", "Senior VP", 8000, 1780000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("AAPL", "2026-05-18", "Jeff Williams", "COO", 15000, 3350000, "Form 144 Intent to Sell", 0, 1, 0),

        ("MSFT", "2026-07-12", "Satya Nadella", "CEO", 40000, 16800000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("MSFT", "2026-07-11", "Amy Hood", "CFO", 10000, 4200000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("MSFT", "2026-06-20", "Brad Smith", "President", 6000, 2520000, "Discretionary Sell", 0, 0, 0),
        ("MSFT", "2026-05-25", "Kathleen Hogan", "Chief HR Officer", 4500, 1890000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("MSFT", "2026-05-10", "Reid Hoffman", "Director", 20000, 8400000, "Discretionary Buy", 0, 0, 0),

        ("TSLA", "2026-07-09", "Elon Musk", "CEO", 150000, 37500000, "Discretionary Sell", 0, 0, 0),
        ("TSLA", "2026-06-28", "Kimbal Musk", "Director", 25000, 6250000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("TSLA", "2026-06-12", "Robyn Denholm", "Chairman", 10000, 2500000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("TSLA", "2026-05-30", "Andrew Baglino", "Senior VP", 8000, 2000000, "Discretionary Sell", 0, 0, 0),
        ("TSLA", "2026-05-01", "Elon Musk", "CEO", 80000, 20000000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),

        ("ORCL", "2026-07-13", "Lawrence J Ellison", "Chairman/CTO", 120000, 16430400, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("ORCL", "2026-07-06", "Safra A Catz", "CEO", 45000, 6160500, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("ORCL", "2026-06-22", "Jeffrey O Henley", "Vice Chairman", 8000, 1096000, "Discretionary Sell", 0, 0, 0),
        ("ORCL", "2026-05-15", "Rona A Fairhead", "Director", 2000, 274000, "Discretionary Buy", 0, 0, 0),

        ("AMD", "2026-07-10", "Lisa T Su", "CEO/Chair", 30000, 4800000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("AMD", "2026-07-01", "Devinder Kumar", "CFO", 8000, 1280000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
        ("AMD", "2026-06-18", "Victor Peng", "President", 5000, 800000, "Discretionary Sell", 0, 0, 0),
        ("AMD", "2026-05-05", "Lisa T Su", "CEO/Chair", 40000, 6400000, "Planned Sell (Rule 10b5-1)", 0, 0, 1),
    ]

    conn.executemany(
        "INSERT INTO lseg_insider_transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        insiders
    )

    returns = [
        # Ticker, TxnType, 3M, 6M, 12M
        ("AAPL", "Discretionary Buy", 3.42, 6.81, 11.24),
        ("AAPL", "Planned Sell (Rule 10b5-1)", -0.12, -0.45, -1.05),
        ("AAPL", "Discretionary Sell", -1.05, -2.14, -4.50),

        ("MSFT", "Discretionary Buy", 4.15, 8.92, 14.80),
        ("MSFT", "Planned Sell (Rule 10b5-1)", 0.05, 0.12, 0.25),
        ("MSFT", "Discretionary Sell", -0.80, -1.50, -3.10),

        ("TSLA", "Discretionary Buy", 8.40, 15.60, 28.40),
        ("TSLA", "Planned Sell (Rule 10b5-1)", -1.10, -2.25, -5.80),
        ("TSLA", "Discretionary Sell", -4.50, -9.10, -18.20),

        ("ORCL", "Discretionary Buy", 2.80, 5.90, 10.40),
        ("ORCL", "Planned Sell (Rule 10b5-1)", 0.10, 0.30, 0.70),
        ("ORCL", "Discretionary Sell", -1.20, -2.40, -5.10),

        ("AMD", "Discretionary Buy", 5.60, 11.40, 19.80),
        ("AMD", "Planned Sell (Rule 10b5-1)", -0.40, -0.90, -1.80),
        ("AMD", "Discretionary Sell", -2.10, -4.60, -9.20),
    ]

    conn.executemany(
        "INSERT INTO lseg_insider_returns VALUES (?, ?, ?, ?, ?)",
        returns
    )

    # Top holdings: institutions & funds
    holdings = [
        # Ticker, Name, Shares, Value, Pct, Date, Change, Type, Style
        ("AAPL", "Vanguard Group Inc", 1320000000, 297000000000.0, 8.42, "2026-06-30", 4500000, "institutional", "Passive"),
        ("AAPL", "BlackRock Inc", 1080000000, 243000000000.0, 6.89, "2026-06-30", -2100000, "institutional", "Passive"),
        ("AAPL", "Berkshire Hathaway Inc", 915000000, 205875000000.0, 5.84, "2026-06-30", 0, "institutional", "Active"),
        ("AAPL", "State Street Corp", 580000000, 130500000000.0, 3.70, "2026-06-30", 1200000, "institutional", "Passive"),
        ("AAPL", "Fidelity Management & Research", 420000000, 94500000000.0, 2.68, "2026-06-30", 8200000, "institutional", "Active"),
        ("AAPL", "Vanguard Total Stock Market Index Fund", 450000000, 101250000000.0, 2.87, "2026-06-30", 2200000, "fund", "Passive"),
        ("AAPL", "Vanguard 500 Index Fund", 340000000, 76500000000.0, 2.17, "2026-06-30", 1800000, "fund", "Passive"),
        ("AAPL", "Fidelity Contrafund", 85000000, 19125000000.0, 0.54, "2026-06-30", -500000, "fund", "Active"),

        ("MSFT", "Vanguard Group Inc", 660000000, 277200000000.0, 8.85, "2026-06-30", 2800000, "institutional", "Passive"),
        ("MSFT", "BlackRock Inc", 540000000, 226800000000.0, 7.24, "2026-06-30", -1400000, "institutional", "Passive"),
        ("MSFT", "State Street Corp", 310000000, 130200000000.0, 4.16, "2026-06-30", 800000, "institutional", "Passive"),
        ("MSFT", "Fidelity Management & Research", 280000000, 117600000000.0, 3.75, "2026-06-30", 5400000, "institutional", "Active"),
        ("MSFT", "Vanguard Total Stock Market Index Fund", 225000000, 94500000000.0, 3.01, "2026-06-30", 1100000, "fund", "Passive"),
        ("MSFT", "Vanguard 500 Index Fund", 170000000, 71400000000.0, 2.28, "2026-06-30", 900000, "fund", "Passive"),
        ("MSFT", "Growth Fund of America", 62000000, 26040000000.0, 0.83, "2026-06-30", 250000, "fund", "Active"),

        ("ORCL", "Vanguard Group Inc", 185000000, 25345000000.0, 6.75, "2026-06-30", 1400000, "institutional", "Passive"),
        ("ORCL", "BlackRock Inc", 152000000, 20824000000.0, 5.55, "2026-06-30", -450000, "institutional", "Passive"),
        ("ORCL", "State Street Corp", 92000000, 12604000000.0, 3.36, "2026-06-30", 120000, "institutional", "Passive"),
        ("ORCL", "Fidelity Management & Research", 84000000, 11508000000.0, 3.07, "2026-06-30", 2100000, "institutional", "Active"),
        ("ORCL", "Vanguard Total Stock Market Index Fund", 58000000, 7946000000.0, 2.12, "2026-06-30", 480000, "fund", "Passive"),
        ("ORCL", "Vanguard 500 Index Fund", 44000000, 6028000000.0, 1.61, "2026-06-30", 390000, "fund", "Passive"),
    ]

    conn.executemany(
        "INSERT INTO lseg_institutional_holdings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        holdings
    )

    rollups = [
        # Ticker, Passive%, Active%, Insider%
        ("AAPL", 52.4, 28.1, 0.08),
        ("MSFT", 56.1, 22.4, 0.05),
        ("TSLA", 28.4, 20.2, 13.02),
        ("ORCL", 32.5, 24.1, 42.18),
        ("AMD", 54.8, 32.2, 0.44),
    ]

    conn.executemany(
        "INSERT INTO lseg_ownership_rollup VALUES (?, ?, ?, ?)",
        rollups
    )

    deals = [
        # DealID, Announced, Completed, AcqTicker, AcqName, TargetTicker, TargetName, Value($M), Terms, Status
        ("DE-202601", "2026-05-18", "2026-08-30", "AAPL", "Apple Inc", "ORCL", "Oracle Corp", 1200.0, "Acquisition of Oracle Cloud Infrastructure (OCI) Custom AI Hardware Division for $1.2B cash.", "Pending"),
        ("DE-202602", "2026-04-12", "2026-07-01", "MSFT", "Microsoft Corp", "AMD", "Advanced Micro Devices Inc", 8500.0, "Acquisition of AMD Semi-Custom Embedded Gaming Console Silicon Unit for $8.5B Cash & Stock.", "Completed"),
        ("DE-202603", "2026-06-25", None, "TSLA", "Tesla Inc", "JBL", "Jabil Inc", 340.0, "Agreement to acquire Jabil Automotive Electronics Manufacturing Plant in Guadalajara, Mexico for $340M cash.", "Pending"),
        ("DE-202604", "2026-02-14", "2026-05-10", "AMD", "Advanced Micro Devices Inc", "HIG", "Hartford Financial Services Group (Asset Division)", 95.0, "Asset purchase of Hartford Financial real estate portfolio for server facilities at $95M cash.", "Completed"),
    ]

    conn.executemany(
        "INSERT INTO sdc_deals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        deals
    )

    conn.commit()


def _init_tables_if_not_exists(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS lseg_insider_transactions (
            ticker TEXT,
            date TEXT,
            insider_name TEXT,
            title TEXT,
            shares INTEGER,
            value REAL,
            txn_classification TEXT,
            is_amendment INTEGER,
            is_form144 INTEGER,
            is_10b51 INTEGER
        );
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS lseg_insider_returns (
            ticker TEXT,
            txn_type TEXT,
            avg_return_3m REAL,
            avg_return_6m REAL,
            avg_return_12m REAL
        );
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS lseg_institutional_holdings (
            ticker TEXT,
            holder_name TEXT,
            shares INTEGER,
            value REAL,
            pct_out REAL,
            date TEXT,
            change_shares INTEGER,
            holder_type TEXT,
            investment_style TEXT
        );
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS lseg_ownership_rollup (
            ticker TEXT PRIMARY KEY,
            passive_pct REAL,
            active_pct REAL,
            insider_pct REAL
        );
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sdc_deals (
            deal_id TEXT PRIMARY KEY,
            date_announced TEXT,
            date_completed TEXT,
            acquirer_ticker TEXT,
            acquirer_name TEXT,
            target_ticker TEXT,
            target_name TEXT,
            deal_value REAL,
            deal_terms TEXT,
            deal_status TEXT
        );
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_insider_ticker ON lseg_insider_transactions(ticker)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_inst_ticker ON lseg_institutional_holdings(ticker)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_deals_acquirer ON sdc_deals(acquirer_ticker)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_deals_target ON sdc_deals(target_ticker)")
    conn.commit()


def main() -> None:
    parser = argparse.ArgumentParser(description="Ingest LSEG and SDC corporate data.")
    parser.add_argument("--mock", action="store_true", help="Populate with rich mock data for major tickers.")
    args = parser.parse_args()

    conn = sqlite3.connect(_DB_PATH)

    if args.mock:
        _init(conn)
        _populate_mock_data(conn)
        conn.close()
        log.info("Mock database generated successfully at %s", _DB_PATH)
        return

    _init_tables_if_not_exists(conn)
    _load_offline_lookups()

    # Real data files paths
    insiders_csv = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "lseg_insiders.csv"))
    returns_csv = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "lseg_insider_returns.csv"))
    holdings_csv = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "lseg_ownership.csv"))
    rollup_csv = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "lseg_ownership_rollup.csv"))
    deals_csv = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data", "sdc_deals.csv"))

    # Ingest insiders
    if os.path.exists(insiders_csv):
        log.info("Ingesting insiders from %s", insiders_csv)
        conn.execute("DELETE FROM lseg_insider_transactions")
        with open(insiders_csv, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = []
            for r in reader:
                ticker = (r.get("ticker") or r.get("Ticker Symbol") or "").strip().upper()
                date_val = (r.get("date") or r.get("trandate") or r.get("Transaction Date") or "").strip()
                insider_name = (r.get("insider_name") or r.get("owner") or r.get("Owner") or "").strip()
                title = (r.get("title") or r.get("rolecode1") or r.get("Role Code 1") or "").strip()
                
                shares_str = r.get("shares") or r.get("Number of Shares") or r.get("shares_adj") or "0"
                try:
                    shares = int(float(shares_str))
                except ValueError:
                    shares = 0
                
                price_str = r.get("tprice") or r.get("Transaction Price") or r.get("tprice_adj") or "0"
                try:
                    price = float(price_str)
                except ValueError:
                    price = 0.0
                
                val_str = r.get("value") or r.get("amount") or "0"
                try:
                    value = float(val_str)
                except ValueError:
                    value = 0.0
                if value == 0.0 and shares > 0 and price > 0.0:
                    value = float(shares * price)
                    
                txn_code = (r.get("txn_code") or r.get("trancode") or r.get("Transaction Code") or "").strip()
                
                amend_val = r.get("is_amendment") or r.get("amend") or r.get("Amendment Indicator") or "0"
                is_amendment = 1 if amend_val and str(amend_val).strip().upper() in ("1", "Y", "YES", "A", "TRUE") else 0
                
                form144_val = r.get("is_form144") or r.get("form144") or "0"
                is_form144 = 1 if form144_val and str(form144_val).strip().upper() in ("1", "Y", "YES", "TRUE") else 0
                
                is10b51_val = r.get("is_10b51") or r.get("rule10b5") or r.get("rule10b51") or "0"
                is_10b51 = 1 if is10b51_val and str(is10b51_val).strip().upper() in ("1", "Y", "YES", "TRUE") else 0

                rows.append((
                    ticker, date_val, insider_name, title, shares, value, txn_code, is_amendment, is_form144, is_10b51
                ))
                if len(rows) >= 50000:
                    conn.executemany("INSERT INTO lseg_insider_transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
                    rows = []
            if rows:
                conn.executemany("INSERT INTO lseg_insider_transactions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)

    # Ingest returns
    if os.path.exists(returns_csv):
        log.info("Ingesting average returns from %s", returns_csv)
        conn.execute("DELETE FROM lseg_insider_returns")
        with open(returns_csv, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = []
            for r in reader:
                ticker = (r.get("ticker") or r.get("ticsym") or r.get("Ticker Symbol") or "").strip().upper()
                if not ticker:
                    cusip = (r.get("cusip") or r.get("Cusip") or "").strip()
                    if cusip:
                        ticker = _cusip_to_ticker(cusip)
                
                # Safe skip if ticker is absent
                if not ticker:
                    continue
                
                # Parse Buy returns
                ret3b = r.get("ret_avg3buy") or r.get("avg_return_3m") or "0"
                ret6b = r.get("ret_avg6buy") or r.get("avg_return_6m") or "0"
                ret12b = r.get("ret_avg12buy") or r.get("avg_return_12m") or "0"
                try:
                    r3b, r6b, r12b = float(ret3b), float(ret6b), float(ret12b)
                except ValueError:
                    r3b = r6b = r12b = 0.0
                
                if abs(r3b) > 0.0 and abs(r3b) <= 1.0:
                    r3b *= 100.0
                if abs(r6b) > 0.0 and abs(r6b) <= 1.0:
                    r6b *= 100.0
                if abs(r12b) > 0.0 and abs(r12b) <= 1.0:
                    r12b *= 100.0
                
                rows.append((ticker, "Discretionary Buy", round(r3b, 2), round(r6b, 2), round(r12b, 2)))
                
                # Parse Sell returns
                ret3s = r.get("ret_avg3sell") or "0"
                ret6s = r.get("ret_avg6sell") or "0"
                ret12s = r.get("ret_avg12sell") or "0"
                try:
                    r3s, r6s, r12s = float(ret3s), float(ret6s), float(ret12s)
                except ValueError:
                    r3s = r6s = r12s = 0.0
                
                if abs(r3s) > 0.0 and abs(r3s) <= 1.0:
                    r3s *= 100.0
                if abs(r6s) > 0.0 and abs(r6s) <= 1.0:
                    r6s *= 100.0
                if abs(r12s) > 0.0 and abs(r12s) <= 1.0:
                    r12s *= 100.0
                
                rows.append((ticker, "Planned Sell (Rule 10b5-1)", round(r3s, 2), round(r6s, 2), round(r12s, 2)))
                
                if len(rows) >= 50000:
                    conn.executemany("INSERT INTO lseg_insider_returns VALUES (?, ?, ?, ?, ?)", rows)
                    rows = []
            if rows:
                conn.executemany("INSERT INTO lseg_insider_returns VALUES (?, ?, ?, ?, ?)", rows)

    # Ingest holdings
    _MGR_NAMES = {
        "93630": "Vanguard Group Inc",
        "09115": "BlackRock Inc",
        "85550": "State Street Corp",
        "26515": "Fidelity Management & Research",
        "35700": "Geode Capital Management LLC",
        "12800": "T. Rowe Price Associates Inc",
        "59300": "JPMorgan Chase & Co",
        "08500": "Balyasny Asset Management",
        "11110": "Citadel Advisors LLC",
        "57400": "Morgan Stanley",
        "38000": "Goldman Sachs Group Inc",
        "90500": "Invesco Ltd",
        "93700": "Wellington Management Co LLP",
        "64100": "Northern Trust Corp",
        "07400": "Bank of America Corp",
        "53500": "Mellon Investments Corp",
        "23200": "Dimensional Fund Advisors LP",
        "31110": "Fisher Asset Management LLC",
        "60700": "Norges Bank Investment Management",
        "02120": "AllianceBernstein LP"
    }

    if os.path.exists(holdings_csv):
        log.info("Ingesting institutional holdings from %s", holdings_csv)
        conn.execute("DELETE FROM lseg_institutional_holdings")
        with open(holdings_csv, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = []
            for r in reader:
                ticker = (r.get("ticker") or r.get("Ticker Symbol") or "").strip().upper()
                
                # Resolve manager name. "stkname" is the SECURITY's own name (e.g.
                # a security-level rollup export carries it on every row for that
                # ticker), never a holder's — treating it as a holder-name fallback
                # mislabeled every row as the company itself. A row with no real
                # per-holder identity (no holder_name/manager_name/mgrno) isn't
                # holder data at all, so it's skipped rather than fabricated.
                mgr_no = str(r.get("mgrno") or "").strip()
                holder_name = (r.get("holder_name") or r.get("manager_name") or "").strip()
                if not holder_name and mgr_no:
                    holder_name = _MGR_NAMES.get(mgr_no, f"Institutional Manager #{mgr_no}")
                if not holder_name:
                    continue
                
                # Calculate total shares from voting authorities if single shares field is missing
                shares_val = r.get("shares") or "0"
                try:
                    shares = int(float(shares_val))
                except ValueError:
                    shares = 0
                if shares == 0:
                    sole = int(float(r.get("sole") or 0))
                    shared = int(float(r.get("shared") or 0))
                    no_vote = int(float(r.get("no") or 0))
                    shares = sole + shared + no_vote

                # Share price for value calculation
                prc_val = r.get("prc") or "0"
                try:
                    price = float(prc_val)
                except ValueError:
                    price = 0.0

                # Value
                val_str = r.get("value") or "0"
                try:
                    value = float(val_str)
                except ValueError:
                    value = 0.0
                if value == 0.0 and shares > 0 and price > 0.0:
                    value = float(shares * price)

                # Shares Outstanding (for pct_out calculation)
                shrout = 0.0
                shrout1_str = r.get("shrout1") # In millions
                shrout2_str = r.get("shrout2") # In thousands
                if shrout1_str:
                    try: shrout = float(shrout1_str) * 1_000_000
                    except ValueError: pass
                elif shrout2_str:
                    try: shrout = float(shrout2_str) * 1_000
                    except ValueError: pass

                # Pct Out — some feeds report this as a 0-1 fraction rather than
                # an already-scaled percent (same ambiguity the rollup ingest
                # below guards against); normalize before falling back to the
                # computed shares/shrout ratio.
                pct_out_str = r.get("pct_out") or "0"
                try:
                    pct_out = float(pct_out_str)
                except ValueError:
                    pct_out = 0.0
                if pct_out > 0.0 and pct_out <= 1.0:
                    pct_out = pct_out * 100.0
                if pct_out == 0.0 and shares > 0 and shrout > 0:
                    pct_out = float((shares / shrout) * 100.0)

                date_val = (r.get("date") or r.get("rdate") or "").strip()
                
                change_str = r.get("change_shares") or r.get("change") or "0"
                try:
                    change_shares = int(float(change_str))
                except ValueError:
                    change_shares = 0

                holder_type = (r.get("holder_type") or "").strip().lower()
                if not holder_type:
                    holder_type = "institutional"

                investment_style = (r.get("investment_style") or "").strip()
                if not investment_style:
                    is_passive = mgr_no in ("93630", "09115", "85550", "35700")
                    investment_style = "Passive" if is_passive else "Active"

                rows.append((
                    ticker, holder_name, shares, value, pct_out, date_val, change_shares, holder_type, investment_style
                ))
                if len(rows) >= 50000:
                    conn.executemany("INSERT INTO lseg_institutional_holdings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
                    rows = []
            if rows:
                conn.executemany("INSERT INTO lseg_institutional_holdings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)

    # Ingest rollup
    if os.path.exists(rollup_csv):
        log.info("Ingesting ownership rollups from %s", rollup_csv)
        conn.execute("DELETE FROM lseg_ownership_rollup")
        with open(rollup_csv, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            # Each ticker has one row per (report date x holding category) — a full
            # multi-year history, not one row per ticker. Summing every row (as
            # this used to) adds up years of quarterly snapshots into one
            # impossible >100% figure. Keep only the latest report date per
            # ticker, accumulating across categories (passive/active/insider)
            # within that one date only.
            aggregates = {}
            for r in reader:
                ticker = (r.get("ticker") or r.get("ticsym") or r.get("Ticker Symbol") or "").strip().upper()
                if not ticker:
                    continue

                report_date = (r.get("reportdate") or r.get("rdate") or r.get("Report Date") or "").strip()
                hldg = str(r.get("hldgtype") or r.get("Holding Category") or "").strip().upper()
                pct_str = r.get("pctshareoutstanding") or r.get("Percent of Shares Outstanding") or "0"
                try:
                    pct = float(pct_str)
                except ValueError:
                    pct = 0.0
                if pct > 0.0 and pct <= 1.0:
                    pct = pct * 100.0

                entry = aggregates.get(ticker)
                if entry is None or report_date > entry["date"]:
                    entry = {"date": report_date, "passive": 0.0, "active": 0.0, "insider": 0.0}
                    aggregates[ticker] = entry
                elif report_date < entry["date"]:
                    continue  # older snapshot than the latest already captured

                if "PASS" in hldg or hldg == "P" or "INDEX" in hldg:
                    entry["passive"] += pct
                elif "ACT" in hldg or hldg == "A":
                    entry["active"] += pct
                elif "INS" in hldg or hldg == "I" or "DIR" in hldg:
                    entry["insider"] += pct
                else:
                    if hldg == "1":
                        entry["passive"] += pct
                    elif hldg == "2":
                        entry["active"] += pct
                    elif hldg == "3":
                        entry["insider"] += pct

            rows = []
            for ticker, data in aggregates.items():
                rows.append((
                    ticker,
                    round(data["passive"], 2),
                    round(data["active"], 2),
                    round(data["insider"], 2)
                ))
                
                if len(rows) >= 50000:
                    conn.executemany("INSERT INTO lseg_ownership_rollup VALUES (?, ?, ?, ?)", rows)
                    rows = []
            if rows:
                conn.executemany("INSERT INTO lseg_ownership_rollup VALUES (?, ?, ?, ?)", rows)

    # Ingest deals
    if os.path.exists(deals_csv):
        log.info("Ingesting SDC M&A deals from %s", deals_csv)
        conn.execute("DELETE FROM sdc_deals")
        with open(deals_csv, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            rows = []
            seen_deals = set()
            for r in reader:
                deal_id = (r.get("deal_id") or r.get("deal_no") or r.get("dealid") or r.get("master_deal_no") or "").strip()
                if not deal_id:
                    continue
                
                # Deduplicate deal IDs in SDC dataset
                if deal_id in seen_deals:
                    continue
                seen_deals.add(deal_id)
                
                date_announced = (r.get("date_announced") or r.get("da") or r.get("announced") or r.get("dateann") or "").strip()
                date_completed = (r.get("date_completed") or r.get("de") or r.get("effective_date") or r.get("dateeff") or "").strip() or None
                
                acquirer_ticker = (r.get("acquirer_ticker") or r.get("acq_ticker") or r.get("acq_symbol") or r.get("aticker") or "").strip().upper() or None
                if not acquirer_ticker:
                    acusip = (r.get("acusip") or r.get("acquiror_sedol") or "").strip()
                    if acusip:
                        acquirer_ticker = _cusip_to_ticker(acusip)
                acquirer_name = (r.get("acquirer_name") or r.get("acq_name") or r.get("amanames") or "Unknown Acquirer").strip()
                
                target_ticker = (r.get("target_ticker") or r.get("tar_ticker") or r.get("tar_symbol") or r.get("tticker") or "").strip().upper() or None
                if not target_ticker:
                    tcusip = (r.get("tcusip") or r.get("cusip") or r.get("target_sedol") or "").strip()
                    if tcusip:
                        target_ticker = _cusip_to_ticker(tcusip)
                target_name = (r.get("target_name") or r.get("tar_name") or r.get("tmanames") or "Unknown Target").strip()
                
                val_str = r.get("deal_value") or r.get("val") or r.get("value") or "0"
                try:
                    deal_value = float(val_str)
                except ValueError:
                    deal_value = 0.0
                    
                deal_terms = (r.get("deal_terms") or r.get("synopsis") or r.get("terms") or "").strip()
                deal_status = (r.get("deal_status") or r.get("status") or "").strip()
                
                rows.append((
                    deal_id, date_announced, date_completed, acquirer_ticker, acquirer_name, target_ticker, target_name, deal_value, deal_terms, deal_status
                ))
                if len(rows) >= 50000:
                    conn.executemany("INSERT INTO sdc_deals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
                    rows = []
            if rows:
                conn.executemany("INSERT INTO sdc_deals VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)

    conn.commit()
    conn.close()
    log.info("Data ingestion completed successfully.")


if __name__ == "__main__":
    main()
