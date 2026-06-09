import { useMemo } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import {
  ComposedChart, Area, Line, Scatter, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, AreaChart,
} from 'recharts'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { useOptimalGrid } from '../../../hooks/useOptimalGrid'

const T = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))', headerBg: 'var(--theme-surface, #0d1826)', tileBg: 'var(--theme-surface, #0d1826)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #5e768f)', dim: '#3a4d62',
  mono: 'var(--theme-mono)', label: 'var(--theme-sans)',
  pos: '#22C55E', neg: '#EF4444', warn: '#f59e0b',
}

interface VolWindow { min: number; p25: number; p50: number; p75: number; max: number; current: number }
interface SnapshotData {
  ticker: string; spot: number; expiry: string | null
  atm_iv: number | null; hv_30: number | null; iv_vs_hv: number | null
  d50_call: number | null; d50_put: number | null; straddle_px: number | null
  pc_vol: number | null; be_upper: number | null; be_lower: number | null
  implied_move: number | null; consensus: string | null
  analyst_count: number | null; latest_action: string | null; price_target: number | null
  vol_cone: Record<string, VolWindow>
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, var(--theme-border-faint, var(--theme-border-faint, rgba(255,255,255,0.05))) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 3,
}

// ── Item registry ─────────────────────────────────────────────────────────────
const DATA_ITEMS = [
  { id: 'atm_iv',       label: 'ATM IV' },
  { id: 'implied_move', label: 'Implied Move' },
  { id: 'd50_call',     label: 'D50 Call' },
  { id: 'd50_put',      label: 'D50 Put' },
  { id: 'hv_30',        label: '30D Hist Vol' },
  { id: 'iv_vs_hv',     label: 'IV vs HV' },
  { id: 'be_range',     label: 'Break-Even' },
  { id: 'pc_vol',       label: 'P/C Volume' },
  { id: 'consensus',    label: 'Consensus' },
  { id: 'vol_cone',     label: 'Vol Cone' },
  { id: 'impl_prob',    label: 'Impl Probability' },
] as const
type ItemId = typeof DATA_ITEMS[number]['id']
const ALL_IDS: ItemId[] = DATA_ITEMS.map(d => d.id)

// ── Helpers ───────────────────────────────────────────────────────────────────
function consensusColor(c: string): string {
  const l = c.toLowerCase()
  if (l.includes('strong buy'))                          return T.pos
  if (l.includes('buy') || l.includes('outperform'))    return '#86efac'
  if (l.includes('hold') || l.includes('neutral'))      return T.warn
  if (l.includes('sell') || l.includes('underperform')) return T.neg
  return T.text
}

function Tile({ label, value, sub, valueColor }: { label: string; value: string; sub?: string; valueColor?: string }) {
  return (
    <div style={{ background: T.tileBg, border: `1px solid ${T.border}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, minHeight: 0 }}>
      <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.1em', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: valueColor ?? T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
      {sub && <span style={{ fontFamily: T.label, fontSize: 9, color: T.dim, lineHeight: 1.3 }}>{sub}</span>}
    </div>
  )
}

function IVPremiumTile({ ratio }: { ratio: number }) {
  const pct = Math.round((ratio - 1) * 100)
  const color = ratio >= 1.3 ? T.neg : ratio >= 1.0 ? T.warn : T.pos
  return (
    <div style={{ background: T.tileBg, border: `1px solid ${T.border}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>IV vs 30D HV</span>
      <span style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color }}>{ratio.toFixed(2)}×</span>
      <div style={{ height: 3, background: T.border, borderRadius: 2 }}>
        <div style={{ height: '100%', width: `${Math.min(ratio / 2 * 100, 100)}%`, background: color, borderRadius: 2 }} />
      </div>
      <span style={{ fontFamily: T.label, fontSize: 9, color: T.dim }}>{pct >= 0 ? '+' : ''}{pct}% — {ratio >= 1.3 ? 'options expensive' : ratio >= 1.0 ? 'slight premium' : 'options cheap'}</span>
    </div>
  )
}

