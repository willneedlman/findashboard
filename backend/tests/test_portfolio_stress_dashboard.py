import os
import sys

import pandas as pd
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import app
import admin_auth
from routers import portfolio

client = TestClient(app)


def test_stress_test_requires_admin_and_still_serves_the_admin_tool(monkeypatch):
    dates = pd.to_datetime(["2020-02-19", "2020-03-23"])
    prices = pd.DataFrame(
        {
            ("Close", "AAPL"): [100.0, 80.0],
            ("Close", "SPY"): [100.0, 70.0],
        },
        index=dates,
    )
    prices.columns = pd.MultiIndex.from_tuples(prices.columns)
    monkeypatch.setattr(portfolio, "get_download", lambda *args, **kwargs: prices)

    payload = {
        "holdings": [{"ticker": "AAPL", "weight": 1}],
        "scenarios": ["covid"],
    }
    assert client.post("/api/portfolio/stress-test", json=payload).status_code == 403

    monkeypatch.setattr(admin_auth, "_ADMIN_SECRET", "test-secret")
    response = client.post(
        "/api/portfolio/stress-test",
        json=payload,
        headers={"x-admin-secret": "test-secret"},
    )

    assert response.status_code == 200
    scenario = response.json()["results"][0]
    assert scenario["key"] == "covid"
    assert scenario["portfolio_return"] == -20.0
    assert scenario["spy_return"] == -30.0
