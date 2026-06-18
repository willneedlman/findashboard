"""Source adapters behind one dispatcher, plus live market context."""
from __future__ import annotations

from sentiment.config import SourceSpec
from sentiment.sources import finnhub, reddit, rss
from sentiment.sources.base import FetchOutcome
from sentiment.sources.market_context import fetch_market_context


def fetch_source(spec: SourceSpec, limit: int) -> FetchOutcome:
    if spec.kind == "rss":
        return rss.fetch(spec, limit)
    if spec.kind == "reddit":
        return reddit.fetch(spec, limit)
    if spec.kind == "finnhub":
        return finnhub.fetch(spec, limit)
    raise ValueError(f"unknown source kind: {spec.kind!r}")


__all__ = ["fetch_source", "FetchOutcome", "fetch_market_context"]
