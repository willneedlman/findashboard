import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers.portfolio import _tail_metrics  # noqa: E402


def test_losing_tail_is_positive():
    final = np.linspace(0.5, 1.5, 1000)

    var_95, cvar_95 = _tail_metrics(final)

    assert var_95 > 0
    assert cvar_95 > 0


def test_tail_that_finishes_ahead_is_negative_so_callers_cannot_print_it_as_a_loss():
    final = np.linspace(1.2, 2.0, 1000)

    var_95, cvar_95 = _tail_metrics(final)

    assert var_95 < 0
    assert cvar_95 < 0


def test_cvar_is_never_less_severe_than_var():
    rng = np.random.default_rng(7)
    for _ in range(50):
        final = np.exp(rng.normal(0.05, 0.3, 500))

        var_95, cvar_95 = _tail_metrics(final)

        assert cvar_95 >= var_95


def test_degenerate_tail_falls_back_to_var():
    final = np.full(100, 1.1)

    var_95, cvar_95 = _tail_metrics(final)

    assert var_95 == cvar_95
