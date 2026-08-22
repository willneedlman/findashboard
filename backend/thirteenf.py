"""Institutional holdings from SEC 13F filings.

What a 13F is, because the tool must not overstate it: a QUARTERLY SNAPSHOT of
long US-listed equity positions, filed up to 45 days after the quarter ends by
managers over $100M. The change columns here are a diff between two snapshots,
not a trade log. A fund can buy and sell inside a quarter and show nothing, and
a position that disappears may have been sold or may simply no longer be
reportable. Shorts, non-US listings and bonds never appear at all.

Three facts the raw filings force on any consumer:

  Rows are per-manager, not per-issuer. Berkshire's Q2 2026 table has 89 rows
  for 29 positions, so anything meaningful starts by aggregating on CUSIP.

  Share classes are separate CUSIPs. Alphabet A and C are two rows and stay
  two rows, because they are two securities with two prices.

  Securities are identified by CUSIP, and SEC publishes no CUSIP-to-ticker map.
  Resolution goes through OpenFIGI, and identifiers beginning with a letter are
  CINS (foreign issuers), which is a different idType.
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import date
from pathlib import Path

import requests

from cache import cached

try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None                     # type: ignore
    def disk_set(_k, _v, ttl=0): pass                 # type: ignore

logger = logging.getLogger(__name__)

# Every filer for a quarter, from SEC's own bulk dataset, built by
# scripts/build_13f_db.py. Crawling EDGAR one manager at a time gave twenty
# funds and minutes of latency; this gives about ten thousand and answers from
# disk. The live path below stays for the newest filings, because the bulk file
# is published a quarter behind.
# The volume in production, the repo in development. It is 126MB for two
# quarters, which is too big for git and too slow to rebuild on every deploy, so
# it lives on the mounted volume and is refreshed when SEC publishes a quarter.
_DB_PATHS = [Path(os.getenv("THIRTEENF_DB", "/data/thirteenf.db")),
             Path(__file__).resolve().parent / "data" / "thirteenf.db"]


def _db_path() -> Path | None:
    return next((p for p in _DB_PATHS if p.exists()), None)


def _db() -> sqlite3.Connection | None:
    _DB = _db_path()
    if _DB is None:
        return None
    try:
        conn = sqlite3.connect(f"file:{_DB}?mode=ro", uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception as e:
        logger.warning("13F database unavailable: %s", e)
        return None


def db_available() -> bool:
    return _db_path() is not None

_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_TIMEOUT = 30
_QUARTER = 30 * 86400          # filings only change quarterly
_FOREVER = 365 * 86400         # a CUSIP's ticker does not change


# ── SEC filings ──────────────────────────────────────────────────────────────

# An empty result here is a failed fetch far more often than a filer with no
# 13F, and this module caches for a month. Without the predicate one bad second
# hides a manager until the quarter turns, which is the same trap that hid Exxon
# and the FOMC minutes earlier.
@cached(ttl=_QUARTER, maxsize=256, persist=True, skip_if=lambda r: not r.get("filings"))
def filings(cik: str) -> dict:
    """Every 13F-HR a manager has filed, newest first."""
    try:
        j = requests.get(f"https://data.sec.gov/submissions/CIK{int(cik):010d}.json",
                         headers=_UA, timeout=_TIMEOUT).json()
    except Exception as e:
        logger.warning("13F submissions failed for %s: %s", cik, e)
        return {"name": None, "filings": []}
    rec = j.get("filings", {}).get("recent", {})
    out = []
    for i, form in enumerate(rec.get("form", [])):
        if form not in ("13F-HR", "13F-HR/A"):
            continue
        out.append({"accession": rec["accessionNumber"][i], "period": rec["reportDate"][i],
                    "filed": rec["filingDate"][i], "amended": form.endswith("/A")})
    return {"name": j.get("name"), "cik": f"{int(cik):010d}", "filings": out}


def _table_url(cik: str, accession: str) -> str | None:
    """The information table inside a filing. Its name varies by filer agent, so
    it is found by elimination rather than guessed."""
    nod = accession.replace("-", "")
    try:
        idx = requests.get(f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{nod}/index.json",
                           headers=_UA, timeout=_TIMEOUT).json()
    except Exception as e:
        logger.warning("13F index failed for %s/%s: %s", cik, accession, e)
        return None
    for item in idx.get("directory", {}).get("item", []):
        n = item.get("name", "")
        if n.endswith(".xml") and "primary_doc" not in n and not n.startswith("xsl"):
            return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{nod}/{n}"
    return None


@cached(ttl=_QUARTER, maxsize=128, persist=True, skip_if=lambda r: not r.get("positions"))
def holdings(cik: str, accession: str) -> dict:
    """Positions from one filing, aggregated by CUSIP.

    Only SH rows are kept: PRN is a principal amount, so counting it as shares
    would put a bond's face value in a share column.
    """
    url = _table_url(cik, accession)
    if not url:
        return {}
    try:
        root = ET.fromstring(requests.get(url, headers=_UA, timeout=60).text)
    except Exception as e:
        logger.warning("13F table failed for %s/%s: %s", cik, accession, e)
        return {}
    ns = {"n": root.tag.split("}")[0].strip("{")} if "}" in root.tag else {}
    def find(el, tag):
        return el.find(f"n:{tag}", ns) if ns else el.find(tag)

    agg: dict[str, dict] = defaultdict(
        lambda: {"issuer": None, "class": None, "value": 0.0, "shares": 0.0,
                 "calls": 0.0, "puts": 0.0, "optionValue": 0.0})
    rows = root.findall("n:infoTable", ns) if ns else root.findall("infoTable")
    for it in rows:
        amt = find(it, "shrsOrPrnAmt")
        if amt is None or (find(amt, "sshPrnamtType").text or "").strip() != "SH":
            continue
        cusip_el = find(it, "cusip")
        if cusip_el is None or not cusip_el.text:
            continue
        a = agg[cusip_el.text.strip().upper()]
        a["issuer"] = (find(it, "nameOfIssuer").text or "").strip()
        cls = find(it, "titleOfClass")
        a["class"] = (cls.text or "").strip() if cls is not None else None
        value = float(find(it, "value").text or 0)
        shares = float(find(amt, "sshPrnamt").text or 0)
        opt = find(it, "putCall")
        kind = (opt.text or "").strip().lower() if opt is not None else ""
        # Option lines sit beside stock lines under the same issuer and must stay
        # out of both totals. Their shares are exposure rather than ownership,
        # and their value is an option's value: folding it in makes the position
        # report a price per share that no row supports.
        if kind == "call":
            a["calls"] += shares
            a["optionValue"] += value
        elif kind == "put":
            a["puts"] += shares
            a["optionValue"] += value
        else:
            a["shares"] += shares
            a["value"] += value
    return {"positions": dict(agg), "rows": len(rows)}


# ── CUSIP resolution ─────────────────────────────────────────────────────────

_figi_lock = threading.Lock()
_figi_last = 0.0


def _figi(body: list[dict]) -> list | None:
    """One OpenFIGI mapping call, throttled.

    Keyless allows 25 requests a minute at 10 jobs each. Set OPENFIGI_API_KEY to
    lift it. Results are cached forever, so the throttle is only ever paid on
    identifiers nobody has looked up before.
    """
    global _figi_last
    import os
    key = os.getenv("OPENFIGI_API_KEY", "")
    headers = {"Content-Type": "application/json"}
    if key:
        headers["X-OPENFIGI-APIKEY"] = key
    gap = 0.25 if key else 2.5
    with _figi_lock:
        wait = gap - (time.time() - _figi_last)
        if wait > 0:
            time.sleep(wait)
        _figi_last = time.time()
    try:
        r = requests.post("https://api.openfigi.com/v3/mapping", json=body,
                          headers=headers, timeout=_TIMEOUT)
        return r.json() if r.status_code == 200 else None
    except Exception as e:
        logger.warning("OpenFIGI failed: %s", e)
        return None


@cached(ttl=_QUARTER, maxsize=4, persist=True, skip_if=lambda r: not r)
def _us_tickers() -> list:
    """Every ticker SEC lists, used to pick a US listing out of a global set."""
    try:
        j = requests.get("https://www.sec.gov/files/company_tickers.json",
                         headers=_UA, timeout=_TIMEOUT).json()
        return sorted({v["ticker"] for v in j.values()})
    except Exception as e:
        logger.warning("SEC ticker file failed: %s", e)
        return []


def resolve_cusips(cusips: list[str]) -> dict[str, str]:
    """CUSIP -> US ticker, cached permanently per identifier.

    Two passes, because one is not enough. The US-composite query answers most
    of them; Exxon is the counter-example, whose US listing is absent from that
    view while its ticker trades on eleven others. So a miss retries unfiltered
    and takes the first ticker SEC also lists, which grounds the answer in a
    real US listing rather than the first foreign line that comes back.
    """
    out: dict[str, str] = {}
    pending: list[str] = []

    # The bulk dataset already carries a ticker for every security anyone holds
    # in size, resolved once at build time. Consulting it first means the live
    # path almost never touches the rate-limited mapping API.
    conn = _db()
    if conn:
        try:
            marks = ",".join("?" * len(cusips))
            for r in conn.execute(
                f"SELECT cusip, ticker FROM securities WHERE ticker IS NOT NULL"
                f" AND cusip IN ({marks})", tuple(cusips)).fetchall():
                out[r["cusip"]] = r["ticker"]
        except Exception as e:
            logger.info("ticker lookup from the dataset failed: %s", e)
        finally:
            conn.close()

    for c in cusips:
        if c in out:
            continue
        hit = disk_get(f"figi:v1:{c}")
        if hit:
            out[c] = hit
        elif hit != "":                       # "" is a remembered miss
            pending.append(c)
    if not pending:
        return out

    idtype = lambda c: "ID_CINS" if c[:1].isalpha() else "ID_CUSIP"
    universe = set(_us_tickers())
    for i in range(0, len(pending), 10):
        batch = pending[i:i + 10]
        res = _figi([{"idType": idtype(c), "idValue": c, "exchCode": "US"} for c in batch]) or []
        for c, d in zip(batch, res):
            rows = (d or {}).get("data") or []
            if rows and rows[0].get("ticker"):
                out[c] = rows[0]["ticker"]
        miss = [c for c in batch if c not in out]
        if miss:
            res2 = _figi([{"idType": idtype(c), "idValue": c} for c in miss]) or []
            for c, d in zip(miss, res2):
                for row in ((d or {}).get("data") or []):
                    t = row.get("ticker")
                    if t and t in universe:
                        out[c] = t
                        break
        for c in batch:
            # Remember misses too, so an unmappable identifier is not retried on
            # every view for the length of the cache.
            disk_set(f"figi:v1:{c}", out.get(c, ""), ttl=_FOREVER)
    return out


@cached(ttl=_QUARTER, maxsize=8, persist=True, skip_if=lambda r: not r)
def _shares_outstanding(period: str) -> dict:
    """Shares outstanding for every filer in one call, keyed by CIK.

    SEC's frames endpoint returns ~4,400 filers in 0.6MB, which is what makes
    "% of shares outstanding" affordable at all: the alternative is one request
    per position.
    """
    y, m = int(period[:4]), int(period[5:7])
    frame = f"CY{y}Q{(m - 1) // 3 + 1}I"
    try:
        j = requests.get(
            f"https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/{frame}.json",
            headers=_UA, timeout=60).json()
    except Exception as e:
        logger.info("shares-outstanding frame %s unavailable: %s", frame, e)
        return {}
    return {str(x["cik"]): float(x["val"]) for x in j.get("data", []) if x.get("val")}


@cached(ttl=_QUARTER, maxsize=4, persist=True, skip_if=lambda r: not r)
def _ticker_ciks() -> dict:
    try:
        j = requests.get("https://www.sec.gov/files/company_tickers.json",
                         headers=_UA, timeout=_TIMEOUT).json()
        return {v["ticker"]: str(v["cik_str"]) for v in j.values()}
    except Exception as e:
        logger.warning("SEC ticker file failed: %s", e)
        return {}


# ── The book ─────────────────────────────────────────────────────────────────

def _pct_change(now: float, then: float | None) -> float | None:
    """None when there is nothing to compare against. A new position is not a
    100% increase, it is a new position, and the caller labels it that way."""
    if then in (None, 0):
        return None
    return (now / then - 1.0) * 100


def book(cik: str, accession: str | None = None, limit: int = 500) -> dict:
    """A manager's positions for one quarter, against the quarter before it.

    EDGAR first, because the bulk dataset is published a quarter behind and a
    manager who filed last week should not read as three months stale. The
    dataset answers when the live fetch has nothing, which covers every filer it
    knows and every quarter it stores.
    """
    meta = filings(cik)
    fl = meta.get("filings") or []
    if not fl:
        stored = db_book(cik)
        if stored:
            return stored
        return {"available": False, "reason": "This filer has no 13F on record."}

    idx = 0
    if accession:
        idx = next((i for i, f in enumerate(fl) if f["accession"] == accession), 0)
    cur_f = fl[idx]
    # The comparison is the previous PERIOD, not the previous filing: an
    # amendment restates a quarter and would otherwise diff against itself.
    prev_f = next((f for f in fl[idx + 1:] if f["period"] < cur_f["period"]), None)

    cur = (holdings(cik, cur_f["accession"]) or {}).get("positions") or {}
    prev = (holdings(cik, prev_f["accession"]) or {}).get("positions") or {} if prev_f else {}
    total = sum(p["value"] for p in cur.values()) or 1.0

    ranked = sorted(cur.items(), key=lambda kv: -kv[1]["value"])[:limit]
    gone = [c for c, _ in sorted(prev.items(), key=lambda kv: -kv[1]["value"]) if c not in cur][:50]
    # Exited names need a ticker too, or the one row a reader most wants to
    # identify is the only one showing a raw CUSIP.
    tickers = resolve_cusips([c for c, _ in ranked] + gone)
    shares_out = _shares_outstanding(cur_f["period"])
    ciks = _ticker_ciks()

    rows = []
    for cusip, pos in ranked:
        was = prev.get(cusip)
        chg = pos["shares"] - was["shares"] if was else None
        ticker = tickers.get(cusip)
        out = shares_out.get(ciks.get(ticker or "", ""), 0) if ticker else 0
        rows.append({
            "cusip": cusip,
            "ticker": ticker,
            "issuer": pos["issuer"],
            "class": pos["class"],
            "value": pos["value"],
            "weight": pos["value"] / total * 100,
            "shares": pos["shares"],
            "calls": pos["calls"] or None,
            "puts": pos["puts"] or None,
            "optionValue": pos.get("optionValue") or None,
            "sharesChange": chg,
            "pctChange": _pct_change(pos["shares"], was["shares"] if was else None),
            "pctOutstanding": (pos["shares"] / out * 100) if out else None,
            "status": "new" if not was else ("added" if (chg or 0) > 0 else
                                             "trimmed" if (chg or 0) < 0 else "held"),
        })

    # A name in the prior quarter and not this one is no longer REPORTED. It may
    # have been sold, or it may no longer be reportable, and the filing cannot
    # tell the difference.
    dropped = [{"cusip": c, "issuer": prev[c]["issuer"], "shares": prev[c]["shares"],
                "value": prev[c]["value"], "ticker": tickers.get(c), "status": "exited"}
               for c in gone]

    return {
        "available": True,
        "cik": meta.get("cik"),
        "manager": meta.get("name"),
        "period": cur_f["period"],
        "filed": cur_f["filed"],
        "amended": cur_f["amended"],
        "comparedTo": prev_f["period"] if prev_f else None,
        "positions": len(cur),
        "filingRows": (holdings(cik, cur_f["accession"]) or {}).get("rows"),
        "totalValue": total,
        "quarters": [{"accession": f["accession"], "period": f["period"],
                      "filed": f["filed"], "amended": f["amended"]} for f in fl[:20]],
        "rows": rows,
        "exited": dropped,
        "unmapped": sum(1 for r in rows if not r["ticker"]),
    }


# ── Finding a manager ────────────────────────────────────────────────────────

@cached(ttl=_QUARTER, maxsize=256, persist=True, skip_if=lambda r: not r, version=2)
def search_managers(query: str) -> list:
    """Managers matching a name, restricted to filers with a 13F on record.

    Names come from the submissions endpoint rather than the search feed:
    EDGAR's atom output renders every company name as a Perl array reference
    ("ARRAY(0x55a1...)"), so the feed is only good for CIKs. Confirming through
    submissions also drops filers whose only 13F is a notice, and it is free
    because the same call is cached for the holdings view.
    """
    import re
    q = (query or "").strip()
    hits = db_search(q)
    if hits:
        return hits
    # Without the dataset there is no list to show. There used to be twenty
    # hand-typed CIKs here and four of them were wrong, labelling Soros as AQR
    # and Man Group as Appaloosa, which is worse than showing nothing: a name
    # typed from memory beside real holdings reads as fact.
    if len(q) < 2:
        return []
    try:
        r = requests.get("https://www.sec.gov/cgi-bin/browse-edgar",
                         params={"company": q, "type": "13F-HR", "dateb": "", "owner": "include",
                                 "count": "25", "action": "getcompany", "output": "atom"},
                         headers=_UA, timeout=_TIMEOUT)
        r.raise_for_status()
        ciks = list(dict.fromkeys(re.findall(r"<cik>(\d{7,10})</cik>", r.text)
                                  or re.findall(r"CIK=(\d{7,10})", r.text)))
    except Exception as e:
        logger.warning("manager search failed for %s: %s", q, e)
        return []

    out = []
    for cik in ciks[:10]:
        meta = filings(cik)
        if meta.get("name") and meta.get("filings"):
            out.append({"cik": meta["cik"], "name": meta["name"],
                        "latest": meta["filings"][0]["period"],
                        "quarters": len(meta["filings"])})
    return out


def db_search(query: str, limit: int = 40) -> list:
    """Managers matching a name, from the bulk dataset.

    Ten thousand filers, answered from disk. Ranked by reported value so the
    names anyone is looking for come first rather than alphabetically.
    """
    conn = _db()
    if not conn:
        return []
    q = (query or "").strip()
    try:
        if q:
            rows = conn.execute(
                "SELECT cik, name, MAX(period) period, MAX(total) total, COUNT(*) quarters"
                " FROM filers WHERE canonical = 1 AND name LIKE ? COLLATE NOCASE"
                " GROUP BY cik ORDER BY total DESC LIMIT ?", (f"%{q}%", limit)).fetchall()
        else:
            rows = conn.execute(
                "SELECT cik, name, MAX(period) period, MAX(total) total, COUNT(*) quarters"
                " FROM filers WHERE canonical = 1 GROUP BY cik ORDER BY total DESC LIMIT ?", (limit,)).fetchall()
        return [{"cik": f"{int(r['cik']):010d}", "name": r["name"], "latest": r["period"],
                 "quarters": r["quarters"], "value": r["total"]} for r in rows]
    finally:
        conn.close()


def db_book(cik: str, period: str | None = None) -> dict | None:
    """A manager's book for a quarter, against the quarter before, from the DB."""
    conn = _db()
    if not conn:
        return None
    try:
        c = str(int(cik))
        rows = conn.execute(
            "SELECT * FROM filers WHERE cik = ? AND canonical = 1 ORDER BY period DESC", (c,)).fetchall()
        if not rows:
            return None
        cur = next((r for r in rows if r["period"] == period), rows[0])
        prev = next((r for r in rows if r["period"] < cur["period"]), None)

        def positions(fid):
            return {r["cusip"]: r for r in conn.execute(
                "SELECT p.*, s.issuer, s.class, s.ticker FROM positions p"
                " JOIN securities s ON s.cusip = p.cusip WHERE p.filer_id = ?", (fid,)).fetchall()}

        now, was = positions(cur["id"]), positions(prev["id"]) if prev else {}
        total = cur["total"] or sum(r["value"] for r in now.values()) or 1.0
        out = []
        for cusip, r in sorted(now.items(), key=lambda kv: -kv[1]["value"]):
            b = was.get(cusip)
            chg = r["shares"] - b["shares"] if b else None
            out.append({
                "cusip": cusip, "ticker": r["ticker"], "issuer": r["issuer"], "class": r["class"],
                "value": r["value"], "weight": r["value"] / total * 100, "shares": r["shares"],
                "calls": r["calls"] or None, "puts": r["puts"] or None,
                "sharesChange": chg, "pctChange": _pct_change(r["shares"], b["shares"] if b else None),
                "pctOutstanding": None,
                "status": "new" if not b else ("added" if (chg or 0) > 0 else
                                               "trimmed" if (chg or 0) < 0 else "held"),
            })
        exited = [{"cusip": k, "ticker": v["ticker"], "issuer": v["issuer"], "class": v["class"],
                   "value": v["value"], "shares": v["shares"], "status": "exited"}
                  for k, v in sorted(was.items(), key=lambda kv: -kv[1]["value"])
                  if k not in now][:50]
        quarters = [{"accession": r["accession"], "period": r["period"],
                     "filed": r["filed"], "amended": bool(r["amended"])} for r in rows[:20]]
        return {
            "available": True, "source": "bulk", "cik": f"{int(c):010d}", "manager": cur["name"],
            "period": cur["period"], "filed": cur["filed"], "amended": bool(cur["amended"]),
            "comparedTo": prev["period"] if prev else None,
            "positions": cur["positions"], "filingRows": None, "totalValue": total,
            "truncated": bool(cur["truncated"]), "quarters": quarters,
            "rows": out, "exited": exited,
            "unmapped": sum(1 for r in out if not r["ticker"]),
        }
    finally:
        conn.close()


