"""Mover Radar — "why is this ticker moving right now."

Pipeline:
  1. Price/volume anomaly: today's move vs the name's own normal daily
     volatility (a z-score, not just raw %) and volume vs its 20-day average.
  2. Market-relative move: same-day SPY (and sector ETF) move, to separate an
     idiosyncratic move from "the whole market/sector did this."
  3. Evidence: every source in news_aggregator.collect() (Alpha Vantage,
     Marketaux, NewsData, StockTwits, RSS, SEC EDGAR filings), filtered to a
     freshness window.
  4. Verdict:
       - Small move (low z-score) AND no fresh evidence  -> "noise", reported
         directly from the heuristics. No LLM call — nothing here for one to
         explain, and asking it to anyway just invites an invented story.
       - Otherwise -> one grounded LLM call synthesizes a plain-English
         explanation FROM the evidence handed to it (cite what's there, say
         "unclear" if the evidence doesn't actually explain the size of the
         move), never asked to reason freely about the ticker.

Cached a few minutes per ticker — this is an expensive multi-source fetch plus
(sometimes) an LLM call, and nothing here changes meaningfully faster than that.
"""
from __future__ import annotations

import datetime as _dt
import logging
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import timedelta

import pandas as pd

from cache import get_download, get_history, get_info
from disk_cache import disk_get, disk_set
from social_schema import NewsEvent, utc_now

import ai_client
import article_extract
import news_aggregator

logger = logging.getLogger(__name__)

_CACHE_TTL = 240              # 4 min
_NOISE_Z_THRESHOLD = 1.25     # below this, the move is within the name's normal daily wobble
_MAX_EVIDENCE_FOR_LLM = 15    # a genuinely relevant roundup headline routinely ranks 11th-15th for a heavily-covered
                              # name (10+ same-tier Google News items alone can fill the old top-10), and this whole
                              # tool's value depends on the model actually seeing that item, not truncating it away
_MATERIAL_SENTIMENT_ABS = 0.40      # |sentiment| below this reads as routine, not a real signal

# Each timeframe is a bar interval + how many bars back the move is measured
# over (5m/15m/30m/1h are 1-bar moves; 1w is a 5-trading-day move on daily
# bars, since yfinance has no native weekly-bar intraday resolution). The
# z-score is always relative to THAT timeframe's own normal step-to-step
# variability, so _NOISE_Z_THRESHOLD/_MATERIAL_* stay meaningful unchanged
# across timeframes — "1.25 sigma" means the same thing whether the bar is
# 5 minutes or 1 week. Freshness scales with the timeframe: a 5-minute move
# needs a headline from the last hour to actually explain it, not one from
# yesterday.
_DEFAULT_TIMEFRAME = "1d"
_TIMEFRAMES = {
    "5m":  {"interval": "5m",  "lookback_days": 5,  "bars_back": 1, "fresh_hours": 1},
    "15m": {"interval": "15m", "lookback_days": 8,  "bars_back": 1, "fresh_hours": 2},
    "30m": {"interval": "30m", "lookback_days": 30, "bars_back": 1, "fresh_hours": 4},
    "1h":  {"interval": "60m", "lookback_days": 60, "bars_back": 1, "fresh_hours": 8},
    "1d":  {"interval": "1d",  "lookback_days": None, "bars_back": 1, "fresh_hours": 30},
    "1w":  {"interval": "1d",  "lookback_days": None, "bars_back": 5, "fresh_hours": 168},
}
_MATERIAL_RELATIVE_VOLUME = 1.5     # trading meaningfully above its own normal volume

# SPDR sector ETFs, keyed by the sector name yfinance reports in .info.
_SECTOR_ETF = {
    "Technology": "XLK", "Communication Services": "XLC", "Consumer Cyclical": "XLY",
    "Consumer Defensive": "XLP", "Financial Services": "XLF", "Healthcare": "XLV",
    "Industrials": "XLI", "Basic Materials": "XLB", "Real Estate": "XLRE",
    "Energy": "XLE", "Utilities": "XLU",
}

# Sources whose URL is the real publisher link, not a redirect — safe to fetch
# for full text. Google News and social posts are excluded: Google's redirect
# obfuscates the destination (see article_extract.py), and social posts aren't
# articles.
_DEEP_READ_SOURCES = {"AlphaVantage", "Marketaux", "NewsData", "CNBC", "MarketWatch", "WSJ"}
_EXPLAINER_KEYWORDS = ("why", "key driver", "explained", "surge", "soar", "rally", "plunge", "jump", "crash", "tumble")
_DEEP_READ_COUNT = 3


