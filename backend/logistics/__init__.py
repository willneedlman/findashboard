"""Geo-Logistics & Supply-Chain analytics — free-source ingestion for non-energy
macro logistics.

`free_ingest` is the consolidated ingestion layer (one function per source,
cleaned dict payloads, disk-cached with serve-stale-on-failure). It mirrors the
house conventions: sync + requests (not asyncio), a module logger, graceful
try/except that never raises into the router, and key-gated no-op where a
credential is required.
"""
