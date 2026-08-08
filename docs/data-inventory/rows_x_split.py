from build_inv import row, prov
S = prov('/api/screener/run'); HUB = prov('/api/corporate/hub')
BETA = prov('/api/market/beta-suite', 'backend/routers/market.py:647')

def sc(id, name, defn, formula, interp, lim):
    row(id, 'derived_metric', 'Stock Screener', name, defn, formula,
        'bundled us_fundamentals.json seed, enriched live from FMP within a daily budget',
        S, 'seed static; live enrichment 30d-cached', interp, lim)

sc('scr_pe','P/E','Price against trailing earnings.','price / EPS (TTM)',
   'The default value filter and the least comparable across sectors. A screen on P/E alone reliably returns cyclicals at their earnings peak.',
   'Suppressed rather than shown negative on losses, so unprofitable names silently drop out of a P/E filter instead of failing it.')
sc('scr_pb','P/B','Price against book value.','price / book value per share',
   'Only meaningful where book value means something: banks, insurers, asset-heavy industrials. For software it is noise.',
   'Book value ignores intangibles and is distorted by buybacks, which can drive equity negative and make the ratio meaningless.')
sc('scr_ps','P/S','Price against revenue.','price / revenue per share',
   'The fallback multiple for unprofitable growth. Comparable only within an industry, because it ignores margin entirely.',
   'Two companies at the same P/S with 10% and 40% margins are not comparably priced. Says nothing about profitability by construction.')
sc('scr_peg','PEG','P/E adjusted for growth.','P/E / earnings growth rate',
   'An attempt to make P/E comparable across growth rates. Below 1 is the conventional cheap threshold.',
   'Assumes a linear trade between growth and multiple that does not hold empirically. Explodes toward infinity as growth approaches zero and is meaningless when negative.')
sc('scr_ev_ebitda','EV/EBITDA','Enterprise value against operating cash proxy.','(market cap + net debt) / EBITDA',
   'The multiple that survives differences in capital structure, which is why it is the right default for anything levered or acquisitive.',
   'EBITDA ignores capex, so it flatters capital-intensive businesses badly. Lease accounting differences move it between sources.')
sc('scr_gross_margin','Gross margin','Profit after direct costs.','gross profit / revenue',
   'The structural quality read: pricing power and product mix show here before they show anywhere else.',
   'Cost-of-revenue definitions vary between filers, particularly on whether support and hosting sit above or below the line.')
sc('scr_op_margin','Operating margin','Profit after operating costs.','operating income / revenue',
   'The efficiency read. The spread against gross margin is where operating leverage lives.',
   'Sensitive to how a filer classifies one-off restructuring, which can move it several points without any operating change.')
sc('scr_net_margin','Net margin','Profit after everything.','net income / revenue',
   'The bottom line, and the one most contaminated by items unrelated to operations. A large gap against operating margin is interest or tax, not the business.',
   'Distorted by one-off tax benefits, asset sales and impairments, all of which persist in TTM for four quarters.')
sc('scr_roe','ROE','Return on shareholders equity.','net income / shareholders equity',
   'The compounding rate on retained capital, and the single best quality screen when paired with a leverage filter.',
   'Trivially inflated by leverage and by buybacks that shrink equity. Meaningless or negative when equity is negative.')
sc('scr_rsi','RSI','Momentum oscillator on the screened name.','RSI(14) from daily closes',
   'Combines with a value filter to separate cheap-and-falling from cheap-and-turning, which is the difference that matters.',
   'Requires enough price history and is computed on demand, so a large universe with this filter is materially slower.')
sc('scr_vs_50dma','Price vs 50-day MA','Distance from the medium-term trend.','price / SMA(50) - 1',
   'The tactical trend filter. Above the 50-day and above the 200-day is the classic confirmation pair.',
   'Needs 50 sessions, so recent listings drop out of the filter rather than failing it.')
sc('scr_vs_200dma','Price vs 200-day MA','Distance from the long-term trend.','price / SMA(200) - 1',
   'The regime filter most institutions actually use. A value screen restricted to names above their 200-day is a materially different strategy.',
   'Needs 200 sessions of history, which excludes anything listed inside a year without saying so.')
