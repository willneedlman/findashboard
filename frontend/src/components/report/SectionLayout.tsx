import ClipRenderer from './ClipRenderer'
import type {
  ReportClip,
  KeyFigure,
  ClipPayload,
  GeneratedSection,
  ChartPayload,
  TablePayload,
  ReportSectionLayout,
  LayoutPreset,
  ChartUnit,
} from '../../lib/reportCreator'
import { toTitleCase } from '../../lib/reportCreator'
import { figureNotes, retitleToPlottedRange, formatReportCell } from '../../lib/reportFigures'
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

// Kept in step with the density veto in resolveReportSectionLayout: once a
// visual is dense, a layout outside this set is replaced by full-width. Any
// preset that wants to survive on real financial data has to land inside it.
const READABLE_WHEN_DENSE = new Set<ReportSectionLayout>([
  'metric-rail', 'metric-rail-left', 'evidence-band', 'analysis-first',
])

// The editorial rotation. Six entries rather than four so the cycle does not
// line up with a report's section count and repeat the same pairing every time.
const EDITORIAL_RHYTHM: ReportSectionLayout[] = [
  'analysis-first', 'evidence-band', 'metric-rail-left',
  'analysis-first', 'metric-rail', 'evidence-band',
]

export function normalizeReportSectionLayout(value: unknown): ReportSectionLayout | undefined {
  return typeof value === 'string' && REPORT_SECTION_LAYOUTS.has(value as ReportSectionLayout)
    ? value as ReportSectionLayout
    : undefined
}

export function applyReportLayoutPreset({
  preset,
  requested,
  visual,
  keyFigures,
  index = 0,
}: {
  preset?: LayoutPreset
  requested?: unknown
  visual?: ReportClip
  keyFigures?: KeyFigure[]
  index?: number
}): ReportSectionLayout | undefined {
  const normalized = normalizeReportSectionLayout(requested)
  if (!preset || !visual || visual.payload.kind === 'text') return normalized
  // A table stays full-width whatever the preset asks: five to seven columns at
  // 68% of the column is not readable, and that is the one veto worth keeping.
  if (visual.payload.kind === 'table') return 'full-width'
  const figureCount = keyFigures?.filter(figure => figure.label || figure.value).length ?? 0

  if (preset === 'editorial') {
    // Editorial used to return `normalized` unchanged, which is why it was the
    // one preset that changed nothing — and it is the default. The model's hint
    // is usually absent, and resolveReportSectionLayout replaces anything
    // outside READABLE_WHEN_DENSE with full-width as soon as a visual is dense.
    // Real financial visuals nearly always are: a time series has more than ten
    // points, a sector bar has a label longer than eighteen characters. So the
    // veto fired on every section and the whole report came out as prose,
    // figure, prose, figure — which is exactly what this preset promises not to
    // be ("one visual beside each argument").
    //
    // Honour a hint that will survive the veto; otherwise rotate, so
    // consecutive sections do not repeat one composition.
    if (normalized && (!visualIsDense(visual) || READABLE_WHEN_DENSE.has(normalized))) {
      return normalized
    }
    // The rail and the band both put figures beside the visual, so they need
    // figures to put there. With none, full-width is the honest composition.
    if (figureCount >= 2) return EDITORIAL_RHYTHM[index % EDITORIAL_RHYTHM.length]
    if (figureCount === 1) return index % 2 === 0 ? 'analysis-first' : 'evidence-band'
    return 'full-width'
  }

  if (preset === 'visual-first') return 'evidence-band'
  if (preset === 'narrative') return 'analysis-first'
  if (figureCount < 2) return 'evidence-band'
  return index % 2 === 0 ? 'metric-rail-left' : 'metric-rail'
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
  if (visualIsDense(visual)) {
    const preservesReadableChartWidth = visual?.payload.kind === 'chart'
      && normalized != null
      && ['metric-rail', 'metric-rail-left', 'evidence-band', 'analysis-first'].includes(normalized)
    if (!preservesReadableChartWidth) return 'full-width'
  }
  if ((normalized === 'wrap-left' || normalized === 'wrap-right') && !visualCanWrap(visual)) {
    return normalized === 'wrap-left' ? 'visual-left' : 'visual-right'
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
              // Reserve both lines whether the label wraps or not, so one long
              // label cannot drop its value off the row's baseline.
              minHeight: 19,
            }}>{toTitleCase(f.label)}</div>
            <div style={{
              fontFamily: palette.mono, fontSize: 12.5, fontWeight: 700, color: palette.ink, marginTop: 1,
              whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-word', lineHeight: '20px', minHeight: 20, paddingBottom: 6,
            }}>{formatReportCell(f.value, f.label)}</div>
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
      // Was 'stretch', which sized the panel to the figure beside it and left
      // a tall empty box under three key figures. The rail is as tall as what
      // it contains.
      alignSelf: 'start',
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
            {formatReportCell(figure.value, figure.label)}
          </div>
        </div>
      ))}
    </aside>
  )
}

