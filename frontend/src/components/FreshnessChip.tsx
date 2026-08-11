import { T } from '../lib/theme'
import { freshnessLabel, type StationState } from '../lib/observatory'

// Freshness is a first-class fact, not a footnote. Provenance answers "where did
// this come from"; this answers "when did anyone last actually see it", which is
// the question that decides whether a number is worth acting on.

const STATE_COLOR: Record<StationState, string> = {
  steady: T.muted,
  rising: T.pos,
  building: T.pos,
  normalising: T.blue,
  falling: T.neg,
  drawing: T.neg,
  diverging: T.warn,
  stale: T.muted,
}

export function stateColor(state: StationState, stale: boolean): string {
  return stale ? T.muted : STATE_COLOR[state]
}

export function StateChip({ state, stale, staleDays, label }: {
  state: StationState
  stale: boolean
  staleDays?: number | null
  label?: string
}) {
  const color = stateColor(state, stale)
  return (
    <span
      title={stale
        ? `Past its freshness window (${freshnessLabel(staleDays ?? null)}). Excluded from the regional read.`
        : `Trailing window against the previous window. Descriptive, not a forecast.`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'help',
        fontFamily: T.mono, fontSize: 9, letterSpacing: '0.08em', whiteSpace: 'nowrap',
        padding: '2px 6px', textTransform: 'uppercase',
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 7%, transparent)`,
        color, opacity: stale ? 0.55 : 1,
      }}
    >
      {label && <span style={{ color: T.muted }}>{label}:</span>}
      <span style={{ fontWeight: 700 }}>{state}</span>
    </span>
  )
}

export default function FreshnessChip({ lastObs, staleDays, stale, quality, compact }: {
  lastObs: string | null
  staleDays: number | null
  stale: boolean
  quality?: 'ok' | 'sparse' | 'dark'
  compact?: boolean
}) {
  const color = stale ? T.warn : quality === 'sparse' ? T.muted : T.pos
  const label = quality === 'dark' ? 'NO DATA' : stale ? `STALE ${staleDays}d` : 'FRESH'
  const title = [
    quality === 'dark'
      ? 'No usable observation has ever landed for this station.'
      : `Last usable observation ${lastObs ?? 'unknown'} (${freshnessLabel(staleDays)}).`,
    quality === 'sparse' ? 'The trailing window holds fewer readings than days.' : '',
    stale ? 'Beyond its freshness window, so it is excluded from the regional read.' : '',
  ].filter(Boolean).join(' ')

  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'help',
        fontFamily: T.mono, fontSize: 9, whiteSpace: 'nowrap',
        padding: '2px 6px',
        border: `1px solid color-mix(in srgb, ${color} 35%, transparent)`,
        background: `color-mix(in srgb, ${color} 7%, transparent)`,
      }}
    >
      <span style={{
        width: 5, height: 5, borderRadius: '50%', flex: 'none',
        background: quality === 'sparse' ? 'transparent' : color,
        border: quality === 'sparse' ? `1px solid ${color}` : 'none',
      }} />
      <span style={{ fontWeight: 700, letterSpacing: '0.08em', color }}>{label}</span>
      {!compact && lastObs && <span style={{ color: T.muted }}>· obs {lastObs}</span>}
    </span>
  )
}
