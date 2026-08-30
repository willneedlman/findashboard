"""Full financial statements as Yahoo Finance presents them.

sec_fundamentals gives 39 as-filed lines over seventeen years and is what the
DCF and the Fundamental Overlay read. It is deliberately narrow: every line
there is one the valuation engine consumes.

A statements PAGE wants the opposite shape. Yahoo shows 39 income lines, 69
balance lines and 53 cash-flow lines over five periods, including the
reconciling items an analyst reads a filing for (EBIT, Normalized EBITDA,
Reconciled Depreciation, Tax Effect Of Unusual Items) and the ones SEC never
tags as a single concept (Invested Capital, Tangible Book Value, Net Tangible
Assets). Those are yfinance's own row labels, so this reads them straight
through rather than renaming them into a house vocabulary that would then have
to be kept in step with theirs.

Quarterly is included because a filing page without it can only answer half the
questions asked of it.
"""
import logging

import pandas as pd

from cache import _run_yf, cached

logger = logging.getLogger(__name__)

# Yahoo orders its breakdown top-down, revenue first. yfinance hands back the
# frame in roughly the reverse, so the order is pinned here: a statement whose
# lines arrive in provider order is not a statement, it is a bag of numbers.
_ORDER = {
    "income": [
        "Total Revenue", "Cost Of Revenue", "Gross Profit", "Operating Expense",
        "Operating Income", "Net Non Operating Interest Income Expense",
        "Other Income Expense", "Pretax Income", "Tax Provision",
        "Earnings From Equity Interest Net Of Tax",
        "Net Income Common Stockholders", "Average Dilution Earnings",
        "Diluted NI Available To Com Stockholders", "Basic EPS", "Diluted EPS",
        "Basic Average Shares", "Diluted Average Shares",
        "Total Operating Income As Reported", "Total Expenses",
        "Net Income From Continuing And Discontinued Operation", "Normalized Income",
        "Interest Income", "Interest Expense", "Net Interest Income", "EBIT", "EBITDA",
        "Reconciled Cost Of Revenue", "Reconciled Depreciation",
        "Net Income From Continuing Operation Net Minority Interest",
        "Total Unusual Items Excluding Goodwill", "Total Unusual Items",
        "Normalized EBITDA", "Tax Rate For Calcs", "Tax Effect Of Unusual Items",
    ],
    "balance": [
        "Total Assets", "Total Liabilities Net Minority Interest",
        "Total Equity Gross Minority Interest", "Total Capitalization",
        "Common Stock Equity", "Capital Lease Obligations", "Net Tangible Assets",
        "Working Capital", "Invested Capital", "Tangible Book Value", "Total Debt",
        "Net Debt", "Share Issued", "Ordinary Shares Number", "Treasury Shares Number",
    ],
    "cashflow": [
        "Operating Cash Flow", "Investing Cash Flow", "Financing Cash Flow",
        "End Cash Position", "Income Tax Paid Supplemental Data",
        "Interest Paid Supplemental Data", "Capital Expenditure", "Issuance Of Debt",
        "Repayment Of Debt", "Repurchase Of Capital Stock", "Free Cash Flow",
    ],
}

_FRAMES = {
    ("income", "annual"): "income_stmt",
    ("income", "quarterly"): "quarterly_income_stmt",
    ("balance", "annual"): "balance_sheet",
    ("balance", "quarterly"): "quarterly_balance_sheet",
    ("cashflow", "annual"): "cashflow",
    ("cashflow", "quarterly"): "quarterly_cashflow",
}

# Lines quoted per share or as a rate, which must not be abbreviated to "3.1B".
_PER_SHARE = {"Basic EPS", "Diluted EPS"}
_RATE = {"Tax Rate For Calcs"}


def _unit(label: str) -> str:
    if label in _PER_SHARE:
        return "$/sh"
    if label in _RATE:
        return "rate"
    if "Shares" in label or label in {"Share Issued", "Ordinary Shares Number",
                                      "Treasury Shares Number"}:
        return "sh"
    return "$"


def _rows(df: "pd.DataFrame", statement: str) -> list[dict]:
    """Statement rows in Yahoo's order, then anything else the filer reported.

    A line yfinance did not return is omitted rather than emitted as null: a
    balance sheet listing forty empty rows tells the reader nothing except that
    the page is broken.
    """
    if df is None or df.empty:
        return []
    present = list(df.index)
    ordered = [r for r in _ORDER[statement] if r in present]
    extra = [r for r in present if r not in set(ordered)]
    out = []
    for label in ordered + sorted(extra):
        series = df.loc[label]
        values = [None if pd.isna(v) else float(v) for v in series.tolist()]
        if all(v is None for v in values):
            continue
        out.append({"label": label, "unit": _unit(label), "values": values,
                    "primary": label in _ORDER[statement]})
    return out


@cached(ttl=21_600, maxsize=120, persist=True)
def get_statements(ticker: str, freq: str = "annual") -> dict:
    """Income, balance sheet and cash flow for one ticker at one frequency."""
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"available": False, "reason": "no_ticker"}

    # Imported here rather than at the top of the call: yfinance takes
    # seconds to import, and a request with no ticker should pay nothing.
    import yfinance as yf
    freq = "quarterly" if str(freq).lower().startswith("q") else "annual"

    def pull():
        t = yf.Ticker(sym)
        return {s: getattr(t, _FRAMES[(s, freq)]) for s in ("income", "balance", "cashflow")}

    try:
        frames = _run_yf(f"statements {sym} {freq}", pull)
    except Exception as e:
        logger.warning("statements failed for %s (%s): %s", sym, freq, e)
        return {"available": False, "reason": "source_error", "ticker": sym}

    income = frames.get("income")
    if income is None or getattr(income, "empty", True):
        # An ETF, a fund, or a symbol with no filed statements at all. Named so
        # the page can say which rather than showing an empty table.
        return {"available": False, "reason": "no_statements", "ticker": sym, "frequency": freq}

    periods = [str(c)[:10] for c in income.columns]
    return {
        "available": True,
        "ticker": sym,
        "frequency": freq,
        "periods": periods,
        "statements": {s: _rows(frames.get(s), s) for s in ("income", "balance", "cashflow")},
        "source": "Yahoo Finance",
    }
