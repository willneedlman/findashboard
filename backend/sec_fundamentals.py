"""Free income / balance / cash-flow statements from SEC EDGAR XBRL companyfacts.

The FMP free tier caps fundamentals at ~250 calls/day, so the DCF/valuation engine
sources its statement line items here first (SEC has no key and no quota) and only
spends an FMP call when SEC is missing, corrupt, or fails the sanity guard.

SEC intentionally supplies statements ONLY — price, market cap, and beta are not in
XBRL and stay on FMP/yfinance. Returned dicts use the exact FMP field names the DCF
engine (fmp.get_dcf_fundamentals) already reads, so it is a drop-in statement source.

Data source: https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
"""
from __future__ import annotations

import logging
from datetime import date

import requests

from sec_segments import _cik_for            # single source of truth for ticker→CIK

try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None                     # type: ignore
    def disk_set(_k, _v, ttl=0): pass                 # type: ignore

logger = logging.getLogger(__name__)

_UA = {"User-Agent": "Alphatape Research admin@alphatape.app"}
_TIMEOUT = 15
_CACHE_TTL = 30 * 86400                                # statements change quarterly
_MISS_TTL = 10 * 60

# us-gaap concepts mapped to the FMP field names the DCF engine consumes. Ordered
# synonyms: the first concept present in the filing wins (taxonomies vary by filer).
_INCOME = {
    "revenue": ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues",
                "RevenueFromContractWithCustomerIncludingAssessedTax", "SalesRevenueNet"],
    "grossProfit": ["GrossProfit"],
    "operatingIncome": ["OperatingIncomeLoss"],
    "netIncome": ["NetIncomeLoss"],
    "epsdiluted": ["EarningsPerShareDiluted"],
    "weightedAverageShsOutDil": ["WeightedAverageNumberOfDilutedSharesOutstanding",
                                 "WeightedAverageNumberOfSharesOutstandingBasic"],
    "incomeBeforeTax": [
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest",
        "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments"],
    "incomeTaxExpense": ["IncomeTaxExpenseBenefit"],
}
_BALANCE = {   # instants
    "cashAndCashEquivalents": ["CashAndCashEquivalentsAtCarryingValue",
                               "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
    "totalStockholdersEquity": ["StockholdersEquity",
                                "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
}
# totalDebt is composed (no single us-gaap tag): long-term + current portion.
_DEBT_LT = ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations"]
_DEBT_CUR = ["LongTermDebtCurrent", "DebtCurrent"]
_CASHFLOW = {   # durations
    "capitalExpenditure": ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"],
    "depreciationAndAmortization": ["DepreciationDepletionAndAmortization",
                                    "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization"],
    "changeInWorkingCapital": ["IncreaseDecreaseInOperatingCapital"],
}
# Filers that never tag a combined D&A line (Microsoft is one) report the pieces
# separately, so add them up rather than treating D&A as missing.
_DA_PARTS = (["Depreciation", "DepreciationNonproduction"],
             ["AmortizationOfIntangibleAssets", "AmortizationOfIntangibleAssetsExcludingGoodwill"])
# Shares are reported in "shares" units; everything else in USD.
_SHARE_FIELDS = {"weightedAverageShsOutDil"}


def _annual_map(us: dict, concepts: list[str], want_shares: bool, instant: bool,
                unit: str | None = None) -> dict[int, float]:
    """{fiscal_year: value} from annual (10-K, fp=FY) facts, merged across concept
    synonyms: the earliest-listed concept wins for any year it covers, and later
    synonyms only fill years it does not. Filers switch tags mid-history (Nvidia
    dropped RevenueFromContractWithCustomer... after FY2022 for Revenues), so
    taking the first synonym that has *any* data silently freezes the series
    years in the past. For durations only ~12-month periods are kept (drops
    quarterly/cumulative facts); the latest restatement per year wins."""
    merged: dict[int, float] = {}
    for concept in concepts:
        node = us.get(concept)
        if not node:
            continue
        facts = node.get("units", {}).get(unit or ("shares" if want_shares else "USD"))
        if not facts:
            continue
        picked: dict[int, tuple[str, float]] = {}
        for f in facts:
            if f.get("fp") != "FY" or not str(f.get("form", "")).startswith("10-K"):
                continue
            fy = f.get("fy")
            val = f.get("val")
            if fy is None or val is None:
                continue
            if not instant:
                s, e = f.get("start"), f.get("end")
                if not (s and e):
                    continue
                try:
                    span = (date.fromisoformat(e) - date.fromisoformat(s)).days
                except ValueError:
                    continue
                if span < 330 or span > 400:          # keep annual only
                    continue
            end = f.get("end", "")
            prev = picked.get(fy)
            if prev is None or end >= prev[0]:         # latest-filed restatement wins
                picked[fy] = (end, float(val))
        for fy, (_e, v) in picked.items():
            merged.setdefault(fy, v)
    return merged


_MATURITY_TAGS = [
    ("Year 1", "LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths"),
    ("Year 2", "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo"),
    ("Year 3", "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearThree"),
    ("Year 4", "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFour"),
    ("Year 5", "LongTermDebtMaturitiesRepaymentsOfPrincipalInYearFive"),
    ("Thereafter", "LongTermDebtMaturitiesRepaymentsOfPrincipalAfterYearFive"),
]


def debt_maturity_schedule(sym: str) -> dict | None:
    """Forward debt-maturity ladder — ASC 470 requires this 5-year-plus-
    thereafter breakdown in every 10-K that carries long-term debt, tagged as
    six top-level XBRL facts. Anchored on the single most recent balance-sheet
    date carrying ANY of the six buckets, then every bucket is read AS OF
    THAT SAME DATE — so the ladder always reflects one filing's footnote
    table, never a patchwork across fiscal years if a filer skips re-tagging
    a bucket in some year. Cached the same 30 days as the other SEC-sourced
    statements here (debt schedules only change with the next 10-K)."""
    cache_key = f"debt_maturity:v1:{sym.upper()}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached
    us = _fetch_facts(sym)
    if not us:
        return None

    all_facts = []
    for _label, tag in _MATURITY_TAGS:
        node = us.get(tag)
        if not node:
            continue
        for f in node.get("units", {}).get("USD", []):
            if str(f.get("form", "")).startswith("10-K") and f.get("val") is not None and f.get("end"):
                all_facts.append(f)
    if not all_facts:
        return None
    as_of = max(f["end"] for f in all_facts)
    anchor = next(f for f in all_facts if f["end"] == as_of)

    buckets = []
    for label, tag in _MATURITY_TAGS:
        node = us.get(tag)
        val = None
        if node:
            for f in node.get("units", {}).get("USD", []):
                if f.get("end") == as_of and str(f.get("form", "")).startswith("10-K") and f.get("val") is not None:
                    val = f["val"]
                    break
        buckets.append({"label": label, "amount": val or 0})

    result = {
        "as_of": as_of,
        "fiscal_year": anchor.get("fy"),
        "filed": anchor.get("filed"),
        "buckets": buckets,
        "total": sum(b["amount"] for b in buckets),
        "source": "SEC EDGAR 10-K (XBRL)",
    }
    disk_set(cache_key, result, ttl=_CACHE_TTL)
    return result


def _fetch_facts(sym: str) -> dict | None:
    cik = _cik_for(sym)
    if not cik:
        return None
    try:
        r = requests.get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
                         headers=_UA, timeout=_TIMEOUT)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json().get("facts", {}).get("us-gaap")
    except Exception as e:
        logger.warning("SEC companyfacts failed for %s: %s", sym, e)
        return None


def _build(sym: str) -> dict | None:
    """Assemble {income:[latest..], balance:{}, cashflow:{}} in FMP field-name shape,
    or None if SEC has no usable us-gaap facts for this filer."""
    us = _fetch_facts(sym)
    if not us:
        return None

    income_maps = {
        k: _annual_map(us, c, k in _SHARE_FIELDS, instant=False,
                       unit="USD/shares" if k == "epsdiluted" else None)
        for k, c in _INCOME.items()
    }
    balance_maps = {k: _annual_map(us, c, False, instant=True) for k, c in _BALANCE.items()}
    debt_lt = _annual_map(us, _DEBT_LT, False, instant=True)
    debt_cur = _annual_map(us, _DEBT_CUR, False, instant=True)
    cash_maps = {k: _annual_map(us, c, False, instant=False) for k, c in _CASHFLOW.items()}

    years = sorted(income_maps.get("revenue", {}).keys(), reverse=True)
    if not years:
        return None

    income = [{"fiscalYear": fy, "calendarYear": fy, "period": "FY", "date": f"{fy}-12-31",
               **{k: income_maps[k].get(fy) for k in _INCOME}} for fy in years]

    by = years[0]                                     # latest fiscal year for point-in-time statements
    lt = debt_lt.get(by)
    cur = debt_cur.get(by)
    total_debt = None
    if lt is not None or cur is not None:
        total_debt = (lt or 0.0) + (cur or 0.0)
    balance = {
        "cashAndCashEquivalents": balance_maps["cashAndCashEquivalents"].get(by),
        "totalStockholdersEquity": balance_maps["totalStockholdersEquity"].get(by),
        "totalDebt": total_debt,
        # no netDebt: SEC has no such tag, so get_dcf_fundamentals derives debt−cash.
    }
    cashflow = {k: cash_maps[k].get(by) for k in _CASHFLOW}
    if cashflow.get("depreciationAndAmortization") is None:
        parts = [_annual_map(us, c, False, instant=False).get(by) for c in _DA_PARTS]
        if any(p is not None for p in parts):
            cashflow["depreciationAndAmortization"] = sum(p or 0.0 for p in parts)
    return {"income": income, "balance": balance, "cashflow": cashflow}


def _history(sym: str) -> list[dict] | None:
    """Every fiscal year SEC has, as one row per year with income, balance and
    cash-flow lines side by side.

    _build deliberately collapses balance and cash flow to the latest year because
    the DCF only needs a point-in-time snapshot. Charting fundamentals needs the
    whole series, and the annual maps behind it already carry every year, so this
    keeps them instead of taking years[0].
    """
    us = _fetch_facts(sym)
    if not us:
        return None

    income_maps = {
        k: _annual_map(us, c, k in _SHARE_FIELDS, instant=False,
                       unit="USD/shares" if k == "epsdiluted" else None)
        for k, c in _INCOME.items()
    }
    balance_maps = {k: _annual_map(us, c, False, instant=True) for k, c in _BALANCE.items()}
    debt_lt = _annual_map(us, _DEBT_LT, False, instant=True)
    debt_cur = _annual_map(us, _DEBT_CUR, False, instant=True)
    cash_maps = {k: _annual_map(us, c, False, instant=False) for k, c in _CASHFLOW.items()}
    da_parts = [_annual_map(us, c, False, instant=False) for c in _DA_PARTS]

    years = sorted(income_maps.get("revenue", {}).keys())
    if not years:
        return None

    rows = []
    for fy in years:
        row = {"fiscalYear": fy, "date": f"{fy}-12-31"}
        for k in _INCOME:
            row[k] = income_maps[k].get(fy)
        for k in _BALANCE:
            row[k] = balance_maps[k].get(fy)
        for k in _CASHFLOW:
            row[k] = cash_maps[k].get(fy)

        lt, cur = debt_lt.get(fy), debt_cur.get(fy)
        row["totalDebt"] = (lt or 0.0) + (cur or 0.0) if (lt is not None or cur is not None) else None

        # Filers that never tag a single D&A line usually tag its components.
        if row.get("depreciationAndAmortization") is None:
            parts = [m.get(fy) for m in da_parts]
            if any(p is not None for p in parts):
                row["depreciationAndAmortization"] = sum(p or 0.0 for p in parts)

        rows.append(row)
    return rows


def get_fundamental_history(ticker: str) -> list[dict]:
    """Annual fundamental line items, oldest first. [] when SEC has nothing."""
    sym = ticker.strip().upper()
    dk = f"sec:hist:v1:{sym}"
    cached = disk_get(dk)
    if cached is not None:
        return cached or []
    rows = _history(sym)
    if not rows:
        disk_set(dk, [], ttl=_MISS_TTL)
        return []
    disk_set(dk, rows, ttl=_CACHE_TTL)
    return rows


def _sane(bundle: dict | None) -> bool:
    """A bundle is usable when it carries the income lines nothing else can supply:
    revenue, diluted shares, and operating income (banks/insurers report no
    operating-income line, so their absence really is a miss). Capex and D&A are
    checked separately and topped up from FMP per field — rejecting the whole
    bundle over one untagged cash-flow line used to throw away a perfectly good
    share count and fall through to a fabricated one whenever FMP was also dry.
    changeInWorkingCapital is excluded: rarely tagged, and the DCF clamps it."""
    if not bundle or not bundle.get("income"):
        return False
    inc = bundle["income"][0]
    return bool(
        (inc.get("revenue") or 0) > 0
        and (inc.get("weightedAverageShsOutDil") or 0) > 0
        and inc.get("operatingIncome") is not None
    )


def _bundle(sym: str) -> dict | None:
    sym = sym.strip().upper()
    dk = f"sec:fund:v4:{sym}"
    cached = disk_get(dk)
    if cached is not None:
        return cached or None                         # cached {} sentinel = known-empty
    bundle = _build(sym)
    if not _sane(bundle):
        disk_set(dk, {}, ttl=_MISS_TTL)
        return None
    disk_set(dk, bundle, ttl=_CACHE_TTL)
    return bundle


def statements_available(sym: str) -> bool:
    """True when SEC can supply sane income+balance+cashflow for `sym`."""
    return _bundle(sym) is not None


def get_income(ticker: str, limit: int = 2) -> list:
    b = _bundle(ticker)
    return (b["income"][:limit] if b else [])


def _quarterly_map(us: dict, concepts: list[str], unit: str = "USD") -> dict[tuple[int, str], tuple[str, float]]:
    """Reported three-month values keyed by fiscal year and quarter.
    A 10-Q often carries both quarter-only and year-to-date facts under the same
    fiscal-period code. Choosing the duration nearest to 90 days avoids treating
    a nine-month cumulative result as Q3 revenue."""
    picked: dict[tuple[int, str], tuple[int, str, float]] = {}
    for concept in concepts:
        node = us.get(concept) or {}
        for fact in node.get("units", {}).get(unit, []):
            fp = str(fact.get("fp") or "").upper()
            fy, val, start, end = fact.get("fy"), fact.get("val"), fact.get("start"), fact.get("end")
            if fp not in {"Q1", "Q2", "Q3"} or fy is None or val is None or not start or not end:
                continue
            if not str(fact.get("form") or "").startswith("10-Q"):
                continue
            try:
                span = (date.fromisoformat(end) - date.fromisoformat(start)).days
            except ValueError:
                continue
            if span < 60 or span > 115:
                continue
            key = (int(fy), fp)
            candidate = (abs(span - 91), str(fact.get("filed") or ""), float(val))
            existing = picked.get(key)
            if existing is None or candidate[:2] < existing[:2]:
                picked[key] = candidate

    dates: dict[tuple[int, str], str] = {}
    for concept in concepts:
        node = us.get(concept) or {}
        for fact in node.get("units", {}).get(unit, []):
            fp, fy, end = str(fact.get("fp") or "").upper(), fact.get("fy"), fact.get("end")
            if fp in {"Q1", "Q2", "Q3"} and fy is not None and end and (int(fy), fp) in picked:
                dates.setdefault((int(fy), fp), str(end))
    return {key: (dates.get(key, ""), item[2]) for key, item in picked.items()}


def get_quarterly_income(ticker: str, limit: int = 4) -> list:
    """Free reported quarterly income metrics from SEC companyfacts."""
    sym = ticker.strip().upper()
    cache_key = f"sec:qinc:v1:{sym}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached[:limit]
    us = _fetch_facts(sym)
    if not us:
        disk_set(cache_key, [], ttl=86400)
        return []
    maps = {
        "revenue": _quarterly_map(us, _INCOME["revenue"]),
        "grossProfit": _quarterly_map(us, _INCOME["grossProfit"]),
        "operatingIncome": _quarterly_map(us, _INCOME["operatingIncome"]),
        "netIncome": _quarterly_map(us, _INCOME["netIncome"]),
        "epsdiluted": _quarterly_map(us, _INCOME["epsdiluted"], unit="USD/shares"),
    }
    keys = sorted({key for values in maps.values() for key in values}, reverse=True)
    rows = []
    for fy, fp in keys:
        row = {"fiscalYear": fy, "period": fp}
        row["date"] = next((values[(fy, fp)][0] for values in maps.values() if (fy, fp) in values), "")
        row["calendarYear"] = row["date"][:4] if row["date"] else fy
        for field, values in maps.items():
            if (fy, fp) in values:
                row[field] = values[(fy, fp)][1]
        if row.get("revenue") is not None:
            rows.append(row)
    disk_set(cache_key, rows, ttl=_CACHE_TTL)
    return rows[:limit]


def get_balance(ticker: str) -> dict:
    b = _bundle(ticker)
    return (b["balance"] if b else {})


def get_cashflow(ticker: str) -> dict:
    b = _bundle(ticker)
    return (b["cashflow"] if b else {})
