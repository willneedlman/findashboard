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


def test_sane_guard_requires_the_income_core():
    assert m._sane(_sane_bundle()) is True
    # revenue / shares
    assert m._sane(_sane_bundle(revenue=0)) is False
    assert m._sane(_sane_bundle(weightedAverageShsOutDil=None)) is False
    # a bank-style filer: revenue+shares present but NO operating income -> must miss
    assert m._sane(_sane_bundle(operatingIncome=None)) is False
    assert m._sane({"income": []}) is False
    assert m._sane(None) is False


def test_missing_cashflow_line_keeps_the_bundle():
    """Capex and D&A are topped up from FMP per field. Rejecting the whole bundle
    over one untagged cash-flow line threw away a good share count too, and when
    FMP was quota-dry that fell through to a fabricated 100M-share placeholder."""
    b = _sane_bundle(); b["cashflow"]["capitalExpenditure"] = None
    assert m._sane(b) is True
    b = _sane_bundle(); b["cashflow"]["depreciationAndAmortization"] = None
    assert m._sane(b) is True


def test_da_composed_when_no_combined_tag(monkeypatch):
    """Microsoft never tags a combined D&A line — it reports Depreciation and
    AmortizationOfIntangibleAssets separately, which must be added."""
    facts = {
        "Revenues": _usd(_annual(2026, 331.8, "2025-07-01", "2026-06-30")),
        "OperatingIncomeLoss": _usd(_annual(2026, 155.2, "2025-07-01", "2026-06-30")),
        "WeightedAverageNumberOfDilutedSharesOutstanding":
            _shares(_annual(2026, 7453.0, "2025-07-01", "2026-06-30")),
        "Depreciation": _usd(_annual(2026, 34.3, "2025-07-01", "2026-06-30")),
        "AmortizationOfIntangibleAssets": _usd(_annual(2026, 4.7, "2025-07-01", "2026-06-30")),
    }
    monkeypatch.setattr(m, "_fetch_facts", lambda sym: facts)
    b = m._build("MSFT")
    assert b["cashflow"]["depreciationAndAmortization"] == 39.0


def test_annual_map_merges_across_tag_switches(monkeypatch):
    """Nvidia stopped tagging RevenueFromContractWithCustomer... after FY2022 and
    moved to Revenues. Taking the first synonym with any data froze revenue in
    2022 and, with it, a pre-split share count."""
    facts = {
        "RevenueFromContractWithCustomerExcludingAssessedTax": _usd(
            _annual(2021, 16.7, "2020-01-27", "2021-01-31"),
            _annual(2022, 26.9, "2021-02-01", "2022-01-30")),
        "Revenues": _usd(
            _annual(2025, 130.5, "2024-01-29", "2025-01-26"),
            _annual(2026, 215.9, "2025-01-27", "2026-01-25")),
    }
    got = m._annual_map(facts, m._INCOME["revenue"], False, instant=False)
    assert got[2022] == 26.9        # earlier-listed synonym wins where it has data
    assert got[2026] == 215.9       # later synonym fills the years it does not
    assert max(got) == 2026


def test_statements_available_false_when_no_facts(monkeypatch):
    monkeypatch.setattr(m, "_fetch_facts", lambda sym: None)
    monkeypatch.setattr(m, "disk_get", lambda k: None)
    monkeypatch.setattr(m, "disk_set", lambda k, v, ttl=0: None)
    assert m.statements_available("NOPE") is False
