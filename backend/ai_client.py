"""Shared LLM utility used by ai.py and any router that needs LLM access.

Two providers, and which one serves a call is decided by the model id, not by a
fixed order: Groq models go to Groq, Mistral models go to Mistral. A call falls
over to the OTHER provider's equivalent model when its own is rate-limited (429),
refuses an oversized request (413), or errors. Each provider gets jittered
exponential backoff for transient errors first; only a sustained failure trips
the fail-over. System/user messages stay split so the static instruction prefix
can be cached across calls.

Cerebras used to be the fail-over. Its account has been out of credit (402) since
at least 2026-08-24, so every Groq 429 was falling through to a provider that
could not answer, which is why a rate-limited Groq surfaced as a total failure.
It is out of the chain. ANTHROPIC_API_KEY is in the Fly secrets and is likewise
out of credit; nothing has ever called it.
"""
import os, json, re, time, random, logging
from fastapi import HTTPException

logger = logging.getLogger(__name__)
_GROQ_KEY = os.getenv("GROQ_API_KEY", "")
_MISTRAL_KEY = os.getenv("MISTRAL_API_KEY", "")

#
# Groq decommissioned llama-3.3-70b-versatile on 2026-08-16 and named gpt-oss-120b
# and qwen3.6-27b as the replacements — both of which we already ran beside it, so
# SMART simply becomes the larger of the two. That makes SMART a reasoning model:
# every caller now spends completion tokens thinking before answering, which
# _groq_call already budgets for (see _GROQ_REASONING). The Cerebras fail-over has
# mapped SMART to the same model all along, so this path is well travelled.
MODEL_OSS = "openai/gpt-oss-120b"
MODEL_QWEN = "qwen/qwen3.6-27b"
MODEL_OSS20 = "openai/gpt-oss-20b"
MODEL_SMART = MODEL_OSS
# Was llama-3.1-8b-instant until Groq withdrew it (confirmed absent from
# /v1/models on 2026-08-24). It had been 404ing on every call since: the report
# fan-out spent each section's last rescue attempt on it, and the screener, bond
# and algo-runtime helpers had no working model at all, because a 404 fails over
# to Cerebras and that account is out of credit (402). Point FAST at the
# smallest live pool model instead.
MODEL_FAST  = MODEL_OSS20

# Groq's agentic system, metered on its own 70,000/min bucket — nearly nine
# times a pool lane — and not a reasoning model, so it reserves one completion
# token per token asked instead of roughly two and a half. That makes it the
# only lane that can absorb a whole report in one call.
#
# It can run a web search, which is why it is a rescue lane and not the writer:
# a grounded report must come from the clips. Measured on the real report task
# it used no tools and returned schema-clean JSON — it reaches for search only
# when asked for a fact the prompt does not carry — but "only when it needs to"
# is the model's judgement, not a guarantee, so it is reached for only once the
# metered lanes have already failed.
MODEL_COMPOUND = "groq/compound-mini"

# Mistral's free "Experiment" tier: ~500,000 tokens a minute against Groq's
# 8,000, one request a second, and about a billion tokens a month. That is the
# lane that makes a whole report writable — seven sections need ~35,000 tokens
# and the Groq pool supplies 24,000 a minute, so the fan-out was starving by
# arithmetic, not by any bug left to find.
#
# The tier is free because you opt into Mistral training on what you send it.
# That is a deliberate choice, made 2026-08-25, and it is the reason this is not
# simply the default for every caller: it carries the report's portfolio clips.
MODEL_MISTRAL = os.getenv("MISTRAL_MODEL", "mistral-medium-latest")
MODEL_MISTRAL_SMALL = os.getenv("MISTRAL_MODEL_SMALL", "mistral-small-latest")
_MISTRAL_MODELS = frozenset({MODEL_MISTRAL, MODEL_MISTRAL_SMALL})
_MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions"
_MISTRAL_TIMEOUT = float(os.getenv("MISTRAL_TIMEOUT", "120"))


# Groq meters tokens per model, not per organisation: burning a model's budget
# leaves the others untouched (measured — llama fell 11963→9845 while qwen and
# gpt-oss held at 7988 and 7927). So work split across these draws on separate
# per-minute buckets instead of queueing behind one.
#
# Losing llama-3.3-70b cost the pool a lane, taking a fan-out from three ways
# over 28k tokens a minute down to two over 16k, and report sections started
# failing rather than queueing. gpt-oss-20b restores the third lane and then
# some: measured 2026-08-15, every one of these is metered independently, so the
# pool is back to 24k across three equal buckets (30k counting overflow) against
# the 28k it had before.
# No MODEL_FAST entry: it is MODEL_OSS20 now, and a second key for the same
# model would have overwritten the real 8,000 with a stale 6,000.
MODEL_TPM = {MODEL_OSS: 8_000, MODEL_QWEN: 8_000, MODEL_OSS20: 8_000,
             MODEL_COMPOUND: 70_000,
             MODEL_MISTRAL: 500_000, MODEL_MISTRAL_SMALL: 500_000}

