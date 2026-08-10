import type { ReportClip, TablePayload, ChartPayload } from './reportCreator'

// Deterministic presentation rules for report figures. The writer model is a
// free tier and cannot be trusted to format a number, state a weight basis, or
// notice that a peer chart is not the book — so none of that is asked of it.
// Everything here is derived from the clip data at render time.

const DECIMALS: [RegExp, number][] = [
  [/\bt[- ]?stat(?:istic)?\b/i, 2],
  [/\bbeta\b|\bcoefficient\b/i, 2],
  [/\bcorrelation\b/i, 2],
  [/\bsharpe\b|\bsortino\b/i, 2],
  [/\b(?:weight|share|allocation|exposure|upside|return|drawdown|volatility|margin|yield|growth)\b|%/i, 1],
  [/\bprice\b|\bvalue\b|\bintrinsic\b|\btarget\b|\$/i, 2],
]

/** Column-driven decimal precision, so one quantity reads the same everywhere. */
export function columnDecimals(column: string, allColumns: string[] = []): number | undefined {
  for (const [pattern, decimals] of DECIMALS) {
    if (pattern.test(column)) return decimals
  }
  // A correlation matrix labels its columns with bare tickers; the precision
  // belongs to the table, not to any one column header.
  if (allColumns.some(other => /\bcorrelation\b/i.test(other))) return 2
  return undefined
}

const NUMERIC_CELL = /^([+\-−]?)\s*(\$?)([\d,]+(?:\.\d+)?)\s*(%|×|x|bps|pp)?$/i

/**
 * Re-format a numeric cell to its column's precision, preserving sign, currency
 * and unit. Non-numeric cells (labels, prose, dates) pass through untouched.
 */
export function formatReportCell(
  value: string | number | null,
  column: string,
  allColumns: string[] = [],
): string {
  if (value == null) return '—'
  const decimals = columnDecimals(column, allColumns)
  const raw = String(value).trim()
  if (decimals == null || !raw) return raw
  // ISO dates and fiscal periods are numeric-looking but are not measurements.
  if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(raw)) return raw
  const match = NUMERIC_CELL.exec(raw)
  if (!match) return raw
  const [, sign, currency, digits, unit] = match
  const parsed = Number(digits.replace(/,/g, ''))
  if (!Number.isFinite(parsed)) return raw
  const negative = sign === '-' || sign === '−'
  const body = parsed.toFixed(decimals)
  return `${negative ? '−' : sign === '+' ? '+' : ''}${currency}${body}${unit ?? ''}`
}

/** Trim false precision out of prose and definition cells ("3.740%" → "3.74%"). */
export function tidyNumbersInText(text: string): string {
  return text.replace(/(\d+)\.(\d{3,})(?=\s*%)/g, (whole, intPart: string, decimals: string) => {
    const trimmed = Number(`${intPart}.${decimals}`).toFixed(2)
    return trimmed.endsWith('0') ? String(Number(trimmed)) : trimmed
  })
}

function columnIndex(columns: string[], pattern: RegExp): number {
  return columns.findIndex(column => pattern.test(column))
}

function cellNumber(value: string | number | null): number | undefined {
  if (value == null) return undefined
  const match = /-?\d+(?:\.\d+)?/.exec(String(value).replace(/,/g, ''))
  if (!match) return undefined
  const parsed = Number(match[0])
  return Number.isFinite(parsed) ? parsed : undefined
}

export function tableTickers(table: TablePayload): string[] {
  const index = columnIndex(table.columns, /^(?:ticker|symbol|holding|portfolio holding)$/i)
  if (index < 0) return []
  return table.rows
    .map(row => String(row[index] ?? '').trim().toUpperCase())
    .filter(Boolean)
}

/**
 * Weight columns in this product come from two different bases: allocation
 * tables include the cash line, risk tables are struck on invested value only.
 * The report quoted both without saying so, which is how one book showed a
 * 13.31% and a 14.3% top position. State the basis on the figure itself.
 */
export function weightBasisNote(table: TablePayload): string | undefined {
  const weight = columnIndex(table.columns, /weight|allocation/i)
  if (weight < 0) return undefined
  const values = table.rows.map(row => cellNumber(row[weight])).filter((v): v is number => v != null)
  if (values.length < 2) return undefined
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total < 80 || total > 120) return undefined
  const hasCash = tableTickers(table).includes('CASH')
    || table.rows.some(row => row.some(cell => /^cash$/i.test(String(cell ?? '').trim())))
  return hasCash
    ? 'Weights are a percent of total portfolio value, cash included.'
    : 'Weights are a percent of invested value, cash excluded.'
}

/** Name the holdings a matrix or ranking silently leaves out. */
export function coverageNote(shown: string[], universe: string[]): string | undefined {
  if (!shown.length || !universe.length) return undefined
  const present = new Set(shown.map(ticker => ticker.toUpperCase()))
  const missing = universe
    .map(ticker => ticker.toUpperCase())
    .filter(ticker => ticker !== 'CASH' && !present.has(ticker))
  if (!missing.length) return undefined
  const named = missing.slice(0, 6).join(', ')
  return `Excludes ${missing.length} holding${missing.length === 1 ? '' : 's'}: ${named}${missing.length > 6 ? ', and others' : ''}.`
}

