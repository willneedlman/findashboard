import { useMemo, useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { loadActivePortfolio, priceHoldings, useQuotes } from './usePortfolio'
import { useWidgetContentState } from '../widgetContentState'

const T = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))', headerBg: 'var(--theme-surface, #0d1826)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #8099b0)', dim: '#3a4d62',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
  pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)', warn: '#f59e0b', blue: '#60a5fa',
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, var(--theme-border-faint, var(--theme-border-faint, rgba(255,255,255,0.05))) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 3,
}

const PERIODS = [
  { label: '1Y', start: () => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().split('T')[0] } },
  { label: '3Y', start: () => { const d = new Date(); d.setFullYear(d.getFullYear() - 3); return d.toISOString().split('T')[0] } },
  { label: '5Y', start: () => { const d = new Date(); d.setFullYear(d.getFullYear() - 5); return d.toISOString().split('T')[0] } },
  { label: 'YTD', start: () => `${new Date().getFullYear()}-01-01` },
  { label: 'All', start: () => '2000-01-01' },
]

interface PortfolioMetrics {
  port_cagr: number; bench_cagr: number; port_sharpe: number
  port_vol: number; max_drawdown: number; beta: number
  sortino: number; calmar: number
}
interface CumulativePoint { date: string; portfolio: number; benchmark: number }
interface BacktestResult {
  metrics: PortfolioMetrics
  cumulative: CumulativePoint[]
  rolling_beta: { date: string; value: number }[]
}

function MetricCell({ label, value, valueColor, sub }: { label: string; value: string; valueColor?: string; sub?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 8px', background: T.headerBg, border: `1px solid ${T.border}` }}>
      <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: valueColor ?? T.text }}>{value}</span>
      {sub && <span style={{ fontFamily: T.label, fontSize: 8, color: T.muted }}>{sub}</span>}
    </div>
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ background: T.headerBg, border: `1px solid ${T.border}`, padding: '6px 10px', fontFamily: T.mono, fontSize: 10 }}>
      <div style={{ color: T.muted, marginBottom: 4 }}>{label}</div>
      {payload.map((p: { name: string; value: number; color: string }) => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: {p.value.toFixed(2)}
        </div>
      ))}
    </div>
  )
}