def db_holders(ticker: str, limit: int = 25) -> dict | None:
    """Every filer in the dataset reporting a ticker, biggest position first.

    This is the view the crawl could never give: a real index from security back
    to holder, over every manager rather than a list of twenty.
    """
    conn = _db()
    if not conn:
        return None
    sym = (ticker or "").strip().upper()
    try:
        cusips = [r["cusip"] for r in conn.execute(
            "SELECT cusip FROM securities WHERE ticker = ?", (sym,)).fetchall()]
        if not cusips:
            return {"available": True, "ticker": sym, "holders": [], "source": "bulk",
                    "asOf": None, "scanned": None, "unmapped": True}
        marks = ",".join("?" * len(cusips))
        latest = conn.execute("SELECT MAX(period) p FROM filers WHERE canonical = 1").fetchone()["p"]
        rows = conn.execute(
            f"SELECT f.cik, f.name, f.period, f.total, p.cusip, p.value, p.shares, s.issuer"
            f" FROM positions p JOIN filers f ON f.id = p.filer_id"
            f" JOIN securities s ON s.cusip = p.cusip"
            f" WHERE p.cusip IN ({marks}) AND f.period = ? AND f.canonical = 1"
            f" ORDER BY p.value DESC LIMIT ?",
            (*cusips, latest, limit)).fetchall()

        prior = conn.execute("SELECT MAX(period) p FROM filers WHERE period < ?", (latest,)).fetchone()["p"]
        before = {}
        if prior:
            for r in conn.execute(
                f"SELECT f.cik, p.shares FROM positions p JOIN filers f ON f.id = p.filer_id"
                f" WHERE p.cusip IN ({marks}) AND f.period = ? AND f.canonical = 1", (*cusips, prior)).fetchall():
                before[r["cik"]] = before.get(r["cik"], 0) + r["shares"]

        out = []
        for r in rows:
            was = before.get(r["cik"])
            chg = r["shares"] - was if was is not None else None
            out.append({
                "manager": r["name"], "cik": f"{int(r['cik']):010d}", "period": r["period"],
                "issuer": r["issuer"], "ticker": sym, "cusip": r["cusip"],
                "value": r["value"], "shares": r["shares"],
                "weight": (r["value"] / r["total"] * 100) if r["total"] else None,
                "sharesChange": chg, "pctChange": _pct_change(r["shares"], was),
                "pctOutstanding": None,
                "status": "new" if was is None else ("added" if (chg or 0) > 0 else
                                                     "trimmed" if (chg or 0) < 0 else "held"),
            })
        holderCount = conn.execute(
            f"SELECT COUNT(*) n FROM positions p JOIN filers f ON f.id = p.filer_id"
            f" WHERE p.cusip IN ({marks}) AND f.period = ? AND f.canonical = 1", (*cusips, latest)).fetchone()["n"]
        return {"available": True, "source": "bulk", "ticker": sym, "asOf": latest,
                "comparedTo": prior, "holders": out, "holderCount": holderCount,
                "filersTotal": conn.execute(
                    "SELECT COUNT(DISTINCT cik) n FROM filers WHERE period = ? AND canonical = 1", (latest,)).fetchone()["n"]}
    finally:
        conn.close()


def holders(ticker: str, limit: int = 20) -> dict:
    """Which tracked managers reported a ticker, and how their stake moved.

    Reads only books this machine has already built. A cold scan of the tracked
    list took over two minutes, because resolving a thousand CUSIPs for a fund
    like Bridgewater costs minutes against a rate-limited mapping API. Blocking a
    page load on that is not a trade worth making, so the warmer below fills the
    caches in the background and this returns what is ready, with the count of
    managers actually read so the answer is never passed off as complete.

    Bounded in a second way too: the filings carry no index from a security back
    to its holders, so "who owns this" can only mean "which of these managers
    reported it".
    """
    sym = (ticker or "").strip().upper()
    if not sym:
        return {"available": False, "reason": "No ticker."}

    full = db_holders(sym, limit)
    if full is not None:
        return full
    return {"available": False, "ticker": sym,
            "reason": "The 13F dataset is not built on this machine. "
                      "Run scripts/build_13f_db.py to load it."}
