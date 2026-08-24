import { useState } from 'react'
import { todayLocal } from '../lib/time'
import { useMutation } from '@tanstack/react-query'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceLine, Legend, Cell,
} from 'recharts'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import HelpTip from '../components/HelpTip'
import { KpiCell } from '../components/mmCockpit'
import { useChartColors } from '../hooks/useChartColors'
import axios from 'axios'

// ── Styles ────────────────────────────────────────────────────────────────────

import { INPUT, Select, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'

// ── Math helpers ──────────────────────────────────────────────────────────────

function rand(state: { seed: number }): number {
  state.seed = (state.seed * 1664525 + 1013904223) & 0xffffffff
  const u1 = ((state.seed >>> 0) / 0x100000000)
  state.seed = (state.seed * 1664525 + 1013904223) & 0xffffffff
  const u2 = ((state.seed >>> 0) / 0x100000000)
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2)
}

function Phi(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422820 * Math.exp(-x * x / 2)
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const cdf = 1 - d * poly
  return x >= 0 ? cdf : 1 - cdf
}

function bsDelta(S: number, K: number, T: number, r: number, sigma: number, isCall: boolean): number {
  if (T <= 0) return isCall ? (S > K ? 1 : 0) : (S < K ? -1 : 0)
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T))
  return isCall ? Phi(d1) : Phi(d1) - 1
}

function bsGamma(S: number, K: number, T: number, r: number, sigma: number): number {
  if (T <= 0) return 0
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T))
  return (0.3989422820 * Math.exp(-d1 * d1 / 2)) / (S * sigma * Math.sqrt(T))
}

function bsPrice(S: number, K: number, T: number, r: number, sigma: number, isCall: boolean): number {
  if (T <= 0) return Math.max(0, isCall ? S - K : K - S)
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T))
  const d2 = d1 - sigma * Math.sqrt(T)
  return isCall
    ? S * Phi(d1) - K * Math.exp(-r * T) * Phi(d2)
    : K * Math.exp(-r * T) * Phi(-d2) - S * Phi(-d1)
}

// ── Simulation ────────────────────────────────────────────────────────────────

type SimParams = {
  spot: number
  strike: number
  dte: number
  iv: number
  rv: number
  hedgeFreq: 'Hourly' | '4x Daily' | 'Twice Daily' | 'Daily' | 'Weekly'
  position: 'Long Gamma' | 'Short Gamma'
  nSims: number
}

type SimResult = {
  terminalPnls: number[]
  // 5 sample paths: array of {day, pnl} per path
  samplePaths: { day: number; pnl: number }[][]
  // avg cumulative hedge PnL per day
  avgHedgePnl: { day: number; hedgePnl: number; thetaCost: number }[]
  premium: number
  thetaBleedPerDay: number
  avgPnl: number
  probProfit: number
  breakevenRv: number
}

