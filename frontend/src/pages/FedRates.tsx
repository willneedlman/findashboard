import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { fetchYieldCurve, fetchFedProjections } from '../hooks/useApi'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR } from '../components/ChartTooltip'

const FED_WEIGHTS = [1.0, 0.9, 0.7, 0.5, 0.3, 0.1]
const YC_WEIGHTS  = [0.98, 0.85, 0.40, 0.1, -0.19, -0.325]
const TICK = { fontSize: 9, fill: '#99907e', fontFamily: 'JetBrains Mono, monospace' }

function MetricCard({ label, value, delta, deltaPositive, sub }: { label: string; value: string; delta?: string; deltaPositive?: boolean; sub?: string }) {
  return (
    <div style={{ background: '#142032', border: '1px solid rgba(255,255,255,0.07)', borderTop: '3px solid #c9a84c', padding: 10 }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#99907e', marginBottom: 6 }}>{label}</div>
      <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 18, fontWeight: 700, color: '#d7e3fc' }}>{value}</div>
      {delta && <div style={{ fontSize: 10, marginTop: 2, color: deltaPositive ? '#22C55E' : '#EF4444' }}>{delta}</div>}
      {sub && <div style={{ fontSize: 10, marginTop: 2, color: '#4d4637' }}>{sub}</div>}
    </div>
  )
}

