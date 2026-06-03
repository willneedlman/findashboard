import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import MetricCard from '../components/MetricCard'
import StrategySelector, { STRATEGIES, type StrategyParams } from '../components/StrategySelector'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR } from '../components/ChartTooltip'
import axios from 'axios'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'

type Asset = {
  ticker: string
  weight: number
  strategy: string
  stratParams: StrategyParams
}

const makeAsset = (ticker: string, weight: number): Asset => ({
  ticker, weight, strategy: STRATEGIES[0], stratParams: {},
})

const DEFAULTS: Asset[] = [
  makeAsset('MSFT', 40),
  makeAsset('AAPL', 30),
  makeAsset('GOOGL', 20),
  makeAsset('AMZN', 10),
]

const INPUT: React.CSSProperties = {
  background: '#0a1628', border: '1px solid #4d4637', color: '#d7e3fc',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '5px 8px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}
const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: '#99907e', marginBottom: 4, display: 'block',
}
const TICK = { fontSize: 9, fill: '#99907e', fontFamily: 'JetBrains Mono, monospace' }

function ChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: '#101c2e', border: '1px solid #2e394d', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, zIndex: 10,
        background: 'rgba(46,57,77,0.8)', padding: '3px 8px',
        borderRight: '1px solid #2e394d', borderBottom: '1px solid #2e394d',
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

