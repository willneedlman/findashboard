import asyncio
from pathlib import Path
from typing import Callable, Awaitable

from ..core.limit_order_book import LimitOrderBook
from ..feed.csv_reader import Event, read_events


OnSnapshotFn = Callable[[int, LimitOrderBook], Awaitable[None]]


class Replayer:
    def __init__(
        self,
        csv_path: str | Path,
        lob: LimitOrderBook,
        speed: float = 1.0,
        snapshot_interval: int = 100,
        on_snapshot: OnSnapshotFn | None = None,
    ):
        self.csv_path = csv_path
        self.lob = lob
        self.speed = speed
        self.snapshot_interval = snapshot_interval
        self.on_snapshot = on_snapshot

        self._paused = asyncio.Event()
        self._paused.set()          # not paused initially
        self._step_gate = asyncio.Event()
        self._stop = False
        self._count = 0

    # ── controls ──────────────────────────────────────────────────────────

    def pause(self) -> None:
        self._paused.clear()

    def resume(self) -> None:
        self._paused.set()

    def step(self) -> None:
        """Advance exactly one event while paused."""
        self._step_gate.set()

    def set_speed(self, multiplier: float) -> None:
        self.speed = max(0.01, multiplier)

    def stop(self) -> None:
        self._stop = True
        self._paused.set()      # unblock if paused so the loop can exit
        self._step_gate.set()

    # ── internals ─────────────────────────────────────────────────────────

    async def _wait_if_paused(self) -> bool:
        """Returns False if stop was requested."""
        if self._paused.is_set():
            return not self._stop

        # paused — block until resume() or step()
        self._step_gate.clear()
        done, _ = await asyncio.wait(
            [
                asyncio.create_task(self._paused.wait()),
                asyncio.create_task(self._step_gate.wait()),
            ],
            return_when=asyncio.FIRST_COMPLETED,
        )
        return not self._stop

    async def run(self) -> None:
        prev_ts = None

        for event in read_events(self.csv_path):
            if self._stop:
                break

            should_continue = await self._wait_if_paused()
            if not should_continue:
                break

            # Replay wall-clock gaps at requested speed
            if prev_ts is not None and self._paused.is_set():
                delta = (event.timestamp - prev_ts).total_seconds()
                if delta > 0:
                    await asyncio.sleep(delta / self.speed)

            prev_ts = event.timestamp
            self.lob.update(event.side, event.price, event.size, event.order_id)
            self._count += 1

            if self._count % self.snapshot_interval == 0 and self.on_snapshot:
                await self.on_snapshot(self._count, self.lob)

        # Final snapshot only if the last batch didn't already fire one
        if self.on_snapshot and self._count > 0 and self._count % self.snapshot_interval != 0:
            await self.on_snapshot(self._count, self.lob)
