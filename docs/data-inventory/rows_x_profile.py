from build_inv import row, prov
HUB = prov('/api/corporate/hub'); SI = prov('/api/corporate/short-interest', 'backend/short_interest.py:101')
BETA = prov('/api/market/beta-suite', 'backend/routers/market.py:647')

def f(id, name, defn, interp, lim, formula='-', src='yfinance info / FMP / FactSet Overview',
      p=HUB, cad='quote 5m, fundamentals 12h', kind='feed_field', tool='Company Profile'):
    row(id, kind, tool, name, defn, formula, src, p, cad, interp, lim)

f('cp_price','Current price and day change','Last trade and its move on the session.',
  'The anchor every ratio on the page divides by, so a stale quote silently ages every multiple beside it.',
  'Delayed outside market hours. Extended-hours prints are shown where the source supplies them but are thin and can be crossed.')
f('cp_market_cap','Market cap','Equity value at the current price.', formula='shares outstanding x price',
  interp='The size classification everything else keys off, and the denominator for the concentration figures in other tools.',
  lim='yfinance reports one share class, so a multi-class issuer (Alphabet, Berkshire, Ford) is understated against a full-float figure. Not adjusted for treasury stock.')
f('cp_pe','P/E ratio','Price against trailing twelve-month earnings.', formula='price / EPS (TTM)',
  interp='The most-quoted multiple and the least comparable across sectors. Only useful against the same company history or a genuine peer set.',
  lim='Meaningless on negative earnings and suppressed rather than shown negative. TTM includes one-offs, so a single impairment can distort it for four quarters.')
f('cp_eps','EPS (TTM)','Trailing twelve-month earnings per share.', formula='sum of the last four reported quarterly diluted EPS',
  interp='The numerator behind P/E and the cleanest single profitability figure per share.',
  lim='Diluted or basic depends on what the source reported. Restatements are picked up silently on the next refresh.')
f('cp_div_yield','Dividend yield','Trailing dividends as a share of price.', formula='trailing 12m dividends / price * 100',
  interp='Rises mechanically when the price falls, so a high yield is as often a warning as an attraction. Check it against the payout trend rather than in isolation.',
  lim='Trailing, so a cut already announced but not yet effective still shows the old rate. Special dividends inflate it for a year.')
f('cp_capm_beta','CAPM beta','Ordinary market beta from a simple regression.',
  formula='cov(stock returns, market returns) / var(market returns)', src='Ken French factors + yfinance',
  p=BETA, cad='on request', kind='derived_metric',
  interp='The textbook figure, shown so the divergence against the Scholes-Williams estimate beside it is visible rather than hidden.',
  lim='Biased toward 1 for thinly traded names because the stock return desynchronises from the same-day market move. That bias is exactly what the adjacent estimate corrects.')
f('cp_sw_beta','Scholes-Williams beta','Beta corrected for non-synchronous trading.',
  formula='cov(ln(1+r_i), mr3) / cov(ln(1+r_m), mr3) where mr3 sums the previous, current and next market log return',
  src='Ken French factors + yfinance', p=BETA, cad='on request', kind='model',
  interp='The estimate to trust for an illiquid name. The app flags divergence from CAPM beta past 15% as a thin-trading warning.',
  lim='The 15% flag is a starting threshold, not a statistically derived cutoff, and the code says so. Daily frequency only; the lead-lag correction is meaningless at lower frequency.')
f('cp_idio_vol','Idiosyncratic and total volatility','Risk not explained by the factor model, and total risk.',
  formula='annualised standard deviation of the factor-regression residuals (IVOL); annualised stdev of raw returns (TVOL)',
  src='Ken French factors', p=BETA, cad='on request', kind='derived_metric',
  interp='High idiosyncratic volatility means the name moves on its own news, which is what a stock-picker wants and a diversifier does not.',
  lim='Residual to a specific factor set, so a missing factor shows up as idiosyncratic risk that is actually systematic.')
