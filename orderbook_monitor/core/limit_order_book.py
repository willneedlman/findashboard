from sortedcontainers import SortedDict
from .price_level import PriceLevel


class LimitOrderBook:
    def __init__(self):
        # Bids: negated keys so SortedDict iteration is highest-first
        self._bids: SortedDict = SortedDict()   # key: -price
        self._asks: SortedDict = SortedDict()   # key: +price

    def update(self, side: str, price: float, size: float, order_id: str = "") -> None:
        book = self._bids if side == "B" else self._asks
        key = -price if side == "B" else price

        if size == 0.0:
            book.pop(key, None)
            return

        if key not in book:
            book[key] = PriceLevel(price=price)

        level = book[key]
        if order_id:
            level.add(order_id, size)
        else:
            level.size = size

        if level.is_empty:
            del book[key]

    def best_bid(self) -> float | None:
        if not self._bids:
            return None
        return self._bids.peekitem(0)[1].price

    def best_ask(self) -> float | None:
        if not self._asks:
            return None
        return self._asks.peekitem(0)[1].price

    def mid_price(self) -> float | None:
        bid, ask = self.best_bid(), self.best_ask()
        if bid is None or ask is None:
            return None
        return (bid + ask) / 2.0

    def get_top_n_levels(self, n: int = 5) -> dict:
        bids = [
            (level.price, level.size)
            for _, level in list(self._bids.items())[:n]
        ]
        asks = [
            (level.price, level.size)
            for _, level in list(self._asks.items())[:n]
        ]
        return {"bids": bids, "asks": asks}

    def get_imbalance(self, depth: int = 5) -> float | None:
        snap = self.get_top_n_levels(depth)
        bid_vol = sum(s for _, s in snap["bids"])
        ask_vol = sum(s for _, s in snap["asks"])
        total = bid_vol + ask_vol
        if total == 0:
            return None
        return (bid_vol - ask_vol) / total
