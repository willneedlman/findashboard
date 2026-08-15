import { useState, useEffect, useRef, useMemo } from 'react'
import axios from 'axios'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ComposedChart, Line } from 'recharts'
import PageWrapper from '../../components/PageWrapper'
import HelpTip from '../../components/HelpTip'
import ExpirySelect from '../../components/ExpirySelect'
import { GammaScalpingContent } from '../GammaScalping'
import CustomStrategyModal, { type CustomStrategyDef } from '../../components/CustomStrategyModal'
import { loadCustomStrategies, saveCustomStrategy } from '../../utils/customStrategies'
import { useTheme } from '../../contexts/ThemeContext'
import { buildOCC, parseOCC, isOCC } from '../../lib/occ'
import PaperChart, { type ChartFill } from '../../components/PaperChart'
import { loadActivePortfolio } from '../../components/dashboard/widgets/usePortfolio'
import { EMPTY_LEG, OPTION_STRATEGY_TEMPLATES, type LegState, type StrategyTemplate } from './optionTemplates'
import { useAuth, adaptAccount, T, inp, sel, lbl, btn, sectionHeader, fmt$, fmtDate, statusColor, computeReplayStats, applyRiskToChart, PT_LS_KEY, BUILTIN_STRATEGY_INFO, PAPER_DEFAULT_PARAMS, PAPER_PARAM_LABELS, STRATEGY_TEMPLATE, RISK_DEFAULTS, type Balances, type Position, type Order, type AccountData, type PendingOptionStrategy, type ChartPoint, type StrategyEntry, type ReplayEvent, type ReplayResult, type RiskConfig, type SchedulerStatus, type SchedulerJob, type SchedulerLogEntry } from './shared'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR } from '../../components/ChartTooltip'
import EmptyState from '../../components/EmptyState'

// ─── Ticker chart modal ───────────────────────────────────────────────────────
function TickerChartModal({ ticker, onClose }: { ticker: string; onClose: () => void }) {
  const [history, setHistory] = useState<{ date: string; close: number }[]>([])
  const [loading, setLoading] = useState(true)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    axios.get(`/api/market/history?ticker=${ticker}`)
      .then(r => { if (!cancelled) { setHistory(r.data.data ?? []); setLoading(false) } })
      .catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const slice = history.slice(-252)
  const minV = Math.min(...slice.map(d => d.close))
  const maxV = Math.max(...slice.map(d => d.close))
  const first = slice[0]?.close
  const last  = slice[slice.length - 1]?.close
  const pct   = first ? ((last - first) / first) * 100 : 0
  const up    = pct >= 0

  return (
    <div
      ref={overlayRef}
      onClick={e => { if (e.target === overlayRef.current) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.72)', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div style={{
        width: 640, background: 'var(--theme-bg, #101c2e)',
        border: '1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
          background: 'var(--theme-surface, #142032)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: T.gold }}>{ticker}</span>
            {last != null && (
              <>
                <span style={{ fontFamily: T.mono, fontSize: 13, color: T.text }}>{fmt$(last)}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: up ? T.pos : T.neg }}>
                  {up ? '+' : ''}{pct.toFixed(2)}% (1Y)
                </span>
              </>
            )}
          </div>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', color: T.muted,
            fontFamily: T.mono, fontSize: 16, cursor: 'pointer', padding: '0 4px',
          }}>×</button>
        </div>
        <div style={{ padding: 14, height: 300 }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><EmptyState variant="loading" size="compact" title="Loading equity curve" /></div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={slice} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={up ? 'var(--theme-positive)' : 'var(--theme-negative)'} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={up ? 'var(--theme-positive)' : 'var(--theme-negative)'} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 9, fill: T.muted, fontFamily: T.mono }}
                  tickLine={false} axisLine={false}
                  tickFormatter={d => d.slice(0, 7)}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 9, fill: T.muted, fontFamily: T.mono }}
                  tickLine={false} axisLine={false}
                  tickFormatter={v => `$${v.toFixed(0)}`}
                  domain={[minV * 0.98, maxV * 1.02]}
                  width={52}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  cursor={CROSSHAIR_CURSOR}
                  formatter={(v: number) => [fmt$(v), 'Close']}
                />
                <Area isAnimationActive={false}
                  type="monotone" dataKey="close"
                  stroke={up ? 'var(--theme-positive)' : 'var(--theme-negative)'} strokeWidth={1.5}
                  fill="url(#chartGrad)" dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Positions panel ──────────────────────────────────────────────────────────
