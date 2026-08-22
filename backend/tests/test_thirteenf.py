"""13F holdings.

The rules worth pinning are the ones that stop a snapshot being read as a trade
log, and the ones that stop a filing's own shape corrupting a book: rows are
per-manager, option lines sit beside stock lines, and PRN rows are principal
amounts rather than shares.
"""
import os
import sys
import uuid

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import thirteenf as tf

_XML = """<?xml version="1.0"?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <infoTable><nameOfIssuer>ACME CORP</nameOfIssuer><titleOfClass>COM</titleOfClass>
    <cusip>111111111</cusip><value>600</value>
    <shrsOrPrnAmt><sshPrnamt>60</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>
  <infoTable><nameOfIssuer>ACME CORP</nameOfIssuer><titleOfClass>COM</titleOfClass>
    <cusip>111111111</cusip><value>400</value>
    <shrsOrPrnAmt><sshPrnamt>40</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>
  <infoTable><nameOfIssuer>ACME CORP</nameOfIssuer><titleOfClass>COM</titleOfClass>
    <cusip>111111111</cusip><value>50</value><putCall>Call</putCall>
    <shrsOrPrnAmt><sshPrnamt>500</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>
  <infoTable><nameOfIssuer>ACME NOTE 2030</nameOfIssuer><titleOfClass>NOTE</titleOfClass>
    <cusip>111111AA1</cusip><value>900</value>
    <shrsOrPrnAmt><sshPrnamt>900000</sshPrnamt><sshPrnamtType>PRN</sshPrnamtType></shrsOrPrnAmt></infoTable>
</informationTable>"""


@pytest.fixture
def parsed(monkeypatch):
    class R:
        text = _XML
    monkeypatch.setattr(tf, "_table_url", lambda c, a: "http://x/t.xml")
    monkeypatch.setattr(tf.requests, "get", lambda *a, **k: R())
    # holdings() is persist=True, so cache_clear only drops the memory tier and a
    # parse stored by an earlier run would answer instead of the code under test.
    # A unique accession per call means the key can never have been seen before.
    tf.holdings.cache_clear()
    return tf.holdings("1", f"acc-{uuid.uuid4()}")["positions"]


def test_rows_are_per_manager_and_aggregate_onto_one_position(parsed):
    # Two manager rows for one issuer are one position, not two.
    assert list(parsed) == ["111111111"]
    assert parsed["111111111"]["shares"] == 100
    assert parsed["111111111"]["value"] == 1000


def test_options_are_exposure_and_never_join_the_share_count(parsed):
    p = parsed["111111111"]
    assert p["shares"] == 100
    assert p["calls"] == 500


def test_a_principal_amount_is_not_a_share_count(parsed):
    # 900,000 of face value would dwarf every equity line it sat beside.
    assert "111111AA1" not in parsed


def test_a_new_position_has_no_percentage_change():
    # Coming from nothing is not a 100% increase, it is a new position, and the
    # caller labels it that way instead.
    assert tf._pct_change(100, None) is None
    assert tf._pct_change(100, 0) is None
    assert tf._pct_change(150, 100) == pytest.approx(50)
    assert tf._pct_change(50, 100) == pytest.approx(-50)


def test_foreign_identifiers_are_cins_not_cusip():
    # Chubb files H1467J104, which returns nothing as a CUSIP and resolves as a
    # CINS. Getting this wrong silently drops every non-US-domiciled issuer.
    assert "H1467J104"[:1].isalpha()
    assert not "037833100"[:1].isalpha()


def test_the_crawl_fallback_reports_how_much_it_actually_read(monkeypatch):
    # Only reachable with no dataset present, which is a fresh checkout before
    # scripts/build_13f_db.py has run.
    monkeypatch.setattr(tf, "_db_path", lambda: None)
    monkeypatch.setattr(tf, "TRACKED", [("1", "One"), ("2", "Two"), ("3", "Three")])
    monkeypatch.setattr(tf, "_cached_book", lambda cik: (
        {"available": True, "manager": "One", "period": "2026-06-30",
         "rows": [{"ticker": "AAPL", "value": 5.0, "shares": 1, "status": "held"}], "exited": []}
        if cik == "1" else None))
    out = tf.holders("AAPL")
    assert out["scanned"] == 1
    assert out["trackedTotal"] == 3
    # A partial scan must say so, or an absent fund reads as one that does not hold it.
    assert out["warming"] is True
    assert out["holders"][0]["manager"] == "One"


