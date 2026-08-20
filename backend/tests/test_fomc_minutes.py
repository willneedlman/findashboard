import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from routers import rates as R  # noqa: E402


class _Resp:
    def __init__(self, status=200, text=""):
        self.status_code = status
        self.text = text


def test_minutes_falls_back_when_the_newest_meeting_has_none(monkeypatch):
    """Minutes land ~3 weeks after the meeting, so the newest meeting usually
    has no page yet and the resolver must walk back rather than give up."""
    seen = []

    def head(url, **kw):
        seen.append(url)
        return _Resp(404 if len(seen) == 1 else 200)

    monkeypatch.setattr(R.requests, "head", head)
    got = R._latest_fomc_minutes()
    assert got is not None
    date_, url = got
    assert url.endswith(".htm") and "fomcminutes" in url
    assert url.endswith(f"fomcminutes{date_.replace('-', '')}.htm")
    assert len(seen) == 2  # first meeting 404'd, second answered


def test_minutes_returns_none_when_nothing_is_published(monkeypatch):
    monkeypatch.setattr(R.requests, "head", lambda url, **kw: _Resp(404))
    assert R._latest_fomc_minutes() is None


def test_doc_text_slices_from_the_policy_section(monkeypatch):
    """The attendance roll and staff review carry no policy signal, so the
    minutes must be read from the participants' discussion onward."""
    body = (
        "<html><body>A joint meeting of the Federal Open Market Committee. "
        "ATTENDANCE Jerome H. Powell, Chair. Staff Review of the Economic Situation "
        "blah. Committee Policy Action nine members agreed to maintain the target "
        "range.</body></html>"
    )
    monkeypatch.setattr(R.requests, "get", lambda url, **kw: _Resp(200, body))
    text = R._fed_doc_text("http://x", R._MINUTES_ANCHORS, 9000)
    assert text.startswith("Committee Policy Action")
    assert "ATTENDANCE" not in text


def test_statement_anchors_are_unchanged(monkeypatch):
    body = "<html><body>Nav junk. Recent indicators suggest activity expanded.</body></html>"
    monkeypatch.setattr(R.requests, "get", lambda url, **kw: _Resp(200, body))
    assert R._fed_doc_text("http://x").startswith("Recent indicators")


def test_unavailable_document_never_raises(monkeypatch):
    monkeypatch.setattr(R.requests, "get", lambda url, **kw: _Resp(404))
    assert R._fed_doc_text("http://x", R._MINUTES_ANCHORS) == ""
