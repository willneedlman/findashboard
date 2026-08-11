import { useMemo, useState } from 'react'
import { T } from '../lib/theme'
import FreshnessChip, { StateChip, stateColor } from './FreshnessChip'
import {
  coverageSummary, formatDelta, formatValue, gapTitle, segmentByGaps, type Station,
} from '../lib/observatory'

// One station, read on its own. Deliberately not a composite: blending stations
// into a single index hides that they can disagree, and the disagreement is the
// most useful thing a multi-station corridor tells you.
//
// The chart draws raw observations as dots and the trailing average as a line
// that BREAKS across coverage gaps. A continuous line over a week with no
// satellite pass is a drawn assertion that nothing happened, which is exactly
// the claim the data cannot support.

interface Props {
  station: Station
  height?: number
  showCaption?: boolean
  onSelect?: (key: string) => void
  selected?: boolean
}

export default function StationGauge({
  station, height = 84, showCaption = false, onSelect, selected,
}: Props) {
  const [hover, setHover] = useState<{ x: number; d: string; v: number } | null>(null)
  const color = stateColor(station.state, station.stale)

  const geom = useMemo(() => {
    const obs = station.observations
    if (obs.length < 2) return null
    const days = obs.map(o => Date.parse(o.d))
    const values = obs.map(o => o.v)
    const trailingValues = station.trailing.filter(p => p.v !== null).map(p => p.v as number)
    const all = [...values, ...trailingValues]
    const minX = Math.min(...days)
    const maxX = Math.max(...days)
    const rawMin = Math.min(...all)
    const rawMax = Math.max(...all)
    const pad = (rawMax - rawMin) * 0.12 || Math.abs(rawMax) * 0.1 || 1
    const minY = rawMin - pad
    const maxY = rawMax + pad
    const spanX = maxX - minX || 1
    const spanY = maxY - minY || 1
    const x = (iso: string) => ((Date.parse(iso) - minX) / spanX) * 100
    const y = (v: number) => height - ((v - minY) / spanY) * height
    return { x, y, minX, maxX, spanX }
  }, [station.observations, station.trailing, height])

  const runs = useMemo(() => segmentByGaps(station.trailing), [station.trailing])

  return (
    <div
      onClick={onSelect ? () => onSelect(station.key) : undefined}
      style={{
        border: `1px solid ${selected ? `color-mix(in srgb, ${T.gold} 45%, transparent)` : T.border}`,
        background: T.bg,
        padding: '10px 12px 8px',
        cursor: onSelect ? 'pointer' : 'default',
        opacity: station.stale ? 0.72 : 1,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{
          fontFamily: T.label, fontSize: 10, fontWeight: 600, letterSpacing: '0.06em',
          textTransform: 'uppercase', color: T.text,
        }}>{station.label}</span>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <StateChip state={station.state} stale={station.stale} staleDays={station.staleDays} />
          {station.stale && <FreshnessChip
            lastObs={station.lastObs} staleDays={station.staleDays}
            stale={station.stale} quality={station.quality} compact
          />}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 600, color }}>
          {formatValue(station.value, station.unit)}
        </span>
        {formatDelta(station.delta, station.deltaWindow) && (
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>
            {formatDelta(station.delta, station.deltaWindow)}
          </span>
        )}
        {station.stale && station.lastKnownState && (
          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
            last read {station.lastKnownState}
          </span>
        )}
      </div>

      {geom ? (
        <svg
          viewBox={`0 0 100 ${height}`} preserveAspectRatio="none"
          style={{ width: '100%', height, display: 'block', overflow: 'visible' }}
          onMouseLeave={() => setHover(null)}
        >
          {station.gaps.map(gap => {
            const x1 = geom.x(gap.from)
            const x2 = geom.x(gap.to)
            // An unexplained gap means the satellites did look and the reading
            // still did not arrive, which is a pipeline fault rather than an
            // observability limit, so it is marked instead of shaded away.
            const unexplained = gap.reason === 'unexplained'
            return (
              <rect
                key={gap.from} x={x1} y={0} width={Math.max(x2 - x1, 0.4)} height={height}
                fill={unexplained
                  ? `color-mix(in srgb, ${T.warn} 14%, transparent)`
                  : `color-mix(in srgb, ${T.muted} 12%, transparent)`}
              >
                <title>{gapTitle(gap)}</title>
              </rect>
            )
          })}

          {station.reference != null && (
            <line
              x1={0} x2={100} y1={geom.y(station.reference)} y2={geom.y(station.reference)}
              stroke={T.muted} strokeWidth={0.5} strokeDasharray="2 2" vectorEffect="non-scaling-stroke"
            />
          )}

          {runs.map((run, i) => (
            <polyline
              key={i}
              points={run.map(p => `${geom.x(p.d)},${geom.y(p.v)}`).join(' ')}
              fill="none" stroke={color} strokeWidth={1.4}
              vectorEffect="non-scaling-stroke" strokeLinejoin="round"
            />
          ))}

          {station.observations.map(o => (
            <circle
              key={o.d} cx={geom.x(o.d)} cy={geom.y(o.v)} r={1.6}
              fill={T.text} opacity={0.55}
              vectorEffect="non-scaling-stroke"
              onMouseEnter={() => setHover({ x: geom.x(o.d), d: o.d, v: o.v })}
            >
              <title>{`${o.d} · ${o.v}`}</title>
            </circle>
          ))}
        </svg>
      ) : (
        <div style={{
          height, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: T.mono, fontSize: 10, color: T.muted,
        }}>
          not enough observations to plot
        </div>
      )}

      <div style={{
        display: 'flex', justifyContent: 'space-between', gap: 8,
        fontFamily: T.mono, fontSize: 8.5, color: T.muted,
      }}>
        <span>{station.source || ''}</span>
        <span title={coverageSummary(station)}>
          {station.gaps.length ? `${station.gaps.length} gap${station.gaps.length === 1 ? '' : 's'}` : ''}
        </span>
      </div>

      {hover && (
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
          {hover.d} · {hover.v}
        </div>
      )}

      {showCaption && station.caption && (
        <p style={{
          margin: 0, fontFamily: T.label, fontSize: 10.5, lineHeight: 1.5, color: T.muted,
        }}>{station.caption}</p>
      )}
    </div>
  )
}

export function StationLegend() {
  return (
    <div style={{
      display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center',
      fontFamily: T.mono, fontSize: 9, color: T.muted,
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: T.text, opacity: 0.55 }} />
        observed reading
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 14, height: 1.5, background: T.gold }} />
        trailing average
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{
          width: 12, height: 9,
          background: `color-mix(in srgb, ${T.muted} 20%, transparent)`,
        }} />
        coverage gap — nothing interpolated
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <span style={{ width: 14, borderTop: `1px dashed ${T.muted}` }} />
        reference
      </span>
    </div>
  )
}
