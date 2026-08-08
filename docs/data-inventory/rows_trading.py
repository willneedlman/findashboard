from build_inv import row, prov
P = 'backend/routers/portfolio.py'; A = 'backend/routers/algo.py'

row('pm_book','user_input','Portfolio Manager','Holdings, options, futures and cash',
    'The user book: positions with share counts and cost basis, across several named portfolios.',
    '-', 'user entry, CSV/JSON import, or AI screenshot import; stored in browser localStorage under pe_portfolios',
    'frontend/src/lib/pmImport.ts; no backend persistence',
    'per edit, local only',
    'The input every portfolio tool keys off. Books are importable into Allocator, Analysis, Compare, Backtester, Factor Decomposition and the drawdown alert through PMImportPicker.',
    'localStorage only, so it is per browser and never synced server-side. A drawdown alert therefore has to carry its holdings in the alert payload, the same way a strategy alert carries its rules. Clearing site data deletes the book.')

row('pm_valuation','derived_metric','Portfolio Manager','Live book value and P&L',
    'Market value, unrealised P&L and weight per position, and the book total.',
    'shares x live price; P&L against cost basis; weight = position value / book value',
    'yfinance batched quotes', prov('/api/portfolio/live-value'),
    'polling, 10s on the live board',
    'The live cockpit. The intraday book-value curve is derived from the same polled marks rather than from a stored series.',
    'Options and futures are marked separately from equities and are excluded from the weighted legs handed to the allocator, which is surfaced as a note rather than silently dropped.')

row('portfolio_risk','derived_metric','Portfolio Analysis','Sharpe, Sortino, Calmar, vol, max drawdown, beta',
    'Standard risk and risk-adjusted return statistics for a book.',
    'sharpe = (annualised return - rf) / annualised vol; sortino uses downside deviation only; calmar = annualised return / |max drawdown|; max drawdown = min(equity/cummax(equity) - 1)',
    'yfinance history over the book weights',
    prov('/api/portfolio/backtest', f'{P}:87-114 metrics'),
    'on request',
    'Sortino is the more honest of the ratios for an asymmetric book because it does not penalise upside volatility. Calmar answers "return per unit of the worst thing that happened".',
    'Backward-looking over the chosen window and highly window-dependent; a book that avoided one crash shows a flattering Calmar. Assumes the current weights were held throughout.')

row('portfolio_var','model','Portfolio Analysis','VaR 95, CVaR 95, percentile outcomes',
    'Monte Carlo loss distribution for the book: the 5% tail and the expected loss inside it.',
    'simulated terminal distribution; VaR = 5th percentile loss; CVaR = mean loss beyond it; p5/p50/p95 terminal returns and liquidation odds also reported',
    'in-house simulation over historical covariance',
    prov('/api/portfolio/montecarlo'),
    'on request',
    'CVaR is the number to read, not VaR: VaR says where the tail starts, CVaR says how bad it is inside. Liquidation odds count paths that hit a margin call.',
    'Distributional assumptions drive the tail entirely; a Gaussian simulation understates real crash risk. Historical covariance is estimated over the chosen window and is unstable for short ones.')

row('factor_decomposition','model','Factor Decomposition','Factor exposures and alpha',
    'A book regressed on market, rates, credit, oil and dollar factors.',
    'multivariate OLS of book returns on factor returns; risk shares from the variance contribution of each loading; annualised alpha from the intercept',
    'in-house factor models module', prov('/api/portfolio/factor-decomposition', 'backend/factor_models.py'),
    'on request',
    'Tells you what a book is actually exposed to as opposed to what it holds. Risk shares sum to the systematic portion; the remainder is name-specific.',
    'Factor set is fixed at five and does not include size, value or momentum, so a style tilt shows up as unexplained alpha. OLS betas are unstable on under a year of data.')

row('beta_suite','model','Regression','CAPM and Scholes-Williams beta, FF3/FF4 loadings, IVOL',
    'Multiple beta estimates for one asset plus Fama-French factor loadings.',
    'CAPM OLS beta; Scholes-Williams lead-lag beta from the sum of previous, current and next market return; FF3/FF4 loadings against Ken French factors; IVOL and TVOL from the residuals',
    'Ken French factor library + yfinance',
    prov('/api/market/beta-suite', 'backend/routers/market.py:647'),
    'on request',
    'The divergence between CAPM and Scholes-Williams beta is itself the signal: a large gap flags thin trading, where naive OLS beta biases toward 1 because the stock return is desynchronised from the same-day market move. The app flags divergence past 15%.',
    'The 15% threshold is a starting point for flagging, not a statistically derived cutoff, and the code says so. Scholes-Williams is daily-only; the lead-lag correction is meaningless at lower frequency.')

