import ClipRenderer from './ClipRenderer'
import type {
  ReportClip,
  KeyFigure,
  ClipPayload,
  GeneratedSection,
  ChartPayload,
  TablePayload,
  ReportSectionLayout,
} from '../../lib/reportCreator'
import { toTitleCase } from '../../lib/reportCreator'
import type { ReportPalette, ClipPalette } from '../../lib/reportTheme'
import { toClipPalette } from '../../lib/reportTheme'

// Research-note section layout. The AI supplies an editorial composition hint;
// this renderer validates it against the evidence actually assigned to the
// section, so creative direction cannot make a dense chart unreadable.

const REPORT_SECTION_LAYOUTS = new Set<ReportSectionLayout>([
  'full-width',
  'visual-left',
  'visual-right',
  'wrap-left',
  'wrap-right',
  'metric-rail',
  'metric-rail-left',
  'evidence-band',
  'analysis-first',
])

export function normalizeReportSectionLayout(value: unknown): ReportSectionLayout | undefined {
  return typeof value === 'string' && REPORT_SECTION_LAYOUTS.has(value as ReportSectionLayout)
    ? value as ReportSectionLayout
    : undefined
}

function visualIsDense(visual?: ReportClip): boolean {
  if (!visual) return false
  const payload = visual.payload
  if (payload.kind === 'table') return true
  if (payload.kind !== 'chart') return false
  if (payload.chartType === 'box' || payload.chartType === 'range' || payload.chartType === 'scatter') return true
  if (payload.data.length > 7 || payload.series.length > 3) return true
  if (payload.chartType === 'bar' && payload.data.some(row => String(row[payload.xKey] ?? '').length > 18)) return true
  return payload.chartType === 'line' && payload.data.length > 10
}

function visualCanWrap(visual?: ReportClip): boolean {
  if (!visual || visual.payload.kind !== 'chart') return false
  const payload = visual.payload
  if (payload.data.length > 6 || payload.series.length > 2) return false
  return payload.chartType === 'pie'
    || payload.chartType === 'bar'
    || payload.chartType === 'dot'
    || payload.chartType === 'histogram'
}

export function resolveReportSectionLayout({
  requested,
  visual,
  analysis,
  keyFigures,
  index = 0,
}: {
  requested?: unknown
  visual?: ReportClip
  analysis?: string
  keyFigures?: KeyFigure[]
  index?: number
}): ReportSectionLayout {
  const normalized = normalizeReportSectionLayout(requested)
  const hasVisual = !!visual && visual.payload.kind !== 'text'
  const figureCount = keyFigures?.filter(figure => figure.label || figure.value).length ?? 0
  const wordCount = (analysis ?? '').trim().split(/\s+/).filter(Boolean).length

  if (!hasVisual) return figureCount >= 2 ? 'metric-rail' : 'full-width'
  if (normalized === 'full-width') return 'full-width'
  if (visualIsDense(visual)) return 'full-width'
  if ((normalized === 'wrap-left' || normalized === 'wrap-right') && !visualCanWrap(visual)) {
    return normalized === 'wrap-left' ? 'visual-left' : 'visual-right'
  }
  if (
    (normalized === 'metric-rail'
      || normalized === 'metric-rail-left'
      || normalized === 'evidence-band'
      || normalized === 'analysis-first')
    && figureCount < 2
  ) {
    return index % 2 === 0 ? 'visual-left' : 'visual-right'
  }
  if (
    (normalized === 'visual-left' || normalized === 'visual-right')
    && visualCanWrap(visual)
    && wordCount >= 48
  ) {
    return normalized === 'visual-left' ? 'wrap-left' : 'wrap-right'
  }
  if (normalized) return normalized

  if (visualCanWrap(visual) && wordCount >= 45) return index % 2 === 0 ? 'wrap-left' : 'wrap-right'
  if (figureCount >= 3 && wordCount >= 32) {
    return index % 3 === 0 ? 'evidence-band' : index % 2 === 0 ? 'metric-rail-left' : 'metric-rail'
  }
  return index % 2 === 0 ? 'visual-left' : 'visual-right'
}

