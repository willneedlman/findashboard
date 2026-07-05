"""Credit delinquency & default analytics engine.

Tracks delinquency buckets, default/charge-off rates, non-performing ratios and
roll rates across consumer, corporate, card, residential and commercial-real-
estate loan portfolios. Pure/deterministic: no external API, so it is fully
testable and cache-free. The router (routers/credit.py) and the CLI at the
bottom of this file both drive this engine off a deterministic mock book that
spans the last 24 months.

Reporting granularity is the *portfolio month* (a DelinquencyRecord): aggregate
dollar balances per delinquency bucket, the way regulators report (FR Y-14 /
Fed charge-off & delinquency series) rather than loan-by-loan.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import Iterable
import calendar
import random

# ── Taxonomy ──────────────────────────────────────────────────────────────────


class AssetClass(str, Enum):
    CONSUMER = "consumer"
    CORPORATE = "corporate"
    CREDIT_CARD = "credit_card"
    RESIDENTIAL_RE = "residential_re"
    CRE = "cre"


class LoanProduct(str, Enum):
    AUTO = "auto"
    STUDENT = "student"
    PERSONAL = "personal"
    CI = "ci"                      # Commercial & Industrial
    SYNDICATED = "syndicated"
    CREDIT_CARD = "credit_card"
    MORTGAGE = "mortgage"          # single-family residential
    CRE_MULTIFAMILY = "cre_multifamily"
    CRE_COMMERCIAL = "cre_commercial"


PRODUCT_CLASS: dict[LoanProduct, AssetClass] = {
    LoanProduct.AUTO: AssetClass.CONSUMER,
    LoanProduct.STUDENT: AssetClass.CONSUMER,
    LoanProduct.PERSONAL: AssetClass.CONSUMER,
    LoanProduct.CI: AssetClass.CORPORATE,
    LoanProduct.SYNDICATED: AssetClass.CORPORATE,
    LoanProduct.CREDIT_CARD: AssetClass.CREDIT_CARD,
    LoanProduct.MORTGAGE: AssetClass.RESIDENTIAL_RE,
    LoanProduct.CRE_MULTIFAMILY: AssetClass.CRE,
    LoanProduct.CRE_COMMERCIAL: AssetClass.CRE,
}

PRODUCT_LABEL: dict[LoanProduct, str] = {
    LoanProduct.AUTO: "Auto Loans",
    LoanProduct.STUDENT: "Student Loans",
    LoanProduct.PERSONAL: "Personal Loans",
    LoanProduct.CI: "C&I Loans",
    LoanProduct.SYNDICATED: "Syndicated Loans",
    LoanProduct.CREDIT_CARD: "Credit Cards",
    LoanProduct.MORTGAGE: "Single-Family Mortgages",
    LoanProduct.CRE_MULTIFAMILY: "CRE — Multifamily",
    LoanProduct.CRE_COMMERCIAL: "CRE — Commercial",
}


class Region(str, Enum):
    NORTHEAST = "northeast"
    SOUTH = "south"
    MIDWEST = "midwest"
    WEST = "west"


class Bucket(str, Enum):
    CURRENT = "current"
    DPD_30_59 = "30-59"
    DPD_60_89 = "60-89"
    DPD_90_119 = "90-119"
    DEFAULT = "120+"       # 120+ DPD / non-accrual — booked but in default


# Ordering worst-last; used for roll-rate transitions and severity groupings.
BUCKET_ORDER: list[Bucket] = [
    Bucket.CURRENT, Bucket.DPD_30_59, Bucket.DPD_60_89, Bucket.DPD_90_119, Bucket.DEFAULT,
]
DELINQUENT_BUCKETS: list[Bucket] = BUCKET_ORDER[1:]              # 30+ DPD
NON_PERFORMING_BUCKETS: list[Bucket] = [Bucket.DPD_90_119, Bucket.DEFAULT]   # 90+ DPD
DEFAULT_BUCKETS: list[Bucket] = [Bucket.DEFAULT]

# Consecutive-severity transitions for roll rates. Charge-off is the terminal
# transition out of the 120+ bucket and is measured off the charge_offs flow.
ROLL_TRANSITIONS: list[tuple[Bucket, Bucket]] = [
    (Bucket.DPD_30_59, Bucket.DPD_60_89),
    (Bucket.DPD_60_89, Bucket.DPD_90_119),
    (Bucket.DPD_90_119, Bucket.DEFAULT),
]


# ── Data models ───────────────────────────────────────────────────────────────


@dataclass
class Loan:
    """A single loan. Loan-level status rolls up into DelinquencyRecords."""
    loan_id: str
    product: LoanProduct
    region: Region
    origination: date
    original_balance: float
    current_balance: float
    days_past_due: int = 0
    charged_off: bool = False

    @property
    def asset_class(self) -> AssetClass:
        return PRODUCT_CLASS[self.product]

    @property
    def bucket(self) -> Bucket:
        if self.charged_off or self.days_past_due >= 120:
            return Bucket.DEFAULT
        if self.days_past_due >= 90:
            return Bucket.DPD_90_119
        if self.days_past_due >= 60:
            return Bucket.DPD_60_89
        if self.days_past_due >= 30:
            return Bucket.DPD_30_59
        return Bucket.CURRENT


@dataclass
class DelinquencyRecord:
    """One portfolio's dollar balances by delinquency bucket for one month.

    `balances` sums to `outstanding` (charged-off loans have already left the
    book); `charge_offs` is the dollar flow charged off *during* this month.
    """
    portfolio_id: str
    asof: date
    product: LoanProduct
    region: Region
    outstanding: float
    balances: dict[Bucket, float]
    charge_offs: float = 0.0

    @property
    def asset_class(self) -> AssetClass:
        return PRODUCT_CLASS[self.product]

    def bal(self, bucket: Bucket) -> float:
        return self.balances.get(bucket, 0.0)


@dataclass
class Portfolio:
    portfolio_id: str
    name: str
    product: LoanProduct
    region: Region
    records: list[DelinquencyRecord] = field(default_factory=list)

    @property
    def asset_class(self) -> AssetClass:
        return PRODUCT_CLASS[self.product]

    @property
    def latest(self) -> DelinquencyRecord | None:
        return max(self.records, key=lambda r: r.asof) if self.records else None


@dataclass
class MarketBenchmark:
    """Industry composite for a period, to contextualize a portfolio's metrics."""
    asset_class: AssetClass
    period: str                 # "YYYY-MM"
    delinquency_rate: float     # 30+ DPD, %
    default_rate: float         # annualized default / charge-off, %
    npa_ratio: float            # %
    source: str = "Industry composite (mock)"


