import csv
import os
import sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import corporate_db
from bond_prices import price_for_cusip, search_issuers
from logistics.ingest_trace_btds import main as ingest_main


@pytest.fixture(autouse=True)
def setup_mock_wrds_trace(tmp_path, monkeypatch):
    # Isolate every path this test touches under pytest's tmp_path — never the
    # real data/corporate.db or data/wrds_trace.csv, which are live ETL output
    # on developer machines and must not be overwritten/dropped by test runs.
    mock_csv_path = tmp_path / "wrds_trace.csv"
    mock_db_path = str(tmp_path / "corporate.db")
    monkeypatch.setattr(corporate_db, "DB_PATH", mock_db_path)

    mock_data = [
        ["cusip", "prc", "trade_date", "issuer_name"],
        ["123456789", "98.5", "2026-07-10", "GOLDMAN SACHS GROUP INC"],
        ["987654321", "102.3", "2026-07-11", "MICROSOFT CORP"],
        ["123456789", "99.1", "2026-07-12", "GOLDMAN SACHS GROUP INC"], # Duplicate, newer date
    ]

    with open(mock_csv_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerows(mock_data)

    ingest_main(csv_path=str(mock_csv_path), db_path=mock_db_path)

    yield


def test_wrds_trace_pricing():
    # Test that CUSIP from wrds_trace returns correct WRDS TRACE price and source
    res = price_for_cusip("123456789")
    assert res is not None
    assert res["market_price"] == 99.1
    assert res["price_source"] == "WRDS TRACE (last trade, 2026-07-12)"
    assert res["price_as_of"] == "2026-07-12"
    assert res["name"] == "GOLDMAN SACHS GROUP INC"

    res_msft = price_for_cusip("987654321")
    assert res_msft is not None
    assert res_msft["market_price"] == 102.3
    assert res_msft["price_source"] == "WRDS TRACE (last trade, 2026-07-11)"


def test_wrds_trace_fallback():
    # Test that CUSIP not in wrds_trace returns None or ETF/N-PORT fallback
    res = price_for_cusip("000000000")
    assert res is None or "price_source" in res


def test_search_issuers_with_wrds():
    # Test that search_issuers returns WRDS TRACE bonds in results
    res = search_issuers("goldman")
    assert len(res) > 0
    goldman_group = [g for g in res if "GOLDMAN" in g["name"]]
    assert len(goldman_group) > 0
    bonds = goldman_group[0]["bonds"]
    assert any(b["cusip"] == "123456789" for b in bonds)
