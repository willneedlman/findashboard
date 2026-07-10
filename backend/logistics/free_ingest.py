"""Consolidated free-source ingestion for the Geo-Logistics hub.

One module, one function per source, each returning a cleaned dict ready for the
router. Matches the house conventions (NOT asyncio — the app runs sync `def`
endpoints in FastAPI's threadpool with `requests` + background threads; async over
blocking requests would stall the loop). Every fetch is wrapped so a failed
endpoint or a changed DOM logs a structured warning and serves the last cached
payload instead of crashing.

Caching: `disk_cache` (SQLite) holds each payload well past its refresh window; a
source re-fetches only once its stored copy ages past its window (weekly for
weekly metrics, monthly for monthly), and on any failure the stale copy is served
with `_stale: True`.

Source reality (honest, drives what actually returns data):
  - IMF PortWatch  : reuses the existing maritime router ingestion. WORKS.
  - OpenSky        : freighter movements at cargo hubs. WORKS with OPENSKY_CLIENT_ID/SECRET.
  - LSCI           : UNCTAD ships it as a .7z (no stdlib unpack), so we read the
                     SAME index from the World Bank keyless JSON mirror. Flaky (502s) → graceful.
  - Drewry WCI     : brittle scrape of the public weekly summary page. Best-effort.
  - Census inv/sales: needs a FREE Census API key (CENSUS_API_KEY) — not keyless. Gated.
  - Cass / ATA     : only headline numbers in monthly press releases, no stable
                     markup — needs a pinned release URL + selector before it returns data.
"""
import concurrent.futures
import logging
import os
import re
import time

import requests
from dotenv import load_dotenv

from disk_cache import disk_get, disk_set

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env"))

logger = logging.getLogger("logistics.free_ingest")

_UA = {"User-Agent": "Mozilla/5.0 (compatible; AlphatapeResearch/1.0; +https://alphatape.app)"}
_TIMEOUT = 25
_STORE_TTL = 120 * 86400          # keep on disk far past any refresh window (serve-stale on failure)
WEEK = 7 * 86400
MONTH = 30 * 86400
HALF_DAY = 12 * 3600


def _resilient(key: str, max_age_s: int, fetch) -> dict:
    """Serve fresh-enough cache; else re-fetch; on failure serve the stale copy.
    Never raises. `fetch` returns a dict (its cleaned payload) or raises."""
    stored = disk_get(key)
    if stored and (time.time() - stored.get("_fetched_at", 0)) < max_age_s:
        return stored
    try:
        data = fetch()
        if not data:
            raise ValueError("empty result")
        data["_fetched_at"] = time.time()
        data["_stale"] = False
        disk_set(key, data, ttl=_STORE_TTL)
        return data
    except Exception as e:
        logger.warning("free_ingest %s failed: %s — serving cached", key, e)
        if stored:
            return {**stored, "_stale": True}
        return {"error": str(e), "_stale": True, "data": None}


# ── 1. Maritime ─────────────────────────────────────────────────────────────
def port_transits() -> dict:
    """Daily chokepoint transits for Suez + Panama, reusing the maritime router's
    IMF PortWatch ingestion (no re-scrape)."""
    def fetch():
        from routers.maritime import _portwatch_ids, _pw_history
        mapping = _portwatch_ids()
        out = {}
        for cid in ("suez", "panama"):
            m = mapping.get(cid)
            if not m:
                continue
            pts = _pw_history(m["portid"], 30)
            latest = next((p for p in reversed(pts) if p.get("total") is not None), None)
            out[cid] = {"latest": latest, "series": pts[-30:]}
        if not out:
            raise ValueError("no PortWatch series resolved")
        return {"chokepoints": out, "source": "IMF PortWatch"}
    return _resilient("logi:port_transits", HALF_DAY, fetch)


def liner_connectivity() -> dict:
    """UNCTAD Liner Shipping Connectivity Index via the World Bank keyless mirror
    (UNCTAD's own bulk is .7z, unusable without a non-stdlib unpacker)."""
    def fetch():
        # World Bank rejects long ;-lists (10 -> 400), so batch ≤7 economies per call.
        econ = []
        for batch in ("CN;US;DE;SG;NL;KR;JP", "GB;BE;ES;AE;MY;IN;IT"):
            r = requests.get(
                f"https://api.worldbank.org/v2/country/{batch}/indicator/IS.SHP.GCNW.XQ",
                params={"format": "json", "per_page": "100", "mrv": "1"}, headers=_UA, timeout=_TIMEOUT)
            r.raise_for_status()
            j = r.json()
            rows = j[1] if isinstance(j, list) and len(j) > 1 else []
            econ += [{"country": d["country"]["value"], "iso": d.get("countryiso3code"),
                      "lsci": d["value"], "year": d["date"]}
                     for d in rows if d.get("value") is not None]
        if not econ:
            raise ValueError("no LSCI values")
        return {"economies": sorted(econ, key=lambda e: -e["lsci"]),
                "indicator": "Liner Shipping Connectivity Index",
                "source": "World Bank (UNCTAD LSCI mirror)"}
    return _resilient("logi:lsci:v2", WEEK, fetch)   # v2: 14 economies + iso3


