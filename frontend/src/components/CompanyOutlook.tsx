import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../lib/theme'
import { formatValue } from './CompanyFinancials'

const MONO = 'var(--theme-mono)'
const LABEL = 'var(--theme-sans)'

interface GridRow {
  period: string; label: string
  avg: number | null; low: number | null; high: number | null
  yearAgo: number | null; analysts: number | null; growth: number | null
}
interface Surprise {
  quarter: string; actual: number | null; estimate: number | null
  difference: number | null; surprisePct: number | null
}
interface Estimates {
  available: boolean; reason?: string; currency?: string
  eps?: GridRow[]; revenue?: GridRow[]; surprises?: Surprise[]; source?: string
}
interface ValuationRow { key: string; label: string; unit: string; value: number | null }
interface Valuation { available: boolean; reason?: string; rows?: ValuationRow[]; source?: string }

interface Drift {
  period: string; label: string; current?: number | null
  d7_pct?: number | null; d30_pct?: number | null; d90_pct?: number | null
}
interface Breadth {
  period: string; label: string
  up_30d?: number | null; down_30d?: number | null; net_30d?: number | null
}
interface Revisions {
  available?: boolean; analyst_count?: number | null; direction?: string
  drift?: Drift[]; breadth?: Breadth[]
  targets?: { raises?: number; cuts?: number; maintains?: number; window_days?: number }
}

