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

# Vision: Haiku first, Groq only when Anthropic cannot serve the call.
#
# Ordering is the whole design. Groq was tried in FRONT of Claude and removed,
# because a free leg that runs first makes every parse pay its reasoning tokens
# before the good model starts — latency with extra steps. Behind Claude it costs
# nothing until Anthropic is unavailable, and then it is the difference between a
# degraded parse and a dead feature. Credits running out is not hypothetical.
#
# Haiku rather than Sonnet because a screenshot parse is transcription, not
# judgement, and the price difference is roughly fivefold: a typical 1400x1000
# screenshot runs ~2.6k input and ~900 output tokens, which is about 2 cents on
# Sonnet. Image tokens dominate that (w*h/750), so downscaling before upload is a
# bigger lever than the model choice.
VISION_MODEL = "claude-haiku-4-5-20251001"
VISION_MODEL_STRONG = "claude-sonnet-5"    # for a caller that needs the harder read
VISION_MODEL_GROQ = "qwen/qwen3.6-27b"     # last resort, free
# Qwen prices prompt and completion together against an 8k/minute ceiling and an
# image is most of the prompt, so the completion has to stay small enough that the
# sum clears it.
# Qwen prices prompt and completion together against this per-minute ceiling, and
# an image is most of the prompt. A fixed completion cap therefore cannot work:
# improving the instructions grew the prompt and the same 3,500 cap started
# returning 429s. The budget is computed from what the prompt actually leaves.
_GROQ_VISION_TPM = 8_000
_GROQ_VISION_HEADROOM = 0.80   # leave room for other calls inside the same minute
_GROQ_VISION_MIN_COMPLETION = 900

# Vision prompts are dominated by pixels: Anthropic charges about w*h/750 image
# tokens, so a 2318x930 screenshot is ~2,900 tokens before a word of instruction.
# Downscaling is therefore the cheapest lever available on both cost and headroom,
# and screenshot text stays legible well below native retina resolution. Capped on
# the longest edge so a wide holdings table is not squashed out of readability.
_VISION_MAX_EDGE = 1_600

# Model tiers. SMART = deep reasoning (100K TPD free); FAST = structured JSON (500K TPD).
# The constants are the Groq model ids; each fallback provider maps them to its own.
#
# Groq decommissioned llama-3.3-70b-versatile on 2026-08-16 and named gpt-oss-120b
# and qwen3.6-27b as the replacements — both of which we already ran beside it, so
# SMART simply becomes the larger of the two. That makes SMART a reasoning model:
# every caller now spends completion tokens thinking before answering, which
# _groq_call already budgets for (see _GROQ_REASONING). The Cerebras fail-over has
# mapped SMART to the same model all along, so this path is well travelled.
MODEL_OSS = "openai/gpt-oss-120b"
MODEL_QWEN = "qwen/qwen3.6-27b"
MODEL_SMART = MODEL_OSS
MODEL_FAST  = "llama-3.1-8b-instant"

# Cerebras fallback models. gpt-oss-120b is the only model Cerebras lists as
# production; everything else there is preview and can be withdrawn. FAST used
# to map to zai-glm-4.7, which Cerebras scheduled for deprecation on
# 2026-08-17 — a fallback that would have failed silently the moment Groq
# rate-limited a structured-JSON call. Both tiers now land on the production
# model; losing a little speed on the fallback path is the right trade.
_CEREBRAS_MODELS = {
    MODEL_SMART: "gpt-oss-120b",
    MODEL_FAST:  "gpt-oss-120b",
}

# Groq meters tokens per model, not per organisation: burning a model's budget
# leaves the others untouched (measured — llama fell 11963→9845 while qwen and
# gpt-oss held at 7988 and 7927). So work split across these draws on separate
# per-minute buckets instead of queueing behind one.
#
# Losing llama cost the pool its widest bucket and one of its three lanes: a
# fan-out now spreads two ways over 16k tokens a minute where it used to spread
# three ways over 28k. Report sections queue rather than fail, but they queue
# longer.
MODEL_TPM = {MODEL_OSS: 8_000, MODEL_QWEN: 8_000, MODEL_FAST: 6_000}
MODEL_POOL = (MODEL_OSS, MODEL_QWEN)

