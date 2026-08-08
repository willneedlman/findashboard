from build_inv import row, prov
P = 'backend/routers/portfolio.py'; A = 'backend/routers/algo.py'

row('pm_book','user_input','Portfolio Manager','Holdings, options, futures and cash',
    'The user book: positions with share counts and cost basis, across several named portfolios.',
    '-', 'user entry, CSV/JSON import, or AI screenshot import; stored in browser localStorage under pe_portfolios',
    'frontend/src/lib/pmImport.ts; no backend persistence',
    'per edit, local only',
    'The input every portfolio tool keys off. Books are importable into Allocator, Analysis, Compare, Backtester, Factor Decomposition and the drawdown alert through PMImportPicker.',
    'localStorage only, so it is per browser and never synced server-side. A drawdown alert therefore has to carry its holdings in the alert payload, the same way a strategy alert carries its rules. Clearing site data deletes the book.')

row('factor_decomposition','model','Factor Decomposition','Factor exposures and alpha',
    'A book regressed on market, rates, credit, oil and dollar factors.',
    'multivariate OLS of book returns on factor returns; risk shares from the variance contribution of each loading; annualised alpha from the intercept',
    'in-house factor models module', prov('/api/portfolio/factor-decomposition', 'backend/factor_models.py'),
    'on request',
    'Tells you what a book is actually exposed to as opposed to what it holds. Risk shares sum to the systematic portion; the remainder is name-specific.',
    'Factor set is fixed at five and does not include size, value or momentum, so a style tilt shows up as unexplained alpha. OLS betas are unstable on under a year of data.')

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

row('rebalance_trades','derived_metric','Portfolio Allocator','Drift and rebalance trade list',
    'The difference between a loaded book and the target weights, as concrete share-level trades.',
    'current shares = (baseline weight/100 x book value)/price; target the same at the slider weights; delta = target - current; trades filtered to |drift| >= 0.1pp',
    'imported book weights + live prices',
    'frontend/src/pages/PortfolioAllocator.tsx (client-side)',
    'recomputed on every weight change',
    'Turns an optimiser output into something actionable. Turnover is shown alongside so the cost of the rebalance is visible before the trade list. A position exited to zero appears as a row rather than disappearing.',
    'No commission, spread, tax lot or wash-sale handling. Anything inside 0.1 percentage points is treated as noise and omitted. CSV export only: there is no hand-off to Paper Trading, because that bridge is options-only today.')

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
