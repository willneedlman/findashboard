"""Institutional consensus panels: FocusEconomics and Consensus Economics.

Neither exposes a public/self-serve API. Access is an enterprise data contract
(negotiated feed + credentials), and their documented deliverables are Excel/CSV
data files, a data platform, and — for enterprise clients — a REST/SFTP feed.

There is nothing to hit live, so this file documents the *shape* of the data
each provides (from their published product docs) and shows how our pipeline
would normalize it into the same {actual, consensus, previous} row we already
use. This is the "replicate the documented payload" step.
"""
from __future__ import annotations

import json

# ── FocusEconomics — Consensus Forecasts ─────────────────────────────────────
# ~1,000 contributing institutions. Per country/indicator/period they publish
# the panel MEAN plus the dispersion (min/max) and individual panelist values.
# Delivery: Consensus Forecast data files + enterprise data feed. No public API.
FOCUS_ECONOMICS_SAMPLE = {
    "provider": "FocusEconomics",
    "country": "United States",
    "indicator": "Consumer Price Index (CPI, % yoy)",
    "reference_period": "2026-06",
    "consensus": {
        "mean": 2.5,          # <-- the median/mean panel consensus we want
        "median": 2.5,
        "minimum": 2.2,
        "maximum": 2.9,
        "standard_deviation": 0.17,
        "number_of_panelists": 42,
    },
    "panelists": [            # per-institution detail also delivered
        {"institution": "Goldman Sachs", "forecast": 2.4},
        {"institution": "Morgan Stanley", "forecast": 2.6},
    ],
    "previous_actual": 2.4,
}

# ── Consensus Economics — Consensus Forecasts ────────────────────────────────
# The original monthly survey (700+ economists across G7/global). Publishes
# MEAN + HIGH + LOW + standard deviation for GDP, CPI, rates, FX, etc.
# Delivery: monthly Excel/PDF + historical database + institutional feed. No
# public API; subscription/enterprise only.
CONSENSUS_ECONOMICS_SAMPLE = {
    "provider": "Consensus Economics",
    "survey_month": "2026-07",
    "country": "United States",
    "variable": "Real GDP (% yoy)",
    "horizon": "2026",
    "survey": {
        "mean": 1.8,          # <-- consensus mean
        "high": 2.4,
        "low": 1.1,
        "standard_deviation": 0.31,
        "respondents": 31,
    },
}


def normalize_focus(row: dict) -> dict:
    """Map a FocusEconomics row into our tape's event shape."""
    c = row["consensus"]
    return {"source": row["provider"], "event": row["indicator"], "country": row["country"],
            "period": row["reference_period"], "consensus": c["mean"],
            "consensus_range": [c["minimum"], c["maximum"]], "previous": row["previous_actual"], "actual": None}


def normalize_consensus_econ(row: dict) -> dict:
    s = row["survey"]
    return {"source": row["provider"], "event": row["variable"], "country": row["country"],
            "period": row["horizon"], "consensus": s["mean"],
            "consensus_range": [s["low"], s["high"]], "previous": None, "actual": None}


if __name__ == "__main__":
    print("FocusEconomics — documented payload (enterprise feed, no public API):")
    print(json.dumps(FOCUS_ECONOMICS_SAMPLE, indent=2))
    print("  consensus field -> consensus.mean\n")
    print("normalized ->", json.dumps(normalize_focus(FOCUS_ECONOMICS_SAMPLE)))

    print("\nConsensus Economics — documented payload (subscription, no public API):")
    print(json.dumps(CONSENSUS_ECONOMICS_SAMPLE, indent=2))
    print("  consensus field -> survey.mean")
    print("normalized ->", json.dumps(normalize_consensus_econ(CONSENSUS_ECONOMICS_SAMPLE)))
