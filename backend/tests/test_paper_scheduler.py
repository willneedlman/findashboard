from strategies.base import Signal
from routers.paper_scheduler import _evaluate_signal


class StubStrategy:
    def __init__(self, signal: Signal):
        self.signal = signal
        self.last_point = None

    def on_data(self, point):
        self.last_point = point
        return self.signal


def test_evaluate_signal_uses_strategy_signal_contract():
    strategy = StubStrategy(Signal.BUY)

    result = _evaluate_signal(strategy, "aapl", 221.5, 1_780_000_000.0)

    assert result == "BUY"
    assert strategy.last_point.symbol == "aapl"
    assert strategy.last_point.price == 221.5


def test_evaluate_signal_rejects_invalid_strategy_result():
    strategy = StubStrategy(Signal.HOLD)
    strategy.signal = None

    try:
        _evaluate_signal(strategy, "MSFT", 510.0, 1_780_000_000.0)
    except TypeError as error:
        assert "expected Signal" in str(error)
    else:
        raise AssertionError("invalid strategy result should be rejected")
