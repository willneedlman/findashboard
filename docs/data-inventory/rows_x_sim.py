from build_inv import row, prov
BT = prov('/api/strategy/portfolio-backtest', 'backend/routers/algo.py:387 _compute_metrics()')
MC = prov('/api/portfolio/montecarlo')
A  = 'backend/routers/algo.py'

def bt(id, name, defn, formula, interp, lim, tool='Portfolio Backtester', kind='derived_metric'):
    row(id, kind, tool, name, defn, formula, 'yfinance daily bars through the shared signal engine',
        BT, 'on request', interp, lim)

bt('bt_total_return','Total return','Cumulative strategy return over the backtest window.',
   'final equity / starting capital - 1',
   'The raw result before any risk adjustment. Always read against the buy-and-hold line on the same chart: a strategy that underperforms holding is not a strategy.',
   'No commission, slippage, spread or borrow. Fills are at the close of the signal bar, which is unachievable in practice and flatters any signal that keys off the close.')
bt('bt_strategy_cagr','Strategy CAGR','Annualised compound return of the strategy.',
   '(final/initial)^(periods_per_year/observations) - 1',
   'Makes windows of different length comparable. The paired Portfolio CAGR column is the same figure for the underlying held passively.',
   'Annualising a short backtest is the most common way to make noise look like edge. Under about three years it says very little.')
bt('bt_ann_vol','Annualized volatility','Volatility of strategy returns.',
   'stdev(strategy daily returns) * sqrt(bars_per_year) * 100',
   'A strategy in cash most of the time posts low volatility for a reason that has nothing to do with skill. Read alongside time-in-market.',
   'Computed over all bars including flat ones, so a rarely-traded strategy looks far calmer than it is when actually positioned.')
bt('bt_sharpe','Sharpe ratio','Risk-adjusted strategy return.',
   'mean(strategy daily return) / stdev(strategy daily return) * sqrt(bars_per_year)',
   'The standard comparator across strategies on the same instrument. Anything above 2 on a daily-bar backtest of a simple rule set should be assumed to be overfitting until proven otherwise.',
   'No risk-free subtraction in this engine, so it is a raw information-ratio-style figure and reads high against a textbook Sharpe in a high-rate environment.')
bt('bt_sortino','Sortino','Downside-adjusted strategy return.',
   'mean return / downside deviation * sqrt(bars_per_year)',
   'The right ratio for a trend strategy, whose whole design is to have lumpy upside and clipped downside.',
   'Downside deviation on a sparse trade count is estimated from very few observations and is correspondingly unstable.')
bt('bt_calmar','Calmar','Strategy return per unit of worst drawdown.',
   'annualised return / |max drawdown|', 
   'The ratio most aligned with whether a strategy is actually holdable through its bad period.',
   'One historical drawdown sets the denominator, so the figure changes discontinuously when the window crosses a crash.')
bt('bt_max_dd','Max drawdown','Deepest peak-to-trough fall in strategy equity.',
   'min(equity / cummax(equity) - 1) * 100',
   'The number that decides whether a backtest is investable. A 25% CAGR with a 70% drawdown is a strategy nobody holds to the recovery.',
   'Close-to-close on the bar interval, so intraday depth and any stop that would have triggered inside a bar are invisible.')
bt('bt_win_rate','Win rate','Share of closed trades that were profitable.',
   'winning trades / total trades * 100',
   'Almost useless alone and routinely misread. A 35% win rate with 4:1 winners beats a 70% win rate with 1:3, which is why the P&L and average-hold columns sit next to it.',
   'Sensitive to how a trade is defined: this engine closes a trade on the exit signal, so a strategy that scales out registers differently from one that exits at once.')
bt('bt_num_trades','Trades and average hold','How many round trips the strategy made and how long each lasted.',
   'count of entry-to-exit pairs; mean bars held, converted to days',
   'The sample size behind every other statistic here. Fewer than about 30 trades means the Sharpe and win rate are anecdotes.',
   'A high trade count on daily bars implies costs this engine does not model, so the more trades a strategy makes the more optimistic its result.')
def mcr(id, name, defn, formula, interp, lim):
    row(id, 'model', 'Monte Carlo', name, defn, formula, 'in-house simulation engine',
        MC, 'on request, job-queued for long runs', interp, lim)

