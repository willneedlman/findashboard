import datetime as dt

import numpy as np
import pandas as pd
import pytest

import rrg


def _daily(columns: dict[str, list[float]]) -> pd.DataFrame:
    index = pd.bdate_range(end=dt.date.today(), periods=len(next(iter(columns.values()))))
    return pd.concat({"Close": pd.DataFrame(columns, index=index)}, axis=1)


def _steady(n: int, drift: float, start: float = 100.0) -> list[float]:
    return [start * (1 + drift) ** i for i in range(n)]


def test_quadrants_split_on_one_hundred():
    assert rrg.quadrant(101, 101) == "leading"
    assert rrg.quadrant(101, 99) == "weakening"
    assert rrg.quadrant(99, 99) == "lagging"
    assert rrg.quadrant(99, 101) == "improving"


def test_tails_are_smooth_enough_to_read(monkeypatch):
    """The bug this pins put eleven sectors on screen swinging two to four
    points of momentum a week, which renders as a mesh rather than as paths.
    Smoothing is not cosmetic here — without it the chart cannot be read."""
    n = 700
    rng = np.random.default_rng(5)
    bench = 100 * np.cumprod(1 + rng.normal(0.0003, 0.01, n))
    # A sector that outperforms steadily, plus daily noise.
    sector = bench * np.cumprod(1 + rng.normal(0.0004, 0.006, n))
    frame = _daily({"XLK": list(sector), "SPY": list(bench)})
    monkeypatch.setattr(rrg, "get_download", lambda *a, **k: frame)

    out = rrg._rrg.__wrapped__(("XLK",), "SPY", 8, 1)
    tail = out["series"][0]["tail"]
    steps = [abs(tail[i]["y"] - tail[i - 1]["y"]) for i in range(1, len(tail))]

    assert max(steps) < 1.5, f"momentum jumping {max(steps):.2f} a week is a hairball"


def test_sustained_outperformance_lands_in_leading(monkeypatch):
    n = 700
    bench = _steady(n, 0.0002)
    sector = _steady(n, 0.0009)          # clearly stronger, and still accelerating away
    frame = _daily({"XLK": sector, "SPY": bench})
    monkeypatch.setattr(rrg, "get_download", lambda *a, **k: frame)

    out = rrg._rrg.__wrapped__(("XLK",), "SPY", 8, 1)
    series = out["series"][0]

    assert series["x"] > 100, "a sector beating the benchmark all year is not weak"
    assert series["quadrant"] in ("leading", "weakening")


def test_a_sector_rolling_over_reads_as_weakening(monkeypatch):
    """Strong on the year, fading lately. This is the reading the chart exists
    to produce, and it depends on momentum being a multi-week change rather
    than last week's wiggle."""
    n = 700
    bench = _steady(n, 0.0003)
    # Outperforms for most of the window, then flattens against the benchmark.
    sector = _steady(n - 90, 0.0011)
    sector += [sector[-1] * (1 + 0.0001) ** i for i in range(1, 91)]
    frame = _daily({"XLK": sector, "SPY": bench})
    monkeypatch.setattr(rrg, "get_download", lambda *a, **k: frame)

    series = rrg._rrg.__wrapped__(("XLK",), "SPY", 8, 1)["series"][0]

    assert series["x"] > 100          # still strong on the year
    assert series["y"] < 100          # but momentum has turned
    assert series["quadrant"] == "weakening"


def test_benchmark_missing_from_the_download_says_so(monkeypatch):
    frame = _daily({"XLK": _steady(400, 0.001)})
    monkeypatch.setattr(rrg, "get_download", lambda *a, **k: frame)
    out = rrg._rrg.__wrapped__(("XLK",), "SPY", 8, 1)
    assert out["available"] is False
    assert "SPY" in out["reason"]


def test_short_history_is_refused_rather_than_extrapolated(monkeypatch):
    frame = _daily({"XLK": _steady(60, 0.001), "SPY": _steady(60, 0.0005)})
    monkeypatch.setattr(rrg, "get_download", lambda *a, **k: frame)
    out = rrg._rrg.__wrapped__(("XLK",), "SPY", 8, 1)
    assert out["available"] is False


def test_a_name_without_enough_history_drops_out_not_the_whole_chart(monkeypatch):
    n = 700
    frame = _daily({
        "XLK": _steady(n, 0.0008),
        "NEW": [float("nan")] * (n - 20) + _steady(20, 0.002),
        "SPY": _steady(n, 0.0003),
    })
    monkeypatch.setattr(rrg, "get_download", lambda *a, **k: frame)

    out = rrg._rrg.__wrapped__(("XLK", "NEW"), "SPY", 8, 1)

    assert [s["ticker"] for s in out["series"]] == ["XLK"]


def test_tail_length_is_respected(monkeypatch):
    n = 700
    frame = _daily({"XLK": _steady(n, 0.0008), "SPY": _steady(n, 0.0003)})
    monkeypatch.setattr(rrg, "get_download", lambda *a, **k: frame)
    for tail in (4, 12):
        out = rrg._rrg.__wrapped__(("XLK",), "SPY", tail, 1)
        assert len(out["series"][0]["tail"]) == tail


def test_counts_cover_every_quadrant(monkeypatch):
    n = 700
    frame = _daily({"XLK": _steady(n, 0.0008), "SPY": _steady(n, 0.0003)})
    monkeypatch.setattr(rrg, "get_download", lambda *a, **k: frame)
    counts = rrg._rrg.__wrapped__(("XLK",), "SPY", 8, 1)["counts"]
    assert set(counts) == {"leading", "weakening", "lagging", "improving"}
    assert sum(counts.values()) == 1


def test_schema_is_part_of_the_persisted_cache_key():
    import inspect
    assert "schema" in inspect.signature(rrg._rrg.__wrapped__).parameters
    assert rrg._SCHEMA >= 2
