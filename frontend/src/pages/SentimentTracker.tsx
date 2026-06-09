import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'

const T = {
  bg:      'var(--theme-bg, #060e1c)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.06))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     '#22c55e',
  neg:     '#ef4444',
}

// ── Types ──────────────────────────────────────────────────────────────────────
interface Entity { name: string; asset_class: string }

interface ScoredItem {
  text:          string
  published_at:  number
  url:           string
  sentiment:     'bullish' | 'bearish' | 'neutral'
  score:         number
  direction:     number
  macro_tier:    number
  confidence:    number
  reasoning_tag: string
  entities:      Entity[]
}

interface Source {
  label:        string
  type:         string
  weight:       number
  avg_score:    number
  avg_direction:number
  avg_conf:     number
  avg_tier:     number
  count:        number
  qualifies:    boolean
  asset_groups: Record<string, string[]>
  items:        ScoredItem[]
}

interface Velocity {
  delta:       number
  velocity_hr: number
  elapsed_min: number
  points_used: number
}

interface Snapshot {
  composite_score: number
  label:           string
  direction:       number
  session_conf:    number
  total_headlines: number
  sources:         Source[]
  fetched_at:      number
  velocity?:       Velocity
  baseline_score?: number
  baseline_std?:   number
  baseline_n?:     number
  baseline_delta?: number
  total_collected?: number
  total_scored?:   number
  sources_used?:   number
}

interface HistoryPoint {
  composite_score: number
  label:           string
  direction:       number
  session_conf:    number
  fetched_at:      number
}

interface HistoryResp {
  points:   HistoryPoint[]
  velocity: Velocity | null
}

// ── Market sessions ────────────────────────────────────────────────────────────
type SessionId = 'PRE' | 'RTH' | 'AHT' | 'OVERNIGHT' | 'WEEKEND'

interface Session {
  id:          SessionId
  label:       string
  short:       string
  description: string
  color:       string
}

const SESSIONS: Session[] = [
  { id: 'PRE',       label: 'Pre-Market',       short: 'PRE',   description: '4:00–9:30 AM ET',  color: '#7aa2f7' },
  { id: 'RTH',       label: 'Regular Hours',    short: 'RTH',   description: '9:30 AM–4:00 PM ET', color: T.pos },
  { id: 'AHT',       label: 'After-Hours',      short: 'AHT',   description: '4:00–8:00 PM ET',  color: '#f7c94b' },
  { id: 'OVERNIGHT', label: 'Overnight',         short: 'NITE',  description: '8:00 PM–4:00 AM ET', color: T.muted },
  { id: 'WEEKEND',   label: 'Weekend',           short: 'WKND',  description: 'Fri 8PM–Mon 4AM ET', color: '#bd93f9' },
]

// NYSE holidays (YYYY-MM-DD in ET)
const NYSE_HOLIDAYS = new Set([
  "2024-01-01","2024-01-15","2024-02-19","2024-03-29","2024-05-27",
  "2024-06-19","2024-07-04","2024-09-02","2024-11-28","2024-12-25",
  "2025-01-01","2025-01-20","2025-02-17","2025-04-18","2025-05-26",
  "2025-06-19","2025-07-04","2025-09-01","2025-11-27","2025-12-25",
  "2026-01-01","2026-01-19","2026-02-16","2026-04-03","2026-05-25",
  "2026-06-19","2026-07-03","2026-09-07","2026-11-26","2026-12-25",
])

function toET(epochSec: number): Date {
  return new Date(epochSec * 1000)
}

function etDateString(d: Date): string {
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .split('/').reverse().join('-').replace(/(\d{4})-(\d{2})-(\d{2})/, '$1-$2-$3')
    .replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => `${y}-${m}-${d}`)
}

