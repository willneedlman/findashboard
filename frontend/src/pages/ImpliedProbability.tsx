import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import axios from 'axios'
import EmptyState from '../components/EmptyState'
const INPUT: React.CSSProperties = { background: '#0a1628', border: '1px solid #4d4637', color: '#d7e3fc', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '5px 8px', width: '100%', outline: 'none' }
const LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e', marginBottom: 4, display: 'block' }
const TOOLTIP_STYLE = { background: '#142032', border: '1px solid #4d4637', borderRadius: 0 }
const TICK = { fontSize: 9, fill: '#99907e', fontFamily: 'JetBrains Mono, monospace' }

function MetricCard({ label, value, help, sub }: { label: string; value: string; help?: string; sub?: string }) {
  const [show, setShow] = useState(false)
  return (
    <div style={{ background: '#142032', border: '1px solid rgba(255,255,255,0.07)', borderTop: '3px solid #c9a84c', padding: 10, position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e' }}>{label}</span>
        {help && <span style={{ fontSize: 10, color: '#4d4637', cursor: 'help' }}
          onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>ⓘ</span>}
        {show && help && (
          <div style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', marginBottom: 6,
            background: '#0a1628', border: '1px solid #4d4637', padding: '6px 8px', width: 180, fontSize: 11,
            color: '#d7e3fc', lineHeight: '15px', zIndex: 50, pointerEvents: 'none' }}>
            {help}
          </div>
        )}
      </div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 700, color: '#d7e3fc' }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#4d4637', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function ChartPanel({ label, height, note, children }: { label: string; height: number; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ background: '#101c2e', border: '1px solid #2e394d', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'rgba(46,57,77,0.8)', padding: '3px 8px', borderRight: '1px solid #2e394d', borderBottom: '1px solid #2e394d', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#d7e3fc' }}>
        {label}
      </div>
      {note && <div style={{ position: 'absolute', top: 0, right: 0, padding: '3px 8px', fontSize: 10, color: '#4d4637', letterSpacing: '0.06em', zIndex: 10 }}>{note}</div>}
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>{children}</div>
    </div>
  )
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
      <div style={{ height: 1, flex: 1, background: '#2e394d' }} />
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#4d4637', whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ height: 1, flex: 1, background: '#2e394d' }} />
    </div>
  )
}

