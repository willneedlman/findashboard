import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { createChart, ColorType, CrosshairMode } from 'lightweight-charts'
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import { readToken } from '../lib/theme'
import { formatLocalDateTime, localTimeZone } from '../lib/time'
import EmptyState from './EmptyState'

// Click-to-chart popup for the Global Markets board. Reuses /api/market/history,
// which already resolves the Yahoo symbol forms used here (^GSPC, CL=F, BTC-USD…)
// and returns intraday points (UNIX-second `date`) for short spans, daily
// ("YYYY-MM-DD" `date`) for long ones — both valid lightweight-charts times.

const MONO = 'var(--theme-mono)'
const GOLD = 'var(--theme-primary, #c9a84c)'

// Short windows use exact intraday lookbacks. Longer windows retain the existing
// date-based history route, which resolves to intraday or daily bars as needed.
const TFS: { k: string; days?: number; window?: '10m' | '30m' | '1h' }[] = [
  { k: '10M', window: '10m' }, { k: '30M', window: '30m' }, { k: '1H', window: '1h' },
  { k: '1D', days: 1 }, { k: '1W', days: 7 }, { k: '1M', days: 31 },
  { k: '3M', days: 93 }, { k: '1Y', days: 366 }, { k: '5Y', days: 1826 },
] as const

interface Row { label: string; symbol: string; quote_symbol?: string; price: number | null; change_pct: number | null }
interface HistPoint { date: string | number; value: number }
interface Hist { price: HistPoint[]; metrics: { total_return: number; current_price: number }; meta?: { intraday?: boolean; as_of?: string | null; window?: string | null } }

