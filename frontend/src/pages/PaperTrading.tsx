import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import HelpTip from '../components/HelpTip'

// ─── Theme tokens ────────────────────────────────────────────────────────────
const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #142032)',
  border:  'rgba(255,255,255,0.08)',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    '#d7e3fc',
  mono:    'JetBrains Mono, monospace',
  pos:     '#22c55e',
  neg:     '#ef4444',
  orange:  '#f97316',
  dim:     'rgba(215,227,252,0.35)',
}

// ─── Shared element styles ────────────────────────────────────────────────────
const inp: React.CSSProperties = {
  background: T.bg,
  border: `1px solid ${T.border}`,
  color: T.text,
  fontFamily: T.mono,
  fontSize: 12,
  padding: '6px 9px',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
}

const sel: React.CSSProperties = {
  ...inp,
  cursor: 'pointer',
  appearance: 'none',
  WebkitAppearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235e768f'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 8px center',
  paddingRight: 26,
}

const lbl: React.CSSProperties = {
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: '0.13em',
  textTransform: 'uppercase' as const,
  color: T.muted,
  display: 'block',
  marginBottom: 4,
  fontFamily: T.mono,
}

const sectionHeader = (label: string, badge?: string | number): React.ReactNode => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 12px',
    borderBottom: `1px solid ${T.border}`,
    background: T.surface,
  }}>
    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', color: T.gold, fontFamily: T.mono }}>
      {label}
    </span>
    {badge !== undefined && (
      <span style={{
        fontSize: 9, fontWeight: 700, padding: '1px 6px',
        background: 'rgba(201,168,76,0.15)', color: T.gold,
        border: `1px solid rgba(201,168,76,0.3)`,
        fontFamily: T.mono,
      }}>
        {badge}
      </span>
    )}
  </div>
)

// ─── Types ────────────────────────────────────────────────────────────────────
interface Balances {
  cash: number
  market_value: number
  equity: number
  buying_power: number
  total_equity: number
  day_change: number
}

interface Position {
  symbol: string
  quantity: number
  cost_basis: number
  date_acquired: string
}

interface Order {
  id: string
  type: string
  symbol: string
  side: string
  quantity: number
  status: string
  price?: number
  avg_fill_price?: number
  create_date: string
}

interface AccountData {
  balances: Balances
  positions: Position[]
  orders: Order[]
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt$(v: number | null | undefined) {
  if (v == null || isNaN(v as number)) return '—'
  return (v as number).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
}

function fmtDate(s: string) {
  if (!s) return '—'
  try { return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) }
  catch { return s }
}

function statusColor(status: string) {
  switch (status?.toLowerCase()) {
    case 'filled':    return T.pos
    case 'pending':
    case 'open':
    case 'partially_filled': return T.gold
    case 'canceled':
    case 'cancelled':
    case 'expired':   return T.dim
    case 'rejected':  return T.neg
    default:          return T.muted
  }
}

// ─── Multi-leg leg row ────────────────────────────────────────────────────────
interface LegState { symbol: string; side: string; qty: string }
const EMPTY_LEG: LegState = { symbol: '', side: 'buy_to_open', qty: '1' }

