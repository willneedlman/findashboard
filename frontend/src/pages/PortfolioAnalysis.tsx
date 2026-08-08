import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import axios from 'axios'
import { useMutation } from '@tanstack/react-query'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronUp, RefreshCw, X } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import ErrorState from '../components/ErrorState'
import LoadingState from '../components/LoadingState'
import { T } from '../lib/theme'
import { MONO, SANS, Panel, KpiStrip, chg, mix, seg } from './cockpitKit'
import {
  cashValue, normalizeTicker, PORTFOLIO_CONTEXT_EVENT, readActivePortfolioContext,
  readPMBooks,
  type PMOptionPosition, type PMPortfolio,
} from '../lib/pmImport'
import { useReportCapture } from '../hooks/useReportCapture'
import { chartClip, kpiClip, tableClip } from '../lib/reportCaptureRegistry'
import type { ClipDraft } from '../lib/reportCreator'

interface WeightedHolding {
  ticker: string
  shares: number
  avgCost: number
  price: number
  value: number
  weight: number
}

interface BacktestData {
  metrics: { port_cagr: number; bench_cagr: number; port_sharpe: number; port_vol: number; max_drawdown: number; sortino: number; calmar: number; beta: number }
  cumulative: { date: string; portfolio: number; benchmark: number }[]
  daily_returns: { date: string; value: number }[]
  rolling_beta: { date: string; value: number }[]
  per_ticker_returns: Record<string, { date: string; value: number }[]>
}

interface MonteCarloData {
  mu: number; sigma: number; var_95: number; cvar_95: number; pct_wiped: number
  pct_margin_called: number; pct_forced_liquidation: number; pct_insolvent: number; median_max_margin_utilization: number
  leverage: number; borrow_rate: number; long_maintenance_margin: number; short_maintenance_margin: number
  dividend_mode: 'reinvest' | 'cash' | 'exclude' | 'embedded'; median_dividend_income_pct: number | null
  model: MonteCarloModel; t_degrees_freedom: number | null; bootstrap_block_days: number | null
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number }
  percentile_paths: { day: number; p5: number; p25: number; p50: number; p75: number; p95: number }[]
  sample_paths: number[][]; histogram: number[]
}

interface FactorRow { factor: string; proxy: string; beta: number; t_stat: number | null; risk_pct: number }
interface FactorHolding { ticker: string; weight: number; betas: Record<string, number>; idiosyncratic_pct: number; book_var_share_pct: number }
interface FactorData {
  factors: FactorRow[]; holdings_detail: FactorHolding[]; systematic_pct: number; idiosyncratic_pct: number
  ann_vol_pct: number; alpha_ann_pct: number; r_squared: number
  concentration: { holdings: number; hhi: number; effective_n: number | null; top_weight: number | null }
  dropped: string[]; source: string
}

interface OptimizerWeight { ticker: string; weight: number; risk_contribution: number }
interface OptimizerPortfolio { return: number; vol: number; sharpe: number; var_95: number; cvar_95: number; weights: OptimizerWeight[] }
interface OptimizerData {
  tickers: string[]; dropped: string[]
  portfolios: { current?: OptimizerPortfolio; max_sharpe: OptimizerPortfolio; min_variance: OptimizerPortfolio; risk_parity: OptimizerPortfolio }
  assets: { ticker: string; return: number; total_return: number; vol: number; beta: number | null }[]
  frontier: { vol: number; return: number; sharpe: number }[]
  covariance: number[][]
}

interface OptionExposure { underlying: string; label: string; marketValue: number | null; deltaShares: number | null; source: string }
interface SectorExposure { sector: string; weight: number; holdings: number }
interface SectorChartSlice extends SectorExposure { memberSectors: string[] }
interface PopoverAnchor { clientX: number; clientY: number }
interface CompanyProfile {
  symbol: string; companyName: string | null; sector: string | null; industry: string | null
  classification: string | null; source: string | null
}
interface PositionDecision extends WeightedHolding {
  sector: string; riskContribution: number | null; beta: number | null; periodReturn: number | null
  idiosyncratic: number | null; decision: string; rationale: string; tone: string
}

interface AnalysisResult {
  bookName: string; generatedAt: string; holdings: WeightedHolding[]; cashWeight: number; coverageWeight: number
  backtest: BacktestData; monteCarlo: MonteCarloData | null; macro: FactorData | null; style: FactorData | null
  optimizer: OptimizerData | null; sectors: SectorExposure[]; positions: PositionDecision[]; options: OptionExposure[]
  warnings: string[]; failures: string[]
  simulationSettings: AnalysisSettings
}

type DividendMode = 'reinvest' | 'cash' | 'exclude'
type MonteCarloModel = 'gbm' | 'student_t' | 'bootstrap'
interface AnalysisSettings {
  horizonDays: number
  simulations: number
  leverage: number
  borrowRate: number
  longMaintenance: number
  shortMaintenance: number
  dividendMode: DividendMode
  model: MonteCarloModel
  tDegreesFreedom: number
  bootstrapBlockDays: number
}

type DetailSelection =
  | { kind: 'sector'; sector: string; memberSectors: string[] }
  | { kind: 'return'; point: BacktestData['cumulative'][number] }
  | { kind: 'drawdown'; point: { date: string; drawdown: number } }
  | { kind: 'monte'; point: { day: number; p5: number; p25: number; p50: number; p75: number; p95: number } }
  | { kind: 'position'; ticker: string }

const BENCHMARK = 'SPY'
const LOOKBACK_YEARS = 5
const HORIZON_DAYS = 756
const MONTE_CARLO_RUNS = 500
const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  horizonDays: HORIZON_DAYS,
  simulations: MONTE_CARLO_RUNS,
  leverage: 1,
  borrowRate: 5,
  longMaintenance: 25,
  shortMaintenance: 30,
  dividendMode: 'reinvest',
  model: 'gbm',
  tDegreesFreedom: 5,
  bootstrapBlockDays: 5,
}
const SECTOR_FALLBACKS: Record<string, string> = {
  BND: 'Fixed Income',
  JOBY: 'eVTOL & Advanced Air Mobility',
  QQQ: 'Diversified Equity',
  RVI: 'Financial Services',
  SPY: 'Diversified Equity',
  SPYI: 'Diversified Equity',
  TSLL: 'Consumer Cyclical',
  VOO: 'Diversified Equity',
  VXUS: 'Diversified Equity',
}
const INVALID_SECTORS = new Set(['', 'na', 'none', 'null', 'unknown', 'unclassified', 'notavailable'])
const fmtPct = (v: number | null | undefined, d = 1) => v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`
const fmtMoney = (v: number) => v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`
const modelLabel = (model: MonteCarloModel) => model === 'student_t' ? 'Student-t fat tails' : model === 'bootstrap' ? 'Historical bootstrap' : 'Normal GBM'
const asDate = (years: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - years); return d.toISOString().slice(0, 10) }
const endDate = () => new Date().toISOString().slice(0, 10)
const quotePrice = (q: any) => Number(q?.current_price ?? q?.price ?? q?.regular_market_price ?? 0)

function resolvedSector(ticker: string, profile?: CompanyProfile) {
  const reported = profile?.classification?.trim() || profile?.industry?.trim() || profile?.sector?.trim() || ''
  const sectorKey = reported.toLowerCase().replace(/[^a-z]/g, '')
  if (!INVALID_SECTORS.has(sectorKey)) return reported
  if (SECTOR_FALLBACKS[ticker]) return SECTOR_FALLBACKS[ticker]
  const name = profile?.companyName?.toLowerCase() ?? ''
  if (/bond|treasury|fixed income/.test(name)) return 'Fixed Income'
  if (/fund|etf|portfolio|index|trust/.test(name)) return 'Diversified Fund'
  return 'Public Equity'
}

function optionLegs(options: PMOptionPosition[]) {
  return options.flatMap(p => p.legs.map(l => ({
    position: p,
    leg: l,
    request: { underlying: normalizeTicker(p.underlying), expiry: l.expiry, strike: l.strike, option_type: l.type },
  })))
}

function monteBands(data: MonteCarloData | null) {
  if (!data?.percentile_paths?.length) return []
  const rows = data.percentile_paths
  const step = Math.max(1, Math.floor(rows.length / 100))
  return rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map(row => ({
    day: row.day,
    p5: Number((row.p5 * 100).toFixed(1)),
    p25: Number((row.p25 * 100).toFixed(1)),
    p50: Number((row.p50 * 100).toFixed(1)),
    p75: Number((row.p75 * 100).toFixed(1)),
    p95: Number((row.p95 * 100).toFixed(1)),
  }))
}

function drawdownSeries(cumulative: BacktestData['cumulative']) {
  let peak = 0
  return cumulative.map(p => { peak = Math.max(peak, p.portfolio); return { date: p.date, drawdown: peak ? (p.portfolio / peak - 1) * 100 : 0 } })
}

function decisionFor(weight: number, risk: number | null, beta: number | null, ret: number | null) {
  if (weight >= 15 || (risk != null && risk >= Math.max(15, weight * 1.45))) return { decision: 'Reduce / hedge review', rationale: risk != null ? `${weight.toFixed(1)}% weight drives ${risk.toFixed(1)}% of variance` : `${weight.toFixed(1)}% position concentration`, tone: T.warn }
  if (ret != null && ret < -20) return { decision: 'Thesis review', rationale: `${ret.toFixed(1)}% over the analysis window`, tone: T.neg }
  if ((beta != null && beta < .75) || (risk != null && risk < weight * .65)) return { decision: 'Retain as diversifier', rationale: beta != null && beta < .75 ? `Low market beta of ${beta.toFixed(2)}` : 'Risk share below capital weight', tone: T.pos }
  if (risk != null && risk > weight * 1.2) return { decision: 'Hold · risk watch', rationale: 'Variance contribution exceeds capital weight', tone: T.warn }
  return { decision: 'Hold / monitor', rationale: 'Risk and capital weight are broadly aligned', tone: T.text }
}

