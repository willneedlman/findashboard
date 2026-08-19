import {
  CalendarRange,
  Search, Calculator, Layers, Compass, Briefcase, Terminal,
  Filter, Brain, CalendarDays, Activity,
  GitCompare, GitMerge, PieChart, Globe, Scale, Coins, Boxes, RotateCcw, Gem,
  LineChart, BarChart2, Waves, Zap, Shuffle, Percent,
  GitBranch, Landmark, Dices, Gauge, BookOpen, Bell, Workflow, Clock, ArrowLeftRight, Home,
  CandlestickChart, Megaphone, Rocket,
  Container, Fuel, MapPinned, Waypoints,
  ClipboardList,
  type LucideIcon,
} from 'lucide-react'

// Single source of truth for the 9-hub navigation taxonomy. Home cards, the hub
// landing pages, and the sidebar dropdowns all read from this list so the
// structure can never drift between surfaces.
//
// A hub is named for the subject or the question, never for the activity: the
// old "Research" hub failed that test (every tool here is research) and had
// become a drawer for four unrelated jobs.

export interface HubTool {
  title: string   // full name (sidebar rows, hub tiles)
  chip: string    // short label (home hub-card chips)
  desc: string    // one-line description (hub tiles)
  route: string   // target path (may include ?tab= for in-page tabs)
  icon: LucideIcon
  // The page reads ?ticker= and actually applies it. lib/tickerLink derives the
  // hand-off list from this flag, so a tool cannot be offered a symbol it will
  // silently drop, and the list cannot drift out of step with the hubs again.
  tickerParam?: boolean
}

export interface Hub {
  slug: string     // url segment for /hub/:slug
  label: string    // display name (cards, tabs, masthead title)
  tagline: string  // short line on the home hub card
  masthead: string // longer line on the hub landing page
  icon: LucideIcon
  tools: HubTool[]
}

