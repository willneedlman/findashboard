// Natural-language routing for the global search.
//
// Deterministic on purpose: no model call, no network, no ranking that changes
// between sessions. A query is scored against a phrase table, and the winner is
// a route the user can be sent to directly — with the ticker already applied
// where the destination reads one.
//
// The phrase table is the whole design. It maps how people ASK for something
// ("what is it worth", "why is it dropping") onto the tool that answers it,
// which tool titles alone do not do: nobody types "Reverse DCF" when what they
// want is "what growth is priced in".

import { ALL_TOOLS } from './hubs'

export interface Intent {
  route: string
  /** Every phrase that should route here. Multi-word phrases score higher. */
  phrases: string[]
  /** The destination reads ?ticker=, so a symbol in the query is carried over. */
  ticker?: boolean
}

export const INTENTS: Intent[] = [
  // Options
  { route: '/volatility-scanner', ticker: true, phrases: ['implied volatility', 'implied vol', 'iv rank', 'vol surface', 'volatility surface', 'skew', 'term structure', 'how expensive are options'] },
  { route: '/dealer-exposure', ticker: true, phrases: ['gamma exposure', 'dealer gamma', 'gex', 'gamma flip', 'dealer positioning'] },
  { route: '/options-scanner', ticker: true, phrases: ['unusual options', 'options flow', 'unusual flow', 'big options trades', 'sweeps'] },
  { route: '/probability', ticker: true, phrases: ['probability', 'odds of', 'chance of', 'implied distribution', 'risk neutral'] },
  { route: '/options', ticker: true, phrases: ['black scholes', 'option price', 'price an option', 'greeks', 'theta', 'vega'] },
  { route: '/strategy', phrases: ['iron condor', 'multi leg', 'option spread', 'payoff diagram', 'straddle', 'strangle'] },
  // Finding and understanding a name
  { route: '/screener', phrases: ['screen', 'screener', 'find stocks', 'filter stocks', 'stocks with', 'cheap stocks', 'market cap over', 'large cap'] },
  { route: '/mover-radar', ticker: true, phrases: ['why is', 'why did', 'what happened to', 'what is moving', 'why moving', 'why down', 'why up'] },
  { route: '/sentiment', phrases: ['sentiment', 'news tone', 'bullish or bearish', 'how is the news'] },
  { route: '/earnings', ticker: true, phrases: ['earnings date', 'who reports', 'earnings calendar', 'when does', 'report earnings'] },
  { route: '/company-profile', ticker: true, phrases: ['company profile', 'revenue mix', 'ownership', 'what does the company do', 'business overview'] },
  { route: '/peer-comparison', ticker: true, phrases: ['peers', 'comparable companies', 'versus peers', 'compared to peers'] },
  { route: '/etf-analyzer', ticker: true, phrases: ['etf holdings', 'look through', 'what is in the etf', 'overlap', 'fund holdings'] },
  { route: '/ipo-calendar', phrases: ['ipo', 'new listings', 'going public'] },
  // Valuation
  { route: '/master-valuation', ticker: true, phrases: ['what is it worth', 'fair value', 'intrinsic value', 'valuation'] },
  { route: '/dcf', ticker: true, phrases: ['dcf', 'discounted cash flow'] },
  { route: '/reverse-dcf', ticker: true, phrases: ['reverse dcf', 'implied growth', 'priced in', 'what is priced in'] },
  { route: '/multiples', ticker: true, phrases: ['multiples', 'target pe', 'implied price from'] },
  { route: '/ddm', ticker: true, phrases: ['dividend discount', 'gordon growth'] },
  { route: '/sotp', ticker: true, phrases: ['sum of the parts', 'sotp', 'segment value'] },
  // Macro and rates
  { route: '/fed', phrases: ['fed', 'fomc', 'rate path', 'rate cuts', 'rate hikes', 'yield curve', 'fed funds'] },
  { route: '/bond', phrases: ['duration', 'convexity', 'yield to maturity', 'bond math'] },
  { route: '/credit-spreads', phrases: ['credit spread', 'high yield spread', 'investment grade spread', 'oas'] },
  { route: '/credit-delinquencies', phrases: ['delinquencies', 'charge offs', 'lending standards', 'financial stress'] },
  { route: '/currency', phrases: ['fx', 'exchange rate', 'currency', 'dollar strength', 'cross rates'] },
  { route: '/economy', phrases: ['inflation', 'cpi', 'unemployment', 'gdp', 'macro data', 'labor market'] },
  { route: '/macro-events', phrases: ['economic calendar', 'data release', 'when is cpi', 'upcoming releases'] },
  { route: '/housing', phrases: ['housing', 'mortgage rate', 'home prices', 'affordability'] },
  { route: '/trader-positioning', phrases: ['positioning', 'cftc', 'commitment of traders', 'net long'] },
  // Markets
  { route: '/global-markets', phrases: ['global markets', 'world indices', 'cross asset', 'how are markets'] },
  { route: '/breadth', phrases: ['breadth', 'advance decline', 'new highs', 'participation'] },
  { route: '/sector-rotation', phrases: ['sector rotation', 'sector performance', 'which sectors', 'sector heatmap'] },
  { route: '/market-hours', phrases: ['market hours', 'is the market open', 'trading session', 'when does the market open'] },
  // Charts and stats
  { route: '/chart-studio', ticker: true, phrases: ['chart', 'candles', 'candlestick', 'plot'] },
  { route: '/asset-overlay', phrases: ['compare assets', 'relative performance', 'indexed to 100', 'outperformed'] },
  { route: '/correlation', phrases: ['correlation', 'correlated', 'diversification'] },
  { route: '/regression', phrases: ['regression', 'ols', 'r squared'] },
  { route: '/seasonality', ticker: true, phrases: ['seasonality', 'seasonal', 'best month', 'month pattern'] },
  // Portfolio
  { route: '/portfolio-manager', phrases: ['my portfolio', 'my holdings', 'my positions', 'book pnl'] },
  { route: '/portfolio-analysis', phrases: ['portfolio risk', 'concentration', 'how risky is my', 'portfolio drawdown', 'analyse my portfolio', 'analyze my portfolio'] },
  { route: '/factor-decomposition', phrases: ['factor', 'exposure to rates', 'factor risk'] },
  { route: '/portfolio-compare', phrases: ['compare portfolios', 'two portfolios'] },
  { route: '/portfolio-allocator', phrases: ['allocate', 'efficient frontier', 'optimal weights', 'deploy cash'] },
  { route: '/backtest', phrases: ['backtest', 'historical performance', 'how would it have done'] },
  { route: '/montecarlo', phrases: ['monte carlo', 'simulate', 'var', 'cvar', 'simulation'] },
  { route: '/trade-history', phrases: ['track record', 'my trades', 'import broker', 'how have i done'] },
  // Desk
  { route: '/paper-trading', phrases: ['paper trade', 'paper trading', 'simulated trading'] },
  { route: '/algo-strategy', phrases: ['algo', 'entry and exit rules', 'strategy rules', 'automate'] },
  { route: '/pairs-trader', phrases: ['pairs trade', 'cointegration', 'mean reversion'] },
  // Trade routes
  { route: '/logistics-map', phrases: ['freight', 'air cargo', 'shipping map', 'ports'] },
  { route: '/trade-flows', phrases: ['trade flows', 'imports and exports', 'bilateral trade'] },
  { route: '/flows-map', phrases: ['tankers', 'energy flows', 'pipelines', 'crude shipments'] },
  { route: '/chokepoint-exposure', phrases: ['chokepoint', 'hormuz', 'suez', 'strait', 'panama canal'] },
]

