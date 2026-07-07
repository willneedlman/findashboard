"""CLI: print a lexicon-vs-overlay accuracy report over the labeled eval set.

    cd backend && python3 -m sentiment.eval.run            # runs the LLM overlay
    cd backend && python3 -m sentiment.eval.run --offline  # lexicon only, no LLM

The overlay path needs GROQ_API_KEY or CEREBRAS_API_KEY (and SENTIMENT_CORRECTION
unset or 1); without a key it degrades to the lexicon and says so.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from sentiment.eval import harness  # noqa: E402

_MARK = {True: "ok ", False: "XX "}
_TAG = {"FIXED": "\033[32mFIXED\033[0m", "BROKE": "\033[31mBROKE\033[0m",
        "adjusted": "adjusted", "same": ""}


def main() -> int:
    ap = argparse.ArgumentParser(description="Sentiment lexicon-vs-overlay eval")
    ap.add_argument("--offline", action="store_true", help="lexicon only, skip the LLM overlay")
    args = ap.parse_args()

    has_key = bool(os.getenv("GROQ_API_KEY") or os.getenv("CEREBRAS_API_KEY"))
    if not args.offline and not has_key:
        print("! No GROQ_API_KEY/CEREBRAS_API_KEY set — overlay degrades to lexicon.\n")

    rep = harness.evaluate(offline=args.offline)

    print(f"  {'exp':<8} {'lexicon':<8} {'overlay':<8}  outcome  headline")
    print("  " + "-" * 78)
    for r in rep["rows"]:
        print(f"  {r['expected']:<8} {_MARK[r['lex_ok']]}{r['lexicon']:<5} "
              f"{_MARK[r['ov_ok']]}{r['overlay']:<5} {_TAG.get(r['outcome'], ''):<8} {r['title'][:52]}")

    lex_acc, ov_acc = rep["lexicon_accuracy"], rep["overlay_accuracy"]
    print("\n  " + "=" * 78)
    print(f"  n={rep['n']}   lexicon {lex_acc:.0%}   overlay {ov_acc:.0%}   "
          f"delta {ov_acc - lex_acc:+.0%}")
    print(f"  overlay touched {rep['corrected']}  ->  fixed {rep['fixed']}, broke {rep['broke']}")
    if rep["offline"]:
        print("  (offline: overlay == lexicon)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
