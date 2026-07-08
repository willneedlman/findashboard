"""Strategy-signal alert type: entry/exit edge detection + create validation.

The rule engine (routers.strategy._run_custom_rules) is mocked so the tests are
deterministic and offline; they exercise the alert layer, not the engine.
"""
import json
import os
import sys
import tempfile

os.environ["ALERTS_DB_PATH"] = tempfile.mktemp()
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import numpy as np
import pytest

import routers.strategy as strat
from routers import alerts

_RULES = {"buy": {"logic": "AND", "conditions": [{}]}, "sell": {"logic": "AND", "conditions": [{}]}}


def _payload(tickers):
    return json.dumps({"name": "My Strat", "rules": _RULES, "tickers": tickers})


@pytest.fixture
def mock_engine(monkeypatch):
    # AAPL just entered (0->1), MSFT stayed invested, NVDA just exited (1->0), TSLA flat cash.
    sigs = {
        "AAPL": np.array([0.0, 0.0, 1.0]), "MSFT": np.array([1.0, 1.0, 1.0]),
        "NVDA": np.array([1.0, 1.0, 0.0]), "TSLA": np.array([0.0, 0.0, 0.0]),
    }
    monkeypatch.setattr(strat, "_run_custom_rules",
                        lambda tk, rules, start, end: (sigs.get(tk), object()))
    return sigs


def test_entry_fires_only_on_rising_edge(mock_engine):
    ok, fired = alerts._strategy_triggered_sync(_payload(["AAPL", "MSFT", "TSLA"]), "strategy_entry")
    assert ok and fired == ["AAPL"]


def test_exit_fires_only_on_falling_edge(mock_engine):
    ok, fired = alerts._strategy_triggered_sync(_payload(["MSFT", "NVDA"]), "strategy_exit")
    assert ok and fired == ["NVDA"]


def test_fans_out_across_tickers(mock_engine):
    # Two names entering the same bar both report.
    sigs = mock_engine
    sigs["AMD"] = np.array([0.0, 0.0, 1.0])
    ok, fired = alerts._strategy_triggered_sync(_payload(["AAPL", "AMD", "MSFT"]), "strategy_entry")
    assert ok and set(fired) == {"AAPL", "AMD"}


def test_no_fire_when_nothing_transitions(mock_engine):
    ok, fired = alerts._strategy_triggered_sync(_payload(["MSFT", "TSLA"]), "strategy_entry")
    assert not ok and fired == []


def test_ticker_cap_bounds_fanout(monkeypatch):
    seen = []
    monkeypatch.setattr(strat, "_run_custom_rules",
                        lambda tk, rules, start, end: (seen.append(tk), (np.zeros(3), object()))[1])
    many = [f"T{i}" for i in range(alerts._STRATEGY_MAX_TICKERS + 5)]
    alerts._strategy_triggered_sync(_payload(many), "strategy_entry")
    assert len(seen) == alerts._STRATEGY_MAX_TICKERS


def test_empty_or_malformed_payload_is_safe():
    assert alerts._strategy_triggered_sync(json.dumps({"rules": {}, "tickers": ["AAPL"]}), "strategy_entry") == (False, [])
    assert alerts._strategy_triggered_sync(json.dumps({"rules": _RULES, "tickers": []}), "strategy_entry") == (False, [])
    assert alerts._strategy_triggered_sync("not json", "strategy_entry") == (False, [])
    assert alerts._strategy_triggered_sync(None, "strategy_entry") == (False, [])


def test_macro_alert_fires_on_watched_event(monkeypatch):
    # Mock the calendar so the test is offline and deterministic.
    import routers.rates as rates
    from datetime import date, timedelta
    soon = (date.today() + timedelta(days=1)).isoformat()
    far = (date.today() + timedelta(days=40)).isoformat()
    events = [
        {"date": soon, "label": "CPI (Headline)", "category": "inflation", "importance": "high"},
        {"date": soon, "label": "Initial Jobless Claims", "category": "employment", "importance": "high"},
        {"date": far, "label": "FOMC Decision", "category": "monetary", "importance": "high"},
    ]
    monkeypatch.setattr(rates, "macro_calendar", lambda: {"events": events})

    # marquee within 2d: CPI is a marquee mover, jobless claims is not.
    ok, hits = alerts._macro_triggered_sync(json.dumps({"mode": "marquee"}), 2)
    assert ok and any("CPI" in h for h in hits) and not any("Jobless" in h for h in hits)
    # monetary within 2d: nothing (FOMC is 40d out).
    ok2, _ = alerts._macro_triggered_sync(json.dumps({"mode": "monetary"}), 2)
    assert not ok2
    # high within 2d: includes jobless claims too.
    ok3, hits3 = alerts._macro_triggered_sync(json.dumps({"mode": "high"}), 2)
    assert ok3 and any("Jobless" in h for h in hits3)


def test_create_validates_rules_and_tickers():
    import asyncio
    from fastapi import HTTPException

    async def _run(payload):
        return await alerts.create_alert(alerts.AlertCreate(
            user_id="u1", ticker="", condition="strategy_entry", threshold=0, payload=payload))

    # Missing rules → 400.
    with pytest.raises(HTTPException):
        asyncio.run(_run({"name": "x", "rules": {}, "tickers": ["AAPL"]}))
    # Missing tickers → 400.
    with pytest.raises(HTTPException):
        asyncio.run(_run({"name": "x", "rules": _RULES, "tickers": []}))
    # Valid → persists with the strategy name in the ticker column and JSON payload.
    res = asyncio.run(_run({"name": "Momentum", "rules": _RULES, "tickers": ["aapl", "AAPL", "msft"]}))
    assert res["ticker"] == "Momentum" and res["condition"] == "strategy_entry"
    stored = json.loads(res["payload"])
    assert stored["tickers"] == ["AAPL", "MSFT"]   # deduped + uppercased
