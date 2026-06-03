import { useEffect, useRef } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'

function toTVSymbol(ticker: string): string {
  if (ticker.includes(':')) return ticker
  if (ticker.endsWith('-USD')) return `CRYPTO:${ticker.replace('-USD', 'USD')}`
  return ticker
}

// Isolated component so React fully unmounts/remounts the iframe when key changes
function TVWidget({ symbol }: { symbol: string }) {
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
      gridColor: 'rgba(46,57,77,0.45)',
      hide_top_toolbar: true,
      hide_legend: false,
      allow_symbol_change: true,
      save_image: false,
      calendar: false,
      support_host: 'https://www.tradingview.com',
    })
    el.appendChild(script)
    return () => { if (el) el.innerHTML = '' }
  }, [])   // runs once on mount; symbol changes handled by key prop on parent

  return (
    <div ref={ref} className="tradingview-widget-container" style={{ flex: 1, minHeight: 0 }}>
      <div className="tradingview-widget-container__widget" style={{ height: '100%', width: '100%' }} />
    </div>
  )
}

export default function TradingViewChart({ config }: { config: WidgetConfig }) {
  const ticker   = config.ticker || 'SPY'
  const tvSymbol = toTVSymbol(ticker)

  return (
    <div style={{ height: '100%', minHeight: 400, display: 'flex', flexDirection: 'column', background: '#101c2e', overflow: 'hidden' }}>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '5px 10px', background: '#0d1826', borderBottom: '1px solid #2e394d', flexShrink: 0,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#c9a84c', flexShrink: 0 }} />
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, color: '#c9a84c', letterSpacing: '0.1em' }}>
          {ticker.toUpperCase()}
        </span>
        <span style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 9, color: '#2e4460', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          TradingView Advanced Chart
        </span>
      </div>

      {/* key forces full unmount+remount of the iframe when symbol changes */}
      <TVWidget key={tvSymbol} symbol={tvSymbol} />
    </div>
  )
}
