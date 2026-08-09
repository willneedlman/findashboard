"""Project the data inventory onto the report tool registry.

`docs/data-inventory/surfaced.csv` is the verified record of every value the app
puts on screen. The report can only fetch *tools*, so this maps each report tool
to the inventory rows it actually surfaces and writes the result to
`backend/data/report_metric_catalog.json`.

Two things downstream need it:

  * the planner, which shows a shortlisted tool's real measurements to the model
    instead of a one-line label, and
  * validation level L6, which checks a drafted claim against the `limits` text
    of the evidence behind it.

Run after editing either the inventory or the registry:

    python3 backend/scripts/build_report_catalog.py
"""
from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from reporting.tool_registry import REPORT_TOOL_BY_ID  # noqa: E402

INVENTORY = ROOT / "docs" / "data-inventory" / "surfaced.csv"
OUT = ROOT / "backend" / "data" / "report_metric_catalog.json"

# Report tool id -> the inventory `surfaced_in` tool names it draws from.
# A report tool can span several app tools (macro-cycle reads the Macro Monitor
# surface), and one app tool can feed several report tools (Company Profile
# feeds company, dividends, debt-maturity and the ownership pair), so this is
# deliberately many-to-many rather than a name match.
TOOL_SOURCES: dict[str, tuple[str, ...]] = {
    "portfolio": ("Portfolio Manager",),
    "portfolio-risk": ("Portfolio Analysis", "Portfolio Compare"),
    "factor-decomposition": ("Factor Decomposition",),
    "correlation": ("Correlation",),
    "company": ("Company Profile",),
    "price-history": ("Chart Studio",),
    "asset-profile": ("Global Markets",),
    "mover": ("Mover Radar",),
    "news": ("Mover Radar",),
    "earnings": ("Earnings Scanner",),
    "dividends": ("Portfolio Manager",),
    "debt-maturity": ("Company Profile",),
    "seasonality": ("Seasonality",),
    "peer-valuation": ("Peer Comparison", "Multiples"),
    "dcf-valuation": ("DCF Valuation",),
    "options": ("Options Pricer", "Volatility Scanner"),
    "volatility-skew": ("Volatility Scanner",),
    "dealer-gex": ("Dealer GEX",),
    "implied-probability": ("Implied Probability",),
    "options-unusual": ("Options Scanner",),
    "insider-activity": ("Earnings Scanner", "Company Profile"),
    "institutional-ownership": ("Company Profile",),
    "cot-positioning": ("Trader Positioning",),
    "breadth": ("Market Breadth",),
    "sector-rotation": ("Sector Rotation",),
    "sector-rrg": ("Sector Rotation",),
    "market-compare": ("Asset Overlay",),
    "regression": ("Regression",),
    "pairs": ("Pairs Trader",),
    "global-markets": ("Global Markets",),
    "fx-matrix": ("FX Matrix",),
    "macro-events": ("Economic Calendar",),
    "macro-cycle": ("Macro Monitor",),
    "sentiment": ("Sentiment Tracker",),
    "credit-spreads": ("Credit Spreads",),
    "credit-stress": ("Credit Stress",),
    "rate-engine": ("Rate Engine",),
    "housing": ("Housing Market",),
    "ipo-calendar": ("IPO Scanner",),
    "chokepoint-exposure": ("Chokepoint Exposure", "Freight Map"),
    # One model surfaces DCF, multiples, DDM, SOTP and the reverse-DCF read, so
    # it maps to all five of the app tools that present those methods.
    "master-valuation": ("Master Valuation", "Dividend Discount", "Sum of the Parts", "Reverse DCF", "Multiples"),
    "monte-carlo": ("Monte Carlo",),
    "portfolio-optimizer": ("Portfolio Allocator",),
    "portfolio-backtest": ("Portfolio Backtester", "Algo Builder"),
}


def inventory_rows() -> list[dict]:
    with INVENTORY.open(newline="") as handle:
        return list(csv.DictReader(handle))


def surfaced_tools(row: dict) -> set[str]:
    return {
        part.split("(")[0].strip()
        for part in re.split(r";\s*", row.get("surfaced_in", ""))
        if part.strip()
    }


def main() -> int:
    rows = inventory_rows()
    known = {name for row in rows for name in surfaced_tools(row)}

    unknown = {
        name
        for names in TOOL_SOURCES.values()
        for name in names
        if name not in known
    }
    if unknown:
        print(f"ERROR: TOOL_SOURCES names no inventory tool calls: {sorted(unknown)}", file=sys.stderr)
        return 1

    missing_tools = sorted(set(TOOL_SOURCES) - set(REPORT_TOOL_BY_ID))
    if missing_tools:
        print(f"ERROR: TOOL_SOURCES references unregistered tools: {missing_tools}", file=sys.stderr)
        return 1

    catalog: dict[str, list[dict]] = {}
    for tool_id, names in TOOL_SOURCES.items():
        wanted = set(names)
        metrics = [
            {
                "id": row["id"],
                "name": row["name"],
                "formula": row["formula"],
                "interpretation": row["interpretation"],
                "limits": row["limits"],
            }
            for row in rows
            if surfaced_tools(row) & wanted
        ]
        catalog[tool_id] = metrics

    covered = {
        row["id"]
        for tool_id, names in TOOL_SOURCES.items()
        for row in rows
        if surfaced_tools(row) & set(names)
    }
    unreachable = [row["id"] for row in rows if row["id"] not in covered]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "metricsByTool": catalog,
        "unreachableMetricIds": sorted(unreachable),
    }, indent=1, sort_keys=True) + "\n")

    reachable = len(covered)
    print(f"{len(rows)} inventory values; {reachable} reachable by the report "
          f"({reachable / len(rows) * 100:.0f}%), {len(unreachable)} not")
    empty = [tool_id for tool_id, metrics in catalog.items() if not metrics]
    if empty:
        print(f"tools with no inventory metrics: {empty}")
    print(f"wrote {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