function FigureFrame({
  title,
  source,
  notes,
  children,
  palette,
  style,
}: {
  title?: string
  source?: string
  notes?: string[]
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
      {(source || notes?.length) && (
        <div style={{
          padding: '0 8px 6px',
          fontFamily: palette.sans,
          fontSize: 7,
          lineHeight: 1.35,
          color: palette.muted,
        }}>
          {source && <div>Source: {source}</div>}
          {notes?.map(note => <div key={note}>{note}</div>)}
        </div>
      )}
    </figure>
  )
}

/** Ceiling for a body figure, high enough to hold a whole book of holdings. */
const MAX_FIGURE_TABLE_ROWS = 40

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

function chartUnitFromLabel(label: string): ChartUnit {
  if (/\bpp\b|percentage points?/i.test(label)) return 'percentage-point'
  if (/\bbps?\b|basis points?/i.test(label)) return 'basis-point'
  if (/\bcorrelation\b/i.test(label)) return 'correlation'
  if (/\bbeta\b|coefficient/i.test(label)) return 'beta'
  if (/\bindexed?\b|normalized/i.test(label)) return 'index'
  if (/\$|\busd\b|price|spot|strike|target|intrinsic|fair value|nav|per share|\/sh/i.test(label)) return 'currency'
  if (/\bp\/e\b|\bev\/ebitda\b|\bp\/s\b|\bp\/b\b|\bp\/fcf\b|\bpeg\b|multiple/i.test(label)) return 'multiple'
  if (/%|\bpct\b|\bpercent\b|volatility|margin|growth|upside|return|yield|rate|share|weight|allocation|premium|roe|roa/i.test(label)) return 'percent'
  return 'number'
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
          series: [{ key: 'momentum', label: 'Momentum score (pp)', unit: 'percentage-point' }],
          details: detailColumns
            .filter(detail => detail.index >= 0)
            .map(({ key, label }) => ({ key, label, unit: chartUnitFromLabel(label) })),
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

  // Two metrics over the same rows is a relationship, and a relationship reads
  // as a position, not as two bar lengths the eye has to pair up by row order.
  // A risk measure against a size measure is the case worth drawing: it shows
  // which positions carry beta the book is not paid for.
  const relationship = !isComposition ? tableRelationship(table, catIndex, numericColumns) : undefined
  if (relationship) return { ...relationship, title }

  // One metric spread over a whole book is a distribution. Ranking sixteen bars
  // answers "which is biggest"; a histogram answers "what does the book look
  // like", which is the question a portfolio section is actually asking.
  const distribution = !isComposition && data.length >= 10
    ? tableDistribution(data, metric.column, title)
    : undefined
  if (distribution) return distribution

  return {
    kind: 'chart',
    // Few categories read better as labelled points than as wide bars, which
    // carry area proportional to nothing at that count.
    chartType: isComposition ? 'pie' : data.length <= 3 ? 'dot' : 'bar',
    barOrientation: !isComposition && (data.length > 4 || data.some(row => row.category.length > 9))
      ? 'horizontal'
      : 'vertical',
    title,
    xKey: 'category',
    data,
    series: [{ key: 'value', label: humanLabel(metric.column), unit: chartUnitFromLabel(metric.column) }],
  }
}

