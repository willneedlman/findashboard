import { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  Area, AreaChart, CartesianGrid, Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import Provenance from '../components/Provenance'
import { TOOLTIP_STYLE } from '../components/ChartTooltip'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, chartClip } from '../lib/reportCaptureRegistry'
import type { ClipDraft } from '../lib/reportCreator'
import { T } from '../lib/theme'

const TAB = 'Volatility Scanner'
const GOLD = T.gold
const BLUE = T.blue
const POS = T.pos
const NEG = T.neg
const TEXT = T.text
const SEC = T.muted
const FAINT = 'var(--theme-text-faint, #8099b0)'
const MONO = T.mono
const SANS = T.label
const BORDER = T.border
const PANEL = T.bg
const PANEL_ALT = T.surface

const lbl: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase',
  color: SEC, fontFamily: SANS, marginBottom: 5, display: 'block',
}
const inp: React.CSSProperties = {
  background: PANEL, border: `1px solid color-mix(in srgb, ${GOLD} 30%, transparent)`,
  color: TEXT, fontFamily: MONO, fontSize: 11, padding: '0 10px', height: 32,
  outline: 'none', boxSizing: 'border-box',
}
const metaText: React.CSSProperties = { fontFamily: SANS, fontSize: 10, color: SEC }

interface SmilePoint { moneyness: number; iv: number }
interface TermPoint {
  expiry: string; dte: number; atm_iv: number; rr_25: number; bf_25: number
  smile: SmilePoint[]; call_points: SmilePoint[]; put_points: SmilePoint[]
}
interface SkewData {
  ticker: string; spot: number; front_expiry: string
  atm_iv: number; rr_25: number; bf_25: number; ts_slope: number
  term_structure: TermPoint[]; front_smile: SmilePoint[]; read: string
}
interface IVHistoryPoint {
  date: string; stock_price: number; iv: number | null; hv_30d: number | null; source: string
}
interface Greeks { delta?: number; gamma?: number; theta?: number; vega?: number; rho?: number }
// Every field /api/iv/history returns — IV Rank surfaced all of these, so they all
// carry over rather than being quietly dropped in the merge.
interface IVHistory {
  ticker: string; expiry: string; option_type: string; strike: number; spot: number
  implied_move: number | null; straddle: number | null
  current_iv: number; bid: number; ask: number; mid: number
  open_interest: number; volume: number; dte: number
  current_hv_30d: number | null; iv_premium: number | null; risk_free_rate: number
  iv_rank: number | null; iv_percentile: number | null
  iv_min: number | null; iv_max: number | null; iv_mean: number | null
  greeks: Greeks
  time_series: IVHistoryPoint[]
}

/** One-sigma move over the contract's life — Vol Skew's implied-move readout. */
function expectedMove(ivPct: number, dte: number, spot: number) {
  const sigma = (ivPct / 100) * Math.sqrt(Math.max(dte, 0) / 365)
  const dollars = spot * sigma
  return { pct: sigma * 100, dollars, lo: spot - dollars, hi: spot + dollars }
}

const ivZone = (v: number | null) => (v == null ? '—' : v >= 67 ? 'EXPENSIVE' : v >= 34 ? 'FAIR' : 'CHEAP')
const ivZoneColor = (v: number | null) => (v == null ? SEC : v >= 67 ? NEG : v >= 34 ? T.warn : POS)

function IVRankVerdict({ value }: { value: number | null }) {
  const pct = Math.max(0, Math.min(100, value ?? 0))
  const color = ivZoneColor(value)
  return (
    <div className="vol-rank-cell">
      <div className="vol-kicker">IV rank · trailing 52 weeks</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontFamily: MONO, fontSize: 42, lineHeight: 0.95, letterSpacing: 'var(--theme-num-tracking, normal)', fontWeight: 700, color }}>{value == null ? '—' : value.toFixed(0)}</span>
        <span style={{ fontFamily: MONO, fontSize: 12, color: SEC }}>/ 100</span>
        {value != null && (
          <span style={{ fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', color, border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)`, padding: '4px 9px' }}>
            {ivZone(value)}
          </span>
        )}
      </div>
      <div className="vol-zone-gauge">
        <span style={{ background: `color-mix(in srgb, ${POS} 28%, transparent)` }} />
        <span style={{ background: `color-mix(in srgb, ${T.warn} 28%, transparent)` }} />
        <span style={{ background: `color-mix(in srgb, ${NEG} 28%, transparent)` }} />
        {value != null && <i style={{ left: `${pct}%`, background: color }}><b style={{ background: color }} /></i>}
      </div>
      <div className="vol-zone-labels"><span>Cheap</span><span>Fair</span><span>Expensive</span></div>
    </div>
  )
}

