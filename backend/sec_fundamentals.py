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
import re
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
# Charting-only line items. Kept apart from the maps above because _build feeds
# the DCF and must keep returning exactly the fields it already returns.
_EXTRA_INCOME = {
    "researchAndDevelopment": ["ResearchAndDevelopmentExpense"],
    "sellingGeneralAndAdmin": ["SellingGeneralAndAdministrativeExpense",
                               "GeneralAndAdministrativeExpense"],
    "interestExpense": ["InterestExpense", "InterestExpenseDebt", "InterestIncomeExpenseNet"],
}
_EXTRA_BALANCE = {   # instants
    "totalAssets": ["Assets"],
    "totalLiabilities": ["Liabilities"],
    "currentAssets": ["AssetsCurrent"],
    "currentLiabilities": ["LiabilitiesCurrent"],
    "inventory": ["InventoryNet"],
    "receivables": ["AccountsReceivableNetCurrent"],
    "propertyPlantEquipment": ["PropertyPlantAndEquipmentNet"],
    "goodwill": ["Goodwill"],
    "retainedEarnings": ["RetainedEarningsAccumulatedDeficit"],
}
_EXTRA_CASHFLOW = {   # durations. SEC tags payments as POSITIVE outflows.
    "operatingCashFlow": ["NetCashProvidedByUsedInOperatingActivities",
                          "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"],
    "investingCashFlow": ["NetCashProvidedByUsedInInvestingActivities"],
    "financingCashFlow": ["NetCashProvidedByUsedInFinancingActivities"],
    "stockCompensation": ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense"],
    "buybacks": ["PaymentsForRepurchaseOfCommonStock"],
    "dividendsPaid": ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"],
}
_DPS = ["CommonStockDividendsPerShareDeclared"]

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


def _companyfacts(cik: str) -> tuple[dict | None, str]:
    """(us-gaap facts, entityName) for one CIK."""
    try:
        r = requests.get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
                         headers=_UA, timeout=_TIMEOUT)
        if r.status_code == 404:
            return None, ""
        r.raise_for_status()
        j = r.json()
        return j.get("facts", {}).get("us-gaap"), j.get("entityName") or ""
    except Exception as e:
        logger.warning("SEC companyfacts failed for CIK%s: %s", cik, e)
        return None, ""


_SUFFIXES = {"corp", "corporation", "inc", "incorporated", "co", "company", "ltd", "limited",
             "plc", "holdings", "holding", "group", "the", "sa", "nv", "ag", "lp", "llc",
             "class", "common", "stock", "new"}


def _norm_name(name: str) -> str:
    """A company name without its corporate suffix, for comparing two spellings
    of the same issuer. EDGAR's conformed name is "EXXON MOBIL CORP" while
    companyfacts says "Exxon Mobil Corporation"."""
    words = [w for w in re.sub(r"[^a-z0-9 ]+", " ", name.lower()).split() if w not in _SUFFIXES]
    return " ".join(words)


def _filing_cik(name: str) -> str | None:
    """The CIK that actually files 10-Ks under this company name.

    A reorganised issuer gets a NEW registrant, and SEC's ticker file follows the
    ticker to it immediately. Exxon's XOM maps to CIK 2115436, which has 94
    concepts and no annual facts at all, while every 10-K since 1993 sits under
    CIK 34088. Company search resolves the name to the filing registrant.
    """
    # Company search matches a PREFIX of the conformed name, so the full legal
    # name misses: "Exxon Mobil Corporation" is not a prefix of "EXXON MOBIL CORP".
    for query in dict.fromkeys([_norm_name(name), name, " ".join(_norm_name(name).split()[:2])]):
        if not query:
            continue
        try:
            r = requests.get(
                "https://www.sec.gov/cgi-bin/browse-edgar",
                params={"company": query, "type": "10-K", "dateb": "", "owner": "include",
                        "count": "10", "action": "getcompany", "output": "atom"},
                headers=_UA, timeout=_TIMEOUT)
            r.raise_for_status()
            hits = re.findall(r"<cik>(\d{7,10})</cik>", r.text) or re.findall(r"CIK=(\d{7,10})", r.text)
            if hits:
                return hits[0].zfill(10)
        except Exception as e:
            logger.warning("SEC company search failed for %s: %s", query, e)
    return None


def _has_annual(us: dict | None) -> bool:
    return bool(us) and bool(_annual_map(us, _INCOME["revenue"], False, instant=False))


def _fetch_facts(sym: str) -> dict | None:
    cik = _cik_for(sym)
    if not cik:
        return None
    us, name = _companyfacts(cik)
    if _has_annual(us) or not name:
        return us
    # Nothing annual under the ticker's own CIK. Before giving up, check whether
    # the history lives under a predecessor registrant of the same name.
    key = f"sec:filingcik:v1:{cik}"
    alt = disk_get(key)
    if alt is None:
        alt = _filing_cik(name) or ""
        disk_set(key, alt, ttl=_CACHE_TTL if alt else _MISS_TTL)
    if not alt or alt == cik:
        return us
    alt_us, alt_name = _companyfacts(alt)
    # Only accept a same-issuer match: a name search can surface a trust or a
    # subsidiary, and charting one company's filings under another's ticker
    # would be worse than showing nothing.
    if _has_annual(alt_us) and _norm_name(alt_name) == _norm_name(name):
        logger.info("SEC: %s has no annual facts under CIK%s, using CIK%s", sym, cik, alt)
        return alt_us
    return us


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
    x_income = {k: _annual_map(us, c, False, instant=False) for k, c in _EXTRA_INCOME.items()}
    x_balance = {k: _annual_map(us, c, False, instant=True) for k, c in _EXTRA_BALANCE.items()}
    x_cash = {k: _annual_map(us, c, False, instant=False) for k, c in _EXTRA_CASHFLOW.items()}
    dps = _annual_map(us, _DPS, False, instant=False, unit="USD/shares")

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
        for maps in (x_income, x_balance, x_cash):
            for k, m in maps.items():
                row[k] = m.get(fy)
        row["dividendPerShare"] = dps.get(fy)

        lt, cur = debt_lt.get(fy), debt_cur.get(fy)
        row["totalDebt"] = (lt or 0.0) + (cur or 0.0) if (lt is not None or cur is not None) else None

        # Filers that never tag a single D&A line usually tag its components.
        if row.get("depreciationAndAmortization") is None:
            parts = [m.get(fy) for m in da_parts]
            if any(p is not None for p in parts):
                row["depreciationAndAmortization"] = sum(p or 0.0 for p in parts)

        # Free cash flow and working capital are definitions, not estimates: the
        # subtraction is the whole content, so deriving them here beats making
        # every user write the same formula.
        ocf, capex = row.get("operatingCashFlow"), row.get("capitalExpenditure")
        row["freeCashFlow"] = ocf - capex if ocf is not None and capex is not None else None
        ca, cl = row.get("currentAssets"), row.get("currentLiabilities")
        row["workingCapital"] = ca - cl if ca is not None and cl is not None else None

        rows.append(row)
    return rows


def get_fundamental_history(ticker: str) -> list[dict]:
    """Annual fundamental line items, oldest first. [] when SEC has nothing."""
    sym = ticker.strip().upper()
    dk = f"sec:hist:v2:{sym}"
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
