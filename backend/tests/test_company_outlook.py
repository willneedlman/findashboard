"""Consensus grids and valuation multiples.

hub/estimates answers whether consensus is drifting up or down. This answers
what the number is: average, low, high, analyst count, the year-ago actual and
implied growth, for this quarter, next quarter, this year and next.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import company_outlook as co  # noqa: E402


class TestNumericSafety:
    """A NaN reaching JSON serialises to a bare NaN token, which json.loads
    rejects on the client. It must never leave here."""

    def test_nan_and_infinity_become_null(self):
        assert co._num(float("nan")) is None
        assert co._num(float("inf")) is None
        assert co._num(float("-inf")) is None
        assert co._num(None) is None

    def test_a_real_number_survives(self):
        assert co._num(8.81249) == 8.81249
        assert co._num(0) == 0.0
        assert co._num(-1.5) == -1.5

    def test_junk_is_null_rather_than_an_exception(self):
        assert co._num("n/a") is None
        assert co._num([]) is None


class TestTheEstimateGrid:
    def _frame(self):
        # Keyed by period so a value can never drift away from its label, then
        # handed back deliberately out of order, which is what the provider does.
        by_period = {
            "0q":  {"avg": 1.97, "low": 1.93, "high": 2.07, "yearAgoEps": 1.85,
                    "numberOfAnalysts": 28, "growth": 0.068},
            "+1q": {"avg": 2.90, "low": 2.51, "high": 3.42, "yearAgoEps": 2.84,
                    "numberOfAnalysts": 22, "growth": 0.024},
            "0y":  {"avg": 8.81, "low": 8.28, "high": 8.94, "yearAgoEps": 7.46,
                    "numberOfAnalysts": 37, "growth": 0.181},
            "+1y": {"avg": 9.53, "low": 8.24, "high": 10.67, "yearAgoEps": 8.81,
                    "numberOfAnalysts": 39, "growth": 0.081},
        }
        df = pd.DataFrame.from_dict(by_period, orient="index")
        return df.reindex(["+1y", "0q", "0y", "+1q"])

    def _cols(self):
        return {"avg": "avg", "low": "low", "high": "high",
                "yearAgoEps": "yearAgo", "numberOfAnalysts": "analysts", "growth": "growth"}

    def test_periods_come_back_in_reading_order(self):
        # This quarter, next quarter, this year, next year. Provider order is
        # not guaranteed and a grid in the wrong order is quietly misread.
        rows = co._grid(self._frame(), self._cols())
        assert [r["period"] for r in rows] == ["0q", "+1q", "0y", "+1y"]

    def test_each_period_is_labelled_for_a_reader(self):
        rows = co._grid(self._frame(), self._cols())
        assert [r["label"] for r in rows] == [
            "Current qtr", "Next qtr", "Current year", "Next year"]

    def test_the_measures_are_carried_across(self):
        first = co._grid(self._frame(), self._cols())[0]
        assert first["avg"] == 1.97 and first["low"] == 1.93 and first["high"] == 2.07
        assert first["yearAgo"] == 1.85 and first["growth"] == 0.068

    def test_an_analyst_count_is_a_count_not_a_measurement(self):
        first = co._grid(self._frame(), self._cols())[0]
        assert first["analysts"] == 28
        assert isinstance(first["analysts"], int)

    def test_a_period_the_provider_omits_is_skipped(self):
        partial = self._frame().drop(index=["+1y", "+1q"])
        assert [r["period"] for r in co._grid(partial, self._cols())] == ["0q", "0y"]

    def test_no_frame_is_no_rows_rather_than_an_error(self):
        assert co._grid(None, self._cols()) == []
        assert co._grid(pd.DataFrame(), self._cols()) == []


class TestValuationRows:
    def test_yahoos_row_order_is_preserved(self):
        keys = [k for k, _l, _u in co._VALUATION]
        assert keys[:4] == ["marketCap", "enterpriseValue", "trailingPE", "forwardPE"]

    def test_money_and_multiples_are_tagged_apart(self):
        units = {k: u for k, _l, u in co._VALUATION}
        assert units["marketCap"] == "$"
        assert units["enterpriseValue"] == "$"
        assert units["trailingPE"] == "x"
        assert units["enterpriseToEbitda"] == "x"

    def test_a_blank_ticker_is_refused_without_a_network_call(self):
        assert co.get_valuation("")["available"] is False
        assert co.get_estimates("  ")["reason"] == "no_ticker"
