"""Real housing data from FRED, shaped to drive the existing housing engine.

Replaces the deterministic mock: builds one NATIONAL ``HousingSeries`` + the
national mortgage-rate history from live FRED series, so ``housing_market``'s
engine (affordability, supply/demand, trend, anomalies) and the router run
unchanged. Fields FRED does not publish are left at 0 and shown as "—" by the UI
rather than fabricated. Returns None if FRED is unavailable so the router can
fall back to the mock book.

Series (all free, national):
    MORTGAGE30US/15US/5US  30y / 15y / 5-1 ARM, weekly
    MSPUS                  median sales price, quarterly ($)
    EXHOSLUSM495S          existing-home sales, monthly (thousands, SAAR)
    ACTLISCOUUS            active listings, monthly (Realtor.com)
    MEDDAYONMARUS          median days on market, monthly (Realtor.com)
    MEDLISPRIPERSQUFEEUS   median list price / sqft, monthly (Realtor.com)
    MEHOINUSA646N          median household income, annual ($)
    DRSFRMACBS             single-family mortgage delinquency, quarterly (%)
    HOUST / PERMIT / COMPUTSA  starts / permits / completions, monthly (thousands, SAAR)
"""
from __future__ import annotations

import logging
from datetime import date

import fred_client as fred
import housing_market as hm

_log = logging.getLogger(__name__)

_SERIES = {
    "rate_30y": "MORTGAGE30US", "rate_15y": "MORTGAGE15US", "rate_arm": "MORTGAGE5US",
    "median_price": "MSPUS", "sales": "EXHOSLUSM495S",
    "active_listings": "ACTLISCOUUS", "days_on_market": "MEDDAYONMARUS",
    "price_per_sqft": "MEDLISPRIPERSQUFEEUS", "median_income": "MEHOINUSA646N",
    "sf_delinq": "DRSFRMACBS",
    "starts": "HOUST", "permits": "PERMIT", "completions": "COMPUTSA",
}


def build(months: int = 40):
    """Return ([national HousingSeries], [MortgageRateRecord]) from FRED, or None."""
    if not fred.available():
        return None
    data = {k: fred.series(sid, months=max(months + 18, 60)) for k, sid in _SERIES.items()}
    # Core anchors must be present or the tool has nothing real to show.
    if not data["median_price"] or not data["rate_30y"] or not data["sales"]:
        _log.warning("housing_fred: core FRED series missing, falling back to mock")
        return None

    axis = hm._month_ends(months)
    if axis and axis[-1] > date.today():
        axis[-1] = date.today()
    rates: list[hm.MortgageRateRecord] = []
    snaps: list[hm.HousingMarketSnapshot] = []
    cons: list[hm.ConstructionActivity] = []

    for d in axis:
        r30 = fred.as_of(data["rate_30y"], d)
        if r30 is None:
            continue  # no rate yet for this month → skip (keeps series contiguous)
        rates.append(hm.MortgageRateRecord(
            asof=d, rate_30y=round(r30, 2),
            rate_15y=round(fred.as_of(data["rate_15y"], d) or 0.0, 2),
            rate_arm=round(fred.as_of(data["rate_arm"], d) or 0.0, 2),
        ))

        sales_a = fred.as_of(data["sales"], d)            # absolute count, annual rate
        delinq = fred.as_of(data["sf_delinq"], d) or 0.0
        snaps.append(hm.HousingMarketSnapshot(
            region=hm.Region.NATIONAL, asof=d,
            median_price=round(fred.as_of(data["median_price"], d) or 0.0, 0),
            price_per_sqft=round(fred.as_of(data["price_per_sqft"], d) or 0.0, 1),
            median_income=round(fred.as_of(data["median_income"], d) or 0.0, 0),
            sales_volume=round((sales_a or 0.0) / 12, 0),         # annual rate → homes/month
            pending_sales=0.0,                                     # not on FRED
            days_on_market=round(fred.as_of(data["days_on_market"], d) or 0.0, 1),
            active_listings=round(fred.as_of(data["active_listings"], d) or 0.0, 0),
            sf_default_rate=round(delinq, 2),
            serious_delinquency=round(delinq, 2),
            # FRED has no clean national series for these; left 0 → UI shows "—".
            mf_default_rate=0.0, foreclosure_rate=0.0, negative_equity=0.0,
            avg_ltv=0.0, avg_fico=0.0,
        ))
        starts = fred.as_of(data["starts"], d)
        permits = fred.as_of(data["permits"], d)
        completions = fred.as_of(data["completions"], d)
        if any(value is not None for value in (starts, permits, completions)):
            cons.append(hm.ConstructionActivity(
                region=hm.Region.NATIONAL, asof=d,
                housing_starts=round((starts or 0.0) * 1000, 0),
                building_permits=round((permits or 0.0) * 1000, 0),
                completions=round((completions or 0.0) * 1000, 0),
            ))

    if len(snaps) < 6:
        _log.warning("housing_fred: only %d months assembled, falling back", len(snaps))
        return None

    nat = hm.HousingSeries(region=hm.Region.NATIONAL, snapshots=snaps, construction=cons)
    return [nat], rates
