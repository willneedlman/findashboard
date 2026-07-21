"""Read-only Reddit ticker mentions — no OAuth, no official API key.

Reddit's official API now requires manual approval even for free,
non-commercial use (the Nov 2025 "Responsible Builder Policy"), on a 2-4 week
timeline with no guarantee of acceptance. This instead reads the public,
unauthenticated .json views reddit.com itself serves to a logged-out browser.

That's a ToS gray area (Reddit's terms are written around the official OAuth
API, not the public site's .json suffix), so this stays deliberately
low-volume and disposable: a short cache TTL, a small subreddit set, and any
failure or block just degrades to an empty result rather than retrying
aggressively or escalating.
"""
import time

import requests

from disk_cache import disk_get, disk_set

_TIMEOUT = 8
_CACHE_TTL = 600          # 10 min — "immediate" without hammering an unauthenticated endpoint
_FAIL_TTL = 120           # short TTL on failure so a transient block clears itself soon
# Finance-relevant subreddits with enough volume to be a useful per-ticker signal.
_SUBREDDITS = "wallstreetbets+stocks+investing+StockMarket+options"
_HEADERS = {
    # Reddit outright blocks generic/default User-Agents even for anonymous
    # reads — a descriptive UA is a hard requirement of their access rules.
    "User-Agent": "alphatape-terminal/1.0 (ticker social-mentions reader; read-only, no auth)",
}


def _search_url(ticker: str) -> str:
    q = f"{ticker} OR %24{ticker}"   # %24 = literal "$TICKER" ticker-tag convention
    return (
        f"https://www.reddit.com/r/{_SUBREDDITS}/search.json"
        f"?q={q}&restrict_sr=1&sort=new&limit=25&t=day"
    )


def ticker_mentions(ticker: str) -> dict:
    """Recent posts mentioning `ticker` across finance subreddits, newest first.

    Never raises — always returns a dict with `available`, so callers (the
    move-explainer's evidence bundle) can degrade gracefully when this
    best-effort source is blocked or empty, same as any other optional signal.
    """
    sym = ticker.strip().upper()
    if not sym:
        return {"available": False, "posts": []}

    cache_key = f"reddit_mentions:v1:{sym}"
    cached = disk_get(cache_key)
    if cached is not None:
        return cached

    try:
        r = requests.get(_search_url(sym), headers=_HEADERS, timeout=_TIMEOUT)
        if r.status_code != 200:
            result = {"available": False, "posts": [], "status": r.status_code}
            disk_set(cache_key, result, ttl=_FAIL_TTL)
            return result
        data = r.json()
    except Exception:
        result = {"available": False, "posts": []}
        disk_set(cache_key, result, ttl=_FAIL_TTL)
        return result

    posts = []
    for child in ((data.get("data") or {}).get("children") or []):
        d = child.get("data") or {}
        title = d.get("title") or ""
        if not title:
            continue
        permalink = d.get("permalink")
        posts.append({
            "title": title,
            "subreddit": d.get("subreddit"),
            "score": d.get("score", 0),
            "num_comments": d.get("num_comments", 0),
            "created_utc": d.get("created_utc"),
            "permalink": f"https://reddit.com{permalink}" if permalink else None,
            "selftext": (d.get("selftext") or "")[:280],
        })
    posts.sort(key=lambda p: p["created_utc"] or 0, reverse=True)

    result = {"available": True, "posts": posts[:15], "fetched_at": int(time.time())}
    disk_set(cache_key, result, ttl=_CACHE_TTL)
    return result
