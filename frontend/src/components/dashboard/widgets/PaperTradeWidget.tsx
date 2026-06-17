import { T } from '../../../lib/theme'
import { useEffect, useRef, useState, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { createChart, ColorType, CrosshairMode, LineStyle } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time, SeriesMarker, IPriceLine, MouseEventParams } from 'lightweight-charts'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { useTheme } from '../../../contexts/ThemeContext'
import { Sliders } from 'lucide-react'
import ExpirySelect from '../../ExpirySelect'
import { buildOCC, occUnderlying } from '../../../lib/occ'
import { smaArr, emaArr, bollinger, vwapArr, type Candle } from '../../../lib/indicators'
import { marketSession } from '../../../lib/marketSession'
import { readToken } from '../../../lib/theme'


interface Position { symbol: string; quantity: number; avg_cost: number; price: number; unrealized_pnl: number }
interface OptionPosition { option_symbol: string; underlying: string; type: string; strike: number; quantity: number; unrealized_pnl: number }
interface OrderRow { id: string; symbol: string; option_symbol?: string; side: string; status: string; fill_price: number | null; created_at?: number }
interface Account { cash: number; equity: number; buying_power: number; realized_pnl: number; positions: Position[]; option_positions?: OptionPosition[]; orders?: OrderRow[] }
interface PaperOrder { status: string; reason: string | null; fill_price: number | null }
type OType = 'market' | 'limit' | 'stop'

const TFS = [
  { key: '1m', label: '1m' }, { key: '3m', label: '3m' }, { key: '5m', label: '5m' }, { key: '10m', label: '10m' },
  { key: '1h', label: '1H' }, { key: '2h', label: '2H' }, { key: '6h', label: '6H' }, { key: '12h', label: '12H' },
  { key: '1d', label: '1D' }, { key: '1wk', label: '1W' }, { key: '1mo', label: '1Mo' },
]


const OVERLAYS = [
  { key: 'sma', label: 'SMA' }, { key: 'ema', label: 'EMA' }, { key: 'bb', label: 'BB' }, { key: 'vwap', label: 'VWAP' }, { key: 'vol', label: 'VOL' },
] as const
type OverlayKey = typeof OVERLAYS[number]['key']

interface OverlayParams { smaPeriod: number; emaPeriod: number; bbPeriod: number; bbMult: number }
const DEFAULT_PARAMS: OverlayParams = { smaPeriod: 20, emaPeriod: 20, bbPeriod: 20, bbMult: 2 }
const DEFAULT_OVERLAYS: Record<OverlayKey, boolean> = { sma: false, ema: false, bb: false, vwap: false, vol: true }

interface OverlayState { on: Record<OverlayKey, boolean>; params: OverlayParams; windowKey: string; barSpacing: number }
function loadOverlayState(id: string): OverlayState {
  try {
    const raw = JSON.parse(localStorage.getItem(`paper-overlays-${id}`) || 'null')
    if (raw) return { on: { ...DEFAULT_OVERLAYS, ...raw.on }, params: { ...DEFAULT_PARAMS, ...raw.params }, windowKey: raw.windowKey || '1D', barSpacing: raw.barSpacing || 0 }
  } catch { /* ignore */ }
  return { on: { ...DEFAULT_OVERLAYS }, params: { ...DEFAULT_PARAMS }, windowKey: '1D', barSpacing: 0 }
}

// Intraday timeframes carry pre/after-hours bars and refresh fast; daily+ are
// session-aggregated. The chart always requests full hours on intraday.
const DAILY_TFS = ['1d', '1wk', '1mo']
const isIntraday = (tf: string) => !DAILY_TFS.includes(tf)

// Graph width: how much time is visible at once. Default 1 trading day.
const WINDOWS = [{ key: '1D', label: '1D' }, { key: '1W', label: '1W' }, { key: '1M', label: '1M' }, { key: '3M', label: '3M' }, { key: 'all', label: 'All' }] as const
const WINDOW_SEC: Record<string, number> = { '1D': 86400, '1W': 604800, '1M': 2592000, '3M': 7776000 }
const _numTime = (t: number | string) => (typeof t === 'number' ? t : Date.parse(t + 'T00:00:00Z') / 1000)
function applyWindow(ts: ReturnType<IChartApi['timeScale']> | undefined, candles: Candle[], win: string) {
  if (!ts || !candles.length) return
  const lastIdx = candles.length - 1
  if (win === 'all' || !WINDOW_SEC[win]) { ts.fitContent(); return }
  const cutoff = _numTime(candles[lastIdx].time) - WINDOW_SEC[win]
  let from = 0
  for (let i = lastIdx; i >= 0; i--) { if (_numTime(candles[i].time) < cutoff) { from = i + 1; break } }
  from = Math.min(from, Math.max(0, lastIdx - 14))
  ts.setVisibleLogicalRange({ from, to: lastIdx + 3 })
}

