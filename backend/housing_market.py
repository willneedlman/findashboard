"""Housing-market analytics engine.

Aggregates pricing, financing, activity and supply indicators into affordability
(NAR-style HAI), supply/demand balance, and MoM/YoY trend, plus a national-vs-
regional report that flags anomalies (e.g. inventory below a 3-month supply).

Pure/deterministic: no external API, so it is fully testable and cache-free. The
router (routers/housing.py) and the CLI at the bottom drive this off a
deterministic 3-year mock cycle (rising rates cooling volume). The field names on
`HousingMarketSnapshot` / `MortgageRateRecord` / `ConstructionActivity` are chosen
to map straight onto standard providers:

    median_price      → FRED MSPUS / Redfin median sale price
    price_per_sqft    → Redfin / Zillow $/sqft
    median_income     → Census/HUD area median income (AMI)
    sales_volume      → NAR existing-home sales (EXHOSLUSM495S)
    pending_sales     → NAR pending home sales index
    days_on_market    → Redfin median DoM
    active_listings   → Realtor.com active listing count
    rate_30y/15y/arm  → FRED MORTGAGE30US / MORTGAGE15US / (ARM proxy)
    housing_starts    → FRED HOUST
    building_permits  → FRED PERMIT
    completions       → FRED COMPUTSA
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Iterable
import calendar
import math
import random

# ── Taxonomy ──────────────────────────────────────────────────────────────────


class Region(str, Enum):
    NATIONAL = "national"
    NORTHEAST = "northeast"
    MIDWEST = "midwest"
    SOUTH = "south"
    WEST = "west"


REGION_LABEL: dict[Region, str] = {
    Region.NATIONAL: "National",
    Region.NORTHEAST: "Northeast",
    Region.MIDWEST: "Midwest",
    Region.SOUTH: "South",
    Region.WEST: "West",
}
CENSUS_REGIONS = [Region.NORTHEAST, Region.MIDWEST, Region.SOUTH, Region.WEST]


# ── Data models ───────────────────────────────────────────────────────────────


@dataclass
class HousingMarketSnapshot:
    """One region's housing market for one month. Levels are absolute; derived
    ratios are computed by the engine so the record stays a pure data carrier."""
    region: Region
    asof: date
    median_price: float          # $
    price_per_sqft: float         # $/sqft
    median_income: float          # $/yr, area median household income
    sales_volume: float           # existing-home sales, homes/month (seasonally adj.)
    pending_sales: float          # pending sales, homes/month
    days_on_market: float         # median days on market
    active_listings: float        # active inventory, homes
    sf_default_rate: float = 0.0      # single-family mortgage serious delinquency / default, %
    mf_default_rate: float = 0.0      # multifamily (apartment) mortgage default, %
    serious_delinquency: float = 0.0  # all mortgages 90+ days past due, %
    foreclosure_rate: float = 0.0     # mortgages in the foreclosure process, %
    negative_equity: float = 0.0      # mortgaged homes underwater (LTV > 100), %
    avg_ltv: float = 0.0              # origination loan-to-value, %
    avg_fico: float = 0.0            # origination borrower credit score

    @property
    def price_to_income(self) -> float:
        return self.median_price / self.median_income if self.median_income else 0.0

    @property
    def months_of_supply(self) -> float:
        """Active inventory / monthly sales: how long to clear the market."""
        return self.active_listings / self.sales_volume if self.sales_volume else 0.0

    @property
    def sell_through(self) -> float:
        """Monthly sales / active listings: higher = seller's market."""
        return self.sales_volume / self.active_listings if self.active_listings else 0.0


@dataclass
class MortgageRateRecord:
    """National mortgage rates for one month (rates are set nationally)."""
    asof: date
    rate_30y: float               # 30-year fixed, %
    rate_15y: float               # 15-year fixed, %
    rate_arm: float               # 5/1 adjustable-rate mortgage, %