const RISK_METRIC = /\b(beta|volatility|variance|idiosyncratic|drawdown|risk|correlation|sharpe)\b/i
const SIZE_METRIC = /\b(weight|allocation|share|value|position|exposure|size|market cap)\b/i

/** A scatter of risk against size when the table carries both over enough rows. */
function tableRelationship(
  table: TablePayload,
  catIndex: number,
  numericColumns: { column: string; index: number }[],
): ChartPayload | undefined {
  if (table.rows.length < 6) return undefined
  const size = numericColumns.find(metric => SIZE_METRIC.test(metric.column))
  const risk = numericColumns.find(metric => RISK_METRIC.test(metric.column) && metric.index !== size?.index)
  if (!size || !risk) return undefined
  const data = table.rows.flatMap(row => {
    const label = String(row[catIndex] ?? '').trim()
    const x = tableNumber(row[size.index])
    const y = tableNumber(row[risk.index])
    if (!label || x == null || y == null || /^total$/i.test(label)) return []
    return [{ [size.column]: x, value: y, label }]
  })
  if (data.length < 6) return undefined
  return {
    kind: 'chart',
    chartType: 'scatter',
    title: '',
    xKey: size.column,
    xUnit: chartUnitFromLabel(size.column),
    data,
    series: [{ key: 'value', label: humanLabel(risk.column), unit: chartUnitFromLabel(risk.column) }],
  }
}

/** Bucket one metric across the book so its shape, not its ranking, is visible. */
function tableDistribution(
  data: { category: string; value: number }[],
  column: string,
  title: string,
): ChartPayload | undefined {
  const values = data.map(row => row.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (!(max > min)) return undefined
  const bucketCount = Math.min(6, Math.max(4, Math.round(Math.sqrt(data.length))))
  const width = (max - min) / bucketCount
  const unit = chartUnitFromLabel(column)
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const low = min + width * index
    return {
      bucket: `${low.toFixed(low >= 100 ? 0 : 1)}–${(low + width).toFixed(low >= 100 ? 0 : 1)}`,
      value: 0,
    }
  })
  for (const value of values) {
    const index = Math.min(bucketCount - 1, Math.floor((value - min) / width))
    buckets[index].value += 1
  }
  return {
    kind: 'chart',
    chartType: 'histogram',
    title: `${title} · Distribution`,
    xKey: 'bucket',
    data: buckets,
    series: [{ key: 'value', label: `Holdings per ${humanLabel(column)} band`, unit: 'number' }],
    details: [{ key: 'value', label: 'Holdings', unit: unit === 'number' ? 'number' : 'number' }],
  }
}

function figureUnit(value: string): ChartUnit {
  if (/\bpp\b|percentage points?/i.test(value)) return 'percentage-point'
  if (/\bbps?\b|basis points?/i.test(value)) return 'basis-point'
  if (/%/.test(value)) return 'percent'
  if (/\$|\busd\b/i.test(value)) return 'currency'
  if (/[×x]\b/i.test(value)) return 'multiple'
  return 'number'
}

function figureUnitLabel(unit: ChartUnit): string {
  if (unit === 'percent') return 'Percent (%)'
  if (unit === 'percentage-point') return 'Percentage points (pp)'
  if (unit === 'currency') return 'Value (USD)'
  if (unit === 'multiple') return 'Multiple (×)'
  if (unit === 'basis-point') return 'Basis points (bps)'
  return 'Value'
}

/** Split "Revenue growth (NVDA)" or "NVDA P/E" into what is measured and who it
 *  is measured on. Returns no subject when the label names only a metric. */
export function splitFigureLabel(label: string): { metric: string; subject?: string } {
  const parenthesised = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(label.trim())
  if (parenthesised) {
    return { metric: parenthesised[1].trim(), subject: parenthesised[2].trim() }
  }
  const leadingTicker = /^([A-Z][A-Z0-9.\-]{0,5}|Peer median|Sector median|Median)\s+(.{2,})$/.exec(label.trim())
  if (leadingTicker) {
    return { metric: leadingTicker[2].trim(), subject: leadingTicker[1].trim() }
  }
  return { metric: label.trim() }
}

