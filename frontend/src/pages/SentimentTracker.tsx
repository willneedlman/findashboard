import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import useIsMobile from '../hooks/useIsMobile'

const T = {
  bg:      'var(--theme-bg, #060e1c)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'rgba(255,255,255,0.06)',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    '#d7e3fc',
  mono:    'JetBrains Mono, monospace',
}

interface ScoredItem {
  text:      string
  sentiment: 'bullish' | 'bearish' | 'neutral'
  score:     number
  url?:      string
  upvotes?:  number
}

interface Source {
  label:     string
  type:      'reddit' | 'news'
  weight:    number
  avg_score: number
  count:     number
  items:     ScoredItem[]
}

interface Snapshot {
  composite_score: number
  label:           string
  sources:         Source[]
  fetched_at:      number
}

function sentimentColor(score: number): string {
  if (score >= 65) return '#22c55e'
  if (score >= 55) return '#86efac'
  if (score >= 45) return T.muted
  if (score >= 35) return '#fca5a5'
  return '#ef4444'
}

function sentimentBg(score: number): string {
  if (score >= 65) return 'rgba(34,197,94,0.12)'
  if (score >= 55) return 'rgba(34,197,94,0.06)'
  if (score >= 45) return 'rgba(255,255,255,0.03)'
  if (score >= 35) return 'rgba(239,68,68,0.06)'
  return 'rgba(239,68,68,0.12)'
}

// Gauge arc — SVG semicircle
function Gauge({ score }: { score: number }) {
  const R = 80
  const cx = 100, cy = 100
  const startAngle = 180
  const endAngle   = 0
  const range      = startAngle - endAngle  // 180 deg
  const pct        = Math.max(0, Math.min(100, score)) / 100
  const angle      = startAngle - pct * range

  const toXY = (deg: number) => {
    const rad = (deg * Math.PI) / 180
    return { x: cx + R * Math.cos(rad), y: cy - R * Math.sin(rad) }
  }

  const start = toXY(startAngle)
  const end   = toXY(endAngle)
  const fill  = toXY(angle)
  const large = pct > 0.5 ? 0 : 1

  const color = sentimentColor(score)

  const trackPath  = `M ${start.x} ${start.y} A ${R} ${R} 0 0 1 ${end.x} ${end.y}`
  const fillPath   = `M ${start.x} ${start.y} A ${R} ${R} 0 ${large} 1 ${fill.x} ${fill.y}`

  return (
    <svg viewBox="20 20 160 110" style={{ width: '100%', maxWidth: 240 }}>
      {/* Track */}
      <path d={trackPath} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={14} strokeLinecap="round" />
      {/* Fill */}
      {score > 0 && (
        <path d={fillPath} fill="none" stroke={color} strokeWidth={14} strokeLinecap="round" />
      )}
      {/* Needle dot */}
      <circle cx={fill.x} cy={fill.y} r={5} fill={color} />
      {/* Score */}
      <text x={cx} y={cy + 8} textAnchor="middle" fill={color}
        fontFamily="JetBrains Mono, monospace" fontSize={28} fontWeight={700}>
        {score.toFixed(0)}
      </text>
      {/* Labels */}
      <text x={22} y={108} textAnchor="start" fill="rgba(255,255,255,0.25)" fontFamily="JetBrains Mono, monospace" fontSize={8}>FEAR</text>
      <text x={178} y={108} textAnchor="end"   fill="rgba(255,255,255,0.25)" fontFamily="JetBrains Mono, monospace" fontSize={8}>GREED</text>
    </svg>
  )
}

function ScoreBar({ score, label }: { score: number; label: string }) {
  const pct = Math.max(0, Math.min(100, score))
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 10, fontFamily: T.mono }}>
        <span style={{ color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 8 }}>{label}</span>
        <span style={{ color: sentimentColor(score), flexShrink: 0 }}>{score.toFixed(0)}</span>
      </div>
      <div style={{ height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: sentimentColor(score), borderRadius: 2, transition: 'width 0.6s ease' }} />
      </div>
    </div>
  )
}