sc('scr_52w_high','52-week high %','Distance below the yearly high.','price / 52-week high - 1',
   'Near the high is a momentum screen; deeply below is a mean-reversion one. Same column, opposite strategies.',
   'Computed on closes, so it differs from a vendor figure based on intraday highs.')
sc('scr_30d_vol','30-day volatility','Recent realised volatility.','stdev of 30 daily returns, annualised',
   'A risk cap on any screen. Also the fastest way to exclude names whose apparent cheapness is distress.',
   'A 30-day window reacts fast and will read extreme for weeks after a single gap.')

def cp(id, name, defn, formula, interp, lim):
    row(id, 'feed_field', 'Company Profile', name, defn, formula,
        'SEC EDGAR first, yfinance and FMP fallback', HUB, 'fundamentals 12h', interp, lim)

cp('cp_gross_margin','Gross margin','Profit after direct costs.','gross profit / revenue',
   'Where pricing power shows first. A gross margin that erodes while revenue grows is the earliest sign of competitive pressure.',
   'Cost-of-revenue classification differs between filers and between SEC and vendor normalisations.')
cp('cp_op_margin','Operating margin','Profit after operating costs.','operating income / revenue',
   'The operating leverage read: compare its trajectory against revenue growth to see whether scale is actually converting.',
   'One-off restructuring charges sit inside operating income for most filers and are not stripped out here.')
cp('cp_net_margin','Net margin','Profit after interest, tax and everything else.','net income / revenue',
   'Read the gap against operating margin rather than the level. A widening gap is a financing or tax story.',
   'Contaminated by asset sales, impairments and tax one-offs that persist in TTM for a year.')
cp('cp_net_debt','Net debt','Debt less cash.','total debt - cash and equivalents',
   'The figure that bridges enterprise value to equity value in every valuation model in the app.',
   'Period-end cash is seasonal for many businesses, so a single balance sheet date can misstate the steady-state position.')
cp('cp_debt_ebitda','Debt / EBITDA','Leverage against operating cash proxy.','total debt / EBITDA',
   'Above 4x is where the credit panel colours red, and roughly where lenders begin imposing covenants.',
   'EBITDA is not cash flow. Meaningless for banks and insurers, which still render a value.')
cp('cp_current_ratio','Current ratio','Short-term assets against short-term liabilities.','current assets / current liabilities',
   'The liquidity floor. Below 1 means the company cannot cover a year of obligations from current assets, which is normal for some models and fatal for others.',
   'A crude measure that treats inventory as liquid. The quick ratio, which does not, is not computed here.')
cp('cp_interest_coverage','Interest coverage','How many times operating profit covers interest.','EBIT / interest expense',
   'The input to the synthetic credit rating, and the threshold the panel colours red below 2x.',
   'Uses reported interest expense, which nets capitalised interest inconsistently. Undefined for a debt-free company, where it renders blank rather than infinite.')

row('reg_ff_loadings','model','Regression','Fama-French factor loadings',
    'Exposure to market, size, value and momentum factors.',
    'multivariate OLS of excess returns on the Ken French FF3 or FF4 factor set',
    'Ken French factor library + yfinance', BETA, 'on request',
    'Separates a return into style exposures. A "stock picker" whose returns are explained by a small-value tilt has a factor portfolio, not a skill.',
    'Factors are US-centric and the library updates monthly with a lag. Loadings over a single year are noisy and rarely significant.')
row('reg_capm_beta','derived_metric','Regression','CAPM beta and the thin-trading flag',
    'Ordinary market beta, and whether it disagrees with the lead-lag corrected estimate.',
    'cov/var beta; flagged when |CAPM - Scholes-Williams| exceeds 15% of the CAPM value',
    'Ken French + yfinance', BETA, 'on request',
    'The divergence is the signal. A large gap means the naive beta is biased toward 1 by thin trading and should not be used for hedging.',
    'The 15% threshold is a starting point for flagging, not a statistically derived cutoff, and the code says so explicitly.')

row('alloc_frontier','model','Portfolio Allocator','Efficient frontier',
    'The set of portfolios with the best return available at each level of risk.',
    'mean-variance optimisation across the ticker set under the chosen bounds',
    'in-house optimiser over yfinance history', prov('/api/portfolio-opt/optimize'), 'on request',
    'The curve is the menu; a book plotted below it is giving up return for no reason. The shape matters more than any single point on it.',
    'Notoriously sensitive to the expected-return estimate. Small changes in the input move the whole curve, which is why the CAPM option exists as an alternative to raw historical means.')
