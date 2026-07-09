"""Admin-filed sentiment mis-score reports.

A durable JSON log the operator uses to flag a headline the engine scored wrong.
Each record keeps the full as-scored context plus the admin's corrected read, so
the fix (lexicon term, correction-overlay tune, horizon rule) is unambiguous when
the log is reviewed.
"""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

from sentiment import config

_FILE = Path(os.getenv("SENTIMENT_REPORTS_PATH",
                       str(Path(config.HISTORY_DEFAULT_PATH).parent / "sentiment_reports.json")))
_lock = threading.Lock()
_LIMIT = 500


def _load() -> list[dict]:
    try:
        if _FILE.exists():
            data = json.loads(_FILE.read_text())
            return data if isinstance(data, list) else []
    except Exception:  # noqa: BLE001
        pass
    return []


def _save(items: list[dict]) -> None:
    _FILE.parent.mkdir(parents=True, exist_ok=True)
    _FILE.write_text(json.dumps(items[-_LIMIT:], indent=2))


def add(payload: dict) -> dict:
    rec = {"id": uuid.uuid4().hex[:12], "reported_at": int(time.time()), **payload}
    with _lock:
        items = _load()
        items.append(rec)
        _save(items)
    return rec


def all_reports() -> list[dict]:
    with _lock:
        return list(reversed(_load()))   # newest first


def delete(rid: str) -> bool:
    with _lock:
        items = _load()
        kept = [i for i in items if i.get("id") != rid]
        _save(kept)
        return len(kept) != len(items)


def clear() -> int:
    with _lock:
        n = len(_load())
        _save([])
        return n
