import type { ReportClip } from './reportCreator'

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
