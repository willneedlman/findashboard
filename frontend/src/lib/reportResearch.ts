import axios from 'axios'
import { chartClip, kpiClip, tableClip, textClip } from './reportCaptureRegistry'
import type { ActivePortfolioContext } from './pmImport'
import { smaArr, emaArr, rsiArr, hvArr, bollinger } from './indicators'
import { parseChartDirective } from './researchDirective'
import {
  masterValuationBlocker,
  seedMasterValuationRequest,
  type MasterValuationFundamentals,
} from './masterValuationSeed'
import { normalizeTicker } from './pmImport'
import { fmtTailReturn } from './format'
import type { ClipDraft, EvidenceDomain, ReportClip, ReportScope } from './reportCreator'

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
  // Reachable since the evidence-selection rebuild. Each one answers a question
  // the report used to have no tool for; see backend/reporting/tool_registry.py
  // for the question tags that route to them.
  | 'asset-profile'
  | 'dividends'
  | 'debt-maturity'
  | 'seasonality'
  | 'options-unusual'
  | 'insider-activity'
  | 'institutional-ownership'
  | 'cot-positioning'
  | 'breadth'
  | 'sector-rrg'
  | 'pairs'
  | 'fx-matrix'
  | 'macro-cycle'
  | 'credit-stress'
  | 'housing'
  | 'ipo-calendar'
  | 'chokepoint-exposure'
  // Modelled tools. Each builds its request from a preceding fetch rather than
  // taking a bare ticker, which is why they came after the first pass.
  | 'master-valuation'
  | 'monte-carlo'
  | 'portfolio-optimizer'
  | 'portfolio-backtest'

export interface ReportResearchSource {
  id: ReportResearchSourceId
  label: string
  tool: string
  route: string
  reason: string
  targets: string[]
  domain: EvidenceDomain
  critical: boolean
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
  questions?: ReportResearchQuestion[]
  coverage?: ReportEvidenceCoverage
  planNotes?: string[]
  /** Caveat text per pull, so a section cannot claim past what the source supports. */
  evidenceLimits?: Record<string, string>
}

export interface ReportObjectivePlan {
  thesis: string
  requiredDataPoints: string[]
  requiredChecks: string[]
}

/** One analytical question the objective contains, with its closed-vocabulary tags. */
export interface ReportResearchQuestion {
  q: string
  tags: string[]
  priority: number
}

/** What the selected evidence covers. Drives the build note, not the fetch. */
export interface ReportEvidenceCoverage {
  evidenceClasses: Record<string, number>
  questionTags: Record<string, number>
  requiredClasses: string[]
  missingClasses: string[]
  toolCount: number
  distinctClasses: number
}

export interface ReportDataBankRun {
  sourceId: ReportResearchSourceId
  label: string
  status: 'complete' | 'partial' | 'failed'
  targets: string[]
  clipIds: string[]
  missingTargets: string[]
  error: string
  domain: EvidenceDomain
  critical: boolean
  requestedTargetCount: number
  coveredTargetCount: number
  coveragePct: number
  unresolvedGaps: string[]
}

