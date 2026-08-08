from build_inv import row, prov
M = prov('/api/master-valuation/analyze'); D = prov('/api/dcf/calculate', 'backend/routers/dcf.py:171 _project()')

def mv(id, name, defn, formula, interp, lim, kind='user_input', tool='Master Valuation', p=None):
    row(id, kind, tool, name, defn, formula, 'user assumption, seeded from filings where available',
        p or M, 'per model run', interp, lim)

mv('mv_base_revenue','Base revenue','Starting revenue the forecast grows from.','seeded from the latest reported TTM revenue',
   'Everything downstream scales off this one number, so a wrong base is the most expensive input error available.',
   'Seeded from TTM, which lags a turn. For a company mid-acquisition the base is pre-deal unless overridden.')
mv('mv_revenue_cagr','Revenue CAGR','Compound growth applied across the forecast.','user rate, faded toward terminal growth over the horizon',
   'The single assumption the output is most sensitive to after WACC. Sanity-check it against the company own history and the industry, both of which are on the page.',
   'A constant CAGR is a fiction for any real business. The fade toward terminal growth softens it but the shape is still imposed rather than modelled.')
mv('mv_terminal_margin','Terminal margin','Operating margin the business converges to.','linear glide from the current margin to the terminal target across the horizon',
   'Where most optimism hides. A terminal margin above the best year the company or its industry has ever posted is the most common way a DCF is talked into a target price.',
   'Damodaran industry data is available as a reality check but is not enforced. Nothing prevents an unattainable value.')
mv('mv_wacc','WACC','Discount rate applied to projected cash flows.','cost of equity from CAPM (risk free + beta x ERP) blended with after-tax cost of debt at target weights',
   'Together with terminal growth it usually moves fair value more than any operating assumption, which is why the sensitivity grid defaults to this axis.',
   'Must exceed terminal growth or the perpetuity formula diverges and the model is nonsense. Beta silently backstops from the bundled Damodaran snapshot when the vendor has none.')
mv('mv_terminal_growth','Terminal growth','Perpetual growth rate after the explicit forecast.','g in TV = FCFF_final x (1+g) / (WACC - g)',
   'Terminal value is typically 60-80% of total DCF value, so this single number dominates the answer. Anything above long-run nominal GDP is a claim the company grows forever faster than the economy.',
   'The model is hypersensitive here: the gap (WACC - g) sits in a denominator, so small changes produce large swings as the two converge.')
mv('mv_net_debt','Net debt and diluted shares','Bridge from enterprise value to value per share.','equity value = enterprise value - net debt; per share = equity value / diluted shares',
   'The unglamorous step where a good enterprise valuation becomes a wrong per-share number. Dilution from options and converts is frequently understated.',
   'Diluted share count is as reported and excludes announced but unissued dilution. Net debt uses period-end cash, which is seasonal for many businesses.')
mv('mv_fcff','Cash from profit (FCFF)','Free cash flow to the firm in each projected year.',
   'EBIT x (1 - tax) + D&A - capex - change in working capital',
   'The actual thing being discounted. The reconciliation from margin to cash is where capital intensity shows up, and it is the step most skipped.',
   'Working capital is modelled as a share of revenue rather than from the individual line items, so a business with unusual payables dynamics is mis-modelled.')

def blend(id, name, defn, formula, interp, lim):
    row(id, 'model', 'Master Valuation', name, defn, formula, 'the four valuation legs', M, 'on request', interp, lim)

blend('mv_dcf_leg','Intrinsic DCF value','Per-share value from the discounted cash flow leg.',
      'sum of discounted FCFF plus discounted terminal value, less net debt, per diluted share',
      'The only leg that does not depend on other companies being priced correctly, which is its whole argument.',
      'Also the leg with the most assumptions, and terminal value dominates it. Independence from the market is bought with dependence on the modeller.')
blend('mv_multiples_leg','Market multiples value','Per-share value from peer multiples.',
      'each selected target multiple applied to the matching company metric, blended by the target weights',
      'Market-anchored and fast. The spread across targets tells you whether the peer set actually agrees.',
      'Assumes the peer group is fairly valued, which is precisely what is in question during a bubble or a washout.')
blend('mv_blended','Blended value','One value per share across the enabled methods.',
      'weighted mean over methods that produced a value, using renormalised active weights',
      'Effective weights are displayed separately from requested weights, so a method that failed to produce a value visibly drops out instead of silently dragging the blend toward zero.',
      'Averaging four models does not reduce error when they share inputs, and three of the four use the same share count and net debt. A confident blend can rest on one bad balance sheet.')
blend('mv_market_gap','Market price vs blended value','The gap the model is claiming.',
      'blended value / market price - 1',
      'The output the whole tool exists to produce. Read it against the sensitivity grid: if the grid spans 2x, a 20% gap is inside the noise of the model.',
      'A gap is a statement about the assumptions, not about the market. The Reverse DCF tool inverts the question and is usually the more disciplined way to ask it.')