interface ChainRow { strike: number; lastPrice: number; bid: number; ask: number }
interface OptionChain { calls: ChainRow[]; puts: ChainRow[]; spot: number | null }
const contractPrice = (r: ChainRow | undefined): number | null => {
  if (!r) return null
  if (r.bid > 0 && r.ask > 0) return (r.bid + r.ask) / 2
  return r.lastPrice > 0 ? r.lastPrice : null
}

const inputStyle: React.CSSProperties = {
  background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, color: T.text,
  fontFamily: T.mono, fontSize: 12, padding: '4px 6px', outline: 'none', width: '100%', boxSizing: 'border-box',
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
  const [tfKey, setTfKey] = useState('10m')
  const initialOverlays = loadOverlayState(config.id)
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>(initialOverlays.on)
  const [params, setParams] = useState<OverlayParams>(initialOverlays.params)
  const [windowKey, setWindowKey] = useState(initialOverlays.windowKey)
  const [barSpacing, setBarSpacing] = useState(initialOverlays.barSpacing)
  const [overlayCfgOpen, setOverlayCfgOpen] = useState(false)
  const [candles, setCandles] = useState<Candle[]>([])

  // Persist overlay toggles + params + zoom per widget so a customized chart survives reload.
  useEffect(() => {
    try { localStorage.setItem(`paper-overlays-${config.id}`, JSON.stringify({ on: overlays, params, windowKey, barSpacing })) } catch { /* ignore */ }
  }, [overlays, params, windowKey, barSpacing, config.id])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const overlayRefs = useRef<ISeriesApi<'Line'>[]>([])
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const lenRef = useRef(0)
  const windowRef = useRef(windowKey); useEffect(() => { windowRef.current = windowKey }, [windowKey])
  const barSpacingRef = useRef(barSpacing); useEffect(() => { barSpacingRef.current = barSpacing }, [barSpacing])
  const candlesRef = useRef<Candle[]>([]); useEffect(() => { candlesRef.current = candles }, [candles])
  const pickWindow = (w: string) => { setWindowKey(w); setBarSpacing(0); applyWindow(chartRef.current?.timeScale(), candlesRef.current, w) }
  const pickBarSpacing = (n: number) => {
    setBarSpacing(n)
    const ts = chartRef.current?.timeScale()
    if (n > 0) { ts?.applyOptions({ barSpacing: n }); ts?.scrollToRealTime() }
    else applyWindow(ts, candlesRef.current, windowRef.current)
  }
  const orderLineRef = useRef<IPriceLine | null>(null)
  const draggingRef = useRef(false)
  const [spot, setSpot] = useState<number | null>(null)
  const [chartErr, setChartErr] = useState(false)
  const [, setTick] = useState(0)
  useEffect(() => { const id = window.setInterval(() => setTick(t => t + 1), 30_000); return () => window.clearInterval(id) }, [])
  const session = marketSession(new Date(), ticker)

  const [side, setSide] = useState<'buy' | 'sell'>('buy')
  const [qty, setQty] = useState('1')
  const [otype, setOType] = useState<OType>('market')
  const [limitPx, setLimitPx] = useState('')
  const [stopPx, setStopPx] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(null)

  // ── Options entry ──
  const [instrument, setInstrument] = useState<'equity' | 'option'>('equity')
  const [opExpiry, setOpExpiry] = useState('')
  const [callPut, setCallPut] = useState<'C' | 'P'>('C')
  const [strike, setStrike] = useState('')
  const [opType, setOpType] = useState<'market' | 'limit'>('market')
  const [opLimit, setOpLimit] = useState('')

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
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, fixLeftEdge: true, rightOffset: 6 },
      // Built-in wheel-zoom is replaced by the amplified handler below; the
      // default trackpad pinch step is far too small.
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
      width: el.clientWidth, height: el.clientHeight,
    })
    const cPos = readToken('--theme-positive', '#22c55e'), cNeg = readToken('--theme-negative', '#ef4444')
    const candle = chart.addCandlestickSeries({
      upColor: cPos, downColor: cNeg, borderUpColor: cPos, borderDownColor: cNeg,
      wickUpColor: cPos, wickDownColor: cNeg, priceLineColor: gold, priceLineWidth: 1,
    })
    const vol = chart.addHistogramSeries({ priceScaleId: 'volume', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false })
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    chartRef.current = chart
    candleRef.current = candle
    volumeRef.current = vol

    // Amplified zoom: trackpad pinch arrives as ctrl+wheel with a tiny deltaY,
    // and plain wheel zooms too — both zoom around the cursor with real gain.
    const onWheel = (e: WheelEvent) => {
      const ts = chart.timeScale()
      const range = ts.getVisibleLogicalRange()
      if (!range) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const pivot = ts.coordinateToLogical(e.clientX - rect.left)
      const width = range.to - range.from
      const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.02 : 0.0015))
      const newWidth = Math.max(8, width * factor)
      const p = pivot == null ? range.from + width / 2 : pivot
      const newFrom = p - (p - range.from) * (newWidth / width)
      ts.setVisibleLogicalRange({ from: newFrom, to: newFrom + newWidth })
    }
    el.addEventListener('wheel', onWheel, { passive: false })

    // Keep some right-side whitespace but stop the last candle scrolling past the
    // horizontal center: clamp the right offset to at most half the visible width.
    const tscale = chart.timeScale()
    let clamping = false
    const onRange = (range: { from: number; to: number } | null) => {
      if (!range || clamping) return
      const n = lenRef.current
      if (n < 2) return
      const width = range.to - range.from
      const maxOffset = width / 2
      if (range.to - (n - 1) > maxOffset + 0.5) {
        clamping = true
        const to = (n - 1) + maxOffset
        tscale.setVisibleLogicalRange({ from: to - width, to })
        requestAnimationFrame(() => { clamping = false })
      }
    }
    tscale.subscribeVisibleLogicalRangeChange(onRange)

    const ro = new ResizeObserver(() => { if (el) chart.resize(el.clientWidth, el.clientHeight) })
    ro.observe(el)
    return () => { el.removeEventListener('wheel', onWheel); tscale.unsubscribeVisibleLogicalRangeChange(onRange); ro.disconnect(); chart.remove(); chartRef.current = null; candleRef.current = null; volumeRef.current = null; overlayRefs.current = [] }
  }, [])

  // fit=true frames the data (fresh ticker/timeframe load); fit=false is a live
  // refresh that updates bars in place and restores the user's zoom/pan so the
  // view doesn't snap back on every poll.
  const fetchCandles = useCallback(async (sym: string, tf: string, fit: boolean) => {
    setChartErr(false)
    try {
      // Always request full hours (pre/after-market) on intraday timeframes.
      const res = await fetch(`/api/market/ohlcv?ticker=${encodeURIComponent(sym)}&tf=${tf}${isIntraday(tf) ? '&prepost=true' : ''}`)
      if (!res.ok) throw new Error(`${res.status}`)
      const cs: Candle[] = (await res.json()).candles
      if (!cs?.length) throw new Error('no data')
      const ts = chartRef.current?.timeScale()
      const prevRange = !fit ? ts?.getVisibleLogicalRange() : null
      // Follow the right edge when already viewing the latest bars; otherwise
      // hold the scrolled-back position. Either way the zoom level is preserved.
      const follow = !fit && !!prevRange && prevRange.to >= lenRef.current - 2
      candleRef.current?.setData(cs.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close })))
      if (fit) {
        if (barSpacingRef.current > 0) { ts?.applyOptions({ barSpacing: barSpacingRef.current }); ts?.scrollToRealTime() }
        else applyWindow(ts, cs, windowRef.current)
      }
      else if (follow) ts?.scrollToRealTime()
      // Keep the scrolled view across interval switches, but snap to latest if the
      // old bar-index range now exceeds a much shorter series (e.g. 1m → 1mo).
      else if (prevRange) { if (prevRange.from >= cs.length - 1) ts?.scrollToRealTime(); else ts?.setVisibleLogicalRange(prevRange) }
      lenRef.current = cs.length
      setCandles(cs)
      setSpot(cs[cs.length - 1].close)
    } catch { if (fit) { setChartErr(true); setCandles([]) } }
  }, [])

  // Fresh load on ticker/timeframe change: frame the data.
  // Fit only on symbol change / first load; switching the candle interval keeps
  // the current zoom and scroll position instead of snapping back to default.
  const prevTickerRef = useRef<string | null>(null)
  useEffect(() => {
    if (!ticker || !candleRef.current) return
    const fit = prevTickerRef.current !== ticker
    prevTickerRef.current = ticker
    fetchCandles(ticker, tfKey, fit)
  }, [ticker, tfKey, fetchCandles])

  // Live refresh: intraday every 15s, daily+ every 60s, preserving zoom.
  useEffect(() => {
    if (!ticker) return
    const id = window.setInterval(() => { if (candleRef.current) fetchCandles(ticker, tfKey, false) }, isIntraday(tfKey) ? 15_000 : 60_000)
    return () => window.clearInterval(id)
  }, [ticker, tfKey, fetchCandles])

  // ── Account (cash, buying power, positions, fills) ──
  const account = useQuery<Account>({
    queryKey: ['paper-account', user?.id],
    queryFn: () => axios.get(`/api/paper/account?user_id=${user!.id}`, { headers: authHeaders }).then(r => r.data),
    enabled: authed,
    staleTime: 15_000,
    retry: 1,
  })

  // ── Indicator overlays ──
  // setData on the volume/overlay series resets the time scale to its default
  // view; capture and restore the visible range so live polls keep the zoom.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const keep = chart.timeScale().getVisibleLogicalRange()
    overlayRefs.current.forEach(s => { try { chart.removeSeries(s) } catch { /* gone */ } })
    overlayRefs.current = []
    if (volumeRef.current) volumeRef.current.setData(overlays.vol && candles.length
      ? candles.map(c => ({ time: c.time as Time, value: c.volume, color: c.close >= c.open ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)' }))
      : [])
    if (candles.length) {
      const close = candles.map(c => c.close)
      const times = candles.map(c => c.time as Time)
      const add = (vals: (number | null)[], color: string) => {
        const s = chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
        s.setData(vals.map((v, i) => (v == null ? null : { time: times[i], value: v })).filter(Boolean) as { time: Time; value: number }[])
        overlayRefs.current.push(s)
      }
      if (overlays.sma) add(smaArr(close, params.smaPeriod), '#60a5fa')
      if (overlays.ema) add(emaArr(close, params.emaPeriod), '#f59e0b')
      if (overlays.bb) { const b = bollinger(close, params.bbPeriod, params.bbMult); add(b.upper, '#a78bfa'); add(b.lower, '#a78bfa') }
      if (overlays.vwap) add(vwapArr(candles), '#22d3ee')
    }
    if (keep) chart.timeScale().setVisibleLogicalRange(keep)
  }, [candles, overlays, params])

  // ── Buy/sell markers from the user's fills on this ticker ──
  useEffect(() => {
    const series = candleRef.current
    if (!series) return
    if (!candles.length) { series.setMarkers([]); return }
    const mPos = readToken('--theme-positive', '#22c55e'), mNeg = readToken('--theme-negative', '#ef4444')
    const ctimes = candles.map(c => _numTime(c.time))
    const fills = (account.data?.orders ?? []).filter(o =>
      o.status === 'filled' && (o.symbol === ticker || occUnderlying(o.option_symbol || '') === ticker))
    const markers: SeriesMarker<Time>[] = fills.map(o => {
      const ot = o.created_at || 0
      let bi = 0, bd = Infinity
      ctimes.forEach((t, i) => { const d = Math.abs(t - ot); if (d < bd) { bd = d; bi = i } })
      const isBuy = String(o.side).startsWith('buy')
      return {
        time: candles[bi].time as Time,
        position: (isBuy ? 'belowBar' : 'aboveBar') as SeriesMarker<Time>['position'],
        color: isBuy ? mPos : mNeg,
        shape: (isBuy ? 'arrowUp' : 'arrowDown') as SeriesMarker<Time>['shape'],
        text: isBuy ? 'B' : 'S',
      }
    }).sort((a, b) => _numTime(a.time as number | string) - _numTime(b.time as number | string))
    series.setMarkers(markers)
  }, [candles, account.data, ticker])

  // ── On-chart order line for limit/stop orders ──
  // Draws a dashed price line at the working limit/stop level; the user drags it
  // (or clicks the chart) to set the price without touching the side inputs.
  // Only equity limit/stop orders map to an underlying price line; option limits
  // are a premium, not an underlying level, so the chart line is equity-only.
  const orderPx = instrument === 'equity' && otype !== 'market'
    ? (otype === 'limit' ? Number(limitPx) : Number(stopPx)) : NaN
  useEffect(() => {
    const series = candleRef.current
    if (!series) return
    if (orderLineRef.current) { try { series.removePriceLine(orderLineRef.current) } catch { /* gone */ } orderLineRef.current = null }
    if (!(orderPx > 0)) return
    orderLineRef.current = series.createPriceLine({
      price: orderPx,
      color: side === 'buy' ? readToken('--theme-positive', '#22c55e') : readToken('--theme-negative', '#ef4444'),
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `${side === 'buy' ? 'BUY' : 'SELL'} ${otype === 'limit' ? 'LMT' : 'STP'}`,
    })
  }, [otype, orderPx, side])

  // Drag the order line, or click anywhere on the chart, to set the price.
  useEffect(() => {
    const el = containerRef.current
    const chart = chartRef.current
    const series = candleRef.current
    if (!el || !chart || !series) return
    const setPx = (p: number) => {
      const v = p.toFixed(2)
      if (otype === 'limit') setLimitPx(v); else setStopPx(v)
    }
    const priceAtY = (clientY: number): number | null => {
      const rect = el.getBoundingClientRect()
      return series.coordinateToPrice(clientY - rect.top) as number | null
    }
    const onDown = (e: PointerEvent) => {
      if (otype === 'market' || !(orderPx > 0)) return
      const rect = el.getBoundingClientRect()
      const lineY = series.priceToCoordinate(orderPx)
      if (lineY == null || Math.abs((e.clientY - rect.top) - lineY) > 9) return
      draggingRef.current = true
      chart.applyOptions({ handleScroll: false, handleScale: false })
      try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return
      const p = priceAtY(e.clientY)
      if (p != null && p > 0) setPx(p)
    }
    const onUp = (e: PointerEvent) => {
      if (!draggingRef.current) return
      draggingRef.current = false
      chart.applyOptions({ handleScroll: true, handleScale: true })
      try { el.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    const onClick = (param: MouseEventParams) => {
      if (!(orderPx > 0) || draggingRef.current || !param.point) return
      const p = series.coordinateToPrice(param.point.y) as number | null
      if (p != null && p > 0) setPx(p)
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    chart.subscribeClick(onClick)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      chart.unsubscribeClick(onClick)
    }
  }, [otype, orderPx])

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

  // ── Options chain for the selected expiry (only in option mode) ──
  const chain = useQuery<OptionChain>({
    queryKey: ['paper-widget-chain', ticker, opExpiry],
    queryFn: () => axios.get(`/api/options/chain?ticker=${encodeURIComponent(ticker)}&expiry=${opExpiry}`).then(r => r.data),
    enabled: instrument === 'option' && !!opExpiry,
    staleTime: 60_000,
    retry: 0,
  })

  // Default the strike to ATM when the chain (or call/put) changes.
  useEffect(() => {
    if (instrument !== 'option') return
    const rows = (callPut === 'C' ? chain.data?.calls : chain.data?.puts) ?? []
    if (!rows.length) return
    const ks = rows.map(r => r.strike)
    if (strike && ks.includes(Number(strike))) return
    const sp = chain.data?.spot ?? spot ?? ks[Math.floor(ks.length / 2)]
    const atm = ks.reduce((b, s) => Math.abs(s - sp) < Math.abs(b - sp) ? s : b, ks[0])
    setStrike(String(atm))
  }, [instrument, callPut, opExpiry, chain.data])

  const optionOrder = useMutation({
    mutationFn: () => axios.post('/api/paper/order/option', {
      user_id: user!.id,
      option_symbol: buildOCC(ticker, opExpiry, strike, callPut),
      side: side === 'buy' ? 'buy_to_open' : 'sell_to_close',
      quantity: Number(qty),
      order_type: opType,
      price: opType === 'limit' ? Number(opLimit) : null,
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

  if (!authed) return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', background: T.bg, padding: 14, textAlign: 'center' }}>
      <span style={{ color: T.muted, fontFamily: T.label, fontSize: 11, lineHeight: 1.5 }}>Sign in to paper-trade<br />your own account.</span>
    </div>
  )

  const commitTicker = () => { const t = tickerInput.trim().toUpperCase(); if (t) { setTicker(t); setResult(null) } }
  // Seed the working price from spot so the on-chart line appears immediately.
  const chooseType = (t: OType) => {
    setOType(t)
    if (t === 'limit' && !(Number(limitPx) > 0) && spot != null) setLimitPx(spot.toFixed(2))
    if (t === 'stop' && !(Number(stopPx) > 0) && spot != null) setStopPx(spot.toFixed(2))
  }
  const qtyN = Number(qty)
  const isOption = instrument === 'option'
  const chainRows = (callPut === 'C' ? chain.data?.calls : chain.data?.puts) ?? []
  const strikes = chainRows.map(r => r.strike).sort((a, b) => a - b)
  const optPx = contractPrice(chainRows.find(r => String(r.strike) === strike))
  const pending = order.isPending || optionOrder.isPending
  // Switching to an option limit seeds the premium from the live mid.
  const chooseOpType = (t: 'market' | 'limit') => {
    setOpType(t)
    if (t === 'limit' && !(Number(opLimit) > 0) && optPx != null) setOpLimit(optPx.toFixed(2))
  }
  const valid = isOption
    ? qtyN > 0 && !!opExpiry && !!strike && (opType !== 'limit' || Number(opLimit) > 0)
    : qtyN > 0 && (otype !== 'limit' || Number(limitPx) > 0) && (otype !== 'stop' || Number(stopPx) > 0)
  const submit = () => {
    if (!valid || pending) return
    if (!confirming) { setConfirming(true); setTimeout(() => setConfirming(false), 4000); return }
    if (isOption) optionOrder.mutate(); else order.mutate()
  }
  const sideColor = side === 'buy' ? T.pos : T.neg
  const summary = isOption
    ? `${side === 'buy' ? 'Buy' : 'Sell'} ${qtyN || ''} ${ticker} ${strike || '—'}${callPut} ${opType === 'limit' ? `@ ${opLimit || '—'}` : '@ mkt'}`
    : `${side === 'buy' ? 'Buy' : 'Sell'} ${qtyN || ''} ${ticker} ${otype === 'market' ? '@ mkt' : otype === 'limit' ? `@ ${limitPx || '—'}` : `stp ${stopPx || '—'}`}`
  const lbl: React.CSSProperties = { fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted }
  const numLbl: React.CSSProperties = { fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.muted }
  const acct = account.data
  const pos = acct?.positions ?? []
  const optPos = acct?.option_positions ?? []
  const selStyle: React.CSSProperties = { background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, color: T.gold, fontFamily: T.mono, fontSize: 9, padding: '2px 4px', outline: 'none', cursor: 'pointer' }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      {/* Header: ticker + spot + overlays + timeframe */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '4px 8px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <input value={tickerInput} onChange={e => setTickerInput(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && commitTicker()} onBlur={commitTicker} style={{ ...inputStyle, width: 64, fontWeight: 700, color: T.gold }} />
        {spot != null && <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text }}>${spot.toFixed(2)}</span>}
        <span title="US market session (ET)" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: session.color, whiteSpace: 'nowrap' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: session.color, boxShadow: `0 0 5px ${session.color}` }} />
          {session.label}
        </span>
        <div style={{ display: 'flex', gap: 2, marginLeft: 'auto', position: 'relative' }}>
          {OVERLAYS.map(o => (
            <button key={o.key} onClick={() => setOverlays(s => ({ ...s, [o.key]: !s[o.key] }))} style={{
              fontFamily: T.mono, fontSize: 8, fontWeight: 700, padding: '2px 5px', cursor: 'pointer',
              border: overlays[o.key] ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`,
              background: overlays[o.key] ? 'rgba(201,168,76,0.12)' : 'transparent',
              color: overlays[o.key] ? T.gold : 'rgba(255,255,255,0.3)', letterSpacing: '0.04em',
            }}>{o.label}</button>
          ))}
          <button onClick={() => setOverlayCfgOpen(o => !o)} title="Overlay settings" style={{
            fontFamily: T.mono, fontSize: 9, fontWeight: 700, padding: '2px 5px', cursor: 'pointer',
            border: overlayCfgOpen ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`,
            background: overlayCfgOpen ? 'rgba(201,168,76,0.12)' : 'transparent',
            color: overlayCfgOpen ? T.gold : 'rgba(255,255,255,0.3)', display: 'flex', alignItems: 'center',
          }}><Sliders size={10} /></button>
          <select value={barSpacing > 0 ? 'custom' : windowKey} onChange={e => pickWindow(e.target.value)} style={selStyle} title="Graph width (visible span)">
            {WINDOWS.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
            {barSpacing > 0 && <option value="custom" disabled>Custom</option>}
          </select>
          <select value={tfKey} onChange={e => setTfKey(e.target.value)} style={selStyle} title="Candle interval">
            {TFS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>

          {overlayCfgOpen && (
            <div style={{ position: 'absolute', top: '120%', right: 0, zIndex: 30, width: 188, background: T.surface, border: `1px solid ${T.gold}`, boxShadow: '0 8px 24px rgba(0,0,0,0.45)', padding: 9, display: 'flex', flexDirection: 'column', gap: 7 }}>
              <span style={{ ...numLbl, color: T.gold, marginBottom: 1 }}>Overlay settings</span>
              {([
                { lbl: 'SMA period',   key: 'smaPeriod', step: 1,    min: 1 },
                { lbl: 'EMA period',   key: 'emaPeriod', step: 1,    min: 1 },
                { lbl: 'BB period',    key: 'bbPeriod',  step: 1,    min: 1 },
                { lbl: 'BB std-dev',   key: 'bbMult',    step: 0.5,  min: 0.5 },
              ] as { lbl: string; key: keyof OverlayParams; step: number; min: number }[]).map(f => (
                <label key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <span style={numLbl}>{f.lbl}</span>
                  <input type="number" min={f.min} step={f.step} value={params[f.key]}
                    onChange={e => { const n = Number(e.target.value); if (n >= f.min) setParams(p => ({ ...p, [f.key]: n })) }}
                    style={{ ...inputStyle, width: 56 }} />
                </label>
              ))}
              <span style={{ ...numLbl, color: T.gold, marginTop: 4 }}>Candle width</span>
              <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span style={numLbl}>Bar spacing</span>
                <input type="number" min={0} max={40} step={1} value={barSpacing} onChange={e => pickBarSpacing(Math.max(0, Math.min(40, Number(e.target.value))))} style={{ ...inputStyle, width: 56 }} />
              </label>
              <span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>0 = auto (fit to graph width)</span>
              <button onClick={() => { setParams({ ...DEFAULT_PARAMS }); pickBarSpacing(0); pickWindow('1D') }} style={{ alignSelf: 'flex-end', background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 8px', cursor: 'pointer' }}>Reset</button>
            </div>
          )}
        </div>
      </div>

      {/* Body: chart + order/positions sidebar */}
      <div style={{ display: 'flex', flexDirection: 'row', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
          {chartErr && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: T.mono, fontSize: 10, color: T.muted }}>No chart data</div>}
          {!isOption && otype !== 'market' && !chartErr && (
            <div style={{ position: 'absolute', top: 6, left: 8, fontFamily: T.mono, fontSize: 8.5, color: T.text, background: 'rgba(0,0,0,0.4)', border: `1px solid ${T.border}`, padding: '2px 6px', pointerEvents: 'none', letterSpacing: '0.03em' }}>
              Drag or click the chart to set {otype} price
            </div>
          )}
        </div>

        <div style={{ width: 178, flexShrink: 0, borderLeft: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 7, borderBottom: `1px solid ${T.border}`, overflowY: 'auto', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 0 }}>
              {(['equity', 'option'] as const).map(m => (
                <button key={m} onClick={() => { setInstrument(m); setResult(null); setConfirming(false) }} style={{
                  flex: 1, fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '4px 0', cursor: 'pointer',
                  border: `1px solid ${instrument === m ? T.gold : T.border}`,
                  background: instrument === m ? 'rgba(201,168,76,0.12)' : 'transparent',
                  color: instrument === m ? T.gold : T.muted,
                }}>{m}</button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 0 }}>
              {(['buy', 'sell'] as const).map(s => (
                <button key={s} onClick={() => setSide(s)} style={{
                  flex: 1, fontFamily: T.label, fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '8px 0', cursor: 'pointer',
                  border: `1px solid ${side === s ? (s === 'buy' ? T.pos : T.neg) : T.border}`,
                  background: side === s ? `color-mix(in srgb, ${s === 'buy' ? T.pos : T.neg} 18%, transparent)` : 'transparent',
                  color: side === s ? (s === 'buy' ? T.pos : T.neg) : T.muted,
                }}>{s}</button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ ...lbl, fontSize: 9, width: 30 }}>Qty</span>
              <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)} style={inputStyle} />
            </div>
            {!isOption && (
              <>
                <div style={{ display: 'flex', gap: 3 }}>
                  {(['market', 'limit', 'stop'] as OType[]).map(t => (
                    <button key={t} onClick={() => chooseType(t)} style={{
                      flex: 1, fontFamily: T.mono, fontSize: 10, fontWeight: 700, padding: '5px 0', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em',
                      border: `1px solid ${otype === t ? T.gold : T.border}`,
                      background: otype === t ? 'rgba(201,168,76,0.12)' : 'transparent',
                      color: otype === t ? T.gold : T.muted,
                    }}>{t.slice(0, 3)}</button>
                  ))}
                </div>
                {otype === 'limit' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ ...lbl, fontSize: 9, width: 30 }}>Lmt</span>
                    <input type="number" step="0.01" value={limitPx} onChange={e => setLimitPx(e.target.value)} placeholder={spot != null ? spot.toFixed(2) : ''} style={inputStyle} />
                  </div>
                )}
                {otype === 'stop' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ ...lbl, fontSize: 9, width: 30 }}>Stp</span>
                    <input type="number" step="0.01" value={stopPx} onChange={e => setStopPx(e.target.value)} placeholder={spot != null ? spot.toFixed(2) : ''} style={inputStyle} />
                  </div>
                )}
              </>
            )}

            {isOption && (
              <>
                <ExpirySelect ticker={ticker} value={opExpiry} onChange={setOpExpiry} autoSelect
                  style={{ ...inputStyle, color: T.gold, cursor: 'pointer' }} />
                <div style={{ display: 'flex', gap: 3 }}>
                  {(['C', 'P'] as const).map(cp => (
                    <button key={cp} onClick={() => setCallPut(cp)} style={{
                      flex: 1, fontFamily: T.mono, fontSize: 10, fontWeight: 700, padding: '5px 0', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em',
                      border: `1px solid ${callPut === cp ? T.gold : T.border}`,
                      background: callPut === cp ? 'rgba(201,168,76,0.12)' : 'transparent',
                      color: callPut === cp ? T.gold : T.muted,
                    }}>{cp === 'C' ? 'Call' : 'Put'}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ ...lbl, fontSize: 9, width: 36 }}>Strike</span>
                  <select value={strike} onChange={e => setStrike(e.target.value)} disabled={!strikes.length} style={{ ...inputStyle, cursor: strikes.length ? 'pointer' : 'not-allowed' }}>
                    {!strikes.length && <option value="">{chain.isLoading ? 'Loading…' : (opExpiry ? 'No strikes' : 'Pick expiry')}</option>}
                    {strikes.map(k => <option key={k} value={String(k)}>{k}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ ...lbl, fontSize: 9 }}>Contract</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.text }}>{optPx != null ? `$${optPx.toFixed(2)}` : '—'}</span>
                </div>
                <div style={{ display: 'flex', gap: 3 }}>
                  {(['market', 'limit'] as const).map(t => (
                    <button key={t} onClick={() => chooseOpType(t)} style={{
                      flex: 1, fontFamily: T.mono, fontSize: 10, fontWeight: 700, padding: '5px 0', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.04em',
                      border: `1px solid ${opType === t ? T.gold : T.border}`,
                      background: opType === t ? 'rgba(201,168,76,0.12)' : 'transparent',
                      color: opType === t ? T.gold : T.muted,
                    }}>{t.slice(0, 3)}</button>
                  ))}
                </div>
                {opType === 'limit' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ ...lbl, fontSize: 9, width: 36 }}>Lmt</span>
                    <input type="number" step="0.01" value={opLimit} onChange={e => setOpLimit(e.target.value)} placeholder={optPx != null ? optPx.toFixed(2) : ''} style={inputStyle} />
                  </div>
                )}
              </>
            )}

            <button onClick={submit} disabled={!valid || pending} style={{
              fontFamily: T.label, fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', padding: '9px 4px',
              border: 'none', cursor: valid && !pending ? 'pointer' : 'not-allowed',
              background: confirming ? T.gold : sideColor, color: 'var(--theme-bg, #0a1628)', opacity: valid && !pending ? 1 : 0.5,
            }}>
              {pending ? 'Placing…' : confirming ? `Confirm · ${summary}` : summary}
            </button>
            {result && <div style={{ fontFamily: T.mono, fontSize: 10, color: result.ok ? T.pos : T.neg, lineHeight: 1.3 }}>{result.text}</div>}
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '6px 10px', borderBottom: `1px solid ${T.border}` }}>
            <span style={{ ...lbl, fontSize: 9 }}>Buying power</span>
            <span style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text }}>{acct ? money(acct.buying_power) : '—'}</span>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px 4px' }}>
              <span style={{ ...lbl, fontSize: 9 }}>Positions</span>
              <button onClick={() => reset.mutate()} title="Reset paper account" style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted }}>Reset</button>
            </div>
            {pos.length === 0 && optPos.length === 0 ? (
              <div style={{ padding: '2px 10px 8px', fontFamily: T.mono, fontSize: 10, color: T.muted }}>{account.isLoading ? 'Loading…' : 'None open'}</div>
            ) : (<>
              {pos.map(p => (
                <div key={p.symbol} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 10px', borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold }}>{p.symbol}<span style={{ color: T.muted, fontSize: 9, marginLeft: 4 }}>{p.quantity}</span></span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: p.unrealized_pnl >= 0 ? T.pos : T.neg }}>{p.unrealized_pnl >= 0 ? '+' : ''}{p.unrealized_pnl.toFixed(0)}</span>
                </div>
              ))}
              {optPos.map(p => (
                <div key={p.option_symbol} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '4px 10px', borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.gold }}>{p.underlying} {p.strike}{p.type === 'call' ? 'C' : 'P'}<span style={{ color: T.muted, fontSize: 9, marginLeft: 4 }}>{p.quantity}</span></span>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: p.unrealized_pnl >= 0 ? T.pos : T.neg }}>{p.unrealized_pnl >= 0 ? '+' : ''}{p.unrealized_pnl.toFixed(0)}</span>
                </div>
              ))}
            </>)}
          </div>
        </div>
      </div>
    </div>
  )
}