function rowChunks<T>(items: T[], preferCols: number): T[][] {
  const n = items.length
  if (n === 0) return []
  let cols = Math.min(Math.max(preferCols, 1), 5, n)
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
    <div className="rc-keep" style={{ border: `1px solid ${palette.border}`, background: palette.cellBg }}>
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
              whiteSpace: 'nowrap', overflow: 'visible', lineHeight: '20px', minHeight: 20, paddingBottom: 6,
            }}>{f.value}</div>
          </>
        )
      }}
    />
  )
}

function KeyFiguresRail({
  figures,
  palette,
}: {
  figures: KeyFigure[]
  palette: ReportPalette
}) {
  if (!figures.length) return null
  return (
    <aside className="rc-keep" style={{
      border: `1px solid ${palette.border}`,
      background: palette.cellBg,
      alignSelf: 'stretch',
    }}>
      {figures.map((figure, index) => (
        <div key={`${figure.label}-${index}`} style={{
          padding: '8px 10px',
          borderTop: index ? `1px solid ${palette.border}` : 'none',
        }}>
          <div style={{
            fontFamily: palette.sans,
            fontSize: 7.5,
            fontWeight: 700,
            letterSpacing: '0.12em',
            lineHeight: 1.25,
            textTransform: 'uppercase',
            color: palette.muted,
          }}>
            {toTitleCase(figure.label)}
          </div>
          <div style={{
            marginTop: 2,
            fontFamily: palette.mono,
            fontSize: 13,
            fontWeight: 700,
            lineHeight: 1.2,
            color: palette.ink,
          }}>
            {figure.value}
          </div>
        </div>
      ))}
    </aside>
  )
}

function FigureFrame({
  title,
  source,
  children,
  palette,
  style,
}: {
  title?: string
  source?: string
  children: React.ReactNode
  palette: ReportPalette
  style?: React.CSSProperties
}) {
  return (
    <figure className="rc-keep rc-atomic rc-figure" style={{
      margin: 0,
      padding: 0,
      border: `1px solid ${palette.border}`,
      background: palette.cellBg,
      width: '100%',
      boxSizing: 'border-box',
      ...style,
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
      {source && (
        <div style={{
          padding: '0 8px 6px',
          fontFamily: palette.sans,
          fontSize: 7,
          lineHeight: 1.35,
          color: palette.muted,
        }}>
          Source: {source}
        </div>
      )}
    </figure>
  )
}

function slimTable(p: Extract<ClipPayload, { kind: 'table' }>, maxRows: number): ClipPayload {
  return { ...p, rows: p.rows.slice(0, maxRows) }
}

function tableNumber(value: string | number | null): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const source = value.trim()
  if (!source || /^(?:n\/a|na|none|—|-)$/i.test(source)) return undefined
  const negative = /^\(.*\)$/.test(source) || /^[−-]/.test(source)
  const normalized = source
    .replace(/[(),$%×x]/gi, '')
    .replace(/\b(?:bps?|usd)\b/gi, '')
    .replace(/[−-]/g, '')
    .replace(/^\+/, '')
    .trim()
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return undefined
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? (negative ? -parsed : parsed) : undefined
}

function humanLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
    .trim()
}

function tableMetricScore(column: string, title: string): number {
  const label = column.toLowerCase()
  const titleWords = new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 3))
  let score = 0
  if (/\b(share|weight|allocation|upside|return|growth|margin|price|value|target|yield|rate|multiple|ratio|exposure)\b/.test(label)) score += 8
  if (/[%$×]|\b(p\/e|ev\/ebitda|p\/s|p\/b|p\/fcf|bps?)\b/.test(label)) score += 5
  if ([...titleWords].some(word => label.includes(word))) score += 5
  if (/\b(rank|id|year|date|analysts?|count|volume)\b/.test(label)) score -= 4
  return score
}

/**
 * Turn a compact categorical table into a decision-grade report visual. The
 * conversion is intentionally conservative: feeds, prose-heavy tables, and
 * mixed-unit boards remain tables, while rankings and composition data become
 * labeled bars or a pie.
 */
