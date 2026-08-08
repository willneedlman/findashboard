from build_inv import row, prov

H = "backend/breadth.py"
row('breadth_advancing','derived_metric','Market Breadth','Advancing / declining',
    'How many index members closed higher than the previous session, and how many closed lower.',
    'count(close_t > close_t-1) and count(close_t < close_t-1) across every member of the index',
    'yfinance daily closes over the member list in backend/data/index_members.json (bundled + live)',
    prov('/api/market/breadth', f'{H}:120 breadth()'),
    'daily closes, cached 6h, persisted',
    'The unweighted vote. 322 up against 177 means the average stock had a good day regardless of what the cap-weighted index printed. Compare it against the index move: a strong index day on weak advancers is being carried by a handful of large members.',
    'One vote per member, so a 0.01% move counts the same as a 9% one. Only the 17 indices with a tracked member list; the Russell 2000, Shanghai Composite, CSI 300, KOSPI, TAIEX, IPC and Bovespa have no free constituent list and return an explanatory message instead.')

row('breadth_ad_ratio','derived_metric','Market Breadth','A/D ratio',
    'Advancers divided by decliners for the latest session.',
    'advancing / declining; null rather than infinity on a session where nothing fell',
    'computed from the same batched download', prov('/api/market/breadth', f'{H}:131'),
    'daily closes, cached 6h',
    'Above 1 means more members rose than fell. Sustained readings above ~2 are broad buying; below ~0.5 is broad selling. It is a same-day snapshot, so read it with the A/D line rather than on its own.',
    'Undefined when no member declined. A single session is noisy; the A/D line is the version with memory.')

row('breadth_ad_line','derived_metric','Market Breadth','Advance / decline line',
    'Running total of net advancers, rebased to zero at the start of the plotted window.',
    'cumsum(advancing - declining) over the last 126 sessions, rebased to 0',
    'computed', prov('/api/market/breadth', f'{H}:66-84 _series()'),
    'daily closes, cached 6h',
    'The level means nothing; the shape against price is the whole signal. Index rising while the line falls means the rally is being carried by fewer names each week, which is the classic pre-correction pattern. The payload ships the index series alongside it so the two can be read on one chart.',
    'Rebased arbitrarily at the window start, so it cannot be compared across different window lengths or across indices.')

row('breadth_pct_above_ma','derived_metric','Market Breadth','% above 50-day / 200-day',
    'Share of index members trading above their own 50 and 200-session moving average.',
    'count(close > rolling_mean(close, N)) / count(members with a defined N-session average), N in (50, 200)',
    'computed', prov('/api/market/breadth', f'{H}:52-64 _series()'),
    'daily closes, cached 6h',
    'The participation reading. Above 50% is a broad market. The gap between the two lines is the cycle read: 50-day above 200-day is early recovery, 200-day above 50-day is late-cycle with short-term momentum fading. The S&P currently sits at 66% and 74%.',
    'Denominator counts only members with enough history, so a name added to the index last month is excluded rather than counted as "not above". Returns null, never zero, when no member qualifies. A 200-day average needs 200 sessions of run-up, which is why the download reaches back 520 calendar days.')

row('breadth_new_extremes','derived_metric','Market Breadth','New 52-week highs / lows',
    'Members setting a one-year price extreme in that session.',
    'count(close >= rolling_max(close, 252)) and count(close <= rolling_min(close, 252)), min_periods 60',
    'computed', prov('/api/market/breadth', f'{H}:61-64'),
    'daily closes, cached 6h',
    'An expansion in highs confirms a trend. An expansion in BOTH at once means the market is splitting rather than moving as one, which historically precedes trouble more reliably than either series alone.',
    'min_periods of 60 means a name with under a year of history can register an extreme against a partial window. Uses closes, not intraday highs and lows, so it undercounts against a vendor that uses the true range.')

row('breadth_divergence','derived_metric','Market Breadth','Divergence state',
    'Whether the index and participation moved the same way over the last month.',
    'sign(index change over 21 sessions) vs sign(A/D line change over the same window) -> narrowing | broadening | aligned',
    'computed', prov('/api/market/breadth', f'{H}:156-179 _divergence()'),
    'daily closes, cached 6h',
    'Names the thing a breadth chart exists to show, so the reader does not have to eyeball two lines. Narrowing is an index rising on shrinking participation. Broadening is a decline the average member has stopped joining, which often marks the end of it.',
    'A plain comparison of two one-month changes, not a model and not a score. A 21-session window will call a mid-correction bounce "broadening". Both figures are printed next to the verdict so it can be checked.')