# Groq's 413 is BUCKET-RELATIVE. A request is "too large" when it does not fit
# what is LEFT of the per-minute allowance, not when it exceeds some fixed size.
# Measured 2026-08-24 against a deliberately refilled bucket, gpt-oss-120b
# accepted 7,000, 10,000 and 11,500-token requests — every one of which 413s
# once the bucket has been drawn down. Bisecting for a "max request size" only
# ever measures how much quota the probe itself had just spent.
#
# So the number that matters is not a size limit. It is each request's fair
# share of the minute. Sizing every one of a seven-section fan-out to the WHOLE
# bucket is what made the second and third section on each lane fail: the first
# request drained the lane, and everything after it was refused as too large.
_DEFAULT_CEILING = 8_000

# A hard per-request size, for models that have one INDEPENDENT of their meter.
# The pool models do not: measured on a full bucket they accept 11,500 tokens,
# so their per-minute allowance is what binds and there is nothing to add here.
# compound-mini does: it 413s a 10,000-token request with 63,000 tokens still
# left in its bucket, because it is an agentic system with its own context
# budget rather than a bare model.
#
# Do not "measure" these by bisection while spending the quota you are
# measuring. That produced two wrong numbers already. Confirm on a full bucket,
# and treat a 429 as "no information about size".
MODEL_MAX_INPUT = {
    MODEL_COMPOUND: 7_000,
    # Not a provider limit — Mistral's context is far larger. This is a
    # deliberate cap: a 500,000 share would let one section build a request of
    # 440,000 tokens, which is how the compound lane produced 413s. 32,000 is
    # roughly fifteen times what a section can carry on a Groq lane, so the
    # evidence stops being the thing that gets shed, and seven of them still sit
    # well inside a minute.
    MODEL_MISTRAL: 32_000,
    MODEL_MISTRAL_SMALL: 32_000,
}


def request_ceiling(model: str, sharing: int = 1) -> int:
    """The largest request to build for `model` when `sharing` of them contend
    for the same per-minute bucket inside one window.

    `sharing` is how many calls will land on this lane before it refills — for a
    fan-out, the sections per lane. Pass 1 for a call that has the lane to
    itself.
    """
    share = MODEL_TPM.get(model, _DEFAULT_CEILING) // max(1, sharing)
    return max(1, min(share, MODEL_MAX_INPUT.get(model, share)))

# Lanes a fan-out starts on. Close enough in capability that it does not matter
# which section lands where — the outline fixes the argument before any of them
# write, so a lane supplies prose, not judgement.
#
# They are NOT the same width any more. Mistral is metered at 500,000 tokens a
# minute against a Groq lane's 8,000, which is the whole reason it is here: a
# seven-section report needs ~35,000 tokens and the three Groq lanes supply
# 24,000 a minute between them, so the fan-out starved by arithmetic. Sizing is
# per-lane (request_ceiling), so a wide lane carries a section with fifteen
# times the evidence rather than the same section with room to spare.
#
# Mistral is listed first so section 0 starts there and the round-robin gives it
# the most work. Present only when its key is set, so a deploy without
# MISTRAL_API_KEY still runs on the Groq pool exactly as before.
def build_pool(mistral_key: str) -> tuple[str, ...]:
    """The fan-out lanes for a given configuration.

    A function, not an expression, so it can be tested at both configurations
    without reloading the module — reloading rebinds MODEL_POOL while other
    modules still hold the old object, and the mismatch surfaces as a failure in
    an unrelated test that only appears in certain orders.
    """
    return tuple(([MODEL_MISTRAL] if mistral_key else [])
                 + [MODEL_OSS, MODEL_QWEN, MODEL_OSS20])


MODEL_POOL = build_pool(_MISTRAL_KEY)

# Tried only after every pool lane has failed. Its bucket is metered separately
# and is wide enough that a section which the 8k lanes all refused still fits,
# so it is what keeps a section from being dropped when the pool is spent.
MODEL_OVERFLOW = (MODEL_COMPOUND,)

# These spend completion tokens thinking before answering, so a caller's budget
# has to cover the scratchpad as well as the answer or the content comes back
# empty. strip_reasoning() removes the trace afterwards. Still used by the report
# section fan-out, which is text work on separate per-model token buckets.
_GROQ_REASONING = frozenset({MODEL_OSS, MODEL_QWEN, "openai/gpt-oss-20b"})

