import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import screener  # noqa: E402


def _frame(prices: dict) -> pd.DataFrame:
    close = pd.DataFrame(prices, index=pd.to_datetime(["2026-08-13", "2026-08-14"]))
    return pd.concat({"Close": close}, axis=1)


def test_bundled_seed_carries_its_build_date_not_the_clock():
    assert screener._US_FUND_BUILT_AT is not None
    assert screener._US_FUND_BUILT_AT < screener._now_iso()


def test_overlay_rescales_market_cap_by_the_price_move(monkeypatch):
    monkeypatch.setattr(
        "cache.get_download",
        lambda tickers, start, end, interval="1d", **kw: _frame({"AAPL": [270.0, 540.0]}),
    )
    rows = [{"ticker": "AAPL", "price": 275.15, "marketCap": 4041.23,
             "priceSource": "bundled", "priceAsOf": screener._US_FUND_BUILT_AT}]

    screener._overlay_live_prices(rows)

    assert rows[0]["price"] == 540.0
    # Shares are unchanged, so the cap moves with the price rather than being
    # refetched from a vendor that would disagree about the share basis.
    assert rows[0]["marketCap"] == round(4041.23 * 540.0 / 275.15, 2)
    assert rows[0]["change1d"] == 100.0
    assert rows[0]["priceSource"] == "live"
    assert rows[0]["priceAsOf"] > screener._US_FUND_BUILT_AT


def test_overlay_leaves_rows_it_cannot_quote_marked_as_stored(monkeypatch):
    monkeypatch.setattr(
        "cache.get_download",
        lambda tickers, start, end, interval="1d", **kw: _frame({"AAPL": [270.0, 300.0]}),
    )
    rows = [
        {"ticker": "AAPL", "price": 275.15, "marketCap": 4041.23, "priceSource": "bundled"},
        {"ticker": "NOPE", "price": 10.0, "marketCap": 1.0, "priceSource": "bundled"},
    ]

    screener._overlay_live_prices(rows)

    assert rows[0]["priceSource"] == "live"
    assert rows[1]["priceSource"] == "bundled"
    assert rows[1]["price"] == 10.0


def test_overlay_survives_a_dead_download(monkeypatch):
    def _boom(*a, **kw):
        raise RuntimeError("vendor down")

    monkeypatch.setattr("cache.get_download", _boom)
    rows = [{"ticker": "AAPL", "price": 275.15, "marketCap": 4041.23, "priceSource": "bundled"}]

    screener._overlay_live_prices(rows)

    assert rows[0]["price"] == 275.15
    assert rows[0]["priceSource"] == "bundled"


def test_stamp_marks_every_row():
    rows = [{"ticker": "A"}, {"ticker": "B"}]

    screener._stamp(rows, "fmp", "2026-08-15T00:00:00Z")

    assert all(r["priceSource"] == "fmp" for r in rows)
    assert all(r["priceAsOf"] == "2026-08-15T00:00:00Z" for r in rows)
