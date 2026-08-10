"""Shared LLM utility used by ai.py and any router that needs LLM access.

Groq is the primary provider (free, fast). When Groq is rate-limited (429),
rejects an oversized request (413), or has a server/connection error, calls fall
over to Cerebras, which serves the same Llama models on a separate quota. Each
provider gets jittered exponential backoff for transient errors first; only a
sustained failure trips the fail-over. System/user messages stay split so the
static instruction prefix can be cached across calls.
"""
import os, json, re, time, random, logging
from fastapi import HTTPException

logger = logging.getLogger(__name__)
_GROQ_KEY = os.getenv("GROQ_API_KEY", "")
_CEREBRAS_KEY = os.getenv("CEREBRAS_API_KEY", "")
_ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# Vision model — none of the text providers above (Groq/Cerebras) have a
# vision-capable model in our tier, so image tasks (screenshot parsing) go to
# Claude instead, which reads dense tabular screenshots far more reliably.
VISION_MODEL = "claude-sonnet-5"

# Model tiers. SMART = deep reasoning (100K TPD free); FAST = structured JSON (500K TPD).
# The constants are the Groq model ids; each fallback provider maps them to its own.
MODEL_SMART = "llama-3.3-70b-versatile"
MODEL_FAST  = "llama-3.1-8b-instant"

# Cerebras fallback models (this account's available set; both run fast on its
# hardware). SMART maps to the 120B reasoner, FAST to the lighter GLM.
_CEREBRAS_MODELS = {
    MODEL_SMART: "gpt-oss-120b",
    MODEL_FAST:  "zai-glm-4.7",
}

_client = None
_cerebras_client = None


def get_client():
    """Lazy module-level singleton — avoids re-creating the client (and its HTTP
    connection pool) on every call."""
    global _client
    if not _GROQ_KEY:
        raise HTTPException(503, "GROQ_API_KEY not configured")
    if _client is None:
        from groq import Groq
        # max_retries=0: the vendor SDK retries before we ever see the error and
        # honours the provider's retry-after, which parked one report request for
        # 59 seconds of total silence — long enough for the proxy to drop the
        # connection and for the browser to give up on a call the server then
        # finished successfully. with_backoff owns retry policy (8s cap), and
        # groq_chat owns failover.
        _client = Groq(api_key=_GROQ_KEY, max_retries=0)
    return _client


def get_cerebras():
    global _cerebras_client
    if not _CEREBRAS_KEY:
        raise HTTPException(503, "CEREBRAS_API_KEY not configured")
    if _cerebras_client is None:
        from cerebras.cloud.sdk import Cerebras
        # See get_client(): our backoff and failover own retries, not the SDK's.
        _cerebras_client = Cerebras(api_key=_CEREBRAS_KEY, max_retries=0)
    return _cerebras_client


_anthropic_client = None


def get_anthropic():
    global _anthropic_client
    if not _ANTHROPIC_KEY:
        raise HTTPException(503, "ANTHROPIC_API_KEY not configured")
    if _anthropic_client is None:
        from anthropic import Anthropic
        _anthropic_client = Anthropic(api_key=_ANTHROPIC_KEY)
    return _anthropic_client


_CONN_ERRORS = ("APIConnectionError", "APITimeoutError", "Timeout", "ConnectionError")


def _is_retryable(exc: Exception) -> bool:
    # Never retry our own 503 (missing key) or other deliberate HTTP errors.
    if isinstance(exc, HTTPException):
        return False
    sc = getattr(exc, "status_code", None)
    if sc is not None:
        return sc == 429 or sc >= 500
    # Connection/timeout errors carry no status code but are worth retrying.
    return type(exc).__name__ in _CONN_ERRORS


def _should_failover(exc: Exception) -> bool:
    """Whether to abandon this provider and try the next one. Like _is_retryable
    but also covers 413 (request too large for this provider's per-minute token
    budget) — pointless to retry in place, but the next provider may have room."""
    if isinstance(exc, HTTPException):
        return False
    sc = getattr(exc, "status_code", None)
    if sc is not None:
        return sc in (429, 413) or sc >= 500
    return type(exc).__name__ in _CONN_ERRORS


def _status_str(exc: Exception) -> str:
    return str(getattr(exc, "status_code", None) or type(exc).__name__)


# A request that goes silent for long enough is indistinguishable from a broken
# one: the proxy drops the connection and the browser reports a failure for work
# the server goes on to complete. Bound the whole provider chain well inside that.
_LLM_DEADLINE_SECONDS = float(os.getenv("LLM_DEADLINE_SECONDS", "45"))


def with_backoff(fn, *, retries: int = 3, base: float = 0.5, cap: float = 8.0,
                 deadline: float | None = None):
    """Run fn(), retrying transient failures with jittered exponential backoff.

    `deadline` is a time.monotonic() stamp past which a retry is not worth
    waiting for; the error is raised instead so fail-over happens promptly.
    """
    attempt = 0
    while True:
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — re-raised below if not retryable
            if attempt >= retries or not _is_retryable(exc):
                raise
            delay = min(cap, base * (2 ** attempt)) + random.uniform(0, base)
            if deadline is not None and time.monotonic() + delay > deadline:
                logger.warning("LLM retry budget exhausted (%s); giving this provider up",
                               _status_str(exc))
                raise
            logger.warning("Groq call failed (%s); retry %d/%d in %.2fs",
                           type(exc).__name__, attempt + 1, retries, delay)
            time.sleep(delay)
            attempt += 1


