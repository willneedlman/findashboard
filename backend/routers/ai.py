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
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from cachetools import TTLCache
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ai_client import groq_complete, groq_chat, parse_json, MODEL_FAST, MODEL_SMART
from routers.screener import ScreenRequest, run_screen
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
    query: str

_SCREENER_SYSTEM = """Convert the stock screener query into structured filter rules.

Available field IDs and their units:
marketCap (billions), peRatio (ratio), forwardPE (ratio), pbRatio (ratio),
psRatio (ratio), evEbitda (ratio), grossMargin (%), operatingMargin (%),
netMargin (%), roe (%), revenueGrowth (%), epsGrowth (%),
debtEquity (ratio), currentRatio (ratio), dividendYield (%), beta (ratio),
change52wHiPct (%, negative means below 52w high)

Operators: gt (>), gte (>=), lt (<), lte (<=), between (range, needs value2)

Sectors: Technology, Healthcare, Financials, Consumer Cyclical, Communication Services,
Industrials, Consumer Defensive, Energy, Utilities, Real Estate, Basic Materials

Respond ONLY with valid JSON (no markdown):
{
  "filters": [
    {"field": "fieldId", "operator": "gt", "value": 0.0, "value2": null}
  ],
  "sector": "SectorName or null",
  "explanation": "one sentence describing what this screen finds"
}"""

@router.post("/screener-parse")
def screener_parse(req: ScreenerParseRequest):
    raw = groq_complete(f'Query: "{req.query}"', max_tokens=400,
                        model=MODEL_FAST, system=_SCREENER_SYSTEM)
    return parse_json(raw)


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

DO THE HEAVY LIFTING:
- Propose a complete strategy structure immediately as a recommendation. Do not interrogate the user for strikes, expirations, or legs.
- If you need clarification, present a concrete choice of options structures (e.g., "To capture a bullish move on AAPL, we can either buy a 30-day Long Call for high leverage, or buy a Bull Call Spread to lower our cost basis. Which style do you prefer?").
- If the user's intent is clear, output a complete DRAFT immediately, using standard institutional parameters as defaults.

LEG SCHEMA:
Each leg in the "legs" array must match this schema:
{
  "option_type": "call" | "put",
  "action": "buy" | "sell",
  "K": number,          // Strike price. Centered around a spot base of 100 if relative (e.g. 95/105 spread), or absolute values if specifically requested.
  "premium": number,    // Estimated premium price per contract (default to 2.0 or a sensible number).
  "quantity": number,   // Contract quantity (default to 1).
  "ticker": string,     // The underlying ticker symbol (e.g., "SPY"). Default to "SPY" if not specified.
  "expiry": string      // Expiration date in "YYYY-MM-DD" format. Default to a date approximately 30 to 60 days from now (use 2026-08-15 as a placeholder if not specified).
}

RESPONSE SHAPES:
Every response must be valid JSON in exactly one of these shapes:
Question: {"type": "question", "text": "<your expert recommendation and options play proposal, plain English>"}
Draft: {
  "type": "draft",
  "name": "<strategy name, e.g. Iron Condor>",
  "legs": [Leg, ...],
  "summary": "<one plain-English sentence summarizing the structure, e.g., 'Sell 90/110 strangle on SPY expiring 2026-08-15 for a net credit.'>"
}"""

@router.post("/options-strategy-chat")
def options_strategy_chat(req: StrategyChatRequest):
    if not req.messages:
        raise HTTPException(400, "messages must not be empty")
    messages = [{"role": "system", "content": _OPTIONS_STRATEGY_CHAT_SYSTEM}]
    messages += [{"role": m.role, "content": m.content} for m in req.messages]
    resp = groq_chat(messages, model=MODEL_SMART, max_tokens=1200)
    raw = (resp.choices[0].message.content or "").strip()
    result = parse_json(raw)
    if not isinstance(result, dict) or result.get("type") not in ("question", "draft"):
        raise HTTPException(500, "AI returned an unexpected response shape")
    return result


# ── Report Creator: synthesize an analyst report from clipped data ────────────

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
    # Optional explicit subject from the client (wins over text heuristics).
    subjectTicker: str = ""
    clips: list[ReportClipIn]

_REPORT_SYSTEM = """You are a senior investment analyst writing a formal research note for a professional desk. Register: academic, financial, and direct. State conclusions plainly. Support every claim with figures from the clips or valuationContext.

