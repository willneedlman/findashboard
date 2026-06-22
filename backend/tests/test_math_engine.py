"""Golden-value and invariant tests for the pricing primitives.

`math_engine` carries the closed-form math behind the Options Pricer, Greeks,
IV solvers and Bond Analytics — the numbers a user reads as truth. These lock
known closed-form values and the structural invariants (put-call parity, Greek
signs, par/discount/premium bond pricing) so a silent numeric regression fails
here instead of on a user's screen.
"""
import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from math_engine import (  # noqa: E402
    bond_price,
    bs_core,
    bs_greeks,
    bs_price,
    duration_convexity,
)


# ── Black-Scholes price ───────────────────────────────────────────────────────

def test_atm_call_known_value():
    # S=K=100, 1y, r=0, sigma=20%: closed form gives 100*(N(0.1)-N(-0.1)).
    price = bs_price(100, 100, 365, 0, 20, "call")
    assert price == pytest.approx(7.9656, abs=1e-3)


def test_atm_put_equals_call_when_rate_zero():
    # Put-call parity at the money with r=0 forces C == P.
    call = bs_price(100, 100, 365, 0, 20, "call")
    put = bs_price(100, 100, 365, 0, 20, "put")
    assert call == pytest.approx(put, abs=1e-9)


def test_put_call_parity_general():
    # C - P == S - K*exp(-rT), the no-arbitrage identity, off the money.
    S, K, T_days, r_pct, sig = 100, 95, 180, 5, 25
    call = bs_price(S, K, T_days, r_pct, sig, "call")
    put = bs_price(S, K, T_days, r_pct, sig, "put")
    expected = S - K * math.exp(-(r_pct / 100) * (T_days / 365))
    assert (call - put) == pytest.approx(expected, abs=1e-6)


def test_expiry_returns_intrinsic():
    assert bs_price(110, 100, 0, 5, 20, "call") == pytest.approx(10.0)
    assert bs_price(90, 100, 0, 5, 20, "put") == pytest.approx(10.0)
    assert bs_price(90, 100, 0, 5, 20, "call") == pytest.approx(0.0)


def test_zero_vol_returns_intrinsic():
    assert bs_core(110, 100, 1, 0, 0, "call") == pytest.approx(10.0)


# ── Greeks ────────────────────────────────────────────────────────────────────

def test_greek_signs_and_bounds():
    call = bs_greeks(100, 100, 365, 5, 20, "call")
    put = bs_greeks(100, 100, 365, 5, 20, "put")
    assert 0 < call["delta"] < 1
    assert -1 < put["delta"] < 0
    # gamma and vega are identical across call/put and strictly positive.
    assert call["gamma"] > 0
    assert call["vega"] > 0
    assert call["gamma"] == pytest.approx(put["gamma"], abs=1e-12)
    assert call["vega"] == pytest.approx(put["vega"], abs=1e-12)
    # Long ATM call bleeds time value.
    assert call["theta"] < 0


def test_call_put_delta_differ_by_one():
    call = bs_greeks(100, 105, 200, 4, 30, "call")
    put = bs_greeks(100, 105, 200, 4, 30, "put")
    assert (call["delta"] - put["delta"]) == pytest.approx(1.0, abs=1e-9)


# ── Bonds ─────────────────────────────────────────────────────────────────────

def test_bond_prices_at_par_when_ytm_equals_coupon():
    assert bond_price(1000, 5, 10, 5) == pytest.approx(1000.0, abs=1e-6)


def test_bond_discount_and_premium():
    par = bond_price(1000, 5, 10, 5)
    discount = bond_price(1000, 5, 10, 6)   # ytm above coupon
    premium = bond_price(1000, 5, 10, 4)    # ytm below coupon
    assert discount < par < premium


def test_duration_convexity_properties():
    d = duration_convexity(1000, 5, 10, 5)
    assert d["mod_duration"] > 0
    assert d["mac_duration"] > 0
    assert d["convexity"] > 0
    # Modified duration is Macaulay discounted by one period yield, so smaller.
    assert d["mod_duration"] < d["mac_duration"]