async function runAnalysis(book: PMPortfolio, benchmark: string, lookbackYears: number, settings: AnalysisSettings): Promise<AnalysisResult> {
  const tickers = [...new Set(book.holdings.map(h => normalizeTicker(h.ticker)).filter(Boolean))]
  if (!tickers.length) throw new Error('This Portfolio Manager book has no equity holdings to analyze.')

  const { data: quotePayload } = await axios.get(`/api/market/quotes?tickers=${encodeURIComponent(tickers.join(','))}`, { timeout: 45_000 })
  const quotes = quotePayload?.quotes ?? {}
  const holdings = book.holdings.map(h => {
    const ticker = normalizeTicker(h.ticker)
    const price = quotePrice(quotes[ticker]) || h.avgCost || 0
    return { ticker, shares: h.shares, avgCost: h.avgCost, price, value: h.shares * price, weight: 0 }
  }).filter(h => h.ticker && h.value > 0)
  const equityValue = holdings.reduce((s, h) => s + h.value, 0)
  const cash = book.cash.reduce((s, c) => s + cashValue(c), 0)
  const totalValue = equityValue + cash
  holdings.forEach(h => { h.weight = totalValue > 0 ? h.value / totalValue * 100 : 0 })
  const cashWeight = totalValue > 0 ? cash / totalValue * 100 : 0
  if (!holdings.length) throw new Error('No holdings could be priced. Check the tickers in Portfolio Manager.')

  const start = asDate(lookbackYears), end = endDate()
  const weights = holdings.map(h => h.weight)
  const core20 = [...holdings].sort((a, b) => b.weight - a.weight).slice(0, 20)
  const coreWeight = core20.reduce((s, h) => s + h.weight, 0)
  const normCoreWeights = core20.map(h => h.weight / coreWeight * 100)
  const factorHoldings = holdings.map(h => ({ ticker: h.ticker, weight: h.weight }))
  const request = <T,>(p: Promise<{ data: T }>) => p.then(r => r.data)

  const tasks = await Promise.allSettled([
    request<BacktestData>(axios.post('/api/portfolio/backtest', { tickers: holdings.map(h => h.ticker), weights, cash_weight: cashWeight, benchmark, start, end, rebalance: 'none' }, { timeout: 120_000 })),
    request<MonteCarloData>(axios.post('/api/portfolio/montecarlo', {
      tickers: core20.map(h => h.ticker), weights: normCoreWeights, start, end,
      n_sims: settings.simulations, horizon_days: settings.horizonDays,
      leverage: settings.leverage, borrow_rate: settings.borrowRate,
      long_maintenance_margin: settings.longMaintenance / 100,
      short_maintenance_margin: settings.shortMaintenance / 100,
      dividend_mode: settings.dividendMode,
      model: settings.model,
      t_degrees_freedom: settings.tDegreesFreedom,
      bootstrap_block_days: settings.bootstrapBlockDays,
    }, { timeout: 120_000 })),
    request<FactorData>(axios.post('/api/portfolio/factor-decomposition', { holdings: factorHoldings, lookback_days: lookbackYears * 365, benchmark, mode: 'macro' }, { timeout: 120_000 })),
    request<FactorData>(axios.post('/api/portfolio/factor-decomposition', { holdings: factorHoldings, lookback_days: lookbackYears * 365, benchmark, mode: 'style' }, { timeout: 120_000 })),
    core20.length >= 2 ? request<OptimizerData>(axios.post('/api/portfolio-opt/optimize', { tickers: core20.map(h => h.ticker), start, end, return_model: 'historical', constraint_mode: 'long_only', weights: Object.fromEntries(core20.map((h, i) => [h.ticker, normCoreWeights[i]])) }, { timeout: 120_000 })) : Promise.resolve(null),
    request<{ rows: CompanyProfile[] }>(axios.get(`/api/portfolio/sectors?symbols=${encodeURIComponent(tickers.join(','))}`, { timeout: 45_000 })),
  ])
  const value = <T,>(i: number): T | null => tasks[i].status === 'fulfilled' ? tasks[i].value as T : null
  const backtest = value<BacktestData>(0)
  if (!backtest) throw new Error('Historical performance could not be calculated. Try a shorter lookback or check for an unpriceable holding.')
  const monteCarlo = value<MonteCarloData>(1)
  const macro = value<FactorData>(2), style = value<FactorData>(3), optimizer = value<OptimizerData>(4)
  const profiles = value<{ rows: CompanyProfile[] }>(5)?.rows ?? []
  const profileByTicker = Object.fromEntries(profiles.map(r => [r.symbol, r]))
  const sectorByTicker = Object.fromEntries(tickers.map(ticker => [ticker, resolvedSector(ticker, profileByTicker[ticker])]))
  const sectorMap = new Map<string, { weight: number; holdings: number }>()
  holdings.forEach(h => { const sector = sectorByTicker[h.ticker]; const s = sectorMap.get(sector) ?? { weight: 0, holdings: 0 }; s.weight += h.weight; s.holdings += 1; sectorMap.set(sector, s) })
  const sectors = [...sectorMap].map(([sector, d]) => ({ sector, ...d })).sort((a, b) => b.weight - a.weight)

  const currentWeights = optimizer?.portfolios.current?.weights ?? []
  const assetByTicker = Object.fromEntries((optimizer?.assets ?? []).map(a => [a.ticker, a]))
  const factorByTicker = Object.fromEntries((macro?.holdings_detail ?? []).map(h => [h.ticker, h]))
  const positions = [...holdings].sort((a, b) => b.weight - a.weight).map(h => {
    const risk = currentWeights.find(w => w.ticker === h.ticker)?.risk_contribution ?? factorByTicker[h.ticker]?.book_var_share_pct ?? null
    const beta = assetByTicker[h.ticker]?.beta ?? factorByTicker[h.ticker]?.betas?.market ?? null
    const periodReturn = assetByTicker[h.ticker]?.total_return ?? null
    return { ...h, sector: sectorByTicker[h.ticker], riskContribution: risk, beta, periodReturn, idiosyncratic: factorByTicker[h.ticker]?.idiosyncratic_pct ?? null, ...decisionFor(h.weight, risk, beta, periodReturn) }
  })

  const flattened = optionLegs(book.optionPositions ?? [])
  let options: OptionExposure[] = []
  if (flattened.length) {
    try {
      const { data } = await axios.post('/api/options/marks', { legs: flattened.map(x => x.request) }, { timeout: 120_000 })
      let cursor = 0
      options = (book.optionPositions ?? []).map(position => {
        let marketValue = 0, deltaShares = 0, priced = true, source = ''
        position.legs.forEach(leg => {
          const mark = data.marks?.[cursor++]
          const sign = leg.side === 'long' ? 1 : -1
          const mult = leg.contracts * 100
          if (mark?.mark == null) priced = false
          else marketValue += sign * mark.mark * mult
          if (mark?.delta == null) priced = false
          else deltaShares += sign * mark.delta * mult
          source = mark?.source || source
        })
        return { underlying: position.underlying, label: position.name, marketValue: priced ? marketValue : null, deltaShares: priced ? deltaShares : null, source: source || 'unavailable' }
      })
    } catch { options = (book.optionPositions ?? []).map(p => ({ underlying: p.underlying, label: p.name, marketValue: null, deltaShares: null, source: 'unavailable' })) }
  }

  const failures = ['Monte Carlo', 'Macro factors', 'Style factors', 'Optimization', 'Sector classification'].filter((_, i) => tasks[i + 1].status === 'rejected')
  const warnings: string[] = []
  if (holdings.length > 20) warnings.push(`Monte Carlo and covariance analysis cover the top 20 holdings (${coreWeight.toFixed(1)}% of capital); historical performance and factors cover the full equity book.`)
  if (cashWeight > 0) warnings.push(`Cash is included in historical performance at the risk-free rate (${cashWeight.toFixed(1)}% weight), but excluded from factor and Monte Carlo estimation.`)
  if (options.length) warnings.push('Options are marked and shown as delta-equivalent exposure; historical return and Monte Carlo results remain equity-and-cash based because contract-level history is unavailable.')
  if (book.futuresCount) warnings.push(`${book.futuresCount} futures position${book.futuresCount === 1 ? '' : 's'} cannot yet be reconstructed from the shared Portfolio Manager context.`)

  return { bookName: book.name, generatedAt: new Date().toISOString(), holdings, cashWeight, coverageWeight: coreWeight, backtest, monteCarlo, macro, style, optimizer, sectors, positions, options, warnings, failures, simulationSettings: settings }
}

function analysisBooks() {
  return readPMBooks().filter(candidate => candidate.holdings.length > 0)
}

function activeBook(books = analysisBooks()): PMPortfolio | null {
  const active = readActivePortfolioContext()
  return books.find(candidate => candidate.id === active.id) ?? books[0] ?? null
}

export default function PortfolioAnalysis() {
  const [books, setBooks] = useState<PMPortfolio[]>(() => analysisBooks())
  const [book, setBook] = useState<PMPortfolio | null>(() => activeBook())
  const [settings, setSettings] = useState<AnalysisSettings>(DEFAULT_ANALYSIS_SETTINGS)
  const m = useMutation({ mutationFn: ({ nextBook, nextSettings }: { nextBook: PMPortfolio; nextSettings: AnalysisSettings }) => runAnalysis(nextBook, BENCHMARK, LOOKBACK_YEARS, nextSettings) })
  const { mutate } = m

  useEffect(() => {
    const sync = () => {
      const nextBooks = analysisBooks()
      setBooks(nextBooks)
      setBook(current => nextBooks.find(candidate => candidate.id === current?.id) ?? activeBook(nextBooks))
    }
    window.addEventListener(PORTFOLIO_CONTEXT_EVENT, sync)
    return () => window.removeEventListener(PORTFOLIO_CONTEXT_EVENT, sync)
  }, [])

  useEffect(() => {
    if (book) mutate({ nextBook: book, nextSettings: settings })
  }, [book, mutate])

  return (
    <PageWrapper title="Portfolio Analysis">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {book && <AnalysisHeader
          book={book}
          books={books}
          pending={m.isPending}
          settings={settings}
          selectBook={id => setBook(books.find(candidate => candidate.id === id) ?? book)}
          refresh={() => {
            const nextBooks = analysisBooks()
            setBooks(nextBooks)
            setBook(nextBooks.find(candidate => candidate.id === book.id) ?? activeBook(nextBooks))
          }}
        />}
        {book && <AnalysisSettingsDisclosure
          pending={m.isPending}
          settings={settings}
          applySettings={nextSettings => {
            setSettings(nextSettings)
            mutate({ nextBook: book, nextSettings })
          }}
        />}
        {!book ? <EmptyState title="No active equity portfolio" hint="Add equities in Portfolio Manager, then return here. Analysis runs automatically from the active portfolio selection." keys={['Portfolio Manager']} />
          : m.isPending ? <LoadingState label="Analyzing the active portfolio" />
          : m.error ? <ErrorState title="Analysis failed" message={(m.error as any)?.response?.data?.detail || (m.error as Error).message || 'The book could not be analysed. Retry, or check the holdings for an unknown ticker.'} onRetry={() => mutate({ nextBook: book, nextSettings: settings })} />
          : m.data ? <Results data={m.data} />
          : null}
      </div>
    </PageWrapper>
  )
}

