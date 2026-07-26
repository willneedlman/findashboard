"""Pure reconciliation logic for the Data Audit module.

No network, no DB, no clock of its own — it turns a set of per-source readings
for one (entity, metric) into a verdict:

  - CONFLICT: the spread across sources exceeds a configurable variance threshold
    (e.g. two feeds disagree on price by more than 0.5%).
  - STALE:    a source's underlying datum is older than its per-source TTL.
  - OUTLIER:  a single source deviates from the median beyond an outlier
    threshold (an extreme/incorrect value), surfaced per-cell even when the row
    is already a conflict.

Kept side-effect free so the whole reconciliation can be unit-tested without any
provider, database, or wall clock (callers pass `now`).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import median
from typing import Iterable

# Row status, worst-wins precedence: ERROR > CONFLICT > OUTLIER > STALE > OK.
STATUS_OK = "ok"
STATUS_STALE = "stale"
STATUS_OUTLIER = "outlier"
STATUS_CONFLICT = "conflict"
STATUS_ERROR = "error"

_PRECEDENCE = {STATUS_OK: 0, STATUS_STALE: 1, STATUS_OUTLIER: 2, STATUS_CONFLICT: 3, STATUS_ERROR: 4}

# Defaults — overridable per run via the audit config.
DEFAULT_VARIANCE_PCT = 0.5     # row is a conflict when the source spread exceeds this
DEFAULT_OUTLIER_PCT = 2.0      # a source is an outlier when it deviates from the median by more than this
DEFAULT_TTL_SECONDS = 3600     # a source datum older than this is stale


@dataclass
class SourceReading:
    """One source's reading for a single (entity, metric)."""
    source: str
    value: float | None
    fetched_at: float | None = None   # epoch seconds of the underlying datum (or pull time)
    error: str | None = None
    raw: dict | None = None           # optional raw payload kept for inspection


def _finite(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _pct_diff(a: float, b: float) -> float:
    """Percentage difference of a from b, guarding a zero denominator."""
    denom = abs(b) if b else (abs(a) or 1.0)
    return abs(a - b) / denom * 100.0


def worst_status(statuses: Iterable[str]) -> str:
    out = STATUS_OK
    for s in statuses:
        if _PRECEDENCE.get(s, 0) > _PRECEDENCE.get(out, 0):
            out = s
    return out


def reconcile(
    entity: str,
    metric: str,
    readings: list[SourceReading],
    *,
    variance_pct: float = DEFAULT_VARIANCE_PCT,
    outlier_pct: float = DEFAULT_OUTLIER_PCT,
    ttl_by_source: dict[str, float] | None = None,
    default_ttl: float = DEFAULT_TTL_SECONDS,
    now: float,
) -> dict:
    """Reconcile per-source readings into an audit verdict for one (entity, metric).

    Returns a JSON-ready dict: the primary (median) value, the source spread as a
    percent, a per-source breakdown with stale/outlier flags, and the worst-wins
    row status.
    """
    ttl_by_source = ttl_by_source or {}
    valid = [r for r in readings if r.error is None and _finite(r.value)]
    values = [float(r.value) for r in valid]

    med = float(median(values)) if values else None
    lo = min(values) if values else None
    hi = max(values) if values else None
    spread_pct = (_pct_diff(hi, lo) if (med and len(values) >= 2) else 0.0)
    # Divergence is measured against the median so the number is stable regardless
    # of which pair happens to be the extremes.
    max_dev_pct = max((_pct_diff(v, med) for v in values), default=0.0) if med else 0.0

    sources: list[dict] = []
    any_stale = False
    any_outlier = False
    # An outlier only means something once there are enough sources to define a
    # consensus to deviate from.
    can_outlier = len(values) >= 3

    for r in readings:
        ok = r.error is None and _finite(r.value)
        dev = _pct_diff(float(r.value), med) if (ok and med is not None) else None
        age = (now - r.fetched_at) if r.fetched_at is not None else None
        ttl = ttl_by_source.get(r.source, default_ttl)
        stale = bool(age is not None and age > ttl)
        outlier = bool(ok and can_outlier and dev is not None and dev > outlier_pct)
        if ok and stale:
            any_stale = True
        if outlier:
            any_outlier = True
        sources.append({
            "source": r.source,
            "value": float(r.value) if ok else None,
            "fetchedAt": r.fetched_at,
            "ageSec": round(age, 1) if age is not None else None,
            "stale": stale,
            "outlier": outlier,
            "deviationPct": round(dev, 4) if dev is not None else None,
            "error": r.error,
        })

    if not values:
        status = STATUS_ERROR
    elif len(values) >= 2 and spread_pct > variance_pct:
        status = STATUS_CONFLICT
    elif any_outlier:
        status = STATUS_OUTLIER
    elif any_stale:
        status = STATUS_STALE
    else:
        status = STATUS_OK

    return {
        "entity": entity,
        "metric": metric,
        "primaryValue": round(med, 6) if med is not None else None,
        "median": round(med, 6) if med is not None else None,
        "min": round(lo, 6) if lo is not None else None,
        "max": round(hi, 6) if hi is not None else None,
        "spreadPct": round(spread_pct, 4),
        "maxDeviationPct": round(max_dev_pct, 4),
        "status": status,
        "validCount": len(values),
        "sourceCount": len(readings),
        "sources": sources,
    }


def run_summary(results: list[dict]) -> dict:
    """Roll a list of reconcile() results into per-status counts for a run."""
    counts = {STATUS_OK: 0, STATUS_STALE: 0, STATUS_OUTLIER: 0, STATUS_CONFLICT: 0, STATUS_ERROR: 0}
    for r in results:
        counts[r.get("status", STATUS_OK)] = counts.get(r.get("status", STATUS_OK), 0) + 1
    return {
        "total": len(results),
        "ok": counts[STATUS_OK],
        "stale": counts[STATUS_STALE],
        "outlier": counts[STATUS_OUTLIER],
        "conflict": counts[STATUS_CONFLICT],
        "error": counts[STATUS_ERROR],
        "flagged": counts[STATUS_CONFLICT] + counts[STATUS_OUTLIER] + counts[STATUS_STALE],
    }
