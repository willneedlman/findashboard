import pytest
from fastapi.testclient import TestClient
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from main import app

client = TestClient(app)


def test_get_corporate_hub_insider_lseg():
    # Test LSEG data path for a mock covered ticker (AAPL)
    response = client.get("/api/corporate/hub/insider?ticker=AAPL")
    assert response.status_code == 200
    data = response.json()
    assert data["ticker"] == "AAPL"
    assert data["source"] == "LSEG"
    assert len(data["transactions"]) > 0
    assert "average_returns" in data
    assert "passive_pct" in data
    assert "active_pct" in data
    
    # Check that a transaction contains the LSEG keys
    first_tx = data["transactions"][0]
    assert "is_10b51" in first_tx
    assert "is_form144" in first_tx
    assert "is_amendment" in first_tx


def test_get_corporate_hub_insider_fallback():
    # Test fallback path for a non-covered ticker (ZZZZZ)
    response = client.get("/api/corporate/hub/insider?ticker=ZZZZZ")
    assert response.status_code == 200
    data = response.json()
    assert data["ticker"] == "ZZZZZ"
    assert data["source"] == "yfinance"
    assert data["transactions"] == []


def test_get_institutional_ownership_lseg():
    # AAPL: the LSEG export has no per-holder identity for institutional
    # holdings (only a security-level ownership rollup), so real named
    # holders come from yfinance; LSEG's passive/active split is merged in
    # separately when available.
    response = client.get("/api/corporate/institutional?ticker=AAPL")
    assert response.status_code == 200
    data = response.json()
    assert data["ticker"] == "AAPL"
    assert data["source"] == "yfinance"
    assert "passive_pct" in data
    assert "active_pct" in data
    assert len(data["holders"]) > 0

    # Regression guard: a prior bug read the security's own name (from a
    # security-level rollup file) as if it were the holder's name, so every
    # row came back mislabeled "APPLE INC" instead of a real institution.
    for h in data["holders"]:
        assert h["holder"] != "APPLE INC"


def test_get_institutional_ownership_fallback():
    # Test institutional endpoint fallback (ZZZZZ)
    response = client.get("/api/corporate/institutional?ticker=ZZZZZ")
    assert response.status_code == 200
    data = response.json()
    assert data["ticker"] == "ZZZZZ"
    assert data["source"] == "yfinance"
    assert data["holders"] == []
    assert data["funds"] == []


def test_get_sdc_deals():
    # Test SDC deals endpoint for AAPL (acquirer side)
    response = client.get("/api/corporate/deals?ticker=AAPL")
    assert response.status_code == 200
    data = response.json()
    assert data["ticker"] == "AAPL"
    assert data["source"] == "SDC"
    assert len(data["deals"]) > 0
    deal = data["deals"][0]
    assert deal["acquirer_ticker"] == "AAPL" or deal["target_ticker"] == "AAPL"
    assert deal["role"] == "acquirer"

    # Test SDC deals endpoint for ORCL (target side)
    response = client.get("/api/corporate/deals?ticker=ORCL")
    assert response.status_code == 200
    data = response.json()
    assert data["ticker"] == "ORCL"
    assert data["source"] == "SDC"
    assert len(data["deals"]) > 0
    target_deals = [d for d in data["deals"] if d["role"] == "target"]
    assert len(target_deals) > 0
    deal = target_deals[0]
    assert deal["target_ticker"] == "ORCL"
