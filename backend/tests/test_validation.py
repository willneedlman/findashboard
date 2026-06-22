"""Tests for the request-validation choke point.

Every router funnels user-supplied tickers and dates through `validation`, so a
loosened regex here is a site-wide injection / bad-input surface. These lock the
accepted symbol forms and the rejection-to-HTTP-400 contract.
"""
import os
import sys

import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from validation import (  # noqa: E402
    validate_date,
    validate_ticker,
    validate_tickers,
)


@pytest.mark.parametrize("raw,expected", [
    ("aapl", "AAPL"),
    ("  msft ", "MSFT"),
    ("BRK-B", "BRK-B"),
    ("^GSPC", "^GSPC"),
    ("EURUSD=X", "EURUSD=X"),
    ("GC=F", "GC=F"),
    ("DX-Y.NYB", "DX-Y.NYB"),
])
def test_valid_tickers_normalised(raw, expected):
    assert validate_ticker(raw) == expected


@pytest.mark.parametrize("bad", ["", "   ", "A B", "DROP;TABLE", "../etc", "x" * 21])
def test_invalid_tickers_rejected(bad):
    with pytest.raises(HTTPException) as exc:
        validate_ticker(bad)
    assert exc.value.status_code == 400


def test_validate_date_accepts_iso_and_rejects_garbage():
    assert validate_date("2024-01-15") == "2024-01-15"
    for bad in ["2024/01/15", "15-01-2024", "not-a-date", "2024-13-40"]:
        with pytest.raises(HTTPException) as exc:
            validate_date(bad)
        assert exc.value.status_code == 400


def test_validate_tickers_enforces_max_count():
    assert validate_tickers(["aapl", "msft"]) == ["AAPL", "MSFT"]
    with pytest.raises(HTTPException) as exc:
        validate_tickers(["AAPL"] * 21, max_count=20)
    assert exc.value.status_code == 400
