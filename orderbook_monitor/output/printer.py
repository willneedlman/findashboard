from ..core.limit_order_book import LimitOrderBook


def print_snapshot(msg_count: int, lob: LimitOrderBook, top_n: int = 5) -> None:
    mid = lob.mid_price()
    snap = lob.get_top_n_levels(top_n)
    imbalance = lob.get_imbalance(top_n)

    mid_str = f"{mid:.4f}" if mid is not None else "N/A"
    imb_str = f"{imbalance:+.3f}" if imbalance is not None else "N/A"

    print(f"\n{'─' * 44}")
    print(f"  msg #{msg_count:>7}  │  mid {mid_str}  │  imb {imb_str}")
    print(f"{'─' * 44}")

    asks_display = list(reversed(snap["asks"]))   # print highest ask first
    for price, size in asks_display:
        bar = "█" * min(20, int(size / 10))
        print(f"  ASK  {price:>10.4f}   {size:>8.0f}  {bar}")

    print(f"  {'·' * 38}")

    for price, size in snap["bids"]:
        bar = "█" * min(20, int(size / 10))
        print(f"  BID  {price:>10.4f}   {size:>8.0f}  {bar}")
