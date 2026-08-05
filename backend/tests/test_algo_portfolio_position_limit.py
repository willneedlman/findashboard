import pytest
from pydantic import ValidationError

from routers.ai import _normalize_fractional_percentages, _portfolio_allocation_issue
from routers.strategy import PortfolioBacktestRequest, _portfolio_entry_capacity


def _request(**overrides):
    return PortfolioBacktestRequest(
        positions=[{"ticker": "AAPL"}],
        **overrides,
    )


def test_position_count_limit_blocks_entry_before_exposure_is_full():
    allowed, position_limit_reached = _portfolio_entry_capacity(
        open_count=3,
        open_exposure=30,
        candidate_size=10,
        exposure_cap=100,
        max_open_positions=3,
    )

    assert allowed is False
    assert position_limit_reached is True


def test_position_count_limit_and_exposure_limit_are_independent():
    assert _portfolio_entry_capacity(2, 20, 10, 100, 3) == (True, False)
    assert _portfolio_entry_capacity(2, 95, 10, 100, 3) == (False, False)
    assert _portfolio_entry_capacity(20, 20, 10, 100, None) == (True, False)


@pytest.mark.parametrize("value", [0, -1, 1001])
def test_max_open_positions_rejects_invalid_values(value):
    with pytest.raises(ValidationError, match="Maximum open positions"):
        _request(max_open_positions=value)


def test_max_open_positions_rejects_fractional_values():
    with pytest.raises(ValidationError):
        _request(max_open_positions=2.5)


def test_max_open_positions_accepts_valid_whole_number():
    assert _request(max_open_positions=7).max_open_positions == 7


def test_ai_portfolio_draft_requires_a_position_limit():
    draft = {"mode": "portfolio", "position_size_pct": 10, "leverage": 1, "effective_annual_rate": 0}

    assert "maximum number" in _portfolio_allocation_issue(draft).lower()
    draft["max_open_positions"] = 4
    assert _portfolio_allocation_issue(draft) is None


def test_ai_draft_does_not_silently_round_a_fractional_limit():
    draft = {
        "mode": "portfolio",
        "position_size_pct": 10,
        "max_open_positions": 2.5,
        "leverage": 1,
        "effective_annual_rate": 0,
        "strategies": [],
    }

    _normalize_fractional_percentages(draft)

    assert draft["max_open_positions"] == 2.5
    assert "whole-number" in _portfolio_allocation_issue(draft).lower()