function AnalysisHeader({ book, books, pending, settings, selectBook, refresh }: { book: PMPortfolio; books: PMPortfolio[]; pending: boolean; settings: AnalysisSettings; selectBook: (id: string) => void; refresh: () => void }) {
  return <div className="portfolio-analysis-header" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, minHeight: 50, padding: '8px 14px', border: `1px solid ${T.border}`, background: T.surface }}>
    <label style={{ minWidth: 210, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontFamily: SANS, fontSize: 8, fontWeight: 800, color: T.muted, letterSpacing: '.12em', textTransform: 'uppercase' }}>Portfolio</span>
      <select aria-label="Portfolio" value={book.id} onChange={event => selectBook(event.target.value)} style={{ minWidth: 210, height: 27, padding: '0 28px 0 8px', border: `1px solid ${T.border}`, background: T.bg, color: T.text, fontFamily: MONO, fontSize: 10.5, outline: 'none', cursor: 'pointer' }}>
        {books.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
      </select>
    </label>
    <div style={{ minWidth: 0, fontFamily: MONO, fontSize: 9.5, color: T.muted, whiteSpace: 'nowrap' }}>{book.holdings.length} equities · {book.optionsCount} options</div>
    <div style={{ marginLeft: 'auto', minWidth: 0, fontFamily: MONO, fontSize: 9.5, color: T.muted, whiteSpace: 'nowrap' }}>{BENCHMARK} · 5Y history · {(settings.horizonDays / 252).toFixed(1)}Y · {settings.simulations} paths · {modelLabel(settings.model)}</div>
    <button onClick={refresh} disabled={pending} aria-label="Refresh portfolio analysis" style={{ flex: '0 0 auto', width: 32, height: 32, display: 'grid', placeItems: 'center', border: `1px solid ${T.border}`, background: 'transparent', color: pending ? T.muted : T.gold, cursor: pending ? 'wait' : 'pointer' }}><RefreshCw size={13} /></button>
  </div>
}

