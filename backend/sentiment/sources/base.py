"""Source-adapter substrate: the timed, validated ingestion boundary.

Every adapter returns a `FetchOutcome` carrying the validated articles plus the
operational telemetry the reliability layer needs (latency, attempted vs parsed
counts, success flag). Raw dicts are validated through `RawArticle` here — the
single zero-trust choke point — so malformed feed items are counted as parse
errors instead of leaking downstream.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable

from pydantic import ValidationError

from sentiment.config import SourceSpec
from sentiment.schemas import RawArticle


@dataclass
class FetchOutcome:
    key: str
    label: str
    articles: list[RawArticle]
    latency_ms: float
    attempted: int        # raw items returned by the source before validation
    parse_errors: int     # items rejected at the RawArticle boundary
    ok: bool              # the network fetch itself succeeded
    error: str | None = None

    @property
    def newest_ts(self) -> int | None:
        return max((a.published_at for a in self.articles), default=None)


def _coerce(raw_items: list[dict[str, Any]]) -> tuple[list[RawArticle], int]:
    """Validate + dedup raw dicts. Returns (articles, parse_error_count)."""
    out: list[RawArticle] = []
    errors = 0
    seen: set[str] = set()
    for d in raw_items:
        try:
            art = RawArticle.model_validate(d)
        except ValidationError:
            errors += 1
            continue
        key = art.title.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(art)
    return out, errors


def timed_fetch(spec: SourceSpec, raw_fn: Callable[[], list[dict[str, Any]]]) -> FetchOutcome:
    """Run a raw fetch, timing it and converting failures into telemetry."""
    start = time.perf_counter()
    ok = True
    error: str | None = None
    raw_items: list[dict[str, Any]] = []
    try:
        raw_items = raw_fn()
    except Exception as ex:  # network/parse failure -> ok=False, recorded for reliability
        ok = False
        error = str(ex)
    latency_ms = round((time.perf_counter() - start) * 1000, 1)
    articles, parse_errors = _coerce(raw_items)
    return FetchOutcome(
        key=spec.key, label=spec.label, articles=articles, latency_ms=latency_ms,
        attempted=len(raw_items), parse_errors=parse_errors, ok=ok, error=error,
    )
