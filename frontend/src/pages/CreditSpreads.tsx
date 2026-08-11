import { T } from '../lib/theme'
import { useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import { KpiCell } from '../components/mmCockpit'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR } from '../components/ChartTooltip'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, chartClip } from '../lib/reportCaptureRegistry'


const SERIES_COLORS: Record<string, string> = {
  ig_oas:  '#60a5fa',
  hy_oas:  'var(--theme-negative, #ef4444)',
  ig_3_5:  '#38bdf8',
  hy_b:    '#f97316',
  hy_ccc:  '#a78bfa',
  vix:     'var(--theme-primary, #c9a84c)',
}

const LOOKBACKS = [
  { label: '3M',  days: 90  },
  { label: '6M',  days: 180 },
  { label: '1Y',  days: 365 },
  { label: '2Y',  days: 730 },
  { label: '5Y',  days: 1825},
]

interface SeriesData {
  label:       string
  description: string
  benchmark:   string
  current:     number | null
  change_1y:   number | null
  history:     { date: string; value: number }[]
}

interface CreditResponse {
  series: Record<string, SeriesData>
  as_of:  string
}

type ViewKey = 'ig_oas' | 'hy_oas' | 'ig_3_5' | 'hy_b' | 'hy_ccc' | 'vix'
const OVERLAY_KEYS: ViewKey[] = ['ig_oas', 'hy_oas', 'ig_3_5', 'hy_b', 'hy_ccc']

