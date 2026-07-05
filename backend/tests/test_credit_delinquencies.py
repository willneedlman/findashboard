"""Tests for the credit delinquency engine (credit_delinquencies).

Locks the metric math (bucket mix, 30+ DPD, NPA, default share, annualized
default), the roll-rate recovery (including the persistent 120+ stock handled by
inflow), aggregation/filtering, the risk-report threshold flags, and mock
determinism. Network-free.
"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import credit_delinquencies as cd  # noqa: E402

B = cd.Bucket


def _rec(asof, current, b30, b60, b90, b120, charge_offs=0.0,
         product=cd.LoanProduct.CREDIT_CARD, region=cd.Region.SOUTH, pid="p"):
    return cd.DelinquencyRecord(
        portfolio_id=pid, asof=asof, product=product, region=region,
        outstanding=current + b30 + b60 + b90 + b120,
        balances={B.CURRENT: current, B.DPD_30_59: b30, B.DPD_60_89: b60,
                  B.DPD_90_119: b90, B.DEFAULT: b120},
        charge_offs=charge_offs,
    )


def test_loan_bucket_thresholds():
    def bucket(dpd, charged=False):
        return cd.Loan("l", cd.LoanProduct.AUTO, cd.Region.WEST, date(2024, 1, 1),
                       100, 90, days_past_due=dpd, charged_off=charged).bucket
    assert bucket(0) == B.CURRENT
    assert bucket(29) == B.CURRENT
    assert bucket(30) == B.DPD_30_59
    assert bucket(59) == B.DPD_30_59
    assert bucket(60) == B.DPD_60_89
    assert bucket(90) == B.DPD_90_119
    assert bucket(120) == B.DEFAULT
    assert bucket(10, charged=True) == B.DEFAULT


def test_asset_class_mapping():
    assert cd.PRODUCT_CLASS[cd.LoanProduct.AUTO] == cd.AssetClass.CONSUMER
    assert cd.PRODUCT_CLASS[cd.LoanProduct.CRE_COMMERCIAL] == cd.AssetClass.CRE
    assert cd.PRODUCT_CLASS[cd.LoanProduct.CREDIT_CARD] == cd.AssetClass.CREDIT_CARD


def test_point_in_time_metrics():
    r = _rec(date(2026, 1, 31), current=900, b30=40, b60=30, b90=20, b120=10)
    assert r.outstanding == 1000
    assert cd.delinquency_rate(r) == 10.0            # (40+30+20+10)/1000
    assert cd.npa_ratio(r) == 3.0                    # (20+10)/1000  (90+ DPD)
    assert cd.default_balance_rate(r) == 1.0         # 10/1000
    bd = cd.bucket_breakdown(r)
    assert bd["current"]["pct"] == 90.0
    assert abs(sum(v["pct"] for v in bd.values()) - 100.0) < 1e-9


def test_roll_rates_recover_transitions():
    # prev → cur constructed so each roll is exactly 0.5 and charge-off 0.05.
    prev = _rec(date(2026, 1, 31), current=0, b30=100, b60=50, b90=20, b120=40)
    cur = _rec(date(2026, 2, 28), current=0, b30=0, b60=50, b90=25, b120=48, charge_offs=2)
    rr = cd.roll_rates([prev, cur])
    assert rr["30-59->60-89"] == 0.5                 # 50/100
    assert rr["60-89->90-119"] == 0.5                # 25/50
    # 120+ is a stock: inflow = 48 - 40 + 2 = 10; 10/20 = 0.5
    assert rr["90-119->120+"] == 0.5
    assert abs(rr["120+->charge_off"] - 0.05) < 1e-9  # 2/40


def test_annualized_default_rate():
    recs = [_rec(date(2025, m, 1), current=1188, b30=0, b60=0, b90=0, b120=0, charge_offs=1)
            for m in range(1, 13)]
    for r in recs:
        r.outstanding = 1200
    # 12 months, sum charge-offs 12, avg outstanding 1200 → 1.0% annualized
    assert abs(cd.annualized_default_rate(recs) - 1.0) < 1e-9


def test_aggregate_sums_balances_per_month():
    a = _rec(date(2026, 1, 31), 100, 10, 5, 3, 2, charge_offs=1, pid="a")
    b = _rec(date(2026, 1, 31), 200, 20, 10, 6, 4, charge_offs=2, pid="b")
    agg = cd.aggregate_records([a, b], "grp")
    assert len(agg) == 1
    g = agg[0]
    assert g.outstanding == a.outstanding + b.outstanding
    assert g.bal(B.DPD_30_59) == 30
    assert g.bal(B.DEFAULT) == 6
    assert g.charge_offs == 3


def test_filter_records_by_class_and_region():
    recs = [
        _rec(date(2026, 1, 31), 100, 0, 0, 0, 0, product=cd.LoanProduct.AUTO, region=cd.Region.WEST),
        _rec(date(2026, 1, 31), 100, 0, 0, 0, 0, product=cd.LoanProduct.CI, region=cd.Region.WEST),
        _rec(date(2026, 1, 31), 100, 0, 0, 0, 0, product=cd.LoanProduct.AUTO, region=cd.Region.SOUTH),
    ]
    assert len(cd.filter_records(recs, asset_class=cd.AssetClass.CONSUMER)) == 2
    assert len(cd.filter_records(recs, region=cd.Region.WEST)) == 2
    assert len(cd.filter_records(recs, asset_class=cd.AssetClass.CONSUMER, region=cd.Region.WEST)) == 1


def test_mock_book_shape_and_determinism():
    a = cd.generate_mock_portfolios(months=24, seed=7)
    b = cd.generate_mock_portfolios(months=24, seed=7)
    assert len(a) == len(cd.LoanProduct) * len(cd.Region) == 36
    assert all(len(p.records) == 24 for p in a)
    # Deterministic: same seed → identical outstanding on the latest record.
    assert a[0].latest.outstanding == b[0].latest.outstanding
    # Every record's buckets sum to its outstanding (charge-offs have left).
    for p in a:
        for r in p.records:
            assert abs(sum(r.balances.values()) - r.outstanding) < 1.0


def test_risk_report_flags_and_structure():
    book = cd.generate_mock_portfolios(months=24, seed=7)
    report = cd.risk_report(book, default_threshold=5.0)
    assert report["total"]["outstanding"] > 0
    assert len(report["by_asset_class"]) == 5
    # Ranked worst-first.
    rates = [b["annualized_default_rate"] for b in report["by_asset_class"]]
    assert rates == sorted(rates, reverse=True)
    # Any flag must actually exceed the threshold and appear in by_asset_class.
    for f in report["flags"]:
        assert f["annualized_default_rate"] > 5.0
    # A 0% threshold flags every class; a huge threshold flags none.
    assert len(cd.risk_report(book, default_threshold=0.0)["flags"]) == 5
    assert len(cd.risk_report(book, default_threshold=99.0)["flags"]) == 0