_client = None


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
        return sc in (429, 413, 402) or sc >= 500
    return type(exc).__name__ in _CONN_ERRORS


# A provider out of credit answers 402 to every call until someone tops it up.
# Trying it on each request costs a round trip and adds its latency to a failure
# that was already decided, so it is set aside and retried occasionally rather
# than continuously.
_UNPAID_COOLDOWN_S = float(os.getenv("LLM_UNPAID_COOLDOWN_S", "900"))
_unpaid_until: dict[str, float] = {}


def _mark_unpaid(provider: str) -> None:
    _unpaid_until[provider] = time.monotonic() + _UNPAID_COOLDOWN_S
    logger.warning("%s is out of credit (402); skipping it for %.0f minutes",
                   provider, _UNPAID_COOLDOWN_S / 60)


def _is_unpaid(provider: str) -> bool:
    until = _unpaid_until.get(provider)
    if until is None:
        return False
    if time.monotonic() >= until:
        _unpaid_until.pop(provider, None)   # cooldown elapsed, let it try again
        return False
    return True


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


_REASONING_SCRATCHPAD = 512


def completion_cost(model: str, max_tokens: int) -> int:
    """Completion tokens a call for `max_tokens` of answer actually reserves.

    Groq counts the requested completion against the model's per-minute limit,
    so anything sizing a request has to ask this rather than assume it gets what
    it asked for. A caller that budgets the bare answer and then lands here
    silently overshoots by the whole scratchpad, which Groq rejects as 413 —
    and 413 fails over, so the symptom surfaces as the *next* provider's 429.
    """
    if model in _GROQ_REASONING:
        return int(max_tokens * 2) + _REASONING_SCRATCHPAD
    return max_tokens