/**
 * A chart whose categories are mostly not in the book is peer evidence, not
 * portfolio evidence. Saying so on the figure stops it reading as a holdings
 * chart, which is how a semis peer set ended up illustrating a portfolio claim.
 */
export function peerSetNote(chart: ChartPayload, holdings: string[]): string | undefined {
  if (!holdings.length) return undefined
  const categories = chart.data
    .map(row => String(row[chart.xKey] ?? '').trim().toUpperCase())
    .filter(value => /^[A-Z][A-Z0-9.\-]{0,5}$/.test(value))
  if (categories.length < 3) return undefined
  const book = new Set(holdings.map(ticker => ticker.toUpperCase()))
  const overlap = categories.filter(category => book.has(category)).length
  if (overlap / categories.length >= 0.5) return undefined
  const outside = categories.length - overlap
  return `Peer set, not portfolio holdings: ${outside} of ${categories.length} names are not held.`
}

const ISO_RANGE = /(\d{4}-\d{2}-\d{2})\s*(?:to|–|—|-)\s*(\d{4}-\d{2}-\d{2})/

function isoFromX(value: unknown): string | undefined {
  const raw = String(value ?? '').trim()
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw)
  return match ? match[1] : undefined
}

/**
 * A caption promising 2026-01-01 to 2026-08-09 above a series that starts in
 * March is a false claim about coverage. Restate the caption from the data the
 * figure actually plots.
 */
export function retitleToPlottedRange(title: string, chart: ChartPayload): string {
  if (!ISO_RANGE.test(title)) return title
  const stamps = chart.data
    .map(row => isoFromX(row[chart.xKey]))
    .filter((value): value is string => !!value)
    .sort()
  if (stamps.length < 2) return title
  return title.replace(ISO_RANGE, `${stamps[0]} to ${stamps[stamps.length - 1]}`)
}

/** Every holding ticker the report knows about, from the allocation clip. */
export function portfolioHoldings(clips: ReportClip[]): string[] {
  const allocation = clips.find(clip => (
    clip.payload.kind === 'table' && /\bcurrent allocation\b/i.test(clip.payload.title || '')
  ))
  if (!allocation || allocation.payload.kind !== 'table') return []
  return tableTickers(allocation.payload).filter(ticker => ticker !== 'CASH')
}

/** Notes that belong under a figure, derived from the figure and the book. */
export function figureNotes(clip: ReportClip, clips: ReportClip[]): string[] {
  const notes: string[] = []
  const holdings = portfolioHoldings(clips)
  if (clip.payload.kind === 'table') {
    const table = clip.payload
    const basis = weightBasisNote(table)
    if (basis) notes.push(basis)
    if (/\bcorrelation matrix\b/i.test(table.title || '')) {
      const shown = table.columns.slice(1).map(column => column.trim().toUpperCase())
      const coverage = coverageNote(shown, holdings)
      if (coverage) notes.push(coverage)
    } else if (/\bbeta\b|\brisk contribution\b/i.test(table.title || '')) {
      const coverage = coverageNote(tableTickers(table), holdings)
      if (coverage) notes.push(coverage)
    }
  }
  if (clip.payload.kind === 'chart') {
    const peer = peerSetNote(clip.payload, holdings)
    if (peer) notes.push(peer)
  }
  return notes
}

/**
 * Identity of a stated metric, so the same one cannot be printed as a KPI three
 * times under three wordings ("Maximum drawdown", "Max drawdown (portfolio)",
 * "Historical max drawdown" were all -25.8% in one report). Qualifiers are
 * stripped; the measured value has to match too, so the benchmark's own
 * drawdown still stands as a separate figure.
 */
export function normalizeFigureKey(label: string, value: string): string {
  const metric = String(label)
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\b(?:portfolio|historical|maximum|max|static|observed|total|full[- ]sample|the|of|vs|versus|book)\b/g, ' ')
    .replace(/[^a-z]+/g, '')
  const amount = String(value).toLowerCase().replace(/[^a-z0-9.+-]/g, '')
  return `${metric}|${amount}`
}

/**
 * A rounded axis ceiling just above the data. Recharts' own "nice" ceiling put
 * an 8.00 top on a 4.20 max and flattened every bar into the lower half.
 */
export function niceAxisMax(values: number[]): number | undefined {
  const finite = values.filter(value => Number.isFinite(value) && value > 0)
  if (!finite.length) return undefined
  const max = Math.max(...finite)
  const magnitude = 10 ** Math.floor(Math.log10(max))
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]) {
    const candidate = step * magnitude
    if (candidate >= max) return Number(candidate.toFixed(6))
  }
  return Number((10 * magnitude).toFixed(6))
}

/**
 * A bar axis that always contains zero. A chart of three negative upsides drew
 * its axis from -175% to -35%, so every bar started at the right edge and its
 * length measured the distance from -175 rather than from nothing.
 */
export function niceBarDomain(values: number[]): [number, number] | undefined {
  const finite = values.filter(value => Number.isFinite(value))
  if (!finite.length) return undefined
  const max = Math.max(...finite, 0)
  const min = Math.min(...finite, 0)
  const top = max > 0 ? (niceAxisMax([max]) ?? max) : 0
  const bottom = min < 0 ? -(niceAxisMax([-min]) ?? -min) : 0
  return [bottom, top]
}
