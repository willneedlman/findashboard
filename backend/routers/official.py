"""Official public-data adapters for positioning, forecasts, bank health, and trade."""
from __future__ import annotations

import io
import logging
import os
import zipfile
from datetime import datetime
from xml.etree import ElementTree as ET

import requests
from fastapi import APIRouter, Query

import cache

logger = logging.getLogger(__name__)
router = APIRouter()

_CFTC = "https://publicreporting.cftc.gov/resource/"
_FDIC = "https://api.fdic.gov/banks/financials"
_CENSUS = "https://api.census.gov/data/timeseries/intltrade"
_SPF = "https://www.philadelphiafed.org/-/media/FRBP/Assets/Surveys-And-Data/survey-of-professional-forecasters/historical-data/medianGrowth.xlsx"
_COT_FAMILIES = {
    "disaggregated": {
        "dataset": "72hh-3qpy", "label": "Disaggregated futures only", "primary": "Managed Money",
        "cohorts": [("Producer/Merchant", "prod_merc_positions_long", "prod_merc_positions_short"), ("Swap Dealers", "swap_positions_long_all", "swap__positions_short_all"), ("Managed Money", "m_money_positions_long_all", "m_money_positions_short_all"), ("Other Reportables", "other_rept_positions_long", "other_rept_positions_short")],
    },
    "tff": {
        "dataset": "gpe5-46if", "label": "Traders in Financial Futures", "primary": "Leveraged Money",
        "cohorts": [("Dealers", "dealer_positions_long_all", "dealer_positions_short_all"), ("Asset Managers", "asset_mgr_positions_long", "asset_mgr_positions_short"), ("Leveraged Money", "lev_money_positions_long", "lev_money_positions_short"), ("Other Reportables", "other_rept_positions_long", "other_rept_positions_short")],
    },
    "cit": {
        "dataset": "4zgm-a668", "label": "Supplemental Commodity Index Traders", "primary": "Index Traders",
        "cohorts": [("Commercial (ex-index)", "comm_positions_long_all_nocit", "comm_positions_short_all_nocit"), ("Index Traders", "cit_positions_long_all", "cit_positions_short_all")],
        # The supplemental report never publishes non-commercial ex-index on its
        # own, so that slice is derived as whatever the reportable total leaves
        # over. Without it the cohorts cannot balance.
        "remainder": "Other Reportables",
    },
}

# Every futures contract has a buyer for every seller, so total longs, total
# shorts and open interest are the same number and the cohort nets must sum to
# zero. Non-reportables are the small-trader remainder that closes that identity;
# leaving them out was what made the categories look unbalanced.
_NONREPORTABLE = ("Non-Reportables", "nonrept_positions_long_all", "nonrept_positions_short_all")
_TOTAL_REPORTABLE = ("tot_rept_positions_long_all", "tot_rept_positions_short")
# CFTC publishes whole contracts, so a couple of contracts of rounding slack is
# expected; anything larger means a field was misread and should surface.
_NET_ZERO_TOLERANCE = 5
_COT_HISTORY_WEEKS = 260          # five years of weekly prints
_TREND_WINDOWS = ((4, "w4"), (13, "w13"), (26, "w26"))
_COT_UNIVERSE = {
    "commodities": {"family": "disaggregated", "label": "Commodities", "markets": [("crude", "WTI Crude", "CRUDE OIL, LIGHT SWEET"), ("gold", "Gold", "GOLD - COMMODITY EXCHANGE"), ("copper", "Copper", "COPPER- #1"), ("corn", "Corn", "CORN - CHICAGO BOARD"), ("soybeans", "Soybeans", "SOYBEANS - CHICAGO BOARD"), ("wheat", "Wheat", "WHEAT-SRW - CHICAGO BOARD")]},
    "rates": {"family": "tff", "label": "Rates", "markets": [("2y", "2-Year Treasury", "UST 2Y NOTE"), ("5y", "5-Year Treasury", "UST 5Y NOTE"), ("10y", "10-Year Treasury", "UST 10Y NOTE"), ("bond", "Treasury Bonds", "UST BOND")]},
    "fx": {"family": "tff", "label": "FX", "markets": [("euro", "Euro FX", "EURO FX"), ("yen", "Japanese Yen", "JAPANESE YEN"), ("pound", "British Pound", "BRITISH POUND"), ("dxy", "U.S. Dollar Index", "USD INDEX")]},
    "indices": {"family": "tff", "label": "Equity index futures", "markets": [("spx", "E-mini S&P 500", "E-MINI S&P 500"), ("nasdaq", "Nasdaq-100 E-mini", "NASDAQ-100 CONSOLIDATED"), ("russell", "Russell 2000", "RUSSELL E-MINI"), ("dow", "Mini Dow", "DJIA CONSOLIDATED")]},
    "agriculture": {"family": "cit", "label": "Agriculture", "markets": [("corn", "Corn", "CORN - CHICAGO BOARD"), ("soybeans", "Soybeans", "SOYBEANS - CHICAGO BOARD"), ("wheat", "Chicago Wheat", "WHEAT-SRW - CHICAGO BOARD"), ("cotton", "Cotton No. 2", "COTTON NO. 2")]} ,
}