row('backtest_metrics','model','Portfolio Backtester','Backtest equity curve and statistics',
    'Strategy equity, CAGR, Sharpe, max drawdown and trade statistics over history.',
    'signals applied to daily bars; sharpe = mean(daily)/std(daily)*sqrt(bars_per_year); equity compounded from per-bar returns; drawdown from the running peak',
    'yfinance daily bars', prov('/api/strategy/portfolio-backtest', f'{A}:387 _compute_metrics()'),
    'on request',
    'The core loop for the strategy tools. Three engines share it: equity, single-option and multi-leg combo, all consuming the same boolean entry/exit arrays.',
    'No commission, slippage or borrow cost is modelled. Fills are at the bar close of the signal bar. Survivorship bias is present for any universe defined today and tested backwards.')

row('algo_signals','model','Algo Builder','Rule and Python strategy signals',
    'Entry and exit boolean arrays from either visual rule blocks or generated Python.',
    'rule blocks compile to Python through backend/algo_runtime/compiler.py; generated code runs in an AST-allowlist sandbox on a forkserver process with resource limits',
    'in-house rules engine and code generator (Groq/Cerebras for generation)',
    prov('/api/strategy/compile', 'backend/algo_runtime/compiler.py; backend/algo_runtime/sandbox.py'),
    'on request',
    'Both paths produce the same (entries, exits, size) contract, so a strategy can move between the visual builder and code without changing the P&L engine. Saved strategies carry a PY badge showing which path is active.',
    'Generated code is validated at seven levels including a causality check by future perturbation (rewriting data after bar k and confirming earlier output is byte-identical), which catches lookahead that prefix truncation misses. Validation rejects genuine lookahead but cannot prove a strategy is economically sound.')

row('algo_sizing','derived_metric','Algo Builder','Per-bar position sizing',
    'A 0-1 conviction multiplier applied to each entry.',
    'size array clamped to [0,1], NaN to 0; position value = cash * allocation * size[i]',
    'in-house', prov('/api/strategy/custom-backtest', f'{A}: _size_multiplier()'),
    'on request',
    'Turns a binary signal into a conviction-weighted one. All three P&L engines honour it.',
    'A wrong-shaped size array raises 422 rather than being broadcast, deliberately: silently recycling a short array would misalign every subsequent bar.')

row('monte_carlo_paths','model','Monte Carlo','Simulated terminal distributions',
    'Distributions of terminal value, drawdown and other outcomes across simulated paths.',
    'GBM, Student-t or block-bootstrap path generation; block bootstrap resamples real returns in 10-day blocks',
    'in-house simulation', prov('/api/portfolio/montecarlo'),
    'on request, job-queued for long runs',
    'The block bootstrap is the one to use for drawdown questions: it preserves the serial correlation that produces real crashes, which GBM cannot generate. Model choice is exposed rather than hidden.',
    'GBM assumes lognormal iid returns and will understate tail risk badly. Student-t fattens tails but still assumes independence. Bootstrap can only produce crashes that already happened in the sample.')

row('pairs_trade','model','Pairs Trader','Spread, z-score and cointegration',
    'The relationship between two names, the spread and its standardised deviation.',
    'hedge ratio from OLS; spread = a - beta*b; z-score of the spread against a rolling window; cointegration test on the pair',
    'yfinance history', prov('/api/regression/pairs'),
    'on request',
    'Entry logic is z-score reversion; the cointegration test is what says whether reversion is a reasonable expectation at all rather than a curve fit.',
    'Cointegration over a chosen window frequently fails out of sample. A pair can be cointegrated historically and structurally broken today, and no test will tell you which.')