@dataclass
class ConstructionActivity:
    """One region's new-construction pipeline for one month (annualized units)."""
    region: Region
    asof: date
    housing_starts: float         # units, SAAR
    building_permits: float       # units, SAAR
    completions: float            # units, SAAR


@dataclass
class HousingSeries:
    """A region's full monthly history plus the national rate series it prices off."""
    region: Region
    snapshots: list[HousingMarketSnapshot] = field(default_factory=list)
    construction: list[ConstructionActivity] = field(default_factory=list)

    @property
    def latest(self) -> HousingMarketSnapshot | None:
        return max(self.snapshots, key=lambda s: s.asof) if self.snapshots else None


# ── Affordability engine ──────────────────────────────────────────────────────

DEFAULT_DOWN_PCT = 0.20          # 20% down (80% LTV)
DEFAULT_FRONT_RATIO = 0.25       # housing payment <= 25% of gross income (NAR)
HAI_BALANCED = 100.0             # HAI = 100 means median family exactly qualifies


def monthly_payment(loan: float, annual_rate_pct: float, months: int = 360) -> float:
    """Fully-amortizing monthly principal & interest."""
    r = annual_rate_pct / 100.0 / 12.0
    if r <= 0:
        return loan / months
    return loan * r * (1 + r) ** months / ((1 + r) ** months - 1)


def qualifying_income(median_price: float, rate_30y: float,
                      down_pct: float = DEFAULT_DOWN_PCT,
                      front_ratio: float = DEFAULT_FRONT_RATIO) -> float:
    """Annual income needed to qualify for the median home at the 30y rate."""
    loan = median_price * (1 - down_pct)
    pi = monthly_payment(loan, rate_30y)
    return pi / front_ratio * 12.0 if front_ratio else 0.0


def affordability_index(snap: HousingMarketSnapshot, rate_30y: float,
                        down_pct: float = DEFAULT_DOWN_PCT,
                        front_ratio: float = DEFAULT_FRONT_RATIO) -> float:
    """NAR-style Housing Affordability Index: 100 = the median-income household
    has exactly enough to qualify for the median-priced home; >100 = surplus."""
    qi = qualifying_income(snap.median_price, rate_30y, down_pct, front_ratio)
    return snap.median_income / qi * 100.0 if qi else 0.0


def supply_demand_spread(snap: HousingMarketSnapshot) -> dict:
    """Sales-to-listings balance. sell_through > ~0.33 (supply < 3 months) is a
    seller's market; higher favors sellers more."""
    st = snap.sell_through
    mos = snap.months_of_supply
    market = "seller" if mos < 4 else "buyer" if mos > 6 else "balanced"
    return {"sell_through": round(st, 4), "months_of_supply": round(mos, 2), "market": market}


# ── Trend analysis ────────────────────────────────────────────────────────────


def _pct_change(cur: float, prev: float) -> float | None:
    if prev is None or prev == 0:
        return None
    return (cur / prev - 1.0) * 100.0


def trend(series: list[float]) -> dict:
    """Month-over-month and year-over-year % change from a chronological series."""
    if not series:
        return {"mom": None, "yoy": None}
    cur = series[-1]
    mom = _pct_change(cur, series[-2]) if len(series) >= 2 else None
    yoy = _pct_change(cur, series[-13]) if len(series) >= 13 else None
    return {"mom": None if mom is None else round(mom, 2),
            "yoy": None if yoy is None else round(yoy, 2)}


# ── Filtering & metrics assembly ──────────────────────────────────────────────


