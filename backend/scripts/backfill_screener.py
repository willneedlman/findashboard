"""Warm the screener's FMP fundamentals cache within the free-tier daily cap.

FMP's free plan allows ~250 calls/day and each ticker's bundle costs 3 calls, so
this fetches a bounded number of NEW tickers per run (default 80 -> 240 calls) and
skips anything already cached. Run it daily (cron); over ~12 runs it covers the
full S&P 500 + 400 + Nasdaq 100 universe, after which screens read entirely from
the 30-day disk cache and cost ~0 FMP calls. Steady state just refreshes the
~1/12 of entries that expire each day.

    python -m scripts.backfill_screener          # 80 new tickers
    BACKFILL_DAILY=120 python -m scripts.backfill_screener
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fmp  # noqa: E402

_DAILY = int(os.getenv("BACKFILL_DAILY", "80"))
_PAUSE = float(os.getenv("BACKFILL_PAUSE", "0.4"))   # seconds between fetches, be gentle


def _universe() -> list[str]:
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "data", "index_constituents.json")
    d = json.load(open(path))
    seen: set[str] = set()
    out: list[str] = []
    for key in ("nasdaq100", "sp500", "sp400"):       # priority: most-screened first
        for t in d.get(key, []):
            sym = str(t).strip().upper().replace(".", "-")
            if sym and sym not in seen:
                seen.add(sym)
                out.append(sym)
    return out


def main() -> int:
    if not fmp.available():
        print("FMP_API_KEY not configured; nothing to do.")
        return 0
    universe = _universe()
    fetched = cached = 0
    for sym in universe:
        if fetched >= _DAILY:
            break
        if fmp.get_fundamentals(sym, cached_only=True) is not None:
            cached += 1
            continue
        bundle = fmp.get_fundamentals(sym)            # 3 FMP calls + 30d disk cache
        if bundle:
            fetched += 1
            print(f"  backfilled {sym} ({fetched}/{_DAILY})")
        else:
            print(f"  skipped {sym} (no data / throttled)")
        time.sleep(_PAUSE)
    remaining = sum(1 for s in universe if fmp.get_fundamentals(s, cached_only=True) is None)
    print(f"done: {fetched} fetched, {cached} already cached, ~{remaining} still uncached "
          f"of {len(universe)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