export function promoteKeyFiguresToChart(
  figures: KeyFigure[] | undefined,
  heading: string,
): ChartPayload | undefined {
  const candidates = (figures ?? []).flatMap((figure) => {
    if (!figure.label || !figure.value || /\bvs\.?\b|[–—]\s*\$?\d/i.test(figure.value)) return []
    const value = tableNumber(figure.value)
    if (value == null) return []
    const { metric, subject } = splitFigureLabel(figure.label)
    return [{ metric: humanLabel(metric), subject, value, unit: figureUnit(figure.value) }]
  })
  // Group by what is measured, not by the unit it happens to share. Grouping on
  // unit put a P/E of 34.5x and an EV/EBITDA of 32.7x side by side as two bars
  // on one axis, which compares nothing: they are different quantities that
  // both end in "x". A chart earns its place by putting ONE measure across
  // several subjects.
  const groups = new Map<string, typeof candidates>()
  for (const candidate of candidates) {
    if (!candidate.subject) continue
    const key = candidate.metric.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), candidate])
  }
  const best = [...groups.values()]
    .map(group => group.filter((item, i, all) =>
      all.findIndex(other => other.subject === item.subject) === i))
    .sort((a, b) => b.length - a.length)[0]
  // Two bars restate the strip printed beside them. Three or more is a spread
  // the reader can see at a glance and cannot get from the numbers alone.
  if (!best || best.length < 3) return undefined
  const measure = best[0].metric
  const selected = best.slice(0, 6).map(item => ({ ...item, metric: item.subject as string }))
  const unit = selected[0].unit
  const sum = selected.reduce((total, item) => total + item.value, 0)
  // The composition test reads the MEASURE, not the subject names the axis now
  // carries: whether these percentages are shares of one whole is a fact about
  // what is being measured.
  const composition = unit === 'percent'
    && selected.length <= 8
    && selected.every(item => item.value >= 0)
    && sum >= 85
    && sum <= 115
    && /\b(share|weight|allocation|mix|composition)\b/i.test(measure)
  return {
    kind: 'chart',
    chartType: composition ? 'pie' : 'bar',
    barOrientation: composition ? 'vertical' : 'horizontal',
    // Name the comparison. "Relative Call · Key Figures" described where the
    // chart sat, not what it showed, and the same title appeared three times.
    title: `${measure} by name`,
    xKey: 'metric',
    data: selected.map(item => ({ metric: item.metric, value: item.value })),
    series: [{ key: 'value', label: figureUnitLabel(unit), unit }],
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

export type ReportVisualFamily =
  | 'allocation'
  | 'performance'
  | 'drawdown'
  | 'risk'
  | 'correlation'
  | 'factor'
  | 'scenario'
  | 'distribution'
  | 'valuation'
  | 'catalyst'
  | 'macro'
  | 'benchmark'
  | 'issuer'
  | 'other'

export function reportVisualFamily(clip: ReportClip): ReportVisualFamily {
  const title = chartTitle(clip).toLowerCase()
  const source = `${clip.researchSourceId ?? ''} ${clip.researchKey ?? ''}`.toLowerCase()
  const hay = `${title} ${source}`
  if (/correlation|covariance/.test(hay)) return 'correlation'
  if (/factor|coefficient|alpha|beta|regression/.test(hay)) return 'factor'
  if (/drawdown|underwater/.test(hay)) return 'drawdown'
  if (/scenario|shock|stress|tail loss|liquidation/.test(hay)) return 'scenario'
  if (/distribution|monte carlo|percentile|histogram|probability/.test(hay)) return 'distribution'
  if (/allocation|weight|concentration|sector exposure|risk share/.test(hay)) return 'allocation'
  if (/volatility|var\b|cvar\b|sharpe|sortino|risk metrics|risk contribution/.test(hay)) return 'risk'
  if (/performance|return|cagr|growth of|wealth|p&l/.test(hay)) return 'performance'
  if (/valuation|dcf|multiple|fair value|peer/.test(hay)) return 'valuation'
  if (/earnings|event|calendar|catalyst|news/.test(hay)) return 'catalyst'
  if (/macro|rates?|fed|credit|yield curve|sentiment|global market/.test(hay)) return 'macro'
  if (/benchmark|active return|vs spy|relative performance|market compare/.test(hay)) return 'benchmark'
  if (clip.evidenceDomain === 'issuer') return 'issuer'
  return 'other'
}

/** Sections whose claim is about the book, not about any one name in it. */
const PORTFOLIO_LEVEL_FAMILIES = new Set<ReportVisualFamily>([
  'allocation', 'performance', 'drawdown', 'risk', 'correlation', 'factor', 'scenario', 'benchmark',
])

/**
 * A visual that is one holding's own series rather than the book's. One of
 * these filled the "Return and Drawdown" section of a portfolio review with a
 * 3.5% position's price chart, while the portfolio's own curve appeared nowhere
 * in the document.
 */
function isSingleIssuerVisual(clip: ReportClip): boolean {
  if (clip.evidenceDomain === 'issuer') return true
  if (clip.payload.kind === 'text') return false
  const title = (clip.payload.title || '').trim()
  if (/\b(portfolio|book|active return|allocation|benchmark|factor|peer|correlation matrix|holding-level)\b/i.test(title)) {
    return false
  }
  return /^[A-Z][A-Z0-9.\-]{1,5}\b/.test(title)
}

function portfolioFamilyRelevance(family: ReportVisualFamily, hint: string): number {
  const normalized = hint.toLowerCase()
  const terms: Record<ReportVisualFamily, RegExp> = {
    allocation: /allocation|weight|concentration|exposure|position|sizing|diversif|composition/,
    performance: /performance|return|cagr|happened|track record|wealth|outcome/,
    drawdown: /drawdown|loss|downside|stress|risk|underwater/,
    risk: /risk|volatility|var|cvar|sharpe|sortino|beta|downside|stability/,
    correlation: /correlation|diversif|co-move|relationship|dependenc/,
    factor: /factor|driver|explain|why|beta|alpha|market sensitivity/,
    scenario: /scenario|stress|shock|downside|upside|could happen|tail|liquidat/,
    distribution: /distribution|probability|odds|percentile|monte carlo|range|uncertainty/,
    valuation: /valuation|value|multiple|dcf|upside|downside|price target/,
    catalyst: /earnings|catalyst|event|outlook|next|forward|news/,
    macro: /macro|rate|fed|credit|economic|outlook|next|forward/,
    benchmark: /benchmark|active|relative|spy|market|performance|return/,
    issuer: /issuer|company|holding|position|security|stock/,
    other: /evidence|data|gap|limitation/,
  }
  return terms[family].test(normalized) ? 28 : 0
}

function assignPortfolioVisuals(
  sections: GeneratedSection[],
  assigned: Map<string, { visual: ReportClip | undefined; showKeyFigures: boolean }>,
  projectClips: ReportClip[],
  objective: string,
  domainCoveragePct?: Partial<Record<NonNullable<ReportClip['evidenceDomain']>, number>>,
): void {
  const generated = sections.flatMap((_, index) => {
    const visual = assigned.get(reportSectionAssignmentKey(sections, index))?.visual
    return visual ? [visual] : []
  })
  const pool = [...new Map([...projectClips, ...generated]
    .filter(clip => clip.payload.kind === 'chart' || clip.payload.kind === 'table')
    .map(clip => [clip.id, clip])).values()]
  const usedIds = new Set<string>()
  const usedSignatures = new Set<string>()
  const familyCounts = new Map<ReportVisualFamily, number>()
  const chartTypeCounts = new Map<string, number>()

  for (const [index, section] of sections.entries()) {
    const assignmentKey = reportSectionAssignmentKey(sections, index)
    const hint = `${section.templateSection ?? ''} ${section.heading} ${section.analysis} ${objective}`
    const candidates = pool.flatMap(clip => {
      const signature = chartSignature(clip)
      if (usedIds.has(clip.id) || usedSignatures.has(signature)) return []
      const family = reportVisualFamily(clip)
      const familyScore = portfolioFamilyRelevance(family, hint)
      const domainScore = clip.evidenceDomain === 'portfolio'
        ? 12
        : clip.evidenceDomain === 'benchmark'
          ? 8
          : clip.evidenceDomain === 'macro' && /outlook|next|forward|macro|rate|credit/i.test(hint)
            ? 8
            : clip.evidenceDomain === 'issuer' && /issuer|holding|position|earnings|catalyst|valuation/i.test(hint)
              ? 4
              : 0
      const coverageScore = clip.evidenceDomain
        ? ((domainCoveragePct?.[clip.evidenceDomain] ?? 100) / 10) - 10
        : 0
      const diversityScore = (familyCounts.get(family) ?? 0) === 0 ? 18 : -22 * (familyCounts.get(family) ?? 0)
      const chartType = clip.payload.kind === 'chart' ? clip.payload.chartType : 'table'
      const typePenalty = -5 * (chartTypeCounts.get(chartType) ?? 0)
      const relevance = scoreChartForHint(clip, hint) + familyScore + domainScore
      return relevance > 4 ? [{ clip, family, chartType, score: relevance + coverageScore + diversityScore + typePenalty }] : []
    }).sort((a, b) => b.score - a.score)

    // A book-level claim gets book-level evidence whenever any exists. A single
    // name's own chart only stands in when the section has nothing else at all.
    const bookLevel = candidates.filter(candidate => (
      !PORTFOLIO_LEVEL_FAMILIES.has(candidate.family) || !isSingleIssuerVisual(candidate.clip)
    ))
    const selected = (bookLevel.length ? bookLevel : candidates)[0]
    if (!selected) {
      assigned.set(assignmentKey, { visual: undefined, showKeyFigures: true })
      continue
    }
    usedIds.add(selected.clip.id)
    usedSignatures.add(chartSignature(selected.clip))
    familyCounts.set(selected.family, (familyCounts.get(selected.family) ?? 0) + 1)
    chartTypeCounts.set(selected.chartType, (chartTypeCounts.get(selected.chartType) ?? 0) + 1)
    assigned.set(assignmentKey, {
      visual: selected.clip,
      showKeyFigures: selected.clip.payload.kind !== 'table' && !isOwnKeyFigureChart(selected.clip),
    })
  }
}

/** A chart the pipeline built out of a section's own key figures. Plotting it
 * beside a rail of the same three numbers prints each one twice. */
function isOwnKeyFigureChart(clip: ReportClip): boolean {
  // Identified by how it was made, not by how it is titled. The title now
  // names the comparison ("P/E by name"), which is what the reader needs and
  // what a title-sniffing test cannot rely on.
  return clip.id.startsWith('key-figure-chart:')
}

function researchTarget(clip: ReportClip): string {
  return clip.researchKey?.split(':')[1]?.toUpperCase() ?? ''
}

/** Score how well a chart matches section heading/analysis for unique assignment. */
function hintMatch(chart: ReportClip, hint: string): { score: number; titleHits: number } {
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
  // Distinct hint words found in the TITLE, counted separately from the score.
  // One shared word is not evidence a chart is on topic: "Market-implied Fed
  // Funds path" and "market value and momentum factor betas" share "market"
  // and nothing else, which was enough to print the former inside the latter.
  const titleSeen = new Set<string>()
  for (const w of tokens) {
    if (title.includes(w)) {
      score += w.length >= 5 ? 4 : 2
      titleSeen.add(w)
    } else if (hay.includes(w)) score += 1
  }
  if (title.length >= 8) {
    const titleWords = title.split(/[^a-z0-9]+/).filter(w => w.length > 3 && !tickerLike.has(w))
    const phraseHits = titleWords.filter(w => hint.toLowerCase().includes(w)).length
    score += phraseHits * 3
  }
  return { score, titleHits: titleSeen.size }
}

function scoreChartForHint(chart: ReportClip, hint: string): number {
  return hintMatch(chart, hint).score
}

/** Whether a chart is related enough to stand in for one the section did not
 *  pick. Two distinct title words, or one overwhelming score, because a single
 *  common word matches almost anything. */
function chartFitsSection(chart: ReportClip, hint: string): boolean {
  const { score, titleHits } = hintMatch(chart, hint)
  return titleHits >= 2 || score >= 8
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
    // A sibling was substituted whatever it scored, so a section whose own clip
    // had no chart got the first chart from the same source tab even when
    // nothing about it matched. Observed: a "Market-implied Fed Funds path"
    // chart printed inside "Correlation and Factor Risk", whose prose is
    // entirely about market, value and momentum betas. Below the floor the
    // honest answer is no figure — the key figures still carry the section.
    if (chartFitsSection(best, sectionHint)) {
      return { visual: best, showKeyFigures: true }
    }
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
  meta: {
    projectId: string
    generatedAt: string
    objective?: string
    domainCoveragePct?: Partial<Record<NonNullable<ReportClip['evidenceDomain']>, number>>
  },
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
      // Tagged so the rail beside it knows the chart came from those very
      // figures. Only the other promotion site set this prefix, so a chart
      // promoted here printed every number twice, once as a bar and once as a
      // cell in the strip next to it.
      id: chart === figureChart ? `key-figure-chart:${assignmentKey}` : `site-chart:${assignmentKey}`,
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

  const portfolioReport = projectClips.some(clip => clip.evidenceDomain === 'portfolio')
    || (projectClips.some(clip => /\bcurrent allocation\b/i.test(clip.payload.title || ''))
      && projectClips.some(clip => /\brisk metrics\b/i.test(clip.payload.title || '')))
  if (portfolioReport) {
    assignPortfolioVisuals(sections, assigned, projectClips, meta.objective ?? '', meta.domainCoveragePct)
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
    // The data appendix used to reprint every table in full, so a body figure
    // could show six rows and defer the rest. There is no appendix now, so a
    // truncated figure is data the reader never sees anywhere. Show it all.
    const cap = maxTableRows ?? MAX_FIGURE_TABLE_ROWS
    const slim = slimTable(p, cap)
    return (
      <>
        <ClipRenderer payload={slim} mode="print" maxTableRows={cap} compact={compact} inline={inline} palette={clipPal} />
        {p.rows.length > cap && (
          <div style={{ fontFamily: mono, fontSize: 8, color: muted, marginTop: 3 }}>
            Showing the first {cap} of {p.rows.length} rows, ranked as sourced.
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
  layoutPreset,
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
  layoutPreset?: LayoutPreset
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
    requested: applyReportLayoutPreset({
      preset: layoutPreset,
      requested: layout,
      visual,
      keyFigures: showKeyFigures ? figures : [],
      index,
    }),
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
  // A caption that promises 2026-01-01 to 2026-08-09 over a series that starts
  // in March is a false claim about coverage, so the window is restated from
  // the points the figure actually plots.
  const figTitle = visual
    ? (visual.payload.kind === 'chart'
        ? retitleToPlottedRange(visual.payload.title || visual.sourceTab, visual.payload)
        : (visual.payload.title || visual.sourceTab))
    : undefined
  const numberedFigTitle = figTitle
    ? `${figureNumber ? `Figure ${figureNumber} · ` : ''}${figTitle}`
    : undefined
  const figureSource = visual
    ? (visual.sourceTab === 'AlphaTape' && clip?.sourceTab
        ? `${clip.sourceTab} · AlphaTape analysis`
        : visual.sourceTab)
    : undefined
  const figureNoteList = visual ? figureNotes(visual, projectClips) : []

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
      <FigureFrame title={numberedFigTitle} source={figureSource} notes={figureNoteList} palette={palette}>
        <Visual
          clip={visual}
          compact
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
        <FigureFrame title={numberedFigTitle} source={figureSource} notes={figureNoteList} palette={palette}>
          <Visual
            clip={visual}
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
            notes={figureNoteList}
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
        <FigureFrame title={numberedFigTitle} source={figureSource} notes={figureNoteList} palette={palette}>
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
        alignItems: 'start',
      }}>
        <FigureFrame title={numberedFigTitle} source={figureSource} notes={figureNoteList} palette={palette}>
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
    <FigureFrame title={numberedFigTitle} source={figureSource} notes={figureNoteList} palette={palette}>
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