# ── Calculation engine ────────────────────────────────────────────────────────


def _sum(rec: DelinquencyRecord, buckets: Iterable[Bucket]) -> float:
    return sum(rec.bal(b) for b in buckets)


def bucket_breakdown(rec: DelinquencyRecord) -> dict[str, dict[str, float]]:
    """Per-bucket dollars and share of outstanding (%)."""
    out = rec.outstanding or 1.0
    return {
        b.value: {"balance": rec.bal(b), "pct": rec.bal(b) / out * 100.0}
        for b in BUCKET_ORDER
    }


def delinquency_rate(rec: DelinquencyRecord, floor: Bucket = Bucket.DPD_30_59) -> float:
    """Share of outstanding at or beyond `floor` DPD (default: 30+ DPD), %."""
    idx = BUCKET_ORDER.index(floor)
    out = rec.outstanding or 1.0
    return _sum(rec, BUCKET_ORDER[idx:]) / out * 100.0


def default_balance_rate(rec: DelinquencyRecord) -> float:
    """Point-in-time share of outstanding sitting in default (120+ DPD), %."""
    out = rec.outstanding or 1.0
    return _sum(rec, DEFAULT_BUCKETS) / out * 100.0


def npa_ratio(rec: DelinquencyRecord) -> float:
    """Non-Performing Assets ratio: (90+ DPD balance / outstanding) x 100."""
    out = rec.outstanding or 1.0
    return _sum(rec, NON_PERFORMING_BUCKETS) / out * 100.0


