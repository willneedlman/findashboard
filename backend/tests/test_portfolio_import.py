"""Tests for portfolio-screenshot import, including the new option-position path.

The vision call is mocked; what's exercised is the option-row validation and the
endpoint's holdings+options response shape.
"""
import base64
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import portfolio_import as pi  # noqa: E402
from routers.portfolio_import import _parse_options, parse_screenshot, ScreenshotImportRequest  # noqa: E402

_IMG = base64.b64encode(b"not-really-an-image").decode()  # _decode_image only checks base64 validity + size


def test_parse_options_valid_and_normalized():
    opts, skipped = _parse_options([
        {"underlying": "aapl", "type": "Call", "strike": "195", "expiry": "2026-08-15", "side": "long", "contracts": "2", "avgPremium": "8.50"},
        {"underlying": "TSLA", "type": "P", "strike": 240, "expiry": "2026-09-18", "side": "sell to open", "contracts": "-1"},
    ])
    assert skipped == 0 and len(opts) == 2
    a, t = opts
    assert (a.underlying, a.type, a.strike, a.side, a.contracts, a.avgPremium) == ("AAPL", "call", 195.0, "long", 2.0, 8.5)
    # "P" -> put, "sell to open"/negative qty -> short, contracts made positive, no premium
    assert (t.type, t.side, t.contracts, t.avgPremium) == ("put", "short", 1.0, None)


def test_parse_options_drops_incomplete_rows():
    opts, skipped = _parse_options([
        {"underlying": "AAPL", "type": "call", "strike": 195, "expiry": "Aug 15", "side": "long", "contracts": 1},  # non-ISO expiry
        {"underlying": "", "type": "call", "strike": 100, "expiry": "2026-08-15", "side": "long", "contracts": 1},   # no underlying
        {"underlying": "NVDA", "type": "call", "strike": 0, "expiry": "2026-08-15", "side": "long", "contracts": 1}, # bad strike
        {"underlying": "NVDA", "type": "call", "strike": 200, "expiry": "2026-08-15", "side": "long", "contracts": 0},# no contracts
    ])
    assert opts == [] and skipped == 4


def test_endpoint_parses_holdings_and_options(monkeypatch):
    payload = {
        "holdings": [{"ticker": "AAPL", "shares": 10, "avgCost": 180}],
        "options": [{"underlying": "AAPL", "type": "call", "strike": 195, "expiry": "2026-08-15",
                     "side": "long", "contracts": 2, "avgPremium": 8.5}],
    }
    monkeypatch.setattr(pi, "vision_complete", lambda *a, **k: json.dumps(payload))
    resp = parse_screenshot(ScreenshotImportRequest(image_base64=_IMG))
    assert len(resp.holdings) == 1 and resp.holdings[0].ticker == "AAPL"
    assert len(resp.options) == 1 and resp.options[0].strike == 195.0 and resp.options[0].type == "call"
    assert resp.warning is None


def test_endpoint_tolerates_legacy_bare_array(monkeypatch):
    monkeypatch.setattr(pi, "vision_complete", lambda *a, **k: json.dumps([{"ticker": "MSFT", "shares": 5, "avgCost": None}]))
    resp = parse_screenshot(ScreenshotImportRequest(image_base64=_IMG))
    assert len(resp.holdings) == 1 and resp.options == []


def test_endpoint_empty_warns(monkeypatch):
    monkeypatch.setattr(pi, "vision_complete", lambda *a, **k: json.dumps({"holdings": [], "options": []}))
    resp = parse_screenshot(ScreenshotImportRequest(image_base64=_IMG))
    assert resp.holdings == [] and resp.options == [] and "No readable" in (resp.warning or "")
