"""UN Comtrade trade-flows endpoint for the Geo-Logistics hub."""
import sys, os
from fastapi import APIRouter, Query, HTTPException

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
import comtrade

router = APIRouter()


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


@router.get("/flows")
def trade_flows(
    reporter: str = Query(..., description="M49 reporter country code"),
    period: str = Query(..., description="4-digit year"),
    cmd: str = Query(..., description="HS commodity code"),
    flow: str = Query("X", description="X exports, M imports"),
):
    """Bilateral trade for one reporter, commodity, year, and flow: the World
    total, a ranked partner breakdown (value + tonnage), and the reporter's world
    trade share. Returns {available:false} when Comtrade is unreachable/empty."""
    if not (period.isdigit() and len(period) == 4):
        raise HTTPException(400, "period must be a 4-digit year")
    if flow not in ("X", "M"):
        raise HTTPException(400, "flow must be X or M")
    rows = comtrade.flows(reporter, period, cmd, flow)
    if not rows:
        return {"available": False}

    world = next((r for r in rows if r.get("partnerCode") == 0), None)
    partners = sorted(
        (r for r in rows if r.get("partnerCode") not in (0, None) and _f(r.get("primaryValue"))),
        key=lambda x: -_f(x["primaryValue"]),
    )
    meta = rows[0]
    ws = comtrade.world_share(reporter, period)

    def leg(r):
        return {
            "partner": comtrade.area_name(r.get("partnerCode")), "iso": comtrade.area_iso(r.get("partnerCode")),
            "value": _f(r.get("primaryValue")), "net_wgt": _f(r.get("netWgt")),
            "qty": _f(r.get("qty")), "unit": r.get("qtyUnitAbbr"),
        }

    return {
        "available": True,
        "reporter": comtrade.area_name(meta.get("reporterCode")), "reporter_iso": comtrade.area_iso(meta.get("reporterCode")),
        "commodity": meta.get("cmdDesc"), "cmd_code": meta.get("cmdCode"),
        "flow": "Exports" if flow == "X" else "Imports", "period": period,
        "total": {"value": _f((world or {}).get("primaryValue")), "net_wgt": _f((world or {}).get("netWgt"))},
        "world_share": ws,
        "partners": [leg(r) for r in partners[:25]],
        "partner_count": len(partners),
        "source": "UN Comtrade (public preview)",
    }
