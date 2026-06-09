import { useState, useEffect, useRef } from 'react'
import axios from 'axios'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ComposedChart, Line } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import HelpTip from '../components/HelpTip'
import { GammaScalpingContent } from './GammaScalping'

// ─── Theme tokens ────────────────────────────────────────────────────────────
const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #142032)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  pos:     '#22c55e',
  neg:     '#ef4444',
  orange:  '#f97316',
  dim:     'var(--theme-text-muted, var(--theme-text-muted, rgba(215,227,252,0.35)))',
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

// ─── Multi-leg leg row ────────────────────────────────────────────────────────
interface LegState { symbol: string; side: string; qty: string }
const EMPTY_LEG: LegState = { symbol: '', side: 'buy_to_open', qty: '1' }

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
  index, leg, hint, onChange, onRemove, canRemove,
}: {
  index: number
  leg: LegState
  hint?: string
  onChange: (l: LegState) => void
  onRemove: () => void
  canRemove: boolean
}) {
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
  const [opSymbol, setOpSymbol]         = useState('')
  const [opSide, setOpSide]             = useState('buy_to_open')
  const [opQty, setOpQty]               = useState('')
  const [opType, setOpType]             = useState('market')
  const [opPrice, setOpPrice]           = useState('')
  const [opDur, setOpDur]               = useState('day')

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
    setMlLegs(tpl.legs.map(l => ({ symbol: '', side: l.side, qty: l.qty })))
    setMlLegHints(tpl.legs.map(l => l.hint))
  }

  useEffect(() => {
    if (!importTemplate) return
    setTab('multileg')
    applyTemplate(importTemplate)
    // If real OCC symbols provided (from Strategy Builder), overwrite leg symbols + underlying
    if (importOCCLegs) {
      setMlLegs(importOCCLegs.map(l => ({ symbol: l.symbol, side: l.side, qty: l.qty })))
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
                  >✕ clear</button>
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
                    <stop offset="5%"  stopColor={up ? '#22c55e' : '#ef4444'} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={up ? '#22c55e' : '#ef4444'} stopOpacity={0.02} />
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
function OrdersPanel({ orders, onCancel, onCancelAll, cancelAllPending, cancelAllError }: {
  orders: Order[]
  onCancel: (id: string) => void
  onCancelAll: () => void
  cancelAllPending?: boolean
  cancelAllError?: boolean
}) {
  const isPending = (status: string) =>
    ['pending', 'open', 'partially_filled'].includes(status?.toLowerCase())

  const pendingOrders = orders.filter(o => isPending(o.status))

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
            {cancelAllPending ? 'Cancelling…' : cancelAllError ? '✕ Failed — retry' : `✕ CANCEL ALL (${pendingOrders.length})`}
          </button>
        )}
      </div>
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

  const cancelAllMutation = useMutation({
    mutationFn: async () => {
      const pending = (orders ?? []).filter(o =>
        ['pending', 'open', 'partially_filled'].includes((o.status ?? '').toLowerCase()))
      if (pending.length === 0) return
      const results = await Promise.allSettled(pending.map(o => axios.delete(`/api/trading/order/${o.id}`)))
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

  const dayChangeColor = bal
    ? bal.day_change >= 0 ? T.pos : T.neg
    : T.muted

  const [gammaOpen, setGammaOpen] = useState(false)

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
            <OrdersPanel
              orders={orders}
              onCancel={id => cancelMutation.mutate(id)}
              onCancelAll={() => cancelAllMutation.mutate()}
              cancelAllPending={cancelAllMutation.isPending}
              cancelAllError={cancelAllMutation.isError}
            />
          </div>
        </div>

        {/* ── Strategy Panel ── */}
        <StrategyPanel
          onImportTemplate={setImportedTemplate}
          pendingBuilderStrategy={pendingBuilderStrategy}
          onApproveBuilderStrategy={approveBuilderStrategy}
          onDismissBuilderStrategy={() => { localStorage.removeItem(PT_LS_KEY); setPendingBuilderStrategy(null) }}
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
    help: 'Golden Cross / Death Cross strategy. Buys when the 50-day SMA crosses above the 200-day SMA and price is above both (confirmed uptrend). Sells when both conditions reverse. Trend-following — performs best in strongly trending markets; whipsaws in choppy conditions. Also used in Backtester/Monte Carlo as drift adjustment.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'SMA Trend Following (50/200)', montecarloKey: 'SMA Trend Following (50/200)',
  },
  bollinger_breakout: {
    label: 'Bollinger Breakout',
    help: 'Computes a 20-period Bollinger Band (±2σ). Enters long when price closes above the upper band (volatility breakout). Exits when price falls below the lower band. Targets explosive breakout moves. Works well on trending assets; prone to false signals during consolidation.',
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
    help: 'Moving Average Convergence Divergence. Computes EMA(12) − EMA(26) = MACD line, and EMA(9) of that = signal line. Buys when MACD crosses above the signal line (bullish momentum shift); sells on cross below. Combines trend and momentum. Lags at turning points; strong in trending environments.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'macd_crossover', montecarloKey: 'MACD Crossover (12,26,9)',
  },
  value_pe: {
    label: 'Value — P/E',
    help: 'Fundamental value strategy. Fetches trailing P/E at session start. Buys when P/E < fair-value threshold (stock is cheap), sells when P/E exceeds expensive threshold. Holds neutral in between. NOTE: P/E is static per session — this strategy emits a sustained BUY or SELL signal rather than reacting to price ticks.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'value_pe', montecarloKey: 'Value — Trailing P/E',
  },
  earnings_growth: {
    label: 'Earnings Growth',
    help: 'Fundamental earnings momentum. Fetches quarterly EPS growth at session start. Buys when EPS growth is positive (company is growing earnings), exits when growth falls below the exit threshold. Like Value P/E, this is a session-level signal — set the ticker param to match your position.',
    usedIn: ['backtester', 'montecarlo'],
    backtesterKey: 'earnings_momentum', montecarloKey: 'Earnings Growth Momentum',
  },
  gamma_scalping: {
    label: 'Gamma Scalping',
    help: 'IV/RV regime proxy using short-term (5-day) vs long-term (20-day) realized volatility ratio. Buys when recent volatility expands above the long-term baseline (vol expansion = long gamma regime); exits when vol compresses below the threshold. Repurposed from the Gamma Scalping simulator — captures convexity-driven moves without requiring live options data.',
    usedIn: [],
  },
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

function StrategySignalChart({ data, ticker, mode }: {
  data: ChartPoint[]; ticker: string; mode: 'replay' | 'live'
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
            {xCount} ticks · updates every 15s
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
interface ReplayResult {
  ticker: string; bars_processed: number
  events: { strategy_name: string; timestamp: number; symbol: string; signal: string; price: number }[]
  summary: Record<string, { BUY: number; SELL: number; HOLD: number }>
}

function StrategyPanel({ onImportTemplate, pendingBuilderStrategy, onApproveBuilderStrategy, onDismissBuilderStrategy }: {
  onImportTemplate: (tpl: StrategyTemplate) => void
  pendingBuilderStrategy: PendingOptionStrategy | null
  onApproveBuilderStrategy: (ps: PendingOptionStrategy) => void
  onDismissBuilderStrategy: () => void
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [replayTicker, setReplayTicker] = useState('SPY')
  const [replayStart, setReplayStart] = useState('2024-01-01')
  const [replayResult, setReplayResult] = useState<ReplayResult | null>(null)
  const [execQty, setExecQty] = useState('1')
  const [execStatus, setExecStatus] = useState<string | null>(null)
  const [liveActive, setLiveActive] = useState(false)
  const [liveStatus, setLiveStatus] = useState<string | null>(null)
  const liveIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [liveChart, setLiveChart] = useState<ChartPoint[]>([])

  const { data: strategies = [] } = useQuery<StrategyEntry[]>({
    queryKey: ['paper-strategies'],
    queryFn: () => axios.get('/api/paper-strategies/').then(r => r.data),
    enabled: open,
  })

  const toggleMut = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      axios.post(`/api/paper-strategies/${name}/toggle`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper-strategies'] }),
  })

  const uploadMut = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData(); fd.append('file', file)
      return axios.post('/api/paper-strategies/upload', fd)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper-strategies'] }),
  })

  const deleteMut = useMutation({
    mutationFn: (name: string) => axios.delete(`/api/paper-strategies/${name}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['paper-strategies'] }),
  })

  const replayMut = useMutation({
    mutationFn: () => axios.post('/api/paper-strategies/replay', {
      ticker: replayTicker.toUpperCase(), start: replayStart,
    }).then(r => r.data),
    onSuccess: async (d: ReplayResult) => {
      setReplayResult(d); setExecStatus(null); setLiveChart([])
      try {
        const hist = await axios.get(`/api/market/history?ticker=${d.ticker}&start=${replayStart}`)
        const prices: { date: string; value: number }[] = hist.data.price ?? []
        // build a date → signal map from events
        const signalMap: Record<string, 'BUY' | 'SELL'> = {}
        for (const ev of d.events) {
          const dateStr = new Date(ev.timestamp * 1000).toISOString().slice(0, 10)
          signalMap[dateStr] = ev.signal as 'BUY' | 'SELL'
        }
        setChartData(prices.map(p => ({
          date: p.date,
          price: p.value,
          buy:  signalMap[p.date] === 'BUY'  ? p.value : undefined,
          sell: signalMap[p.date] === 'SELL' ? p.value : undefined,
        })))
      } catch { /* chart optional */ }
    },
  })

  const placeOrder = (symbol: string, side: 'buy' | 'sell', qty: number) =>
    axios.post('/api/trading/order/equity', {
      symbol, side, quantity: qty, order_type: 'market', duration: 'day',
    })

  const executeSignals = async () => {
    if (!replayResult) return
    const qty = Math.max(1, parseInt(execQty) || 1)
    const events = replayResult.events.filter(e => e.signal !== 'HOLD')
    if (events.length === 0) { setExecStatus('No BUY/SELL signals to execute.'); return }
    setExecStatus(`Placing ${events.length} orders…`)
    let ok = 0, fail = 0
    for (const ev of events) {
      try {
        await placeOrder(ev.symbol, ev.signal === 'BUY' ? 'buy' : 'sell', qty)
        ok++
      } catch { fail++ }
    }
    setExecStatus(`Done — ${ok} placed${fail ? `, ${fail} failed` : ''}.`)
    qc.invalidateQueries({ queryKey: ['account'] })
  }

  const startLive = () => {
    const ticker = replayTicker.toUpperCase()
    const qty = Math.max(1, parseInt(execQty) || 1)
    setLiveActive(true)
    setLiveStatus('Live — waiting for first tick…')
    setLiveChart([])
    setChartData([])
    liveIntervalRef.current = setInterval(async () => {
      try {
        const priceRes = await axios.get(`/api/market/quote/${ticker}`)
        const price: number = priceRes.data?.current_price ?? priceRes.data?.last ?? priceRes.data?.price
        if (!price) return
        const now = new Date().toLocaleTimeString()
        const signals: { strategy_name: string; signal: string }[] =
          await axios.post('/api/paper-strategies/tick', {
            timestamp: Date.now() / 1000, symbol: ticker, price, size: 0, side: 'trade',
          }).then(r => r.data)
        const sigMap: Record<string, string> = {}
        for (const s of signals) sigMap[s.strategy_name] = s.signal
        const firstSig = signals.find(s => s.signal === 'BUY' || s.signal === 'SELL')
        setLiveChart(prev => [...prev.slice(-199), {
          date: now,
          price,
          buy:  firstSig?.signal === 'BUY'  ? price : undefined,
          sell: firstSig?.signal === 'SELL' ? price : undefined,
        }])
        for (const s of signals) {
          if (s.signal === 'BUY' || s.signal === 'SELL') {
            await placeOrder(ticker, s.signal === 'BUY' ? 'buy' : 'sell', qty)
            setLiveStatus(`${now} — ${s.strategy_name}: ${s.signal} ${qty}x ${ticker} @ $${price.toFixed(2)}`)
            qc.invalidateQueries({ queryKey: ['account'] })
          }
        }
        if (!firstSig) setLiveStatus(`${now} — ${ticker} $${price.toFixed(2)} · HOLD`)
      } catch (e) {
        setLiveStatus(`Error: ${(e as Error).message}`)
      }
    }, 15_000)
  }

  const stopLive = () => {
    if (liveIntervalRef.current) clearInterval(liveIntervalRef.current)
    setLiveActive(false)
    setLiveStatus(null)
  }

  useEffect(() => () => { if (liveIntervalRef.current) clearInterval(liveIntervalRef.current) }, [])

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
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color: T.gold }}>⬡ STRATEGIES</span>
        <span style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>
          {strategies.length} loaded · {strategies.filter(s => s.enabled).length} active
        </span>
        {pendingBuilderStrategy && (
          <span style={{ fontSize: 9, fontWeight: 700, color: T.gold, fontFamily: T.mono,
            padding: '1px 6px', border: `1px solid ${T.gold}`, marginLeft: 4, animation: 'pulse 1.5s infinite' }}>
            ⚡ PENDING
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
            <button
              onClick={() => onApproveBuilderStrategy(pendingBuilderStrategy)}
              style={{ padding: '6px 14px', fontSize: 10, fontFamily: T.mono, fontWeight: 700,
                cursor: 'pointer', border: 'none', background: T.gold, color: '#0d1826', letterSpacing: '0.1em' }}
            >
              ✓ APPROVE
            </button>
            <button
              onClick={onDismissBuilderStrategy}
              style={{ padding: '6px 10px', fontSize: 10, fontFamily: T.mono, cursor: 'pointer',
                border: `1px solid ${T.border}`, background: 'transparent', color: T.muted }}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {open && (
        <div>
        <div style={{ padding: '10px 14px', display: 'flex', gap: 14, flexWrap: 'wrap' }}>

          {/* Strategy list */}
          <div style={{ flex: 1, minWidth: 300 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, textTransform: 'uppercase' }}>
                Strategies
              </span>
              <HelpTip width={280} position="right" text="Enable/disable strategies that run during live auto-trade and replay. Multiple enabled strategies all fire signals simultaneously — place orders for whichever fires first per tick. Toggle OFF strategies you don't want active. Builtin strategies cannot be deleted. Upload custom .py strategies below." />
            </div>
            {strategies.length === 0 && (
              <div style={{ fontSize: 10, color: T.dim, fontFamily: T.mono }}>No strategies loaded.</div>
            )}
            {strategies.map(s => {
              const info = BUILTIN_STRATEGY_INFO[s.name]
              return (
                <div key={s.name} style={{ marginBottom: 6, padding: '7px 10px',
                  border: `1px solid ${s.enabled ? 'rgba(201,168,76,0.25)' : T.border}`,
                  background: s.enabled ? 'rgba(201,168,76,0.04)' : 'var(--theme-hover, rgba(255,255,255,0.01))' }}>
                  {/* Row 1: name + help + toggle + delete */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ flex: 1, fontSize: 11, fontWeight: 700, color: T.text, fontFamily: T.mono }}>
                      {info?.label ?? s.name}
                    </span>
                    {info && <HelpTip width={300} position="right" text={info.help} />}
                    <button
                      onClick={() => toggleMut.mutate({ name: s.name, enabled: !s.enabled })}
                      style={{
                        padding: '2px 8px', fontSize: 9, fontFamily: T.mono, fontWeight: 700, cursor: 'pointer', border: '1px solid',
                        borderColor: s.enabled ? 'rgba(34,197,94,0.5)' : T.border,
                        background: s.enabled ? 'rgba(34,197,94,0.1)' : 'transparent',
                        color: s.enabled ? T.pos : T.muted, letterSpacing: '0.08em',
                      }}
                    >{s.enabled ? 'ON' : 'OFF'}</button>
                    {s.author !== 'builtin' && (
                      <button onClick={() => deleteMut.mutate(s.name)}
                        style={{ background: 'none', border: 'none', color: T.neg, cursor: 'pointer', fontSize: 12, padding: '0 4px' }}>×</button>
                    )}
                  </div>
                  {/* Row 2: description */}
                  <div style={{ fontSize: 9, color: T.dim, marginTop: 3, fontFamily: T.mono, lineHeight: '13px' }}>
                    {s.description}
                  </div>
                  {/* Row 3: cross-tool badges */}
                  {info && info.usedIn.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
                      {info.usedIn.includes('backtester') && (
                        <a href="/backtester" style={{ textDecoration: 'none' }}>
                          <span style={{ fontSize: 8, padding: '1px 5px', border: '1px solid rgba(96,165,250,0.4)',
                            color: '#60a5fa', fontFamily: T.mono, cursor: 'pointer', letterSpacing: '0.06em' }}>
                            ↗ BACKTESTER
                          </span>
                        </a>
                      )}
                      {info.usedIn.includes('montecarlo') && (
                        <a href="/monte-carlo" style={{ textDecoration: 'none' }}>
                          <span style={{ fontSize: 8, padding: '1px 5px', border: '1px solid rgba(167,139,250,0.4)',
                            color: '#a78bfa', fontFamily: T.mono, cursor: 'pointer', letterSpacing: '0.06em' }}>
                            ↗ MONTE CARLO
                          </span>
                        </a>
                      )}
                    </div>
                  )}
                </div>
              )
            })}

            {/* Upload */}
            <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
              <input ref={fileRef} type="file" accept=".py" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadMut.mutate(f) }} />
              <button
                onClick={() => fileRef.current?.click()}
                style={{ ...btn, flex: 1 }}
              >
                {uploadMut.isPending ? 'Uploading…' : '↑ Upload Strategy (.py)'}
              </button>
            </div>
            {uploadMut.isError && (
              <div style={{ marginTop: 4, fontSize: 9, color: T.neg, fontFamily: T.mono }}>
                {(uploadMut.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? 'Upload failed'}
              </div>
            )}
          </div>

          {/* Replay + Live Execution */}
          <div style={{ width: 300, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, textTransform: 'uppercase' }}>
                Replay & Auto-Execute
              </span>
              <HelpTip width={290} position="right" text="Replay: runs all enabled strategies against historical daily closes (via yfinance) for the chosen ticker + date range. Shows BUY/SELL/HOLD counts and a price chart with signal markers. 'Execute Signals' converts every non-HOLD signal into a real paper order. Qty = number of shares per order." />
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
                {/* Execute replay signals as paper orders */}
                {replayResult.events.length > 0 && (
                  <button
                    onClick={executeSignals}
                    style={{ ...btn, width: '100%', marginBottom: 4,
                      borderColor: 'rgba(201,168,76,0.6)', background: 'rgba(201,168,76,0.14)' }}
                  >
                    ⚡ Execute {replayResult.events.filter(e => e.signal !== 'HOLD').length} Signal Orders
                  </button>
                )}
                {execStatus && (
                  <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>{execStatus}</div>
                )}
              </>
            )}

            {/* Live mode */}
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, marginTop: 4 }}>
              <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, marginBottom: 6, textTransform: 'uppercase' }}>
                Live Auto-Trade (15s poll) <HelpTip width={270} position="top" text="Polls the current market price every 15 seconds. Feeds each tick to all enabled strategies. If any strategy returns BUY or SELL, a real paper order is placed immediately for the specified qty. The price chart updates live. NOTE: strategies need warm-up bars — RSI needs 14+ ticks, SMA-200 needs 200+ ticks before signalling. Best used during market hours." />
              </div>
              {!liveActive ? (
                <button
                  onClick={startLive}
                  disabled={strategies.filter(s => s.enabled).length === 0}
                  style={{ ...btn, width: '100%', borderColor: 'rgba(34,197,94,0.4)', color: T.pos }}
                >
                  ● Start Live
                </button>
              ) : (
                <button onClick={stopLive}
                  style={{ ...btn, width: '100%', borderColor: 'rgba(239,68,68,0.4)', color: T.neg }}>
                  ■ Stop Live
                </button>
              )}
              {liveStatus && (
                <div style={{ marginTop: 4, fontSize: 9, color: liveActive ? T.pos : T.muted, fontFamily: T.mono, wordBreak: 'break-all' }}>
                  {liveStatus}
                </div>
              )}
            </div>
          </div>

          {/* Option Leg Strategy Import */}
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, marginBottom: 8, textTransform: 'uppercase' }}>
              Option Leg Strategies → Order Ticket <HelpTip width={270} position="top" text="Click any preset to instantly pre-load the correct leg structure (sides, quantities, order type) into the multileg order ticket above. You still fill in the OCC option symbols — use the Chain Scanner to find them. Hover each button in the order ticket for a description of that strategy's P&L profile." />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {OPTION_STRATEGY_TEMPLATES.map(tpl => (
                <button
                  key={tpl.name}
                  title={tpl.description}
                  onClick={() => {
                    onImportTemplate(tpl)
                    document.getElementById('order-ticket-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                  style={{
                    padding: '4px 9px', fontSize: 9, fontFamily: T.mono, cursor: 'pointer',
                    border: `1px solid ${T.border}`, background: 'rgba(201,168,76,0.06)',
                    color: T.muted, letterSpacing: '0.05em', whiteSpace: 'nowrap',
                    transition: 'color 0.12s, border-color 0.12s',
                  }}
                  onMouseEnter={e => { (e.target as HTMLButtonElement).style.color = T.gold; (e.target as HTMLButtonElement).style.borderColor = T.gold }}
                  onMouseLeave={e => { (e.target as HTMLButtonElement).style.color = T.muted; (e.target as HTMLButtonElement).style.borderColor = T.border }}
                >
                  {tpl.shortName} ↑
                </button>
              ))}
            </div>
            <div style={{ marginTop: 8, fontSize: 9, color: T.dim, fontFamily: T.mono }}>
              Click any strategy to pre-load leg structure into the multileg order ticket.
            </div>
          </div>

          {/* Code snippet */}
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: T.muted, marginBottom: 8, textTransform: 'uppercase' }}>
              Custom Strategy Template <HelpTip width={270} position="top" text="Paste this into a .py file and upload via the button above. Implement on_data() — it receives a MarketDataPoint (price, timestamp, symbol) per tick and must return Signal.BUY, Signal.SELL, or Signal.HOLD. initialize() runs once with your params dict. metadata() must be a pure function — no I/O." />
            </div>
            <pre style={{
              margin: 0, padding: '8px 10px', background: 'rgba(0,0,0,0.3)', border: `1px solid ${T.border}`,
              fontSize: 9, color: '#a8c9f0', fontFamily: T.mono, overflowX: 'auto', lineHeight: 1.5,
              userSelect: 'all',
            }}>{STRATEGY_TEMPLATE}</pre>
          </div>
        </div>

        {/* Signal chart — replay or live */}
        {(chartData.length > 0 || liveChart.length > 0) && (
          <StrategySignalChart
            data={liveActive ? liveChart : chartData}
            ticker={replayTicker}
            mode={liveActive ? 'live' : 'replay'}
          />
        )}
        </div>
      )}
    </div>
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
