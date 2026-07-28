import { useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))',
  surface: 'var(--theme-surface, #142032)', gold: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #5e768f)',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
  pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)',
}

interface Entity { name: string; asset_class: string }
interface NewsItem {
  text: string
  url: string
  published_at: number
  sentiment: string
  direction: number
  seen_in_sources: number
  entities: Entity[]
  source: string
}
interface Source {
  label: string
  items: Omit<NewsItem, 'source'>[]
}
interface SentimentSnapshot { sources: Source[] }

function safeUrl(url: string): string {
  return url.startsWith('http://') || url.startsWith('https://') ? url : '#'
}

function matchesTicker(item: NewsItem, ticker: string): boolean {
  const target = ticker.toUpperCase()
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return item.entities.some(entity => entity.name.toUpperCase() === target)
    || new RegExp(`(^|[^A-Z])${escaped}([^A-Z]|$)`).test(item.text.toUpperCase())
}

export default function NewsFeed({ config }: { config: WidgetConfig }) {
  const tickers = config.tickers?.length ? config.tickers : config.ticker ? [config.ticker] : []
  const expandMode = config.newsExpand ?? 'first'
  const [openMap, setOpenMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(tickers.map((ticker, index) => [ticker, expandMode === 'all' || (expandMode === 'first' && index === 0)]))
  )
  const { data, isLoading, isError } = useQuery<SentimentSnapshot>({
    queryKey: ['sentiment-news-feed', 24],
    queryFn: () => axios.get('/api/sentiment/snapshot?timeframe_hours=24&sample_size=500').then(r => r.data),
    staleTime: 600_000,
    retry: 1,
  })
  const allItems: NewsItem[] = (data?.sources ?? []).flatMap(source =>
    source.items.map(item => ({ ...item, source: source.label }))
  ).sort((a, b) => b.published_at - a.published_at)

  if (!tickers.length) {
    return <div style={{ height: '100%', display: 'grid', placeItems: 'center', background: T.bg, color: T.muted, fontFamily: T.label, fontSize: 11 }}>Configure tickers in edit mode.</div>
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: T.bg }}>
      {isLoading && <div style={{ padding: 12, color: T.muted, fontFamily: T.mono, fontSize: 10 }}>Scoring headlines...</div>}
      {isError && <div style={{ padding: 12, color: T.neg, fontFamily: T.mono, fontSize: 10 }}>News unavailable</div>}
      {tickers.map(ticker => {
        const items = allItems.filter(item => matchesTicker(item, ticker)).slice(0, 20)
        const open = !!openMap[ticker]
        return (
          <div key={ticker} style={{ borderBottom: `1px solid ${T.border}` }}>
            <button onClick={() => setOpenMap(current => ({ ...current, [ticker]: !open }))} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
              border: 0, borderBottom: open ? `1px solid ${T.border}` : 0, background: open ? T.surface : T.bg,
              color: T.gold, cursor: 'pointer', fontFamily: T.mono,
            }}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em' }}>{ticker}</span>
              <span style={{ marginLeft: 'auto', color: T.muted, fontSize: 9 }}>{items.length} scored</span>
            </button>
            {open && (items.length ? items.map(item => {
              const bullish = item.direction > 0.1
              const bearish = item.direction < -0.1
              const tone = bullish ? T.pos : bearish ? T.neg : T.muted
              return (
                <div key={`${item.url}-${item.published_at}`} style={{ padding: '8px 12px 8px 28px', borderBottom: `1px solid ${T.border}` }}>
                  <a href={safeUrl(item.url)} target="_blank" rel="noopener noreferrer" style={{ display: 'block', color: T.text, textDecoration: 'none', fontFamily: T.label, fontSize: 11, lineHeight: 1.4 }}>
                    {item.text}
                  </a>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontFamily: T.mono, fontSize: 8 }}>
                    <span style={{ color: T.muted }}>{item.source}</span>
                    <span style={{ color: tone, border: `1px solid ${tone}`, padding: '0 4px' }}>{bullish ? 'BULL' : bearish ? 'BEAR' : 'NEUTRAL'}</span>
                    <span style={{ color: T.muted }}>seen in {item.seen_in_sources || 1} sources</span>
                    <span style={{ marginLeft: 'auto', color: T.muted }}>{new Date(item.published_at * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                  </div>
                </div>
              )
            }) : <div style={{ padding: '10px 28px', color: T.muted, fontFamily: T.label, fontSize: 10 }}>No scored headlines in this window.</div>)}
          </div>
        )
      })}
    </div>
  )
}
