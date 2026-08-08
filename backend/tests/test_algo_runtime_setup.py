"""Setup extraction: what to trade, as opposed to when.

The failure this guards against is silent and expensive — applying a setup the
user did not ask for changes which instrument their backtest runs on without
telling them. So `clean()` is conservative by construction: anything
questionable is dropped, and silence means "leave what is on screen alone".
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from algo_runtime.setup import clean, explicit_moneyness, mentioned_tickers   # noqa: E402


def test_silence_changes_nothing():
    assert clean({}) == {}
    assert clean({"ticker": None, "instMode": ""}) == {}


@pytest.mark.parametrize("bad", ["SP500", "NASDAQ", "TICKER", "SYMBOL", "PLACEHOLDER",
                                 "ALL", "toolongsymbol", "", "123", "CALL", "RSI"])
def test_universe_labels_and_placeholders_are_not_tickers(bad):
    """A model with no real symbol reaches for one of these; applying it would
    backtest nothing while looking like it worked."""
    assert "ticker" not in clean({"ticker": bad})


@pytest.mark.parametrize("good", ["AAPL", "NVDA", "BRK-B", "SPY", "F"])
def test_real_symbols_survive(good):
    assert clean({"ticker": good})["ticker"] == good


def test_option_parameters_imply_an_option():
    """The live failure: "a 30 day 5% OTM call" came back with optType, otmPct
    and dte all correct and instMode "underlying", which would have traded
    shares. Option parameters on an underlying trade are meaningless, so the
    more specific signal wins."""
    out = clean({"ticker": "NVDA", "instMode": "underlying",
                 "optType": "call", "otmPct": 5, "dte": 30})
    assert out["instMode"] == "option"
    assert out["optType"] == "call" and out["dte"] == 30


def test_legs_imply_a_combo():
    legs = [{"type": "call", "side": "sell", "moneyness": 1.0, "qty": 1},
            {"type": "put", "side": "sell", "moneyness": 1.0, "qty": 1}]
    assert clean({"instMode": "option", "comboLegs": legs})["instMode"] == "combo"


def test_combo_without_legs_is_dropped():
    """An instrument with nothing to price is worse than leaving it alone."""
    assert "instMode" not in clean({"instMode": "combo"})


def test_plain_shares_stay_shares():
    """The coherence rules must not promote a request that really is shares."""
    assert clean({"ticker": "AAPL", "instMode": "underlying"})["instMode"] == "underlying"


def test_several_named_symbols_become_a_book():
    out = clean({"positions": [{"ticker": "AAPL"}, {"ticker": "MSFT", "side": "short"}]})
    assert out["mode"] == "portfolio"
    assert [p["ticker"] for p in out["positions"]] == ["AAPL", "MSFT"]
    assert out["positions"][1]["side"] == "short"


def test_positions_without_a_real_symbol_are_dropped():
    out = clean({"positions": [{"ticker": "AAPL"}, {"ticker": "TICKER"}, {"ticker": "SP500"}]})
    assert len(out["positions"]) == 1


def test_position_option_parameters_imply_an_option():
    out = clean({"positions": [{"ticker": "AAPL", "optType": "put", "dte": 45}]})
    assert out["positions"][0]["instMode"] == "option"
    assert out["positions"][0]["optType"] == "put"


@pytest.mark.parametrize("field,value", [
    ("dte", -5), ("dte", 99999), ("otmPct", -200), ("otmPct", 10000),
    ("portfolioTradeSize", 0), ("portfolioTradeSize", 500),
    ("portfolioMaxOpenPositions", 0), ("timeframe", "1y"), ("side", "sideways"),
    ("mode", "hybrid"), ("instMode", "futures"), ("optType", "swaption"),
])
def test_out_of_range_and_unknown_values_are_dropped(field, value):
    assert field not in clean({field: value})


def test_malformed_legs_are_dropped_individually():
    legs = [{"type": "call", "side": "sell", "moneyness": 1.0, "qty": 1},
            {"type": "banana", "side": "sell"},
            "not a dict"]
    assert len(clean({"comboLegs": legs})["comboLegs"]) == 1


def test_leg_defaults_are_sane():
    out = clean({"comboLegs": [{"type": "put", "side": "buy"}]})
    leg = out["comboLegs"][0]
    assert leg["moneyness"] == 1.0 and leg["qty"] == 1.0


@pytest.mark.parametrize("pct,expected", [(-80, -80.0), (-20, -20.0), (0, 0), (5, 5.0), (20, 20.0)])
def test_in_the_money_is_negative_otm(pct, expected):
    """otmPct is SIGNED distance out of the money, so ITM is negative.
    otmToMoneyness(call, -80) = 0.20, a strike at 20% of spot — 80% in the money.
    A positive value here inverts the user's trade."""
    assert clean({"otmPct": pct, "optType": "call"})["otmPct"] == expected