def _timeframe_cfg(timeframe: str) -> dict:
    return _TIMEFRAMES.get(timeframe, _TIMEFRAMES[_DEFAULT_TIMEFRAME])


def _normalize_download(raw: pd.DataFrame, ticker: str) -> pd.DataFrame:
    if raw is None or raw.empty:
        return pd.DataFrame()
    if isinstance(raw.columns, pd.MultiIndex):
        try:
            return raw.xs(ticker, axis=1, level="Ticker")
        except KeyError:
            return pd.DataFrame()
    return raw


def _fetch_timeframe_bars(ticker: str, timeframe: str) -> pd.DataFrame:
    """1d/1w reuse the existing daily-history path (proven, FMP/AV-fallback
    aware). Intraday timeframes need real intraday bars, which only
    get_download's `interval` param provides — yfinance's free intraday data
    only reaches back 60 days, hence the short lookback windows."""
    cfg = _timeframe_cfg(timeframe)
    if timeframe == "1w":
        return get_history(ticker, period="2y")
    if timeframe not in ("5m", "15m", "30m", "1h"):
        return get_history(ticker, period="4mo")
    end = _dt.date.today() + _dt.timedelta(days=1)
    start = end - _dt.timedelta(days=cfg["lookback_days"])
    raw = get_download((ticker,), str(start), str(end), interval=cfg["interval"])
    return _normalize_download(raw, ticker)


def _extended_move(ticker: str, last_close: float) -> dict | None:
    """The move that has happened since the last completed bar.

    Bars only exist for sessions that have ended, so a company reporting at
    16:05 and gapping twelve percent registers as a flat day until tomorrow's
    open — which is exactly when a mover radar is least useful. This reads the
    live mark instead and measures it against the last regular close.

    Source depends on the session. Overnight quotes are indicative NBBO
    midpoints rather than trades, so they are labelled as such and never
    presented as prints.
    """
    from market_hours import is_market_open, is_overnight_session, session_label

    if is_market_open() or not last_close:
        return None                                # regular bars already cover it

    session = session_label()
    price = None
    kind = "trade"
    try:
        import alpaca
        if is_overnight_session():
            quote = (alpaca.get_latest_overnight_quotes((ticker,)) or {}).get(ticker.upper()) or {}
            price, kind = quote.get("price"), "indicative quote"
        else:
            price = alpaca.get_latest_price(ticker)
    except Exception as exc:                       # noqa: BLE001 — live mark is best-effort
        logger.debug("mover radar live mark %s unavailable: %s", ticker, exc)

    if price is None and not is_overnight_session():
        try:
            import extended_quotes
            price = (extended_quotes.extended_quote(ticker) or {}).get("price")
        except Exception as exc:                   # noqa: BLE001
            logger.debug("mover radar extended quote %s unavailable: %s", ticker, exc)

    if not price:
        return None
    pct = (float(price) / float(last_close) - 1) * 100
    return {
        "session": session,
        "price": round(float(price), 2),
        "pct_vs_close": round(pct, 2),
        "kind": kind,
        "note": (
            "Indicative overnight quote midpoint, not a trade."
            if kind == "indicative quote"
            else f"Latest {session} print against the regular-session close."
        ),
    }


def _pct_move_n(hist: pd.DataFrame, bars_back: int) -> float | None:
    closes = hist["Close"].dropna()
    if len(closes) < bars_back + 1:
        return None
    return float((closes.iloc[-1] / closes.iloc[-1 - bars_back] - 1) * 100)