export function promoteTableToChart(table: TablePayload): ChartPayload | undefined {
  if (table.rows.length < 2 || table.rows.length > 14 || table.columns.length < 2) return undefined
  if (
    /\b(earnings|event)\s+(?:schedule|calendar)\b/i.test(table.title || '')
    || table.columns.some(column => /\b(date|datetime|fiscal period|days until)\b/i.test(column))
  ) return undefined

  const sectorLeadership = /\bsector (?:leadership|rotation)\b/i.test(table.title || '')
  if (sectorLeadership) {
    const tickerIndex = table.columns.findIndex(column => /^(ticker|symbol)$/i.test(column.trim()))
    const sectorIndex = table.columns.findIndex(column => /^sector$/i.test(column.trim()))
    const momentumIndex = table.columns.findIndex(column => /^momentum(?: score)?$/i.test(column.trim()))
    if (tickerIndex >= 0 && sectorIndex >= 0 && momentumIndex >= 0) {
      const detailColumns = [
        { key: 'oneWeek', label: '1W return %', pattern: /^1w\s*%?$/i },
        { key: 'oneMonth', label: '1M return %', pattern: /^1m\s*%?$/i },
        { key: 'threeMonth', label: '3M return %', pattern: /^3m\s*%?$/i },
        { key: 'vsSpyOneMonth', label: 'Vs SPY · 1M %', pattern: /^vs\s+spy\s+1m$/i },
      ].map(detail => ({
        ...detail,
        index: table.columns.findIndex(column => detail.pattern.test(column.trim())),
      }))
      const data = table.rows.flatMap(row => {
        const ticker = row[tickerIndex]
        const sector = row[sectorIndex]
        const momentum = tableNumber(row[momentumIndex])
        if (ticker == null || sector == null || momentum == null) return []
        return [{
          sector: `${String(sector)} · ${String(ticker)}`,
          momentum,
          ...Object.fromEntries(detailColumns.flatMap(detail => {
            const value = detail.index >= 0 ? tableNumber(row[detail.index]) : undefined
            return value == null ? [] : [[detail.key, value]]
          })),
        }]
      }).sort((a, b) => b.momentum - a.momentum)
      if (data.length >= 2) {
        return {
          kind: 'chart',
          chartType: 'bar',
          barOrientation: 'horizontal',
          title: `${table.title} · Momentum ranking`,
          xKey: 'sector',
          data,
          series: [{ key: 'momentum', label: 'Momentum score (pp)' }],
          details: detailColumns
            .filter(detail => detail.index >= 0)
            .map(({ key, label }) => ({ key, label })),
        }
      }
    }
  }

  const categoryPriority = /\b(ticker|symbol|company|name|segment|sector|region|category|driver|metric|maturity|instrument)\b/i
  const categoryIndex = table.columns.findIndex(column => categoryPriority.test(column))
  const catIndex = categoryIndex >= 0 ? categoryIndex : table.columns.findIndex((_, index) => (
    table.rows.filter(row => typeof row[index] === 'string' && tableNumber(row[index]) == null).length >= table.rows.length * 0.7
  ))
  if (catIndex < 0) return undefined

  const numericColumns = table.columns
    .map((column, index) => {
      if (index === catIndex) return undefined
      const values = table.rows.map(row => tableNumber(row[index]))
      const valid = values.filter((value): value is number => value != null)
      if (valid.length < Math.max(2, Math.ceil(table.rows.length * 0.7))) return undefined
      return {
        column,
        index,
        values,
        score: tableMetricScore(column, table.title || ''),
      }
    })
    .filter((metric): metric is NonNullable<typeof metric> => !!metric)
    .sort((a, b) => b.score - a.score || a.index - b.index)

  if (!numericColumns.length) return undefined
  const compositionMetric = numericColumns.find(metric => /\b(share|weight|allocation|mix|composition)\b|%/i.test(metric.column))
  const metric = compositionMetric ?? numericColumns[0]
  const data = table.rows.flatMap((row) => {
    const category = row[catIndex]
    const value = tableNumber(row[metric.index])
    if (category == null || value == null || /^total$/i.test(String(category).trim())) return []
    return [{ category: String(category), value }]
  })
  if (data.length < 2) return undefined

  const sum = data.reduce((total, row) => total + row.value, 0)
  const isComposition = !!compositionMetric
    && data.every(row => row.value >= 0)
    && sum >= 85
    && sum <= 115
    && data.length <= 9
  const title = table.title
    ? `${table.title}${table.title.toLowerCase().includes(metric.column.toLowerCase()) ? '' : ` · ${humanLabel(metric.column)}`}`
    : humanLabel(metric.column)

  return {
    kind: 'chart',
    chartType: isComposition ? 'pie' : 'bar',
    barOrientation: !isComposition && (data.length > 4 || data.some(row => row.category.length > 9))
      ? 'horizontal'
      : 'vertical',
    title,
    xKey: 'category',
    data,
    series: [{ key: 'value', label: humanLabel(metric.column) }],
  }
}