function fmt(v: number | null, pre = '', suf = '', d = 1) {
  return v != null ? `${pre}${v.toFixed(d)}${suf}` : 'N/A'
}

// ── Price Projection Cone ─────────────────────────────────────────────────────
// X axis = calendar dates, Y axis = share price.
// Gold bands: ±1σ and ±2σ projected price range based on ATM IV.
// Blue band: ±1σ from 30d historical vol (for comparison).
function VolCone({ spot, atmIv, hv30, expiry }: {
  spot:   number
  atmIv:  number | null
  hv30:   number | null
  expiry: string | null
}) {
  const data = useMemo(() => {
    if (!atmIv) return []
    const today   = Date.now()
    const expiryMs = expiry ? new Date(expiry).getTime() : today + 60 * 86400000
    const dteDays  = Math.max((expiryMs - today) / 86400000, 1)
    // show 3× DTE so the cone context is visible, at least 90 days
    const horizonDays = Math.max(dteDays * 3, 90)
    const pts   = 60
    const r     = 0.045
    const sigIV = atmIv / 100
    const sigHV = hv30 != null ? hv30 / 100 : null

    return Array.from({ length: pts + 1 }, (_, i) => {
      const T_days = (horizonDays * i) / pts
      const T_y    = T_days / 365.25
      const date   = new Date(today + T_days * 86400000)
      const label  = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const driftIV = (r - 0.5 * sigIV ** 2) * T_y
      const sqrtT   = Math.sqrt(T_y)

      const iv1up = parseFloat((spot * Math.exp(driftIV + sigIV * sqrtT)).toFixed(2))
      const iv1dn = parseFloat((spot * Math.exp(driftIV - sigIV * sqrtT)).toFixed(2))
      const iv2up = parseFloat((spot * Math.exp(driftIV + 2 * sigIV * sqrtT)).toFixed(2))
      const iv2dn = parseFloat((spot * Math.exp(driftIV - 2 * sigIV * sqrtT)).toFixed(2))
      const expected = parseFloat((spot * Math.exp(driftIV)).toFixed(2))

      let hv1up: number | undefined, hv1dn: number | undefined
      if (sigHV) {
        const dHV  = (r - 0.5 * sigHV ** 2) * T_y
        hv1up = parseFloat((spot * Math.exp(dHV + sigHV * sqrtT)).toFixed(2))
        hv1dn = parseFloat((spot * Math.exp(dHV - sigHV * sqrtT)).toFixed(2))
      }

      return { label, T_days: Math.round(T_days), iv2up, iv1up, expected, iv1dn, iv2dn, hv1up, hv1dn }
    })
  }, [spot, atmIv, hv30, expiry])

  if (!atmIv || data.length === 0) return null

  const expiryLabel = expiry
    ? new Date(expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null

  const priceFormatter = (v: number) =>
    v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    const d = payload[0]?.payload
    if (!d) return null
    return (
      <div style={{ background: T.headerBg, border: `1px solid ${T.border}`, padding: '7px 10px', fontFamily: T.mono, fontSize: 10, minWidth: 160 }}>
        <div style={{ color: T.gold, fontWeight: 700, marginBottom: 5 }}>{label} · {d.T_days}d</div>
        <div style={{ color: 'rgba(201,168,76,0.6)', marginBottom: 2 }}>±2σ IV  {priceFormatter(d.iv2dn)} – {priceFormatter(d.iv2up)}</div>
        <div style={{ color: T.gold, marginBottom: 2 }}>±1σ IV  {priceFormatter(d.iv1dn)} – {priceFormatter(d.iv1up)}</div>
        {d.hv1up != null && <div style={{ color: 'var(--theme-tertiary, #60a5fa)' }}>±1σ HV  {priceFormatter(d.hv1dn)} – {priceFormatter(d.hv1up)}</div>}
        <div style={{ color: T.text, marginTop: 3 }}>expected  {priceFormatter(d.expected)}</div>
      </div>
    )
  }

  return (
    <div style={{ padding: '0 8px 8px', flex: 1, minHeight: 0 }}>
      <div style={{ fontFamily: T.label, fontSize: 9, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4, display: 'flex', gap: 12 }}>
        <span>Price Projection Cone</span>
        <span style={{ color: T.gold }}>IV {atmIv.toFixed(1)}%</span>
        {hv30 && <span style={{ color: 'var(--theme-tertiary, #60a5fa)' }}>HIST VOL {hv30.toFixed(1)}%</span>}
      </div>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(46,57,77,0.35)" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 9, fill: T.muted, fontFamily: T.mono }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 9, fill: T.muted, fontFamily: T.mono }} tickLine={false} axisLine={false}
            tickFormatter={priceFormatter} width={44}
            domain={['auto', 'auto']} />
          <Tooltip content={<CustomTooltip />} />

          {/* ±2σ IV outer cone — fills from baseline to iv2up then cut by iv2dn */}
          <Area type="monotone" dataKey="iv2up" stroke="rgba(201,168,76,0.25)" strokeWidth={1} fill="color-mix(in srgb, var(--theme-primary, #c9a84c) 7%, transparent)" dot={false} legendType="none" />
          <Area type="monotone" dataKey="iv2dn" stroke="rgba(201,168,76,0.25)" strokeWidth={1} fill={T.bg} dot={false} legendType="none" />

          {/* ±1σ IV inner cone */}
          <Area type="monotone" dataKey="iv1up" stroke="rgba(201,168,76,0.5)" strokeWidth={1.5} fill="color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)" dot={false} legendType="none" />
          <Area type="monotone" dataKey="iv1dn" stroke="rgba(201,168,76,0.5)" strokeWidth={1.5} fill={T.bg} dot={false} legendType="none" />

          {/* ±1σ HV comparison cone (blue) */}
          {hv30 != null && <>
            <Area type="monotone" dataKey="hv1up" stroke="rgba(96,165,250,0.4)" strokeWidth={1} strokeDasharray="4 2" fill="rgba(96,165,250,0.07)" dot={false} legendType="none" />
            <Area type="monotone" dataKey="hv1dn" stroke="rgba(96,165,250,0.4)" strokeWidth={1} strokeDasharray="4 2" fill={T.bg} dot={false} legendType="none" />
          </>}

          {/* Expected value (drift path) */}
          <Line type="monotone" dataKey="expected" stroke={T.gold} strokeWidth={1} strokeDasharray="3 3" dot={false} legendType="none" />

          {/* Current spot */}
          <ReferenceLine y={spot} stroke="var(--theme-text-muted, rgba(215,227,252,0.35))" strokeWidth={1} strokeDasharray="2 4"
            label={{ value: `$${spot.toFixed(2)}`, position: 'insideTopLeft', fontSize: 9, fill: T.text, fontFamily: T.mono }} />

          {/* Expiry marker */}
          {expiryLabel && (
            <ReferenceLine x={expiryLabel} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)" strokeWidth={1}
              label={{ value: 'exp', position: 'insideTopRight', fontSize: 8, fill: T.dim, fontFamily: T.label }} />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Market-Implied Probability ────────────────────────────────────────────────
function ImpliedProb({ spot, atmIv, expiry }: { spot: number; atmIv: number; expiry: string | null }) {
  const data = useMemo(() => {
    const T_y = expiry
      ? Math.max((new Date(expiry).getTime() - Date.now()) / (365.25 * 86400000), 1 / 365.25)
      : 30 / 365
    const sigma = atmIv / 100
    const mu    = -0.5 * sigma * sigma * T_y
    const sigT  = sigma * Math.sqrt(T_y)
    const lo = spot * Math.exp(mu - 3.5 * sigT)
    const hi = spot * Math.exp(mu + 3.5 * sigT)
    const pts = 120
    return Array.from({ length: pts }, (_, i) => {
      const x  = lo + (hi - lo) * i / (pts - 1)
      const lx = Math.log(x / spot)
      const p  = (1 / (x * sigT * Math.sqrt(2 * Math.PI))) * Math.exp(-((lx - mu) ** 2) / (2 * sigT ** 2))
      const inSd1 = Math.abs(lx - mu) <= sigT
      return { price: Math.round(x * 100) / 100, prob: p, sd1: inSd1 ? p : 0 }
    })
  }, [spot, atmIv, expiry])

  return (
    <div style={{ padding: '0 8px 8px', flex: 1, minHeight: 0 }}>
      <div style={{ fontFamily: T.label, fontSize: 9, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
        Market-Implied Probability Distribution
      </div>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(46,57,77,0.4)" vertical={false} />
          <XAxis dataKey="price" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 9, fill: T.muted, fontFamily: T.mono }} tickLine={false} axisLine={false} tickFormatter={v => `$${v.toFixed(0)}`} tickCount={7} />
          <YAxis hide />
          <Tooltip
            contentStyle={{ background: T.headerBg, border: `1px solid ${T.border}`, fontSize: 10, fontFamily: T.mono }}
            formatter={(val: number, name: string) => name === 'prob' ? [`${(val * 100).toFixed(3)}%`, 'density'] : [null, null]}
            labelFormatter={v => `$${Number(v).toFixed(2)}`}
          />
          <Area type="monotone" dataKey="sd1" stroke="none" fill="rgba(34,197,94,0.18)" />
          <Area type="monotone" dataKey="prob" stroke="#60a5fa" strokeWidth={1.5} fill="rgba(96,165,250,0.08)" dot={false} />
          <ReferenceLine x={spot} stroke={T.gold} strokeWidth={1.5}
            label={{ value: `$${spot.toFixed(0)}`, position: 'insideTopRight', fontSize: 9, fill: T.gold, fontFamily: T.mono }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

// ── Checkbox panel ────────────────────────────────────────────────────────────
// ── Main widget ───────────────────────────────────────────────────────────────
export default function OptionsSnapshot({ config }: { config: WidgetConfig }) {
  const ticker = config.ticker
  const visibleItems = (config.visibleItems ?? ALL_IDS) as ItemId[]
  const visible = new Set<ItemId>(visibleItems)

  const show = (id: ItemId) => visible.has(id)

  // Count visible data tiles (not charts)
  const tileIds: ItemId[] = ['atm_iv','implied_move','d50_call','d50_put','hv_30','iv_vs_hv','be_range','pc_vol','consensus']
  const visibleTileCount = tileIds.filter(id => visible.has(id)).length

  const { cols, gridRef } = useOptimalGrid(visibleTileCount, { minW: 130, minH: 60, targetAspect: 1.8 })

  const { data, isLoading, isError } = useQuery<SnapshotData>({
    queryKey: ['options-snapshot-v3', ticker],
    queryFn: () => axios.get(`/api/options/snapshot?ticker=${ticker}`).then(r => r.data),
    enabled: !!ticker,
    staleTime: 900_000,
  })

  const base: React.CSSProperties = {
    background: T.bg, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', fontFamily: T.mono,
  }

  if (!ticker) {
    return (
      <div style={base}>
        <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
        <div style={{ padding: '8px 12px', background: T.headerBg, borderBottom: `1px solid ${T.border}` }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold }}>OPTIONS SNAPSHOT</span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: T.muted, fontFamily: T.label, fontSize: 12 }}>Configure ticker in edit mode.</span>
        </div>
      </div>
    )
  }

  if (isLoading) {
    return (
      <div style={base}>
        <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
        <div style={{ padding: '7px 12px', background: T.headerBg, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold }}>{ticker}</span>
        </div>
        <div style={{ flex: '0 1 auto', minHeight: 0, overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: 6, padding: 8 }}>
          {Array.from({ length: visibleTileCount }).map((_, i) => <div key={i} style={{ ...shimmer, minHeight: 60 }} />)}
        </div>
      </div>
    )
  }

  if (isError || !data) {
    return (
      <div style={base}>
        <div style={{ padding: '7px 12px', background: T.headerBg, borderBottom: `1px solid ${T.border}` }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: T.gold }}>{ticker}</span>
        </div>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: T.muted, fontFamily: T.label, fontSize: 12 }}>Options data unavailable.</span>
        </div>
      </div>
    )
  }

  const daysToExpiry = data.expiry
    ? Math.max(Math.round((new Date(data.expiry).getTime() - Date.now()) / 86400000), 0)
    : null

  const showCharts = show('vol_cone') || show('impl_prob')
  const hasCone = show('vol_cone') && data.atm_iv != null
  const hasProb = show('impl_prob') && data.atm_iv != null

  return (
    <div style={base}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Data tiles */}
      {visibleTileCount > 0 && (
        <div ref={gridRef} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)`, gridAutoRows: 'minmax(60px, auto)', display: 'grid', gap: 6, padding: 8, flex: '0 1 auto', minHeight: 0, overflowY: 'auto' }}>
          {show('atm_iv') && (
            <Tile label="ATM IV" value={fmt(data.atm_iv, '', '%')} sub="implied vol at-the-money"
              valueColor={data.atm_iv != null ? data.atm_iv > 60 ? T.neg : data.atm_iv > 35 ? T.warn : T.pos : undefined} />
          )}
          {show('implied_move') && (
            <Tile label="Implied Move" value={data.implied_move != null ? `±${data.implied_move.toFixed(1)}%` : 'N/A'}
              sub={data.straddle_px != null ? `straddle $${data.straddle_px.toFixed(2)}` : undefined} />
          )}
          {show('d50_call') && (
            <Tile label="D50 Call" value={fmt(data.d50_call, '$', '', 2)} sub={`ATM call · strike ≈ $${data.spot.toFixed(0)}`} />
          )}
          {show('d50_put') && (
            <Tile label="D50 Put" value={fmt(data.d50_put, '$', '', 2)} sub={`ATM put · strike ≈ $${data.spot.toFixed(0)}`} />
          )}
          {show('hv_30') && (
            <Tile label="30D Historical Vol" value={fmt(data.hv_30, '', '%')} sub="realized vol (30 day)" />
          )}
          {show('iv_vs_hv') && (
            data.iv_vs_hv != null
              ? <IVPremiumTile ratio={data.iv_vs_hv} />
              : <Tile label="IV vs 30D HV" value="N/A" />
          )}
          {show('be_range') && (
            <Tile label="Break-Even Range"
              value={data.be_lower != null && data.be_upper != null ? `$${data.be_lower.toFixed(2)} – $${data.be_upper.toFixed(2)}` : 'N/A'}
              sub={data.straddle_px != null ? `straddle ±$${data.straddle_px.toFixed(2)} from spot` : undefined} />
          )}
          {show('pc_vol') && (
            <Tile label="P/C Volume" value={fmt(data.pc_vol, '', '', 2)}
              sub={data.pc_vol != null ? data.pc_vol > 1.2 ? 'put-heavy' : data.pc_vol < 0.8 ? 'call-heavy' : 'balanced' : undefined}
              valueColor={data.pc_vol != null ? data.pc_vol > 1.2 ? T.neg : data.pc_vol < 0.8 ? T.pos : T.text : undefined} />
          )}
          {show('consensus') && (
            <div style={{ background: T.tileBg, border: `1px solid ${T.border}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, minHeight: 0 }}>
              <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                Consensus{data.analyst_count ? ` · ${data.analyst_count}` : ''}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 700, color: data.consensus ? consensusColor(data.consensus) : T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {data.consensus ? data.consensus.split('  ')[0] : 'N/A'}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {data.consensus?.split('  ')[1] && <span style={{ fontFamily: T.label, fontSize: 9, color: T.dim }}>{data.consensus.split('  ')[1]}</span>}
                {(data.latest_action || data.price_target != null) && (
                  <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {data.latest_action}{data.price_target != null ? ` · PT $${data.price_target.toFixed(0)}` : ''}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Charts */}
      {showCharts && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: hasCone && hasProb ? 'row' : 'column', gap: 0 }}>
          {hasCone && <VolCone spot={data.spot} atmIv={data.atm_iv} hv30={data.hv_30} expiry={data.expiry} />}
          {hasProb && data.atm_iv != null && (
            <ImpliedProb spot={data.spot} atmIv={data.atm_iv} expiry={data.expiry} />
          )}
        </div>
      )}
    </div>
  )
}