function AnalysisSettingsDisclosure({ pending, settings, applySettings }: { pending: boolean; settings: AnalysisSettings; applySettings: (settings: AnalysisSettings) => void }) {
  const [advancedOpen, setAdvancedOpen] = useState(true)
  const [draft, setDraft] = useState(settings)
  useEffect(() => setDraft(settings), [settings])
  const set = <K extends keyof AnalysisSettings>(key: K, value: AnalysisSettings[K]) => setDraft(current => ({ ...current, [key]: value }))
  const normalized: AnalysisSettings = {
    horizonDays: Math.min(2520, Math.max(21, Number(draft.horizonDays) || HORIZON_DAYS)),
    simulations: Math.min(1000, Math.max(100, Number(draft.simulations) || MONTE_CARLO_RUNS)),
    leverage: Math.min(10, Math.max(1, Number(draft.leverage) || 1)),
    borrowRate: Math.min(100, Math.max(0, Number(draft.borrowRate) || 0)),
    longMaintenance: Math.min(200, Math.max(1, Number(draft.longMaintenance) || 25)),
    shortMaintenance: Math.min(200, Math.max(1, Number(draft.shortMaintenance) || 30)),
    dividendMode: draft.dividendMode,
    model: draft.model,
    tDegreesFreedom: Math.min(30, Math.max(2.1, Number(draft.tDegreesFreedom) || 5)),
    bootstrapBlockDays: Math.min(63, Math.max(1, Math.round(Number(draft.bootstrapBlockDays) || 5))),
  }
  const dirty = JSON.stringify(normalized) !== JSON.stringify(settings)
  const inputStyle: React.CSSProperties = { width: '100%', height: 29, border: `1px solid ${T.border}`, background: T.bg, color: T.text, padding: '0 8px', fontFamily: MONO, fontSize: 10, outline: 'none' }

  return <div style={{ display: 'flex', flexDirection: 'column' }}>
    <button type="button" onClick={() => setAdvancedOpen(open => !open)} aria-expanded={advancedOpen} className="portfolio-analysis-settings-trigger" style={{ width: '100%', minHeight: 42, display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px', border: `1px solid ${advancedOpen ? mix(T.gold, 65) : T.border}`, background: advancedOpen ? mix(T.gold, 7) : T.surface, color: T.text, cursor: 'pointer', textAlign: 'left' }}>
      <span style={{ fontFamily: SANS, fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: T.gold }}>Monte Carlo parameters</span>
      <span style={{ minWidth: 0, fontFamily: MONO, fontSize: 9.5, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{modelLabel(settings.model)} · {settings.simulations} paths · {settings.horizonDays} days · {settings.leverage.toFixed(1)}x leverage</span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto', fontFamily: SANS, fontSize: 9, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: advancedOpen ? T.gold : T.text }}>Advanced settings {advancedOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
    </button>
    {advancedOpen && <div className="portfolio-analysis-advanced" style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(100px, 1fr))', gap: 10, padding: '12px 14px', border: `1px solid ${T.border}`, borderTop: 0, background: T.surface }}>
      <AnalysisParameter label="Simulation model"><select value={draft.model} onChange={event => set('model', event.target.value as MonteCarloModel)} style={{ ...inputStyle, cursor: 'pointer' }}><option value="gbm">Normal GBM</option><option value="student_t">Fat tails · Student-t</option><option value="bootstrap">Historical bootstrap</option></select></AnalysisParameter>
      {draft.model === 'student_t' && <AnalysisParameter label="Tail degrees of freedom"><input type="number" min={2.1} max={30} step={0.5} value={draft.tDegreesFreedom} onChange={event => set('tDegreesFreedom', Number(event.target.value))} style={inputStyle} /></AnalysisParameter>}
      {draft.model === 'bootstrap' && <AnalysisParameter label="Bootstrap block days"><input type="number" min={1} max={63} step={1} value={draft.bootstrapBlockDays} onChange={event => set('bootstrapBlockDays', Number(event.target.value))} style={inputStyle} /></AnalysisParameter>}
      <AnalysisParameter label="Horizon (days)"><input type="number" min={21} max={2520} step={21} value={draft.horizonDays} onChange={event => set('horizonDays', Number(event.target.value))} style={inputStyle} /></AnalysisParameter>
      <AnalysisParameter label="Simulation paths"><input type="number" min={100} max={1000} step={100} value={draft.simulations} onChange={event => set('simulations', Number(event.target.value))} style={inputStyle} /></AnalysisParameter>
      <AnalysisParameter label="Leverage"><input type="number" min={1} max={10} step={0.1} value={draft.leverage} onChange={event => set('leverage', Number(event.target.value))} style={inputStyle} /></AnalysisParameter>
      <AnalysisParameter label="Borrow rate %"><input type="number" min={0} max={100} step={0.25} value={draft.borrowRate} onChange={event => set('borrowRate', Number(event.target.value))} style={inputStyle} /></AnalysisParameter>
      <AnalysisParameter label="Long maintenance %"><input type="number" min={1} max={200} step={1} value={draft.longMaintenance} onChange={event => set('longMaintenance', Number(event.target.value))} style={inputStyle} /></AnalysisParameter>
      <AnalysisParameter label="Short maintenance %"><input type="number" min={1} max={200} step={1} value={draft.shortMaintenance} onChange={event => set('shortMaintenance', Number(event.target.value))} style={inputStyle} /></AnalysisParameter>
      <AnalysisParameter label="Dividends"><select value={draft.dividendMode} onChange={event => set('dividendMode', event.target.value as DividendMode)} style={{ ...inputStyle, cursor: 'pointer' }}><option value="reinvest">Reinvest</option><option value="cash">Pay to cash</option><option value="exclude">Exclude</option></select></AnalysisParameter>
      <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 12, paddingTop: 2 }}>
        <div style={{ color: T.muted, fontFamily: SANS, fontSize: 9.5, lineHeight: 1.45 }}>{draft.model === 'student_t' ? 'Student-t paths preserve modeled drift and volatility while increasing extreme moves; lower degrees of freedom produce heavier tails.' : draft.model === 'bootstrap' ? 'Historical bootstrap resamples contiguous return blocks, retaining empirical skew, fat tails, and short-run clustering without assuming a normal distribution.' : 'Normal GBM uses independent Gaussian shocks calibrated to the portfolio’s historical drift and volatility.'} Maintenance tracks marked exposure against changing equity and breaches force deleveraging.</div>
        <button type="button" onClick={() => { setDraft(normalized); applySettings(normalized) }} disabled={!dirty || pending} style={{ marginLeft: 'auto', height: 30, minWidth: 116, border: `1px solid ${dirty ? T.gold : T.border}`, background: dirty ? mix(T.gold, 12) : 'transparent', color: dirty ? T.gold : T.muted, fontFamily: SANS, fontSize: 9, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', cursor: dirty && !pending ? 'pointer' : 'default' }}>{pending ? 'Running…' : dirty ? 'Apply & rerun' : 'Applied'}</button>
      </div>
    </div>}
  </div>
}

function AnalysisParameter({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><span style={{ color: T.muted, fontFamily: SANS, fontSize: 8, fontWeight: 800, letterSpacing: '.09em', textTransform: 'uppercase' }}>{label}</span>{children}</label>
}

function Results({ data }: { data: AnalysisResult }) {
  const { backtest: b, monteCarlo: mc, macro, optimizer } = data
  const activeReturn = b.metrics.port_cagr - b.metrics.bench_cagr
  const p5Return = mc ? (mc.percentiles.p5 - 1) * 100 : null
  const p50Return = mc ? (mc.percentiles.p50 - 1) * 100 : null
  const p95Return = mc ? (mc.percentiles.p95 - 1) * 100 : null
  const liquidationOdds = mc?.pct_forced_liquidation ?? mc?.pct_wiped ?? null
  const liquidatedPaths = liquidationOdds == null ? null : Math.round(liquidationOdds / 100 * data.simulationSettings.simulations)
  const health = b.metrics.port_sharpe >= 1 && b.metrics.max_drawdown > -25 && (macro?.concentration.effective_n ?? 0) >= 5 ? 'Balanced' : b.metrics.max_drawdown <= -35 || (macro?.concentration.effective_n ?? 99) < 3 ? 'High risk' : 'Watch'
  const healthColor = health === 'Balanced' ? T.pos : health === 'High risk' ? T.neg : T.warn

  useReportCapture(() => {
    const pieces: ClipDraft[] = [
      kpiClip('Portfolio Analysis', `${data.bookName} · Portfolio verdict`, [
        { label: 'CAGR', value: `${b.metrics.port_cagr}%` }, { label: 'Active CAGR', value: `${activeReturn}%` },
        { label: 'Volatility', value: `${b.metrics.port_vol}%` }, { label: 'Max drawdown', value: `${b.metrics.max_drawdown}%` },
        { label: 'Sharpe', value: b.metrics.port_sharpe.toFixed(2) }, { label: 'Beta', value: b.metrics.beta.toFixed(2) },
        { label: 'Monte Carlo VaR 95', value: mc ? `${mc.var_95}%` : 'Unavailable' },
        { label: 'Monte Carlo CVaR 95', value: mc ? `${mc.cvar_95}%` : 'Unavailable' },
        { label: 'Monte Carlo 5th percentile', value: p5Return == null ? 'Unavailable' : `${p5Return}%` },
        { label: 'Monte Carlo median', value: p50Return == null ? 'Unavailable' : `${p50Return}%` },
        { label: 'Monte Carlo 95th percentile', value: p95Return == null ? 'Unavailable' : `${p95Return}%` },
        { label: 'Monte Carlo liquidation odds', value: liquidationOdds == null ? 'Unavailable' : `${liquidationOdds}% (${liquidatedPaths}/${data.simulationSettings.simulations} paths)` },
        { label: 'Monte Carlo margin-call odds', value: mc ? `${mc.pct_margin_called}%` : 'Unavailable' },
        { label: 'Effective holdings', value: macro?.concentration.effective_n?.toFixed(1) ?? 'Unavailable' },
      ]),
      chartClip('Portfolio Analysis', `Cumulative wealth vs ${BENCHMARK}`, 'line', 'date', b.cumulative, [{ key: 'portfolio', label: data.bookName }, { key: 'benchmark', label: BENCHMARK }]),
      tableClip('Portfolio Analysis', 'Position decision ledger', ['Ticker', 'Weight %', 'Sector', 'Risk contribution %', 'Beta', 'Period return %', 'Decision', 'Rationale'], data.positions.map(p => [p.ticker, p.weight, p.sector, p.riskContribution, p.beta, p.periodReturn, p.decision, p.rationale])),
    ]
    if (data.sectors.length) pieces.push(tableClip('Portfolio Analysis', 'Sector exposure', ['Sector', 'Weight %', 'Holdings'], data.sectors.map(s => [s.sector, s.weight, s.holdings])))
    if (macro?.factors.length) pieces.push(tableClip('Portfolio Analysis', 'Macro factor decomposition', ['Factor', 'Proxy', 'Beta', 'Risk %', 't-stat'], macro.factors.map(f => [f.factor, f.proxy, f.beta, f.risk_pct, f.t_stat])))
    return pieces
  }, { sourceTab: 'Portfolio Analysis' })

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Panel label="Portfolio verdict" meta={new Date(data.generatedAt).toLocaleString()} style={{ padding: '42px 16px 14px' }}>
      <div className="portfolio-verdict-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, .65fr) minmax(300px, 1.5fr) minmax(260px, 1fr)', gap: 20, alignItems: 'center' }}>
        <div><div style={{ fontFamily: SANS, fontSize: 9, color: T.muted, letterSpacing: '.14em', textTransform: 'uppercase' }}>Risk posture</div><div style={{ fontFamily: MONO, fontSize: 24, color: healthColor, fontWeight: 800, marginTop: 5 }}>{health}</div></div>
        <div style={{ fontFamily: SANS, fontSize: 14, color: T.text, lineHeight: 1.55 }}>{verdict(data, activeReturn)}</div>
        <div style={{ borderLeft: `1px solid ${T.border}`, paddingLeft: 18 }}><div style={{ fontFamily: SANS, fontSize: 9, color: T.muted, letterSpacing: '.12em', textTransform: 'uppercase' }}>First decision</div><div style={{ fontFamily: MONO, fontSize: 12, color: data.positions[0]?.tone ?? T.text, marginTop: 7 }}>{data.positions[0]?.ticker ?? '—'} · {data.positions[0]?.decision ?? 'No position signal'}</div><div style={{ fontFamily: SANS, fontSize: 11, color: T.muted, marginTop: 5 }}>{data.positions[0]?.rationale}</div></div>
      </div>
    </Panel>
    <KpiStrip cellHeight={86} cells={[
      { label: 'Alpha', value: macro ? fmtPct(macro.alpha_ann_pct) : '—', sub: 'Factor adjusted', vc: chg(macro?.alpha_ann_pct) },
      { label: 'Beta', value: b.metrics.beta.toFixed(2), sub: `vs ${BENCHMARK}`, vc: b.metrics.beta > 1.2 ? T.warn : T.text },
      { label: 'Portfolio CAGR', value: fmtPct(b.metrics.port_cagr), sub: `${fmtPct(activeReturn)} active`, vc: chg(activeReturn) },
      { label: 'Max drawdown', value: `${b.metrics.max_drawdown.toFixed(1)}%`, vc: T.neg, sub: `Calmar ${b.metrics.calmar.toFixed(2)}` },
      { label: 'Sharpe', value: b.metrics.port_sharpe.toFixed(2), sub: `Sortino ${b.metrics.sortino.toFixed(2)}`, vc: b.metrics.port_sharpe >= 1 ? T.pos : T.warn },
      { label: 'Volatility', value: `${b.metrics.port_vol.toFixed(1)}%`, sub: 'Annualized', vc: b.metrics.port_vol >= 30 ? T.warn : T.text },
    ]} />
    <KpiStrip cellHeight={86} cells={[
      { label: 'VaR 95%', value: mc ? `${mc.var_95.toFixed(1)}%` : '—', sub: 'Loss not exceeded in 95% of paths', vc: T.neg },
      { label: 'CVaR 95%', value: mc ? `${mc.cvar_95.toFixed(1)}%` : '—', sub: 'Average loss in worst 5%', vc: T.neg },
      { label: '5th percentile', value: p5Return == null ? '—' : fmtPct(p5Return), sub: 'Severe downside terminal return', vc: T.neg },
      { label: 'Median outcome', value: p50Return == null ? '—' : fmtPct(p50Return), sub: '50th-percentile terminal return', vc: chg(p50Return) },
      { label: '95th percentile', value: p95Return == null ? '—' : fmtPct(p95Return), sub: 'Strong upside terminal return', vc: T.pos },
      { label: 'Liquidation odds', value: liquidationOdds == null ? '—' : `${liquidationOdds.toFixed(1)}%`, sub: mc ? `${liquidatedPaths} paths · ${mc.pct_margin_called.toFixed(1)}% calls · ${mc.median_max_margin_utilization.toFixed(1)}% peak margin` : 'Monte Carlo unavailable', vc: liquidationOdds != null && liquidationOdds > 0 ? T.neg : T.pos },
    ]} />
    {(data.warnings.length > 0 || data.failures.length > 0) && <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>{data.warnings.map(w => <Notice key={w} text={w} warn />)}{data.failures.map(f => <Notice key={f} text={`${f} was unavailable; the rest of the analysis is still valid.`} />)}</div>}
    <ConciseAnalysis data={data} />
  </div>
}

const sectorColors = [T.gold, T.blue, T.pos, T.warn, '#a78bfa', '#22d3ee', '#f97316', '#e879f9', '#14b8a6', '#fb7185', '#84cc16', '#38bdf8', '#c084fc', '#f59e0b', '#2dd4bf', T.muted]

function ConciseAnalysis({ data }: { data: AnalysisResult }) {
  const [selection, setSelection] = useState<DetailSelection | null>(null)
  const [popoverAnchor, setPopoverAnchor] = useState<PopoverAnchor | null>(null)
  const drawdowns = drawdownSeries(data.backtest.cumulative)
  const bands = monteBands(data.monteCarlo)
  const classifiedSlices: SectorChartSlice[] = data.sectors.map(sector => ({ ...sector, memberSectors: [sector.sector] }))
  const sectorData: SectorChartSlice[] = [...classifiedSlices]
  if (data.cashWeight > 0) sectorData.push({ sector: 'Cash', weight: data.cashWeight, holdings: 1, memberSectors: ['Cash'] })
  const downtrends = data.positions.filter(p => p.periodReturn != null && p.periodReturn < 0).sort((a, b) => (a.periodReturn ?? 0) - (b.periodReturn ?? 0)).slice(0, 5)
  const terminal = data.monteCarlo?.percentiles

  const chartPoint = (state: any) => state?.activePayload?.[0]?.payload
  const capturePopoverAnchor = (event: React.PointerEvent<HTMLElement>) => {
    setPopoverAnchor({ clientX: event.clientX, clientY: event.clientY })
  }

  useEffect(() => {
    if (!selection) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelection(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selection])

  return <div className="portfolio-analysis-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
    <Panel label="Sector allocation" meta="Current value · select a sector" style={{ gridColumn: '1 / -1', minHeight: 360, overflow: 'hidden' }}>
      <div className="portfolio-sector-layout" onPointerDownCapture={capturePopoverAnchor} style={{ minHeight: 330, display: 'grid', gridTemplateColumns: 'minmax(280px, .72fr) minmax(440px, 1.28fr)', alignItems: 'center', paddingTop: 28, overflow: 'hidden' }}>
        <div className="portfolio-sector-chart" style={{ minWidth: 0, height: 300, cursor: 'pointer', outline: 'none' }}><ResponsiveContainer width="100%" height="100%"><PieChart style={{ outline: 'none' }}><Pie data={sectorData} dataKey="weight" nameKey="sector" innerRadius="50%" outerRadius="76%" paddingAngle={1} stroke={T.surface} style={{ outline: 'none' }} onClick={(entry: any) => { const slice = sectorData.find(item => item.sector === (entry?.sector ?? entry?.payload?.sector)); if (slice) setSelection({ kind: 'sector', sector: slice.sector, memberSectors: slice.memberSectors }) }}>{sectorData.map((s, i) => <Cell key={s.sector} fill={sectorColors[i % sectorColors.length]} cursor="pointer" style={{ outline: 'none' }} />)}</Pie><Tooltip contentStyle={tipStyle} formatter={(value: number) => `${Number(value).toFixed(1)}%`} /></PieChart></ResponsiveContainer></div>
        <div className="portfolio-sector-legend" style={{ display: 'grid', gridTemplateColumns: sectorData.length > 8 ? 'repeat(2, minmax(0, 1fr))' : '1fr', alignContent: 'center', gap: 5, minWidth: 0, width: '100%', maxWidth: '100%', padding: '0 18px 0 8px', overflow: 'hidden' }}>{sectorData.map((s, i) => <button type="button" aria-label={`Inspect ${s.sector}, ${s.weight.toFixed(1)} percent`} aria-pressed={selection?.kind === 'sector' && selection.sector === s.sector} className="portfolio-inspectable portfolio-sector-row" onClick={() => setSelection({ kind: 'sector', sector: s.sector, memberSectors: s.memberSectors })} key={s.sector} style={{ appearance: 'none', border: '1px solid transparent', background: selection?.kind === 'sector' && selection.sector === s.sector ? T.hover : 'transparent', color: 'inherit', display: 'grid', gridTemplateColumns: '8px minmax(0, 1fr) 48px', gap: 8, alignItems: 'center', minWidth: 0, width: '100%', maxWidth: '100%', padding: '6px 7px', fontFamily: MONO, fontSize: 9.5, textAlign: 'left', cursor: 'pointer' }}><span style={{ width: 7, height: 7, background: sectorColors[i % sectorColors.length] }} /><span style={{ color: selection?.kind === 'sector' && selection.sector === s.sector ? T.text : T.muted, minWidth: 0, lineHeight: 1.25, overflowWrap: 'anywhere' }}>{s.sector}</span><span style={{ color: T.text, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{s.weight.toFixed(1)}%</span></button>)}</div>
      </div>
      {selection?.kind === 'sector' && <DetailInspector selection={selection} data={data} anchor={popoverAnchor} onClose={() => setSelection(null)} />}
    </Panel>

    <Panel label="Return path" meta={`Growth of $100 vs ${BENCHMARK} · select a date`} style={{ height: 360 }}>
      <div className="portfolio-chart-hit" onPointerDownCapture={capturePopoverAnchor} style={{ height: '100%' }}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data.backtest.cumulative} margin={{ top: 40, right: 14, bottom: 5, left: 0 }} onClick={(state: any) => { const point = chartPoint(state); if (point) setSelection({ kind: 'return', point }) }}><CartesianGrid stroke={T.borderFaint} vertical={false} /><XAxis dataKey="date" tick={{ fill: T.muted, fontSize: 9 }} minTickGap={70} /><YAxis tick={{ fill: T.muted, fontSize: 9 }} width={42} /><Tooltip contentStyle={tipStyle} /><ReferenceLine y={100} stroke={T.border} /><Line dataKey="portfolio" name={data.bookName} stroke={T.gold} strokeWidth={2} dot={false} activeDot={{ r: 4 }} /><Line dataKey="benchmark" name={BENCHMARK} stroke={T.blue} strokeWidth={1.2} dot={false} activeDot={{ r: 3 }} /></ComposedChart></ResponsiveContainer></div>
      {selection?.kind === 'return' && <DetailInspector selection={selection} data={data} anchor={popoverAnchor} onClose={() => setSelection(null)} />}
    </Panel>

    <Panel label="Downside path" meta="Peak-to-trough · select a date" style={{ height: 360 }}>
      <div className="portfolio-chart-hit" onPointerDownCapture={capturePopoverAnchor} style={{ height: '100%' }}><ResponsiveContainer width="100%" height="100%"><AreaChart data={drawdowns} margin={{ top: 40, right: 14, bottom: 5, left: 0 }} onClick={(state: any) => { const point = chartPoint(state); if (point) setSelection({ kind: 'drawdown', point }) }}><CartesianGrid stroke={T.borderFaint} vertical={false} /><XAxis dataKey="date" tick={{ fill: T.muted, fontSize: 9 }} minTickGap={70} /><YAxis tick={{ fill: T.muted, fontSize: 9 }} width={42} /><Tooltip contentStyle={tipStyle} formatter={(value: number) => `${Number(value).toFixed(1)}%`} /><ReferenceLine y={0} stroke={T.border} /><Area dataKey="drawdown" stroke={T.neg} fill={mix(T.neg, 18)} activeDot={{ r: 4 }} /></AreaChart></ResponsiveContainer></div>
      {selection?.kind === 'drawdown' && <DetailInspector selection={selection} data={data} anchor={popoverAnchor} onClose={() => setSelection(null)} />}
    </Panel>

    <Panel label="Monte Carlo range" meta={`${modelLabel(data.simulationSettings.model)} · ${data.simulationSettings.simulations} paths · ${data.simulationSettings.leverage.toFixed(1)}x · select a horizon`} style={{ gridColumn: '1 / -1', height: 350, overflow: 'hidden' }}>
      {data.monteCarlo && bands.length ? <div className="portfolio-monte-layout" onPointerDownCapture={capturePopoverAnchor} style={{ height: '100%', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 150px', gap: 14 }}>
        <div className="portfolio-chart-hit" style={{ minWidth: 0, height: '100%' }}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={bands} margin={{ top: 40, right: 5, bottom: 14, left: 0 }} onClick={(state: any) => { const point = chartPoint(state); if (point) setSelection({ kind: 'monte', point }) }}><CartesianGrid stroke={T.borderFaint} vertical={false} /><XAxis dataKey="day" tick={{ fill: T.muted, fontSize: 9 }} /><YAxis tick={{ fill: T.muted, fontSize: 9 }} width={44} /><Tooltip contentStyle={tipStyle} formatter={(value: number) => Number(value).toFixed(1)} /><ReferenceLine y={100} stroke={T.border} /><Area dataKey="p95" stroke="none" fill={mix(T.blue, 8)} /><Area dataKey="p75" stroke="none" fill={mix(T.blue, 14)} /><Area dataKey="p25" stroke="none" fill={T.surface} /><Area dataKey="p5" stroke="none" fill={mix(T.neg, 12)} /><Line dataKey="p50" name="Median" stroke={T.gold} strokeWidth={2} dot={false} activeDot={{ r: 4 }} /></ComposedChart></ResponsiveContainer></div>
        <div className="portfolio-monte-outcomes" style={{ padding: '30px 0 12px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', gap: 24, minHeight: 0 }}><Outcome label="Upside (95th)" value={terminal ? fmtPct((terminal.p95 - 1) * 100, 0) : '—'} color={T.pos} onClick={() => setSelection({ kind: 'monte', point: bands[bands.length - 1] })} /><Outcome label="Median" value={terminal ? fmtPct((terminal.p50 - 1) * 100, 0) : '—'} color={T.gold} onClick={() => setSelection({ kind: 'monte', point: bands[bands.length - 1] })} /><Outcome label="Downside (5th)" value={terminal ? fmtPct((terminal.p5 - 1) * 100, 0) : '—'} color={T.neg} onClick={() => setSelection({ kind: 'monte', point: bands[bands.length - 1] })} /><Outcome label="Tail loss" value={`-${data.monteCarlo.cvar_95.toFixed(1)}%`} color={T.neg} onClick={() => setSelection({ kind: 'monte', point: bands[bands.length - 1] })} /></div>
      </div> : <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: T.muted, fontFamily: SANS, fontSize: 11 }}>Monte Carlo unavailable</div>}
      {selection?.kind === 'monte' && <DetailInspector selection={selection} data={data} anchor={popoverAnchor} onClose={() => setSelection(null)} />}
    </Panel>

    <Panel label="Downtrend watch" meta="Select a holding for detail" style={{ gridColumn: '1 / -1', minHeight: 170, padding: '44px 14px 12px' }}>
      {downtrends.length ? <div className="portfolio-downtrend-grid" onPointerDownCapture={capturePopoverAnchor} style={{ display: 'grid', gridTemplateColumns: `repeat(${downtrends.length}, minmax(130px, 1fr))`, gap: 1, background: T.borderFaint }}>{downtrends.map(p => <button type="button" aria-label={`Inspect ${p.ticker}`} className="portfolio-inspectable" onClick={() => setSelection({ kind: 'position', ticker: p.ticker })} key={p.ticker} style={{ appearance: 'none', border: selection?.kind === 'position' && selection.ticker === p.ticker ? `1px solid ${T.gold}` : 0, background: T.surface, color: 'inherit', padding: '12px 14px', textAlign: 'left', cursor: 'pointer' }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontFamily: MONO }}><span style={{ color: T.gold, fontWeight: 800, fontSize: 12 }}>{p.ticker}</span><span style={{ color: T.neg, fontSize: 12 }}>{fmtPct(p.periodReturn)}</span></div><div style={{ color: T.muted, fontFamily: SANS, fontSize: 10, marginTop: 8, lineHeight: 1.4 }}>{p.decision}</div><div style={{ color: T.muted, fontFamily: MONO, fontSize: 9, marginTop: 5 }}>Weight {p.weight.toFixed(1)}% · Beta {p.beta?.toFixed(2) ?? '—'}</div></button>)}</div>
        : <div style={{ color: T.muted, fontFamily: SANS, fontSize: 11 }}>No modeled holding has a negative return over the five-year analysis window.</div>}
      {selection?.kind === 'position' && <DetailInspector selection={selection} data={data} anchor={popoverAnchor} onClose={() => setSelection(null)} />}
    </Panel>
  </div>
}

function Outcome({ label, value, color, onClick }: { label: string; value: string; color: string; onClick?: () => void }) {
  return <button type="button" className="portfolio-inspectable" onClick={onClick} style={{ appearance: 'none', border: 0, background: 'transparent', padding: '3px 5px', textAlign: 'left', cursor: onClick ? 'pointer' : 'default' }}><div style={{ color: T.muted, fontFamily: SANS, fontSize: 8.5, letterSpacing: '.08em', textTransform: 'uppercase' }}>{label}</div><div style={{ color, fontFamily: MONO, fontSize: 16, fontWeight: 800, marginTop: 3 }}>{value}</div></button>
}

function DetailInspector({ selection, data, anchor, onClose }: { selection: DetailSelection; data: AnalysisResult; anchor: PopoverAnchor | null; onClose: () => void }) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 12, top: 12, scale: 1, ready: false })
  let title = 'Selected detail'
  let context = ''
  let metrics: { label: string; value: string; color?: string }[] = []
  let note = ''
  let sectorHoldings: PositionDecision[] = []

  if (selection.kind === 'sector') {
    sectorHoldings = data.positions.filter(position => selection.memberSectors.includes(position.sector)).sort((a, b) => b.weight - a.weight)
    const weight = selection.sector === 'Cash' ? data.cashWeight : sectorHoldings.reduce((sum, position) => sum + position.weight, 0)
    const marketValue = sectorHoldings.reduce((sum, position) => sum + position.value, 0)
    const costBasis = sectorHoldings.reduce((sum, position) => sum + (position.shares * position.avgCost), 0)
    const unrealizedGain = marketValue - costBasis
    const unrealizedReturn = costBasis > 0 ? (unrealizedGain / costBasis) * 100 : null
    title = selection.sector
    context = 'Allocation and holdings'
    metrics = [
      { label: 'Portfolio weight', value: `${weight.toFixed(1)}%`, color: T.gold },
      { label: 'Positions', value: String(sectorHoldings.length) },
      { label: 'Market value', value: fmtMoney(marketValue) },
      { label: 'Cost basis', value: fmtMoney(costBasis) },
      { label: 'Unrealized P&L', value: fmtMoney(unrealizedGain), color: chg(unrealizedGain) },
      { label: 'Unrealized return', value: fmtPct(unrealizedReturn), color: chg(unrealizedReturn) },
    ]
    note = sectorHoldings.length ? 'Cost basis is quantity multiplied by average cost. Unrealized return compares the current sector market value with that aggregate cost basis.' : 'Cash is included in total allocation but excluded from equity factor estimates.'
  } else if (selection.kind === 'return') {
    const active = selection.point.portfolio - selection.point.benchmark
    title = selection.point.date
    context = 'Return path'
    metrics = [
      { label: data.bookName, value: selection.point.portfolio.toFixed(1), color: T.gold },
      { label: BENCHMARK, value: selection.point.benchmark.toFixed(1), color: T.blue },
      { label: 'Active wealth', value: `${active > 0 ? '+' : ''}${active.toFixed(1)}`, color: chg(active) },
      { label: 'Relative position', value: active >= 0 ? 'Ahead' : 'Behind', color: chg(active) },
    ]
    note = `Both series start at 100. Active wealth is the portfolio index minus the ${BENCHMARK} index on this date.`
  } else if (selection.kind === 'drawdown') {
    title = selection.point.date
    context = 'Downside path'
    metrics = [
      { label: 'Drawdown', value: `${selection.point.drawdown.toFixed(1)}%`, color: selection.point.drawdown < 0 ? T.neg : T.text },
      { label: 'Capital retained', value: `${(100 + selection.point.drawdown).toFixed(1)}%` },
      { label: 'Severity', value: selection.point.drawdown <= -20 ? 'Bear market' : selection.point.drawdown <= -10 ? 'Correction' : selection.point.drawdown < 0 ? 'Pullback' : 'At peak' },
    ]
    note = 'Drawdown measures the decline from the portfolio’s prior high-water mark, not the return from the analysis start.'
  } else if (selection.kind === 'monte') {
    title = `Day ${selection.point.day}`
    context = 'Monte Carlo distribution'
    metrics = [
      { label: '5th percentile', value: `${selection.point.p5.toFixed(0)} (${fmtPct(selection.point.p5 - 100, 0)})`, color: T.neg },
      { label: '25th percentile', value: `${selection.point.p25.toFixed(0)} (${fmtPct(selection.point.p25 - 100, 0)})`, color: T.warn },
      { label: 'Median', value: `${selection.point.p50.toFixed(0)} (${fmtPct(selection.point.p50 - 100, 0)})`, color: T.gold },
      { label: '95th percentile', value: `${selection.point.p95.toFixed(0)} (${fmtPct(selection.point.p95 - 100, 0)})`, color: T.pos },
    ]
    note = `Values show modeled wealth from a starting index of 100 across ${data.simulationSettings.simulations} ${modelLabel(data.simulationSettings.model).toLowerCase()} paths at ${data.simulationSettings.leverage.toFixed(1)}x leverage.`
  } else {
    const position = data.positions.find(item => item.ticker === selection.ticker)
    title = selection.ticker
    context = position?.sector ?? 'Position detail'
    metrics = position ? [
      { label: 'Weight', value: `${position.weight.toFixed(1)}%`, color: T.gold },
      { label: 'Period return', value: fmtPct(position.periodReturn), color: chg(position.periodReturn) },
      { label: 'Beta', value: position.beta?.toFixed(2) ?? 'Unavailable' },
      { label: 'Risk share', value: position.riskContribution == null ? 'Unavailable' : `${position.riskContribution.toFixed(1)}%` },
    ] : []
    note = position ? `${position.decision}. ${position.rationale}.` : 'Position detail is unavailable.'
  }

  useLayoutEffect(() => {
    const place = () => {
      const popup = popoverRef.current
      if (!popup) return
      const margin = 12
      const gap = 12
      const naturalWidth = popup.offsetWidth
      const naturalHeight = popup.offsetHeight
      const scale = Math.min(1, (window.innerWidth - margin * 2) / naturalWidth, (window.innerHeight - margin * 2) / naturalHeight)
      const fittedWidth = naturalWidth * scale
      const fittedHeight = naturalHeight * scale
      const x = anchor?.clientX ?? window.innerWidth / 2
      const y = anchor?.clientY ?? window.innerHeight / 2
      const preferredLeft = x > window.innerWidth / 2 ? x - fittedWidth - gap : x + gap
      const preferredTop = y > window.innerHeight / 2 ? y - fittedHeight - gap : y + gap
      setPosition({
        left: Math.max(margin, Math.min(preferredLeft, window.innerWidth - fittedWidth - margin)),
        top: Math.max(margin, Math.min(preferredTop, window.innerHeight - fittedHeight - margin)),
        scale,
        ready: true,
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchor, selection])

  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node)) onClose()
    }
    const dismissOnScroll = () => onClose()
    window.addEventListener('pointerdown', dismissOutside, true)
    window.addEventListener('scroll', dismissOnScroll, true)
    return () => {
      window.removeEventListener('pointerdown', dismissOutside, true)
      window.removeEventListener('scroll', dismissOnScroll, true)
    }
  }, [onClose])

  const popup = <div ref={popoverRef} className={`portfolio-chart-popover${selection.kind === 'sector' ? ' portfolio-chart-popover--sector' : ''}`} role="dialog" aria-modal="false" aria-label={`${title} ${context}`} style={{ left: position.left, top: position.top, transform: `scale(${position.scale})`, visibility: position.ready ? 'visible' : 'hidden' }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 14, paddingBottom: 10, borderBottom: `1px solid ${T.borderFaint}` }}>
      <div style={{ minWidth: 0 }}><div style={{ color: T.text, fontFamily: MONO, fontSize: 13, fontWeight: 800, overflowWrap: 'anywhere' }}>{title}</div><div style={{ color: T.muted, fontFamily: SANS, fontSize: 9, letterSpacing: '.08em', textTransform: 'uppercase', marginTop: 3 }}>{context}</div></div>
      <button type="button" onClick={onClose} aria-label="Close selected detail" className="portfolio-popover-close"><X size={13} /></button>
    </div>
    <div className="portfolio-detail-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 1, background: T.borderFaint, marginTop: 10 }}>{metrics.map(metric => <div key={metric.label} style={{ background: T.surface, padding: '9px 10px', minWidth: 0 }}><div style={{ color: T.muted, fontFamily: SANS, fontSize: 8, letterSpacing: '.08em', textTransform: 'uppercase' }}>{metric.label}</div><div style={{ color: metric.color ?? T.text, fontFamily: MONO, fontSize: 13, fontWeight: 800, marginTop: 4, overflowWrap: 'anywhere' }}>{metric.value}</div></div>)}</div>
    {selection.kind === 'sector' && sectorHoldings.length > 0 && <div style={{ marginTop: 10, border: `1px solid ${T.borderFaint}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 70px 88px', gap: 8, padding: '6px 9px', color: T.muted, fontFamily: SANS, fontSize: 8, letterSpacing: '.08em', textTransform: 'uppercase', borderBottom: `1px solid ${T.borderFaint}` }}><span>Holding</span><span style={{ textAlign: 'right' }}>Return</span><span style={{ textAlign: 'right' }}>Value</span></div>
      {sectorHoldings.map(position => { const gain = position.avgCost > 0 ? ((position.price / position.avgCost) - 1) * 100 : null; return <div key={position.ticker} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 70px 88px', gap: 8, padding: '7px 9px', borderBottom: `1px solid ${T.borderFaint}`, background: T.surface, color: T.text, fontFamily: MONO, fontSize: 9 }}><span style={{ minWidth: 0 }}><strong style={{ color: T.gold }}>{position.ticker}</strong><span style={{ color: T.muted }}> · {position.weight.toFixed(1)}%</span></span><span style={{ textAlign: 'right', color: chg(gain) }}>{fmtPct(gain)}</span><span style={{ textAlign: 'right' }}>{fmtMoney(position.value)}</span></div> })}
    </div>}
    <div style={{ color: T.muted, fontFamily: SANS, fontSize: 9.5, lineHeight: 1.45, marginTop: 10 }}>{note}</div>
  </div>

  return createPortal(popup, document.body)
}

function verdict(d: AnalysisResult, active: number) {
  const dominant = d.macro?.factors[0]
  const concentrated = (d.macro?.concentration.effective_n ?? 99) < 5
  const tail = d.monteCarlo?.cvar_95
  return `${d.bookName} has ${active >= 0 ? 'outperformed' : 'underperformed'} its benchmark by ${Math.abs(active).toFixed(1)} percentage points annualized with ${d.backtest.metrics.port_vol.toFixed(1)}% volatility. ${concentrated ? 'Capital is meaningfully concentrated.' : 'Diversification is broadly functional.'}${dominant ? ` ${dominant.factor} is the largest measured factor driver.` : ''}${tail != null ? ` The modeled 5% tail averages a ${tail.toFixed(1)}% loss over the selected horizon.` : ''}`
}

function Notice({ text, warn = false }: { text: string; warn?: boolean }) { return <div style={{ display: 'flex', gap: 8, alignItems: 'center', border: `1px solid ${warn ? mix(T.warn, 35) : T.border}`, padding: '7px 10px', color: warn ? T.warn : T.muted, fontFamily: MONO, fontSize: 9.5 }}><AlertTriangle size={13} />{text}</div> }

const tipStyle = { background: T.surface, border: `1px solid ${T.border}`, fontFamily: MONO, fontSize: 10 }
function Overview({ data, benchmark }: { data: AnalysisResult; benchmark: string }) {
  const topSectors = data.sectors.slice(0, 7)
  const riskRows = data.positions.slice(0, 8)
  return <div className="portfolio-analysis-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.65fr) minmax(300px, .8fr)', gap: 10 }}>
    <Panel label="Growth of $100" meta={`Full book · vs ${benchmark}`} style={{ height: 340 }}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data.backtest.cumulative} margin={{ top: 40, right: 14, bottom: 8, left: 0 }}><CartesianGrid stroke={T.borderFaint} vertical={false} /><XAxis dataKey="date" tick={{ fill: T.muted, fontSize: 9 }} minTickGap={70} /><YAxis tick={{ fill: T.muted, fontSize: 9 }} width={44} /><Tooltip contentStyle={tipStyle} /><ReferenceLine y={100} stroke={T.border} /><Line dataKey="portfolio" stroke={T.gold} dot={false} strokeWidth={2} name={data.bookName} /><Line dataKey="benchmark" stroke={T.blue} dot={false} strokeWidth={1.3} name={benchmark} /></ComposedChart></ResponsiveContainer></Panel>
    <Panel label="Sector exposure" meta="Direct holdings" style={{ minHeight: 340, padding: '44px 14px 12px' }}><div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>{topSectors.map((s, i) => <ExposureBar key={s.sector} label={s.sector} value={s.weight} max={topSectors[0]?.weight || 1} color={i === 0 && s.weight >= 35 ? T.warn : T.blue} />)}{data.cashWeight > 0 && <ExposureBar label="Cash" value={data.cashWeight} max={topSectors[0]?.weight || 1} color={T.muted} />}</div></Panel>
    <Panel label="Capital weight vs risk contribution" meta="Variance contribution" style={{ gridColumn: '1 / -1', minHeight: 300 }}><ResponsiveContainer width="100%" height={270}><BarChart data={riskRows} margin={{ top: 42, right: 18, left: 4, bottom: 4 }}><CartesianGrid stroke={T.borderFaint} vertical={false} /><XAxis dataKey="ticker" tick={{ fill: T.text, fontSize: 10 }} /><YAxis tick={{ fill: T.muted, fontSize: 9 }} /><Tooltip contentStyle={tipStyle} /><Bar dataKey="weight" name="Capital weight %" fill={T.blue} /><Bar dataKey="riskContribution" name="Risk contribution %" fill={T.gold} /></BarChart></ResponsiveContainer></Panel>
  </div>
}

function ExposureBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) { return <div><div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontFamily: MONO, fontSize: 10 }}><span style={{ color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span><span style={{ color }}>{value.toFixed(1)}%</span></div><div style={{ height: 5, background: T.hover, marginTop: 5 }}><div style={{ height: '100%', width: `${Math.max(1, value / max * 100)}%`, background: color }} /></div></div> }

function Performance({ data, benchmark }: { data: AnalysisResult; benchmark: string }) {
  const dd = drawdownSeries(data.backtest.cumulative)
  const beta = data.backtest.rolling_beta
  return <div className="portfolio-analysis-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
    <Panel label="Cumulative performance" meta={`Portfolio vs ${benchmark}`} style={{ height: 340 }}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={data.backtest.cumulative} margin={{ top: 40, right: 14, left: 0, bottom: 6 }}><CartesianGrid stroke={T.borderFaint} vertical={false}/><XAxis dataKey="date" tick={{ fill: T.muted, fontSize: 9 }} minTickGap={60}/><YAxis tick={{ fill: T.muted, fontSize: 9 }} width={44}/><Tooltip contentStyle={tipStyle}/><Line dataKey="portfolio" stroke={T.gold} dot={false} strokeWidth={2}/><Line dataKey="benchmark" stroke={T.blue} dot={false}/></ComposedChart></ResponsiveContainer></Panel>
    <Panel label="Drawdown" meta="Peak-to-trough" style={{ height: 340 }}><ResponsiveContainer width="100%" height="100%"><AreaChart data={dd} margin={{ top: 40, right: 14, left: 0, bottom: 6 }}><CartesianGrid stroke={T.borderFaint} vertical={false}/><XAxis dataKey="date" tick={{ fill: T.muted, fontSize: 9 }} minTickGap={60}/><YAxis tick={{ fill: T.muted, fontSize: 9 }} width={44}/><Tooltip contentStyle={tipStyle}/><Area dataKey="drawdown" stroke={T.neg} fill={mix(T.neg, 20)} /></AreaChart></ResponsiveContainer></Panel>
    <Panel label="Rolling beta" meta="60 trading days" style={{ height: 290, gridColumn: '1 / -1' }}><ResponsiveContainer width="100%" height="100%"><AreaChart data={beta} margin={{ top: 40, right: 14, left: 0, bottom: 6 }}><CartesianGrid stroke={T.borderFaint} vertical={false}/><XAxis dataKey="date" tick={{ fill: T.muted, fontSize: 9 }} minTickGap={80}/><YAxis tick={{ fill: T.muted, fontSize: 9 }} width={44}/><Tooltip contentStyle={tipStyle}/><ReferenceLine y={1} stroke={T.gold}/><Area dataKey="value" stroke={T.blue} fill={mix(T.blue, 14)} /></AreaChart></ResponsiveContainer></Panel>
  </div>
}

function RiskFactors({ data }: { data: AnalysisResult }) {
  const [factorSet, setFactorSet] = useState<'macro' | 'style'>('macro')
  const d = factorSet === 'macro' ? data.macro : data.style
  const corr = data.optimizer
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div style={{ width: 220, display: 'flex' }}><button onClick={() => setFactorSet('macro')} style={seg(factorSet === 'macro')}>Macro</button><button onClick={() => setFactorSet('style')} style={seg(factorSet === 'style')}>Style</button></div>
    {d ? <div className="portfolio-analysis-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(300px, .8fr)', gap: 10 }}>
      <Panel label={`${factorSet} factor decomposition`} meta={d.source} style={{ minHeight: 320, padding: '45px 16px 14px' }}><div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>{d.factors.map(f => <div key={f.factor} style={{ display: 'grid', gridTemplateColumns: '90px 70px 70px 1fr 55px', gap: 8, alignItems: 'center', fontFamily: MONO, fontSize: 10 }}><span style={{ color: T.text }}>{f.factor}</span><span style={{ color: T.muted }}>{f.proxy}</span><span style={{ color: chg(f.beta) }}>β {f.beta > 0 ? '+' : ''}{f.beta}</span><div style={{ height: 8, background: T.hover }}><div style={{ width: `${Math.min(100, Math.abs(f.risk_pct))}%`, height: '100%', background: f.risk_pct >= 0 ? T.gold : T.neg }} /></div><span style={{ textAlign: 'right', color: T.text }}>{f.risk_pct}%</span></div>)}</div></Panel>
      <Panel label="Risk composition" meta="Explained variance" style={{ minHeight: 320, padding: '55px 18px 18px' }}><div style={{ fontFamily: MONO, fontSize: 42, fontWeight: 800, color: T.gold }}>{d.systematic_pct.toFixed(1)}%</div><div style={{ fontFamily: SANS, fontSize: 11, color: T.muted, marginTop: 5 }}>systematic factor risk</div><div style={{ height: 10, display: 'flex', marginTop: 22 }}><div style={{ width: `${d.systematic_pct}%`, background: T.gold }} /><div style={{ flex: 1, background: T.blue }} /></div><div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontFamily: MONO, fontSize: 10 }}><span style={{ color: T.gold }}>Systematic {d.systematic_pct}%</span><span style={{ color: T.blue }}>Idiosyncratic {d.idiosyncratic_pct}%</span></div><div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${T.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}><Metric label="Annualized vol" value={`${d.ann_vol_pct}%`} /><Metric label="Factor alpha" value={fmtPct(d.alpha_ann_pct)} color={chg(d.alpha_ann_pct)} /><Metric label="Effective names" value={d.concentration.effective_n?.toFixed(1) ?? '—'} /><Metric label="HHI" value={d.concentration.hhi.toFixed(3)} /></div></Panel>
    </div> : <Notice text={`${factorSet} factor analysis was unavailable for this book and window.`} />}
    {corr && <Panel label="Current portfolio vs alternatives" meta="Same covariance and return window" style={{ padding: '44px 14px 12px' }}><ComparisonTable optimizer={corr} /></Panel>}
    {corr && corr.covariance.length > 0 && <CorrelationMatrix optimizer={corr} />}
  </div>
}

function Metric({ label, value, color = T.text }: { label: string; value: string; color?: string }) { return <div><div style={{ fontFamily: SANS, fontSize: 8.5, color: T.muted, textTransform: 'uppercase', letterSpacing: '.11em' }}>{label}</div><div style={{ fontFamily: MONO, fontSize: 16, color, marginTop: 4 }}>{value}</div></div> }
function ComparisonTable({ optimizer }: { optimizer: OptimizerData }) {
  const rows = [['Current', optimizer.portfolios.current], ['Max Sharpe', optimizer.portfolios.max_sharpe], ['Min variance', optimizer.portfolios.min_variance], ['Risk parity', optimizer.portfolios.risk_parity]] as const
  return <div style={{ overflowX: 'auto' }}><table style={tableStyle}><thead><tr>{['Portfolio', 'Expected return', 'Volatility', 'Sharpe', 'VaR 95', 'CVaR 95'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead><tbody>{rows.map(([name, p]) => p && <tr key={name}><td style={{ ...tdStyle, color: name === 'Current' ? T.gold : T.text }}>{name}</td><td style={tdNum}>{fmtPct(p.return)}</td><td style={tdNum}>{p.vol.toFixed(1)}%</td><td style={tdNum}>{p.sharpe.toFixed(2)}</td><td style={tdNum}>{p.var_95.toFixed(1)}%</td><td style={tdNum}>{p.cvar_95.toFixed(1)}%</td></tr>)}</tbody></table></div>
}

function CorrelationMatrix({ optimizer }: { optimizer: OptimizerData }) {
  const n = Math.min(12, optimizer.tickers.length)
  const names = optimizer.tickers.slice(0, n)
  const correlation = (i: number, j: number) => {
    const vi = optimizer.covariance[i]?.[i] ?? 0, vj = optimizer.covariance[j]?.[j] ?? 0
    return vi > 0 && vj > 0 ? (optimizer.covariance[i]?.[j] ?? 0) / Math.sqrt(vi * vj) : 0
  }
  return <Panel label="Correlation structure" meta={`${n} largest modeled holdings${optimizer.tickers.length > n ? ` · ${optimizer.tickers.length - n} omitted from display` : ''}`} style={{ padding: '44px 14px 14px' }}>
    <div style={{ overflowX: 'auto' }}><div style={{ display: 'grid', gridTemplateColumns: `72px repeat(${n}, minmax(42px, 1fr))`, minWidth: 72 + n * 48 }}>
      <div />{names.map(t => <div key={`h-${t}`} style={{ fontFamily: MONO, fontSize: 8.5, color: T.muted, textAlign: 'center', padding: '5px 2px' }}>{t}</div>)}
      {names.map((row, i) => <div key={row} style={{ display: 'contents' }}><div style={{ fontFamily: MONO, fontSize: 9, color: T.text, display: 'flex', alignItems: 'center', paddingLeft: 4 }}>{row}</div>{names.map((col, j) => { const c = correlation(i, j); return <div title={`${row} / ${col}: ${c.toFixed(2)}`} key={`${row}-${col}`} style={{ height: 32, margin: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: c >= 0 ? mix(T.blue, 8 + Math.abs(c) * 42) : mix(T.neg, 8 + Math.abs(c) * 42), color: Math.abs(c) >= .55 ? T.text : T.muted, fontFamily: MONO, fontSize: 8.5 }}>{c.toFixed(2)}</div> })}</div>)}
    </div></div>
  </Panel>
}

function Scenarios({ data, horizon }: { data: AnalysisResult; horizon: number }) {
  const mc = data.monteCarlo, bands = monteBands(mc)
  if (!mc) return <Notice text="Monte Carlo analysis was unavailable for this portfolio." />
  const terminal = mc.percentiles
  const outcomes = [{ label: 'Severe downside', value: terminal.p5 * 100, color: T.neg }, { label: 'Downside', value: terminal.p25 * 100, color: T.warn }, { label: 'Median', value: terminal.p50 * 100, color: T.gold }, { label: 'Upside', value: terminal.p75 * 100, color: T.blue }, { label: 'Strong upside', value: terminal.p95 * 100, color: T.pos }]
  return <div className="portfolio-analysis-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(280px, .7fr)', gap: 10 }}>
    <Panel label="Monte Carlo outcome fan" meta={`${Math.round(horizon / 252)} years · correlated portfolio returns`} style={{ height: 390 }}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={bands} margin={{ top: 40, right: 14, left: 2, bottom: 8 }}><CartesianGrid stroke={T.borderFaint} vertical={false}/><XAxis dataKey="day" tick={{ fill: T.muted, fontSize: 9 }}/><YAxis tick={{ fill: T.muted, fontSize: 9 }} width={50}/><Tooltip contentStyle={tipStyle} formatter={(value: number) => Number(value).toFixed(1)}/><ReferenceLine y={100} stroke={T.border}/><Area dataKey="p95" stroke="none" fill={mix(T.blue, 8)}/><Area dataKey="p75" stroke="none" fill={mix(T.blue, 15)}/><Area dataKey="p25" stroke="none" fill={T.surface}/><Area dataKey="p5" stroke="none" fill={mix(T.neg, 10)}/><Line dataKey="p50" stroke={T.gold} dot={false} strokeWidth={2}/></ComposedChart></ResponsiveContainer></Panel>
    <Panel label="Terminal outcomes" meta="Starting value = 100" style={{ minHeight: 390, padding: '48px 16px 12px' }}><div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>{outcomes.map(o => <div key={o.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${T.borderFaint}`, paddingBottom: 10 }}><span style={{ fontFamily: SANS, fontSize: 10, color: T.muted }}>{o.label}</span><span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 800, color: o.color }}>{o.value.toFixed(0)}</span></div>)}</div><div style={{ marginTop: 22, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}><Metric label="VaR 95" value={`-${mc.var_95.toFixed(1)}%`} color={T.neg}/><Metric label="CVaR 95" value={`-${mc.cvar_95.toFixed(1)}%`} color={T.neg}/><Metric label="Model return" value={fmtPct(mc.mu * 100)} /><Metric label="Model vol" value={`${(mc.sigma * 100).toFixed(1)}%`} /></div></Panel>
    <Panel label="Scenario interpretation" meta="Decision use" style={{ gridColumn: '1 / -1', padding: '44px 16px 14px' }}><div className="scenario-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, background: T.border }}><ScenarioCard title="Base case" value={`${((terminal.p50 - 1) * 100).toFixed(0)}%`} text="Median terminal wealth change. Use this as the center of the modeled range, not a forecast." color={T.gold}/><ScenarioCard title="Loss budget" value={`${mc.cvar_95.toFixed(1)}%`} text="Average modeled loss in the worst 5% of outcomes. Compare this with the loss the portfolio can actually tolerate." color={T.neg}/><ScenarioCard title="Capital at risk" value={`${mc.pct_wiped.toFixed(1)}%`} text="Share of modeled paths ending at zero. A non-zero result demands leverage or concentration review." color={mc.pct_wiped > 0 ? T.neg : T.pos}/></div></Panel>
  </div>
}