def annualized_default_rate(records: list[DelinquencyRecord], months: int = 12) -> float:
    """Annualized default rate over a period = charge-offs / average outstanding.

    This is the standard 'default rate over a given period' banks report: the
    dollars that crossed into loss, annualized, not a point-in-time stock. Uses
    the trailing `months` records.
    """
    window = sorted(records, key=lambda r: r.asof)[-months:]
    if not window:
        return 0.0
    charge_offs = sum(r.charge_offs for r in window)
    avg_out = sum(r.outstanding for r in window) / len(window) or 1.0
    return charge_offs / avg_out * (12.0 / len(window)) * 100.0


def roll_rates(records: list[DelinquencyRecord]) -> dict[str, float]:
    """Average month-over-month roll probabilities between adjacent buckets.

    roll(A→B) for a month pair = flow into the worse bucket B this month /
    balance in bucket A last month, averaged over consecutive pairs and clamped
    to [0, 1]. Transitory buckets (30-59, 60-89, 90-119) are replaced monthly so
    their balance *is* the inflow; the 120+ bucket is a persistent stock, so its
    inflow is measured as Δbalance + charge-offs (dollars that entered default
    minus those that then charged off). The terminal '120+ → charge-off' roll is
    measured off the charge_offs flow.
    """
    ordered = sorted(records, key=lambda r: r.asof)
    sums: dict[str, list[float]] = {}

    def add(key: str, num: float, den: float) -> None:
        if den > 0:
            sums.setdefault(key, []).append(max(0.0, min(1.0, num / den)))

    for prev, cur in zip(ordered, ordered[1:]):
        for worse_from, worse_to in ROLL_TRANSITIONS:
            if worse_to == Bucket.DEFAULT:
                inflow = cur.bal(Bucket.DEFAULT) - prev.bal(Bucket.DEFAULT) + cur.charge_offs
            else:
                inflow = cur.bal(worse_to)
            add(f"{worse_from.value}->{worse_to.value}", inflow, prev.bal(worse_from))
        add(f"{Bucket.DEFAULT.value}->charge_off", cur.charge_offs, prev.bal(Bucket.DEFAULT))

    return {k: sum(v) / len(v) for k, v in sums.items()}


def record_metrics(rec: DelinquencyRecord) -> dict:
    """All point-in-time metrics for a single portfolio-month."""
    return {
        "portfolio_id": rec.portfolio_id,
        "asof": rec.asof.isoformat(),
        "product": rec.product.value,
        "asset_class": rec.asset_class.value,
        "region": rec.region.value,
        "outstanding": round(rec.outstanding, 2),
        "buckets": {k: {"balance": round(v["balance"], 2), "pct": round(v["pct"], 4)}
                    for k, v in bucket_breakdown(rec).items()},
        "delinquency_rate_30plus": round(delinquency_rate(rec), 4),
        "npa_ratio": round(npa_ratio(rec), 4),
        "default_balance_rate": round(default_balance_rate(rec), 4),
        "charge_offs": round(rec.charge_offs, 2),
    }


# ── Filtering & aggregation ───────────────────────────────────────────────────


def filter_records(
    records: Iterable[DelinquencyRecord],
    *,
    asset_class: AssetClass | None = None,
    product: LoanProduct | None = None,
    region: Region | None = None,
    start: date | None = None,
    end: date | None = None,
) -> list[DelinquencyRecord]:
    """Filter by asset class, product, region and/or time window."""
    out = []
    for r in records:
        if asset_class is not None and r.asset_class != asset_class:
            continue
        if product is not None and r.product != product:
            continue
        if region is not None and r.region != region:
            continue
        if start is not None and r.asof < start:
            continue
        if end is not None and r.asof > end:
            continue
        out.append(r)
    return out


def aggregate_records(records: list[DelinquencyRecord], group_id: str) -> list[DelinquencyRecord]:
    """Collapse many portfolios into one synthetic book per month (sum balances).

    Returns one DelinquencyRecord per as-of month. Used to roll several
    products/regions up into an asset-class or all-book view whose rates and
    roll rates are then computed with the same functions.
    """
    by_month: dict[date, list[DelinquencyRecord]] = {}
    for r in records:
        by_month.setdefault(r.asof, []).append(r)

    agg: list[DelinquencyRecord] = []
    for asof, group in sorted(by_month.items()):
        balances = {b: sum(r.bal(b) for r in group) for b in BUCKET_ORDER}
        # A mixed group has no single product/region; tag the dominant product.
        dominant = max(group, key=lambda r: r.outstanding)
        agg.append(DelinquencyRecord(
            portfolio_id=group_id,
            asof=asof,
            product=dominant.product,
            region=dominant.region,
            outstanding=sum(r.outstanding for r in group),
            balances=balances,
            charge_offs=sum(r.charge_offs for r in group),
        ))
    return agg


