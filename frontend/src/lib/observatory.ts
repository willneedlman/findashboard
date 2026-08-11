// Client mirror of backend/observatory/grammar.py. The backend decides every
// state; nothing here re-derives one, so a chart and a chip can never disagree
// about what a station is doing.

export type StationKind = 'stock' | 'flow' | 'share'

export type StationState =
  | 'steady' | 'rising' | 'falling' | 'building'
  | 'drawing' | 'normalising' | 'diverging' | 'stale'

export interface ObservationPoint { d: string; v: number }
export interface TrailingPoint { d: string; v: number | null; n?: number }
export type GapReason =
  | 'no_pass' | 'cloud' | 'partial' | 'unexplained'
  // Thermal-sensor gaps, attributed by FIRMS itself rather than by Sentinel coverage.
  | 'partial_view' | 'no_reading'

export interface ViewingSummary {
  medianDetections: number | null
  partialViewDays: number
  partialViewThreshold: number | null
  filtering: boolean
  note: string
}

export interface CoverageGap {
  from: string
  to: string
  days: number
  // Present once the gap has been checked against the Copernicus catalogue.
  reason?: GapReason
  detail?: string
  passes?: number
  usablePasses?: number
}

export interface CoverageSummary {
  windowDays: number
  daysWithPass: number
  daysWithUsablePass: number
  lookRate: number
  cloudLimit: number
  source: string
}

export const GAP_REASON_LABEL: Record<GapReason, string> = {
  no_pass: 'no satellite pass',
  cloud: 'cloud',
  partial: 'partial cloud',
  unexplained: 'look available, reading missing',
  partial_view: 'obscured view, not a quiet field',
  no_reading: 'no usable detections',
}

export interface Station {
  key: string
  label: string
  kind: StationKind
  unit: string
  caption?: string
  detail?: string
  source?: string
  state: StationState
  lastKnownState?: StationState | null
  stale: boolean
  staleDays: number | null
  quality: 'ok' | 'sparse' | 'dark'
  value: number | null
  delta: number | null
  deltaWindow: string
  reference?: number | null
  lastObs: string | null
  observations: ObservationPoint[]
  trailing: TrailingPoint[]
  gaps: CoverageGap[]
  grammarVersion: string
}

export interface RegionalRead {
  subject: string
  headline: string
  body: string
  directions: 'aligned' | 'split' | 'flat' | 'none'
  liveStations?: number
  staleStations?: number
  grammarVersion: string
  stationStates: { key: string; label: string; state: StationState; stale: boolean; staleDays: number | null }[]
}

export interface Board {
  subject: string
  stations: Station[]
  read: RegionalRead
  feedAsOf: string | null
  grammarVersion: string
  descriptive: boolean
  coverage?: CoverageSummary
  viewing?: ViewingSummary
  source?: string
  days?: number
}

// Splitting on nulls is the whole point: each run renders as its own path so no
// stroke ever spans a window where the feed saw nothing.
export function segmentByGaps(points: TrailingPoint[]): { d: string; v: number }[][] {
  const runs: { d: string; v: number }[][] = []
  let current: { d: string; v: number }[] = []
  for (const p of points) {
    if (p.v === null || p.v === undefined) {
      if (current.length) runs.push(current)
      current = []
    } else {
      current.push({ d: p.d, v: p.v })
    }
  }
  if (current.length) runs.push(current)
  return runs
}

const RISING = new Set<StationState>(['rising', 'building', 'normalising'])
const FALLING = new Set<StationState>(['falling', 'drawing', 'diverging'])

export function stateDirection(state: StationState): 1 | -1 | 0 {
  if (RISING.has(state)) return 1
  if (FALLING.has(state)) return -1
  return 0
}

export function formatValue(value: number | null, unit: string): string {
  if (value === null || value === undefined) return 'no reading'
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2
  const text = value.toLocaleString(undefined, { maximumFractionDigits: digits })
  return unit.startsWith('/') || unit === '%' ? `${text}${unit}` : `${text} ${unit}`
}

export function formatDelta(delta: number | null, window: string): string | null {
  if (delta === null || delta === undefined) return null
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : ''
  const abs = Math.abs(delta)
  const digits = abs >= 10 ? 0 : 1
  return `${arrow}${abs.toLocaleString(undefined, { maximumFractionDigits: digits })} ${window}`
}

// Freshness is reported in whole days because every feed these boards read from
// publishes at best daily; an hours-precise "2h ago" would imply a resolution
// the underlying satellite pass or port report does not have.
export function freshnessLabel(staleDays: number | null): string {
  if (staleDays === null || staleDays === undefined) return 'no observation'
  if (staleDays <= 0) return 'today'
  if (staleDays === 1) return 'yesterday'
  if (staleDays < 7) return `${staleDays}d old`
  if (staleDays < 14) return 'over a week old'
  if (staleDays < 60) return `${Math.floor(staleDays / 7)}w old`
  return `${Math.floor(staleDays / 30)}mo old`
}

export function coverageSummary(station: Station): string {
  const gapDays = station.gaps.reduce((sum, g) => sum + g.days, 0)
  if (!gapDays) return 'no coverage gaps in window'
  const runs = station.gaps.length
  const base = `${gapDays}d across ${runs} coverage gap${runs === 1 ? '' : 's'} — nothing interpolated`
  const unexplained = station.gaps.filter(g => g.reason === 'unexplained').length
  return unexplained
    ? `${base}. ${unexplained} had a usable satellite pass, so the reading is missing rather than unobservable.`
    : base
}

export function gapTitle(gap: CoverageGap): string {
  const head = `Coverage gap ${gap.from} → ${gap.to} (${gap.days}d).`
  const why = gap.reason ? ` Cause: ${GAP_REASON_LABEL[gap.reason]}.` : ''
  return `${head}${why} ${gap.detail ?? ''} Nothing interpolated across it.`.trim()
}
