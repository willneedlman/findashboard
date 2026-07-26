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
            # Every FMP sub-call (income/balance/cashflow statements) catches
            # its own request errors and returns [] / {} instead of raising —
            # a deliberate design so a transient failure doesn't get cached as
            # a false "no data" (see fmp._cached's docstring). But it means a
            # FULL outage (e.g. the free-tier daily quota exhausted, 429 on
            # every endpoint) still looks like a "successful" call here: a
            # dict of all-zero/default values (revenue 0, shares defaulted to
            # 100M, growth defaulted to 10%) rather than an exception — so the
            # `except` below never triggers the yfinance fallback. Revenue is
            # the one field with no plausible legitimate zero (a real company
            # always has SOME trailing revenue), so treat a zero there as
            # "this response isn't real" and force the fallback explicitly.
            if not data.get("revenue"):
                raise ValueError(f"FMP returned no revenue for {ticker} — statements fetch likely failed")
            info = get_info(ticker)          # cheap/cached — for sector/industry Damodaran lookup only
            beta, source = _resolve_beta(ticker, data.get("beta"), info.get("sector"), info.get("industry"))
            data["beta"] = round(beta, 2)
            data["assumptions_source"] = source
            # FMP's /profile call (the only source of market_price/market_cap
            # here) can fail independently of the statement calls that feed
            # the rest of this dict — e.g. hitting the free-tier daily quota
            # (429) while income/balance/cashflow still succeed — silently
            # returning market_price: None instead of raising, so the
            # `except` below never triggers a fallback. Backstop from the
            # yfinance `info` already fetched above for beta/sector; it's
            # already paid for, so this costs nothing extra.
            if not data.get("market_price"):
                data["market_price"] = float(info.get("currentPrice") or info.get("regularMarketPrice") or 0) or None
            if not data.get("market_cap"):
                data["market_cap"] = info.get("marketCap")
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
    term_g = getattr(req, "terminal_growth", 3.0) or 3.0
    for y in range(1, req.years + 1):
        # Terminal growth deceleration decay: initial growth rate fades towards terminal growth
        # over multi-year forecast horizons to account for market saturation and realistic scale.
        g_eff = term_g + (rev_growth - term_g) * (0.82 ** (y - 1))
        rev = rev * (1 + g_eff / 100)
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


def _run_dcf(revenue: float, op_margin: float, target_margin: float, shares: float, net_debt: float,
             tax_rate: float, stages: list[Stage], capex: Curve, da: Curve, wc: Curve,
             terminal_growth: float, wacc: float) -> dict:
    """Core projection, factored out so the tornado sensitivity below can
    re-run it cheaply (in-process, no HTTP round-trip) with one driver flexed
    at a time."""
    growth_schedule = _stage_schedule(stages)
    total_years = len(growth_schedule)

    fcfs = []
    rev = revenue
    for y in range(1, total_years + 1):
        g = growth_schedule[y - 1]
        rev = rev * (1 + g / 100)
        margin = op_margin + (target_margin - op_margin) * ((y - 1) / max(total_years - 1, 1))
        capex_pct = _glide(capex, y, total_years)
        da_pct = _glide(da, y, total_years)
        wc_pct = _glide(wc, y, total_years)

        ebit = rev * (margin / 100)
        nopat = ebit * (1 - tax_rate / 100)
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

    terminal_fcf = fcfs[-1]["fcf"] * (1 + terminal_growth / 100)
    terminal_value = terminal_fcf / (wacc / 100 - terminal_growth / 100)
    pv_terminal = terminal_value / ((1 + wacc / 100) ** total_years)
    pv_fcfs = sum(f["pv_fcf"] for f in fcfs)
    enterprise_value = pv_fcfs + pv_terminal
    equity_value = enterprise_value - net_debt
    intrinsic_per_share = equity_value / shares if shares else 0.0

    return {
        "fcfs": fcfs,
        "total_years": total_years,
        "pv_fcfs": round(pv_fcfs, 1),
        "terminal_value": round(pv_terminal, 1),
        "enterprise_value": round(enterprise_value, 1),
        "equity_value": round(equity_value, 1),
        "intrinsic_per_share": round(intrinsic_per_share, 2),
    }


