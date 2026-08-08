"""What the report can pull, and what each pull is good for.

Selection happens at tool granularity because a tool is the unit the client can
actually fetch. But the planner used to see only an id, a label and one line of
prose, which is not enough for a small model to choose on fit rather than on
name similarity — so every spec also carries the *questions* it answers, the
*shape* of what comes back, and the specific measurements in `yields`.

Four machine fields drive the deterministic layer in `evidence_plan.py`:

    question_tags   closed vocabulary; retrieval matches on these
    evidence_class  what role this plays in an argument; drives the coverage floor
    output_shapes   what a section can render; drives the visual budget
    cost            wall-clock tier, so a short report does not wait on a slow scan

Keep `yields` concrete. "IV rank, 30-day realised vol, expected move" lets the
model reason; "options data" does not.
"""
from __future__ import annotations

from dataclasses import dataclass, field

# ── Closed vocabularies ──────────────────────────────────────────────────────
# Tags are the join between a question and the tools that can answer it. Adding
# one means teaching the decomposer about it, so keep the set small and orthogonal.
QUESTION_TAGS: tuple[str, ...] = (
    "valuation_level",
    "trend_direction",
    "relative_performance",
    "risk_downside",
    "volatility_regime",
    "positioning_flow",
    "catalyst_event",
    "quality_fundamental",
    "capital_structure",
    "macro_regime",
    "rates_credit",
    "liquidity_breadth",
    "concentration",
    "correlation_struct",
    "seasonality_timing",
    "supply_chain_real",
    "scenario_forward",
)

# The role a piece of evidence plays in an argument. A report that is all
# `level` and no `risk` is the failure mode the coverage floor exists to catch.
EVIDENCE_CLASSES: tuple[str, ...] = (
    "level",        # where something stands right now
    "trend",        # which way it has been going
    "risk",         # what could go wrong, and how far
    "relative",     # how it compares to something else
    "positioning",  # what other participants have done
    "catalyst",     # dated events that could change the answer
    "context",      # the regime the subject sits inside
)

OUTPUT_SHAPES: tuple[str, ...] = (
    "scalar", "series", "table", "distribution", "matrix", "categorical",
)

COSTS: tuple[str, ...] = ("cheap", "normal", "slow")


@dataclass(frozen=True)
class ReportToolSpec:
    id: str
    label: str
    description: str
    target_mode: str
    produces_visuals: bool = False
    domain: str = "issuer"
    question_tags: tuple[str, ...] = ()
    evidence_class: str = "level"
    output_shapes: tuple[str, ...] = ("scalar",)
    cost: str = "normal"
    yields: tuple[str, ...] = ()
    limits: str = ""


def _spec(*args, **kwargs) -> ReportToolSpec:
    tool = ReportToolSpec(*args, **kwargs)
    unknown = set(tool.question_tags) - set(QUESTION_TAGS)
    if unknown:
        raise ValueError(f"{tool.id}: unknown question tags {sorted(unknown)}")
    if tool.evidence_class not in EVIDENCE_CLASSES:
        raise ValueError(f"{tool.id}: unknown evidence class {tool.evidence_class}")
    unknown_shapes = set(tool.output_shapes) - set(OUTPUT_SHAPES)
    if unknown_shapes:
        raise ValueError(f"{tool.id}: unknown output shapes {sorted(unknown_shapes)}")
    if tool.cost not in COSTS:
        raise ValueError(f"{tool.id}: unknown cost tier {tool.cost}")
    return tool


