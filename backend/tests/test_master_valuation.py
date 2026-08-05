import os
import sys

import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import routers.master_valuation as master_valuation
from routers.master_valuation import MasterValuationRequest, _default_schedule, _driver_effects, _project, _reverse, _sensitivity_tables


def request(**overrides):
    payload = {
        "ticker": "TEST",
        "revenue": 1000,
        "shares": 100,
        "net_debt": 100,
        "market_price": 30,
        "wacc": 10,
        "cost_of_equity": 11,
        "schedule": [
            {
                "year": year,
                "growth": 15 - year,
                "margin": 20 + year,
                "tax_rate": 20,
                "da_pct": 4,
                "capex_pct": 6,
                "change_nwc_pct": 2,
                "sbc_pct": 1,
                "cash_adjustment_pct": 0,
                "dilution_pct": 1,
                "payout_pct": 20,
            }
            for year in range(1, 6)
        ],
        "terminal": {
            "perpetual_growth": 3,
        },
        "multiple_targets": [
            {"metric": "ev_revenue", "multiple": 4, "weight": 50, "year": 3},
            {"metric": "ev_ebitda", "multiple": 16, "weight": 50, "year": 3},
        ],
        "sotp_segments": [
            {"name": "Platform", "revenue_share": 70, "price_to_sales_multiple": 5},
            {"name": "Services", "revenue_share": 30, "price_to_sales_multiple": 2},
        ],
        "weights": {"dcf": 50, "multiples": 25, "ddm": 10, "sotp": 15},
        "dividend_terminal_growth": 3,
    }
    payload.update(overrides)
    return MasterValuationRequest(**payload)


def test_all_methods_share_the_same_schedule():
    base = _project(request())
    faster = request()
    for row in faster.schedule:
        row.growth += 8
    changed = _project(faster)

    assert base["rows"][0]["fcf"] == pytest.approx(177.32)
    assert changed["dcf"]["value_per_share"] > base["dcf"]["value_per_share"]
    assert changed["multiples"]["value_per_share"] > base["multiples"]["value_per_share"]
    assert changed["ddm"]["value_per_share"] > base["ddm"]["value_per_share"]
    assert changed["sotp"]["value_per_share"] > base["sotp"]["value_per_share"]


def test_fundamentals_seed_business_parts_from_reported_segments(monkeypatch):
    base = {
        "revenue": 1000, "shares": 100, "net_debt": 50, "market_price": 30,
        "beta": 1, "assumptions_source": "test", "rev_growth": 8, "op_margin": 20,
        "capex_pct": 5, "da_pct": 4, "wc_pct": 1, "tax_rate": 21,
    }
    monkeypatch.setattr(master_valuation, "get_fundamentals", lambda _ticker: base)

    import routers.valuation as valuation
    import cache
    monkeypatch.setattr(valuation, "multiples", lambda _ticker: {"metrics": []})
    monkeypatch.setattr(valuation, "build_sotp_data", lambda _ticker, fundamentals_override=None: {
        "segments": [
            {"name": "Platform", "revenue": 700, "peer_ps": 6},
            {"name": "Services", "revenue": 300, "peer_ps": None},
        ],
        "suggested_multiple": 4,
        "source": "SEC 10-K",
        "fiscalYear": 2025,
    })
    monkeypatch.setattr(cache, "get_info", lambda _ticker: {})

    result = master_valuation.fundamentals("AAPL")

    assert result["business_segments"] == [
        {"name": "Platform", "revenue_share": 70, "price_to_sales_multiple": 5},
        {"name": "Services", "revenue_share": 30, "price_to_sales_multiple": 4},
    ]
    assert result["business_segments_source"] == "SEC 10-K"
    assert result["business_segments_fiscal_year"] == 2025


def test_complete_methods_reconcile_only_in_the_final_blend():
    req = request()
    result = _project(req)

    assert result["dcf"]["value_per_share"] != result["multiples"]["value_per_share"]
    total = sum(result["active_weights"].values())
    expected = sum(result["methods"][key] * weight for key, weight in result["active_weights"].items()) / total
    assert result["composite"]["value_per_share"] == pytest.approx(expected)