function runSimulation(params: SimParams): SimResult {
  const state = { seed: 42 }

  const { spot: S0, strike: K, dte, iv, rv, hedgeFreq, position, nSims } = params
  const sigma_iv = iv / 100
  const sigma_rv = rv / 100
  const r = 0
  const T0 = dte / 365

  const stepsPerDay =
    hedgeFreq === 'Hourly'      ? 6.5 :
    hedgeFreq === '4x Daily'    ? 4   :
    hedgeFreq === 'Twice Daily' ? 2   :
    hedgeFreq === 'Weekly'      ? 0.2 : 1
  const totalSteps = Math.max(1, Math.round(dte * stepsPerDay))
  const dt = T0 / totalSteps

  const premium = bsPrice(S0, K, T0, r, sigma_iv, true) + bsPrice(S0, K, T0, r, sigma_iv, false)

  const thetaBleedPerDay =
    (bsPrice(S0, K, T0, r, sigma_iv, true) + bsPrice(S0, K, T0, r, sigma_iv, false)) -
    (bsPrice(S0, K, Math.max(T0 - 1 / 365, 1e-6), r, sigma_iv, true) +
      bsPrice(S0, K, Math.max(T0 - 1 / 365, 1e-6), r, sigma_iv, false))

  const terminalPnls: number[] = []
  const allPaths: number[][] = []
  // cumulative hedge pnl per step, accumulated across sims
  const cumHedgePnlSum: number[] = new Array(totalSteps + 1).fill(0)
  // Track realized gamma P&L separately: sum(0.5 * Gamma * dS²) — always positive, grows with RV
  const cumGammaPnlSum: number[] = new Array(totalSteps + 1).fill(0)


  for (let sim = 0; sim < nSims; sim++) {
    let S = S0
    let callDelta = bsDelta(S, K, T0, r, sigma_iv, true)
    let putDelta = bsDelta(S, K, T0, r, sigma_iv, false)
    let stradDelta = callDelta + putDelta

    let cumulativeHedgePnl = 0
    let cumulativeGammaPnl = 0
    const pathPnls: number[] = [0]

    for (let step = 1; step <= totalSteps; step++) {
      const T_prev = Math.max(T0 - (step - 1) * dt, 1e-8)
      const T_remain = Math.max(T0 - step * dt, 1e-8)
      const S_old = S
      S = S * Math.exp((r - 0.5 * sigma_rv * sigma_rv) * dt + sigma_rv * Math.sqrt(dt) * rand(state))

      const newCallDelta = bsDelta(S, K, T_remain, r, sigma_iv, true)
      const newPutDelta = bsDelta(S, K, T_remain, r, sigma_iv, false)
      const newStradDelta = newCallDelta + newPutDelta

      const dS = S - S_old
      // P&L from holding the short-delta stock hedge while price moved by dS.
      cumulativeHedgePnl += -stradDelta * dS

      // Realized gamma scalping P&L: 0.5 × Gamma × dS² (convexity gain, independent of direction)
      const gamma = bsGamma(S_old, K, T_prev, r, sigma_iv)
      cumulativeGammaPnl += 0.5 * gamma * dS * dS

      stradDelta = newStradDelta

      pathPnls.push(cumulativeHedgePnl)
      cumHedgePnlSum[step] += cumulativeHedgePnl
      cumGammaPnlSum[step] += cumulativeGammaPnl
    }

    const intrinsic = Math.abs(S - K)
    let termPnl = intrinsic - premium + cumulativeHedgePnl
    if (position === 'Short Gamma') termPnl = -termPnl

    terminalPnls.push(termPnl)
    allPaths.push(pathPnls)
  }

  // Sample 5 paths: worst, lower-middle (random), median, upper-middle (random), best
  const sortedByTerminal = [...Array(nSims).keys()].sort((a, b) => terminalPnls[a] - terminalPnls[b])
  const worstIdx  = sortedByTerminal[0]
  const bestIdx   = sortedByTerminal[nSims - 1]
  const medianIdx = sortedByTerminal[Math.floor(nSims / 2)]
  const lowerPool = sortedByTerminal.slice(Math.floor(nSims * 0.1), Math.floor(nSims * 0.4))
  const upperPool = sortedByTerminal.slice(Math.floor(nSims * 0.6), Math.floor(nSims * 0.9))
  const lowerMidIdx = lowerPool[Math.floor(lowerPool.length * 0.5)]
  const upperMidIdx = upperPool[Math.floor(upperPool.length * 0.5)]

  const samplePaths = [worstIdx, lowerMidIdx, medianIdx, upperMidIdx, bestIdx].map(pathIdx => {
    const raw = allPaths[pathIdx]
    return raw.map((pnl, day) => ({ day, pnl: position === 'Long Gamma' ? pnl : -pnl }))
  })

  // Average cumulative realized gamma P&L (0.5×Γ×dS²) per step, resampled to day granularity.
  // This is what the graph should show: convexity gains vs theta cost, both growing over time.
  const stepsPerDayActual = totalSteps / dte
  const avgHedgePnl: { day: number; hedgePnl: number; thetaCost: number }[] = []
  for (let d = 0; d <= dte; d++) {
    const step = Math.min(Math.round(d * stepsPerDayActual), totalSteps)
    const avgGamma = cumGammaPnlSum[step] / nSims
    const thetaAcc = -thetaBleedPerDay * d
    avgHedgePnl.push({
      day: d,
      hedgePnl: position === 'Long Gamma' ? avgGamma : -avgGamma,
      thetaCost: position === 'Long Gamma' ? thetaAcc : -thetaAcc,
    })
  }

  const avgPnl = terminalPnls.reduce((a, b) => a + b, 0) / nSims
  const probProfit = terminalPnls.filter(p => p > 0).length / nSims * 100

  // Breakeven RV: the point where avg_pnl ≈ 0
  // Approximate: premium is proportional to vol, so breakevenRv ≈ IV * (premium / (premium + avgPnl))
  // Better: binary search
  let lo = 0.01, hi = 3.0
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) / 2
    const testPremium = bsPrice(S0, K, T0, r, mid, true) + bsPrice(S0, K, T0, r, mid, false)
    // For long gamma, breakeven when RV = IV is approximately when realized gamma PnL = theta
    // Rough approximation: avgPnl ~ 0.5 * (rv^2 - iv^2) * gamma_avg * T * S^2
    const gamma0 = bsGamma(S0, K, T0, r, sigma_iv)
    const approxPnl = 0.5 * (mid * mid - sigma_iv * sigma_iv) * gamma0 * S0 * S0 * T0
    const signed = position === 'Long Gamma' ? approxPnl : -approxPnl
    if (signed > 0) hi = mid
    else lo = mid
  }
  const breakevenRv = (lo + hi) / 2 * 100

  return {
    terminalPnls,
    samplePaths,
    avgHedgePnl,
    premium,
    thetaBleedPerDay,
    avgPnl,
    probProfit,
    breakevenRv,
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ChartPanel({ label, height, note, children }: { label: string; height: number; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{
        display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        minHeight: 24, flexWrap: 'wrap',
      }}>
        <div style={{
          flex: 1, zIndex: 10,
          background: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 10%, var(--theme-bg, #101c2e))', padding: '3px 8px',
          fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {label}
        </div>
        {note && (
          <div style={{
            padding: '3px 8px', flexShrink: 0,
            fontSize: 10, color: 'var(--theme-text-dim, rgba(255,255,255,0.35))', letterSpacing: '0.06em', zIndex: 10,
            background: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 10%, var(--theme-bg, #101c2e))', borderLeft: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
            whiteSpace: 'nowrap',
          }}>
            {note}
          </div>
        )}
      </div>
      <div style={{ padding: '6px 8px 8px', height }}>
        {children}
      </div>
    </div>
  )
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, marginBottom: 2 }}>
      <div style={{ height: 1, flex: 1, background: 'var(--theme-border, var(--theme-border, rgba(255,255,255,0.07)))' }} />
      <span style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
        color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', whiteSpace: 'nowrap',
      }}>{label}</span>
      <div style={{ height: 1, flex: 1, background: 'var(--theme-border, var(--theme-border, rgba(255,255,255,0.07)))' }} />
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function GammaScalpingContent() {
  const cc = useChartColors()

  const [ticker, setTicker] = useState('SPY')
  const [paramsOpen, setParamsOpen] = useState(true)
  const [spot, setSpot] = useState(500)
  const [strike, setStrike] = useState(500)
  const [dte, setDte] = useState(30)
  const [iv, setIv] = useState(20)
  const [rv, setRv] = useState(20)
  const [hedgeFreq, setHedgeFreq] = useState<'Hourly' | '4x Daily' | 'Twice Daily' | 'Daily' | 'Weekly'>('Daily')
  const [position, setPosition] = useState<'Long Gamma' | 'Short Gamma'>('Long Gamma')
  const [nSims, setNSims] = useState(500)
  const [fetching, setFetching] = useState(false)
  const [fetchErr, setFetchErr] = useState('')

  const mutation = useMutation({
    mutationFn: async (params: SimParams) => {
      return runSimulation(params)
    },
  })

  const result = mutation.data

  async function fetchTickerData() {
    if (!ticker.trim()) return
    setFetching(true)
    setFetchErr('')
    try {
      const end = todayLocal()
      const res = await axios.get(`/api/market/history`, {
        params: { ticker: ticker.toUpperCase(), start: '2024-01-01', end },
      })
      const price = res.data?.metrics?.current_price
      const annVol = res.data?.metrics?.ann_volatility

      if (price && price > 0) {
        setSpot(parseFloat(price.toFixed(2)))
        setStrike(parseFloat(price.toFixed(2)))
      }
      if (annVol && annVol > 0) {
        setIv(parseFloat(annVol.toFixed(1)))
        setRv(parseFloat(annVol.toFixed(1)))
      }
    } catch {
      setFetchErr('Fetch failed')
    } finally {
      setFetching(false)
    }
  }

  function handleRun() {
    mutation.mutate({ spot, strike, dte, iv, rv, hedgeFreq, position, nSims })
  }

  // Build histogram data
  const histData = (() => {
    if (!result) return []
    const pnls = result.terminalPnls
    const min = Math.min(...pnls)
    const max = Math.max(...pnls)
    const nBuckets = 30
    const bucketSize = (max - min) / nBuckets || 1
    const buckets: { x: number; count: number }[] = []
    for (let i = 0; i < nBuckets; i++) {
      buckets.push({ x: parseFloat((min + (i + 0.5) * bucketSize).toFixed(2)), count: 0 })
    }
    for (const p of pnls) {
      const idx = Math.min(Math.floor((p - min) / bucketSize), nBuckets - 1)
      buckets[idx].count++
    }
    return buckets
  })()

  // Build path chart data — merge 5 paths into one array by day
  const pathData = (() => {
    if (!result) return []
    const maxDay = result.samplePaths[0]?.length ?? 0
    return Array.from({ length: maxDay }, (_, i) => {
      const obj: Record<string, number> = { day: i }
      result.samplePaths.forEach((path, pi) => {
        obj[`p${pi}`] = path[i]?.pnl ?? 0
      })
      return obj
    })
  })()

  const sidebar = (
    <RailSection title="Sim Controls" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader label="Underlying" />

      <div>
        <span style={LABEL}>Ticker</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            style={{ ...INPUT, flex: 1 }}
            value={ticker}
            onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && fetchTickerData()}
            placeholder="SPY"
          />
          <button
            onClick={fetchTickerData}
            disabled={fetching}
            style={{
              background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)',
              border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)',
              color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'var(--theme-mono)',
              fontSize: 11, padding: '5px 8px', cursor: fetching ? 'wait' : 'pointer',
            }}
          >
            {fetching ? '…' : 'Fill'}
          </button>
        </div>
        {fetchErr && <div style={{ fontSize: 10, color: cc.loss, marginTop: 3 }}>{fetchErr}</div>}
      </div>

      <div>
        <span style={LABEL}>Spot Price ($)</span>
        <input style={INPUT} type="number" min={1} step={0.5} value={spot}
          onChange={e => setSpot(parseFloat(e.target.value) || 0)} />
      </div>

      <div>
        <span style={LABEL}>
          Strike ($)
          <HelpTip text="ATM (= spot) maximizes gamma. OTM reduces both premium and gamma." width={160} />
        </span>
        <input style={INPUT} type="number" min={1} step={0.5} value={strike}
          onChange={e => setStrike(parseFloat(e.target.value) || 0)} />
      </div>

      <SectionHeader label="Option Params" />

      <div>
        <span style={LABEL}>
          DTE (days)
          <HelpTip text="Longer DTE = more theta bleed. Near expiry, gamma accelerates." width={160} />
        </span>
        <input style={INPUT} type="number" min={1} max={365} value={dte}
          onChange={e => setDte(Math.max(1, Math.min(365, parseInt(e.target.value) || 1)))} />
      </div>

      <div>
        <span style={LABEL}>
          Implied Vol (%)
          <HelpTip text="Option pricing vol. Edge = RV - IV. IV > RV favors short gamma." width={160} />
        </span>
        <input style={INPUT} type="number" min={1} max={500} step={0.1} value={iv}
          onChange={e => setIv(parseFloat(e.target.value) || 0)} />
      </div>

      <div>
        <span style={LABEL}>
          Realized Vol (%)
          <HelpTip text="Actual stock vol in sim. RV > IV = long gamma edge. Auto-filled by the fetch button." width={160} />
        </span>
        <input style={INPUT} type="number" min={1} max={500} step={0.1} value={rv}
          onChange={e => setRv(parseFloat(e.target.value) || 0)} />
      </div>

      <SectionHeader label="Simulation" />

      <div>
        <span style={LABEL}>
          Hedge Frequency
          <HelpTip text="How often delta is rebalanced. More frequent = smoother but costlier." width={160} />
        </span>
        <Select value={hedgeFreq}
          onChange={e => setHedgeFreq(e.target.value as typeof hedgeFreq)}>
          <option>Hourly</option>
          <option>4x Daily</option>
          <option>Twice Daily</option>
          <option>Daily</option>
          <option>Weekly</option>
        </Select>
      </div>

      <div>
        <span style={LABEL}>
          Position
          <HelpTip text="Long: profit if RV > IV. Short: collect theta, lose if stock moves." width={160} />
        </span>
        <Select value={position}
          onChange={e => setPosition(e.target.value as typeof position)}>
          <option value="Long Gamma">Long Gamma (bought straddle)</option>
          <option value="Short Gamma">Short Gamma (sold straddle)</option>
        </Select>
      </div>

      <div>
        <span style={LABEL}>
          Simulations
          <HelpTip text="More paths = smoother distribution. 500 is balanced. Use 2000 for precision." width={160} />
        </span>
        <input style={INPUT} type="number" min={100} max={2000} step={100} value={nSims}
          onChange={e => setNSims(Math.max(100, Math.min(2000, parseInt(e.target.value) || 500)))} />
      </div>

      <button
        onClick={handleRun}
        disabled={mutation.isPending}
        style={{
          marginTop: 4,
          background: mutation.isPending
            ? 'color-mix(in srgb, var(--theme-primary) 12%, transparent)'
            : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 22%, transparent)',
          border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)',
          color: 'var(--theme-primary, #c9a84c)',
          fontFamily: 'var(--theme-mono)',
          fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
          padding: '9px 0', cursor: mutation.isPending ? 'wait' : 'pointer',
          width: '100%', textAlign: 'center',
        }}
      >
        {mutation.isPending ? 'Running…' : 'Run Simulation'}
      </button>

      {mutation.isError && (
        <div style={{ fontSize: 10, color: cc.loss }}>
          Simulation error. Check inputs.
        </div>
      )}
    </div>
    </RailSection>
  )

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 10, borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))', paddingBottom: 10,
        }}>
          <h1 style={{
            fontFamily: 'var(--theme-mono)', fontSize: 14, fontWeight: 700,
            letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)', margin: 0,
          }}>
            Gamma Scalping Simulator
          </h1>
          <span style={{ fontSize: 10, color: 'var(--theme-secondary, #8099b0)', letterSpacing: '0.06em' }}>
            delta-hedge P&L · long/short gamma · {nSims} paths
          </span>
        </div>

        <SidebarLayout sidebar={sidebar} sidebarTitle="" sidebarWidth={210}>
          {!result ? (
            <EmptyState
              title="No simulation run yet"
              hint="Configure position parameters in the sidebar and click Run Simulation."
              action="Run Simulation"
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              {/* Metric cards */}
              <div style={{ display: 'flex', flexWrap: 'wrap', background: 'var(--theme-surface, #142032)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                <KpiCell
                  grow
                  label="Avg P&L"
                  value={`$${result.avgPnl >= 0 ? '+' : ''}${result.avgPnl.toFixed(2)}`}
                  valueSize={20}
                  sub={`${nSims} simulations`}
                  help="Mean terminal P&L across all simulation paths after delta-hedging."
                />
                <KpiCell
                  grow
                  label="Prob Profit"
                  value={`${result.probProfit.toFixed(1)}%`}
                  valueSize={20}
                  sub="paths with PnL > 0"
                  help="Fraction of simulation paths ending with positive P&L."
                />
                <KpiCell
                  grow
                  label="Breakeven RV"
                  value={`${result.breakevenRv.toFixed(1)}%`}
                  valueSize={20}
                  sub={`IV = ${iv}%`}
                  help="The realized vol at which expected P&L is approximately zero (delta-hedge neutral)."
                />
                <KpiCell
                  grow
                  label="Theta Bleed / Day"
                  value={`$${result.thetaBleedPerDay.toFixed(3)}`}
                  valueSize={20}
                  sub="BS theta decay"
                  help="Daily option value decay (BS theta), paid by long gamma / received by short gamma."
                />
              </div>

              {/* Chart 1 — P&L Distribution */}
              <ChartPanel
                label="P&L Distribution"
                height={220}
                note={`IV ${iv}%  ·  RV ${rv}%  ·  ${position}`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={histData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke={cc.gridLine} />
                    <XAxis
                      dataKey="x"
                      tick={TICK}
                      tickFormatter={v => `$${Number(v).toFixed(0)}`}
                      interval="preserveStartEnd"
                    />
                    <YAxis tick={TICK} width={28} />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={{ color: 'var(--theme-text, #d7e3fc)', fontSize: 11 }}
                      labelFormatter={v => `P&L: $${Number(v).toFixed(2)}`}
                      formatter={(v: number) => [v, 'Paths']}
                    />
                    <ReferenceLine x={0} stroke={cc.muted} strokeDasharray="4 3" />
                    <Bar dataKey="count" maxBarSize={24} isAnimationActive={false}>
                      {histData.map((entry, i) => (
                        <Cell key={i} fill={entry.x >= 0 ? cc.gain : cc.loss} fillOpacity={0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartPanel>

              {/* Chart 2 — Sample Paths */}
              <ChartPanel label="Sample Paths, worst · p10 · median · p90 · best" height={220} note="cumulative PnL">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={pathData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={cc.gridLine} />
                    <XAxis dataKey="day" tick={TICK} label={{ value: 'Day', position: 'insideRight', offset: -4, fill: 'var(--theme-text-faint, rgba(255,255,255,0.22))', fontSize: 9 }} />
                    <YAxis tick={TICK} width={40} tickFormatter={v => `$${v.toFixed(0)}`} />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={{ color: 'var(--theme-text, #d7e3fc)', fontSize: 11 }}
                      labelFormatter={v => `Day ${v}`}
                      formatter={(v: number, name: string) => [`$${v.toFixed(2)}`, `Path ${name.replace('p', '')}`]}
                    />
                    <ReferenceLine y={0} stroke={cc.muted} strokeDasharray="4 3" />
                    {[0, 1, 2, 3, 4].map(i => (
                      <Line
                        key={i}
                        type="monotone"
                        dataKey={`p${i}`}
                        stroke={cc.c2}
                        strokeOpacity={0.3 + i * 0.12}
                        strokeWidth={1.2}
                        dot={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </ChartPanel>

              {/* Chart 3 — Avg Cumulative PnL vs Theta Bleed */}
              <ChartPanel
                label="Avg Realized Gamma P&L vs Theta Decay"
                height={220}
                note="per day"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={result.avgHedgePnl} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <defs>
                      <linearGradient id="gainGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={cc.gain} stopOpacity={0.35} />
                        <stop offset="95%" stopColor={cc.gain} stopOpacity={0.04} />
                      </linearGradient>
                      <linearGradient id="lossGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={cc.loss} stopOpacity={0.35} />
                        <stop offset="95%" stopColor={cc.loss} stopOpacity={0.04} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={cc.gridLine} />
                    <XAxis dataKey="day" tick={TICK} label={{ value: 'Day', position: 'insideBottomRight', offset: 0, fill: 'var(--theme-text-faint, rgba(255,255,255,0.22))', fontSize: 9 }} />
                    <YAxis tick={TICK} width={44} tickFormatter={v => `$${v.toFixed(0)}`} />
                    <Tooltip
                      contentStyle={TOOLTIP_STYLE}
                      labelStyle={{ color: 'var(--theme-text, #d7e3fc)', fontSize: 11 }}
                      labelFormatter={v => `Day ${v}`}
                      formatter={(v: number, name: string) => [`$${v.toFixed(3)}`, name]}
                    />
                    <Legend
                      verticalAlign="top"
                      align="right"
                      wrapperStyle={{ fontSize: 10, fontFamily: 'var(--theme-mono)', paddingBottom: 4, flexWrap: 'wrap' }}
                    />
                    <ReferenceLine y={0} stroke={cc.muted} strokeDasharray="4 3" />
                    <Area
                      type="monotone"
                      dataKey="hedgePnl"
                      name="Realized Gamma P&L"
                      stroke={cc.gain}
                      fill="url(#gainGrad)"
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                    <Area
                      type="monotone"
                      dataKey="thetaCost"
                      name="Theta Cost"
                      stroke={cc.loss}
                      fill="url(#lossGrad)"
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartPanel>

            </div>
          )}
        </SidebarLayout>
      </div>
  )
}
