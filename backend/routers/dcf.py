import logging
logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fmp
import damodaran
from cache import get_info
from validation import validate_ticker

router = APIRouter()


class DCFRequest(BaseModel):
    ticker: str
    revenue: float
    op_margin: float = 15.0
    rev_growth: float = 10.0
    wacc: float = 10.0
    terminal_growth: float = 2.5
    years: int = 5
    shares: float = 100.0
    net_debt: float = 0.0
    tax_rate: float = 21.0
    capex_pct: float = 5.0
    da_pct: float = 4.0


@router.get("/fundamentals")
def get_fundamentals(ticker: str):
    ticker = validate_ticker(ticker)
    # FMP path — fast (~200ms), real financial statement data
    if fmp.available():
        try:
            return fmp.get_dcf_fundamentals(ticker)
        except Exception:
            pass  # fall through to yfinance

    # yfinance fallback
    try:
        info = get_info(ticker)
        revenue       = (info.get("totalRevenue") or 0) / 1e6
        op_margin_raw = info.get("operatingMargins")
        shares     = (info.get("sharesOutstanding") or 0) / 1e6
        total_debt = (info.get("totalDebt") or 0) / 1e6
        # yfinance uses different field names across versions/tickers; try all
        total_cash_raw = (
            info.get("totalCash")
            or info.get("cashAndCashEquivalents")
            or info.get("cash")
            or info.get("cashAndShortTermInvestments")
            or 0
        )
        total_cash = total_cash_raw / 1e6
        net_debt   = total_debt - total_cash
        rev_growth = (info.get("revenueGrowth") or 0.10) * 100
        price      = float(info.get("currentPrice") or info.get("regularMarketPrice") or 0) or None

        # Damodaran fallback — backstop beta / operating margin when yfinance is thin.
        beta_raw = info.get("beta")
        assumptions_source = "yfinance"
        if beta_raw and op_margin_raw:
            beta      = float(beta_raw)
            op_margin = float(op_margin_raw) * 100
        else:
            dmd = damodaran.lookup(info.get("sector"), info.get("industry"))
            beta      = float(beta_raw) if beta_raw else dmd["beta"]
            op_margin = float(op_margin_raw) * 100 if op_margin_raw else dmd["op_margin"]
            tag = dmd["name"] if dmd.get("matched") else "market avg"
            assumptions_source = f"Damodaran {dmd['updated']} — {tag}"

        return {
            "revenue":      max(0.0, round(revenue, 0)),
            "op_margin":    round(op_margin, 1),
            "shares":       max(0.1, round(shares, 1)),
            "net_debt":     round(net_debt, 0),
            "rev_growth":   round(rev_growth, 1),
            "capex_pct":    5.0,
            "da_pct":       4.0,
            "wc_pct":       0.5,
            "tax_rate":     21.0,
            "beta":         round(max(0.1, beta), 2),
            "market_price": price,
            "market_cap":   None,
            "de_ratio":     0.0,
            "assumptions_source": assumptions_source,
        }
    except Exception:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")


def _project(req, rev_growth: float):
    """FCFF projection + terminal value at a given revenue growth rate.
    Shared by the forward DCF and the reverse-DCF solver."""
    fcfs = []
    rev = req.revenue
    for y in range(1, req.years + 1):
        rev = rev * (1 + rev_growth / 100)
        ebit = rev * (req.op_margin / 100)
        nopat = ebit * (1 - req.tax_rate / 100)
        da = rev * (req.da_pct / 100)
        capex = rev * (req.capex_pct / 100)
        fcf = nopat + da - capex
        pv = fcf / ((1 + req.wacc / 100) ** y)
        fcfs.append({"year": y, "revenue": round(rev, 1), "fcf": round(fcf, 1), "pv_fcf": round(pv, 1)})

    terminal_fcf = fcfs[-1]["fcf"] * (1 + req.terminal_growth / 100)
    terminal_value = terminal_fcf / (req.wacc / 100 - req.terminal_growth / 100)
    pv_terminal = terminal_value / ((1 + req.wacc / 100) ** req.years)
    pv_fcfs = sum(f["pv_fcf"] for f in fcfs)
    enterprise_value = pv_fcfs + pv_terminal
    equity_value = enterprise_value - req.net_debt
    intrinsic_per_share = equity_value / req.shares if req.shares else 0.0
    return fcfs, pv_fcfs, pv_terminal, enterprise_value, equity_value, intrinsic_per_share