# Published CME/ICE contract specifications. `scale` converts a cent-quoted feed
# to dollars (grains, softs). Treasuries carry `face`: their size is the face
# value of the note, which is the market convention and needs no price lookup.
# These are contract terms, not estimates, so they are hardcoded deliberately.
_CONTRACT_SPECS: dict[str, dict] = {
    "spx":      {"mult": 50,         "unit": "index point", "symbol": "^GSPC"},
    "nasdaq":   {"mult": 20,         "unit": "index point", "symbol": "^NDX"},
    "russell":  {"mult": 50,         "unit": "index point", "symbol": "^RUT"},
    "dow":      {"mult": 5,          "unit": "index point", "symbol": "^DJI"},
    "euro":     {"mult": 125_000,    "unit": "EUR",         "symbol": "EURUSD=X"},
    "yen":      {"mult": 12_500_000, "unit": "JPY",         "symbol": "JPYUSD=X"},
    "pound":    {"mult": 62_500,     "unit": "GBP",         "symbol": "GBPUSD=X"},
    "dxy":      {"mult": 1_000,      "unit": "index point", "symbol": "DX-Y.NYB"},
    "2y":       {"mult": 200_000,    "unit": "USD face",    "face": True},
    "5y":       {"mult": 100_000,    "unit": "USD face",    "face": True},
    "10y":      {"mult": 100_000,    "unit": "USD face",    "face": True},
    "bond":     {"mult": 100_000,    "unit": "USD face",    "face": True},
    "crude":    {"mult": 1_000,      "unit": "barrel",      "symbol": "CL=F"},
    "gold":     {"mult": 100,        "unit": "troy ounce",  "symbol": "GC=F"},
    "copper":   {"mult": 25_000,     "unit": "pound",       "symbol": "HG=F"},
    "corn":     {"mult": 5_000,      "unit": "bushel",      "symbol": "ZC=F", "scale": 0.01},
    "soybeans": {"mult": 5_000,      "unit": "bushel",      "symbol": "ZS=F", "scale": 0.01},
    "wheat":    {"mult": 5_000,      "unit": "bushel",      "symbol": "ZW=F", "scale": 0.01},
    "cotton":   {"mult": 50_000,     "unit": "pound",       "symbol": "CT=F", "scale": 0.01},
}