def _groq_call(model, messages, max_tokens, temperature):
    kwargs: dict = {"model": model, "max_tokens": max_tokens, "messages": messages}
    if temperature is not None:
        kwargs["temperature"] = temperature
    return get_client().chat.completions.create(**kwargs)


def _cerebras_call(model, messages, max_tokens, temperature):
    cmodel = _CEREBRAS_MODELS.get(model, _CEREBRAS_MODELS[MODEL_SMART])
    kwargs: dict = {"model": cmodel, "messages": messages}
    if temperature is not None:
        kwargs["temperature"] = temperature
    if cmodel == "gpt-oss-120b":
        # Reasoning model: spends completion tokens thinking before the answer.
        # Keep that minimal for our structured/JSON tasks and add headroom so the
        # final content isn't starved by the caller's tight token budget.
        kwargs["reasoning_effort"] = "low"
        kwargs["max_completion_tokens"] = max_tokens + 1024
    else:
        kwargs["max_completion_tokens"] = max_tokens
    return get_cerebras().chat.completions.create(**kwargs)


def groq_chat(messages: list[dict], *, model: str = MODEL_SMART,
              max_tokens: int = 512, temperature: float | None = None):
    """Low-level completion with retry and cross-provider fail-over. Returns the
    raw (OpenAI-shaped) response so callers can read finish_reason / usage.
    Prefer groq_complete() for simple text."""
    providers = []
    if _GROQ_KEY:
        providers.append(("groq", _groq_call))
    if _CEREBRAS_KEY:
        providers.append(("cerebras", _cerebras_call))
    if not providers:
        raise HTTPException(503, "No LLM provider configured (set GROQ_API_KEY or CEREBRAS_API_KEY)")

    import metrics
    last_exc: Exception | None = None
    deadline = time.monotonic() + _LLM_DEADLINE_SECONDS
    for i, (name, call) in enumerate(providers):
        try:
            resp = with_backoff(
                lambda c=call: c(model, messages, max_tokens, temperature),
                deadline=deadline,
            )
            metrics.record_ai(name, ok=True)
            return resp
        except Exception as exc:  # noqa: BLE001 — re-raised below if chain exhausted
            last_exc = exc
            metrics.record_ai(name, ok=False, error=_status_str(exc))
            if i == len(providers) - 1 or not _should_failover(exc):
                raise
            logger.warning("LLM provider %s failed (%s); failing over to %s",
                           name, _status_str(exc), providers[i + 1][0])
    raise last_exc  # unreachable; the loop always returns or raises


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
    # content can be None when a reasoning fallback model (gpt-oss) spends its
    # whole budget thinking; coerce so callers never hit .strip() on None.
    return (resp.choices[0].message.content or "").strip()


def vision_complete(image_b64: str, media_type: str, prompt: str, *,
                     max_tokens: int = 1024, system: str | None = None,
                     model: str = VISION_MODEL) -> str:
    """Single-turn image+text completion via Claude. `image_b64` is raw base64
    (no data-URL prefix); `media_type` is e.g. "image/png" or "image/jpeg".
    Returns stripped text — pass through parse_json() for structured output.
    """
    def call():
        kwargs: dict = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": image_b64}},
                    {"type": "text", "text": prompt},
                ],
            }],
        }
        if system:
            kwargs["system"] = system
        return get_anthropic().messages.create(**kwargs)
    resp = with_backoff(call)
    return "".join(block.text for block in resp.content if block.type == "text").strip()


def parse_json(raw: str):
    raw = re.sub(r"^```(?:json)?\s*", "", raw.strip())
    raw = re.sub(r"\s*```$", "", raw)

    def strip_line_comments(s: str) -> str:
        out = []
        in_string = False
        escaped = False
        i = 0
        while i < len(s):
            char = s[i]
            if char == '"' and not escaped:
                in_string = not in_string
            if not in_string and char == '/' and i + 1 < len(s) and s[i + 1] == '/':
                while i < len(s) and s[i] not in '\r\n':
                    i += 1
                continue
            out.append(char)
            if char == '\\':
                escaped = not escaped
            else:
                escaped = False
            i += 1
        return "".join(out)

    def clean_control_chars(s: str) -> str:
        in_string = False
        escaped = False
        chars = []
        for char in s:
            if char == '"' and not escaped:
                in_string = not in_string
            if in_string and char == '\n':
                chars.append('\\n')
            elif in_string and char == '\r':
                chars.append('\\r')
            elif in_string and char == '\t':
                chars.append('\\t')
            else:
                chars.append(char)
            if char == '\\':
                escaped = not escaped
            else:
                escaped = False
        return "".join(chars)

    cleaned = clean_control_chars(strip_line_comments(raw))
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        m = re.search(r'[\[{].*[\]}]', cleaned, re.DOTALL)
        if m:
            try:
                return json.loads(m.group())
            except Exception:
                pass
        raise HTTPException(500, "AI returned malformed JSON")
