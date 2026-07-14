import sqlite3

from logistics.company_fundamentals import _identity_matches, _resolve


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE ticker_index (symbol TEXT, exchange TEXT, veridion_id TEXT);
        CREATE TABLE companies (veridion_id TEXT PRIMARY KEY, name TEXT);
        CREATE TABLE customer_links (
            supplier_ticker TEXT NOT NULL,
            customer_ticker TEXT,
            customer_name TEXT NOT NULL,
            customer_sales REAL,
            pct_of_revenue REAL,
            fiscal_year INTEGER NOT NULL
        );
    """)
    return conn


def test_identity_match_removes_legal_and_listing_noise():
    assert _identity_matches("Wal-Mart.com USA, LLC", "Walmart Inc.")
    assert not _identity_matches("11880 Solutions AG", "Target Corporation")


def test_resolve_rejects_foreign_bare_ticker_collision():
    conn = _db()
    conn.execute("INSERT INTO companies VALUES (?, ?)", ("foreign", "11880 Solutions AG"))
    conn.execute("INSERT INTO ticker_index VALUES (?, ?, ?)", ("TGT", "ETR", "foreign"))

    company, exchange = _resolve(conn, "TGT", "Target Corporation")

    assert company is None
    assert exchange is None


def test_resolve_uses_matching_us_issuer():
    conn = _db()
    conn.executemany("INSERT INTO companies VALUES (?, ?)", [
        ("foreign", "11880 Solutions AG"),
        ("target", "Target Corporation"),
    ])
    conn.executemany("INSERT INTO ticker_index VALUES (?, ?, ?)", [
        ("TGT", "ETR", "foreign"),
        ("TGT", "NYSE", "target"),
    ])

    company, exchange = _resolve(conn, "TGT", "Target Corp.")

    assert company["name"] == "Target Corporation"
    assert exchange == "NYSE"


def test_query_customer_links():
    from logistics.company_fundamentals import query_customer_links
    import logistics.company_fundamentals as cf

    conn = _db()
    conn.executemany("INSERT INTO companies VALUES (?, ?)", [
        ("amkr_id", "Amkor Technology, Inc."),
        ("aapl_id", "Apple Inc."),
    ])
    conn.executemany("INSERT INTO ticker_index VALUES (?, ?, ?)", [
        ("AMKR", "NASDAQ", "amkr_id"),
        ("AAPL", "NASDAQ", "aapl_id"),
    ])
    conn.executemany("INSERT INTO customer_links VALUES (?, ?, ?, ?, ?, ?)", [
        ("AMKR", "AAPL", "APPLE INC", 1500.0, 33.33, 2025),
        ("AAPL", None, "US GOVT", 12000.0, 3.16, 2025),
    ])

    orig_conn = cf._conn
    orig_avail = cf.available
    cf._conn = lambda: conn
    cf.available = lambda: True

    try:
        res_aapl = query_customer_links("AAPL")
        assert len(res_aapl["customers"]) == 1
        assert res_aapl["customers"][0]["customer_name"] == "US GOVT"
        assert res_aapl["customers"][0]["pct_of_revenue"] == 3.16

        assert len(res_aapl["suppliers"]) == 1
        assert res_aapl["suppliers"][0]["supplier_ticker"] == "AMKR"
        assert res_aapl["suppliers"][0]["supplier_name"] == "Amkor Technology, Inc."
        assert res_aapl["suppliers"][0]["pct_of_revenue"] == 33.33

        res_amkr = query_customer_links("AMKR")
        assert len(res_amkr["customers"]) == 1
        assert res_amkr["customers"][0]["customer_ticker"] == "AAPL"
        assert len(res_amkr["suppliers"]) == 0
    finally:
        cf._conn = orig_conn
        cf.available = orig_avail

