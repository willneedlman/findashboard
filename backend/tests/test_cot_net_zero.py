"""COT cohort accounting: the categories have to add up.

Every futures contract has a buyer for every seller, so total longs, total shorts
and open interest are one number and the cohort nets must sum to zero. The tool
previously omitted Non-Reportables, which left the categories visibly unbalanced.
These tests run against a captured CFTC row shape rather than the live API.
"""
import pytest

from routers.official import (
    _COT_FAMILIES,
    _NET_ZERO_TOLERANCE,
    _cohort_split,
    _cot_market,
    _trend,
)


def _tff_row(**over):
    """A TFF print with the published identity intact: longs == shorts == OI."""
    row = {
        "report_date_as_yyyy_mm_dd": "2026-08-04T00:00:00.000",
        "market_and_exchange_names": "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE",
        "open_interest_all": "2116079",
        "dealer_positions_long_all": "236175", "dealer_positions_short_all": "953001",
        "asset_mgr_positions_long": "1162320", "asset_mgr_positions_short": "225287",
        "lev_money_positions_long": "206039", "lev_money_positions_short": "536038",
        "other_rept_positions_long": "52902", "other_rept_positions_short": "54744",
        "nonrept_positions_long_all": "265488", "nonrept_positions_short_all": "153854",
    }
    row.update(over)
    return row


def _cit_row(**over):
    """A supplemental CIT print. Note the mixed-case key: Socrata returns
    `Comm_Positions_Short_All_NoCIT`, which a case-sensitive lookup silently misses."""
    row = {
        "report_date_as_yyyy_mm_dd": "2026-08-04T00:00:00.000",
        "market_and_exchange_names": "CORN - CHICAGO BOARD OF TRADE",
        "open_interest_all": "2332893",
        "comm_positions_long_all_nocit": "647282", "Comm_Positions_Short_All_NoCIT": "992815",
        "cit_positions_long_all": "471229", "cit_positions_short_all": "123097",
        "nonrept_positions_long_all": "183109", "nonrept_positions_short_all": "228541",
        "tot_rept_positions_long_all": "2149783", "tot_rept_positions_short": "2104352",
    }
    row.update(over)
    return row


def test_tff_cohorts_include_non_reportables():
    split = _cohort_split(_COT_FAMILIES["tff"], _tff_row())
    assert [name for name, _, _ in split] == [
        "Dealers", "Asset Managers", "Leveraged Money", "Other Reportables", "Non-Reportables",
    ]


def test_tff_cohorts_net_to_zero():
    split = _cohort_split(_COT_FAMILIES["tff"], _tff_row())
    assert sum(long - short for _, long, short in split) == 0


def test_dropping_non_reportables_is_what_broke_the_balance():
    split = _cohort_split(_COT_FAMILIES["tff"], _tff_row())
    reportable_only = sum(long - short for name, long, short in split if name != "Non-Reportables")
    non_reportable = next(long - short for name, long, short in split if name == "Non-Reportables")
    assert reportable_only != 0
    assert reportable_only + non_reportable == 0


def test_long_and_short_totals_match_each_other():
    """The directional totals are equal, which is what forces the nets to zero.

    They do NOT equal open interest: TFF reports spreading in its own columns, so
    OI exceeds the directional sum by exactly the spread book. Spreading is equal
    on both sides, so it cancels out of every net.
    """
    split = _cohort_split(_COT_FAMILIES["tff"], _tff_row())
    total_long = sum(long for _, long, _ in split)
    total_short = sum(short for _, _, short in split)
    assert total_long == total_short
    spreading = 2116079 - total_long
    assert spreading > 0, "the sample carries a spread book"


def test_cit_derives_the_unpublished_reportable_slice():
    split = _cohort_split(_COT_FAMILIES["cit"], _cit_row())
    names = [name for name, _, _ in split]
    assert "Other Reportables" in names, "the non-commercial ex-index slice must be derived"
    assert names[-1] == "Non-Reportables"
    # CFTC rounds to whole contracts, so allow the published slack.
    assert abs(sum(long - short for _, long, short in split)) <= _NET_ZERO_TOLERANCE


def test_a_missing_field_yields_no_split_rather_than_a_partial_one():
    # A partial split would silently break the identity every caller relies on.
    assert _cohort_split(_COT_FAMILIES["tff"], _tff_row(asset_mgr_positions_long=None)) == []
    assert _cohort_split(_COT_FAMILIES["cit"], _cit_row(tot_rept_positions_short=None)) == []


