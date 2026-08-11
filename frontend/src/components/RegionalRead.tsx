import { T } from '../lib/theme'
import { StateChip } from './FreshnessChip'
import type { Board } from '../lib/observatory'

// The narrative panel. Text is composed by a fixed rule set on the backend, not
// by a language model, and it says so: a reader who cannot audit the sentence has
// no way to tell a measurement from a fluent guess. The version stamp is there so
// a changed sentence can be traced to a changed rule.

export default function RegionalRead({ board, compact }: { board: Board; compact?: boolean }) {
  const { read } = board
  const accent = read.directions === 'split' ? T.warn
    : read.directions === 'none' ? T.muted
    : T.blue

  return (
    <section style={{ border: `1px solid ${T.border}`, background: T.bg, padding: compact ? 12 : 16 }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10,
      }}>
        <span style={{
          fontFamily: T.label, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: T.muted,
        }}>
          Regional read — what the stations say together
        </span>
        <span
          title="Every sentence here describes the trailing window against an earlier window. Nothing on this board projects forward."
          style={{
            fontFamily: T.mono, fontSize: 8.5, letterSpacing: '0.08em', cursor: 'help',
            padding: '2px 6px', color: accent,
            border: `1px solid color-mix(in srgb, ${accent} 35%, transparent)`,
            background: `color-mix(in srgb, ${accent} 7%, transparent)`,
          }}
        >
          DESCRIPTIVE, NOT A FORECAST
        </span>
      </header>

      <p style={{
        margin: 0, fontFamily: T.label, fontSize: compact ? 12 : 13.5, lineHeight: 1.65, color: T.text,
      }}>{read.body}</p>

      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 12 }}>
        {read.stationStates.map(s => (
          <StateChip
            key={s.key} label={s.label} state={s.state}
            stale={s.stale} staleDays={s.staleDays}
          />
        ))}
      </div>

      <footer style={{
        marginTop: 12, paddingTop: 8, borderTop: `1px solid ${T.border}`,
        display: 'flex', gap: 12, flexWrap: 'wrap',
        fontFamily: T.mono, fontSize: 8.5, letterSpacing: '0.06em', color: T.muted,
      }}>
        {board.feedAsOf && <span>FEED {board.feedAsOf}</span>}
        <span>PATTERN GRAMMAR V{read.grammarVersion}</span>
        {read.liveStations != null && (
          <span>{read.liveStations} LIVE · {read.staleStations} STALE</span>
        )}
        <span title="Composed by a deterministic rule set, not a language model. The same series always produces the same sentence.">
          RULE-COMPOSED
        </span>
      </footer>
    </section>
  )
}
