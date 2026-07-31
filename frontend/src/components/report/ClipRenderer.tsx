import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, AreaChart, Area,
  PieChart, Pie, Cell, ScatterChart, Scatter,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, LabelList, ReferenceLine,
} from 'recharts'
import type { LabelProps } from 'recharts'
import TickerLogo from '../TickerLogo'
import type { ClipPayload, ChartPayload, TablePayload, KpiPayload, TextPayload } from '../../lib/reportCreator'
import type { ClipPalette } from '../../lib/reportTheme'
import { isTickerSymbol } from '../../lib/tickerLogos'
import { formatHorizontalCategoryLabel, horizontalCategoryAxisWidth } from './chartLabels'

// One renderer for every clip payload, shared by capture preview, workspace,
// and print. Print mode accepts a theme-derived palette so the PDF matches the
// active color preset. Multi-scale series keep dual Y axes.

const MONO = 'var(--theme-mono, ui-monospace, monospace)'
const SANS = 'var(--theme-sans, sans-serif)'

type Palette = ClipPalette

const DARK: Palette = {
  ink: 'var(--theme-text, #d7e3fc)',
  muted: 'var(--theme-secondary, #5e768f)',
  border: 'var(--theme-border, rgba(255,255,255,0.10))',
  accent: 'var(--theme-primary, #c9a84c)',
  pos: 'var(--theme-positive, #22c55e)',
  neg: 'var(--theme-negative, #ef4444)',
  gridStroke: 'rgba(255,255,255,0.06)',
  headBg: 'rgba(255,255,255,0.03)',
  cellBg: 'var(--theme-surface, #0d1826)',
  series: ['#c9a84c', '#60a5fa', '#d07b34', '#c084fc', '#34d399', '#f4a4c0'],
}

/** Fallback print palette when no theme is passed (light research note). */
const PRINT_FALLBACK: Palette = {
  ink: '#1f2933',
  muted: '#5b6b7b',
  border: '#d4dae1',
  accent: '#9a7b1f',
  pos: '#167c56',
  neg: '#b0331f',
  gridStroke: '#e6eaef',
  headBg: '#f4f6f8',
  cellBg: '#ffffff',
  series: ['#b8860b', '#2f6fb0', '#c0632e', '#7a4fb0', '#2e8b57', '#b23b6b'],
}

function seriesColor(pal: Palette, explicit: string | undefined, i: number, themed: boolean): string {
  // Themed/print reports always use palette series so chart colors match the preset.
  if (explicit && !themed) return explicit
  return pal.series[i % pal.series.length]
}

// Report-consistent color mapping: the same series KEY (a ticker like NVDA, or
// a semantic key like "intrinsic"/"market") always resolves to the same palette
// slot, so NVDA is one fixed color and AAPL another across every chart in the
// report — not flipped by whatever order the series happen to appear in. A
// deterministic hash picks the slot; collisions inside one chart are resolved
// by stable probing over a sorted key order so the result is identical wherever
// the same key set is drawn.
function buildColorMap(pal: Palette, keys: string[]): Map<string, string> {
  const map = new Map<string, string>()
  const used = new Set<number>()
  const n = pal.series.length
  const hash = (k: string) => {
    let h = 0
    for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) >>> 0
    return h % n
  }
  for (const key of [...new Set(keys)].sort()) {
    let slot = hash(key)
    let guard = 0
    while (used.has(slot) && used.size < n && guard < n) { slot = (slot + 1) % n; guard++ }
    used.add(slot)
    map.set(key, pal.series[slot])
  }
  return map
}

