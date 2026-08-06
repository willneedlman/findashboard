import axios from 'axios'
import { chartClip, kpiClip, tableClip, textClip } from './reportCaptureRegistry'
import type { ActivePortfolioContext } from './pmImport'
import { smaArr, emaArr, rsiArr, hvArr, bollinger } from './indicators'
import { parseChartDirective } from './researchDirective'
import { normalizeTicker } from './pmImport'
import type { ClipDraft, ReportClip, ReportScope } from './reportCreator'

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
  /** Plain-English setup instruction from the planner ("chart it against SPY with
   * 50 and 200 day moving averages"). Resolved deterministically by the collector
   * against what the tool can actually do, so an unusable instruction degrades to
   * the default view rather than failing the source. */
  directive?: string
}

export interface ReportResearchPlan {
  objective: string
  intent: ReportResearchIntent
  symbols: string[]
  sources: ReportResearchSource[]
  blockedReason?: string
  aiEnhanced?: boolean
  aiSummary?: string
  objectivePlan?: ReportObjectivePlan
  requiredSourceIds?: ReportResearchSourceId[]
}

export interface ReportObjectivePlan {
  thesis: string
  requiredDataPoints: string[]
  requiredChecks: string[]
}

export interface ReportDataBankRun {
  sourceId: ReportResearchSourceId
  label: string
  status: 'complete' | 'partial' | 'failed'
  targets: string[]
  clipIds: string[]
  missingTargets: string[]
  error: string
}

export interface ReportDataBank {
  phase: 'complete'
  requiredSourceIds: ReportResearchSourceId[]
  runs: ReportDataBankRun[]
  objectivePlan: ReportObjectivePlan
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

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function withResearchRetry<T>(request: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request()
    } catch (error) {
      lastError = error
      const status = (error as { response?: { status?: number } })?.response?.status
      const retryable = status == null || status === 408 || status === 429 || status >= 500
      if (!retryable || attempt === 2) throw error
      await wait(350 * (2 ** attempt))
    }
  }
  throw lastError
}

