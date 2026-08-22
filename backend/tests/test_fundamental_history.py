"""Per-period market values on a seventeen-year fundamental series.

The bug this guards: Yahoo's historical closes are already split-adjusted onto
today's basis while SEC reports share counts and EPS as they stood, so
multiplying one by the other put Apple's FY2009 market cap at $5.7B against a
real ~$160B, and every multiple built on it followed.
"""
import os
import sys

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from main import app
import routers.corporate as corp

client = TestClient(app)

# Two years either side of a 4:1 split, with round numbers so the arithmetic is
# checkable by eye: 1000 shares before the split are 4000 on today's basis.
_ROWS = [
    {"fiscalYear": 2019, "date": "2019-09-28", "revenue": 1000.0, "grossProfit": 400.0,
     "operatingIncome": 300.0, "netIncome": 200.0, "epsdiluted": 0.2,
     "weightedAverageShsOutDil": 1000.0, "depreciationAndAmortization": 50.0,
     "totalDebt": 100.0, "cashAndCashEquivalents": 40.0, "totalStockholdersEquity": 500.0,
     "operatingCashFlow": 250.0, "capitalExpenditure": 50.0, "freeCashFlow": 200.0,
     "dividendPerShare": 0.04},
    {"fiscalYear": 2020, "date": "2020-09-26", "revenue": 1200.0, "grossProfit": 500.0,
     "operatingIncome": 360.0, "netIncome": 240.0, "epsdiluted": 0.06,
     "weightedAverageShsOutDil": 4000.0, "depreciationAndAmortization": 60.0,
     "totalDebt": 120.0, "cashAndCashEquivalents": 20.0, "totalStockholdersEquity": 600.0,
     "operatingCashFlow": 300.0, "capitalExpenditure": 60.0, "freeCashFlow": 240.0,
     "dividendPerShare": 0.01},
]


@pytest.fixture
def stub(monkeypatch):
    import sec_fundamentals as sec
    monkeypatch.setattr(sec, "get_fundamental_history", lambda t: _ROWS)
    # Split-adjusted closes: $2.50 then $3.00.
    monkeypatch.setattr(corp, "_period_closes",
                        lambda t, dates: {"2019-09-28": 2.5, "2020-09-26": 3.0,
                                          dates[-1]: 3.0})
    monkeypatch.setattr(corp, "_split_factors",
                        lambda t, dates: {"2019-09-28": 4.0, "2020-09-26": 1.0})
    monkeypatch.setattr("estimates.forward_periods", lambda t: [])
    corp.fundamental_history.cache_clear()
    yield
    corp.fundamental_history.cache_clear()


def _periods(sym="TEST"):
    r = client.get(f"/api/corporate/fundamental-history?ticker={sym}")
    assert r.status_code == 200
    return {p["fiscalYear"]: p for p in r.json()["periods"]}


def test_shares_and_eps_move_onto_todays_split_basis(stub):
    p = _periods()
    # 1000 pre-split shares are 4000 today, so both years sit on one scale.
    assert p[2019]["weightedAverageShsOutDil"] == 4000.0
    assert p[2020]["weightedAverageShsOutDil"] == 4000.0
    assert p[2019]["epsdiluted"] == pytest.approx(0.05)
    assert p[2020]["epsdiluted"] == pytest.approx(0.06)
    assert p[2019]["dividendPerShare"] == pytest.approx(0.01)


def test_market_cap_uses_the_same_basis_as_the_price(stub):
    p = _periods()
    # $2.50 against an as-filed 1000 shares would be $2,500. It is $10,000.
    assert p[2019]["marketCap"] == pytest.approx(10_000.0)
    assert p[2020]["marketCap"] == pytest.approx(12_000.0)
    assert p[2019]["enterpriseValue"] == pytest.approx(10_060.0)


def test_multiples_follow_from_the_corrected_basis(stub):
    p = _periods()
    assert p[2019]["pe"] == pytest.approx(2.5 / 0.05)
    assert p[2020]["pe"] == pytest.approx(3.0 / 0.06)
    assert p[2019]["ps"] == pytest.approx(10.0)
    assert p[2019]["pb"] == pytest.approx(20.0)
    assert p[2019]["evEbitda"] == pytest.approx(10_060.0 / 350.0)
    # Yields carry their percent, so 200/10000 reads as 2%.
    assert p[2019]["fcfYield"] == pytest.approx(2.0)
    assert p[2019]["dividendYield"] == pytest.approx(0.4)


def test_a_negative_denominator_is_a_gap_not_a_cheap_multiple(stub, monkeypatch):
    import sec_fundamentals as sec
    loss = [dict(_ROWS[0], netIncome=-200.0, epsdiluted=-0.2, operatingIncome=-300.0,
                 totalStockholdersEquity=-500.0, freeCashFlow=-200.0)]
    monkeypatch.setattr(sec, "get_fundamental_history", lambda t: loss)
    corp.fundamental_history.cache_clear()
    p = _periods("LOSS")[2019]
    assert p["pe"] is None
    assert p["pb"] is None
    assert p["evFcf"] is None
    # A negative FCF yield is a real reading, not a gap.
    assert p["fcfYield"] < 0
