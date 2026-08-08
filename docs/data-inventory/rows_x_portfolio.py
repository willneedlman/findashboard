from build_inv import row, prov
P = 'backend/routers/portfolio.py'
BT = prov('/api/portfolio/backtest', f'{P}:87-114 metrics')
MC = prov('/api/portfolio/montecarlo')
LV = prov('/api/portfolio/live-value')

def perf(id, name, defn, formula, interp, lim, cad='on request'):
    row(id, 'derived_metric', 'Portfolio Analysis', name, defn, formula,
        'yfinance daily closes over the book weights', BT, cad, interp, lim)

perf('pa_cagr','Portfolio CAGR','Compound annual growth rate of the book over the analysis window.',
     '(final/initial)^(252/observations) - 1',
     'The headline return, annualised so windows of different length compare. Read it beside Max drawdown: a 20% CAGR bought with a 60% drawdown is a different product from the same CAGR at 15%.',
     'Geometric, so it is dominated by the window endpoints. A window that starts at a crash low flatters it badly. Assumes the current weights were held throughout, with no rebalancing drag.')
perf('pa_vol','Annualized volatility','Standard deviation of the book daily returns, annualised.',
     'stdev(daily returns) * sqrt(252) * 100',
     'The denominator of Sharpe and the plain measure of how bumpy the ride was. Above roughly 20% is equity-like; below 10% means significant bond or cash weight.',
     'Treats upside and downside deviation identically, which is why Sortino exists. Assumes returns are iid, so it understates risk for a trending or autocorrelated book.')
perf('pa_sharpe','Sharpe','Excess return per unit of total volatility.',
     '(annualised arithmetic return - risk free) / annualised vol',
     'The standard risk-adjusted comparator. Above 1 is good, above 2 is rare and usually means a short window or a hidden tail risk.',
     'Penalises upside volatility as heavily as downside. Highly unstable on under two years of data, and trivially gamed by a strategy that sells tails.')
perf('pa_sortino','Sortino','Excess return per unit of downside deviation only.',
     '(annualised arithmetic return - risk free) / downside deviation',
     'The more honest ratio for an asymmetric book, because it stops punishing the volatility you want. A large Sortino/Sharpe gap means the book upside is lumpy, which is usually a feature.',
     'Downside deviation is estimated from fewer observations than total volatility, so it is noisier. Sensitive to the choice of minimum acceptable return, which is fixed at the risk-free rate here.')
perf('pa_calmar','Calmar','Annualised return per unit of worst drawdown.',
     'annualised return / |max drawdown|',
     'Answers "return per unit of the worst thing that actually happened", which is the number a drawdown-sensitive allocator cares about most.',
     'Driven entirely by a single historical event. A book that missed one crash by luck shows a flattering Calmar that says nothing about the next one.')
perf('pa_max_dd','Max drawdown','Largest peak-to-trough decline in book value over the window.',
     'min(equity / cummax(equity) - 1) * 100',
     'The honest worst case an investor would have had to sit through. More predictive of whether someone actually holds a strategy than any return figure.',
     'Path-dependent and window-dependent: extending the window can only make it worse, never better. Uses closing values, so intraday depth is understated.')
perf('pa_beta','Beta','Sensitivity of the book to the benchmark.',
     'cov(book returns, benchmark returns) / var(benchmark returns)',
     'Above 1 means the book amplifies market moves. Read with the factor decomposition: a beta of 1 can hide offsetting sector and rate exposures.',
     'Contemporaneous OLS beta with no lead-lag correction, unlike the Global Markets asset panel. A book holding foreign equities will read low for the session-offset reason documented there.')
perf('pa_period_return','Period return','Simple total return over the analysis window.',
     'final value / initial value - 1',
     'The un-annualised number, which is the one that matches a brokerage statement over the same dates.',
     'Not comparable across windows of different length. Price return over the book; dividends are handled separately.')

def mc(id, name, defn, formula, interp, lim):
    row(id, 'model', 'Portfolio Analysis', name, defn, formula,
        'in-house Monte Carlo over historical covariance', MC, 'on request', interp, lim)

