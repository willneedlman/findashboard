import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'

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

interface HistoryPoint {
  composite_score: number
  label:           string
  fetched_at:      number
}

type Timeframe = '1H' | '4H' | '8H' | '24H'

const TF_HOURS: Record<Timeframe, number> = { '1H': 1, '4H': 4, '8H': 8, '24H': 24 }

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

// ── Gauge ─────────────────────────────────────────────────────────────────────
// Arc: 180° semicircle, cx=100 cy=100 R=80, stroke=14 with round caps.
// Caps extend ~7px beyond endpoints (20,100) and (180,100), so viewBox
// starts at x=8 and ends at x=192 (8px margin each side). Top of arc at
// y=20; stroke top at y=13 so min-y=8. Labels at y=110 → height=110 from y=8.
function Gauge({ score }: { score: number }) {
  const R = 80, cx = 100, cy = 100
  const pct   = Math.max(0, Math.min(100, score)) / 100
  const angle = 180 - pct * 180          // 180° → 0°
  const rad   = (angle * Math.PI) / 180
  const fx    = cx + R * Math.cos(rad)
  const fy    = cy - R * Math.sin(rad)
  const large = pct > 0.5 ? 0 : 1
  const color = sentimentColor(score)

  const trackPath = `M 20 100 A ${R} ${R} 0 0 1 180 100`
  const fillPath  = `M 20 100 A ${R} ${R} 0 ${large} 1 ${fx} ${fy}`

  return (
    <svg viewBox="8 8 184 112" style={{ width: '100%', display: 'block' }}>
      {/* Track */}
      <path d={trackPath} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={14} strokeLinecap="round" />
      {/* Filled arc */}
      {score > 0 && (
        <path d={fillPath} fill="none" stroke={color} strokeWidth={14} strokeLinecap="round" />
      )}
      {/* Needle dot */}
      <circle cx={fx} cy={fy} r={6} fill={color} />
      {/* Score */}
      <text x={cx} y={cy + 6} textAnchor="middle" fill={color}
        fontFamily="JetBrains Mono, monospace" fontSize={30} fontWeight={700}>
        {score.toFixed(0)}
      </text>
      {/* FEAR / GREED labels */}
      <text x={18} y={116} textAnchor="start" fill="rgba(255,255,255,0.3)"
        fontFamily="JetBrains Mono, monospace" fontSize={8}>FEAR</text>
      <text x={182} y={116} textAnchor="end" fill="rgba(255,255,255,0.3)"
        fontFamily="JetBrains Mono, monospace" fontSize={8}>GREED</text>
    </svg>
  )
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function Sparkline({ points }: { points: HistoryPoint[] }) {
  if (points.length < 2) return null
  const W = 220, H = 48
  const scores = points.map(p => p.composite_score)
  const min = Math.min(...scores, 30)
  const max = Math.max(...scores, 70)
  const range = max - min || 1
  const xs = points.map((_, i) => (i / (points.length - 1)) * W)
  const ys = scores.map(s => H - ((s - min) / range) * H)
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x} ${ys[i]}`).join(' ')
  const latest = scores[scores.length - 1]
  const color  = sentimentColor(latest)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" opacity={0.7} />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={3} fill={color} />
    </svg>
  )
}

// ── Score bar ─────────────────────────────────────────────────────────────────
function ScoreBar({ score, label }: { score: number; label: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 10, fontFamily: T.mono }}>
        <span style={{ color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 8 }}>{label}</span>
        <span style={{ color: sentimentColor(score), flexShrink: 0 }}>{score.toFixed(0)}</span>
      </div>
      <div style={{ height: 3, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, score))}%`, background: sentimentColor(score), transition: 'width 0.6s ease' }} />
      </div>
    </div>
  )
}

