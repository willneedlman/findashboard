"""Business-cycle read from the FRED series the Macro Monitor already pulls.

Deliberately not a recession probability. A single percentage implies a
calibrated model behind it, and there is no such model here: this is a handful
of well-known indicators, each scored against a published rule of thumb, added
up. What the panel owes the reader is the components and their thresholds, so
the number can be argued with — a black-box "37% chance of recession" cannot be.

Five components, each contributing -1 (contractionary) to +1 (expansionary):

  curve      10y minus 2y. Inversion has led every US recession since 1970,
             with a long and variable lag, so it scores on the level.
  claims     initial jobless claims against their own 12-month low. Claims
             turning up off a trough is among the earliest labour signals.
  unemploy   the Sahm rule: 3-month average unemployment against its trailing
             12-month minimum. Half a point is the documented trigger.
  payrolls   3-month average monthly job growth.
  credit     high-yield option-adjusted spread, which widens before earnings
             break.

The composite is the mean of whatever components resolved, so a dead feed
narrows the base rather than silently scoring zero.
"""
from __future__ import annotations

import datetime as _dt

from cache import cached

# (series, label, how to read it) — thresholds are stated on the component so
# the UI can print them next to the score.
_SAHM_TRIGGER = 0.50      # percentage points, Sahm (2019)
_CLAIMS_WARN = 15.0       # percent above the 12-month low


def _values(series_id: str, limit: int) -> list[dict]:
    import fred
    try:
        return fred.observations(series_id, limit) or []
    except Exception:
        return []


def _score(value: float, good: float, bad: float) -> float:
    """Linear score in [-1, 1]: +1 at `good`, -1 at `bad`, clamped."""
    if good == bad:
        return 0.0
    raw = (value - bad) / (good - bad) * 2 - 1
    return round(max(-1.0, min(1.0, raw)), 3)


def _curve() -> dict | None:
    obs = _values("T10Y2Y", 300)
    if not obs:
        return None
    level = float(obs[-1]["value"])
    return {
        "key": "curve",
        "label": "Yield curve, 10y minus 2y",
        "value": round(level, 2),
        "unit": "pp",
        "as_of": obs[-1]["date"],
        # Inverted is the warning; a percentage point of positive slope is normal.
        "score": _score(level, good=1.0, bad=-0.5),
        "reading": "inverted" if level < 0 else "flat" if level < 0.5 else "normal",
        "rule": "Inversion has preceded every US recession since 1970, with a lag of roughly 6 to 18 months.",
    }


def _claims() -> dict | None:
    obs = _values("ICSA", 60)          # weekly, about 14 months
    if len(obs) < 30:
        return None
    latest = float(obs[-1]["value"])
    trough = min(float(o["value"]) for o in obs)
    above = (latest / trough - 1.0) * 100 if trough else 0.0
    return {
        "key": "claims",
        "label": "Initial claims vs their 12-month low",
        "value": round(above, 1),
        "unit": "%",
        "as_of": obs[-1]["date"],
        "score": _score(above, good=0.0, bad=_CLAIMS_WARN * 2),
        "reading": "rising" if above > _CLAIMS_WARN else "stable",
        "rule": f"More than {_CLAIMS_WARN:.0f}% above the trough is the level that has historically marked a turn.",
    }


def _sahm() -> dict | None:
    obs = _values("UNRATE", 24)
    if len(obs) < 15:
        return None
    values = [float(o["value"]) for o in obs]
    recent3 = sum(values[-3:]) / 3
    prior12_min = min(values[-15:-3]) if len(values) >= 15 else min(values[:-3])
    gap = recent3 - prior12_min
    return {
        "key": "unemployment",
        "label": "Sahm gap",
        "value": round(gap, 2),
        "unit": "pp",
        "as_of": obs[-1]["date"],
        "score": _score(gap, good=0.0, bad=_SAHM_TRIGGER * 2),
        "reading": "triggered" if gap >= _SAHM_TRIGGER else "clear",
        "rule": f"The 3-month unemployment average {_SAHM_TRIGGER:.2f}pp above its prior 12-month low is the Sahm trigger.",
    }


def _payrolls() -> dict | None:
    obs = _values("PAYEMS", 8)
    if len(obs) < 4:
        return None
    changes = [float(obs[i]["value"]) - float(obs[i - 1]["value"]) for i in range(1, len(obs))]
    avg3 = sum(changes[-3:]) / min(3, len(changes))
    return {
        "key": "payrolls",
        "label": "Payroll growth, 3-month average",
        "value": round(avg3, 1),
        "unit": "k jobs",
        "as_of": obs[-1]["date"],
        "score": _score(avg3, good=200.0, bad=-50.0),
        "reading": "contracting" if avg3 < 0 else "slow" if avg3 < 100 else "solid",
        "rule": "Roughly 100k a month keeps pace with labour-force growth.",
    }


def _credit() -> dict | None:
    obs = _values("BAMLH0A0HYM2", 300)
    if not obs:
        return None
    level = float(obs[-1]["value"])
    return {
        "key": "credit",
        "label": "High-yield spread",
        "value": round(level, 2),
        "unit": "pp",
        "as_of": obs[-1]["date"],
        "score": _score(level, good=3.0, bad=8.0),
        "reading": "wide" if level > 6 else "elevated" if level > 4.5 else "calm",
        "rule": "Spreads past roughly 6 points mark genuine funding stress.",
    }


@cached(ttl=3600, maxsize=4, persist=True)
def cycle(schema: int = 1) -> dict:
    parts = [c for c in (_curve(), _claims(), _sahm(), _payrolls(), _credit()) if c]
    if not parts:
        return {"available": False, "reason": "No FRED series resolved. Check FRED_API_KEY."}

    composite = sum(p["score"] for p in parts) / len(parts)
    if composite >= 0.35:
        phase, blurb = "Expansion", "The indicators are pointing the same way, and that way is up."
    elif composite >= 0.05:
        phase, blurb = "Late expansion", "Still expanding, but at least one component has rolled over."
    elif composite >= -0.35:
        phase, blurb = "Slowdown", "The signals are mixed and the labour and credit components are softening."
    else:
        phase, blurb = "Contraction", "Most components are at levels that have historically accompanied a recession."

    weakest = min(parts, key=lambda p: p["score"])
    strongest = max(parts, key=lambda p: p["score"])
    return {
        "available": True,
        "as_of": _dt.date.today().isoformat(),
        "composite": round(composite, 3),
        "phase": phase,
        "blurb": blurb,
        "components": parts,
        "resolved": len(parts),
        "expected": 5,
        "weakest": weakest["key"],
        "strongest": strongest["key"],
    }
