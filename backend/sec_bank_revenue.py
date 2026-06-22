"""Bank revenue-by-activity from SEC XBRL (free, no key).

Splits a bank / broker-dealer's net revenue into Net Interest Income and the
noninterest fee/trading lines using only universally-tagged us-gaap concepts,
so it generalizes to any bank with no per-issuer mapping.

Trading is broken out when the issuer tags it (e.g. JPMorgan's principal
transactions); otherwise it folds into Other Noninterest — e.g. Goldman tags
market-making revenue only via dimensioned facts we deliberately do not pull
here, to keep this source-of-truth simple and generic. Returns a SegBlock-shaped
dict matching fmp.EMPTY_SEGMENTS so the existing SegmentBreakdown UI renders it.
"""
from __future__ import annotations
import logging
import requests

logger = logging.getLogger(__name__)
_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_TIMEOUT = 15

try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None                     # type: ignore
    def disk_set(_k, _v, ttl=0): pass                 # type: ignore

# SIC codes for depository banks, security broker-dealers, and their holding cos.
_BANK_SICS = {"6020", "6021", "6022", "6029", "6035", "6036", "6199", "6200", "6211", "6311"}

_EMPTY = {"fiscalYear": None, "currency": "USD", "latest": [], "history": [], "concentration": None}


def _cik_for(ticker: str) -> str | None:
    try:
        data = requests.get("https://www.sec.gov/files/company_tickers.json", headers=_UA, timeout=_TIMEOUT).json()
        t = ticker.strip().upper()
        for row in data.values():
            if str(row.get("ticker", "")).upper() == t:
                return str(row["cik_str"]).zfill(10)
    except Exception as e:
        logger.warning("bank-rev cik lookup failed for %s: %s", ticker, e)
    return None


def _is_bank(cik: str) -> bool:
    try:
        sic = str(requests.get(f"https://data.sec.gov/submissions/CIK{cik}.json",
                               headers=_UA, timeout=_TIMEOUT).json().get("sic", ""))
        return sic in _BANK_SICS
    except Exception:
        return False


def _annual_by_year(cik: str, concept: str) -> dict[int, float]:
    """{fiscal_year: value} for a us-gaap concept, taking the latest-filed per year."""
    try:
        r = requests.get(f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik}/us-gaap/{concept}.json",
                         headers=_UA, timeout=_TIMEOUT)
        if r.status_code != 200:
            return {}
        out: dict[int, float] = {}
        filed: dict[int, str] = {}
        for x in r.json().get("units", {}).get("USD", []):
            if x.get("form") != "10-K" or x.get("fp") != "FY" or x.get("fy") is None:
                continue
            fy = int(x["fy"])
            f = x.get("filed", "")
            if fy not in out or f >= filed[fy]:        # newest filing wins (restatements)
                out[fy], filed[fy] = float(x["val"]), f
        return out
    except Exception:
        return {}


def get_bank_revenue_activity(ticker: str, years: int = 6) -> dict:
    """SegBlock-shaped revenue-by-activity for banks; empty block otherwise."""
    cik = _cik_for(ticker)
    if not cik or not _is_bank(cik):
        return dict(_EMPTY)

    key = f"bankrev:{cik}"
    cached = disk_get(key)
    if cached is not None:
        return cached

    nii_net = _annual_by_year(cik, "InterestIncomeExpenseNet")
    int_inc = _annual_by_year(cik, "InterestAndDividendIncomeOperating")
    int_exp = _annual_by_year(cik, "InterestExpense")
    ib      = _annual_by_year(cik, "InvestmentBankingRevenue")
    noni    = _annual_by_year(cik, "NoninterestIncome")
    comm    = _annual_by_year(cik, "BrokerageCommissionsRevenue")
    trade   = _annual_by_year(cik, "PrincipalTransactionsRevenue") or _annual_by_year(cik, "TradingGainsLosses")

    by_year: dict[int, dict[str, float]] = {}
    for fy, ni in noni.items():
        if not ni or ni <= 0:
            continue
        nii = nii_net.get(fy)
        if nii is None and fy in int_inc and fy in int_exp:
            nii = int_inc[fy] - int_exp[fy]
        ib_v, comm_v, trade_v = ib.get(fy, 0.0), comm.get(fy, 0.0), trade.get(fy, 0.0)
        segs: dict[str, float] = {}
        if nii and nii > 0:
            segs["Net Interest Income"] = nii
        if ib_v > 0:
            segs["Investment Banking"] = ib_v
        if trade_v > 0:
            segs["Trading"] = trade_v
        if comm_v > 0:
            segs["Commissions"] = comm_v
        other = ni - ib_v - comm_v - trade_v
        if other > 0:
            segs["Other Noninterest"] = other
        if len(segs) >= 2:
            by_year[fy] = segs

    if not by_year:
        return dict(_EMPTY)

    fys = sorted(by_year, reverse=True)[:years]
    latest_fy = fys[0]
    latest = by_year[latest_fy]
    prior = by_year.get(latest_fy - 1, {})
    total = sum(latest.values()) or 1.0

    latest_list = []
    for name, val in sorted(latest.items(), key=lambda x: -x[1]):
        prev = prior.get(name)
        latest_list.append({
            "name": name, "value": val, "pct": round(val / total * 100, 1),
            "yoy_pct": round((val - prev) / prev * 100, 1) if prev else None,
        })

    shares = [v / total for v in latest.values()]
    concentration = {"topShare": round(max(shares) * 100, 1),
                     "hhi": round(sum(s * s for s in shares) * 10000),
                     "count": len(latest)}

    history = [{"year": fy, "total": round(sum(by_year[fy].values())),
                "segments": [{"name": n, "value": v}
                             for n, v in sorted(by_year[fy].items(), key=lambda x: -x[1])]}
               for fy in sorted(fys)]

    result = {"fiscalYear": latest_fy, "currency": "USD", "latest": latest_list,
              "history": history, "concentration": concentration, "source": "sec"}
    disk_set(key, result, ttl=86400)
    return result
