"""Best-effort full-article-text extraction for a small, selected subset of
evidence URLs — not a general scraper, and deliberately narrow in scope:

  - Used ONLY as ephemeral input to the LLM synthesis call in mover_radar.py.
    The extracted text is never cached, never stored, and never returned in
    any API response — the frontend only ever sees headline/url/source, same
    as every other evidence item. This is "read a few articles to help write
    an accurate summary," not "republish scraped content."
  - The LLM is explicitly instructed (see mover_radar._build_llm_prompt) to
    paraphrase facts from these excerpts in its own words, not quote them.
  - Best-effort only: paywalled sites, JS-rendered pages with no server HTML,
    and outright blocks all just return None. No retries, no escalation —
    if the first plain fetch doesn't yield readable text, move on.
  - Google News' own redirect links (news.google.com/rss/articles/...) are
    NOT resolved here — Google deliberately obfuscates the real destination
    (no meta-refresh, no discoverable redirect target in the served HTML;
    verified live), and reverse-engineering that encoding is exactly the kind
    of adversarial scraping this module intentionally avoids. Deep-reading is
    restricted to sources that hand back a real, direct publisher URL
    (Alpha Vantage, Marketaux, NewsData.io, and the fixed CNBC/MarketWatch/WSJ
    feeds) — see mover_radar._select_deep_read_candidates.
"""
from __future__ import annotations

import logging

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)
_TIMEOUT = 8
_MAX_CHARS = 2500
_UA = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
}


def extract_article_text(url: str, max_chars: int = _MAX_CHARS) -> str | None:
    """The likely main-body text of the article at `url`, truncated to
    `max_chars`, or None on any failure (paywall, block, non-article page,
    timeout). Never raises."""
    if not url:
        return None
    try:
        resp = requests.get(url, headers=_UA, timeout=_TIMEOUT)
        if resp.status_code != 200 or "text/html" not in resp.headers.get("content-type", ""):
            return None
        soup = BeautifulSoup(resp.content, "lxml")
    except Exception as exc:
        logger.info("article extract failed for %s: %s", url, exc)
        return None

    for tag in soup(["script", "style", "nav", "header", "footer", "aside", "form"]):
        tag.decompose()

    # Prefer a real <article> container when the page has one; otherwise take
    # every <p> on the page — noisier (nav/related-links text can leak in),
    # but works across arbitrary site templates without per-site rules.
    container = soup.find("article") or soup
    paragraphs = [p.get_text(" ", strip=True) for p in container.find_all("p")]
    text = " ".join(p for p in paragraphs if len(p) > 40)   # drop short boilerplate lines (bylines, captions)
    if len(text) < 200:
        return None   # not enough real content — likely a paywall stub or JS-rendered shell
    return text[:max_chars]
