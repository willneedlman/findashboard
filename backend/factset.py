"""FactSet Overview API client — the Financial Highlights endpoint.

The Emory academic key is entitled to exactly one Overview endpoint,
``/report/overview/v1/financial-highlights``, which returns ~35 statement and
ratio line items across several actual fiscal years plus forward consensus
estimates. This module authenticates (HTTP Basic: username-serial + API key),
parses the STACH 2.0 table into a flat metric map, and exposes both a normalized
table (for display) and a DCF-shaped fundamentals dict (a drop-in preferred
source for the valuation tools).

Everything degrades gracefully: no credentials, a non-covered ticker, an
IP-restricted 401/403, or any parse failure returns None so callers fall back to
their existing sources (FMP, SEC, yfinance, Damodaran). FactSet keys are pinned
to an IP range, so this only returns data from an allowed host.
"""
from __future__ import annotations

import logging
import os
import sys

import requests

sys.path.insert(0, os.path.dirname(__file__))
try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

logger = logging.getLogger(__name__)

_BASE = "https://api.factset.com/report/overview/v1"
_TTL = 24 * 3600                                      # fundamentals move quarterly


def available() -> bool:
    return bool(os.getenv("FACTSET_USERNAME") and os.getenv("FACTSET_API_KEY"))


def _auth() -> tuple[str, str]:
    return (os.getenv("FACTSET_USERNAME", ""), os.getenv("FACTSET_API_KEY", ""))


def _fs_id(ticker: str) -> str:
    """FactSet ids are region-qualified (AAPL -> AAPL-US). Pass through anything
    already qualified or non-US (a dash or a dot means the caller was explicit)."""
    t = ticker.strip().upper()
    return t if ("-" in t or "." in t) else f"{t}-US"


def _num(v):
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None


def financial_highlights(ticker: str, actual: int = 6, estimate: int = 2) -> dict | None:
    """Normalized Financial Highlights for a ticker.

    Returns {ticker, periods: [{label, is_estimate}], metrics: {name: [values...]},
    order newest-first, source, as_of} or None. Cached 24h per (ticker, shape)."""
    if not available():
        return None
    fid = _fs_id(ticker)
    ck = f"factset_fh:{fid}:{actual}:{estimate}"
    cached = disk_get(ck)
    if cached is not None:
        return cached or None                          # {} sentinel = known-empty
    try:
        r = requests.get(
            f"{_BASE}/financial-highlights",
            params={"id": fid, "actual": actual, "estimate": estimate},
            auth=_auth(), timeout=20, headers={"Accept": "application/json"},
        )
        if r.status_code != 200:
            if r.status_code in (401, 403):
                logger.info("FactSet not authorized/reachable (%s) for %s", r.status_code, fid)
            disk_set(ck, {}, ttl=3600)                 # short negative cache
            return None
        body = r.json()
        table = body["data"]["tables"]["main"]["data"]["rows"]
    except Exception as e:
        logger.info("FactSet financial-highlights failed for %s: %s", fid, e)
        disk_set(ck, {}, ttl=1800)
        return None

    header = next((row for row in table if row.get("rowType") == "Header"), None)
    if not header:
        disk_set(ck, {}, ttl=3600)
        return None
    labels = header.get("cells", [])[1:]               # cells[0] is the row-label column
    periods = [{"label": lbl, "is_estimate": i < estimate} for i, lbl in enumerate(labels)]

    metrics: dict[str, list] = {}
    for row in table:
        if row.get("rowType") == "Header":
            continue
        cells = row.get("cells", [])
        name = cells[0] if cells else None
        if not name:
            continue
        metrics[name] = [_num(v) for v in cells[1:]]   # keep last occurrence on dup labels

    out = {
        "ticker": fid, "periods": periods, "metrics": metrics,
        "source": "FactSet Overview", "as_of": (body.get("meta") or {}).get("pagination", {}),
    }
    disk_set(ck, out, ttl=_TTL)
    return out


def _latest(fin: dict, name: str, estimate: bool = False):
    """Latest value for a metric. estimate=False returns the newest ACTUAL period,
    estimate=True the newest estimate period."""
    vals = fin["metrics"].get(name)
    if not vals:
        return None
    idxs = [i for i, p in enumerate(fin["periods"]) if p["is_estimate"] == estimate]
    for i in idxs:
        if i < len(vals) and vals[i] is not None:
            return vals[i]
    return None


def latest_actual(fin: dict, name: str):
    """Newest completed (non-estimate) value for a metric, or None."""
    return _latest(fin, name, estimate=False)


def next_estimate(fin: dict, name: str):
    """The consensus estimate for the period adjacent to the latest actual (one
    year forward), or None. Newest-first ordering puts it at the highest est index."""
    vals = fin["metrics"].get(name)
    if not vals:
        return None
    est_idxs = [i for i, p in enumerate(fin["periods"]) if p["is_estimate"]]
    if not est_idxs:
        return None
    ni = max(est_idxs)
    return vals[ni] if ni < len(vals) else None


def get_dcf_fundamentals(ticker: str) -> dict | None:
    """DCF-shaped fundamentals from FactSet, matching fmp.get_dcf_fundamentals so
    it is a drop-in preferred source. Beta and live price are not in this endpoint,
    so the caller fills those from yfinance. Returns None when uncovered."""
    fin = financial_highlights(ticker)
    if not fin:
        return None
    rev = _latest(fin, "Revenue")
    if not rev or rev <= 0:
        return None

    op_margin = _latest(fin, "EBIT Margin (%)") or _latest(fin, "Operating Margin (%)")
    net_income = _latest(fin, "Net Income")
    eps = _latest(fin, "EPS (Diluted)")
    capex = _latest(fin, "Cap Ex")
    cash = _latest(fin, "Cash & ST Inv")
    equity = _latest(fin, "Total Shareholder Equity")
    de_pct = _latest(fin, "Total Debt / Total Eq (%)")

    # Forward revenue growth from the consensus estimate beats a trailing figure.
    # Use the NEAREST forward estimate (the estimate period adjacent to the last
    # actual), not the farthest, so this is a one-year growth rate.
    rev_vals = fin["metrics"].get("Revenue", [])
    est_idxs = [i for i, p in enumerate(fin["periods"]) if p["is_estimate"]]
    rev_next = None
    if est_idxs:
        ni = max(est_idxs)                             # newest-first: nearest estimate = highest est index
        if ni < len(rev_vals):
            rev_next = rev_vals[ni]
    rev_growth = round((rev_next / rev - 1) * 100, 1) if (rev_next and rev) else None

    shares = round(net_income / eps, 1) if (net_income and eps) else None   # $M / $ = M shares
    total_debt = (de_pct / 100 * equity) if (de_pct is not None and equity) else None
    net_debt = round(total_debt - (cash or 0), 0) if total_debt is not None else None

    return {
        "revenue": round(rev, 0),
        "op_margin": round(op_margin, 1) if op_margin is not None else None,
        "shares": max(0.1, shares) if shares else None,
        "net_debt": net_debt,
        "rev_growth": rev_growth,
        "capex_pct": round(capex / rev * 100, 1) if (capex and rev) else None,
        "da_pct": 4.0,
        "wc_pct": 0.5,
        "tax_rate": 21.0,
        "de_ratio": round(de_pct / 100, 2) if de_pct is not None else 0.0,
        "assumptions_source": "FactSet Overview + consensus estimates",
    }
