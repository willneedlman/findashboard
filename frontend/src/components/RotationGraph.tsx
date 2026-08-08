import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, ReferenceArea, LabelList, Line, ComposedChart,
} from 'recharts'
import EmptyState from './EmptyState'
import { T } from '../lib/theme'
import { MONO, SANS, mix } from '../pages/cockpitKit'
import { TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM } from '../pages/valuationShared'

// Relative Rotation Graph.
//
// Two numbers per sector against the benchmark: how strong it is (x) and
// whether that strength is building or fading (y). Both centre on 100, so the
// plane splits into four quadrants with names.
//
// The tail is the point of the chart, not decoration. Rotation runs clockwise,
// so a sector sitting in "weakening" that arrived from "leading" is a position
// being unwound, while the same dot arriving from "lagging" is one being built.

const QUADRANTS: Record<string, { label: string; color: string; blurb: string }> = {
  leading:   { label: 'Leading',   color: T.pos,  blurb: 'strong and still strengthening' },
  weakening: { label: 'Weakening', color: T.warn, blurb: 'strong but losing steam' },
  lagging:   { label: 'Lagging',   color: T.neg,  blurb: 'weak and still weakening' },
  improving: { label: 'Improving', color: T.blue, blurb: 'weak but turning up' },
}

interface TailPoint { date: string; x: number; y: number }
interface Series {
  ticker: string; x: number; y: number
  quadrant: keyof typeof QUADRANTS
  from_quadrant: keyof typeof QUADRANTS
  tail: TailPoint[]
}
interface Rrg {
  available: boolean
  reason?: string
  benchmark?: string
  as_of?: string
  tail_weeks?: number
  window_weeks?: number
  series?: Series[]
  counts?: Record<string, number>
}

/** Pad a bound so the crosshair at 100 is never flush against the frame. */
function domainFor(values: number[]): [number, number] {
  if (!values.length) return [98, 102]
  const lo = Math.min(...values, 100)
  const hi = Math.max(...values, 100)
  const pad = Math.max((hi - lo) * 0.18, 0.35)
  return [+(lo - pad).toFixed(2), +(hi + pad).toFixed(2)]
}

