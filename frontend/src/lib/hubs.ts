import {
  Search, Calculator, Layers, Compass, Briefcase, Terminal,
  Filter, Brain, CalendarClock, CalendarDays, FileText, Activity,
  GitCompare, PieChart, Globe, Scale, Coins, Boxes, RotateCcw, Gem,
  LineChart, BarChart2, Waves, Zap, Shuffle, Percent,
  GitBranch, Landmark, Dices, Gauge, BookOpen, Bell, Workflow, Clock, ArrowLeftRight, Home,
  CandlestickChart, Megaphone, Rocket,
  Container, Fuel, MapPinned, Waypoints,
  type LucideIcon,
} from 'lucide-react'

// Single source of truth for the 6-hub navigation taxonomy. Home cards, the hub
// landing pages, and the sidebar dropdowns all read from this list so the
// structure can never drift between surfaces.

export interface HubTool {
  title: string   // full name (sidebar rows, hub tiles)
  chip: string    // short label (home hub-card chips)
  desc: string    // one-line description (hub tiles)
  route: string   // target path (may include ?tab= for in-page tabs)
  icon: LucideIcon
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
    slug: 'research',
    label: 'Research',
    tagline: 'Screen the universe, know the company, follow the flow.',
    masthead: 'Screen for candidates, dig into companies and filings, and track the sentiment, sector moves, and statistics behind the idea.',
    icon: Search,
    tools: [
      { title: 'Stock Screener',    chip: 'Screener',        desc: '25+ fundamental and technical filters across the universe', route: '/screener',           icon: Filter },
      { title: 'Company Profile',   chip: 'Company Profile', desc: 'Price history, revenue mix, ownership, and credit for one name', route: '/company-profile',  icon: Globe },
      { title: 'Earnings AI',       chip: 'Earnings AI',     desc: 'Call transcripts and filing summaries on demand',          route: '/earnings',           icon: FileText },
      { title: 'Peer Comparison',   chip: 'Peers',           desc: 'Trading multiples versus sector peers',                    route: '/relative-valuation', icon: Scale },
      { title: 'ETF Analyzer',      chip: 'ETF Analyzer',    desc: 'Look-through holdings, overlap, and concentration',        route: '/etf-analyzer',       icon: Boxes },
      { title: 'Sentiment Tracker', chip: 'Sentiment',       desc: 'AI-scored news sentiment across 7 sources',                route: '/sentiment',          icon: Brain },
      { title: 'Portfolio Earnings', chip: 'Earnings',       desc: 'Your holdings counting down to their next report, with valuation, positioning and the wire', route: '/corporate', icon: CalendarClock },
      { title: 'Earnings Scanner', chip: 'Earnings Scan',  desc: 'Confirmed and estimated report dates with past reactions',  route: '/earnings-calendar',  icon: CalendarDays },
      { title: 'IPO Scanner',      chip: 'IPO Scanner',    desc: 'Upcoming and recent public offerings with pricing and deal size', route: '/ipo-calendar',    icon: Rocket },
      { title: 'Sector Rotation',   chip: 'Sector Rotation', desc: 'GICS sector performance heatmap over time',                route: '/sector-rotation',    icon: PieChart },
      { title: 'Regression',        chip: 'Regression',      desc: 'OLS and polynomial fits with diagnostics',                 route: '/regression',         icon: Activity },
      { title: 'Correlation',       chip: 'Correlation',     desc: 'Correlation matrix, rolling drift, and beta',              route: '/correlation',        icon: Waves },
    ],
  },
  {
    slug: 'options',
    label: 'Options',
    tagline: 'Price, scan, and structure options end to end.',
    masthead: 'Price, scan, and structure options end to end, from a single contract to a full multi-leg book.',
    icon: Layers,
    tools: [
      { title: 'Options Pricer',      chip: 'Pricer',              desc: 'Black-Scholes greeks and payoff diagrams',          route: '/options',         icon: LineChart },
      { title: 'Chain Scanner',       chip: 'Chain Scanner',       desc: 'Live option chains with IV rank and skew',          route: '/chain',           icon: BarChart2 },
      { title: 'IV Rank & Term',      chip: 'IV Rank',             desc: 'IV rank and term structure versus history',         route: '/iv-tracker',      icon: Waves },
      { title: 'Volatility Skew',     chip: 'Vol Skew',            desc: 'Put/call skew and the smile across strikes',        route: '/skew',            icon: CandlestickChart },
      { title: 'Dealer GEX',          chip: 'Dealer GEX',          desc: 'Gamma exposure by strike and expiry',               route: '/gex',             icon: Zap },
      { title: 'Options Flow',        chip: 'Flow',                desc: 'Volume and open-interest surges',                   route: '/unusual-options', icon: Activity },
      { title: 'Options Strategy Builder', chip: 'Options Strategy', desc: 'Multi-leg P&L and risk profiles',                 route: '/strategy',        icon: Shuffle },
      { title: 'Implied Probability', chip: 'Implied Probability', desc: 'Risk-neutral distributions from the chain',         route: '/probability',     icon: Percent },
    ],
  },
  {
    slug: 'macro',
    label: 'Macro',
    tagline: 'Rates, growth, credit, and markets in one read.',
    masthead: 'Rates, growth, and credit in one read, from the implied FOMC path to high-yield spreads, FX crosses, and world markets.',
    icon: Compass,
    tools: [
      { title: 'Rate Engine',    chip: 'Rate Engine',    desc: 'Implied FOMC path and the full yield curve',     route: '/fed',            icon: GitBranch },
      { title: 'Macro Monitor',  chip: 'Macro',          desc: 'Growth, inflation, and labor-market dashboards', route: '/economy',        icon: Compass },
      { title: 'Economic Calendar', chip: 'Econ Calendar', desc: 'US, EU and Asia economic releases and central-bank decisions with consensus and the release-day market reaction', route: '/macro-events', icon: Megaphone },
      { title: 'Global Markets', chip: 'Global Markets', desc: 'World indices, FX, commodities, yields, and crypto on one board', route: '/global-markets', icon: Globe },
      { title: 'Bond Analytics', chip: 'Bonds',          desc: 'Yield-to-maturity, duration, and convexity',     route: '/bond',           icon: Landmark },
      { title: 'Bond Lookup',    chip: 'Lookup',         desc: 'Resolve a CUSIP or issuer to bond reference data', route: '/cusip',          icon: BookOpen },
      { title: 'Credit Spreads', chip: 'Credit Spreads', desc: 'Investment-grade and high-yield spread monitor', route: '/credit-spreads', icon: Activity },
      { title: 'Credit Stress', chip: 'Credit Stress', desc: 'Financial stress, bank lending standards, delinquencies, and charge-offs from Federal Reserve sources', route: '/credit-delinquencies', icon: Percent },
      { title: 'Housing Market', chip: 'Housing', desc: 'Home prices, mortgage rates, affordability, supply/demand, construction, and rental listings', route: '/housing', icon: Home },
      { title: 'Currency Matrix', chip: 'FX Matrix',     desc: 'Spot cross-rates, forward points, cross-currency basis, and FX vol', route: '/currency', icon: ArrowLeftRight },
      { title: 'Market Hours',   chip: 'Market Hours',   desc: 'Live global session clock across futures, US, Europe, Asia', route: '/market-hours',   icon: Clock },
      { title: 'Trader Positioning', chip: 'Positioning', desc: 'CFTC positioning across commodities, rates, FX, and equity-index futures', route: '/trader-positioning', icon: BarChart2 },
    ],
  },
  {
    slug: 'charting',
    label: 'Charting',
    tagline: 'Every feed in the terminal on one chart.',
    masthead: 'Candles, overlays, and cross-asset comparisons. Plot any series the terminal knows on one timeline.',
    icon: CandlestickChart,
    tools: [
      { title: 'Chart Studio',    chip: 'Chart Studio',    desc: 'Every time-series feed in the app on one candlestick chart', route: '/chart-studio', icon: CandlestickChart },
      { title: 'Asset Overlay',   chip: 'Asset Overlay',   desc: 'Overlay any set of assets on a single chart',                route: '/compare',      icon: GitCompare },
      { title: 'Compare Portfolios', chip: 'Compare',      desc: 'Two to four books side by side',                             route: '/portfolio-compare', icon: Scale },
    ],
  },
  {
    slug: 'trading',
    label: 'Trading',
    tagline: 'Build, test, execute, and track your book.',
    masthead: 'Compose a strategy, test it against history, run it on the simulated desk, and track every trade and holding.',
    icon: Terminal,
    tools: [
      { title: 'Paper Trading',            chip: 'Paper Trading', desc: 'Simulated live execution across asset classes', route: '/paper-trading', icon: Terminal },
      { title: 'Algorithmic Strategy Builder', chip: 'Algo Builder', desc: 'Compose entry/exit rules and risk, then save and run', route: '/algo-strategy', icon: Workflow },
      { title: 'Backtester',               chip: 'Backtester',    desc: 'Sharpe, Sortino, and Calmar across history',    route: '/backtest',          icon: BarChart2 },
      { title: 'Monte Carlo',              chip: 'Monte Carlo',   desc: 'GBM path simulation with VaR and CVaR',         route: '/montecarlo',        icon: Dices },
      { title: 'Portfolio Optimizer',      chip: 'Optimizer',     desc: 'Efficient frontier, max-Sharpe, risk parity, and per-holding risk', route: '/portfolio-optimizer', icon: PieChart },
      { title: 'Factor Decomposition',     chip: 'Factors',       desc: 'Regress your book on market, rates, credit, oil, and dollar factors', route: '/factor-decomposition', icon: Layers },
      { title: 'Pairs Trader',             chip: 'Pairs',         desc: 'Cointegration, mean-reversion half-life, and a z-score spread backtest', route: '/pairs-trader',        icon: Shuffle },
      { title: 'Market Maker Simulator',   chip: 'Market Maker',  desc: 'Quote two-sided markets and hedge — options and Treasury desks', route: '/market-maker', icon: Gauge },
      { title: 'Portfolio Manager',        chip: 'Manager',       desc: 'Holdings, P&L, and portfolio-level greeks',     route: '/portfolio-manager', icon: Briefcase },
      { title: 'Trade Journal',            chip: 'Trade Journal', desc: 'Entry/exit, P&L, and win-rate analytics',       route: '/trade-journal',     icon: BookOpen },
      { title: 'Price Alerts',             chip: 'Price Alerts',  desc: 'Price and percent-change notifications',        route: '/alerts',            icon: Bell },
    ],
  },
  {
    slug: 'valuation',
    label: 'Valuation',
    tagline: 'Intrinsic value three ways, plus reverse-engineered expectations.',
    masthead: 'Pin down intrinsic value three ways and reverse-engineer exactly what the current price is pricing in.',
    icon: Calculator,
    tools: [
      { title: 'DCF Valuation',     chip: 'DCF',         desc: 'Ten-year DCF with margin and growth glide paths',              route: '/dcf',         icon: Calculator },
      { title: 'Dividend Discount', chip: 'DDM',         desc: 'Gordon and multi-stage dividend discount models',              route: '/ddm',         icon: Coins },
      { title: 'Sum of the Parts',  chip: 'SOTP',        desc: 'Value each business segment, then sum the parts',              route: '/sotp',        icon: Boxes },
      { title: 'Multiples',         chip: 'Multiples',   desc: 'Implied price from target P/E, EV/Sales, and more',            route: '/multiples',   icon: Scale },
      { title: 'Reverse DCF',       chip: 'Reverse DCF', desc: 'Solve for the growth the current price implies',               route: '/reverse-dcf', icon: RotateCcw },
      { title: 'NAV Tracker',       chip: 'NAV Tracker', desc: 'Premium and discount on asset-backed proxies',                 route: '/nav',         icon: Gem },
    ],
  },
  {
    slug: 'logistics',
    label: 'Geo-Logistics',
    tagline: 'Track the physical economy — ships, freighters, and freight tonnage.',
    masthead: 'Follow physical trade in near real time: liner connectivity and container rates, canal chokepoint transits, air-freighter frequency at the global cargo hubs, and US inventories and freight tonnage.',
    icon: Container,
    tools: [
      { title: 'Freight Map',      chip: 'Logistics',    desc: 'Air hubs, chokepoints, connectivity ports, live cargo ships, and freight macro on one map', route: '/logistics-map', icon: MapPinned },
      { title: 'Supply Chain Map', chip: 'Supply Map',   desc: 'Map a company\'s sourcing and end-market overlap across peer firms', route: '/supply-chain-peers', icon: Waypoints },
      { title: 'Energy Flows Map', chip: 'Energy Flows', desc: 'Live AIS tankers, energy pipelines, export terminals, and chokepoints',                       route: '/flows-map',     icon: Fuel },
      { title: 'Chokepoint Exposure', chip: 'Exposure',  desc: 'Live chokepoint stress mapped to the tankers, oil, refiners, and shippers it moves',         route: '/chokepoint-exposure', icon: Waypoints },
      { title: 'Trade Flows',      chip: 'Trade Flows', desc: 'Bilateral trade by commodity and country: top partners, tonnage, and world share', route: '/trade-flows',         icon: ArrowLeftRight },
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
