export const WIDGET_TYPES = [
  'price-card', 'mini-chart', 'news-feed', 'watchlist', 'macro-strip',
  'earnings-calendar', 'options-snapshot', 'portfolio-summary', 'options-pricer',
  'delta-target', 'tradingview-chart', 'correlation-matrix', 'macro-calendar',
  'global-macro', 'credit-spreads', 'yield-curve', 'sector-rotation', 'dealer-gex',
  'vol-skew', 'sentiment-gauge', 'screener', 'pm-portfolios', 'paper-trade',
  'index-tape', 'analyst-ratings', 'valuation', 'insider-activity', 'risk-metrics',
  'pnl-attribution', 'factor-decomposition', 'time-and-sales', 'unusual-flow',
  'heatmap', 'trade-blotter', 'position-sizer', 'market-hours', 'ticker-control',
] as const

export type WidgetType = typeof WIDGET_TYPES[number]
export type WidgetPriority = 'primary' | 'secondary' | 'supporting'
export type DashboardRegion = 'top' | 'center' | 'rail' | 'body' | 'bottom'
export type DashboardObjective = 'trading' | 'portfolio' | 'macro' | 'risk' | 'research' | 'screening' | 'options' | 'general'
export type WidgetDisplayState = 'auto' | 'full' | 'compact' | 'summary' | 'minimum'
export type WidgetOrientation = 'horizontal' | 'vertical' | 'balanced'
export type WidgetDensity = 'compact' | 'standard' | 'dense'
export type WidgetVisualRole = 'focal' | 'supporting'
export type WidgetGrowth = 'fixed' | 'horizontal' | 'vertical' | 'bounded'

export const DEFAULT_MACRO_STRIP_SERIES = ['FED', '1Y', '2Y', '5Y', '10Y', 'SPREAD']
export const MACRO_STRIP_SERIES = [
  'FED', '1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y',
  'SPREAD', 'SPREAD_5_30',
]
export const CREDIT_SPREAD_SERIES = ['ig', 'hy', 'ig_3_5', 'hy_b', 'hy_ccc', 'vix']
export const MACRO_CALENDAR_CATEGORIES = ['monetary', 'inflation', 'employment', 'growth', 'housing', 'sentiment']
export const SECTOR_ROTATION_PERIODS = ['1W', '1M', '3M', '6M', 'YTD', '1Y']

export interface WidgetConfig {
  id: string
  type: WidgetType
  title?: string
  ticker?: string
  tickers?: string[]
  period?: '1mo' | '3mo' | '6mo' | '1y'
  color?: string
  weights?: number[]
  categories?: string[]
  lookback?: number
  chartMode?: 'cumulative' | 'beta'
  periodDays?: number
  visibleCols?: string[]
  newsExpand?: 'first' | 'all' | 'none'
  visibleItems?: string[]
  targetDelta?: number
  expDays?: number
  optionType?: 'call' | 'put'
  strike?: number
  vol?: number
  expiry?: string
  timeframeHours?: number
  sectorPeriod?: string
  riskPct?: number
  entry?: number
  stop?: number
  accountValue?: number
  portfolioId?: string
  layout?: 'clock' | 'rows'
  macroSymbols?: string[]
  factorModel?: 'macro' | 'style'
  benchmark?: string
  factorCategories?: string[]
  contributionDisplay?: boolean
  exposureDisplay?: boolean
  valueMode?: 'absolute' | 'relative'
  presentation?: 'chart' | 'table'
  sortBy?: 'risk' | 'exposure' | 'factor'
  filter?: string
  visible?: boolean
  displayState?: WidgetDisplayState
}

export interface WidgetDefinition {
  id: WidgetType
  name: string
  icon: string
  category: string
  purpose: string
  dataType: string
  priority: WidgetPriority
  orientation: WidgetOrientation
  density: WidgetDensity
  visualRole: WidgetVisualRole
  growth: WidgetGrowth
  preferred: { w: number; h: number }
  minimum: { w: number; h: number }
  maximum: { w: number; h: number }
  region: DashboardRegion
  compatible: WidgetType[]
  related: WidgetType[]
  conflicts: WidgetType[]
  dataSources: string[]
  configOptions: (keyof WidgetConfig)[]
  defaultConfig: Partial<WidgetConfig>
  interactive: boolean
  sticky: boolean
  multiple: boolean
  objectives: DashboardObjective[]
  description: string
}

