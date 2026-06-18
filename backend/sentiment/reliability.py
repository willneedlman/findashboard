"""Per-source operational reliability — a dynamic, persisted health score.

Each fetch updates EWMA telemetry (latency, parse-error rate, empty rate) and a
consecutive-failure counter for its source. `score()` collapses that state into a
deterministic reliability in [0, 1]; the source manager multiplies a source's
authority weight by it, so a degrading feed is automatically and transparently
down-weighted. State persists to JSON so reliability survives process restarts.

The score is dominated by the signals that actually indicate a broken feed
(hard fetch failures, parse errors, persistent emptiness); latency and staleness
only apply a gentle penalty once they cross a soft threshold, so a healthy source
sits at ~1.0 rather than being dinged for normal variance.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from dataclasses import asdict, dataclass
from pathlib import Path

from sentiment import config
from sentiment.schemas import SourceHealth
from sentiment.sources.base import FetchOutcome

_log = logging.getLogger(__name__)


@dataclass
class SourceState:
    ewma_latency_ms: float = 0.0
    parse_error_rate: float = 0.0
    empty_rate: float = 0.0
    consecutive_failures: int = 0
    last_staleness_h: float = 0.0
    samples: int = 0


def _reliability_score(st: SourceState) -> float:
    """Deterministic reliability in [0, 1] from a source's telemetry state.

    Hard fetch failures dominate multiplicatively (a source that never delivers
    cannot be "reliable" no matter how clean its non-existent payloads are); data
    quality and latency/staleness apply secondary penalties. A single failure is
    a gentle dip (x0.7); sustained failure decays past the downgrade floor.
    """
    fetch_mult = config.FETCH_DECAY ** st.consecutive_failures
    quality = 0.6 * (1.0 - st.parse_error_rate) + 0.4 * (1.0 - st.empty_rate)

    over_lat = max(0.0, st.ewma_latency_ms - config.LATENCY_SOFT_MS)
    latency_mult = max(0.6, 1.0 - over_lat / (4 * config.LATENCY_SOFT_MS))
    over_stale = max(0.0, st.last_staleness_h - config.STALENESS_SOFT_H)
    staleness_mult = max(0.6, 1.0 - over_stale / (4 * config.STALENESS_SOFT_H))

    return round(max(0.0, min(1.0, quality * fetch_mult * latency_mult * staleness_mult)), 4)


class Reliability:
    """Loads/holds/persists per-source telemetry and exposes the health view."""

    def __init__(self, path: str | None = None) -> None:
        raw = path if path is not None else os.getenv(
            config.RELIABILITY_PATH_ENV, config.RELIABILITY_DEFAULT_PATH)
        self._path = Path(raw)
        self._lock = threading.Lock()
        self._state: dict[str, SourceState] = self._load()

    def _load(self) -> dict[str, SourceState]:
        try:
            if self._path.exists():
                data = json.loads(self._path.read_text())
                return {k: SourceState(**v) for k, v in data.items()}
        except Exception as ex:
            _log.warning("Could not load reliability state: %s", ex)
        return {}

    def persist(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._lock:
                payload = {k: asdict(v) for k, v in self._state.items()}
            self._path.write_text(json.dumps(payload))
        except Exception as ex:
            _log.warning("Could not persist reliability state: %s", ex)

    def update(self, outcome: FetchOutcome, now: int) -> None:
        """Fold one fetch outcome into the source's EWMA telemetry."""
        a = config.EWMA_ALPHA
        with self._lock:
            st = self._state.setdefault(outcome.key, SourceState())
            sample_parse = (outcome.parse_errors / outcome.attempted) if outcome.attempted else 0.0
            sample_empty = 1.0 if (outcome.ok and not outcome.articles) else 0.0

            st.ewma_latency_ms = (
                outcome.latency_ms if st.samples == 0
                else a * outcome.latency_ms + (1 - a) * st.ewma_latency_ms
            )
            st.parse_error_rate = a * sample_parse + (1 - a) * st.parse_error_rate
            st.empty_rate = a * sample_empty + (1 - a) * st.empty_rate
            st.consecutive_failures = 0 if outcome.ok else st.consecutive_failures + 1
            if outcome.newest_ts is not None:
                st.last_staleness_h = max(0.0, (now - outcome.newest_ts) / 3600.0)
            st.samples += 1

    def score(self, key: str) -> float:
        with self._lock:
            st = self._state.get(key)
        return 1.0 if st is None else _reliability_score(st)

    def health(self, key: str, label: str, authority: float) -> SourceHealth:
        with self._lock:
            st = self._state.get(key) or SourceState()
        rel = _reliability_score(st)
        downgraded = rel < config.RELIABILITY_FLOOR
        return SourceHealth(
            label=label, key=key, reliability_score=rel,
            latency_ms=round(st.ewma_latency_ms, 1), staleness_h=round(st.last_staleness_h, 2),
            parse_error_rate=round(st.parse_error_rate, 3), empty_rate=round(st.empty_rate, 3),
            downgraded=downgraded, weight_effective=round(authority * rel, 3),
        )
