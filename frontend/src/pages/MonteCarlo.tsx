import { useState, useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { AreaChart, Area, LineChart, Line, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend, ScatterChart, Scatter } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { KpiCell } from '../components/mmCockpit'
import { useChartColors } from '../hooks/useChartColors'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
const POS = 'var(--theme-positive)', NEG = 'var(--theme-negative)'
import StrategySelector, { STRATEGIES, CUSTOM_STRATEGY_KEY, type StrategyParams } from '../components/StrategySelector'
import { rulesForTicker } from '../components/CustomStrategyModal'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'
import { FUTURES } from '../lib/futures'
import axios from 'axios'
import EmptyState from '../components/EmptyState'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'
import UniversePicker from '../components/UniversePicker'
import { CASH_SYMBOL } from '../lib/pmImport'
import { screenerFilterToApi } from '../lib/format'
import ConfigHeader, { Field, NumberInput, paramInput, RebalanceSelect, type RebalanceFreq } from '../components/portfolio/ConfigHeader'
import { usePortfolio, type PortfolioHolding } from '../contexts/PortfolioContext'
import { PRESETS, PRESET_DESC, PRESET_GROUPS } from './strategy-builder/shared'
import { ALGO_STRATEGIES, ALGO_DEFAULT_PARAMS, ALGO_PARAM_LABELS } from './portfolio-backtester/shared'
import { ALGO_MC_HANDOFF_KEY, ALGO_MC_OPTIONS_HANDOFF_KEY, legsToCombo, ComboLegEditor, mkComboLeg, MAX_COMBO_LEGS, type AlgoMonteCarloHandoff, type AlgoOptionsMonteCarloHandoff, type ComboLeg, NumInput } from './AlgoStrategyBuilder'
import { runComboMonteCarloJob } from '../lib/mcJobClient'
// ── GBM math ────────────────────────────────────────────────────────────────

function runGBM(S0: number, mu: number, sigma: number, T: number, nSims: number) {
  return runDiffusion(S0, mu, sigma, T, nSims, gaussRandom)
}

let _seed = 12345
function uniRandom() {
  _seed = (_seed * 1664525 + 1013904223) & 0xffffffff
  return (_seed >>> 0) / 0x100000000
}
function gaussRandom() {
  const u1 = uniRandom()
  const u2 = uniRandom()
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2)
}

// Standardized Student-t shock (unit variance) — fatter tails than Gaussian, so
// extreme single-day moves and crashes show up far more often than GBM allows.
const T_DF = 5
function tRandom(df: number) {
  const z = gaussRandom()
  let chi2 = 0
  for (let i = 0; i < df; i++) { const g = gaussRandom(); chi2 += g * g }
  const t = z / Math.sqrt(chi2 / df)
  return t * Math.sqrt((df - 2) / df)
}

// GBM with a pluggable shock. shock() returns a unit-variance draw; Gaussian
// recovers classic GBM, Student-t adds fat tails without changing drift/vol.
function runDiffusion(S0: number, mu: number, sigma: number, T: number, nSims: number, shock: () => number) {
  const dt = 1 / 252
  const paths: number[][] = []
  for (let s = 0; s < nSims; s++) {
    const path = [S0]
    let v = S0
    for (let t = 0; t < T; t++) {
      v = v * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * shock())
      path.push(v)
    }
    paths.push(path)
  }
  return paths
}

// Moving-block bootstrap across all legs with SHARED block indices: resample REAL
// daily log returns in contiguous blocks, drawing the SAME historical dates for
// every leg each block. This carries genuine fat tails, volatility clustering and
// multi-day crash runs (which GBM's iid normal shocks cannot produce) AND keeps
// cross-asset correlation — a macro drawdown lands on the whole portfolio at once
// instead of being diversified away by independent per-leg draws. Each leg's
// returns are date-aligned (same length) and recentered to its own target drift.
const BLOCK_SIZE = 10
function runBootstrapShared(alignedReturns: number[][], targetMeans: number[], T: number, nSims: number, block: number): number[][][] {
  const k = alignedReturns.length
  const M = alignedReturns[0]?.length ?? 0
  const empMeans = alignedReturns.map(r => r.reduce((a, b) => a + b, 0) / (r.length || 1))
  const B = Math.min(block, M)
  const maxStart = M - B
  const out: number[][][] = alignedReturns.map(() => [])
  for (let s = 0; s < nSims; s++) {
    const v = new Array(k).fill(1.0)
    const paths: number[][] = alignedReturns.map(() => [1.0])
    let t = 0
    while (t < T) {
      const start = Math.floor(uniRandom() * (maxStart + 1))   // shared across every leg
      for (let b = 0; b < B && t < T; b++, t++) {
        for (let li = 0; li < k; li++) {
          v[li] *= Math.exp(alignedReturns[li][start + b] - empMeans[li] + targetMeans[li])
          paths[li].push(v[li])
        }
      }
    }
    for (let li = 0; li < k; li++) out[li].push(paths[li])
  }
  return out
}

// Pearson correlation matrix of the legs' aligned daily returns, clamped off ±1
// so the Cholesky stays well-conditioned.
function correlationMatrix(returns: number[][]): number[][] {
  const k = returns.length
  const M = returns[0].length
  const mean = returns.map(r => r.reduce((a, b) => a + b, 0) / r.length)
  const std = returns.map((r, i) => Math.sqrt(r.reduce((a, x) => a + (x - mean[i]) ** 2, 0) / r.length) || 1e-9)
  const R = Array.from({ length: k }, () => new Array(k).fill(0))
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let cov = 0
      for (let t = 0; t < M; t++) cov += (returns[i][t] - mean[i]) * (returns[j][t] - mean[j])
      const c = i === j ? 1 : Math.max(-0.999, Math.min(0.999, cov / M / (std[i] * std[j])))
      R[i][j] = R[j][i] = c
    }
  }
  return R
}

// Lower-triangular Cholesky factor (L·Lᵀ = A); a small diagonal jitter keeps it
// real if the empirical matrix is barely non-positive-definite.
function cholesky(A: number[][]): number[][] {
  const n = A.length
  const L = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0
      for (let m = 0; m < j; m++) sum += L[i][m] * L[j][m]
      if (i === j) L[i][j] = Math.sqrt(Math.max(A[i][i] - sum, 1e-12))
      else L[i][j] = (A[i][j] - sum) / (L[j][j] || 1e-9)
    }
  }
  return L
}

// Correlated GBM / Student-t across legs. `chol` is the Cholesky factor of the
// legs' return-correlation matrix, so multiplying an iid shock vector by it yields
// shocks with that correlation — macro moves hit correlated legs together. For
// Student-t a single chi-square scale shared per step gives joint tail dependence
// (extreme days arrive across the whole portfolio at once).
function runDiffusionCorrelated(mus: number[], sigmas: number[], chol: number[][], T: number, nSims: number, studentT: boolean): number[][][] {
  const k = mus.length
  const dt = 1 / 252
  const sqdt = Math.sqrt(dt)
  const out: number[][][] = mus.map(() => [])
  for (let s = 0; s < nSims; s++) {
    const v = new Array(k).fill(1.0)
    const paths: number[][] = mus.map(() => [1.0])
    for (let t = 0; t < T; t++) {
      const z = new Array(k)
      for (let i = 0; i < k; i++) z[i] = gaussRandom()
      let scale = 1.0
      if (studentT) {
        let chi2 = 0
        for (let i = 0; i < T_DF; i++) { const g = gaussRandom(); chi2 += g * g }
        scale = Math.sqrt((T_DF - 2) / chi2)   // standardized multivariate-t shock
      }
      for (let i = 0; i < k; i++) {
        let corr = 0
        for (let j = 0; j <= i; j++) corr += chol[i][j] * z[j]
        const shock = corr * scale
        v[i] *= Math.exp((mus[i] - 0.5 * sigmas[i] * sigmas[i]) * dt + sigmas[i] * sqdt * shock)
        paths[i].push(v[i])
      }
    }
    for (let i = 0; i < k; i++) out[i].push(paths[i])
  }
  return out
}

type SimModel = 'gbm' | 't' | 'bootstrap'
const MODEL_LABELS: Record<SimModel, string> = {
  gbm: 'GBM (lognormal)',
  t: 'Student-t (fat tails)',
  bootstrap: 'Block bootstrap (historical)',
}

/** Options-strategy MC path generators (server-side). */
type OptionsPathModel = 'gbm' | 'student_t' | 'bootstrap' | 'gbm_rn'
const OPTIONS_PATH_MODELS: { value: OptionsPathModel; label: string; hint: string }[] = [
  { value: 'gbm', label: 'GBM (physical)', hint: 'Lognormal paths, σ = max(ATM IV, HV). Multi-name correlated when possible.' },
  { value: 'student_t', label: 'Student-t (fat tails)', hint: 'Same drift/vol as GBM with fatter crash tails (df=5).' },
  { value: 'bootstrap', label: 'Block bootstrap', hint: 'Resamples each name’s historical log-return blocks (vol clustering + real tails).' },
  { value: 'gbm_rn', label: 'GBM (risk-neutral)', hint: 'Classic options RN measure: drift ≈ r, vol = ATM IV only.' },
]

function pathPercentiles(paths: number[][], day: number) {
  const vals = paths.map(p => p[day]).sort((a, b) => a - b)
  const n = vals.length
  return {
    p5:  vals[Math.floor(n * 0.05)],
    p25: vals[Math.floor(n * 0.25)],
    p50: vals[Math.floor(n * 0.50)],
    p75: vals[Math.floor(n * 0.75)],
    p95: vals[Math.floor(n * 0.95)],
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

type Leg = {
  ticker: string
  weight: number
  spot: number
  vol: number
  drift: number
  strategy: string
  stratParams: StrategyParams
  fetched: boolean
}

type ExactAlgoReplay = {
  metrics: { total_return: number; ann_return: number; max_drawdown: number; sharpe: number; num_trades: number; win_rate: number; total_pnl: number }
  bars?: number
  span?: { start: string; end: string }
}

const makeLeg = (ticker: string, weight: number): Leg => ({
  ticker, weight, spot: 100, vol: 20, drift: 8,
  strategy: STRATEGIES[0], stratParams: {}, fetched: false,
})

function readAlgoUniverseHandoff(): AlgoMonteCarloHandoff | null {
  try {
    const raw = JSON.parse(localStorage.getItem(ALGO_MC_HANDOFF_KEY) || 'null')
    if (!raw || raw.version !== 1 || !raw.strategy || !Array.isArray(raw.positions) || !raw.positions.length) return null
    return raw as AlgoMonteCarloHandoff
  } catch {
    return null
  }
}

function readAlgoOptionsHandoff(): AlgoOptionsMonteCarloHandoff | null {
  try {
    const raw = JSON.parse(localStorage.getItem(ALGO_MC_OPTIONS_HANDOFF_KEY) || 'null')
    if (!raw || raw.version !== 1 || !raw.ticker || !Array.isArray(raw.legs) || !raw.legs.length) return null
    return raw as AlgoOptionsMonteCarloHandoff
  } catch {
    return null
  }
}

// ── Styles ───────────────────────────────────────────────────────────────────

import { INPUT, TICK } from './valuationShared'

function ChartPanel({ label, height, children }: { label: React.ReactNode; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, zIndex: 10,
        background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px',
        borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)',
      }}>
        {label}
      </div>
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>
        {children}
      </div>
    </div>
  )
}

// ── Options Strategy P&L distribution ───────────────────────────────────────
// Standalone mode, separate from the portfolio GBM simulator above: pick a
// ticker + a multi-leg combo (same PRESETS as Options/Algo Strategy Builder),
// simulate the underlying to DTE via risk-neutral GBM, and show the resulting
// P&L distribution (breakevens, max profit/loss, probability of profit).

function MCModeToggle({ mode, onChange }: { mode: 'portfolio' | 'options-strategy'; onChange: (m: 'portfolio' | 'options-strategy') => void }) {
  return (
    <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
      {(['portfolio', 'options-strategy'] as const).map(m => (
        <button key={m} onClick={() => onChange(m)} style={{
          padding: '6px 14px', fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.08em', textTransform: 'uppercase', cursor: 'pointer',
          background: mode === m ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
          border: `1px solid ${mode === m ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.12))'}`,
          color: mode === m ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-secondary, #8099b0)',
        }}>{m === 'portfolio' ? 'Portfolio' : 'Options Strategy'}</button>
      ))}
    </div>
  )
}

