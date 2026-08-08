"""Build backend/data/index_members.json — the member list for each index
on the Global Markets board.

Run by hand, not at request time. Index membership changes a handful of times a
year, and the alternative (scraping on every open) puts a slow, breakable
dependency in front of a panel that has to render in under a second.

Every ticker is verified against yfinance before it is written. A name that does
not resolve is dropped rather than shipped, so the panel never prices a symbol
that does not exist. Coverage per index is recorded in the file and shown in the
UI, because "48 of 50 members" is a fact the reader is entitled to.

Usage:  python backend/scripts/build_index_members.py [--index ^NSEI]
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import os
import re
import sys
import time
import warnings
from concurrent.futures import ThreadPoolExecutor

import pandas as pd
import requests

warnings.filterwarnings("ignore")

UA = {"User-Agent": "finance-dashboard/1.0 (wneedlman@gmail.com)"}
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "index_members.json")

# (yfinance index symbol) -> (wikipedia page, ticker column, yahoo suffix, weighting)
#
# `suffix` is appended only when the scraped ticker does not already carry one.
# `weighting` labels how the index actually weights its members, so the panel can
# say what a "share" column means instead of implying every index is cap
# weighted. The Dow and the Nikkei are price weighted, which changes the answer
# to "what moves this index" completely.
SOURCES: dict[str, dict] = {
    "^GSPC":      dict(page="List_of_S%26P_500_companies",      col="symbol", suffix="",     weighting="cap",   min_rows=400),
    "^DJI":       dict(page="Dow_Jones_Industrial_Average",      col="symbol", suffix="",     weighting="price", min_rows=25),
    "^IXIC":      dict(page="List_of_NASDAQ-100_companies",      col="ticker", suffix="",     weighting="cap",   min_rows=90,
                       note="Nasdaq-100 members. The Nasdaq Composite has roughly 3,000 members and no published list."),
    "^RUT":       dict(skip="The Russell 2000 has 2,000 members and FTSE Russell does not publish a free constituent list."),
    "^GSPTSE":    dict(page="S%26P/TSX_60",                      col="symbol", suffix=".TO",  weighting="cap",   min_rows=50,
                       note="S&P/TSX 60 members, the large-cap subset of the composite."),
    "^FTSE":      dict(page="FTSE_100_Index",                    col="ticker", suffix=".L",   weighting="cap",   min_rows=90),
    "^GDAXI":     dict(page="DAX",                               col="ticker", suffix=".DE",  weighting="cap",   min_rows=35),
    "^FCHI":      dict(page="CAC_40",                            col="ticker", suffix=".PA",  weighting="cap",   min_rows=35),
    "^STOXX50E":  dict(page="EURO_STOXX_50",                     col="ticker", suffix="",     weighting="cap",   min_rows=40),
    "^IBEX":      dict(page="IBEX_35",                           col="ticker", suffix=".MC",  weighting="cap",   min_rows=30),
    "^SSMI":      dict(page="Swiss_Market_Index",                col="ticker", suffix=".SW",  weighting="cap",   min_rows=15),
    "^AEX":       dict(page="AEX_index",                         col="ticker", suffix=".AS",  weighting="cap",   min_rows=20),
    "FTSEMIB.MI": dict(page="FTSE_MIB",                          col="ticker", suffix=".MI",  weighting="cap",   min_rows=30),
    # Wikipedia renders the Nikkei's members as a sectioned bullet list, not a
    # table, so this one is parsed out of the list items.
    "^N225":      dict(page="Nikkei_225", list_section="Components", list_re=r"\(\s*TYO\s*:\s*(\d{4})\s*\)",
                       suffix=".T", weighting="price"),
    "^HSI":       dict(page="Hang_Seng_Index",                   col="ticker", suffix=".HK",  weighting="cap",   min_rows=60),
    "^NSEI":      dict(page="NIFTY_50",                          col="symbol", suffix=".NS",  weighting="cap",   min_rows=45),
    "^AXJO":      dict(page="S%26P/ASX_200",                     col="code",   suffix=".AX",  weighting="cap",   min_rows=150),
    "^STI":       dict(page="Straits_Times_Index",               col="symbol", suffix=".SI",  weighting="cap",   min_rows=20),
    "^KS11":      dict(skip="No free published constituent list for the full KOSPI."),
    "^TWII":      dict(skip="No free published constituent list for the TAIEX."),
    "000001.SS":  dict(skip="The Shanghai Composite has roughly 2,200 members and no published list."),
    "000300.SS":  dict(skip="No free published constituent list for the CSI 300."),
    "^MXX":       dict(skip="No reliable free constituent list for the IPC."),
    "^BVSP":      dict(skip="No reliable free constituent list for the Bovespa."),
    "^VIX":       dict(skip="The VIX is a volatility calculation, not a basket of shares."),
}

# Hong Kong codes are zero-padded to four digits on Yahoo; Tokyo codes are bare.
def _normalise(raw: str, suffix: str) -> str | None:
    t = str(raw).strip().upper()
    t = re.sub(r"\[.*?\]", "", t).strip()
    # Some tables write the venue inline: "SGX: J36".
    t = t.split(":")[-1].strip()
    if not t or t in ("NAN", "-", "—"):
        return None
    if "." in t and not t.endswith("."):          # already carries an exchange suffix
        head, tail = t.rsplit(".", 1)
        if not tail.isdigit():
            return t
    t = t.rstrip(".")
    if suffix == ".HK":
        digits = re.sub(r"\D", "", t)
        return f"{digits.zfill(4)}{suffix}" if digits else None
    if suffix == ".T":
        digits = re.sub(r"\D", "", t)
        return f"{digits}{suffix}" if digits else None
    # Yahoo writes UK share classes with a hyphen: BT.A -> BT-A.L
    t = t.replace(".", "-")
    return f"{t}{suffix}" if suffix else t


def _pick_column(table: pd.DataFrame, wanted: str):
    for c in table.columns:
        if re.sub(r"\[.*?\]", "", str(c)).strip().lower() == wanted:
            return c
    for c in table.columns:
        if wanted in str(c).lower():
            return c
    return None


def _scrape_list(html: str, spec: dict) -> list[tuple[str, str]]:
    """[(ticker, company name)] from a bullet list rather than a table."""
    start = html.find(f'id="{spec["list_section"]}"')
    if start == -1:
        return []
    out: list[tuple[str, str]] = []
    for item in re.findall(r"<li[^>]*>(.*?)</li>", html[start:], re.S):
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", item)).strip()
        m = re.search(spec["list_re"], text)
        if not m:
            continue
        name = text[:m.start()].strip().rstrip("(").strip()
        # The first item trails the section's own prose. Keep the last sentence,
        # which is the company, and drop the paragraph that preceded it.
        if len(name) > 70:
            name = re.split(r"\[edit\]|(?<=[a-z])\.\s+(?=[A-Z])", name)[-1].strip()
        out.append((f"{m.group(1)}{spec['suffix']}", name or m.group(1)))
    return out


def _scrape(spec: dict) -> list[tuple[str, str]]:
    """[(ticker, company name)] from the page's constituent table."""
    html = requests.get(f"https://en.wikipedia.org/wiki/{spec['page']}", headers=UA, timeout=30).text
    if spec.get("list_section"):
        return _scrape_list(html, spec)
    for table in pd.read_html(io.StringIO(html)):
        tcol = _pick_column(table, spec["col"])
        if tcol is None or len(table) < spec["min_rows"]:
            continue
        ncol = None
        for cand in ("company", "name", "company name", "security", "issuer"):
            ncol = _pick_column(table, cand)
            if ncol is not None:
                break
        out: list[tuple[str, str]] = []
        for _, row in table.iterrows():
            sym = _normalise(row[tcol], spec["suffix"])
            if not sym:
                continue
            name = re.sub(r"\[.*?\]", "", str(row[ncol])).strip() if ncol is not None else sym
            out.append((sym, name or sym))
        if out:
            return out
    return []