REPORT_TOOL_REGISTRY: tuple[ReportToolSpec, ...] = (
    # ── Portfolio ────────────────────────────────────────────────────────────
    _spec(
        "portfolio", "Active book", "Holdings, cash, saved values, and concentration.",
        "portfolio", False, "portfolio",
        question_tags=("concentration", "quality_fundamental"),
        evidence_class="level", output_shapes=("table", "scalar"), cost="cheap",
        yields=("position weights", "cash balance", "position count", "largest-holding share"),
    ),
    _spec(
        "portfolio-risk", "Risk and performance",
        "Portfolio return, volatility, drawdown, beta, and benchmark-relative performance.",
        "portfolio", True, "portfolio",
        question_tags=("risk_downside", "relative_performance", "trend_direction"),
        evidence_class="risk", output_shapes=("series", "scalar"), cost="normal",
        yields=("total return", "annualised volatility", "max drawdown", "beta to benchmark",
                "excess return versus benchmark"),
    ),
    _spec(
        "factor-decomposition", "Factor exposures",
        "Systematic, idiosyncratic, macro, or style factor exposures and rolling betas.",
        "portfolio-or-symbols", True, "portfolio",
        question_tags=("correlation_struct", "risk_downside", "concentration"),
        evidence_class="risk", output_shapes=("series", "table"), cost="normal",
        yields=("factor betas", "R-squared", "idiosyncratic share of variance", "rolling factor beta"),
    ),
    _spec(
        "correlation", "Correlation structure",
        "Correlation matrix, strongest pairs, beta, and rolling correlation.",
        "symbols", True, "portfolio",
        question_tags=("correlation_struct", "concentration", "risk_downside"),
        evidence_class="relative", output_shapes=("matrix", "series"), cost="normal",
        yields=("pairwise correlation matrix", "most and least correlated pairs", "rolling correlation"),
    ),

    # ── Issuer core ──────────────────────────────────────────────────────────
    _spec(
        "company", "Company snapshot",
        "Company fundamentals, market data, valuation multiples, and beta.",
        "symbols", False, "issuer",
        question_tags=("quality_fundamental", "valuation_level", "capital_structure"),
        evidence_class="level", output_shapes=("scalar", "table"), cost="cheap",
        yields=("revenue and earnings growth", "margins", "P/E and EV/EBITDA", "beta",
                "market cap", "analyst consensus and price target"),
    ),
    _spec(
        "price-history", "Price and drawdown",
        "Historical price path with return and drawdown context.",
        "symbols", True, "issuer",
        question_tags=("trend_direction", "risk_downside"),
        evidence_class="trend", output_shapes=("series",), cost="cheap",
        yields=("price path", "period return", "max drawdown", "realised volatility"),
    ),
    _spec(
        "asset-profile", "Instrument profile",
        "Return ladder, 52-week range position, realised volatility, drawdown, and benchmark relationship for one instrument or index.",
        "symbols", False, "benchmark",
        question_tags=("trend_direction", "relative_performance", "volatility_regime"),
        evidence_class="level", output_shapes=("scalar", "table"), cost="cheap",
        yields=("1d/1w/1m/3m/6m/1y/YTD return ladder", "position within the 52-week range",
                "30-day realised volatility", "1-year max drawdown", "beta and correlation to the benchmark"),
        limits="Beta for a market whose session does not overlap the benchmark is measured on lagged returns; a raw same-day beta understates it badly.",
    ),
    _spec(
        "mover", "Catalyst scan",
        "Price, volume, market context, filings, and event evidence behind a move.",
        "symbols", False, "issuer",
        question_tags=("catalyst_event", "trend_direction"),
        evidence_class="catalyst", output_shapes=("scalar", "table"), cost="normal",
        yields=("move size versus normal range", "relative volume", "attributed cause", "linked filings"),
    ),
    _spec(
        "news", "Recent news", "Recent symbol-specific headlines and sources.",
        "symbols", False, "issuer",
        question_tags=("catalyst_event",),
        evidence_class="catalyst", output_shapes=("table",), cost="cheap",
        yields=("dated headlines", "publisher", "story sentiment"),
    ),
    _spec(
        "earnings", "Earnings calendar",
        "Scheduled earnings events over the report outlook horizon.",
        "symbols", False, "issuer",
        question_tags=("catalyst_event", "scenario_forward"),
        evidence_class="catalyst", output_shapes=("table",), cost="cheap",
        yields=("next earnings date", "confirmed or estimated flag", "consensus EPS"),
        limits="yfinance omits the just-reported quarter for one to three days, which reads as a rescheduled date months out.",
    ),
    _spec(
        "dividends", "Dividend profile",
        "Forward annual dividend per share and yield for each named holding.",
        "symbols", False, "issuer",
        question_tags=("quality_fundamental", "capital_structure"),
        evidence_class="level", output_shapes=("table", "scalar"), cost="cheap",
        yields=("annual dividend per share", "dividend yield"),
        limits="Forward annual rate and yield only. Payment cadence, ex-dates and dividend history are not in this feed.",
    ),
    _spec(
        "debt-maturity", "Debt and maturity wall",
        "Scheduled debt maturities by year from the latest 10-K, and total debt outstanding.",
        "symbols", True, "issuer",
        question_tags=("capital_structure", "risk_downside"),
        evidence_class="risk", output_shapes=("categorical", "scalar"), cost="normal",
        yields=("debt maturing per year bucket", "total debt outstanding", "filing date of the schedule"),
        limits="Taken from the last annual filing, so it is up to a year stale and excludes anything issued or repaid since.",
    ),
    _spec(
        "seasonality", "Seasonal pattern",
        "Month-of-year, weekday, and turn-of-month return patterns with the sample size behind each.",
        "symbols", True, "issuer",
        question_tags=("seasonality_timing", "trend_direction"),
        evidence_class="context", output_shapes=("categorical", "table"), cost="normal",
        yields=("mean and median return by calendar month", "hit rate per month", "best and worst month",
                "current month's historical record", "turn-of-month versus rest-of-month"),
        limits="A twenty-year sample gives roughly twenty observations per month. Treat a hit rate as descriptive, never predictive.",
    ),

    # ── Valuation ────────────────────────────────────────────────────────────
    _spec(
        "peer-valuation", "Peer valuation",
        "Peer multiples, operating quality, consensus targets, and valuation gaps.",
        "symbols", True, "issuer",
        question_tags=("valuation_level", "relative_performance", "quality_fundamental"),
        evidence_class="relative", output_shapes=("table", "categorical"), cost="normal",
        yields=("peer P/E, EV/EBITDA, P/S", "premium or discount to the peer median",
                "peer margins and growth", "consensus target upside"),
    ),
    _spec(
        "dcf-valuation", "DCF valuation",
        "Intrinsic value, projected revenue and free cash flow, and driver sensitivity.",
        "symbols", True, "issuer",
        question_tags=("valuation_level", "scenario_forward"),
        evidence_class="level", output_shapes=("series", "table", "scalar"), cost="slow",
        yields=("intrinsic value per share", "implied upside or downside", "projected revenue and FCF",
                "sensitivity to WACC and terminal growth"),
        limits="Output is dominated by the assumption set. Report the assumptions beside the value or the number means nothing.",
    ),

    # ── Options ──────────────────────────────────────────────────────────────
    _spec(
        "options", "Options snapshot",
        "Implied volatility, realized volatility, expected move, and positioning.",
        "symbols", True, "issuer",
        question_tags=("volatility_regime", "scenario_forward", "positioning_flow"),
        evidence_class="level", output_shapes=("scalar", "series"), cost="normal",
        yields=("IV rank and percentile", "30-day realised volatility", "IV minus RV spread",
                "expected move to expiry", "put/call ratio"),
    ),
    _spec(
        "volatility-skew", "Volatility skew",
        "Options smile, downside skew, implied move, and ATM volatility term structure.",
        "symbols", True, "issuer",
        question_tags=("volatility_regime", "risk_downside", "positioning_flow"),
        evidence_class="risk", output_shapes=("series",), cost="normal",
        yields=("25-delta put minus call skew", "volatility smile by strike",
                "ATM term structure", "term-structure slope"),
    ),
    _spec(
        "dealer-gex", "Dealer gamma",
        "Dealer gamma exposure by strike, gamma flip, and positioning levels.",
        "symbols", True, "issuer",
        question_tags=("positioning_flow", "volatility_regime"),
        evidence_class="positioning", output_shapes=("categorical", "scalar"), cost="normal",
        yields=("net gamma exposure by strike", "gamma flip level", "largest positive and negative strikes"),
        limits="Dealer sign convention is assumed, not observed. Direction of the hedging flow is an inference.",
    ),
    _spec(
        "implied-probability", "Implied probability",
        "Risk-neutral price cone, terminal distribution, percentiles, and finish-above probabilities.",
        "symbols", True, "issuer",
        question_tags=("scenario_forward", "risk_downside", "volatility_regime"),
        evidence_class="risk", output_shapes=("distribution", "series"), cost="normal",
        yields=("risk-neutral terminal distribution", "price cone by expiry",
                "probability of finishing above a level", "percentile price bands"),
        limits="Risk-neutral, not real-world. These are hedging-cost-implied odds and are biased downward for the upside.",
    ),
    _spec(
        "options-unusual", "Unusual options activity",
        "Contracts trading far above their open interest, by volume, premium, and moneyness.",
        "symbols", False, "issuer",
        question_tags=("positioning_flow", "catalyst_event"),
        evidence_class="positioning", output_shapes=("table",), cost="normal",
        yields=("volume-to-open-interest ratio by contract", "premium traded", "strike and expiry of the activity",
                "call versus put split of the unusual flow"),
        limits="Volume over open interest shows size, not direction or intent. Whether the trade opened or closed a position is not in the data, and sweep versus block cannot be derived from this feed.",
    ),

    # ── Ownership and positioning ────────────────────────────────────────────
    _spec(
        "insider-activity", "Insider activity",
        "Recent Form 4 insider buys and sells with size, role, and 10b5-1 status.",
        "symbols", False, "issuer",
        question_tags=("positioning_flow", "quality_fundamental"),
        evidence_class="positioning", output_shapes=("table", "scalar"), cost="normal",
        yields=("dated insider transactions", "buy versus sell value", "insider role",
                "10b5-1 plan flag", "insider ownership percentage"),
        limits="A 10b5-1 sale is scheduled in advance and carries no signal. Separate planned from discretionary before reading intent.",
    ),
    _spec(
        "institutional-ownership", "Institutional ownership",
        "13F holder base, quarter-on-quarter position changes, and float held.",
        "symbols", False, "issuer",
        question_tags=("positioning_flow", "concentration"),
        evidence_class="positioning", output_shapes=("table", "scalar"), cost="normal",
        yields=("percentage of float held by institutions", "top holders and their stakes",
                "holders adding versus trimming", "largest position increases and decreases"),
        limits="13F is filed up to 45 days after quarter end and covers long US equity only. It is a snapshot of a past quarter, not current positioning.",
    ),
    _spec(
        "cot-positioning", "Futures positioning",
        "CFTC Commitments of Traders net positioning and weekly flow by trader cohort.",
        "market", True, "macro",
        question_tags=("positioning_flow", "macro_regime"),
        evidence_class="positioning", output_shapes=("series", "table"), cost="normal",
        yields=("net position by cohort", "weekly change in net position", "open interest change",
                "crowding percentile versus history"),
        limits="Published weekly with a three-day lag and covers futures only. Crowding is a percentile of the cohort's own history, not an absolute.",
    ),

    # ── Market structure and breadth ─────────────────────────────────────────
    _spec(
        "breadth", "Market breadth",
        "Advance-decline, new highs and lows, share of members above their moving averages, and index-versus-breadth divergence.",
        "market", True, "benchmark",
        # Trend, not context. The advance-decline line and the participation
        # change are a direction of travel measured over 126 sessions, and this
        # is the only market-mode tool that supplies one — a macro brief has no
        # other way to satisfy its trend floor.
        question_tags=("liquidity_breadth", "trend_direction", "risk_downside"),
        evidence_class="trend", output_shapes=("series", "scalar"), cost="slow",
        yields=("advancing versus declining members", "advance-decline line",
                "share of members above the 50 and 200-day average", "new highs minus new lows",
                "index-versus-breadth divergence state"),
        limits="Members are the current index constituents, so the history carries survivorship bias.",
    ),
    _spec(
        "sector-rotation", "Sector leadership",
        "Sector return leadership and momentum across horizons.",
        "market", True, "benchmark",
        question_tags=("relative_performance", "trend_direction", "macro_regime"),
        evidence_class="relative", output_shapes=("categorical", "table"), cost="normal",
        yields=("sector returns at 1w/1m/3m", "relative strength versus the index", "momentum ranking"),
    ),
    _spec(
        "sector-rrg", "Rotation graph",
        "Relative-strength and momentum coordinates per sector against the benchmark, with the multi-week trail.",
        "market", True, "benchmark",
        question_tags=("relative_performance", "trend_direction", "macro_regime"),
        evidence_class="relative", output_shapes=("series", "table"), cost="normal",
        yields=("RS-Ratio and RS-Momentum per sector", "quadrant (leading/weakening/lagging/improving)",
                "the quadrant each sector rotated in from", "quadrant population counts"),
        limits="The standard public construction, not the proprietary commercial one. Both axes are normalised over 52 weeks, so they are relative to that window.",
    ),
    _spec(
        "market-compare", "Relative performance",
        "Normalized multi-asset performance comparison.",
        "symbols", True, "benchmark",
        question_tags=("relative_performance", "trend_direction"),
        evidence_class="relative", output_shapes=("series",), cost="cheap",
        yields=("rebased price paths", "total return per asset over the window", "dispersion between the best and worst"),
    ),
    _spec(
        "regression", "Regression model",
        "Fitted returns, coefficients, significance, and residual diagnostics.",
        "symbols", True, "benchmark",
        question_tags=("correlation_struct", "relative_performance"),
        evidence_class="relative", output_shapes=("series", "table"), cost="normal",
        yields=("alpha and beta", "R-squared", "t-statistics and significance", "residual diagnostics"),
    ),
    _spec(
        "pairs", "Pair relationship",
        "Cointegration, hedge ratio, spread z-score, half-life, and the historical spread trade record for two names.",
        "symbols", True, "benchmark",
        question_tags=("correlation_struct", "relative_performance", "scenario_forward"),
        evidence_class="relative", output_shapes=("scalar", "table"), cost="normal",
        yields=("hedge ratio", "spread z-score against entry and exit bands",
                "ADF statistic and whether the spread is stationary", "mean-reversion half-life",
                "backtested spread Sharpe and win rate"),
        limits="A non-stationary ADF result means the pair is not cointegrated over this window, and the z-score has no mean to revert to.",
    ),
    _spec(
        "global-markets", "Global market board",
        "Cross-asset session levels and performance.",
        "market", True, "macro",
        question_tags=("macro_regime", "relative_performance"),
        evidence_class="context", output_shapes=("table", "categorical"), cost="cheap",
        yields=("index, FX, commodity, yield and crypto levels", "session and YTD change per instrument",
                "best and worst performing asset class"),
    ),
    _spec(
        "fx-matrix", "Currency matrix",
        "Cross-rate matrix, forward points, basis, implied volatility, and short rates across the majors.",
        "market", True, "macro",
        question_tags=("macro_regime", "rates_credit", "volatility_regime"),
        evidence_class="context", output_shapes=("matrix", "table"), cost="normal",
        yields=("spot cross rates between the eight majors", "session change per pair",
                "3-month forward points and cross-currency basis", "1-week and 1-month implied volatility",
                "policy short rate per currency"),
    ),

    # ── Macro ────────────────────────────────────────────────────────────────
    _spec(
        "macro-events", "Macro event calendar", "Upcoming economic and policy events.",
        "market", False, "macro",
        question_tags=("catalyst_event", "macro_regime"),
        evidence_class="catalyst", output_shapes=("table",), cost="cheap",
        yields=("dated releases over the outlook window", "consensus and prior where published", "release importance"),
    ),
    _spec(
        "macro-cycle", "Business cycle read",
        "Composite cycle score and phase from payrolls, unemployment, yield curve, and related components.",
        "market", True, "macro",
        question_tags=("macro_regime", "scenario_forward", "risk_downside"),
        evidence_class="context", output_shapes=("scalar", "table"), cost="normal",
        yields=("composite cycle score", "named cycle phase", "per-component score and reading",
                "strongest and weakest component", "how many components resolved"),
        limits="A mean of the components that resolved, not a probability. When fewer than the expected components resolve, the composite rests on a thinner base.",
    ),
    _spec(
        "sentiment", "Market sentiment",
        "Current directional news sentiment and participation.",
        "market", True, "macro",
        question_tags=("catalyst_event", "macro_regime"),
        evidence_class="context", output_shapes=("scalar", "categorical"), cost="cheap",
        yields=("composite sentiment score", "forward versus backward-looking split",
                "bullish and bearish share of headlines", "headline count in the window"),
    ),
    _spec(
        "credit-spreads", "Credit spreads",
        "Investment-grade, high-yield, quality ladder, VIX, and spread history.",
        "market", True, "macro",
        question_tags=("rates_credit", "risk_downside", "macro_regime"),
        evidence_class="context", output_shapes=("series", "table"), cost="normal",
        yields=("IG and HY option-adjusted spreads", "spread history over the window",
                "quality ladder by rating", "VIX level"),
    ),
    _spec(
        "credit-stress", "Credit stress",
        "Observed delinquency and charge-off rates by asset class, with Federal Reserve stress indicators.",
        "market", True, "macro",
        question_tags=("rates_credit", "risk_downside", "macro_regime"),
        evidence_class="risk", output_shapes=("table", "scalar"), cost="normal",
        yields=("delinquency rate by asset class", "charge-off rate by asset class",
                "direction of travel per series", "Federal Reserve stress indicator levels"),
        limits="Federal Reserve aggregates are quarterly and lag by roughly a quarter. Observed only, with no modeled portfolio overlay.",
    ),
    _spec(
        "rate-engine", "Rates and Fed path",
        "Market-implied Fed path and Treasury yield-curve visuals.",
        "market", True, "macro",
        question_tags=("rates_credit", "macro_regime", "scenario_forward"),
        evidence_class="context", output_shapes=("series", "table"), cost="normal",
        yields=("market-implied policy rate path", "Treasury curve by tenor",
                "key curve spreads", "SEP median dots"),
    ),
    _spec(
        "housing", "Housing market",
        "Mortgage rates, median price, affordability, months of supply, and delinquency.",
        "market", True, "macro",
        question_tags=("macro_regime", "rates_credit"),
        evidence_class="context", output_shapes=("table", "scalar"), cost="normal",
        yields=("30-year and ARM mortgage rate", "median price and price per square foot",
                "price-to-income and affordability index", "months of supply and days on market",
                "single-family default and CRE delinquency rate"),
    ),
    _spec(
        "ipo-calendar", "IPO calendar",
        "Priced and upcoming listings with deal size, as a read on primary-market risk appetite.",
        "market", False, "macro",
        question_tags=("liquidity_breadth", "catalyst_event", "macro_regime"),
        evidence_class="context", output_shapes=("table", "scalar"), cost="cheap",
        yields=("count of listings in the window", "priced versus pending split",
                "deal value per listing", "exchange mix"),
    ),
    _spec(
        "chokepoint-exposure", "Chokepoint exposure",
        "Maritime chokepoint transit stress and the listed companies most exposed to it.",
        "market", True, "macro",
        question_tags=("supply_chain_real", "macro_regime", "risk_downside"),
        evidence_class="context", output_shapes=("table", "categorical"), cost="normal",
        yields=("transit volume and status per chokepoint", "change versus the baseline",
                "disruption score", "most exposed tickers and the chokepoints driving it"),
        limits="Exposure is a curated company-to-chokepoint map, not a measured revenue dependency. The PortWatch baseline lags by three to four days.",
    ),
)


REPORT_TOOL_BY_ID = {tool.id: tool for tool in REPORT_TOOL_REGISTRY}

# Which shapes a section may render for a given output shape. The planner never
# picks a chart type freely, so a scalar cannot become a line chart by accident.
VISUAL_BY_SHAPE: dict[str, tuple[str, ...]] = {
    "scalar": ("kpi",),
    "series": ("line", "area"),
    "table": ("table",),
    "distribution": ("histogram", "area"),
    "matrix": ("table",),
    "categorical": ("bar", "table"),
}


def report_tool_manifest() -> list[dict]:
    return [
        {
            "id": tool.id,
            "label": tool.label,
            "description": tool.description,
            "targetMode": tool.target_mode,
            "producesVisuals": tool.produces_visuals,
            "domain": tool.domain,
            "questionTags": list(tool.question_tags),
            "evidenceClass": tool.evidence_class,
            "outputShapes": list(tool.output_shapes),
            "cost": tool.cost,
            "yields": list(tool.yields),
            "limits": tool.limits,
        }
        for tool in REPORT_TOOL_REGISTRY
    ]
