"""Tests for the AI dashboard-builder endpoint. The LLM is mocked; what's under
test is the request contract and the server-side normalization that guarantees
the AI can never emit an unplaceable tile.
"""
import json
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import pytest  # noqa: E402
from routers import ai  # noqa: E402
from routers.ai import DashboardChatRequest, DashboardCatalogItem, StrategyChatMessage  # noqa: E402


def _resp(content):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=content))])


def _catalog():
    return [
        DashboardCatalogItem(type="yield-curve", label="Yield Curve", defW=4, defH=7, minW=3, minH=5),
        DashboardCatalogItem(type="dealer-gex", label="Dealer GEX", defW=4, defH=6, minW=3, minH=4, ticker=True),
    ]


def _req(msg="build a macro dashboard"):
    return DashboardChatRequest(messages=[StrategyChatMessage(role="user", content=msg)], catalog=_catalog())


def test_draft_normalizes_sizes_and_drops_unknown_types(monkeypatch):
    draft = {"type": "draft", "name": "Macro", "action": "replace", "summary": "s", "items": [
        {"type": "yield-curve", "config": {}, "x": 0, "y": 0, "w": 20, "h": 1},   # w over grid, h below min
        {"type": "bogus", "x": 0, "y": 0, "w": 4, "h": 4},                        # not in catalog -> dropped
        {"type": "dealer-gex", "config": {"ticker": "NVDA"}, "x": -5, "y": 0, "w": 4, "h": 6},
    ]}
    monkeypatch.setattr(ai, "groq_chat", lambda *a, **k: _resp(json.dumps(draft)))
    out = ai.dashboard_chat(_req())
    assert out["type"] == "draft" and out["action"] == "replace" and out["name"] == "Macro"
    items = out["items"]
    assert len(items) == 2                                   # bogus dropped
    yc = items[0]
    assert yc["type"] == "yield-curve" and yc["w"] == 12 and yc["h"] == 5   # w clamped to grid, h up to minH
    gex = items[1]
    assert gex["config"]["ticker"] == "NVDA" and gex["x"] == 0              # negative x clamped


def test_question_passes_through(monkeypatch):
    monkeypatch.setattr(ai, "groq_chat", lambda *a, **k: _resp('{"type":"question","text":"which theme?"}'))
    out = ai.dashboard_chat(_req())
    assert out["type"] == "question" and "theme" in out["text"]


def test_draft_with_no_valid_items_becomes_question(monkeypatch):
    draft = {"type": "draft", "items": [{"type": "nope", "w": 4, "h": 4}]}
    monkeypatch.setattr(ai, "groq_chat", lambda *a, **k: _resp(json.dumps(draft)))
    out = ai.dashboard_chat(_req())
    assert out["type"] == "question"


def test_bad_action_defaults_to_replace(monkeypatch):
    draft = {"type": "draft", "action": "explode", "items": [{"type": "yield-curve", "w": 4, "h": 7}]}
    monkeypatch.setattr(ai, "groq_chat", lambda *a, **k: _resp(json.dumps(draft)))
    assert ai.dashboard_chat(_req())["action"] == "replace"


def test_empty_catalog_rejected():
    with pytest.raises(ai.HTTPException):
        ai.dashboard_chat(DashboardChatRequest(messages=[StrategyChatMessage(role="user", content="x")], catalog=[]))


def test_normalizer_enforces_duplicate_conflict_and_config_metadata():
    catalog = [
        DashboardCatalogItem(type="index-tape", multiple=False, configOptions=["tickers"]),
        DashboardCatalogItem(type="paper-trade", conflicts=["tradingview-chart"], ticker=True, configOptions=["ticker"]),
        DashboardCatalogItem(type="tradingview-chart", conflicts=["paper-trade"], ticker=True, configOptions=["ticker"]),
    ]
    items = [
        {"type": "index-tape", "config": {"tickers": ["SPY"], "bogus": True}},
        {"type": "index-tape", "config": {"tickers": ["QQQ"]}},
        {"type": "paper-trade", "config": {"ticker": "NVDA"}},
        {"type": "tradingview-chart", "config": {"ticker": "NVDA"}},
    ]
    out = ai._normalize_dashboard_items(items, catalog, 12)
    assert [item["type"] for item in out] == ["index-tape", "paper-trade"]
    assert out[0]["config"] == {"tickers": ["SPY"]}


def test_llm_failure_returns_friendly_503(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("provider 429 rate limit")
    monkeypatch.setattr(ai, "groq_chat", boom)
    with pytest.raises(ai.HTTPException) as ei:
        ai.dashboard_chat(_req())
    assert ei.value.status_code == 503 and "busy" in ei.value.detail.lower()
