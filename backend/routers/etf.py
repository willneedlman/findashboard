"""ETF X-ray — look-through holdings, overlap, and concentration.

Two holdings sources:
  - SSGA: SPDR funds publish a full daily holdings .xlsx (Name/Ticker/Weight),
    the same ungated feed bond_prices.py uses. Complete holdings.
  - stockanalysis.com: a JSON endpoint covering essentially any ETF, but only
    the TOP 25 holdings. Used for non-SPDR funds (QQQ, Vanguard, iShares, ARK…),
    flagged partial so overlap/look-through is read with the right caveat.

Other issuers' own feeds (Invesco, iShares, Vanguard) are bot-blocked server-side,
hence the stockanalysis.com fallback.
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

_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"}

# fund -> (source, key, label). source "ssga" = full; "sa" = stockanalysis top-25.
SUPPORTED: dict[str, tuple[str, str, str]] = {
    # SPDR / SSGA — full holdings
    "SPY":  ("ssga", "spy",  "S&P 500"),
    "DIA":  ("ssga", "dia",  "Dow 30"),
    "MDY":  ("ssga", "mdy",  "S&P MidCap 400"),
    "SPYG": ("ssga", "spyg", "S&P 500 Growth"),
    "SPYV": ("ssga", "spyv", "S&P 500 Value"),
    "XLK":  ("ssga", "xlk",  "Technology"),
    "XLF":  ("ssga", "xlf",  "Financials"),
    "XLE":  ("ssga", "xle",  "Energy"),
    "XLV":  ("ssga", "xlv",  "Health Care"),
    "XLY":  ("ssga", "xly",  "Consumer Disc."),
    "XLP":  ("ssga", "xlp",  "Consumer Staples"),
    "XLI":  ("ssga", "xli",  "Industrials"),
    "XLB":  ("ssga", "xlb",  "Materials"),
    "XLRE": ("ssga", "xlre", "Real Estate"),
    "XLU":  ("ssga", "xlu",  "Utilities"),
    "XLC":  ("ssga", "xlc",  "Communication"),
    # Other issuers — full holdings via Alpha Vantage when ALPHAVANTAGE_API_KEY is
    # set, else top-25 via stockanalysis.com (flagged partial). See _load.
    "QQQ":  ("sa", "QQQ",  "Nasdaq-100"),
    "VOO":  ("sa", "VOO",  "Vanguard S&P 500"),
    "VTI":  ("sa", "VTI",  "Vanguard Total Market"),
    "VXUS": ("sa", "VXUS", "Vanguard Total Int'l"),
    "VEA":  ("sa", "VEA",  "Vanguard Developed Mkts"),
    "VWO":  ("sa", "VWO",  "Vanguard Emerging Mkts"),
    "VUG":  ("sa", "VUG",  "Vanguard Growth"),
    "VTV":  ("sa", "VTV",  "Vanguard Value"),
    "VIG":  ("sa", "VIG",  "Vanguard Dividend Appr."),
    "VYM":  ("sa", "VYM",  "Vanguard High Dividend"),
    "VGT":  ("sa", "VGT",  "Vanguard Info Tech"),
    "IVV":  ("sa", "IVV",  "iShares S&P 500"),
    "IWM":  ("sa", "IWM",  "Russell 2000"),
    "SCHD": ("sa", "SCHD", "Schwab Dividend"),
    "ARKK": ("sa", "ARKK", "ARK Innovation"),
    "ARKW": ("sa", "ARKW", "ARK Next-Gen Internet"),
    "ARKG": ("sa", "ARKG", "ARK Genomic"),
    "ARKF": ("sa", "ARKF", "ARK Fintech"),
    "ARKQ": ("sa", "ARKQ", "ARK Autonomous & Robotics"),
}


@cached(ttl=86_400, maxsize=64)
def _spdr_holdings(fund: str) -> dict:
    """Full holdings for one SPDR equity fund via the SSGA daily .xlsx."""
    import openpyxl
    url = ("https://www.ssga.com/us/en/intermediary/library-content/products/"
           f"fund-data/etfs/us/holdings-daily-us-en-{fund.lower()}.xlsx")
    resp = requests.get(url, headers=_UA, timeout=20)
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
        if t not in holdings or wt > holdings[t]["weight"]:
            holdings[t] = {"name": str(nm).strip() if nm else t, "weight": round(wt, 4)}
    return {"as_of": as_of, "name": fund_name, "holdings": holdings, "partial": False, "total": len(holdings)}


@cached(ttl=86_400, maxsize=128)
def _sa_holdings(ticker: str) -> dict:
    """Top-25 holdings for any ETF via stockanalysis.com's JSON endpoint."""
    url = f"https://stockanalysis.com/api/symbol/e/{ticker.upper()}/holdings"
    resp = requests.get(url, headers=_UA, timeout=20)
    if resp.status_code != 200:
        return {}
    d = (resp.json() or {}).get("data", {})
    holdings: dict[str, dict] = {}
    for h in d.get("holdings", []):
        raw = str(h.get("s") or "").strip()
        if not raw:
            continue
        # "$NVDA" for US listings; "!tpe/2330" for foreign listings (exch/code).
        sym = raw[1:].upper() if raw.startswith("$") else raw.split("/")[-1].upper() if raw.startswith("!") else raw.upper()
        if not sym:
            continue
        try:
            wt = float(str(h.get("as") or "").rstrip("%"))
        except ValueError:
            continue
        if wt <= 0:
            continue
        holdings[sym] = {"name": str(h.get("n") or sym).strip(), "weight": round(wt, 4)}
    return {"as_of": d.get("date"), "name": None, "holdings": holdings,
            "partial": True, "total": d.get("count") or len(holdings)}


