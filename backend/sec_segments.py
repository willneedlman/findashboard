"""Free product-segment revenue from SEC EDGAR inline XBRL.

Fallback for the SOTP tab when FMP's segmentation endpoint is unavailable
(rate-limited / plan-gated). EDGAR has no API key and no quota, so this is the
reliable source. We pull the latest 10-K's inline-XBRL revenue facts that are
dimensioned by the product/service axis, for the most recent annual period.
"""
from __future__ import annotations
import re
import logging
import requests

logger = logging.getLogger(__name__)

# SEC requires a descriptive User-Agent with contact info.
_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_TIMEOUT = 15

try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None                     # type: ignore
    def disk_set(_k, _v, ttl=0): pass                 # type: ignore

# Revenue concepts a segment table tags against.
_REVENUE_CONCEPTS = (
    "revenuefromcontractwithcustomerexcludingassessedtax",
    "revenuefromcontractwithcustomerincludingassessedtax",
    "revenues",
)
# Axes that carry a product/segment breakdown (not geography).
_PRODUCT_AXES = ("productorserviceaxis", "productsandservicesaxis", "statementbusinesssegmentsaxis")

_TAG_RE  = re.compile(r"<ix:nonfraction\b([^>]*)>([^<]*)</ix:nonfraction>", re.I | re.S)
_ATTR_RE = re.compile(r'([\w:-]+)\s*=\s*"([^"]*)"')
_CTX_RE  = re.compile(r"<(?:xbrli:)?context\b[^>]*\bid=\"([^\"]+)\"[^>]*>(.*?)</(?:xbrli:)?context>", re.I | re.S)
_MEMBER_RE = re.compile(r'dimension="([^"]+)"\s*>\s*([^<\s]+)', re.I)
_END_RE   = re.compile(r"<(?:xbrli:)?enddate>\s*([0-9-]+)", re.I)
_START_RE = re.compile(r"<(?:xbrli:)?startdate>\s*([0-9-]+)", re.I)


def _cik_for(ticker: str) -> str | None:
    try:
        data = requests.get("https://www.sec.gov/files/company_tickers.json", headers=_UA, timeout=_TIMEOUT).json()
        t = ticker.strip().upper()
        for row in data.values():
            if str(row.get("ticker", "")).upper() == t:
                return str(row["cik_str"]).zfill(10)
    except Exception as e:
        logger.warning("SEC cik lookup failed for %s: %s", ticker, e)
    return None


def _latest_10k(cik: str) -> tuple[str, str] | None:
    """Return (accession_no_dashes, primary_document) for the most recent 10-K."""
    try:
        j = requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json", headers=_UA, timeout=_TIMEOUT).json()
        r = j["filings"]["recent"]
        for form, accn, doc in zip(r["form"], r["accessionNumber"], r["primaryDocument"]):
            if form == "10-K" and doc:
                return accn.replace("-", ""), doc
    except Exception as e:
        logger.warning("SEC submissions failed for %s: %s", cik, e)
    return None


def _parse_number(text: str, attrs: dict) -> float | None:
    raw = text.strip().replace(",", "")
    if not raw or raw in ("-", "—"):
        return None
    try:
        val = float(raw)
    except ValueError:
        return None
    scale = int(attrs.get("scale", "0") or 0)
    val *= 10 ** scale
    if attrs.get("sign") == "-":
        val = -val
    return val