interface DistSummary {
  mean: number | null; std: number | null; min: number | null
  p5: number | null; p25: number | null; p50: number | null
  p75: number | null; p95: number | null; max: number | null
  prob_positive: number | null
}

interface MarketRegressionSummary {
  correlation: number
  r_squared: number
  beta: number
  beta_p: number | null
  alpha_daily: number
  alpha_p: number | null
  observations: number
}

interface MarketRegression {
  benchmark: string
  n_paths: number
  n_obs: number
  n_failed: number
  /** Same strip as algo backtester: corr / R² / beta / daily α / n */
  summary?: MarketRegressionSummary
  alpha_ann_pct: DistSummary | null
  beta: DistSummary | null
  r_squared: DistSummary | null
  /** Daily returns scatter: x=market, y=strategy (+ OLS line) */
  scatter: {
    x?: number[]
    y?: number[]
    line?: { x: number; y: number }[]
    /** legacy path-coeff scatter (pre-summary) */
    beta?: number[]
    alpha_ann_pct?: number[]
    r_squared?: number[]
  }
  market_bands?: { day: number; p5: number; p50: number; p95: number }[]
  calibration?: { mu_annual: number; sigma_annual: number }
  error?: string
}

function formatPValue(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(Number(value))) return '—'
  return Number(value) < 0.001 ? '<0.001' : Number(value).toFixed(3)
}

interface ComboMcResult {
  ticker: string | null; tickers: string[] | null; is_basket: boolean
  dropped_tickers: { ticker: string; reason: string }[] | null
  spot: number | null; iv: number | null; dte: number
  entry_credit_debit: number
  breakevens: number[]
  per_ticker_breakevens: { ticker: string; spot: number; entry_credit_debit: number; breakevens: number[]; max_profit: number | null; max_loss: number | null }[] | null
  max_profit: number | null; max_loss: number | null
  prob_profit: number
  percentiles: { p5: number; p25: number; p50: number; p75: number; p95: number }
  percentiles_equity?: { p5: number; p25: number; p50: number; p75: number; p95: number }
  payoff_curve: { price: number; pnl: number }[]
  /** Hold-to-DTE: raw terminal $ P&L list. Strategy mode: binned {price,count}[]. */
  histogram: number[] | { price: number; count: number }[]
  n_sims: number
  horizon_days?: number
  path_model?: string
  has_exit_rule: boolean
  max_hold_days: number | null
  avg_hold_days: number
  pct_take_profit: number
  pct_stop_loss: number
  pct_held_to_exit_cap: number
  initial_capital: number; position_size: number; leverage: number; effective_annual_rate: number
  interest_paid_p50: number
  pnl_bands?: { day: number; p5: number; p25: number; p50: number; p75: number; p95: number }[]
  /** When "equity_100", pnl_bands are already portfolio equity on a $100 start. */
  bands_unit?: 'pnl' | 'equity_100'
  strategy_metrics?: {
    ann_return: number
    max_drawdown: number
    sharpe: number
    win_rate: number
    num_trades: number
  }
  market_regression?: MarketRegression
  diagnostics?: {
    median_trades: number
    mean_trades?: number
    pct_paths_with_trades: number
    warning: string | null
    path_cache?: { hits: number; total: number; all_cached?: boolean }
  }
}

function fmtNum(v: number | null | undefined, digits = 1, fallback = '—'): string {
  if (v == null || !Number.isFinite(Number(v))) return fallback
  return Number(v).toFixed(digits)
}

function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  return `${Number(v).toFixed(digits)}%`
}

function readAllScreens(): { id: string; name: string; filters: any[]; sortBy: string; sortDir: 'asc' | 'desc' }[] {
  const PRESETS = [
    { id: 'liquid-large-caps', name: 'Liquid Large Caps', sortBy: 'marketCap', sortDir: 'desc' as const,
      filters: [{ field: 'marketCap', operator: 'gt', value: 10 }] },
    { id: 'mega-cap-quality', name: 'Mega-Cap Quality', sortBy: 'marketCap', sortDir: 'desc' as const,
      filters: [{ field: 'marketCap', operator: 'gt', value: 100 }, { field: 'operatingMargin', operator: 'gt', value: 20 }, { field: 'roe', operator: 'gt', value: 15 }] },
    { id: 'deep-value', name: 'Deep Value', sortBy: 'peRatio', sortDir: 'asc' as const,
      filters: [{ field: 'peRatio', operator: 'gt', value: 0 }, { field: 'peRatio', operator: 'lt', value: 15 }, { field: 'pbRatio', operator: 'lt', value: 3 }] },
    { id: 'high-growth', name: 'High Growth', sortBy: 'revenueGrowth', sortDir: 'desc' as const,
      filters: [{ field: 'revenueGrowth', operator: 'gt', value: 25 }] },
    { id: 'dividend-growers', name: 'Dividend Growers', sortBy: 'dividendYield', sortDir: 'desc' as const,
      filters: [{ field: 'dividendYield', operator: 'gt', value: 2 }, { field: 'netMargin', operator: 'gt', value: 5 }] },
    { id: 'momentum-leaders', name: 'Momentum Leaders', sortBy: 'priceChange', sortDir: 'desc' as const,
      filters: [{ field: 'change52wHiPct', operator: 'gt', value: -5 }, { field: 'priceChange', operator: 'gt', value: 10, param: '3M' }] },
    { id: 'quality-at-a-price', name: 'Quality at a Price', sortBy: 'roe', sortDir: 'desc' as const,
      filters: [{ field: 'roe', operator: 'gt', value: 15 }, { field: 'peRatio', operator: 'lt', value: 25 }] },
  ]
  try {
    const raw = localStorage.getItem('fdb_screener_saved_screens_v1')
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.map((s: any) => ({
          id: s.id,
          name: s.name,
          filters: Array.isArray(s.filters) ? s.filters : [],
          sortBy: s.sortBy || 'marketCap',
          sortDir: s.sortDir || 'desc'
        }))
      }
    }
  } catch {
    // ignore
  }
  return PRESETS
}