S = "backend/seasonality.py"
row('season_month_mean','derived_metric','Seasonality','Average return by month',
    'Mean and median month-end to month-end return for each calendar month, with the hit rate.',
    'resample to month-end, pct_change, group by calendar month; mean, median, share positive, best, worst',
    'yfinance daily closes', prov('/api/market/seasonality', f'{S}:65-68'),
    'on request, cached 6h, persisted',
    'Read the hit rate before the mean: a +2.8% average on a 55% hit rate is one enormous year, while the same average at 80% is a pattern. SPY comes out November best and September worst, which is the documented shape and a useful sanity check that the calculation is sound.',
    'Ten to forty observations per bucket. No significance test is reported and none is implied. Month-end to month-end, so it captures the move you would have held rather than an average of daily returns, which would drop compounding.')

row('season_weekday','derived_metric','Seasonality','Day of week',
    'Average daily return and hit rate by weekday.',
    'group daily pct_change by index.dayofweek; mean, median, share positive',
    'yfinance daily closes', prov('/api/market/seasonality', f'{S}:70'),
    'on request, cached 6h',
    'Texture, not an edge. Effects are a few hundredths of a percent on samples of a few thousand days, and the page says so next to the table.',
    'Differences are well inside the noise for any realistic sample. Ignores holidays and half-days, which cluster on particular weekdays.')

row('season_turn_of_month','derived_metric','Seasonality','Turn of month',
    'Average daily return in the last session of a month plus the first three of the next, against the rest of the month.',
    'flag last 1 and first 3 sessions of each month; compare mean daily return of the flagged set against the remainder',
    'yfinance daily closes', prov('/api/market/seasonality', f'{S}:75-86'),
    'on request, cached 6h',
    'A long-documented pattern usually attributed to pension and payroll flows. The comparison figure matters more than the level: SPY prints 0.07% against 0.04% for the rest of the month.',
    'Session-based, not calendar-based, so a month ending on a weekend shifts the window. No control for month-end index rebalancing, which overlaps the same days.')

row('season_year_grid','derived_metric','Seasonality','Year-by-year grid',
    'Every month of every year in the sample as a heat-shaded percentage.',
    'monthly returns pivoted to year x month', 'yfinance daily closes',
    prov('/api/market/seasonality', f'{S}:88-92'),
    'on request, cached 6h',
    'The audit trail for the averages above it. Scan the column for a month before trusting its mean: one 2008 or one 2020 can carry an entire average on its own.',
    'Partial first and last years appear as short rows, so the top and bottom of the grid are not comparable with the full years between them. Colour intensity is capped at a fixed scale, so two very different large moves shade identically.')

R = "backend/rrg.py"
row('rrg_strength','derived_metric','Sector Rotation','RS-Ratio (relative strength)',
    'How far a sector is ahead of the benchmark, measured against its own one-year normal, centred on 100.',
    '100 + zscore(EMA_10w(sector_close / SPY_close), 52w baseline), then a 3-week average',
    'yfinance weekly closes of the 11 GICS sector ETFs and SPY',
    prov('/api/market/rrg', f'{R}:86-89 _rrg()'),
    'weekly Friday closes, cached 1h, persisted',
    'The x axis. 102 is roughly two standard deviations ahead of its own normal. Left of 100 is underperforming. XLK currently reads 102.0 on the back of +21% against SPY over six months.',
    'Self-referential: both axes are z-scores against the sector own history, so two sectors at 101 are each two sigma strong relative to themselves, not equally strong in absolute terms. Cannot be read as "XLK beat XLV by this much".')

row('rrg_momentum','derived_metric','Sector Rotation','RS-Momentum',
    'Whether that relative strength is building or fading, centred on 100.',
    '100 + zscore(RS-Ratio.diff(4 weeks), 52w baseline), then a 3-week average',
    'derived from RS-Ratio', prov('/api/market/rrg', f'{R}:90-94'),
    'weekly, cached 1h',
    'The y axis, and the derivative of the x axis: strength is position, momentum is velocity. Above 100 means strength is building faster than that sector typically manages. XLK reads 98.6 while still at 102 strength, which is a leader rolling over.',
    'Also normalised against the sector own history, so a sector whose strength rose slightly can still print below 100 if it normally rises faster. Not a measure of volatility or jumpiness. Before 2026-08-08 this used a 12-week baseline and a one-week difference, which produced coordinates that swung 2-4 points a week and rendered as a mesh.')

