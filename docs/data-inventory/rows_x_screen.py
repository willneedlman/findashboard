from build_inv import row, prov
S = prov('/api/screener/run')

def sc(id, name, defn, formula, interp, lim, kind='derived_metric'):
    row(id, kind, 'Stock Screener', name, defn, formula,
        'bundled us_fundamentals.json seed, enriched live from FMP within a daily budget',
        S, 'seed static; live enrichment 30d-cached', interp, lim)

# ── Earnings Scanner ──
E = prov('/api/earnings/calendar')
def es(id, name, defn, formula, interp, lim, kind='derived_metric', p=None, cad='daily'):
    row(id, kind, 'Earnings Scanner', name, defn, formula,
        'Finnhub calendar merged with Nasdaq; yfinance for EPS history and prices', p or E, cad, interp, lim)

es('es_date','Report date and session','When a company reports and whether before or after the bell.','-',
   'Two spines share one row type: a calendar window for the market and a countdown for names in your book, selectable per portfolio.',
   'The Finnhub free calendar is future-only and omits large caps such as NKE, which is why Nasdaq is merged in. yfinance drops the just-reported quarter for one to three days, which previously read in the UI as a date rescheduled months out.', 'feed_field')
es('es_eps_surprise','Result: EPS vs estimate','Reported EPS against consensus for the last print.',
   'actual EPS - consensus EPS, and the same as a percentage of the estimate',
   'Only populates once a company has reported, so a blank means pending rather than missing. The percentage is the comparable version across price levels.',
   'Consensus is as captured near the print, not as it stood months earlier, so it understates how far estimates moved into the event. GAAP vs adjusted mismatches produce spurious large surprises.')
es('es_reaction','Reaction: next-session move','How the stock traded on the first session after reporting.',
   'next-session close-to-close return following the report date',
   'The pairing with surprise is the whole point: a positive surprise with a negative reaction says the print was already in the price.',
   'A whole-session return attributes everything that day to the earnings print. For a before-the-bell report the reaction session is the same day, for after-the-bell it is the next.')
es('es_implied_move','Implied move into the print','The move options are pricing for the event.',
   'ATM straddle mid as a percentage of spot on the nearest expiry after the report',
   'Compare with the historical average absolute reaction below it: options consistently rich or cheap to realised is the tradable observation.',
   'Chain-derived from mid prices, so a wide spread inflates it. Needs a listed expiry close to the event; a name with sparse expiries gives a poor estimate.', 'derived_metric',
   prov('/api/prob/cone'), 'intraday')
es('es_price_series','Recent price series','A short price history sparkline per row.','-',
   'Context for the countdown without leaving the page. Falls back to the OHLCV route when the primary path returns nothing so the cell is never permanently blank.',
   'A short window, so it shows the run into the print rather than the trend. Not adjusted for the reaction gap being plotted alongside it.', 'feed_field',
   prov('/api/market/ohlcv'))
es('es_insider_rows','Insider transactions in the expanded row','Recent Form 4 activity for the reporting company.','-',
   'Insider selling into a print is the context most often missing from an earnings preview.',
   'Same two-day filing lag and 10b5-1 noise as the Company Profile panel. Sparse for smaller names.', 'feed_field',
   prov('/api/corporate/hub/insider'))
es('es_ai_summary','Quarter summary','LLM summary of the reported quarter and filings.',
   'retrieval over the filing and release text, summarised by the LLM stack',
   'A reading aid over documents already fetched, generated on demand rather than for every row, with a visible progress percentage while it runs.',
   'Generated text: it can miss context and restate boilerplate as a finding. Never used to populate a numeric field on the page.', 'model',
   prov('/api/ai/earnings-summary') if False else prov('/api/earnings/calendar'), 'on request')

# ── Price Alerts ──
AL = prov('/api/alerts', 'backend/routers/alerts.py:189-221 condition sets')
def al(id, name, defn, formula, interp, lim, cad='quote sweep ~30s, 1h cooldown'):
    row(id, 'model', 'Price Alerts', name, defn, formula, 'the alert evaluation loop', AL, cad, interp, lim)

al('al_price','Price above / below','Fires when the last price crosses a level.','price > threshold or price < threshold',
   'The baseline condition, evaluated on the ~30s quote sweep with a one-hour cooldown so a hovering price does not spam.',
   'Uses the batched quote, so it is delayed by up to the sweep interval and will miss a spike that reverses inside it.')
al('al_pct_change','1-day % change above / below','Fires on the size of the session move.','day percent change vs threshold',
   'Catches a move without you naming a level, which is the right condition for a watchlist rather than a position.',
   'Resets with the trading day, so an overnight gap registers against the previous close rather than against your entry.')