export function CreditSpreadsContent() {
  const [lookback, setLookback] = useState(365)
  const [showVix, setShowVix] = useState(true)
  const [activeKeys, setActiveKeys] = useState<Set<ViewKey>>(new Set(['ig_oas', 'hy_oas']))

  const { data, isLoading, isError } = useQuery<CreditResponse>({
    queryKey: ['credit-spreads', lookback],
    queryFn: () => axios.get(`/api/rates/credit-spreads?lookback=${lookback}`).then(r => r.data),
    staleTime: 3_600_000,
    retry: 1,
  })

  const toggleKey = (k: ViewKey) => setActiveKeys(prev => {
    const n = new Set(prev)
    n.has(k) ? n.delete(k) : n.add(k)
    return n
  })

  // Merge all history into one timeline
  const chartData = (() => {
    if (!data) return []
    const dateMap: Record<string, Record<string, number>> = {}

    for (const [key, s] of Object.entries(data.series)) {
      for (const { date, value } of s.history) {
        if (!dateMap[date]) dateMap[date] = {}
        dateMap[date][key] = value
      }
    }
    return Object.entries(dateMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, vals]) => ({ date, ...vals }))
  })()

  // Dual Y-axis: spreads (left) + VIX (right)
  const tabBtn = (active: boolean): React.CSSProperties => ({
    fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
    textTransform: 'uppercase', padding: '4px 12px', cursor: 'pointer',
    background: active ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)' : 'var(--theme-hover, rgba(255,255,255,0.04))',
    border: `1px solid ${active ? T.gold : T.border}`,
    color: active ? T.gold : T.muted,
  })

  const TAB = 'Credit Spreads'
  useReportCapture(() => {
    if (!data) return null
    const pieces: ClipDraft[] = [
      kpiClip(TAB, 'Credit Spread Snapshot', [
        ...Object.entries(data.series).filter(([k]) => k !== 'vix').map(([, s]) => ({
          label: s.label,
          value: s.current != null ? `${s.current.toFixed(0)} bps` : '—',
          sub: s.change_1y != null
            ? `${s.change_1y >= 0 ? '▲' : '▼'} ${Math.abs(s.change_1y).toFixed(0)} bps vs 1Y`
            : s.benchmark,
        })),
        ...(data.series.vix ? [{
          label: 'VIX',
          value: data.series.vix.current != null ? data.series.vix.current.toFixed(2) : '—',
          sub: 'CBOE 30-day implied vol',
        }] : []),
      ]),
    ]
    if (chartData.length) {
      const keys = [...activeKeys]
      pieces.push(chartClip(TAB, 'Spread History', 'line', 'date',
        chartData.map(row => {
          const out: Record<string, string | number | null> = { date: row.date }
          for (const k of keys) out[k] = (row as any)[k] ?? null
          if (showVix) out.vix = (row as any).vix ?? null
          return out
        }),
        [
          ...keys.map(k => ({ key: k, label: data.series[k]?.label ?? k })),
          ...(showVix ? [{ key: 'vix', label: 'VIX' }] : []),
        ],
      ))
    }
    return pieces
  }, { disabled: !data, sourceTab: TAB })

  return (
      <div id="credit-spreads-content" style={{ width: '100%' }}>
        <PageHeader
          title="Credit Spread Monitor"
        />

        {/* Stat row — single panel, stats separated by dividers */}
        {data && (
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap' }}>
              {Object.entries(data.series).filter(([k]) => k !== 'vix').map(([key, s]) => {
                const change = s.change_1y ?? null
                const sub = change != null
                  ? `${s.benchmark ?? ''} · ${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(0)} bps vs 1Y ago`
                  : (s.benchmark ?? '')
                return <KpiCell key={key} grow label={s.label} value={s.current != null ? `${s.current.toFixed(0)} bps` : '—'}
                  sub={sub} subColor={change != null ? (change >= 0 ? T.neg : T.pos) : undefined} />
              })}
              {data.series.vix && (
                <KpiCell grow label="VIX" value={data.series.vix.current != null ? data.series.vix.current.toFixed(2) : '—'}
                  color="var(--theme-primary, #c9a84c)" sub="CBOE 30-day implied vol (S&P 500)" />
              )}
            </div>
          </div>
        )}

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 1 }}>
            {LOOKBACKS.map(l => (
              <button key={l.label} onClick={() => setLookback(l.days)} style={tabBtn(lookback === l.days)}>{l.label}</button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 6, marginLeft: 12, flexWrap: 'wrap' }}>
            {OVERLAY_KEYS.map(k => {
              const s = data?.series[k]
              if (!s) return null
              const on = activeKeys.has(k)
              return (
                <button key={k} onClick={() => toggleKey(k)} style={{
                  fontFamily: T.mono, fontSize: 8, padding: '3px 8px', cursor: 'pointer',
                  background: on ? `${SERIES_COLORS[k]}20` : 'transparent',
                  border: `1px solid ${on ? SERIES_COLORS[k] : T.border}`,
                  color: on ? SERIES_COLORS[k] : T.muted,
                }}>
                  {s.label}
                </button>
              )
            })}
            <button onClick={() => setShowVix(v => !v)} style={{
              fontFamily: T.mono, fontSize: 8, padding: '3px 8px', cursor: 'pointer',
              background: showVix ? `${SERIES_COLORS.vix}20` : 'transparent',
              border: `1px solid ${showVix ? SERIES_COLORS.vix : T.border}`,
              color: showVix ? SERIES_COLORS.vix : T.muted,
            }}>
              VIX overlay
            </button>
          </div>
        </div>

        {/* Chart */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }}>
          <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.18)', borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>Spread History</span>
            {data && <span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>BofA ICE via FRED · {data.as_of}</span>}
          </div>
          <div style={{ padding: 16 }}>
          {isLoading && <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.muted, fontFamily: T.mono, fontSize: 11 }}>Loading spread history…</div>}
          {isError  && <div style={{ height: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.neg,  fontFamily: T.mono, fontSize: 11 }}>Failed. Check the FRED API key</div>}
          {data && (
            <ResponsiveContainer width="100%" height={320}>
              <LineChart data={chartData} margin={{ left: 0, right: 40, top: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--theme-hover, rgba(255,255,255,0.04))" />
                <XAxis dataKey="date" tick={{ fontFamily: T.mono, fontSize: 8, fill: T.muted }} tickLine={false} axisLine={false} tickFormatter={v => v.slice(0, 7)} interval="preserveStartEnd" />
                <YAxis yAxisId="spread" tickFormatter={v => `${v}`} tick={{ fontFamily: T.mono, fontSize: 8, fill: T.muted }} tickLine={false} axisLine={false} label={{ value: 'OAS (bps)', angle: -90, position: 'insideLeft', fill: T.muted, fontSize: 8, fontFamily: T.mono }} />
                {showVix && <YAxis yAxisId="vix" orientation="right" tickFormatter={v => `${v}`} tick={{ fontFamily: T.mono, fontSize: 8, fill: T.gold }} tickLine={false} axisLine={false} />}
                <Tooltip cursor={CROSSHAIR_CURSOR} contentStyle={{ ...TOOLTIP_STYLE }} labelStyle={{ color: T.gold, fontFamily: T.label, fontWeight: 700 }} formatter={(v: number, name: string) => [`${v.toFixed(2)}${name === 'vix' ? '' : ' bps'}`, name.toUpperCase()]} />
                {OVERLAY_KEYS.filter(k => activeKeys.has(k)).map(k => (
                  <Line key={k} yAxisId="spread" type="monotone" dataKey={k} stroke={SERIES_COLORS[k]} strokeWidth={1.5} dot={false} name={k} />
                ))}
                {showVix && <Line yAxisId="vix" type="monotone" dataKey="vix" stroke={SERIES_COLORS.vix} strokeWidth={1} dot={false} strokeDasharray="4 3" name="vix" />}
              </LineChart>
            </ResponsiveContainer>
          )}
          </div>
        </div>

        {/* Interpretation guide — single panel with left-accent rows */}
        <div style={{ background: T.surface, border: `1px solid ${T.border}`, boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }}>
          <div style={{ padding: '8px 14px', background: 'rgba(0,0,0,0.18)', borderBottom: `1px solid ${T.border}`, fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted }}>
            Spread Reference Guide
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
            {[
              { label: 'Investment Grade', color: '#60a5fa', text: 'AAA–BBB corps vs. matched-maturity Treasuries. <100 bps: benign. 100–200: caution. >200: stress. Rising = tightening conditions for IG issuers.' },
              { label: 'High Yield', color: 'var(--theme-negative, #ef4444)', text: 'BB–CCC corps vs. matched-maturity Treasuries. <350 bps: risk-on. 350–600: stress building. >600: distress. Leads equity drawdowns by days to weeks.' },
              { label: 'High Yield CCC', color: '#a78bfa', text: 'Lowest-rated junk vs. Treasuries. Most recession-sensitive. Spikes signal weakest borrowers losing market access, a leading indicator of credit seizure.' },
              { label: 'VIX vs Spreads', color: 'var(--theme-primary, #c9a84c)', text: 'VIX = equity implied vol. Spreads = credit risk premium. Divergence matters: spreads widening while VIX is calm = credit market leading equities lower.' },
            ].map((item, i) => (
              <div key={item.label} style={{ padding: '12px 16px', borderLeft: `2px solid ${item.color}`, borderTop: i >= 2 ? `1px solid ${T.border}` : 'none', borderRight: i % 2 === 0 ? `1px solid ${T.border}` : 'none' }}>
                <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: item.color, marginBottom: 5 }}>{item.label}</div>
                <p style={{ fontFamily: T.label, fontSize: 11, color: T.muted, lineHeight: 1.55, margin: 0 }}>{item.text}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
  )
}

export default function CreditSpreads() {
  return <PageWrapper><CreditSpreadsContent /></PageWrapper>
}