def drewry_wci() -> dict:
    """Top-line Drewry World Container Index composite ($/40ft) scraped from the
    public weekly summary page. Brittle by nature — DOM change → stale fallback."""
    def fetch():
        r = requests.get(
            "https://www.drewry.co.uk/supply-chain-advisors/supply-chain-expertise/"
            "world-container-index-assessed-by-drewry", headers=_UA, timeout=_TIMEOUT)
        r.raise_for_status()
        m = re.search(r"World Container Index[^$]{0,160}\$\s*([\d,]{4,})", r.text, re.I | re.S)
        val = int(m.group(1).replace(",", "")) if m else None
        # Sanity gate: a real WCI composite is ~$1k-$12k/40ft. Reject anything else so a
        # loose regex match can't surface a wrong number (better stale than wrong).
        if not val or not (800 <= val <= 15000):
            raise ValueError(f"no plausible WCI composite in markup (got {val})")
        return {"composite_usd_per_40ft": val, "source": "Drewry WCI (public summary, scraped)"}
    return _resilient("logi:drewry_wci", WEEK, fetch)


# ── 2. Aviation ─────────────────────────────────────────────────────────────
_OPENSKY_TOKEN = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
_OPENSKY_API = "https://opensky-network.org/api"
CARGO_OPERATORS = {
    "FDX": "FedEx", "UPS": "UPS", "GTI": "Atlas Air", "GSS": "DHL (Southern)",
    "BCS": "DHL (EAT)", "DHK": "DHL Air", "CLX": "Cargolux", "GEC": "Lufthansa Cargo",
    "CKS": "Kalitta Air", "ABX": "ABX Air", "PAC": "Polar Air Cargo", "BOX": "AirBridgeCargo",
}
CARGO_HUBS = {
    "KMEM": "Memphis", "KSDF": "Louisville", "EDDF": "Frankfurt", "VHHH": "Hong Kong",
    "PANC": "Anchorage", "KCVG": "Cincinnati", "EDDP": "Leipzig", "ZSPD": "Shanghai",
    "RKSI": "Incheon", "OMDB": "Dubai", "WSSS": "Singapore", "KIND": "Indianapolis",
}
_os_token = {"value": None, "exp": 0.0}


def _opensky_bearer() -> "str | None":
    now = time.time()
    if _os_token["value"] and now < _os_token["exp"] - 60:
        return _os_token["value"]
    cid, sec = os.getenv("OPENSKY_CLIENT_ID"), os.getenv("OPENSKY_CLIENT_SECRET")
    if not (cid and sec):
        return None
    r = requests.post(_OPENSKY_TOKEN, data={
        "grant_type": "client_credentials", "client_id": cid, "client_secret": sec}, timeout=15)
    r.raise_for_status()
    j = r.json()
    _os_token["value"] = j.get("access_token")
    _os_token["exp"] = now + float(j.get("expires_in", 1800))
    return _os_token["value"]


def _hub_moves(icao: str, city: str, begin: int, end: int, headers: dict) -> "dict | None":
    """Cargo movements at one hub. None on hard failure (drops the hub, doesn't
    fail the whole sweep); a 404 is a legitimate empty window."""
    by_op: dict[str, int] = {}
    for ep in ("arrival", "departure"):
        try:
            r = requests.get(f"{_OPENSKY_API}/flights/{ep}",
                             params={"airport": icao, "begin": begin, "end": end},
                             headers=headers, timeout=_TIMEOUT)
        except Exception:
            return None
        if r.status_code == 404:
            continue
        if r.status_code != 200:
            return None
        for f in r.json():
            op = CARGO_OPERATORS.get((f.get("callsign") or "").strip()[:3])
            if op:
                by_op[op] = by_op.get(op, 0) + 1
    return {"icao": icao, "city": city, "movements": sum(by_op.values()), "by_operator": by_op}