function figureUnit(value: string): 'pct' | 'price' | 'multiple' | 'bps' | 'number' {
  if (/\bbps?\b|basis points?/i.test(value)) return 'bps'
  if (/%/.test(value)) return 'pct'
  if (/\$|\busd\b/i.test(value)) return 'price'
  if (/[×x]\b/i.test(value)) return 'multiple'
  return 'number'
}

function figureUnitLabel(unit: ReturnType<typeof figureUnit>): string {
  if (unit === 'pct') return 'Percent (%)'
  if (unit === 'price') return 'Value (USD)'
  if (unit === 'multiple') return 'Multiple (×)'
  if (unit === 'bps') return 'Basis points (bps)'
  return 'Value'
}

export function promoteKeyFiguresToChart(
  figures: KeyFigure[] | undefined,
  heading: string,
): ChartPayload | undefined {
  const candidates = (figures ?? []).flatMap((figure) => {
    if (!figure.label || !figure.value || /\bvs\.?\b|[–—]\s*\$?\d/i.test(figure.value)) return []
    const value = tableNumber(figure.value)
    if (value == null) return []
    return [{ metric: humanLabel(figure.label), value, unit: figureUnit(figure.value) }]
  })
  const groups = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    groups.set(candidate.unit, [...(groups.get(candidate.unit) ?? []), candidate])
  }
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0]
  if (!best || best.length < 2) return undefined
  const selected = best.slice(0, 6)
  const unit = selected[0].unit
  const sum = selected.reduce((total, item) => total + item.value, 0)
  const composition = unit === 'pct'
    && selected.length <= 8
    && selected.every(item => item.value >= 0)
    && sum >= 85
    && sum <= 115
    && selected.some(item => /\b(share|weight|allocation|mix|composition)\b/i.test(item.metric))
  return {
    kind: 'chart',
    chartType: composition ? 'pie' : 'bar',
    barOrientation: composition ? 'vertical' : 'horizontal',
    title: `${heading} · Key Figures`,
    xKey: 'metric',
    data: selected.map(item => ({ metric: item.metric, value: item.value })),
    series: [{ key: 'value', label: figureUnitLabel(unit) }],
  }
}

function chartTitle(c: ReportClip): string {
  if (c.payload.kind === 'chart' || c.payload.kind === 'kpi' || c.payload.kind === 'table' || c.payload.kind === 'text') {
    return c.payload.title || ''
  }
  return ''
}

function chartSignature(clip: ReportClip): string {
  if (clip.payload.kind !== 'chart') return clip.id
  const payload = clip.payload
  const categories = payload.data.map(row => String(row[payload.xKey] ?? '')).join('|')
  const series = payload.series.map(item => item.key).sort().join('|')
  return `${payload.chartType}:${(payload.title || '').toLowerCase()}:${payload.xKey}:${categories}:${series}`
}

