"""One-time backfill: add quickRatio/inventoryTurnover/receivablesTurnover/
interestCoverage/payoutRatio to the existing data/us_fundamentals.json —
fields Finnhub's /stock/metric response already carries but
build_us_fundamentals.py never captured. Re-fetches only the metric call
(not profile2) for tickers already in the file, so it's half the API calls
of a full rebuild. Merge-safe and resumable, same pattern as the main build
script: python3 backend/scripts/backfill_us_fundamentals_ratios.py
"""
import json
import os
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")
BASE = "https://finnhub.io/api/v1"


def _key() -> str:
    env = os.path.join(os.path.dirname(HERE), ".env")
    for line in open(env):
        if line.startswith("FINNHUB_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return os.getenv("FINNHUB_API_KEY", "")


_KEY = _key()
_session = requests.Session()
_NEW_FIELDS = ("quickRatio", "inventoryTurnover", "receivablesTurnover", "interestCoverage", "payoutRatio")


def _num(v, nd=2):
    return round(v, nd) if isinstance(v, (int, float)) else None


def _fetch_metric(tk: str) -> dict:
    r = _session.get(f"{BASE}/stock/metric", params={"symbol": tk, "metric": "all", "token": _KEY}, timeout=10)
    time.sleep(1.05)
    if r.status_code != 200:
        return {}
    try:
        return (r.json() or {}).get("metric", {})
    except Exception:
        return {}


def main():
    if not _KEY:
        raise SystemExit("FINNHUB_API_KEY not found in backend/.env")
    path = os.path.join(DATA, "us_fundamentals.json")
    out = json.load(open(path))
    todo = [tk for tk, row in out.items() if not all(f in row for f in _NEW_FIELDS)]
    print(f"start: {len(out) - len(todo)}/{len(out)} already backfilled, {len(todo)} to fetch (~{len(todo) * 1.1 / 60:.0f} min)")
    for i, tk in enumerate(todo):
        try:
            m = _fetch_metric(tk)
        except Exception:
            m = {}
        if m:
            out[tk]["quickRatio"] = _num(m.get("quickRatioAnnual") or m.get("quickRatioQuarterly"))
            out[tk]["inventoryTurnover"] = _num(m.get("inventoryTurnoverTTM") or m.get("inventoryTurnoverAnnual"))
            out[tk]["receivablesTurnover"] = _num(m.get("receivablesTurnoverTTM") or m.get("receivablesTurnoverAnnual"))
            out[tk]["interestCoverage"] = _num(m.get("netInterestCoverageTTM") or m.get("netInterestCoverageAnnual"))
            out[tk]["payoutRatio"] = _num(m.get("payoutRatioAnnual") or m.get("payoutRatioTTM"))
        if (i + 1) % 20 == 0 or i == len(todo) - 1:
            json.dump(out, open(path, "w"), separators=(",", ":"), sort_keys=True)
            print(f"  {i + 1}/{len(todo)} fetched (last: {tk})")
    json.dump(out, open(path, "w"), separators=(",", ":"), sort_keys=True)
    print(f"done: {len(out)} names in {path}")


if __name__ == "__main__":
    main()