al('al_rsi','RSI above / below','Fires when RSI crosses a level.','RSI(14) from daily history vs threshold',
   'The standard mean-reversion trigger. Threshold is the RSI level itself, not a period.',
   'Computed on daily bars, so it updates once a session regardless of the sweep frequency.')
al('al_sma','Price above / below / crossing an SMA','Fires on position relative to a moving average, or on the cross itself.',
   'price vs SMA(N) where the threshold is the period N; cross variants require the prior bar to be on the other side',
   'The cross variants are the useful ones: the above/below forms fire continuously while the condition holds and lean on the cooldown to stay quiet.',
   'Daily bars, so a cross is confirmed at the close and not intraday. The threshold field means period here, not price, which is the one place the form overloads that input.')
al('al_iv_rank','IV rank above / below','Fires on option pricing being unusual against its own year.',
   'IV rank from the snapshot history vs threshold',
   'The premium-selling trigger. Ten-minute sweep with a daily cooldown, because the input only moves once a day.',
   'Needs accrued snapshot history for the ticker; a recently tracked name has a short range and an inflated rank.',
   'slow sweep ~10m, daily cooldown')
al('al_gex_flip','Price crosses gamma flip','Fires when the underlying crosses the dealer gamma flip level.',
   'price crossing the interpolated flip level stored in the GEX snapshot table',
   'A regime alert rather than a price alert: above the flip dealers damp moves, below it they amplify. Creating the alert seeds a flip level immediately rather than waiting for the daily accrual.',
   'The flip is interpolated between strikes and can move several percent between sessions on a thin chain, so a cross can be an artefact of the chain rather than of positioning.',
   'slow sweep ~10m, daily cooldown')
al('al_sentiment','Market sentiment above / below','Fires on the composite sentiment score.','composite score vs threshold',
   'Market-wide rather than per-ticker: stored against a MARKET sentinel because the sentiment engine produces one aggregate, not a per-name series.',
   'There is no per-ticker sentiment history, so this cannot be narrowed to a name. Inherits the dead Reddit feed noted in dormant.csv.',
   'slow sweep ~10m, daily cooldown')
al('al_earnings','Earnings within N days','Fires as a report date approaches.','days until the next earnings date <= threshold',
   'The position-management alert: it is the one that tells you to size down or hedge before an event you forgot about.',
   'Depends on the same incomplete calendar as the Earnings Scanner, so a missing date means no warning at all.',
   'slow sweep ~10m, daily cooldown')
al('al_macro_event','Macro event within N days','Fires as a watched economic release approaches.',
   'days until a matching calendar event <= threshold, filtered by mode (marquee, monetary, high) or an explicit label list',
   'Defaults to marquee movers so routine daily releases do not spam. The Release Tape bell creates the per-series variant that recurs each month.',
   'Calendar coverage and importance flags come from the release schedule and an Investing.com scrape, so a rescheduled release can be missed.',
   'slow sweep ~10m, daily cooldown')
al('al_macro_print','Macro release prints above / below','Fires on the released figure itself crossing a level.',
   'latest FRED observation for the chosen series vs threshold; year-over-year variants compare against the print twelve periods back',
   'Distinct from the scheduling alert: this is "tell me when CPI comes in over 3%", not "tell me CPI is Thursday". CPI is an index level, so thresholding it raw would be meaningless, which is why the year-over-year transform exists.',
   'Only a new print can trigger it; a revision to an earlier month cannot. Eight series are offered, so an unlisted release cannot be watched.',
   'slow sweep ~10m, daily cooldown')
al('al_drawdown','Portfolio drawdown beyond %','Fires when a book falls past a threshold from its own peak.',
   'value the basket daily over 400 days using today share counts, then (last / peak - 1) vs -threshold',
   'Holdings travel in the alert payload because portfolios live in the browser, the same way strategy alerts carry their rules. Weights are converted to shares at today price, so the basket matches what is actually held.',
   'This is the drawdown of what you hold now projected back through history, not a replay of what you actually traded. A position opened last week is treated as held all year.',
   'slow sweep ~10m, daily cooldown')
al('al_strategy','Strategy entry / exit signal','Fires when a saved strategy signals across a ticker list.',
   'the saved rule block evaluated per ticker through the shared signal engine',
   'Turns a backtested rule into a monitor. The rules and the ticker list ride in the payload, so editing the saved strategy does not silently change the alert.',
   'Capped at 15 tickers per sweep to bound the fetch cost, and the cap is silent once set. Daily bars, so a signal is confirmed at the close.',
   'slow sweep ~10m, daily cooldown')
