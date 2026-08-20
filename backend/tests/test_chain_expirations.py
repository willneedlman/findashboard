import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import options as O  # noqa: E402


def test_chain_returns_every_future_expiry(monkeypatch):
    """The list used to be sliced to 12, which for SPY stopped inside the daily
    expiries and never reached a monthly, let alone a LEAP."""
    exps = [f"2026-08-{d:02d}" for d in range(20, 32)] + ["2026-09-18", "2027-01-15", "2028-12-15"]

    class _T:
        def get_expirations(self, sym): return exps
        def get_quote(self, sym): return {"last": 500.0}
        def get_options_chain(self, sym, expiry): return {"calls": [], "puts": []}

    monkeypatch.setattr(O, "_tradier", _T())
    monkeypatch.setattr(O.yf, "Ticker", lambda s: type("X", (), {"options": exps, "option_chain": lambda *a: None})())

    out = O.options_chain(ticker="SPY")
    got = out["expirations"]
    assert len(got) == len(exps), f"expected all {len(exps)}, got {len(got)}"
    assert "2028-12-15" in got, "the longest-dated expiry must survive"
    assert "2027-01-15" in got


def test_past_expiries_are_still_dropped(monkeypatch):
    """Filtering to future dates is the one trim that should remain."""
    exps = ["2020-01-17", "2026-09-18", "2028-12-15"]

    class _T:
        def get_expirations(self, sym): return exps
        def get_quote(self, sym): return {"last": 500.0}
        def get_options_chain(self, sym, expiry): return {"calls": [], "puts": []}

    monkeypatch.setattr(O, "_tradier", _T())
    monkeypatch.setattr(O.yf, "Ticker", lambda s: type("X", (), {"options": exps, "option_chain": lambda *a: None})())

    got = O.options_chain(ticker="SPY")["expirations"]
    assert "2020-01-17" not in got
    assert got == ["2026-09-18", "2028-12-15"]
