import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { fetchGEX } from '../../../hooks/useApi'
import type { WidgetConfig } from '../../../hooks/useDashboard'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     '#22c55e',
  neg:     '#ef4444',
}

interface GEXStrike { strike: number; net_gex: number }
interface GEXResp { spot?: number; data?: GEXStrike[]; expiry?: string | null }

const STRIKE_COUNTS = [10, 20, 30, 40, 0] // 0 = all
const selStyle: React.CSSProperties = { background: 'var(--theme-bg, #101c2e)', border: `1px solid ${T.border}`, color: T.gold, fontFamily: T.mono, fontSize: 8.5, padding: '1px 3px', outline: 'none', cursor: 'pointer' }

export default function DealerGEXWidget({ config }: { config: WidgetConfig }) {
  const ticker = config.ticker
  const expiry = config.expiry
  const [count, setCount] = useState(20) // strikes shown around spot; 0 = all

  const { data, isLoading, isError } = useQuery<GEXResp>({
    queryKey: ['gex-widget', ticker, expiry],
    queryFn: () => fetchGEX(ticker as string, expiry || undefined),
    enabled: !!ticker,
    staleTime: 300_000,
    retry: 1,
  })

  if (!ticker) return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', background: T.bg, padding: 12, textAlign: 'center' }}>
      <span style={{ color: T.muted, fontFamily: T.label, fontSize: 11 }}>Configure a ticker in edit mode.</span>
    </div>
  )

  const spot = data?.spot ?? null
  const raw = [...(data?.data ?? [])].sort((a, b) => a.strike - b.strike)
  // Show the `count` strikes nearest spot (0 = all) so the bars stay readable.
  const band = count > 0 && spot
    ? [...raw].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, count).sort((a, b) => a.strike - b.strike)
    : raw
  const totalNet = raw.reduce((s, d) => s + d.net_gex, 0)

  // Gamma flip: per-strike net_gex sign change nearest spot.
  let flip: number | null = null
  if (spot && raw.length > 1) {
    let best = Infinity
    for (let i = 0; i < raw.length - 1; i++) {
      if (raw[i].net_gex * raw[i + 1].net_gex < 0) {
        const cand = Math.abs(raw[i].strike - spot) <= Math.abs(raw[i + 1].strike - spot) ? raw[i].strike : raw[i + 1].strike
        const dist = Math.abs(cand - spot)
        if (dist < best) { best = dist; flip = cand }
      }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      {isLoading && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.muted }}>Loading GEX…</div>}
      {isError && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>Failed to load GEX</div>}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
            {[
              { l: 'Spot', v: spot != null ? `$${spot.toFixed(0)}` : '—', c: T.text },
              { l: 'Net GEX', v: `${totalNet >= 0 ? '+' : ''}${totalNet.toFixed(0)}M`, c: totalNet >= 0 ? T.pos : T.neg },
              { l: 'Flip', v: flip ? `$${flip.toFixed(0)}` : 'N/A', c: T.gold },
            ].map(({ l, v, c }) => (
              <div key={l} style={{ padding: '7px 10px', borderRight: `1px solid ${T.border}` }}>
                <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }}>{l}</div>
                <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: c, lineHeight: 1 }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '3px 10px 0', flexShrink: 0 }}>
            <span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted, letterSpacing: '0.06em' }}>{data?.expiry ? `exp ${data.expiry}` : 'all chains'}</span>
            <select value={count} onChange={e => setCount(Number(e.target.value))} style={selStyle} title="Strikes shown (nearest spot)">
              {STRIKE_COUNTS.map(n => <option key={n} value={n}>{n === 0 ? 'All strikes' : `${n} strikes`}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: '4px 4px 4px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={band} margin={{ left: 2, right: 4, top: 4, bottom: 0 }}>
                <XAxis dataKey="strike" tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }} tickFormatter={(v: number) => `${v}`} interval="preserveStartEnd" />
                <YAxis hide domain={['auto', 'auto']} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 9, padding: '4px 8px' }}
                  labelStyle={{ color: T.gold, fontSize: 8 }}
                  formatter={(v: number) => [`${v.toFixed(0)}M`, 'Net GEX']}
                />
                {spot && <ReferenceLine x={band.reduce((p, c) => Math.abs(c.strike - spot) < Math.abs(p - spot) ? c.strike : p, band[0]?.strike ?? spot)} stroke="rgba(201,168,76,0.6)" strokeDasharray="3 3" />}
                <Bar dataKey="net_gex" radius={[1, 1, 0, 0]}>
                  {band.map((d, i) => <Cell key={i} fill={d.net_gex >= 0 ? T.pos : T.neg} fillOpacity={0.85} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  )
}