function etHourMin(d: Date): { h: number; m: number; dow: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
    hour12: false, weekday: 'narrow',
  }).formatToParts(d)
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0')
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0')
  const wday = parts.find(p => p.type === 'weekday')?.value ?? 'M'
  const DOW: Record<string, number> = { S: 0, M: 1, T: 2, W: 3, Th: 4, F: 5, Sa: 6 }
  // weekday narrow: Su Mo Tu We Th Fr Sa
  const dowMap: Record<string, number> = { Su:0,Mo:1,Tu:2,We:3,Th:4,Fr:5,Sa:6 }
  // Use toLocaleString for DOW
  const dowStr = d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short' })
  const dowShort: Record<string, number> = { Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6 }
  return { h, m, dow: dowShort[dowStr] ?? 1 }
}

function getSessionForEpoch(epochSec: number): SessionId {
  const d = toET(epochSec)
  const { h, m, dow } = etHourMin(d)
  const hm = h + m / 60

  // Weekend: Sat all day, Sun before 4AM, Fri after 8PM
  if (dow === 6) return 'WEEKEND'
  if (dow === 0 && hm < 4) return 'WEEKEND'
  if (dow === 5 && hm >= 20) return 'WEEKEND'

  // Weekday
  if (hm >= 4 && hm < 9.5)  return 'PRE'
  if (hm >= 9.5 && hm < 16) return 'RTH'
  if (hm >= 16 && hm < 20)  return 'AHT'
  return 'OVERNIGHT'
}

function currentSession(): SessionId {
  return getSessionForEpoch(Date.now() / 1000)
}

function isHoliday(): boolean {
  const d = new Date()
  const str = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  return NYSE_HOLIDAYS.has(str)
}

function sessionDisabled(id: SessionId): boolean {
  if (id === 'WEEKEND') return false
  if (id === 'OVERNIGHT') return false
  if (isHoliday() && (id === 'RTH' || id === 'PRE' || id === 'AHT')) return true
  return false
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function sentimentColor(score: number): string {
  if (score >= 65) return T.pos
  if (score >= 55) return '#86efac'
  if (score >= 45) return T.muted
  if (score >= 35) return '#fca5a5'
  return T.neg
}
function sentimentBg(score: number): string {
  if (score >= 65) return 'rgba(34,197,94,0.1)'
  if (score >= 55) return 'rgba(34,197,94,0.05)'
  if (score >= 45) return 'var(--theme-hover, rgba(255,255,255,0.02))'
  if (score >= 35) return 'rgba(239,68,68,0.05)'
  return 'rgba(239,68,68,0.1)'
}
function tierColor(t: number): string {
  return ['#5e768f','#60a5fa','#f7c94b','#fb923c','#ef4444'][Math.max(0,t-1)]
}
function confOpacity(c: number): number {
  return 0.4 + c * 0.6
}

const ASSET_CLASS_COLORS: Record<string, string> = {
  Equities:      '#60a5fa',
  'Fixed Income':'#f7c94b',
  FX:            '#22c55e',
  Commodities:   '#fb923c',
  Crypto:        '#bd93f9',
  Macro:         '#f472b6',
}

// ── Gauge ──────────────────────────────────────────────────────────────────────
function Gauge({ score, conf }: { score: number; conf: number }) {
  const R = 80, cx = 100, cy = 100
  const pct   = Math.max(0, Math.min(100, score)) / 100
  const angle = 180 - pct * 180
  const rad   = (angle * Math.PI) / 180
  const fx    = cx + R * Math.cos(rad)
  const fy    = cy - R * Math.sin(rad)
  const large = pct > 0.999 ? 1 : 0
  const color = sentimentColor(score)
  const trackOpacity = 0.3 + conf * 0.7

  return (
    <svg viewBox="8 8 184 112" style={{ width: '100%', display: 'block', opacity: trackOpacity }}>
      <path d={`M 20 100 A ${R} ${R} 0 0 1 180 100`}
        fill="none" stroke="var(--theme-border, rgba(255,255,255,0.08))" strokeWidth={14} strokeLinecap="round" />
      {score > 0 && (
        <path d={`M 20 100 A ${R} ${R} 0 ${large} 1 ${fx} ${fy}`}
          fill="none" stroke={color} strokeWidth={14} strokeLinecap="round" />
      )}
      <circle cx={fx} cy={fy} r={6} fill={color} />
      <text x={cx} y={cy + 6} textAnchor="middle" fill={color}
        fontFamily="var(--theme-mono)" fontSize={30} fontWeight={700}>
        {score.toFixed(0)}
      </text>
      <text x={18} y={116} textAnchor="start" fill="var(--theme-text-dim, rgba(255,255,255,0.3))"
        fontFamily="var(--theme-mono)" fontSize={8}>FEAR</text>
      <text x={182} y={116} textAnchor="end" fill="var(--theme-text-dim, rgba(255,255,255,0.3))"
        fontFamily="var(--theme-mono)" fontSize={8}>GREED</text>
    </svg>
  )
}

// ── Sparkline ──────────────────────────────────────────────────────────────────
function Sparkline({ points }: { points: HistoryPoint[] }) {
  if (points.length < 2) return null
  const W = 220, H = 48
  const scores = points.map(p => p.composite_score)
  const min = Math.min(...scores, 30), max = Math.max(...scores, 70)
  const range = max - min || 1
  const xs = points.map((_, i) => (i / (points.length - 1)) * W)
  const ys = scores.map(s => H - ((s - min) / range) * H)
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ')
  const color = sentimentColor(scores[scores.length - 1])
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: H, display: 'block' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" opacity={0.7} />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={3} fill={color} />
    </svg>
  )
}

