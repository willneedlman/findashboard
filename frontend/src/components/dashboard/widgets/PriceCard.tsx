import { useEffect, useRef, useState, useCallback } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { readToken } from '../../../lib/theme'
import { useLiveMarks } from '../../../hooks/useLiveMarks'
import EmptyState from '../../EmptyState'

const T = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))', headerBg: 'var(--theme-surface, #0d1826)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #8099b0)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
  pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)',
}

interface PriceData {
  metrics: {
    current_price: number
    ann_volatility: number
    max_drawdown: number
  }
  price: { date: string; value: number }[]
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, var(--theme-border-faint, var(--theme-border-faint, rgba(255,255,255,0.05))) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 2s infinite',
  borderRadius: 3,
}

const PERIODS = [
  { label: '1M', value: '1mo' },
  { label: '3M', value: '3mo' },
  { label: '6M', value: '6mo' },
  { label: '1Y', value: '1y' },
  { label: '2Y', value: '2y' },
  { label: '5Y', value: '5y' },
]

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number }

function CandleChart({ ticker }: { ticker: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<IChartApi | null>(null)
  const candleRef    = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef    = useRef<ISeriesApi<'Histogram'> | null>(null)
  const [period, setPeriod]   = useState('1y')
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const cs      = getComputedStyle(document.documentElement)
    const bg      = cs.getPropertyValue('--theme-bg').trim()       || '#101c2e'
    const surface = cs.getPropertyValue('--theme-surface').trim()  || '#0d1826'
    const gold    = cs.getPropertyValue('--theme-primary').trim()  || '#c9a84c'
    const text    = cs.getPropertyValue('--theme-secondary').trim()|| '#8099b0'

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: bg },
        textColor: text,
        fontFamily: "ui-monospace, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: 'var(--theme-hover, var(--theme-hover, rgba(255,255,255,0.03)))' },
        horzLines: { color: 'var(--theme-hover, var(--theme-hover, rgba(255,255,255,0.03)))' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: `${gold}66`, labelBackgroundColor: surface },
        horzLine: { color: `${gold}66`, labelBackgroundColor: surface },
      },
      rightPriceScale: { borderColor: 'var(--theme-border, rgba(255,255,255,0.06))', textColor: text },
      timeScale:       { borderColor: 'var(--theme-border, rgba(255,255,255,0.06))', timeVisible: false },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale:  { mouseWheel: true, pinch: true },
      width:  el.clientWidth,
      height: el.clientHeight,
    })
    const cPos = readToken('--theme-positive', '#22c55e'), cNeg = readToken('--theme-negative', '#ef4444')
    const candle = chart.addCandlestickSeries({
      upColor: cPos, downColor: cNeg,
      borderUpColor: cPos, borderDownColor: cNeg,
      wickUpColor: cPos, wickDownColor: cNeg,
      priceLineColor: gold,
      priceLineWidth: 1,
    })
    const volume = chart.addHistogramSeries({
      color: `${gold}26`,
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
    chartRef.current  = chart
    candleRef.current = candle
    volumeRef.current = volume
    const ro = new ResizeObserver(() => { if (el) chart.resize(el.clientWidth, el.clientHeight) })
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; candleRef.current = null; volumeRef.current = null }
  }, [])

  const fetchData = useCallback(async (sym: string, p: string) => {
    setLoading(true); setError(null)
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

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 2, padding: '3px 8px', background: 'rgba(0,0,0,0.15)', flexShrink: 0 }}>
        {PERIODS.map(p => (
          <button key={p.value} onClick={() => setPeriod(p.value)} style={{
            fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700,
            padding: '2px 6px',
            border: period === p.value ? '1px solid rgba(201,168,76,0.55)' : '1px solid var(--theme-border, rgba(255,255,255,0.07))',
            background: period === p.value ? 'rgba(201,168,76,0.12)' : 'transparent',
            color: period === p.value ? 'var(--theme-primary, #c9a84c)' : 'rgba(255,255,255,0.3)',
            cursor: 'pointer', letterSpacing: '0.08em',
          }}>{p.label}</button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        {loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,28,46,0.65)' }}>
            <EmptyState variant="loading" size="compact" title="Loading price history" />
          </div>
        )}
        {error && !loading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--theme-secondary, #8099b0)' }}>Chart unavailable</div>
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.18))' }}>{error}</div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function PriceCard({ config }: { config: WidgetConfig }) {
  const ticker = config.ticker
  const liveMarks = useLiveMarks(ticker ? [ticker] : [])

  const { data, isLoading, isError } = useQuery<PriceData>({
    queryKey: ['price-card', ticker],
    queryFn: async () => {
      const start = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
      const res = await axios.get(`/api/market/history?ticker=${ticker}&start=${start}`)
      return res.data
    },
    enabled: !!ticker,
    staleTime: 600_000,
  })

  const base: React.CSSProperties = {
    background: T.bg, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden',
  }

  if (!ticker || isError) {
    return (
      <div style={{ ...base, padding: '12px 14px', gap: 6 }}>
        <span style={{ color: T.gold, fontWeight: 700, fontSize: 13 }}>{config.ticker || 'No ticker set'}</span>
        <span style={{ color: T.muted, fontSize: 11, fontFamily: T.label }}>Configure ticker in edit mode.</span>
      </div>
    )
  }

  if (isLoading || !data) {
    return (
      <div style={{ ...base, padding: '10px 12px', gap: 8 }}>
        <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
        <div style={{ ...shimmer, width: '60%', height: 16 }} />
        <div style={{ ...shimmer, width: '40%', height: 11 }} />
        <div style={{ ...shimmer, flex: 1, minHeight: 80 }} />
      </div>
    )
  }

  const { current_price, ann_volatility, max_drawdown } = data.metrics
  const prices = data.price
  const livePrice = liveMarks[ticker.toUpperCase()] ?? current_price
  const dayChange = prices.length >= 2
    ? ((livePrice - prices[prices.length - 2].value) / prices[prices.length - 2].value) * 100
    : 0
  const dayColor = dayChange >= 0 ? T.pos : T.neg
  const daySign  = dayChange >= 0 ? '+' : ''

  return (
    <div style={base}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Single-row header: all stats on one line, no wrapping */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 0,
        padding: '0 10px', height: 34,
        background: T.headerBg, borderBottom: `1px solid ${T.border}`,
        flexShrink: 0, overflow: 'hidden',
      }}>
        <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold, letterSpacing: '0.06em', marginRight: 8, flexShrink: 0 }}>
          {ticker}
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.text, marginRight: 6, flexShrink: 0 }}>
          ${livePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 11, color: dayColor, flexShrink: 0 }}>
          {daySign}{dayChange.toFixed(2)}%
        </span>
        {/* Divider */}
        <div style={{ width: 1, height: 12, background: T.border, margin: '0 10px', flexShrink: 0 }} />
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>
          VOL
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.text, whiteSpace: 'nowrap', flexShrink: 0, marginLeft: 3 }}>
          {ann_volatility.toFixed(1)}%
        </span>
        <div style={{ width: 1, height: 12, background: T.border, margin: '0 8px', flexShrink: 0 }} />
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, whiteSpace: 'nowrap', flexShrink: 0 }}>
          DD
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 10, color: max_drawdown < -15 ? T.neg : T.muted, whiteSpace: 'nowrap', flexShrink: 0, marginLeft: 3 }}>
          {max_drawdown.toFixed(1)}%
        </span>
      </div>

      <CandleChart ticker={ticker} />
    </div>
  )
}