def _price_volume_stats(ticker: str, timeframe: str = _DEFAULT_TIMEFRAME) -> dict:
    bars_back = _timeframe_cfg(timeframe)["bars_back"]
    hist = _fetch_timeframe_bars(ticker, timeframe)
    if hist is None or hist.empty or len(hist) < bars_back + 15:
        return {"available": False}
    pct_move = _pct_move_n(hist, bars_back)
    if pct_move is None:
        return {"available": False}
    last_close = float(hist["Close"].dropna().iloc[-1])

    step_returns = hist["Close"].dropna().pct_change(bars_back).dropna()
    baseline_returns = step_returns.iloc[:-1]   # exclude the move being measured from its own baseline
    vol_pct = float(baseline_returns.std() * 100) if len(baseline_returns) > 10 else None
    z_score = (pct_move / vol_pct) if vol_pct and vol_pct > 1e-6 else None

    volumes = hist["Volume"].dropna()
    window_vol = float(volumes.iloc[-bars_back:].sum()) if len(volumes) >= bars_back else None
    avg_volume = None
    if len(volumes) >= bars_back * 21:
        rolling = volumes.rolling(bars_back).sum().dropna()
        avg_volume = float(rolling.iloc[:-1].tail(20).mean())
    relative_volume = (window_vol / avg_volume) if avg_volume and window_vol else None

    extended = _extended_move(ticker, last_close)
    return {
        "available": True, "last_close": round(last_close, 2), "pct_move": round(pct_move, 2),
        "extended": extended,
        # What a reader should treat as "the move right now". Off-hours that is
        # the gap the bars have not caught, not yesterday's completed session.
        "effective_pct_move": round(
            extended["pct_vs_close"] if extended else pct_move, 2),
        "daily_vol_pct": round(vol_pct, 2) if vol_pct else None,
        "z_score": round(z_score, 2) if z_score is not None else None,
        "avg_volume": avg_volume, "today_volume": window_vol,
        "relative_volume": round(relative_volume, 2) if relative_volume else None,
    }


def _earnings_context(ticker: str, fresh_hours: int) -> dict | None:
    """The most recent report and the next scheduled one, with the surprise.

    Earnings arrive through the news feed as prose a model has to infer from,
    which is the weakest possible form of the strongest possible catalyst. A
    structured beat or miss is a fact worth citing, and knowing a print lands
    tonight explains a move a headline search never will.
    """
    ck = f"mover_radar:earn:{ticker}"
    cached = disk_get(ck)
    if cached is not None:
        return cached or None

    out: dict | None = None
    try:
        import yfinance as yf
        df = yf.Ticker(ticker).get_earnings_dates(limit=12)
        if df is not None and not df.empty:
            now = pd.Timestamp.now(tz=df.index.tz)
            past, upcoming = df[df.index < now], df[df.index >= now]
            out = {}
            if not past.empty:
                stamp = past.index[0]
                row = past.iloc[0]
                hours_ago = (now - stamp).total_seconds() / 3600.0
                estimate, actual = row.get("EPS Estimate"), row.get("Reported EPS")
                surprise = row.get("Surprise(%)")
                out["last_report"] = {
                    "at": stamp.isoformat(),
                    "hoursAgo": round(hours_ago, 1),
                    "epsEstimate": None if pd.isna(estimate) else round(float(estimate), 2),
                    "epsActual": None if pd.isna(actual) else round(float(actual), 2),
                    "surprisePct": None if pd.isna(surprise) else round(float(surprise), 2),
                    # yfinance timestamps the release itself, so the hour tells
                    # you before-open from after-close without a separate field.
                    "timing": "before the open" if stamp.hour < 12 else "after the close",
                    # The whole point: is this report new enough to BE the move?
                    "withinWindow": hours_ago <= fresh_hours,
                }
            if not upcoming.empty:
                nxt = upcoming.index[-1]
                out["next_report"] = {
                    "at": nxt.isoformat(),
                    "hoursAway": round((nxt - now).total_seconds() / 3600.0, 1),
                }
            out = out or None
    except Exception as exc:                       # noqa: BLE001 — context is optional
        logger.debug("mover radar earnings context %s unavailable: %s", ticker, exc)

    disk_set(ck, out or {}, ttl=3600)
    return out


def _earnings_headline(earnings: dict | None) -> str | None:
    """One line a brief can cite verbatim, or None when there is nothing to say."""
    last = (earnings or {}).get("last_report") or {}
    if not last.get("withinWindow"):
        return None
    when = f"{last['hoursAgo']:.0f}h ago {last['timing']}"
    actual, estimate, surprise = last.get("epsActual"), last.get("epsEstimate"), last.get("surprisePct")
    if actual is None or estimate is None:
        return f"Reported earnings {when}; EPS actual vs estimate not yet available."
    verb = "beat" if surprise and surprise > 0 else "missed" if surprise and surprise < 0 else "matched"
    tail = f" ({surprise:+.1f}% surprise)" if surprise is not None else ""
    return f"Reported earnings {when}: EPS {actual} vs {estimate} estimate, {verb}{tail}."


