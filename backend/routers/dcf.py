import logging
logger = logging.getLogger(__name__)

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
import sys, os, datetime as _dt
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import fmp
import damodaran
import factset
import factor_models as fm
from cache import get_info
from validation import validate_ticker
from routers.rates import risk_free_rate

router = APIRouter()
MAX_HORIZON = 20


def _resolve_beta(ticker: str, vendor_beta, sector, industry) -> tuple[float, str]:
    """Beta priority chain: computed CAPM beta (regressed against Ken French
    Mkt-RF over the trailing 3 years) -> vendor beta -> Damodaran
    sector/industry fallback. Only drops to Damodaran when there isn't
    enough price history to regress at all (e.g. a recent IPO)."""
    try:
        start = (_dt.date.today() - _dt.timedelta(days=3 * 365)).isoformat()
        end = _dt.date.today().isoformat()
        returns = fm.stock_returns(ticker, start, end, "daily")
        if len(returns) >= 20:
            fit = fm.capm(returns, fm.get_factors("daily"))
            if fit.get("available"):
                return max(0.1, float(fit["betas"]["mktrf"])), "computed CAPM"
    except Exception:
        logger.warning("computed beta failed for %s, falling back", ticker, exc_info=True)

    if vendor_beta:
        return max(0.1, float(vendor_beta)), "vendor"

    dmd = damodaran.lookup(sector, industry)
    tag = dmd["name"] if dmd.get("matched") else "market avg"
    return max(0.1, float(dmd["beta"])), f"Damodaran {dmd['updated']} — {tag}"


# FactSet Financial Highlights (real statements + forward consensus estimates) is
# the highest-quality source when the key is entitled and the ticker is covered.
# It overrides the statement-derived fields on top of the FMP/yfinance base, which
# still supplies beta, live price, and market cap that this endpoint does not carry.
@router.get("/fundamentals")
def get_fundamentals(ticker: str):
    base = _base_fundamentals(ticker)
    if factset.available():
        try:
            fs = factset.get_dcf_fundamentals(ticker)
            if fs and fs.get("revenue"):
                for k in ("revenue", "op_margin", "shares", "net_debt", "rev_growth", "capex_pct", "de_ratio"):
                    if fs.get(k) is not None:
                        base[k] = fs[k]
                # FactSet supplies financials but never beta — overwriting
                # assumptions_source with FactSet's own label here used to
                # mislabel the beta figure too (e.g. showing "FactSet" when
                # beta actually came from the computed-CAPM/vendor/Damodaran
                # chain in _resolve_beta). Compose both so each figure's real
                # source stays honest.
                base["assumptions_source"] = f"{fs['assumptions_source']} · beta: {base['assumptions_source']}"
        except Exception:
            logger.info("FactSet fundamentals unavailable for %s, using base source", ticker)
    return base


def _base_fundamentals(ticker: str):
    ticker = validate_ticker(ticker)
    # FMP path — fast (~200ms), real financial statement data
    if fmp.available():
        try:
            data = fmp.get_dcf_fundamentals(ticker)
            info = get_info(ticker)          # cheap/cached — for sector/industry Damodaran lookup only
            beta, source = _resolve_beta(ticker, data.get("beta"), info.get("sector"), info.get("industry"))
            data["beta"] = round(beta, 2)
            data["assumptions_source"] = source
            return data
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

        # Damodaran fallback — backstop operating margin when yfinance is thin.
        # Beta is resolved separately via the computed-CAPM -> vendor -> Damodaran
        # priority chain in _resolve_beta(); assumptions_source reflects that tier.
        beta_raw = info.get("beta")
        if op_margin_raw:
            op_margin = float(op_margin_raw) * 100
        else:
            dmd = damodaran.lookup(info.get("sector"), info.get("industry"))
            op_margin = dmd["op_margin"]
        beta, assumptions_source = _resolve_beta(ticker, beta_raw, info.get("sector"), info.get("industry"))

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


def _margin_for_year(op_margin: float, target_margin, y: int, years: int) -> float:
    """Pre-profit fallback. A loss-making company (negative operating margin) is
    modeled as ramping linearly from its current margin to a positive maturity
    target over the projection horizon, so FCF can turn positive and the model
    stays solvable. Profitable companies keep a flat margin (classic DCF)."""
    if op_margin < 0 and target_margin is not None and target_margin > op_margin:
        return op_margin + (target_margin - op_margin) * (y / max(years, 1))
    return op_margin


