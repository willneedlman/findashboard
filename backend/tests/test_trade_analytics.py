"""Measuring a reconstructed account, and the ways that goes wrong.

Network-free: prices are injected, so these test the arithmetic rather than a
data provider.
"""
import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402

import trade_analytics as A  # noqa: E402
from brokerage_import import Txn  # noqa: E402


def _flat_prices(symbols, start, days, rate=0.0):
    idx = pd.date_range(pd.Timestamp(start), periods=days, freq="D")
    frame = pd.DataFrame(index=idx)
    for s in symbols:
        frame[s] = 100.0 * (1 + rate) ** np.arange(days)
    return frame


class TestFundingFloor:
    """A ledger opens with dust: fractions of a cent of stock-lending income
    days before the first deposit. Dividing by $0.0055 turned a $239 gain into
    a reported 261,622% return."""

    def test_dust_days_do_not_become_the_denominator(self):
        idx = pd.date_range("2026-01-01", periods=10, freq="D")
        equity = pd.Series([0.0008, 0.0118, 0.0055, 1060.5, 1062.0, 1065.0,
                            1070.0, 1068.0, 1075.0, 1080.0], index=idx)
        flows = pd.Series([0, 0, 0, 1058.82, 0, 0, 0, 0, 0, 0], index=idx, dtype=float)
        ret = A._twr(equity, flows)
        assert ret.abs().max() < 0.10, f"a dust denominator leaked through: {ret.max():.2%}"

    def test_the_floor_scales_with_the_account(self):
        small = pd.Series([1.0, 2.0, 3.0], index=pd.date_range("2026-01-01", periods=3))
        big = pd.Series([1e6, 2e6, 3e6], index=pd.date_range("2026-01-01", periods=3))
        assert A.funding_floor(big) > A.funding_floor(small)

    def test_an_empty_account_has_no_floor_and_no_returns(self):
        empty = pd.Series([0.0, 0.0], index=pd.date_range("2026-01-01", periods=2))
        assert A.funding_floor(empty) == 0.0
        assert A._twr(empty, empty * 0).empty


class TestExternalFlowsAreNotReturns:
    def test_a_pure_deposit_earns_nothing(self, monkeypatch):
        """Cash in, nothing bought, prices irrelevant: 0%. Counting the deposit
        as a gain is the single easiest way to report a fabulous return."""
        start = date(2026, 1, 1)
        monkeypatch.setattr(A, "_price_frame",
                            lambda syms, s, e: _flat_prices(syms, start, 40))
        txns = [
            Txn(date=start, kind="deposit", amount=10_000.0),
            Txn(date=start + timedelta(days=20), kind="deposit", amount=10_000.0),
        ]
        out = A.analyze(txns, benchmark="SPY")
        assert out["metrics"]["totalReturnPct"] == pytest.approx(0.0, abs=0.05)
        assert out["account"]["netContributions"] == pytest.approx(20_000.0)
        assert out["account"]["netGain"] == pytest.approx(0.0, abs=1.0)

    def test_a_rising_holding_earns_its_gain(self, monkeypatch):
        start = date(2026, 1, 1)
        # 1% a day for 30 days on the whole book.
        monkeypatch.setattr(A, "_price_frame",
                            lambda syms, s, e: _flat_prices(syms, start, 31, rate=0.01))
        txns = [
            Txn(date=start, kind="deposit", amount=10_000.0),
            Txn(date=start, kind="buy", symbol="SPY", quantity=100.0, price=100.0, amount=-10_000.0),
        ]
        out = A.analyze(txns, benchmark="SPY")
        # 1.01**30 - 1 = 34.8%
        assert out["metrics"]["totalReturnPct"] == pytest.approx(34.8, abs=1.5)


class TestSecurityTransfers:
    def test_transferred_shares_are_not_also_cash(self, monkeypatch):
        """An ACAT receive carries a quantity AND a dollar amount, and that
        amount is what the shares were worth. Adding both counts it twice."""
        start = date(2026, 1, 1)
        monkeypatch.setattr(A, "_price_frame",
                            lambda syms, s, e: _flat_prices(syms, start, 20))
        txns = [Txn(date=start, kind="deposit", symbol="SPY",
                    quantity=100.0, amount=10_000.0)]
        built = A.build_curve(txns)
        # 100 shares at 100 = 10,000. Not 20,000.
        assert float(built["equity"].iloc[-1]) == pytest.approx(10_000.0, abs=1.0)
        assert float(built["cash"].iloc[-1]) == pytest.approx(0.0, abs=0.01)

    def test_it_still_counts_as_an_external_contribution(self, monkeypatch):
        start = date(2026, 1, 1)
        monkeypatch.setattr(A, "_price_frame",
                            lambda syms, s, e: _flat_prices(syms, start, 20))
        built = A.build_curve([Txn(date=start, kind="deposit", symbol="SPY",
                                   quantity=100.0, amount=10_000.0)])
        assert float(built["flows"].sum()) == pytest.approx(10_000.0)


class TestCaveatsAreStated:
    def test_a_short_window_says_so(self, monkeypatch):
        start = date(2026, 1, 1)
        monkeypatch.setattr(A, "_price_frame",
                            lambda syms, s, e: _flat_prices(syms, start, 25, rate=0.002))
        txns = [Txn(date=start, kind="deposit", amount=10_000.0),
                Txn(date=start, kind="buy", symbol="SPY", quantity=100.0, amount=-10_000.0)]
        out = A.analyze(txns)
        assert any("not reliable at this length" in c for c in out["caveats"])

    def test_options_are_declared_as_realised_cash_only(self, monkeypatch):
        start = date(2026, 1, 1)
        monkeypatch.setattr(A, "_price_frame",
                            lambda syms, s, e: _flat_prices(syms, start, 200, rate=0.001))
        txns = [Txn(date=start, kind="deposit", amount=10_000.0),
                Txn(date=start, kind="buy", symbol="SPY", quantity=100.0, amount=-10_000.0),
                Txn(date=start + timedelta(days=5), kind="sell", symbol="NVDA260807C200",
                    quantity=1, amount=892.32, is_option=True)]
        out = A.analyze(txns)
        assert any("Option trades are carried at realised cash" in c for c in out["caveats"])
        assert out["account"]["optionRealised"] == pytest.approx(892.32)


class TestRealisedPnl:
    def test_a_round_trip_banks_the_difference(self):
        start = date(2026, 1, 1)
        txns = [
            Txn(date=start, kind="buy", symbol="SPY", quantity=10, amount=-1000.0),
            Txn(date=start + timedelta(days=5), kind="sell", symbol="SPY",
                quantity=10, amount=1200.0),
        ]
        assert A._realised_pnl(txns) == pytest.approx(200.0)

    def test_a_partial_sale_banks_only_its_share(self):
        start = date(2026, 1, 1)
        txns = [
            Txn(date=start, kind="buy", symbol="SPY", quantity=10, amount=-1000.0),
            Txn(date=start + timedelta(days=5), kind="sell", symbol="SPY",
                quantity=5, amount=600.0),
        ]
        assert A._realised_pnl(txns) == pytest.approx(100.0)

    def test_dividends_count_as_realised(self):
        txns = [Txn(date=date(2026, 1, 1), kind="dividend", symbol="BND", amount=0.75)]
        assert A._realised_pnl(txns) == pytest.approx(0.75)