You receive: Purpose, Goal, Timeframe (lookback and/or lookforward), DATA CLIPS (each with id, source tool, title, optional user note, data summary), and valuationContext (live spot, optional day change, optional DCF, signalDigest of directional cues extracted from clips).

Primary job: answer the Goal with a clear stance. When the Goal is a fair value, price target, near-term range, or outlook, keyResult MUST be a dollar range — never "not estimable" and never a vague qualitative-only bottom line when marketPrice is set.

════════════════════════════════════════
STANCE (non-negotiable)
════════════════════════════════════════
- Take a lean: bullish, bearish, or neutral. Neutral is allowed only when directional signals truly cancel or are absent. If call flow, call GEX, and risk-on macro align, do NOT hide behind "range-bound with no edge."
- Conviction: low, moderate, or high. Low conviction still requires a lean and an asymmetric or shifted range that reflects that lean.
- Separate (1) the statistical envelope from options (implied move, vol cone, density percentiles) from (2) your research range. The cone/IV envelope is a constraint on how wide you may go, not the thesis itself. Do not publish a range that is essentially spot ± implied-move or the cone's 15th/85th unless every other clip is empty of directional content.
- Encode stance in the dollars: a bullish lean usually means midpoint above spot and/or more room to the upside than downside (e.g. floor near spot or slightly below, ceiling further out). A bearish lean does the reverse. A truly neutral lean may be tight and near-symmetric — say so explicitly and name the conflicting signals.
- Executive summary and conclusion must each state the lean, the range, and the two or three decisive drivers in plain language. Avoid empty phrases like "modest upside bias" without tying them to a mid above spot or an asymmetric band.

════════════════════════════════════════
INTEGRATE EVERY SUPPLIED CLIP FAMILY
════════════════════════════════════════
Build ONE argument. Each body section must push the range decision forward, not summarize a panel in isolation.
- Dealer GEX / gamma: long gamma + call-heavy GEX supports a floor and mean-reversion toward a flip/zero-gamma level. Call wall / put wall strikes are candidate range edges. State whether dealers dampen or amplify moves in the lean direction.
- Options flow / unusual activity: call vs put premium share, top strikes, vol/OI aggression. Aggressive call buying below or at spot is a bullish tell. Put buying above spot is a hedge or bearish tell. Do not ignore flow when setting the mid.
- IV rank / term / implied move: IV rank high = richer premium, often mean-reverting vol. Implied move sets a hard near-term width budget. Prefer base case inside ~0.5–0.8× one implied-move, with tails out to the cone only if catalysts justify it.
- Implied probability / density: modal strike and P50 are better anchors for "where the market prices the stock" than a flat ±10% band. Skew (put vs call IV) shifts the lean.
- Macro / calendar: scheduled high-impact prints (CPI, FOMC, ECB) raise event vol. They widen the band or cut conviction. They do not by themselves center the range on spot.
- Credit / stress / markets board: risk-on vs risk-off backdrop tilts equity beta names.
- Sentiment: only if the clip has real scores/figures (ignore empty stubs that say no structured panels).
- Company profile / fundamentals: valuation multiples, growth, margin — structural context for whether a premium to spot is justified.
- DCF / multiples / SOTP: structural anchors. Cite gap to spot. Do not paste intrinsic as the range. Use as one vote among positioning and vol.
Ignore pure appendix stubs that contain no figures.

