"""
AI assistant router — Groq-powered helpers for DCF, screener NL, corporate brief,
strategy narrative, backtest commentary, bond narrative, and screener fallback.
"""
import logging
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from ai_client import groq_complete, parse_json

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

@router.post("/dcf-assumptions")
def dcf_assumptions(req: DCFAssumptionsRequest):
    prompt = f"""You are a financial analyst. Given these current fundamentals for {req.ticker}:
- TTM Revenue: ${req.revenue:,.0f}M
- Current Operating Margin: {req.op_margin:.1f}%
- Recent Revenue Growth: {req.rev_growth:.1f}%
- Beta: {req.beta:.2f}
- Sector: {req.sector or "unknown"}
- Current WACC estimate: {req.wacc:.1f}%

Suggest realistic 10-year DCF model assumptions. Consider the sector, growth stage, and competitive position.
Respond ONLY with valid JSON (no markdown):
{{
  "rev_growth_1": <yr 1-3 annual growth %, float>,
  "rev_growth_2": <yr 4-7 annual growth %, float>,
  "rev_growth_3": <yr 8-10 annual growth %, float>,
  "target_margin": <yr 10 operating margin %, float>,
  "wacc": <suggested WACC %, float>,
  "terminal_growth": <terminal growth rate %, float, typically 2-3>,
  "rationale": {{
    "growth": "one sentence on growth trajectory",
    "margin": "one sentence on margin expansion thesis",
    "wacc": "one sentence on discount rate reasoning"
  }}
}}"""
    raw = groq_complete(prompt, max_tokens=450)
    return parse_json(raw)


# ── 2. Screener natural-language parser ───────────────────────────────────────

class ScreenerParseRequest(BaseModel):
    query: str

@router.post("/screener-parse")
def screener_parse(req: ScreenerParseRequest):
    prompt = f"""Convert this stock screener query into structured filter rules.
Query: "{req.query}"

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
{{
  "filters": [
    {{"field": "fieldId", "operator": "gt", "value": 0.0, "value2": null}}
  ],
  "sector": "SectorName or null",
  "explanation": "one sentence describing what this screen finds"
}}"""
    raw = groq_complete(prompt, max_tokens=400)
    return parse_json(raw)


# ── 4. Corporate hub brief ────────────────────────────────────────────────────

class CorporateBriefRequest(BaseModel):
    tickers: list[str]
    rows: list[dict] = []

@router.post("/corporate-brief")
def corporate_brief(req: CorporateBriefRequest):
    summaries = []
    for row in req.rows[:5]:
        tk = row.get("ticker", "")
        news = " | ".join(n.get("title", "") for n in row.get("news", [])[:2])
        summaries.append(
            f"{tk}: change={row.get('pctChange','N/A')}% mcap={row.get('marketCap','N/A')} "
            f"consensus={row.get('consensus','N/A')} pe={row.get('pe','N/A')} news=[{news}]"
        )
    tickers_str = ", ".join(req.tickers)
    context = "\n".join(summaries) or tickers_str

    prompt = f"""Write a concise 3-bullet terminal intelligence brief for: {tickers_str}

Available data:
{context}

Respond ONLY with valid JSON (no markdown):
{{
  "bullets": [
    "bullet covering price action or key catalyst",
    "bullet covering valuation or analyst sentiment",
    "bullet covering risk or macro context"
  ],
  "tone": "bullish|neutral|bearish|mixed"
}}"""
    raw = groq_complete(prompt, max_tokens=300)
    return parse_json(raw)


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

@router.post("/bond-narrative")
def bond_narrative(req: BondNarrativeRequest):
    prompt = f"""Provide a concise fixed-income analysis:
- Bond type: {req.bond_type}
- Coupon: {req.coupon_rate}%  Maturity: {req.maturity} years
- Market Price: ${req.market_price:.2f}  Face: ${req.face:.0f}
- YTM: {req.ytm}%  Modified Duration: {req.mod_duration}  Convexity: {req.convexity}

Respond ONLY with valid JSON (no markdown):
{{
  "summary": "2-sentence plain-English assessment of this bond's positioning",
  "rate_sensitivity": "one sentence: how a 100bps rate move affects this bond given its duration",
  "yield_context": "one sentence comparing this YTM to typical investment-grade or treasury levels",
  "investor_fit": "one sentence on what investor profile suits this bond"
}}"""
    raw = groq_complete(prompt, max_tokens=300)
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
