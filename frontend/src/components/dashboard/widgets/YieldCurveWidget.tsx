import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { useMemo } from 'react'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { TOOLTIP_STYLE } from '../../ChartTooltip'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  text:    'var(--theme-text, #d7e3fc)',
  muted:   'var(--theme-secondary, #8099b0)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     'var(--theme-positive, #22c55e)',
  neg:     'var(--theme-negative, #ef4444)',
  blue:    '#60a5fa',
  violet:  '#a78bfa',
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface) 25%, rgba(255,255,255,0.05) 50%, var(--theme-surface) 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 2,
}

const TENOR_ORDER = ['1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y']

interface Snapshot { [tenor: string]: number }
interface CurveHistResponse {
  current:   Snapshot
  snapshots: { '1M': Snapshot; '3M': Snapshot; '1Y': Snapshot }
  as_of:     string
}

const COMPARISONS: { key: keyof CurveHistResponse['snapshots']; label: string; color: string; dash: string }[] = [
  { key: '1M', label: '1M ago', color: T.blue,   dash: '4 2' },
  { key: '1Y', label: '1Y ago', color: T.violet, dash: '2 3' },
]

function spreadColor(bps: number) {
  if (bps < -50) return T.neg
  if (bps < 0)   return '#f97316'
  if (bps < 50)  return T.muted
  return T.pos
}

function shapeLabel(curve: Snapshot): { text: string; color: string } {
  const t2  = curve['2Y']  ?? curve['1Y']
  const t10 = curve['10Y']
  if (!t2 || !t10) return { text: 'Loading', color: T.muted }
  const spread = (t10 - t2) * 100
  if (spread < -30) return { text: 'Inverted', color: T.neg }
  if (spread < 15)  return { text: 'Flat',     color: '#f97316' }
  if (spread > 80)  return { text: 'Steep',    color: T.pos }
  return               { text: 'Normal',    color: T.gold }
}

export default function YieldCurveWidget({ config: _config }: { config: WidgetConfig }) {
  const { data, isLoading, isError } = useQuery<CurveHistResponse>({
    queryKey: ['yield-curve-history'],
    queryFn: () => axios.get('/api/rates/yield-curve-history').then(r => r.data),
    staleTime: 3_600_000,
    retry: 1,
  })

  // Categorical chart data: one row per tenor, columns for current + comparisons
  const curveChartData = useMemo(() => {
    if (!data?.current) return []
    return TENOR_ORDER
      .filter(t => data.current[t] != null)
      .map(t => {
        const pt: Record<string, string | number> = { tenor: t, current: data.current[t] }
        for (const { key } of COMPARISONS) {
          if (data.snapshots[key]?.[t] != null) pt[key] = data.snapshots[key][t]
        }
        return pt
      })
  }, [data])

  const cur = data?.current ?? {}
  const spread2_10  = cur['10Y'] != null && cur['2Y'] != null
    ? Math.round((cur['10Y'] - cur['2Y'])  * 100) : null
  const spread3m_10 = cur['10Y'] != null && cur['3M'] != null
    ? Math.round((cur['10Y'] - cur['3M']) * 100) : null
  const shape = shapeLabel(cur)

  const KEY_TENORS = ['2Y', '5Y', '10Y', '30Y']

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Yield Curve</span>
        {!isLoading && (
          <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: shape.color }}>
            ● {shape.text}
          </span>
        )}
      </div>

      {isLoading && (
        <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1,2,3,4].map(i => <div key={i} style={{ ...shimmer, height: 20 }} />)}
        </div>
      )}

      {isError && (
        <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>Failed to load yield curve</div>
      )}

      {data && (
        <>
          {/* Key rate tiles */}
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${KEY_TENORS.length}, 1fr)`, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
            {KEY_TENORS.map((tenor, i) => {
              const rate    = cur[tenor]
              const prev1y  = data.snapshots['1Y']?.[tenor]
              const chg     = rate != null && prev1y != null ? Math.round((rate - prev1y) * 100) : null
              return (
                <div key={tenor} style={{ padding: '7px 8px', borderRight: i < KEY_TENORS.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                  <div style={{ fontFamily: T.label, fontSize: 7, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }}>{tenor}</div>
                  <div style={{ fontFamily: T.mono, fontSize: 17, fontWeight: 700, color: T.gold, lineHeight: 1 }}>
                    {rate != null ? rate.toFixed(2) : '—'}
                    <span style={{ fontSize: 9, opacity: 0.65 }}>%</span>
                  </div>
                  {chg != null && (
                    <div style={{ fontFamily: T.mono, fontSize: 8, color: chg >= 0 ? T.neg : T.pos, marginTop: 2 }}>
                      {chg >= 0 ? '+' : ''}{chg}bps vs 1Y
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* Curve chart — categorical X-axis, tight Y domain */}
          <div style={{ flex: 1, minHeight: 0, padding: '8px 6px 4px 2px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={curveChartData} margin={{ top: 4, right: 8, left: 0, bottom: 8 }}>
                <CartesianGrid stroke="rgba(100,120,150,0.1)" vertical={false} />
                <XAxis
                  dataKey="tenor"
                  tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }}
                  axisLine={false} tickLine={false}
                  interval={0}
                />
                <YAxis
                  tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }}
                  tickFormatter={v => `${(v as number).toFixed(1)}%`}
                  axisLine={false} tickLine={false} width={34}
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  contentStyle={{ ...TOOLTIP_STYLE }}
                  labelFormatter={(label: string) => label}
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  formatter={(v: any, key: string) => {
                    const labels: Record<string, string> = { current: 'Today', '1M': '1M ago', '1Y': '1Y ago' }
                    return [`${(v as number).toFixed(3)}%`, labels[key] ?? key]
                  }}
                />
                <Area isAnimationActive={false}
                  type="monotoneX" dataKey="current"
                  stroke={T.gold} strokeWidth={2}
                  fill="color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)"
                  dot={{ fill: T.gold, r: 2.5, strokeWidth: 0 }}
                  activeDot={{ r: 4 }}
                  connectNulls
                />
                {COMPARISONS.map(({ key, color, dash }) => (
                  <Line isAnimationActive={false}
                    key={key} type="monotoneX" dataKey={key}
                    stroke={color} strokeWidth={1} strokeDasharray={dash}
                    dot={false} connectNulls
                  />
                ))}
                <ReferenceLine y={0} stroke={T.border} strokeWidth={1} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Legend + spreads footer */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 10px 6px', borderTop: `1px solid ${T.border}`, flexShrink: 0, flexWrap: 'wrap', gap: 4 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontFamily: T.mono, fontSize: 8, color: T.gold }}>─── Today</span>
              {COMPARISONS.map(({ key, label, color }) => (
                <span key={key} style={{ fontFamily: T.mono, fontSize: 8, color }}>- - {label}</span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ fontFamily: T.mono, fontSize: 9 }}>
                <span style={{ color: T.muted }}>2/10 </span>
                <span style={{ fontWeight: 700, color: spread2_10 != null ? spreadColor(spread2_10) : T.muted }}>
                  {spread2_10 != null ? `${spread2_10 >= 0 ? '+' : ''}${spread2_10}bps` : '—'}
                </span>
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 9 }}>
                <span style={{ color: T.muted }}>3M/10 </span>
                <span style={{ fontWeight: 700, color: spread3m_10 != null ? spreadColor(spread3m_10) : T.muted }}>
                  {spread3m_10 != null ? `${spread3m_10 >= 0 ? '+' : ''}${spread3m_10}bps` : '—'}
                </span>
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
