import logging
logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fmp
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
        revenue    = (info.get("totalRevenue") or 0) / 1e6
        op_margin  = (info.get("operatingMargins") or 0.15) * 100
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
        beta       = float(info.get("beta") or 1.0)
        price      = float(info.get("currentPrice") or info.get("regularMarketPrice") or 0) or None
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
        }
    except Exception as e:
        logger.exception("internal error"); raise HTTPException(500, "Internal server error")


@router.post("/value")
def dcf_value(req: DCFRequest):
    fcfs = []
    rev = req.revenue
    for y in range(1, req.years + 1):
        rev = rev * (1 + req.rev_growth / 100)
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
    intrinsic_per_share = equity_value / req.shares if req.shares else 0

    return {
        "fcfs": fcfs,
        "pv_fcfs": round(pv_fcfs, 1),
        "terminal_value": round(pv_terminal, 1),
        "enterprise_value": round(enterprise_value, 1),
        "equity_value": round(equity_value, 1),
        "intrinsic_per_share": round(intrinsic_per_share, 2),
    }
