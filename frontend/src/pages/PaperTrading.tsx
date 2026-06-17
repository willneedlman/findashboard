import { useState, useEffect, useRef, useMemo } from 'react'
import axios from 'axios'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ComposedChart, Line } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import HelpTip from '../components/HelpTip'
import ExpirySelect from '../components/ExpirySelect'
import { GammaScalpingContent } from './GammaScalping'
import CustomStrategyModal, { type CustomStrategyDef } from '../components/CustomStrategyModal'
import { loadCustomStrategies, saveCustomStrategy } from '../utils/customStrategies'
import { useTheme } from '../contexts/ThemeContext'
import { buildOCC, parseOCC, isOCC } from '../lib/occ'
import PaperChart, { type ChartFill } from '../components/PaperChart'

// Per-user auth for the paper engine: the current account id + session-token
// headers. Paper trading is now each user's own book, so every call is owner-gated.
function useAuth() {
  const { user } = useTheme()
  const token = typeof window !== 'undefined' ? (localStorage.getItem('ft-session-token') || '') : ''
  return {
    uid: user?.id || '',
    authed: !!user?.id && !!token,
    headers: { headers: { Authorization: `Bearer ${token}`, 'x-session-token': token } },
  }
}

// Adapt the per-user engine's account response to the shape this page renders.
function adaptAccount(d: any): AccountData {
  const positions = [
    ...(d?.positions ?? []).map((p: any) => ({ symbol: p.symbol, quantity: p.quantity, cost_basis: p.avg_cost * p.quantity, date_acquired: '' })),
    ...(d?.option_positions ?? []).map((p: any) => ({ symbol: p.option_symbol, quantity: p.quantity, cost_basis: p.avg_cost * p.quantity, date_acquired: '' })),
  ]
  const orders = (d?.orders ?? []).map((o: any) => ({
    id: o.id, type: o.order_type, symbol: o.option_symbol || o.symbol, side: o.side,
    quantity: o.quantity, status: o.status, price: o.limit_price ?? o.stop_price ?? undefined,
    avg_fill_price: o.fill_price ?? undefined, create_date: o.created_at ? new Date(o.created_at * 1000).toISOString() : '',
  }))
  return {
    balances: { cash: d?.cash ?? 0, market_value: (d?.equity ?? 0) - (d?.cash ?? 0), equity: d?.equity ?? 0,
                buying_power: d?.buying_power ?? 0, total_equity: d?.equity ?? 0, day_change: 0 },
    positions, orders,
  }
}

// ─── Theme tokens ────────────────────────────────────────────────────────────
const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #142032)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  pos:     'var(--theme-positive)',
  neg:     'var(--theme-negative)',
  warn:    'var(--theme-warn)',
  dim:     'var(--theme-text-muted, var(--theme-text-muted, rgba(215,227,252,0.35)))',
}

// ─── Shared element styles ────────────────────────────────────────────────────
const inp: React.CSSProperties = {
  background: T.bg,
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
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

const PT_LS_KEY = 'ft_pending_option_strategy'

interface PendingOptionStrategy {
  name: string; underlying: string; orderType: 'debit' | 'credit' | 'market'
  legs: { occ: string; side: 'buy_to_open' | 'sell_to_open'; qty: string; hint: string }[]
  savedAt: number
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

// OCC option symbol helpers live in lib/occ (shared with the paper-trade widget).

// ─── Multi-leg leg row ────────────────────────────────────────────────────────
interface LegState { expDate: string; strike: string; callPut: 'C' | 'P'; side: string; qty: string }
const EMPTY_LEG: LegState = { expDate: '', strike: '', callPut: 'C', side: 'buy_to_open', qty: '1' }

interface StrategyTemplate {
  name: string; shortName: string; orderType: string
  legs: { side: string; qty: string; hint: string }[]
  description: string
}

const OPTION_STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    name: 'Bull Call Spread', shortName: 'Bull Call', orderType: 'debit',
    description: 'Buy lower strike call, sell higher strike call. Capped upside, defined risk.',
    legs: [
      { side: 'buy_to_open',  qty: '1', hint: 'Long call — lower strike (ATM)' },
      { side: 'sell_to_open', qty: '1', hint: 'Short call — higher strike (OTM)' },
    ],
  },
  {
    name: 'Bear Put Spread', shortName: 'Bear Put', orderType: 'debit',
    description: 'Buy higher strike put, sell lower strike put. Bearish, defined risk.',
    legs: [
      { side: 'buy_to_open',  qty: '1', hint: 'Long put — higher strike (ATM)' },
      { side: 'sell_to_open', qty: '1', hint: 'Short put — lower strike (OTM)' },
    ],
  },
  {
    name: 'Bull Put Spread', shortName: 'Bull Put', orderType: 'credit',
    description: 'Sell higher strike put, buy lower strike put. Collect premium; profit if stock stays above short strike.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short put — higher strike (slightly OTM)' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long put — lower strike (further OTM)' },
    ],
  },
  {
    name: 'Bear Call Spread', shortName: 'Bear Call', orderType: 'credit',
    description: 'Sell lower strike call, buy higher strike call. Collect premium; profit if stock stays below short strike.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short call — lower strike (slightly OTM)' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long call — higher strike (further OTM)' },
    ],
  },
  {
    name: 'Long Straddle', shortName: 'Straddle', orderType: 'debit',
    description: 'Buy ATM call + put same strike/expiry. Profits from large move in either direction.',
    legs: [
      { side: 'buy_to_open', qty: '1', hint: 'Long call — ATM strike' },
      { side: 'buy_to_open', qty: '1', hint: 'Long put — same ATM strike' },
    ],
  },
  {
    name: 'Short Straddle', shortName: 'Sh. Straddle', orderType: 'credit',
    description: 'Sell ATM call + put. Max profit if stock pins at strike. Unlimited risk.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short call — ATM strike' },
      { side: 'sell_to_open', qty: '1', hint: 'Short put — same ATM strike' },
    ],
  },
  {
    name: 'Long Strangle', shortName: 'Strangle', orderType: 'debit',
    description: 'Buy OTM call + OTM put. Cheaper than straddle; needs bigger move.',
    legs: [
      { side: 'buy_to_open', qty: '1', hint: 'Long call — OTM strike above current' },
      { side: 'buy_to_open', qty: '1', hint: 'Long put — OTM strike below current' },
    ],
  },
  {
    name: 'Iron Condor', shortName: 'Iron Condor', orderType: 'credit',
    description: 'Sell OTM call spread + OTM put spread. Profit in range-bound market.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short put — lower inner strike' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long put — lowest strike (wing)' },
      { side: 'sell_to_open', qty: '1', hint: 'Short call — upper inner strike' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long call — highest strike (wing)' },
    ],
  },
  {
    name: 'Iron Butterfly', shortName: 'Iron Fly', orderType: 'credit',
    description: 'Sell ATM straddle + buy OTM wings. Max credit at-the-money.',
    legs: [
      { side: 'buy_to_open',  qty: '1', hint: 'Long put wing — lowest strike' },
      { side: 'sell_to_open', qty: '1', hint: 'Short put — ATM strike' },
      { side: 'sell_to_open', qty: '1', hint: 'Short call — same ATM strike' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long call wing — highest strike' },
    ],
  },
  {
    name: 'Covered Call', shortName: 'Cov. Call', orderType: 'credit',
    description: 'Long 100 shares (equity tab) + sell OTM call. Income on held position.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short call — OTM strike above cost basis' },
    ],
  },
  {
    name: 'Protective Put', shortName: 'Prot. Put', orderType: 'debit',
    description: 'Long 100 shares (equity tab) + buy put as insurance.',
    legs: [
      { side: 'buy_to_open', qty: '1', hint: 'Long put — strike at or below entry price' },
    ],
  },
  {
    name: 'Calendar Spread', shortName: 'Calendar', orderType: 'debit',
    description: 'Sell near-term ATM option, buy same-strike further-dated option. Profits from time decay difference.',
    legs: [
      { side: 'sell_to_open', qty: '1', hint: 'Short near-term — same strike, closer expiry' },
      { side: 'buy_to_open',  qty: '1', hint: 'Long far-term — same strike, further expiry' },
    ],
  },
]