# ── Portfolio & risk reporting ────────────────────────────────────────────────


def portfolio_summary(portfolio: Portfolio, benchmark: MarketBenchmark | None = None) -> dict:
    """Current risk posture for one portfolio, plus roll rates and a trend."""
    latest = portfolio.latest
    if latest is None:
        return {"portfolio_id": portfolio.portfolio_id, "empty": True}

    summary = {
        "portfolio_id": portfolio.portfolio_id,
        "name": portfolio.name,
        "product": portfolio.product.value,
        "product_label": PRODUCT_LABEL[portfolio.product],
        "asset_class": portfolio.asset_class.value,
        "region": portfolio.region.value,
        "current": record_metrics(latest),
        "annualized_default_rate": round(annualized_default_rate(portfolio.records), 4),
        "roll_rates": {k: round(v, 4) for k, v in roll_rates(portfolio.records).items()},
        "trend": [
            {"asof": r.asof.isoformat(),
             "delinquency_rate_30plus": round(delinquency_rate(r), 4),
             "npa_ratio": round(npa_ratio(r), 4)}
            for r in sorted(portfolio.records, key=lambda r: r.asof)
        ],
    }
    if benchmark is not None:
        summary["benchmark"] = {
            "delinquency_rate": benchmark.delinquency_rate,
            "default_rate": benchmark.default_rate,
            "npa_ratio": benchmark.npa_ratio,
            "source": benchmark.source,
        }
    return summary


def risk_report(portfolios: list[Portfolio], default_threshold: float = 5.0) -> dict:
    """Book-wide risk posture, flagging asset classes over the default threshold.

    Aggregates every portfolio's records up to the asset-class level and to a
    total book, then computes the same metrics. `flags` lists any asset class
    whose annualized default rate exceeds `default_threshold` (%).
    """
    all_records = [r for p in portfolios for r in p.records]

    def block(label: str, group_id: str, records: list[DelinquencyRecord]) -> dict:
        agg = aggregate_records(records, group_id)
        latest = max(agg, key=lambda r: r.asof)
        ann_default = annualized_default_rate(agg)
        return {
            "label": label,
            "outstanding": round(latest.outstanding, 2),
            "delinquency_rate_30plus": round(delinquency_rate(latest), 4),
            "npa_ratio": round(npa_ratio(latest), 4),
            "default_balance_rate": round(default_balance_rate(latest), 4),
            "annualized_default_rate": round(ann_default, 4),
            "over_threshold": ann_default > default_threshold,
            "buckets": {k: round(v["pct"], 4) for k, v in bucket_breakdown(latest).items()},
        }

    by_class: list[dict] = []
    flags: list[dict] = []
    for ac in AssetClass:
        recs = [r for r in all_records if r.asset_class == ac]
        if not recs:
            continue
        b = block(ac.value, f"class:{ac.value}", recs)
        by_class.append(b)
        if b["over_threshold"]:
            flags.append({"asset_class": ac.value,
                          "annualized_default_rate": b["annualized_default_rate"],
                          "threshold": default_threshold})

    total = block("Total book", "total", all_records) if all_records else None
    asof = max((r.asof for r in all_records), default=None)
    return {
        "asof": asof.isoformat() if asof else None,
        "default_threshold": default_threshold,
        "total": total,
        "by_asset_class": sorted(by_class, key=lambda b: -b["annualized_default_rate"]),
        "flags": flags,
        "portfolios": [portfolio_summary(p) for p in portfolios],
    }


# ── Deterministic mock book (last 24 months) ──────────────────────────────────