// ── Source panel ──────────────────────────────────────────────────────────────
function SourcePanel({ src }: { src: Source }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div style={{ marginBottom: 8, border: `1px solid ${T.border}`, background: T.surface }}>
      <div
        onClick={() => setExpanded(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer' }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.text, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {src.label}
          </div>
          <div style={{ fontSize: 9, color: T.muted, marginTop: 2 }}>{src.count} headlines</div>
        </div>
        <div style={{ fontSize: 14, fontWeight: 700, color: sentimentColor(src.avg_score), fontFamily: T.mono, flexShrink: 0 }}>
          {src.avg_score.toFixed(0)}
        </div>
        <div style={{ color: T.muted, fontSize: 10 }}>{expanded ? '▲' : '▼'}</div>
      </div>
      {expanded && (
        <div style={{ padding: '0 12px 12px', borderTop: `1px solid ${T.border}` }}>
          {src.items.map((item, i) => (
            <div key={i} style={{ padding: '6px 8px', marginTop: 6, background: sentimentBg(item.score), border: `1px solid rgba(255,255,255,0.04)` }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: sentimentColor(item.score), flexShrink: 0, marginTop: 2 }}>
                  {item.sentiment}
                </span>
                <span style={{ fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: '15px', flex: 1 }}>
                  {item.url
                    ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>{item.text}</a>
                    : item.text}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function SentimentTracker() {
  const [timeframe, setTimeframe] = useState<Timeframe>('4H')

  const { data, isLoading, error, refetch, isFetching } = useQuery<Snapshot>({
    queryKey:       ['sentiment-snapshot'],
    queryFn:        () => axios.get('/api/sentiment/snapshot').then(r => r.data),
    staleTime:      14 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  })

  const { data: history } = useQuery<HistoryPoint[]>({
    queryKey:  ['sentiment-history'],
    queryFn:   () => axios.get('/api/sentiment/history').then(r => r.data),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  })

  const cutoff = Date.now() / 1000 - TF_HOURS[timeframe] * 3600
  const filteredHistory = (history ?? []).filter(p => p.fetched_at >= cutoff)

  const lastUpdated = data?.fetched_at
    ? new Date(data.fetched_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  const newsSources = data?.sources.filter(s => s.type === 'news') ?? []

  const tfBtn = (tf: Timeframe) => (
    <button key={tf} onClick={() => setTimeframe(tf)} style={{
      padding: '3px 8px', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
      fontFamily: T.mono, cursor: 'pointer', border: `1px solid ${tf === timeframe ? T.gold : T.border}`,
      background: tf === timeframe ? 'rgba(201,168,76,0.12)' : 'transparent',
      color: tf === timeframe ? T.gold : T.muted,
    }}>{tf}</button>
  )

  const sidebar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* Gauge */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '14px 14px 10px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 10, textAlign: 'center' }}>
          Market Sentiment
        </div>
        {data ? (
          <>
            <Gauge score={data.composite_score} />
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', color: sentimentColor(data.composite_score), marginTop: 6, fontFamily: T.mono, textAlign: 'center' }}>
              {data.label}
            </div>
          </>
        ) : isLoading ? (
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontSize: 11 }}>Loading…</div>
        ) : null}
        {lastUpdated && (
          <div style={{ fontSize: 9, color: T.muted, marginTop: 6, fontFamily: T.mono, textAlign: 'center' }}>Updated {lastUpdated}</div>
        )}
      </div>

      {/* Trend sparkline + timeframe selector */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
            Trend
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['1H','4H','8H','24H'] as Timeframe[]).map(tfBtn)}
          </div>
        </div>
        {filteredHistory.length >= 2
          ? <Sparkline points={filteredHistory} />
          : <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, textAlign: 'center', padding: '12px 0' }}>
              Accumulates as refreshes happen
            </div>
        }
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
          background: 'transparent', border: `1px solid ${T.gold}`, color: T.gold,
          cursor: isFetching ? 'wait' : 'pointer', fontFamily: T.mono, opacity: isFetching ? 0.5 : 1,
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
          Fetching financial news headlines and scoring with AI…<br />
          <span style={{ fontSize: 10, opacity: 0.6 }}>First load takes ~10–15 seconds</span>
        </div>
      )}

      {data && newsSources.length > 0 && (
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8 }}>
            News Headlines ({newsSources.reduce((a, s) => a + s.count, 0)} articles)
          </div>
          {newsSources.map(src => <SourcePanel key={src.label} src={src} />)}
        </div>
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
              Financial News · AI Scored — works 24/7
            </div>
          </div>
        </div>
        {content}
      </SidebarLayout>
    </PageWrapper>
  )
}
