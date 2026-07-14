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
    },
}
_COT_UNIVERSE = {
    "commodities": {"family": "disaggregated", "label": "Commodities", "markets": [("crude", "WTI Crude", "CRUDE OIL, LIGHT SWEET"), ("gold", "Gold", "GOLD - COMMODITY EXCHANGE"), ("copper", "Copper", "COPPER- #1"), ("corn", "Corn", "CORN - CHICAGO BOARD"), ("soybeans", "Soybeans", "SOYBEANS - CHICAGO BOARD"), ("wheat", "Wheat", "WHEAT-SRW - CHICAGO BOARD")]},
    "rates": {"family": "tff", "label": "Rates", "markets": [("2y", "2-Year Treasury", "UST 2Y NOTE"), ("5y", "5-Year Treasury", "UST 5Y NOTE"), ("10y", "10-Year Treasury", "UST 10Y NOTE"), ("bond", "Treasury Bonds", "UST BOND")]},
    "fx": {"family": "tff", "label": "FX", "markets": [("euro", "Euro FX", "EURO FX"), ("yen", "Japanese Yen", "JAPANESE YEN"), ("pound", "British Pound", "BRITISH POUND"), ("dxy", "U.S. Dollar Index", "USD INDEX")]},
    "indices": {"family": "tff", "label": "Equity index futures", "markets": [("spx", "E-mini S&P 500", "E-MINI S&P 500"), ("nasdaq", "Nasdaq-100 E-mini", "NASDAQ-100 CONSOLIDATED"), ("russell", "Russell 2000", "RUSSELL E-MINI"), ("dow", "Mini Dow", "DJIA CONSOLIDATED")]},
    "agriculture": {"family": "cit", "label": "Agriculture", "markets": [("corn", "Corn", "CORN - CHICAGO BOARD"), ("soybeans", "Soybeans", "SOYBEANS - CHICAGO BOARD"), ("wheat", "Chicago Wheat", "WHEAT-SRW - CHICAGO BOARD"), ("cotton", "Cotton No. 2", "COTTON NO. 2")]} ,
}


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


def _cot_market(family_key: str, market_key: str, label: str, term: str) -> dict | None:
    family = _COT_FAMILIES[family_key]
    fields = ["report_date_as_yyyy_mm_dd", "market_and_exchange_names", "open_interest_all"]
    fields.extend(field for _, long, short in family["cohorts"] for field in (long, short))
    params = {
        "$select": ",".join(fields),
        "$where": f"upper(market_and_exchange_names) like '%{term}%'",
        "$order": "report_date_as_yyyy_mm_dd desc",
        "$limit": 110,
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
    primary = next(item for item in family["cohorts"] if item[0] == family["primary"])
    series, cohorts = [], []
    for row in reversed(rows):
        long = _row_num(row, primary[1])
        short = _row_num(row, primary[2])
        oi = _row_num(row, "open_interest_all")
        if long is None or short is None or oi is None:
            continue
        series.append({
            "date": str(row.get("report_date_as_yyyy_mm_dd", ""))[:10],
            "net": long - short,
            "net_pct_oi": (long - short) / oi * 100 if oi else None,
            "open_interest": oi,
        })
    latest = series[-1] if series else None
    if not latest:
        return None
    latest_row = rows[0]
    for cohort_label, long_field, short_field in family["cohorts"]:
        long, short = _row_num(latest_row, long_field), _row_num(latest_row, short_field)
        if long is not None and short is not None:
            cohorts.append({"label": cohort_label, "long": long, "short": short, "net": long - short, "net_pct_oi": (long - short) / latest["open_interest"] * 100 if latest["open_interest"] else None})
    values = [point["net_pct_oi"] for point in series if point["net_pct_oi"] is not None]
    crowding = sum(value <= latest["net_pct_oi"] for value in values) / len(values) * 100 if values else None
    prior = series[-2] if len(series) > 1 else None
    return {"id": market_key, "label": label, "contract": contract, "latest": latest, "weekly_flow": latest["net"] - prior["net"] if prior else None, "open_interest_change": latest["open_interest"] - prior["open_interest"] if prior else None, "crowding": crowding, "series": series, "cohorts": cohorts}


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
