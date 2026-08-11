import { useQuery } from '@tanstack/react-query'
import { T } from '../lib/theme'
import RegionalRead from './RegionalRead'
import StationGauge, { StationLegend } from './StationGauge'
import FreshnessChip from './FreshnessChip'
import type { Board as ObservationBoard } from '../lib/observatory'

// Renders any observation board. Every state, gap and freshness verdict is
// computed by the backend grammar, so this file lays out what it is given and
// derives nothing — a chip and a chart can never disagree about a station.

const HOUR_MS = 3_600_000

export interface ObservationBoardPanelProps {
  queryKey: unknown[]
  fetcher: () => Promise<ObservationBoard>
  enabled?: boolean
  footnote?: string
  emptyLabel?: string
  // Embedded inside another panel's spare space rather than owning a panel:
  // tighter gauges, and the standing explanation drops to a tooltip.
  compact?: boolean
}

export default function ObservationBoardPanel({
  queryKey, fetcher, enabled = true, footnote, emptyLabel, compact = false,
}: ObservationBoardPanelProps) {
  const { data, isLoading, error } = useQuery<ObservationBoard>({
    queryKey,
    queryFn: fetcher,
    staleTime: HOUR_MS,
    refetchInterval: HOUR_MS,
    refetchOnWindowFocus: false,
    enabled,
    retry: false,
  })

  const shell = (children: React.ReactNode) => (
    <div style={{
      border: `1px solid ${T.border}`, padding: 16,
      fontFamily: T.mono, fontSize: 10, color: T.muted, lineHeight: 1.6,
    }}>{children}</div>
  )

  if (isLoading) return shell('Reading stations…')

  if (error || !data) {
    // The backend states why a board is unavailable (a missing key, a dead
    // feed). Surfacing that verbatim beats a generic failure, because "no data"
    // and "flaring stopped" look identical on an empty chart.
    const detail = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
    return shell(detail || emptyLabel || 'Board unavailable. The feed did not return a usable series.')
  }

  const staleCount = data.stations.filter(s => s.stale).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, flexWrap: 'wrap',
      }}>
        <span style={{
          fontFamily: T.label, fontSize: 11, fontWeight: 600, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: T.text,
        }}>
          {data.subject} — stations
        </span>
        <FreshnessChip
          lastObs={data.feedAsOf}
          staleDays={data.stations[0]?.staleDays ?? null}
          stale={staleCount === data.stations.length && data.stations.length > 0}
          quality={data.stations.every(s => s.quality === 'dark') ? 'dark' : 'ok'}
        />
      </div>

      <RegionalRead board={data} compact={compact} />

      {data.coverage && (
        <div
          title={`Checked against the ${data.coverage.source}. A pass counts as usable when scene cloud is at or below ${data.coverage.cloudLimit}%; radar passes always count, which is why they see ships optical cannot.`}
          style={{
            display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', cursor: 'help',
            border: `1px solid ${T.border}`, padding: '6px 10px',
            fontFamily: T.mono, fontSize: 9, color: T.muted,
          }}
        >
          <span style={{ color: T.text, letterSpacing: '0.08em' }}>SATELLITE LOOK RATE</span>
          <span>{Math.round(data.coverage.lookRate * 100)}% of {data.coverage.windowDays}d</span>
          <span>{data.coverage.daysWithUsablePass} usable of {data.coverage.daysWithPass} pass days</span>
        </div>
      )}

      {data.viewing?.filtering && data.viewing.partialViewDays > 0 && (
        <div
          title={data.viewing.note}
          style={{
            display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', cursor: 'help',
            border: `1px solid color-mix(in srgb, ${T.warn} 30%, transparent)`,
            background: `color-mix(in srgb, ${T.warn} 6%, transparent)`,
            padding: '6px 10px', fontFamily: T.mono, fontSize: 9, color: T.muted,
          }}
        >
          <span style={{ color: T.warn, letterSpacing: '0.08em' }}>OBSCURED VIEWS HELD OUT</span>
          <span>{data.viewing.partialViewDays} day{data.viewing.partialViewDays === 1 ? '' : 's'}</span>
          <span>
            under {data.viewing.partialViewThreshold} detections vs a
            baseline of {data.viewing.medianDetections}
          </span>
        </div>
      )}

      <StationLegend title={compact ? footnote : undefined} />

      <div style={{
        display: 'grid', gap: 10,
        gridTemplateColumns: `repeat(auto-fit, minmax(${compact ? 190 : 240}px, 1fr))`,
      }}>
        {data.stations.map(station => (
          <StationGauge key={station.key} station={station} height={compact ? 58 : 84} />
        ))}
      </div>

      {compact ? null : <p style={{
        margin: 0, fontFamily: T.label, fontSize: 10.5, lineHeight: 1.6, color: T.muted,
      }}>
        {footnote || (
          <>
            Each station is measured on its own and never pooled into a single index.
            Breaks in a line are real coverage gaps where the feed saw nothing, and
            nothing is drawn across them.
          </>
        )}
      </p>}
    </div>
  )
}
