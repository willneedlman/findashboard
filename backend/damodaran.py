"""Damodaran Online industry-average assumptions — DCF fallback only.

Snapshot of NYU Stern (Damodaran) US industry betas and operating margins,
used to backstop per-company beta / operating margin when the primary data
sources (FMP, yfinance) don't return them. Refresh annually by re-fetching
his data pages and regenerating data/damodaran.json.
"""
import json
import os
import re
import functools
import logging

logger = logging.getLogger(__name__)

_DATA_PATH = os.path.join(os.path.dirname(__file__), "data", "damodaran.json")

# Hard fallback if the snapshot file is somehow unavailable (Total Market
# without financials, Jan 2026).
_MARKET_DEFAULT = {"beta": 0.99, "unlevered_beta": 0.88, "op_margin": 14.65}

# yfinance/FMP sector & industry strings rarely match Damodaran's taxonomy
# exactly. These substrings disambiguate the common high-volume cases that
# plain token overlap gets wrong; everything else falls back to token scoring.
_ALIASES = [
    ("biotech",        "Drugs (Biotechnology)"),
    ("pharmaceutical", "Drugs (Pharmaceutical)"),
    ("drug manufactur","Drugs (Pharmaceutical)"),
    ("semiconductor",  "Semiconductor"),
    ("software",       "Software (System & Application)"),
    ("internet",       "Software (Internet)"),
    ("bank",           "Banks (Regional)"),
    ("insurance",      "Insurance (General)"),
    ("oil & gas e&p",  "Oil/Gas (Production and Exploration)"),
    ("aerospace",      "Aerospace/Defense"),
    ("airline",        "Air Transport"),
    ("auto manufactur","Auto & Truck"),
    ("reit",           "R.E.I.T."),
    ("utilities",      "Utility (General)"),
    ("restaurant",     "Restaurant/Dining"),
    ("tobacco",        "Tobacco"),
]


@functools.lru_cache(maxsize=1)
def _load() -> dict:
    try:
        with open(_DATA_PATH) as f:
            return json.load(f)
    except Exception as e:
        logger.warning("Damodaran snapshot unavailable (%s); using market default", e)
        return {"market": _MARKET_DEFAULT, "industries": [], "updated": "n/a"}


def _norm(s: str | None) -> list[str]:
    """Lowercase, split on non-alphanumerics, singularize trailing 's'."""
    tokens = re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).split()
    return [t[:-1] if len(t) > 3 and t.endswith("s") else t for t in tokens]


def lookup(sector: str | None = None, industry: str | None = None) -> dict:
    """Closest Damodaran industry row for a company's sector/industry.

    Returns {name, beta, unlevered_beta, op_margin, matched, updated, source}.
    Falls back to the total-market average when nothing matches.
    """
    data = _load()
    market = data.get("market", _MARKET_DEFAULT)
    updated = data.get("updated", "n/a")
    base = {
        "beta":           market["beta"],
        "unlevered_beta": market["unlevered_beta"],
        "op_margin":      market["op_margin"],
        "updated":        updated,
        "source":         "Damodaran Online",
    }

    rows = data.get("industries", [])
    if not rows:
        return {**base, "name": "Total Market", "matched": False}

    by_name = {r["name"]: r for r in rows}
    query = f"{industry or ''} {sector or ''}".lower()

    # 1) explicit alias substrings (industry string preferred)
    for needle, target in _ALIASES:
        if needle in query and target in by_name:
            r = by_name[target]
            return {"name": r["name"], "beta": r["beta"], "unlevered_beta": r["unlevered_beta"],
                    "op_margin": r["op_margin"], "matched": True, "updated": updated,
                    "source": "Damodaran Online"}

    # 2) token-overlap scoring against industry, then sector
    for candidate in (industry, sector):
        q = set(_norm(candidate))
        if not q:
            continue
        best, best_score = None, 0.0
        for r in rows:
            if r["name"].startswith("Total Market"):
                continue
            ind = set(_norm(r["name"]))
            shared = q & ind
            if not shared:
                continue
            score = len(shared) / len(q | ind)   # Jaccard
            if score > best_score:
                best, best_score = r, score
        if best and best_score >= 0.34:
            return {"name": best["name"], "beta": best["beta"], "unlevered_beta": best["unlevered_beta"],
                    "op_margin": best["op_margin"], "matched": True, "updated": updated,
                    "source": "Damodaran Online"}

    return {**base, "name": "Total Market", "matched": False}
