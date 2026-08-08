"""Prompt -> validated Python, with an automatic repair loop.

Five stages, each independently retryable:

  1 INTENT      what is being asked (create / edit / explain / tune)
  2 SPEC        extract a checkable spec, and decide whether the request is
                possible at all (algo_runtime.spec)
  3 GROUND      deterministic facts — the contract, the helper list, current code
  4 GENERATE    the model writes the whole `signal()` function
  5 VALIDATE    algo_runtime.validate L0-L6 (safe, causal, runnable)
                + algo_runtime.spec.conformance L7 (is it what was asked)
  6 REPAIR      feed the diagnostic back, up to MAX_REPAIRS times

The repair loop is what makes this usable rather than a demo: a model that
writes `close.shift(-1)` gets told "lookahead bias: entries[119] changes when
data after bar 120 is collapsed" and fixes the cause. Only after the retries are
spent does a failure reach the user, and then it names the check that failed.

Stages 2 and 5 exist because L0-L6 prove the code is SAFE, not that it is what
you asked for. Without them the engine answers an impossible request by quietly
writing a different, possible one — which is the worst failure available here,
since it looks exactly like success.
"""
from __future__ import annotations

import logging
import os
import re
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from .contract import Ctx                       # noqa: E402
from .sandbox import make_runner                # noqa: E402
from .setup import extract as extract_setup                      # noqa: E402
from .spec import conformance, extract as extract_spec, refusal   # noqa: E402
from .validate import validate_source           # noqa: E402

logger = logging.getLogger("algo_runtime.generate")

MAX_REPAIRS = 2
GEN_TOKENS = 1600


def _helper_catalog() -> str:
    """The vocabulary shown to the model.

    Grouped, because a flat list of 66 names reads as noise and the model falls
    back on hand-rolled numpy — which is exactly what the causal helpers exist to
    prevent. Verified against the module at import so a renamed helper fails here
    rather than silently disappearing from the prompt.
    """
    from . import indicators as ind

    groups: list[tuple[str, list[tuple[str, str]]]] = [
        ("Trend and momentum", [
            ("sma(a, period)", "simple moving average"),
            ("ema(a, period)", "exponential moving average"),
            ("rsi(a, period=14)", "0-100"),
            ("macd_line / macd_signal(a)", "fast=12, slow=26, signal_period=9"),
            ("bb_upper / bb_mid / bb_lower(a, period=20, std=2.0)", "Bollinger bands"),
            ("momentum(a, period)", "a[i]/a[i-period] - 1, a ratio"),
            ("pct_change(a, period)", "percent over N bars (5.0 = +5%)"),
            ("slope(a, period)", "least-squares trend, units per bar"),
        ]),
        ("Statistics over a trailing window", [
            ("rolling_mean / rolling_std / rolling_min / rolling_max / rolling_sum / rolling_median(a, period)", ""),
            ("zscore(a, period=20)", "how unusual this bar is vs its own history"),
            ("percentile_rank(a, period=252)", "0-100, regime-free"),
            ("rolling_corr(a, b, period=60)", "trailing correlation"),
            ("rolling_beta(a, benchmark, period=60)", "on returns, not levels"),
            ("pct_returns(a)", "bar-over-bar returns"),
        ]),
        ("Bar shape — needs high/low/open", [
            ("true_range(high, low, close)", "the real thing"),
            ("atr_true(high, low, close, period=14)", "Wilder ATR"),
            ("gap_pct(open, close)", "overnight gap, percent"),
            ("range_pct(high, low, close)", "bar range as percent of close"),
            ("close_position(high, low, close)", "0=at the low, 1=at the high"),
            ("typical_price(high, low, close)", "(H+L+C)/3"),
        ]),
        ("Volume", [
            ("relative_volume(volume, period=20)", "1.0 = typical, 3.0 = 3x normal"),
            ("dollar_volume(close, volume)", ""),
            ("vwap(price, volume, period=20)", "rolling VWAP"),
            ("obv(close, volume)", "on-balance volume"),
        ]),
        ("Sequencing and state — impossible in the old rule builder", [
            ("bars_since(flag)", "bars since flag was last True"),
            ("cooldown(flag, bars)", "suppress re-firing for N bars"),
            ("streak(flag)", "length of the current True run"),
            ("held_for(flag, bars)", "True once flag held N bars"),
            ("count_in_window(flag, period)", "firings in the trailing window"),
        ]),
        ("Drawdown and extremes", [
            ("drawdown_pct / runup_pct(a)", "vs the running peak/trough"),
            ("is_new_high / is_new_low(a, period)", ""),
            ("pct_below_high / pct_above_low(a, period)", ""),
        ]),
        ("Relative and cross-ticker", [
            ("ratio(a, b)", "safe divide"),
            ("relative_strength(a, benchmark, period=63)", "excess return, points"),
            ("spread_zscore(a, b, period=60)", "the pair-trade signal"),
        ]),
        ("Volatility", [
            ("realized_vol(a, period=21)", "annualized, percent"),
            ("iv_rank(a, period=252)", "realized-vol percentile"),
            ("atr(a, period=14)", "close-only proxy; prefer atr_true"),
        ]),
        ("Calendar — needs c.index", [
            ("day_of_week(index, n)", "Mon=0 .. Fri=4"),
            ("month_of_year(index, n)", "1-12"),
            ("is_month_end(index, n)", "first bar of a new month"),
        ]),
        ("Combining", [
            ("crosses_above / crosses_below(a, b)", "b may be a number"),
            ("rising / falling(a, k=1)", ""),
            ("prev(a, k=1)", "look BACK k bars; negative k is an error"),
            ("all_of / any_of(*flags)", "AND / OR"),
            ("where(cond, a, b)", "pick per bar"), ("clip(a, lo, hi)", ""), ("never(n)", "all-False"),
        ]),
    ]

    lines: list[str] = []
    for title, rows in groups:
        lines.append(f"  {title}")
        for sig, doc in rows:
            for name in sig.split("(")[0].replace("/", " / ").split(" / "):
                base = name.strip()
                if base and not hasattr(ind, base):
                    raise RuntimeError(f"helper catalog names {base!r}, which does not exist")
            lines.append(f"    ind.{sig:<48} {doc}".rstrip())
    return "\n".join(lines)