# These spend completion tokens thinking before answering, so a caller's budget
# has to cover the scratchpad as well as the answer or the content comes back
# empty. strip_reasoning() removes the trace afterwards. Still used by the report
# section fan-out, which is text work on separate per-model token buckets.
_GROQ_REASONING = frozenset({MODEL_OSS, MODEL_QWEN, "openai/gpt-oss-20b"})

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
    if model in _GROQ_REASONING:
        # Headroom for the scratchpad on top of the caller's answer budget. Without
        # it a reasoning model spends the whole allowance thinking and returns
        # content=None, which reads downstream as a provider failure rather than a
        # budget one. Measured on a 20-row screenshot: 2.4k completion tokens for a
        # ~1.2k answer, so the scratchpad can match the answer. Scale with the ask
        # rather than adding a constant that only fits small ones.
        kwargs["max_tokens"] = int(max_tokens * 2) + 512
        if model.startswith("openai/gpt-oss"):
            kwargs["reasoning_effort"] = "low"
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


def _exhausted(exc: Exception, provider: str) -> Exception:
    """Turn a terminal provider failure into something the UI can say out loud.

    Every provider being rate-limited is an expected state on a free tier, not a
    bug in the request — but it reached the browser as a bare "Internal server
    error", which is indistinguishable from a crash and sends you reading
    tracebacks for a quota problem.
    """
    status = getattr(exc, "status_code", None)
    if status == 429:
        return HTTPException(503, (
            f"Every AI provider is rate-limited right now ({provider} returned 429). "
            "This is a free-tier quota, not a problem with your report. Wait a minute and retry."
        ))
    if status == 413:
        if "vision" in provider:
            return HTTPException(503, (
                f"The image is larger than {provider} accepts in one call. "
                "Crop or downscale the screenshot and retry."
            ))
        return HTTPException(503, (
            f"The request is larger than {provider} accepts in one call. "
            "Reduce the report length or the number of clips and retry."
        ))
    return exc


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
                raise _exhausted(exc, name)
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


def downscale_image(image_b64: str, media_type: str, max_edge: int = _VISION_MAX_EDGE):
    """Shrink an oversized screenshot before it is priced as tokens.

    Returns (base64, media_type), unchanged when the image already fits or when
    anything goes wrong — a failed resize must never block a parse that would
    otherwise have worked.
    """
    try:
        import base64 as _b64
        import io
        from PIL import Image

        raw = _b64.b64decode(image_b64)
        img = Image.open(io.BytesIO(raw))
        longest = max(img.size)
        if longest <= max_edge:
            return image_b64, media_type

        scale = max_edge / longest
        resized = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                             Image.LANCZOS)
        buf = io.BytesIO()
        # PNG keeps text edges crisp, which is the whole point of the image. JPEG
        # would be smaller on disk but the tokens are priced on pixels, not bytes.
        if resized.mode not in ("RGB", "L"):
            resized = resized.convert("RGB")
        resized.save(buf, format="PNG", optimize=True)
        logger.info("vision image downscaled %sx%s -> %sx%s",
                    img.width, img.height, resized.width, resized.height)
        return _b64.b64encode(buf.getvalue()).decode(), "image/png"
    except Exception as exc:  # noqa: BLE001 — resizing is an optimisation, not a gate
        logger.warning("vision image downscale failed, sending original: %s", exc)
        return image_b64, media_type


def _claude_vision_call(image_b64: str, media_type: str, prompt: str,
                        max_tokens: int, system: str | None, model: str) -> str:
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
    resp = get_anthropic().messages.create(**kwargs)
    return "".join(block.text for block in resp.content if block.type == "text").strip()


def _estimate_image_tokens(image_b64: str) -> int:
    """Anthropic's w*h/750 rule is close enough for Groq budgeting too."""
    try:
        import base64 as _b64
        import io
        from PIL import Image
        w, h = Image.open(io.BytesIO(_b64.b64decode(image_b64))).size
        return int(w * h / 750)
    except Exception:  # noqa: BLE001 — a rough guess beats refusing to budget
        return 1_500