row('rrg_quadrant','derived_metric','Sector Rotation','Quadrant and tail',
    'Which of leading / weakening / lagging / improving a sector sits in, and where it came from.',
    'quadrant from sign of (x-100, y-100); tail is the last N weekly coordinate pairs',
    'derived', prov('/api/market/rrg', f'{R}:57-60 quadrant()'),
    'weekly, cached 1h',
    'Rotation runs clockwise, so the tail carries more information than the dot: a sector in Weakening arriving from Leading is a position unwinding, while the same dot arriving from Lagging is one being built. Zero sectors in Leading means no sector is out in front and the index is being carried by individual names.',
    'This is the standard public construction of the graph, not a reproduction of the commercial product, whose exact smoothing is proprietary. Shape and readings are right; decimals will not match a paid terminal.')

row('sector_rel_strength','derived_metric','Sector Rotation','Sector relative return',
    'Each GICS sector ETF return minus SPY over 1W/1M/3M/6M/YTD/1Y.',
    'sector_return(period) - SPY_return(period), per period',
    'yfinance daily closes of 11 SPDR sector ETFs',
    prov('/api/market/sector-rotation', 'backend/routers/market.py:1486-1489'),
    'daily, disk-cached',
    'The heatmap. Positive means the sector beat the index over that window. Reading several periods together separates a durable leader from a one-week bounce.',
    'Sector ETFs are proxies for the GICS sectors, so they carry their own fees and tracking error. Eleven sectors only; no industry-level detail.')

row('sector_momentum','derived_metric','Sector Rotation','Sector momentum score',
    'Whether a sector is accelerating: recent month against the average month of the last quarter.',
    'return_1M - (return_3M / 3)', 'derived',
    prov('/api/market/sector-rotation', 'backend/routers/market.py:1494'),
    'daily, disk-cached',
    'Positive means the last month outpaced the quarterly run rate, so the trend is accelerating. This is the simple sortable version; the RRG view is the same idea done properly with smoothing and a normalised baseline.',
    'A crude approximation of acceleration that assumes a linear 3-month path. It will flag a sector that fell hard two months ago and merely stopped falling.')

G = "backend/index_profile.py"
row('asset_return_ladder','derived_metric','Global Markets','Return ladder (1W-5Y)',
    'Trailing return over 1W, 1M, 3M, 6M, YTD, 1Y, 3Y and 5Y for any row on the board.',
    'last / close_at_or_before(today - window) - 1, per window; YTD uses 1 January',
    'yfinance 5y daily closes', prov('/api/market/asset-profile', f'{G}:99-107 asset_stats()'),
    'daily closes, get_download cached 15m',
    'Reading several windows together separates a trend from a bounce. Works for every row on the board, not just equities.',
    'Uses the last close at or before the anchor date, so a long market closure shifts the base. Price return only: no dividends, so equity index figures understate total return by roughly the yield.')

row('asset_yield_bp','derived_metric','Global Markets','Yield change in basis points',
    'For the US yield rows, the change in the yield level rather than a percentage return.',
    'last_level - level_at_or_before(anchor), rendered as basis points',
    'yfinance / FRED', prov('/api/market/asset-profile', f'{G}:104-107 changes_abs'),
    'daily, cached 15m',
    'A 10-year going 4.00 to 4.66 has not returned 16%, it has risen 66 basis points. The panel switches to this reading automatically for the yield rows.',
    'Applies only to the yield section of the board. The frontend decides which reading to show from a `yields` flag, so a yield surfaced elsewhere would still print a percentage.')

row('asset_52w_range','derived_metric','Global Markets','52-week range and position',
    'One-year high and low, where the current price sits inside that band, and distance from each end.',
    'min/max of the last 366 calendar days of closes; position = (last-low)/(high-low)*100',
    'yfinance daily closes', prov('/api/market/asset-profile', f'{G}:109-111'),
    'daily, cached 15m',
    'Position near 100% of the band means the asset is at its yearly high. Distance from high is the plain drawdown reading.',
    'Closing prices only, so it will differ from a vendor 52-week high computed on intraday extremes.')

row('asset_vol_dd','derived_metric','Global Markets','30-day volatility and deepest 1-year fall',
    'Annualised realised volatility over the last 30 sessions, and the largest peak-to-trough fall inside one year.',
    'std(daily returns, last 30) * sqrt(252) * 100; min(price/cummax(price) - 1) over 366 days',
    'yfinance daily closes', prov('/api/market/asset-profile', f'{G}:113-117'),
    'daily, cached 15m',
    'The volatility figure is a 30-session window, so it reacts fast and will look extreme after a shock: the KOSPI reads 90% against a 52% one-year figure. The drawdown is the honest worst case an investor would have lived through.',
    'Realised, not implied, and backward-looking. The 30-day window and the 1-year drawdown are different horizons and should not be compared to each other.')