row('paper_account','derived_metric','Paper Trading','Positions, orders, balances, realised P&L',
    'A simulated brokerage account with equity and multi-leg option orders.',
    'fills marked against live quotes; realised P&L on close; equity = cash + marked positions',
    'in-house paper engine, SQLite persisted',
    prov('/api/paper/account', 'backend/paper_engine.py'),
    'polling; scheduler loop every 3s',
    'The execution sandbox. Options structures built in the Options tools hand off through a localStorage bridge and arrive as an approvable multi-leg order.',
    'Fills are at the quoted mid with no slippage, no partial fills and no queue position, so any strategy that depends on execution quality is flattered. Tradier account APIs exist in routers/trading.py but have no frontend caller.')

row('alert_conditions','model','Price Alerts','Alert conditions',
    'The condition set the alert engine can evaluate.',
    'price/pct thresholds; RSI and SMA cross conditions from price history; IV rank; gamma-flip cross; market sentiment; earnings within N days; macro event within N days; macro release printed above/below a level; portfolio drawdown beyond a percentage; saved-strategy entry/exit swept across a ticker list',
    'quote batch, price history, GEX snapshots, sentiment engine, FRED, user payload',
    prov('/api/alerts', 'backend/routers/alerts.py:189-221 condition sets'),
    'quote conditions ~30s with a 1h cooldown; slow conditions ~10m with a daily cooldown',
    'Slow-data conditions deliberately run on a 10-minute sweep and fire at most once a day, because their inputs move on a daily clock. Macro print alerts compare year-over-year against the print twelve periods back, since CPI is an index level and thresholding it raw is meaningless.',
    'Portfolio drawdown measures the basket against its own one-year peak holding today share counts fixed, so it is the drawdown of what you hold now rather than a replay of what you traded, and weights are converted to shares at today price. Strategy alerts cap fan-out at 15 tickers per sweep. No alert on a saved screen.')

row('rebalance_trades','derived_metric','Portfolio Allocator','Drift and rebalance trade list',
    'The difference between a loaded book and the target weights, as concrete share-level trades.',
    'current shares = (baseline weight/100 x book value)/price; target the same at the slider weights; delta = target - current; trades filtered to |drift| >= 0.1pp',
    'imported book weights + live prices',
    'frontend/src/pages/PortfolioAllocator.tsx (client-side)',
    'recomputed on every weight change',
    'Turns an optimiser output into something actionable. Turnover is shown alongside so the cost of the rebalance is visible before the trade list. A position exited to zero appears as a row rather than disappearing.',
    'No commission, spread, tax lot or wash-sale handling. Anything inside 0.1 percentage points is treated as noise and omitted. CSV export only: there is no hand-off to Paper Trading, because that bridge is options-only today.')

row('efficient_frontier','model','Portfolio Allocator','Frontier, max-Sharpe and target weights',
    'Optimal portfolios across the risk/return frontier for a ticker set.',
    'mean-variance optimisation; expected returns from history or CAPM; long-only or custom bounds',
    'in-house optimiser over yfinance history',
    prov('/api/portfolio-opt/optimize'),
    'on request',
    'Locked tickers are held fixed and the proposal is redistributed across the rest, which is what makes it usable on a real book rather than a blank slate.',
    'Mean-variance is notoriously sensitive to the expected-return input; small changes in the estimate move the weights a lot. The CAPM option exists precisely because raw historical means are the worst estimator.')

row('trade_journal','user_input','Trade Journal','Logged trades and outcomes',
    'Manually recorded trades with entry, exit, tags and notes.',
    'realised P&L per closed trade', 'user entry, localStorage',
    'frontend/src/pages/TradeJournal.tsx',
    'per edit, local only',
    'The discipline layer. Tagging by setup is what makes the log analysable rather than a diary.',
    'Entirely manual: there is no auto-import of fills from Paper Trading, so the journal and the paper account can disagree. Local storage only.')

row('mm_simulator','model','Market Maker','Quote, inventory and P&L simulation',
    'A market-making game with a timed challenge mode and a durable leaderboard.',
    'simulated order flow against user quotes; P&L = spread capture minus inventory mark-to-market; options and fixed-income variants',
    'in-house simulation', prov('/api/leaderboard/{p}'),
    'live during a session; leaderboard persisted',
    'Teaches the inventory/spread trade-off directly. Score is net P&L, not percentage return, so a large book cannot flatter a small edge.',
    'Synthetic flow, not real order flow. Leaderboards are separate for the options and fixed-income variants and are not comparable.')
