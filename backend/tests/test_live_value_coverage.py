"""Reporting of a range that a short-history holding cut short.

The curve is an inner join across holdings, so a book containing one recent
listing silently returns the SAME window for 1Y as for YTD — the two ranges look
identical on screen with nothing to explain why. The join stays (marking the book
before a name exists would step the total up as names come online), so the
contract is that the response reports what it actually covered.
"""
import datetime as _dt

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from main import app

client = TestClient(app)

FULL = "AAPL"      # a year of history
SHORT = "NEWCO"    # lists in January


def _frame(end: pd.Timestamp) -> pd.DataFrame:
    idx = pd.date_range(end - pd.Timedelta(days=364), end, freq="B", tz="UTC")
    full = pd.Series(np.linspace(200.0, 230.0, len(idx)), index=idx)
    short = pd.Series(np.linspace(50.0, 60.0, len(idx)), index=idx)
    short[short.index < pd.Timestamp(year=end.year, month=1, day=2, tz="UTC")] = np.nan
    return pd.DataFrame({FULL: full, SHORT: short})


@pytest.fixture
def stub(monkeypatch):
    """Serve the synthetic frame for every window the endpoint asks for."""
    from routers import portfolio

    end = pd.Timestamp(_dt.datetime.now(_dt.timezone.utc)).normalize()
    frame = _frame(end)

    def fake_closes(symbols, start, tf=portfolio._LIVE_TF):
        cols = [s for s in symbols if s in frame.columns]
        return frame[cols].copy(), "stub"

    monkeypatch.setattr(portfolio, "_live_intraday_closes", fake_closes)
    return frame


def _post(rng: str, tickers=(FULL, SHORT)):
    body = {"holdings": [{"ticker": t, "shares": 1} for t in tickers], "cash": 0.0, "range": rng}
    r = client.post("/api/portfolio/live-value", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_a_short_history_holding_is_named_as_the_limit(stub):
    body = _post("1y")
    assert body["limited_by"], "a 1Y cut short by a January listing must say so"
    assert {x["ticker"] for x in body["limited_by"]} == {SHORT}
    assert body["covered_from"] > body["requested_from"]


def test_a_full_history_book_reports_no_limit(stub):
    body = _post("1y", tickers=(FULL,))
    assert body["limited_by"] == []
    # Covered from the requested start, give or take the weekend the window opens on.
    covered = pd.Timestamp(body["covered_from"])
    requested = pd.Timestamp(body["requested_from"])
    assert covered - requested <= pd.Timedelta(days=4)


def test_ytd_is_not_flagged_when_it_genuinely_starts_in_january(stub):
    # The listing date and the YTD start coincide, so nothing is being cut short.
    assert _post("ytd")["limited_by"] == []


def test_the_truncated_range_still_returns_the_shorter_curve(stub):
    # The fix is reporting, not silently extending: 1Y and YTD still agree here.
    one_year, ytd = _post("1y"), _post("ytd")
    assert one_year["covered_from"] == ytd["covered_from"]
    assert len(one_year["points"]) == len(ytd["points"])
    assert one_year["limited_by"] and not ytd["limited_by"]


def test_coverage_fields_are_present_on_a_cash_only_book(stub):
    r = client.post("/api/portfolio/live-value", json={"holdings": [], "cash": 500.0, "range": "1y"})
    assert r.status_code == 200
    body = r.json()
    assert body["limited_by"] == []
    assert body["covered_from"] is None and body["requested_from"] is None


def test_intraday_ranges_have_no_requested_window(stub):
    # 1D and 1H are session-relative, so there is no calendar window to fall short of.
    assert _post("1d")["requested_from"] is None
