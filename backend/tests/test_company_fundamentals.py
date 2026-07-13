import sqlite3

from logistics.company_fundamentals import _identity_matches, _resolve


def _db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE ticker_index (symbol TEXT, exchange TEXT, veridion_id TEXT);
        CREATE TABLE companies (veridion_id TEXT PRIMARY KEY, name TEXT);
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
