"""Live market context (equity levels, VIX, yields, DXY, Fed-funds futures).

Ported from the legacy `_fetch_market_context`. In the new design this no longer
feeds a scoring prompt — the lexicon scores text directly — but the context is
still returned in the snapshot payload and rendered by the frontend, so it is
preserved verbatim (same dict shape) with its own short TTL cache.
"""
from __future__ import annotations

import logging
import os
import sys
import threading
import time
from datetime import date
from typing import Any

import requests

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))))
from cache import get_history  # noqa: E402

from sentiment import config  # noqa: E402

_log = logging.getLogger(__name__)

_ZQ_MONTH = {1: 'F', 2: 'G', 3: 'H', 4: 'J', 5: 'K', 6: 'M',
             7: 'N', 8: 'Q', 9: 'U', 10: 'V', 11: 'X', 12: 'Z'}

_FOMC_DATES = [
    "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18",
    "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10",
    "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17",
    "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
    "2027-01-27", "2027-03-17", "2027-04-28", "2027-06-16",
    "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08",
]

_cache: dict[str, Any] | None = None
_expires: float = 0.0
_lock = threading.Lock()


def fetch_market_context() -> dict[str, Any]:
    """Equity/macro levels + Fed-funds futures cut probabilities. Cached briefly."""
    global _cache, _expires
    now = time.time()
    with _lock:
        if _cache is not None and now < _expires:
            return _cache

    ctx: dict[str, Any] = {}
    try:
        def _pct(new: float, old: float) -> float:
            return round((new / old - 1) * 100, 2) if old else 0.0

        for sym, key in [
            ("^GSPC", "sp500"), ("^IXIC", "nasdaq"), ("^VIX", "vix"),
            ("^TNX", "yield_10y"), ("^IRX", "yield_3m"), ("DX-Y.NYB", "dxy"),
            ("GC=F", "gold"), ("CL=F", "oil"), ("NG=F", "natgas"), ("BTC-USD", "btc"),
        ]:
            try:
                hist = get_history(sym, period="6mo")
                if hist.empty:
                    continue
                c = hist["Close"].dropna()
                if len(c) < 2:
                    continue
                price = float(c.iloc[-1])
                entry: dict[str, Any] = {
                    "current": round(price, 2),
                    "chg_1d": _pct(price, float(c.iloc[-2])) if len(c) > 1 else 0.0,
                    "chg_5d": _pct(price, float(c.iloc[-6])) if len(c) > 5 else 0.0,
                    "chg_1m": _pct(price, float(c.iloc[-22])) if len(c) > 21 else 0.0,
                }
                if key == "sp500":
                    ytd = c[c.index.year == date.today().year]
                    if len(ytd) > 0:
                        entry["chg_ytd"] = _pct(price, float(ytd.iloc[0]))
                if key == "vix":
                    entry["regime"] = (
                        "low" if price < 15 else "normal" if price < 20
                        else "elevated" if price < 30 else "high"
                    )
                    entry["avg_30d"] = round(float(c.tail(22).mean()), 1)
                ctx[key] = entry
            except Exception as _e:
                _log.debug("Market ctx %s: %s", sym, _e)

        if "yield_10y" in ctx and "yield_3m" in ctx:
            spread = round(ctx["yield_10y"]["current"] - ctx["yield_3m"]["current"], 3)
            ctx["yield_curve"] = {
                "spread_3m10y": spread,
                "shape": "inverted" if spread < -0.1 else "flat" if spread < 0.3 else "normal",
            }

        ffr: float | None = ctx.get("yield_3m", {}).get("current")
        fed: dict[str, Any] = {}
        if ffr is not None:
            fed["effective_rate_proxy"] = round(ffr, 2)
            fed["note"] = "3M T-bill proxy"

        fred_key = os.getenv("FRED_API_KEY", "")
        if fred_key:
            try:
                r = requests.get(
                    "https://api.stlouisfed.org/fred/series/observations",
                    params={"series_id": "DFF", "api_key": fred_key,
                            "file_type": "json", "sort_order": "desc", "limit": "5"},
                    timeout=5,
                )
                if r.status_code == 200:
                    for obs in r.json().get("observations", []):
                        val = obs.get("value")
                        if val and val != ".":
                            ffr = float(val)
                            fed = {"effective_rate": round(ffr, 2)}
                            break
            except Exception:
                pass

        today = date.today()
        upcoming = [date.fromisoformat(d) for d in _FOMC_DATES if date.fromisoformat(d) >= today][:3]

        cut_probs: list[dict[str, Any]] = []
        for mtg in upcoming:
            try:
                zq = f"ZQ{_ZQ_MONTH[mtg.month]}{str(mtg.year)[-2:]}=F"
                zh = get_history(zq, period="5d")
                if zh.empty:
                    continue
                zq_price = float(zh["Close"].iloc[-1])
                impl_rate = round(100.0 - zq_price, 4)
                bps_priced = round((ffr - impl_rate) * 100, 1) if ffr is not None else 0.0

                prob = 0.0
                if ffr is not None and ffr > 0:
                    import calendar as _cal
                    days_total = _cal.monthrange(mtg.year, mtg.month)[1]
                    days_before = (mtg - date(mtg.year, mtg.month, 1)).days
                    days_after = days_total - days_before
                    if days_after > 0:
                        new_implied = (impl_rate * days_total - days_before * ffr) / days_after
                        prob = max(0.0, min(1.0, (ffr - new_implied) / 0.25))

                cut_probs.append({
                    "meeting": mtg.isoformat(), "ticker": zq, "implied_rate": impl_rate,
                    "bps_priced": bps_priced, "prob_cut_25bp": round(prob * 100, 1),
                })
            except Exception as _e:
                _log.debug("ZQ futures %s: %s", mtg, _e)

        if cut_probs:
            fed["cut_probabilities"] = cut_probs

        dec_year = today.year if today.month <= 11 else today.year + 1
        try:
            zq_dec = f"ZQ{_ZQ_MONTH[12]}{str(dec_year)[-2:]}=F"
            zh_dec = get_history(zq_dec, period="5d")
            if not zh_dec.empty and ffr is not None:
                dec_impl = 100.0 - float(zh_dec["Close"].iloc[-1])
                cum_bps = round((ffr - dec_impl) * 100, 0)
                fed["cumulative_bps_eoy"] = cum_bps
                fed["implied_cuts_eoy"] = round(cum_bps / 25, 1)
        except Exception:
            pass

        if fed:
            ctx["fed_policy"] = fed
    except Exception as ex:
        _log.warning("fetch_market_context failed: %s", ex)

    with _lock:
        _cache = ctx
        _expires = time.time() + config.MARKET_CTX_TTL
    return ctx
