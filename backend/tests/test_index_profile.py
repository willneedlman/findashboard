import datetime as dt

import pandas as pd
import pytest

import index_profile as ip


def _frame(columns: dict[str, list[float]], days: int) -> pd.DataFrame:
    """A yfinance-shaped multi-ticker download: a Close block keyed by ticker."""
    index = pd.bdate_range(end=dt.date.today(), periods=days)
    close = pd.DataFrame({k: v for k, v in columns.items()}, index=index)
    return pd.concat({"Close": close}, axis=1)


@pytest.fixture
def members():
    return [
        {"ticker": "AAA.L", "name": "Alpha", "shares": 1_000_000, "currency": "GBp"},
        {"ticker": "BBB.L", "name": "Beta", "shares": 2_000_000, "currency": "GBp"},
    ]


def test_pence_quotes_are_not_counted_as_pounds(monkeypatch, members):
    """The failure this guards against does not look wrong on one row. A London
    constituent priced at 1500 pence is a 15 pound share, and treating the quote
    as pounds inflates every FTSE cap by exactly 100x."""
    frame = _frame({"AAA.L": [1000.0, 1500.0], "BBB.L": [500.0, 500.0], "GBPUSD=X": [1.25, 1.25]}, 2)
    monkeypatch.setattr(ip, "get_download", lambda *a, **k: frame)

    rows, fx = ip._price_members(members, "GBp")

    assert fx == pytest.approx(0.0125)                     # 1.25 USD per GBP, GBp is 1/100
    alpha = next(r for r in rows if r["ticker"] == "AAA.L")
    assert alpha["market_cap_usd"] == pytest.approx(1_000_000 * 1500 * 0.0125)   # $18.75m, not $1.875bn


def test_usd_index_needs_no_fx_pair(monkeypatch):
    frame = _frame({"AAA": [10.0, 11.0]}, 2)
    captured = {}

    def fake(tickers, *a, **k):
        captured["tickers"] = tickers
        return frame

    monkeypatch.setattr(ip, "get_download", fake)
    rows, fx = ip._price_members([{"ticker": "AAA", "name": "A", "shares": 100, "currency": "USD"}], "USD")

    assert captured["tickers"] == ("AAA",)
    assert fx == 1.0
    assert rows[0]["market_cap_usd"] == 1100
    assert rows[0]["change_pct"] == pytest.approx(10.0)


def test_member_missing_from_the_download_is_dropped_not_zeroed(monkeypatch, members):
    """A name Yahoo did not return must vanish from the table. Emitting it at
    zero would drag the breadth count and the cap total silently."""
    frame = _frame({"AAA.L": [100.0, 110.0], "GBPUSD=X": [1.25, 1.25]}, 2)
    monkeypatch.setattr(ip, "get_download", lambda *a, **k: frame)

    rows, _ = ip._price_members(members, "GBp")

    assert [r["ticker"] for r in rows] == ["AAA.L"]


def test_profile_aggregates(monkeypatch):
    entry = {
        "currency": "USD", "weighting": "cap", "as_of": "2026-08-08", "source": "wiki",
        "members": [
            {"ticker": "BIG", "name": "Big", "shares": 1000, "currency": "USD"},
            {"ticker": "MID", "name": "Mid", "shares": 100, "currency": "USD"},
            {"ticker": "FLAT", "name": "Flat", "shares": 10, "currency": "USD"},
        ],
    }
    monkeypatch.setattr(ip, "_load", lambda: {"indices": {"^X": entry}})
    frame = _frame({"BIG": [100.0, 110.0], "MID": [50.0, 45.0], "FLAT": [10.0, 10.0]}, 2)
    monkeypatch.setattr(ip, "get_download", lambda *a, **k: frame)

    out = ip.index_profile.__wrapped__("^X")

    assert out["available"] is True
    assert out["breadth"] == {"advancing": 1, "declining": 1, "unchanged": 1, "priced": 3}
    assert [m["ticker"] for m in out["members"]] == ["BIG", "MID", "FLAT"]   # cap order
    assert out["total_market_cap_usd"] == 1000 * 110 + 100 * 45 + 10 * 10
    assert out["members"][0]["weight_pct"] == pytest.approx(95.99, abs=0.01)
    assert out["leaders"][0]["ticker"] == "BIG"
    assert out["laggards"] == []                     # too few names to split into two lists
    assert out["coverage"] == {"listed": 3, "priced": 3}


