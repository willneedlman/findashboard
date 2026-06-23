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


def _search_openfigi_issuer(q: str):
    """Issuer-name -> list of that issuer's corporate bonds via OpenFIGI search
    (free). Results carry coupon + maturity in the description but no CUSIP (it is
    licensed), so they price at par and resolve to reference terms only."""
    try:
        r = requests.post("https://api.openfigi.com/v3/search",
                          json={"query": q, "marketSecDes": "Corp"},
                          headers={"Content-Type": "application/json"}, timeout=12)
        if r.status_code != 200:
            return []
        recs = r.json().get("data") or []
    except Exception:
        return []
    out, seen = [], set()
    today = date.today()
    for d in recs:
        desc = d.get("securityDescription") or d.get("ticker") or ""
        coupon, mat = _parse_bond_desc(desc)
        if coupon is None or not mat:
            continue
        try:
            mdate = date.fromisoformat(mat)
        except ValueError:
            continue
        if mdate <= today:
            continue
        key = (round(coupon, 3), mat)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "found": True, "source": "openfigi-search", "cusip": "",
            "figi": d.get("figi"),
            "name": d.get("name") or q.upper(),
            "ticker": d.get("ticker"),
            "description": desc or None,
            "type": "Corporate Bond", "market_sector": "Corp",
            "coupon_rate": coupon, "maturity_date": mat,
            "years_to_maturity": round((mdate - today).days / 365.25, 2),
        })
    out.sort(key=lambda b: b["maturity_date"])
    return out[:15]


@router.get("/search")
def bond_search(q: str):
    """Resolve an issuer name to its outstanding corporate bonds. Identity-only
    (no CUSIP, no price) because that data is licensed; returns parseable
    coupon/maturity so each candidate can be analyzed at par or imported."""
    qn = (q or "").strip()
    if len(qn) < 2:
        return {"query": qn, "results": []}
    key = f"bondsearch:{qn.lower()}"
    cached = disk_get(key)
    if cached is not None:
        return cached
    results = _search_openfigi_issuer(qn)
    payload = {"query": qn, "results": results}
    if results:
        disk_set(key, payload, ttl=86400)
    return payload


def _resolve_cusip(cu: str) -> dict:
    """Identity (Treasury or OpenFIGI, cached 7d) plus the latest free price mark."""
    ident = disk_get(f"cusipid:{cu}")
    if ident is None:
        ident = _lookup_treasury(cu) or _lookup_openfigi(cu) or {"found": False, "cusip": cu}
        if ident.get("found"):
            disk_set(f"cusipid:{cu}", ident, ttl=604800)
    result = dict(ident)
    if result.get("found"):
        try:
            import bond_prices
            px = bond_prices.price_for_cusip(cu)
            if px:
                for k in ("market_price", "price_source", "price_as_of"):
                    if px.get(k) is not None:
                        result[k] = px[k]
                # Backfill terms from the ETF holding when the identity lookup
                # missed them, so a priced bond always has the coupon + maturity
                # needed to solve a yield.
                if result.get("coupon_rate") is None and px.get("coupon_rate") is not None:
                    result["coupon_rate"] = px["coupon_rate"]
                if result.get("maturity_date") is None and px.get("maturity_date"):
                    result["maturity_date"] = px["maturity_date"]
                    try:
                        result["years_to_maturity"] = round(
                            (date.fromisoformat(px["maturity_date"]) - date.today()).days / 365.25, 2)
                    except ValueError:
                        pass
        except Exception:
            pass
    return result


@router.get("/cusip/{cusip}")
def bond_by_cusip(cusip: str):
    """Resolve a CUSIP to a security: Treasuries get full coupon/maturity (free
    TreasuryDirect); other securities get identity only (OpenFIGI). Priced
    corporate-bond data needs a licensed feed and is intentionally not fetched."""
    cu = cusip.strip().upper()
    if not re.fullmatch(r"[A-Z0-9]{9}", cu):
        raise HTTPException(400, "CUSIP must be 9 alphanumeric characters")
    return _resolve_cusip(cu)


class CusipBatch(BaseModel):
    cusips: list[str] = Field(default_factory=list, max_length=100)


@router.post("/cusip/batch")
def bond_cusip_batch(req: CusipBatch):
    """Resolve a pasted list of CUSIPs into a flat table: issuer, coupon,
    maturity, price mark, computed yield, and the price as-of date. Yield is
    solved only when a price mark exists; without one it is left blank rather
    than echoing the coupon as an at-par figure."""
    rows, seen = [], set()
    for raw in req.cusips[:100]:
        cu = (raw or "").strip().upper()
        if not cu or cu in seen:
            continue
        seen.add(cu)
        if not re.fullmatch(r"[A-Z0-9]{9}", cu):
            rows.append({"cusip": cu, "found": False, "error": "invalid"})
            continue
        r = _resolve_cusip(cu)
        if not r.get("found"):
            rows.append({"cusip": cu, "found": False})
            continue
        ytm = None
        coupon, yrs, mp = r.get("coupon_rate"), r.get("years_to_maturity"), r.get("market_price")
        if coupon is not None and yrs and mp is not None:
            ytm = round(solve_ytm(1000, coupon, round((mp / 100) * 1000), max(1, round(yrs))) * 100, 4)
        rows.append({
            "cusip": cu, "found": True,
            "name": r.get("name"), "type": r.get("type"),
            "coupon_rate": coupon, "maturity_date": r.get("maturity_date"),
            "market_price": r.get("market_price"), "price_source": r.get("price_source"),
            "price_as_of": r.get("price_as_of"), "ytm": ytm,
        })
    return {"rows": rows}


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