# Per-product monthly dynamics for the roll-forward simulator:
#   out    – outstanding book size ($M), new_dq – monthly entry rate into 30-59
#   as a share of performing balance, r1..r3 – roll-to-next-bucket probabilities,
#   co     – 120+ → charge-off probability, stress – annualized drift on new_dq
#   over the window (office CRE and cards deteriorating; mortgages benign).
_PROFILE: dict[LoanProduct, dict[str, float]] = {
    LoanProduct.AUTO:            {"out": 62000, "new_dq": 0.020, "r1": 0.48, "r2": 0.58, "r3": 0.64, "co": 0.50, "stress": 0.18},
    LoanProduct.STUDENT:         {"out": 96000, "new_dq": 0.016, "r1": 0.40, "r2": 0.50, "r3": 0.55, "co": 0.30, "stress": 0.05},
    LoanProduct.PERSONAL:        {"out": 22000, "new_dq": 0.019, "r1": 0.52, "r2": 0.62, "r3": 0.67, "co": 0.55, "stress": 0.12},
    LoanProduct.CI:              {"out": 130000, "new_dq": 0.006, "r1": 0.34, "r2": 0.45, "r3": 0.55, "co": 0.40, "stress": 0.08},
    LoanProduct.SYNDICATED:      {"out": 74000, "new_dq": 0.009, "r1": 0.42, "r2": 0.56, "r3": 0.66, "co": 0.55, "stress": 0.15},
    LoanProduct.CREDIT_CARD:     {"out": 88000, "new_dq": 0.017, "r1": 0.55, "r2": 0.70, "r3": 0.78, "co": 0.58, "stress": 0.22},
    LoanProduct.MORTGAGE:        {"out": 265000, "new_dq": 0.008, "r1": 0.28, "r2": 0.34, "r3": 0.40, "co": 0.18, "stress": -0.05},
    LoanProduct.CRE_MULTIFAMILY: {"out": 92000, "new_dq": 0.008, "r1": 0.36, "r2": 0.46, "r3": 0.52, "co": 0.38, "stress": 0.20},
    LoanProduct.CRE_COMMERCIAL:  {"out": 115000, "new_dq": 0.015, "r1": 0.54, "r2": 0.66, "r3": 0.74, "co": 0.56, "stress": 0.35},
}

_REGION_TILT: dict[Region, float] = {   # relative delinquency multiplier
    Region.NORTHEAST: 0.95, Region.SOUTH: 1.12, Region.MIDWEST: 1.02, Region.WEST: 0.98,
}


def _month_ends(n: int, anchor: date | None = None) -> list[date]:
    """The last `n` month-end dates ending at the anchor month (default today)."""
    anchor = anchor or date.today()
    y, m = anchor.year, anchor.month
    out: list[date] = []
    for _ in range(n):
        out.append(date(y, m, calendar.monthrange(y, m)[1]))
        m -= 1
        if m == 0:
            m, y = 12, y - 1
    return list(reversed(out))


def _simulate(product: LoanProduct, region: Region, portfolio_id: str,
              months: int, rng: random.Random) -> list[DelinquencyRecord]:
    p = _PROFILE[product]
    tilt = _REGION_TILT[region] * rng.uniform(0.92, 1.08)
    outstanding = p["out"] * rng.uniform(0.18, 0.42)   # one regional book is a slice of the product

    # Warm-up so the delinquency pipeline starts near steady state, not empty.
    b30 = outstanding * p["new_dq"] * tilt
    b60 = b30 * p["r1"]
    b90 = b60 * p["r2"]
    b120 = b90 * p["r3"] / max(p["co"], 1e-6)

    dates = _month_ends(months)
    records: list[DelinquencyRecord] = []
    for i, asof in enumerate(dates):
        drift = 1.0 + p["stress"] * (i / max(months - 1, 1))
        seasonal = 1.0 + 0.06 * (1 if asof.month in (1, 2, 8) else -0.5 if asof.month in (5, 6) else 0)
        noise = rng.uniform(0.9, 1.1)
        entry = p["new_dq"] * tilt * drift * seasonal * noise

        performing = max(outstanding - (b30 + b60 + b90 + b120), 0.0)
        new_b30 = performing * entry
        new_b60 = b30 * p["r1"]
        new_b90 = b60 * p["r2"]
        co_flow = b120 * p["co"]
        new_b120 = b120 - co_flow + b90 * p["r3"]

        b30, b60, b90, b120 = new_b30, new_b60, new_b90, new_b120
        current = max(outstanding - (b30 + b60 + b90 + b120), 0.0)

        records.append(DelinquencyRecord(
            portfolio_id=portfolio_id, asof=asof, product=product, region=region,
            outstanding=round(outstanding, 2),
            balances={
                Bucket.CURRENT: round(current, 2),
                Bucket.DPD_30_59: round(b30, 2),
                Bucket.DPD_60_89: round(b60, 2),
                Bucket.DPD_90_119: round(b90, 2),
                Bucket.DEFAULT: round(b120, 2),
            },
            charge_offs=round(co_flow, 2),
        ))
        # New originations roughly replace charge-offs plus mild book growth.
        outstanding = outstanding + co_flow * rng.uniform(0.7, 1.1) + outstanding * 0.002
    return records


