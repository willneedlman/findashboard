import { useState, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import MetricCard from '../components/MetricCard'
import StrategySelector, { STRATEGIES, type StrategyParams } from '../components/StrategySelector'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'
import SidebarLayout from '../components/SidebarLayout'
import axios from 'axios'
import EmptyState from '../components/EmptyState'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'
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

const INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: '1px solid rgba(255,255,255,0.10)', color: '#d7e3fc',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '5px 8px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}
const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block',
}
const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'JetBrains Mono, monospace' }

function ChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.08)', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, zIndex: 10,
        background: 'rgba(46,57,77,0.8)', padding: '3px 8px',
        borderRight: '1px solid rgba(255,255,255,0.08)', borderBottom: '1px solid rgba(255,255,255,0.08)',
        fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#d7e3fc',
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

export default function MonteCarlo() {
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
  const [horizon, setHorizon] = useState(252)
  const [nSims, setNSims] = useState(500)
  const [benchmark, setBenchmark] = useState('SPY')
  const [fetching, setFetching] = useState(false)


  const updateLeg = (i: number, patch: Partial<Leg>) =>
    setLegs(prev => prev.map((l, idx) => idx === i ? { ...l, ...patch } : l))

  const fetchAll = async () => {
    setFetching(true)
    const updated = await Promise.all(
      legs.map(async (leg) => {
        try {
          const { data } = await axios.get(`/api/market/history?ticker=${leg.ticker}&start=2022-01-01`)
          if (data?.metrics) {
            const years = Math.max(new Date().getFullYear() - 2022, 1)
            return {
              ...leg,
              spot: +data.metrics.current_price.toFixed(2),
              vol:  +data.metrics.ann_volatility.toFixed(1),
              drift: +(data.metrics.total_return / years).toFixed(1),
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

  const { mutate, data, isPending } = useMutation({
    mutationFn: async () => {
      _seed = 42 * (horizon + nSims + legs.length)
      const totalWeight = legs.reduce((s, l) => s + l.weight, 0) || 100

      // Fire strategy signals + benchmark fetch in parallel
      const [legAdjs, benchResult] = await Promise.all([
        Promise.all(
          legs.map(async (leg) => {
            if (leg.strategy === STRATEGIES[0]) return { stratAdj: 0, stratLabel: '', stratDetail: '' }
            try {
              const { data: sig } = await axios.post('/api/strategy/signal', {
                ticker: leg.ticker, strategy: leg.strategy,
                start: '2022-01-01', end: new Date().toISOString().split('T')[0],
                params: leg.stratParams,
              })
              return { stratAdj: sig.drift_adj ?? 0, stratLabel: sig.label ?? '', stratDetail: sig.detail ?? '' }
            } catch { return { stratAdj: 0, stratLabel: '', stratDetail: '' } }
          })
        ),
        axios.get(`/api/market/history?ticker=${benchmark}&start=2020-01-01`)
          .then(r => r.data)
          .catch(() => null),
      ])

      const benchVol   = benchResult?.metrics?.ann_volatility ?? 15
      const benchDrift = benchResult?.metrics
        ? benchResult.metrics.total_return / Math.max(new Date().getFullYear() - 2020, 1)
        : 8

      // Per-leg GBMs (normalized to start at 1.0)
      const allPaths = legs.map((leg, i) => {
        const mu    = (leg.drift + legAdjs[i].stratAdj) / 100
        const sigma = leg.vol / 100
        return runGBM(1.0, mu, sigma, horizon, Math.min(nSims, 500))
      })

      // Combine into weighted portfolio paths (scaled to $100)
      const portfolioPaths = Array.from({ length: Math.min(nSims, 500) }, (_, simIdx) =>
        Array.from({ length: horizon + 1 }, (_, day) =>
          legs.reduce((sum, leg, li) =>
            sum + (leg.weight / totalWeight) * allPaths[li][simIdx][day], 0) * 100
        )
      )

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

      return {
        bands, histogram, S0, median, p5, p95, probProfit, varAmt, cvarAmt, effDrift,
        benchmark, legs: legs.map((l, i) => ({ ...l, ...legAdjs[i] })),
      }
    },
  })

  const focus = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')
  const blur  = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'rgba(255,255,255,0.10)')
  const totalWeight = legs.reduce((s, l) => s + l.weight, 0)

  return (
    <PageWrapper>
      <SidebarLayout sidebarWidth={210} sidebarTitle="Simulation Controls" sidebar={<>

        {/* ── Left sidebar ─────────────────────────────────────────────── */}

          <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'var(--theme-surface, #142032)' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>
              Simulation Parameters
            </div>
          </div>

          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, flex: 1, overflowY: 'auto' }}>

            {/* Per-leg inputs */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <label style={{ ...LABEL, marginBottom: 0 }}>Portfolio Legs</label>
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                  color: totalWeight === 100 ? '#2f6b4b' : '#8c2e36',
                }}>
                  {totalWeight}%
                </span>
              </div>

              {/* Column headers */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                <span style={{ flex: 7, fontSize: 9, color: 'rgba(255,255,255,0.22)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Ticker</span>
                <span style={{ flex: 4, fontSize: 9, color: 'rgba(255,255,255,0.22)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Wt %</span>
                <span style={{ width: 16 }} />
              </div>

              {legs.map((leg, i) => (
                <div key={i} style={{ marginBottom: 8 }}>
                  {/* Ticker + weight row */}
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 4 }}>
                    <input
                      style={{ ...INPUT, flex: 7, padding: '4px 6px', fontSize: 11 }}
                      value={leg.ticker}
                      onChange={e => updateLeg(i, { ticker: e.target.value.toUpperCase(), fetched: false })}
                      onFocus={focus} onBlur={blur}
                    />
                    <input
                      type="number" min={0} max={100} step={5}
                      style={{ ...INPUT, flex: 4, padding: '4px 6px', fontSize: 11 }}
                      value={leg.weight}
                      onChange={e => updateLeg(i, { weight: +e.target.value })}
                      onFocus={focus} onBlur={blur}
                    />
                    <button
                      style={{ width: 16, background: 'none', border: 'none', color: 'rgba(255,255,255,0.22)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0 }}
                      onMouseEnter={e => ((e.target as HTMLElement).style.color = '#8c2e36')}
                      onMouseLeave={e => ((e.target as HTMLElement).style.color = '#4d4637')}
                      onClick={() => setLegs(p => p.filter((_, j) => j !== i))}
                    >×</button>
                  </div>

                  {/* Fetched stats pill */}
                  {leg.fetched && (
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.22)', letterSpacing: '0.08em', marginBottom: 4, paddingLeft: 2 }}>
                      ${leg.spot.toLocaleString()} · σ {leg.vol}% · μ {leg.drift}%/yr
                    </div>
                  )}

                  {/* Per-leg strategy */}
                  <div style={{ paddingLeft: 2 }}>
                    <label style={{ ...LABEL, fontSize: 9, marginBottom: 3 }}>Strategy</label>
                    <StrategySelector
                      value={leg.strategy}
                      params={leg.stratParams}
                      onChange={(s, p) => updateLeg(i, { strategy: s, stratParams: p })}
                      compact
                    />
                  </div>

                  {/* Leg divider */}
                  {i < legs.length - 1 && (
                    <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', marginTop: 8 }} />
                  )}
                </div>
              ))}

              {/* Add leg + Fetch All */}
              <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                <button
                  style={{ fontSize: 10, color: 'rgba(255,255,255,0.22)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, letterSpacing: '0.1em' }}
                  onMouseEnter={e => ((e.target as HTMLElement).style.color = 'var(--theme-primary, #c9a84c)')}
                  onMouseLeave={e => ((e.target as HTMLElement).style.color = '#4d4637')}
                  onClick={() => setLegs(p => [...p, makeLeg('', Math.max(0, 100 - totalWeight))])}
                >+ Add Leg</button>
                <span style={{ color: 'rgba(255,255,255,0.08)', fontSize: 10 }}>·</span>
                <button
                  style={{ fontSize: 10, color: 'rgba(255,255,255,0.22)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, letterSpacing: '0.1em' }}
                  onMouseEnter={e => ((e.target as HTMLElement).style.color = 'var(--theme-primary, #c9a84c)')}
                  onMouseLeave={e => ((e.target as HTMLElement).style.color = '#4d4637')}
                  disabled={fetching}
                  onClick={fetchAll}
                >{fetching ? 'Fetching…' : 'Fetch All'}</button>
              </div>
            </div>

            {/* Shared simulation params */}
            <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={LABEL}>Horizon (trading days)</label>
                <input type="number" style={INPUT} value={horizon} step={21} min={5} max={504}
                  onChange={e => setHorizon(+e.target.value)} onFocus={focus} onBlur={blur} />
              </div>
              <div>
                <label style={LABEL}>Simulations</label>
                <input type="number" style={INPUT} value={nSims} step={100} min={100} max={2000}
                  onChange={e => setNSims(+e.target.value)} onFocus={focus} onBlur={blur} />
              </div>
              <div>
                <label style={LABEL}>Benchmark Ticker</label>
                <input style={INPUT} value={benchmark}
                  onChange={e => setBenchmark(e.target.value.toUpperCase())}
                  onFocus={focus} onBlur={blur} />
              </div>
            </div>
          </div>

          <div style={{ padding: 10, borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 8 }}>
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
            <button onClick={() => mutate()} disabled={isPending || legs.length === 0} style={{
              width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: (isPending || legs.length === 0) ? 'default' : 'pointer',
              opacity: (isPending || legs.length === 0) ? 0.6 : 1,
            }}>
              {isPending ? 'Simulating…' : '⬢ Run Simulation'}
            </button>
          </div>

      {/* ── Right panel ──────────────────────────────────────────────── */}
      </>}>

          {!data && !isPending && (
            <EmptyState title="Monte Carlo Simulator" hint="Add legs, set parameters, then press Run Simulation." />
          )}

          {data && (
            <>
              {/* Active strategy signals */}
              {data.legs.some((l: any) => l.strategy !== STRATEGIES[0] && l.stratLabel) && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {data.legs.filter((l: any) => l.strategy !== STRATEGIES[0] && l.stratLabel).map((l: any, i: number) => (
                    <div key={i} style={{
                      background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.08)',
                      borderLeft: `4px solid ${l.stratAdj >= 0 ? '#2f6b4b' : '#8c2e36'}`,
                      padding: '8px 14px',
                    }}>
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, color: l.stratAdj >= 0 ? '#4caf7d' : '#e05c6e', marginBottom: 3 }}>
                        {l.ticker} · {l.strategy} — {l.stratLabel}
                        <span style={{ marginLeft: 10, fontSize: 10, color: 'var(--theme-secondary, #99907e)', fontWeight: 400 }}>
                          Drift adj: {l.stratAdj > 0 ? '+' : ''}{l.stratAdj}% · Eff. drift: {+(l.drift + l.stratAdj).toFixed(1)}%/yr
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)' }}>{l.stratDetail}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Portfolio composition */}
              <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.08)', padding: '8px 12px', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                {data.legs.map((l: any, i: number) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, color: '#d7e3fc' }}>{l.ticker}</span>
                    <span style={{ fontSize: 10, color: 'var(--theme-primary, #c9a84c)' }}>{l.weight}%</span>
                    {l.fetched && (
                      <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.22)', letterSpacing: '0.06em' }}>
                        ${l.spot.toLocaleString()} · σ {l.vol}%
                      </span>
                    )}
                    {l.strategy !== STRATEGIES[0] && (
                      <span style={{ fontSize: 9, color: l.stratAdj >= 0 ? '#4caf7d' : '#e05c6e', letterSpacing: '0.06em' }}>
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
              </div>

              <div className="metric-grid">
                <MetricCard label="P5 Outcome" value={`$${data.p5.toFixed(2)}`} />
                <MetricCard label="P95 Outcome" value={`$${data.p95.toFixed(2)}`} />
                <MetricCard label="CVaR 95%" value={`$${data.cvarAmt.toFixed(2)}`} deltaPositive={false} />
                <MetricCard label="Eff. Portfolio Drift" value={`${data.effDrift.toFixed(1)}%`} />
              </div>

              <ChartPanel label={`Simulated Portfolio Paths vs ${data.benchmark}`} height={328}>
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={data.bands}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="day" tick={TICK} tickFormatter={d => `D${d}`} interval="preserveStartEnd" />
                    <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} domain={['auto', 'auto']} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} formatter={(v: number) => [`$${v.toFixed(2)}`]} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Area type="monotone" dataKey="p95" stroke="#2f6b4b" strokeWidth={1.5} fill="transparent" name="P95" />
                    <Area type="monotone" dataKey="p75" stroke="rgba(47,107,75,0.4)" strokeWidth={1} fill="rgba(31,86,115,0.1)" name="P75" />
                    <Area type="monotone" dataKey="p50" stroke="#1f5673" strokeWidth={2.5} fill="transparent" strokeDasharray="4 2" name="Median" />
                    <Area type="monotone" dataKey="bench_p50" stroke="#d97736" strokeWidth={1.5} fill="transparent" strokeDasharray="3 5" name={data.benchmark} />
                    <Area type="monotone" dataKey="p25" stroke="rgba(140,46,54,0.4)" strokeWidth={1} fill="transparent" name="P25" />
                    <Area type="monotone" dataKey="p5" stroke="#8c2e36" strokeWidth={1.5} fill="transparent" name="P5" />
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
                    <ReferenceLine x={String(Math.round(data.S0))} stroke="#c9a84c" strokeDasharray="4 4"
                      label={{ value: 'Entry', fill: 'var(--theme-primary, #c9a84c)', fontSize: 9 }} />
                    <ReferenceLine x={String(Math.round(data.median))} stroke="#1f5673" strokeDasharray="4 4"
                      label={{ value: 'Median', fill: 'var(--theme-tertiary, #1f5673)', fontSize: 9 }} />
                    <Bar dataKey="count" fill="#7b5ea7" opacity={0.8} name="Frequency" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartPanel>
            </>
          )}
      </SidebarLayout>
    </PageWrapper>
  )
}
