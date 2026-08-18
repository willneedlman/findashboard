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

    def test_options_are_priced_now_rather_than_declared_uncovered(self, monkeypatch):
        start = date(2026, 1, 1)
        monkeypatch.setattr(A, "_price_frame",
                            lambda syms, s, e: _flat_prices(syms, start, 200, rate=0.001))
        txns = [Txn(date=start, kind="deposit", amount=10_000.0),
                Txn(date=start, kind="buy", symbol="SPY", quantity=100.0, amount=-10_000.0),
                Txn(date=start + timedelta(days=5), kind="sell", symbol="NVDA260807C200",
                    quantity=1, price=8.93, amount=892.32, is_option=True)]
        out = A.analyze(txns)
        # Changed deliberately: contracts are marked with Black-Scholes against
        # the underlying, at the volatility solved out of their own fill, so the
        # old "realised cash only" caveat is no longer true.
        assert not any("realised cash only" in c for c in out["caveats"])
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


class TestMarketRegression:
    """The regression intercept carries a standard error, so unlike a ratio it
    can be tested against zero."""

    def _series(self, n=500, beta=1.2, alpha_daily=0.0002, noise=0.0005, seed=7):
        # Enough days and little enough idiosyncratic noise that the injected
        # alpha is resolvable. At n=250 with 0.002 daily noise the standard
        # error is about a third of the signal, and the estimate legitimately
        # lands nowhere near the input — which is the whole reason the t-stat
        # is reported beside the number.
        rng = np.random.default_rng(seed)
        idx = pd.date_range("2026-01-01", periods=n, freq="B")
        bench = pd.Series(rng.normal(0.0004, 0.01, n), index=idx)
        port = alpha_daily + beta * bench + pd.Series(rng.normal(0, noise, n), index=idx)
        return port, bench

    def test_it_recovers_the_beta_it_was_given(self):
        port, bench = self._series(beta=1.2)
        out = A.market_regression(port, bench, rf=0.0)
        assert out["sufficient"] is True
        assert out["beta"] == pytest.approx(1.2, abs=0.05)

    def test_it_recovers_the_alpha_it_was_given(self):
        port, bench = self._series(alpha_daily=0.0002)
        out = A.market_regression(port, bench, rf=0.0)
        # 0.0002 a day over 252 days is about 5%.
        assert out["alphaRegressionPct"] == pytest.approx(5.0, abs=1.5)

    def test_real_alpha_is_reported_as_significant(self):
        port, bench = self._series(alpha_daily=0.0006)
        out = A.market_regression(port, bench, rf=0.0)
        assert out["significant"] is True and out["pValue"] < 0.05

    def test_no_alpha_is_not_dressed_up_as_alpha(self):
        # Noise restored to a realistic level: with none, any tiny drift reads
        # as significant, which is not the case being tested.
        port, bench = self._series(alpha_daily=0.0, noise=0.002)
        out = A.market_regression(port, bench, rf=0.0)
        assert out["significant"] is False, "noise must not read as skill"

    def test_a_short_sample_refuses_to_fit(self):
        port, bench = self._series(n=15)
        out = A.market_regression(port, bench, rf=0.0)
        assert out["sufficient"] is False

    def test_it_ships_the_points_and_the_line_the_numbers_came_from(self):
        port, bench = self._series()
        out = A.market_regression(port, bench, rf=0.0)
        assert len(out["points"]) == out["observations"]
        assert len(out["line"]) == 2
        # The drawn line must be the fit, not a redrawn approximation.
        (x0, y0), (x1, y1) = [(p["x"], p["y"]) for p in out["line"]]
        assert (y1 - y0) / (x1 - x0) == pytest.approx(out["beta"], abs=0.01)