def _groq_vision_budget(image_b64: str, system: str | None, prompt: str, max_tokens: int) -> int:
    """Completion tokens that still leave the whole request inside the ceiling."""
    prompt_tokens = _estimate_image_tokens(image_b64) + (len(system or "") + len(prompt)) // 4
    room = int(_GROQ_VISION_TPM * _GROQ_VISION_HEADROOM) - prompt_tokens
    return max(_GROQ_VISION_MIN_COMPLETION, min(max_tokens, room))


def _groq_vision_call(image_b64: str, media_type: str, prompt: str,
                      max_tokens: int, system: str | None, model: str) -> str:
    content = [
        {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{image_b64}"}},
        {"type": "text", "text": prompt},
    ]
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": content})
    budget = _groq_vision_budget(image_b64, system, prompt, max_tokens)
    resp = get_client().chat.completions.create(
        model=VISION_MODEL_GROQ, max_tokens=budget,
        # Reading a table is transcription, not reasoning, and the scratchpad is
        # charged against the same budget as the answer — on a wide screenshot it
        # consumed the budget and truncated the JSON mid-object. "none" is the only
        # value Groq accepts besides "default" here.
        reasoning_effort="none",
        temperature=0, messages=messages,
    )
    choice = resp.choices[0]
    if getattr(choice, "finish_reason", None) == "length":
        raise RuntimeError("vision answer truncated before it finished")
    return strip_reasoning(choice.message.content or "")


# Out of credit is a 400 from Anthropic, not a 429, so the generic retry/failover
# predicates do not catch it. It is also the one failure a paid-primary chain most
# needs to survive, which is the reason this fallback exists at all.
_CREDIT_MARKERS = ("credit balance", "insufficient", "quota", "billing", "payment")


def _is_exhausted_account(exc: Exception) -> bool:
    return any(marker in str(exc).lower() for marker in _CREDIT_MARKERS)


def vision_complete(image_b64: str, media_type: str, prompt: str, *,
                     max_tokens: int = 1024, system: str | None = None,
                     model: str = VISION_MODEL, validate=None) -> str:
    """Single-turn image+text completion. `image_b64` is raw base64 (no data-URL
    prefix); `media_type` is e.g. "image/png" or "image/jpeg". Returns stripped
    text — pass through parse_json() for structured output.

    Claude serves this. Groq is tried only if Anthropic cannot: no key, no credit,
    rate limited, or a server error. `validate` is the caller's parser and runs
    inside each attempt, so an answer the caller cannot use is treated as a
    failure here instead of blowing up downstream.
    """
    image_b64, media_type = downscale_image(image_b64, media_type)

    providers: list[tuple[str, object, str]] = []
    if _ANTHROPIC_KEY:
        providers.append(("claude-vision", _claude_vision_call, model))
    if _GROQ_KEY:
        providers.append(("groq-vision", _groq_vision_call, VISION_MODEL_GROQ))
    if not providers:
        raise HTTPException(503, "No vision provider configured (set ANTHROPIC_API_KEY or GROQ_API_KEY)")

    import metrics
    last_exc: Exception | None = None
    for i, (name, call, use_model) in enumerate(providers):
        try:
            text = with_backoff(
                lambda c=call, m=use_model: c(image_b64, media_type, prompt, max_tokens, system, m),
                retries=1,
            )
            if not text:
                raise RuntimeError("vision model returned no text")
            if validate is not None:
                validate(text)
            metrics.record_ai(name, ok=True)
            return text
        except Exception as exc:  # noqa: BLE001 — re-raised if the chain is exhausted
            last_exc = exc
            metrics.record_ai(name, ok=False, error=_status_str(exc))
            if i == len(providers) - 1:
                raise _exhausted(exc, name)
            reason = "out of credit" if _is_exhausted_account(exc) else _status_str(exc)
            logger.warning("vision provider %s failed (%s); falling back to %s",
                           name, reason, providers[i + 1][0])
    raise last_exc  # unreachable


_THINK_BLOCK = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.DOTALL | re.IGNORECASE)


def strip_reasoning(raw: str) -> str:
    """Remove a reasoning model's visible scratchpad before parsing.

    gpt-oss and qwen both emit one on the report fan-out path. Without this the
    salvage regex in parse_json matches the first brace it finds, which is the
    model's discarded draft whenever the scratchpad contains one.
    """
    return _THINK_BLOCK.sub("", raw or "").strip()


def parse_json(raw: str):
    raw = strip_reasoning(raw)
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