@router.post("/value")
def dcf_value(req: DCFRequest):
    # The Gordon terminal value is only finite when WACC > terminal growth. Past
    # that, (wacc - g) flips negative and a negative terminal FCF turns into a
    # spuriously huge positive terminal value — a meaningless result, not a number
    # worth returning.
    if req.wacc <= req.terminal_growth:
        raise HTTPException(400, "WACC must exceed terminal growth for a finite valuation")
    fcfs, pv_fcfs, pv_terminal, enterprise_value, equity_value, intrinsic_per_share = _project(req, req.rev_growth)
    return {
        "fcfs": fcfs,
        "pv_fcfs": round(pv_fcfs, 1),
        "terminal_value": round(pv_terminal, 1),
        "enterprise_value": round(enterprise_value, 1),
        "equity_value": round(equity_value, 1),
        "intrinsic_per_share": round(intrinsic_per_share, 2),
    }


class ReverseDCFRequest(BaseModel):
    ticker: str
    revenue: float
    op_margin: float = 15.0
    wacc: float = 10.0
    terminal_growth: float = 2.5
    years: int = 5
    shares: float = 100.0
    net_debt: float = 0.0
    tax_rate: float = 21.0
    capex_pct: float = 5.0
    da_pct: float = 4.0
    market_price: float = 0.0
    current_growth: float | None = None   # the company's actual growth, for context


@router.post("/reverse")
def dcf_reverse(req: ReverseDCFRequest):
    """Solve for the annual revenue growth rate the current market price implies,
    holding every other DCF assumption fixed. The classic reverse-DCF question:
    'what does the market expect this company to do?'"""
    from scipy.optimize import brentq

    if req.market_price <= 0:
        raise HTTPException(400, "market_price must be positive")
    if req.wacc <= req.terminal_growth:
        raise HTTPException(400, "WACC must exceed terminal growth for a finite valuation")

    def gap(g: float) -> float:
        return _project(req, g)[5] - req.market_price

    lo, hi = -50.0, 150.0
    implied = None
    try:
        if gap(lo) * gap(hi) <= 0:
            implied = brentq(gap, lo, hi, xtol=1e-3, maxiter=200)
    except Exception:
        implied = None

    if implied is None:
        return {
            "implied_growth": None,
            "market_price": round(req.market_price, 2),
            "current_growth": req.current_growth,
            "note": "The market price implies a growth rate outside a plausible range. Revisit the margin, WACC, or terminal-growth assumptions.",
        }

    fcfs, pv_fcfs, pv_terminal, ev, equity, ips = _project(req, implied)
    verdict = None
    if req.current_growth is not None:
        delta = implied - req.current_growth
        if   delta >  3: verdict = "demanding"   # market prices in materially faster growth than current
        elif delta < -3: verdict = "undemanding"
        else:            verdict = "in-line"

    return {
        "implied_growth":      round(implied, 2),
        "market_price":        round(req.market_price, 2),
        "intrinsic_per_share": round(ips, 2),
        "current_growth":      req.current_growth,
        "growth_gap":          round(implied - req.current_growth, 2) if req.current_growth is not None else None,
        "verdict":             verdict,
        "enterprise_value":    round(ev, 1),
        "equity_value":        round(equity, 1),
        "pv_fcfs":             round(pv_fcfs, 1),
        "terminal_value":      round(pv_terminal, 1),
        "fcfs":                fcfs,
    }