def snapshot_metrics(snap: HousingMarketSnapshot, rate_30y: float) -> dict:
    """All point-in-time metrics for one region-month."""
    return {
        "region": snap.region.value,
        "asof": snap.asof.isoformat(),
        "median_price": round(snap.median_price, 2),
        "price_per_sqft": round(snap.price_per_sqft, 2),
        "median_income": round(snap.median_income, 2),
        "price_to_income": round(snap.price_to_income, 3),
        "sales_volume": round(snap.sales_volume, 0),
        "pending_sales": round(snap.pending_sales, 0),
        "days_on_market": round(snap.days_on_market, 1),
        "active_listings": round(snap.active_listings, 0),
        "months_of_supply": round(snap.months_of_supply, 2),
        "affordability_index": round(affordability_index(snap, rate_30y), 1),
        "sf_default_rate": round(snap.sf_default_rate, 2),
        "mf_default_rate": round(snap.mf_default_rate, 2),
        "serious_delinquency": round(snap.serious_delinquency, 2),
        "foreclosure_rate": round(snap.foreclosure_rate, 2),
        "negative_equity": round(snap.negative_equity, 2),
        "avg_ltv": round(snap.avg_ltv, 1),
        "avg_fico": round(snap.avg_fico, 0),
        **supply_demand_spread(snap),
        "rate_30y": round(rate_30y, 2),
    }


def region_report(hs: HousingSeries, rates: dict[date, MortgageRateRecord]) -> dict:
    """Current posture for one region + MoM/YoY trends on price and volume."""
    snaps = sorted(hs.snapshots, key=lambda s: s.asof)
    if not snaps:
        return {"region": hs.region.value, "empty": True}
    latest = snaps[-1]
    rate = rates.get(latest.asof)
    r30 = rate.rate_30y if rate else 0.0
    return {
        **snapshot_metrics(latest, r30),
        "region_label": REGION_LABEL[hs.region],
        "trends": {
            "median_price": trend([s.median_price for s in snaps]),
            "sales_volume": trend([s.sales_volume for s in snaps]),
            "affordability_index": trend([
                affordability_index(s, (rates.get(s.asof).rate_30y if rates.get(s.asof) else 0.0))
                for s in snaps]),
            "months_of_supply": trend([s.months_of_supply for s in snaps]),
            "sf_default_rate": trend([s.sf_default_rate for s in snaps]),
            "mf_default_rate": trend([s.mf_default_rate for s in snaps]),
            "serious_delinquency": trend([s.serious_delinquency for s in snaps]),
        },
        "history": [
            {"asof": s.asof.isoformat(),
             "median_price": round(s.median_price, 0),
             "sales_volume": round(s.sales_volume, 0),
             "months_of_supply": round(s.months_of_supply, 2),
             "sf_default_rate": round(s.sf_default_rate, 2),
             "mf_default_rate": round(s.mf_default_rate, 2),
             "affordability_index": round(
                 affordability_index(s, (rates.get(s.asof).rate_30y if rates.get(s.asof) else 0.0)), 1)}
            for s in snaps
        ],
    }


def anomalies(hs: HousingSeries, rates: dict[date, MortgageRateRecord],
              tight_supply: float = 3.0, unaffordable_hai: float = 100.0,
              dom_yoy_jump: float = 40.0) -> list[dict]:
    """Sharp conditions worth surfacing for a region's latest month."""
    snaps = sorted(hs.snapshots, key=lambda s: s.asof)
    if not snaps:
        return []
    latest = snaps[-1]
    r30 = (rates.get(latest.asof).rate_30y if rates.get(latest.asof) else 0.0)
    out: list[dict] = []
    if latest.months_of_supply < tight_supply:
        out.append({"region": hs.region.value, "kind": "tight_supply",
                    "detail": f"{latest.months_of_supply:.1f}-month supply (< {tight_supply})",
                    "value": round(latest.months_of_supply, 2)})
    hai = affordability_index(latest, r30)
    if hai < unaffordable_hai:
        out.append({"region": hs.region.value, "kind": "unaffordable",
                    "detail": f"HAI {hai:.0f} (< {unaffordable_hai:.0f})", "value": round(hai, 1)})
    dom_yoy = trend([s.days_on_market for s in snaps])["yoy"]
    if dom_yoy is not None and dom_yoy > dom_yoy_jump:
        out.append({"region": hs.region.value, "kind": "dom_spike",
                    "detail": f"days-on-market +{dom_yoy:.0f}% YoY", "value": round(dom_yoy, 1)})
    return out


