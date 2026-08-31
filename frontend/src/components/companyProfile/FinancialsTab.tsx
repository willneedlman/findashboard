import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../../lib/theme'
import EmptyState from '../EmptyState'
import { MONO, SANS, BRIGHT, DIM, ROW_LINE, STRIP } from './ui'
import { DASH } from './format'

interface Row { label: string; unit: string; values: (number | null)[]; primary: boolean }
interface Resp {
  available: boolean; reason?: string
  frequency?: string; periods?: string[]
  statements?: Record<string, Row[]>
  source?: string
}

const STATEMENTS = [
  { key: 'income', label: 'Income' },
  { key: 'balance', label: 'Balance' },
  { key: 'cashflow', label: 'Cash flow' },
] as const

const FREQUENCIES = [
  { key: 'annual', label: 'Annual' },
  { key: 'quarterly', label: 'Quarterly' },
] as const

const VIEWS = [
  { key: 'table', label: 'Table' },
  { key: 'trend', label: 'Trend' },
] as const

/** Lines that close a section rather than feed one. They carry the weight and
 *  the row fill, so the eye can find the subtotals without reading every line. */
const SUBTOTALS = new Set([
  'Total Revenue', 'Gross Profit', 'Operating Income', 'Pretax Income',
  'Net Income Common Stockholders', 'Net Income From Continuing Operation Net Minority Interest',
  'EBITDA', 'EBIT', 'Total Expenses',
  'Total Assets', 'Total Liabilities Net Minority Interest', 'Total Equity Gross Minority Interest',
  'Total Capitalization', 'Total Debt', 'Net Debt', 'Working Capital',
  'Operating Cash Flow', 'Investing Cash Flow', 'Financing Cash Flow',
  'Free Cash Flow', 'End Cash Position',
])

/** The six lines each statement is read by, in the handoff's order. */
const TREND: Record<string, string[]> = {
  income: ['Total Revenue', 'Gross Profit', 'Operating Income',
           'Net Income Common Stockholders', 'EBITDA', 'Diluted EPS'],
  balance: ['Total Assets', 'Cash And Cash Equivalents', 'Total Debt',
            'Total Equity Gross Minority Interest', 'Working Capital', 'Tangible Book Value'],
  cashflow: ['Operating Cash Flow', 'Free Cash Flow', 'Capital Expenditure',
             'Stock Based Compensation', 'Repurchase Of Capital Stock', 'End Cash Position'],
}

/** Bar heights for one trend card, scaled to the largest ABSOLUTE value in the
 *  set so a series that crosses zero still reads.
 *
 *  Returned as a list rather than computed per bar, because the scale has to be
 *  shared: computing it inside the loop is how a bar ends up sized against
 *  something other than its own row.
 */
export function barHeights(values: (number | null)[], cap = 68, floor = 3): number[] {
  const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  const max = finite.length ? Math.max(...finite.map(Math.abs)) : 0
  return values.map(v => {
    if (typeof v !== 'number' || !Number.isFinite(v) || max <= 0) return floor
    return Math.max(floor, (Math.abs(v) / max) * cap)
  })
}

/** Statement money, at the magnitude a filing is read in. Anything at or above
 *  a billion reads as billions; below that, millions. */
function money(v: number | null, unit: string): string {
  if (v == null || !Number.isFinite(v)) return DASH
  if (unit === '$/sh') return v.toFixed(2)
  if (unit === 'sh') return `${(v / 1e9).toFixed(3)}B`
  if (unit === 'rate') return `${(v * 100).toFixed(1)}%`
  const abs = Math.abs(v)
  const body = abs >= 1e9 ? `${(abs / 1e9).toFixed(2)}B` : `${Math.round(abs / 1e6)}M`
  // A negative on a statement is in parentheses, which is how a filing prints
  // it and how an accountant reads it.
  return v < 0 ? `(${body})` : body
}

