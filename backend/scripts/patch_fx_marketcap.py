"""One-off patch: re-check every foreign-domiciled entry in us_fundamentals.json
against Finnhub's live /stock/profile2 currency field, and null out marketCap
(+ the price derived from it) for any that are quoted in a non-USD local
currency — see the matching fix in finnhub.py get_profile() and
build_us_fundamentals.py/expand_us_fundamentals.py _fetch() for why.

Run:  python3 backend/scripts/patch_fx_marketcap.py
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


def main():
    path = os.path.join(DATA, "us_fundamentals.json")
    d = json.load(open(path))
    foreign = sorted(k for k, v in d.items() if v.get("country") not in ("United States", None, ""))
    print(f"checking {len(foreign)} foreign-domiciled entries...")

    patched, checked = [], 0
    for tk in foreign:
        r = _session.get(f"{BASE}/stock/profile2", params={"symbol": tk, "token": _KEY}, timeout=10)
        time.sleep(1.05)
        checked += 1
        if r.status_code != 200:
            continue
        p = r.json() or {}
        currency = p.get("currency")
        if currency not in (None, "USD"):
            entry = d[tk]
            if entry.get("marketCap") is not None or entry.get("price") is not None:
                print(f"  patching {tk}: currency={currency}, was marketCap={entry.get('marketCap')}B price={entry.get('price')}")
                entry["marketCap"] = None
                entry["price"] = None
                patched.append(tk)
        if checked % 20 == 0:
            json.dump(d, open(path, "w"), separators=(",", ":"), sort_keys=True)
            print(f"  {checked}/{len(foreign)} checked, {len(patched)} patched so far")

    json.dump(d, open(path, "w"), separators=(",", ":"), sort_keys=True)
    print(f"done: {len(patched)}/{len(foreign)} entries patched (non-USD currency, marketCap/price nulled)")
    print(sorted(patched))


if __name__ == "__main__":
    main()