const DEFAULT_CLIENT: ResearchClient = {
  get: url => withResearchRetry(async () => (await axios.get(url)).data),
  post: (url, body) => withResearchRetry(async () => (await axios.post(url, body)).data),
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await run(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapWithConcurrency(items, limit, async (item, index) => {
    try {
      return { status: 'fulfilled', value: await run(item, index) } as PromiseFulfilledResult<R>
    } catch (reason) {
      return { status: 'rejected', reason } as PromiseRejectedResult
    }
  })
}

const SOURCE_META: Record<ReportResearchSourceId, Omit<ReportResearchSource, 'reason' | 'targets'>> = {
  portfolio: { id: 'portfolio', label: 'Active book', tool: 'Portfolio Manager', route: '/portfolio-manager' },
  'portfolio-risk': { id: 'portfolio-risk', label: 'Risk and performance', tool: 'Portfolio Compare', route: '/portfolio-compare' },
  company: { id: 'company', label: 'Company snapshot', tool: 'Earnings Scanner', route: '/earnings' },
  'price-history': { id: 'price-history', label: 'Price and drawdown', tool: 'Chart Studio', route: '/chart-studio' },
  'market-compare': { id: 'market-compare', label: 'Relative performance', tool: 'Asset Overlay', route: '/asset-overlay' },
  mover: { id: 'mover', label: 'Catalyst scan', tool: 'Mover Radar', route: '/mover-radar' },
  news: { id: 'news', label: 'Recent news', tool: 'Mover Radar', route: '/mover-radar' },
  options: { id: 'options', label: 'Options snapshot', tool: 'Options Desk', route: '/options' },
  earnings: { id: 'earnings', label: 'Earnings calendar', tool: 'Earnings Scanner', route: '/earnings' },
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
    .filter(holding => holding.shares > 0)
    .sort((a, b) => (b.shares * b.avgCost) - (a.shares * a.avgCost))
    .map(holding => normalizeTicker(holding.ticker))
    .filter(Boolean)
    .slice(0, 8)
}

function portfolioOptionSymbols(portfolio: ActivePortfolioContext): string[] {
  return unique((portfolio.optionPositions ?? [])
    .map(position => normalizeTicker(position.underlying))
    .filter(Boolean))
    .slice(0, 8)
}

function usesActivePortfolio(scope: ReportScope, portfolio: ActivePortfolioContext): boolean {
  return portfolio.hasData && (scope.includePortfolio || scope.reportType === 'portfolio-review')
}

export function planReportResearch(
  scope: ReportScope,
  portfolio: ActivePortfolioContext,
): ReportResearchPlan {
  const objective = [scope.goal || scope.purpose, scope.mustInclude].filter(Boolean).join('\n').trim()
  const explicit = parseResearchSymbols(scope.researchSymbols)
  const inferred = inferResearchSymbols(objective)
  const hasActivePortfolio = usesActivePortfolio(scope, portfolio)
  const equitySymbols = hasActivePortfolio ? portfolioSymbols(portfolio) : []
  const optionSymbols = hasActivePortfolio ? portfolioOptionSymbols(portfolio) : []
  const bookSymbols = unique([...equitySymbols, ...optionSymbols]).slice(0, 8)
  const requestedSymbols = unique(explicit.length ? explicit : inferred.length ? inferred : bookSymbols)
  const intent = detectIntent(objective, requestedSymbols.length)
  const symbols = intent === 'portfolio' && bookSymbols.length ? bookSymbols : requestedSymbols
  const researchTargets = intent === 'comparison' ? symbols : symbols.slice(0, 1)
  const catalystRequested = /\b(catalyst|moving|mover|selloff|rally|surge|drop|news|event)\b/i.test(objective)
  const valuationRequested = /\b(valuation|value|fair value|multiple|p\/e|peg|cheap|expensive|peer|intrinsic)\b/i.test(objective)
  const fullPortfolioRequested = intent === 'portfolio' && /\b(complete|entire|full|comprehensive|decision.grade|all elements|all aspects)\b/i.test(objective)
  const macroRiskRequested = /\b(macro|cross.asset|market regime|global markets?|inflation|cpi|pce|rates?|fed|fomc|credit|recession|downside|risk)\b/i.test(objective)
  const gammaRequested = /\b(gamma|gex|dealer positioning|call wall|put wall)\b/i.test(objective)
  const sources: ReportResearchSource[] = []

  const add = (id: ReportResearchSourceId, reason: string, targets: string[] = []) => {
    if (sources.some(source => source.id === id) || !sourceMatchesHorizon(id, scope)) return
    // A relationship tool gets the whole symbol set, not the single-name slice.
    const resolved = MULTI_ASSET_SOURCES.has(id) && targets.length
      ? targetsForSource(id, targets)
      : targets
    sources.push({ ...SOURCE_META[id], reason, targets: resolved, selectionOrigin: 'baseline' })
  }

  if (!objective) {
    return { objective, intent, symbols, sources, blockedReason: 'Add an objective so AlphaTape can choose relevant tools.' }
  }

  if (hasActivePortfolio && portfolio.futuresCount > 0) {
    return {
      objective,
      intent,
      symbols,
      sources,
      blockedReason: `The active portfolio includes ${portfolio.futuresCount} futures position${portfolio.futuresCount === 1 ? '' : 's'}. Automated book research does not yet model futures contract exposure. Turn off portfolio context or use a supported book.`,
    }
  }

  if (intent === 'portfolio') {
    if (hasActivePortfolio) {
      add('portfolio', 'Establish holdings, cash, and concentration from the active book.')
      if (equitySymbols.length) {
        add('portfolio-risk', 'Measure return, volatility, beta, drawdown, and benchmark-relative performance for the equity and cash sleeve.')
        add('factor-decomposition', 'Separate systematic exposure from name-specific risk for the equity and cash sleeve.', equitySymbols)
      }
      if (equitySymbols.length >= 2) add('correlation', 'Test whether the equity holdings provide real diversification under a common window.', equitySymbols)
      add('company', 'Review fundamentals, growth, valuation, analyst expectations, and company-specific risks for the largest actual holdings.', bookSymbols)
      add('price-history', 'Measure return paths and drawdowns across the largest actual holdings.', bookSymbols)
      add('news', 'Capture current catalysts and changes in the information set for the largest actual holdings.', bookSymbols)
      if (optionSymbols.length) {
        add('options', 'Measure implied volatility, realized volatility, expected move, and positioning for each option underlying.', optionSymbols)
        add('volatility-skew', 'Measure downside skew and the volatility term structure for each option underlying.', optionSymbols)
        add('implied-probability', 'Estimate option-implied outcome ranges for each option underlying.', optionSymbols)
        if (fullPortfolioRequested || gammaRequested) {
          add('dealer-gex', 'Assess strike-level dealer gamma around each option underlying.', optionSymbols)
        }
      }
      add('global-markets', 'Frame the book against the current cross-asset regime.')
      add('sector-rotation', 'Test the portfolio tilt against current sector leadership and momentum.')
    }
    if (!hasActivePortfolio && symbols.length === 0) {
      return {
        objective, intent, symbols, sources,
        blockedReason: 'Select an active portfolio or add ticker symbols for this risk report.',
      }
    }
    if (macroRiskRequested || fullPortfolioRequested) {
      add('credit-spreads', 'Identify whether the credit regime is amplifying or cushioning portfolio downside.')
      add('rate-engine', 'Connect duration-sensitive holdings and valuation risk to the yield curve and expected Fed path.')
    }
    if (macroRiskRequested || catalystRequested || fullPortfolioRequested) {
      add('macro-events', 'Identify scheduled events that can change portfolio risk.')
    }
    if (catalystRequested || fullPortfolioRequested) {
      add('sentiment', 'Measure whether the current news tape confirms or contradicts the portfolio thesis.')
    }
    if (valuationRequested || fullPortfolioRequested) {
      add('peer-valuation', 'Benchmark the largest holdings against relevant peers, operating quality, and consensus targets.', bookSymbols)
      add('dcf-valuation', 'Build intrinsic-value anchors and sensitivities for the largest holdings.', bookSymbols)
    }
    add('earnings', 'Check near-term earnings risk only for actual portfolio holdings.', bookSymbols.length ? bookSymbols : symbols)
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

  if (hasActivePortfolio && intent !== 'portfolio') {
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

/** A screen saved in the Stock Screener's own library. Read straight from its
 * storage key rather than importing the page, which would pull the whole screener
 * into this bundle. Shape mirrors StockScreener's `Preset`. */
export interface SavedScreen {
  id: string
  name: string
  desc?: string
  universes?: string[]
  sortBy: string
  sortDir: 'asc' | 'desc'
  sortParam?: string
  filters: { field: string; operator: string; value: string | number; param?: string }[]
}

export const SAVED_SCREENS_STORAGE_KEY = 'fdb_screener_saved_screens_v1'

export function readSavedScreens(): SavedScreen[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVED_SCREENS_STORAGE_KEY) ?? 'null')
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((raw): SavedScreen[] => {
      const s = record(raw)
      const id = plain(s.id)
      const name = plain(s.name)
      if (id === '—' || name === '—') return []
      return [{
        id,
        name,
        desc: s.desc ? plain(s.desc) : undefined,
        universes: array(s.universes).map(u => plain(u)).filter(u => u !== '—'),
        sortBy: plain(s.sortBy) === '—' ? 'marketCap' : plain(s.sortBy),
        sortDir: plain(s.sortDir).toLowerCase() === 'asc' ? 'asc' : 'desc',
        sortParam: s.sortParam ? plain(s.sortParam) : undefined,
        filters: array(s.filters).flatMap(f => {
          const item = record(f)
          const field = plain(item.field)
          if (field === '—' || item.value === '' || item.value == null) return []
          return [{
            field,
            operator: plain(item.operator),
            value: item.value as string | number,
            param: item.param ? plain(item.param) : undefined,
          }]
        }),
      }]
    })
  } catch {
    return []
  }
}

/** Run a saved screen and return its top symbols. Skips the AI parse entirely —
 * the criteria are already structured, so there is nothing to interpret. */
export async function runSavedScreen(
  screen: SavedScreen,
  limit = 8,
  client: ResearchClient = DEFAULT_CLIENT,
): Promise<ReportScreenerSelection> {
  const filters: ReportScreenerFilter[] = screen.filters.flatMap(f => {
    const value = finite(f.value)
    if (value == null || !['gt', 'gte', 'lt', 'lte', 'between'].includes(f.operator)) return []
    return [{
      field: f.field,
      operator: f.operator as ReportScreenerFilter['operator'],
      value,
      value2: null,
      param: f.param ?? null,
    }]
  })
  const capped = clamp(Math.trunc(limit), 1, 8)
  const screenRun = record(await client.post('/api/screener/run', {
    filters,
    universe: screen.universes?.length ? screen.universes[0] : null,
    sector: null,
    exchange: null,
    region: null,
    sort_by: screen.sortBy,
    sort_dir: screen.sortDir,
    sort_param: screen.sortParam ?? null,
    limit: capped,
  }))
  const symbols = unique(
    array(screenRun.results)
      .map(row => normalizeTicker(plain(record(row).ticker)))
      .filter(symbol => /^[A-Z0-9^][A-Z0-9^=-]{0,11}$/.test(symbol)),
  ).slice(0, capped)
  return {
    symbols,
    total: Math.max(symbols.length, Math.trunc(finite(screenRun.total) ?? symbols.length)),
    explanation: `Ran the saved screen "${screen.name}".`,
    filters,
    sector: null,
    universe: screen.universes?.length ? screen.universes[0] : null,
    exchange: null,
    region: null,
    sortBy: screen.sortBy,
    sortDir: screen.sortDir,
  }
}

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
  const years = scope.lookforwardPreset === 'next3y' ? 3
    : scope.lookforwardPreset === 'next5y' ? 5
      : scope.lookforwardPreset === 'next10y' ? 10
        : 0
  if (years) {
    const end = new Date(start)
    end.setUTCFullYear(end.getUTCFullYear() + years)
    end.setUTCDate(end.getUTCDate() - 1)
    return { start: isoDate(start), end: isoDate(end) }
  }
  const days = scope.lookforwardPreset === 'next7' ? 7
    : scope.lookforwardPreset === 'next30' ? 30
      : scope.lookforwardPreset === 'next90' ? 90
        : scope.lookforwardPreset === 'next180' ? 180
          : scope.lookforwardPreset === 'next365' || scope.lookforwardPreset === 'unlimited' ? 365
            : 14
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + (days - 1))
  return { start: isoDate(start), end: isoDate(end) }
}

function outlookRangeDescription(scope: ReportScope): string {
  if (scope.lookforwardPreset === 'unlimited') return 'open-ended outlook with no fixed end date'
  const range = lookforwardRange(scope)
  return `${range.start} to ${range.end}`
}