mc('pa_var95','VaR 95','The loss the book does not exceed in 95% of simulated paths.',
   '5th percentile of the simulated terminal return distribution',
   'Where the tail starts. Useful as a budget line, not as a worst case: by construction one path in twenty is worse than this, and VaR says nothing about how much worse.',
   'A quantile, so it is blind to everything beyond it. Two books with identical VaR can have wildly different disaster profiles, which is the whole reason CVaR sits next to it.')
mc('pa_cvar95','CVaR 95','Average loss across the worst 5% of simulated paths.',
   'mean of the simulated terminal returns below the 5th percentile',
   'The number to actually read. Unlike VaR it is sensitive to the shape of the tail, so it distinguishes a book that loses 6% in a bad case from one that loses 40%.',
   'Entirely determined by the simulation model. A Gaussian engine cannot produce the fat tails that make real crashes, so CVaR from a GBM run is optimistic by construction.')
mc('pa_p5','5th percentile outcome','Severe-downside terminal return across simulated paths.', 'quantile(terminal returns, 0.05)',
   'The pessimistic planning case. Pair it with Liquidation odds: a bad percentile matters far more when leverage means the path cannot be held.',
   'Simulated, not historical. The tail is a model output, and the model assumptions are the input that moves it most.')
mc('pa_p50','Median outcome','Middle terminal return across simulated paths.', 'quantile(terminal returns, 0.50)',
   'The central expectation, and a better planning number than the mean because the terminal distribution of a compounding series is right-skewed.',
   'The median of a simulation is not a forecast. It inherits the drift assumption, which is usually estimated from the same history being simulated.')
mc('pa_p95','95th percentile outcome','Strong-upside terminal return across simulated paths.', 'quantile(terminal returns, 0.95)',
   'The optimistic case, useful mainly as a width check: a very wide p5-to-p95 band means the horizon is too long or the vol too high for the median to mean much.',
   'Same model dependence as the downside. Right tail is less policy-relevant than the left but is quoted for symmetry.')
mc('pa_liquidation_odds','Liquidation odds','Share of simulated paths that hit a margin call.',
   'count(paths breaching the maintenance requirement) / total paths * 100',
   'The number that turns leverage from an abstraction into a probability. A book with an attractive median and 15% liquidation odds is not the same product as one at 0%.',
   'Depends on the long and short maintenance percentages entered, which are user inputs rather than broker-verified. Assumes no intra-path deleveraging or margin top-up.')
mc('pa_outcome_fan','Monte Carlo outcome fan','Percentile bands of book value over the simulated horizon.',
   'percentile envelope of the simulated equity paths at each step',
   'Shows the cone widening with time, which is the single best visual argument that a long-horizon point forecast is meaningless.',
   'The cone is not a confidence interval on reality, only on the model. Correlations are held fixed across the horizon, which is exactly when they break.')

row('pa_sim_model','user_input','Portfolio Analysis','Simulation model',
    'Which return-generating process the simulation uses: GBM, Student-t or block bootstrap.',
    'GBM draws iid lognormal; Student-t adds fat tails via a degrees-of-freedom parameter; block bootstrap resamples real historical returns in 10-day blocks',
    'user selection', MC, 'per run',
    'The block bootstrap is the one to use for any drawdown question, because it preserves the serial correlation that produces real crashes. GBM structurally cannot generate them.',
    'Exposing the model is honest but shifts the burden: the same book can show very different CVaR under each. Bootstrap can only reproduce crashes already in the sample window.')
row('pa_horizon','user_input','Portfolio Analysis','Horizon and path count',
    'Simulated days and number of paths.', '-', 'user selection', MC, 'per run',
    'Longer horizons widen the cone superlinearly. Path count affects only the smoothness of the percentile estimates, not their centre.',
    'Percentile estimates in the far tail need far more paths to stabilise than the median does, so a low path count makes CVaR noisy while the median looks fine.')

row('pa_hhi','derived_metric','Portfolio Analysis','HHI and effective holdings',
    'Concentration of the book, and how many equally weighted positions it behaves like.',
    'HHI = sum(weight^2); effective holdings = 1 / HHI',
    'computed from book weights', BT, 'on request',
    'A 20-position book with an effective count of 4 is a 4-position book wearing a disguise. This is the fastest read on whether diversification is real.',
    'Counts positions, not risk: two names in the same sector count as two. The risk-contribution panel is the version that accounts for covariance.')
