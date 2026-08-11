"""Real industry delinquency benchmarks from FRED for the Credit Stress tool.

FRED publishes aggregate delinquency and charge-off rates by loan category,
quarterly, for all commercial banks. This module intentionally contains no
portfolio simulation, aging buckets, or modeled roll rates.

    delinquency = DR*ACBS series (30+ DPD, %) · charge-off = COR*ACBS (annualized, %)
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

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

_STRESS_MAP = {
    "stl_fsi": {
        "series": "STLFSI4",
        "label": "St. Louis Financial Stress",
        "unit": "index",
        "frequency": "weekly",
        "interpretation": (
            "Composite of 18 weekly market-priced series (rates, yield spreads, the VIX) "
            "combined by principal components. Standard deviations from its own historical "
            "average, not percent: above zero is more stressed than usual."
        ),
    },
    "nfci": {
        "series": "NFCI",
        "label": "Chicago Fed Financial Conditions",
        "unit": "index",
        "frequency": "weekly",
        "interpretation": (
            "Composite of roughly 105 risk, credit and leverage indicators across money, "
            "debt, equity and banking markets, many of them quantities rather than prices. "
            "Standard deviations from its own average: above zero is tighter than normal."
        ),
    },
    "ci_tightening": {
        "series": "DRTSCILM",
        "label": "C&I Lending Standards",
        "unit": "percent",
        "frequency": "quarterly",
        "interpretation": "Net share of banks tightening standards for large and middle-market C&I loans.",
    },
    "card_tightening": {
        "series": "DRTSCLCC",
        "label": "Credit Card Standards",
        "unit": "percent",
        "frequency": "quarterly",
        "interpretation": "Net share of banks tightening credit-card lending standards.",
    },
}


def market_series(months: int = 36) -> list[dict]:
    """Real bank-loan delinquency and charge-off histories, by FRED category."""
    if not fred.available():
        return []

    def load(item: tuple[str, tuple[str, str]]) -> dict | None:
        asset_class, (delinq_id, chargeoff_id) = item
        delinq = fred.series(delinq_id, months=months)
        chargeoffs = dict(fred.series(chargeoff_id, months=months))
        if not delinq:
            return None
        trend = [{"asof": d.isoformat(), "delinquency_rate": round(v, 3),
                  "chargeoff_rate": round(chargeoffs[d], 3) if d in chargeoffs else None}
                 for d, v in delinq]
        latest = trend[-1]
        return {"asset_class": asset_class, "label": _LABELS[asset_class],
                "asof": latest["asof"], "delinquency_rate": latest["delinquency_rate"],
                "chargeoff_rate": latest["chargeoff_rate"], "trend": trend,
                "source": "FRED · St. Louis Fed"}

    with ThreadPoolExecutor(max_workers=len(_MAP)) as pool:
        return [result for result in pool.map(load, _MAP.items()) if result is not None]


def stress_indicators(months: int = 36) -> list[dict]:
    """Observed financial-stress and bank-lending-standard indicators."""
    if not fred.available():
        return []
    def load(item: tuple[str, dict]) -> dict | None:
        key, config = item
        observations = fred.series(config["series"], months=months)
        if not observations:
            return None
        trend = [{"asof": day.isoformat(), "value": round(value, 4)} for day, value in observations]
        latest = trend[-1]
        previous = trend[-2]["value"] if len(trend) > 1 else None
        return {
            "key": key,
            "label": config["label"],
            "asof": latest["asof"],
            "value": latest["value"],
            "previous": previous,
            "unit": config["unit"],
            "frequency": config["frequency"],
            "interpretation": config["interpretation"],
            "trend": trend,
            "source": "Federal Reserve via FRED",
        }

    with ThreadPoolExecutor(max_workers=len(_STRESS_MAP)) as pool:
        return [result for result in pool.map(load, _STRESS_MAP.items()) if result is not None]