function researchTarget(clip: ReportClip): string {
  return clip.researchKey?.split(':')[1]?.toUpperCase() ?? ''
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
  const usedSignatures = new Set<string>()
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
      const sectionTarget = researchTarget(clip)
      const chartTarget = researchTarget(c)
      const sameResearchOutput = !!sectionTarget && chartTarget === sectionTarget
      const targetMismatch = !!sectionTarget && !!chartTarget && chartTarget !== sectionTarget
      candidates.push({
        sectionId: s.clipId,
        chart: c,
        score: scoreChartForHint(c, hint) + (sameResearchOutput ? 12 : 0) - (targetMismatch ? 16 : 0),
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
    if (usedSignatures.has(chartSignature(cand.chart))) continue
    if (!cand.isOwn && cand.score < SIBLING_MIN_SCORE) continue
    assigned.set(cand.sectionId, cand.chart)
    used.add(cand.chart.id)
    usedSignatures.add(chartSignature(cand.chart))
  }

  // Fill any section whose own clip IS a chart but lost the slot to a
  // higher-scored competitor — never fall back to a weak/unrelated sibling
  // here; an unmatched section just renders as prose + KPI strip instead.
  for (const cand of candidates) {
    if (!cand.isOwn) continue
    if (assigned.has(cand.sectionId)) continue
    if (used.has(cand.chart.id)) continue
    if (usedSignatures.has(chartSignature(cand.chart))) continue
    assigned.set(cand.sectionId, cand.chart)
    used.add(cand.chart.id)
    usedSignatures.add(chartSignature(cand.chart))
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

export function assignReportBodyVisuals(
  sections: GeneratedSection[],
  clipById: Map<string, ReportClip>,
  projectClips: ReportClip[],
  meta: { projectId: string; generatedAt: string },
): Map<string, { visual: ReportClip | undefined; showKeyFigures: boolean }> {
  const rejectedVisuals = new Set<string>()
  const keyedSections = sections.map((section, index) => ({
    ...section,
    clipId: reportSectionAssignmentKey(sections, index),
  }))
  const keyedClipById = new Map(keyedSections.flatMap((section, index) => {
    const clip = clipById.get(sections[index].clipId)
    return clip ? [[section.clipId, clip] as const] : []
  }))
  const assigned = assignBodyVisuals(keyedSections, keyedClipById, projectClips)
  for (const [index, section] of sections.entries()) {
    const assignmentKey = reportSectionAssignmentKey(sections, index)
    const sourceVisual = assigned.get(assignmentKey)?.visual
    const sectionClip = clipById.get(section.clipId)
    if (sourceVisual?.payload.kind === 'chart' && /rolling correlation\s*·/i.test(sourceVisual.payload.title || '')) {
      const pair = (sourceVisual.payload.title || '').split('·').pop()?.match(/[A-Z][A-Z0-9.-]{0,9}/g) ?? []
      const sectionText = `${section.heading} ${section.analysis}`.toUpperCase()
      if (pair.length >= 2 && !pair.slice(0, 2).every(ticker => sectionText.includes(ticker))) {
        assigned.set(assignmentKey, { visual: undefined, showKeyFigures: true })
        rejectedVisuals.add(assignmentKey)
        continue
      }
    }
    const isOwnNativeChart = sourceVisual?.payload.kind === 'chart' && sourceVisual.id === sectionClip?.id
    if (isOwnNativeChart) continue
    const tableChart = sourceVisual?.payload.kind === 'table' ? promoteTableToChart(sourceVisual.payload) : undefined
    const figureChart = !section.chart && !tableChart && sourceVisual?.payload.kind !== 'chart'
      ? promoteKeyFiguresToChart(section.keyFigures, section.heading)
      : undefined
    const chart = section.chart ?? tableChart ?? figureChart
    if (!chart) continue
    const generatedVisual: ReportClip = {
      id: `site-chart:${assignmentKey}`,
      sourceTab: 'AlphaTape',
      capturedAt: meta.generatedAt,
      dataType: 'chart',
      payload: chart,
      projectId: meta.projectId,
    }
    if (sourceVisual?.payload.kind === 'chart' && section.chart) {
      const hint = `${section.heading} ${section.analysis}`
      if (scoreChartForHint(sourceVisual, hint) >= scoreChartForHint(generatedVisual, hint)) continue
    }
    assigned.set(assignmentKey, {
      visual: generatedVisual,
      showKeyFigures: !figureChart,
    })
  }

  const portfolioReport = projectClips.some(clip => (
    /\bcurrent allocation\b/i.test(clip.payload.title || '')
    && /portfolio manager|active book/i.test(clip.sourceTab)
  ))
    && projectClips.some(clip => /\brisk metrics\b/i.test(clip.payload.title || ''))
  if (portfolioReport) {
    const findVisual = (pattern: RegExp, kind?: ClipPayload['kind']) => projectClips.find(clip => (
      (!kind || clip.payload.kind === kind) && pattern.test(clip.payload.title || '')
    ))
    for (const [index, section] of sections.entries()) {
      const assignmentKey = reportSectionAssignmentKey(sections, index)
      const heading = section.heading.toLowerCase()
      let visual: ReportClip | undefined
      let showKeyFigures = false
      if (heading.includes('what happened')) {
        visual = projectClips.find(clip => (
          clip.payload.kind === 'chart'
          && clip.researchSourceId === 'portfolio-risk'
          && /:performance$/i.test(clip.researchKey || '')
        )) ?? projectClips.find(clip => clip.payload.kind === 'chart'
          && /\bvs SPY\b/i.test(clip.payload.title || '')
          && !/\b(active return|drawdown)\b/i.test(clip.payload.title || ''))
        showKeyFigures = true
      } else if (heading.includes('why it happened')) {
        visual = projectClips.find(clip => (
          clip.payload.kind === 'chart'
          && clip.researchSourceId === 'factor-decomposition'
          && /:rolling-market$/i.test(clip.researchKey || '')
        )) ?? findVisual(/rolling .*market coefficient/i, 'chart')
          ?? findVisual(/holding-level beta and portfolio risk contribution/i, 'table')
        showKeyFigures = true
      } else if (heading.includes('what could happen next')) {
        visual = findVisual(/upcoming portfolio earnings schedule/i, 'table')
          ?? findVisual(/market-shock scenario losses/i, 'table')
      } else if (heading.includes('what action follows')) {
        visual = findVisual(/proposed allocation|trade impact|before and after/i, 'table')
        if (!visual) rejectedVisuals.add(assignmentKey)
      }
      assigned.set(assignmentKey, { visual, showKeyFigures })
    }
  }

  const chartGroups = new Map<string, Array<{ section: GeneratedSection; visual: ReportClip }>>()
  for (const [index, section] of sections.entries()) {
    const visual = assigned.get(reportSectionAssignmentKey(sections, index))?.visual
    if (!visual || visual.payload.kind !== 'chart') continue
    const signature = chartSignature(visual)
    chartGroups.set(signature, [...(chartGroups.get(signature) ?? []), { section, visual }])
  }
  for (const duplicates of chartGroups.values()) {
    if (duplicates.length < 2) continue
    const ranked = [...duplicates].sort((a, b) => (
      scoreChartForHint(b.visual, `${b.section.heading} ${b.section.analysis}`)
      - scoreChartForHint(a.visual, `${a.section.heading} ${a.section.analysis}`)
    ))
    for (const duplicate of ranked.slice(1)) {
      const duplicateIndex = sections.indexOf(duplicate.section)
      assigned.set(reportSectionAssignmentKey(sections, duplicateIndex), { visual: undefined, showKeyFigures: true })
    }
  }
  for (const [index, section] of sections.entries()) {
    const assignmentKey = reportSectionAssignmentKey(sections, index)
    if (rejectedVisuals.has(assignmentKey)) continue
    if (assigned.get(assignmentKey)?.visual) continue
    const fallback = promoteKeyFiguresToChart(section.keyFigures, section.heading)
    if (!fallback) continue
    assigned.set(assignmentKey, {
      visual: {
        id: `key-figure-chart:${assignmentKey}`,
        sourceTab: 'AlphaTape',
        capturedAt: meta.generatedAt,
        dataType: 'chart',
        payload: fallback,
        projectId: meta.projectId,
      },
      showKeyFigures: false,
    })
  }
  return assigned
}

export function reportSectionAssignmentKey(sections: GeneratedSection[], index: number): string {
  const clipId = sections[index]?.clipId ?? ''
  return sections.filter(section => section.clipId === clipId).length > 1
    ? `${clipId}::${index}`
    : clipId
}

function Visual({
  clip,
  compact,
  inline,
  maxTableRows,
  clipPal,
  mono,
  muted,
}: {
  clip: ReportClip
  compact?: boolean
  inline?: boolean
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
        <ClipRenderer payload={slim} mode="print" maxTableRows={cap} compact={compact} inline={inline} palette={clipPal} />
        {p.rows.length > cap && (
          <div style={{ fontFamily: mono, fontSize: 8, color: muted, marginTop: 3 }}>
            Showing {cap} of {p.rows.length} rows.
          </div>
        )}
      </>
    )
  }
  return <ClipRenderer payload={p} mode="print" compact={compact} inline={inline} maxTableRows={maxTableRows} palette={clipPal} />
}

export default function SectionLayout({
  analysis,
  clip,
  keyFigures,
  index = 0,
  layout,
  projectClips = [],
  visual: visualOverride,
  showKeyFigures: showKeyFiguresOverride,
  column = false,
  figureNumber,
  palette,
}: {
  analysis?: string
  clip?: ReportClip
  keyFigures?: KeyFigure[]
  index?: number
  layout?: ReportSectionLayout
  projectClips?: ReportClip[]
  visual?: ReportClip
  showKeyFigures?: boolean
  column?: boolean
  figureNumber?: number
  palette: ReportPalette
}) {
  const assigned = visualOverride !== undefined || showKeyFiguresOverride !== undefined
    ? { visual: visualOverride, showKeyFigures: showKeyFiguresOverride ?? true }
    : preferChartVisual(clip, projectClips, undefined, analysis ?? '')
  const visual = assigned.visual
  const showKeyFigures = assigned.showKeyFigures
  const figures = (keyFigures?.filter(f => f.label || f.value) ?? [])
    .slice(0, visual?.payload.kind === 'chart' ? 6 : 4)
  const isChart = visual?.payload.kind === 'chart'
  const hasVisual = !!visual && visual.payload.kind !== 'text'
  const textBody = analysis?.trim() || ''
  const resolvedLayout = resolveReportSectionLayout({
    requested: layout,
    visual,
    analysis: textBody,
    keyFigures: showKeyFigures ? figures : [],
    index,
  })
  const clipPal = toClipPalette(palette)
  const prose: React.CSSProperties = {
    fontFamily: palette.sans, fontSize: 11.5, lineHeight: 1.45, color: palette.ink, margin: 0, whiteSpace: 'pre-wrap',
  }
  const textNode = textBody ? <div className="rc-section-prose" style={prose}>{textBody}</div> : null
  const figTitle = visual ? (visual.payload.title || visual.sourceTab) : undefined
  const numberedFigTitle = figTitle
    ? `${figureNumber ? `Figure ${figureNumber} · ` : ''}${figTitle}`
    : undefined
  const figureSource = visual
    ? (visual.sourceTab === 'AlphaTape' && clip?.sourceTab
        ? `${clip.sourceTab} · AlphaTape analysis`
        : visual.sourceTab)
    : undefined

  const stack: React.CSSProperties = {
    marginTop: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  }

  if (!hasVisual) {
    if (column) {
      return (
        <div style={stack}>
          {textNode}
          {figures.length > 0 && <KeyFiguresStrip figures={figures} palette={palette} />}
          {clip?.payload.kind === 'text' && !textBody && (
            <FigureFrame title={clip.payload.title || 'Note'} source={clip.sourceTab} palette={palette}>
              <ClipRenderer payload={clip.payload} mode="print" palette={clipPal} />
            </FigureFrame>
          )}
        </div>
      )
    }
    return (
      <div style={stack}>
        {(resolvedLayout === 'metric-rail' || resolvedLayout === 'metric-rail-left') && textNode && figures.length > 0 ? (
          <div style={{
            display: 'grid',
            gridTemplateColumns: resolvedLayout === 'metric-rail-left'
              ? 'minmax(132px, 0.32fr) minmax(0, 1fr)'
              : 'minmax(0, 1fr) minmax(132px, 0.32fr)',
            gap: 10,
            alignItems: 'start',
          }}>
            {resolvedLayout === 'metric-rail-left' && <KeyFiguresRail figures={figures} palette={palette} />}
            {textNode}
            {resolvedLayout === 'metric-rail' && <KeyFiguresRail figures={figures} palette={palette} />}
          </div>
        ) : (
          <>
            {textNode}
            {figures.length > 0 && <KeyFiguresStrip figures={figures} palette={palette} />}
          </>
        )}
        {clip?.payload.kind === 'text' && !textBody && (
          <FigureFrame title={clip.payload.title || 'Note'} source={clip.sourceTab} palette={palette}>
            <ClipRenderer payload={clip.payload} mode="print" palette={clipPal} />
          </FigureFrame>
        )}
      </div>
    )
  }

  if (!visual) return null

  if (column) {
    const visualFirst = resolvedLayout === 'visual-left'
      || resolvedLayout === 'wrap-left'
      || resolvedLayout === 'evidence-band'
    const visualNode = (
      <FigureFrame title={numberedFigTitle} source={figureSource} palette={palette}>
        <Visual
          clip={visual}
          compact
          maxTableRows={visual.payload.kind === 'table' ? 5 : undefined}
          clipPal={clipPal}
          mono={palette.mono}
          muted={palette.muted}
        />
      </FigureFrame>
    )
    const figuresNode = showKeyFigures && figures.length > 0
      ? <KeyFiguresStrip figures={figures} palette={palette} />
      : null
    return (
      <div style={stack}>
        {visualFirst && visualNode}
        {textNode}
        {!visualFirst && visualNode}
        {figuresNode}
      </div>
    )
  }

  if (resolvedLayout === 'full-width') {
    return (
      <div style={stack}>
        {textNode}
        <FigureFrame title={numberedFigTitle} source={figureSource} palette={palette}>
          <Visual
            clip={visual}
            maxTableRows={visual.payload.kind === 'table' ? 6 : undefined}
            clipPal={clipPal}
            mono={palette.mono}
            muted={palette.muted}
          />
        </FigureFrame>
        {showKeyFigures && figures.length > 0 && <KeyFiguresStrip figures={figures} palette={palette} />}
      </div>
    )
  }

  if (resolvedLayout === 'wrap-left' || resolvedLayout === 'wrap-right') {
    const floatSide = resolvedLayout === 'wrap-left' ? 'left' : 'right'
    return (
      <div style={stack}>
        <div style={{ display: 'flow-root' }}>
          <FigureFrame
            title={numberedFigTitle}
            source={figureSource}
            palette={palette}
            style={{
              float: floatSide,
              width: '42%',
              margin: floatSide === 'left' ? '0 12px 5px 0' : '0 0 5px 12px',
            }}
          >
            <Visual clip={visual} compact inline clipPal={clipPal} mono={palette.mono} muted={palette.muted} />
          </FigureFrame>
          {textNode}
        </div>
        {showKeyFigures && figures.length > 0 && <KeyFiguresStrip figures={figures} palette={palette} />}
      </div>
    )
  }

  if (resolvedLayout === 'metric-rail' || resolvedLayout === 'metric-rail-left') {
    const railFirst = resolvedLayout === 'metric-rail-left'
    const main = (
      <div style={stack}>
        {textNode}
        <FigureFrame title={numberedFigTitle} source={figureSource} palette={palette}>
          <Visual clip={visual} compact clipPal={clipPal} mono={palette.mono} muted={palette.muted} />
        </FigureFrame>
      </div>
    )
    const rail = showKeyFigures && figures.length > 0
      ? <KeyFiguresRail figures={figures} palette={palette} />
      : null
    return (
      <div style={{
        display: 'grid',
        gridTemplateColumns: railFirst
          ? 'minmax(132px, 0.32fr) minmax(0, 1fr)'
          : 'minmax(0, 1fr) minmax(132px, 0.32fr)',
        gap: 10,
        alignItems: 'start',
      }}>
        {railFirst ? rail : main}
        {railFirst ? main : rail}
      </div>
    )
  }

  if (resolvedLayout === 'evidence-band' || resolvedLayout === 'analysis-first') {
    const evidence = (
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 0.68fr) minmax(132px, 0.32fr)',
        gap: 10,
        alignItems: 'stretch',
      }}>
        <FigureFrame title={numberedFigTitle} source={figureSource} palette={palette}>
          <Visual clip={visual} compact clipPal={clipPal} mono={palette.mono} muted={palette.muted} />
        </FigureFrame>
        <KeyFiguresRail figures={figures} palette={palette} />
      </div>
    )
    return (
      <div style={stack}>
        {resolvedLayout === 'analysis-first' && textNode}
        {evidence}
        {resolvedLayout === 'evidence-band' && textNode}
      </div>
    )
  }

  const visualFirst = resolvedLayout === 'visual-left'
  const visualNode = (
    <FigureFrame title={numberedFigTitle} source={figureSource} palette={palette}>
      <Visual clip={visual} compact={isChart} clipPal={clipPal} mono={palette.mono} muted={palette.muted} />
    </FigureFrame>
  )
  const narrativeNode = (
    <div style={stack}>
      {textNode}
      {showKeyFigures && figures.length > 0 && <KeyFiguresStrip figures={figures} palette={palette} />}
    </div>
  )
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: visualFirst ? 'minmax(0, 0.46fr) minmax(0, 0.54fr)' : 'minmax(0, 0.54fr) minmax(0, 0.46fr)',
      gap: 12,
      alignItems: 'start',
    }}>
      {visualFirst ? visualNode : narrativeNode}
      {visualFirst ? narrativeNode : visualNode}
    </div>
  )
}
