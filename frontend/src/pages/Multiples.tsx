import { useState, useMemo } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import MetricCard from '../components/MetricCard'
import EmptyState from '../components/EmptyState'

const INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '5px 8px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}
const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block',
}
const TH: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }
const TD: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '6px 8px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }

type Metric = { key: string; label: string; per_share: number; current_mult: number | null; ev_based: boolean }
type MultiplesData = {
  ticker: string; price?: number | null; shares?: number; net_debt?: number; metrics: Metric[]; note?: string
}

export function MultiplesContent() {
  const [ticker, setTicker] = useState('AAPL')
  const [data, setData] = useState<MultiplesData | null>(null)
  const [target, setTarget] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true); setError(null)
    try {
      const res = await axios.get(`/api/valuation/multiples?ticker=${ticker.trim().toUpperCase()}`)
      const d: MultiplesData = res.data
      setData(d)
      const seed: Record<string, number> = {}
      for (const m of d.metrics) if (m.current_mult != null) seed[m.key] = m.current_mult
      setTarget(seed)
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Could not load multiples.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  const rows = useMemo(() => {
    if (!data) return null
    const netDebtPS = (data.shares && data.net_debt != null) ? data.net_debt / data.shares : 0
    const out = data.metrics.map(m => {
      const mult = target[m.key] ?? m.current_mult ?? 0
      const implied = m.ev_based ? mult * m.per_share - netDebtPS : mult * m.per_share
      const upside = data.price ? (implied / data.price - 1) * 100 : null
      return { ...m, mult, implied, upside }
    })
    const valid = out.filter(r => isFinite(r.implied) && r.implied > 0)
    const avg = valid.length ? valid.reduce((a, r) => a + r.implied, 0) / valid.length : null
    const avgUpside = (avg != null && data.price) ? (avg / data.price - 1) * 100 : null
    return { out, avg, avgUpside }
  }, [data, target])

  return (
    <SidebarLayout sidebarWidth={210} sidebarTitle="Multiples Inputs" sidebar={<>
      <div style={{ marginBottom: 12 }}>
        <label style={LABEL}>Ticker</label>
        <input style={INPUT} value={ticker} onChange={e => setTicker(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()} placeholder="AAPL" />
      </div>
      <button onClick={load} disabled={loading}
        style={{ ...INPUT, width: '100%', cursor: 'pointer', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
          color: 'var(--theme-primary, #c9a84c)', borderColor: 'var(--theme-primary, #c9a84c)', marginBottom: 16 }}>
        {loading ? 'Loading…' : 'Load multiples'}
      </button>
      {data && data.metrics.length > 0 && (
        <div style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-secondary, #99907e)', lineHeight: 1.8 }}>
          <div style={{ marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Set a target multiple per line in the table. Implied price updates live.</div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Market price</span><span>${data.price?.toFixed(2)}</span></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Net debt</span><span>${(data.net_debt ?? 0).toFixed(0)}M</span></div>
        </div>
      )}
    </>}>

      {error && <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {!data && !error && (
        <EmptyState title="Multiples Valuation" hint="Enter a ticker and Load multiples, then set a target multiple per line to see the implied share price." />
      )}

      {data && !data.metrics.length && (
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.7 }}>
          {data.note || 'No usable per-share metrics for this ticker.'}
        </div>
      )}

      {rows && data!.metrics.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <MetricCard label="Blended implied value" value={rows.avg != null ? `$${rows.avg.toFixed(2)}` : 'n/a'} />
            <MetricCard label="Market price" value={data!.price ? `$${data!.price.toFixed(2)}` : 'n/a'} />
            <MetricCard label="Upside vs price" value={rows.avgUpside != null ? `${rows.avgUpside > 0 ? '+' : ''}${rows.avgUpside.toFixed(1)}%` : 'n/a'} deltaPositive={(rows.avgUpside ?? 0) >= 0} />
          </div>

          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...TH, textAlign: 'left' }}>Multiple</th>
                <th style={TH}>Per share</th><th style={TH}>Current</th><th style={TH}>Target</th><th style={TH}>Implied price</th><th style={TH}>Upside</th>
              </tr></thead>
              <tbody>
                {rows.out.map(r => (
                  <tr key={r.key}>
                    <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }}>{r.label}</td>
                    <td style={TD}>{r.ev_based ? `$${r.per_share.toFixed(2)} EBITDA` : `$${r.per_share.toFixed(2)}`}</td>
                    <td style={{ ...TD, color: 'var(--theme-secondary, #99907e)' }}>{r.current_mult != null ? `${r.current_mult.toFixed(1)}x` : '—'}</td>
                    <td style={{ ...TD, padding: '3px 8px' }}>
                      <input type="number" step={0.5} value={Number(r.mult.toFixed(1))}
                        onChange={e => setTarget(t => ({ ...t, [r.key]: Number(e.target.value) }))}
                        style={{ ...INPUT, width: 70, padding: '3px 6px', textAlign: 'right', color: 'var(--theme-primary, #c9a84c)' }} />
                    </td>
                    <td style={TD}>{isFinite(r.implied) && r.implied > 0 ? `$${r.implied.toFixed(2)}` : '—'}</td>
                    <td style={{ ...TD, color: (r.upside ?? 0) >= 0 ? '#3fb950' : '#f85149' }}>
                      {r.upside != null && isFinite(r.implied) ? `${r.upside > 0 ? '+' : ''}${r.upside.toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, letterSpacing: '0.06em', color: 'var(--theme-secondary, #99907e)' }}>
            EV/EBITDA implied price nets out debt per share. Blended value is the simple average of the positive implied prices.
          </div>
        </div>
      )}
    </SidebarLayout>
  )
}

export default function Multiples() {
  return <PageWrapper title="Multiples Valuation"><MultiplesContent /></PageWrapper>
}