export function PositionsPanel({ positions }: { positions: Position[] }) {
  const [quotes, setQuotes] = useState<Record<string, { price: number; pct1d: number | null }>>({})
  const [chartTicker, setChartTicker] = useState<string | null>(null)

  useEffect(() => {
    const syms = [...new Set(positions.map(p => p.symbol))]
    if (syms.length === 0) return
    Promise.all(
      syms.map(sym =>
        axios.get(`/api/market/quote/${sym}`)
          .then(r => [sym, { price: r.data.current_price, pct1d: r.data.pct_change_1d }] as const)
          .catch(() => [sym, null] as const)
      )
    ).then(pairs => {
      const m: Record<string, { price: number; pct1d: number | null }> = {}
      for (const [sym, q] of pairs) if (q) m[sym] = q
      setQuotes(m)
    })
  }, [positions])

  const th: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' as const,
    color: T.muted, padding: '7px 10px', textAlign: 'left' as const,
    borderBottom: `1px solid ${T.border}`, fontFamily: T.mono, whiteSpace: 'nowrap' as const,
  }
  const td: React.CSSProperties = {
    padding: '8px 10px', fontSize: 12, fontFamily: T.mono,
    color: T.text, borderBottom: `1px solid var(--theme-hover, rgba(255,255,255,0.04))`,
  }

  return (
    <>
      {chartTicker && <TickerChartModal ticker={chartTicker} onClose={() => setChartTicker(null)} />}
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {sectionHeader('POSITIONS', positions.length)}
        {positions.length === 0 ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: T.dim, fontFamily: T.mono, fontSize: 12,
          }}>
            No open positions
          </div>
        ) : (
          <div style={{ overflowX: 'auto', flex: 1 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Symbol</th>
                  <th style={{ ...th, textAlign: 'right' as const }}>Qty</th>
                  <th style={{ ...th, textAlign: 'right' as const }}>Cost / Share</th>
                  <th style={{ ...th, textAlign: 'right' as const }}>Last</th>
                  <th style={{ ...th, textAlign: 'right' as const }}>Unr. P&amp;L $</th>
                  <th style={{ ...th, textAlign: 'right' as const }}>Unr. P&amp;L %</th>
                  <th style={{ ...th, textAlign: 'right' as const }}>1D %</th>
                  <th style={{ ...th, textAlign: 'right' as const }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => {
                  const q = quotes[p.symbol]
                  const costPerShare = p.quantity ? p.cost_basis / p.quantity : 0
                  // Futures P&L is leveraged by the contract multiplier, and the %
                  // is return on posted margin (a 1% move on ~10x reads ~10%).
                  // Equities have multiplier 1 and show the raw price-move %.
                  const mult = p.multiplier || 1
                  const unrealized = q ? (q.price - costPerShare) * mult * p.quantity : null
                  const unrealizedPct = unrealized != null && p.margin
                    ? (unrealized / p.margin) * 100
                    : q && costPerShare ? (q.price / costPerShare - 1) * 100 : null
                  return (
                    <tr key={i}
                      onClick={() => setChartTicker(p.symbol)}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--theme-primary) 6%, transparent)'; (e.currentTarget as HTMLElement).style.cursor = 'pointer' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; (e.currentTarget as HTMLElement).style.cursor = 'default' }}
                      style={{ transition: 'background 0.1s' }}
                    >
                      <td style={{ ...td, color: T.gold, fontWeight: 700 }}>{p.symbol}</td>
                      <td style={{ ...td, textAlign: 'right' as const }}>{p.quantity}</td>
                      <td style={{ ...td, textAlign: 'right' as const, color: T.muted }}>{fmt$(costPerShare)}</td>
                      <td style={{ ...td, textAlign: 'right' as const }}>
                        {q ? fmt$(q.price) : <span style={{ color: T.dim }}>…</span>}
                      </td>
                      <td style={{ ...td, textAlign: 'right' as const }}>
                        {unrealized != null ? (
                          <span style={{ color: unrealized >= 0 ? T.pos : T.neg }}>
                            {unrealized >= 0 ? '+' : ''}{fmt$(unrealized)}
                          </span>
                        ) : <span style={{ color: T.dim }}>…</span>}
                      </td>
                      <td style={{ ...td, textAlign: 'right' as const }}>
                        {unrealizedPct != null ? (
                          <span style={{ color: unrealizedPct >= 0 ? T.pos : T.neg }}>
                            {unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(2)}%
                          </span>
                        ) : <span style={{ color: T.dim }}>…</span>}
                      </td>
                      <td style={{ ...td, textAlign: 'right' as const }}>
                        {q?.pct1d != null ? (
                          <span style={{ color: q.pct1d >= 0 ? T.pos : T.neg }}>
                            {q.pct1d >= 0 ? '+' : ''}{q.pct1d.toFixed(2)}%
                          </span>
                        ) : <span style={{ color: T.dim }}>—</span>}
                      </td>
                      <td style={{ ...td, textAlign: 'right' as const, color: T.dim, fontSize: 10 }}>
                        {fmtDate(p.date_acquired)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}

// ─── Orders panel ─────────────────────────────────────────────────────────────
export function OrdersPanel({ orders, onCancel, onCancelAll, cancelAllPending, cancelAllError, automatedOrders, initialStatus }: {
  orders: Order[]
  onCancel: (id: string) => void
  onCancelAll: () => void
  cancelAllPending?: boolean
  cancelAllError?: boolean
  automatedOrders?: Record<string, string>
  initialStatus?: 'all'|'filled'|'pending'|'rejected'|'canceled'
}) {
  const [statusF, setStatusF] = useState<'all'|'filled'|'pending'|'rejected'|'canceled'>(initialStatus ?? 'all')
  const [sideF,   setSideF]   = useState<'all'|'buy'|'sell'>('all')

  const isPending = (status: string) =>
    ['pending', 'open', 'partially_filled'].includes(status?.toLowerCase())

  const pendingOrders = orders.filter(o => isPending(o.status))

  const filtered = orders.filter(o => {
    const s    = o.status?.toLowerCase() ?? ''
    const side = o.side?.toLowerCase()   ?? ''
    if (statusF === 'filled'   && s !== 'filled') return false
    if (statusF === 'pending'  && !isPending(o.status)) return false
    if (statusF === 'rejected' && s !== 'rejected') return false
    if (statusF === 'canceled' && !['canceled','cancelled','expired'].includes(s)) return false
    if (sideF   === 'buy'  && !side.startsWith('buy')  && side !== 'buy')  return false
    if (sideF   === 'sell' && !side.startsWith('sell') && side !== 'sell') return false
    return true
  })

  const pill = (active: boolean, label: string, onClick: () => void, color?: string) => (
    <button
      onClick={onClick}
      style={{
        padding: '2px 6px', fontSize: 8, fontFamily: T.mono, fontWeight: 700,
        letterSpacing: '0.07em', cursor: 'pointer',
        border: `1px solid ${active ? (color ?? T.gold) : T.border}`,
        background: active ? `color-mix(in srgb, ${color ?? T.gold} 14%, transparent)` : 'transparent',
        color: active ? (color ?? T.gold) : T.dim,
        transition: 'background 0.1s var(--ease-out), border-color 0.1s var(--ease-out), color 0.1s var(--ease-out)',
      }}
    >{label}</button>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {sectionHeader('ORDERS & HISTORY', orders.length)}
        {pendingOrders.length > 0 && (
          <button
            onClick={onCancelAll}
            disabled={cancelAllPending}
            style={{
              margin: '0 10px 0 0', padding: '3px 8px', fontSize: 9, fontFamily: T.mono, fontWeight: 700,
              cursor: cancelAllPending ? 'wait' : 'pointer', letterSpacing: '0.08em',
              background: cancelAllError ? 'color-mix(in srgb, var(--theme-negative) 20%, transparent)' : 'color-mix(in srgb, var(--theme-negative) 10%, transparent)',
              border: `1px solid rgba(239,68,68,${cancelAllError ? '0.7' : '0.4'})`, color: T.neg,
              opacity: cancelAllPending ? 0.6 : 1,
            }}
          >
            {cancelAllPending ? 'Cancelling…' : cancelAllError ? 'Failed — retry' : `Cancel All (${pendingOrders.length})`}
          </button>
        )}
      </div>

      {/* Filter bar */}
      <div style={{ padding: '6px 10px', borderBottom: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {pill(statusF === 'all',      'ALL',      () => setStatusF('all'))}
          {pill(statusF === 'filled',   'FILLED',   () => setStatusF('filled'),   T.pos)}
          {pill(statusF === 'pending',  'PENDING',  () => setStatusF('pending'),  T.gold)}
          {pill(statusF === 'rejected', 'REJECTED', () => setStatusF('rejected'), T.neg)}
          {pill(statusF === 'canceled', 'CANCELED', () => setStatusF('canceled'), T.muted)}
        </div>
        <div style={{ display: 'flex', gap: 3 }}>
          {pill(sideF === 'all',  'ALL',  () => setSideF('all'))}
          {pill(sideF === 'buy',  'BUY',  () => setSideF('buy'),  T.pos)}
          {pill(sideF === 'sell', 'SELL', () => setSideF('sell'), T.neg)}
        </div>
      </div>

      {orders.length === 0 ? (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: T.dim, fontFamily: T.mono, fontSize: 12, flexDirection: 'column', gap: 6,
        }}>
          
          No orders yet
        </div>
      ) : filtered.length === 0 ? (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: T.dim, fontFamily: T.mono, fontSize: 11,
        }}>
          No orders match filters
        </div>
      ) : (
        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map(o => {
            const stratName = automatedOrders?.[o.id]
            return (
              <div key={o.id} style={{
                background: T.bg,
                border: `1px solid ${stratName ? 'rgba(167,139,250,0.28)' : T.border}`,
                padding: '9px 10px',
                position: 'relative',
              }}>
                {/* Symbol + automated badge + cancel */}
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 5 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.gold }}>{o.symbol}</span>
                    {stratName && (
                      <span style={{
                        fontSize: 8, fontWeight: 700, padding: '1px 5px',
                        background: 'rgba(167,139,250,0.12)', color: '#a78bfa',
                        border: '1px solid rgba(167,139,250,0.38)', fontFamily: T.mono,
                        letterSpacing: '0.07em', whiteSpace: 'nowrap',
                      }}>{stratName}</span>
                    )}
                  </div>
                  {isPending(o.status) && (
                    <button
                      onClick={() => onCancel(o.id)}
                      title="Cancel order"
                      style={{
                        background: 'none', border: `1px solid color-mix(in srgb, var(--theme-negative) 35%, transparent)`,
                        color: T.neg, cursor: 'pointer', fontSize: 11, lineHeight: 1,
                        padding: '2px 6px', fontFamily: T.mono, flexShrink: 0,
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>

                {/* Side / qty / price */}
                <div style={{ fontFamily: T.mono, fontSize: 11, color: T.text, marginBottom: 5 }}>
                  {o.side} {o.quantity}
                  {o.avg_fill_price
                    ? <span style={{ color: T.pos }}> @ {fmt$(o.avg_fill_price)}</span>
                    : o.price
                      ? <span style={{ color: T.muted }}> @ {fmt$(o.price)}</span>
                      : <span style={{ color: T.dim }}> @ MKT</span>
                  }
                </div>

                {/* Status + date */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
                    color: statusColor(o.status), fontFamily: T.mono,
                    textTransform: 'uppercase' as const,
                  }}>
                    {o.status}
                  </span>
                  <span style={{ fontSize: 9, color: T.dim, fontFamily: T.mono }}>{fmtDate(o.create_date)}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
