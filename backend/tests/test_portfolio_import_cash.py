"""Cash on a screenshot import is the one field that can silently inflate a book.

Buying power is a borrowing limit and an account total is a sum of positions that
are already being imported. Either one entering as a cash balance overstates the
portfolio without erroring, so the prompt asks the model to skip them and this
rejects them regardless of what the model returns.
"""
import pytest

from routers.portfolio_import import _parse_cash


def labels(rows):
    return [(c.label, c.amount) for c in rows]


def test_a_real_balance_is_kept():
    kept, skipped = _parse_cash([{"label": "Cash", "amount": 5000}])
    assert labels(kept) == [("Cash", 5000.0)]
    assert skipped == 0


def test_a_sweep_or_money_market_balance_is_kept():
    kept, _ = _parse_cash([
        {"label": "Money Market", "amount": 2500},
        {"label": "Cash & sweep", "amount": 1200.5},
        {"label": "Settled cash", "amount": 90},
    ])
    assert len(kept) == 3


@pytest.mark.parametrize("label", [
    "Buying Power",
    "buying power",
    "Margin buying power",
    "Total Account Value",
    "TOTAL",
    "Net worth",
    "Account value",
    "Margin available",
])
def test_anything_that_would_double_count_is_rejected(label):
    kept, skipped = _parse_cash([{"label": label, "amount": 100_000}])
    assert kept == []
    assert skipped == 1


def test_a_negative_balance_survives_because_a_margin_debit_is_real():
    kept, _ = _parse_cash([{"label": "Cash", "amount": -3200.75}])
    assert labels(kept) == [("Cash", -3200.75)]


def test_currency_and_comma_formatting_is_tolerated():
    kept, _ = _parse_cash([{"label": "Cash", "amount": "$12,004.55"}])
    assert labels(kept) == [("Cash", 12004.55)]


def test_rows_without_a_usable_amount_are_skipped_not_zeroed():
    kept, skipped = _parse_cash([
        {"label": "Cash", "amount": None},
        {"label": "Cash", "amount": "n/a"},
        {"label": "", "amount": 500},
        "not a dict",
    ])
    assert kept == []
    assert skipped == 4


def test_a_long_label_is_truncated_rather_than_rejected():
    kept, _ = _parse_cash([{"label": "C" * 200, "amount": 10}])
    assert len(kept) == 1
    assert len(kept[0].label) <= 40


def test_non_list_input_is_safe():
    assert _parse_cash(None) == ([], 0)
    assert _parse_cash({"label": "Cash"}) == ([], 0)