function ScenarioCard({ title, value, text, color }: { title: string; value: string; text: string; color: string }) { return <div style={{ background: T.surface, padding: '16px 18px' }}><div style={{ fontFamily: SANS, fontSize: 9, textTransform: 'uppercase', letterSpacing: '.12em', color: T.muted }}>{title}</div><div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 800, color, marginTop: 6 }}>{value}</div><div style={{ fontFamily: SANS, fontSize: 11, lineHeight: 1.5, color: T.muted, marginTop: 8 }}>{text}</div></div> }

function Positions({ data }: { data: AnalysisResult }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Panel label="Position decision ledger" meta="Every equity position · rules-based diagnostic" style={{ paddingTop: 32 }}><div style={{ overflowX: 'auto' }}><table style={tableStyle}><thead><tr>{['Position', 'Weight', 'Sector', 'Risk share', 'Beta', 'Period return', 'Idio. risk', 'Decision', 'Reason'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead><tbody>{data.positions.map(p => <tr key={p.ticker}><td style={{ ...tdStyle, color: T.gold, fontWeight: 800 }}>{p.ticker}<div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>{fmtMoney(p.value)}</div></td><td style={tdNum}>{p.weight.toFixed(1)}%</td><td style={tdStyle}>{p.sector}</td><td style={{ ...tdNum, color: p.riskContribution != null && p.riskContribution > p.weight * 1.2 ? T.warn : T.text }}>{p.riskContribution?.toFixed(1) ?? '—'}%</td><td style={tdNum}>{p.beta?.toFixed(2) ?? '—'}</td><td style={{ ...tdNum, color: chg(p.periodReturn) }}>{fmtPct(p.periodReturn)}</td><td style={tdNum}>{p.idiosyncratic?.toFixed(0) ?? '—'}%</td><td style={{ ...tdStyle, color: p.tone, fontWeight: 700, minWidth: 145 }}>{p.decision}</td><td style={{ ...tdStyle, color: T.muted, minWidth: 220 }}>{p.rationale}</td></tr>)}</tbody></table></div></Panel>
    {data.options.length > 0 && <Panel label="Options exposure" meta="Current mark and delta-equivalent shares" style={{ padding: '44px 14px 12px' }}><div style={{ overflowX: 'auto' }}><table style={tableStyle}><thead><tr>{['Underlying', 'Structure', 'Market value', 'Delta shares', 'Mark source'].map(h => <th style={thStyle} key={h}>{h}</th>)}</tr></thead><tbody>{data.options.map((o, i) => <tr key={`${o.underlying}-${i}`}><td style={{ ...tdStyle, color: T.gold }}>{o.underlying}</td><td style={tdStyle}>{o.label}</td><td style={tdNum}>{o.marketValue == null ? '—' : fmtMoney(o.marketValue)}</td><td style={tdNum}>{o.deltaShares?.toFixed(0) ?? '—'}</td><td style={tdStyle}>{o.source}</td></tr>)}</tbody></table></div></Panel>}
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', border: `1px solid ${T.border}`, fontFamily: SANS, color: T.muted, fontSize: 10.5 }}><CheckCircle2 size={14} color={T.pos}/><span>Decisions are deterministic review flags based on concentration, covariance risk contribution, beta, and historical return, not generated investment advice.</span><ArrowRight size={13}/><span style={{ color: T.text }}>Validate each flag against the investment thesis and tax constraints.</span></div>
  </div>
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', minWidth: 720 }
const thStyle: React.CSSProperties = { textAlign: 'left', fontFamily: SANS, fontSize: 8.5, fontWeight: 800, color: T.muted, letterSpacing: '.11em', textTransform: 'uppercase', padding: '9px 12px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }
const tdStyle: React.CSSProperties = { fontFamily: SANS, fontSize: 10.5, color: T.text, padding: '10px 12px', borderBottom: `1px solid ${T.borderFaint}` }
const tdNum: React.CSSProperties = { ...tdStyle, fontFamily: MONO, textAlign: 'right', whiteSpace: 'nowrap' }