def market_report(regions: list[HousingSeries], rates: dict[date, MortgageRateRecord]) -> dict:
    """National-vs-regional posture with anomaly flags."""
    asof = max((s.asof for hs in regions for s in hs.snapshots), default=None)
    latest_rate = rates.get(asof) if asof else None
    by_region = [region_report(hs, rates) for hs in regions]
    flags = [f for hs in regions for f in anomalies(hs, rates)]
    return {
        "asof": asof.isoformat() if asof else None,
        "rates": None if not latest_rate else {
            "rate_30y": latest_rate.rate_30y, "rate_15y": latest_rate.rate_15y,
            "rate_arm": latest_rate.rate_arm,
        },
        "by_region": by_region,
        "flags": flags,
    }


# ── Deterministic 3-year mock cycle ───────────────────────────────────────────

# Per-region starting levels (roughly Census-region realistic, month 0).
# sf/mf = single-family / multifamily default base %, risk = foreclosure & negative-
# equity tilt (West runs hotter on price sensitivity, Midwest cooler).
_PROFILE: dict[Region, dict[str, float]] = {
    Region.NORTHEAST: {"price": 465000, "ppsf": 305, "income": 84000, "sales": 62000, "listings": 210000, "dom": 34, "starts": 118000, "sf": 0.42, "mf": 0.70, "risk": 1.05},
    Region.MIDWEST:   {"price": 268000, "ppsf": 172, "income": 71000, "sales": 108000, "listings": 300000, "dom": 30, "starts": 155000, "sf": 0.30, "mf": 0.48, "risk": 0.88},
    Region.SOUTH:     {"price": 345000, "ppsf": 188, "income": 69000, "sales": 232000, "listings": 640000, "dom": 38, "starts": 760000, "sf": 0.38, "mf": 0.62, "risk": 1.00},
    Region.WEST:      {"price": 615000, "ppsf": 355, "income": 90000, "sales": 118000, "listings": 330000, "dom": 28, "starts": 300000, "sf": 0.28, "mf": 0.55, "risk": 1.12},
}


def _month_ends(n: int, anchor: date | None = None) -> list[date]:
    anchor = anchor or date.today().replace(day=1)
    y, m = anchor.year, anchor.month
    out: list[date] = []
    for _ in range(n):
        out.append(date(y, m, calendar.monthrange(y, m)[1]))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return list(reversed(out))


def _rate_cycle(months: int, rng: random.Random) -> list[MortgageRateRecord]:
    """A rising-then-plateauing 30y path (~3.1% → ~7.1%), with 15y/ARM tracking."""
    dates = _month_ends(months)
    recs: list[MortgageRateRecord] = []
    for i, asof in enumerate(dates):
        t = i / max(months - 1, 1)
        # Logistic-ish ramp that flattens in the last third.
        base = 3.1 + 4.0 / (1 + math.exp(-8 * (t - 0.45)))
        r30 = round(base + rng.uniform(-0.08, 0.08), 2)
        r15 = round(r30 - 0.72 + rng.uniform(-0.04, 0.04), 2)
        # ARMs start cheaper than fixed, then invert as the curve flattens.
        arm = round(r30 - 0.55 + 1.1 * t + rng.uniform(-0.05, 0.05), 2)
        recs.append(MortgageRateRecord(asof=asof, rate_30y=r30, rate_15y=r15, rate_arm=arm))
    return recs


