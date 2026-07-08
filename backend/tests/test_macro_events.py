"""Macro Event Release Hub — network-free tests for the pure formatting helpers.

The FRED and yfinance calls are not exercised here (they need the network); this
locks the value rendering, period labels, and surprise wording that shape every
card.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers.macro_events import _fmt, _period_label, _next_period_label, _direction


def test_fmt_renders_each_unit():
    assert _fmt("yoy", 2.82) == "2.8% y/y"
    assert _fmt("mom", 0.13) == "0.1% m/m"
    assert _fmt("pct", 4.2) == "4.2%"
    assert _fmt("k", 147) == "+147K"
    assert _fmt("k", -12) == "-12K"


def test_period_label_month_and_quarter():
    assert _period_label("2026-05-01", "m") == "May 2026"
    assert _period_label("2026-01-01", "q") == "Q1 2026"
    assert _period_label("2026-10-01", "q") == "Q4 2026"


def test_next_period_label_rolls_over():
    assert _next_period_label("2026-05-01", "m") == "Jun 2026"
    assert _next_period_label("2026-12-01", "m") == "Jan 2027"     # year rollover
    assert _next_period_label("2026-01-01", "q") == "Q2 2026"
    assert _next_period_label("2026-10-01", "q") == "Q1 2027"      # quarter + year rollover


def test_direction_wording():
    assert _direction(2.8, 2.7) == "higher than"
    assert _direction(4.2, 4.3) == "lower than"
    assert _direction(4.2, 4.2) == "level with"
