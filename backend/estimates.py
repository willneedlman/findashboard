"""Analyst estimate revisions.

The terminal already shows where consensus *is* — mean EPS, price target, the
buy/hold/sell split. This is where consensus has been *going*, which is the part
that carries the signal: revision breadth is one of the more durable equity
factors, and a target of $300 that was $250 a month ago is a different fact from
one that was $350.

Three views of the same question, all from feeds already in use:

  drift      consensus EPS now against 7, 30, 60 and 90 days ago, per period
  breadth    how many analysts revised up against down over 7 and 30 days
  targets    price-target raises and cuts from the recent action feed

Nothing here is annualised or scored. A revision count is a count, and turning
four upgrades into a 0-100 "momentum score" would invent precision the input
does not have.
"""
from __future__ import annotations

import datetime as _dt

import pandas as pd

from cache import cached, _run_yf

# Yahoo labels the fiscal periods relative to now.
_PERIOD_LABEL = {
    "0q": "Current quarter",
    "+1q": "Next quarter",
    "0y": "Current year",
    "+1y": "Next year",
}
_AGO_COLUMNS = [("7daysAgo", 7), ("30daysAgo", 30), ("60daysAgo", 60), ("90daysAgo", 90)]


def _num(value) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return None if pd.isna(out) else out


def _pct(now: float | None, then: float | None) -> float | None:
    if now is None or then in (None, 0):
        return None
    return round((now / then - 1.0) * 100, 2)


def _drift(eps_trend: pd.DataFrame | None) -> list[dict]:
    if eps_trend is None or eps_trend.empty:
        return []
    rows = []
    for period, row in eps_trend.iterrows():
        current = _num(row.get("current"))
        if current is None:
            continue
        entry = {
            "period": str(period),
            "label": _PERIOD_LABEL.get(str(period), str(period)),
            "current": round(current, 4),
        }
        for column, days in _AGO_COLUMNS:
            then = _num(row.get(column))
            entry[f"d{days}"] = round(then, 4) if then is not None else None
            entry[f"d{days}_pct"] = _pct(current, then)
        rows.append(entry)
    return rows


def _breadth(eps_revisions: pd.DataFrame | None) -> list[dict]:
    if eps_revisions is None or eps_revisions.empty:
        return []
    rows = []
    for period, row in eps_revisions.iterrows():
        up7 = _num(row.get("upLast7days")) or 0
        # Yahoo's casing is inconsistent between the two 7-day columns.
        down7 = _num(row.get("downLast7Days")) or _num(row.get("downLast7days")) or 0
        up30 = _num(row.get("upLast30days")) or 0
        down30 = _num(row.get("downLast30days")) or 0
        rows.append({
            "period": str(period),
            "label": _PERIOD_LABEL.get(str(period), str(period)),
            "up_7d": int(up7), "down_7d": int(down7),
            "up_30d": int(up30), "down_30d": int(down30),
            "net_30d": int(up30 - down30),
        })
    return rows


def _targets(actions: pd.DataFrame | None, days: int = 120) -> dict:
    """Price-target moves from the recent analyst action feed."""
    if actions is None or actions.empty:
        return {"raises": 0, "cuts": 0, "maintains": 0, "recent": []}
    frame = actions.copy()
    try:
        frame = frame[frame.index >= (pd.Timestamp.utcnow().tz_localize(None) - pd.Timedelta(days=days))]
    except Exception:
        frame = frame.head(40)

    raises = cuts = maintains = 0
    recent = []
    for stamp, row in frame.head(40).iterrows():
        action = str(row.get("priceTargetAction") or "").strip()
        current = _num(row.get("currentPriceTarget"))
        prior = _num(row.get("priorPriceTarget"))
        if action == "Raises":
            raises += 1
        elif action in ("Lowers", "Cuts"):
            cuts += 1
        elif action == "Maintains":
            maintains += 1
        recent.append({
            "date": str(stamp)[:10],
            "firm": str(row.get("Firm") or "").strip() or None,
            "action": action or None,
            "to_grade": str(row.get("ToGrade") or "").strip() or None,
            "from_grade": str(row.get("FromGrade") or "").strip() or None,
            # A brand-new coverage initiation reports a prior target of 0, which
            # is an absence, not a target of zero.
            "target": current,
            "prior_target": prior if prior else None,
        })
    return {"raises": raises, "cuts": cuts, "maintains": maintains, "window_days": days, "recent": recent[:12]}