def test_sector_mix_is_cap_weighted_not_headcount(monkeypatch):
    """One giant bank outweighs six small miners. Counting names instead of
    capital would invert the picture on any concentrated index."""
    rows = [
        {"sector": "Banks", "market_cap_usd": 900, "change_pct": -1.0},
        {"sector": "Mining", "market_cap_usd": 50, "change_pct": 4.0},
        {"sector": "Mining", "market_cap_usd": 50, "change_pct": 2.0},
        {"sector": None, "market_cap_usd": 100, "change_pct": 5.0},      # untagged, excluded
    ]
    mix = ip._sector_mix(rows, 1000.0)

    assert [s["sector"] for s in mix] == ["Banks", "Mining"]
    assert mix[0]["weight_pct"] == 90.0 and mix[0]["count"] == 1
    assert mix[1]["weight_pct"] == 10.0 and mix[1]["count"] == 2
    assert mix[1]["change_pct"] == pytest.approx(3.0)     # equal caps, so the mean


def test_sector_mix_is_empty_without_a_cap_total(monkeypatch):
    assert ip._sector_mix([{"sector": "Banks", "market_cap_usd": 10, "change_pct": 1.0}], None) == []


def test_unavailable_index_explains_itself(monkeypatch):
    monkeypatch.setattr(ip, "_load", lambda: {"indices": {"^RUT": {"unavailable": "2,000 members, no free list."}}})
    out = ip.index_profile.__wrapped__("^RUT")
    assert out == {"available": False, "reason": "2,000 members, no free list."}


def test_non_index_gets_no_constituent_section_at_all(monkeypatch):
    """Gold and EUR/USD run through the same endpoint. Telling them they have
    no members answers a question the reader never asked, so the payload stays
    silent and the panel renders nothing."""
    monkeypatch.setattr(ip, "_load", lambda: {"indices": {}})
    assert ip.index_profile.__wrapped__("GC=F") == {"available": False}


def test_stats_ladder_and_range(monkeypatch):
    # 400 sessions rising 1 -> 400 so every window has a base and the last price
    # is the 52-week high.
    index = pd.bdate_range(end=dt.date.today(), periods=400)
    px = pd.Series(range(1, 401), index=index, dtype=float)
    bench = pd.Series(range(1, 401), index=index, dtype=float)
    frame = pd.concat({"Close": pd.DataFrame({"^X": px, "^GSPC": bench})}, axis=1)
    monkeypatch.setattr(ip, "get_download", lambda *a, **k: frame)

    out = ip.asset_stats("^X")

    assert out["last"] == 400.0
    assert out["range_52w"]["position_pct"] == 100.0
    assert out["range_52w"]["from_high_pct"] == 0.0
    assert out["returns"]["1w"] > 0
    # A perfectly co-moving series is beta 1 to itself.
    assert out["vs_benchmark"]["correlation"] == pytest.approx(1.0, abs=0.01)


def test_stats_absolute_changes_track_returns(monkeypatch):
    """Yields render basis points off `changes_abs`, so it has to agree with the
    percentage it sits beside."""
    index = pd.bdate_range(end=dt.date.today(), periods=300)
    px = pd.Series([4.0] * 299 + [4.5], index=index)
    frame = pd.concat({"Close": pd.DataFrame({"^TNX": px})}, axis=1)
    monkeypatch.setattr(ip, "get_download", lambda *a, **k: frame)

    out = ip.asset_stats("^TNX", benchmark="^TNX")

    assert out["changes_abs"]["1m"] == pytest.approx(0.5)
    assert out["returns"]["1m"] == pytest.approx(12.5)


def test_benchmark_against_itself_has_no_beta_row(monkeypatch):
    index = pd.bdate_range(end=dt.date.today(), periods=300)
    frame = pd.concat({"Close": pd.DataFrame({"^GSPC": pd.Series(range(1, 301), index=index, dtype=float)})}, axis=1)
    monkeypatch.setattr(ip, "get_download", lambda *a, **k: frame)

    assert ip.asset_stats("^GSPC")["vs_benchmark"] is None


def test_empty_download_returns_nothing_rather_than_raising(monkeypatch):
    monkeypatch.setattr(ip, "get_download", lambda *a, **k: pd.DataFrame())
    assert ip.asset_stats("^X") == {}


def test_shipped_constituent_file_is_sane():
    """The data asset itself. A member without a ticker, or an index claiming a
    weighting scheme the API does not know, breaks the panel quietly."""
    data = ip._load()
    indices = data.get("indices", {})
    assert len(indices) >= 15
    tracked = {k: v for k, v in indices.items() if "members" in v}
    assert len(tracked) >= 15
    for symbol, entry in tracked.items():
        assert entry["weighting"] in ("cap", "price"), symbol
        assert entry["members"], symbol
        assert entry.get("currency"), symbol
        for member in entry["members"]:
            assert member["ticker"] and member["name"], symbol
            assert member.get("shares") is None or member["shares"] > 0, member["ticker"]
    # Sector tagging is best effort per source, but it has to have worked
    # somewhere or the mix panel is dead weight on every screen.
    tagged = sum(1 for e in tracked.values() for m in e["members"] if m.get("sector"))
    total = sum(len(e["members"]) for e in tracked.values())
    assert tagged / total > 0.9, f"only {tagged}/{total} members carry a sector"