def _verify(symbols: list[str]) -> dict[str, dict]:
    """{ticker: {shares, currency}} for the subset Yahoo actually prices.

    Share count rather than market cap on purpose. A cap frozen at build time is
    wrong by the next session; shares outstanding moves a few times a year, so
    storing it lets the API compute an exact live cap from the price it is
    already downloading, with no extra request per name."""
    import yfinance as yf
    out: dict[str, dict] = {}

    def one(sym: str):
        # Yahoo throttles a long run hard. Back off rather than record a live
        # name as dead, which would silently shrink an index.
        for attempt in range(4):
            try:
                fi = yf.Ticker(sym).fast_info
                price = fi.get("lastPrice")
                if not price:
                    return None
                shares = fi.get("shares")
                return sym, {"shares": int(shares) if shares else None,
                             "currency": fi.get("currency") or None}
            except Exception:
                time.sleep(1.5 * (attempt + 1))
        return None

    with ThreadPoolExecutor(4) as pool:
        for i, res in enumerate(pool.map(one, symbols), 1):
            if res:
                out[res[0]] = res[1]
            if i % 100 == 0:
                print(f"    verified {i}/{len(symbols)}", file=sys.stderr)
    return out


def build(only: str | None = None) -> dict:
    existing = {}
    if os.path.exists(OUT):
        with open(OUT) as fh:
            existing = json.load(fh).get("indices", {})

    indices: dict[str, dict] = dict(existing)
    for sym, spec in SOURCES.items():
        if only and sym != only:
            continue
        if "skip" in spec:
            indices[sym] = {"unavailable": spec["skip"]}
            print(f"{sym}: skipped ({spec['skip'][:48]}…)", file=sys.stderr)
            continue
        print(f"{sym}: scraping {spec['page']}", file=sys.stderr)
        try:
            scraped = _scrape(spec)
        except Exception as exc:
            print(f"{sym}: FAILED {exc}", file=sys.stderr)
            continue
        if not scraped:
            print(f"{sym}: no constituent table matched", file=sys.stderr)
            continue
        scraped = list(dict.fromkeys(scraped))
        live = _verify([s for s, _ in scraped])
        members = [
            {"ticker": s, "name": n, **live[s]}
            for s, n in scraped if s in live
        ]
        currencies = [m["currency"] for m in members if m.get("currency")]
        prior = existing.get(sym, {})
        if len(members) < len(prior.get("members", [])) * 0.9:
            print(f"{sym}: KEPT prior list ({len(prior['members'])}) — this run only resolved {len(members)}", file=sys.stderr)
            continue
        indices[sym] = {
            "currency": max(set(currencies), key=currencies.count) if currencies else None,
            "members": members,
            "weighting": spec["weighting"],
            "scraped": len(scraped),
            "resolved": len(members),
            "source": f"en.wikipedia.org/wiki/{spec['page']}",
            "as_of": dt.date.today().isoformat(),
            **({"note": spec["note"]} if spec.get("note") else {}),
        }
        print(f"{sym}: {len(members)}/{len(scraped)} resolved", file=sys.stderr)

    payload = {"built": dt.date.today().isoformat(), "indices": indices}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as fh:
        json.dump(payload, fh, indent=1, sort_keys=True)
    return payload


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--index", help="rebuild a single index, e.g. ^NSEI")
    args = ap.parse_args()
    data = build(args.index)
    ok = {k: v.get("resolved") for k, v in data["indices"].items() if "members" in v}
    print(f"\nwrote {OUT}\n{len(ok)} indices: {ok}", file=sys.stderr)