export default function PortfolioSummary({ config }: { config: WidgetConfig }) {
  const portfolio = useMemo(() => loadActivePortfolio(config.portfolioId), [config.portfolioId])
  const tickers = portfolio.holdings.map(holding => holding.ticker)
  const quotes = useQuotes(tickers)
  const priced = priceHoldings(portfolio.holdings, quotes)
  const equityValue = priced.reduce((sum, position) => sum + position.value, 0)
  const totalValue = equityValue + portfolio.cash
  const weights = priced.map(position => totalValue > 0 ? position.value / totalValue : 0)
  const cashWeight = totalValue > 0 ? portfolio.cash / totalValue : 0

  const [periodIdx, setPeriodIdx] = useState(0)
  const [legendOpen, setLegendOpen] = useState(true)
  const activeChart = (config.chartMode as 'cumulative' | 'beta') ?? 'cumulative'

  const today = new Date().toISOString().split('T')[0]
  const startDate = PERIODS[periodIdx].start()

  const { data, isLoading, isError } = useQuery<BacktestResult>({
    queryKey: ['portfolio-summary-v3', tickers.join(','), weights.map(weight => weight.toFixed(6)).join(','), cashWeight.toFixed(6), startDate],
    queryFn: () => axios.post('/api/portfolio/backtest', { tickers, weights, cash_weight: cashWeight, benchmark: 'SPY', start: startDate, end: today }).then(r => r.data),
    staleTime: 300_000,
    enabled: tickers.length >= 1 && totalValue > 0,
    retry: 1,
  })
  useWidgetContentState(config.id, !tickers.length ? 'empty' : isLoading ? 'loading' : isError ? 'error' : data ? 'ready' : 'empty')

  const base: React.CSSProperties = {
    background: T.bg, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: T.mono,
  }

  if (!tickers.length) {
    return (
      <div style={base}>
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: T.muted, fontFamily: T.label, fontSize: 11 }}>
          Add holdings in Portfolio Manager.
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div style={base}>
        <div style={{ padding: '6px 12px', background: T.headerBg, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold }}>{portfolio.name.toUpperCase() || 'PORTFOLIO'}</span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: T.neg, fontFamily: T.label, fontSize: 11 }}>Data unavailable. Check tickers or try a shorter period.</span>
        </div>
      </div>
    )
  }

  if (isLoading || !data) {
    return (
      <div style={base}>
        <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
        <div style={{ padding: '6px 12px', background: T.headerBg, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold }}>{portfolio.name.toUpperCase() || 'PORTFOLIO'}</span>
        </div>
        <div style={{ flex: '0 1 auto', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, padding: 8 }}>
          {Array.from({ length: 8 }).map((_, i) => <div key={i} style={{ ...shimmer, height: 44 }} />)}
        </div>
        <div style={{ flex: 1, margin: '0 8px 8px', ...shimmer }} />
      </div>
    )
  }

  const { port_cagr, bench_cagr, port_sharpe, port_vol, max_drawdown, beta, sortino, calmar } = data.metrics
  const alpha = port_cagr - bench_cagr

  // Thin the cumulative series for rendering performance
  const cumData = data.cumulative.filter((_, i, a) => i === 0 || i === a.length - 1 || i % Math.max(1, Math.floor(a.length / 200)) === 0)
  const betaData = data.rolling_beta?.filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 200)) === 0) ?? []

  // Tick labels: show ~6 evenly spaced
  const tickInterval = Math.max(1, Math.floor(cumData.length / 6))

  return (
    <div style={base}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Allocation bar */}
      <div style={{ borderBottom: `1px solid ${T.border}`, background: 'var(--theme-bg, #080f1d)', flexShrink: 0 }}>
        <div onClick={() => setLegendOpen(o => !o)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '3px 8px', cursor: 'pointer', userSelect: 'none' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {tickers.map((tk, i) => (
              <span key={tk} style={{ fontFamily: T.label, fontSize: 9, color: T.text }}>
                <span style={{ color: T.gold }}>{tk}</span>
                <span style={{ color: T.dim }}> {(weights[i] * 100).toFixed(0)}%</span>
              </span>
            ))}
            {cashWeight > 0 && (
              <span style={{ fontFamily: T.label, fontSize: 9, color: T.text }}>
                <span style={{ color: T.gold }}>CASH</span>
                <span style={{ color: T.dim }}> {(cashWeight * 100).toFixed(0)}%</span>
              </span>
            )}
          </div>
          <span style={{ color: T.dim, fontSize: 9, fontFamily: T.mono, transition: 'transform 0.15s', display: 'inline-block', transform: legendOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▾</span>
        </div>
        {legendOpen && (
          <div style={{ padding: '0 8px 4px', display: 'flex', gap: 2 }}>
            {tickers.map((tk, i) => (
              <div key={tk} title={`${tk} ${(weights[i] * 100).toFixed(1)}%`} style={{ height: 4, background: T.gold, opacity: 0.4 + weights[i] * 0.6, flex: weights[i] }} />
            ))}
            {cashWeight > 0 && <div title={`Cash ${(cashWeight * 100).toFixed(1)}%`} style={{ height: 4, background: T.muted, flex: cashWeight }} />}
          </div>
        )}
      </div>

      {/* Metrics grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, padding: '6px 8px', flex: '0 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <MetricCell label="CAGR" value={`${port_cagr >= 0 ? '+' : ''}${port_cagr.toFixed(1)}%`} valueColor={port_cagr >= bench_cagr ? T.pos : T.neg} sub={`SPY ${bench_cagr.toFixed(1)}%`} />
        <MetricCell label="α Alpha" value={`${alpha >= 0 ? '+' : ''}${alpha.toFixed(1)}%`} valueColor={alpha >= 0 ? T.pos : T.neg} />
        <MetricCell label="Sharpe" value={port_sharpe.toFixed(2)} valueColor={port_sharpe >= 1 ? T.pos : port_sharpe >= 0.5 ? T.warn : T.neg} />
        <MetricCell label="Sortino" value={sortino.toFixed(2)} valueColor={sortino >= 1.5 ? T.pos : sortino >= 0.8 ? T.warn : T.neg} />
        <MetricCell label="Max DD" value={`${max_drawdown.toFixed(1)}%`} valueColor={T.neg} />
        <MetricCell label="Calmar" value={calmar.toFixed(2)} valueColor={calmar >= 0.5 ? T.pos : T.warn} />
        <MetricCell label="Vol" value={`${port_vol.toFixed(1)}%`} />
        <MetricCell label="Beta" value={beta.toFixed(2)} valueColor={Math.abs(beta - 1) < 0.15 ? T.text : beta > 1.3 ? T.warn : T.pos} />
      </div>

      {/* Chart */}
      <div style={{ flex: 1, minHeight: 0, padding: '0 4px 6px' }}>
        <ResponsiveContainer width="100%" height="100%">
          {activeChart === 'cumulative' ? (
            <AreaChart data={cumData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={T.gold} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={T.gold} stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={T.muted} stopOpacity={0.2} />
                  <stop offset="95%" stopColor={T.muted} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="rgba(46,57,77,0.35)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }} tickLine={false} axisLine={false} interval={tickInterval} />
              <YAxis tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }} tickLine={false} axisLine={false} tickFormatter={v => `${v.toFixed(0)}`} width={32} />
              <Tooltip content={<ChartTooltip />} />
              <ReferenceLine y={100} stroke="var(--theme-text-subtle, rgba(215,227,252,0.15))" strokeDasharray="3 4" />
              <Area type="monotone" dataKey="benchmark" name="SPY" stroke={T.muted} strokeWidth={1} fill="url(#bg)" dot={false} isAnimationActive={false} />
              <Area type="monotone" dataKey="portfolio" name="Port" stroke={T.gold} strokeWidth={1.5} fill="url(#pg)" dot={false} isAnimationActive={false} />
            </AreaChart>
          ) : (
            <LineChart data={betaData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="rgba(46,57,77,0.35)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }} tickLine={false} axisLine={false} interval={Math.max(1, Math.floor(betaData.length / 6))} />
              <YAxis tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }} tickLine={false} axisLine={false} width={32} />
              <Tooltip content={<ChartTooltip />} />
              <ReferenceLine y={1} stroke="var(--theme-text-subtle, rgba(215,227,252,0.2))" strokeDasharray="3 4" label={{ value: 'β=1', position: 'insideTopRight', fontSize: 8, fill: T.dim, fontFamily: T.label }} />
              <Line type="monotone" dataKey="value" name="β" stroke={T.blue} strokeWidth={1.5} dot={false} isAnimationActive={false} />
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  )
}