def _project(req, rev_growth: float):
    """FCFF projection + terminal value at a given revenue growth rate.
    Shared by the forward DCF and the reverse-DCF solver."""
    fcfs = []
    rev = req.revenue
    for y in range(1, req.years + 1):
        rev = rev * (1 + rev_growth / 100)
        margin = _margin_for_year(req.op_margin, getattr(req, "target_margin", None), y, req.years)
        ebit = rev * (margin / 100)
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


# ── Forward DCF — adjustable growth stages + CapEx/D&A/WC glide paths ──────────
# A moderate upgrade over a flat single-rate model: revenue growth is a
# user-defined list of stages (each its own duration + rate) instead of a
# hardcoded split, and CapEx/D&A/working-capital are each their own start->end
# linear glide path instead of one flat %-of-revenue for the whole horizon.
# Margin stays a single current->target linear ramp (same convention as
# _margin_for_year above, generalized to any stage count). Full driver-level
# detail (segment revenue, DSO/DPO/DIO working capital, a debt schedule) would
# be a bigger rebuild, left for later.
class Stage(BaseModel):
    years: int = Field(gt=0, le=MAX_HORIZON)
    growth: float   # revenue growth %, this stage


class Curve(BaseModel):
    """A metric expressed as %-of-revenue that glides linearly from start_pct
    (year 1) to end_pct (final projection year) — e.g. CapEx starting high
    during a growth phase and fading to a steady-state %."""
    start_pct: float
    end_pct: float


class DCFRequest(BaseModel):
    ticker: str
    revenue: float
    op_margin: float = 15.0
    target_margin: float = 15.0
    shares: float = 100.0
    net_debt: float = 0.0
    tax_rate: float = 21.0
    stages: list[Stage]
    capex: Curve = Curve(start_pct=5.0, end_pct=5.0)
    da: Curve = Curve(start_pct=4.0, end_pct=4.0)
    wc: Curve = Curve(start_pct=0.5, end_pct=0.5)
    terminal_growth: float = 2.5

    # WACC: pass `wacc` directly to override, or leave it unset to build one
    # from CAPM cost of equity + after-tax cost of debt, weighted by D/E.
    wacc: float | None = None
    risk_free: float | None = None          # None = live Treasury curve
    equity_risk_premium: float = 5.5
    beta: float | None = None               # None = resolved from _base_fundamentals
    cost_of_debt_spread: float = 2.0        # spread over risk-free for Kd
    de_ratio: float | None = None           # None = resolved from _base_fundamentals

    @model_validator(mode="after")
    def _validate(self):
        self.ticker = validate_ticker(self.ticker)
        if not self.stages:
            raise ValueError("At least one growth stage is required")
        total_years = sum(s.years for s in self.stages)
        if total_years > MAX_HORIZON:
            raise ValueError(f"Total projection horizon ({total_years}y) exceeds the {MAX_HORIZON}-year cap")
        return self


def _resolve_wacc(req: DCFRequest) -> dict:
    """Returns the WACC plus a breakdown of how it was built, so the UI can
    show its work instead of a single opaque number."""
    if req.wacc is not None:
        return {"wacc": req.wacc, "mode": "manual", "risk_free": None, "cost_of_equity": None,
                "cost_of_debt": None, "beta": req.beta, "equity_weight": None, "debt_weight": None}

    beta = req.beta
    de_ratio = req.de_ratio
    if beta is None or de_ratio is None:
        try:
            base = _base_fundamentals(req.ticker)
        except Exception:
            base = {}
        if beta is None:
            beta = base.get("beta") or 1.0
        if de_ratio is None:
            de_ratio = base.get("de_ratio") or 0.0

    if req.risk_free is not None:
        rf = req.risk_free / 100.0
    else:
        try:
            rf = risk_free_rate()["rate"]
        except Exception:
            rf = 0.045

    erp = req.equity_risk_premium / 100.0
    ke = rf + beta * erp                                    # cost of equity, CAPM
    kd = rf + req.cost_of_debt_spread / 100.0                # cost of debt, risk-free + credit spread
    ew = 1 / (1 + de_ratio) if de_ratio > 0 else 1.0
    dw = de_ratio / (1 + de_ratio) if de_ratio > 0 else 0.0
    wacc = (ke * ew + kd * (1 - req.tax_rate / 100.0) * dw) * 100
    wacc = max(3.0, min(25.0, wacc))
    return {
        "wacc": round(wacc, 2), "mode": "auto", "risk_free": round(rf * 100, 2),
        "cost_of_equity": round(ke * 100, 2), "cost_of_debt": round(kd * 100, 2),
        "beta": round(beta, 2), "equity_weight": round(ew, 3), "debt_weight": round(dw, 3),
    }


