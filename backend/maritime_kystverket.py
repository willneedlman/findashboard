"""Kystverket (Norwegian Coastal Administration) live AIS.

Decoupled TCP streaming consumer for the open feed at 153.44.253.27:5631 — raw
AIVDM/BSVDM NMEA (ships >45 m within 12 nm of the Norwegian coast, no auth). It
decodes with pyais and pushes into the shared vessel store through injected
callables, so this module never imports the aisstream/REST code and stays fully
decoupled from it.
"""
import logging
import os
import socket
import threading

_log = logging.getLogger("kystverket")

HOST = os.getenv("KYSTVERKET_HOST", "153.44.253.27")
PORT = int(os.getenv("KYSTVERKET_PORT", "5631"))

_stop = threading.Event()
_thread: threading.Thread | None = None
_status = {"connected": False, "messages": 0, "error": None}

_POS_TYPES = {1, 2, 3, 18, 19}
_STATIC_TYPES = {5, 24}


def _strip_tagblock(line: str) -> str:
    r"""Drop a leading NMEA 4.0 TAG block (\s:...,c:...*hh\) if present."""
    if line.startswith("\\"):
        end = line.find("\\", 1)
        if end != -1:
            return line[end + 1:]
    return line


def _apply(d: dict, upsert, classify, remember):
    mmsi = d.get("mmsi")
    if not mmsi:
        return
    mmsi = str(mmsi)
    t = d.get("msg_type")
    if t in _POS_TYPES:
        lat, lon = d.get("lat"), d.get("lon")
        if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
            return
        upsert(mmsi, lat=lat, lon=lon, sog=d.get("speed"), cog=d.get("course"),
               heading=d.get("heading"), source="kystverket")
    if t in _STATIC_TYPES:
        nm = (d.get("shipname") or "").strip() or None
        st = d.get("ship_type")
        imo = d.get("imo")
        dest = (d.get("destination") or "").strip() or None
        cat = classify(st, nm, imo)
        upsert(mmsi, name=nm, ship_type=st, category=cat, destination=dest, imo=imo, source="kystverket")
        remember(mmsi, {"category": cat, "name": nm, "destination": dest, "ship_type": st, "imo": imo})


def _handle_line(line: str, frag: dict, upsert, classify, remember):
    from pyais import decode
    s = _strip_tagblock(line.strip())
    if not (s.startswith("!AIVDM") or s.startswith("!BSVDM")):
        return
    _status["messages"] += 1
    parts = s.split(",")
    try:
        total, num = int(parts[1]), int(parts[2])
    except (IndexError, ValueError):
        return
    if total == 1:
        sentences = [s]
    else:
        key = f"{parts[3]}:{parts[4]}"           # sequence id + channel
        buf = frag.setdefault(key, {})
        buf[num] = s
        if len(buf) < total:
            if len(frag) > 500:                  # guard against unbounded fragment buildup
                frag.clear()
            return
        sentences = [buf[i] for i in sorted(buf)]
        frag.pop(key, None)
    try:
        _apply(decode(*sentences).asdict(), upsert, classify, remember)
    except Exception:
        pass                                     # malformed / unsupported sentence — skip


def _run(upsert, classify, remember):
    backoff = 1
    frag: dict = {}
    while not _stop.is_set():
        sock = None
        try:
            sock = socket.create_connection((HOST, PORT), timeout=15)
            sock.settimeout(20)
            _status.update(connected=True, error=None)
            _log.info("Kystverket AIS connected %s:%s", HOST, PORT)
            backoff = 1
            buf = b""
            while not _stop.is_set():
                chunk = sock.recv(4096)
                if not chunk:
                    raise ConnectionError("socket closed by peer")
                buf += chunk
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    _handle_line(raw.decode("ascii", "replace"), frag, upsert, classify, remember)
        except Exception as e:
            _status.update(connected=False, error=str(e))
            _log.warning("Kystverket stream error: %s (reconnect in %ss)", e, backoff)
        finally:
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass
        if _stop.is_set():
            break
        _stop.wait(backoff)
        backoff = min(backoff * 2, 60)           # exponential backoff, capped at 60s


def start_stream(upsert, classify, remember):
    """Spawn the Kystverket consumer thread (disable with KYSTVERKET_ENABLED=0)."""
    global _thread
    if os.getenv("KYSTVERKET_ENABLED", "1") != "1":
        _log.info("Kystverket disabled via env")
        return
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_run, args=(upsert, classify, remember), name="kystverket", daemon=True)
    _thread.start()


def stop_stream():
    _stop.set()


def status() -> dict:
    return _status
