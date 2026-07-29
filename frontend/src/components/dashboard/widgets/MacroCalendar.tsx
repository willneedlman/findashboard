import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../../lib/theme'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { useWidgetContentState } from '../widgetContentState'

interface Reaction {
  asset: string
  change: number | null
  unit?: string
}

interface MacroEvent {
  id: string
  name: string
  category: string
  datetime: string
  displayTime: string
  impact: string
  status: string
  actual: string | number | null
  expected: string | number | null
  previous: string | number | null
  expectedLabel?: string
  sourceName: string
  reactions: Reaction[]
}

interface CalendarResponse {
  events: MacroEvent[]
  as_of: string
  source: string
}

const CAT_COLOR: Record<string, string> = {
  'central bank': T.gold,
  inflation: T.neg,
  labor: T.pos,
  growth: T.blue,
  sentiment: 'var(--theme-accent-violet, #a78bfa)',
}

const CAT_TAG: Record<string, string> = {
  'central bank': 'FED',
  inflation: 'INF',
  labor: 'LAB',
  growth: 'GDP',
  sentiment: 'SNT',
}

function categoryKey(value: string): string {
  const key = value.toLowerCase()
  if (key === 'monetary') return 'central bank'
  if (key === 'employment') return 'labor'
  if (key === 'housing') return 'growth'
  return key
}

function groupEvents(events: MacroEvent[]): [string, MacroEvent[]][] {
  const groups = new Map<string, MacroEvent[]>()
  for (const event of events) {
    const date = new Date(event.datetime)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const eventDay = new Date(date)
    eventDay.setHours(0, 0, 0, 0)
    const days = Math.round((eventDay.getTime() - today.getTime()) / 86_400_000)
    const label = days === 0 ? 'Today'
      : days === 1 ? 'Tomorrow'
        : days > 1 && days <= 7 ? 'This Week'
          : date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    groups.set(label, [...(groups.get(label) ?? []), event])
  }
  return [...groups.entries()]
}

function valueText(value: string | number | null): string {
  return value == null || value === '' ? '-' : String(value)
}

export default function MacroCalendar({ config }: { config: WidgetConfig }) {
  const { data, isLoading, isError } = useQuery<CalendarResponse>({
    queryKey: ['macro-events-widget'],
    queryFn: () => axios.get('/api/macro-events').then(r => r.data),
    staleTime: 3_600_000,
    retry: 1,
  })
  const selected = config.categories?.map(categoryKey)
  const events = (data?.events ?? []).filter(event => !selected?.length || selected.includes(categoryKey(event.category)))
  useWidgetContentState(config.id, isLoading ? 'loading' : isError ? 'error' : events.length ? 'ready' : 'empty')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isLoading && <div style={{ padding: 12, color: T.muted, fontFamily: T.mono, fontSize: 10 }}>Loading release calendar...</div>}
        {isError && <div style={{ padding: 12, color: T.neg, fontFamily: T.mono, fontSize: 10 }}>Release calendar unavailable</div>}
        {groupEvents(events).map(([group, rows]) => (
          <div key={group}>
            <div style={{
              padding: '5px 10px 3px', borderBottom: `1px solid ${T.border}`,
              color: T.muted, fontFamily: T.label, fontSize: 8, fontWeight: 700,
              letterSpacing: '0.12em', textTransform: 'uppercase',
            }}>
              {group}
            </div>
            {rows.map(event => {
              const key = categoryKey(event.category)
              const color = CAT_COLOR[key] ?? T.gold
              const released = event.status === 'released'
              return (
                <div key={event.id} style={{ padding: '6px 10px', borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <div style={{ width: 3, height: event.impact.toLowerCase() === 'high' ? 24 : 15, background: color, opacity: event.impact.toLowerCase() === 'low' ? 0.4 : 1 }} />
                    <span style={{ width: 24, color, fontFamily: T.mono, fontSize: 7, fontWeight: 700 }}>{CAT_TAG[key] ?? 'ECO'}</span>
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.text, fontFamily: T.label, fontSize: 10 }}>
                      {event.name}
                    </span>
                    <span style={{ color: T.muted, fontFamily: T.mono, fontSize: 8 }}>{event.displayTime}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 10, paddingLeft: 34, marginTop: 3, fontFamily: T.mono, fontSize: 8 }}>
                    <span style={{ color: released ? T.text : T.muted }}>ACT {valueText(event.actual)}</span>
                    <span style={{ color: T.muted }}>{(event.expectedLabel ?? 'CONS').toUpperCase()} {valueText(event.expected)}</span>
                    <span style={{ color: T.textDim }}>PREV {valueText(event.previous)}</span>
                  </div>
                  {event.reactions?.length > 0 && (
                    <div style={{ display: 'flex', gap: 10, paddingLeft: 34, marginTop: 3, fontFamily: T.mono, fontSize: 8 }}>
                      {event.reactions.map(reaction => (
                        <span key={reaction.asset} style={{ color: reaction.change == null ? T.muted : reaction.change >= 0 ? T.pos : T.neg }}>
                          {reaction.asset} {reaction.change == null ? '-' : `${reaction.change >= 0 ? '+' : ''}${reaction.change}${reaction.unit ?? ''}`}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
        {!isLoading && !events.length && (
          <div style={{ display: 'grid', gap: 4, padding: '14px 12px', color: T.muted }}>
            <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
              Calendar clear
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 9, lineHeight: 1.5 }}>
              No matching releases in the current window.
            </span>
          </div>
        )}
      </div>
      {data && <div style={{ padding: '3px 10px', borderTop: `1px solid ${T.border}`, color: T.muted, background: T.surface, fontFamily: T.mono, fontSize: 8 }}>{data.source}</div>}
    </div>
  )
}