function LegRow({
  index, leg, onChange, onRemove, canRemove,
}: {
  index: number
  leg: LegState
  onChange: (l: LegState) => void
  onRemove: () => void
  canRemove: boolean
}) {
  return (
    <div style={{ border: `1px solid ${T.border}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ ...lbl, marginBottom: 0, color: T.gold }}>LEG {index + 1}</span>
        {canRemove && (
          <button onClick={onRemove} style={{
            background: 'none', border: 'none', color: T.neg, cursor: 'pointer',
            fontSize: 14, lineHeight: 1, padding: '0 2px',
          }}>×</button>
        )}
      </div>
      <div>
        <span style={lbl}>OCC Symbol</span>
        <input style={inp} value={leg.symbol}
          onChange={e => onChange({ ...leg, symbol: e.target.value })}
          placeholder="SPY250117C00580000" />
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 2 }}>
          <span style={lbl}>Side</span>
          <select style={sel} value={leg.side} onChange={e => onChange({ ...leg, side: e.target.value })}>
            <option value="buy_to_open">buy_to_open</option>
            <option value="sell_to_open">sell_to_open</option>
            <option value="buy_to_close">buy_to_close</option>
            <option value="sell_to_close">sell_to_close</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <span style={lbl}>Qty</span>
          <input style={inp} type="number" min="1" value={leg.qty}
            onChange={e => onChange({ ...leg, qty: e.target.value })} placeholder="1" />
        </div>
      </div>
    </div>
  )
}

// ─── Order Ticket ─────────────────────────────────────────────────────────────
function OrderTicket({ onOrderPlaced }: { onOrderPlaced: () => void }) {
  const [tab, setTab] = useState<'equity' | 'option' | 'multileg'>('equity')

  // Equity state
  const [eqSymbol, setEqSymbol]   = useState('')
  const [eqSide, setEqSide]       = useState<'buy' | 'sell'>('buy')
  const [eqQty, setEqQty]         = useState('')
  const [eqType, setEqType]       = useState('market')
  const [eqPrice, setEqPrice]     = useState('')
  const [eqDur, setEqDur]         = useState('day')

  // Option state
  const [opUnderlying, setOpUnderlying] = useState('')
  const [opSymbol, setOpSymbol]         = useState('')
  const [opSide, setOpSide]             = useState('buy_to_open')
  const [opQty, setOpQty]               = useState('')
  const [opType, setOpType]             = useState('market')
  const [opPrice, setOpPrice]           = useState('')
  const [opDur, setOpDur]               = useState('day')

  // Multi-leg state
  const [mlUnderlying, setMlUnderlying] = useState('')
  const [mlLegs, setMlLegs]             = useState<LegState[]>([{ ...EMPTY_LEG }, { ...EMPTY_LEG }])
  const [mlType, setMlType]             = useState('debit')
  const [mlPrice, setMlPrice]           = useState('')
  const [mlDur, setMlDur]               = useState('day')

  // Feedback
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  function showFeedback(ok: boolean, msg: string) {
    setFeedback({ ok, msg })
    setTimeout(() => setFeedback(null), 3500)
  }

  const eqMutation = useMutation({
    mutationFn: (body: object) => axios.post('/api/trading/order/equity', body).then(r => r.data),
    onSuccess: () => {
      showFeedback(true, 'Order placed successfully')
      setEqSymbol(''); setEqQty(''); setEqPrice('')
      onOrderPlaced()
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Order failed'
      showFeedback(false, msg)
    },
  })

  const opMutation = useMutation({
    mutationFn: (body: object) => axios.post('/api/trading/order/option', body).then(r => r.data),
    onSuccess: () => {
      showFeedback(true, 'Option order placed')
      setOpUnderlying(''); setOpSymbol(''); setOpQty(''); setOpPrice('')
      onOrderPlaced()
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Order failed'
      showFeedback(false, msg)
    },
  })

  const mlMutation = useMutation({
    mutationFn: (body: object) => axios.post('/api/trading/order/multileg', body).then(r => r.data),
    onSuccess: () => {
      showFeedback(true, 'Multi-leg order placed')
      setMlUnderlying(''); setMlLegs([{ ...EMPTY_LEG }, { ...EMPTY_LEG }]); setMlPrice('')
      onOrderPlaced()
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Order failed'
      showFeedback(false, msg)
    },
  })

  function handleEquitySubmit() {
    if (!eqSymbol || !eqQty) return
    eqMutation.mutate({
      symbol: eqSymbol.toUpperCase(),
      side: eqSide,
      quantity: parseInt(eqQty),
      order_type: eqType,
      price: (eqType !== 'market' && eqPrice) ? parseFloat(eqPrice) : null,
      duration: eqDur,
    })
  }

  function handleOptionSubmit() {
    if (!opUnderlying || !opSymbol || !opQty) return
    opMutation.mutate({
      symbol: opUnderlying.toUpperCase(),
      option_symbol: opSymbol,
      side: opSide,
      quantity: parseInt(opQty),
      order_type: opType,
      price: (opType === 'limit' && opPrice) ? parseFloat(opPrice) : null,
      duration: opDur,
    })
  }

  function handleMultilegSubmit() {
    const validLegs = mlLegs.filter(l => l.symbol.trim() && l.qty)
    if (!mlUnderlying || validLegs.length < 2) return
    mlMutation.mutate({
      symbol: mlUnderlying.toUpperCase(),
      legs: validLegs.map(l => ({
        option_symbol: l.symbol.trim(),
        side: l.side,
        quantity: parseInt(l.qty),
      })),
      order_type: mlType,
      price: (mlType !== 'market' && mlPrice) ? parseFloat(mlPrice) : null,
      duration: mlDur,
    })
  }

  const tabBtn = (id: 'equity' | 'option' | 'multileg', label: string) => (
    <button
      onClick={() => setTab(id)}
      style={{
        flex: 1, padding: '7px 0', fontFamily: T.mono, fontSize: 9, fontWeight: 700,
        letterSpacing: '0.10em', cursor: 'pointer', border: 'none',
        background: tab === id ? T.gold : 'transparent',
        color: tab === id ? '#0d1826' : T.muted,
        transition: 'all 0.15s',
      }}
    >
      {label}
    </button>
  )

  const toggleBtn = (active: boolean, label: string, onClick: () => void, activeColor = T.gold) => (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '6px 0', fontFamily: T.mono, fontSize: 10, fontWeight: 700,
        letterSpacing: '0.1em', cursor: 'pointer',
        border: `1px solid ${active ? activeColor : T.border}`,
        background: active ? `${activeColor}22` : 'transparent',
        color: active ? activeColor : T.dim,
        transition: 'all 0.12s',
      }}
    >
      {label}
    </button>
  )

  const isPending = eqMutation.isPending || opMutation.isPending || mlMutation.isPending
  const mlValidLegs = mlLegs.filter(l => l.symbol.trim() && l.qty)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {sectionHeader('ORDER TICKET')}

      {/* Tab bar */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}` }}>
        {tabBtn('equity', 'EQUITY / ETF')}
        {tabBtn('option', 'OPTION')}
        {tabBtn('multileg', 'MULTI-LEG')}
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto', flex: 1 }}>
        {tab === 'equity' && (
          <>
            <div>
              <span style={lbl}>Symbol — stock or ETF</span>
              <input
                style={inp}
                value={eqSymbol}
                onChange={e => setEqSymbol(e.target.value.toUpperCase())}
                placeholder="AAPL · SPY · QQQ · IWM"
                maxLength={10}
              />
            </div>

            <div>
              <span style={lbl}>Side</span>
              <div style={{ display: 'flex', gap: 6 }}>
                {toggleBtn(eqSide === 'buy', 'BUY', () => setEqSide('buy'), T.pos)}
                {toggleBtn(eqSide === 'sell', 'SELL', () => setEqSide('sell'), T.neg)}
              </div>
            </div>

            <div>
              <span style={lbl}>Quantity</span>
              <input style={inp} type="number" min="1" value={eqQty}
                onChange={e => setEqQty(e.target.value)} placeholder="100" />
            </div>

            <div>
              <span style={lbl}>Order Type</span>
              <select style={sel} value={eqType} onChange={e => setEqType(e.target.value)}>
                <option value="market">MARKET</option>
                <option value="limit">LIMIT</option>
                <option value="stop">STOP</option>
                <option value="stop_limit">STOP LIMIT</option>
              </select>
            </div>

            {(eqType === 'limit' || eqType === 'stop' || eqType === 'stop_limit') && (
              <div>
                <span style={lbl}>Price</span>
                <input style={inp} type="number" min="0" step="0.01" value={eqPrice}
                  onChange={e => setEqPrice(e.target.value)} placeholder="0.00" />
              </div>
            )}

            <div>
              <span style={lbl}>Duration</span>
              <select style={sel} value={eqDur} onChange={e => setEqDur(e.target.value)}>
                <option value="day">DAY</option>
                <option value="gtc">GTC</option>
                <option value="pre">PRE-MARKET</option>
                <option value="post">POST-MARKET</option>
                <option value="all">ALL SESSIONS</option>
              </select>
            </div>

            <button
              onClick={handleEquitySubmit}
              disabled={isPending || !eqSymbol || !eqQty}
              style={{
                width: '100%', padding: '9px 0', fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                letterSpacing: '0.12em', cursor: isPending ? 'wait' : 'pointer',
                border: 'none',
                background: eqSide === 'buy' ? T.gold : T.neg,
                color: eqSide === 'buy' ? '#0d1826' : '#fff',
                opacity: (!eqSymbol || !eqQty) ? 0.45 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {isPending ? 'PLACING…' : `PLACE ${eqSide.toUpperCase()} ORDER`}
            </button>
          </>
        )}

        {tab === 'option' && (
          <>
            <div>
              <span style={lbl}>Underlying</span>
              <input
                style={inp}
                value={opUnderlying}
                onChange={e => setOpUnderlying(e.target.value.toUpperCase())}
                placeholder="SPY"
                maxLength={10}
              />
            </div>

            <div>
              <span style={lbl}>
                Option Symbol (OCC)
                <HelpTip text="OCC format: ROOT + YYMMDD + C/P + 8-digit strike padded to 3 decimals. Example: SPY250117C00580000 = SPY, Jan 17 2025, Call, $580 strike. Find the symbol in the Chain Scanner." position="right" width={250} />
              </span>
              <input
                style={inp}
                value={opSymbol}
                onChange={e => setOpSymbol(e.target.value)}
                placeholder="SPY250117C00580000"
              />
              <span style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, marginTop: 3, display: 'block' }}>
                ROOT + YYMMDD + C/P + 8-digit strike×1000
              </span>
            </div>

            <div>
              <span style={lbl}>
                Side
                <HelpTip text="buy_to_open: initiates a new long position. sell_to_open: initiates a short (writes the option). buy_to_close / sell_to_close: closes an existing position." position="right" width={230} />
              </span>
              <select style={sel} value={opSide} onChange={e => setOpSide(e.target.value)}>
                <option value="buy_to_open">buy_to_open</option>
                <option value="sell_to_open">sell_to_open</option>
                <option value="buy_to_close">buy_to_close</option>
                <option value="sell_to_close">sell_to_close</option>
              </select>
            </div>

            <div>
              <span style={lbl}>Quantity (contracts)</span>
              <input style={inp} type="number" min="1" value={opQty}
                onChange={e => setOpQty(e.target.value)} placeholder="1" />
            </div>

            <div>
              <span style={lbl}>Order Type</span>
              <select style={sel} value={opType} onChange={e => setOpType(e.target.value)}>
                <option value="market">MARKET</option>
                <option value="limit">LIMIT</option>
              </select>
            </div>

            {opType === 'limit' && (
              <div>
                <span style={lbl}>Limit Price</span>
                <input style={inp} type="number" min="0" step="0.01" value={opPrice}
                  onChange={e => setOpPrice(e.target.value)} placeholder="0.00" />
              </div>
            )}

            <div>
              <span style={lbl}>Duration</span>
              <select style={sel} value={opDur} onChange={e => setOpDur(e.target.value)}>
                <option value="day">DAY</option>
                <option value="gtc">GTC</option>
              </select>
            </div>

            <button
              onClick={handleOptionSubmit}
              disabled={isPending || !opUnderlying || !opSymbol || !opQty}
              style={{
                width: '100%', padding: '9px 0', fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                letterSpacing: '0.12em', cursor: isPending ? 'wait' : 'pointer',
                border: 'none',
                background: opSide.startsWith('buy') ? T.gold : T.neg,
                color: opSide.startsWith('buy') ? '#0d1826' : '#fff',
                opacity: (!opUnderlying || !opSymbol || !opQty) ? 0.45 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {isPending ? 'PLACING…' : 'PLACE OPTION ORDER'}
            </button>
          </>
        )}

        {tab === 'multileg' && (
          <>
            <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, lineHeight: '14px' }}>
              2–4 legs. Use for spreads, straddles, strangles, condors, and combos.
            </div>

            <div>
              <span style={lbl}>Underlying</span>
              <input
                style={inp}
                value={mlUnderlying}
                onChange={e => setMlUnderlying(e.target.value.toUpperCase())}
                placeholder="SPY"
                maxLength={10}
              />
            </div>

            {/* Leg rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {mlLegs.map((leg, i) => (
                <LegRow
                  key={i}
                  index={i}
                  leg={leg}
                  onChange={updated => setMlLegs(prev => prev.map((l, j) => j === i ? updated : l))}
                  onRemove={() => setMlLegs(prev => prev.filter((_, j) => j !== i))}
                  canRemove={mlLegs.length > 2}
                />
              ))}
            </div>

            {mlLegs.length < 4 && (
              <button
                onClick={() => setMlLegs(prev => [...prev, { ...EMPTY_LEG }])}
                style={{
                  background: 'none', border: `1px dashed ${T.border}`, color: T.muted,
                  fontFamily: T.mono, fontSize: 10, cursor: 'pointer', padding: '6px 0',
                  width: '100%', letterSpacing: '0.1em',
                }}
              >
                + ADD LEG
              </button>
            )}

            <div>
              <span style={lbl}>
                Order Type
                <HelpTip text="Debit: you pay a net premium (buying spread). Credit: you collect a net premium (selling spread). Even: zero-cost combo. Market: fill at best available." position="right" width={230} />
              </span>
              <select style={sel} value={mlType} onChange={e => setMlType(e.target.value)}>
                <option value="debit">DEBIT</option>
                <option value="credit">CREDIT</option>
                <option value="even">EVEN</option>
                <option value="market">MARKET</option>
              </select>
            </div>

            {mlType !== 'market' && mlType !== 'even' && (
              <div>
                <span style={lbl}>Net Price</span>
                <input style={inp} type="number" min="0" step="0.01" value={mlPrice}
                  onChange={e => setMlPrice(e.target.value)} placeholder="0.00" />
              </div>
            )}

            <div>
              <span style={lbl}>Duration</span>
              <select style={sel} value={mlDur} onChange={e => setMlDur(e.target.value)}>
                <option value="day">DAY</option>
                <option value="gtc">GTC</option>
              </select>
            </div>

            <button
              onClick={handleMultilegSubmit}
              disabled={isPending || !mlUnderlying || mlValidLegs.length < 2}
              style={{
                width: '100%', padding: '9px 0', fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                letterSpacing: '0.12em', cursor: isPending ? 'wait' : 'pointer',
                border: 'none',
                background: T.gold,
                color: '#0d1826',
                opacity: (!mlUnderlying || mlValidLegs.length < 2) ? 0.45 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {isPending ? 'PLACING…' : `PLACE SPREAD (${mlValidLegs.length} LEGS)`}
            </button>
          </>
        )}

        {feedback && (
          <div style={{
            padding: '8px 10px', fontFamily: T.mono, fontSize: 11,
            background: feedback.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
            border: `1px solid ${feedback.ok ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)'}`,
            color: feedback.ok ? T.pos : T.neg,
          }}>
            {feedback.ok ? '✓ ' : '✗ '}{feedback.msg}
          </div>
        )}

        <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, textAlign: 'center', marginTop: 4 }}>
          PAPER / SANDBOX — no real money
        </div>
      </div>
    </div>
  )
}

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
        border: '1px solid rgba(201,168,76,0.3)',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.08)',
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: T.dim, fontFamily: T.mono, fontSize: 12 }}>Loading…</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={slice} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor={up ? '#22c55e' : '#ef4444'} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={up ? '#22c55e' : '#ef4444'} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
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
                  contentStyle={{ background: 'var(--theme-surface, #142032)', border: '1px solid rgba(201,168,76,0.3)', borderRadius: 0, fontFamily: T.mono, fontSize: 11 }}
                  formatter={(v: number) => [fmt$(v), 'Close']}
                />
                <Area
                  type="monotone" dataKey="close"
                  stroke={up ? '#22c55e' : '#ef4444'} strokeWidth={1.5}
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
function PositionsPanel({ positions }: { positions: Position[] }) {
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
    color: T.text, borderBottom: `1px solid rgba(255,255,255,0.04)`,
  }

  return (
    <>
      {chartTicker && <TickerChartModal ticker={chartTicker} onClose={() => setChartTicker(null)} />}
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {sectionHeader('POSITIONS', positions.length)}
        {positions.length === 0 ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: T.dim, fontFamily: T.mono, fontSize: 12, flexDirection: 'column', gap: 6,
          }}>
            <span style={{ fontSize: 24, opacity: 0.3 }}>⬜</span>
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
                  <th style={{ ...th, textAlign: 'right' as const }}>Unr. P&amp;L</th>
                  <th style={{ ...th, textAlign: 'right' as const }}>1D %</th>
                  <th style={{ ...th, textAlign: 'right' as const }}>Date</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p, i) => {
                  const q = quotes[p.symbol]
                  const costPerShare = p.quantity ? p.cost_basis / p.quantity : 0
                  const mktVal = q ? q.price * p.quantity : null
                  const unrealized = mktVal != null ? mktVal - p.cost_basis : null
                  const unrealizedPct = unrealized != null && p.cost_basis ? (unrealized / p.cost_basis) * 100 : null
                  return (
                    <tr key={i}
                      onClick={() => setChartTicker(p.symbol)}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(201,168,76,0.06)'; (e.currentTarget as HTMLElement).style.cursor = 'pointer' }}
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
                            {unrealizedPct != null && (
                              <span style={{ fontSize: 10, marginLeft: 4 }}>({unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(1)}%)</span>
                            )}
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
function OrdersPanel({ orders, onCancel }: { orders: Order[]; onCancel: (id: string) => void }) {
  const isPending = (status: string) =>
    ['pending', 'open', 'partially_filled'].includes(status?.toLowerCase())

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {sectionHeader('ORDERS & HISTORY', orders.length)}
      {orders.length === 0 ? (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: T.dim, fontFamily: T.mono, fontSize: 12, flexDirection: 'column', gap: 6,
        }}>
          <span style={{ fontSize: 24, opacity: 0.3 }}>📋</span>
          No orders yet
        </div>
      ) : (
        <div style={{ overflowY: 'auto', flex: 1, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {orders.map(o => (
            <div key={o.id} style={{
              background: T.bg,
              border: `1px solid ${T.border}`,
              padding: '9px 10px',
              position: 'relative',
            }}>
              {/* Symbol + cancel */}
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 5 }}>
                <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.gold }}>{o.symbol}</span>
                {isPending(o.status) && (
                  <button
                    onClick={() => onCancel(o.id)}
                    title="Cancel order"
                    style={{
                      background: 'none', border: `1px solid rgba(239,68,68,0.35)`,
                      color: T.neg, cursor: 'pointer', fontSize: 11, lineHeight: 1,
                      padding: '2px 6px', fontFamily: T.mono,
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

              {/* Status + type + date */}
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
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function PaperTrading() {
  const queryClient = useQueryClient()

  const { data, isError, isLoading, refetch } = useQuery<AccountData>({
    queryKey: ['trading-account'],
    queryFn: () => axios.get('/api/trading/account').then(r => r.data),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => axios.delete(`/api/trading/order/${id}`).then(r => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trading-account'] }),
  })

  function invalidateAccount() {
    queryClient.invalidateQueries({ queryKey: ['trading-account'] })
  }

  const bal = data?.balances
  const positions = data?.positions ?? []
  const orders = [...(data?.orders ?? [])].sort((a, b) =>
    new Date(b.create_date).getTime() - new Date(a.create_date).getTime()
  )

  const dayChangeColor = bal
    ? bal.day_change >= 0 ? T.pos : T.neg
    : T.muted

  // Column height tracking
  const [bodyHeight, setBodyHeight] = useState('calc(100vh - 130px)')
  useEffect(() => {
    function updateHeight() {
      setBodyHeight(`calc(100vh - 130px)`)
    }
    window.addEventListener('resize', updateHeight)
    return () => window.removeEventListener('resize', updateHeight)
  }, [])

  return (
    <PageWrapper>
      <div style={{ fontFamily: T.mono, color: T.text, display: 'flex', flexDirection: 'column', height: '100%' }}>

        {/* ── Error banner ── */}
        {isError && (
          <div style={{
            padding: '9px 14px', marginBottom: 8,
            background: 'rgba(239,68,68,0.1)', border: `1px solid rgba(239,68,68,0.4)`,
            color: T.neg, fontSize: 12, fontFamily: T.mono,
          }}>
            ⚠ Tradier sandbox unavailable — check API key in .env
          </div>
        )}

        {/* ── Header bar ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap',
          padding: '10px 14px',
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderBottom: `2px solid ${T.gold}`,
          marginBottom: 10,
        }}>
          {/* Title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.14em', color: T.gold }}>
              PAPER TRADING
            </span>
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '2px 7px',
              background: 'rgba(249,115,22,0.18)', color: T.orange,
              border: `1px solid rgba(249,115,22,0.4)`, letterSpacing: '0.1em',
            }}>
              SANDBOX
            </span>
          </div>

          <div style={{ width: 1, height: 18, background: T.border }} />

          {/* Metrics */}
          {isLoading ? (
            <span style={{ fontSize: 11, color: T.dim }}>Loading…</span>
          ) : bal ? (
            <>
              <HeaderMetric label="EQUITY" value={fmt$(bal.total_equity)} />
              <HeaderMetric label="BUYING POWER" value={fmt$(bal.buying_power)} />
              <HeaderMetric label="DAY P&L" value={fmt$(bal.day_change)} valueColor={dayChangeColor} />
              <HeaderMetric label="CASH" value={fmt$(bal.cash)} />
            </>
          ) : null}

          <div style={{ marginLeft: 'auto' }}>
            <button
              onClick={() => refetch()}
              title="Refresh"
              style={{
                background: 'none', border: `1px solid ${T.border}`, color: T.muted,
                cursor: 'pointer', padding: '4px 10px', fontFamily: T.mono, fontSize: 13,
                transition: 'border-color 0.15s, color 0.15s',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = T.gold
                ;(e.currentTarget as HTMLButtonElement).style.color = T.gold
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = T.border
                ;(e.currentTarget as HTMLButtonElement).style.color = T.muted
              }}
            >
              ↻
            </button>
          </div>
        </div>

        {/* ── Three-column body ── */}
        <div style={{
          display: 'flex', gap: 10, alignItems: 'flex-start',
          height: bodyHeight, overflow: 'hidden',
        }}>
          {/* Left: Order Ticket — 300px */}
          <div style={{
            width: 300, flexShrink: 0,
            background: T.surface,
            border: `1px solid ${T.border}`,
            display: 'flex', flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
          }}>
            <OrderTicket onOrderPlaced={invalidateAccount} />
          </div>

          {/* Middle: Positions — flex */}
          <div style={{
            flex: 1, minWidth: 0,
            background: T.surface,
            border: `1px solid ${T.border}`,
            display: 'flex', flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
          }}>
            <PositionsPanel positions={positions} />
          </div>

          {/* Right: Orders — 280px */}
          <div style={{
            width: 280, flexShrink: 0,
            background: T.surface,
            border: `1px solid ${T.border}`,
            display: 'flex', flexDirection: 'column',
            height: '100%',
            overflow: 'hidden',
          }}>
            <OrdersPanel orders={orders} onCancel={id => cancelMutation.mutate(id)} />
          </div>
        </div>
      </div>
    </PageWrapper>
  )
}

function HeaderMetric({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.13em', color: T.muted, textTransform: 'uppercase' as const }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 700, color: valueColor ?? T.text }}>
        {value}
      </span>
    </div>
  )
}
