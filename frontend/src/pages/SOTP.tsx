import { useState, useMemo } from 'react'
import { ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import MetricCard from '../components/MetricCard'
import EmptyState from '../components/EmptyState'
import { useChartColors } from '../hooks/useChartColors'
import {
  INPUT, LABEL, SIDEBAR, SECTION, PRIMARY_BTN, READOUT_ROW, TOOLTIP_STYLE, TOOLTIP_LABEL,
  TOOLTIP_ITEM, TOOLTIP_CURSOR, TICK, TH, TD, PANEL, METRIC_GRID, STACK, fmtM, ChartPanel,
} from './valuationShared'

type Seg = { name: string; revenue: number; pct: number | null }
type SotpData = {
  ticker: string; fiscalYear?: number | string; currency?: string; source?: string
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
    // P/S is an equity multiple, so segment value sums straight to equity (no net-debt step).
    const rows = data.segments.map(s => ({ ...s, mult: mult[s.name] ?? 1.0, value: s.revenue * (mult[s.name] ?? 1.0) }))
    const total = rows.reduce((a, r) => a + r.value, 0)
    const perShare = data.shares ? total / data.shares : 0
    const upside = data.market_price ? (perShare / data.market_price - 1) * 100 : null
    return { rows, total, perShare, upside }
  }, [data, mult])

  return (
    <SidebarLayout sidebarWidth={250} sidebarTitle="SOTP Inputs" sidebar={
      <div style={SIDEBAR}>
        <div>
          <label style={LABEL}>Ticker</label>
          <input style={INPUT} value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && load()} placeholder="AAPL" />
          <button onClick={load} disabled={loading} style={{ ...PRIMARY_BTN, marginTop: 8 }}>
            {loading ? 'Loading…' : 'Load segments'}
          </button>
        </div>

        {calc && <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={SECTION}>P / S per segment</div>
            {calc.rows.map(r => (
              <div key={r.name}>
                <label style={{ ...LABEL, textTransform: 'none', letterSpacing: 0, fontSize: 11, color: 'var(--theme-text, #d7e3fc)', marginBottom: 6 }}>{r.name}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input type="range" min={0.1} max={15} step={0.05} value={r.mult}
                    onChange={e => setMult(m => ({ ...m, [r.name]: Number(e.target.value) }))}
                    style={{ flex: 1, accentColor: 'var(--theme-primary, #c9a84c)' }} />
                  <input type="number" min={0} step={0.05} value={Number(r.mult.toFixed(2))}
                    onChange={e => setMult(m => ({ ...m, [r.name]: Number(e.target.value) }))}
                    style={{ ...INPUT, width: 64, padding: '4px 6px', textAlign: 'right', color: 'var(--theme-primary, #c9a84c)' }} />
                </div>
              </div>
            ))}
          </div>
          <div style={{ paddingTop: 4, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div style={READOUT_ROW}><span>Shares</span><span>{data!.shares?.toFixed(0)}M</span></div>
            {data!.fiscalYear && <div style={READOUT_ROW}><span>Segments FY</span><span>{data!.fiscalYear}</span></div>}
          </div>
        </>}
      </div>
    }>

      {error && <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {!data && !error && (
        <EmptyState title="Sum-of-the-Parts"
          hint="Value each business segment on its own P/S multiple, then sum to an equity value. Enter a ticker and Load segments." />
      )}

      {data && !data.segments.length && (
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.7, maxWidth: 620 }}>
          {data.note || 'No segment breakdown available for this issuer.'}
        </div>
      )}

      {calc && (
        <div style={STACK}>
          <div style={METRIC_GRID}>
            <MetricCard label="Implied market value" value={fmtM(calc.total)} />
            <MetricCard label="Value / share" value={`$${calc.perShare.toFixed(2)}`} />
            <MetricCard label="Upside vs price" value={calc.upside != null ? `${calc.upside > 0 ? '+' : ''}${calc.upside.toFixed(1)}%` : 'n/a'}
              delta={calc.upside != null ? `$${data!.market_price?.toFixed(2)} mkt` : undefined} deltaPositive={(calc.upside ?? 0) >= 0} />
          </div>

          {(data!.source || data!.fiscalYear) && (
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9.5, letterSpacing: '0.08em', color: 'var(--theme-secondary, #99907e)', marginTop: -8 }}>
              Segment revenue: {data!.source ?? 'data'}{data!.fiscalYear ? ` · FY${data!.fiscalYear}` : ''}
            </div>
          )}

          <div style={PANEL}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...TH, textAlign: 'left' }}>Segment</th>
                <th style={TH}>Revenue</th><th style={TH}>% mix</th><th style={TH}>P/S</th><th style={TH}>Segment value</th>
              </tr></thead>
              <tbody>
                {calc.rows.map(r => (
                  <tr key={r.name}>
                    <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }}>{r.name}</td>
                    <td style={TD}>{fmtM(r.revenue)}</td>
                    <td style={{ ...TD, color: 'var(--theme-secondary, #99907e)' }}>{r.pct != null ? `${r.pct}%` : '—'}</td>
                    <td style={{ ...TD, color: 'var(--theme-primary, #c9a84c)' }}>{r.mult.toFixed(2)}x</td>
                    <td style={TD}>{fmtM(r.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ChartPanel title="Value by segment">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={calc.rows} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--theme-border, rgba(255,255,255,0.08))" />
                <XAxis type="number" tick={TICK} tickFormatter={(v) => fmtM(v)} />
                <YAxis type="category" dataKey="name" tick={TICK} width={120} />
                <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={TOOLTIP_CURSOR} formatter={(v: number) => fmtM(v)} />
                <Bar dataKey="value" name="Segment value" radius={[0, 2, 2, 0]}>
                  {calc.rows.map((_, i) => <Cell key={i} fill={cc.c1} />)}
                </Bar>
              </ComposedChart>
            </ResponsiveContainer>
          </ChartPanel>
        </div>
      )}
    </SidebarLayout>
  )
}

export default function SOTP() {
  return <PageWrapper title="SOTP Valuation"><SOTPContent /></PageWrapper>
}