def _simulate_region(region: Region, rates: list[MortgageRateRecord],
                     rng: random.Random) -> HousingSeries:
    p = _PROFILE[region]
    dates = [r.asof for r in rates]
    r0 = rates[0].rate_30y
    price, ppsf, income = p["price"], p["ppsf"], p["income"]
    hs = HousingSeries(region=region)
    for i, asof in enumerate(dates):
        rate = rates[i].rate_30y
        drate = rate - r0                     # cumulative rate shock, pts
        seasonal = 1.0 + 0.06 * math.sin((asof.month - 3) / 12 * 2 * math.pi)  # spring peak
        noise = rng.uniform(0.98, 1.02)

        # Prices rise early, then flatten/dip as rates bite (lagged).
        appreciation = (1.0035 - 0.0016 * max(drate, 0)) ** i
        price = p["price"] * appreciation * rng.uniform(0.995, 1.005)
        ppsf = p["ppsf"] * appreciation * rng.uniform(0.995, 1.005)
        income = p["income"] * (1.0028 ** i)   # incomes grind up ~3.4%/yr

        # Volume is rate-sensitive: every point of rate shock trims turnover.
        vol_factor = max(0.55, 1 - 0.11 * max(drate, 0))
        sales = p["sales"] * vol_factor * seasonal * noise
        pending = sales * rng.uniform(0.9, 1.04)
        # As sales cool, listings build and homes sit longer.
        listings = p["listings"] * (1 + 0.09 * max(drate, 0)) * (2 - seasonal) * rng.uniform(0.98, 1.02)
        dom = p["dom"] * (1 + 0.14 * max(drate, 0)) / seasonal * rng.uniform(0.97, 1.03)

        # Credit risk: defaults and stress rise with the rate shock; multifamily is
        # more cyclical than single-family, and softening prices push some underwater.
        sf_def = p["sf"] * (1 + 0.30 * max(drate, 0)) * noise
        mf_def = p["mf"] * (1 + 0.62 * max(drate, 0)) * noise
        serious = (0.82 * sf_def + 0.18 * mf_def) * 1.7          # 90+ DPD is broader than default
        foreclosure = 0.22 * p["risk"] * (1 + 0.22 * max(drate, 0)) * noise
        neg_equity = (2.1 * p["risk"] + 0.55 * max(drate, 0)) * noise
        ltv = 78.5 + 0.9 * max(drate, 0)                         # buyers stretch → higher LTV
        fico = 744 + 4.5 * max(drate, 0)                         # lenders tighten → higher origination FICO

        hs.snapshots.append(HousingMarketSnapshot(
            region=region, asof=asof,
            median_price=round(price, 0), price_per_sqft=round(ppsf, 1), median_income=round(income, 0),
            sales_volume=round(sales, 0), pending_sales=round(pending, 0),
            days_on_market=round(dom, 1), active_listings=round(listings, 0),
            sf_default_rate=round(sf_def, 2), mf_default_rate=round(mf_def, 2),
            serious_delinquency=round(serious, 2), foreclosure_rate=round(foreclosure, 2),
            negative_equity=round(neg_equity, 2), avg_ltv=round(ltv, 1), avg_fico=round(fico, 0),
        ))
        # Construction pulls back as rates rise; permits lead starts lead completions.
        starts = p["starts"] * max(0.6, 1 - 0.08 * max(drate, 0)) * seasonal * rng.uniform(0.97, 1.03)
        hs.construction.append(ConstructionActivity(
            region=region, asof=asof,
            housing_starts=round(starts, 0),
            building_permits=round(starts * rng.uniform(1.02, 1.1), 0),
            completions=round(starts * rng.uniform(0.85, 0.95), 0),
        ))
    return hs


