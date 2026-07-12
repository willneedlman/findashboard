"""Maritime & energy-infrastructure map data.

Three static reference layers (chokepoints, export terminals, a coarse pipeline
fallback), a live Overpass connector for on-demand OSM pipeline detail, and a
background AIS worker that keeps an in-memory snapshot of vessels around the
major shipping chokepoints (fed by aisstream.io over a WebSocket).

Data fetching lives here; the React page (pages/MaritimeMap.tsx) only plots.
"""
import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

import requests
from fastapi import APIRouter, Query

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
try:
    from disk_cache import disk_get, disk_set
    import disk_cache as _dc
except ImportError:                                   # pragma: no cover
    _dc = None
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

import energy_nowcaster

_log = logging.getLogger("maritime")
router = APIRouter()


# ── Static reference data ───────────────────────────────────────────────────
# Top global maritime chokepoints. oil_mbd = approx daily crude+products transit
# in million barrels/day (EIA World Oil Transit Chokepoints, rounded).
CHOKEPOINTS = [
    {"id": "hormuz",    "name": "Strait of Hormuz",   "lat": 26.57, "lon": 56.25, "oil_mbd": 21.0, "note": "Gulf crude to Asia/Europe"},
    {"id": "malacca",   "name": "Strait of Malacca",  "lat": 1.43,  "lon": 102.9, "oil_mbd": 23.0, "note": "Middle East to East Asia"},
    {"id": "suez",      "name": "Suez Canal + SUMED", "lat": 30.42, "lon": 32.35, "oil_mbd": 9.2,  "note": "Red Sea to Mediterranean"},
    {"id": "bab",       "name": "Bab el-Mandeb",      "lat": 12.58, "lon": 43.33, "oil_mbd": 8.8,  "note": "Gateway to the Suez route"},
    {"id": "panama",    "name": "Panama Canal",       "lat": 9.08,  "lon": -79.68, "oil_mbd": 1.0, "note": "US Gulf to Pacific"},
    {"id": "bosphorus", "name": "Turkish Straits",    "lat": 41.12, "lon": 29.07, "oil_mbd": 3.0,  "note": "Black Sea crude export"},
    {"id": "danish",    "name": "Danish Straits",     "lat": 55.70, "lon": 12.70, "oil_mbd": 3.2,  "note": "Baltic (Russian) export"},
    {"id": "goodhope",  "name": "Cape of Good Hope",  "lat": -34.36, "lon": 18.47, "oil_mbd": 5.8, "note": "Suez bypass around Africa"},
    {"id": "gibraltar", "name": "Strait of Gibraltar", "lat": 35.97, "lon": -5.50, "oil_mbd": 3.0, "note": "Atlantic-Mediterranean link"},
    {"id": "taiwan",    "name": "Taiwan Strait",      "lat": 24.50, "lon": 119.5, "oil_mbd": 14.0, "note": "East Asia trade artery"},
]

# Top oil/LNG export terminals. kind: oil | lng. throughput is an approximate
# nameplate/observed capacity string for the tooltip.
PORTS = [
    {"name": "Ras Tanura",        "country": "Saudi Arabia", "lat": 26.64, "lon": 50.16, "kind": "oil", "throughput": "~6.5 Mb/d crude"},
    {"name": " Juaymah",          "country": "Saudi Arabia", "lat": 26.88, "lon": 50.03, "kind": "oil", "throughput": "~3.0 Mb/d crude"},
    {"name": "Kharg Island",      "country": "Iran",         "lat": 29.23, "lon": 50.32, "kind": "oil", "throughput": "~5.0 Mb/d crude"},
    {"name": "Basra Oil Terminal", "country": "Iraq",        "lat": 29.68, "lon": 48.80, "kind": "oil", "throughput": "~3.4 Mb/d crude"},
    {"name": "Fujairah",          "country": "UAE",          "lat": 25.16, "lon": 56.36, "kind": "oil", "throughput": "bunkering + crude hub"},
    {"name": "Ruwais",            "country": "UAE",          "lat": 24.11, "lon": 52.73, "kind": "oil", "throughput": "~1.5 Mb/d products"},
    {"name": "Ras Laffan",        "country": "Qatar",        "lat": 25.90, "lon": 51.60, "kind": "lng", "throughput": "~77 Mtpa LNG"},
    {"name": "Sabine Pass",       "country": "United States", "lat": 29.73, "lon": -93.87, "kind": "lng", "throughput": "~30 Mtpa LNG"},
    {"name": "Corpus Christi",    "country": "United States", "lat": 27.81, "lon": -97.40, "kind": "oil", "throughput": "~2.0 Mb/d crude"},
    {"name": "Houston",          "country": "United States", "lat": 29.73, "lon": -95.10, "kind": "oil", "throughput": "major crude/products"},
    {"name": "Rotterdam",        "country": "Netherlands",  "lat": 51.95, "lon": 4.14,  "kind": "oil", "throughput": "Europe import hub"},
    {"name": "Primorsk",         "country": "Russia",       "lat": 60.34, "lon": 28.61, "kind": "oil", "throughput": "~1.4 Mb/d crude"},
    {"name": "Novorossiysk",     "country": "Russia",       "lat": 44.72, "lon": 37.78, "kind": "oil", "throughput": "~1.6 Mb/d crude"},
    {"name": "Yanbu",           "country": "Saudi Arabia", "lat": 24.09, "lon": 38.06, "kind": "oil", "throughput": "Red Sea crude export"},
    {"name": "Yeosu",           "country": "South Korea",  "lat": 34.76, "lon": 127.66, "kind": "oil", "throughput": "refining/export hub"},
    {"name": "Singapore",       "country": "Singapore",    "lat": 1.26,  "lon": 103.75, "kind": "oil", "throughput": "global bunkering hub"},
    {"name": "Jebel Ali",       "country": "UAE",          "lat": 25.01, "lon": 55.06, "kind": "oil", "throughput": "products + bunkering"},
    {"name": "Bonny",           "country": "Nigeria",      "lat": 4.42,  "lon": 7.15,  "kind": "lng", "throughput": "~22 Mtpa LNG + crude"},
    {"name": "Gladstone",       "country": "Australia",    "lat": -23.84, "lon": 151.25, "kind": "lng", "throughput": "~30 Mtpa LNG"},
    {"name": "Dampier",         "country": "Australia",    "lat": -20.66, "lon": 116.71, "kind": "lng", "throughput": "NWS ~16 Mtpa LNG"},
    {"name": "Bethioua (Arzew)", "country": "Algeria",     "lat": 35.80, "lon": -0.25, "kind": "lng", "throughput": "~25 Mtpa LNG"},
    {"name": "Zeebrugge",       "country": "Belgium",      "lat": 51.34, "lon": 3.20,  "kind": "lng", "throughput": "Europe LNG terminal"},
]

# Coarse illustrative pipeline tracks (fallback when Overpass returns nothing).
# substance: gas | oil. Each is a short list of [lat, lon] waypoints.
PIPELINES = [
    {"name": "Nord Stream",        "substance": "gas", "coords": [[60.68, 27.30], [59.60, 22.00], [57.90, 18.50], [55.50, 15.00], [54.14, 13.62]]},
    {"name": "Yamal-Europe",       "substance": "gas", "coords": [[57.05, 34.96], [55.40, 30.00], [53.90, 27.56], [52.40, 21.00], [52.34, 14.55]]},
    {"name": "Druzhba",            "substance": "oil", "coords": [[53.20, 50.15], [52.60, 41.00], [52.10, 31.00], [50.45, 30.52], [48.75, 19.15]]},
    {"name": "Power of Siberia",   "substance": "gas", "coords": [[60.10, 121.00], [56.30, 124.70], [53.75, 127.50], [50.28, 127.53]]},
    {"name": "Trans-Alaska",       "substance": "oil", "coords": [[70.25, -148.52], [66.56, -150.68], [64.84, -147.72], [61.13, -146.35], [61.13, -146.35]]},
    {"name": "Keystone",           "substance": "oil", "coords": [[51.62, -111.10], [49.00, -101.00], [45.00, -97.50], [39.05, -96.30], [35.98, -96.77]]},
    {"name": "Trans Mountain",     "substance": "oil", "coords": [[53.55, -113.50], [52.20, -118.00], [50.67, -120.34], [49.25, -122.95]]},
    {"name": "BTC (Baku-Ceyhan)",  "substance": "oil", "coords": [[40.38, 49.85], [41.00, 45.00], [40.20, 42.00], [38.20, 38.00], [36.87, 35.93]]},
    {"name": "West-East Gas",      "substance": "gas", "coords": [[44.30, 84.90], [40.00, 95.00], [37.50, 106.00], [34.30, 113.00], [31.23, 121.47]]},
    {"name": "Maghreb-Europe Gas", "substance": "gas", "coords": [[35.20, -1.00], [35.20, -3.00], [35.90, -5.35], [37.00, -6.00], [40.42, -3.70]]},
    {"name": "TransMed",           "substance": "gas", "coords": [[33.90, 10.10], [37.10, 11.00], [38.10, 13.36], [41.90, 12.50]]},
    {"name": "Trans-Alaska South", "substance": "oil", "coords": [[61.13, -146.35], [61.00, -146.20]]},
]