const iso = (d: Date) => d.toISOString().split('T')[0]
const formatChartTime = (time: Time) => {
  const date = typeof time === 'number'
    ? new Date(time * 1000)
    : typeof time === 'string'
      ? new Date(`${time}T00:00:00`)
      : new Date(time.year, time.month - 1, time.day)
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

const formatChartAxisTime = (time: Time) => {
  if (typeof time !== 'number') {
    const date = typeof time === 'string' ? new Date(`${time}T00:00:00`) : new Date(time.year, time.month - 1, time.day)
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  return new Date(time * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}

export default function AssetChartModal({ row, yields, onClose }: { row: Row; yields?: boolean; onClose: () => void }) {
  const [tf, setTf] = useState<string>('1D')
  const [data, setData] = useState<Hist | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null)

  // Fetch the selected window.
  useEffect(() => {
    let cancel = false
    setLoading(true); setErr(false)
    const selected = TFS.find(t => t.k === tf)!
    const ticker = row.quote_symbol ?? row.symbol
    const params = selected.window
      ? { ticker, window: selected.window }
      : (() => {
          const end = new Date()
          const start = new Date(end.getTime() - selected.days! * 86400000)
          return { ticker, start: iso(start), end: iso(end) }
        })()
    axios.get<Hist>('/api/market/history', { params })
      .then(r => { if (!cancel) { setData(r.data); setLoading(false) } })
      .catch(() => { if (!cancel) { setErr(true); setLoading(false); setData(null) } })
    return () => { cancel = true }
  }, [tf, row.symbol, row.quote_symbol, refreshKey])

  useEffect(() => {
    if (!['10M', '30M', '1H', '1D'].includes(tf)) return
    const id = window.setInterval(() => setRefreshKey(v => v + 1), 60_000)
    return () => window.clearInterval(id)
  }, [tf])

  // Build the chart once.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const chart = createChart(el, {
      layout: { background: { type: ColorType.Solid, color: readToken('--theme-bg', '#101c2e'), }, textColor: readToken('--theme-secondary', '#8099b0'), fontFamily: 'ui-monospace, monospace', fontSize: 10, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.03)' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
      localization: { timeFormatter: (time: Time) => formatChartTime(time) },
      timeScale: { borderColor: 'rgba(255,255,255,0.06)', timeVisible: true, fixLeftEdge: true, rightOffset: 3, tickMarkFormatter: (time: Time) => formatChartAxisTime(time) },
      width: el.clientWidth, height: el.clientHeight,
    })
    const pos = readToken('--theme-positive', '#3fb6a0')
    const series = chart.addAreaSeries({ lineColor: pos, topColor: `${pos}3d`, bottomColor: 'rgba(0,0,0,0)', lineWidth: 2, priceLineVisible: false })
    chartRef.current = chart
    seriesRef.current = series
    const ro = new ResizeObserver(() => chart.resize(el.clientWidth, el.clientHeight))
    ro.observe(el)
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; seriesRef.current = null }
  }, [])

  // Feed data + tint the line by the window's direction.
  useEffect(() => {
    const s = seriesRef.current, chart = chartRef.current
    if (!s || !chart || !data?.price?.length) return
    const up = (data.metrics?.total_return ?? 0) >= 0
    const col = up ? readToken('--theme-positive', '#3fb6a0') : readToken('--theme-negative', '#cf4b3f')
    s.applyOptions({ lineColor: col, topColor: `${col}3d` })
    s.setData(data.price.map(p => ({ time: p.date as Time, value: p.value })))
    chart.timeScale().fitContent()
  }, [data])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ret = data?.metrics?.total_return
  const cur = data?.metrics?.current_price
  const up = (ret ?? 0) >= 0
  const retColor = ret == null ? 'var(--theme-secondary, #5f7893)' : up ? 'var(--theme-positive, #3fb6a0)' : 'var(--theme-negative, #cf4b3f)'
  const sourceStatus = data?.meta?.intraday ? 'MARKET DATA' : data ? 'SESSION DATA' : 'LOADING'

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label={`${row.label} chart`}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ width: 'min(940px, 94vw)', height: 'min(560px, 84vh)', display: 'flex', flexDirection: 'column', background: 'var(--theme-surface, #0d1826)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 34%, transparent)', borderRadius: 8, boxShadow: '0 24px 70px rgba(0,0,0,0.55)', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '13px 16px', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 22%, transparent)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
            <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 15, fontWeight: 700, color: 'var(--theme-text, #eaf1fb)', whiteSpace: 'nowrap' }}>{row.label}</span>
            {cur != null && (
              <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 700, color: 'var(--theme-text, #e6edf7)', fontVariantNumeric: 'tabular-nums' }}>
                {cur.toLocaleString(undefined, { maximumFractionDigits: cur < 10 ? 4 : 2 })}{yields ? '%' : ''}
              </span>
            )}
            {ret != null && (
              <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: retColor }}>
                {up ? '+' : ''}{ret.toFixed(2)}% <span style={{ color: 'var(--theme-secondary, #5f7893)', fontWeight: 400 }}>{tf}</span>
              </span>
            )}
            <span style={{ fontFamily: MONO, fontSize: 8.5, letterSpacing: '0.08em', color: 'var(--theme-secondary, #5f7893)' }}>{sourceStatus} · {localTimeZone()}</span>
          </div>
          <div style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
            {TFS.map(t => (
              <button key={t.k} onClick={() => setTf(t.k)}
                style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', padding: '4px 9px', cursor: 'pointer',
                  border: tf === t.k ? `1px solid ${GOLD}` : '1px solid var(--theme-border, rgba(255,255,255,0.14))',
                  background: tf === t.k ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                  color: tf === t.k ? GOLD : 'var(--theme-secondary, #8099b0)' }}>{t.k}</button>
            ))}
          </div>
          <button onClick={onClose} aria-label="Close chart"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: 16, lineHeight: 1, color: 'var(--theme-secondary, #8099b0)', padding: '0 2px' }}>×</button>
        </div>

        {/* Chart */}
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <div ref={wrapRef} style={{ width: '100%', height: '100%' }} />
          {(loading || err) && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: MONO, fontSize: 11, color: 'var(--theme-secondary, #8099b0)', pointerEvents: 'none' }}>
              {err ? 'No chart data' : <EmptyState variant="loading" size="compact" title="Loading candles" />}
            </div>
          )}
          {!loading && !err && data?.meta?.as_of && <div style={{ position: 'absolute', left: 12, bottom: 8, fontFamily: MONO, fontSize: 8.5, color: 'var(--theme-secondary, #5f7893)', pointerEvents: 'none' }}>As of {formatLocalDateTime(data.meta.as_of)} local</div>}
        </div>
      </div>
    </div>
  )
}