row('mv_ai_suggestions','model','Master Valuation','Filing evidence, risks and watch items',
    'LLM-extracted evidence from filings supporting or challenging the assumptions.',
    'retrieval over filing text, summarised by the LLM stack', 'SEC EDGAR text + Groq/Cerebras',
    prov('/api/ai/valuation-evidence') if False else M, 'on request',
    'Grounds the assumptions in the actual filing rather than in the modeller priors. Dismissible, and never writes an assumption on its own.',
    'Generated text over retrieved passages: it can miss context and can restate a risk factor boilerplate as a finding. Nothing here changes a number unless a human accepts it.')

# ── Chart Studio ──
CS = prov('/api/market/ohlcv'); EV = prov('/api/market/chart-events')
def cs(id, name, defn, formula, interp, lim, kind='derived_metric', p=None, src='OHLCV from Alpaca where available, else yfinance'):
    row(id, kind, 'Chart Studio', name, defn, formula, src, p or CS, 'candles 60s intraday / 300s daily', interp, lim)

cs('cs_candles','OHLCV candles','Open, high, low, close and volume at the selected timeframe.','-',
   'The base layer. Alpaca supplies up to 119 days of 5-minute bars against yfinance 60-day cap, so intraday history is materially deeper when the key is set.',
   'Alpaca covers US equities and ETFs only; indices, futures, FX and crypto are screened out and served by yfinance or Binance. Feed is IEX, not full-market SIP, so volume is a fraction of consolidated tape.',
   kind='feed_field')
cs('cs_vwap','VWAP','Volume-weighted average price across the visible session.',
   'cumulative(price x volume) / cumulative(volume), reset per session',
   'The execution benchmark. Price above VWAP with rising volume is the classic intraday strength read.',
   'On the IEX feed the volume is a partial tape, so VWAP is computed off a subset of prints and will differ from a consolidated VWAP.')
cs('cs_ma','Moving averages','Simple or exponential average over a chosen period.',
   'SMA = mean(close, N); EMA = exponentially weighted mean with span N',
   'Both the type and period are user-set, so the overlay matches whatever convention the reader already uses rather than imposing one.',
   'Computed on the loaded window only, so an average with a long period is undefined at the left edge rather than borrowing prior history.')
cs('cs_bollinger','Bollinger bands','Volatility envelope around a moving average.',
   'SMA(close, N) plus and minus k standard deviations of close over the same window',
   'Band width is a volatility read in itself: a squeeze usually precedes an expansion, regardless of direction.',
   'Assumes returns are normally distributed around the mean, which they are not, so touches of the band are more frequent than the nominal probability implies.')
cs('cs_rsi','RSI','Relative strength index momentum oscillator.',
   '100 - 100/(1 + average gain / average loss) over the period, Wilder smoothing',
   'Above 70 and below 30 are the conventional extremes, drawn as reference lines. In a strong trend RSI stays extreme for a long time, which is why it is a lane and not a signal.',
   'Bounded, so it compresses information at the extremes. Divergence readings are subjective and not computed here.')
cs('cs_macd','MACD','Trend and momentum from two exponential averages.',
   'MACD = EMA(12) - EMA(26); signal = EMA(9) of MACD; histogram = MACD - signal',
   'The histogram is the useful part: it crosses zero before the lines do, which is the earliest mechanical read of a momentum turn.',
   'Lagging by construction. Whipsaws badly in a range, generating crossovers with no follow-through.')
cs('cs_gex_lane','Dealer GEX lane','Net dealer gamma, gamma flip level and regime, plotted under price.',
   'net GEX and flip from the options exposure engine, resampled onto the chart timeline',
   'Putting the flip level on the same time axis as price is the point: it shows when price crossed into a negative-gamma regime rather than just that it is there now.',
   'Sparse relative to price, so the lane syncs one-way from the main chart and never back. A two-way sync would drag the price axis to the sparse series range.')
cs('cs_iv_lane','IV rank and percentile lane','Implied volatility positioning over time.',
   'IV rank and percentile from the snapshot history, resampled onto the chart timeline',
   'Shows whether the current option pricing is unusual in the context of the plotted price move.',
   'Limited by the accrued snapshot history, which starts when this app began recording rather than when the option started trading.')
cs('cs_macro_lanes','Macro overlay lanes','CPI, unemployment, DXY, VIX, US 3M and 10Y yields, Hormuz transits.',
   'each series fetched from its own source and resampled onto the chart timeline',
   'The reason this tool exists: it is the only place a single equity can be plotted against a macro series and a chokepoint transit count on one timeline.',
   'Monthly macro series step rather than move, so on an intraday chart they render as flat plateaus. Mixing frequencies on one axis is visually honest only because each lane is separate.')
cs('cs_events','Corporate event markers','Earnings, dividend and split markers pinned to the price timeline.','-',
   'Turns an unexplained gap into a labelled one, which is the fastest way to rule a move in or out as a data artefact.',
   'Coverage depends on filing data and is sparse for non-US names. Split adjustment is applied to prices, so an unmarked historical split would show as a real move.',
   kind='feed_field', p=EV, src='filings and yfinance actions')
