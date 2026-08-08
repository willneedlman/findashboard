from build_inv import row, prov
C = 'backend/routers/corporate.py'

row('insider_transactions','feed_field','Company Profile','Insider transactions (Form 4)',
    'Recent open-market buys and sells by officers, directors and 10% holders.',
    '-', 'LSEG insider tables where present, yfinance fallback',
    prov('/api/corporate/hub/insider', f'{C}:505'),
    'on request, cached',
    'Cluster buying by several insiders is the classic signal; a single sale is usually a scheduled 10b5-1 disposal and carries little information. Read the transaction classification, not just the direction.',
    'Form 4 has a two-business-day filing deadline, so the data is days old at best. Option exercises and tax withholding sales appear as transactions and dominate the raw counts. LSEG coverage is partial; most tickers fall through to yfinance.')

row('institutional_ownership','feed_field','Company Profile','Institutional and insider ownership',
    'Percentage held by institutions and by insiders, with the top holders and fund holders.',
    '-  (passive/active split comes from the LSEG rollup where it exists)',
    'LSEG ownership tables, yfinance fallback',
    prov('/api/corporate/institutional', f'{C}:1140'),
    '13F quarterly; cached 12h',
    'High institutional ownership means the register is concentrated in hands that move in size. The passive/active split matters more than the headline: a name that is 40% index-held has a different float dynamic from one that is 40% actively held.',
    'From 13F filings, which cover long US equity positions only: no shorts, no derivatives, no non-US managers. Filed up to 45 days after quarter end, so it is up to four months stale at the end of a cycle.')

row('institutional_changes','derived_metric','Company Profile','Quarter-over-quarter position changes',
    'Which holders added, which trimmed, the net share change and the biggest moves each way.',
    'per-holder pct_change since the prior filing; counts split at +/-0.5%; net = sum(shares * pct/(100+pct))',
    'yfinance pctChange field, or LSEG change_shares normalised to a percentage',
    prov('/api/corporate/institutional', f'{C}:1145 _position_changes()'),
    '13F quarterly; cached 12h',
    'The holders table is nearly static quarter to quarter; the change is the part that carries information and answers "what are funds accumulating". AAPL last filing: 5 added, 2 trimmed.',
    'yfinance reports a brand-new position as +100%, indistinguishable from a doubled one, so both are counted as "added" rather than guessed at. Same 45-day 13F lag as the ownership figures.')

row('analyst_ratings','feed_field','Company Profile','Analyst ratings and price targets',
    'The buy/hold/sell distribution, consensus recommendation, and mean/high/low price target.',
    '-  (implied upside = target_mean / price - 1)',
    'yfinance recommendations and analyst_price_targets',
    prov('/api/corporate/hub/analyst', f'{C}:704'),
    'on request, cached',
    'The level of consensus. Implied upside against the current price is the headline, but the distribution matters more: a mean target hiding a 200-point spread is not consensus.',
    'Sell-side ratings skew structurally positive. Target dates are not published, so a stale target from a departed analyst can sit in the mean indefinitely.')

row('estimate_revisions','derived_metric','Company Profile','Estimate revision momentum',
    'Where consensus EPS has been moving, as distinct from where it is.',
    'consensus EPS now vs 7/30/60/90 days ago per fiscal period, as a percentage; up/down analyst counts over 7 and 30 days; price-target raises and cuts over 120 days',
    'yfinance eps_trend, eps_revisions and upgrades_downgrades',
    prov('/api/corporate/hub/estimates', 'backend/estimates.py:139 revisions()'),
    'on request, cached 6h, persisted',
    'Revision breadth is one of the more durable equity factors. NVDA currently reads rising: FY consensus +7.9% over 90 days, 4 analysts up and 0 down, 24 target raises and no cuts. A rising price on falling estimates is the configuration to be wary of.',
    'Counts are reported as counts and no score is derived from them, because four upgrades is four upgrades. yfinance reports a new coverage initiation with a prior target of 0, which is an absence rather than a target of zero and is nulled. Sparse or absent for small caps and most non-US listings.')

row('credit_quality','model','Company Profile','Synthetic credit rating and Altman Z',
    'A model credit grade from interest coverage, plus the Altman Z bankruptcy score.',
    'interest coverage mapped to a rating through the Damodaran synthetic-rating table; Altman Z from the standard five-ratio formula; implied default spread from the same table',
    'company financials from yfinance/SEC, plus the bundled Damodaran industry dataset',
    prov('/api/corporate/credit', f'{C}:840'),
    'on request, cached',
    'A cheap sanity check on balance-sheet risk when no agency rating exists. Interest coverage under 2x and debt/EBITDA over 4x are the two thresholds the panel colours red at.',
    'Model-based, explicitly NOT an S&P/Moody\'s/Fitch rating, and the panel says so. Altman Z was fitted on manufacturers and is unreliable for financials, REITs and asset-light software. Falls back to a bundled Damodaran snapshot when live financials are missing.')