def _market_relative_stats(ticker_pct_move: float, sector: str | None, timeframe: str = _DEFAULT_TIMEFRAME) -> dict:
    out = {"spy_pct": None, "sector": sector, "sector_etf": None, "sector_pct": None, "excess_vs_market": None}
    bars_back = _timeframe_cfg(timeframe)["bars_back"]

    spy_hist = _fetch_timeframe_bars("SPY", timeframe)
    spy_moved = _pct_move_n(spy_hist, bars_back) if spy_hist is not None and not spy_hist.empty else None
    if spy_moved is not None:
        out["spy_pct"] = round(spy_moved, 2)
        out["excess_vs_market"] = round(ticker_pct_move - spy_moved, 2)

    etf = _SECTOR_ETF.get(sector or "")
    if etf:
        sec_hist = _fetch_timeframe_bars(etf, timeframe)
        sec_moved = _pct_move_n(sec_hist, bars_back) if sec_hist is not None and not sec_hist.empty else None
        if sec_moved is not None:
            out["sector_etf"] = etf
            out["sector_pct"] = round(sec_moved, 2)
    return out


def _fresh_evidence(events, hours: int = 30):
    cutoff = utc_now() - timedelta(hours=hours)
    return [e for e in events if e.timestamp >= cutoff]


def _has_material_evidence(events, price: dict, earnings: dict | None = None) -> bool:
    """Whether ANYTHING in the fresh evidence is actually strong enough to be
    a catalyst, as opposed to routine coverage (a 13F "shares purchased by
    fund X" filing, a minor analyst price-target tweak) that shows up on every
    ordinary day for a heavily-covered name regardless of whether it moved."""
    # A report inside the window is the catalyst, whether or not the newswire
    # has caught up. Judging that by headline count would call the most
    # explainable move of the quarter unexplained for the first hour.
    if (earnings or {}).get("last_report", {}).get("withinWindow"):
        return True
    # Likewise a real extended-hours gap: bars have not recorded it yet, so
    # every bar-derived signal below reads flat while the stock is moving.
    ext = price.get("extended") or {}
    if abs(ext.get("pct_vs_close") or 0) >= 2.0:
        return True
    if any(e.source_name == "SEC EDGAR" for e in events):
        return True
    if any(e.sentiment_score is not None and abs(e.sentiment_score) >= _MATERIAL_SENTIMENT_ABS for e in events):
        return True
    rel_vol = price.get("relative_volume")
    return bool(rel_vol and rel_vol >= _MATERIAL_RELATIVE_VOLUME)


_CASHTAG_RE = re.compile(r"\$([A-Z]{1,5})\b")
# Financial "roundup" headlines routinely list tickers bare, comma-separated,
# with no $ prefix at all ("INTC, MU, SNDK Stocks Jumped...", "SNDK, TSM, NFLX,
# YUMC") — cashtag-only matching misses these entirely. A plain all-caps
# 2-5 letter token is a solid ticker signal in this context (prose around it
# is title-case), MINUS a stoplist of the acronyms that would otherwise
# false-positive constantly.
_BARE_TICKER_RE = re.compile(r"\b[A-Z]{2,5}\b")
_TICKER_STOPWORDS = {
    "CEO", "CFO", "CTO", "COO", "IPO", "ETF", "ETFS", "SEC", "FDA", "GDP", "EPS",
    "ATH", "ATL", "USA", "US", "AI", "EV", "EVS", "IT", "PR", "NYSE", "NASDAQ",
    "OTC", "ESG", "YOY", "QOQ", "CPI", "FOMC", "FED", "GAAP", "SPAC", "M&A",
}


def _extract_symbols(text: str, exclude: str) -> set[str]:
    cashtags = set(_CASHTAG_RE.findall(text))
    bare = {t for t in _BARE_TICKER_RE.findall(text) if t not in _TICKER_STOPWORDS}
    return (cashtags | bare) - {exclude}


def _co_mentioned_terms(ticker_events: list, exclude: str) -> list[str]:
    """Other tickers mentioned ALONGSIDE this one in its own evidence (a
    StockTwits post name-checking "$MU $SNDK", a bare roundup list "INTC, MU,
    SNDK Stocks Jumped...", or prose like "Micron, SanDisk Break Momentum
    Rally") — these are exactly the peers most likely to share whatever
    sector story is actually driving the move, resolved to company names too
    since prose headlines often say "Micron," not "$MU" or "MU" at all."""
    counts: dict[str, int] = {}
    for e in ticker_events:
        for m in _extract_symbols(e.headline_or_text, exclude):
            counts[m] = counts.get(m, 0) + 1
    symbols = [s for s, _ in sorted(counts.items(), key=lambda kv: -kv[1])][:5]
    terms = list(symbols)
    for sym in symbols:
        try:
            name = (get_info(sym) or {}).get("longName") or (get_info(sym) or {}).get("shortName")
        except Exception:
            name = None
        if name:
            short = name.split(",")[0].split(" Inc")[0].split(" Corp")[0].strip()
            terms.append(short)
            first_word = short.split()[0] if short.split() else None
            # Headlines routinely drop the corporate suffix entirely ("Micron",
            # not "Micron Technology") — a >=4-char first word is distinctive
            # enough to match on without also catching generic single words.
            if first_word and len(first_word) >= 4 and first_word not in terms:
                terms.append(first_word)
    return terms