SUBSTANCE_COLOR = {"gas": "#f59e0b", "oil": "#8b1a1a", "product": "#c084fc", "other": "#6b7280"}

# ── Bundled open datasets ───────────────────────────────────────────────────
# Built offline from Global Energy Monitor (GEM) GeoJSON trackers and NGA's
# World Port Index. See scripts note in the feature memory for how to refresh.
_DATA = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")


def _load_bundle(fname: str, key: str):
    try:
        with open(os.path.join(_DATA, fname)) as f:
            return json.load(f).get(key, [])
    except Exception as e:
        _log.warning("bundle %s load failed: %s", fname, e)
        return []


_GEM_PIPES = _load_bundle("gem_pipelines.json", "pipelines")   # [{n,f,g:[[[lat,lon]..]..],bb:[s,w,n,e]}]
_GEM_LNG = _load_bundle("gem_lng.json", "lng")                  # [{n,la,lo,st,ie,cap}]
_WPI = _load_bundle("world_ports.json", "ports")               # [{n,la,lo,c,s}]
_GEM_FAC = _load_bundle("gem_facilities.json", "facilities")   # [{n,la,lo,k,x}] fields/plants/coal terminals
_NETL_FAC = _load_bundle("netl_facilities.json", "facilities") # NETL refineries + processing plants
_ALL_FAC = _GEM_FAC + _NETL_FAC
_EMODNET = _load_bundle("emodnet.json", "features")            # EU offshore pipelines/platforms/windfarms

# World Bank Container Port Performance Index (2023) — port efficiency rank.
try:
    with open(os.path.join(_DATA, "cppi.json")) as _f:
        _cppi_b = json.load(_f)
except Exception:
    _cppi_b = {"ranks": {}, "total": 0}
_CPPI_TOTAL = _cppi_b.get("total", 405)


def _norm_port(n: str) -> str:
    n = re.sub(r"\(.*?\)", "", n or "").upper()
    return re.sub(r"[^A-Z0-9]+", " ", n).strip()


_CPPI_NORM = {_norm_port(k): v for k, v in _cppi_b.get("ranks", {}).items()}


def _cppi_rank(name: str):
    return _CPPI_NORM.get(_norm_port(name))


# Tag curated terminals with their CPPI rank once at load.
for _p in PORTS:
    _r = _cppi_rank(_p["name"])
    if _r:
        _p["cppi"] = _r

# GEM LNG Carrier Tracker → hard-classify gas carriers by IMO/name (AIS type
# codes can't distinguish LNG from crude tankers).
try:
    with open(os.path.join(_DATA, "lng_carriers.json")) as _f:
        _lng_b = json.load(_f)
except Exception:
    _lng_b = {"imos": [], "names": []}
_LNG_IMOS = set(_lng_b.get("imos", []))
_LNG_NAMES = set(_lng_b.get("names", []))


def _parse_bbox(bbox: str):
    s, w, n, e = [float(x) for x in bbox.split(",")]
    return s, w, n, e


def _bbox_hit(bb, s, w, n, e) -> bool:
    """bb=[minlat,minlon,maxlat,maxlon] intersects the query box s,w,n,e."""
    return not (bb[2] < s or bb[0] > n or bb[3] < w or bb[1] > e)


def _gem_pipes_bbox(s, w, n, e, cap=2000) -> list:
    out = []
    for p in _GEM_PIPES:
        if not _bbox_hit(p["bb"], s, w, n, e):
            continue
        for seg in p["g"]:
            out.append({"name": p["n"], "substance": p["f"], "coords": seg})
            if len(out) >= cap:
                return out
    return out


def _gem_pipes_overview(cap=1200) -> list:
    """Longest-span pipelines first, capped by output polyline count so the
    zoomed-out world view stays light (features are multi-segment)."""
    top = sorted(_GEM_PIPES, key=lambda p: (p["bb"][2] - p["bb"][0]) + (p["bb"][3] - p["bb"][1]), reverse=True)
    out = []
    for p in top:
        for seg in p["g"]:
            out.append({"name": p["n"], "substance": p["f"], "coords": seg})
            if len(out) >= cap:
                return out
    return out


# ── EIA / HIFLD US pipelines (ArcGIS FeatureServer) — gas + crude oil ────────
_EIA_HOST = "https://geo.dot.gov/server/rest/services/Hosted"
_EIA_LAYERS = [("Natural_Gas_Pipelines_US_EIA", "gas"), ("Crude_Oil_Pipelines_US_EIA", "oil")]


def fetch_eia_pipelines(s, w, n, e) -> list:
    ck = f"eia:{round(s,2)},{round(w,2)},{round(n,2)},{round(e,2)}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    out = []
    for layer, substance in _EIA_LAYERS:
        params = {
            "where": "1=1", "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
            "inSR": "4326", "spatialRel": "esriSpatialRelIntersects", "outFields": "*",
            "outSR": "4326", "f": "geojson", "resultRecordCount": "2000",
        }
        try:
            r = requests.get(f"{_EIA_HOST}/{layer}/FeatureServer/0/query", params=params,
                             timeout=30, headers={"User-Agent": "AlphatapeTerminal/1.0"})
            r.raise_for_status()
            feats = r.json().get("features", [])
        except Exception as ex:
            _log.warning("EIA %s fetch failed: %s", layer, ex)
            continue
        for f in feats:
            g = f.get("geometry") or {}
            if g.get("type") != "LineString":
                continue
            coords = [[c[1], c[0]] for c in g["coordinates"] if len(c) >= 2]
            if len(coords) < 2:
                continue
            pr = f.get("properties") or {}
            out.append({"name": pr.get("opername") or pr.get("operator") or pr.get("pipename") or "EIA pipeline",
                        "substance": substance, "coords": coords})
    disk_set(ck, out, ttl=86400)
    return out


def _substance_of(tags: dict) -> str:
    raw = (tags.get("substance") or tags.get("type") or tags.get("content") or "").lower()
    if any(k in raw for k in ("gas", "cng", "lng", "methane")):
        return "gas"
    if any(k in raw for k in ("oil", "crude", "petroleum")):
        return "oil"
    if any(k in raw for k in ("fuel", "product", "diesel", "gasoline", "naphtha")):
        return "product"
    return "other"


# ── Live pipelines via Overpass (OpenStreetMap) ─────────────────────────────
_OVERPASS = "https://overpass-api.de/api/interpreter"


def fetch_overpass_pipelines(south: float, west: float, north: float, east: float) -> list:
    """Query OSM for pipeline ways within a bbox. Returns polyline dicts.
    Wrapped so a timeout/rate-limit never breaks the endpoint."""
    q = (
        f"[out:json][timeout:25];"
        f'way["man_made"="pipeline"]({south},{west},{north},{east});'
        f"out geom tags;"
    )
    try:
        r = requests.post(_OVERPASS, data={"data": q}, timeout=30,
                          headers={"User-Agent": "AlphatapeTerminal/1.0"})
        r.raise_for_status()
        elements = r.json().get("elements", [])
    except Exception as e:
        _log.warning("overpass fetch failed: %s", e)
        return []
    out = []
    for el in elements:
        geom = el.get("geometry") or []
        if len(geom) < 2:
            continue
        out.append({
            "name": (el.get("tags") or {}).get("name") or "OSM pipeline",
            "substance": _substance_of(el.get("tags") or {}),
            "coords": [[g["lat"], g["lon"]] for g in geom],
        })
    return out


