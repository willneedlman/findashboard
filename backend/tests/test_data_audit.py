"""Tests for the Data Audit module.

The reconciliation engine is pure (no network/DB/clock — `now` is injected), so
its verdicts are fully unit-testable. A second block drives run_audit_once with
fake fetchers against a temp SQLite db to lock the persist / filter / resolve
path without touching any provider.
"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from data_audit_engine import (  # noqa: E402
    SourceReading, reconcile, run_summary, worst_status,
    STATUS_OK, STATUS_STALE, STATUS_OUTLIER, STATUS_CONFLICT, STATUS_ERROR,
)

NOW = 1_700_000_000.0


def _r(source, value, fetched_at=NOW, error=None):
    return SourceReading(source=source, value=value, fetched_at=fetched_at, error=error)


def _reconcile(readings, **kw):
    kw.setdefault("variance_pct", 0.5)
    kw.setdefault("outlier_pct", 2.0)
    kw.setdefault("default_ttl", 3600)
    kw.setdefault("now", NOW)
    return reconcile("AAPL", "price", readings, **kw)


# ── engine: status logic ──────────────────────────────────────────────────────

def test_agreeing_sources_are_ok():
    out = _reconcile([_r("yf", 100.0), _r("fmp", 100.2), _r("fh", 100.1)])
    assert out["status"] == STATUS_OK
    assert out["primaryValue"] == 100.1  # median
    assert out["spreadPct"] < 0.5


def test_divergence_beyond_variance_is_conflict():
    out = _reconcile([_r("yf", 100.0), _r("fmp", 100.0), _r("fh", 105.0)])
    assert out["status"] == STATUS_CONFLICT
    # spread = (105-100)/100 = 5%
    assert round(out["spreadPct"], 1) == 5.0
    # the 105 source deviates from the 100 median by 5% > 2% -> flagged outlier cell
    fh = next(s for s in out["sources"] if s["source"] == "fh")
    assert fh["outlier"] is True


def test_two_source_divergence_is_conflict_but_no_outlier_flag():
    # With only two sources there is no consensus to be an outlier from.
    out = _reconcile([_r("yf", 100.0), _r("fmp", 110.0)])
    assert out["status"] == STATUS_CONFLICT
    assert all(s["outlier"] is False for s in out["sources"])


def test_stale_source_when_agreeing_yields_stale_status():
    out = _reconcile(
        [_r("yf", 100.0, fetched_at=NOW - 10_000), _r("fmp", 100.1), _r("fh", 100.05)],
        default_ttl=3600,
    )
    assert out["status"] == STATUS_STALE
    yf = next(s for s in out["sources"] if s["source"] == "yf")
    assert yf["stale"] is True
    assert out["sources"][1]["stale"] is False


def test_conflict_outranks_stale():
    out = _reconcile(
        [_r("yf", 100.0, fetched_at=NOW - 10_000), _r("fmp", 100.0), _r("fh", 108.0)],
    )
    assert out["status"] == STATUS_CONFLICT  # worst-wins over the stale yf


def test_per_source_ttl_override():
    readings = [_r("yf", 100.0, fetched_at=NOW - 5000), _r("fmp", 100.1), _r("fh", 100.05)]
    # yf gets a long TTL so its 5000s-old datum is fresh; nothing else stale -> ok
    out = _reconcile(readings, ttl_by_source={"yf": 999_999}, default_ttl=3600)
    assert out["status"] == STATUS_OK


def test_missing_fetched_at_is_never_stale():
    out = _reconcile([_r("yf", 100.0, fetched_at=None), _r("fmp", 100.1, fetched_at=None)])
    assert out["status"] == STATUS_OK
    assert all(s["stale"] is False for s in out["sources"])


def test_all_missing_is_error():
    out = _reconcile([_r("yf", None, error="no data"), _r("fmp", None, error="no key")])
    assert out["status"] == STATUS_ERROR
    assert out["primaryValue"] is None
    assert out["validCount"] == 0


def test_errored_source_excluded_from_median():
    out = _reconcile([_r("yf", 100.0), _r("fmp", None, error="429"), _r("fh", 100.2)])
    assert out["validCount"] == 2
    assert out["primaryValue"] == 100.1


def test_non_finite_values_are_ignored():
    out = _reconcile([_r("yf", float("nan")), _r("fmp", 100.0), _r("fh", 100.1)])
    assert out["validCount"] == 2


def test_worst_status_precedence():
    assert worst_status([STATUS_OK, STATUS_STALE]) == STATUS_STALE
    assert worst_status([STATUS_STALE, STATUS_CONFLICT, STATUS_OK]) == STATUS_CONFLICT
    assert worst_status([STATUS_OUTLIER, STATUS_STALE]) == STATUS_OUTLIER
    assert worst_status([STATUS_CONFLICT, STATUS_ERROR]) == STATUS_ERROR
    assert worst_status([]) == STATUS_OK


def test_run_summary_counts():
    results = [
        {"status": STATUS_OK}, {"status": STATUS_OK}, {"status": STATUS_CONFLICT},
        {"status": STATUS_STALE}, {"status": STATUS_OUTLIER}, {"status": STATUS_ERROR},
    ]
    s = run_summary(results)
    assert s["total"] == 6 and s["ok"] == 2 and s["conflict"] == 1
    assert s["flagged"] == 3  # conflict + stale + outlier


# ── router: multi-domain run / persist / filter / resolve (network-free) ──────

def _fake_source(da, key, values):
    return da.AuditSource(key, lambda: True, lambda entity: {"values": values, "fetched_at": None, "error": None, "raw": dict(values)})


def test_default_config_has_all_domains():
    from routers import data_audit as da
    cfg = da._default_config()
    assert set(cfg["domains"]) == {"equity", "fx", "crypto", "macro"}
    assert cfg["interval_s"] == 21600  # 6h default respects the FMP free-tier cap
    # crypto ships with two keyless sources for real reconciliation out of the box.
    assert cfg["domains"]["crypto"]["enabled_sources"] == ["yfinance", "binance"]


def test_run_persist_and_resolve_equity_domain(tmp_path, monkeypatch):
    from routers import data_audit as da

    monkeypatch.setattr(da, "_DB_PATH", tmp_path / "audit_test.db")
    da._init_db()

    # Patch the equity domain to two fake sources over three metrics: they agree
    # on market_cap but conflict on price. fetched_at=None keeps staleness out.
    eq = da.DOMAINS["equity"]
    monkeypatch.setattr(eq, "metrics", ["price", "market_cap", "pe"])
    monkeypatch.setattr(eq, "sources", {
        "src_a": _fake_source(da, "src_a", {"price": 100.0, "market_cap": 2_000.0, "pe": 30.0}),
        "src_b": _fake_source(da, "src_b", {"price": 108.0, "market_cap": 2_001.0, "pe": 30.1}),
    })

    cfg = da._default_config()
    cfg["domains"]["equity"].update({"universe": ["AAPL"], "enabled_sources": ["src_a", "src_b"],
                                     "variance_pct": 0.5, "outlier_pct": 2.0})
    da._save_config(cfg)

    # only_domain avoids the other domains' live network fetchers.
    res = da.run_audit_once("manual", only_domain="equity")
    assert res["summary"]["total"] == 3
    assert res["summary"]["conflict"] >= 1

    price_rows = da.results(domain="equity", status="conflict", metric="price")["rows"]
    assert len(price_rows) == 1 and price_rows[0]["entity"] == "AAPL"
    assert da.results(domain="equity", status="ok", metric="market_cap")["count"] == 1
    assert da.results(domain="equity", source="src_a")["count"] == 3

    updated = da.resolve(da.ResolveBody(domain="equity", entity="AAPL", metric="price", action="override", source="src_a", note="src_a is truth"))
    assert updated["resolvedSource"] == "src_a"
    assert da.history()["rows"][0]["action"] == "override"

    da.run_audit_once("manual", only_domain="equity")   # a later run must preserve the override
    detail = da.entity_detail("equity", "AAPL", "price")
    assert detail["resolvedSource"] == "src_a"
    assert any(h["action"] == "override" for h in detail["resolutions"])


def test_single_source_domain_flags_stale_not_conflict(tmp_path, monkeypatch):
    # A one-source domain (like macro/FRED) can never "conflict" — it audits
    # freshness. An old datum flags STALE; a fresh one is OK.
    from routers import data_audit as da
    monkeypatch.setattr(da, "_DB_PATH", tmp_path / "macro_test.db")
    da._init_db()

    macro = da.DOMAINS["macro"]
    old = NOW - 10 * 86400
    monkeypatch.setattr(macro, "sources", {
        "fred": da.AuditSource("fred", lambda: True, lambda e: {"values": {"value": 3.1}, "fetched_at": old, "error": None, "raw": {}}),
    })
    cfg = da._default_config()
    cfg["domains"]["macro"].update({"universe": ["CPIAUCSL"], "enabled_sources": ["fred"], "default_ttl_s": 5 * 86400})
    da._save_config(cfg)

    da.run_audit_once("manual", only_domain="macro")
    rows = da.results(domain="macro")["rows"]
    assert len(rows) == 1
    assert rows[0]["status"] == "stale"       # 10d old vs 5d TTL, single source
    assert rows[0]["primaryValue"] == 3.1


def test_update_config_rejects_unknown_domain():
    from routers import data_audit as da
    import pytest
    with pytest.raises(da.HTTPException):
        da.update_config(da.ConfigUpdate(domain="bogus", enabled=False))