row('pa_risk_contribution','derived_metric','Portfolio Analysis','Capital weight vs risk contribution',
    'How much of the book risk each position supplies, against how much capital it holds.',
    'marginal contribution to risk = weight * (covariance row . weights) / portfolio vol, normalised to 100%',
    'covariance of daily returns', BT, 'on request',
    'The gap between the two bars is the point. A 5% position supplying 20% of the risk is the position that will decide the outcome, regardless of what the weight says.',
    'Covariance is estimated over the chosen window and is unstable for short ones. Assumes a linear risk model, so it understates option and convexity exposure.')
row('pa_sector_exposure','derived_metric','Portfolio Analysis','Sector allocation',
    'Book weight by GICS-style sector.', 'sum of position weights grouped by sector',
    'yfinance sector tags', BT, 'on request',
    'The cross-check on a book that looks diversified by name count. Read it against the risk contribution panel rather than on its own.',
    'Sector tags come from yfinance own taxonomy, not GICS, and a conglomerate gets one tag. Cash, options and futures fall outside the sector split.')
row('pa_factor_alpha','model','Portfolio Analysis','Factor alpha and rolling beta',
    'Return not explained by the factor set, and how market sensitivity drifted.',
    'intercept of the multivariate factor regression, annualised; rolling beta over an N-day window',
    'in-house factor models', prov('/api/portfolio/factor-decomposition'), 'on request',
    'Alpha here means "unexplained by these five factors", not "skill". A rising rolling beta during a rally usually means the book is drifting more aggressive without anyone deciding to.',
    'Only five factors, with no size, value or momentum leg, so a style tilt reports as alpha. Alpha estimates need years of data to separate from noise and are rarely significant over a single year.')
row('pa_downtrend_watch','derived_metric','Portfolio Analysis','Downtrend watch and decision ledger',
    'Rules-based review flags per position, with the reason for each flag.',
    'deterministic thresholds over concentration, covariance risk contribution, beta and historical return',
    'computed from the same analysis', BT, 'on request',
    'Deliberately deterministic so every flag can be traced to a rule. The page states plainly that these are review flags, not generated investment advice.',
    'Threshold-based, so it flags on level rather than on trajectory and will keep flagging a position that is already being fixed. No forward-looking input at all.')

row('pm_market_value','derived_metric','Portfolio Manager','Market value and weight per position',
    'Live value of each holding and its share of the book.',
    'shares * live price; weight = position value / book value',
    'yfinance batched quotes', LV, 'polling, 10s on the live board',
    'The live cockpit. Weight here is the input the Allocator rebalance reads as the current state.',
    'Options and futures are marked on a separate path and are excluded from the weighted equity legs handed to other tools, surfaced as a note rather than dropped silently.')
row('pm_unrealized','derived_metric','Portfolio Manager','Unrealized P&L and return',
    'Gain or loss against cost basis, in dollars and percent.',
    'shares * (price - avg cost); return = price / avg cost - 1',
    'book cost basis + live price', LV, 'polling, 10s',
    'Cost basis is user-entered, so this is only as accurate as what was typed. Imported books carry the basis from the import where the source had one.',
    'No lot-level tracking, so a position built in several tranches shows one blended basis and cannot produce tax-lot reporting.')
row('pm_dividends','feed_field','Portfolio Manager','Dividends',
    'Dividend history and forward yield for held names.', '-', 'yfinance dividend history',
    prov('/api/market/dividends'), 'daily',
    'Turns a price-return book into something closer to total return. Ex-dates matter for anyone hedging around them.',
    'Historical dividends only; a forward estimate is an extrapolation of the last declared rate. Special dividends distort a trailing yield badly.')
row('pm_intraday_curve','derived_metric','Portfolio Manager','Intraday book-value curve',
    'Book value through the session, from polled marks.',
    'sum(shares * price) recomputed on each poll and appended to an in-session series',
    'the same polled quotes', LV, '10s polling, in-session only',
    'Shows the day path rather than just the endpoint. The axis is deliberately a fixed numeric time axis with a stable value domain, because auto-scaling on a polling chart makes the line appear to jump on every tick.',
    'In-session only and not persisted, so a refresh restarts the curve. Built from polled marks, so a gap in polling appears as a straight line rather than as missing data.')