def _market_context_evidence(ticker_events: list, ticker: str, limit: int = 6) -> list:
    """Unfiltered top headlines from the general RSS feeds (CNBC/MarketWatch/
    WSJ), excluding anything already caught by the ticker-specific search and
    ranked so a headline mentioning a co-mentioned peer/company sorts first.

    A sector-wide story ("memory chip stocks surge on AI demand") routinely
    moves a name without ever naming it — ticker/company-name substring
    matching misses that by construction. This gives the LLM a chance to
    connect a broad headline to THIS ticker's sector when the ticker-specific
    evidence doesn't explain the move on its own. Free — reuses the same
    cached RSS fetch fetch_ticker_mentions() already made."""
    import rss_feeds
    seen_urls = {e.url for e in ticker_events if e.url}
    seen_text = {e.headline_or_text for e in ticker_events}
    boost_terms = [t.lower() for t in _co_mentioned_terms(ticker_events, ticker)]

    candidates = [
        h for h in rss_feeds.fetch_all_headlines()
        if h.url not in seen_urls and h.headline_or_text not in seen_text
    ]

    def relevance(h) -> int:
        text = h.headline_or_text.lower()
        return 0 if any(t in text for t in boost_terms) else 1

    candidates.sort(key=relevance)   # boosted matches first, else original recency order preserved (stable sort)
    return candidates[:limit]


def _select_drill_peers(ticker_evidence: list, ticker: str, count: int = 3) -> list[tuple[str, str | None]]:
    """Which peer tickers to search DIRECTLY, on their own — not wait for them
    to incidentally turn up in this ticker's search results. A peer's own
    dedicated coverage (its earnings call, its guidance, its pricing news)
    routinely explains a sector move better than anything naming THIS ticker,
    because the peer IS the story (TSMC's own price-hike/demand commentary
    moving every memory/chip name in sympathy, without ever naming them)."""
    counts: dict[str, int] = {}
    for e in ticker_evidence:
        for m in _extract_symbols(e.headline_or_text, ticker):
            counts[m] = counts.get(m, 0) + 1
    top_symbols = [s for s, _ in sorted(counts.items(), key=lambda kv: -kv[1])][:count]
    peers = []
    for sym in top_symbols:
        try:
            name = (get_info(sym) or {}).get("longName") or (get_info(sym) or {}).get("shortName")
        except Exception:
            name = None
        peers.append((sym, name))
    return peers


def _peer_context_evidence(ticker_evidence: list, ticker: str, limit_per_peer: int = 6) -> list:
    """Each drilled peer's OWN Google News results (free, no budget), relabeled
    so it's clear in the prompt/UI this is the PEER's coverage, not something
    already tagged to the primary ticker."""
    import rss_feeds
    events = []
    for peer_sym, peer_name in _select_drill_peers(ticker_evidence, ticker):
        try:
            peer_events = rss_feeds.fetch_google_news(peer_sym, peer_name)
        except Exception as exc:
            logger.info("peer drill-down fetch failed for %s: %s", peer_sym, exc)
            continue
        for e in _fresh_evidence(peer_events)[:limit_per_peer]:
            publisher = e.source_name.removeprefix("Google News (").removesuffix(")")
            events.append(NewsEvent(
                timestamp=e.timestamp, source_name=f"{peer_sym} · {publisher}", ticker=e.ticker,
                headline_or_text=e.headline_or_text, sentiment_score=e.sentiment_score,
                url=e.url, raw_payload=e.raw_payload,
            ))
    return events


def _rank_evidence(events) -> list:
    """SEC filings and strong-sentiment news first — the highest-signal,
    most-attributable sources — then everything else by recency."""
    def rank(e):
        if e.source_name == "SEC EDGAR":
            priority = 0
        elif e.source_name in ("AlphaVantage", "Marketaux", "NewsData", "CNBC", "MarketWatch", "WSJ") or e.source_name.startswith("Google News"):
            priority = 1
        else:   # social
            priority = 2
        return (priority, -e.timestamp.timestamp())
    return sorted(events, key=rank)


