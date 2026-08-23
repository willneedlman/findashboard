"""Tests for the Options Strategy Builder AI helper's grounding layer.

The LLM call itself isn't exercised; what matters is that (1) ticker detection
picks the real optionable symbol out of options vocabulary and articles, and
(2) a draft's legs get snapped onto real strikes/premiums/expiries — turning a
relative-to-100 structure into tradeable legs around the live spot. Network-free:
options_data and the spot lookup are monkeypatched.
"""
import os
import sys

from datetime import date as _date, timedelta as _timedelta

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import options_data  # noqa: E402
from routers import ai  # noqa: E402
from routers.ai import (  # noqa: E402
    _detect_options_ticker, _ground_options_draft, _nearest_dte_expiry, _snap_expiry,
    StrategyChatMessage as M,
)

_REAL = {"NVDA", "AAPL", "TSLA", "SPY", "F", "A", "AGX"}
# Built from today rather than written down: the grounding code snaps to the
# nearest expiry that has not passed, so a hardcoded date silently changes what
# the test is asserting the moment the calendar rolls past it.
_NEAR = _date.today() + _timedelta(days=7)
_FAR = _date.today() + _timedelta(days=45)
_EXPS = [_NEAR.isoformat(), _FAR.isoformat()]


def _fake_exps(sym):
    return _EXPS if sym.strip().upper() in _REAL else []


def _chain(strikes):
    df = pd.DataFrame({
        "strike": strikes,
        "bid": [max(0.5, 200 - s) * 0.1 + 1 for s in strikes],
        "ask": [max(0.5, 200 - s) * 0.1 + 1.4 for s in strikes],
        "lastPrice": [1.0 for _ in strikes],
    })

    class _Chain:
        calls = df
        puts = df
        underlying = {"regularMarketPrice": 200.0}
    return _Chain()


def _patch(monkeypatch):
    monkeypatch.setattr(options_data, "get_expirations", _fake_exps)
    monkeypatch.setattr(options_data, "get_chain", lambda sym, exp: _chain(list(range(150, 251, 5))))
    monkeypatch.setattr(ai, "_options_spot", lambda sym, chain=None: 200.0)


# ── ticker detection ──────────────────────────────────────────────────────────

def test_detects_lowercase_ticker_over_article(monkeypatch):
    monkeypatch.setattr(options_data, "get_expirations", _fake_exps)
    assert _detect_options_ticker([M(role="user", content="buy a bull call spread on nvda")]) == "NVDA"


def test_detects_cashtag(monkeypatch):
    monkeypatch.setattr(options_data, "get_expirations", _fake_exps)
    assert _detect_options_ticker([M(role="user", content="long straddle on $TSLA into earnings")]) == "TSLA"


def test_uppercase_ticker_wins_over_stray_word(monkeypatch):
    monkeypatch.setattr(options_data, "get_expirations", _fake_exps)
    assert _detect_options_ticker([M(role="user", content="I want a put spread on AAPL")]) == "AAPL"


def test_no_ticker_returns_none(monkeypatch):
    monkeypatch.setattr(options_data, "get_expirations", _fake_exps)
    assert _detect_options_ticker([M(role="user", content="sell me a wide iron condor next month")]) is None


def test_uppercase_single_letter_ticker_allowed(monkeypatch):
    monkeypatch.setattr(options_data, "get_expirations", _fake_exps)
    assert _detect_options_ticker([M(role="user", content="buy F calls")]) == "F"


# ── draft grounding ───────────────────────────────────────────────────────────

def test_relative_to_100_spread_rescales_and_snaps(monkeypatch):
    _patch(monkeypatch)
    draft = {"type": "draft", "name": "Bull Call Spread", "legs": [
        {"option_type": "call", "action": "buy", "K": 100, "premium": 2, "quantity": 1, "ticker": "NVDA", "expiry": (_date.today() + _timedelta(days=6)).isoformat()},
        {"option_type": "call", "action": "sell", "K": 105, "premium": 2, "quantity": 1, "ticker": "NVDA", "expiry": (_date.today() + _timedelta(days=6)).isoformat()},
    ]}
    g = _ground_options_draft(draft, "NVDA")
    assert g["spot"] == 200.0 and g["ticker"] == "NVDA"
    ks = [l["K"] for l in g["legs"]]
    assert ks == [200.0, 210.0]                       # 100/105 rescaled to spot then snapped to the 5-pt ladder
    assert g["legs"][0]["action"] == "buy" and g["legs"][1]["action"] == "sell"
    assert all(l["expiry"] == _EXPS[0] for l in g["legs"])   # snapped to nearest real expiry
    assert all(l["premium"] > 0 for l in g["legs"])   # real mid, never left at the placeholder


def test_absolute_strikes_are_snapped_not_rescaled(monkeypatch):
    _patch(monkeypatch)
    # Already near spot -> not treated as relative-to-100; just snapped to the ladder.
    draft = {"type": "draft", "name": "Strangle", "legs": [
        {"option_type": "put", "action": "sell", "K": 188, "premium": 3, "quantity": 1, "ticker": "NVDA", "expiry": _EXPS[1]},
        {"option_type": "call", "action": "sell", "K": 213, "premium": 3, "quantity": 1, "ticker": "NVDA", "expiry": _EXPS[1]},
    ]}
    g = _ground_options_draft(draft, "NVDA")
    assert [l["K"] for l in g["legs"]] == [190.0, 215.0]   # snapped to nearest 5-pt strikes, not rescaled
    assert all(l["expiry"] == _EXPS[1] for l in g["legs"])


def test_nearest_dte_and_snap_expiry():
    assert _nearest_dte_expiry(_EXPS, 35) in _EXPS
    assert _snap_expiry((_date.today() + _timedelta(days=6)).isoformat(), _EXPS, _EXPS[0]) == _EXPS[0]
    assert _snap_expiry(_EXPS[1], _EXPS, _EXPS[0]) == _EXPS[1]
