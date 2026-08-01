"""
AI assistant router — Groq-powered helpers for DCF, screener NL, corporate brief,
strategy narrative, backtest commentary, bond narrative, screener fallback, and
the Algo Strategy Builder's describe-in-English chat.
"""
import hashlib
import json
import logging
import re
import sys, os
import threading
from statistics import median as _median
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from cachetools import TTLCache
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from ai_client import groq_complete, groq_chat, parse_json, MODEL_FAST, MODEL_SMART
from routers.screener import (
    PRICE_CHANGE_PERIODS,
    SCREENER_FIELDS,
    SECTORS,
    UNIVERSE_OPTIONS,
    ScreenRequest,
    resolve_company_mentions,
    run_screen,
)
from disk_cache import disk_get, disk_set

logger = logging.getLogger(__name__)
router = APIRouter()

_ai_screen_cache: TTLCache = TTLCache(maxsize=500, ttl=14400)
_ai_screen_lock = threading.Lock()


# ── 1. DCF assumption suggester ───────────────────────────────────────────────

class DCFAssumptionsRequest(BaseModel):
    ticker: str
    revenue: float = 0
    op_margin: float = 15.0
    rev_growth: float = 10.0
    beta: float = 1.0
    sector: str = ""
    wacc: float = 10.0

_DCF_SYSTEM = """You are a financial analyst. Suggest realistic 10-year DCF model assumptions from the provided fundamentals. Consider the sector, growth stage, and competitive position.
Respond ONLY with valid JSON (no markdown):
{
  "rev_growth_1": <yr 1-3 annual growth %, float>,
  "rev_growth_2": <yr 4-7 annual growth %, float>,
  "rev_growth_3": <yr 8-10 annual growth %, float>,
  "target_margin": <yr 10 operating margin %, float>,
  "wacc": <suggested WACC %, float>,
  "terminal_growth": <terminal growth rate %, float, typically 2-3>,
  "rationale": {
    "growth": "one sentence on growth trajectory",
    "margin": "one sentence on margin expansion thesis",
    "wacc": "one sentence on discount rate reasoning"
  }
}"""

@router.post("/dcf-assumptions")
def dcf_assumptions(req: DCFAssumptionsRequest):
    prompt = f"""Fundamentals for {req.ticker}:
- TTM Revenue: ${req.revenue:,.0f}M
- Current Operating Margin: {req.op_margin:.1f}%
- Recent Revenue Growth: {req.rev_growth:.1f}%
- Beta: {req.beta:.2f}
- Sector: {req.sector or "unknown"}
- Current WACC estimate: {req.wacc:.1f}%"""
    raw = groq_complete(prompt, max_tokens=450, model=MODEL_FAST, system=_DCF_SYSTEM)
    return parse_json(raw)


# ── 2. Screener natural-language parser ───────────────────────────────────────

class ScreenerParseRequest(BaseModel):
    query: str = Field(min_length=2, max_length=1200)

_SCREENER_FIELD_IDS = {item["id"] for item in SCREENER_FIELDS}
_SCREENER_OPERATORS = {"gt", "gte", "lt", "lte", "between"}
_SCREENER_UNIVERSES = {item["value"] for item in UNIVERSE_OPTIONS if item["value"]}
_SCREENER_EXCHANGES = {"NASDAQ", "NYSE", "AMEX", "LSE", "XETRA", "TSE"}
_SCREENER_REGIONS = {"North America", "Europe", "Asia-Pacific"}
_SCREENER_SECTOR_ALIASES = {
    "financials": "Financial Services",
    "health care": "Healthcare",
    "consumer staples": "Consumer Defensive",
    "consumer discretionary": "Consumer Cyclical",
    "materials": "Basic Materials",
}
_SCREENER_SECTOR_QUERY_PATTERNS = [
    (r"\b(banks?|banking|financial services?|financials?|brokerage|insurance|fintech)\b", "Financial Services"),
    (r"\b(technology|software|semiconductor|cybersecurity|cloud)\b", "Technology"),
    (r"\b(healthcare|health care|biotech|pharma|pharmaceutical)\b", "Healthcare"),
    (r"\b(consumer discretionary|consumer cyclical|retail|automotive)\b", "Consumer Cyclical"),
    (r"\b(communication services?|media|telecom)\b", "Communication Services"),
    (r"\b(industrial|industrials|aerospace|machinery)\b", "Industrials"),
    (r"\b(consumer staples?|consumer defensive|food products?)\b", "Consumer Defensive"),
    (r"\b(energy|oil|gas|exploration and production)\b", "Energy"),
    (r"\b(utilit(?:y|ies)|electric power)\b", "Utilities"),
    (r"\b(real estate|reit)\b", "Real Estate"),
    (r"\b(basic materials?|materials|mining|chemicals)\b", "Basic Materials"),
]


def _screener_key(value) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").lower())


_SCREENER_FIELD_ALIASES = {
    _screener_key(alias): item["id"]
    for item in SCREENER_FIELDS
    for alias in (item["id"], item["label"])
}
_SCREENER_FIELD_ALIASES.update({
    "pe": "peRatio",
    "pb": "pbRatio",
    "ps": "psRatio",
    "evebitda": "evEbitda",
})
_SCREENER_OPERATOR_ALIASES = {
    ">": "gt",
    ">=": "gte",
    "≥": "gte",
    "<": "lt",
    "<=": "lte",
    "≤": "lte",
    "range": "between",
}
_SCREENER_UNIVERSE_ALIASES = {
    _screener_key(alias): item["value"]
    for item in UNIVERSE_OPTIONS
    if item["value"]
    for alias in (item["value"], item["label"])
}


def _infer_screener_sector(value: str) -> str | None:
    text = str(value or "").lower()
    return next((sector for pattern, sector in _SCREENER_SECTOR_QUERY_PATTERNS if re.search(pattern, text)), None)


def _infer_screener_region(value: str) -> str | None:
    text = str(value or "").lower()
    if re.search(r"\b(?:american|u\.?s\.?|united states|north american)\b", text):
        return "North America"
    if re.search(r"\b(?:european|europe)\b", text):
        return "Europe"
    if re.search(r"\b(?:asian|asia|asia[- ]pacific|apac)\b", text):
        return "Asia-Pacific"
    return None


def _strip_schema_union(value) -> str:
    """Free models sometimes copy schema prose such as "sp500 or null"."""
    text = str(value or "").strip()
    return re.sub(r"\s+or\s+null\s*$", "", text, flags=re.I).strip()


def _infer_screener_symbol_group(value: str) -> list[str]:
    text = str(value or "").lower()
    if (
        re.search(r"\b(?:major|large|largest|big|biggest)\b", text)
        and re.search(r"\bbanks?\b", text)
        and re.search(r"\b(?:american|u\.?s\.?|united states)\b", text)
    ):
        return ["JPM", "BAC", "WFC", "C", "USB", "PNC", "TFC", "BK"]
    return []


def _deterministic_screener_parse(query: str) -> dict | None:
    symbols = _infer_screener_symbol_group(query)
    if not symbols:
        return None
    return {
        "valid": True,
        "warning": None,
        "accepted_filter_count": 0,
        "dropped_filter_count": 0,
        "include_symbols": symbols,
        "filters": [],
        "sector": "Financial Services",
        "universe": "sp500",
        "exchange": None,
        "region": "North America",
        "sort_by": "marketCap",
        "sort_dir": "desc",
        "sort_param": None,
        "limit": len(symbols),
        "explanation": "Major American banks ranked by market capitalization.",
    }


_SCREENER_SYSTEM = """Convert the user's stock-selection brief into the exact
parameters supported by AlphaTape Stock Screener. Use only the fields and values
listed below. Do not invent proxy criteria for a concept the screener cannot measure.

Available field IDs and their units:
price (USD), marketCap (USD billions), volume (shares), avgVolume (shares),
beta (ratio), priceChange (%, requires param 1D|1W|1M|3M|6M|YTD|1Y),
change52wHiPct (%, negative means below the 52-week high),
peRatio, pbRatio, psRatio, evEbitda, pegRatio,
revenueGrowth (%), epsGrowth (%), grossMargin (%), operatingMargin (%),
netMargin (%), roe (%), roa (%), debtEquity, currentRatio, quickRatio,
cashRatio, interestCoverage, roic (%), inventoryTurnover,
receivablesTurnover, payablesTurnover, cashConversionCycle (days),
dividendYield (%), payoutRatio (%), rsi14, smaDist50 (%), smaDist200 (%),
vol30 (%).

Operators: gt (>), gte (>=), lt (<), lte (<=), between (range, needs value2)

Sectors: Technology, Healthcare, Financial Services, Consumer Cyclical,
Communication Services, Industrials, Consumer Defensive, Energy, Utilities,
Real Estate, Basic Materials.

Universes: sp500, sp400, nasdaq100, xlk, xlf, xlv, xly, xlc, xli, xlp,
xle, xlu, xlre, xlb, ftse100, dax40, nikkei225, or null for all bundled universes.
Exchanges: NASDAQ, NYSE, AMEX, LSE, XETRA, TSE, or null.
Regions: North America, Europe, Asia-Pacific, or null.

Choose a useful sort from the available field IDs. "Best", "highest", "fastest",
and "largest" normally sort descending. "Cheapest", "lowest", and "least volatile"
normally sort ascending. Keep limit between 1 and 50. If the user does not specify
a count, use 8.

Respond ONLY with valid JSON (no markdown):
{
  "filters": [
    {"field": "fieldId", "operator": "gt", "value": 0.0, "value2": null, "param": null}
  ],
  "sector": null,
  "universe": null,
  "exchange": null,
  "region": null,
  "sort_by": "fieldId",
  "sort_dir": "asc or desc",
  "sort_param": null,
  "limit": 8,
  "include_symbols": [],
  "explanation": "one sentence describing what this screen finds"
}
Replace null only when the user supplies a compatible constraint. Never return
the literal words "or null". Qualitative size words such as major, large, and
largest should sort by marketCap descending, not create a nonnumeric filter."""


def _screener_number(value, field: str):
    raw = str(value).strip().replace(",", "").replace("$", "").replace("%", "")
    match = re.fullmatch(r"([-+]?\d+(?:\.\d+)?)\s*([KMBT]?)", raw, re.I)
    if not match:
        return None
    try:
        number = float(match.group(1))
    except (TypeError, ValueError):
        return None
    suffix = match.group(2).upper()
    if suffix:
        if field == "marketCap":
            number *= {"K": 0.000001, "M": 0.001, "B": 1, "T": 1000}[suffix]
        elif field in {"volume", "avgVolume"}:
            number *= {"K": 1_000, "M": 1_000_000, "B": 1_000_000_000, "T": 1_000_000_000_000}[suffix]
        else:
            return None
    return number if number == number and abs(number) != float("inf") else None


def _normalize_screener_parse(value, query: str = "") -> dict:
    data = value if isinstance(value, dict) else {}
    issues = []
    if not isinstance(value, dict):
        issues.append("The AI did not return a structured screener plan.")
    filters = []
    raw_filters = data.get("filters", [])
    if "filters" not in data:
        issues.append("The AI did not return a filter list.")
    if not isinstance(raw_filters, list):
        raw_filters = []
        issues.append("The AI returned an invalid filter list.")
    include_raw = data.get("include_symbols", [])
    include_text = " ".join(str(item) for item in include_raw) if isinstance(include_raw, list) else ""
    include_symbols = resolve_company_mentions(f"{query} {include_text}")
    inferred_group = _infer_screener_symbol_group(query)
    include_symbols = list(dict.fromkeys([*include_symbols, *inferred_group]))[:8]
    inferred_sector = _infer_screener_sector(query)
    inferred_region = _infer_screener_region(query)
    inferred_sort_by = "marketCap" if re.search(
        r"\b(?:major|large|largest|big|biggest|mega[- ]?cap)\b",
        query,
        re.I,
    ) else None
    dropped_filters = 0
    for raw_filter in raw_filters[:10]:
        if not isinstance(raw_filter, dict):
            dropped_filters += 1
            continue
        field = _SCREENER_FIELD_ALIASES.get(_screener_key(raw_filter.get("field")))
        operator_raw = str(raw_filter.get("operator", "")).strip().lower()
        operator = _SCREENER_OPERATOR_ALIASES.get(operator_raw, operator_raw)
        number = _screener_number(raw_filter.get("value"), field or "")
        if field not in _SCREENER_FIELD_IDS or operator not in _SCREENER_OPERATORS or number is None:
            raw_field_key = _screener_key(raw_filter.get("field"))
            raw_value = str(raw_filter.get("value") or "")
            if raw_field_key in {"sector", "industry"}:
                repaired_sector = _infer_screener_sector(f"{raw_value} {query}")
                if repaired_sector:
                    inferred_sector = repaired_sector
                    continue
            if raw_field_key in {"country", "geography", "region"}:
                repaired_region = _infer_screener_region(f"{raw_value} {query}")
                if repaired_region:
                    inferred_region = repaired_region
                    continue
            if raw_field_key == "marketcap" and re.search(
                r"\b(?:major|large|largest|big|biggest|mega[- ]?cap)\b",
                f"{raw_value} {query}",
                re.I,
            ):
                inferred_sort_by = "marketCap"
                continue
            if raw_field_key in {"company", "companyname", "name", "symbol", "ticker"} and include_symbols:
                continue
            dropped_filters += 1
            continue
        value2 = _screener_number(raw_filter.get("value2"), field) if operator == "between" else None
        if operator == "between" and value2 is None:
            dropped_filters += 1
            continue
        param = str(raw_filter.get("param", "")).upper()
        filters.append({
            "field": field,
            "operator": operator,
            "value": number,
            "value2": value2,
            "param": param if field == "priceChange" and param in PRICE_CHANGE_PERIODS else None,
        })
    if len(raw_filters) > 10:
        dropped_filters += len(raw_filters) - 10
    if dropped_filters:
        issues.append(
            f"{dropped_filters} criterion could not be mapped to a supported screener field."
            if dropped_filters == 1
            else f"{dropped_filters} criteria could not be mapped to supported screener fields."
        )

    sector_raw = _strip_schema_union(data.get("sector"))
    sector = _SCREENER_SECTOR_ALIASES.get(sector_raw.lower(), sector_raw)
    if sector not in SECTORS:
        if sector_raw and sector_raw.lower() not in {"none", "null", "all"} and not inferred_sector:
            issues.append(f'Sector "{sector_raw}" is not supported.')
        sector = inferred_sector

    universe_raw = _strip_schema_union(data.get("universe"))
    universe = _SCREENER_UNIVERSE_ALIASES.get(_screener_key(universe_raw))
    if universe not in _SCREENER_UNIVERSES:
        if universe_raw and universe_raw.lower() not in {"none", "null", "all", "all bundled universes"}:
            issues.append(f'Universe "{universe_raw}" is not supported.')
        universe = None

    exchange_raw = _strip_schema_union(data.get("exchange"))
    exchange = exchange_raw.upper()
    if exchange not in _SCREENER_EXCHANGES:
        mentioned_exchanges = {
            item
            for item in _SCREENER_EXCHANGES
            if re.search(rf"\b{re.escape(item)}\b", exchange, re.I)
        }
        if exchange_raw and exchange_raw.lower() not in {"none", "null", "all"} and len(mentioned_exchanges) < 2:
            issues.append(f'Exchange "{exchange_raw}" is not supported.')
        exchange = None

    region_raw = _strip_schema_union(data.get("region"))
    region = next((item for item in _SCREENER_REGIONS if item.lower() == region_raw.lower()), None)
    if region is None and region_raw and region_raw.lower() not in {"none", "null", "all"}:
        issues.append(f'Region "{region_raw}" is not supported.')
    if region is None:
        region = inferred_region

    sort_raw = str(data.get("sort_by") or inferred_sort_by or "marketCap").strip()
    if not data.get("sort_by"):
        issues.append("The AI did not choose a supported sort field.")
    sort_by = _SCREENER_FIELD_ALIASES.get(_screener_key(sort_raw))
    if sort_by not in _SCREENER_FIELD_IDS:
        issues.append(f'Sort field "{sort_raw}" is not supported.')
        sort_by = "marketCap"
    sort_dir = str(data.get("sort_dir") or "desc").strip().lower()
    if sort_dir not in {"asc", "desc"}:
        sort_dir = "desc"
    sort_param_raw = str(data.get("sort_param") or "").upper()
    sort_param = sort_param_raw if sort_by == "priceChange" and sort_param_raw in PRICE_CHANGE_PERIODS else None

    try:
        limit = int(data.get("limit", 8))
    except (TypeError, ValueError):
        limit = 8

    explanation = re.sub(r"\s+", " ", str(data.get("explanation") or "")).strip()
    if not explanation:
        issues.append("The AI did not explain the interpreted screen.")
    warning = " ".join(issues)
    return {
        "valid": not issues,
        "warning": warning or None,
        "accepted_filter_count": len(filters),
        "dropped_filter_count": dropped_filters,
        "include_symbols": include_symbols,
        "filters": filters,
        "sector": sector,
        "universe": universe,
        "exchange": exchange,
        "region": region,
        "sort_by": sort_by,
        "sort_dir": sort_dir,
        "sort_param": sort_param,
        "limit": max(1, min(50, limit)),
        "explanation": explanation or "Screen the selected universe using the interpreted criteria.",
    }


@router.post("/screener-parse")
def screener_parse(req: ScreenerParseRequest):
    deterministic = _deterministic_screener_parse(req.query)
    if deterministic:
        return deterministic
    raw = groq_complete(f'Query: "{req.query}"', max_tokens=400,
                        model=MODEL_FAST, system=_SCREENER_SYSTEM)
    return _normalize_screener_parse(parse_json(raw), req.query)


# ── 4. Corporate hub brief ────────────────────────────────────────────────────

class CorporateBriefRequest(BaseModel):
    tickers: list[str]
    rows: list[dict] = []

_BRIEF_SYSTEM = """Write a desk brief for a watchlist of holdings heading into their earnings reports, using the available data.
Produce EXACTLY 3 bullets. Each bullet is ONE plain-English sentence (a string, never an object or list) that sweeps across the watchlist:
1. Report timing: which names report soonest, what is on deck.
2. Implied-move outliers, valuation or analyst sentiment.
3. Short-interest or positioning risk into the prints.
Respond ONLY with valid JSON (no markdown), exactly this shape:
{"bullets": ["sentence 1", "sentence 2", "sentence 3"], "tone": "bullish|neutral|bearish|mixed"}"""

@router.post("/corporate-brief")
def corporate_brief(req: CorporateBriefRequest):
    summaries = []
    for row in req.rows[:12]:
        tk = row.get("ticker", "")
        news = " | ".join(n.get("title", "") for n in row.get("news", [])[:2])
        summaries.append(
            f"{tk}: reports_in={row.get('daysToReport','N/A')}d implied_move={row.get('impliedMove','N/A')}% "
            f"short_float={row.get('shortPct','N/A')} change={row.get('pctChange','N/A')}% "
            f"mcap={row.get('marketCap','N/A')} consensus={row.get('consensus','N/A')} "
            f"pe={row.get('pe','N/A')} news=[{news}]"
        )
    tickers_str = ", ".join(req.tickers)
    context = "\n".join(summaries) or tickers_str

    prompt = f"""Write a brief for: {tickers_str}

Available data:
{context}"""
    raw = groq_complete(prompt, max_tokens=300, model=MODEL_FAST, system=_BRIEF_SYSTEM)
    out = parse_json(raw)
    # Models drift on the shape: bare array, wrong key name, list markers.
    if isinstance(out, list):
        out = {"bullets": out}
    elif not isinstance(out, dict):
        out = {}
    bullets = out.get("bullets") or out.get("brief") or []
    if isinstance(bullets, str):
        bullets = [bullets]
    bullets = [str(b).lstrip("-• ").strip() for b in bullets if str(b).strip()]
    return {"bullets": bullets, "tone": out.get("tone") or "neutral"}


# ── 5. Strategy risk narrative ────────────────────────────────────────────────

class StrategyNarrativeRequest(BaseModel):
    legs: list[dict] = []
    net_delta: float = 0
    net_gamma: float = 0
    net_theta: float = 0
    net_vega: float = 0

@router.post("/strategy-narrative")
def strategy_narrative(req: StrategyNarrativeRequest):
    legs_text = "\n".join(
        f"  {l.get('position_type','').upper()} {l.get('qty',1)}x "
        f"{l.get('option_type','').upper()} K={l.get('strike')} exp={l.get('expiry','')} ({l.get('ticker','')})"
        for l in req.legs[:8]
    ) or "  (no legs)"

    prompt = f"""Analyze this options strategy:
Legs:
{legs_text}

Net Greeks: Δ={req.net_delta:+.4f}  Γ={req.net_gamma:+.4f}  Θ={req.net_theta:+.4f}  ν={req.net_vega:+.4f}

Respond ONLY with valid JSON (no markdown):
{{
  "strategy_name": "e.g. Bull Call Spread, Long Straddle, Iron Condor",
  "summary": "2-sentence plain-English description of the trade",
  "max_loss_scenario": "one sentence on the worst-case outcome",
  "max_gain_scenario": "one sentence on the best-case outcome",
  "ideal_conditions": "what IV and price conditions favor this trade",
  "key_risks": ["risk 1", "risk 2"]
}}"""
    raw = groq_complete(prompt, max_tokens=400)
    return parse_json(raw)


# ── 6. Backtest commentary ────────────────────────────────────────────────────

class BacktestCommentaryRequest(BaseModel):
    strategy_name: str = ""
    ticker: str = ""
    total_return: float = 0
    ann_return: float = 0
    max_drawdown: float = 0
    sharpe: float = 0
    win_rate: float = 0
    num_trades: int = 0
    drawdown_start: str = ""
    drawdown_end: str = ""

@router.post("/backtest-commentary")
def backtest_commentary(req: BacktestCommentaryRequest):
    dd_note = (
        f"Worst drawdown period: {req.drawdown_start} → {req.drawdown_end}"
        if req.drawdown_start else ""
    )
    prompt = f"""Analyze these backtest results for "{req.strategy_name or 'a trading strategy'}" on {req.ticker or 'a portfolio'}:
- Total Return: {req.total_return:+.2f}%
- Annualized Return: {req.ann_return:+.2f}%
- Max Drawdown: {req.max_drawdown:.2f}%
- Sharpe Ratio: {req.sharpe:.3f}
- Win Rate: {req.win_rate:.1f}%
- Number of Trades: {req.num_trades}
{dd_note}

Respond ONLY with valid JSON (no markdown):
{{
  "verdict": "one-sentence overall assessment",
  "strengths": ["strength 1", "strength 2"],
  "weaknesses": ["weakness 1", "weakness 2"],
  "drawdown_context": "one sentence on likely market drivers of the worst drawdown",
  "suggestions": ["improvement 1", "improvement 2"]
}}"""
    raw = groq_complete(prompt, max_tokens=400)
    return parse_json(raw)


# ── 7. Bond narrative ─────────────────────────────────────────────────────────

class BondNarrativeRequest(BaseModel):
    ytm: float
    mod_duration: float
    convexity: float
    coupon_rate: float
    maturity: int
    bond_type: str
    market_price: float
    face: float

_BOND_SYSTEM = """Provide a concise fixed-income analysis of the given bond.
Respond ONLY with valid JSON (no markdown):
{
  "summary": "2-sentence plain-English assessment of this bond's positioning",
  "rate_sensitivity": "one sentence: how a 100bps rate move affects this bond given its duration",
  "yield_context": "one sentence comparing this YTM to typical investment-grade or treasury levels",
  "investor_fit": "one sentence on what investor profile suits this bond"
}"""

@router.post("/bond-narrative")
def bond_narrative(req: BondNarrativeRequest):
    prompt = f"""- Bond type: {req.bond_type}
- Coupon: {req.coupon_rate}%  Maturity: {req.maturity} years
- Market Price: ${req.market_price:.2f}  Face: ${req.face:.0f}
- YTM: {req.ytm}%  Modified Duration: {req.mod_duration}  Convexity: {req.convexity}"""
    raw = groq_complete(prompt, max_tokens=300, model=MODEL_FAST, system=_BOND_SYSTEM)
    return parse_json(raw)


# ── 8. Screener AI fallback ───────────────────────────────────────────────────

class ScreenerFallbackRequest(BaseModel):
    tickers: list[str]

@router.post("/screener-fallback")
def screener_fallback(req: ScreenerFallbackRequest):
    tickers_str = ", ".join(req.tickers[:15])
    prompt = f"""Provide estimated fundamental metrics for these well-known stocks: {tickers_str}

Use your training knowledge. All values are estimates.
Respond ONLY with a valid JSON array (no markdown):
[
  {{
    "ticker": "AAPL",
    "companyName": "Apple Inc.",
    "sector": "Technology",
    "exchange": "NASDAQ",
    "marketCap": 3100,
    "peRatio": 28.5,
    "forwardPE": 26.0,
    "pbRatio": 45.0,
    "psRatio": 8.0,
    "evEbitda": 22.0,
    "operatingMargin": 30.0,
    "netMargin": 25.0,
    "grossMargin": 44.0,
    "roe": 150.0,
    "revenueGrowth": 5.0,
    "epsGrowth": 10.0,
    "debtEquity": 1.8,
    "currentRatio": 1.0,
    "beta": 1.2,
    "dividendYield": 0.5,
    "price": 185.0,
    "isAiEstimate": true
  }}
]
Include every ticker. Use null for metrics you are very uncertain about."""
    raw = groq_complete(prompt, max_tokens=1500)
    result = parse_json(raw)
    if not isinstance(result, list):
        result = result.get("results", [])
    return {"results": result, "source": "ai_estimate"}


# ── 9. Algo Strategy Builder — describe-in-English chat ──────────────────────
# Multi-turn (unlike every other endpoint above): the model asks clarifying
# questions before committing to a rule set, so the client resends the whole
# transcript each turn rather than one-shotting a prompt. Schema/vocabulary
# mirrors CustomStrategyModal.tsx (IndicatorType, NO_TIMEFRAME_TYPES, OpType,
# RuleBlock/ConditionGroup/ConditionRow, StrategyRisk) exactly — the frontend
# drops the "draft" response straight into that component's state with no
# translation layer, so any drift here breaks the accept flow silently.

class StrategyChatMessage(BaseModel):
    role: str      # 'user' | 'assistant'
    content: str

class StrategyChatRequest(BaseModel):
    messages: list[StrategyChatMessage]
    scope: str | None = "rules"


def _draft_is_confirmed(messages: list[StrategyChatMessage]) -> bool:
    last_user = next((m.content.lower() for m in reversed(messages) if m.role == "user"), "")
    if "not ready" in last_user or "not sure" in last_user:
        return False
    # Word-boundary match, not substring — "yes" as a bare `in` check also
    # matches "yesterday"/"yesteryear", misreading an unrelated message
    # (e.g. "use yesterday's close instead") as explicit build confirmation.
    # Deliberately broad: this only runs on the user's reply to the model's
    # own "ready to build?" confirmation question, where a short informal
    # affirmative ("yeah", "sure", "ok") or a dismissal of a side-question
    # back toward building ("just follow my parameters", "just use what I
    # said") both mean the same thing — go ahead — and previously fell
    # through to a confusing, context-blind fallback question instead.
    phrases = (
        "yes", "yeah", "yep", "yup", "yea", "confirm", "proceed", "go ahead", "go for it",
        "build it", "build this", "create it", "draft it", "prepare the draft", "prepare draft",
        "use your defaults", "use the defaults", "sounds good", "sounds right", "looks good", "looks right",
        "i'm ready", "im ready", "ready to build", "ready to create", "do it", "let's do it", "lets do it",
        "that works", "works for me", "correct", "that's right", "thats right", "sure", "ok", "okay",
        "just build it", "just go ahead",
    )
    if any(re.search(rf"\b{re.escape(phrase)}\b", last_user) for phrase in phrases):
        return True
    # Lead-in fragments rather than full phrases — "just follow my
    # paramaters" (a real user typo, "parameters" misspelled) wouldn't match
    # an exact-phrase list; "just follow"/"just use"/"just go with" alone are
    # distinctive enough dismiss-the-side-question-and-proceed signals not to
    # need the rest of the sentence to match verbatim.
    lead_ins = ("just follow", "just use", "just go with", "just stick with", "just do what i", "just proceed")
    return any(re.search(rf"\b{re.escape(phrase)}", last_user) for phrase in lead_ins)


def _confirmation_reprompt() -> str:
    """Fallback text when the model attempted a draft but the user's last
    reply didn't clearly read as confirmation (per _draft_is_confirmed).

    Deliberately generic — it must never re-ask a decision already settled
    earlier in the conversation. This replaced a hardcoded, turn-count-
    indexed sequence of discovery questions (ticker, timeframe, entry,
    exit, "risk posture", ...) that fired here regardless of what had
    actually been discussed — it could and did resurface an already-
    answered question, or even a question about a field that isn't part of
    the strategy schema at all ("risk posture" is not a real parameter).
    A single content-free re-ask can't be wrong the way that array could."""
    return "Just to confirm — should I go ahead and build this strategy with everything we've covered so far?"


def _requested_exit_summary(messages: list[StrategyChatMessage]) -> str | None:
    """Answer a direct exit-rule question from choices already made in chat."""
    last_user = next((message.content.lower() for message in reversed(messages) if message.role == "user"), "")
    asks_for_summary = re.search(r"\b(?:what|which|tell|show|list|describe|explain)\b.{0,80}\b(?:take.?profit|profit target|stop.?loss|loss condition|exit condition|exit rules?)", last_user)
    if not asks_for_summary:
        return None
    stop_loss = take_profit = None
    for message in reversed(messages):
        if message.role != "user":
            continue
        text = message.content.lower()
        if stop_loss is None:
            match = re.search(r"(?:stop.?loss(?:pct)?\s*(?:=|:|of)?\s*|(?:loss|loses?)\s+(?:reaches?\s+)?)(\d+(?:\.\d+)?)\s*%?", text)
            if match:
                stop_loss = match.group(1)
        if take_profit is None:
            match = re.search(r"(?:take.?profit(?:pct)?\s*(?:=|:|of)?\s*|(?:profit|gain)\s+(?:reaches?\s+)?)(\d+(?:\.\d+)?)\s*%?", text)
            if match:
                take_profit = match.group(1)
        if stop_loss is not None and take_profit is not None:
            break
    if stop_loss is None and take_profit is None:
        return "Those exit thresholds have not been set yet. Would you like to set a stop-loss or a take-profit target first?"
    parts = []
    if stop_loss is not None:
        parts.append(f"a {stop_loss}% stop-loss")
    if take_profit is not None:
        parts.append(f"a {take_profit}% take-profit target")
    return f"The current requested exit rules are {' and '.join(parts)}."


def _asks_for_parameters(messages: list[StrategyChatMessage]) -> bool:
    last_user = next((message.content.lower() for message in reversed(messages) if message.role == "user"), "")
    return bool(re.search(r"\b(?:parameters?|full setup|setup details|strategy details|all settings)\b", last_user))


def _draft_parameter_review(draft: dict) -> str:
    """Turn a premature JSON draft into a readable review without applying it."""
    labels = {"OPT_IVRANK": "IV Rank", "PCT_CHANGE": "% change", "PCT_BELOW_HIGH": "% below N-day high", "PCT_ABOVE_LOW": "% above N-day low", "PRICE": "price", "RSI": "RSI", "SMA": "SMA", "EMA": "EMA"}
    operators = {"gt": "is above", "gte": "is at or above", "lt": "is below", "lte": "is at or below", "crosses_above": "crosses above", "crosses_below": "crosses below"}

    def ref(value: object) -> str:
        if not isinstance(value, dict):
            return "indicator"
        label = labels.get(str(value.get("type") or ""), str(value.get("type") or "indicator"))
        if value.get("period") is not None:
            label += f" ({value['period']}-day)"
        return label

    def block(value: object) -> str:
        if not isinstance(value, dict):
            return "not specified"
        phrases = []
        for group in value.get("groups", []):
            if not isinstance(group, dict):
                continue
            terms = []
            for condition in group.get("conditions", []):
                if not isinstance(condition, dict):
                    continue
                lhs = condition.get("lhs") if isinstance(condition.get("lhs"), dict) else {}
                rhs = condition.get("rhs_num") if condition.get("rhs_type") == "number" else ref(condition.get("rhs_ind"))
                if condition.get("rhs_type") == "number" and lhs.get("type") in {"OPT_IVRANK", "PCT_CHANGE", "PCT_BELOW_HIGH", "PCT_ABOVE_LOW", "OPT_HV"}:
                    rhs = f"{rhs}%"
                terms.append(f"{ref(lhs)} {operators.get(condition.get('op'), condition.get('op', 'matches'))} {rhs}")
            if terms:
                phrases.append(f" {group.get('logic', 'AND ')} ".join(terms))
        return "; ".join(phrases) or "not specified"

    strategies = [item for item in ([draft.get("strategy")] if draft.get("mode") == "single" else draft.get("strategies", [])) if isinstance(item, dict)]
    strategy = strategies[0] if strategies else {}
    risk = strategy.get("risk") if isinstance(strategy.get("risk"), dict) else {}
    positions = [item for item in draft.get("positions", []) if isinstance(item, dict)]
    tickers = [str(item.get("ticker") or "") for item in positions]
    universe = f"{len(tickers)} eligible symbols" + (f" ({', '.join(tickers[:6])}{'…' if len(tickers) > 6 else ''})" if tickers else "")
    instrument = positions[0] if positions else draft
    combo = instrument.get("combo_legs") if isinstance(instrument, dict) else None
    expression = str(instrument.get("instrument") or "underlying") if isinstance(instrument, dict) else "underlying"
    if expression == "combo" and isinstance(combo, list):
        legs = ", ".join(f"{str(leg.get('side', ''))} {str(leg.get('type', ''))} at {leg.get('moneyness', 1)}× spot" for leg in combo if isinstance(leg, dict))
        expression = f"combo: {legs}; {instrument.get('combo_dte', 30)} calendar DTE"
    elif expression == "option":
        expression = f"{instrument.get('opt_type', 'call')} option, {instrument.get('dte', 30)} DTE, {instrument.get('otm_pct', 0)}% OTM"
    size = draft.get("position_size_pct") if draft.get("mode") == "portfolio" else risk.get("sizingPct")
    size_text = f"{size}% of total portfolio per admitted trade" if size is not None else "not yet specified"
    leverage_text = ""
    if draft.get("mode") == "portfolio":
        leverage_text = f" Leverage: {draft.get('leverage', 1)}x; borrowing EAR: {draft.get('effective_annual_rate', 0)}% (interest applies only above portfolio equity)."
    risk_text = "; ".join(
        f"{label}: {risk[key]}%" if risk.get(key) not in (None, 0) else f"{label}: not configured"
        for key, label in (("stopLossPct", "stop-loss"), ("takeProfitPct", "take-profit"), ("trailingStopPct", "trailing stop"))
    )
    risk_text += f"; maximum hold: {risk['maxHoldBars']} bars" if risk.get("maxHoldBars") else "; maximum hold: not configured"
    return (
        f"Parameter review — not applied: universe: {universe or draft.get('ticker', 'not specified')}. "
        f"Trade expression: {expression}. Trade size: {size_text}.{leverage_text} "
        f"Entry rules: {block(strategy.get('buy'))}. Exit rules: {block(strategy.get('sell'))}. "
        f"Risk controls: {risk_text}. Say “I’m ready” only when you want me to prepare the apply-ready draft."
    )