mcr('mc_median_final','Median final value','Middle terminal outcome across simulated paths.',
    'quantile(terminal equity, 0.50)',
    'The central case. Reported as a median rather than a mean because terminal wealth of a compounding series is right-skewed and the mean sits above almost every path.',
    'Inherits the drift assumption directly. If drift is estimated from the same history being simulated, this is close to circular.')
mcr('mc_p5_p95','P5 and P95 outcomes','The 5th and 95th percentile terminal outcomes.',
    'quantile(terminal equity, 0.05) and (0.95)',
    'The width between them is the real output. A band spanning 5x means the horizon is too long or the volatility too high for any point estimate to be meaningful.',
    'Tail quantiles need far more paths to stabilise than the median. A run with few paths shows a steady median and a jittery band.')
mcr('mc_prob_profit','Probability of profit','Share of paths finishing above the starting value.',
    'count(terminal > initial) / paths * 100',
    'The most intuitive output and the easiest to over-read. For an options structure it is the headline, but a 70% win probability with a 5:1 loss ratio is a losing trade.',
    'Says nothing about magnitude. Always read beside max loss and CVaR, which is why they are on the same strip.')
mcr('mc_prob_ruin','Probability of ruin and forced liquidation','Share of paths that hit zero or a margin call.',
    'count(paths breaching ruin or the maintenance requirement) / paths * 100',
    'The constraint that makes median outcomes irrelevant: a path that liquidates cannot recover, so leverage turns a good median into a bad expectation.',
    'Depends on user-entered maintenance percentages. Assumes no top-up and no discretionary deleveraging, which is conservative but not always realistic.')
mcr('mc_vol_drag','Volatility drag','The gap between arithmetic and geometric return caused by volatility.',
    'arithmetic mean return - geometric mean return, approximately variance / 2',
    'Explains why a strategy with a positive average return can still lose money. The drag grows with the square of volatility, which is the mathematical case against leverage.',
    'The variance/2 approximation breaks down at high volatility, where the true drag is larger than the formula suggests.')
mcr('mc_max_dd_median','Median max drawdown','Typical worst fall across simulated paths.',
    'median of the per-path maximum drawdown',
    'More useful than a single historical drawdown because it is a distribution: it answers "what drawdown should I expect", not "what happened once".',
    'Only as good as the path generator. GBM cannot produce clustered volatility, so its drawdowns are systematically too shallow.')
mcr('mc_median_peak_margin','Median peak margin','Highest margin utilisation reached on a typical path.',
    'median across paths of the maximum margin requirement as a share of equity',
    'The early-warning number for a levered structure: a book that peaks at 90% utilisation on the median path will breach on plenty of others.',
    'Peak is per-path, so the median peak is not the peak of the median path and cannot be read off the equity fan.')
mcr('mc_exact_replay','Exact replay return','What the structure would have returned over the actual historical path.',
    'the strategy evaluated on the realised price series rather than on simulated ones',
    'The control for the simulation. A large gap between replay and median simulated return means the model assumptions, not the strategy, are producing the result.',
    'A single path, so it is an anecdote by construction. Included as a sanity check, not as evidence.')
row('mc_sim_model','user_input','Monte Carlo','Simulation model',
    'GBM physical, GBM risk-neutral, Student-t or block bootstrap.',
    'physical GBM uses estimated drift; risk-neutral sets drift to the risk-free rate; Student-t adds a tail degrees-of-freedom parameter; block bootstrap resamples real returns in 10-day blocks',
    'user selection', MC, 'per run',
    'Risk-neutral is the correct choice for pricing an option structure; physical is the correct choice for forecasting a portfolio. Using the wrong one is the most common error this selector prevents.',
    'The same structure produces materially different probability-of-profit under each. The choice is exposed rather than hidden precisely because it is not neutral.')
row('mc_exit_rules','user_input','Monte Carlo','Stop-loss, take-profit and hold-to-cap outcomes',
    'How each simulated path terminated.',
    'count of paths hitting the stop, the target, or running to the horizon',
    'user-entered exit rules', MC, 'per run',
    'The distribution of exit reasons is the clearest picture of whether the exit rules are doing anything. If 95% of paths hold to cap, the stop is decorative.',
    'Stops are evaluated at bar close, so a path that would have gapped through a stop is filled at the stop level rather than at the gap.')
