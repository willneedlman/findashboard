import datetime as dt
import os
import sys

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from main import app
from market_hours import is_market_open, is_overnight_session, session_label, session_status

client = TestClient(app)


def eastern(year: int, month: int, day: int, hour: int, minute: int = 0) -> dt.datetime:
    return dt.datetime(year, month, day, hour, minute, tzinfo=dt.timezone(dt.timedelta(hours=-4)))


def test_regular_holiday_and_early_close_sessions():
    assert is_market_open(eastern(2026, 7, 2, 10))
    assert session_label(eastern(2026, 7, 3, 10)) == "holiday"
    assert not is_market_open(eastern(2026, 7, 3, 10))
    assert session_label(eastern(2026, 11, 27, 12)) == "regular"
    assert session_label(eastern(2026, 11, 27, 14)) == "after-hours"


def test_observed_new_year_can_fall_in_prior_calendar_year():
    assert session_label(eastern(2021, 12, 31, 11)) == "holiday"
    assert not is_market_open(eastern(2021, 12, 31, 11))


def test_overnight_session_observes_245_window_and_holidays():
    assert is_overnight_session(eastern(2026, 8, 2, 20, 1))  # Sunday evening
    assert session_label(eastern(2026, 8, 3, 1, 0)) == "closed"  # No Monday overnight
    assert is_overnight_session(eastern(2026, 8, 4, 1, 0))  # Monday night into Tuesday
    assert not is_overnight_session(eastern(2026, 7, 2, 21, 0))  # Friday holiday follows


def test_session_status_exposes_holiday_metadata():
    status = session_status(eastern(2026, 12, 25, 11))
    assert status["label"] == "holiday"
    assert status["holiday"] == "Christmas Day"
    assert status["is_open"] is False


def test_market_session_endpoint_contract():
    response = client.get("/api/market/session")
    assert response.status_code == 200
    assert {"label", "is_open", "holiday", "early_close", "as_of", "timezone"} <= response.json().keys()
