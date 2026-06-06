import { useState, useMemo } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceLine, Legend,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import MetricCard from '../components/MetricCard'
import { useChartColors } from '../hooks/useChartColors'
import StrategySelector, { STRATEGIES, type StrategyParams } from '../components/StrategySelector'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'
import ChartTooltip from '../components/ChartTooltip'
import axios from 'axios'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'
import { usePortfolio } from '../contexts/PortfolioContext'
import HelpTip from '../components/HelpTip'

// ── Shared ──────────────────────────────────────────────────────────────────

const TAB_BAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  background: 'var(--theme-surface, #0d1826)',
  borderBottom: '1px solid rgba(255,255,255,0.06)',
  marginBottom: 0,
  flexShrink: 0,
}

const TAB_BASE: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  padding: '10px 20px',
  cursor: 'pointer',
  background: 'none',
  border: 'none',
  borderBottom: '2px solid transparent',
  transition: 'color 0.15s, border-color 0.15s',
}

type Tab = 'portfolio' | 'strategy'

// ── Portfolio tab types & constants ─────────────────────────────────────────

type Asset = {
  ticker: string
  weight: number
  strategy: string
  stratParams: StrategyParams
}

const makeAsset = (ticker: string, weight: number): Asset => ({
  ticker, weight, strategy: STRATEGIES[0], stratParams: {},
})

const PORT_DEFAULTS: Asset[] = [
  makeAsset('MSFT', 40),
  makeAsset('AAPL', 30),
  makeAsset('GOOGL', 20),
  makeAsset('AMZN', 10),
]

const PORT_INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: '1px solid rgba(255,255,255,0.10)', color: '#d7e3fc',
  fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '5px 8px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}

const PORT_LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block',
}

const PORT_TICK = { fontSize: 9, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'JetBrains Mono, monospace' }

// ── Strategy tab types & constants ───────────────────────────────────────────

const ALGO_STRATEGIES = [
  { value: 'rsi_mean_reversion', label: 'RSI Mean Reversion' },
  { value: 'ma_crossover',       label: 'MA Crossover' },
  { value: 'bollinger_breakout', label: 'Bollinger Breakout' },
  { value: 'momentum',           label: 'Momentum' },
]

const ALGO_DEFAULT_PARAMS: Record<string, Record<string, number>> = {
  rsi_mean_reversion: { period: 14, oversold: 30, overbought: 70 },
  ma_crossover:       { fast: 20, slow: 50 },
  bollinger_breakout: { period: 20, std_dev: 2.0 },
  momentum:           { lookback: 20 },
}

const ALGO_PARAM_LABELS: Record<string, Record<string, string>> = {
  rsi_mean_reversion: { period: 'Period', oversold: 'Oversold', overbought: 'Overbought' },
  ma_crossover:       { fast: 'Fast MA', slow: 'Slow MA' },
  bollinger_breakout: { period: 'Period', std_dev: 'Std Dev' },
  momentum:           { lookback: 'Lookback Days' },
}

const ALGO_INPUT: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.10)',
  color: '#d7e3fc',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  padding: '5px 8px',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box',
}

const ALGO_LABEL: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--theme-secondary, #5e768f)',
  marginBottom: 4,
  display: 'block',
}

const ALGO_TICK = { fontSize: 9, fill: 'var(--theme-secondary, #5e768f)', fontFamily: 'JetBrains Mono, monospace' }

const ALGO_SECTION_DIVIDER: React.CSSProperties = {
  borderTop: '1px solid rgba(255,255,255,0.06)',
  marginTop: 14,
  paddingTop: 14,
}

type BacktestResult = {
  equity_curve: { date: string; strategy: number; benchmark: number }[]
  metrics: {
    total_return: number
    ann_return: number
    max_drawdown: number
    sharpe: number
    num_trades: number
    win_rate: number
  }
  trades: { date: string; action: string; price: number }[]
}

type SignalResult = {
  signal: 'BUY' | 'SELL' | 'HOLD'
  value: number
  description: string
}

// ── Shared sub-components ────────────────────────────────────────────────────

function PortChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
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

function AlgoChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.08)', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, zIndex: 10,
        background: 'rgba(46,57,77,0.85)', padding: '3px 10px',
        borderRight: '1px solid rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.06)',
        fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#d7e3fc',
      }}>
        {label}
      </div>
      <div style={{ paddingTop: 30, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>
        {children}
      </div>
    </div>
  )
}

