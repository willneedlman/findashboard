import { T } from '../../../lib/theme'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR } from '../../ChartTooltip'


const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, rgba(255,255,255,0.05) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 2,
}

const SERIES_META: Record<string, { backendKey: string; label: string; color: string; isVix?: boolean }> = {
  ig:     { backendKey: 'ig_oas', label: 'IG OAS',  color: 'var(--theme-tertiary, #60a5fa)' },
  hy:     { backendKey: 'hy_oas', label: 'HY OAS',  color: 'var(--theme-negative, #ef4444)' },
  ig_3_5: { backendKey: 'ig_3_5', label: 'IG 3–5Y', color: '#818cf8' },
  hy_b:   { backendKey: 'hy_b',   label: 'HY B',    color: 'var(--theme-accent-orange, #f97316)' },
  hy_ccc: { backendKey: 'hy_ccc', label: 'HY CCC',  color: '#fb7185' },
  vix:    { backendKey: 'vix',    label: 'VIX',     color: 'var(--theme-primary, #c9a84c)', isVix: true },
}

interface SeriesData {
  label:      string
  current:    number | null
  change_1y?: number | null
  history:    { date: string; value: number }[]
}

interface CreditResponse {
  series: Record<string, SeriesData>
  as_of:  string
}

function rangeStats(series?: SeriesData) {
  const values = series?.history.map(point => point.value).filter(Number.isFinite) ?? []
  if (!values.length) return { min: null, max: null, z: null }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  const current = series?.current
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    z: current != null && variance > 0 ? (current - mean) / Math.sqrt(variance) : null,
  }
}

