import { useState } from 'react'
import axios from 'axios'
import { useQueries } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))', headerBg: 'var(--theme-surface, #142032)', sectionBg: 'var(--theme-surface, #0d1826)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #5e768f)', dim: '#3a4d62',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
  pos: '#22C55E', neg: '#EF4444',
}

interface NewsItem {
  title: string
  link: string
  publisher: string
  pubDate?: string
}

interface HubData {
  news: NewsItem[]
  ticker: string
  pct_change_1d: number
}

function safeUrl(url: string): string {
  return url.startsWith('http://') || url.startsWith('https://') ? url : '#'
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, var(--theme-border-faint, var(--theme-border-faint, rgba(255,255,255,0.05))) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 2s infinite',
  borderRadius: 3,
}

function TickerSection({
  ticker,
  isLoading,
  data,
  open,
  onToggle,
  isLast,
}: {
  ticker: string
  isLoading: boolean
  data?: HubData
  open: boolean
  onToggle: () => void
  isLast: boolean
}) {
  const pct      = data?.pct_change_1d ?? 0
  const pctColor = pct >= 0 ? T.pos : T.neg
  const pctSign  = pct >= 0 ? '+' : ''
  const items    = data?.news ?? []

  return (
    <div style={{ borderBottom: isLast ? 'none' : `1px solid ${T.border}` }}>
      {/* Section header — click to toggle */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 12px',
          background: open ? T.headerBg : T.sectionBg,
          cursor: 'pointer',
          borderBottom: open ? `1px solid ${T.border}` : 'none',
          userSelect: 'none',
          transition: 'background 0.12s',
        }}
      >
        {open
          ? <ChevronDown  size={12} style={{ color: T.gold, flexShrink: 0 }} />
          : <ChevronRight size={12} style={{ color: T.dim,  flexShrink: 0 }} />
        }
        <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, color: T.gold, letterSpacing: '0.12em', textTransform: 'uppercase', flexShrink: 0 }}>
          {ticker}
        </span>
        {isLoading && (
          <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
            loading…
          </span>
        )}
        {!isLoading && data && (
          <>
            <span style={{ fontFamily: T.mono, fontSize: 9, color: pctColor, flexShrink: 0 }}>
              {pctSign}{pct.toFixed(2)}%
            </span>
            <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, marginLeft: 'auto', flexShrink: 0 }}>
              {items.length} stories
            </span>
          </>
        )}
      </div>

      {/* News items — only rendered when open */}
      {open && (
        <div>
          {isLoading
            ? Array.from({ length: 3 }).map((_, i) => (
                <div key={i} style={{ padding: '10px 14px', borderBottom: `1px solid ${T.border}`, display: 'flex', flexDirection: 'column', gap: 5 }}>
                  <div style={{ ...shimmer, height: 13, width: '85%' }} />
                  <div style={{ ...shimmer, height: 10, width: '40%' }} />
                </div>
              ))
            : items.length === 0
              ? (
                <div style={{ padding: '12px 14px' }}>
                  <span style={{ fontFamily: T.label, fontSize: 11, color: T.muted }}>No stories found.</span>
                </div>
              )
              : items.map((item, i) => (
                  <div
                    key={i}
                    style={{
                      padding: '9px 14px 8px 28px',
                      borderBottom: i < items.length - 1 ? `1px solid rgba(46,57,77,0.5)` : 'none',
                      background: i % 2 === 0 ? 'transparent' : 'rgba(13,24,38,0.4)',
                    }}
                  >
                    <a
                      href={safeUrl(item.link)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: T.text, textDecoration: 'none', fontSize: 12,
                        lineHeight: 1.45, display: 'block',
                        transition: 'color 0.1s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.color = T.gold)}
                      onMouseLeave={e => (e.currentTarget.style.color = T.text)}
                    >
                      {item.title}
                    </a>
                    <div style={{ marginTop: 4, display: 'flex', gap: 10 }}>
                      <span style={{ color: T.muted, fontSize: 9, fontFamily: T.label, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                        {item.publisher}
                      </span>
                      {item.pubDate && (
                        <span style={{ color: T.dim, fontSize: 9, fontFamily: T.label }}>{item.pubDate}</span>
                      )}
                    </div>
                  </div>
                ))
          }
        </div>
      )}
    </div>
  )
}

export default function NewsFeed({ config }: { config: WidgetConfig }) {
  // Support both single ticker (legacy) and multi-ticker
  const tickers: string[] = config.tickers && config.tickers.length > 0
    ? config.tickers
    : config.ticker
      ? [config.ticker]
      : []

  const expandMode = config.newsExpand ?? 'first'
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() => {
    if (expandMode === 'all') return Object.fromEntries(tickers.map(t => [t, true]))
    if (expandMode === 'none') return Object.fromEntries(tickers.map(t => [t, false]))
    return Object.fromEntries(tickers.map((t, i) => [t, i === 0]))
  })

  const toggle = (t: string) => setOpenMap(p => ({ ...p, [t]: !p[t] }))

  const results = useQueries({
    queries: tickers.map(t => ({
      queryKey: ['news', t],
      queryFn: () => axios.get(`/api/corporate/hub?ticker=${t}`).then(r => r.data as HubData),
      enabled: true,
      staleTime: 900_000,
    })),
  })

  const containerStyle: React.CSSProperties = {
    background: T.bg, height: '100%', width: '100%',
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    fontFamily: T.mono,
  }

  if (tickers.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: T.muted, fontSize: 11, fontFamily: T.label }}>Configure tickers in edit mode.</span>
        </div>
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {tickers.map((ticker, i) => (
          <TickerSection
            key={ticker}
            ticker={ticker}
            isLoading={results[i].isLoading}
            data={results[i].data}
            open={!!openMap[ticker]}
            onToggle={() => toggle(ticker)}
            isLast={i === tickers.length - 1}
          />
        ))}
      </div>
    </div>
  )
}
