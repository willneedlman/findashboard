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
import { KpiCell } from '../components/mmCockpit'
import { TOOLTIP_STYLE } from '../components/ChartTooltip'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, chartClip } from '../lib/reportCaptureRegistry'
import type { ClipDraft } from '../lib/reportCreator'

const TAB = 'Volatility Scanner'
const GOLD = 'var(--theme-primary, #c9a84c)'
const BLUE = 'var(--theme-tertiary, #60a5fa)'
const POS = 'var(--theme-positive, #3fb950)'
const NEG = 'var(--theme-negative, #f85149)'
const TEXT = 'var(--theme-text, #d7e3fc)'
const SEC = 'var(--theme-secondary, #8099b0)'
const FAINT = 'var(--theme-text-faint, #5e768f)'
const MONO = 'var(--theme-mono, monospace)'
const SANS = 'var(--theme-sans, sans-serif)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'
const SURFACE = 'var(--theme-surface, #0d1826)'

const lbl: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
  color: FAINT, fontFamily: SANS, marginBottom: 6, display: 'block',
}
// Project input token: 32px tall, dark, single gold border.
const inp: React.CSSProperties = {
  background: 'var(--theme-bg)', border: `1px solid color-mix(in srgb, ${GOLD} 30%, transparent)`,
  color: TEXT, fontFamily: MONO, fontSize: 11, padding: '0 10px', height: 32,
  outline: 'none', boxSizing: 'border-box',
}
const panelHead: React.CSSProperties = {
  padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, fontFamily: SANS, fontSize: 10,
  fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GOLD,
}

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

const ivZone = (v: number | null) => (v == null ? '—' : v >= 66 ? 'EXPENSIVE' : v >= 33 ? 'FAIR' : 'CHEAP')
const ivZoneColor = (v: number | null) => (v == null ? SEC : v >= 66 ? NEG : v >= 33 ? 'var(--theme-warn, #d29922)' : POS)

/** IV Rank's three-zone gauge, carried over intact. */
function IVGauge({ value, title }: { value: number | null; title: string }) {
  const pct = Math.max(0, Math.min(100, value ?? 0))
  const color = ivZoneColor(value)
  const W = 160, H = 22
  const markerX = (pct / 100) * W
  return (
    <div style={{ minWidth: 180, flex: '1 1 180px', padding: '10px 13px', borderRight: `1px solid ${BORDER}` }}>
      <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: FAINT, fontFamily: MONO, marginBottom: 6 }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 700, fontFamily: MONO, color }}>{value == null ? '—' : value.toFixed(1)}</span>
        <span style={{ fontSize: 8, fontFamily: MONO, color: FAINT }}>/ 100</span>
        <span style={{ fontSize: 9, fontWeight: 700, fontFamily: MONO, color, marginLeft: 4 }}>{ivZone(value)}</span>
      </div>
      <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
        <rect x={0} y={6} width={W * 0.33} height={6} rx={1} style={{ fill: 'var(--theme-positive)' }} opacity={0.28} />
        <rect x={W * 0.33} y={6} width={W * 0.33} height={6} rx={1} style={{ fill: 'var(--theme-warn)' }} opacity={0.28} />
        <rect x={W * 0.66} y={6} width={W * 0.34} height={6} rx={1} style={{ fill: 'var(--theme-negative)' }} opacity={0.28} />
        <text x={W * 0.165} y={20} textAnchor="middle" fontSize={7} fontFamily={MONO} style={{ fill: 'var(--theme-positive)' }} opacity={0.75}>CHEAP</text>
        <text x={W * 0.495} y={20} textAnchor="middle" fontSize={7} fontFamily={MONO} style={{ fill: 'var(--theme-warn)' }} opacity={0.75}>FAIR</text>
        <text x={W * 0.83} y={20} textAnchor="middle" fontSize={7} fontFamily={MONO} style={{ fill: 'var(--theme-negative)' }} opacity={0.75}>EXP</text>
        {value !== null && (
          <>
            <line x1={markerX} y1={3} x2={markerX} y2={15} stroke={color} strokeWidth={1.5} />
            <circle cx={markerX} cy={9} r={3.5} fill={color} />
          </>
        )}
      </svg>
    </div>
  )
}

