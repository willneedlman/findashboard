import { useMemo } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer, AreaChart,
} from 'recharts'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { useOptimalGrid } from '../../../hooks/useOptimalGrid'
import { TOOLTIP_STYLE } from '../../ChartTooltip'

// ── Design tokens ─────────────────────────────────────────────────────────────
const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  text:    'var(--theme-text, #d7e3fc)',
  muted:   'var(--theme-secondary, #8099b0)',
  dim:     'color-mix(in srgb, var(--theme-secondary, #8099b0) 55%, transparent)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     'var(--theme-positive, #22c55e)',
  neg:     'var(--theme-negative, #ef4444)',
  warn:    '#f59e0b',
  blue:    '#60a5fa',
}

// Semantic accents keyed to tile role
const ACCENT = {
  iv:       T.gold,
  move:     T.gold,
  hv:       T.blue,
  pricing:  'color-mix(in srgb, var(--theme-text, #d7e3fc) 30%, transparent)',
  risk:     T.warn,
  neutral:  'color-mix(in srgb, var(--theme-border, rgba(255,255,255,0.08)) 120%, transparent)',
}

interface SnapshotData {
  ticker: string; spot: number; expiry: string | null
  atm_iv: number | null; hv_30: number | null; iv_vs_hv: number | null
  d50_call: number | null; d50_put: number | null; straddle_px: number | null
  pc_vol: number | null; be_upper: number | null; be_lower: number | null
  implied_move: number | null; consensus: string | null
  analyst_count: number | null; latest_action: string | null; price_target: number | null
  vol_cone: Record<string, unknown>
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, var(--theme-surface, #0d0d0d) 25%, rgba(255,255,255,0.04) 50%, var(--theme-surface, #0d0d0d) 75%)',
  backgroundSize: '200% 100%', animation: 'shimmer 2s infinite', borderRadius: 2,
}

const DATA_ITEMS = [
  { id: 'atm_iv' }, { id: 'implied_move' }, { id: 'd50_call' },
  { id: 'd50_put' }, { id: 'hv_30' }, { id: 'iv_vs_hv' },
  { id: 'be_range' }, { id: 'pc_vol' }, { id: 'consensus' },
  { id: 'vol_cone' }, { id: 'impl_prob' },
] as const
type ItemId = typeof DATA_ITEMS[number]['id']
const ALL_IDS: ItemId[] = DATA_ITEMS.map(d => d.id)

function consensusColor(c: string): string {
  const l = c.toLowerCase()
  if (l.includes('strong buy'))                          return T.pos
  if (l.includes('buy') || l.includes('outperform'))    return '#86efac'
  if (l.includes('hold') || l.includes('neutral'))      return T.warn
  if (l.includes('sell') || l.includes('underperform')) return T.neg
  return T.text
}

function fmt(v: number | null, pre = '', suf = '', d = 1) {
  return v != null ? `${pre}${v.toFixed(d)}${suf}` : '—'
}

// ── Base tile ─────────────────────────────────────────────────────────────────
function Tile({ label, value, sub, sub2, valueColor, accent }: {
  label: string; value: string; sub?: string; sub2?: string
  valueColor?: string; accent?: string
}) {
  return (
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`,
      borderTop: `2px solid ${accent ?? ACCENT.neutral}`,
      padding: '5px 8px', display: 'flex', flexDirection: 'column', gap: 1,
      minWidth: 0, minHeight: 0, overflow: 'hidden',
    }}>
      <span style={{ fontFamily: T.label, fontSize: 7, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.1em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: valueColor ?? T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: '1.15' }}>{value}</span>
      {sub  && <span style={{ fontFamily: T.label, fontSize: 7, color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</span>}
      {sub2 && <span style={{ fontFamily: T.label, fontSize: 7, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub2}</span>}
    </div>
  )
}

// ── IV vs HV gauge tile ───────────────────────────────────────────────────────
function IVPremiumTile({ ratio }: { ratio: number }) {
  const pct   = Math.round((ratio - 1) * 100)
  const color = ratio >= 1.5 ? T.neg : ratio >= 1.1 ? T.warn : ratio >= 0.9 ? T.text : T.pos
  // 0× → 3× mapped to 0–100%; 1× is the "fair" mid-point at 33%
  const barPct  = Math.min(ratio / 3 * 100, 100)
  const fairPct = 1 / 3 * 100  // 33.3% = 1.0× position
  const label   = ratio >= 1.5 ? 'expensive' : ratio >= 1.1 ? 'elevated' : ratio >= 0.9 ? 'fair' : 'cheap'

  return (
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`,
      borderTop: `2px solid ${T.gold}`,
      padding: '5px 8px', display: 'flex', flexDirection: 'column', gap: 2,
      minWidth: 0, overflow: 'hidden',
    }}>
      <span style={{ fontFamily: T.label, fontSize: 7, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>IV vs 30D HV</span>
      <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color, lineHeight: '1.15' }}>{ratio.toFixed(2)}×</span>
      {/* Gauge bar with fair-value marker */}
      <div style={{ position: 'relative', height: 4, background: T.border, borderRadius: 2 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: `${barPct}%`, background: color, borderRadius: 2, transition: 'width 0.3s' }} />
        {/* 1× fair-value notch */}
        <div style={{ position: 'absolute', top: -1, left: `${fairPct}%`, width: 1, height: 6, background: T.muted, borderRadius: 1 }} />
      </div>
      <span style={{ fontFamily: T.label, fontSize: 7, color: T.dim }}>
        {pct >= 0 ? '+' : ''}{pct}% vs HV · <span style={{ color }}>{label}</span>
      </span>
    </div>
  )
}