const ROUTE_TITLES: Record<string, string> = Object.fromEntries(
  ALL_TOOLS.map(t => [t.route.split('?')[0], t.title]),
)

/** Words that look like symbols but are how people describe things. */
const VOCAB = new Set<string>([
  ...INTENTS.flatMap(i => i.phrases.flatMap(p => p.split(' '))),
  ...ALL_TOOLS.flatMap(t => t.title.toLowerCase().split(/\s+/)),
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'my', 'is', 'are', 'and', 'or',
  'what', 'why', 'how', 'when', 'show', 'find', 'open', 'best', 'top', 'vs',
  // Finance words that are shaped like symbols but never meant as one.
  'beta', 'alpha', 'delta', 'gamma', 'vega', 'rho', 'risk', 'value', 'price',
  'yield', 'rate', 'rates', 'flow', 'flows', 'trade', 'book', 'fund', 'etf',
  'news', 'data', 'model', 'stock', 'stocks', 'bond', 'bonds', 'cash', 'debt',
])

const SYMBOL_RE = /^\^?[A-Za-z]{1,5}(\.[A-Za-z])?$/

// Every proper prefix of a vocabulary word. A query arrives one key at a time,
// so "wha" shows up long before "what" does, and reading that as a symbol threw
// a wall of "WHA -> Mover Radar" rows over the answer being reached for.
const VOCAB_PREFIXES = (() => {
  const out = new Set<string>()
  for (const word of VOCAB) {
    for (let i = 1; i < word.length; i++) out.add(word.slice(0, i))
  }
  return out
})()

