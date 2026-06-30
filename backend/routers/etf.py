"""ETF X-ray — look-through holdings, overlap, and concentration.

Source: SPDR/SSGA publish an ungated daily holdings .xlsx per fund (the same
feed bond_prices.py uses for bond SPDRs). Equity SPDR files expose Name /
Ticker / Weight per holding, which is everything the X-ray needs. Scope is the
SPDR family; other issuers (iShares/Vanguard/Invesco) would need their own feeds.
"""
import io
import logging

import requests
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from cache import cached

router = APIRouter()
logger = logging.getLogger(__name__)

# Curated SPDR equity funds the X-ray supports (label for the picker).
SUPPORTED = {
    "SPY": "S&P 500", "DIA": "Dow 30", "MDY": "S&P MidCap 400", "SPMD": "S&P MidCap 400",
    "SPYG": "S&P 500 Growth", "SPYV": "S&P 500 Value", "SPLG": "S&P 500 (low-cost)",
    "XLK": "Technology", "XLF": "Financials", "XLE": "Energy", "XLV": "Health Care",
    "XLY": "Consumer Disc.", "XLP": "Consumer Staples", "XLI": "Industrials",
    "XLB": "Materials", "XLRE": "Real Estate", "XLU": "Utilities", "XLC": "Communication",
}


@cached(ttl=86_400, maxsize=64)
def _spdr_holdings(fund: str) -> dict:
    """{ as_of, name, holdings: {ticker: {name, weight}} } for one SPDR equity fund."""
    import openpyxl
    url = ("https://www.ssga.com/us/en/intermediary/library-content/products/"
           f"fund-data/etfs/us/holdings-daily-us-en-{fund.lower()}.xlsx")
    resp = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=20)
    if resp.status_code != 200 or not resp.content:
        return {}
    wb = openpyxl.load_workbook(io.BytesIO(resp.content), read_only=True, data_only=True)
    rows = list(wb.active.iter_rows(values_only=True))

    as_of = fund_name = None
    hi = None
    for i, row in enumerate(rows):
        cells = [str(c) for c in row if c is not None]
        joined = " ".join(cells)
        if "Fund Name:" in joined and len(cells) > 1:
            fund_name = cells[1]
        if "As of" in joined:
            for c in cells:
                if "As of" in c:
                    as_of = c.split("As of", 1)[1].strip()
        if "Name" in [str(c) for c in row] and "Ticker" in [str(c) for c in row]:
            hi = i
            break
    if hi is None:
        return {}
    hdr = {str(c).strip(): i for i, c in enumerate(rows[hi]) if c}
    if not all(k in hdr for k in ("Name", "Ticker", "Weight")):
        return {}

    holdings: dict[str, dict] = {}
    for row in rows[hi + 1:]:
        tkr = row[hdr["Ticker"]]
        if not tkr or str(tkr).strip() in ("-", ""):
            continue
        try:
            wt = float(row[hdr["Weight"]])
        except (TypeError, ValueError):
            continue
        if wt <= 0:
            continue
        t = str(tkr).strip().upper()
        nm = row[hdr["Name"]]
        # A fund can list a ticker twice (multi-class); keep the larger weight.
        if t not in holdings or wt > holdings[t]["weight"]:
            holdings[t] = {"name": str(nm).strip() if nm else t, "weight": round(wt, 4)}
    return {"as_of": as_of, "name": fund_name or fund.upper(), "holdings": holdings}


@router.get("/supported")
def supported():
    return {"funds": [{"ticker": k, "label": v} for k, v in SUPPORTED.items()]}


@router.get("/holdings")
def holdings(fund: str):
    f = fund.strip().upper()
    data = _spdr_holdings(f)
    if not data or not data.get("holdings"):
        raise HTTPException(404, f"No SPDR holdings available for {f}")
    rows = sorted(
        ({"ticker": t, "name": h["name"], "weight": h["weight"]} for t, h in data["holdings"].items()),
        key=lambda r: r["weight"], reverse=True,
    )
    return {"fund": f, "name": data["name"], "as_of": data["as_of"], "count": len(rows), "holdings": rows}


class XrayRequest(BaseModel):
    funds: list[str] = []


@router.post("/xray")
def xray(req: XrayRequest):
    funds = [f.strip().upper() for f in req.funds if f.strip()][:8]
    if len(funds) < 2:
        raise HTTPException(422, "Select at least two ETFs to compare")

    loaded: dict[str, dict] = {}
    for f in funds:
        d = _spdr_holdings(f)
        if d and d.get("holdings"):
            loaded[f] = d
    if len(loaded) < 2:
        raise HTTPException(404, "Could not load holdings for at least two of the selected ETFs")

    funds = list(loaded.keys())
    w = 1.0 / len(funds)  # equal-weight blend across the selected funds

    # Look-through aggregate: blended weight of each underlying across the basket.
    agg: dict[str, dict] = {}
    for f, d in loaded.items():
        for t, h in d["holdings"].items():
            a = agg.setdefault(t, {"ticker": t, "name": h["name"], "weight": 0.0, "funds": []})
            a["weight"] += h["weight"] * w
            a["funds"].append(f)
    aggregate = sorted(
        ({**a, "weight": round(a["weight"], 4), "fund_count": len(a["funds"])} for a in agg.values()),
        key=lambda r: r["weight"], reverse=True,
    )

    # Pairwise weight-overlap: sum of min(weight) over shared holdings (0-100%).
    overlap = []
    for i in range(len(funds)):
        for j in range(i + 1, len(funds)):
            a, b = loaded[funds[i]]["holdings"], loaded[funds[j]]["holdings"]
            shared = set(a) & set(b)
            ov = sum(min(a[t]["weight"], b[t]["weight"]) for t in shared)
            overlap.append({"a": funds[i], "b": funds[j], "overlap": round(ov, 2), "shared": len(shared)})

    per_fund = []
    for f, d in loaded.items():
        hs = sorted((h["weight"] for h in d["holdings"].values()), reverse=True)
        per_fund.append({
            "fund": f, "name": d["name"], "as_of": d["as_of"],
            "count": len(hs), "top10": round(sum(hs[:10]), 2),
        })

    return {
        "funds": per_fund,
        "unique_holdings": len(agg),
        "overlapping_holdings": sum(1 for a in agg.values() if len(a["funds"]) > 1),
        "aggregate": aggregate,
        "overlap": overlap,
    }