def air_cargo() -> dict:
    """Freighter movements (arrivals+departures) at the cargo hubs over a settled 24h
    window, by operator. Hubs are swept in parallel (OpenSky is slow per call).
    Community ADS-B: undercounts, ~12h lag, 404 on empty windows. Gated on creds."""
    def fetch():
        token = _opensky_bearer()
        if not token:
            raise ValueError("OPENSKY_CLIENT_ID/SECRET not set (free OpenSky account)")
        headers = {"Authorization": f"Bearer {token}"}
        end = int(time.time()) - 12 * 3600
        begin = end - 24 * 3600
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            results = ex.map(lambda kv: _hub_moves(kv[0], kv[1], begin, end, headers), CARGO_HUBS.items())
        hubs = [h for h in results if h]
        if not hubs:
            raise ValueError("no hub data")
        return {"window": {"begin": begin, "end": end}, "hubs": sorted(hubs, key=lambda h: -h["movements"]),
                "source": "OpenSky Network (community ADS-B, partial, ~12h lag)"}
    return _resilient("logi:air_cargo:v2", HALF_DAY, fetch)   # v2: 12 hubs


def flights() -> dict:
    """Live positions of cargo aircraft (FedEx/UPS/DHL/Atlas/... by callsign) from
    OpenSky state vectors. Cached 120s to respect the daily credit budget."""
    def fetch():
        token = _opensky_bearer()
        if not token:
            raise ValueError("OPENSKY_CLIENT_ID/SECRET not set (free OpenSky account)")
        r = requests.get(f"{_OPENSKY_API}/states/all",
                         headers={"Authorization": f"Bearer {token}"}, timeout=30)
        r.raise_for_status()
        # State vector: 0 icao24,1 callsign,2 origin_country,5 lon,6 lat,7 baro_alt,
        # 8 on_ground,9 velocity,10 true_track.
        out = []
        for s in r.json().get("states") or []:
            cs = (s[1] or "").strip()
            op = CARGO_OPERATORS.get(cs[:3])
            if not op or s[6] is None or s[5] is None or s[8]:   # cargo, airborne, positioned
                continue
            out.append({"icao24": s[0], "callsign": cs, "operator": op,
                        "lat": s[6], "lon": s[5], "alt_m": s[7], "vel_ms": s[9],
                        "heading": s[10], "origin_country": s[2]})
        return {"flights": out, "source": "OpenSky Network (live state vectors)"}
    return _resilient("logi:flights", 120, fetch)


# ── 3. Domestic & Customs ───────────────────────────────────────────────────
def inventory_sales() -> dict:
    """US total-business inventories-to-sales ratio (Census MTIS). Needs a FREE
    Census API key (CENSUS_API_KEY) — the dataset is not keyless."""
    def fetch():
        key = os.getenv("CENSUS_API_KEY")
        if not key:
            raise ValueError("CENSUS_API_KEY not set (free key at api.census.gov)")
        # MTIS: `time` is a predicate (not a get column); the date returns as `time`.
        # TOTBUS/IR = total business inventories-to-sales ratio, seasonally adjusted.
        r = requests.get("https://api.census.gov/data/timeseries/eits/mtis",
            params={"get": "cell_value,time_slot_date", "for": "us",
                    "category_code": "TOTBUS", "data_type_code": "IR",
                    "seasonally_adj": "yes", "time_slot_id": "0",
                    "time": "from 2024-01", "key": key},
            headers=_UA, timeout=_TIMEOUT)
        r.raise_for_status()
        rows = r.json()
        hdr, body = rows[0], rows[1:]
        iv, it = hdr.index("cell_value"), hdr.index("time")
        series = sorted(({"time": d[it], "ratio": float(d[iv])} for d in body),
                        key=lambda x: x["time"])
        if not series:
            raise ValueError("no MTIS rows")
        return {"series": series[-24:], "latest": series[-1],
                "metric": "total business inventories-to-sales ratio (SA)", "source": "US Census MTIS"}
    return _resilient("logi:inv_sales", MONTH, fetch)


def freight_indices() -> dict:
    """Cass Freight Index (Shipments + Expenditures) and Truck Tonnage — pulled from
    FRED, which republishes all three, instead of scraping the brittle monthly press
    releases. Reuses the shared fred.observations helper and our FRED_API_KEY."""
    def fetch():
        import fred
        series = {
            "cass_shipments": "FRGSHPUSM649NCIS",
            "cass_expenditures": "FRGEXPUSM649NCIS",
            "truck_tonnage": "TRUCKD11",
        }
        out = {}
        for name, sid in series.items():
            obs = fred.observations(sid, 24)
            if obs:
                out[name] = {"latest": obs[-1], "series": obs}
        if not out:
            raise ValueError("no FRED freight series returned")
        return {"indices": out, "source": "FRED (Cass Information Systems; BTS Truck Tonnage)"}
    return _resilient("logi:freight_indices", MONTH, fetch)
