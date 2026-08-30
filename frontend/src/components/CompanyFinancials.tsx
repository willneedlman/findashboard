import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../lib/theme'

const MONO = 'var(--theme-mono)'
const LABEL = 'var(--theme-sans)'

interface Row { label: string; unit: string; values: (number | null)[]; primary: boolean }
interface Resp {
  available: boolean
  reason?: string
  ticker?: string
  frequency?: string
  periods?: string[]
  statements?: Record<string, Row[]>
  source?: string
}

// The three statements, in the order a filing presents them. These are the
// `group` values the endpoint already tags each field with, so the selector is
// a filter rather than a second mapping that could drift from the backend.
const STATEMENTS = [
  { key: 'income', label: 'Income' },
  { key: 'balance', label: 'Balance sheet' },
  { key: 'cashflow', label: 'Cash flow' },
] as const

// Yahoo reports five periods at each frequency, so there is no range to choose.
// Annual against quarterly is the choice that matters, and a statements page
// without quarterly can only answer half the questions asked of it.
const FREQUENCIES = [
  { key: 'annual', label: 'Annual' },
  { key: 'quarterly', label: 'Quarterly' },
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
    case 'rate': return `${(v * 100).toFixed(1)}%`
    case '%': return `${(v * 100).toFixed(1)}%`
    default: return magnitude(v)
  }
}

export default function CompanyFinancials({ ticker }: { ticker: string }) {
  const [statement, setStatement] = useState<string>('income')
  const [freq, setFreq] = useState<string>('annual')

  const q = useQuery<Resp>({
    queryKey: ['company-statements', ticker, freq],
    queryFn: () => axios
      .get(`/api/corporate/statements?ticker=${encodeURIComponent(ticker)}&freq=${freq}`)
      .then(r => r.data),
    retry: 0,
  })

  const rows = q.data?.statements?.[statement] ?? []
  const periods = q.data?.periods ?? []

  const controls = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      marginBottom: 12, paddingBottom: 10, borderBottom: `1px solid ${T.border}`,
    }}>
      <Seg options={STATEMENTS.map(s => ({ value: s.key, label: s.label }))}
           value={statement} onChange={setStatement} />
      <div style={{ flex: 1 }} />
      <Seg options={FREQUENCIES.map(f => ({ value: f.key, label: f.label }))}
           value={freq} onChange={setFreq} />
    </div>
  )

  if (q.isLoading) return <Frame>{controls}<Note>Loading statements…</Note></Frame>

  // The ordinary answer for an ETF, a fund, or anything that does not file.
  // An empty table would read as a fault in the page rather than a fact about
  // the security.
  if (q.isError || !q.data?.available) {
    const why = q.data?.reason === 'source_error'
      ? `Statements could not be loaded for ${ticker} just now. Try again shortly.`
      : `No financial statements are published for ${ticker}. That is expected for an `
        + 'ETF, a closed-end fund, or any security that is not an operating company.'
    return <Frame>{controls}<Note>{why}</Note></Frame>
  }

  return (
    <Frame>
      {controls}
      <div style={{
        fontFamily: MONO, fontSize: 9, color: T.muted, letterSpacing: '0.04em', marginBottom: 8,
      }}>
        {q.data.source} · {rows.length} lines · {periods.length} periods
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%', borderCollapse: 'collapse',
          fontFamily: MONO, fontSize: 11.5, fontVariantNumeric: 'tabular-nums',
        }}>
          <thead>
            <tr>
              <th style={{ ...TH, textAlign: 'left', minWidth: 230 }}>Breakdown</th>
              {periods.map(p => <th key={p} style={TH}>{p}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              // The first line the filer does NOT report on Yahoo's own summary
              // starts the supplementary block, so the reader can see where the
              // headline statement ends.
              const startsExtras = r.primary === false && rows[i - 1]?.primary !== false
              return (
                <tr key={r.label} style={{
                  borderTop: startsExtras
                    ? `1px solid ${T.border}`
                    : '1px solid var(--theme-border-faint, rgba(255,255,255,0.04))',
                }}>
                  <td style={{
                    padding: '5px 10px', whiteSpace: 'nowrap',
                    color: r.primary ? T.text : T.muted,
                    fontWeight: r.primary ? 400 : 300,
                  }}>
                    {r.label}
                  </td>
                  {r.values.map((v, j) => (
                    <td key={j} style={{
                      padding: '5px 10px', textAlign: 'right', whiteSpace: 'nowrap',
                      color: v == null ? T.muted : (r.primary ? T.text : T.muted),
                    }}>
                      {formatValue(v, r.unit)}
                    </td>
                  ))}
                </tr>
              )
            })}
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
