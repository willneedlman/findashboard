"""Accrual of the analyst-estimate series.

No free source carries a dense history of where consensus has been, so the
series accrues one point per day. Alpha Vantage publishes four lookback
figures per row, which seed the first quarter of it; everything after that is
observed. The rules that matter are that a reconstructed point never
overwrites an observed one, and that a reconstruction is labelled as one.
"""
import os
import sys
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from main import app
import routers.snapshots as snaps

client = TestClient(app)

_AV_ROWS = [
    {"date": "2026-09-30", "horizon": "fiscal year",
     "eps_estimate_average": "8.80", "revenue_estimate_average": "477000000000",
     "eps_estimate_analyst_count": "38",
     "eps_estimate_average_7_days_ago": "8.79", "eps_estimate_average_30_days_ago": "8.76",
     "eps_estimate_average_60_days_ago": "8.75", "eps_estimate_average_90_days_ago": "8.74"},
    {"date": "2027-09-30", "horizon": "fiscal year",
     "eps_estimate_average": "9.53", "revenue_estimate_average": "524000000000",
     "eps_estimate_analyst_count": "40",
     "eps_estimate_average_7_days_ago": "9.55", "eps_estimate_average_30_days_ago": "9.71",
     "eps_estimate_average_60_days_ago": "9.67", "eps_estimate_average_90_days_ago": "9.65"},
    {"date": "2026-12-31", "horizon": "quarter", "eps_estimate_average": "2.91"},
]

_SYM = "ZZTEST"


@pytest.fixture
def store(monkeypatch):
    saved: dict[str, object] = {}
    monkeypatch.setattr(snaps, "disk_get", lambda k: saved.get(k))
    monkeypatch.setattr(snaps, "disk_set", lambda k, v, ttl=0: saved.__setitem__(k, v))
    monkeypatch.setattr(snaps, "_av_fiscal_years",
                        lambda s: [r for r in _AV_ROWS if r["horizon"] == "fiscal year"])
    return saved


def test_seeding_opens_the_series_with_a_quarter_of_history(store):
    r = client.get(f"/api/snapshots/series?kind=est&ticker={_SYM}")
    assert r.status_code == 200
    d = r.json()
    assert d["fiscal_years"] == ["2026", "2027"]
    # Four lookbacks plus today.
    assert len(d["series"]["2026"]) == 5
    days = [p["d"] for p in d["series"]["2026"]]
    assert days == sorted(days)
    assert days[-1] == date.today().isoformat()
    assert days[0] == (date.today() - timedelta(days=90)).isoformat()


def test_a_reconstruction_says_so_and_carries_eps_only(store):
    d = client.get(f"/api/snapshots/series?kind=est&ticker={_SYM}").json()
    older, today = d["series"]["2027"][0], d["series"]["2027"][-1]
    assert older["reconstructed"] is True
    assert older["eps"] == 9.65
    # Revenue has no published history, so it is absent rather than backfilled
    # with today's number.
    assert "rev" not in older
    assert "reconstructed" not in today
    assert today["rev"] == 524_000_000_000
    assert today["n"] == 40


def test_an_observed_point_is_never_overwritten_by_a_reconstruction(store):
    day = (date.today() - timedelta(days=30)).isoformat()
    snaps.record_point("est", _SYM, {"fy": {"2026": {"eps": 1.23, "rev": 5.0}}}, day=day)
    snaps.seed_est(_SYM)
    kept = [p for p in snaps.get_points("est", _SYM) if p["d"] == day]
    assert len(kept) == 1
    assert kept[0]["fy"]["2026"]["eps"] == 1.23
    assert "src" not in kept[0]


def test_the_daily_pass_leaves_estimates_alone(store):
    # Each estimate costs an Alpha Vantage call against a 25/day tier, so the
    # core loop must not walk sixty tickers through it.
    import inspect
    src = inspect.getsource(snaps._run_loop)
    assert 'for kind in ("gex", "iv30")' in src
    assert "est" not in src.split("for kind in")[1].split("\n")[0]
