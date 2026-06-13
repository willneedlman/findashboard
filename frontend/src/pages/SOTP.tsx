import { useState, useMemo } from 'react'
import { ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import MetricCard from '../components/MetricCard'
import EmptyState from '../components/EmptyState'
import { useChartColors } from '../hooks/useChartColors'

const INPUT: React.CSSProperties = {
  background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
  color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '5px 8px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}
const LABEL: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: 'var(--theme-secondary, #99907e)', marginBottom: 4, display: 'block',
}
const TOOLTIP_STYLE = { background: 'var(--theme-surface, #142032)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', borderRadius: 0 }
const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #99907e)', fontFamily: 'var(--theme-mono)' }
const TH: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', padding: '6px 8px', textAlign: 'right', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }
const TD: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '6px 8px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }

function fmtM(v: number) {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}T`
  if (abs >= 1_000)     return `$${(v / 1_000).toFixed(1)}B`
  return `$${v.toFixed(0)}M`
}

type Seg = { name: string; revenue: number; pct: number | null }
type SotpData = {
  ticker: string; fiscalYear?: number; currency?: string
  segments: Seg[]; total_revenue?: number; net_debt?: number; shares?: number; market_price?: number | null
  suggested_multiple?: number | null; note?: string
}

export function SOTPContent() {
  const cc = useChartColors()
  const [ticker, setTicker] = useState('AAPL')
  const [data, setData] = useState<SotpData | null>(null)
  const [mult, setMult] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true); setError(null)
    try {
      const res = await axios.get(`/api/valuation/sotp?ticker=${ticker.trim().toUpperCase()}`)
      const d: SotpData = res.data
      setData(d)
      // Seed every segment at the company's current blended EV/Sales so the tool
      // starts near fair value; the user then tunes each segment up or down.
      const start = d.suggested_multiple ?? 3.0
      const seed: Record<string, number> = {}
      for (const s of d.segments) seed[s.name] = start
      setMult(seed)
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Could not load segment data.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  const calc = useMemo(() => {
    if (!data || !data.segments.length) return null
    const rows = data.segments.map(s => ({ ...s, mult: mult[s.name] ?? 3.0, ev: s.revenue * (mult[s.name] ?? 3.0) }))
    const totalEV = rows.reduce((a, r) => a + r.ev, 0)
    const equity = totalEV - (data.net_debt ?? 0)
    const perShare = data.shares ? equity / data.shares : 0
    const upside = data.market_price ? (perShare / data.market_price - 1) * 100 : null
    return { rows, totalEV, equity, perShare, upside }
  }, [data, mult])

  return (
    <SidebarLayout sidebarWidth={240} sidebarTitle="SOTP Inputs" sidebar={<>
      <div style={{ marginBottom: 12 }}>
        <label style={LABEL}>Ticker</label>
        <input style={INPUT} value={ticker} onChange={e => setTicker(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && load()} placeholder="AAPL" />
      </div>
      <button onClick={load} disabled={loading}
        style={{ ...INPUT, width: '100%', cursor: 'pointer', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
          color: 'var(--theme-primary, #c9a84c)', borderColor: 'var(--theme-primary, #c9a84c)', marginBottom: 16 }}>
        {loading ? 'Loading…' : 'Load segments'}
      </button>

      {calc && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }}>
            EV / Sales per segment
          </div>
          {calc.rows.map(r => (
            <div key={r.name}>
              <label style={{ ...LABEL, marginBottom: 2, textTransform: 'none', letterSpacing: 0, fontSize: 10, color: 'var(--theme-text, #d7e3fc)' }}>{r.name}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="range" min={0.5} max={15} step={0.1} value={r.mult}
                  onChange={e => setMult(m => ({ ...m, [r.name]: Number(e.target.value) }))} style={{ flex: 1, accentColor: 'var(--theme-primary, #c9a84c)' }} />
                <input type="number" min={0} step={0.1} value={r.mult}
                  onChange={e => setMult(m => ({ ...m, [r.name]: Number(e.target.value) }))} style={{ ...INPUT, width: 56, padding: '3px 6px' }} />
              </div>
            </div>
          ))}
          <div style={{ marginTop: 8, fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-secondary, #99907e)', lineHeight: 1.7 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Net debt</span><span>{fmtM(data!.net_debt ?? 0)}</span></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Shares</span><span>{data!.shares?.toFixed(0)}M</span></div>
            {data!.fiscalYear && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Segments FY</span><span>{data!.fiscalYear}</span></div>}
          </div>
        </div>
      )}
    </>}>

      {error && <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {!data && !error && (
        <EmptyState title="Sum-of-the-Parts" hint="Enter a ticker and Load segments to value each business segment on its own EV/Sales multiple." />
      )}

      {data && !data.segments.length && (
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.7 }}>
          {data.note || 'No segment breakdown available for this issuer.'}
        </div>
      )}

      {calc && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <MetricCard label="Enterprise value" value={fmtM(calc.totalEV)} />
            <MetricCard label="Equity value" value={fmtM(calc.equity)} />
            <MetricCard label="Value / share" value={`$${calc.perShare.toFixed(2)}`} />
            <MetricCard label="Upside vs price" value={calc.upside != null ? `${calc.upside > 0 ? '+' : ''}${calc.upside.toFixed(1)}%` : 'n/a'}
              delta={calc.upside != null ? `${data!.market_price?.toFixed(2)} mkt` : undefined} deltaPositive={(calc.upside ?? 0) >= 0} />
          </div>

          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...TH, textAlign: 'left' }}>Segment</th>
                <th style={TH}>Revenue</th><th style={TH}>% mix</th><th style={TH}>EV/Sales</th><th style={TH}>Segment EV</th>
              </tr></thead>
              <tbody>
                {calc.rows.map(r => (
                  <tr key={r.name}>
                    <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }}>{r.name}</td>
                    <td style={TD}>{fmtM(r.revenue)}</td>
                    <td style={{ ...TD, color: 'var(--theme-secondary, #99907e)' }}>{r.pct != null ? `${r.pct}%` : '—'}</td>
                    <td style={{ ...TD, color: 'var(--theme-primary, #c9a84c)' }}>{r.mult.toFixed(1)}x</td>
                    <td style={TD}>{fmtM(r.ev)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '28px 8px 8px', position: 'relative' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
              Enterprise value by segment
            </div>
            <div style={{ height: 240 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={calc.rows} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke="var(--theme-border, rgba(255,255,255,0.08))" />
                  <XAxis type="number" tick={TICK} tickFormatter={(v) => fmtM(v)} />
                  <YAxis type="category" dataKey="name" tick={TICK} width={110} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(v: number) => fmtM(v)} />
                  <Bar dataKey="ev" name="Segment EV" radius={[0, 2, 2, 0]}>
                    {calc.rows.map((_, i) => <Cell key={i} fill={cc.c1} />)}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </SidebarLayout>
  )
}

export default function SOTP() {
  return <PageWrapper title="SOTP Valuation"><SOTPContent /></PageWrapper>
}
