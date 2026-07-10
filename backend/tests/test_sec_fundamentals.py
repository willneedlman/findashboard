"""Tests for the SEC EDGAR companyfacts fundamentals parser (sec_fundamentals).

Locks the XBRL→FMP-field mapping: concept-synonym resolution, annual-only period
filtering, latest-restatement wins, composed totalDebt, the _sane guard, and the
SEC-vs-FMP source selection. Network-free (facts + CIK lookup are stubbed).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import sec_fundamentals as m  # noqa: E402


def _usd(*facts):
    return {"units": {"USD": list(facts)}, "label": ""}


def _shares(*facts):
    return {"units": {"shares": list(facts)}, "label": ""}


def _annual(fy, val, start, end, form="10-K"):
    return {"fy": fy, "fp": "FY", "form": form, "start": start, "end": end, "val": val}


def _instant(fy, val, end, form="10-K"):
    return {"fy": fy, "fp": "FY", "form": form, "end": end, "val": val}


def test_concept_synonym_resolution_prefers_first_present():
    # First synonym absent, second present -> second is used.
    us = {"Revenues": _usd(_annual(2024, 500.0, "2023-10-01", "2024-09-28"))}
    got = m._annual_map(us, m._INCOME["revenue"], want_shares=False, instant=False)
    assert got == {2024: 500.0}


def test_annual_filter_drops_quarterly_durations():
    # A 90-day period must be ignored; only the ~365-day fact survives.
    us = {"Revenues": _usd(
        _annual(2024, 120.0, "2024-07-01", "2024-09-28"),   # ~90d quarter -> dropped
        _annual(2024, 500.0, "2023-10-01", "2024-09-28"),   # ~annual -> kept
    )}
    assert m._annual_map(us, ["Revenues"], want_shares=False, instant=False) == {2024: 500.0}


def test_latest_restatement_wins():
    us = {"Revenues": _usd(
        _annual(2024, 480.0, "2023-10-01", "2024-09-28"),   # original
        _annual(2024, 500.0, "2023-10-01", "2024-09-30"),   # later end -> restatement wins
    )}
    assert m._annual_map(us, ["Revenues"], want_shares=False, instant=False) == {2024: 500.0}


def test_non_10k_and_non_fy_ignored():
    us = {"Revenues": _usd(
        {"fy": 2024, "fp": "Q3", "form": "10-Q", "start": "2024-07-01", "end": "2024-09-28", "val": 9.0},
        _annual(2024, 500.0, "2023-10-01", "2024-09-28"),
    )}
    assert m._annual_map(us, ["Revenues"], want_shares=False, instant=False) == {2024: 500.0}


def _apple_like_facts():
    return {
        "RevenueFromContractWithCustomerExcludingAssessedTax": _usd(
            _annual(2024, 391.0, "2023-10-01", "2024-09-28"),
            _annual(2023, 383.0, "2022-10-02", "2023-09-30")),
        "OperatingIncomeLoss": _usd(_annual(2024, 123.0, "2023-10-01", "2024-09-28")),
        "WeightedAverageNumberOfDilutedSharesOutstanding": _shares(
            _annual(2024, 15408.0, "2023-10-01", "2024-09-28")),
        "IncomeTaxExpenseBenefit": _usd(_annual(2024, 29.0, "2023-10-01", "2024-09-28")),
        "CashAndCashEquivalentsAtCarryingValue": _usd(_instant(2024, 29.9, "2024-09-28")),
        "StockholdersEquity": _usd(_instant(2024, 57.0, "2024-09-28")),
        "LongTermDebtNoncurrent": _usd(_instant(2024, 85.0, "2024-09-28")),
        "LongTermDebtCurrent": _usd(_instant(2024, 10.0, "2024-09-28")),
        "PaymentsToAcquirePropertyPlantAndEquipment": _usd(_annual(2024, 9.4, "2023-10-01", "2024-09-28")),
        "DepreciationDepletionAndAmortization": _usd(_annual(2024, 11.4, "2023-10-01", "2024-09-28")),
    }


def test_build_maps_to_fmp_field_names(monkeypatch):
    monkeypatch.setattr(m, "_fetch_facts", lambda sym: _apple_like_facts())
    b = m._build("AAPL")
    assert b is not None
    assert len(b["income"]) == 2                       # 2 fiscal years, latest first
    assert b["income"][0]["revenue"] == 391.0
    assert b["income"][1]["revenue"] == 383.0
    assert b["income"][0]["weightedAverageShsOutDil"] == 15408.0
    # totalDebt is composed from long-term + current portions.
    assert b["balance"]["totalDebt"] == 95.0
    assert b["balance"]["cashAndCashEquivalents"] == 29.9
    assert "netDebt" not in b["balance"]               # SEC has no netDebt tag
    assert b["cashflow"]["capitalExpenditure"] == 9.4
    assert b["cashflow"]["changeInWorkingCapital"] is None  # rarely tagged -> absent


def _sane_bundle(**income_over):
    inc = {"revenue": 100.0, "weightedAverageShsOutDil": 10.0, "operatingIncome": 20.0}
    inc.update(income_over)
    return {"income": [inc],
            "cashflow": {"capitalExpenditure": 5.0, "depreciationAndAmortization": 4.0}}


def test_sane_guard_requires_all_dcf_drivers():
    assert m._sane(_sane_bundle()) is True
    # revenue / shares
    assert m._sane(_sane_bundle(revenue=0)) is False
    assert m._sane(_sane_bundle(weightedAverageShsOutDil=None)) is False
    # a bank-style filer: revenue+shares present but NO operating income -> must miss
    assert m._sane(_sane_bundle(operatingIncome=None)) is False
    # missing capex / D&A -> must miss (would zero out reinvestment in the DCF)
    b = _sane_bundle(); b["cashflow"]["capitalExpenditure"] = None
    assert m._sane(b) is False
    b = _sane_bundle(); b["cashflow"]["depreciationAndAmortization"] = None
    assert m._sane(b) is False
    assert m._sane({"income": []}) is False
    assert m._sane(None) is False


def test_statements_available_false_when_no_facts(monkeypatch):
    monkeypatch.setattr(m, "_fetch_facts", lambda sym: None)
    monkeypatch.setattr(m, "disk_get", lambda k: None)
    monkeypatch.setattr(m, "disk_set", lambda k, v, ttl=0: None)
    assert m.statements_available("NOPE") is False
