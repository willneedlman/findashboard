import { Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { T } from '../lib/theme'

interface Period { label: string; is_estimate: boolean }
interface Row { label: string; unit: string; values: (number | null)[] }
interface Group { title: string; rows: Row[] }
interface Resp { available: boolean; ticker?: string; periods?: Period[]; groups?: Group[]; source?: string }

const MONO = 'var(--theme-mono)'
const LABEL = 'var(--theme-sans)'

function fmt(v: number | null, unit: string): string {
  if (v == null) return '—'
  switch (unit) {
    case '$M': return Math.abs(v) >= 1000 ? `$${(v / 1000).toFixed(1)}B` : `$${v.toFixed(0)}M`
    case '%': return `${v.toFixed(1)}%`
    case 'x': return `${v.toFixed(2)}x`
    case '$': return `$${v.toFixed(2)}`
    case 'd': return `${v.toFixed(0)}d`
    default: return String(v)
  }
}

// FactSet Overview financials + forward consensus estimates. Renders only when the
// key is entitled and the ticker is covered; otherwise nothing (graceful hide).
export default function FactSetFinancials({ ticker }: { ticker: string }) {
  const q = useQuery<Resp>({
    queryKey: ['factset-financials', ticker],
    queryFn: () => axios.get(`/api/factset/financials?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    enabled: !!ticker,
    staleTime: 6 * 3600_000,
    retry: 0,
  })
  const d = q.data
  if (!d?.available || !d.periods?.length || !d.groups?.length) return null

  const periods = d.periods
  const th: React.CSSProperties = { fontFamily: LABEL, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }

  return (
    <div className="ft-panel">
      <div className="ft-panel-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>Financials &amp; Estimates</span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: T.muted, letterSpacing: '0.04em' }}>FactSet · estimates marked *</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11.5 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left', minWidth: 150 }} />
              {periods.map((p, i) => (
                <th key={i} style={{ ...th, color: p.is_estimate ? T.gold : T.muted, background: p.is_estimate ? 'color-mix(in srgb, var(--theme-primary) 6%, transparent)' : 'transparent' }}>
                  {p.label}{p.is_estimate ? ' *' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.groups.map(g => (
              <Fragment key={g.title}>
                <tr>
                  <td colSpan={periods.length + 1} style={{ fontFamily: LABEL, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.gold, padding: '10px 10px 5px', borderTop: `1px solid ${T.border}` }}>{g.title}</td>
                </tr>
                {g.rows.map(r => (
                  <tr key={g.title + r.label} style={{ borderTop: `1px solid var(--theme-border-faint, rgba(255,255,255,0.04))` }}>
                    <td style={{ padding: '5px 10px', color: T.text, whiteSpace: 'nowrap' }}>{r.label}</td>
                    {r.values.map((v, i) => (
                      <td key={i} style={{ padding: '5px 10px', textAlign: 'right', color: periods[i]?.is_estimate ? T.gold : T.text, background: periods[i]?.is_estimate ? 'color-mix(in srgb, var(--theme-primary) 4%, transparent)' : 'transparent', whiteSpace: 'nowrap' }}>
                        {fmt(v, r.unit)}
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
