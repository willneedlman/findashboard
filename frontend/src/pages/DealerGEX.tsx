import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import { fetchGEX, fetchOptionsChain } from '../hooks/useApi'
import EmptyState from '../components/EmptyState'
const INPUT: React.CSSProperties = { background: '#0a1628', border: '1px solid #4d4637', color: '#d7e3fc', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '5px 8px', width: '100%', outline: 'none' }
const LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e', marginBottom: 4, display: 'block' }
const TOOLTIP_STYLE = { background: '#142032', border: '1px solid #4d4637', borderRadius: 0 }
const TICK = { fontSize: 9, fill: '#99907e', fontFamily: 'JetBrains Mono, monospace' }

function MetricCard({ label, value, sub, help }: { label: string; value: string; sub?: string; help?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ background: '#142032', border: '1px solid rgba(255,255,255,0.07)', borderTop: '3px solid #c9a84c', padding: 10, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e' }}>{label}</span>
        {help && <span style={{ fontSize: 10, color: '#4d4637', cursor: 'help' }}
          onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>ⓘ</span>}
        {show && help && (
          <div style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 6, background: '#0a1628', border: '1px solid #4d4637', padding: '6px 8px', width: 180, fontSize: 11, color: '#d7e3fc', lineHeight: '15px', zIndex: 50, pointerEvents: 'none' }}>{help}</div>
        )}
      </div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 700, color: '#d7e3fc' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#4d4637', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function ChartPanel({ label, note, height, children }: { label: string; note?: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: '#101c2e', border: '1px solid #2e394d', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'rgba(46,57,77,0.8)', padding: '3px 8px', borderRight: '1px solid #2e394d', borderBottom: '1px solid #2e394d', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#d7e3fc' }}>{label}</div>
      {note && <div style={{ position: 'absolute', top: 0, right: 0, padding: '3px 8px', fontSize: 10, color: '#4d4637', zIndex: 10 }}>{note}</div>}
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>{children}</div>
    </div>
  )
}

