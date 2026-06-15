import { useState, useMemo, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  ReferenceLine, Legend,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import MetricCard from '../components/MetricCard'
import { useChartColors } from '../hooks/useChartColors'
import StrategySelector, { STRATEGIES, CUSTOM_STRATEGY_KEY, type StrategyParams } from '../components/StrategySelector'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'
import { FUTURES } from '../lib/futures'
import ChartTooltip from '../components/ChartTooltip'
import axios from 'axios'
import SidebarLayout from '../components/SidebarLayout'
import { RailSection } from './valuationShared'
import EmptyState from '../components/EmptyState'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'
import { usePortfolio } from '../contexts/PortfolioContext'
import HelpTip from '../components/HelpTip'

// ── Shared ──────────────────────────────────────────────────────────────────

const TAB_BAR: React.CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  background: 'var(--theme-surface, #0d1826)',
  borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
  marginBottom: 0,
  flexShrink: 0,
}

const TAB_BASE: React.CSSProperties = {
  fontFamily: 'var(--theme-mono)',
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
  background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: 'var(--theme-text, #d7e3fc)',
  fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '5px 8px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}

const PORT_LABEL: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)',
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block',
}

const PORT_TICK = { fontSize: 9, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'var(--theme-mono)' }

// ── Strategy tab types & constants ───────────────────────────────────────────

const ALGO_STRATEGIES = [
  { value: 'rsi_mean_reversion',  label: 'RSI Mean Reversion' },
  { value: 'ma_crossover',        label: 'MA Crossover' },
  { value: 'bollinger_breakout',  label: 'Bollinger Breakout' },
  { value: 'momentum',            label: 'Momentum' },
  { value: 'macd_crossover',      label: 'MACD Crossover' },
  { value: 'value_pe',            label: 'Value — P/E' },
  { value: 'earnings_momentum',   label: 'Earnings Growth' },
  { value: 'micro_scalp',         label: 'EMA Micro-Scalp (3/8)' },
]

const ALGO_DEFAULT_PARAMS: Record<string, Record<string, number>> = {
  rsi_mean_reversion:  { period: 14, oversold: 30, overbought: 70 },
  ma_crossover:        { fast: 20, slow: 50 },
  bollinger_breakout:  { period: 20, std_dev: 2.0 },
  momentum:            { lookback: 20 },
  macd_crossover:      { fast: 12, slow: 26, signal: 9 },
  value_pe:            { pe_in_threshold: 35 },
  earnings_momentum:   { exit_threshold_pct: -5 },
  micro_scalp:         { ema_fast: 3, ema_slow: 8, atr_period: 5, atr_mult: 0.3 },
}

const ALGO_PARAM_LABELS: Record<string, Record<string, string>> = {
  rsi_mean_reversion:  { period: 'Period', oversold: 'Oversold', overbought: 'Overbought' },
  ma_crossover:        { fast: 'Fast MA', slow: 'Slow MA' },
  bollinger_breakout:  { period: 'Period', std_dev: 'Std Dev' },
  momentum:            { lookback: 'Lookback Days' },
  macd_crossover:      { fast: 'Fast EMA', slow: 'Slow EMA', signal: 'Signal EMA' },
  value_pe:            { pe_in_threshold: 'P/E Exit Threshold' },
  earnings_momentum:   { exit_threshold_pct: 'EPS Exit %' },
  micro_scalp:         { ema_fast: 'Fast EMA', ema_slow: 'Slow EMA', atr_period: 'ATR Period', atr_mult: 'Min ATR %' },
}

const ALGO_INPUT: React.CSSProperties = {
  background: 'transparent',
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)',
  fontFamily: 'var(--theme-mono)',
  fontSize: 12,
  padding: '5px 8px',
  width: '100%',
  outline: 'none',
  boxSizing: 'border-box',
}

const ALGO_LABEL: React.CSSProperties = {
  fontFamily: 'var(--theme-sans)',
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--theme-secondary, #5e768f)',
  marginBottom: 4,
  display: 'block',
}

const ALGO_TICK = { fontSize: 9, fill: 'var(--theme-secondary, #5e768f)', fontFamily: 'var(--theme-mono)' }

const ALGO_SECTION_DIVIDER: React.CSSProperties = {
  borderTop: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))',
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
    initial_capital: number
    final_capital: number
    total_pnl: number
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

function AlgoChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, zIndex: 10,
        background: 'var(--theme-surface, rgba(46,57,77,0.85))', padding: '3px 10px',
        borderRight: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))',
        borderBottom: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))',
        fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
        color: 'var(--theme-text, #d7e3fc)',
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
  const [portOpen, setPortOpen] = useState(true)
  const [start, setStart] = useState('2020-01-01')
  const [end, setEnd] = useState(() => new Date().toISOString().split('T')[0])
  const [portSignalData, setPortSignalData] = useState<{ ticker: string; data: SignalChartPoint[]; trades: { date: string; action: string; price: number }[] }[]>([])
  const [slPct,    setSlPct]    = useState('')
  const [tpPct,    setTpPct]    = useState('')
  const [trailPct, setTrailPct] = useState('')
  const [posPct,   setPosPct]   = useState('100')
  const [cashYield, setCashYield] = useState('4.5')   // % APY earned on the un-deployed / idle cash sleeve
  const [leverage,   setLeverage]   = useState('1')
  const [borrowRate, setBorrowRate] = useState('0')

  const { mutate, data, isPending } = useMutation({
    mutationFn: async () => {
      const totalWeight = assets.reduce((s, a) => s + a.weight, 0) || 100
      const weights = assets.map(a => a.weight / totalWeight * 100)

      const [{ data: bt }, ...legSigs] = await Promise.all([
        axios.post('/api/portfolio/backtest', {
          tickers: assets.map(a => a.ticker),
          weights,
          benchmark, start, end,
          leverage: Number(leverage) || 1,
          borrow_rate: Number(borrowRate) || 0,
        }),
        ...assets.map(a => {
          if (a.strategy === STRATEGIES[0]) return Promise.resolve(null)
          if (a.strategy === CUSTOM_STRATEGY_KEY) {
            const customDef = a.stratParams._custom_def ? JSON.parse(a.stratParams._custom_def) : null
            if (!customDef) return Promise.resolve(null)
            return axios.post('/api/strategy/custom-signal', {
              ticker: a.ticker, start, end,
              rules: customDef, bull_drift: customDef.bull_drift ?? 5, bear_drift: customDef.bear_drift ?? -3,
            }).then(r => r.data).catch(() => null)
          }
          return axios.post('/api/strategy/signal', { ticker: a.ticker, strategy: a.strategy, start, end, params: a.stratParams })
            .then(r => r.data).catch(() => null)
        }),
      ])

      const rfDaily = (parseFloat(cashYield) || 0) / 100 / 252   // cash sleeve grows at the chosen yield
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

        const sl    = slPct    ? parseFloat(slPct)    / 100 : null
        const tp    = tpPct    ? parseFloat(tpPct)    / 100 : null
        const trail = trailPct ? parseFloat(trailPct) / 100 : null
        const pos   = parseFloat(posPct || '100') / 100

        const legInTrade  = assets.map(() => false)
        const legEntryCum = assets.map(() => 1.0)
        const legPeakCum  = assets.map(() => 1.0)
        const legStopped  = assets.map(() => false)

        let stratVal = 100, portVal = 100, benchVal = 100
        const stratCumulative: { date: string; strategy: number; portfolio: number; benchmark: number }[] = []

        bt.cumulative.forEach((row: any, i: number) => {
          assets.forEach((_, li) => {
            const sv = sigMaps[li][row.date]
            if (sv !== undefined) {
              const wasIn = lastSigs[li] > 0.5
              const nowIn = sv > 0.5
              if (wasIn && !nowIn) {
                legInTrade[li] = false; legEntryCum[li] = 1.0; legPeakCum[li] = 1.0; legStopped[li] = false
              } else if (!wasIn && nowIn) {
                legInTrade[li] = true; legEntryCum[li] = 1.0; legPeakCum[li] = 1.0; legStopped[li] = false
              }
              lastSigs[li] = sv
            }
          })

          if (i > 0) {
            const prevRow = bt.cumulative[i - 1]
            const benchRet = (row.benchmark / prevRow.benchmark) - 1

            let stratPortRet = 0
            assets.forEach((a, li) => {
              const wt = a.weight / totalWeight
              const actualRet = tickerRetMaps[a.ticker][row.date] ?? 0
              if (!legInTrade[li] || legStopped[li]) { stratPortRet += wt * rfDaily; return }
              legEntryCum[li] *= (1 + actualRet)
              legPeakCum[li]   = Math.max(legPeakCum[li], legEntryCum[li])
              const gain         = legEntryCum[li] - 1.0
              const drawFromPeak = legPeakCum[li] > 0 ? (legPeakCum[li] - legEntryCum[li]) / legPeakCum[li] : 0
              if ((sl    !== null && gain         < -sl)    ||
                  (tp    !== null && gain         > tp)     ||
                  (trail !== null && drawFromPeak > trail)) {
                legStopped[li] = true; stratPortRet += wt * rfDaily; return
              }
              stratPortRet += wt * (pos * actualRet + (1 - pos) * rfDaily)
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
        const signalTrades: { ticker: string; trades: { date: string; action: string; price: number }[] }[] = []
        assets.forEach((a, i) => {
          const sig: { date: string; value: number }[] = legSigs[i]?.signal ?? []
          if (!sig.length || a.strategy === STRATEGIES[0]) return
          const trades: { date: string; action: string; price: number }[] = []
          for (let j = 1; j < sig.length; j++) {
            if (sig[j - 1].value < 0.5 && sig[j].value >= 0.5)
              trades.push({ date: sig[j].date, action: 'BUY', price: 0 })
            else if (sig[j - 1].value >= 0.5 && sig[j].value < 0.5)
              trades.push({ date: sig[j].date, action: 'SELL', price: 0 })
          }
          if (trades.length > 0) signalTrades.push({ ticker: a.ticker, trades })
        })

        strategyResult = {
          cumulative: stratCumulative,
          cagr: +(((finalStrat / 100) ** (1 / years) - 1) * 100).toFixed(2),
          signalTrades,
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

  useEffect(() => {
    const legs = data?.strategyResult?.signalTrades as { ticker: string; trades: { date: string; action: string; price: number }[] }[] | undefined
    if (!legs?.length) { setPortSignalData([]); return }
    Promise.all(
      legs.map(leg =>
        axios.get(`/api/market/history?ticker=${encodeURIComponent(leg.ticker)}&start=${start}`)
          .then(r => {
            const prices: { date: string; value: number }[] = r.data.price ?? []
            const priceByDate: Record<string, number> = {}
            prices.forEach(p => { priceByDate[p.date] = p.value })
            const tradeMap: Record<string, { buy?: number; sell?: number }> = {}
            leg.trades.forEach(tr => {
              if (!tradeMap[tr.date]) tradeMap[tr.date] = {}
              const px = priceByDate[tr.date] ?? 0
              if (tr.action === 'BUY') tradeMap[tr.date].buy = px
              else tradeMap[tr.date].sell = px
            })
            return {
              ticker: leg.ticker,
              data: prices.map(p => ({ date: p.date, price: p.value, ...tradeMap[p.date] })),
              trades: leg.trades.map(tr => ({ ...tr, price: priceByDate[tr.date] ?? 0 })),
            }
          })
          .catch(() => null)
      )
    ).then(res => setPortSignalData(res.filter(Boolean) as typeof portSignalData))
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps

  const updateAsset = (i: number, patch: Partial<Asset>) =>
    setAssets(prev => prev.map((a, idx) => idx === i ? { ...a, ...patch } : a))

  const focus = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')
  const blur  = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')

  return (
    <SidebarLayout sidebarWidth={240} sidebarTitle="" sidebar={<>
        <RailSection title="Portfolio Controls" open={portOpen} onToggle={() => setPortOpen(o => !o)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <label style={PORT_LABEL}>Allocation</label>
            <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
              <span style={{ flex: 7, fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Ticker</span>
              <span style={{ flex: 4, fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Wt %</span>
              <span style={{ width: 16 }} />
            </div>

            {assets.map((a, i) => (
              <div key={i} style={{ marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                  <input style={{ ...PORT_INPUT, flex: 7, padding: '4px 6px' }} value={a.ticker}
                    list="ft-futures" placeholder="e.g. AAPL or ES=F"
                    onChange={e => updateAsset(i, { ticker: e.target.value.toUpperCase() })}
                    onFocus={focus} onBlur={blur} />
                  {i === 0 && <datalist id="ft-futures">{FUTURES.map(f => <option key={f.sym} value={f.sym}>{f.label}</option>)}</datalist>}
                  <input type="number" style={{ ...PORT_INPUT, flex: 4, padding: '4px 6px' }} value={a.weight} step={1}
                    onChange={e => updateAsset(i, { weight: +e.target.value })}
                    onFocus={focus} onBlur={blur} />
                  <button
                    style={{ width: 16, background: 'none', border: 'none', color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: 0, flexShrink: 0 }}
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
                  <div style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))', marginTop: 10 }} />
                )}
              </div>
            ))}

            <button
              style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', background: 'none', border: 'none', cursor: 'pointer', padding: 0, letterSpacing: '0.1em', marginTop: 2 }}
              onMouseEnter={e => ((e.target as HTMLElement).style.color = 'var(--theme-primary, #c9a84c)')}
              onMouseLeave={e => ((e.target as HTMLElement).style.color = '#4d4637')}
              onClick={() => setAssets(p => [...p, makeAsset('', 0)])}>+ Add Asset</button>
          </div>

          <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={PORT_LABEL}>Start</label>
              <input type="date" style={PORT_INPUT} value={start} onChange={e => setStart(e.target.value)} onFocus={focus} onBlur={blur} />
            </div>
            <div>
              <label style={PORT_LABEL}>End</label>
              <input type="date" style={PORT_INPUT} value={end} onChange={e => setEnd(e.target.value)} onFocus={focus} onBlur={blur} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <div>
                <label style={PORT_LABEL}>Leverage (x)</label>
                <input type="number" style={PORT_INPUT} value={leverage} min={1} step={0.25}
                  onChange={e => setLeverage(e.target.value)} onFocus={focus} onBlur={blur} />
              </div>
              {(Number(leverage) || 1) > 1 && (
                <div>
                  <label style={PORT_LABEL}>Borrow Rate %</label>
                  <input type="number" style={PORT_INPUT} value={borrowRate} min={0} max={30} step={0.5}
                    onChange={e => setBorrowRate(e.target.value)} onFocus={focus} onBlur={blur} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Risk Controls */}
        <div style={{ padding: '10px 10px 0', borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ ...PORT_LABEL, marginBottom: 0, color: 'var(--theme-primary, #c9a84c)' }}>Risk Controls</label>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {([
              { label: 'Conservative', sl: '8',  tp: '20', trail: '6',  pos: '25' },
              { label: 'Moderate',     sl: '15', tp: '35', trail: '10', pos: '50' },
              { label: 'Aggressive',   sl: '25', tp: '80', trail: '15', pos: '100' },
              { label: 'Uncapped',     sl: '',   tp: '',   trail: '',   pos: '100' },
            ] as const).map(p => (
              <button key={p.label} type="button"
                onClick={() => { setSlPct(p.sl); setTpPct(p.tp); setTrailPct(p.trail); setPosPct(p.pos) }}
                style={{
                  background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
                  color: 'var(--theme-primary, #c9a84c)',
                  fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
                  padding: '3px 7px', cursor: 'pointer', borderRadius: 2,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)')}
              >{p.label.toUpperCase()}</button>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[
              { label: 'Stop-Loss %', val: slPct,    set: setSlPct },
              { label: 'Take-Profit %', val: tpPct,  set: setTpPct },
              { label: 'Trailing Stop %', val: trailPct, set: setTrailPct },
              { label: 'Position Size %', val: posPct,   set: setPosPct },
              { label: 'Cash Yield %', val: cashYield, set: setCashYield },
            ].map(({ label, val, set }) => (
              <div key={label}>
                <label style={{ ...PORT_LABEL, fontSize: 9, marginBottom: 2 }}>{label}</label>
                <input type="number" style={{ ...PORT_INPUT, padding: '3px 6px', fontSize: 10 }}
                  value={val} placeholder={label.includes('Position') ? '100' : 'off'}
                  onChange={e => set(e.target.value)} min={0.1} step={1}
                  onFocus={focus} onBlur={blur} />
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: 10, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <label style={PORT_LABEL}>Benchmark</label>
            <input style={PORT_INPUT} value={benchmark} onChange={e => setBenchmark(e.target.value.toUpperCase())} onFocus={focus} onBlur={blur} />
          </div>
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
            {isPending ? 'Running…' : 'Run Portfolio Engine'}
          </button>
        </div>
        </RailSection>
    </>}>

        {!data && !isPending && (
          <EmptyState title="Portfolio Backtester" hint="Set your tickers, weights, and date range, then press Run Backtest." />
        )}

        {data && (
          <>
            {data.leverage > 1 && (
              <div style={{
                background: 'var(--theme-bg, #101c2e)',
                border: `1px solid color-mix(in srgb, ${data.liquidated ? 'var(--theme-negative)' : 'var(--theme-primary, #c9a84c)'} 35%, transparent)`,
                borderLeft: `4px solid ${data.liquidated ? 'var(--theme-negative)' : 'var(--theme-primary, #c9a84c)'}`,
                padding: '8px 14px', fontFamily: 'var(--theme-mono)', fontSize: 11, lineHeight: 1.5,
              }}>
                <span style={{ color: data.liquidated ? 'var(--theme-negative)' : 'var(--theme-primary, #c9a84c)', fontWeight: 700 }}>
                  {data.liquidated ? 'LIQUIDATED' : `LEVERED ${data.leverage}x`}
                </span>
                <span style={{ color: 'var(--theme-secondary, #99907e)', marginLeft: 8 }}>
                  {data.liquidated
                    ? `Equity hit zero at ${data.leverage}x leverage. The portfolio was wiped out; the curve below stops at -100%.`
                    : `Borrowing ${(data.leverage - 1).toFixed(2)}x capital at ${data.borrow_rate}% to magnify returns. Metrics reflect the levered equity.`}
                </span>
              </div>
            )}
            {data.strategyResult?.legs?.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {data.strategyResult.legs.map((l: any, i: number) => (
                  <div key={i} style={{
                    background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
                    borderLeft: `4px solid ${l.drift_adj >= 0 ? '#2f6b4b' : '#8c2e36'}`,
                    padding: '8px 14px',
                  }}>
                    <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, fontWeight: 700, color: l.drift_adj >= 0 ? '#4caf7d' : '#e05c6e', marginBottom: 3 }}>
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

            {portSignalData.map(leg => (
              <BacktestSignalChart
                key={leg.ticker}
                data={leg.data}
                ticker={leg.ticker}
                trades={leg.trades}
              />
            ))}
          </>
        )}
    </SidebarLayout>
  )
}

// ── Backtest signal chart ────────────────────────────────────────────────────

interface SignalChartPoint {
  date: string
  price: number
  buy?: number
  sell?: number
}

function BacktestSignalChart({ data, ticker, trades }: {
  data: SignalChartPoint[]
  ticker: string
  trades: { date: string; action: string; price: number }[]
}) {
  const cc = useChartColors()
  const buyCount = trades.filter(t => t.action === 'BUY').length
  const sellCount = trades.filter(t => t.action === 'SELL').length

  type DotProps = { cx?: number; cy?: number; value?: number }

  const BuyDot = (props: DotProps) => {
    const { cx = 0, cy = 0, value } = props
    if (value == null) return null
    return <polygon points={`${cx},${cy - 7} ${cx - 5},${cy + 1} ${cx + 5},${cy + 1}`} style={{ fill: 'var(--theme-positive)' }} stroke="none" />
  }

  const SellDot = (props: DotProps) => {
    const { cx = 0, cy = 0, value } = props
    if (value == null) return null
    return <polygon points={`${cx},${cy + 7} ${cx - 5},${cy - 1} ${cx + 5},${cy - 1}`} style={{ fill: 'var(--theme-negative)' }} stroke="none" />
  }

  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        background: 'var(--theme-surface, rgba(46,57,77,0.85))', padding: '4px 10px',
        borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
        fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
      }}>
        <span style={{ color: 'var(--theme-text, #d7e3fc)' }}>▶ REPLAY · {ticker}</span>
        <span style={{ color: 'var(--theme-positive)' }}>▲ {buyCount} BUY</span>
        <span style={{ color: 'var(--theme-negative)' }}>▼ {sellCount} SELL</span>
      </div>
      <div style={{ padding: '4px 8px 8px 8px', height: 260 }}>
        {data.length === 0 ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, color: 'var(--theme-text-muted, rgba(215,227,252,0.35))', fontFamily: 'var(--theme-mono)' }}>
            Fetching price history…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
                width={52}
                tickFormatter={v => `$${(v as number).toFixed(0)}`}
                domain={['auto', 'auto']}
              />
              <Tooltip
                content={<ChartTooltip formatter={(v, _n) => `$${(v as number).toFixed(2)}`} />}
                contentStyle={TOOLTIP_STYLE}
                cursor={CROSSHAIR_CURSOR}
              />
              <Line
                type="monotone"
                dataKey="price"
                name="Price"
                stroke={cc.primary}
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3, fill: cc.primary }}
              />
              <Line
                type="monotone"
                dataKey="buy"
                name="BUY"
                stroke="transparent"
                dot={<BuyDot />}
                activeDot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="sell"
                name="SELL"
                stroke="transparent"
                dot={<SellDot />}
                activeDot={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  )
}

// ── Strategy tab content ─────────────────────────────────────────────────────

function StrategyTab() {
  const cc = useChartColors()

  const [ticker, setTicker] = useState('SPY')
  const [strategy, setStrategy] = useState('rsi_mean_reversion')
  const [params, setParams] = useState<Record<string, number>>(ALGO_DEFAULT_PARAMS.rsi_mean_reversion)
  const [startDate, setStartDate] = useState('2022-01-01')
  const [stratOpen, setStratOpen] = useState(true)
  const [stopLoss, setStopLoss] = useState('')
  const [takeProfit, setTakeProfit] = useState('')
  const [trailingStop, setTrailingStop] = useState('')
  const [maxHoldBars, setMaxHoldBars] = useState('')
  const [positionSize, setPositionSize] = useState('100')
  const [initialCapital, setInitialCapital] = useState('10000')

  const [result, setResult] = useState<BacktestResult | null>(null)
  const [priceChartData, setPriceChartData] = useState<SignalChartPoint[]>([])
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
      setPriceChartData([])
      signalMutation.mutate({ ticker: ticker.trim().toUpperCase(), strategy, params })
      const t = ticker.trim().toUpperCase()
      axios.get(`/api/market/history?ticker=${encodeURIComponent(t)}&start=${startDate}`)
        .then(r => {
          const prices: { date: string; value: number }[] = r.data.price ?? []
          const tradeMap: Record<string, { buy?: number; sell?: number }> = {}
          data.trades.forEach(tr => {
            if (!tradeMap[tr.date]) tradeMap[tr.date] = {}
            if (tr.action === 'BUY') tradeMap[tr.date].buy = tr.price
            else if (tr.action === 'SELL') tradeMap[tr.date].sell = tr.price
          })
          setPriceChartData(prices.map(p => ({ date: p.date, price: p.value, ...tradeMap[p.date] })))
        })
        .catch(() => {})
    },
  })

  function handleStrategyChange(val: string) {
    setStrategy(val)
    setParams(ALGO_DEFAULT_PARAMS[val] ?? {})
  }

  function handleParamChange(key: string, val: string) {
    const n = parseFloat(val)
    setParams(prev => ({ ...prev, [key]: val === '' ? 0 : isNaN(n) ? prev[key] ?? 0 : n }))
  }

  function runBacktest() {
    const sl = parseFloat(stopLoss)
    const tp = parseFloat(takeProfit)
    const ts = parseFloat(trailingStop)
    const mh = parseInt(maxHoldBars)
    const ps = parseFloat(positionSize)
    const ic = parseFloat(initialCapital)
    backtestMutation.mutate({
      ticker: ticker.trim().toUpperCase(),
      strategy,
      params,
      start: startDate,
      stop_loss:      isNaN(sl) || sl <= 0 ? undefined : sl,
      take_profit:    isNaN(tp) || tp <= 0 ? undefined : tp,
      trailing_stop:  isNaN(ts) || ts <= 0 ? undefined : ts,
      max_hold_bars:  isNaN(mh) || mh <= 0 ? undefined : mh,
      position_size:  isNaN(ps) ? 100 : Math.min(100, Math.max(5, ps)),
      initial_capital: isNaN(ic) || ic <= 0 ? 10000 : ic,
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
    <RailSection title="Strategy Controls" open={stratOpen} onToggle={() => setStratOpen(o => !o)}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
          <HelpTip text="RSI Mean Reversion: buys oversold, sells overbought. MA Crossover: long when fast MA > slow MA. Bollinger Breakout: enters on band breaks. Momentum: long when N-day return is positive." position="bottom" width={230} />
        </span>
        <select
          style={{ ...ALGO_INPUT, cursor: 'pointer' }}
          value={strategy}
          onChange={e => handleStrategyChange(e.target.value)}
        >
          {ALGO_STRATEGIES.map(s => (
            <option key={s.value} value={s.value} style={{ background: 'var(--theme-surface)' }}>
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
        <span style={{ ...ALGO_LABEL, color: 'var(--theme-primary, #c9a84c)', marginBottom: 8 }}>
          Risk Management
          <HelpTip text="Stop-loss and take-profit exit the position when price moves the specified % from entry. Position size controls how much of the portfolio is deployed per trade. The remainder stays in cash." position="bottom" width={230} />
        </span>
        {/* Preset risk profiles */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
          {([
            { label: 'Conservative', sl: '5', tp: '10', trail: '4', pos: '25' },
            { label: 'Moderate',     sl: '8', tp: '20', trail: '6', pos: '50' },
            { label: 'Aggressive',   sl: '15', tp: '40', trail: '10', pos: '100' },
            { label: 'Scalp',        sl: '2', tp: '4',  trail: '1.5', pos: '75' },
          ] as const).map(p => (
            <button
              key={p.label}
              type="button"
              onClick={() => { setStopLoss(p.sl); setTakeProfit(p.tp); setTrailingStop(p.trail); setPositionSize(p.pos) }}
              style={{
                background: 'rgba(201,168,76,0.08)',
                border: '1px solid rgba(201,168,76,0.3)',
                color: 'rgba(201,168,76,0.85)',
                fontFamily: 'var(--theme-mono)',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.08em',
                padding: '3px 7px',
                cursor: 'pointer',
                borderRadius: 2,
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(201,168,76,0.18)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(201,168,76,0.08)')}
            >
              {p.label.toUpperCase()}
            </button>
          ))}
        </div>
        <div style={{ marginBottom: 8 }}>
          <span style={ALGO_LABEL}>Stop-Loss %</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={stopLoss}
            onChange={e => setStopLoss(e.target.value)}
            placeholder="e.g. 5  (off if blank)"
            min={0.1}
            step={0.5}
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <span style={ALGO_LABEL}>Take-Profit %</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={takeProfit}
            onChange={e => setTakeProfit(e.target.value)}
            placeholder="e.g. 15  (off if blank)"
            min={0.1}
            step={0.5}
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <span style={ALGO_LABEL}>Trailing Stop %</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={trailingStop}
            onChange={e => setTrailingStop(e.target.value)}
            placeholder="e.g. 8  (off if blank)"
            min={0.1}
            step={0.5}
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <span style={ALGO_LABEL}>Max Hold (days)</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={maxHoldBars}
            onChange={e => setMaxHoldBars(e.target.value)}
            placeholder="e.g. 20  (off if blank)"
            min={1}
            step={1}
          />
        </div>
        <div style={{ marginBottom: 8 }}>
          <span style={ALGO_LABEL}>Position Size %</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={positionSize}
            onChange={e => setPositionSize(e.target.value)}
            min={5}
            max={100}
            step={5}
          />
        </div>
        <div>
          <span style={ALGO_LABEL}>Initial Capital ($)</span>
          <input
            type="number"
            style={ALGO_INPUT}
            value={initialCapital}
            onChange={e => setInitialCapital(e.target.value)}
            min={100}
            step={1000}
          />
        </div>
      </div>

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
          fontFamily: 'var(--theme-mono)',
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
              fontFamily: 'var(--theme-mono)',
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
          <div style={{ fontSize: 9, color: 'var(--theme-text-dim, rgba(255,255,255,0.2))', letterSpacing: '0.06em' }}>
            Run backtest to compute
          </div>
        )}
      </div>
    </div>
    </RailSection>
  )

  return (
    <SidebarLayout sidebar={sidebar} sidebarTitle="" sidebarWidth={220}>
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
          fontFamily: 'var(--theme-mono)', fontSize: 11, letterSpacing: '0.12em',
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
            <MetricCard
              label="Final Capital"
              value={`$${result.metrics.final_capital >= 1000 ? (result.metrics.final_capital / 1000).toFixed(1) + 'K' : result.metrics.final_capital.toFixed(0)}`}
              deltaPositive={result.metrics.total_pnl >= 0}
            />
            <MetricCard
              label="P&L ($)"
              value={`${result.metrics.total_pnl >= 0 ? '+' : ''}$${Math.abs(result.metrics.total_pnl) >= 1000 ? (result.metrics.total_pnl / 1000).toFixed(1) + 'K' : result.metrics.total_pnl.toFixed(0)}`}
              deltaPositive={result.metrics.total_pnl >= 0}
            />
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
                  fontFamily: 'var(--theme-mono)', fontSize: 9,
                  padding: '2px 6px', cursor: aiCommentaryPending ? 'default' : 'pointer',
                  opacity: aiCommentaryPending ? 0.5 : 1,
                }}
              >{aiCommentaryPending ? '…' : 'Analyze'}</button>
            </div>
            {!aiCommentary && !aiCommentaryPending && (
              <div style={{ padding: '8px 10px', fontSize: 10, color: 'var(--theme-secondary, #5e768f)', fontFamily: 'var(--theme-sans)' }}>
                Click Analyze for AI commentary on these backtest results.
              </div>
            )}
            {aiCommentary && (
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 11, color: 'var(--theme-text, #d7e3fc)', lineHeight: '16px', fontFamily: 'var(--theme-sans)' }}>{aiCommentary.verdict}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { label: 'Strengths', items: aiCommentary.strengths, color: 'var(--theme-positive)' },
                    { label: 'Weaknesses', items: aiCommentary.weaknesses, color: 'var(--theme-negative)' },
                  ].map(({ label, items, color }) => (
                    <div key={label}>
                      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color, textTransform: 'uppercase', marginBottom: 4 }}>{label}</div>
                      {(items ?? []).map((s: string, i: number) => (
                        <div key={i} style={{ fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '14px', paddingLeft: 8, borderLeft: `2px solid ${color}44`, marginBottom: 3, fontFamily: 'var(--theme-sans)' }}>{s}</div>
                      ))}
                    </div>
                  ))}
                </div>
                {Array.isArray(aiCommentary.suggestions) && aiCommentary.suggestions.length > 0 && (
                  <div>
                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color: '#c9a84c', textTransform: 'uppercase', marginBottom: 4 }}>Suggestions</div>
                    {aiCommentary.suggestions.map((s: string, i: number) => (
                      <div key={i} style={{ fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '14px', paddingLeft: 8, borderLeft: '2px solid rgba(201,168,76,0.3)', marginBottom: 3, fontFamily: 'var(--theme-sans)' }}>{s}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <AlgoChartPanel label={`Equity Curve — Strategy vs Buy & Hold (starts $${Number(initialCapital || 10000).toLocaleString()})`} height={350}>
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
                  wrapperStyle={{ fontSize: 9, fontFamily: 'var(--theme-mono)', letterSpacing: '0.08em', paddingTop: 6 }}
                />
                <ReferenceLine y={100} stroke="var(--theme-text-subtle, rgba(255,255,255,0.12))" strokeDasharray="4 2" />
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

          <BacktestSignalChart
            data={priceChartData}
            ticker={ticker.trim().toUpperCase()}
            trades={result.trades}
          />

          <AlgoChartPanel label="Monthly Strategy Returns" height={200}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={monthlyReturns} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={cc.gridLine} />
                <XAxis
                  dataKey="month"
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                  padding={{ left: 0, right: 0 }}
                />
                <YAxis
                  tick={ALGO_TICK}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={v => `${v}%`}
                  width={40}
                  domain={[
                    (dataMin: number) => Math.floor(dataMin * 1.15),
                    (dataMax: number) => Math.ceil(dataMax * 1.15),
                  ]}
                />
                <Tooltip
                  content={<ChartTooltip formatter={(v, _n) => `${(v as number).toFixed(2)}%`} />}
                  contentStyle={TOOLTIP_STYLE}
                  cursor={BAR_CURSOR}
                />
                <ReferenceLine y={0} stroke="var(--theme-secondary, var(--theme-text-faint, rgba(255,255,255,0.15)))" strokeOpacity={0.4} />
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

          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div style={{
              padding: '6px 12px',
              borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
              fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase',
              color: 'var(--theme-text, #d7e3fc)', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>Trade Log</span>
              <span style={{ color: 'var(--theme-secondary, #5e768f)', fontWeight: 400 }}>
                {result.trades.length} trades
              </span>
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--theme-mono)', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
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
                        borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))',
                        background: i % 2 === 0 ? 'transparent' : 'var(--theme-hover, rgba(255,255,255,0.01))',
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
                      <td style={{ padding: '5px 12px', color: 'var(--theme-text, #d7e3fc)' }}>
                        ${trade.price.toFixed(2)}
                      </td>
                    </tr>
                  ))}
                  {result.trades.length === 0 && (
                    <tr>
                      <td colSpan={3} style={{ padding: '16px 12px', color: 'var(--theme-text-dim, rgba(255,255,255,0.2))', textAlign: 'center', fontSize: 10 }}>
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

// ── Backtester page ──────────────────────────────────────────────────────────

export default function PortfolioBacktester() {
  return (
    <PageWrapper title="Portfolio Backtester">
      <PortfolioTab />
    </PageWrapper>
  )
}
