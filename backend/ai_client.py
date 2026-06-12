"""Shared Groq utility used by ai.py and any router that needs LLM access.

Provides a singleton client (connection reuse), jittered exponential backoff for
transient 429/5xx errors, and a system/user message split so Groq can cache the
static instruction prefix across calls.
"""
import os, json, re, time, random, logging
from fastapi import HTTPException

logger = logging.getLogger(__name__)
_GROQ_KEY = os.getenv("GROQ_API_KEY", "")

# Model tiers. SMART = deep reasoning (100K TPD free); FAST = structured JSON (500K TPD).
MODEL_SMART = "llama-3.3-70b-versatile"
MODEL_FAST  = "llama-3.1-8b-instant"

_client = None


def get_client():
    """Lazy module-level singleton — avoids re-creating the client (and its HTTP
    connection pool) on every call."""
    global _client
    if not _GROQ_KEY:
        raise HTTPException(503, "GROQ_API_KEY not configured")
    if _client is None:
        from groq import Groq
        _client = Groq(api_key=_GROQ_KEY)
    return _client


def _is_retryable(exc: Exception) -> bool:
    # Never retry our own 503 (missing key) or other deliberate HTTP errors.
    if isinstance(exc, HTTPException):
        return False
    sc = getattr(exc, "status_code", None)
    if sc is not None:
        return sc == 429 or sc >= 500
    # Connection/timeout errors carry no status code but are worth retrying.
    return type(exc).__name__ in (
        "APIConnectionError", "APITimeoutError", "Timeout", "ConnectionError",
    )


def with_backoff(fn, *, retries: int = 3, base: float = 0.5, cap: float = 8.0):
    """Run fn(), retrying transient failures with jittered exponential backoff."""
    attempt = 0
    while True:
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — re-raised below if not retryable
            if attempt >= retries or not _is_retryable(exc):
                raise
            delay = min(cap, base * (2 ** attempt)) + random.uniform(0, base)
            logger.warning("Groq call failed (%s); retry %d/%d in %.2fs",
                           type(exc).__name__, attempt + 1, retries, delay)
            time.sleep(delay)
            attempt += 1


def groq_chat(messages: list[dict], *, model: str = MODEL_SMART,
              max_tokens: int = 512, temperature: float | None = None):
    """Low-level completion with retry. Returns the raw response object so callers
    can read finish_reason / usage. Prefer groq_complete() for simple text."""
    def _call():
        kwargs: dict = {"model": model, "max_tokens": max_tokens, "messages": messages}
        if temperature is not None:
            kwargs["temperature"] = temperature
        return get_client().chat.completions.create(**kwargs)
    return with_backoff(_call)


def groq_complete(prompt: str, max_tokens: int = 512, *,
                  model: str = MODEL_SMART, system: str | None = None) -> str:
    """Single-turn completion returning stripped text.

    Pass `system` for the static schema/instructions (cacheable prefix) and keep
    the dynamic data in `prompt`.
    """
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    resp = groq_chat(messages, model=model, max_tokens=max_tokens)
    return resp.choices[0].message.content.strip()


def parse_json(raw: str):
    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    raw = re.sub(r"\s*```$", "", raw)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r'[\[{].*[\]}]', raw, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except Exception:
                pass
        raise HTTPException(500, "AI returned malformed JSON")