// ── Portfolio tab content ────────────────────────────────────────────────────

function PortfolioTab() {
  const cc = useChartColors()
  const { holdings } = usePortfolio()
  const initialAssets = useMemo(() => {
    if (holdings.length === 0) return PORT_DEFAULTS
    const total = holdings.reduce((s, h) => s + h.weight, 0) || holdings.length
    return holdings.map(h => makeAsset(h.ticker, Math.round(h.weight / total * 100)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const [assets, setAssets] = useState<Asset[]>(initialAssets)
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
        const sigMaps: Record<string, number>[] = legSigs.map(sig => {
          const m: Record<string, number> = {}
          if (sig?.signal) sig.signal.forEach((s: any) => { m[s.date] = s.value })
          return m
        })
        const lastSigs = assets.map(() => 1)

        const tickerRetMaps: Record<string, Record<string, number>> = {}
        for (const a of assets) {
          const map: Record<string, number> = {}
          bt.per_ticker_returns[a.ticker]?.forEach((r: any) => { map[r.date] = r.value / 100 })
          tickerRetMaps[a.ticker] = map
        }

        let stratVal = 100, portVal = 100, benchVal = 100
        const stratCumulative: { date: string; strategy: number; portfolio: number; benchmark: number }[] = []

        bt.cumulative.forEach((row: any, i: number) => {
          assets.forEach((_, li) => {
            const sv = sigMaps[li][row.date]
            if (sv !== undefined) lastSigs[li] = sv
          })

          if (i > 0) {
            const prevRow = bt.cumulative[i - 1]
            const benchRet = (row.benchmark / prevRow.benchmark) - 1

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

  const focus = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')
  const blur  = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'rgba(255,255,255,0.10)')

  return (
    <SidebarLayout sidebarWidth={240} sidebarTitle="Portfolio Controls" sidebar={<>
        <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, flex: 1, overflowY: 'auto' }}>
          <div>
            <label style={PORT_LABEL}>Allocation</label>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <span style={{ flex: 7, fontSize: 9, color: 'rgba(255,255,255,0.22)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Ticker</span>
              <span style={{ flex: 4, fontSize: 9, color: 'rgba(255,255,255,0.22)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Wt %</span>
              <span style={{ width: 16 }} />
            </div>

            {assets.map((a, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                  <input style={{ ...PORT_INPUT, flex: 7, padding: '4px 6px' }} value={a.ticker}
                    onChange={e => updateAsset(i, { ticker: e.target.value.toUpperCase() })}
                    onFocus={focus} onBlur={blur} />
                  <input type="number" style={{ ...PORT_INPUT, flex: 4, padding: '4px 6px' }} value={a.weight} step={1}
                    onChange={e => updateAsset(i, { weight: +e.target.value })}
                    onFocus={focus} onBlur={blur} />
                  <button
                    style={{ width: 16, background: 'none', border: 'none', color: 'rgba(255,255,255,0.22)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0 }}
                    onMouseEnter={e => ((e.target as HTMLElement).style.color = '#8c2e36')}
                    onMouseLeave={e => ((e.target as HTMLElement).style.color = '#4d4637')}
                    onClick={() => setAssets(p => p.filter((_, j) => j !== i))}>×</button>
                </div>

                <div style={{ paddingLeft: 2 }}>
                  <label style={{ ...PORT_LABEL, fontSize: 9, marginBottom: 3 }}>Strategy</label>
                  <StrategySelector
                    value={a.strategy}
                    params={a.stratParams}
                    onChange={(s, p) => updateAsset(i, { strategy: s, stratParams: p })}
                    compact
                  />
                </div>

                {i < assets.length - 1 && (
                  <div style={{ borderBottom: '1px solid rgba(255,255,255,0.06)', marginTop: 10 }} />
                )}
              </div>
            ))}

            <button
              style={{ fontSize: 10, color: 'rgba(255,255,255,0.22)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, letterSpacing: '0.1em', marginTop: 2 }}
              onMouseEnter={e => ((e.target as HTMLElement).style.color = 'var(--theme-primary, #c9a84c)')}
              onMouseLeave={e => ((e.target as HTMLElement).style.color = '#4d4637')}
              onClick={() => setAssets(p => [...p, makeAsset('', 0)])}>+ Add Asset</button>
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={PORT_LABEL}>Benchmark</label>
              <input style={PORT_INPUT} value={benchmark} onChange={e => setBenchmark(e.target.value.toUpperCase())} onFocus={focus} onBlur={blur} />
            </div>
            <div>
              <label style={PORT_LABEL}>Start</label>
              <input type="date" style={PORT_INPUT} value={start} onChange={e => setStart(e.target.value)} onFocus={focus} onBlur={blur} />
            </div>
            <div>
              <label style={PORT_LABEL}>End</label>
              <input type="date" style={PORT_INPUT} value={end} onChange={e => setEnd(e.target.value)} onFocus={focus} onBlur={blur} />
            </div>
          </div>
        </div>

        <div style={{ padding: 10, borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 8 }}>
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
            width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
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
            {data.strategyResult?.legs?.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.strategyResult.legs.map((l: any, i: number) => (
                  <div key={i} style={{
                    background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.08)',
                    borderLeft: `4px solid ${l.drift_adj >= 0 ? '#2f6b4b' : '#8c2e36'}`,
                    padding: '8px 14px',
                  }}>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, color: l.drift_adj >= 0 ? '#4caf7d' : '#e05c6e', marginBottom: 3 }}>
                      {l.ticker} · {l.strategy} — {l.label}
                      <span style={{ marginLeft: 10, fontSize: 10, color: 'var(--theme-secondary, #99907e)', fontWeight: 400 }}>
                        Drift adj: {l.drift_adj > 0 ? '+' : ''}{l.drift_adj}%
                      </span>
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)' }}>{l.detail}</div>
                  </div>
                ))}
              </div>
            )}

            <div style={{
              position: 'sticky', top: 0, zIndex: 20,
              background: 'var(--theme-bg, #0a1628)', padding: '8px 0 4px',
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
            </div>

            <PortChartPanel label="Cumulative Return — Base 100" height={308}>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={data.strategyResult?.cumulative || data.cumulative}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                  <XAxis dataKey="date" tick={PORT_TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" />
                  <YAxis tick={PORT_TICK} orientation="right" />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line type="monotone" dataKey="portfolio" name="Portfolio" stroke={cc.c2} strokeWidth={2.5} dot={false} />
                  <Line type="monotone" dataKey="benchmark" name={benchmark} stroke={cc.primary} strokeWidth={2} strokeDasharray="5 3" dot={false} />
                  {data.strategyResult && (
                    <Line type="monotone" dataKey="strategy" name="Strategy Overlay"
                      stroke={cc.gain} strokeWidth={2} strokeDasharray="4 2" dot={false} />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </PortChartPanel>

            <div className="chart-pair">
              <PortChartPanel label="Daily Portfolio Returns" height={208}>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={data.daily_returns}>
                    <XAxis dataKey="date" tick={false} />
                    <YAxis tick={PORT_TICK} tickFormatter={v => `${v}%`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={BAR_CURSOR} />
                    <Bar dataKey="value" fill={cc.c2Muted} opacity={0.7} />
                  </BarChart>
                </ResponsiveContainer>
              </PortChartPanel>
              <PortChartPanel label={`Rolling 60D Beta vs ${benchmark}`} height={208}>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={data.rolling_beta}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="date" tick={PORT_TICK} tickFormatter={d => d.slice(0, 7)} interval="preserveStartEnd" />
                    <YAxis tick={PORT_TICK} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                    <ReferenceLine y={1} stroke="rgba(128,128,128,0.4)" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="value" stroke={cc.gain} strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </PortChartPanel>
            </div>
          </>
        )}
    </SidebarLayout>
  )
}

// ── Strategy tab content ─────────────────────────────────────────────────────

function StrategyTab() {
  const cc = useChartColors()

  const [ticker, setTicker] = useState('SPY')
  const [strategy, setStrategy] = useState('rsi_mean_reversion')
  const [params, setParams] = useState<Record<string, number>>(ALGO_DEFAULT_PARAMS.rsi_mean_reversion)
  const [startDate, setStartDate] = useState('2022-01-01')

  const [result, setResult] = useState<BacktestResult | null>(null)
  const [liveSignal, setLiveSignal] = useState<SignalResult | null>(null)
  const [aiCommentary, setAiCommentary] = useState<any>(null)
  const [aiCommentaryPending, setAiCommentaryPending] = useState(false)

  const signalMutation = useMutation({
    mutationFn: (body: object) =>
      axios.post('/api/algo/signal', body).then(r => r.data as SignalResult),
    onSuccess: data => setLiveSignal(data),
  })

  const backtestMutation = useMutation({
    mutationFn: (body: object) =>
      axios.post('/api/algo/backtest', body).then(r => r.data as BacktestResult),
    onSuccess: data => {
      setResult(data)
      signalMutation.mutate({ ticker: ticker.trim().toUpperCase(), strategy, params })
    },
  })

  function handleStrategyChange(val: string) {
    setStrategy(val)
    setParams(ALGO_DEFAULT_PARAMS[val] ?? {})
  }

  function handleParamChange(key: string, val: string) {
    setParams(prev => ({ ...prev, [key]: parseFloat(val) || 0 }))
  }

  function runBacktest() {
    backtestMutation.mutate({
      ticker: ticker.trim().toUpperCase(),
      strategy,
      params,
      start: startDate,
    })
  }

  const monthlyReturns = useMemo(() => {
    if (!result) return []
    const curve = result.equity_curve
    const monthly: Record<string, { start: number; end: number }> = {}
    for (const pt of curve) {
      const month = pt.date.slice(0, 7)
      if (!monthly[month]) monthly[month] = { start: pt.strategy, end: pt.strategy }
      monthly[month].end = pt.strategy
    }
    return Object.entries(monthly).map(([month, { start, end }]) => ({
      month,
      return: parseFloat(((end / start - 1) * 100).toFixed(2)),
    }))
  }, [result])

  const signalColor = liveSignal
    ? liveSignal.signal === 'BUY' ? cc.gain
      : liveSignal.signal === 'SELL' ? cc.loss
      : cc.muted
    : cc.muted

  const paramKeys = Object.keys(ALGO_DEFAULT_PARAMS[strategy] ?? {})
  const paramLabels = ALGO_PARAM_LABELS[strategy] ?? {}

  const sidebar = (
    <div style={{ padding: '14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <span style={ALGO_LABEL}>Ticker</span>
        <input
          style={ALGO_INPUT}
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          placeholder="e.g. SPY"
        />
      </div>

      <div>
        <span style={ALGO_LABEL}>
          Strategy
          <HelpTip text="RSI Mean Reversion: buys oversold, sells overbought. MA Crossover: long when fast MA > slow MA. Bollinger Breakout: enters on band breaks. Momentum: long when N-day return is positive." position="right" width={240} />
        </span>
        <select
          style={{ ...ALGO_INPUT, cursor: 'pointer' }}
          value={strategy}
          onChange={e => handleStrategyChange(e.target.value)}
        >
          {ALGO_STRATEGIES.map(s => (
            <option key={s.value} value={s.value} style={{ background: '#0d1826' }}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {paramKeys.length > 0 && (
        <div style={ALGO_SECTION_DIVIDER}>
          <span style={{ ...ALGO_LABEL, color: 'var(--theme-primary, #c9a84c)', marginBottom: 8 }}>Parameters</span>
          {paramKeys.map(key => (
            <div key={key} style={{ marginBottom: 8 }}>
              <span style={ALGO_LABEL}>{paramLabels[key] ?? key}</span>
              <input
                type="number"
                style={ALGO_INPUT}
                value={params[key] ?? ''}
                onChange={e => handleParamChange(key, e.target.value)}
                step={key === 'std_dev' ? 0.1 : 1}
              />
            </div>
          ))}
        </div>
      )}

      <div style={ALGO_SECTION_DIVIDER}>
        <span style={ALGO_LABEL}>Start Date</span>
        <input
          type="date"
          style={ALGO_INPUT}
          value={startDate}
          onChange={e => setStartDate(e.target.value)}
        />
      </div>

      <button
        onClick={runBacktest}
        disabled={backtestMutation.isPending}
        style={{
          marginTop: 6,
          background: backtestMutation.isPending
            ? 'rgba(201,168,76,0.15)'
            : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)',
          border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)',
          color: backtestMutation.isPending ? 'rgba(201,168,76,0.45)' : 'var(--theme-primary, #c9a84c)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.12em',
          padding: '8px 12px',
          cursor: backtestMutation.isPending ? 'not-allowed' : 'pointer',
          width: '100%',
          textTransform: 'uppercase',
          transition: 'all 0.15s',
        }}
      >
        {backtestMutation.isPending ? '· Running ·' : '↓ Run Backtest'}
      </button>

      {backtestMutation.isError && (
        <div style={{ fontSize: 10, color: cc.loss, letterSpacing: '0.04em', padding: '4px 0' }}>
          Error: {(backtestMutation.error as Error)?.message ?? 'Request failed'}
        </div>
      )}

      <div style={{ ...ALGO_SECTION_DIVIDER, marginTop: 18 }}>
        <span style={{ ...ALGO_LABEL, marginBottom: 8 }}>Live Signal</span>
        {liveSignal ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: '5px 14px',
              border: `1px solid ${signalColor}`,
              background: `color-mix(in srgb, ${signalColor} 12%, transparent)`,
              color: signalColor,
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 14,
              fontWeight: 700,
              letterSpacing: '0.18em',
            }}>
              {liveSignal.signal}
            </div>
            <div style={{ fontSize: 9, color: 'var(--theme-secondary, #5e768f)', letterSpacing: '0.05em', lineHeight: '14px' }}>
              {liveSignal.description}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.06em' }}>
            Run backtest to compute
          </div>
        )}
      </div>
    </div>
  )

  return (
    <SidebarLayout sidebar={sidebar} sidebarTitle="Strategy Controls" sidebarWidth={220}>
      {!result && !backtestMutation.isPending && (
        <EmptyState
          title="No backtest results yet"
          hint="Configure a strategy in the sidebar and click Run Backtest."
        />
      )}

      {backtestMutation.isPending && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          minHeight: 300, color: 'var(--theme-secondary, #5e768f)',
          fontFamily: 'JetBrains Mono, monospace', fontSize: 11, letterSpacing: '0.12em',
        }}>
          Computing strategy signals…
        </div>
      )}

      {result && !backtestMutation.isPending && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            <MetricCard
              label="Total Return"
              value={`${result.metrics.total_return > 0 ? '+' : ''}${result.metrics.total_return.toFixed(2)}%`}
              deltaPositive={result.metrics.total_return >= 0}
            />
            <MetricCard
              label="Ann. Return"
              value={`${result.metrics.ann_return > 0 ? '+' : ''}${result.metrics.ann_return.toFixed(2)}%`}
              deltaPositive={result.metrics.ann_return >= 0}
            />
            <MetricCard
              label="Max Drawdown"
              value={`${result.metrics.max_drawdown.toFixed(2)}%`}
              deltaPositive={false}
            />
            <MetricCard
              label="Sharpe Ratio"
              value={result.metrics.sharpe.toFixed(3)}
              deltaPositive={result.metrics.sharpe >= 1}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            <MetricCard
              label="Num Trades"
              value={result.metrics.num_trades}
            />
            <MetricCard
              label="Win Rate"
              value={`${result.metrics.win_rate.toFixed(1)}%`}
              deltaPositive={result.metrics.win_rate >= 50}
            />
            <div />
            <div />
          </div>

          {/* AI Backtest Commentary */}
          <div style={{ border: '1px solid rgba(201,168,76,0.2)', background: 'rgba(201,168,76,0.03)' }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid rgba(201,168,76,0.12)', background: 'rgba(201,168,76,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#c9a84c' }}>AI Backtest Commentary</span>
              <button
                onClick={async () => {
                  setAiCommentaryPending(true)
                  try {
                    const { data: r } = await axios.post('/api/ai/backtest-commentary', {
                      strategy_name: strategy,
                      ticker: ticker.trim().toUpperCase(),
                      total_return: result.metrics.total_return,
                      ann_return: result.metrics.ann_return,
                      max_drawdown: result.metrics.max_drawdown,
                      sharpe: result.metrics.sharpe,
                      win_rate: result.metrics.win_rate,
                      num_trades: result.metrics.num_trades,
                    })
                    setAiCommentary(r)
                  } catch { /* silent */ }
                  setAiCommentaryPending(false)
                }}
                disabled={aiCommentaryPending}
                style={{
                  background: 'color-mix(in srgb, #c9a84c 10%, transparent)',
                  border: '1px solid rgba(201,168,76,0.4)', color: '#c9a84c',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: 9,
                  padding: '2px 6px', cursor: aiCommentaryPending ? 'default' : 'pointer',
                  opacity: aiCommentaryPending ? 0.5 : 1,
                }}
              >{aiCommentaryPending ? '…' : '⬢ Analyze'}</button>
            </div>
            {!aiCommentary && !aiCommentaryPending && (
              <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--theme-secondary, #5e768f)', fontFamily: 'IBM Plex Sans, sans-serif' }}>
                Click Analyze for AI commentary on these backtest results.
              </div>
            )}
            {aiCommentary && (
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, color: '#d7e3fc', lineHeight: '16px', fontFamily: 'IBM Plex Sans, sans-serif' }}>{aiCommentary.verdict}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { label: 'Strengths', items: aiCommentary.strengths, color: '#22c55e' },
                    { label: 'Weaknesses', items: aiCommentary.weaknesses, color: '#ef4444' },
                  ].map(({ label, items, color }) => (
                    <div key={label}>
                      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
                      {(items ?? []).map((s: string, i: number) => (
                        <div key={i} style={{ fontSize: 10, color: 'rgba(215,227,252,0.8)', lineHeight: '14px', paddingLeft: 8, borderLeft: `2px solid ${color}44`, marginBottom: 3, fontFamily: 'IBM Plex Sans, sans-serif' }}>{s}</div>
                      ))}
                    </div>
                  ))}
                </div>
                {Array.isArray(aiCommentary.suggestions) && aiCommentary.suggestions.length > 0 && (
                  <div>
                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color: '#c9a84c', textTransform: 'uppercase', marginBottom: 4 }}>Suggestions</div>
                    {aiCommentary.suggestions.map((s: string, i: number) => (
                      <div key={i} style={{ fontSize: 10, color: 'rgba(215,227,252,0.7)', lineHeight: '14px', paddingLeft: 8, borderLeft: '2px solid rgba(201,168,76,0.3)', marginBottom: 3, fontFamily: 'IBM Plex Sans, sans-serif' }}>{s}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <AlgoChartPanel label="Equity Curve — Strategy vs Buy &amp; Hold (starts $100)" height={350}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={result.equity_curve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="stratGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={cc.c2} stopOpacity={0.3} />
                    <stop offset="95%" stopColor={cc.c2} stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke={cc.gridLine} />
                <XAxis
                  dataKey="date"
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={d => d.slice(0, 7)}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={v => `$${v}`}
                  width={48}
                />
                <Tooltip
                  content={<ChartTooltip formatter={(v, _n) => `$${(v as number).toFixed(2)}`} />}
                  contentStyle={TOOLTIP_STYLE}
                  cursor={CROSSHAIR_CURSOR}
                />
                <Legend
                  wrapperStyle={{ fontSize: 9, fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.08em', paddingTop: 6 }}
                />
                <ReferenceLine y={100} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 2" />
                <Area
                  type="monotone"
                  dataKey="strategy"
                  name="Strategy"
                  stroke={cc.c2}
                  strokeWidth={2}
                  fill="url(#stratGrad)"
                  dot={false}
                  activeDot={{ r: 3, fill: cc.c2 }}
                />
                <Line
                  type="monotone"
                  dataKey="benchmark"
                  name="Buy & Hold"
                  stroke={cc.primary}
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  dot={false}
                  activeDot={{ r: 3, fill: cc.primary }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </AlgoChartPanel>

          <AlgoChartPanel label="Trade Signals on Price" height={260}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={result.equity_curve}
                margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke={cc.gridLine} />
                <XAxis
                  dataKey="date"
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={d => d.slice(0, 7)}
                  interval="preserveStartEnd"
                />
                <YAxis tick={ALGO_TICK} tickLine={false} axisLine={false} width={48} tickFormatter={v => `$${v}`} />
                <Tooltip
                  content={<ChartTooltip formatter={(v, _n) => `$${(v as number).toFixed(2)}`} />}
                  contentStyle={TOOLTIP_STYLE}
                  cursor={CROSSHAIR_CURSOR}
                />
                <Line
                  type="monotone"
                  dataKey="strategy"
                  name="Strategy ($)"
                  stroke={cc.muted}
                  strokeWidth={1.5}
                  dot={false}
                />
                {result.trades
                  .filter(t => t.action === 'BUY')
                  .map(t => (
                    <ReferenceLine
                      key={`buy-${t.date}`}
                      x={t.date}
                      stroke={cc.gain}
                      strokeWidth={1}
                      strokeDasharray="2 3"
                      label={{
                        value: '▲',
                        position: 'insideTopLeft',
                        fill: cc.gain,
                        fontSize: 8,
                      }}
                    />
                  ))}
                {result.trades
                  .filter(t => t.action === 'SELL')
                  .map(t => (
                    <ReferenceLine
                      key={`sell-${t.date}`}
                      x={t.date}
                      stroke={cc.loss}
                      strokeWidth={1}
                      strokeDasharray="2 3"
                      label={{
                        value: '▼',
                        position: 'insideTopRight',
                        fill: cc.loss,
                        fontSize: 8,
                      }}
                    />
                  ))}
              </LineChart>
            </ResponsiveContainer>
          </AlgoChartPanel>

          <AlgoChartPanel label="Monthly Strategy Returns" height={200}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyReturns} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={cc.gridLine} />
                <XAxis
                  dataKey="month"
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={v => `${v}%`}
                  width={40}
                />
                <Tooltip
                  content={<ChartTooltip formatter={(v, _n) => `${(v as number).toFixed(2)}%`} />}
                  contentStyle={TOOLTIP_STYLE}
                  cursor={BAR_CURSOR}
                />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
                <Bar
                  dataKey="return"
                  name="Monthly Return"
                  radius={[2, 2, 0, 0]}
                  fill={cc.gain}
                  shape={(props: {
                    x?: number; y?: number; width?: number; height?: number;
                    value?: number;
                  }) => {
                    const { x = 0, y = 0, width = 0, height = 0, value = 0 } = props
                    const fill = value >= 0 ? cc.gain : cc.loss
                    return <rect x={x} y={y} width={width} height={Math.abs(height)} fill={fill} rx={2} />
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </AlgoChartPanel>

          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{
              padding: '6px 12px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
              color: '#d7e3fc', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Trade Log</span>
              <span style={{ color: 'var(--theme-secondary, #5e768f)', fontWeight: 400 }}>
                {result.trades.length} trades
              </span>
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    {['Date', 'Action', 'Price'].map(col => (
                      <th key={col} style={{
                        padding: '5px 12px', textAlign: 'left',
                        fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                        color: 'var(--theme-secondary, #5e768f)', position: 'sticky', top: 0,
                        background: 'var(--theme-bg, #101c2e)',
                      }}>
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.trades.map((trade, i) => (
                    <tr
                      key={i}
                      style={{
                        borderBottom: '1px solid rgba(255,255,255,0.04)',
                        background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                      }}
                    >
                      <td style={{ padding: '5px 12px', color: 'var(--theme-secondary, #5e768f)' }}>
                        {trade.date}
                      </td>
                      <td style={{ padding: '5px 12px' }}>
                        <span style={{
                          color: trade.action === 'BUY' ? cc.gain : cc.loss,
                          fontWeight: 700,
                          fontSize: 10,
                          letterSpacing: '0.08em',
                        }}>
                          {trade.action}
                        </span>
                      </td>
                      <td style={{ padding: '5px 12px', color: '#d7e3fc' }}>
                        ${trade.price.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  {result.trades.length === 0 && (
                    <tr>
                      <td colSpan={3} style={{ padding: '16px 12px', color: 'rgba(255,255,255,0.2)', textAlign: 'center', fontSize: 10 }}>
                        No trades generated
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </SidebarLayout>
  )
}

// ── Unified Backtester page ──────────────────────────────────────────────────

interface BacktesterProps {
  initialTab?: Tab
}

export default function PortfolioBacktester({ initialTab = 'portfolio' }: BacktesterProps) {
  const [activeTab, setActiveTab] = useState<Tab>(initialTab)

  return (
    <PageWrapper>
      {/* Page header */}
      <div style={{ marginBottom: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
          <h1 style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 14, fontWeight: 700, letterSpacing: '0.18em',
            textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)', margin: 0,
          }}>
            Backtester
          </h1>
          <span style={{
            fontSize: 9, color: 'var(--theme-secondary, #5e768f)',
            fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.12em',
          }}>
            Portfolio simulation &amp; strategy analysis
          </span>
        </div>

        {/* Tab bar */}
        <div style={TAB_BAR}>
          {(['portfolio', 'strategy'] as Tab[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                ...TAB_BASE,
                color: activeTab === tab
                  ? 'var(--theme-primary, #c9a84c)'
                  : 'var(--theme-secondary, #5e768f)',
                borderBottom: activeTab === tab
                  ? '2px solid var(--theme-primary, #c9a84c)'
                  : '2px solid transparent',
              }}
            >
              {tab}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ marginTop: 16 }}>
        {activeTab === 'portfolio' ? <PortfolioTab /> : <StrategyTab />}
      </div>
    </PageWrapper>
  )
}
