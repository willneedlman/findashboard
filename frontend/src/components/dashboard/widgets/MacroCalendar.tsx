import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg:       'var(--theme-bg, #101c2e)',
  surface:  'var(--theme-surface, #0d1826)',
  border:   'var(--theme-border, rgba(255,255,255,0.08))',
  gold:     'var(--theme-primary, #c9a84c)',
  text:     'var(--theme-text, #d7e3fc)',
  muted:    'var(--theme-secondary, #5e768f)',
  mono:     'var(--theme-mono)',
  label:    'var(--theme-sans)',
}

const CAT_COLOR: Record<string, string> = {
  monetary:   'var(--theme-primary, #c9a84c)',
  inflation:  'var(--theme-negative, #ef4444)',
  employment: 'var(--theme-positive, #22c55e)',
  growth:     'var(--theme-tertiary, #60a5fa)',
  housing:    'var(--theme-accent-orange, #f97316)',
  sentiment:  'var(--theme-accent-violet, #a78bfa)',
}

const CAT_TAG: Record<string, string> = {
  monetary:   'FED',
  inflation:  'INF',
  employment: 'EMP',
  growth:     'GDP',
  housing:    'HSG',
  sentiment:  'SNT',
}

interface MacroEvent {
  date: string
  time_et?: string
  label: string
  category: string
  importance: 'high' | 'medium'
  unit: string
  previous: string | null
}

interface CalendarResponse {
  events: MacroEvent[]
  as_of: string
}

function fmtTime(t: string): string {
  const [hStr, mStr] = t.split(':')
  const h = parseInt(hStr, 10)
  const suffix = h >= 12 ? 'PM' : 'AM'
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h
  return `${h12}:${mStr} ${suffix}`
}

function daysUntil(ds: string): number {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((new Date(ds + 'T00:00:00').getTime() - today.getTime()) / 86_400_000)
}

function groupEvents(events: MacroEvent[]): [string, MacroEvent[]][] {
  const map = new Map<string, MacroEvent[]>()
  for (const e of events) {
    const days = daysUntil(e.date)
    const key = days === 0 ? 'Today'
              : days === 1 ? 'Tomorrow'
              : days <= 7  ? 'This Week'
              : days <= 14 ? 'Next Week'
              : new Date(e.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).replace(/\d+$/, '')  + 'Week'
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(e)
  }
  return [...map.entries()]
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, var(--theme-border-faint, var(--theme-border-faint, rgba(255,255,255,0.05))) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%',
  animation: 'shimmer 2s infinite',
  borderRadius: 2,
}

const ALL_CATS = ['monetary', 'inflation', 'employment', 'growth', 'housing', 'sentiment']

export default function MacroCalendar({ config }: { config: WidgetConfig }) {
  const activeCats = config.categories?.length ? config.categories : ALL_CATS

  const { data, isLoading, isError } = useQuery<CalendarResponse>({
    queryKey: ['macro-calendar'],
    queryFn: () => axios.get('/api/rates/macro-calendar').then(r => r.data),
    staleTime: 3_600_000,
    retry: 1,
  })

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px 0' }}>
        {isLoading && (
          <div style={{ padding: '10px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[120, 90, 110, 80].map((w, i) => (
              <div key={i} style={{ ...shimmer, height: 12, width: `${w}px` }} />
            ))}
          </div>
        )}

        {isError && (
          <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: 'var(--theme-negative)' }}>
            Failed to load calendar
          </div>
        )}

        {data && groupEvents(data.events.filter(e => activeCats.includes(e.category))).map(([week, events]) => (
          <div key={week}>
            {/* Week label */}
            <div style={{
              padding: '5px 10px 3px',
              fontFamily: T.label, fontSize: 8, fontWeight: 700,
              letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted,
              borderBottom: `1px solid ${T.border}`,
            }}>
              {week}
            </div>

            {events.map((e, i) => {
              const days  = daysUntil(e.date)
              const color = CAT_COLOR[e.category] ?? T.gold
              const d     = new Date(e.date + 'T00:00:00')
              const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
              const timeStr = e.time_et ? ` ${fmtTime(e.time_et)} ET` : ''

              return (
                <div key={`${e.date}-${i}`} style={{
                  display: 'flex', alignItems: 'center', gap: 7,
                  padding: '4px 10px',
                  background: days === 0 ? `color-mix(in srgb, ${color} 8%, transparent)` : 'transparent',
                  borderBottom: `1px solid ${T.border}`,
                }}>
                  {/* Importance indicator */}
                  <div style={{
                    width: 3, height: e.importance === 'high' ? 22 : 14,
                    background: color,
                    opacity: e.importance === 'high' ? 1 : 0.45,
                    flexShrink: 0, borderRadius: 1,
                  }} />

                  {/* Category tag */}
                  <span style={{
                    fontFamily: T.mono, fontSize: 7, fontWeight: 700,
                    color, letterSpacing: '0.06em', flexShrink: 0, width: 22,
                  }}>
                    {CAT_TAG[e.category] ?? 'ECO'}
                  </span>

                  {/* Label */}
                  <span style={{
                    fontFamily: T.label, fontSize: 10, color: T.text,
                    flex: 1, minWidth: 0, overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {e.label}
                  </span>

                  {/* Date pill */}
                  <span style={{
                    fontFamily: T.mono, fontSize: 8, flexShrink: 0,
                    color: days <= 3 ? color : T.muted,
                    fontWeight: days <= 3 ? 700 : 400,
                  }}>
                    {days === 0 ? 'today' : days === 1 ? 'tmrw' : dateStr}{timeStr}
                  </span>
                </div>
              )
            })}
          </div>
        ))}

        {data && data.events.filter(e => activeCats.includes(e.category)).length === 0 && (
          <div style={{ padding: 16, fontFamily: T.mono, fontSize: 10, color: T.muted, textAlign: 'center' }}>
            No events in the next 90 days
          </div>
        )}
      </div>

      {/* Footer */}
      {data && (
        <div style={{
          padding: '3px 10px', background: T.surface,
          borderTop: `1px solid ${T.border}`, flexShrink: 0,
          fontFamily: T.mono, fontSize: 8, color: T.muted,
        }}>
          computed schedule · as of {data.as_of}
        </div>
      )}
    </div>
  )
}