def fetch_overpass_ports(south: float, west: float, north: float, east: float) -> list:
    """Query OSM for harbours/ports within a bbox (free global port coordinates).
    `out center` collapses ways/relations to a single point."""
    q = (
        f"[out:json][timeout:25];"
        f"("
        f'node["harbour"="yes"]({south},{west},{north},{east});'
        f'way["harbour"="yes"]({south},{west},{north},{east});'
        f'node["seamark:type"="harbour"]({south},{west},{north},{east});'
        f'way["industrial"="port"]({south},{west},{north},{east});'
        f'node["man_made"="offshore_platform"]({south},{west},{north},{east});'
        f'way["man_made"="offshore_platform"]({south},{west},{north},{east});'
        f");"
        f"out center tags 160;"
    )
    try:
        r = requests.post(_OVERPASS, data={"data": q}, timeout=30,
                          headers={"User-Agent": "AlphatapeTerminal/1.0"})
        r.raise_for_status()
        elements = r.json().get("elements", [])
    except Exception as e:
        _log.warning("overpass ports fetch failed: %s", e)
        return []
    out, seen = [], set()
    for el in elements:
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lon = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lon is None:
            continue
        name = (el.get("tags") or {}).get("name")
        key = name or f"{round(lat, 3)},{round(lon, 3)}"
        if key in seen:
            continue
        seen.add(key)
        tags = el.get("tags") or {}
        kind = "platform" if tags.get("man_made") == "offshore_platform" else "osm"
        out.append({"name": name or ("Offshore platform" if kind == "platform" else "OSM port"),
                    "lat": lat, "lon": lon, "kind": kind})
    return out


def get_ports(bbox: str | None) -> dict:
    """Curated export terminals always; live OSM commercial ports when a bbox is
    passed (cached 24h per bbox)."""
    base = {"ports": PORTS, "osm_ports": [], "source": "curated"}
    if not bbox:
        return base
    ck = f"osmports:{bbox}"
    cached = disk_get(ck)
    if cached is not None:
        return {"ports": PORTS, "osm_ports": cached, "source": "curated+osm"}
    try:
        s, w, n, e = [float(x) for x in bbox.split(",")]
    except Exception:
        return base
    osm = fetch_overpass_ports(s, w, n, e)
    disk_set(ck, osm, ttl=86400)
    return {"ports": PORTS, "osm_ports": osm, "source": "curated+osm"}


def get_pipelines(bbox: str | None, source: str = "gem") -> dict:
    """Pipeline polylines by source:
    - gem  (default): verified GEM tracks, viewport-filtered; world view shows the
      longest lines. Falls back to the coarse bundle only if GEM failed to load.
    - osm: live OpenStreetMap detail via Overpass (bbox, cached 24h).
    - eia: US natural-gas network via the EIA/HIFLD ArcGIS service (bbox, cached).
    """
    colors = SUBSTANCE_COLOR
    if source == "osm":
        if not bbox:
            return {"pipelines": [], "colors": colors, "source": "osm"}
        ck = f"pipelines:osm:{bbox}"
        cached = disk_get(ck)
        if cached is not None:
            return cached
        try:
            s, w, n, e = _parse_bbox(bbox)
        except Exception:
            return {"pipelines": [], "colors": colors, "source": "osm"}
        out = {"pipelines": fetch_overpass_pipelines(s, w, n, e), "colors": colors, "source": "osm"}
        disk_set(ck, out, ttl=86400)
        return out
    if source == "eia":
        if not bbox:
            return {"pipelines": [], "colors": colors, "source": "eia"}
        try:
            s, w, n, e = _parse_bbox(bbox)
        except Exception:
            return {"pipelines": [], "colors": colors, "source": "eia"}
        return {"pipelines": fetch_eia_pipelines(s, w, n, e), "colors": colors, "source": "eia"}
    # default: GEM
    if not _GEM_PIPES:
        return {"pipelines": PIPELINES, "colors": colors, "source": "fallback"}
    if not bbox:
        return {"pipelines": _gem_pipes_overview(), "colors": colors, "source": "gem-overview"}
    try:
        s, w, n, e = _parse_bbox(bbox)
    except Exception:
        return {"pipelines": _gem_pipes_overview(), "colors": colors, "source": "gem-overview"}
    return {"pipelines": _gem_pipes_bbox(s, w, n, e), "colors": colors, "source": "gem"}


# ── HELCOM Baltic shipping (ArcGIS MapServer) ───────────────────────────────
_HELCOM_URL = "https://maps.helcom.fi/arcgis/rest/services/MADS/Shipping/MapServer/0/query"
_HELCOM_DIR = os.path.join(_DATA, "cache", "helcom")


def fetch_helcom(bbox: str | None) -> dict:
    """HELCOM 'AIS passage line crossings by ship type' (Baltic) as polylines,
    weighted by total crossings. Cached in disk_cache and mirrored to a raw
    GeoJSON file under data/cache/helcom/."""
    ck = f"helcom:{bbox or 'all'}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    params = {"where": "1=1", "outFields": "*", "f": "geojson", "outSR": "4326", "resultRecordCount": 4000}
    if bbox:
        try:
            s, w, n, e = _parse_bbox(bbox)
            params.update({"geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
                           "inSR": "4326", "spatialRel": "esriSpatialRelIntersects"})
        except Exception:
            pass
    try:
        r = requests.get(_HELCOM_URL, params=params, timeout=35, headers={"User-Agent": "AlphatapeTerminal/1.0"})
        r.raise_for_status()
        gj = r.json()
    except Exception as ex:
        _log.warning("HELCOM fetch failed: %s", ex)
        return {"features": [], "count": 0}
    feats = []
    for f in gj.get("features", []):
        g = f.get("geometry") or {}
        t = g.get("type")
        if t not in ("LineString", "MultiLineString"):
            continue
        pr = f.get("properties") or {}
        crossings = sum(v for k, v in pr.items()
                        if isinstance(v, (int, float)) and k not in ("OBJECTID", "Id", "Shape_STLe"))
        segs = [g["coordinates"]] if t == "LineString" else g["coordinates"]
        for seg in segs:
            coords = [[c[1], c[0]] for c in seg if len(c) >= 2]
            if len(coords) >= 2:
                feats.append({"coords": coords, "location": pr.get("Location"), "crossings": round(crossings)})
    out = {"features": feats, "count": len(feats)}
    try:
        os.makedirs(_HELCOM_DIR, exist_ok=True)
        with open(os.path.join(_HELCOM_DIR, "layer0.geojson"), "w") as fh:
            json.dump(gj, fh)
    except Exception:
        pass
    disk_set(ck, out, ttl=86400)
    return out


def get_lng(bbox: str | None) -> dict:
    """GEM LNG terminals (points). Small enough to serve globally; bbox optional."""
    items = _GEM_LNG
    if bbox:
        try:
            s, w, n, e = _parse_bbox(bbox)
            items = [t for t in _GEM_LNG if s <= t["la"] <= n and w <= t["lo"] <= e]
        except Exception:
            pass
    return {"lng": items, "count": len(items)}


def get_world_ports(bbox: str | None) -> dict:
    """NGA World Port Index. World view returns only Large harbours; a bbox
    returns every port in view (capped)."""
    if not bbox:
        big = [p for p in _WPI if p.get("s") == "Large"]
        return {"ports": big, "count": len(big), "scope": "large"}
    try:
        s, w, n, e = _parse_bbox(bbox)
        inb = []
        for p in _WPI:
            if s <= p["la"] <= n and w <= p["lo"] <= e:
                r = _cppi_rank(p["n"])
                inb.append({**p, "cppi": r} if r else p)
    except Exception:
        inb = []
    return {"ports": inb[:2500], "count": len(inb), "scope": "bbox", "cppi_total": _CPPI_TOTAL}


def get_facilities(bbox: str | None) -> dict:
    """GEM fields/plants/coal terminals + NETL refineries/processing plants. The
    power-plant set is large, so the world view drops it; a bbox returns all."""
    if not bbox:
        light = [f for f in _ALL_FAC if f.get("k") != "plant"]
        return {"facilities": light, "count": len(light), "scope": "no-plants"}
    try:
        s, w, n, e = _parse_bbox(bbox)
        inb = [f for f in _ALL_FAC if s <= f["la"] <= n and w <= f["lo"] <= e]
    except Exception:
        inb = []
    return {"facilities": inb[:4000], "count": len(inb), "scope": "bbox"}