def test_dcf_and_multiples_are_independent_complete_methods():
    base_request = request()
    base = _project(base_request)

    richer_multiple = base_request.model_copy(deep=True)
    richer_multiple.multiple_targets[0].multiple *= 2
    multiple_change = _project(richer_multiple)
    assert multiple_change["dcf"]["value_per_share"] == pytest.approx(base["dcf"]["value_per_share"])
    assert multiple_change["multiples"]["value_per_share"] > base["multiples"]["value_per_share"]

    richer_terminal_growth = base_request.model_copy(deep=True)
    richer_terminal_growth.terminal.perpetual_growth += 1
    dcf_change = _project(richer_terminal_growth)
    assert dcf_change["dcf"]["value_per_share"] > base["dcf"]["value_per_share"]
    assert dcf_change["multiples"]["value_per_share"] == pytest.approx(base["multiples"]["value_per_share"])


def test_future_multiple_and_sotp_outputs_are_discounted_to_present():
    req = request()
    result = _project(req)
    year_three = result["rows"][2]
    expected_ev_revenue = (year_three["revenue"] * 4 / 1.1**3 - req.net_debt) / year_three["shares"]
    line = next(item for item in result["multiples"]["lines"] if item["metric"] == "ev_revenue")
    assert line["value_per_share"] == pytest.approx(expected_ev_revenue)
    assert line["effective_weight"] == pytest.approx(50)

    final = result["rows"][-1]
    weighted_segment_multiple = 5 * 0.7 + 2 * 0.3
    expected_sotp = final["revenue"] * weighted_segment_multiple / 1.1**5 / final["shares"]
    assert result["sotp"]["value_per_share"] == pytest.approx(expected_sotp)


def test_cash_conversion_factor_scales_the_annual_fcf_bridge():
    base = request()
    converted = request()
    converted.schedule[0].fcf_conversion_pct = 120
    base_result = _project(base)
    converted_result = _project(converted)
    assert converted_result["rows"][0]["fcf"] == pytest.approx(base_result["rows"][0]["fcf"] * 1.2)


def test_reverse_outputs_can_be_applied_back_to_price():
    req = request()
    base = _project(req)
    req.market_price = base["dcf"]["value_per_share"] * 1.25
    implied = _reverse(req, base)

    assert implied["implied_revenue_cagr"] is not None
    adopted = req.model_copy(deep=True)
    for row, growth in zip(adopted.schedule, implied["implied_growth_schedule"]):
        row.growth = growth
    assert _project(adopted)["dcf"]["value_per_share"] == pytest.approx(req.market_price, rel=1e-5)


def test_implied_market_multiple_solves_the_standalone_multiples_method():
    req = request()
    base = _project(req)
    implied = _reverse(req, base)
    target_year = implied["implied_exit_year"]
    row = base["rows"][target_year - 1]
    solved_value = (
        (row["ebit"] + row["da"]) * implied["implied_exit_multiple"] / 1.1**target_year
        - req.net_debt
    ) / row["shares"]

    assert target_year == 3
    assert solved_value == pytest.approx(req.market_price)


def test_invalid_intrinsic_terminal_spread_is_rejected():
    with pytest.raises(ValidationError, match="WACC must be greater"):
        request(wacc=3, terminal={"perpetual_growth": 3})


def test_unavailable_methods_do_not_dilute_composite_weight():
    req = request(
        multiple_targets=[],
        sotp_segments=[],
        schedule=[
            {
                "year": year,
                "growth": 5,
                "margin": 20,
                "tax_rate": 21,
                "da_pct": 4,
                "capex_pct": 5,
                "change_nwc_pct": 0.5,
                "payout_pct": 0,
            }
            for year in range(1, 4)
        ],
    )
    result = _project(req)
    assert result["active_weights"] == {"dcf": 100}
    assert result["composite"]["value_per_share"] == result["dcf"]["value_per_share"]


def test_dividend_value_discounts_each_years_per_share_dividend():
    req = request()
    result = _project(req)
    expected_pv = sum(row["dividend_per_share"] / 1.11**row["year"] for row in result["rows"])
    final = result["rows"][-1]
    terminal = final["dividend_per_share"] * 1.03 / (0.11 - 0.03) / 1.11**len(result["rows"])
    assert result["ddm"]["value_per_share"] == pytest.approx(expected_pv + terminal)