function TableClip({ p, pal, maxRows, print }: { p: TablePayload; pal: Palette; maxRows?: number; print: boolean }) {
  const rows = maxRows != null && maxRows > 0 ? p.rows.slice(0, maxRows) : p.rows
  const truncated = rows.length < p.rows.length
  const isTextColumn = (index: number) =>
    index === 0 || /\b(name|headline|event|source|instrument|sector|feature|driver|status|category|region)\b/i.test(p.columns[index] ?? '')
  const narrativeIndex = print && p.columns.length <= 5
    ? p.columns.findIndex(column => /\b(headline|event|name|instrument|driver)\b/i.test(column))
    : -1
  const tickerColumn = p.columns.findIndex(column => /^(ticker|symbol)$/i.test(column.trim()))
  const correlationMatrix = /\bcorrelation matrix\b/i.test(p.title || '')
  const heatBackground = (cell: string | number | null, column: number) => {
    if (!correlationMatrix || column === 0) return undefined
    const value = Number(cell)
    if (!Number.isFinite(value) || Math.abs(value) > 1) return undefined
    const opacity = 0.05 + Math.abs(value) * 0.22
    return value < 0
      ? `rgba(239, 68, 68, ${opacity.toFixed(3)})`
      : `rgba(96, 165, 250, ${opacity.toFixed(3)})`
  }
  return (
    <div style={{ overflowX: print ? 'hidden' : 'auto', maxWidth: '100%' }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: print ? 10.5 : 10,
        tableLayout: print ? 'fixed' : 'auto',
      }}>
        {narrativeIndex >= 0 && (
          <colgroup>
            {p.columns.map((_, index) => (
              <col
                key={index}
                style={{ width: index === narrativeIndex ? '50%' : `${50 / Math.max(1, p.columns.length - 1)}%` }}
              />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {p.columns.map((c, i) => (
              <th key={i} style={{
                padding: print ? '6px 8px' : '5px 8px', textAlign: isTextColumn(i) ? 'left' : 'right', color: pal.muted,
                fontFamily: SANS, fontSize: print ? 9 : 8, fontWeight: 700, letterSpacing: '0.06em',
                textTransform: 'uppercase', borderBottom: `1px solid ${pal.border}`,
                background: pal.headBg, whiteSpace: print ? 'normal' : 'nowrap',
                overflowWrap: print ? 'anywhere' : undefined,
              }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} style={{
                  padding: print ? '6px 8px' : '4px 8px', textAlign: isTextColumn(c) ? 'left' : 'right', color: pal.ink,
                  borderBottom: `1px solid ${pal.border}`, fontVariantNumeric: 'tabular-nums',
                  whiteSpace: print ? 'normal' : 'nowrap',
                  overflowWrap: print ? 'anywhere' : undefined,
                  wordBreak: print ? 'break-word' : undefined,
                  verticalAlign: 'top',
                  background: heatBackground(cell, c),
                }}>
                  {print && c === tickerColumn && typeof cell === 'string' && isTickerSymbol(cell) ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                      <TickerLogo
                        ticker={cell}
                        size={16}
                        crossOrigin="anonymous"
                        fit="contain"
                        cornerRadius={3}
                        padding={1}
                        logoBackground="#ffffff"
                        normalizeVisualWeight
                      />
                      <span>{cell}</span>
                    </span>
                  ) : (cell == null ? '—' : String(cell))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <div style={{ fontFamily: MONO, fontSize: 8, color: pal.muted, marginTop: 4 }}>
          Showing {rows.length} of {p.rows.length} rows.
        </div>
      )}
    </div>
  )
}

function chunkRows<T>(items: T[], preferCols: number): T[][] {
  const n = items.length
  if (!n) return []
  let cols = Math.min(Math.max(preferCols, 1), 4, n)
  if (n > cols && n % cols === 1 && cols > 2) cols -= 1
  const rows: T[][] = []
  for (let i = 0; i < n; i += cols) rows.push(items.slice(i, i + cols))
  return rows
}

function KpiClip({ p, pal }: { p: KpiPayload; pal: Palette }) {
  const rows = chunkRows(p.cells, Math.min(p.cells.length, 4))
  return (
    <div style={{ border: `1px solid ${pal.border}`, background: pal.cellBg }}>
      {rows.map((row, ri) => (
        <div
          key={ri}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))`,
            borderTop: ri === 0 ? 'none' : `1px solid ${pal.border}`,
          }}
        >
          {row.map((k, ci) => {
            const longValue = String(k.value ?? '').length > 24
            return (
            <div
              key={ci}
              style={{
                background: pal.cellBg,
                padding: '8px 10px',
                minWidth: 0,
                borderLeft: ci === 0 ? 'none' : `1px solid ${pal.border}`,
              }}
            >
              <div style={{
                fontFamily: SANS, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em',
                lineHeight: 1.25, textTransform: 'uppercase', color: pal.muted,
                whiteSpace: 'normal', wordBreak: 'break-word',
              }}>{k.label}</div>
              <div style={{
                fontFamily: MONO, fontSize: longValue ? 10.5 : 15, fontWeight: 700, lineHeight: 1.35, minHeight: 22, color: pal.ink, marginTop: 3,
                whiteSpace: longValue ? 'normal' : 'nowrap', overflow: 'visible', overflowWrap: longValue ? 'anywhere' : undefined,
              }}>{k.value}</div>
              {k.sub && (
                <div style={{
                  fontFamily: MONO, fontSize: 8, color: pal.muted, marginTop: 2,
                  lineHeight: 1.3, whiteSpace: 'normal', wordBreak: 'break-word',
                }}>{k.sub}</div>
              )}
            </div>
          )})}
        </div>
      ))}
    </div>
  )
}

// ── Chart axis helpers ─────────────────────────────────────────────────────

// Internal-only keys for the 'range' floating-bar trick — namespaced so they
// can never collide with a model-supplied series key.
const RANGE_LO_KEY = (key: string) => `__rlo_${key}`
const RANGE_SPAN_KEY = (key: string) => `__rspan_${key}`

function seriesValues(p: ChartPayload, key: string): number[] {
  return p.data.map(d => Number(d[key])).filter(v => Number.isFinite(v))
}

function seriesStats(p: ChartPayload) {
  return p.series.map((s, i) => {
    const vals = seriesValues(p, s.key)
    const min = vals.length ? Math.min(...vals) : 0
    const max = vals.length ? Math.max(...vals) : 0
    const mid = (min + max) / 2
    const span = Math.abs(max - min) || Math.abs(mid) || 1
    return { ...s, i, min, max, mid, span, vals }
  })
}

/** Split series into left/right Y scales when magnitudes diverge (IV % vs $ price). */
function partitionScales(p: ChartPayload) {
  const stats = seriesStats(p).filter(s => s.vals.length)
  if (stats.length <= 1) return { left: stats, right: [] as typeof stats }

  // Group by order-of-magnitude of typical level.
  const mag = (s: typeof stats[0]) => Math.log10(Math.max(Math.abs(s.mid), Math.abs(s.max), 1e-9))
  const sorted = [...stats].sort((a, b) => mag(b) - mag(a))
  const primary = sorted[0]
  const left = [primary]
  const right: typeof stats = []
  for (const s of sorted.slice(1)) {
    const ratio = Math.max(s.span, Math.abs(s.mid)) / Math.max(primary.span, Math.abs(primary.mid), 1e-9)
    // Different scale if levels differ by ~5× or more (stock $200 vs IV 40).
    if (ratio > 5 || ratio < 0.2) right.push(s)
    else left.push(s)
  }
  // If everything landed on one side, no dual axis.
  if (!right.length || !left.length) return { left: stats, right: [] as typeof stats }
  return { left, right }
}

type TickKind = 'auto' | 'pct' | 'price' | 'compact' | 'multiple' | 'bps' | 'pp'

function compactNumber(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `${(a / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(a / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  if (a >= 100) return a.toFixed(0)
  if (a >= 10) return a.toFixed(1)
  if (a >= 1) return a.toFixed(2)
  return a.toFixed(2)
}

function fmtTick(v: number, kind: TickKind = 'auto'): string {
  if (!Number.isFinite(v)) return ''
  const a = Math.abs(v)
  const sign = v < 0 ? '−' : ''
  if (kind === 'price') return `${sign}$${compactNumber(v)}`
  if (kind === 'pct') return `${sign}${a.toFixed(a >= 10 ? 0 : 1)}%`
  if (kind === 'multiple') return `${sign}${compactNumber(v)}×`
  if (kind === 'bps') return `${sign}${compactNumber(v)} bps`
  if (kind === 'pp') return `${sign}${compactNumber(v)} pp`
  return `${sign}${compactNumber(v)}`
}

function inferTickKind(
  stats: { mid: number; max: number; min: number; label: string }[],
  context = '',
): Exclude<TickKind, 'compact'> {
  const seriesLabel = stats.map(s => s.label).join(' ').toLowerCase()
  const label = `${seriesLabel} ${context}`.toLowerCase()
  if (/\bpp\b|\bpercentage points?\b/.test(seriesLabel)) return 'pp'
  if (/\b(bps?|basis points?)\b/.test(seriesLabel)) return 'bps'
  if (/%|\bpct\b|\bpercent\b/.test(seriesLabel)) return 'pct'
  if (/(\$|\busd\b|\bprice\b|\bspot\b|\bstrike\b|\btarget\b|\bintrinsic\b|\bfair value\b|\bnav\b|\bper share\b|\/sh\b)/.test(seriesLabel)) return 'price'
  if (/(\bp\/e\b|\bev\/ebitda\b|\bp\/s\b|\bp\/b\b|\bp\/fcf\b|\bpeg\b|\bmultiple\b)/.test(seriesLabel)) return 'multiple'
  if (/\b(bps?|basis points?)\b/.test(label)) return 'bps'
  if (/(\bprice history\b|\$|\busd\b|\bspot\b|\bstrike\b|\btarget\b|\bintrinsic\b|\bfair value\b|\bnav\b|\bper share\b|\/sh\b)/.test(label)) return 'price'
  if (/(%|\bpct\b|\bpercent\b|\biv\b|\bvol(?:atility)?\b|\bmargin\b|\bgrowth\b|\bupside\b|\breturn\b|\byield\b|\brate\b|\bshare\b|\bweight\b|\ballocation\b|\bpremium\b|\broe\b|\broa\b)/.test(label)) return 'pct'
  if (/(\bp\/e\b|\bev\/ebitda\b|\bp\/s\b|\bp\/b\b|\bp\/fcf\b|\bpeg\b|\bmultiple\b)/.test(label)) return 'multiple'
  if (!stats.length) return 'auto'
  return 'auto'
}

function humanizeAxisLabel(value: string): string {
  const normalized = value.replace(/[_-]+/g, ' ').trim()
  if (/^(x|date|asof|month|year|period)$/i.test(normalized)) return /^(x)$/i.test(normalized) ? 'Period' : normalized.replace(/\b\w/g, c => c.toUpperCase())
  if (/^(name|ticker|symbol)$/i.test(normalized)) return 'Company'
  if (/^category$/i.test(normalized)) return 'Category'
  if (/^driver$/i.test(normalized)) return 'Valuation driver'
  return normalized.replace(/\b\w/g, c => c.toUpperCase())
}

function measureLabel(
  stats: { label: string }[],
  kind: Exclude<TickKind, 'compact'>,
  context = '',
): string {
  if (kind === 'pct') return 'Percent (%)'
  if (kind === 'price') return 'Value (USD)'
  if (kind === 'multiple') return 'Multiple (×)'
  if (kind === 'bps') return 'Basis points (bps)'
  if (kind === 'pp') return 'Percentage points (pp)'
  if (/\b(relative performance|indexed|normalized)\b/i.test(context)) return 'Indexed performance (start = 100)'
  if (/\bcorrelation\b/i.test(context)) return 'Correlation'
  if (/\bbeta\b/i.test(context)) return 'Beta'
  if (/\b(residual|return)\b/i.test(context)) return 'Return'
  if (stats.length === 1 && stats[0].label) return stats[0].label
  return 'Value'
}

export function HorizontalCategoryTick({
  x = 0,
  y = 0,
  payload,
  pal,
  print,
}: {
  x?: number
  y?: number
  payload?: { value?: unknown }
  pal: Palette
  print: boolean
}) {
  const label = formatHorizontalCategoryLabel(payload?.value, print ? 16 : 18)
  const fontSize = print ? 7.5 : 8.5
  const labelX = x - (print ? 5 : 7)
  if (!label.secondary) {
    return (
      <text
        x={labelX}
        y={y}
        dy="0.35em"
        textAnchor="end"
        fill={pal.ink}
        fontFamily={SANS}
        fontSize={fontSize}
        fontWeight={600}
      >
        {label.primary}
      </text>
    )
  }
  return (
    <text
      x={labelX}
      y={y}
      dy="0.35em"
      textAnchor="end"
      fontFamily={SANS}
      aria-label={`${label.secondary} ${label.primary}`}
    >
      <tspan
        fill={pal.muted}
        fontFamily={MONO}
        fontSize={print ? 6.8 : 7.8}
        fontWeight={700}
      >
        {label.secondary}
      </tspan>
      <tspan
        dx={print ? 4 : 5}
        fill={pal.ink}
        fontSize={fontSize}
        fontWeight={600}
      >
        {label.primary}
      </tspan>
    </text>
  )
}

function formatXTick(v: string | number): string {
  const s = String(v)
  // ISO date
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s.slice(0, 10) + 'T00:00:00')
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    }
  }
  // Year-month
  if (/^\d{4}-\d{2}$/.test(s)) {
    const d = new Date(s + '-01T00:00:00')
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
    }
  }
  const n = Number(s)
  if (Number.isFinite(n) && Math.abs(n) >= 1000) return fmtTick(n, 'compact')
  if (s.length > 8) return s.slice(0, 7) + '…'
  return s
}

// Box & whisker — recharts has no clean box plot, so this is a self-contained
// SVG: one horizontal box per metric (whiskers min→max, box Q1→Q3, median line)
// with the subjects' own values drawn as labeled marker dots. Full control means
// no origin bug and no label overlap.
function BoxPlotClip({ p, pal, height, print }: { p: ChartPayload; pal: Palette; height: number; print: boolean }) {
  type Row = { name: string; min: number; q1: number; median: number; q3: number; max: number; outliers?: number[]; markers: { label: string; value: number }[] }
  const rows: Row[] = p.data.map(d => ({
    name: String(d[p.xKey] ?? ''),
    min: Number(d.min), q1: Number(d.q1), median: Number(d.median), q3: Number(d.q3), max: Number(d.max),
    outliers: Array.isArray(d.outliers) ? (d.outliers as number[]).map(Number).filter(Number.isFinite) : [],
    markers: Array.isArray(d.markers) ? (d.markers as { label: string; value: number }[]).filter(m => Number.isFinite(Number(m.value))) : [],
  })).filter(r => [r.min, r.q1, r.median, r.q3, r.max].every(Number.isFinite))
  if (!rows.length) return null

  const markerColors = buildColorMap(pal, rows.flatMap(r => r.markers.map(m => m.label)))
  const whiskerVals = rows.flatMap(r => [r.min, r.max, ...(r.outliers || [])])
  const markerVals = rows.flatMap(r => r.markers.map(m => m.value))
  let lo = Math.min(...whiskerVals), hi = Math.max(...whiskerVals)
  if (markerVals.length) {
    const clampedMarkers = markerVals.map(v => Math.min(Math.max(v, lo - (hi - lo) * 0.4), hi + (hi - lo) * 0.4))
    lo = Math.min(lo, ...clampedMarkers)
    hi = Math.max(hi, ...clampedMarkers)
  }
  const pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1
  lo -= pad; hi += pad

  const VB_W = 340
  const rowH = 62, topPad = 18, axisH = 26, labelW = 6, plotX = 62, plotR = 12
  const plotW = VB_W - plotX - plotR
  const VB_H = topPad + rows.length * rowH + axisH
  const x = (v: number) => plotX + ((Math.min(Math.max(v, lo), hi) - lo) / (hi - lo)) * plotW
  const ticks = 5
  const tickVals = Array.from({ length: ticks }, (_, i) => lo + ((hi - lo) * i) / (ticks - 1))

  return (
    <div style={{ width: '100%' }}>
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} width="100%" style={{ display: 'block', fontFamily: MONO }} preserveAspectRatio="xMidYMid meet">
        {tickVals.map((tv, i) => (
          <g key={`t${i}`}>
            <line x1={x(tv)} x2={x(tv)} y1={topPad - 6} y2={topPad + rows.length * rowH} stroke={pal.gridStroke} strokeWidth={0.6} />
            <text x={x(tv)} y={VB_H - 8} fontSize={8} fill={pal.muted} textAnchor="middle">{fmtTick(tv)}</text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cy = topPad + i * rowH + rowH / 2 - 6
          const boxTop = cy - 11, boxH = 22
          return (
            <g key={r.name}>
              <text x={labelW} y={cy + 3} fontSize={9} fontWeight={700} fill={pal.ink}>{r.name.length > 8 ? r.name.slice(0, 8) : r.name}</text>
              {/* whisker */}
              <line x1={x(r.min)} x2={x(r.max)} y1={cy} y2={cy} stroke={pal.muted} strokeWidth={1} />
              <line x1={x(r.min)} x2={x(r.min)} y1={cy - 6} y2={cy + 6} stroke={pal.muted} strokeWidth={1} />
              <line x1={x(r.max)} x2={x(r.max)} y1={cy - 6} y2={cy + 6} stroke={pal.muted} strokeWidth={1} />
              {/* box */}
              <rect x={x(r.q1)} y={boxTop} width={Math.max(x(r.q3) - x(r.q1), 1)} height={boxH} fill={pal.headBg} stroke={pal.accent} strokeWidth={1} />
              <line x1={x(r.median)} x2={x(r.median)} y1={boxTop} y2={boxTop + boxH} stroke={pal.accent} strokeWidth={1.6} />
              {/* outlier points */}
              {r.outliers?.map((ov, oi) => (
                <g key={`out-${oi}`}>
                  <circle cx={x(ov)} cy={cy} r={3} fill="none" stroke={pal.muted} strokeWidth={1} />
                  <text x={x(ov)} y={cy - 12} fontSize={7} fill={pal.muted} textAnchor="middle">{fmtTick(ov)}</text>
                </g>
              ))}
              {/* subject markers */}
              {r.markers.map((m, mi) => (
                <g key={m.label}>
                  <circle cx={x(m.value)} cy={cy} r={3.6} fill={markerColors.get(m.label) ?? pal.series[mi % pal.series.length]} stroke={pal.cellBg} strokeWidth={1} />
                  <text x={x(m.value)} y={cy - (mi % 2 === 0 ? 13 : -21)} fontSize={7.5} fontWeight={700} textAnchor="middle" fill={markerColors.get(m.label) ?? pal.ink}>{m.label} {fmtTick(m.value)}</text>
                </g>
              ))}
            </g>
          )
        })}
      </svg>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 4, justifyContent: 'center' }}>
        <span style={{ fontFamily: MONO, fontSize: 8, color: pal.muted }}>Box = interquartile range (25th–75th), line = median, whiskers = 1.5× IQR statistical bounds. Outliers plotted as individual points.</span>
      </div>
    </div>
  )
}

function ChartClip({
  p, pal, height, print = false,
}: {
  p: ChartPayload
  pal: Palette
  height: number
  print?: boolean
}) {
  if (p.chartType === 'box') return <BoxPlotClip p={p} pal={pal} height={height} print={print} />

  // Categorical types keep every category (strikes, peers, buckets). Line/area/
  // scatter: light downsample if huge.
  const CATEGORICAL = p.chartType === 'bar' || p.chartType === 'histogram' || p.chartType === 'dot'
    || p.chartType === 'pie' || p.chartType === 'range'
  const data = CATEGORICAL || p.data.length <= 60
    ? p.data
    : p.data.filter((_, i) => i % Math.ceil(p.data.length / 50) === 0 || i === p.data.length - 1)

  // 'range' floats a bar from low to high via a transparent base + visible span
  // stacked on top — recharts has no native floating-bar primitive. The whole
  // stack is shifted down by rDomainMin so the y-axis can start near the band's
  // low (not 0): the bars then FILL the plot instead of floating in the upper
  // half, and the axis shows real values via a +rDomainMin tick formatter.
  let rangeMin = Infinity, rangeMax = -Infinity
  if (p.chartType === 'range') {
    for (const row of data) for (const s of p.series) {
      const v = row[s.key]
      if (Array.isArray(v)) {
        const a = Number(v[0]), b = Number(v[1])
        if (Number.isFinite(a) && Number.isFinite(b)) { rangeMin = Math.min(rangeMin, a, b); rangeMax = Math.max(rangeMax, a, b) }
      }
    }
  }
  const rPad = Number.isFinite(rangeMin) ? ((rangeMax - rangeMin) * 0.12 || Math.abs(rangeMax) * 0.1 || 1) : 0
  const rDomainMin = Number.isFinite(rangeMin) ? rangeMin - rPad : 0
  const rDomainMax = Number.isFinite(rangeMax) ? rangeMax + rPad : 0
  const rangeData = p.chartType === 'range'
    ? data.map(row => {
      const out: Record<string, string | number | null> = { [p.xKey]: String(row[p.xKey] ?? '') }
      for (const s of p.series) {
        const v = row[s.key]
        const lo = Array.isArray(v) ? Number(v[0]) : NaN
        const hi = Array.isArray(v) ? Number(v[1]) : NaN
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
          out[RANGE_LO_KEY(s.key)] = Math.min(lo, hi) - rDomainMin  // transparent base, offset by domain min
          out[RANGE_SPAN_KEY(s.key)] = Math.max(hi - lo, 0)
          out[`__rhival_${s.key}`] = Math.max(lo, hi)  // real high, for the top value label
          out[`__rloval_${s.key}`] = Math.min(lo, hi)  // real low, for the bottom value label
        }
      }
      return out
    })
    : data

  let { left, right } = partitionScales(p)
  const categoryContext = data.map(row => String(row[p.xKey] ?? '')).join(' ')
  let leftKind = inferTickKind(left, `${p.title ?? ''} ${categoryContext}`)
  let rightKind = right.length ? inferTickKind(right, `${p.title ?? ''} ${categoryContext}`) : 'auto'
  if (right.length && leftKind === rightKind && leftKind !== 'auto') {
    left = [...left, ...right]
    right = []
    leftKind = inferTickKind(left, `${p.title ?? ''} ${categoryContext}`)
    rightKind = 'auto'
  }
  const dual = right.length > 0
  const axisTick = { fontFamily: MONO, fontSize: 9, fill: pal.muted }
  const xLabel = humanizeAxisLabel(p.xKey)
  const leftMeasure = measureLabel(left, leftKind, p.title)
  const rightMeasure = dual ? measureLabel(right, rightKind, p.title) : ''

  // Report-consistent per-series colors (NVDA always one color, AAPL another).
  const colorMap = buildColorMap(pal, p.series.map(s => s.key))
  const fillFor = (s: { key: string; color?: string }, i: number): string =>
    (s.color && !print ? s.color : colorMap.get(s.key) ?? pal.series[i % pal.series.length])

  // X ticks: limit count for readability
  const xCount = data.length
  const xInterval = xCount <= 6 ? 0 : Math.max(1, Math.ceil(xCount / 5) - 1)

  // Categorical labels (segment/metric/driver names) are often long ("Professional
  // Visualization", "Operating Margin"). Angle them instead of clipping to "Profe…"
  // so every category stays readable, and give the axis the height to fit.
  const categoricalX = p.chartType === 'bar' || p.chartType === 'histogram'
    || p.chartType === 'dot' || p.chartType === 'range'
  const longLabels = categoricalX && data.some(d => String(d[p.xKey] ?? '').length > 7)
  const xAngle = longLabels ? -28 : 0
  const xAxisHeight = longLabels ? (print ? 52 : 58) : (print ? 28 : 30)

  const yTick = (kind: typeof leftKind) => (v: number) => fmtTick(v, kind)

  const margin = print
    ? { top: 10, right: dual ? 42 : 14, left: 8, bottom: longLabels ? 8 : 4 }
    : { top: 8, right: dual ? 44 : 12, left: 2, bottom: longLabels ? 4 : 0 }

  const leftKeys = new Set(left.map(s => s.key))

  // Value labels printed on each mark (bars, dots, scatter, range ends). Gated
  // by mark density so a sparse comparison chart gets numbers on it while a busy
  // one stays legible on the axis alone. Kind follows each series' own axis so a
  // $ bar reads "$206" and a % bar reads "31.6".
  const markCount = data.length * Math.max(p.series.length, 1)
  const showValueLabels = markCount > 0 && markCount <= 20
  const showRangeValueLabels = markCount > 0 && markCount <= 10
  const seriesKind = (key: string): typeof leftKind => (leftKeys.has(key) || !dual) ? leftKind : rightKind
  const valueLabelFontSize = 9
  const valueLabel = (key: string) => (v: unknown) => fmtTick(Number(v), seriesKind(key))

  const leftMinVal = left.length ? Math.min(...left.map(s => s.min)) : 0
  const leftDomain: [any, any] = (p.chartType === 'bar' || p.chartType === 'histogram') && leftMinVal >= 0
    ? [0, 'auto']
    : ['auto', 'auto']

  const commonX = (
    <XAxis
      dataKey={p.xKey}
      tick={{ ...axisTick, ...(longLabels ? { textAnchor: 'end' } : {}) }}
      tickLine={false}
      axisLine={{ stroke: pal.border }}
      interval={categoricalX ? 0 : xInterval}
      angle={xAngle}
      minTickGap={longLabels ? 0 : (print ? 12 : 20)}
      tickFormatter={longLabels ? undefined : formatXTick}
      height={xAxisHeight}
      label={{
        value: xLabel,
        position: 'insideBottom',
        offset: print ? -1 : -2,
        fill: pal.muted,
        fontFamily: SANS,
        fontSize: print ? 8 : 8,
        fontWeight: 700,
      }}
    />
  )

  const yLeft = (
    <YAxis
      yAxisId="left"
      orientation="left"
      tick={axisTick}
      tickLine={false}
      axisLine={false}
      width={print ? 52 : 48}
      tickFormatter={yTick(leftKind)}
      domain={leftDomain}
      label={{
        value: leftMeasure,
        angle: -90,
        position: 'insideLeft',
        fill: pal.muted,
        fontFamily: SANS,
        fontSize: print ? 8 : 8,
        fontWeight: 700,
      }}
    />
  )
  const yRight = dual ? (
    <YAxis
      yAxisId="right"
      orientation="right"
      tick={axisTick}
      tickLine={false}
      axisLine={false}
      width={print ? 46 : 44}
      tickFormatter={yTick(rightKind)}
      domain={['auto', 'auto']}
      label={{
        value: rightMeasure,
        angle: 90,
        position: 'insideRight',
        fill: pal.muted,
        fontFamily: SANS,
        fontSize: print ? 8 : 8,
        fontWeight: 700,
      }}
    />
  ) : null

  const grid = <CartesianGrid strokeDasharray="3 3" stroke={pal.gridStroke} />
  const details = p.details ?? []
  const tip = !print ? (
    details.length ? (
      <Tooltip
        cursor={{ fill: pal.headBg }}
        content={({ active, payload, label }) => {
          if (!active || !payload?.length) return null
          const row = payload[0].payload as Record<string, unknown>
          return (
            <div style={{
              background: 'var(--theme-surface, #0d1826)',
              border: `1px solid ${pal.border}`,
              color: pal.ink,
              fontFamily: MONO,
              fontSize: 10,
              padding: '7px 9px',
            }}>
              <div style={{ color: pal.accent, fontWeight: 700, marginBottom: 5 }}>{String(label ?? '')}</div>
              {p.series.map(series => {
                const value = Number(row[series.key])
                if (!Number.isFinite(value)) return null
                return (
                  <div key={series.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                    <span style={{ color: pal.muted }}>{series.label}</span>
                    <span>{fmtTick(value, seriesKind(series.key))}</span>
                  </div>
                )
              })}
              {details.map(detail => {
                const value = Number(row[detail.key])
                if (!Number.isFinite(value)) return null
                const kind = inferTickKind([{ label: detail.label, min: value, max: value, mid: value }], p.title)
                return (
                  <div key={detail.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 14 }}>
                    <span style={{ color: pal.muted }}>{detail.label}</span>
                    <span>{fmtTick(value, kind)}</span>
                  </div>
                )
              })}
            </div>
          )
        }}
      />
    ) : (
      <Tooltip
        contentStyle={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${pal.border}`, fontFamily: MONO, fontSize: 10 }}
        labelStyle={{ color: pal.accent }}
        formatter={(value: number, name: string) => {
          const series = p.series.find(item => item.label === name || item.key === name)
          return [fmtTick(Number(value), series ? seriesKind(series.key) : leftKind), name]
        }}
      />
    )
  ) : null

  // Legend always when dual scale or multi-series so axes make sense.
  const showLegend = p.series.length > 1 || dual

  const legendStyle = { fontFamily: MONO, fontSize: 8.5, color: pal.muted, paddingTop: 4 }

  // Pie: roll tiny slices (<3%) into "Other" and identify every slice through a
  // legend below the chart — inline pie labels collide badly on small adjacent
  // slices, which is the label-overlap the report kept showing.
  const pieKey = p.series[0]?.key ?? ''
  const pieRaw = p.chartType === 'pie'
    ? data.map(d => ({ name: String(d[p.xKey] ?? ''), value: Number(d[pieKey]) })).filter(s => Number.isFinite(s.value) && s.value > 0)
    : []
  const pieTotal = pieRaw.reduce((a, s) => a + s.value, 0) || 1
  const pieOther = pieRaw.filter(s => s.value / pieTotal < 0.03).reduce((a, s) => a + s.value, 0)
  const pieData = pieOther > 0
    ? [...pieRaw.filter(s => s.value / pieTotal >= 0.03), { name: 'Other', value: pieOther }]
    : pieRaw
  const pieColor = (i: number) => pal.series[i % pal.series.length]

  const horizontalBars = p.chartType === 'bar' && p.barOrientation === 'horizontal'
  const horizontalKind = p.series[0] ? seriesKind(p.series[0].key) : leftKind
  const horizontalValues = p.series[0] ? seriesValues(p, p.series[0].key) : []
  const isDivergingHorizontal = horizontalBars
    && p.series.length === 1
    && horizontalValues.some(value => value < 0)
    && horizontalValues.some(value => value > 0)
    && /\b(momentum|return|change|upside|downside|relative|variance|contribution)\b/i.test(
      `${p.title ?? ''} ${p.series[0]?.label ?? ''}`,
    )
  const horizontalValueLabel = (props: LabelProps) => {
    const view = props.viewBox as { x?: number; y?: number; width?: number; height?: number } | undefined
    const value = Number(props.value)
    if (!view || !Number.isFinite(value)) return null
    const x = Number(view.x ?? 0)
    const y = Number(view.y ?? 0)
    const width = Number(view.width ?? 0)
    const height = Number(view.height ?? 0)
    const negative = value < 0
    const formatted = `${value > 0 ? '+' : ''}${fmtTick(value, horizontalKind)}`
    const barEnd = x + width
    return (
      <text
        x={barEnd + (negative ? -4 : 4)}
        y={y + height / 2}
        dy="0.35em"
        textAnchor={negative ? 'end' : 'start'}
        fill={pal.ink}
        fontSize={valueLabelFontSize}
        fontFamily={MONO}
        fontWeight={700}
      >
        {formatted}
      </text>
    )
  }
  const horizontalCategoryWidth = horizontalCategoryAxisWidth(
    data.map(row => row[p.xKey]),
    print,
  )

  return (
    <div style={{ width: '100%', minHeight: height }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        minHeight: 20,
        padding: '0 4px 4px',
        color: pal.muted,
        fontFamily: SANS,
        fontSize: print ? 7 : 8,
        fontWeight: 700,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
      }}>
        <span>Measure · {p.chartType === 'pie' ? (p.series[0]?.label || 'Share') : leftMeasure}</span>
        <span>By · {xLabel}</span>
      </div>
      <ResponsiveContainer width="100%" height={height} debounce={1}>
        {p.chartType === 'pie' ? (
          <PieChart margin={{ top: 6, right: 6, left: 6, bottom: 6 }}>
            {!print && (
              <Tooltip
                contentStyle={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${pal.border}`, fontFamily: MONO, fontSize: 10 }}
                labelStyle={{ color: pal.accent }}
                formatter={(value: number) => `${((value / pieTotal) * 100).toFixed(1)}%`}
              />
            )}
            <Pie
              data={pieData}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={Math.max(Math.min(height, 300) * 0.17, 28)}
              outerRadius={Math.max(Math.min(height, 300) / 2 - (print ? 14 : 12), 44)}
              isAnimationActive={false}
              label={false}
              labelLine={false}
              stroke={pal.cellBg}
              strokeWidth={1.5}
            >
              {pieData.map((_, i) => <Cell key={i} fill={pieColor(i)} />)}
            </Pie>
            <text
              x="50%"
              y="47%"
              textAnchor="middle"
              dominantBaseline="middle"
              fill={pal.muted}
              fontFamily={SANS}
              fontSize={print ? 7 : 8}
              fontWeight={700}
            >
              TOTAL
            </text>
            <text
              x="50%"
              y="55%"
              textAnchor="middle"
              dominantBaseline="middle"
              fill={pal.ink}
              fontFamily={MONO}
              fontSize={print ? 12 : 14}
              fontWeight={700}
            >
              100%
            </text>
          </PieChart>
        ) : p.chartType === 'scatter' ? (
          <ScatterChart margin={margin}>
            {grid}
            <XAxis
              dataKey={p.xKey}
              type="number"
              name={p.xKey}
              tick={axisTick}
              tickLine={false}
              axisLine={{ stroke: pal.border }}
              tickFormatter={v => fmtTick(Number(v))}
              height={print ? 28 : 30}
            />
            <YAxis
              dataKey={p.series[0]?.key}
              type="number"
              name={p.series[0]?.label}
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              width={print ? 42 : 48}
              tickFormatter={v => fmtTick(Number(v))}
            />
            {!print && (
              <Tooltip
                contentStyle={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${pal.border}`, fontFamily: MONO, fontSize: 10 }}
                labelStyle={{ color: pal.accent }}
                cursor={{ strokeDasharray: '3 3' }}
                formatter={(value: number) => fmtTick(value)}
                labelFormatter={(_v, payload) =>
                  String((payload?.[0]?.payload as Record<string, unknown> | undefined)?.label ?? '')}
              />
            )}
            <Scatter data={data} fill={p.series[0] ? fillFor(p.series[0], 0) : pal.series[0]} isAnimationActive={false}>
              {showValueLabels && p.series[0] && (
                <LabelList dataKey={p.series[0].key} position="top" formatter={valueLabel(p.series[0].key)}
                  fill={pal.ink} fontSize={valueLabelFontSize} fontFamily={MONO} fontWeight={700} />
              )}
            </Scatter>
          </ScatterChart>
        ) : p.chartType === 'range' ? (
          <BarChart data={rangeData} margin={margin}>
            {grid}
            {commonX}
            <YAxis
              yAxisId="left"
              orientation="left"
              tick={axisTick}
              tickLine={false}
              axisLine={false}
              width={print ? 42 : 48}
              domain={[0, Math.max(rDomainMax - rDomainMin, 1)]}
              tickFormatter={(v: number) => fmtTick(v + rDomainMin)}
            />
            {!print && (
              <Tooltip
                contentStyle={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${pal.border}`, fontFamily: MONO, fontSize: 10 }}
                labelStyle={{ color: pal.accent }}
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  const row = payload[0].payload as Record<string, number | undefined>
                  return (
                    <div style={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${pal.border}`, fontFamily: MONO, fontSize: 10, padding: '6px 8px' }}>
                      <div style={{ color: pal.accent, marginBottom: 3 }}>{label}</div>
                      {p.series.map(s => {
                        const base = row[RANGE_LO_KEY(s.key)]
                        const span = row[RANGE_SPAN_KEY(s.key)]
                        if (base == null || span == null) return null
                        const lo = base + rDomainMin
                        return <div key={s.key}>{s.label}: {fmtTick(lo)}–{fmtTick(lo + span)}</div>
                      })}
                    </div>
                  )
                }}
              />
            )}
            {/* No auto <Legend> here — its labels come straight from p.series
                below, not from recharts inferring names off the base/span
                bars, so an internal field name can never leak into it. */}
            {p.series.flatMap((s, i) => {
              const c = fillFor(s, i)
              const stackId = `range-${s.key}`
              return [
                <Bar key={`${s.key}-base`} yAxisId="left" dataKey={RANGE_LO_KEY(s.key)} stackId={stackId} fill="transparent" isAnimationActive={false} legendType="none" />,
                <Bar key={`${s.key}-span`} yAxisId="left" dataKey={RANGE_SPAN_KEY(s.key)} stackId={stackId} legendType="none" fill={c} isAnimationActive={false} maxBarSize={print ? 18 : 28}>
                  {showRangeValueLabels && [
                    <LabelList key="hi" dataKey={`__rhival_${s.key}`} position="top" formatter={valueLabel(s.key)}
                      fill={pal.ink} fontSize={valueLabelFontSize} fontFamily={MONO} fontWeight={700} />,
                    <LabelList key="lo" dataKey={`__rloval_${s.key}`} position="bottom" formatter={valueLabel(s.key)}
                      fill={pal.muted} fontSize={valueLabelFontSize} fontFamily={MONO} fontWeight={700} />,
                  ]}
                </Bar>,
              ]
            })}
          </BarChart>
        ) : horizontalBars ? (
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 4, right: print ? 44 : 56, left: 2, bottom: print ? 18 : 20 }}
            barCategoryGap="24%"
          >
            <CartesianGrid strokeDasharray="3 3" stroke={pal.gridStroke} horizontal={false} />
            <XAxis
              type="number"
              tick={axisTick}
              tickLine={false}
              axisLine={{ stroke: pal.border }}
              tickFormatter={(value: number) => fmtTick(value, horizontalKind)}
              domain={leftMinVal >= 0 ? [0, 'auto'] : ['auto', 'auto']}
              label={{
                value: leftMeasure,
                position: 'insideBottom',
                offset: -2,
                fill: pal.muted,
                fontFamily: SANS,
                fontSize: print ? 7 : 8,
                fontWeight: 700,
              }}
            />
            {isDivergingHorizontal && (
              <ReferenceLine x={0} stroke={pal.muted} strokeWidth={1} />
            )}
            <YAxis
              type="category"
              dataKey={p.xKey}
              tick={(props) => <HorizontalCategoryTick {...props} pal={pal} print={print} />}
              tickLine={false}
              axisLine={false}
              width={horizontalCategoryWidth}
              interval={0}
            />
            {tip}
            {p.series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                fill={fillFor(s, i)}
                isAnimationActive={false}
                maxBarSize={print ? 18 : 24}
              >
                {isDivergingHorizontal && data.map((row, index) => (
                  <Cell
                    key={`${s.key}-${index}`}
                    fill={Number(row[s.key]) >= 0 ? pal.pos : pal.neg}
                  />
                ))}
                {showValueLabels && (
                  isDivergingHorizontal ? (
                    <LabelList dataKey={s.key} content={horizontalValueLabel} />
                  ) : (
                    <LabelList
                      dataKey={s.key}
                      position="right"
                      formatter={valueLabel(s.key)}
                      fill={pal.ink}
                      fontSize={valueLabelFontSize}
                      fontFamily={MONO}
                      fontWeight={700}
                    />
                  )
                )}
              </Bar>
            ))}
            {showLegend && <Legend wrapperStyle={legendStyle} iconType="square" iconSize={8} />}
          </BarChart>
        ) : p.chartType === 'bar' || p.chartType === 'histogram' ? (
          <BarChart data={data} margin={margin} barCategoryGap={p.chartType === 'histogram' ? 1 : undefined}>
            {grid}
            {commonX}
            {yLeft}
            {yRight}
            {tip}
            {p.series.map((s, i) => (
              <Bar
                key={s.key}
                yAxisId={leftKeys.has(s.key) || !dual ? 'left' : 'right'}
                dataKey={s.key}
                name={s.label}
                fill={fillFor(s, i)}
                isAnimationActive={false}
                maxBarSize={print ? 18 : 28}
              >
                {showValueLabels && (
                  <LabelList dataKey={s.key} position="top" formatter={valueLabel(s.key)}
                    fill={pal.ink} fontSize={valueLabelFontSize} fontFamily={MONO} fontWeight={700} />
                )}
              </Bar>
            ))}
            {showLegend && <Legend wrapperStyle={legendStyle} iconType="square" iconSize={8} />}
          </BarChart>
        ) : p.chartType === 'area' ? (
          <AreaChart data={data} margin={margin}>
            {grid}
            {commonX}
            {yLeft}
            {yRight}
            {tip}
            {p.series.map((s, i) => {
              const c = fillFor(s, i)
              return (
                <Area
                  key={s.key}
                  yAxisId={leftKeys.has(s.key) || !dual ? 'left' : 'right'}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={c}
                  fill={c}
                  fillOpacity={0.12}
                  strokeWidth={print ? 2.2 : 1.8}
                  isAnimationActive={false}
                />
              )
            })}
            {showLegend && <Legend wrapperStyle={legendStyle} iconType="line" iconSize={10} />}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={margin}>
            {grid}
            {commonX}
            {yLeft}
            {yRight}
            {tip}
            {p.series.map((s, i) => (
              <Line
                key={s.key}
                yAxisId={leftKeys.has(s.key) || !dual ? 'left' : 'right'}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={p.chartType === 'dot' ? 'none' : fillFor(s, i)}
                dot={p.chartType === 'dot' ? { r: print ? 3.5 : 4.5, fill: fillFor(s, i), strokeWidth: 0 } : false}
                strokeWidth={print ? 2.3 : 1.9}
                strokeDasharray={p.chartType !== 'dot' && i === 1 ? '6 3' : undefined}
                connectNulls
                isAnimationActive={false}
              >
                {p.chartType === 'dot' && showValueLabels && (
                  <LabelList dataKey={s.key} position="top" formatter={valueLabel(s.key)}
                    fill={pal.ink} fontSize={valueLabelFontSize} fontFamily={MONO} fontWeight={700} />
                )}
              </Line>
            ))}
            {showLegend && <Legend wrapperStyle={legendStyle} iconType="line" iconSize={10} />}
          </LineChart>
        )}
      </ResponsiveContainer>
      {p.chartType === 'pie' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', marginTop: 6, justifyContent: 'center' }}>
          {pieData.map((s, i) => (
            <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 8.5, color: pal.ink }}>
              <span style={{ width: 8, height: 8, background: pieColor(i), flex: 'none' }} />
              {s.name} <span style={{ color: pal.muted }}>{((s.value / pieTotal) * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      )}
      {p.chartType === 'range' && p.series.length > 1 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 4, paddingTop: 2 }}>
          {p.series.map((s, i) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: MONO, fontSize: 8.5, color: pal.muted }}>
              <span style={{ width: 8, height: 8, background: fillFor(s, i), display: 'inline-block' }} />
              {s.label}
            </div>
          ))}
        </div>
      )}
      {dual && p.chartType !== 'pie' && p.chartType !== 'scatter' && (
        <div style={{ fontFamily: MONO, fontSize: 7.5, color: pal.muted, marginTop: 2, lineHeight: 1.3 }}>
          Left axis: {left.map(s => s.label).join(', ')}. Right axis: {right.map(s => s.label).join(', ')}.
        </div>
      )}
    </div>
  )
}

function TextClip({ p, pal }: { p: TextPayload; pal: Palette }) {
  return <div style={{ fontFamily: SANS, fontSize: 11, lineHeight: 1.55, color: pal.ink, whiteSpace: 'pre-wrap' }}>{p.body}</div>
}

export function reportChartHeight(
  payload: ClipPayload,
  print: boolean,
  compact = false,
  inline = false,
): number {
  const baseChartH = print
    ? (inline ? 118 : compact ? 176 : 220)
    : (inline ? 126 : compact ? 170 : 230)
  if (
    payload.kind !== 'chart'
    || payload.chartType !== 'bar'
    || payload.barOrientation !== 'horizontal'
  ) {
    return baseChartH
  }
  return Math.max(
    print ? (inline ? 104 : compact ? 124 : 138) : (inline ? 116 : compact ? 136 : 154),
    Math.min(
      print ? (inline ? 220 : compact ? 250 : 276) : (inline ? 240 : compact ? 280 : 320),
      payload.data.length * (print ? (inline ? 15 : compact ? 17 : 18) : (inline ? 18 : 20))
        + (print ? (inline ? 38 : compact ? 42 : 46) : (inline ? 44 : 50)),
    ),
  )
}

export default function ClipRenderer({
  payload,
  mode = 'dark',
  compact,
  inline,
  maxTableRows,
  palette,
}: {
  payload: ClipPayload
  mode?: 'dark' | 'print'
  compact?: boolean
  inline?: boolean
  maxTableRows?: number
  /** Theme-derived palette for print mode (active color preset). */
  palette?: ClipPalette
}) {
  const print = mode === 'print'
  const pal = print ? (palette ?? PRINT_FALLBACK) : DARK
  const tableCap = maxTableRows ?? (print ? 10 : undefined)
  const chartH = reportChartHeight(payload, print, compact, inline)
  switch (payload.kind) {
    case 'table': return <TableClip p={payload} pal={pal} maxRows={tableCap} print={print} />
    case 'kpi':   return <KpiClip p={payload} pal={pal} />
    case 'chart': return <ChartClip p={payload} pal={pal} height={chartH} print={print} />
    case 'text':  return <TextClip p={payload} pal={pal} />
  }
}