export default function RotationGraph({ names }: { names?: Record<string, string> }) {
  const [tail, setTail] = useState(8)
  const q = useQuery<Rrg>({
    queryKey: ['rrg', tail],
    queryFn: () => axios.get('/api/market/rrg', { params: { tail } }).then(r => r.data),
    staleTime: 60 * 60_000,
    retry: 0,
  })
  const d = q.data
  const series = d?.series ?? []

  if (q.isLoading) {
    return <div style={{ padding: 26 }}><EmptyState variant="loading" size="compact" title="Building the rotation graph" /></div>
  }
  if (!d?.available) {
    return (
      <div style={{ padding: '16px 14px', fontFamily: SANS, fontSize: 11, color: T.muted }}>
        {d?.reason ?? 'The rotation graph is unavailable right now.'}
      </div>
    )
  }

  const xs = series.flatMap(s => s.tail.map(p => p.x))
  const ys = series.flatMap(s => s.tail.map(p => p.y))
  const xDomain = domainFor(xs)
  const yDomain = domainFor(ys)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>Tail</span>
        <div style={{ display: 'flex' }}>
          {[4, 8, 12, 16].map(w => {
            const on = w === tail
            return (
              <button key={w} onClick={() => setTail(w)}
                style={{
                  fontFamily: MONO, fontSize: 10.5, fontWeight: 700, padding: '0 10px', minHeight: 28,
                  cursor: 'pointer', marginLeft: -1,
                  background: on ? mix(T.gold, 14) : 'transparent',
                  border: `1px solid ${on ? T.gold : T.border}`, color: on ? T.gold : T.muted,
                }}>{w}w</button>
            )
          })}
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {Object.entries(QUADRANTS).map(([key, meta]) => (
            <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontSize: 10, color: T.muted }}>
              <span style={{ width: 8, height: 8, background: meta.color, flex: 'none' }} />
              {meta.label} <strong style={{ color: T.text }}>{d.counts?.[key] ?? 0}</strong>
            </span>
          ))}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={420}>
        <ComposedChart margin={{ top: 12, right: 26, bottom: 24, left: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={T.borderFaint} />
          {/* Quadrant washes, faint enough to read the tails over. */}
          <ReferenceArea x1={100} x2={xDomain[1]} y1={100} y2={yDomain[1]} fill={mix(T.pos, 6)} stroke="none" />
          <ReferenceArea x1={100} x2={xDomain[1]} y1={yDomain[0]} y2={100} fill={mix(T.warn, 6)} stroke="none" />
          <ReferenceArea x1={xDomain[0]} x2={100} y1={yDomain[0]} y2={100} fill={mix(T.neg, 6)} stroke="none" />
          <ReferenceArea x1={xDomain[0]} x2={100} y1={100} y2={yDomain[1]} fill={mix(T.blue, 6)} stroke="none" />
          <ReferenceLine x={100} stroke={T.muted} />
          <ReferenceLine y={100} stroke={T.muted} />
          <XAxis type="number" dataKey="x" domain={xDomain} stroke={T.muted}
            tick={{ fill: T.muted, fontSize: 9 }} tickFormatter={(v: number) => v.toFixed(1)}
            label={{ value: 'Relative strength  ·  100 = benchmark', position: 'insideBottom', offset: -14, fill: T.muted, fontSize: 10 }} />
          <YAxis type="number" dataKey="y" domain={yDomain} stroke={T.muted} width={52}
            tick={{ fill: T.muted, fontSize: 9 }} tickFormatter={(v: number) => v.toFixed(1)}
            label={{ value: 'Momentum', angle: -90, position: 'center', dx: -22, fill: T.muted, fontSize: 10 }} />
          <ZAxis range={[70, 70]} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM}
            cursor={{ strokeDasharray: '3 3' }}
            formatter={(v: number, key: string) => [v.toFixed(2), key === 'x' ? 'Strength' : 'Momentum']} />

          {series.map(s => (
            <Line key={`tail-${s.ticker}`} data={s.tail} dataKey="y" type="linear"
              stroke={QUADRANTS[s.quadrant].color} strokeWidth={1.2} strokeOpacity={0.5}
              dot={{ r: 1.6, fill: QUADRANTS[s.quadrant].color, strokeWidth: 0 }} isAnimationActive={false} legendType="none" />
          ))}
          {series.map(s => (
            <Scatter key={s.ticker} data={[{ ...s, label: names?.[s.ticker] ?? s.ticker }]}
              fill={QUADRANTS[s.quadrant].color} isAnimationActive={false}>
              <LabelList dataKey="label" position="right" offset={9}
                style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, fill: T.text }} />
            </Scatter>
          ))}
        </ComposedChart>
      </ResponsiveContainer>

      <div style={{ overflowX: 'auto', marginTop: 8 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 420 }}>
          <thead>
            <tr>
              {['Sector', 'Quadrant', 'Came from', 'Strength', 'Momentum'].map((h, i) => (
                <th key={h} style={{
                  fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
                  color: T.muted, padding: '0 10px 7px', textAlign: i < 3 ? 'left' : 'right', whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.map(s => (
              <tr key={s.ticker} style={{ borderTop: `1px solid ${T.borderFaint}` }}>
                <td style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: T.text, padding: '5px 10px' }}>
                  {s.ticker}<span style={{ fontFamily: SANS, fontSize: 10, color: T.muted, marginLeft: 8 }}>{names?.[s.ticker] ?? ''}</span>
                </td>
                <td style={{ padding: '5px 10px' }}>
                  <span style={{ fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: QUADRANTS[s.quadrant].color }}>
                    {QUADRANTS[s.quadrant].label}
                  </span>
                </td>
                <td style={{ fontFamily: SANS, fontSize: 10, color: T.muted, padding: '5px 10px' }}>
                  {s.from_quadrant === s.quadrant ? 'held' : QUADRANTS[s.from_quadrant].label}
                </td>
                <td style={{ fontFamily: MONO, fontSize: 11, color: s.x >= 100 ? T.pos : T.neg, textAlign: 'right', padding: '5px 10px', fontVariantNumeric: 'tabular-nums' }}>{s.x.toFixed(2)}</td>
                <td style={{ fontFamily: MONO, fontSize: 11, color: s.y >= 100 ? T.pos : T.neg, textAlign: 'right', padding: '5px 10px', fontVariantNumeric: 'tabular-nums' }}>{s.y.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.borderFaint}`, fontFamily: SANS, fontSize: 10.5, lineHeight: 1.55, color: T.muted }}>
        Weekly, against {d.benchmark}, normalised over {d.window_weeks} weeks. Rotation runs clockwise, so read the
        tail as well as the dot: the same position means different things arriving from Leading than from Lagging.
        This is the standard public construction of the graph, not a reproduction of the commercial one.
      </div>
    </div>
  )
}
