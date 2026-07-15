import { useState, useMemo } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import {
  INPUT, LABEL, SECTION, RailSection, PRIMARY_BTN, GHOST_BTN, READOUT_ROW,
  TH, TD, PANEL, STACK, fmtM, VerdictStrip, upsidePrimary, LabeledPanel,
} from './valuationShared'

// Gold ramp across segments so the value stack / bars read as one family.
const RAMP: number[][] = [[216, 184, 90], [201, 168, 76], [178, 146, 63], [156, 126, 53], [134, 105, 43]]
function ramp(i: number, n: number): string {
  const x = (n <= 1 ? 0 : i / (n - 1)) * (RAMP.length - 1)
  const lo = Math.floor(x), hi = Math.min(lo + 1, RAMP.length - 1), f = x - lo
  const c = RAMP[lo].map((v, k) => Math.round(v + (RAMP[hi][k] - v) * f))
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
}
const HAIR = '1px solid var(--theme-border, rgba(255,255,255,0.08))'

// 100%-width bar split by each segment's share of total implied value.
function ValueStack({ rows, total }: { rows: { name: string; value: number }[]; total: number }) {
  return (
    <div>
      <div style={{ display: 'flex', height: 44, width: '100%', border: HAIR, overflow: 'hidden' }}>
        {rows.map((r, i) => {
          const pct = total > 0 ? (r.value / total) * 100 : 0
          return (
            <div key={r.name} title={`${r.name} · ${fmtM(r.value)}`} style={{ width: `${pct}%`, background: ramp(i, rows.length), display: 'flex', alignItems: 'center', justifyContent: 'center', borderRight: i < rows.length - 1 ? '1px solid #0a1628' : 'none' }}>
              {pct >= 4 && <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700, color: '#0a1628' }}>{pct.toFixed(1)}%</span>}
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 12 }}>
        {rows.map((r, i) => (
          <span key={r.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'var(--theme-mono)', fontSize: 10 }}>
            <span style={{ width: 9, height: 9, background: ramp(i, rows.length), flex: 'none' }} />
            <span style={{ color: 'var(--theme-text, #d7e3fc)' }}>{r.name}</span>
            <span style={{ color: 'var(--theme-secondary, #99907e)' }}>{fmtM(r.value)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// Per-segment revenue bar (blue) over value bar (segment ramp) — the multiple's lift.
function RevValueBars({ rows }: { rows: { name: string; revenue: number; value: number }[] }) {
  const maxRev = Math.max(...rows.map(r => r.revenue)) || 1
  const maxVal = Math.max(...rows.map(r => r.value)) || 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.map((r, i) => (
        <div key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ width: 92, flex: 'none', textAlign: 'right', fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-text, #d7e3fc)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <div style={{ height: 8, width: `${(r.revenue / maxRev) * 100}%`, background: 'var(--theme-tertiary, #60a5fa)', opacity: 0.75, flex: 'none' }} />
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary, #99907e)', whiteSpace: 'nowrap' }}>rev {fmtM(r.revenue)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ height: 12, width: `${(r.value / maxVal) * 100}%`, background: ramp(i, rows.length), flex: 'none' }} />
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-text, #d7e3fc)', whiteSpace: 'nowrap' }}>value {fmtM(r.value)}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

type Seg = { name: string; revenue: number; pct: number | null; sector?: string | null }
type SotpData = {
  ticker: string; fiscalYear?: number | string; currency?: string; source?: string
  segments: Seg[]; total_revenue?: number; net_debt?: number; shares?: number; market_price?: number | null
  suggested_multiple?: number | null; sector_ps?: Record<string, number>; note?: string
}

export function SOTPContent() {
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
          hint="Value each business segment on its own P/S multiple, then sum to an equity value. Enter a ticker and Load segments."
          keys={['Enter']} kpis={['Equity Value', 'Per Share', 'Upside', 'Segments']}
          preview="table" previewLabel="Segment Valuation" columns={['Segment', 'Revenue', 'Multiple', 'Value']} action="Load segments" />
      )}

      {data && !data.segments.length && (
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.7, maxWidth: 620 }}>
          {data.note || 'No segment breakdown available for this issuer.'}
        </div>
      )}

      {calc && (
        <div style={STACK}>
          <div style={PANEL}>
            <VerdictStrip
              primary={upsidePrimary(calc.upside ?? null, `$${calc.perShare.toFixed(2)}`, data!.market_price != null ? `$${data!.market_price.toFixed(2)}` : null)}
              cells={[
                { label: 'Implied Market Value', value: fmtM(calc.total) },
                { label: 'Value / Share', value: `$${calc.perShare.toFixed(2)}` },
                { label: 'Market Price', value: data!.market_price != null ? `$${data!.market_price.toFixed(2)}` : 'n/a' },
              ]}
            />
          </div>

          {(data!.source || data!.fiscalYear) && (
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9.5, letterSpacing: '0.08em', color: 'var(--theme-secondary, #99907e)', marginTop: -8 }}>
              Segment revenue: {data!.source ?? 'data'}{data!.fiscalYear ? ` · FY${data!.fiscalYear}` : ''}
            </div>
          )}

          {/* Value stack — each segment's share of total implied value */}
          <LabeledPanel title="Value stack">
            <ValueStack rows={calc.rows} total={calc.total} />
          </LabeledPanel>

          {(() => {
            const maxVal = Math.max(...calc.rows.map(r => r.value)) || 1
            return (
              <div style={PANEL}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr>
                    <th style={{ ...TH, textAlign: 'left' }}>Segment</th>
                    <th style={TH}>Revenue</th><th style={TH}>% mix</th><th style={TH}>P/S</th><th style={TH}>Segment value</th>
                  </tr></thead>
                  <tbody>
                    {calc.rows.map((r, i) => {
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
                          <td style={TD}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                              <div style={{ height: 8, width: 64 * (r.value / maxVal), background: ramp(i, calc.rows.length), flex: 'none' }} />
                              <span>{fmtM(r.value)}</span>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          })()}

          {/* Revenue → value: the multiple's lift, per segment */}
          <LabeledPanel title="Revenue → value" right={`at ${(calc.total / (calc.rows.reduce((a, r) => a + r.revenue, 0) || 1)).toFixed(2)}× blended P/S`}>
            <RevValueBars rows={calc.rows} />
          </LabeledPanel>
        </div>
      )}
    </SidebarLayout>
  )
}

export default function SOTP() {
  return <PageWrapper title="SOTP Valuation"><SOTPContent /></PageWrapper>
}