export interface ReportDataBank {
  phase: 'ready' | 'blocked'
  requiredSourceIds: ReportResearchSourceId[]
  criticalSourceIds: ReportResearchSourceId[]
  runs: ReportDataBankRun[]
  objectivePlan: ReportObjectivePlan
  coverage: {
    requestedTargets: number
    coveredTargets: number
    targetCoveragePct: number
    domainCoveragePct: Record<EvidenceDomain, number>
  }
  unresolvedGaps: string[]
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

const SOURCE_META: Record<ReportResearchSourceId, Omit<ReportResearchSource, 'reason' | 'targets' | 'critical'>> = {
  portfolio: { id: 'portfolio', label: 'Active book', tool: 'Portfolio Manager', route: '/portfolio-manager', domain: 'portfolio' },
  'portfolio-risk': { id: 'portfolio-risk', label: 'Risk and performance', tool: 'Portfolio Compare', route: '/portfolio-compare', domain: 'portfolio' },
  company: { id: 'company', label: 'Company snapshot', tool: 'Earnings Scanner', route: '/earnings', domain: 'issuer' },
  'price-history': { id: 'price-history', label: 'Price and drawdown', tool: 'Chart Studio', route: '/chart-studio', domain: 'issuer' },
  'market-compare': { id: 'market-compare', label: 'Relative performance', tool: 'Asset Overlay', route: '/asset-overlay', domain: 'benchmark' },
  mover: { id: 'mover', label: 'Catalyst scan', tool: 'Mover Radar', route: '/mover-radar', domain: 'issuer' },
  news: { id: 'news', label: 'Recent news', tool: 'Mover Radar', route: '/mover-radar', domain: 'issuer' },
  options: { id: 'options', label: 'Options snapshot', tool: 'Options Desk', route: '/options', domain: 'issuer' },
  earnings: { id: 'earnings', label: 'Earnings calendar', tool: 'Earnings Scanner', route: '/earnings', domain: 'issuer' },
  'global-markets': { id: 'global-markets', label: 'Global market board', tool: 'Global Markets', route: '/global-markets', domain: 'macro' },
  'macro-events': { id: 'macro-events', label: 'Macro event calendar', tool: 'Macro Event Hub', route: '/macro-events', domain: 'macro' },
  sentiment: { id: 'sentiment', label: 'Market sentiment', tool: 'Sentiment Tracker', route: '/sentiment', domain: 'macro' },
  'sector-rotation': { id: 'sector-rotation', label: 'Sector leadership', tool: 'Sector Rotation', route: '/sector-rotation', domain: 'benchmark' },
  correlation: { id: 'correlation', label: 'Correlation structure', tool: 'Correlation', route: '/correlation', domain: 'portfolio' },
  regression: { id: 'regression', label: 'Regression model', tool: 'Regression', route: '/regression', domain: 'benchmark' },
  'factor-decomposition': { id: 'factor-decomposition', label: 'Factor exposures', tool: 'Factor Decomposition', route: '/factor-decomposition', domain: 'portfolio' },
  'credit-spreads': { id: 'credit-spreads', label: 'Credit risk regime', tool: 'Credit Spreads', route: '/credit-spreads', domain: 'macro' },
  'rate-engine': { id: 'rate-engine', label: 'Rates and Fed path', tool: 'Rate Engine', route: '/fed', domain: 'macro' },
  'peer-valuation': { id: 'peer-valuation', label: 'Peer valuation', tool: 'Peer Comparison', route: '/relative-valuation', domain: 'issuer' },
  'dcf-valuation': { id: 'dcf-valuation', label: 'DCF valuation', tool: 'DCF Valuation', route: '/dcf', domain: 'issuer' },
  'volatility-skew': { id: 'volatility-skew', label: 'Volatility skew', tool: 'Volatility Skew', route: '/skew', domain: 'issuer' },
  'dealer-gex': { id: 'dealer-gex', label: 'Dealer gamma', tool: 'Dealer Exposure', route: '/gex', domain: 'issuer' },
  'implied-probability': { id: 'implied-probability', label: 'Implied probability', tool: 'Implied Probability', route: '/probability', domain: 'issuer' },
  'asset-profile': { id: 'asset-profile', label: 'Instrument profile', tool: 'Global Markets', route: '/global-markets', domain: 'benchmark' },
  dividends: { id: 'dividends', label: 'Dividend profile', tool: 'Portfolio Manager', route: '/portfolio-manager', domain: 'issuer' },
  'debt-maturity': { id: 'debt-maturity', label: 'Debt and maturity wall', tool: 'Company Profile', route: '/company-profile', domain: 'issuer' },
  seasonality: { id: 'seasonality', label: 'Seasonal pattern', tool: 'Seasonality', route: '/seasonality', domain: 'issuer' },
  'options-unusual': { id: 'options-unusual', label: 'Unusual options activity', tool: 'Options Scanner', route: '/options-scanner', domain: 'issuer' },
  'insider-activity': { id: 'insider-activity', label: 'Insider activity', tool: 'Company Profile', route: '/company-profile', domain: 'issuer' },
  'institutional-ownership': { id: 'institutional-ownership', label: 'Institutional ownership', tool: 'Company Profile', route: '/company-profile', domain: 'issuer' },
  'cot-positioning': { id: 'cot-positioning', label: 'Futures positioning', tool: 'Trader Positioning', route: '/trader-positioning', domain: 'macro' },
  breadth: { id: 'breadth', label: 'Market breadth', tool: 'Market Breadth', route: '/breadth', domain: 'benchmark' },
  'sector-rrg': { id: 'sector-rrg', label: 'Rotation graph', tool: 'Sector Rotation', route: '/sector-rotation', domain: 'benchmark' },
  pairs: { id: 'pairs', label: 'Pair relationship', tool: 'Pairs Trader', route: '/pairs-trader', domain: 'benchmark' },
  'fx-matrix': { id: 'fx-matrix', label: 'Currency matrix', tool: 'FX Matrix', route: '/currency', domain: 'macro' },
  'macro-cycle': { id: 'macro-cycle', label: 'Business cycle read', tool: 'Macro Monitor', route: '/economy', domain: 'macro' },
  'credit-stress': { id: 'credit-stress', label: 'Credit stress', tool: 'Credit Stress', route: '/credit-delinquencies', domain: 'macro' },
  housing: { id: 'housing', label: 'Housing market', tool: 'Housing Market', route: '/housing', domain: 'macro' },
  'ipo-calendar': { id: 'ipo-calendar', label: 'IPO calendar', tool: 'IPO Scanner', route: '/ipo-calendar', domain: 'macro' },
  'chokepoint-exposure': { id: 'chokepoint-exposure', label: 'Chokepoint exposure', tool: 'Chokepoint Exposure', route: '/chokepoint-exposure', domain: 'macro' },
  'master-valuation': { id: 'master-valuation', label: 'Multi-method valuation', tool: 'Master Valuation', route: '/master-valuation', domain: 'issuer' },
  'monte-carlo': { id: 'monte-carlo', label: 'Simulated outcome range', tool: 'Monte Carlo', route: '/montecarlo', domain: 'portfolio' },
  'portfolio-optimizer': { id: 'portfolio-optimizer', label: 'Allocation efficiency', tool: 'Portfolio Allocator', route: '/portfolio-optimizer', domain: 'portfolio' },
  'portfolio-backtest': { id: 'portfolio-backtest', label: 'Strategy backtest', tool: 'Portfolio Backtester', route: '/backtest', domain: 'portfolio' },
}

type ResearchTargetMode = 'market' | 'symbols' | 'portfolio' | 'portfolio-or-symbols'

export interface ReportResearchToolCatalogItem {
  id: ReportResearchSourceId
  label: string
  description: string
  targetMode: ResearchTargetMode
  producesVisuals: boolean
  domain: EvidenceDomain
}

const REPORT_RESEARCH_TOOL_CATALOG_BASE: Omit<ReportResearchToolCatalogItem, 'domain'>[] = [
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
  { id: 'asset-profile', label: 'Instrument profile', description: 'Return ladder, position in the 52-week range, realised volatility, drawdown, and benchmark relationship for one instrument or index.', targetMode: 'symbols', producesVisuals: false },
  { id: 'dividends', label: 'Dividend profile', description: 'Forward annual dividend per share and yield for each named holding.', targetMode: 'symbols', producesVisuals: false },
  { id: 'debt-maturity', label: 'Debt and maturity wall', description: 'Scheduled debt maturities by year from the latest annual filing, and total debt outstanding.', targetMode: 'symbols', producesVisuals: true },
  { id: 'seasonality', label: 'Seasonal pattern', description: 'Month-of-year, weekday, and turn-of-month return patterns with the sample size behind each.', targetMode: 'symbols', producesVisuals: true },
  { id: 'options-unusual', label: 'Unusual options activity', description: 'Contracts trading far above their open interest, by volume, premium, and moneyness.', targetMode: 'symbols', producesVisuals: false },
  { id: 'insider-activity', label: 'Insider activity', description: 'Recent Form 4 insider buys and sells with size, role, and 10b5-1 status.', targetMode: 'symbols', producesVisuals: false },
  { id: 'institutional-ownership', label: 'Institutional ownership', description: '13F holder base, quarter-on-quarter position changes, and float held.', targetMode: 'symbols', producesVisuals: false },
  { id: 'cot-positioning', label: 'Futures positioning', description: 'CFTC Commitments of Traders net positioning and weekly flow by trader cohort.', targetMode: 'market', producesVisuals: true },
  { id: 'breadth', label: 'Market breadth', description: 'Advance-decline, new highs and lows, share of members above their moving averages, and index-versus-breadth divergence.', targetMode: 'market', producesVisuals: true },
  { id: 'sector-rrg', label: 'Rotation graph', description: 'Relative-strength and momentum coordinates per sector against the benchmark, with the quadrant each rotated in from.', targetMode: 'market', producesVisuals: true },
  { id: 'pairs', label: 'Pair relationship', description: 'Cointegration, hedge ratio, spread z-score, half-life, and the historical spread trade record for two names.', targetMode: 'symbols', producesVisuals: false },
  { id: 'fx-matrix', label: 'Currency matrix', description: 'Cross-rate matrix, forward points, basis, implied volatility, and short rates across the majors.', targetMode: 'market', producesVisuals: true },
  { id: 'macro-cycle', label: 'Business cycle read', description: 'Composite cycle score and phase from payrolls, unemployment, the yield curve, and related components.', targetMode: 'market', producesVisuals: false },
  { id: 'credit-stress', label: 'Credit stress', description: 'Observed delinquency and charge-off rates by asset class, with Federal Reserve stress indicators.', targetMode: 'market', producesVisuals: true },
  { id: 'housing', label: 'Housing market', description: 'Mortgage rates, median price, affordability, months of supply, and delinquency.', targetMode: 'market', producesVisuals: false },
  { id: 'ipo-calendar', label: 'IPO calendar', description: 'Priced and upcoming listings with deal size, as a read on primary-market risk appetite.', targetMode: 'market', producesVisuals: false },
  { id: 'chokepoint-exposure', label: 'Chokepoint exposure', description: 'Maritime chokepoint transit stress and the listed companies most exposed to it.', targetMode: 'market', producesVisuals: true },
  { id: 'master-valuation', label: 'Multi-method valuation', description: 'One model carrying DCF, exit multiples, dividend discount and sum-of-the-parts side by side, plus the reverse-DCF read of what the market price already assumes.', targetMode: 'symbols', producesVisuals: true },
  { id: 'monte-carlo', label: 'Simulated outcome range', description: 'Forward distribution of portfolio value from simulated paths, with tail loss measures.', targetMode: 'portfolio-or-symbols', producesVisuals: true },
  { id: 'portfolio-optimizer', label: 'Allocation efficiency', description: 'The current book scored against max-Sharpe, minimum-variance, risk-parity and equal-weight allocations on one efficient frontier.', targetMode: 'portfolio', producesVisuals: true },
  { id: 'portfolio-backtest', label: 'Strategy backtest', description: 'The saved rule-based strategy replayed over history across the book, with its trade record.', targetMode: 'portfolio-or-symbols', producesVisuals: true },
]

export const REPORT_RESEARCH_TOOL_CATALOG: ReportResearchToolCatalogItem[] = REPORT_RESEARCH_TOOL_CATALOG_BASE.map(item => ({
  ...item,
  domain: SOURCE_META[item.id].domain,
}))

const HISTORICAL_RESEARCH_SOURCES = new Set<ReportResearchSourceId>([
  'price-history',
  'market-compare',
  'portfolio-risk',
  'sector-rotation',
  'correlation',
  'regression',
  'factor-decomposition',
  'credit-spreads',
  'seasonality',
  'breadth',
  'sector-rrg',
  'pairs',
  'cot-positioning',
  'master-valuation',
  'monte-carlo',
  'portfolio-optimizer',
  'portfolio-backtest',
])

const FORWARD_RESEARCH_SOURCES = new Set<ReportResearchSourceId>([
  'earnings',
  'macro-events',
  'implied-probability',
  'ipo-calendar',
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
  )
}

export function inferResearchSymbols(value: string): string[] {
  const matches = value.match(/\$?[A-Z^][A-Z0-9.^=-]{0,11}\b/g) ?? []
  return unique(
    matches
      .map(match => normalizeTicker(match.replace(/^\$/, '')))
      .filter(symbol => !SYMBOL_STOP.has(symbol)),
  )
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

const CRITICAL_SOURCES: Record<ReportResearchIntent, ReadonlySet<ReportResearchSourceId>> = {
  portfolio: new Set(['portfolio', 'portfolio-risk', 'correlation', 'factor-decomposition']),
  macro: new Set(['global-markets', 'macro-events']),
  options: new Set(['company', 'options', 'volatility-skew', 'implied-probability']),
  catalyst: new Set(['company', 'mover', 'news']),
  comparison: new Set(['company', 'market-compare', 'regression']),
  valuation: new Set(['company', 'peer-valuation', 'dcf-valuation']),
  company: new Set(['company', 'price-history']),
}

function isCriticalSource(intent: ReportResearchIntent, sourceId: ReportResearchSourceId): boolean {
  return CRITICAL_SOURCES[intent].has(sourceId)
}

function portfolioSymbols(portfolio: ActivePortfolioContext): string[] {
  return [...portfolio.holdings]
    .filter(holding => holding.shares !== 0)
    .sort((a, b) => Math.abs(b.shares * b.avgCost) - Math.abs(a.shares * a.avgCost))
    .map(holding => normalizeTicker(holding.ticker))
    .filter(Boolean)
}

function portfolioOptionSymbols(portfolio: ActivePortfolioContext): string[] {
  return unique((portfolio.optionPositions ?? [])
    .map(position => normalizeTicker(position.underlying))
    .filter(Boolean))
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
  const bookSymbols = unique([...equitySymbols, ...optionSymbols])
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
    sources.push({
      ...SOURCE_META[id],
      reason: `${reason}${truncationNote(id, targets, resolved)}`,
      targets: resolved,
      critical: isCriticalSource(intent, id),
      selectionOrigin: 'baseline',
    })
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
      add('company', 'Review fundamentals, growth, valuation, analyst expectations, and company-specific risks for every actual holding.', bookSymbols)
      add('price-history', 'Measure return paths and drawdowns across every actual holding.', bookSymbols)
      add('news', 'Capture current catalysts and changes in the information set for every actual holding.', bookSymbols)
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
      add('peer-valuation', 'Benchmark every eligible holding against relevant peers, operating quality, and consensus targets.', bookSymbols)
      add('dcf-valuation', 'Build intrinsic-value anchors and sensitivities for every eligible holding.', bookSymbols)
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
  // Number(null) is 0 and Number('') is 0, so coercing first turns an explicit
  // "not computed" from an API into a hard zero. A null DDM leg rendered as
  // $0.00 with -100% upside is a fabricated number in a report, not a gap.
  if (value == null || value === '') return null
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
/** Fixed-precision number for a table cell, or null when unavailable.
 *
 * A column of numbers has to share a precision or the eye cannot compare down
 * it. Returns a number rather than a string so sorting and charting still work.
 */
const round = (value: unknown, digits: number): number | null => {
  const parsed = finite(value)
  return parsed == null ? null : Number(parsed.toFixed(digits))
}

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
    evidenceDomain: source.domain,
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
const MULTI_ASSET_SOURCES = new Set<ReportResearchSourceId>(['correlation', 'regression', 'market-compare', 'pairs'])

// What each relationship tool can actually take. Correlation rejects more than
// twelve tickers with a 400, which is not retryable and surfaced as the generic
// "Research source did not complete" — so every book with more than twelve
// holdings lost its correlation evidence and the message never said why.
// Pairs takes exactly two, and an overlay past eight lines is unreadable.
const MULTI_ASSET_LIMIT: Partial<Record<ReportResearchSourceId, number>> = {
  correlation: 12,
  'market-compare': 8,
  pairs: 2,
}

function targetsForSource(sourceId: ReportResearchSourceId, symbols: string[]): string[] {
  // Symbols arrive ordered by position size, so truncating keeps the holdings
  // that actually move the book.
  const resolved = unique(symbols.map(normalizeTicker).filter(Boolean))
  const limit = MULTI_ASSET_LIMIT[sourceId]
  return limit ? resolved.slice(0, limit) : resolved
}

/** Says so when a relationship tool could not take every subject.
 *
 * A truncated basket that reports 100% coverage reads as "all holdings are this
 * correlated", which is a stronger claim than the evidence supports. The note
 * rides on the source's reason so it shows in the plan and in the data bank.
 */
function truncationNote(sourceId: ReportResearchSourceId, requested: string[], resolved: string[]): string {
  const asked = unique(requested.map(normalizeTicker).filter(Boolean)).length
  if (resolved.length >= asked) return ''
  return ` Covers the largest ${resolved.length} of ${asked} subjects by position size; ${asked - resolved.length} excluded.`
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
    // The template decides which evidence classes the plan must cover, and the
    // length decides how many pulls it may carry. Both are enforced server-side,
    // so they have to travel with the request rather than be inferred from prose.
    templateId: scope.reportType,
    length: scope.length,
    // Costs the evidence budget from the real section count rather than mapping
    // a custom size onto the nearest preset.
    sectionCount: scope.customSections ?? 0,
    // Anything the horizon rules out is unavailable, not merely unattractive.
    // Telling the planner keeps it from spending a shortlist slot on a tool the
    // client would then silently refuse to run.
    disabledSourceIds: REPORT_RESEARCH_TOOL_CATALOG
      .filter(tool => !sourceMatchesHorizon(tool.id, scope)
        // A strategy backtest with no saved strategy has nothing to replay, and
        // inventing a rule set would attribute a strategy the user never chose.
        || (tool.id === 'portfolio-backtest' && !hasSavedStrategyForBacktest()))
      .map(tool => tool.id),
  }))
  const additions = array(response.additions)
  const catalog = new Map(toolCatalog.map(item => [item.id, item]))
  const sources = [...baseline.sources]
  const portfolioRelationshipTargets = usesActivePortfolio(scope, portfolio)
    ? portfolioSymbols(portfolio)
    : baseline.symbols
  // No addition cap here any more. The server enforces a budget derived from the
  // report length and will not return more than the note can carry, so a second
  // cap on this side could only silently drop evidence the coverage floor had
  // just added to close a gap.
  for (const raw of additions) {
    const addition = record(raw)
    const id = String(addition.id ?? '') as ReportResearchSourceId
    const item = catalog.get(id)
    if (!item || sources.some(source => source.id === id)) continue
    const hasPortfolio = usesActivePortfolio(scope, portfolio)
    if (item.targetMode === 'symbols' && baseline.symbols.length === 0) continue
    if (item.targetMode === 'portfolio' && !hasPortfolio) continue
    if (item.targetMode === 'portfolio-or-symbols' && !hasPortfolio && baseline.symbols.length === 0) continue
    if (MULTI_ASSET_SOURCES.has(id) && portfolioRelationshipTargets.length < 2) continue
    const reason = String(addition.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 220)
    if (!reason) continue
    const requested = MULTI_ASSET_SOURCES.has(id)
      ? portfolioRelationshipTargets
      : baseline.intent === 'comparison' || baseline.intent === 'portfolio'
        ? baseline.symbols
        : baseline.symbols.slice(0, 1)
    const resolved = item.targetMode === 'market' || item.targetMode === 'portfolio'
      ? []
      : targetsForSource(id, requested)
    sources.push({
      ...SOURCE_META[id],
      reason: `${reason}${resolved.length ? truncationNote(id, requested, resolved) : ''}`,
      critical: isCriticalSource(baseline.intent, id),
      targets: resolved,
      selectionOrigin: 'ai',
    })
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
    questions: array(response.questions).map(raw => {
      const question = record(raw)
      return {
        q: plain(question.q) === '—' ? '' : plain(question.q),
        tags: array(question.tags).map(plain).filter(tag => tag !== '—'),
        priority: finite(question.priority) ?? 9,
      }
    }).filter(question => question.q),
    coverage: response.coverage ? (response.coverage as ReportEvidenceCoverage) : undefined,
    planNotes: array(response.planNotes).map(plain).filter(note => note !== '—'),
    evidenceLimits: record(response.evidenceLimits) as Record<string, string>,
  }
}

