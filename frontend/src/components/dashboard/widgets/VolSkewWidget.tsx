import { T } from '../../../lib/theme'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, CartesianGrid } from 'recharts'
import type { WidgetConfig } from '../../../hooks/useDashboard'


interface SkewResp {
  ticker: string
  spot: number
  front_expiry: string
  atm_iv: number
  rr_25: number
  ts_slope: number
  front_smile: { moneyness: number; iv: number }[]
  term_structure: { expiry: string; dte: number; atm_iv: number; rr_25: number; smile: { moneyness: number; iv: number }[] }[]
}

const skewColor = (v: number) => (v > 4 ? T.neg : v > 1.5 ? T.warn : T.pos)

export default function VolSkewWidget({ config }: { config: WidgetConfig }) {
  const ticker = config.ticker

  const { data, isLoading, isError } = useQuery<SkewResp>({
    queryKey: ['skew-widget', ticker],
    queryFn: () => axios.get(`/api/prob/skew?ticker=${ticker}`).then(r => r.data),
    enabled: !!ticker,
    staleTime: 300_000,
    retry: 1,
  })

  if (!ticker) return (
    <div style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', background: T.bg, padding: 12, textAlign: 'center' }}>
      <span style={{ color: T.muted, fontFamily: T.label, fontSize: 11 }}>Configure a ticker in edit mode.</span>
    </div>
  )

  // The whole term is fetched at once; the date param just selects which expiry's
  // smile and skew to show. Term slope stays a global read.
  const sel = data?.term_structure?.find(t => t.expiry === config.expiry) ?? data?.term_structure?.[0]
  const atmIv = sel?.atm_iv ?? data?.atm_iv ?? 0
  const putSkew = sel?.rr_25 ?? data?.rr_25 ?? 0
  const smile = sel?.smile ?? data?.front_smile ?? []
  const smileExpiry = sel?.expiry ?? data?.front_expiry ?? ''

  const stats = data ? [
    { l: 'ATM IV', v: `${atmIv.toFixed(1)}%`, c: T.text },
    { l: 'Put Skew', v: `${putSkew > 0 ? '+' : ''}${putSkew.toFixed(1)}`, c: skewColor(putSkew) },
    { l: 'Term', v: `${data.ts_slope > 0 ? '+' : ''}${data.ts_slope.toFixed(1)}`, c: data.ts_slope < -0.5 ? T.neg : T.gold },
  ] : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      {isLoading && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.muted }}>Loading skew…</div>}
      {isError && <div style={{ padding: 12, fontFamily: T.mono, fontSize: 10, color: T.neg }}>No skew data</div>}

      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
            {stats.map(({ l, v, c }) => (
              <div key={l} style={{ padding: '7px 10px', borderRight: `1px solid ${T.border}` }}>
                <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 3 }}>{l}</div>
                <div style={{ fontFamily: T.mono, fontSize: 14, fontWeight: 700, color: c, lineHeight: 1 }}>{v}</div>
              </div>
            ))}
          </div>

          <div style={{ padding: '4px 10px 0', fontFamily: T.mono, fontSize: 8, color: T.muted, letterSpacing: '0.06em', flexShrink: 0 }}>
            Skew · {smileExpiry} · IV by moneyness
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: '2px 4px 4px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={smile} margin={{ left: 2, right: 6, top: 4, bottom: 0 }}>
                <CartesianGrid horizontal vertical={false} stroke="rgba(100,120,150,0.12)" />
                <XAxis dataKey="moneyness" tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }} tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v}%`} type="number" domain={['dataMin', 'dataMax']} />
                <YAxis width={28} tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }} tickFormatter={(v: number) => `${Math.round(v)}%`} domain={['auto', 'auto']} />
                <Tooltip
                  cursor={{ stroke: T.border }}
                  contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 9, padding: '4px 8px' }}
                  labelStyle={{ color: T.gold, fontSize: 8 }}
                  formatter={(v: number) => [`${v.toFixed(1)}%`, 'IV']}
                  labelFormatter={(m) => `${Number(m) > 0 ? '+' : ''}${m}% moneyness`}
                />
                <ReferenceLine x={0} stroke="color-mix(in srgb, var(--theme-primary) 45%, transparent)" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="iv" stroke={T.gold} strokeWidth={1.6} dot={{ r: 1.6, fill: T.gold, strokeWidth: 0 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  )
}
