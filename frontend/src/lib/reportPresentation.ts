import type { ReportClip } from './reportCreator'

function meaningfulCell(value: string | number | null): boolean {
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'string') return false
  return !/^(?:|—|-|n\/a|na|none|null)$/i.test(value.trim())
}

function tableHasDecisionContent(clip: ReportClip): boolean {
  if (clip.payload.kind !== 'table' || clip.payload.rows.length === 0) return false
  const table = clip.payload
  const identityColumns = table.columns
    .map((column, index) => (
      /\b(?:ticker|symbol|company|name|date|type|event|holder|counterparty|sector|segment|category|driver|metric)\b/i.test(column)
        ? index
        : -1
    ))
    .filter(index => index >= 0)
  if (!identityColumns.length) {
    return table.rows.some(row => row.filter(meaningfulCell).length >= Math.min(2, table.columns.length))
  }
  const identifiedRows = table.rows.filter(row => (
    identityColumns.some(index => meaningfulCell(row[index] ?? null))
  )).length
  return identifiedRows >= Math.max(1, Math.ceil(table.rows.length * 0.25))
}

export function selectReportAppendixData(
  appendixClipIds: string[],
  clips: ReportClip[],
): ReportClip[] {
  const clipById = new Map(clips.map(clip => [clip.id, clip]))
  const seen = new Set<string>()
  const selected: ReportClip[] = []
  for (const id of appendixClipIds) {
    const clip = clipById.get(id)
    if (!clip || seen.has(id) || clip.payload.kind === 'chart') continue
    if (clip.payload.kind === 'table' && !tableHasDecisionContent(clip)) continue
    if (clip.payload.kind === 'kpi' && !clip.payload.cells.some(cell => meaningfulCell(cell.value))) continue
    if (
      clip.payload.kind === 'text'
      && /no structured panels|add a note describing/i.test(clip.payload.body)
    ) continue
    seen.add(id)
    selected.push(clip)
  }
  const rank = (clip: ReportClip) =>
    clip.payload.kind === 'kpi' ? 1 : clip.payload.kind === 'table' ? 2 : 3
  return selected.sort((a, b) => rank(a) - rank(b))
}