@cached(ttl=6 * 3600, maxsize=256, persist=True)
def revisions(ticker: str) -> dict:
    import yfinance as yf
    symbol = ticker.strip().upper()
    stock = yf.Ticker(symbol)

    def pull(attr):
        try:
            return _run_yf(f"{attr} {symbol}", lambda: getattr(stock, attr))
        except Exception:
            return None

    drift = _drift(pull("eps_trend"))
    breadth = _breadth(pull("eps_revisions"))
    targets = _targets(pull("upgrades_downgrades"))
    estimate = pull("earnings_estimate")

    coverage = None
    if estimate is not None and not estimate.empty:
        try:
            coverage = int(_num(estimate.loc["0y"].get("numberOfAnalysts")) or 0) or None
        except Exception:
            coverage = None

    if not drift and not breadth and not targets["recent"]:
        return {"available": False, "reason": "No analyst estimates are published for this symbol."}

    # The headline is the current fiscal year, which is what "estimates are
    # rising" normally means.
    year = next((d for d in drift if d["period"] == "0y"), None)
    year_breadth = next((b for b in breadth if b["period"] == "0y"), None)
    direction = "flat"
    if year and year.get("d90_pct") is not None:
        if year["d90_pct"] > 0.5:
            direction = "rising"
        elif year["d90_pct"] < -0.5:
            direction = "falling"

    return {
        "available": True,
        "ticker": symbol,
        "as_of": _dt.date.today().isoformat(),
        "analyst_count": coverage,
        "direction": direction,
        "headline": {
            "period": "Current year",
            "current": year["current"] if year else None,
            "change_30d_pct": year.get("d30_pct") if year else None,
            "change_90d_pct": year.get("d90_pct") if year else None,
            "up_30d": year_breadth["up_30d"] if year_breadth else None,
            "down_30d": year_breadth["down_30d"] if year_breadth else None,
        },
        "drift": drift,
        "breadth": breadth,
        "targets": targets,
    }


# v2 added the offset-0 anchor. Without the bump the persisted v1 payload
# keeps being served and the consensus line stays detached for the whole TTL.
@cached(ttl=6 * 3600, maxsize=256, persist=True, version=2)
def forward_periods(ticker: str) -> list[dict]:
    """Consensus EPS and revenue for the two fiscal years not yet reported.

    Yahoo labels these 0y and +1y: the year underway and the one after it. SEC
    only carries a fiscal year once its 10-K is filed, so the first unreported
    year is always the last reported one plus one, and no date arithmetic is
    needed to line them up.

    The basis is not the same. Consensus EPS is normally an adjusted figure
    while the reported line is GAAP, and Yahoo's revenue can aggregate segments
    differently, so these come back as their own fields rather than as a
    continuation of the reported series.
    """
    import yfinance as yf
    symbol = ticker.strip().upper()
    stock = yf.Ticker(symbol)

    def pull(attr):
        try:
            return _run_yf(f"{attr} {symbol}", lambda: getattr(stock, attr))
        except Exception:
            return None

    eps, rev = pull("earnings_estimate"), pull("revenue_estimate")
    out = []
    # Offset 0 is the last REPORTED year, carrying this source's own figure for
    # it. Without it the consensus line starts in mid-air one year to the right
    # of where the reported line ends, and the two never join. Anchoring on the
    # source's own prior-year number rather than the filed one keeps the whole
    # consensus line on one basis.
    if eps is not None and "0y" in eps.index:
        anchor_eps = _num(eps.loc["0y"].get("yearAgoEps"))
        anchor_rev = _num(rev.loc["0y"].get("yearAgoRevenue")) if rev is not None and "0y" in rev.index else None
        if anchor_eps is not None or anchor_rev is not None:
            out.append({"offset": 0, "epsEstimate": anchor_eps, "revenueEstimate": anchor_rev,
                        "analysts": None})
    for offset, period in ((1, "0y"), (2, "+1y")):
        e = _num(eps.loc[period].get("avg")) if eps is not None and period in eps.index else None
        r = _num(rev.loc[period].get("avg")) if rev is not None and period in rev.index else None
        if e is None and r is None:
            continue
        n = _num(eps.loc[period].get("numberOfAnalysts")) if eps is not None and period in eps.index else None
        out.append({"offset": offset, "epsEstimate": e, "revenueEstimate": r,
                    "analysts": int(n) if n else None})
    return out
