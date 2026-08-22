import { useMemo, useState } from 'react'
import { useQueries } from '@tanstack/react-query'
import axios from 'axios'
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceArea,
} from 'recharts'
import { T } from '../lib/theme'
import { MONO, SANS, mix, seg } from '../pages/cockpitKit'
import { TOOLTIP_STYLE } from './ChartTooltip'

// Where consensus has been, rather than where it is.
//
// No free source publishes this as a series, so it accrues one point per day
// from first view. The opening quarter is reconstructed from the published
// 7/30/60/90-day lookbacks, which carry EPS only, and the chart says so instead
// of drawing a revenue line that would be flat by construction.

interface Point { d: string; eps?: number; rev?: number; n?: number; reconstructed?: boolean }
interface Resp { ticker: string; fiscal_years: string[]; series: Record<string, Point[]>; note: string }

type Metric = 'eps' | 'rev'
const METRICS: { key: Metric; label: string }[] = [
  { key: 'eps', label: 'EPS' },
  { key: 'rev', label: 'Revenue' },
]
// Fiscal year is the dash, so the company keeps the hue it has on the other chart.
const FY_DASH: (string | undefined)[] = [undefined, '7 4', '2 3', '11 4 2 4']

function money(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  return `$${v.toFixed(2)}`
}

export default function RevisionTrend({ tickers, colorFor, multi }: {
  tickers: string[]
  colorFor: (t: string) => string
  multi: boolean
}) {
  const [metric, setMetric] = useState<Metric>('eps')

  const results = useQueries({
    queries: tickers.map(tk => ({
      queryKey: ['estimate-trend', tk],
      queryFn: () => axios.get(`/api/snapshots/series?kind=est&ticker=${encodeURIComponent(tk)}`)
        .then(r => r.data as Resp),
      staleTime: 3600 * 1000,
      retry: 1,
    })),
  })
  const loading = results.some(r => r.isLoading)
  // "No consensus is published" and "the request failed" are different facts and
  // must not share a message.
  const failed = !loading && results.length > 0 && results.every(r => r.error)
  const sig = results.map((r, i) => `${tickers[i]}:${r.data ? 'y' : '-'}`).join('|')
  const ok = useMemo(
    () => results.map((r, i) => ({ tk: tickers[i], data: r.data })).filter(l => l.data) as { tk: string; data: Resp }[],
    [sig], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const lines = useMemo(() => ok.flatMap(l => (l.data.fiscal_years ?? []).map((fy, i) => ({
    id: `${l.tk}__${fy}`,
    label: multi ? `${l.tk} FY${fy}` : `FY${fy}`,
    color: colorFor(l.tk),
    dash: FY_DASH[i % FY_DASH.length],
  }))), [ok, multi, colorFor])

  const rows = useMemo(() => {
    const days = new Set<string>()
    ok.forEach(l => Object.values(l.data.series ?? {}).forEach(pts => pts.forEach(p => days.add(p.d))))
    return [...days].sort().map(d => {
      const row: Record<string, string | number | null> = { d }
      for (const l of ok) {
        for (const fy of l.data.fiscal_years ?? []) {
          const p = (l.data.series[fy] ?? []).find(x => x.d === d)
          row[`${l.tk}__${fy}`] = p ? (p[metric] ?? null) : null
        }
      }
      return row
    })
  }, [ok, metric])

  // Everything up to the last reconstructed day is the seeded span.
  const seededUntil = useMemo(() => {
    let last: string | null = null
    ok.forEach(l => Object.values(l.data.series ?? {}).forEach(pts => pts.forEach(p => {
      if (p.reconstructed && (!last || p.d > last)) last = p.d
    })))
    return last
  }, [ok])

  const fmt = (v: number | null | undefined) =>
    (v == null || !Number.isFinite(v) ? '—' : metric === 'eps' ? `$${v.toFixed(2)}` : money(v))
  const day = (d: string) => d.slice(5).replace('-', '/')

  const empty = !loading && rows.length === 0
  const revGap = metric === 'rev' && seededUntil !== null

  return (
    <div style={{ border: `1px solid ${T.border}`, background: T.bg, flex: '1 1 auto',
      display: 'flex', flexDirection: 'column', minHeight: 420 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: '8px 12px', borderBottom: `1px solid ${T.borderFaint}` }}>
        <div style={{ display: 'flex', width: 150 }}>
          {METRICS.map(m => (
            <div key={m.key} onClick={() => setMetric(m.key)} style={seg(metric === m.key)}>{m.label}</div>
          ))}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, color: T.muted }}>
          {rows.length ? `${day(rows[0].d as string)} – ${day(rows[rows.length - 1].d as string)} · ${rows.length} points` : '—'}
        </div>
        <div style={{ marginLeft: 'auto', fontFamily: SANS, fontSize: 9.5, color: mix(T.muted, 75) }}>
          One point per day, from first view
        </div>
      </div>

      <div style={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
        <div style={{ position: 'absolute', top: 12, right: 12, bottom: 6, left: 12 }}>
          {loading || empty || lines.length === 0 ? (
            <div style={{ height: '100%', display: 'grid', placeItems: 'center', fontFamily: SANS,
              fontSize: 12, color: T.muted, textAlign: 'center', lineHeight: 1.6 }}>
              {loading ? 'Reading the consensus series.'
                : failed ? 'Could not read the consensus series.'
                : 'No consensus is published for these names.'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={rows} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
                <CartesianGrid stroke={T.borderFaint} vertical={false} />
                <XAxis dataKey="d" tickFormatter={day} tick={{ fill: T.muted, fontSize: 10, fontFamily: MONO }} />
                <YAxis width={metric === 'eps' ? 54 : 62} domain={['auto', 'auto']}
                  tick={{ fill: T.muted, fontSize: 10, fontFamily: MONO }}
                  tickFormatter={(v: number) => (metric === 'eps' ? `$${v.toFixed(2)}` : money(v))} />
                {seededUntil && metric === 'eps' && (
                  <ReferenceArea x1={rows[0].d as string} x2={seededUntil} fill={T.gold} fillOpacity={0.05}
                    stroke={mix(T.gold, 22)}
                    label={{ value: 'reconstructed', position: 'insideTop', fontSize: 9,
                      fill: mix(T.gold, 70), fontFamily: SANS }} />
                )}
                <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(d: string) => d}
                  formatter={(v: number, n: string) => [fmt(v), n]} />
                <Legend content={() => (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px 16px',
                    justifyContent: 'center', paddingTop: 6 }}>
                    {lines.map(l => (
                      <span key={l.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 7,
                        fontFamily: SANS, fontSize: 11, color: T.text }}>
                        <svg width={28} height={8} style={{ flexShrink: 0 }} aria-hidden>
                          <line x1={0} y1={4} x2={28} y2={4} stroke={l.color} strokeWidth={2}
                            strokeDasharray={l.dash} />
                        </svg>
                        {l.label}
                      </span>
                    ))}
                  </div>
                )} />
                {lines.map(l => (
                  <Line key={l.id} dataKey={l.id} name={l.label} stroke={l.color} strokeDasharray={l.dash}
                    strokeWidth={1.9} dot={{ r: 2, strokeWidth: 0, fill: l.color }} isAnimationActive={false}
                    connectNulls={false} />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {revGap && (
        <div style={{ padding: '0 12px 8px', fontFamily: SANS, fontSize: 9.5, color: T.muted, lineHeight: 1.5 }}>
          Revenue estimates have no published history, so this series starts the day you first opened it.
          The EPS view carries a reconstructed opening quarter.
        </div>
      )}
    </div>
  )
}