row('asset_beta_corr','model','Global Markets','Beta and correlation vs S&P 500',
    'The relationship between an asset and the US equity benchmark over the last year.',
    'Scholes-Williams (1977): beta = cov(ln(1+r_asset), mr3) / cov(ln(1+r_mkt), mr3) where mr3 is the sum of the previous, current and next market log return. Correlation is taken at whichever of lag 0 or lag 1 reads stronger by at least 0.05.',
    'yfinance daily closes for the asset and ^GSPC',
    prov('/api/market/asset-profile', f'{G}:69-127 _relationship()'),
    'daily, cached 15m',
    'Beta near 1 means the asset moves with the S&P point for point. The Scholes-Williams form is used because most of the world does not trade while New York is open: Seoul closes at 06:00 UTC and New York at 21:00, so a same-day comparison put the KOSPI at beta 0.52 while it carried four times the S&P volatility. Corrected it reads 2.09. The panel says when a session offset was applied.',
    'The correction is near a no-op where sessions overlap, which is the check that it is not simply inflating everything: FTSE moves 0.31 to 0.36 while the KOSPI moves 0.52 to 2.09. Correlation cannot be summed the same way, so the lag is chosen from the data rather than a table of exchange hours. Needs 60 overlapping observations.')

row('gm_board_quote','feed_field','Global Markets','Board price and change',
    'Last price and window change for 52 instruments across indices, FX, commodities, US yields and crypto.',
    'last close in the selected window against the window base; 10m/30m/1h use intraday bars, longer windows use daily',
    'yfinance batched download; FRED for the 2-year yield',
    prov('/api/market/global-board', 'backend/routers/market.py:112 global_board()'),
    '10m-1h intraday, cached 2m in memory and on disk',
    'One request covers the whole board, so the page is a single round trip. Outside the US cash session the Americas index rows swap to their CME futures proxy and are flagged as such.',
    'A CME proxy is a different instrument from the cash index and is labelled `is_cme_proxy`. Row status is one of intraday / delayed / end_of_day / unavailable and should be read before the number.')

row('index_constituents','bundled_dataset','Global Markets','Index members with live caps',
    'Members of 17 world indices, priced live, with market cap, weight, sector and day change.',
    'members from a bundled list; market cap = stored shares outstanding x live price x FX to USD',
    'constituent lists scraped from Wikipedia at build time (backend/scripts/build_index_members.py), prices live from yfinance',
    prov('/api/market/index-constituents', f'{G}:191 index_profile()'),
    'list rebuilt manually; prices cached 30m, persisted',
    'Answers what an index is actually made of. Caps are computed live from a stored share count rather than a stored cap, because a cap is wrong by the next session while a share count moves a few times a year. Concentration (top 5 / top 10) is the fastest read on whether an index is really a basket.',
    '1,620 of 1,741 scraped names resolved on Yahoo; the rest were dropped rather than shipped unpriced. Coverage is stated per index in the payload. London quotes in pence, so the FX conversion divides by 100 (case-sensitive on GBp vs GBP). The Dow and Nikkei are price-weighted, so a market-cap share column there is context, not influence, and the caption says so. Eight board indices have no free member list.')

row('index_sectors','derived_metric','Global Markets','Sector mix',
    'Weight, member count and cap-weighted day move per sector within an index.',
    'group members by sector; weight = sector cap / total cap; change = cap-weighted mean of member day changes',
    'sector tags scraped from the same Wikipedia tables',
    prov('/api/market/index-constituents', f'{G}:145-176 _sector_mix()'),
    'cached 30m',
    'Weighted by capital, not by headcount: the S&P has 75 Financials against 73 Information Technology names, but IT is 34.9% of the index and Financials 10.3%. Counting names would invert the picture.',
    'Each index publishes its own taxonomy and they are left alone: the Hang Seng ships 4 buckets, the FTSE 44. Not comparable across indices. 1,588 of 1,620 members carry a sector; the Straits Times table publishes none.')

row('index_breadth_today','derived_metric','Global Markets','Constituent breadth and concentration',
    'Advancing/declining count among an index members, and the share of market cap in the top 5 and top 10.',
    'counts of member day change sign; top-N cap sum / total cap',
    'computed', prov('/api/market/index-constituents', f'{G}:214-229'),
    'cached 30m',
    'Concentration is the number that explains why an index and its average member can disagree. The Dow shows 71.8% in its top 5.',
    'Day change is close-to-close from the batched download, so for a foreign index it is the last completed session, not live.')