class TestOptionMarking:
    def test_an_occ_symbol_is_decomposed(self):
        spec = A.parse_option_symbol("NVDA260807C200")
        assert spec["underlying"] == "NVDA" and spec["right"] == "call"
        assert spec["strike"] == 200.0 and spec["expiry"] == date(2026, 8, 7)

    def test_a_plain_ticker_is_not_an_option(self):
        assert A.parse_option_symbol("NVDA") is None

    def test_the_fill_price_gives_back_its_own_volatility(self):
        from math_engine import bs_price
        truth = 0.55
        price = float(bs_price(205.0, 200.0, 30.0, 4.0, truth * 100, "call"))
        solved = A.implied_vol(price, 205.0, 200.0, 30 / 365, 0.04, "call")
        assert solved == pytest.approx(truth, abs=0.01)

    def test_a_price_at_or_below_intrinsic_has_no_volatility_to_solve(self):
        # Deep in the money with no time value left: nothing to back out.
        assert A.implied_vol(5.0, 205.0, 200.0, 30 / 365, 0.04, "call") is None

    def test_an_option_position_is_marked_into_the_curve(self, monkeypatch):
        start = date(2026, 1, 1)
        monkeypatch.setattr(A, "_price_frame",
                            lambda syms, s, e: _flat_prices(syms, start, 60))
        txns = [
            Txn(date=start, kind="deposit", amount=10_000.0),
            Txn(date=start, kind="buy", symbol="SPY260201C100", quantity=1,
                price=5.0, amount=-500.0, is_option=True),
        ]
        built = A.build_curve(txns)
        # Cash fell by the premium; the contract carries value in its place,
        # rather than the premium simply vanishing from the account.
        assert float(built["cash"].iloc[-1]) == pytest.approx(9_500.0, abs=1.0)
        assert float(built["option_value"].max()) > 0


class TestDirectAlpha:
    """Money-weighted alpha: every contribution carried forward at the
    benchmark's own return, then the IRR of that scaled series. It asks what
    those exact dollars would have become in the index on those exact dates,
    with no CAPM and no beta."""

    def _bench(self, days=400, daily=0.0004):
        idx = pd.date_range("2026-01-01", periods=days, freq="D")
        return pd.Series(100.0 * (1 + daily) ** np.arange(days), index=idx)

    def _flows(self, bench, points):
        f = pd.Series(0.0, index=bench.index)
        for offset, amount in points:
            f.iloc[offset] += amount
        return f

    def test_matching_the_benchmark_earns_no_alpha(self):
        bench = self._bench()
        flows = self._flows(bench, [(0, 10_000.0)])
        # Ending exactly where the index would have taken it.
        ending = 10_000.0 * float(bench.iloc[-1] / bench.iloc[0])
        out = A.direct_alpha(flows, ending, bench)
        assert out["available"] is True
        assert out["alphaPct"] == pytest.approx(0.0, abs=0.2)

    def test_beating_the_benchmark_shows_positive_alpha(self):
        bench = self._bench()
        flows = self._flows(bench, [(0, 10_000.0)])
        ending = 10_000.0 * float(bench.iloc[-1] / bench.iloc[0]) * 1.10
        out = A.direct_alpha(flows, ending, bench)
        assert out["alphaPct"] > 0
        assert out["dollarsVsBenchmark"] == pytest.approx(
            ending - out["benchmarkValue"], abs=1.0)

    def test_trailing_the_benchmark_shows_negative_alpha(self):
        bench = self._bench()
        flows = self._flows(bench, [(0, 10_000.0)])
        ending = 10_000.0 * float(bench.iloc[-1] / bench.iloc[0]) * 0.90
        assert A.direct_alpha(flows, ending, bench)["alphaPct"] < 0

    def test_a_late_contribution_is_scaled_from_its_own_date(self):
        """The whole point of money-weighting: a dollar added near the end had
        less time in the index, so it is not held to the full-period return."""
        bench = self._bench()
        early = A.direct_alpha(self._flows(bench, [(0, 10_000.0)]), 12_000.0, bench)
        late = A.direct_alpha(self._flows(bench, [(350, 10_000.0)]), 12_000.0, bench)
        assert late["benchmarkValue"] < early["benchmarkValue"]

    def test_no_flows_means_nothing_to_measure(self):
        bench = self._bench()
        assert A.direct_alpha(pd.Series(0.0, index=bench.index), 1000.0, bench)["available"] is False

    def test_an_empty_account_is_not_measured(self):
        bench = self._bench()
        assert A.direct_alpha(self._flows(bench, [(0, 100.0)]), 0.0, bench)["available"] is False


class TestIrr:
    def test_it_finds_a_known_rate(self):
        # -1000 now, +1100 in a year is 10%.
        assert A._irr([(0.0, -1000.0), (1.0, 1100.0)]) == pytest.approx(0.10, abs=1e-4)

    def test_flows_of_one_sign_have_no_rate(self):
        assert A._irr([(0.0, -100.0), (1.0, -100.0)]) is None
