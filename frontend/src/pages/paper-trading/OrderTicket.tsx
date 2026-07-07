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
import { buildOCC, parseOCC, isOCC, occUnderlying } from '../../lib/occ'
import PaperChart, { type ChartFill } from '../../components/PaperChart'
import { loadActivePortfolio } from '../../components/dashboard/widgets/usePortfolio'
import { EMPTY_LEG, OPTION_STRATEGY_TEMPLATES, type LegState, type StrategyTemplate } from './optionTemplates'
import { useAuth, adaptAccount, T, inp, sel, lbl, btn, sectionHeader, fmt$, fmtDate, statusColor, computeReplayStats, applyRiskToChart, PT_LS_KEY, BUILTIN_STRATEGY_INFO, PAPER_DEFAULT_PARAMS, PAPER_PARAM_LABELS, STRATEGY_TEMPLATE, RISK_DEFAULTS, type Balances, type Position, type Order, type AccountData, type PendingOptionStrategy, type ChartPoint, type StrategyEntry, type ReplayEvent, type ReplayResult, type RiskConfig, type SchedulerStatus, type SchedulerJob, type SchedulerLogEntry } from './shared'

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
export function OrderTicket({ onOrderPlaced, importTemplate, onTemplateConsumed, importOCCLegs, importUnderlying }: {
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
    // A single-leg strategy (e.g. Long Call) can't go through the multi-leg
    // endpoint (it requires 2-4 legs), so route a lone imported leg to the
    // single-option ticket instead.
    if (importOCCLegs?.length === 1) {
      const leg = importOCCLegs[0]
      const parsed = parseOCC(leg.symbol)
      if (parsed) {
        setTab('option')
        setOpUnderlying((importUnderlying || occUnderlying(leg.symbol)).toUpperCase())
        setOpExpDate(parsed.expDate)
        setOpStrike(parsed.strike)
        setOpCallPut(parsed.callPut)
        setOpSide(leg.side)
        setOpQty(leg.qty)
        onTemplateConsumed?.()
        document.getElementById('order-ticket-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
    }
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

  // Import the active Portfolio Manager book: place a market buy for every
  // holding's share count so the paper account mirrors the real portfolio.
  const importMutation = useMutation({
    mutationFn: async () => {
      const { holdings } = loadActivePortfolio()
      const buyable = holdings.filter(h => h.shares > 0)
      if (buyable.length === 0) throw new Error('No holdings in your active Portfolio Manager book to import.')
      const results = await Promise.allSettled(buyable.map(h => axios.post('/api/paper/order', {
        user_id: uid, symbol: h.ticker.toUpperCase(), side: 'buy', quantity: Math.round(h.shares),
        order_type: 'market', limit_price: null, stop_price: null,
      }, headers)))
      return { ok: results.filter(r => r.status === 'fulfilled').length, failed: results.filter(r => r.status === 'rejected').length }
    },
    onSuccess: ({ ok, failed }) => {
      showFeedback(failed === 0, `Imported ${ok} position${ok === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`)
      onOrderPlaced()
    },
    onError: (err: unknown) => showFeedback(false, (err as Error)?.message ?? 'Import failed'),
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
              <button
                onClick={() => importMutation.mutate()}
                disabled={importMutation.isPending}
                style={{
                  width: '100%', padding: '8px 0', fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
                  cursor: importMutation.isPending ? 'wait' : 'pointer',
                  background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: T.gold,
                }}
              >
                {importMutation.isPending ? 'IMPORTING…' : 'IMPORT PORTFOLIO'}
              </button>
              <span style={{ ...lbl, display: 'block', marginTop: 5, textTransform: 'none', letterSpacing: 0 }}>
                Places market buys for every holding in your active Portfolio Manager book.
              </span>
            </div>

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
                      background: mlTemplate?.name === tpl.name ? 'color-mix(in srgb, var(--theme-primary) 15%, transparent)' : 'transparent',
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
            background: feedback.ok ? 'color-mix(in srgb, var(--theme-positive) 10%, transparent)' : 'color-mix(in srgb, var(--theme-negative) 10%, transparent)',
            border: `1px solid ${feedback.ok ? 'color-mix(in srgb, var(--theme-positive) 40%, transparent)' : 'color-mix(in srgb, var(--theme-negative) 40%, transparent)'}`,
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
