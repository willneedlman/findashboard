import asyncio
import sys
from pathlib import Path

from .config import ReplayConfig
from .core.limit_order_book import LimitOrderBook
from .output.printer import print_snapshot
from .replay.replayer import Replayer


async def _run(cfg: ReplayConfig) -> None:
    lob = LimitOrderBook()

    async def on_snapshot(count: int, book: LimitOrderBook) -> None:
        print_snapshot(count, book, top_n=cfg.top_n_levels)

    replayer = Replayer(
        csv_path=cfg.csv_path,
        lob=lob,
        speed=cfg.speed_multiplier,
        snapshot_interval=cfg.snapshot_interval,
        on_snapshot=on_snapshot,
    )

    print(f"Replaying {cfg.csv_path} at {cfg.speed_multiplier}x speed…")
    print(f"Snapshot every {cfg.snapshot_interval} messages | top {cfg.top_n_levels} levels\n")

    await replayer.run()
    print("\nReplay complete.")


def main(csv_path: str | None = None) -> None:
    cfg = ReplayConfig()
    if csv_path:
        cfg.csv_path = csv_path
    elif len(sys.argv) > 1:
        cfg.csv_path = sys.argv[1]

    asyncio.run(_run(cfg))


if __name__ == "__main__":
    main()