const pct = (v: number | null) =>
  v == null ? '–' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`

export default function CompanyOutlook({ ticker }: { ticker: string }) {
  const est = useQuery<Estimates>({
    queryKey: ['estimates-grid', ticker],
    queryFn: () => axios.get(`/api/corporate/estimates-grid?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    retry: 0,
  })
  const rev = useQuery<Revisions>({
    queryKey: ['hub-estimates', ticker],
    queryFn: () => axios.get(`/api/corporate/hub/estimates?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    retry: 0,
  })
  const val = useQuery<Valuation>({
    queryKey: ['valuation-measures', ticker],
    queryFn: () => axios.get(`/api/corporate/valuation-measures?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    retry: 0,
  })

  const loading = est.isLoading || val.isLoading
  const nothing = !loading
    && !(est.data?.available) && !(val.data?.available)

  if (loading) return <Panel title="Outlook"><Note>Loading consensus…</Note></Panel>
  if (nothing) {
    return (
      <Panel title="Outlook">
        <Note>
          No analyst coverage or valuation multiples are published for {ticker}. That is
          expected for an ETF, a fund, or a security analysts do not follow.
        </Note>
      </Panel>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {est.data?.available && !!est.data.surprises?.length && (
        <Panel title="Earnings surprise" note={`${est.data.source} · last ${est.data.surprises.length} quarters`}>
          <Table
            head={['Quarter', 'Estimate', 'Actual', 'Difference', 'Surprise']}
            rows={est.data.surprises.map(s => [
              s.quarter,
              formatValue(s.estimate, '$/sh'),
              formatValue(s.actual, '$/sh'),
              formatValue(s.difference, '$/sh'),
              // The sign is the whole point of the column, so it is coloured
              // rather than left for the reader to work out from a minus.
              <span key="s" style={{ color: (s.surprisePct ?? 0) >= 0 ? T.pos : T.neg }}>
                {pct(s.surprisePct)}
              </span>,
            ])}
          />
        </Panel>
      )}

      {est.data?.available && !!est.data.revenue?.length && (
        <Panel title="Revenue estimate" note={`Currency in ${est.data.currency}`}>
          <Grid rows={est.data.revenue} unit="$" />
        </Panel>
      )}

      {est.data?.available && !!est.data.eps?.length && (
        <Panel title="Earnings estimate" note={`Currency in ${est.data.currency}`}>
          <Grid rows={est.data.eps} unit="$/sh" />
        </Panel>
      )}

      {rev.data?.available && !!rev.data.drift?.length && (
        <Panel
          title="Estimate revisions"
          note={rev.data.targets
            ? `Targets over ${rev.data.targets.window_days ?? 120} days: `
              + `${rev.data.targets.raises ?? 0} raised, ${rev.data.targets.cuts ?? 0} cut, `
              + `${rev.data.targets.maintains ?? 0} maintained`
            : undefined}
        >
          {/* Drift answers whether the number is moving. The estimate grids
              above answer what the number is. Neither replaces the other. */}
          <Table
            head={['Period', 'Consensus', '7d', '30d', '90d', 'Up / down 30d']}
            rows={(rev.data.drift ?? []).map(dr => {
              const b = (rev.data?.breadth ?? []).find(x => x.period === dr.period)
              return [
                dr.label,
                formatValue(dr.current, '$/sh'),
                <Drift key="7" v={dr.d7_pct} />,
                <Drift key="30" v={dr.d30_pct} />,
                <Drift key="90" v={dr.d90_pct} />,
                b ? `${b.up_30d ?? 0} / ${b.down_30d ?? 0}` : '–',
              ]
            })}
          />
        </Panel>
      )}

      {val.data?.available && (
        <Panel title="Valuation measures" note={`${val.data.source} · current`}>
          <Table
            head={['Measure', 'Value']}
            rows={(val.data.rows ?? []).map(r => [r.label, formatValue(r.value, r.unit)])}
            align={['left', 'right']}
          />
        </Panel>
      )}
    </div>
  )
}

/** The estimate grid reads across periods, so periods are the columns and the
 *  measures are the rows, which is how Yahoo prints it. */
function Grid({ rows, unit }: { rows: GridRow[]; unit: string }) {
  const measures: [string, (r: GridRow) => string][] = [
    ['No. of analysts', r => (r.analysts == null ? '–' : String(r.analysts))],
    ['Avg. estimate', r => formatValue(r.avg, unit)],
    ['Low estimate', r => formatValue(r.low, unit)],
    ['High estimate', r => formatValue(r.high, unit)],
    ['Year ago', r => formatValue(r.yearAgo, unit)],
    ['Growth', r => pct(r.growth)],
  ]
  return (
    <Table
      head={['', ...rows.map(r => r.label)]}
      rows={measures.map(([label, fmt]) => [label, ...rows.map(fmt)])}
    />
  )
}

function Table({ head, rows, align }: {
  head: string[]
  rows: (string | React.ReactNode)[][]
  align?: ('left' | 'right')[]
}) {
  const at = (i: number) => align?.[i] ?? (i === 0 ? 'left' : 'right')
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{
        width: '100%', borderCollapse: 'collapse',
        fontFamily: MONO, fontSize: 11.5, fontVariantNumeric: 'tabular-nums',
      }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} style={{
                fontFamily: LABEL, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em',
                textTransform: 'uppercase', color: T.muted, textAlign: at(i),
                padding: '0 10px 7px', whiteSpace: 'nowrap',
                minWidth: i === 0 ? 140 : undefined,
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--theme-border-faint, rgba(255,255,255,0.04))' }}>
              {r.map((c, j) => (
                <td key={j} style={{
                  padding: '5px 10px', textAlign: at(j), whiteSpace: 'nowrap',
                  color: j === 0 ? T.text : T.text,
                }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Panel({ title, note, children }: {
  title: string; note?: string; children: React.ReactNode
}) {
  return (
    <div className="ft-panel" style={{ padding: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
        marginBottom: 12, paddingBottom: 9, borderBottom: `1px solid ${T.border}`,
      }}>
        <span style={{
          fontFamily: LABEL, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: T.gold,
        }}>{title}</span>
        {note && <span style={{ fontFamily: MONO, fontSize: 9, color: T.muted }}>{note}</span>}
      </div>
      {children}
    </div>
  )
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: MONO, fontSize: 11, color: T.muted, lineHeight: 1.6 }}>{children}</div>
}

/** A revision percent. Signed and coloured, with the number printed, because
 *  the direction is the whole content of the cell. */
function Drift({ v }: { v?: number | null }) {
  if (v == null) return <span>–</span>
  return (
    <span style={{ color: v >= 0 ? T.pos : T.neg }}>
      {`${v > 0 ? '+' : ''}${v.toFixed(2)}%`}
    </span>
  )
}
