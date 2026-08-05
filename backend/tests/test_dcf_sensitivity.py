import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import ai, dcf


def _request():
    return dcf.DCFRequest(
        ticker="AAPL",
        revenue=100_000,
        op_margin=25,
        target_margin=28,
        shares=1_000,
        net_debt=5_000,
        tax_rate=21,
        stages=[
            dcf.Stage(years=3, growth=12),
            dcf.Stage(years=4, growth=8),
            dcf.Stage(years=3, growth=4),
        ],
        capex=dcf.Curve(start_pct=5, end_pct=4),
        da=dcf.Curve(start_pct=4, end_pct=3.5),
        wc=dcf.Curve(start_pct=0.5, end_pct=0.25),
        terminal_growth=2.5,
        wacc=9,
    )


def test_forward_dcf_returns_multiple_two_way_sensitivity_tables():
    result = dcf.dcf_value(_request())

    assert [table["id"] for table in result["sensitivity_tables"]] == [
        "growth_margin", "wacc_terminal", "growth_wacc", "margin_wacc", "growth_conversion",
    ]
    for table in result["sensitivity_tables"]:
        assert len(table["row_driver"]["values"]) == 5
        assert len(table["column_driver"]["values"]) == 5
        assert len(table["values"]) == 5
        assert all(len(row) == 5 for row in table["values"])

    growth_margin = result["sensitivity_tables"][0]
    assert growth_margin["values"][2][2] == result["intrinsic_per_share"]
    assert growth_margin["values"][0][0] < growth_margin["values"][4][4]


def test_growth_schedule_shift_hits_requested_cagr():
    stages = _request().stages
    shifted = dcf._stages_for_cagr(stages, 15.0)

    assert abs(dcf._schedule_cagr(shifted) - 15.0) < 0.001
    assert shifted[0].growth - shifted[1].growth == stages[0].growth - stages[1].growth


def test_cash_conversion_factor_scales_fcf_and_valuation():
    base = _request()
    converted = base.model_copy(update={"fcf_conversion_pct": 120})

    base_result = dcf.dcf_value(base)
    converted_result = dcf.dcf_value(converted)

    assert converted_result["fcfs"][0]["fcf"] > base_result["fcfs"][0]["fcf"]
    assert converted_result["intrinsic_per_share"] > base_result["intrinsic_per_share"]
    assert converted_result["fcf_conversion_pct"] == 120


def test_custom_growth_and_margin_sensitivity_ranges_are_respected():
    request = _request().model_copy(update={
        "sensitivity_growth_low": 20,
        "sensitivity_growth_high": 50,
        "sensitivity_margin_low": 25,
        "sensitivity_margin_high": 45,
    })

    result = dcf.dcf_value(request)
    growth_margin = result["sensitivity_tables"][0]

    assert growth_margin["column_driver"]["values"] == [20, 27.5, 35, 42.5, 50]
    assert growth_margin["row_driver"]["values"] == [25, 30, 35, 40, 45]


def test_forward_dcf_reports_market_implied_growth_and_margin():
    request = _request()
    intrinsic = dcf.dcf_value(request)["intrinsic_per_share"]
    result = dcf.dcf_value(request.model_copy(update={"market_price": intrinsic}))

    market = result["market_implied"]
    assert abs(market["implied_revenue_cagr"] - result["modeled_revenue_cagr"]) < 0.02
    assert abs(market["implied_target_margin"] - request.target_margin) < 0.02
    assert market["implied_terminal_revenue"] > request.revenue


def test_tornado_sensitivity_preserves_finite_discount_spread():
    request = _request().model_copy(update={"wacc": 3.5, "terminal_growth": 2.5})

    result = dcf.dcf_value(request)

    assert result["intrinsic_per_share"] > 0
    assert all(row["lo"] == row["lo"] and row["hi"] == row["hi"] for row in result["tornado"])


def test_dcf_ai_prompt_contains_latest_statement_and_returns_thesis(monkeypatch):
    statement = {
        "ticker": "AAPL",
        "source": "SEC EDGAR 10-Q",
        "period": "Q3 ended 2026-06-30",
        "comparison_period": "Q3 ended 2025-06-30",
        "income": {"revenue_m": 100, "revenue_growth_pct": 8, "operating_margin_pct": 30},
        "balance_sheet": {"net_debt_m": -20},
        "cash_flow": {"free_cash_flow_m": 25},
    }
    captured = {}
    model_output = {
        "rev_growth_1": 9, "rev_growth_2": 6, "rev_growth_3": 4,
        "target_margin": 31, "wacc": 8.5, "terminal_growth": 2.5,
        "rationale": {"growth": "g", "margin": "m", "wacc": "w"},
        "thesis": {
            "stance": "constructive", "summary": "Grounded summary",
            "evidence": ["Revenue grew 8%"], "risks": ["Growth slows"],
            "watch_items": ["Operating margin"],
        },
    }
    def complete(prompt, **kwargs):
        captured["prompt"] = prompt
        return json.dumps(model_output)

    monkeypatch.setattr(ai.fmp, "get_dcf_statement_context", lambda ticker: statement)
    monkeypatch.setattr(ai, "groq_complete", complete)
    monkeypatch.setattr(ai, "disk_get", lambda key: None)
    monkeypatch.setattr(ai, "disk_set", lambda *args, **kwargs: None)

    result = ai.dcf_assumptions(ai.DCFAssumptionsRequest(ticker="AAPL"))

    assert "SEC EDGAR 10-Q" in captured["prompt"]
    assert "Q3 ended 2026" in captured["prompt"]
    assert result["thesis"]["stance"] == "constructive"
    assert result["statement_context"] == statement
    assert result["cache_meta"]["cached"] is False


def test_dcf_ai_reuses_cached_stock_analysis_and_regenerate_bypasses_it(monkeypatch):
    statement = {"ticker": "AAPL", "source": "SEC", "period": "Q3", "income": {"revenue_m": 100}}
    stored = {}
    calls = []
    model_output = {
        "rev_growth_1": 9, "rev_growth_2": 6, "rev_growth_3": 4,
        "target_margin": 30, "wacc": 9, "terminal_growth": 2.5,
        "rationale": {"growth": "g", "margin": "m", "wacc": "w"},
        "thesis": {"stance": "balanced", "summary": "s", "evidence": ["e"], "risks": ["r"], "watch_items": ["w"]},
    }

    def complete(*args, **kwargs):
        calls.append(1)
        return json.dumps(model_output)

    monkeypatch.setattr(ai.fmp, "get_dcf_statement_context", lambda ticker: statement)
    monkeypatch.setattr(ai, "groq_complete", complete)
    monkeypatch.setattr(ai, "disk_get", lambda key: stored.get(key))
    monkeypatch.setattr(ai, "disk_set", lambda key, value, ttl: stored.__setitem__(key, value))

    first = ai.dcf_assumptions(ai.DCFAssumptionsRequest(ticker="AAPL"))
    second = ai.dcf_assumptions(ai.DCFAssumptionsRequest(ticker="AAPL"))
    regenerated = ai.dcf_assumptions(ai.DCFAssumptionsRequest(ticker="AAPL", regenerate=True))

    assert len(calls) == 2
    assert first["cache_meta"]["cached"] is False
    assert second["cache_meta"]["cached"] is True
    assert regenerated["cache_meta"]["cached"] is False
