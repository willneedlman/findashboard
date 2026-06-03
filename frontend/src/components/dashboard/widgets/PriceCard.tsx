import { useEffect, useRef } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: '#101c2e', border: '#2e394d', headerBg: '#0d1826',
  gold: '#c9a84c', text: '#d7e3fc', muted: '#5e768f',
  mono: 'JetBrains Mono, monospace', label: 'IBM Plex Sans, sans-serif',
  pos: '#22C55E', neg: '#EF4444',
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
  background: 'linear-gradient(90deg, #101c2e 25%, #1a2d45 50%, #101c2e 75%)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 2s infinite',
  borderRadius: 3,
}

function toTVSymbol(ticker: string): string {
  if (ticker.includes(':')) return ticker
  if (ticker.endsWith('-USD')) return `CRYPTO:${ticker.replace('-USD', 'USD')}`
  return ticker
}

function TVEmbed({ symbol }: { symbol: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const script = document.createElement('script')
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
    script.type = 'text/javascript'
    script.async = true
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol,
      interval: 'D',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      backgroundColor: '#0d1826',
      gridColor: 'rgba(46,57,77,0.4)',
      hide_top_toolbar: false,
      hide_legend: true,
      allow_symbol_change: false,
      save_image: false,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    })
    el.appendChild(script)
    return () => { if (el) el.innerHTML = '' }
  }, [])  // runs once on mount; key prop on caller forces remount on symbol change

  return (
    <div ref={ref} className="tradingview-widget-container" style={{ flex: 1, minHeight: 0 }}>
      <div className="tradingview-widget-container__widget" style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

export default function PriceCard({ config }: { config: WidgetConfig }) {
  const ticker = config.ticker

  const { data, isLoading, isError } = useQuery<PriceData>({
    queryKey: ['price-card', ticker],
    queryFn: async () => {
      const start = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
      const res = await axios.get(`/api/market/history?ticker=${ticker}&start=${start}`)
      return res.data
    },
    enabled: !!ticker,
    staleTime: 60_000,
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
  const dayChange = prices.length >= 2
    ? ((prices[prices.length - 1].value - prices[prices.length - 2].value) / prices[prices.length - 2].value) * 100
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
          ${current_price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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

      <TVEmbed key={toTVSymbol(ticker)} symbol={toTVSymbol(ticker)} />
    </div>
  )
}
