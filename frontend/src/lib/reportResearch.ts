import axios from 'axios'
import { chartClip, kpiClip, tableClip, textClip } from './reportCaptureRegistry'
import type { ActivePortfolioContext } from './pmImport'
import { normalizeTicker } from './pmImport'
import type { ClipDraft, ReportScope } from './reportCreator'

export type ReportResearchIntent =
  | 'portfolio'
  | 'macro'
  | 'options'
  | 'catalyst'
  | 'comparison'
  | 'valuation'
  | 'company'

export type ReportResearchSourceId =
  | 'portfolio'
  | 'portfolio-risk'
  | 'company'
  | 'price-history'
  | 'market-compare'
  | 'mover'
  | 'news'
  | 'options'
  | 'earnings'
  | 'global-markets'
  | 'macro-events'
  | 'sentiment'
  | 'sector-rotation'
  | 'correlation'
  | 'regression'
  | 'factor-decomposition'
  | 'credit-spreads'
  | 'rate-engine'
  | 'peer-valuation'
  | 'dcf-valuation'
  | 'volatility-skew'
  | 'dealer-gex'
  | 'implied-probability'

export interface ReportResearchSource {
  id: ReportResearchSourceId
  label: string
  tool: string
  route: string
  reason: string
  targets: string[]
  selectionOrigin?: 'baseline' | 'ai'
}

export interface ReportResearchPlan {
  objective: string
  intent: ReportResearchIntent
  symbols: string[]
  sources: ReportResearchSource[]
  blockedReason?: string
  aiEnhanced?: boolean
  aiSummary?: string
}

export interface ReportResearchFailure {
  sourceId: ReportResearchSourceId
  label: string
  message: string
  target?: string
  researchKey?: string
}

export interface ReportResearchCompletion {
  sourceId: ReportResearchSourceId
  label: string
  clipCount: number
}

export interface ReportResearchResult {
  clips: ClipDraft[]
  completed: ReportResearchCompletion[]
  failed: ReportResearchFailure[]
  finishedAt: string
}

export interface ReportResearchProgress {
  sourceId: ReportResearchSourceId
  status: 'running' | 'complete' | 'partial' | 'failed'
  clipCount?: number
  message?: string
}

export interface ReportScreenerFilter {
  field: string
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'between'
  value: number
  value2: number | null
  param: string | null
}

export interface ReportScreenerSelection {
  symbols: string[]
  total: number
  explanation: string
  filters: ReportScreenerFilter[]
  sector: string | null
  universe: string | null
  exchange: string | null
  region: string | null
  sortBy: string
  sortDir: 'asc' | 'desc'
}

interface ResearchClient {
  get: (url: string) => Promise<unknown>
  post: (url: string, body: unknown) => Promise<unknown>
}

const DEFAULT_CLIENT: ResearchClient = {
  get: async url => (await axios.get(url)).data,
  post: async (url, body) => (await axios.post(url, body)).data,
}

const SOURCE_META: Record<ReportResearchSourceId, Omit<ReportResearchSource, 'reason' | 'targets'>> = {
  portfolio: { id: 'portfolio', label: 'Active book', tool: 'Portfolio Manager', route: '/portfolio-manager' },
  'portfolio-risk': { id: 'portfolio-risk', label: 'Risk and performance', tool: 'Portfolio Compare', route: '/portfolio-compare' },
  company: { id: 'company', label: 'Company snapshot', tool: 'Corporate Hub', route: '/corporate' },
  'price-history': { id: 'price-history', label: 'Price and drawdown', tool: 'Chart Studio', route: '/chart-studio' },
  'market-compare': { id: 'market-compare', label: 'Relative performance', tool: 'Compare', route: '/compare' },
  mover: { id: 'mover', label: 'Catalyst scan', tool: 'Mover Radar', route: '/mover-radar' },
  news: { id: 'news', label: 'Recent news', tool: 'Mover Radar', route: '/mover-radar' },
  options: { id: 'options', label: 'Options snapshot', tool: 'Options Desk', route: '/options' },
  earnings: { id: 'earnings', label: 'Earnings calendar', tool: 'Earnings Scanner', route: '/earnings-calendar' },
  'global-markets': { id: 'global-markets', label: 'Global market board', tool: 'Global Markets', route: '/global-markets' },
  'macro-events': { id: 'macro-events', label: 'Macro event calendar', tool: 'Macro Event Hub', route: '/macro-events' },
  sentiment: { id: 'sentiment', label: 'Market sentiment', tool: 'Sentiment Tracker', route: '/sentiment' },
  'sector-rotation': { id: 'sector-rotation', label: 'Sector leadership', tool: 'Sector Rotation', route: '/sector-rotation' },
  correlation: { id: 'correlation', label: 'Correlation structure', tool: 'Correlation', route: '/correlation' },
  regression: { id: 'regression', label: 'Regression model', tool: 'Regression', route: '/regression' },
  'factor-decomposition': { id: 'factor-decomposition', label: 'Factor exposures', tool: 'Factor Decomposition', route: '/factor-decomposition' },
  'credit-spreads': { id: 'credit-spreads', label: 'Credit risk regime', tool: 'Credit Spreads', route: '/credit-spreads' },
  'rate-engine': { id: 'rate-engine', label: 'Rates and Fed path', tool: 'Rate Engine', route: '/fed' },
  'peer-valuation': { id: 'peer-valuation', label: 'Peer valuation', tool: 'Peer Comparison', route: '/relative-valuation' },
  'dcf-valuation': { id: 'dcf-valuation', label: 'DCF valuation', tool: 'DCF Valuation', route: '/dcf' },
  'volatility-skew': { id: 'volatility-skew', label: 'Volatility skew', tool: 'Volatility Skew', route: '/skew' },
  'dealer-gex': { id: 'dealer-gex', label: 'Dealer gamma', tool: 'Dealer GEX', route: '/gex' },
  'implied-probability': { id: 'implied-probability', label: 'Implied probability', tool: 'Implied Probability', route: '/probability' },
}

type ResearchTargetMode = 'market' | 'symbols' | 'portfolio' | 'portfolio-or-symbols'

export interface ReportResearchToolCatalogItem {
  id: ReportResearchSourceId
  label: string
  description: string
  targetMode: ResearchTargetMode
  producesVisuals: boolean
}

export const REPORT_RESEARCH_TOOL_CATALOG: ReportResearchToolCatalogItem[] = [
  { id: 'portfolio', label: 'Active book', description: 'Holdings, cash, saved values, and concentration.', targetMode: 'portfolio', producesVisuals: false },
  { id: 'portfolio-risk', label: 'Risk and performance', description: 'Portfolio return, volatility, drawdown, beta, and a benchmark-relative performance chart.', targetMode: 'portfolio', producesVisuals: true },
  { id: 'company', label: 'Company snapshot', description: 'Company fundamentals, market data, valuation multiples, and beta.', targetMode: 'symbols', producesVisuals: false },
  { id: 'price-history', label: 'Price and drawdown', description: 'Historical price path with return and drawdown context.', targetMode: 'symbols', producesVisuals: true },
  { id: 'market-compare', label: 'Relative performance', description: 'Normalized multi-asset performance comparison.', targetMode: 'symbols', producesVisuals: true },
  { id: 'mover', label: 'Catalyst scan', description: 'Price, volume, market context, filings, and event evidence behind a move.', targetMode: 'symbols', producesVisuals: false },
  { id: 'news', label: 'Recent news', description: 'Recent symbol-specific headlines and sources.', targetMode: 'symbols', producesVisuals: false },
  { id: 'options', label: 'Options snapshot', description: 'Implied volatility, realized volatility, expected move, and positioning.', targetMode: 'symbols', producesVisuals: true },
  { id: 'earnings', label: 'Earnings calendar', description: 'Scheduled earnings events over the report outlook horizon.', targetMode: 'symbols', producesVisuals: false },
  { id: 'global-markets', label: 'Global market board', description: 'Cross-asset session levels and performance.', targetMode: 'market', producesVisuals: true },
  { id: 'macro-events', label: 'Macro event calendar', description: 'Upcoming economic and policy events.', targetMode: 'market', producesVisuals: false },
  { id: 'sentiment', label: 'Market sentiment', description: 'Current directional news sentiment and participation.', targetMode: 'market', producesVisuals: true },
  { id: 'sector-rotation', label: 'Sector leadership', description: 'Sector return leadership and momentum across horizons.', targetMode: 'market', producesVisuals: true },
  { id: 'correlation', label: 'Correlation structure', description: 'Correlation matrix, strongest pairs, beta, and rolling correlation.', targetMode: 'symbols', producesVisuals: true },
  { id: 'regression', label: 'Regression model', description: 'Explain one asset with one or more comparison assets using fitted-versus-actual returns, coefficients, significance, and residual diagnostics.', targetMode: 'symbols', producesVisuals: true },
  { id: 'factor-decomposition', label: 'Factor exposures', description: 'Systematic, idiosyncratic, macro or style factor exposures and rolling betas.', targetMode: 'portfolio-or-symbols', producesVisuals: true },
  { id: 'credit-spreads', label: 'Credit risk regime', description: 'Investment-grade, high-yield, quality ladder, VIX, and spread history.', targetMode: 'market', producesVisuals: true },
  { id: 'rate-engine', label: 'Rates and Fed path', description: 'Market-implied Fed path and Treasury yield-curve visuals.', targetMode: 'market', producesVisuals: true },
  { id: 'peer-valuation', label: 'Peer valuation', description: 'Peer multiples, operating quality, consensus targets, valuation gaps, and analyst upside with comparison visuals.', targetMode: 'symbols', producesVisuals: true },
  { id: 'dcf-valuation', label: 'DCF valuation', description: 'Fundamental intrinsic value using explicit AI-assisted assumptions, projected revenue and free cash flow, plus driver sensitivity.', targetMode: 'symbols', producesVisuals: true },
  { id: 'volatility-skew', label: 'Volatility skew', description: 'Options smile, downside skew, implied move, and ATM volatility term structure.', targetMode: 'symbols', producesVisuals: true },
  { id: 'dealer-gex', label: 'Dealer gamma', description: 'Dealer gamma exposure by strike, gamma flip, and the largest positive and negative positioning levels.', targetMode: 'symbols', producesVisuals: true },
  { id: 'implied-probability', label: 'Implied probability', description: 'Risk-neutral price cone, options-implied terminal distribution, percentiles, and finish-above probabilities.', targetMode: 'symbols', producesVisuals: true },
]

const HISTORICAL_RESEARCH_SOURCES = new Set<ReportResearchSourceId>([
  'price-history',
  'market-compare',
  'portfolio-risk',
  'sector-rotation',
  'correlation',
  'regression',
  'factor-decomposition',
  'credit-spreads',
])

const FORWARD_RESEARCH_SOURCES = new Set<ReportResearchSourceId>([
  'earnings',
  'macro-events',
  'implied-probability',
])

function sourceMatchesHorizon(sourceId: ReportResearchSourceId, scope: ReportScope): boolean {
  if (scope.lookbackPreset === 'none' && HISTORICAL_RESEARCH_SOURCES.has(sourceId)) return false
  if (scope.lookforwardPreset === 'none' && FORWARD_RESEARCH_SOURCES.has(sourceId)) return false
  return true
}

const SYMBOL_STOP = new Set([
  'A', 'AI', 'AND', 'ARE', 'AS', 'AT', 'BETTER', 'BETWEEN', 'BOOK', 'BUY', 'BY',
  'CAN', 'COMPARE', 'DCF', 'DO', 'EPS', 'ETF', 'FED', 'FOR', 'FROM', 'HAS', 'HOLD',
  'HOW', 'I', 'IN', 'IS', 'IT', 'IV', 'LONG', 'MARKET', 'MY', 'NOT', 'OF', 'ON',
  'OR', 'PE', 'PORTFOLIO', 'REPORT', 'RISK', 'SELL', 'SHORT', 'SHOULD', 'THE',
  'THIS', 'TO', 'US', 'VALUE', 'VS', 'WHAT', 'WHICH', 'WHY', 'WITH', 'YTD',
])

