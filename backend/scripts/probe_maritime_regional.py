"""Lightweight probe for the regional maritime feeds.

    python backend/scripts/probe_maritime_regional.py

Verifies (1) the Kystverket TCP AIS stream decodes live vessels and (2) the
HELCOM ArcGIS layer returns line features. Network egress is required (raw TCP
for Kystverket) — run where outbound TCP is allowed (e.g. the Fly host), not the
sandboxed dev shell.
"""
import os
import socket
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def probe_kystverket(seconds: int = 15):
    from pyais import decode
    import maritime_kystverket as k
    print(f"[Kystverket] connecting {k.HOST}:{k.PORT} for {seconds}s...")
    positions, sample = 0, None
    try:
        s = socket.create_connection((k.HOST, k.PORT), timeout=10)
        s.settimeout(3)
        end, buf = time.time() + seconds, b""
        while time.time() < end:
            try:
                buf += s.recv(4096)
            except socket.timeout:
                continue
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                line = k._strip_tagblock(raw.decode("ascii", "replace").strip())
                if not line.startswith(("!AIVDM", "!BSVDM")) or line.split(",")[1] != "1":
                    continue
                try:
                    d = decode(line).asdict()
                except Exception:
                    continue
                if d.get("msg_type") in k._POS_TYPES and d.get("lat") is not None:
                    positions += 1
                    sample = sample or {kk: d.get(kk) for kk in ("mmsi", "lat", "lon", "speed", "course")}
        s.close()
    except Exception as e:
        print(f"[Kystverket] ERROR {type(e).__name__}: {e}")
        return False
    print(f"[Kystverket] decoded {positions} position reports; sample={sample}")
    return positions > 0


def probe_helcom():
    from routers import maritime
    print("[HELCOM] querying ArcGIS layer 0...")
    out = maritime.fetch_helcom(None)
    print(f"[HELCOM] {out['count']} line features (sample crossings="
          f"{out['features'][0]['crossings'] if out['features'] else 'n/a'})")
    return out["count"] > 0


if __name__ == "__main__":
    ok_k = probe_kystverket()
    ok_h = probe_helcom()
    print(f"\nRESULT  kystverket={'OK' if ok_k else 'FAIL'}  helcom={'OK' if ok_h else 'FAIL'}")
    sys.exit(0 if (ok_k and ok_h) else 1)
