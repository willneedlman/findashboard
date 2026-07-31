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


def _revenue_facts(html: str) -> list[tuple[str, dict, float]]:
    """(period_end, context members, value) for every positive duration revenue
    fact, in document order. Order matters: each disaggregation table emits its
    rows consecutively, which is what lets us tell one cut from another."""
    ctx: dict[str, dict] = {}
    for cid, body in _CTX_RE.findall(html):
        members = {dim.split(":")[-1].lower(): mem.split(":")[-1] for dim, mem in _MEMBER_RE.findall(body)}
        end = _END_RE.search(body)
        start = _START_RE.search(body)
        ctx[cid] = {"members": members, "end": end.group(1) if end else None, "duration": bool(start)}

    facts: list[tuple[str, dict, float]] = []
    for attrstr, inner in _TAG_RE.findall(html):
        attrs = dict(_ATTR_RE.findall(attrstr))
        if attrs.get("name", "").split(":")[-1].lower() not in _REVENUE_CONCEPTS:
            continue
        c = ctx.get(attrs.get("contextRef", ""))
        if not c or not c["duration"] or not c["end"]:
            continue
        val = _parse_number(inner, attrs)
        if val is None or val <= 0:
            continue
        facts.append((c["end"], c["members"], val))
    return facts


def _split_runs(facts: list[tuple[dict, float]], member_fn) -> list[tuple[str, list]]:
    """Group same-period facts into contiguous disclosure runs.

    A filer can disclose several different cuts of the same revenue on the *same*
    axis — Microsoft tags both product-vs-service ($64.7B / $267.1B) and its ten
    named product lines against ProductOrServiceAxis. Merging them into one bag
    double-counts total revenue and makes every member look like a rollup of the
    others. Each table's rows are consecutive and closed off by a total row, so a
    break in classification is a break between cuts.
    """
    runs: list[tuple[str, list]] = []
    cur: list[tuple[str, float]] = []
    grp: str | None = None
    for members, val in facts:
        cls = member_fn(members)
        if cls is None or (cur and cls[0] != grp):
            if cur:
                runs.append((grp, cur))
            cur, grp = [], None
            if cls is None:
                continue
        grp = cls[0]
        if not any(m == cls[1] for m, _ in cur):
            cur.append((cls[1], val))
    if cur:
        runs.append((grp, cur))
    return runs