@cache.cached(ttl=900, maxsize=4)
def _contract_prices() -> dict:
    """Last price for every priced contract in ONE batched download.

    Positions are meaningless across asset classes until they are in dollars: 100
    corn contracts and 100 S&P contracts differ by more than an order of
    magnitude. A symbol that fails to price yields no notional rather than a
    guessed one.
    """
    import datetime as _dt

    symbols = sorted({spec["symbol"] for spec in _CONTRACT_SPECS.values() if spec.get("symbol")})
    today = _dt.date.today()
    # A week of lookback so a long weekend or holiday still yields a last print.
    start = (today - _dt.timedelta(days=8)).isoformat()
    end = (today + _dt.timedelta(days=1)).isoformat()
    try:
        frame = cache.get_download(tuple(symbols), start, end, "1d", cache_ttl=900, auto_adjust=False)
        closes = frame["Close"] if "Close" in frame else frame
        latest = closes.ffill().iloc[-1]
        return {sym: float(latest[sym]) for sym in symbols
                if sym in latest and latest[sym] == latest[sym]}
    except Exception:
        logger.exception("contract price fetch failed; notional will be omitted")
        return {}


def _contract_value(market_key: str) -> dict | None:
    """What one contract is worth in dollars, plus the terms behind that number."""
    spec = _CONTRACT_SPECS.get(market_key)
    if not spec:
        return None
    if spec.get("face"):
        return {"multiplier": spec["mult"], "unit": spec["unit"], "price": None,
                "value_usd": float(spec["mult"]), "basis": "face value"}
    price = _contract_prices().get(spec["symbol"])
    if price is None:
        return {"multiplier": spec["mult"], "unit": spec["unit"], "price": None,
                "value_usd": None, "basis": "unpriced"}
    value = spec["mult"] * price * spec.get("scale", 1)
    return {"multiplier": spec["mult"], "unit": spec["unit"], "price": price,
            "value_usd": value, "basis": "mark to market"}


