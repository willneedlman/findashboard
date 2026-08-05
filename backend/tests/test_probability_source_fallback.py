from types import SimpleNamespace

import pandas as pd

from routers import probability


def test_expirations_fall_back_when_tradier_rejects_request(monkeypatch):
    monkeypatch.setattr(probability.tradier, "available", lambda: True)
    monkeypatch.setattr(
        probability.tradier,
        "get_expirations",
        lambda _ticker: (_ for _ in ()).throw(RuntimeError("401 Unauthorized")),
    )
    monkeypatch.setattr(probability.options_data, "get_expirations", lambda _ticker: ["2026-09-18"])

    assert probability._options_expirations("NVDA") == ["2026-09-18"]


def test_chain_falls_back_when_tradier_rejects_request(monkeypatch):
    calls = pd.DataFrame([{"strike": 200, "lastPrice": 10}])
    puts = pd.DataFrame([{"strike": 200, "lastPrice": 8}])
    monkeypatch.setattr(probability.tradier, "available", lambda: True)
    monkeypatch.setattr(
        probability.tradier,
        "get_options_chain",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("401 Unauthorized")),
    )
    monkeypatch.setattr(
        probability.options_data,
        "get_chain",
        lambda *_args: SimpleNamespace(calls=calls, puts=puts),
    )

    fallback_calls, fallback_puts = probability._options_chain("NVDA", "2026-09-18")

    assert fallback_calls.equals(calls)
    assert fallback_puts.equals(puts)