def _select_deep_read_candidates(ticker_evidence: list, count: int = _DEEP_READ_COUNT) -> list[int]:
    """Indices (into ticker_evidence) of the few items worth fetching full
    text for — only sources with a direct (non-redirect) URL, preferring
    explainer-style headlines ("why," "key driver," "surge"...) over routine
    ones (a price-target tweak, a mechanical 13F filing)."""
    def score(item):
        i, e = item
        if e.source_name not in _DEEP_READ_SOURCES or not e.url:
            return None
        text = e.headline_or_text.lower()
        hits = sum(1 for kw in _EXPLAINER_KEYWORDS if kw in text)
        return (-hits, i)   # more keyword hits first, else earliest (already relevance-ranked)

    scored = [(score(item), item[0]) for item in enumerate(ticker_evidence) if score(item) is not None]
    scored.sort(key=lambda x: x[0])
    return [idx for _, idx in scored[:count]]


def _deep_read_excerpts(ticker_evidence: list, indices: list[int]) -> dict[int, str]:
    """Fetches full-article text for the selected indices CONCURRENTLY.
    Returns only successes (paywalled/blocked/JS-only pages just don't appear
    in the result — analyze() proceeds on headlines alone for those)."""
    if not indices:
        return {}
    excerpts: dict[int, str] = {}
    with ThreadPoolExecutor(max_workers=len(indices)) as pool:
        futures = {pool.submit(article_extract.extract_article_text, ticker_evidence[i].url): i for i in indices}
        for future in as_completed(futures):
            i = futures[future]
            try:
                text = future.result()
            except Exception as exc:
                logger.info("deep-read failed for evidence[%d]: %s", i, exc)
                text = None
            if text:
                excerpts[i] = text
    return excerpts