SYSTEM = f"""You write ONE Python function for a backtesting engine. Nothing else.

CONTRACT
    def signal(c):
        ...
        return Signals(entries, exits)            # or Signals(entries, exits, size)

`entries` and `exits` are numpy BOOL arrays of length c.n — one flag per bar.
They are RAW per-bar conditions. Do NOT track position state, count lots,
compute P&L, or apply stop losses: the engine does all of that. Your job is "is
the entry condition true on this bar" and "is the exit condition true on this
bar".

`size` is OPTIONAL and answers a third question: HOW MUCH on this bar. It is a
float array in 0..1 multiplying the user's configured position size, so 0.5
means half of whatever they set, and 1.0 (the default when you omit it) means
full. Use it for conviction or for volatility targeting — staking less when the
name is moving violently keeps risk per trade roughly constant:

    vol = ind.realized_vol(c.close, 21)
    size = ind.clip(ind.ratio(np.full(c.n, 20.0), vol), 0, 1)   # 20% vol = full size
    return Signals(entries, exits, size)

Omit `size` unless the request actually calls for varying the stake. It cannot
exceed 1.0 (the user's setting is a ceiling) and must never be negative — a
short is expressed by the strategy's side setting, not a negative stake.

WHAT `c` GIVES YOU
    c.close c.open c.high c.low c.volume   the traded symbol's bars, float64[n]
    c.n                  number of bars
    c.index              bar timestamps (may be None)
    c.frame("SPY")       another symbol's closes, date-aligned, same length
    c.bar("high", "SPY") any OHLCV field for any referenced symbol
    c.metric("FUND_PE")  point-in-time fundamentals/liquidity, per bar
    c.param("x", 10)     a tunable number
A field this feed lacks is all-NaN, and NaN comparisons are False, so a
condition on missing data never fires rather than trading on zeros.

HELPERS (already imported as `ind`; numpy is `np`)
{_helper_catalog()}

HARD RULES
1. NO imports. `np`, `ind` and `Signals` are already available.
2. NEVER read the future. No np.roll(x, -1), no shift(-1), no whole-series
   np.max/np.min/np.mean/np.percentile, no x[::-1] cumulative fills, no
   centered windows, no c.close[-1] as a reference level. Bar i may only use
   data from bars 0..i. Expanding windows (np.maximum.accumulate, np.cumsum)
   are fine because they only look back.
3. Prefer the `ind` helpers over hand-rolled numpy — they are already causal,
   and every one you use is a lookahead bug that cannot happen. Reach for the
   statistical, sequencing and bar-shape helpers freely: this engine is NOT
   limited to simple threshold rules. Composite conditions, rate limiting,
   volume regimes, volatility normalisation and pair spreads are all expected.
4. Deterministic: if you need randomness, seed it (np.random.default_rng(42)).
5. Comparisons involving NaN are False in numpy. That is the correct behaviour
   during indicator warmup — do not "fix" it with nan_to_num.
6. Return the WHOLE function every time, even for a small edit.

WORTH KNOWING
You may compute intermediate series freely, use Python loops when a rule is
genuinely sequential (the engine kills anything over 10s of CPU), and normalise
by volatility (`ind.ratio(x, ind.atr_true(c.high, c.low, c.close, 14))`) so a
threshold means the same thing across regimes. A rule like "no more than one
entry per fortnight" is `ind.cooldown(raw, 10)`.

OUTPUT
Python source only. No markdown fences, no explanation, no example usage.
"""

_FENCE = re.compile(r"^\s*```(?:python)?\s*|\s*```\s*$", re.M)


def _strip(raw: str) -> str:
    """Models add fences and prose however firmly you ask them not to."""
    text = _FENCE.sub("", raw or "").strip()
    if "def signal" in text:
        # Drop anything before the def (a stray sentence) and any trailing prose
        # that is not indented under it.
        start = text.index("def signal")
        head, body = text[:start], text[start:]
        if head.strip() and not head.strip().startswith(("import", "from", "#")):
            text = body
    return text.strip()


