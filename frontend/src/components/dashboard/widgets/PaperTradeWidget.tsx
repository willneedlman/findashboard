import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { useTheme } from '../../../contexts/ThemeContext'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     '#22c55e',
  neg:     '#ef4444',
}

interface Candle { time: number | string; open: number; high: number; low: number; close: number; volume: number }
interface Position { symbol: string; quantity: number; avg_cost: number; price: number; unrealized_pnl: number }
interface Account { cash: number; equity: number; buying_power: number; realized_pnl: number; positions: Position[] }
interface PaperOrder { status: string; reason: string | null; fill_price: number | null }
type OType = 'market' | 'limit' | 'stop'

const TFS = [
  { key: '1m',  label: '1m', period: '1d',  interval: '1m' },
  { key: '1mo', label: '1M', period: '1mo', interval: '1d' },
  { key: '3mo', label: '3M', period: '3mo', interval: '1d' },
  { key: '6mo', label: '6M', period: '6mo', interval: '1d' },
  { key: '1y',  label: '1Y', period: '1y',  interval: '1d' },
]

const inputStyle: React.CSSProperties = {
  background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, color: T.text,
  fontFamily: T.mono, fontSize: 11, padding: '3px 5px', outline: 'none', width: '100%', boxSizing: 'border-box',
}
const money = (v: number) => v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export default function PaperTradeWidget({ config }: { config: WidgetConfig }) {
  const { user } = useTheme()
  const token = typeof window !== 'undefined' ? (localStorage.getItem('ft-session-token') || '') : ''
  const authed = !!user?.id && !!token
  const authHeaders = { Authorization: `Bearer ${token}`, 'x-session-token': token }

  const qc = useQueryClient()
  const [ticker, setTicker] = useState((config.ticker || 'SPY').toUpperCase())
  const [tickerInput, setTickerInput] = useState(ticker)
  const [tfKey, setTfKey] = useState('6mo')
  const tf = TFS.find(t => t.key === tfKey) ?? TFS[3]

  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const [spot, setSpot] = useState<number | null>(null)
  const [chartErr, setChartErr] = useState(false)

  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [qty, setQty] = useState('1')
  const [otype, setOType] = useState<OType>('market')
  const [limitPx, setLimitPx] = useState('')
  const [stopPx, setStopPx] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null)

  // ── Candlestick chart ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const cs = getComputedStyle(document.documentElement)
    const bg = cs.getPropertyValue('--theme-bg').trim() || '#101c2e'
    const txt = cs.getPropertyValue('--theme-secondary').trim() || '#5e768f'
    const gold = cs.getPropertyValue('--theme-primary').trim() || '#c9a84c'
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: bg }, textColor: txt, fontFamily: "'JetBrains Mono', monospace", fontSize: 9 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: `${gold}66` }, horzLine: { color: `${gold}66` } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', textColor: txt },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true },
      width: el.clientWidth, height: el.clientHeight,
    })
    const candle = chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#22c55e', borderDownColor: '#ef4444',
      wickUpColor: '#22c55e', wickDownColor: '#ef4444', priceLineColor: gold, priceLineWidth: 1,
    })
    chartRef.current = chart
    candleRef.current = candle
    const ro = new ResizeObserver(() => { if (el) chart.resize(el.clientWidth, el.clientHeight) })
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; candleRef.current = null }
  }, [])

  const fetchCandles = useCallback(async (sym: string, period: string, interval: string) => {
    setChartErr(false)
    try {
      const res = await fetch(`/api/market/ohlcv?ticker=${encodeURIComponent(sym)}&period=${period}&interval=${interval}`)
      if (!res.ok) throw new Error(`${res.status}`)
      const candles: Candle[] = (await res.json()).candles
      if (!candles?.length) throw new Error('no data')
      candleRef.current?.setData(candles.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close })))
      chartRef.current?.timeScale().fitContent()
      setSpot(candles[candles.length - 1].close)
    } catch { setChartErr(true) }
  }, [])

  useEffect(() => { if (ticker && candleRef.current) fetchCandles(ticker, tf.period, tf.interval) }, [ticker, tf.period, tf.interval, fetchCandles])

  // ── Per-user account (cash, buying power, positions) ──
  const account = useQuery<Account>({
    queryKey: ['paper-account', user?.id],
    queryFn: () => axios.get(`/api/paper/account?user_id=${user!.id}`, { headers: authHeaders }).then(r => r.data),
    enabled: authed,
    staleTime: 15_000,
    retry: 1,
  })

  const order = useMutation({
    mutationFn: () => axios.post('/api/paper/order', {
      user_id: user!.id, symbol: ticker, side, quantity: Number(qty), order_type: otype,
      limit_price: otype === 'limit' ? Number(limitPx) : null,
      stop_price: otype === 'stop' ? Number(stopPx) : null,
    }, { headers: authHeaders }).then(r => r.data as PaperOrder),
    onSuccess: (o) => {
      if (o.status === 'filled') setResult({ text: `Filled @ $${o.fill_price?.toFixed(2)}`, ok: true })
      else if (o.status === 'open') setResult({ text: 'Resting (open order)', ok: true })
      else setResult({ text: `Rejected: ${o.reason ?? o.status}`, ok: false })
      qc.invalidateQueries({ queryKey: ['paper-account', user?.id] })
    },
    onError: (e: unknown) => setResult({ text: ((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail) ?? 'Order failed', ok: false }),
    onSettled: () => setConfirming(false),
  })

  const reset = useMutation({
    mutationFn: () => axios.post('/api/paper/reset', { user_id: user!.id }, { headers: authHeaders }).then(r => r.data),
    onSuccess: () => { setResult(null); qc.invalidateQueries({ queryKey: ['paper-account', user?.id] }) },
  })

  if (!authed) return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', background: T.bg, padding: 14, textAlign: 'center' }}>
      <span style={{ color: T.muted, fontFamily: T.label, fontSize: 11, lineHeight: 1.5 }}>Sign in to paper-trade<br />your own account.</span>
    </div>
  )

  const commitTicker = () => { const t = tickerInput.trim().toUpperCase(); if (t) { setTicker(t); setResult(null) } }
  const qtyN = Number(qty)
  const valid = qtyN > 0 && (otype !== 'limit' || Number(limitPx) > 0) && (otype !== 'stop' || Number(stopPx) > 0)
  const submit = () => {
    if (!valid || order.isPending) return
    if (!confirming) { setConfirming(true); setTimeout(() => setConfirming(false), 4000); return }
    order.mutate()
  }
  const sideColor = side === 'buy' ? T.pos : T.neg
  const summary = `${side === 'buy' ? 'Buy' : 'Sell'} ${qtyN || ''} ${ticker} ${otype === 'market' ? '@ mkt' : otype === 'limit' ? `@ ${limitPx || '—'}` : `stp ${stopPx || '—'}`}`
  const lbl: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted }
  const acct = account.data
  const pos = acct?.positions ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      {/* Header: ticker box + spot + timeframe */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <input value={tickerInput} onChange={e => setTickerInput(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && commitTicker()} onBlur={commitTicker} style={{ ...inputStyle, width: 72, fontWeight: 700, color: T.gold }} />
        {spot != null && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>${spot.toFixed(2)}</span>}
        <div style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
          {TFS.map(t => (
            <button key={t.key} onClick={() => setTfKey(t.key)} style={{
              fontFamily: T.mono, fontSize: 8.5, fontWeight: 700, padding: '2px 6px', cursor: 'pointer',
              border: tfKey === t.key ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`,
              background: tfKey === t.key ? 'rgba(201,168,76,0.12)' : 'transparent',
              color: tfKey === t.key ? T.gold : 'rgba(255,255,255,0.3)', letterSpacing: '0.04em',
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Body: chart + order/positions sidebar */}
      <div style={{ display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
          {chartErr && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: T.mono, fontSize: 10, color: T.muted }}>No chart data</div>}
        </div>

        <div style={{ width: 176, flexShrink: 0, borderLeft: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6, borderBottom: `1px solid ${T.border}` }}>
            <div style={{ display: 'flex', gap: 0 }}>
              {(['buy', 'sell'] as const).map(s => (
                <button key={s} onClick={() => setSide(s)} style={{
                  flex: 1, fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 0', cursor: 'pointer',
                  border: `1px solid ${side === s ? (s === 'buy' ? T.pos : T.neg) : T.border}`,
                  background: side === s ? `color-mix(in srgb, ${s === 'buy' ? T.pos : T.neg} 18%, transparent)` : 'transparent',
                  color: side === s ? (s === 'buy' ? T.pos : T.neg) : T.muted,
                }}>{s}</button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ ...lbl, width: 26 }}>Qty</span>
              <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)} style={inputStyle} />
            </div>
            <div style={{ display: 'flex', gap: 3 }}>
              {(['market', 'limit', 'stop'] as OType[]).map(t => (
                <button key={t} onClick={() => setOType(t)} style={{
                  flex: 1, fontFamily: T.mono, fontSize: 8, fontWeight: 700, padding: '3px 0', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em',
                  border: `1px solid ${otype === t ? T.gold : T.border}`,
                  background: otype === t ? 'rgba(201,168,76,0.12)' : 'transparent',
                  color: otype === t ? T.gold : T.muted,
                }}>{t.slice(0, 3)}</button>
              ))}
            </div>
            {otype === 'limit' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ ...lbl, width: 26 }}>Lmt</span>
                <input type="number" step="0.01" value={limitPx} onChange={e => setLimitPx(e.target.value)} placeholder={spot != null ? spot.toFixed(2) : ''} style={inputStyle} />
              </div>
            )}
            {otype === 'stop' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ ...lbl, width: 26 }}>Stp</span>
                <input type="number" step="0.01" value={stopPx} onChange={e => setStopPx(e.target.value)} placeholder={spot != null ? spot.toFixed(2) : ''} style={inputStyle} />
              </div>
            )}
            <button onClick={submit} disabled={!valid || order.isPending} style={{
              fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', padding: '7px 4px',
              border: 'none', cursor: valid && !order.isPending ? 'pointer' : 'not-allowed',
              background: confirming ? T.gold : sideColor, color: 'var(--theme-bg, #0a1628)', opacity: valid && !order.isPending ? 1 : 0.5,
            }}>
              {order.isPending ? 'Placing…' : confirming ? `Confirm · ${summary}` : summary}
            </button>
            {result && <div style={{ fontFamily: T.mono, fontSize: 9, color: result.ok ? T.pos : T.neg, lineHeight: 1.3 }}>{result.text}</div>}
          </div>

          {/* Buying power + reset */}
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '5px 8px', borderBottom: `1px solid ${T.border}` }}>
            <span style={lbl}>Buying power</span>
            <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.text }}>{acct ? money(acct.buying_power) : '—'}</span>
          </div>

          {/* Positions */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px 3px' }}>
              <span style={lbl}>Positions</span>
              <button onClick={() => reset.mutate()} title="Reset paper account" style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted }}>Reset</button>
            </div>
            {pos.length === 0 ? (
              <div style={{ padding: '2px 8px 8px', fontFamily: T.mono, fontSize: 9, color: T.muted }}>{account.isLoading ? 'Loading…' : 'None open'}</div>
            ) : pos.map(p => (
              <div key={p.symbol} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 8px', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.gold }}>{p.symbol}<span style={{ color: T.muted, fontSize: 8, marginLeft: 4 }}>{p.quantity}</span></span>
                <span style={{ fontFamily: T.mono, fontSize: 9, color: p.unrealized_pnl >= 0 ? T.pos : T.neg }}>{p.unrealized_pnl >= 0 ? '+' : ''}{p.unrealized_pnl.toFixed(0)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