def _num(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _row_num(row: dict, field: str):
    for key, value in row.items():
        if key.lower() == field.lower():
            return _num(value)
    return None


def _cohort_split(family: dict, row: dict) -> list[tuple[str, float, float]]:
    """Every participant category for one weekly print, as (label, long, short).

    Returns [] when any field is missing rather than a partial split, because a
    partial split silently breaks the net-zero identity the caller relies on.
    """
    out: list[tuple[str, float, float]] = []
    for label, long_field, short_field in family["cohorts"]:
        long, short = _row_num(row, long_field), _row_num(row, short_field)
        if long is None or short is None:
            return []
        out.append((label, long, short))
    if family.get("remainder"):
        total_long, total_short = (_row_num(row, field) for field in _TOTAL_REPORTABLE)
        if total_long is None or total_short is None:
            return []
        out.append((
            family["remainder"],
            total_long - sum(long for _, long, _ in out),
            total_short - sum(short for _, _, short in out),
        ))
    nonrept_long, nonrept_short = (_row_num(row, field) for field in _NONREPORTABLE[1:])
    if nonrept_long is None or nonrept_short is None:
        return []
    out.append((_NONREPORTABLE[0], nonrept_long, nonrept_short))
    return out


def _trend(history: list[float | None]) -> dict:
    """Change in a cohort's net over the trailing windows, oldest-first history.

    Asset managers and other slow money move over months, so a week-on-week
    delta says almost nothing about where they are actually going.
    """
    out: dict[str, float | None] = {}
    latest = history[-1] if history else None
    for weeks, key in _TREND_WINDOWS:
        prior = history[-1 - weeks] if len(history) > weeks else None
        out[key] = latest - prior if latest is not None and prior is not None else None
    return out


def _cot_market(family_key: str, market_key: str, label: str, term: str) -> dict | None:
    family = _COT_FAMILIES[family_key]
    fields = ["report_date_as_yyyy_mm_dd", "market_and_exchange_names", "open_interest_all"]
    fields.extend(field for _, long, short in family["cohorts"] for field in (long, short))
    fields.extend(_NONREPORTABLE[1:])
    if family.get("remainder"):
        fields.extend(_TOTAL_REPORTABLE)
    params = {
        "$select": ",".join(fields),
        "$where": f"upper(market_and_exchange_names) like '%{term}%'",
        "$order": "report_date_as_yyyy_mm_dd desc",
        "$limit": _COT_HISTORY_WEEKS,
    }
    try:
        response = requests.get(f"{_CFTC}{family['dataset']}.json", params=params, timeout=15)
        response.raise_for_status()
        rows = response.json()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("CFTC %s positioning unavailable: %s", family_key, exc)
        return None
    if not rows:
        return None
    contract = rows[0].get("market_and_exchange_names")
    rows = [r for r in rows if r.get("market_and_exchange_names") == contract]
    series: list[dict] = []
    cohort_history: dict[str, list[float]] = {}
    latest_split: list[tuple[str, float, float]] = []
    for row in reversed(rows):
        oi = _row_num(row, "open_interest_all")
        split = _cohort_split(family, row)
        if oi is None or not split:
            continue
        primary_net = next((long - short for name, long, short in split if name == family["primary"]), None)
        if primary_net is None:
            continue
        for name, long, short in split:
            cohort_history.setdefault(name, []).append(long - short)
        latest_split = split
        series.append({
            "date": str(row.get("report_date_as_yyyy_mm_dd", ""))[:10],
            "net": primary_net,
            "net_pct_oi": primary_net / oi * 100 if oi else None,
            "open_interest": oi,
            "cohort_net": {name: long - short for name, long, short in split},
        })
    latest = series[-1] if series else None
    if not latest:
        return None

    # Distinct name from `contract`: that already holds the CFTC contract name
    # string this market was matched on, and shadowing it shipped the dict to the
    # UI in its place.
    contract_value = _contract_value(market_key)
    unit_value = contract_value["value_usd"] if contract_value else None
    cohorts = []
    for cohort_label, long, short in latest_split:
        net = long - short
        cohorts.append({
            "label": cohort_label,
            "long": long,
            "short": short,
            "net": net,
            "net_pct_oi": net / latest["open_interest"] * 100 if latest["open_interest"] else None,
            "trend": _trend(cohort_history.get(cohort_label, [])),
            "derived": cohort_label == family.get("remainder"),
            "long_usd": long * unit_value if unit_value else None,
            "short_usd": short * unit_value if unit_value else None,
            "net_usd": net * unit_value if unit_value else None,
        })
    # Longs and shorts are the same pool seen from two sides, so this is an
    # identity, not an estimate. Report it either way so a bad field mapping
    # shows up on screen instead of quietly skewing every cohort.
    residual = sum(item["net"] for item in cohorts)
    values = [point["net_pct_oi"] for point in series if point["net_pct_oi"] is not None]
    crowding = sum(value <= latest["net_pct_oi"] for value in values) / len(values) * 100 if values else None
    prior = series[-2] if len(series) > 1 else None
    return {
        "id": market_key,
        "label": label,
        "contract": contract,
        "latest": latest,
        "weekly_flow": latest["net"] - prior["net"] if prior else None,
        "open_interest_change": latest["open_interest"] - prior["open_interest"] if prior else None,
        "crowding": crowding,
        "series": series,
        "cohorts": cohorts,
        "net_residual": residual,
        "balanced": abs(residual) <= _NET_ZERO_TOLERANCE,
        "weeks": len(series),
        "primary": family["primary"],
        "contract_value": contract_value,
        "open_interest_usd": latest["open_interest"] * unit_value if unit_value else None,
    }


@cache.cached(ttl=6 * 3600, maxsize=10)
def cot_positioning(asset_class: str) -> dict:
    universe = _COT_UNIVERSE[asset_class]
    family_key = universe["family"]
    markets = [result for market in universe["markets"] if (result := _cot_market(family_key, *market))]
    return {"available": bool(markets), "asset_class": asset_class, "asset_label": universe["label"], "family": _COT_FAMILIES[family_key]["label"], "markets": markets, "source": "CFTC Commitments of Traders", "as_of": max((market["latest"]["date"] for market in markets), default=None)}


def _last_numeric_xlsx_row(content: bytes, sheet_name: str) -> list[float]:
    """Extract the final populated numeric row without relying on an Excel engine."""
    namespace = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    rel_namespace = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheets = workbook.find(f"{namespace}sheets")
        relationship_id = next(
            sheet.attrib.get(f"{rel_namespace}id") for sheet in sheets
            if sheet.attrib.get("name") == sheet_name
        )
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = next(
            relation.attrib["Target"] for relation in relationships
            if relation.attrib.get("Id") == relationship_id
        ).lstrip("/")
        sheet_xml = ET.fromstring(archive.read(f"xl/{target}"))
        last_values: list[float] = []
        for row in sheet_xml.findall(f".//{namespace}row"):
            values = []
            for cell in row.findall(f"{namespace}c"):
                value = cell.find(f"{namespace}v")
                numeric = _num(value.text if value is not None else None)
                if numeric is not None:
                    values.append(numeric)
            if values:
                last_values = values
    return last_values


def _quarter_label(year: int, quarter: int) -> str:
    return f"{year} Q{quarter}"


@cache.cached(ttl=24 * 3600, maxsize=2)
def spf_forecasts() -> dict:
    try:
        response = requests.get(_SPF, timeout=25)
        response.raise_for_status()
        sheets = {
            "RGDP": ("Real GDP growth", "Real output growth"),
            "PGDP": ("GDP price inflation", "GDP-wide inflation"),
            "EMP_PCG": ("Payroll employment growth", "Nonfarm payroll growth"),
            "HOUSING": ("Housing starts growth", "Housing construction growth"),
        }
        forecasts = []
        survey_period = None
        forecast_period = None
        for sheet, (label, description) in sheets.items():
            values = _last_numeric_xlsx_row(response.content, sheet)
            if len(values) >= 3:
                year, quarter = int(values[0]), int(values[1])
                forecast_year, forecast_quarter = divmod(year * 4 + quarter - 1 + 4, 4)
                forecast_quarter += 1
                survey_period = survey_period or _quarter_label(year, quarter)
                forecast_period = forecast_period or _quarter_label(forecast_year, forecast_quarter)
                forecasts.append({"key": sheet, "label": label, "description": description, "unit": "annualized % change", "median": values[-1], "horizon": "four quarters ahead"})
    except Exception as exc:  # third-party workbook schema changes are non-fatal
        logger.warning("SPF workbook unavailable: %s", exc)
        return {"available": False, "source": "Philadelphia Fed SPF"}
    return {"available": bool(forecasts), "forecasts": forecasts, "horizon": "four quarters ahead", "survey_period": survey_period, "forecast_period": forecast_period, "source": "Philadelphia Fed Survey of Professional Forecasters", "as_of": datetime.utcnow().date().isoformat()}


@cache.cached(ttl=24 * 3600, maxsize=2)
def fdic_bank_system() -> dict:
    fields = "NAME,CERT,ASSET,DEP,ROA,ROE,NIMY,NCLNLSR,NETINC,RISDATE"
    params = {"limit": 500, "format": "json", "filters": "ACTIVE:1", "fields": fields, "sort_by": "ASSET", "sort_order": "DESC"}
    try:
        payload = requests.get(_FDIC, params=params, timeout=20).json()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("FDIC bank data unavailable: %s", exc)
        return {"available": False, "source": "FDIC BankFind"}
    rows = [entry.get("data", {}) for entry in payload.get("data", [])]
    latest_date = max((str(row.get("RISDATE", "")) for row in rows), default="")
    if latest_date:
        try:
            response = requests.get(_FDIC, params={**params, "filters": f"ACTIVE:1 AND RISDATE:{latest_date}"}, timeout=20)
            response.raise_for_status()
            rows = [entry.get("data", {}) for entry in response.json().get("data", [])]
        except (requests.RequestException, ValueError) as exc:
            logger.warning("FDIC latest-quarter request unavailable: %s", exc)
    banks = []
    seen = set()
    for row in rows:
        cert = row.get("CERT")
        if not cert or cert in seen:
            continue
        seen.add(cert)
        banks.append({"name": row.get("NAME"), "cert": cert, "assets": _num(row.get("ASSET")), "deposits": _num(row.get("DEP")), "roa": _num(row.get("ROA")), "roe": _num(row.get("ROE")), "nim": _num(row.get("NIMY")), "net_chargeoffs": _num(row.get("NCLNLSR")), "as_of": str(row.get("RISDATE", ""))})
    banks.sort(key=lambda bank: bank["assets"] or 0, reverse=True)
    banks = banks[:12]
    return {"available": bool(banks), "banks": banks, "source": "FDIC BankFind", "as_of": latest_date or max((b["as_of"] for b in banks), default=None)}


def census_enabled() -> bool:
    return bool(os.getenv("CENSUS_API_KEY", "").strip())


@cache.cached(ttl=24 * 3600, maxsize=96)
def census_trade(flow: str, period: str, commodity: str) -> dict:
    key = os.getenv("CENSUS_API_KEY", "").strip()
    if not key:
        return {"available": False, "source": "U.S. Census International Trade API", "detail": "CENSUS_API_KEY is not configured."}
    exports = flow == "X"
    prefix = "exports" if exports else "imports"
    commodity_key = "E_COMMODITY" if exports else "I_COMMODITY"
    value_key = "ALL_VAL_MO" if exports else "GEN_VAL_MO"
    quantity_key = "QTY_1_MO"
    fields = f"CTY_CODE,CTY_NAME,{commodity_key},{commodity_key}_LDESC,{value_key},{quantity_key}"
    year, month = period.split("-", 1)
    try:
        response = requests.get(f"{_CENSUS}/{prefix}/hs", params={"get": fields, "YEAR": year, "MONTH": month, commodity_key: commodity, "key": key}, timeout=20)
        response.raise_for_status()
        rows = response.json()
    except (requests.RequestException, ValueError) as exc:
        logger.warning("Census trade unavailable: %s", exc)
        return {"available": False, "source": "U.S. Census International Trade API"}
    if len(rows) < 2:
        return {"available": False, "source": "U.S. Census International Trade API"}
    headers, values = rows[0], rows[1:]
    items = [dict(zip(headers, row)) for row in values]
    partners = [
        {"partner": item.get("CTY_NAME"), "code": item.get("CTY_CODE"), "value": _num(item.get(value_key)), "quantity": _num(item.get(quantity_key))}
        for item in items
        if str(item.get("CTY_CODE", "")).isdigit() and not str(item.get("CTY_CODE", "")).startswith("0")
    ]
    return {"available": bool(partners), "period": period, "commodity": commodity, "flow": "Exports" if exports else "Imports", "partners": sorted(partners, key=lambda item: item["value"] or 0, reverse=True), "source": "U.S. Census International Trade API"}


@router.get("/cot")
def cot(asset_class: str = Query("commodities", pattern="^(commodities|rates|fx|indices|agriculture)$")):
    return cot_positioning(asset_class)


@router.get("/spf")
def spf():
    return spf_forecasts()


@router.get("/fdic")
def fdic():
    return fdic_bank_system()


@router.get("/census-status")
def census_status():
    return {"available": census_enabled(), "source": "U.S. Census International Trade API", "detail": "Monthly U.S. bilateral trade is enabled when CENSUS_API_KEY is configured."}


@router.get("/census-trade")
def census(flow: str = Query("X", pattern="^(X|M)$"), period: str = Query(..., pattern="^20\\d{2}-(0[1-9]|1[0-2])$"), commodity: str = Query(..., min_length=2, max_length=10)):
    return census_trade(flow, period, commodity)
