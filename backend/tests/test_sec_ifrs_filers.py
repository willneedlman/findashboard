"""SEC holds foreign filers' statements. We were not reading them.

/api/corporate/fundamental-history 404'd for every foreign private issuer:
SAP, TSM, NVO. Two independent gates were shut, and opening either alone
changed nothing.

  1. TAXONOMY. A 20-F filer reports under IFRS, so its companyfacts carry ZERO
     us-gaap concepts. Measured against SEC on 2026-08-30:
         SAP  CIK 0001000184  us-gaap 0  ifrs-full 368
         TSM  CIK 0001046179  us-gaap 0  ifrs-full 334
         NVO  CIK 0000353278  us-gaap 0  ifrs-full 253
  2. FORM. The annual filter required form 10-K, which rejects a 20-F or a
     Canadian 40-F outright.

And a third thing surfaced once those opened: a foreign filer reports in its own
currency, so the USD unit bucket is empty or holds a couple of convenience
translations.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import sec_fundamentals as sf  # noqa: E402


class TestAnnualFormsIncludeForeignFilings:
    def test_the_three_annual_report_forms_are_accepted(self):
        assert sf._is_annual("10-K")
        assert sf._is_annual("20-F")      # foreign private issuer
        assert sf._is_annual("40-F")      # Canadian MJDS

    def test_an_amendment_still_counts(self):
        assert sf._is_annual("10-K/A")
        assert sf._is_annual("20-F/A")

    def test_a_quarterly_or_current_report_does_not(self):
        assert not sf._is_annual("10-Q")
        assert not sf._is_annual("8-K")
        assert not sf._is_annual("6-K")   # the foreign equivalent of an 8-K
        assert not sf._is_annual("")
        assert not sf._is_annual(None)


class TestReportingCurrency:
    """The filer's own currency, taken from where its facts actually are."""

    def _facts(self, per_unit):
        return {"Revenue": {"units": {
            unit: [{"fp": "FY", "form": "20-F", "val": 1, "fy": 2020 + i} for i in range(n)]
            for unit, n in per_unit.items()
        }}}

    def test_a_domestic_filer_is_usd(self):
        assert sf.reporting_currency(self._facts({"USD": 12}), ["Revenue"]) == "USD"

    def test_a_convenience_translation_does_not_beat_the_real_statements(self):
        # The exact SAP shape: 82 annual facts in EUR against 3 in USD. Any
        # "USD if present" rule picks the three and discards nine years of
        # filings behind them, which is what returned a single 2017 period.
        assert sf.reporting_currency(self._facts({"EUR": 82, "USD": 3}), ["Revenue"]) == "EUR"

    def test_a_filer_with_no_usd_at_all_is_read_in_its_own_currency(self):
        assert sf.reporting_currency(self._facts({"DKK": 40}), ["Revenue"]) == "DKK"
        assert sf.reporting_currency(self._facts({"TWD": 30}), ["Revenue"]) == "TWD"

    def test_usd_wins_a_genuine_tie(self):
        # Which is the shape a domestic filer produces.
        assert sf.reporting_currency(self._facts({"USD": 10, "EUR": 10}), ["Revenue"]) == "USD"

    def test_share_and_per_share_units_are_not_currencies(self):
        facts = {"Revenue": {"units": {
            "shares": [{"fp": "FY", "form": "10-K", "val": 1, "fy": 2024}] * 50,
            "USD/shares": [{"fp": "FY", "form": "10-K", "val": 1, "fy": 2024}] * 50,
            "EUR": [{"fp": "FY", "form": "20-F", "val": 1, "fy": 2024}] * 5,
        }}}
        assert sf.reporting_currency(facts, ["Revenue"]) == "EUR"

    def test_nothing_to_go_on_falls_back_to_usd(self):
        assert sf.reporting_currency({}, ["Revenue"]) == "USD"
        assert sf.reporting_currency({"Revenue": {"units": {}}}, ["Revenue"]) == "USD"

    def test_only_annual_facts_vote(self):
        # A quarterly-heavy unit must not decide the reporting currency.
        facts = {"Revenue": {"units": {
            "EUR": [{"fp": "Q1", "form": "6-K", "val": 1, "fy": 2024}] * 99,
            "USD": [{"fp": "FY", "form": "10-K", "val": 1, "fy": 2024}] * 4,
        }}}
        assert sf.reporting_currency(facts, ["Revenue"]) == "USD"


class TestTheIfrsConceptsAreMapped:
    """Names read off a real filer's companyfacts, not guessed. A wrong concept
    name fails silently as an absent line rather than as an error."""

    def test_the_income_statement_reaches_ifrs_names(self):
        assert "Revenue" in sf._INCOME["revenue"]
        assert "ProfitLoss" in sf._INCOME["netIncome"]
        assert "ProfitLossFromOperatingActivities" in sf._INCOME["operatingIncome"]
        assert "ProfitLossBeforeTax" in sf._INCOME["incomeBeforeTax"]

    def test_the_balance_sheet_reaches_ifrs_names(self):
        assert "CashAndCashEquivalents" in sf._BALANCE["cashAndCashEquivalents"]
        assert "Equity" in sf._BALANCE["totalStockholdersEquity"]

    def test_debt_reaches_ifrs_names(self):
        assert "LongtermBorrowings" in sf._DEBT_LT
        assert "CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings" in sf._DEBT_CUR

    def test_the_us_gaap_name_still_comes_first(self):
        # Order is the precedence rule, so a domestic filer must never fall
        # through to an IFRS synonym.
        assert sf._INCOME["netIncome"].index("NetIncomeLoss") == 0
        assert sf._INCOME["revenue"].index("Revenue") > 0