def answer_tokens_within(model: str, available: int) -> int:
    """Inverse of completion_cost: the largest answer that fits `available`."""
    if model in _GROQ_REASONING:
        return max(0, (available - _REASONING_SCRATCHPAD) // 2)
    return max(0, available)


def _groq_call(model, messages, max_tokens, temperature):
    # Substitute when handed a model Groq does not serve. This runs when a
    # Mistral call fails over: sending "mistral-medium-latest" to Groq spends a
    # request to be told the model does not exist.
    if model in _MISTRAL_MODELS:
        model = MODEL_SMART
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
        kwargs["max_tokens"] = completion_cost(model, max_tokens)
        if model.startswith("openai/gpt-oss"):
            kwargs["reasoning_effort"] = "low"
    return get_client().chat.completions.create(**kwargs)


def _mistral_call(model, messages, max_tokens, temperature):
    """Mistral's chat-completions endpoint, which is OpenAI-shaped.

    Called over httpx rather than through a vendor SDK: the SDK would be a new
    dependency on a 1GB machine, and the only thing needed here is one POST
    whose response already matches what every caller reads. The response is
    wrapped so `resp.choices[0].message.content` works exactly as it does for
    Groq.
    """
    import httpx

    if not _MISTRAL_KEY:
        raise HTTPException(503, "MISTRAL_API_KEY not configured")
    body: dict = {
        "model": model if model in _MISTRAL_MODELS else MODEL_MISTRAL,
        "messages": messages,
        "max_tokens": max_tokens,
    }
    if temperature is not None:
        body["temperature"] = temperature
    r = httpx.post(_MISTRAL_URL, timeout=_MISTRAL_TIMEOUT, json=body,
                   headers={"Authorization": f"Bearer {_MISTRAL_KEY}",
                            "Content-Type": "application/json"})
    if r.status_code >= 400:
        # Carry the provider's status so _should_failover, _is_retryable and
        # _exhausted all read it the same way they read a vendor SDK error.
        raise _ProviderError(r.status_code, (r.text or "")[:400])
    return _shape(r.json())


class _ProviderError(Exception):
    """A raw-HTTP provider failure, shaped like the vendor SDK errors so the
    retry, fail-over and diagnosis paths do not need to know the difference."""

    def __init__(self, status_code: int, detail: str = ""):
        super().__init__(f"{status_code}: {detail}")
        self.status_code = status_code


class _Msg:
    def __init__(self, d): self.content = d.get("content") or ""


class _Choice:
    def __init__(self, d):
        self.message = _Msg(d.get("message") or {})
        self.finish_reason = d.get("finish_reason")


class _Resp:
    def __init__(self, d):
        self.choices = [_Choice(c) for c in (d.get("choices") or [])]
        self.usage = d.get("usage")


def _shape(payload: dict):
    """Give a raw JSON completion the same attribute access the SDKs return."""
    return _Resp(payload)


def _exhausted(exc: Exception, provider: str,
               chain: list[tuple[str, str]] | None = None) -> Exception:
    """Turn a terminal provider failure into something the UI can say out loud.

    Every provider being rate-limited is an expected state on a free tier, not a
    bug in the request — but it reached the browser as a bare "Internal server
    error", which is indistinguishable from a crash and sends you reading
    tracebacks for a quota problem.

    `chain` is every provider tried, because the last failure is not always the
    real one: an oversized request 413s on the first provider and fails over,
    so the message the user saw named the second provider's 429 and blamed a
    quota for a request that was simply too big. Diagnose from the whole chain.
    """
    tried = chain or [(provider, _status_str(exc))]
    if any(status == "413" for _, status in tried):
        over = ", ".join(name for name, status in tried if status == "413")
        return HTTPException(503, (
            f"The request was larger than {over} accepts in one call, so it could not be "
            "written. This is a size problem, not a quota: use fewer clips or a shorter report."
        ))
    status = getattr(exc, "status_code", None)
    if any(st == "402" for _, st in tried):
        broke = ", ".join(name for name, st in tried if st == "402")
        return HTTPException(503, (
            f"{broke} is out of credit, so this request could not be completed. "
            "Top up that account, or the request will keep failing over to it and back."
        ))
    if status == 429:
        return HTTPException(503, (
            f"Every AI provider is rate-limited right now ({provider} returned 429). "
            "This is a free-tier quota, not a problem with your report. Wait a minute and retry."
        ))
    if status == 413:
        return HTTPException(503, (
            f"The request is larger than {provider} accepts in one call. "
            "Reduce the report length or the number of clips and retry."
        ))
    return exc


def _providers_for(model: str) -> list[tuple[str, object]]:
    """Providers to try for `model`, in order, own-provider first.

    Which provider serves a call follows the MODEL, not a fixed order. Groq ids
    go to Groq and Mistral ids go to Mistral; the other is the fail-over, and
    _mistral_call/_groq_call each substitute their own equivalent model when
    handed one they do not serve. Trying Groq first for a Mistral model was the
    obvious shape and it is wrong: it spends the Groq bucket to learn the model
    does not exist there, and Groq's bucket is the scarce one.
    """
    mistral = ("mistral", _mistral_call) if _MISTRAL_KEY else None
    groq = ("groq", _groq_call) if _GROQ_KEY else None
    order = [mistral, groq] if model in _MISTRAL_MODELS else [groq, mistral]
    live = [p for p in order if p]
    # Skip anything known to be out of credit, but keep one thing to try: a
    # request that fails reports why, where a request with nothing left to try
    # reports only that there was nothing to try.
    payable = [p for p in live if not _is_unpaid(p[0])]
    return payable or live[-1:]


def groq_chat(messages: list[dict], *, model: str = MODEL_SMART,
              max_tokens: int = 512, temperature: float | None = None,
              retries: int | None = None):
    """Low-level completion with retry and cross-provider fail-over. Returns the
    raw (OpenAI-shaped) response so callers can read finish_reason / usage.
    Prefer groq_complete() for simple text.

    `retries` overrides the per-provider backoff count. Pass 0 when the CALLER
    has somewhere better to go: a 429 means this model's bucket is empty, and
    sitting on it through three backoffs costs about four seconds to learn
    something the first response already said. A caller that walks several
    models is better off moving to the next one immediately and letting its own
    retry loop do the waiting.
    """
    providers = _providers_for(model)
    if not providers:
        raise HTTPException(503, "No LLM provider configured (set GROQ_API_KEY or MISTRAL_API_KEY)")
    import metrics
    last_exc: Exception | None = None
    tried: list[tuple[str, str]] = []
    deadline = time.monotonic() + _LLM_DEADLINE_SECONDS
    for i, (name, call) in enumerate(providers):
        try:
            resp = with_backoff(
                lambda c=call: c(model, messages, max_tokens, temperature),
                deadline=deadline,
                **({} if retries is None else {"retries": retries}),
            )
            metrics.record_ai(name, ok=True)
            return resp
        except Exception as exc:  # noqa: BLE001 — re-raised below if chain exhausted
            last_exc = exc
            tried.append((name, _status_str(exc)))
            metrics.record_ai(name, ok=False, error=_status_str(exc))
            if getattr(exc, "status_code", None) == 402:
                _mark_unpaid(name)
            if i == len(providers) - 1 or not _should_failover(exc):
                raise _exhausted(exc, name, tried)
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