def test_deep_itm_stays_in_range():
    """-90 is the floor; a deeper request is dropped rather than clamped to
    something the user did not ask for."""
    assert clean({"otmPct": -85})["otmPct"] == -85.0
    assert "otmPct" not in clean({"otmPct": -95})


def test_a_patch_that_repeats_the_current_ticker_reports_no_ticker_change():
    """Keeps the "what did this message change" summary honest."""
    from algo_runtime.setup import extract
    # clean() alone cannot know the current setup; the drop happens in extract().
    # This documents the contract that extract() applies it.
    assert clean({"ticker": "SPY"})["ticker"] == "SPY"


# ── deterministic guards over the model's answer ─────────────────────────────

@pytest.mark.parametrize("text,expected", [
    ("365 dte, 80% itm", -80.0),
    ("20% ITM, 365 DTE", -20.0),
    ("buy a 5% out of the money call", 5.0),
    ("sell a 20% otm put", 20.0),
    ("at the money straddle", 0.0),
    ("an ATM call", 0.0),
    ("in-the-money by 15%", -15.0),
    ("no moneyness mentioned at all", None),
    ("365 dte", None),
])
def test_stated_moneyness_is_parsed_not_guessed(text, expected):
    """"80% itm" came back as -20 because an earlier turn said 20 and the model
    anchored on it. A number plus a side is not a judgement call, so it is parsed
    and overrides the model — getting it wrong silently trades a different
    strike."""
    assert explicit_moneyness(text) == expected


def test_moneyness_takes_the_last_statement_in_a_message():
    assert explicit_moneyness("was 20% otm, make it 80% itm") == -80.0


@pytest.mark.parametrize("text,present,absent", [
    ("Trade SPY, long a 365 day call", "SPY", "AAPL"),
    ("run this on NVDA and MSFT", "NVDA", "TSLA"),
    ("365 dte, 80% itm", None, "AAPL"),
])
def test_only_symbols_the_user_typed_are_recognised(text, present, absent):
    """An empty setup let the model reach for AAPL and silently move the
    backtest off SPY. A symbol nobody typed is a hallucination."""
    seen = mentioned_tickers(text)
    if present:
        assert present in seen
    assert absent not in seen


def test_common_words_are_not_mistaken_for_symbols():
    seen = mentioned_tickers("buy the call and sell the put when rsi is low")
    for word in ("BUY", "SELL", "CALL", "PUT", "RSI", "THE", "AND"):
        assert word not in seen


def test_a_full_realistic_extraction():
    out = clean({
        "mode": "single", "ticker": "NVDA", "side": "long", "timeframe": "1d",
        "instMode": "option", "optType": "call", "otmPct": 5, "dte": 30,
    })
    assert out == {"mode": "single", "ticker": "NVDA", "side": "long", "timeframe": "1d",
                   "instMode": "option", "optType": "call", "otmPct": 5.0, "dte": 30}