# ── EMODnet Human Activities (EU offshore) ──────────────────────────────────
# Bundled snapshot from the EMODnet WFS (pipelines/platforms/windfarms). WFS
# fetch-all was too slow on the request path; refresh the bundle offline.
def fetch_emodnet(bbox: str | None) -> dict:
    """EU offshore pipelines, platforms, and wind farms, filtered to the view."""
    items = _EMODNET
    if bbox:
        try:
            s, w, n, e = _parse_bbox(bbox)
            def inb(it):
                if "coords" in it:
                    return any(s <= p[0] <= n and w <= p[1] <= e for p in it["coords"])
                return s <= it.get("la", 999) <= n and w <= it.get("lo", 999) <= e
            items = [it for it in items if inb(it)]
        except Exception:
            pass
    return {"features": items, "count": len(items)}


# ── Live AIS vessel stream (aisstream.io WebSocket) ─────────────────────────
# aisstream bounding boxes are [[lat1, lon1], [lat2, lon2]] corner pairs.
_AIS_BBOXES = [
    [[-5.0, 95.0], [8.0, 105.0]],     # Malacca
    [[27.0, 32.0], [33.0, 34.5]],     # Suez / Red Sea north
    [[10.0, 42.0], [16.0, 45.0]],     # Bab el-Mandeb
    [[7.0, -81.0], [10.5, -78.0]],    # Panama
    [[24.0, 54.0], [28.0, 58.0]],     # Hormuz
    [[50.0, -6.0], [54.0, 2.0]],      # English Channel / Dover
    [[53.0, 3.0], [58.0, 14.0]],      # North Sea / Danish straits
    [[24.0, -98.0], [30.0, -88.0]],   # US Gulf
    [[35.0, 25.0], [41.0, 30.0]],     # Aegean / Turkish straits
    [[31.0, 120.0], [38.0, 127.0]],   # Yellow Sea / Korea approaches
    # Container-port anchorages (for the Logistics Map's cargo-ship layer). Moderate
    # set — the 1GB VM has OOM'd before, so these are the busiest hubs only.
    [[33.4, -118.6], [34.2, -117.8]], # Los Angeles / Long Beach
    [[29.8, 121.0], [31.7, 123.0]],   # Shanghai / Ningbo-Zhoushan
    [[51.6, 3.0], [52.4, 4.8]],       # Rotterdam / Antwerp approaches
    [[34.5, 128.5], [35.6, 129.6]],   # Busan
    [[40.3, -74.5], [40.9, -73.7]],   # New York / New Jersey
]

_VESSEL_TTL = 600          # drop vessels not seen in 10 min
_REG_TTL = 30 * 86400      # remember a vessel's static profile for 30 days
_REG_PREFIX = "ais:static:"
_vessels: dict[str, dict] = {}
# Persistent MMSI -> static profile (category/name/destination/ship_type). Built
# from the live ShipStaticData messages and reloaded on start, so a vessel is
# classified from the first position report instead of waiting ~6 min for its
# next static broadcast.
_static_reg: dict[str, dict] = {}
_lock = threading.Lock()
_stop = threading.Event()
_ws_thread: threading.Thread | None = None
_ws_app = None
_status = {"connected": False, "key_present": bool(os.getenv("AISSTREAM_API_KEY")), "error": None, "registry": 0}


def _load_registry():
    """Warm the in-memory ship registry from disk (survives restarts)."""
    if _dc is None:
        return
    try:
        rows = _dc._conn().execute(
            "SELECT key, value FROM cache WHERE key LIKE ? AND expires_at > ?",
            (_REG_PREFIX + "%", time.time()),
        ).fetchall()
    except Exception as e:
        _log.warning("registry load failed: %s", e)
        return
    for key, value in rows:
        try:
            _static_reg[key[len(_REG_PREFIX):]] = json.loads(value)
        except Exception:
            continue
    _status["registry"] = len(_static_reg)
    _log.info("AIS ship registry loaded: %d vessels", len(_static_reg))


def _classify(ship_type, name: str, imo=None) -> str:
    """Best-effort vessel category. AIS type codes can't tell LNG from crude
    tankers (both 80-89), so we first match the GEM LNG Carrier registry by IMO
    or name, then fall back to a name heuristic, then the AIS type code."""
    if imo is not None:
        try:
            if str(int(imo)) in _LNG_IMOS:
                return "lng"
        except (TypeError, ValueError):
            pass
    nm = (name or "").upper()
    if nm and nm in _LNG_NAMES:
        return "lng"
    if any(k in nm for k in ("LNG", "LPG", " GAS")):
        return "lng"
    try:
        t = int(ship_type)
    except (TypeError, ValueError):
        return "other"
    if 80 <= t <= 89:
        return "tanker"
    if 70 <= t <= 79:
        return "cargo"
    return "other"


def _upsert(mmsi: str, **fields):
    with _lock:
        v = _vessels.get(mmsi, {"mmsi": mmsi})
        v.update({k: val for k, val in fields.items() if val is not None})
        v["ts"] = time.time()
        _vessels[mmsi] = v


# ── Chokepoint geofencing → live transit nowcast ────────────────────────────
_ENERGY_CATS = ("tanker", "lng")
# Per-chokepoint capture radius (km). Tight enough that a crossing means the vessel
# was genuinely in the strait, not just passing within tens of km. Narrow
# canals/straits get a small radius; wide passages a larger one. AIS Class-A
# vessels underway report every 2-10s, so even 12km is crossed by many pings.
_CHOKE_RADIUS_KM = {
    "hormuz": 30, "malacca": 35, "suez": 18, "bab": 22, "panama": 14,
    "bosphorus": 12, "danish": 18, "goodhope": 40, "gibraltar": 14, "taiwan": 45,
}
_DEFAULT_RADIUS_KM = 25.0
_MIN_TRANSIT_SOG = 2.0     # kn — a transit is a moving vessel; filter anchored/waiting ships


def _haversine_km(lat1, lon1, lat2, lon2) -> float:
    from math import radians, sin, cos, asin, sqrt
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return 2 * 6371.0 * asin(sqrt(a))


def _nearest_choke(lat, lon) -> "str | None":
    """Chokepoint id whose (per-chokepoint) capture radius contains (lat, lon), else
    None. Cheap lat/lon gates keep this ~free on the position hot path."""
    if lat is None or lon is None:
        return None
    for c in CHOKEPOINTS:
        if abs(lat - c["lat"]) > 0.6:
            continue
        dlon = abs(lon - c["lon"])
        if dlon > 180:
            dlon = 360 - dlon
        if dlon > 0.9:
            continue
        if _haversine_km(lat, lon, c["lat"], c["lon"]) <= _CHOKE_RADIUS_KM.get(c["id"], _DEFAULT_RADIUS_KM):
            return c["id"]
    return None


def _check_crossing(mmsi: str, lat, lon) -> None:
    """Log one transit when an energy vessel enters a chokepoint radius
    (outside->inside edge). Debounced via the vessel's stored in_choke state.
    Category and hull dims fall back to the persistent static registry, so a vessel
    is counted even before its next ShipStaticData broadcast."""
    if lat is None or lon is None:
        return                                # a coord-less ping must not reset in_choke (double-count guard)
    cur = _nearest_choke(lat, lon)
    with _lock:
        v = _vessels.get(mmsi)
        if v is None:
            return
        reg = _static_reg.get(mmsi) or {}
        cat = v.get("category") or reg.get("category")
        prev = v.get("in_choke")
        v["in_choke"] = cur
        draught = v.get("draught") or reg.get("draught")
        loa = v.get("loa") or reg.get("loa")
        beam = v.get("beam") or reg.get("beam")
        sog = v.get("sog")
    # A transit is a moving vessel; a known near-stationary SOG means anchored/waiting.
    moving = sog is None or sog >= _MIN_TRANSIT_SOG
    if cur and cur != prev and cat in _ENERGY_CATS and moving:   # new entry by a moving tanker/LNG carrier
        energy_nowcaster.record_transit(mmsi, cur, cat, draught, loa, beam)