@cached(ttl=86_400, maxsize=128)
def _av_holdings(ticker: str) -> dict:
    """FULL holdings for any ETF via Alpha Vantage ETF_PROFILE (free key, 25/day).
    Complete constituents with weights — used for non-SPDR funds when a key is set,
    otherwise the caller falls back to the top-25 source. Cached 24h to stay within
    the free quota; returns {} on missing key / quota / error so the fallback runs."""
    key = os.getenv("ALPHAVANTAGE_API_KEY")
    if not key:
        return {}
    try:
        resp = requests.get("https://www.alphavantage.co/query",
                            params={"function": "ETF_PROFILE", "symbol": ticker.upper(), "apikey": key},
                            headers=_UA, timeout=20)
        if resp.status_code != 200:
            return {}
        d = resp.json() or {}
    except Exception:
        return {}
    raw = d.get("holdings")
    if not raw or "Information" in d or "Note" in d:   # quota hit / rate-limited → fall back
        return {}
    holdings: dict[str, dict] = {}
    for h in raw:
        sym = str(h.get("symbol") or "").strip().upper()
        if not sym or sym in ("N/A", "CASH", "USD", "-"):
            continue
        try:
            wt = float(h.get("weight") or 0) * 100.0   # AV returns a decimal fraction
        except (TypeError, ValueError):
            continue
        if wt <= 0:
            continue
        holdings[sym] = {"name": str(h.get("description") or sym).strip(), "weight": round(wt, 4)}
    if not holdings:
        return {}
    return {"as_of": None, "name": None, "holdings": holdings, "partial": False, "total": len(holdings)}


def _load(fund: str) -> dict:
    """Unified holdings load for a supported fund, tagged with src/label."""
    meta = SUPPORTED.get(fund)
    if not meta:
        return {}
    src, key, label = meta
    # SPDR → SSGA (full). Others → Alpha Vantage full holdings when a key is set,
    # else the stockanalysis top-25 (flagged partial).
    d = _spdr_holdings(key) if src == "ssga" else (_av_holdings(key) or _sa_holdings(key))
    if d and d.get("holdings"):
        d = dict(d)
        d["label"] = label
        d["name"] = d.get("name") or label
        d["src"] = src
    return d


@router.get("/supported")
def supported():
    return {"funds": [
        {"ticker": k, "label": v[2], "partial": v[0] == "sa"} for k, v in SUPPORTED.items()
    ]}


@router.get("/holdings")
def holdings(fund: str):
    f = fund.strip().upper()
    data = _load(f)
    if not data or not data.get("holdings"):
        raise HTTPException(404, f"No holdings available for {f}")
    rows = sorted(
        ({"ticker": t, "name": h["name"], "weight": h["weight"]} for t, h in data["holdings"].items()),
        key=lambda r: r["weight"], reverse=True,
    )
    return {"fund": f, "name": data["name"], "as_of": data["as_of"], "count": len(rows),
            "partial": data.get("partial", False), "total": data.get("total"), "holdings": rows}


class XrayRequest(BaseModel):
    funds: list[str] = []


@router.post("/xray")
def xray(req: XrayRequest):
    funds = [f.strip().upper() for f in req.funds if f.strip()][:8]
    if len(funds) < 1:
        raise HTTPException(422, "Select at least one ETF")

    loaded: dict[str, dict] = {}
    for f in funds:
        d = _load(f)
        if d and d.get("holdings"):
            loaded[f] = d
    if len(loaded) < 1:
        raise HTTPException(404, "Could not load holdings for the selected ETF(s)")

    funds = list(loaded.keys())
    w = 1.0 / len(funds)  # equal-weight blend across the selected funds

    # Look-through aggregate: blended weight of each underlying across the basket.
    # by_fund keeps the holding's raw weight in each fund so the UI can re-blend
    # over a selected subset (the "union of these ETFs" view).
    agg: dict[str, dict] = {}
    for f, d in loaded.items():
        for t, h in d["holdings"].items():
            a = agg.setdefault(t, {"ticker": t, "name": h["name"], "weight": 0.0, "funds": [], "by_fund": {}})
            a["weight"] += h["weight"] * w
            a["funds"].append(f)
            a["by_fund"][f] = round(h["weight"], 4)
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
            "partial": d.get("partial", False), "coverage": round(sum(hs), 1), "total": d.get("total"),
        })

    return {
        "funds": per_fund,
        "unique_holdings": len(agg),
        "overlapping_holdings": sum(1 for a in agg.values() if len(a["funds"]) > 1),
        "any_partial": any(p["partial"] for p in per_fund),
        "aggregate": aggregate,
        "overlap": overlap,
    }
