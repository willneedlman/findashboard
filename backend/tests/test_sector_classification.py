import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import sector_classification as sectors  # noqa: E402


def test_joby_uses_evtol_classification(monkeypatch):
    monkeypatch.setattr(sectors, "disk_get", lambda _key: None)
    monkeypatch.setattr(sectors, "disk_set", lambda *_args, **_kwargs: None)

    row = sectors.classify_security("joby")

    assert row["sector"] == "Industrials"
    assert row["industry"] == "eVTOL & Advanced Air Mobility"
    assert row["classification"] == "eVTOL & Advanced Air Mobility"


def test_missing_provider_values_never_return_na(monkeypatch):
    monkeypatch.setattr(sectors, "disk_get", lambda _key: None)
    monkeypatch.setattr(sectors, "disk_set", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(sectors, "_SEED", {})
    monkeypatch.setattr(sectors.finnhub, "get_profile", lambda _ticker: {"sector": "N/A", "industry": None})
    monkeypatch.setattr(sectors.fmp, "available", lambda: False)
    monkeypatch.setattr(sectors, "get_info", lambda _ticker: {"sector": "Unknown", "industry": ""})

    row = sectors.classify_security("ZZTEST")

    assert row["sector"] == "Other Public Equity"
    assert row["industry"] == "Other Public Equity"
    assert row["classification"] == "Other Public Equity"


def test_cached_classification_skips_all_providers(monkeypatch):
    cached = {"symbol": "CACHED", "sector": "Industrials", "industry": "Aerospace", "classification": "Aerospace", "source": "cache seed"}
    monkeypatch.setattr(sectors, "disk_get", lambda _key: cached)
    monkeypatch.setattr(sectors.finnhub, "get_profile", lambda _ticker: (_ for _ in ()).throw(AssertionError("provider should not run")))

    assert sectors.classify_security("cached") == cached
