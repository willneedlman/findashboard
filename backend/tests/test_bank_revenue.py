"""Tests for the bank revenue-by-activity bucketing (sec_bank_revenue._assemble).

Locks the part that turns raw SEC concept values into the fees-vs-trading mix:
trading split-out when tagged, the GS-style fold-to-other + computed NII, the
2-segment minimum, percentage/total math, and the bank SIC gate. Network-free.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import sec_bank_revenue as m  # noqa: E402

B = 1e9


def _maps(**kw):
    base = {"nii_net": {}, "int_inc": {}, "int_exp": {}, "ib": {}, "noni": {}, "comm": {}, "trade": {}}
    base.update(kw)
    return base


def test_jpm_style_splits_out_trading():
    out = m._assemble(_maps(
        noni={2025: 87.00 * B, 2024: 90.10 * B},
        nii_net={2025: 95.44 * B, 2024: 92.60 * B},
        ib={2025: 9.62 * B, 2024: 8.90 * B},
        comm={2025: 3.73 * B, 2024: 3.10 * B},
        trade={2025: 27.21 * B, 2024: 24.80 * B},
    ))
    assert out["fiscalYear"] == 2025
    names = [s["name"] for s in out["latest"]]
    assert "Trading" in names
    assert names[0] == "Net Interest Income"          # largest slice sorts first
    # NII + noninterest reconciles to total net revenue.
    total = sum(s["value"] for s in out["latest"])
    assert round(total / B, 1) == round(95.44 + 87.00, 1)
    assert abs(sum(s["pct"] for s in out["latest"]) - 100) < 0.5
    other = next(s for s in out["latest"] if s["name"] == "Other Noninterest")
    assert round(other["value"] / B, 2) == round(87.00 - 9.62 - 3.73 - 27.21, 2)
    trading = next(s for s in out["latest"] if s["name"] == "Trading")
    assert trading["yoy_pct"] == round((27.21 - 24.80) / 24.80 * 100, 1)
    assert [h["year"] for h in out["history"]] == [2024, 2025]   # oldest -> newest


def test_gs_style_folds_trading_and_computes_nii():
    out = m._assemble(_maps(
        noni={2025: 44.72 * B},
        int_inc={2025: 80.37 * B},
        int_exp={2025: 66.81 * B},   # NII computed = 13.56B (no nii_net tag)
        ib={2025: 9.35 * B},
        comm={2025: 4.04 * B},
        # no trade tag -> trading folds into Other Noninterest
    ))
    names = {s["name"] for s in out["latest"]}
    assert "Trading" not in names
    assert names == {"Net Interest Income", "Investment Banking", "Commissions", "Other Noninterest"}
    nii = next(s for s in out["latest"] if s["name"] == "Net Interest Income")
    assert round(nii["value"] / B, 2) == round(80.37 - 66.81, 2)
    other = next(s for s in out["latest"] if s["name"] == "Other Noninterest")
    assert round(other["value"] / B, 2) == round(44.72 - 9.35 - 4.04, 2)


def test_empty_and_single_segment_yield_no_block():
    assert m._assemble(_maps())["latest"] == []
    # A year that resolves to only one segment is dropped (needs >= 2).
    assert m._assemble(_maps(noni={2025: 5 * B}, ib={2025: 5 * B}))["latest"] == []


def test_bank_sic_gate():
    assert "6020" in m._BANK_SICS          # national commercial banks
    assert "6211" in m._BANK_SICS          # security broker-dealers
    assert "3571" not in m._BANK_SICS      # electronic computers (AAPL) -> not a bank
