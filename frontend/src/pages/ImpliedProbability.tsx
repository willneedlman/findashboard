import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts'
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
  const [ticker, setTicker] = useState('SPY')
  const [paramsOpen, setParamsOpen] = useState(true)
  const [expiry, setExpiry] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]
  })

  const { mutate, data, isPending, error: mutError } = useMutation({
    mutationFn: async () => {
      const [coneResp, distResp] = await Promise.allSettled([
        axios.post('/api/prob/cone', { ticker, expiry }),
        axios.get(`/api/prob/chain-distribution?ticker=${ticker}&expiry=${expiry}`),
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

  const cone = data?.cone
  const dist = data?.dist

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
            <button onClick={() => mutate()} disabled={isPending} style={{
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
              <div style={STRIP}>
                <KpiCell grow minWidth={150} label="Current Spot" value={`$${cone.S0.toLocaleString()}`} color="var(--theme-primary, #c9a84c)" valueSize={16} />
                <KpiCell grow label="ATM Implied Vol" value={`${(cone.sigma * 100).toFixed(1)}%`} color="var(--theme-tertiary, #60a5fa)" />
                <KpiCell grow label="Risk-Free Rate" value={`${(cone.r * 100).toFixed(2)}%`} />
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
          {dist && (
            <>
              <SectionHeader label="Market-Implied Probability Distribution" />

              <div style={STRIP}>
                <KpiCell grow minWidth={150} label="P50 Strike · Median" value={`$${dist.p50.toLocaleString()}`} color="var(--theme-primary, #c9a84c)" valueSize={16} />
                <KpiCell grow label="Modal Strike" value={`$${dist.modal_strike.toLocaleString()}`} />
                <KpiCell grow label="P10 Strike" value={`$${dist.p10.toLocaleString()}`} />
                <KpiCell grow label="P90 Strike" value={`$${dist.p90.toLocaleString()}`} />
                <KpiCell grow label="IV Skew (P−C)" value={`${dist.iv_skew > 0 ? '+' : ''}${dist.iv_skew.toFixed(1)}%`} color={dist.iv_skew > 0 ? 'var(--theme-negative)' : 'var(--theme-positive)'} />
              </div>

              <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', letterSpacing: '0.06em' }}>
                Expiry: <span style={{ color: 'var(--theme-primary, #c9a84c)' }}>{dist.expiry}</span>
                &nbsp;·&nbsp; Avg Call IV: <span style={{ color: 'var(--theme-text, #d7e3fc)' }}>{dist.avg_call_iv.toFixed(1)}%</span>
                &nbsp;·&nbsp; P(S_T &gt; K) = N(d2) from the live IV smile (skew-aware)
              </div>
              <div style={{ fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', letterSpacing: '0.04em', marginTop: 4, lineHeight: 1.5 }}>
                This is the <span style={{ color: 'var(--theme-text, #d7e3fc)' }}>risk-neutral</span> distribution — what options price in, including a downside risk premium — not a real-world forecast. Realized jumps and gaps (earnings, macro) can exceed the smooth curve. For premium selling, the skew matters more than the peak.
              </div>

              <ChartPanel label={`Market-Implied Probability Density — ${ticker}`} height={348}>
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart data={dist.density} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis type="number" tick={TICK} tickFormatter={v => `${(v * 100).toFixed(2)}%`} />
                    <YAxis type="category" dataKey="strike" tick={TICK} width={52} tickFormatter={v => `$${v}`} reversed />
                    <Tooltip formatter={(v: number) => [`${(v * 100).toFixed(3)}%`, 'Density']} contentStyle={TOOLTIP_STYLE} />
                    {[dist.p10, dist.p50, dist.p90].map((level, i) => (
                      <ReferenceLine key={i} y={level} stroke={[cc.gain,cc.c2,cc.loss][i]} strokeDasharray="4 4"
                        label={{ value: `P${[10,50,90][i]}`, fill: [cc.gain,cc.c2,cc.loss][i], fontSize: 9 }} />
                    ))}
                    <Area type="monotone" dataKey="density" stroke={cc.c2} fill={cc.c2Dim} strokeWidth={2} name="Market Density" />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartPanel>

              <ChartPanel label="Cumulative Probability — P(Finish Above Strike)" height={248}
                note={`P50 strike = $${dist.p50} (50% above)`}>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={dist.delta_curve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="strike" tick={TICK} tickFormatter={v => `$${v}`} interval="preserveStartEnd" />
                    <YAxis tick={TICK} tickFormatter={v => `${(v * 100).toFixed(0)}%`} domain={[0,1]} orientation="right" />
                    <Tooltip formatter={(v: number) => [`${(v*100).toFixed(1)}%`, 'P(S_T > K)']} contentStyle={TOOLTIP_STYLE} />
                    <ReferenceLine y={0.5}      stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)" strokeDasharray="4 4" label={{ value: '50%', fill: 'var(--theme-primary, #c9a84c)', fontSize: 9, position: 'insideTopLeft' }} />
                    <ReferenceLine x={dist.p50} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)" strokeDasharray="4 4" label={{ value: `P50 $${dist.p50}`, fill: 'var(--theme-primary, #c9a84c)', fontSize: 9, position: 'insideTopRight' }} />
                    <ReferenceLine x={dist.p10} stroke={cc.gainMuted} strokeDasharray="3 5" label={{ value: 'P10', fill: cc.gain, fontSize: 9 }} />
                    <ReferenceLine x={dist.p90} stroke={cc.lossMuted} strokeDasharray="3 5" label={{ value: 'P90', fill: cc.loss, fontSize: 9 }} />
                    <Line type="monotone" dataKey="delta" stroke={cc.c2} strokeWidth={2} dot={false} name="P(S_T > K)" />
                  </LineChart>
                </ResponsiveContainer>
              </ChartPanel>
            </>
          )}

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