def _on_message(_ws, raw):
    try:
        msg = json.loads(raw)
    except Exception:
        return
    mtype = msg.get("MessageType")
    meta = msg.get("MetaData") or {}
    mmsi = str(meta.get("MMSI") or "")
    if not mmsi:
        return
    name = (meta.get("ShipName") or "").strip() or None
    if mtype == "PositionReport":
        pr = (msg.get("Message") or {}).get("PositionReport") or {}
        lat = pr.get("Latitude") or meta.get("latitude")
        lon = pr.get("Longitude") or meta.get("longitude")
        _upsert(
            mmsi, name=name, lat=lat, lon=lon,
            sog=pr.get("Sog"), cog=pr.get("Cog"),
            heading=pr.get("TrueHeading"),
            time_utc=meta.get("time_utc"),
        )
        _check_crossing(mmsi, lat, lon)
    elif mtype == "ShipStaticData":
        sd = (msg.get("Message") or {}).get("ShipStaticData") or {}
        nm = name or (sd.get("Name") or "").strip() or None
        imo = sd.get("ImoNumber")
        cat = _classify(sd.get("Type"), nm, imo)
        dest = (sd.get("Destination") or "").strip() or None
        # Draught + hull dimensions feed the nowcaster's capacity proxy. Dimension
        # is A/B/C/D metres from the AIS reference point: LOA = A+B, beam = C+D.
        draught = sd.get("MaximumStaticDraught") or None
        dim = sd.get("Dimension") or {}
        loa = ((dim.get("A") or 0) + (dim.get("B") or 0)) or None
        beam = ((dim.get("C") or 0) + (dim.get("D") or 0)) or None
        _upsert(mmsi, name=nm, ship_type=sd.get("Type"), category=cat, destination=dest, imo=imo,
                draught=draught, loa=loa, beam=beam)
        _remember(mmsi, {"category": cat, "name": nm, "destination": dest, "ship_type": sd.get("Type"),
                         "imo": imo, "draught": draught, "loa": loa, "beam": beam})


def _remember(mmsi: str, profile: dict):
    """Persist a vessel's static profile, skipping unchanged rows to avoid churn."""
    with _lock:
        prev = _static_reg.get(mmsi)
        _static_reg[mmsi] = profile
        _status["registry"] = len(_static_reg)
    if prev and prev.get("category") == profile.get("category") and prev.get("destination") == profile.get("destination"):
        return
    disk_set(_REG_PREFIX + mmsi, profile, ttl=_REG_TTL)


def _on_open(ws):
    key = os.getenv("AISSTREAM_API_KEY")
    sub = {
        "APIKey": key,
        "BoundingBoxes": _AIS_BBOXES,
        "FilterMessageTypes": ["PositionReport", "ShipStaticData"],
    }
    ws.send(json.dumps(sub))
    _status["connected"] = True
    _log.info("AIS stream connected")


def _on_error(_ws, err):
    _status["connected"] = False
    _status["error"] = str(err)
    _log.warning("AIS stream error: %s", err)


def _on_close(_ws, *_a):
    _status["connected"] = False


def _run_ws():
    try:
        import websocket   # websocket-client
    except ImportError:
        _status["error"] = "websocket-client not installed"
        _log.error("websocket-client missing; AIS stream disabled")
        return
    global _ws_app
    while not _stop.is_set():
        try:
            _ws_app = websocket.WebSocketApp(
                "wss://stream.aisstream.io/v0/stream",
                on_open=_on_open, on_message=_on_message,
                on_error=_on_error, on_close=_on_close,
            )
            _ws_app.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:
            _log.warning("AIS run_forever crashed: %s", e)
        if not _stop.is_set():
            time.sleep(5)   # backoff before reconnect


def start_ais_stream():
    """Spawn the AIS worker thread if an API key is configured."""
    global _ws_thread
    _status["key_present"] = bool(os.getenv("AISSTREAM_API_KEY"))
    if not _status["key_present"]:
        _log.info("AISSTREAM_API_KEY not set — vessel stream disabled")
        return
    if _ws_thread and _ws_thread.is_alive():
        return
    _load_registry()
    _stop.clear()
    _ws_thread = threading.Thread(target=_run_ws, name="ais-stream", daemon=True)
    _ws_thread.start()


def stop_ais_stream():
    _stop.set()
    if _ws_app is not None:
        try:
            _ws_app.close()
        except Exception:
            pass


# ── VesselAPI REST fallback (api.vesselapi.com bounding-box endpoint) ────────
# Strictly a fallback: the free tier has a tiny monthly quota, so we only poll
# when the AIS WebSocket is down, on a long interval, over a couple of small
# (<=4 deg span) boxes. Enabled by VESSELAPI_KEY.
_REST_BASE = os.getenv("VESSELAPI_BASE", "https://api.vesselapi.com").rstrip("/")
_REST_INTERVAL = 300
_REST_BOXES = [
    (25.5, 55.5, 27.5, 57.0),   # Hormuz  (latBottom, lonLeft, latTop, lonRight)
    (1.0, 103.0, 3.0, 105.0),   # Singapore / Malacca east
]
_rest_thread: threading.Thread | None = None


def _poll_vesselapi_box(box, headers) -> int:
    latB, lonL, latT, lonR = box
    r = requests.get(
        f"{_REST_BASE}/v1/location/vessels/bounding-box",
        params={"filter.lonLeft": lonL, "filter.lonRight": lonR,
                "filter.latBottom": latB, "filter.latTop": latT, "pagination.limit": 50},
        headers=headers, timeout=20,
    )
    r.raise_for_status()
    n = 0
    for it in r.json().get("vessels", []):
        mmsi = str(it.get("mmsi") or "")
        la, lo = it.get("latitude"), it.get("longitude")
        if not mmsi or la is None or lo is None:
            continue
        nm = it.get("vessel_name")
        _upsert(mmsi, name=nm, lat=la, lon=lo, sog=it.get("sog"), cog=it.get("cog"),
                heading=it.get("heading"), category=_classify(None, nm))
        _check_crossing(mmsi, la, lo)
        n += 1
    return n


def _run_rest_poll():
    key = os.getenv("VESSELAPI_KEY")
    if not key:
        return
    headers = {"Authorization": f"Bearer {key}", "User-Agent": "AlphatapeTerminal/1.0"}
    while not _stop.is_set():
        if not _status.get("connected"):          # fallback only — spare the quota while AIS is healthy
            try:
                got = sum(_poll_vesselapi_box(b, headers) for b in _REST_BOXES)
                _status["rest_active"] = True
                _log.info("VesselAPI fallback pulled %d vessels", got)
            except Exception as e:
                _log.warning("VesselAPI poll failed: %s", e)
        _stop.wait(_REST_INTERVAL)


def start_rest_poll():
    """Start the REST fallback poller if VESSELAPI_KEY is configured."""
    global _rest_thread
    _status["rest"] = bool(os.getenv("VESSELAPI_KEY"))
    if not _status["rest"]:
        return
    if _rest_thread and _rest_thread.is_alive():
        return
    _rest_thread = threading.Thread(target=_run_rest_poll, name="vesselapi-poll", daemon=True)
    _rest_thread.start()


def _snapshot() -> list:
    cutoff = time.time() - _VESSEL_TTL
    with _lock:
        stale = [m for m, v in _vessels.items() if v.get("ts", 0) < cutoff]
        for m in stale:
            _vessels.pop(m, None)
        return [
            v for v in _vessels.values()
            if v.get("lat") is not None and v.get("lon") is not None
        ]


# ── AIS position history (24h ring buffer for the replay scrubber) ──────────
# Frames are kept as compact JSON strings, not Python object trees: 145 frames
# of 300 nested lists as objects cost tens of MB resident and helped OOM-kill
# the 512MB prod VM; as strings the buffer is ~2MB.
_HIST_INTERVAL = 600          # sample every 10 min → 145 frames/24h
_HIST_MAX_FRAMES = 145
_HIST_MAX_VESSELS = 300       # per-frame cap keeps the payload ~1 MB
_hist_frames: list[tuple[int, str]] = []   # (epoch, json-encoded vessel rows)
_hist_lock = threading.Lock()
_hist_thread = None

_CAT_CODE = {"tanker": "t", "lng": "l", "cargo": "c"}


def _sample_history():
    vessels = _snapshot()
    if not vessels:
        return
    if len(vessels) > _HIST_MAX_VESSELS:
        step = len(vessels) / _HIST_MAX_VESSELS
        vessels = [vessels[int(i * step)] for i in range(_HIST_MAX_VESSELS)]
    rows = [
        [v["mmsi"], round(v["lat"], 3), round(v["lon"], 3),
         int(v["heading"]) if v.get("heading") not in (None, 511) else int(v.get("cog") or 0),
         _CAT_CODE.get(v.get("category"), "o")]
        for v in vessels
    ]
    entry = (int(time.time()), json.dumps(rows, separators=(",", ":")))
    with _hist_lock:
        _hist_frames.append(entry)
        del _hist_frames[:-_HIST_MAX_FRAMES]
        disk_set("ais_hist_frames", _hist_frames, ttl=2 * 86400)


