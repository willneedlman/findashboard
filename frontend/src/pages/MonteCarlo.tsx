import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { KpiCell } from '../components/mmCockpit'
import { useChartColors } from '../hooks/useChartColors'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
const POS = 'var(--theme-positive)', NEG = 'var(--theme-negative)'
import StrategySelector, { STRATEGIES, CUSTOM_STRATEGY_KEY, type StrategyParams } from '../components/StrategySelector'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'
import { FUTURES } from '../lib/futures'
import axios from 'axios'
import EmptyState from '../components/EmptyState'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'
import PMImportPicker from '../components/PMImportPicker'
import { CASH_SYMBOL } from '../lib/pmImport'
import ConfigHeader, { Field, paramInput } from '../components/portfolio/ConfigHeader'
import { usePortfolio, type PortfolioHolding } from '../contexts/PortfolioContext'
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

const makeLeg = (ticker: string, weight: number): Leg => ({
  ticker, weight, spot: 100, vol: 20, drift: 8,
  strategy: STRATEGIES[0], stratParams: {}, fetched: false,
})

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

// ── Component ────────────────────────────────────────────────────────────────

export function MonteCarloContent() {
  const cc = useChartColors()
  const { holdings, setHoldings } = usePortfolio()
  const [legs, setLegs] = useState<Leg[]>(() => {
    if (holdings && holdings.length > 0) {
      return holdings.map(h => ({
        ...makeLeg(h.ticker, h.weight),
        strategy: h.strategy ?? STRATEGIES[0],
        stratParams: ((h as unknown as Record<string, unknown>).stratParams ?? {}) as StrategyParams,
      }))
    }
    return [makeLeg('SPY', 100)]
  })
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
                      rules: customDef, bull_drift: customDef.bull_drift ?? 5, bear_drift: customDef.bear_drift ?? -3,
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

      // Combine into weighted portfolio paths (normalized to start at 1.0)
      const rawPortfolioPaths = Array.from({ length: Math.min(nSims, 500) }, (_, simIdx) =>
        Array.from({ length: horizon + 1 }, (_, day) =>
          legs.reduce((sum, leg, li) =>
            sum + (leg.weight / totalWeight) * allPaths[li][simIdx][day], 0)
        )
      )
      // Apply borrow-to-magnify leverage to the gross portfolio paths (static debt, floored
      // at 0 on wipeout), then risk controls, then scale to $100.
      const L = Number(leverage) || 1
      const bDaily = Math.pow(1 + (Number(borrowRate) || 0) / 100, 1 / 252)
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
      }
    },
  })

  return (
    <>
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
        benchmark={benchmark} setBenchmark={setBenchmark}
        leverage={leverage} setLeverage={setLeverage}
        borrowRate={borrowRate} setBorrowRate={setBorrowRate}
        sl={{ val: slPct, set: setSlPct }}
        tp={{ val: tpPct, set: setTpPct }}
        trail={{ val: trailPct, set: setTrailPct }}
        pos={{ val: posPct, set: setPosPct }}
        cash={{ val: cashYield, set: setCashYield }}
        horizon={horizon} setHorizon={setHorizon}
        nSims={nSims} setNSims={setNSims}
        targetPrice={targetPrice} setTargetPrice={setTargetPrice}
        onRun={() => mutate()}
        isRunning={isPending}
        tickerListId="mc-futures"
        tickerList={<datalist id="mc-futures">{FUTURES.map(f => <option key={f.sym} value={f.sym}>{f.label}</option>)}</datalist>}
        paramExtra={
          <Field label="Simulation Model">
            <select value={model} onChange={e => setModel(e.target.value as SimModel)}
              style={{ ...paramInput, cursor: 'pointer' }}>
              {(Object.keys(MODEL_LABELS) as SimModel[]).map(m => (
                <option key={m} value={m}>{MODEL_LABELS[m]}</option>
              ))}
            </select>
          </Field>
        }
        overflow={
          <>
            <button onClick={fetchAll} disabled={fetching}
              style={{ ...INPUT, cursor: fetching ? 'default' : 'pointer', textAlign: 'left', opacity: fetching ? 0.6 : 1 }}>
              {fetching ? 'Fetching…' : 'Fetch Live Vol / Drift'}
            </button>
            <PMImportPicker
              style={{ ...INPUT, cursor: 'pointer' }}
              onImport={(r) => {
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
            <EmptyState title="Monte Carlo Simulator" hint="Add legs, set parameters, then press Run Simulation." />
          )}

          {data && (
            <>
              {/* Portfolio composition */}
              <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '8px 12px', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
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
              </div>

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
