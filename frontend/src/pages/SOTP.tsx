import { useState, useMemo } from 'react'
import axios from 'axios'
import { useTickerParam } from '../hooks/useTickerParam'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import {
  INPUT, LABEL, SECTION, RailSection, PRIMARY_BTN, GHOST_BTN, READOUT_ROW,
  PANEL, STACK, fmtM, VerdictStrip, upsidePrimary, LabeledPanel,
} from './valuationShared'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip } from '../lib/reportCaptureRegistry'

// Revenue → value is one measure at two stages, so it takes one hue at two steps
// rather than two categorical colours. Validated against the #101c2e surface:
// chroma, 3:1 contrast and normal-vision separation all pass, lightness monotone.
const C_REV = '#2563eb'
const C_VAL = '#60a5fa'
const HAIR = '1px solid var(--theme-border, rgba(255,255,255,0.08))'
const MUTED = 'var(--theme-secondary, #8099b0)'
const TEXT = 'var(--theme-text, #d7e3fc)'
const GOLD = 'var(--theme-primary, #c9a84c)'

const pct1 = (v: number) => `${v.toFixed(1)}%`

type Seg = {
  name: string; revenue: number; pct: number | null
  peer_group?: string | null; peer_ps?: number | null; peer_note?: string | null
}
type PeerGroup = { name: string; ps: number; family: string; note: string }
type SotpData = {
  ticker: string; fiscalYear?: number | string; currency?: string; source?: string
  segments: Seg[]; total_revenue?: number; net_debt?: number | null
  shares?: number | null; market_price?: number | null; market_cap?: number | null
  suggested_multiple?: number | null; peer_groups?: PeerGroup[]; note?: string
}
type Row = Seg & { mult: number; value: number; share: number; basis: string }

