import math
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator

from routers.dcf import get_fundamentals
from validation import validate_ticker


router = APIRouter()
MAX_YEARS = 20
DRIVER_BUMPS = {
    "growth": 5.0,
    "margin": 5.0,
    "tax_rate": 5.0,
    "da_pct": 1.0,
    "capex_pct": 1.0,
    "change_nwc_pct": 1.0,
    "sbc_pct": 1.0,
    "cash_adjustment_pct": 1.0,
    "fcf_conversion_pct": 1.0,
    "net_interest_pct": 1.0,
    "dilution_pct": 1.0,
    "payout_pct": 1.0,
}
DRIVER_LIMITS = {
    "growth": (-75.0, 200.0),
    "margin": (-100.0, 100.0),
    "tax_rate": (0.0, 60.0),
    "da_pct": (0.0, 50.0),
    "capex_pct": (-25.0, 100.0),
    "change_nwc_pct": (-50.0, 50.0),
    "sbc_pct": (0.0, 50.0),
    "cash_adjustment_pct": (-50.0, 50.0),
    "fcf_conversion_pct": (0.0, 300.0),
    "net_interest_pct": (-25.0, 50.0),
    "dilution_pct": (-25.0, 50.0),
    "payout_pct": (0.0, 100.0),
}


class AnnualAssumption(BaseModel):
    year: int = Field(ge=1, le=MAX_YEARS)
    growth: float = Field(ge=-75, le=200)
    margin: float = Field(ge=-100, le=100)
    tax_rate: float = Field(default=21, ge=0, le=60)
    da_pct: float = Field(default=4, ge=0, le=50)
    capex_pct: float = Field(default=5, ge=-25, le=100)
    change_nwc_pct: float = Field(default=0.5, ge=-50, le=50)
    sbc_pct: float = Field(default=0, ge=0, le=50)
    cash_adjustment_pct: float = Field(default=0, ge=-50, le=50)
    fcf_conversion_pct: float = Field(default=100, ge=0, le=300)
    net_interest_pct: float = Field(default=0, ge=-25, le=50)
    dilution_pct: float = Field(default=0, ge=-25, le=50)
    payout_pct: float = Field(default=0, ge=0, le=100)


class TerminalConfig(BaseModel):
    perpetual_growth: float = Field(default=3.0, ge=-10, le=15)


class MultipleTarget(BaseModel):
    metric: Literal["ev_revenue", "ev_ebitda"]
    multiple: float = Field(gt=0, le=200)
    weight: float = Field(default=25, ge=0, le=100)
    year: int = Field(default=3, ge=1, le=MAX_YEARS)


