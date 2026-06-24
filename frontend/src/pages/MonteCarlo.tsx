import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import MetricCard from '../components/MetricCard'
import { useChartColors } from '../hooks/useChartColors'
import StrategySelector, { STRATEGIES, CUSTOM_STRATEGY_KEY, type StrategyParams } from '../components/StrategySelector'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'
import { FUTURES } from '../lib/futures'
import axios from 'axios'
import EmptyState from '../components/EmptyState'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'
import PMImportPicker from '../components/PMImportPicker'
import { CASH_SYMBOL } from '../lib/pmImport'
import ConfigHeader from '../components/portfolio/ConfigHeader'
import { usePortfolio, type PortfolioHolding } from '../contexts/PortfolioContext'
// ── GBM math ────────────────────────────────────────────────────────────────

function runGBM(S0: number, mu: number, sigma: number, T: number, nSims: number) {
  const dt = 1 / 252
  const paths: number[][] = []
  for (let s = 0; s < nSims; s++) {
    const path = [S0]
    let v = S0
    for (let t = 0; t < T; t++) {
      v = v * Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * gaussRandom())
      path.push(v)
    }
    paths.push(path)
  }
  return paths
}

let _seed = 12345
function gaussRandom() {
  _seed = (_seed * 1664525 + 1013904223) & 0xffffffff
  const u1 = ((_seed >>> 0) / 0x100000000)
  _seed = (_seed * 1664525 + 1013904223) & 0xffffffff
  const u2 = ((_seed >>> 0) / 0x100000000)
  return Math.sqrt(-2 * Math.log(Math.max(u1, 1e-10))) * Math.cos(2 * Math.PI * u2)
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
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [horizon, setHorizon] = useState(252)
  const [nSims, setNSims] = useState(500)
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

      // Per-leg GBMs (normalized to start at 1.0)
      const allPaths = legs.map((leg, i) => {
        const mu    = (leg.drift + legAdjs[i].stratAdj) / 100
        const sigma = leg.vol / 100
        return runGBM(1.0, mu, sigma, horizon, Math.min(nSims, 500))
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
        probTarget, targetPrice,
        benchmark, legs: legs.map((l, i) => ({ ...l, ...legAdjs[i] })),
      }
    },
  })

  return (
    <>
      <ConfigHeader
        mode="montecarlo"
        onModeChange={m => { if (m === 'backtester') navigate('/backtest') }}
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
              </div>

              {/* Metric cards */}
              <div className="metric-grid">
                <MetricCard label="Starting Value" value="$100.00" />
                <MetricCard label="Median Final" value={`$${data.median.toFixed(2)}`}
                  delta={`${((data.median / data.S0 - 1) * 100).toFixed(1)}%`}
                  deltaPositive={data.median > data.S0} />
                <MetricCard label="Prob of Profit" value={`${data.probProfit.toFixed(1)}%`}
                  deltaPositive={data.probProfit > 50} />
                <MetricCard label="VaR 95%" value={`$${data.varAmt.toFixed(2)}`} deltaPositive={false} />
                {data.probTarget !== null && (
                  <MetricCard
                    label={`Prob ≥ $${data.targetPrice}`}
                    value={`${data.probTarget.toFixed(1)}%`}
                    deltaPositive={data.probTarget > 50}
                  />
                )}
              </div>

              <div className="metric-grid">
                <MetricCard label="P5 Outcome" value={`$${data.p5.toFixed(2)}`} />
                <MetricCard label="P95 Outcome" value={`$${data.p95.toFixed(2)}`} />
                <MetricCard label="CVaR 95%" value={`$${data.cvarAmt.toFixed(2)}`} deltaPositive={false} />
                <MetricCard label="Eff. Portfolio Drift" value={`${data.effDrift.toFixed(1)}%`} />
                {data.probRuin > 0 && (
                  <MetricCard label="Prob of Ruin" value={`${data.probRuin.toFixed(1)}%`}
                    delta="wiped to $0" deltaPositive={false} />
                )}
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