def _build_llm_prompt(ticker: str, sector: str | None, price: dict, relative: dict,
                       ticker_evidence: list, market_context: list, peer_context: list,
                       excerpts: dict[int, str], earnings: dict | None = None) -> tuple[str, str]:
    system = (
        "You are a markets analyst explaining a single stock's move using ONLY the "
        "evidence provided below. Rules: cite the specific evidence item(s) your "
        "explanation rests on (by index number). Never invent a reason not present "
        "in the evidence. Some items include a 'Full-text excerpt' pulled from the "
        "source article — use it to identify concrete facts (numbers, named "
        "entities, analyst calls) but ALWAYS paraphrase them in your own words; "
        "never quote more than a few consecutive words verbatim from any excerpt. "
        "When an EARNINGS block is present it is structured company data, not a "
        "headline, and it outranks the news: if a report landed inside the window, "
        "lead with it, state the actual against the estimate, and say plainly "
        "whether it beat or missed. Cite it as 'the earnings report' rather than "
        "an index number, since it is not part of the numbered evidence list. "
        "When a LIVE MARK block is present the regular session is closed and the "
        "bars have not recorded the current move: explain the live move, and if "
        "the mark is an indicative quote rather than a trade, say so. "
        "The 'Peer company news' section is that OTHER company's own coverage, not "
        "about this ticker — but a close peer's earnings, guidance, or pricing news "
        "(e.g. a chip foundry announcing a price hike from surging demand) routinely "
        "explains why an entire related industry moved together, so treat a strong "
        "match there as real evidence, not a stretch, and say explicitly it's "
        "peer/sector-driven rather than company-specific. The 'General market/sector "
        "headlines' section is weaker still — NOT confirmed relevant at all — only "
        "cite one if it plausibly connects to this ticker's industry. If nothing here "
        "clearly explains the SIZE of the move, say so plainly instead of "
        "overreaching. Output strict JSON only: "
        '{"summary": "2-3 sentence plain-English explanation", '
        '"confidence": "high"|"medium"|"low", "cited_indices": [int, ...]}'
    )
    lines = [
        f"Ticker: {ticker}" + (f" (sector: {sector})" if sector else ""),
        f"Move (last completed bar): {price['pct_move']:+.2f}% (z-score vs its own normal daily move: {price.get('z_score')})",
        f"Volume: {price.get('relative_volume')}x its 20-day average" if price.get("relative_volume") else "Volume: unavailable",
        f"Vs S&P 500 today: {relative.get('spy_pct')}% (excess/idiosyncratic move: {relative.get('excess_vs_market')})",
    ]
    if relative.get("sector_etf"):
        lines.append(f"Vs its sector ({relative['sector_etf']}) today: {relative.get('sector_pct')}%")

    ext = price.get("extended") or {}
    if ext:
        lines.append(
            f"\nLIVE MARK — the regular session is closed ({ext['session']}). "
            f"{ext['price']} is {ext['pct_vs_close']:+.2f}% against the last regular close of "
            f"{price['last_close']}. Source: {ext['kind']}. {ext['note']} "
            "The bar-based move above predates this and does not include it."
        )

    headline = _earnings_headline(earnings)
    last = (earnings or {}).get("last_report") or {}
    nxt = (earnings or {}).get("next_report") or {}
    if headline or nxt:
        lines.append("\nEARNINGS (structured company data, not a headline):")
        if headline:
            lines.append(f"  {headline}")
            if last.get("epsActual") is not None:
                lines.append(
                    f"  EPS actual {last['epsActual']} vs estimate {last['epsEstimate']}"
                    + (f", surprise {last['surprisePct']:+.1f}%" if last.get("surprisePct") is not None else "")
                )
        elif last:
            lines.append(
                f"  Last reported {last['hoursAgo']:.0f}h ago, outside this timeframe's window "
                "— unlikely to be the cause of the current move."
            )
        if nxt:
            lines.append(
                f"  Next report in {nxt['hoursAway']:.0f}h ({nxt['at'][:10]}). "
                "A move ahead of a print is often positioning, not news."
            )

    lines.append(f"\nEvidence about {ticker} specifically (newest/highest-signal first):")
    for i, e in enumerate(ticker_evidence[:_MAX_EVIDENCE_FOR_LLM]):
        sentiment = f", sentiment {e.sentiment_score:+.2f}" if e.sentiment_score is not None else ""
        lines.append(f"[{i}] ({e.source_name}{sentiment}) {e.headline_or_text[:220]}")
        if i in excerpts:
            lines.append(f"    Full-text excerpt: {excerpts[i]}")

    offset = len(ticker_evidence[:_MAX_EVIDENCE_FOR_LLM])
    if peer_context:
        lines.append("\nPeer company news (a related company's OWN coverage, not about this ticker directly):")
        for j, e in enumerate(peer_context):
            lines.append(f"[{offset + j}] ({e.source_name}) {e.headline_or_text[:220]}")
        offset += len(peer_context)
    if market_context:
        lines.append("\nGeneral market/sector headlines (NOT confirmed to be about this ticker):")
        for j, e in enumerate(market_context):
            lines.append(f"[{offset + j}] ({e.source_name}) {e.headline_or_text[:220]}")
    return system, "\n".join(lines)


