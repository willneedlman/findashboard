import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers.slot_engine import (
    SlotContext,
    eval_comparator,
    eval_upside_direction,
    filter_banned_connectives,
    resolve_slots,
)

def test_eval_comparator_multiple_ratios():
    assert eval_comparator(40.3, 31.6) == "well above"
    assert eval_comparator(31.6, 48.9) == "well under"
    assert eval_comparator(31.6, 31.6) == "in line with"
    assert eval_comparator(40.0, 48.9) == "below"


def test_eval_comparator_roe_phrasing():
    assert eval_comparator(141.5, 114.3, phrasing="roe") == "substantially higher than"
    assert eval_comparator(114.3, 141.5, phrasing="roe") == "substantially lower than"


def test_eval_upside_direction():
    assert "upside of 20.3% to intrinsic value" in eval_upside_direction(206.84, 172.0)
    assert "downside of 16.8% to intrinsic value" in eval_upside_direction(172.15, 206.84)


def test_filter_banned_connectives():
    raw = "The margins remain strong, reinforcing the valuation gap and underscoring the thesis."
    filtered = filter_banned_connectives(raw)
    assert "reinforcing the valuation gap" not in filtered
    assert "underscoring the thesis" not in filtered


def test_resolve_slots_replaces_fields_and_comparators():
    ctx = SlotContext(fields={
        "subject.ticker": "NVDA",
        "subject.pe_trailing": 31.6,
        "peers.pe_median": 48.9,
        "subject.dcf_intrinsic": 172.15,
        "subject.market_price": 206.84,
    })

    template = (
        "{subject.ticker} trades at a trailing P/E of {subject.pe_trailing}, "
        "{cmp:subject.pe_trailing,peers.pe_median} the peer median of {peers.pe_median}. "
        "DCF analysis yields {cmp_upside:subject.dcf_intrinsic,subject.market_price}."
    )

    resolved = resolve_slots(template, ctx)

    assert "NVDA trades at a trailing P/E of 31.6x" in resolved
    assert "well under the peer median of 48.9x" in resolved
    assert "downside of 16.8% to intrinsic value" in resolved
