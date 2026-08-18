"""Monte Carlo that does not promise the past will repeat.

A portfolio analysis projected a 5th percentile of +260% over three years, a
median of +1253% and a 95th of +5014%. Nothing was broken in the arithmetic:
the book had run at about 150% a year and the simulation extrapolated that
faithfully for 756 days.

Two things were wrong with doing so. A sample mean return is a very poor
estimate of an expected one, and diversification was assumed to hold on exactly
the days it does not.
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402

from routers.portfolio import (  # noqa: E402
    _apply_correlation_breakdown, _breakdown_factor, _simulation_drift,
)

_DAY = 1 / 252


def _daily_log(annual: float) -> float:
    return math.log1p(annual) / 252


class TestDriftIsNotExtrapolated:
    """The standard error of a mean return is sigma/sqrt(n). Over three years of
    a 30%-vol book that is about 17 points a year, wider than any plausible
    expected return, so the sample mean cannot be taken at face value."""

    def test_a_spectacular_run_is_not_projected_forward(self):
        # The book from the screenshot: about 150% a year.
        used, meta = _simulation_drift(_daily_log(1.50), 0.32 * math.sqrt(_DAY),
                                       756, "shrunk", 0.25)
        assert meta["sample_annual_pct"] == pytest.approx(150.0, abs=1.0)
        assert meta["used_annual_pct"] <= 25.0
        assert meta["capped"] is True

    def test_the_cap_binds_even_when_the_user_asks_for_history(self):
        # "historical" keeps the estimator, not a licence for any number.
        _, meta = _simulation_drift(_daily_log(3.00), 0.4 * math.sqrt(_DAY),
                                    500, "historical", 0.25)
        assert meta["used_annual_pct"] <= 25.0

    def test_a_short_sample_leans_on_the_prior(self):
        # One year of data barely constrains an expected return.
        _, short = _simulation_drift(_daily_log(0.80), 0.3 * math.sqrt(_DAY), 252, "shrunk", 1.0)
        _, long = _simulation_drift(_daily_log(0.80), 0.3 * math.sqrt(_DAY), 252 * 20, "shrunk", 1.0)
        assert short["used_annual_pct"] < long["used_annual_pct"]

    def test_a_modest_history_survives_roughly_intact(self):
        # Shrinkage must not punish a believable number into nothing.
        _, meta = _simulation_drift(_daily_log(0.08), 0.15 * math.sqrt(_DAY),
                                    252 * 10, "shrunk", 0.25)
        assert 6.0 < meta["used_annual_pct"] < 10.0

    def test_risk_free_mode_ignores_the_sample_entirely(self):
        _, meta = _simulation_drift(_daily_log(1.50), 0.3 * math.sqrt(_DAY),
                                    756, "risk_free", 0.25)
        assert meta["used_annual_pct"] < 10.0

    def test_the_reported_drift_is_the_one_simulated(self):
        used, meta = _simulation_drift(_daily_log(0.30), 0.2 * math.sqrt(_DAY),
                                       756, "shrunk", 0.25)
        assert math.expm1(used * 252) * 100 == pytest.approx(meta["used_annual_pct"], abs=0.01)


class TestCorrelationBreakdown:
    """Correlations converge in a sell-off, so the diversification a book relies
    on is missing exactly when it is needed."""

    def _book(self, seed=3, n=800, common=0.63):
        rng = np.random.default_rng(seed)
        driver = rng.normal(0, 0.014, n)
        return pd.DataFrame({f"A{i}": driver * common + rng.normal(0, 0.017, n)
                             for i in range(4)}), np.array([0.25] * 4)

    def test_a_diversified_book_has_something_to_lose(self):
        price_ret, w = self._book()
        assert _breakdown_factor(price_ret, w) > 1.2

    def test_a_book_that_is_already_one_bet_has_nothing_to_lose(self):
        # Four names moving as one are not diversified, so nothing breaks down.
        rng = np.random.default_rng(5)
        driver = rng.normal(0, 0.015, 800)
        price_ret = pd.DataFrame({f"A{i}": driver for i in range(4)})
        assert _breakdown_factor(price_ret, np.array([0.25] * 4)) == pytest.approx(1.0, abs=0.02)

    def test_the_down_tail_deepens(self):
        rng = np.random.default_rng(11)
        mu, sigma = 0.0003, 0.012
        shocks = mu + sigma * rng.standard_normal(200_000)
        out = _apply_correlation_breakdown(shocks, mu, sigma, 1.55, 1.5)
        assert np.percentile(out, 1) < np.percentile(shocks, 1) * 1.4

    def test_the_upside_is_not_widened(self):
        """Correlations converging is a sell-off phenomenon, not a symmetric
        one, so only the left tail stretches. The whole distribution then shifts
        by a constant when the drift is put back, which moves the upside without
        widening it: the spread across the right tail is what must be unchanged.
        """
        rng = np.random.default_rng(12)
        mu, sigma = 0.0003, 0.012
        shocks = mu + sigma * rng.standard_normal(200_000)
        out = _apply_correlation_breakdown(shocks, mu, sigma, 1.55, 1.5)
        right_before = np.percentile(shocks, 99) - np.percentile(shocks, 90)
        right_after = np.percentile(out, 99) - np.percentile(out, 90)
        assert right_after == pytest.approx(right_before, rel=0.01)
        left_before = np.percentile(shocks, 10) - np.percentile(shocks, 1)
        left_after = np.percentile(out, 10) - np.percentile(out, 1)
        assert left_after > left_before * 1.2

    def test_the_drift_survives_the_reshaping(self):
        # Drift is a parameter and correlation behaviour is a shape. Scaling one
        # tail dragged the mean by about 21 points a year, which silently
        # overrode the drift the caller chose.
        rng = np.random.default_rng(14)
        mu, sigma = 0.0003, 0.012
        shocks = mu + sigma * rng.standard_normal(200_000)
        out = _apply_correlation_breakdown(shocks, mu, sigma, 1.55, 1.5)
        assert out.mean() == pytest.approx(shocks.mean(), abs=1e-9)

    def test_no_diversification_to_lose_means_no_change(self):
        rng = np.random.default_rng(13)
        shocks = 0.0003 + 0.012 * rng.standard_normal(10_000)
        assert np.array_equal(_apply_correlation_breakdown(shocks, 0.0003, 0.012, 1.0, 1.5), shocks)


class TestTerminalDistributionIsBelievable:
    def _simulate(self, mu_daily, sigma_daily, factor=1.0, days=756, sims=4000, seed=21):
        rng = np.random.default_rng(seed)
        shocks = mu_daily + sigma_daily * rng.standard_normal((days, sims))
        shocks = _apply_correlation_breakdown(shocks, mu_daily, sigma_daily, factor, 1.5)
        return np.exp(np.cumsum(shocks, axis=0))[-1]

    def test_the_downside_can_actually_lose_money(self):
        """The reported 5th percentile was +260%: the model had no losing
        outcome at all over three years, which is not a risk model."""
        used, _ = _simulation_drift(_daily_log(1.50), 0.32 * math.sqrt(_DAY), 756, "shrunk", 0.25)
        final = self._simulate(used, 0.32 * math.sqrt(_DAY), factor=1.55)
        p5 = float(np.percentile(final, 5))
        assert p5 < 1.0, f"5th percentile finished at {(p5 - 1) * 100:+.0f}%, still a gain"

    def test_the_median_is_not_a_lottery_win(self):
        used, _ = _simulation_drift(_daily_log(1.50), 0.32 * math.sqrt(_DAY), 756, "shrunk", 0.25)
        median = float(np.median(self._simulate(used, 0.32 * math.sqrt(_DAY), factor=1.55)))
        assert median < 3.0, f"median finished at {(median - 1) * 100:+.0f}% over three years"

    def test_breakdown_widens_the_loss_without_moving_the_median_much(self):
        used, _ = _simulation_drift(_daily_log(0.10), 0.20 * math.sqrt(_DAY), 2520, "shrunk", 0.25)
        calm = self._simulate(used, 0.20 * math.sqrt(_DAY), factor=1.0)
        stressed = self._simulate(used, 0.20 * math.sqrt(_DAY), factor=1.6)
        assert np.percentile(stressed, 5) < np.percentile(calm, 5)
        # And the median is left where the drift put it, within noise.
        assert np.median(stressed) == pytest.approx(np.median(calm), rel=0.08)