/** FY2025, or Q2 2026. The API returns period end dates. */
function periodLabel(iso: string, freq: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const y = d.getUTCFullYear()
  if (freq === 'quarterly') return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${y}`
  return `FY${y}`
}

export default function FinancialsTab({ ticker }: { ticker: string }) {
  const [statement, setStatement] = useState<string>('income')
  const [freq, setFreq] = useState<string>('annual')
  const [view, setView] = useState<string>('table')

  const q = useQuery<Resp>({
    queryKey: ['cp-statements', ticker, freq],
    queryFn: () => axios
      .get(`/api/corporate/statements?ticker=${encodeURIComponent(ticker)}&freq=${freq}`)
      .then(r => r.data),
    staleTime: 600_000, retry: 0, enabled: !!ticker,
  })

  const rawRows = q.data?.statements?.[statement] ?? []
  const rawPeriods = q.data?.periods ?? []

  // Yahoo pads its period list to a fixed width, so the oldest column often
  // carries a label and no figures on any line. A column of em-dashes is not a
  // fact about the company, so drop the periods nothing reports.
  const { rows, periods, sparse } = useMemo(() => {
    const filled = rawPeriods.map((_, i) => rawRows.filter(r => r.values?.[i] != null).length)
    const keep = filled.map(n => n > 0)
    // A period reported on a handful of lines is kept, because those figures are
    // real, but it is named below the table so a column of em-dashes reads as
    // the source's coverage rather than as a broken render.
    const sparse = rawPeriods
      .map((p, i) => ({ p, i, n: filled[i] }))
      .filter(x => x.n > 0 && rawRows.length > 0 && x.n / rawRows.length < 0.25)
    if (keep.every(Boolean)) return { rows: rawRows, periods: rawPeriods, sparse }
    return {
      rows: rawRows.map(r => ({ ...r, values: r.values.filter((_, i) => keep[i]) })),
      periods: rawPeriods.filter((_, i) => keep[i]),
      sparse: sparse.filter(x => keep[x.i]),
    }
  }, [rawRows, rawPeriods])

  const labels = useMemo(() => periods.map(p => periodLabel(p, freq)), [periods, freq])

  const sparseNote = sparse.length
    ? `${sparse.map(x => periodLabel(x.p, freq)).join(' and ')} ${sparse.length > 1 ? 'are' : 'is'} only partly reported by this source: `
      + sparse.map(x => `${x.n} of ${rows.length} lines`).join(', ') + '.'
    : ''

  const controls = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap',
      background: T.surface, border: `1px solid ${T.border}`, padding: '11px 16px',
      marginBottom: 20,
    }}>
      <Group label="Statement">
        <Seg options={STATEMENTS} value={statement} onChange={setStatement} />
      </Group>
      <Group label="Frequency">
        <Seg options={FREQUENCIES} value={freq} onChange={setFreq} />
      </Group>
      <Group label="View">
        <Seg options={VIEWS} value={view} onChange={setView} />
      </Group>
      <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: DIM }}>
        {rows.length} lines available
        {view === 'trend' ? ', 6 shown' : `, ${rows.length} shown`}
      </span>
    </div>
  )

  if (!q.isLoading && !q.data?.available) {
    return (
      <>
        {controls}
        <EmptyState
          title="Financials"
          hint="No financial statements are published for this symbol. That is expected for an ETF, a closed-end fund, or any security that is not an operating company."
        />
      </>
    )
  }

  return (
    <>
      {controls}
      {view === 'table'
        ? <TableView rows={rows} labels={labels} sparseNote={sparseNote} />
        : <TrendView rows={rows} labels={labels} statement={statement} />}
    </>
  )
}

function TableView({ rows, labels, sparseNote }: { rows: Row[]; labels: string[]; sparseNote: string }) {
  return (
    <div style={{ background: T.bg, border: `1px solid ${T.border}`, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {/* Sticky so the line item stays readable while the periods scroll. */}
            <th style={{ ...th, textAlign: 'left', position: 'sticky', left: 0, zIndex: 1, minWidth: 240 }}>
              Line item
            </th>
            {labels.map(l => <th key={l} style={th}>{l}</th>)}
            <th style={th}>YoY</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const sub = SUBTOTALS.has(r.label)
            // Computed from the two most recent columns, which are the first two
            // the API returns.
            const [now, prev] = [r.values[0], r.values[1]]
            // Divided by the ABSOLUTE prior value, so a line that improves from
            // a loss to a smaller loss reads as growth rather than as decline.
            const growth = now != null && prev != null && prev !== 0
              ? ((now - prev) / Math.abs(prev)) * 100
              : null
            return (
              <tr key={r.label} style={{
                borderBottom: ROW_LINE,
                background: sub ? 'rgba(255,255,255,0.022)' : 'transparent',
              }}>
                <td style={{
                  ...td, textAlign: 'left', fontFamily: SANS, fontSize: 12,
                  fontWeight: sub ? 700 : 400,
                  color: sub ? BRIGHT : T.muted,
                  position: 'sticky', left: 0,
                  // The sticky cell needs an opaque fill or the scrolling
                  // columns show through it. Mixed from the row's own tint
                  // rather than a literal, so it follows a retheme.
                  background: sub
                    ? 'color-mix(in srgb, #fff 2.2%, var(--theme-bg))'
                    : T.bg,
                }}>
                  {r.label}
                </td>
                {r.values.map((v, i) => (
                  <td key={i} style={{
                    ...td,
                    color: v != null && v < 0 ? 'var(--theme-negative)' : (sub ? BRIGHT : T.text),
                    fontWeight: sub ? 700 : 400,
                  }}>
                    {money(v, r.unit)}
                  </td>
                ))}
                <td style={{
                  ...td, fontSize: 11.5, fontWeight: 700,
                  color: growth == null ? T.muted
                    : growth >= 0 ? 'var(--theme-positive)' : 'var(--theme-negative)',
                }}>
                  {growth == null ? DASH : `${growth > 0 ? '+' : ''}${growth.toFixed(1)}%`}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {sparseNote && (
        <div style={{
          padding: '9px 16px', borderTop: `1px solid ${T.borderFaint}`,
          fontFamily: MONO, fontSize: 10, color: T.muted,
        }}>
          {sparseNote}
        </div>
      )}
    </div>
  )
}

function TrendView({ rows, labels, statement }: {
  rows: Row[]; labels: string[]; statement: string
}) {
  const byLabel = new Map(rows.map(r => [r.label, r]))
  const picked = (TREND[statement] ?? []).map(l => byLabel.get(l)).filter((r): r is Row => !!r)

  if (!picked.length) {
    return (
      <div style={{ padding: 18, fontFamily: MONO, fontSize: 11, color: T.muted }}>
        None of the six trend lines were reported for this statement.
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16 }}>
      {picked.map(r => <TrendCard key={r.label} row={r} labels={labels} />)}
    </div>
  )
}

function TrendCard({ row, labels }: { row: Row; labels: string[] }) {
  // Oldest to newest, left to right, which is the reverse of the table's column
  // order: a table is read most-recent-first, a trend is read as time passing.
  const values = [...row.values].reverse()
  const periods = [...labels].reverse()
  const heights = barHeights(values)
  const latest = row.values[0]
  const prev = row.values[1]
  const growth = latest != null && prev != null && prev !== 0
    ? ((latest - prev) / Math.abs(prev)) * 100
    : null

  return (
    <div style={{ background: T.bg, border: `1px solid ${T.border}`, padding: '14px 16px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{
          fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: T.muted, flex: 1, minWidth: 0,
        }}>
          {row.label}
        </span>
        <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: BRIGHT }}>
          {money(latest, row.unit)}
        </span>
        <span style={{
          fontFamily: MONO, fontSize: 11.5, fontWeight: 700,
          color: growth == null ? T.muted
            : growth >= 0 ? 'var(--theme-positive)' : 'var(--theme-negative)',
        }}>
          {growth == null ? DASH : `${growth > 0 ? '+' : ''}${growth.toFixed(1)}%`}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', height: 92, marginTop: 12 }}>
        {values.map((v, i) => {
          const newest = i === values.length - 1
          const h = heights[i]
          const fill = v != null && v < 0
            ? 'color-mix(in srgb, var(--theme-negative) 55%, transparent)'
            : newest
              ? 'var(--theme-primary)'
              : 'color-mix(in srgb, var(--theme-tertiary) 62%, transparent)'
          return (
            <div key={i} style={{
              flex: 1, display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'flex-end', gap: 5, minWidth: 0,
            }}>
              <span style={{ fontFamily: MONO, fontSize: 10, color: DIM, whiteSpace: 'nowrap' }}>
                {money(v, row.unit)}
              </span>
              <div style={{ width: '100%', height: h, background: fill }} />
            </div>
          )
        })}
      </div>

      <div style={{
        display: 'flex', gap: 10, marginTop: 7, paddingTop: 7,
        borderTop: `1px solid ${T.borderFaint}`,
      }}>
        {periods.map(p => (
          <span key={p} style={{
            flex: 1, textAlign: 'center', fontFamily: MONO, fontSize: 9.5, color: DIM,
          }}>
            {p}
          </span>
        ))}
      </div>
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <span style={{
        fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: DIM,
      }}>
        {label}
      </span>
      {children}
    </div>
  )
}

function Seg({ options, value, onChange }: {
  options: readonly { key: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div style={{ display: 'inline-flex', gap: 2 }}>
      {options.map(o => {
        const on = o.key === value
        return (
          <button key={o.key} onClick={() => onChange(o.key)} style={{
            fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em',
            textTransform: 'uppercase', padding: '5px 11px', cursor: 'pointer',
            background: 'transparent',
            border: `1px solid ${on ? 'color-mix(in srgb, var(--theme-primary) 35%, transparent)' : 'transparent'}`,
            color: on ? T.gold : T.muted,
            transition: 'color 120ms cubic-bezier(0.23,1,0.32,1), border-color 120ms cubic-bezier(0.23,1,0.32,1)',
          }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

const th: React.CSSProperties = {
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: T.muted, textAlign: 'right',
  padding: '11px 16px', whiteSpace: 'nowrap',
  background: STRIP, borderBottom: `1px solid ${T.border}`,
}

const td: React.CSSProperties = {
  padding: '9px 16px', textAlign: 'right', whiteSpace: 'nowrap',
  fontFamily: MONO, fontSize: 12, fontVariantNumeric: 'tabular-nums', color: T.text,
}
