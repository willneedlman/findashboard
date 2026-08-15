import pytest

import cycle


def _obs(values, start_year=2025):
    return [{"date": f"{start_year}-{(i % 12) + 1:02d}-01", "value": v} for i, v in enumerate(values)]


def _patch(monkeypatch, mapping: dict[str, list]):
    monkeypatch.setattr(cycle, "_values", lambda sid, limit: mapping.get(sid, []))


def test_score_clamps_at_both_ends():
    assert cycle._score(5.0, good=1.0, bad=-0.5) == 1.0
    assert cycle._score(-9.0, good=1.0, bad=-0.5) == -1.0
    assert cycle._score(0.25, good=1.0, bad=-0.5) == pytest.approx(0.0, abs=0.01)


def test_sahm_gap_uses_the_prior_twelve_month_low_not_the_prior_print(monkeypatch):
    """The Sahm rule is a 3-month average against the trailing 12-month minimum.
    Comparing to last month instead would miss a slow grind upward, which is the
    exact shape it was designed to catch."""
    # Twelve months at 3.5, then a grind to 4.2: gap is 0.7, past the trigger.
    _patch(monkeypatch, {"UNRATE": _obs([3.5] * 12 + [3.9, 4.1, 4.2])})
    out = cycle._sahm()
    assert out["value"] == pytest.approx(0.57, abs=0.02)
    assert out["reading"] == "triggered"
    assert out["score"] < 0


def test_sahm_clear_when_unemployment_is_flat(monkeypatch):
    _patch(monkeypatch, {"UNRATE": _obs([4.0] * 15)})
    out = cycle._sahm()
    assert out["value"] == 0.0
    assert out["reading"] == "clear"
    assert out["score"] == 1.0


def test_inverted_curve_scores_negative(monkeypatch):
    _patch(monkeypatch, {"T10Y2Y": _obs([0.5, -0.4])})
    out = cycle._curve()
    assert out["reading"] == "inverted"
    assert out["score"] < 0


def test_claims_measured_against_their_own_trough(monkeypatch):
    _patch(monkeypatch, {"ICSA": _obs([200_000.0] * 29 + [260_000.0])})
    out = cycle._claims()
    assert out["value"] == pytest.approx(30.0)
    assert out["reading"] == "rising"


def test_payrolls_are_a_three_month_average_of_the_change(monkeypatch):
    # Level series stepping by 300k, 200k, 100k -> average 200k.
    _patch(monkeypatch, {"PAYEMS": _obs([1000.0, 1300.0, 1500.0, 1600.0])})
    out = cycle._payrolls()
    assert out["value"] == pytest.approx(200.0)
    assert out["reading"] == "solid"


def test_composite_is_the_mean_of_whatever_resolved(monkeypatch):
    """A dead feed has to narrow the base, not score zero. Treating a missing
    series as neutral would drag every reading toward the middle and quietly
    make the panel less decisive the more broken it got."""
    _patch(monkeypatch, {"T10Y2Y": _obs([2.0])})       # only the curve resolves
    out = cycle.cycle.__wrapped__()
    assert out["available"] is True
    assert out["resolved"] == 1
    assert out["composite"] == out["components"][0]["score"]


def test_no_series_at_all_says_so(monkeypatch):
    _patch(monkeypatch, {})
    out = cycle.cycle.__wrapped__()
    assert out["available"] is False
    assert "FRED" in out["reason"]


def test_phase_labels_track_the_composite(monkeypatch):
    _patch(monkeypatch, {"T10Y2Y": _obs([2.0])})       # strongly positive
    assert cycle.cycle.__wrapped__()["phase"] == "Expansion"
    _patch(monkeypatch, {"T10Y2Y": _obs([-1.5])})      # deeply inverted
    assert cycle.cycle.__wrapped__()["phase"] == "Contraction"


def test_every_component_carries_the_rule_it_is_judged_by(monkeypatch):
    """The panel's whole claim is that it can be argued with, which needs the
    threshold printed next to the level."""
    _patch(monkeypatch, {
        "T10Y2Y": _obs([1.0]),
        "ICSA": _obs([200_000.0] * 30),
        "UNRATE": _obs([4.0] * 15),
        "PAYEMS": _obs([1000.0, 1150.0, 1300.0, 1450.0]),
        "BAMLH0A0HYM2": _obs([3.5]),
    })
    out = cycle.cycle.__wrapped__()
    assert out["resolved"] == 5
    for component in out["components"]:
        assert component["rule"], component["key"]
        assert -1.0 <= component["score"] <= 1.0
        assert component["as_of"]


def test_expansion_blurb_does_not_claim_agreement_it_has_not_got(monkeypatch):
    """A composite above the expansion line said "the indicators are pointing the
    same way" while payroll growth sat below it flagged slow in red. The header
    is the part people read, so it has to survive a look at its own table."""
    # Curve, claims, Sahm and credit positive, payrolls shrinking. The composite
    # still clears the expansion line, which is exactly the case that used to
    # print agreement over a red component.
    _patch(monkeypatch, {
        "T10Y2Y": _obs([2.0]),
        "ICSA": _obs([200_000.0] * 30),
        "UNRATE": _obs([4.0] * 15),
        "PAYEMS": _obs([1000.0, 1000.0, 1000.0, 990.0]),
        "BAMLH0A0HYM2": _obs([4.6]),
    })
    out = cycle.cycle.__wrapped__()

    assert out["phase"] == "Expansion"
    assert out["components_up"] < out["resolved"]
    assert "pointing the same way" not in out["blurb"]
    assert f"{out['components_up']} of {out['resolved']}" in out["blurb"]


def test_agreement_is_still_claimed_when_every_component_agrees(monkeypatch):
    _patch(monkeypatch, {
        "T10Y2Y": _obs([2.0]),
        "ICSA": _obs([200_000.0] * 30),
        "UNRATE": _obs([4.0] * 15),
        "PAYEMS": _obs([1000.0, 1150.0, 1300.0, 1450.0]),
        "BAMLH0A0HYM2": _obs([2.5]),
    })
    out = cycle.cycle.__wrapped__()

    assert out["components_up"] == out["resolved"]
    assert out["blurb"] == "The indicators are pointing the same way, and that way is up."
