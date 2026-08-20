import {
  Activity, ArrowLeftRight, BarChart2, Bell, BookOpen, Boxes,
  Brain, Briefcase, Calculator, CalendarDays, CalendarRange, CandlestickChart,
  ClipboardList, Clock, Coins, Compass, Dices, Filter,
  Fuel, Gauge, Gem, GitBranch, GitCompare, GitMerge,
  Globe, Home, Landmark, Layers, LineChart, MapPinned,
  Megaphone, Percent, PieChart, Rocket, RotateCcw, Scale,
  Search, Shuffle, Terminal, Waves, Waypoints, Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react'

// Single source of truth for every tool in the application.
//
// This replaced a seven-hub tree. The tree failed because it sorted on three
// axes at once (asset class, activity, data domain) and because it forced one
// parent per tool: 30 of these 60 do more than one job, so wherever each was
// filed it was hidden from everyone approaching down the other path. Earnings
// Scanner screens a calendar and tracks your holdings. Monte Carlo projects a
// book and prices a spread. Tags let a tool appear in every place it belongs.
//
// Jobs are the browse axis and answer "what am I trying to do". Assets are a
// secondary filter and answer "in which market". A tool carries one to three
// jobs. Adding or re-filing one is a one-line edit with no route to migrate.

export type Job = 'find' | 'study' | 'value' | 'options' | 'macro' | 'rates' | 'chart' | 'stats' | 'book' | 'strategy' | 'practice' | 'flows' | 'utility'

export type Asset = 'equity' | 'option' | 'rate' | 'credit' | 'fx' | 'commodity' | 'shipping' | 'fund' | 'crypto'

export interface Tool {
  title: string   // full name (sidebar rows, index rows)
  chip: string    // short label (compact surfaces)
  desc: string    // one line on what it does
  route: string   // target path (may include ?tab= for in-page tabs)
  icon: LucideIcon
  jobs: Job[]     // what it is for. First entry is its primary job.
  assets: Asset[] // which markets it covers. Empty for the economy at large.
  // The page reads ?ticker= and actually applies it. lib/tickerLink derives the
  // hand-off list from this flag, so a tool cannot be offered a symbol it will
  // silently drop.
  tickerParam?: boolean
}

export const JOBS: { id: Job; label: string; blurb: string; icon: LucideIcon }[] = [
  { id: 'find', label: 'Find something', blurb: 'Surface names and contracts you did not already have.', icon: Search },
  { id: 'study', label: 'Study a name', blurb: 'Understand one company, fund or contract in depth.', icon: Compass },
  { id: 'value', label: 'Value it', blurb: 'Work out what something is worth.', icon: Calculator },
  { id: 'options', label: 'Options and vol', blurb: 'Chains, greeks, surfaces and dealer positioning.', icon: Layers },
  { id: 'macro', label: 'Macro', blurb: 'The economy, the cycle, and where the market sits in it.', icon: Globe },
  { id: 'rates', label: 'Rates and credit', blurb: 'The curve, the Fed, spreads and stress.', icon: Landmark },
  { id: 'chart', label: 'Charts', blurb: 'Plot and compare series on one canvas.', icon: CandlestickChart },
  { id: 'stats', label: 'Statistics', blurb: 'Relationships between series: correlation, regression, factors.', icon: GitCompare },
  { id: 'book', label: 'Your book', blurb: 'Hold, measure and stress the portfolio you own.', icon: Briefcase },
  { id: 'strategy', label: 'Strategy', blurb: 'Design a trade, test it against history, and put it on.', icon: Workflow },
  { id: 'practice', label: 'Practice', blurb: 'Simulators with nothing real at stake.', icon: Dices },
  { id: 'flows', label: 'Trade and shipping', blurb: 'Physical goods, energy, and the routes they move on.', icon: Waypoints },
  { id: 'utility', label: 'Utilities', blurb: 'Cross-cutting tools that serve every other one.', icon: Boxes },
]

export const ASSETS: { id: Asset; label: string }[] = [
  { id: 'equity', label: 'Equities' },
  { id: 'option', label: 'Options' },
  { id: 'rate', label: 'Rates' },
  { id: 'credit', label: 'Credit' },
  { id: 'fx', label: 'FX' },
  { id: 'commodity', label: 'Commodities' },
  { id: 'shipping', label: 'Shipping' },
  { id: 'fund', label: 'Funds' },
  { id: 'crypto', label: 'Crypto' },
]

export const TOOLS: Tool[] = [
  { title: 'Stock Screener', chip: 'Stock Screener', desc: '25+ fundamental and technical filters across the universe',
    route: '/screener', icon: Filter, jobs: ['find'], assets: ['equity'] },
  { title: 'IPO Scanner', chip: 'IPO Scanner', desc: 'Upcoming and recent public offerings with pricing and deal size',
    route: '/ipo-calendar', icon: Rocket, jobs: ['find'], assets: ['equity'] },
  { title: 'Mover Radar', chip: 'Mover Radar', desc: 'Why a ticker is moving right now: news, filings, and social, or confirmation it is just noise',
    route: '/mover-radar', icon: Gauge, jobs: ['study'], assets: ['equity'], tickerParam: true },
  { title: 'Company Profile', chip: 'Company Profile', desc: 'Price history, revenue mix, ownership, and credit for one name',
    route: '/company-profile', icon: Globe, jobs: ['study'], assets: ['equity'], tickerParam: true },
  { title: 'Peer Comparison', chip: 'Peer Comparison', desc: 'Trading multiples versus sector peers',
    route: '/relative-valuation', icon: Scale, jobs: ['study', 'find'], assets: ['equity'], tickerParam: true },
  { title: 'Earnings Scanner', chip: 'Earnings Scanner', desc: 'One calendar: who reports when, your holdings inline, and an AI filing summary on any row',
    route: '/earnings', icon: CalendarDays, jobs: ['find', 'book'], assets: ['equity'], tickerParam: true },
  { title: 'Sentiment Tracker', chip: 'Sentiment Tracker', desc: 'AI-scored news sentiment across 7 sources',
    route: '/sentiment', icon: Brain, jobs: ['find', 'macro'], assets: ['equity'] },
  { title: 'ETF Analyzer', chip: 'ETF Analyzer', desc: 'Look-through holdings, overlap, and concentration',
    route: '/etf-analyzer', icon: Boxes, jobs: ['study', 'book'], assets: ['fund', 'equity'], tickerParam: true },
  { title: 'NAV Tracker', chip: 'NAV Tracker', desc: 'Premium and discount on asset-backed proxies',
    route: '/nav', icon: Gem, jobs: ['value', 'study'], assets: ['equity', 'fund'], tickerParam: true },
  { title: 'Report Creator', chip: 'Report Creator', desc: 'Collect evidence manually or let AlphaTape research across its tools, then build a print-ready report',
    route: '/report-creator', icon: ClipboardList, jobs: ['utility'], assets: [] },
  { title: 'Options Scanner', chip: 'Options Scanner', desc: 'Unusual flow and the chain it sits in, on one surface',
    route: '/options-scanner', icon: Activity, jobs: ['find', 'options'], assets: ['option'], tickerParam: true },
  { title: 'Volatility Scanner', chip: 'Volatility Scanner', desc: 'One IV surface across expiry and strike, with rank, term structure and skew from a single load',
    route: '/volatility-scanner', icon: Waves, jobs: ['study', 'options'], assets: ['option'], tickerParam: true },
  { title: 'Dealer Exposure', chip: 'Dealer Exposure', desc: 'Gamma exposure by strike and expiry',
    route: '/gex', icon: Zap, jobs: ['study', 'options'], assets: ['option'], tickerParam: true },
  { title: 'Implied Probability', chip: 'Implied Probability', desc: 'Risk-neutral distributions from the chain',
    route: '/probability', icon: Percent, jobs: ['options', 'stats'], assets: ['option'], tickerParam: true },
  { title: 'Options Pricer', chip: 'Options Pricer', desc: 'Black-Scholes greeks and payoff diagrams',
    route: '/options', icon: LineChart, jobs: ['options', 'strategy'], assets: ['option'] },
  { title: 'Options Strategy', chip: 'Options Strategy', desc: 'Multi-leg P&L and risk profiles',
    route: '/strategy', icon: Shuffle, jobs: ['options', 'strategy'], assets: ['option'] },
  { title: 'Macro Monitor', chip: 'Macro Monitor', desc: 'Growth, inflation, and labor-market dashboards',
    route: '/economy', icon: Compass, jobs: ['macro'], assets: [] },
  { title: 'Economic Calendar', chip: 'Econ Calendar', desc: 'US, EU and Asia economic releases and central-bank decisions with consensus and the release-day market reaction',
    route: '/macro-events', icon: Megaphone, jobs: ['macro'], assets: [] },
  { title: 'Rate Engine', chip: 'Rate Engine', desc: 'Implied FOMC path and the full yield curve',
    route: '/fed', icon: GitBranch, jobs: ['rates'], assets: ['rate'] },
  { title: 'Bond Analytics', chip: 'Bond Analytics', desc: 'Yield-to-maturity, duration, and convexity',
    route: '/bond', icon: Landmark, jobs: ['value', 'rates'], assets: ['rate'] },
  { title: 'Bond Lookup', chip: 'Bond Lookup', desc: 'Resolve a CUSIP or issuer to bond reference data',
    route: '/cusip', icon: BookOpen, jobs: ['rates', 'utility'], assets: ['rate', 'credit'] },
  { title: 'Credit Spreads', chip: 'Credit Spreads', desc: 'Investment-grade and high-yield spread monitor',
    route: '/credit-spreads', icon: Activity, jobs: ['rates'], assets: ['credit'] },
  { title: 'Credit Stress', chip: 'Credit Stress', desc: 'Financial stress, bank lending standards, delinquencies, and charge-offs from Federal Reserve sources',
    route: '/credit-delinquencies', icon: Percent, jobs: ['rates'], assets: ['credit'] },
  { title: 'FX Matrix', chip: 'FX Matrix', desc: 'Spot cross-rates, forward points, cross-currency basis, and FX vol',
    route: '/currency', icon: ArrowLeftRight, jobs: ['macro', 'chart'], assets: ['fx'] },
  { title: 'Trader Positioning', chip: 'Trader Positioning', desc: 'CFTC positioning across commodities, rates, FX, and equity-index futures',
    route: '/trader-positioning', icon: BarChart2, jobs: ['macro', 'find'], assets: ['commodity', 'rate', 'fx', 'equity'] },
  { title: 'Housing Market', chip: 'Housing Market', desc: 'Home prices, mortgage rates, affordability, supply/demand, construction, and rental listings',
    route: '/housing', icon: Home, jobs: ['macro'], assets: [] },
  { title: 'Global Markets', chip: 'Global Markets', desc: 'World indices, FX, commodities, yields, and crypto on one board',
    route: '/global-markets', icon: Globe, jobs: ['chart', 'macro'], assets: ['equity', 'fx', 'commodity', 'rate', 'crypto'] },
  { title: 'Market Hours', chip: 'Market Hours', desc: 'Live global session clock across futures, US, Europe, Asia',
    route: '/market-hours', icon: Clock, jobs: ['utility'], assets: [] },
  { title: 'Market Breadth', chip: 'Market Breadth', desc: 'Advance/decline, new highs-lows, and how many members are above their moving averages',
    route: '/breadth', icon: Activity, jobs: ['find', 'macro'], assets: ['equity'] },
  { title: 'Seasonality', chip: 'Seasonality', desc: 'Month, weekday and turn-of-month patterns, each shown with its sample size',
    route: '/seasonality', icon: CalendarRange, jobs: ['study', 'stats'], assets: ['equity'], tickerParam: true },
  { title: 'Sector Rotation', chip: 'Sector Rotation', desc: 'GICS sector performance heatmap over time',
    route: '/sector-rotation', icon: PieChart, jobs: ['find', 'macro'], assets: ['equity'] },
  { title: 'Chart Studio', chip: 'Chart Studio', desc: 'Every time-series feed in the app on one candlestick chart',
    route: '/chart-studio', icon: CandlestickChart, jobs: ['chart'], assets: ['equity', 'option', 'fx', 'commodity', 'rate'] },
  { title: 'Asset Overlay', chip: 'Asset Overlay', desc: 'Overlay any set of assets on a single chart',
    route: '/asset-overlay', icon: GitCompare, jobs: ['chart'], assets: ['equity', 'fund', 'commodity', 'fx'] },
  { title: 'Correlation', chip: 'Correlation', desc: 'Correlation matrix, rolling drift, and beta',
    route: '/correlation', icon: Waves, jobs: ['stats', 'strategy'], assets: ['equity'] },
  { title: 'Regression', chip: 'Regression', desc: 'OLS and polynomial fits with diagnostics',
    route: '/regression', icon: Activity, jobs: ['stats', 'strategy'], assets: ['equity'] },
  { title: 'Portfolio Manager', chip: 'Portfolio Manager', desc: 'Holdings, P&L, and portfolio-level greeks, plus a live tab marked to real-time prices',
    route: '/portfolio-manager', icon: Briefcase, jobs: ['book'], assets: ['equity', 'option'] },
  { title: 'Portfolio Analysis', chip: 'Portfolio Analysis', desc: 'Sectors, alpha, beta, drawdowns, and 500-path portfolio scenarios in one view',
    route: '/portfolio-analysis', icon: ClipboardList, jobs: ['book'], assets: ['equity'] },
  { title: 'Factor Decomposition', chip: 'Factor Decomposition', desc: 'Regress your book on market, rates, credit, oil, and dollar factors',
    route: '/factor-decomposition', icon: Layers, jobs: ['book', 'stats'], assets: ['equity'] },
  { title: 'Portfolio Compare', chip: 'Portfolio Compare', desc: 'Two to four books side by side',
    route: '/portfolio-compare', icon: Scale, jobs: ['book'], assets: ['equity'] },
  { title: 'Portfolio Allocator', chip: 'Portfolio Allocator', desc: 'Deploy cash with linked sliders against a solved efficient frontier, then send it to Portfolio Manager',
    route: '/portfolio-allocator', icon: PieChart, jobs: ['book', 'strategy'], assets: ['equity'] },
  { title: 'Portfolio Backtester', chip: 'Portfolio Backtester', desc: 'Sharpe, Sortino, and Calmar across history',
    route: '/backtest', icon: BarChart2, jobs: ['book', 'strategy'], assets: ['equity'] },
  { title: 'Monte Carlo', chip: 'Monte Carlo', desc: 'GBM path simulation with VaR and CVaR',
    route: '/montecarlo', icon: Dices, jobs: ['strategy', 'book', 'options'], assets: ['equity', 'option'] },
  { title: 'Algo Builder', chip: 'Algo Builder', desc: 'Compose entry/exit rules and risk, then save and run',
    route: '/algo-strategy', icon: Workflow, jobs: ['strategy'], assets: ['equity'] },
  { title: 'Pairs Trader', chip: 'Pairs Trader', desc: 'Cointegration, mean-reversion half-life, and a z-score spread backtest',
    route: '/pairs-trader', icon: Shuffle, jobs: ['strategy', 'stats'], assets: ['equity'] },
  { title: 'Paper Trading', chip: 'Paper Trading', desc: 'Simulated live execution across asset classes',
    route: '/paper-trading', icon: Terminal, jobs: ['practice', 'strategy'], assets: ['equity', 'option'] },
  { title: 'Options MM Simulator', chip: 'Options MM', desc: 'Quote a chain, carry the inventory, hedge the greeks, on one screen',
    route: '/options-mm-2', icon: Gauge, jobs: ['practice'], assets: ['option'] },
  { title: 'Fixed Income MM Simulator', chip: 'Fixed Income MM', desc: 'Quote the curve, carry the DV01, hedge with futures, on one screen',
    route: '/fixed-income-mm-2', icon: Landmark, jobs: ['practice'], assets: ['rate'] },
  { title: 'Trade Analyzer', chip: 'Trade Analyzer', desc: 'Import a Fidelity or Robinhood export and measure the account: drawdown, Sharpe, Sortino, alpha, beta and your best trades',
    route: '/trade-history', icon: ClipboardList, jobs: ['book'], assets: ['equity', 'option'] },
  { title: 'Price Alerts', chip: 'Price Alerts', desc: 'Price and percent-change notifications',
    route: '/alerts', icon: Bell, jobs: ['utility', 'book'], assets: ['equity', 'option'] },
  { title: 'Master Valuation', chip: 'Master Valuation', desc: 'One shared forecast connecting DCF, reverse expectations, multiples, dividends, and business parts',
    route: '/master-valuation', icon: GitMerge, jobs: ['value'], assets: ['equity'], tickerParam: true },
  { title: 'DCF Valuation', chip: 'DCF', desc: 'Adjustable growth stages and CapEx/D&A/WC glide paths',
    route: '/dcf', icon: Calculator, jobs: ['value'], assets: ['equity'], tickerParam: true },
  { title: 'Reverse DCF', chip: 'Reverse DCF', desc: 'Solve for the growth the current price implies',
    route: '/reverse-dcf', icon: RotateCcw, jobs: ['value'], assets: ['equity'], tickerParam: true },
  { title: 'Multiples', chip: 'Multiples', desc: 'Implied price from target P/E, EV/Sales, and more',
    route: '/multiples', icon: Scale, jobs: ['value'], assets: ['equity'], tickerParam: true },
  { title: 'Dividend Discount', chip: 'DDM', desc: 'Gordon and multi-stage dividend discount models',
    route: '/ddm', icon: Coins, jobs: ['value'], assets: ['equity'], tickerParam: true },
  { title: 'Sum of the Parts', chip: 'SOTP', desc: 'Value each business segment, then sum the parts',
    route: '/sotp', icon: Boxes, jobs: ['value'], assets: ['equity'], tickerParam: true },
  { title: 'Freight Map', chip: 'Freight Map', desc: 'Air hubs, chokepoints, connectivity ports, live cargo ships, and freight macro on one map',
    route: '/logistics-map', icon: MapPinned, jobs: ['flows'], assets: ['shipping'] },
  { title: 'Trade Flows', chip: 'Trade Flows', desc: 'Bilateral trade by commodity and country: top partners, tonnage, and world share',
    route: '/trade-flows', icon: ArrowLeftRight, jobs: ['flows'], assets: ['shipping'] },
  { title: 'Supply Chain Map', chip: 'Supply Chain Map', desc: 'Map a company\'s sourcing and end-market overlap across peer firms',
    route: '/supply-chain-peers', icon: Waypoints, jobs: ['flows', 'study'], assets: ['equity', 'shipping'], tickerParam: true },
  { title: 'Energy Flows', chip: 'Energy Flows', desc: 'Live AIS tankers, energy pipelines, export terminals, and chokepoints',
    route: '/flows-map', icon: Fuel, jobs: ['flows'], assets: ['shipping', 'commodity'] },
  { title: 'Chokepoint Exposure', chip: 'Exposure', desc: 'Live chokepoint stress mapped to the tankers, oil, refiners, and shippers it moves',
    route: '/chokepoint-exposure', icon: Waypoints, jobs: ['flows', 'find'], assets: ['shipping', 'commodity', 'equity'] },
]

// Alphabetical is the only defensible default order for a flat list: any other
// sort encodes an opinion the filters are there to express.
export const ALL_TOOLS: Tool[] = [...TOOLS].sort((a, b) => a.title.localeCompare(b.title))

export function toolsForJob(job: Job): Tool[] {
  return ALL_TOOLS.filter(t => t.jobs.includes(job))
}

export function jobById(id: string | undefined) {
  return JOBS.find(j => j.id === id)
}

// Resolve the current location to the tool it represents (for recents + active
// state). Prefer an exact path+query match, then fall back to a query-less path.
export function findToolByLocation(pathname: string, search: string): Tool | undefined {
  const full = pathname + (search || '')
  return TOOLS.find(t => t.route === full)
    ?? TOOLS.find(t => !t.route.includes('?') && t.route === pathname)
}