export const HUBS: Hub[] = [
  {
    slug: 'markets',
    label: 'Markets',
    tagline: 'What is moving right now, and why.',
    masthead: 'Read the board, the breadth, and the rotation, then find out why a name is moving before you act on it.',
    icon: Activity,
    tools: [
      { title: 'Global Markets',    chip: 'Global Markets',   desc: 'World indices, FX, commodities, yields, and crypto on one board', route: '/global-markets', icon: Globe },
      { title: 'Market Breadth',    chip: 'Market Breadth',   desc: 'Advance/decline, new highs-lows, and how many members are above their moving averages', route: '/breadth', icon: Activity },
      { title: 'Sector Rotation',   chip: 'Sector Rotation',  desc: 'GICS sector performance heatmap over time',                  route: '/sector-rotation',    icon: PieChart },
      { title: 'Mover Radar',       chip: 'Mover Radar',      desc: 'Why a ticker is moving right now: news, filings, and social, or confirmation it is just noise', route: '/mover-radar', tickerParam: true, icon: Gauge },
      { title: 'Sentiment Tracker', chip: 'Sentiment Tracker', desc: 'AI-scored news sentiment across 7 sources',                 route: '/sentiment',          icon: Brain },
      { title: 'Earnings Scanner',  chip: 'Earnings Scanner', desc: 'One calendar: who reports when, your holdings inline, and an AI filing summary on any row', route: '/earnings', tickerParam: true, icon: CalendarDays },
      { title: 'Market Hours',      chip: 'Market Hours',     desc: 'Live global session clock across futures, US, Europe, Asia', route: '/market-hours',       icon: Clock },
      { title: 'Price Alerts',      chip: 'Price Alerts',     desc: 'Price and percent-change notifications',                     route: '/alerts',             icon: Bell },
    ],
  },
  {
    slug: 'companies',
    label: 'Companies',
    tagline: 'Find a name, then know it cold.',
    masthead: 'Screen the universe down to a shortlist, then dig into the filings, the peers, the ownership, and the fund structure behind each name.',
    icon: Search,
    tools: [
      { title: 'Stock Screener',    chip: 'Stock Screener',  desc: '25+ fundamental and technical filters across the universe', route: '/screener',           icon: Filter },
      { title: 'Company Profile',   chip: 'Company Profile', desc: 'Price history, revenue mix, ownership, and credit for one name', route: '/company-profile', tickerParam: true,  icon: Globe },
      { title: 'Peer Comparison',   chip: 'Peer Comparison', desc: 'Trading multiples versus sector peers',                    route: '/peer-comparison', tickerParam: true, icon: Scale },
      { title: 'ETF Analyzer',      chip: 'ETF Analyzer',    desc: 'Look-through holdings, overlap, and concentration',        route: '/etf-analyzer', tickerParam: true,       icon: Boxes },
      { title: 'NAV Tracker',       chip: 'NAV Tracker',     desc: 'Premium and discount on asset-backed proxies',             route: '/nav', tickerParam: true,                icon: Gem },
      { title: 'IPO Scanner',       chip: 'IPO Scanner',     desc: 'Upcoming and recent public offerings with pricing and deal size', route: '/ipo-calendar',    icon: Rocket },
      { title: 'Report Creator',    chip: 'Report Creator',  desc: 'Collect evidence manually or let AlphaTape research across its tools, then build a print-ready report', route: '/report-creator', icon: ClipboardList },
    ],
  },
  {
    slug: 'options',
    label: 'Options',
    tagline: 'Price, scan, and structure options end to end.',
    masthead: 'Price, scan, and structure options end to end, from a single contract to a full multi-leg book.',
    icon: Layers,
    tools: [
      { title: 'Options Scanner',     chip: 'Options Scanner',     desc: 'Unusual flow and the chain it sits in, on one surface', route: '/options-scanner', tickerParam: true, icon: Activity },
      { title: 'Volatility Scanner',  chip: 'Volatility Scanner',  desc: 'One IV surface across expiry and strike, with rank, term structure and skew from a single load', route: '/volatility-scanner', tickerParam: true, icon: Waves },
      { title: 'Dealer Exposure',          chip: 'Dealer Exposure',          desc: 'Gamma exposure by strike and expiry',               route: '/dealer-exposure', tickerParam: true,             icon: Zap },
      { title: 'Implied Probability', chip: 'Implied Probability', desc: 'Risk-neutral distributions from the chain',         route: '/probability', tickerParam: true,     icon: Percent },
      { title: 'Options Pricer',      chip: 'Options Pricer',      desc: 'Black-Scholes greeks and payoff diagrams',          route: '/options',         icon: LineChart },
      { title: 'Options Strategy',    chip: 'Options Strategy',    desc: 'Multi-leg P&L and risk profiles',                   route: '/strategy',        icon: Shuffle },
    ],
  },
  {
    slug: 'macro',
    label: 'Macro & Rates',
    tagline: 'Rates, growth, and credit in one read.',
    masthead: 'Rates, growth, and credit in one read, from the implied FOMC path to high-yield spreads, FX crosses, and positioning.',
    icon: Compass,
    tools: [
      { title: 'Macro Monitor',  chip: 'Macro Monitor',  desc: 'Growth, inflation, and labor-market dashboards', route: '/economy',        icon: Compass },
      { title: 'Economic Calendar', chip: 'Econ Calendar', desc: 'US, EU and Asia economic releases and central-bank decisions with consensus and the release-day market reaction', route: '/macro-events', icon: Megaphone },
      { title: 'Rate Engine',    chip: 'Rate Engine',    desc: 'Implied FOMC path and the full yield curve',     route: '/fed',            icon: GitBranch },
      { title: 'Bond Analytics', chip: 'Bond Analytics', desc: 'Yield-to-maturity, duration, and convexity',     route: '/bond',           icon: Landmark },
      { title: 'Bond Lookup',    chip: 'Bond Lookup',    desc: 'Resolve a CUSIP or issuer to bond reference data', route: '/cusip',          icon: BookOpen },
      { title: 'Credit Spreads', chip: 'Credit Spreads', desc: 'Investment-grade and high-yield spread monitor', route: '/credit-spreads', icon: Activity },
      { title: 'Credit Stress', chip: 'Credit Stress', desc: 'Financial stress, bank lending standards, delinquencies, and charge-offs from Federal Reserve sources', route: '/credit-delinquencies', icon: Percent },
      { title: 'FX Matrix', chip: 'FX Matrix',           desc: 'Spot cross-rates, forward points, cross-currency basis, and FX vol', route: '/currency', icon: ArrowLeftRight },
      { title: 'Trader Positioning', chip: 'Trader Positioning', desc: 'CFTC positioning across commodities, rates, FX, and equity-index futures', route: '/trader-positioning', icon: BarChart2 },
      { title: 'Housing Market', chip: 'Housing Market', desc: 'Home prices, mortgage rates, affordability, supply/demand, construction, and rental listings', route: '/housing', icon: Home },
    ],
  },
  {
    slug: 'charts',
    label: 'Charts & Stats',
    tagline: 'Plot it, overlay it, measure it.',
    masthead: 'Put any series the terminal knows on one timeline, overlay the assets you care about, and run the correlation, regression, and seasonality behind the picture.',
    icon: CandlestickChart,
    tools: [
      { title: 'Chart Studio',       chip: 'Chart Studio',    desc: 'Every time-series feed in the app on one candlestick chart', route: '/chart-studio', icon: CandlestickChart },
      { title: 'Asset Overlay',      chip: 'Asset Overlay',   desc: 'Overlay any set of assets on a single chart',                route: '/asset-overlay',      icon: GitCompare },
      { title: 'Correlation',        chip: 'Correlation',     desc: 'Correlation matrix, rolling drift, and beta',                route: '/correlation',        icon: Waves },
      { title: 'Regression',         chip: 'Regression',      desc: 'OLS and polynomial fits with diagnostics',                   route: '/regression',         icon: Activity },
      { title: 'Ticker Seasonality', chip: 'Seasonality',     desc: 'Month, weekday and turn-of-month patterns, each shown with its sample size', route: '/seasonality', tickerParam: true, icon: CalendarRange },
    ],
  },
  {
    slug: 'valuation',
    label: 'Valuation',
    tagline: 'Intrinsic value three ways, plus reverse-engineered expectations.',
    masthead: 'Pin down intrinsic value three ways and reverse-engineer exactly what the current price is pricing in.',
    icon: Calculator,
    tools: [
      { title: 'Master Valuation',  chip: 'Master Valuation', desc: 'One shared forecast connecting DCF, reverse expectations, multiples, dividends, and business parts', route: '/master-valuation', tickerParam: true, icon: GitMerge },
      { title: 'DCF Valuation',     chip: 'DCF',         desc: 'Adjustable growth stages and CapEx/D&A/WC glide paths',         route: '/dcf', tickerParam: true,         icon: Calculator },
      { title: 'Reverse DCF',       chip: 'Reverse DCF', desc: 'Solve for the growth the current price implies',                route: '/reverse-dcf', tickerParam: true, icon: RotateCcw },
      { title: 'Multiples',         chip: 'Multiples',   desc: 'Implied price from target P/E, EV/Sales, and more',             route: '/multiples', tickerParam: true,   icon: Scale },
      { title: 'Dividend Discount', chip: 'DDM',         desc: 'Gordon and multi-stage dividend discount models',              route: '/ddm', tickerParam: true,         icon: Coins },
      { title: 'Sum of the Parts',  chip: 'SOTP',        desc: 'Value each business segment, then sum the parts',               route: '/sotp', tickerParam: true,        icon: Boxes },
    ],
  },
  {
    slug: 'portfolio',
    label: 'Portfolio',
    tagline: 'What your book holds, and what it does next.',
    masthead: 'Track holdings and P&L, decompose the risk, compare books, and push the whole thing through history and 500 simulated paths.',
    icon: Briefcase,
    tools: [
      { title: 'Portfolio Manager',        chip: 'Portfolio Manager', desc: 'Holdings, P&L, and portfolio-level greeks, plus a live tab marked to real-time prices', route: '/portfolio-manager', icon: Briefcase },
      { title: 'Portfolio Analysis',       chip: 'Portfolio Analysis', desc: 'Sectors, alpha, beta, drawdowns, and 500-path portfolio scenarios in one view', route: '/portfolio-analysis', icon: ClipboardList },
      { title: 'Factor Decomposition',     chip: 'Factor Decomposition', desc: 'Regress your book on market, rates, credit, oil, and dollar factors', route: '/factor-decomposition', icon: Layers },
      { title: 'Portfolio Compare',        chip: 'Portfolio Compare', desc: 'Two to four books side by side',            route: '/portfolio-compare', icon: Scale },
      { title: 'Portfolio Allocator',      chip: 'Portfolio Allocator', desc: 'Deploy cash with linked sliders against a solved efficient frontier, then send it to Portfolio Manager', route: '/portfolio-allocator', icon: PieChart },
      { title: 'Portfolio Backtester',     chip: 'Portfolio Backtester', desc: 'Sharpe, Sortino, and Calmar across history', route: '/backtest',      icon: BarChart2 },
      { title: 'Monte Carlo',              chip: 'Monte Carlo',   desc: 'GBM path simulation with VaR and CVaR',         route: '/montecarlo',        icon: Dices },
      { title: 'Track Record', chip: 'Track Record', desc: 'Import a Fidelity or Robinhood export and measure the account: drawdown, Sharpe, Sortino, alpha, beta and your best trades', route: '/trade-history', icon: ClipboardList },
    ],
  },
  {
    slug: 'desk',
    label: 'Trading Desk',
    tagline: 'Run it live, or practice until it is boring.',
    masthead: 'Build and automate a strategy, trade it on paper across asset classes, and hold a two-sided book on the options and rates simulators.',
    icon: Terminal,
    tools: [
      { title: 'Paper Trading',            chip: 'Paper Trading', desc: 'Simulated live execution across asset classes', route: '/paper-trading', icon: Terminal },
      { title: 'Algo Builder',             chip: 'Algo Builder', desc: 'Compose entry/exit rules and risk, then save and run', route: '/algo-strategy', icon: Workflow },
      { title: 'Pairs Trader',             chip: 'Pairs Trader',  desc: 'Cointegration, mean-reversion half-life, and a z-score spread backtest', route: '/pairs-trader',        icon: Shuffle },
      { title: 'Options MM Simulator', chip: 'Options MM',          desc: 'Quote a chain, carry the inventory, hedge the greeks, on one screen', route: '/options-mm-2', icon: Gauge },
      { title: 'Fixed Income MM Simulator', chip: 'Fixed Income MM', desc: 'Quote the curve, carry the DV01, hedge with futures, on one screen', route: '/fixed-income-mm-2', icon: Landmark },
    ],
  },
  {
    slug: 'trade-routes',
    label: 'Trade Routes',
    tagline: 'The lanes, canals, and supply chains under the tape.',
    masthead: 'Follow physical trade in near real time: liner connectivity and container rates, canal chokepoint transits, air-freighter frequency at the global cargo hubs, tanker flows, and the supplier networks behind a ticker.',
    icon: Container,
    tools: [
      { title: 'Freight Map',      chip: 'Freight Map',  desc: 'Air hubs, chokepoints, connectivity ports, live cargo ships, and freight macro on one map', route: '/logistics-map', icon: MapPinned },
      { title: 'Trade Flows',      chip: 'Trade Flows', desc: 'Bilateral trade by commodity and country: top partners, tonnage, and world share', route: '/trade-flows',         icon: ArrowLeftRight },
      { title: 'Supply Chain Map', chip: 'Supply Chain Map', desc: 'Map a company\'s sourcing and end-market overlap across peer firms', route: '/supply-chain-peers', tickerParam: true, icon: Waypoints },
      { title: 'Energy Flows',     chip: 'Energy Flows', desc: 'Live AIS tankers, energy pipelines, export terminals, and chokepoints',                       route: '/flows-map',     icon: Fuel },
      { title: 'Chokepoint Exposure', chip: 'Exposure',  desc: 'Live chokepoint stress mapped to the tankers, oil, refiners, and shippers it moves',         route: '/chokepoint-exposure', icon: Waypoints },
    ],
  },
]

export const ALL_TOOLS: HubTool[] = HUBS.flatMap(h => h.tools)

export function hubBySlug(slug: string | undefined): Hub | undefined {
  return HUBS.find(h => h.slug === slug)
}

// Resolve the current location to the tool it represents (for recents + active
// state). Prefer an exact path+query match, then fall back to a query-less path.
export function findToolByLocation(pathname: string, search: string): HubTool | undefined {
  const full = pathname + (search || '')
  return ALL_TOOLS.find(t => t.route === full)
    ?? ALL_TOOLS.find(t => !t.route.includes('?') && t.route === pathname)
}

// Which hub does the current location belong to? Used to auto-open the sidebar
// dropdown and highlight the active hub.
export function hubForLocation(pathname: string, search: string): Hub | undefined {
  const full = pathname + (search || '')
  const exact = HUBS.find(h => h.tools.some(t => t.route === full))
  if (exact) return exact
  return HUBS.find(h => h.tools.some(t => t.route.split('?')[0] === pathname))
}
