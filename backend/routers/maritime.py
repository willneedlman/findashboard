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
import threading
import time

import requests
from fastapi import APIRouter, Query

import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
try:
    from disk_cache import disk_get, disk_set
except ImportError:                                   # pragma: no cover
    def disk_get(_k): return None
    def disk_set(_k, _v, ttl=0): pass

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


def get_pipelines(bbox: str | None) -> dict:
    """Bundled coarse tracks by default; live Overpass detail when a bbox is
    passed (cached 24h per bbox). GEM/OSM are the open sources; the bundle is
    the durable fallback so the layer always renders."""
    base = {"pipelines": PIPELINES, "colors": SUBSTANCE_COLOR, "source": "bundled"}
    if not bbox:
        return base
    ck = f"pipelines:{bbox}"
    cached = disk_get(ck)
    if cached is not None:
        return cached
    try:
        s, w, n, e = [float(x) for x in bbox.split(",")]
    except Exception:
        return base
    live = fetch_overpass_pipelines(s, w, n, e)
    if not live:
        return base
    out = {"pipelines": live, "colors": SUBSTANCE_COLOR, "source": "overpass"}
    disk_set(ck, out, ttl=86400)
    return out


# ── Live AIS vessel stream (aisstream.io WebSocket) ─────────────────────────
# aisstream bounding boxes are [[lat1, lon1], [lat2, lon2]] corner pairs.
_AIS_BBOXES = [
    [[-5.0, 95.0], [8.0, 105.0]],     # Malacca
    [[27.0, 32.0], [33.0, 34.5]],     # Suez / Red Sea north
    [[7.0, -81.0], [10.5, -78.0]],    # Panama
    [[24.0, 54.0], [28.0, 58.0]],     # Hormuz
]

_VESSEL_TTL = 600          # drop vessels not seen in 10 min
_vessels: dict[str, dict] = {}
_lock = threading.Lock()
_stop = threading.Event()
_ws_thread: threading.Thread | None = None
_ws_app = None
_status = {"connected": False, "key_present": bool(os.getenv("AISSTREAM_API_KEY")), "error": None}


def _classify(ship_type, name: str) -> str:
    """Best-effort vessel category from AIS ship-type code + name heuristics.
    AIS type codes cannot distinguish crude from LNG (both 80-89), so a name
    containing GAS/LNG promotes a tanker to the LNG bucket."""
    nm = (name or "").upper()
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
        _upsert(
            mmsi, name=name,
            lat=pr.get("Latitude") or meta.get("latitude"),
            lon=pr.get("Longitude") or meta.get("longitude"),
            sog=pr.get("Sog"), cog=pr.get("Cog"),
            heading=pr.get("TrueHeading"),
            time_utc=meta.get("time_utc"),
        )
    elif mtype == "ShipStaticData":
        sd = (msg.get("Message") or {}).get("ShipStaticData") or {}
        _upsert(
            mmsi, name=name or (sd.get("Name") or "").strip() or None,
            ship_type=sd.get("Type"),
            category=_classify(sd.get("Type"), name or sd.get("Name")),
            destination=(sd.get("Destination") or "").strip() or None,
        )


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


# ── Endpoints ───────────────────────────────────────────────────────────────
@router.get("/chokepoints")
def chokepoints():
    return {"chokepoints": CHOKEPOINTS}


@router.get("/ports")
def ports():
    return {"ports": PORTS}


@router.get("/pipelines")
def pipelines(bbox: str | None = Query(None, description="south,west,north,east for live OSM detail")):
    return get_pipelines(bbox)


@router.get("/vessels")
def vessels():
    """Current in-memory AIS snapshot. status.key_present=false means no
    AISSTREAM_API_KEY is configured, so the layer will be empty by design."""
    v = _snapshot()
    for x in v:
        x.setdefault("category", _classify(x.get("ship_type"), x.get("name")))
    return {"vessels": v, "count": len(v), "status": _status}
