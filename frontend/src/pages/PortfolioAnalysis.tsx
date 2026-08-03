import { useMemo, useState } from 'react'
import axios from 'axios'
import { useMutation } from '@tanstack/react-query'
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line,
  ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { AlertTriangle, ArrowRight, CheckCircle2 } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import ErrorState from '../components/ErrorState'
import LoadingState from '../components/LoadingState'
import { T } from '../lib/theme'
import { MONO, SANS, Panel, KpiStrip, chg, mix, seg } from './cockpitKit'
import {
  cashValue, normalizeTicker, readPMBooks,
  type PMOptionPosition, type PMPortfolio,
} from '../lib/pmImport'
import { useReportCapture } from '../hooks/useReportCapture'
import { chartClip, kpiClip, tableClip } from '../lib/reportCaptureRegistry'
import type { ClipDraft } from '../lib/reportCreator'

type Tab = 'overview' | 'performance' | 'risk' | 'scenarios' | 'positions'

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
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number }
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
interface PositionDecision extends WeightedHolding {
  sector: string; riskContribution: number | null; beta: number | null; periodReturn: number | null
  idiosyncratic: number | null; decision: string; rationale: string; tone: string
}

interface AnalysisResult {
  bookName: string; generatedAt: string; holdings: WeightedHolding[]; cashWeight: number; coverageWeight: number
  backtest: BacktestData; monteCarlo: MonteCarloData | null; macro: FactorData | null; style: FactorData | null
  optimizer: OptimizerData | null; sectors: SectorExposure[]; positions: PositionDecision[]; options: OptionExposure[]
  warnings: string[]; failures: string[]
}

const LOOKBACKS = [['1Y', 1], ['3Y', 3], ['5Y', 5], ['10Y', 10]] as const
const HORIZONS = [['1Y', 252], ['3Y', 756], ['5Y', 1260], ['10Y', 2520]] as const
const fmtPct = (v: number | null | undefined, d = 1) => v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`
const fmtMoney = (v: number) => v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`
const asDate = (years: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - years); return d.toISOString().slice(0, 10) }
const endDate = () => new Date().toISOString().slice(0, 10)
const quotePrice = (q: any) => Number(q?.current_price ?? q?.price ?? q?.regular_market_price ?? 0)

function optionLegs(options: PMOptionPosition[]) {
  return options.flatMap(p => p.legs.map(l => ({
    position: p,
    leg: l,
    request: { underlying: normalizeTicker(p.underlying), expiry: l.expiry, strike: l.strike, option_type: l.type },
  })))
}

