from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ReportToolSpec:
    id: str
    label: str
    description: str
    target_mode: str
    produces_visuals: bool = False


REPORT_TOOL_REGISTRY: tuple[ReportToolSpec, ...] = (
    ReportToolSpec("portfolio", "Active book", "Holdings, cash, saved values, and concentration.", "portfolio"),
    ReportToolSpec("portfolio-risk", "Risk and performance", "Portfolio return, volatility, drawdown, beta, and benchmark-relative performance.", "portfolio", True),
    ReportToolSpec("company", "Company snapshot", "Company fundamentals, market data, valuation multiples, and beta.", "symbols"),
    ReportToolSpec("price-history", "Price and drawdown", "Historical price path with return and drawdown context.", "symbols", True),
    ReportToolSpec("market-compare", "Relative performance", "Normalized multi-asset performance comparison.", "symbols", True),
    ReportToolSpec("mover", "Catalyst scan", "Price, volume, market context, filings, and event evidence behind a move.", "symbols"),
    ReportToolSpec("news", "Recent news", "Recent symbol-specific headlines and sources.", "symbols"),
    ReportToolSpec("options", "Options snapshot", "Implied volatility, realized volatility, expected move, and positioning.", "symbols", True),
    ReportToolSpec("earnings", "Earnings calendar", "Scheduled earnings events over the report outlook horizon.", "symbols"),
    ReportToolSpec("global-markets", "Global market board", "Cross-asset session levels and performance.", "market", True),
    ReportToolSpec("macro-events", "Macro event calendar", "Upcoming economic and policy events.", "market"),
    ReportToolSpec("sentiment", "Market sentiment", "Current directional news sentiment and participation.", "market", True),
    ReportToolSpec("sector-rotation", "Sector leadership", "Sector return leadership and momentum across horizons.", "market", True),
    ReportToolSpec("correlation", "Correlation structure", "Correlation matrix, strongest pairs, beta, and rolling correlation.", "symbols", True),
    ReportToolSpec("regression", "Regression model", "Fitted returns, coefficients, significance, and residual diagnostics.", "symbols", True),
    ReportToolSpec("factor-decomposition", "Factor exposures", "Systematic, idiosyncratic, macro, or style factor exposures and rolling betas.", "portfolio-or-symbols", True),
    ReportToolSpec("credit-spreads", "Credit risk regime", "Investment-grade, high-yield, quality ladder, VIX, and spread history.", "market", True),
    ReportToolSpec("rate-engine", "Rates and Fed path", "Market-implied Fed path and Treasury yield-curve visuals.", "market", True),
    ReportToolSpec("peer-valuation", "Peer valuation", "Peer multiples, operating quality, consensus targets, and valuation gaps.", "symbols", True),
    ReportToolSpec("dcf-valuation", "DCF valuation", "Intrinsic value, projected revenue and free cash flow, and driver sensitivity.", "symbols", True),
    ReportToolSpec("volatility-skew", "Volatility skew", "Options smile, downside skew, implied move, and ATM volatility term structure.", "symbols", True),
    ReportToolSpec("dealer-gex", "Dealer gamma", "Dealer gamma exposure by strike, gamma flip, and positioning levels.", "symbols", True),
    ReportToolSpec("implied-probability", "Implied probability", "Risk-neutral price cone, terminal distribution, percentiles, and finish-above probabilities.", "symbols", True),
)


REPORT_TOOL_BY_ID = {tool.id: tool for tool in REPORT_TOOL_REGISTRY}


def report_tool_manifest() -> list[dict]:
    return [
        {
            "id": tool.id,
            "label": tool.label,
            "description": tool.description,
            "targetMode": tool.target_mode,
            "producesVisuals": tool.produces_visuals,
        }
        for tool in REPORT_TOOL_REGISTRY
    ]