def _run_history_sampler():
    while not _stop.is_set():
        try:
            _sample_history()
        except Exception as e:
            _log.warning("AIS history sample failed: %s", e)
        _stop.wait(_HIST_INTERVAL)


def start_history_sampler():
    """Record vessel positions every 10 min so the replay scrubber has data."""
    global _hist_thread
    if _hist_thread and _hist_thread.is_alive():
        return
    restored = disk_get("ais_hist_frames")
    if restored:
        with _hist_lock:
            # JSON round-trip turns tuples into lists; older deploys stored
            # dict frames — keep only entries in the (t, json_str) shape.
            _hist_frames.extend(
                (e[0], e[1]) for e in restored[-_HIST_MAX_FRAMES:]
                if isinstance(e, (list, tuple)) and len(e) == 2 and isinstance(e[1], str)
            )
    _hist_thread = threading.Thread(target=_run_history_sampler, name="ais-history", daemon=True)
    _hist_thread.start()


# ── IMF PortWatch: daily chokepoint transit history ─────────────────────────
# AIS-derived daily transit calls + deadweight capacity per chokepoint,
# published by the IMF (~4 day lag, history back to 2019). Free ArcGIS feed.
_PW_BASE = "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services"

# Our chokepoint id → a keyword that uniquely matches the PortWatch portname,
# so the portid mapping survives PortWatch renames like Bosporus/Bosphorus.
_PW_KEYWORDS = {
    "hormuz": "hormuz", "malacca": "malacca", "suez": "suez", "bab": "mandeb",
    "panama": "panama", "bosphorus": "bospor", "danish": "oresund",
    "goodhope": "good hope", "gibraltar": "gibraltar", "taiwan": "taiwan",
}


def _portwatch_ids() -> dict:
    cached = disk_get("pw_choke_ids")
    if cached:
        return cached
    r = requests.get(
        f"{_PW_BASE}/PortWatch_chokepoints_database/FeatureServer/0/query",
        params={"where": "1=1", "outFields": "portid,portname",
                "returnGeometry": "false", "f": "json"},
        timeout=20,
    )
    r.raise_for_status()
    rows = [f["attributes"] for f in r.json().get("features", [])]
    out = {}
    for ours, kw in _PW_KEYWORDS.items():
        hit = next((x for x in rows if kw in (x.get("portname") or "").lower()), None)
        if hit:
            out[ours] = {"portid": hit["portid"], "portname": hit["portname"]}
    if out:
        disk_set("pw_choke_ids", out, ttl=7 * 86400)
    return out


def _pw_date(v) -> str:
    if isinstance(v, (int, float)):
        return time.strftime("%Y-%m-%d", time.gmtime(v / 1000))
    return str(v)[:10]


