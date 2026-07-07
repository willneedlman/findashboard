import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, ReferenceDot, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { KpiCell } from '../components/mmCockpit'
import SidebarLayout from '../components/SidebarLayout'
import axios from 'axios'
import EmptyState from '../components/EmptyState'
import ExpirySelect from '../components/ExpirySelect'
import { useChartColors } from '../hooks/useChartColors'
import { INPUT, LABEL, TOOLTIP_STYLE, TICK, RailSection } from './valuationShared'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}
// KPI strips carry a 2px gold top border per the design.
const STRIP_GOLD: React.CSSProperties = { ...STRIP, borderTop: '2px solid var(--theme-primary, #c9a84c)' }

// Linear interpolation of a curve ([{strike, <key>}], strike-ascending) at x.
function interpAt(arr: any[] | undefined, key: string, x: number): number | null {
  if (!arr || arr.length === 0) return null
  if (x <= arr[0].strike) return arr[0][key]
  if (x >= arr[arr.length - 1].strike) return arr[arr.length - 1][key]
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1]
    if (x >= a.strike && x <= b.strike) {
      const t = (x - a.strike) / ((b.strike - a.strike) || 1)
      return a[key] + (b[key] - a[key]) * t
    }
  }
  return arr[arr.length - 1][key]
}

function ChartPanel({ label, height, note, children }: { label: string; height: number; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'var(--theme-surface, rgba(46,57,77,0.8))', padding: '3px 8px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)' }}>
        {label}
      </div>
      {note && <div style={{ position: 'absolute', top: 0, right: 0, padding: '3px 8px', fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', letterSpacing: '0.06em', zIndex: 10 }}>{note}</div>}
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>{children}</div>
    </div>
  )
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
      <div style={{ height: 1, flex: 1, background: 'var(--theme-hover, rgba(255,255,255,0.08))' }} />
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ height: 1, flex: 1, background: 'var(--theme-hover, rgba(255,255,255,0.08))' }} />
    </div>
  )
}

