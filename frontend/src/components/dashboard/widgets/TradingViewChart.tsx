import { useEffect, useRef, useState } from 'react'
import type { WidgetConfig } from '../../../hooks/useDashboard'

function toTVSymbol(ticker: string): string {
  if (ticker.includes(':')) return ticker
  if (ticker.endsWith('-USD')) return `CRYPTO:${ticker.replace('-USD', 'USD')}`
  return ticker
}

function TVWidget({ symbol }: { symbol: string }) {
  const ref     = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    // Resolve CSS variables to actual hex so TradingView can use them
    const style  = getComputedStyle(document.documentElement)
    const bgColor = style.getPropertyValue('--theme-bg').trim() || '#101c2e'

    const script = document.createElement('script')
    script.src   = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
    script.type  = 'text/javascript'
    script.async = true
    script.textContent = JSON.stringify({
      autosize:           true,
      symbol,
      interval:           'D',
      timezone:           'Etc/UTC',
      theme:              'dark',
      style:              '1',
      locale:             'en',
      backgroundColor:    bgColor,
      gridColor:          'rgba(46,57,77,0.35)',
      hide_top_toolbar:   true,
      hide_legend:        false,
      allow_symbol_change: true,
      save_image:         false,
      calendar:           false,
      support_host:       'https://www.tradingview.com',
    })
    el.appendChild(script)

    // If the TV iframe hasn't appeared after 8 seconds, remove and show fallback
    const timer = setTimeout(() => {
      if (el && !el.querySelector('iframe')) {
        setFailed(true)
        el.innerHTML = ''
      }
    }, 8000)

    return () => {
      clearTimeout(timer)
      if (el) el.innerHTML = ''
    }
  }, []) // symbol changes handled by key prop on parent

  if (failed) {
    return (
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 8,
        background: 'var(--theme-bg, #101c2e)',
        padding: 24,
      }}>
        <div style={{ fontSize: 28, opacity: 0.2 }}>⬜</div>
        <div style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 11, color: 'var(--theme-secondary, #5e768f)', textAlign: 'center', lineHeight: 1.6 }}>
          TradingView chart unavailable
        </div>
        <div style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 9, color: 'rgba(255,255,255,0.2)', textAlign: 'center' }}>
          Check network / ad-blocker · use Market Data tab for price history
        </div>
      </div>
    )
  }

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
    <div style={{ height: '100%', minHeight: 400, display: 'flex', flexDirection: 'column', background: 'var(--theme-bg, #101c2e)', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '5px 10px', background: 'var(--theme-surface, #0d1826)',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--theme-primary, #c9a84c)', flexShrink: 0 }} />
        <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', letterSpacing: '0.1em' }}>
          {ticker.toUpperCase()}
        </span>
        <span style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 9, color: 'rgba(255,255,255,0.20)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>
          TradingView Advanced Chart
        </span>
      </div>

      {/* key forces full unmount+remount when symbol changes */}
      <TVWidget key={tvSymbol} symbol={tvSymbol} />
    </div>
  )
}