export default function DealerGEX() {
  const [ticker, setTicker]           = useState('SPY')
  const [rangePercent, setRangePercent] = useState(15)

  const { mutate, data, isPending } = useMutation({
    mutationFn: async () => {
      const [gex, chain] = await Promise.all([fetchGEX(ticker), fetchOptionsChain(ticker)])
      // Build OI map keyed by strike
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
  const filtered = spot && data?.data
    ? data.data.filter((d: any) => d.strike >= spot * (1 - rangePercent / 100) && d.strike <= spot * (1 + rangePercent / 100))
    : (data?.data ?? [])

  const totalNet  = data?.data?.reduce((s: number, d: any) => s + d.net_gex, 0) ?? 0
  const totalCall = data?.data?.reduce((s: number, d: any) => s + d.call_gex, 0) ?? 0

  let flipLevel: number | null = null
  if (data?.data) {
    const sorted = [...data.data].sort((a, b) => a.strike - b.strike)
    let cum = 0
    for (let i = 0; i < sorted.length - 1; i++) {
      const prev = cum; cum += sorted[i].net_gex
      if (prev * cum < 0) { flipLevel = sorted[i].strike; break }
    }
  }

  return (
    <PageWrapper>
      <SidebarLayout sidebarWidth={190} sidebarTitle="GEX Controls" sidebar={<>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #2e394d', background: '#142032' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>GEX Parameters</div>
          </div>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
            <div>
              <label style={LABEL}>Ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} style={INPUT}
                onFocus={e => (e.target.style.borderColor = '#c9a84c')} onBlur={e => (e.target.style.borderColor = '#4d4637')} />
            </div>
            <div>
              <label style={LABEL}>Strike Range (% each side)</label>
              <input type="number" value={rangePercent} step={5} min={5} max={50} onChange={e => setRangePercent(+e.target.value)} style={INPUT}
                onFocus={e => (e.target.style.borderColor = '#c9a84c')} onBlur={e => (e.target.style.borderColor = '#4d4637')} />
            </div>
            <div style={{ fontSize: 10, color: '#4d4637', lineHeight: '14px' }}>
              Aggregates all expiry chains. May take 20–40s on first load.
            </div>
          </div>
          <div style={{ padding: 10, borderTop: '1px solid #2e394d' }}>
            <button onClick={() => mutate()} disabled={isPending} style={{
              width: '100%', background: '#1f2a3d', border: '1px solid #c9a84c', color: '#c9a84c',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1,
            }}>
              {isPending ? 'Loading chains…' : '⬢ Load GEX Profile'}
            </button>
          </div>
        </>}>
          {data && (
            <>
              <div className="metric-grid">
                <MetricCard label="Spot Price" value={`$${spot?.toLocaleString()}`} />
                <MetricCard label="Net GEX" value={`${totalNet > 0 ? '+' : ''}$${totalNet.toFixed(1)}M`}
                  sub={totalNet > 0 ? 'Dealers long γ' : 'Dealers short γ'}
                  help="Positive = dealers long gamma (stabilising). Negative = dealers short (trend amplification)." />
                <MetricCard label="Call GEX" value={`+$${totalCall.toFixed(1)}M`} />
                <MetricCard label="Gamma Flip" value={flipLevel ? `~$${flipLevel.toLocaleString()}` : 'N/A'}
                  help="Cumulative net GEX zero crossing — key support/resistance level." />
              </div>

              <ChartPanel label="Net Dealer GEX by Strike ($M per 1% move)" height={368}
                note="Green = long γ (pin) · Red = short γ (amplify)">
                <ResponsiveContainer width="100%" height={340}>
                  <BarChart data={filtered}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="strike" tick={TICK} tickFormatter={v => `$${v}`} />
                    <YAxis tick={TICK} tickFormatter={v => `${v.toFixed(1)}M`} orientation="right" />
                    <Tooltip formatter={(v: number) => [`$${v.toFixed(2)}M`, 'Net GEX']} contentStyle={TOOLTIP_STYLE} />
                    {spot && <ReferenceLine x={spot} stroke="rgba(201,168,76,0.7)" strokeDasharray="4 4"
                      label={{ value: `Spot $${spot}`, fill: '#c9a84c', fontSize: 9 }} />}
                    {flipLevel && <ReferenceLine x={flipLevel} stroke="rgba(217,119,54,0.7)" strokeDasharray="3 5"
                      label={{ value: `Flip $${flipLevel}`, fill: '#d97736', fontSize: 9 }} />}
                    <Bar dataKey="net_gex" name="Net GEX">
                      {filtered.map((d: any, i: number) => (
                        <Cell key={i} fill={d.net_gex >= 0 ? '#2e7d4f' : '#8c2e36'} fillOpacity={0.85} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </ChartPanel>

              <ChartPanel label="Call vs Put GEX by Strike" height={308}
                note="Large put GEX = support · Large call GEX = resistance">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={filtered}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="strike" tick={TICK} tickFormatter={v => `$${v}`} />
                    <YAxis tick={TICK} tickFormatter={v => `${v.toFixed(1)}M`} orientation="right" />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    {spot && <ReferenceLine x={spot} stroke="rgba(201,168,76,0.5)" strokeDasharray="4 4" />}
                    <Bar dataKey="call_gex" name="Call GEX" fill="rgba(46,125,79,0.75)" stackId="s" />
                    <Bar dataKey="put_gex"  name="Put GEX"  fill="rgba(140,46,54,0.75)"  stackId="s" />
                  </BarChart>
                </ResponsiveContainer>
              </ChartPanel>

              <ChartPanel label="Open Interest Walls (Nearest Expiry)" height={288}
                note="Clipped at 90th pct · High OI = gravitational price level near expiry">
                {(() => {
                  const oiMap = data?.oiMap ?? {}
                  // Build from oiMap, filtered to spot range
                  const raw = Object.entries(oiMap)
                    .map(([k, v]: [string, any]) => ({ strike: +k, callOI: v.callOI, putOI: -v.putOI }))
                    .filter(d => !spot || (d.strike >= spot * (1 - rangePercent / 100) && d.strike <= spot * (1 + rangePercent / 100)))
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
                      <BarChart data={clipped}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                        <XAxis dataKey="strike" tick={TICK} tickFormatter={v => `$${v}`} />
                        <YAxis tick={TICK} orientation="right"
                          tickFormatter={v => Math.abs(v) >= 1000 ? `${(Math.abs(v)/1000).toFixed(0)}k` : Math.abs(v).toFixed(0)} />
                        <Tooltip formatter={(v: number) => [Math.abs(v).toLocaleString(), '']} contentStyle={TOOLTIP_STYLE} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        {spot && <ReferenceLine x={spot} stroke="rgba(201,168,76,0.7)" strokeDasharray="4 4"
                          label={{ value: 'Spot', fill: '#c9a84c', fontSize: 9 }} />}
                        <Bar dataKey="callOI" name="Call OI" fill="rgba(46,125,79,0.75)" />
                        <Bar dataKey="putOI"  name="Put OI"  fill="rgba(140,46,54,0.75)" />
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
