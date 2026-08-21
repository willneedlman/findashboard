import os
import sys
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import options as O  # noqa: E402


def test_chain_returns_every_future_expiry(monkeypatch):
    """The list used to be sliced to 12, which for SPY stopped inside the daily
    expiries and never reached a monthly, let alone a LEAP."""
    today = date.today()
    exps = ([(today + timedelta(days=i)).isoformat() for i in range(0, 12)]
            + [(today + timedelta(days=n)).isoformat() for n in (30, 150, 850)])

    class _T:
        def get_expirations(self, sym): return exps
        def get_quote(self, sym): return {"last": 500.0}
        def get_options_chain(self, sym, expiry): return {"calls": [], "puts": []}

    monkeypatch.setattr(O, "_tradier", _T())
    monkeypatch.setattr(O.yf, "Ticker", lambda s: type("X", (), {"options": exps, "option_chain": lambda *a: None})())

    out = O.options_chain(ticker="SPY")
    got = out["expirations"]
    assert len(got) == len(exps), f"expected all {len(exps)}, got {len(got)}"
    assert exps[-1] in got, "the longest-dated expiry must survive"
    assert exps[-2] in got


def test_past_expiries_are_still_dropped(monkeypatch):
    """Filtering to future dates is the one trim that should remain."""
    past = (today_ := date.today()) - timedelta(days=900)
    future = [(today_ + timedelta(days=n)).isoformat() for n in (30, 850)]
    exps = [past.isoformat()] + future

    class _T:
        def get_expirations(self, sym): return exps
        def get_quote(self, sym): return {"last": 500.0}
        def get_options_chain(self, sym, expiry): return {"calls": [], "puts": []}

    monkeypatch.setattr(O, "_tradier", _T())
    monkeypatch.setattr(O.yf, "Ticker", lambda s: type("X", (), {"options": exps, "option_chain": lambda *a: None})())

    got = O.options_chain(ticker="SPY")["expirations"]
    assert past.isoformat() not in got
    assert got == future
