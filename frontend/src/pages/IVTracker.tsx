import { useState, useEffect, useCallback, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { Widget, KpiCell } from '../components/mmCockpit'
import {
  ComposedChart, Line, Area, XAxis, YAxis,
  Tooltip, CartesianGrid, ResponsiveContainer,
  ReferenceLine, Legend,
} from 'recharts'

// ── Design tokens — all values are CSS variables so every theme preset works ───
const T = {
  bg:      'var(--theme-bg)',
  surface: 'var(--theme-surface)',
  border:  'var(--theme-border)',
  gold:    'var(--theme-primary)',
  muted:   'var(--theme-secondary)',
  text:    'var(--theme-text)',
  dim:     'var(--theme-text-dim)',
  mono:    'var(--theme-mono)',
  pos:     'var(--theme-positive)',
  neg:     'var(--theme-negative)',
  warn:    'var(--theme-warn)',
  hover:   'var(--theme-hover)',
}

const PANEL: React.CSSProperties = {
  background: T.surface,
  border:     `1px solid ${T.border}`,
  padding:    '14px 16px',
}

const TICK = { fill: T.muted, fontSize: 9, fontFamily: T.mono }

const TOOLTIP_STYLE: React.CSSProperties = {
  background:   T.surface,
  border:       `1px solid var(--theme-border)`,
  borderRadius: 0,
  fontSize:     10,
  fontFamily:   T.mono,
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface TsPoint {
  date:        string
  stock_price: number
  iv:          number | null
  hv_30d:      number | null
  source:      string
}

interface Greeks {
  delta?: number
  gamma?: number
  theta?: number
  vega?:  number
  rho?:   number
}

interface IVData {
  ticker:          string
  expiry:          string
  option_type:     string
  strike:          number
  spot:            number
  implied_move:    number | null
  straddle:        number | null
  current_iv:      number
  bid:             number
  ask:             number
  mid:             number
  open_interest:   number
  volume:          number
  dte:             number
  current_hv_30d:  number | null
  iv_premium:      number | null
  risk_free_rate:  number
  iv_rank:         number | null
  iv_percentile:   number | null
  iv_min:          number | null
  iv_max:          number | null
  iv_mean:         number | null
  greeks:          Greeks
  time_series:     TsPoint[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function ivLabel(rank: number | null): string {
  if (rank === null) return '—'
  if (rank >= 75) return 'EXPENSIVE'
  if (rank >= 40) return 'FAIR'
  return 'CHEAP'
}

function ivLabelColor(rank: number | null): string {
  if (rank === null) return T.muted
  if (rank >= 75) return T.neg
  if (rank >= 40) return T.warn
  return T.pos
}

function fmtPct(v: number | null | undefined, decimals = 1): string {
  return v == null ? '—' : `${v.toFixed(decimals)}%`
}

function fmtNum(v: number | null | undefined, decimals = 2): string {
  return v == null ? '—' : v.toFixed(decimals)
}

// ── IV Rank / Percentile gauge ─────────────────────────────────────────────────
function IVGauge({
  value, label, title,
}: {
  value: number | null; label: string; title: string
}) {
  const pct    = Math.max(0, Math.min(100, value ?? 0))
  const color  = ivLabelColor(value)
  const W      = 160, H = 22
  const markerX = (pct / 100) * W

  return (
    <div style={{ ...PANEL, minWidth: 180, flex: '1 1 180px' }}>
      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em',
                    textTransform: 'uppercase', color: T.muted,
                    fontFamily: T.mono, marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 700, fontFamily: T.mono, color }}>
          {value == null ? '—' : value.toFixed(1)}
        </span>
        <span style={{ fontSize: 8, fontFamily: T.mono, color: T.muted }}>/ 100</span>
        <span style={{ fontSize: 9, fontWeight: 700, fontFamily: T.mono,
                       color, marginLeft: 4 }}>
          {label}
        </span>
      </div>
      {/* Three-zone bar — SVG fill via style prop so CSS variables resolve correctly */}
      <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
        {/* Zone fills */}
        <rect x={0}        y={6} width={W * 0.33} height={6} rx={1}
              style={{ fill: 'var(--theme-positive)' }} opacity={0.28} />
        <rect x={W * 0.33} y={6} width={W * 0.33} height={6} rx={1}
              style={{ fill: 'var(--theme-warn)' }}     opacity={0.28} />
        <rect x={W * 0.66} y={6} width={W * 0.34} height={6} rx={1}
              style={{ fill: 'var(--theme-negative)' }} opacity={0.28} />
        {/* Zone labels — full adaptive color for legibility on any theme */}
        <text x={W * 0.165} y={20} textAnchor="middle" fontSize={7} fontFamily={T.mono}
              style={{ fill: 'var(--theme-positive)' }} opacity={0.75}>CHEAP</text>
        <text x={W * 0.495} y={20} textAnchor="middle" fontSize={7} fontFamily={T.mono}
              style={{ fill: 'var(--theme-warn)' }}     opacity={0.75}>FAIR</text>
        <text x={W * 0.83}  y={20} textAnchor="middle" fontSize={7} fontFamily={T.mono}
              style={{ fill: 'var(--theme-negative)' }} opacity={0.75}>EXP</text>
        {/* Marker */}
        {value !== null && (
          <>
            <line x1={markerX} y1={3} x2={markerX} y2={15}
                  stroke={color} strokeWidth={1.5} />
            <circle cx={markerX} cy={9} r={3.5} fill={color} />
          </>
        )}
      </svg>
    </div>
  )
}

// ── Select ────────────────────────────────────────────────────────────────────
function FTSelect({
  value, onChange, options, placeholder, disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      style={{
        background:  T.surface,
        border:      `1px solid ${T.border}`,
        color:       value ? T.text : T.muted,
        fontFamily:  T.mono,
        fontSize:    11,
        padding:     '5px 10px',
        outline:     'none',
        cursor:      disabled ? 'not-allowed' : 'pointer',
        minWidth:    120,
      }}
    >
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  )
}

// ── Section label ─────────────────────────────────────────────────────────────
function SLabel({ label }: { label: string }) {
  return (
    <div style={{
      fontSize: 8, fontWeight: 700, letterSpacing: '0.16em',
      textTransform: 'uppercase', color: T.muted,
      fontFamily: T.mono, marginBottom: 8, marginTop: 4,
    }}>
      {label}
    </div>
  )
}

// ── Custom Tooltip ─────────────────────────────────────────────────────────────
function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null
  return (
    <div style={{ ...TOOLTIP_STYLE, padding: '8px 12px', minWidth: 160 }}>
      <div style={{ color: T.muted, marginBottom: 4, fontSize: 9 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ display: 'flex', justifyContent: 'space-between',
                                      gap: 16, color: p.color, fontSize: 10 }}>
          <span>{p.name}</span>
          <span style={{ fontWeight: 700 }}>{p.value != null ? `${p.value.toFixed(2)}${p.unit ?? ''}` : '—'}</span>
        </div>
      ))}
    </div>
  )
}

