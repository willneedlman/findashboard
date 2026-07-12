"""Real industry delinquency benchmarks from FRED for the Credit Stress tool.

FRED publishes aggregate delinquency and charge-off rates by loan category,
quarterly, for all commercial banks. This module intentionally contains no
portfolio simulation, aging buckets, or modeled roll rates.

    delinquency = DR*ACBS series (30+ DPD, %) · charge-off = COR*ACBS (annualized, %)
"""
from __future__ import annotations

import fred_client as fred
# label -> (delinquency series, charge-off series), all commercial banks:
#   DRCCLACBS/CORCCACBS      credit card
#   DRCLACBS/CORCLACBS       consumer (all consumer loans)
#   DRSFRMACBS/CORSFRMACBS   single-family residential mortgage
#   DRCRELEXFACBS/CORCREXFACBS  commercial real estate (ex farmland)
#   DRBLACBS/CORBLACBS       business loans
_MAP: dict[str, tuple[str, str]] = {
    "credit_card": ("DRCCLACBS", "CORCCACBS"),
    "consumer": ("DRCLACBS", "CORCLACBS"),
    "residential_re": ("DRSFRMACBS", "CORSFRMACBS"),
    "commercial_re": ("DRCRELEXFACBS", "CORCREXFACBS"),
    "business": ("DRBLACBS", "CORBLACBS"),
}

_LABELS = {
    "credit_card": "Credit cards", "consumer": "Consumer loans",
    "residential_re": "Residential mortgages", "commercial_re": "Commercial real estate",
    "business": "Business loans",
}


def market_series(months: int = 36) -> list[dict]:
    """Real bank-loan delinquency and charge-off histories, by FRED category."""
    if not fred.available():
        return []
    out = []
    for asset_class, (delinq_id, chargeoff_id) in _MAP.items():
        delinq = fred.series(delinq_id, months=months)
        chargeoffs = dict(fred.series(chargeoff_id, months=months))
        if not delinq:
            continue
        trend = [{"asof": d.isoformat(), "delinquency_rate": round(v, 3),
                  "chargeoff_rate": round(chargeoffs[d], 3) if d in chargeoffs else None}
                 for d, v in delinq]
        latest = trend[-1]
        out.append({"asset_class": asset_class, "label": _LABELS[asset_class],
                    "asof": latest["asof"], "delinquency_rate": latest["delinquency_rate"],
                    "chargeoff_rate": latest["chargeoff_rate"], "trend": trend,
                    "source": "FRED · St. Louis Fed"})
    return out