def _drop_rollups(items: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """Drop parent/subtotal rows from one document-ordered run.

    A parent is printed immediately before its children (Nvidia: Data Center =
    Compute + Networking) or a subtotal immediately after them (JPMorgan: Total
    International = EMEA + Asia Pacific + Latin America), so only contiguous
    neighbours are candidates. Searching arbitrary subsets instead matches by
    coincidence once a table has more than a handful of rows.
    """
    vals = [v for _, v in items]
    n = len(vals)
    drop: set[int] = set()
    for i, v in enumerate(vals):
        tol = max(1.0, 0.005 * v)
        for direction in (1, -1):
            s = 0.0
            for step in range(1, n):
                j = i + direction * step
                if not 0 <= j < n:
                    break
                s += vals[j]
                if step >= 2 and abs(s - v) <= tol:
                    drop.add(i)
                    break
                if s > v + tol:
                    break
            if i in drop:
                break
    return [it for k, it in enumerate(items) if k not in drop]


def _segments_from_instance(html: str, member_fn=_segment_member,
                            priority: tuple = ("product", "segment")) -> dict:
    facts = _revenue_facts(html)
    if not facts:
        return {}
    latest_end = max(e for e, _, _ in facts)
    period = [(m, v) for e, m, v in facts if e == latest_end]
    # Undimensioned revenue for the period — the anchor every real cut must sum to.
    total = next((v for m, v in period if not m), None)

    def reconciles(s: float) -> bool:
        return total is not None and abs(s - total) <= 0.01 * total

    runs = _split_runs(period, member_fn)
    for grp in priority:
        cands = [_drop_rollups(items) for g, items in runs if g == grp]
        cands = [c for c in cands if len(c) >= 2]
        if not cands:
            continue
        # A cut that ties out to reported revenue wins; among those, the most
        # granular one.
        best = max(cands, key=lambda c: (reconciles(sum(v for _, v in c)), len(c)))
        return {"end": latest_end, "segments": best,
                "total": total if reconciles(sum(v for _, v in best)) else None}
    return {}


_COUNTRY = {
    "US": "United States", "USA": "United States", "U": "United States",
    "CN": "China", "TW": "Taiwan", "SG": "Singapore", "JP": "Japan", "KR": "South Korea",
    "DE": "Germany", "GB": "United Kingdom", "UK": "United Kingdom", "FR": "France",
    "CA": "Canada", "IN": "India", "HK": "Hong Kong", "MX": "Mexico", "IE": "Ireland",
    "NL": "Netherlands", "MY": "Malaysia", "TH": "Thailand", "VN": "Vietnam", "ID": "Indonesia",
    "BR": "Brazil", "IL": "Israel", "CH": "Switzerland", "AU": "Australia", "PH": "Philippines",
    "NONUS": "Non-US", "NONU": "Non-US",
}


_DIGIT_WORD = {"Zero": "0", "One": "1", "Two": "2", "Three": "3", "Four": "4",
               "Five": "5", "Six": "6", "Seven": "7", "Eight": "8", "Nine": "9"}

# Brand names that camel-case splitting pulls apart or leaves shouting.
_BRAND = {"Linked In": "LinkedIn", "XBOX": "Xbox", "You Tube": "YouTube",
          "I Phone": "iPhone", "I Pad": "iPad", "I Cloud": "iCloud"}


def _spell_numbers(words: list[str]) -> list[str]:
    """MicrosoftThreeSixFive -> Microsoft 365. XBRL member names cannot start a
    token with a digit, so filers spell numeric brands out digit by digit."""
    out: list[str] = []
    i = 0
    while i < len(words):
        j = i
        while j < len(words) and words[j] in _DIGIT_WORD:
            j += 1
        if j - i >= 2:
            out.append("".join(_DIGIT_WORD[w] for w in words[i:j]))
        else:
            out.extend(words[i:j] or [words[i]])
        i = max(j, i + 1)
    return out


def _humanize(member: str) -> str:
    s = re.sub(r"Member$", "", member)
    # Geographic facts use ISO country codes (US, CN, TW…) — map to readable names.
    code = re.sub(r"[^A-Za-z]", "", s).upper()
    if code in _COUNTRY:
        return _COUNTRY[code]
    s = re.sub(r"([a-z])and([A-Z])", r"\1 and \2", s)   # WearablesHomeandAccessories -> ...Home and Acc...
    s = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", s)
    s = re.sub(r"(?<=[A-Z])(?=[A-Z][a-z])", " ", s)
    s = " ".join(_spell_numbers(s.split()))
    for pat, brand in _BRAND.items():
        s = re.sub(rf"\b{pat}\b", brand, s)
    s = s.replace(" And ", " and ").strip()
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
    segs = parsed.get("segments") or []
    if not segs:
        return {"latest": []}

    # Percentages are of reported revenue, not of the members we happened to keep,
    # so a partial breakdown reads as partial instead of as the whole pie.
    total = parsed.get("total") or sum(v for _, v in segs) or 1.0
    latest = [{"name": _humanize(m), "value": v, "pct": round(v / total * 100, 1)}
              for m, v in sorted(segs, key=lambda x: -x[1])]
    result = {"fiscalYear": (parsed.get("end") or "")[:4], "currency": "USD", "latest": latest, "source": "sec"}
    try:
        disk_set(cache_key, result, ttl=30 * 86400)
    except Exception:
        pass
    return result


def get_segment_revenue(ticker: str) -> dict:
    """Latest-year product-segment revenue from the most recent 10-K (fmp shape)."""
    sym = ticker.strip().upper()
    return _extract_from_10k(sym, _segment_member, f"sec_seg:v3:{sym}", ("product", "segment"))


def get_geo_revenue(ticker: str) -> dict:
    """Latest-year geographic revenue from the most recent 10-K (fmp shape)."""
    sym = ticker.strip().upper()
    return _extract_from_10k(sym, _geo_member, f"sec_geo:v3:{sym}", ("geo",))