function LegRow({
  index, leg, hint, underlying, onChange, onRemove, canRemove,
}: {
  index: number
  leg: LegState
  hint?: string
  underlying: string
  onChange: (l: LegState) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const occ = buildOCC(underlying, leg.expDate, leg.strike, leg.callPut)
  return (
    <div style={{ border: `1px solid ${T.border}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <span style={{ ...lbl, marginBottom: 0, color: T.gold }}>LEG {index + 1}</span>
          {hint && <span style={{ fontSize: 8, color: T.dim, fontFamily: T.mono, marginLeft: 6 }}>{hint}</span>}
        </div>
        {canRemove && (
          <button onClick={onRemove} style={{
            background: 'none', border: 'none', color: T.neg, cursor: 'pointer',
            fontSize: 14, lineHeight: 1, padding: '0 2px',
          }}>×</button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <span style={lbl}>Expiration</span>
          <ExpirySelect ticker={underlying} value={leg.expDate} autoSelect={false}
            onChange={v => onChange({ ...leg, expDate: v })} style={inp} />
        </div>
        <div style={{ flex: 1 }}>
          <span style={lbl}>Strike</span>
          <input style={inp} type="number" min="0" step="0.5" value={leg.strike}
            onChange={e => onChange({ ...leg, strike: e.target.value })} placeholder="580.00" />
        </div>
      </div>
      <div>
        <span style={lbl}>Call / Put</span>
        <div style={{ display: 'flex', gap: 0 }}>
          {(['C', 'P'] as const).map(cp => (
            <button
              key={cp}
              onClick={() => onChange({ ...leg, callPut: cp })}
              style={{
                flex: 1, padding: '6px 0', fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                letterSpacing: '0.1em', cursor: 'pointer', border: `1px solid ${T.border}`,
                background: leg.callPut === cp ? (cp === 'C' ? T.pos : T.neg) : T.bg,
                color: leg.callPut === cp ? 'var(--theme-bg)' : T.muted,
                borderRight: cp === 'C' ? 'none' : undefined,
                transition: 'background 0.15s, color 0.15s',
              }}
            >
              {cp === 'C' ? 'CALL' : 'PUT'}
            </button>
          ))}
        </div>
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
      {occ && (
        <div style={{ padding: '4px 8px', background: 'color-mix(in srgb, var(--theme-primary) 6%, transparent)', border: `1px solid color-mix(in srgb, var(--theme-primary) 20%, transparent)` }}>
          <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, fontFamily: T.mono }}>OCC SYMBOL</span>
          <div style={{ fontSize: 11, fontFamily: T.mono, color: T.gold, marginTop: 1, letterSpacing: '0.04em' }}>{occ}</div>
        </div>
      )}
    </div>
  )
}

// ─── Order Ticket ─────────────────────────────────────────────────────────────
function OrderTicket({ onOrderPlaced, importTemplate, onTemplateConsumed, importOCCLegs, importUnderlying }: {
  onOrderPlaced: () => void
  importTemplate?: StrategyTemplate | null
  onTemplateConsumed?: () => void
  importOCCLegs?: { symbol: string; side: string; qty: string }[] | null
  importUnderlying?: string | null
}) {
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
  const [opExpDate, setOpExpDate]       = useState('')
  const [opStrike, setOpStrike]         = useState('')
  const [opCallPut, setOpCallPut]       = useState<'C' | 'P'>('C')
  const [opSide, setOpSide]             = useState('buy_to_open')
  const [opQty, setOpQty]               = useState('')
  const [opType, setOpType]             = useState('market')
  const [opPrice, setOpPrice]           = useState('')
  const [opDur, setOpDur]               = useState('day')

  const opSymbol = useMemo(
    () => buildOCC(opUnderlying, opExpDate, opStrike, opCallPut),
    [opUnderlying, opExpDate, opStrike, opCallPut],
  )

  // Multi-leg state
  const [mlUnderlying, setMlUnderlying]           = useState('')
  const [mlLegs, setMlLegs]                       = useState<LegState[]>([{ ...EMPTY_LEG }, { ...EMPTY_LEG }])
  const [mlType, setMlType]                       = useState('debit')
  const [mlPrice, setMlPrice]                     = useState('')
  const [mlDur, setMlDur]                         = useState('day')
  const [mlTemplate, setMlTemplate]               = useState<StrategyTemplate | null>(null)
  const [mlLegHints, setMlLegHints]               = useState<string[]>([])

  const applyTemplate = (tpl: StrategyTemplate) => {
    setMlTemplate(tpl)
    setMlType(tpl.orderType)
    setMlLegs(tpl.legs.map(l => ({ expDate: '', strike: '', callPut: l.hint.toLowerCase().includes('put') ? 'P' : 'C', side: l.side, qty: l.qty })))
    setMlLegHints(tpl.legs.map(l => l.hint))
  }

  useEffect(() => {
    if (!importTemplate) return
    setTab('multileg')
    applyTemplate(importTemplate)
    // If real OCC symbols provided (from Strategy Builder), parse them into leg params
    if (importOCCLegs) {
      setMlLegs(importOCCLegs.map(l => {
        const parsed = parseOCC(l.symbol)
        return parsed
          ? { ...parsed, side: l.side, qty: l.qty }
          : { expDate: '', strike: '', callPut: 'C' as const, side: l.side, qty: l.qty }
      }))
    }
    if (importUnderlying) setMlUnderlying(importUnderlying)
    onTemplateConsumed?.()
    document.getElementById('order-ticket-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [importTemplate]) // eslint-disable-line react-hooks/exhaustive-deps

  // Feedback
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  function showFeedback(ok: boolean, msg: string) {
    setFeedback({ ok, msg })
    setTimeout(() => setFeedback(null), 3500)
  }

  const { uid, headers } = useAuth()

  const eqMutation = useMutation({
    mutationFn: (body: object) => axios.post('/api/paper/order', body, headers).then(r => r.data),
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
    mutationFn: (body: object) => axios.post('/api/paper/order/option', body, headers).then(r => r.data),
    onSuccess: () => {
      showFeedback(true, 'Option order placed')
      setOpUnderlying(''); setOpExpDate(''); setOpStrike(''); setOpQty(''); setOpPrice('')
      onOrderPlaced()
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Order failed'
      showFeedback(false, msg)
    },
  })

  const mlMutation = useMutation({
    mutationFn: (body: object) => axios.post('/api/paper/order/multileg', body, headers).then(r => r.data),
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
      user_id: uid,
      symbol: eqSymbol.toUpperCase(),
      side: eqSide,
      quantity: parseInt(eqQty),
      order_type: eqType,
      limit_price: (eqType === 'limit' && eqPrice) ? parseFloat(eqPrice) : null,
      stop_price: (eqType === 'stop' && eqPrice) ? parseFloat(eqPrice) : null,
    })
  }

  function handleOptionSubmit() {
    if (!opUnderlying || !opSymbol || !opQty) return
    opMutation.mutate({
      user_id: uid,
      option_symbol: opSymbol,
      side: opSide,
      quantity: parseInt(opQty),
      order_type: opType,
      price: (opType === 'limit' && opPrice) ? parseFloat(opPrice) : null,
    })
  }

  function handleMultilegSubmit() {
    const validLegs = mlLegs
      .map(l => ({ occ: buildOCC(mlUnderlying, l.expDate, l.strike, l.callPut), side: l.side, qty: l.qty }))
      .filter(l => l.occ && l.qty)
    if (!mlUnderlying || validLegs.length < 2) return
    mlMutation.mutate({
      user_id: uid,
      legs: validLegs.map(l => ({
        option_symbol: l.occ,
        side: l.side,
        quantity: parseInt(l.qty),
      })),
      order_type: mlType,
      net_price: (mlType !== 'market' && mlPrice) ? parseFloat(mlPrice) : null,
    })
  }

  const tabBtn = (id: 'equity' | 'option' | 'multileg', label: string) => (
    <button
      onClick={() => setTab(id)}
      style={{
        flex: 1, padding: '7px 0', fontFamily: T.mono, fontSize: 9, fontWeight: 700,
        letterSpacing: '0.10em', cursor: 'pointer', border: 'none',
        background: tab === id ? T.gold : 'transparent',
        color: tab === id ? 'var(--theme-bg)' : T.muted,
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
  const mlValidLegs = mlLegs.filter(l => buildOCC(mlUnderlying, l.expDate, l.strike, l.callPut) && l.qty)

  return (
    <div id="order-ticket-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
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
                color: 'var(--theme-bg)',
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
              <span style={lbl}>Expiration Date</span>
              <ExpirySelect ticker={opUnderlying} value={opExpDate} onChange={setOpExpDate} autoSelect={false} style={inp} />
            </div>

            <div>
              <span style={lbl}>Strike Price</span>
              <input
                style={inp}
                type="number"
                min="0"
                step="0.5"
                value={opStrike}
                onChange={e => setOpStrike(e.target.value)}
                placeholder="580.00"
              />
            </div>

            <div>
              <span style={lbl}>Call / Put</span>
              <div style={{ display: 'flex', gap: 0 }}>
                {(['C', 'P'] as const).map(cp => (
                  <button
                    key={cp}
                    onClick={() => setOpCallPut(cp)}
                    style={{
                      flex: 1, padding: '6px 0', fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                      letterSpacing: '0.1em', cursor: 'pointer', border: `1px solid ${T.border}`,
                      background: opCallPut === cp ? (cp === 'C' ? T.pos : T.neg) : T.bg,
                      color: opCallPut === cp ? 'var(--theme-bg)' : T.muted,
                      borderRight: cp === 'C' ? 'none' : undefined,
                      transition: 'background 0.15s, color 0.15s',
                    }}
                  >
                    {cp === 'C' ? 'CALL' : 'PUT'}
                  </button>
                ))}
              </div>
            </div>

            {opSymbol && (
              <div style={{ padding: '5px 8px', background: 'color-mix(in srgb, var(--theme-primary) 6%, transparent)', border: `1px solid color-mix(in srgb, var(--theme-primary) 20%, transparent)` }}>
                <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, fontFamily: T.mono }}>OCC SYMBOL</span>
                <div style={{ fontSize: 12, fontFamily: T.mono, color: T.gold, marginTop: 2, letterSpacing: '0.04em' }}>{opSymbol}</div>
              </div>
            )}

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
              disabled={isPending || !opSymbol || !opQty}
              style={{
                width: '100%', padding: '9px 0', fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                letterSpacing: '0.12em', cursor: isPending ? 'wait' : 'pointer',
                border: 'none',
                background: opSide.startsWith('buy') ? T.gold : T.neg,
                color: 'var(--theme-bg)',
                opacity: (!opSymbol || !opQty) ? 0.45 : 1,
                transition: 'opacity 0.15s',
              }}
            >
              {isPending ? 'PLACING…' : 'PLACE OPTION ORDER'}
            </button>
          </>
        )}

        {tab === 'multileg' && (
          <>
            {/* Strategy template picker */}
            <div>
              <span style={lbl}>Strategy Template</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                {OPTION_STRATEGY_TEMPLATES.map(tpl => (
                  <button
                    key={tpl.name}
                    onClick={() => applyTemplate(tpl)}
                    style={{
                      padding: '3px 8px', fontSize: 9, fontFamily: T.mono, cursor: 'pointer',
                      border: '1px solid',
                      borderColor: mlTemplate?.name === tpl.name ? T.gold : T.border,
                      background: mlTemplate?.name === tpl.name ? 'rgba(201,168,76,0.15)' : 'transparent',
                      color: mlTemplate?.name === tpl.name ? T.gold : T.muted,
                      letterSpacing: '0.06em', fontWeight: mlTemplate?.name === tpl.name ? 700 : 400,
                      whiteSpace: 'nowrap',
                    }}
                  >{tpl.shortName}</button>
                ))}
                {mlTemplate && (
                  <button
                    onClick={() => { setMlTemplate(null); setMlLegHints([]); setMlLegs([{ ...EMPTY_LEG }, { ...EMPTY_LEG }]) }}
                    style={{ padding: '3px 8px', fontSize: 9, fontFamily: T.mono, cursor: 'pointer',
                      border: `1px solid ${T.border}`, background: 'transparent', color: T.neg }}
                  >Clear</button>
                )}
              </div>
              {mlTemplate && (
                <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, lineHeight: '14px',
                  padding: '5px 8px', background: 'var(--theme-hover, rgba(255,255,255,0.02))', border: `1px solid ${T.border}` }}>
                  <span style={{ color: T.gold, fontWeight: 700 }}>{mlTemplate.name}</span>
                  {' · '}{mlTemplate.description}
                </div>
              )}
              {!mlTemplate && (
                <div style={{ fontSize: 9, color: T.dim, fontFamily: T.mono }}>
                  Select a template or build manually below.
                </div>
              )}
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
                  hint={mlLegHints[i]}
                  underlying={mlUnderlying}
                  onChange={updated => setMlLegs(prev => prev.map((l, j) => j === i ? updated : l))}
                  onRemove={() => { setMlLegs(prev => prev.filter((_, j) => j !== i)); setMlLegHints(prev => prev.filter((_, j) => j !== i)) }}
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
                color: 'var(--theme-bg)',
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
            {feedback.ok ? '' : '! '}{feedback.msg}
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: T.dim, fontFamily: T.mono, fontSize: 12 }}>Loading…</div>
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
                  contentStyle={{ background: 'var(--theme-surface, #142032)', border: '1px solid rgba(201,168,76,0.3)', borderRadius: 0, fontFamily: T.mono, fontSize: 11 }}
                  formatter={(v: number) => [fmt$(v), 'Close']}
                />
                <Area
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
function OrdersPanel({ orders, onCancel, onCancelAll, cancelAllPending, cancelAllError, automatedOrders }: {
  orders: Order[]
  onCancel: (id: string) => void
  onCancelAll: () => void
  cancelAllPending?: boolean
  cancelAllError?: boolean
  automatedOrders?: Record<string, string>
}) {
  const [statusF, setStatusF] = useState<'all'|'filled'|'pending'|'rejected'|'canceled'>('all')
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
        transition: 'all 0.1s',
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
              background: cancelAllError ? 'rgba(239,68,68,0.2)' : 'rgba(239,68,68,0.1)',
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
                        background: 'none', border: `1px solid rgba(239,68,68,0.35)`,
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

// ─── Main page ────────────────────────────────────────────────────────────────
export default function PaperTrading() {
  const queryClient = useQueryClient()
  const { uid, authed, headers } = useAuth()

  const { data, isError, isLoading, refetch } = useQuery<AccountData>({
    queryKey: ['trading-account', uid],
    queryFn: () => axios.get(`/api/paper/account?user_id=${uid}`, headers).then(r => adaptAccount(r.data)),
    enabled: authed,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchInterval: 15_000,
  })

  const cancelMutation = useMutation({
    mutationFn: (id: string) => axios.delete(`/api/paper/order/${id}?user_id=${uid}`, headers).then(r => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trading-account'] }),
  })

  const cancelAllMutation = useMutation({
    mutationFn: async () => {
      const pending = (orders ?? []).filter(o =>
        ['pending', 'open', 'partially_filled'].includes((o.status ?? '').toLowerCase()))
      if (pending.length === 0) return
      const results = await Promise.allSettled(pending.map(o => axios.delete(`/api/paper/order/${o.id}?user_id=${uid}`, headers)))
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) throw new Error(`${failed} of ${pending.length} cancellations failed`)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['trading-account'] }),
    onError: () => queryClient.invalidateQueries({ queryKey: ['trading-account'] }),
  })

  function invalidateAccount() {
    queryClient.invalidateQueries({ queryKey: ['trading-account'] })
  }

  const bal = data?.balances
  const positions = data?.positions ?? []
  const orders = [...(data?.orders ?? [])].sort((a, b) =>
    new Date(b.create_date).getTime() - new Date(a.create_date).getTime()
  )

  // Filled orders → buy/sell markers on the chart for the matching ticker.
  const chartFills: ChartFill[] = orders
    .filter(o => (o.status ?? '').toLowerCase() === 'filled' && o.create_date)
    .map(o => {
      const occ = isOCC(o.symbol)
      return { time: Math.floor(new Date(o.create_date).getTime() / 1000), side: o.side, symbol: occ ? undefined : o.symbol, option_symbol: occ ? o.symbol : undefined }
    })
  const chartInitTicker = positions.find(p => /^[A-Z.]{1,6}$/.test(p.symbol))?.symbol || 'SPY'

  const dayChangeColor = bal
    ? bal.day_change >= 0 ? T.pos : T.neg
    : T.muted

  const [gammaOpen, setGammaOpen] = useState(false)

  // Automated order tracking: orderId → strategyName
  const [automatedOrders, setAutomatedOrders] = useState<Record<string, string>>({})
  const handleAutomatedOrder = (id: string, name: string) =>
    setAutomatedOrders(prev => ({ ...prev, [id]: name }))

  // Template import from StrategyPanel → OrderTicket
  const [importedTemplate, setImportedTemplate] = useState<StrategyTemplate | null>(null)

  // Pending strategy sent from Strategy Builder via localStorage
  const [pendingBuilderStrategy, setPendingBuilderStrategy] = useState<PendingOptionStrategy | null>(() => {
    try { return JSON.parse(localStorage.getItem(PT_LS_KEY) ?? 'null') } catch { return null }
  })

  const approveBuilderStrategy = (ps: PendingOptionStrategy) => {
    // Convert PendingOptionStrategy legs into multileg OrderTicket state
    const asTpl: StrategyTemplate = {
      name: ps.name, shortName: ps.name,
      orderType: ps.orderType,
      description: `Imported from Strategy Builder · ${ps.legs.length} legs`,
      legs: ps.legs.map(l => ({ side: l.side, qty: l.qty, hint: l.hint })),
    }
    // Pre-fill OCC symbols by injecting them via a special channel
    setPendingOCCLegs(ps.legs.map(l => ({ symbol: l.occ, side: l.side, qty: l.qty })))
    setPendingUnderlying(ps.underlying)
    setImportedTemplate(asTpl)
    localStorage.removeItem(PT_LS_KEY)
    setPendingBuilderStrategy(null)
  }

  const [pendingOCCLegs, setPendingOCCLegs] = useState<{ symbol: string; side: string; qty: string }[] | null>(null)
  const [pendingUnderlying, setPendingUnderlying] = useState<string | null>(null)

  // Column height tracking
  const [bodyHeight, setBodyHeight] = useState('calc(100vh - 130px)')
  useEffect(() => {
    function updateHeight() {
      setBodyHeight(`calc(100vh - 130px)`)
    }
    window.addEventListener('resize', updateHeight)
    return () => window.removeEventListener('resize', updateHeight)
  }, [])

  if (!authed) return (
    <PageWrapper title="Paper Trading">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', textAlign: 'center' }}>
        <div style={{ fontFamily: T.mono, color: T.muted, fontSize: 13, lineHeight: 1.6 }}>
          Sign in to paper-trade your own account.<br />
          <span style={{ fontSize: 11, color: T.dim }}>Each account gets its own $100k book, positions, and strategies.</span>
        </div>
      </div>
    </PageWrapper>
  )

  return (
    <PageWrapper title="Paper Trading">
      <div style={{ fontFamily: T.mono, color: T.text, display: 'flex', flexDirection: 'column', height: '100%' }}>

        {/* ── Error banner ── */}
        {isError && (
          <div style={{
            padding: '9px 14px', marginBottom: 8,
            background: 'rgba(239,68,68,0.1)', border: `1px solid rgba(239,68,68,0.4)`,
            color: T.neg, fontSize: 12, fontFamily: T.mono,
          }}>
            Tradier sandbox unavailable — check API key in .env
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
          {/* Sandbox badge */}
          <span style={{
            fontSize: 9, fontWeight: 700, padding: '2px 7px',
            background: 'color-mix(in srgb, var(--theme-warn) 18%, transparent)', color: T.warn,
            border: `1px solid rgba(249,115,22,0.4)`, letterSpacing: '0.1em',
          }}>
            SANDBOX
          </span>

          <div style={{ width: 1, height: 18, background: T.border }} />

          {/* Metrics */}
          {isLoading ? (
            <span style={{ fontSize: 11, color: T.dim }}>Loading…</span>
          ) : bal ? (
            <>
              <HeaderMetric label="EQUITY" value={fmt$(bal.total_equity)} />
              <HeaderMetric label="BUYING POWER" value={fmt$(bal.buying_power)} />
              <HeaderMetric label="TOTAL P&L" value={fmt$(bal.day_change)} valueColor={dayChangeColor} />
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

        {(<>
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
            <OrderTicket
              onOrderPlaced={invalidateAccount}
              importTemplate={importedTemplate}
              onTemplateConsumed={() => { setImportedTemplate(null); setPendingOCCLegs(null); setPendingUnderlying(null) }}
              importOCCLegs={pendingOCCLegs}
              importUnderlying={pendingUnderlying}
            />
          </div>

          {/* Middle: Chart over Positions — flex */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10, height: '100%', overflow: 'hidden' }}>
            <div style={{ flex: '3 1 0', minHeight: 0, background: T.surface, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
              <PaperChart initialTicker={chartInitTicker} fills={chartFills} storageKey={uid || 'page'} />
            </div>
            <div style={{ flex: '2 1 0', minHeight: 0, background: T.surface, border: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <PositionsPanel positions={positions} />
            </div>
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
            <OrdersPanel
              orders={orders}
              onCancel={id => cancelMutation.mutate(id)}
              onCancelAll={() => cancelAllMutation.mutate()}
              cancelAllPending={cancelAllMutation.isPending}
              cancelAllError={cancelAllMutation.isError}
              automatedOrders={automatedOrders}
            />
          </div>
        </div>

        {/* ── Strategy Panel ── */}
        <StrategyPanel
          pendingBuilderStrategy={pendingBuilderStrategy}
          onApproveBuilderStrategy={approveBuilderStrategy}
          onDismissBuilderStrategy={() => { localStorage.removeItem(PT_LS_KEY); setPendingBuilderStrategy(null) }}
          onAutomatedOrder={handleAutomatedOrder}
        />

        </>)}
      </div>
    </PageWrapper>
  )
}

// ─── Builtin strategy metadata catalogue (mirrors backend builtins) ──────────
const BUILTIN_STRATEGY_INFO: Record<string, {
  label: string; help: string; usedIn: ('backtester' | 'montecarlo')[]
  backtesterKey?: string; montecarloKey?: string
}> = {
  rsi_mean_reversion: {
    label: 'RSI Mean Reversion',
    help: 'Computes RSI(14). Buys when RSI crosses above the oversold threshold (30), signalling a potential bounce. Sells when RSI crosses below the overbought threshold (70). Best in range-bound, mean-reverting markets. Also used in the Backtester and Monte Carlo drift-adjustment overlay.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'RSI Mean Reversion (14)', montecarloKey: 'RSI Mean Reversion (14)',
  },
  sma_trend_following: {
    label: 'SMA Trend Following',
    help: 'Golden Cross / Death Cross strategy. Buys when the 50-day SMA crosses above the 200-day SMA and price is above both (confirmed uptrend). Sells when both conditions reverse. Trend-following. Performs best in strongly trending markets. Whipsaws in choppy conditions. Also used in Backtester and Monte Carlo as drift adjustment.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'SMA Trend Following (50/200)', montecarloKey: 'SMA Trend Following (50/200)',
  },
  bollinger_breakout: {
    label: 'Bollinger Breakout',
    help: 'Computes a 20-period Bollinger Band (±2σ). Enters long when price closes above the upper band (volatility breakout). Exits when price falls below the lower band. Targets breakout moves. Works well on trending assets. Prone to false signals during consolidation.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'bollinger_breakout', montecarloKey: 'Bollinger Breakout (20,2)',
  },
  momentum: {
    label: '6-Month Momentum',
    help: 'Computes the 126-day (≈6-month) price return. Buys when positive momentum (price higher than 6 months ago), sells when it turns negative. One of the most robust documented equity anomalies. Tends to underperform after sudden market reversals. Also used in Backtester and Monte Carlo.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'momentum', montecarloKey: '6-Month Price Momentum',
  },
  macd_crossover: {
    label: 'MACD Crossover',
    help: 'Moving Average Convergence Divergence. Computes EMA(12) − EMA(26) = MACD line, and EMA(9) of it = signal line. Buys when MACD crosses above the signal line (bullish momentum shift). Sells on cross below. Combines trend and momentum. Lags at turning points. Strong in trending environments.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'macd_crossover', montecarloKey: 'MACD Crossover (12,26,9)',
  },
  value_pe: {
    label: 'Value P/E',
    help: 'Fundamental value strategy. Fetches trailing P/E at session start. Buys when P/E < fair-value threshold (stock is cheap), sells when P/E exceeds the expensive threshold. Holds neutral in between. Note: P/E is static per session. This strategy emits a sustained BUY or SELL signal rather than reacting to price ticks.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'value_pe', montecarloKey: 'Value — Trailing P/E',
  },
  earnings_growth: {
    label: 'Earnings Growth',
    help: 'Fundamental earnings momentum. Fetches quarterly EPS growth at session start. Buys when EPS growth is positive (company is growing earnings), exits when growth falls below the exit threshold. Like Value P/E, this is a session-level signal. Set the ticker param to match your position.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'earnings_momentum', montecarloKey: 'Earnings Growth Momentum',
  },
  gamma_scalping: {
    label: 'Gamma Scalping',
    help: 'IV/RV regime proxy using the short-term (5-day) vs long-term (20-day) realized volatility ratio. Buys when recent volatility expands above the long-term baseline (vol expansion = long gamma regime). Exits when vol compresses below the threshold. Repurposed from the Gamma Scalping simulator. Captures convexity-driven moves without requiring live options data.',
    usedIn: [],
  },
  micro_scalp: {
    label: 'EMA Micro-Scalp (3/8)',
    help: 'Very short-term EMA crossover scalp. Enters when EMA(3) crosses above EMA(8), a fast micro-trend burst. Exits on the reverse cross. Optional ATR filter skips signals when the market is too quiet. Generates frequent round trips. Best on volatile, trending assets.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'micro_scalp', montecarloKey: 'EMA Micro-Scalp (3/8)',
  },
}

// ─── Paper strategy param definitions (mirrors backend initialize() defaults) ─

const PAPER_DEFAULT_PARAMS: Record<string, Record<string, number>> = {
  rsi_mean_reversion:  { period: 14, oversold: 30, overbought: 70 },
  sma_trend_following: { sma_fast: 50, sma_slow: 200 },
  bollinger_breakout:  { period: 20, std_dev: 2.0 },
  momentum:            { lookback_days: 126, threshold_pct: 0 },
  macd_crossover:      { ema_fast: 12, ema_slow: 26, signal_period: 9 },
  value_pe:            { pe_deep_value: 12, pe_fair_value: 20, pe_expensive: 35, pe_very_expensive: 50 },
  earnings_growth:     { exit_threshold_pct: -5 },
  gamma_scalping:      { short_window: 5, long_window: 20, entry_ratio: 1.3, exit_ratio: 0.8 },
  micro_scalp:         { ema_fast: 3, ema_slow: 8, atr_period: 5, atr_mult: 0.3 },
}

const PAPER_PARAM_LABELS: Record<string, Record<string, string>> = {
  rsi_mean_reversion:  { period: 'Period', oversold: 'Oversold', overbought: 'Overbought' },
  sma_trend_following: { sma_fast: 'Fast SMA', sma_slow: 'Slow SMA' },
  bollinger_breakout:  { period: 'Period', std_dev: 'Std Dev' },
  momentum:            { lookback_days: 'Lookback', threshold_pct: 'Threshold %' },
  macd_crossover:      { ema_fast: 'Fast EMA', ema_slow: 'Slow EMA', signal_period: 'Signal' },
  value_pe:            { pe_deep_value: 'Deep Value P/E', pe_fair_value: 'Fair Value P/E', pe_expensive: 'Exit P/E', pe_very_expensive: 'Very Exp P/E' },
  earnings_growth:     { exit_threshold_pct: 'Exit EPS %' },
  gamma_scalping:      { short_window: 'Short Window', long_window: 'Long Window', entry_ratio: 'Entry Ratio', exit_ratio: 'Exit Ratio' },
  micro_scalp:         { ema_fast: 'Fast EMA', ema_slow: 'Slow EMA', atr_period: 'ATR Period', atr_mult: 'Min ATR %' },
}

// ─── Strategy Signal Chart ───────────────────────────────────────────────────

interface ChartPoint { date: string; price: number; buy?: number; sell?: number }

function computeReplayStats(data: ChartPoint[]) {
  const trades: { entry: number; exit: number }[] = []
  let entryPrice: number | null = null
  for (const pt of data) {
    if (pt.buy != null && entryPrice === null) entryPrice = pt.price
    if (pt.sell != null && entryPrice !== null) {
      trades.push({ entry: entryPrice, exit: pt.price })
      entryPrice = null
    }
  }
  if (trades.length === 0) return null
  const wins = trades.filter(t => t.exit > t.entry).length
  const totalPnlPct = trades.reduce((s, t) => s + (t.exit / t.entry - 1) * 100, 0)
  return {
    pnl: totalPnlPct,
    winRate: (wins / trades.length) * 100,
    trades: trades.length,
  }
}

function StrategySignalChart({ data, ticker, mode, intervalMs = 15_000 }: {
  data: ChartPoint[]; ticker: string; mode: 'replay' | 'live'; intervalMs?: number
}) {
  const buyCount  = data.filter(d => d.buy  != null).length
  const sellCount = data.filter(d => d.sell != null).length
  const stats = mode === 'replay' ? computeReplayStats(data) : null

  const BuyDot = (props: { cx?: number; cy?: number; payload?: ChartPoint }) => {
    const { cx = 0, cy = 0, payload } = props
    if (!payload?.buy) return null
    return <polygon points={`${cx},${cy - 7} ${cx - 5},${cy + 3} ${cx + 5},${cy + 3}`} fill={T.pos} opacity={0.9} />
  }
  const SellDot = (props: { cx?: number; cy?: number; payload?: ChartPoint }) => {
    const { cx = 0, cy = 0, payload } = props
    if (!payload?.sell) return null
    return <polygon points={`${cx},${cy + 7} ${cx - 5},${cy - 3} ${cx + 5},${cy - 3}`} fill={T.neg} opacity={0.9} />
  }

  const xCount = data.length
  const tickInterval = Math.max(1, Math.floor(xCount / 8))

  return (
    <div style={{ borderTop: `1px solid ${T.border}`, padding: '10px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, textTransform: 'uppercase' }}>
          {mode === 'live' ? '● LIVE' : '▶ REPLAY'} · {ticker}
        </span>
        <span style={{ fontSize: 9, color: T.pos, fontFamily: T.mono }}>▲ {buyCount} BUY</span>
        <span style={{ fontSize: 9, color: T.neg, fontFamily: T.mono }}>▼ {sellCount} SELL</span>
        {stats && (
          <>
            <span style={{ width: 1, height: 12, background: T.border, display: 'inline-block' }} />
            <span style={{ fontSize: 9, fontFamily: T.mono, color: stats.pnl >= 0 ? T.pos : T.neg }}>
              P&L {stats.pnl >= 0 ? '+' : ''}{stats.pnl.toFixed(1)}%
            </span>
            <span style={{ fontSize: 9, fontFamily: T.mono, color: T.muted }}>
              Win {stats.winRate.toFixed(0)}%
            </span>
            <span style={{ fontSize: 9, fontFamily: T.mono, color: T.dim }}>
              {stats.trades} trades
            </span>
          </>
        )}
        {mode === 'live' && (
          <span style={{ fontSize: 9, color: T.dim, fontFamily: T.mono, marginLeft: 'auto' }}>
            {xCount} ticks · updates every {intervalMs / 1000}s
          </span>
        )}
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }}
            interval={tickInterval}
            tickLine={false}
            axisLine={{ stroke: T.border }}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }}
            tickLine={false}
            axisLine={false}
            width={52}
            tickFormatter={(v: number) => `$${v.toFixed(0)}`}
          />
          <Tooltip
            contentStyle={{ background: 'var(--theme-surface,#142032)', border: `1px solid ${T.border}`,
              fontFamily: T.mono, fontSize: 10, borderRadius: 0 }}
            labelStyle={{ color: T.gold }}
            formatter={(value: number, name: string) => {
              if (name === 'price') return [`$${value.toFixed(2)}`, 'Price']
              if (name === 'buy')   return [`$${value.toFixed(2)}`, '▲ BUY']
              if (name === 'sell')  return [`$${value.toFixed(2)}`, '▼ SELL']
              return [`${value}`, name]
            }}
          />
          {/* Price line */}
          <Line
            type="monotone"
            dataKey="price"
            stroke={T.gold}
            strokeWidth={1.5}
            dot={false}
            activeDot={{ r: 3, fill: T.gold }}
            isAnimationActive={false}
          />
          {/* BUY signals */}
          <Line
            type="monotone"
            dataKey="buy"
            stroke="transparent"
            dot={(props) => <BuyDot key={`buy-${props.index}`} cx={props.cx} cy={props.cy} payload={props.payload as ChartPoint} />}
            activeDot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
          {/* SELL signals */}
          <Line
            type="monotone"
            dataKey="sell"
            stroke="transparent"
            dot={(props) => <SellDot key={`sell-${props.index}`} cx={props.cx} cy={props.cy} payload={props.payload as ChartPoint} />}
            activeDot={false}
            isAnimationActive={false}
            connectNulls={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Strategy Panel ──────────────────────────────────────────────────────────

const btn: React.CSSProperties = {
  padding: '5px 10px', fontSize: 9, fontFamily: 'var(--theme-mono)', fontWeight: 700,
  letterSpacing: '0.08em', cursor: 'pointer', background: 'rgba(201,168,76,0.08)',
  border: '1px solid rgba(201,168,76,0.3)', color: 'var(--theme-primary, #c9a84c)',
  transition: 'background 0.15s',
}

const STRATEGY_TEMPLATE = `from strategies.base import Strategy, MarketDataPoint, Signal, StrategyMetadata
from collections import deque
from typing import Any

class MyStrategy(Strategy):
    def initialize(self, params: dict[str, Any]) -> None:
        self._period = int(params.get("period", 14))
        self._prices: deque = deque(maxlen=self._period + 1)

    def on_data(self, dp: MarketDataPoint) -> Signal:
        self._prices.append(dp.price)
        if len(self._prices) < self._period + 1:
            return Signal.HOLD
        # ── your logic here ──
        avg = sum(self._prices) / len(self._prices)
        if dp.price > avg * 1.02:
            return Signal.BUY
        if dp.price < avg * 0.98:
            return Signal.SELL
        return Signal.HOLD

    def metadata(self) -> StrategyMetadata:
        return StrategyMetadata(
            name="my_strategy", version="1.0.0",
            author="you", description="Price vs MA crossover",
            parameters={"period": {"type":"int","default":14}},
        )`

interface StrategyEntry {
  name: string; version: string; author: string; description: string
  parameters: Record<string, unknown>; enabled: boolean
}
interface ReplayEvent { strategy_name: string; timestamp: number; symbol: string; signal: string; price: number }
interface ReplayResult {
  ticker: string; bars_processed: number
  events: ReplayEvent[]
  summary: Record<string, { BUY: number; SELL: number; HOLD: number }>
}

interface RiskConfig {
  stop_loss: string
  take_profit: string
  trailing_stop: string
  max_hold: string
}
const RISK_DEFAULTS: RiskConfig = { stop_loss: '', take_profit: '', trailing_stop: '', max_hold: '' }

function applyRiskToChart(
  events: ReplayEvent[],
  riskByStrategy: Record<string, RiskConfig>,
  prices: { date: string; value: number }[],
): { date: string; price: number; buy?: number; sell?: number }[] {
  const strategyNames = [...new Set(events.map(e => e.strategy_name))]
  const finalSig: Record<string, 'BUY' | 'SELL'> = {}

  for (const name of strategyNames) {
    const risk = riskByStrategy[name] ?? RISK_DEFAULTS
    const sl   = risk.stop_loss     ? parseFloat(risk.stop_loss)     : null
    const tp   = risk.take_profit   ? parseFloat(risk.take_profit)   : null
    const ts   = risk.trailing_stop ? parseFloat(risk.trailing_stop) : null
    const mh   = risk.max_hold      ? parseInt(risk.max_hold)        : null

    const rawByDate: Record<string, 'BUY' | 'SELL'> = {}
    for (const ev of events.filter(e => e.strategy_name === name)) {
      rawByDate[new Date(ev.timestamp * 1000).toISOString().slice(0, 10)] = ev.signal as 'BUY' | 'SELL'
    }

    let inTrade = false, entryPrice = 0, peak = 0, bars = 0
    for (const bar of prices) {
      const raw = rawByDate[bar.date]
      if (!inTrade) {
        if (raw === 'BUY') {
          inTrade = true; entryPrice = bar.value; peak = bar.value; bars = 0
          finalSig[bar.date] = 'BUY'
        }
      } else {
        bars++; peak = Math.max(peak, bar.value)
        const stopHit  = sl && bar.value <= entryPrice * (1 - sl / 100)
        const tpHit    = tp && bar.value >= entryPrice * (1 + tp / 100)
        const trailHit = ts && bar.value <= peak * (1 - ts / 100)
        const timeHit  = mh && bars >= mh
        if (stopHit || tpHit || trailHit || timeHit || raw === 'SELL') {
          inTrade = false
          finalSig[bar.date] = 'SELL'
        }
      }
    }
  }

  return prices.map(p => ({
    date: p.date, price: p.value,
    buy:  finalSig[p.date] === 'BUY'  ? p.value : undefined,
    sell: finalSig[p.date] === 'SELL' ? p.value : undefined,
  }))
}

function StrategyPanel({ pendingBuilderStrategy, onApproveBuilderStrategy, onDismissBuilderStrategy, onAutomatedOrder }: {
  pendingBuilderStrategy: PendingOptionStrategy | null
  onApproveBuilderStrategy: (ps: PendingOptionStrategy) => void
  onDismissBuilderStrategy: () => void
  onAutomatedOrder?: (id: string, strategyName: string) => void
}) {
  const qc = useQueryClient()
  const { uid, authed, headers } = useAuth()
  const [open, setOpen] = useState(false)
  const [replayTicker, setReplayTicker] = useState('SPY')
  const [replayStart, setReplayStart] = useState('2024-01-01')
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null)
  const [execQty, setExecQty] = useState('1')
  const [execStatus, setExecStatus] = useState<string | null>(null)
  const [liveActive, setLiveActive] = useState(false)
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const [offlineStatus, setOfflineStatus] = useState<string | null>(null)
  const [customModalOpen, setCustomModalOpen] = useState(false)
  const liveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [liveIntervalMs, setLiveIntervalMs] = useState(15_000)
  const fileRef = useRef<HTMLInputElement>(null)

  // Per-strategy param overrides and param-editor open state
  const [stratParams, setStratParams] = useState<Record<string, Record<string, number>>>({})
  const [paramsOpen, setParamsOpen] = useState<Record<string, boolean>>({})
  const [cardOpen, setCardOpen] = useState<Record<string, boolean>>({})
  const [stratColOpen, setStratColOpen] = useState(true)

  // Per-strategy risk controls
  const [riskParams, setRiskParams] = useState<Record<string, RiskConfig>>({})
  const [riskOpen, setRiskOpen] = useState<Record<string, boolean>>({})
  // Live-mode per-strategy position state for risk tracking
  const liveTradeState = useRef<Record<string, { inTrade: boolean; entryPrice: number; peak: number; bars: number }>>({})

  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [liveChart, setLiveChart] = useState<ChartPoint[]>([])

  const { data: strategies = [] } = useQuery<StrategyEntry[]>({
    queryKey: ['paper/strategies'],
    queryFn: () => axios.get('/api/paper/strategies/').then(r => r.data),
    enabled: open,
  })

  // ── Scheduler queries (scoped to this panel, enabled when open) ──────────────
  const { data: schedulerStatus } = useQuery<SchedulerStatus>({
    queryKey: ['paper/scheduler/status'],
    queryFn: () => axios.get(`/api/paper/scheduler/status?user_id=${uid}`, headers).then(r => r.data),
    enabled: authed,
    refetchInterval: 15_000,
  })

  const { data: schedulerJobs = [] } = useQuery<SchedulerJob[]>({
    queryKey: ['paper/scheduler/jobs'],
    queryFn: () => axios.get(`/api/paper/scheduler/jobs?user_id=${uid}`, headers).then(r => r.data),
    enabled: open && authed,
    refetchInterval: open ? 15_000 : false,
  })

  const { data: schedulerLog = [] } = useQuery<SchedulerLogEntry[]>({
    queryKey: ['paper/scheduler/log'],
    queryFn: () => axios.get(`/api/paper/scheduler/log?limit=50&user_id=${uid}`, headers).then(r => r.data),
    enabled: open && authed,
    refetchInterval: open ? 30_000 : false,
  })

  const createJobMut = useMutation({
    mutationFn: (body: { ticker: string; strategy_name: string; qty: number; params: Record<string, number> }) =>
      axios.post('/api/paper/scheduler/jobs', { ...body, user_id: uid }, headers).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['paper/scheduler/jobs'] })
      qc.invalidateQueries({ queryKey: ['paper/scheduler/status'] })
    },
  })

  const deleteJobMut = useMutation({
    mutationFn: (id: string) => axios.delete(`/api/paper/scheduler/jobs/${id}?user_id=${uid}`, headers).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['paper/scheduler/jobs'] })
      qc.invalidateQueries({ queryKey: ['paper/scheduler/status'] })
    },
  })

  const toggleJobMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      axios.patch(`/api/paper/scheduler/jobs/${id}/toggle?user_id=${uid}`, { enabled }, headers).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper/scheduler/jobs'] }),
  })

  const toggleMut = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      axios.post(`/api/paper/strategies/${name}/toggle`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper/strategies'] }),
  })

  const uploadMut = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData(); fd.append('file', file)
      return axios.post('/api/paper/strategies/upload', fd)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper/strategies'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (name: string) => axios.delete(`/api/paper/strategies/${name}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper/strategies'] }),
  })

  const createCustomMut = useMutation({
    mutationFn: (body: { name: string; rules: object; bull_drift: number; bear_drift: number }) =>
      axios.post('/api/paper/strategies/custom', body).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['paper/strategies'] })
      setCustomModalOpen(false)
    },
  })

  const handleCustomSave = (def: CustomStrategyDef) => {
    saveCustomStrategy(def)
    createCustomMut.mutate({
      name: def.name,
      rules: { buy: def.buy, sell: def.sell },
      bull_drift: def.bull_drift,
      bear_drift: def.bear_drift,
    })
  }

  const replayMut = useMutation({
    mutationFn: () => axios.post('/api/paper/strategies/replay', {
      ticker: replayTicker.toUpperCase(), start: replayStart,
    }).then(r => r.data),
    onSuccess: async (d: ReplayResult) => {
      setReplayResult(d); setExecStatus(null); setLiveChart([])
      try {
        const hist = await axios.get(`/api/market/history?ticker=${d.ticker}&start=${replayStart}`)
        const prices: { date: string; value: number }[] = hist.data.price ?? []
        setChartData(applyRiskToChart(d.events, riskParams, prices))
      } catch { /* chart optional */ }
    },
  })

  const placeOrder = (symbol: string, side: 'buy' | 'sell', qty: number) =>
    axios.post('/api/paper/order', {
      user_id: uid, symbol, side, quantity: qty, order_type: 'market',
    }, headers)

  const executeSignals = async () => {
    if (!replayResult) return
    const qty = Math.max(1, parseInt(execQty) || 1)
    const events = replayResult.events.filter(e => e.signal !== 'HOLD')
    if (events.length === 0) { setExecStatus('No BUY/SELL signals to execute.'); return }
    setExecStatus(`Placing ${events.length} orders…`)
    let ok = 0, fail = 0
    for (const ev of events) {
      try {
        const r = await placeOrder(ev.symbol, ev.signal === 'BUY' ? 'buy' : 'sell', qty)
        const orderId = r.data?.order?.id ?? r.data?.id
        if (orderId) onAutomatedOrder?.(String(orderId), 'Replay')
        ok++
      } catch { fail++ }
    }
    setExecStatus(`Done — ${ok} placed${fail ? `, ${fail} failed` : ''}.`)
    qc.invalidateQueries({ queryKey: ['account'] })
  }

  const startLive = () => {
    const ticker = replayTicker.toUpperCase()
    const qty = Math.max(1, parseInt(execQty) || 1)
    const scalping = strategies.some(s => s.enabled && s.name === 'micro_scalp')
    const intervalMs = scalping ? 3_000 : 15_000
    setLiveIntervalMs(intervalMs)
    setLiveActive(true)
    setLiveStatus(`Live — waiting for first tick… (${scalping ? '3s' : '15s'} interval)`)
    setLiveChart([])
    setChartData([])
    liveTradeState.current = {}
    liveIntervalRef.current = setInterval(async () => {
      try {
        const priceRes = await axios.get(`/api/market/quote/${ticker}`)
        const price: number = priceRes.data?.current_price ?? priceRes.data?.last ?? priceRes.data?.price
        if (!price) return
        const now = new Date().toLocaleTimeString()
        const rawSignals: { strategy_name: string; signal: string }[] =
          await axios.post('/api/paper/strategies/tick', {
            timestamp: Date.now() / 1000, symbol: ticker, price, size: 0, side: 'trade',
          }).then(r => r.data)

        // Apply per-strategy risk overrides
        const signals = rawSignals.map(s => {
          const state = liveTradeState.current[s.strategy_name] ??
            (liveTradeState.current[s.strategy_name] = { inTrade: false, entryPrice: 0, peak: 0, bars: 0 })
          const risk = riskParams[s.strategy_name] ?? RISK_DEFAULTS
          const sl  = risk.stop_loss     ? parseFloat(risk.stop_loss)     : null
          const tp  = risk.take_profit   ? parseFloat(risk.take_profit)   : null
          const ts  = risk.trailing_stop ? parseFloat(risk.trailing_stop) : null
          const mh  = risk.max_hold      ? parseInt(risk.max_hold)        : null

          if (s.signal === 'BUY' && !state.inTrade) {
            state.inTrade = true; state.entryPrice = price; state.peak = price; state.bars = 0
            return s
          }
          if (state.inTrade) {
            state.bars++; state.peak = Math.max(state.peak, price)
            const stopHit  = sl && price <= state.entryPrice * (1 - sl / 100)
            const tpHit    = tp && price >= state.entryPrice * (1 + tp / 100)
            const trailHit = ts && price <= state.peak * (1 - ts / 100)
            const timeHit  = mh && state.bars >= mh
            if (stopHit || tpHit || trailHit || timeHit) {
              state.inTrade = false
              return { ...s, signal: 'SELL' }
            }
            if (s.signal === 'SELL') { state.inTrade = false; return s }
          }
          return s
        })

        const firstSig = signals.find(s => s.signal === 'BUY' || s.signal === 'SELL')
        setLiveChart(prev => [...prev.slice(-199), {
          date: now, price,
          buy:  firstSig?.signal === 'BUY'  ? price : undefined,
          sell: firstSig?.signal === 'SELL' ? price : undefined,
        }])
        for (const s of signals) {
          if (s.signal === 'BUY' || s.signal === 'SELL') {
            const r = await placeOrder(ticker, s.signal === 'BUY' ? 'buy' : 'sell', qty)
            const orderId = r.data?.order?.id ?? r.data?.id
            if (orderId) onAutomatedOrder?.(String(orderId), s.strategy_name)
            setLiveStatus(`${now} — ${s.strategy_name}: ${s.signal} ${qty}x ${ticker} @ $${price.toFixed(2)}`)
            qc.invalidateQueries({ queryKey: ['account'] })
          }
        }
        if (!firstSig) setLiveStatus(`${now} — ${ticker} $${price.toFixed(2)} · HOLD`)
      } catch (e) {
        setLiveStatus(`Error: ${(e as Error).message}`)
      }
    }, intervalMs)
  }

  const stopLive = () => {
    if (liveIntervalRef.current) clearInterval(liveIntervalRef.current)
    setLiveActive(false)
    setLiveStatus(null)
  }

  const runOffline = async () => {
    const ticker = replayTicker.toUpperCase()
    const qty = Math.max(1, parseInt(execQty) || 1)
    const active = strategies.filter(s => s.enabled)
    if (active.length === 0) { setOfflineStatus('Enable at least one strategy first.'); return }
    setOfflineStatus('Scheduling…')
    let created = 0
    for (const s of active) {
      const defaults = PAPER_DEFAULT_PARAMS[s.name] ?? {}
      const overrides = stratParams[s.name] ?? {}
      const risk = riskParams[s.name] ?? RISK_DEFAULTS
      const riskNums: Record<string, number> = {}
      if (risk.stop_loss)     riskNums.stop_loss     = parseFloat(risk.stop_loss)
      if (risk.take_profit)   riskNums.take_profit   = parseFloat(risk.take_profit)
      if (risk.trailing_stop) riskNums.trailing_stop = parseFloat(risk.trailing_stop)
      if (risk.max_hold)      riskNums.max_hold      = parseInt(risk.max_hold)
      try {
        await createJobMut.mutateAsync({ ticker, strategy_name: s.name, qty, params: { ...defaults, ...overrides, ...riskNums } })
        created++
      } catch { /* skip duplicates or unknown strategies */ }
    }
    const hasScalp = active.some(s => s.name === 'micro_scalp')
    const intervalNote = hasScalp
      ? active.length > 1
        ? 'micro_scalp every 3s, others every 60s'
        : 'every 3s'
      : 'every 60s'
    setOfflineStatus(`Scheduled ${created} job${created !== 1 ? 's' : ''} for ${ticker} — ${intervalNote} during market hours`)
  }

  useEffect(() => () => { if (liveIntervalRef.current) clearInterval(liveIntervalRef.current) }, [])

  // All jobs grouped by ticker
  const allTickers = [...new Set(schedulerJobs.map(j => j.ticker))].sort()
  const sigColor   = (s: string) => s === 'BUY' ? T.pos : s === 'SELL' ? T.neg : T.dim

  return (
    <div style={{ marginTop: 10, border: `1px solid ${T.border}`, background: T.surface, flexShrink: 0 }}>
      {/* Header / toggle */}
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 14px', background: 'none', border: 'none', cursor: 'pointer',
          borderBottom: open ? `1px solid ${T.border}` : 'none',
        }}
      >
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color: T.gold, fontFamily: T.mono }}>STRATEGIES</span>

        {/* Enabled-for-replay/live count */}
        {(() => {
          const enabledN = strategies.filter(s => s.enabled).length
          return (
            <span style={{
              fontSize: 8, padding: '1px 5px', fontFamily: T.mono, letterSpacing: '0.07em',
              border: `1px solid ${enabledN > 0 ? 'rgba(201,168,76,0.4)' : T.border}`,
              color: enabledN > 0 ? T.gold : T.muted,
              background: enabledN > 0 ? 'rgba(201,168,76,0.06)' : 'transparent',
            }}>
              {enabledN} / {strategies.length} enabled
            </span>
          )
        })()}

        {/* Offline scheduler jobs — separate from "enabled" above */}
        {schedulerStatus && schedulerStatus.active_jobs > 0 && (
          <span style={{
            fontSize: 8, padding: '1px 5px', fontFamily: T.mono, letterSpacing: '0.07em',
            border: '1px solid rgba(34,197,94,0.4)', color: T.pos, background: 'rgba(34,197,94,0.06)',
          }}>
            {schedulerStatus.active_jobs} scheduler job{schedulerStatus.active_jobs !== 1 ? 's' : ''} running
          </span>
        )}

        {pendingBuilderStrategy && (
          <span style={{ fontSize: 9, fontWeight: 700, color: T.gold, fontFamily: T.mono,
            padding: '1px 6px', border: `1px solid ${T.gold}`, marginLeft: 4, animation: 'pulse 1.5s infinite' }}>
            PENDING
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: T.muted }}>{open ? '▲' : '▼'}</span>
      </button>

      {/* Pending strategy from Strategy Builder */}
      {pendingBuilderStrategy && (
        <div style={{ padding: '10px 14px', background: 'rgba(201,168,76,0.07)',
          borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.gold, fontFamily: T.mono, marginBottom: 3 }}>
              ↗ From Strategy Builder: <span style={{ color: T.text }}>{pendingBuilderStrategy.name}</span>
            </div>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>
              {pendingBuilderStrategy.underlying} · {pendingBuilderStrategy.legs.length} legs · {pendingBuilderStrategy.orderType}
              {' · '}saved {new Date(pendingBuilderStrategy.savedAt).toLocaleTimeString()}
            </div>
            <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {pendingBuilderStrategy.legs.map((l, i) => (
                <span key={i} style={{ fontSize: 8, fontFamily: T.mono, color: l.side === 'buy_to_open' ? T.pos : T.neg,
                  padding: '1px 5px', border: `1px solid ${l.side === 'buy_to_open' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
                  {l.side === 'buy_to_open' ? '▲' : '▼'} {l.occ}
                </span>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => onApproveBuilderStrategy(pendingBuilderStrategy)}
              style={{ padding: '6px 14px', fontSize: 10, fontFamily: T.mono, fontWeight: 700,
                cursor: 'pointer', border: 'none', background: T.gold, color: 'var(--theme-bg)', letterSpacing: '0.1em' }}>
              APPROVE
            </button>
            <button onClick={onDismissBuilderStrategy}
              style={{ padding: '6px 10px', fontSize: 10, fontFamily: T.mono, cursor: 'pointer',
                border: `1px solid ${T.border}`, background: 'transparent', color: T.muted }}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {open && (
        <div>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>

          {/* Strategy list — collapsible column */}
          <div style={{ flex: stratColOpen ? 1 : 'none', minWidth: stratColOpen ? 300 : 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
              <button
                onClick={() => setStratColOpen(o => !o)}
                title={stratColOpen ? 'Collapse strategy list' : 'Expand strategy list'}
                style={{
                  background: 'none', border: `1px solid ${T.border}`, color: T.muted,
                  cursor: 'pointer', padding: '1px 6px', fontFamily: T.mono, fontSize: 9, flexShrink: 0,
                }}
              >{stratColOpen ? '◀ Hide' : '▶ Strategies'}</button>
              {stratColOpen && (
                <>
                  <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, textTransform: 'uppercase' }}>
                    Strategies
                  </span>
                  <HelpTip width={280} position="right" text="Enable or disable strategies that run during live auto-trade, replay, and Run Offline. Expand Parameters to set each strategy's options. They flow through to all three execution modes." />
                </>
              )}
            </div>

            {/* Status summary (always shown when column is open) */}
            {stratColOpen && (() => {
              const enabledStrats = strategies.filter(s => s.enabled)
              const jobCount = schedulerStatus?.active_jobs ?? 0
              return (
                <div style={{
                  marginBottom: 8, padding: '7px 10px',
                  background: 'rgba(0,0,0,0.15)', border: `1px solid ${T.border}`,
                  fontSize: 9, fontFamily: T.mono, display: 'flex', flexDirection: 'column', gap: 4,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: T.muted }}>For Replay / Live:</span>
                    <span style={{ color: enabledStrats.length > 0 ? T.gold : T.dim, fontWeight: 700 }}>
                      {enabledStrats.length === 0
                        ? 'none enabled'
                        : enabledStrats.map(s => BUILTIN_STRATEGY_INFO[s.name]?.label ?? s.name).join(', ')}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: T.muted }}>Scheduler jobs (server-side):</span>
                    <span style={{ color: jobCount > 0 ? T.pos : T.dim, fontWeight: 700 }}>
                      {jobCount > 0 ? `${jobCount} running` : 'none'}
                    </span>
                  </div>
                </div>
              )
            })()}
            {stratColOpen && strategies.length === 0 && (
              <div style={{ fontSize: 10, color: T.dim, fontFamily: T.mono }}>No strategies loaded.</div>
            )}
            {stratColOpen && strategies.map(s => {
              const info = BUILTIN_STRATEGY_INFO[s.name]
              const defaults = PAPER_DEFAULT_PARAMS[s.name] ?? {}
              const labels  = PAPER_PARAM_LABELS[s.name]  ?? {}
              const overrides = stratParams[s.name] ?? {}
              const merged  = { ...defaults, ...overrides }
              const paramKeys = Object.keys(defaults)
              const pOpen = paramsOpen[s.name] ?? false
              const risk  = riskParams[s.name] ?? RISK_DEFAULTS
              const rOpen = riskOpen[s.name] ?? false
              const cOpen = cardOpen[s.name] ?? false
              const hasRisk = !!(risk.stop_loss || risk.take_profit || risk.trailing_stop || risk.max_hold)
              const hasCustomParams = Object.keys(overrides).length > 0
              const setRisk = (k: keyof RiskConfig, v: string) =>
                setRiskParams(prev => ({ ...prev, [s.name]: { ...(prev[s.name] ?? RISK_DEFAULTS), [k]: v } }))
              return (
                <div key={s.name} style={{ marginBottom: 4,
                  border: `1px solid ${s.enabled ? 'rgba(201,168,76,0.25)' : T.border}`,
                  background: s.enabled ? 'rgba(201,168,76,0.03)' : 'var(--theme-hover, rgba(255,255,255,0.01))' }}>

                  {/* ── Collapsed header row (always visible) ── */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                    {/* Expand/collapse toggle */}
                    <button
                      onClick={() => setCardOpen(p => ({ ...p, [s.name]: !cOpen }))}
                      style={{
                        padding: '8px 8px 8px 10px', background: 'none', border: 'none', cursor: 'pointer',
                        color: T.dim, fontSize: 9, flexShrink: 0, lineHeight: 1,
                      }}
                      title={cOpen ? 'Collapse' : 'Expand settings'}
                    >
                      {cOpen ? '▼' : '▶'}
                    </button>

                    {/* Strategy name — clicking also expands */}
                    <button
                      onClick={() => setCardOpen(p => ({ ...p, [s.name]: !cOpen }))}
                      style={{
                        flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer',
                        padding: '8px 4px',
                      }}
                    >
                      <span style={{ fontSize: 11, fontWeight: 700, color: s.enabled ? T.text : T.muted, fontFamily: T.mono }}>
                        {info?.label ?? s.name}
                      </span>
                      {/* Inline status indicators when collapsed */}
                      {!cOpen && (
                        <span style={{ marginLeft: 8, fontSize: 8, color: T.dim, fontFamily: T.mono }}>
                          {hasCustomParams && <span style={{ color: T.gold, marginRight: 5 }}>customised</span>}
                          {hasRisk && <span style={{ color: T.warn, marginRight: 5 }}>risk</span>}
                          <span style={{ color: T.dim }}>{s.description?.slice(0, 48)}{(s.description?.length ?? 0) > 48 ? '…' : ''}</span>
                        </span>
                      )}
                    </button>

                    {info && <HelpTip width={300} position="right" text={info.help} />}

                    {/* ON/OFF toggle */}
                    <button
                      onClick={(e) => { e.stopPropagation(); toggleMut.mutate({ name: s.name, enabled: !s.enabled }) }}
                      style={{
                        padding: '3px 8px', fontSize: 9, fontFamily: T.mono, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                        borderColor: s.enabled ? 'rgba(34,197,94,0.5)' : T.border,
                        background: s.enabled ? 'rgba(34,197,94,0.1)' : 'transparent',
                        color: s.enabled ? T.pos : T.muted, letterSpacing: '0.08em',
                        margin: '0 4px', flexShrink: 0,
                      }}
                    >{s.enabled ? 'ON' : 'OFF'}</button>

                    {s.author !== 'builtin' && (
                      <button onClick={(e) => { e.stopPropagation(); deleteMut.mutate(s.name) }}
                        style={{ background: 'none', border: 'none', color: T.neg, cursor: 'pointer', fontSize: 12, padding: '0 8px', flexShrink: 0 }}>×</button>
                    )}
                  </div>

                  {/* ── Expanded body (collapsible) ── */}
                  {cOpen && (
                    <div style={{ padding: '6px 10px 10px', borderTop: `1px solid ${T.border}` }}>
                      {/* Description */}
                      <div style={{ fontSize: 9, color: T.dim, marginBottom: 8, fontFamily: T.mono, lineHeight: '14px' }}>
                        {s.description}
                      </div>

                      {/* Parameters */}
                      {paramKeys.length > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          <button
                            onClick={() => setParamsOpen(p => ({ ...p, [s.name]: !pOpen }))}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 4,
                              fontSize: 9, fontFamily: T.mono, color: pOpen ? T.gold : T.muted,
                              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                              letterSpacing: '0.08em',
                            }}
                          >
                            <span style={{ fontSize: 8 }}>{pOpen ? '▼' : '▶'}</span> Parameters
                            {hasCustomParams && (
                              <span style={{ fontSize: 7, color: T.gold, fontFamily: T.mono, padding: '0 3px',
                                border: '1px solid rgba(201,168,76,0.4)', marginLeft: 2 }}>customised</span>
                            )}
                          </button>
                          {pOpen && (
                            <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {paramKeys.map(key => (
                                <div key={key} style={{ minWidth: 70, flex: 1 }}>
                                  <span style={{ ...lbl, fontSize: 8 }}>{labels[key] ?? key}</span>
                                  <input
                                    type="number"
                                    value={merged[key] ?? defaults[key]}
                                    step={key.includes('ratio') || key === 'std_dev' ? 0.1 : 1}
                                    onChange={e => setStratParams(p => ({
                                      ...p,
                                      [s.name]: { ...(p[s.name] ?? {}), [key]: parseFloat(e.target.value) || defaults[key] },
                                    }))}
                                    style={{ ...inp, fontSize: 11, padding: '4px 6px' }}
                                  />
                                </div>
                              ))}
                              {hasCustomParams && (
                                <div style={{ width: '100%' }}>
                                  <button
                                    onClick={() => setStratParams(p => { const n = { ...p }; delete n[s.name]; return n })}
                                    style={{ fontSize: 8, fontFamily: T.mono, color: T.muted, background: 'none',
                                      border: `1px solid ${T.border}`, padding: '1px 6px', cursor: 'pointer' }}
                                  >↺ Reset defaults</button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Risk controls */}
                      <div style={{ marginBottom: 6 }}>
                        <button
                          onClick={() => setRiskOpen(p => ({ ...p, [s.name]: !rOpen }))}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 4,
                            fontSize: 9, fontFamily: T.mono, color: rOpen ? T.warn : hasRisk ? T.warn : T.muted,
                            background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                            letterSpacing: '0.08em',
                          }}
                        >
                          <span style={{ fontSize: 8 }}>{rOpen ? '▼' : '▶'}</span> Risk Controls
                          {hasRisk && (
                            <span style={{ fontSize: 7, color: T.warn, padding: '0 3px',
                              border: '1px solid color-mix(in srgb, var(--theme-warn) 40%, transparent)', marginLeft: 2 }}>active</span>
                          )}
                        </button>
                        {rOpen && (
                          <div style={{ marginTop: 6, padding: '8px 10px', background: 'color-mix(in srgb, var(--theme-warn) 4%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-warn) 15%, transparent)' }}>
                            <div style={{ fontSize: 8, color: T.dim, fontFamily: T.mono, marginBottom: 8, lineHeight: '12px' }}>
                              Leave blank to disable. Applied to replay chart, live mode, and scheduled jobs.
                            </div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {([
                                { key: 'stop_loss' as const,     label: 'Stop Loss %',     help: 'Exit if price drops X% from entry. e.g. 2' },
                                { key: 'take_profit' as const,   label: 'Take Profit %',   help: 'Exit if price rises X% from entry. e.g. 5' },
                                { key: 'trailing_stop' as const, label: 'Trailing Stop %', help: 'Exit if price drops X% from its peak since entry. e.g. 1.5' },
                                { key: 'max_hold' as const,      label: 'Max Hold (days)', help: 'Force exit after N trading days regardless of signal.' },
                              ] as { key: keyof RiskConfig; label: string; help: string }[]).map(({ key, label, help }) => (
                                <div key={key} style={{ minWidth: 80, flex: 1 }}>
                                  <span style={{ ...lbl, fontSize: 8, color: 'color-mix(in srgb, var(--theme-warn) 70%, var(--theme-secondary))' }}>{label}</span>
                                  <input
                                    type="number"
                                    min={0}
                                    step={key === 'max_hold' ? 1 : 0.1}
                                    placeholder="off"
                                    value={risk[key]}
                                    title={help}
                                    onChange={e => setRisk(key, e.target.value)}
                                    style={{ ...inp, fontSize: 11, padding: '4px 6px', borderColor: risk[key] ? 'color-mix(in srgb, var(--theme-warn) 40%, transparent)' : undefined }}
                                  />
                                </div>
                              ))}
                            </div>
                            {hasRisk && (
                              <button
                                onClick={() => setRiskParams(p => { const n = { ...p }; delete n[s.name]; return n })}
                                style={{ marginTop: 6, fontSize: 8, fontFamily: T.mono, color: T.muted, background: 'none',
                                  border: `1px solid ${T.border}`, padding: '1px 6px', cursor: 'pointer' }}
                              >↺ Clear risk</button>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Cross-tool badges */}
                      {info && info.usedIn.length > 0 && (
                        <div style={{ display: 'flex', gap: 4 }}>
                          {info.usedIn.includes('backtester') && (
                            <a href="/backtester" style={{ textDecoration: 'none' }}>
                              <span style={{ fontSize: 8, padding: '1px 5px', border: '1px solid rgba(96,165,250,0.4)',
                                color: '#60a5fa', fontFamily: T.mono, cursor: 'pointer', letterSpacing: '0.06em' }}>↗ BACKTESTER</span>
                            </a>
                          )}
                          {info.usedIn.includes('montecarlo') && (
                            <a href="/monte-carlo" style={{ textDecoration: 'none' }}>
                              <span style={{ fontSize: 8, padding: '1px 5px', border: '1px solid rgba(167,139,250,0.4)',
                                color: '#a78bfa', fontFamily: T.mono, cursor: 'pointer', letterSpacing: '0.06em' }}>↗ MONTE CARLO</span>
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Upload + Build Custom */}
            {stratColOpen && (
              <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                <input ref={fileRef} type="file" accept=".py" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadMut.mutate(f) }} />
                <button onClick={() => fileRef.current?.click()} style={{ ...btn, flex: 1 }}>
                  {uploadMut.isPending ? 'Uploading…' : '↑ Upload (.py)'}
                </button>
                <button
                  onClick={() => setCustomModalOpen(true)}
                  style={{ ...btn, flex: 1, borderColor: 'rgba(201,168,76,0.5)', color: T.gold }}
                >Build Custom</button>
              </div>
            )}
            {stratColOpen && uploadMut.isError && (
              <div style={{ marginTop: 4, fontSize: 9, color: T.neg, fontFamily: T.mono }}>
                {(uploadMut.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Upload failed'}
              </div>
            )}
            {stratColOpen && createCustomMut.isError && (
              <div style={{ marginTop: 4, fontSize: 9, color: T.neg, fontFamily: T.mono }}>
                {(createCustomMut.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Failed to create strategy'}
              </div>
            )}

            {/* Strategy Library — saved custom strategies from other tools */}
            {stratColOpen && (() => {
              const registeredNames = new Set(strategies.map(s => s.name))
              const unregistered = loadCustomStrategies().filter(d => !registeredNames.has(d.name))
              if (unregistered.length === 0) return null
              return (
                <div style={{ marginTop: 10, padding: '8px 10px', border: `1px solid rgba(201,168,76,0.2)`, background: 'rgba(201,168,76,0.04)' }}>
                  <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, marginBottom: 6, fontFamily: T.mono }}>
                    Strategy Library
                  </div>
                  <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono, marginBottom: 8 }}>
                    Strategies built in Monte Carlo / Backtester — click Register to add to paper trading
                  </div>
                  {unregistered.map(def => {
                    const buyCount  = def.buy.groups.reduce((s, g) => s + g.conditions.length, 0)
                    const sellCount = def.sell.groups.reduce((s, g) => s + g.conditions.length, 0)
                    return (
                      <div key={def.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', borderBottom: `1px solid ${T.border}` }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: T.text, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {def.name}
                          </div>
                          <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>
                            B:{buyCount} cond · S:{sellCount} cond
                          </div>
                        </div>
                        <button
                          onClick={() => createCustomMut.mutate({
                            name: def.name,
                            rules: { buy: def.buy, sell: def.sell },
                            bull_drift: def.bull_drift ?? 0,
                            bear_drift: def.bear_drift ?? 0,
                          })}
                          disabled={createCustomMut.isPending}
                          style={{ ...btn, fontSize: 8, padding: '3px 8px', borderColor: 'rgba(201,168,76,0.4)', color: T.gold, flexShrink: 0 }}
                        >
                          + Register
                        </button>
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </div>

          {/* Replay + Live + Offline */}
          <div style={{ width: 300, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, textTransform: 'uppercase' }}>
                Replay & Execute
              </span>
              <HelpTip width={290} position="right" text="Replay runs enabled strategies against historical closes. Start Live polls the market every 15s and places orders in your browser session. Run Offline schedules server-side jobs that trade automatically even when this page is closed. It uses the params set per strategy above." />
            </div>

            {/* Ticker / date / qty */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
              <input value={replayTicker} onChange={e => setReplayTicker(e.target.value.toUpperCase())}
                placeholder="Ticker" style={{ ...inp, width: 70 }} />
              <input value={replayStart} onChange={e => setReplayStart(e.target.value)}
                type="date" style={{ ...inp, flex: 1 }} />
              <input value={execQty} onChange={e => setExecQty(e.target.value)}
                placeholder="Qty" style={{ ...inp, width: 46 }} />
            </div>

            {/* Replay */}
            <button
              onClick={() => replayMut.mutate()}
              disabled={replayMut.isPending || strategies.filter(s => s.enabled).length === 0}
              style={{ ...btn, width: '100%', marginBottom: 6 }}
            >
              {replayMut.isPending ? 'Running…' : '▶ Run Replay'}
            </button>

            {replayResult && (
              <>
                <div style={{ fontSize: 9, fontFamily: T.mono, marginBottom: 6 }}>
                  <div style={{ color: T.muted, marginBottom: 4 }}>
                    {replayResult.ticker} · {replayResult.bars_processed} bars
                  </div>
                  {Object.entries(replayResult.summary).map(([name, counts]) => (
                    <div key={name} style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
                      <span style={{ color: T.gold, flex: 1 }}>{name}</span>
                      <span style={{ color: T.pos }}>B:{counts.BUY}</span>
                      <span style={{ color: T.neg }}>S:{counts.SELL}</span>
                      <span style={{ color: T.muted }}>H:{counts.HOLD}</span>
                    </div>
                  ))}
                  {replayResult.events.length === 0 && (
                    <div style={{ color: T.dim }}>No BUY/SELL signals.</div>
                  )}
                </div>
                {replayResult.events.length > 0 && (
                  <button
                    onClick={executeSignals}
                    style={{ ...btn, width: '100%', marginBottom: 4,
                      borderColor: 'rgba(201,168,76,0.6)', background: 'rgba(201,168,76,0.14)' }}
                  >
                    Execute {replayResult.events.filter(e => e.signal !== 'HOLD').length} Signal Orders
                  </button>
                )}
                {execStatus && (
                  <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>{execStatus}</div>
                )}
              </>
            )}

            {/* Live + Offline buttons */}
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 4 }}>
              <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, marginBottom: 6, textTransform: 'uppercase' }}>
                Live & Offline
                <HelpTip width={270} position="top" text="Start Live: polls price every 15s (3s for EMA Micro-Scalp) in this browser tab. Stops when you close the page. Run Offline: registers server-side jobs that run every 60s (3s for EMA Micro-Scalp) during market hours using the params configured per strategy above, even with the browser closed." />
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                {!liveActive ? (
                  <button
                    onClick={startLive}
                    disabled={strategies.filter(s => s.enabled).length === 0}
                    style={{ ...btn, flex: 1, borderColor: 'rgba(34,197,94,0.4)', color: T.pos }}
                  >● Start Live</button>
                ) : (
                  <button onClick={stopLive}
                    style={{ ...btn, flex: 1, borderColor: 'rgba(239,68,68,0.4)', color: T.neg }}>■ Stop Live</button>
                )}
                <button
                  onClick={runOffline}
                  disabled={strategies.filter(s => s.enabled).length === 0}
                  style={{ ...btn, flex: 1, borderColor: 'rgba(96,165,250,0.4)', color: '#60a5fa' }}
                >Run Offline</button>
              </div>

              {liveStatus && (
                <div style={{ fontSize: 9, color: liveActive ? T.pos : T.muted, fontFamily: T.mono, wordBreak: 'break-all', marginBottom: 4 }}>
                  {liveStatus}
                </div>
              )}
              {offlineStatus && (
                <div style={{ fontSize: 9, color: '#60a5fa', fontFamily: T.mono, wordBreak: 'break-all', marginBottom: 6 }}>
                  {offlineStatus}
                </div>
              )}

              {/* Scheduler status pills */}
              {schedulerStatus && (
                <div style={{ display: 'flex', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: 8, padding: '1px 5px', fontFamily: T.mono,
                    border: `1px solid ${schedulerStatus.scheduler_running ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)'}`,
                    color: schedulerStatus.scheduler_running ? T.pos : T.neg,
                    background: schedulerStatus.scheduler_running ? 'rgba(34,197,94,0.06)' : 'rgba(239,68,68,0.06)',
                  }}>
                    {schedulerStatus.scheduler_running ? '● RUNNING' : '○ STOPPED'}
                  </span>
                  <span style={{
                    fontSize: 8, padding: '1px 5px', fontFamily: T.mono,
                    border: `1px solid ${schedulerStatus.market_open ? 'rgba(201,168,76,0.4)' : T.border}`,
                    color: schedulerStatus.market_open ? T.gold : T.muted,
                  }}>
                    {schedulerStatus.market_open ? 'MARKET OPEN' : 'CLOSED'}
                  </span>
                  {schedulerStatus.active_jobs > 0 && (
                    <span style={{ fontSize: 8, padding: '1px 5px', fontFamily: T.mono, color: T.muted, border: `1px solid ${T.border}` }}>
                      {schedulerStatus.active_jobs} job{schedulerStatus.active_jobs !== 1 ? 's' : ''} active
                    </span>
                  )}
                </div>
              )}

              {/* All scheduler jobs grouped by ticker */}
              {schedulerJobs.length > 0 && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, textTransform: 'uppercase', marginBottom: 4 }}>
                    Active Jobs — All Tickers
                  </div>
                  {allTickers.map(ticker => {
                    const jobs = schedulerJobs.filter(j => j.ticker === ticker)
                    return (
                      <div key={ticker} style={{ marginBottom: 6 }}>
                        <div style={{
                          fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
                          color: ticker === replayTicker.toUpperCase() ? T.gold : T.muted,
                          fontFamily: T.mono, marginBottom: 3, paddingLeft: 2,
                        }}>
                          {ticker}
                          {ticker === replayTicker.toUpperCase() && (
                            <span style={{ fontWeight: 400, color: T.dim, marginLeft: 5 }}>selected</span>
                          )}
                        </div>
                        {jobs.map(job => (
                          <div key={job.id} style={{
                            display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2,
                            padding: '4px 7px',
                            border: `1px solid ${job.enabled ? 'rgba(201,168,76,0.2)' : T.border}`,
                            background: job.enabled ? 'rgba(201,168,76,0.03)' : 'transparent',
                          }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 10, fontFamily: T.mono, color: T.text, fontWeight: 600 }}>
                                {BUILTIN_STRATEGY_INFO[job.strategy_name]?.label ?? job.strategy_name}
                              </div>
                              {job.last_signal ? (
                                <div style={{ fontSize: 8, fontFamily: T.mono, color: sigColor(job.last_signal) }}>
                                  {job.last_signal} @ ${job.last_price?.toFixed(2)}
                                  {job.warmed_up
                                    ? <span style={{ color: T.dim }}> · ready</span>
                                    : <span style={{ color: T.dim }}> · warming</span>
                                  }
                                </div>
                              ) : (
                                <div style={{ fontSize: 8, fontFamily: T.mono, color: T.dim }}>
                                  {job.warmed_up ? 'ready · no signal yet' : 'warming up…'}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => toggleJobMut.mutate({ id: job.id, enabled: !job.enabled })}
                              style={{
                                padding: '1px 6px', fontSize: 8, fontFamily: T.mono, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                                borderColor: job.enabled ? 'rgba(34,197,94,0.5)' : T.border,
                                background: job.enabled ? 'rgba(34,197,94,0.1)' : 'transparent',
                                color: job.enabled ? T.pos : T.muted, flexShrink: 0,
                              }}
                            >{job.enabled ? 'ON' : 'OFF'}</button>
                            <button
                              onClick={() => deleteJobMut.mutate(job.id)}
                              style={{ background: 'none', border: 'none', color: T.neg, cursor: 'pointer', fontSize: 13, padding: '0 2px', flexShrink: 0 }}
                            >×</button>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Recent activity — all tickers */}
              {schedulerLog.length > 0 && (
                <div>
                  <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, textTransform: 'uppercase', marginBottom: 3 }}>
                    Recent Activity
                  </div>
                  {schedulerLog.slice(0, 10).map(e => (
                    <div key={e.id} style={{ display: 'flex', gap: 5, alignItems: 'baseline',
                      padding: '2px 0', borderBottom: `1px solid ${T.border}` }}>
                      <span style={{ fontSize: 7, color: T.dim, fontFamily: T.mono, whiteSpace: 'nowrap' }}>
                        {new Date(e.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span style={{ fontSize: 8, fontWeight: 700, color: sigColor(e.signal), fontFamily: T.mono }}>{e.signal}</span>
                      <span style={{ fontSize: 8, color: T.gold, fontFamily: T.mono, fontWeight: 700 }}>{e.ticker}</span>
                      <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>${e.price.toFixed(2)}</span>
                      <span style={{ fontSize: 7, color: T.dim, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {e.strategy_name}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

        </div>

        {/* Signal chart — replay or live */}
        {(chartData.length > 0 || liveChart.length > 0) && (
          <StrategySignalChart
            data={liveActive ? liveChart : chartData}
            ticker={replayTicker}
            mode={liveActive ? 'live' : 'replay'}
            intervalMs={liveIntervalMs}
          />
        )}
        </div>
      )}

      <CustomStrategyModal
        open={customModalOpen}
        onClose={() => setCustomModalOpen(false)}
        onSave={handleCustomSave}
      />
    </div>
  )
}

// ─── Scheduler interfaces (used by StrategyPanel) ─────────────────────────────

interface SchedulerStatus {
  scheduler_running: boolean
  market_open: boolean
  poll_interval_s: number
  total_jobs: number
  active_jobs: number
  log_entries: number
}

interface SchedulerJob {
  id: string
  ticker: string
  strategy_name: string
  params: Record<string, unknown>
  qty: number
  enabled: boolean
  warmed_up: boolean
  last_signal: string | null
  last_price: number | null
  last_run_ts: number | null
  created_at: number
}

interface SchedulerLogEntry {
  id: string
  job_id: string
  ticker: string
  strategy_name: string
  signal: string
  price: number
  timestamp: number
  order_id: string | null
  notes: string | null
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
