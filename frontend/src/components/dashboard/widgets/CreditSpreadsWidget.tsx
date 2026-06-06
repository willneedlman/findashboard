import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'rgba(255,255,255,0.08)',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    '#d7e3fc',
  mono:    'JetBrains Mono, monospace',
  label:   'IBM Plex Sans, sans-serif',
  pos:     '#22c55e',
  neg:     '#ef4444',
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, rgba(255,255,255,0.05) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 2,
}

interface SeriesData {
  label:   string
  current: number | null
  change_1y: number | null
  history: { date: string; value: number }[]
}

interface CreditResponse {
  series: Record<string, SeriesData>
  as_of:  string
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

  const ig  = data?.series.ig_oas
  const hy  = data?.series.hy_oas
  const vix = data?.series.vix

  const chartData = (() => {
    const dateMap: Record<string, { ig?: number; hy?: number }> = {}
    if (activeSeries.includes('ig') && ig)
      ig.history.slice(-lookback).forEach(d => { dateMap[d.date] = { ...dateMap[d.date], ig: d.value } })
    if (activeSeries.includes('hy') && hy)
      hy.history.slice(-lookback).forEach(d => { dateMap[d.date] = { ...dateMap[d.date], hy: d.value } })
    return Object.entries(dateMap).sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v }))
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: T.surface, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold }}>Credit Spreads</span>
        {data && <span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>BofA ICE via FRED</span>}
      </div>

      {isLoading && (
        <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[1,2,3].map(i => <div key={i} style={{ ...shimmer, height: 24 }} />)}
        </div>
      )}

      {isError && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>Failed — check FRED API key</div>}

      {data && (
        <>
          {/* Stat row */}
          <div style={{ display: 'grid', gridTemplateColumns: [activeSeries.includes('ig') && '1fr', activeSeries.includes('hy') && '1fr', activeSeries.includes('vix') && '1fr'].filter(Boolean).join(' '), borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
            {[
              { key: 'ig',  label: 'IG OAS', value: ig?.current,  color: '#60a5fa' },
              { key: 'hy',  label: 'HY OAS', value: hy?.current,  color: '#ef4444' },
              { key: 'vix', label: 'VIX',    value: vix?.current, color: T.gold   },
            ].filter(s => activeSeries.includes(s.key)).map(({ label, value, color }) => (
              <div key={label} style={{ padding: '8px 10px', borderRight: `1px solid ${T.border}` }}>
                <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 4 }}>{label}</div>
                <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color, lineHeight: 1 }}>
                  {value != null ? value.toFixed(0) : '—'}
                  <span style={{ fontSize: 9, opacity: 0.6 }}>{label === 'VIX' ? '' : ' bps'}</span>
                </div>
              </div>
            ))}
          </div>

          {/* Sparkline chart */}
          <div style={{ flex: 1, minHeight: 0, padding: '6px 4px 4px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ left: 2, right: 2, top: 2, bottom: 0 }}>
                <XAxis dataKey="date" hide />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip
                  cursor={{ stroke: T.border }}
                  contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 9, padding: '4px 8px' }}
                  labelStyle={{ color: T.gold, fontSize: 8 }}
                  formatter={(v: number, name: string) => [`${v.toFixed(0)} bps`, name === 'ig' ? 'IG OAS' : 'HY OAS']}
                />
                {activeSeries.includes('ig') && <Line type="monotone" dataKey="ig" stroke="#60a5fa" strokeWidth={1.5} dot={false} />}
                {activeSeries.includes('hy') && <Line type="monotone" dataKey="hy" stroke="#ef4444" strokeWidth={1.5} dot={false} />}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Change indicators */}
          <div style={{ display: 'flex', gap: 0, borderTop: `1px solid ${T.border}`, flexShrink: 0 }}>
            {[
              { key: 'ig', label: 'IG vs 1Y', val: ig?.change_1y, color: '#60a5fa' },
              { key: 'hy', label: 'HY vs 1Y', val: hy?.change_1y, color: '#ef4444' },
            ].filter(s => activeSeries.includes(s.key)).map(({ label, val, color }) => (
              <div key={label} style={{ flex: 1, padding: '5px 10px', borderRight: `1px solid ${T.border}` }}>
                <span style={{ fontFamily: T.label, fontSize: 8, color: T.muted }}>{label}: </span>
                <span style={{ fontFamily: T.mono, fontSize: 9, fontWeight: 700, color: val == null ? T.muted : val >= 0 ? T.neg : T.pos }}>
                  {val != null ? `${val >= 0 ? '+' : ''}${val.toFixed(0)} bps` : '—'}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