// ── Velocity display ───────────────────────────────────────────────────────────
function VelocityBadge({ v }: { v: Velocity }) {
  const up   = v.velocity_hr > 0
  const flat = Math.abs(v.velocity_hr) < 0.5
  const color = flat ? T.muted : up ? T.pos : T.neg
  const arrow = flat ? '→' : up ? '↑' : '↓'
  const label = flat
    ? 'Stable'
    : `${up ? '+' : ''}${v.velocity_hr.toFixed(1)}/hr`
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'var(--theme-hover, rgba(255,255,255,0.03))', border: `1px solid var(--theme-border-faint, rgba(255,255,255,0.05))` }}>
      <span style={{ fontSize: 14, color }}>{arrow}</span>
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color, fontFamily: T.mono }}>{label}</div>
        <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>over {v.elapsed_min}m</div>
      </div>
    </div>
  )
}

// ── Session selector ───────────────────────────────────────────────────────────
function SessionSelector({ active, onChange }: { active: SessionId; onChange: (s: SessionId) => void }) {
  const holiday = isHoliday()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {holiday && (
        <div style={{ fontSize: 8, fontWeight: 700, color: '#f7c94b', letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: T.mono, padding: '3px 6px', border: '1px solid rgba(247,201,75,0.25)', background: 'rgba(247,201,75,0.06)', marginBottom: 2 }}>
          NYSE Holiday — RTH unavailable
        </div>
      )}
      {SESSIONS.map(s => {
        const disabled = sessionDisabled(s.id)
        const isActive = s.id === active
        const isCurrent = s.id === currentSession()
        return (
          <button
            key={s.id}
            onClick={() => !disabled && onChange(s.id)}
            disabled={disabled}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px', background: isActive ? `${s.color}15` : 'transparent',
              border: `1px solid ${isActive ? s.color + '60' : T.border}`,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.35 : 1, textAlign: 'left',
            }}
          >
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: isCurrent ? s.color : 'transparent', border: `1.5px solid ${s.color}`, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: isActive ? s.color : T.muted, fontFamily: T.mono, letterSpacing: '0.06em' }}>
                {s.short}
                {isCurrent && <span style={{ fontSize: 7, marginLeft: 4, color: s.color, opacity: 0.7 }}>● LIVE</span>}
              </div>
              <div style={{ fontSize: 8, color: T.muted, fontFamily: T.label }}>{s.description}</div>
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Asset class tag ────────────────────────────────────────────────────────────
function AssetTag({ name, assetClass }: { name: string; assetClass: string }) {
  const color = ASSET_CLASS_COLORS[assetClass] ?? T.muted
  return (
    <span style={{
      fontSize: 8, fontWeight: 700, fontFamily: T.mono, letterSpacing: '0.06em',
      padding: '1px 4px', border: `1px solid ${color}40`, color, background: `${color}10`,
      whiteSpace: 'nowrap',
    }}>
      {name}
    </span>
  )
}

// ── Source panel ───────────────────────────────────────────────────────────────
// Articles show all current headlines regardless of session selector.
// Session selector only filters the sparkline trend. Each article shows
// a badge for the session it was published in.
function SourcePanel({ src }: { src: Source }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{ marginBottom: 8, border: `1px solid ${src.qualifies ? T.border : 'var(--theme-hover, rgba(255,255,255,0.03))'}`, background: T.surface, opacity: src.qualifies ? 1 : 0.55 }}>
      <div onClick={() => setExpanded(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: T.text, fontFamily: T.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {src.label}
            </span>
            {!src.qualifies && (
              <span style={{ fontSize: 7, fontWeight: 700, color: T.muted, letterSpacing: '0.1em', fontFamily: T.mono, background: 'var(--theme-border-faint, rgba(255,255,255,0.05))', padding: '1px 4px' }}>
                LOW SIGNAL
              </span>
            )}
          </div>
          <div style={{ fontSize: 9, color: T.muted, marginTop: 2, fontFamily: T.mono }}>
            {src.count} headlines · T{src.avg_tier.toFixed(0)} · conf {(src.avg_conf * 100).toFixed(0)}%
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: sentimentColor(src.avg_score), fontFamily: T.mono }}>
            {src.avg_score.toFixed(0)}
          </div>
          <div style={{ fontSize: 8, color: src.avg_direction > 0.1 ? T.pos : src.avg_direction < -0.1 ? T.neg : T.muted, fontFamily: T.mono }}>
            {src.avg_direction > 0 ? '+' : ''}{src.avg_direction.toFixed(2)}
          </div>
        </div>
        <span style={{ color: T.muted, fontSize: 10 }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{ padding: '0 12px 12px', borderTop: `1px solid ${T.border}` }}>
          {/* Asset groups */}
          {Object.keys(src.asset_groups).length > 0 && (
            <div style={{ padding: '8px 0', display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {Object.entries(src.asset_groups).map(([ac, names]) =>
                names.slice(0, 4).map(name => <AssetTag key={`${ac}-${name}`} name={name} assetClass={ac} />)
              )}
            </div>
          )}

          {src.items.map((item, i) => {
            const itemSession = SESSIONS.find(s => s.id === getSessionForEpoch(item.published_at))
            return (
              <div key={i} style={{
                padding: '7px 8px', marginTop: 6, background: sentimentBg(item.score),
                border: `1px solid var(--theme-hover, rgba(255,255,255,0.04))`,
                opacity: confOpacity(item.confidence),
              }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 4 }}>
                  <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: sentimentColor(item.score), flexShrink: 0, marginTop: 2 }}>
                    {item.sentiment}
                  </span>
                  <span style={{ fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: '15px', flex: 1 }}>
                    {item.url
                      ? <a href={item.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>{item.text}</a>
                      : item.text}
                  </span>
                </div>
                {/* Provenance row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 8, padding: '1px 5px', fontFamily: T.mono, fontWeight: 700, letterSpacing: '0.06em', background: `${tierColor(item.macro_tier)}15`, color: tierColor(item.macro_tier), border: `1px solid ${tierColor(item.macro_tier)}40` }}>
                    T{item.macro_tier}
                  </span>
                  <span style={{ fontSize: 8, padding: '1px 5px', fontFamily: T.mono, color: T.muted, background: 'var(--theme-hover, rgba(255,255,255,0.03))', border: `1px solid ${T.border}` }}>
                    [{item.reasoning_tag}]
                  </span>
                  <span style={{ fontSize: 8, color: T.muted, fontFamily: T.mono }}>
                    conf {(item.confidence * 100).toFixed(0)}%
                  </span>
                  {itemSession && (
                    <span style={{ fontSize: 7, padding: '1px 4px', fontFamily: T.mono, color: itemSession.color, border: `1px solid ${itemSession.color}40`, background: `${itemSession.color}10` }}>
                      {itemSession.short}
                    </span>
                  )}
                  {item.entities.slice(0, 3).map(e => <AssetTag key={e.name} name={e.name} assetClass={e.asset_class} />)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Score bar ──────────────────────────────────────────────────────────────────
function ScoreBar({ score, label, conf }: { score: number; label: string; conf: number }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, fontSize: 10, fontFamily: T.mono }}>
        <span style={{ color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 8 }}>{label}</span>
        <span style={{ color: sentimentColor(score), flexShrink: 0 }}>{score.toFixed(0)}</span>
      </div>
      <div style={{ height: 3, background: 'var(--theme-hover, rgba(255,255,255,0.06))', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${Math.max(0, Math.min(100, score))}%`, background: sentimentColor(score), opacity: 0.4 + conf * 0.6, transition: 'width 0.6s ease' }} />
      </div>
    </div>
  )
}

// ── Page ───────────────────────────────────────────────────────────────────────
export default function SentimentTracker() {
  const [session, setSession] = useState<SessionId>(currentSession)
  const qc = useQueryClient()

  const { data, isLoading, error, isFetching } = useQuery<Snapshot>({
    queryKey:        ['sentiment-snapshot'],
    queryFn:         () => axios.get('/api/sentiment/snapshot').then(r => r.data),
    staleTime:       14 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  })

  const { data: histResp } = useQuery<HistoryResp>({
    queryKey:        ['sentiment-history'],
    queryFn:         () => axios.get('/api/sentiment/history').then(r => r.data),
    staleTime:       5 * 60 * 1000,
    refetchInterval: 15 * 60 * 1000,
  })

  const history = histResp?.points ?? []
  const velocity = data?.velocity ?? histResp?.velocity

  // Filter history to selected session (for sparkline)
  const sessionHistory = useMemo(
    () => history.filter(p => getSessionForEpoch(p.fetched_at) === session),
    [history, session]
  )

  // Prefer server-computed baseline (persisted across restarts); fall back to in-memory history
  const baselineAvg = useMemo(() => {
    if (data?.baseline_score != null) return data.baseline_score
    if (history.length < 3) return null
    return history.reduce((s, p) => s + p.composite_score, 0) / history.length
  }, [data, history])

  const baselineDelta = data != null && baselineAvg !== null
    ? data.baseline_delta ?? (data.composite_score - baselineAvg)
    : null

  const baselineN = data?.baseline_n ?? history.length

  // Source-type breakdown
  const sourceTypeCounts = useMemo(() => {
    if (!data) return null
    const counts: Record<string, number> = {}
    for (const src of data.sources) {
      counts[src.type] = (counts[src.type] ?? 0) + 1
    }
    return counts
  }, [data])

  // Per-asset-class sentiment aggregated across all sources/items
  const assetClassScores = useMemo(() => {
    if (!data) return []
    const acc: Record<string, { scoreSum: number; confSum: number; count: number }> = {}
    for (const src of data.sources) {
      for (const item of src.items) {
        for (const entity of item.entities ?? []) {
          const ac = entity.asset_class
          if (!acc[ac]) acc[ac] = { scoreSum: 0, confSum: 0, count: 0 }
          acc[ac].scoreSum += item.score * item.confidence
          acc[ac].confSum  += item.confidence
          acc[ac].count    += 1
        }
      }
    }
    return Object.entries(acc)
      .filter(([, v]) => v.count > 0)
      .map(([ac, v]) => ({
        ac,
        score: v.confSum > 0 ? Math.round(v.scoreSum / v.confSum) : 50,
        count: v.count,
      }))
      .sort((a, b) => b.count - a.count)
  }, [data])

  const handleRefresh = () => {
    qc.invalidateQueries({ queryKey: ['sentiment-snapshot'] })
    qc.invalidateQueries({ queryKey: ['sentiment-history'] })
    axios.get('/api/sentiment/snapshot?refresh=true')
      .then(fresh => qc.setQueryData(['sentiment-snapshot'], fresh.data))
  }

  const lastUpdated = data?.fetched_at
    ? new Date(data.fetched_at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  const conf         = data?.session_conf ?? 1
  const lowSignal    = conf < 0.5
  const newsSources  = data?.sources ?? []
  const activeSess   = SESSIONS.find(s => s.id === session)!

  const sidebar = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* Gauge */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '14px 14px 10px' }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 10, textAlign: 'center' }}>
          Market Sentiment
        </div>
        {data ? (
          <>
            <Gauge score={data.composite_score} conf={conf} />
            <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', color: sentimentColor(data.composite_score), marginTop: 6, fontFamily: T.mono, textAlign: 'center' }}>
              {data.label}
            </div>
            {lowSignal && (
              <div style={{ marginTop: 6, textAlign: 'center', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: '#f7c94b', fontFamily: T.mono, background: 'rgba(247,201,75,0.07)', padding: '3px 0', border: '1px solid rgba(247,201,75,0.2)' }}>
                LOW SIGNAL — CONF {(conf * 100).toFixed(0)}%
              </div>
            )}
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 9, color: T.muted, fontFamily: T.mono }}>
              <span>DIR {data.direction > 0 ? '+' : ''}{data.direction.toFixed(2)}</span>
              <span>{data.total_headlines} headlines</span>
            </div>
            {baselineDelta !== null && (
              <div style={{ marginTop: 6, padding: '4px 8px', background: 'var(--theme-hover, rgba(255,255,255,0.03))', border: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))', textAlign: 'center', fontSize: 9, fontFamily: T.mono }}>
                <span style={{ color: T.muted }}>vs {baselineN}pt baseline </span>
                <span style={{ color: baselineDelta > 3 ? T.pos : baselineDelta < -3 ? T.neg : T.muted, fontWeight: 700 }}>
                  {baselineDelta > 0 ? '+' : ''}{baselineDelta.toFixed(1)}
                </span>
                {data?.baseline_std != null && (
                  <span style={{ color: 'var(--theme-text-dim, rgba(255,255,255,0.2))' }}> ±{data.baseline_std.toFixed(1)}σ</span>
                )}
              </div>
            )}
            {sourceTypeCounts && (
              <div style={{ marginTop: 5, display: 'flex', gap: 4, justifyContent: 'center', flexWrap: 'wrap' }}>
                {Object.entries(sourceTypeCounts).map(([type, n]) => (
                  <span key={type} style={{
                    fontSize: 8, fontFamily: T.mono, fontWeight: 700, letterSpacing: '0.08em',
                    padding: '2px 5px', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
                    color: type === 'reddit' ? '#ff6314' : type === 'finnhub' ? '#60a5fa' : T.muted,
                    background: type === 'reddit' ? 'rgba(255,99,20,0.06)' : type === 'finnhub' ? 'rgba(96,165,250,0.06)' : 'transparent',
                  }}>
                    {type.toUpperCase()} {n}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : isLoading ? (
          <div style={{ height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontSize: 11 }}>Loading…</div>
        ) : null}
        {lastUpdated && (
          <div style={{ fontSize: 9, color: T.muted, marginTop: 6, fontFamily: T.mono, textAlign: 'center' }}>Updated {lastUpdated}</div>
        )}
      </div>

      {/* Asset-class breakdown */}
      {assetClassScores.length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '10px 12px' }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8 }}>
            By Asset Class
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {assetClassScores.map(({ ac, score, count }) => {
              const color = ASSET_CLASS_COLORS[ac] ?? T.muted
              const sentiment = score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'neutral'
              const sentColor = score >= 60 ? T.pos : score <= 40 ? T.neg : T.muted
              return (
                <div key={ac}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color, fontFamily: T.mono, letterSpacing: '0.04em' }}>{ac}</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: sentColor, fontFamily: T.mono }}>{sentiment}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color, fontFamily: T.mono }}>{score}</span>
                    </div>
                  </div>
                  <div style={{ height: 3, background: `${T.border}`, borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      width: `${score}%`, height: '100%', borderRadius: 2,
                      background: color, opacity: 0.75,
                      transition: 'width 0.5s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: 8, color: T.muted, marginTop: 2, fontFamily: T.mono }}>{count} mention{count !== 1 ? 's' : ''}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Velocity */}
      {velocity && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 10 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>Velocity</div>
          <VelocityBadge v={velocity} />
        </div>
      )}

      {/* Session selector */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 10 }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8 }}>Market Session</div>
        <SessionSelector active={session} onChange={setSession} />
      </div>

      {/* Trend sparkline */}
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 12 }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>
          Trend — {activeSess.short}
        </div>
        {sessionHistory.length >= 2
          ? <Sparkline points={sessionHistory} />
          : <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, textAlign: 'center', padding: '12px 0' }}>Accumulates per session</div>
        }
      </div>

      {/* Source score bars */}
      {newsSources.length > 0 && (
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: 12 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 10 }}>
            By Source
          </div>
          {newsSources.map(s => (
            <ScoreBar key={s.label} score={s.avg_score} label={s.label} conf={s.avg_conf} />
          ))}
        </div>
      )}

      {/* Refresh */}
      <button
        onClick={handleRefresh}
        disabled={isFetching}
        style={{
          padding: '7px 12px', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase', background: 'transparent', border: `1px solid ${T.gold}`,
          color: T.gold, cursor: isFetching ? 'wait' : 'pointer',
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
          Fetching financial news headlines and scoring with AI…<br />
          <span style={{ fontSize: 10, opacity: 0.6 }}>First load ~10–15 seconds</span>
        </div>
      )}

      {/* Asset class legend */}
      {data && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {Object.entries(ASSET_CLASS_COLORS).map(([ac, color]) => (
            <span key={ac} style={{ fontSize: 8, fontWeight: 700, fontFamily: T.mono, letterSpacing: '0.06em', padding: '2px 6px', border: `1px solid ${color}40`, color, background: `${color}10` }}>
              {ac}
            </span>
          ))}
          <span style={{ fontSize: 8, fontFamily: T.mono, color: T.muted, padding: '2px 6px', border: `1px solid ${T.border}` }}>T1–T5 = macro tier</span>
        </div>
      )}

      {data && newsSources.length > 0 && (
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 8 }}>
            News Headlines — {activeSess.label} ({newsSources.reduce((a, s) => a + s.count, 0)} total)
          </div>
          <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 8, padding: '4px 8px', background: 'var(--theme-hover, rgba(255,255,255,0.02))', border: `1px solid ${T.border}` }}>
            Articles = current RSS snapshot. Session selector filters the Trend sparkline only. Each article badge shows its publish session.
          </div>
          {newsSources.map(src => (
            <SourcePanel key={src.label} src={src} />
          ))}
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
              Financial News · AI Scored · Session: <span style={{ color: activeSess.color }}>{activeSess.label}</span>
            </div>
          </div>
        </div>
        {content}
      </SidebarLayout>
    </PageWrapper>
  )
}
