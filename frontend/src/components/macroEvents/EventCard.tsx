import { ExternalLink, Clock, MapPin } from 'lucide-react'
import { T } from '../../lib/theme'
import type { MacroEvent, Impact } from '../../data/mockEventsData'
import MarketReactionBadge from './MarketReactionBadge'

const IMPACT_COLOR: Record<Impact, string> = { High: T.neg, Medium: T.gold, Low: T.muted }

function timeUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'due'
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  if (days >= 1) return `in ${days}d ${hours}h`
  const mins = Math.floor((ms % 3_600_000) / 60_000)
  return `in ${hours}h ${mins}m`
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 74 }}>
      <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: accent || T.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

function Chip({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 7px', border: `1px solid ${color}`, color,
      fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
    }}>{children}</span>
  )
}

export default function EventCard({ event }: { event: MacroEvent }) {
  const upcoming = event.status === 'upcoming'
  const impactColor = IMPACT_COLOR[event.impact]

  return (
    <article style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderLeft: `3px solid ${impactColor}`,
      boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      padding: '16px 18px',
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <h3 style={{ margin: 0, fontFamily: T.mono, fontSize: 15, fontWeight: 700, color: T.text }}>{event.name}</h3>
            <Chip color={impactColor}>{event.impact}</Chip>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: T.muted, fontFamily: T.label, fontSize: 11 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <MapPin size={12} /> {event.country} <span style={{ color: T.border }}>·</span> {event.category}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Clock size={12} /> {event.displayTime}
            </span>
          </div>
        </div>
        {upcoming
          ? <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold, padding: '3px 9px', border: `1px solid ${T.goldTint(45)}`, background: T.goldTint(10), whiteSpace: 'nowrap' }}>UPCOMING · {timeUntil(event.datetime)}</span>
          : <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: T.muted, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Released</span>}
      </div>

      {/* Numbers */}
      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', paddingBottom: 2 }}>
        <Stat label="Actual" value={event.actual ?? '—'} accent={upcoming ? T.muted : T.gold} />
        {event.expected != null && <Stat label={event.expectedLabel || 'Consensus'} value={event.expected} accent={T.blue} />}
        <Stat label="Previous" value={event.previous} />
      </div>

      {/* AI summary */}
      <div style={{
        background: T.bg, border: `1px solid ${T.borderFaint}`,
        padding: '11px 13px',
        fontFamily: T.label, fontSize: 12.5, lineHeight: 1.55, color: T.text,
      }}>
        <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, display: 'block', marginBottom: 5 }}>Brief</span>
        {event.summary}
      </div>

      {/* Market response + source */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }}>Market Response</span>
          {upcoming
            ? <span style={{ fontFamily: T.label, fontSize: 11, color: T.muted, fontStyle: 'italic' }}>Pending release</span>
            : <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {event.reactions.map(r => <MarketReactionBadge key={r.asset} reaction={r} />)}
              </div>}
        </div>
        <a href={event.sourceUrl} target="_blank" rel="noopener noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '5px 11px', border: `1px solid ${T.border}`,
            fontFamily: T.label, fontSize: 11, fontWeight: 600, color: T.blue, textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}>
          {event.sourceName} <ExternalLink size={12} />
        </a>
      </div>
    </article>
  )
}