function monteBands(data: MonteCarloData | null) {
  if (!data?.sample_paths?.length) return []
  const rows = data.sample_paths
  const pick = (vals: number[], q: number) => vals[Math.min(vals.length - 1, Math.floor((vals.length - 1) * q))]
  const step = Math.max(1, Math.floor(rows.length / 100))
  return rows.filter((_, i) => i % step === 0 || i === rows.length - 1).map((row, i) => {
    const s = [...row].sort((a, b) => a - b)
    return { day: i * step, p5: pick(s, .05) * 100, p25: pick(s, .25) * 100, p50: pick(s, .5) * 100, p75: pick(s, .75) * 100, p95: pick(s, .95) * 100 }
  })
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

async function runAnalysis(book: PMPortfolio, benchmark: string, lookbackYears: number, horizonDays: number, simulations: number): Promise<AnalysisResult> {
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
    request<MonteCarloData>(axios.post('/api/portfolio/montecarlo', { tickers: core20.map(h => h.ticker), weights: normCoreWeights, start, end, n_sims: simulations, horizon_days: horizonDays }, { timeout: 120_000 })),
    request<FactorData>(axios.post('/api/portfolio/factor-decomposition', { holdings: factorHoldings, lookback_days: lookbackYears * 365, benchmark, mode: 'macro' }, { timeout: 120_000 })),
    request<FactorData>(axios.post('/api/portfolio/factor-decomposition', { holdings: factorHoldings, lookback_days: lookbackYears * 365, benchmark, mode: 'style' }, { timeout: 120_000 })),
    core20.length >= 2 ? request<OptimizerData>(axios.post('/api/portfolio-opt/optimize', { tickers: core20.map(h => h.ticker), start, end, return_model: 'historical', constraint_mode: 'long_only', weights: Object.fromEntries(core20.map((h, i) => [h.ticker, normCoreWeights[i]])) }, { timeout: 120_000 })) : Promise.resolve(null),
    request<{ rows: { symbol: string; sector: string | null }[] }>(axios.get(`/api/earnings/profile?symbols=${encodeURIComponent(tickers.join(','))}&seed_only=false`, { timeout: 45_000 })),
  ])
  const value = <T,>(i: number): T | null => tasks[i].status === 'fulfilled' ? tasks[i].value as T : null
  const backtest = value<BacktestData>(0)
  if (!backtest) throw new Error('Historical performance could not be calculated. Try a shorter lookback or check for an unpriceable holding.')
  const monteCarlo = value<MonteCarloData>(1)
  const macro = value<FactorData>(2), style = value<FactorData>(3), optimizer = value<OptimizerData>(4)
  const profiles = value<{ rows: { symbol: string; sector: string | null }[] }>(5)?.rows ?? []
  const sectorByTicker = Object.fromEntries(profiles.map(r => [r.symbol, r.sector || 'Unclassified']))
  const sectorMap = new Map<string, { weight: number; holdings: number }>()
  holdings.forEach(h => { const sector = sectorByTicker[h.ticker] || 'Unclassified'; const s = sectorMap.get(sector) ?? { weight: 0, holdings: 0 }; s.weight += h.weight; s.holdings += 1; sectorMap.set(sector, s) })
  const sectors = [...sectorMap].map(([sector, d]) => ({ sector, ...d })).sort((a, b) => b.weight - a.weight)

  const currentWeights = optimizer?.portfolios.current?.weights ?? []
  const assetByTicker = Object.fromEntries((optimizer?.assets ?? []).map(a => [a.ticker, a]))
  const factorByTicker = Object.fromEntries((macro?.holdings_detail ?? []).map(h => [h.ticker, h]))
  const positions = [...holdings].sort((a, b) => b.weight - a.weight).map(h => {
    const risk = currentWeights.find(w => w.ticker === h.ticker)?.risk_contribution ?? factorByTicker[h.ticker]?.book_var_share_pct ?? null
    const beta = assetByTicker[h.ticker]?.beta ?? factorByTicker[h.ticker]?.betas?.market ?? null
    const periodReturn = assetByTicker[h.ticker]?.total_return ?? null
    return { ...h, sector: sectorByTicker[h.ticker] || 'Unclassified', riskContribution: risk, beta, periodReturn, idiosyncratic: factorByTicker[h.ticker]?.idiosyncratic_pct ?? null, ...decisionFor(h.weight, risk, beta, periodReturn) }
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

  return { bookName: book.name, generatedAt: new Date().toISOString(), holdings, cashWeight, coverageWeight: coreWeight, backtest, monteCarlo, macro, style, optimizer, sectors, positions, options, warnings, failures }
}

export default function PortfolioAnalysis() {
  const books = useMemo(() => readPMBooks().filter(b => b.holdings.length), [])
  const [bookId, setBookId] = useState(books[0]?.id ?? '')
  const [benchmark, setBenchmark] = useState('SPY')
  const [lookback, setLookback] = useState(5)
  const [horizon, setHorizon] = useState(756)
  const [simulations, setSimulations] = useState(1000)
  const [tab, setTab] = useState<Tab>('overview')
  const m = useMutation({ mutationFn: () => {
    const book = books.find(b => b.id === bookId)
    if (!book) throw new Error('Choose a Portfolio Manager book first.')
    return runAnalysis(book, normalizeTicker(benchmark), lookback, horizon, simulations)
  } })

  return (
    <PageWrapper title="Portfolio Analysis">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <AnalysisControls books={books} bookId={bookId} setBookId={setBookId} benchmark={benchmark} setBenchmark={setBenchmark} lookback={lookback} setLookback={setLookback} horizon={horizon} setHorizon={setHorizon} simulations={simulations} setSimulations={setSimulations} pending={m.isPending} run={() => m.mutate()} />
        {m.isPending ? <LoadingState label="Running performance, factor, covariance, sector, and scenario analysis" />
          : m.error ? <ErrorState message={(m.error as any)?.response?.data?.detail || (m.error as Error).message || 'Portfolio analysis failed.'} onRetry={() => m.mutate()} />
          : m.data ? <Results data={m.data} tab={tab} setTab={setTab} benchmark={benchmark} horizon={horizon} />
          : <EmptyState title="One book. One coordinated risk audit." hint="Import the selected Portfolio Manager book and run returns, drawdowns, factor exposure, covariance, sector concentration, Monte Carlo, and position-level decisions with one set of assumptions." keys={['Return', 'Risk', 'Factors', 'Scenarios', 'Positions']} kpis={['CAGR', 'Sharpe', 'Beta', 'CVaR', 'Effective N']} preview="chart" previewLabel="Portfolio vs benchmark" action="Run full analysis" />}
      </div>
    </PageWrapper>
  )
}

function AnalysisControls(p: { books: PMPortfolio[]; bookId: string; setBookId: (v: string) => void; benchmark: string; setBenchmark: (v: string) => void; lookback: number; setLookback: (v: number) => void; horizon: number; setHorizon: (v: number) => void; simulations: number; setSimulations: (v: number) => void; pending: boolean; run: () => void }) {
  const selected = p.books.find(b => b.id === p.bookId)
  return <Panel label="Analysis mandate" meta={selected ? `${selected.holdings.length} equities · ${selected.optionsCount} options · ${selected.futuresCount} futures` : 'No saved book'} style={{ padding: '42px 16px 14px' }}>
    <div className="portfolio-analysis-controls" style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1.6fr) repeat(4, minmax(120px, .75fr)) auto', gap: 10, alignItems: 'end' }}>
      <Control label="Portfolio Manager book"><select value={p.bookId} onChange={e => p.setBookId(e.target.value)} style={inputStyle}><option value="">Choose a book</option>{p.books.map(b => <option value={b.id} key={b.id}>{b.name}</option>)}</select></Control>
      <Control label="Benchmark"><input value={p.benchmark} onChange={e => p.setBenchmark(e.target.value.toUpperCase())} style={inputStyle} /></Control>
      <Control label="History"><div style={{ display: 'flex' }}>{LOOKBACKS.map(([l, v]) => <button key={v} onClick={() => p.setLookback(v)} style={seg(p.lookback === v)}>{l}</button>)}</div></Control>
      <Control label="Outlook"><select value={p.horizon} onChange={e => p.setHorizon(Number(e.target.value))} style={inputStyle}>{HORIZONS.map(([l, v]) => <option value={v} key={v}>{l}</option>)}</select></Control>
      <Control label="Simulations"><select value={p.simulations} onChange={e => p.setSimulations(Number(e.target.value))} style={inputStyle}><option value={250}>250</option><option value={500}>500</option><option value={1000}>1,000</option></select></Control>
      <button onClick={p.run} disabled={!p.bookId || p.pending} style={{ height: 36, padding: '0 18px', border: `1px solid ${T.gold}`, background: mix(T.gold, 16), color: T.gold, fontFamily: SANS, fontWeight: 800, fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', cursor: p.pending ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>{p.pending ? 'Analyzing…' : 'Run analysis'}</button>
    </div>
  </Panel>
}

const inputStyle: React.CSSProperties = { width: '100%', height: 36, boxSizing: 'border-box', border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontFamily: MONO, fontSize: 11, padding: '0 10px', outline: 'none' }
function Control({ label, children }: { label: string; children: React.ReactNode }) { return <label><div style={{ fontFamily: SANS, fontSize: 9, color: T.muted, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', marginBottom: 6 }}>{label}</div>{children}</label> }

function Results({ data, tab, setTab, benchmark, horizon }: { data: AnalysisResult; tab: Tab; setTab: (v: Tab) => void; benchmark: string; horizon: number }) {
  const { backtest: b, monteCarlo: mc, macro, optimizer } = data
  const activeReturn = b.metrics.port_cagr - b.metrics.bench_cagr
  const health = b.metrics.port_sharpe >= 1 && b.metrics.max_drawdown > -25 && (macro?.concentration.effective_n ?? 0) >= 5 ? 'Balanced' : b.metrics.max_drawdown <= -35 || (macro?.concentration.effective_n ?? 99) < 3 ? 'High risk' : 'Watch'
  const healthColor = health === 'Balanced' ? T.pos : health === 'High risk' ? T.neg : T.warn
  const tabs: [Tab, string][] = [['overview', 'Overview'], ['performance', 'Performance'], ['risk', 'Risk & factors'], ['scenarios', 'Scenarios'], ['positions', 'Positions']]

  useReportCapture(() => {
    const pieces: ClipDraft[] = [
      kpiClip('Portfolio Analysis', `${data.bookName} · Portfolio verdict`, [
        { label: 'CAGR', value: `${b.metrics.port_cagr}%` }, { label: 'Active CAGR', value: `${activeReturn}%` },
        { label: 'Volatility', value: `${b.metrics.port_vol}%` }, { label: 'Max drawdown', value: `${b.metrics.max_drawdown}%` },
        { label: 'Sharpe', value: b.metrics.port_sharpe.toFixed(2) }, { label: 'Beta', value: b.metrics.beta.toFixed(2) },
        { label: 'Monte Carlo CVaR 95', value: mc ? `${mc.cvar_95}%` : 'Unavailable' },
        { label: 'Effective holdings', value: macro?.concentration.effective_n?.toFixed(1) ?? 'Unavailable' },
      ]),
      chartClip('Portfolio Analysis', `Cumulative wealth vs ${benchmark}`, 'line', 'date', b.cumulative, [{ key: 'portfolio', label: data.bookName }, { key: 'benchmark', label: benchmark }]),
      tableClip('Portfolio Analysis', 'Position decision ledger', ['Ticker', 'Weight %', 'Sector', 'Risk contribution %', 'Beta', 'Period return %', 'Decision', 'Rationale'], data.positions.map(p => [p.ticker, p.weight, p.sector, p.riskContribution, p.beta, p.periodReturn, p.decision, p.rationale])),
    ]
    if (data.sectors.length) pieces.push(tableClip('Portfolio Analysis', 'Sector exposure', ['Sector', 'Weight %', 'Holdings'], data.sectors.map(s => [s.sector, s.weight, s.holdings])))
    if (macro?.factors.length) pieces.push(tableClip('Portfolio Analysis', 'Macro factor decomposition', ['Factor', 'Proxy', 'Beta', 'Risk %', 't-stat'], macro.factors.map(f => [f.factor, f.proxy, f.beta, f.risk_pct, f.t_stat])))
    return pieces
  }, { sourceTab: 'Portfolio Analysis' })

  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Panel label="Portfolio verdict" meta={`${data.bookName} · ${new Date(data.generatedAt).toLocaleString()}`} style={{ padding: '42px 16px 14px' }}>
      <div className="portfolio-verdict-grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, .65fr) minmax(300px, 1.5fr) minmax(260px, 1fr)', gap: 20, alignItems: 'center' }}>
        <div><div style={{ fontFamily: SANS, fontSize: 9, color: T.muted, letterSpacing: '.14em', textTransform: 'uppercase' }}>Risk posture</div><div style={{ fontFamily: MONO, fontSize: 24, color: healthColor, fontWeight: 800, marginTop: 5 }}>{health}</div></div>
        <div style={{ fontFamily: SANS, fontSize: 14, color: T.text, lineHeight: 1.55 }}>{verdict(data, activeReturn)}</div>
        <div style={{ borderLeft: `1px solid ${T.border}`, paddingLeft: 18 }}><div style={{ fontFamily: SANS, fontSize: 9, color: T.muted, letterSpacing: '.12em', textTransform: 'uppercase' }}>First decision</div><div style={{ fontFamily: MONO, fontSize: 12, color: data.positions[0]?.tone ?? T.text, marginTop: 7 }}>{data.positions[0]?.ticker ?? '—'} · {data.positions[0]?.decision ?? 'No position signal'}</div><div style={{ fontFamily: SANS, fontSize: 11, color: T.muted, marginTop: 5 }}>{data.positions[0]?.rationale}</div></div>
      </div>
    </Panel>
    <KpiStrip cells={[
      { label: 'Portfolio CAGR', value: fmtPct(b.metrics.port_cagr), sub: `${fmtPct(activeReturn)} vs ${benchmark}`, vc: chg(activeReturn) },
      { label: 'Volatility', value: `${b.metrics.port_vol.toFixed(1)}%`, sub: `β ${b.metrics.beta.toFixed(2)}` },
      { label: 'Max drawdown', value: `${b.metrics.max_drawdown.toFixed(1)}%`, vc: T.neg, sub: `Calmar ${b.metrics.calmar.toFixed(2)}` },
      { label: 'Sharpe', value: b.metrics.port_sharpe.toFixed(2), sub: `Sortino ${b.metrics.sortino.toFixed(2)}`, vc: b.metrics.port_sharpe >= 1 ? T.pos : T.warn },
      { label: '95% CVaR', value: mc ? `-${mc.cvar_95.toFixed(1)}%` : '—', sub: `${Math.round(horizon / 252)}Y Monte Carlo`, vc: T.neg },
      { label: 'Effective names', value: macro?.concentration.effective_n?.toFixed(1) ?? '—', sub: `${data.holdings.length} equities held` },
    ]} />
    {(data.warnings.length > 0 || data.failures.length > 0) && <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>{data.warnings.map(w => <Notice key={w} text={w} warn />)}{data.failures.map(f => <Notice key={f} text={`${f} was unavailable; the rest of the analysis is still valid.`} />)}</div>}
    <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}`, overflowX: 'auto' }}>{tabs.map(([key, label]) => <button key={key} onClick={() => setTab(key)} style={{ border: 0, borderBottom: `2px solid ${tab === key ? T.gold : 'transparent'}`, background: 'transparent', color: tab === key ? T.gold : T.muted, fontFamily: SANS, fontWeight: 800, fontSize: 10, letterSpacing: '.11em', textTransform: 'uppercase', padding: '11px 18px', cursor: 'pointer', whiteSpace: 'nowrap' }}>{label}</button>)}</div>
    {tab === 'overview' && <Overview data={data} benchmark={benchmark} />}
    {tab === 'performance' && <Performance data={data} benchmark={benchmark} />}
    {tab === 'risk' && <RiskFactors data={data} />}
    {tab === 'scenarios' && <Scenarios data={data} horizon={horizon} />}
    {tab === 'positions' && <Positions data={data} />}
  </div>
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
    <Panel label="Monte Carlo outcome fan" meta={`${Math.round(horizon / 252)} years · correlated portfolio returns`} style={{ height: 390 }}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={bands} margin={{ top: 40, right: 14, left: 2, bottom: 8 }}><CartesianGrid stroke={T.borderFaint} vertical={false}/><XAxis dataKey="day" tick={{ fill: T.muted, fontSize: 9 }}/><YAxis tick={{ fill: T.muted, fontSize: 9 }} width={50}/><Tooltip contentStyle={tipStyle}/><ReferenceLine y={100} stroke={T.border}/><Area dataKey="p95" stroke="none" fill={mix(T.blue, 8)}/><Area dataKey="p75" stroke="none" fill={mix(T.blue, 15)}/><Area dataKey="p25" stroke="none" fill={T.surface}/><Area dataKey="p5" stroke="none" fill={mix(T.neg, 10)}/><Line dataKey="p50" stroke={T.gold} dot={false} strokeWidth={2}/></ComposedChart></ResponsiveContainer></Panel>
    <Panel label="Terminal outcomes" meta="Starting value = 100" style={{ minHeight: 390, padding: '48px 16px 12px' }}><div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>{outcomes.map(o => <div key={o.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${T.borderFaint}`, paddingBottom: 10 }}><span style={{ fontFamily: SANS, fontSize: 10, color: T.muted }}>{o.label}</span><span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 800, color: o.color }}>{o.value.toFixed(0)}</span></div>)}</div><div style={{ marginTop: 22, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}><Metric label="VaR 95" value={`-${mc.var_95.toFixed(1)}%`} color={T.neg}/><Metric label="CVaR 95" value={`-${mc.cvar_95.toFixed(1)}%`} color={T.neg}/><Metric label="Model return" value={fmtPct(mc.mu * 100)} /><Metric label="Model vol" value={`${(mc.sigma * 100).toFixed(1)}%`} /></div></Panel>
    <Panel label="Scenario interpretation" meta="Decision use" style={{ gridColumn: '1 / -1', padding: '44px 16px 14px' }}><div className="scenario-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, background: T.border }}><ScenarioCard title="Base case" value={`${((terminal.p50 - 1) * 100).toFixed(0)}%`} text="Median terminal wealth change. Use this as the center of the modeled range, not a forecast." color={T.gold}/><ScenarioCard title="Loss budget" value={`${mc.cvar_95.toFixed(1)}%`} text="Average modeled loss in the worst 5% of outcomes. Compare this with the loss the portfolio can actually tolerate." color={T.neg}/><ScenarioCard title="Capital at risk" value={`${mc.pct_wiped.toFixed(1)}%`} text="Share of modeled paths ending at zero. A non-zero result demands leverage or concentration review." color={mc.pct_wiped > 0 ? T.neg : T.pos}/></div></Panel>
  </div>
}