async function perTickerWith(
  source: ReportResearchSource,
  run: (ticker: string) => Promise<ClipDraft | ClipDraft[] | null>,
  targetErrors?: Map<string, string>,
): Promise<ClipDraft[]> {
  const settled = await mapSettledWithConcurrency(source.targets, 2, run)
  return settled.flatMap((result, index) => {
    if (result.status === 'rejected') {
      // Without this the reason was discarded and every per-ticker failure read
      // "No usable data returned", whether the source was throttled, rejected
      // the request, or genuinely had nothing for that name.
      targetErrors?.set(`${source.id}:${source.targets[index]}`, failureMessage(result.reason))
      return []
    }
    if (!result.value) return []
    return Array.isArray(result.value) ? result.value : [result.value]
  })
}

async function runSource(
  source: ReportResearchSource,
  scope: ReportScope,
  portfolio: ActivePortfolioContext,
  client: ResearchClient,
  targetErrors?: Map<string, string>,
): Promise<ClipDraft[]> {
  // Shadows the module helper so every per-ticker case records why a target
  // failed without each of the seventeen call sites having to pass the sink.
  const perTicker = (
    forSource: ReportResearchSource,
    run: (ticker: string) => Promise<ClipDraft | ClipDraft[] | null>,
  ) => perTickerWith(forSource, run, targetErrors)
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
            segmentRows.map(row => [
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
            activityNames.map(name => ({ key: name, label: `${name} ($B)`, unit: 'currency' as const })),
          ), source, `${ticker}:activity-history`, ticker))
        }

        const geographicRows = array(record(profile.geo_segments).latest).map(record)
          .filter(row => plain(row.name) !== '—' && finite(row.pct) != null)
        if (geographicRows.length >= 2) {
          clips.push(tagClip(tableClip(
            'Corporate Hub',
            `Geographic Segments · ${ticker}`,
            ['Region', 'Value', 'Share %'],
            geographicRows.map(row => [
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
              ...(revenue ? [{ key: 'revenue', label: 'Revenue ($M)', unit: 'currency' as const }] : []),
              ...(netIncome ? [{ key: 'netIncome', label: 'Net income ($M)', unit: 'currency' as const }] : []),
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
            [{ key: 'subject', label: ticker, unit: 'multiple' }, { key: 'median', label: 'Peer median', unit: 'multiple' }],
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
            [{ key: 'subject', label: ticker, unit: 'percent' }, { key: 'median', label: 'Peer median', unit: 'percent' }],
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
            [{ key: 'upside', label: 'Consensus upside %', unit: 'percent' }],
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
        // Naming the blocker beats a bare "no usable data": a pre-revenue or
        // newly listed name is a fact about the company, not a source outage,
        // and the report should say which.
        if (revenue == null || revenue <= 0) {
          throw new Error('No reported revenue, so a discounted cash flow cannot be built.')
        }
        if (shares == null || shares <= 0) {
          throw new Error('No share count reported, so a per-share value cannot be derived.')
        }
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
            { label: 'Market price', value: money(marketPrice), sub: 'Latest value returned by the fundamentals source. Verify quote time before acting' },
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
            { label: 'Starting revenue', value: moneyMillions(revenue), sub: 'Model input. USD millions' },
            { label: 'Year 1 revenue', value: moneyMillions(firstRevenue), sub: 'Model output. USD millions' },
            { label: `Year ${plain(fcfs[fcfs.length - 1].year)} revenue`, value: moneyMillions(lastRevenue), sub: 'Model output. USD millions' },
            { label: `Y1–Y${plain(fcfs[fcfs.length - 1].year)} CAGR`, value: projectionCagr == null ? '—' : percent(projectionCagr), sub: `${intervals} compounding intervals` },
            { label: 'Cumulative growth', value: cumulativeGrowth == null ? '—' : percent(cumulativeGrowth), sub: 'Not an annualized rate' },
          ]), source, `${ticker}:projection-math`, ticker))
          clips.push(tagClip(chartClip(
            'DCF Valuation',
            `${ticker} revenue projection`,
            'bar',
            'year',
            fcfs.map(row => ({ year: `Y${plain(row.year)}`, revenue: finite(row.revenue) == null ? null : finite(row.revenue)! / 1000 })),
            [{ key: 'revenue', label: 'Revenue (USD billions)', unit: 'currency' }],
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
            [{ key: 'fcf', label: 'Free cash flow (USD billions)', unit: 'currency' }, { key: 'presentValue', label: 'PV of FCF (USD billions)', unit: 'currency' }],
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
              { key: 'low', label: 'Low $/share', unit: 'currency' },
              { key: 'base', label: 'Base $/share', unit: 'currency' },
              { key: 'high', label: 'High $/share', unit: 'currency' },
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
          { label: 'Years 1-3 growth', value: `${growth1.toFixed(1)}%` },
          { label: 'Years 4-7 growth', value: `${growth2.toFixed(1)}%` },
          { label: 'Years 8-10 growth', value: `${growth3.toFixed(1)}%` },
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
        const series: { key: string; label: string; unit: 'currency' }[] = [{ key: 'price', label: ticker, unit: 'currency' }]
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
        for (const key of Object.keys(priced)) series.push({ key, label: key, unit: 'currency' })
        for (const sym of Object.keys(overlaySeries)) series.push({ key: sym, label: `${sym} (rebased)`, unit: 'currency' })

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
            'line', 'date', thin(oscRows), oscillators.map(o => ({
              key: o.label,
              label: o.label,
              unit: o.kind === 'hv' ? 'percent' as const : 'index' as const,
            })))
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
        tickers.map(ticker => ({ key: ticker, label: ticker, unit: 'index' as const })),
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
            [{ key: 'volatility', label: 'Volatility %', unit: 'percent' }],
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
            [{ key: 'iv', label: 'Implied volatility %', unit: 'percent' }],
          ), source, `${ticker}:smile-visual`, ticker))
        }
        if (terms.length) {
          clips.push(tagClip(chartClip(
            'Volatility Skew',
            `${ticker} volatility term structure`,
            'line',
            'dte',
            terms.map(term => ({ dte: finite(term.dte), atmIv: finite(term.atm_iv), downsideSkew: finite(term.rr_25) })),
            [{ key: 'atmIv', label: 'ATM IV %', unit: 'percent' }, { key: 'downsideSkew', label: '25Δ put skew', unit: 'percentage-point' }],
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
            [{ key: 'netGex', label: 'Net GEX ($M)', unit: 'currency' }],
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
            [{ key: 'callGex', label: 'Call GEX ($M)', unit: 'currency' }, { key: 'putGex', label: 'Put GEX ($M)', unit: 'currency' }],
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
              { key: 'upper', label: '~85th percentile', unit: 'currency' },
              { key: 'median', label: 'Median', unit: 'currency' },
              { key: 'lower', label: '~15th percentile', unit: 'currency' },
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
            [{ key: 'density', label: 'Probability density %', unit: 'percent' }],
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
            [{ key: 'probability', label: 'Finish-above probability %', unit: 'percent' }],
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
          [{ key: 'change', label: 'Change %', unit: 'percent' }],
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
          [{ key: 'share', label: 'Share %', unit: 'percent' }],
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
          [{ key: 'momentum', label: 'Momentum score (pp)', unit: 'percentage-point' }],
          {
            barOrientation: 'horizontal',
            details: [
              { key: 'oneWeek', label: '1W return %', unit: 'percent' },
              { key: 'oneMonth', label: '1M return %', unit: 'percent' },
              { key: 'threeMonth', label: '3M return %', unit: 'percent' },
              { key: 'vsSpyOneMonth', label: 'Vs SPY · 1M %', unit: 'percent' },
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
          [{ key: 'actual', label: `${dependent} actual`, unit: 'number' }, { key: 'fitted', label: 'Model fitted', unit: 'number' }],
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
          [{ key: 'residual', label: 'Residual', unit: 'number' }],
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
            // Strings, not numbers: +(1).toFixed(2) is 1, so the diagonal
            // printed as "1" beside "0.42" and the column could not be read
            // down. A correlation matrix is display-only, so fixed width wins.
            ...tickers.map(columnTicker => {
              const value = lookup.get(`${rowTicker}|${columnTicker}`)
              return value == null ? null : value.toFixed(2)
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
          [{ key: 'correlation', label: 'Correlation', unit: 'correlation' }],
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
          [{ key: 'beta', label: 'Beta', unit: 'beta' }],
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
          [{ key: 'correlation', label: `${plain(rolling.window)}-day correlation`, unit: 'correlation' }],
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
            [{ key: 'beta', label: 'Beta', unit: 'beta' }],
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
            // Rounded here rather than at render: the raw floats printed as a
            // ragged column of 2.3548 next to 1.181 next to 6, which reads as
            // four different precisions for the same measurement.
            holdingsDetail.map(holding => [
              plain(holding.ticker),
              round(holding.weight, 1),
              round(record(holding.betas).market, 2),
              round(holding.book_var_share_pct, 1),
              round(holding.idiosyncratic_pct, 1),
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
              { key: 'beta', label: 'Rolling beta', unit: 'beta' },
              { key: 'fullSample', label: 'Full-sample beta', unit: 'beta' },
              { key: 'lower95', label: '95% lower', unit: 'beta' },
              { key: 'upper95', label: '95% upper', unit: 'beta' },
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
          entries.slice(0, 6).map(([key, value]) => ({
            key,
            label: plain(record(value).label ?? key),
            unit: key === 'vix' ? 'index' as const : 'basis-point' as const,
          })),
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
          [{ key: 'rate', label: 'Implied rate %', unit: 'percent' }],
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
            { key: 'today', label: 'Today', unit: 'percent' },
            { key: '1D ago', label: '1D ago', unit: 'percent' },
            { key: '1M ago', label: '1M ago', unit: 'percent' },
            { key: '6M ago', label: '6M ago', unit: 'percent' },
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
      const sectorPairs = await Promise.all(valued.map(async holding => {
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
          [{ key: 'weight', label: 'Portfolio weight %', unit: 'percent' }],
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
      const selected = priced
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
          [{ key: 'portfolio', label: analysisName, unit: 'index' }, { key: 'SPY', label: 'SPY', unit: 'index' }],
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
          [{ key: 'activeReturn', label: 'Cumulative active return (pp)', unit: 'percentage-point' }],
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
          [{ key: 'portfolioDrawdown', label: `${analysisName} drawdown %`, unit: 'percent' }, { key: 'benchmarkDrawdown', label: 'SPY drawdown %', unit: 'percent' }],
        ), source, `${portfolio.id}:drawdown`))
      }
      return clips
    }

    // ── Tools the report reached for the first time in the evidence rebuild ──
    // Each one closes a question the planner could previously find no tool for.
    // They follow the same contract as the cases above: return [] rather than
    // throw when the source has nothing, so one thin answer degrades that pull
    // to a recorded gap instead of failing the report.

    case 'asset-profile':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/market/asset-profile?ticker=${encodeURIComponent(ticker)}`))
        const stats = record(data.stats)
        const returns = record(stats.returns)
        const band = record(stats.range_52w)
        if (finite(stats.last) == null) return null
        const vsBenchmark = record(stats.vs_benchmark)
        const cells = [
          { label: 'Last', value: finite(stats.last)!.toLocaleString(undefined, { maximumFractionDigits: 2 }), sub: plain(stats.as_of) },
          ...['1D', '1W', '1M', '3M', '6M', 'YTD', '1Y'].map(key => ({
            label: `Return ${key}`, value: percent(returns[key]),
          })),
          { label: '30d realised volatility', value: percent(stats.vol_30d), sub: 'Annualised' },
          { label: 'Max drawdown 1y', value: percent(stats.max_drawdown_1y) },
        ]
        if (finite(band.position_pct) != null) {
          cells.push({
            label: 'Position in 52w range',
            value: `${finite(band.position_pct)!.toFixed(0)}%`,
            sub: `${finite(band.low)?.toFixed(2) ?? '—'} to ${finite(band.high)?.toFixed(2) ?? '—'}`,
          })
        }
        if (finite(vsBenchmark.beta) != null) {
          // A beta on a market that does not overlap the benchmark's session is
          // measured on lagged returns, and saying so is the difference between
          // 0.52 and 2.09 for an index like the KOSPI.
          const lag = finite(vsBenchmark.correlation_lag_days) ?? 0
          cells.push({
            label: `Beta vs ${plain(vsBenchmark.benchmark_label) === '—' ? 'benchmark' : plain(vsBenchmark.benchmark_label)}`,
            value: finite(vsBenchmark.beta)!.toFixed(2),
            sub: `Correlation ${finite(vsBenchmark.correlation)?.toFixed(2) ?? '—'}${
              vsBenchmark.session_offset ? ` · lagged ${lag}d for non-overlapping sessions` : ''}`,
          })
        }
        return tagClip(kpiClip('Global Markets', `${ticker} · instrument profile`, cells), source, ticker, ticker)
      })

    case 'dividends': {
      const targets = source.targets.slice(0, 25)
      if (!targets.length) return []
      const data = record(await client.get(`/api/market/dividends?tickers=${encodeURIComponent(targets.join(','))}`))
      const rows = targets
        .map(ticker => {
          const row = record(data[ticker])
          return [ticker, finite(row.annual_dividend), finite(row.dividend_yield)]
        })
        .filter(row => row[1] != null || row[2] != null)
      if (!rows.length) return []
      return [tagClip(tableClip(
        'Portfolio Manager',
        'Dividend profile',
        ['Ticker', 'Annual dividend $/share', 'Yield %'],
        rows,
      ), source, 'dividends')]
    }

    case 'debt-maturity':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/corporate/debt-maturity?ticker=${encodeURIComponent(ticker)}`))
        const buckets = array(data.buckets)
          .map(item => ({ bucket: plain(record(item).label), amount: finite(record(item).amount) }))
          .filter(row => row.amount != null)
        if (!buckets.length) return null
        const scale = 1e9
        return [
          tagClip(kpiClip('Company Profile', `${ticker} · debt outstanding`, [
            { label: 'Total debt', value: moneyMillions(data.total) },
            { label: 'Fiscal year', value: plain(data.fiscal_year), sub: `Filed ${plain(data.filed)}` },
            { label: 'Source', value: 'SEC 10-K (XBRL)', sub: `As of ${plain(data.as_of)}` },
          ]), source, ticker, ticker),
          tagClip(chartClip(
            'Company Profile',
            `${ticker} · debt maturing by period`,
            'bar',
            'bucket',
            buckets.map(row => ({ bucket: row.bucket, amount: +(row.amount! / scale).toFixed(2) })),
            [{ key: 'amount', label: 'Maturing $bn', unit: 'number' }],
          ), source, `${ticker}:maturity-wall`, ticker),
        ]
      })

    case 'seasonality':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/market/seasonality?ticker=${encodeURIComponent(ticker)}`))
        if (!data.available) return null
        const months = array(data.months).map(item => record(item))
        if (!months.length) return null
        const stat = (value: unknown) => record(value)
        const current = stat(data.current_month)
        const best = stat(data.best_month)
        const worst = stat(data.worst_month)
        // The sample size is the story. Twenty Augusts is not a forecast, and a
        // hit rate quoted without its n invites exactly that misreading.
        const describe = (row: Record<string, any>) =>
          `${percent(row.mean_pct)} mean · ${finite(row.hit_rate_pct)?.toFixed(0) ?? '—'}% hit · n=${plain(row.n)}`
        return [
          tagClip(kpiClip('Seasonality', `${ticker} · seasonal record`, [
            { label: `Current month (${plain(current.label)})`, value: percent(current.mean_pct), sub: describe(current) },
            { label: `Best month (${plain(best.label)})`, value: percent(best.mean_pct), sub: describe(best) },
            { label: `Worst month (${plain(worst.label)})`, value: percent(worst.mean_pct), sub: describe(worst) },
            { label: 'Sample', value: `${finite(data.years_covered)?.toFixed(0) ?? '—'} years`, sub: `${plain(data.sessions)} sessions from ${plain(data.first_date)}` },
          ]), source, ticker, ticker),
          tagClip(chartClip(
            'Seasonality',
            `${ticker} · mean return by calendar month`,
            'bar',
            'month',
            months.map(row => ({
              month: plain(row.label),
              mean: finite(row.mean_pct),
              hitRate: finite(row.hit_rate_pct),
            })),
            [{ key: 'mean', label: 'Mean return %', unit: 'percent' }],
            { details: [{ key: 'hitRate', label: 'Hit rate %', unit: 'percent' }] },
          ), source, `${ticker}:monthly-pattern`, ticker),
          tagClip(tableClip(
            'Seasonality',
            `${ticker} · monthly detail with sample size`,
            ['Month', 'Mean %', 'Median %', 'Hit rate %', 'Best %', 'Worst %', 'Observations'],
            months.map(row => [
              plain(row.label), finite(row.mean_pct), finite(row.median_pct),
              finite(row.hit_rate_pct), finite(row.best_pct), finite(row.worst_pct), finite(row.n),
            ]),
          ), source, `${ticker}:monthly-table`, ticker),
        ]
      })

    case 'options-unusual':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/options/unusual?ticker=${encodeURIComponent(ticker)}`))
        const rows = array(data.rows).map(item => record(item))
        if (!rows.length) return null
        const top = rows
          .sort((a, b) => (finite(b.volOiRatio) ?? 0) - (finite(a.volOiRatio) ?? 0))
          .slice(0, 15)
        const calls = rows.filter(row => plain(row.type).toLowerCase() === 'call').length
        return [
          tagClip(kpiClip('Options Scanner', `${ticker} · unusual options activity`, [
            { label: 'Contracts flagged', value: plain(data.count) },
            { label: 'Call share', value: rows.length ? `${((calls / rows.length) * 100).toFixed(0)}%` : '—', sub: `${calls} calls / ${rows.length - calls} puts` },
            { label: 'Highest volume/OI', value: finite(top[0]?.volOiRatio)?.toFixed(1) ?? '—', sub: `${plain(top[0]?.strike)} ${plain(top[0]?.type)} ${plain(top[0]?.expiry)}` },
            { label: 'Screen', value: `vol/OI ≥ ${plain(record(data.params).minVolOi)}`, sub: `min volume ${plain(record(data.params).minVolume)}` },
          ]), source, ticker, ticker),
          tagClip(tableClip(
            'Options Scanner',
            `${ticker} · contracts trading above open interest`,
            ['Type', 'Strike', 'Expiry', 'DTE', 'Volume', 'Open interest', 'Vol/OI', 'IV %', 'Premium $'],
            top.map(row => [
              plain(row.type), finite(row.strike), plain(row.expiry), finite(row.dte),
              finite(row.volume), finite(row.openInterest), finite(row.volOiRatio),
              finite(row.iv) == null ? null : +(finite(row.iv)! * 100).toFixed(1), finite(row.premium),
            ]),
          ), source, `${ticker}:unusual-contracts`, ticker),
        ]
      })

    case 'insider-activity':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/corporate/hub/insider?ticker=${encodeURIComponent(ticker)}`))
        const rows = array(data.transactions).map(item => record(item))
        if (!rows.length) return null
        const sumBy = (side: string) => rows
          .filter(row => plain(row.side).toLowerCase() === side)
          .reduce((total, row) => total + (finite(row.value) ?? 0), 0)
        const bought = sumBy('buy')
        const sold = sumBy('sell')
        const planned = rows.filter(row => row.is_10b51).length
        return [
          tagClip(kpiClip('Company Profile', `${ticker} · insider activity`, [
            { label: 'Reported transactions', value: String(rows.length) },
            { label: 'Bought', value: money(bought) },
            { label: 'Sold', value: money(sold) },
            // A scheduled sale carries no signal, so the split has to be visible
            // beside the totals or the totals will be over-read.
            { label: 'Under a 10b5-1 plan', value: `${planned} of ${rows.length}`, sub: 'Pre-scheduled, not discretionary' },
            { label: 'Held by insiders', value: percent(data.held_pct_insiders) },
          ]), source, ticker, ticker),
          tagClip(tableClip(
            'Company Profile',
            `${ticker} · recent insider transactions`,
            ['Date', 'Insider', 'Role', 'Side', 'Shares', 'Value $', '10b5-1'],
            rows.slice(0, 15).map(row => [
              plain(row.date), plain(row.insider), plain(row.title), plain(row.side),
              finite(row.shares), finite(row.value), row.is_10b51 ? 'Yes' : 'No',
            ]),
          ), source, `${ticker}:insider-transactions`, ticker),
        ]
      })

    case 'institutional-ownership':
      return perTicker(source, async ticker => {
        const data = record(await client.get(`/api/corporate/institutional?ticker=${encodeURIComponent(ticker)}`))
        const holders = array(data.holders).map(item => record(item))
        const changes = record(data.changes)
        if (!holders.length && finite(data.pct_institutions) == null) return null
        const clips: ClipDraft[] = [
          tagClip(kpiClip('Company Profile', `${ticker} · institutional ownership`, [
            { label: 'Float held by institutions', value: finite(data.pct_institutions) == null ? '—' : `${(finite(data.pct_institutions)! * 100).toFixed(1)}%` },
            { label: 'Held by insiders', value: finite(data.pct_insiders) == null ? '—' : `${(finite(data.pct_insiders)! * 100).toFixed(1)}%` },
            { label: 'Holders adding', value: plain(changes.added), sub: `${plain(changes.trimmed)} trimming, ${plain(changes.unchanged)} unchanged` },
            { label: 'Net share change', value: finite(changes.net_share_change) == null ? '—' : finite(changes.net_share_change)!.toLocaleString() },
            // 13F is a rear-view mirror; the filing date belongs next to the number.
            { label: 'Filing quarter', value: plain(changes.filed), sub: 'Filed up to 45 days after quarter end' },
          ]), source, ticker, ticker),
        ]
        if (holders.length) {
          clips.push(tagClip(tableClip(
            'Company Profile',
            `${ticker} · largest institutional holders`,
            ['Holder', 'Shares', 'Value $', '% of float', 'Change %', 'As of'],
            holders.slice(0, 12).map(row => [
              plain(row.holder), finite(row.shares), finite(row.value),
              finite(row.pct_out) == null ? null : +(finite(row.pct_out)! * 100).toFixed(2),
              finite(row.pct_change), plain(row.date),
            ]),
          ), source, `${ticker}:holders`, ticker))
        }
        return clips
      })

    case 'cot-positioning': {
      const data = record(await client.get('/api/official/cot'))
      if (!data.available) return []
      const markets = array(data.markets).map(item => record(item))
      if (!markets.length) return []
      const clips = [tagClip(tableClip(
        'Trader Positioning',
        `Futures positioning · ${plain(data.asset_label)} · ${plain(data.as_of)}`,
        ['Market', 'Net position', 'Weekly flow', 'Open interest change', 'Crowding percentile'],
        markets.map(row => [
          plain(row.label), finite(row.latest), finite(row.weekly_flow),
          finite(row.open_interest_change), finite(row.crowding),
        ]),
      ), source, 'cot-table')]
      const withSeries = markets.find(row => array(row.series).length > 4)
      if (withSeries) {
        clips.push(tagClip(chartClip(
          'Trader Positioning',
          `${plain(withSeries.label)} · net positioning history`,
          'line',
          'date',
          array(withSeries.series).map(item => ({
            date: plain(record(item).date),
            net: finite(record(item).net ?? record(item).value),
          })).filter(point => point.net != null),
          [{ key: 'net', label: 'Net position (contracts)', unit: 'number' }],
        ), source, 'cot-history'))
      }
      return clips
    }

    case 'breadth': {
      const data = record(await client.get('/api/market/breadth'))
      if (!data.available) return []
      const today = record(data.today)
      const participation = record(data.participation)
      const divergence = record(data.divergence)
      const history = array(data.history).map(item => record(item))
      const clips = [tagClip(kpiClip('Market Breadth', `Breadth · ${plain(data.index)} · ${plain(data.as_of)}`, [
        { label: 'Advancing', value: plain(today.advancing), sub: `${plain(today.declining)} declining` },
        { label: 'Advance/decline ratio', value: finite(today.ad_ratio)?.toFixed(2) ?? '—' },
        { label: 'New highs', value: plain(today.new_highs), sub: `${plain(today.new_lows)} new lows` },
        { label: 'Above 50-day', value: finite(participation.pct_above_50) == null ? '—' : `${finite(participation.pct_above_50)!.toFixed(1)}%`, sub: `${percent(participation.pct_above_50_change)} over the window` },
        { label: 'Above 200-day', value: finite(participation.pct_above_200) == null ? '—' : `${finite(participation.pct_above_200)!.toFixed(1)}%`, sub: `${percent(participation.pct_above_200_change)} over the window` },
        { label: 'Index vs breadth', value: plain(divergence.state), sub: `${plain(divergence.sessions)} sessions · index ${percent(divergence.index_change_pct)}` },
        { label: 'Members priced', value: `${plain(record(data.coverage).priced)} of ${plain(record(data.coverage).listed)}` },
      ]), source, 'breadth-summary')]
      if (history.length > 4) {
        clips.push(tagClip(chartClip(
          'Market Breadth',
          `Share of ${plain(data.index)} members above their moving average`,
          'line',
          'date',
          history.map(row => ({
            date: plain(row.date),
            above50: finite(row.pct_above_50),
            above200: finite(row.pct_above_200),
          })),
          [
            { key: 'above50', label: 'Above 50-day %', unit: 'percent' },
            { key: 'above200', label: 'Above 200-day %', unit: 'percent' },
          ],
        ), source, 'breadth-participation'))
        clips.push(tagClip(chartClip(
          'Market Breadth',
          `${plain(data.index)} advance-decline line`,
          'line',
          'date',
          history.map(row => ({ date: plain(row.date), adLine: finite(row.ad_line) })),
          [{ key: 'adLine', label: 'Cumulative advance-decline', unit: 'number' }],
        ), source, 'breadth-ad-line'))
      }
      return clips
    }

    case 'sector-rrg': {
      const data = record(await client.get('/api/market/rrg'))
      if (!data.available) return []
      const series = array(data.series).map(item => record(item))
      if (!series.length) return []
      const counts = record(data.counts)
      return [
        tagClip(kpiClip('Sector Rotation', `Rotation quadrants vs ${plain(data.benchmark)} · ${plain(data.as_of)}`, [
          { label: 'Leading', value: plain(counts.leading), sub: 'Strong and strengthening' },
          { label: 'Weakening', value: plain(counts.weakening), sub: 'Strong but fading' },
          { label: 'Lagging', value: plain(counts.lagging), sub: 'Weak and weakening' },
          { label: 'Improving', value: plain(counts.improving), sub: 'Weak but turning up' },
          { label: 'Normalisation window', value: `${plain(data.window_weeks)} weeks`, sub: `${plain(data.tail_weeks)}-week trail` },
        ]), source, 'rrg-quadrants'),
        tagClip(tableClip(
          'Sector Rotation',
          `Relative strength and momentum vs ${plain(data.benchmark)}`,
          ['Sector', 'Quadrant', 'Rotated in from', 'Strength', 'Momentum'],
          series.map(row => [
            plain(row.ticker), plain(row.quadrant),
            plain(row.from_quadrant) === plain(row.quadrant) ? 'held' : plain(row.from_quadrant),
            finite(row.x), finite(row.y),
          ]),
        ), source, 'rrg-table'),
      ]
    }

    case 'pairs': {
      const [a, b] = source.targets
      if (!a || !b) return []
      const data = record(await client.get(`/api/regression/pairs?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`))
      if (finite(data.hedge_ratio) == null) return []
      const adf = record(data.adf)
      const zscore = record(data.zscore)
      const backtest = record(data.backtest)
      const stationary = adf.stationary === true
      return [tagClip(kpiClip('Pairs Trader', `${a} / ${b} · pair relationship`, [
        { label: 'Hedge ratio', value: finite(data.hedge_ratio)!.toFixed(3), sub: plain(data.hedge_method) },
        { label: 'Correlation', value: finite(data.correlation)?.toFixed(3) ?? '—' },
        // Without cointegration the z-score has no mean to revert to, so the
        // ADF verdict has to travel with the z-score, not sit below it.
        { label: 'Cointegrated', value: stationary ? 'Yes' : 'No', sub: `ADF ${finite(adf.stat)?.toFixed(2) ?? '—'} vs 5% critical ${finite(adf.crit_5)?.toFixed(2) ?? '—'}` },
        { label: 'Spread z-score', value: finite(zscore.current)?.toFixed(2) ?? '—', sub: stationary ? `entry ±${plain(zscore.entry)} · exit ±${plain(zscore.exit)}` : 'Not mean-reverting on this window' },
        { label: 'Half-life', value: finite(data.half_life_days) == null ? '—' : `${finite(data.half_life_days)!.toFixed(0)} days` },
        { label: 'Signal', value: plain(data.signal) },
        { label: 'Backtested Sharpe', value: finite(backtest.sharpe)?.toFixed(2) ?? '—', sub: `${plain(backtest.trades)} trades · ${finite(backtest.win_rate)?.toFixed(0) ?? '—'}% win rate` },
      ]), source, `${a}-${b}`)]
    }

    case 'fx-matrix': {
      const data = record(await client.get('/api/fx/matrix'))
      const rows = array(data.rows).map(item => record(item))
      if (!rows.length) return []
      return [
        tagClip(tableClip(
          'FX Matrix',
          'Major currencies versus the US dollar',
          ['Currency', 'Pair', 'Spot', 'Change %', '3m forward points', '3m basis bps', '1w vol %', '1m vol %', 'Short rate %'],
          rows.map(row => [
            plain(row.ccy), plain(row.pair), finite(row.spot), finite(row.chg_pct),
            finite(row.fwd_pts_3m), finite(row.basis_3m_bps), finite(row.vol_1w),
            finite(row.vol_1m), finite(row.short_rate),
          ]),
        ), source, 'fx-table'),
        tagClip(chartClip(
          'FX Matrix',
          'Policy short rate by currency',
          'bar',
          'ccy',
          rows.map(row => ({ ccy: plain(row.ccy), rate: finite(row.short_rate) })),
          [{ key: 'rate', label: 'Short rate %', unit: 'percent' }],
        ), source, 'fx-rates'),
      ]
    }

    case 'macro-cycle': {
      const data = record(await client.get('/api/rates/cycle'))
      if (!data.available) return []
      const components = array(data.components).map(item => record(item))
      const clips = [tagClip(kpiClip('Macro Monitor', `Business cycle · ${plain(data.as_of)}`, [
        { label: 'Phase', value: plain(data.phase) },
        { label: 'Composite score', value: finite(data.composite)?.toFixed(2) ?? '—', sub: plain(data.blurb) },
        // A mean over three of five components is a weaker read than a mean over
        // five, and nothing else on the card would tell the reader that.
        { label: 'Components resolved', value: `${plain(data.resolved)} of ${plain(data.expected)}`, sub: 'Mean of resolved components, not a probability' },
        { label: 'Strongest', value: plain(data.strongest) },
        { label: 'Weakest', value: plain(data.weakest) },
      ]), source, 'cycle-summary')]
      if (components.length) {
        clips.push(tagClip(tableClip(
          'Macro Monitor',
          'Cycle components',
          ['Component', 'Reading', 'Value', 'Score', 'Rule', 'As of'],
          components.map(row => [
            plain(row.label), plain(row.reading), `${plain(row.value)}${plain(row.unit) === '—' ? '' : ` ${plain(row.unit)}`}`,
            finite(row.score), plain(row.rule), plain(row.as_of),
          ]),
        ), source, 'cycle-components'))
      }
      return clips
    }

    case 'credit-stress': {
      const data = record(await client.get('/api/credit/summary'))
      if (!data.available) return []
      const classes = array(data.asset_classes).map(item => record(item))
      const indicators = array(data.stress_indicators).map(item => record(item))
      if (!classes.length && !indicators.length) return []
      const clips: ClipDraft[] = []
      if (classes.length) {
        clips.push(tagClip(tableClip(
          'Credit Stress',
          `Delinquency and charge-off by asset class · ${plain(data.as_of)}`,
          ['Asset class', 'Delinquency %', 'Charge-off %', 'Trend', 'As of'],
          classes.map(row => [
            plain(row.label), finite(row.delinquency_rate), finite(row.chargeoff_rate),
            plain(row.trend), plain(row.asof),
          ]),
        ), source, 'credit-classes'))
        clips.push(tagClip(chartClip(
          'Credit Stress',
          'Delinquency rate by asset class',
          'bar',
          'assetClass',
          classes.map(row => ({ assetClass: plain(row.label), rate: finite(row.delinquency_rate) })),
          [{ key: 'rate', label: 'Delinquency %', unit: 'percent' }],
        ), source, 'credit-delinquency-visual'))
      }
      if (indicators.length) {
        clips.push(tagClip(tableClip(
          'Credit Stress',
          'Federal Reserve stress indicators',
          ['Indicator', 'Value', 'Previous', 'Unit', 'Frequency', 'Reading', 'As of'],
          indicators.map(row => [
            plain(row.label), finite(row.value), finite(row.previous), plain(row.unit),
            plain(row.frequency), plain(row.interpretation), plain(row.asof),
          ]),
        ), source, 'credit-indicators'))
      }
      return clips
    }

    case 'housing': {
      const data = record(await client.get('/api/housing/report'))
      if (!data.available) return []
      const rates = record(data.rates)
      const regions = array(data.by_region).map(item => record(item))
      const national = regions[0]
      if (!national) return []
      return [tagClip(kpiClip('Housing Market', `Housing · ${plain(data.asof)}`, [
        { label: '30-year mortgage', value: finite(rates.rate_30y) == null ? '—' : `${finite(rates.rate_30y)!.toFixed(2)}%` },
        { label: 'ARM', value: finite(rates.rate_arm) == null ? '—' : `${finite(rates.rate_arm)!.toFixed(2)}%` },
        { label: 'Median price', value: money(national.median_price), sub: `${plain(national.region)} · $${plain(national.price_per_sqft)}/sqft` },
        { label: 'Price to income', value: finite(national.price_to_income)?.toFixed(2) ?? '—', sub: `Affordability index ${plain(national.affordability_index)}` },
        { label: 'Months of supply', value: finite(national.months_of_supply)?.toFixed(1) ?? '—', sub: `${plain(national.days_on_market)} days on market` },
        { label: 'Single-family default rate', value: percent(national.sf_default_rate), sub: `CRE delinquency ${percent(national.cre_delinquency_rate)}` },
      ]), source, 'housing-summary')]
    }

    case 'ipo-calendar': {
      const { range } = eventResearchRange(scope)
      const days = clamp(inclusiveDays(range), 30, 400)
      const data = record(await client.get(`/api/ipo/calendar?date=${range.end}&days=${days}`))
      const rows = array(data.rows).map(item => record(item))
      if (!rows.length) return []
      const priced = finite(data.priced) ?? 0
      const count = finite(data.count) ?? rows.length
      const dealValues = rows.map(row => finite(row.dealValue)).filter((value): value is number => value != null)
      return [
        tagClip(kpiClip('IPO Scanner', `Primary market · ${plain(data.from)} to ${plain(data.to)}`, [
          { label: 'Listings in window', value: String(count) },
          { label: 'Priced', value: String(priced), sub: `${count - priced} pending or withdrawn` },
          { label: 'Median deal value', value: money(median(dealValues)) },
          { label: 'Largest deal', value: money(dealValues.length ? Math.max(...dealValues) : null) },
        ]), source, 'ipo-summary'),
        tagClip(tableClip(
          'IPO Scanner',
          'Largest listings in the window',
          ['Symbol', 'Company', 'Date', 'Exchange', 'Price', 'Shares', 'Deal value $', 'Status'],
          rows
            .sort((a, b) => (finite(b.dealValue) ?? 0) - (finite(a.dealValue) ?? 0))
            .slice(0, 15)
            .map(row => [
              plain(row.symbol), plain(row.name), plain(row.date), plain(row.exchange),
              finite(row.price), finite(row.shares), finite(row.dealValue), plain(row.status),
            ]),
        ), source, 'ipo-table'),
      ]
    }

    case 'chokepoint-exposure': {
      const data = record(await client.get('/api/maritime/exposure'))
      const chokepoints = array(data.chokepoints).map(item => record(item))
      const leaders = array(data.leaders).map(item => record(item))
      if (!chokepoints.length) return []
      const clips = [tagClip(tableClip(
        'Chokepoint Exposure',
        'Maritime chokepoint transit stress',
        ['Chokepoint', 'Oil mb/d', 'Status', 'Change vs baseline %', 'Share of flow %', 'Disruption score'],
        chokepoints.map(row => [
          plain(row.name), finite(row.oil_mbd), plain(row.status),
          finite(row.delta_pct), finite(row.share_pct), finite(row.disruption),
        ]),
      ), source, 'chokepoint-table')]
      if (leaders.length) {
        clips.push(tagClip(tableClip(
          'Chokepoint Exposure',
          'Listed companies most exposed to the stressed chokepoints',
          ['Ticker', 'Group', 'Direction', 'Exposure score', 'Chokepoints', 'Price', 'Change %'],
          leaders.slice(0, 12).map(row => [
            plain(row.ticker), plain(row.group), plain(row.direction), finite(row.score),
            array(row.chokepoints).map(plain).join(', '), finite(row.price), finite(row.change_pct),
          ]),
        ), source, 'chokepoint-leaders'))
      }
      return clips
    }

    // ── Modelled tools ───────────────────────────────────────────────────────
    // These build a request instead of taking a ticker. The assumptions come
    // from the same helpers their pages use, so a report and the page it links
    // to cannot show different numbers for the same company or book.

    case 'master-valuation':
      return perTicker(source, async ticker => {
        const fundamentals = record(await client.get(
          `/api/master-valuation/fundamentals?ticker=${encodeURIComponent(ticker)}`,
        )) as unknown as MasterValuationFundamentals
        const blocker = masterValuationBlocker(fundamentals)
        // Refusing here is the point: a valuation built on invented revenue or
        // a two-year forecast is worse than no valuation section at all. The
        // blocker text already says which, so it travels as the failure reason.
        if (blocker) throw new Error(blocker)
        const analysis = record(await client.post(
          '/api/master-valuation/analyze',
          seedMasterValuationRequest(fundamentals),
        ))
        const methods = record(analysis.methods)
        const composite = record(analysis.composite)
        const reverse = record(analysis.reverse)
        const price = finite(analysis.market_price)
        const value = finite(composite.value_per_share)
        if (value == null) return null
        const upside = price && price > 0 ? (value / price - 1) * 100 : null
        const methodRows = ([
          ['Discounted cash flow', methods.dcf],
          ['Exit multiples', methods.multiples],
          ['Dividend discount', methods.ddm],
          ['Sum of the parts', methods.sotp],
        ] as const)
          .map(([label, raw]) => [label, finite(raw), price && finite(raw) ? +((finite(raw)! / price - 1) * 100).toFixed(1) : null])
          .filter(row => row[1] != null)
        const clips: ClipDraft[] = [
          tagClip(kpiClip('Master Valuation', `${ticker} · multi-method valuation`, [
            { label: 'Blended value per share', value: `$${value.toFixed(2)}`, sub: `Weighted across ${methodRows.length} method${methodRows.length === 1 ? '' : 's'}` },
            { label: 'Market price', value: price == null ? '—' : `$${price.toFixed(2)}` },
            { label: 'Implied upside', value: upside == null ? '—' : `${upside.toFixed(1)}%` },
            // The spread is the honest confidence measure. A composite quoted
            // alone hides a DCF and a multiples value 80% apart.
            {
              label: 'Method spread',
              value: `$${finite(composite.range_low)?.toFixed(2) ?? '—'} to $${finite(composite.range_high)?.toFixed(2) ?? '—'}`,
              sub: 'Widest gap between methods, not a confidence interval',
            },
            { label: 'Assumption source', value: plain(fundamentals.source) },
          ]), source, ticker, ticker),
          tagClip(tableClip(
            'Master Valuation',
            `${ticker} · value per share by method`,
            ['Method', 'Value per share $', 'Upside vs market %'],
            methodRows as (string | number | null)[][],
          ), source, `${ticker}:valuation-methods`, ticker),
        ]
        if (methodRows.length > 1) {
          clips.push(tagClip(chartClip(
            'Master Valuation',
            `${ticker} · valuation by method`,
            'bar',
            'method',
            methodRows.map(row => ({ method: String(row[0]), value: row[1] as number | null })),
            [{ key: 'value', label: 'Value per share $', unit: 'number' }],
          ), source, `${ticker}:valuation-visual`, ticker))
        }
        if (finite(reverse.implied_revenue_cagr) != null) {
          clips.push(tagClip(kpiClip('Reverse DCF', `${ticker} · what the market price already assumes`, [
            { label: 'Implied revenue CAGR', value: `${finite(reverse.implied_revenue_cagr)!.toFixed(1)}%`, sub: 'To justify the current price on these other assumptions' },
            { label: 'Implied terminal margin', value: finite(reverse.implied_terminal_margin) == null ? '—' : `${finite(reverse.implied_terminal_margin)!.toFixed(1)}%` },
            { label: 'Implied discount rate', value: finite(reverse.implied_wacc) == null ? '—' : `${finite(reverse.implied_wacc)!.toFixed(2)}%` },
            { label: 'Implied exit multiple', value: finite(reverse.implied_exit_multiple) == null ? '—' : `${finite(reverse.implied_exit_multiple)!.toFixed(1)}x`, sub: `Year ${plain(reverse.implied_exit_year)}` },
          ]), source, `${ticker}:reverse-dcf`, ticker))
        }
        return clips
      })

    case 'monte-carlo': {
      const { start, end } = lookbackRange(scope)
      const basis = await portfolioWeightBasis(source, portfolio, client)
      if (!basis) return []
      const data = record(await client.post('/api/portfolio/montecarlo', {
        tickers: basis.tickers,
        weights: basis.weights,
        start,
        end,
        n_sims: 500,
        horizon_days: 252,
      }))
      const percentiles = record(data.percentiles)
      const core = record(data.core_metrics)
      if (finite(percentiles.p50) == null) return []
      const asPct = (value: unknown) => finite(value) == null ? '—' : `${((finite(value)! - 1) * 100).toFixed(1)}%`
      return [
        tagClip(kpiClip('Monte Carlo', `${basis.label} · simulated one-year outcome range`, [
          { label: 'Median outcome', value: asPct(percentiles.p50), sub: '500 paths over 252 sessions' },
          { label: '5th percentile', value: asPct(percentiles.p5), sub: 'One year in twenty is worse than this' },
          { label: '95th percentile', value: asPct(percentiles.p95) },
          { label: '95% VaR', value: fmtTailReturn(finite(data.var_95)), sub: 'Terminal return at the 5th percentile' },
          // CVaR is the average of the tail, so it is always worse than VaR and
          // is the number that describes the loss you actually take when it goes.
          { label: '95% CVaR', value: fmtTailReturn(finite(data.cvar_95)), sub: 'Mean terminal return across the worst 5% of paths' },
          { label: 'Simulated CAGR', value: finite(core.cagr) == null ? '—' : `${finite(core.cagr)!.toFixed(1)}%`, sub: `Volatility drag ${finite(core.volatility_drag)?.toFixed(1) ?? '—'}%` },
          { label: 'Simulated max drawdown', value: finite(core.max_drawdown) == null ? '—' : `${finite(core.max_drawdown)!.toFixed(1)}%` },
          { label: 'Calibration window', value: `${start} to ${end}`, sub: `Drift ${((finite(data.mu) ?? 0) * 100).toFixed(1)}% · vol ${((finite(data.sigma) ?? 0) * 100).toFixed(1)}%` },
        ]), source, 'monte-carlo-summary'),
        tagClip(chartClip(
          'Monte Carlo',
          `${basis.label} · simulated terminal value by percentile`,
          'bar',
          'percentile',
          (['p5', 'p25', 'p50', 'p75', 'p95'] as const).map(key => ({
            percentile: key.replace('p', '') + 'th',
            change: finite(percentiles[key]) == null ? null : +((finite(percentiles[key])! - 1) * 100).toFixed(1),
          })),
          [{ key: 'change', label: 'Change over one year %', unit: 'percent' }],
        ), source, 'monte-carlo-distribution'),
      ]
    }

    case 'portfolio-optimizer': {
      const { start, end } = lookbackRange(scope)
      const basis = await portfolioWeightBasis(source, portfolio, client)
      // Two assets is the minimum for a frontier to exist at all.
      if (!basis || basis.tickers.length < 2) return []
      const weightMap: Record<string, number> = {}
      basis.tickers.forEach((ticker, index) => { weightMap[ticker] = basis.weights[index] })
      const data = record(await client.post('/api/portfolio-opt/optimize', {
        tickers: basis.tickers.slice(0, 20),
        start,
        end,
        weights: weightMap,
      }))
      const portfolios = record(data.portfolios)
      const rows = ([
        ['Current book', portfolios.current],
        ['Max Sharpe', portfolios.max_sharpe],
        ['Minimum variance', portfolios.min_variance],
        ['Risk parity', portfolios.risk_parity],
        ['Equal weight', portfolios.equal_weight],
      ] as const)
        .map(([label, raw]) => {
          const row = record(raw)
          return [label, finite(row.return), finite(row.vol), finite(row.sharpe)]
        })
        .filter(row => row[1] != null)
      if (!rows.length) return []
      const current = record(portfolios.current)
      const best = record(portfolios.max_sharpe)
      const frontier = array(data.frontier).map(item => record(item))
      const clips: ClipDraft[] = [
        tagClip(kpiClip('Portfolio Allocator', `${basis.label} · allocation efficiency`, [
          { label: 'Current Sharpe', value: finite(current.sharpe)?.toFixed(2) ?? '—', sub: `${finite(current.return)?.toFixed(1) ?? '—'}% return at ${finite(current.vol)?.toFixed(1) ?? '—'}% volatility` },
          { label: 'Best attainable Sharpe', value: finite(best.sharpe)?.toFixed(2) ?? '—', sub: 'Max-Sharpe weights on this window' },
          {
            label: 'Sharpe gap',
            value: finite(best.sharpe) != null && finite(current.sharpe) != null
              ? (finite(best.sharpe)! - finite(current.sharpe)!).toFixed(2) : '—',
            // In-sample by construction. Saying so here stops the gap being read
            // as money left on the table.
            sub: 'In-sample optimum. Not repeatable out of sample',
          },
          { label: 'Assets priced', value: `${array(data.tickers).length}`, sub: array(data.dropped).length ? `${array(data.dropped).length} dropped` : 'All holdings covered' },
          { label: 'Window', value: `${plain(record(data.span).start)} to ${plain(record(data.span).end)}`, sub: `${plain(data.days)} sessions` },
        ]), source, 'optimizer-summary'),
        tagClip(tableClip(
          'Portfolio Allocator',
          `${basis.label} · the book against standard allocations`,
          ['Allocation', 'Return %', 'Volatility %', 'Sharpe'],
          rows as (string | number | null)[][],
        ), source, 'optimizer-comparison'),
      ]
      if (frontier.length > 2) {
        clips.push(tagClip(chartClip(
          'Portfolio Allocator',
          `${basis.label} · efficient frontier`,
          'line',
          'vol',
          frontier.map(point => ({ vol: finite(point.vol), return: finite(point.return) })),
          [{ key: 'return', label: 'Expected return %', unit: 'percent' }],
          { xUnit: 'percent' },
        ), source, 'optimizer-frontier'))
      }
      return clips
    }

    case 'portfolio-backtest': {
      const handoff = readAlgoStrategyHandoff()
      // Gated on a strategy the user actually built. There is no default rule
      // set worth reporting: inventing one would attribute a strategy to them
      // that they never chose.
      if (!handoff) return []
      const risk = record(record(handoff.strategy).risk)
      const positions = array(handoff.positions).map(raw => {
        const position = record(raw)
        return {
          ticker: plain(position.ticker),
          side: plain(position.side) === '—' ? 'long' : plain(position.side),
          rules: { buy: record(handoff.strategy).buy, sell: record(handoff.strategy).sell },
          position_size: finite(position.tradeSize) ?? finite(handoff.tradeSizePct) ?? 10,
          stop_loss: finite(risk.stopLossPct) || undefined,
          take_profit: finite(risk.takeProfitPct) || undefined,
          trailing_stop: finite(risk.trailingStopPct) || undefined,
          max_hold_bars: finite(risk.maxHoldBars) || undefined,
        }
      }).filter(position => position.ticker && position.ticker !== '—')
      if (!positions.length) return []
      const data = record(await client.post('/api/strategy/portfolio-backtest', {
        positions,
        start: plain(handoff.start) === '—' ? lookbackRange(scope).start : plain(handoff.start),
        end: plain(handoff.end) === '—' ? lookbackRange(scope).end : plain(handoff.end),
        timeframe: plain(handoff.timeframe) === '—' ? '1d' : plain(handoff.timeframe),
        initial_capital: 10_000,
        position_size: finite(handoff.tradeSizePct) ?? 10,
        leverage: finite(handoff.leverage) ?? 1,
        effective_annual_rate: finite(handoff.effectiveAnnualRate) ?? 0,
      }))
      const metrics = record(data.metrics ?? data)
      if (finite(metrics.total_return) == null && finite(metrics.cagr) == null) return []
      const strategyName = plain(record(handoff.strategy).name) === '—' ? 'Saved strategy' : plain(record(handoff.strategy).name)
      const equity = array(data.equity_curve ?? data.equity).map(item => record(item))
      const clips: ClipDraft[] = [
        tagClip(kpiClip('Portfolio Backtester', `${strategyName} · replayed across ${positions.length} position${positions.length === 1 ? '' : 's'}`, [
          { label: 'Total return', value: percent(metrics.total_return) },
          { label: 'CAGR', value: percent(metrics.cagr) },
          { label: 'Sharpe', value: finite(metrics.sharpe)?.toFixed(2) ?? '—' },
          { label: 'Max drawdown', value: percent(metrics.max_drawdown) },
          { label: 'Trades', value: plain(metrics.trades ?? metrics.trade_count), sub: `${finite(metrics.win_rate)?.toFixed(0) ?? '—'}% win rate` },
          { label: 'Time in market', value: percent(metrics.exposure_pct) },
          // The measurement is of the rule, not of holding these names.
          { label: 'Measures', value: 'The rule set, not the holdings', sub: `${plain(handoff.timeframe)} bars from ${plain(handoff.start)}` },
        ]), source, 'backtest-summary'),
      ]
      if (equity.length > 4) {
        clips.push(tagClip(chartClip(
          'Portfolio Backtester',
          `${strategyName} · equity curve`,
          'line',
          'date',
          thin(equity.map(point => ({ date: plain(point.date ?? point.t), equity: finite(point.equity ?? point.value) }))),
          [{ key: 'equity', label: 'Portfolio value $', unit: 'number' }],
        ), source, 'backtest-equity'))
      }
      return clips
    }
  }
}

/** Live-marked book weights, shared by the simulator and the optimizer.
 *
 * Both need the same thing: the tickers and the fractions they represent right
 * now. Cost basis would misweight a book that has moved, so live quotes lead and
 * saved cost is only the fallback.
 */
async function portfolioWeightBasis(
  source: ReportResearchSource,
  portfolio: ActivePortfolioContext,
  client: ResearchClient,
): Promise<{ tickers: string[]; weights: number[]; label: string } | null> {
  const holdings = (portfolio.hasData ? portfolio.holdings : [])
    .map(holding => ({ ...holding, ticker: normalizeTicker(holding.ticker) }))
    .filter(holding => holding.ticker && holding.shares > 0)
  // Falls back to the researched symbols equally weighted, so a symbol-scoped
  // report can still simulate without an active book.
  if (!holdings.length) {
    const symbols = unique(source.targets.map(normalizeTicker).filter(Boolean)).slice(0, 20)
    if (!symbols.length) return null
    return {
      tickers: symbols,
      weights: symbols.map(() => 1 / symbols.length),
      label: symbols.length === 1 ? symbols[0] : `${symbols.length} named assets, equally weighted`,
    }
  }
  let quotes: Record<string, unknown> = {}
  try {
    quotes = record(await client.get(`/api/alerts/quotes?tickers=${encodeURIComponent(holdings.map(holding => holding.ticker).join(','))}`))
  } catch {
    quotes = {}
  }
  const valued = holdings
    .map(holding => {
      const mark = finite(record(quotes[holding.ticker]).current_price) ?? (holding.avgCost > 0 ? holding.avgCost : null)
      return { ticker: holding.ticker, value: mark == null ? 0 : Math.max(0, holding.shares * mark) }
    })
    .filter(row => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 20)
  const total = valued.reduce((sum, row) => sum + row.value, 0)
  if (!valued.length || total <= 0) return null
  return {
    tickers: valued.map(row => row.ticker),
    weights: valued.map(row => +(row.value / total).toFixed(6)),
    label: /^default$/i.test(portfolio.name.trim()) ? 'Portfolio' : portfolio.name,
  }
}

/** The strategy the user sent from the Algo Strategy Builder, if there is one. */
function readAlgoStrategyHandoff(): Record<string, any> | null {
  try {
    const raw = JSON.parse(localStorage.getItem('fdb_algo_universe_monte_carlo_handoff') || 'null')
    if (!raw || raw.version !== 1 || !raw.strategy || !Array.isArray(raw.positions) || !raw.positions.length) return null
    return raw
  } catch {
    return null
  }
}

/** Whether a strategy backtest can run at all. Drives the planner's disabled set. */
export function hasSavedStrategyForBacktest(): boolean {
  return readAlgoStrategyHandoff() != null
}

const failureMessage = (error: unknown) => {
  const response = (error as { response?: { status?: number; data?: unknown } })?.response
  const status = response?.status
  if (status === 404) return 'No usable data returned.'
  if (status === 429) return 'Source rate limit reached. Retry shortly.'
  if (status && status >= 500) return 'Source is temporarily unavailable.'
  // A 4xx is the source rejecting the request, and its detail says why — a
  // twelve-ticker cap, a period it does not accept, too few overlapping bars.
  // Collapsing that into "did not complete" is what made a correlation failure
  // on a thirteen-holding book impossible to diagnose from the report.
  if (status && status >= 400) {
    const detail = (record(response?.data).detail ?? '') as unknown
    const text = typeof detail === 'string' ? detail.trim() : ''
    if (text) return `Source rejected the request: ${text.slice(0, 160)}`
    return 'Source rejected the request.'
  }
  const thrown = (error as { message?: string })?.message
  if (thrown && thrown !== 'empty source') return thrown.slice(0, 160)
  return 'Returned no usable rows for this scope.'
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
  'asset-profile',
  'debt-maturity',
  'seasonality',
  'options-unusual',
  'insider-activity',
  'institutional-ownership',
  'master-valuation',
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
    const targetErrors = new Map<string, string>()
    try {
      const clips = await runSource(source, scope, portfolio, client, targetErrors)
      const missingTargets = PER_TICKER_SOURCES.has(source.id)
        ? source.targets.filter(target => !clips.some(clip => clip.researchKey === `${source.id}:${target}`))
        : []
      missingTargets.forEach(target => failed.push({
        sourceId: source.id,
        label: source.label,
        target,
        researchKey: `${source.id}:${target}`,
        // The recorded reason when the request failed; otherwise the source
        // answered and simply had nothing usable for this name.
        message: targetErrors.get(`${source.id}:${target}`) ?? `No usable data returned for ${target}.`,
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
    const missingTargets = unique(failures.flatMap(failure => failure.target ? [failure.target] : []))
    const requestedTargetCount = source?.targets.length || 1
    const coveredTargetCount = status === 'failed'
      ? 0
      : source?.targets.length
        ? Math.max(0, source.targets.length - missingTargets.length)
        : sourceClips.length ? 1 : 0
    const coveragePct = requestedTargetCount
      ? Math.round((coveredTargetCount / requestedTargetCount) * 1000) / 10
      : 100
    const failureGaps = failures.map(failure => (
      failure.target
        ? `${source?.label ?? sourceId}: ${failure.target} - ${failure.message}`
        : `${source?.label ?? sourceId}: ${failure.message}`
    ))
    const unresolvedGaps = failureGaps.length
      ? failureGaps
      : status === 'failed'
        ? [`${source?.label ?? sourceId}: No usable evidence returned.`]
        : []
    return {
      sourceId,
      label: source?.label ?? sourceId,
      status,
      targets: source?.targets ?? [],
      clipIds: sourceClips.map(clip => clip.id),
      missingTargets,
      error: failures.length
        ? failures.map(failure => failure.message).filter(Boolean).join(' ') || 'Some requested evidence did not complete.'
        : status === 'failed' ? 'No usable evidence returned.' : '',
      domain: source?.domain ?? 'issuer',
      critical: source?.critical ?? false,
      requestedTargetCount,
      coveredTargetCount,
      coveragePct,
      unresolvedGaps,
    }
  })
  const requestedTargets = runs.reduce((sum, run) => sum + run.requestedTargetCount, 0)
  const coveredTargets = runs.reduce((sum, run) => sum + run.coveredTargetCount, 0)
  const domains: EvidenceDomain[] = ['portfolio', 'issuer', 'macro', 'benchmark']
  const domainCoveragePct = Object.fromEntries(domains.map(domain => {
    const domainRuns = runs.filter(run => run.domain === domain)
    const requested = domainRuns.reduce((sum, run) => sum + run.requestedTargetCount, 0)
    const covered = domainRuns.reduce((sum, run) => sum + run.coveredTargetCount, 0)
    return [domain, requested ? Math.round((covered / requested) * 1000) / 10 : 100]
  })) as Record<EvidenceDomain, number>
  const unresolvedGaps = runs.flatMap(run => run.unresolvedGaps)
  const criticalSourceIds = requiredSourceIds.filter(sourceId => (
    plan.sources.find(source => source.id === sourceId)?.critical === true
  ))
  const criticalReady = runs
    .filter(run => criticalSourceIds.includes(run.sourceId))
    .every(run => run.status === 'complete' && run.coveragePct === 100)
  return {
    phase: criticalReady ? 'ready' : 'blocked',
    requiredSourceIds,
    criticalSourceIds,
    runs,
    objectivePlan: plan.objectivePlan ?? {
      thesis: '',
      requiredDataPoints: [],
      requiredChecks: [],
    },
    coverage: {
      requestedTargets,
      coveredTargets,
      targetCoveragePct: requestedTargets ? Math.round((coveredTargets / requestedTargets) * 1000) / 10 : 100,
      domainCoveragePct,
    },
    unresolvedGaps,
  }
}