def _probe_ctx(n: int = 400, seed: int = 7) -> Ctx:
    """A synthetic random walk for validation.

    Deliberately not live market data: these checks are structural (lookahead,
    warmup, determinism), and a fixed series makes the verdict reproducible and
    instant instead of dependent on whichever ticker happens to be loaded.
    """
    rng = np.random.default_rng(seed)
    return Ctx(close=100 * np.exp(np.cumsum(rng.normal(0.0004, 0.013, n))))


def classify(prompt: str, has_code: bool) -> str:
    """Stage 1. Deterministic — the four regex intent-detectors this replaces in
    ai.py were the reason strategy-chat became hard to reason about, and a
    keyword table is at least inspectable."""
    p = (prompt or "").lower()
    if any(w in p for w in ("explain", "what does", "how does", "why does", "walk me through")):
        return "explain"
    if has_code and any(w in p for w in ("change", "edit", "instead", "add ", "remove ", "tweak",
                                         "make it", "adjust", "also ", "tighten", "loosen")):
        return "edit"
    return "create"


def generate(prompt: str, current_source: str | None = None, history: list[dict] | None = None,
             model: str | None = None, current_setup: dict | None = None) -> dict:
    """Run the pipeline. Returns {ok, source, diagnostics, attempts, intent, explanation}."""
    from ai_client import groq_chat, MODEL_SMART

    intent = classify(prompt, bool(current_source))

    if intent == "explain":
        msgs = [{"role": "system", "content":
                 "Explain this trading strategy's Python in plain English: what it enters on, what it "
                 "exits on, and any risk in the logic. Be specific and brief. No code."}]
        msgs += list(history or [])
        msgs.append({"role": "user", "content": f"{prompt}\n\n```python\n{current_source or ''}\n```"})
        resp = groq_chat(msgs, model=model or MODEL_SMART, max_tokens=700)
        return {"ok": True, "source": current_source, "diagnostics": [], "attempts": 0,
                "intent": intent, "explanation": (resp.choices[0].message.content or "").strip()}

    # Stage 2. An impossible request is refused, not answered with something
    # adjacent — the user needs to know their idea cannot be backtested.
    spec = extract_spec(prompt) if intent == "create" else {"feasible": True, "entry": [], "exit": []}
    if not spec.get("feasible", True):
        return refusal(spec, prompt)

    # What to trade, as distinct from when. `signal()` cannot name a ticker or
    # choose an instrument — that is engine config — so it is extracted here and
    # returned as a patch the UI saves onto the strategy.
    setup = extract_setup(prompt, history=history, current=current_setup)

    ctx = _probe_ctx()
    runner = make_runner()

    messages = [{"role": "system", "content": SYSTEM}]
    messages += list(history or [])
    if current_source:
        messages.append({"role": "system",
                         "content": f"The current strategy is:\n\n{current_source}\n\n"
                                    "Modify it as asked and return the complete function."})
    messages.append({"role": "user", "content": prompt})

    attempts, last = 0, None
    for attempt in range(MAX_REPAIRS + 1):
        attempts = attempt + 1
        resp = groq_chat(messages, model=model or MODEL_SMART, max_tokens=GEN_TOKENS)
        source = _strip(resp.choices[0].message.content or "")
        if not source:
            messages.append({"role": "user", "content": "You returned nothing. Return the Python function."})
            continue

        res = validate_source(source, ctx, runner)
        diags = [d.as_dict() for d in res.diagnostics]
        # L7 only runs on code that is already safe — telling a model its
        # thresholds are wrong while it also has a syntax error wastes a retry.
        mismatches = conformance(source, spec) if res.ok else []
        diags += mismatches
        # Only demonstrable mismatches (wrong threshold, inverted comparison)
        # force a retry. "Never uses X" is advisory: the extractor may have named
        # the wrong helper for what the user described, and rejecting correct
        # code over a misread request is worse than shipping it with a note.
        blocking = [m for m in mismatches if m.get("severity") == "error"]
        last = {"source": source, "diagnostics": diags}

        if res.ok and not blocking:
            return {"ok": True, "source": source, "diagnostics": diags,
                    "attempts": attempts, "intent": intent, "explanation": None,
                    "spec": spec, "setup": setup}

        problems = [d.message for d in res.errors] + [m["message"] for m in blocking]
        logger.info("generate attempt %d failed: %s", attempts, "; ".join(problems))
        if attempt == MAX_REPAIRS:
            break

        repair = res.repair_prompt() if not res.ok else (
            "The code runs and is causal, but it does not match what was asked. Fix these and "
            "return the whole function again:\n"
            + "\n".join(f"- {m['message']}" for m in blocking))
        messages += [{"role": "assistant", "content": source},
                     {"role": "user", "content": repair}]

    return {"ok": False, "source": (last or {}).get("source"),
            "diagnostics": (last or {}).get("diagnostics", []),
            "attempts": attempts, "intent": intent, "explanation": None,
            "spec": spec, "setup": setup}