def analyze(ticker: str, timeframe: str = _DEFAULT_TIMEFRAME) -> dict:
    sym = ticker.strip().upper()
    tf = timeframe if timeframe in _TIMEFRAMES else _DEFAULT_TIMEFRAME
    cache_key = f"mover_radar:v2:{sym}:{tf}"   # v2 adds the live mark + earnings block
    cached = disk_get(cache_key)
    if cached is not None:
        return cached

    info = get_info(sym) or {}
    company_name = info.get("longName") or info.get("shortName")
    sector = info.get("sector")

    price = _price_volume_stats(sym, tf)
    if not price.get("available"):
        result = {"ticker": sym, "timeframe": tf, "available": False, "reason": "No price history available for this ticker at this timeframe."}
        disk_set(cache_key, result, ttl=_CACHE_TTL)
        return result

    relative = _market_relative_stats(price["pct_move"], sector, tf)

    fresh_hours = _timeframe_cfg(tf)["fresh_hours"]
    # Fetched alongside the news rather than after it: earnings is the single
    # most likely explanation for a large move, and waiting on the slower
    # multi-source news fan-out to start it would add its latency to every call.
    with ThreadPoolExecutor(max_workers=2) as pool:
        earnings_future = pool.submit(_earnings_context, sym, fresh_hours)
        collected = news_aggregator.collect(sym, company_name)
        try:
            earnings = earnings_future.result(timeout=12)
        except Exception as exc:                   # noqa: BLE001 — context is optional
            logger.debug("mover radar earnings context %s: %s", sym, exc)
            earnings = None

    fresh = _fresh_evidence(collected["events"], hours=fresh_hours)
    ranked = _rank_evidence(fresh)

    z = price.get("z_score")
    is_small_move = z is None or abs(z) < _NOISE_Z_THRESHOLD
    # Off-hours the bar-based z-score describes a session that already ended, so
    # a stock gapping on a print would score as small. Judge the live gap instead.
    ext = price.get("extended") or {}
    if ext and price.get("daily_vol_pct"):
        live_z = ext["pct_vs_close"] / price["daily_vol_pct"]
        if abs(live_z) >= _NOISE_Z_THRESHOLD:
            is_small_move = False
    material = _has_material_evidence(ranked, price, earnings)
    # A small move isn't "explained" just because SOME evidence exists — a
    # heavily-covered large-cap has routine analyst notes and mechanical 13F
    # "shares purchased by fund X" filings on every ordinary day, with no
    # relation to whether the stock actually did anything. Noise means no
    # MATERIAL catalyst, not literally zero headlines.
    verdict = "noise" if (is_small_move and not material) else "explained"

    ticker_evidence = ranked[:_MAX_EVIDENCE_FOR_LLM]
    market_context: list = []
    peer_context: list = []
    narrative = None
    if verdict == "explained":
        # Search a wider pool than the top-10 displayed for deep-read
        # candidates — Google News alone often fills every one of the top 10
        # slots for a well-covered name, and its redirect URLs can't be
        # deep-read, so restricting the search to just the displayed 10 would
        # make this almost never fire. A good explainer candidate further down
        # the ranked list (an Alpha Vantage/RSS item with a real URL) gets
        # appended to the evidence list so it has its own citable index.
        deep_read_pool = ranked[:25]
        candidate_positions = _select_deep_read_candidates(deep_read_pool)
        deep_read_items = [deep_read_pool[p] for p in candidate_positions]
        extra = [e for e in deep_read_items if e not in ticker_evidence]
        ticker_evidence = ticker_evidence + extra
        excerpt_targets = [ticker_evidence.index(e) for e in deep_read_items]

        try:
            peer_context = _peer_context_evidence(ticker_evidence, sym)
        except Exception as exc:
            logger.warning("mover radar peer drill-down failed for %s: %s", sym, exc)
            peer_context = []
        try:
            market_context = _market_context_evidence(ticker_evidence, sym)
        except Exception as exc:
            logger.warning("mover radar market context fetch failed for %s: %s", sym, exc)
            market_context = []
        # Full-text excerpts are ephemeral — used only to build this prompt,
        # never cached, never returned to the API/frontend. The LLM is
        # instructed to paraphrase them, not quote them.
        excerpts: dict[int, str] = {}
        try:
            excerpts = _deep_read_excerpts(ticker_evidence, excerpt_targets)
        except Exception as exc:
            logger.warning("mover radar deep-read failed for %s: %s", sym, exc)
            excerpts = {}
        try:
            system, prompt = _build_llm_prompt(sym, sector, price, relative, ticker_evidence, market_context, peer_context, excerpts, earnings)
            raw = ai_client.groq_complete(prompt, system=system, max_tokens=400)
            narrative = ai_client.parse_json(raw)
        except Exception as exc:
            logger.warning("mover radar LLM synthesis failed for %s: %s", sym, exc)
            narrative = None
        if narrative is None:
            # LLM unavailable/failed — evidence still stands on its own, just unsynthesized.
            verdict = "evidence_only"

    result = {
        "ticker": sym, "timeframe": tf, "available": True, "company_name": company_name, "sector": sector,
        "price": price, "relative": relative, "verdict": verdict,
        # Surfaced so the UI can show the catalyst without re-deriving it from prose.
        "earnings": earnings,
        "earningsHeadline": _earnings_headline(earnings),
        "evidence": [
            {"source": e.source_name, "headline": e.headline_or_text, "sentiment": e.sentiment_score,
             "url": e.url, "timestamp": e.timestamp.isoformat(), "is_market_context": False}
            for e in ticker_evidence
        ] + [
            {"source": e.source_name, "headline": e.headline_or_text, "sentiment": e.sentiment_score,
             "url": e.url, "timestamp": e.timestamp.isoformat(), "is_market_context": True}
            for e in peer_context
        ] + [
            {"source": e.source_name, "headline": e.headline_or_text, "sentiment": e.sentiment_score,
             "url": e.url, "timestamp": e.timestamp.isoformat(), "is_market_context": True}
            for e in market_context
        ],
        "narrative": narrative,
        "source_status": collected["source_status"],
        "as_of": utc_now().isoformat(),
    }
    disk_set(cache_key, result, ttl=_CACHE_TTL)
    return result
