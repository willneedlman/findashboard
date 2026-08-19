import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import portfolio as pf  # noqa: E402


def _frame(aapl: list[float], spy: list[float], div: float = 0.0) -> pd.DataFrame:
    index = pd.bdate_range("2025-01-02", periods=len(aapl))
    columns = pd.MultiIndex.from_product([["Close", "Dividends"], ["AAPL", "SPY"]])
    frame = pd.DataFrame(0.0, index=index, columns=columns)
    frame[("Close", "AAPL")] = aapl
    frame[("Close", "SPY")] = spy
    if div:
        frame.loc[index[-1], ("Dividends", "AAPL")] = div
    return frame


@pytest.fixture(autouse=True)
def _patch(monkeypatch):
    monkeypatch.setattr(pf, "_get_risk_free_rate", lambda: 0.0)


def _run(monkeypatch, frame, **kw) -> dict:
    monkeypatch.setattr(pf, "get_download", lambda *a, **k: frame)
    return pf.backtest(pf.BacktestRequest(
        tickers=["AAPL"], weights=[100.0], benchmark="SPY",
        start="2025-01-02", end="2025-01-10", dividend_mode="reinvest", **kw,
    ))


def _total_return(result: dict) -> float:
    """The cumulative series is indexed to 100, so the last point is the return."""
    return round(result["cumulative"][-1]["portfolio"] - 100.0, 6)


def test_long_leg_tracks_the_asset(monkeypatch):
    out = _run(monkeypatch, _frame([100.0, 110.0], [100.0, 100.0]))
    assert _total_return(out) == pytest.approx(10.0, abs=1e-6)


def test_omitting_sides_is_identical_to_all_long(monkeypatch):
    """The default path must not move: every existing caller omits `sides`."""
    frame = _frame([100.0, 104.0, 99.0, 107.0], [100.0] * 4)
    bare = _run(monkeypatch, frame)
    explicit = _run(monkeypatch, frame, sides=["long"])
    assert _total_return(bare) == _total_return(explicit)


def test_short_leg_inverts_the_move(monkeypatch):
    """Short 100% of a name that rises 10% loses 10%."""
    out = _run(monkeypatch, _frame([100.0, 110.0], [100.0, 100.0]), sides=["short"])
    assert _total_return(out) == pytest.approx(-10.0, abs=1e-6)


def test_short_leg_profits_when_the_asset_falls(monkeypatch):
    out = _run(monkeypatch, _frame([100.0, 90.0], [100.0, 100.0]), sides=["short"])
    assert _total_return(out) == pytest.approx(10.0, abs=1e-6)


def test_short_pays_the_dividend_rather_than_receiving_it(monkeypatch):
    """A dividend is a liability on a short, so it drags the flat-price book."""
    flat = _frame([100.0, 100.0], [100.0, 100.0], div=2.0)
    assert _total_return(_run(monkeypatch, flat, sides=["short"])) < 0
    assert _total_return(_run(monkeypatch, flat, sides=["long"])) > 0


def test_borrow_cost_only_bites_the_short_book(monkeypatch):
    flat = _frame([100.0] * 30, [100.0] * 30)
    charged = _total_return(_run(monkeypatch, flat, sides=["short"], short_borrow_rate=12.0))
    free = _total_return(_run(monkeypatch, flat, sides=["short"]))
    assert charged < free
    # A long book never pays borrow, so the same rate leaves it untouched.
    assert _total_return(_run(monkeypatch, flat, sides=["long"], short_borrow_rate=12.0)) == \
           _total_return(_run(monkeypatch, flat, sides=["long"]))


def test_book_starts_at_nav_one(monkeypatch):
    """Long 60 / short 40 is still one unit of capital, not 0.2 or 1.4."""
    frame = _frame([100.0, 100.0], [100.0, 100.0])
    monkeypatch.setattr(pf, "get_download", lambda *a, **k: frame)
    out = pf.backtest(pf.BacktestRequest(
        tickers=["AAPL", "SPY"], weights=[60.0, 40.0], sides=["long", "short"],
        benchmark="SPY", start="2025-01-02", end="2025-01-10",
    ))
    assert _total_return(out) == pytest.approx(0.0, abs=1e-6)
