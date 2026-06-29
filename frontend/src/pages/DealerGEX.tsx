import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { KpiCell } from '../components/mmCockpit'
import SidebarLayout from '../components/SidebarLayout'
import { fetchGEX, fetchOptionsChain } from '../hooks/useApi'
import EmptyState from '../components/EmptyState'
import { useChartColors } from '../hooks/useChartColors'
import { INPUT, LABEL, TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM, TICK, RailSection } from './valuationShared'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}

function ChartPanel({ label, note, height, children }: { label: string; note?: string; height: number; children: React.ReactNode }) {
  const headerH = note ? 42 : 26
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{
        background: 'var(--theme-bg, #101c2e)',
        borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
        padding: '4px 8px',
        display: 'flex', flexDirection: 'column', gap: 2,
      }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)', lineHeight: 1.3 }}>{label}</span>
        {note && <span style={{ fontSize: 9, color: 'var(--theme-secondary, #8099b0)', letterSpacing: '0.06em', lineHeight: 1.3 }}>{note}</span>}
      </div>
      <div style={{ paddingTop: 8, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height: height - (headerH - 26) }}>{children}</div>
    </div>
  )
}

const SELECT: React.CSSProperties = { background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '5px 8px', width: '100%', outline: 'none' }

export default function DealerGEX() {
  const cc = useChartColors()
  const [ticker, setTicker] = useState('SPY')
  const [nStrikes, setNStrikes] = useState(20)
  const [paramsOpen, setParamsOpen] = useState(true)
  const [expiry, setExpiry] = useState<string>('')

  const { mutate, data, isPending } = useMutation({
    mutationFn: async () => {
      const [gex, chain] = await Promise.all([
        fetchGEX(ticker, expiry || undefined),
        fetchOptionsChain(ticker, expiry || undefined),
      ])
      const oiMap: Record<number, { callOI: number; putOI: number }> = {}
      ;(chain.calls ?? []).forEach((c: any) => {
        oiMap[c.strike] = oiMap[c.strike] ?? { callOI: 0, putOI: 0 }
        oiMap[c.strike].callOI += c.openInterest ?? 0
      })
      ;(chain.puts ?? []).forEach((p: any) => {
        oiMap[p.strike] = oiMap[p.strike] ?? { callOI: 0, putOI: 0 }
        oiMap[p.strike].putOI += p.openInterest ?? 0
      })
      return { ...gex, oiMap }
    },
  })

  const spot: number | null = data?.spot ?? null

  const STEP = spot ? (spot >= 500 ? 5 : spot >= 100 ? 2.5 : 1) : 5

  // Use raw API data — no zero-padding. Filter to nStrikes range around spot.
  const filtered = (() => {
    if (!data?.data || !(data.data as any[]).length) return []
    const raw = (data.data as any[]).sort((a, b) => a.strike - b.strike)
    if (!spot) return raw

    const lo = spot - nStrikes * STEP
    const hi = spot + nStrikes * STEP
    const inRange = raw.filter(d => d.strike >= lo && d.strike <= hi)

    // Clip at 99th percentile to prevent one spike from flattening everything else
    const absVals = inRange.map(d => Math.abs(d.net_gex)).filter(v => v > 0).sort((a, b) => a - b)
    const p99 = absVals[Math.floor(absVals.length * 0.99)] ?? Infinity
    const MIN_GEX = (absVals[absVals.length - 1] ?? 0) * 0.005  // drop bars < 0.5% of max

    return inRange
      .filter(d => Math.abs(d.net_gex) >= MIN_GEX)
      .map(d => ({
        strike:   d.strike,
        net_gex:  Math.sign(d.net_gex) * Math.min(Math.abs(d.net_gex), p99),
        call_gex: Math.min(Math.abs(d.call_gex), p99) * Math.sign(d.call_gex ?? 1),
        put_gex:  d.put_gex,
      }))
  })()

  const totalNet  = data?.data?.reduce((s: number, d: any) => s + d.net_gex, 0) ?? 0
  const totalCall = data?.data?.reduce((s: number, d: any) => s + d.call_gex, 0) ?? 0
  const totalPut  = data?.data?.reduce((s: number, d: any) => s + d.put_gex, 0) ?? 0

  let flipLevel: number | null = null
  if (data?.data && spot) {
    const sorted = [...data.data].sort((a, b) => a.strike - b.strike)
    // Find the per-strike sign change in net_gex closest to spot.
    // This finds the structural flip even when cumulative GEX stays one-sided.
    let bestDist = Infinity
    for (let i = 0; i < sorted.length - 1; i++) {
      if (sorted[i].net_gex * sorted[i + 1].net_gex < 0) {
        const candidate = Math.abs(sorted[i].strike - spot) <= Math.abs(sorted[i + 1].strike - spot)
          ? sorted[i].strike : sorted[i + 1].strike
        const dist = Math.abs(candidate - spot)
        if (dist < bestDist) { bestDist = dist; flipLevel = candidate }
      }
    }
  }

  return (
    <PageWrapper title="Dealer GEX">
      <SidebarLayout sidebarWidth={210} sidebarTitle="" sidebar={<>
          <RailSection title="GEX Parameters" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={LABEL}>Ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} style={INPUT}
                onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')} onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')} />
            </div>
            <div>
              <label style={LABEL}>Strikes Each Side</label>
              <input type="number" value={nStrikes} step={5} min={5} max={100} onChange={e => setNStrikes(+e.target.value)} style={INPUT}
                onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')} onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')} />
            </div>
            <div>
              <label style={LABEL}>Expiry</label>
              {data?.expirations?.length ? (
                <select value={expiry} onChange={e => setExpiry(e.target.value)} style={SELECT}>
                  <option value="">All chains</option>
                  {(data.expirations as string[]).map((e: string) => (
                    <option key={e} value={e}>{e}</option>
                  ))}
                </select>
              ) : (
                <input value={expiry} onChange={e => setExpiry(e.target.value)} placeholder="e.g. 2026-06-20" style={INPUT}
                  onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')} onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')} />
              )}
            </div>
            <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', lineHeight: '14px' }}>
              {expiry ? `Showing ${expiry} only.` : 'Aggregates all expiry chains. May take 20–40s on first load.'}
            </div>
          </div>
          </RailSection>
          <div style={{ padding: 12 }}>
            <button onClick={() => mutate()} disabled={isPending} style={{
              width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1,
            }}>
              {isPending ? 'Loading chains…' : 'Load GEX Profile'}
            </button>
          </div>
        </>}>
          {data && (
            <>
              {data.source && (
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12, fontFamily: 'var(--theme-mono)', fontSize: 10.5, letterSpacing: '0.04em', color: data.delayed ? '#e0a93f' : 'var(--theme-positive, #3fb950)' }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none', background: data.delayed ? '#e0a93f' : 'var(--theme-positive, #3fb950)', boxShadow: `0 0 0 3px ${data.delayed ? 'rgba(224,169,63,0.18)' : 'rgba(63,185,80,0.18)'}` }} />
                  <span style={{ fontWeight: 700 }}>{data.delayed ? 'DELAYED DATA' : 'LIVE'}</span>
                  <span>· {data.source}</span>
                  {data.quote_time && <span style={{ color: 'var(--theme-secondary, #5e768f)' }}>· quote as of {new Date(data.quote_time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
                </div>
              )}
              <div style={STRIP}>
                <KpiCell grow minWidth={170} label={totalNet > 0 ? 'Net GEX · Dealers Long γ' : 'Net GEX · Dealers Short γ'}
                  value={`${totalNet > 0 ? '+' : ''}$${totalNet.toFixed(1)}M`} color={totalNet > 0 ? 'var(--theme-positive)' : 'var(--theme-negative)'} valueSize={16} />
                <KpiCell grow label="Spot Price" value={`$${spot?.toFixed(2)}`} />
                <KpiCell grow label="Call GEX" value={`+$${totalCall.toFixed(1)}M`} color="var(--theme-positive)" />
                <KpiCell grow label="Put GEX" value={`$${totalPut.toFixed(1)}M`} color="var(--theme-negative)" />
                <KpiCell grow label="Gamma Flip" value={flipLevel ? `~$${flipLevel.toLocaleString()}` : 'N/A'} />
              </div>

              <ChartPanel label="Net Dealer GEX by Strike ($M per 1% move)" height={368}
                note="Green = long γ (pin) · Red = short γ (amplify)">
                <ResponsiveContainer width="100%" height={340}>
                  {/* Top margin reserves a clear band above the bars for the spot
                      and flip labels, so neither overlaps the bars or each other. */}
                  <BarChart data={filtered} barCategoryGap="20%" barSize={18} margin={{ top: 40, right: 5, left: 5, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="strike" tick={TICK} tickFormatter={v => `$${v}`} interval="preserveStartEnd" />
                    <YAxis tick={TICK} tickFormatter={v => {
                      const a = Math.abs(v)
                      return a >= 1000 ? `${(v/1000).toFixed(1)}B` : `${v.toFixed(0)}M`
                    }} orientation="right" />
                    <Tooltip formatter={(v: number) => [`$${v.toFixed(1)}M`, 'Net GEX']} contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }} />
                    {spot && <ReferenceLine x={spot} stroke="color-mix(in srgb, var(--theme-primary) 70%, transparent)" strokeDasharray="4 4"
                      label={({ viewBox }: any) => (
                        // Row 1 of the top band — text to the left of the spot line.
                        <text x={Math.max(2, viewBox.x - 50)} y={viewBox.y - 26} fill="var(--theme-primary, #c9a84c)" fontSize={9} fontFamily="var(--theme-mono)">{`Spot $${spot.toFixed(0)}`}</text>
                      )} />}
                    {flipLevel && <ReferenceLine x={flipLevel} stroke="rgba(217,119,54,0.7)" strokeDasharray="3 5"
                      label={({ viewBox }: any) => {
                        // Row 2 of the top band — below the spot label, above the bars.
                        const x = Math.max(2, viewBox.x + 3)
                        return (
                          <g>
                            <rect x={x} y={viewBox.y - 20} width={62} height={14} fill="rgba(30,20,10,0.82)" rx={2} />
                            <text x={x + 3} y={viewBox.y - 10} fill="#d97736" fontSize={9} fontFamily="var(--theme-mono)">{`Flip $${flipLevel}`}</text>
                          </g>
                        )
                      }} />}
                    <Bar dataKey="net_gex" name="Net GEX" radius={[2,2,0,0]}>
                      {filtered.map((d: any, i: number) => (
                        <Cell key={i} fill={d.net_gex >= 0 ? cc.gain : cc.loss} fillOpacity={0.88} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartPanel>

              <ChartPanel label="Call vs Put GEX by Strike" height={308}
                note="Large put GEX = support · Large call GEX = resistance">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={filtered} barCategoryGap="20%" barSize={18}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="strike" tick={TICK} tickFormatter={v => `$${v}`} interval="preserveStartEnd" />
                    <YAxis tick={TICK} tickFormatter={v => {
                      const a = Math.abs(v)
                      return a >= 1000 ? `${(v/1000).toFixed(1)}B` : `${v.toFixed(0)}M`
                    }} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    {spot && <ReferenceLine x={spot} stroke="color-mix(in srgb, var(--theme-primary) 50%, transparent)" strokeDasharray="4 4" />}
                    <Bar dataKey="call_gex" name="Call GEX" fill={cc.gainMuted} stackId="s" radius={[2,2,0,0]} />
                    <Bar dataKey="put_gex"  name="Put GEX"  fill={cc.lossMuted}  stackId="s" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartPanel>

              <ChartPanel label="Open Interest Walls (Nearest Expiry)" height={288}
                note="Clipped at 90th pct · High OI = gravitational price level near expiry">
                {(() => {
                  const oiMap = data?.oiMap ?? {}
                  // Build from oiMap, filtered to spot range
                  const center = spot ? Math.round(spot / STEP) * STEP : 0
                  const raw = spot
                    ? Array.from({ length: 2 * nStrikes + 1 }, (_, i) => {
                        const s = center + (i - nStrikes) * STEP
                        const callOI = Object.entries(oiMap)
                          .filter(([k]) => Math.round(+k / STEP) * STEP === s)
                          .reduce((sum, [, v]: [string, any]) => sum + (v.callOI ?? 0), 0)
                        const putOI = Object.entries(oiMap)
                          .filter(([k]) => Math.round(+k / STEP) * STEP === s)
                          .reduce((sum, [, v]: [string, any]) => sum + (v.putOI ?? 0), 0)
                        return { strike: s, callOI, putOI: -putOI }
                      })
                    : Object.entries(oiMap)
                        .map(([k, v]: [string, any]) => ({ strike: +k, callOI: v.callOI, putOI: -v.putOI }))
                        .sort((a, b) => a.strike - b.strike)

                  // Clip at 90th percentile to prevent ATM spike flattening the chart
                  const absVals = raw.flatMap(d => [d.callOI, Math.abs(d.putOI)]).filter(v => v > 0).sort((a, b) => a - b)
                  const p90 = absVals[Math.floor(absVals.length * 0.9)] ?? 1
                  const clipped = raw.map(d => ({
                    strike: d.strike,
                    callOI: Math.min(d.callOI, p90),
                    putOI:  Math.max(d.putOI, -p90),
                  }))

                  return (
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={clipped} barCategoryGap="20%" barSize={18}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                        <XAxis dataKey="strike" tick={TICK} tickFormatter={v => `$${v}`} interval="preserveStartEnd" />
                        <YAxis tick={TICK} orientation="right"
                          tickFormatter={v => Math.abs(v) >= 1000 ? `${(Math.abs(v)/1000).toFixed(0)}k` : Math.abs(v).toFixed(0)} />
                        <Tooltip formatter={(v: number) => [Math.abs(v).toLocaleString(), '']} contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM} cursor={{ fill: 'var(--theme-hover, rgba(255,255,255,0.04))' }} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        {spot && <ReferenceLine x={spot} stroke="color-mix(in srgb, var(--theme-primary) 70%, transparent)" strokeDasharray="4 4"
                          label={{ value: 'Spot', fill: 'var(--theme-primary, #c9a84c)', fontSize: 9 }} />}
                        <Bar dataKey="callOI" name="Call OI" fill={cc.gainMuted} />
                        <Bar dataKey="putOI"  name="Put OI"  fill={cc.lossMuted} />
                      </BarChart>
                    </ResponsiveContainer>
                  )
                })()}
              </ChartPanel>
            </>
          )}
          {!data && !isPending && (
            <EmptyState title="Dealer GEX" hint="Enter a ticker and press Load GEX." />
          )}
        </SidebarLayout>
    </PageWrapper>
  )
}
