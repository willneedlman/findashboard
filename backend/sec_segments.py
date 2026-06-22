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


def _segment_member(members: dict) -> tuple[str, str] | None:
    """(group, member) for a revenue fact, or None for a cross/total. A company
    can disclose several different cuts of the same revenue (Apple: product detail,
    Product/Service, AND geographic operating segments); each cut is tagged to its
    own group so they're never merged — the caller picks one coherent breakdown.

      • single ProductOrService axis (iPhone, Mac…)         -> 'product'
      • business-segments axis, alone or as OperatingSegments -> 'segment'
    """
    if len(members) == 1:
        ax = next(iter(members))
        if ax in ("productorserviceaxis", "productsandservicesaxis"):
            return ("product", members[ax])
        if ax == "statementbusinesssegmentsaxis":
            return ("segment", members[ax])
        return None
    if (len(members) == 2 and "statementbusinesssegmentsaxis" in members
            and members.get("consolidationitemsaxis", "").lower() == "operatingsegmentsmember"):
        return ("segment", members["statementbusinesssegmentsaxis"])
    return None


def _geo_member(members: dict) -> tuple[str, str] | None:
    """Geographic member for a revenue fact dimensioned solely by geography."""
    if len(members) == 1 and "statementgeographicalaxis" in members:
        return ("geo", members["statementgeographicalaxis"])
    return None


def _segments_from_instance(html: str, member_fn=_segment_member,
                            priority: tuple = ("product", "segment")) -> dict:
    # 1) contexts -> {id: {members: {axis_lower: member}, end: date, duration: bool}}
    ctx: dict[str, dict] = {}
    for cid, body in _CTX_RE.findall(html):
        members = {dim.split(":")[-1].lower(): mem.split(":")[-1] for dim, mem in _MEMBER_RE.findall(body)}
        end = _END_RE.search(body)
        start = _START_RE.search(body)
        ctx[cid] = {"members": members, "end": end.group(1) if end else None, "duration": bool(start)}

    # 2) revenue facts, kept separate per disclosure group so different cuts of the
    #    same revenue (product detail vs geographic segments) are never summed.
    groups: dict[str, dict[str, dict[str, float]]] = {}   # group -> end -> {member: val}
    for attrstr, inner in _TAG_RE.findall(html):
        attrs = dict(_ATTR_RE.findall(attrstr))
        name = attrs.get("name", "").split(":")[-1].lower()
        if name not in _REVENUE_CONCEPTS:
            continue
        c = ctx.get(attrs.get("contextRef", ""))
        if not c or not c["duration"] or not c["end"]:
            continue
        cls = member_fn(c["members"])
        if cls is None:
            continue
        grp, member = cls
        val = _parse_number(inner, attrs)
        if val is None or val <= 0:
            continue
        groups.setdefault(grp, {}).setdefault(c["end"], {}).setdefault(member, val)

    # Return the first priority group that yields a real breakdown (≥2 members
    # after rollups), at its latest period.
    for grp in priority:
        d = groups.get(grp)
        if not d:
            continue
        latest_end = max(d.keys())
        segs = _drop_rollups(d[latest_end])
        if len(segs) >= 2:
            return {"end": latest_end, "segments": segs}
    return {}


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


_COUNTRY = {
    "US": "United States", "USA": "United States", "U": "United States",
    "CN": "China", "TW": "Taiwan", "SG": "Singapore", "JP": "Japan", "KR": "South Korea",
    "DE": "Germany", "GB": "United Kingdom", "UK": "United Kingdom", "FR": "France",
    "CA": "Canada", "IN": "India", "HK": "Hong Kong", "MX": "Mexico", "IE": "Ireland",
    "NL": "Netherlands", "MY": "Malaysia", "TH": "Thailand", "VN": "Vietnam", "ID": "Indonesia",
    "BR": "Brazil", "IL": "Israel", "CH": "Switzerland", "AU": "Australia", "PH": "Philippines",
    "NONUS": "Non-US", "NONU": "Non-US",
}


def _humanize(member: str) -> str:
    s = re.sub(r"Member$", "", member)
    # Geographic facts use ISO country codes (US, CN, TW…) — map to readable names.
    code = re.sub(r"[^A-Za-z]", "", s).upper()
    if code in _COUNTRY:
        return _COUNTRY[code]
    s = re.sub(r"([a-z])and([A-Z])", r"\1 and \2", s)   # WearablesHomeandAccessories -> ...Home and Acc...
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s)
    s = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", s)
    s = s.replace(" And ", " and ").strip()
    # Common Apple-style leading-I products read better lowercased (iPhone, iPad, iMac).
    s = re.sub(r"^I (Phone|Pad|Mac|Pod|Tunes|Cloud)", r"i\1", s)
    return s


def _extract_from_10k(sym: str, member_fn, cache_key: str, priority: tuple) -> dict:
    """Shared 10-K revenue-breakdown extractor. `member_fn` selects which facts to
    keep (product segments or geography) and `priority` picks one disclosure group.
    Returns {fiscalYear, currency, latest: [{name, value, pct}], source} matching
    the fmp shape, or {'latest': []}."""
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

    parsed = _segments_from_instance(html, member_fn, priority)
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


def get_segment_revenue(ticker: str) -> dict:
    """Latest-year product-segment revenue from the most recent 10-K (fmp shape)."""
    sym = ticker.strip().upper()
    return _extract_from_10k(sym, _segment_member, f"sec_seg:v2:{sym}", ("product", "segment"))


def get_geo_revenue(ticker: str) -> dict:
    """Latest-year geographic revenue from the most recent 10-K (fmp shape)."""
    sym = ticker.strip().upper()
    return _extract_from_10k(sym, _geo_member, f"sec_geo:v2:{sym}", ("geo",))