export default function ImpliedProbability() {
  const [ticker, setTicker]     = useState('SPY')
  const [targetPx, setTargetPx] = useState(550)
  const [expiry, setExpiry]     = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString().split('T')[0]
  })

  const { mutate, data, isPending } = useMutation({
    mutationFn: async () => {
      const [coneResp, distResp] = await Promise.allSettled([
        axios.post('/api/prob/cone', { ticker, target_px: targetPx, expiry }),
        axios.get(`/api/prob/chain-distribution?ticker=${ticker}&expiry=${expiry}`),
      ])
      return {
        cone: coneResp.status === 'fulfilled' ? coneResp.value.data : null,
        dist: distResp.status === 'fulfilled' ? distResp.value.data : null,
      }
    },
  })

  const cone = data?.cone
  const dist = data?.dist

  return (
    <PageWrapper>
      <SidebarLayout sidebarWidth={190} sidebarTitle="Probability Inputs" sidebar={<>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid #2e394d', background: '#142032' }}>
            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>Distribution Parameters</div>
          </div>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
            <div>
              <label style={LABEL}>Target Ticker</label>
              <input value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} style={INPUT}
                onFocus={e => (e.target.style.borderColor = '#c9a84c')} onBlur={e => (e.target.style.borderColor = '#4d4637')} />
            </div>
            <div>
              <label style={LABEL}>Target Expiry</label>
              <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} style={INPUT}
                onFocus={e => (e.target.style.borderColor = '#c9a84c')} onBlur={e => (e.target.style.borderColor = '#4d4637')} />
            </div>
            <div>
              <label style={LABEL}>Target Price ($)</label>
              <input type="number" value={targetPx} step={5} onChange={e => setTargetPx(+e.target.value)} style={INPUT}
                onFocus={e => (e.target.style.borderColor = '#c9a84c')} onBlur={e => (e.target.style.borderColor = '#4d4637')} />
            </div>
            <div style={{ fontSize: 10, color: '#4d4637', lineHeight: '14px' }}>
              Black-Scholes risk-neutral pricing. Reflects market hedging cost, not a directional forecast.
            </div>
          </div>
          <div style={{ padding: 10, borderTop: '1px solid #2e394d' }}>
            <button onClick={() => mutate()} disabled={isPending} style={{
              width: '100%', background: '#1f2a3d', border: '1px solid #c9a84c', color: '#c9a84c',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1,
            }}>
              {isPending ? 'Computing…' : '⬢ Generate Cone'}
            </button>
          </div>
        </>}>

          {/* Volatility Cone section */}
          {cone && (
            <>
              <div className="metric-grid">
                <MetricCard label="Current Spot"    value={`$${cone.S0.toLocaleString()}`} />
                <MetricCard label="ATM Implied Vol" value={`${(cone.sigma * 100).toFixed(1)}%`} />
                <MetricCard label={`P(Above $${targetPx})`} value={`${(cone.prob_above * 100).toFixed(1)}%`} />
                <MetricCard label="Risk-Free Rate"  value={`${(cone.r * 100).toFixed(2)}%`} />
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
                    <ReferenceLine y={targetPx} stroke="#d97736" strokeDasharray="5 3"
                      label={{ value: `Target $${targetPx}`, fill: '#d97736', fontSize: 9, position: 'right' }} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Area type="monotone" dataKey="upper"  stroke="#2f6b4b" strokeWidth={1.5} fill="url(#upperGrad)" name="~85th Pct" />
                    <Area type="monotone" dataKey="median" stroke="#1f5673" strokeWidth={2}   fill="transparent" strokeDasharray="4 2" name="Median" />
                    <Area type="monotone" dataKey="lower"  stroke="#8c2e36" strokeWidth={1.5} fill="url(#lowerGrad)" name="~15th Pct" />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartPanel>
            </>
          )}

          {/* Market-implied distribution section */}
          {dist && (
            <>
              <SectionHeader label="Market-Implied Probability Distribution" />

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 10 }}>
                <MetricCard label="Modal Strike" value={`$${dist.modal_strike.toLocaleString()}`} help="Strike with highest probability mass" />
                <MetricCard label="P10 Strike"   value={`$${dist.p10.toLocaleString()}`}          help="10% chance of finishing above" />
                <MetricCard label="P50 Strike"   value={`$${dist.p50.toLocaleString()}`}          help="50% chance of finishing above (median)" />
                <MetricCard label="P90 Strike"   value={`$${dist.p90.toLocaleString()}`}          help="90% chance of finishing above" />
                <MetricCard label="IV Skew (P−C)" value={`${dist.iv_skew > 0 ? '+' : ''}${dist.iv_skew.toFixed(1)}%`} help="Positive = put premium, fear indicator" />
              </div>

              <div style={{ fontSize: 10, color: '#4d4637', letterSpacing: '0.06em' }}>
                Expiry: <span style={{ color: '#c9a84c' }}>{dist.expiry}</span>
                &nbsp;·&nbsp; Avg Call IV: <span style={{ color: '#d7e3fc' }}>{dist.avg_call_iv.toFixed(1)}%</span>
                &nbsp;·&nbsp; Derived from live options chain — call delta ≈ risk-neutral P(S_T &gt; K)
              </div>

              <ChartPanel label={`Market-Implied Probability Density — ${ticker}`} height={348}>
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart data={dist.density} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis type="number" tick={TICK} tickFormatter={v => `${(v * 100).toFixed(2)}%`} />
                    <YAxis type="category" dataKey="strike" tick={TICK} width={52} tickFormatter={v => `$${v}`} reversed />
                    <Tooltip formatter={(v: number) => [`${(v * 100).toFixed(3)}%`, 'Density']} contentStyle={TOOLTIP_STYLE} />
                    {[dist.p10, dist.p50, dist.p90].map((level, i) => (
                      <ReferenceLine key={i} y={level} stroke={['#2f6b4b','#1f5673','#8c2e36'][i]} strokeDasharray="4 4"
                        label={{ value: `P${[10,50,90][i]}`, fill: ['#2f6b4b','#1f5673','#8c2e36'][i], fontSize: 9 }} />
                    ))}
                    <Area type="monotone" dataKey="density" stroke="#1f5673" fill="rgba(31,86,115,0.3)" strokeWidth={2} name="Market Density" />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartPanel>

              <ChartPanel label="Call Delta Curve — P(Finish Above Strike)" height={248}
                note={`P50 strike = $${dist.p50} (delta ≈ 0.50)`}>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={dist.delta_curve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="strike" tick={TICK} tickFormatter={v => `$${v}`} interval="preserveStartEnd" />
                    <YAxis tick={TICK} tickFormatter={v => `${(v * 100).toFixed(0)}%`} domain={[0,1]} orientation="right" />
                    <Tooltip formatter={(v: number) => [`${(v*100).toFixed(1)}%`, 'P(S_T > K)']} contentStyle={TOOLTIP_STYLE} />
                    <ReferenceLine y={0.5}      stroke="rgba(201,168,76,0.4)" strokeDasharray="4 4" label={{ value: '50%', fill: '#c9a84c', fontSize: 9, position: 'insideTopLeft' }} />
                    <ReferenceLine x={dist.p50} stroke="rgba(201,168,76,0.4)" strokeDasharray="4 4" label={{ value: `P50 $${dist.p50}`, fill: '#c9a84c', fontSize: 9, position: 'insideTopRight' }} />
                    <ReferenceLine x={dist.p10} stroke="rgba(47,107,75,0.5)"  strokeDasharray="3 5" label={{ value: 'P10', fill: '#2f6b4b', fontSize: 9 }} />
                    <ReferenceLine x={dist.p90} stroke="rgba(140,46,54,0.5)"  strokeDasharray="3 5" label={{ value: 'P90', fill: '#8c2e36', fontSize: 9 }} />
                    <Line type="monotone" dataKey="delta" stroke="#4a9abe" strokeWidth={2} dot={false} name="Call Delta" />
                  </LineChart>
                </ResponsiveContainer>
              </ChartPanel>
            </>
          )}

          {data && !dist && (
            <div style={{ background: '#101c2e', border: '1px solid #2e394d', padding: 16, fontSize: 12, color: '#4d4637' }}>
              Market-implied distribution unavailable — no options data for this ticker/expiry.
              The volatility cone above uses Black-Scholes with historical volatility.
            </div>
          )}

          {!data && !isPending && (
            <EmptyState title="Implied Probability" hint="Enter a ticker and expiry, then press Generate." />
          )}
        </SidebarLayout>
    </PageWrapper>
  )
}