function Stat({ label, value, color, tip }: { label: string; value: string; color?: string; tip?: string }) {
  return (
    <div style={{ minWidth: 96, padding: '7px 11px', borderRight: `1px solid ${BORDER}`, borderBottom: `1px solid ${BORDER}`, flex: '1 1 96px' }} title={tip}>
      <div style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: FAINT }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: color ?? TEXT, marginTop: 3, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
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

/**
 * IV -> cell colour. `rank` shifts the palette so the surface reads against the
 * name's own 52-week history: a high-rank surface runs hot even where the raw
 * numbers look ordinary, which is the whole point of rank contextualizing it.
 */
function cellColor(iv: number | null, [lo, hi]: [number, number], rank: number | null): string {
  if (iv == null || !Number.isFinite(iv)) return 'transparent'
  const t = Math.max(0, Math.min(1, (iv - lo) / (hi - lo)))
  const bias = rank == null ? 0.5 : Math.max(0, Math.min(1, rank / 100))
  // Blend toward gold as IV rises within the surface, and lift the floor with rank.
  const intensity = Math.round((0.12 + 0.78 * t) * (0.55 + 0.45 * bias) * 100)
  return `color-mix(in srgb, ${GOLD} ${intensity}%, var(--theme-bg))`
}

export function VolatilityScannerContent() {
  const [draft, setDraft] = useState('AAPL')
  const [ticker, setTicker] = useState('')
  const [side, setSide] = useState<Side>('composite')
  const [expiryIdx, setExpiryIdx] = useState(0)
  const [moneyness, setMoneyness] = useState(0)
  // IV Rank let you pick the exact contract and lookback; both carry over. Strike
  // is blank = ATM (the backend snaps to the nearest listed strike either way).
  const [strikeDraft, setStrikeDraft] = useState('')
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

  // IV rank + the IV-vs-HV history, for the selected expiry's ATM contract. This is
  // IVTracker's source, reused unchanged — no new options vendor.
  const strikeParam = parseFloat(strikeDraft) > 0 ? parseFloat(strikeDraft) : data?.spot
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
    () => (selected ? pointsFor(selected, side).filter(p => Math.abs(p.moneyness) <= 25) : []),
    [selected, side],
  )

  const histSeries = useMemo(
    () => (rankQ.data?.time_series ?? []).filter(p => p.iv != null || p.hv_30d != null),
    [rankQ.data],
  )

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
    if (sym) setTicker(sym)
  }

  return (
    <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Controls */}
      <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderTop: `2px solid ${GOLD}`, display: 'flex', alignItems: 'flex-end', gap: 18, padding: '12px 16px', flexWrap: 'wrap' }}>
        <div>
          <label style={lbl} htmlFor="vol-ticker">Ticker</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input id="vol-ticker" value={draft} onChange={e => setDraft(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submit()}
              placeholder="AAPL" style={{ ...inp, width: 130, textTransform: 'uppercase' }} />
            <button onClick={submit} disabled={isPending}
              style={{ background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-bg)', fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', padding: '0 16px', height: 32, cursor: isPending ? 'default' : 'pointer', opacity: isPending ? 0.6 : 1 }}>
              {isPending ? 'Loading' : 'Fetch'}
            </button>
          </div>
        </div>
        <div>
          <label style={lbl}>Side</label>
          <div style={{ display: 'flex', border: `1px solid ${BORDER}`, height: 32 }}>
            {SIDES.map((s, i) => (
              <button key={s.key} onClick={() => setSide(s.key)} aria-pressed={side === s.key}
                title={s.key === 'composite'
                  ? 'Fitted out-of-the-money smile: puts below spot, calls above. The tightest quotes on each side.'
                  : `Raw ${s.key} quotes across all strikes. In-the-money wings are wide, so this is noisier than the composite.`}
                style={{ background: side === s.key ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent', border: 'none', borderRight: i < SIDES.length - 1 ? `1px solid ${BORDER}` : 'none', cursor: 'pointer', color: side === s.key ? GOLD : SEC, fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: '0 12px' }}>{s.label}</button>
            ))}
          </div>
        </div>
        {data && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 10, fontFamily: MONO }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: GOLD, letterSpacing: '0.04em' }}>
              IV RANK {rank != null ? `${rank.toFixed(0)}%` : '—'}
            </span>
            <span style={{ fontSize: 10, color: FAINT }}>· 52-WK</span>
            <span style={{ fontSize: 10, color: SEC }}>{data.ticker} ${data.spot.toFixed(2)}</span>
          </div>
        )}
        {isError && <div style={{ width: '100%', fontFamily: MONO, fontSize: 9, color: NEG }}>{errMsg ?? 'No options data for this ticker'}</div>}
        {limitedHistory && (
          <div style={{ width: '100%', fontFamily: SANS, fontSize: 9.5, color: SEC }}>
            Limited history: options come from Yahoo chains only, so this name has no stored
            IV history to rank against yet. The surface and cross-sections are still live.
          </div>
        )}
      </div>

      {!data && !isPending && (
        <EmptyState title="Volatility Scanner"
          hint="Enter a ticker and press FETCH. One chain load drives the IV surface, the term structure, and the skew." />
      )}
      {isPending && <EmptyState title="Loading the chain" hint="Fitting the smile across every listed expiry." variant="loading" />}

      {data && selected && (
        <>
          <div style={{ display: 'flex', borderTop: `1px solid ${BORDER}`, border: `1px solid ${BORDER}`, background: SURFACE, flexWrap: 'wrap' }}>
            <KpiCell grow align="top" label="ATM IV" value={`${selected.atm_iv.toFixed(1)}%`} valueSize={18} sub={`${selected.dte}d · ${selected.expiry}`} />
            <KpiCell grow align="top" label="IV Rank" value={rank != null ? `${rank.toFixed(0)}%` : '—'} valueSize={18}
              color={rank == null ? SEC : rank > 60 ? NEG : rank < 30 ? POS : GOLD}
              sub={rankQ.data?.iv_percentile != null ? `${rankQ.data.iv_percentile.toFixed(0)}th pctile` : 'limited history'} />
            <KpiCell grow align="top" label="25D Risk Reversal" value={`${selected.rr_25 > 0 ? '+' : ''}${selected.rr_25.toFixed(1)}`} valueSize={18}
              color={selected.rr_25 > 4 ? NEG : GOLD} sub="put IV minus call IV" />
            <KpiCell grow align="top" label="25D Butterfly" value={selected.bf_25.toFixed(1)} valueSize={18} sub="wing richness" />
            <KpiCell grow align="top" label="Term Slope" value={`${data.ts_slope > 0 ? '+' : ''}${data.ts_slope.toFixed(1)}`} valueSize={18}
              color={data.ts_slope < -0.5 ? NEG : POS} sub={data.ts_slope < -0.5 ? 'inverted' : 'contango'} />
          </div>

          {/* Surface — the centerpiece. Click a row for its skew, a column for its term structure. */}
          <div style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
            <div style={{ ...panelHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <span>Implied Volatility Surface <span style={{ color: FAINT, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· expiry x moneyness · click a row or column</span></span>
              <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT, textTransform: 'none', letterSpacing: 0 }}>
                {scale[0].toFixed(0)}% <span style={{ display: 'inline-block', width: 54, height: 8, verticalAlign: 'middle', margin: '0 5px', background: `linear-gradient(90deg, ${cellColor(scale[0], scale, rank)}, ${cellColor(scale[1], scale, rank)})`, border: `1px solid ${BORDER}` }} /> {scale[1].toFixed(0)}% IV
              </span>
            </div>
            <div style={{ overflowX: 'auto', padding: '8px 10px 10px' }}>
              <table style={{ borderCollapse: 'collapse', fontFamily: MONO, fontSize: 9 }}>
                <thead>
                  <tr>
                    <th style={{ padding: '3px 7px', color: FAINT, fontWeight: 400, textAlign: 'right', whiteSpace: 'nowrap' }}>exp / mny</th>
                    {BUCKETS.map(b => (
                      <th key={b} style={{ padding: '3px 2px', fontWeight: 700, minWidth: 40 }}>
                        <button onClick={() => setMoneyness(b)} aria-pressed={Math.abs(moneyness - b) < 0.01}
                          title={`Show the term structure at ${b > 0 ? '+' : ''}${b}% moneyness`}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px 3px', fontFamily: MONO, fontSize: 9, fontWeight: 700, color: Math.abs(moneyness - b) < 0.01 ? GOLD : SEC }}>
                          {b > 0 ? '+' : ''}{b}%
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {term.map((t, i) => {
                    const isSel = i === expiryIdx
                    const pts = pointsFor(t, side)
                    return (
                      <tr key={t.expiry}>
                        <td style={{ padding: '2px 7px', textAlign: 'right', whiteSpace: 'nowrap', borderRight: `1px solid ${BORDER}` }}>
                          <button onClick={() => setExpiryIdx(i)} aria-pressed={isSel}
                            title={`Show the ${t.expiry} skew cross-section`}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: MONO, fontSize: 9, fontWeight: isSel ? 700 : 400, color: isSel ? GOLD : SEC }}>
                            {t.dte}d
                          </button>
                        </td>
                        {BUCKETS.map(b => {
                          const iv = ivAt(pts, b)
                          const colSel = Math.abs(moneyness - b) < 0.01
                          return (
                            <td key={b} title={iv != null ? `${t.expiry} · ${b > 0 ? '+' : ''}${b}% · IV ${iv.toFixed(1)}%` : `${t.expiry} · ${b > 0 ? '+' : ''}${b}% · no quote`}
                              style={{
                                background: cellColor(iv, scale, rank), textAlign: 'center', padding: '3px 2px',
                                color: iv == null ? FAINT : TEXT,
                                outline: isSel || colSel ? `1px solid color-mix(in srgb, ${GOLD} 55%, transparent)` : 'none',
                                outlineOffset: -1,
                              }}>
                              {iv != null ? iv.toFixed(0) : '·'}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {side !== 'composite' && (
                <div style={{ fontFamily: SANS, fontSize: 9, color: SEC, marginTop: 7 }}>
                  Raw {side} quotes. In-the-money strikes carry wide, stale markets, so those cells
                  are less reliable than the composite. The colour scale stays on the composite fit.
                </div>
              )}
            </div>
          </div>

          {/* Linked cross-sections */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 420px', minWidth: 0, background: SURFACE, border: `1px solid ${BORDER}` }}>
              <div style={panelHead}>Term Structure <span style={{ color: FAINT, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· IV by expiry at {moneyness > 0 ? '+' : ''}{moneyness}%</span></div>
              <div style={{ padding: '10px 8px 4px' }}>
                <ResponsiveContainer width="100%" height={230}>
                  <LineChart data={termSeries} margin={{ top: 4, right: 8, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="dte" tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }}
                      tickFormatter={(v: number) => `${v}d`} minTickGap={26} />
                    <YAxis tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }} width={40}
                      tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE}
                      labelFormatter={(v: number) => `${v} days to expiry`}
                      formatter={(v: number, n: string) => [`${v.toFixed(1)}%`, n === 'iv' ? `IV at ${moneyness}%` : 'ATM IV']} />
                    <Line type="monotone" dataKey="atm" name="atm" stroke={SEC} strokeWidth={1.1} strokeDasharray="3 3" dot={false} isAnimationActive={false} connectNulls />
                    <Line type="monotone" dataKey="iv" name="iv" stroke={GOLD} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />
                    {selected && <ReferenceLine x={selected.dte} stroke={GOLD} strokeDasharray="2 3" />}
                  </LineChart>
                </ResponsiveContainer>
                <div style={{ fontFamily: SANS, fontSize: 9, color: FAINT, padding: '2px 10px 8px' }}>
                  <span style={{ color: GOLD }}>─</span> selected moneyness · <span style={{ color: SEC }}>- -</span> ATM · vertical marks the selected expiry
                </div>
              </div>
            </div>

            <div style={{ flex: '1 1 420px', minWidth: 0, background: SURFACE, border: `1px solid ${BORDER}` }}>
              <div style={panelHead}>Skew <span style={{ color: FAINT, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· {selected.expiry} · {selected.dte}d</span></div>
              <div style={{ padding: '10px 8px 4px' }}>
                <ResponsiveContainer width="100%" height={230}>
                  <AreaChart data={smileSeries} margin={{ top: 4, right: 8, bottom: 4, left: 4 }}>
                    <defs>
                      <linearGradient id="vol-smile" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={GOLD} stopOpacity={0.24} />
                        <stop offset="100%" stopColor={GOLD} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="moneyness" type="number" domain={['dataMin', 'dataMax']}
                      tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }}
                      tickFormatter={(v: number) => `${v > 0 ? '+' : ''}${v.toFixed(0)}%`} minTickGap={24} />
                    <YAxis tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }} width={40}
                      tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE}
                      labelFormatter={(v: number) => `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}% from spot`}
                      formatter={(v: number) => [`${v.toFixed(1)}%`, 'IV']} />
                    <ReferenceLine x={0} stroke={SEC} strokeDasharray="3 3" label={{ value: 'spot', position: 'insideTopLeft', fill: FAINT, fontSize: 9, fontFamily: MONO }} />
                    <ReferenceLine x={moneyness} stroke={GOLD} strokeDasharray="2 3" />
                    <Area type="monotone" dataKey="iv" stroke={GOLD} strokeWidth={1.8} fill="url(#vol-smile)" dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
                <div style={{ fontFamily: SANS, fontSize: 9, color: FAINT, padding: '2px 10px 8px' }}>
                  {side === 'composite' ? 'Fitted OTM smile' : `Raw ${side} quotes`} · gold mark is the selected moneyness
                </div>
              </div>
            </div>
          </div>

          {/* Full contract detail — every field IV Rank surfaced. */}
          <div style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
            <div style={{ ...panelHead, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
              <span>Contract Detail <span style={{ color: FAINT, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
                · {selected.expiry} · {rankQ.data ? `${rankQ.data.strike} ${rankQ.data.option_type}` : 'ATM'}
              </span></span>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, textTransform: 'none', letterSpacing: 0 }}>
                <div>
                  <label style={{ ...lbl, marginBottom: 3 }} htmlFor="vs-strike">Strike</label>
                  <input id="vs-strike" type="number" step="1" value={strikeDraft} onChange={e => setStrikeDraft(e.target.value)}
                    placeholder={data.spot.toFixed(0)} title="Blank uses at-the-money. Snaps to the nearest listed strike."
                    style={{ ...inp, width: 92, height: 28 }} />
                </div>
                <div>
                  <label style={{ ...lbl, marginBottom: 3 }} htmlFor="vs-days">Lookback</label>
                  <select id="vs-days" value={days} onChange={e => setDays(parseInt(e.target.value, 10))}
                    style={{ ...inp, width: 92, height: 28, cursor: 'pointer' }}>
                    {[30, 60, 90, 180, 365].map(d => <option key={d} value={d}>{d} days</option>)}
                  </select>
                </div>
              </div>
            </div>
            {rankQ.isLoading && <div style={{ padding: 16, fontFamily: SANS, fontSize: 11, color: FAINT }}>Loading contract…</div>}
            {rankQ.isError && <div style={{ padding: 16, fontFamily: SANS, fontSize: 11, color: SEC }}>No chain data for this contract. Try another strike or expiry.</div>}
            {rankQ.data && (() => {
              const d = rankQ.data
              const g = d.greeks ?? {}
              const em = expectedMove(d.current_iv, d.dte, d.spot)
              return (
                <>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', borderBottom: `1px solid ${BORDER}` }}>
                    <IVGauge value={d.iv_rank} title="IV Rank" />
                    <IVGauge value={d.iv_percentile} title="IV Percentile" />
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap' }}>
                    <Stat label="Implied Vol" value={`${d.current_iv.toFixed(1)}%`} color={GOLD} />
                    <Stat label="Realized 30d" value={d.current_hv_30d != null ? `${d.current_hv_30d.toFixed(1)}%` : '—'} color={BLUE} />
                    <Stat label="IV Premium" value={d.iv_premium != null ? `${d.iv_premium > 0 ? '+' : ''}${d.iv_premium.toFixed(1)}%` : '—'}
                      color={d.iv_premium != null && d.iv_premium > 0 ? NEG : POS} tip="Implied minus realized. Positive means options are pricing more movement than the stock has delivered." />
                    <Stat label="IV Min" value={d.iv_min != null ? `${d.iv_min.toFixed(1)}%` : '—'} />
                    <Stat label="IV Mean" value={d.iv_mean != null ? `${d.iv_mean.toFixed(1)}%` : '—'} />
                    <Stat label="IV Max" value={d.iv_max != null ? `${d.iv_max.toFixed(1)}%` : '—'} />
                    <Stat label="Spot" value={`$${d.spot.toFixed(2)}`} />
                    <Stat label="Strike" value={`${d.strike}`} />
                    <Stat label="DTE" value={`${d.dte}d`} />
                    <Stat label="Bid" value={d.bid > 0 ? `$${d.bid.toFixed(2)}` : '—'} />
                    <Stat label="Ask" value={d.ask > 0 ? `$${d.ask.toFixed(2)}` : '—'} />
                    <Stat label="Mid" value={d.mid > 0 ? `$${d.mid.toFixed(2)}` : '—'} color={GOLD} />
                    <Stat label="Open Interest" value={d.open_interest.toLocaleString()} />
                    <Stat label="Volume" value={d.volume.toLocaleString()} />
                    <Stat label="Straddle" value={d.straddle != null ? `$${d.straddle.toFixed(2)}` : '—'} tip="Cost of the at-the-money call plus put" />
                    <Stat label="Implied Move" value={d.implied_move != null ? `${d.implied_move > 0 ? '±' : ''}${d.implied_move.toFixed(1)}%` : `±${em.pct.toFixed(1)}%`}
                      color={GOLD} tip={`One sigma by expiry: $${em.lo.toFixed(2)} to $${em.hi.toFixed(2)}`} />
                    {/* Backend already returns this as a percent (iv_tracker.py rounds r*100). */}
                    <Stat label="Risk-Free" value={`${d.risk_free_rate.toFixed(2)}%`} />
                    <Stat label="Delta" value={g.delta != null ? g.delta.toFixed(3) : '—'} />
                    <Stat label="Gamma" value={g.gamma != null ? g.gamma.toFixed(4) : '—'} />
                    <Stat label="Theta" value={g.theta != null ? g.theta.toFixed(3) : '—'} color={NEG} />
                    <Stat label="Vega" value={g.vega != null ? g.vega.toFixed(3) : '—'} />
                    <Stat label="Rho" value={g.rho != null ? g.rho.toFixed(3) : '—'} />
                  </div>
                </>
              )
            })()}
          </div>

          {/* Per-expiry term-structure table — Vol Skew's numeric read, kept whole. */}
          <div style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
            <div style={panelHead}>Term Structure Detail <span style={{ color: FAINT, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· every listed expiry</span></div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 10, minWidth: 560 }}>
                <thead>
                  <tr>
                    {['Expiry', 'DTE', 'ATM IV', '25D RR', '25D Fly', 'Implied Move', '1σ Range'].map((h, i) => (
                      <th key={h} style={{ padding: '5px 10px', textAlign: i === 0 ? 'left' : 'right', color: FAINT, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', borderBottom: `1px solid ${BORDER}`, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {term.map((t, i) => {
                    const em = expectedMove(t.atm_iv, t.dte, data.spot)
                    const isSel = i === expiryIdx
                    return (
                      <tr key={t.expiry} onClick={() => setExpiryIdx(i)} style={{ cursor: 'pointer', background: isSel ? `color-mix(in srgb, ${GOLD} 8%, transparent)` : 'transparent' }}>
                        <td style={{ padding: '5px 10px', color: isSel ? GOLD : TEXT, fontWeight: isSel ? 700 : 400, whiteSpace: 'nowrap' }}>{t.expiry}</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', color: SEC }}>{t.dte}d</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', color: GOLD }}>{t.atm_iv.toFixed(1)}%</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', color: t.rr_25 > 4 ? NEG : TEXT }}>{t.rr_25 > 0 ? '+' : ''}{t.rr_25.toFixed(1)}</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', color: TEXT }}>{t.bf_25.toFixed(1)}</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', color: TEXT }}>±{em.pct.toFixed(1)}%</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', color: SEC }}>${em.lo.toFixed(0)} – ${em.hi.toFixed(0)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* IV vs realized history for the selected contract — IVTracker's view, kept. */}
          <div style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
            <div style={panelHead}>IV vs Realized <span style={{ color: FAINT, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· {selected.expiry} ATM {side === 'put' ? 'put' : 'call'}</span></div>
            <div style={{ padding: '10px 8px 4px' }}>
              {rankQ.isLoading ? (
                <div style={{ height: 200, display: 'grid', placeItems: 'center', fontFamily: SANS, fontSize: 11, color: FAINT }}>Loading IV history…</div>
              ) : !histSeries.length ? (
                <div style={{ height: 200, display: 'grid', placeItems: 'center', fontFamily: SANS, fontSize: 11, color: FAINT, textAlign: 'center', padding: '0 20px' }}>
                  No stored IV history for this contract yet. Yahoo chains carry no history, so
                  rank builds up from snapshots this app records over time.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={histSeries} margin={{ top: 4, right: 8, bottom: 4, left: 4 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="date" tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }} minTickGap={44}
                      tickFormatter={(v: string) => {
                        const d = new Date(v)
                        return isNaN(d.getTime()) ? v : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                      }} />
                    <YAxis yAxisId="vol" tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }} width={40}
                      tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                    <YAxis yAxisId="px" orientation="right" domain={['auto', 'auto']} tick={{ fontFamily: MONO, fontSize: 9, fill: FAINT }}
                      tickLine={false} axisLine={{ stroke: BORDER }} width={48} tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE}
                      formatter={(v: number, n: string) => [
                        n === 'stock_price' ? `$${v.toFixed(2)}` : `${v.toFixed(1)}%`,
                        n === 'iv' ? 'Implied' : n === 'hv_30d' ? 'Realized 30d' : 'Stock price',
                      ]} />
                    <Line yAxisId="px" type="monotone" dataKey="stock_price" name="stock_price" stroke={FAINT} strokeWidth={1} dot={false} isAnimationActive={false} connectNulls />
                    <Line yAxisId="vol" type="monotone" dataKey="iv" name="iv" stroke={GOLD} strokeWidth={1.7} dot={false} isAnimationActive={false} connectNulls />
                    <Line yAxisId="vol" type="monotone" dataKey="hv_30d" name="hv_30d" stroke={BLUE} strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              )}
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '4px 10px 8px', flexWrap: 'wrap', fontFamily: SANS, fontSize: 9, color: FAINT }}>
                <span><span style={{ color: GOLD }}>─</span> implied</span>
                <span><span style={{ color: BLUE }}>─</span> realized 30d</span>
                <span><span style={{ color: FAINT }}>─</span> stock price</span>
                {histSeries.length > 0 && (
                  <span title="Where each IV point came from: a stored snapshot, or a realized-vol proxy scaled to the current IV/HV ratio">
                    sources: {[...new Set(histSeries.map(p => p.source).filter(Boolean))].join(', ')}
                  </span>
                )}
                <Provenance kind="live" source="Yahoo option chains · daily" />
              </div>
            </div>
          </div>

          {data.read && (
            <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, padding: '11px 14px', fontFamily: SANS, fontSize: 11, color: TEXT, lineHeight: 1.6 }}>
              {data.read}
            </div>
          )}
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