// One row per segment: the two bars carry magnitude, the numbers carry precision,
// and the peer picker sits where its effect is visible. Ten segments is past the
// point where colour can carry identity, so identity is the label.
function SegmentRow({ r, maxValue, peerGroups, onMult, onPeer }: {
  r: Row; maxValue: number; peerGroups: PeerGroup[]
  onMult: (v: number) => void; onPeer: (g: string) => void
}) {
  const families = useMemo(() => {
    const out: Record<string, PeerGroup[]> = {}
    for (const g of peerGroups) (out[g.family] ??= []).push(g)
    return out
  }, [peerGroups])

  return (
    <div style={{
      display: 'grid', gap: '4px 14px', alignItems: 'center', padding: '11px 0', borderBottom: HAIR,
      gridTemplateColumns: 'minmax(190px, 1.5fr) minmax(120px, 1.6fr) 82px 74px 92px 56px',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, color: TEXT, lineHeight: 1.35 }}>{r.name}</div>
        <select value={r.peer_group ?? ''} onChange={e => onPeer(e.target.value)} title={r.peer_note ?? ''}
          style={{
            ...INPUT, marginTop: 5, padding: '3px 22px 3px 6px', fontSize: 10, cursor: 'pointer',
            width: '100%', color: r.peer_group ? TEXT : MUTED,
            appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
            backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238099b0' stroke-width='2.5'><path d='M6 9l6 6 6-6'/></svg>")`,
            backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center',
          }}>
          <option value="">No comp, company blended</option>
          {Object.entries(families).map(([fam, gs]) => (
            <optgroup key={fam} label={fam}>
              {gs.map(g => <option key={g.name} value={g.name}>{g.name} · {g.ps}x</option>)}
            </optgroup>
          ))}
        </select>
      </div>

      {/* Revenue → value. Same hue, two steps: the gap is the multiple's lift. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <div title={`Revenue ${fmtM(r.revenue)}`}
          style={{ height: 5, width: `${Math.min(100, (r.revenue / maxValue) * 100)}%`, background: C_REV, borderRadius: '0 3px 3px 0', minWidth: 2 }} />
        <div title={`Segment value ${fmtM(r.value)}`}
          style={{ height: 9, width: `${Math.min(100, (r.value / maxValue) * 100)}%`, background: C_VAL, borderRadius: '0 3px 3px 0', minWidth: 2 }} />
      </div>

      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: MUTED, textAlign: 'right' }}>{fmtM(r.revenue)}</span>

      <div style={{ display: 'flex', alignItems: 'center', gap: 3, justifyContent: 'flex-end' }}>
        <input type="number" min={0} step={0.05} value={Number(r.mult.toFixed(2))}
          onChange={e => onMult(Number(e.target.value))}
          style={{ ...INPUT, width: 56, padding: '3px 5px', textAlign: 'right', fontSize: 11, color: GOLD }} />
        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: MUTED }}>x</span>
      </div>

      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, fontWeight: 700, color: TEXT, textAlign: 'right' }}>{fmtM(r.value)}</span>
      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: MUTED, textAlign: 'right' }}>{pct1(r.share)}</span>

      <div style={{ gridColumn: '1 / -1', fontFamily: 'var(--theme-mono)', fontSize: 9.5, letterSpacing: '0.04em', color: MUTED }}>
        {r.basis}{r.peer_note ? ` · ${r.peer_note}` : ''}
      </div>
    </div>
  )
}

export function SOTPContent() {
  const [ticker, setTicker] = useState('AAPL')
  // The drawer and palette offer this page for a symbol. It never read the
  // URL, so a deep link opened on the hardcoded default instead.
  useTickerParam(setTicker)

  const [inputsOpen, setInputsOpen] = useState(true)
  const [data, setData] = useState<SotpData | null>(null)
  const [mult, setMult] = useState<Record<string, number>>({})
  const [peer, setPeer] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // How far to pull each tagged segment toward its pure-play peer multiple. 0 =
  // keep the company's own blended multiple; 1 = full peer comp. Blending avoids
  // the SOTP collapsing when a premium franchise is valued at commodity comps.
  const [peerWeight, setPeerWeight] = useState(0.5)

  const blended = data?.suggested_multiple ?? null
  const peerGroups = data?.peer_groups ?? []
  const peerPS = useMemo(() => Object.fromEntries(peerGroups.map(g => [g.name, g.ps])), [peerGroups])
  const peerNote = useMemo(() => Object.fromEntries(peerGroups.map(g => [g.name, g.note])), [peerGroups])

  // Segment multiple = peerWeight·peer + (1−peerWeight)·blended.
  const weightedMult = (p: number, w: number) => {
    const b = blended ?? p
    return Math.round((w * p + (1 - w) * b) * 100) / 100
  }

  async function load() {
    setLoading(true); setError(null)
    try {
      const res = await axios.get(`/api/valuation/sotp?ticker=${ticker.trim().toUpperCase()}`)
      const d: SotpData = res.data
      setData(d)
      // Seed each segment at its own peer comp, blended halfway to the company's
      // own P/S. Seeding everything at the blended multiple instead left every
      // row showing the same number while its picker advertised a different one.
      const b = d.suggested_multiple
      const seedMult: Record<string, number> = {}
      const seedPeer: Record<string, string> = {}
      for (const s of d.segments) {
        if (s.peer_group) seedPeer[s.name] = s.peer_group
        const p = s.peer_ps
        seedMult[s.name] = p != null && b != null
          ? Math.round((0.5 * p + 0.5 * b) * 100) / 100
          : (p ?? b ?? 1.0)
      }
      setMult(seedMult)
      setPeer(seedPeer)
      setPeerWeight(0.5)
    } catch (e: any) {
      setError(e?.response?.data?.detail || 'Could not load segment data.')
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  function applyPeer(segName: string, group: string) {
    setPeer(p => ({ ...p, [segName]: group }))
    const ps = peerPS[group]
    setMult(m => ({ ...m, [segName]: ps != null ? weightedMult(ps, peerWeight) : (blended ?? m[segName]) }))
  }
  // Live: moving the weight re-blends every segment that has a comp.
  function changeWeight(w: number) {
    setPeerWeight(w)
    setMult(m => {
      const next = { ...m }
      for (const s of data?.segments ?? []) {
        const ps = peerPS[peer[s.name]]
        if (ps != null) next[s.name] = weightedMult(ps, w)
      }
      return next
    })
  }
  function resetBlended() {
    if (blended == null) return
    setMult(m => Object.fromEntries(Object.keys(m).map(k => [k, blended])))
  }
  function applyPurePeer() {
    changeWeight(1)
  }

  const calc = useMemo(() => {
    if (!data || !data.segments.length) return null
    const fallback = blended ?? 1.0
    const priced = data.segments.map(s => {
      const group = peer[s.name] || null
      const ps = group ? peerPS[group] : null
      const m = mult[s.name] ?? fallback
      const weighted = ps != null ? weightedMult(ps, peerWeight) : null
      const basis = ps != null && weighted != null && Math.abs(m - weighted) < 0.005
        ? `${group} ${ps}x · ${Math.round(peerWeight * 100)}% peer`
        : blended != null && Math.abs(m - blended) < 0.005
          ? `Company blended ${blended}x`
          : 'Custom'
      return { ...s, peer_group: group, peer_note: group ? peerNote[group] : null, mult: m, value: s.revenue * m, basis }
    })
    const total = priced.reduce((a, r) => a + r.value, 0)
    const rows: Row[] = priced
      .map(r => ({ ...r, share: total > 0 ? (r.value / total) * 100 : 0 }))
      .sort((a, b) => b.value - a.value)
    const perShare = data.shares ? total / data.shares : null
    const upside = perShare != null && data.market_price ? (perShare / data.market_price - 1) * 100 : null
    const totalRev = priced.reduce((a, r) => a + r.revenue, 0)
    return { rows, total, perShare, upside, impliedPS: totalRev > 0 ? total / totalRev : null }
  }, [data, mult, peer, peerWeight, blended])

  useReportCapture(() => {
    if (!data || !calc) return null
    const tkr = data.ticker ? ` · ${data.ticker}` : ''
    const pieces: ClipDraft[] = [
      kpiClip('Sum of the Parts', `SOTP Verdict${tkr}`, [
        { label: 'Value / Share', value: calc.perShare != null ? `$${calc.perShare.toFixed(2)}` : 'n/a' },
        ...(data.market_price != null ? [{ label: 'Market Price', value: `$${data.market_price.toFixed(2)}` }] : []),
        ...(calc.upside != null ? [{ label: 'Upside', value: `${calc.upside >= 0 ? '+' : '−'}${Math.abs(calc.upside).toFixed(1)}%` }] : []),
        { label: 'Implied Equity Value', value: fmtM(calc.total) },
      ]),
      tableClip(
        'Sum of the Parts',
        `Segment Values${tkr}`,
        ['Segment', 'Peer comp', 'Revenue', 'P/S', 'Value'],
        calc.rows.map(r => [r.name, r.peer_group ?? 'Blended', fmtM(r.revenue), `${r.mult.toFixed(2)}x`, fmtM(r.value)]),
      ),
    ]
    return pieces
  }, { disabled: !data || !calc, sourceTab: 'Sum of the Parts' })

  const comped = calc ? calc.rows.filter(r => r.peer_group).length : 0

  return (
    <SidebarLayout sidebarWidth={250} sidebarTitle="" sidebar={
      <RailSection title="SOTP Inputs" open={inputsOpen} onToggle={() => setInputsOpen(o => !o)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={LABEL}>Ticker</label>
          <TickerInput style={INPUT} value={ticker} onChange={setTicker} onEnter={load} placeholder="Ticker or company" />
          <button onClick={load} disabled={loading} style={{ ...PRIMARY_BTN, marginTop: 8 }}>
            {loading ? 'FETCHING…' : 'FETCH'}
          </button>
        </div>

        {calc && <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={SECTION}>Comp weighting</div>
            {blended != null ? (
              <>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                    <label style={{ ...LABEL, marginBottom: 0 }}>Peer weight</label>
                    <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: GOLD }}>{Math.round(peerWeight * 100)}%</span>
                  </div>
                  <input type="range" min={0} max={1} step={0.05} value={peerWeight}
                    onChange={e => changeWeight(Number(e.target.value))}
                    style={{ width: '100%', accentColor: 'var(--theme-primary, #c9a84c)' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--theme-mono)', fontSize: 8.5, color: MUTED }}>
                    <span>company blended</span><span>pure peer</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={applyPurePeer} style={{ ...PRIMARY_BTN, flex: 1, padding: '5px 6px', fontSize: 10 }}>Pure peer</button>
                  <button onClick={resetBlended} style={{ ...GHOST_BTN, flex: 1, padding: '5px 6px', fontSize: 10 }}>All blended</button>
                </div>
                <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 9.5, lineHeight: 1.6, color: MUTED, margin: 0 }}>
                  At 0% every part carries the company's own P/S, so the sum reproduces today's market cap.
                  At 100% each part carries its pure-play comp.
                </p>
              </>
            ) : (
              <p style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, lineHeight: 1.6, color: MUTED, margin: 0 }}>
                No live price or share count for this issuer, so there is no company blended P/S to weight against.
                Segments carry their peer comps directly.
              </p>
            )}
          </div>

          <div style={{ paddingTop: 4, borderTop: HAIR }}>
            <div style={READOUT_ROW}><span>Segments</span><span>{calc.rows.length}</span></div>
            <div style={READOUT_ROW}><span>With peer comp</span><span>{comped} / {calc.rows.length}</span></div>
            <div style={READOUT_ROW}><span>Shares</span><span>{data!.shares != null ? `${data!.shares.toFixed(0)}M` : 'n/a'}</span></div>
            {blended != null && <div style={READOUT_ROW}><span>Blended P/S</span><span>{blended.toFixed(2)}x</span></div>}
            {calc.impliedPS != null && <div style={READOUT_ROW}><span>Implied P/S</span><span>{calc.impliedPS.toFixed(2)}x</span></div>}
            {data!.fiscalYear && <div style={READOUT_ROW}><span>Segments FY</span><span>{data!.fiscalYear}</span></div>}
          </div>
        </>}
      </div>
      </RailSection>
    }>

      {error && <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {!data && !error && (
        <EmptyState title="Sum-of-the-Parts"
          hint="Value each business segment on its own pure-play P/S multiple, then sum to an equity value. Enter a ticker and press FETCH."
          keys={['Enter']} action="FETCH" />
      )}

      {data && !data.segments.length && (
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, color: TEXT, lineHeight: 1.7, maxWidth: 620 }}>
          {data.note || 'No segment breakdown available for this issuer.'}
        </div>
      )}

      {calc && (
        <div style={STACK}>
          <div style={PANEL}>
            <VerdictStrip
              primary={upsidePrimary(
                calc.upside ?? null,
                calc.perShare != null ? `$${calc.perShare.toFixed(2)}` : 'n/a',
                data!.market_price != null ? `$${data!.market_price.toFixed(2)}` : null,
              )}
              cells={[
                { label: 'Implied Equity Value', value: fmtM(calc.total) },
                { label: 'Value / Share', value: calc.perShare != null ? `$${calc.perShare.toFixed(2)}` : 'n/a' },
                { label: 'Market Cap', value: data!.market_cap != null ? fmtM(data!.market_cap) : 'n/a' },
                { label: 'Implied P/S', value: calc.impliedPS != null ? `${calc.impliedPS.toFixed(2)}x` : 'n/a' },
              ]}
            />
          </div>

          {(data!.source || data!.fiscalYear) && (
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9.5, letterSpacing: '0.08em', color: MUTED, marginTop: -8 }}>
              Segment revenue: {data!.source ?? 'data'}{data!.fiscalYear ? ` · FY${data!.fiscalYear}` : ''}
              {blended != null && ` · company blended P/S ${blended.toFixed(2)}x`}
            </div>
          )}

          <LabeledPanel title="Segment build-up" right={`${calc.rows.length} segments · ${comped} with a peer comp`}>
            {/* Two series, so a legend is always present. */}
            <div style={{ display: 'flex', gap: 18, marginBottom: 10, fontFamily: 'var(--theme-mono)', fontSize: 10, color: MUTED }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 12, height: 5, background: C_REV, borderRadius: 2 }} />Revenue
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 12, height: 9, background: C_VAL, borderRadius: 2 }} />Segment value
              </span>
            </div>
            <div style={{
              display: 'grid', gap: '4px 14px', paddingBottom: 6, borderBottom: HAIR,
              gridTemplateColumns: 'minmax(190px, 1.5fr) minmax(120px, 1.6fr) 82px 74px 92px 56px',
              fontFamily: 'var(--theme-mono)', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: MUTED,
            }}>
              <span>Segment / peer comp</span><span>Revenue → value</span>
              <span style={{ textAlign: 'right' }}>Revenue</span>
              <span style={{ textAlign: 'right' }}>P/S</span>
              <span style={{ textAlign: 'right' }}>Value</span>
              <span style={{ textAlign: 'right' }}>% of sum</span>
            </div>
            {calc.rows.map(r => (
              <SegmentRow key={r.name} r={r} maxValue={Math.max(...calc.rows.map(x => x.value)) || 1}
                peerGroups={peerGroups}
                onMult={v => setMult(m => ({ ...m, [r.name]: v }))}
                onPeer={g => applyPeer(r.name, g)} />
            ))}
            <div style={{
              display: 'grid', gap: '4px 14px', paddingTop: 10,
              gridTemplateColumns: 'minmax(190px, 1.5fr) minmax(120px, 1.6fr) 82px 74px 92px 56px',
              fontFamily: 'var(--theme-mono)', fontSize: 11, color: TEXT, fontWeight: 700,
            }}>
              <span>Sum of the parts</span><span />
              <span style={{ textAlign: 'right', color: MUTED }}>{fmtM(calc.rows.reduce((a, r) => a + r.revenue, 0))}</span>
              <span style={{ textAlign: 'right', color: GOLD }}>{calc.impliedPS != null ? `${calc.impliedPS.toFixed(2)}x` : '—'}</span>
              <span style={{ textAlign: 'right' }}>{fmtM(calc.total)}</span>
              <span style={{ textAlign: 'right', color: MUTED }}>100.0%</span>
            </div>
          </LabeledPanel>
        </div>
      )}
    </SidebarLayout>
  )
}

export default function SOTP() {
  return <PageWrapper title="SOTP Valuation"><SOTPContent /></PageWrapper>
}
