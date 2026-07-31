import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import ai


def test_screener_parse_normalizes_free_model_output(monkeypatch):
    model_output = {
        "filters": [
            {"field": "Revenue Growth YoY (%)", "operator": ">", "value": "15%", "value2": None},
            {"field": "marketCap", "operator": "range", "value": "$2B", "value2": "$10B"},
        ],
        "sector": "Financials",
        "universe": "S&P 500",
        "exchange": "nasdaq",
        "region": "north america",
        "sort_by": "P/E Ratio",
        "sort_dir": "ASC",
        "sort_param": "1M",
        "limit": 500,
        "explanation": "  Find growing financial companies.  ",
    }
    monkeypatch.setattr(ai, "groq_complete", lambda *args, **kwargs: json.dumps(model_output))

    result = ai.screener_parse(ai.ScreenerParseRequest(query="Growing financial stocks"))

    assert result["valid"] is True
    assert result["warning"] is None
    assert result["dropped_filter_count"] == 0
    assert result["filters"] == [
        {
            "field": "revenueGrowth",
            "operator": "gt",
            "value": 15.0,
            "value2": None,
            "param": None,
        },
        {
            "field": "marketCap",
            "operator": "between",
            "value": 2.0,
            "value2": 10.0,
            "param": None,
        },
    ]
    assert result["sector"] == "Financial Services"
    assert result["universe"] == "sp500"
    assert result["exchange"] == "NASDAQ"
    assert result["region"] == "North America"
    assert result["sort_by"] == "peRatio"
    assert result["sort_dir"] == "asc"
    assert result["sort_param"] is None
    assert result["limit"] == 50
    assert result["explanation"] == "Find growing financial companies."


def test_screener_parse_marks_unmapped_criteria_invalid(monkeypatch):
    monkeypatch.setattr(ai, "groq_complete", lambda *args, **kwargs: json.dumps({
        "filters": [{"field": "magicScore", "operator": "gt", "value": 90}],
        "sort_by": "marketCap",
        "sort_dir": "desc",
        "limit": "not-a-number",
    }))

    result = ai.screener_parse(ai.ScreenerParseRequest(query="Find large companies"))

    assert result["sort_by"] == "marketCap"
    assert result["sort_dir"] == "desc"
    assert result["limit"] == 8
    assert result["valid"] is False
    assert result["accepted_filter_count"] == 0
    assert result["dropped_filter_count"] == 1
    assert "could not be mapped" in result["warning"]
    assert result["explanation"]


def test_screener_parse_repairs_named_company_and_peer_group(monkeypatch):
    model_output = {
        "filters": [
            {"field": "companyName", "operator": "contains", "value": "JPMorgan"},
        ],
        "sector": None,
        "universe": None,
        "exchange": None,
        "region": None,
        "sort_by": "marketCap",
        "sort_dir": "desc",
        "sort_param": None,
        "limit": 8,
        "include_symbols": [],
        "explanation": "Large-cap financial services companies and banks",
    }
    monkeypatch.setattr(ai, "groq_complete", lambda *args, **kwargs: json.dumps(model_output))

    result = ai.screener_parse(ai.ScreenerParseRequest(
        query="JPMorgan and other financial services companies and banks",
    ))

    assert result["valid"] is True
    assert result["warning"] is None
    assert result["include_symbols"] == ["JPM"]
    assert result["sector"] == "Financial Services"
    assert result["filters"] == []
    assert result["dropped_filter_count"] == 0


def test_screener_parse_repairs_major_american_banks_schema_literals(monkeypatch):
    monkeypatch.setattr(
        ai,
        "groq_complete",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("recognized screen must bypass the LLM")),
    )

    result = ai.screener_parse(ai.ScreenerParseRequest(query="Major american banks"))

    assert result["valid"] is True
    assert result["warning"] is None
    assert result["filters"] == []
    assert result["dropped_filter_count"] == 0
    assert result["sector"] == "Financial Services"
    assert result["universe"] == "sp500"
    assert result["exchange"] is None
    assert result["region"] == "North America"
    assert result["sort_by"] == "marketCap"
    assert result["sort_dir"] == "desc"
    assert result["include_symbols"] == ["JPM", "BAC", "WFC", "C", "USB", "PNC", "TFC", "BK"]


def test_screener_parse_treats_multiple_known_exchanges_as_no_exchange_filter(monkeypatch):
    monkeypatch.setattr(ai, "groq_complete", lambda *args, **kwargs: json.dumps({
        "filters": [],
        "sector": "Technology",
        "universe": "sp500",
        "exchange": "NASDAQ, NYSE",
        "region": "North America",
        "sort_by": "marketCap",
        "sort_dir": "desc",
        "limit": 8,
        "include_symbols": [],
        "explanation": "Large American technology companies.",
    }))

    result = ai.screener_parse(ai.ScreenerParseRequest(query="Large American technology companies"))

    assert result["valid"] is True
    assert result["exchange"] is None
    assert result["warning"] is None