f('cp_max_dd','Max drawdown and market performance','Worst peak-to-trough fall, and return against the index.',
  formula='min(price/cummax(price) - 1); relative return vs benchmark over the window',
  src='yfinance history', p=prov('/api/market/history'), cad='daily', kind='derived_metric',
  interp='The pair answers "how much pain, for how much reward" in one line.',
  lim='Window-dependent and close-based, so intraday depth is understated.')
f('cp_avg_volume','Average daily volume','Typical shares traded per session.', formula='mean daily volume over the trailing window',
  src='yfinance', p=prov('/api/market/history'), cad='daily', kind='derived_metric',
  interp='The liquidity check that decides whether a position is exitable, and the denominator for days-to-cover.',
  lim='Shares, not dollars, so it is not comparable across price levels. A single block trade skews a short window.')

f('cp_shares_short','Shares short and short % of float','Size of the short position, absolutely and against tradable shares.',
  formula='shares short; shares short / float; shares short / shares outstanding',
  src='FINRA consolidated biweekly file', p=SI, cad='biweekly settlement', kind='feed_field',
  interp='Percent of float is the meaningful version: 20% of a small float is a very different setup from 20% of outstanding on a mega cap.',
  lim='Float is sourced separately from the short figure and the two can be dated differently, so the ratio can be internally inconsistent by a couple of weeks.')

f('cp_target_spread','Mean, high and low price target','The analyst target range.', formula='-',
  src='yfinance analyst_price_targets', p=prov('/api/corporate/hub/analyst'), cad='on request',
  interp='The spread matters more than the mean. A tight cluster is real consensus; a 3x range between high and low means the sell side disagrees about the business, not about the price.',
  lim='No target dates are published, so a stale target from a departed analyst sits in the mean indefinitely. Structurally optimistic.')
f('cp_implied_upside','Implied upside','Distance from the current price to the mean target.',
  formula='target_mean / price - 1', src='derived', p=prov('/api/corporate/hub/analyst'),
  cad='on request', kind='derived_metric',
  interp='Moves as much on price as on any change of view, so a rising implied upside during a selloff is usually the price falling, not analysts turning bullish.',
  lim='Inherits every bias in the target set. Not a forecast and not a probability.')
f('cp_consensus','Consensus recommendation and distribution','The buy/hold/sell split and its summary rating.',
  formula='counts of strongBuy/buy/hold/sell/strongSell; mean recommendation score',
  src='yfinance recommendations', p=prov('/api/corporate/hub/analyst'), cad='on request',
  interp='Read the distribution, not the mean. Sell-side ratings are compressed into the top half of the scale, so "hold" often functions as a sell.',
  lim='Coverage counts vary wildly by size; a mean over three analysts is not consensus.')

f('cp_debt_maturity','Debt maturity ladder','When outstanding debt comes due, by year.', formula='-',
  src='SEC filings via corporate DB', p=prov('/api/corporate/debt-maturity'), cad='on filing',
  interp='A wall of maturities inside two years at rates above the existing coupon is a refinancing risk the leverage ratios alone will not show.',
  lim='Only issues captured in the filing extraction appear. Revolvers and undrawn facilities are usually absent, which understates flexibility.')
f('cp_ma_activity','M&A activity','Announced deals involving the company.', formula='-',
  src='SDC deals table in the bundled corporate DB', p=prov('/api/corporate/deals'), cad='static extract',
  interp='Context for a valuation gap: a name trading at a discount with recent approach activity is a different situation from one without.',
  lim='From a static bundled extract with no as-of date shown in the UI, so recent deals may be missing entirely.')
f('cp_revenue_segments','Revenue by segment, geography and activity','Reported revenue splits.', formula='-',
  src='SEC filings / FactSet Overview', p=HUB, cad='on filing',
  interp='The input to any sum-of-the-parts view, and the fastest way to see whether a "software company" is actually a hardware company.',
  lim='Segment definitions are the company own and change between years without restatement. The activity split (fees vs trading) only exists for financials.')
