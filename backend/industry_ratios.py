"""Industry/sector-median ratio benchmarking — WRDS Industry Financial Ratio
(WIFR) methodology applied to the Screener's existing bundled US fundamentals
universe.

No new data source: reuses data/us_fundamentals.json (~915 US names,
Finnhub-sourced) + data/reference.db (SEC-primary overrides for the same
names), which routers/screener.py already loads for its own bundled-seed
fallback path (see _US_FUND / _REF_FUND there). This module aggregates that
same data cross-sectionally by sector instead of adding a new fetch.

Methodology, per the WIFR manual:
  - Group by sector (screener.py's SECTORS list).
  - Aggregate with MEDIAN, not mean — ratios with denominators that can go
    negative (P/E, PEG) produce meaningless averages.
  - Winsorize at the 1% level: drop values below the 1st or above the 99th
    percentile per sector per field before taking the median.
  - Financials are excluded only from the specific ratios where they're not
    meaningful (balance-sheet liquidity ratios don't read the same way for a
    bank, whose "current liabilities" include deposits) — not blanket-
    excluded from the universe, since valuation/profitability ratios ARE
    meaningful for banks.

Computed once at import, same pattern as screener.py's own module-level
_US_FUND/_REF_FUND loads: the underlying bundled files only change when the
offline build scripts re-run, not on any live cadence, so there's nothing to
refresh per-request.
"""
from __future__ import annotations
import json
import logging
import os
import sqlite3

import numpy as np

logger = logging.getLogger(__name__)

_HERE = os.path.dirname(os.path.abspath(__file__))

# Ratios worth benchmarking against peers. Excludes beta (not a "ratio" in the
# WIFR sense — see factor_models.py for real beta) and fields the bundled
# dataset doesn't carry (interestCoverage, payoutRatio) — those are live-fetch
# only per ticker today and have no bundled universe to benchmark against.
MEDIAN_FIELDS = (
    "peRatio", "pbRatio", "psRatio", "evEbitda", "pegRatio",
    "grossMargin", "operatingMargin", "netMargin", "roe", "roa",
    "debtEquity", "currentRatio", "revenueGrowth", "epsGrowth", "dividendYield",
)

_EXCLUDE_FOR_FINANCIALS = {"currentRatio"}
_FINANCIALS_SECTOR = "Financial Services"
_WINSORIZE_PCT = 1.0     # trim below p1 / above p99 per sector per field
_MIN_SAMPLE_FOR_TRIM = 20  # percentile trimming only means something with a real sample


def _norm_tk(t) -> str:
    return str(t).strip().upper().replace(".", "-")


def _load_bundled_universe() -> list[dict]:
    """Same precedence as screener.py's own bundled-seed fallback (see
    run_screen's `us_missing` branch): Finnhub seed, overridden by SEC-primary
    fields where reference.db has them."""
    try:
        path = os.path.join(_HERE, "data", "us_fundamentals.json")
        seed = json.load(open(path))
    except Exception as e:
        logger.warning("industry_ratios: us_fundamentals.json load failed: %s", e)
        return []

    ref: dict[str, dict] = {}
    ref_path = os.path.join(_HERE, "data", "reference.db")
    if os.path.exists(ref_path):
        try:
            ref_fields = ("grossMargin", "operatingMargin", "netMargin", "roe", "roa",
                          "debtEquity", "currentRatio", "revenueGrowth", "epsGrowth")
            conn = sqlite3.connect(f"file:{ref_path}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            for r in conn.execute("SELECT * FROM fundamentals").fetchall():
                ref[_norm_tk(r["ticker"])] = {k: r[k] for k in ref_fields if r[k] is not None}
            conn.close()
        except Exception as e:
            logger.warning("industry_ratios: reference.db load failed: %s", e)

    rows = []
    for k, v in seed.items():
        row = dict(v)
        row.update(ref.get(_norm_tk(k), {}))
        rows.append(row)
    return rows


def _winsorize(values: list) -> np.ndarray:
    arr = np.array([v for v in values if isinstance(v, (int, float)) and not np.isnan(v)], dtype=float)
    if arr.size >= _MIN_SAMPLE_FOR_TRIM:
        lo, hi = np.percentile(arr, [_WINSORIZE_PCT, 100 - _WINSORIZE_PCT])
        arr = arr[(arr >= lo) & (arr <= hi)]
    return arr


def _compute() -> "tuple[dict, dict]":
    """Returns (summary, raw) where summary is sector -> field -> {median, n}
    (small, JSON-friendly, what the API returns) and raw is sector -> field ->
    winsorized ndarray (kept in memory only, for exact percentile_rank())."""
    rows = _load_bundled_universe()
    by_sector: dict[str, list[dict]] = {}
    for r in rows:
        sector = r.get("sector")
        if sector:
            by_sector.setdefault(sector, []).append(r)

    summary: dict[str, dict[str, dict]] = {}
    raw: dict[str, dict[str, np.ndarray]] = {}
    for sector, sector_rows in by_sector.items():
        summary[sector] = {}
        raw[sector] = {}
        for field in MEDIAN_FIELDS:
            if sector == _FINANCIALS_SECTOR and field in _EXCLUDE_FOR_FINANCIALS:
                continue
            arr = _winsorize([r.get(field) for r in sector_rows])
            if arr.size:
                summary[sector][field] = {"median": round(float(np.median(arr)), 3), "n": int(arr.size)}
                raw[sector][field] = arr
    return summary, raw


_SECTOR_MEDIANS, _SECTOR_RAW = _compute()


def get_sector_medians() -> dict[str, dict[str, dict]]:
    """Full sector -> field -> {median, n} map. Small (11 sectors x <=15
    fields) — cheap to return whole, no per-field endpoint needed."""
    return _SECTOR_MEDIANS


def get_field_median(sector: str, field: str) -> float | None:
    entry = _SECTOR_MEDIANS.get(sector, {}).get(field)
    return entry["median"] if entry else None


def percentile_rank(sector: str, field: str, value: float | None) -> float | None:
    """Where `value` sits in the sector's winsorized distribution for this
    field, 0-100. None if the sector/field has no data or value is None."""
    if value is None:
        return None
    arr = _SECTOR_RAW.get(sector, {}).get(field)
    if arr is None or arr.size == 0:
        return None
    below = float((arr < value).sum())
    tied = float((arr == value).sum())
    return round((below + 0.5 * tied) / arr.size * 100, 1)
