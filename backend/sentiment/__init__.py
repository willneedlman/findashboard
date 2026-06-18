"""Decoupled, deterministic market-sentiment engine.

Pipeline: ingest (sources) -> validate (schemas) -> qualify (source_manager)
-> score (lexicon, deterministic) -> enrich (enrich, optional LLM) -> aggregate
(aggregate, pure) -> assemble (engine). The composite score is reproducible from
raw text plus a reference timestamp; the LLM only adds non-scoring tags.

Import the public API directly from `sentiment.engine`
(`build_snapshot`, `history_payload`) to keep package import side-effect free.
"""