row('peer_valuation','derived_metric','Peer Comparison','Trading comps',
    'A peer set with P/E, EV/EBITDA, P/S, margins and growth side by side.',
    'per-peer multiples from financials; peer set from sector/industry match',
    'yfinance financials, FMP, bundled us_fundamentals.json seed',
    prov('/api/corporate/peer-valuation', f'{C}:999'),
    'on request, cached',
    'The relative-value read: where a name sits against its own peer group rather than against its own history. Read the median, not the mean, since one loss-making peer distorts a P/E average.',
    'Peer selection is by classification, not by business model, so a diversified company gets an incoherent set. Multiples on negative earnings are suppressed rather than shown as negative. Free-tier FMP caps enrichment, so some peers fall back to the bundled seed.')

row('screener_universe','bundled_dataset','Stock Screener','Screenable universe and fundamentals',
    'The set of names that can be screened, with the fundamental fields available for each.',
    '-', 'bundled data/us_fundamentals.json (~915 Finnhub-sourced names) plus data/index_constituents.json index sets, enriched live from FMP',
    prov('/api/screener/run', 'backend/routers/screener.py:39 _load_universe()'),
    'bundled seed static; live enrichment budgeted per day',
    'The seed is the durable fallback so US names always show stats even when the live budget is spent. Region filter and ETF/international universes extend it.',
    'FMP free tier binds at roughly 250 calls per day, so live enrichment is capped at SCREENER_LIVE_ENRICH=25 per run, 30-day cached, with an in-app daily budget. Beyond that, fields come from the bundled seed and are as old as the last rebuild. Non-US coverage is thinner than US.')

row('sentiment_composite','model','Sentiment Tracker','Composite sentiment score',
    'A 0-100 market sentiment reading built from scored headlines across 19 sources.',
    'lexicon scoring per headline, weighted by source reliability; low-confidence headlines (<=0.55) go to one batched temperature-0 LLM call that can override direction; aggregated to a composite',
    'RSS wires, Finnhub, Reddit specs; Groq/Cerebras for the corrective overlay',
    prov('/api/sentiment/snapshot', 'backend/sentiment/engine.py build_snapshot()'),
    'periodic refresh, history accrued in-process',
    'The lexicon stays primary and the LLM only corrects the uncertain tail, which keeps the score deterministic and cheap. Split into forward-looking and backward-looking subscores, and by asset class, because "the news is bad" and "the news says things will be bad" are different claims.',
    'Reddit is configured with 8 subreddit sources but production returns one, sitting at the neutral default: Reddit blocks datacenter IPs, so any mention-velocity feature built on it would be measuring nothing. Asset-class breakdown covers Equities, Crypto, Macro and Commodities only; FX and fixed income were dropped as too ambiguous to score. History is aggregate, not per ticker.')

row('sentiment_breaking','derived_metric','Sentiment Tracker','Breaking headlines and cross-source dedup',
    'Stories carried by a wire feed, and syndicated duplicates collapsed to one representative.',
    'shingle/Jaccard similarity over titles groups duplicates; the representative carries a seen_in_sources count',
    'the same source set', prov('/api/sentiment/snapshot', 'backend/sentiment/source_manager.py:88 verify()'),
    'per refresh',
    'A story appearing across N feeds is weighted once, not N times, with an "N FEEDS" badge. Prevents a single syndicated wire story from moving the composite.',
    'Similarity is lexical, so a genuinely independent story on the same event with different wording is not merged, and a rewritten headline can escape the grouping.')

row('etf_holdings','feed_field','ETF Analyzer','ETF look-through holdings and overlap',
    'Full or top-25 constituents for an ETF, plus pairwise overlap and concentration across funds.',
    'overlap = shared weight between two funds; concentration = top-N weight sum',
    'SSGA daily holdings .xlsx for SPDR funds (full), Alpha Vantage ETF_PROFILE for others (full, needs key), stockanalysis.com top-25 as last resort',
    prov('/api/etf/xray', 'backend/routers/etf.py:211 holdings loader'),
    'cached 24h',
    'Answers what you actually own across several funds. Overlap is the number that surprises people: two "different" large-cap ETFs frequently share most of their weight.',
    'Alpha Vantage returns holdings for US-equity ETFs but NOT for foreign-market funds (INDA, EWJ return zero holdings), so an international ETF falls back to a partial top-25 flagged `partial`. Free AV key is 25 calls/day, hence the 24h cache.')

row('ipo_calendar','feed_field','IPO Scanner','Upcoming and recent IPOs',
    'Pricing date, range, shares and exchange for listings.',
    '-', 'Finnhub /calendar/ipo, one call',
    prov('/api/ipo/calendar'),
    'daily',
    'A watchlist of supply coming to market. No enrichment, so it is a schedule rather than an analysis.',
    'Finnhub free coverage is inconsistent for smaller listings and withdrawn deals linger. No post-listing performance tracking.')

row('mover_radar','model','Mover Radar','Why a name is moving',
    'Evidence behind an unusual price move: news, filings, social chatter, plus a z-score and relative volume.',
    'z_score of the day return against a trailing distribution; relative_volume against a 20-day average; excess return vs the market',
    'price history, news feeds, EDGAR, LLM synthesis',
    prov('/api/movers/explain'),
    'on request',
    'Separates a real catalyst from noise. A z-score above 2 with no evidence found is itself informative: it says the move is not explained by anything public.',
    'The LLM synthesis is a summary of the evidence listed below it, and when the summarizer is unavailable the page shows the raw evidence rather than nothing. Social coverage is limited by the same dead Reddit path as the sentiment tool.')