function VerdictMetric({ label, value, unit, caption, color }: { label: string; value: string; unit: string; caption: string; color: string }) {
  return (
    <div className="vol-verdict-metric">
      <div className="vol-kicker">{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, margin: '7px 0 8px' }}>
        <span style={{ fontFamily: MONO, fontSize: 22, lineHeight: 1, fontWeight: 700, color }}>{value}</span>
        <span style={metaText}>{unit}</span>
      </div>
      <p>{caption}</p>
    </div>
  )
}

function SectionStrip({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="vol-section-strip">
      <span>{title}</span>
      {children && <div className="vol-section-meta">{children}</div>}
    </div>
  )
}

function GroupStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="vol-group-stat">
      <span>{label}</span>
      <strong style={{ color: color ?? TEXT }}>{value}</strong>
    </div>
  )
}

function HistoryLegend({ label, color, pattern = 'solid' }: { label: string; color: string; pattern?: 'solid' | 'dashed' | 'dotted' }) {
  return (
    <span className="vol-history-legend">
      <i aria-hidden="true" style={{ borderTopColor: color, borderTopStyle: pattern === 'solid' ? 'solid' : pattern }} />
      <span>{label}</span>
    </span>
  )
}

function MiniSparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="vol-mini-sparkline" />
  return (
    <div className="vol-mini-sparkline">
      <LineChart width={150} height={34} data={values.map((value, index) => ({ index, value }))} margin={{ top: 2, right: 1, bottom: 2, left: 1 }}>
        <Line type="monotone" dataKey="value" stroke={T.chartNeutral} strokeWidth={1.2} dot={false} isAnimationActive={false} />
      </LineChart>
    </div>
  )
}

type Side = 'composite' | 'call' | 'put'
const SIDES: { key: Side; label: string }[] = [
  { key: 'composite', label: 'Composite' },
  { key: 'call', label: 'Call' },
  { key: 'put', label: 'Put' },
]

// Heatmap columns. The fitted smile arrives as 60 points across +/-15% moneyness;
// 13 buckets is what reads as a grid without becoming a wall of cells.
const BUCKETS = Array.from({ length: 13 }, (_, i) => -15 + i * 2.5)

/** Nearest sampled IV to a target moneyness, or null when that side has no quote there. */
function ivAt(points: SmilePoint[], moneyness: number, tolerance = 3): number | null {
  let best: SmilePoint | null = null
  let bestGap = Infinity
  for (const p of points) {
    const gap = Math.abs(p.moneyness - moneyness)
    if (gap < bestGap) { bestGap = gap; best = p }
  }
  return best && bestGap <= tolerance ? best.iv : null
}

function pointsFor(t: TermPoint, side: Side): SmilePoint[] {
  return side === 'call' ? t.call_points : side === 'put' ? t.put_points : t.smile
}

/**
 * Robust IV range for the colour scale, always taken from the COMPOSITE fit.
 *
 * Deep-ITM quotes are wide and stale — AAPL's -17% call printed 105% IV against a
 * 26% ATM — so letting the per-side raw points set the scale would wash the whole
 * heatmap into one colour. Percentile-clipped for the same reason.
 */
function ivScale(term: TermPoint[]): [number, number] {
  const all = term.flatMap(t => t.smile.map(p => p.iv)).filter(Number.isFinite).sort((a, b) => a - b)
  if (!all.length) return [0, 1]
  const lo = all[Math.floor(all.length * 0.02)]
  const hi = all[Math.floor(all.length * 0.98)]
  return hi > lo ? [lo, hi] : [lo, lo + 1]
}

function cellColor(iv: number | null, [lo, hi]: [number, number]): string {
  if (iv == null || !Number.isFinite(iv)) return 'transparent'
  const t = Math.max(0, Math.min(1, (iv - lo) / (hi - lo)))
  const intensity = Math.round((0.08 + 0.40 * t) * 100)
  return `color-mix(in srgb, ${GOLD} ${intensity}%, var(--theme-bg))`
}

function skewCaption(value: number) {
  if (value > 5) return `Puts price ${Math.abs(value).toFixed(1)} points above calls. Downside protection carries the premium.`
  if (value < -5) return `Calls price ${Math.abs(value).toFixed(1)} points above puts. Upside demand carries the premium.`
  return `Calls and puts are within ${Math.abs(value).toFixed(1)} points. Directional premium is limited.`
}

function termCaption(value: number) {
  if (value > 0.5) return 'Long-dated vol prices above the front. The curve is in normal contango.'
  if (value < -0.5) return 'Front vol prices above the back. The curve points to near-term event stress.'
  return 'Volatility is nearly flat across expiries. No single tenor dominates the curve.'
}