function ScenarioCard({ title, value, text, color }: { title: string; value: string; text: string; color: string }) { return <div style={{ background: T.surface, padding: '16px 18px' }}><div style={{ fontFamily: SANS, fontSize: 9, textTransform: 'uppercase', letterSpacing: '.12em', color: T.muted }}>{title}</div><div style={{ fontFamily: MONO, fontSize: 24, fontWeight: 800, color, marginTop: 6 }}>{value}</div><div style={{ fontFamily: SANS, fontSize: 11, lineHeight: 1.5, color: T.muted, marginTop: 8 }}>{text}</div></div> }

function Positions({ data }: { data: AnalysisResult }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Panel label="Position decision ledger" meta="Every equity position · rules-based diagnostic" style={{ paddingTop: 32 }}><div style={{ overflowX: 'auto' }}><table style={tableStyle}><thead><tr>{['Position', 'Weight', 'Sector', 'Risk share', 'Beta', 'Period return', 'Idio. risk', 'Decision', 'Reason'].map(h => <th key={h} style={thStyle}>{h}</th>)}</tr></thead><tbody>{data.positions.map(p => <tr key={p.ticker}><td style={{ ...tdStyle, color: T.gold, fontWeight: 800 }}>{p.ticker}<div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>{fmtMoney(p.value)}</div></td><td style={tdNum}>{p.weight.toFixed(1)}%</td><td style={tdStyle}>{p.sector}</td><td style={{ ...tdNum, color: p.riskContribution != null && p.riskContribution > p.weight * 1.2 ? T.warn : T.text }}>{p.riskContribution?.toFixed(1) ?? '—'}%</td><td style={tdNum}>{p.beta?.toFixed(2) ?? '—'}</td><td style={{ ...tdNum, color: chg(p.periodReturn) }}>{fmtPct(p.periodReturn)}</td><td style={tdNum}>{p.idiosyncratic?.toFixed(0) ?? '—'}%</td><td style={{ ...tdStyle, color: p.tone, fontWeight: 700, minWidth: 145 }}>{p.decision}</td><td style={{ ...tdStyle, color: T.muted, minWidth: 220 }}>{p.rationale}</td></tr>)}</tbody></table></div></Panel>
    {data.options.length > 0 && <Panel label="Options exposure" meta="Current mark and delta-equivalent shares" style={{ padding: '44px 14px 12px' }}><div style={{ overflowX: 'auto' }}><table style={tableStyle}><thead><tr>{['Underlying', 'Structure', 'Market value', 'Delta shares', 'Mark source'].map(h => <th style={thStyle} key={h}>{h}</th>)}</tr></thead><tbody>{data.options.map((o, i) => <tr key={`${o.underlying}-${i}`}><td style={{ ...tdStyle, color: T.gold }}>{o.underlying}</td><td style={tdStyle}>{o.label}</td><td style={tdNum}>{o.marketValue == null ? '—' : fmtMoney(o.marketValue)}</td><td style={tdNum}>{o.deltaShares?.toFixed(0) ?? '—'}</td><td style={tdStyle}>{o.source}</td></tr>)}</tbody></table></div></Panel>}
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', border: `1px solid ${T.border}`, fontFamily: SANS, color: T.muted, fontSize: 10.5 }}><CheckCircle2 size={14} color={T.pos}/><span>Decisions are deterministic review flags based on concentration, covariance risk contribution, beta, and historical return—not generated investment advice.</span><ArrowRight size={13}/><span style={{ color: T.text }}>Validate each flag against the investment thesis and tax constraints.</span></div>
  </div>
}

const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse', minWidth: 720 }
const thStyle: React.CSSProperties = { textAlign: 'left', fontFamily: SANS, fontSize: 8.5, fontWeight: 800, color: T.muted, letterSpacing: '.11em', textTransform: 'uppercase', padding: '9px 12px', borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' }
const tdStyle: React.CSSProperties = { fontFamily: SANS, fontSize: 10.5, color: T.text, padding: '10px 12px', borderBottom: `1px solid ${T.borderFaint}` }
const tdNum: React.CSSProperties = { ...tdStyle, fontFamily: MONO, textAlign: 'right', whiteSpace: 'nowrap' }