def _pw_history(portid: str, days: int) -> list:
    since = (datetime.now(timezone.utc) - timedelta(days=days + 6)).strftime("%Y-%m-%d")
    r = requests.get(
        f"{_PW_BASE}/Daily_Chokepoints_Data/FeatureServer/0/query",
        params={
            "where": f"portid='{portid}' AND date >= DATE '{since}'",
            "outFields": "date,n_tanker,n_cargo,n_total,capacity",
            "orderByFields": "date ASC", "returnGeometry": "false",
            "resultRecordCount": 2000, "f": "json",
        },
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    if "error" in body:
        raise RuntimeError(body["error"].get("message", "PortWatch query error"))
    return [
        {"d": _pw_date(a["date"]), "tanker": a.get("n_tanker"), "cargo": a.get("n_cargo"),
         "total": a.get("n_total"), "cap": a.get("capacity")}
        for a in (f["attributes"] for f in body.get("features", []))
        if a.get("date") is not None
    ]


# ── Endpoints ───────────────────────────────────────────────────────────────
@router.get("/chokepoints")
def chokepoints():
    return {"chokepoints": CHOKEPOINTS}


@router.get("/chokepoint-history")
def chokepoint_history(
    ids: str = Query("hormuz", description="comma-separated chokepoint ids (see /chokepoints)"),
    days: int = Query(90, ge=14, le=730),
):
    """Daily transit calls and vessel capacity per chokepoint, IMF PortWatch."""
    want = list(dict.fromkeys(s.strip() for s in ids.split(",") if s.strip()))[:6]
    key = f"pw_hist_{days}_{'_'.join(sorted(want))}"
    cached = disk_get(key)
    if cached:
        _attach_history_nowcast(cached["series"])     # bridge the gap to today, fresh
        return cached
    mapping = _portwatch_ids()
    resolvable = [
        (cid, mapping[cid], meta) for cid in want
        if cid in mapping and (meta := next((c for c in CHOKEPOINTS if c["id"] == cid), None))
    ]

    def fetch(item):
        cid, m, meta = item
        try:
            return {"id": cid, "name": meta["name"], "points": _pw_history(m["portid"], days)}
        except Exception as e:
            _log.warning("PortWatch history failed for %s: %s", cid, e)
            return None

    with ThreadPoolExecutor(max_workers=len(resolvable) or 1) as ex:
        series = [s for s in ex.map(fetch, resolvable) if s]
    out = {"series": series, "days": days, "source": "IMF PortWatch"}
    # Only cache complete responses so one transient PortWatch failure
    # doesn't pin a missing series for the whole TTL.
    if series and len(series) == len(resolvable):
        disk_set(key, out, ttl=3600)                 # cache the baseline BEFORE the live tail
    _attach_history_nowcast(out["series"])
    return out


def _attach_history_nowcast(series: list) -> None:
    """Attach the trailing live-AIS crossing counts (last PortWatch day → today) to
    each history series so the frontend can draw a dashed estimate tail. Raw daily
    counts only — the frontend anchors them to the plotted PortWatch level."""
    if not series:
        return
    daily = energy_nowcaster.daily_counts([s["id"] for s in series])
    today = datetime.now(timezone.utc).date()
    for s in series:
        pts = s.get("points") or []
        if not pts:
            continue
        try:
            last = date.fromisoformat(pts[-1]["d"])
        except (ValueError, KeyError, TypeError):
            continue
        gap, d = [], last + timedelta(days=1)
        while d <= today:
            gap.append(d.isoformat())
            d += timedelta(days=1)
        if not gap:
            continue
        counts = daily.get(s["id"], {})
        gap_counts = {g: counts.get(g, 0) for g in gap}
        # No live crossings over the gap means the AIS feed is dark for this
        # chokepoint (no coverage), not that traffic fell to zero. Skip the
        # estimate so the chart never draws a flat carry-forward that reads as a
        # confirmed level. A real signal (>=1 crossing) re-enables the tail.
        if sum(gap_counts.values()) <= 0:
            continue
        s["nowcast_days"] = gap
        s["nowcast_daily"] = gap_counts


# Approximate global seaborne crude+products trade, Mb/d (EIA/UNCTAD scale).
# Denominator for the inspector's "share of seaborne oil" figure.
_SEABORNE_OIL_MBD = 78.0


@router.get("/chokepoint-stats")
def chokepoint_stats():
    """Per-chokepoint transit stats for the cockpit strip, inspector and
    alert widgets: 7d avg calls + delta vs prior 7d, 30d daily series,
    latest tanker/cargo mix, 2-sigma anomaly flag. IMF PortWatch, cached 1h."""
    cached = disk_get("pw_choke_stats")
    if cached:
        _attach_nowcast(cached["stats"])          # merge fresh live layer over the 6h baseline
        cached["nowcast_meta"] = _NOWCAST_META
        return cached
    mapping = _portwatch_ids()

    def build(meta):
        m = mapping.get(meta["id"])
        if not m:
            return None
        try:
            pts = _pw_history(m["portid"], 44)
        except Exception as e:
            _log.warning("PortWatch stats failed for %s: %s", meta["id"], e)
            return None
        rows = [p for p in pts if p["total"] is not None]
        if len(rows) < 21:
            return None
        totals = [p["total"] for p in rows]
        last7, prev7 = totals[-7:], totals[-14:-7]
        avg7 = sum(last7) / 7
        prev_avg = sum(prev7) / 7
        delta = ((avg7 - prev_avg) / prev_avg * 100) if prev_avg else None
        s30 = totals[-30:]
        mean30 = sum(s30) / len(s30)
        sd30 = (sum((x - mean30) ** 2 for x in s30) / len(s30)) ** 0.5
        anomaly = "high" if sd30 and avg7 > mean30 + 2 * sd30 else \
                  "low" if sd30 and avg7 < mean30 - 2 * sd30 else None
        status = "congested" if (delta is not None and delta <= -5) or anomaly == "low" else \
                 "watch" if anomaly == "high" or (delta is not None and delta >= 8) else "normal"
        latest = rows[-1]
        caps = [p["cap"] for p in rows[-7:] if p["cap"] is not None]
        # Tanker-only baseline: the live AIS nowcast counts energy vessels
        # (tanker+LNG) only, so its delta must compare against PortWatch tankers,
        # not n_total — otherwise the delta is structurally negative and useless.
        tanks = [p["tanker"] for p in rows[-7:] if p["tanker"] is not None]
        tanker_avg7 = sum(tanks) / len(tanks) if tanks else None
        return {
            "id": meta["id"], "name": meta["name"], "oil_mbd": meta["oil_mbd"],
            "share_pct": round(meta["oil_mbd"] / _SEABORNE_OIL_MBD * 100),
            "avg7": round(avg7, 1), "delta_pct": round(delta, 1) if delta is not None else None,
            "tanker_avg7": round(tanker_avg7, 1) if tanker_avg7 else None,
            "transits7": sum(last7), "series30": s30,
            "mix": {"tanker": latest["tanker"], "cargo": latest["cargo"], "total": latest["total"]},
            "cap7": round(sum(caps) / len(caps)) if caps else None,
            "anomaly": anomaly, "status": status, "as_of": latest["d"],
        }

    with ThreadPoolExecutor(max_workers=len(CHOKEPOINTS)) as ex:
        stats = [s for s in ex.map(build, CHOKEPOINTS) if s]
    out = {"stats": stats, "source": "IMF PortWatch"}
    if len(stats) == len([c for c in CHOKEPOINTS if c["id"] in mapping]):
        # PortWatch publishes a new day at most ~once/24h; a 1h TTL surfaces that
        # new day within the hour instead of up to 6h late. Shorter buys nothing
        # (source unchanged) and only hammers the free ArcGIS feed.
        disk_set("pw_choke_stats", out, ttl=3600)       # cache the baseline BEFORE the live merge
    _attach_nowcast(out["stats"])
    out["nowcast_meta"] = _NOWCAST_META
    return out


# ── Live AIS nowcast reconciliation ─────────────────────────────────────────
_NOWCAST_META = {
    "window_h": 96,
    "source": "aisstream+vesselapi",
    "method": "live tanker/LNG chokepoint crossings; capacity is a draught x hull-dim "
              "displacement proxy (estimate), not manifest DWT",
}


def _ais_covered_chokes() -> set:
    """Chokepoint ids that fall inside at least one live AIS bounding box; the rest
    get confidence 'none' since the stream never sees them."""
    covered = set()
    for c in CHOKEPOINTS:
        for (lat1, lon1), (lat2, lon2) in _AIS_BBOXES:
            if min(lat1, lat2) <= c["lat"] <= max(lat1, lat2) and \
               min(lon1, lon2) <= c["lon"] <= max(lon1, lon2):
                covered.add(c["id"])
                break
    return covered


def _live_energy_activity() -> dict:
    """Distinct energy vessels currently within each chokepoint radius — the live
    signal that lifts nowcast confidence to high."""
    counts: dict = {}
    for v in _snapshot():
        if v.get("category") not in _ENERGY_CATS:
            continue
        cid = _nearest_choke(v.get("lat"), v.get("lon"))
        if cid:
            counts[cid] = counts.get(cid, 0) + 1
    return counts


def _attach_nowcast(stats: list) -> dict:
    """Merge the fresh 96h nowcast onto PortWatch stat rows (additive: existing
    fields untouched) and return the standalone nowcast dict. The baseline is
    PortWatch's tanker calls/day (tanker_avg7), matching the energy-only live
    count so live_vs_baseline_pct is a like-for-like delta, not an artifact."""
    ids = [c["id"] for c in CHOKEPOINTS]
    baseline = {s["id"]: s["tanker_avg7"] for s in stats if s.get("tanker_avg7")}
    nc = energy_nowcaster.nowcast(
        baseline, ids, _ais_covered_chokes(),
        bool(_status.get("connected")), _live_energy_activity(),
    )
    for s in stats:
        s["nowcast"] = nc.get(s["id"])
    return nc


@router.get("/energy-nowcast")
def energy_nowcast():
    """Standalone live AIS nowcast per chokepoint (trailing 96h), for direct polling
    without the PortWatch baseline payload."""
    ids = [c["id"] for c in CHOKEPOINTS]
    blob = disk_get("pw_choke_stats") or {}
    baseline = {s["id"]: s["tanker_avg7"] for s in blob.get("stats", []) if s.get("tanker_avg7")}
    nc = energy_nowcaster.nowcast(
        baseline, ids, _ais_covered_chokes(),
        bool(_status.get("connected")), _live_energy_activity(),
    )
    return {"nowcast": nc, "nowcast_meta": _NOWCAST_META}


@router.get("/ports")
def ports(bbox: str | None = Query(None, description="south,west,north,east for live OSM commercial ports")):
    return get_ports(bbox)


@router.get("/pipelines")
def pipelines(
    bbox: str | None = Query(None, description="south,west,north,east"),
    source: str = Query("gem", description="gem | osm | eia"),
):
    return get_pipelines(bbox, source)


@router.get("/lng")
def lng(bbox: str | None = Query(None, description="south,west,north,east")):
    return get_lng(bbox)


@router.get("/world-ports")
def world_ports(bbox: str | None = Query(None, description="south,west,north,east; omit for large harbours only")):
    return get_world_ports(bbox)


@router.get("/helcom")
def helcom(bbox: str | None = Query(None, description="south,west,north,east for the Baltic view")):
    return fetch_helcom(bbox)


@router.get("/facilities")
def facilities(bbox: str | None = Query(None, description="south,west,north,east; omit for fields+terminals only")):
    return get_facilities(bbox)


@router.get("/emodnet")
def emodnet(bbox: str | None = Query(None, description="south,west,north,east")):
    return fetch_emodnet(bbox)


@router.get("/vessel-history")
def vessel_history(hours: int = Query(24, ge=1, le=24)):
    """Sampled AIS position frames for the replay scrubber. Categories are
    coded t/l/c/o (tanker, LNG, cargo, other); each vessel row is
    [mmsi, lat, lon, heading, cat]."""
    cutoff = time.time() - hours * 3600
    with _hist_lock:
        recent = [e for e in _hist_frames if e[0] >= cutoff]
    frames = [{"t": t, "v": json.loads(j)} for t, j in recent]
    return {"frames": frames, "interval_s": _HIST_INTERVAL, "count": len(frames)}


@router.get("/vessels")
def vessels(classified_only: bool = Query(False, description="drop vessels whose type is still unknown")):
    """Current in-memory AIS snapshot, enriched from the persistent ship
    registry so most vessels carry a type from the first position report.
    status.key_present=false means no AISSTREAM_API_KEY is configured."""
    v = _snapshot()
    for x in v:
        reg = _static_reg.get(x["mmsi"])
        if reg:
            if not x.get("category") or x["category"] == "other":
                x["category"] = reg.get("category") or x.get("category")
            x.setdefault("destination", reg.get("destination"))
            x.setdefault("name", reg.get("name"))
        imo = x.get("imo") or (reg or {}).get("imo")
        if not x.get("category") or x["category"] == "other":
            x["category"] = _classify(x.get("ship_type"), x.get("name"), imo)
    if classified_only:
        v = [x for x in v if x.get("category") and x["category"] != "other"]
    status = dict(_status)
    try:
        import maritime_kystverket
        status["kystverket"] = maritime_kystverket.status()
    except Exception:
        pass
    return {"vessels": v, "count": len(v), "status": status}


# ── Chokepoint → equity exposure ─────────────────────────────────────────────
# Which listed names move when a chokepoint is disrupted. Curated, not derived:
# a hand-built map is honest and auditable, and there is no free feed that scores
# single-name chokepoint sensitivity. `dir` is the tendency when the chokepoint
# is DISRUPTED (transits drop / rerouting): +1 benefits (tanker day-rates, crude,
# defense), -1 pressured (feedstock/logistics cost, Asia-trade names).
_EXP_GROUPS = {
    "tanker":   "Tankers",
    "oil":      "Oil majors & E&P",
    "refiner":  "Refiners",
    "lng":      "LNG",
    "defense":  "Defense",
    "semi":     "Semiconductors",
    "liner":    "Container liners",
}
# Reusable exposure baskets, referenced per chokepoint below.
_TANKERS = [("FRO", 1), ("STNG", 1), ("INSW", 1), ("DHT", 1), ("ASC", 1)]
_OILMAJ  = [("XOM", 1), ("CVX", 1), ("COP", 1), ("OXY", 1)]
_REFINE  = [("VLO", -1), ("MPC", -1), ("PSX", -1)]
_DEFENSE = [("LMT", 1), ("RTX", 1), ("NOC", 1)]
_LNG     = [("LNG", 1)]
_SEMI    = [("TSM", -1), ("NVDA", -1), ("AVGO", -1)]
_LINER   = [("ZIM", 1)]

# chokepoint id → { group: [(ticker, dir), ...] }
CHOKEPOINT_EXPOSURE: dict[str, dict[str, list]] = {
    "hormuz":    {"tanker": _TANKERS, "oil": _OILMAJ, "defense": _DEFENSE, "refiner": _REFINE},
    "malacca":   {"tanker": _TANKERS, "oil": _OILMAJ, "lng": _LNG, "semi": _SEMI},
    "suez":      {"tanker": _TANKERS, "liner": _LINER, "refiner": _REFINE},
    "bab":       {"tanker": _TANKERS, "liner": _LINER, "defense": _DEFENSE, "refiner": _REFINE},
    "panama":    {"liner": _LINER, "lng": _LNG},
    "bosphorus": {"tanker": _TANKERS, "oil": _OILMAJ},
    "danish":    {"tanker": _TANKERS, "oil": _OILMAJ},
    "goodhope":  {"tanker": _TANKERS, "liner": _LINER},
    "gibraltar": {"tanker": _TANKERS, "refiner": _REFINE},
    "taiwan":    {"semi": _SEMI, "defense": _DEFENSE, "liner": _LINER},
}
_EXP_NOTE = {
    "tanker": "day-rates rise on rerouting and longer ton-miles",
    "oil": "crude tightens when Gulf supply is at risk",
    "refiner": "feedstock cost and logistics risk rise",
    "lng": "cargoes reroute and prices tighten",
    "defense": "geopolitical tension lifts order expectations",
    "semi": "Asia trade and fab logistics at risk",
    "liner": "box rates spike on rerouting and blank sailings",
}


# Live-nowcast contribution to disruption. Only trusted tiers count; a noise
# floor absorbs the residual AIS-undercount bias (we see fewer tankers than
# PortWatch even in normal conditions), and the excess is scaled + capped so the
# noisier live layer can freshen the score without ever dominating PortWatch.
_NOWCAST_W = {"high": 1.0, "medium": 0.5}
_LIVE_DROP_FLOOR = 15.0   # ignore live drops shallower than this (% below tanker baseline)
_LIVE_SCALE = 0.2         # excess-% → disruption points
_LIVE_CAP = 12.0          # max points the live layer may add


def _choke_disruption(stat: dict) -> float:
    """Non-negative disruption magnitude from a chokepoint-stats row. Congestion
    (transits dropping vs the prior week) is the disruptive signal; a rising
    count is not. Scaled so a flat/normal chokepoint contributes 0.

    PortWatch (delta/status/anomaly) is the stable base; a trusted live-AIS drop
    off the tanker baseline adds a fresh component so a today disruption surfaces
    before PortWatch publishes it (its feed lags ~4-7d)."""
    d = stat.get("delta_pct")
    base = max(0.0, -(d or 0.0))                      # % transit drop wk/wk
    if stat.get("status") == "congested":
        base += 5.0
    if stat.get("anomaly") == "low":
        base += 3.0

    nc = stat.get("nowcast") or {}
    w = _NOWCAST_W.get(nc.get("confidence"), 0.0)
    live = nc.get("live_vs_baseline_pct")
    if w and live is not None and -live > _LIVE_DROP_FLOOR:
        base += min((-live - _LIVE_DROP_FLOOR) * _LIVE_SCALE * w, _LIVE_CAP)

    return round(base, 1)


@router.get("/exposure")
def chokepoint_exposure():
    """Live chokepoint stress mapped to the listed names it tends to move.

    Joins the curated CHOKEPOINT_EXPOSURE map to /chokepoint-stats (IMF
    PortWatch + AIS nowcast) and enriches each name with a live daily quote.
    `leaders` ranks names by net exposure to today's disruption so a name sitting
    behind several stressed chokepoints floats up. When no chokepoint is under
    stress every disruption is 0 and leaders fall back to exposure breadth."""
    from cache import get_download

    stats = {s["id"]: s for s in chokepoint_stats().get("stats", [])}

    # Collect every unique ticker for one batched quote download.
    syms = sorted({t for groups in CHOKEPOINT_EXPOSURE.values()
                   for basket in groups.values() for t, _ in basket})
    import datetime as _dt
    end = (_dt.date.today() + _dt.timedelta(days=1)).isoformat()
    start = (_dt.date.today() - _dt.timedelta(days=20)).isoformat()
    quote: dict[str, dict] = {}
    try:
        df = get_download(tuple(syms), start, end, "1d")
        closes = df.get("Close") if not df.empty else None
        if closes is not None:
            for sym in syms:
                try:
                    s = closes[sym].dropna() if sym in closes else None
                    if s is None or len(s) < 2:
                        continue
                    price, prev = float(s.iloc[-1]), float(s.iloc[-2])
                    quote[sym] = {
                        "price": round(price, 2),
                        "change_pct": round((price / prev - 1) * 100, 2) if prev else None,
                        "spark": [round(float(v), 2) for v in s.tail(10)],
                    }
                except Exception:
                    continue
    except Exception:
        pass

    # Per-ticker aggregate score across every chokepoint it sits behind.
    agg: dict[str, dict] = {}
    choke_cards = []
    for meta in CHOKEPOINTS:
        cid = meta["id"]
        groups = CHOKEPOINT_EXPOSURE.get(cid)
        stat = stats.get(cid)
        if not groups:
            continue
        disruption = _choke_disruption(stat) if stat else 0.0
        exposures = []
        for gkey, basket in groups.items():
            for tkr, direction in basket:
                exposures.append({
                    "ticker": tkr, "group": _EXP_GROUPS[gkey], "group_key": gkey,
                    "direction": direction, "note": _EXP_NOTE[gkey],
                    **quote.get(tkr, {"price": None, "change_pct": None, "spark": []}),
                })
                a = agg.setdefault(tkr, {
                    "ticker": tkr, "group": _EXP_GROUPS[gkey], "group_key": gkey,
                    "direction": direction, "score": 0.0, "chokepoints": [], "drivers": [],
                    **quote.get(tkr, {"price": None, "change_pct": None, "spark": []}),
                })
                a["score"] += disruption * direction
                a["chokepoints"].append(meta["name"])
                a["drivers"].append({
                    "strait": meta["name"], "status": (stat or {}).get("status") or "normal",
                    "direction": direction, "contribution": round(disruption * direction, 1),
                })
        choke_cards.append({
            "id": cid, "name": meta["name"], "oil_mbd": meta["oil_mbd"],
            "status": (stat or {}).get("status"), "delta_pct": (stat or {}).get("delta_pct"),
            "share_pct": (stat or {}).get("share_pct"), "disruption": round(disruption, 1),
            "series30": (stat or {}).get("series30") or [],
            "exposures": exposures,
        })

    for a in agg.values():
        a["score"] = round(a["score"], 1)
        a["links"] = len(a["chokepoints"])
        a["drivers"].sort(key=lambda d: abs(d["contribution"]), reverse=True)
    # Rank: active disruption first (|score| desc), breadth as the calm-market
    # tiebreak so the board is never empty.
    leaders = sorted(agg.values(), key=lambda x: (abs(x["score"]), x["links"]), reverse=True)
    # Stressed chokepoints float to the top of the card list.
    choke_cards.sort(key=lambda c: c["disruption"], reverse=True)

    return {
        "chokepoints": choke_cards,
        "leaders": leaders,
        "any_stress": any(c["disruption"] > 0 for c in choke_cards),
        "priced": len(quote),
        "source": "curated exposure map + IMF PortWatch + yfinance",
    }
