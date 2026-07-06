"""Tests for the housing-market engine (housing_market).

Locks the affordability math (amortization, qualifying income, HAI), the
supply/demand derivations, MoM/YoY trend, the mock cycle (rising rates cooling
volume), and the report anomaly flags. Network-free.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import housing_market as hm  # noqa: E402


def _snap(price=400000, income=80000, sales=100.0, listings=500.0, dom=30.0, ppsf=200.0):
    return hm.HousingMarketSnapshot(
        region=hm.Region.NATIONAL, asof=date(2026, 1, 31),
        median_price=price, price_per_sqft=ppsf, median_income=income,
        sales_volume=sales, pending_sales=sales, days_on_market=dom, active_listings=listings,
    )


def test_monthly_payment_matches_amortization_formula():
    # $300k at 6% for 30y ≈ $1,798.65/mo
    pi = hm.monthly_payment(300000, 6.0, 360)
    assert abs(pi - 1798.65) < 0.5
    # zero-rate path is straight division
    assert hm.monthly_payment(360000, 0.0, 360) == 1000.0


def test_qualifying_income_and_hai():
    # 20% down on $400k -> $320k loan; at 6% P&I ≈ $1,918.56/mo.
    qi = hm.qualifying_income(400000, 6.0)
    pi = hm.monthly_payment(320000, 6.0)
    assert abs(qi - pi / 0.25 * 12) < 1e-6
    # A household earning exactly the qualifying income has HAI = 100.
    snap = _snap(price=400000, income=qi)
    assert abs(hm.affordability_index(snap, 6.0) - 100.0) < 1e-6
    # Double the income -> HAI 200; higher rate -> lower HAI.
    assert abs(hm.affordability_index(_snap(price=400000, income=qi * 2), 6.0) - 200.0) < 1e-6
    assert hm.affordability_index(snap, 8.0) < 100.0


def test_supply_and_sell_through():
    s = _snap(sales=100, listings=500)
    assert s.months_of_supply == 5.0             # 500 / 100
    assert s.sell_through == 0.2                  # 100 / 500
    assert s.price_to_income == _snap().median_price / _snap().median_income
    assert hm.supply_demand_spread(s)["market"] == "balanced"                              # 5 months
    assert hm.supply_demand_spread(_snap(sales=200, listings=500))["market"] == "seller"   # 2.5 months
    assert hm.supply_demand_spread(_snap(sales=50, listings=500))["market"] == "buyer"      # 10 months


def test_trend_mom_yoy():
    series = [100.0 * (1.01 ** i) for i in range(13)]   # +1%/mo for 13 months
    t = hm.trend(series)
    assert abs(t["mom"] - 1.0) < 1e-6
    assert abs(t["yoy"] - round((1.01 ** 12 - 1) * 100, 2)) < 1e-9   # engine rounds to 2dp
    assert hm.trend([100.0])["mom"] is None          # not enough history
    assert hm.trend([])["yoy"] is None


def test_mock_shape_and_rising_rate_cycle():
    regions, rates = hm.generate_mock(months=36, seed=11)
    # National + 4 census regions, each 36 months.
    assert [hs.region for hs in regions][0] == hm.Region.NATIONAL
    assert len(regions) == 5
    assert all(len(hs.snapshots) == 36 for hs in regions)
    assert len(rates) == 36
    # Rates rise over the window.
    assert rates[-1].rate_30y > rates[0].rate_30y + 2.5
    # Determinism.
    r2, _ = hm.generate_mock(months=36, seed=11)
    assert r2[0].latest.median_price == regions[0].latest.median_price
    # Rising rates cool turnover: national sales lower at the end than the start.
    nat = regions[0].snapshots
    assert nat[-1].sales_volume < nat[0].sales_volume


def test_market_report_structure_and_flags():
    regions, rates = hm.generate_mock(months=36, seed=11)
    rep = hm.market_report(regions, hm.rate_map(rates))
    assert rep["asof"] is not None
    assert len(rep["by_region"]) == 5
    assert rep["rates"]["rate_30y"] > 0
    # Every flag is a real anomaly (tight supply, unaffordable, or DoM spike).
    for f in rep["flags"]:
        assert f["kind"] in {"tight_supply", "unaffordable", "dom_spike"}
    # National block carries trends + history.
    nat = next(b for b in rep["by_region"] if b["region"] == "national")
    assert "trends" in nat and len(nat["history"]) == 36