type DefinitionInput = Pick<WidgetDefinition, 'name' | 'icon' | 'category' | 'purpose' | 'dataType' | 'priority' | 'preferred' | 'minimum' | 'region' | 'description'> & Partial<Omit<WidgetDefinition, 'id' | 'name' | 'icon' | 'category' | 'purpose' | 'dataType' | 'priority' | 'preferred' | 'minimum' | 'region' | 'description'>>

function define(id: WidgetType, input: DefinitionInput): WidgetDefinition {
  const maximum = input.maximum ?? {
    w: Math.min(12, input.preferred.w + 2),
    h: input.preferred.h + 2,
  }
  const orientation: WidgetOrientation = input.orientation
    ?? (input.preferred.w >= input.preferred.h * 1.6 ? 'horizontal' : input.preferred.h >= input.preferred.w * 1.6 ? 'vertical' : 'balanced')
  const density: WidgetDensity = input.density
    ?? (/table|list|feed|calendar|tape|board/i.test(input.dataType) ? 'dense' : /summary|metrics/i.test(input.dataType) ? 'compact' : 'standard')
  const visualRole: WidgetVisualRole = input.visualRole ?? (input.priority === 'primary' ? 'focal' : 'supporting')
  const growth: WidgetGrowth = input.growth
    ?? (input.region === 'top' || orientation === 'horizontal' ? 'horizontal' : density === 'dense' ? 'vertical' : 'bounded')
  return {
    id,
    compatible: [],
    related: [],
    conflicts: [],
    dataSources: [],
    configOptions: [],
    defaultConfig: {},
    interactive: false,
    sticky: false,
    multiple: true,
    objectives: ['general'],
    ...input,
    maximum,
    orientation,
    density,
    visualRole,
    growth,
  }
}