function ChartPanel({ label, height, children }: { label: string; height: number; children: React.ReactNode }) {
  return (
    <div style={{ background: '#101c2e', border: '1px solid #2e394d', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 0, left: 0, zIndex: 10, background: 'rgba(46,57,77,0.8)', padding: '3px 8px', borderRight: '1px solid #2e394d', borderBottom: '1px solid #2e394d', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#d7e3fc' }}>{label}</div>
      <div style={{ paddingTop: 28, paddingLeft: 8, paddingRight: 8, paddingBottom: 8, height }}>{children}</div>
    </div>
  )
}

export default function FedRates() {
  const [twist, setTwist] = useState(0)

  const { data: curveData } = useQuery({ queryKey: ['yield-curve'],    queryFn: fetchYieldCurve })
  const { data: fedData }   = useQuery({ queryKey: ['fed-projections'], queryFn: fetchFedProjections })

  const adjustedMeetings = fedData?.meetings.map((m: any, i: number) => ({
    ...m,
    base_rate:     m.rate,
    adjusted_rate: +(m.rate + (twist / 100) * (FED_WEIGHTS[i] ?? 0.05)).toFixed(2),
  })) ?? []

  const tenors = ['1Y', '2Y', '5Y', '10Y', '20Y', '30Y']
  const adjustedCurve = curveData ? tenors.map((t, i) => ({
    tenor:    t,
    current:  curveData.curve[t] ?? 0,
    adjusted: +Math.max(0.1, (curveData.curve[t] ?? 0) + (twist / 100) * YC_WEIGHTS[i]).toFixed(3),
  })) : []

  const nextRate  = adjustedMeetings[0]?.adjusted_rate
  const yearEnd   = adjustedMeetings[4]?.adjusted_rate
  const totalMove = adjustedMeetings.length >= 2
    ? ((adjustedMeetings.at(-1)?.adjusted_rate ?? 0) - (adjustedMeetings[0]?.adjusted_rate ?? 0)) * 100
    : 0

  return (
    <PageWrapper>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden', width: '100%' }}>

        {/* Rate sensitivity slider — full width */}
        <div style={{ background: '#101c2e', border: '1px solid #2e394d', padding: '10px 14px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>
              Rate Sensitivity
            </span>
            <input type="range" min={-200} max={200} step={5} value={twist}
              onChange={e => setTwist(+e.target.value)} style={{ flex: 1, minWidth: 80, accentColor: '#c9a84c' }} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 14, fontWeight: 700, color: '#c9a84c', whiteSpace: 'nowrap', width: 80, textAlign: 'right' }}>
              {twist > 0 ? '+' : ''}{twist} bps
            </span>
            {twist !== 0 && (
              <button onClick={() => setTwist(0)} style={{ fontSize: 9, color: '#4d4637', background: 'none', border: '1px solid #2e394d', padding: '3px 8px', cursor: 'pointer', letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Summary metrics */}
        {adjustedMeetings.length > 0 && (
          <div className="metric-grid">
            <MetricCard label="Next Meeting Implied" value={`${nextRate?.toFixed(2)}%`}
              delta={twist !== 0 ? `${(twist * FED_WEIGHTS[0]).toFixed(1)} bps adj` : undefined}
              deltaPositive={twist < 0} />
            <MetricCard label="Year-End 2026" value={`${yearEnd?.toFixed(2)}%`} />
            <MetricCard label="Total Projected Move"
              value={`${totalMove > 0 ? '+' : ''}${totalMove.toFixed(0)} bps`}
              deltaPositive={totalMove < 0} sub="Through last FOMC meeting" />
          </div>
        )}

        {/* FOMC probabilities */}
        <div style={{ background: '#101c2e', border: '1px solid #2e394d' }}>
          <div style={{ padding: '6px 10px', borderBottom: '1px solid #2e394d', background: '#142032' }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#ffffff' }}>Next FOMC Meeting — Probability Breakdown</span>
          </div>
          <div style={{ padding: 10 }} className="metric-grid">
            <MetricCard label="Hike +50bps" value="2%"  />
            <MetricCard label="Hike +25bps" value="10%" />
            <MetricCard label="Hold"        value="82%" />
            <MetricCard label="Cut −25bps"  value="6%"  />
          </div>
        </div>

        {/* Rate path + Yield curve */}
        {adjustedMeetings.length > 0 && adjustedCurve.length > 0 && (
          <div className="chart-pair">
            <ChartPanel label="Market-Implied Fed Funds Rate Path" height={248}>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={adjustedMeetings}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                  <XAxis dataKey="date" tick={TICK} />
                  <YAxis tick={TICK} tickFormatter={v => `${v}%`} domain={['auto','auto']} orientation="right" />
                  <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Line type="monotone" dataKey="base_rate" stroke="#4d4637" strokeWidth={1.5} strokeDasharray="5 3" dot={{ fill: '#4d4637', r: 3 }} name="Base Path" />
                  <Line type="monotone" dataKey="adjusted_rate" stroke="#1f5673" strokeWidth={2.5} dot={{ fill: '#d97736', r: 4 }} name="Adjusted Path" />
                </LineChart>
              </ResponsiveContainer>
            </ChartPanel>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {/* Yield curve tenors */}
              <div className="metric-grid">
                {adjustedCurve.map(pt => (
                  <MetricCard key={pt.tenor} label={pt.tenor} value={`${pt.adjusted.toFixed(2)}%`}
                    delta={twist !== 0 ? `${((pt.adjusted - pt.current) * 100).toFixed(0)} bps` : undefined}
                    deltaPositive={(pt.adjusted - pt.current) < 0} />
                ))}
              </div>
              <ChartPanel label="US Treasury Yield Curve" height={158}>
                <ResponsiveContainer width="100%" height={130}>
                  <LineChart data={adjustedCurve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="tenor" tick={TICK} />
                    <YAxis tick={TICK} tickFormatter={v => `${v}%`} domain={['auto','auto']} orientation="right" />
                    <Tooltip formatter={(v: number) => [`${v.toFixed(3)}%`, '']} contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                    <Line type="monotone" dataKey="current"  stroke="#4d4637" strokeWidth={1.5} strokeDasharray="5 3" dot={{ fill: '#4d4637', r: 3 }} name="Current" />
                    <Line type="monotone" dataKey="adjusted" stroke="#1f5673" strokeWidth={2.5} dot={{ fill: '#d97736', r: 4 }} name="Adjusted" />
                  </LineChart>
                </ResponsiveContainer>
              </ChartPanel>
            </div>
          </div>
        )}

        {/* Meeting probability distribution */}
        {fedData && (
          <ChartPanel label="Meeting Probability Distribution (Hike / Hold / Cut)" height={228}>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={fedData.meetings}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                <XAxis dataKey="date" tick={TICK} />
                <YAxis tick={TICK} tickFormatter={v => `${v}%`} orientation="right" />
                <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="prob_hike" name="Hike" fill="#8c2e36" stackId="a" />
                <Bar dataKey="prob_hold" name="Hold" fill="#5e768f" stackId="a" />
                <Bar dataKey="prob_cut"  name="Cut"  fill="#2f6b4b" stackId="a" />
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>
        )}
      </div>
    </PageWrapper>
  )
}