def _segments_from_instance(html: str) -> dict:
    # 1) contexts -> {id: {members: {axis_lower: member}, end: date, duration: bool}}
    ctx: dict[str, dict] = {}
    for cid, body in _CTX_RE.findall(html):
        members = {dim.split(":")[-1].lower(): mem.split(":")[-1] for dim, mem in _MEMBER_RE.findall(body)}
        end = _END_RE.search(body)
        start = _START_RE.search(body)
        ctx[cid] = {"members": members, "end": end.group(1) if end else None, "duration": bool(start)}

    # 2) revenue facts dimensioned ONLY by a product/segment axis, latest annual period
    by_end: dict[str, dict[str, float]] = {}
    for attrstr, inner in _TAG_RE.findall(html):
        attrs = dict(_ATTR_RE.findall(attrstr))
        name = attrs.get("name", "").split(":")[-1].lower()
        if name not in _REVENUE_CONCEPTS:
            continue
        c = ctx.get(attrs.get("contextRef", ""))
        if not c or not c["duration"] or not c["end"]:
            continue
        prod = [(ax, m) for ax, m in c["members"].items() if ax in _PRODUCT_AXES]
        # Require exactly one dimension and it is the product axis (skip geography crosses, totals)
        if len(c["members"]) != 1 or not prod:
            continue
        val = _parse_number(inner, attrs)
        if val is None or val <= 0:
            continue
        member = prod[0][1]
        by_end.setdefault(c["end"], {})[member] = val

    if not by_end:
        return {}
    latest_end = max(by_end.keys())
    return {"end": latest_end, "segments": _drop_rollups(by_end[latest_end])}


def _is_rollup(target: float, others: list[float], tol: float) -> bool:
    """True if some subset of >=2 of `others` sums to ~target (a parent member
    that double-counts its children, e.g. Apple's 'Products' = iPhone+Mac+...)."""
    n = len(others)
    for mask in range(1, 1 << n):
        if bin(mask).count("1") < 2:
            continue
        s = sum(others[i] for i in range(n) if mask & (1 << i))
        if abs(s - target) <= tol:
            return True
    return False


def _drop_rollups(segs: dict) -> dict:
    items = list(segs.items())
    vals = [v for _, v in items]
    keep: dict[str, float] = {}
    for i, (name, v) in enumerate(items):
        others = [vals[j] for j in range(len(vals)) if j != i]
        if _is_rollup(v, others, tol=max(1.0, 0.01 * v)):
            continue   # parent/roll-up — its children are already counted
        keep[name] = v
    return keep


def _humanize(member: str) -> str:
    s = re.sub(r"Member$", "", member)
    s = re.sub(r"([a-z])and([A-Z])", r"\1 and \2", s)   # WearablesHomeandAccessories -> ...Home and Acc...
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s)
    s = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", s)
    s = s.replace(" And ", " and ").strip()
    # Common Apple-style leading-I products read better lowercased (iPhone, iPad, iMac).
    s = re.sub(r"^I (Phone|Pad|Mac|Pod|Tunes|Cloud)", r"i\1", s)
    return s


def get_segment_revenue(ticker: str) -> dict:
    """Latest-year product-segment revenue from the most recent 10-K.

    Returns {fiscalYear, currency, latest: [{name, value, pct}]} matching the
    fmp.get_revenue_segments shape, or an empty 'latest' on failure."""
    sym = ticker.strip().upper()
    cache_key = f"sec_seg:{sym}"
    cached = disk_get(cache_key)
    if isinstance(cached, dict) and cached.get("latest"):
        return cached

    cik = _cik_for(sym)
    if not cik:
        return {"latest": []}
    flk = _latest_10k(cik)
    if not flk:
        return {"latest": []}
    accn, doc = flk
    url = f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accn}/{doc}"
    try:
        html = requests.get(url, headers=_UA, timeout=30).text
    except Exception as e:
        logger.warning("SEC 10-K fetch failed %s: %s", url, e)
        return {"latest": []}

    parsed = _segments_from_instance(html)
    segs = parsed.get("segments") or {}
    if not segs:
        return {"latest": []}

    total = sum(segs.values()) or 1.0
    latest = [{"name": _humanize(m), "value": v, "pct": round(v / total * 100, 1)}
              for m, v in sorted(segs.items(), key=lambda x: -x[1])]
    result = {"fiscalYear": (parsed.get("end") or "")[:4], "currency": "USD", "latest": latest, "source": "sec"}
    try:
        disk_set(cache_key, result, ttl=30 * 86400)
    except Exception:
        pass
    return result
