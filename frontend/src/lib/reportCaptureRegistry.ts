// Per-route capture registration. Tool pages call registerReportCapture with a
// getClip snapshot; the shell toolbar reads the active route's entry so every
// hub tool can offer "Send to Report" without each page owning its own button.

import type { ChartUnit, ClipDraft } from './reportCreator'

export type ReportCaptureEntry = {
  getClip: () => ClipDraft | ClipDraft[] | null
  disabled?: boolean
  sourceTab?: string
}

const entries = new Map<string, ReportCaptureEntry>()
const listeners = new Set<() => void>()

function emit() {
  listeners.forEach(fn => fn())
}

export function normalizeCapturePath(pathname: string, search = ''): string {
  const path = pathname || '/'
  // Prefer full path+query when tools use ?tab=, else bare path.
  if (search && search !== '?') {
    const full = path + (search.startsWith('?') ? search : `?${search}`)
    return full
  }
  return path
}

export function registerReportCapture(
  path: string,
  entry: ReportCaptureEntry,
): () => void {
  const key = path || '/'
  entries.set(key, entry)
  emit()
  return () => {
    if (entries.get(key) === entry) {
      entries.delete(key)
      emit()
    }
  }
}

export function getReportCapture(pathname: string, search = ''): ReportCaptureEntry | null {
  const full = normalizeCapturePath(pathname, search)
  if (entries.has(full)) return entries.get(full) ?? null
  // Fall back to path-only so ?tab= tools still resolve when registered bare.
  if (entries.has(pathname)) return entries.get(pathname) ?? null
  return null
}

export function subscribeReportCapture(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Helpers for building ClipDrafts without retyping boilerplate. */
export function kpiClip(
  sourceTab: string,
  title: string,
  cells: { label: string; value: string; sub?: string }[],
): ClipDraft {
  return { sourceTab, dataType: 'kpi', payload: { kind: 'kpi', title, cells } }
}

export function tableClip(
  sourceTab: string,
  title: string,
  columns: string[],
  rows: (string | number | null)[][],
): ClipDraft {
  return { sourceTab, dataType: 'table', payload: { kind: 'table', title, columns, rows } }
}

/** A Pattern Grammar board as a table clip that carries its own freshness.
 *
 * This is the point of the whole freshness chain: a board can be showing a
 * reading nobody has refreshed in six weeks, and a clip without provenance
 * enters the report as a bare figure the writer then states in the present
 * tense. Attaching the observation date lets it be written as history.
 */
export function boardClip(sourceTab: string, board: {
  subject: string
  feedAsOf?: string | null
  stations: {
    label: string; value: number | null; unit: string; state: string
    stale: boolean; staleDays: number | null; lastObs: string | null
    source?: string; gaps: unknown[]
  }[]
  read?: { body?: string }
  viewing?: { partialViewDays?: number } | null
}): ClipDraft {
  const rows = board.stations.map(s => [
    s.label,
    s.value == null ? '—' : `${s.value} ${s.unit}`.trim(),
    s.state,
    s.lastObs ?? 'unknown',
    s.stale ? `stale ${s.staleDays ?? '?'}d` : 'current',
  ])
  const oldest = board.stations.reduce<number | null>(
    (worst, s) => (s.staleDays != null && (worst == null || s.staleDays > worst) ? s.staleDays : worst), null)
  const heldOut = board.viewing?.partialViewDays ?? 0
  const gapCount = board.stations.reduce((n, s) => n + (s.gaps?.length ?? 0), 0)
  const coverage = [
    gapCount ? `${gapCount} coverage gap(s), nothing interpolated` : '',
    heldOut ? `${heldOut} obscured day(s) held out of the level series` : '',
  ].filter(Boolean).join('; ')

  return {
    sourceTab,
    dataType: 'table',
    payload: {
      kind: 'table',
      title: `${board.subject} — stations`,
      columns: ['Station', 'Reading', 'State', 'Observed', 'Freshness'],
      rows,
    },
    freshness: {
      lastObs: board.feedAsOf ?? null,
      staleDays: oldest,
      // The board is only as current as its least fresh station: a report that
      // reads the freshest one as the whole picture is the error being prevented.
      stale: board.stations.some(s => s.stale),
      source: board.stations[0]?.source ?? '',
      coverageNote: coverage,
    },
  }
}

export function textClip(sourceTab: string, title: string, body: string): ClipDraft {
  return { sourceTab, dataType: 'text', payload: { kind: 'text', title, body } }
}

export function chartClip(
  sourceTab: string,
  title: string,
  chartType: 'line' | 'bar' | 'area',
  xKey: string,
  data: Array<Record<string, string | number | null>>,
  series: Array<{ key: string; label: string; color?: string; unit?: ChartUnit }>,
  options?: {
    barOrientation?: 'vertical' | 'horizontal'
    xUnit?: ChartUnit
    details?: Array<{ key: string; label: string; unit?: ChartUnit }>
  },
): ClipDraft {
  const normalizedSeries = series.map(item => ({ ...item, unit: item.unit ?? 'number' as const }))
  const normalizedDetails = options?.details?.map(item => ({ ...item, unit: item.unit ?? 'number' as const }))
  return {
    sourceTab,
    dataType: 'chart',
    payload: { kind: 'chart', title, chartType, xKey, data, series: normalizedSeries, ...options, details: normalizedDetails },
  }
}
