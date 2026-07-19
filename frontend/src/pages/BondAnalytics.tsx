import { useState, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { KpiCell } from '../components/mmCockpit'
import { fetchBondAnalytics } from '../hooks/useApi'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import Provenance from '../components/Provenance'
import axios from 'axios'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip, textClip } from '../lib/reportCaptureRegistry'
import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}

function ChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>{label}</div>
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>{children}</div>
    </div>
  )
}

export function BondAnalyticsContent() {
  const seed = (useLocation().state as { seed?: any } | null)?.seed
  const [imported] = useState<{ cusip?: string; name?: string } | null>(seed?.meta ?? null)
  const [p, setP]     = useState(seed
    ? { face: seed.face ?? 1000, coupon_rate: seed.coupon_rate ?? 5, market_price: seed.market_price ?? 1000, maturity: seed.maturity ?? 10 }
    : { face: 1000, coupon_rate: 5, market_price: 1000, maturity: 10 })
  const [shift, setShift] = useState(0)
  const [paramsOpen, setParamsOpen] = useState(true)
  const [aiNarrative, setAiNarrative] = useState<any>(null)
  const [aiNarrativePending, setAiNarrativePending] = useState(false)
  const [cusip, setCusip] = useState('')
  const [cusipOpen, setCusipOpen] = useState(true)
  const [lookup, setLookup] = useState<any>(null)
  const [lookupPending, setLookupPending] = useState(false)
  const [lookupErr, setLookupErr] = useState<string | null>(null)

  const { mutate, data, isPending, isError } = useMutation({
    mutationFn: () => fetchBondAnalytics(p),
    onSuccess: async (d) => {
      setAiNarrative(null)
      setAiNarrativePending(true)
      try {
        const { data: r } = await axios.post('/api/ai/bond-narrative', {
          ytm: d.ytm, mod_duration: d.mod_duration, convexity: d.convexity,
          coupon_rate: p.coupon_rate, maturity: p.maturity,
          bond_type: d.bond_type, market_price: p.market_price, face: p.face,
        })
        setAiNarrative(r)
      } catch { /* silent */ }
      setAiNarrativePending(false)
    },
  })
  useEffect(() => { if (seed) mutate() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: keyof typeof p) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP(prev => ({ ...prev, [k]: +e.target.value }))

  const doLookup = async () => {
    const cu = cusip.trim().toUpperCase()
    if (!/^[A-Z0-9]{9}$/.test(cu)) { setLookupErr('Enter a 9-character CUSIP'); setLookup(null); return }
    setLookupPending(true); setLookupErr(null); setLookup(null)
    try {
      const { data: r } = await axios.get(`/api/bond/cusip/${cu}`)
      if (!r.found) { setLookupErr(`No security found for ${cu}`); return }
      setLookup(r)
      setP(prev => ({
        ...prev,
        ...(r.coupon_rate != null ? { coupon_rate: r.coupon_rate } : {}),
        ...(r.years_to_maturity ? { maturity: Math.max(1, Math.min(100, Math.round(r.years_to_maturity))) } : {}),
        ...(r.market_price != null ? { market_price: Math.round((r.market_price / 100) * prev.face) } : {}),
      }))
    } catch {
      setLookupErr('Lookup failed — try again')
    } finally {
      setLookupPending(false)
    }
  }

  const shiftedPoint = data?.sensitivity.find((s: any) => s.shift === shift)

  const liveBondType = (() => {
    const price = shiftedPoint ? shiftedPoint.price : data?.sensitivity.find((s: any) => s.shift === 0)?.price
    if (!data || price == null) return data?.bond_type ?? 'Par Bond'
    const face = p.face
    if (price > face * 1.001) return 'Premium Bond'
    if (price < face * 0.999) return 'Discount Bond'
    return 'Par Bond'
  })()

  const TAB = 'Bond Analytics'
  useReportCapture(() => {
    if (!data) return null
    const pieces: ClipDraft[] = [
      kpiClip(TAB, 'Bond Metrics', [
        { label: 'Implied YTM', value: `${data.ytm}%`, sub: liveBondType },
        { label: 'Modified Duration', value: String(data.mod_duration) },
        { label: 'Convexity', value: String(data.convexity) },
        { label: 'Coupon Payment', value: `$${data.coupon_payment}` },
        { label: 'Face', value: `$${p.face}` },
        { label: 'Market Price', value: `$${p.market_price}` },
        { label: 'Coupon Rate', value: `${p.coupon_rate}%` },
        { label: 'Maturity', value: `${p.maturity}y` },
      ]),
    ]
    if (shiftedPoint) {
      const chg = (shiftedPoint.price - p.market_price) / p.market_price * 100
      pieces.push(kpiClip(TAB, `Rate Shift Sensitivity · ${shift > 0 ? '+' : ''}${shift} bps`, [
        { label: 'Rate Shift', value: `${shift > 0 ? '+' : ''}${shift} bps` },
        { label: 'New Price', value: `$${shiftedPoint.price.toFixed(2)}`, sub: `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` },
        { label: 'New YTM', value: `${Math.max(((data.ytm / 100) + shift / 10000) * 100, 0.01).toFixed(2)}%` },
      ]))
    }
    if (data.sensitivity?.length) {
      pieces.push(chartClip(TAB, 'Price vs Rate Shift', 'line', 'shift',
        data.sensitivity.map((s: any) => ({ shift: s.shift, price: s.price })),
        [{ key: 'price', label: 'Price' }],
      ))
    }
    if (data.cash_flows?.length) {
      pieces.push(chartClip(TAB, 'Cash Flow Schedule', 'bar', 'year',
        data.cash_flows.map((c: any) => ({ year: c.year, nominal: c.nominal, pv: c.pv })),
        [{ key: 'nominal', label: 'Nominal CF' }, { key: 'pv', label: 'Present Value' }],
      ))
      pieces.push(tableClip(TAB, 'Cash Flows',
        ['Year', 'Nominal', 'PV'],
        data.cash_flows.map((c: any) => [c.year, c.nominal?.toFixed?.(2) ?? c.nominal, c.pv?.toFixed?.(2) ?? c.pv]),
      ))
    }
    if (aiNarrative?.summary) {
      pieces.push(textClip(TAB, 'AI Bond Analysis', [
        aiNarrative.summary,
        aiNarrative.rate_sensitivity && `Rate Sensitivity: ${aiNarrative.rate_sensitivity}`,
        aiNarrative.yield_context && `Yield Context: ${aiNarrative.yield_context}`,
        aiNarrative.investor_fit && `Investor Fit: ${aiNarrative.investor_fit}`,
      ].filter(Boolean).join('\n\n')))
    }
    return pieces
  }, { disabled: !data, sourceTab: TAB })

  return (
      <SidebarLayout sidebarWidth={210} sidebarTitle="" sidebar={<>
          <RailSection title="CUSIP Lookup" open={cusipOpen} onToggle={() => setCusipOpen(o => !o)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <input value={cusip} onChange={e => setCusip(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && doLookup()}
                placeholder="9-char CUSIP" maxLength={9} style={INPUT}
                onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')} onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')} />
              <button onClick={doLookup} disabled={lookupPending} style={{
                width: '100%', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
                border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
                fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                padding: '7px 0', cursor: lookupPending ? 'default' : 'pointer', opacity: lookupPending ? 0.6 : 1,
              }}>{lookupPending ? 'Looking up…' : 'Look up'}</button>
              {lookupErr && <div style={{ fontSize: 9, color: 'var(--theme-negative, #ef4444)', fontFamily: 'var(--theme-sans)' }}>{lookupErr}</div>}
              {lookup && (
                <div style={{ background: 'var(--theme-surface, #142032)', border: '1px solid var(--theme-border, rgba(255,255,255,0.10))', padding: '8px 9px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-sans)' }}>{lookup.name}</div>
                  <div style={{ fontSize: 9, color: 'var(--theme-secondary, #99907e)', fontFamily: 'var(--theme-mono)' }}>{lookup.type}{lookup.ticker ? ` · ${lookup.ticker}` : ''}</div>
                  {lookup.coupon_rate != null && (
                    <div style={{ fontSize: 9, color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-sans)' }}>
                      Coupon {lookup.coupon_rate}% · matures {lookup.maturity_date} — prefilled
                    </div>
                  )}
                  {lookup.market_price != null ? (
                    <div style={{ fontSize: 9, color: 'var(--theme-positive, #22c55e)', fontFamily: 'var(--theme-sans)', lineHeight: 1.4 }}>
                      Price {lookup.market_price}/100 · {lookup.price_source}{lookup.price_as_of ? ` · as of ${lookup.price_as_of}` : ''} — prefilled (a mark, not a live quote)
                    </div>
                  ) : (
                    <div style={{ fontSize: 9, color: 'var(--theme-secondary, #99907e)', fontFamily: 'var(--theme-sans)', lineHeight: 1.4 }}>
                      {lookup.coupon_rate != null ? 'No free price found — enter market price manually.' : 'Identity only — enter coupon & price manually.'} Live prices need a licensed feed.
                    </div>
                  )}
                </div>
              )}
            </div>
          </RailSection>
          <RailSection title="Bond Parameters" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {([
              { label: 'Face Value ($)',    key: 'face',         step: 100  },
              { label: 'Coupon Rate (%)',   key: 'coupon_rate',  step: 0.25 },
              { label: 'Market Price ($)',  key: 'market_price', step: 1    },
              { label: 'Maturity (Years)',  key: 'maturity',     step: 1    },
            ] as const).map(f => (
              <div key={f.key}>
                <label style={LABEL}>{f.label}</label>
                <input type="number" value={(p as any)[f.key]} step={f.step} onChange={set(f.key as any)} style={INPUT}
                  onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')} onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')} />
              </div>
            ))}
          </div>
          </RailSection>
          <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button onClick={() => mutate()} disabled={isPending} style={{
              width: '100%', background: isPending ? 'var(--theme-hover, rgba(255,255,255,0.04))' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, transparent)',
              border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer',
              opacity: isPending ? 0.6 : 1, transition: 'opacity 0.15s',
            }}>
              {isPending ? 'Analyzing…' : 'Analyze Bond'}
            </button>
            {isError && <div style={{ fontSize: 9, color: 'var(--theme-negative, #ef4444)', textAlign: 'center', fontFamily: 'var(--theme-sans)' }}>Server unavailable — is the backend running?</div>}
          </div>
      </>}>
          {imported && (
            <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--theme-surface, #142032)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)', fontFamily: 'var(--theme-sans)', fontSize: 11, color: 'var(--theme-secondary, #99907e)' }}>
              Imported from CUSIP <span style={{ fontFamily: 'var(--theme-mono)', color: 'var(--theme-primary, #c9a84c)' }}>{imported.cusip}</span>{imported.name ? ` · ${imported.name}` : ''}
            </div>
          )}
          {data && (
            <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <Provenance kind="model" source={imported ? 'ETF-derived mark · analytics computed' : 'analytics computed from your inputs'} />
              </div>
              {/* Bond classification + metrics */}
              {(() => {
                const typeColor = liveBondType === 'Premium Bond' ? 'var(--theme-positive)' : liveBondType === 'Discount Bond' ? 'var(--theme-negative)' : 'var(--theme-primary, #c9a84c)'
                return (
                  <div style={STRIP}>
                    <KpiCell grow minWidth={150} label="Implied YTM" value={`${data.ytm}%`} valueSize={16} color="var(--theme-primary, #c9a84c)" sub={liveBondType} subColor={typeColor} />
                    <KpiCell grow label="Modified Duration" value={String(data.mod_duration)} />
                    <KpiCell grow label="Convexity" value={String(data.convexity)} />
                    <KpiCell grow label="Coupon Payment" value={`$${data.coupon_payment}`} />
                  </div>
                )
              })()}

              {/* Duration sensitivity */}
              <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>Duration-Adjusted Price Sensitivity</span>
                </div>
                <div style={{ padding: '10px 12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', whiteSpace: 'nowrap' }}>Rate Shift</span>
                    <input type="range" min={-300} max={300} step={5} value={shift}
                      onChange={e => setShift(+e.target.value)} style={{ flex: 1, accentColor: 'var(--theme-primary, #c9a84c)' }} />
                    <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', whiteSpace: 'nowrap', width: 72, textAlign: 'right' }}>
                      {shift > 0 ? '+' : ''}{shift} bps
                    </span>
                  </div>

                  {shiftedPoint && (() => {
                    const chg = (shiftedPoint.price - p.market_price) / p.market_price * 100
                    return (
                      <div style={{ ...STRIP, marginBottom: 12 }}>
                        <KpiCell grow label="Rate Shift" value={`${shift > 0 ? '+' : ''}${shift} bps`} />
                        <KpiCell grow label="New Price" value={`$${shiftedPoint.price.toFixed(2)}`}
                          color={shiftedPoint.price > p.market_price ? 'var(--theme-positive)' : 'var(--theme-negative)'}
                          sub={`${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`} subColor={shiftedPoint.price > p.market_price ? 'var(--theme-positive)' : 'var(--theme-negative)'} />
                        <KpiCell grow label="New YTM" value={`${Math.max(((data.ytm / 100) + shift / 10000) * 100, 0.01).toFixed(2)}%`} />
                      </div>
                    )
                  })()}
                </div>

                <ChartPanel label="Price vs Rate Shift" height={248}>
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={data.sensitivity}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                      <XAxis dataKey="shift" tick={TICK} tickFormatter={v => `${v}bps`} interval="preserveStartEnd" />
                      <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right" />
                      <Tooltip formatter={(v: number) => [`$${v.toFixed(2)}`, 'Price']} contentStyle={TOOLTIP_STYLE} />
                      <ReferenceLine x={shift} stroke="var(--theme-tertiary, #60a5fa)" strokeDasharray="4 4" />
                      <ReferenceLine y={p.market_price} stroke="var(--theme-border, rgba(255,255,255,0.1))" strokeDasharray="4 4" />
                      <Line type="monotone" dataKey="price" stroke="var(--theme-primary, #c9a84c)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartPanel>
              </div>

              <ChartPanel label="Cash Flow Schedule: Nominal vs Present Value" height={288}>
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={data.cash_flows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="year" tick={TICK} />
                    <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Bar dataKey="nominal" name="Nominal CF" fill="var(--theme-primary, #c9a84c)" opacity={0.85} />
                    <Bar dataKey="pv"      name="Present Value" fill="var(--theme-tertiary, #60a5fa)" opacity={0.85} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartPanel>
            </>
          )}
          {(aiNarrativePending || aiNarrative) && (
            <div style={{ border: '1px solid color-mix(in srgb, var(--theme-primary) 20%, transparent)', background: 'color-mix(in srgb, var(--theme-primary) 3%, transparent)' }}>
              <div style={{ padding: '6px 12px', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary) 12%, transparent)', background: 'color-mix(in srgb, var(--theme-primary) 6%, transparent)' }}>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>AI Bond Analysis</span>
              </div>
              {aiNarrativePending && !aiNarrative && (
                <div style={{ padding: '10px 12px', fontSize: 10, color: 'var(--theme-text-muted, rgba(215,227,252,0.5))', fontFamily: 'var(--theme-sans)' }}>Analyzing…</div>
              )}
              {aiNarrative && (
                <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text, #d7e3fc)', lineHeight: '16px', fontFamily: 'var(--theme-sans)' }}>{aiNarrative.summary}</div>
                  {[
                    { label: 'Rate Sensitivity', text: aiNarrative.rate_sensitivity },
                    { label: 'Yield Context', text: aiNarrative.yield_context },
                    { label: 'Investor Fit', text: aiNarrative.investor_fit },
                  ].map(({ label, text }) => text ? (
                    <div key={label} style={{ paddingLeft: 8, borderLeft: '2px solid color-mix(in srgb, var(--theme-primary) 30%, transparent)' }}>
                      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--theme-primary, #c9a84c)', textTransform: 'uppercase', marginBottom: 2 }}>{label}</div>
                      <div style={{ fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '14px', fontFamily: 'var(--theme-sans)' }}>{text}</div>
                    </div>
                  ) : null)}
                </div>
              )}
            </div>
          )}
          {!data && (
            <EmptyState title="Bond Analytics" hint="Enter face value, coupon rate, market price and maturity, then press Analyze Bond."
              keys={['Enter']} action="Analyze Bond" />
          )}
      </SidebarLayout>
  )
}

export default function BondAnalytics() {
  return <PageWrapper title="Bond Analytics"><BondAnalyticsContent /></PageWrapper>
}