function eventResearchRange(scope: ReportScope): { range: ResearchDateRange; capped: boolean } {
  const requested = lookforwardRange(scope)
  const capped = scope.lookforwardPreset === 'unlimited' || inclusiveDays(requested) > 365
  if (!capped) return { range: requested, capped: false }
  const start = validDate(requested.start) ?? new Date()
  const end = new Date(start)
  end.setUTCDate(end.getUTCDate() + 364)
  return { range: { start: isoDate(start), end: isoDate(end) }, capped: true }
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

// Tools that measure a relationship BETWEEN assets. One target is not a reduced
// version of their output, it is no output at all — correlation of a thing with
// itself is 1. Both planners truncate the symbol list to a single name unless the
// intent is literally 'comparison', which handed these tools one ticker and made
// them fail every time the planner chose them for a portfolio or macro report.
const MULTI_ASSET_SOURCES = new Set<ReportResearchSourceId>(['correlation', 'regression', 'market-compare'])

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
  const manifestResponse = record(await client.get('/api/ai/report-tools'))
  const serverToolIds = new Set(
    array(manifestResponse.tools)
      .map(item => plain(record(item).id) as ReportResearchSourceId)
      .filter(Boolean),
  )
  const toolCatalog = REPORT_RESEARCH_TOOL_CATALOG.filter(
    tool => serverToolIds.has(tool.id) && sourceMatchesHorizon(tool.id, scope),
  )
  if (!toolCatalog.length) throw new Error('AlphaTape report tool registry is unavailable')
  const historicalWindow = scope.lookbackPreset === 'none'
    ? 'historical lookback disabled'
    : `${lookbackRange(scope).start} to ${lookbackRange(scope).end}`
  const forwardWindow = scope.lookforwardPreset === 'none'
    ? 'forward outlook disabled'
    : outlookRangeDescription(scope)
  const response = record(await client.post('/api/ai/report-research-plan', {
    objective: baseline.objective,
    mustInclude: scope.mustInclude,
    timeframe: `${historicalWindow}; ${forwardWindow}`,
    symbols: baseline.symbols,
    portfolio: {
      included: usesActivePortfolio(scope, portfolio),
      name: portfolio.name,
      positionCount: portfolio.positionCount,
      equityCount: portfolio.holdings.length,
      optionsCount: portfolio.optionsCount,
      futuresCount: portfolio.futuresCount,
      cashIncluded: portfolio.cashValue > 0,
    },
    baselineSourceIds: baseline.sources.map(source => source.id),
  }))
  const additions = array(response.additions)
  const catalog = new Map(toolCatalog.map(item => [item.id, item]))
  const sources = [...baseline.sources]
  const portfolioRelationshipTargets = usesActivePortfolio(scope, portfolio)
    ? portfolioSymbols(portfolio)
    : baseline.symbols
  let added = 0
  for (const raw of additions) {
    if (added >= 8) break
    const addition = record(raw)
    const id = String(addition.id ?? '') as ReportResearchSourceId
    const item = catalog.get(id)
    if (!item || sources.some(source => source.id === id)) continue
    const hasPortfolio = usesActivePortfolio(scope, portfolio)
    if (item.targetMode === 'symbols' && baseline.symbols.length === 0) continue
    if (item.targetMode === 'portfolio' && !hasPortfolio) continue
    if (item.targetMode === 'portfolio-or-symbols' && !hasPortfolio && baseline.symbols.length === 0) continue
    if ((id === 'correlation' || id === 'regression') && portfolioRelationshipTargets.length < 2) continue
    const reason = String(addition.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
    if (!reason) continue
    sources.push({
      ...SOURCE_META[id],
      reason,
      targets: item.targetMode === 'market' || item.targetMode === 'portfolio'
        ? []
        : targetsForSource(id, MULTI_ASSET_SOURCES.has(id)
          ? portfolioRelationshipTargets
          : baseline.intent === 'comparison' || baseline.intent === 'portfolio'
            ? baseline.symbols
          : baseline.symbols.slice(0, 1)),
      selectionOrigin: 'ai',
    })
    added += 1
  }

  // Per-tool setup instructions, applied to baseline tools as well as additions.
  const directives = record(response.directives)
  const directed = sources.map(source => {
    const text = plain(directives[source.id])
    return text && text !== '—' ? { ...source, directive: text } : source
  })

  const objectiveRaw = record(response.objectivePlan)
  const objectivePlan: ReportObjectivePlan = {
    thesis: plain(objectiveRaw.thesis) === '—' ? '' : plain(objectiveRaw.thesis),
    requiredDataPoints: array(objectiveRaw.requiredDataPoints).map(plain).filter(value => value !== '—').slice(0, 12),
    requiredChecks: array(objectiveRaw.requiredChecks).map(plain).filter(value => value !== '—').slice(0, 10),
  }
  const requiredResponse = array(response.requiredSourceIds)
    .map(value => String(value) as ReportResearchSourceId)
    .filter(id => directed.some(source => source.id === id))
  const requiredSourceIds = unique([
    ...baseline.sources.map(source => source.id),
    ...requiredResponse,
    ...directed.filter(source => source.selectionOrigin === 'ai').map(source => source.id),
  ])

  return {
    ...baseline,
    sources: directed,
    aiEnhanced: true,
    aiSummary: String(response.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 240),
    objectivePlan,
    requiredSourceIds,
  }
}

async function perTicker(
  source: ReportResearchSource,
  run: (ticker: string) => Promise<ClipDraft | ClipDraft[] | null>,
): Promise<ClipDraft[]> {
  const settled = await mapSettledWithConcurrency(source.targets, 2, run)
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
            { label: 'Market price', value: money(marketPrice), sub: 'Latest value returned by the fundamentals source; verify quote time before acting' },
            { label: 'Upside to intrinsic', value: upside == null ? '—' : percent(upside) },
            { label: 'Enterprise value', value: moneyMillions(data.enterprise_value) },
            { label: 'PV of explicit FCF', value: moneyMillions(data.pv_fcfs) },
            { label: 'Terminal value', value: moneyMillions(data.terminal_value) },
          ]), source, ticker, ticker),
        ]
        if (marketPrice != null && marketPrice > 0 && (intrinsic / marketPrice < 0.2 || intrinsic / marketPrice > 5)) {
          clips.push(tagClip(textClip(
            'DCF Valuation',
            `DCF scale reconciliation required · ${ticker}`,
            `The DCF output of ${money(intrinsic)} per share differs from the current market value of ${money(marketPrice)} by more than 5×. Treat the DCF as unreconciled until units, diluted share count, corporate actions, net debt, and quote alignment are verified. Do not use it to justify an allocation change.`,
          ), source, `${ticker}:scale-warning`, ticker))
        }
        if (fcfs.length) {
          const firstRevenue = finite(fcfs[0].revenue)
          const lastRevenue = finite(fcfs[fcfs.length - 1].revenue)
          const intervals = Math.max(0, fcfs.length - 1)
          const projectionCagr = firstRevenue != null && firstRevenue > 0 && lastRevenue != null && intervals > 0
            ? (Math.pow(lastRevenue / firstRevenue, 1 / intervals) - 1) * 100
            : null
          const cumulativeGrowth = firstRevenue != null && firstRevenue > 0 && lastRevenue != null
            ? ((lastRevenue / firstRevenue) - 1) * 100
            : null
          clips.push(tagClip(kpiClip('DCF Valuation', `Projection math · ${ticker}`, [
            { label: 'Starting revenue', value: moneyMillions(revenue), sub: 'Model input; USD millions' },
            { label: 'Year 1 revenue', value: moneyMillions(firstRevenue), sub: 'Model output; USD millions' },
            { label: `Year ${plain(fcfs[fcfs.length - 1].year)} revenue`, value: moneyMillions(lastRevenue), sub: 'Model output; USD millions' },
            { label: `Y1–Y${plain(fcfs[fcfs.length - 1].year)} CAGR`, value: projectionCagr == null ? '—' : percent(projectionCagr), sub: `${intervals} compounding intervals` },
            { label: 'Cumulative growth', value: cumulativeGrowth == null ? '—' : percent(cumulativeGrowth), sub: 'Not an annualized rate' },
          ]), source, `${ticker}:projection-math`, ticker))
          clips.push(tagClip(chartClip(
            'DCF Valuation',
            `${ticker} revenue projection`,
            'bar',
            'year',
            fcfs.map(row => ({ year: `Y${plain(row.year)}`, revenue: finite(row.revenue) == null ? null : finite(row.revenue)! / 1000 })),
            [{ key: 'revenue', label: 'Revenue (USD billions)' }],
          ), source, `${ticker}:revenue-visual`, ticker))
          clips.push(tagClip(chartClip(
            'DCF Valuation',
            `${ticker} free cash flow projection`,
            'line',
            'year',
            fcfs.map(row => ({
              year: `Y${plain(row.year)}`,
              fcf: finite(row.fcf) == null ? null : finite(row.fcf)! / 1000,
              presentValue: finite(row.pv_fcf) == null ? null : finite(row.pv_fcf)! / 1000,
            })),
            [{ key: 'fcf', label: 'Free cash flow (USD billions)' }, { key: 'presentValue', label: 'PV of FCF (USD billions)' }],
          ), source, `${ticker}:fcf-visual`, ticker))
          clips.push(tagClip(tableClip(
            'DCF Valuation',
            `DCF projection bridge · ${ticker}`,
            ['Year', 'Revenue $B', 'Growth %', 'Op margin %', 'EBIT $B', 'FCF $B', 'PV FCF $B'],
            fcfs.map(row => [
              `Y${plain(row.year)}`,
              finite(row.revenue) == null ? null : +(finite(row.revenue)! / 1000).toFixed(2),
              finite(row.growth),
              finite(row.margin),
              finite(row.ebit) == null ? null : +(finite(row.ebit)! / 1000).toFixed(2),
              finite(row.fcf) == null ? null : +(finite(row.fcf)! / 1000).toFixed(2),
              finite(row.pv_fcf) == null ? null : +(finite(row.pv_fcf)! / 1000).toFixed(2),
            ]),
          ), source, `${ticker}:projection-bridge`, ticker))
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
          clips.push(tagClip(tableClip(
            'DCF Valuation',
            `DCF sensitivity assumptions · ${ticker}`,
            ['Driver', 'Tested range', 'Low value/share', 'Base value/share', 'High value/share'],
            sensitivity.map(row => [
              plain(row.label),
              plain(row.range),
              finite(row.lo),
              intrinsic,
              finite(row.hi),
            ]),
          ), source, `${ticker}:sensitivity-assumptions`, ticker))
          if (sensitivity.some(row => (finite(row.lo) ?? 0) < 0 || (finite(row.hi) ?? 0) < 0)) {
            clips.push(tagClip(textClip(
              'DCF Valuation',
              `Negative equity-value sensitivity · ${ticker}`,
              'A negative per-share sensitivity result means enterprise value falls below net debt and other claims under that tested assumption. It is a model stress outcome, not a negative stock price forecast.',
            ), source, `${ticker}:negative-equity-value`, ticker))
          }
        }
        clips.push(tagClip(kpiClip('DCF Valuation', `Model assumptions · ${ticker}`, [
          { label: 'Revenue input', value: moneyMillions(revenue), sub: 'USD millions' },
          { label: 'Shares', value: `${shares.toLocaleString('en-US', { maximumFractionDigits: 1 })}M` },
          { label: 'Net debt', value: moneyMillions(request.net_debt), sub: 'USD millions' },
          { label: 'Tax rate', value: `${request.tax_rate.toFixed(1)}%` },
          { label: 'WACC', value: `${wacc.toFixed(1)}%`, sub: 'AI-assisted assumption' },
          { label: 'Terminal growth', value: `${terminalGrowth.toFixed(1)}%`, sub: 'AI-assisted assumption' },
          { label: 'Target margin', value: `${targetMargin.toFixed(1)}%`, sub: `current ${currentMargin.toFixed(1)}%` },
          { label: 'Years 1–3 growth', value: `${growth1.toFixed(1)}%` },
          { label: 'Years 4–7 growth', value: `${growth2.toFixed(1)}%` },
          { label: 'Years 8–10 growth', value: `${growth3.toFixed(1)}%` },
          { label: 'CapEx / revenue', value: `${capexPct.toFixed(1)}%` },
          { label: 'D&A / revenue', value: `${daPct.toFixed(1)}%` },
          { label: 'Working capital / revenue', value: `${wcPct.toFixed(1)}%`, sub: `fades to ${(wcPct * 0.5).toFixed(1)}%` },
        ]), source, `${ticker}:assumptions`, ticker))
        return clips
      })

    case 'price-history':
      return perTicker(source, async ticker => {
        const range = lookbackRange(scope)
        const data = record(await client.get(
          `/api/market/history?ticker=${encodeURIComponent(ticker)}&start=${range.start}&end=${range.end}`,
        ))
        const full = array(data.price).map(point => ({
          date: plain(record(point).date),
          price: finite(record(point).value),
        })).filter(point => point.price != null) as { date: string; price: number }[]
        if (!full.length) return null

        const plan = parseChartDirective(source.directive, [ticker])
        const closes = full.map(p => p.price)
        const series: { key: string; label: string }[] = [{ key: 'price', label: ticker }]
        const priced: Record<string, (number | null)[]> = {}

        // Only same-scale indicators belong on the price axis. RSI, MACD and HV
        // live on their own scale, so they become a separate exhibit rather than
        // a second y-axis on this one.
        for (const ind of plan.indicators) {
          if (ind.kind === 'sma') priced[ind.label] = smaArr(closes, ind.period)
          else if (ind.kind === 'ema') priced[ind.label] = emaArr(closes, ind.period)
          else if (ind.kind === 'bollinger') {
            const b = bollinger(closes, ind.period)
            priced[`${ind.label} upper`] = b.upper
            priced[`${ind.label} lower`] = b.lower
          }
        }

        // Overlay tickers are re-based to the subject's first close so two price
        // levels can share one axis honestly.
        const overlaySeries: Record<string, Record<string, number>> = {}
        for (const sym of plan.overlays) {
          try {
            const o = record(await client.get(
              `/api/market/history?ticker=${encodeURIComponent(sym)}&start=${range.start}&end=${range.end}`,
            ))
            const pts = array(o.price).map(p => ({ date: plain(record(p).date), value: finite(record(p).value) }))
              .filter(p => p.value != null) as { date: string; value: number }[]
            if (pts.length < 2) continue
            const scale = full[0].price / pts[0].value
            overlaySeries[sym] = Object.fromEntries(pts.map(p => [p.date, p.value * scale]))
          } catch { /* an overlay that will not load is dropped, not fatal */ }
        }

        const merged = full.map((point, i) => {
          const row: Record<string, string | number | null> = { date: point.date, price: point.price }
          for (const [key, values] of Object.entries(priced)) row[key] = values[i]
          for (const [sym, byDate] of Object.entries(overlaySeries)) row[sym] = byDate[point.date] ?? null
          return row
        })
        for (const key of Object.keys(priced)) series.push({ key, label: key })
        for (const sym of Object.keys(overlaySeries)) series.push({ key: sym, label: `${sym} (rebased)` })

        const metrics = record(data.metrics)
        const clip = chartClip('Chart Studio', `${ticker} price history`, 'line', 'date', thin(merged), series)
        const extras = series.length > 1 ? ` · with ${series.slice(1).map(s => s.label).join(', ')}` : ''
        clip.payload.title = `${ticker} price history · ${percent(metrics.total_return)} return · ${percent(metrics.max_drawdown)} max drawdown${extras}`
        const out = [tagClip(clip, source, ticker, ticker)]

        const oscillators = plan.indicators.filter(i => i.kind === 'rsi' || i.kind === 'hv')
        if (oscillators.length) {
          const oscRows = full.map((point, i) => {
            const row: Record<string, string | number | null> = { date: point.date }
            for (const ind of oscillators) {
              row[ind.label] = ind.kind === 'rsi' ? rsiArr(closes, ind.period)[i] : hvArr(closes, ind.period)[i]
            }
            return row
          })
          const oscClip = chartClip('Chart Studio', `${ticker} ${oscillators.map(o => o.label).join(' and ')}`,
            'line', 'date', thin(oscRows), oscillators.map(o => ({ key: o.label, label: o.label })))
          out.push(tagClip(oscClip, source, `${ticker}-osc`, ticker))
        }
        return out
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
      const { range, capped } = eventResearchRange(scope)
      const totalDays = inclusiveDays(range)
      const first = validDate(range.start)!
      const requests: string[] = []
      for (let offset = 0; offset < totalDays; offset += 14) {
        const start = new Date(first)
        start.setUTCDate(start.getUTCDate() + offset)
        requests.push(`/api/earnings/calendar?date=${isoDate(start)}&days=${Math.min(14, totalDays - offset)}`)
      }
      const responses = await mapWithConcurrency(requests, 2, url => client.get(url))
      const targets = new Set(source.targets)
      const candidateRows = responses.flatMap(data => array(record(data).rows))
        .filter(row => targets.has(normalizeTicker(plain(record(row).symbol))))
        .map(row => {
          const item = record(row)
          return [normalizeTicker(plain(item.symbol)), plain(item.date), plain(item.hour)] as [string, string, string]
        })
        .sort((a, b) => a[1].localeCompare(b[1]))
      const seenTickers = new Set<string>()
      const rows = candidateRows.filter(row => {
        if (seenTickers.has(row[0])) return false
        seenTickers.add(row[0])
        return true
      })
      const horizon = `${range.start} to ${range.end}${capped ? ' · first year of longer outlook' : ''}`
      if (!rows.length) {
        return [tagClip(textClip(
          'Earnings Scanner',
          `Upcoming earnings · ${horizon}`,
          `No scheduled earnings were found for ${source.targets.join(', ')} from ${range.start} through ${range.end}.`
          + (capped ? ' Calendar evidence is intentionally limited to the first year of the longer analytical outlook.' : ''),
        ), source, source.targets.join('-'))]
      }
      const hasCompleteSessionData = rows.every(row => !/^(?:|—|-)$/i.test(row[2].trim()))
      return [
        tagClip(tableClip(
          'Earnings Scanner',
          `Upcoming portfolio earnings schedule · ${horizon}`,
          hasCompleteSessionData ? ['Portfolio holding', 'Report date', 'Session'] : ['Portfolio holding', 'Report date'],
          hasCompleteSessionData ? rows : rows.map(([ticker, date]) => [ticker, date]),
        ), source, source.targets.join('-')),
        tagClip(tableClip(
          'Earnings Scanner',
          'Earnings schedule methodology',
          ['Item', 'Definition'],
          [
            ['Coverage', `Nearest scheduled event per requested portfolio holding from ${range.start} through ${range.end}`],
            ['Comparison rule', 'Absolute EPS estimates are omitted because EPS levels are not comparable across issuers'],
            ['Directional evidence', 'Use company-specific growth, revisions, dispersion, guidance, and historical reaction'],
          ],
        ), source, `${source.targets.join('-')}:methodology`),
      ]
    }

    case 'global-markets': {
      const data = record(await client.get('/api/market/global-board?window=1d'))
      const rows = array(data.sections).flatMap(section => {
        const group = record(section)
        return array(group.rows).map(item => {
          const row = record(item)
          return [plain(group.name), plain(row.label), finite(row.price), finite(row.change_pct), plain(row.status)]
        })
      }).filter(row => row[2] != null && !/unavailable|error|failed/i.test(String(row[4]))).slice(0, 40)
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
      const today = isoDate(new Date())
      const rows = array(data.events)
        .map(record)
        .filter(row => {
          const eventDate = plain(row.datetime).slice(0, 10)
          return /^\d{4}-\d{2}-\d{2}$/.test(eventDate) && eventDate >= today
        })
        .sort((a, b) => plain(a.datetime).localeCompare(plain(b.datetime)))
        .slice(0, 24)
        .map(row => [plain(row.datetime), plain(row.name), plain(row.impact), plain(row.category), plain(row.region)])
      if (!rows.length) return []
      return [tagClip(tableClip(
        'Macro Event Hub',
        `Upcoming macro events · collected ${today}`,
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
      if (source.targets.length < 2) {
        throw new Error(`Regression needs a dependent and at least one independent subject, got ${source.targets.length || 'none'}.`)
      }
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
      // Returning [] here surfaced as a bare "no usable data" and hid the real
      // cause, which was always the plan handing this tool one ticker.
      if (source.targets.length < 2) {
        throw new Error(`Correlation needs at least 2 subjects, got ${source.targets.length || 'none'}.`)
      }
      const period = correlationPeriod(scope)
      const rollingWindow = Math.max(5, Math.min(60, Math.floor(inclusiveDays(lookbackRange(scope)) / 2)))
      const data = record(await client.post('/api/regression/correlation', {
        tickers: source.targets,
        period,
        use_returns: true,
        benchmark: 'SPY',
        rolling_window: rollingWindow,
      }))
      const summary = record(data.summary)
      const strongest = record(summary.strongest_pair)
      const negative = record(summary.most_negative_pair)
      const lowestCorrelation = finite(negative.value)
      const clips: ClipDraft[] = [
        tagClip(kpiClip('Correlation', 'Correlation structure', [
          { label: 'Avg |correlation|', value: finite(summary.avg_abs_correlation)?.toFixed(2) ?? '—' },
          { label: 'Strongest pair', value: finite(strongest.value)?.toFixed(2) ?? '—', sub: [strongest.a, strongest.b].filter(Boolean).join(' ↔ ') },
          { label: lowestCorrelation != null && lowestCorrelation < 0 ? 'Most negative' : 'Lowest correlation', value: lowestCorrelation?.toFixed(2) ?? '—', sub: [negative.a, negative.b].filter(Boolean).join(' ↔ ') },
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
            ...tickers.map(columnTicker => {
              const value = lookup.get(`${rowTicker}|${columnTicker}`)
              return value == null ? null : +value.toFixed(2)
            }),
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
        const numericValues = values.map(finite).filter((value): value is number => value != null)
        const first = numericValues[0]
        const latest = numericValues[numericValues.length - 1]
        const average = numericValues.length ? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length : null
        clips.push(tagClip(kpiClip('Correlation', `Rolling correlation summary · ${pair.join(' ↔ ')}`, [
          { label: 'Pair', value: pair.join(' ↔ '), sub: `${plain(rolling.window)} trading-day Pearson correlation of daily returns` },
          { label: 'First', value: first == null ? '—' : first.toFixed(2), sub: plain(dates[0]) },
          { label: 'Latest', value: latest == null ? '—' : latest.toFixed(2), sub: plain(dates[dates.length - 1]) },
          { label: 'Average', value: average == null ? '—' : average.toFixed(2), sub: 'Mean of displayed rolling observations' },
          { label: 'Range', value: numericValues.length ? `${Math.min(...numericValues).toFixed(2)} to ${Math.max(...numericValues).toFixed(2)}` : '—' },
          { label: 'Windows', value: String(numericValues.length) },
        ]), source, `${source.targets.join('-')}:rolling-summary`))
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
      const holdings = usesActivePortfolio(scope, portfolio)
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
        const bookBetas = record(data.book_betas)
        clips.push(tagClip(kpiClip('Factor Decomposition', `Factor decomposition · ${response.mode}`, [
          { label: 'Annual volatility', value: percent(data.ann_vol_pct) },
          { label: 'Systematic share of variance', value: finite(data.systematic_pct) == null ? '—' : `${finite(data.systematic_pct)!.toFixed(1)}%` },
          { label: 'Idiosyncratic share of variance', value: finite(data.idiosyncratic_pct) == null ? '—' : `${finite(data.idiosyncratic_pct)!.toFixed(1)}%` },
          { label: 'Annual alpha', value: percent(data.alpha_ann_pct) },
          { label: 'Model R²', value: finite(data.r_squared) == null ? '—' : finite(data.r_squared)!.toFixed(3) },
          { label: 'Multifactor market coefficient', value: finite(bookBetas.market) == null ? '—' : finite(bookBetas.market)!.toFixed(3), sub: `Portfolio OLS coefficient · benchmark ${plain(data.benchmark)}` },
          { label: 'Effective N', value: finite(record(data.concentration).effective_n)?.toFixed(1) ?? '—' },
          { label: 'Observations', value: plain(data.observations) },
          { label: 'Weighting', value: plain(data.weighting) },
          { label: 'Data source', value: plain(data.source) },
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
          clips.push(tagClip(tableClip(
            'Factor Decomposition',
            `${response.mode === 'macro' ? 'Macro' : 'Style'} factor model coefficients`,
            ['Factor', 'Proxy', 'Beta', 't-statistic', 'Significant at 5%', 'Signed factor contribution %'],
            factors.map(factor => [
              plain(factor.factor),
              plain(factor.proxy),
              finite(factor.beta),
              finite(factor.t_stat),
              Math.abs(finite(factor.t_stat) ?? 0) >= 1.96 ? 'Yes' : 'No',
              finite(factor.risk_pct),
            ]),
          ), source, `${response.mode}:factor-table`))
        }
        const holdingsDetail = array(data.holdings_detail).map(record)
        if (holdingsDetail.length) {
          clips.push(tagClip(tableClip(
            'Factor Decomposition',
            'Holding-level beta and portfolio risk contribution',
            ['Holding', 'Weight %', 'Market beta', 'Book variance share %', 'Idiosyncratic share %'],
            holdingsDetail.map(holding => [
              plain(holding.ticker),
              finite(holding.weight),
              finite(record(holding.betas).market),
              finite(holding.book_var_share_pct),
              finite(holding.idiosyncratic_pct),
            ]),
          ), source, `${response.mode}:holding-contributions`))
        }
        const rolling = record(data.rolling)
        const rollingEntry = Object.entries(rolling).find(([, value]) => array(value).length)
        if (rollingEntry) {
          const [factor, points] = rollingEntry
          const rollingPoints = array(points).map(point => ({
            date: plain(record(point).date),
            beta: finite(record(point).beta),
            lower95: finite(record(point).lower95),
            upper95: finite(record(point).upper95),
            fullSample: finite(bookBetas[factor]),
          })).filter(point => point.beta != null) as { date: string; beta: number }[]
          if (rollingPoints.length) {
            const betas = rollingPoints.map(point => point.beta)
            clips.push(tagClip(kpiClip('Factor Decomposition', `Rolling multifactor ${factor} coefficient summary`, [
              { label: 'First beta', value: betas[0].toFixed(3), sub: rollingPoints[0].date },
              { label: 'Latest beta', value: betas[betas.length - 1].toFixed(3), sub: rollingPoints[rollingPoints.length - 1].date },
              { label: 'Minimum beta', value: Math.min(...betas).toFixed(3) },
              { label: 'Maximum beta', value: Math.max(...betas).toFixed(3) },
              { label: 'Rolling window', value: `${plain(data.roll_window)} trading days` },
              { label: 'Method', value: 'Multivariate OLS', sub: `Portfolio returns on ${response.mode} factors` },
            ]), source, `${response.mode}:rolling-${factor}-summary`))
          }
          clips.push(tagClip(chartClip(
            'Factor Decomposition',
            `Rolling ${plain(data.roll_window)}-day ${factor} coefficient with 95% confidence range`,
            'line',
            'date',
            thin(rollingPoints, 100),
            [
              { key: 'beta', label: 'Rolling beta' },
              { key: 'fullSample', label: 'Full-sample beta' },
              { key: 'lower95', label: '95% lower' },
              { key: 'upper95', label: '95% upper' },
            ],
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
      const portfolioName = /^default$/i.test(portfolio.name.trim()) ? 'Portfolio' : portfolio.name
      const holdings = portfolio.holdings
        .map(holding => ({ ...holding, ticker: normalizeTicker(holding.ticker) }))
        .filter(holding => holding.ticker && holding.shares > 0)
      let quotes: Record<string, unknown> = {}
      try {
        quotes = record(await client.get(`/api/alerts/quotes?tickers=${encodeURIComponent(holdings.map(holding => holding.ticker).join(','))}`))
      } catch {
        quotes = {}
      }
      const valued = holdings.map(holding => {
        const liveMark = finite(record(quotes[holding.ticker]).current_price)
        const savedMark = holding.avgCost > 0 ? holding.avgCost : null
        const mark = liveMark ?? savedMark
        return {
          ...holding,
          mark,
          markSource: liveMark != null ? 'live quote' : savedMark != null ? 'saved cost fallback' : 'unpriced',
          value: mark == null ? null : Math.max(0, holding.shares * mark),
        }
      })
      const sectorPairs = await Promise.all(valued.slice(0, 30).map(async holding => {
        try {
          const company = record(await client.get(`/api/corporate/hub?ticker=${encodeURIComponent(holding.ticker)}`))
          const sector = plain(company.sector)
          return [holding.ticker, sector === '—' ? 'Unclassified' : sector] as const
        } catch {
          return [holding.ticker, 'Unclassified'] as const
        }
      }))
      const sectorByTicker = new Map(sectorPairs)
      const optionPositions = portfolio.optionPositions ?? []
      const optionLegs = optionPositions.flatMap(position => position.legs.map(leg => ({
        position,
        leg,
        request: {
          underlying: normalizeTicker(position.underlying),
          expiry: leg.expiry,
          strike: leg.strike,
          option_type: leg.type,
        },
      })))
      let optionMarks: Record<string, any>[] = []
      if (optionLegs.length) {
        try {
          optionMarks = array(record(await client.post('/api/options/marks', {
            legs: optionLegs.map(item => item.request),
          })).marks).map(record)
        } catch {
          optionMarks = []
        }
      }
      let markedOptionValue = 0
      let optionMarkIndex = 0
      const optionRows = optionLegs.map(({ position, leg }) => {
        const mark = record(optionMarks[optionMarkIndex++])
        const currentMark = finite(mark.mark)
        const delta = finite(mark.delta)
        const sign = leg.side === 'long' ? 1 : -1
        const multiplier = Math.max(0, leg.contracts) * 100
        const value = currentMark == null ? null : sign * currentMark * multiplier
        const deltaEquivalent = delta == null ? null : sign * delta * multiplier
        if (value != null) markedOptionValue += value
        return [
          normalizeTicker(position.underlying), position.name || 'Custom', leg.side, leg.type,
          leg.contracts, money(leg.strike), leg.expiry, money(leg.avgPremium),
          currentMark == null ? 'Unpriced' : money(currentMark),
          value == null ? 'Unpriced' : money(value),
          deltaEquivalent == null ? '—' : deltaEquivalent.toFixed(1),
          plain(mark.source),
        ]
      })
      const markedOptionLegs = optionRows.filter(row => row[8] !== 'Unpriced').length
      const pricedTotal = valued.reduce((sum, holding) => sum + (holding.value ?? 0), 0)
      const total = pricedTotal + portfolio.cashValue + markedOptionValue
      const rows = [...portfolio.holdings]
        .map(original => valued.find(holding => holding.ticker === normalizeTicker(original.ticker)))
        .filter((holding): holding is NonNullable<typeof holding> => holding != null)
        .map(holding => [
          holding.ticker,
          holding.shares,
          holding.mark == null ? 'Unpriced' : money(holding.mark),
          holding.value == null ? 'Unpriced' : money(holding.value),
          holding.value != null && total > 0 ? +((holding.value / total) * 100).toFixed(2) : null,
          sectorByTicker.get(holding.ticker) ?? 'Unclassified',
          holding.markSource,
        ])
        .sort((a, b) => Number(b[4] ?? 0) - Number(a[4] ?? 0))
      if (portfolio.cashValue > 0) rows.push(['CASH', null, null, money(portfolio.cashValue), total > 0 ? +((portfolio.cashValue / total) * 100).toFixed(2) : null, 'Cash', 'saved cash'])
      if (optionLegs.length) rows.push([
        'OPTIONS', null, null,
        markedOptionLegs ? money(markedOptionValue) : 'Unpriced',
        markedOptionLegs && total > 0 ? +((markedOptionValue / total) * 100).toFixed(2) : null,
        'Derivative contracts', `${markedOptionLegs}/${optionLegs.length} legs marked`,
      ])
      const unpriced = valued.filter(holding => holding.mark == null)
      const fallbacks = valued.filter(holding => holding.markSource === 'saved cost fallback')
      const clips = [tagClip(tableClip(
        'Portfolio Manager',
        `${portfolioName} · current allocation`,
        ['Ticker', 'Shares', 'Mark', 'Market value', 'Weight %', 'Sector classification', 'Valuation source'],
        rows,
      ), source, portfolio.id)]
      if (optionPositions.length) {
        clips.push(tagClip(tableClip(
          'Portfolio Manager',
          `${portfolioName} · current option positions`,
          ['Underlying', 'Strategy', 'Side', 'Type', 'Contracts', 'Strike', 'Expiry', 'Saved premium', 'Mark', 'Market value', 'Δ-equivalent shares', 'Mark source'],
          optionRows,
        ), source, `${portfolio.id}:option-positions`))
        clips.push(tagClip(textClip(
          'Portfolio Manager',
          `${portfolioName} · option analytics coverage`,
          `Option contracts are included in the allocation inventory with ${markedOptionLegs}/${optionLegs.length} live or model-derived marks and delta-equivalent exposure. Their underlyings receive volatility, skew, implied-probability, company, price, news, and catalyst research. Historical return, beta, volatility, drawdown, and factor statistics remain equity-and-cash sleeve metrics because contract-level history and nonlinear Greek aggregation are not available.`,
        ), source, `${portfolio.id}:option-coverage`))
      }
      const sectorWeights = new Map<string, number>()
      let fundLookThroughWeight = 0
      for (const holding of valued) {
        if (holding.value == null || total <= 0) continue
        const sector = sectorByTicker.get(holding.ticker) ?? 'Unclassified'
        const weight = (holding.value / total) * 100
        if (/exchange[- ]traded fund|\betf\b/i.test(sector)) {
          fundLookThroughWeight += weight
        } else {
          sectorWeights.set(sector, (sectorWeights.get(sector) ?? 0) + weight)
        }
      }
      if (portfolio.cashValue > 0 && total > 0) sectorWeights.set('Cash', (portfolio.cashValue / total) * 100)
      if (fundLookThroughWeight > 0) sectorWeights.set('Fund look-through required', fundLookThroughWeight)
      const sectorRows = [...sectorWeights.entries()].sort((a, b) => b[1] - a[1])
      if (sectorRows.length) {
        clips.push(tagClip(tableClip(
          'Portfolio Manager',
          `${portfolioName} · direct issuer sector allocation`,
          ['Classification', 'Portfolio weight %', 'Basis'],
          sectorRows.map(([sector, weight]) => [
            sector,
            +weight.toFixed(2),
            sector === 'Cash' ? 'Portfolio cash balance'
              : sector === 'Fund look-through required' ? 'Underlying fund holdings are not included in direct issuer sector weights'
                : 'Corporate Hub provider classification',
          ]),
        ), source, `${portfolio.id}:sector-allocation`))
        clips.push(tagClip(chartClip(
          'Portfolio Manager',
          `${portfolioName} direct issuer sector weights`,
          'bar',
          'sector',
          sectorRows.map(([sector, weight]) => ({ sector, weight: +weight.toFixed(2) })),
          [{ key: 'weight', label: 'Portfolio weight %' }],
          { barOrientation: 'horizontal' },
        ), source, `${portfolio.id}:sector-allocation-visual`))
        if (fundLookThroughWeight > 0) {
          clips.push(tagClip(textClip(
            'Portfolio Manager',
            `${portfolioName} · fund look-through limitation`,
            `${fundLookThroughWeight.toFixed(1)}% of portfolio value is held through funds whose underlying sector exposures are not included in the direct issuer sector totals. Do not describe a directly classified technology weight as the portfolio's total economic technology exposure.`,
          ), source, `${portfolio.id}:fund-look-through`))
        }
      }
      if (unpriced.length || fallbacks.length) {
        clips.push(tagClip(textClip(
          'Portfolio Manager',
          `${portfolioName} · allocation data quality`,
          [
            unpriced.length ? `${unpriced.length} position(s) are unpriced and excluded from portfolio weights: ${unpriced.map(holding => holding.ticker).join(', ')}.` : '',
            fallbacks.length ? `${fallbacks.length} position(s) use saved cost instead of a current quote: ${fallbacks.map(holding => holding.ticker).join(', ')}.` : '',
            'Do not recommend maintaining or changing the current allocation until every material position has a current mark.',
          ].filter(Boolean).join(' '),
        ), source, `${portfolio.id}:data-quality`))
      }
      return clips
    }

    case 'portfolio-risk': {
      if (!portfolio.holdings.length) return []
      const portfolioName = /^default$/i.test(portfolio.name.trim()) ? 'Portfolio' : portfolio.name
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
        ? `${portfolioName} · top ${selected.length} equity sleeve`
        : portfolioName
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
      const benchmarkMetric = record(array(data.metrics)[1])
      const series = record(array(data.series)[0])
      const periodReturn = finite(metric.period_return) ?? finite(metric.cagr)
      const benchmarkReturn = finite(benchmarkMetric.period_return) ?? finite(benchmarkMetric.cagr)
      const activeReturn = periodReturn != null && benchmarkReturn != null ? periodReturn - benchmarkReturn : null
      const periodDays = finite(metric.period_days)
      const returnLabel = periodDays != null && periodDays < 365 ? 'Period return' : 'CAGR'
      const clips: ClipDraft[] = [
        tagClip(kpiClip('Portfolio Compare', `${analysisName} risk metrics · ${horizon}`, [
          { label: returnLabel, value: percent(periodReturn), sub: `${horizon} · auto-adjusted close` },
          { label: `SPY ${returnLabel.toLowerCase()}`, value: percent(benchmarkReturn), sub: 'same dates and return method' },
          { label: 'Active return vs SPY', value: percent(activeReturn), sub: activeReturn == null ? 'Unavailable' : activeReturn >= 0 ? 'Outperformance' : 'Underperformance' },
          { label: 'Portfolio volatility', value: percent(metric.vol), sub: 'Daily returns annualized by √252' },
          { label: 'SPY volatility', value: percent(benchmarkMetric.vol), sub: 'Same dates and method' },
          { label: 'Portfolio Sharpe', value: finite(metric.sharpe) == null ? '—' : finite(metric.sharpe)!.toFixed(2), sub: `Annualized · ${finite(metric.risk_free_rate_pct)?.toFixed(2) ?? '—'}% risk-free rate` },
          { label: 'SPY Sharpe', value: finite(benchmarkMetric.sharpe) == null ? '—' : finite(benchmarkMetric.sharpe)!.toFixed(2), sub: 'Same dates, frequency, and risk-free rate' },
          { label: 'Portfolio max drawdown', value: percent(metric.max_drawdown) },
          { label: 'SPY max drawdown', value: percent(benchmarkMetric.max_drawdown) },
          { label: 'Portfolio single-factor beta vs SPY', value: finite(metric.beta) == null ? '—' : finite(metric.beta)!.toFixed(2), sub: `${horizon} · daily covariance / SPY variance` },
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
          {
            label: 'Sample',
            value: finite(metric.observations) == null ? '—' : `${finite(metric.observations)} observations`,
            sub: periodDays == null ? horizon : `${periodDays} calendar days`,
          },
        ]), source, `${portfolio.id}:metrics`),
        tagClip(tableClip(
          'Portfolio Compare',
          `${analysisName} · performance methodology`,
          ['Item', 'Definition'],
          [
            ['Data and period', `Yahoo Finance adjusted daily closes · ${horizon}`],
            ['Return', `Ending index / starting index - 1 · ${periodDays != null && periodDays < 365 ? 'period return' : 'CAGR'}`],
            ['Risk', 'Daily volatility annualized by √252. Drawdown uses the running peak.'],
            ['Beta', 'Portfolio single-factor covariance with SPY / SPY variance'],
            ['Sharpe / Sortino', `Annualized daily excess return · ${finite(metric.risk_free_rate_pct)?.toFixed(3) ?? '—'}% risk-free rate`],
            ['Scope', 'SPY is an analytical reference. Beta shocks are linear and exclude fees, taxes, gaps, and nonlinear holdings.'],
          ],
        ), source, `${portfolio.id}:methodology`),
      ]
      if ((portfolio.optionPositions ?? []).length) {
        clips.push(tagClip(textClip(
          'Portfolio Compare',
          `${analysisName} · derivative coverage limitation`,
          'The displayed return, volatility, Sharpe ratio, drawdown, beta, and stress statistics cover equities and cash only. Open option positions can create nonlinear delta, gamma, vega, theta, assignment, and expiry risk and are analyzed separately by underlying; these sleeve statistics are not whole-account statistics.',
        ), source, `${portfolio.id}:derivative-coverage`))
      }
      const portfolioBeta = finite(metric.beta)
      if (portfolioBeta != null) {
        clips.push(tagClip(tableClip(
          'Portfolio Compare',
          `${analysisName} market-shock scenario losses · beta-only sensitivity`,
          ['SPY shock', 'Beta-implied portfolio move'],
          [-5, -10, -15].map(shock => [
            `${shock}%`,
            `${(shock * portfolioBeta).toFixed(1)}%`,
          ]),
        ), source, `${portfolio.id}:beta-scenarios`))
      }
      const points = thin(array(series.points).map(point => ({
        date: plain(record(point).date),
        portfolio: finite(record(point).value),
      })).filter(point => point.portfolio != null))
      const benchmark = new Map(array(data.benchmark_points).map(point => [plain(record(point).date), finite(record(point).value)]))
      if (points.length) {
        const indexedRows = points.map(point => ({ ...point, SPY: benchmark.get(point.date) ?? null }))
        clips.push(tagClip(chartClip(
          'Portfolio Compare',
          `${analysisName} vs SPY · ${horizon}`,
          'line',
          'date',
          indexedRows,
          [{ key: 'portfolio', label: analysisName }, { key: 'SPY', label: 'SPY' }],
        ), source, `${portfolio.id}:performance`))
        clips.push(tagClip(chartClip(
          'Portfolio Compare',
          `${analysisName} active return vs SPY · ${horizon}`,
          'line',
          'date',
          indexedRows.map(point => ({
            date: point.date,
            activeReturn: point.SPY == null ? null : +(Number(point.portfolio) - Number(point.SPY)).toFixed(3),
          })),
          [{ key: 'activeReturn', label: 'Cumulative active return (pp)' }],
        ), source, `${portfolio.id}:active-return`))
        let portfolioPeak = -Infinity
        let benchmarkPeak = -Infinity
        const drawdowns = indexedRows.map(point => {
          portfolioPeak = Math.max(portfolioPeak, Number(point.portfolio))
          if (point.SPY != null) benchmarkPeak = Math.max(benchmarkPeak, Number(point.SPY))
          return {
            date: point.date,
            portfolioDrawdown: portfolioPeak > 0 ? ((Number(point.portfolio) / portfolioPeak) - 1) * 100 : null,
            benchmarkDrawdown: point.SPY != null && benchmarkPeak > 0 ? ((Number(point.SPY) / benchmarkPeak) - 1) * 100 : null,
          }
        })
        clips.push(tagClip(chartClip(
          'Portfolio Compare',
          `${analysisName} drawdown vs SPY · ${horizon}`,
          'line',
          'date',
          drawdowns,
          [{ key: 'portfolioDrawdown', label: `${analysisName} drawdown %` }, { key: 'benchmarkDrawdown', label: 'SPY drawdown %' }],
        ), source, `${portfolio.id}:drawdown`))
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

  await mapWithConcurrency(plan.sources, 3, async source => {
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
  })

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

export function buildReportDataBank(
  plan: ReportResearchPlan,
  result: ReportResearchResult,
  clips: ReportClip[],
): ReportDataBank {
  const requiredSourceIds = unique(plan.requiredSourceIds?.length
    ? plan.requiredSourceIds
    : plan.sources.map(source => source.id))
  const runs = requiredSourceIds.map((sourceId): ReportDataBankRun => {
    const source = plan.sources.find(candidate => candidate.id === sourceId)
    const sourceClips = clips.filter(clip => clip.origin === 'alphatape' && clip.researchSourceId === sourceId)
    const failures = result.failed.filter(failure => failure.sourceId === sourceId)
    const status = sourceClips.length
      ? failures.length ? 'partial' : 'complete'
      : 'failed'
    return {
      sourceId,
      label: source?.label ?? sourceId,
      status,
      targets: source?.targets ?? [],
      clipIds: sourceClips.map(clip => clip.id),
      missingTargets: failures.flatMap(failure => failure.target ? [failure.target] : []),
      error: failures.length
        ? failures.map(failure => failure.message).filter(Boolean).join(' ') || 'Some requested evidence did not complete.'
        : status === 'failed' ? 'No usable evidence returned.' : '',
    }
  })
  return {
    phase: 'complete',
    requiredSourceIds,
    runs,
    objectivePlan: plan.objectivePlan ?? {
      thesis: '',
      requiredDataPoints: [],
      requiredChecks: [],
    },
  }
}
