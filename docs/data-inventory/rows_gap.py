from build_inv import row, prov

row('nav_premium','derived_metric','NAV Tracker','Premium / discount to NAV',
    'How far a closed-end fund or trust trades from its net asset value.',
    '(market price / NAV - 1) * 100, with a z-score against the fund own history',
    'proxy NAV computed from the fund holdings registry; prices from yfinance',
    prov('/api/nav/proxy'), 'on request, cached',
    'A persistent discount is structural; a discount several standard deviations wide against the fund own history is the tradable version. The z-score matters more than the level, because every vehicle has its own normal.',
    'NAV is a proxy computed from a registry of holdings, not the fund published NAV, so it will not match the official figure. Only the vehicles in the registry are covered; anything else returns nothing.')

row('report_clips','user_input','Report Creator','Captured clips',
    'Charts, KPI strips and tables captured from any tool into a report project.',
    '-', 'each tool registers a capture through useReportCapture / reportCaptureRegistry',
    'frontend/src/lib/reportCaptureRegistry.ts; frontend/src/hooks/useReportCapture.ts',
    'captured on demand, stored per project',
    'The clip records the data as it was when captured, so a report is a snapshot rather than a live view. Export goes through a dedicated print route rather than a canvas rasteriser, which is why the PDF has selectable text and vector charts.',
    'A clip does not refresh: reopening a project shows the numbers as captured, with the capture time. Any tool that has not registered a capture cannot be clipped, and there is no error when you try.')

row('market_hours','derived_metric','Market Hours','Global session clock',
    'Which exchanges are open, closed, pre-market or after-hours right now, and when each next opens.',
    'exchange session windows plus a holiday calendar evaluated against the current time in each venue timezone',
    'in-house, fully client-side',
    'frontend/src/lib/marketHours.ts and frontend/src/lib/marketHolidays.ts',
    'ticks locally, no network',
    'The only tool in the app with no backend call: it is deterministic, so it stays correct offline and costs nothing. Used to decide whether the Global Markets board shows cash indices or CME futures proxies.',
    'The holiday calendar is a bundled static list, so an unscheduled closure or a newly announced holiday will be wrong until the list is updated. Half-days are modelled for the venues that have them but not for every venue.')

row('chart_studio_overlays','derived_metric','Chart Studio','Indicator and event overlays',
    'Candles with moving averages, Bollinger bands, RSI, MACD, volume, IV and GEX lanes, plus corporate-event markers.',
    'indicators computed client-side in lib/indicators.ts over the fetched OHLCV; events from the chart-events endpoint',
    'yfinance/Alpaca OHLCV; corporate events from filings and earnings',
    prov('/api/market/chart-events'),
    'candles 60s intraday / 300s daily; events cached 6h',
    'Follower lanes sync one-way from the main chart, never two-way, because a sparse lane (IV, GEX) has fewer points than price and a two-way sync would drag the price axis to the sparse series range.',
    'Indicators are computed on the loaded window only, so an indicator with a long lookback is undefined at the left edge of a short window rather than borrowing prior history. Event markers depend on filing coverage and are sparse for non-US names.')

row('asset_overlay','derived_metric','Asset Overlay','Normalised multi-asset comparison',
    'Several assets on one chart, indexed to a common base or shown as percentage change.',
    'indexed: price / price_at_window_start * 100; pct: price / base - 1',
    'yfinance history', prov('/api/market/compare'),
    'on request, cached',
    'Indexing to 100 is the honest way to compare instruments of different price. Multiples and ratios plot on a separate right axis at their real level, because normalising a P/E destroys the thing you wanted to see.',
    'Indexing is sensitive to the start date: shifting the window start changes every line. Price return only, so a high-yield asset is understated against a low-yield one over long windows.')

row('portfolio_compare','derived_metric','Portfolio Compare','Side-by-side book comparison',
    'Two or more candidate books compared on CAGR, vol, Sharpe, Sortino, Calmar, max drawdown and beta, with leverage and borrow cost.',
    'each book valued as a weighted basket over history; the same metric set as Portfolio Analysis; liquidation flagged when levered equity goes to zero',
    'yfinance history', prov('/api/market/compare'),
    'on request',
    'The A/B test for allocation decisions. Leverage and borrow rate are inputs, so the cost of a levered version is charged rather than assumed away, and a book that would have been liquidated is flagged rather than shown with a fictional recovery.',
    'Assumes fixed weights with no rebalancing drag or transaction cost. Borrow is a flat rate, not a term structure, so a long backtest under changing rates is optimistic or pessimistic depending on the period.')