row('alloc_max_sharpe','model','Portfolio Allocator','Max-Sharpe portfolio and target weights',
    'The tangency portfolio, and the weights it proposes.',
    'the frontier point maximising (return - risk free) / volatility, with locked tickers held fixed and the remainder redistributed',
    'in-house optimiser', prov('/api/portfolio-opt/optimize'), 'on request',
    'Locking positions and redistributing the rest is what makes this usable on a real book rather than a blank slate. The proposal feeds directly into the rebalance trade list.',
    'Concentrates aggressively into whichever asset had the best historical Sharpe, which is why bounds and locks exist. Unconstrained output is rarely investable.')

def pr(id, name, defn, formula, interp, lim):
    row(id, 'model', 'Pairs Trader', name, defn, formula, 'yfinance history',
        prov('/api/regression/pairs'), 'on request', interp, lim)
pr('pairs_hedge_spread','Hedge ratio and spread','The regression-implied ratio between two names, and the residual.',
   'OLS of A on B gives beta; spread = A - beta x B',
   'The spread is the tradable series, not either leg. A hedge ratio far from 1 means the position is materially unbalanced in dollar terms.',
   'An OLS hedge ratio is unstable and drifts; it is estimated over the whole window rather than rolling, so a structural break is averaged away.')
pr('pairs_zscore','Spread z-score','How far the spread sits from its own mean.','(spread - rolling mean) / rolling stdev',
   'The entry and exit trigger. Conventional thresholds are 2 to enter and 0 to exit, both visible on the chart.',
   'Assumes the spread is stationary. If the pair has genuinely decoupled, the z-score keeps signalling entry all the way down.')
pr('pairs_cointegration','Cointegration test','Whether the two series share a long-run relationship.',
   'statistical test for a stationary linear combination of the two price series',
   'The gate that decides whether mean reversion is a reasonable expectation at all, rather than a curve fit. Without it a pairs trade is two correlated bets.',
   'Cointegration over a chosen window frequently fails out of sample. A pair can test cointegrated historically and be structurally broken today, and no test distinguishes those.')

row('bt_daily_alpha','derived_metric','Portfolio Backtester','Daily alpha',
    'Strategy return not explained by the benchmark.',
    'intercept of the OLS of strategy daily returns on benchmark daily returns',
    'yfinance daily bars', prov('/api/strategy/portfolio-backtest'), 'on request',
    'The excess the strategy produced per day after accounting for its market exposure. Annualise it mentally by multiplying by roughly 252 to judge whether it is material.',
    'No t-statistic or p-value is reported on this panel, so there is nothing here to distinguish alpha from luck. The Regression tools do report significance; this does not.')
row('bt_r_squared','derived_metric','Portfolio Backtester','Market correlation and R-squared',
    'How much of the strategy return the benchmark explains.',
    'Pearson r between strategy and benchmark daily returns, and its square',
    'yfinance daily bars', prov('/api/strategy/portfolio-backtest'), 'on request',
    'A high R-squared means the strategy is a levered or delevered index position whatever its rules claim. Low correlation with positive alpha is the only combination worth paying for.',
    'Measures linear co-movement only. A strategy that is flat most of the time and fully long occasionally can show low R-squared while carrying full market risk when it matters.')

row('mc_breakevens','model','Monte Carlo','Break-even prices',
    'Underlying prices at which an options structure returns zero at expiry.',
    'roots of the expiry payoff function across the price grid',
    'in-house payoff engine', prov('/api/portfolio/montecarlo'), 'on request',
    'The deterministic frame around the probabilistic result. Distance from spot to the nearest break-even is the honest read on how much has to go right.',
    'Expiry-only: ignores the path, early assignment and financing. A structure can be profitable at expiry and still be closed at a loss on a margin call.')
row('mc_max_loss','model','Monte Carlo','Max loss and max profit',
    'Bounds of the structure payoff.','minimum and maximum of the expiry payoff across the evaluated price grid',
    'in-house payoff engine', prov('/api/portfolio/montecarlo'), 'on request',
    'Max loss is the number that should size the position, not probability of profit. A 70% win rate with a 5:1 loss ratio is a losing structure.',
    'Bounded by the evaluated grid, so an unbounded short leg shows a finite max loss that is an artefact of the grid width rather than a real limit.')

