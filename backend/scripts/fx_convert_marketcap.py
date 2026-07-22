"""Follow-up to patch_fx_marketcap.py: that pass correctly NULLED OUT market
cap for every foreign-currency-denominated entry (TSM, ASML, SAP, NVO, BABA,
…) rather than report a wrong number — safe, but it left large, legitimate
ADRs unusable for market-cap filtering, defeating the actual point of adding
them to the seed. This re-fetches the raw local-currency figure for each of
those entries, converts to USD with a live FX rate (yfinance, already a core
dependency — one quote per distinct currency, not per company), and writes
the corrected marketCap/price back.

Run:  python3 backend/scripts/fx_convert_marketcap.py
"""
import json
import os
import time

import requests
import yfinance as yf

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

    # Re-fetch raw local-currency figures for every entry with a null
    # marketCap and a foreign country — patch_fx_marketcap.py nulled these
    # out without keeping the raw value + currency, so we need it fresh.
    candidates = sorted(k for k, v in d.items()
                         if v.get("marketCap") is None and v.get("country") not in ("United States", None, ""))
    print(f"re-fetching raw local-currency data for {len(candidates)} entries...")

    raw: dict = {}   # ticker -> (local_market_cap_millions, currency, shares_out)
    for tk in candidates:
        r = _session.get(f"{BASE}/stock/profile2", params={"symbol": tk, "token": _KEY}, timeout=10)
        time.sleep(1.05)
        if r.status_code != 200:
            continue
        p = r.json() or {}
        cur = p.get("currency")
        mc = p.get("marketCapitalization")
        sh = p.get("shareOutstanding")
        if cur and cur != "USD" and mc is not None:
            raw[tk] = (mc, cur, sh)

    currencies = sorted({cur for _mc, cur, _sh in raw.values()})
    print(f"distinct currencies to convert: {currencies}")

    # One FX quote per currency, not per company. yfinance "XXXUSD=X" gives
    # units of USD per 1 unit of XXX directly.
    fx_usd_per_unit: dict = {}
    for cur in currencies:
        try:
            t = yf.Ticker(f"{cur}USD=X")
            hist = t.history(period="5d")
            if not hist.empty:
                fx_usd_per_unit[cur] = float(hist["Close"].dropna().iloc[-1])
        except Exception as e:
            print(f"  FX lookup failed for {cur}: {e}")
    print(f"FX rates (USD per 1 unit): {fx_usd_per_unit}")

    converted = 0
    for tk, (mc_local_m, cur, sh) in raw.items():
        rate = fx_usd_per_unit.get(cur)
        if rate is None:
            continue
        mc_usd_m = mc_local_m * rate
        d[tk]["marketCap"] = round(mc_usd_m / 1000, 2)   # $M -> $B
        if sh:
            d[tk]["price"] = round(mc_usd_m / sh, 2)
        converted += 1
        print(f"  {tk}: {mc_local_m:.0f}M {cur} x {rate:.4f} = ${mc_usd_m/1000:.1f}B")

    json.dump(d, open(path, "w"), separators=(",", ":"), sort_keys=True)
    print(f"done: {converted}/{len(candidates)} entries converted to USD and saved")


if __name__ == "__main__":
    main()