function premiumCaption(value: number | null, rank: number | null) {
  if (value == null) return 'Realized volatility history is not available for this contract yet.'
  const tension = rank != null && rank >= 67 && value < 0
    ? ' Rich against its own range, but still below delivered volatility.'
    : ''
  if (value < 0) return `Implied volatility is ${Math.abs(value).toFixed(1)} points below realized.${tension}`
  if (value > 0) return `Implied volatility is ${value.toFixed(1)} points above realized. Options carry a delivered-vol premium.`
  return 'Implied and realized volatility are aligned. The market prices what the stock delivered.'
}

function thetaCaption(theta: number | undefined, mid: number) {
  if (theta == null || mid <= 0) return 'Daily decay is unavailable for this contract.'
  const pct = Math.abs(theta) / mid * 100
  return `Theta of ${Math.abs(theta).toFixed(3)} against a $${mid.toFixed(2)} mid. The contract loses about ${pct.toFixed(0)}% of its value per day if nothing moves.`
}

function paddedDomain(values: Array<number | null | undefined>, minimumSpan = 6): [number, number] {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v))
  if (!finite.length) return [0, minimumSpan]
  const lo = Math.min(...finite)
  const hi = Math.max(...finite)
  const span = Math.max(hi - lo, minimumSpan)
  const pad = span * 0.14
  return [Math.max(0, Math.floor(lo - pad)), Math.ceil(hi + pad)]
}