export const WIDGET_DEFINITIONS: Record<WidgetType, WidgetDefinition> = {
  'index-tape': define('index-tape', { name: 'Index Tape', icon: 'IDX', category: 'Market context', purpose: 'Broad live market context', dataType: 'Streaming quotes', priority: 'supporting', preferred: { w: 12, h: 1 }, minimum: { w: 6, h: 1 }, maximum: { w: 12, h: 2 }, region: 'top', sticky: true, multiple: false, interactive: true, objectives: ['trading', 'macro', 'screening'], compatible: ['tradingview-chart', 'paper-trade', 'heatmap'], related: ['market-hours', 'global-macro'], dataSources: ['live quote'], configOptions: ['tickers'], defaultConfig: { tickers: ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', 'BTC-USD'] }, description: 'Full-width live price strip that anchors market and trading dashboards.' }),
  'paper-trade': define('paper-trade', { name: 'Paper Trade', icon: 'TR', category: 'Trading', purpose: 'Primary chart and order-entry workspace', dataType: 'Interactive chart and orders', priority: 'primary', preferred: { w: 9, h: 10 }, minimum: { w: 6, h: 8 }, region: 'center', interactive: true, objectives: ['trading'], compatible: ['watchlist', 'trade-blotter', 'position-sizer'], related: ['index-tape', 'time-and-sales'], conflicts: ['tradingview-chart'], dataSources: ['paper account', 'market bars'], configOptions: ['ticker'], defaultConfig: { ticker: 'SPY' }, description: 'Large chart and order-entry surface for the paper account.' }),
  'tradingview-chart': define('tradingview-chart', { name: 'TradingView Chart', icon: 'TV', category: 'Trading', purpose: 'Primary price analysis surface', dataType: 'Candles and volume', priority: 'primary', preferred: { w: 8, h: 8 }, minimum: { w: 5, h: 6 }, region: 'center', interactive: true, objectives: ['trading', 'research'], compatible: ['watchlist', 'news-feed', 'options-snapshot'], related: ['price-card', 'mini-chart'], conflicts: ['paper-trade'], dataSources: ['market history', 'live quote'], configOptions: ['ticker', 'period'], defaultConfig: { ticker: 'SPY', period: '3mo' }, description: 'Large candlestick and volume chart with a live mark.' }),
  'heatmap': define('heatmap', { name: 'Market Heatmap', icon: 'HM', category: 'Screening', purpose: 'Market breadth and leadership', dataType: 'Treemap', priority: 'primary', preferred: { w: 8, h: 8 }, minimum: { w: 6, h: 6 }, region: 'center', interactive: true, objectives: ['screening', 'macro'], related: ['sector-rotation', 'screener'], dataSources: ['market movers'], description: 'Market-cap treemap with printed daily returns.' }),
  'screener': define('screener', { name: 'Screener', icon: 'SCR', category: 'Screening', purpose: 'Find names matching a market screen', dataType: 'Dense sortable table', priority: 'primary', preferred: { w: 7, h: 9 }, minimum: { w: 5, h: 6 }, region: 'center', interactive: true, objectives: ['screening', 'research'], compatible: ['watchlist', 'mini-chart'], related: ['heatmap', 'sector-rotation'], dataSources: ['market screener'], description: 'Dense equity screening table for gainers, losers, volume, and large caps.' }),
  'risk-metrics': define('risk-metrics', { name: 'Risk Metrics', icon: 'RSK', category: 'Portfolio', purpose: 'Portfolio volatility, drawdown, and concentration', dataType: 'Metrics and concentration bars', priority: 'primary', preferred: { w: 5, h: 6 }, minimum: { w: 4, h: 6 }, region: 'center', objectives: ['risk', 'portfolio'], compatible: ['portfolio-summary', 'factor-decomposition', 'pnl-attribution'], related: ['correlation-matrix', 'pm-portfolios'], dataSources: ['portfolio manager', 'market history'], configOptions: ['portfolioId', 'benchmark'], defaultConfig: { benchmark: 'SPY' }, description: 'Portfolio VaR, beta, volatility, drawdown, and concentration.' }),
  'factor-decomposition': define('factor-decomposition', { name: 'Factor Decomposition', icon: 'FAC', category: 'Portfolio', purpose: 'Explain portfolio exposure and risk contribution by factor', dataType: 'Factor bars, exposure chart, and table', priority: 'primary', preferred: { w: 7, h: 5 }, minimum: { w: 5, h: 5 }, region: 'center', interactive: true, objectives: ['risk', 'portfolio'], compatible: ['risk-metrics', 'pnl-attribution'], related: ['correlation-matrix', 'pm-portfolios'], dataSources: ['portfolio manager', 'factor models', 'market history'], configOptions: ['portfolioId', 'factorModel', 'lookback', 'benchmark', 'factorCategories', 'contributionDisplay', 'exposureDisplay', 'valueMode', 'presentation', 'sortBy', 'filter'], defaultConfig: { factorModel: 'macro', lookback: 365, benchmark: 'SPY', factorCategories: ['market', 'rates', 'credit', 'oil', 'dollar'], contributionDisplay: true, exposureDisplay: true, valueMode: 'absolute', presentation: 'chart', sortBy: 'risk', filter: '' }, description: 'Standalone macro or style factor exposure and risk contribution for a saved portfolio.' }),
  'global-macro': define('global-macro', { name: 'Global Macro', icon: 'FX', category: 'Macro', purpose: 'Cross-asset global market board', dataType: 'Dense grouped quote list', priority: 'secondary', preferred: { w: 4, h: 9 }, minimum: { w: 3, h: 6 }, region: 'rail', objectives: ['macro', 'risk'], compatible: ['yield-curve', 'credit-spreads', 'macro-calendar'], related: ['index-tape', 'market-hours'], dataSources: ['global market board'], configOptions: ['categories', 'macroSymbols'], defaultConfig: { categories: ['equity', 'fx', 'bond', 'commodity', 'vol', 'crypto'], macroSymbols: [] }, description: 'Selectable indices, rates, commodities, currencies, crypto, and volatility series.' }),
  'macro-calendar': define('macro-calendar', { name: 'Macro Calendar', icon: 'CAL', category: 'Macro', purpose: 'Track scheduled economic catalysts', dataType: 'Event table', priority: 'secondary', preferred: { w: 5, h: 4 }, minimum: { w: 4, h: 3 }, maximum: { w: 7, h: 6 }, region: 'body', density: 'dense', growth: 'bounded', multiple: false, objectives: ['macro', 'research'], related: ['global-macro', 'yield-curve'], dataSources: ['macro events'], configOptions: ['categories'], defaultConfig: { categories: MACRO_CALENDAR_CATEGORIES }, description: 'Economic releases with consensus, prior, and market reaction.' }),
  'yield-curve': define('yield-curve', { name: 'Yield Curve', icon: 'YC', category: 'Macro', purpose: 'Read rates shape and inversion', dataType: 'Curve chart and spreads', priority: 'secondary', preferred: { w: 5, h: 7 }, minimum: { w: 4, h: 5 }, maximum: { w: 7, h: 8 }, region: 'body', visualRole: 'focal', multiple: false, objectives: ['macro', 'risk'], related: ['credit-spreads', 'macro-strip'], dataSources: ['Treasury yields'], description: 'Treasury curve, key spreads, and inversion history.' }),
  'credit-spreads': define('credit-spreads', { name: 'Credit Spreads', icon: 'CR', category: 'Macro', purpose: 'Read credit quality and decompression', dataType: 'Time series and quality ladder', priority: 'secondary', preferred: { w: 4, h: 7 }, minimum: { w: 4, h: 6 }, maximum: { w: 6, h: 8 }, region: 'body', multiple: false, objectives: ['macro', 'risk'], related: ['yield-curve', 'risk-metrics'], dataSources: ['FRED', 'market history'], configOptions: ['categories', 'lookback'], defaultConfig: { categories: ['ig', 'hy', 'vix'], lookback: 90 }, description: 'Credit quality ladder, z-scores, OAS history, and VIX.' }),
  'options-snapshot': define('options-snapshot', { name: 'Options Snapshot', icon: 'OPT', category: 'Options', purpose: 'Primary volatility and probability snapshot', dataType: 'Metrics and distributions', priority: 'primary', preferred: { w: 7, h: 8 }, minimum: { w: 5, h: 6 }, region: 'center', objectives: ['options', 'trading'], related: ['dealer-gex', 'vol-skew'], dataSources: ['Tradier'], configOptions: ['ticker', 'visibleItems'], defaultConfig: { ticker: 'SPY' }, description: 'ATM IV, implied move, put-call ratio, vol cone, and probability.' }),
  'dealer-gex': define('dealer-gex', { name: 'Dealer Exposure', icon: 'GEX', category: 'Options', purpose: 'Locate gamma flip and dealer walls', dataType: 'Diverging strike bars', priority: 'secondary', preferred: { w: 4, h: 7 }, minimum: { w: 4, h: 5 }, region: 'body', objectives: ['options', 'trading'], related: ['vol-skew', 'options-snapshot'], dataSources: ['Tradier options'], configOptions: ['ticker', 'expiry'], defaultConfig: { ticker: 'SPY' }, description: 'Dealer gamma by strike with interpolated flip and positive and negative walls.' }),
  'vol-skew': define('vol-skew', { name: 'Vol Skew', icon: 'VOL', category: 'Options', purpose: 'Read smile and term structure', dataType: 'Volatility curves', priority: 'secondary', preferred: { w: 4, h: 7 }, minimum: { w: 4, h: 5 }, region: 'body', objectives: ['options', 'trading'], related: ['dealer-gex', 'options-snapshot'], dataSources: ['Tradier options'], configOptions: ['ticker', 'expiry'], defaultConfig: { ticker: 'SPY' }, description: 'Vendor IV smile, downside skew, and term structure.' }),
  'unusual-flow': define('unusual-flow', { name: 'Unusual Options Flow', icon: 'FLOW', category: 'Options', purpose: 'Surface concentrated options activity', dataType: 'Dense options table', priority: 'secondary', preferred: { w: 12, h: 6 }, minimum: { w: 6, h: 5 }, region: 'bottom', objectives: ['options', 'trading'], related: ['options-snapshot', 'dealer-gex'], dataSources: ['options chain'], configOptions: ['ticker'], defaultConfig: { ticker: 'SPY' }, description: 'Largest option trades ranked by premium and volume-to-open-interest.' }),
  'watchlist': define('watchlist', { name: 'Watchlist', icon: 'W', category: 'Market context', purpose: 'Monitor a focused ticker set', dataType: 'Compact quote list', priority: 'secondary', preferred: { w: 4, h: 6 }, minimum: { w: 3, h: 4 }, region: 'rail', interactive: true, objectives: ['trading', 'screening', 'research'], related: ['mini-chart', 'tradingview-chart'], dataSources: ['live quote'], configOptions: ['tickers', 'visibleCols'], defaultConfig: { tickers: ['SPY', 'QQQ', 'AAPL', 'MSFT'] }, description: 'Focused quote list with live marks and daily change.' }),
  'news-feed': define('news-feed', { name: 'News Feed', icon: 'N', category: 'Research', purpose: 'Track catalysts for selected names', dataType: 'Headline stream', priority: 'supporting', preferred: { w: 4, h: 6 }, minimum: { w: 3, h: 4 }, region: 'rail', objectives: ['research', 'trading', 'macro'], related: ['watchlist', 'sentiment-gauge'], dataSources: ['news providers'], configOptions: ['tickers', 'newsExpand'], defaultConfig: { tickers: ['SPY', 'AAPL', 'NVDA'], newsExpand: 'first' }, description: 'Ticker-aware news wire with deduplication and sentiment.' }),
  'pm-portfolios': define('pm-portfolios', { name: 'Portfolios', icon: 'PF', category: 'Portfolio', purpose: 'Monitor saved books and live value', dataType: 'Portfolio summary table', priority: 'secondary', preferred: { w: 5, h: 5 }, minimum: { w: 4, h: 4 }, region: 'body', objectives: ['portfolio', 'risk', 'trading'], related: ['risk-metrics', 'pnl-attribution'], dataSources: ['portfolio manager', 'live quote'], description: 'Saved books with live value and unrealized profit and loss.' }),
  'pnl-attribution': define('pnl-attribution', { name: 'P/L Attribution', icon: 'PNL', category: 'Portfolio', purpose: 'Explain portfolio profit and loss by position', dataType: 'Attribution bars', priority: 'secondary', preferred: { w: 7, h: 6 }, minimum: { w: 5, h: 5 }, region: 'body', objectives: ['portfolio', 'risk'], related: ['risk-metrics', 'factor-decomposition'], dataSources: ['portfolio manager', 'live quote'], configOptions: ['portfolioId'], description: 'Day or open profit and loss attribution using live portfolio marks.' }),
  'portfolio-summary': define('portfolio-summary', { name: 'Portfolio Summary', icon: 'P', category: 'Portfolio', purpose: 'Lead portfolio performance and benchmark context', dataType: 'Performance chart and metrics', priority: 'primary', preferred: { w: 7, h: 6 }, minimum: { w: 5, h: 5 }, region: 'center', objectives: ['portfolio', 'risk', 'research'], compatible: ['risk-metrics', 'factor-decomposition', 'pnl-attribution', 'pm-portfolios'], related: ['correlation-matrix'], dataSources: ['portfolio manager', 'market history'], configOptions: ['portfolioId', 'tickers', 'weights', 'chartMode'], defaultConfig: { tickers: ['SPY', 'QQQ', 'TLT', 'GLD'], weights: [0.4, 0.3, 0.2, 0.1], chartMode: 'cumulative' }, description: 'Active portfolio performance, alpha, Sharpe, drawdown, volatility, beta, and allocation.' }),
  'correlation-matrix': define('correlation-matrix', { name: 'Correlation Matrix', icon: 'CORR', category: 'Risk', purpose: 'Find diversification and clustering', dataType: 'Matrix', priority: 'secondary', preferred: { w: 5, h: 6 }, minimum: { w: 4, h: 5 }, region: 'body', objectives: ['risk', 'portfolio', 'research'], related: ['risk-metrics', 'factor-decomposition'], dataSources: ['market history'], configOptions: ['tickers', 'periodDays'], defaultConfig: { tickers: ['SPY', 'QQQ', 'TLT', 'GLD', 'BTC-USD'], periodDays: 252 }, description: 'Return correlation matrix for a configurable basket.' }),
  'market-hours': define('market-hours', { name: 'Market Hours', icon: 'HRS', category: 'Market context', purpose: 'Show current global session context', dataType: 'Session clock', priority: 'supporting', preferred: { w: 3, h: 5 }, minimum: { w: 3, h: 4 }, region: 'rail', objectives: ['trading', 'macro'], related: ['index-tape', 'global-macro'], dataSources: ['market session'], configOptions: ['layout'], defaultConfig: { layout: 'clock' }, description: 'Holiday-aware US session status and global market clocks.' }),
  'macro-strip': define('macro-strip', { name: 'Macro Strip', icon: 'RATE', category: 'Macro', purpose: 'Compact rates context', dataType: 'Summary metrics', priority: 'supporting', preferred: { w: 12, h: 2 }, minimum: { w: 6, h: 2 }, maximum: { w: 12, h: 2 }, region: 'top', growth: 'horizontal', multiple: false, objectives: ['macro', 'risk'], related: ['yield-curve'], dataSources: ['rates'], configOptions: ['tickers'], defaultConfig: { tickers: DEFAULT_MACRO_STRIP_SERIES }, description: 'Compact configurable rates and curve-spread strip.' }),
  'sector-rotation': define('sector-rotation', { name: 'Sector Rotation', icon: 'SR', category: 'Screening', purpose: 'Rank sector leadership', dataType: 'Ranked diverging bars', priority: 'secondary', preferred: { w: 4, h: 7 }, minimum: { w: 4, h: 5 }, maximum: { w: 6, h: 8 }, region: 'body', density: 'dense', growth: 'bounded', multiple: false, objectives: ['screening', 'macro', 'research'], related: ['heatmap', 'screener'], dataSources: ['sector ETF history'], configOptions: ['sectorPeriod'], defaultConfig: { sectorPeriod: '1M' }, description: 'GICS sector rankings by absolute return or strength versus SPY.' }),
  'sentiment-gauge': define('sentiment-gauge', { name: 'Market Sentiment', icon: 'SENT', category: 'Market context', purpose: 'Summarize market tone and direction', dataType: 'Composite metrics', priority: 'supporting', preferred: { w: 3, h: 5 }, minimum: { w: 3, h: 4 }, region: 'rail', objectives: ['trading', 'research', 'macro'], related: ['news-feed'], dataSources: ['sentiment model'], configOptions: ['timeframeHours'], defaultConfig: { timeframeHours: 4 }, description: 'Market sentiment, momentum, direction, and breaking headlines.' }),
  'price-card': define('price-card', { name: 'Price Card', icon: '$', category: 'Research', purpose: 'Detailed single-name price context', dataType: 'Price chart and metrics', priority: 'secondary', preferred: { w: 4, h: 7 }, minimum: { w: 3, h: 6 }, region: 'body', objectives: ['research', 'trading'], related: ['mini-chart', 'news-feed'], dataSources: ['market history', 'live quote'], configOptions: ['ticker', 'period'], defaultConfig: { ticker: 'SPY', period: '3mo' }, description: 'Live price, daily move, volatility, drawdown, candles, and volume.' }),
  'mini-chart': define('mini-chart', { name: 'Mini Chart', icon: 'CH', category: 'Research', purpose: 'Compact price trend support', dataType: 'Area chart', priority: 'supporting', preferred: { w: 5, h: 4 }, minimum: { w: 3, h: 3 }, region: 'rail', objectives: ['research', 'screening'], conflicts: ['price-card'], dataSources: ['market history', 'live quote'], configOptions: ['ticker', 'period'], defaultConfig: { ticker: 'SPY', period: '1y' }, description: 'Compact price trend and return chart.' }),
  'earnings-calendar': define('earnings-calendar', { name: 'Earnings Scanner', icon: 'E', category: 'Research', purpose: 'Track upcoming earnings catalysts', dataType: 'Event table', priority: 'secondary', preferred: { w: 5, h: 6 }, minimum: { w: 4, h: 5 }, region: 'body', objectives: ['research', 'screening'], related: ['watchlist', 'news-feed'], dataSources: ['Nasdaq', 'Finnhub', 'Tradier'], configOptions: ['tickers'], defaultConfig: { tickers: ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL'] }, description: 'Earnings dates, estimates, and options-implied moves.' }),
  'analyst-ratings': define('analyst-ratings', { name: 'Analyst Consensus', icon: 'AN', category: 'Research', purpose: 'Summarize analyst positioning and targets', dataType: 'Distribution and metrics', priority: 'secondary', preferred: { w: 4, h: 6 }, minimum: { w: 3, h: 5 }, region: 'body', objectives: ['research'], related: ['valuation', 'insider-activity'], dataSources: ['analyst data'], configOptions: ['ticker'], defaultConfig: { ticker: 'AAPL' }, description: 'Rating distribution, targets, and implied upside.' }),
  'valuation': define('valuation', { name: 'Valuation', icon: 'VAL', category: 'Research', purpose: 'Compare market multiples', dataType: 'Metric comparison', priority: 'secondary', preferred: { w: 5, h: 6 }, minimum: { w: 4, h: 5 }, region: 'body', objectives: ['research'], related: ['analyst-ratings', 'insider-activity'], dataSources: ['fundamentals'], configOptions: ['ticker'], defaultConfig: { ticker: 'AAPL' }, description: 'Multiples with rich or cheap context versus peers.' }),
  'insider-activity': define('insider-activity', { name: 'Insider Activity', icon: 'INS', category: 'Research', purpose: 'Track ownership and insider transactions', dataType: 'Ownership metrics and log', priority: 'supporting', preferred: { w: 3, h: 6 }, minimum: { w: 3, h: 5 }, region: 'rail', objectives: ['research'], related: ['valuation', 'analyst-ratings'], dataSources: ['corporate ownership'], configOptions: ['ticker'], defaultConfig: { ticker: 'AAPL' }, description: 'Ownership split and recent insider transactions.' }),
  'options-pricer': define('options-pricer', { name: 'Options Pricer', icon: 'BS', category: 'Options', purpose: 'Price a single option and Greeks', dataType: 'Interactive calculator', priority: 'supporting', preferred: { w: 4, h: 5 }, minimum: { w: 3, h: 5 }, region: 'rail', interactive: true, objectives: ['options'], related: ['delta-target'], conflicts: ['delta-target'], dataSources: ['Black-Scholes'], configOptions: ['ticker', 'strike', 'vol', 'expDays', 'optionType'], defaultConfig: { ticker: 'SPY', strike: 0, vol: 0, expDays: 30, optionType: 'call' }, description: 'Interactive Black-Scholes price and Greeks.' }),
  'delta-target': define('delta-target', { name: 'Delta Price Target', icon: 'DEL', category: 'Options', purpose: 'Solve strike for a target delta', dataType: 'Interactive calculator', priority: 'supporting', preferred: { w: 4, h: 5 }, minimum: { w: 3, h: 5 }, region: 'rail', interactive: true, objectives: ['options'], related: ['options-pricer'], conflicts: ['options-pricer'], dataSources: ['Black-Scholes'], configOptions: ['ticker', 'targetDelta', 'expDays', 'optionType'], defaultConfig: { ticker: 'SPY', targetDelta: 0.3, expDays: 30, optionType: 'call' }, description: 'Reverse Black-Scholes strike solver for a target delta.' }),
  'time-and-sales': define('time-and-sales', { name: 'Time and Sales', icon: 'T&S', category: 'Trading', purpose: 'Read recent intraday prints', dataType: 'High-density tape', priority: 'supporting', preferred: { w: 3, h: 8 }, minimum: { w: 3, h: 6 }, region: 'rail', objectives: ['trading'], related: ['paper-trade'], dataSources: ['intraday bars'], configOptions: ['ticker'], defaultConfig: { ticker: 'SPY' }, description: 'Recent prints with price, size, and direction.' }),
  'trade-blotter': define('trade-blotter', { name: 'Trade Blotter', icon: 'BLT', category: 'Trading', purpose: 'Review order and fill history', dataType: 'Order table', priority: 'secondary', preferred: { w: 6, h: 6 }, minimum: { w: 5, h: 5 }, region: 'bottom', objectives: ['trading', 'risk'], related: ['paper-trade'], dataSources: ['paper account'], description: 'Order and fill history with side, quantity, price, and status.' }),
  'position-sizer': define('position-sizer', { name: 'Position Sizer', icon: 'SIZ', category: 'Trading', purpose: 'Size a position from account risk', dataType: 'Interactive calculator', priority: 'supporting', preferred: { w: 4, h: 6 }, minimum: { w: 3, h: 5 }, region: 'rail', interactive: true, objectives: ['trading', 'risk'], related: ['paper-trade', 'risk-metrics'], dataSources: ['live quote'], configOptions: ['ticker', 'riskPct', 'entry', 'stop', 'accountValue'], defaultConfig: { ticker: 'SPY', riskPct: 1 }, description: 'Share sizing from account value, risk percentage, entry, and stop.' }),
  'ticker-control': define('ticker-control', { name: 'Ticker Control', icon: 'TKR', category: 'Controls', purpose: 'Retarget all ticker-aware widgets', dataType: 'Dashboard control', priority: 'supporting', preferred: { w: 3, h: 2 }, minimum: { w: 3, h: 2 }, region: 'top', interactive: true, multiple: false, description: 'Shows the dashboard-wide ticker selector in the toolbar.' }),
}

export const WIDGET_DEFAULT_SIZE = Object.fromEntries(WIDGET_TYPES.map(type => [type, WIDGET_DEFINITIONS[type].preferred])) as Record<WidgetType, { w: number; h: number }>
export const WIDGET_MIN_SIZES = Object.fromEntries(WIDGET_TYPES.map(type => [type, { minW: WIDGET_DEFINITIONS[type].minimum.w, minH: WIDGET_DEFINITIONS[type].minimum.h }])) as Record<WidgetType, { minW: number; minH: number }>
export const WIDGET_LABELS = Object.fromEntries(WIDGET_TYPES.map(type => [type, WIDGET_DEFINITIONS[type].name])) as Record<WidgetType, string>
export const WIDGET_DESCRIPTIONS = Object.fromEntries(WIDGET_TYPES.map(type => [type, WIDGET_DEFINITIONS[type].description])) as Record<WidgetType, string>
export const WIDGET_ICONS = Object.fromEntries(WIDGET_TYPES.map(type => [type, WIDGET_DEFINITIONS[type].icon])) as Record<WidgetType, string>

export function responsiveState(type: WidgetType, w: number, h: number, requested: WidgetDisplayState = 'auto'): Exclude<WidgetDisplayState, 'auto'> {
  if (requested !== 'auto') return requested
  const def = WIDGET_DEFINITIONS[type]
  if (w <= def.minimum.w && h <= def.minimum.h) return 'minimum'
  if (w < def.preferred.w || h < def.preferred.h) return 'compact'
  if (w >= Math.min(12, def.preferred.w + 2) && h >= def.preferred.h + 2) return 'full'
  return 'summary'
}

export function isWidgetType(value: unknown): value is WidgetType {
  return typeof value === 'string' && (WIDGET_TYPES as readonly string[]).includes(value)
}