function OptionsStrategyMonteCarlo({ onSwitchMode, handoff }: { onSwitchMode: () => void; handoff: AlgoOptionsMonteCarloHandoff | null }) {
  const cc = useChartColors()
  const { holdings } = usePortfolio()
  const [collapsed, setCollapsed] = useState(false)

  const [tickers, setTickers] = useState<string[]>(() =>
    handoff?.tickers && handoff.tickers.length > 1 ? handoff.tickers : [handoff?.ticker ?? 'AAPL']
  )
  const [tickerInput, setTickerInput] = useState<string>(() =>
    handoff?.tickers && handoff.tickers.length > 1 ? handoff.tickers.join(', ') : (handoff?.ticker ?? 'AAPL')
  )
  const [comboPreset, setComboPreset] = useState('Short Straddle')

  const allScreens = useMemo(() => readAllScreens(), [])
  const [screenerLoading, setScreenerLoading] = useState(false)
  const [screenerError, setSenerError] = useState<string | null>(null)

  const handleTickerInputChange = (val: string) => {
    setTickerInput(val)
    const list = val.split(',')
      .map(t => t.trim().toUpperCase())
      .filter(t => t.length > 0)
    setTickers(list.length > 0 ? list : ['AAPL'])
  }

  const handleScreenSelect = async (screenId: string) => {
    if (!screenId) return
    const screen = allScreens.find(s => s.id === screenId)
    if (!screen) return

    setScreenerLoading(true)
    setSenerError(null)
    try {
      const { data } = await axios.post('/api/screener/run', {
        filters: screen.filters.map((f: { field: string; operator: string; value: string | number; value2?: string | number | null; param?: string | null }) => ({
          ...f,
          value: screenerFilterToApi(f.field, String(f.value)) ?? Number(f.value),
          value2: f.value2 != null && f.value2 !== '' ? (screenerFilterToApi(f.field, String(f.value2)) ?? Number(f.value2)) : null,
        })),
        sector: null,
        exchange: null,
        sort_by: screen.sortBy,
        sort_dir: screen.sortDir,
        limit: 40,
      })
      const results = data?.results ?? []
      const list = results
        .map((r: any) => r.ticker.trim().toUpperCase())
        .filter((t: string) => t && t !== 'CASH')
      if (list.length > 0) {
        setTickers(list)
        setTickerInput(list.join(', '))
      } else {
        setSenerError('No symbols matched in screen.')
      }
    } catch (err: any) {
      setSenerError(err?.message ?? 'Failed to run screen.')
    } finally {
      setScreenerLoading(false)
    }
  }

  // Unified legs state. If a preset is loaded initially, fetch its legs.
  const [legs, setLegs] = useState<ComboLeg[]>(() =>
    handoff?.legs ?? legsToCombo(PRESETS[comboPreset] ?? [])
  )

  const updateLeg = (i: number, patch: Partial<ComboLeg>) =>
    setLegs(prev => prev.map((leg, j) => j === i ? { ...leg, ...patch } : leg))
  const addLeg = () =>
    setLegs(prev => prev.length < MAX_COMBO_LEGS ? [...prev, mkComboLeg()] : prev)
  const removeLeg = (i: number) =>
    setLegs(prev => prev.length > 1 ? prev.filter((_, j) => j !== i) : prev)

  const [comboDte, setComboDte] = useState(handoff?.dte ?? 30)
  // Default low for interactive use; large universe/horizon jobs scale up intentionally.
  const [nSims, setNSims] = useState(500)

  const [tpPct, setTpPct] = useState(handoff?.takeProfitPct ? String(handoff.takeProfitPct) : '')
  const [slPct, setSlPct] = useState(handoff?.stopLossPct ? String(handoff.stopLossPct) : '')
  const [maxHoldDays, setMaxHoldDays] = useState(handoff?.maxHoldDays ? String(handoff.maxHoldDays) : '')

  const [positionSize, setPositionSize] = useState(String(handoff?.positionSizePct ?? 8)) // Default to 8% in the screenshot
  const [leverage, setLeverage] = useState(String(handoff?.leverage ?? 3)) // Default to 3x in the screenshot
  const [borrowRate, setBorrowRate] = useState(String(handoff?.effectiveAnnualRate ?? 3.5)) // Default to 3.5% in the screenshot

  const [strategy, setStrategy] = useState<string>(handoff?.strategyName ? 'imported_algo' : 'none')
  const [strategyParams, setStrategyParams] = useState<Record<string, number>>({})
  // Keep imported Algo Builder rules in state so a re-render / preset change
  // cannot drop strategyRules while Entry Signal still says "Imported: …".
  const [importedRules, setImportedRules] = useState<{ buy: any; sell: any } | null>(
    () => handoff?.strategyRules ?? null,
  )
  const [simHorizon, setSimHorizon] = useState<number>(strategy !== 'none' || handoff?.strategyName ? 63 : 252)
  const [pathModel, setPathModel] = useState<OptionsPathModel>('student_t')

  // Mirror server caps (backend/routers/algo.py)
  const STRATEGY_N_SIMS_CAP = 2000
  const STRATEGY_HORIZON_CAP = 1260 // ~5y trading days
  const strategyMode = strategy !== 'none'
  const simsCap = strategyMode ? STRATEGY_N_SIMS_CAP : 5000
  const effectiveNSims = Math.min(Math.max(100, nSims), simsCap)
  const effectiveHorizon = strategyMode
    ? Math.min(Math.max(1, simHorizon || 63), STRATEGY_HORIZON_CAP)
    : undefined
  const effectiveDte = Math.min(Math.max(1, comboDte || 30), 365)

  // Rough ETA for display only — client no longer times out the wait.
  const mcEtaLabel = useMemo(() => {
    const nTick = Math.max(1, tickers.length)
    const h = strategyMode ? (effectiveHorizon ?? 63) : Math.min(effectiveDte, 365)
    const simDays = nTick * effectiveNSims * h
    const workers = Math.min(4, nTick)
    const estMs = nTick * 2000 + (simDays * 0.015) / Math.max(1, workers / 1.2)
    const sec = Math.round(estMs / 1000)
    if (sec < 60) return `~${Math.max(20, sec)}s`
    const min = Math.round(sec / 60)
    return min <= 1 ? '~1 min' : `~${min} min`
  }, [tickers.length, strategyMode, effectiveNSims, effectiveHorizon, effectiveDte])

  const [mcProgress, setMcProgress] = useState<{ pct: number; message: string }>({ pct: 0, message: '' })

  const { mutate, data, isPending, isError, error } = useMutation<ComboMcResult>({
    mutationFn: async () => {
      const rulesPayload = strategy === 'imported_algo'
        ? (importedRules ?? handoff?.strategyRules)
        : undefined
      if (strategy === 'imported_algo' && !rulesPayload) {
        throw new Error('Imported strategy has no buy/sell rules attached — re-export from Algo Strategy Builder.')
      }
      setMcProgress({ pct: 0, message: 'Starting job…' })
      // Async job + poll — no client wait timeout; progress comes from the server.
      return runComboMonteCarloJob<ComboMcResult>({
        ticker: tickers[0] ?? 'AAPL',
        tickers: tickers.length > 1 ? tickers : undefined,
        combo: { dte: effectiveDte, legs: legs }, n_sims: effectiveNSims,
        take_profit_pct: tpPct ? +tpPct : undefined,
        stop_loss_pct: slPct ? +slPct : undefined,
        max_hold_days: maxHoldDays ? +maxHoldDays : undefined,
        position_size: Math.min(100, Math.max(1, Number(positionSize) || 100)),
        leverage: Math.max(1, Number(leverage) || 1),
        effective_annual_rate: Math.min(100, Math.max(0, Number(borrowRate) || 0)),
        strategy: (strategy === 'none' || strategy === 'imported_algo') ? undefined : strategy,
        strategy_params: (strategy === 'none' || strategy === 'imported_algo') ? undefined : strategyParams,
        strategy_rules: rulesPayload,
        horizon_days: effectiveHorizon,
        path_model: pathModel,
      }, {
        onProgress: p => setMcProgress({ pct: p.progress, message: p.progress_message }),
      })
    },
    onSuccess: () => setMcProgress({ pct: 100, message: 'Complete' }),
    onError: () => { /* keep last progress message for context */ },
  })

  // Normalize path bands to $100-start equity for plotting
  const bandsData = useMemo(() => {
    if (!data?.pnl_bands?.length) return []
    const cap = data.initial_capital > 0 ? data.initial_capital : 10_000
    const alreadyEquity = data.bands_unit === 'equity_100'
    const mkt = data.market_regression?.market_bands
    const mktByDay = new Map((mkt ?? []).map(b => [b.day, b]))
    return data.pnl_bands.map((b: any) => {
      const scale = (v: number) => alreadyEquity ? v : 100 * (1 + v / cap)
      const mb = mktByDay.get(b.day)
      return {
        day: b.day,
        p5: scale(b.p5),
        p25: scale(b.p25),
        p50: scale(b.p50),
        p75: scale(b.p75),
        p95: scale(b.p95),
        bench_p50: mb?.p50,
      }
    })
  }, [data])

  const terminalHist = useMemo(() => {
    if (!data?.histogram?.length) return []
    const h = data.histogram
    // Strategy mode: already binned {price, count}
    if (typeof h[0] === 'object' && h[0] != null && 'count' in (h[0] as object)) {
      return h as { price: number; count: number }[]
    }
    // Hold-to-DTE: raw terminal $ P&L → bin on $100 equity scale
    const cap = data.initial_capital > 0 ? data.initial_capital : 10_000
    const vals = (h as number[]).map(v => 100 * (1 + v / cap)).filter(Number.isFinite).sort((a, b) => a - b)
    if (!vals.length) return []
    const lo = vals[Math.floor(vals.length * 0.01)]
    const hi = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))]
    const nBins = 40
    const width = Math.max(1e-6, hi - lo) / nBins
    const counts = new Array(nBins).fill(0)
    for (const v of vals) {
      const i = Math.min(nBins - 1, Math.max(0, Math.floor((v - lo) / width)))
      counts[i]++
    }
    return counts.map((count, i) => ({ price: Math.round((lo + (i + 0.5) * width) * 100) / 100, count }))
  }, [data])

  // Daily-return scatter for regression chart (strategy y vs market x)
  const regReturnsScatter = useMemo(() => {
    const sc = data?.market_regression?.scatter
    if (!sc?.x?.length || !sc?.y?.length) return []
    return sc.x.map((x, i) => ({ x, y: sc.y![i] })).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
  }, [data])

  const regReturnsLine = useMemo(() => {
    const line = data?.market_regression?.scatter?.line
    if (!line?.length) return []
    return line.map(p => ({ x: p.x, y: p.y }))
  }, [data])

  const handlePresetChange = (presetName: string) => {
    setComboPreset(presetName)
    setLegs(legsToCombo(PRESETS[presetName] ?? []))
  }

  const SUBLABEL: React.CSSProperties = {
    display: 'block',
    fontFamily: 'var(--theme-sans)',
    fontSize: 8,
    fontWeight: 700,
    letterSpacing: '0.12em',
    textTransform: 'uppercase',
    color: 'var(--theme-text-faint, rgba(255,255,255,0.4))',
    marginBottom: 3
  }


  return (
    <>
      <MCModeToggle mode="options-strategy" onChange={m => m === 'portfolio' && onSwitchMode()} />
      
      
      {/* MONTE CARLO · OPTIONS STRATEGY Header Panel */}
      <div style={{
        background: 'var(--theme-surface, #0d1826)',
        border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        padding: '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        marginBottom: 8
      }}>
        {/* Title row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: collapsed ? 'none' : '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 3, height: 14, background: 'var(--theme-primary, #c9a84c)' }} />
            <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--theme-text, #d7e3fc)' }}>MONTE CARLO · OPTIONS STRATEGY</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>
              {OPTIONS_PATH_MODELS.find(m => m.value === pathModel)?.label ?? pathModel}
              {' · '}{effectiveNSims.toLocaleString()} paths{strategyMode ? ` · ${effectiveHorizon}d horizon` : ''}
            </div>
            <button onClick={() => setCollapsed(c => !c)} title={collapsed ? 'Expand' : 'Collapse'} style={{
              background: 'transparent', border: 'none', color: 'var(--theme-text-faint, rgba(255,255,255,0.4))',
              cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center', transition: 'color 0.2s'
            }}>{collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}</button>
          </div>
        </div>

        {!collapsed && (<>

        {/* SETUP SECTION */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{ width: 2, height: 10, background: 'var(--theme-primary, #c9a84c)' }} />
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>Setup</span>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', width: '100%', marginBottom: 4 }}>
            <div style={{ flex: 1, minWidth: 150 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                <label style={SUBLABEL}>
                  Tickers (comma-separated)
                  {screenerLoading && <span style={{ color: 'var(--theme-primary, #c9a84c)', marginLeft: 6, textTransform: 'none', fontSize: 8 }}>[Running screen…]</span>}
                  {screenerError && <span style={{ color: 'var(--theme-negative, #ef4444)', marginLeft: 6, textTransform: 'none', fontSize: 8 }}>[{screenerError}]</span>}
                </label>
                <UniversePicker
                  mode="tickers"
                  tickerCap={40}
                  onImportTickers={list => { setTickers(list); setTickerInput(list.join(', ')) }}
                  screenHandoff={{ screens: allScreens, loading: screenerLoading, onSelect: handleScreenSelect, triggerLabel: 'Load from Screener' }}
                  style={{
                    background: 'var(--theme-bg, #07101a)',
                    fontSize: 8, fontWeight: 700, letterSpacing: '0.04em',
                    padding: '1px 4px', height: 15, boxSizing: 'border-box',
                  }}
                />
              </div>
              <input 
                value={tickerInput} 
                onChange={e => handleTickerInputChange(e.target.value)} 
                style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }} 
                placeholder="e.g. AAPL, MSFT, TSLA"
              />
            </div>
            <div style={{ width: 140 }}>
              <label style={SUBLABEL}>Structure</label>
              <select value={comboPreset} onChange={e => handlePresetChange(e.target.value)} style={{ ...paramInput, cursor: 'pointer', background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                {PRESET_GROUPS.map(g => (
                  <optgroup key={g.label} label={g.label}>
                    {g.keys.map(k => <option key={k} value={k}>{k}</option>)}
                  </optgroup>
                ))}
              </select>
            </div>
            <div style={{ width: 80 }}>
              <label style={SUBLABEL}>DTE</label>
              <NumInput
                value={comboDte}
                min={1}
                max={365}
                onCommit={v => setComboDte(Math.round(v))}
                title="Days to expiry for the option structure (1–365)."
                style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}
              />
            </div>
            <div style={{ width: 90 }}>
              <label style={SUBLABEL}>Simulations</label>
              <NumInput
                value={nSims}
                min={100}
                max={simsCap}
                onCommit={v => setNSims(Math.round(v))}
                title={strategyMode
                  ? `Entry-signal mode caps at ${STRATEGY_N_SIMS_CAP.toLocaleString()} paths (day-by-day pricing). Clear the field to type a new value.`
                  : 'Hold-to-DTE mode caps at 5,000 paths. Clear the field to type a new value.'}
                style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}
              />
            </div>
            <div style={{ width: 170 }}>
              <label style={SUBLABEL}>Path model</label>
              <select
                value={pathModel}
                onChange={e => setPathModel(e.target.value as OptionsPathModel)}
                title={OPTIONS_PATH_MODELS.find(m => m.value === pathModel)?.hint}
                style={{ ...paramInput, cursor: 'pointer', background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}
              >
                {OPTIONS_PATH_MODELS.map(m => (
                  <option key={m.value} value={m.value} title={m.hint}>{m.label}</option>
                ))}
              </select>
            </div>
            <div style={{ width: 140 }}>
              <label style={SUBLABEL}>Entry Signal</label>
              <select
                value={strategy}
                onChange={e => {
                  const val = e.target.value
                  setStrategy(val)
                  setStrategyParams(ALGO_DEFAULT_PARAMS[val] || {})
                  if (val === 'imported_algo' && handoff?.strategyRules) {
                    setImportedRules(handoff.strategyRules)
                  }
                }}
                style={{ ...paramInput, cursor: 'pointer', background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}
              >
                <option value="none">Enter Immediately</option>
                {handoff?.strategyName && (
                  <option value="imported_algo">Imported: {handoff.strategyName}</option>
                )}
                {ALGO_STRATEGIES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
            {strategy !== 'none' && (
              <div style={{ width: 80 }}>
                <label style={SUBLABEL}>Horizon</label>
                <NumInput
                  value={simHorizon}
                  min={1}
                  max={STRATEGY_HORIZON_CAP}
                  onCommit={v => setSimHorizon(Math.round(v))}
                  title={`Entry-signal horizon capped at ${STRATEGY_HORIZON_CAP} trading days (~5y). Clear the field to type a new value.`}
                  style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}
                />
              </div>
            )}
            {strategy !== 'none' && Object.keys(ALGO_DEFAULT_PARAMS[strategy] || {}).map(param => {
              const label = ALGO_PARAM_LABELS[strategy]?.[param] || param
              return (
                <div key={param} style={{ width: 85 }}>
                  <label style={SUBLABEL}>{label}</label>
                  <input
                    type="number"
                    value={strategyParams[param] !== undefined ? strategyParams[param] : ALGO_DEFAULT_PARAMS[strategy][param]}
                    onChange={e => {
                      const val = Number(e.target.value) || 0
                      setStrategyParams(prev => ({ ...prev, [param]: val }))
                    }}
                    style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}
                  />
                </div>
              )
            })}
            <button onClick={() => mutate()} disabled={isPending} style={{
              display: 'flex', alignItems: 'center', gap: 6, background: 'var(--theme-primary, #c9a84c)', border: '1px solid var(--theme-primary, #c9a84c)',
              color: 'var(--theme-bg, #101c2e)', fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '8px 18px', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1, whiteSpace: 'nowrap',
              boxShadow: '0 0 10px rgba(201, 168, 76, 0.3)', transition: 'all 0.2s ease', height: 28, boxSizing: 'border-box'
            }}>
              {isPending ? 'Running…' : '▶ Run Simulation'}
            </button>
          </div>
        </div>

        {/* LEGS SECTION */}
        <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 2, height: 10, background: 'var(--theme-primary, #c9a84c)' }} />
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>Legs - {legs.length}</span>
            </div>
            <button onClick={addLeg} disabled={legs.length >= 4} style={{
              background: 'none', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', padding: '3px 8px',
              cursor: legs.length >= 4 ? 'default' : 'pointer', opacity: legs.length >= 4 ? 0.5 : 1
            }}>
              + ADD LEG
            </button>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8 }}>
            {legs.map((leg, i) => {
              const isSell = leg.side === 'sell'
              const color = isSell ? 'var(--theme-negative, #ef4444)' : 'var(--theme-positive, #22c55e)'
              return (
                <div key={i} style={{
                  background: 'var(--theme-bg, #07101a)',
                  border: `1px solid ${color}44`,
                  padding: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color, textTransform: 'uppercase' }}>Leg {i + 1}</span>
                    <button type="button" onClick={() => removeLeg(i)} disabled={legs.length <= 1} style={{
                      background: 'none', border: 'none', fontSize: 14, cursor: legs.length <= 1 ? 'default' : 'pointer',
                      color: legs.length <= 1 ? 'var(--theme-text-faint, rgba(255,255,255,0.2))' : color
                    }}>×</button>
                  </div>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    <div>
                      <label style={{ ...SUBLABEL, marginBottom: 2 }}>Type</label>
                      <select value={leg.type} onChange={e => updateLeg(i, { type: e.target.value as ComboLeg['type'] })} style={{ ...paramInput, background: '#0a1628', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '4px 6px', fontSize: 11, color: 'var(--theme-text, #d7e3fc)', outline: 'none' }}>
                        <option value="call">Call</option>
                        <option value="put">Put</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ ...SUBLABEL, marginBottom: 2 }}>Side</label>
                      <select value={leg.side} onChange={e => updateLeg(i, { side: e.target.value as ComboLeg['side'] })} style={{ ...paramInput, background: '#0a1628', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '4px 6px', fontSize: 11, color: 'var(--theme-text, #d7e3fc)', outline: 'none' }}>
                        <option value="buy">Buy</option>
                        <option value="sell">Sell</option>
                      </select>
                    </div>
                  </div>
                  
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    <div>
                      <label style={{ ...SUBLABEL, marginBottom: 2 }}>Strike %</label>
                      <NumInput value={Math.round(leg.moneyness * 100)} min={1} onCommit={pct => updateLeg(i, { moneyness: Math.max(0.01, pct / 100) })} style={{ ...paramInput, background: '#0a1628', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '4px 6px', fontSize: 11, color: 'var(--theme-text, #d7e3fc)' }} />
                    </div>
                    <div>
                      <label style={{ ...SUBLABEL, marginBottom: 2 }}>Qty</label>
                      <NumInput value={leg.qty} min={1} onCommit={q => updateLeg(i, { qty: Math.max(1, Math.round(q)) })} style={{ ...paramInput, background: '#0a1628', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '4px 6px', fontSize: 11, color: 'var(--theme-text, #d7e3fc)' }} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* EXIT RULES SECTION */}
        <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{ width: 2, height: 10, background: 'var(--theme-primary, #c9a84c)' }} />
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>Exit Rules</span>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ width: 100 }}>
                <label style={SUBLABEL}>Take-Profit %</label>
                <input value={tpPct} placeholder="off" onChange={e => setTpPct(e.target.value)} style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }} />
              </div>
              <div style={{ width: 100 }}>
                <label style={SUBLABEL}>Stop-Loss %</label>
                <input value={slPct} placeholder="off" onChange={e => setSlPct(e.target.value)} style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }} />
              </div>
              <div style={{ width: 115 }}>
                <label style={SUBLABEL}>Max Hold - Days</label>
                <input value={maxHoldDays} placeholder={`${comboDte} (DTE)`} onChange={e => setMaxHoldDays(e.target.value)} style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }} />
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 280, fontSize: 9.5, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', fontFamily: 'var(--theme-mono)', lineHeight: '14px' }}>
              % of the entry credit/debit magnitude — e.g. Take-Profit 50 closes once 50% of max profit is captured, matching the position's realized P&L path day-by-day (not just at expiry). Leave blank to hold to DTE.
            </div>
          </div>
        </div>

        {/* SIZING & LEVERAGE SECTION */}
        <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingTop: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <div style={{ width: 2, height: 10, background: 'var(--theme-primary, #c9a84c)' }} />
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>Sizing & Leverage</span>
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ width: 100 }}>
                <label style={SUBLABEL}>Position Size %</label>
                <input value={positionSize} onChange={e => setPositionSize(e.target.value)} style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }} />
              </div>
              <div style={{ width: 100 }}>
                <label style={SUBLABEL}>Leverage *</label>
                <input value={leverage} onChange={e => setLeverage(e.target.value)} style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }} />
              </div>
              <div style={{ width: 115 }}>
                <label style={SUBLABEL}>Borrow Rate %</label>
                <input value={borrowRate} onChange={e => setBorrowRate(e.target.value)} style={{ ...paramInput, background: 'var(--theme-bg, #07101a)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }} />
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 280, fontSize: 9.5, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', fontFamily: 'var(--theme-mono)', lineHeight: '14px' }}>
              Each admitted trade sizes to Position Size% × Leverage of the full account (same as the Algo backtester) — not split across tickers. Leg qty ratios stay fixed. Wipeout floors at $0.
            </div>
          </div>
        </div>
      </>)}
      </div>

      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {isPending && (
          <div style={{
            background: 'var(--theme-surface, #0d1826)',
            border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
            padding: '28px 24px 24px',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
          }}>
            <div style={{
              fontFamily: 'var(--theme-mono)', fontSize: 13, fontWeight: 700,
              letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)',
            }}>
              Running Simulation…
            </div>
            <div style={{
              fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-secondary, #8099b0)',
              textAlign: 'center', maxWidth: 520, lineHeight: 1.5,
            }}>
              {strategyMode
                ? `${tickers.length} name${tickers.length === 1 ? '' : 's'} · ${effectiveNSims.toLocaleString()} paths · ${effectiveHorizon}d · rough ETA ${mcEtaLabel}`
                : `${effectiveNSims.toLocaleString()} paths · ${tickers.length} name${tickers.length === 1 ? '' : 's'} · rough ETA ${mcEtaLabel}`}
              <br />
              <span style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))' }}>
                Safe to switch tabs — job runs on the server with no client timeout.
              </span>
            </div>
            <div style={{ width: 'min(420px, 100%)', marginTop: 4 }}>
              <div style={{
                display: 'flex', justifyContent: 'space-between', marginBottom: 6,
                fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700,
                color: 'var(--theme-primary, #c9a84c)',
              }}>
                <span>{Math.min(100, Math.max(0, mcProgress.pct)).toFixed(0)}%</span>
                <span style={{ fontWeight: 500, color: 'var(--theme-secondary, #8099b0)', fontSize: 10 }}>
                  {mcProgress.message || 'Working…'}
                </span>
              </div>
              <div style={{
                height: 8, borderRadius: 4, overflow: 'hidden',
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.08)',
              }}>
                <div style={{
                  height: '100%',
                  width: `${Math.min(100, Math.max(2, mcProgress.pct || 2))}%`,
                  background: 'linear-gradient(90deg, var(--theme-primary, #c9a84c), color-mix(in srgb, var(--theme-primary, #c9a84c) 60%, #fff))',
                  boxShadow: '0 0 10px rgba(201,168,76,0.35)',
                  transition: 'width 0.35s ease',
                }} />
              </div>
            </div>
          </div>
        )}
        {!data && !isPending && (
          <EmptyState title="Options Strategy Monte Carlo" hint="Pick a ticker and a multi-leg structure, then run the simulation." action="Run Simulation" />
        )}
        {isError && !isPending && (
          <div style={{ padding: '10px 14px', border: '1px solid var(--theme-negative)', color: 'var(--theme-negative)', fontFamily: 'var(--theme-mono)', fontSize: 11, lineHeight: 1.45 }}>
            {(() => {
              const d = (error as any)?.response?.data?.detail
              if (typeof d === 'string') return d
              if (Array.isArray(d)) return d.map((x: any) => x?.msg ?? String(x)).join(' · ')
              if ((error as any)?.message) return String((error as any).message)
              return 'Simulation failed'
            })()}
          </div>
        )}
        {data && !isPending && (
          <>
            {data.diagnostics?.warning && (
              <div style={{
                padding: '10px 14px', border: '1px solid var(--theme-primary, #c9a84c)',
                background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
                fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-primary, #c9a84c)', lineHeight: 1.45,
              }}>
                {data.diagnostics.warning}
              </div>
            )}

            {data.strategy_metrics ? (
              <div style={STRIP}>
                <KpiCell grow label="CAGR (Median)" value={fmtPct(data.strategy_metrics.ann_return)} color={(data.strategy_metrics.ann_return ?? 0) >= 0 ? POS : NEG} />
                <KpiCell grow label="Sharpe (Median)" value={fmtNum(data.strategy_metrics.sharpe, 2)} color={(data.strategy_metrics.sharpe ?? 0) >= 1.0 ? POS : 'var(--theme-text)'} />
                <KpiCell grow label="Max Drawdown (Median)" value={fmtPct(data.strategy_metrics.max_drawdown)} color={NEG} />
                <KpiCell grow label="Win Rate" value={fmtPct(data.strategy_metrics.win_rate)} color={(data.strategy_metrics.win_rate ?? 0) >= 50 ? POS : NEG}
                  sub="all winning trades / all trades" />
                <KpiCell grow label="Trades / Path" value={fmtNum(data.strategy_metrics.num_trades, 2)}
                  sub={data.diagnostics
                    ? `${fmtNum(data.diagnostics.pct_paths_with_trades, 0)}% paths traded` +
                      (data.diagnostics.median_trades > 0 ? ` · med ${fmtNum(data.diagnostics.median_trades, 1)} when active` : '')
                    : 'mean across paths'} />
                <KpiCell grow label="Prob. of Profit" value={fmtPct(data.prob_profit)} color={data.prob_profit >= 50 ? POS : NEG} />
              </div>
            ) : (
              <div style={STRIP}>
                <KpiCell grow label={data.entry_credit_debit >= 0 ? 'Credit Received' : 'Debit Paid'} value={`$${Math.abs(data.entry_credit_debit).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color={data.entry_credit_debit >= 0 ? POS : NEG} />
                <KpiCell grow label="Prob. of Profit" value={fmtPct(data.prob_profit)} color={data.prob_profit >= 50 ? POS : NEG} />
                <KpiCell grow label={data.has_exit_rule ? 'Max Profit (expiry)' : 'Max Profit'} value={data.is_basket ? 'N/A (basket)' : data.max_profit == null ? 'Unlimited' : `$${data.max_profit.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color={POS} />
                <KpiCell grow label={data.has_exit_rule ? 'Max Loss (expiry)' : 'Max Loss'} value={data.is_basket ? 'N/A (basket)' : data.max_loss == null ? 'Unlimited' : `$${Math.abs(data.max_loss).toLocaleString(undefined, { maximumFractionDigits: 0 })}`} color={NEG} />
                <KpiCell grow label="Breakevens" value={data.is_basket ? 'N/A (basket)' : data.breakevens.length ? data.breakevens.map(b => `$${b.toFixed(0)}`).join(' / ') : '—'} />
                <KpiCell grow label={data.is_basket ? 'Symbols · DTE' : 'Spot · IV · DTE'} value={data.is_basket ? `${data.tickers?.length ?? 0} tickers · ${data.dte}d` : `$${fmtNum(data.spot, 2)} · ${fmtNum(data.iv, 1)}% · ${data.dte}d`} />
              </div>
            )}

            {(data.leverage > 1 || data.position_size < 100 || data.diagnostics?.path_cache) && (
              <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary, #8099b0)' }}>
                {data.position_size}% × {data.leverage}x = {(data as any).trade_size_pct != null
                  ? `${fmtNum((data as any).trade_size_pct, 1)}%`
                  : `${fmtNum(data.position_size * data.leverage, 1)}%`} per trade
                {(data as any).dollars_per_trade != null ? ` ($${(data as any).dollars_per_trade.toLocaleString(undefined, { maximumFractionDigits: 0 })})` : ''}
                {' · '}{fmtNum(data.effective_annual_rate, 2)}% EAR
                {data.interest_paid_p50 > 0 ? ` · median interest $${fmtNum(data.interest_paid_p50, 0)}` : ''}
                {data.diagnostics?.path_cache
                  ? ` · path cache ${data.diagnostics.path_cache.hits}/${data.diagnostics.path_cache.total}${data.diagnostics.path_cache.all_cached ? ' (fast re-run)' : ''}`
                  : ''}
              </div>
            )}

            {!data.strategy_metrics && data.has_exit_rule && (
              <div style={STRIP}>
                <KpiCell grow label="Avg. Hold" value={`${data.avg_hold_days}d`} sub={`of ${data.max_hold_days}d cap`} />
                <KpiCell grow label="Hit Take-Profit" value={`${data.pct_take_profit}%`} color={POS} sub="of simulated paths" />
                <KpiCell grow label="Hit Stop-Loss" value={`${data.pct_stop_loss}%`} color={NEG} sub="of simulated paths" />
                <KpiCell grow label="Held to Cap" value={`${data.pct_held_to_exit_cap}%`} sub="neither triggered" />
              </div>
            )}

            {/* Simulated Portfolio Paths chart */}
            <ChartPanel label={`Simulated Portfolio Paths ($100 start · ${data.n_sims.toLocaleString()} paths${data.horizon_days ? ` · ${data.horizon_days}d` : ''})`} height={328}>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={bandsData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                  <XAxis dataKey="day" tick={TICK} tickFormatter={d => `D${d}`} interval="preserveStartEnd" />
                  <YAxis tick={TICK} tickFormatter={v => `$${Number(v).toFixed(0)}`} domain={['auto', 'auto']} orientation="right" />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} formatter={(v: number) => [`$${Number(v).toFixed(2)}`]} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Area type="monotone" dataKey="p95" stroke={cc.gain} strokeWidth={1.5} fill="transparent" name="P95" isAnimationActive={false} />
                  <Area type="monotone" dataKey="p75" stroke={cc.c2} strokeWidth={1} fill="rgba(31,86,115,0.12)" name="P75" isAnimationActive={false} />
                  <Area type="monotone" dataKey="p50" stroke={cc.c2} strokeWidth={2.5} fill="transparent" strokeDasharray="4 2" name="Median" isAnimationActive={false} />
                  {data.market_regression?.market_bands && (
                    <Area type="monotone" dataKey="bench_p50" stroke={cc.primary} strokeWidth={1.5} fill="transparent" strokeDasharray="3 5" name={`${data.market_regression.benchmark} median`} isAnimationActive={false} />
                  )}
                  <Area type="monotone" dataKey="p25" stroke="rgba(140,46,54,0.55)" strokeWidth={1} fill="transparent" name="P25" isAnimationActive={false} />
                  <Area type="monotone" dataKey="p5" stroke={cc.loss} strokeWidth={1.5} fill="transparent" name="P5" isAnimationActive={false} />
                  <ReferenceLine y={100} stroke="var(--theme-primary, #c9a84c)" strokeDasharray="4 4" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartPanel>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-secondary, #8099b0)', marginBottom: 8 }}>
              {(['p5', 'p25', 'p50', 'p75', 'p95'] as const).map(k => {
                const eq = data.percentiles_equity?.[k]
                const val = eq != null
                  ? eq
                  : 100 * (1 + (data.percentiles?.[k] ?? 0) / (data.initial_capital || 10_000))
                const n = Number(val)
                return (
                  <span key={k}>{k.toUpperCase()}: <span style={{ color: n >= 100 ? POS : NEG, fontWeight: 700 }}>${fmtNum(n, 2)}</span></span>
                )
              })}
            </div>

            {terminalHist.length > 0 && (
              <ChartPanel label="Terminal Portfolio Distribution ($100 start)" height={208}>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={terminalHist}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="price" tick={TICK} interval="preserveStartEnd" tickFormatter={v => `$${v}`} />
                    <YAxis tick={TICK} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={BAR_CURSOR} />
                    <ReferenceLine x={100} stroke="var(--theme-primary, #c9a84c)" strokeDasharray="4 4"
                      label={{ value: 'Entry', fill: 'var(--theme-primary, #c9a84c)', fontSize: 9 }} />
                    <Bar dataKey="count" fill={cc.c2Muted} opacity={0.85} name="Frequency" isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartPanel>
            )}

            {/* Market regression KPIs directly above the regression chart (backtester layout) */}
            {data.market_regression?.summary && data.market_regression.summary.observations >= 3 && (
              <div style={{ ...STRIP, flexWrap: 'wrap' }}>
                <KpiCell
                  grow minWidth={135}
                  label="Market Corr. (r)"
                  value={data.market_regression.summary.correlation.toFixed(3)}
                  color={Math.abs(data.market_regression.summary.correlation) < 0.35 ? POS : undefined}
                  sub={`daily returns vs ${data.market_regression.benchmark}`}
                />
                <KpiCell grow label="R²" value={data.market_regression.summary.r_squared.toFixed(3)} sub="market explained" />
                <KpiCell
                  grow
                  label="Beta"
                  value={data.market_regression.summary.beta.toFixed(3)}
                  sub={`p ${formatPValue(data.market_regression.summary.beta_p)}`}
                />
                <KpiCell
                  grow
                  label="Daily Alpha"
                  value={`${data.market_regression.summary.alpha_daily >= 0 ? '+' : ''}${(data.market_regression.summary.alpha_daily * 100).toFixed(3)}%`}
                  color={data.market_regression.summary.alpha_daily >= 0 ? POS : NEG}
                  sub={`p ${formatPValue(data.market_regression.summary.alpha_p)}`}
                />
                <KpiCell
                  grow
                  label="Observations"
                  value={String(data.market_regression.summary.observations)}
                  sub="daily return pairs"
                />
              </div>
            )}

            {regReturnsScatter.length > 1 && data.market_regression && (
              <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
                <div style={{
                  position: 'absolute', top: 0, left: 0, zIndex: 10,
                  background: 'var(--theme-surface, #142032)', padding: '3px 8px',
                  borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
                  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
                  color: 'var(--theme-text, #d7e3fc)',
                }}>
                  {`Regression — Strategy vs Market (${data.market_regression.benchmark}) Daily Returns`}
                </div>
                <div style={{ paddingTop: 36, paddingLeft: 4, paddingRight: 12, paddingBottom: 12 }}>
                  <ResponsiveContainer width="100%" height={300}>
                    <ScatterChart margin={{ top: 16, right: 28, left: 8, bottom: 40 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                      <XAxis
                        type="number"
                        dataKey="x"
                        name="market"
                        tick={{ ...TICK, fontSize: 10 }}
                        tickFormatter={v => `${(Number(v) * 100).toFixed(1)}%`}
                        domain={['auto', 'auto']}
                        label={{
                          value: `${data.market_regression.benchmark} daily return`,
                          fill: 'var(--theme-secondary, #8099b0)',
                          fontSize: 11,
                          position: 'insideBottom',
                          offset: -28,
                        }}
                      />
                      <YAxis
                        type="number"
                        dataKey="y"
                        name="strategy"
                        orientation="right"
                        width={72}
                        tick={{ ...TICK, fontSize: 10 }}
                        tickFormatter={v => `${(Number(v) * 100).toFixed(1)}%`}
                        domain={['auto', 'auto']}
                        label={{
                          value: 'strategy daily return',
                          fill: 'var(--theme-secondary, #8099b0)',
                          fontSize: 11,
                          angle: 90,
                          position: 'insideRight',
                          offset: 10,
                        }}
                      />
                      <Tooltip
                        contentStyle={TOOLTIP_STYLE}
                        formatter={(v: number, name: string) => [
                          `${(Number(v) * 100).toFixed(3)}%`,
                          name === 'y' || name === 'strategy' ? 'strategy' : name === 'x' || name === 'market' ? data.market_regression!.benchmark : name,
                        ]}
                        labelFormatter={() => ''}
                      />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.12)" />
                      <ReferenceLine x={0} stroke="rgba(255,255,255,0.12)" />
                      <Scatter data={regReturnsScatter} fill={cc.c2} fillOpacity={0.28} name="days" isAnimationActive={false} />
                      {regReturnsLine.length > 0 && (
                        <Scatter
                          data={regReturnsLine}
                          line={{ stroke: 'var(--theme-primary, #c9a84c)', strokeWidth: 2 }}
                          fill="var(--theme-primary, #c9a84c)"
                          shape={() => null as any}
                          name="OLS fit"
                          isAnimationActive={false}
                          legendType="line"
                        />
                      )}
                    </ScatterChart>
                  </ResponsiveContainer>
                  <div style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', letterSpacing: '0.04em', color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', textAlign: 'center', marginTop: 4 }}>
                    OLS line · two-sided p-values test beta and alpha against zero
                  </div>
                </div>
              </div>
            )}

            {/* Basket Mode skipped tickers & breakevens table */}
            {data.is_basket && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {data.dropped_tickers && data.dropped_tickers.length > 0 && (
                  <div title={data.dropped_tickers.map(d => `${d.ticker}: ${d.reason}`).join('\n')}
                    style={{ padding: '8px 14px', border: '1px solid var(--theme-negative)', background: 'color-mix(in srgb, var(--theme-negative) 8%, transparent)', fontFamily: 'var(--theme-mono)', fontSize: 10, color: NEG }}>
                    {data.dropped_tickers.length} of {(data.tickers?.length ?? 0) + data.dropped_tickers.length} tickers skipped (no live data): {data.dropped_tickers.map(d => d.ticker).join(', ')}. The rest of the basket still ran below.
                  </div>
                )}
                {data.per_ticker_breakevens && data.per_ticker_breakevens.length > 0 && (
                  <div style={{ border: '1px solid var(--theme-border, rgba(255,255,255,0.12))', overflow: 'hidden' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.6fr 1fr 1fr', gap: 8, padding: '6px 12px', fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.12))' }}>
                      <span>Ticker</span><span>Spot</span><span>Breakevens</span><span>Max Profit</span><span>Max Loss</span>
                    </div>
                    <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                      {data.per_ticker_breakevens.map(row => (
                        <div key={row.ticker} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.6fr 1fr 1fr', gap: 8, padding: '5px 12px', fontFamily: 'var(--theme-mono)', fontSize: 10.5, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
                          <span style={{ color: 'var(--theme-text, #d7e3fc)' }}>{row.ticker}</span>
                          <span>${fmtNum(row.spot, 2)}</span>
                          <span>{row.breakevens.length ? row.breakevens.map(b => `$${b.toFixed(0)}`).join(' / ') : '—'}</span>
                          <span style={{ color: POS }}>{row.max_profit == null ? 'Unlimited' : `$${row.max_profit.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span>
                          <span style={{ color: NEG }}>{row.max_loss == null ? 'Unlimited' : `$${Math.abs(row.max_loss).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

export function MonteCarloContent() {
  const cc = useChartColors()
  const { holdings, setHoldings } = usePortfolio()
  const [algoHandoff] = useState<AlgoMonteCarloHandoff | null>(readAlgoUniverseHandoff)
  const [algoOptionsHandoff] = useState<AlgoOptionsMonteCarloHandoff | null>(readAlgoOptionsHandoff)
  const [legs, setLegs] = useState<Leg[]>(() => {
    if (algoHandoff) {
      const weight = 100 / algoHandoff.positions.length
      return algoHandoff.positions.map(position => ({
        ...makeLeg(position.ticker, weight),
        strategy: CUSTOM_STRATEGY_KEY,
        stratParams: { _custom_def: JSON.stringify(algoHandoff.strategy) } as StrategyParams,
      }))
    }
    if (holdings && holdings.length > 0) {
      return holdings.map(h => ({
        ...makeLeg(h.ticker, h.weight),
        strategy: h.strategy ?? STRATEGIES[0],
        stratParams: ((h as unknown as Record<string, unknown>).stratParams ?? {}) as StrategyParams,
      }))
    }
    return [makeLeg('SPY', 100)]
  })
  const [mcMode, setMcMode] = useState<'portfolio' | 'options-strategy'>(algoOptionsHandoff ? 'options-strategy' : 'portfolio')
  const [collapsed, setCollapsed] = useState(false)
  const [horizon, setHorizon] = useState(252)
  const [nSims, setNSims] = useState(500)
  const [model, setModel] = useState<SimModel>('gbm')
  const [benchmark, setBenchmark] = useState('SPY')
  const [targetPrice, setTargetPrice] = useState(0)
  const [fetching, setFetching] = useState(false)
  const [slPct, setSlPct] = useState('')
  const [tpPct, setTpPct] = useState('')
  const [trailPct, setTrailPct] = useState('')
  const [posPct, setPosPct] = useState('100')
  const [cashYield, setCashYield] = useState('4.5')   // % APY earned on the un-deployed cash portion
  const [leverage, setLeverage] = useState('1')
  const [borrowRate, setBorrowRate] = useState('0')
  const [rebalance, setRebalance] = useState<RebalanceFreq>('none')
  const [crspMode, setCrspMode] = useState(false)
  // CRSP mode estimates drift/vol from an actual historical window (point-in-time
  // S&P 500 membership as of `start`) rather than simulating forward from today,
  // so it needs a date range the normal per-leg GBM/bootstrap flow doesn't.
  const [crspStart, setCrspStart] = useState('2015-01-01')
  const [crspEnd, setCrspEnd] = useState(() => new Date().toISOString().split('T')[0])

  const { mutate: runExactReplay, data: exactReplay, isPending: exactReplayPending, isError: exactReplayError } = useMutation<ExactAlgoReplay>({
    mutationFn: async () => {
      if (!algoHandoff) throw new Error('No algorithm universe was imported.')
      const risk = algoHandoff.strategy.risk ?? { stopLossPct: 0, takeProfitPct: 0, trailingStopPct: 0, maxHoldBars: 0 }
      const positions = algoHandoff.positions.map(position => ({
        ticker: position.ticker,
        side: position.side,
        rules: { buy: algoHandoff.strategy.buy, sell: algoHandoff.strategy.sell },
        instrument: position.instMode === 'option'
          ? { kind: 'option', type: position.optType, moneyness: position.optType === 'call' ? 1 + position.otmPct / 100 : 1 - position.otmPct / 100, dte: position.dte }
          : position.instMode === 'combo'
            ? { kind: 'combo', dte: position.comboDte, legs: position.comboLegs }
            : undefined,
        position_size: position.tradeSize ?? algoHandoff.tradeSizePct,
        stop_loss: risk.stopLossPct || undefined,
        take_profit: risk.takeProfitPct || undefined,
        trailing_stop: risk.trailingStopPct || undefined,
        max_hold_bars: risk.maxHoldBars || undefined,
      }))
      const { data } = await axios.post('/api/strategy/portfolio-backtest', {
        positions,
        start: algoHandoff.start,
        end: algoHandoff.end,
        timeframe: algoHandoff.timeframe,
        initial_capital: 10_000,
        position_size: algoHandoff.tradeSizePct,
        leverage: algoHandoff.leverage ?? 1,
        effective_annual_rate: algoHandoff.effectiveAnnualRate ?? 0,
      })
      return data
    },
  })


  const updateLeg = (i: number, patch: Partial<Leg>) =>
    setLegs(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l))

  const fetchAll = async () => {
    setFetching(true)
    const updated = await Promise.all(
      legs.map(async (leg) => {
        // The synthetic cash sleeve has no price history; keep its preset vol/drift.
        if (leg.ticker === CASH_SYMBOL) return leg
        try {
          const { data } = await axios.get(`/api/market/history?ticker=${leg.ticker}&start=2022-01-01`)
          if (data?.metrics) {
            const years = Math.max(new Date().getFullYear() - 2022, 1)
            // CAGR = (1 + totalReturn/100)^(1/years) - 1; cap at ±150%/yr for sane simulation
            const cagr = (Math.pow(1 + data.metrics.total_return / 100, 1 / years) - 1) * 100
            const drift = Math.max(-150, Math.min(150, +cagr.toFixed(1)))
            return {
              ...leg,
              spot: +data.metrics.current_price.toFixed(2),
              vol:  +data.metrics.ann_volatility.toFixed(1),
              drift,
              fetched: true,
            }
          }
        } catch { /* keep defaults */ }
        return leg
      })
    )
    setLegs(updated)
    setFetching(false)
  }

  function applyRiskControls(paths: number[][]): number[][] {
    const sl    = slPct    ? parseFloat(slPct)    / 100 : null
    const tp    = tpPct    ? parseFloat(tpPct)    / 100 : null
    const trail = trailPct ? parseFloat(trailPct) / 100 : null
    const pos   = parseFloat(posPct || '100') / 100
    const cy    = (parseFloat(cashYield) || 0) / 100   // cash sleeve APY
    const S0 = 1.0
    return paths.map(path => {
      let peak = S0
      let exited = false
      let exitVal = S0
      return path.map((v, day) => {
        if (day === 0) { peak = S0; exited = false; return v }
        if (exited) return exitVal
        // Position sizing: the un-deployed cash portion compounds at the cash yield
        const scaled = pos * v + (1 - pos) * S0 * Math.pow(1 + cy, day / 252)
        peak = Math.max(peak, v)
        if (sl   !== null && scaled <= S0 * (1 - sl))   { exited = true; exitVal = S0 * (1 - sl); return exitVal }
        if (tp   !== null && scaled >= S0 * (1 + tp))   { exited = true; exitVal = S0 * (1 + tp); return exitVal }
        if (trail !== null && v <= peak * (1 - trail)) { exited = true; exitVal = peak * (1 - trail); return exitVal }
        return scaled
      })
    })
  }

  const { mutate, data, isPending } = useMutation({
    mutationFn: async () => {
      _seed = 42 * (horizon + nSims + legs.length)

      if (crspMode) {
        const [{ data: simulation }, benchResult] = await Promise.all([
          axios.post('/api/portfolio/montecarlo', {
            crsp_mode: true,
            start: crspStart,
            end: crspEnd,
            n_sims: Math.min(nSims, 1000),
            horizon_days: horizon,
            leverage: Math.max(1, Number(leverage) || 1),
            borrow_rate: Math.max(0, Number(borrowRate) || 0),
          }),
          axios.get(`/api/market/history?ticker=${benchmark}&start=2020-01-01`)
            .then(r => r.data)
            .catch(() => null),
        ])

        // The API returns its chart sample time-major; transpose to the path-major
        // shape used by the shared percentile helpers below.
        const sampledPaths = (simulation.sample_paths?.[0] ?? []).map((_: number, i: number) =>
          simulation.sample_paths.map((row: number[]) => row[i] * 100)
        )
        const terminal = (simulation.histogram as number[]).map(v => v * 100).sort((a, b) => a - b)
        const benchVol = benchResult?.metrics?.ann_volatility ?? 15
        const benchDrift = benchResult?.metrics
          ? (() => {
              const years = Math.max(new Date().getFullYear() - 2020, 1)
              return (Math.pow(1 + benchResult.metrics.total_return / 100, 1 / years) - 1) * 100
            })()
          : 8
        const benchPaths = runGBM(100, benchDrift / 100, benchVol / 100, horizon, 100)
        const bands = Array.from({ length: horizon + 1 }, (_, day) => ({
          day,
          ...pathPercentiles(sampledPaths, day),
          bench_p50: pathPercentiles(benchPaths, day).p50,
        }))
        const min = terminal[0], max = terminal[terminal.length - 1]
        const step = Math.max((max - min) / 50, 1)
        const histogram = Array.from({ length: 50 }, (_, i) => {
          const lo = min + i * step, hi = lo + step
          return { price: +lo.toFixed(0), count: terminal.filter(v => v >= lo && (i === 49 ? v <= hi : v < hi)).length }
        })
        const p5 = terminal[Math.floor(terminal.length * 0.05)]
        const cvarSlice = terminal.slice(0, Math.max(1, Math.floor(terminal.length * 0.05)))
        const target = targetPrice > 0 ? targetPrice : null
        return {
          bands, histogram, S0: 100,
          median: terminal[Math.floor(terminal.length * 0.5)], p5,
          p95: terminal[Math.floor(terminal.length * 0.95)],
          probProfit: terminal.filter(v => v > 100).length / terminal.length * 100,
          probRuin: simulation.pct_wiped,
          varAmt: 100 - p5,
          cvarAmt: 100 - cvarSlice.reduce((sum, value) => sum + value, 0) / cvarSlice.length,
          effDrift: simulation.mu * 100,
          probTarget: target === null ? null : terminal.filter(v => v >= target).length / terminal.length * 100,
          targetPrice, model: 'gbm', benchmark, legs: [],
          crsp_mode: true,
          constituent_count: simulation.constituent_count,
          delistings: simulation.delistings ?? [],
        }
      }
      const totalWeight = legs.reduce((s, l) => s + l.weight, 0) || 100

      // Fire strategy signals + benchmark fetch in parallel
      const [legAdjs, benchResult] = await Promise.all([
        Promise.all(
          legs.map(async (leg) => {
            if (leg.strategy === STRATEGIES[0]) return { stratAdj: 0, stratLabel: '', stratDetail: '', stratChartData: [], stratBuyCount: 0, stratSellCount: 0 }
            try {
              const today = new Date().toISOString().split('T')[0]
              const isCustom = leg.strategy === CUSTOM_STRATEGY_KEY
              const customDef = isCustom && leg.stratParams._custom_def
                ? JSON.parse(leg.stratParams._custom_def)
                : null
              if (isCustom && !customDef) return { stratAdj: 0, stratLabel: 'Custom — no rules', stratDetail: '', stratChartData: [], stratBuyCount: 0, stratSellCount: 0 }
              const [sigResp, priceResp] = await Promise.all([
                isCustom
                  ? axios.post('/api/strategy/custom-signal', {
                      ticker: leg.ticker, start: '2022-01-01', end: today,
                      rules: rulesForTicker(customDef, leg.ticker), bull_drift: customDef.bull_drift ?? 5, bear_drift: customDef.bear_drift ?? -3,
                    })
                  : axios.post('/api/strategy/signal', {
                      ticker: leg.ticker, strategy: leg.strategy,
                      start: '2022-01-01', end: today,
                      params: leg.stratParams,
                    }),
                axios.get(`/api/market/history?ticker=${leg.ticker}&start=2022-01-01`),
              ])
              const signalArr: {date: string; value: number}[] = sigResp.data.signal ?? []
              const priceArr:  {date: string; value: number}[] = priceResp.data?.price ?? []
              const sigMap: Record<string, number> = {}
              signalArr.forEach(s => { sigMap[s.date] = s.value })
              let prevSig: number | null = null
              let buyCount = 0, sellCount = 0
              const chartData = priceArr.map(p => {
                const sig = sigMap[p.date]
                let action: 'buy' | 'sell' | null = null
                if (sig !== undefined && prevSig !== null) {
                  if (sig === 1 && prevSig === 0) { action = 'buy'; buyCount++ }
                  else if (sig === 0 && prevSig === 1) { action = 'sell'; sellCount++ }
                }
                if (sig !== undefined) prevSig = sig
                return { date: p.date, price: p.value, action }
              })
              return {
                stratAdj: sigResp.data.drift_adj ?? 0,
                stratLabel: sigResp.data.label ?? '',
                stratDetail: sigResp.data.detail ?? '',
                stratChartData: chartData,
                stratBuyCount: buyCount,
                stratSellCount: sellCount,
              }
            } catch { return { stratAdj: 0, stratLabel: '', stratDetail: '', stratChartData: [], stratBuyCount: 0, stratSellCount: 0 } }
          })
        ),
        axios.get(`/api/market/history?ticker=${benchmark}&start=2020-01-01`)
          .then(r => r.data)
          .catch(() => null),
      ])

      const benchVol   = benchResult?.metrics?.ann_volatility ?? 15
      const benchDrift = benchResult?.metrics
        ? (() => {
            const years = Math.max(new Date().getFullYear() - 2020, 1)
            const cagr  = (Math.pow(1 + benchResult.metrics.total_return / 100, 1 / years) - 1) * 100
            return Math.max(-150, Math.min(150, cagr))
          })()
        : 8

      const n = Math.min(nSims, 500)

      // Fetch + date-align leg histories whenever legs need linkage: always for
      // bootstrap, and for GBM / Student-t whenever there are >=2 real legs to
      // correlate. Aligning on COMMON trading dates lets a resampled block (or an
      // estimated correlation) reflect the legs actually moving together.
      const nonCashCount = legs.filter(l => l.ticker !== CASH_SYMBOL).length
      const alignedIdx: number[] = []        // leg indices that have usable aligned history
      const aligned: number[][] = []
      if (model === 'bootstrap' || nonCashCount >= 2) {
        const series = await Promise.all(legs.map(async (leg) => {
          if (leg.ticker === CASH_SYMBOL) return null
          try {
            const { data } = await axios.get(`/api/market/history?ticker=${leg.ticker}&start=2022-01-01`)
            return ((data?.price ?? []) as { date: string; value: number }[]).filter(p => p.value > 0)
          } catch { return null }
        }))
        let common: Set<string> | null = null
        for (const pts of series) {
          if (!pts || pts.length === 0) continue
          const ds = new Set<string>(pts.map(p => p.date))
          if (common === null) { common = ds; continue }
          const prev: Set<string> = common
          common = new Set<string>([...prev].filter(d => ds.has(d)))
        }
        const commonDates: string[] = common ? [...common].sort() : []
        if (commonDates.length > BLOCK_SIZE + 1) {
          series.forEach((pts, i) => {
            if (!pts) return
            const byDate: Record<string, number> = {}
            pts.forEach(p => { byDate[p.date] = p.value })
            const px = commonDates.map(d => byDate[d])
            const rets: number[] = []
            for (let k = 1; k < px.length; k++) rets.push(Math.log(px[k] / px[k - 1]))
            alignedIdx.push(i)
            aligned.push(rets)
          })
        }
      }

      // Linked simulation for the legs that have aligned history. Bootstrap shares
      // block indices; GBM / Student-t draw shocks correlated by the empirical
      // correlation matrix (Cholesky) so macro moves hit correlated legs together.
      const allPaths: number[][][] = new Array(legs.length)
      if (model === 'bootstrap' && aligned.length) {
        const targetMeans = alignedIdx.map((i, p) => {
          const mu = (legs[i].drift + legAdjs[i].stratAdj) / 100
          const em = aligned[p].reduce((a, b) => a + b, 0) / aligned[p].length
          const ev = aligned[p].reduce((a, x) => a + (x - em) * (x - em), 0) / aligned[p].length
          return mu / 252 - 0.5 * ev   // = (mu - 0.5 σ²) dt with empirical σ
        })
        const sharedPaths = runBootstrapShared(aligned, targetMeans, horizon, n, BLOCK_SIZE)
        alignedIdx.forEach((i, p) => { allPaths[i] = sharedPaths[p] })
      } else if (model !== 'bootstrap' && aligned.length >= 2) {
        const mus    = alignedIdx.map(i => (legs[i].drift + legAdjs[i].stratAdj) / 100)
        const sigmas = alignedIdx.map(i => legs[i].vol / 100)
        const chol   = cholesky(correlationMatrix(aligned))
        const corrPaths = runDiffusionCorrelated(mus, sigmas, chol, horizon, n, model === 't')
        alignedIdx.forEach((i, p) => { allPaths[i] = corrPaths[p] })
      }

      // Remaining legs (cash, a failed fetch, or single-leg runs with no linkage)
      // simulate independently. A bootstrap leg with no history falls back to GBM.
      legs.forEach((leg, i) => {
        if (allPaths[i]) return
        const mu    = (leg.drift + legAdjs[i].stratAdj) / 100
        const sigma = leg.vol / 100
        if (model === 't') allPaths[i] = runDiffusion(1.0, mu, sigma, horizon, n, () => tRandom(T_DF))
        else allPaths[i] = runGBM(1.0, mu, sigma, horizon, n)
      })

      // Combine into portfolio paths (start 1.0). Holdings drift with each leg's
      // simulated growth and reset to target weights every `rebalStep` trading
      // days; 0 = never (buy & hold), 1 = constant weights.
      const rebalStep = { none: 0, daily: 1, weekly: 5, monthly: 21, quarterly: 63, annually: 252 }[rebalance]
      const targetW = legs.map(l => l.weight / totalWeight)
      const rawPortfolioPaths = Array.from({ length: Math.min(nSims, 500) }, (_, simIdx) => {
        const h = [...targetW]
        const path = [1.0]
        for (let day = 1; day <= horizon; day++) {
          let v = 0
          for (let li = 0; li < legs.length; li++) {
            h[li] *= allPaths[li][simIdx][day] / (allPaths[li][simIdx][day - 1] || 1e-12)
            v += h[li]
          }
          path.push(v)
          if (rebalStep && day % rebalStep === 0) for (let li = 0; li < legs.length; li++) h[li] = targetW[li] * v
        }
        return path
      })
      // Apply borrow-to-magnify leverage to the gross portfolio paths (static debt, floored
      // at 0 on wipeout), then risk controls, then scale to $100.
      const L = Math.max(1, Number(leverage) || 1)
      const bDaily = Math.pow(1 + (Math.max(0, Number(borrowRate) || 0)) / 100, 1 / 252)
      const leveredPaths = L === 1 ? rawPortfolioPaths : rawPortfolioPaths.map(path => {
        let wiped = false
        return path.map((g, day) => {
          if (wiped) return 0
          const eq = L * g - (L - 1) * Math.pow(bDaily, day)
          if (eq <= 0) { wiped = true; return 0 }
          return eq
        })
      })
      const portfolioPaths = applyRiskControls(leveredPaths).map(p => p.map(v => v * 100))

      const benchPaths = runGBM(100, benchDrift / 100, benchVol / 100, horizon, 100)

      // Percentile bands
      const bands = Array.from({ length: horizon + 1 }, (_, day) => ({
        day,
        ...pathPercentiles(portfolioPaths, day),
        bench_p50: pathPercentiles(benchPaths, day).p50,
      }))

      // Terminal stats
      const terminal = portfolioPaths.map(p => p[horizon]).sort((a, b) => a - b)
      const S0 = 100
      const p5      = terminal[Math.floor(terminal.length * 0.05)]
      const p95     = terminal[Math.floor(terminal.length * 0.95)]
      const median  = terminal[Math.floor(terminal.length * 0.50)]
      const probProfit = terminal.filter(v => v > S0).length / terminal.length * 100
      const probRuin   = terminal.filter(v => v <= 0).length / terminal.length * 100  // paths wiped to $0
      const varAmt  = S0 - p5
      const cvarSlice = terminal.slice(0, Math.floor(terminal.length * 0.05))
      const cvarAmt = S0 - cvarSlice.reduce((s, v) => s + v, 0) / (cvarSlice.length || 1)

      const min = terminal[0], max = terminal[terminal.length - 1]
      const step = (max - min) / 50
      const histogram = Array.from({ length: 50 }, (_, i) => {
        const lo = min + i * step, hi = lo + step
        return { price: +(lo).toFixed(0), count: terminal.filter(v => v >= lo && v < hi).length }
      })

      const effDrift = legs.reduce((s, l, i) =>
        s + (l.weight / totalWeight) * (l.drift + legAdjs[i].stratAdj), 0)

      const probTarget = targetPrice > 0
        ? terminal.filter(v => v >= targetPrice).length / terminal.length * 100
        : null

      return {
        bands, histogram, S0, median, p5, p95, probProfit, probRuin, varAmt, cvarAmt, effDrift,
        probTarget, targetPrice, model,
        bootstrapReady: model !== 'bootstrap' || legs.every((l, i) => l.ticker === CASH_SYMBOL || alignedIdx.includes(i)),
        benchmark, legs: legs.map((l, i) => ({ ...l, ...legAdjs[i] })),
        crsp_mode: false,
      }
    },
  })

  if (mcMode === 'options-strategy') {
    return <OptionsStrategyMonteCarlo onSwitchMode={() => setMcMode('portfolio')} handoff={algoOptionsHandoff} />
  }

  return (
    <>
      <MCModeToggle mode={mcMode} onChange={setMcMode} />
      {algoHandoff && (
        <div style={{ marginTop: 10, padding: '8px 10px', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)', color: 'var(--theme-text, #d7e3fc)', fontSize: 10, fontFamily: 'var(--theme-mono)', lineHeight: 1.5 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>Imported algo universe · {algoHandoff.positions.length} symbols · {algoHandoff.tradeSizePct}% per admitted trade · {algoHandoff.strategy.name}.</span>
            <button onClick={() => runExactReplay()} disabled={exactReplayPending} style={{ ...INPUT, width: 'auto', padding: '4px 8px', cursor: exactReplayPending ? 'default' : 'pointer', color: 'var(--theme-primary, #c9a84c)', borderColor: 'var(--theme-primary, #c9a84c)', opacity: exactReplayPending ? 0.6 : 1 }}>
              {exactReplayPending ? 'Replaying…' : 'Run Exact Algo Replay'}
            </button>
          </div>
          <div style={{ marginTop: 4, color: 'var(--theme-secondary, #8099b0)' }}>The normal Monte Carlo view remains a correlated equal-weight proxy. Exact Replay uses the same universe event queue, risk exits, and modeled option/combo P&amp;L engine as the Algorithmic Strategy Builder.</div>
        </div>
      )}
      {exactReplay && (
        <div style={{ ...STRIP, marginTop: 10 }}>
          <KpiCell grow label="Exact Replay Return" value={`${exactReplay.metrics.total_return >= 0 ? '+' : ''}${exactReplay.metrics.total_return.toFixed(2)}%`} color={exactReplay.metrics.total_return >= 0 ? POS : NEG} />
          <KpiCell grow label="P&L" value={`${exactReplay.metrics.total_pnl >= 0 ? '+' : ''}$${exactReplay.metrics.total_pnl.toFixed(2)}`} color={exactReplay.metrics.total_pnl >= 0 ? POS : NEG} />
          <KpiCell grow label="Trades" value={String(exactReplay.metrics.num_trades)} />
          <KpiCell grow label="Sharpe" value={exactReplay.metrics.sharpe.toFixed(3)} />
          <KpiCell grow label="Max Drawdown" value={`${exactReplay.metrics.max_drawdown.toFixed(2)}%`} color={NEG} />
        </div>
      )}
      {exactReplayError && <div style={{ marginTop: 8, color: NEG, fontSize: 10, fontFamily: 'var(--theme-mono)' }}>Exact replay failed. Check the imported symbols, rules, and market-data availability.</div>}
      <ConfigHeader
        mode="montecarlo"
        collapsed={collapsed}
        onToggleCollapse={() => setCollapsed(c => !c)}
        holdings={legs}
        onHoldingsChange={next => setLegs(next.map((h, i) => {
          // Equal length means an in-place edit (add/remove change the length). A
          // ticker change there invalidates the fetched spot/vol/drift, so rebuild
          // that leg from defaults and keep only its weight/strategy.
          const prev = legs[i]
          if (next.length === legs.length && prev && prev.ticker !== h.ticker) {
            return { ...makeLeg(h.ticker, h.weight), strategy: h.strategy, stratParams: h.stratParams }
          }
          return { ...makeLeg(h.ticker, h.weight), ...h } as Leg
        }))}
        crspMode={crspMode} onCrspModeChange={setCrspMode}
        benchmark={benchmark} setBenchmark={setBenchmark}
        leverage={leverage} setLeverage={setLeverage}
        borrowRate={borrowRate} setBorrowRate={setBorrowRate}
        sl={{ val: slPct, set: setSlPct }}
        tp={{ val: tpPct, set: setTpPct }}
        trail={{ val: trailPct, set: setTrailPct }}
        pos={{ val: posPct, set: setPosPct }}
        cash={{ val: cashYield, set: setCashYield }}
        start={crspStart} setStart={setCrspStart}
        end={crspEnd} setEnd={setCrspEnd}
        horizon={horizon} setHorizon={setHorizon}
        nSims={nSims} setNSims={setNSims}
        targetPrice={targetPrice} setTargetPrice={setTargetPrice}
        onRun={() => mutate()}
        isRunning={isPending}
        tickerListId="mc-futures"
        tickerList={<datalist id="mc-futures">{FUTURES.map(f => <option key={f.sym} value={f.sym}>{f.label}</option>)}</datalist>}
        paramExtra={
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Simulation Model">
              <select value={crspMode ? 'gbm' : model} disabled={crspMode} onChange={e => setModel(e.target.value as SimModel)}
                style={{ ...paramInput, cursor: crspMode ? 'not-allowed' : 'pointer', opacity: crspMode ? 0.65 : 1 }}>
                {(Object.keys(MODEL_LABELS) as SimModel[]).map(m => (
                  <option key={m} value={m}>{MODEL_LABELS[m]}</option>
                ))}
              </select>
            </Field>
            <RebalanceSelect value={rebalance} onChange={setRebalance} />
          </div>
        }
        overflow={
          <>
            <button onClick={fetchAll} disabled={fetching}
              style={{ ...INPUT, cursor: fetching ? 'default' : 'pointer', textAlign: 'left', opacity: fetching ? 0.6 : 1 }}>
              {fetching ? 'Fetching…' : 'Fetch Live Vol / Drift'}
            </button>
            <UniversePicker
              mode="weighted"
              style={{ ...INPUT, cursor: 'pointer' }}
              onImportWeighted={(r) => {
                const newLegs: Leg[] = r.legs.map(l => makeLeg(l.ticker, l.weight))
                if (r.cashWeight > 0) newLegs.push({ ...makeLeg(CASH_SYMBOL, r.cashWeight), vol: 0, drift: parseFloat(cashYield) || 4.5, fetched: true })
                if (newLegs.length === 0) return
                setHoldings(newLegs.map(l => ({ ticker: l.ticker, weight: l.weight })))
                setLegs(newLegs)
              }}
            />
            <PortfolioIO
              mode="portfolio"
              assets={legs.map(l => ({ ticker: l.ticker, weight: l.weight, strategy: l.strategy, stratParams: l.stratParams as Record<string, unknown> }))}
              onImportAssets={(imported: PortfolioAsset[]) => {
                const newLegs = imported.map(a => ({
                  ...makeLeg(a.ticker, a.weight),
                  strategy: a.strategy ?? STRATEGIES[0],
                  stratParams: (a.stratParams ?? {}) as StrategyParams,
                }))
                setHoldings(newLegs.map(l => ({ ticker: l.ticker, weight: l.weight, strategy: l.strategy })))
                setLegs(newLegs)
              }}
              name="montecarlo"
            />
          </>
        }
      />
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>

          {!data && !isPending && (
            <EmptyState title="Monte Carlo Simulator" hint="Add legs, set parameters, then press Run Simulation."
              keys={['Enter']} action="Run Simulation" />
          )}

          {data && (
            <>
              {data.crsp_mode && (
                <div style={{
                  background: 'var(--theme-bg, #101c2e)',
                  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
                  borderLeft: '4px solid var(--theme-primary, #c9a84c)',
                  padding: '8px 14px', fontFamily: 'var(--theme-mono)', fontSize: 11, lineHeight: 1.5,
                }}>
                  <span style={{ color: 'var(--theme-primary, #c9a84c)', fontWeight: 700 }}>SURVIVORSHIP-BIAS-FREE (CRSP)</span>
                  <span style={{ color: 'var(--theme-secondary, #99907e)', marginLeft: 8 }}>
                    GBM calibration uses {data.constituent_count} S&amp;P 500 constituents as of {crspStart}
                    {data.delistings?.length > 0 && `, including ${data.delistings.length} delisted/acquired names carried through the return history`}.
                  </span>
                </div>
              )}
              {/* Portfolio composition */}
              {!data.crsp_mode && <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '8px 12px', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {data.legs.map((l: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, color: 'var(--theme-text, #d7e3fc)' }}>{l.ticker}</span>
                    <span style={{ fontSize: 10, color: 'var(--theme-primary, #c9a84c)' }}>{l.weight}%</span>
                    {l.fetched && (
                      <span style={{ fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', letterSpacing: '0.06em' }}>
                        ${l.spot.toLocaleString()} · σ {l.vol}%
                      </span>
                    )}
                    {l.strategy !== STRATEGIES[0] && (
                      <span style={{ fontSize: 9, color: l.stratAdj >= 0 ? 'var(--theme-positive)' : 'var(--theme-negative)', letterSpacing: '0.06em' }}>
                        [{l.strategy.split(' ')[0]}]
                      </span>
                    )}
                  </div>
                ))}
                <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {!data.bootstrapReady && (
                    <span style={{ fontSize: 9, color: 'var(--theme-negative)', letterSpacing: '0.04em' }}>
                      no history — using GBM, run Fetch Live Vol / Drift
                    </span>
                  )}
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>
                    {MODEL_LABELS[data.model as SimModel]}
                  </span>
                </span>
              </div>}

              {/* Answer-first outcome strip */}
              <div style={STRIP}>
                <KpiCell grow minWidth={150} label="Median Final" value={`$${data.median.toFixed(2)}`} valueSize={16}
                  color={data.median > data.S0 ? POS : NEG}
                  sub={`${data.median > data.S0 ? '+' : ''}${((data.median / data.S0 - 1) * 100).toFixed(1)}% vs start`} subColor={data.median > data.S0 ? POS : NEG} />
                <KpiCell grow label="Prob of Profit" value={`${data.probProfit.toFixed(1)}%`} color={data.probProfit > 50 ? POS : NEG} />
                <KpiCell grow label="P5 Outcome" value={`$${data.p5.toFixed(2)}`} />
                <KpiCell grow label="P95 Outcome" value={`$${data.p95.toFixed(2)}`} />
                <KpiCell grow label="VaR 95%" value={`$${data.varAmt.toFixed(2)}`} color={NEG} />
                <KpiCell grow label="CVaR 95%" value={`$${data.cvarAmt.toFixed(2)}`} color={NEG} />
                <KpiCell grow label="Eff. Drift" value={`${data.effDrift.toFixed(1)}%`} />
                {data.probTarget !== null && <KpiCell grow label={`Prob ≥ $${data.targetPrice}`} value={`${data.probTarget.toFixed(1)}%`} color={data.probTarget > 50 ? POS : undefined} />}
                {data.probRuin > 0 && <KpiCell grow label="Prob of Ruin" value={`${data.probRuin.toFixed(1)}%`} color={NEG} sub="wiped to $0" subColor={NEG} />}
              </div>

              <ChartPanel label={`Simulated Portfolio Paths vs ${data.benchmark}`} height={328}>
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={data.bands}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="day" tick={TICK} tickFormatter={d => `D${d}`} interval="preserveStartEnd" />
                    <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} domain={['auto', 'auto']} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} formatter={(v: number) => [`$${v.toFixed(2)}`]} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Area type="monotone" dataKey="p95" stroke={cc.gain} strokeWidth={1.5} fill="transparent" name="P95" />
                    <Area type="monotone" dataKey="p75" stroke="rgba(47,107,75,0.4)" strokeWidth={1} fill="rgba(31,86,115,0.1)" name="P75" />
                    <Area type="monotone" dataKey="p50" stroke={cc.c2} strokeWidth={2.5} fill="transparent" strokeDasharray="4 2" name="Median" />
                    <Area type="monotone" dataKey="bench_p50" stroke={cc.primary} strokeWidth={1.5} fill="transparent" strokeDasharray="3 5" name={data.benchmark} />
                    <Area type="monotone" dataKey="p25" stroke="rgba(140,46,54,0.4)" strokeWidth={1} fill="transparent" name="P25" />
                    <Area type="monotone" dataKey="p5" stroke={cc.loss} strokeWidth={1.5} fill="transparent" name="P5" />
                    {data.targetPrice > 0 && (
                      <ReferenceLine y={data.targetPrice} stroke="var(--theme-primary, #c9a84c)" strokeDasharray="5 3"
                        label={{ value: `Target $${data.targetPrice}`, fill: 'var(--theme-primary, #c9a84c)', fontSize: 9, position: 'insideTopLeft' }} />
                    )}
                  </AreaChart>
                </ResponsiveContainer>
              </ChartPanel>

              <ChartPanel label="Terminal Portfolio Distribution ($100 start)" height={208}>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.histogram}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="price" tick={TICK} interval="preserveStartEnd" tickFormatter={v => `$${v}`} />
                    <YAxis tick={TICK} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={BAR_CURSOR} />
                    <ReferenceLine x={String(Math.round(data.S0))} stroke="var(--theme-primary, #c9a84c)" strokeDasharray="4 4"
                      label={{ value: 'Entry', fill: 'var(--theme-primary, #c9a84c)', fontSize: 9 }} />
                    <ReferenceLine x={String(Math.round(data.median))} stroke="var(--theme-tertiary, #1f5673)" strokeDasharray="4 4"
                      label={{ value: 'Median', fill: 'var(--theme-tertiary, #1f5673)', fontSize: 9 }} />
                    {data.targetPrice > 0 && (
                      <ReferenceLine x={String(Math.round(data.targetPrice))} stroke="var(--theme-primary, #c9a84c)" strokeDasharray="4 4"
                        label={{ value: 'Target', fill: 'var(--theme-primary, #c9a84c)', fontSize: 9 }} />
                    )}
                    <Bar dataKey="count" fill={cc.c2Muted} opacity={0.8} name="Frequency" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartPanel>

              {/* Active strategy signals */}
              {data.legs.some((l: any) => l.strategy !== STRATEGIES[0] && l.stratLabel) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {data.legs.filter((l: any) => l.strategy !== STRATEGIES[0] && l.stratLabel).map((l: any, i: number) => (
                    <div key={i} style={{
                      background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
                      borderLeft: `4px solid ${l.stratAdj >= 0 ? 'var(--theme-positive)' : 'var(--theme-negative)'}`,
                      padding: '8px 14px',
                    }}>
                      <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, color: l.stratAdj >= 0 ? 'var(--theme-positive)' : 'var(--theme-negative)', marginBottom: 3 }}>
                        {l.ticker} · {l.strategy} · {l.stratLabel}
                        <span style={{ marginLeft: 10, fontSize: 10, color: 'var(--theme-secondary, #99907e)', fontWeight: 400 }}>
                          Drift adj: {l.stratAdj > 0 ? '+' : ''}{l.stratAdj}% · Eff. drift: {+(l.drift + l.stratAdj).toFixed(1)}%/yr
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)' }}>{l.stratDetail}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Buy/Sell signal chart: price line with up/down BUY/SELL markers */}
              {data.legs.some((l: any) => l.strategy !== STRATEGIES[0] && l.stratChartData?.length > 0) && (
                <>
                  {data.legs
                    .filter((l: any) => l.strategy !== STRATEGIES[0] && l.stratChartData?.length > 0)
                    .map((l: any, idx: number) => {
                      const renderDot = (dotProps: any) => {
                        const { cx, cy, payload, index } = dotProps
                        if (payload.action === 'buy')
                          return <polygon key={`b${index}`} points={`${cx},${cy - 9} ${cx - 6},${cy + 4} ${cx + 6},${cy + 4}`} style={{ fill: 'var(--theme-positive)' }} stroke="none" />
                        if (payload.action === 'sell')
                          return <polygon key={`s${index}`} points={`${cx},${cy + 9} ${cx - 6},${cy - 4} ${cx + 6},${cy - 4}`} style={{ fill: 'var(--theme-negative)' }} stroke="none" />
                        return <g key={`n${index}`} />
                      }
                      const header = (
                        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          <span style={{ color: 'var(--theme-text, #d7e3fc)' }}>{l.ticker}</span>
                          <span style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.3))' }}>·</span>
                          <span style={{ color: 'var(--theme-positive)' }}>↑ {l.stratBuyCount} BUY</span>
                          <span style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.3))' }}>·</span>
                          <span style={{ color: 'var(--theme-negative)' }}>↓ {l.stratSellCount} SELL</span>
                          <span style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.3))', fontWeight: 400 }}>· {l.strategy}</span>
                        </span>
                      )
                      return (
                        <ChartPanel key={idx} label={header} height={248}>
                          <ResponsiveContainer width="100%" height={212}>
                            <LineChart data={l.stratChartData} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                              <XAxis dataKey="date" tick={TICK} tickFormatter={(d: string) => d.slice(0, 7)} interval="preserveStartEnd" />
                              <YAxis tick={TICK} tickFormatter={(v: number) => `$${v.toFixed(0)}`} orientation="right" />
                              <Tooltip contentStyle={TOOLTIP_STYLE}
                                formatter={(v: number, _: string, p: any) => [
                                  `$${v.toFixed(2)}${p.payload.action === 'buy' ? '  ↑ BUY' : p.payload.action === 'sell' ? '  ↓ SELL' : ''}`,
                                  l.ticker,
                                ]}
                                labelFormatter={(d: string) => d}
                              />
                              <Line type="monotone" dataKey="price" stroke={cc.primary} strokeWidth={1.5} dot={renderDot} activeDot={{ r: 3, fill: cc.primary }} isAnimationActive={false} />
                            </LineChart>
                          </ResponsiveContainer>
                        </ChartPanel>
                      )
                    })}
                </>
              )}
            </>
          )}
      </div>
    </>
  )
}

export default function MonteCarlo() {
  return <PageWrapper title="Monte Carlo Simulator"><MonteCarloContent /></PageWrapper>
}