@router.post("/value")
def dcf_value(req: DCFRequest):
    wacc_build = _resolve_wacc(req)
    wacc = wacc_build["wacc"]
    if wacc <= req.terminal_growth:
        raise HTTPException(400, "WACC must exceed terminal growth for a finite valuation")

    result = _run_dcf(req.revenue, req.op_margin, req.target_margin, req.shares, req.net_debt,
                      req.tax_rate, req.stages, req.capex, req.da, req.wc, req.terminal_growth, wacc)

    # One-way sensitivity (tornado): flex each key assumption low/high while
    # everything else holds at base, re-running the same projection in-process.
    def ips_with(**overrides) -> float:
        return _run_dcf(
            req.revenue, req.op_margin, overrides.get("target_margin", req.target_margin),
            req.shares, req.net_debt, overrides.get("tax_rate", req.tax_rate),
            overrides.get("stages", req.stages), overrides.get("capex", req.capex), req.da, req.wc,
            overrides.get("terminal_growth", req.terminal_growth), overrides.get("wacc", wacc),
        )["intrinsic_per_share"]

    stage1_growth = req.stages[0].growth
    def _stage1_flexed(g: float) -> list[Stage]:
        return [Stage(years=req.stages[0].years, growth=g), *req.stages[1:]]

    drivers = [
        ("WACC", "%", 1.5, wacc, lambda x: ips_with(wacc=x)),
        ("Terminal growth", "%", 1.0, req.terminal_growth, lambda x: ips_with(terminal_growth=x)),
        ("Target margin", "%", 4.0, req.target_margin, lambda x: ips_with(target_margin=x)),
        ("Yr 1 growth", "%", 4.0, stage1_growth, lambda x: ips_with(stages=_stage1_flexed(x))),
        ("Tax rate", "%", 3.0, req.tax_rate, lambda x: ips_with(tax_rate=x)),
        ("CapEx % rev", "%", 1.5, req.capex.start_pct, lambda x: ips_with(capex=Curve(start_pct=x, end_pct=req.capex.end_pct))),
    ]
    tornado = []
    for label, unit, d, base, calc in drivers:
        a, b = calc(base - d), calc(base + d)
        tornado.append({
            "label": label, "range": f"{base - d:.1f} – {base + d:.1f}{unit}",
            "lo": round(min(a, b), 2), "hi": round(max(a, b), 2),
        })
    tornado.sort(key=lambda t: abs(t["hi"] - t["lo"]), reverse=True)

    result["wacc_build"] = wacc_build
    result["tornado"] = tornado
    result["tornado_base"] = result["intrinsic_per_share"]
    return result


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


def _solve_growth(req: "ReverseDCFRequest"):
    """Brentq-solve the revenue growth rate that matches req.market_price,
    or None if no plausible rate does. Factored out so the sensitivity sweep
    below can re-run it against tweaked copies of the request."""
    from scipy.optimize import brentq

    def gap(g: float) -> float:
        return _project(req, g)[5] - req.market_price

    lo, hi = -50.0, 150.0
    try:
        if gap(lo) * gap(hi) <= 0:
            return brentq(gap, lo, hi, xtol=1e-3, maxiter=200)
    except Exception:
        pass
    return None


@router.post("/reverse")
def dcf_reverse(req: ReverseDCFRequest):
    """Solve for the annual revenue growth rate the current market price implies,
    holding every other DCF assumption fixed. The classic reverse-DCF question:
    'what does the market expect this company to do?'"""
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

    implied = _solve_growth(req)

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

    # Sensitivity: how much does the IMPLIED GROWTH answer move if margin/WACC/
    # terminal growth were different, holding the market price fixed? Re-solves
    # brentq against a tweaked copy of the request for each driver's low/high —
    # same {label, range, lo, hi} shape as the forward DCF's tornado (growth %
    # instead of $/share), reusing the same chart component on the frontend.
    sensitivity = []
    drivers = [
        ("Operating margin", "pts", 5.0, req.op_margin, "op_margin"),
        ("WACC", "pts", 1.5, req.wacc, "wacc"),
        ("Terminal growth", "pts", 1.0, req.terminal_growth, "terminal_growth"),
    ]
    for label, unit, d, base, field in drivers:
        lo_val, hi_val = base - d, base + d
        if field == "wacc" and lo_val <= req.terminal_growth:
            lo_val = req.terminal_growth + 0.5
        g_lo = _solve_growth(req.model_copy(update={field: lo_val}))
        g_hi = _solve_growth(req.model_copy(update={field: hi_val}))
        if g_lo is not None and g_hi is not None:
            sensitivity.append({
                "label": label, "range": f"{lo_val:.1f} – {hi_val:.1f}{unit}",
                "lo": round(min(g_lo, g_hi), 2), "hi": round(max(g_lo, g_hi), 2),
            })
    sensitivity.sort(key=lambda t: abs(t["hi"] - t["lo"]), reverse=True)

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
        "sensitivity":         sensitivity,
        "note": (f"Pre-profit company: operating margin assumed to ramp from {req.op_margin:.1f}% to {req.target_margin:.1f}% by year {req.years}, holding revenue growth as the solved variable." if pre_profit else None),
    }