/**
 * Pull a symbol out of a natural-language query.
 *
 * A bare lowercase word is NOT a ticker. That rule is the whole point: the
 * palette used to treat every 1-5 letter token as a symbol, so typing "vol",
 * "chart" or "beta" pushed a wall of "open VOL in ..." shortcuts over the tool
 * the user was actually reaching for.
 */
export function extractTicker(query: string): string | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  for (const raw of tokens) {
    const token = raw.replace(/[^A-Za-z.^]/g, '')
    if (!token || !SYMBOL_RE.test(token)) continue
    // Typed in caps is an explicit symbol, whatever the word is.
    if (token === token.toUpperCase() && /[A-Z]/.test(token)) return token.toUpperCase()
    // Otherwise only when it is neither ordinary search vocabulary nor the
    // start of some. That is what lets a lowercase "aapl" resolve while "vol",
    // "chart" and the half-typed "wha" do not. Typing it in caps stays the
    // escape hatch for a real symbol that shadows a word.
    const lower = token.toLowerCase()
    if (!VOCAB.has(lower) && !VOCAB_PREFIXES.has(lower)) return token.toUpperCase()
  }
  return null
}

export interface IntentMatch { route: string; title: string; score: number; ticker: string | null }

/**
 * Rank routes for a natural-language query. Longer phrase hits win, so
 * "reverse dcf" beats "dcf" and "implied volatility" beats "vol".
 */
export function resolveIntents(query: string, limit = 4): IntentMatch[] {
  const q = ` ${query.toLowerCase().trim().replace(/[^a-z0-9^. ]/g, ' ').replace(/\s+/g, ' ')} `
  if (q.trim().length < 2) return []
  const ticker = extractTicker(query)
  const out: IntentMatch[] = []
  for (const intent of INTENTS) {
    let best = 0
    for (const phrase of intent.phrases) {
      if (!q.includes(` ${phrase} `) && !q.includes(` ${phrase}`)) continue
      // Weight by how much of the query the phrase actually explains.
      best = Math.max(best, phrase.split(' ').length * 10 + phrase.length)
    }
    if (best > 0) {
      out.push({
        route: intent.route,
        title: ROUTE_TITLES[intent.route] ?? intent.route,
        score: best,
        ticker: intent.ticker ? ticker : null,
      })
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit)
}

/** The route to open, with the symbol applied when the destination reads one. */
export function intentUrl(match: IntentMatch): string {
  return match.ticker ? `${match.route}?ticker=${encodeURIComponent(match.ticker)}` : match.route
}