const unique = <T,>(values: T[]) => [...new Set(values)]

export function parseResearchSymbols(value: string): string[] {
  return unique(
    value
      .split(/[\s,;]+/)
      .map(normalizeTicker)
      .filter(symbol => /^[A-Z0-9^][A-Z0-9^=-]{0,11}$/.test(symbol) && !SYMBOL_STOP.has(symbol)),
  ).slice(0, 8)
}

export function inferResearchSymbols(value: string): string[] {
  const matches = value.match(/\$?[A-Z^][A-Z0-9.^=-]{0,11}\b/g) ?? []
  return unique(
    matches
      .map(match => normalizeTicker(match.replace(/^\$/, '')))
      .filter(symbol => !SYMBOL_STOP.has(symbol)),
  ).slice(0, 8)
}

function detectIntent(objective: string, symbolCount = 0): ReportResearchIntent {
  const text = objective.toLowerCase()
  if (/\b(portfolio|holdings|book|positions|allocation|my account)\b/.test(text)) return 'portfolio'
  if (symbolCount > 1 && /\b(compare|comparison|versus|vs\.?|relative|between|better)\b/.test(text)) return 'comparison'
  if (/\b(options?|volatility|implied vol|iv rank|skew|gamma|delta|straddle|strangle)\b/.test(text)) return 'options'
  if (/\b(macro|economy|economic|inflation|rates?|fed|fomc|yield|credit|recession|growth)\b/.test(text)) return 'macro'
  if (/\b(catalyst|moving|mover|selloff|rally|surge|drop|news|event)\b/.test(text)) return 'catalyst'
  if (/\b(compare|comparison|versus|vs\.?|relative|between|better)\b/.test(text)) return 'comparison'
  if (/\b(valuation|value|fair value|multiple|p\/e|peg|cheap|expensive|peer)\b/.test(text)) return 'valuation'
  return 'company'
}

function portfolioSymbols(portfolio: ActivePortfolioContext): string[] {
  return [...portfolio.holdings]
    .sort((a, b) => (b.shares * b.avgCost) - (a.shares * a.avgCost))
    .map(holding => normalizeTicker(holding.ticker))
    .filter(Boolean)
    .slice(0, 8)
}

