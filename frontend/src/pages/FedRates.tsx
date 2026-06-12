import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { fetchYieldCurve, fetchFedProjections } from '../hooks/useApi'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR, BAR_CURSOR } from '../components/ChartTooltip'

const FED_WEIGHTS = [1.0, 0.9, 0.7, 0.5, 0.3, 0.1]
const YC_WEIGHTS  = [1.0, 0.98, 0.85, 0.40, 0.1, -0.19, -0.325]
const TICK = { fontSize: 9, fill: 'var(--theme-secondary, #5e768f)', fontFamily: 'var(--theme-mono)' }

const T = {
  bg:      'var(--theme-bg, #060e1c)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.06))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     '#22c55e',
  neg:     '#ef4444',
}

// ── Inline stat row — replaces isolated metric tiles ──────────────────────
function StatRow({ items }: { items: { label: string; value: string; sub?: string; delta?: string; positive?: boolean }[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      {items.map((item, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            padding: '14px 18px',
            borderRight: i < items.length - 1 ? `1px solid ${T.border}` : 'none',
          }}
        >
          <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 6 }}>
            {item.label}
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 22, fontWeight: 700, color: T.text, lineHeight: 1.1 }}>
            {item.value}
          </div>
          {item.sub && <div style={{ fontFamily: T.label, fontSize: 10, color: T.muted, marginTop: 4 }}>{item.sub}</div>}
          {item.delta && (
            <div style={{ fontFamily: T.mono, fontSize: 10, marginTop: 4, color: item.positive ? T.pos : T.neg }}>
              {item.delta}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Panel wrapper ─────────────────────────────────────────────────────────
function Panel({ title, children, action }: { title?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="ft-panel">
      {title && (
        <div className="ft-panel-header">
          <span>{title}</span>
          {action}
        </div>
      )}
      {children}
    </div>
  )
}

// ── Yield curve tenor table ───────────────────────────────────────────────
function YieldTable({ curve, adjusted, twist }: { curve: Record<string, number>; adjusted: { tenor: string; current: number; adjusted: number }[]; twist: number }) {
  const TENORS = ['FF', '1Y', '2Y', '5Y', '10Y', '20Y', '30Y']
  const LABELS: Record<string, string> = { FF: 'Fed Funds' }
  return (
    <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}` }}>
      {TENORS.map((t, i) => {
        const pt = adjusted.find(a => a.tenor === t)
        const val = pt?.adjusted ?? curve[t] ?? null
        const delta = pt && twist !== 0 ? (pt.adjusted - pt.current) * 100 : null
        return (
          <div
            key={t}
            style={{
              flex: 1,
              padding: '12px 14px',
              borderRight: i < TENORS.length - 1 ? `1px solid ${T.border}` : 'none',
            }}
          >
            <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, marginBottom: 5 }}>
              {LABELS[t] ?? t}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: T.text, lineHeight: 1 }}>
              {val != null ? `${val.toFixed(2)}%` : '—'}
            </div>
            {delta != null && (
              <div style={{ fontFamily: T.mono, fontSize: 9, marginTop: 3, color: delta < 0 ? T.pos : T.neg }}>
                {delta > 0 ? '+' : ''}{delta.toFixed(0)} bps
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function FedRatesContent() {
  const [twist, setTwist] = useState(0)

  const { data: curveData } = useQuery({ queryKey: ['yield-curve'],    queryFn: fetchYieldCurve })
  const { data: fedData }   = useQuery({ queryKey: ['fed-projections'], queryFn: fetchFedProjections })

  const adjustedMeetings = fedData?.meetings.map((m: any, i: number) => ({
    ...m,
    base_rate:     m.rate,
    adjusted_rate: +(m.rate + (twist / 100) * (FED_WEIGHTS[i] ?? 0.05)).toFixed(2),
  })) ?? []

  const adjustedCurve = curveData ? ['FF', '1Y', '2Y', '5Y', '10Y', '20Y', '30Y'].map((t, i) => ({
    tenor:    t,
    current:  curveData.curve[t] ?? 0,
    adjusted: +Math.max(0.1, (curveData.curve[t] ?? 0) + (twist / 100) * YC_WEIGHTS[i]).toFixed(3),
  })) : []

  const nextRate  = adjustedMeetings[0]?.adjusted_rate
  const yearEnd   = adjustedMeetings[4]?.adjusted_rate
  const totalMove = adjustedMeetings.length >= 2
    ? ((adjustedMeetings.at(-1)?.adjusted_rate ?? 0) - (adjustedMeetings[0]?.adjusted_rate ?? 0)) * 100
    : 0

  const summaryItems = [
    { label: 'Next Meeting Implied',   value: nextRate != null ? `${nextRate.toFixed(2)}%` : '—',
      delta: twist !== 0 ? `${(twist * FED_WEIGHTS[0]).toFixed(1)} bps adj` : undefined, positive: twist < 0 },
    { label: adjustedMeetings[4]?.date ? `${adjustedMeetings[4].date} Implied` : 'Forward Implied',
      value: yearEnd != null ? `${yearEnd.toFixed(2)}%` : '—' },
    { label: 'Total Projected Move',    value: `${totalMove > 0 ? '+' : ''}${totalMove.toFixed(0)} bps`,
      sub: 'Through last FOMC meeting' },
  ]

  const fomc = fedData?.meetings[0]

  const gridTwo: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))', gap: 12 }

  return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Rate sensitivity slider */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 16, marginBottom: 2, paddingBottom: 14, borderBottom: `1px solid var(--theme-border-faint, rgba(255,255,255,0.05))` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: T.surface, border: `1px solid ${T.border}`, padding: '8px 14px', flexShrink: 0 }}>
            <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>
              Rate Scenario
            </span>
            <input
              type="range" min={-200} max={200} step={5} value={twist}
              onChange={e => setTwist(+e.target.value)}
              style={{ width: 120, accentColor: T.gold }}
            />
            <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.gold, width: 64, textAlign: 'right', whiteSpace: 'nowrap' }}>
              {twist > 0 ? '+' : ''}{twist} bps
            </span>
            {twist !== 0 && (
              <button
                onClick={() => setTwist(0)}
                style={{ fontFamily: T.label, fontSize: 9, color: T.muted, background: 'none', border: `1px solid ${T.border}`, padding: '2px 7px', cursor: 'pointer', letterSpacing: '0.1em', textTransform: 'uppercase' }}
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {/* ── Summary + next-meeting probabilities, side by side ─────────── */}
        <div style={gridTwo}>
          {adjustedMeetings.length > 0 && (
            <Panel title="Rate Outlook">
              <StatRow items={summaryItems} />
            </Panel>
          )}
          {fomc && (
            <Panel title="Next FOMC Meeting — Probability Breakdown">
              <StatRow items={[
                { label: 'Hike',  value: `${fomc.prob_hike}%` },
                { label: 'Hold',  value: `${fomc.prob_hold}%` },
                { label: 'Cut',   value: `${fomc.prob_cut}%`  },
              ]} />
            </Panel>
          )}
        </div>

        {/* ── Two primary charts, side by side ───────────────────────────── */}
        <div style={gridTwo}>
          {adjustedMeetings.length > 0 && (
            <Panel title="Market-Implied Fed Funds Rate Path">
              <div style={{ height: 260, padding: '8px 8px 0' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={adjustedMeetings} margin={{ left: 0, right: 28, top: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
                    <XAxis dataKey="date" tick={TICK} axisLine={false} tickLine={false} />
                    <YAxis tick={TICK} tickFormatter={v => `${v}%`} domain={['auto','auto']} axisLine={false} tickLine={false} width={44} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                    <Legend wrapperStyle={{ fontFamily: T.label, fontSize: 9, paddingBottom: 6 }} />
                    <Line type="monotone" dataKey="base_rate"     stroke="var(--theme-text-faint, rgba(255,255,255,0.18))" strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Base Path" />
                    <Line type="monotone" dataKey="adjusted_rate" stroke="var(--theme-tertiary, #60a5fa)" strokeWidth={2} dot={{ fill: 'var(--theme-primary, #c9a84c)', r: 4 }} name="Adjusted Path" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          )}

          {fedData && (
            <Panel title="Meeting Probability Distribution — Hike / Hold / Cut">
              <div style={{ height: 260, padding: '8px 8px 0' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={fedData.meetings} margin={{ left: 0, right: 28, top: 8, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
                    <XAxis dataKey="date" tick={TICK} axisLine={false} tickLine={false} />
                    <YAxis tick={TICK} tickFormatter={v => `${v}%`} axisLine={false} tickLine={false} width={44} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} cursor={BAR_CURSOR} />
                    <Legend wrapperStyle={{ fontFamily: T.label, fontSize: 9, paddingBottom: 6 }} />
                    <Bar dataKey="prob_hike" name="Hike" fill="#c0394d" stackId="a" />
                    <Bar dataKey="prob_hold" name="Hold" fill="var(--theme-chart-neutral, #4a7fa5)" stackId="a" />
                    <Bar dataKey="prob_cut"  name="Cut"  fill="#2e9a62" stackId="a" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Panel>
          )}
        </div>

        {/* ── Treasury yield curve — full width ──────────────────────────── */}
        {adjustedCurve.length > 0 && (
          <Panel title="US Treasury Yield Curve">
            <YieldTable curve={curveData?.curve ?? {}} adjusted={adjustedCurve} twist={twist} />
            <div style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={adjustedCurve} margin={{ left: 0, right: 24, top: 12, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
                  <XAxis dataKey="tenor" tick={TICK} axisLine={false} tickLine={false} />
                  <YAxis tick={TICK} tickFormatter={v => `${v}%`} domain={['auto','auto']} axisLine={false} tickLine={false} width={44} />
                  <Tooltip formatter={(v: number) => [`${v.toFixed(3)}%`, '']} contentStyle={TOOLTIP_STYLE} cursor={CROSSHAIR_CURSOR} />
                  <Legend wrapperStyle={{ fontFamily: T.label, fontSize: 9, paddingBottom: 6 }} />
                  <Line type="monotone" dataKey="current"  stroke="var(--theme-text-faint, rgba(255,255,255,0.2))" strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Current" />
                  <Line type="monotone" dataKey="adjusted" stroke="var(--theme-tertiary, #60a5fa)" strokeWidth={2} dot={{ fill: 'var(--theme-primary, #c9a84c)', r: 3 }} name="Adjusted" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </Panel>
        )}

      </div>
  )
}

export default function FedRates() {
  return <PageWrapper title="Fed Rates"><FedRatesContent /></PageWrapper>
}
