import { useEffect, useRef, useState, useCallback } from 'react'
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { WidgetConfig } from '../../../hooks/useDashboard'

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
    const grid    = 'rgba(255,255,255,0.04)'

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
        borderColor: 'rgba(255,255,255,0.06)',
        textColor:   text,
      },
      timeScale: {
        borderColor:    'rgba(255,255,255,0.06)',
        timeVisible:    false,
        secondsVisible: false,
      },
      handleScroll:    { mouseWheel: true, pressedMouseMove: true },
      handleScale:     { mouseWheel: true, pinch: true },
      width:  el.clientWidth,
      height: el.clientHeight,
    })

    const candle = chart.addCandlestickSeries({
      upColor:         '#22c55e',
      downColor:       '#ef4444',
      borderUpColor:   '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor:     '#22c55e',
      wickDownColor:   '#ef4444',
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
  const pctColor = pos ? '#22c55e' : '#ef4444'

  return (
    <div style={{ height: '100%', minHeight: 300, display: 'flex', flexDirection: 'column', background: 'var(--theme-bg, #101c2e)', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 10px 5px', background: 'var(--theme-surface, #0d1826)', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--theme-primary, #c9a84c)', flexShrink: 0 }} />
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', letterSpacing: '0.1em' }}>
          {displaySym}
        </span>
        {crosshair ? (
          <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: '#d7e3fc', letterSpacing: '0.04em', display: 'flex', gap: 8 }}>
            <span style={{ color: '#5e768f' }}>{crosshair.date}</span>
            <span>O <span style={{ color: '#d7e3fc' }}>{crosshair.open.toFixed(2)}</span></span>
            <span>H <span style={{ color: '#22c55e' }}>{crosshair.high.toFixed(2)}</span></span>
            <span>L <span style={{ color: '#ef4444' }}>{crosshair.low.toFixed(2)}</span></span>
            <span>C <span style={{ color: '#d7e3fc' }}>{crosshair.close.toFixed(2)}</span></span>
            <span style={{ color: pctColor }}>{crosshair.pct >= 0 ? '+' : ''}{crosshair.pct.toFixed(2)}%</span>
          </span>
        ) : (
          <span style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 9, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
            Candlestick · Daily
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
          {PERIODS.map(p => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              style={{
                fontFamily:  'JetBrains Mono, monospace',
                fontSize:    9,
                fontWeight:  700,
                padding:     '2px 6px',
                border:      period === p.value ? '1px solid rgba(201,168,76,0.55)' : '1px solid rgba(255,255,255,0.07)',
                background:  period === p.value ? 'rgba(201,168,76,0.12)' : 'transparent',
                color:       period === p.value ? 'var(--theme-primary, #c9a84c)' : 'rgba(255,255,255,0.3)',
                cursor:      'pointer',
                letterSpacing: '0.08em',
                transition:  'all 0.12s',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Chart */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,28,46,0.65)' }}>
            <span style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 10, color: 'var(--theme-secondary, #5e768f)', letterSpacing: '0.12em' }}>LOADING…</span>
          </div>
        )}
        {error && !loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <div style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 11, color: 'var(--theme-secondary, #5e768f)' }}>Chart unavailable</div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 9, color: 'rgba(255,255,255,0.18)' }}>{error}</div>
          </div>
        )}
      </div>
    </div>
  )
}
