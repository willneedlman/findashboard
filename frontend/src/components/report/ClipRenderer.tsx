import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import type { ClipPayload, ChartPayload, TablePayload, KpiPayload, TextPayload } from '../../lib/reportCreator'
import type { ClipPalette } from '../../lib/reportTheme'

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

function TableClip({ p, pal, maxRows }: { p: TablePayload; pal: Palette; maxRows?: number }) {
  const rows = maxRows != null && maxRows > 0 ? p.rows.slice(0, maxRows) : p.rows
  const truncated = rows.length < p.rows.length
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 10 }}>
        <thead>
          <tr>
            {p.columns.map((c, i) => (
              <th key={i} style={{
                padding: '5px 8px', textAlign: i === 0 ? 'left' : 'right', color: pal.muted,
                fontFamily: SANS, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em',
                textTransform: 'uppercase', borderBottom: `1px solid ${pal.border}`,
                background: pal.headBg, whiteSpace: 'nowrap',
              }}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} style={{
                  padding: '4px 8px', textAlign: c === 0 ? 'left' : 'right', color: pal.ink,
                  borderBottom: `1px solid ${pal.border}`, fontVariantNumeric: 'tabular-nums',
                  whiteSpace: 'nowrap',
                }}>{cell == null ? '—' : String(cell)}</td>
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
          {row.map((k, ci) => (
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
                fontFamily: MONO, fontSize: 15, fontWeight: 700, color: pal.ink, marginTop: 3,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{k.value}</div>
              {k.sub && (
                <div style={{
                  fontFamily: MONO, fontSize: 8, color: pal.muted, marginTop: 2,
                  lineHeight: 1.3, whiteSpace: 'normal', wordBreak: 'break-word',
                }}>{k.sub}</div>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ── Chart axis helpers ─────────────────────────────────────────────────────

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

function fmtTick(v: number, kind: 'auto' | 'pct' | 'price' | 'compact' = 'auto'): string {
  if (!Number.isFinite(v)) return ''
  if (kind === 'pct' || (kind === 'auto' && Math.abs(v) <= 200 && Math.abs(v) > 0 && Math.abs(v) < 100 && Number.isInteger(Math.round(v * 10)))) {
    // Prefer plain number; callers pass kind when known.
  }
  const a = Math.abs(v)
  if (kind === 'price' || (kind === 'auto' && a >= 20 && a < 1e6)) {
    if (a >= 100) return v.toFixed(0)
    if (a >= 10) return v.toFixed(1)
    return v.toFixed(2)
  }
  if (kind === 'pct') {
    return `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(a >= 10 ? 0 : 1)}`
  }
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  if (a >= 100) return v.toFixed(0)
  if (a >= 10) return v.toFixed(1)
  if (a >= 1) return v.toFixed(2)
  return v.toFixed(2)
}

function inferTickKind(stats: { mid: number; max: number; min: number; label: string }[]): 'auto' | 'pct' | 'price' {
  const label = stats.map(s => s.label).join(' ').toLowerCase()
  if (/\b(iv|vol|%|pct|percent|rank|premium|share)\b/.test(label)) return 'pct'
  if (/\b(price|spot|strike|\$|nav|fair)\b/.test(label)) return 'price'
  if (!stats.length) return 'auto'
  const maxAbs = Math.max(...stats.map(s => Math.max(Math.abs(s.max), Math.abs(s.min))))
  if (maxAbs <= 150 && maxAbs > 0) return 'auto'
  return 'auto'
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

function ChartClip({
  p, pal, height, print = false,
}: {
  p: ChartPayload
  pal: Palette
  height: number
  print?: boolean
}) {
  // Bar charts: keep all categories (strikes). Line/area: light downsample if huge.
  const data = p.chartType === 'bar' || p.data.length <= 60
    ? p.data
    : p.data.filter((_, i) => i % Math.ceil(p.data.length / 50) === 0 || i === p.data.length - 1)

  const { left, right } = partitionScales(p)
  const dual = right.length > 0
  const leftKind = inferTickKind(left)
  const rightKind = dual ? inferTickKind(right) : 'auto'
  const axisTick = { fontFamily: MONO, fontSize: print ? 8 : 9, fill: pal.muted }

  // X ticks: limit count for readability
  const xCount = data.length
  const xInterval = xCount <= 8 ? 0 : xCount <= 16 ? 1 : Math.floor(xCount / 6)

  const yTick = (kind: typeof leftKind) => (v: number) => fmtTick(v, kind)

  const margin = print
    ? { top: 8, right: dual ? 36 : 8, left: 2, bottom: p.chartType === 'bar' && xCount > 12 ? 4 : 2 }
    : { top: 8, right: dual ? 44 : 12, left: 2, bottom: 0 }

  const leftKeys = new Set(left.map(s => s.key))
  const commonX = (
    <XAxis
      dataKey={p.xKey}
      tick={axisTick}
      tickLine={false}
      axisLine={{ stroke: pal.border }}
      interval={xInterval}
      minTickGap={print ? 12 : 20}
      tickFormatter={formatXTick}
      height={print ? 28 : 30}
    />
  )

  const yLeft = (
    <YAxis
      yAxisId="left"
      orientation="left"
      tick={axisTick}
      tickLine={false}
      axisLine={false}
      width={print ? 42 : 48}
      tickFormatter={yTick(leftKind)}
      domain={['auto', 'auto']}
    />
  )
  const yRight = dual ? (
    <YAxis
      yAxisId="right"
      orientation="right"
      tick={axisTick}
      tickLine={false}
      axisLine={false}
      width={print ? 36 : 44}
      tickFormatter={yTick(rightKind)}
      domain={['auto', 'auto']}
    />
  ) : null

  const grid = <CartesianGrid strokeDasharray="3 3" stroke={pal.gridStroke} />
  const tip = !print ? (
    <Tooltip
      contentStyle={{ background: 'var(--theme-surface, #0d1826)', border: `1px solid ${pal.border}`, fontFamily: MONO, fontSize: 10 }}
      labelStyle={{ color: pal.accent }}
    />
  ) : null

  // Legend always when dual scale or multi-series so axes make sense.
  const showLegend = p.series.length > 1 || dual

  return (
    <div style={{ width: '100%', minHeight: height }}>
      <ResponsiveContainer width="100%" height={height} debounce={1}>
        {p.chartType === 'bar' ? (
          <BarChart data={data} margin={margin}>
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
                fill={seriesColor(pal, s.color, i, print)}
                isAnimationActive={false}
                maxBarSize={print ? 18 : 28}
              />
            ))}
            {showLegend && (
              <Legend
                wrapperStyle={{ fontFamily: MONO, fontSize: 8.5, color: pal.muted, paddingTop: 4 }}
                iconType="square"
                iconSize={8}
              />
            )}
          </BarChart>
        ) : p.chartType === 'area' ? (
          <AreaChart data={data} margin={margin}>
            {grid}
            {commonX}
            {yLeft}
            {yRight}
            {tip}
            {p.series.map((s, i) => {
              const c = seriesColor(pal, s.color, i, print)
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
                  strokeWidth={1.6}
                  isAnimationActive={false}
                />
              )
            })}
            {showLegend && (
              <Legend
                wrapperStyle={{ fontFamily: MONO, fontSize: 8.5, color: pal.muted, paddingTop: 4 }}
                iconType="line"
                iconSize={10}
              />
            )}
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
                stroke={seriesColor(pal, s.color, i, print)}
                dot={false}
                strokeWidth={1.7}
                connectNulls
                isAnimationActive={false}
              />
            ))}
            {showLegend && (
              <Legend
                wrapperStyle={{ fontFamily: MONO, fontSize: 8.5, color: pal.muted, paddingTop: 4 }}
                iconType="line"
                iconSize={10}
              />
            )}
          </LineChart>
        )}
      </ResponsiveContainer>
      {dual && (
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

export default function ClipRenderer({
  payload,
  mode = 'dark',
  compact,
  maxTableRows,
  palette,
}: {
  payload: ClipPayload
  mode?: 'dark' | 'print'
  compact?: boolean
  maxTableRows?: number
  /** Theme-derived palette for print mode (active color preset). */
  palette?: ClipPalette
}) {
  const print = mode === 'print'
  const pal = print ? (palette ?? PRINT_FALLBACK) : DARK
  const tableCap = maxTableRows ?? (print ? 10 : undefined)
  // Full-width print charts get real height; compact only for side-by-side.
  const chartH = print
    ? (compact ? 168 : 210)
    : (compact ? 170 : 230)
  switch (payload.kind) {
    case 'table': return <TableClip p={payload} pal={pal} maxRows={tableCap} />
    case 'kpi':   return <KpiClip p={payload} pal={pal} />
    case 'chart': return <ChartClip p={payload} pal={pal} height={chartH} print={print} />
    case 'text':  return <TextClip p={payload} pal={pal} />
  }
}