export function planReportResearch(
  scope: ReportScope,
  portfolio: ActivePortfolioContext,
): ReportResearchPlan {
  const objective = [scope.goal || scope.purpose, scope.mustInclude].filter(Boolean).join('\n').trim()
  const explicit = parseResearchSymbols(scope.researchSymbols)
  const inferred = inferResearchSymbols(objective)
  const bookSymbols = scope.includePortfolio && portfolio.hasData ? portfolioSymbols(portfolio) : []
  const symbols = unique(explicit.length ? explicit : inferred.length ? inferred : bookSymbols)
  const intent = detectIntent(objective, symbols.length)
  const researchTargets = intent === 'comparison' ? symbols : symbols.slice(0, 1)
  const catalystRequested = /\b(catalyst|moving|mover|selloff|rally|surge|drop|news|event)\b/i.test(objective)
  const valuationRequested = /\b(valuation|value|fair value|multiple|p\/e|peg|cheap|expensive|peer|intrinsic)\b/i.test(objective)
  const gammaRequested = /\b(gamma|gex|dealer positioning|call wall|put wall)\b/i.test(objective)
  const sources: ReportResearchSource[] = []

  const add = (id: ReportResearchSourceId, reason: string, targets: string[] = []) => {
    if (sources.some(source => source.id === id) || !sourceMatchesHorizon(id, scope)) return
    sources.push({ ...SOURCE_META[id], reason, targets, selectionOrigin: 'baseline' })
  }

  if (!objective) {
    return { objective, intent, symbols, sources, blockedReason: 'Add an objective so AlphaTape can choose relevant tools.' }
  }

  if (scope.includePortfolio && portfolio.hasData && (portfolio.optionsCount > 0 || portfolio.futuresCount > 0)) {
    const unsupported = [
      portfolio.optionsCount ? `${portfolio.optionsCount} option position${portfolio.optionsCount === 1 ? '' : 's'}` : '',
      portfolio.futuresCount ? `${portfolio.futuresCount} futures position${portfolio.futuresCount === 1 ? '' : 's'}` : '',
    ].filter(Boolean).join(' and ')
    return {
      objective,
      intent,
      symbols,
      sources,
      blockedReason: `The active portfolio includes ${unsupported}. Automated book research currently supports equities and cash only. Turn off portfolio context or use a supported book.`,
    }
  }

  if (intent === 'portfolio') {
    if (scope.includePortfolio && portfolio.hasData) {
      add('portfolio', 'Establish holdings, cash, and concentration from the active book.')
      add('portfolio-risk', 'Measure return, volatility, beta, drawdown, and benchmark-relative performance.')
    }
    if (!(scope.includePortfolio && portfolio.hasData) && symbols.length === 0) {
      return {
        objective, intent, symbols, sources,
        blockedReason: 'Select an active portfolio or add ticker symbols for this risk report.',
      }
    }
    add('global-markets', 'Frame the book against the current cross-asset session.')
    add('macro-events', 'Identify scheduled events that can change portfolio risk.')
    add('earnings', 'Check near-term earnings risk in the selected names.', symbols)
  } else if (intent === 'macro') {
    add('global-markets', 'Establish the current cross-asset regime.')
    add('macro-events', 'Map the upcoming policy and economic calendar.')
    add('sentiment', 'Measure the direction and confidence of the current news tape.')
    add('sector-rotation', 'Show where market leadership is strengthening or weakening.')
  } else {
    if (symbols.length === 0) {
      return {
        objective, intent, symbols, sources,
        blockedReason: 'Add at least one ticker symbol for this research question.',
      }
    }
    add('company', 'Anchor the report in the subject company’s business mix, financial trajectory, analyst view, and market data.', researchTargets)
    if (intent === 'comparison' && symbols.length > 1) {
      add('market-compare', 'Compare the subjects on one normalized return path.', symbols)
      add('regression', 'Quantify how tightly the subjects move together and where their return paths diverge.', symbols)
      if (valuationRequested) add('peer-valuation', 'Compare valuation and operating quality against each subject’s peer group.', symbols.slice(0, 4))
    } else {
      add('price-history', 'Measure the subject’s return, volatility, and drawdown over the report horizon.', researchTargets)
    }
    if (intent === 'options') {
      add('options', 'Measure implied volatility, expected move, and options positioning.', researchTargets)
      add('volatility-skew', 'Show how downside protection and volatility change across strikes and expiries.', researchTargets)
      add('implied-probability', 'Translate the options surface into a price cone and terminal probability distribution.', researchTargets)
      if (gammaRequested) add('dealer-gex', 'Locate gamma concentration, the flip level, and potential pin or acceleration zones.', researchTargets)
      if (catalystRequested) add('mover', 'Test the move against price, volume, market context, filings, and news.', researchTargets)
      add('news', 'Check whether current volatility is tied to a visible catalyst.', researchTargets)
    } else if (intent === 'catalyst') {
      add('mover', 'Test the move against price, volume, market context, filings, and news.', researchTargets)
      add('news', 'Retain the underlying headlines as reviewable evidence.', researchTargets)
      add('options', 'Check whether implied volatility confirms the event risk.', researchTargets)
    } else {
      if (intent === 'company') {
        add('peer-valuation', 'Test the subject’s valuation and returns against a relevant peer set.', researchTargets)
      }
      add('news', 'Capture current catalysts and changes in the information set.', researchTargets)
      add('earnings', 'Check the next scheduled earnings event.', researchTargets)
      if (intent === 'valuation') {
        add('peer-valuation', 'Benchmark multiples, operating quality, and consensus targets against peers.', researchTargets)
        add('dcf-valuation', 'Build an intrinsic-value anchor with explicit assumptions and sensitivity.', researchTargets)
      }
    }
  }

  if (scope.includePortfolio && portfolio.hasData && intent !== 'portfolio') {
    add('portfolio', 'Show whether the researched names are material to the active book.')
  }

  return { objective, intent, symbols, sources }
}

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const array = (value: unknown): any[] => Array.isArray(value) ? value : []
const finite = (value: unknown): number | null => {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}
const percent = (value: unknown, digits = 1): string => {
  const number = finite(value)
  return number == null ? '—' : `${number >= 0 ? '+' : ''}${number.toFixed(digits)}%`
}
const money = (value: unknown): string => {
  const number = finite(value)
  if (number == null) return '—'
  if (Math.abs(number) >= 1e12) return `$${(number / 1e12).toFixed(2)}T`
  if (Math.abs(number) >= 1e9) return `$${(number / 1e9).toFixed(2)}B`
  if (Math.abs(number) >= 1e6) return `$${(number / 1e6).toFixed(1)}M`
  return `$${number.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}
const moneyMillions = (value: unknown): string => {
  const number = finite(value)
  if (number == null) return '—'
  if (Math.abs(number) >= 1e6) return `$${(number / 1e6).toFixed(2)}T`
  if (Math.abs(number) >= 1e3) return `$${(number / 1e3).toFixed(2)}B`
  return `$${number.toFixed(1)}M`
}
const plain = (value: unknown): string => value == null || value === '' ? '—' : String(value)
const median = (values: number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value))
const routeFor = (route: string, ticker?: string) =>
  ticker ? `${route}?ticker=${encodeURIComponent(ticker)}` : route

export async function screenReportSymbols(
  query: string,
  client: ResearchClient = DEFAULT_CLIENT,
): Promise<ReportScreenerSelection> {
  const parsed = record(await client.post('/api/ai/screener-parse', { query: query.trim() }))
  if (parsed.valid === false) {
    const warning = plain(parsed.warning)
    throw new Error(warning === '—'
      ? 'The AI could not map this brief to supported Stock Screener criteria.'
      : warning)
  }
  const filters = array(parsed.filters).flatMap(raw => {
    const item = record(raw)
    const value = finite(item.value)
    const operator = plain(item.operator)
    if (!plain(item.field).trim() || value == null || !['gt', 'gte', 'lt', 'lte', 'between'].includes(operator)) return []
    const value2 = operator === 'between' ? finite(item.value2) : null
    if (operator === 'between' && value2 == null) return []
    return [{
      field: plain(item.field),
      operator: operator as ReportScreenerFilter['operator'],
      value,
      value2,
      param: item.param ? plain(item.param) : null,
    }]
  })
  const requestedLimit = Math.trunc(finite(parsed.limit) ?? 8)
  const limit = clamp(requestedLimit, 1, 8)
  const sortDir = plain(parsed.sort_dir).toLowerCase() === 'asc' ? 'asc' : 'desc'
  const includedSymbols = unique(
    array(parsed.include_symbols)
      .map(symbol => normalizeTicker(plain(symbol)))
      .filter(symbol => /^[A-Z0-9^][A-Z0-9^=-]{0,11}$/.test(symbol)),
  )
  const screen = record(await client.post('/api/screener/run', {
    filters,
    sector: parsed.sector || null,
    universe: parsed.universe || null,
    exchange: parsed.exchange || null,
    region: parsed.region || null,
    sort_by: plain(parsed.sort_by) === '—' ? 'marketCap' : plain(parsed.sort_by),
    sort_dir: sortDir,
    sort_param: parsed.sort_param || null,
    limit,
  }))
  const symbols = unique(
    [
      ...includedSymbols,
      ...array(screen.results)
        .map(row => normalizeTicker(plain(record(row).ticker)))
        .filter(symbol => /^[A-Z0-9^][A-Z0-9^=-]{0,11}$/.test(symbol)),
    ],
  ).slice(0, limit)
  return {
    symbols,
    total: Math.max(symbols.length, Math.trunc(finite(screen.total) ?? symbols.length)),
    explanation: plain(parsed.explanation) === '—'
      ? 'Applied the interpreted Stock Screener criteria.'
      : plain(parsed.explanation),
    filters,
    sector: parsed.sector ? plain(parsed.sector) : null,
    universe: parsed.universe ? plain(parsed.universe) : null,
    exchange: parsed.exchange ? plain(parsed.exchange) : null,
    region: parsed.region ? plain(parsed.region) : null,
    sortBy: plain(parsed.sort_by) === '—' ? 'marketCap' : plain(parsed.sort_by),
    sortDir,
  }
}

function tagClip(
  draft: ClipDraft,
  source: ReportResearchSource,
  key: string,
  ticker?: string,
): ClipDraft {
  return {
    ...draft,
    origin: 'alphatape',
    researchSourceId: source.id,
    researchKey: `${source.id}:${key}`,
    sourceRoute: routeFor(source.route, ticker),
  }
}

function thin<T>(rows: T[], maximum = 140): T[] {
  if (rows.length <= maximum) return rows
  const step = Math.ceil(rows.length / maximum)
  return rows.filter((_, index) => index % step === 0 || index === rows.length - 1)
}

interface ResearchDateRange {
  start: string
  end: string
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10)
const validDate = (value?: string) => {
  if (!value) return null
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isNaN(date.getTime()) ? null : date
}

function lookbackRange(scope: ReportScope, today = new Date()): ResearchDateRange {
  const customEnd = scope.lookbackPreset === 'custom' ? validDate(scope.customEnd) : null
  const end = customEnd ?? today
  const customStart = scope.lookbackPreset === 'custom' ? validDate(scope.customStart) : null
  if (customStart) return { start: isoDate(customStart), end: isoDate(end) }
  if (scope.lookbackPreset === 'ytd') {
    return { start: `${end.getUTCFullYear()}-01-01`, end: isoDate(end) }
  }
  if (scope.lookbackPreset === 'qtd') {
    const quarterMonth = Math.floor(end.getUTCMonth() / 3) * 3
    return {
      start: isoDate(new Date(Date.UTC(end.getUTCFullYear(), quarterMonth, 1, 12))),
      end: isoDate(end),
    }
  }
  const days = scope.lookbackPreset === 'last7' ? 7
    : scope.lookbackPreset === 'last90' ? 90
      : 30
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - (days - 1))
  return { start: isoDate(start), end: isoDate(end) }
}

function lookforwardRange(scope: ReportScope, today = new Date()): ResearchDateRange {
  const customStart = scope.lookforwardPreset === 'custom' ? validDate(scope.forwardCustomStart) : null
  const start = customStart ?? today
  const customEnd = scope.lookforwardPreset === 'custom' ? validDate(scope.forwardCustomEnd) : null
  if (customEnd) return { start: isoDate(start), end: isoDate(customEnd) }
  const days = scope.lookforwardPreset === 'next7' ? 7
    : scope.lookforwardPreset === 'next30' ? 30
      : scope.lookforwardPreset === 'next90' ? 90
        : scope.lookforwardPreset === 'next180' ? 180
          : 14
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + (days - 1))
  return { start: isoDate(start), end: isoDate(end) }
}

function inclusiveDays(range: ResearchDateRange): number {
  const start = validDate(range.start)
  const end = validDate(range.end)
  if (!start || !end) return 1
  return Math.max(1, Math.floor((end.getTime() - start.getTime()) / 86400000) + 1)
}

function comparePeriod(scope: ReportScope): string {
  if (scope.lookbackPreset === 'ytd') return 'ytd'
  const days = inclusiveDays(lookbackRange(scope))
  if (days <= 8) return '1w'
  if (days <= 45) return '1m'
  if (days <= 120) return '3m'
  if (days <= 210) return '6m'
  if (days <= 550) return '1y'
  if (days <= 900) return '2y'
  return '5y'
}

function correlationPeriod(scope: ReportScope): string {
  const days = inclusiveDays(lookbackRange(scope))
  if (days <= 45) return '1mo'
  if (days <= 120) return '3mo'
  if (days <= 210) return '6mo'
  if (days <= 550) return '1y'
  if (days <= 900) return '2y'
  if (days <= 1300) return '3y'
  return '5y'
}

export function researchSourceProducesVisuals(sourceId: ReportResearchSourceId): boolean {
  return REPORT_RESEARCH_TOOL_CATALOG.find(item => item.id === sourceId)?.producesVisuals ?? false
}

function targetsForSource(sourceId: ReportResearchSourceId, symbols: string[]): string[] {
  const limit = sourceId === 'dcf-valuation' || sourceId === 'volatility-skew'
    || sourceId === 'dealer-gex' || sourceId === 'implied-probability'
    ? 3
    : sourceId === 'peer-valuation'
      ? 4
      : 8
  return symbols.slice(0, limit)
}

export async function enhanceReportResearchPlan(
  baseline: ReportResearchPlan,
  scope: ReportScope,
  portfolio: ActivePortfolioContext,
  client: ResearchClient = DEFAULT_CLIENT,
): Promise<ReportResearchPlan> {
  if (baseline.blockedReason) return baseline
  const toolCatalog = REPORT_RESEARCH_TOOL_CATALOG.filter(tool => sourceMatchesHorizon(tool.id, scope))
  const historicalWindow = scope.lookbackPreset === 'none'
    ? 'historical lookback disabled'
    : `${lookbackRange(scope).start} to ${lookbackRange(scope).end}`
  const forwardWindow = scope.lookforwardPreset === 'none'
    ? 'forward outlook disabled'
    : `${lookforwardRange(scope).start} to ${lookforwardRange(scope).end}`
  const response = record(await client.post('/api/ai/report-research-plan', {
    objective: baseline.objective,
    mustInclude: scope.mustInclude,
    timeframe: `${historicalWindow}; ${forwardWindow}`,
    symbols: baseline.symbols,
    portfolio: {
      included: scope.includePortfolio && portfolio.hasData,
      name: portfolio.name,
      positionCount: portfolio.positionCount,
      equityCount: portfolio.holdings.length,
      optionsCount: portfolio.optionsCount,
      futuresCount: portfolio.futuresCount,
      cashIncluded: portfolio.cashValue > 0,
    },
    baselineSourceIds: baseline.sources.map(source => source.id),
    tools: toolCatalog,
  }))
  const additions = array(response.additions)
  const catalog = new Map(toolCatalog.map(item => [item.id, item]))
  const sources = [...baseline.sources]
  let added = 0
  for (const raw of additions) {
    if (added >= 4) break
    const addition = record(raw)
    const id = String(addition.id ?? '') as ReportResearchSourceId
    const item = catalog.get(id)
    if (!item || sources.some(source => source.id === id)) continue
    const hasPortfolio = scope.includePortfolio && portfolio.hasData
    if (item.targetMode === 'symbols' && baseline.symbols.length === 0) continue
    if (item.targetMode === 'portfolio' && !hasPortfolio) continue
    if (item.targetMode === 'portfolio-or-symbols' && !hasPortfolio && baseline.symbols.length === 0) continue
    if ((id === 'correlation' || id === 'regression') && baseline.symbols.length < 2) continue
    const reason = String(addition.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
    if (!reason) continue
    sources.push({
      ...SOURCE_META[id],
      reason,
      targets: item.targetMode === 'market' || item.targetMode === 'portfolio'
        ? []
        : targetsForSource(id, baseline.intent === 'comparison' ? baseline.symbols : baseline.symbols.slice(0, 1)),
      selectionOrigin: 'ai',
    })
    added += 1
  }
  return {
    ...baseline,
    sources,
    aiEnhanced: true,
    aiSummary: String(response.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
  }
}

async function perTicker(
  source: ReportResearchSource,
  run: (ticker: string) => Promise<ClipDraft | ClipDraft[] | null>,
): Promise<ClipDraft[]> {
  const settled = await Promise.allSettled(source.targets.map(run))
  return settled.flatMap(result => {
    if (result.status !== 'fulfilled' || !result.value) return []
    return Array.isArray(result.value) ? result.value : [result.value]
  })
}

async function runSource(
  source: ReportResearchSource,
  scope: ReportScope,
  portfolio: ActivePortfolioContext,
  client: ResearchClient,
): Promise<ClipDraft[]> {
  switch (source.id) {
    case 'company':
      return perTicker(source, async ticker => {
        const safeGet = async (url: string) => {
          try {
            return record(await client.get(url))
          } catch {
            return {}
          }
        }
        const [data, profile, analyst, earningsDetail, financials] = await Promise.all([
          safeGet(`/api/corporate/hub?ticker=${encodeURIComponent(ticker)}`),
          safeGet(`/api/corporate/supply-chain?ticker=${encodeURIComponent(ticker)}`),
          safeGet(`/api/corporate/hub/analyst?ticker=${encodeURIComponent(ticker)}`),
          safeGet(`/api/corporate/hub/earnings-detail?ticker=${encodeURIComponent(ticker)}`),
          safeGet(`/api/factset/financials?ticker=${encodeURIComponent(ticker)}&actual=4&estimate=2`),
        ])
        if (!Object.keys(data).length && !Object.keys(profile).length) return null
        const clips: ClipDraft[] = [tagClip(kpiClip('Corporate Hub', `${ticker} company snapshot`, [
          { label: 'Price', value: money(data.current_price), sub: percent(data.pct_change_1d) },
          { label: 'Market cap', value: money(data.market_cap ?? profile.market_cap) },
          { label: 'Forward P/E', value: finite(data.forward_pe) == null ? (finite(profile.pe_ratio) == null ? '—' : `${finite(profile.pe_ratio)!.toFixed(1)}x TTM`) : `${finite(data.forward_pe)!.toFixed(1)}x` },
          { label: 'EV / EBITDA', value: finite(data.ev_ebitda) == null ? '—' : finite(data.ev_ebitda)!.toFixed(1) },
          { label: 'ROE', value: finite(profile.roe) == null ? '—' : `${finite(profile.roe)!.toFixed(1)}%` },
          { label: 'Revenue growth', value: finite(profile.rev_growth) == null ? '—' : `${(finite(profile.rev_growth)! * 100).toFixed(1)}%` },
          { label: 'Consensus', value: plain(data.consensus ?? analyst.recommendation_key), sub: [profile.sector ?? data.sector, profile.industry ?? data.industry].filter(Boolean).join(' · ') || undefined },
        ]), source, ticker, ticker)]

        const segmentBlock = array(record(profile.product_segments).latest).length
          ? record(profile.product_segments)
          : record(profile.revenue_activity)
        const segmentRows = array(segmentBlock.latest).map(record)
          .filter(row => plain(row.name) !== '—' && finite(row.pct) != null)
        if (segmentRows.length >= 2) {
          clips.push(tagClip(tableClip(
            'Corporate Hub',
            `Product Segments · ${ticker}`,
            ['Segment', 'Value', 'Share %', 'YoY %'],
            segmentRows.slice(0, 8).map(row => [
              plain(row.name),
              finite(row.value),
              finite(row.pct),
              finite(row.yoy_pct),
            ]),
          ), source, `${ticker}:segments`, ticker))
        }

        const activityHistory = array(record(profile.revenue_activity).history).map(record)
        if (activityHistory.length >= 2) {
          const activityNames = unique(
            activityHistory.flatMap(row => array(row.segments).map(segment => plain(record(segment).name)))
              .filter(name => name !== '—'),
          ).slice(0, 5)
          const activityRows = activityHistory.map(row => {
            const values = new Map(array(row.segments).map(segment => {
              const item = record(segment)
              return [plain(item.name), finite(item.value)]
            }))
            return {
              year: plain(row.year),
              ...Object.fromEntries(activityNames.map(name => [
                name,
                values.get(name) == null ? null : +(values.get(name)! / 1e9).toFixed(2),
              ])),
            }
          })
          clips.push(tagClip(chartClip(
            'Corporate Hub',
            `${ticker} revenue activity history`,
            'line',
            'year',
            activityRows,
            activityNames.map(name => ({ key: name, label: `${name} ($B)` })),
          ), source, `${ticker}:activity-history`, ticker))
        }

        const geographicRows = array(record(profile.geo_segments).latest).map(record)
          .filter(row => plain(row.name) !== '—' && finite(row.pct) != null)
        if (geographicRows.length >= 2) {
          clips.push(tagClip(tableClip(
            'Corporate Hub',
            `Geographic Segments · ${ticker}`,
            ['Region', 'Value', 'Share %'],
            geographicRows.slice(0, 8).map(row => [
              plain(row.name),
              finite(row.value),
              finite(row.pct),
            ]),
          ), source, `${ticker}:geography`, ticker))
        }

        if (/\bbanks?\b/i.test(plain(profile.industry))) {
          const fdic = await safeGet('/api/official/fdic')
          const bankRows = array(fdic.banks).map(record)
            .filter(row => finite(row.assets) != null)
            .slice(0, 10)
          if (bankRows.length) {
            clips.push(tagClip(tableClip(
              'FDIC BankFind',
              `Bank profitability and credit context · ${ticker}`,
              ['Bank', 'Assets $M', 'Deposits $M', 'ROA %', 'ROE %', 'NIM %', 'Net charge-offs %'],
              bankRows.map(row => [
                plain(row.name),
                finite(row.assets),
                finite(row.deposits),
                finite(row.roa),
                finite(row.roe),
                finite(row.nim),
                finite(row.net_chargeoffs),
              ]),
            ), source, `${ticker}:bank-context`, ticker))
          }
        }

        if (finite(analyst.target_mean) != null || finite(analyst.implied_upside) != null) {
          const distribution = record(analyst.distribution)
          clips.push(tagClip(kpiClip('Corporate Hub', `Analyst view · ${ticker}`, [
            { label: 'Mean target', value: money(analyst.target_mean), sub: finite(analyst.implied_upside) == null ? undefined : `${percent(analyst.implied_upside)} vs spot` },
            { label: 'Target low', value: money(analyst.target_low) },
            { label: 'Target high', value: money(analyst.target_high) },
            { label: 'Analysts', value: plain(analyst.total_analysts) },
            { label: 'Buy ratings', value: String((finite(distribution.strongBuy) ?? 0) + (finite(distribution.buy) ?? 0)) },
            { label: 'Hold / sell', value: `${finite(distribution.hold) ?? 0} / ${(finite(distribution.sell) ?? 0) + (finite(distribution.strongSell) ?? 0)}` },
          ]), source, `${ticker}:analyst`, ticker))
        }

        if (
          data.date
          || finite(earningsDetail.epsEst) != null
          || finite(earningsDetail.revEst) != null
          || finite(earningsDetail.beatRatePct) != null
        ) {
          clips.push(tagClip(kpiClip('Corporate Hub', `Earnings setup · ${ticker}`, [
            { label: 'Report date', value: plain(data.date), sub: plain(earningsDetail.reportTiming) === '—' ? undefined : plain(earningsDetail.reportTiming) },
            { label: 'EPS estimate', value: finite(earningsDetail.epsEst) == null ? '—' : money(earningsDetail.epsEst), sub: finite(earningsDetail.epsPriorYear) == null ? undefined : `prior year ${money(earningsDetail.epsPriorYear)}` },
            { label: 'Revenue estimate', value: money(earningsDetail.revEst) },
            { label: 'Historical beat rate', value: finite(earningsDetail.beatRatePct) == null ? '—' : `${finite(earningsDetail.beatRatePct)!.toFixed(0)}%` },
            { label: 'Average reaction', value: finite(earningsDetail.histAvgMovePct) == null ? '—' : `${finite(earningsDetail.histAvgMovePct)!.toFixed(1)}% absolute` },
            { label: 'Horizon', value: plain(data.horizon) },
          ]), source, `${ticker}:earnings-setup`, ticker))
        }

        const periods = array(financials.periods).map(record)
        const financialRows = array(financials.groups)
          .flatMap(group => array(record(group).rows).map(record))
        const rowFor = (label: string) => financialRows.find(row => plain(row.label).toLowerCase() === label.toLowerCase())
        const revenue = rowFor('Revenue')
        const netIncome = rowFor('Net Income')
        if (financials.available === true && periods.length >= 2 && (revenue || netIncome)) {
          const trendRows = periods.map((period, index) => ({
            period: `${plain(period.label)}${period.is_estimate ? 'E' : 'A'}`,
            revenue: finite(array(revenue?.values)[index]),
            netIncome: finite(array(netIncome?.values)[index]),
          }))
          clips.push(tagClip(chartClip(
            'Corporate Hub',
            `${ticker} financial trajectory · actual and consensus`,
            'bar',
            'period',
            trendRows,
            [
              ...(revenue ? [{ key: 'revenue', label: 'Revenue ($M)' }] : []),
              ...(netIncome ? [{ key: 'netIncome', label: 'Net income ($M)' }] : []),
            ],
          ), source, `${ticker}:financial-trend`, ticker))

          const selected = ['Revenue', 'Net Income', 'EPS (Diluted)', 'Return on Equity']
            .map(label => rowFor(label))
            .filter((row): row is Record<string, any> => !!row)
          if (selected.length) {
            clips.push(tagClip(tableClip(
              'Corporate Hub',
              `Financials and estimates · ${ticker}`,
              ['Metric', 'Unit', ...periods.map(period => `${plain(period.label)}${period.is_estimate ? 'E' : 'A'}`)],
              selected.map(row => [
                plain(row.label),
                plain(row.unit),
                ...array(row.values).slice(0, periods.length).map(value => finite(value)),
              ]),
            ), source, `${ticker}:financial-table`, ticker))
          }
        }
        return clips
      })

    case 'peer-valuation':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/corporate/peer-valuation?ticker=${encodeURIComponent(ticker)}`))
        const peers = array(data.peers).map(record)
        const target = peers.find(peer => Boolean(peer.is_target) || normalizeTicker(plain(peer.ticker)) === ticker)
        if (!target) return null
        const comparisonPeers = peers.filter(peer => peer !== target)
        const peerMedian = (key: string) => median(comparisonPeers.map(peer => finite(peer[key])).filter((value): value is number => value != null))
        const analystUpside = finite(target.target_mean_price) != null && finite(target.price)
          ? ((finite(target.target_mean_price)! / finite(target.price)!) - 1) * 100
          : null
        const clips: ClipDraft[] = [
          tagClip(kpiClip('Peer Comparison', `Peer valuation · ${ticker}`, [
            { label: 'P/E', value: finite(target.pe) == null ? '—' : `${finite(target.pe)!.toFixed(1)}x`, sub: peerMedian('pe') == null ? undefined : `peer median ${peerMedian('pe')!.toFixed(1)}x` },
            { label: 'EV / EBITDA', value: finite(target.ev_ebitda) == null ? '—' : `${finite(target.ev_ebitda)!.toFixed(1)}x`, sub: peerMedian('ev_ebitda') == null ? undefined : `peer median ${peerMedian('ev_ebitda')!.toFixed(1)}x` },
            { label: 'Revenue growth', value: finite(target.revenue_growth) == null ? '—' : percent(finite(target.revenue_growth)! * 100), sub: peerMedian('revenue_growth') == null ? undefined : `peer median ${percent(peerMedian('revenue_growth')! * 100)}` },
            { label: 'ROE', value: finite(target.roe) == null ? '—' : percent(finite(target.roe)! * 100), sub: peerMedian('roe') == null ? undefined : `peer median ${percent(peerMedian('roe')! * 100)}` },
            { label: 'Analyst upside', value: analystUpside == null ? '—' : percent(analystUpside), sub: finite(target.target_mean_price) == null ? undefined : `target ${money(target.target_mean_price)}` },
            { label: 'Peer set', value: String(peers.length), sub: plain(data.sector) },
          ]), source, ticker, ticker),
        ]
        const multipleRows = [
          { metric: 'P/E', subject: finite(target.pe), median: peerMedian('pe') },
          { metric: 'EV / EBITDA', subject: finite(target.ev_ebitda), median: peerMedian('ev_ebitda') },
          { metric: 'P/S', subject: finite(target.ps), median: peerMedian('ps') },
          { metric: 'P/FCF', subject: finite(target.pfcf), median: peerMedian('pfcf') },
        ].filter(row => row.subject != null || row.median != null)
        if (multipleRows.length) {
          clips.push(tagClip(chartClip(
            'Peer Comparison',
            `${ticker} multiples vs peer median`,
            'bar',
            'metric',
            multipleRows,
            [{ key: 'subject', label: ticker }, { key: 'median', label: 'Peer median' }],
          ), source, `${ticker}:multiples-visual`, ticker))
        }
        const qualityRows = [
          { metric: 'ROE', subject: finite(target.roe) == null ? null : finite(target.roe)! * 100, median: peerMedian('roe') == null ? null : peerMedian('roe')! * 100 },
          { metric: 'Revenue growth', subject: finite(target.revenue_growth) == null ? null : finite(target.revenue_growth)! * 100, median: peerMedian('revenue_growth') == null ? null : peerMedian('revenue_growth')! * 100 },
        ].filter(row => row.subject != null || row.median != null)
        if (qualityRows.length) {
          clips.push(tagClip(chartClip(
            'Peer Comparison',
            `${ticker} operating quality vs peers`,
            'bar',
            'metric',
            qualityRows,
            [{ key: 'subject', label: ticker }, { key: 'median', label: 'Peer median' }],
          ), source, `${ticker}:quality-visual`, ticker))
        }
        const targetRows = peers
          .map(peer => {
            const price = finite(peer.price)
            const targetPrice = finite(peer.target_mean_price)
            return {
              ticker: plain(peer.ticker),
              upside: price != null && price > 0 && targetPrice != null ? ((targetPrice / price) - 1) * 100 : null,
            }
          })
          .filter(row => row.upside != null)
        if (targetRows.length) {
          clips.push(tagClip(chartClip(
            'Peer Comparison',
            'Consensus upside across the peer set',
            'bar',
            'ticker',
            targetRows,
            [{ key: 'upside', label: 'Consensus upside %' }],
          ), source, `${ticker}:consensus-visual`, ticker))
        }
        clips.push(tagClip(tableClip(
          'Peer Comparison',
          `${ticker} peer evidence`,
          ['Ticker', 'P/E', 'EV/EBITDA', 'P/S', 'ROE %', 'Rev growth %', 'Target'],
          peers.slice(0, 9).map(peer => [
            plain(peer.ticker),
            finite(peer.pe),
            finite(peer.ev_ebitda),
            finite(peer.ps),
            finite(peer.roe) == null ? null : +(finite(peer.roe)! * 100).toFixed(1),
            finite(peer.revenue_growth) == null ? null : +(finite(peer.revenue_growth)! * 100).toFixed(1),
            finite(peer.target_mean_price),
          ]),
        ), source, `${ticker}:table`, ticker))
        return clips
      })

    case 'dcf-valuation':
      return perTicker(source, async ticker => {
        const fundamentals = record(await client.get(`/api/dcf/fundamentals?ticker=${encodeURIComponent(ticker)}`))
        const revenue = finite(fundamentals.revenue)
        const shares = finite(fundamentals.shares)
        if (revenue == null || revenue <= 0 || shares == null || shares <= 0) return null
        const currentMargin = finite(fundamentals.op_margin) ?? 15
        const baseGrowth = clamp(finite(fundamentals.rev_growth) ?? 10, -20, 40)
        let suggested: Record<string, any> = {}
        try {
          suggested = record(await client.post('/api/ai/dcf-assumptions', {
            ticker,
            revenue,
            op_margin: currentMargin,
            rev_growth: baseGrowth,
            beta: finite(fundamentals.beta) ?? 1,
            sector: plain(fundamentals.sector) === '—' ? '' : plain(fundamentals.sector),
            wacc: 10,
          }))
        } catch {
          suggested = {}
        }
        const growth1 = clamp(finite(suggested.rev_growth_1) ?? baseGrowth, -20, 50)
        const growth2 = clamp(finite(suggested.rev_growth_2) ?? growth1 * 0.6, -10, 35)
        const growth3 = clamp(finite(suggested.rev_growth_3) ?? growth1 * 0.3, -5, 20)
        const targetMargin = clamp(finite(suggested.target_margin) ?? Math.max(currentMargin, 10), -30, 60)
        const terminalGrowth = clamp(finite(suggested.terminal_growth) ?? 2.5, 0, 5)
        const wacc = clamp(finite(suggested.wacc) ?? 10, terminalGrowth + 1, 25)
        const capexPct = clamp(finite(fundamentals.capex_pct) ?? 5, 0, 30)
        const daPct = clamp(finite(fundamentals.da_pct) ?? 4, 0, 30)
        const wcPct = clamp(finite(fundamentals.wc_pct) ?? 0.5, -10, 20)
        const request = {
          ticker,
          revenue,
          op_margin: currentMargin,
          target_margin: targetMargin,
          shares,
          net_debt: finite(fundamentals.net_debt) ?? 0,
          tax_rate: clamp(finite(fundamentals.tax_rate) ?? 21, 0, 50),
          stages: [
            { years: 3, growth: growth1 },
            { years: 4, growth: growth2 },
            { years: 3, growth: growth3 },
          ],
          capex: { start_pct: capexPct, end_pct: capexPct },
          da: { start_pct: daPct, end_pct: daPct },
          wc: { start_pct: wcPct, end_pct: wcPct * 0.5 },
          terminal_growth: terminalGrowth,
          wacc,
          beta: finite(fundamentals.beta) ?? undefined,
          de_ratio: finite(fundamentals.de_ratio) ?? undefined,
        }
        const data = record(await client.post('/api/dcf/value', request))
        const intrinsic = finite(data.intrinsic_per_share)
        if (intrinsic == null) return null
        const marketPrice = finite(fundamentals.market_price)
        const upside = marketPrice != null && marketPrice > 0 ? ((intrinsic / marketPrice) - 1) * 100 : null
        const fcfs = array(data.fcfs).map(record)
        const clips: ClipDraft[] = [
          tagClip(kpiClip('DCF Valuation', `DCF verdict · ${ticker}`, [
            { label: 'Intrinsic / share', value: money(intrinsic) },
            { label: 'Market price', value: money(marketPrice) },
            { label: 'Upside to intrinsic', value: upside == null ? '—' : percent(upside) },
            { label: 'Enterprise value', value: moneyMillions(data.enterprise_value) },
            { label: 'PV of explicit FCF', value: moneyMillions(data.pv_fcfs) },
            { label: 'Terminal value', value: moneyMillions(data.terminal_value) },
          ]), source, ticker, ticker),
        ]
        if (fcfs.length) {
          clips.push(tagClip(chartClip(
            'DCF Valuation',
            `${ticker} revenue projection`,
            'bar',
            'year',
            fcfs.map(row => ({ year: `Y${plain(row.year)}`, revenue: finite(row.revenue) })),
            [{ key: 'revenue', label: 'Revenue ($M)' }],
          ), source, `${ticker}:revenue-visual`, ticker))
          clips.push(tagClip(chartClip(
            'DCF Valuation',
            `${ticker} free cash flow projection`,
            'line',
            'year',
            fcfs.map(row => ({ year: `Y${plain(row.year)}`, fcf: finite(row.fcf), presentValue: finite(row.pv_fcf) })),
            [{ key: 'fcf', label: 'Free cash flow ($M)' }, { key: 'presentValue', label: 'PV of FCF ($M)' }],
          ), source, `${ticker}:fcf-visual`, ticker))
        }
        const sensitivity = array(data.tornado).map(record)
        if (sensitivity.length) {
          clips.push(tagClip(chartClip(
            'DCF Valuation',
            `${ticker} value-driver sensitivity`,
            'bar',
            'driver',
            sensitivity.map(row => ({
              driver: plain(row.label),
              low: finite(row.lo),
              base: intrinsic,
              high: finite(row.hi),
            })),
            [
              { key: 'low', label: 'Low $/share' },
              { key: 'base', label: 'Base $/share' },
              { key: 'high', label: 'High $/share' },
            ],
          ), source, `${ticker}:sensitivity-visual`, ticker))
        }
        clips.push(tagClip(kpiClip('DCF Valuation', `Model assumptions · ${ticker}`, [
          { label: 'WACC', value: `${wacc.toFixed(1)}%`, sub: 'AI-assisted assumption' },
          { label: 'Terminal growth', value: `${terminalGrowth.toFixed(1)}%`, sub: 'AI-assisted assumption' },
          { label: 'Target margin', value: `${targetMargin.toFixed(1)}%`, sub: `current ${currentMargin.toFixed(1)}%` },
          { label: 'Years 1–3 growth', value: `${growth1.toFixed(1)}%` },
          { label: 'Years 4–7 growth', value: `${growth2.toFixed(1)}%` },
          { label: 'Years 8–10 growth', value: `${growth3.toFixed(1)}%` },
        ]), source, `${ticker}:assumptions`, ticker))
        return clips
      })

    case 'price-history':
      return perTicker(source, async ticker => {
        const range = lookbackRange(scope)
        const data = record(await client.get(
          `/api/market/history?ticker=${encodeURIComponent(ticker)}&start=${range.start}&end=${range.end}`,
        ))
        const rows = thin(array(data.price).map(point => ({
          date: plain(record(point).date),
          price: finite(record(point).value),
        })).filter(point => point.price != null))
        if (!rows.length) return null
        const metrics = record(data.metrics)
        const clip = chartClip('Chart Studio', `${ticker} price history`, 'line', 'date', rows, [
          { key: 'price', label: ticker },
        ])
        clip.payload.title = `${ticker} price history · ${percent(metrics.total_return)} return · ${percent(metrics.max_drawdown)} max drawdown`
        return tagClip(clip, source, ticker, ticker)
      })

    case 'market-compare': {
      const period = comparePeriod(scope)
      const data = record(await client.get(`/api/market/compare?tickers=${encodeURIComponent(source.targets.join(','))}&period=${period}&normalize=indexed`))
      const rows = thin(array(data.series).map(row => record(row)))
      if (!rows.length) return []
      const tickers = array(data.tickers).map(String)
      return [tagClip(chartClip(
        'Compare',
        `Relative performance · ${period.toUpperCase()}`,
        'line',
        'date',
        rows,
        tickers.map(ticker => ({ key: ticker, label: ticker })),
      ), source, source.targets.join('-'))]
    }

    case 'mover':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/movers/explain?ticker=${encodeURIComponent(ticker)}&timeframe=1d`))
        if (!data.available) return null
        const price = record(data.price)
        const narrative = record(data.narrative)
        const evidence = array(data.evidence).slice(0, 6)
        const lines = [
          `${ticker} move: ${percent(price.pct_move, 2)}. Verdict: ${plain(data.verdict).replace(/_/g, ' ')}.`,
          narrative.summary ? String(narrative.summary) : '',
          ...evidence.map(item => {
            const row = record(item)
            return `${plain(row.source)}: ${plain(row.headline)}`
          }),
        ].filter(Boolean)
        return tagClip(textClip('Mover Radar', `${ticker} catalyst scan`, lines.join('\n')), source, ticker, ticker)
      })

    case 'news':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/market/news?ticker=${encodeURIComponent(ticker)}`))
        const rows = array(data.news).slice(0, 10).map(item => {
          const row = record(item)
          const content = record(row.content)
          const provider = record(content.provider)
          const publishedRaw = content.pubDate ?? row.pubDate ?? row.providerPublishTime ?? row.published_at ?? row.date
          const publishedNumber = finite(publishedRaw)
          const published = publishedNumber != null && publishedNumber > 1e9
            ? new Date(publishedNumber > 1e12 ? publishedNumber : publishedNumber * 1000)
            : new Date(String(publishedRaw ?? ''))
          const date = Number.isNaN(published.getTime()) ? '—' : published.toISOString().slice(0, 10)
          return [
            date,
            plain(provider.displayName ?? row.publisher ?? row.source),
            plain(content.title ?? row.title ?? row.headline),
          ]
        }).filter(row => row[2] !== '—')
        if (!rows.length) return null
        return tagClip(tableClip('Market News', `${ticker} recent news`, ['Date', 'Source', 'Headline'], rows), source, ticker, ticker)
      })

    case 'options':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/options/snapshot?ticker=${encodeURIComponent(ticker)}`))
        const clips = [tagClip(kpiClip('Options Desk', `${ticker} options snapshot`, [
          { label: 'Spot', value: money(data.spot) },
          { label: 'ATM IV', value: finite(data.atm_iv) == null ? '—' : `${finite(data.atm_iv)!.toFixed(1)}%` },
          { label: '30D HV', value: finite(data.hv_30) == null ? '—' : `${finite(data.hv_30)!.toFixed(1)}%` },
          { label: 'IV / HV', value: finite(data.iv_vs_hv) == null ? '—' : `${finite(data.iv_vs_hv)!.toFixed(2)}x` },
          { label: 'Implied move', value: finite(data.implied_move) == null ? '—' : `${finite(data.implied_move)!.toFixed(1)}%`, sub: plain(data.expiry) },
          { label: 'Put / call vol', value: finite(data.pc_vol) == null ? '—' : finite(data.pc_vol)!.toFixed(2) },
        ]), source, ticker, ticker)]
        const atmIv = finite(data.atm_iv)
        const realized = finite(data.hv_30)
        if (atmIv != null || realized != null) {
          clips.push(tagClip(chartClip(
            'Options Desk',
            `${ticker} implied vs realized volatility`,
            'bar',
            'measure',
            [
              { measure: 'ATM IV', volatility: atmIv },
              { measure: '30D realized', volatility: realized },
            ],
            [{ key: 'volatility', label: 'Volatility %' }],
          ), source, `${ticker}:volatility-visual`, ticker))
        }
        return clips
      })

    case 'volatility-skew':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/prob/skew?ticker=${encodeURIComponent(ticker)}`))
        const terms = array(data.term_structure).map(record)
        const front = terms.find(term => plain(term.expiry) === plain(data.front_expiry)) ?? terms[0]
        if (!front) return null
        const spot = finite(data.spot)
        const atmIv = finite(front.atm_iv)
        const dte = finite(front.dte)
        const impliedMove = spot != null && atmIv != null && dte != null
          ? (atmIv / 100) * Math.sqrt(Math.max(dte, 0) / 365) * 100
          : null
        const clips: ClipDraft[] = [
          tagClip(kpiClip('Volatility Skew', `Skew pulse · ${ticker}`, [
            { label: 'ATM IV', value: atmIv == null ? '—' : `${atmIv.toFixed(1)}%`, sub: plain(front.expiry) },
            { label: '25Δ risk reversal', value: finite(front.rr_25) == null ? '—' : finite(front.rr_25)!.toFixed(1), sub: 'positive = puts richer' },
            { label: '25Δ butterfly', value: finite(front.bf_25) == null ? '—' : finite(front.bf_25)!.toFixed(1) },
            { label: 'Implied move', value: impliedMove == null ? '—' : `±${impliedMove.toFixed(1)}%`, sub: dte == null ? undefined : `${dte.toFixed(0)} days` },
            { label: 'Term slope', value: finite(data.ts_slope) == null ? '—' : finite(data.ts_slope)!.toFixed(1) },
            { label: 'Spot', value: money(spot) },
          ]), source, ticker, ticker),
        ]
        const smile = array(front.smile).map(record)
        if (smile.length) {
          clips.push(tagClip(chartClip(
            'Volatility Skew',
            `${ticker} implied-volatility smile · ${plain(front.expiry)}`,
            'area',
            'moneyness',
            smile.map(point => ({ moneyness: finite(point.moneyness), iv: finite(point.iv) })),
            [{ key: 'iv', label: 'Implied volatility %' }],
          ), source, `${ticker}:smile-visual`, ticker))
        }
        if (terms.length) {
          clips.push(tagClip(chartClip(
            'Volatility Skew',
            `${ticker} volatility term structure`,
            'line',
            'dte',
            terms.map(term => ({ dte: finite(term.dte), atmIv: finite(term.atm_iv), downsideSkew: finite(term.rr_25) })),
            [{ key: 'atmIv', label: 'ATM IV %' }, { key: 'downsideSkew', label: '25Δ put skew' }],
          ), source, `${ticker}:term-visual`, ticker))
        }
        return clips
      })

    case 'dealer-gex':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/options/gex?ticker=${encodeURIComponent(ticker)}`))
        const spot = finite(data.spot)
        const profile = array(data.data).map(record)
          .filter(row => {
            const strike = finite(row.strike)
            return strike != null && (spot == null || (strike >= spot * 0.72 && strike <= spot * 1.28))
          })
        if (!profile.length && spot == null) return null
        const clips: ClipDraft[] = [
          tagClip(kpiClip('Dealer GEX', `Dealer gamma · ${ticker}`, [
            { label: 'Spot', value: money(spot) },
            { label: 'Gamma flip', value: money(data.flip), sub: 'nearest net-GEX sign change' },
            { label: 'Net GEX', value: finite(data.total_net_gex) == null ? '—' : `$${finite(data.total_net_gex)!.toFixed(1)}M` },
            { label: 'Max positive', value: money(record(data.max_positive_gex).strike), sub: finite(record(data.max_positive_gex).gex_m) == null ? undefined : `$${finite(record(data.max_positive_gex).gex_m)!.toFixed(1)}M` },
            { label: 'Max negative', value: money(record(data.max_negative_gex).strike), sub: finite(record(data.max_negative_gex).gex_m) == null ? undefined : `$${finite(record(data.max_negative_gex).gex_m)!.toFixed(1)}M` },
            { label: 'Data', value: data.delayed ? 'Delayed' : 'Current', sub: plain(data.source) },
          ]), source, ticker, ticker),
        ]
        if (profile.length) {
          const rows = thin(profile, 70).map(row => ({
            strike: finite(row.strike),
            netGex: finite(row.net_gex),
          }))
          clips.push(tagClip(chartClip(
            'Dealer GEX',
            `${ticker} net gamma by strike`,
            'bar',
            'strike',
            rows,
            [{ key: 'netGex', label: 'Net GEX ($M)' }],
          ), source, `${ticker}:net-gex-visual`, ticker))
          clips.push(tagClip(chartClip(
            'Dealer GEX',
            `${ticker} call and put gamma`,
            'bar',
            'strike',
            thin(profile, 55).map(row => ({
              strike: finite(row.strike),
              callGex: finite(row.call_gex),
              putGex: finite(row.put_gex),
            })),
            [{ key: 'callGex', label: 'Call GEX ($M)' }, { key: 'putGex', label: 'Put GEX ($M)' }],
          ), source, `${ticker}:call-put-visual`, ticker))
        }
        return clips
      })

    case 'implied-probability':
      return perTicker(source, async ticker => {
        let expiry = ''
        try {
          const snapshot = record(await client.get(`/api/options/snapshot?ticker=${encodeURIComponent(ticker)}`))
          expiry = plain(snapshot.expiry) === '—' ? '' : plain(snapshot.expiry)
        } catch {
          expiry = ''
        }
        if (!expiry) {
          const fallback = new Date()
          fallback.setUTCDate(fallback.getUTCDate() + 30)
          expiry = fallback.toISOString().slice(0, 10)
        }
        let cone: Record<string, any> = {}
        let distribution: Record<string, any> = {}
        try {
          cone = record(await client.post('/api/prob/cone', { ticker, expiry }))
        } catch {
          cone = {}
        }
        try {
          distribution = record(await client.get(`/api/prob/chain-distribution?ticker=${encodeURIComponent(ticker)}&expiry=${encodeURIComponent(expiry)}`))
        } catch {
          distribution = {}
        }
        const coneRows = array(cone.cone).map(record)
        const density = array(distribution.density).map(record)
        if (!coneRows.length && !density.length) return null
        const clips: ClipDraft[] = [
          tagClip(kpiClip('Implied Probability', `Options-implied distribution · ${ticker}`, [
            { label: 'Spot', value: money(cone.S0) },
            { label: 'ATM IV', value: finite(cone.sigma) == null ? '—' : `${(finite(cone.sigma)! * 100).toFixed(1)}%` },
            { label: 'Modal strike', value: money(distribution.modal_strike) },
            { label: 'P10', value: money(distribution.p10) },
            { label: 'Median', value: money(distribution.p50), sub: `expiry ${plain(distribution.expiry ?? expiry)}` },
            { label: 'P90', value: money(distribution.p90) },
          ]), source, ticker, ticker),
        ]
        if (coneRows.length) {
          clips.push(tagClip(chartClip(
            'Implied Probability',
            `${ticker} risk-neutral price cone`,
            'area',
            'date',
            thin(coneRows.map(row => ({
              date: plain(row.date),
              upper: finite(row.upper),
              median: finite(row.median),
              lower: finite(row.lower),
            })), 100),
            [
              { key: 'upper', label: '~85th percentile' },
              { key: 'median', label: 'Median' },
              { key: 'lower', label: '~15th percentile' },
            ],
          ), source, `${ticker}:cone-visual`, ticker))
        }
        if (density.length) {
          clips.push(tagClip(chartClip(
            'Implied Probability',
            `${ticker} terminal probability density`,
            'area',
            'strike',
            thin(density.map(row => ({ strike: finite(row.strike), density: finite(row.density) == null ? null : finite(row.density)! * 100 })), 100),
            [{ key: 'density', label: 'Probability density %' }],
          ), source, `${ticker}:density-visual`, ticker))
        }
        const curve = array(distribution.delta_curve).map(record)
        if (curve.length) {
          clips.push(tagClip(chartClip(
            'Implied Probability',
            `${ticker} probability of finishing above strike`,
            'line',
            'strike',
            thin(curve.map(row => ({ strike: finite(row.strike), probability: finite(row.delta) == null ? null : finite(row.delta)! * 100 })), 100),
            [{ key: 'probability', label: 'Finish-above probability %' }],
          ), source, `${ticker}:finish-above-visual`, ticker))
        }
        return clips
      })

    case 'earnings': {
      if (!source.targets.length) return []
      const range = lookforwardRange(scope)
      const totalDays = inclusiveDays(range)
      const first = validDate(range.start)!
      const requests: Promise<unknown>[] = []
      for (let offset = 0; offset < totalDays; offset += 14) {
        const start = new Date(first)
        start.setUTCDate(start.getUTCDate() + offset)
        requests.push(client.get(
          `/api/earnings/calendar?date=${isoDate(start)}&days=${Math.min(14, totalDays - offset)}`,
        ))
      }
      const responses = await Promise.all(requests)
      const targets = new Set(source.targets)
      const rows = responses.flatMap(data => array(record(data).rows))
        .filter(row => targets.has(normalizeTicker(plain(record(row).symbol))))
        .map(row => {
          const item = record(row)
          return [plain(item.symbol), plain(item.date), plain(item.hour), finite(item.epsEstimate)]
        })
      const horizon = `${range.start} to ${range.end}`
      if (!rows.length) {
        return [tagClip(textClip(
          'Earnings Scanner',
          `Upcoming earnings · ${horizon}`,
          `No scheduled earnings were found for ${source.targets.join(', ')} from ${range.start} through ${range.end}.`,
        ), source, source.targets.join('-'))]
      }
      return [tagClip(tableClip(
        'Earnings Scanner',
        `Upcoming earnings · ${horizon}`,
        ['Ticker', 'Date', 'Session', 'EPS estimate'],
        rows,
      ), source, source.targets.join('-'))]
    }

    case 'global-markets': {
      const data = record(await client.get('/api/market/global-board?window=1d'))
      const rows = array(data.sections).flatMap(section => {
        const group = record(section)
        return array(group.rows).map(item => {
          const row = record(item)
          return [plain(group.name), plain(row.label), finite(row.price), finite(row.change_pct), plain(row.status)]
        })
      }).slice(0, 40)
      if (!rows.length) return []
      const clips = [tagClip(tableClip(
        'Global Markets',
        `Cross-asset board${data.as_of ? ` · ${String(data.as_of).slice(0, 16)}` : ''}`,
        ['Group', 'Instrument', 'Last', 'Change %', 'Status'],
        rows,
      ), source, 'board')]
      const movers = rows
        .filter(row => typeof row[3] === 'number')
        .sort((a, b) => Math.abs(Number(b[3])) - Math.abs(Number(a[3])))
        .slice(0, 12)
        .map(row => ({ instrument: String(row[1]), change: Number(row[3]) }))
      if (movers.length) {
        clips.push(tagClip(chartClip(
          'Global Markets',
          'Largest cross-asset moves',
          'bar',
          'instrument',
          movers,
          [{ key: 'change', label: 'Change %' }],
        ), source, 'moves-visual'))
      }
      return clips
    }

    case 'macro-events': {
      const data = record(await client.get('/api/macro-events'))
      const rows = array(data.events).slice(0, 24).map(item => {
        const row = record(item)
        return [plain(row.datetime), plain(row.name), plain(row.impact), plain(row.category), plain(row.region)]
      })
      if (!rows.length) return []
      return [tagClip(tableClip(
        'Macro Event Hub',
        'Upcoming macro events',
        ['Date and time', 'Event', 'Impact', 'Category', 'Region'],
        rows,
      ), source, 'calendar')]
    }

    case 'sentiment': {
      const data = record(await client.get('/api/sentiment/snapshot?timeframe_hours=24'))
      if (finite(data.composite_score) == null) return []
      const clips = [tagClip(kpiClip('Sentiment Tracker', 'Market sentiment · 24 hours', [
        { label: 'Composite', value: finite(data.composite_score)!.toFixed(0), sub: plain(data.label) },
        { label: 'Forward', value: finite(data.forward_composite) == null ? '—' : finite(data.forward_composite)!.toFixed(0), sub: `${finite(data.forward_count) ?? 0} articles` },
        { label: 'Backward', value: finite(data.backward_composite) == null ? '—' : finite(data.backward_composite)!.toFixed(0), sub: `${finite(data.backward_count) ?? 0} articles` },
        { label: 'Bull', value: finite(data.bull_pct) == null ? '—' : `${finite(data.bull_pct)!.toFixed(0)}%` },
        { label: 'Bear', value: finite(data.bear_pct) == null ? '—' : `${finite(data.bear_pct)!.toFixed(0)}%` },
        { label: 'Headlines', value: plain(data.in_window_count) },
      ]), source, '24h')]
      const bull = finite(data.bull_pct)
      const bear = finite(data.bear_pct)
      if (bull != null || bear != null) {
        clips.push(tagClip(chartClip(
          'Sentiment Tracker',
          'Headline sentiment split · 24 hours',
          'bar',
          'stance',
          [
            { stance: 'Bullish', share: bull },
            { stance: 'Bearish', share: bear },
          ],
          [{ key: 'share', label: 'Share %' }],
        ), source, 'split-visual'))
      }
      return clips
    }

    case 'sector-rotation': {
      const data = record(await client.get('/api/market/sector-rotation'))
      const rows = array(data.sectors)
        .sort((a, b) => (finite(record(b).returns?.['1M']) ?? -Infinity) - (finite(record(a).returns?.['1M']) ?? -Infinity))
        .map(item => {
          const row = record(item)
          return [
            plain(row.ticker),
            plain(row.name),
            finite(record(row.returns)['1W']),
            finite(record(row.returns)['1M']),
            finite(record(row.returns)['3M']),
            finite(record(row.rel_strength)['1M']),
            finite(row.momentum),
          ]
        })
      if (!rows.length) return []
      const momentumData = rows
        .map(row => ({
          sector: `${String(row[1])} · ${String(row[0])}`,
          momentum: typeof row[6] === 'number' ? row[6] : null,
          oneWeek: typeof row[2] === 'number' ? row[2] : null,
          oneMonth: typeof row[3] === 'number' ? row[3] : null,
          threeMonth: typeof row[4] === 'number' ? row[4] : null,
          vsSpyOneMonth: typeof row[5] === 'number' ? row[5] : null,
        }))
        .sort((a, b) => (b.momentum ?? -Infinity) - (a.momentum ?? -Infinity))
      return [
        tagClip(tableClip(
        'Sector Rotation',
        `Sector leadership${data.as_of ? ` · ${data.as_of}` : ''}`,
        ['Ticker', 'Sector', '1W %', '1M %', '3M %', 'vs SPY 1M', 'Momentum'],
        rows,
        ), source, 'rotation'),
        tagClip(chartClip(
          'Sector Rotation',
          `Sector leadership · momentum ranking${data.as_of ? ` · ${data.as_of}` : ''}`,
          'bar',
          'sector',
          momentumData,
          [{ key: 'momentum', label: 'Momentum score (pp)' }],
          {
            barOrientation: 'horizontal',
            details: [
              { key: 'oneWeek', label: '1W return %' },
              { key: 'oneMonth', label: '1M return %' },
              { key: 'threeMonth', label: '3M return %' },
              { key: 'vsSpyOneMonth', label: 'Vs SPY · 1M %' },
            ],
          },
        ), source, 'rotation-visual'),
      ]
    }

    case 'regression': {
      if (source.targets.length < 2) return []
      const dependent = source.targets[0]
      const independent = source.targets.slice(1, 5)
      const data = record(await client.post('/api/regression/analyze', {
        y_ticker: dependent,
        x_tickers: independent,
        period: correlationPeriod(scope),
        model_type: 'linear',
        degree: 1,
        use_returns: true,
        include_chart: true,
      }))
      if (finite(data.r_squared) == null) return []
      const features = array(data.feature_names).map(String)
      const coefficients = array(data.coefficients)
      const pValues = array(data.p_values)
      const clips: ClipDraft[] = [
        tagClip(kpiClip('Regression', `${dependent} return model`, [
          { label: 'R²', value: finite(data.r_squared)!.toFixed(3), sub: finite(data.adj_r_squared) == null ? undefined : `adjusted ${finite(data.adj_r_squared)!.toFixed(3)}` },
          { label: 'Observations', value: plain(data.observations) },
          { label: 'Model error', value: finite(data.mse) == null ? '—' : finite(data.mse)!.toExponential(2), sub: 'mean squared error' },
          { label: 'Intercept', value: finite(data.intercept) == null ? '—' : finite(data.intercept)!.toFixed(5), sub: finite(data.intercept_p) == null ? undefined : `p ${finite(data.intercept_p)!.toFixed(3)}` },
          ...features.slice(0, 2).map((feature, index) => ({
            label: `Beta · ${feature}`,
            value: finite(coefficients[index]) == null ? '—' : finite(coefficients[index])!.toFixed(3),
            sub: finite(pValues[index]) == null ? undefined : `p ${finite(pValues[index])!.toFixed(3)}`,
          })),
        ]), source, source.targets.join('-')),
      ]
      if (features.length) {
        clips.push(tagClip(tableClip(
          'Regression',
          `${dependent} model coefficients`,
          ['Feature', 'Coefficient', 'p-value', 'Significant at 5%'],
          features.map((feature, index) => [
            feature,
            finite(coefficients[index]),
            finite(pValues[index]),
            finite(pValues[index]) != null ? (finite(pValues[index])! < 0.05 ? 'Yes' : 'No') : '—',
          ]),
        ), source, `${source.targets.join('-')}:coefficients`))
      }
      const modelData = record(data.data)
      const dates = array(modelData.dates)
      const actual = array(modelData.y)
      const fitted = array(modelData.y_pred)
      if (actual.length && fitted.length) {
        clips.push(tagClip(chartClip(
          'Regression',
          `${dependent} actual vs fitted returns`,
          'line',
          'date',
          thin(actual.map((value, index) => ({
            date: plain(dates[index] ?? index + 1),
            actual: finite(value),
            fitted: finite(fitted[index]),
          })), 120),
          [{ key: 'actual', label: `${dependent} actual` }, { key: 'fitted', label: 'Model fitted' }],
        ), source, `${source.targets.join('-')}:fit-visual`))
      }
      const residuals = array(data.residuals)
      if (residuals.length) {
        clips.push(tagClip(chartClip(
          'Regression',
          `${dependent} model residuals`,
          'bar',
          'date',
          thin(residuals.map((value, index) => ({
            date: plain(dates[index] ?? index + 1),
            residual: finite(value),
          })), 80),
          [{ key: 'residual', label: 'Residual' }],
        ), source, `${source.targets.join('-')}:residuals-visual`))
      }
      return clips
    }

    case 'correlation': {
      if (source.targets.length < 2) return []
      const period = correlationPeriod(scope)
      const rollingWindow = Math.max(5, Math.min(60, Math.floor(inclusiveDays(lookbackRange(scope)) / 2)))
      const data = record(await client.post('/api/regression/correlation', {
        tickers: source.targets,
        period,
        use_returns: true,
        benchmark: 'SPY',
        rolling_window: rollingWindow,
        pair: source.targets.slice(0, 2),
      }))
      const summary = record(data.summary)
      const strongest = record(summary.strongest_pair)
      const negative = record(summary.most_negative_pair)
      const clips: ClipDraft[] = [
        tagClip(kpiClip('Correlation', 'Correlation structure', [
          { label: 'Avg |correlation|', value: finite(summary.avg_abs_correlation)?.toFixed(3) ?? '—' },
          { label: 'Strongest pair', value: finite(strongest.value)?.toFixed(2) ?? '—', sub: [strongest.a, strongest.b].filter(Boolean).join(' ↔ ') },
          { label: 'Most negative', value: finite(negative.value)?.toFixed(2) ?? '—', sub: [negative.a, negative.b].filter(Boolean).join(' ↔ ') },
          { label: 'Observations', value: plain(data.observations), sub: period },
        ]), source, `${source.targets.join('-')}:summary`),
      ]
      const tickers = array(data.tickers).map(String)
      const matrix = array(data.matrix)
      if (tickers.length && matrix.length) {
        const lookup = new Map(matrix.map(item => {
          const row = record(item)
          return [`${row.row}|${row.col}`, finite(row.value)]
        }))
        clips.push(tagClip(tableClip(
          'Correlation',
          'Correlation matrix',
          ['', ...tickers],
          tickers.map(rowTicker => [
            rowTicker,
            ...tickers.map(columnTicker => lookup.get(`${rowTicker}|${columnTicker}`) ?? null),
          ]),
        ), source, `${source.targets.join('-')}:matrix`))
      }
      const pairs = array(data.pairs).map(record).slice(0, 16)
      if (pairs.length) {
        clips.push(tagClip(chartClip(
          'Correlation',
          'Pair correlations',
          'bar',
          'pair',
          pairs.map(pair => ({
            pair: `${plain(pair.a)} ↔ ${plain(pair.b)}`,
            correlation: finite(pair.value),
          })),
          [{ key: 'correlation', label: 'Correlation' }],
        ), source, `${source.targets.join('-')}:pairs-visual`))
      }
      const betas = array(data.betas).map(record)
      if (betas.length) {
        clips.push(tagClip(chartClip(
          'Correlation',
          'Beta vs SPY',
          'bar',
          'ticker',
          betas.map(beta => ({ ticker: plain(beta.ticker), beta: finite(beta.beta) })),
          [{ key: 'beta', label: 'Beta' }],
        ), source, `${source.targets.join('-')}:beta-visual`))
      }
      const rolling = record(data.rolling)
      const dates = array(rolling.dates)
      const values = array(rolling.corr)
      if (dates.length && values.length) {
        const pair = array(rolling.pair).map(String)
        clips.push(tagClip(chartClip(
          'Correlation',
          `Rolling correlation · ${pair.join(' ↔ ')}`,
          'line',
          'date',
          thin(dates.map((date, index) => ({ date: String(date), correlation: finite(values[index]) })), 100),
          [{ key: 'correlation', label: `${plain(rolling.window)}-day correlation` }],
        ), source, `${source.targets.join('-')}:rolling`))
      }
      return clips
    }

    case 'factor-decomposition': {
      const holdings = scope.includePortfolio && portfolio.hasData
        ? portfolio.holdings
          .filter(holding => holding.ticker && holding.shares > 0)
          .map(holding => ({ ticker: normalizeTicker(holding.ticker), shares: holding.shares }))
        : source.targets.map(ticker => ({ ticker, weight: 100 / Math.max(1, source.targets.length) }))
      if (!holdings.length) return []
      const lookbackDays = Math.max(90, Math.min(14600, inclusiveDays(lookbackRange(scope))))
      const objective = `${scope.goal} ${scope.purpose} ${scope.mustInclude}`.toLowerCase()
      const mode = /\b(macro|rates?|credit|oil|dollar|economic)\b/.test(objective) ? 'macro'
        : /\b(style|size|value|momentum|fama|carhart)\b/.test(objective) ? 'style'
          : 'macro'
      const responses = await Promise.all([mode].map(async factorMode => ({
        mode: factorMode,
        data: record(await client.post('/api/portfolio/factor-decomposition', {
          holdings,
          lookback_days: lookbackDays,
          mode: factorMode,
          benchmark: 'SPY',
        })),
      })))
      const clips: ClipDraft[] = []
      for (const response of responses) {
        const data = response.data
        const factors = array(data.factors).map(record)
        clips.push(tagClip(kpiClip('Factor Decomposition', `Factor decomposition · ${response.mode}`, [
          { label: 'Annual volatility', value: percent(data.ann_vol_pct) },
          { label: 'Systematic', value: percent(data.systematic_pct) },
          { label: 'Idiosyncratic', value: percent(data.idiosyncratic_pct) },
          { label: 'Annual alpha', value: percent(data.alpha_ann_pct) },
          { label: 'Effective N', value: finite(record(data.concentration).effective_n)?.toFixed(1) ?? '—' },
          { label: 'Observations', value: plain(data.observations) },
        ]), source, `${response.mode}:summary`))
        if (factors.length) {
          clips.push(tagClip(chartClip(
            'Factor Decomposition',
            `${response.mode === 'macro' ? 'Macro' : 'Style'} factor betas`,
            'bar',
            'factor',
            factors.map(factor => ({ factor: plain(factor.factor), beta: finite(factor.beta) })),
            [{ key: 'beta', label: 'Beta' }],
          ), source, `${response.mode}:betas`))
        }
        const rolling = record(data.rolling)
        const rollingEntry = Object.entries(rolling).find(([, value]) => array(value).length)
        if (rollingEntry) {
          const [factor, points] = rollingEntry
          clips.push(tagClip(chartClip(
            'Factor Decomposition',
            `Rolling ${factor} exposure`,
            'line',
            'date',
            thin(array(points).map(point => ({
              date: plain(record(point).date),
              beta: finite(record(point).beta),
            })), 100),
            [{ key: 'beta', label: 'Beta' }],
          ), source, `${response.mode}:rolling-${factor}`))
        }
      }
      return clips
    }

    case 'credit-spreads': {
      const lookback = Math.max(90, inclusiveDays(lookbackRange(scope)))
      const data = record(await client.get(`/api/rates/credit-spreads?lookback=${lookback}`))
      const series = record(data.series)
      const entries = Object.entries(series).filter(([, value]) => Object.keys(record(value)).length)
      if (!entries.length) return []
      const clips: ClipDraft[] = [
        tagClip(kpiClip('Credit Spreads', 'Credit spread snapshot', entries.map(([key, value]) => {
          const item = record(value)
          return {
            label: plain(item.label ?? key),
            value: key === 'vix' ? finite(item.current)?.toFixed(2) ?? '—' : `${finite(item.current)?.toFixed(0) ?? '—'} bps`,
            sub: finite(item.change_1y) == null ? plain(item.benchmark) : `${finite(item.change_1y)! >= 0 ? '+' : ''}${finite(item.change_1y)!.toFixed(0)} vs 1Y`,
          }
        })), source, 'snapshot'),
      ]
      const dates = new Map<string, Record<string, string | number | null>>()
      for (const [key, value] of entries) {
        for (const rawPoint of array(record(value).history)) {
          const point = record(rawPoint)
          const date = plain(point.date)
          const row = dates.get(date) ?? { date }
          row[key] = finite(point.value)
          dates.set(date, row)
        }
      }
      const history = thin([...dates.values()].sort((a, b) => String(a.date).localeCompare(String(b.date))), 140)
      if (history.length) {
        clips.push(tagClip(chartClip(
          'Credit Spreads',
          'Credit spread history',
          'line',
          'date',
          history,
          entries.slice(0, 6).map(([key, value]) => ({ key, label: plain(record(value).label ?? key) })),
        ), source, 'history-visual'))
      }
      return clips
    }

    case 'rate-engine': {
      const [curveRaw, fedRaw] = await Promise.all([
        client.get('/api/rates/yield-curve'),
        client.get('/api/rates/fed-projections'),
      ])
      const curve = record(curveRaw)
      const fed = record(fedRaw)
      const meetings = array(fed.meetings).map(record)
      const clips: ClipDraft[] = []
      if (meetings.length) {
        clips.push(tagClip(chartClip(
          'Rate Engine',
          'Market-implied Fed funds path',
          'line',
          'date',
          meetings.map(meeting => ({ date: plain(meeting.date), rate: finite(meeting.rate) })),
          [{ key: 'rate', label: 'Implied rate %' }],
        ), source, 'fed-path-visual'))
        clips.push(tagClip(tableClip(
          'Rate Engine',
          'Meeting odds',
          ['Date', 'Implied rate', 'P(Hike)', 'P(Hold)', 'P(Cut)'],
          meetings.slice(0, 10).map(meeting => [
            plain(meeting.date),
            finite(meeting.rate),
            finite(meeting.prob_hike),
            finite(meeting.prob_hold),
            finite(meeting.prob_cut),
          ]),
        ), source, 'meeting-odds'))
      }
      const tenorOrder = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y']
      const todayCurve = record(curve.curve)
      const curveRows = tenorOrder
        .filter(tenor => finite(todayCurve[tenor]) != null)
        .map(tenor => ({
          tenor,
          today: finite(todayCurve[tenor]),
          '1D ago': finite(record(curve.curve_1d)[tenor]),
          '1M ago': finite(record(curve.curve_1m)[tenor]),
          '6M ago': finite(record(curve.curve_6m)[tenor]),
        }))
      if (curveRows.length) {
        clips.push(tagClip(chartClip(
          'Rate Engine',
          'US Treasury yield curve',
          'line',
          'tenor',
          curveRows,
          [
            { key: 'today', label: 'Today' },
            { key: '1D ago', label: '1D ago' },
            { key: '1M ago', label: '1M ago' },
            { key: '6M ago', label: '6M ago' },
          ],
        ), source, 'yield-curve-visual'))
      }
      return clips
    }

    case 'portfolio': {
      if (!portfolio.hasData) return []
      const total = portfolio.holdings.reduce((sum, holding) => sum + Math.max(0, holding.shares * holding.avgCost), 0) + portfolio.cashValue
      const rows = [...portfolio.holdings]
        .map(holding => {
          const value = Math.max(0, holding.shares * holding.avgCost)
          return [holding.ticker, holding.shares, money(holding.avgCost), money(value), total > 0 ? +((value / total) * 100).toFixed(2) : null]
        })
        .sort((a, b) => Number(b[4] ?? 0) - Number(a[4] ?? 0))
      if (portfolio.cashValue > 0) rows.push(['CASH', null, null, money(portfolio.cashValue), total > 0 ? +((portfolio.cashValue / total) * 100).toFixed(2) : null])
      return [tagClip(tableClip(
        'Portfolio Manager',
        `${portfolio.name} · saved positions`,
        ['Ticker', 'Shares', 'Cost basis', 'Saved value', 'Weight %'],
        rows,
      ), source, portfolio.id)]
    }

    case 'portfolio-risk': {
      if (!portfolio.holdings.length) return []
      const holdings = portfolio.holdings
        .map(holding => ({ ...holding, ticker: normalizeTicker(holding.ticker) }))
        .filter(holding => holding.ticker && holding.shares > 0)
      const quoteResponses = await Promise.all(
        Array.from({ length: Math.ceil(holdings.length / 50) }, (_, index) => holdings.slice(index * 50, (index + 1) * 50))
          .map(async batch => {
            try {
              return record(await client.get(`/api/alerts/quotes?tickers=${encodeURIComponent(batch.map(holding => holding.ticker).join(','))}`))
            } catch {
              return {}
            }
          }),
      )
      const quotes = Object.assign({}, ...quoteResponses)
      const priced = holdings
        .map(holding => {
          const current = finite(record(quotes[holding.ticker]).current_price)
          const mark = current ?? holding.avgCost
          return {
            ticker: holding.ticker,
            value: Math.max(0, holding.shares * mark),
            fallback: current == null,
          }
        })
        .filter(holding => holding.ticker && holding.value > 0)
        .sort((a, b) => b.value - a.value)
      const selected = priced.slice(0, 20)
      const fullEquity = priced.reduce((sum, holding) => sum + holding.value, 0)
      const fullTotal = fullEquity + portfolio.cashValue
      const selectedEquity = selected.reduce((sum, holding) => sum + holding.value, 0)
      const analysisTotal = selectedEquity + portfolio.cashValue
      if (!selected.length || analysisTotal <= 0 || fullTotal <= 0) return []
      const tickers = selected.map(holding => holding.ticker)
      const weights = selected.map(holding => holding.value / analysisTotal)
      const range = lookbackRange(scope)
      const fallbackTickers = selected.filter(holding => holding.fallback).map(holding => holding.ticker)
      const omittedCount = priced.length - selected.length
      const coverage = (analysisTotal / fullTotal) * 100
      const analysisName = omittedCount
        ? `${portfolio.name} · top ${selected.length} equity sleeve`
        : portfolio.name
      const horizon = `${range.start} to ${range.end}`
      const data = record(await client.post('/api/portfolio/compare', {
        portfolios: [
          { name: analysisName, tickers, weights, cash_weight: portfolio.cashValue / analysisTotal },
          { name: 'SPY', tickers: ['SPY'], weights: [1] },
        ],
        benchmark: 'SPY',
        start: range.start,
        end: range.end,
      }))
      const metric = record(array(data.metrics)[0])
      const series = record(array(data.series)[0])
      const clips: ClipDraft[] = [
        tagClip(kpiClip('Portfolio Compare', `${analysisName} risk metrics · ${horizon}`, [
          { label: 'CAGR', value: percent(metric.cagr) },
          { label: 'Volatility', value: percent(metric.vol) },
          { label: 'Sharpe', value: finite(metric.sharpe) == null ? '—' : finite(metric.sharpe)!.toFixed(2) },
          { label: 'Max drawdown', value: percent(metric.max_drawdown) },
          { label: 'Beta vs SPY', value: finite(metric.beta) == null ? '—' : finite(metric.beta)!.toFixed(2) },
          { label: 'Sortino', value: finite(metric.sortino) == null ? '—' : finite(metric.sortino)!.toFixed(2) },
          {
            label: 'Book coverage',
            value: `${coverage.toFixed(1)}%`,
            sub: omittedCount ? `${omittedCount} smaller position${omittedCount === 1 ? '' : 's'} omitted` : 'All eligible positions',
          },
          {
            label: 'Position marks',
            value: fallbackTickers.length ? `${fallbackTickers.length} fallback` : 'Live',
            sub: fallbackTickers.length ? `Saved cost: ${fallbackTickers.join(', ')}` : 'Current quotes',
          },
        ]), source, `${portfolio.id}:metrics`),
      ]
      const points = thin(array(series.points).map(point => ({
        date: plain(record(point).date),
        portfolio: finite(record(point).value),
      })).filter(point => point.portfolio != null))
      const benchmark = new Map(array(data.benchmark_points).map(point => [plain(record(point).date), finite(record(point).value)]))
      if (points.length) {
        clips.push(tagClip(chartClip(
          'Portfolio Compare',
          `${analysisName} vs SPY · ${horizon}`,
          'line',
          'date',
          points.map(point => ({ ...point, SPY: benchmark.get(point.date) ?? null })),
          [{ key: 'portfolio', label: analysisName }, { key: 'SPY', label: 'SPY' }],
        ), source, `${portfolio.id}:performance`))
      }
      return clips
    }
  }
}

const failureMessage = (error: unknown) => {
  const status = (error as { response?: { status?: number } })?.response?.status
  if (status === 404) return 'No usable data returned.'
  if (status === 429) return 'Source rate limit reached. Retry shortly.'
  if (status && status >= 500) return 'Source is temporarily unavailable.'
  return 'Research source did not complete.'
}

const PER_TICKER_SOURCES = new Set<ReportResearchSourceId>([
  'company',
  'price-history',
  'mover',
  'news',
  'options',
  'peer-valuation',
  'dcf-valuation',
  'volatility-skew',
  'dealer-gex',
  'implied-probability',
])

export async function collectReportResearch(
  plan: ReportResearchPlan,
  scope: ReportScope,
  portfolio: ActivePortfolioContext,
  onProgress?: (progress: ReportResearchProgress) => void,
  client: ResearchClient = DEFAULT_CLIENT,
): Promise<ReportResearchResult> {
  const bySource = new Map<ReportResearchSourceId, ClipDraft[]>()
  const completed: ReportResearchCompletion[] = []
  const failed: ReportResearchFailure[] = []

  await Promise.all(plan.sources.map(async source => {
    onProgress?.({ sourceId: source.id, status: 'running' })
    try {
      const clips = await runSource(source, scope, portfolio, client)
      const missingTargets = PER_TICKER_SOURCES.has(source.id)
        ? source.targets.filter(target => !clips.some(clip => clip.researchKey === `${source.id}:${target}`))
        : []
      missingTargets.forEach(target => failed.push({
        sourceId: source.id,
        label: source.label,
        target,
        researchKey: `${source.id}:${target}`,
        message: `No usable data returned for ${target}.`,
      }))
      if (!clips.length) {
        if (!missingTargets.length) throw new Error('empty source')
        onProgress?.({
          sourceId: source.id,
          status: 'failed',
          message: `${missingTargets.length} target${missingTargets.length === 1 ? '' : 's'} did not complete.`,
        })
        return
      }
      bySource.set(source.id, clips)
      completed.push({ sourceId: source.id, label: source.label, clipCount: clips.length })
      onProgress?.({
        sourceId: source.id,
        status: missingTargets.length ? 'partial' : 'complete',
        clipCount: clips.length,
        message: missingTargets.length
          ? `${missingTargets.length} target${missingTargets.length === 1 ? '' : 's'} did not complete.`
          : undefined,
      })
    } catch (error) {
      const message = failureMessage(error)
      failed.push({ sourceId: source.id, label: source.label, message })
      onProgress?.({ sourceId: source.id, status: 'failed', message })
    }
  }))

  const sourceOrder = new Map(plan.sources.map((source, index) => [source.id, index]))
  completed.sort((a, b) => (sourceOrder.get(a.sourceId) ?? 0) - (sourceOrder.get(b.sourceId) ?? 0))
  failed.sort((a, b) => {
    const sourceDelta = (sourceOrder.get(a.sourceId) ?? 0) - (sourceOrder.get(b.sourceId) ?? 0)
    if (sourceDelta) return sourceDelta
    const source = plan.sources.find(candidate => candidate.id === a.sourceId)
    return (source?.targets.indexOf(a.target ?? '') ?? 0) - (source?.targets.indexOf(b.target ?? '') ?? 0)
  })

  return {
    clips: plan.sources.flatMap(source => bySource.get(source.id) ?? []),
    completed,
    failed,
    finishedAt: new Date().toISOString(),
  }
}
