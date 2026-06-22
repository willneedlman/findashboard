import re
import numpy as np
import requests
from datetime import date
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from math_engine import duration_convexity
try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

router = APIRouter()

_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}


def _lookup_treasury(cusip: str):
    """US Treasury security details by CUSIP (free, public TreasuryDirect API)."""
    try:
        r = requests.get(f"https://www.treasurydirect.gov/TA_WS/securities/search?cusip={cusip}&format=json",
                         headers=_UA, timeout=10)
        if r.status_code != 200:
            return None
        rows = r.json()
        if not isinstance(rows, list) or not rows:
            return None
        row = max(rows, key=lambda x: x.get("issueDate") or "")
        mat = (row.get("maturityDate") or "")[:10]
        issue = (row.get("issueDate") or "")[:10]
        coupon = None
        try:
            coupon = round(float(row.get("interestRate")), 4)
        except (TypeError, ValueError):
            pass
        years = None
        if mat:
            try:
                years = round((date.fromisoformat(mat) - date.today()).days / 365.25, 2)
            except ValueError:
                pass
        sec = row.get("securityType") or "Treasury"
        term = row.get("securityTerm") or ""
        return {
            "found": True, "source": "treasury", "cusip": cusip,
            "name": f"U.S. Treasury {sec} {term}".strip(),
            "type": f"Treasury {sec}",
            "coupon_rate": coupon,
            "maturity_date": mat or None,
            "issue_date": issue or None,
            "years_to_maturity": years,
        }
    except Exception:
        return None


def _parse_bond_desc(desc: str):
    """Pull (coupon, maturity_date) from an OpenFIGI bond description such as
    'AAPL 3.85 05/04/43'. Returns (None, None) for floaters/non-standard lines."""
    m = re.search(r"\s([\d.]+)\s+(\d{2})/(\d{2})/(\d{2})\s*$", desc or "")
    if not m:
        return None, None
    try:
        coupon = round(float(m.group(1)), 4)
    except ValueError:
        return None, None
    return coupon, f"20{m.group(4)}-{m.group(2)}-{m.group(3)}"


def _lookup_openfigi(cusip: str):
    """Identity by CUSIP via OpenFIGI (free, rate-limited). For corporate/muni
    bonds the description encodes coupon + maturity, which we parse and return;
    live price/yield still needs a licensed feed (TRACE/Bloomberg)."""
    try:
        r = requests.post("https://api.openfigi.com/v3/mapping",
                          json=[{"idType": "ID_CUSIP", "idValue": cusip}],
                          headers={"Content-Type": "application/json"}, timeout=10)
        if r.status_code != 200:
            return None
        data = r.json()
        recs = data[0].get("data") if data and isinstance(data, list) else None
        if not recs:
            return None
        d = recs[0]
        sector = d.get("marketSector") or ""
        desc = d.get("securityDescription") or d.get("ticker") or ""
        coupon = mat = years = None
        if sector in ("Corp", "Muni", "Govt", "Mtge"):
            coupon, mat = _parse_bond_desc(desc)
            if mat:
                try:
                    years = round((date.fromisoformat(mat) - date.today()).days / 365.25, 2)
                except ValueError:
                    mat = None
        type_label = {"Corp": "Corporate Bond", "Muni": "Municipal Bond",
                      "Govt": "Government Bond", "Mtge": "Mortgage Security"}.get(
                          sector, d.get("securityType2") or d.get("securityType") or "Security")
        return {
            "found": True, "source": "openfigi", "cusip": cusip,
            "name": d.get("name") or cusip,
            "ticker": d.get("ticker"),
            "description": desc or None,
            "type": type_label,
            "market_sector": sector or None,
            "coupon_rate": coupon, "maturity_date": mat, "years_to_maturity": years,
        }
    except Exception:
        return None


@router.get("/cusip/{cusip}")
def bond_by_cusip(cusip: str):
    """Resolve a CUSIP to a security: Treasuries get full coupon/maturity (free
    TreasuryDirect); other securities get identity only (OpenFIGI). Priced
    corporate-bond data needs a licensed feed and is intentionally not fetched."""
    cu = cusip.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{9}", cu):
        raise HTTPException(400, "CUSIP must be 9 alphanumeric characters")
    cached = disk_get(f"cusip:{cu}")
    if cached is not None:
        return cached
    result = _lookup_treasury(cu) or _lookup_openfigi(cu) or {"found": False, "cusip": cu}
    if result.get("found"):
        disk_set(f"cusip:{cu}", result, ttl=604800)   # 7 days; CUSIP facts are static
    return result


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
