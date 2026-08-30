"""Yahoo's full statements, ordered and unit-tagged.

sec_fundamentals is 39 as-filed lines over seventeen years, narrow because every
line in it feeds the DCF. A statements page wants the other shape: 39 income, 69
balance and 53 cash-flow lines over five periods, including the reconciling
items (EBIT, Normalized EBITDA, Tax Effect Of Unusual Items) and the derived
ones SEC never tags as a single concept (Invested Capital, Tangible Book Value).
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import statements as st  # noqa: E402


def _frame(rows, periods=("2025-09-30", "2024-09-30")):
    # Row labels on the INDEX and periods as columns, which is the shape
    # yfinance returns and the shape _rows reads.
    return pd.DataFrame.from_dict(rows, orient="index", columns=list(periods))


class TestStatementOrdering:
    """A statement whose lines arrive in provider order is not a statement, it
    is a bag of numbers. yfinance hands the frame back roughly upside down."""

    def test_revenue_leads_the_income_statement(self):
        df = _frame({
            "Tax Effect Of Unusual Items": [1.0, 2.0],
            "EBITDA": [140e9, 130e9],
            "Total Revenue": [416e9, 391e9],
            "Gross Profit": [195e9, 180e9],
        })
        rows = st._rows(df, "income")
        assert rows[0]["label"] == "Total Revenue"
        assert rows[1]["label"] == "Gross Profit"

    def test_total_assets_leads_the_balance_sheet(self):
        df = _frame({"Treasury Shares Number": [1.0, 2.0], "Total Assets": [365e9, 352e9]})
        assert st._rows(df, "balance")[0]["label"] == "Total Assets"

    def test_operating_cash_flow_leads_the_cash_flow(self):
        df = _frame({"Free Cash Flow": [99e9, 91e9], "Operating Cash Flow": [118e9, 110e9]})
        assert st._rows(df, "cashflow")[0]["label"] == "Operating Cash Flow"

    def test_lines_outside_the_known_order_still_ship_after_it(self):
        df = _frame({"Some Other Line": [5.0, 6.0], "Total Revenue": [416e9, 391e9]})
        rows = st._rows(df, "income")
        assert [r["label"] for r in rows] == ["Total Revenue", "Some Other Line"]
        assert rows[0]["primary"] is True
        assert rows[1]["primary"] is False


class TestEmptyLines:
    def test_a_line_the_filer_never_reported_is_omitted(self):
        # Forty empty rows tell the reader nothing except that the page broke.
        df = _frame({"Total Revenue": [416e9, 391e9], "Interest Income": [None, None]})
        assert [r["label"] for r in st._rows(df, "income")] == ["Total Revenue"]

    def test_a_partly_reported_line_is_kept(self):
        df = _frame({"Interest Income": [None, 3e9]})
        rows = st._rows(df, "income")
        assert len(rows) == 1 and rows[0]["values"] == [None, 3e9]

    def test_an_empty_frame_is_no_rows_rather_than_an_error(self):
        assert st._rows(pd.DataFrame(), "income") == []
        assert st._rows(None, "income") == []


class TestUnits:
    """A share count abbreviated as money, or an EPS as billions, is worse than
    no number: it is a plausible wrong one."""

    def test_per_share_lines_are_not_money(self):
        assert st._unit("Basic EPS") == "$/sh"
        assert st._unit("Diluted EPS") == "$/sh"

    def test_share_counts_are_shares(self):
        assert st._unit("Basic Average Shares") == "sh"
        assert st._unit("Diluted Average Shares") == "sh"
        assert st._unit("Ordinary Shares Number") == "sh"
        assert st._unit("Treasury Shares Number") == "sh"
        assert st._unit("Share Issued") == "sh"

    def test_a_rate_is_a_rate(self):
        assert st._unit("Tax Rate For Calcs") == "rate"

    def test_everything_else_is_money(self):
        for label in ("Total Revenue", "EBITDA", "Total Assets", "Free Cash Flow"):
            assert st._unit(label) == "$"


class TestUnavailable:
    def test_a_blank_ticker_is_refused_without_a_network_call(self):
        assert st.get_statements("")["available"] is False
        assert st.get_statements("   ")["reason"] == "no_ticker"