function SourcePanel({ src }: { src: Source }) {
  const [expanded, setExpanded] = useState(false)
  const icon = src.type === 'reddit' ? '⬆' : '📰'

  return (
    <div style={{ border: `1px solid ${T.border}`, background: T.surface, marginBottom: 8 }}>
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', background: 'transparent', border: 'none',
          cursor: 'pointer', textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>{icon}</span>
        <span style={{ flex: 1, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.text, fontFamily: T.mono }}>{src.label}</span>
        <span style={{ fontSize: 10, fontFamily: T.mono, color: sentimentColor(src.avg_score), marginRight: 8 }}>{src.avg_score.toFixed(0)}/100</span>
        <span style={{ fontSize: 10, color: T.muted }}>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div style={{ padding: '0 12px 12px', borderTop: `1px solid ${T.border}` }}>
          {src.items.map((item, i) => (
            <div key={i} style={{
              padding: '6px 8px', marginTop: 6,
              background: sentimentBg(item.score),
              border: `1px solid rgba(255,255,255,0.04)`,
            }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span style={{
                  fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
                  color: sentimentColor(item.score), flexShrink: 0, marginTop: 2,
                }}>
                  {item.sentiment}
                </span>
                <span style={{ fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: '15px', flex: 1 }}>
                  {item.url
                    ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>{item.text}</a>
                    : item.text
                  }
                </span>
                {item.upvotes !== undefined && (
                  <span style={{ fontSize: 9, color: T.muted, flexShrink: 0 }}>↑{item.upvotes >= 1000 ? `${(item.upvotes / 1000).toFixed(1)}k` : item.upvotes}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SentimentTracker() {
  const isMobile = useIsMobile()

  const { data, isLoading, error, refetch, isFetching } = useQuery<Snapshot>({
    queryKey: ['sentiment-snapshot'],
    queryFn:  () => axios.get('/api/sentiment/snapshot').then(r => r.data),
    staleTime: 14 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  })

  const lastUpdated = data?.fetched_at
    ? new Date(data.fetched_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  const redditSources = data?.sources.filter(s => s.type === 'reddit') ?? []
  const newsSources   = data?.sources.filter(s => s.type === 'news')   ?? []

  const sidebar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Gauge */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 16, textAlign: 'center' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8 }}>
          Market Sentiment
        </div>
        {data ? (
          <>
            <Gauge score={data.composite_score} />
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', color: sentimentColor(data.composite_score), marginTop: 4, fontFamily: T.mono }}>
              {data.label}
            </div>
          </>
        ) : isLoading ? (
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontSize: 11 }}>Loading…</div>
        ) : null}
        {lastUpdated && (
          <div style={{ fontSize: 9, color: T.muted, marginTop: 8, fontFamily: T.mono }}>Updated {lastUpdated}</div>
        )}
      </div>

      {/* Source score bars */}
      {data && data.sources.length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 12 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 10 }}>
            By Source
          </div>
          {data.sources.map(s => (
            <ScoreBar key={s.label} score={s.avg_score} label={s.label} />
          ))}
        </div>
      )}

      {/* Refresh */}
      <button
        onClick={() => refetch()}
        disabled={isFetching}
        style={{
          padding: '7px 12px', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
          background: 'transparent', border: `1px solid ${T.gold}`, color: T.gold, cursor: isFetching ? 'wait' : 'pointer',
          fontFamily: T.mono, opacity: isFetching ? 0.5 : 1,
        }}
      >
        {isFetching ? 'Refreshing…' : '↺ Refresh'}
      </button>
    </div>
  )

  const content = (
    <div>
      {error && (
        <div style={{ padding: 12, background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', color: '#fca5a5', fontSize: 11, fontFamily: T.mono, marginBottom: 12 }}>
          Failed to load sentiment data. Backend may be starting up.
        </div>
      )}

      {isLoading && !data && (
        <div style={{ textAlign: 'center', padding: 48, color: T.muted, fontSize: 12, fontFamily: T.mono }}>
          Fetching Reddit posts + news headlines and scoring with AI…<br />
          <span style={{ fontSize: 10, opacity: 0.6 }}>First load takes ~10–15 seconds</span>
        </div>
      )}

      {data && (
        <>
          {/* Reddit */}
          {redditSources.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8 }}>
                Reddit ({redditSources.reduce((a, s) => a + s.count, 0)} posts)
              </div>
              {redditSources.map(src => <SourcePanel key={src.label} src={src} />)}
            </div>
          )}

          {/* News */}
          {newsSources.length > 0 && (
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8 }}>
                News Headlines ({newsSources.reduce((a, s) => a + s.count, 0)} articles)
              </div>
              {newsSources.map(src => <SourcePanel key={src.label} src={src} />)}
            </div>
          )}
        </>
      )}
    </div>
  )

  return (
    <PageWrapper>
      <SidebarLayout sidebar={sidebar} sidebarWidth={260}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.text, fontFamily: T.mono }}>
              Market Sentiment Tracker
            </div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
              Reddit · Financial News · AI Scored — works 24/7
            </div>
          </div>
        </div>
        {content}
      </SidebarLayout>
    </PageWrapper>
  )
}
