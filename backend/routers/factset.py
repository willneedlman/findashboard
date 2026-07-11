"""FactSet Overview API endpoints (Financial Highlights).

Serves the one entitled Overview endpoint as a display-ready, grouped table:
statement lines, margins, balance sheet, cash flow, and ratios across actual
fiscal years plus forward consensus estimates. Returns {available:false} rather
than erroring when the key is absent, not entitled, or the ticker is uncovered,
so the frontend simply hides the panel.
"""
import sys, os
from fastapi import APIRouter, Query

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import factset
from validation import validate_ticker

router = APIRouter()

# Curated display layout over the ~35 Financial Highlights line items.
# (group, [(label, unit)]) with unit in {$M, %, x, $, d}.
_GROUPS: list[tuple[str, list[tuple[str, str]]]] = [
    ("Income statement", [
        ("Revenue", "$M"), ("Gross Income", "$M"), ("EBITDA", "$M"),
        ("EBIT", "$M"), ("Net Income", "$M"),
    ]),
    ("Per share", [
        ("EPS (Diluted)", "$"), ("Dividend Per Share", "$"), ("Book Value Per Share", "$"),
    ]),
    ("Margins", [
        ("Gross Margin (%)", "%"), ("EBITDA Margin (%)", "%"), ("EBIT Margin (%)", "%"),
        ("Operating Margin (%)", "%"), ("Pre Tax Margin (%)", "%"), ("Net Margin (%)", "%"),
        ("Free Cash Flow Margin (%)", "%"),
    ]),
    ("Balance sheet", [
        ("Cash & ST Inv", "$M"), ("Total Assets", "$M"), ("Total Liabilities", "$M"),
        ("Total Shareholder Equity", "$M"),
    ]),
    ("Cash flow", [
        ("Net Operating Cash Flow", "$M"), ("Cap Ex", "$M"), ("Free Cash Flow", "$M"),
    ]),
    ("Returns & leverage", [
        ("Return on Asset (%)", "%"), ("Return on Equity (%)", "%"),
        ("Current Ratio", "x"), ("Quick Ratio", "x"),
        ("Total Debt / Total Eq (%)", "%"), ("Interest Coverage", "x"),
    ]),
    ("Efficiency", [
        ("Asset Turnover", "x"), ("Inventory Turnover", "x"),
        ("Days Sales Outstanding", "d"), ("Days Payable Outstanding", "d"),
    ]),
]


@router.get("/financials")
def financials(ticker: str = Query(...), actual: int = Query(6, ge=1, le=10), estimate: int = Query(2, ge=0, le=4)):
    """Grouped Financial Highlights for a ticker, or {available:false} if uncovered."""
    ticker = validate_ticker(ticker)
    if not factset.available():
        return {"available": False, "reason": "not_configured"}
    fin = factset.financial_highlights(ticker, actual=actual, estimate=estimate)
    if not fin:
        return {"available": False, "reason": "no_coverage", "ticker": ticker}

    metrics = fin["metrics"]
    groups = []
    for title, rows in _GROUPS:
        out_rows = []
        for label, unit in rows:
            vals = metrics.get(label)
            if not vals or all(v is None for v in vals):
                continue
            out_rows.append({"label": label.replace(" (%)", ""), "unit": unit, "values": vals})
        if out_rows:
            groups.append({"title": title, "rows": out_rows})

    return {
        "available": True, "ticker": fin["ticker"], "periods": fin["periods"],
        "groups": groups, "source": "FactSet Overview (Financial Highlights)",
    }
