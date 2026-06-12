import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from math_engine import duration_convexity

router = APIRouter()


def solve_ytm(face: float, coupon_rate: float, market_price: float, maturity: int) -> float:
    coupon = face * (coupon_rate / 100)
    ytm = 0.05
    for _ in range(100):
        periods = np.arange(1, maturity + 1)
        estimate = (coupon / ((1 + ytm) ** periods)).sum() + face / ((1 + ytm) ** maturity)
        error = market_price - estimate
        if abs(error) < 1e-6:
            break
        ytm -= error / (market_price * maturity)
    return max(ytm, 0.0001)


class BondRequest(BaseModel):
    face: float = Field(default=1000.0, gt=0, le=1_000_000)
    coupon_rate: float = Field(default=5.0, ge=0, le=100)
    market_price: float = Field(default=1000.0, gt=0, le=1_000_000)
    maturity: int = Field(default=10, ge=1, le=100)


@router.post("/analytics")
def bond_analytics(req: BondRequest):
    ytm = solve_ytm(req.face, req.coupon_rate, req.market_price, req.maturity)
    d = duration_convexity(req.face, req.coupon_rate, req.maturity, ytm * 100)
    coupon = req.face * (req.coupon_rate / 100)
    cf_years = list(range(1, req.maturity + 1))
    nominal_cfs = [coupon] * req.maturity
    nominal_cfs[-1] += req.face
    pv_cfs = [cf / ((1 + ytm) ** t) for cf, t in zip(nominal_cfs, cf_years)]

    bond_type = "Premium Bond" if req.market_price > req.face else ("Discount Bond" if req.market_price < req.face else "Par Bond")

    # sensitivity curve
    shifts = list(range(-300, 305, 5))
    sensitivity = []
    for s in shifts:
        new_ytm = max(ytm + s / 10000, 0.0001)
        new_px = sum(nominal_cfs[i - 1] / ((1 + new_ytm) ** i) for i in cf_years)
        sensitivity.append({"shift": s, "price": round(new_px, 4)})

    return {
        "bond_type": bond_type,
        "ytm": round(ytm * 100, 4),
        "mod_duration": round(d["mod_duration"], 4),
        "mac_duration": round(d["mac_duration"], 4),
        "convexity": round(d["convexity"], 4),
        "coupon_payment": round(coupon, 2),
        "cash_flows": [{"year": t, "nominal": round(n, 2), "pv": round(p, 2)} for t, n, p in zip(cf_years, nominal_cfs, pv_cfs)],
        "sensitivity": sensitivity,
    }
