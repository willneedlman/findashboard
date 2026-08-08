import datetime as dt
import json

import pandas as pd
import pytest

import routers.alerts as alerts


def _obs(values: list[float], start="2025-01-01"):
    base = dt.date.fromisoformat(start)
    return [{"date": (base + dt.timedelta(days=30 * i)).isoformat(), "value": v}
            for i, v in enumerate(values)]


# ── Macro print ──────────────────────────────────────────────────────────────

def test_macro_print_fires_on_the_level_not_the_schedule(monkeypatch):
    """The existing macro alert says a release is coming. This one has to read
    the released figure, which is a different question entirely."""
    monkeypatch.setattr("fred.observations", lambda sid, n: _obs([4.0, 4.2, 4.6]))
    hit, value, label = alerts._macro_print_sync(
        json.dumps({"series": "UNRATE", "label": "Unemployment"}), "macro_print_above", 4.5)
    assert hit is True
    assert value == 4.6
    assert "Unemployment 4.60" in label


def test_macro_print_below_is_not_just_the_negation(monkeypatch):
    monkeypatch.setattr("fred.observations", lambda sid, n: _obs([4.0, 3.2]))
    assert alerts._macro_print_sync(json.dumps({"series": "UNRATE"}), "macro_print_below", 3.5)[0] is True
    assert alerts._macro_print_sync(json.dumps({"series": "UNRATE"}), "macro_print_above", 3.5)[0] is False


def test_yoy_compares_against_twelve_periods_back_not_a_calendar_year(monkeypatch):
    """CPI is an index level. Thresholding it raw is meaningless — "CPI above 3"
    means the year-over-year rate, and the base has to be the print twelve
    periods back because the series may be monthly, weekly or quarterly."""
    # 13 prints, 100 -> 104: a 4% year-over-year rate.
    monkeypatch.setattr("fred.observations", lambda sid, n: _obs([100.0] * 12 + [104.0]))
    hit, value, _ = alerts._macro_print_sync(
        json.dumps({"series": "CPIAUCSL", "transform": "yoy"}), "macro_print_above", 3.0)
    assert hit is True
    assert value == pytest.approx(4.0)


def test_yoy_needs_a_full_year_of_prints(monkeypatch):
    monkeypatch.setattr("fred.observations", lambda sid, n: _obs([100.0, 104.0]))
    assert alerts._macro_print_sync(
        json.dumps({"series": "CPIAUCSL", "transform": "yoy"}), "macro_print_above", 3.0) == (False, None, "")


def test_macro_print_without_a_series_does_not_fire(monkeypatch):
    monkeypatch.setattr("fred.observations", lambda sid, n: _obs([9.0]))
    assert alerts._macro_print_sync(json.dumps({}), "macro_print_above", 1.0)[0] is False
    assert alerts._macro_print_sync(None, "macro_print_above", 1.0)[0] is False


def test_macro_print_survives_a_dead_feed(monkeypatch):
    monkeypatch.setattr("fred.observations", lambda sid, n: [])
    assert alerts._macro_print_sync(json.dumps({"series": "UNRATE"}), "macro_print_above", 1.0)[0] is False


# ── Portfolio drawdown ───────────────────────────────────────────────────────

def _closes(columns: dict[str, list[float]]):
    index = pd.bdate_range(end=dt.date.today(), periods=len(next(iter(columns.values()))))
    return pd.concat({"Close": pd.DataFrame(columns, index=index)}, axis=1)


def test_drawdown_measures_from_the_basket_peak(monkeypatch):
    # One name doubles then halves back: peak in the middle, 50% below it now.
    frame = _closes({"AAA": [100.0, 200.0, 100.0]})
    monkeypatch.setattr("cache.get_download", lambda *a, **k: frame)

    hit, dd, label = alerts._portfolio_drawdown_sync(
        json.dumps({"label": "Book", "total_value": 1000, "holdings": [{"ticker": "AAA", "weight": 100}]}), 20.0)

    assert hit is True
    assert dd == pytest.approx(-50.0)
    assert "Book" in label


def test_drawdown_below_the_threshold_stays_quiet(monkeypatch):
    frame = _closes({"AAA": [100.0, 105.0, 104.0]})
    monkeypatch.setattr("cache.get_download", lambda *a, **k: frame)
    hit, dd, _ = alerts._portfolio_drawdown_sync(
        json.dumps({"total_value": 1000, "holdings": [{"ticker": "AAA", "weight": 100}]}), 5.0)
    assert hit is False
    assert dd == pytest.approx(-0.95, abs=0.01)


def test_weights_become_shares_at_todays_price(monkeypatch):
    """The client stores a book by weight, not by lot. Treating a 50% weight as
    50 shares would give a $300 stock three times the dollar exposure of a $100
    one at the same weight."""
    frame = _closes({"HIGH": [300.0, 300.0], "LOW": [100.0, 50.0]})
    monkeypatch.setattr("cache.get_download", lambda *a, **k: frame)

    hit, dd, _ = alerts._portfolio_drawdown_sync(json.dumps({
        "total_value": 1000,
        "holdings": [{"ticker": "HIGH", "weight": 50}, {"ticker": "LOW", "weight": 50}],
    }), 1.0)

    # Equal dollars in each *today*: 1.67 shares of HIGH, 10 of LOW. Held back
    # through the window that basket was worth 1500 when LOW was at 100, so it
    # is 33% off its peak. Weight-as-shares would have put three times the
    # dollar exposure in HIGH and produced a different, wrong number.
    assert hit is True
    assert dd == pytest.approx(-33.33, abs=0.5)


def test_drawdown_ignores_a_name_the_download_missed(monkeypatch):
    frame = _closes({"AAA": [100.0, 80.0]})
    monkeypatch.setattr("cache.get_download", lambda *a, **k: frame)
    hit, dd, _ = alerts._portfolio_drawdown_sync(json.dumps({
        "total_value": 1000,
        "holdings": [{"ticker": "AAA", "weight": 50}, {"ticker": "GONE", "weight": 50}],
    }), 10.0)
    assert hit is True
    assert dd == pytest.approx(-20.0)


def test_drawdown_without_holdings_does_not_fire():
    assert alerts._portfolio_drawdown_sync(json.dumps({"holdings": []}), 5.0)[0] is False
    assert alerts._portfolio_drawdown_sync(None, 5.0)[0] is False


def test_both_conditions_are_registered():
    assert "macro_print_above" in alerts._VALID_CONDITIONS
    assert "macro_print_below" in alerts._VALID_CONDITIONS
    assert "portfolio_drawdown_above" in alerts._VALID_CONDITIONS