def _glide(curve: Curve, y: int, total_years: int) -> float:
    if total_years <= 1:
        return curve.end_pct
    t = (y - 1) / (total_years - 1)
    return curve.start_pct + (curve.end_pct - curve.start_pct) * t


def _stage_schedule(stages: list[Stage]) -> list[float]:
    """Per-year growth rate, one entry per projection year, expanded from the
    stage list (e.g. [{years:3,growth:15},{years:4,growth:10}] -> 3 years at
    15% then 4 years at 10%)."""
    out: list[float] = []
    for s in stages:
        out.extend([s.growth] * s.years)
    return out


@router.post("/value")
def dcf_value(req: DCFRequest):
    wacc_build = _resolve_wacc(req)
    wacc = wacc_build["wacc"]
    if wacc <= req.terminal_growth:
        raise HTTPException(400, "WACC must exceed terminal growth for a finite valuation")

    growth_schedule = _stage_schedule(req.stages)
    total_years = len(growth_schedule)

    fcfs = []
    rev = req.revenue
    for y in range(1, total_years + 1):
        g = growth_schedule[y - 1]
        rev = rev * (1 + g / 100)
        margin = req.op_margin + (req.target_margin - req.op_margin) * ((y - 1) / max(total_years - 1, 1))
        capex_pct = _glide(req.capex, y, total_years)
        da_pct = _glide(req.da, y, total_years)
        wc_pct = _glide(req.wc, y, total_years)

        ebit = rev * (margin / 100)
        nopat = ebit * (1 - req.tax_rate / 100)
        da_amt = rev * (da_pct / 100)
        capex_amt = rev * (capex_pct / 100)
        wc_amt = rev * (wc_pct / 100)
        fcf = nopat + da_amt - capex_amt - wc_amt
        pv = fcf / ((1 + wacc / 100) ** y)

        fcfs.append({
            "year": y, "revenue": round(rev, 1), "growth": round(g, 2), "margin": round(margin, 2),
            "capex_pct": round(capex_pct, 2), "da_pct": round(da_pct, 2), "wc_pct": round(wc_pct, 2),
            "ebit": round(ebit, 1), "fcf": round(fcf, 1), "pv_fcf": round(pv, 1),
        })

    terminal_fcf = fcfs[-1]["fcf"] * (1 + req.terminal_growth / 100)
    terminal_value = terminal_fcf / (wacc / 100 - req.terminal_growth / 100)
    pv_terminal = terminal_value / ((1 + wacc / 100) ** total_years)
    pv_fcfs = sum(f["pv_fcf"] for f in fcfs)
    enterprise_value = pv_fcfs + pv_terminal
    equity_value = enterprise_value - req.net_debt
    intrinsic_per_share = equity_value / req.shares if req.shares else 0.0

    return {
        "fcfs": fcfs,
        "total_years": total_years,
        "pv_fcfs": round(pv_fcfs, 1),
        "terminal_value": round(pv_terminal, 1),
        "enterprise_value": round(enterprise_value, 1),
        "equity_value": round(equity_value, 1),
        "intrinsic_per_share": round(intrinsic_per_share, 2),
        "wacc_build": wacc_build,
    }


class ReverseDCFRequest(BaseModel):
    ticker: str
    revenue: float
    op_margin: float = 15.0
    target_margin: float | None = None
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

    # Pre-profit fallback: a loss-making company can't be solved holding a
    # negative margin flat (FCF never turns positive). Ramp toward a positive
    # maturity target; default it when the caller didn't supply one.
    pre_profit = req.op_margin < 0
    if pre_profit and req.target_margin is None:
        req.target_margin = 12.0

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
            "pre_profit": pre_profit,
            "note": (
                f"Even assuming this pre-profit company ramps to a {req.target_margin:.0f}% operating "
                f"margin by year {req.years}, no plausible growth rate matches the price. Try a higher "
                f"target margin or a longer projection."
                if pre_profit else
                "The market price implies a growth rate outside a plausible range. Revisit the margin, WACC, or terminal-growth assumptions."
            ),
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
        "pre_profit":          pre_profit,
        "assumed_target_margin": round(req.target_margin, 1) if pre_profit else None,
        "note": (f"Pre-profit company: operating margin assumed to ramp from {req.op_margin:.1f}% to {req.target_margin:.1f}% by year {req.years}, holding revenue growth as the solved variable." if pre_profit else None),
    }
