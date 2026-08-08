import { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { readToken } from '../../../lib/theme'
import { ChevronsRight } from 'lucide-react'
import { useLiveMarks } from '../../../hooks/useLiveMarks'
import EmptyState from '../../EmptyState'

const PERIODS = [
  { label: '1M', value: '1mo' },
  { label: '3M', value: '3mo' },
  { label: '6M', value: '6mo' },
  { label: '1Y', value: '1y' },
  { label: '2Y', value: '2y' },
  { label: '5Y', value: '5y' },
]

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number }

function toTVSymbol(ticker: string): string {
  if (ticker.includes(':')) return ticker.split(':')[1]
  if (ticker.endsWith('-USD')) return ticker.replace('-USD', '')
  return ticker
}

export default function TradingViewChart({ config }: { config: WidgetConfig }) {
  const ticker    = (config.ticker || 'SPY').toUpperCase()
  const displaySym = toTVSymbol(ticker)
  const liveMarks = useLiveMarks([ticker])
  const livePrice = liveMarks[ticker]

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef      = useRef<IChartApi | null>(null)
  const candleRef     = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef     = useRef<ISeriesApi<'Histogram'> | null>(null)
  const lenRef        = useRef(0)
  const awayRef       = useRef(false)

  const [period, setPeriod]   = useState('1y')
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  // True when zoomed/panned away from the full fit → show the snap-back button.
  const [isAway, setIsAway]   = useState(false)
  const [crosshair, setCrosshair] = useState<{ date: string; open: number; high: number; low: number; close: number; pct: number } | null>(null)

  // Create chart once
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const cs      = getComputedStyle(document.documentElement)
    const bg      = cs.getPropertyValue('--theme-bg').trim()      || '#101c2e'
    const surface = cs.getPropertyValue('--theme-surface').trim() || '#0d1826'
    const gold    = cs.getPropertyValue('--theme-primary').trim() || '#c9a84c'
    const text    = cs.getPropertyValue('--theme-secondary').trim()|| '#8099b0'
    const grid    = 'var(--theme-hover, var(--theme-hover, rgba(255,255,255,0.04)))'

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: bg },
        textColor:  text,
        fontFamily: "ui-monospace, monospace",
        fontSize:   10,
      },
      grid: {
        vertLines:   { color: grid },
        horzLines:   { color: grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: `${gold}66`, labelBackgroundColor: surface },
        horzLine: { color: `${gold}66`, labelBackgroundColor: surface },
      },
      rightPriceScale: {
        borderColor: 'var(--theme-border, rgba(255,255,255,0.06))',
        textColor:   text,
      },
      timeScale: {
        borderColor:    'var(--theme-border, rgba(255,255,255,0.06))',
        timeVisible:    false,
        secondsVisible: false,
      },
      handleScroll:    { mouseWheel: true, pressedMouseMove: true },
      handleScale:     { mouseWheel: true, pinch: true },
      width:  el.clientWidth,
      height: el.clientHeight,
    })

    const cPos = readToken('--theme-positive', '#22c55e'), cNeg = readToken('--theme-negative', '#ef4444')
    const candle = chart.addCandlestickSeries({
      upColor:         cPos,
      downColor:       cNeg,
      borderUpColor:   cPos,
      borderDownColor: cNeg,
      wickUpColor:     cPos,
      wickDownColor:   cNeg,
      priceLineColor:  gold,
      priceLineWidth:  1,
    })

    const volume = chart.addHistogramSeries({
      color:        `${gold}2e`,
      priceFormat:  { type: 'volume' },
      priceScaleId: 'vol',
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.seriesData) { setCrosshair(null); return }
      const d = param.seriesData.get(candle) as Candle | undefined
      if (!d) { setCrosshair(null); return }
      setCrosshair({
        date:  String(param.time),
        open:  d.open,
        high:  d.high,
        low:   d.low,
        close: d.close,
        pct:   d.open !== 0 ? ((d.close - d.open) / d.open) * 100 : 0,
      })
    })

    chartRef.current  = chart
    candleRef.current = candle
    volumeRef.current = volume

    // The default view is fitContent (the full series). Offer snap-back when the
    // view is zoomed in or panned so it no longer covers the whole range.
    const tscale = chart.timeScale()
    const onRange = (range: { from: number; to: number } | null) => {
      const n = lenRef.current
      if (!range || n < 2) return
      // Only when the latest candle is out of view; hides once it's back in sight.
      const away = (n - 1) - range.to > 2
      if (away !== awayRef.current) { awayRef.current = away; setIsAway(away) }
    }
    tscale.subscribeVisibleLogicalRangeChange(onRange)

    const ro = new ResizeObserver(() => {
      if (el) chart.resize(el.clientWidth, el.clientHeight)
    })
    ro.observe(el)

    return () => {
      tscale.unsubscribeVisibleLogicalRangeChange(onRange)
      ro.disconnect()
      chart.remove()
      chartRef.current  = null
      candleRef.current = null
      volumeRef.current = null
    }
  }, [])

  const fetchData = useCallback(async (sym: string, p: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/market/ohlcv?ticker=${encodeURIComponent(sym)}&period=${p}`)
      if (!res.ok) throw new Error(`${res.status}`)
      const json = await res.json()
      const candles: Candle[] = json.candles
      if (!candles?.length) throw new Error('no data')
      candleRef.current?.setData(candles.map(c => ({ time: c.time as `${number}-${number}-${number}`, open: c.open, high: c.high, low: c.low, close: c.close })))
      volumeRef.current?.setData(candles.map(c => ({ time: c.time as `${number}-${number}-${number}`, value: c.volume, color: c.close >= c.open ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)' })))
      lenRef.current = candles.length
      chartRef.current?.timeScale().fitContent()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (candleRef.current) fetchData(ticker, period)
  }, [ticker, period, fetchData])

  const pos  = crosshair?.pct != null && crosshair.pct >= 0
  const pctColor = pos ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'
  const snapBack = () => chartRef.current?.timeScale().fitContent()

  return (
    <div style={{ height: '100%', minHeight: 300, display: 'flex', flexDirection: 'column', background: 'var(--theme-bg, #101c2e)', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, height: 30, padding: '0 10px',
        borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        background: 'var(--theme-surface, #0d1826)', flexShrink: 0,
        fontFamily: 'var(--theme-mono)',
      }}>
        <span style={{ color: 'var(--theme-primary, #c9a84c)', fontSize: 11, fontWeight: 700 }}>{displaySym}</span>
        {crosshair ? (
          <>
            <span style={{ color: 'var(--theme-secondary, #8099b0)', fontSize: 9 }}>{crosshair.date}</span>
            <span style={{ color: 'var(--theme-text, #d7e3fc)', fontSize: 9 }}>O {crosshair.open.toFixed(2)}</span>
            <span style={{ color: 'var(--theme-text, #d7e3fc)', fontSize: 9 }}>H {crosshair.high.toFixed(2)}</span>
            <span style={{ color: 'var(--theme-text, #d7e3fc)', fontSize: 9 }}>L {crosshair.low.toFixed(2)}</span>
            <span style={{ color: pctColor, fontSize: 9 }}>C {crosshair.close.toFixed(2)} {crosshair.pct >= 0 ? '+' : ''}{crosshair.pct.toFixed(2)}%</span>
          </>
        ) : (
          <span style={{ color: 'var(--theme-text, #d7e3fc)', fontSize: 12, fontWeight: 700 }}>
            {livePrice == null ? '-' : `$${livePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          </span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,28,46,0.65)' }}>
            <EmptyState variant="loading" size="compact" title="Loading candles" />
          </div>
        )}
        {error && !loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-secondary, #8099b0)' }}>Chart unavailable</div>
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.18))' }}>{error}</div>
          </div>
        )}
        {isAway && !loading && !error && (
          <button onClick={snapBack} title="Snap back to latest" aria-label="Snap back to latest"
            style={{
              position: 'absolute', right: 52, bottom: 14, zIndex: 5,
              display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34,
              background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, var(--theme-surface, #1f2a3d))',
              border: '1.5px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)',
              borderRadius: 8, cursor: 'pointer', color: 'var(--theme-primary, #c9a84c)',
              boxShadow: '0 2px 10px rgba(0,0,0,0.28)', transition: 'background 0.15s ease',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 24%, var(--theme-surface, #1f2a3d))' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, var(--theme-surface, #1f2a3d))' }}>
            <ChevronsRight size={18} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  )
}
