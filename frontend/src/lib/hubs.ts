import {
  Search, Calculator, Layers, Compass, Briefcase, Terminal,
  Filter, Brain, CalendarClock, FileText, Activity,
  GitCompare, PieChart, Globe, Scale, Coins, Boxes, RotateCcw, Gem,
  LineChart, BarChart2, Waves, Zap, Shuffle, Percent,
  GitBranch, Landmark, Dices, Gauge, BookOpen, Bell, Workflow, Clock, ArrowLeftRight,
  Ship, CandlestickChart,
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
      { title: 'Company Profile',   chip: 'Company Profile', desc: 'Price history, revenue mix, ownership, and credit for one name', route: '/supply-chain',  icon: Globe },
      { title: 'Earnings AI',       chip: 'Earnings AI',     desc: 'Call transcripts and filing summaries on demand',          route: '/earnings',           icon: FileText },
      { title: 'Peer Comparison',   chip: 'Peers',           desc: 'Trading multiples versus sector peers',                    route: '/relative-valuation', icon: Scale },
      { title: 'ETF Analyzer',      chip: 'ETF Analyzer',    desc: 'Look-through holdings, overlap, and concentration',        route: '/etf-analyzer',       icon: Boxes },
      { title: 'Sentiment Tracker', chip: 'Sentiment',       desc: 'AI-scored news sentiment across 7 sources',                route: '/sentiment',          icon: Brain },
      { title: 'Market Calendar',   chip: 'Calendar',        desc: 'Corporate catalysts and the earnings calendar in one view', route: '/corporate',         icon: CalendarClock },
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
      { title: 'Implied Volatility',  chip: 'Implied Vol',         desc: 'IV rank, term structure, and volatility skew',      route: '/iv-tracker',      icon: Waves },
      { title: 'Dealer GEX',          chip: 'Dealer GEX',          desc: 'Gamma exposure by strike and expiry',               route: '/gex',             icon: Zap },
      { title: 'Options Flow',        chip: 'Flow',                desc: 'Volume and open-interest surges',                   route: '/unusual-options', icon: Activity },
      { title: 'Options Strategy Builder', chip: 'Options Strategy', desc: 'Multi-leg P&L and risk profiles',                 route: '/strategy',        icon: Shuffle },
      { title: 'Implied Probability', chip: 'Implied Probability', desc: 'Risk-neutral distributions from the chain',         route: '/probability',     icon: Percent },
    ],
  },
  {
    slug: 'macro',
    label: 'Macro',
    tagline: 'Rates, growth, credit, and flows in one read.',
    masthead: 'Rates, growth, and credit in one read, from the implied FOMC path to high-yield spreads and physical energy flows.',
    icon: Compass,
    tools: [
      { title: 'Rate Engine',    chip: 'Rate Engine',    desc: 'Implied FOMC path and the full yield curve',     route: '/fed',            icon: GitBranch },
      { title: 'Macro Monitor',  chip: 'Macro',          desc: 'Growth, inflation, and labor-market dashboards', route: '/economy',        icon: Compass },
      { title: 'Global Markets', chip: 'Global Markets', desc: 'World indices, FX, commodities, yields, and crypto on one board', route: '/global-markets', icon: Globe },
      { title: 'Bond Analytics', chip: 'Bonds',          desc: 'Yield-to-maturity, duration, and convexity',     route: '/bond',           icon: Landmark },
      { title: 'Bond Lookup',    chip: 'Lookup',         desc: 'Resolve a CUSIP or issuer to bond reference data', route: '/cusip',          icon: BookOpen },
      { title: 'Credit Spreads', chip: 'Credit Spreads', desc: 'Investment-grade and high-yield spread monitor', route: '/credit-spreads', icon: Activity },
      { title: 'Currency Matrix', chip: 'FX Matrix',     desc: 'Spot cross-rates, forward points, cross-currency basis, and FX vol', route: '/currency', icon: ArrowLeftRight },
      { title: 'Global Energy Flows', chip: 'Energy Flows', desc: 'Live AIS vessels, energy pipelines, export terminals, and chokepoints', route: '/flows-map', icon: Ship },
      { title: 'Market Hours',   chip: 'Market Hours',   desc: 'Live global session clock across futures, US, Europe, Asia', route: '/market-hours',   icon: Clock },
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
      { title: 'Market Maker Simulator',   chip: 'Market Maker',  desc: 'Quote two-sided markets and hedge — options and Treasury desks', route: '/market-maker', icon: Gauge },
      { title: 'Portfolio Manager',        chip: 'Manager',       desc: 'Holdings, P&L, and portfolio-level greeks',     route: '/portfolio-manager', icon: Briefcase },
      { title: 'Compare Portfolios',       chip: 'Compare',       desc: 'Two to four books side by side',                route: '/portfolio-compare', icon: Scale },
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