// ── Main Component ─────────────────────────────────────────────────────────────
export function IVTrackerContent() {
  const [ticker,     setTicker]     = useState('')
  const [tickerInput, setTickerInput] = useState('')
  const [expiry,     setExpiry]     = useState('')
  const [optType,    setOptType]    = useState<'call' | 'put'>('call')
  const [strike,     setStrike]     = useState('')
  const [days,       setDays]       = useState('90')
  const [loadKey,    setLoadKey]    = useState(0)   // bump to trigger fetch
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Debounce ticker input → validated ticker state
  const handleTickerInput = useCallback((v: string) => {
    setTickerInput(v.toUpperCase())
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const clean = v.trim().toUpperCase()
      if (clean.length >= 1) {
        setTicker(clean)
        setExpiry('')
        setStrike('')
      }
    }, 600)
  }, [])

  // Reset downstream when expiry changes
  useEffect(() => { setStrike('') }, [expiry])
  // Reset downstream when option type changes
  useEffect(() => { setStrike('') }, [optType])

  // ── API queries ─────────────────────────────────────────────────────────────
  const expQuery = useQuery<{ expirations: string[] }>({
    queryKey: ['iv-exps', ticker],
    queryFn:  () => axios.get(`/api/iv/expirations?ticker=${ticker}`).then(r => r.data),
    enabled:  ticker.length >= 1,
    staleTime: 5 * 60_000,
  })

  const strikeQuery = useQuery<{ strikes: number[]; atm_strike: number; spot: number }>({
    queryKey: ['iv-strikes', ticker, expiry, optType],
    queryFn:  () =>
      axios.get(`/api/iv/strikes?ticker=${ticker}&expiry=${expiry}&option_type=${optType}`)
           .then(r => r.data),
    enabled:  !!(ticker && expiry),
    staleTime: 2 * 60_000,
  })

  const ivQuery = useQuery<IVData>({
    queryKey: ['iv-history', ticker, expiry, optType, strike, days, loadKey],
    queryFn:  () =>
      axios.get('/api/iv/history', {
        params: { ticker, expiry, option_type: optType, strike, days },
      }).then(r => r.data),
    enabled:  !!(ticker && expiry && strike && loadKey > 0),
    staleTime: 0,
    retry:    1,
  })

  const canLoad = !!(ticker && expiry && strike)
  const data    = ivQuery.data
  const loading = ivQuery.isFetching

  // Auto-select ATM when strikes load
  useEffect(() => {
    if (strikeQuery.data?.atm_strike && !strike) {
      setStrike(String(strikeQuery.data.atm_strike))
    }
  }, [strikeQuery.data, strike])

  // ── Chart data preprocessing ──────────────────────────────────────────────
  const chartData = data?.time_series.map(p => ({
    ...p,
    // Show every 5th label to avoid crowding
    iv:    p.iv,
    hv30:  p.hv_30d,
    price: p.stock_price,
  })) ?? []

  const ivMean   = data?.iv_mean ?? null
  const ivRank   = data?.iv_rank ?? null
  const ivPct    = data?.iv_percentile ?? null
  const greeks   = data?.greeks ?? {}

  // Compute IV chart color segments: red above mean, green below
  const ivColor = ivRank == null ? T.gold
    : ivRank >= 75 ? T.neg
    : ivRank <= 25 ? T.pos
    : T.warn

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* ── Controls ── */}
        <div style={{ ...PANEL, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
          {/* Ticker */}
          <div>
            <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono,
                          marginBottom: 3, textTransform: 'uppercase',
                          letterSpacing: '0.1em' }}>
              Ticker
            </div>
            <input
              value={tickerInput}
              onChange={e => handleTickerInput(e.target.value)}
              placeholder="AAPL"
              style={{
                background: T.bg, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)',
                color: T.text, fontFamily: T.mono, fontSize: 12,
                padding: '5px 10px', outline: 'none', width: 90,
                textTransform: 'uppercase',
              }}
            />
          </div>

          {/* Expiry */}
          <div>
            <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono,
                          marginBottom: 3, textTransform: 'uppercase',
                          letterSpacing: '0.1em' }}>
              Expiry {expQuery.isFetching && <span style={{ color: T.gold }}>…</span>}
            </div>
            <FTSelect
              value={expiry}
              onChange={setExpiry}
              placeholder="Select expiry"
              disabled={!expQuery.data?.expirations?.length}
              options={(expQuery.data?.expirations ?? []).map(e => ({ value: e, label: e }))}
            />
          </div>

          {/* Type */}
          <div>
            <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono,
                          marginBottom: 3, textTransform: 'uppercase',
                          letterSpacing: '0.1em' }}>
              Type
            </div>
            <div style={{ display: 'flex' }}>
              {(['call', 'put'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setOptType(t)}
                  style={{
                    padding: '5px 14px', fontSize: 11, fontFamily: T.mono,
                    fontWeight: optType === t ? 700 : 400,
                    background:  optType === t
                      ? (t === 'call' ? 'color-mix(in srgb, var(--theme-positive) 15%, transparent)'
                                      : 'color-mix(in srgb, var(--theme-negative) 15%, transparent)')
                      : T.bg,
                    color: optType === t
                      ? (t === 'call' ? T.pos : T.neg)
                      : T.muted,
                    border: `1px solid ${T.border}`,
                    borderRight: t === 'call' ? 'none' : undefined,
                    cursor: 'pointer',
                  }}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {/* Strike */}
          <div>
            <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono,
                          marginBottom: 3, textTransform: 'uppercase',
                          letterSpacing: '0.1em' }}>
              Strike {strikeQuery.isFetching && <span style={{ color: T.gold }}>…</span>}
              {strikeQuery.data && (
                <span style={{ marginLeft: 4, color: T.muted }}>
                  (ATM {strikeQuery.data.atm_strike})
                </span>
              )}
            </div>
            <FTSelect
              value={strike}
              onChange={setStrike}
              placeholder="Select strike"
              disabled={!strikeQuery.data?.strikes?.length}
              options={(strikeQuery.data?.strikes ?? []).map(s => ({
                value: String(s),
                label: s === strikeQuery.data?.atm_strike ? `${s} (ATM)` : String(s),
              }))}
            />
          </div>

          {/* Days */}
          <div>
            <div style={{ fontSize: 8, color: T.muted, fontFamily: T.mono,
                          marginBottom: 3, textTransform: 'uppercase',
                          letterSpacing: '0.1em' }}>
              Lookback
            </div>
            <FTSelect
              value={days}
              onChange={setDays}
              options={[
                { value: '30',  label: '30 days'  },
                { value: '60',  label: '60 days'  },
                { value: '90',  label: '90 days'  },
                { value: '180', label: '180 days' },
                { value: '252', label: '1 year'   },
              ]}
            />
          </div>

          {/* Load button */}
          <button
            onClick={() => setLoadKey(k => k + 1)}
            disabled={!canLoad || loading}
            style={{
              padding: '6px 20px', fontSize: 10, fontWeight: 700,
              fontFamily: T.mono, letterSpacing: '0.1em',
              background: canLoad ? `${T.gold}22` : T.hover,
              color:      canLoad ? T.gold : T.muted,
              border:     `1px solid ${canLoad ? T.gold + '50' : T.border}`,
              cursor:     canLoad ? 'pointer' : 'not-allowed',
            }}
          >
            {loading ? 'LOADING…' : 'LOAD'}
          </button>

          {ivQuery.isError && (
            <span style={{ fontSize: 9, color: T.neg, fontFamily: T.mono }}>
              ! {(ivQuery.error as any)?.response?.data?.detail ?? 'Error loading data'}
            </span>
          )}
        </div>

        {/* ── Snapshot: current metrics ── */}
        {data && (
          <>
            <SLabel label={`${data.ticker} ${data.strike} ${data.option_type.toUpperCase()} · ${data.expiry} · ${data.dte}d to expiry`} />

            {/* Answer-first instrument strip: lead with the IV-rank verdict */}
            <div style={{ display: 'flex', alignItems: 'stretch', background: T.surface, border: `1px solid ${T.border}`, overflowX: 'auto' }}>
              <KpiCell grow minWidth={110} label="IV Rank" value={ivRank == null ? '—' : ivRank.toFixed(0)} color={ivLabelColor(ivRank)} valueSize={16} sub={ivRank == null ? undefined : ivLabel(ivRank)} subColor={ivLabelColor(ivRank)} />
              <KpiCell grow label="Current IV" value={`${data.current_iv.toFixed(1)}%`} color={ivColor} />
              <KpiCell grow label="HV 30d" value={fmtPct(data.current_hv_30d)} />
              <KpiCell grow label="IV Premium" value={data.iv_premium != null ? `${data.iv_premium >= 0 ? '+' : ''}${data.iv_premium.toFixed(1)}%` : '—'} color={data.iv_premium != null ? (data.iv_premium >= 0 ? T.neg : T.pos) : undefined} />
              <KpiCell grow label="Implied Move" value={data.implied_move != null ? `±${data.implied_move.toFixed(1)}%` : '—'} />
              <KpiCell grow label="Underlying" value={`$${data.spot.toFixed(2)}`} />
              <KpiCell grow label="Straddle" value={data.straddle != null ? `$${data.straddle.toFixed(2)}` : '—'} />
              <KpiCell grow label="Bid / Ask" value={`$${data.bid.toFixed(2)} / $${data.ask.toFixed(2)}`} />
              <KpiCell grow label="Vol / OI" value={`${data.volume.toLocaleString()} / ${data.open_interest.toLocaleString()}`} />
              <KpiCell grow label="IV Range" value={`${fmtPct(data.iv_min)}–${fmtPct(data.iv_max)}`} />
            </div>

            {/* IV Rank + IV Percentile gauges */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <IVGauge
                value={ivRank}
                label={ivLabel(ivRank)}
                title="IV Rank  (where IV sits in its historical range)"
              />
              <IVGauge
                value={ivPct}
                label={ivLabel(ivPct)}
                title="IV Percentile  (% of days with lower IV)"
              />
              <div style={{ ...PANEL, flex: '1 1 220px', fontSize: 9, fontFamily: T.mono, color: T.dim, lineHeight: 1.6 }}>
                <div style={{ fontWeight: 700, color: T.muted, marginBottom: 4, letterSpacing: '0.1em', textTransform: 'uppercase', fontSize: 8 }}>
                  Interpretation
                </div>
                <span style={{ color: T.pos }}>CHEAP</span>{' '}(rank &lt; 25) — premium selling less favorable, buying puts/calls relatively cheap.
                {' '}<span style={{ color: T.warn }}>FAIR</span>{' '}— neutral vol regime.
                {' '}<span style={{ color: T.neg }}>EXPENSIVE</span>{' '}(rank &gt; 75) — premium selling environment; covered calls and short spreads attractive.
              </div>
            </div>

            {/* ── Chart ── */}
            <Widget title={`IV vs HV vs Stock Price · ${days}-day window`} bodyStyle={{ padding: '12px 8px' }}>
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={chartData}
                               margin={{ top: 8, right: 55, left: 0, bottom: 0 }}>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--theme-border)"
                  />
                  <XAxis
                    dataKey="date"
                    tick={TICK}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={d => d.slice(5)}   // MM-DD
                    interval="preserveStartEnd"
                    minTickGap={40}
                  />
                  {/* Left axis: IV % */}
                  <YAxis
                    yAxisId="iv"
                    tick={TICK}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => `${v}%`}
                    width={42}
                    domain={['auto', 'auto']}
                  />
                  {/* Right axis: Stock Price */}
                  <YAxis
                    yAxisId="price"
                    orientation="right"
                    tick={TICK}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={v => `$${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0)}`}
                    width={52}
                    domain={['auto', 'auto']}
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend
                    wrapperStyle={{ fontSize: 9, fontFamily: T.mono,
                                    color: T.muted, paddingTop: 6 }}
                  />
                  {/* IV mean reference line */}
                  {ivMean != null && (
                    <ReferenceLine
                      yAxisId="iv"
                      y={ivMean}
                      stroke={T.muted}
                      strokeDasharray="5 3"
                      strokeOpacity={0.5}
                      label={{ value: `avg ${ivMean.toFixed(1)}%`,
                               fill: T.muted, fontSize: 8,
                               position: 'insideTopLeft',
                               fontFamily: T.mono }}
                    />
                  )}
                  {/* Stock price area (right axis) — drawn first so it sits behind */}
                  <Area
                    yAxisId="price"
                    dataKey="price"
                    name="Stock Price"
                    stroke="var(--theme-tertiary)"
                    fill="var(--theme-tertiary)"
                    strokeWidth={1.5}
                    strokeOpacity={0.7}
                    fillOpacity={0.07}
                    dot={false}
                    activeDot={{ r: 3, fill: 'var(--theme-tertiary)' }}
                    unit="$"
                    connectNulls
                  />
                  {/* HV 30d dashed line */}
                  <Line
                    yAxisId="iv"
                    dataKey="hv30"
                    name="HV 30d"
                    stroke={T.muted}
                    strokeWidth={1}
                    strokeDasharray="4 3"
                    dot={false}
                    unit="%"
                    connectNulls
                  />
                  {/* IV line — primary signal */}
                  <Line
                    yAxisId="iv"
                    dataKey="iv"
                    name="Implied Vol"
                    stroke={ivColor}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: ivColor }}
                    unit="%"
                    connectNulls
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </Widget>

            {/* ── Greeks ── */}
            {Object.keys(greeks).length > 0 && (
              <Widget title="Option Greeks (current)">
                <div style={{ display: 'flex', alignItems: 'stretch', overflowX: 'auto' }}>
                  <KpiCell grow label="Δ Delta" value={fmtNum(greeks.delta, 4)} />
                  <KpiCell grow label="Γ Gamma" value={fmtNum(greeks.gamma, 6)} />
                  <KpiCell grow label="Θ Theta" value={`$${fmtNum(greeks.theta, 4)}/d`} />
                  <KpiCell grow label="ν Vega" value={`$${fmtNum(greeks.vega, 4)}`} />
                  <KpiCell grow label="ρ Rho" value={`$${fmtNum(greeks.rho, 4)}`} />
                  <KpiCell grow label="Risk-Free Rate" value={fmtPct(data.risk_free_rate)} />
                </div>
              </Widget>
            )}

          </>
        )}

        {/* ── Empty state ── */}
        {!data && !loading && (
          <EmptyState title="Implied Volatility Tracker" hint="Enter a ticker, select an expiry and strike, then load its IV history."
            keys={['Enter']} kpis={['IV Rank', 'IV Percentile', 'ATM IV', 'Implied Move', 'Open Interest']}
            preview="chart" previewLabel="IV History" />
        )}

        {loading && (
          <div style={{ ...PANEL, padding: '30px', textAlign: 'center' }}>
            <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono,
                          letterSpacing: '0.2em' }}>
              FETCHING IV DATA…
            </div>
          </div>
        )}

      </div>
  )
}

export default function IVTracker() {
  return <PageWrapper title="IV Rank & Term Structure"><IVTrackerContent /></PageWrapper>
}
