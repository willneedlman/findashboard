import { T } from '../lib/theme'
import { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, ColorType, CrosshairMode, LineStyle } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time, SeriesMarker, IPriceLine } from 'lightweight-charts'
import { Sliders, ChevronsRight } from 'lucide-react'
import { smaArr, emaArr, bollinger, vwapArr, type Candle } from '../lib/indicators'
import { marketSession } from '../lib/marketSession'
import { useLiveTick } from '../lib/useLiveTick'
import { occUnderlying } from '../lib/occ'
import { readToken } from '../lib/theme'


const TFS = [
  { key: '1m', label: '1m' }, { key: '3m', label: '3m' }, { key: '5m', label: '5m' }, { key: '10m', label: '10m' },
  { key: '1h', label: '1H' }, { key: '2h', label: '2H' }, { key: '6h', label: '6H' }, { key: '12h', label: '12H' },
  { key: '1d', label: '1D' }, { key: '1wk', label: '1W' }, { key: '1mo', label: '1Mo' },
]
const DAILY_TFS = ['1d', '1wk', '1mo']
const isIntraday = (tf: string) => !DAILY_TFS.includes(tf)

const OVERLAYS = [{ key: 'sma', label: 'SMA' }, { key: 'ema', label: 'EMA' }, { key: 'bb', label: 'BB' }, { key: 'vwap', label: 'VWAP' }, { key: 'vol', label: 'VOL' }] as const
type OverlayKey = typeof OVERLAYS[number]['key']
interface OverlayParams { smaPeriod: number; emaPeriod: number; bbPeriod: number; bbMult: number }
const DEFAULT_PARAMS: OverlayParams = { smaPeriod: 20, emaPeriod: 20, bbPeriod: 20, bbMult: 2 }
const DEFAULT_OVERLAYS: Record<OverlayKey, boolean> = { sma: false, ema: false, bb: false, vwap: false, vol: true }

// Graph width: how much time is visible at once. Default 1 trading day.
const WINDOWS = [{ key: '1D', label: '1D' }, { key: '1W', label: '1W' }, { key: '1M', label: '1M' }, { key: '3M', label: '3M' }, { key: 'all', label: 'All' }] as const
const WINDOW_SEC: Record<string, number> = { '1D': 86400, '1W': 604800, '1M': 2592000, '3M': 7776000 }
const numTime = (t: number | string) => (typeof t === 'number' ? t : Date.parse(t + 'T00:00:00Z') / 1000)

// Frame the visible range to the last `win` of data (by timestamp), keeping a
// minimum bar count so coarse timeframes don't collapse to a couple of bars.
function applyWindow(ts: ReturnType<IChartApi['timeScale']> | undefined, candles: Candle[], win: string) {
  if (!ts || !candles.length) return
  const lastIdx = candles.length - 1
  if (win === 'all' || !WINDOW_SEC[win]) { ts.fitContent(); return }
  const cutoff = numTime(candles[lastIdx].time) - WINDOW_SEC[win]
  let from = 0
  for (let i = lastIdx; i >= 0; i--) { if (numTime(candles[i].time) < cutoff) { from = i + 1; break } }
  from = Math.min(from, Math.max(0, lastIdx - 14))
  ts.setVisibleLogicalRange({ from, to: lastIdx + 3 })
}

interface ChartPrefs { on: Record<OverlayKey, boolean>; params: OverlayParams; windowKey: string }
function loadState(key: string): ChartPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(`paper-chart-overlays-${key}`) || 'null')
    if (raw) return { on: { ...DEFAULT_OVERLAYS, ...raw.on }, params: { ...DEFAULT_PARAMS, ...raw.params }, windowKey: raw.windowKey || '1D' }
  } catch { /* ignore */ }
  return { on: { ...DEFAULT_OVERLAYS }, params: { ...DEFAULT_PARAMS }, windowKey: '1D' }
}