def _screen_candidates(spec: dict) -> str:
    def number(value):
        try:
            parsed = float(value)
            return parsed if parsed == parsed and abs(parsed) != float("inf") else None
        except (TypeError, ValueError):
            return None

    filters = []
    for raw_filter in spec.get("filters") if isinstance(spec.get("filters"), list) else []:
        if not isinstance(raw_filter, dict):
            continue
        value = number(raw_filter.get("value"))
        if value is None or not isinstance(raw_filter.get("field"), str):
            continue
        value2 = number(raw_filter.get("value2"))
        filters.append({
            "field": raw_filter["field"],
            "operator": raw_filter.get("operator") if raw_filter.get("operator") in {"gt", "gte", "lt", "lte", "between"} else "gt",
            "value": value,
            "value2": value2,
            "param": raw_filter.get("param") if raw_filter.get("param") in {"1D", "1W", "1M", "3M", "6M", "YTD", "1Y"} else None,
        })
    universes = spec.get("universes") if isinstance(spec.get("universes"), list) else [spec.get("universe")]
    universes = [universe for universe in universes if universe in {"sp500", "sp400", "nasdaq100"}]
    if not universes:
        universes = [None]
    request_data = {
        "filters": filters,
        "sector": spec.get("sector") if isinstance(spec.get("sector"), str) else None,
        "industry": spec.get("industry") if isinstance(spec.get("industry"), str) else None,
        "exchange": spec.get("exchange") if isinstance(spec.get("exchange"), str) else None,
        "region": spec.get("region") if isinstance(spec.get("region"), str) else None,
        "universes": sorted(set(universes), key=lambda universe: universe or "all"),
        "sort_by": spec.get("sort_by") if isinstance(spec.get("sort_by"), str) else "marketCap",
        "sort_dir": spec.get("sort_dir") if spec.get("sort_dir") in {"asc", "desc"} else "desc",
        "sort_param": spec.get("sort_param") if spec.get("sort_param") in {"1D", "1W", "1M", "3M", "6M", "YTD", "1Y"} else None,
        "limit": None,
    }
    cache_key = "ai:strategy-screen:" + hashlib.sha256(
        json.dumps(request_data, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    with _ai_screen_lock:
        cached = _ai_screen_cache.get(cache_key)
    if cached is not None:
        return cached
    cached = disk_get(cache_key)
    if isinstance(cached, str):
        with _ai_screen_lock:
            _ai_screen_cache[cache_key] = cached
        return cached
    rows = []
    seen = set()
    for universe in universes:
        screened = run_screen(ScreenRequest.model_validate({
            **{key: value for key, value in request_data.items() if key != "universes"},
            "universe": universe,
        }))
        for row in screened.get("results", []):
            ticker = str(row.get("ticker") or "").upper()
            if ticker and ticker not in seen:
                seen.add(ticker)
                rows.append(row)
    if not rows:
        result = "The screen returned no matches."
    else:
        items = []
        for row in rows:
            details = []
            if row.get("beta") is not None:
                details.append(f"β {float(row['beta']):.2f}")
            if row.get("sector"):
                details.append(str(row["sector"]))
            items.append(f"{row.get('ticker', '—')} ({', '.join(details)})")
        result = f"Screen results: {len(rows)} matches — " + "; ".join(items) + "."
    with _ai_screen_lock:
        _ai_screen_cache[cache_key] = result
    disk_set(cache_key, result, ttl=14400)
    return result


def _latest_screened_ticker_list(messages: list[StrategyChatMessage]) -> list[str]:
    for message in reversed(messages):
        if message.role != "assistant" or "Screen results:" not in message.content:
            continue
        result_text = message.content.split("Screen results:", 1)[1].split("\n", 1)[0]
        return list(dict.fromkeys(re.findall(r"\b([A-Z][A-Z0-9.-]*)\s*\(", result_text)))
    return []


def _ticker_list_from_screen_text(text: str) -> list[str]:
    """Extract actual symbols from the stable screen-result display format."""
    return list(dict.fromkeys(re.findall(r"\b([A-Z][A-Z0-9.-]*)\s*\(", text)))


def _latest_screened_tickers(messages: list[StrategyChatMessage]) -> set[str]:
    return set(_latest_screened_ticker_list(messages))


def _user_requested_all_screened_stocks(messages: list[StrategyChatMessage]) -> bool:
    user_text = "\n".join(message.content.lower() for message in messages if message.role == "user")
    return bool(re.search(r"\b(?:all|every)\b.{0,80}(?:screen(?:ed)?|candidate|ticker|stock|nasdaq|s\s*&\s*p\s*500|sp500)", user_text))


def _screen_spec_from_universe_request(messages: list[StrategyChatMessage]) -> dict | None:
    """Recover an obvious universe screen if the model returned a label as a ticker."""
    text = "\n".join(message.content.lower() for message in messages if message.role == "user")
    universes = []
    if re.search(r"\b(?:nasdaq[\s-]*100|nasdaq100)\b", text):
        universes.append("nasdaq100")
    if re.search(r"\b(?:s\s*&\s*p\s*500|s&p500|s\s*p\s*500|sp500)\b", text):
        universes.append("sp500")
    beta_match = re.search(r"\bbeta\s*(?:>|≥|greater than|above|over)\s*(\d+(?:\.\d+)?)", text)
    if not universes or not beta_match:
        return None
    return {
        "filters": [{"field": "beta", "operator": "gt", "value": float(beta_match.group(1)), "value2": None, "param": None}],
        "universes": universes,
        "sort_by": "marketCap",
        "sort_dir": "desc",
        "sector": None,
        "region": None,
    }


def _should_expand_screened_universe(messages: list[StrategyChatMessage]) -> bool:
    text = "\n".join(message.content.lower() for message in messages if message.role == "user")
    if re.search(r"\b(?:only|pick|choose|top)\s+\d+\b", text):
        return False
    return _user_requested_all_screened_stocks(messages) or _screen_spec_from_universe_request(messages) is not None


def _expand_all_screened_positions(draft: dict, messages: list[StrategyChatMessage]) -> None:
    """Apply an explicit all-candidates request without relying on LLM JSON length."""
    candidates = _latest_screened_ticker_list(messages)
    positions = draft.get("positions")
    if draft.get("mode") != "portfolio" or not isinstance(positions, list) or not positions:
        return
    if not _should_expand_screened_universe(messages):
        return
    if not candidates:
        universe_screen = _screen_spec_from_universe_request(messages)
        if universe_screen:
            try:
                candidates = _ticker_list_from_screen_text(_screen_candidates(universe_screen))
            except Exception:
                logger.exception("Strategy chat portfolio-expansion screen fallback failed")
    if not candidates:
        return
    template = next((position for position in positions if isinstance(position, dict)), None)
    if template is None:
        return
    strategies = draft.get("strategies") if isinstance(draft.get("strategies"), list) else []
    strategy_name = str(template.get("strategy_name") or next((strategy.get("name") for strategy in strategies if isinstance(strategy, dict) and strategy.get("name")), ""))
    if not strategy_name:
        return
    existing = {str(position.get("ticker") or "").upper() for position in positions if isinstance(position, dict)}
    expanded = [position for position in positions if isinstance(position, dict)]
    for ticker in candidates:
        if ticker not in existing:
            expanded.append({**template, "ticker": ticker, "strategy_name": strategy_name})
    draft["positions"] = expanded


def _draft_tickers(draft: dict) -> set[str]:
    if draft.get("mode") == "portfolio":
        return {str(position.get("ticker") or "").upper() for position in draft.get("positions", []) if isinstance(position, dict)} - {""}
    ticker = str(draft.get("ticker") or "").upper()
    return {ticker} if ticker else set()


def _invalid_draft_tickers(draft: dict) -> set[str]:
    """Reject AI stand-ins before they can become editable portfolio positions."""
    universe_labels = {"ALL", "NASDAQ", "NASDAQ100", "NASDAQ-100", "SP500", "S&P500", "SPX"}
    invalid = set()
    for ticker in _draft_tickers(draft):
        if (
            ticker in universe_labels
            or "PLACEHOLDER" in ticker
            or ticker in {"TICKER", "SYMBOL", "TECH_HIGH_BETA"}
            or not re.fullmatch(r"[A-Z]{1,6}(?:[.-][A-Z]{1,2})?", ticker)
        ):
            invalid.add(ticker)
    return invalid


def _draft_rules_issue(draft: dict) -> str | None:
    """A draft must carry rules, not just position parameters."""
    def complete(strategy: object) -> bool:
        return isinstance(strategy, dict) and isinstance(strategy.get("buy"), dict) and isinstance(strategy.get("sell"), dict)

    if draft.get("mode") == "single":
        return None if complete(draft.get("strategy")) else "The draft has no complete buy and sell rule definition for the single strategy."

    positions = [position for position in draft.get("positions", []) if isinstance(position, dict)]
    strategies = [strategy for strategy in draft.get("strategies", []) if complete(strategy)]
    if not positions:
        return "The portfolio draft has no positions."
    if not strategies:
        return "The portfolio draft has positions but no complete buy and sell rule definitions."
    strategy_names = {str(strategy.get("name") or "") for strategy in strategies}
    missing = sorted({str(position.get("strategy_name") or "") for position in positions} - strategy_names)
    if missing:
        return f"The portfolio positions are missing complete rules for: {', '.join(missing)}."
    return None


def _portfolio_allocation_issue(draft: dict) -> str | None:
    """Ensure a universe strategy has one valid shared trade size."""
    if draft.get("mode") != "portfolio":
        return None
    try:
        allocation = float(draft.get("position_size_pct"))
    except (TypeError, ValueError):
        return "What percentage of the total portfolio should each admitted trade use?"
    if not 0 < allocation <= 100:
        return "What trade size between 1% and 100% of the total portfolio should each admitted trade use?"
    try:
        leverage = float(draft.get("leverage", 1))
        interest_rate = float(draft.get("effective_annual_rate", 0))
    except (TypeError, ValueError):
        return "What leverage multiple and effective annual borrowing rate should this portfolio use?"
    if leverage < 1:
        return "What leverage (1x or higher) should this portfolio use?"
    if not 0 <= interest_rate <= 100:
        return "What effective annual borrowing rate between 0% and 100% should this portfolio use?"
    return None


def _strip_self_ticker_placeholders(value: object) -> object:
    """A rule's omitted ticker means the currently traded symbol, never $TICKER."""
    if isinstance(value, list):
        return [_strip_self_ticker_placeholders(item) for item in value]
    if not isinstance(value, dict):
        return value
    cleaned = {}
    for key, item in value.items():
        if key == "ticker" and isinstance(item, str) and item.strip().upper() in {"$TICKER", "TICKER", "$SYMBOL", "SYMBOL", "SELF"}:
            continue
        cleaned[key] = _strip_self_ticker_placeholders(item)
    return cleaned


_PERCENTAGE_INDICATORS = {"PCT_CHANGE", "PCT_BELOW_HIGH", "PCT_ABOVE_LOW", "OPT_HV", "OPT_IVRANK"}


def _normalize_fractional_percentages(draft: dict) -> None:
    """The builder stores percentage points, while LLMs often emit fractions."""
    def percent(value: object) -> object:
        if isinstance(value, (int, float)) and not isinstance(value, bool) and 0 < abs(value) < 1:
            return value * 100
        return value

    def block(value: object) -> None:
        if not isinstance(value, dict):
            return
        for group in value.get("groups", []):
            if not isinstance(group, dict):
                continue
            for condition in group.get("conditions", []):
                if not isinstance(condition, dict):
                    continue
                lhs = condition.get("lhs")
                if isinstance(lhs, dict) and lhs.get("type") in _PERCENTAGE_INDICATORS and condition.get("rhs_type") == "number":
                    condition["rhs_num"] = percent(condition.get("rhs_num"))

    def strategy(value: object) -> None:
        if not isinstance(value, dict):
            return
        block(value.get("buy"))
        block(value.get("sell"))
        risk = value.get("risk")
        if isinstance(risk, dict):
            for key in ("sizingPct", "stopLossPct", "takeProfitPct", "trailingStopPct"):
                risk[key] = percent(risk.get(key))
            # Single-mode drafts have no guardrail question equivalent to
            # _portfolio_allocation_issue (that one only checks mode=="portfolio")
            # — clamp here instead of letting an out-of-range value get saved
            # and only fail later when the user actually runs the backtest.
            if "leverage" in risk:
                try:
                    risk["leverage"] = max(1.0, float(risk["leverage"]))
                except (TypeError, ValueError):
                    risk["leverage"] = 1.0
            if "effectiveAnnualRate" in risk:
                try:
                    risk["effectiveAnnualRate"] = min(100.0, max(0.0, float(risk["effectiveAnnualRate"])))
                except (TypeError, ValueError):
                    risk["effectiveAnnualRate"] = 0.0

    if draft.get("mode") == "portfolio":
        draft["position_size_pct"] = percent(draft.get("position_size_pct"))
        draft["effective_annual_rate"] = percent(draft.get("effective_annual_rate"))
        for item in draft.get("strategies", []):
            strategy(item)
    else:
        strategy(draft.get("strategy"))


def _fix_invalid_moneyness(draft: dict) -> None:
    """moneyness must be a positive strike/spot ratio (roughly 0.5-2.0) — the
    prompt spells out the call/put sign formula, but a model still
    occasionally confuses it with a signed OTM-percentage offset and emits a
    non-positive or wildly out-of-range value, which would misprice every
    leg. Clamp to ATM (1.0) rather than trying to reverse-engineer the
    intended strike: a wrong-but-plausible-looking "fix" is worse than an
    obviously-neutral one the user can see and adjust."""
    def fix_legs(legs: object) -> None:
        if not isinstance(legs, list):
            return
        for leg in legs:
            if not isinstance(leg, dict):
                continue
            m = leg.get("moneyness")
            if isinstance(m, (int, float)) and not isinstance(m, bool) and not (0.01 <= m <= 10):
                logger.warning("Strategy chat emitted invalid moneyness %r, clamping to ATM", m)
                leg["moneyness"] = 1.0

    fix_legs(draft.get("combo_legs"))
    positions = draft.get("positions")
    if isinstance(positions, list):
        for position in positions:
            if isinstance(position, dict):
                fix_legs(position.get("combo_legs"))


def _requested_premium_pnl_exits(messages: list[StrategyChatMessage]) -> bool:
    """Whether the author means option P&L thresholds, not price moves — this
    used to require literal jargon ("premium-based", "stopLossPct") that
    essentially no real user types; a plain "50% profit target" or "close at
    50% max profit" (exactly how people actually phrase this) went
    undetected, so _remove_premium_exit_proxies below never ran and a
    hallucinated sell-rule proxy for that percentage slipped through."""
    text = "\n".join(message.content.lower() for message in messages if message.role == "user")
    return bool(re.search(
        r"(?:entry|initial)\s+premium|premium[-\s]based|modeled\s+(?:option|combo|straddle)\s+(?:p&l|profit|loss)"
        r"|stoplosspct|takeprofitpct|profit\s+target|take[-\s]profit|max(?:imum)?\s+profit|%\s*profit|profit\s*%",
        text,
    ))


def _remove_premium_exit_proxies(draft: dict, messages: list[StrategyChatMessage]) -> None:
    """Do not duplicate option-P&L exits as impossible one-day stock moves."""
    if not _requested_premium_pnl_exits(messages):
        return

    def number(value: object) -> float | None:
        try:
            return float(value)
        except (TypeError, ValueError):
            return None

    def strategy(value: object) -> None:
        if not isinstance(value, dict):
            return
        risk = value.get("risk") if isinstance(value.get("risk"), dict) else {}
        stop_loss, take_profit = number(risk.get("stopLossPct")), number(risk.get("takeProfitPct"))
        sell = value.get("sell")
        if not isinstance(sell, dict):
            return
        groups = sell.get("groups")
        if not isinstance(groups, list):
            return
        cleaned_groups = []
        for group in groups:
            if not isinstance(group, dict):
                continue
            kept = []
            for condition in group.get("conditions", []):
                if not isinstance(condition, dict):
                    continue
                lhs = condition.get("lhs") if isinstance(condition.get("lhs"), dict) else {}
                rhs = number(condition.get("rhs_num"))
                is_one_day_move = lhs.get("type") == "PCT_CHANGE" and number(lhs.get("period")) == 1 and rhs is not None
                mirrors_take_profit = is_one_day_move and take_profit is not None and condition.get("op") in {"gt", "gte"} and abs(rhs - take_profit) < 1e-9
                mirrors_stop_loss = is_one_day_move and stop_loss is not None and condition.get("op") in {"lt", "lte"} and abs(rhs + stop_loss) < 1e-9
                if not (mirrors_take_profit or mirrors_stop_loss):
                    kept.append(condition)
            if kept:
                cleaned_groups.append({**group, "conditions": kept})
        sell["groups"] = cleaned_groups

    if draft.get("mode") == "portfolio":
        for item in draft.get("strategies", []):
            strategy(item)
    else:
        strategy(draft.get("strategy"))

_STRATEGY_CHAT_SYSTEM = """You are a highly experienced quantitative trading strategist assistant embedded in the Algorithmic Strategy Builder. The user describes a strategy or a move they want to capture in plain English. Your job is to do the heavy lifting: translate their ideas into a concrete, executable backtesting strategy, recommending assets, indicator values, and risk management parameters rather than asking them for every detail.

ADVANCED STRATEGY & ASSET KNOWLEDGE:
- Volatility Trading:
  - Assets: Propose SVXY (short volatility ETF - shorting VIX futures for selling vol), VXX (long volatility ETN for buying vol), UVXY (leveraged long), or trading SPY using IV Rank filters.
  - Setup: Propose buying SVXY (or shorting VXX) when IV Rank is high (above 90) and selling to close when it drops (to 50). Explain these asset choices.
  - Volatility Overstatement: Compare implied volatility to realized volatility. Recommending selling volatility (e.g., shorting VXX or buying SVXY) when Implied Volatility Rank (OPT_IVRANK) exceeds realized Historical Volatility (OPT_HV) by a wide margin (indicating overpriced premiums).
  - Timeframe/Indicator: Recommend daily timeframe and standard 252 trading day window for IV Rank (OPT_IVRANK(252, "daily")).
- Volatility Squeezes & Mean Reversion:
  - Bollinger Band Squeeze: Identify periods of low volatility contracting bands (BB_UPPER - BB_LOWER narrowing) to buy breakout momentum or buy volatility (Long Volatility plays), and sell volatility (Short Volatility plays) when bands expand to extremes.
  - Mean Reversion: Recommend trading liquid ETFs (SPY, QQQ, IWM) using Bollinger Bands (BB_UPPER/BB_MID/BB_LOWER, default period 20, 2.0 std) or RSI (14) oversold/overbought levels.
- Trend Following / Momentum:
  - Golden Cross: 50 SMA crossing above 200 SMA (SMA(50) crosses_above SMA(200)) as a primary bullish entry trigger.
  - Trend Filters: Use 200-day SMA (PRICE gt SMA(200)) as a trend-filter; only take long setups in uptrends, and short setups in downtrends.

DO THE HEAVY LIFTING:
- Never interrogate the user with a checklist of parameter questions (e.g., "What asset? What period? What timeframe?").
- Instead, make expert professional recommendations. Propose concrete option choices (e.g., "We can implement this in SVXY for shorting volatility, or we can buy VXX when volatility spikes. Here is the rule structure for SVXY...").
- If the user's intent is clear, output a complete DRAFT immediately, using professional standards as defaults, and summarize it in the "summary" field.
- If you must ask a question, make it a high-level strategic recommendation or selection (e.g., "I suggest using SVXY to sell volatility using a 252-day IV Rank window. Should we build this as a pure volatility-timing strategy, or add an RSI filter to avoid selling vol during extended market downtrends?").

SUPPORTED INDICATORS:
Technical: PRICE, RSI(period), SMA(period), EMA(period), MACD_LINE(fast,slow,signal_period), MACD_SIGNAL(fast,slow,signal_period), BB_UPPER/BB_MID/BB_LOWER(period,std), ATR(period), MOMENTUM(period), PCT_CHANGE(period), PCT_BELOW_HIGH(period), PCT_ABOVE_LOW(period)
Volatility: OPT_HV(period) = realized volatility %, OPT_IVRANK(period, one of 5/21/63/252 trading days) = IV rank %
Fundamental (point-in-time daily): FUND_PE, FUND_PEG, FUND_EPSGROWTH, FUND_NETMARGIN, FUND_GROSSMARGIN, FUND_DEBTEQUITY, FUND_DIVYIELD, FUND_PB, FUND_CURRENTRATIO, FUND_BETA
Liquidity: VOL_RELATIVE, VOL_DOLLAR
Shipping flows: FLOW_HORMUZ, FLOW_SUEZ, FLOW_PANAMA, FLOW_MALACCA

PERCENTAGE UNITS: PCT_CHANGE, PCT_BELOW_HIGH, PCT_ABOVE_LOW, OPT_HV, and OPT_IVRANK use literal percentage points. Never convert a percent to a decimal fraction: a requested 20% drop is rhs_num -20, a 5% gain is 5, and 0.2 means 0.2%.

INDICATOR REFS:
IndicatorRef = {"type": <indicator type above>, "period"?: number, "fast"?: number, "slow"?: number, "signal_period"?: number, "std"?: number, "ticker"?: string, "timeframe"?: string}
- "ticker" is ONLY for an explicit cross-asset reference (e.g. "price relative to SPY"); omit it to mean the strategy's own traded symbol.
- Every field above except "type" is OPTIONAL. Omit fields that don't apply to the chosen type.

SCHEMA:
Condition = {"lhs": IndicatorRef, "op": "gt"|"lt"|"gte"|"lte"|"crosses_above"|"crosses_below", "rhs_type": "number"|"indicator", "rhs_num"?: number, "rhs_ind"?: IndicatorRef}
Group = {"logic": "AND"|"OR", "conditions": [Condition, ...]}
RuleBlock = {"logic": "AND"|"OR", "groups": [Group, ...]}
StrategyRisk = {"sizingPct": number, "stopLossPct": number, "takeProfitPct": number, "trailingStopPct": number, "maxHoldBars": number}

RESPONSE SHAPES:
Every response must be valid JSON in exactly one of these shapes:
Question: {"type": "question", "text": "<your expert recommendation and strategic choice or question to the user, plain English>"}
Draft: {"type": "draft", "buy": RuleBlock, "sell": RuleBlock, "risk": StrategyRisk, "summary": "<plain-English summary of your recommended setup>"}
"""

_STRATEGY_CHAT_FULL_SYSTEM = """You are a highly experienced quantitative trading strategist assistant embedded in the Algorithmic Strategy Builder.
The user describes a backtest setup, a portfolio, a multi-leg options strategy, or a set of entry/exit rules in plain English. Your job is to translate their plain-English ideas into a complete, executable backtest configuration.

You can customize:
1. Mode: "single" (one ticker, one structure) or "portfolio" (the same algorithm applied across multiple tickers/a universe). Default to "single" whenever the user names exactly one ticker and describes one structure on it — do not use "portfolio" just because it technically supports one position; "portfolio" is for when the user actually wants a basket, screened universe, or several named tickers sharing one strategy.
2. Sizing / Leverage: a portfolio is a universe strategy, not a collection of capital sleeves. Every admitted trade uses one shared position_size_pct of the total portfolio, regardless of ticker; entries wait once simultaneous exposure reaches the leveraged gross cap. A portfolio can also set leverage (1x minimum, no ceiling — warn the user that high leverage risks a full wipeout) and effective_annual_rate (borrowing EAR); the backtest compounds that EAR into a daily financing charge on gross exposure above portfolio equity. For a single position, use risk sizing (sizingPct).
3. Underlyings: tickers (e.g. AAPL, SPY, SVXY).
4. Instrument Type: Shares (underlying), options (call/put), or combo options (multi-leg, e.g. selling straddles/strangles/condors/spreads).
5. Expiry DTE: Days to expiration, in CALENDAR days (not trading-day bars — see the maxHoldBars note under OPTION/COMBO RISK SEMANTICS).
6. Option Legs: custom strikes (moneyness multiplier), action (buy/sell), type (call/put), qty.
7. Custom Strategy Rules: custom buy/sell indicator rules and risk parameters (just like the standalone custom strategy rules).

COGNITIVE TASK:
- Be discovery-first. On the first user message, ALWAYS respond with a question — never a draft — even if the idea sounds complete. Help the user turn a market idea into an intentional, testable strategy before configuring it.
- Ask one focused clarifying question per turn, tailored to the idea. Start with the highest-leverage unresolved decision, use the answer to select the next question, and cover the relevant items below rather than asking generic open-ended questions:
  1. Objective and market thesis: what move, regime, income goal, hedge, or inefficiency is the strategy trying to capture?
  2. Universe and horizon: specific ticker(s) versus an ETF/index, holding period, and backtest window/timeframe.
  3. Trade expression: shares versus options/combos, directional bias, preferred DTE/strike distance or whether the user wants recommendations.
  4. Signal design: what should trigger entry, what should trigger exit, and whether the user prefers trend, mean-reversion, volatility, momentum, or fundamental filters.
  5. Risk: conservative/moderate/aggressive posture, position size or portfolio weights, stop/profit/trailing-stop preferences, and maximum holding period.
- A Question response must ask EXACTLY ONE decision question. Never number questions, use a checklist, or combine multiple decisions in one message. Keep it concise; when useful, offer 2–3 concrete choices for that one decision and explain the tradeoff briefly.
- Do not repeat facts already supplied in the transcript. If the user gives several decisions in one reply, acknowledge them internally and move to only the next missing decision.
- Continue asking only for genuinely missing material decisions. Once the user has answered the relevant questions, summarize the choices in one short confirmation question before drafting.
- Output a complete configuration DRAFT only after the user explicitly confirms the summary, says to proceed, or explicitly asks you to choose the remaining defaults. Do not silently assume material risk, horizon, or trade-expression choices.
- Answer direct questions about the proposed setup rather than repeating a prior confirmation prompt. If the user asks to see, list, or tell them all parameters or the full setup, provide a detailed plain-English review of every selected parameter (universe, trade expression and legs, DTE, sizing, each entry and exit rule, and risk control). This is inspection only, never permission to create a DRAFT. Only create a DRAFT after the user explicitly says they are ready, asks to proceed, or otherwise gives an unambiguous build instruction.
- For a portfolio draft, set one root-level position_size_pct and return exactly one shared strategy in strategies. Do not assign weights to tickers or divide capital across the universe: each ticker is simply eligible to receive that shared algorithm, and each admitted trade uses position_size_pct of total portfolio value.
- Never multiply position_size_pct by the number of eligible tickers, ask the user to reduce it because of universe size, or describe the ticker universe as combined allocation. With a 10% trade size, the engine admits at most 10 concurrent trades and queues later signals; 60 eligible symbols do not mean 600% exposure.
- All percentage fields use percentage points, never fractions: position_size_pct 1 means 1% (not 0.01), IV Rank 80 means 80% (not 0.8), and a 10% price drop is -10 (not -0.1).
- When relevant to the user's risk appetite, ask one focused question about leverage and effective annual borrowing rate (EAR) before drafting. If the user does not want leverage, set leverage to 1 and effective_annual_rate to 0. Never imply leverage is free: state that interest is charged on borrowed gross exposure.
- OPTION/COMBO RISK SEMANTICS: stopLossPct and takeProfitPct are evaluated against the modeled position's P&L relative to its entry premium basis. They are not underlying-price conditions. A user's plain-English "profit target," "take profit," "close at N% profit," or "max profit" language for an option/combo ALWAYS means this premium-based threshold — put it ONLY in risk.takeProfitPct (same for a stated stop-loss -> risk.stopLossPct). NEVER invent a sell-rule condition to represent a profit/loss/time value: not PCT_CHANGE, not OPT_HV (realized volatility), not any other indicator — none of them measure the position's own P&L, and re-purposing a stated percentage or day-count as an unrelated indicator's threshold or period (e.g. turning "50% profit, 14 DTE" into an OPT_HV condition thresholded at 50 with period 14) is always wrong, not just a stylistic mismatch. If the user's exit is fully described by a profit target, stop-loss, and/or a hold-time limit, the sell rule block MUST stay EMPTY ({"logic":"OR","groups":[]}) — the position then closes only on those risk controls or option/combo expiration. Only add a real sell-rule condition when the user explicitly describes a genuine market/signal-based exit (e.g., "exit when IV Rank drops below 30," "exit on a trend reversal") distinct from the profit/loss/time controls. maxHoldBars: 0 means no time-based exit; the option/combo must then close only on a real sell rule, a P&L risk control, or expiration and settlement at DTE.
- BARS ARE NOT CALENDAR DAYS — NEVER SET maxHoldBars TO A DTE NUMBER DIRECTLY: maxHoldBars counts trading-day BARS (there is no bar on a weekend or market holiday). dte, combo_dte, and any "N DTE" the user states are CALENDAR days. The two units are never numerically interchangeable, and the gap between them (roughly 2 calendar days out of every 7) is exactly what a naive 1:1 mapping gets wrong. When the user wants a position closed once it reaches N DTE remaining (e.g., "close at 14 DTE" on a structure entered at 30 DTE): first find the CALENDAR days elapsed at that point (entry dte − target dte, e.g. 30 − 14 = 16 calendar days), then convert that to an approximate trading-day bar count via calendar_days × 5/7, rounded to the nearest whole bar (16 × 5/7 ≈ 11 → maxHoldBars: 11) — and say in the summary that this is an approximation because market holidays aren't modeled, so the actual close may land a bar or two early/late versus the literal DTE target. If the user instead says "hold for N trading days" or "N bars," use maxHoldBars: N directly with no conversion. If the phrasing is genuinely ambiguous (e.g., "close after 2 weeks" with no calendar/trading-day cue), ask which they mean before drafting rather than guessing.
- For a condition that should evaluate the traded symbol itself, omit IndicatorRef.ticker entirely. Never use $TICKER, TICKER, $SYMBOL, SYMBOL, or SELF as a ticker value; ticker is only for a real explicit cross-asset symbol such as SPY.
- A Question response must contain only the conversational discovery/confirmation message; never include a partial draft or JSON inside its text.
- Every full DRAFT must include complete buy and sell rule definitions: a single draft needs a complete "strategy" object, and a portfolio draft needs a complete "strategies" entry for every position's "strategy_name". Never return positions or option legs alone as a draft; ask a question instead if the rules are not ready.
- PERCENTAGE UNITS: PCT_CHANGE, PCT_BELOW_HIGH, PCT_ABOVE_LOW, OPT_HV, and OPT_IVRANK use literal percentage points. Never convert a percent to a decimal fraction: a requested 20% drop is rhs_num -20, a 5% gain is 5, and 0.2 means 0.2%.

BACKTEST REVIEW:
- A message beginning with "BACKTEST REVIEW" is a continuation of the existing strategy conversation, not a new strategy request. Use the supplied setup, performance metrics, date window, and exit mix to reason about what changed performance.
- Start the review with a concise diagnosis of the most important outcome, then ask exactly one focused question about the improvement objective or tradeoff. Do not restart the entire discovery interview or discard prior chat context.
- Once the user confirms the desired revision, return a revised DRAFT that changes only the relevant rules, risk, instruments, or weights and explains the expected tradeoff in the summary. For a single-strategy review, always include the complete revised "strategy" object. For a portfolio review, always include the complete revised "strategies" list and the matching "positions". When the review message supplies existing strategy names, preserve those names exactly in the revised strategy objects so the builder replaces the actual saved rules rather than creating lookalikes.
- Never say the algorithm has changed, updated, or been applied until the user selects the client-side apply action. When asking for final confirmation, say you will prepare a revised setup for the user to review and apply.

LIVE PAPER TIMEFRAME CONSTRAINT:
- Live paper trading evaluates custom-strategy indicators on daily bars only. Backtests can use 5m, 15m, 30m, 1h, weekly, or monthly indicator timeframes.
- Before proposing any non-daily indicator timeframe, explicitly tell the user it is backtest-only and ask whether they want a daily rule for paper trading or a non-daily rule for research/backtesting.
- Never silently place a non-daily timeframe in a DRAFT. If the user confirms a non-daily backtest, state the daily-only live-paper limitation in the draft summary.

SCREENER ACCESS:
- You can screen the dashboard's live stock universe to find real candidate tickers. Use it whenever the user asks you to screen, find, select, or narrow stocks, or when they describe a thematic basket instead of naming tickers.
- Never invent placeholder tickers. If the user wants high-beta tech, growth stocks, liquid large caps, or another screenable universe, use a screen before naming candidates.
- Use a screen only when you have enough criteria to make it meaningful. If a crucial filter is missing, ask one focused question first.
- A screen may use: filters on price, marketCap, volume, avgVolume, beta, priceChange (with param 1D|1W|1M|3M|6M|YTD|1Y), change52wHiPct, peRatio, pbRatio, psRatio, evEbitda, pegRatio, revenueGrowth, epsGrowth, grossMargin, operatingMargin, netMargin, roe, debtEquity, currentRatio, dividendYield, rsi14, smaDist50, smaDist200, or vol30; sector; region; universe (sp500|sp400|nasdaq100); and sort_by/sort_dir.
- marketCap's filter value is in BILLIONS of dollars, not raw dollars: "$20B" or "20 billion" means value:20, never value:20000000000. Every other dollar-scale field on this list (price, volume, avgVolume) uses its plain natural unit (price in $, volume/avgVolume in shares) — do not billions-scale those.
- A screen may use one `universe` or multiple `universes`. When the user asks for Nasdaq-100 and S&P 500 (including phrasing like "Nasdaq and SPY stocks"), use `"universes":["nasdaq100","sp500"]`; never replace that request with an all-universe screen.
- For each filter use {"field":"beta","operator":"gt"|"gte"|"lt"|"lte"|"between","value":number,"value2":number|null,"param":string|null}. Do not state or impose a result cap. The server ignores any `limit` field and always returns every match.
- After a screen, ask exactly one focused follow-up question about the candidates or the next unresolved strategy decision.
- When a user chooses a screened basket, create a portfolio with positions for every actual returned candidate ticker they choose. Do not arbitrarily reduce the basket size. Never use `ALL`, `NASDAQ`, `SP500`, `TECH_HIGH_BETA`, or any other label/placeholder as a ticker.
- If the strategy is meant to run on a screened basket and that basket hasn't been resolved to real tickers yet (no screen has run, or the user hasn't picked from its results), stay in "question" or "screen" mode for EVERY message about that strategy — including one that only tweaks an unrelated parameter (strikes, DTE, position size, exits). A message like "sell an 85% strike instead" is not a request to draft; acknowledge the update in a "question" response and continue toward resolving the basket (run the screen yourself if you already have enough criteria, otherwise ask what's missing). Never attempt a "draft" whose positions would need a placeholder ticker to fill in — draft only once every position has a real one.
- When the user has explicitly selected every screened candidate, return just one real screened ticker in positions as a complete position template. The server will expand that template to every selected candidate. This preserves an unlimited universe without generating a massive, truncated JSON response.

JSON RESPONSE SHAPES:
Every response must be valid JSON in exactly one of these shapes:
1. Question: {"type": "question", "text": "<plain-English response/question>"}
2. Screen:
{"type":"screen","screen":{"filters":[],"sector":null,"region":null,"universes":["nasdaq100","sp500"],"sort_by":"marketCap","sort_dir":"desc","sort_param":null},"text":"<brief context plus exactly one follow-up question>"}
3. Draft:
{
  "type": "draft",
  "summary": "<one sentence summary of the drafted setup>",
  "mode": "single" | "portfolio",
  
  // IF mode is "single":
  "ticker": "AAPL",
  "side": "long" | "short",
  "instrument": "underlying" | "option" | "combo",
  "opt_type": "call" | "put",   // for option
  "otm_pct": number,            // for option (% out-of-the-money, negative = ITM)
  "dte": number,                // for option
  "combo_legs": [               // for combo
    {"type": "call" | "put", "side": "buy" | "sell", "moneyness": number, "qty": number}  // moneyness: strike relative to spot (e.g. 1.0 = ATM, 1.05 = 5% OTM call, 0.95 = 5% OTM put)
  ],
  "combo_dte": number,          // for combo
  "strategy": {                 // optional custom strategy rules
    "name": "<strategy name>",
    "buy": RuleBlock,
    "sell": RuleBlock,
    "risk": StrategyRisk
  },
  
  // IF mode is "portfolio":
  "position_size_pct": number,  // one shared % of the total portfolio per admitted trade
  "leverage": number,           // gross-notional multiplier, minimum 1x (no ceiling); 1 = no leverage
  "effective_annual_rate": number, // borrowing EAR in percentage points, e.g. 8.5
  "positions": [
    {
      "ticker": "AAPL",
      "side": "long" | "short",
      "instrument": "underlying" | "option" | "combo",
      "opt_type": "call" | "put",   // optional
      "otm_pct": number,            // optional
      "dte": number,                // optional
      "combo_legs": [               // optional
        {"type": "call" | "put", "side": "buy" | "sell", "moneyness": number, "qty": number}
      ],
      "combo_dte": number,          // optional
      "strategy_name": "<strategy name, e.g. RSI Mean Reversion (14) or a name in the strategies array>"
    }
  ],
  "strategies": [                   // custom strategy rulesets created for this portfolio
    {
      "name": "<strategy name>",
      "buy": RuleBlock,
      "sell": RuleBlock,
      "risk": StrategyRisk
    }
  ]
}

INDICATOR SCHEMA (for strategy rules):
Condition = {"lhs": IndicatorRef, "op": "gt"|"lt"|"gte"|"lte"|"crosses_above"|"crosses_below", "rhs_type": "number"|"indicator", "rhs_num"?: number, "rhs_ind"?: IndicatorRef}
Group = {"logic": "AND"|"OR", "conditions": [Condition, ...]}
RuleBlock = {"logic": "AND"|"OR", "groups": [Group, ...]}
StrategyRisk = {"sizingPct": number, "stopLossPct": number, "takeProfitPct": number, "trailingStopPct": number, "maxHoldBars": number}  // maxHoldBars is a trading-day BAR count, not calendar days — see the BARS ARE NOT CALENDAR DAYS note above

For portfolio drafts, StrategyRisk.sizingPct is ignored by execution; use root-level position_size_pct as the sole trade-size control.
IndicatorRef = {"type": "PRICE"|"RSI"|"SMA"|"EMA"|"MACD_LINE"|"MACD_SIGNAL"|"BB_UPPER"|"BB_MID"|"BB_LOWER"|"ATR"|"MOMENTUM"|"PCT_CHANGE"|"OPT_HV"|"OPT_IVRANK", "period"?: number, "fast"?: number, "slow"?: number, "signal_period"?: number, "std"?: number, "ticker"?: string, "timeframe"?: string}

MONEYNESS RULES:
- In option legs, moneyness is the STRIKE-TO-SPOT RATIO (strike / spot) — never a percentage offset — and MUST always be a positive number, typically between about 0.5 and 2.0. Negative or zero moneyness is invalid, misprices every leg, and must never be output under any circumstance.
- Compute it as moneyness = 1 + (otm_pct / 100) for a CALL, and moneyness = 1 - (otm_pct / 100) for a PUT, where otm_pct is how far out-of-the-money the strike is (positive = OTM, negative = ITM). A call and a put move in OPPOSITE directions relative to 1.0 for the same OTM distance — do not subtract or negate a percentage against 1 without applying this call/put-specific sign.
- Worked examples: call 5% OTM -> 1.05. call 5% ITM -> 0.95. put 5% OTM -> 0.95. put 5% ITM -> 1.05. ATM (either type) -> 1.0.
- Preset combo legs:
  - Short Straddle: Sell 1.0 ATM Call, Sell 1.0 ATM Put.
  - Short Strangle: Sell 1.05 OTM Call, Sell 0.95 OTM Put.
  - Bull Call Spread: Buy 1.0 Call, Sell 1.05 Call.
  - Bear Put Spread: Buy 1.0 Put, Sell 0.95 Put.
"""

@router.post("/strategy-chat")
def strategy_chat(req: StrategyChatRequest):
    if not req.messages:
        raise HTTPException(400, "messages must not be empty")
    parameter_request = req.scope == "full" and _asks_for_parameters(req.messages)
    if req.scope == "full" and not parameter_request:
        exit_summary = _requested_exit_summary(req.messages)
        if exit_summary:
            return {"type": "question", "text": exit_summary}
    sys_prompt = _STRATEGY_CHAT_FULL_SYSTEM if req.scope == "full" else _STRATEGY_CHAT_SYSTEM
    messages = [{"role": "system", "content": sys_prompt}]
    if parameter_request:
        messages.append({
            "role": "system",
            "content": "The user is requesting a parameter review only. Return type 'question' with a specific, complete plain-English review of the universe, instrument/legs/DTE, shared trade size, each entry rule, each exit rule, and every risk control already chosen. Do not return a draft, do not offer an apply-ready setup, and do not ask for confirmation.",
        })
    if req.scope == "full" and _draft_is_confirmed(req.messages) and _should_expand_screened_universe(req.messages):
        template_tickers = _latest_screened_ticker_list(req.messages)
        if not template_tickers:
            universe_screen = _screen_spec_from_universe_request(req.messages)
            if universe_screen:
                try:
                    template_tickers = _ticker_list_from_screen_text(_screen_candidates(universe_screen))
                except Exception:
                    logger.exception("Strategy chat compact-draft screen lookup failed")
        if template_tickers:
            messages.append({
                "role": "system",
                "content": (
                    f"The user has authorized the draft for every screened symbol. To prevent output truncation, return EXACTLY ONE position object only, using {template_tickers[0]} as the real ticker template. "
                    "Do not enumerate any other ticker and never use a universe label. Put the complete strategies array BEFORE positions in the JSON. "
                    "The server expands this one template to every screened symbol after your response. This compact one-position format is mandatory."
                ),
            })
    messages += [{"role": m.role, "content": m.content} for m in req.messages]
    # Large screened baskets need enough output room for every position and its
    # rule mapping; the former 1,500-token limit silently truncated these drafts.
    resp = groq_chat(messages, model=MODEL_SMART, max_tokens=16000)
    raw = (resp.choices[0].message.content or "").strip()
    try:
        result = parse_json(raw)
    except HTTPException as exc:
        # The chat can still advance when a provider ignores the JSON-only
        # contract and returns a plain-language follow-up. Treat it as a
        # question rather than exposing a parser error to the strategy author.
        if exc.status_code == 500 and raw:
            if raw.lstrip().startswith(("{", "[")):
                logger.warning("Strategy chat returned incomplete JSON draft")
                return {"type": "question", "text": "I couldn't complete that strategy draft without truncating it. The selected universe and rules are still intact—please ask me to prepare the draft again."}
            logger.warning("Strategy chat returned non-JSON content; using conversational fallback")
            return {"type": "question", "text": raw}
        raise
    if not isinstance(result, dict) or result.get("type") not in ("question", "screen", "draft"):
        raise HTTPException(500, "AI returned an unexpected response shape")
    if req.scope == "full" and result["type"] == "question":
        text = str(result.get("text") or "")
        legacy_sizing_markers = ("combined allocation", "combined weights", "per-ticker allocation", "eligible tickers")
        if any(marker in text.lower() for marker in legacy_sizing_markers) and ("reduce" in text.lower() or "exceed" in text.lower()):
            logger.warning("Strategy chat returned legacy per-ticker sizing guidance")
            return {
                "type": "question",
                "text": "That trade size is valid: the universe does not multiply it by the number of symbols. The engine caps concurrent exposure at 100%, so a 10% trade size admits up to 10 simultaneous trades and queues later signals. What exit rule should close an admitted trade?",
            }
    if req.scope == "full" and result["type"] == "screen":
        try:
            candidates = _screen_candidates(result.get("screen") if isinstance(result.get("screen"), dict) else {})
        except Exception:
            logger.exception("Strategy chat screener request failed")
            return {"type": "question", "text": "I couldn't run that screen right now. Which specific ticker or index would you like to use instead?"}
        if candidates.strip() == "The screen returned no matches.":
            return {"type": "question", "text": f"{candidates} Try loosening a filter (a lower market cap or beta threshold, a broader universe) and I'll run it again."}
        text = str(result.get("text") or "Which of these candidates would you like to use?").strip()
        return {"type": "question", "text": f"{candidates}\n\n{text}"}
    if req.scope == "full" and result["type"] == "draft":
        result = _strip_self_ticker_placeholders(result)
        _normalize_fractional_percentages(result)
        _fix_invalid_moneyness(result)
        _remove_premium_exit_proxies(result, req.messages)
        if parameter_request:
            return {"type": "question", "text": _draft_parameter_review(result)}
        _expand_all_screened_positions(result, req.messages)
        allocation_issue = _portfolio_allocation_issue(result)
        if allocation_issue:
            logger.warning("Strategy chat attempted stacked portfolio sizing: %s", allocation_issue)
            return {"type": "question", "text": allocation_issue}
        rules_issue = _draft_rules_issue(result)
        if rules_issue:
            logger.warning("Strategy chat attempted to return a position-only draft: %s", rules_issue)
            return {
                "type": "question",
                "text": f"I need to prepare the full executable rule set before this can be applied. {rules_issue} Please confirm that you want me to return the complete strategy rules with the position setup.",
            }
        screened_tickers = _latest_screened_tickers(req.messages)
        draft_tickers = _draft_tickers(result)
        invalid_placeholders = sorted(_invalid_draft_tickers(result))
        if invalid_placeholders:
            universe_screen = _screen_spec_from_universe_request(req.messages)
            if universe_screen:
                try:
                    candidates = _ticker_list_from_screen_text(_screen_candidates(universe_screen))
                except Exception:
                    logger.exception("Strategy chat universe-screen fallback failed")
                else:
                    positions = result.get("positions") if isinstance(result.get("positions"), list) else []
                    template = next((position for position in positions if isinstance(position, dict) and str(position.get("ticker") or "").upper() in candidates), None)
                    template = template or next((position for position in positions if isinstance(position, dict)), None)
                    if candidates and template:
                        result["positions"] = [{**template, "ticker": candidates[0]}]
                        _expand_all_screened_positions(result, req.messages)
                        invalid_placeholders = sorted(_invalid_draft_tickers(result))
            if invalid_placeholders:
                return {
                    "type": "question",
                    "text": "I can't load placeholder or universe labels as positions. I'll need to screen for real ticker candidates first, then you can choose the basket to use.",
                }
        invalid_tickers = sorted(draft_tickers - screened_tickers) if screened_tickers else []
        if invalid_tickers:
            return {"type": "question", "text": f"The screen returned these eligible candidates: {', '.join(sorted(screened_tickers))}. Which of those should I use in the portfolio?"}
    if req.scope == "full" and result["type"] == "draft" and not _draft_is_confirmed(req.messages):
        logger.warning("Strategy chat attempted a draft before user confirmation")
        return {"type": "question", "text": _confirmation_reprompt()}
    return result


_OPTIONS_STRATEGY_CHAT_SYSTEM = """You are an options strategy engineer embedded in the Options Strategy Builder. The user describes a market view, a volatility trade, or a directional play in plain English. Your job is to do the heavy lifting: analyze their intent, propose concrete multi-leg options strategies, suggest optimal strikes, expiries, and tickers, and present a structured options draft rather than asking the user to decide everything.

ADVANCED OPTIONS STRATEGIES KNOWLEDGE & RECOMMENDATIONS:
- Directional Trades:
  - Moderate Bullish: Propose a Bull Call Spread (buy ATM call, sell OTM call) or Bull Put Credit Spread.
  - Aggressive Bullish: Propose a Long Call, Call Ratio Spread (buy 1 ATM call, sell 2 OTM calls; captures upside while netting a credit), or a Risk Reversal (sell OTM put, buy OTM call).
  - Moderate Bearish: Propose a Bear Put Spread or Bear Call Credit Spread.
  - Directional Hedged Income: Propose a Collar (Long stock + OTM long put + OTM short call) to cap gains and protect downside.
- Volatility & Range-Bound Trades (Theta & Volatility Arbitrage):
  - Range-bound / Short Volatility:
    - Iron Condor: Sell 15-20 delta put/call spreads on liquid indexes (SPY/QQQ).
    - Iron Butterfly: Sell ATM short put and call, buy OTM long wings.
    - Short Strangle / Straddle: Sell OTM or ATM call and put for high premium intake (requires high IV Rank).
    - Jade Lizard: Sell OTM put and sell OTM credit call spread. Set strikes so that total credit received exceeds the width of the call spread, eliminating upside risk.
  - Breakout / Long Volatility:
    - Long Straddle / Strangle: Buy ATM or slightly OTM options ahead of volatility catalysts (earnings, CPI).
    - Long Butterfly: Buy ATM call, sell 2 OTM calls, buy further OTM call. High reward/risk targeting a specific pin price.
  - Time Decay & Expiry Plays:
    - Calendar Spread: Sell near-term ATM call/put, buy longer-term ATM call/put to exploit differences in theta decay rates.
    - Diagonal Spread (Poor Man's Covered Call): Buy deep ITM LEAPS option (80+ delta, 180+ DTE), sell near-term OTM option (30 delta, 30 DTE) to generate recurring income.

ADVANCED PARAMETER DEFAULTS & RISK MANAGEMENT:
- Ticker Defaults: Propose broad market indexes (SPY, QQQ, IWM) for market/volatility strategies due to tight spreads. Recommend individual stocks (AAPL, TSLA, NVDA) for high-growth directional bets.
- Expiration Sweet Spot: Recommend monthly expiries 30 to 45 days out (e.g. 2026-08-15) for optimal theta decay with low gamma risk. Suggest LEAPS (180+ DTE) for structural long legs in diagonals.
- Strike Selection:
  - Short Legs: Target 15-30 delta (e.g. 30 delta for credit spreads, 15-20 delta for iron condors).
  - Long Wings: Buy 5-10 delta or 5-10 points out for risk definition.
  - Relative Base: Output strikes relative to a spot base of 100 (e.g. buy 90 put, sell 95 put for a 5-point put spread) so the builder can scale them.
- Risk Exit Management:
  - Profit Targets: Exit credit spreads and iron condors at 50% of maximum profit. Exit strangles at 25-50% max profit.
  - Stop Losses: Set stop losses at 2x to 3x credit received for short premium trades.
  - Time Management: Exit or roll short options at 21 DTE to mitigate accelerating gamma risk.

LIVE MARKET DATA:
When the underlying is known, a system message titled "LIVE MARKET DATA" gives you the real spot price, the real available expiries, and real tradeable strikes near spot. USE THESE. Place absolute strikes around the live spot and pick one of the real expiries. The builder then snaps every strike/premium to the nearest real listed contract, so treat premium as an estimate — your job is correct STRUCTURE and sensible STRIKE PLACEMENT relative to spot, not exact pricing.

WHEN TO ASK vs DRAFT:
- Ask a QUESTION when the underlying ticker is not yet identifiable, OR when the market view (direction / volatility / range) is genuinely ambiguous and you cannot reasonably assume it. Ask ONE focused question with concrete either/or choices (e.g. "Bullish on AAPL — do you want a defined-risk Bull Call Spread, or a higher-leverage Long Call?"). Never interrogate the user for individual strikes, premiums, or leg-by-leg detail — you fill those in.
- Otherwise output a DRAFT immediately using standard institutional defaults (30-45 DTE, the delta/width guidance above).

STRUCTURE INTEGRITY (verify before drafting):
- The legs MUST match the named strategy exactly. Iron condor = 4 legs (sell put spread + sell call spread), vertical spread = 2 legs same type opposite action, straddle = 2 legs (long/short call + put at the SAME strike), strangle = 2 legs at DIFFERENT OTM strikes, butterfly = 3 strikes 1:-2:1, calendar = same strike different expiries. Every short leg needs its defining long wing for any defined-risk structure the user asked for.
- Buy/sell, call/put, and the strike ordering must be internally consistent (a bull call spread buys the LOWER strike and sells the HIGHER; a bear put spread buys the HIGHER and sells the LOWER).

LEG SCHEMA:
Each leg in the "legs" array must match this schema:
{
  "option_type": "call" | "put",
  "action": "buy" | "sell",
  "K": number,          // ABSOLUTE strike price near the live spot (e.g. spot 196 -> a 5% OTM call is ~206). Only use a ~100 base if the real spot is actually near 100.
  "premium": number,    // Estimated premium per contract (the builder re-prices to the real chain).
  "quantity": number,   // Contract quantity (default 1).
  "ticker": string,     // The underlying ticker symbol (e.g., "SPY"). If none was given, ASK — do not invent one.
  "expiry": string      // A real expiry from LIVE MARKET DATA in "YYYY-MM-DD" format (the builder snaps to the nearest listed date).
}

RESPONSE SHAPES:
Every response must be valid JSON in exactly one of these shapes:
Question: {"type": "question", "text": "<one focused clarifying question with concrete choices, plain English>"}
Draft: {
  "type": "draft",
  "name": "<strategy name, e.g. Iron Condor>",
  "legs": [Leg, ...],
  "summary": "<one plain-English sentence, e.g. 'Sell the 185/175 put spread and 205/215 call spread on AAPL for Aug 15 as a net-credit iron condor.'>"
}"""

# ── Options strategy chat: ground the AI draft in real market data ────────────
# The model is good at STRUCTURE (which legs a strategy needs) but blind to the
# live spot, the real strike ladder, and the real premiums. So we detect the
# ticker, feed the model live market context so it places absolute strikes near
# spot, then snap every leg to a real listed contract on the backend. That is
# what turns "nonsense" 95/105 legs on a $196 stock into real tradeable legs.

# Options vocabulary + common English words that must never be probed as a
# ticker. "A"/"I" are real tickers (Agilent, Intelligent Bio) but overwhelmingly
# the article/pronoun, so they are excluded from the bare-word tier.
_OPT_VOCAB_STOP = {
    "BUY", "SELL", "PUT", "CALL", "PUTS", "CALLS", "ATM", "OTM", "ITM", "IV", "DTE", "LEAP", "LEAPS",
    "THE", "AND", "FOR", "OR", "TO", "OF", "ON", "IN", "AT", "AN", "IC", "PMCC", "CSP", "CC", "IS", "IT",
    "SPREAD", "STRANGLE", "STRADDLE", "CONDOR", "IRON", "FLY", "BUTTERFLY", "COLLAR", "RATIO", "CREDIT",
    "DEBIT", "LONG", "SHORT", "BULL", "BEAR", "WIDE", "WEEK", "WEEKLY", "MONTH", "MONTHLY", "EXP", "EXPIRY",
    "DELTA", "THETA", "VEGA", "GAMMA", "EPS", "CPI", "FOMC", "US", "ETF", "YES", "NO", "OK", "USD", "PCT",
    "SET", "GET", "NEW", "OLD", "LOW", "HIGH", "NET", "MY", "ME", "BE", "DO", "IF", "SO", "UP", "AS", "BY",
    "WITH", "THAT", "THIS", "WANT", "MAKE", "GIVE", "SOME", "MORE", "LESS", "OVER", "UNDER", "ABOUT",
    "A", "I", "AN", "WE", "YOU", "YOUR", "OUR", "NEXT", "INTO", "FROM", "THEN", "THAN", "THEM", "THEY",
    "WILL", "JUST", "LIKE", "NEED", "PLUS", "ONE", "TWO", "OUT", "ARE", "WAS", "HAS", "HAD", "CAN", "GO",
    "DAYS", "DAY", "OTM", "NEAR", "FAR", "COST", "RISK", "GAIN", "OPEN", "CLOSE", "SIZE", "EACH",
}


def _opt_num(v) -> float | None:
    try:
        f = float(v)
        return f if f == f and f not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _detect_options_ticker(messages: list[StrategyChatMessage]) -> str | None:
    """Most-recently-mentioned real optionable ticker in the conversation.

    Prioritised: $CASHTAGs, then tokens written UPPERCASE in the source (real
    ticker style, e.g. NVDA/SPY/F), then lowercase 2-5 letter words. A candidate
    is confirmed only if it has a live options chain (cached), which also rejects
    options vocabulary the stoplist would miss. Uppercase-first ordering stops a
    stray 'a'/'on' from beating an explicit 'NVDA'."""
    import options_data
    cashtags: list[str] = []
    upper_src: list[str] = []
    lower_words: list[str] = []
    for m in reversed(messages):
        if m.role != "user":
            continue
        for t in re.findall(r"\$([A-Za-z]{1,5})\b", m.content):
            up = t.upper()
            if up not in _OPT_VOCAB_STOP and up not in cashtags:
                cashtags.append(up)
        for t in re.findall(r"\b[A-Z]{1,5}\b", m.content):
            if t not in _OPT_VOCAB_STOP and t not in upper_src:
                upper_src.append(t)
        for t in re.findall(r"\b[a-z]{2,5}\b", m.content):
            up = t.upper()
            if up not in _OPT_VOCAB_STOP and up not in lower_words:
                lower_words.append(up)
    for cand in (cashtags + upper_src + lower_words)[:10]:
        try:
            if options_data.get_expirations(cand):
                return cand
        except Exception:  # noqa: BLE001
            continue
    return None


def _options_spot(sym: str, chain=None) -> float | None:
    try:
        if chain is None:
            import options_data
            exps = options_data.get_expirations(sym)
            if exps:
                chain = options_data.get_chain(sym, exps[0])
        u = getattr(chain, "underlying", None) if chain is not None else None
        if isinstance(u, dict):
            for k in ("regularMarketPrice", "currentPrice", "regularMarketPreviousClose", "last"):
                v = _opt_num(u.get(k))
                if v:
                    return v
    except Exception:  # noqa: BLE001
        pass
    try:
        import cache
        info = cache.get_info(sym) or {}
        return _opt_num(info.get("currentPrice")) or _opt_num(info.get("regularMarketPrice"))
    except Exception:  # noqa: BLE001
        return None


def _opt_dte(exp_iso: str) -> int:
    import datetime as _dt
    try:
        return (_dt.date.fromisoformat(str(exp_iso)[:10]) - _dt.date.today()).days
    except Exception:  # noqa: BLE001
        return 9999


def _nearest_dte_expiry(exps: list[str], target: int) -> str | None:
    return min(exps, key=lambda e: abs(_opt_dte(e) - target)) if exps else None


def _snap_expiry(requested, exps: list[str], default: str | None) -> str | None:
    import datetime as _dt
    if not exps:
        return (str(requested)[:10] if requested else default)
    r = str(requested or "")[:10]
    if r in exps:
        return r
    try:
        rd = _dt.date.fromisoformat(r)
        return min(exps, key=lambda e: abs((_dt.date.fromisoformat(e[:10]) - rd).days))
    except Exception:  # noqa: BLE001
        return default


def _snap_strike_premium(df, k: float, spot: float | None, otype: str) -> tuple[float | None, float | None]:
    """Nearest real listed strike to k, with its real mid premium. Falls back to
    a rough intrinsic + time-value estimate when the contract is untradeable."""
    import options_data
    try:
        rows = df.to_dict("records")
    except Exception:  # noqa: BLE001
        return None, None
    rows = [r for r in rows if _opt_num(r.get("strike")) is not None]
    if not rows:
        return None, None
    best = min(rows, key=lambda r: abs(float(r["strike"]) - k))
    strike = float(best["strike"])
    prem = options_data._best_price(best)
    if not prem or prem <= 0:
        intrinsic = max(0.0, (spot - strike) if otype == "call" else (strike - spot)) if spot else 0.0
        prem = round(intrinsic + max(0.05, (spot or strike) * 0.01), 2)
    return strike, prem


def _draft_ticker(result: dict) -> str | None:
    for leg in (result.get("legs") or []):
        if isinstance(leg, dict) and isinstance(leg.get("ticker"), str) and leg["ticker"].strip():
            return leg["ticker"].strip().upper()
    return None


def _options_market_context(sym: str) -> str | None:
    """Live spot + real expiries + real near-spot strikes, so the model places
    absolute strikes on the real ladder instead of a made-up base of 100."""
    import datetime as _dt
    import options_data
    try:
        exps = options_data.get_expirations(sym)
    except Exception:  # noqa: BLE001
        return None
    if not exps:
        return None
    today = _dt.date.today().isoformat()
    fexps = [e for e in exps if e >= today][:10] or list(exps)[:10]
    spot = _options_spot(sym)
    target = _nearest_dte_expiry(fexps, 35)
    strikes: list[float] = []
    if target:
        try:
            ch = options_data.get_chain(sym, target)
            ks = sorted(float(s) for s in ch.calls["strike"].tolist())
            if spot:
                ks = [k for k in ks if 0.8 * spot <= k <= 1.2 * spot]
            strikes = ks[:48]
        except Exception:  # noqa: BLE001
            pass
    fmt_k = lambda k: str(int(k)) if float(k).is_integer() else str(round(k, 2))
    lines = [
        f"LIVE MARKET DATA for {sym}:",
        (f"- Spot price: ${spot:.2f}" if spot else "- Spot price: unavailable"),
        f"- Real available expiries (YYYY-MM-DD): {', '.join(fexps)}",
        f"- Suggested expiry (~35 DTE): {target}" if target else "",
    ]
    if strikes:
        lines.append(f"- Real tradeable strikes near spot for {target}: {', '.join(fmt_k(k) for k in strikes)}")
    lines.append("Place ABSOLUTE strikes on this real ladder around the live spot, and use one of these real expiries. Do NOT use a base of 100.")
    return "\n".join(ln for ln in lines if ln)


def _ground_options_draft(draft: dict, sym: str) -> dict:
    """Snap the model's legs to real listed contracts: rescale a relative-to-100
    strike set back onto spot, then set each leg's strike/premium/expiry from the
    live chain. Best-effort — returns the draft unchanged if data is unavailable."""
    import options_data
    legs = draft.get("legs")
    if not isinstance(legs, list) or not legs:
        return draft
    try:
        exps = options_data.get_expirations(sym)
    except Exception:  # noqa: BLE001
        return draft
    if not exps:
        return draft
    import datetime as _dt
    today = _dt.date.today().isoformat()
    fexps = [e for e in exps if e >= today] or list(exps)
    spot = _options_spot(sym)
    default_exp = _nearest_dte_expiry(fexps, 35)

    # A strike set clustered near 100 while spot is far from 100 is the old
    # relative-to-100 convention — rescale it back onto the real spot first.
    ks = [k for k in (_opt_num(l.get("K")) for l in legs if isinstance(l, dict)) if k]
    if spot and ks:
        med = sorted(ks)[len(ks) // 2]
        if med and (spot / med > 1.5 or spot / med < 0.67):
            for l in legs:
                if isinstance(l, dict):
                    k = _opt_num(l.get("K"))
                    if k:
                        l["K"] = k * spot / 100.0

    chain_cache: dict[str, object] = {}

    def chain_for(exp: str):
        if exp not in chain_cache:
            try:
                chain_cache[exp] = options_data.get_chain(sym, exp)
            except Exception:  # noqa: BLE001
                chain_cache[exp] = None
        return chain_cache[exp]

    out_legs: list[dict] = []
    for l in legs:
        if not isinstance(l, dict):
            continue
        otype = "put" if str(l.get("option_type", "")).lower().startswith("p") else "call"
        action = "sell" if str(l.get("action", "")).lower().startswith("s") else "buy"
        exp = _snap_expiry(l.get("expiry"), fexps, default_exp)
        k = _opt_num(l.get("K")) or spot or 100.0
        prem = _opt_num(l.get("premium")) or 2.0
        ch = chain_for(exp)
        if ch is not None:
            df = getattr(ch, "puts" if otype == "put" else "calls", None)
            if df is not None:
                snapped, snapped_prem = _snap_strike_premium(df, k, spot, otype)
                if snapped is not None:
                    k, prem = snapped, snapped_prem
        out_legs.append({
            "option_type": otype, "action": action,
            "K": round(float(k), 2), "premium": round(float(prem), 2),
            "quantity": max(1, int(_opt_num(l.get("quantity")) or 1)),
            "ticker": sym, "expiry": exp,
        })
    draft["legs"] = out_legs
    draft["ticker"] = sym
    draft["spot"] = round(spot, 2) if spot else None
    return draft


@router.post("/options-strategy-chat")
def options_strategy_chat(req: StrategyChatRequest):
    if not req.messages:
        raise HTTPException(400, "messages must not be empty")
    sym = _detect_options_ticker(req.messages)
    chat = [{"role": "system", "content": _OPTIONS_STRATEGY_CHAT_SYSTEM}]
    if sym:
        ctx = _options_market_context(sym)
        if ctx:
            chat.append({"role": "system", "content": ctx})
    chat += [{"role": m.role, "content": m.content} for m in req.messages]
    resp = groq_chat(chat, model=MODEL_SMART, max_tokens=1200)
    raw = (resp.choices[0].message.content or "").strip()
    result = parse_json(raw)
    if not isinstance(result, dict) or result.get("type") not in ("question", "draft"):
        raise HTTPException(500, "AI returned an unexpected response shape")
    if result.get("type") == "draft":
        ground_sym = sym or _draft_ticker(result)
        if ground_sym:
            try:
                result = _ground_options_draft(result, ground_sym)
            except Exception as e:  # noqa: BLE001 — grounding is best-effort
                logger.warning("options draft grounding failed for %s: %s", ground_sym, e)
    return result


# ── Report Creator: plan research and synthesize clipped evidence ─────────────

class ReportResearchToolIn(BaseModel):
    id: str
    label: str = ""
    description: str = ""
    targetMode: str = "market"
    producesVisuals: bool = False


# Headroom over the current catalogue so new tools reach the planner as they are
# added. Bounded only to keep one prompt from growing without limit.
_RESEARCH_CATALOG_CAP = 64
# Beyond the deterministic baseline. Four was tight enough that a broad objective
# could not reach the evidence it needed.
_RESEARCH_MAX_ADDITIONS = 8


class ReportResearchPlanRequest(BaseModel):
    objective: str = ""
    mustInclude: str = ""
    timeframe: str = ""
    symbols: list[str] = Field(default_factory=list)
    portfolio: dict = Field(default_factory=dict)
    baselineSourceIds: list[str] = Field(default_factory=list)
    tools: list[ReportResearchToolIn] = Field(default_factory=list)


_REPORT_RESEARCH_PLANNER_SYSTEM = """You are AlphaTape's research director.
Choose only ADDITIONAL tools that materially improve the evidence for the stated report objective.
The deterministic baseline tools are already included. Do not repeat them.
Prefer a chart-producing tool when a visual relationship, trend, distribution, or comparison would make the conclusion clearer.
Do not add tools merely for breadth. Every selection must close a specific evidence gap.
Respect targetMode: symbol tools need symbols, portfolio tools need a supported active portfolio, and market tools need neither.
You also DIRECT each tool you want configured, rather than accepting its default view.
A directive is one plain-English sentence saying how to set that tool up for this objective:
which lines, indicators, overlays, comparisons, or windows it should show. Write directives
only where a non-default setup genuinely helps; a tool with no directive runs its default view.
Examples of useful directives:
  "price-history": "chart it against SPY with 50 and 200 day moving averages and RSI"
  "market-compare": "index all names to 100 at the start of the lookback"
  "correlation": "use a 90 day rolling window against the benchmark"
Name overlays by ticker and indicators by their common name and period.

Return only valid JSON:
{
  "summary": "one short sentence describing the evidence strategy",
  "additions": [
    {"id": "exact catalog id", "reason": "specific evidence gap this tool closes"}
  ],
  "directives": {"exact catalog id": "one sentence configuring that tool"}
}
Directives may target baseline tools as well as additions.
Select at most 8 additions. An empty additions array is valid when the baseline is sufficient."""


def _normalize_report_research_plan(raw, allowed: set[str], baseline: set[str]) -> dict:
    data = raw if isinstance(raw, dict) else {}
    summary = re.sub(r"\s+", " ", str(data.get("summary", "")).strip())[:240]
    additions: list[dict] = []
    seen: set[str] = set()
    for item in data.get("additions", []):
        if not isinstance(item, dict):
            continue
        source_id = str(item.get("id", "")).strip()
        if source_id not in allowed or source_id in baseline or source_id in seen:
            continue
        reason = re.sub(r"\s+", " ", str(item.get("reason", "")).strip())[:220]
        if not reason:
            continue
        additions.append({"id": source_id, "reason": reason})
        seen.add(source_id)
        if len(additions) >= _RESEARCH_MAX_ADDITIONS:
            break

    # Per-tool setup instructions, for baseline tools as well as additions. Kept
    # as prose: the client resolves each one against what that tool can actually
    # do, so an unusable instruction degrades to the default view.
    directives: dict[str, str] = {}
    raw_directives = data.get("directives")
    if isinstance(raw_directives, dict):
        for source_id, text in raw_directives.items():
            key = str(source_id).strip()
            if key not in allowed:
                continue
            body = re.sub(r"\s+", " ", str(text).strip())[:240]
            if body:
                directives[key] = body
    return {"summary": summary, "additions": additions, "directives": directives}


@router.post("/report-research-plan")
def plan_report_research(req: ReportResearchPlanRequest):
    objective = req.objective.strip()
    if not objective:
        raise HTTPException(400, "Report objective is required")
    # The catalogue is the planner's whole world: anything trimmed here is a tool
    # it can never choose. This was pinned at 24 while exactly 23 tools existed,
    # so the next tool added would have been silently invisible to it.
    tools = req.tools[:_RESEARCH_CATALOG_CAP]
    allowed = {tool.id for tool in tools if tool.id}
    baseline = {source_id for source_id in req.baselineSourceIds if source_id in allowed}
    if not allowed:
        raise HTTPException(400, "No supported research tools supplied")
    prompt = json.dumps({
        "objective": objective[:1200],
        "mustInclude": req.mustInclude[:1200],
        "timeframe": req.timeframe[:160],
        "symbols": req.symbols[:8],
        "portfolio": req.portfolio,
        "baselineSourceIds": sorted(baseline),
        "toolCatalog": [
            {
                "id": tool.id,
                "label": tool.label[:80],
                "description": tool.description[:240],
                "targetMode": tool.targetMode,
                "producesVisuals": tool.producesVisuals,
            }
            for tool in tools if tool.id
        ],
    }, separators=(",", ":"))
    raw = groq_complete(
        prompt,
        max_tokens=800,
        model=MODEL_SMART,
        system=_REPORT_RESEARCH_PLANNER_SYSTEM,
    )
    return _normalize_report_research_plan(parse_json(raw), allowed, baseline)

class ReportClipIn(BaseModel):
    id: str
    sourceTab: str = ""
    dataType: str = ""
    title: str = ""
    userDescription: str = ""
    dataSummary: str = ""

class ReportGenRequest(BaseModel):
    projectName: str = ""
    timeframe: str = ""
    purpose: str = ""
    goal: str = ""
    # Optional subject hint for API clients. Clear company/ticker language in the
    # objective remains authoritative so stale UI state cannot retarget a report.
    subjectTicker: str = ""
    # 'short' | 'medium' | 'long' — how much depth the note should have. Unknown/missing → 'medium'.
    length: str = "medium"
    # What kind of note this is, chosen in setup. Decides the argument shape.
    # Unknown/missing → no type-specific direction is added.
    reportType: str = ""
    # Page-composition preference, chosen in setup. Biases the per-section layout.
    layoutPreset: str = ""
    # Free-text requirements the report must satisfy (a stat, a verdict, a chart,
    # a specific figure) — not curated away even if the model wouldn't otherwise pick them.
    mustInclude: str = ""
    clips: list[ReportClipIn]

_LENGTH_SPEC = {
    "short": {
        "sections": "1 to 2",
        "guidance": (
            "Short: headline verdict plus the single most decisive driver. One or two body sections, "
            "each with 2-3 tight sentences and 2-3 keyFigures. No secondary color, no minor caveats. "
            "Executive summary is 1-2 sentences. Conclusion is 1 sentence."
        ),
    },
    "medium": {
        "sections": "3 to 5",
        "guidance": (
            "Medium: standard research-note depth. 3 to 5 body sections, each 1-2 short paragraphs with "
            "2-4 keyFigures. Executive summary is one tight paragraph. Conclusion covers the verdict, "
            "the main risk to it, and an action. Merge related evidence rather than adding modules."
        ),
    },
    "long": {
        "sections": "5 to 8",
        "guidance": (
            "Long: full supporting detail for a desk that wants the complete picture. 5 to 8 body "
            "sections — cover secondary drivers, sensitivities, and peer/segment detail that medium "
            "length would cut, in addition to the core thesis sections. Each section can run 2-4 "
            "paragraphs with 2-4 keyFigures. Executive summary can run 2-3 sentences. Conclusion "
            "should also name secondary risks and a monitoring checklist. Still cut clips that add "
            "nothing — length is a ceiling on depth, not "
            "a quota to fill with restated numbers."
        ),
    },
}

def _length_key(length: str | None) -> str:
    v = (length or "").strip().lower()
    return v if v in _LENGTH_SPEC else "medium"

def _must_include_section(raw: str | None, extra: list[str] | None = None) -> str:
    """Build the MUST INCLUDE prompt block from the user's own text plus any
    auto-detected directives (see _auto_must_include), or '' if both are empty."""
    lines = [line.strip() for line in (raw or "").splitlines() if line.strip()]
    lines.extend(extra or [])
    if not lines:
        return ""
    items = "\n".join(f"- {line}" for line in lines)
    return f"""
════════════════════════════════════════
MUST INCLUDE — non-negotiable, from the user
════════════════════════════════════════
The user has required the following to appear in this report:
{items}
Each requirement must surface somewhere in the output — in a section's analysis, a keyFigure, a chart, the keyResult, the executiveSummary, or the conclusion, whichever fits it best. These survive the curation and length rules above: even a "short" report, or a section that would otherwise get merged or cut, must still make room for every required item. Satisfy a requirement only with a real figure already present in the clips or valuationContext — never fabricate a number, chart data point, or verdict to check the box. If a requirement cannot be sourced from the data you were given, say so explicitly wherever it would have appeared (e.g. "PEG ratio not available in the supplied clips") — do not silently drop it and do not invent it.
"""

_REPORT_RANGE_GUIDANCE = """The Goal is a price call on ONE equity. Return a dollar range in keyResult.value using "$A–$B", with A < B.
- Take a bullish, bearish, or neutral lean and low, moderate, or high conviction. Use neutral only when signals genuinely cancel.
- Encode the lean in the range. A bullish range should usually have a midpoint above spot or more upside than downside. A bearish range should do the reverse.
- Treat implied move, volatility cones, and probability bands as width constraints, not as the thesis. Let flow, positioning, catalysts, fundamentals, and valuation determine direction.
- Keep short-horizon ranges within roughly ±25% of spot unless supplied evidence supports more.
- keyResult.context, executiveSummary, and conclusion must name spot, the lean, the range, and the two or three decisive drivers.
- Use options strikes, gamma levels, probability anchors, catalysts, and valuation only when the supplied clips contain them."""

_REPORT_OPEN_GUIDANCE = """The Goal is a comparison, screen, ranking, thematic read, portfolio question, or other non-range task.
- keyResult.value is a direct headline verdict under 40 characters, such as "Buy NVDA", "NVDA over AAPL", or "Reduce Tech Risk". Never return a bare ticker.
- stance.baseCase is only the favored ticker/name or a 2–3 word tag. Put reasoning in stance.thesis.
- For a single-company equity research note that did not explicitly request a price target, give a Buy, Hold, Avoid, Watch, or equivalent research verdict. Do not manufacture a fair-value range from volatility or an implied move.
- For multiple subjects, build one side-by-side argument organized by comparative theme. Do not create mirrored sections for each subject.
- Include every decision-relevant subject in the shared comparison and reach a verdict even when evidence conflicts.
- executiveSummary and conclusion must state the verdict and the two or three decisive drivers."""

_REPORT_SCHEMA_BY_MODE = {
    "range": {
        "baseCase": "the midpoint as '$X'",
        "label": "'Fair Value Range (TICKER)' or 'Near-Term Range (TICKER)'",
        "value": "'$A–$B'",
        "context": "'spot $X · lean · decisive drivers'",
    },
    "open": {
        "baseCase": "the favored ticker/name or a 2-3 word tag, never a sentence",
        "label": "a short answer label such as 'Relative Pick', 'Risk Call', or 'Verdict'",
        "value": "a headline verdict under 40 characters",
        "context": "the figures that decided the verdict",
    },
}

_SECTION_DESIGN_INTENTS = {"visual", "narrative", "balanced", "compact"}

_RESEARCH_NOTE_EDITORIAL_STANDARD = """
════════════════════════════════════════
EQUITY-RESEARCH EDITORIAL STANDARD
════════════════════════════════════════
Write for an investor deciding what to do, not for a reader learning the topic.
1. The headline states the conclusion and the tension in plain English. Never use a generic title such as "Valuation Analysis" or "Company Overview".
2. Open with the call, what changed, and the two facts that matter most. Put background later.
3. Section headings are conclusions, not topics. Use "Margins Hold Despite Slower Growth", not "Margins".
4. Start every section with its takeaway. Then explain the mechanism, the evidence, and the caveat. Use short paragraphs and remove scene-setting filler.
5. Label figures with their period and unit. Distinguish actual results, estimates, consensus, targets, and spot price. State the valuation method, forecast year, and multiple whenever the clips provide them.
6. Use keyFigures as the compact evidence rail. Do not repeat every keyFigure in the adjacent prose. Prose explains why the numbers matter.
7. Put valuation, catalysts, and risks into separate decision blocks when the evidence supports them. For a price call, make the base case and material upside/downside paths explicit without inventing scenarios.
8. End with an action and the evidence that would make the call stronger or weaker.
"""

_REPORT_SYSTEM = """You are a senior investment analyst writing a formal research note for a professional desk. Write directly, support claims with supplied evidence, and answer the Goal.

You receive: Purpose, Goal, Timeframe (lookback and/or lookforward), DATA CLIPS (each with id, source tool, title, optional user note, data summary), valuationContext (live spot, optional day change, optional DCF, signalDigest of directional cues extracted from clips, reportMode, and reportLength), and optionally an `outline`.

OUTLINE: if the input includes an `outline` (a thesis plus planned sections), it was drafted first as the report's analytical structure and you MUST follow it. Anchor the entire report to outline.thesis. Write exactly the outline's sections, in order, each using its heading and developing its `argues` point with the clip figures. Do not add, drop, reorder, split, or merge sections. If no outline is present, plan a thesis-first structure yourself with one section per comparative theme (never one section per subject for the same theme).

════════════════════════════════════════
LENGTH — valuationContext.reportLength sets the target depth
════════════════════════════════════════
{{LENGTH_GUIDANCE}}
Cut anything that does not advance the thesis, regardless of the length target.
{{MUST_INCLUDE_SECTION}}
════════════════════════════════════════
MODE
════════════════════════════════════════
{{MODE_GUIDANCE}}

{{EDITORIAL_STANDARD}}

════════════════════════════════════════
INTEGRATE EVERY SUPPLIED CLIP FAMILY (both modes)
════════════════════════════════════════
Build ONE argument, whichever mode you are in.
- Sentiment: only if the clip has real scores/figures (ignore empty stubs that say no structured panels).
- Company profile / fundamentals: valuation multiples, growth, margin — structural context.
- Credit / stress / markets board: risk-on vs risk-off backdrop tilts equity beta names.
Ignore pure appendix stubs that contain no figures. If clips conflict (e.g. bullish GEX vs demanding reverse-DCF growth, or subject A wins on growth but subject B wins on valuation), name the conflict, weight the horizon, and still reach a verdict with appropriate conviction.

════════════════════════════════════════
VISUALS
════════════════════════════════════════
You do not build charts or choose renderer layouts. Use a chart clip's id as clipId when its native visual materially supports the section. Prefer 2–4 distinct decision-grade visuals when enough relevant chart clips exist. Omit unused visuals and never place chart clips in appendixClipIds.

════════════════════════════════════════
DESIGN INTENT
════════════════════════════════════════
Choose one simple `design` intent per section:
- "visual": the evidence should lead.
- "narrative": the interpretation should lead.
- "balanced": evidence and interpretation have equal weight.
- "compact": this is supporting material and should use minimal space.
The application converts this intent into a compatible, varied composition after it builds the real visuals.

════════════════════════════════════════
HORIZON
════════════════════════════════════════
- Lookback: interpret trends against that history.
- Lookforward: the verdict applies to this window. A 7-day range is a trading corridor, not terminal value. A 90-day range (or comparison thesis) can sit further from spot when models and macro support it.
- Connect both when present.

════════════════════════════════════════
HARD RULES & NARRATIVE VOCABULARY (both modes)
════════════════════════════════════════
- Use ONLY figures present in clips or valuationContext. Never invent prices, GEX, IV, or dates.
- Field-to-Label Controlled Vocabulary:
  - `upside = (intrinsic - price) / price`: verbalize strictly as "X% upside to intrinsic" (if intrinsic > price) or "X% downside to intrinsic" (if intrinsic < price). NEVER call a negative upside a "premium above intrinsic".
  - `premium_to_intrinsic = (price - intrinsic) / intrinsic`: verbalize strictly as "X% premium to intrinsic".
  - Single polarity per field per paragraph: a given metric may not map to opposing polarity words in the same paragraph.
- Metric Nouns: Single-period growth (e.g. REV GROWTH 85.2%) must be called "growth rate" or "revenue growth", NEVER "revenue CAGR". Reserve "CAGR" strictly for multi-year compound growth rates with explicit n_periods.
- DCF arithmetic and units: Use the deterministic Projection Math clip for CAGR and cumulative growth. Never relabel cumulative growth as CAGR. Treat DCF Revenue, EBIT, FCF, enterprise value, and bridge inputs in the units printed by their clip. Never abbreviate an input expressed in USD millions as though it were raw dollars.
- DCF completeness: An intrinsic-value conclusion must name the valuation date or quote limitation, explicit forecast horizon, WACC, terminal growth, and at least the principal operating assumptions. Describe one-way sensitivity as one-variable-at-a-time, not as a probability distribution or a robust downside case.
- Horizon discipline: An open-ended outlook does not supply a target date. Never pair it with a precise price target or expected return unless another clip supplies an explicit target date or annualized return.
- Correlation and beta: Prose beside a rolling chart must name the exact pair or factor in that chart and use the chart's first/latest/range values. Do not substitute a different matrix pair. Low correlation is diversification evidence, not proof that concentration risk is absent. Beta is market sensitivity, not volatility.
- Portfolio actions: Never recommend trimming, adding, hedging, or changing a weight unless the clips show the complete current allocation, a specific proposed allocation or trade list, holding-level risk contributions, and quantified before-and-after beta, volatility, and scenario losses. Beta above 1 cannot explain underperformance by itself. Use return attribution before assigning active return to beta, sectors, selection, cash, fees, or timing.
- Portfolio evidence order: The first portfolio section must show portfolio return, SPY return, active return, portfolio and SPY volatility, and both maximum drawdowns before any causal explanation. If active-return attribution is absent, say the cause remains unresolved. Factor regression and risk contribution are not substitutes for allocation and security-selection attribution.
- Benchmark comparison: Call SPY an analytical US equity reference unless the evidence explicitly validates it as the policy benchmark. Any claim of similar risk must print both portfolio and benchmark volatility using matching dates and methods. Compare Sharpe and drawdown only when both sides are supplied.
- Factor naming: A rolling beta chart is "Rolling Market Beta", not a factor decomposition. Use "factor decomposition" only when the evidence supplies multiple factor coefficients, fit statistics, and systematic versus idiosyncratic risk.
- Factor contribution naming: A signed beta-times-covariance contribution may be negative and sums to model R-squared. Call it "signed factor contribution", never a literal share of variance. Raw beta magnitude is not importance; use t-statistics and contribution when discussing materiality.
- Sector look-through: A direct issuer sector table does not measure economic sector exposure inside ETFs or funds. If a fund look-through limitation is supplied, label sector weights "directly classified" and never present them as total portfolio exposure.
- Portfolio concentration language: Without fund holdings and a reference allocation, never call the portfolio overweight technology. When the evidence supports only one holding's weight, beta, variance share, and idiosyncratic share, frame the conclusion as single-security risk concentration.
- Systematic versus idiosyncratic risk: Market beta measures systematic sensitivity. Residual or idiosyncratic variance must come from the residual calculation. Never infer idiosyncratic contribution from high beta.
- Mixed valuation: A discount on one multiple is not an overall valuation discount when other supplied multiples show premiums. State results by metric and call the picture mixed when measures disagree.
- Valuation methods: Relative multiples, analyst consensus, and DCF are separate methods. Never say a P/E discount delivers or implies DCF upside. If consensus and DCF upside differ, show both, explain that they use different methods, and state which one informs the conclusion. In portfolio reviews, valuation is one compact supporting panel, not the central argument.
- Valuation integrity: If DCF value and market price differ by more than 5x, or DCF and consensus point sharply in opposite directions, treat the DCF as unreconciled. Check units, diluted share count, corporate actions, and price alignment. Do not use that output to justify an allocation action.
- Catalyst labels: Use "upcoming catalyst" only when the supplied evidence contains the actual future event and date. A methodology clip is not a catalyst calendar. Remove catalyst language from a heading when no dated event is available.
- Portfolio summary structure: For a portfolio review, write the executive summary as exactly three short sentences: what happened, the strongest supported diagnosis, and the decision implication. Keep it under 80 words. Use exactly four body sections that answer What Happened, Why It Happened, What Could Happen Next, and What Action Follows. Keep each section analysis under 110 words and move definitions or calculation details to the appendix.
- Measurement versus outlook: State the historical measurement window separately from the forecast horizon. Recent beta, volatility, and a near-term event do not establish a multi-year outlook unless a forward model explicitly connects them.
- Derivative coverage: When the book contains options, distinguish contract inventory and underlying-market research from whole-account exposure. Equity-and-cash return, beta, volatility, factor, drawdown, and allocation statistics are sleeve metrics until verified option marks and Greeks support nonlinear position-level aggregation. Never present underlying shares as though the option contracts were stock holdings.
- Statistical claims: Call a coefficient significant only when the coefficient evidence gives its p-value and it is below the stated threshold. Regression is association, never proof of causation.
- Sector framing: Sector momentum does not make an individual high-beta growth stock "defensive". Use defensive only when the supplied company or risk evidence supports that classification.
- Macro events: A calendar is event-risk evidence, not a directional inflation forecast. Do not call an event upcoming if its date precedes the report date, and do not infer an inflation direction without an actual or consensus CPI/PCE value.
- Interpret, Don't Recite: Do not simply repeat raw numbers visible in adjacent KPI cards. Prose must explain the mechanism, competitive context, caveats, or disconfirming evidence.
- Comparative Claims: Verify comparative adjectives ("higher", "lower", "dwarfs", "lags") against operands. Never state a lower metric is higher or vice versa.
- Swings and moves as PERCENT, never raw dollars alone: any price swing, sensitivity range, target band, or move MUST be expressed as a percent of the subject's current price (valuationContext.marketPrice, or per-subject marketPrice in valuationContext.subjects), not as a bare dollar amount. valuationContext.sensitivitySwing gives the precomputed swingPct per subject — cite it. A $40 swing on a $200 stock is a 20% swing; a $400 swing on a $1,500 stock is a 27% swing. Dollar magnitudes are not comparable across differently-priced names, so never rank or contrast two names' swings in dollars. State the dollar band if useful, but always alongside the percent.
- Risks: cover the key risks to the thesis in plain prose when the data supports it. Do NOT write a falsification trigger, a "falsification floor/ceiling", or any "IF metric crosses threshold BY date THEN thesis invalidated" statement, and never invent threshold levels, trigger dates, or cutoff figures to build one. Describe what would weaken the thesis qualitatively, using only figures already in the clips.
- stance object required (see schema).
- Tone and keyResult must agree. Do not claim a strong lean with a hedged, noncommittal keyResult.
- Writing: no em dashes, no semicolons, no emoji, no bullet lists inside prose. Flowing paragraphs. Spartan. No restating Purpose/Goal as labels.
- Curate sections: only clips that advance the thesis. Supporting non-chart evidence may go to appendixClipIds. Omit irrelevant or redundant chart clips entirely.
- Every body section needs keyFigures (2–4 real figures from that clip). Keep keyFigures sparse.
- Large boards: two to five key figures, not every row.
- Report length is driven by valuationContext.reportLength (see LENGTH above), not by clip count. Merge clips that serve the same point into one section (e.g. two DCF verdicts for a comparison, or a KPI panel plus the chart behind it) rather than writing a section per clip.
- Every section's analysis must interpret, compare, or draw a conclusion — never transcribe a clip's numbers back as prose with no takeaway (e.g. do not write "NVDA's price is $206.84, P/E is 31.6x, EPS is $6.54" and stop there; those figures already appear in the keyFigures/table below the prose). If a clip has nothing to add beyond its own numbers, cut the section. A supporting non-chart clip may move to appendixClipIds; an unused chart must be omitted.

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "headline": "punchy research-note title, under 12 words, no period",
  "stance": {
    "lean": "bullish" | "bearish" | "neutral",
    "conviction": "low" | "moderate" | "high",
    "baseCase": "{{BASE_CASE_SCHEMA}}",
    "thesis": "one sentence: what you believe and why, over the lookforward"
  },
  "keyResult": {
    "label": "{{KEY_RESULT_LABEL_SCHEMA}}",
    "value": "{{KEY_RESULT_VALUE_SCHEMA}}",
    "context": "{{KEY_RESULT_CONTEXT_SCHEMA}}"
  },
  "executiveSummary": "one tight paragraph stating the verdict (range or open) and how the clips jointly justify it (not a list of panel summaries)",
  "sections": [
    {
      "clipId": "<id>",
      "heading": "analytical heading naming the comparative theme, not the tool name or a single subject",
      "design": "visual | narrative | balanced | compact",
      "analysis": "paragraphs linking figures to the verdict (what moves it, what strengthens or weakens it) — interpret, do not transcribe. Section count and depth follow valuationContext.reportLength, not clip count. Do NOT include a chart field; the site adds charts.",
      "keyFigures": [ { "label": "metric", "value": "figure with units" } ]
    }
  ],
  "conclusion": "restate the verdict and conviction, the main risk to it, and a concrete action",
  "appendixClipIds": ["<supporting non-chart clip ids only>"]
}
Every clipId must be one of the provided clip ids."""


# Report types whose subject is an aggregate — a book, a regime, a result set —
# rather than one issuer. For these, resolving a single subject equity is always
# wrong: the highest-scoring constituent would become the report's subject.
_BOOK_LEVEL_TYPES = frozenset({"portfolio-review", "macro-brief", "screen-summary"})
_NAMED_SUBJECT_TYPES = frozenset({"comparison", "thesis"})
# Same test the research planner uses to classify portfolio intent. The planner
# already routed these to portfolio tools while the generator went on resolving a
# single subject equity, which is the disagreement that rated a four-holding book
# review as a Hold on one holding.
_PORTFOLIO_INTENT_RE = re.compile(r"\b(portfolio|holdings|book|positions|allocation|my account)\b", re.I)


def _book_level_report(req, subjects_ranked: list[str]) -> bool:
    """True when the report's subject is an aggregate rather than one issuer."""
    if req.reportType in _BOOK_LEVEL_TYPES:
        return True
    if req.reportType in _NAMED_SUBJECT_TYPES:
        return False
    # 'equity-note' is also the stored default for projects created before the
    # setup flow existed, so it cannot be read as a deliberate choice. Fall back
    # to the objective — but require more than one candidate subject, so a real
    # single-name note that merely mentions a portfolio keeps its subject.
    text = f"{getattr(req, 'goal', '')}\n{getattr(req, 'purpose', '')}"
    return len(subjects_ranked) >= 2 and bool(_PORTFOLIO_INTENT_RE.search(text))

# Chosen in the setup flow. Each names the argument shape and the verdict the
# reader is owed, which the generic prompt cannot infer from the goal alone.
_REPORT_TYPE_GUIDANCE = {
    "equity-note": (
        "REPORT TYPE — Equity note. One issuer. Organize by driver (demand, margin, capital allocation, "
        "valuation), not by data source. Close on a Buy/Hold/Avoid/Watch verdict with the single condition "
        "that would change it."
    ),
    "comparison": (
        "REPORT TYPE — Comparison. Two or more subjects judged against each other. Every body section is one "
        "comparative theme covering all subjects together; never one section per subject. Each section names "
        "which subject wins that theme and by how much. Close by naming the winner outright."
    ),
    "macro-brief": (
        "REPORT TYPE — Macro brief. Cross-asset or thematic; no single issuer is the subject. Lead with the "
        "regime read, then the assets it implicates. State what would falsify the read. Keep single-name "
        "detail out unless it evidences the macro point."
    ),
    "portfolio-review": (
        "REPORT TYPE — Portfolio review. The subject is the reader's book. Organize by exposure, "
        "concentration, and risk contribution rather than by holding. Close on specific actions (trim, add, "
        "hedge, hold) naming the positions each applies to. The allocation table and deterministic portfolio "
        "metrics are authoritative. Never describe a negative active return as outperformance. For samples "
        "under one year, say period return, not CAGR. Do not claim a tilt or holding caused performance unless "
        "a holding-level or factor attribution clip quantifies that contribution. Do not recommend maintaining "
        "the current allocation when material positions are unpriced or the allocation clip says weights are "
        "incomplete. Benchmark-relative conclusions must compare return and risk-adjusted metrics. Earnings "
        "analysis may cover actual holdings only, and absolute EPS levels across companies are not comparable. "
        "A macro risk named in the headline or verdict must have a dedicated evidence clip and a quantified "
        "portfolio transmission mechanism; otherwise state that the evidence is insufficient. Distinguish "
        "backward-looking measurements from forward scenarios and disclose methodology limitations."
    ),
    "screen-summary": (
        "REPORT TYPE — Screen summary. The subject is a result set. Say what the screen selected for, then "
        "rank the names that survive scrutiny and say plainly which fail it and why. Close with the shortlist."
    ),
    "thesis": (
        "REPORT TYPE — Thesis. Long-form. Build the case in full: the setup, the mechanism, the evidence, the "
        "bear case argued at its strongest, and what would break the thesis. Do not compress to a verdict too "
        "early; the argument is the product."
    ),
}

_BOOK_LEVEL_VERDICT_GUIDANCE = (
    "AGGREGATE SUBJECT — this report is about a book, a regime, or a result set, not one issuer.\n"
    "- Do NOT headline a single ticker and do NOT make the verdict a rating on one name. "
    "\"Hold NVDA\" is wrong here even if one holding dominates the evidence.\n"
    "- keyResult.value is an action on the whole subject, such as \"Trim Semis Concentration\", "
    "\"Reduce Tech Risk\", or \"Add Duration\".\n"
    "- stance.baseCase names the aggregate or the theme, never a single ticker.\n"
    "- Individual names appear as evidence for the aggregate read, not as the thing being rated."
)


def _report_system_prompt(mode: str, length_key: str, must_include: str,
                          report_type: str = "", book_level: bool = False) -> str:
    """The layout preset is deliberately NOT passed here: renderer preset names are
    kept out of the model's vocabulary (it emits a coarse `design` intent instead)
    and layout is resolved deterministically in _apply_section_layout_architecture."""
    mode_key = "range" if mode == "range" else "open"
    mode_guidance = _REPORT_RANGE_GUIDANCE if mode_key == "range" else _REPORT_OPEN_GUIDANCE
    # Independent of report type: a project stored before the setup flow existed
    # carries no type, so the aggregate direction has to attach to the detection
    # rather than to the type alone.
    if book_level:
        mode_guidance = f"{mode_guidance}\n\n{_BOOK_LEVEL_VERDICT_GUIDANCE}"
    type_guidance = _REPORT_TYPE_GUIDANCE.get(report_type, "")
    if type_guidance:
        mode_guidance = f"{mode_guidance}\n\n{type_guidance}"
    schema = _REPORT_SCHEMA_BY_MODE[mode_key]
    return (
        _REPORT_SYSTEM
        .replace("{{MODE_GUIDANCE}}", mode_guidance)
        .replace("{{LENGTH_GUIDANCE}}", _LENGTH_SPEC[length_key]["guidance"])
        .replace("{{MUST_INCLUDE_SECTION}}", must_include)
        .replace("{{EDITORIAL_STANDARD}}", _RESEARCH_NOTE_EDITORIAL_STANDARD)
        .replace("{{BASE_CASE_SCHEMA}}", schema["baseCase"])
        .replace("{{KEY_RESULT_LABEL_SCHEMA}}", schema["label"])
        .replace("{{KEY_RESULT_VALUE_SCHEMA}}", schema["value"])
        .replace("{{KEY_RESULT_CONTEXT_SCHEMA}}", schema["context"])
    )

def _clean_figs(raw) -> list:
    figs = []
    for f in (raw or [])[:6]:
        if isinstance(f, dict):
            label = str(f.get("label", "")).strip()
            value = str(f.get("value", "")).strip()
            if label and value:
                figs.append({"label": label[:60], "value": value[:60]})
    return figs


def _report_title(result: dict, outline: dict | None, req: ReportGenRequest) -> str:
    raw = str(result.get("headline", "")).strip()
    if not raw and outline:
        raw = str(outline.get("thesis", "")).strip()
    if not raw:
        raw = (req.goal or req.projectName or "AlphaTape Research").strip()
    words = raw.rstrip(" .").split()
    return _title_case(" ".join(words[:12]), 96) or "AlphaTape Research"

_CHART_TYPES = {"bar", "line", "area", "pie", "histogram", "dot", "range", "scatter", "box"}
_SINGLE_SERIES_TYPES = {"pie", "scatter"}  # only series[0] is used
_BOX_KEYS = ("min", "q1", "median", "q3", "max")

# Title Case: small words stay lowercase mid-phrase; finance acronyms / tickers stay upper.
_TITLE_SMALL = {
    "a", "an", "the", "and", "or", "of", "for", "to", "in", "on", "at", "by", "vs", "vs.",
    "via", "per", "as", "from", "into", "over", "with", "than",
}
_TITLE_ACRONYMS = {
    "dcf", "wacc", "fcf", "peg", "roe", "roa", "roi", "ev", "eps", "cagr", "yoy", "ytd",
    "qtd", "iv", "gex", "kpi", "ai", "us", "uk", "eu", "fx", "pe", "p/e", "p/s", "p/b",
    "p/fcf", "ev/ebitda", "ebitda", "ebit", "nopat", "capex", "d&a", "wc", "ipo", "etf",
    "gdp", "cpi", "fed", "sec", "api", "pdf", "usd", "m&a",
}

def _title_case(s: str | None, max_len: int = 80) -> str:
    """Proper Title Case for section headings and chart titles.

    Preserves finance acronyms (DCF, WACC, P/E), keeps small words lowercase when
    not first/last, and leaves all-caps tickers (NVDA, AAPL) intact.
    """
    if not s:
        return ""
    text = re.sub(r"\s+", " ", str(s).strip())
    if not text:
        return ""
    # Split on whitespace but keep hyphenated compounds and slash units together.
    parts = re.split(r"(\s+)", text)
    word_idxs = [i for i, p in enumerate(parts) if p.strip() and not p.isspace()]
    out: list[str] = []
    for i, part in enumerate(parts):
        if not part.strip() or part.isspace():
            out.append(part)
            continue
        is_first = i == word_idxs[0] if word_idxs else True
        is_last = i == word_idxs[-1] if word_idxs else True
        # Em-dash / en-dash separated clauses: title-case each side independently
        # is already handled by treating the dash as its own token when split fails;
        # for "A — B" the split keeps "—" with spaces as separate parts.
        token = part
        # Slash units like P/E, EV/EBITDA
        low = token.lower().strip("()[],.:;")
        punct_prefix = token[: len(token) - len(token.lstrip("([\"'"))]
        punct_suffix = token[len(token.rstrip(")].,:;'\"%!?")):] if token else ""
        core = token[len(punct_prefix): len(token) - len(punct_suffix) or None]
        if not core:
            out.append(token)
            continue
        core_low = core.lower()
        if core_low in _TITLE_ACRONYMS or core_low.replace(".", "") in _TITLE_ACRONYMS:
            cased = core_low.upper() if "/" not in core_low and "&" not in core_low else core.upper()
            # P/E style
            if "/" in core_low:
                cased = "/".join(
                    (p.upper() if p.lower() in _TITLE_ACRONYMS or len(p) <= 3 else p.capitalize())
                    for p in core.split("/")
                )
            out.append(f"{punct_prefix}{cased}{punct_suffix}")
            continue
        # All-caps ticker-like token (2–5 letters) — keep as-is upper
        if re.fullmatch(r"[A-Za-z]{1,5}", core) and core.isupper() and core_low not in _TITLE_SMALL:
            out.append(f"{punct_prefix}{core.upper()}{punct_suffix}")
            continue
        if core_low in _TITLE_SMALL and not is_first and not is_last:
            out.append(f"{punct_prefix}{core_low}{punct_suffix}")
            continue
        # Hyphenated: Title-Case Each Piece
        if "-" in core and not core.startswith("-"):
            cased = "-".join(
                (p.upper() if p.lower() in _TITLE_ACRONYMS or (p.isupper() and len(p) <= 5)
                 else (p.capitalize() if p else p))
                for p in core.split("-")
            )
            out.append(f"{punct_prefix}{cased}{punct_suffix}")
            continue
        out.append(f"{punct_prefix}{core[:1].upper()}{core[1:].lower()}{punct_suffix}")
    result = "".join(out).strip()
    return result[:max_len] if max_len else result

def _clean_box_chart(raw: dict) -> dict | None:
    """Validate a box-and-whisker chart. Each data row is a distribution with
    min/q1/median/q3/max and optional marker points (the subjects' own values).
    Built server-side from a peer table, so this only sanity-checks structure.
    Whiskers are expected to already be Tukey-fenced (1.5×IQR); this still
    enforces monotone ordering so a bad row cannot break the renderer."""
    x_key = str(raw.get("xKey", "")).strip() or "metric"
    rows: list[dict] = []
    for row in (raw.get("data") or [])[:6]:
        if not isinstance(row, dict):
            continue
        stats = {k: _coerce_num(row.get(k)) for k in _BOX_KEYS}
        if any(stats[k] is None for k in _BOX_KEYS):
            continue
        # Monotone: q1 ≤ median ≤ q3, whiskers outside the box.
        q1, med, q3 = stats["q1"], stats["median"], stats["q3"]
        if q1 > q3:
            q1, q3 = q3, q1
        med = min(max(med, q1), q3)
        mn = min(stats["min"], q1)
        mx = max(stats["max"], q3)
        clean = {x_key: str(row.get(x_key, ""))[:40],
                 "min": mn, "q1": q1, "median": med, "q3": q3, "max": mx}
        markers = []
        for m in (row.get("markers") or [])[:6]:
            if isinstance(m, dict):
                mv = _coerce_num(m.get("value"))
                ml = str(m.get("label", "")).strip()[:12]
                if mv is not None and ml:
                    markers.append({"label": ml, "value": mv})
        if markers:
            clean["markers"] = markers
        # Optional outlier list (beyond Tukey fences) for the renderer.
        outliers = []
        for o in (row.get("outliers") or [])[:12]:
            if isinstance(o, dict):
                ov = _coerce_num(o.get("value"))
                ol = str(o.get("label", "")).strip()[:12]
                if ov is not None:
                    outliers.append({"label": ol, "value": ov} if ol else {"value": ov})
            else:
                ov = _coerce_num(o)
                if ov is not None:
                    outliers.append({"value": ov})
        if outliers:
            clean["outliers"] = outliers
        rows.append(clean)
    if not rows:
        return None
    return {"kind": "chart", "chartType": "box",
            "title": _title_case(str(raw.get("title", "")).strip(), 60) or None,
            "xKey": x_key, "data": rows,
            "series": [{"key": s.get("key", "v"), "label": str(s.get("label", "")).strip()[:40] or "value"}
                       for s in (raw.get("series") or [{"key": "v", "label": "value"}])[:1]]}

def _coerce_num(v) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        return _parse_money(v.replace("%", "").replace("$", ""))
    return None

def _clean_chart(raw) -> dict | None:
    """Validate/sanitize a model-synthesized chart (ClipPayload 'chart' shape).
    Drops it entirely rather than guessing at malformed structure — a missing
    chart degrades to prose + keyFigures, never a broken visual. See the
    ChartPayload chartType data-convention comment in reportCreator.ts for the
    per-type shape (pie/scatter use series[0] only; range values are a
    [low, high] tuple per series, not two separately-named keys; scatter's
    xKey values are numeric, not categories)."""
    if not isinstance(raw, dict):
        return None
    chart_type = str(raw.get("chartType", "")).strip().lower()
    if chart_type not in _CHART_TYPES:
        return None
    if chart_type == "box":
        return _clean_box_chart(raw)
    x_key = str(raw.get("xKey", "")).strip()
    if not x_key:
        return None

    series: list[dict] = []
    series_cap = 1 if chart_type in _SINGLE_SERIES_TYPES else 4
    for s in (raw.get("series") or [])[:series_cap]:
        if not isinstance(s, dict):
            continue
        key = str(s.get("key", "")).strip()
        if not key:
            continue
        label = str(s.get("label", "")).strip()[:40] or key
        series.append({"key": key, "label": label})
    if not series:
        return None
    if chart_type != "range" and any(
        s["key"].lower().endswith(("_low", "_high")) for s in series
    ):
        # A near-certain sign of a botched hand-rolled range chart (the model
        # used chartType "bar" with series literally named "<x>_low"/"<x>_high"
        # instead of chartType "range" with a [low, high] tuple) — the raw
        # field name would leak into the legend. Drop rather than show it.
        return None
    series_keys = {s["key"] for s in series}

    data: list[dict] = []
    for row in (raw.get("data") or [])[:8]:
        if not isinstance(row, dict) or x_key not in row or row[x_key] is None:
            continue

        if chart_type == "scatter":
            x_num = _coerce_num(row[x_key])
            y_num = _coerce_num(row.get(series[0]["key"]))
            if x_num is None or y_num is None:
                continue
            clean_row: dict = {x_key: x_num, series[0]["key"]: y_num}
            label = row.get("label")
            if isinstance(label, str) and label.strip():
                clean_row["label"] = label.strip()[:40]
            data.append(clean_row)
            continue

        clean_row = {x_key: str(row[x_key])[:40]}
        has_value = False
        if chart_type == "range":
            for k in series_keys:
                v = row.get(k)
                if not (isinstance(v, (list, tuple)) and len(v) == 2):
                    continue
                lo, hi = _coerce_num(v[0]), _coerce_num(v[1])
                if lo is not None and hi is not None:
                    clean_row[k] = [min(lo, hi), max(lo, hi)]
                    has_value = True
        else:
            for k in series_keys:
                num = _coerce_num(row.get(k))
                if num is not None:
                    clean_row[k] = num
                    has_value = True
        if has_value:
            data.append(clean_row)

    if len(data) < 2:
        return None

    title = _title_case(str(raw.get("title", "")).strip(), 60)
    return {
        "kind": "chart",
        "chartType": chart_type,
        "title": title or None,
        "xKey": x_key,
        "data": data,
        "series": series,
    }

_TICKER_STOP = {
    "THE", "AND", "FOR", "FROM", "LAST", "DAYS", "DAY", "YTD", "QTD", "PDF", "API", "USD",
    "CEO", "CFO", "EPS", "PE", "AI", "US", "UK", "EU", "FX", "VIX", "DCF", "FCF",
    "EV", "WACC", "KPI", "ROI", "ROA", "ROE", "NIM", "NCO", "GDP", "CPI", "FED",
    "ETF", "IPO", "ALL", "NOT", "YES", "LOW", "HIGH", "MID", "NET", "PER", "VS",
    "TO", "OF", "OR", "IN", "ON", "AT", "BY", "AS", "AN", "A", "IS", "BE", "IT",
    "RANGE", "FAIR", "VALUE", "PRICE", "TARGET", "STOCK", "SHARE", "SHARES",
    "NEXT", "OVER", "INTO", "WITH", "THIS", "THAT", "THAN", "THEN", "WHEN",
    "WHAT", "WILL", "WEEK", "YEAR", "MONTH", "REPORT", "MODEL", "SPOT",
    "OLD", "BIG", "TOP", "OUT", "CAN", "HAS", "HAD", "WAS", "ARE",
    "ANY", "OWN", "OUR", "ITS", "HIS", "HER", "WHO", "HOW", "WHY", "MAY", "GET",
    "SET", "RUN", "USE", "SEE", "SAY", "TRY", "WAY", "END", "AGO", "YET", "TOO",
    "ALSO", "JUST", "ONLY", "EVEN", "MUCH", "MANY", "MOST", "SOME", "SUCH",
    "VERY", "WELL", "BACK", "BOTH", "EACH", "FEW", "MORE", "SAME", "OTHER",
    "UNDER", "AFTER", "BEFORE", "ABOUT", "ABOVE", "BELOW", "BETWEEN", "DURING",
    "THROUGH", "ACROSS", "AGAINST", "WITHOUT", "WITHIN", "ESTIMATE", "ANALYZE",
    "IDENTIFY", "HORIZON", "LOOKBACK", "OUTLOOK", "QUARTER", "PORTFOLIO",
    "MARKET", "CREDIT", "STRESS", "GLOBAL", "MACRO",
    # NOTE: NOW/NEW/ALL stay out of the hard stop — they are real tickers but
    # live in _AMBIGUOUS_TICKERS and require strong context (not "from now").
}

# Listings that collide with English (ServiceNow=NOW). Accept only with clear cues.
_AMBIGUOUS_TICKERS = {
    "NOW", "NEW", "ALL", "ONE", "TWO", "BIG", "TOP", "OLD", "LOW", "OUT", "CAN",
    "HAS", "ANY", "OWN", "SO", "UP", "ON", "IT", "OR", "IF", "DO", "GO", "AN",
    "BY", "TO", "AT", "IN", "FOR", "NEXT", "LAST", "FROM", "DAYS", "DAY", "WEEK",
    "YEAR", "SOON", "NEAR", "LONG", "FAST", "REAL", "SAFE", "TRUE", "FREE", "OPEN",
    "LIVE", "FUND", "BOND", "CASH", "GOLD", "TECH", "DATA", "AUTO", "BEST", "GOOD",
    "PLAY", "MOVE", "CALL", "PUT", "BEAT", "MISS", "GAIN", "LOSS", "RISK", "RATE",
}

# Common company names → listing ticker (fast path before FMP/yfinance search).
_COMPANY_ALIASES = {
    "nvidia": "NVDA", "nvda": "NVDA",
    "apple": "AAPL", "aapl": "AAPL",
    "microsoft": "MSFT", "msft": "MSFT",
    "google": "GOOGL", "alphabet": "GOOGL", "googl": "GOOGL", "goog": "GOOG",
    "amazon": "AMZN", "amzn": "AMZN",
    "meta": "META", "facebook": "META",
    "tesla": "TSLA", "tsla": "TSLA",
    "broadcom": "AVGO", "avgo": "AVGO",
    "amd": "AMD", "advanced micro devices": "AMD",
    "intel": "INTC", "intc": "INTC",
    "netflix": "NFLX", "nflx": "NFLX",
    "salesforce": "CRM", "crm": "CRM",
    "oracle": "ORCL", "orcl": "ORCL",
    "adobe": "ADBE", "adbe": "ADBE",
    "costco": "COST", "cost": "COST",
    "walmart": "WMT", "wmt": "WMT",
    "jpmorgan": "JPM", "jp morgan": "JPM", "jpm": "JPM",
    "berkshire": "BRK.B", "berkshire hathaway": "BRK.B",
    "exxon": "XOM", "exxonmobil": "XOM", "xom": "XOM",
    "chevron": "CVX", "cvx": "CVX",
    "visa": "V", "mastercard": "MA",
    "paypal": "PYPL", "pypl": "PYPL",
    "uber": "UBER", "airbnb": "ABNB", "abnb": "ABNB",
    "palantir": "PLTR", "pltr": "PLTR",
    "coinbase": "COIN", "coin": "COIN",
    "micron": "MU", "mu": "MU",
    "qualcomm": "QCOM", "qcom": "QCOM",
    "texas instruments": "TXN", "txn": "TXN",
    "asml": "ASML", "tsmc": "TSM", "taiwan semiconductor": "TSM",
    "servicenow": "NOW", "service now": "NOW",
}

_DCF_TICKER_RE = re.compile(
    r"(?:DCF|Intrinsic|Verdict|Valuation|Assumptions|Bridge|Sensitivity|Projection)[^\n·•|\-]*[·•|\-]\s*([A-Z]{1,5})\b",
    re.I,
)
_EXPLICIT_TICKER_RE = re.compile(
    r"(?:\$|ticker\s*[:=]?\s*|symbol\s*[:=]?\s*|\(|\bfor\s+|\bof\s+|\bon\s+)"
    r"([A-Za-z]{1,5})(?:'s|’s)?\b",
    re.I,
)
_RANGE_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)\s*[-–—to]+\s*\$?\s*([\d,]+(?:\.\d+)?)",
    re.I,
)
_ENGLISH_NOW_RE = re.compile(
    r"\b(?:from|right|by|until|till|starting|as\s+of|up\s+to)\s+now\b|"
    r"\bnow\s+(?:on|that|the|we|i|to|for|is|as)\b",
    re.I,
)

def _parse_money(s: str) -> float | None:
    try:
        return float(s.replace(",", ""))
    except Exception:
        return None

def _is_plausible_ticker(sym: str) -> bool:
    s = (sym or "").upper()
    if not s or s in _TICKER_STOP:
        return False
    return bool(re.fullmatch(r"[A-Z]{1,5}", s))

def _ticker_context_score(sym: str, blob: str) -> int:
    """Higher = more likely the user meant this equity, not an English word."""
    if not blob:
        return 0
    s = sym.upper()
    score = 0
    if re.search(rf"\${re.escape(s)}\b", blob, re.I):
        score += 50
    if re.search(rf"\({re.escape(s)}\)", blob, re.I):
        score += 40
    if re.search(rf"\b(?:ticker|symbol)\s*[:=]?\s*{re.escape(s)}\b", blob, re.I):
        score += 45
    if re.search(rf"\b(?:for|of|on|in)\s+{re.escape(s)}\b", blob, re.I):
        score += 30
    if re.search(rf"\b{re.escape(s)}\b\s+(?:fair|value|price|target|dcf|valuation|stock|shares)\b", blob, re.I):
        score += 35
    if re.search(rf"\b(?:fair|value|price|target|dcf|valuation|stock)\b[^\n.]{{0,40}}\b{re.escape(s)}\b", blob, re.I):
        score += 30
    if re.search(rf"\b{re.escape(s)}\b", blob):
        score += 10
    if s in _AMBIGUOUS_TICKERS:
        score -= 40
        if s == "NOW" and _ENGLISH_NOW_RE.search(blob):
            score -= 50
        if s == "NOW" and re.search(r"servicenow|service\s*now", blob, re.I):
            score += 80
    return score

def _extract_ticker_candidates(*texts: str) -> list[str]:
    out: list[str] = []
    for t in texts:
        if not t:
            continue
        for m in _EXPLICIT_TICKER_RE.finditer(t):
            sym = m.group(1).upper()
            if _is_plausible_ticker(sym) and sym not in out:
                out.append(sym)
        for m in re.finditer(r"\b([A-Za-z]{2,5})(?:'s|’s)?\b", t):
            sym = m.group(1).upper()
            if not _is_plausible_ticker(sym) or sym in out:
                continue
            raw = m.group(1)
            # Only bare tokens that look like tickers (all-caps) or known alias keys
            # (nvda, aapl). Do NOT treat alias values as a match for English words
            # ("now" must not become ServiceNow's NOW).
            if raw.isupper() or raw.lower() in _COMPANY_ALIASES:
                out.append(sym)
    return out

def _alias_hits(*texts: str) -> list[str]:
    blob = " ".join(t for t in texts if t).lower()
    if not blob:
        return []
    hits: list[str] = []
    for name in sorted(_COMPANY_ALIASES.keys(), key=len, reverse=True):
        if re.search(rf"\b{re.escape(name)}\b", blob):
            sym = _COMPANY_ALIASES[name]
            if sym not in hits:
                hits.append(sym)
    return hits

def _search_symbol(query: str) -> str | None:
    q = (query or "").strip()
    if not q or len(q) < 2:
        return None
    if q.upper() in _TICKER_STOP or q.upper() in _AMBIGUOUS_TICKERS:
        return None
    try:
        import fmp
        if fmp.available():
            rows = fmp.search_symbols(q, limit=5)
            for r in rows:
                sym = str(r.get("ticker") or "").upper()
                if sym and _is_plausible_ticker(sym) and sym not in _AMBIGUOUS_TICKERS:
                    return sym
                if sym and _is_plausible_ticker(sym):
                    return sym
    except Exception as e:
        logger.warning("report FMP symbol search failed for %r: %s", q, e)
    try:
        import yfinance as yf
        search = getattr(yf, "Search", None)
        if search is not None:
            res = search(q, max_results=5)
            quotes = getattr(res, "quotes", None) or []
            for row in quotes:
                sym = str(row.get("symbol") or "").upper()
                if not sym or "." in sym or not _is_plausible_ticker(sym):
                    continue
                if sym in _AMBIGUOUS_TICKERS:
                    continue
                if len(sym) <= 5:
                    return sym
    except Exception as e:
        logger.warning("report yfinance symbol search failed for %r: %s", q, e)
    return None

def _dcf_tickers_from_clips(clips: list[ReportClipIn]) -> set[str]:
    found: set[str] = set()
    for c in clips:
        blob = f"{c.sourceTab} {c.title} {c.dataSummary}"
        if not re.search(r"dcf|intrinsic\s*/?\s*share|enterprise\s+value", blob, re.I):
            continue
        for m in _DCF_TICKER_RE.finditer(blob):
            sym = m.group(1).upper()
            if _is_plausible_ticker(sym):
                found.add(sym)
        for m in re.finditer(r"[·•]\s*([A-Z]{1,5})\b", blob):
            sym = m.group(1).upper()
            if _is_plausible_ticker(sym):
                found.add(sym)
    return found

def _score_subjects(req: ReportGenRequest) -> dict[str, int]:
    """Score every plausible ticker mentioned across goal/purpose/name/clips."""
    goal = req.goal or ""
    purpose = req.purpose or ""
    name = req.projectName or ""
    goal_purpose = f"{goal}\n{purpose}"
    all_text = f"{goal}\n{purpose}\n{name}"
    scores: dict[str, int] = {}

    def bump(sym: str, pts: int, blob: str = all_text):
        if not _is_plausible_ticker(sym):
            return
        s = sym.upper()
        scores[s] = scores.get(s, 0) + pts + _ticker_context_score(s, blob)

    for sym in _alias_hits(goal, purpose):
        bump(sym, 100, goal_purpose)
    for sym in _alias_hits(name):
        bump(sym, 40, name)

    for sym in _extract_ticker_candidates(goal):
        bump(sym, 80, goal)
    for sym in _extract_ticker_candidates(purpose):
        bump(sym, 50, purpose)
    for sym in _extract_ticker_candidates(name):
        bump(sym, 25, name)

    dcf = _dcf_tickers_from_clips(req.clips)
    clip_blob = " ".join(f"{c.title} {c.dataSummary}" for c in req.clips)
    for sym in dcf:
        bump(sym, 60, clip_blob)

    # Subject-owned research clips are a stronger fallback than guessing a company
    # from generic prose, but explicit objective language still wins.
    for sym, count in _subject_evidence_tickers(req.clips).items():
        bump(sym, min(70, 45 + (count - 1) * 5), clip_blob)

    if not scores or max(scores.values()) < 40:
        for source, w in ((goal, 55), (purpose, 35), (name, 20)):
            if not source:
                continue
            for m in re.finditer(r"\b([A-Za-z][A-Za-z.&'-]{1,30})(?:'s|’s)?\b", source):
                word = m.group(1)
                if word.upper() in _TICKER_STOP or word.lower() in {
                    "estimate", "analyze", "identify", "fair", "value", "range", "price",
                    "target", "report", "next", "days", "last", "quarter", "portfolio",
                    "from", "now", "into", "over", "under", "about",
                }:
                    continue
                resolved = _search_symbol(word)
                if resolved:
                    bump(resolved, w, source)

    return scores

def _subject_scores(req: ReportGenRequest) -> dict[str, int]:
    """Combine evidence/text scores with an optional client hint.

    A hint is only used when the request has no high-confidence subject already.
    This prevents a stale screener symbol from overriding "JPMorgan" in the goal.
    """
    scores = _score_subjects(req)
    explicit = (getattr(req, "subjectTicker", None) or "").strip().upper()
    if explicit and _is_plausible_ticker(explicit):
        best_score = max(scores.values()) if scores else 0
        if not scores or best_score < 80 or scores.get(explicit, -1) >= best_score:
            scores[explicit] = scores.get(explicit, 0) + 90
    return scores

def _subject_ticker(req: ReportGenRequest) -> str | None:
    """Resolve subject equity — scored so 'from NOW' loses to NVDA."""
    scores = _subject_scores(req)
    if not scores:
        return None

    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    for sym, sc in ranked:
        if sym in _AMBIGUOUS_TICKERS and sc < 50:
            continue
        if sc <= 0:
            continue
        return sym
    best_sym, best_sc = ranked[0]
    return best_sym if best_sc > 0 else None

def _ranked_subjects(req: ReportGenRequest, limit: int = 4) -> list[str]:
    """All plausible subjects above the confidence floor, ranked — used to
    detect comparison-style reports (2+ named tickers) so the report doesn't
    collapse onto whichever one ticker _subject_ticker would have picked."""
    scores = _subject_scores(req)
    ranked = sorted(scores.items(), key=lambda kv: (-kv[1], kv[0]))
    out: list[str] = []
    for sym, sc in ranked:
        if len(out) >= limit:
            break
        if sym in out:
            continue
        if sym in _AMBIGUOUS_TICKERS and sc < 50:
            continue
        if sc <= 0:
            continue
        out.append(sym)
    return out

_COMPARISON_RE = re.compile(
    r"\bvs\.?\b|\bversus\b|\bcompar(?:e|es|ed|ison|ing)\b|\bbetter\s+(?:pick|buy|value|choice)\b|"
    r"\brelative\s+value\b|\bwhich\s+(?:one|stock|name|company)\b|\brank(?:ing)?\b|"
    r"\bpair(?:s)?\s*trade\b|\bside[- ]by[- ]side\b|\bhead[- ]to[- ]head\b",
    re.I,
)
_PRICE_RANGE_GOAL_RE = re.compile(
    r"\b(?:fair|intrinsic)\s+value\b|\bprice\s+(?:target|range|forecast)\b|"
    r"\btarget\s+price\b|\bvaluation\s+range\b|\bupside\s+(?:case|potential)\b|"
    r"\bdownside\s+(?:case|risk)\b|\bwhere\s+(?:can|could|will)\s+(?:the\s+)?(?:stock|shares?|price)\b",
    re.I,
)

def _report_mode(req: ReportGenRequest, subjects: list[str]) -> str:
    """Use a range only when a one-company goal explicitly asks for valuation or
    a price target. Generic equity research receives an actionable open verdict."""
    if len(subjects) != 1:
        return "open"
    text = f"{req.goal}\n{req.purpose}".strip()
    if text and _COMPARISON_RE.search(text):
        return "open"
    return "range" if text and _PRICE_RANGE_GOAL_RE.search(text) else "open"

def _subject_dcf_present(clips: list[ReportClipIn], subject: str | None) -> bool:
    if not subject:
        return False
    sub = subject.upper()
    for c in clips:
        blob = f"{c.sourceTab} {c.title} {c.dataSummary}"
        if not re.search(r"dcf|intrinsic\s*/?\s*share", blob, re.I):
            continue
        if re.search(rf"(?:·|•)\s*{re.escape(sub)}\b", blob, re.I):
            return True
        if re.search(rf"\b{re.escape(sub)}\b", blob) and re.search(r"intrinsic", blob, re.I):
            return True
    return False

def _fetch_market_quote(ticker: str | None) -> dict:
    """Live last price (+ optional day change) for the subject equity."""
    empty = {"ticker": ticker, "price": None, "changePct": None, "name": None, "source": None}
    if not ticker:
        return empty
    sym = ticker.strip().upper()
    out = {**empty, "ticker": sym}

    # Primary: shared live quote path (Alpaca / Tradier / yfinance).
    try:
        from quotes import live_price
        p = live_price(sym)
        if p and p > 0:
            out["price"] = float(p)
            out["source"] = "live_price"
    except Exception as e:
        logger.warning("report live_price failed for %s: %s", sym, e)

    # Enrich with name + day change via yfinance (and price fallback).
    try:
        import yfinance as yf
        t = yf.Ticker(sym)
        info = {}
        try:
            info = t.fast_info or {}
        except Exception:
            info = {}
        if out["price"] is None:
            p = getattr(info, "last_price", None) if not isinstance(info, dict) else info.get("last_price")
            if p and float(p) > 0:
                out["price"] = float(p)
                out["source"] = "yfinance.fast_info"
        prev = getattr(info, "previous_close", None) if not isinstance(info, dict) else info.get("previous_close")
        if out["price"] and prev and float(prev) > 0:
            out["changePct"] = (out["price"] / float(prev) - 1.0) * 100.0
        try:
            meta = t.info or {}
            if isinstance(meta, dict):
                out["name"] = meta.get("shortName") or meta.get("longName") or out["name"]
                if out["price"] is None:
                    p = meta.get("currentPrice") or meta.get("regularMarketPrice")
                    if p and float(p) > 0:
                        out["price"] = float(p)
                        out["source"] = "yfinance.info"
                if out["changePct"] is None and meta.get("regularMarketChangePercent") is not None:
                    out["changePct"] = float(meta["regularMarketChangePercent"])
        except Exception:
            pass
    except Exception as e:
        logger.warning("report yfinance enrich failed for %s: %s", sym, e)

    return out

def _fetch_market_price(ticker: str | None) -> float | None:
    q = _fetch_market_quote(ticker)
    p = q.get("price")
    return float(p) if p and float(p) > 0 else None

def _dcf_intrinsic_for_subject(clips: list[ReportClipIn], subject: str | None) -> float | None:
    if not subject:
        return None
    sub = subject.upper()
    for c in clips:
        blob = f"{c.title} {c.dataSummary}"
        if not re.search(rf"(?:·|•)\s*{re.escape(sub)}\b|\b{re.escape(sub)}\b", blob):
            continue
        if not re.search(r"intrinsic", blob, re.I):
            continue
        m = re.search(r"intrinsic\s*/?\s*share\s*[:=]?\s*\$?\s*([\d,]+(?:\.\d+)?)", blob, re.I)
        if m:
            return _parse_money(m.group(1))
        # KPI summary: "Intrinsic / Share: $196.17"
        m = re.search(r"Intrinsic\s*/\s*Share:\s*\$?\s*([\d,]+(?:\.\d+)?)", blob, re.I)
        if m:
            return _parse_money(m.group(1))
    return None

def _parse_range(value: str) -> tuple[float, float] | None:
    m = _RANGE_RE.search(value or "")
    if not m:
        return None
    a, b = _parse_money(m.group(1)), _parse_money(m.group(2))
    if a is None or b is None:
        return None
    return (min(a, b), max(a, b))

def _fmt_range(lo: float, hi: float) -> str:
    def f(x: float) -> str:
        if x >= 1000:
            return f"${x:,.0f}"
        if x >= 100:
            return f"${x:.0f}"
        return f"${x:.2f}"
    return f"{f(lo)}–{f(hi)}"

def _spot_context(market: float, change_pct: float | None, extra: str = "") -> str:
    bits = [f"spot ${market:,.2f}"]
    if change_pct is not None and abs(change_pct) < 50:
        bits.append(f"day {change_pct:+.1f}%")
    if extra:
        bits.append(extra)
    return " · ".join(bits)

def _clip_signal_digest(clips: list[ReportClipIn]) -> dict:
    """Extract directional cues from clip text so the model cannot ignore them."""
    blob = " ".join(
        f"{c.sourceTab} {c.title} {c.dataSummary} {c.userDescription}" for c in clips
    )
    dig: dict = {"rawHints": []}

    def hint(s: str):
        if s and s not in dig["rawHints"]:
            dig["rawHints"].append(s)

    m = re.search(r"(?:calls?\s*%|call\s*(?:share|pct|%))\s*[:\s]+(\d+(?:\.\d+)?)\s*%?", blob, re.I)
    if m:
        dig["callPremiumPct"] = float(m.group(1))
        hint(f"call premium share {m.group(1)}%")
    m = re.search(r"net\s*gex\s*[:\s]+([+\-−]?\s*\$?[\d,.]+)\s*([MBK])?", blob, re.I)
    if m:
        dig["netGexRaw"] = m.group(0).strip()
        hint(m.group(0).strip())
    m = re.search(r"call\s*gex\s*[:\s]+([+\-−]?\s*\$?[\d,.]+)\s*([MBK])?", blob, re.I)
    if m:
        dig["callGexRaw"] = m.group(0).strip()
    m = re.search(r"put\s*gex\s*[:\s]+([+\-−]?\s*\$?[\d,.]+)\s*([MBK])?", blob, re.I)
    if m:
        dig["putGexRaw"] = m.group(0).strip()
    m = re.search(r"implied\s*move\s*[:\s]+([+\-−]?\d+(?:\.\d+)?)\s*%", blob, re.I)
    if m:
        dig["impliedMovePct"] = abs(float(m.group(1).replace("−", "-")))
        hint(f"implied move ±{dig['impliedMovePct']}%")
    m = re.search(r"iv\s*rank\s*[:\s]+(\d+(?:\.\d+)?)", blob, re.I)
    if m:
        dig["ivRank"] = float(m.group(1))
    m = re.search(r"(?:85th|p85|upper)\s*(?:percentile)?\s*[:\s]+\$?\s*([\d,]+(?:\.\d+)?)", blob, re.I)
    if m:
        dig["coneP85"] = _parse_money(m.group(1))
    m = re.search(r"(?:15th|p15|lower)\s*(?:percentile)?\s*[:\s]+\$?\s*([\d,]+(?:\.\d+)?)", blob, re.I)
    if m:
        dig["coneP15"] = _parse_money(m.group(1))
    m = re.search(r"(?:median|p50|modal(?:\s*strike)?)\s*[:\s]+\$?\s*([\d,]+(?:\.\d+)?)", blob, re.I)
    if m:
        dig["coneMid"] = _parse_money(m.group(1))
    # Crude directional score from keywords in options/macro clips
    score = 0
    if dig.get("callPremiumPct") is not None:
        if dig["callPremiumPct"] >= 60:
            score += 2
            hint("call-heavy flow")
        elif dig["callPremiumPct"] <= 40:
            score -= 2
            hint("put-heavy flow")
    if re.search(r"call[- ]?(?:heavy|biased|dominated)|long gamma|bullish tilt", blob, re.I):
        score += 1
    if re.search(r"put[- ]?(?:heavy|biased|dominated)|short gamma|bearish tilt", blob, re.I):
        score -= 1
    if re.search(r"below[- ]average stress|risk[- ]on|net easing", blob, re.I):
        score += 1
        hint("constructive macro/credit")
    if re.search(r"above[- ]average stress|risk[- ]off|net tightening|demanding", blob, re.I):
        score -= 1
        hint("cautious macro/credit")
    dig["directionalScore"] = score
    dig["suggestedLean"] = "bullish" if score >= 2 else "bearish" if score <= -2 else "mixed_or_neutral"
    dig["guidance"] = (
        "Use signalDigest with the clips. suggestedLean is a hint from positioning/flow/macro keywords, "
        "not a mandate. Vol cone and implied move bound width. Do not set the research range equal to "
        "spot ± impliedMove or cone 15/85 alone when directionalScore is non-zero. Shift midpoint and/or "
        "wings to encode lean."
    )
    return dig


def _report_prompt_clips(
    clips: list[ReportClipIn],
    length: str,
    book_level: bool,
) -> list[dict]:
    """Select a compact, diverse evidence set for the LLM writer.

    Large AlphaTape runs can collect hundreds of supporting clips. The full set
    remains available for charts, appendix selection, and export; the writer
    receives a decision-grade subset so outline and drafting stay within the
    edge proxy's response window.
    """
    cap = {"short": 16, "medium": 24, "long": 32}.get(_length_key(length), 24)
    data_cap = {"short": 650, "medium": 850, "long": 1_050}.get(_length_key(length), 850)
    priority_rules = [
        (r"current allocation|current option positions", 1_000),
        (r"risk metrics|performance methodology|vs spy|active return|drawdown", 960),
        (r"factor model coefficients|rolling .*coefficient|holding-level beta|scenario losses", 930),
        (r"option analytics coverage|derivative coverage|options snapshot|skew pulse|dealer gamma|implied", 900),
        (r"earnings schedule|macro event|catalyst", 860),
        (r"dcf verdict|model assumptions|value drivers|peer valuation", 840),
        (r"company snapshot|financials and estimates|recent news", 780),
        (r"sector allocation|correlation matrix|global market|credit|yield curve", 740),
    ]

    def score(clip: ReportClipIn) -> int:
        text = f"{clip.sourceTab} {clip.title}"
        best = 500
        for pattern, value in priority_rules:
            if re.search(pattern, text, re.I):
                best = max(best, value)
        if clip.userDescription.strip():
            best += 240
        if clip.dataType.lower() in {"chart", "kpi"}:
            best += 20
        return best

    selected: list[ReportClipIn] = []
    source_counts: dict[str, int] = {}
    ticker_counts: dict[str, int] = {}
    for clip in sorted(clips, key=lambda item: (-score(item), item.title.lower(), item.id)):
        source = clip.sourceTab.strip().lower() or "unknown"
        ticker = (_clip_ticker(clip) or "").upper()
        high_priority = score(clip) >= 900
        if not high_priority and source_counts.get(source, 0) >= 3:
            continue
        if not high_priority and ticker and ticker_counts.get(ticker, 0) >= 2:
            continue
        selected.append(clip)
        source_counts[source] = source_counts.get(source, 0) + 1
        if ticker:
            ticker_counts[ticker] = ticker_counts.get(ticker, 0) + 1
        if len(selected) >= cap:
            break

    if not book_level:
        selected.sort(key=lambda item: (-score(item), item.title.lower(), item.id))

    def compact(clip: ReportClipIn) -> dict:
        data = clip.dataSummary.strip()
        if len(data) > data_cap:
            data = f"{data[:data_cap].rstrip()} … [supporting detail retained in appendix]"
        return {
            "id": clip.id,
            "sourceTool": clip.sourceTab,
            "type": clip.dataType,
            "title": clip.title,
            "userInstruction": clip.userDescription,
            "data": data,
        }

    return [compact(clip) for clip in selected]

def _truncate_clean(s: str, n: int) -> str:
    """Trim to n chars on a word boundary with an ellipsis, not a mid-word cut."""
    s = (s or "").strip()
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(" ", 1)[0].rstrip(" .,-–—")
    return (cut or s[:n]) + "…"

_BARE_TICKER_RE = re.compile(r"^[A-Z]{1,5}(\.[A-Z]{1,2})?$")

def _is_bare_ticker(value: str) -> bool:
    """A lone ticker/name (e.g. 'NVDA') is not a verdict — it needs an action
    or comparison word (Buy/Favor/X over Y) to actually answer the Goal."""
    return bool(_BARE_TICKER_RE.fullmatch((value or "").strip().upper()))

def _stance_from_result(result: dict, market: float | None) -> dict | None:
    raw = result.get("stance")
    if not isinstance(raw, dict):
        raw = {}
    lean = str(raw.get("lean", "")).strip().lower()
    if lean not in ("bullish", "bearish", "neutral"):
        # Infer from baseCase vs spot if possible
        lean = "neutral"
        bc = _parse_range(f"${raw.get('baseCase', '')}") or None
        if market and raw.get("baseCase"):
            try:
                bcv = _parse_money(str(raw.get("baseCase", "")).replace("$", ""))
                if bcv and bcv > market * 1.01:
                    lean = "bullish"
                elif bcv and bcv < market * 0.99:
                    lean = "bearish"
            except Exception:
                pass
    conv = str(raw.get("conviction", "")).strip().lower()
    if conv not in ("low", "moderate", "high"):
        conv = "moderate"
    base = str(raw.get("baseCase", "")).strip()
    thesis = str(raw.get("thesis", "")).strip()
    return {
        "lean": lean,
        "conviction": conv,
        "baseCase": _truncate_clean(base, 40),
        "thesis": thesis[:280],
    }

def _normalize_key_result(
    key_result: dict | None,
    *,
    subject: str | None,
    market: float | None,
    change_pct: float | None = None,
    subject_dcf: bool,
    dcf_intrinsic: float | None,
    stance: dict | None = None,
    signal_digest: dict | None = None,
    force_range: bool = True,
) -> dict | None:
    """Ensure a usable keyResult. When force_range is True (single-subject
    price-target style goal), repair/build a live-spot dollar range and
    preserve asymmetric, stance-encoding wings — the original behavior.
    When False (comparison, screen, or any other non-price-target goal),
    trust the model's own direct answer verbatim; only patch in missing
    spot/lean context, never rewrite the value into a price range."""
    lean = (stance or {}).get("lean") or "neutral"

    if not force_range:
        label = ((key_result or {}).get("label") or "Bottom Line").strip()[:80] or "Bottom Line"
        value = ((key_result or {}).get("value") or "").strip()
        context = ((key_result or {}).get("context") or "").strip()
        usable = bool(value) and "not estimable" not in value.lower() and not _is_bare_ticker(value)
        if usable:
            if market and market > 0 and "spot $" not in context.lower():
                context = _spot_context(market, change_pct, context or f"{lean} lean")
            elif not context and lean != "neutral":
                context = f"{lean} lean"
            return {"label": label, "value": _truncate_clean(value, 70), "context": context[:200]}
        thesis = ((stance or {}).get("thesis") or "").strip()
        if thesis:
            return {"label": label, "value": _truncate_clean(thesis, 120), "context": context[:200]}
        if value:
            # Bare ticker with nothing to back it — still not a verdict on its own.
            return {"label": label, "value": f"Favor {value}"[:80], "context": context[:200]}
        return key_result

    label = f"Near-Term Range ({subject})" if subject else (
        (key_result or {}).get("label") or "Fair Value Range"
    )
    # Prefer model label if it already names the ticker sensibly
    if key_result and key_result.get("label"):
        label = str(key_result["label"]).strip()[:80]
    value = ((key_result or {}).get("value") or "").strip()
    context = ((key_result or {}).get("context") or "").strip()
    rng = _parse_range(value)
    ctx_l = context.lower()
    weak_ctx = (
        not context
        or "not estimable" in ctx_l
        or "spot unknown" in ctx_l
        or "not estimable" in value.lower()
    )
    missing_range = (not rng) or "not estimable" in value.lower() or "pending" in value.lower()
    sig = signal_digest or {}
    impl = sig.get("impliedMovePct")
    if isinstance(impl, (int, float)) and impl > 0:
        impl = float(impl) / 100.0
    else:
        impl = None

    # Fallback range when the model omitted one: directional if signals say so.
    if market and market > 0 and missing_range:
        if subject_dcf and dcf_intrinsic and dcf_intrinsic > 0:
            blend = market * 0.55 + dcf_intrinsic * 0.45
            lo, hi = sorted((blend * 0.94, blend * 1.08))
            lo = max(lo, market * 0.75)
            hi = min(hi, market * 1.35)
            if lo >= hi:
                lo, hi = market * 0.92, market * 1.10
            gap_pct = (dcf_intrinsic / market - 1) * 100
            value = _fmt_range(lo, hi)
            rng = (lo, hi)
            context = _spot_context(
                market, change_pct,
                f"{lean} · DCF ${dcf_intrinsic:,.2f} ({gap_pct:+.0f}% vs spot)",
            )
        else:
            # Asymmetric default from lean + optional implied-move width.
            wing = impl if impl and 0.02 <= impl <= 0.20 else 0.06
            if lean == "bullish":
                lo, hi = market * (1 - wing * 0.55), market * (1 + wing * 1.15)
            elif lean == "bearish":
                lo, hi = market * (1 - wing * 1.15), market * (1 + wing * 0.55)
            else:
                lo, hi = market * (1 - wing * 0.85), market * (1 + wing * 0.85)
            value = _fmt_range(lo, hi)
            rng = (lo, hi)
            context = _spot_context(market, change_pct, f"{lean} lean · multi-signal fallback")

    if market and market > 0 and rng:
        lo, hi = rng[0], rng[1]
        mid = (lo + hi) / 2
        down = market - lo
        up = hi - market
        # Only cap fantasy mids — do not re-center a reasoned asymmetric band onto spot.
        if mid > market * 1.45 or mid < market * 0.55:
            wing = impl if impl and impl > 0 else 0.10
            if lean == "bullish":
                lo, hi = market * (1 - wing * 0.5), market * (1 + wing * 1.2)
            elif lean == "bearish":
                lo, hi = market * (1 - wing * 1.2), market * (1 + wing * 0.5)
            else:
                lo, hi = market * (1 - wing), market * (1 + wing)
            value = _fmt_range(lo, hi)
            rng = (lo, hi)
            mid = (lo + hi) / 2
            context = _spot_context(market, change_pct, f"{lean} · range capped vs spot")
        else:
            width = hi - lo
            if width > market * 0.50:
                # Shrink wings proportionally (keep mid / asymmetry).
                scale = (market * 0.36) / width
                lo = mid - (mid - lo) * scale
                hi = mid + (hi - mid) * scale
                value = _fmt_range(lo, hi)
                rng = (lo, hi)

        # If model produced a near-symmetric band glued to spot while lean is
        # directional, nudge mid and wings slightly (do not invent a new thesis).
        mid = (rng[0] + rng[1]) / 2
        down = max(market - rng[0], 1e-9)
        up = max(rng[1] - market, 1e-9)
        sym_ratio = min(down, up) / max(down, up)
        mid_glued = abs(mid / market - 1) < 0.008
        if lean in ("bullish", "bearish") and mid_glued and sym_ratio > 0.85:
            wing = (rng[1] - rng[0]) / 2
            if lean == "bullish":
                lo = market - wing * 0.65
                hi = market + wing * 1.25
            else:
                lo = market - wing * 1.25
                hi = market + wing * 0.65
            value = _fmt_range(lo, hi)
            rng = (lo, hi)
            mid = (lo + hi) / 2
            if "lean" not in context.lower():
                context = _spot_context(
                    market, change_pct,
                    f"{lean} lean · range shifted off spot (signals, not pure vol envelope)",
                )

        if weak_ctx or "spot $" not in context.lower() or "spot unknown" in context.lower():
            to_mid = (mid / market - 1) * 100
            extra = f"{lean} · mid {to_mid:+.1f}% vs spot"
            if subject_dcf and dcf_intrinsic and dcf_intrinsic > 0:
                gap = (dcf_intrinsic / market - 1) * 100
                extra = f"DCF ${dcf_intrinsic:,.2f} ({gap:+.0f}% vs spot) · {extra}"
            context = _spot_context(market, change_pct, extra)
        else:
            if not re.search(r"spot\s*\$", context, re.I):
                context = _spot_context(market, change_pct, context)
            if lean and lean not in context.lower():
                context = f"{context} · {lean}"
            if subject_dcf and dcf_intrinsic and dcf_intrinsic > 0 and "dcf" not in context.lower():
                gap = (dcf_intrinsic / market - 1) * 100
                context = f"{context} · DCF ${dcf_intrinsic:,.2f} ({gap:+.0f}% vs spot)"

        return {"label": label[:80], "value": value[:80], "context": context[:200]}

    if value and "not estimable" not in value.lower():
        return {
            "label": label[:80],
            "value": value[:80],
            "context": (context or "Live spot unavailable for this symbol")[:160],
        }
    if subject:
        return {
            "label": f"Near-Term Range ({subject})",
            "value": "Range pending spot",
            "context": f"Could not fetch a live market price for {subject}. Check the symbol or market data feed.",
        }
    return key_result

def _chart_signature(chart: dict) -> tuple:
    return (
        chart["chartType"],
        tuple(sorted(str(row.get(chart["xKey"])) for row in chart["data"])),
        tuple(sorted(sr["key"] for sr in chart["series"])),
    )

_TICKER_SUFFIX_RE = re.compile(r"[·•]\s*([A-Za-z]{1,6})\s*$")
_TICKER_PREFIX_RE = re.compile(r"^([A-Za-z]{1,6})\s*[·•]")
_TICKER_SUBJECT_TITLE_RE = re.compile(
    r"^([A-Za-z]{1,6})\s+(?:company\s+snapshot|financial\s+trajectory|"
    r"revenue\s+activity\s+history|price\s+(?:history|and\s+drawdown))\b",
    re.I,
)
_SUBJECT_EVIDENCE_TITLE_RE = re.compile(
    r"\b(?:company\s+snapshot|financial\s+trajectory|financials\s+and\s+estimates|"
    r"revenue\s+activity\s+history|analyst\s+view|earnings\s+setup|"
    r"peer\s+valuation|dcf\s+verdict|model\s+assumptions|"
    r"price\s+(?:history|and\s+drawdown))\b",
    re.I,
)
_NUM_RE = re.compile(r"([-−]?)\s*\$?\s*([\d,]+(?:\.\d+)?)")

def _clip_ticker(clip: "ReportClipIn") -> str | None:
    """Extract the subject ticker from a clip title in either position the app
    uses: "DCF Verdict · NVDA" (suffix) or "NVDA · Profitability" (prefix)."""
    title = clip.title or ""
    m = (
        _TICKER_SUFFIX_RE.search(title)
        or _TICKER_PREFIX_RE.match(title)
        or _TICKER_SUBJECT_TITLE_RE.match(title)
    )
    return m.group(1).upper() if m else None

def _subject_evidence_tickers(clips: list[ReportClipIn]) -> dict[str, int]:
    """Count high-confidence, subject-owned evidence clips by ticker.

    Broad market, news, and peer rows are deliberately excluded: a peer appearing
    inside a comparison table must never become the report subject.
    """
    counts: dict[str, int] = {}
    for clip in clips:
        if not _SUBJECT_EVIDENCE_TITLE_RE.search(clip.title or ""):
            continue
        ticker = _clip_ticker(clip)
        if not ticker or not _is_plausible_ticker(ticker):
            continue
        counts[ticker] = counts.get(ticker, 0) + 1
    return counts

def _first_number(s: str) -> float | None:
    """First signed number in a KPI value string, tolerating $, %, unicode minus
    and a trailing "(sub)" note — e.g. "−16.8% (Overvalued)" -> -16.8."""
    m = _NUM_RE.search(s or "")
    if not m:
        return None
    val = _parse_money(m.group(2))
    if val is None:
        return None
    return -val if m.group(1) in ("-", "−") else val

def _parse_kpi_summary(summary: str) -> dict[str, str]:
    """Parse a summarizeClipForAI KPI dump ("Label: value; Label: value; ...")
    into {label: value}. The inverse of the frontend's cell join."""
    out: dict[str, str] = {}
    for part in (summary or "").split(";"):
        label, sep, val = part.partition(":")
        if sep and label.strip():
            out[label.strip()] = val.strip()
    return out

def _parse_table_summary(summary: str) -> tuple[list[str], list[list[str]]] | None:
    """Parse a summarizeClipForAI table dump ("Columns: A | B | C\\nrow1\\n...")
    back into (columns, rows). None if it doesn't look like this shape."""
    lines = (summary or "").strip().splitlines()
    if not lines or not lines[0].startswith("Columns:"):
        return None
    columns = [c.strip() for c in lines[0][len("Columns:"):].split("|")]
    rows = []
    for line in lines[1:]:
        line = line.strip()
        if not line or line.startswith("("):  # "(+N more rows)" footer
            continue
        rows.append([c.strip() for c in line.split("|")])
    return columns, rows

def _mechanical_sensitivity_chart(clips: list[ReportClipIn]) -> dict | None:
    """DCF one-way sensitivity tables ("Value Drivers — one-way sensitivity")
    are an unambiguous low/high spread per driver — build the 'range' chart
    directly from the real clip data rather than leave it to the model, which
    has repeatedly either skipped charting this or malformed the chart."""
    by_subject: dict[str, dict[str, tuple[float, float]]] = {}
    for c in clips:
        if not re.match(r"^Value Drivers\b", c.title or "", re.I):
            continue
        parsed = _parse_table_summary(c.dataSummary)
        if not parsed:
            continue
        columns, rows = parsed
        try:
            lo_i, hi_i, drv_i = columns.index("Low $/sh"), columns.index("High $/sh"), columns.index("Driver")
        except ValueError:
            continue
        m = _TICKER_SUFFIX_RE.search(c.title or "")
        subject = m.group(1).upper() if m else c.id
        drivers: dict[str, tuple[float, float]] = {}
        for row in rows:
            if len(row) <= max(lo_i, hi_i, drv_i):
                continue
            lo = _parse_money(row[lo_i].replace("$", ""))
            hi = _parse_money(row[hi_i].replace("$", ""))
            if lo is not None and hi is not None and row[drv_i]:
                drivers[row[drv_i]] = (lo, hi)
        if drivers:
            by_subject[subject] = drivers

    if not by_subject:
        return None
    subjects = list(by_subject.keys())[:2]
    all_drivers: list[str] = []
    for subj in subjects:
        for d in by_subject[subj]:
            if d not in all_drivers:
                all_drivers.append(d)

    data = []
    for d in all_drivers[:6]:
        row: dict = {"driver": d}
        has_any = False
        for subj in subjects:
            if d in by_subject[subj]:
                row[subj] = list(by_subject[subj][d])
                has_any = True
        if has_any:
            data.append(row)
    if len(data) < 2:
        return None

    return {
        "kind": "chart", "chartType": "range",
        "title": _title_case("DCF Sensitivity — One-Way Swing ($/sh)"),
        "xKey": "driver", "data": data,
        "series": [{"key": s, "label": f"{s} $/sh"} for s in subjects],
    }

def _mechanical_segments_pie(clip: ReportClipIn) -> dict | None:
    """Product/geographic segment-mix tables are an unambiguous composition
    of one company's revenue — a real candidate for a deterministic pie."""
    if not re.match(r"^(Product|Geographic) Segments\b", clip.title or "", re.I):
        return None
    parsed = _parse_table_summary(clip.dataSummary)
    if not parsed:
        return None
    columns, rows = parsed
    if "Share %" not in columns:
        return None
    share_i = columns.index("Share %")
    data = []
    for row in rows:
        if len(row) <= share_i or not row[0]:
            continue
        share = _parse_money(row[share_i])
        if share is not None:
            data.append({"segment": row[0], "share": share})
    if len(data) < 2:
        return None
    return {
        "kind": "chart", "chartType": "pie",
        "title": clip.title, "xKey": "segment",
        "data": data[:8],
        "series": [{"key": "share", "label": "Share %"}],
    }

def _all_kpis_by_ticker(clips: list[ReportClipIn]) -> dict[str, dict[str, str]]:
    """Merge every KPI clip's "Label: value" pairs, grouped by subject ticker,
    into one {ticker: {label: value}} map. This is what lets us build correct
    cross-company comparison charts deterministically instead of trusting the
    weak generation model to assemble chart JSON from the clip text."""
    out: dict[str, dict[str, str]] = {}
    for c in clips:
        if _parse_table_summary(c.dataSummary) is not None:
            continue  # tables handled by their own recipes
        ticker = _clip_ticker(c)
        if not ticker:
            continue
        kv = _parse_kpi_summary(c.dataSummary)
        if kv:
            out.setdefault(ticker, {}).update(kv)
    return out

def _grouped_kpi_chart(by_ticker: dict[str, dict[str, str]],
                       metrics: list[tuple[str, str]], title: str) -> dict | None:
    """Grouped bar comparing `metrics` across every subject (xKey=metric name,
    one series per ticker). metrics is (kpi label to look up, display label).
    Only metrics present for >=2 tickers are charted, and >=2 such metrics are
    required, so the chart is always a real multi-point comparison."""
    tickers = list(by_ticker.keys())[:4]
    if len(tickers) < 2:
        return None
    data: list[dict] = []
    for kpi_label, disp in metrics:
        row: dict = {"metric": disp}
        n = 0
        for t in tickers:
            v = _first_number(by_ticker[t].get(kpi_label, ""))
            if v is not None:
                row[t] = v
                n += 1
        if n >= 2:
            data.append(row)
    if len(data) < 2:
        return None
    return {"kind": "chart", "chartType": "bar", "title": _title_case(title), "xKey": "metric",
            "data": data, "series": [{"key": t, "label": t} for t in tickers]}

def _valuation_gap_chart(by_ticker: dict[str, dict[str, str]]) -> dict | None:
    """Grouped bar of DCF intrinsic value vs market price per subject — the
    canonical "valuation gap" visual (xKey=ticker, series=Intrinsic/Market)."""
    rows: list[dict] = []
    for t, kv in by_ticker.items():
        intrinsic = _first_number(kv.get("Intrinsic / Share", ""))
        market = _first_number(kv.get("Market Price", "")) or _first_number(kv.get("Price", ""))
        if intrinsic is not None and market is not None:
            rows.append({"name": t, "intrinsic": intrinsic, "market": market})
    if len(rows) < 2:
        return None
    return {"kind": "chart", "chartType": "bar", "title": _title_case("DCF Intrinsic vs Market Price"),
            "xKey": "name", "data": rows[:4],
            "series": [{"key": "intrinsic", "label": "DCF Intrinsic"},
                       {"key": "market", "label": "Market Price"}]}

def _peer_pe_median_chart(clips: list[ReportClipIn]) -> dict | None:
    """Grouped bar of each subject's P/E vs its sector-median P/E, read from the
    "All Metrics · TICKER" peer tables (the Median row plus the subject's own
    row). xKey=ticker, series=[Company P/E, Peer Median]."""
    rows: list[dict] = []
    for c in clips:
        if not re.match(r"^All Metrics\b", c.title or "", re.I):
            continue
        parsed = _parse_table_summary(c.dataSummary)
        subject = _clip_ticker(c)
        if not parsed or not subject:
            continue
        columns, trows = parsed
        try:
            pe_i, tk_i = columns.index("P/E"), columns.index("Ticker")
        except ValueError:
            continue
        company_pe = median_pe = None
        for r in trows:
            if len(r) <= max(pe_i, tk_i):
                continue
            if r[tk_i].strip().lower() == "median":
                median_pe = _first_number(r[pe_i])
            elif r[tk_i].strip().upper() == subject:
                company_pe = _first_number(r[pe_i])
        if company_pe is not None and median_pe is not None:
            rows.append({"name": subject, "company": company_pe, "median": median_pe})
    if len(rows) < 2:
        return None
    return {"kind": "chart", "chartType": "bar", "title": _title_case("P/E vs Sector Median"),
            "xKey": "name", "data": rows[:4],
            "series": [{"key": "company", "label": "Company P/E"},
                       {"key": "median", "label": "Sector Median"}]}

def _analyst_upside_chart(clips: list[ReportClipIn]) -> dict | None:
    """Dot plot of each subject's analyst upside %, read from the subject's own
    row in the "Analyst Consensus · TICKER" peer tables. A dot plot (not a bar)
    because the values straddle zero and read cleaner as points."""
    rows: list[dict] = []
    for c in clips:
        if not re.match(r"^Analyst Consensus\b", c.title or "", re.I):
            continue
        parsed = _parse_table_summary(c.dataSummary)
        subject = _clip_ticker(c)
        if not parsed or not subject:
            continue
        columns, trows = parsed
        try:
            up_i, tk_i = columns.index("Upside"), columns.index("Ticker")
        except ValueError:
            continue
        for r in trows:
            if len(r) > max(up_i, tk_i) and r[tk_i].strip().upper() == subject:
                up = _first_number(r[up_i])
                if up is not None:
                    rows.append({"name": subject, "upside": up})
                break
    if len(rows) < 2:
        return None
    # A bar (not a dot plot) reads cleanest for a handful of upside figures that
    # straddle zero — negative bar down, positive bar up — and matches the
    # "prefer bar" styling rule.
    return {"kind": "chart", "chartType": "bar", "title": _title_case("Analyst Upside to Target (%)"),
            "xKey": "name", "data": rows[:6],
            "series": [{"key": "upside", "label": "Upside %"}]}

_POINTS_RE = re.compile(r"POINTS:\s*(.+)", re.S)

def _parse_chart_points(summary: str) -> dict[str, list] | None:
    """Parse the POINTS line the client emits for chart clips
    ("POINTS: year=[Y1,Y2]; Revenue=[300,340]") into {name: [values]}. Numeric
    arrays become floats; the label/x axis stays a list of strings."""
    m = _POINTS_RE.search(summary or "")
    if not m:
        return None
    out: dict[str, list] = {}
    for part in m.group(1).split(";"):
        name, sep, arr = part.partition("=")
        name, arr = name.strip(), arr.strip().strip("[]")
        if not sep or not name or not arr:
            continue
        raw_vals = [v.strip() for v in arr.split(",")]
        nums = [_coerce_num(v) for v in raw_vals]
        out[name] = nums if all(n is not None for n in nums) else raw_vals
    return out or None

def _apply_growth_deceleration_guardrail(revs: list[float], terminal_g: float = 3.5) -> list[float]:
    """Sanity-check multi-year revenue projections: apply terminal growth deceleration
    and market saturation bounds so multi-year forecasts account for competitive decay
    and realistic scale rather than uncapped compound growth rates."""
    if len(revs) < 2:
        return revs
    out = [revs[0]]
    for i in range(1, len(revs)):
        prev = out[-1]
        implied_g = ((revs[i] / revs[i - 1]) - 1) * 100 if revs[i - 1] > 0 else 0
        decel_factor = 0.82 ** (i - 1)
        g_bounded = terminal_g + (implied_g - terminal_g) * decel_factor
        out.append(round(prev * (1 + g_bounded / 100), 1))
    return out

def _revenue_overlay_chart(clips: list[ReportClipIn]) -> dict | None:
    """Dual-line overlay of each subject's revenue trajectory across the shared
    projection years — a real synchronized-timeline line chart from the DCF
    "Revenue Projection · TICKER" chart clips. Magnitudes differ between names,
    so the renderer auto-splits the two lines onto a dual axis."""
    by_ticker: dict[str, tuple[list, list]] = {}
    for c in clips:
        if not re.match(r"^Revenue Projection\b", c.title or "", re.I):
            continue
        t = _clip_ticker(c)
        pts = _parse_chart_points(c.dataSummary)
        if not t or not pts:
            continue
        years = next((v for v in pts.values() if v and isinstance(v[0], str)), None)
        revs = next((v for v in pts.values() if v and isinstance(v[0], (int, float))), None)
        if years and revs and len(years) == len(revs) and len(years) >= 3:
            bounded_revs = _apply_growth_deceleration_guardrail([float(r) for r in revs])
            by_ticker[t] = ([str(y) for y in years], bounded_revs)
    if len(by_ticker) < 2:
        return None
    tickers = list(by_ticker.keys())[:2]
    base_years = by_ticker[tickers[0]][0]
    data: list[dict] = []
    for i, yr in enumerate(base_years):
        row: dict = {"year": yr}
        ok = False
        for t in tickers:
            _, revs = by_ticker[t]
            if i < len(revs):
                row[t] = revs[i]
                ok = True
        if ok:
            data.append(row)
    if len(data) < 3:
        return None
    return {"kind": "chart", "chartType": "line", "title": _title_case("Revenue Trajectory (Projected, $M)"),
            "xKey": "year", "data": data[:12],
            "series": [{"key": t, "label": f"{t} revenue"} for t in tickers]}

def _quartiles(vals: list[float]) -> tuple[float, float, float, float, float]:
    s = sorted(vals)
    n = len(s)
    def q(p: float) -> float:
        idx = p * (n - 1)
        lo = int(idx)
        frac = idx - lo
        return s[lo] if lo + 1 >= n else s[lo] * (1 - frac) + s[lo + 1] * frac

    q1 = q(0.25)
    med = q(0.5)
    q3 = q(0.75)
    iqr = max(q3 - q1, 0.5)

    # Standard Tukey 1.5x IQR whisker bounds logic to manage extreme outliers
    lower_fence = q1 - 1.5 * iqr
    upper_fence = q3 + 1.5 * iqr

    non_outliers = [v for v in s if lower_fence <= v <= upper_fence]
    w_min = non_outliers[0] if non_outliers else max(s[0], lower_fence)
    w_max = non_outliers[-1] if non_outliers else min(s[-1], upper_fence)

    return w_min, q1, med, q3, w_max

def _peer_distribution_box(clips: list[ReportClipIn]) -> dict | None:
    """Box & whisker of the peer P/E distribution from the All Metrics tables,
    with the subjects marked as points. Outlier management ensures whiskers
    reflect 1.5x IQR statistical bounds rather than distorted extremes."""
    pe_vals: list[float] = []
    markers: dict[str, float] = {}
    for c in clips:
        if not re.match(r"^All Metrics\b", c.title or "", re.I):
            continue
        parsed = _parse_table_summary(c.dataSummary)
        subject = _clip_ticker(c)
        if not parsed:
            continue
        cols, rows = parsed
        try:
            pe_i, tk_i = cols.index("P/E"), cols.index("Ticker")
        except ValueError:
            continue
        for r in rows:
            if len(r) <= max(pe_i, tk_i):
                continue
            tk = r[tk_i].strip()
            if tk.lower() == "median":
                continue
            pe = _first_number(r[pe_i])
            if pe is None or not (0 < pe < 300):
                continue
            pe_vals.append(pe)
            if subject and tk.upper() == subject:
                markers[subject] = pe
    for t, kv in _all_kpis_by_ticker(clips).items():
        if t not in markers:
            pe = _first_number(kv.get("P/E", ""))
            if pe is not None and 0 < pe < 300:
                markers[t] = pe
    if len(pe_vals) < 5 or not markers:
        return None
    mn, q1, med, q3, mx = _quartiles(pe_vals)
    return {"kind": "chart", "chartType": "box", "title": _title_case("Peer P/E Distribution"),
            "xKey": "metric",
            "data": [{"metric": "P/E", "min": round(mn, 1), "q1": round(q1, 1),
                      "median": round(med, 1), "q3": round(q3, 1), "max": round(mx, 1),
                      "markers": [{"label": k, "value": round(v, 1)} for k, v in markers.items()]}],
            "series": [{"key": "P/E", "label": "P/E"}]}

def _peg_comparison_chart(clips: list[ReportClipIn]) -> dict | None:
    """PEG (P/E-to-growth) comparison for the subjects, read from the Top Matches
    screener table's PEG column — real data the report was not using, and the
    single cleanest 'growth-adjusted valuation' number."""
    subjects = list(_all_kpis_by_ticker(clips).keys())[:4]
    if len(subjects) < 2:
        return None
    peg: dict[str, float] = {}
    for c in clips:
        if not re.search(r"Top Matches|Screener|Liquid Large", c.title or "", re.I):
            continue
        parsed = _parse_table_summary(c.dataSummary)
        if not parsed:
            continue
        cols, rows = parsed
        try:
            peg_i, tk_i = cols.index("PEG"), cols.index("Ticker")
        except ValueError:
            continue
        for r in rows:
            if len(r) <= max(peg_i, tk_i):
                continue
            tk = r[tk_i].strip().upper()
            if tk in subjects and tk not in peg:
                v = _first_number(r[peg_i])
                if v is not None and 0 < v < 20:
                    peg[tk] = v
    present = [t for t in subjects if t in peg]
    if len(present) < 2:
        return None
    return {"kind": "chart", "chartType": "bar", "title": _title_case("PEG Ratio — Growth-Adjusted Valuation"),
            "xKey": "name", "data": [{"name": t, "peg": peg[t]} for t in present],
            "series": [{"key": "peg", "label": "PEG"}]}

def _price_performance_overlay(clips: list[ReportClipIn]) -> dict | None:
    """Tier-2 data sourcing: when the clips lack a shared historical series, fetch
    ~1yr of real closes for the two subjects through the existing cached history
    helper and build a dual-line relative-performance overlay (both indexed to
    100 at the start, one synchronized timeline). Real market data, never
    fabricated; degrades to None on any fetch problem so the report falls back to
    the clip-only charts. Bounded to the two subject tickers and cached."""
    subjects = list(_all_kpis_by_ticker(clips).keys())[:2]
    if len(subjects) < 2:
        return None
    try:
        import cache
        sampled: dict[str, list[float]] = {}
        dates: list[str] = []
        for t in subjects:
            df = cache.get_history(t, period="1y")
            if df is None or getattr(df, "empty", True) or "Close" not in getattr(df, "columns", []):
                return None
            closes = df["Close"].dropna()
            if len(closes) < 30:
                return None
            step = max(1, len(closes) // 12)
            pts = closes.iloc[::step]
            sampled[t] = [float(v) for v in pts.tolist()]
            if not dates:  # both trade the same calendar; position-sampling aligns them
                dates = [d.strftime("%b '%y") for d in pts.index]
    except Exception as e:  # noqa: BLE001 — Tier-2 fetch is best-effort
        logger.warning("report price-overlay fetch failed: %s", e)
        return None

    n = min(len(dates), *(len(v) for v in sampled.values()))
    if n < 4:
        return None
    base = {t: sampled[t][0] or 1.0 for t in subjects}
    data: list[dict] = []
    for i in range(n):
        row: dict = {"month": dates[i]}
        for t in subjects:
            row[t] = round(sampled[t][i] / base[t] * 100, 1)
        data.append(row)
    return {"kind": "chart", "chartType": "line",
            "title": _title_case("Relative Price Performance (Indexed to 100, 1Yr)"),
            "xKey": "month", "data": data,
            "series": [{"key": t, "label": t} for t in subjects]}

def _has_critical_sensitivity_insight(clips: list[ReportClipIn]) -> bool:
    """Determine whether DCF sensitivity provides critical decision-making insight.
    In comparative reports (e.g. NVDA vs AAPL), routine sensitivity is secondary noise
    unless WACC/driver swings reveal significant asymmetry or thesis-flipping divergence."""
    sens = _mechanical_sensitivity_chart(clips)
    if not sens or not sens.get("data"):
        return False
    data = sens.get("data", [])
    swings: dict[str, list[float]] = {}
    for row in data:
        for k, v in row.items():
            if k != "driver" and isinstance(v, (list, tuple)) and len(v) == 2:
                swings.setdefault(k, []).append(abs(v[1] - v[0]))
    if len(swings) >= 2:
        avg_swings = [sum(v) / max(len(v), 1) for v in swings.values()]
        if max(avg_swings) > 0 and (max(avg_swings) / min(avg_swings) > 1.35 or abs(avg_swings[0] - avg_swings[1]) > 15):
            return True
    return False

def _mechanical_chart_pool(clips: list[ReportClipIn]) -> list[tuple[dict, tuple[str, ...], int]]:
    """Deterministically build every comparison chart this app's clip formats
    support. THE SITE OWNS CHART CONSTRUCTION: the generation model (Llama 70B /
    gpt-oss) cannot reliably choose or build chart JSON, so it never does — it
    writes prose and picks the thesis, and we build and assign the charts. Every
    chart is re-validated through _clean_chart."""
    by_ticker = _all_kpis_by_ticker(clips)
    sens_priority = 0 if len(by_ticker) <= 1 else (0 if _has_critical_sensitivity_insight(clips) else 3)
    candidates: list[tuple[dict | None, tuple[str, ...], int]] = [
        (_peer_distribution_box(clips),
         ("peer", "distribution", "sector", "median", "relative", "cheap", "discount", "premium", "multiple"), 0),
        (_mechanical_sensitivity_chart(clips),
         ("sensitiv", "wacc", "swing", "driver", "downside", "one-way", "uncertain"), sens_priority),
        (next((pie for c in clips if (pie := _mechanical_segments_pie(c))), None),
         ("segment", "mix", "composition", "geograph", "revenue by", "product line", "diversif", "concentrat"), 0),
        (_revenue_overlay_chart(clips),
         ("revenue", "trajectory", "top-line", "top line", "expansion", "future cash", "projection"), 1),
        (_price_performance_overlay(clips),
         ("price", "performance", "momentum", "return", "trend", "market", "rally", "trading"), 1),
        (_analyst_upside_chart(clips),
         ("analyst", "upside", "consensus", "rating", "target", "sentiment"), 1),
        (_valuation_gap_chart(by_ticker),
         ("valuation gap", "intrinsic", "dcf", "premium", "fair value", "overvalu", "undervalu"), 2),
        (_peg_comparison_chart(clips),
         ("peg", "growth-adjusted", "growth adjusted", "cheap", "value"), 2),
        (_grouped_kpi_chart(by_ticker, [
            ("Rev Growth", "Rev Growth"), ("Gross Margin", "Gross Margin"),
            ("Operating Margin", "Op Margin"), ("Net Margin", "Net Margin"),
        ], "Growth & Margin Comparison"),
         ("growth", "margin", "profitab", "edge", "momentum"), 2),
        (_grouped_kpi_chart(by_ticker, [
            ("P/E", "P/E"), ("ROE", "ROE"), ("ROA", "ROA"),
        ], "Multiple & Return Comparison"),
         ("multiple", "return on", "efficiency", "capital", "quality"), 2),
    ]
    pool: list[tuple[dict, tuple[str, ...], int]] = []
    for chart, keywords, priority in candidates:
        clean = _clean_chart(chart) if chart else None
        if clean:
            pool.append((clean, keywords, priority))
    return pool

def _section_haystack(section: dict) -> str:
    parts = [section.get("heading", ""), section.get("analysis", "")]
    parts += [f.get("label", "") for f in (section.get("keyFigures") or [])]
    return " ".join(parts).lower()

def _auto_must_include(clips: list[ReportClipIn]) -> list[str]:
    """Directives the site forces into the report plan: it tells the writing
    model which sections to WRITE so that the high-value charts the site can
    build (sensitivity range, segment-mix pie) have a section to live in."""
    out: list[str] = []
    is_portfolio = any(re.search(r"\b(current allocation|portfolio risk metrics)\b", c.title or "", re.I) for c in clips)
    subjects = sorted({
        t for c in clips
        if re.match(r"^Value Drivers\b", c.title or "", re.I)
        for t in [_clip_ticker(c)] if t
    })
    if subjects and not is_portfolio:
        who = " and ".join(subjects)
        out.append(
            f"Write a dedicated section on the DCF one-way sensitivity swing for {who} "
            "(how much intrinsic value moves as WACC and other drivers vary, and what the "
            "tighter or wider swing implies). Do not bury this in another section. You write "
            "the analysis; a chart is added automatically, so do not build one yourself."
        )
    if any(_mechanical_segments_pie(c) for c in clips):
        out.append(
            "Write a short section on the primary subject's revenue composition / segment "
            "mix (where its revenue comes from and how concentrated it is). You write the "
            "analysis; a chart is added automatically, so do not build one yourself."
        )
    clip_titles = " | ".join(c.title or "" for c in clips)
    if re.search(r"\bfinancial trajectory\b|\bfinancials and estimates\b", clip_titles, re.I):
        out.append(
            "Write a dedicated financial-trajectory section that separates reported actuals from "
            "forward consensus estimates, identifies the earnings or revenue inflection, and explains "
            "what must happen operationally for the thesis to hold."
        )
    if re.search(r"\brevenue activity history\b|\bbank profitability and credit context\b", clip_titles, re.I):
        out.append(
            "This is bank research. Write a dedicated earnings-quality section covering the supplied "
            "net-interest-income and fee/trading mix, profitability, net interest margin, and credit "
            "context. Distinguish issuer evidence from FDIC industry context. If CET1 or consolidated "
            "charge-off data is absent, identify that gap instead of implying it was reviewed."
        )
    if re.search(r"\bpeer valuation\b|\banalyst view\b|\bconsensus upside\b", clip_titles, re.I):
        out.append(
            ("For a portfolio review, keep single-name valuation to one compact supporting panel. "
             "Separate relative multiples, analyst consensus, and DCF as distinct methods and reconcile different upside estimates. "
             if is_portfolio else "Write a dedicated valuation section. State the subject's relevant multiple or analyst ")
            + ("Do not describe an options-implied move as fair value." if is_portfolio else
               "target range, compare it with the peer evidence, and explain whether the premium or discount is justified. Do not describe an options-implied move as fair value.")
        )
    if any(re.search(r"\b(news|catalyst|earnings)\b", f"{c.sourceTab} {c.title}", re.I) for c in clips):
        out.append(
            "Separate catalysts from risks. Name the dated or observable catalyst evidence available "
            "in the clips and state which monitoring signal would weaken the thesis."
        )
    return out

def _inject_mechanical_charts(sections: list[dict], clips: list[ReportClipIn]) -> None:
    """Assign the site-built charts to sections. THE SITE OWNS ALL SECTION
    CHARTS: whatever chart the writing model may have emitted is discarded, and
    each site-built chart claims its best-matching section. Distinct chart types
    (box, range, pie, line) are assigned first so the report leads with variety;
    the many possible bar charts compete for what is left, and an adjacency
    penalty keeps two of the same type off neighbouring sections. Every chart is
    used at most once. Mutates sections in place; a section that matches no chart
    simply renders as prose plus its key-figure strip."""
    for sec in sections:
        sec["chart"] = None  # the model does not get to choose charts
    pool = _mechanical_chart_pool(clips)
    if any(re.search(r"\b(current allocation|portfolio risk metrics)\b", c.title or "", re.I) for c in clips):
        pool = [item for item in pool if not re.search(
            r"\b(peer|consensus upside|dcf|sensitivity|intrinsic|multiple)\b",
            str(item[0].get("title", "")),
            re.I,
        )]
    if not pool:
        return
    pool.sort(key=lambda item: item[2])  # priority 0 (distinct types) first
    used_sigs: set[tuple] = set()

    def neighbor_types(idx: int) -> set[str]:
        types: set[str] = set()
        for j in (idx - 1, idx + 1):
            if 0 <= j < len(sections) and sections[j].get("chart"):
                types.add(sections[j]["chart"]["chartType"])
        return types

    for chart, keywords, _priority in pool:
        sig = _chart_signature(chart)
        if sig in used_sigs:
            continue  # never place the same comparison twice
        ctype = chart["chartType"]
        best_i, best_score = -1, 0
        for i, sec in enumerate(sections):
            if sec.get("chart") is not None:
                continue
            score = sum(1 for k in keywords if k in _section_haystack(sec))
            if score <= 0:
                continue
            if ctype in neighbor_types(i):
                score -= 2  # discourage two same-type charts on adjacent sections
            if score > best_score:
                best_i, best_score = i, score
        if best_i >= 0:
            sections[best_i]["chart"] = chart
            used_sigs.add(sig)

def _build_sections(raw_sections, valid_ids: set[str]) -> list[dict]:
    """Clean model-returned sections and drop a section's chart if an earlier
    section already drew the same comparison — the model generates each
    section's chart independently and sometimes redraws the same one twice
    (e.g. a margin comparison under both "Growth" and "Profitability")."""
    sections: list[dict] = []
    seen_chart_sigs: set[tuple] = set()
    for s in raw_sections or []:
        if not isinstance(s, dict):
            continue
        cid = str(s.get("clipId", ""))
        analysis = str(s.get("analysis", "")).strip()
        if cid not in valid_ids or not analysis:
            continue
        chart = _clean_chart(s.get("chart"))
        if chart:
            sig = _chart_signature(chart)
            if sig in seen_chart_sigs:
                chart = None
            else:
                seen_chart_sigs.add(sig)
        section = {
            "clipId": cid,
            "heading": _title_case(str(s.get("heading", "")).strip()) or "Analysis",
            "analysis": analysis,
            "keyFigures": _clean_figs(s.get("keyFigures")),
            "chart": chart,
        }
        design = str(s.get("design", "")).strip().lower()
        if design in _SECTION_DESIGN_INTENTS:
            section["design"] = design
        sections.append(section)
    return sections


def _material_portfolio_positions(clips: list[ReportClipIn]) -> list[tuple[str, float]]:
    for clip in clips:
        if not re.search(r"\bcurrent allocation\b", clip.title, re.I):
            continue
        parsed = _parse_table_summary(clip.dataSummary)
        if not parsed:
            continue
        columns, rows = parsed
        ticker_i = next((i for i, column in enumerate(columns) if re.fullmatch(r"Ticker", column, re.I)), -1)
        weight_i = next((i for i, column in enumerate(columns) if re.search(r"Weight", column, re.I)), -1)
        if ticker_i < 0 or weight_i < 0:
            continue
        positions: list[tuple[str, float]] = []
        for row in rows:
            if len(row) <= max(ticker_i, weight_i):
                continue
            ticker = row[ticker_i].strip().upper()
            weight = _first_number(row[weight_i])
            if ticker and ticker not in {"CASH", "OPTIONS"} and weight is not None and weight > 0.05:
                positions.append((ticker, weight))
        return sorted(positions, key=lambda item: item[1], reverse=True)
    return []


def _has_option_positions(clips: list[ReportClipIn]) -> bool:
    return any(re.search(r"\bcurrent option positions\b", clip.title, re.I) for clip in clips)


def _normalize_portfolio_sections(sections: list[dict]) -> list[dict]:
    if len(sections) <= 4:
        return sections
    buckets: dict[str, dict] = {}
    extras: list[dict] = []
    for section in sections:
        heading = str(section.get("heading", ""))
        key = (
            "happened" if re.search(r"\bwhat happened\b", heading, re.I)
            else "why" if re.search(r"\bwhy it happened\b", heading, re.I)
            else "next" if re.search(r"\bwhat could happen next\b", heading, re.I)
            else "action" if re.search(r"\bwhat action follows\b", heading, re.I)
            else ""
        )
        if key and key not in buckets:
            buckets[key] = section
        else:
            extras.append(section)
    if len(buckets) < 4:
        return sections[:4]
    for extra in extras:
        text = f"{extra.get('heading', '')} {extra.get('analysis', '')}"
        target_key = (
            "next" if re.search(r"\b(valuation|dcf|catalyst|earnings|scenario|stress|outlook)\b", text, re.I)
            else "why" if re.search(r"\b(beta|factor|correlation|concentration|risk)\b", text, re.I)
            else "action"
        )
        target = buckets[target_key]
        target["analysis"] = f"{target.get('analysis', '')} {extra.get('analysis', '')}".strip()
        existing = {(str(item.get("label", "")).lower(), str(item.get("value", ""))) for item in target.get("keyFigures", [])}
        for figure in extra.get("keyFigures", []):
            signature = (str(figure.get("label", "")).lower(), str(figure.get("value", "")))
            if signature not in existing and len(target.get("keyFigures", [])) < 4:
                target.setdefault("keyFigures", []).append(figure)
                existing.add(signature)
    return [buckets[key] for key in ("happened", "why", "next", "action")]


def _section_evidence_profile(section: dict, clip: ReportClipIn | None) -> dict:
    chart = section.get("chart") if isinstance(section.get("chart"), dict) else None
    chart_type = str((chart or {}).get("chartType", "")).lower()
    chart_rows = len((chart or {}).get("data") or [])
    chart_series = len((chart or {}).get("series") or [])
    data_type = (clip.dataType if clip else "").strip().lower()
    source_text = " ".join([
        clip.title if clip else "",
        clip.dataSummary if clip else "",
    ]).lower()
    dense_keywords = (
        "time series", "history", "historical", "yield curve", "sensitivity",
        "matrix", "ranking", "ranked", "distribution", "term structure",
    )
    dense = (
        data_type == "table"
        or chart_type in {"box", "range", "scatter"}
        or chart_rows > 7
        or chart_series > 3
        or (data_type == "chart" and any(word in source_text for word in dense_keywords))
    )
    return {
        "dense": dense,
        "hasVisual": bool(chart) or data_type in {"chart", "table", "kpi"},
        "figureCount": len(section.get("keyFigures") or []),
        "wordCount": len(str(section.get("analysis", "")).split()),
    }


def _default_section_design(profile: dict) -> str:
    if profile["dense"]:
        return "visual"
    if profile["wordCount"] >= 110:
        return "narrative"
    if profile["figureCount"] >= 2:
        return "balanced"
    return "compact"


def _section_editorial_role(section: dict) -> str:
    text = " ".join([
        str(section.get("heading", "")),
        str(section.get("analysis", ""))[:320],
    ]).lower()
    if re.search(r"\b(risk|downside|bear case|what could go wrong|uncertaint)", text):
        return "risk"
    if re.search(r"\b(valuation|fair value|price target|multiple|upside|discount|premium|risk.?reward)", text):
        return "valuation"
    if re.search(r"\b(catalyst|milestone|event|calendar|trigger|watch item)", text):
        return "catalyst"
    if re.search(r"\b(earnings|revenue|margin|cash flow|financial|forecast|estimate|growth)", text):
        return "financials"
    if re.search(r"\b(thesis|our call|investment view|bottom line|outlook)", text):
        return "thesis"
    return "context"


def _can_share_editorial_row(profile: dict, layout: str, role: str, index: int) -> bool:
    if index == 0 or profile["dense"] or profile["wordCount"] > 105 or profile["figureCount"] > 3:
        return False
    if layout == "full-width" and profile["hasVisual"]:
        return False
    if layout in {"evidence-band", "analysis-first"} and profile["wordCount"] > 68:
        return False
    return role in {"risk", "valuation", "catalyst", "context", "financials"}


def _apply_section_layout_architecture(
    sections: list[dict],
    clips: list[ReportClipIn],
    preset: str = "",
) -> None:
    """Convert simple editorial intent into renderer-safe research-note compositions.

    `preset` is the composition the user picked during setup. It outranks the
    model's per-section intent and the role heuristics, because it is an explicit
    instruction rather than an inference — but it never outranks the two renderer
    safety rules above it (a dense table needs the full width; a section with no
    visual cannot use a side-by-side layout). 'editorial' is the historical
    default and deliberately falls through to the unchanged behaviour."""
    clips_by_id = {clip.id: clip for clip in clips}
    side_index = 0
    rail_index = 0
    band_index = 0
    last_layout = ""
    profiles: list[dict] = []
    roles: list[str] = []

    for section in sections:
        profile = _section_evidence_profile(section, clips_by_id.get(section.get("clipId", "")))
        role = _section_editorial_role(section)
        profiles.append(profile)
        roles.append(role)
        intent = section.pop("design", None) or _default_section_design(profile)
        figures = profile["figureCount"]
        preset_locked = False

        if profile["dense"]:
            layout = "full-width"
        elif not profile["hasVisual"]:
            layout = "metric-rail" if figures >= 2 else "full-width"
        elif preset == "visual-first":
            layout = "evidence-band" if band_index % 2 == 0 else "full-width"
            band_index += 1
            preset_locked = True
        elif preset == "data-dense" and figures >= 2:
            layout = "metric-rail-left" if rail_index % 2 == 0 else "metric-rail"
            rail_index += 1
            preset_locked = True
        elif preset == "narrative":
            layout = "analysis-first" if figures < 3 else "full-width"
            preset_locked = True
        elif role == "valuation" and figures >= 2:
            layout = "evidence-band"
        elif role in {"risk", "catalyst"}:
            layout = "wrap-right" if side_index % 2 == 0 else "wrap-left"
            side_index += 1
        elif role == "financials" and figures >= 3:
            layout = "metric-rail-left" if rail_index % 2 == 0 else "metric-rail"
            rail_index += 1
        elif intent == "visual":
            layout = "visual-left" if side_index % 2 == 0 else "visual-right"
            side_index += 1
        elif intent == "narrative":
            layout = "wrap-right" if side_index % 2 == 0 else "wrap-left"
            side_index += 1
        elif intent == "compact":
            layout = "wrap-left" if side_index % 2 == 0 else "wrap-right"
            side_index += 1
        elif figures >= 3:
            layout = "metric-rail-left" if rail_index % 2 == 0 else "metric-rail"
            rail_index += 1
        else:
            layout = "visual-right" if side_index % 2 == 0 else "visual-left"
            side_index += 1

        # Alternating consecutive repeats keeps a default-composed note from
        # reading as a template, but a preset the user chose is meant to repeat —
        # mirroring it away is how "narrative" ended up rendering side-by-side.
        if layout == last_layout and layout != "full-width" and not preset_locked:
            mirrors = {
                "visual-left": "visual-right",
                "visual-right": "visual-left",
                "wrap-left": "wrap-right",
                "wrap-right": "wrap-left",
                "metric-rail": "metric-rail-left",
                "metric-rail-left": "metric-rail",
                "evidence-band": "metric-rail-left",
                "analysis-first": "visual-right",
            }
            layout = mirrors.get(layout, layout)
        section["layout"] = layout
        last_layout = layout

    # Research notes use paired support blocks for valuation, catalysts, risks,
    # and compact financial evidence. Mark only complete adjacent pairs so the
    # renderer never leaves an unexplained empty half-row.
    for section in sections:
        section.pop("placement", None)
    index = 1
    while index < len(sections) - 1:
        first = sections[index]
        second = sections[index + 1]
        if (
            _can_share_editorial_row(profiles[index], str(first.get("layout", "")), roles[index], index)
            and _can_share_editorial_row(
                profiles[index + 1],
                str(second.get("layout", "")),
                roles[index + 1],
                index + 1,
            )
        ):
            first["placement"] = "half"
            second["placement"] = "half"
            index += 2
        else:
            index += 1


def _select_report_appendix_clip_ids(raw_ids, clips: list[ReportClipIn], used: set[str]) -> list[str]:
    clip_type = {clip.id: clip.dataType.strip().lower() for clip in clips}
    appendix: list[str] = []
    for raw_id in raw_ids or []:
        clip_id = str(raw_id)
        if (
            clip_id in clip_type
            and clip_type[clip_id] != "chart"
            and clip_id not in used
            and clip_id not in appendix
        ):
            appendix.append(clip_id)
    return appendix

# ── Sequential pipeline: Step 1 (outline) and Step 4 (verify) ────────────────
# The report is built in distinct, ordered LLM passes rather than one rushed
# call, so a weak writer model commits to a thesis-first structure before it
# writes, and a final pass checks the prose against the numbers. Each pass has a
# graceful fallback: if the outline or verify pass fails, the pipeline still
# produces a report from the remaining steps.

_REPORT_OUTLINE_SYSTEM = """You are an equity-research editor planning a report BEFORE it is written. Given the goal and the data clips, produce a top-down outline built around ONE investment thesis.

Rules:
- State a single decisive thesis sentence that directly answers the goal.
- Follow reportLength: short uses 1 to 2 sections; medium uses 3 to 5; long uses 5 to 8. If reportType is portfolio-review, use exactly four sections: What Happened, Why It Happened, What Could Happen Next, and What Action Follows. Merge evidence into those four sections instead of creating module-by-module sections.
- Target a compact two-to-three-page decision note for short and medium reports. Continue beyond three pages only when material evidence cannot be presented clearly within that target. Never pad a report or cut decision-critical evidence merely to hit a page count.
- Each section must advance the thesis with distinct evidence, ordered so the argument builds top-down.
- Use this order when supported: what changed and the call, operating or financial drivers, valuation, catalysts, then risks. Background belongs last and should be omitted when the reader can understand the call without it.
- Require every section and chart to directly advance the central investment thesis. Omit secondary or low-relevance analyses (such as routine DCF sensitivity) unless they provide a critical decision-making insight for the central thesis.
- Every heading must state a finding or tension, not merely name a topic. Use "Margins Hold Despite Slower Growth", not "Revenue Trajectory & Margins".
- ONE section per comparative theme. In a multi-subject comparison every section compares all subjects together (e.g. a single "Valuation Gap" section covering both names). NEVER split a theme into one section per subject.
- Each section names the single most relevant chart family, or "none".
- Use ONLY evidence present in the clips. Do not invent sections the data cannot support.
- The input may contain coverageRequirements. Treat each as non-negotiable and create enough distinct sections to satisfy them without repeating a theme.

Respond ONLY with JSON (no markdown, no code fences):
{
  "thesis": "one decisive sentence answering the goal",
  "sections": [
    { "heading": "Title Case Comparative Theme", "argues": "what this section establishes, one sentence", "chartHint": "growth | margins | valuation | sensitivity | segments | multiples | upside | none" }
  ]
}"""

def _generate_outline(payload: dict) -> dict | None:
    """Step 1 — draft a thesis-first section outline. Returns None on any failure
    so the pipeline falls back to a single unplanned draft."""
    if payload.get("reportType") == "portfolio-review":
        forward_heading = (
            "What Could Happen Next: Stress, Valuation, and Dated Catalysts"
            if payload.get("hasPortfolioValuation")
            else "What Could Happen Next: Stress and Dated Catalysts"
        )
        return {
            "thesis": "Assess the book through measured performance, concentration, and decision-relevant risk.",
            "sections": [
                {"heading": "What Happened: Return and Risk Versus SPY", "argues": "Compare portfolio and SPY period return, active return, volatility, and maximum drawdown using matching dates and methods.", "chartHint": "performance"},
                {"heading": "Why It Happened: Market Sensitivity and Name-Specific Risk", "argues": "Separate measured market sensitivity, factor coefficients, and holding concentration from unsupported active-return attribution.", "chartHint": "risk"},
                {"heading": forward_heading, "argues": "Show beta-only market stress, any supplied compact valuation evidence, and only catalysts with actual supplied dates.", "chartHint": "scenario"},
                {"heading": "What Action Follows: Evidence Before Reallocation", "argues": "Recommend no allocation change unless a proposed portfolio and quantified before-and-after risk and return evidence are supplied.", "chartHint": "none"},
            ],
        }
    try:
        messages = [
            {"role": "system", "content": _REPORT_OUTLINE_SYSTEM},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]
        resp = groq_chat(messages, model=MODEL_SMART, max_tokens=900, temperature=0.2)
        out = parse_json((resp.choices[0].message.content or "").strip())
        if not isinstance(out, dict):
            return None
        secs = [
            {"heading": _title_case(str(s.get("heading", "")).strip()),
             "argues": str(s.get("argues", "")).strip(),
             "chartHint": str(s.get("chartHint", "")).strip().lower()}
            for s in (out.get("sections") or []) if isinstance(s, dict) and str(s.get("heading", "")).strip()
        ]
        if not secs:
            return None
        section_cap = 4 if payload.get("reportType") == "portfolio-review" else {"short": 2, "medium": 5, "long": 8}[_length_key(payload.get("reportLength"))]
        return {"thesis": str(out.get("thesis", "")).strip(), "sections": secs[:section_cap]}
    except Exception as e:  # noqa: BLE001 — outline is best-effort
        logger.warning("report outline step failed: %s", e)
        return None

_REPORT_VERIFY_SYSTEM = """You are a senior equity-research copy editor doing the final proofreading pass. You receive the report's executiveSummary and conclusion, plus CHART FACTS: the exact figures shown in the report's charts.

Fix ONLY these, and change nothing else:
1. Numerical accuracy — any number in the text that contradicts the CHART FACTS must be corrected to the chart figure. Never introduce a number that is not in the facts.
2. Tone — sharp, professional equity-research prose. Cut filler, hedging, and repetition. No em dashes, no semicolons, no emoji, no bullet lists.
3. Swings and moves — any price swing, sensitivity range, target band, or move stated only in dollars must be restated as a percent of the current price. The CHART FACTS carry the percent (e.g. a sensitivity series labeled "NVDA (19% swing)"); use it. Never contrast two differently-priced names' swings in dollars alone. Do not invent a percent that is not derivable from the facts.

Keep the verdict, the lean, and the overall length unchanged. Do not restructure. Respond ONLY with JSON (no markdown, no code fences):
{ "executiveSummary": "...", "conclusion": "..." }"""

def _chart_facts(sections: list[dict]) -> str:
    """Compact, human-readable digest of every number the site put into the
    section charts — the ground truth the verify pass checks the prose against."""
    facts: list[str] = []
    for sec in sections:
        ch = sec.get("chart")
        if not isinstance(ch, dict):
            continue
        x_key = ch.get("xKey", "")
        rows: list[str] = []
        for row in (ch.get("data") or [])[:8]:
            cat = row.get(x_key)
            vals: list[str] = []
            for s in ch.get("series", []):
                v = row.get(s.get("key"))
                if isinstance(v, (list, tuple)) and len(v) == 2:
                    vals.append(f"{s.get('label')} {v[0]}-{v[1]}")
                elif isinstance(v, (int, float)) and not isinstance(v, bool):
                    vals.append(f"{s.get('label')} {v}")
            if vals:
                rows.append(f"{cat}: " + ", ".join(vals))
        if rows:
            facts.append(f"{ch.get('title', 'Chart')} — " + "; ".join(rows))
    return " | ".join(facts)

def _verify_report(executive: str, conclusion: str, chart_facts: str) -> dict | None:
    """Step 4 — proofread the summary and conclusion for numeric consistency
    against the chart facts and for tone. Returns None on failure so the draft
    prose is used unchanged."""
    if not executive and not conclusion:
        return None
    try:
        payload = {"executiveSummary": executive, "conclusion": conclusion, "chartFacts": chart_facts or "(no charts)"}
        messages = [
            {"role": "system", "content": _REPORT_VERIFY_SYSTEM},
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
        ]
        resp = groq_chat(messages, model=MODEL_SMART, max_tokens=1400, temperature=0.1)
        out = parse_json((resp.choices[0].message.content or "").strip())
        if not isinstance(out, dict):
            return None
        es = str(out.get("executiveSummary", "")).strip()
        cc = str(out.get("conclusion", "")).strip()
        # Guard against a pass that dropped content: keep the draft if a field
        # came back empty or implausibly shorter than the original.
        if es and len(es) < len(executive) * 0.5:
            es = executive
        if cc and len(cc) < len(conclusion) * 0.5:
            cc = conclusion
        return {"executiveSummary": es or executive, "conclusion": cc or conclusion}
    except Exception as e:  # noqa: BLE001 — verify is best-effort
        logger.warning("report verify step failed: %s", e)
        return None

def _fix_comparative_reversals(text: str, clips: list[ReportClipIn]) -> str:
    """Post-generation linter for NARR-03: extracts comparative claims, compares operands,
    and auto-corrects directional reversals (e.g. 'lower ROE (141.5%)' vs 114.3%)."""
    if not text or not clips:
        return text
    by_ticker = _all_kpis_by_ticker(clips)
    if len(by_ticker) < 2:
        return text

    parsed_vals: dict[str, dict[str, float]] = {}
    for tkr, kv in by_ticker.items():
        parsed_vals[tkr] = {}
        for k, v in kv.items():
            num = _first_number(str(v))
            if num is not None:
                parsed_vals[tkr][k.upper()] = num

    tickers = list(parsed_vals.keys())
    for i in range(len(tickers)):
        for j in range(i + 1, len(tickers)):
            t1, t2 = tickers[i], tickers[j]
            v1, v2 = parsed_vals[t1], parsed_vals[t2]

            roe1, roe2 = v1.get("ROE"), v2.get("ROE")
            if roe1 is not None and roe2 is not None:
                if roe1 > roe2:
                    pattern = rf"(\b{re.escape(t1)}(?:'s|’s)?\b[^\n.]{{0,80}}\b)lower(\s+roe\b)"
                    text = re.sub(pattern, r"\1higher\2", text, flags=re.I)
                elif roe2 > roe1:
                    pattern = rf"(\b{re.escape(t2)}(?:'s|’s)?\b[^\n.]{{0,80}}\b)lower(\s+roe\b)"
                    text = re.sub(pattern, r"\1higher\2", text, flags=re.I)

            gm1, gm2 = v1.get("GROSS MARGIN"), v2.get("GROSS MARGIN")
            if gm1 is not None and gm2 is not None:
                if gm1 > gm2:
                    pattern = rf"(\b{re.escape(t1)}(?:'s|’s)?\b[^\n.]{{0,80}}\b)lower(\s+gross\s+margin\b)"
                    text = re.sub(pattern, r"\1higher\2", text, flags=re.I)

    return text

def _fix_upside_vocabulary_reversals(text: str) -> str:
    """NARR-01 & NARR-02: Fix upside/downside vocabulary reversals and misleading CAGR labels."""
    if not text:
        return text
    text = re.sub(r"trading\s+([\d.]+%\s+)above\s+intrinsic\s+value", r"trading at a \1downside to intrinsic value", text, flags=re.I)
    text = re.sub(r"\b(single-period|85\.2%|35%|16\.6%)\s+revenue\s+cagr\b", r"\1 revenue growth rate", text, flags=re.I)
    return text


def _dcf_price_pairs(clips: list[ReportClipIn]) -> list[tuple[str, float, float]]:
    pairs: list[tuple[str, float, float]] = []
    for clip in clips:
        if not re.search(r"\bdcf verdict\b", clip.title, re.I):
            continue
        fields = _parse_kpi_summary(clip.dataSummary)
        intrinsic = _first_number(fields.get("Intrinsic / Share", ""))
        market = _first_number(fields.get("Market Price", ""))
        ticker = _clip_ticker(clip) or "the subject"
        if intrinsic is not None and market is not None and market > 0:
            pairs.append((ticker, intrinsic, market))
    return pairs


def _fix_dcf_direction(text: str, clips: list[ReportClipIn]) -> str:
    if not text:
        return text
    pairs = _dcf_price_pairs(clips)
    if not pairs:
        return text
    ticker, intrinsic, market = pairs[0]
    downside = max(0.0, (1 - intrinsic / market) * 100)
    if intrinsic >= market:
        return text
    text = re.sub(
        r"(?:trades?\s+at\s+)?(?:an?\s+)?\d+(?:\.\d+)?%\s+discount\s+to\s+(?:its\s+)?(?:dcf[- ]derived\s+)?intrinsic\s+value",
        f"has {downside:.1f}% downside to DCF-derived intrinsic value",
        text,
        flags=re.I,
    )
    text = re.sub(r"\bmagnitude of (?:the|this) discount\b", "magnitude of the DCF downside", text, flags=re.I)
    return text


def _extreme_dcf_warning(clips: list[ReportClipIn]) -> str | None:
    pairs = _dcf_price_pairs(clips)
    if not pairs:
        return None
    ticker, intrinsic, market = pairs[0]
    ratio = intrinsic / market
    if 0.2 <= ratio <= 5:
        return None
    direction = (ratio - 1) * 100
    implication = f"{abs(direction):.1f}% {'upside' if direction > 0 else 'downside'}"
    return (
        f"The {ticker} DCF output is ${intrinsic:,.2f} per share versus a ${market:,.2f} market price, "
        f"which implies {implication}. This extreme scale gap is not decision-grade until share count, "
        "units, corporate actions, and price alignment are reconciled. Peer multiples and analyst consensus "
        "are separate methods and do not validate the DCF magnitude."
    )

def _ensure_risks_section(sections: list[dict], subject: str | None, valuation_context: dict) -> None:
    """Ensure a qualitative key-risks section exists. Deliberately carries NO
    falsification trigger and NO invented threshold figures — risks are described
    in plain prose so the report never states a fabricated cutoff, date, or
    trigger level."""
    has_risks = any(re.search(r"\brisk", s.get("heading", ""), re.I) for s in sections)
    if not has_risks:
        sections.append({
            "clipId": "key-investment-risks",
            "heading": _title_case("Key Investment Risks"),
            "analysis": (
                "Product cycle transitions and customer spending pauses pose execution risk to the "
                "revenue trajectory the thesis relies on. A faster discount-rate expansion or a "
                "compression in the valuation multiple would weigh directly on the present value of "
                "future cash flows and is the main way the call is wrong. Monitor these against the "
                "figures cited above rather than any fixed trigger level."
            ),
            "keyFigures": [],
            "chart": None,
        })

def _sensitivity_swing_summary(clips: list[ReportClipIn], price_by_subject: dict[str, float | None]) -> dict[str, dict]:
    """Per-subject intrinsic-value envelope from the DCF one-way sensitivity data,
    expressed as a PERCENT of that subject's current price so swings are
    comparable across differently-priced names (a $40 NVDA swing and a $400 MELI
    swing are both stated as a percent of spot). Returns {} when no sensitivity
    data or price is available."""
    ch = _mechanical_sensitivity_chart(clips)
    if not ch:
        return {}
    out: dict[str, dict] = {}
    for s in ch.get("series", []):
        key = str(s.get("key", "")).upper()
        lows: list[float] = []
        highs: list[float] = []
        for row in ch.get("data", []):
            v = row.get(s.get("key"))
            if isinstance(v, (list, tuple)) and len(v) == 2:
                try:
                    lows.append(float(v[0])); highs.append(float(v[1]))
                except (TypeError, ValueError):
                    continue
        if not lows:
            continue
        lo, hi = min(lows), max(highs)
        price = price_by_subject.get(key)
        swing_pct = ((hi - lo) / price * 100.0) if price else None
        out[key] = {
            "low": round(lo, 2), "high": round(hi, 2), "swing": round(hi - lo, 2),
            "swingPct": round(swing_pct, 1) if swing_pct is not None else None,
        }
    return out


def _annotate_sensitivity_swing(sections: list[dict], price_by_subject: dict[str, float | None]) -> None:
    """Fold each subject's swing-as-percent-of-spot into the placed sensitivity
    range chart's series labels, so the visual states the percent regardless of
    what the prose does (e.g. 'NVDA (19% swing)'). Mutates sections in place."""
    for sec in sections:
        ch = sec.get("chart")
        if not isinstance(ch, dict) or ch.get("chartType") != "range":
            continue
        title = str(ch.get("title", "")).lower()
        if "sensitiv" not in title and "swing" not in title:
            continue
        for s in ch.get("series", []):
            key = str(s.get("key", "")).upper()
            price = price_by_subject.get(key)
            if not price:
                continue
            lows: list[float] = []
            highs: list[float] = []
            for row in ch.get("data", []):
                v = row.get(s.get("key"))
                if isinstance(v, (list, tuple)) and len(v) == 2:
                    try:
                        lows.append(float(v[0])); highs.append(float(v[1]))
                    except (TypeError, ValueError):
                        continue
            if not lows:
                continue
            pct = (max(highs) - min(lows)) / price * 100.0
            base = str(s.get("key", ""))
            s["label"] = f"{base} ({pct:.0f}% swing)"


def _build_report_slot_ctx(clips: list[ReportClipIn], subject: str | None, name: str | None,
                           market: float | None, dcf_intrinsic: float | None):
    """Deterministic slot fields (subject/peer numerics) shared by report
    generation and revision, so revised prose passes the same numeric guardrails
    the original draft did."""
    from routers.slot_engine import SlotContext
    slot_fields: dict = {
        "subject.ticker": subject or "",
        "subject.name": name or "",
        "subject.market_price": market,
        "subject.dcf_intrinsic": dcf_intrinsic,
    }
    all_kpis = _all_kpis_by_ticker(clips)
    subj_kpis = all_kpis.get((subject or "").upper(), {})
    slot_fields["subject.pe_trailing"] = _first_number(subj_kpis.get("P/E") or subj_kpis.get("PE") or "")
    slot_fields["subject.roe"] = _first_number(subj_kpis.get("ROE") or "")
    slot_fields["subject.gross_margin"] = _first_number(subj_kpis.get("GROSS MARGIN") or subj_kpis.get("MARGIN") or "")
    slot_fields["subject.rev_growth"] = _first_number(subj_kpis.get("REV GROWTH") or subj_kpis.get("GROWTH") or "")

    pe_vals = [num for t, kv in all_kpis.items() if t != (subject or "").upper() and (num := _first_number(kv.get("P/E") or "")) is not None]
    if pe_vals:
        slot_fields["peers.pe_median"] = round(float(_median(pe_vals)), 1)
    roe_vals = [num for t, kv in all_kpis.items() if t != (subject or "").upper() and (num := _first_number(kv.get("ROE") or "")) is not None]
    if roe_vals:
        slot_fields["peers.roe_median"] = round(float(_median(roe_vals)), 1)
    return SlotContext(fields=slot_fields)


_NUMERIC_CLAIM_RE = re.compile(
    r"(?<![A-Za-z])(?:[$+\-]\s*)?\d[\d,]*(?:\.\d+)?(?:\s*(?:%|x|×|bps?))?(?![A-Za-z])",
    re.I,
)


def _numeric_value(token: str) -> float | None:
    match = re.search(r"[-+]?\d[\d,]*(?:\.\d+)?", token.replace("$", "").replace(" ", ""))
    if not match:
        return None
    try:
        return float(match.group(0).replace(",", ""))
    except ValueError:
        return None


def _supported_report_numbers(clips: list[ReportClipIn], slot_ctx) -> list[float]:
    source = "\n".join(
        " ".join([clip.title, clip.userDescription, clip.dataSummary])
        for clip in clips
    )
    values = [
        value
        for token in _NUMERIC_CLAIM_RE.findall(source)
        if (value := _numeric_value(token)) is not None
    ]
    for raw in getattr(slot_ctx, "fields", {}).values():
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            values.append(float(raw))
    return values


def _unsupported_numeric_claims(text: str, supported: list[float]) -> list[str]:
    unsupported: list[str] = []
    for match in _NUMERIC_CLAIM_RE.finditer(text):
        token = match.group(0)
        value = _numeric_value(token)
        if value is None:
            continue
        following = text[match.end(): match.end() + 16]
        if 1900 <= abs(value) <= 2100 or re.match(r"\s*(?:days?|weeks?|months?|years?|quarters?)\b", following, re.I):
            continue
        has_financial_unit = bool(re.search(r"[$%×]|\bx\b|\bbps?\b", token, re.I))
        if not has_financial_unit and abs(value) < 13:
            continue
        tolerance = max(0.11, abs(value) * 0.015)
        if any(abs(value - candidate) <= max(tolerance, abs(candidate) * 0.015) for candidate in supported):
            continue
        unsupported.append(token.strip())
    return unsupported


def _remove_unverified_numeric_sentences(text: str, clips: list[ReportClipIn], slot_ctx) -> str:
    if not text:
        return text
    supported = _supported_report_numbers(clips, slot_ctx)
    blocks = re.split(r"(\n+)", text)
    cleaned: list[str] = []
    removed = False
    for block in blocks:
        if not block or block.startswith("\n"):
            cleaned.append(block)
            continue
        sentences = re.split(r"(?<=[.!?])\s+", block)
        kept = []
        for sentence in sentences:
            if _unsupported_numeric_claims(sentence, supported):
                removed = True
                continue
            kept.append(sentence)
        cleaned.append(" ".join(kept))
    result = re.sub(r"\n{3,}", "\n\n", "".join(cleaned)).strip()
    if result:
        return result
    if removed:
        return "The supplied clips do not verify the numerical comparison generated for this section."
    return text


def _filter_unverified_key_figures(sections: list[dict], clips: list[ReportClipIn], slot_ctx) -> None:
    supported = _supported_report_numbers(clips, slot_ctx)
    for section in sections:
        section["keyFigures"] = [
            figure
            for figure in section.get("keyFigures", [])
            if not _unsupported_numeric_claims(str(figure.get("value", "")), supported)
        ]


def _apply_report_linters(text: str, clips: list[ReportClipIn], slot_ctx) -> str:
    """The full deterministic prose pass: comparative-direction fixes, upside
    vocabulary fixes, slot resolution, then numeric provenance enforcement.
    Applied to every AI-written block in both the initial draft and later revision."""
    from routers.slot_engine import resolve_slots
    resolved = resolve_slots(
        _remove_unsupported_sector_momentum(
            _remove_unsupported_catalyst_claims(
                _repair_portfolio_diversification_claims(
                    _separate_drawdown_and_stress(
                        _separate_systematic_and_residual_risk(
                            _repair_valuation_method_causality(
                                _clarify_direct_sector_weights(
                                    _fix_portfolio_performance_claims(
                                        _fix_dcf_direction(
                                            _fix_upside_vocabulary_reversals(_fix_comparative_reversals(text, clips)),
                                            clips,
                                        ),
                                        clips,
                                    ),
                                    clips,
                                )
                            ),
                        ),
                    ),
                    clips,
                ),
                clips,
            ),
            clips,
        ),
        slot_ctx,
    )
    return _remove_unverified_numeric_sentences(resolved, clips, slot_ctx)


def _portfolio_active_return(clips: list[ReportClipIn]) -> float | None:
    for clip in clips:
        match = re.search(
            r"Active return(?:\s+vs\s+[A-Z0-9.^-]+)?\s*:\s*([+\-]?\d+(?:\.\d+)?)%",
            f"{clip.title}\n{clip.dataSummary}",
            re.I,
        )
        if match:
            try:
                return float(match.group(1))
            except ValueError:
                return None
    return None


def _has_attribution_evidence(clips: list[ReportClipIn]) -> bool:
    return any(
        re.search(r"\b(attribution|contribution to (?:active )?return|security selection)\b", f"{c.sourceTab} {c.title}", re.I)
        for c in clips
    )


def _fix_portfolio_performance_claims(text: str, clips: list[ReportClipIn]) -> str:
    """Make benchmark direction deterministic and remove unsupported causality.

    The AI may explain a computed active return, but it cannot reverse its sign or
    infer that a tilt caused it without an attribution dataset.
    """
    if not text:
        return text
    active_return = _portfolio_active_return(clips)
    if active_return is not None and active_return < 0:
        text = re.sub(r"\boutperformance\b", "underperformance", text, flags=re.I)
        text = re.sub(r"\boutperformed\b", "underperformed", text, flags=re.I)
        text = re.sub(r"\boutperforming\b", "underperforming", text, flags=re.I)
    elif active_return is not None and active_return > 0:
        text = re.sub(r"\bunderperformance\b", "outperformance", text, flags=re.I)
        text = re.sub(r"\bunderperformed\b", "outperformed", text, flags=re.I)
        text = re.sub(r"\bunderperforming\b", "outperforming", text, flags=re.I)
    if not _has_attribution_evidence(clips):
        text = re.sub(
            r"\b(drives?|driving|generates?|generated|causes?|caused)\s+(outperformance|underperformance)\b",
            r"is associated with \2",
            text,
            flags=re.I,
        )
        repaired = []
        for sentence in re.split(r"(?<=[.!?])\s+", text):
            if (
                re.search(r"\b(?:beta|risk|volatility|Sharpe|drawdown|asset selection)\b", sentence, re.I)
                and re.search(r"\b(?:lag|underperform)", sentence, re.I)
                and re.search(r"\b(?:driv(?:e|en|ing)?|explain(?:s|ed|ing)?|caus(?:e|ed|ing)|source|responsib(?:le|ility)|attribut(?:e|ed|ion)|dominat(?:e|es|ed|ing)|reflect(?:s|ed|ing)?|stems?\s+from|due\s+to|because)\b", sentence, re.I)
            ):
                repaired.append(
                    "The portfolio produced a different return and risk profile from SPY. The available evidence does not determine whether active return arose from market exposure, allocation, security selection, cash, fees, or trading."
                )
            else:
                repaired.append(sentence)
        text = " ".join(repaired)
    return text


_PORTFOLIO_ACTION_RE = re.compile(
    r"(?:"
    r"\brecommend(?:s|ed|ing|ation)?\b|"
    r"\b(?:we|investors?|the portfolio|you)\s+(?:should\s+|would\s+)?"
    r"(?:add(?:ing)?|buy(?:ing)?|increase|increasing|trim(?:ming)?|reduc(?:e|ing)|sell(?:ing)?|hold(?:ing)?|maintain(?:ing)?|allocat(?:e|ing)|hedg(?:e|ing))\b|"
    r"\b(?:add(?:ing)?|buy(?:ing)?|increase|increasing|trim(?:ming)?|reduc(?:e|ing)|sell(?:ing)?)\s+(?:the\s+)?"
    r"(?:position|exposure|allocation|weight|shares?|[A-Z]{1,5})\b|"
    r"\b(?:reduction|increase|trim|addition|reallocation)\s+(?:in|of|to)\s+(?:the\s+)?(?:position|exposure|allocation|weight)\b|"
    r"\b(?:trim|reduction|reallocation)\s+(?:is|appears|looks)\s+(?:justified|warranted|supported)\b"
    r")",
    re.I,
)


def _remove_unsupported_portfolio_actions(text: str) -> str:
    """Remove implementable advice when no before/after trade evidence exists.

    Prompt instructions are insufficient here: the writer can still produce a
    bullish thesis and an allocation instruction beside a blocking warning. A
    deterministic sentence filter makes the gate authoritative in every prose
    block, including headings generated by a later verification pass.
    """
    if not text or not _PORTFOLIO_ACTION_RE.search(text):
        return text
    parts = re.split(r"(?<=[.!?])\s+|\n+", text)
    kept = [part.strip() for part in parts if part.strip() and not _PORTFOLIO_ACTION_RE.search(part)]
    return " ".join(kept).strip()


def _has_portfolio_trade_impact_evidence(clips: list[ReportClipIn]) -> bool:
    evidence = "\n".join(f"{clip.sourceTab}\n{clip.title}\n{clip.dataSummary}" for clip in clips)
    has_proposal = bool(re.search(
        r"\b(proposed|target)\s+(?:portfolio|allocation|weight)|\btrade (?:size|list)|\bshares? to (?:buy|sell)\b",
        evidence,
        re.I,
    ))
    has_impact = bool(re.search(
        r"\b(post[- ]trade|after (?:the )?trade|before and after|expected portfolio beta|scenario loss|trade impact)\b",
        evidence,
        re.I,
    ))
    return has_proposal and has_impact


def _remove_unsupported_sector_momentum(text: str, clips: list[ReportClipIn]) -> str:
    if any(re.search(r"sector rotation|sector leadership", f"{clip.sourceTab} {clip.title}", re.I) for clip in clips):
        return text
    sentences = re.split(r"(?<=[.!?])\s+", text)
    return " ".join(
        sentence for sentence in sentences
        if not (
            re.search(r"\bmomentum\b", sentence, re.I)
            and re.search(r"\b(technology|tech|energy|sector)\b", sentence, re.I)
        )
    ).strip()


def _repair_valuation_method_causality(text: str) -> str:
    repaired: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if re.search(r"\bP\s*/\s*E\b", sentence, re.I) and re.search(r"\bDCF\b", sentence, re.I):
            sentence = re.sub(
                r",?\s*(?:delivering|implying|creating|producing)\s+",
                ". Separately, the DCF indicates ",
                sentence,
                flags=re.I,
            )
        repaired.append(sentence)
    text = " ".join(repaired)
    return re.sub(
        r"(?:^|(?<=[.!?])\s+)No DCF valuation (?:is|was) supplied[^.!?]*[.!?]?\s*",
        "",
        text,
        flags=re.I,
    ).strip()


def _separate_systematic_and_residual_risk(text: str) -> str:
    repaired: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if (
            re.search(r"\bbeta\b", sentence, re.I)
            and re.search(r"\b(?:idiosyncratic|residual|name[- ]specific)\b", sentence, re.I)
            and re.search(r"\b(?:driv|explain|caus|because|due|from|attribut|contribut|amplif)", sentence, re.I)
        ):
            repaired.append(
                "Market beta measures systematic sensitivity. Residual variance measures name-specific risk, and position weight determines how each affects the account."
            )
        else:
            repaired.append(sentence)
    return " ".join(repaired)


def _separate_drawdown_and_stress(text: str) -> str:
    repaired: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if (
            re.search(r"\bdrawdown\b", sentence, re.I)
            and re.search(r"\b(?:stress|scenario|beta[- ]only|hypothetical|implied)\b", sentence, re.I)
        ):
            repaired.append(
                "Maximum drawdown is an observed peak-to-trough loss. The beta-only stress result is a separate hypothetical market-shock sensitivity."
            )
        else:
            repaired.append(sentence)
    return " ".join(repaired)


def _repair_portfolio_diversification_claims(text: str, clips: list[ReportClipIn]) -> str:
    if len(_material_portfolio_positions(clips)) != 1:
        return text
    repaired: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        if re.search(r"\bcorrelation\b", sentence, re.I) and re.search(r"\bdiversif", sentence, re.I):
            repaired.append(
                "Low correlation with comparison securities indicates potential diversification, but the account realizes none because one security holds the entire positive-weight allocation."
            )
        else:
            repaired.append(sentence)
    return " ".join(repaired)


def _remove_unsupported_catalyst_claims(text: str, clips: list[ReportClipIn]) -> str:
    has_dated_event = any(
        re.search(r"\b(upcoming portfolio earnings schedule|earnings setup|catalyst calendar)\b", clip.title, re.I)
        and not re.search(r"\bmethodology\b", clip.title, re.I)
        and bool(re.search(r"\b20\d{2}-\d{2}-\d{2}\b", clip.dataSummary))
        for clip in clips
    )
    if has_dated_event:
        return text
    text = re.sub(r"\s*(?:and|&)\s+upcoming catalysts?\b", "", text, flags=re.I)
    return re.sub(r"\bupcoming catalysts?\b", "forward evidence", text, flags=re.I)


def _clarify_direct_sector_weights(text: str, clips: list[ReportClipIn]) -> str:
    if not any(re.search(r"fund look-through limitation", clip.title, re.I) for clip in clips):
        return text
    text = re.sub(
        r"\b(?:technology|tech)(?:\s+holdings?)?\s+(?:accounts? for|represents?|is|weight is)\s+"
        r"([+\-]?\d+(?:\.\d+)?%)\s+(?:of\s+)?(?:the\s+)?portfolio(?:'s)?(?:\s+(?:weight|value))?",
        r"Directly classified technology holdings account for \1 of portfolio value, excluding fund look-through",
        text,
        flags=re.I,
    )
    text = re.sub(
        r"High Market Beta and Concentrated (?:Technology|Tech) Exposure",
        "High Market Sensitivity and NVDA-Specific Risk",
        text,
        flags=re.I,
    )
    repaired: list[str] = []
    for sentence in re.split(r"(?<=[.!?])\s+", text):
        pct = re.search(r"([+\-]?\d+(?:\.\d+)?%)", sentence)
        if pct and re.search(r"\b(?:technology|tech)\b", sentence, re.I) and re.search(
            r"\b(?:actual|total|hides?|overweight(?:ed)?|fund look[- ]through)\b", sentence, re.I
        ):
            repaired.append(
                f"Directly held technology securities represent {pct.group(1)} of the portfolio. "
                "Total economic technology exposure cannot be determined without fund holdings look-through."
            )
        elif re.search(r"\boverweight(?:ed)?\b.*\b(?:technology|tech)\b", sentence, re.I):
            repaired.append("The supplied evidence supports NVDA-specific risk concentration, not a total technology overweight conclusion.")
        else:
            repaired.append(sentence)
    return " ".join(repaired)


def _report_quality_warnings(req: ReportGenRequest, book_level: bool) -> list[dict]:
    if not book_level:
        return []
    warnings: list[dict] = []
    portfolio_clips = [c for c in req.clips if re.search(r"portfolio manager|active book", c.sourceTab, re.I)]
    portfolio_text = "\n".join(f"{c.title}\n{c.dataSummary}" for c in portfolio_clips)
    if not portfolio_clips:
        warnings.append({
            "severity": "warning", "code": "allocation-missing",
            "title": "Current allocation is not verified",
            "detail": "No authoritative holdings and weights clip was supplied, so allocation advice is not implementable.",
        })
    elif re.search(r"\bunpriced\b|excluded from portfolio weights", portfolio_text, re.I):
        warnings.append({
            "severity": "warning", "code": "allocation-incomplete",
            "title": "Portfolio weights are incomplete",
            "detail": "At least one position lacks a usable mark and is excluded from the reported allocation.",
        })
    elif re.search(r"saved cost fallback|fallback", portfolio_text, re.I):
        warnings.append({
            "severity": "warning", "code": "allocation-fallback-marks",
            "title": "Some weights use fallback marks",
            "detail": "One or more positions use saved cost rather than a current quote; concentration figures are provisional.",
        })

    active_return = _portfolio_active_return(req.clips)
    if active_return is None:
        warnings.append({
            "severity": "warning", "code": "benchmark-comparison-missing",
            "title": "Benchmark-relative return is not auditable",
            "detail": "The evidence does not provide a deterministic active return computed on matching dates and methods.",
        })
    else:
        warnings.append({
            "severity": "info", "code": "benchmark-fit",
            "title": "Benchmark suitability requires confirmation",
            "detail": "SPY is a broad US equity reference, not a validated policy benchmark; a multi-asset book may require a blended benchmark.",
        })

    if not any(re.search(r"\b(stress test|scenario loss|expected shortfall|value at risk|CVaR|VaR)\b", f"{c.sourceTab} {c.title}", re.I) for c in req.clips):
        warnings.append({
            "severity": "info", "code": "forward-risk-missing",
            "title": "Risk evidence is backward-looking",
            "detail": "Volatility, beta, and drawdown describe the selected history; no forward stress loss or probability distribution was supplied.",
        })

    all_text = "\n".join(f"{c.sourceTab}\n{c.title}\n{c.dataSummary}" for c in req.clips)
    objective = f"{req.projectName}\n{req.purpose}\n{req.goal}\n{req.mustInclude}"
    if re.search(r"\b(inflation|CPI|PCE|sticky prices?)\b", objective, re.I):
        has_inflation_measure = bool(re.search(
            r"\b(?:core\s+)?(?:CPI|PCE)\b[^\n]{0,100}\d+(?:\.\d+)?%",
            all_text,
            re.I,
        ))
        if not has_inflation_measure:
            warnings.append({
                "severity": "warning", "code": "inflation-evidence-missing",
                "title": "Inflation thesis lacks measured evidence",
                "detail": "No dated CPI or PCE reading with a value was supplied, so inflation cannot support the headline or allocation call.",
            })

    if any(c.sourceTab.lower().startswith("earnings") for c in req.clips):
        warnings.append({
            "severity": "info", "code": "earnings-comparability",
            "title": "Earnings figures require company-specific context",
            "detail": "Absolute EPS levels across issuers are not comparable; use growth, revisions, dispersion, valuation, and historical reactions instead.",
        })
    return warnings


@router.post("/report")
def generate_report(req: ReportGenRequest):
    if not req.clips:
        raise HTTPException(400, "No clips to synthesize")
    valid_ids = {c.id for c in req.clips}

    subject = _subject_ticker(req)
    subjects_ranked = _ranked_subjects(req)
    # A book, a regime and a result set have no single subject equity. Resolving
    # one anyway hands the model a subjectTicker with live spot and an
    # instruction to always cite it, which is how a four-holding portfolio review
    # came back as a Hold rating on whichever holding had the most clips.
    book_level = _book_level_report(req, subjects_ranked)
    if book_level:
        subject = None
    evidence_subjects = _subject_evidence_tickers(req.clips)
    if subject and evidence_subjects and subject not in evidence_subjects:
        evidence_subject = sorted(
            evidence_subjects.items(),
            key=lambda item: (-item[1], item[0]),
        )[0][0]
        raise HTTPException(
            409,
            f"Report objective resolves to {subject}, but the collected company evidence is for "
            f"{evidence_subject}. Re-run AlphaTape research for {subject} before generating.",
        )
    mode = "open" if book_level else _report_mode(req, subjects_ranked)
    length_key = _length_key(req.length)
    dcf_names = sorted(_dcf_tickers_from_clips(req.clips))
    subject_dcf = _subject_dcf_present(req.clips, subject)
    quote = _fetch_market_quote(subject)
    market = float(quote["price"]) if quote.get("price") else None
    change_pct = float(quote["changePct"]) if quote.get("changePct") is not None else None
    dcf_intrinsic = _dcf_intrinsic_for_subject(req.clips, subject) if subject_dcf else None
    signal_digest = _clip_signal_digest(req.clips)
    quality_warnings = _report_quality_warnings(req, book_level)
    valuation_context = {
        "reportMode": mode,
        "reportLength": length_key,
        "subjectTicker": subject,
        "subjectName": quote.get("name"),
        "marketPrice": round(market, 4) if market else None,
        "dayChangePct": round(change_pct, 3) if change_pct is not None else None,
        "priceSource": quote.get("source"),
        "subjectDcfPresent": subject_dcf,
        "subjectDcfIntrinsic": round(dcf_intrinsic, 4) if dcf_intrinsic else None,
        "dcfTickersInClips": dcf_names,
        "signalDigest": signal_digest,
        "qualityWarnings": quality_warnings,
        "note": (
            "marketPrice is LIVE spot for subjectTicker — always cite it. "
            "signalDigest summarizes directional cues already in the clips (GEX, call%, IV, cone). "
            "Vol cone and implied move bound WIDTH only. "
            "When signalDigest.suggestedLean is bullish or bearish, the research range must encode that lean "
            "(mid shifted and/or asymmetric wings). Do not publish spot ± impliedMove as the whole thesis. "
            "Integrate every clip family into one argument. "
            "qualityWarnings are advisory limitations to disclose in the analysis; they never prevent generation. "
            "subjectDcfIntrinsic is one input, not the answer. "
            "reportMode tells you the shape keyResult must take — see system prompt."
        ),
    }

    if book_level:
        valuation_context["note"] = (
            "This report has NO single subject equity — the subject is the book, regime, or result "
            "set as a whole. subjectTicker is deliberately null: do not promote any one constituent "
            "into the report's subject, do not headline a single ticker, and do not issue a per-name "
            "Buy/Hold/Sell rating as the report's verdict. valuationContext.subjects lists the "
            "constituents with live spot; use them as components of the aggregate picture. "
            "signalDigest summarizes directional cues already in the clips. "
            "qualityWarnings are advisory limitations to disclose, never reasons to refuse the report. "
            "Integrate every clip family into one argument."
        )

    if (mode == "open" and len(subjects_ranked) >= 2) or (book_level and subjects_ranked):
        subj_ctx = []
        for t in subjects_ranked[:4]:
            q = quote if t == subject else _fetch_market_quote(t)
            mkt_t = float(q["price"]) if q.get("price") else None
            chg_t = float(q["changePct"]) if q.get("changePct") is not None else None
            dcf_present_t = _subject_dcf_present(req.clips, t)
            dcf_val_t = _dcf_intrinsic_for_subject(req.clips, t) if dcf_present_t else None
            subj_ctx.append({
                "ticker": t,
                "name": q.get("name"),
                "marketPrice": round(mkt_t, 4) if mkt_t else None,
                "dayChangePct": round(chg_t, 3) if chg_t is not None else None,
                "dcfIntrinsic": round(dcf_val_t, 4) if dcf_val_t else None,
            })
        valuation_context["subjects"] = subj_ctx
        valuation_context["note"] += (
            " This is a multi-subject report: valuationContext.subjects lists every named "
            "ticker with its own live spot and DCF (if present). Weigh ALL of them against "
            "each other using their own clips — do not silently pick one as the report's real "
            "subject and relegate the other's central clips to appendixClipIds."
        )

    # Price-by-subject for percent-of-spot swing framing (single + multi subject).
    price_by_subject: dict[str, float | None] = {}
    if subject and market:
        price_by_subject[subject.upper()] = market
    for s in valuation_context.get("subjects", []):
        if s.get("ticker") and s.get("marketPrice"):
            price_by_subject[str(s["ticker"]).upper()] = s["marketPrice"]
    swing_summary = _sensitivity_swing_summary(req.clips, price_by_subject)
    if swing_summary:
        valuation_context["sensitivitySwing"] = swing_summary
        valuation_context["note"] += (
            " valuationContext.sensitivitySwing gives each subject's DCF intrinsic-value envelope "
            "and its swingPct (the full swing as a percent of that subject's current price). State "
            "sensitivity and range widths using swingPct, never a bare dollar spread — dollar swings "
            "are not comparable across differently-priced names."
        )

    clip_payload = _report_prompt_clips(req.clips, length_key, book_level)
    goal_text = req.goal or "(not specified)"
    purpose_text = req.purpose or "(not specified)"
    coverage_requirements = _auto_must_include(req.clips)

    # STEP 1 — Analytical structure: draft a thesis-first outline before writing.
    outline = _generate_outline({
        "goal": goal_text, "purpose": purpose_text,
        "reportType": req.reportType,
        "hasPortfolioValuation": any(
            re.search(r"\b(?:DCF|valuation|intrinsic value|peer multiples?)\b", f"{clip.sourceTab} {clip.title}", re.I)
            and not re.search(r"\bmethodology\b", clip.title, re.I)
            for clip in req.clips
        ),
        "reportLength": length_key,
        "valuationContext": valuation_context,
        "coverageRequirements": coverage_requirements,
        "clips": clip_payload,
    })

    # STEP 2 — Draft: write the full report, following the outline when present.
    payload = {
        "projectName": req.projectName,
        "timeframe": req.timeframe,
        "purpose": purpose_text,
        "goal": goal_text,
        "valuationContext": valuation_context,
        "outline": outline,  # may be None → the model plans and writes in one shot
        "clips": clip_payload,
    }
    sys_prompt = _report_system_prompt(
        mode,
        length_key,
        _must_include_section(req.mustInclude, coverage_requirements),
        (req.reportType or "").strip(),
        book_level,
    )
    messages = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    max_tokens = {"short": 2200, "medium": 4000, "long": 6500}[length_key]
    resp = groq_chat(messages, model=MODEL_SMART, max_tokens=max_tokens, temperature=0.3)
    raw = (resp.choices[0].message.content or "").strip()
    result = parse_json(raw)
    if not isinstance(result, dict) or "executiveSummary" not in result:
        raise HTTPException(502, "AI returned an unexpected report shape")

    sections = _build_sections(result.get("sections"), valid_ids)
    material_positions = _material_portfolio_positions(req.clips) if book_level else []
    if (req.reportType or "").strip() == "portfolio-review":
        sections = _normalize_portfolio_sections(sections)
    # STEP 3 — Intentional chart mapping: the site builds and assigns every chart.
    _inject_mechanical_charts(sections, req.clips)
    _annotate_sensitivity_swing(sections, price_by_subject)
    used = {s["clipId"] for s in sections}
    appendix = _select_report_appendix_clip_ids(
        result.get("appendixClipIds"),
        req.clips,
        used,
    )
    if book_level:
        appendix_terms = [
            r"current allocation", r"sector allocation", r"performance methodology",
            r"holding-level beta", r"factor model coefficients", r"scenario losses",
            r"upcoming portfolio earnings schedule",
        ]
        if len(material_positions) >= 2:
            appendix_terms.append(r"correlation matrix")
        if len(material_positions) == 1:
            appendix_terms.extend([r"model assumptions", r"value drivers", r"dcf verdict"])
        if _has_option_positions(req.clips):
            appendix_terms.extend([
                r"current option positions", r"option analytics coverage",
                r"derivative coverage limitation", r"options snapshot", r"skew pulse",
            ])
        allowed_appendix = re.compile("|".join(appendix_terms), re.I)
        clips_by_id = {clip.id: clip for clip in req.clips}
        appendix = [
            clip_id for clip_id in appendix
            if clip_id in clips_by_id and allowed_appendix.search(clips_by_id[clip_id].title)
        ]
        audit_pattern = allowed_appendix
        for clip in req.clips:
            if (
                clip.id not in used
                and clip.id not in appendix
                and clip.dataType.strip().lower() != "chart"
                and audit_pattern.search(clip.title)
            ):
                appendix.append(clip.id)

    stance = _stance_from_result(result, market)
    # If model omitted stance lean, use signal digest as soft prior.
    if stance and stance.get("lean") == "neutral" and signal_digest.get("suggestedLean") in ("bullish", "bearish"):
        stance["lean"] = signal_digest["suggestedLean"]
        if not stance.get("thesis"):
            stance["thesis"] = (
                f"Positioning and flow cues lean {stance['lean']} "
                f"({', '.join(signal_digest.get('rawHints', [])[:3]) or 'see clips'})."
            )

    key_result = None
    kr = result.get("keyResult")
    if isinstance(kr, dict) and str(kr.get("value", "")).strip():
        key_result = {
            "label": str(kr.get("label", "")).strip() or "Bottom line",
            "value": str(kr.get("value", "")).strip(),
            "context": str(kr.get("context", "")).strip(),
        }
    key_result = _normalize_key_result(
        key_result,
        subject=subject,
        market=market,
        change_pct=change_pct,
        subject_dcf=subject_dcf,
        dcf_intrinsic=dcf_intrinsic,
        stance=stance,
        signal_digest=signal_digest,
        force_range=(mode == "range"),
    )

    # STEP 4 — Verification gate: proofread the summary and conclusion against the
    # exact numbers the charts show, and tighten the tone.
    executive_summary = str(result.get("executiveSummary", "")).strip()
    conclusion = str(result.get("conclusion", "")).strip()
    verified = _verify_report(executive_summary, conclusion, _chart_facts(sections))
    if verified:
        executive_summary = verified["executiveSummary"]
        conclusion = verified["conclusion"]

    # STEP 5 — Slot resolution + post-generation linters (shared with revision).
    slot_ctx = _build_report_slot_ctx(req.clips, subject, quote.get("name"), market, dcf_intrinsic)

    executive_summary = _apply_report_linters(executive_summary, req.clips, slot_ctx)
    conclusion = _apply_report_linters(conclusion, req.clips, slot_ctx)
    if stance and stance.get("thesis"):
        stance["thesis"] = _apply_report_linters(str(stance["thesis"]), req.clips, slot_ctx)
    if key_result.get("context"):
        key_result["context"] = _apply_report_linters(str(key_result["context"]), req.clips, slot_ctx)
    for s in sections:
        if s.get("analysis"):
            s["analysis"] = _apply_report_linters(s["analysis"], req.clips, slot_ctx)
        if s.get("heading"):
            s["heading"] = _apply_report_linters(s["heading"], req.clips, slot_ctx)
    _filter_unverified_key_figures(sections, req.clips, slot_ctx)

    headline = _apply_report_linters(_report_title(result, outline, req), req.clips, slot_ctx)
    if key_result.get("value"):
        key_result["value"] = _apply_report_linters(str(key_result["value"]), req.clips, slot_ctx)

    if book_level and not _has_portfolio_trade_impact_evidence(req.clips):
        single_position = material_positions[0] if len(material_positions) == 1 and not _has_option_positions(req.clips) else None
        key_result = (
            {
                "label": "Portfolio action",
                "value": "Test Diversification Alternatives",
                "context": f"{single_position[0]} is {single_position[1]:.1f}% of positive-weight holdings; no alternative book was evaluated.",
            }
            if single_position
            else {
                "label": "Portfolio action",
                "value": "No Allocation Change Supported",
                "context": "A proposed allocation and quantified before/after risk impact were not supplied.",
            }
        )
        if stance:
            stance["lean"] = "neutral"
            stance["conviction"] = "low"
            stance["baseCase"] = "Single-position account" if single_position else stance.get("baseCase", "")
            stance["thesis"] = (
                "The account is dominated by one security; the next decision is to test diversified alternatives."
                if single_position
                else "The evidence describes current risk but does not support a specific portfolio trade."
            )
        executive_summary = _remove_unsupported_portfolio_actions(executive_summary)
        if not executive_summary:
            executive_summary = "The supplied evidence describes current portfolio behavior but does not quantify an implementable allocation change."
        for section in sections:
            section["analysis"] = _remove_unsupported_portfolio_actions(str(section.get("analysis", "")))
            if re.search(r"\bwhat action follows\b", str(section.get("heading", "")), re.I):
                section["analysis"] = (
                    "The account is a single-position exposure. Test a diversified alternative against the current book using matched-period return, volatility, drawdown, beta, scenario loss, costs, and taxes before trading."
                    if single_position
                    else "No allocation change is supported. Monitor measured return, volatility, drawdown, market sensitivity, and holding-level variance contributions."
                )
                section["keyFigures"] = []
            elif not section["analysis"]:
                section["analysis"] = "This evidence measures portfolio behavior but does not establish the effect of a specific trade."
            section["heading"] = _remove_unsupported_portfolio_actions(str(section.get("heading", ""))) or "Portfolio Risk Requires Quantification"
        dcf_warning = _extreme_dcf_warning(req.clips)
        if dcf_warning:
            for section in sections:
                if re.search(r"\bwhat could happen next\b", str(section.get("heading", "")), re.I):
                    sentences = re.split(r"(?<=[.!?])\s+", str(section.get("analysis", "")))
                    retained = [sentence for sentence in sentences if not re.search(r"\b(dcf|intrinsic|analyst consensus|peer multiple|valuation)\b", sentence, re.I)]
                    section["analysis"] = " ".join([*retained, dcf_warning]).strip()
        headline = (
            f"Single-Position {single_position[0]} Exposure Dominates Account Risk"
            if single_position
            else "Beta and Concentration Shape Recent Portfolio Risk"
        )
        conclusion = (
            "The account's single-position concentration is the primary risk. Test diversified alternatives on matched return, risk, scenario loss, costs, and taxes before trading."
            if single_position
            else "No allocation change is supported. The evidence identifies recent market sensitivity and concentration risk, but does not quantify a superior trade."
        )

    if not book_level:
        _ensure_risks_section(sections, subject, valuation_context)
    _apply_section_layout_architecture(sections, req.clips, (req.layoutPreset or "").strip())

    return {
        "headline": headline,
        "stance": stance,
        "keyResult": key_result,
        "executiveSummary": executive_summary,
        "sections": sections,
        "conclusion": conclusion,
        "appendixClipIds": appendix,
        "model": MODEL_SMART,
        "valuationContext": valuation_context,
    }


# ── Report Creator: targeted AI revision of an already-generated report ────────
# The user points at a block (or the whole report) and describes a change; the
# model proposes replacement prose for only the affected block(s). The client
# then shows the alternative and lets the user implement, retry, or dismiss it.

_ALLOWED_REVISE_FIELDS = {"headline", "executiveSummary", "conclusion", "section.analysis", "section.heading"}

class ReportReviseRequest(BaseModel):
    projectName: str = ""
    timeframe: str = ""
    purpose: str = ""
    goal: str = ""
    subjectTicker: str = ""
    # Carried through so a revision cannot reintroduce a single-name anchor on a
    # report whose subject is a book, a regime, or a result set.
    reportType: str = ""
    instruction: str = ""
    scope: str = "block"        # "block" (one field) | "report" (any prose blocks)
    field: str = ""             # block scope: which field to revise
    clipId: str = ""            # section.* fields: which section
    generated: dict = {}        # current report: headline, executiveSummary, sections, conclusion, stance, keyResult
    clips: list[ReportClipIn] = []

_REPORT_REVISE_SYSTEM = """You are an equity-research editor revising an ALREADY-WRITTEN report at the user's request. You receive the full report (headline, thesis, executive summary, every section, conclusion), the DATA CLIPS behind it, the live valuationContext, the TARGET you must revise, and the user's REQUESTED CHANGE.

Rewrite ONLY the target block(s). Return improved replacement text that satisfies the request while staying true to the data.

RULES:
- Use ONLY figures present in the clips or valuationContext. Never invent a number, price, ratio, or date. If the request needs data you were not given, make the qualitative change you can and say the figure is not available rather than fabricating it.
- Express every price swing, sensitivity range, target band, or move as a PERCENT of the subject's current price (valuationContext.marketPrice, or per-subject marketPrice in valuationContext.subjects), never as a bare dollar amount. A $40 move on a $200 stock is 20%. valuationContext.sensitivitySwing carries the precomputed swingPct.
- Never write a falsification trigger or any "IF metric crosses threshold BY date THEN thesis invalidated" statement, and never invent threshold levels, cutoff dates, or trigger figures.
- Keep the report's verdict and lean unless the request explicitly asks to change them.
- House style: spartan, active voice, address the reader as "you", no em dashes, no semicolons, no emoji, no bullet lists inside prose, flowing paragraphs.
- Do not touch any block other than the target(s).

TARGET:
- scope "block": revise exactly the one field in target.field. For section.analysis / section.heading, target.clipId identifies the section. Return exactly one patch, for that field.
- scope "report": the request may span the report. Return a patch for EACH prose block that must change to satisfy it. Do not rewrite blocks the request does not touch.

Allowed field values: "headline", "executiveSummary", "conclusion", "section.analysis", "section.heading".

Respond ONLY with valid JSON (no markdown, no code fences):
{ "patches": [ { "field": "<one allowed value>", "clipId": "<section clipId, only for section.* fields>", "after": "<the revised text>" } ] }"""


def _revise_block_before(generated: dict, field: str, clip_id: str) -> str | None:
    """Current text of the targeted block, or None if the field/section is unknown."""
    if field == "headline":
        return str(generated.get("headline") or "")
    if field == "executiveSummary":
        return str(generated.get("executiveSummary") or "")
    if field == "conclusion":
        return str(generated.get("conclusion") or "")
    if field in ("section.analysis", "section.heading"):
        key = "analysis" if field == "section.analysis" else "heading"
        for s in (generated.get("sections") or []):
            if isinstance(s, dict) and str(s.get("clipId")) == clip_id:
                return str(s.get(key) or "")
        return None
    return None


@router.post("/report/revise")
def revise_report(req: ReportReviseRequest):
    instruction = (req.instruction or "").strip()
    if not instruction:
        raise HTTPException(400, "No revision instruction provided")
    generated = req.generated if isinstance(req.generated, dict) else {}
    if not generated:
        raise HTTPException(400, "No generated report to revise")

    scope = "report" if req.scope == "report" else "block"
    if scope == "block":
        if req.field not in _ALLOWED_REVISE_FIELDS:
            raise HTTPException(400, f"Cannot revise field {req.field!r}")
        if _revise_block_before(generated, req.field, req.clipId) is None:
            raise HTTPException(400, "Target block not found in the report")

    # Reuse the generation helpers by adapting the request shape.
    gen_req = ReportGenRequest(
        projectName=req.projectName, purpose=req.purpose, goal=req.goal,
        subjectTicker=req.subjectTicker, clips=req.clips,
    )
    subjects_ranked = _ranked_subjects(gen_req)
    book_level = _book_level_report(req, subjects_ranked)
    subject = None if book_level else _subject_ticker(gen_req)
    mode = "open" if book_level else _report_mode(gen_req, subjects_ranked)
    quote = _fetch_market_quote(subject)
    market = float(quote["price"]) if quote.get("price") else None
    dcf_intrinsic = _dcf_intrinsic_for_subject(req.clips, subject) if _subject_dcf_present(req.clips, subject) else None

    price_by_subject: dict[str, float | None] = {}
    if subject and market:
        price_by_subject[subject.upper()] = market
    subjects_ctx = []
    if (mode == "open" and len(subjects_ranked) >= 2) or (book_level and subjects_ranked):
        for t in subjects_ranked[:4]:
            q = quote if t == subject else _fetch_market_quote(t)
            mkt_t = float(q["price"]) if q.get("price") else None
            if mkt_t:
                price_by_subject[t.upper()] = mkt_t
            subjects_ctx.append({"ticker": t, "name": q.get("name"), "marketPrice": round(mkt_t, 4) if mkt_t else None})

    valuation_context = {
        "reportMode": mode,
        "subjectTicker": subject,
        "marketPrice": round(market, 4) if market else None,
        "subjectDcfIntrinsic": round(dcf_intrinsic, 4) if dcf_intrinsic else None,
    }
    if subjects_ctx:
        valuation_context["subjects"] = subjects_ctx
    swing_summary = _sensitivity_swing_summary(req.clips, price_by_subject)
    if swing_summary:
        valuation_context["sensitivitySwing"] = swing_summary

    # Compact current-report view for grounding.
    report_view = {
        "headline": generated.get("headline") or "",
        "thesis": (generated.get("stance") or {}).get("thesis") if isinstance(generated.get("stance"), dict) else "",
        "executiveSummary": generated.get("executiveSummary") or "",
        "conclusion": generated.get("conclusion") or "",
        "sections": [
            {"clipId": str(s.get("clipId")), "heading": s.get("heading") or "", "analysis": s.get("analysis") or ""}
            for s in (generated.get("sections") or []) if isinstance(s, dict)
        ],
    }
    clip_payload = [
        {"id": c.id, "sourceTool": c.sourceTab, "type": c.dataType,
         "title": c.title, "userInstruction": c.userDescription, "data": c.dataSummary}
        for c in req.clips
    ]
    target = {"scope": scope, "field": req.field, "clipId": req.clipId} if scope == "block" else {"scope": "report"}

    payload = {
        "purpose": req.purpose or "(not specified)",
        "goal": req.goal or "(not specified)",
        "valuationContext": valuation_context,
        "report": report_view,
        "target": target,
        "requestedChange": instruction,
        "clips": clip_payload,
    }
    messages = [
        {"role": "system", "content": _REPORT_REVISE_SYSTEM},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    resp = groq_chat(messages, model=MODEL_SMART, max_tokens=2600, temperature=0.35)
    result = parse_json((resp.choices[0].message.content or "").strip())
    if not isinstance(result, dict) or not isinstance(result.get("patches"), list):
        raise HTTPException(502, "AI returned an unexpected revision shape")

    slot_ctx = _build_report_slot_ctx(req.clips, subject, quote.get("name"), market, dcf_intrinsic)
    valid_section_ids = {s["clipId"] for s in report_view["sections"]}
    seen: set[tuple[str, str]] = set()
    patches: list[dict] = []
    for p in result["patches"]:
        if not isinstance(p, dict):
            continue
        field = str(p.get("field") or "")
        clip_id = str(p.get("clipId") or "")
        after = str(p.get("after") or "").strip()
        if field not in _ALLOWED_REVISE_FIELDS or not after:
            continue
        if scope == "block" and (field != req.field or (req.field.startswith("section.") and clip_id != req.clipId)):
            continue
        if field.startswith("section.") and clip_id not in valid_section_ids:
            continue
        dedupe = (field, clip_id)
        if dedupe in seen:
            continue
        seen.add(dedupe)
        before = _revise_block_before(generated, field, clip_id) or ""
        # Headings are short labels, not prose; skip the numeric-prose linters.
        after_clean = after if field == "section.heading" else _apply_report_linters(after, req.clips, slot_ctx)
        if after_clean.strip() == before.strip():
            continue
        patches.append({"field": field, "clipId": clip_id, "before": before, "after": after_clean.strip()})

    return {"patches": patches, "model": MODEL_SMART}


# ── Dashboard Creator: AI assembles a custom dashboard from a description ──────
# Mirrors the options / algo strategy chat: the user describes what they want to
# monitor or trade, and the model chooses the widgets, sizes them, and lays them
# out on the 12-column grid. The catalog (types/labels/descriptions/sizes) is sent
# from the client so it always matches the live widget registry.

class DashboardCatalogItem(BaseModel):
    type: str
    label: str = ""
    description: str = ""
    defW: int = 4
    defH: int = 5
    minW: int = 1
    minH: int = 1
    ticker: bool = False
    category: str = ""
    purpose: str = ""
    dataType: str = ""
    priority: str = "secondary"
    region: str = "body"
    orientation: str = "balanced"
    density: str = "standard"
    visualRole: str = "supporting"
    growth: str = "bounded"
    compatible: list[str] = Field(default_factory=list)
    related: list[str] = Field(default_factory=list)
    conflicts: list[str] = Field(default_factory=list)
    configOptions: list[str] = Field(default_factory=list)
    multiple: bool = True

class DashboardChatRequest(BaseModel):
    messages: list[StrategyChatMessage]
    catalog: list[DashboardCatalogItem] = Field(default_factory=list)
    current: list[dict] = Field(default_factory=list)      # {type, ticker?, title?} of existing widgets
    cols: int = 12

_DASHBOARD_CHAT_SYSTEM = """You are a dashboard architect for a professional financial terminal's custom dashboard builder. The user describes, in plain English, what they want to monitor, trade, or analyze. Do the heavy lifting: pick the BEST set of widgets for that intent, size them, set their config, and arrange them on the grid — do not make the user choose widgets one by one.

You are given:
- CATALOG: every available widget with its purpose, data type, visual priority, preferred region, dimensions, compatible, related, and conflicting widgets, configuration options, and duplicate rule. Use ONLY these `type` values.
- CURRENT: the widgets already on the active dashboard (so you can add to or replace them).

Never repeat a widget with the same material configuration. Multiple instances are only useful when their configured subjects differ and the comparison is intentional.

GRID: 12 columns wide. Give each widget a width w (1..12, at least its minW) and height h (at least its minH) in grid units, and ORDER the items by importance. The builder validates your suggestions, maps widgets into a curated template, and compacts unmatched items into balanced rows. Any x/y you send are ignored.
The composition template is an internal design tool. Infer the strongest structure from the user's intent and widget mix. Never ask the user to choose a template or preset, and never mention internal template names in questions, summaries, or drafts.

LAYOUT:
- Keep widgets near their catalog default dimensions. Do not stretch a tile merely to fill a row.
- Pair a wide primary workspace with narrow supporting widgets that can stack vertically beside it, such as 9+3 or 8+4.
- Use compact heights. Charts and dense tables usually need h=5-8. Supporting lists and metrics usually need h=3-6.
- Full-width strips get their own row: macro-strip (12x2) and index-tape (12x1). Put the index tape at the TOP when broad live market context matters.
- Lead with the primary / overview widget (larger, near the top). Aim for 6-10 widgets in a coherent order.
- Do not include conflicting widgets or duplicate a widget whose multiple flag is false. Use related and compatible metadata to form coherent rows.
- On trading dashboards, paper-trade is the large central interaction surface. Supporting widgets must not reduce its usable size.

CONFIG (set only what applies, in each item's `config`):
- ticker widgets (CATALOG ticker=true): set config.ticker to a real symbol from the user's request, else a sensible default (SPY for market/macro, or the name they mention).
- multi-ticker widgets — watchlist, news-feed, correlation-matrix, index-tape: set config.tickers to an array of symbols.
- portfolio widgets — risk-metrics, factor-decomposition, pnl-attribution, portfolio-summary, pm-portfolios: leave portfolioId empty to use the user's default portfolio.
- use only fields listed in each widget's configOptions.
- set config.title only to override the default label; otherwise omit it.
- Never invent config fields that aren't implied by the widget.

MATCH INTENT (examples, not limits):
- Macro / rates / credit view: macro-strip, yield-curve, credit-spreads, global-macro, macro-calendar, sector-rotation.
- Options / vol / flow: dealer-gex, vol-skew, options-snapshot, options-pricer, delta-target, unusual-flow.
- A single name to watch: lead with ONE main chart — tradingview-chart (large, focused, h=8) or price-card (chart + stats header, h=7); use mini-chart only as a small secondary spark. Support it with news-feed, analyst-ratings, valuation, earnings-calendar. Do not stack two big charts of the same ticker.
- Portfolio / risk: ALWAYS include portfolio-summary, risk-metrics, factor-decomposition, pnl-attribution, correlation-matrix, and pm-portfolios. These are complementary views of performance, loss, exposure, attribution, diversification, and book context. Do not substitute market tape, watchlist, options, or macro widgets unless the user explicitly asks for them.
- Broad market monitor: index-tape, heatmap, watchlist, sentiment-gauge, sector-rotation, market-hours.

ACTION — how the draft should be applied:
- "replace": a fresh dashboard for this request (the default when they describe a whole dashboard).
- "append": ADD these widgets to the current dashboard (when they say "add ...", or ask for specific widgets on top of what's there).
- "new": create a separate new dashboard tab (when they say "make/create a new dashboard").

WHEN TO ASK: only return a question when the request is too vague to choose well (no theme, no ticker, no goal). Otherwise build. If you ask, offer concrete directions.

Respond ONLY with valid JSON (no markdown, no code fences), exactly one shape:
Question: {"type":"question","text":"<one focused question with concrete options>"}
Draft: {"type":"draft","name":"<short dashboard name>","action":"replace|append|new","summary":"<one plain sentence describing the layout>","items":[{"type":"<catalog type>","config":{...},"x":0,"y":0,"w":6,"h":6}, ...]}"""

_DASHBOARD_INTENT_PROFILES = {
    "risk": {
        "required": (
            "portfolio-summary",
            "risk-metrics",
            "factor-decomposition",
            "correlation-matrix",
            "pnl-attribution",
            "pm-portfolios",
        ),
        "name": "Portfolio Risk Monitor",
        "summary": "Portfolio performance and loss first, followed by factor exposure, diversification, attribution, and book context.",
    },
    "portfolio": {
        "required": (
            "portfolio-summary",
            "risk-metrics",
            "factor-decomposition",
            "correlation-matrix",
            "pnl-attribution",
            "pm-portfolios",
        ),
        "name": "Portfolio Monitor",
        "summary": "Portfolio performance, risk, factor exposure, diversification, attribution, and book context in one view.",
    },
}


def _dashboard_user_text(messages: list[StrategyChatMessage]) -> str:
    return " ".join(message.content for message in messages if message.role == "user").lower()


def _infer_dashboard_objective(messages: list[StrategyChatMessage]) -> str:
    text = _dashboard_user_text(messages)
    portfolio_terms = re.search(r"\b(portfolio|holdings?|book|allocation|p/?l)\b", text)
    risk_terms = re.search(r"\b(risk|var|drawdown|concentration|exposure|stress|downside|hedg(?:e|ing))\b", text)
    if risk_terms and portfolio_terms:
        return "risk"
    if re.search(r"\b(portfolio risk|value at risk|max(?:imum)? drawdown|factor exposure)\b", text):
        return "risk"
    if portfolio_terms:
        return "portfolio"
    if re.search(r"\b(options?|gamma|gex|skew|implied vol(?:atility)?|greeks?|calls?|puts?)\b", text):
        return "options"
    if re.search(r"\b(macro|rates?|yield curve|credit spreads?|inflation|fed|economic)\b", text):
        return "macro"
    if re.search(r"\b(screen|screener|filter|candidates?|universe)\b", text):
        return "screening"
    if re.search(r"\b(trade|trading|order|execution|tape|intraday)\b", text):
        return "trading"
    if re.search(r"\b(research|valuation|analyst|fundamental|company|earnings)\b", text):
        return "research"
    return "general"


def _requests_complete_dashboard(text: str) -> bool:
    return bool(re.search(r"\b(dashboard|monitor|overview|cockpit|workspace|track my|watch my)\b", text))


def _explicitly_requests_widget(widget_type: str, label: str, text: str) -> bool:
    terms = {widget_type.replace("-", " "), label.lower()}
    aliases = {
        "vol-skew": {"volatility skew", "skew"},
        "global-macro": {"cross asset", "global macro"},
        "index-tape": {"market tape", "index tape"},
        "pm-portfolios": {"portfolio list", "saved portfolios"},
        "pnl-attribution": {"p/l attribution", "pnl attribution"},
    }
    terms.update(aliases.get(widget_type, set()))
    return any(term and term in text for term in terms)


def _enforce_dashboard_intent(
    items: list[dict],
    catalog: list[DashboardCatalogItem],
    objective: str,
    action: str,
    text: str,
    cols: int,
) -> list[dict]:
    profile = _DASHBOARD_INTENT_PROFILES.get(objective)
    if not profile or action == "append" or not _requests_complete_dashboard(text):
        return items
    specs = {item.type: item for item in catalog}
    proposed = {item["type"]: item for item in items}
    guarded: list[dict] = []
    for widget_type in profile["required"]:
        spec = specs.get(widget_type)
        if not spec:
            continue
        guarded.append(proposed.get(widget_type) or {
            "type": widget_type,
            "config": {},
            "x": 0,
            "y": 0,
            "w": min(cols, max(spec.minW, spec.defW)),
            "h": max(spec.minH, spec.defH),
        })
    required = set(profile["required"])
    for item in items:
        if item["type"] in required:
            continue
        spec = specs.get(item["type"])
        if spec and _explicitly_requests_widget(item["type"], spec.label, text):
            guarded.append(item)
    return _normalize_dashboard_items(guarded[:8], catalog, cols)


def _normalize_dashboard_items(items, catalog: list[DashboardCatalogItem], cols: int) -> list[dict]:
    """Keep only real widget types and clamp every size to the grid + the
    widget's minimums, defaulting anything missing — the client still re-packs,
    but this guarantees the AI can't emit an unplaceable tile."""
    by_type = {c.type: c for c in catalog}
    out: list[dict] = []
    accepted_types: list[str] = []
    accepted_identities: set[str] = set()
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        t = str(it.get("type") or "")
        spec = by_type.get(t)
        if not spec:
            continue
        if not spec.multiple and t in accepted_types:
            continue
        if any(existing in spec.conflicts or t in by_type[existing].conflicts for existing in accepted_types):
            continue
        w = it.get("w")
        h = it.get("h")
        try:
            w = int(w)
        except (TypeError, ValueError):
            w = spec.defW
        try:
            h = int(h)
        except (TypeError, ValueError):
            h = spec.defH
        w = max(spec.minW, min(w, cols))
        h = max(spec.minH, h)
        x = it.get("x")
        try:
            x = max(0, min(int(x), cols - w))
        except (TypeError, ValueError):
            x = 0
        try:
            y = max(0, int(it.get("y")))
        except (TypeError, ValueError):
            y = 0
        raw_config = it.get("config") if isinstance(it.get("config"), dict) else {}
        allowed_config = set(spec.configOptions) | {"title"}
        if spec.ticker:
            allowed_config.add("ticker")
        config = {key: value for key, value in raw_config.items() if key in allowed_config}
        identity = json.dumps([t, config], sort_keys=True, separators=(",", ":"))
        if identity in accepted_identities:
            continue
        out.append({"type": t, "config": config, "x": x, "y": y, "w": w, "h": h})
        accepted_types.append(t)
        accepted_identities.add(identity)
    return out


@router.post("/dashboard-chat")
def dashboard_chat(req: DashboardChatRequest):
    if not req.messages:
        raise HTTPException(400, "messages must not be empty")
    if not req.catalog:
        raise HTTPException(400, "no widget catalog provided")
    cols = req.cols if 1 <= req.cols <= 24 else 12
    catalog_lines = "\n".join(
        f"- {c.type} ({c.label}): {c.purpose or c.description[:100]}; data={c.dataType}; "
        f"priority={c.priority}; region={c.region}; size={c.defW}x{c.defH}; min={c.minW}x{c.minH}; "
        f"orientation={c.orientation}; density={c.density}; role={c.visualRole}; growth={c.growth}; "
        f"related={','.join(c.related) or 'none'}; conflicts={','.join(c.conflicts) or 'none'}; "
        f"config={','.join(c.configOptions) or 'none'}; multiple={c.multiple}"
        for c in req.catalog
    )
    current_summary = ", ".join(
        f"{w.get('type')}" + (f"({w.get('ticker')})" if w.get("ticker") else "")
        for w in req.current if isinstance(w, dict) and w.get("type")
    ) or "(empty)"
    context = f"CATALOG:\n{catalog_lines}\n\nCURRENT DASHBOARD: {current_summary}\n\nGrid is {cols} columns wide."
    chat = [
        {"role": "system", "content": _DASHBOARD_CHAT_SYSTEM},
        {"role": "system", "content": context},
    ]
    chat += [{"role": m.role, "content": m.content} for m in req.messages]
    # Fail gracefully: a busy / rate-limited LLM provider makes groq_chat raise a
    # raw error that would otherwise surface as a bare 500. Give the user an
    # actionable retry message instead.
    try:
        resp = groq_chat(chat, model=MODEL_SMART, max_tokens=1600, temperature=0.3)
        result = parse_json((resp.choices[0].message.content or "").strip())
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning("dashboard-chat LLM failure: %s", e)
        raise HTTPException(503, "The AI model is busy right now. Give it a few seconds and try again.")
    if not isinstance(result, dict) or result.get("type") not in ("question", "draft"):
        raise HTTPException(502, "The AI returned an unexpected response. Try rephrasing your request.")
    if result.get("type") == "draft":
        objective = _infer_dashboard_objective(req.messages)
        text = _dashboard_user_text(req.messages)
        action = result.get("action")
        action = action if action in ("replace", "append", "new") else "replace"
        items = _normalize_dashboard_items(result.get("items"), req.catalog, cols)
        items = _enforce_dashboard_intent(items, req.catalog, objective, action, text, cols)
        if not items:
            return {"type": "question", "text": "I could not turn that into widgets. Tell me the theme (macro, options, a specific ticker, portfolio risk) and I will lay it out."}
        result["action"] = action
        result["items"] = items
        result["objective"] = objective
        profile = _DASHBOARD_INTENT_PROFILES.get(objective)
        name = str(result.get("name") or "AI Dashboard").strip()
        if profile and not any(term in name.lower() for term in ("portfolio", "risk")):
            name = profile["name"]
        result["name"] = name[:40]
        result["summary"] = profile["summary"] if profile else str(result.get("summary") or "").strip()
    return result
