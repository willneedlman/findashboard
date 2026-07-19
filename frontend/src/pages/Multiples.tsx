import { useState, useMemo } from 'react'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import { INPUT, LABEL, RailSection, PRIMARY_BTN, READOUT_ROW, TH, TD, PANEL, STACK, VerdictStrip, upsidePrimary, LabeledPanel } from './valuationShared'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip } from '../lib/reportCaptureRegistry'

const MONO = 'var(--theme-mono)', SANS = 'var(--theme-sans)'
const TXT = 'var(--theme-text, #d7e3fc)', SEC = 'var(--theme-secondary, #99907e)', GOLD = 'var(--theme-primary, #c9a84c)'
const BAND = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 28%, transparent)'
const HAIR = '1px solid var(--theme-border, rgba(255,255,255,0.08))'

type Bar = { label: string; lo: number; hi: number; marker: number }

// Football field: per-multiple implied-price range (bear–bull band) with a
// marker at the target multiple, over a full-height market-price rule.
function FootballField({ bars, price }: { bars: Bar[]; price: number | null }) {
  const LABEL_W = 104
  // Domain is anchored to the stable bear–bull bands and the market price only —
  // NOT the target markers — so typing a target never rescales the whole chart.
  const vals = [...bars.flatMap(b => [b.lo, b.hi]), ...(price != null ? [price] : [])].filter(v => isFinite(v))
  const minV = Math.min(...vals), maxV = Math.max(...vals)
  const pad = (maxV - minV) * 0.06 || 1
  const dMin = minV - pad, span = (maxV + pad) - dMin || 1
  const pct = (v: number) => ((v - dMin) / span) * 100
  const xAt = (v: number) => `calc(${LABEL_W}px + (100% - ${LABEL_W}px) * ${pct(v) / 100})`
  const ticks = Array.from({ length: 5 }, (_, i) => dMin + (span * i) / 4)
  return (
    <div style={{ position: 'relative' }}>
      {price != null && <>
        <div style={{ position: 'absolute', top: 16, bottom: 34, left: xAt(price), width: 2, marginLeft: -1, background: TXT, zIndex: 2 }} />
        <div style={{ position: 'absolute', top: 0, left: xAt(price), transform: 'translateX(-50%)', fontFamily: MONO, fontSize: 9, color: TXT, whiteSpace: 'nowrap', zIndex: 3 }}>price ${price.toFixed(2)}</div>
      </>}
      <div style={{ paddingTop: 16 }}>
        {bars.map((b, i) => {
          const showMk = isFinite(b.marker) && b.marker > 0
          const raw = pct(b.marker)
          const mkPct = Math.max(1, Math.min(99, raw))         // clamp an off-scale target to the track edge
          const offR = raw > 100, offL = raw < 0
          const label = offR ? `$${b.marker.toFixed(2)} ↑` : offL ? `$${b.marker.toFixed(2)} ↓` : `$${b.marker.toFixed(2)}`
          const labelLeft = mkPct > 78
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', height: 26 }}>
              <div style={{ width: LABEL_W, flex: 'none', paddingRight: 8, fontFamily: SANS, fontSize: 11, color: TXT, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</div>
              <div style={{ position: 'relative', flex: 1, height: '100%' }}>
                <div style={{ position: 'absolute', top: '50%', transform: 'translateY(-50%)', left: `${pct(b.lo)}%`, width: `${Math.max(0, pct(b.hi) - pct(b.lo))}%`, height: 10, background: BAND, border: `1px solid ${GOLD}`, boxSizing: 'border-box' }} />
                {showMk && <>
                  <div style={{ position: 'absolute', top: 3, bottom: 3, left: `${mkPct}%`, width: 3, marginLeft: -1.5, background: GOLD, opacity: offR || offL ? 0.55 : 1 }} />
                  <span style={{ position: 'absolute', top: '50%', left: `${mkPct}%`, transform: labelLeft ? 'translate(-100%,-50%)' : 'translate(7px,-50%)', marginLeft: labelLeft ? -7 : 0, fontFamily: MONO, fontSize: 9, color: TXT, whiteSpace: 'nowrap' }}>{label}</span>
                </>}
              </div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', marginTop: 4, paddingTop: 6, borderTop: HAIR }}>
        <div style={{ width: LABEL_W, flex: 'none' }} />
        <div style={{ position: 'relative', flex: 1, height: 12 }}>
          {ticks.map((t, i) => (
            <span key={i} style={{ position: 'absolute', left: `${pct(t)}%`, transform: i === 0 ? 'none' : i === ticks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)', fontFamily: MONO, fontSize: 9, color: SEC }}>${t.toFixed(0)}</span>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', justifyContent: 'center', marginTop: 8, fontFamily: SANS, fontSize: 9, color: SEC }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 14, height: 8, background: BAND, border: `1px solid ${GOLD}`, boxSizing: 'border-box' }} />Implied range (bear–bull multiple)</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 3, height: 12, background: GOLD }} />At target multiple</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 2, height: 12, background: TXT }} />Market price</span>
      </div>
    </div>
  )
}

type Metric = { key: string; label: string; per_share: number; current_mult: number | null; ev_based: boolean }
type MultiplesData = {
  ticker: string; price?: number | null; shares?: number; net_debt?: number; metrics: Metric[]; note?: string
}

export function MultiplesContent() {
  const [ticker, setTicker] = useState('AAPL')
  const [inputsOpen, setInputsOpen] = useState(true)
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

  useReportCapture(() => {
    if (!data || !rows || !data.metrics.length) return null
    const tkr = data.ticker ? ` · ${data.ticker}` : ''
    const pieces: ClipDraft[] = [
      kpiClip('Multiples', `Multiples Verdict${tkr}`, [
        { label: 'Blended Implied', value: rows.avg != null ? `$${rows.avg.toFixed(2)}` : '—' },
        ...(data.price != null ? [{ label: 'Market Price', value: `$${data.price.toFixed(2)}` }] : []),
        ...(rows.avgUpside != null ? [{ label: 'Upside', value: `${rows.avgUpside >= 0 ? '+' : '−'}${Math.abs(rows.avgUpside).toFixed(1)}%` }] : []),
      ]),
      tableClip(
        'Multiples',
        `Implied Price by Multiple${tkr}`,
        ['Multiple', 'Per Share', 'Current', 'Target', 'Implied', 'Upside'],
        rows.out.map(r => [
          r.label,
          r.per_share.toFixed(2),
          r.current_mult != null ? r.current_mult.toFixed(1) : null,
          r.mult.toFixed(1),
          isFinite(r.implied) ? `$${r.implied.toFixed(2)}` : null,
          r.upside != null ? `${r.upside >= 0 ? '+' : '−'}${Math.abs(r.upside).toFixed(1)}%` : null,
        ]),
      ),
    ]
    return pieces
  }, { disabled: !data || !rows || !data.metrics.length, sourceTab: 'Multiples' })

  return (
    <SidebarLayout sidebarWidth={232} sidebarTitle="" sidebar={
      <RailSection title="Multiples Inputs" open={inputsOpen} onToggle={() => setInputsOpen(o => !o)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <label style={LABEL}>Ticker</label>
          <TickerInput style={INPUT} value={ticker} onChange={setTicker} onEnter={load} placeholder="Ticker or company" />
          <button onClick={load} disabled={loading} style={{ ...PRIMARY_BTN, marginTop: 8 }}>
            {loading ? 'Loading…' : 'Load multiples'}
          </button>
        </div>
        {data && data.metrics.length > 0 && (
          <>
            <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, lineHeight: 1.6, color: 'var(--theme-text-dim, rgba(255,255,255,0.45))' }}>
              Set a target multiple per line in the table. The implied price updates live.
            </div>
            <div style={{ paddingTop: 4, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              <div style={READOUT_ROW}><span>Market price</span><span>${data.price?.toFixed(2)}</span></div>
              <div style={READOUT_ROW}><span>Net debt</span><span>${(data.net_debt ?? 0).toFixed(0)}M</span></div>
            </div>
          </>
        )}
      </div>
      </RailSection>
    }>

      {error && <div style={{ color: '#f85149', fontFamily: 'var(--theme-mono)', fontSize: 12, marginBottom: 12 }}>{error}</div>}

      {!data && !error && (
        <EmptyState title="Multiples Valuation"
          hint="Set a target multiple on any line to see the share price it implies. Enter a ticker and Load multiples."
          keys={['Enter']} kpis={['Implied Price', 'Upside', 'P/E', 'EV/EBITDA', 'P/S']}
          preview="table" previewLabel="Valuation Multiples" columns={['Metric', 'Current', 'Target', 'Implied Price']} action="Load multiples" />
      )}

      {data && !data.metrics.length && (
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.7, maxWidth: 620 }}>
          {data.note || 'No usable per-share metrics for this ticker.'}
        </div>
      )}

      {rows && data!.metrics.length > 0 && (
        <div style={STACK}>
          <div style={PANEL}>
            <VerdictStrip
              primary={upsidePrimary(rows.avgUpside ?? null, rows.avg != null ? `$${rows.avg.toFixed(2)}` : 'n/a', data!.price ? `$${data!.price.toFixed(2)}` : null)}
              cells={[
                { label: 'Blended Implied', value: rows.avg != null ? `$${rows.avg.toFixed(2)}` : 'n/a' },
                { label: 'Market Price', value: data!.price ? `$${data!.price.toFixed(2)}` : 'n/a' },
              ]}
            />
          </div>

          {/* Football field — implied price ranges vs the live price */}
          {(() => {
            const netDebtPS = (data!.shares && data!.net_debt != null) ? data!.net_debt / data!.shares : 0
            const impliedAt = (m: number, ps: number, ev: boolean) => ev ? m * ps - netDebtPS : m * ps
            const bars: Bar[] = rows.out
              .filter(r => r.current_mult != null)
              .map(r => {
                const cm = r.current_mult as number
                const a = impliedAt(cm * 0.75, r.per_share, r.ev_based), b = impliedAt(cm * 1.25, r.per_share, r.ev_based)
                return { label: r.label, lo: Math.min(a, b), hi: Math.max(a, b), marker: r.implied }
              })
              .filter(b => isFinite(b.lo) && isFinite(b.hi) && isFinite(b.marker) && b.hi > 0)
            return bars.length ? (
              <LabeledPanel title="Implied price by method">
                <FootballField bars={bars} price={data!.price ?? null} />
              </LabeledPanel>
            ) : null
          })()}

          <div style={PANEL}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr>
                <th style={{ ...TH, textAlign: 'left' }}>Multiple</th>
                <th style={TH}>Per share</th><th style={TH}>Current</th><th style={TH}>Target</th><th style={TH}>Implied price</th><th style={TH}>Upside</th>
              </tr></thead>
              <tbody>
                {rows.out.map(r => (
                  <tr key={r.key}>
                    <td style={{ ...TD, textAlign: 'left', fontWeight: 700 }}>{r.label}</td>
                    <td style={TD}>${r.per_share.toFixed(2)}</td>
                    <td style={{ ...TD, color: 'var(--theme-secondary, #99907e)' }}>{r.current_mult != null ? `${r.current_mult.toFixed(1)}x` : '—'}</td>
                    <td style={{ ...TD, padding: '5px 12px' }}>
                      <input type="number" step={0.5} min={0} value={Number(r.mult.toFixed(1))}
                        onFocus={e => e.target.select()}
                        onChange={e => setTarget(t => ({ ...t, [r.key]: Number(e.target.value) }))}
                        style={{ ...INPUT, width: 74, padding: '4px 6px', textAlign: 'right', color: 'var(--theme-primary, #c9a84c)' }} />
                    </td>
                    <td style={TD}>{isFinite(r.implied) && r.implied > 0 ? `$${r.implied.toFixed(2)}` : '—'}</td>
                    <td style={{ ...TD, color: (r.upside ?? 0) >= 0 ? 'var(--theme-positive, #3fb950)' : 'var(--theme-negative, #f85149)' }}>
                      {r.upside != null && isFinite(r.implied) && r.implied > 0 ? `${r.upside > 0 ? '+' : ''}${r.upside.toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </SidebarLayout>
  )
}

export default function Multiples() {
  return <PageWrapper title="Multiples Valuation"><MultiplesContent /></PageWrapper>
}