export interface ChartFill { time: number; side: string; symbol?: string; option_symbol?: string }
// A resting equity limit/stop order, drawn as a persistent on-chart price line.
export interface ChartOrder { id: string; symbol: string; side: 'buy' | 'sell'; type: 'limit' | 'stop'; price: number }
export type PlaceOrderFn = (o: { symbol: string; price: number; side: 'buy' | 'sell'; type: 'limit' | 'stop' }) => void
export type CancelOrderFn = (id: string) => void

const inputStyle: React.CSSProperties = {
  background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, color: T.text,
  fontFamily: T.mono, fontSize: 12, padding: '4px 6px', outline: 'none', boxSizing: 'border-box',
}
const selStyle: React.CSSProperties = { background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, color: T.gold, fontFamily: T.mono, fontSize: 9, padding: '2px 4px', outline: 'none', cursor: 'pointer' }

export default function PaperChart({ initialTicker = 'SPY', fills = [], orders = [], onPlaceOrder, onCancelOrder, storageKey = 'page' }: { initialTicker?: string; fills?: ChartFill[]; orders?: ChartOrder[]; onPlaceOrder?: PlaceOrderFn; onCancelOrder?: CancelOrderFn; storageKey?: string }) {
  const init = loadState(storageKey)
  const [ticker, setTicker] = useState(initialTicker.toUpperCase())
  const [tickerInput, setTickerInput] = useState(initialTicker.toUpperCase())
  const [tfKey, setTfKey] = useState('10m')
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>(init.on)
  const [params, setParams] = useState<OverlayParams>(init.params)
  const [windowKey, setWindowKey] = useState(init.windowKey)
  const [cfgOpen, setCfgOpen] = useState(false)
  const [candles, setCandles] = useState<Candle[]>([])
  const [spot, setSpot] = useState<number | null>(null)
  const [chartErr, setChartErr] = useState(false)
  // True when the view is scrolled away from the latest candle, so the snap-back
  // ("auto fit") button is shown — like Robinhood's chevrons that jump to now.
  const [isAway, setIsAway] = useState(false)
  const awayRef = useRef(false)
  const [, setTick] = useState(0)
  useEffect(() => { const id = window.setInterval(() => setTick(t => t + 1), 30_000); return () => window.clearInterval(id) }, [])
  const session = marketSession(new Date(), ticker)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const overlayRefs = useRef<ISeriesApi<'Line'>[]>([])
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const lenRef = useRef(0)
  const pendingLinesRef = useRef<Map<string, IPriceLine>>(new Map())
  const [menu, setMenu] = useState<{ x: number; y: number; price: number; cancelId?: string; cancelLabel?: string } | null>(null)
  const windowRef = useRef(windowKey); useEffect(() => { windowRef.current = windowKey }, [windowKey])
  const candlesRef = useRef<Candle[]>([]); useEffect(() => { candlesRef.current = candles }, [candles])
  // Tick the forming candle from a live Tradier quote while the market is live.
  useLiveTick(ticker, !/closed|weekend|overnight/.test(session.key), candleRef, candlesRef, setSpot)

  useEffect(() => { try { localStorage.setItem(`paper-chart-overlays-${storageKey}`, JSON.stringify({ on: overlays, params, windowKey })) } catch { /* ignore */ } }, [overlays, params, windowKey, storageKey])

  // The window is the only framing control: candle width follows from the span.
  const pickWindow = (w: string) => { setWindowKey(w); applyWindow(chartRef.current?.timeScale(), candlesRef.current, w) }

  // Snap the view back to the latest data at the current framing.
  const snapBack = () => applyWindow(chartRef.current?.timeScale(), candlesRef.current, windowRef.current)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const cs = getComputedStyle(document.documentElement)
    const bg = cs.getPropertyValue('--theme-bg').trim() || '#101c2e'
    const txt = cs.getPropertyValue('--theme-secondary').trim() || '#8099b0'
    const gold = cs.getPropertyValue('--theme-primary').trim() || '#c9a84c'
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: bg }, textColor: txt, fontFamily: "ui-monospace, monospace", fontSize: 10 },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: `${gold}66` }, horzLine: { color: `${gold}66` } },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)', textColor: txt },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, fixLeftEdge: true, rightOffset: 6 },
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
    chartRef.current = chart; candleRef.current = candle; volumeRef.current = vol
    // Amplified zoom: trackpad pinch (ctrl+wheel) and plain wheel zoom around the cursor.
    const onWheel = (e: WheelEvent) => {
      const ts = chart.timeScale(); const range = ts.getVisibleLogicalRange(); if (!range) return
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
      // Show snap-back only while the latest candle is out of view (scrolled into
      // the past); hide it as soon as the present candle is back in sight.
      const away = (n - 1) - range.to > 3
      if (away !== awayRef.current) { awayRef.current = away; setIsAway(away) }
    }
    tscale.subscribeVisibleLogicalRangeChange(onRange)
    const ro = new ResizeObserver(() => { if (el) chart.resize(el.clientWidth, el.clientHeight) })
    ro.observe(el)
    return () => { el.removeEventListener('wheel', onWheel); tscale.unsubscribeVisibleLogicalRangeChange(onRange); ro.disconnect(); chart.remove(); chartRef.current = null; candleRef.current = null; volumeRef.current = null; overlayRefs.current = [] }
  }, [])

  const fetchCandles = useCallback(async (sym: string, tf: string, fit: boolean) => {
    setChartErr(false)
    try {
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
      if (fit) applyWindow(ts, cs, windowRef.current)
      else if (follow) ts?.scrollToRealTime()
      // Preserve the scrolled view on interval switches, but if the old bar-index
      // range now sits past a much shorter series (e.g. 1m → 1mo), snap to the
      // latest bars instead of leaving blank whitespace.
      else if (prevRange) { if (prevRange.from >= cs.length - 1) ts?.scrollToRealTime(); else ts?.setVisibleLogicalRange(prevRange) }
      lenRef.current = cs.length
      setCandles(cs); setSpot(cs[cs.length - 1].close)
    } catch { if (fit) { setChartErr(true); setCandles([]) } }
  }, [])

  // Re-frame (fit) only when the symbol changes or on first load; switching the
  // candle interval keeps the current zoom/scroll instead of snapping to default.
  const prevTickerRef = useRef<string | null>(null)
  useEffect(() => {
    if (!ticker || !candleRef.current) return
    const fit = prevTickerRef.current !== ticker
    prevTickerRef.current = ticker
    fetchCandles(ticker, tfKey, fit)
  }, [ticker, tfKey, fetchCandles])
  useEffect(() => {
    if (!ticker) return
    const id = window.setInterval(() => { if (candleRef.current) fetchCandles(ticker, tfKey, false) }, isIntraday(tfKey) ? 15_000 : 60_000)
    return () => window.clearInterval(id)
  }, [ticker, tfKey, fetchCandles])

  // Overlays. setData on the volume/overlay series resets the time scale to its
  // default view, so capture and restore the visible range around the update —
  // otherwise every live poll would yank the chart back to default zoom.
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
      if (overlays.vwap) add(vwapArr(candles, isIntraday(tfKey)), '#22d3ee')
    }
    if (keep) chart.timeScale().setVisibleLogicalRange(keep)
  }, [candles, overlays, params])

  // Buy/sell markers from this ticker's fills
  useEffect(() => {
    const series = candleRef.current
    if (!series) return
    if (!candles.length) { series.setMarkers([]); return }
    const mPos = readToken('--theme-positive', '#22c55e'), mNeg = readToken('--theme-negative', '#ef4444')
    const ctimes = candles.map(c => numTime(c.time))
    const mine = fills.filter(o => o.symbol === ticker || occUnderlying(o.option_symbol || '') === ticker)
    const markers: SeriesMarker<Time>[] = mine.map(o => {
      let bi = 0, bd = Infinity
      ctimes.forEach((t, i) => { const d = Math.abs(t - (o.time || 0)); if (d < bd) { bd = d; bi = i } })
      const isBuy = String(o.side).startsWith('buy')
      return {
        time: candles[bi].time as Time,
        position: (isBuy ? 'belowBar' : 'aboveBar') as SeriesMarker<Time>['position'],
        color: isBuy ? mPos : mNeg,
        shape: (isBuy ? 'arrowUp' : 'arrowDown') as SeriesMarker<Time>['shape'],
        text: isBuy ? 'B' : 'S',
      }
    }).sort((a, b) => numTime(a.time as number | string) - numTime(b.time as number | string))
    series.setMarkers(markers)
  }, [candles, fills, ticker])

  // Resting limit/stop orders for this ticker → persistent dashed price lines.
  // Driven off account state (not the order form), so they stay put regardless of
  // which order-type tab is active and multiple can show at once. Diff-rendered so
  // live polls don't flicker the lines.
  useEffect(() => {
    const series = candleRef.current
    if (!series) return
    const cPos = readToken('--theme-positive', '#22c55e'), cNeg = readToken('--theme-negative', '#ef4444')
    const mine = orders.filter(o => o.symbol === ticker && o.price > 0)
    const want = new Set(mine.map(o => o.id))
    for (const [id, line] of pendingLinesRef.current) {
      if (!want.has(id)) { try { series.removePriceLine(line) } catch { /* gone */ } pendingLinesRef.current.delete(id) }
    }
    for (const o of mine) {
      const opts = {
        price: o.price, color: o.side === 'buy' ? cPos : cNeg, lineWidth: 2 as const,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true,
        title: `${o.side === 'buy' ? 'BUY' : 'SELL'} ${o.type === 'limit' ? 'LMT' : 'STP'}`,
      }
      const existing = pendingLinesRef.current.get(o.id)
      if (existing) existing.applyOptions(opts)
      else pendingLinesRef.current.set(o.id, series.createPriceLine(opts))
    }
  }, [orders, ticker, candles])

  // Right-click a price level to drop a resting order — or, when the click lands
  // on an existing pending order line, to cancel that order instead.
  const onChartContextMenu = (e: React.MouseEvent) => {
    if (!onPlaceOrder && !onCancelOrder) return
    const series = candleRef.current, el = containerRef.current
    if (!series || !el) return
    e.preventDefault()
    const rect = el.getBoundingClientRect()
    const clickY = e.clientY - rect.top
    const price = series.coordinateToPrice(clickY) as number | null
    if (price == null || !(price > 0)) return
    let hit: { id: string; label: string } | undefined
    if (onCancelOrder) {
      for (const o of orders.filter(o => o.symbol === ticker && o.price > 0)) {
        const oy = series.priceToCoordinate(o.price)
        if (oy != null && Math.abs(oy - clickY) <= 6) {
          hit = { id: o.id, label: `${o.side === 'buy' ? 'BUY' : 'SELL'} ${o.type === 'limit' ? 'LMT' : 'STP'} ${o.price.toFixed(2)}` }
          break
        }
      }
    }
    setMenu({ x: e.clientX - rect.left, y: clickY, price, cancelId: hit?.id, cancelLabel: hit?.label })
  }
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu])

  const commitTicker = () => { const t = tickerInput.trim().toUpperCase(); if (t) setTicker(t) }
  const numLbl: React.CSSProperties = { fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.muted }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', padding: '5px 8px', background: 'rgba(0,0,0,0.15)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <input value={tickerInput} onChange={e => setTickerInput(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && commitTicker()} onBlur={commitTicker} style={{ ...inputStyle, width: 72, fontWeight: 700, color: T.gold }} />
        {spot != null && <span style={{ fontFamily: T.mono, fontSize: 12, color: T.text }}>${spot.toFixed(2)}</span>}
        <span title="US market session (ET)" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: session.color, whiteSpace: 'nowrap' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: session.color, boxShadow: `0 0 6px ${session.color}` }} />
          {session.label}
        </span>
        <div style={{ display: 'flex', gap: 2, marginLeft: 'auto', position: 'relative' }}>
          {OVERLAYS.map(o => (
            <button key={o.key} onClick={() => setOverlays(s => ({ ...s, [o.key]: !s[o.key] }))} style={{
              fontFamily: T.mono, fontSize: 8, fontWeight: 700, padding: '2px 6px', cursor: 'pointer', letterSpacing: '0.04em',
              border: overlays[o.key] ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`,
              background: overlays[o.key] ? 'rgba(201,168,76,0.12)' : 'transparent',
              color: overlays[o.key] ? T.gold : 'rgba(255,255,255,0.3)',
            }}>{o.label}</button>
          ))}
          <button onClick={() => setCfgOpen(o => !o)} title="Overlay settings" style={{
            fontFamily: T.mono, fontSize: 9, fontWeight: 700, padding: '2px 5px', cursor: 'pointer', display: 'flex', alignItems: 'center',
            border: cfgOpen ? '1px solid rgba(201,168,76,0.55)' : `1px solid ${T.border}`,
            background: cfgOpen ? 'rgba(201,168,76,0.12)' : 'transparent', color: cfgOpen ? T.gold : 'rgba(255,255,255,0.3)',
          }}><Sliders size={11} /></button>
          <select value={windowKey} onChange={e => pickWindow(e.target.value)} style={selStyle} title="Graph width (visible span)">
            {WINDOWS.map(w => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
          <select value={tfKey} onChange={e => setTfKey(e.target.value)} style={selStyle} title="Candle interval">
            {TFS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          {cfgOpen && (
            <div style={{ position: 'absolute', top: '120%', right: 0, zIndex: 30, width: 196, background: T.surface, border: `1px solid ${T.gold}`, boxShadow: '0 8px 24px rgba(0,0,0,0.45)', padding: 10, display: 'flex', flexDirection: 'column', gap: 7 }}>
              <span style={{ ...numLbl, color: T.gold, marginBottom: 1 }}>Overlay settings</span>
              {([
                { lbl: 'SMA period', key: 'smaPeriod', step: 1, min: 1 },
                { lbl: 'EMA period', key: 'emaPeriod', step: 1, min: 1 },
                { lbl: 'BB period', key: 'bbPeriod', step: 1, min: 1 },
                { lbl: 'BB std-dev', key: 'bbMult', step: 0.5, min: 0.5 },
              ] as { lbl: string; key: keyof OverlayParams; step: number; min: number }[]).map(f => (
                <label key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                  <span style={numLbl}>{f.lbl}</span>
                  <input type="number" min={f.min} step={f.step} value={params[f.key]} onChange={e => { const n = Number(e.target.value); if (n >= f.min) setParams(p => ({ ...p, [f.key]: n })) }} style={{ ...inputStyle, width: 60 }} />
                </label>
              ))}
              <button onClick={() => { setParams({ ...DEFAULT_PARAMS }); pickWindow('1D') }} style={{ alignSelf: 'flex-end', background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '2px 8px', cursor: 'pointer' }}>Reset</button>
            </div>
          )}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }} onContextMenu={onChartContextMenu}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {menu && (onPlaceOrder || onCancelOrder) && (
          <OrderContextMenu menu={menu} ticker={ticker} spot={spot} onClose={() => setMenu(null)}
            onCancel={menu.cancelId && onCancelOrder ? () => { onCancelOrder(menu.cancelId!); setMenu(null) } : undefined}
            onPick={onPlaceOrder ? (side, type) => { onPlaceOrder({ symbol: ticker, price: menu.price, side, type }); setMenu(null) } : undefined} />
        )}
        {chartErr && <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: T.mono, fontSize: 11, color: T.muted }}>No chart data</div>}
        {isAway && !chartErr && (
          <button onClick={snapBack} title="Snap back to latest" aria-label="Snap back to latest"
            style={{
              position: 'absolute', right: 56, bottom: 16, zIndex: 5,
              display: 'flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36,
              // Drive off --theme-primary (always a strong accent: gold on dark,
              // near-black on Paper White) so the control is high-contrast on every preset.
              background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, var(--theme-surface, #1f2a3d))',
              border: '1.5px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)',
              borderRadius: 8, cursor: 'pointer', color: 'var(--theme-primary, #c9a84c)',
              boxShadow: '0 2px 10px rgba(0,0,0,0.28)',
              transition: 'background 0.15s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 24%, var(--theme-surface, #1f2a3d))' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, var(--theme-surface, #1f2a3d))' }}>
            <ChevronsRight size={19} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  )
}

// Only the order types that actually REST at the clicked level are offered, so a
// right-click can't accidentally place a marketable (immediately-filling) order.
// Below the market: buy limit / sell stop. Above it: sell limit / buy stop.
const BELOW_ACTIONS = [
  { side: 'buy', type: 'limit', label: 'Buy limit', color: T.pos },
  { side: 'sell', type: 'stop', label: 'Sell stop', color: T.neg },
] as const
const ABOVE_ACTIONS = [
  { side: 'sell', type: 'limit', label: 'Sell limit', color: T.neg },
  { side: 'buy', type: 'stop', label: 'Buy stop', color: T.pos },
] as const

function OrderContextMenu({ menu, ticker, spot, onClose, onPick, onCancel }: {
  menu: { x: number; y: number; price: number; cancelLabel?: string }
  ticker: string
  spot: number | null
  onClose: () => void
  onPick?: (side: 'buy' | 'sell', type: 'limit' | 'stop') => void
  onCancel?: () => void
}) {
  const W = 168
  const left = `min(${menu.x}px, calc(100% - ${W + 8}px))`
  const top = `min(${menu.y}px, calc(100% - 110px))`
  // No spot yet → offer everything; otherwise only the resting side.
  const actions = spot == null
    ? [...BELOW_ACTIONS, ...ABOVE_ACTIONS]
    : menu.price < spot ? BELOW_ACTIONS : ABOVE_ACTIONS
  const rel = spot == null ? '' : menu.price < spot ? 'below market' : 'above market'
  return (
    <>
      <div onClick={onClose} onContextMenu={e => { e.preventDefault(); onClose() }}
        style={{ position: 'absolute', inset: 0, zIndex: 19 }} />
      <div style={{
        position: 'absolute', left, top, width: W, zIndex: 20,
        background: T.surface, border: `1px solid ${T.gold}`, boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
      }}>
        <div style={{ padding: '6px 9px', borderBottom: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 10 }}>
          {onCancel
            ? <span style={{ color: T.gold, fontWeight: 700 }}>{menu.cancelLabel}</span>
            : <>
                <span style={{ color: T.muted }}>{ticker} @ </span>
                <span style={{ color: T.gold, fontWeight: 700 }}>${menu.price.toFixed(2)}</span>
                {rel && <span style={{ color: T.muted, fontSize: 8.5, marginLeft: 5 }}>{rel}</span>}
              </>}
        </div>
        {onCancel ? (
          <button onClick={onCancel}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px',
              background: 'transparent', border: 'none', color: T.neg, fontFamily: T.mono,
              fontSize: 11, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.04em',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'color-mix(in srgb, var(--theme-negative) 12%, transparent)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
          >Cancel order</button>
        ) : actions.map(a => (
          <button key={`${a.side}-${a.type}`} onClick={() => onPick?.(a.side, a.type)}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px',
              background: 'transparent', border: 'none', borderBottom: `1px solid ${T.border}`,
              color: a.color, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'color-mix(in srgb, var(--theme-primary) 10%, transparent)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent' }}
          >{a.label}</button>
        ))}
      </div>
    </>
  )
}
