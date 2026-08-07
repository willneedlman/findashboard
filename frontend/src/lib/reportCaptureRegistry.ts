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
