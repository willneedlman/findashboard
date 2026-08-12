"""The earnings catalyst must never state something the evidence contradicts.

Two real failures drove these tests, both on NBIS:

  1. yfinance reported 2026-08-12 08:00 for a release that actually crossed the
     evening of 2026-08-11, so the panel said "2h ago before the open". Its clock
     time is rounded — the same ticker shows 06:00/07:00/08:00/09:00/12:00 across
     six quarters — so a session is only claimed when the issuer's own history is
     consistent.
  2. yfinance then dropped the quarter's row entirely, which silently promoted the
     PREVIOUS quarter to "last report". Pairing its EPS with today's headline
     reported a +396% beat using May's numbers.
"""
import datetime as dt

import pytest

import mover_radar as mr
from social_schema import NewsEvent, utc_now


def event(headline, hours_ago=2.0, source="NewsData"):
    return NewsEvent(
        ticker="NBIS",
        source_name=source,
        headline_or_text=headline,
        url=None,
        timestamp=utc_now() - dt.timedelta(hours=hours_ago),
        sentiment_score=None,
    )


# ── detecting a report from the newswire ──────────────────────────────────────

@pytest.mark.parametrize("headline", [
    "Earnings Flash (NBIS) Nebius Group N.V. Reports Q2 Revenue $582.3M",
    "Nebius surges after Q2 beat; plans to continue investing in capex",
    "NBIS Stock Surges After Nebius Q2 Revenue Soars 454%",
    "Apple reports second-quarter results",
    "Microsoft tops estimates on cloud strength",
])
def test_a_result_headline_is_detected(headline):
    assert mr._earnings_signal_from_evidence([event(headline)]) is not None


@pytest.mark.parametrize("headline", [
    "Nebius Q3 earnings preview: what to watch",
    "Nebius to report Q3 results on November 11",
    "Nebius schedules Q3 earnings call",
    "Investors position ahead of Q3 earnings",
    "Analyst raises Nebius price target to $150",
    "Nebius Group NBIS Stock Jumps On $1B AI Deal",
])
def test_a_preview_or_unrelated_item_is_not_a_report(headline):
    assert mr._earnings_signal_from_evidence([event(headline)]) is None


def test_the_earliest_matching_headline_sets_the_timing():
    """The wire that broke it first is closest to the release, not the loudest."""
    signal = mr._earnings_signal_from_evidence([
        event("NBIS Stock Surges After Nebius Q2 Revenue Soars 454%", hours_ago=2),
        event("Earnings Flash (NBIS) Reports Q2 Revenue $582.3M", hours_ago=15),
        event("Nebius surges after Q2 beat", hours_ago=6),
    ])
    assert signal["corroborating"] == 3
    assert signal["hoursAgo"] == pytest.approx(15, abs=0.2)


# ── what the headline says ────────────────────────────────────────────────────

def _headline(signal_hours, feed_date, eps_actual=None, eps_estimate=None, surprise=None):
    at = (utc_now() - dt.timedelta(hours=signal_hours)).isoformat()
    return mr._earnings_headline({
        "news_signal": {"at": at, "hoursAgo": signal_hours, "headline": "Reports Q2",
                        "source": "NewsData", "corroborating": 3},
        "last_report": {"date": feed_date, "epsActual": eps_actual,
                        "epsEstimate": eps_estimate, "surprisePct": surprise,
                        "withinWindow": True, "hoursAgo": signal_hours},
    })


def test_a_stale_quarter_in_the_feed_is_never_quoted_as_this_report():
    """The +396% regression: May's EPS attributed to an August print."""
    out = _headline(signal_hours=15, feed_date="2026-05-13",
                    eps_actual=2.11, eps_estimate=-0.71, surprise=396.14)
    assert "2.11" not in out
    assert "396" not in out
    assert "has not posted this quarter" in out


def test_the_feed_is_quoted_when_it_describes_the_same_report():
    today = utc_now().date().isoformat()
    out = _headline(signal_hours=3, feed_date=today,
                    eps_actual=1.62, eps_estimate=1.40, surprise=15.7)
    assert "1.62" in out and "1.4" in out and "beat" in out


def test_timing_is_expressed_in_days_not_a_false_clock_time():
    """The feed's hour is rounded, so the copy must not imply precision."""
    out = _headline(signal_hours=15, feed_date="2026-05-13")
    assert "yesterday" in out
    assert "before the open" not in out and "after the close" not in out


def test_a_report_from_today_says_today():
    assert "today" in _headline(signal_hours=3, feed_date="2026-05-13")


def test_corroboration_count_is_stated_when_several_wires_carried_it():
    assert "3 sources carried it" in _headline(signal_hours=3, feed_date="2026-05-13")


# ── falling back to the feed when no headline corroborates ────────────────────

def test_without_a_headline_the_feed_may_be_used_but_states_no_clock_time():
    out = mr._earnings_headline({"last_report": {
        "date": "2026-07-30", "timing": None, "timingConfident": False,
        "epsActual": None, "epsEstimate": -0.5, "withinWindow": True, "hoursAgo": 5,
    }})
    assert "2026-07-30" in out
    assert "before the open" not in out and "after the close" not in out


def test_a_consistent_issuer_keeps_its_session_label():
    out = mr._earnings_headline({"last_report": {
        "date": "2026-07-30", "timing": "after the close", "timingConfident": True,
        "epsActual": 2.02, "epsEstimate": 1.89, "surprisePct": 6.74,
        "withinWindow": True, "hoursAgo": 5,
    }})
    assert "after the close" in out and "beat" in out


def test_a_report_outside_the_window_produces_nothing():
    assert mr._earnings_headline({"last_report": {
        "date": "2026-05-13", "withinWindow": False, "hoursAgo": 400,
    }}) is None


def test_no_earnings_data_produces_nothing():
    assert mr._earnings_headline(None) is None
    assert mr._earnings_headline({}) is None


# ── materiality ───────────────────────────────────────────────────────────────

def test_a_corroborated_print_is_material_even_with_a_flat_bar():
    """A gap the bars have not recorded must not be filed as noise."""
    flat = {"relative_volume": 1.0, "extended": None}
    assert mr._has_material_evidence([], flat, {"news_signal": {"hoursAgo": 2}}) is True
