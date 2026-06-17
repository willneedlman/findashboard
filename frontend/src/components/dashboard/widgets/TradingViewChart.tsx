import { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { readToken } from '../../../lib/theme'

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

  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef      = useRef<IChartApi | null>(null)
  const candleRef     = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef     = useRef<ISeriesApi<'Histogram'> | null>(null)

  const [period, setPeriod]   = useState('1y')
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [crosshair, setCrosshair] = useState<{ date: string; open: number; high: number; low: number; close: number; pct: number } | null>(null)

  // Create chart once
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const cs      = getComputedStyle(document.documentElement)
    const bg      = cs.getPropertyValue('--theme-bg').trim()      || '#101c2e'
    const surface = cs.getPropertyValue('--theme-surface').trim() || '#0d1826'
    const gold    = cs.getPropertyValue('--theme-primary').trim() || '#c9a84c'
    const text    = cs.getPropertyValue('--theme-secondary').trim()|| '#5e768f'
    const grid    = 'var(--theme-hover, var(--theme-hover, rgba(255,255,255,0.04)))'

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: bg },
        textColor:  text,
        fontFamily: "'JetBrains Mono', monospace",
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

    const ro = new ResizeObserver(() => {
      if (el) chart.resize(el.clientWidth, el.clientHeight)
    })
    ro.observe(el)

    return () => {
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

  return (
    <div style={{ height: '100%', minHeight: 300, display: 'flex', flexDirection: 'column', background: 'var(--theme-bg, #101c2e)', overflow: 'hidden' }}>

      {/* Chart */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,28,46,0.65)' }}>
            <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 10, color: 'var(--theme-secondary, #5e768f)', letterSpacing: '0.12em' }}>LOADING…</span>
          </div>
        )}
        {error && !loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-secondary, #5e768f)' }}>Chart unavailable</div>
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.18))' }}>{error}</div>
          </div>
        )}
      </div>
    </div>
  )
}