def generate_mock(months: int = 36, seed: int = 11) -> tuple[list[HousingSeries], list[MortgageRateRecord]]:
    """Deterministic 3-year book: 4 census regions + a National aggregate, plus
    the national rate cycle they price off."""
    rng = random.Random(seed)
    rates = _rate_cycle(months, rng)
    regions = [_simulate_region(r, rates, rng) for r in CENSUS_REGIONS]

    # National = aggregate of the four regions (sum volumes, weighted prices).
    nat = HousingSeries(region=Region.NATIONAL)
    by_month: dict[date, list[HousingMarketSnapshot]] = {}
    con_by_month: dict[date, list[ConstructionActivity]] = {}
    for hs in regions:
        for s in hs.snapshots:
            by_month.setdefault(s.asof, []).append(s)
        for c in hs.construction:
            con_by_month.setdefault(c.asof, []).append(c)
    for asof, group in sorted(by_month.items()):
        sales = sum(s.sales_volume for s in group)
        wsum = sum(s.sales_volume for s in group) or 1
        nat.snapshots.append(HousingMarketSnapshot(
            region=Region.NATIONAL, asof=asof,
            median_price=round(sum(s.median_price * s.sales_volume for s in group) / wsum, 0),
            price_per_sqft=round(sum(s.price_per_sqft * s.sales_volume for s in group) / wsum, 1),
            median_income=round(sum(s.median_income * s.sales_volume for s in group) / wsum, 0),
            sales_volume=round(sales, 0),
            pending_sales=round(sum(s.pending_sales for s in group), 0),
            days_on_market=round(sum(s.days_on_market * s.sales_volume for s in group) / wsum, 1),
            active_listings=round(sum(s.active_listings for s in group), 0),
            sf_default_rate=round(sum(s.sf_default_rate * s.sales_volume for s in group) / wsum, 2),
            mf_default_rate=round(sum(s.mf_default_rate * s.sales_volume for s in group) / wsum, 2),
            serious_delinquency=round(sum(s.serious_delinquency * s.sales_volume for s in group) / wsum, 2),
            foreclosure_rate=round(sum(s.foreclosure_rate * s.sales_volume for s in group) / wsum, 2),
            negative_equity=round(sum(s.negative_equity * s.sales_volume for s in group) / wsum, 2),
            avg_ltv=round(sum(s.avg_ltv * s.sales_volume for s in group) / wsum, 1),
            avg_fico=round(sum(s.avg_fico * s.sales_volume for s in group) / wsum, 0),
        ))
    for asof, cgroup in sorted(con_by_month.items()):
        nat.construction.append(ConstructionActivity(
            region=Region.NATIONAL, asof=asof,
            housing_starts=round(sum(c.housing_starts for c in cgroup), 0),
            building_permits=round(sum(c.building_permits for c in cgroup), 0),
            completions=round(sum(c.completions for c in cgroup), 0),
        ))
    return [nat, *regions], rates


def rate_map(rates: list[MortgageRateRecord]) -> dict[date, MortgageRateRecord]:
    return {r.asof: r for r in rates}


# ── CLI ───────────────────────────────────────────────────────────────────────


def _cli() -> None:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="Housing-market affordability & supply/demand analytics")
    ap.add_argument("--months", type=int, default=36, help="history depth (default 36)")
    ap.add_argument("--json", action="store_true", help="emit the full market report as JSON")
    args = ap.parse_args()

    regions, rates = generate_mock(months=args.months)
    rmap = rate_map(rates)
    report = market_report(regions, rmap)

    if args.json:
        print(json.dumps(report, indent=2))
        return

    r = report["rates"] or {}
    print(f"\nUS HOUSING MARKET  ·  as of {report['asof']}  ·  "
          f"30y {r.get('rate_30y', 0):.2f}%  15y {r.get('rate_15y', 0):.2f}%  ARM {r.get('rate_arm', 0):.2f}%\n")
    header = f"  {'REGION':<12}{'MED PRICE':>12}{'P/INCOME':>10}{'SUPPLY':>9}{'DoM':>7}{'HAI':>7}{'MARKET':>10}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for b in report["by_region"]:
        print(f"  {b['region_label']:<12}${b['median_price']/1000:>10.0f}k{b['price_to_income']:>10.2f}"
              f"{b['months_of_supply']:>8.1f}m{b['days_on_market']:>6.0f}d{b['affordability_index']:>7.0f}{b['market']:>10}")
    if report["flags"]:
        print("\n  ANOMALIES:")
        for f in report["flags"]:
            print(f"    · {f['region']:<10} {f['detail']}")
    print()


if __name__ == "__main__":
    _cli()