export function VolatilityScannerContent() {
  const [draft, setDraft] = useState('AAPL')
  const [ticker, setTicker] = useState('')
  const [side, setSide] = useState<Side>('composite')
  const [expiryIdx, setExpiryIdx] = useState(0)
  const [moneyness, setMoneyness] = useState(0)
  const [strikeDraft, setStrikeDraft] = useState('')
  const [strikeValue, setStrikeValue] = useState<number | null>(null)
  const [strikeEditing, setStrikeEditing] = useState(false)
  const [days, setDays] = useState(180)

  // One FETCH loads one chain snapshot; every panel below is a slice of it. The
  // rank query is chained (it needs the front expiry) but is not a per-view load.
  const surfaceQ = useMutation<SkewData>({
    mutationFn: async () => (await axios.get(`/api/prob/skew?ticker=${encodeURIComponent(ticker)}`)).data,
  })
  const { mutate: loadSurface, data, isPending, isError, error } = surfaceQ
  const errMsg = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail

  useEffect(() => { if (ticker) loadSurface() }, [ticker, loadSurface])

  const term = data?.term_structure ?? []
  const selected = term[Math.min(expiryIdx, Math.max(0, term.length - 1))]

  useEffect(() => {
    if (!data?.ticker) return
    setExpiryIdx(0)
    setMoneyness(0)
    setStrikeDraft('')
    setStrikeValue(null)
  }, [data?.ticker])

  // IV rank + the IV-vs-HV history, for the selected expiry's ATM contract. This is
  // IVTracker's source, reused unchanged — no new options vendor.
  const strikeParam = strikeValue ?? data?.spot
  const rankQ = useQuery<IVHistory>({
    queryKey: ['vol-rank', data?.ticker, selected?.expiry, side === 'put' ? 'put' : 'call', strikeParam, days],
    queryFn: () => axios.get('/api/iv/history', {
      params: {
        ticker: data!.ticker, expiry: selected!.expiry,
        option_type: side === 'put' ? 'put' : 'call', strike: strikeParam, days,
      },
    }).then(r => r.data),
    enabled: !!data && !!selected && !!strikeParam,
    retry: false,
    staleTime: 300_000,
  })
  const rank = rankQ.data?.iv_rank ?? null
  const limitedHistory = !!data && !rankQ.isLoading && (rankQ.isError || rank == null)

  const scale = useMemo(() => ivScale(term), [term])

  // Term structure at the SELECTED moneyness — this is what makes picking a strike
  // on the surface redraw the term view, rather than it always showing ATM.
  const termSeries = useMemo(() => term.map(t => ({
    expiry: t.expiry, dte: t.dte,
    iv: ivAt(pointsFor(t, side), moneyness),
    atm: t.atm_iv,
  })), [term, side, moneyness])

  const smileSeries = useMemo(
    () => (selected && data
      ? pointsFor(selected, side)
        .filter(p => Math.abs(p.moneyness) <= 25)
        .map(point => ({ ...point, strike: data.spot * (1 + point.moneyness / 100) }))
      : []),
    [selected, side, data],
  )

  const histSeries = useMemo(
    () => (rankQ.data?.time_series ?? []).filter(p => p.iv != null || p.hv_30d != null),
    [rankQ.data],
  )
  const stockSpark = useMemo(
    () => histSeries.map(point => point.stock_price).filter(Number.isFinite).slice(-60),
    [histSeries],
  )
  const dayChange = stockSpark.length > 1 ? (stockSpark[stockSpark.length - 1] / stockSpark[stockSpark.length - 2] - 1) * 100 : null
  const termDomain = useMemo(() => paddedDomain(termSeries.map(point => point.iv), 6), [termSeries])
  const skewDomain = useMemo(() => paddedDomain(smileSeries.map(point => point.iv), 10), [smileSeries])

  useEffect(() => {
    if (!strikeEditing && !rankQ.isFetching && rankQ.data?.strike != null) setStrikeDraft(String(rankQ.data.strike))
  }, [rankQ.data?.strike, rankQ.isFetching, strikeEditing])

  useReportCapture(() => {
    if (!data || !selected) return null
    const pieces: ClipDraft[] = [
      kpiClip(TAB, `Volatility Scanner · ${data.ticker} ${selected.expiry}`, [
        { label: 'IV Rank', value: rank != null ? `${rank.toFixed(0)}%` : 'limited history' },
        { label: 'IV Percentile', value: rankQ.data?.iv_percentile != null ? `${rankQ.data.iv_percentile.toFixed(0)}%` : '—' },
        { label: 'ATM IV', value: `${selected.atm_iv.toFixed(1)}%` },
        { label: 'Realized 30d', value: rankQ.data?.current_hv_30d != null ? `${rankQ.data.current_hv_30d.toFixed(1)}%` : '—' },
        { label: 'IV Premium', value: rankQ.data?.iv_premium != null ? `${rankQ.data.iv_premium > 0 ? '+' : ''}${rankQ.data.iv_premium.toFixed(1)}%` : '—' },
        { label: '25D RR', value: `${selected.rr_25 > 0 ? '+' : ''}${selected.rr_25.toFixed(1)}` },
        { label: '25D Fly', value: `${selected.bf_25.toFixed(1)}` },
        { label: 'Term slope', value: `${data.ts_slope > 0 ? '+' : ''}${data.ts_slope.toFixed(1)}` },
        { label: 'Implied move', value: `±${expectedMove(selected.atm_iv, selected.dte, data.spot).pct.toFixed(1)}%` },
      ]),
    ]
    if (rankQ.data) {
      const d = rankQ.data
      const g = d.greeks ?? {}
      pieces.push(kpiClip(TAB, `${data.ticker} ${d.strike} ${d.option_type} · ${d.expiry}`, [
        { label: 'Mid', value: d.mid > 0 ? `$${d.mid.toFixed(2)}` : '—' },
        { label: 'Bid / Ask', value: `${d.bid.toFixed(2)} / ${d.ask.toFixed(2)}` },
        { label: 'Vol / OI', value: `${d.volume.toLocaleString()} / ${d.open_interest.toLocaleString()}` },
        { label: 'IV range', value: d.iv_min != null && d.iv_max != null ? `${d.iv_min.toFixed(1)}% – ${d.iv_max.toFixed(1)}%` : '—' },
        { label: 'Delta', value: g.delta != null ? g.delta.toFixed(3) : '—' },
        { label: 'Gamma', value: g.gamma != null ? g.gamma.toFixed(4) : '—' },
        { label: 'Theta', value: g.theta != null ? g.theta.toFixed(3) : '—' },
        { label: 'Vega', value: g.vega != null ? g.vega.toFixed(3) : '—' },
        { label: 'Rho', value: g.rho != null ? g.rho.toFixed(3) : '—' },
      ]))
    }
    const termRows = termSeries.filter(r => r.iv != null)
    if (termRows.length) {
      pieces.push(chartClip(
        TAB, `${data.ticker} term structure at ${moneyness.toFixed(1)}% moneyness`,
        'line', 'expiry',
        termRows.map(r => ({ expiry: r.expiry, iv: r.iv as number, atm: r.atm })),
        [{ key: 'iv', label: `IV at ${moneyness.toFixed(1)}%` }, { key: 'atm', label: 'ATM IV' }],
      ))
    }
    if (smileSeries.length) {
      pieces.push(chartClip(
        TAB, `${data.ticker} ${selected.expiry} skew (${side})`,
        'area', 'moneyness',
        smileSeries.map(p => ({ moneyness: `${p.moneyness.toFixed(1)}%`, iv: p.iv })),
        [{ key: 'iv', label: 'Implied volatility' }],
      ))
    }
    return pieces
  })

  const submit = () => {
    const sym = draft.trim().toUpperCase()
    if (!sym) return
    if (sym === ticker) loadSurface()
    else setTicker(sym)
  }

  const commitStrike = () => {
    const value = Number(strikeDraft)
    setStrikeEditing(false)
    setStrikeValue(Number.isFinite(value) && value > 0 ? value : null)
  }

  return (
    <div className="vol-scanner-frame">
      <div className="vol-instrument-bar">
        <div className="vol-instrument-identity">
          <div>
            <strong>{data?.ticker ?? (draft.trim().toUpperCase() || 'AAPL')}</strong>
            <span>{data ? 'Options surface' : 'Load an optionable ticker'}</span>
          </div>
          {data && (
            <div className="vol-spot-block">
              <strong>${data.spot.toFixed(2)}</strong>
              <span style={{ color: dayChange == null ? SEC : dayChange >= 0 ? POS : NEG }}>
                {dayChange == null ? 'live spot' : `${dayChange >= 0 ? '+' : ''}${dayChange.toFixed(2)}% latest`}
              </span>
            </div>
          )}
          <MiniSparkline values={stockSpark} />
        </div>
        <div className="vol-instrument-controls">
          <div>
            <label style={lbl}>Side</label>
            <div className="vol-side-toggle">
              {SIDES.map(s => (
                <button key={s.key} type="button" onClick={() => setSide(s.key)} aria-pressed={side === s.key}
                  title={s.key === 'composite' ? 'Fitted out-of-the-money smile using the tighter side of the market' : `Raw ${s.key} quotes across listed strikes`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={lbl} htmlFor="vol-ticker">Ticker</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input id="vol-ticker" value={draft} onChange={e => setDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()}
                placeholder="AAPL" style={{ ...inp, width: 110, textTransform: 'uppercase' }} />
              <button className="vol-fetch" onClick={submit} disabled={isPending}>{isPending ? 'Loading' : 'Fetch'}</button>
            </div>
          </div>
        </div>
        {isError && <div className="vol-inline-status" style={{ color: NEG }}>{errMsg ?? 'No options data for this ticker. Try another symbol.'}</div>}
        {limitedHistory && <div className="vol-inline-status">Limited IV history. The live surface and cross-sections are still available.</div>}
      </div>

      {!data && !isPending && (
        <div className="vol-empty-band">
          <EmptyState title="Volatility Scanner" hint="Enter a ticker and press Fetch. One chain load drives the surface, term structure, skew, and contract evidence." />
        </div>
      )}
      {isPending && !data && (
        <div className="vol-loading-ladder" aria-label="Loading volatility surface">
          <div /><div /><div /><div /><div />
        </div>
      )}

      {data && selected && (
        <>
          <div className="vol-verdict-row">
            <IVRankVerdict value={rank} />
            <div className="vol-verdict-grid">
              <VerdictMetric label="Skew · 25 delta" value={`${selected.rr_25 >= 0 ? '+' : ''}${selected.rr_25.toFixed(1)}`} unit="vol pts"
                caption={skewCaption(selected.rr_25)} color={Math.abs(selected.rr_25) > 5 ? NEG : GOLD} />
              <VerdictMetric label="Term slope" value={`${data.ts_slope >= 0 ? '+' : ''}${data.ts_slope.toFixed(1)}`} unit={data.ts_slope > 0.5 ? 'contango' : data.ts_slope < -0.5 ? 'backwardation' : 'flat'}
                caption={termCaption(data.ts_slope)} color={data.ts_slope < -0.5 ? NEG : POS} />
              <VerdictMetric label="Implied less realized" value={rankQ.data?.iv_premium == null ? '—' : `${rankQ.data.iv_premium >= 0 ? '+' : ''}${rankQ.data.iv_premium.toFixed(1)}`}
                unit={rankQ.data?.current_hv_30d == null ? 'history limited' : `${rankQ.data.current_iv.toFixed(1)} vs ${rankQ.data.current_hv_30d.toFixed(1)}`}
                caption={premiumCaption(rankQ.data?.iv_premium ?? null, rank)} color={(rankQ.data?.iv_premium ?? 0) > 0 ? NEG : POS} />
            </div>
          </div>

          <section className="vol-band">
            <SectionStrip title="Implied volatility surface">
              <span>Click a row for its skew, a column for its term structure</span>
              <i />
              <span>{scale[0].toFixed(0)}%</span>
              <span className="vol-surface-swatch" style={{ background: `linear-gradient(90deg, ${cellColor(scale[0], scale)}, ${cellColor(scale[1], scale)})` }} />
              <span>{scale[1].toFixed(0)}% IV</span>
            </SectionStrip>
            <div className="vol-surface-scroll">
              <div className="vol-surface-grid">
                <div className="vol-surface-header vol-expiry-head">Expiry</div>
                {BUCKETS.map(bucket => (
                  <button key={bucket} className="vol-surface-header" aria-pressed={Math.abs(moneyness - bucket) < 0.01} onClick={() => setMoneyness(bucket)}>
                    {bucket > 0 ? '+' : ''}{bucket}%
                  </button>
                ))}
                <div className="vol-surface-header vol-atm-head">ATM IV</div>
                {term.map((point, rowIndex) => {
                  const rowSelected = rowIndex === Math.min(expiryIdx, term.length - 1)
                  const points = pointsFor(point, side)
                  return (
                    <div key={point.expiry} style={{ display: 'contents' }}>
                      <button className="vol-expiry-cell" aria-pressed={rowSelected} onClick={() => setExpiryIdx(rowIndex)}>
                        <span>{point.expiry}</span><b>{point.dte}d</b>
                      </button>
                      {BUCKETS.map(bucket => {
                        const iv = ivAt(points, bucket)
                        const columnSelected = Math.abs(moneyness - bucket) < 0.01
                        const cellDescription = iv == null
                          ? `${point.expiry}, ${bucket}% moneyness, no quote`
                          : `${point.expiry}, ${bucket}% moneyness, ${iv.toFixed(1)}% IV, strike $${(data.spot * (1 + bucket / 100)).toFixed(0)}`
                        return (
                          <button key={bucket} className="vol-heat-cell" onClick={() => { setExpiryIdx(rowIndex); setMoneyness(bucket) }}
                            aria-label={cellDescription} aria-pressed={rowSelected && columnSelected} title={cellDescription}
                            style={{ background: cellColor(iv, scale), color: iv == null ? FAINT : TEXT, outline: rowSelected || columnSelected ? `1px solid color-mix(in srgb, ${GOLD} 60%, transparent)` : 'none' }}>
                            {iv == null ? '·' : iv.toFixed(0)}
                          </button>
                        )
                      })}
                      <button className="vol-atm-cell" aria-label={`${point.expiry}, ATM implied volatility ${point.atm_iv.toFixed(1)}%`} aria-pressed={rowSelected} onClick={() => setExpiryIdx(rowIndex)}>{point.atm_iv.toFixed(1)}%</button>
                    </div>
                  )
                })}
              </div>
              {side !== 'composite' && <div className="vol-surface-note">Raw {side} quotes can be noisier in the in-the-money wing. The scale stays anchored to the composite fit.</div>}
            </div>
          </section>

          <div className="vol-chart-grid">
            <section className="vol-band">
              <SectionStrip title="Term structure"><span>IV by expiry at {moneyness > 0 ? '+' : ''}{moneyness}% moneyness</span></SectionStrip>
              <div className="vol-chart-body">
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart data={termSeries} margin={{ top: 12, right: 16, bottom: 8, left: 0 }}>
                    <defs><linearGradient id="vol-term-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={GOLD} stopOpacity={0.2} /><stop offset="100%" stopColor={GOLD} stopOpacity={0.01} /></linearGradient></defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="expiry" tick={{ fontFamily: MONO, fontSize: 11, fill: SEC }} tickLine={false} axisLine={false}
                      tickFormatter={(value: string) => `${term.find(point => point.expiry === value)?.dte ?? ''}d`} interval="preserveStartEnd" />
                    <YAxis domain={termDomain} tick={{ fontFamily: MONO, fontSize: 11, fill: SEC }} tickLine={false} axisLine={false} width={48} tickFormatter={(value: number) => `${value.toFixed(0)}%`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(value: string) => {
                      const point = term.find(item => item.expiry === value)
                      return point ? `${point.expiry}, ${point.dte} DTE` : value
                    }} formatter={(value: number) => [`${value.toFixed(1)}%`, 'IV']} />
                    <ReferenceLine x={selected.expiry} stroke={GOLD} strokeDasharray="2 3" />
                    <Area type="monotone" dataKey="iv" stroke={GOLD} strokeWidth={2.2} fill="url(#vol-term-fill)" connectNulls isAnimationActive={false}
                      dot={{ r: 2.6, fill: PANEL, stroke: GOLD, strokeWidth: 1.4 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
            <section className="vol-band">
              <SectionStrip title="Skew"><span>{selected.expiry} · {selected.dte}d · {side === 'composite' ? 'fitted OTM smile' : `raw ${side} quotes`}</span></SectionStrip>
              <div className="vol-chart-body">
                <ResponsiveContainer width="100%" height={320}>
                  <AreaChart data={smileSeries} margin={{ top: 12, right: 16, bottom: 8, left: 0 }}>
                    <defs><linearGradient id="vol-smile-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={GOLD} stopOpacity={0.26} /><stop offset="100%" stopColor={GOLD} stopOpacity={0.02} /></linearGradient></defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="moneyness" type="number" domain={[-15, 15]} ticks={[-15, -10, -5, 0, 5, 10, 15]} tick={{ fontFamily: MONO, fontSize: 11, fill: SEC }} tickLine={false} axisLine={false} tickFormatter={(value: number) => `${value > 0 ? '+' : ''}${value}%`} />
                    <YAxis domain={skewDomain} tick={{ fontFamily: MONO, fontSize: 11, fill: SEC }} tickLine={false} axisLine={false} width={48} tickFormatter={(value: number) => `${value.toFixed(0)}%`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} labelFormatter={(value: number) => {
                      const point = smileSeries.find(item => Math.abs(item.moneyness - Number(value)) < 0.001)
                      return `${value > 0 ? '+' : ''}${Number(value).toFixed(1)}% moneyness${point ? ` · $${point.strike.toFixed(2)} strike` : ''}`
                    }} formatter={(value: number) => [`${value.toFixed(1)}%`, 'IV']} />
                    <ReferenceLine x={0} stroke={SEC} strokeDasharray="3 3" label={{ value: 'spot', position: 'insideTopRight', fill: FAINT, fontSize: 10, fontFamily: MONO }} />
                    {Math.abs(moneyness) > 0.01 && <ReferenceLine x={moneyness} stroke={GOLD} strokeDasharray="2 3" />}
                    <Area type="monotone" dataKey="iv" stroke={GOLD} strokeWidth={2.2} fill="url(#vol-smile-fill)" dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </section>
          </div>

          <section className="vol-band">
            <SectionStrip title={`Contract · ${data.ticker} ${rankQ.data?.strike ?? data.spot.toFixed(0)} ${(rankQ.data?.option_type ?? (side === 'put' ? 'put' : 'call')).toUpperCase()} · ${selected.expiry} · ${selected.dte} DTE`}>
              <label htmlFor="vs-strike">Strike</label>
              <input id="vs-strike" type="number" step="1" value={strikeDraft} onFocus={() => setStrikeEditing(true)} onChange={event => { setStrikeEditing(true); setStrikeDraft(event.target.value) }} onBlur={commitStrike}
                onKeyDown={event => event.key === 'Enter' && commitStrike()} placeholder={data.spot.toFixed(0)} title="Blank uses at the money. Values snap to the nearest listed strike." style={{ ...inp, width: 84, height: 28 }} />
              <label htmlFor="vs-days">Lookback</label>
              <select id="vs-days" value={days} onChange={event => setDays(Number(event.target.value))} style={{ ...inp, width: 96, height: 28, cursor: 'pointer' }}>
                {[90, 180, 365].map(value => <option key={value} value={value}>{value} days</option>)}
              </select>
            </SectionStrip>
            {rankQ.isLoading && <div className="vol-contract-state">Loading contract evidence</div>}
            {rankQ.isError && <div className="vol-contract-state">No chain data for this contract. Choose another strike or expiry.</div>}
            {rankQ.data && (() => {
              const detail = rankQ.data
              const greeks = detail.greeks ?? {}
              const move = expectedMove(detail.current_iv, detail.dte, detail.spot)
              const spread = detail.ask > 0 && detail.bid > 0 ? detail.ask - detail.bid : null
              const maxRange = Math.max(detail.iv_max ?? detail.current_iv, detail.current_iv) * 1.08
              const rangeLeft = Math.max(0, Math.min(100, ((detail.iv_min ?? 0) / maxRange) * 100))
              const rangeMarker = Math.max(0, Math.min(100, (detail.current_iv / maxRange) * 100))
              return (
                <div className="vol-contract-grid">
                  <div className="vol-contract-group">
                    <div className="vol-group-title">Pricing</div>
                    <div className="vol-contract-hero"><strong style={{ color: GOLD }}>{detail.mid > 0 ? `$${detail.mid.toFixed(2)}` : '—'}</strong><span>mid · ${detail.bid.toFixed(2)} / ${detail.ask.toFixed(2)}</span></div>
                    <div className="vol-group-grid">
                      <GroupStat label="Straddle" value={detail.straddle == null ? '—' : `$${detail.straddle.toFixed(2)}`} />
                      <GroupStat label="Spread" value={spread == null ? '—' : `$${spread.toFixed(2)}`} />
                      <GroupStat label="Volume" value={detail.volume.toLocaleString()} />
                      <GroupStat label="Open interest" value={detail.open_interest.toLocaleString()} />
                      <GroupStat label="Spot" value={`$${detail.spot.toFixed(2)}`} />
                      <GroupStat label="Risk free" value={`${detail.risk_free_rate.toFixed(2)}%`} />
                    </div>
                  </div>
                  <div className="vol-contract-group">
                    <div className="vol-group-title">Volatility</div>
                    <div className="vol-contract-hero"><strong style={{ color: GOLD }}>{detail.current_iv.toFixed(1)}%</strong><span>implied · {detail.current_hv_30d == null ? 'realized unavailable' : `${detail.current_hv_30d.toFixed(1)}% realized 30d`}</span></div>
                    <div className="vol-range-row"><div className="vol-range-track"><span style={{ left: `${rangeLeft}%` }} /><i style={{ left: `${rangeMarker}%` }} /></div><span>{detail.iv_min?.toFixed(1) ?? '—'} to {detail.iv_max?.toFixed(1) ?? '—'} · mean {detail.iv_mean?.toFixed(1) ?? '—'}</span></div>
                    <div className="vol-group-grid">
                      <GroupStat label="IV premium" value={detail.iv_premium == null ? '—' : `${detail.iv_premium >= 0 ? '+' : ''}${detail.iv_premium.toFixed(1)}%`} color={(detail.iv_premium ?? 0) > 0 ? NEG : POS} />
                      <GroupStat label="IV percentile" value={detail.iv_percentile == null ? '—' : detail.iv_percentile.toFixed(1)} color={(detail.iv_percentile ?? 0) >= 67 ? NEG : TEXT} />
                      <GroupStat label="Implied move" value={`±${(detail.implied_move ?? move.pct).toFixed(1)}%`} color={GOLD} />
                      <GroupStat label="1 sigma range" value={`$${move.lo.toFixed(0)} to $${move.hi.toFixed(0)}`} />
                      <GroupStat label="25D RR" value={`${selected.rr_25 >= 0 ? '+' : ''}${selected.rr_25.toFixed(1)}`} color={Math.abs(selected.rr_25) > 5 ? NEG : TEXT} />
                      <GroupStat label="25D fly" value={selected.bf_25.toFixed(1)} />
                    </div>
                  </div>
                  <div className="vol-contract-group vol-greeks-group">
                    <div className="vol-group-title">Greeks</div>
                    <div className="vol-contract-hero"><strong>{greeks.delta == null ? '—' : greeks.delta.toFixed(3)}</strong><span>delta · at the money</span></div>
                    <div className="vol-group-grid">
                      <GroupStat label="Gamma" value={greeks.gamma == null ? '—' : greeks.gamma.toFixed(4)} />
                      <GroupStat label="Theta" value={greeks.theta == null ? '—' : greeks.theta.toFixed(3)} color={NEG} />
                      <GroupStat label="Vega" value={greeks.vega == null ? '—' : greeks.vega.toFixed(3)} />
                      <GroupStat label="Rho" value={greeks.rho == null ? '—' : greeks.rho.toFixed(3)} />
                    </div>
                    <p className="vol-theta-caption">{thetaCaption(greeks.theta, detail.mid)}</p>
                  </div>
                </div>
              )
            })()}
          </section>

          <section className="vol-band">
            <SectionStrip title="Implied vs realized">
              <HistoryLegend label="implied" color={GOLD} />
              <HistoryLegend label="realized 30d" color={BLUE} pattern="dashed" />
              <HistoryLegend label="stock price" color={T.chartNeutral} pattern="dotted" />
              <Provenance kind="live" source="Yahoo option chains · daily" />
            </SectionStrip>
            <div className="vol-history-body">
              {rankQ.isLoading ? <div className="vol-chart-state">Loading IV history</div> : !histSeries.length ? (
                <div className="vol-chart-state">No stored IV history yet. Rank builds as the app records daily snapshots.</div>
              ) : (
                <ResponsiveContainer width="100%" height={230}>
                  <LineChart data={histSeries} margin={{ top: 12, right: 4, bottom: 8, left: 0 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="date" tick={{ fontFamily: MONO, fontSize: 11, fill: SEC }} tickLine={false} axisLine={false} minTickGap={60} tickFormatter={(value: string) => {
                      const parsed = new Date(value)
                      return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    }} />
                    <YAxis yAxisId="vol" domain={paddedDomain(histSeries.flatMap(point => [point.iv, point.hv_30d]), 10)} tick={{ fontFamily: MONO, fontSize: 11, fill: SEC }} tickLine={false} axisLine={false} width={48} tickFormatter={(value: number) => `${value.toFixed(0)}%`} />
                    <YAxis yAxisId="px" orientation="right" domain={paddedDomain(histSeries.map(point => point.stock_price), 10)} tick={{ fontFamily: MONO, fontSize: 11, fill: FAINT }} tickLine={false} axisLine={false} width={52} tickFormatter={(value: number) => `$${value.toFixed(0)}`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value: number, name: string) => [name === 'stock_price' ? `$${value.toFixed(2)}` : `${value.toFixed(1)}%`, name === 'iv' ? 'Implied' : name === 'hv_30d' ? 'Realized 30d' : 'Stock price']} />
                    <Line yAxisId="px" type="monotone" dataKey="stock_price" stroke={T.chartNeutral} strokeWidth={1.35} strokeDasharray="1 5" strokeLinecap="round" dot={false} isAnimationActive={false} />
                    <Line yAxisId="vol" type="monotone" dataKey="hv_30d" stroke={BLUE} strokeWidth={1.7} strokeDasharray="7 5" dot={false} isAnimationActive={false} />
                    <Line yAxisId="vol" type="monotone" dataKey="iv" stroke={GOLD} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

export default function VolatilityScanner() {
  return (
    <PageWrapper title="Volatility Scanner">
      <VolatilityScannerContent />
    </PageWrapper>
  )
}