def cs2(id, name, defn, formula, interp, lim):
    row(id, 'derived_metric', 'Correlation', name, defn, formula, 'yfinance history',
        prov('/api/correlation/matrix'), 'on request', interp, lim)
cs2('corr_matrix','Correlation matrix','Pairwise correlation across the selected assets.',
    'Pearson correlation of daily returns over the chosen period',
    'The diversification check. Anything above roughly 0.8 is one position wearing two tickers.',
    'Cross-region pairs are understated by the same session-offset problem the Global Markets beta corrects for, and this tool does NOT apply that correction.')
cs2('corr_rolling','Rolling correlation','How a pair correlation drifts over time.',
    'correlation over a rolling N-day window',
    'The panel that matters: a static matrix hides that diversification disappears exactly when it is needed. Spikes toward +1 mark a risk-off regime.',
    'A rolling window trades responsiveness against stability; a short window produces swings that are estimation noise rather than regime change.')
cs2('corr_beta','Beta to the benchmark','Each asset sensitivity to the chosen benchmark.',
    'cov(asset, benchmark) / var(benchmark)',
    'Turns a correlation matrix into something position-sizeable, since correlation alone says nothing about magnitude.',
    'Contemporaneous and uncorrected for session offsets, so foreign assets read low.')

def cd(id, name, defn, interp, lim):
    row(id, 'feed_field', 'Credit Stress', name, defn, '-', 'FRED (Federal Reserve and FDIC series)',
        prov('/api/credit/summary'), 'quarterly on release', interp, lim)
cd('cs_lending_standards','Bank lending standards','Net share of banks tightening credit standards, from the SLOOS.',
   'The leading indicator of the three on this page. Standards tighten several quarters before delinquencies rise, so this is where a credit cycle turns first.',
   'A survey of senior loan officers, so it measures intent rather than realised lending. Quarterly and small-sample.')
cd('cs_delinquencies','Delinquency rates','Share of loans past due, by loan category.',
   'The realised consumer stress read, and a lagging one. Credit card and auto delinquencies turn before mortgage.',
   'Lags the cycle by several quarters and is heavily revised. Aggregates hide the subprime cohort where the turn actually starts.')
cd('cs_charge_offs','Charge-off rates','Loans written off as uncollectable.',
   'The final confirmation, and the most lagging series here. By the time charge-offs rise the credit event has already happened.',
   'Lags delinquencies by roughly two quarters by construction, since a loan must be delinquent before it is charged off.')

row('hm_inventory','derived_metric','Housing Market','Inventory and months of supply',
    'Homes available and how long they would take to clear.','inventory / monthly sales pace',
    'FRED and Census', prov('/api/housing/report'), 'monthly',
    'Six months is the conventional balance point. Below four is a seller market and is where price acceleration comes from.',
    'National aggregates hide enormous regional dispersion, and no regional view exists in the UI despite a regional endpoint being available.')
row('hm_construction','feed_field','Housing Market','Housing starts and permits',
    'New residential construction activity.','-','FRED and Census', prov('/api/housing/report'), 'monthly',
    'Permits lead starts, and starts lead completions by roughly a year, so permits are the forward-looking series of the three.',
    'Extremely volatile month to month and revised heavily. Multi-family and single-family behave differently and are frequently reported together.')

row('si_level','feed_field','Company Profile','Short interest',
    'Shares sold short at the last settlement date.','-','FINRA consolidated biweekly file',
    prov('/api/corporate/short-interest', 'backend/short_interest.py:101'), 'biweekly Reg SHO settlement',
    'The raw position. On its own it says little: percentage of float and days to cover are the readings that matter.',
    'Biweekly and lagged: settlement is roughly two weeks behind and publication a week further, so this is never current.')
row('si_days_cover','derived_metric','Company Profile','Days to cover',
    'How many sessions of average volume it would take to close the short position.',
    'shares short / average daily volume, as published by FINRA',
    'FINRA', prov('/api/corporate/short-interest', 'backend/short_interest.py:101'), 'biweekly',
    'Above 3 is the crowding threshold the panel colours amber at. This is the squeeze-risk number, because it measures the exit, not the position.',
    'Uses the volume regime at the settlement date. A subsequent volume surge makes the position far easier to cover than the published figure implies.')