export function ImpliedProbabilityContent() {
  const cc = useChartColors()
  const [sp] = useSearchParams()
  const urlTicker = (sp.get('ticker') || '').trim().toUpperCase()
  const [ticker, setTicker] = useState(urlTicker || 'SPY')
  const [paramsOpen, setParamsOpen] = useState(true)
  const [expiry, setExpiry] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]
  })

  // Query (not mutation): the result is deterministic on (ticker, expiry), so
  // regenerating the same pair within the 15-min staleTime is a cache hit.
  // Arriving with ?ticker= (drawer, palette, linked mode) auto-loads it.
  const [submitted, setSubmitted] = useState<{ ticker: string; expiry: string } | null>(() =>
    urlTicker ? { ticker: urlTicker, expiry: (() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0] })() } : null)
  const { data, isFetching: isPending, error: mutError, refetch } = useQuery({
    queryKey: ['implied-prob', submitted?.ticker, submitted?.expiry],
    enabled: !!submitted,
    retry: false,
    queryFn: async () => {
      const [coneResp, distResp] = await Promise.allSettled([
        axios.post('/api/prob/cone', { ticker: submitted!.ticker, expiry: submitted!.expiry }),
        axios.get(`/api/prob/chain-distribution?ticker=${submitted!.ticker}&expiry=${submitted!.expiry}`),
      ])
      const cone = coneResp.status === 'fulfilled' ? coneResp.value.data : null
      const dist = distResp.status === 'fulfilled' ? distResp.value.data : null
      if (!cone && !dist) {
        const err = coneResp.status === 'rejected' ? coneResp.reason : null
        const isNetwork = err?.code === 'ERR_NETWORK' || err?.message?.includes('Network Error')
        throw Object.assign(new Error(isNetwork ? 'backend_down' : 'no_data'), { cone, dist })
      }
      return { cone, dist }
    },
  })
  // Same params → force a refetch; with retry:false a transient failure would
  // otherwise be stuck until the user edits an input.
  const generate = () => {
    if (submitted && submitted.ticker === ticker && submitted.expiry === expiry) refetch()
    else setSubmitted({ ticker, expiry })
  }

  const cone = data?.cone
  const dist = data?.dist

  // Probability Explorer: a strike the user drags to test, synced across both
  // lower charts. Seeds to the median and clamps to the density range on load.
  const [strike, setStrike] = useState<number | null>(null)
  useEffect(() => { if (dist?.p50 != null) setStrike(dist.p50) }, [dist])

  const dte = (() => {
    const d = new Date(`${expiry}T00:00:00`)
    return isNaN(+d) ? null : Math.max(0, Math.round((+d - Date.now()) / 86_400_000))
  })()

  return (
    <SidebarLayout sidebarWidth={210} sidebarTitle="" sidebar={<>
          <RailSection title="Distribution Parameters" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div>
              <label style={LABEL}>Target Ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} style={INPUT}
                onFocus={e => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')} onBlur={e => (e.target.style.borderColor = 'var(--theme-border, rgba(255,255,255,0.10))')} />
            </div>
            <div>
              <label style={LABEL}>Target Expiry</label>
              <ExpirySelect ticker={ticker} value={expiry} onChange={setExpiry} style={INPUT} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', lineHeight: '14px' }}>
              Black-Scholes risk-neutral pricing. Reflects market hedging cost, not a directional forecast.
            </div>
          </div>
          </RailSection>
          <div style={{ padding: 12 }}>
            <button onClick={generate} disabled={isPending} style={{
              width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1,
            }}>
              {isPending ? 'Computing…' : '↓ Generate'}
            </button>
          </div>
        </>}>

          {/* Volatility Cone section */}
          {cone && (
            <>
              <div style={STRIP_GOLD}>
                <KpiCell grow minWidth={150} label="Current Spot" value={`$${cone.S0.toLocaleString()}`} color="var(--theme-primary, #c9a84c)" valueSize={16} />
                <KpiCell grow label="ATM Implied Vol" value={`${(cone.sigma * 100).toFixed(1)}%`} color="var(--theme-tertiary, #60a5fa)" />
                <KpiCell grow label="Risk-Free Rate" value={`${(cone.r * 100).toFixed(2)}%`} />
                <KpiCell grow label="Days to Expiry" value={dte != null ? `${dte}d` : '—'} />
              </div>

              <ChartPanel label={`Volatility Cone — ${ticker}`} height={328} note="BS Risk-Neutral">
                <ResponsiveContainer width="100%" height={300}>
                  <AreaChart data={cone.cone}>
                    <defs>
                      <linearGradient id="upperGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2f6b4b" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="#2f6b4b" stopOpacity={0.03} />
                      </linearGradient>
                      <linearGradient id="lowerGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#8c2e36" stopOpacity={0.2} />
                        <stop offset="100%" stopColor="#8c2e36" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="date" tick={TICK} tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                    <YAxis tick={TICK} tickFormatter={v => `$${v.toFixed(0)}`} orientation="right" domain={['auto','auto']} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Area type="monotone" dataKey="upper"  stroke={cc.gain} strokeWidth={1.5} fill="url(#upperGrad)" name="~85th Pct" />
                    <Area type="monotone" dataKey="median" stroke={cc.c2}   strokeWidth={2}   fill="transparent" strokeDasharray="4 2" name="Median" />
                    <Area type="monotone" dataKey="lower"  stroke={cc.loss} strokeWidth={1.5} fill="url(#lowerGrad)" name="~15th Pct" />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartPanel>
            </>
          )}

          {/* Market-implied distribution section */}
          {dist && (() => {
            const sMin = dist.density?.length ? dist.density[0].strike : 0
            const sMax = dist.density?.length ? dist.density[dist.density.length - 1].strike : 0
            const k = strike ?? dist.p50
            const pAbove = interpAt(dist.delta_curve, 'delta', k)
            const densV = interpAt(dist.density, 'density', k)
            const dPoint = dist.density?.length
              ? dist.density.reduce((b: any, p: any) => Math.abs(p.strike - k) < Math.abs(b.strike - k) ? p : b, dist.density[0])
              : null
            const spot = cone?.S0 ?? null
            const vsSpot = spot ? (k - spot) / spot * 100 : null
            const GOLD = 'var(--theme-primary, #c9a84c)', SEC = 'var(--theme-secondary, #8099b0)'
            return (
            <>
              <SectionHeader label="Market-Implied Probability Distribution" />

              <div style={STRIP_GOLD}>
                <KpiCell grow label="Modal Strike" value={`$${dist.modal_strike.toLocaleString()}`} sub="most likely" />
                <KpiCell grow label="P10 Strike" value={`$${dist.p10.toLocaleString()}`} color={cc.gain} sub="10% finish above" />
                <KpiCell grow minWidth={130} label="P50 Strike" value={`$${dist.p50.toLocaleString()}`} color={GOLD} valueSize={16} sub="median" />
                <KpiCell grow label="P90 Strike" value={`$${dist.p90.toLocaleString()}`} color={cc.loss} sub="90% finish above" />
                <KpiCell grow label="IV Skew (P−C)" value={`${dist.iv_skew > 0 ? '+' : ''}${dist.iv_skew.toFixed(1)}%`} color={dist.iv_skew > 0 ? cc.loss : cc.gain} sub="put-rich" />
              </div>

              <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.4))', letterSpacing: '0.06em', lineHeight: 1.5 }}>
                Expiry: <span style={{ color: GOLD }}>{dist.expiry}</span>
                &nbsp;·&nbsp; Avg Call IV: <span style={{ color: 'var(--theme-text, #d7e3fc)' }}>{dist.avg_call_iv.toFixed(1)}%</span>
                &nbsp;·&nbsp; P(S_T &gt; K) = N(d2) from the live IV skew. Risk-neutral, not a real-world forecast. For premium selling the skew matters more than the peak.
              </div>

              {/* Probability Explorer — drag a strike, synced across both charts */}
              <div style={{ background: 'var(--theme-surface, #0d1826)', border: '1px solid rgba(201,168,76,0.3)', padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 11 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: GOLD }}>Probability Explorer</span>
                </div>
                <div>
                  <input type="range" min={sMin} max={sMax} step={1} value={k} onChange={e => setStrike(+e.target.value)}
                    style={{ width: '100%', accentColor: GOLD }} aria-label="Test strike" />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--theme-mono)', fontSize: 9, color: SEC, marginTop: 2 }}>
                    <span>${sMin}</span><span>${sMax}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'stretch', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                  <KpiCell grow label="Strike" value={`$${k.toLocaleString()}`} color={GOLD} valueSize={18} />
                  <KpiCell grow label="P(Finish Above)" value={pAbove != null ? `${(pAbove * 100).toFixed(1)}%` : '—'} color={cc.gain} valueSize={18} />
                  <KpiCell grow label="P(Below)" value={pAbove != null ? `${((1 - pAbove) * 100).toFixed(1)}%` : '—'} color={cc.loss} valueSize={18} />
                  <KpiCell grow label="Density" value={densV != null ? `${(densV * 100).toFixed(2)}%` : '—'} color="var(--theme-tertiary, #60a5fa)" valueSize={18} />
                  <KpiCell grow label="vs Spot" value={vsSpot != null ? `${vsSpot >= 0 ? '+' : ''}${vsSpot.toFixed(1)}%` : '—'} color={(vsSpot ?? 0) >= 0 ? cc.gain : cc.loss} valueSize={18} />
                </div>
              </div>

              {/* Bottom chart row: density + cumulative side-by-side */}
              <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', flexWrap: 'wrap' }}>
                <div style={{ width: 372, flexShrink: 0, minWidth: 0 }}>
                  <ChartPanel label={`Probability Density — ${ticker}`} height={324}>
                    <ResponsiveContainer width="100%" height={296}>
                      <AreaChart data={dist.density} layout="vertical">
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.045)" />
                        <XAxis type="number" tick={TICK} tickFormatter={v => `${(v * 100).toFixed(1)}%`} />
                        <YAxis type="category" dataKey="strike" tick={TICK} width={52} tickFormatter={v => `$${v}`} reversed />
                        <Tooltip formatter={(v: number) => [`${(v * 100).toFixed(3)}%`, 'Density']} contentStyle={TOOLTIP_STYLE} />
                        <ReferenceLine y={dist.modal_strike} stroke={SEC} strokeDasharray="4 4" strokeOpacity={0.5} label={{ value: 'Modal', fill: SEC, fontSize: 9 }} />
                        <Area type="monotone" dataKey="density" stroke={cc.c2} fill={cc.c2Dim} strokeWidth={2} name="Market Density" />
                        {dPoint && <ReferenceLine y={dPoint.strike} stroke={GOLD} strokeDasharray="5 3" />}
                        {dPoint && <ReferenceDot x={dPoint.density} y={dPoint.strike} r={4} fill={GOLD} stroke="#0a1320" strokeWidth={1.5} />}
                      </AreaChart>
                    </ResponsiveContainer>
                  </ChartPanel>
                </div>
                <div style={{ flex: 1, minWidth: 320 }}>
                  <ChartPanel label="Cumulative — P(Finish Above Strike)" height={324} note={`P50 = $${dist.p50}`}>
                    <ResponsiveContainer width="100%" height={296}>
                      <LineChart data={dist.delta_curve} margin={{ top: 22, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.045)" />
                        <XAxis type="number" dataKey="strike" domain={['dataMin', 'dataMax']} tick={TICK} tickFormatter={v => `$${v}`} interval="preserveStartEnd" />
                        <YAxis tick={TICK} tickFormatter={v => `${(v * 100).toFixed(0)}%`} domain={[0, 1]} orientation="right" />
                        <Tooltip formatter={(v: number) => [`${(v * 100).toFixed(1)}%`, 'P(S_T > K)']} contentStyle={TOOLTIP_STYLE} />
                        <ReferenceLine y={0.5}      stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)" strokeDasharray="4 4" label={{ value: '50%', fill: GOLD, fontSize: 9, position: 'insideLeft' }} />
                        <ReferenceLine x={dist.p50} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 45%, transparent)" strokeDasharray="4 4" label={{ value: 'P50', fill: GOLD, fontSize: 9, position: 'top' }} />
                        <ReferenceLine x={dist.p10} stroke={cc.gainMuted} strokeDasharray="3 5" label={{ value: 'P10', fill: cc.gain, fontSize: 9, position: 'top' }} />
                        <ReferenceLine x={dist.p90} stroke={cc.lossMuted} strokeDasharray="3 5" label={{ value: 'P90', fill: cc.loss, fontSize: 9, position: 'top' }} />
                        <Line type="monotone" dataKey="delta" stroke={cc.c2} strokeWidth={2.2} dot={false} name="P(S_T > K)" />
                        <ReferenceLine x={k} stroke={GOLD} strokeDasharray="5 3" />
                        {pAbove != null && <ReferenceDot x={k} y={pAbove} r={4} fill={GOLD} stroke="#0a1320" strokeWidth={1.5} />}
                      </LineChart>
                    </ResponsiveContainer>
                  </ChartPanel>
                </div>
              </div>
            </>
            )
          })()}

          {data && !dist && (
            <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: 16, fontSize: 12, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>
              Market-implied distribution unavailable — no options data for this ticker/expiry.
              The volatility cone above uses Black-Scholes with historical volatility.
            </div>
          )}

          {mutError && (
            <div style={{ background: 'color-mix(in srgb, var(--theme-negative) 7%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-negative) 30%, transparent)', padding: '12px 16px', fontSize: 12, color: 'var(--theme-text, #d7e3fc)' }}>
              {(mutError as Error).message === 'backend_down'
                ? 'Backend unreachable — start the API server (uvicorn main:app --reload --port 8000) and try again.'
                : 'No data returned — check ticker and try again.'}
            </div>
          )}

          {!data && !mutError && !isPending && (
            <EmptyState title="Implied Probability" hint="Enter a ticker and expiry, then press Generate." />
          )}
        </SidebarLayout>
  )
}

export default function ImpliedProbability() {
  return <PageWrapper title="Implied Probability"><ImpliedProbabilityContent /></PageWrapper>
}