class SotpSegment(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    revenue_share: float = Field(gt=0, le=100)
    price_to_sales_multiple: float = Field(gt=0, le=100)


class MethodWeights(BaseModel):
    dcf: float = Field(default=60, ge=0, le=100)
    multiples: float = Field(default=30, ge=0, le=100)
    ddm: float = Field(default=0, ge=0, le=100)
    sotp: float = Field(default=10, ge=0, le=100)


class MasterValuationRequest(BaseModel):
    ticker: str
    revenue: float = Field(gt=0)
    shares: float = Field(gt=0)
    net_debt: float = 0
    market_price: float | None = Field(default=None, gt=0)
    wacc: float = Field(default=9.5, gt=0, le=50)
    cost_of_equity: float = Field(default=10.0, gt=0, le=50)
    schedule: list[AnnualAssumption]
    terminal: TerminalConfig = Field(default_factory=TerminalConfig)
    multiple_targets: list[MultipleTarget] = Field(default_factory=list)
    sotp_segments: list[SotpSegment] = Field(default_factory=list)
    weights: MethodWeights = Field(default_factory=MethodWeights)
    dividend_terminal_growth: float = Field(default=3.0, ge=-10, le=15)

    @model_validator(mode="after")
    def validate_model(self):
        if not 3 <= len(self.schedule) <= MAX_YEARS:
            raise ValueError(f"Schedule must contain 3 to {MAX_YEARS} years")
        if [row.year for row in self.schedule] != list(range(1, len(self.schedule) + 1)):
            raise ValueError("Schedule years must be consecutive and begin at year 1")
        if self.wacc <= self.terminal.perpetual_growth:
            raise ValueError("WACC must be greater than perpetual growth")
        if any(target.year > len(self.schedule) for target in self.multiple_targets):
            raise ValueError("Multiple reference year exceeds the forecast horizon")
        if self.multiple_targets and self.weights.multiples > 0 and sum(target.weight for target in self.multiple_targets) <= 0:
            raise ValueError("At least one target multiple must have a positive within-method weight")
        if self.cost_of_equity <= self.dividend_terminal_growth and any(row.payout_pct > 0 for row in self.schedule):
            raise ValueError("Cost of equity must exceed dividend terminal growth")
        if sum(self.weights.model_dump().values()) <= 0:
            raise ValueError("At least one valuation method must have a positive weight")
        return self


def _lerp(start: float, end: float, index: int, count: int) -> float:
    return start if count <= 1 else start + (end - start) * index / (count - 1)


def _finite_or(value, default: float) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if math.isfinite(parsed) else default


def _default_schedule(fundamentals: dict, years: int = 10) -> list[dict]:
    growth = _finite_or(fundamentals.get("rev_growth"), 10)
    margin = _finite_or(fundamentals.get("op_margin"), 15)
    terminal_growth = 3.5
    terminal_margin = max(margin, min(35, margin + 5))
    capex = _finite_or(fundamentals.get("capex_pct"), 5)
    da = _finite_or(fundamentals.get("da_pct"), 4)
    wc = _finite_or(fundamentals.get("wc_pct"), 0.5)
    tax = _finite_or(fundamentals.get("tax_rate"), 21)
    return [
        {
            "year": index + 1,
            "growth": round(_lerp(growth, terminal_growth, index, years), 2),
            "margin": round(_lerp(margin, terminal_margin, index, years), 2),
            "tax_rate": tax,
            "da_pct": da,
            "capex_pct": capex,
            "change_nwc_pct": wc,
            "sbc_pct": 0,
            "cash_adjustment_pct": 0,
            "fcf_conversion_pct": 100,
            "net_interest_pct": 0,
            "dilution_pct": 0,
            "payout_pct": 0,
        }
        for index in range(years)
    ]


@router.get("/fundamentals")
def fundamentals(ticker: str):
    sym = validate_ticker(ticker)
    base = get_fundamentals(sym)
    current_multiples = {}
    business_segments = []
    business_segments_source = None
    business_segments_fiscal_year = None
    dps = None
    dividend_yield = None
    try:
        from routers.valuation import multiples
        multiples_data = multiples(sym)
        for row in multiples_data.get("metrics", []):
            if row.get("key") == "ev_ebitda" and row.get("current_mult") is not None:
                current_multiples["ev_ebitda"] = row["current_mult"]
    except Exception:
        pass
    try:
        from cache import get_info
        info = get_info(sym) or {}
        dps = float(info.get("trailingAnnualDividendRate") or info.get("dividendRate") or 0) or None
        price = base.get("market_price")
        dividend_yield = dps / price * 100 if dps and price else None
    except Exception:
        pass
    price = base.get("market_price")
    shares = base.get("shares")
    revenue = base.get("revenue")
    net_debt = base.get("net_debt") or 0
    if price and shares and revenue:
        current_multiples["ev_revenue"] = round((price * shares + net_debt) / revenue, 2)
    try:
        from routers.valuation import build_sotp_data
        parts = build_sotp_data(sym, fundamentals_override=base)
        reported_segments = parts.get("segments") or []
        reported_revenue = sum(_finite_or(segment.get("revenue"), 0) for segment in reported_segments)
        company_ps = _finite_or(parts.get("suggested_multiple"), 1.0)
        for segment in reported_segments:
            segment_revenue = _finite_or(segment.get("revenue"), 0)
            if segment_revenue <= 0 or reported_revenue <= 0:
                continue
            peer_ps = _finite_or(segment.get("peer_ps"), company_ps)
            seeded_ps = round(max(0.01, min(100, (company_ps + peer_ps) / 2)), 2)
            business_segments.append({
                "name": segment.get("name") or "Reported segment",
                "revenue_share": round(segment_revenue / reported_revenue * 100, 2),
                "price_to_sales_multiple": seeded_ps,
            })
        business_segments_source = parts.get("source")
        business_segments_fiscal_year = parts.get("fiscalYear")
    except Exception:
        pass

    return {
        "ticker": sym,
        "revenue": base.get("revenue"),
        "shares": base.get("shares"),
        "net_debt": base.get("net_debt"),
        "market_price": base.get("market_price"),
        "beta": base.get("beta"),
        "source": base.get("assumptions_source"),
        "schedule": _default_schedule(base),
        "current_multiples": current_multiples,
        "business_segments": business_segments,
        "business_segments_source": business_segments_source,
        "business_segments_fiscal_year": business_segments_fiscal_year,
        "dividend_per_share": dps,
        "dividend_yield": round(dividend_yield, 2) if dividend_yield is not None else None,
    }


def _project(req: MasterValuationRequest, schedule: list[AnnualAssumption] | None = None, wacc: float | None = None) -> dict:
    rows = []
    revenue = req.revenue
    shares = req.shares
    active_schedule = schedule or req.schedule
    discount_rate = req.wacc if wacc is None else wacc
    pv_fcfs = 0.0
    pv_dividend_per_share = 0.0

    for assumption in active_schedule:
        prior_revenue = revenue
        revenue *= 1 + assumption.growth / 100
        shares *= 1 + assumption.dilution_pct / 100
        ebit = revenue * assumption.margin / 100
        nopat = ebit * (1 - assumption.tax_rate / 100)
        interest_expense = revenue * assumption.net_interest_pct / 100
        net_income = (ebit - interest_expense) * (1 - assumption.tax_rate / 100)
        da = revenue * assumption.da_pct / 100
        capex = revenue * assumption.capex_pct / 100
        change_nwc = (revenue - prior_revenue) * assumption.change_nwc_pct / 100
        sbc = revenue * assumption.sbc_pct / 100
        cash_adjustment = revenue * assumption.cash_adjustment_pct / 100
        base_fcf = nopat + da + sbc + cash_adjustment - capex - change_nwc
        fcf = base_fcf * assumption.fcf_conversion_pct / 100
        dividend = max(0.0, net_income) * assumption.payout_pct / 100
        dividend_per_share = dividend / shares
        pv_fcf = fcf / ((1 + discount_rate / 100) ** assumption.year)
        pv_dividend_per_share += dividend_per_share / ((1 + req.cost_of_equity / 100) ** assumption.year)
        pv_fcfs += pv_fcf
        rows.append({
            **assumption.model_dump(),
            "revenue": revenue,
            "ebit": ebit,
            "nopat": nopat,
            "interest_expense": interest_expense,
            "net_income": net_income,
            "da": da,
            "capex": capex,
            "change_nwc": change_nwc,
            "sbc": sbc,
            "cash_adjustment": cash_adjustment,
            "fcf": fcf,
            "pv_fcf": pv_fcf,
            "shares": shares,
            "dividend": dividend,
            "dividend_per_share": dividend_per_share,
        })

    final = rows[-1]
    terminal_fcf = final["fcf"] * (1 + req.terminal.perpetual_growth / 100)
    terminal_value = terminal_fcf / ((discount_rate - req.terminal.perpetual_growth) / 100)
    pv_terminal = terminal_value / ((1 + discount_rate / 100) ** len(rows))
    enterprise_value = pv_fcfs + pv_terminal
    dcf_equity = enterprise_value - req.net_debt
    dcf_per_share = dcf_equity / final["shares"]

    multiple_lines = []
    for target in req.multiple_targets:
        row = rows[target.year - 1]
        if target.metric == "ev_revenue":
            present_enterprise = row["revenue"] * target.multiple / ((1 + discount_rate / 100) ** target.year)
            equity = present_enterprise - req.net_debt
        else:
            present_enterprise = (row["ebit"] + row["da"]) * target.multiple / ((1 + discount_rate / 100) ** target.year)
            equity = present_enterprise - req.net_debt
        value = equity / row["shares"]
        if math.isfinite(value):
            multiple_lines.append({
                "metric": target.metric,
                "multiple": target.multiple,
                "year": target.year,
                "weight": target.weight,
                "value_per_share": value,
            })
    multiple_weight = sum(line["weight"] for line in multiple_lines)
    for line in multiple_lines:
        line["effective_weight"] = line["weight"] / multiple_weight * 100 if multiple_weight > 0 else 0
    multiples_per_share = (
        sum(line["value_per_share"] * line["weight"] for line in multiple_lines) / multiple_weight
        if multiple_weight > 0 else None
    )

    ddm_per_share = None
    if final["dividend"] > 0:
        next_dividend_per_share = final["dividend_per_share"] * (1 + req.dividend_terminal_growth / 100)
        terminal_per_share = next_dividend_per_share / ((req.cost_of_equity - req.dividend_terminal_growth) / 100)
        ddm_per_share = pv_dividend_per_share + terminal_per_share / ((1 + req.cost_of_equity / 100) ** len(rows))

    sotp_per_share = None
    if req.sotp_segments:
        share_total = sum(segment.revenue_share for segment in req.sotp_segments)
        terminal_equity = sum(
            final["revenue"] * segment.revenue_share / share_total * segment.price_to_sales_multiple
            for segment in req.sotp_segments
        )
        present_equity = terminal_equity / ((1 + discount_rate / 100) ** len(rows))
        sotp_per_share = present_equity / final["shares"]

    methods = {
        "dcf": dcf_per_share,
        "multiples": multiples_per_share,
        "ddm": ddm_per_share,
        "sotp": sotp_per_share,
    }
    requested_weights = req.weights.model_dump()
    requested_active_weights = {
        key: requested_weights[key]
        for key, value in methods.items()
        if value is not None and math.isfinite(value) and requested_weights[key] > 0
    }
    total_weight = sum(requested_active_weights.values())
    used_weight_fallback = total_weight <= 0
    if used_weight_fallback:
        requested_active_weights = {"dcf": 1.0}
        total_weight = 1.0
    active_weights = {key: weight / total_weight * 100 for key, weight in requested_active_weights.items()}
    composite = sum(methods[key] * weight / 100 for key, weight in active_weights.items())
    values = [methods[key] for key in active_weights]
    terminal_pct = pv_terminal / enterprise_value * 100 if enterprise_value else None
    warnings = []
    if terminal_pct is not None and terminal_pct > 85:
        warnings.append(f"Terminal value contributes {terminal_pct:.0f}% of enterprise value.")
    if final["fcf"] <= 0:
        warnings.append("Terminal free cash flow is non-positive; the perpetuity result is not economically meaningful.")
    if req.sotp_segments and abs(sum(segment.revenue_share for segment in req.sotp_segments) - 100) > 0.5:
        warnings.append("SOTP segment shares were normalized to 100%.")
    non_positive_methods = [key for key, value in methods.items() if value is not None and math.isfinite(value) and value <= 0]
    if non_positive_methods:
        warnings.append(f"Non-positive equity value from: {', '.join(non_positive_methods)}. The result remains in the connected valuation.")
    if used_weight_fallback:
        warnings.append("No weighted method was available. Intrinsic DCF was used at 100% effective weight.")

    return {
        "rows": rows,
        "dcf": {
            "value_per_share": dcf_per_share,
            "enterprise_value": enterprise_value,
            "equity_value": dcf_equity,
            "pv_forecast_fcf": pv_fcfs,
            "pv_terminal": pv_terminal,
            "terminal_pct": terminal_pct,
        },
        "multiples": {"value_per_share": multiples_per_share, "lines": multiple_lines},
        "ddm": {"value_per_share": ddm_per_share},
        "sotp": {"value_per_share": sotp_per_share},
        "methods": methods,
        "active_weights": active_weights,
        "composite": {
            "value_per_share": composite,
            "range_low": min(values) if values else dcf_per_share,
            "range_high": max(values) if values else dcf_per_share,
        },
        "warnings": warnings,
    }


def _bisect_value(fn, target: float, low: float, high: float, iterations: int = 48) -> float | None:
    low_value = fn(low) - target
    high_value = fn(high) - target
    if not math.isfinite(low_value) or not math.isfinite(high_value) or low_value * high_value > 0:
        return None
    for _ in range(iterations):
        middle = (low + high) / 2
        middle_value = fn(middle) - target
        if abs(middle_value) < 1e-5:
            return middle
        if low_value * middle_value <= 0:
            high = middle
        else:
            low = middle
            low_value = middle_value
    return (low + high) / 2


def _shifted_schedule(req: MasterValuationRequest, field: Literal["growth", "margin"], shift: float) -> list[AnnualAssumption]:
    result = []
    for row in req.schedule:
        values = row.model_dump()
        shifted = values[field] + shift
        values[field] = max(-75, min(200, shifted)) if field == "growth" else max(-100, min(100, shifted))
        result.append(AnnualAssumption(**values))
    return result


def _bumped_schedule(req: MasterValuationRequest, field: str, bump: float) -> list[AnnualAssumption]:
    low, high = DRIVER_LIMITS[field]
    result = []
    for row in req.schedule:
        values = row.model_dump()
        values[field] = max(low, min(high, values[field] + bump))
        result.append(AnnualAssumption(**values))
    return result


def _driver_effects(req: MasterValuationRequest, base: dict) -> dict:
    base_value = base["composite"]["value_per_share"]
    effects = {}
    for field, bump in DRIVER_BUMPS.items():
        changed = _project(req, schedule=_bumped_schedule(req, field, bump))
        changed_value = changed["composite"]["value_per_share"]
        effects[field] = {
            "bump": bump,
            "value_per_share": changed_value,
            "change_per_share": changed_value - base_value,
        }
    for field, effect in effects.items():
        effect["change_per_point"] = effect["change_per_share"] / DRIVER_BUMPS[field]
    ranked = sorted(effects, key=lambda key: abs(effects[key]["change_per_point"]), reverse=True)
    for rank, field in enumerate(ranked, 1):
        effects[field]["rank"] = rank
    return effects


def _schedule_cagr(schedule: list[AnnualAssumption]) -> float:
    return (math.prod(1 + row.growth / 100 for row in schedule) ** (1 / len(schedule)) - 1) * 100


def _schedule_at_cagr(req: MasterValuationRequest, target: float) -> list[AnnualAssumption]:
    shift = _bisect_value(
        lambda amount: _schedule_cagr(_shifted_schedule(req, "growth", amount)),
        target, -250, 250,
    )
    return _shifted_schedule(req, "growth", shift if shift is not None else target - _schedule_cagr(req.schedule))


def _bounded_axis(base: float, step: float, minimum: float, maximum: float) -> tuple[list[float], int]:
    base = round(max(minimum, min(maximum, base)), 2)
    values = {base}
    distance = 1
    while len(values) < 5:
        for direction in (-1, 1):
            candidate = round(base + direction * step * distance, 2)
            if minimum <= candidate <= maximum:
                values.add(candidate)
        distance += 1
    axis = sorted(values, key=lambda value: (abs(value - base), value))[:5]
    axis.sort()
    return axis, axis.index(base)


def _sensitivity_grid(
    title: str,
    row_label: str,
    column_label: str,
    row_values: list[float],
    column_values: list[float],
    row_suffix: str,
    column_suffix: str,
    base_row_index: int,
    base_column_index: int,
    evaluator,
) -> dict:
    values = []
    for row_value in row_values:
        row = []
        for column_value in column_values:
            value = evaluator(row_value, column_value)
            row.append(value if value is not None and math.isfinite(value) else None)
        values.append(row)
    return {
        "title": title,
        "row_label": row_label,
        "column_label": column_label,
        "row_values": row_values,
        "column_values": column_values,
        "row_suffix": row_suffix,
        "column_suffix": column_suffix,
        "values": values,
        "base_row_index": base_row_index,
        "base_column_index": base_column_index,
    }


def _sensitivity_tables(req: MasterValuationRequest) -> dict:
    base_cagr = _schedule_cagr(req.schedule)
    base_margin = req.schedule[-1].margin
    ebitda_targets = [target for target in req.multiple_targets if target.metric == "ev_ebitda"]
    ebitda_weight = sum(target.weight for target in ebitda_targets)
    base_ebitda_multiple = (
        sum(target.multiple * target.weight for target in ebitda_targets) / ebitda_weight
        if ebitda_weight > 0
        else ebitda_targets[0].multiple if ebitda_targets else 16.0
    )

    def connected(changed: MasterValuationRequest) -> float:
        return _project(changed)["composite"]["value_per_share"]

    def discount_rate(wacc_value: float, growth_value: float) -> float | None:
        if wacc_value <= growth_value:
            return None
        changed = req.model_copy(deep=True)
        changed.wacc = wacc_value
        changed.terminal.perpetual_growth = growth_value
        return connected(changed)

    def operating_case(cagr_value: float, margin_value: float) -> float:
        changed = req.model_copy(deep=True)
        changed.schedule = _schedule_at_cagr(req, cagr_value)
        changed.schedule = _shifted_schedule(changed, "margin", margin_value - changed.schedule[-1].margin)
        return connected(changed)

    def growth_risk(wacc_value: float, cagr_value: float) -> float | None:
        if wacc_value <= req.terminal.perpetual_growth:
            return None
        changed = req.model_copy(deep=True)
        changed.wacc = wacc_value
        changed.schedule = _schedule_at_cagr(req, cagr_value)
        return connected(changed)

    def exit_framework(margin_value: float, multiple_value: float) -> float:
        changed = req.model_copy(deep=True)
        changed.schedule = _shifted_schedule(req, "margin", margin_value - base_margin)
        for target in changed.multiple_targets:
            if target.metric == "ev_ebitda":
                target.multiple = multiple_value
        return connected(changed)

    wacc_values, wacc_base = _bounded_axis(req.wacc, 1, 0.01, 50)
    terminal_growth_values, terminal_growth_base = _bounded_axis(req.terminal.perpetual_growth, 0.5, -10, 15)
    cagr_values, cagr_base = _bounded_axis(base_cagr, 5, -75, 200)
    margin_values, margin_base = _bounded_axis(base_margin, 5, -100, 100)
    exit_values, exit_base = _bounded_axis(base_ebitda_multiple, 2, 0.01, 200)

    tables = {
        "discount_rate": _sensitivity_grid(
            "WACC x terminal growth", "WACC", "Terminal growth",
            wacc_values, terminal_growth_values, "%", "%", wacc_base, terminal_growth_base, discount_rate,
        ),
        "operating_case": _sensitivity_grid(
            "Revenue CAGR x terminal margin", "Revenue CAGR", "Terminal margin",
            cagr_values, margin_values, "%", "%", cagr_base, margin_base, operating_case,
        ),
        "growth_risk": _sensitivity_grid(
            "WACC x revenue CAGR", "WACC", "Revenue CAGR",
            wacc_values, cagr_values, "%", "%", wacc_base, cagr_base, growth_risk,
        ),
        "exit_framework": _sensitivity_grid(
            "Terminal margin x market multiple", "Terminal margin", "Target EV / EBITDA",
            margin_values, exit_values, "%", "x", margin_base, exit_base, exit_framework,
        ),
    }
    base_value = connected(req)
    for table in tables.values():
        table["values"][table["base_row_index"]][table["base_column_index"]] = base_value
    return tables


def _reverse(req: MasterValuationRequest, base: dict) -> dict:
    price = req.market_price
    if price is None:
        return {}

    growth_shift = _bisect_value(
        lambda shift: _project(req, _shifted_schedule(req, "growth", shift))["dcf"]["value_per_share"],
        price, -75, 150,
    )
    margin_shift = _bisect_value(
        lambda shift: _project(req, _shifted_schedule(req, "margin", shift))["dcf"]["value_per_share"],
        price, -75, 75,
    )
    wacc = _bisect_value(
        lambda rate: _project(req, wacc=rate)["dcf"]["value_per_share"],
        price, max(req.terminal.perpetual_growth + 0.25, 1), 40,
    )
    reference_target = next((target for target in req.multiple_targets if target.metric == "ev_ebitda" and target.weight > 0), None)
    reference_year = reference_target.year if reference_target else len(req.schedule)
    reference_row = base["rows"][reference_year - 1]
    implied_exit = None
    if reference_row["ebit"] + reference_row["da"] > 0:
        discount = (1 + req.wacc / 100) ** reference_year
        required_enterprise_value = (price * reference_row["shares"] + req.net_debt) * discount
        implied_exit = required_enterprise_value / (reference_row["ebit"] + reference_row["da"])
        if not math.isfinite(implied_exit) or implied_exit <= 0:
            implied_exit = None

    growth_schedule = _shifted_schedule(req, "growth", growth_shift) if growth_shift is not None else None
    margin_schedule = _shifted_schedule(req, "margin", margin_shift) if margin_shift is not None else None
    return {
        "growth_shift": growth_shift,
        "implied_revenue_cagr": (
            (math.prod(1 + row.growth / 100 for row in growth_schedule) ** (1 / len(growth_schedule)) - 1) * 100
            if growth_schedule else None
        ),
        "implied_growth_schedule": [row.growth for row in growth_schedule] if growth_schedule else None,
        "margin_shift": margin_shift,
        "implied_terminal_margin": margin_schedule[-1].margin if margin_schedule else None,
        "implied_margin_schedule": [row.margin for row in margin_schedule] if margin_schedule else None,
        "implied_wacc": wacc,
        "implied_exit_multiple": implied_exit,
        "implied_exit_year": reference_year,
    }


@router.post("/analyze")
def analyze(req: MasterValuationRequest):
    try:
        req.ticker = validate_ticker(req.ticker)
        result = _project(req)
        result["ticker"] = req.ticker
        result["market_price"] = req.market_price
        result["reverse"] = _reverse(req, result)
        result["driver_effects"] = _driver_effects(req, result)
        result["sensitivity_tables"] = _sensitivity_tables(req)
        return result
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except Exception as exc:
        raise HTTPException(500, f"Valuation model failed: {exc}") from exc
