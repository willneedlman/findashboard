"""
AI assistant router — Groq-powered helpers for DCF, screener NL, corporate brief,
strategy narrative, backtest commentary, bond narrative, screener fallback, and
the Algo Strategy Builder's describe-in-English chat.
"""
import logging
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ai_client import groq_complete, groq_chat, parse_json, MODEL_FAST, MODEL_SMART

logger = logging.getLogger(__name__)
router = APIRouter()


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
1. Mode: "single" (single asset backtest) or "portfolio" (multiple assets with weights).
2. Sizing / Weights: position weights (weight_pct) or risk sizing (sizingPct).
3. Underlyings: tickers (e.g. AAPL, SPY, SVXY).
4. Instrument Type: Shares (underlying), options (call/put), or combo options (multi-leg, e.g. selling straddles/strangles/condors/spreads).
5. Expiry DTE: Days to expiration.
6. Option Legs: custom strikes (moneyness multiplier), action (buy/sell), type (call/put), qty.
7. Custom Strategy Rules: custom buy/sell indicator rules and risk parameters (just like the standalone custom strategy rules).

COGNITIVE TASK:
- If the user's request is ambiguous or lacks detail, respond with a question (type: "question") proposing specific options.
- If the intent is clear, immediately output a complete configuration DRAFT (type: "draft") utilizing standard professional defaults. Do not make the user configure the details.

JSON RESPONSE SHAPES:
Every response must be valid JSON in exactly one of these shapes:
1. Question: {"type": "question", "text": "<plain-English response/question>"}
2. Draft:
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
      "weight_pct": number,         // sizing weight %
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
StrategyRisk = {"sizingPct": number, "stopLossPct": number, "takeProfitPct": number, "trailingStopPct": number, "maxHoldBars": number}
IndicatorRef = {"type": "PRICE"|"RSI"|"SMA"|"EMA"|"MACD_LINE"|"MACD_SIGNAL"|"BB_UPPER"|"BB_MID"|"BB_LOWER"|"ATR"|"MOMENTUM"|"PCT_CHANGE"|"OPT_HV"|"OPT_IVRANK", "period"?: number, "fast"?: number, "slow"?: number, "signal_period"?: number, "std"?: number, "ticker"?: string, "timeframe"?: string}

MONEYNESS RULES:
- In option legs, moneyness is the strike ratio (strike / spot). E.g., a call at spot is 1.0; a call 5% OTM is 1.05; a put 5% OTM is 0.95.
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
    sys_prompt = _STRATEGY_CHAT_FULL_SYSTEM if req.scope == "full" else _STRATEGY_CHAT_SYSTEM
    messages = [{"role": "system", "content": sys_prompt}]
    messages += [{"role": m.role, "content": m.content} for m in req.messages]
    resp = groq_chat(messages, model=MODEL_SMART, max_tokens=1500)
    raw = (resp.choices[0].message.content or "").strip()
    result = parse_json(raw)
    if not isinstance(result, dict) or result.get("type") not in ("question", "draft"):
        raise HTTPException(500, "AI returned an unexpected response shape")
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

