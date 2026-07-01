"""Currency matrix: live spot cross-rates, CIP-implied forward points, indicative
cross-currency basis, and short-term realized-vol trends for the G10 majors.

Spot and realized vol are LIVE (yfinance daily FX). Forward points are computed
from covered interest-rate parity using a bundled short-rate table, and the
cross-currency basis is an indicative reference table — true live forwards/basis
need a paid rates feed. All model-based fields are flagged as such in the UI.
"""
import math
import time

import numpy as np
import yfinance as yf
from fastapi import APIRouter, HTTPException

try:
    from disk_cache import disk_get, disk_set
except Exception:  # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

router = APIRouter()

MAJORS = ["EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD"]
NAMES = {
    "USD": "US Dollar", "EUR": "Euro", "GBP": "British Pound", "JPY": "Japanese Yen",
    "CHF": "Swiss Franc", "AUD": "Australian Dollar", "CAD": "Canadian Dollar", "NZD": "New Zealand Dollar",
}
# yfinance FX ticker → (currency, quoted as USD-per-unit?)
PAIRS = {
    "EURUSD=X": ("EUR", True), "GBPUSD=X": ("GBP", True), "AUDUSD=X": ("AUD", True), "NZDUSD=X": ("NZD", True),
    "USDJPY=X": ("JPY", False), "USDCHF=X": ("CHF", False), "USDCAD=X": ("CAD", False),
}
# Indicative 3-month money-market rates (%), for CIP-implied forward points.
SHORT_RATE = {"USD": 4.30, "EUR": 2.40, "JPY": 0.25, "GBP": 4.20, "CHF": 0.50, "AUD": 4.10, "CAD": 2.75, "NZD": 4.50}
# Indicative 3-month cross-currency basis vs USD (bps).
XCCY_3M = {"EUR": -10, "JPY": -38, "GBP": -6, "CHF": -22, "AUD": 6, "CAD": -9, "NZD": 4}
PIP = {"JPY": 0.01}  # default 0.0001


@router.get("/matrix")
def matrix():
    ck = "fx:matrix"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    try:
        data = yf.download(list(PAIRS.keys()), period="2mo", interval="1d", progress=False, auto_adjust=False, threads=True)
    except Exception as e:
        raise HTTPException(502, f"FX feed unavailable: {e}")
    close = data["Close"] if isinstance(data.columns, __import__("pandas").MultiIndex) else data

    tau = 0.25
    uval = {"USD": 1.0}   # USD per 1 unit of currency
    rows = []
    for tk, (ccy, usd_per) in PAIRS.items():
        try:
            s = close[tk].dropna()
        except Exception:
            continue
        if len(s) < 2:
            continue
        spot = float(s.iloc[-1]); prev = float(s.iloc[-2])
        uval[ccy] = spot if usd_per else 1.0 / spot

        ret = np.log(s / s.shift(1)).dropna()
        vol1w = float(ret.tail(5).std() * math.sqrt(252) * 100) if len(ret) >= 5 else None
        vol1m = float(ret.tail(21).std() * math.sqrt(252) * 100) if len(ret) >= 21 else None
        trend = "flat"
        if vol1w and vol1m:
            trend = "up" if vol1w > vol1m * 1.05 else "down" if vol1w < vol1m * 0.95 else "flat"

        # CIP forward in the conventional quote: F = S·(1+r_term·τ)/(1+r_base·τ)
        r_base = SHORT_RATE[ccy] / 100 if usd_per else SHORT_RATE["USD"] / 100
        r_term = SHORT_RATE["USD"] / 100 if usd_per else SHORT_RATE[ccy] / 100
        fwd = spot * (1 + r_term * tau) / (1 + r_base * tau)
        pip = PIP.get(ccy, 0.0001)

        rows.append({
            "ccy": ccy, "name": NAMES[ccy], "pair": f"{ccy}/USD" if usd_per else f"USD/{ccy}",
            "spot": round(spot, 2 if ccy == "JPY" else 4),
            "chg_pct": round((spot / prev - 1) * 100, 2) if prev else None,
            "fwd_pts_3m": round((fwd - spot) / pip, 1),
            "basis_3m_bps": XCCY_3M[ccy],
            "vol_1w": round(vol1w, 1) if vol1w is not None else None,
            "vol_1m": round(vol1m, 1) if vol1m is not None else None,
            "vol_trend": trend,
            "short_rate": SHORT_RATE[ccy],
        })

    ccys = ["USD"] + [r["ccy"] for r in rows]
    grid = [[round(uval[a] / uval[b], 2 if b == "JPY" else 4) for b in ccys] for a in ccys]

    out = {
        "currencies": ccys, "names": NAMES, "matrix": grid, "rows": rows,
        "short_rates": SHORT_RATE, "usd_short_rate": SHORT_RATE["USD"], "as_of": int(time.time()),
    }
    disk_set(ck, out, ttl=900)
    return out
