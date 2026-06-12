import csv
import io
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel
from sortedcontainers import SortedDict

from .users import _require_admin

router = APIRouter()


# ── Minimal LOB implementation (no file I/O, runs in-process) ─────────────────

class _Level:
    __slots__ = ('price', 'size')
    def __init__(self, price: float, size: float):
        self.price = price
        self.size  = size

class _LOB:
    def __init__(self):
        self._bids: SortedDict = SortedDict()   # key: -price
        self._asks: SortedDict = SortedDict()   # key: +price

    def update(self, side: str, price: float, size: float) -> None:
        book = self._bids if side == 'B' else self._asks
        key  = -price    if side == 'B' else price
        if size == 0.0:
            book.pop(key, None)
        else:
            book[key] = _Level(price, size)

    def best_bid(self):
        return self._bids.peekitem(0)[1].price if self._bids else None

    def best_ask(self):
        return self._asks.peekitem(0)[1].price if self._asks else None

    def mid(self):
        b, a = self.best_bid(), self.best_ask()
        return round((b + a) / 2, 6) if b and a else None

    def imbalance(self, depth=5):
        bv = sum(v.size for _, v in list(self._bids.items())[:depth])
        av = sum(v.size for _, v in list(self._asks.items())[:depth])
        return round((bv - av) / (bv + av), 4) if (bv + av) else None

    def top_n(self, n=5):
        bids = [(v.price, v.size) for _, v in list(self._bids.items())[:n]]
        asks = [(v.price, v.size) for _, v in list(self._asks.items())[:n]]
        return bids, asks


# ── Schema ────────────────────────────────────────────────────────────────────

class LOBReplayRequest(BaseModel):
    csv_content:       str
    snapshot_interval: int = 50
    top_n:             int = 5


# ── Route ─────────────────────────────────────────────────────────────────────

@router.post("/replay")
def lob_replay(req: LOBReplayRequest, x_admin_secret: str = Header(default="")):
    _require_admin(x_admin_secret)

    if req.snapshot_interval < 1 or req.snapshot_interval > 10_000:
        raise HTTPException(400, "snapshot_interval must be 1–10000")
    if req.top_n < 1 or req.top_n > 20:
        raise HTTPException(400, "top_n must be 1–20")

    lob = _LOB()
    snapshots = []
    count = 0
    errors = 0

    reader = csv.DictReader(io.StringIO(req.csv_content.strip()))
    for row in reader:
        try:
            side  = row['side'].strip().upper()
            price = float(row['price'])
            size  = float(row['size'])
        except (KeyError, ValueError):
            errors += 1
            continue

        lob.update(side, price, size)
        count += 1

        if count % req.snapshot_interval == 0:
            bids, asks = lob.top_n(req.top_n)
            snapshots.append({
                'msg':       count,
                'mid':       lob.mid(),
                'imbalance': lob.imbalance(req.top_n),
                'bids':      bids,
                'asks':      asks,
            })

    # Final snapshot if not already captured
    if count > 0 and count % req.snapshot_interval != 0:
        bids, asks = lob.top_n(req.top_n)
        snapshots.append({
            'msg':       count,
            'mid':       lob.mid(),
            'imbalance': lob.imbalance(req.top_n),
            'bids':      bids,
            'asks':      asks,
        })

    return {
        'total_messages': count,
        'parse_errors':   errors,
        'snapshots':      snapshots,
    }