If clips conflict (e.g. bullish GEX vs demanding reverse-DCF growth), name the conflict, weight the horizon (near-term positioning often dominates a 7-day goal, models dominate a 90-day fair-value goal), and still pick a lean with appropriate conviction.

════════════════════════════════════════
HORIZON
════════════════════════════════════════
- Lookback: interpret trends against that history.
- Lookforward: the range and recommendation apply to this window. A 7-day range is a trading corridor, not terminal value. A 90-day range can sit further from spot when models and macro support it.
- Connect both when present.

════════════════════════════════════════
HARD RULES
════════════════════════════════════════
- Use ONLY figures present in clips or valuationContext. Never invent prices, GEX, IV, or dates.
- keyResult.value format: "$A–$B" with A < B. Prefer whole dollars for equities above $20.
- keyResult.context: must include spot, lean, and the main driver stack (e.g. "spot $203 · bullish lean · call GEX + flow · IV envelope caps $218").
- stance object required (see schema).
- Tone and range must agree. Do not claim a strong bullish lean with a mid glued to spot and equal wings.
- No 2×–3× fantasy targets without model support. Keep a short horizon range inside roughly ±25% of spot unless clips justify wider.
- Writing: no em dashes, no semicolons, no emoji, no bullet lists inside prose. Flowing paragraphs. Spartan. No restating Purpose/Goal as labels.
- Curate sections: only clips that advance the thesis. Others → appendixClipIds.
- Prefer chart-type clips as body section clipIds when the same tool also has a KPI or table clip (diagrams lead the note; KPIs become keyFigures). Put redundant KPI-only duplicates in appendixClipIds.
- Every body section needs keyFigures (2–4 real figures from that clip). Keep keyFigures sparse when a chart carries the story.
- Large boards: two to five key figures, not every row.

