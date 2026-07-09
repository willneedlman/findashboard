"""Live reconnaissance of macro-calendar consensus sources.

Hits the real endpoints where possible with our configured keys, and inspects
the actual payload to locate the consensus/survey field. Enterprise-only feeds
(FocusEconomics, Consensus Economics) are covered by documented-schema mocks in
probe_institutional.py.

Run: python3 macro_probe/probe_apis.py
"""
from __future__ import annotations

import json
import os
import sys

import requests
from dotenv import dotenv_values

BACKEND = os.path.join(os.path.dirname(__file__), "..", "backend")
ENV = dotenv_values(os.path.join(BACKEND, ".env"))
FINNHUB = ENV.get("FINNHUB_API_KEY", "")
FMP = ENV.get("FMP_API_KEY", "")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"


def line(title: str) -> None:
    print("\n" + "=" * 78 + f"\n{title}\n" + "=" * 78)


def show(obj, n=1) -> None:
    print(json.dumps(obj[:n] if isinstance(obj, list) else obj, indent=2, default=str)[:900])


def finnhub():
    line("1a. FINNHUB /calendar/economic  (consensus field: 'estimate')")
    url = f"https://finnhub.io/api/v1/calendar/economic?from=2026-07-01&to=2026-07-31&token={FINNHUB}"
    r = requests.get(url, timeout=20)
    print(f"HTTP {r.status_code}")
    if r.status_code == 200:
        data = r.json().get("economicCalendar", [])
        print(f"rows: {len(data)}")
        if data:
            show(data, 2)
            print("\nconsensus field present:", "estimate" in data[0], "| keys:", list(data[0].keys()))
    else:
        print("BODY:", r.text[:200])
        print("VERDICT: economic-calendar is gated on the free/standard tier (needs paid plan).")


def fmp():
    line("1b. FMP economic calendar  (consensus field: 'estimate')")
    for label, url in [
        ("v3", f"https://financialmodelingprep.com/api/v3/economic_calendar?from=2026-07-01&to=2026-07-31&apikey={FMP}"),
        ("stable", f"https://financialmodelingprep.com/stable/economic-calendar?from=2026-07-01&to=2026-07-31&apikey={FMP}"),
    ]:
        r = requests.get(url, timeout=20)
        print(f"[{label}] HTTP {r.status_code}: {r.text[:120]}")
    print("DOCUMENTED SCHEMA (paid tiers): {date, country, event, currency, previous, estimate, actual, change, impact}")
    print("  -> 'estimate' = FMP's consensus figure. Endpoint 402/429 on our free key.")


def trading_economics():
    line("1c. TRADING ECONOMICS /calendar  (fields: 'Forecast' vs 'TEForecast')")
    # Historic free guest key
    r = requests.get("https://api.tradingeconomics.com/calendar?c=guest:guest&format=json", timeout=20)
    print(f"[guest:guest] HTTP {r.status_code}: {r.text[:160]}")
    print("DOCUMENTED SCHEMA: each row has BOTH:")
    print("  * 'Forecast'   = pooled market/survey consensus TE republishes")
    print("  * 'TEForecast' = Trading Economics' own econometric model value")
    print("  -> To get true survey consensus, read 'Forecast' (not 'TEForecast').")


def forex_factory():
    line("3a. FOREX FACTORY  (public weekly JSON feed; consensus field: 'forecast')")
    # The calendar the FF site itself loads; used by most open-source FF wrappers.
    for label, url in [
        ("thisweek", "https://nfs.faireconomy.media/ff_calendar_thisweek.json"),
        ("nextweek", "https://nfs.faireconomy.media/ff_calendar_nextweek.json"),
    ]:
        try:
            r = requests.get(url, headers={"User-Agent": UA}, timeout=25)
            print(f"[{label}] HTTP {r.status_code}, {len(r.content)} bytes")
            if r.status_code == 200:
                data = r.json()
                print(f"  events: {len(data)}")
                # find a high-impact US event with a forecast
                hi = [e for e in data if e.get("impact") == "High" and e.get("forecast")]
                sample = hi[0] if hi else data[0]
                show(sample)
                print("  consensus field:", "'forecast' =", repr(sample.get("forecast")),
                      "| keys:", list(sample.keys()))
                return data
        except Exception as e:
            print(f"[{label}] ERR {e}")
    return None


def investing():
    line("3b. INVESTING.COM  (AJAX getCalendarFilteredData; consensus col = 'Forecast')")
    url = "https://www.investing.com/economic-calendar/Service/getCalendarFilteredData"
    headers = {"User-Agent": UA, "X-Requested-With": "XMLHttpRequest",
               "Content-Type": "application/x-www-form-urlencoded", "Referer": "https://www.investing.com/economic-calendar/"}
    body = "country%5B%5D=5&importance%5B%5D=3&timeZone=8&timeFilter=timeRemain&currentTab=thisWeek&limit_from=0"
    try:
        r = requests.post(url, headers=headers, data=body, timeout=25)
        print(f"HTTP {r.status_code}, {len(r.content)} bytes")
        if r.status_code == 200:
            from bs4 import BeautifulSoup
            html = r.json().get("data", "") if r.headers.get("content-type", "").startswith("application/json") else r.text
            soup = BeautifulSoup(html, "html.parser")
            rows = soup.select("tr.js-event-item")
            print(f"  parsed event rows: {len(rows)}")
            if rows:
                td = rows[0].find_all("td")
                cols = [c.get_text(strip=True) for c in td]
                print("  first row cells:", cols)
                print("  -> forecast column = the 'eventActual/eventForecast/eventPrevious' cells (consensus = Forecast).")
        else:
            print("BODY:", r.text[:160])
            print("  VERDICT: Cloudflare/anti-bot likely blocks server-side requests; needs a real browser (playwright).")
    except Exception as e:
        print(f"ERR {e}  -> Cloudflare/anti-bot; use playwright.")


if __name__ == "__main__":
    print("keys:", {"FINNHUB": bool(FINNHUB), "FMP": bool(FMP)})
    finnhub()
    fmp()
    trading_economics()
    forex_factory()
    investing()
    print("\nDone. See probe_institutional.py for FocusEconomics / Consensus Economics schema mocks.")