// ── Consensus tile (handles N/A gracefully) ───────────────────────────────────
function ConsensusTile({ consensus, analystCount, latestAction, priceTarget }: {
  consensus: string | null; analystCount: number | null
  latestAction: string | null; priceTarget: number | null
}) {
  const noData = !consensus
  const rating = consensus?.split('  ')[0] ?? null
  const source = consensus?.split('  ')[1] ?? null
  const accentColor = rating ? consensusColor(rating) : ACCENT.neutral

  return (
    <div style={{
      background: T.surface, border: `1px solid ${T.border}`,
      borderTop: `2px solid ${accentColor}`,
      padding: '5px 8px', display: 'flex', flexDirection: 'column', gap: 1,
      minHeight: 0, overflow: 'hidden',
    }}>
      <span style={{ fontFamily: T.label, fontSize: 7, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
        Consensus{analystCount ? ` · ${analystCount} analysts` : ''}
      </span>
      {noData ? (
        <>
          <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: T.muted, lineHeight: '1.15' }}>No Coverage</span>
          <span style={{ fontFamily: T.label, fontSize: 7, color: T.dim }}>No analyst ratings available</span>
        </>
      ) : (
        <>
          <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 700, color: consensusColor(rating!), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: '1.15' }}>
            {rating}
          </span>
          {source && <span style={{ fontFamily: T.label, fontSize: 7, color: T.dim, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{source}</span>}
          {(latestAction || priceTarget != null) && (
            <span style={{ fontFamily: T.label, fontSize: 7, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {latestAction}{priceTarget != null ? ` · PT $${priceTarget.toFixed(0)}` : ''}
            </span>
          )}
        </>
      )}
    </div>
  )
}

// ── Price Projection Cone ─────────────────────────────────────────────────────
function VolCone({ spot, atmIv, hv30, expiry }: {
  spot: number; atmIv: number | null; hv30: number | null; expiry: string | null
}) {
  const { data, yDomain, expiryLabel, xInterval } = useMemo(() => {
    if (!atmIv) return { data: [], yDomain: ['auto', 'auto'] as [string, string], expiryLabel: null, xInterval: 1 }
    const today    = Date.now()
    const expiryMs = expiry ? new Date(expiry).getTime() : today + 60 * 86400000
    const dteDays  = Math.max((expiryMs - today) / 86400000, 1)
    const horizonDays = Math.min(Math.max(dteDays * 1.5, 45), 180)
    const pts   = 40
    const r     = 0.045
    const sigIV = atmIv / 100
    const sigHV = hv30 != null ? hv30 / 100 : null

    const rows = Array.from({ length: pts + 1 }, (_, i) => {
      const T_days = (horizonDays * i) / pts
      const T_y    = T_days / 365.25
      const date   = new Date(today + T_days * 86400000)
      const label  = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      const dIV    = (r - 0.5 * sigIV ** 2) * T_y
      const sq     = Math.sqrt(T_y)
      const iv1up  = parseFloat((spot * Math.exp(dIV + sigIV * sq)).toFixed(2))
      const iv1dn  = parseFloat((spot * Math.exp(dIV - sigIV * sq)).toFixed(2))
      const expected = parseFloat((spot * Math.exp(dIV)).toFixed(2))
      let hv1up: number | undefined, hv1dn: number | undefined
      if (sigHV) {
        const dHV = (r - 0.5 * sigHV ** 2) * T_y
        hv1up = parseFloat((spot * Math.exp(dHV + sigHV * sq)).toFixed(2))
        hv1dn = parseFloat((spot * Math.exp(dHV - sigHV * sq)).toFixed(2))
      }
      return { label, T_days: Math.round(T_days), iv1up, expected, iv1dn, hv1up, hv1dn }
    })

    // Symmetric arithmetic spread around spot — keeps current price visually centered
    const horizT = horizonDays / 365.25
    const spread = spot * sigIV * Math.sqrt(horizT)
    const yMin   = Math.floor((spot - spread * 1.25) / 10) * 10
    const yMax   = Math.ceil((spot  + spread * 1.25) / 10) * 10

    const el = expiry
      ? new Date(expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : null

    // interval for XAxis: tickCount doesn't work on string categories — use interval instead
    // floor((n-1)/4) gives ~4-5 evenly-spaced labels regardless of data length
    const xInterval = Math.max(1, Math.floor((rows.length - 1) / 4))

    return { data: rows, yDomain: [yMin, yMax] as [number, number], expiryLabel: el, xInterval }
  }, [spot, atmIv, hv30, expiry])

  if (!atmIv || data.length === 0) return null

  const priceFmt = (v: number) => v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(0)}`

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CT = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null
    const d = payload[0]?.payload
    if (!d) return null
    return (
      <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '5px 8px', fontFamily: T.mono, fontSize: 9 }}>
        <div style={{ color: T.gold, fontWeight: 700, marginBottom: 3 }}>{label} · {d.T_days}d</div>
        <div style={{ color: T.gold }}>±1σ IV  {priceFmt(d.iv1dn)} – {priceFmt(d.iv1up)}</div>
        {d.hv1up != null && <div style={{ color: T.blue }}>±1σ HV  {priceFmt(d.hv1dn)} – {priceFmt(d.hv1up)}</div>}
        <div style={{ color: T.muted, marginTop: 2 }}>exp  {priceFmt(d.expected)}</div>
      </div>
    )
  }

  return (
    <>
      <div style={{ fontFamily: T.label, fontSize: 7, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.09em', display: 'flex', gap: 10, flexShrink: 0, paddingBottom: 3 }}>
        <span>Price Cone</span>
        <span style={{ color: T.gold }}>IV {atmIv.toFixed(1)}%</span>
        {hv30 && <span style={{ color: T.blue }}>HV {hv30.toFixed(1)}%</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(100,120,150,0.12)" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }} tickLine={false} axisLine={false} interval={xInterval} />
            <YAxis tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }} tickLine={false} axisLine={false}
              tickFormatter={priceFmt} width={38} domain={yDomain} tickCount={4} />
            <Tooltip content={<CT />} />
            <Area isAnimationActive={false} type="monotone" dataKey="iv1up" stroke="color-mix(in srgb, var(--theme-primary) 55%, transparent)" strokeWidth={1.5} fill="color-mix(in srgb, var(--theme-primary, #c9a84c) 20%, transparent)" dot={false} legendType="none" />
            <Area isAnimationActive={false} type="monotone" dataKey="iv1dn" stroke="color-mix(in srgb, var(--theme-primary) 55%, transparent)" strokeWidth={1.5} fill={T.bg} dot={false} legendType="none" />
            {hv30 != null && <>
              <Area isAnimationActive={false} type="monotone" dataKey="hv1up" stroke="rgba(96,165,250,0.4)" strokeWidth={1} strokeDasharray="3 2" fill="rgba(96,165,250,0.07)" dot={false} legendType="none" />
              <Area isAnimationActive={false} type="monotone" dataKey="hv1dn" stroke="rgba(96,165,250,0.4)" strokeWidth={1} strokeDasharray="3 2" fill={T.bg} dot={false} legendType="none" />
            </>}
            <Line isAnimationActive={false} type="monotone" dataKey="expected" stroke={T.gold} strokeWidth={1} strokeDasharray="4 3" dot={false} legendType="none" />
            <ReferenceLine y={spot} stroke="var(--theme-text-subtle, rgba(215,227,252,0.2))" strokeWidth={1} strokeDasharray="2 4" />
            {expiryLabel && (
              <ReferenceLine x={expiryLabel} stroke="color-mix(in srgb, var(--theme-primary, #c9a84c) 28%, transparent)" strokeWidth={1} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

// ── Probability Distribution ──────────────────────────────────────────────────
function ImpliedProb({ spot, atmIv, expiry }: { spot: number; atmIv: number; expiry: string | null }) {
  const { data, sd1lo, sd1hi, xDomain, xTicks } = useMemo(() => {
    const T_y = expiry
      ? Math.max((new Date(expiry).getTime() - Date.now()) / (365.25 * 86400000), 1 / 365.25)
      : 30 / 365
    const sigma = atmIv / 100
    const mu    = -0.5 * sigma * sigma * T_y
    const sigT  = sigma * Math.sqrt(T_y)
    const lo = spot * Math.exp(mu - 3.5 * sigT)
    const hi = spot * Math.exp(mu + 3.5 * sigT)
    const pts = 100
    const rows = Array.from({ length: pts }, (_, i) => {
      const x  = lo + (hi - lo) * i / (pts - 1)
      const lx = Math.log(x / spot)
      const p  = (1 / (x * sigT * Math.sqrt(2 * Math.PI))) * Math.exp(-((lx - mu) ** 2) / (2 * sigT ** 2))
      const inSd1 = Math.abs(lx - mu) <= sigT
      return { price: Math.round(x * 100) / 100, prob: p, sd1: inSd1 ? p : 0 }
    })
    const sd1lo = parseFloat((spot * Math.exp(mu - sigT)).toFixed(2))
    const sd1hi = parseFloat((spot * Math.exp(mu + sigT)).toFixed(2))
    // Make the visible domain symmetric around spot so the peak centres visually
    const halfRange = Math.max(spot - lo, hi - spot)
    const dMin = Math.round(spot - halfRange)
    const dMax = Math.round(spot + halfRange)
    const xDomain: [number, number] = [dMin, dMax]
    const xTicks = [dMin, Math.round(sd1lo), Math.round(spot), Math.round(sd1hi), dMax]
    return { data: rows, sd1lo, sd1hi, xDomain, xTicks }
  }, [spot, atmIv, expiry])

  return (
    <>
      <div style={{ fontFamily: T.label, fontSize: 7, color: T.muted, textTransform: 'uppercase', letterSpacing: '0.09em', flexShrink: 0, paddingBottom: 3 }}>
        Prob Distribution
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(100,120,150,0.12)" vertical={false} />
            <XAxis dataKey="price" type="number" domain={xDomain} ticks={xTicks} tick={{ fontSize: 8, fill: T.muted, fontFamily: T.mono }} tickLine={false} axisLine={false} tickFormatter={v => `$${Math.round(v as number)}`} />
            <YAxis hide />
            <Tooltip
              contentStyle={{ ...TOOLTIP_STYLE }}
              formatter={(val: number, name: string) => name === 'prob' ? [`${(val * 100).toFixed(3)}%`, 'density'] : [null, null]}
              labelFormatter={v => `$${Number(v).toFixed(2)}`}
            />
            {/* ±1σ shaded region */}
            <Area isAnimationActive={false} type="monotone" dataKey="sd1" stroke="none" fill="color-mix(in srgb, var(--theme-positive) 13%, transparent)" />
            <Area isAnimationActive={false} type="monotone" dataKey="prob" stroke={T.blue} strokeWidth={1.5} fill="rgba(96,165,250,0.07)" dot={false} />
            {/* Spot */}
            <ReferenceLine x={spot} stroke={T.gold} strokeWidth={1.5}
              label={{ value: `$${spot.toFixed(0)}`, position: 'insideTopRight', fontSize: 8, fill: T.gold, fontFamily: T.mono }} />
            {/* ±1σ bounds */}
            <ReferenceLine x={sd1lo} stroke="color-mix(in srgb, var(--theme-positive) 50%, transparent)" strokeWidth={1} strokeDasharray="3 3"
              label={{ value: '−1σ', position: 'insideBottomLeft', fontSize: 7, fill: 'color-mix(in srgb, var(--theme-positive) 70%, transparent)', fontFamily: T.mono }} />
            <ReferenceLine x={sd1hi} stroke="color-mix(in srgb, var(--theme-positive) 50%, transparent)" strokeWidth={1} strokeDasharray="3 3"
              label={{ value: '+1σ', position: 'insideBottomRight', fontSize: 7, fill: 'color-mix(in srgb, var(--theme-positive) 70%, transparent)', fontFamily: T.mono }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

// ── Main widget ───────────────────────────────────────────────────────────────
export default function OptionsSnapshot({ config }: { config: WidgetConfig }) {
  const ticker = config.ticker
  const visibleItems = (config.visibleItems ?? ALL_IDS) as ItemId[]
  const visible = new Set<ItemId>(visibleItems)
  const show = (id: ItemId) => visible.has(id)

  const tileIds: ItemId[] = ['atm_iv','implied_move','d50_call','d50_put','hv_30','iv_vs_hv','be_range','pc_vol','consensus']
  const visibleTileCount = tileIds.filter(id => visible.has(id)).length

  const { cols, gridRef } = useOptimalGrid(visibleTileCount, { minW: 95, minH: 48, targetAspect: 2.0, gap: 3, padding: 5 })

  const { data, isLoading, isError } = useQuery<SnapshotData>({
    queryKey: ['options-snapshot-v3', ticker],
    queryFn: () => axios.get(`/api/options/snapshot?ticker=${ticker}`).then(r => r.data),
    enabled: !!ticker,
    staleTime: 900_000,
  })

  const base: React.CSSProperties = {
    background: T.bg, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden',
  }

  if (!ticker) return (
    <div style={base}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: T.muted, fontFamily: T.label, fontSize: 11 }}>Configure ticker in edit mode.</span>
      </div>
    </div>
  )

  if (isLoading) return (
    <div style={base}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 3, padding: 5 }}>
        {Array.from({ length: visibleTileCount }).map((_, i) => <div key={i} style={{ ...shimmer, height: 52 }} />)}
      </div>
    </div>
  )

  if (isError || !data) return (
    <div style={base}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: T.muted, fontFamily: T.label, fontSize: 11 }}>Options data unavailable.</span>
      </div>
    </div>
  )

  // Break-even expiry label for context
  const expiryShort = data.expiry
    ? new Date(data.expiry).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null

  const showCharts = show('vol_cone') || show('impl_prob')
  const hasCone    = show('vol_cone') && data.atm_iv != null
  const hasProb    = show('impl_prob') && data.atm_iv != null

  return (
    <div style={base}>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* ── Row 1: Volatility/Pricing ── */}
      {/* ── Row 2: Risk Comparison     ── */}
      {/* ── Row 3: Market Structure    ── */}
      {visibleTileCount > 0 && (
        <div
          ref={gridRef}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridAutoRows: 'minmax(48px, auto)',
            gap: 3,
            padding: 5,
            flex: '0 0 auto',
          }}
        >
          {/* — Volatility & Pricing row — */}
          {show('atm_iv') && (
            <Tile
              label="ATM IV" accent={ACCENT.iv}
              value={fmt(data.atm_iv, '', '%')}
              sub="IV at-the-money"
              valueColor={data.atm_iv != null
                ? data.atm_iv > 60 ? T.neg : data.atm_iv > 35 ? T.warn : T.pos
                : undefined}
            />
          )}
          {show('implied_move') && (
            <Tile
              label="Implied Move" accent={ACCENT.move}
              value={data.implied_move != null ? `±${data.implied_move.toFixed(1)}%` : '—'}
              sub={data.straddle_px != null ? `straddle $${data.straddle_px.toFixed(2)}` : undefined}
            />
          )}
          {show('d50_call') && (
            <Tile
              label="D50 Call"
              value={fmt(data.d50_call, '$', '', 2)}
              sub={`call premium · K≈$${data.spot.toFixed(0)}`}
            />
          )}

          {/* — Risk Comparison row — */}
          {show('d50_put') && (
            <Tile
              label="D50 Put"
              value={fmt(data.d50_put, '$', '', 2)}
              sub={`put premium · K≈$${data.spot.toFixed(0)}`}
            />
          )}
          {show('hv_30') && (
            <Tile
              label="30D Hist Vol" accent={ACCENT.hv}
              value={fmt(data.hv_30, '', '%')}
              sub="30-day realized vol"
              valueColor={T.blue}
            />
          )}
          {show('iv_vs_hv') && (
            data.iv_vs_hv != null
              ? <IVPremiumTile ratio={data.iv_vs_hv} />
              : <Tile label="IV vs 30D HV" value="—" sub="Data unavailable" />
          )}

          {/* — Market Structure row — */}
          {show('be_range') && (
            <Tile
              label={expiryShort ? `Break-Even · ${expiryShort}` : 'Break-Even'}
              value={data.be_lower != null && data.be_upper != null
                ? `$${data.be_lower.toFixed(1)}–$${data.be_upper.toFixed(1)}` : '—'}
              sub={data.straddle_px != null ? `±$${data.straddle_px.toFixed(2)} from spot` : undefined}
              sub2="ATM straddle basis"
            />
          )}
          {show('pc_vol') && (
            <Tile
              label="P/C Volume"
              value={fmt(data.pc_vol, '', '', 2)}
              sub={data.pc_vol != null
                ? data.pc_vol > 1.2 ? 'put-heavy · bearish lean'
                : data.pc_vol < 0.8 ? 'call-heavy · bullish lean'
                : 'balanced'
                : undefined}
              valueColor={data.pc_vol != null
                ? data.pc_vol > 1.2 ? T.neg : data.pc_vol < 0.8 ? T.pos : T.text
                : undefined}
            />
          )}
          {show('consensus') && (
            <ConsensusTile
              consensus={data.consensus}
              analystCount={data.analyst_count}
              latestAction={data.latest_action}
              priceTarget={data.price_target}
            />
          )}
        </div>
      )}

      {/* ── Charts — grow to fill the cell (min 150px), visually separated ── */}
      {showCharts && (
        <div style={{
          borderTop: `1px solid ${T.border}`,
          display: 'flex',
          flex: 1,
          minHeight: 150,
          overflow: 'hidden',
          background: 'color-mix(in srgb, var(--theme-surface, #0d1826) 40%, var(--theme-bg, #101c2e))',
        }}>
          {hasCone && (
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: '5px 6px 5px 8px' }}>
              <VolCone spot={data.spot} atmIv={data.atm_iv} hv30={data.hv_30} expiry={data.expiry} />
            </div>
          )}
          {hasCone && hasProb && (
            <div style={{ width: 1, background: T.border, flexShrink: 0, alignSelf: 'stretch', margin: '6px 0' }} />
          )}
          {hasProb && data.atm_iv != null && (
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', padding: '5px 8px 5px 6px' }}>
              <ImpliedProb spot={data.spot} atmIv={data.atm_iv} expiry={data.expiry} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