Respond ONLY with valid JSON (no markdown, no code fences):
{
  "headline": "punchy research-note title, under 12 words, no period",
  "stance": {
    "lean": "bullish" | "bearish" | "neutral",
    "conviction": "low" | "moderate" | "high",
    "baseCase": "$X",
    "thesis": "one sentence: what you believe happens over the lookforward and why"
  },
  "keyResult": {
    "label": "Fair Value Range (TICKER)" or "Near-Term Range (TICKER)",
    "value": "$A–$B",
    "context": "spot $X · lean · decisive drivers"
  },
  "executiveSummary": "one tight paragraph: lean, range, spot, and how GEX/flow/IV/macro/models jointly justify the band (not a list of panel summaries)",
  "sections": [
    {
      "clipId": "<id>",
      "heading": "analytical heading, not the tool name",
      "analysis": "one to three paragraphs linking THIS clip's figures to the lean and to the dollar range (what edge moves, what widens/tightens)",
      "keyFigures": [ { "label": "metric", "value": "figure with units" } ]
    }
  ],
  "conclusion": "restate lean, range, conviction, what would falsify the view, and a concrete action (hold band, buy dips toward floor, fade rallies into ceiling, wait for event)",
  "appendixClipIds": ["<ids not central to the thesis>"]
}
Every clipId must be one of the provided clip ids."""

def _clean_figs(raw) -> list:
    figs = []
    for f in (raw or [])[:6]:
        if isinstance(f, dict):
            label = str(f.get("label", "")).strip()
            value = str(f.get("value", "")).strip()
            if label and value:
                figs.append({"label": label[:60], "value": value[:60]})
    return figs

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

def _subject_ticker(req: ReportGenRequest) -> str | None:
    """Resolve subject equity — scored so 'from NOW' loses to NVDA."""
    # Explicit client override wins.
    explicit = (getattr(req, "subjectTicker", None) or "").strip().upper()
    if explicit and _is_plausible_ticker(explicit):
        return explicit

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
        "baseCase": base[:40],
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
) -> dict | None:
    """Ensure usable keyResult with live spot. Preserve asymmetric, stance-encoding ranges."""
    lean = (stance or {}).get("lean") or "neutral"
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

@router.post("/report")
def generate_report(req: ReportGenRequest):
    if not req.clips:
        raise HTTPException(400, "No clips to synthesize")
    valid_ids = {c.id for c in req.clips}

    subject = _subject_ticker(req)
    dcf_names = sorted(_dcf_tickers_from_clips(req.clips))
    subject_dcf = _subject_dcf_present(req.clips, subject)
    quote = _fetch_market_quote(subject)
    market = float(quote["price"]) if quote.get("price") else None
    change_pct = float(quote["changePct"]) if quote.get("changePct") is not None else None
    dcf_intrinsic = _dcf_intrinsic_for_subject(req.clips, subject) if subject_dcf else None
    signal_digest = _clip_signal_digest(req.clips)

    valuation_context = {
        "subjectTicker": subject,
        "subjectName": quote.get("name"),
        "marketPrice": round(market, 4) if market else None,
        "dayChangePct": round(change_pct, 3) if change_pct is not None else None,
        "priceSource": quote.get("source"),
        "subjectDcfPresent": subject_dcf,
        "subjectDcfIntrinsic": round(dcf_intrinsic, 4) if dcf_intrinsic else None,
        "dcfTickersInClips": dcf_names,
        "signalDigest": signal_digest,
        "note": (
            "marketPrice is LIVE spot — always cite it. "
            "signalDigest summarizes directional cues already in the clips (GEX, call%, IV, cone). "
            "Vol cone and implied move bound WIDTH only. "
            "When signalDigest.suggestedLean is bullish or bearish, the research range must encode that lean "
            "(mid shifted and/or asymmetric wings). Do not publish spot ± impliedMove as the whole thesis. "
            "Integrate every clip family into one argument. "
            "subjectDcfIntrinsic is one input, not the answer."
        ),
    }

    payload = {
        "projectName": req.projectName,
        "timeframe": req.timeframe,
        "purpose": req.purpose or "(not specified)",
        "goal": req.goal or "(not specified)",
        "valuationContext": valuation_context,
        "clips": [
            {"id": c.id, "sourceTool": c.sourceTab, "type": c.dataType,
             "title": c.title, "userInstruction": c.userDescription, "data": c.dataSummary}
            for c in req.clips
        ],
    }
    messages = [
        {"role": "system", "content": _REPORT_SYSTEM},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
    ]
    resp = groq_chat(messages, model=MODEL_SMART, max_tokens=4000, temperature=0.3)
    raw = (resp.choices[0].message.content or "").strip()
    result = parse_json(raw)
    if not isinstance(result, dict) or "executiveSummary" not in result:
        raise HTTPException(502, "AI returned an unexpected report shape")

    sections = []
    for s in result.get("sections") or []:
        if not isinstance(s, dict):
            continue
        cid = str(s.get("clipId", ""))
        analysis = str(s.get("analysis", "")).strip()
        if cid in valid_ids and analysis:
            sections.append({
                "clipId": cid,
                "heading": str(s.get("heading", "")).strip() or "Analysis",
                "analysis": analysis,
                "keyFigures": _clean_figs(s.get("keyFigures")),
            })
    used = {s["clipId"] for s in sections}
    appendix = [cid for cid in (str(x) for x in (result.get("appendixClipIds") or [])) if cid in valid_ids and cid not in used]
    for cid in (c.id for c in req.clips):
        if cid not in used and cid not in appendix:
            appendix.append(cid)

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
    )

    return {
        "headline": str(result.get("headline", "")).strip(),
        "stance": stance,
        "keyResult": key_result,
        "executiveSummary": str(result.get("executiveSummary", "")).strip(),
        "sections": sections,
        "conclusion": str(result.get("conclusion", "")).strip(),
        "appendixClipIds": appendix,
        "model": MODEL_SMART,
        "valuationContext": valuation_context,
    }
