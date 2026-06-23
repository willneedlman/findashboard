"""Free corporate-bond price-by-CUSIP lookups. No real time, but legal + free.

Two complementary sources, both end-of-period marks (not live quotes):

  A. SPDR bond-ETF daily holdings (State Street / SSGA). An ungated daily .xlsx
     listing each holding's ISIN (-> CUSIP), par + market value (-> price per
     100), coupon and maturity. Fresh (T-1). Six funds span the IG and HY curve
     (~10k CUSIPs), fetched concurrently and cached per fund.
  B. SEC N-PORT fund filings via EDGAR full-text search. Any bond a registered
     fund holds, priced at the fund's last report date. Broad but month-lagged.

ETF price wins when present (fresher); N-PORT is the fallback. Callers must label
the price with its source + as-of date — it is not a live quote.
"""
from __future__ import annotations
import io
import re
import logging
import requests

logger = logging.getLogger(__name__)
_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_BROWSER_UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"}

try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass


def _num(v):
    try:
        return round(float(v), 4)
    except (TypeError, ValueError):
        return None


def _date(v):
    """Normalize SSGA maturity (e.g. '07/21/2028' or a datetime) to YYYY-MM-DD."""
    if v is None:
        return None
    s = str(v)
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", s)
    if m:
        return f"{m.group(3)}-{m.group(1)}-{m.group(2)}"
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    return m.group(0) if m else None


# ── Option A: SPDR bond-ETF daily holdings (SSGA) ─────────────────────────────
# Maximize free coverage across the SSGA bond lineup, ~15k unique CUSIPs. Broad
# aggregate/total-return funds come first so the cleaner corp/HY-specific marks
# win on overlap (last write wins in the merge):
#   aggregate + total return: SPAB, TOTL, STOT
#   investment-grade corp curve: SPBO, SPIB, SPSB, SPLB
#   high yield: JNK, SPHY, SJNK, HYBL
_SSGA_FUNDS = ("SPAB", "TOTL", "STOT",
               "SPBO", "SPIB", "SPSB", "SPLB",
               "JNK", "SPHY", "SJNK", "HYBL")


def _ssga_holdings(fund: str) -> dict:
    import openpyxl
    url = ("https://www.ssga.com/us/en/intermediary/library-content/products/"
           f"fund-data/etfs/us/holdings-daily-us-en-{fund.lower()}.xlsx")
    r = requests.get(url, headers=_BROWSER_UA, timeout=25)
    r.raise_for_status()
    wb = openpyxl.load_workbook(io.BytesIO(r.content), read_only=True, data_only=True)
    rows = list(wb.active.iter_rows(values_only=True))

    as_of = None
    hi = None
    for i, row in enumerate(rows):
        cells = [str(c) for c in row if c is not None]
        for c in cells:
            if "As of" in c:
                as_of = c.replace("As of", "").strip()
        if "Name" in [str(c) for c in row]:
            hi = i
            break
    if hi is None:
        return {}
    hdr = {str(c).strip(): i for i, c in enumerate(rows[hi]) if c}
    if not all(k in hdr for k in ("Identifier", "Par Value", "Market Value")):
        return {}

    out = {}
    for row in rows[hi + 1:]:
        ident = row[hdr["Identifier"]]
        if not ident or not str(ident).startswith("US"):
            continue
        cusip = str(ident)[2:11]
        if not re.fullmatch(r"[0-9A-Z]{9}", cusip):
            continue
        try:
            par = float(row[hdr["Par Value"]])
            mv = float(row[hdr["Market Value"]])
        except (TypeError, ValueError):
            continue
        if par <= 0:
            continue
        out[cusip] = {
            "market_price": round(mv / par * 100, 3),
            "coupon_rate": _num(row[hdr["Coupon"]]) if "Coupon" in hdr else None,
            "maturity_date": _date(row[hdr["Maturity"]]) if "Maturity" in hdr else None,
            "price_source": f"SPDR {fund} (ETF holding)",
            "price_as_of": as_of,
        }
    return out


def _ssga_holdings_cached(fund: str) -> dict:
    """One fund's holdings, cached 24h on its own key so a single slow or failed
    download never discards the others' coverage."""
    ck = f"ssga:{fund}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    try:
        h = _ssga_holdings(fund)
    except Exception as e:
        logger.warning("ssga %s holdings failed: %s", fund, e)
        h = {}
    if h:
        disk_set(ck, h, ttl=86400)
    return h


def _etf_price_map() -> dict:
    cached = disk_get("etf_px_map:v3")
    if cached is not None:
        return cached
    # Fetch funds concurrently: total build time is the slowest single download,
    # not the sum, so the combined map stays well inside the request timeout.
    from concurrent.futures import ThreadPoolExecutor
    m: dict = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for h in pool.map(_ssga_holdings_cached, _SSGA_FUNDS):
            m.update(h)
    disk_set("etf_px_map:v3", m, ttl=43200)           # 12 h
    return m


# ── Option B: SEC N-PORT fund filings (EDGAR) ─────────────────────────────────
def _parse_nport(xml: str, cusip: str):
    md = re.search(r"<repPdDate>([\d-]+)</repPdDate>", xml)
    as_of = md.group(1) if md else None
    for block in xml.split("</invstOrSec>"):
        if not re.search(r"<cusip>\s*" + re.escape(cusip) + r"\s*</cusip>", block):
            continue
        bal = re.search(r"<balance>([\d.]+)</balance>", block)
        val = re.search(r"<valUSD>([\d.]+)</valUSD>", block)
        if bal and val and float(bal.group(1)) > 0:
            return {
                "market_price": round(float(val.group(1)) / float(bal.group(1)) * 100, 3),
                "price_source": "SEC N-PORT (fund mark)",
                "price_as_of": as_of,
            }
    return None


def _nport_price(cusip: str):
    try:
        r = requests.get("https://efts.sec.gov/LATEST/search-index",
                         params={"q": f'"{cusip}"', "forms": "NPORT-P"},
                         headers=_UA, timeout=15)
        hits = r.json().get("hits", {}).get("hits", [])
        for h in hits[:4]:
            _id = h.get("_id", "")
            if ":" not in _id:
                continue
            acc, doc = _id.split(":", 1)
            cik = (h.get("_source", {}).get("ciks") or [None])[0]
            if not cik:
                continue
            url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{acc.replace('-', '')}/{doc}"
            px = _parse_nport(requests.get(url, headers=_UA, timeout=20).text, cusip)
            if px:
                return px
    except Exception as e:
        logger.warning("nport price %s failed: %s", cusip, e)
    return None


def price_for_cusip(cusip: str):
    """Daily ETF mark first (fresher), else N-PORT monthly mark. Cached 12h,
    including misses, so a CUSIP with no free price isn't re-fetched repeatedly."""
    cu = cusip.strip().upper()
    ck = f"bondpx:v3:{cu}"
    cached = disk_get(ck)
    if cached is not None:
        return cached or None
    px = _etf_price_map().get(cu) or _nport_price(cu)
    disk_set(ck, px or {}, ttl=43200)
    return px
