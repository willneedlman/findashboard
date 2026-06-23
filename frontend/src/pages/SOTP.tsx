import { useState, useMemo } from 'react'
import { ComposedChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import MetricCard from '../components/MetricCard'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import { useChartColors } from '../hooks/useChartColors'
import {
  INPUT, LABEL, SIDEBAR, SECTION, RailSection, PRIMARY_BTN, GHOST_BTN, READOUT_ROW, TOOLTIP_STYLE, TOOLTIP_LABEL,
  TOOLTIP_ITEM, TOOLTIP_CURSOR, TICK, TH, TD, PANEL, METRIC_GRID, STACK, fmtM, ChartPanel,
} from './valuationShared'

type Seg = { name: string; revenue: number; pct: number | null; sector?: string | null }
type SotpData = {
  ticker: string; fiscalYear?: number | string; currency?: string; source?: string
  segments: Seg[]; total_revenue?: number; net_debt?: number; shares?: number; market_price?: number | null
  suggested_multiple?: number | null; sector_ps?: Record<string, number>; note?: string
}

export function SOTPContent() {
  const cc = useChartColors()
  const [ticker, setTicker] = useState('AAPL')
  const [inputsOpen, setInputsOpen] = useState(true)
  const [data, setData] = useState<SotpData | null>(null)
  const [mult, setMult] = useState<Record<string, number>>({})
  const [sector, setSector] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // How far to pull each tagged segment toward its pure-play peer multiple. 0 =
  // keep the company's own blended multiple; 1 = full peer comp. Blending avoids
  // the SOTP collapsing when a premium franchise is valued at commodity comps.
  const [peerWeight, setPeerWeight] = useState(0.5)

  const blended = data?.suggested_multiple ?? null
  const sectorPS = data?.sector_ps ?? {}

  // Segment multiple = peerWeight·peer + (1−peerWeight)·blended.
  const weightedMult = (peer: number, w: number) => {
    const b = blended ?? peer
    return Math.round((w * peer + (1 - w) * b) * 100) / 100
  }

  async function load() {
    setLoading(true); setError(null)
    try {
      const res = await axios.get(`/api/valuation/sotp?ticker=${ticker.trim().toUpperCase()}`)
      const d: SotpData = res.data
      setData(d)
      // Default: seed every segment at the company's blended P/S, so SOTP opens
      // exactly at fair value. The peer multiples are an opt-in overlay below.
      const start = d.suggested_multiple ?? 3.0
      const seed: Record<string, number> = {}
      const sec: Record<string, string> = {}
      for (const s of d.segments) {
        seed[s.name] = start
        if (s.sector) sec[s.name] = s.sector
      }
      setMult(seed)
      setSector(sec)
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Could not load segment data.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  // Tag a segment to a peer group and apply the peer-weighted P/S immediately. An
  // empty selection clears the tag and falls back to the blended multiple.
  function applySector(segName: string, sec: string) {
    setSector(s => ({ ...s, [segName]: sec }))
    const ps = sectorPS[sec]
    setMult(m => ({ ...m, [segName]: ps != null ? weightedMult(ps, peerWeight) : (blended ?? m[segName]) }))
  }
  function applyPeerAll() {
    setMult(m => {
      const next = { ...m }
      for (const s of data?.segments ?? []) {
        const ps = sectorPS[sector[s.name]]
        if (ps != null) next[s.name] = weightedMult(ps, peerWeight)
      }
      return next
    })
  }
  // Live: moving the weight re-blends every tagged segment.
  function changeWeight(w: number) {
    setPeerWeight(w)
    setMult(m => {
      const next = { ...m }
      for (const s of data?.segments ?? []) {
        const ps = sectorPS[sector[s.name]]
        if (ps != null) next[s.name] = weightedMult(ps, w)
      }
      return next
    })
  }
  function resetBlended() {
    if (blended == null) return
    setMult(m => Object.fromEntries(Object.keys(m).map(k => [k, blended])))
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
    <SidebarLayout sidebarWidth={250} sidebarTitle="" sidebar={
      <RailSection title="SOTP Inputs" open={inputsOpen} onToggle={() => setInputsOpen(o => !o)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={LABEL}>Ticker</label>
          <TickerInput style={INPUT} value={ticker} onChange={setTicker} onEnter={load} placeholder="Ticker or company" />
          <button onClick={load} disabled={loading} style={{ ...PRIMARY_BTN, marginTop: 8 }}>
            {loading ? 'Loading…' : 'Load segments'}
          </button>
        </div>

        {calc && <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={SECTION}>P / S per segment</div>
            {blended != null && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={applyPeerAll} style={{ ...PRIMARY_BTN, flex: 1, padding: '5px 6px', fontSize: 10 }}>
                  Apply peer P/S
                </button>
                <button onClick={resetBlended} style={{ ...GHOST_BTN, flex: 1, padding: '5px 6px', fontSize: 10 }}>
                  Reset to blended
                </button>
              </div>
            )}
            {blended != null && (
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <label style={{ ...LABEL, marginBottom: 0 }}>Peer weight</label>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-primary, #c9a84c)' }}>{Math.round(peerWeight * 100)}%</span>
                </div>
                <input type="range" min={0} max={1} step={0.05} value={peerWeight}
                  onChange={e => changeWeight(Number(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--theme-primary, #c9a84c)' }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--theme-mono)', fontSize: 8.5, color: 'var(--theme-secondary, #99907e)' }}>
                  <span>company blended</span><span>pure peer</span>
                </div>
              </div>
            )}
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
                {/* Pick a peer group → its P/S is applied to this segment immediately. */}
                <select value={sector[r.name] ?? ''} onChange={e => applySector(r.name, e.target.value)}
                  style={{ ...INPUT, marginTop: 6, padding: '5px 28px 5px 8px', fontSize: 11, cursor: 'pointer',
                    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
                    backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2399907e' stroke-width='2.5'><path d='M6 9l6 6 6-6'/></svg>")`,
                    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 9px center' }}>
                  <option value="">Peer group — blended</option>
                  {Object.entries(sectorPS).map(([name, ps]) => (
                    <option key={name} value={name}>{name} · {ps}x</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div style={{ paddingTop: 4, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div style={READOUT_ROW}><span>Shares</span><span>{data!.shares?.toFixed(0)}M</span></div>
            {data!.fiscalYear && <div style={READOUT_ROW}><span>Segments FY</span><span>{data!.fiscalYear}</span></div>}
          </div>
        </>}
      </div>
      </RailSection>
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
                {calc.rows.map(r => {
                  const sel = sector[r.name]
                  const peer = sectorPS[sel]
                  const weighted = peer != null ? weightedMult(peer, peerWeight) : null
                  const onBlended = blended != null && Math.abs(r.mult - blended) < 0.01
                  const onPeer = weighted != null && Math.abs(r.mult - weighted) < 0.01
                  const basis = onBlended ? 'Blended' : onPeer ? `${sel} · ${Math.round(peerWeight * 100)}% peer` : 'Custom'
                  return (
                    <tr key={r.name}>
                      <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }}>
                        {r.name}
                        <span style={{ display: 'block', fontWeight: 400, fontSize: 9.5, letterSpacing: '0.04em', color: 'var(--theme-secondary, #99907e)' }}>
                          {basis}
                        </span>
                      </td>
                      <td style={TD}>{fmtM(r.revenue)}</td>
                      <td style={{ ...TD, color: 'var(--theme-secondary, #99907e)' }}>{r.pct != null ? `${r.pct}%` : '—'}</td>
                      <td style={{ ...TD, color: 'var(--theme-primary, #c9a84c)' }}>{r.mult.toFixed(2)}x</td>
                      <td style={TD}>{fmtM(r.value)}</td>
                    </tr>
                  )
                })}
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
