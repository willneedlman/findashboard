"""Reasoning models emit a visible scratchpad ahead of the answer.

Qwen does it on every call and gpt-oss does it on the Cerebras fail-over path,
so this is the normal case for two of three providers, not an edge case.
"""
import pytest

from ai_client import parse_json, strip_reasoning


def test_a_draft_inside_the_scratchpad_is_not_mistaken_for_the_answer():
    """The regression this guards: parse_json used to salvage the first {...} it
    could find, which is the model's rough work when the scratchpad contains a
    draft. On portfolio import that silently imports the wrong positions."""
    raw = (
        "<think>\n"
        'Draft: {"holdings": [{"ticker": "WRONG", "shares": 999}]}\n'
        "That is wrong, redo it.\n"
        "</think>\n"
        '{"holdings": [{"ticker": "AAPL", "shares": 150}]}'
    )
    assert parse_json(raw) == {"holdings": [{"ticker": "AAPL", "shares": 150}]}


@pytest.mark.parametrize("tag", ["think", "thinking", "reasoning"])
def test_every_scratchpad_tag_is_removed(tag):
    raw = f"<{tag}>noise {{\"a\": 1}}</{tag}>\n{{\"b\": 2}}"
    assert parse_json(raw) == {"b": 2}


def test_tag_matching_is_case_insensitive():
    assert parse_json('<THINK>junk</THINK>{"ok": true}') == {"ok": True}


def test_a_multiline_scratchpad_is_removed_whole():
    raw = "<think>\nline one\nline two\nline three\n</think>\n[1, 2, 3]"
    assert parse_json(raw) == [1, 2, 3]


def test_plain_output_is_untouched():
    assert strip_reasoning('{"a": 1}') == '{"a": 1}'
    assert parse_json('{"a": 1}') == {"a": 1}


def test_a_fenced_answer_after_a_scratchpad_still_parses():
    raw = '<think>weighing it up</think>\n```json\n{"a": 1}\n```'
    assert parse_json(raw) == {"a": 1}


def test_none_and_empty_are_safe():
    assert strip_reasoning(None) == ""
    assert strip_reasoning("") == ""


def test_an_unclosed_tag_is_left_alone_rather_than_eating_the_answer():
    """A truncated response should fail loudly at the JSON layer, not have its
    remaining content silently deleted by a greedy strip."""
    raw = '<think>cut off mid-thought {"a": 1}'
    assert "<think>" in strip_reasoning(raw)
