import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../lib/theme'

const MONO = 'var(--theme-mono)'
const LABEL = 'var(--theme-sans)'

interface Field { key: string; label: string; unit: string; group: string }
interface Period { fiscalYear: number; date: string; estimate?: boolean; [k: string]: unknown }
interface Resp {
  ticker: string
  source: string
  reportedCurrency?: string
  fields: Field[]
  periods: Period[]
}

// The three statements, in the order a filing presents them. These are the
// `group` values the endpoint already tags each field with, so the selector is
// a filter rather than a second mapping that could drift from the backend.
const STATEMENTS = [
  { group: 'Income', label: 'Income' },
  { group: 'Balance', label: 'Balance sheet' },
  { group: 'Cash flow', label: 'Cash flow' },
] as const

// Columns are periods, and AAPL has seventeen of them. A single-year picker
// would hide the comparison that makes a statement worth reading, so the
// control sets how far back to go instead.
const RANGES = [
  { years: 5, label: '5Y' },
  { years: 10, label: '10Y' },
  { years: 0, label: 'All' },
] as const

/** Money at the magnitude a reader thinks in. Never scientific notation, which
 *  is what `toLocaleString` on a trillion-dollar balance sheet can produce. */
function magnitude(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toFixed(0)
}

export function formatValue(v: unknown, unit: string): string {
  // A gap is a gap. Rendering it as 0 states a fact the filing does not.
  if (v == null || typeof v !== 'number' || !Number.isFinite(v)) return '–'
  switch (unit) {
    case '$': return magnitude(v)
    case 'sh': return magnitude(v)
    case '$/sh': return v.toFixed(2)
    case 'x': return `${v.toFixed(1)}x`
    case '%': return `${(v * 100).toFixed(1)}%`
    default: return magnitude(v)
  }
}

export default function CompanyFinancials({ ticker }: { ticker: string }) {
  const [statement, setStatement] = useState<string>('Income')
  const [range, setRange] = useState<number>(10)

  const q = useQuery<Resp>({
    queryKey: ['company-financials', ticker],
    queryFn: () => axios.get(`/api/corporate/fundamental-history?ticker=${encodeURIComponent(ticker)}`)
      .then(r => r.data),
    retry: 0,
  })

  const rows = useMemo(
    () => (q.data?.fields ?? []).filter(f => f.group === statement),
    [q.data, statement],
  )

  const columns = useMemo(() => {
    // Forward estimate periods carry no filed statement, so they belong to the
    // estimates surface, not to a page showing what was reported.
    const filed = (q.data?.periods ?? []).filter(p => !p.estimate)
    const newestFirst = [...filed].sort((a, b) => b.fiscalYear - a.fiscalYear)
    return range > 0 ? newestFirst.slice(0, range) : newestFirst
  }, [q.data, range])

  if (q.isLoading) {
    return <Frame><Note>Loading filed statements…</Note></Frame>
  }

  // 404 is the ordinary answer for an ETF, a fund, or a company that has never
  // filed with SEC. Say which rather than showing an empty table, which reads
  // as a fault in the page.
  if (q.isError || !q.data?.periods?.length) {
    return (
      <Frame>
        <Note>
          No SEC-filed financial statements for {ticker}. This is expected for an ETF, a
          closed-end fund, or a company that does not file with the SEC.
        </Note>
      </Frame>
    )
  }

  const ccy = q.data.reportedCurrency || 'USD'

  return (
    <Frame>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
        marginBottom: 12, paddingBottom: 10, borderBottom: `1px solid ${T.border}`,
      }}>
        <Seg options={STATEMENTS.map(s => ({ value: s.group, label: s.label }))}
             value={statement} onChange={setStatement} />
        <div style={{ flex: 1 }} />
        <Seg options={RANGES.map(r => ({ value: String(r.years), label: r.label }))}
             value={String(range)} onChange={v => setRange(Number(v))} />
      </div>

      <div style={{
        fontFamily: MONO, fontSize: 9, color: T.muted, letterSpacing: '0.04em', marginBottom: 8,
      }}>
        {q.data.source} · figures in {ccy}
        {ccy !== 'USD' && ' · market values and multiples are omitted because the share price is in USD'}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontFamily: MONO, fontSize: 11.5, fontVariantNumeric: 'tabular-nums',
        }}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: 'left', minWidth: 170 }} />
              {columns.map(c => (
                <th key={c.fiscalYear} style={TH}>{c.fiscalYear}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(f => (
              <tr key={f.key} style={{ borderTop: `1px solid var(--theme-border-faint, rgba(255,255,255,0.04))` }}>
                <td style={{ padding: '5px 10px', color: T.text, whiteSpace: 'nowrap' }}>{f.label}</td>
                {columns.map(c => (
                  <td key={c.fiscalYear} style={{
                    padding: '5px 10px', textAlign: 'right', whiteSpace: 'nowrap',
                    color: c[f.key] == null ? T.muted : T.text,
                  }}>
                    {formatValue(c[f.key], f.unit)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Frame>
  )
}

const TH: React.CSSProperties = {
  fontFamily: LABEL, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: T.muted, textAlign: 'right',
  padding: '0 10px 7px', whiteSpace: 'nowrap',
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="ft-panel" style={{ padding: 16 }}>{children}</div>
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: MONO, fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
      {children}
    </div>
  )
}

function Seg({ options, value, onChange }: {
  options: { value: string; label: string }[]
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div style={{ display: 'inline-flex', border: `1px solid ${T.border}` }}>
      {options.map(o => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              fontFamily: LABEL, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', padding: '6px 12px', cursor: 'pointer',
              border: 'none',
              background: on ? 'color-mix(in srgb, var(--theme-primary) 16%, transparent)' : 'transparent',
              color: on ? T.gold : T.muted,
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