# ── The bulk dataset ─────────────────────────────────────────────────────────

def _mini_db(path):
    """A dataset with the one shape that broke the reverse index: a manager who
    filed an original and two amendments for the same quarter, one of them a
    partial restatement covering a fraction of the book."""
    import sqlite3
    c = sqlite3.connect(path)
    c.executescript("""
      CREATE TABLE filers (id INTEGER PRIMARY KEY, accession TEXT, cik TEXT, name TEXT,
        period TEXT, amended INT, filed TEXT, total REAL, positions INT, truncated INT,
        canonical INT DEFAULT 0);
      CREATE TABLE securities (cusip TEXT PRIMARY KEY, issuer TEXT, class TEXT, ticker TEXT);
      CREATE TABLE positions (filer_id INT, cusip TEXT, value REAL, shares REAL,
        calls REAL DEFAULT 0, puts REAL DEFAULT 0);
    """)
    c.executemany("INSERT INTO filers VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        (1, 'a-1', '99', 'Vanguard Test', '2026-03-31', 0, '2026-05-08', 1000.0, 2, 0, 0),
        (2, 'a-2', '99', 'Vanguard Test', '2026-03-31', 1, '2026-05-15', 1200.0, 2, 0, 0),
        (3, 'a-3', '99', 'Vanguard Test', '2026-03-31', 1, '2026-05-15',   50.0, 1, 0, 0),
        (4, 'a-0', '99', 'Vanguard Test', '2025-12-31', 0, '2026-02-10',  900.0, 2, 0, 0),
    ])
    c.execute("INSERT INTO securities VALUES ('037833100','APPLE INC','COM','AAPL')")
    c.executemany("INSERT INTO positions (filer_id, cusip, value, shares) VALUES (?,?,?,?)", [
        (1, '037833100', 1000.0, 100), (2, '037833100', 1200.0, 120),
        (3, '037833100',   50.0,   5), (4, '037833100',  900.0,  90),
    ])
    # The canonical pass, exactly as the ETL runs it.
    c.execute("UPDATE filers SET canonical = 1 WHERE id IN (SELECT id FROM"
              " (SELECT id, ROW_NUMBER() OVER (PARTITION BY cik, period"
              "  ORDER BY total DESC, filed DESC) rn FROM filers) WHERE rn = 1)")
    c.commit()
    c.close()


@pytest.fixture
def bulk(tmp_path, monkeypatch):
    path = tmp_path / "t.db"
    _mini_db(path)
    monkeypatch.setattr(tf, "_db_path", lambda: path)
    return path


def test_one_filing_per_manager_per_quarter(bulk):
    # Three filings for one quarter must be one row, or a fund appears several
    # times in the holder list at several different sizes.
    out = tf.db_holders("AAPL")
    assert out["holderCount"] == 1
    assert len(out["holders"]) == 1


def test_the_canonical_filing_is_the_complete_one(bulk):
    # The largest book, not the newest filing: the last amendment here restates
    # $50 of a $1,200 book.
    h = tf.db_holders("AAPL")["holders"][0]
    assert h["value"] == 1200.0
    assert h["shares"] == 120


def test_the_diff_measures_against_the_previous_quarter(bulk):
    h = tf.db_holders("AAPL")["holders"][0]
    assert h["sharesChange"] == pytest.approx(30)     # 120 against 90
    assert h["pctChange"] == pytest.approx(100 / 3)
    assert h["status"] == "added"


def test_an_unmapped_ticker_says_so_rather_than_reporting_no_holders(bulk):
    out = tf.db_holders("ZZZZ")
    assert out["holders"] == []
    # "nobody holds it" and "we cannot identify it" are different answers.
    assert out["unmapped"] is True