def test_case_insensitive_field_lookup_survives_socrata_casing():
    # Socrata returns some columns in mixed case; a case-sensitive read drops them.
    row = _cit_row()
    assert row["Comm_Positions_Short_All_NoCIT"] == "992815"
    split = _cohort_split(_COT_FAMILIES["cit"], row)
    commercial = next(item for item in split if item[0] == "Commercial (ex-index)")
    assert commercial[2] == 992815.0


@pytest.mark.parametrize("history,expected", [
    ([1.0] * 30, {"w4": 0.0, "w13": 0.0, "w26": 0.0}),
    (list(range(30)), {"w4": 4.0, "w13": 13.0, "w26": 26.0}),
])
def test_trend_measures_change_over_each_window(history, expected):
    assert _trend(history) == expected


def test_trend_is_none_when_history_is_too_short():
    assert _trend([1.0, 2.0]) == {"w4": None, "w13": None, "w26": None}
    assert _trend([]) == {"w4": None, "w13": None, "w26": None}


def test_market_reports_balance_and_per_cohort_history(monkeypatch):
    rows = [_tff_row(report_date_as_yyyy_mm_dd=f"2026-0{month}-04T00:00:00.000") for month in (1, 2, 3)]

    class _Resp:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return rows

    monkeypatch.setattr("routers.official.requests.get", lambda *a, **k: _Resp())
    market = _cot_market("tff", "spx", "E-mini S&P 500", "E-MINI S&P 500")

    assert market["balanced"] is True
    assert market["net_residual"] == 0
    assert market["weeks"] == 3
    assert market["primary"] == "Leveraged Money"
    # Every weekly point carries the full cohort split, not just the primary.
    assert set(market["series"][0]["cohort_net"]) == {
        "Dealers", "Asset Managers", "Leveraged Money", "Other Reportables", "Non-Reportables",
    }
    assert all("trend" in cohort for cohort in market["cohorts"])


# ── Contract sizing ───────────────────────────────────────────────────────────

from routers.official import _CONTRACT_SPECS, _contract_value  # noqa: E402


def test_treasuries_size_off_face_value_without_a_price(monkeypatch):
    monkeypatch.setattr("routers.official._contract_prices", lambda: {})
    ten_year = _contract_value("10y")
    assert ten_year["value_usd"] == 100_000
    assert ten_year["basis"] == "face value"


def test_priced_contracts_multiply_price_by_size(monkeypatch):
    monkeypatch.setattr("routers.official._contract_prices", lambda: {"^GSPC": 5000.0})
    assert _contract_value("spx")["value_usd"] == 50 * 5000.0


def test_cent_quoted_grains_are_scaled_to_dollars(monkeypatch):
    # Corn feeds quote cents per bushel: 472.25 is $4.7225, so 5,000bu is ~$23.6k.
    monkeypatch.setattr("routers.official._contract_prices", lambda: {"ZC=F": 472.25})
    assert _contract_value("corn")["value_usd"] == pytest.approx(23_612.5)


def test_an_unpriced_contract_reports_no_notional_rather_than_a_guess(monkeypatch):
    monkeypatch.setattr("routers.official._contract_prices", lambda: {})
    gold = _contract_value("gold")
    assert gold["value_usd"] is None
    assert gold["basis"] == "unpriced"


def test_an_unknown_market_has_no_contract_spec():
    assert _contract_value("not-a-market") is None


def test_every_universe_market_has_a_contract_spec():
    from routers.official import _COT_UNIVERSE
    missing = {
        market[0]
        for universe in _COT_UNIVERSE.values()
        for market in universe["markets"]
        if market[0] not in _CONTRACT_SPECS
    }
    assert not missing, f"markets without published contract terms: {sorted(missing)}"


def test_dollar_nets_also_sum_to_zero(monkeypatch):
    """Contracts net to zero and every cohort shares one multiplier, so dollars do too."""
    monkeypatch.setattr("routers.official._contract_prices", lambda: {"^GSPC": 5000.0})
    rows = [_tff_row()]

    class _Resp:
        status_code = 200
        def raise_for_status(self): pass
        def json(self): return rows

    monkeypatch.setattr("routers.official.requests.get", lambda *a, **k: _Resp())
    market = _cot_market("tff", "spx", "E-mini S&P 500", "E-MINI S&P 500")
    assert sum(cohort["net_usd"] for cohort in market["cohorts"]) == 0
    assert market["open_interest_usd"] == 2116079 * 50 * 5000.0