export default function PortfolioBacktester() {
  const [assets, setAssets] = useState<Asset[]>(DEFAULTS)
  const [benchmark, setBenchmark] = useState('SPY')
  const [start, setStart] = useState('2020-01-01')
  const [end, setEnd] = useState('2024-12-31')

  const { mutate, data, isPending } = useMutation({
    mutationFn: async () => {
      const totalWeight = assets.reduce((s, a) => s + a.weight, 0) || 100
      const weights = assets.map(a => a.weight / totalWeight * 100)

      const [{ data: bt }, ...legSigs] = await Promise.all([
        axios.post('/api/portfolio/backtest', {
          tickers: assets.map(a => a.ticker),
          weights,
          benchmark, start, end,
        }),
        ...assets.map(a =>
          a.strategy !== STRATEGIES[0]
            ? axios.post('/api/strategy/signal', { ticker: a.ticker, strategy: a.strategy, start, end, params: a.stratParams })
                .then(r => r.data).catch(() => null)
            : Promise.resolve(null)
        ),
      ])

      const rfDaily = 0.045 / 252
      const hasAnyStrategy = legSigs.some(s => s?.signal?.length > 0)

      let strategyResult = null
      if (hasAnyStrategy) {
        // Build per-leg signal maps
        const sigMaps: Record<string, number>[] = legSigs.map(sig => {
          const m: Record<string, number> = {}
          if (sig?.signal) sig.signal.forEach((s: any) => { m[s.date] = s.value })
          return m
        })
        const lastSigs = assets.map(() => 1)

        // Per-ticker return maps for fast lookup
        const tickerRetMaps: Record<string, Record<string, number>> = {}
        for (const a of assets) {
          const map: Record<string, number> = {}
          bt.per_ticker_returns[a.ticker]?.forEach((r: any) => { map[r.date] = r.value / 100 })
          tickerRetMaps[a.ticker] = map
        }

        let stratVal = 100, portVal = 100, benchVal = 100
        const stratCumulative: { date: string; strategy: number; portfolio: number; benchmark: number }[] = []

        bt.cumulative.forEach((row: any, i: number) => {
          // Update last signals for each leg
          assets.forEach((_, li) => {
            const sv = sigMaps[li][row.date]
            if (sv !== undefined) lastSigs[li] = sv
          })

          if (i > 0) {
            const prevRow = bt.cumulative[i - 1]
            const benchRet = (row.benchmark / prevRow.benchmark) - 1

            // Per-leg adjusted return: invested leg uses actual return, else rf
            let stratPortRet = 0
            assets.forEach((a, li) => {
              const wt = a.weight / totalWeight
              const actualRet = tickerRetMaps[a.ticker][row.date] ?? 0
              stratPortRet += wt * (lastSigs[li] > 0.5 ? actualRet : rfDaily)
            })

            const portRet = bt.daily_returns[i]?.value / 100 || 0
            portVal *= (1 + portRet)
            stratVal *= (1 + stratPortRet)
            benchVal *= (1 + benchRet)
          }
          stratCumulative.push({ date: row.date, strategy: +stratVal.toFixed(2), portfolio: +portVal.toFixed(2), benchmark: +benchVal.toFixed(2) })
        })

        const finalStrat = stratCumulative[stratCumulative.length - 1]?.strategy ?? 100
        const years = Math.max((new Date(end).getTime() - new Date(start).getTime()) / (365.25 * 86400000), 1)
        strategyResult = {
          cumulative: stratCumulative,
          cagr: +(((finalStrat / 100) ** (1 / years) - 1) * 100).toFixed(2),
          legs: assets.map((a, i) => ({
            ticker: a.ticker,
            strategy: a.strategy,
            label: legSigs[i]?.label ?? '',
            detail: legSigs[i]?.detail ?? '',
            drift_adj: legSigs[i]?.drift_adj ?? 0,
          })).filter(l => l.strategy !== STRATEGIES[0] && l.label),
        }
      }

      return { ...bt, strategyResult }
    },
  })

  const updateAsset = (i: number, patch: Partial<Asset>) =>
    setAssets(prev => prev.map((a, idx) => idx === i ? { ...a, ...patch } : a))

  const focus = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = '#c9a84c')
  const blur  = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = '#4d4637')

  return (
    <PageWrapper>
      <SidebarLayout sidebarWidth={240} sidebarTitle="Portfolio Controls" sidebar={<>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #2e394d', background: '#142032' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>
              Portfolio Controls
            </div>
          </div>

          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, flex: 1, overflowY: 'auto' }}>
            {/* Asset allocation */}
            <div>
              <label style={LABEL}>Allocation</label>
              <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                <span style={{ flex: 7, fontSize: 9, color: '#4d4637', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Ticker</span>
                <span style={{ flex: 4, fontSize: 9, color: '#4d4637', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Wt %</span>
                <span style={{ width: 16 }} />
              </div>

              {assets.map((a, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                    <input style={{ ...INPUT, flex: 7, padding: '4px 6px' }} value={a.ticker}
                      onChange={e => updateAsset(i, { ticker: e.target.value.toUpperCase() })}
                      onFocus={focus} onBlur={blur} />
                    <input type="number" style={{ ...INPUT, flex: 4, padding: '4px 6px' }} value={a.weight} step={1}
                      onChange={e => updateAsset(i, { weight: +e.target.value })}
                      onFocus={focus} onBlur={blur} />
                    <button
                      style={{ width: 16, background: 'none', border: 'none', color: '#4d4637', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0 }}
                      onMouseEnter={e => ((e.target as HTMLElement).style.color = '#8c2e36')}
                      onMouseLeave={e => ((e.target as HTMLElement).style.color = '#4d4637')}
                      onClick={() => setAssets(p => p.filter((_, j) => j !== i))}>×</button>
                  </div>

                  <div style={{ paddingLeft: 2 }}>
                    <label style={{ ...LABEL, fontSize: 9, marginBottom: 3 }}>Strategy</label>
                    <StrategySelector
                      value={a.strategy}
                      params={a.stratParams}
                      onChange={(s, p) => updateAsset(i, { strategy: s, stratParams: p })}
                      compact
                    />
                  </div>

                  {i < assets.length - 1 && (
                    <div style={{ borderBottom: '1px solid #1e2d3d', marginTop: 10 }} />
                  )}
                </div>
              ))}

              <button
                style={{ fontSize: 10, color: '#4d4637', background: 'none', border: 'none', cursor: 'pointer', padding: 0, letterSpacing: '0.1em', marginTop: 2 }}
                onMouseEnter={e => ((e.target as HTMLElement).style.color = '#c9a84c')}
                onMouseLeave={e => ((e.target as HTMLElement).style.color = '#4d4637')}
                onClick={() => setAssets(p => [...p, makeAsset('', 0)])}>+ Add Asset</button>
            </div>

            <div style={{ borderTop: '1px solid #2e394d', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <label style={LABEL}>Benchmark</label>
                <input style={INPUT} value={benchmark} onChange={e => setBenchmark(e.target.value.toUpperCase())} onFocus={focus} onBlur={blur} />
              </div>
              <div>
                <label style={LABEL}>Start</label>
                <input type="date" style={INPUT} value={start} onChange={e => setStart(e.target.value)} onFocus={focus} onBlur={blur} />
              </div>
              <div>
                <label style={LABEL}>End</label>
                <input type="date" style={INPUT} value={end} onChange={e => setEnd(e.target.value)} onFocus={focus} onBlur={blur} />
              </div>
            </div>
          </div>

          <div style={{ padding: 10, borderTop: '1px solid #2e394d', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <PortfolioIO
              mode="portfolio"
              assets={assets.map(a => ({ ticker: a.ticker, weight: a.weight, strategy: a.strategy, stratParams: a.stratParams as Record<string, unknown> }))}
              onImportAssets={(imported: PortfolioAsset[]) =>
                setAssets(imported.map(a => ({
                  ticker: a.ticker,
                  weight: a.weight,
                  strategy: a.strategy ?? STRATEGIES[0],
                  stratParams: (a.stratParams ?? {}) as StrategyParams,
                })))
              }
              name="portfolio"
            />
            <button onClick={() => mutate()} disabled={isPending} style={{
              width: '100%', background: '#1f2a3d', border: '1px solid #c9a84c', color: '#c9a84c',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer',
              opacity: isPending ? 0.6 : 1,
            }}>
              {isPending ? 'Running…' : '⬢ Run Portfolio Engine'}
            </button>
          </div>
      </>}>

          {!data && !isPending && (
            <EmptyState title="Portfolio Backtester" hint="Set your tickers, weights, and date range, then press Run Backtest." />
          )}

          {data && (
            <>
              {/* Per-leg strategy signal banners */}
              {data.strategyResult?.legs?.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {data.strategyResult.legs.map((l: any, i: number) => (
                    <div key={i} style={{
                      background: '#101c2e', border: '1px solid #2e394d',
                      borderLeft: `4px solid ${l.drift_adj >= 0 ? '#2f6b4b' : '#8c2e36'}`,
                      padding: '8px 14px',
                    }}>
                      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, color: l.drift_adj >= 0 ? '#4caf7d' : '#e05c6e', marginBottom: 3 }}>
                        {l.ticker} · {l.strategy} — {l.label}
                        <span style={{ marginLeft: 10, fontSize: 10, color: '#99907e', fontWeight: 400 }}>
                          Drift adj: {l.drift_adj > 0 ? '+' : ''}{l.drift_adj}%
                        </span>
                      </div>
                      <div style={{ fontSize: 10, color: '#99907e' }}>{l.detail}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* ── Sticky metric strip ── */}
              <div style={{
                position: 'sticky', top: 0, zIndex: 20,
                background: '#0a1628', padding: '8px 0 4px',
                borderBottom: '1px solid rgba(46,57,77,0.8)',
                display: 'flex', flexDirection: 'column', gap: 6,
              }}>
                <div className="metric-grid">
                  <MetricCard label="Portfolio CAGR" value={`${data.metrics.port_cagr}%`}
                    delta={`${data.metrics.port_cagr - data.metrics.bench_cagr > 0 ? '+' : ''}${(data.metrics.port_cagr - data.metrics.bench_cagr).toFixed(2)}% vs ${benchmark}`}
                    deltaPositive={data.metrics.port_cagr > data.metrics.bench_cagr}
                    help="Compound Annual Growth Rate — the smoothed annualized return your portfolio achieved over the backtest period." />
                  <MetricCard label={`${benchmark} CAGR`} value={`${data.metrics.bench_cagr}%`}
                    help={`Compound Annual Growth Rate of the ${benchmark} benchmark over the same period. Used as the passive-hold baseline.`} />
                  <MetricCard label="Sharpe" value={data.metrics.port_sharpe}
                    help="Sharpe Ratio — excess return earned per unit of total volatility. Higher is better; >1 is generally considered good." />
                  <MetricCard label="Ann. Vol" value={`${data.metrics.port_vol}%`}
                    help="Annualized Volatility — the standard deviation of daily returns scaled to a full year." />
                </div>

              {data.strategyResult ? (
                <div className="metric-grid">
                  <MetricCard label="Strategy CAGR" value={`${data.strategyResult.cagr}%`}
                    delta={`${(data.strategyResult.cagr - data.metrics.port_cagr).toFixed(2)}% vs portfolio`}
                    deltaPositive={data.strategyResult.cagr > data.metrics.port_cagr}
                    help="Compound Annual Growth Rate of the active overlay strategy, compared against the base portfolio." />
                  <MetricCard label="Max Drawdown" value={`${data.metrics.max_drawdown}%`} deltaPositive={false}
                    help="Maximum Drawdown — the largest peak-to-trough decline during the backtest." />
                  <MetricCard label="Sortino" value={data.metrics.sortino}
                    help="Sortino Ratio — penalizes only downside volatility. Higher is better; >1 is solid." />
                  <MetricCard label="Beta" value={data.metrics.beta}
                    help="Beta — measures the portfolio's sensitivity to benchmark movements." />
                </div>
              ) : (
                <div className="metric-grid">
                  <MetricCard label="Max Drawdown" value={`${data.metrics.max_drawdown}%`} deltaPositive={false}
                    help="Maximum Drawdown — the largest peak-to-trough decline during the backtest." />
                  <MetricCard label="Sortino" value={data.metrics.sortino}
                    help="Sortino Ratio — penalizes only downside volatility. Higher is better; >1 is solid." />
                  <MetricCard label="Calmar" value={data.metrics.calmar}
                    help="Calmar Ratio — annualized return divided by maximum drawdown." />
                  <MetricCard label="Beta" value={data.metrics.beta}
                    help="Beta — measures the portfolio's sensitivity to benchmark movements." />
                </div>
              )}
              </div>{/* end sticky metric strip */}

              <ChartPanel label="Cumulative Return — Base 100" height={308}>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={data.strategyResult?.cumulative || data.cumulative}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="date" tick={TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" />
                    <YAxis tick={TICK} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Line type="monotone" dataKey="portfolio" name="Portfolio" stroke="#1f5673" strokeWidth={2.5} dot={false} />
                    <Line type="monotone" dataKey="benchmark" name={benchmark} stroke="#d97736" strokeWidth={2} strokeDasharray="5 3" dot={false} />
                    {data.strategyResult && (
                      <Line type="monotone" dataKey="strategy" name="Strategy Overlay"
                        stroke="#4caf7d" strokeWidth={2} strokeDasharray="4 2" dot={false} />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </ChartPanel>

              <div className="chart-pair">
                <ChartPanel label="Daily Portfolio Returns" height={208}>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={data.daily_returns}>
                      <XAxis dataKey="date" tick={false} />
                      <YAxis tick={TICK} tickFormatter={v => `${v}%`} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                      <Bar dataKey="value" fill="#6c757d" opacity={0.7} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartPanel>
                <ChartPanel label={`Rolling 60D Beta vs ${benchmark}`} height={208}>
                  <ResponsiveContainer width="100%" height={180}>
                    <LineChart data={data.rolling_beta}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                      <XAxis dataKey="date" tick={TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" />
                      <YAxis tick={TICK} orientation="right" />
                      <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                      <ReferenceLine y={1} stroke="rgba(128,128,128,0.4)" strokeDasharray="4 4" />
                      <Line type="monotone" dataKey="value" stroke="#2f6b4b" strokeWidth={1.5} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartPanel>
              </div>
            </>
          )}
      </SidebarLayout>
    </PageWrapper>
  )
}