def generate_mock_portfolios(months: int = 24, seed: int = 7) -> list[Portfolio]:
    """A deterministic book: every product across every region, `months` deep."""
    rng = random.Random(seed)
    portfolios: list[Portfolio] = []
    for product in LoanProduct:
        for region in Region:
            pid = f"{product.value}:{region.value}"
            portfolios.append(Portfolio(
                portfolio_id=pid,
                name=f"{PRODUCT_LABEL[product]} — {region.value.title()}",
                product=product, region=region,
                records=_simulate(product, region, pid, months, rng),
            ))
    return portfolios


def mock_benchmarks(portfolios: list[Portfolio]) -> dict[str, MarketBenchmark]:
    """Industry composite per asset class from the mock book's latest month."""
    all_records = [r for p in portfolios for r in p.records]
    period = max((r.asof for r in all_records), default=date.today()).strftime("%Y-%m")
    out: dict[str, MarketBenchmark] = {}
    for ac in AssetClass:
        recs = [r for r in all_records if r.asset_class == ac]
        if not recs:
            continue
        agg = aggregate_records(recs, f"class:{ac.value}")
        latest = max(agg, key=lambda r: r.asof)
        out[ac.value] = MarketBenchmark(
            asset_class=ac, period=period,
            delinquency_rate=round(delinquency_rate(latest) * 1.05, 3),
            default_rate=round(annualized_default_rate(agg) * 1.08, 3),
            npa_ratio=round(npa_ratio(latest) * 1.05, 3),
        )
    return out


# ── CLI ───────────────────────────────────────────────────────────────────────


def _cli() -> None:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="Credit delinquency & default analytics")
    ap.add_argument("--months", type=int, default=24, help="history depth (default 24)")
    ap.add_argument("--threshold", type=float, default=5.0, help="default-rate flag threshold %%")
    ap.add_argument("--json", action="store_true", help="emit the full risk report as JSON")
    args = ap.parse_args()

    portfolios = generate_mock_portfolios(months=args.months)
    report = risk_report(portfolios, default_threshold=args.threshold)

    if args.json:
        print(json.dumps(report, indent=2))
        return

    print(f"\nCREDIT RISK POSTURE  ·  as of {report['asof']}  ·  threshold {args.threshold:.1f}% default\n")
    t = report["total"]
    print(f"  Total book: ${t['outstanding']/1000:,.1f}B outstanding  |  "
          f"30+ DPD {t['delinquency_rate_30plus']:.2f}%  |  NPA {t['npa_ratio']:.2f}%  |  "
          f"default(ann) {t['annualized_default_rate']:.2f}%\n")
    header = f"  {'ASSET CLASS':<16}{'30+ DPD':>10}{'NPA':>9}{'DEFAULT(ann)':>14}{'':>6}"
    print(header)
    print("  " + "-" * (len(header) - 2))
    for b in report["by_asset_class"]:
        flag = "  OVER" if b["over_threshold"] else ""
        print(f"  {b['label']:<16}{b['delinquency_rate_30plus']:>9.2f}%{b['npa_ratio']:>8.2f}%"
              f"{b['annualized_default_rate']:>13.2f}%{flag}")
    if report["flags"]:
        print("\n  OVER THRESHOLD: " + ", ".join(
            f"{f['asset_class']} ({f['annualized_default_rate']:.2f}%)" for f in report["flags"]))
    print()


if __name__ == "__main__":
    _cli()
