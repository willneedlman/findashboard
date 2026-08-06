import numpy as np
import pandas as pd
import pytest
from pydantic import ValidationError

from routers.algo import _compute_combo_metrics, _compute_metrics, _compute_option_metrics
from routers.strategy import CustomBacktestRequest


def _request(**overrides):
    return CustomBacktestRequest(
        ticker="AAPL",
        rules={},
        **overrides,
    )


@pytest.mark.parametrize("value", [0, -1, 1001])
def test_single_position_limit_rejects_invalid_values(value):
    with pytest.raises(ValidationError, match="Maximum open positions"):
        _request(max_open_positions=value)


def test_single_position_limit_rejects_fractional_values():
    with pytest.raises(ValidationError):
        _request(max_open_positions=2.5)


def test_single_position_limit_accepts_valid_whole_number():
    assert _request(max_open_positions=7).max_open_positions == 7


def _signals():
    close = pd.Series(
        [100.0, 101.0, 102.0, 103.0, 104.0],
        index=pd.date_range("2025-01-01", periods=5, freq="D"),
    )
    buy = np.array([False, True, True, True, True])
    sell = np.zeros(5, dtype=bool)
    return buy, sell, close


def test_share_engine_enforces_position_entry_limit():
    buy, sell, close = _signals()

    result = _compute_metrics(buy, sell, close, position_size=10, max_open_positions=2)

    assert sum(trade.get("is_entry") is True for trade in result["trades"]) == 2
    assert result["metrics"]["max_open_positions"] == 2
    assert result["metrics"]["position_limit_blocked_entries"] == 2


def test_option_engine_enforces_position_lot_limit():
    buy, sell, close = _signals()

    result = _compute_option_metrics(
        buy,
        sell,
        close,
        {"type": "call", "moneyness": 1.0, "dte": 30},
        iv=20.0,
        position_size=10,
        max_open_positions=2,
    )

    assert sum(trade.get("is_entry") is True for trade in result["trades"]) == 2
    assert result["metrics"]["max_open_positions"] == 2
    assert result["metrics"]["position_limit_blocked_entries"] == 2


def test_combo_engine_enforces_position_lot_limit():
    buy, sell, close = _signals()

    result = _compute_combo_metrics(
        buy,
        sell,
        close,
        {
            "dte": 30,
            "legs": [{"type": "call", "side": "buy", "moneyness": 1.0, "qty": 1}],
        },
        iv=20.0,
        position_size=10,
        max_open_positions=2,
    )

    assert sum(trade.get("is_entry") is True for trade in result["trades"]) == 2
    assert result["metrics"]["max_open_positions"] == 2
    assert result["metrics"]["position_limit_blocked_entries"] == 2