export default function CreditSpreadsWidget({ config }: { config: WidgetConfig }) {
  const activeSeries = config.categories?.length ? config.categories : ['ig', 'hy', 'vix']
  const lookback     = config.lookback ?? 90

  const { data, isLoading, isError } = useQuery<CreditResponse>({
    queryKey: ['credit-spreads', 365],
    queryFn: () => axios.get('/api/rates/credit-spreads?lookback=365').then(r => r.data),
    staleTime: 3_600_000,
    retry: 1,
  })

  const hasVix       = activeSeries.includes('vix')
  const creditSeries = activeSeries.filter(k => SERIES_META[k] && !SERIES_META[k].isVix)

  // Build chart data — credit keys on left axis, vix on right axis (different scale)
  const chartData = (() => {
    const dateMap: Record<string, Record<string, number>> = {}
    for (const key of creditSeries) {
      const meta   = SERIES_META[key]
      const series = data?.series[meta.backendKey]
      if (!series) continue
      series.history.slice(-lookback).forEach(d => {
        dateMap[d.date] = { ...dateMap[d.date], [key]: d.value }
      })
    }
    if (hasVix && data?.series.vix) {
      data.series.vix.history.slice(-lookback).forEach(d => {
        dateMap[d.date] = { ...dateMap[d.date], _vix: d.value }
      })
    }
    return Object.entries(dateMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }))
  })()

  const statItems = activeSeries
    .map(key => {
      const meta   = SERIES_META[key]
      if (!meta) return null
      const series = data?.series[meta.backendKey]
      return { key, label: meta.label, color: meta.color, value: series?.current ?? null, isVix: !!meta.isVix, ...rangeStats(series) }
    })
    .filter(Boolean) as { key: string; label: string; color: string; value: number | null; isVix: boolean; min: number | null; max: number | null; z: number | null }[]

  const quality = [
    { key: 'ig_3_5', label: 'IG 3-5Y', color: SERIES_META.ig_3_5.color },
    { key: 'hy_b', label: 'HY B', color: SERIES_META.hy_b.color },
    { key: 'hy_ccc', label: 'HY CCC', color: SERIES_META.hy_ccc.color },
  ].map(item => {
    const series = data?.series[item.key]
    return { ...item, value: series?.current ?? null, ...rangeStats(series) }
  })
  const qualityValues = quality.map(item => item.value).filter((value): value is number => value != null)
  const qualityMin = Math.min(...qualityValues, 0)
  const qualityMax = Math.max(...qualityValues, 1)
  const igValue = quality[0].value
  const cccValue = quality[2].value
  const decompression = igValue != null && cccValue != null ? cccValue - igValue : null

  const changeItems = creditSeries.map(key => {
    const meta   = SERIES_META[key]
    const series = data?.series[meta.backendKey]
    return { key, label: `${meta.label} vs 1Y`, color: meta.color, val: series?.change_1y ?? null }
  })

  // Grid columns: fit all on 1 row if ≤4, else split evenly across 2 rows
  const changeCols = changeItems.length <= 4 ? changeItems.length : Math.ceil(changeItems.length / 2)

  const showChart = creditSeries.length > 0 || hasVix

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {isLoading && (
        <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1,2,3].map(i => <div key={i} style={{ ...shimmer, height: 24 }} />)}
        </div>
      )}

      {isError && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>Credit data unavailable</div>}

      {data && (
        <>
          {/* Stat tiles */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${statItems.length}, 1fr)`,
            borderBottom: `1px solid ${T.border}`,
            flexShrink: 0,
          }}>
            {statItems.map(({ label, value, color, isVix, min, max, z }) => (
              <div key={label} style={{ padding: '8px 10px', borderRight: `1px solid ${T.border}` }}>
                <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 4 }}>{label}</div>
                <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color, lineHeight: 1 }}>
                  {value != null ? value.toFixed(0) : '—'}
                  {!isVix && <span style={{ fontSize: 9, opacity: 0.6 }}> bps</span>}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 7.5, color: T.muted, marginTop: 3, whiteSpace: 'nowrap' }}>
                  z {z == null ? 'n/a' : `${z >= 0 ? '+' : ''}${z.toFixed(1)}`} | 1Y {min == null || max == null ? 'n/a' : `${min.toFixed(0)}-${max.toFixed(0)}`}
                </div>
              </div>
            ))}
          </div>

          <div style={{ padding: '5px 10px 6px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: T.muted }}>QUALITY LADDER</span>
              <span style={{ fontFamily: T.mono, fontSize: 8, color: decompression != null ? T.neg : T.muted }}>
                CCC-IG gap {decompression == null ? 'n/a' : `${decompression.toFixed(0)} bps`}
              </span>
            </div>
            <div style={{ position: 'relative', height: 18, background: 'rgba(255,255,255,0.04)', border: `1px solid ${T.border}` }}>
              {quality.map(item => {
                const left = item.value == null ? 0 : ((item.value - qualityMin) / Math.max(qualityMax - qualityMin, 1)) * 92
                return (
                  <div key={item.key} style={{ position: 'absolute', left: `${left}%`, top: 2, transform: 'translateX(-1px)', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <div style={{ width: 2, height: 12, background: item.color }} />
                    <span style={{ fontFamily: T.mono, fontSize: 7.5, color: item.color, whiteSpace: 'nowrap' }}>
                      {item.label} {item.value == null ? 'n/a' : item.value.toFixed(0)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Chart — credit series on left axis, VIX on right axis */}
          {showChart && (
            <div style={{ flex: 1, minHeight: 0, padding: '6px 4px 4px' }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ left: 2, right: hasVix ? 2 : 2, top: 2, bottom: 0 }}>
                  <XAxis dataKey="date" hide />
                  {creditSeries.length > 0 && (
                    <YAxis yAxisId="left" hide domain={['auto', 'auto']} />
                  )}
                  {hasVix && (
                    <YAxis yAxisId="right" orientation="right" hide domain={['auto', 'auto']} />
                  )}
                  <Tooltip
                    cursor={CROSSHAIR_CURSOR}
                    contentStyle={{ ...TOOLTIP_STYLE }}
                    labelStyle={{ color: T.gold, fontSize: 8 }}
                    formatter={(v: number, key: string) => {
                      if (key === '_vix') return [`${v.toFixed(1)}`, 'VIX']
                      return [`${v.toFixed(0)} bps`, SERIES_META[key]?.label ?? key]
                    }}
                  />
                  {creditSeries.map(key => (
                    <Line isAnimationActive={false}
                      key={key}
                      yAxisId="left"
                      type="monotone"
                      dataKey={key}
                      stroke={SERIES_META[key]?.color ?? T.muted}
                      strokeWidth={1.5}
                      dot={false}
                    />
                  ))}
                  {hasVix && (
                    <Line isAnimationActive={false}
                      yAxisId="right"
                      type="monotone"
                      dataKey="_vix"
                      stroke={SERIES_META.vix.color}
                      strokeWidth={1.5}
                      dot={false}
                    />
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Change vs 1Y — grid so overflow wraps evenly */}
          {changeItems.length > 0 && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${changeCols}, 1fr)`,
              borderTop: `1px solid ${T.border}`,
              flexShrink: 0,
            }}>
              {changeItems.map(({ label, val, color }) => (
                <div key={label} style={{ padding: '5px 10px', borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ fontFamily: T.label, fontSize: 8, color: T.muted }}>{label}: </span>
                  {val != null ? (
                    <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: val >= 0 ? T.neg : T.pos }}>
                      {val >= 0 ? '+' : ''}{val.toFixed(0)} bps
                    </span>
                  ) : (
                    <span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }} title="One-year spread change unavailable">
                      n/a
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
