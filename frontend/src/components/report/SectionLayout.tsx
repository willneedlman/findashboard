import ClipRenderer from './ClipRenderer'
import type { ReportClip, KeyFigure, ClipPayload } from '../../lib/reportCreator'
import { toTitleCase } from '../../lib/reportCreator'
import type { ReportPalette, ClipPalette } from '../../lib/reportTheme'
import { toClipPalette } from '../../lib/reportTheme'

// Research-note section layout. Charts lead when available; composition stays
// dense — full-width stack only (no side-by-side empty columns). Each chart
// appears at most once across body sections. Colors come from the active theme.

function rowChunks<T>(items: T[], preferCols: number): T[][] {
  const n = items.length
  if (n === 0) return []
  let cols = Math.min(Math.max(preferCols, 1), 4, n)
  if (n > cols && n % cols === 1 && cols > 2) cols -= 1
  const rows: T[][] = []
  for (let i = 0; i < n; i += cols) rows.push(items.slice(i, i + cols))
  return rows
}

export function FillGrid({
  items,
  preferCols = 4,
  render,
  palette,
}: {
  items: { key: string | number }[]
  preferCols?: number
  render: (item: { key: string | number }, i: number) => React.ReactNode
  palette: Pick<ReportPalette, 'border' | 'cellBg'>
}) {
  if (!items.length) return null
  const rows = rowChunks(items, preferCols)
  return (
    <div style={{ border: `1px solid ${palette.border}`, background: palette.cellBg }}>
      {rows.map((row, ri) => (
        <div
          key={ri}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))`,
            borderTop: ri === 0 ? 'none' : `1px solid ${palette.border}`,
          }}
        >
          {row.map((item, ci) => (
            <div
              key={item.key}
              style={{
                minWidth: 0,
                padding: '6px 10px',
                background: palette.cellBg,
                borderLeft: ci === 0 ? 'none' : `1px solid ${palette.border}`,
              }}
            >
              {render(item, ri * 10 + ci)}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function KeyFiguresStrip({
  figures,
  palette,
}: {
  figures: KeyFigure[]
  palette: ReportPalette
}) {
  if (!figures.length) return null
  const items = figures.map((f, i) => ({ key: i, ...f }))
  return (
    <FillGrid
      items={items}
      preferCols={Math.min(figures.length, 4)}
      palette={palette}
      render={(item) => {
        const f = item as { key: number; label: string; value: string }
        return (
          <>
            <div style={{
              fontFamily: palette.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', color: palette.muted, lineHeight: 1.2,
            }}>{toTitleCase(f.label)}</div>
            <div style={{
              fontFamily: palette.mono, fontSize: 12.5, fontWeight: 700, color: palette.ink, marginTop: 1,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{f.value}</div>
          </>
        )
      }}
    />
  )
}

function FigureFrame({
  title,
  children,
  palette,
}: {
  title?: string
  children: React.ReactNode
  palette: ReportPalette
}) {
  return (
    <figure style={{
      margin: 0,
      padding: 0,
      border: `1px solid ${palette.border}`,
      background: palette.cellBg,
      width: '100%',
    }}>
      {title && (
        <figcaption style={{
          fontFamily: palette.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em',
          textTransform: 'uppercase',
          padding: '5px 10px',
          borderBottom: `1px solid ${palette.border}`,
          background: palette.panel,
          color: palette.accent,
        }}>
          {toTitleCase(title)}
        </figcaption>
      )}
      <div style={{ padding: '6px 8px 8px', background: palette.cellBg }}>
        {children}
      </div>
    </figure>
  )
}

function slimTable(p: Extract<ClipPayload, { kind: 'table' }>, maxRows: number): ClipPayload {
  return { ...p, rows: p.rows.slice(0, maxRows) }
}

function chartTitle(c: ReportClip): string {
  if (c.payload.kind === 'chart' || c.payload.kind === 'kpi' || c.payload.kind === 'table' || c.payload.kind === 'text') {
    return c.payload.title || ''
  }
  return ''
}

/** Score how well a chart matches section heading/analysis for unique assignment. */
function scoreChartForHint(chart: ReportClip, hint: string): number {
  const title = chartTitle(chart).toLowerCase()
  const hay = `${title} ${chart.sourceTab} ${chart.dataType}`.toLowerCase()
  // A bare ticker (e.g. "NVDA") mentioned in the hint is not evidence this
  // specific chart is on-topic — in a multi-subject comparison report every
  // section names every subject, so every sibling chart for that subject
  // would otherwise "match" regardless of what it actually shows. Strip
  // ticker-looking tokens (all-caps runs in the ORIGINAL hint) before scoring.
  const tickerLike = new Set((hint.match(/\b[A-Z]{2,5}\b/g) || []).map(t => t.toLowerCase()))
  const tokens = hint
    .toLowerCase()
    .replace(/[^a-z0-9%$.+\- ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !tickerLike.has(w) && !/^(the|and|for|with|from|that|this|near|sets|shows|signals)$/.test(w))
  let score = 0
  for (const w of tokens) {
    if (title.includes(w)) score += w.length >= 5 ? 4 : 2
    else if (hay.includes(w)) score += 1
  }
  if (title.length >= 8) {
    const titleWords = title.split(/[^a-z0-9]+/).filter(w => w.length > 3 && !tickerLike.has(w))
    const phraseHits = titleWords.filter(w => hint.toLowerCase().includes(w)).length
    score += phraseHits * 3
  }
  return score
}

/**
 * Pick a chart (or other visual) for a section. Never reuses a chart id in
 * `usedChartIds`. Sibling charts from the same sourceTab compete by title match
 * against `sectionHint` (heading + analysis).
 */
export function preferChartVisual(
  sectionClip: ReportClip | undefined,
  projectClips: ReportClip[],
  usedChartIds?: Set<string>,
  sectionHint = '',
): { visual: ReportClip | undefined; showKeyFigures: boolean } {
  const used = usedChartIds ?? new Set<string>()
  if (!sectionClip) {
    return { visual: undefined, showKeyFigures: true }
  }

  const kind = sectionClip.payload.kind
  if (kind === 'chart' && !used.has(sectionClip.id)) {
    return { visual: sectionClip, showKeyFigures: false }
  }

  const siblings = projectClips.filter(
    c => c.id !== sectionClip.id
      && c.sourceTab === sectionClip.sourceTab
      && c.payload.kind === 'chart'
      && !used.has(c.id),
  )

  if (siblings.length > 0) {
    let best = siblings[0]
    let bestScore = scoreChartForHint(best, sectionHint)
    for (let i = 1; i < siblings.length; i++) {
      const s = scoreChartForHint(siblings[i], sectionHint)
      if (s > bestScore) {
        best = siblings[i]
        bestScore = s
      }
    }
    return { visual: best, showKeyFigures: true }
  }

  if (kind === 'chart' && used.has(sectionClip.id)) {
    return { visual: undefined, showKeyFigures: true }
  }
  if (kind === 'kpi') {
    return { visual: undefined, showKeyFigures: true }
  }
  if (kind === 'table') {
    return { visual: sectionClip, showKeyFigures: false }
  }
  return { visual: sectionClip, showKeyFigures: true }
}

/** Pre-assign unique body visuals so no chart appears twice across sections. */
export function assignBodyVisuals(
  sections: { clipId: string; heading?: string; analysis?: string }[],
  clipById: Map<string, ReportClip>,
  projectClips: ReportClip[],
): Map<string, { visual: ReportClip | undefined; showKeyFigures: boolean }> {
  const used = new Set<string>()
  const out = new Map<string, { visual: ReportClip | undefined; showKeyFigures: boolean }>()

  type Cand = { sectionId: string; chart: ReportClip; score: number; isOwn: boolean }
  const candidates: Cand[] = []

  for (const s of sections) {
    const clip = clipById.get(s.clipId)
    if (!clip) {
      out.set(s.clipId, { visual: undefined, showKeyFigures: true })
      continue
    }
    const hint = `${s.heading ?? ''} ${s.analysis ?? ''}`
    if (clip.payload.kind === 'chart') {
      candidates.push({
        sectionId: s.clipId,
        chart: clip,
        score: scoreChartForHint(clip, hint) + 50,
        isOwn: true,
      })
    }
    for (const c of projectClips) {
      if (c.id === clip.id) continue
      if (c.sourceTab !== clip.sourceTab || c.payload.kind !== 'chart') continue
      candidates.push({
        sectionId: s.clipId,
        chart: c,
        score: scoreChartForHint(c, hint),
        isOwn: false,
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score || (a.isOwn === b.isOwn ? 0 : a.isOwn ? -1 : 1))

  // A bare ticker-symbol mention (e.g. "NVDA" appearing anywhere in the
  // section's prose) alone scores 2 — trivially true in every section of a
  // multi-subject comparison report, so on its own it is not evidence the
  // chart is actually about this section's point. Require a real keyword
  // match (a 5+ letter content word, or several short ones) before a sibling
  // chart from another clip is allowed to stand in for this section.
  const SIBLING_MIN_SCORE = 6

  const assigned = new Map<string, ReportClip>()
  for (const cand of candidates) {
    if (assigned.has(cand.sectionId)) continue
    if (used.has(cand.chart.id)) continue
    if (!cand.isOwn && cand.score < SIBLING_MIN_SCORE) continue
    assigned.set(cand.sectionId, cand.chart)
    used.add(cand.chart.id)
  }

  // Fill any section whose own clip IS a chart but lost the slot to a
  // higher-scored competitor — never fall back to a weak/unrelated sibling
  // here; an unmatched section just renders as prose + KPI strip instead.
  for (const cand of candidates) {
    if (!cand.isOwn) continue
    if (assigned.has(cand.sectionId)) continue
    if (used.has(cand.chart.id)) continue
    assigned.set(cand.sectionId, cand.chart)
    used.add(cand.chart.id)
  }

  for (const s of sections) {
    if (out.has(s.clipId)) continue
    const clip = clipById.get(s.clipId)
    const chart = assigned.get(s.clipId)
    if (chart) {
      out.set(s.clipId, {
        visual: chart,
        showKeyFigures: !clip || clip.payload.kind !== 'chart' || chart.id !== clip.id,
      })
      continue
    }
    if (!clip) {
      out.set(s.clipId, { visual: undefined, showKeyFigures: true })
      continue
    }
    const kind = clip.payload.kind
    if (kind === 'table') {
      out.set(s.clipId, { visual: clip, showKeyFigures: false })
    } else if (kind === 'kpi' || kind === 'chart') {
      out.set(s.clipId, { visual: undefined, showKeyFigures: true })
    } else {
      out.set(s.clipId, { visual: clip, showKeyFigures: true })
    }
  }

  return out
}

function Visual({
  clip,
  compact,
  maxTableRows,
  clipPal,
  mono,
  muted,
}: {
  clip: ReportClip
  compact?: boolean
  maxTableRows?: number
  clipPal: ClipPalette
  mono: string
  muted: string
}) {
  const p = clip.payload
  if (p.kind === 'table') {
    const cap = maxTableRows ?? 6
    const slim = slimTable(p, cap)
    return (
      <>
        <ClipRenderer payload={slim} mode="print" maxTableRows={cap} compact={compact} palette={clipPal} />
        {p.rows.length > cap && (
          <div style={{ fontFamily: mono, fontSize: 8, color: muted, marginTop: 3 }}>
            Showing {cap} of {p.rows.length} rows.
          </div>
        )}
      </>
    )
  }
  return <ClipRenderer payload={p} mode="print" compact={compact} maxTableRows={maxTableRows} palette={clipPal} />
}

/**
 * Dense section body. Full-width prose then full-width chart — no side-by-side
 * columns that leave empty whitespace under short text.
 */
export default function SectionLayout({
  analysis,
  clip,
  keyFigures,
  index: _index = 0,
  projectClips = [],
  visual: visualOverride,
  showKeyFigures: showKeyFiguresOverride,
  palette,
}: {
  analysis?: string
  clip?: ReportClip
  keyFigures?: KeyFigure[]
  index?: number
  projectClips?: ReportClip[]
  visual?: ReportClip
  showKeyFigures?: boolean
  palette: ReportPalette
}) {
  const assigned = visualOverride !== undefined || showKeyFiguresOverride !== undefined
    ? { visual: visualOverride, showKeyFigures: showKeyFiguresOverride ?? true }
    : preferChartVisual(clip, projectClips, undefined, analysis ?? '')
  const visual = assigned.visual
  const showKeyFigures = assigned.showKeyFigures
  const figures = (keyFigures?.filter(f => f.label || f.value) ?? [])
    .slice(0, visual?.payload.kind === 'chart' ? 3 : 4)
  const isChart = visual?.payload.kind === 'chart'
  const hasVisual = !!visual && visual.payload.kind !== 'text'
  const textBody = analysis?.trim() || ''
  const clipPal = toClipPalette(palette)
  const prose: React.CSSProperties = {
    fontFamily: palette.sans, fontSize: 11.5, lineHeight: 1.45, color: palette.ink, margin: 0, whiteSpace: 'pre-wrap',
  }
  const textNode = textBody ? <div style={prose}>{textBody}</div> : null
  const figTitle = visual ? (visual.payload.title || visual.sourceTab) : undefined

  const stack: React.CSSProperties = {
    marginTop: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  }

  if (hasVisual && visual && isChart) {
    return (
      <div style={stack}>
        {textNode}
        <FigureFrame title={figTitle} palette={palette}>
          <Visual clip={visual} clipPal={clipPal} mono={palette.mono} muted={palette.muted} />
        </FigureFrame>
        {showKeyFigures && figures.length > 0 && <KeyFiguresStrip figures={figures} palette={palette} />}
      </div>
    )
  }

  if (hasVisual && visual && visual.payload.kind === 'table') {
    return (
      <div style={stack}>
        {textNode}
        {showKeyFigures && figures.length > 0 && <KeyFiguresStrip figures={figures} palette={palette} />}
        <FigureFrame title={figTitle} palette={palette}>
          <Visual clip={visual} maxTableRows={6} clipPal={clipPal} mono={palette.mono} muted={palette.muted} />
        </FigureFrame>
      </div>
    )
  }

  return (
    <div style={stack}>
      {textNode}
      {figures.length > 0 && <KeyFiguresStrip figures={figures} palette={palette} />}
      {clip?.payload.kind === 'text' && (
        <FigureFrame title={clip.payload.title || 'Note'} palette={palette}>
          <ClipRenderer payload={clip.payload} mode="print" palette={clipPal} />
        </FigureFrame>
      )}
    </div>
  )
}