def test_driver_effects_are_backend_perturbations_with_ranked_impact():
    req = request()
    base = _project(req)
    effects = _driver_effects(req, base)

    assert set(effects) == {
        "growth", "margin", "tax_rate", "da_pct", "capex_pct", "change_nwc_pct",
        "sbc_pct", "cash_adjustment_pct", "fcf_conversion_pct", "net_interest_pct",
        "dilution_pct", "payout_pct",
    }
    assert effects["growth"]["bump"] == 5
    assert effects["capex_pct"]["bump"] == 1
    assert effects["growth"]["change_per_share"] > 0
    assert effects["capex_pct"]["change_per_share"] < 0
    assert sorted(item["rank"] for item in effects.values()) == list(range(1, 13))
    ranked = sorted(effects, key=lambda key: abs(effects[key]["change_per_point"]), reverse=True)
    assert [effects[key]["rank"] for key in ranked] == list(range(1, 13))


def test_sensitivity_tables_center_on_the_current_model():
    req = request()
    tables = _sensitivity_tables(req)
    table = tables["discount_rate"]

    assert set(tables) == {"discount_rate", "operating_case", "growth_risk", "exit_framework"}
    assert table["row_values"] == [8, 9, 10, 11, 12]
    assert table["column_values"] == [2, 2.5, 3, 3.5, 4]
    assert len(table["values"]) == 5
    assert all(len(row) == 5 for row in table["values"])
    assert table["base_row_index"] == 2
    assert table["base_column_index"] == 2
    assert table["values"][0][4] > table["values"][4][0]
    base_value = _project(req)["composite"]["value_per_share"]
    for sensitivity in tables.values():
        assert sensitivity["values"][sensitivity["base_row_index"]][sensitivity["base_column_index"]] == pytest.approx(base_value)


def test_sensitivity_axes_stay_unique_and_in_range_at_model_boundaries():
    req = request(wacc=50, terminal={"perpetual_growth": 15})
    req.multiple_targets[1].multiple = 200
    req.schedule = [row.model_copy(update={"growth": 200, "margin": 100}) for row in req.schedule]
    tables = _sensitivity_tables(req)
    base_value = _project(req)["composite"]["value_per_share"]

    for sensitivity in tables.values():
        assert sensitivity["row_values"] == sorted(set(sensitivity["row_values"]))
        assert sensitivity["column_values"] == sorted(set(sensitivity["column_values"]))
        assert len(sensitivity["row_values"]) == 5
        assert len(sensitivity["column_values"]) == 5
        assert sensitivity["values"][sensitivity["base_row_index"]][sensitivity["base_column_index"]] == pytest.approx(base_value)


def test_operating_sensitivity_moves_value_with_cagr_and_margin():
    table = _sensitivity_tables(request())["operating_case"]

    assert table["row_label"] == "Revenue CAGR"
    assert table["column_label"] == "Terminal margin"
    assert table["values"][4][4] > table["values"][0][0]


def test_market_multiple_sensitivity_changes_the_standalone_multiple_method():
    table = _sensitivity_tables(request())["exit_framework"]

    assert table["column_label"] == "Target EV / EBITDA"
    assert table["values"][2][4] > table["values"][2][0]


def test_zero_fundamentals_remain_zero_in_default_schedule():
    schedule = _default_schedule({
        "rev_growth": 0, "op_margin": 0, "tax_rate": 0, "capex_pct": 0,
        "da_pct": 0, "wc_pct": 0,
    }, years=3)

    assert schedule[0]["growth"] == 0
    assert schedule[0]["margin"] == 0
    assert schedule[0]["tax_rate"] == 0
    assert schedule[0]["capex_pct"] == 0
    assert schedule[0]["da_pct"] == 0
    assert schedule[0]["change_nwc_pct"] == 0


def test_non_positive_method_values_remain_in_connected_value():
    req = request(net_debt=100_000)
    result = _project(req)

    assert result["methods"]["dcf"] < 0
    assert result["methods"]["multiples"] < 0
    assert result["methods"]["sotp"] > 0
    assert set(result["active_weights"]) == {"dcf", "multiples", "ddm", "sotp"}
    expected = sum(result["methods"][key] * weight / 100 for key, weight in result["active_weights"].items())
    assert result["composite"]["value_per_share"] == pytest.approx(expected)


def test_all_zero_method_weights_are_rejected():
    with pytest.raises(ValidationError, match="positive weight"):
        request(weights={"dcf": 0, "multiples": 0, "ddm": 0, "sotp": 0})


def test_active_multiples_method_requires_a_positive_internal_weight():
    with pytest.raises(ValidationError, match="target multiple"):
        request(
            multiple_targets=[{"metric": "ev_revenue", "multiple": 4, "weight": 0, "year": 3}],
            weights={"dcf": 65, "multiples": 35, "ddm": 0, "sotp": 0},
        )
