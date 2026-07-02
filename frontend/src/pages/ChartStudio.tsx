import { useEffect, useMemo, useReducer, useRef, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  createChart, ColorType, CrosshairMode, LineStyle,
  type IChartApi, type ISeriesApi, type Time, type SeriesMarker, type IPriceLine,
} from 'lightweight-charts'
import PageWrapper from '../components/PageWrapper'
import { readToken } from '../lib/theme'
import { smaArr, emaArr, bollinger, vwapArr, rsiArr, macdArr, hvArr } from '../lib/indicators'

// ── Types ────────────────────────────────────────────────────────────────────
interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface RawCandle { time: number | string; open: number; high: number; low: number; close: number; volume: number }
interface ChartEvents {
  earnings: { date: string; eps: number | null; estimate: number | null; surprise_pct: number | null }[]
  dividends: { date: string; amount: number }[]
  splits: { date: string; ratio: number }[]
}

const TFS = ['1m', '5m', '15m', '1h', '4h', '1d', '1wk'] as const
type TF = typeof TFS[number]
const INTRADAY: Set<TF> = new Set(['1m', '5m', '15m', '1h', '4h'])

type AssetClass = 'equities' | 'index' | 'futures' | 'fx'
const ASSET_CLASSES: { key: AssetClass; label: string; watch: string[] }[] = [
  { key: 'equities', label: 'EQUITIES', watch: ['QQQ', 'IWM', 'NVDA', 'AAPL'] },
  { key: 'index', label: 'INDEX', watch: ['^GSPC', '^NDX', '^DJI', '^VIX'] },
  { key: 'futures', label: 'FUTURES', watch: ['ES=F', 'NQ=F', 'GC=F', 'CL=F'] },
  { key: 'fx', label: 'FX', watch: ['EURUSD=X', 'USDJPY=X', 'GBPUSD=X', 'DX-Y.NYB'] },
]

type CandleWidth = 'thin' | 'med' | 'wide'
const CANDLE_WIDTHS: { key: CandleWidth; spacing: number }[] = [
  { key: 'thin', spacing: 4 }, { key: 'med', spacing: 9 }, { key: 'wide', spacing: 16 },
]

// Visible-span presets: pick a window, candles auto-size to fit it. Wheel zoom
// drops the control to Custom.
const DAY = 86400
const SPANS: Record<'intra' | 'daily' | 'weekly', { key: string; label: string; sec: number }[]> = {
  intra: [
    { key: '1D', label: '1D', sec: DAY }, { key: '3D', label: '3D', sec: 3 * DAY },
    { key: '1W', label: '1W', sec: 7 * DAY }, { key: '1M', label: '1M', sec: 31 * DAY },
    { key: 'all', label: 'ALL', sec: 0 },
  ],
  daily: [
    { key: '1M', label: '1M', sec: 31 * DAY }, { key: '3M', label: '3M', sec: 92 * DAY },
    { key: '6M', label: '6M', sec: 183 * DAY }, { key: '1Y', label: '1Y', sec: 365 * DAY },
    { key: 'all', label: 'ALL', sec: 0 },
  ],
  weekly: [
    { key: '1Y', label: '1Y', sec: 365 * DAY }, { key: '3Y', label: '3Y', sec: 3 * 365 * DAY },
    { key: '5Y', label: '5Y', sec: 5 * 365 * DAY }, { key: 'all', label: 'ALL', sec: 0 },
  ],
}
const spansFor = (tf: TF) => INTRADAY.has(tf) ? SPANS.intra : tf === '1wk' ? SPANS.weekly : SPANS.daily

// ── Data plumbing ────────────────────────────────────────────────────────────
const toEpoch = (t: number | string): number =>
  typeof t === 'number' ? t : Math.floor(Date.parse(`${t}T00:00:00Z`) / 1000)
const monthEpoch = (ym: string) => toEpoch(`${ym}-01`)

const fetchCandles = async (ticker: string, tf: TF): Promise<Candle[]> => {
  const r = await axios.get(`/api/market/ohlcv?ticker=${encodeURIComponent(ticker)}&tf=${tf}`)
  return (r.data.candles as RawCandle[]).map(c => ({ ...c, time: toEpoch(c.time) }))
}

interface OverlayDef { id: string; label: string; src: string; style: GlyphStyle; fetch: () => Promise<{ time: number; value: number }[]> }

const tickerOverlay = (sym: string, tf: TF): OverlayDef => ({
  id: `cmp:${sym}`, label: sym, src: 'OHLCV', style: 'line',
  fetch: async () => (await fetchCandles(sym, tf)).map(c => ({ time: c.time, value: c.close })),
})

const curveSpread = (name: string): OverlayDef => ({
  id: `spread:${name}`, label: `${name} spread`, src: 'FRED', style: 'line',
  fetch: async () => {
    const r = await axios.get('/api/rates/curve-spreads')
    const s = r.data.spreads.find((x: any) => x.name === name)
    return (s?.history ?? []).map((p: any) => ({ time: toEpoch(p.date), value: p.bp }))
  },
})

const creditOas = (key: 'ig_oas' | 'hy_oas', label: string): OverlayDef => ({
  id: key, label, src: 'FRED', style: 'line',
  fetch: async () => {
    const r = await axios.get('/api/rates/credit-spreads?lookback=365')
    return (r.data.series?.[key]?.history ?? []).filter((p: any) => p.value != null)
      .map((p: any) => ({ time: toEpoch(p.date), value: p.value }))
  },
})

// `fund:*`, `hv30`, `snap:*` and `xlkrs` are re-bound to the active primary
// ticker inside the component; placeholder fetches keep the registry uniform.
const fundMetric = (metric: string, label: string): OverlayDef => ({
  id: `fund:${metric}`, label, src: 'FMP', style: 'diamond', fetch: async () => [],
})

interface OverlayGroup { group: string; tag: string; defs: OverlayDef[] }
const APP_OVERLAY_GROUPS = (tf: TF): OverlayGroup[] => [
  {
    group: 'Rates & macro', tag: 'FRED', defs: [
      { ...tickerOverlay('^TNX', tf), id: 'us10y', label: 'US 10Y yield', src: 'CBOE' },
      { ...tickerOverlay('^IRX', tf), id: 'us3m', label: 'US 3M yield', src: 'CBOE' },
      curveSpread('2s10s'), curveSpread('3M10Y'),
      {
        id: 'cpi', label: 'CPI YoY', src: 'FRED', style: 'diamond',
        fetch: async () => {
          const r = await axios.get('/api/rates/economy')
          return (r.data.inflation?.trend ?? []).filter((p: any) => p.cpi != null).map((p: any) => ({ time: monthEpoch(p.d), value: p.cpi }))
        },
      },
      {
        id: 'unemp', label: 'Unemployment', src: 'FRED', style: 'diamond',
        fetch: async () => {
          const r = await axios.get('/api/rates/economy')
          return (r.data.unemployment?.trend ?? []).filter((p: any) => p.v != null).map((p: any) => ({ time: monthEpoch(p.d), value: p.v }))
        },
      },
      creditOas('ig_oas', 'IG OAS'), creditOas('hy_oas', 'HY OAS'),
    ],
  },
  {
    group: 'Cross-asset', tag: 'MKT', defs: [
      { ...tickerOverlay('DX-Y.NYB', tf), id: 'dxy', label: 'DXY dollar', src: 'ICE' },
      { id: 'xlkrs', label: 'Sector RS · XLK', src: 'Computed', style: 'line', fetch: async () => [] },
      { ...tickerOverlay('^VIX', tf), id: 'vix', label: 'VIX', src: 'CBOE' },
      { id: 'hv30', label: 'HV 30d', src: 'Computed', style: 'line', fetch: async () => [] },
      {
        id: 'hormuz', label: 'Hormuz transits', src: 'PortWatch', style: 'diamond',
        fetch: async () => {
          const r = await axios.get('/api/maritime/chokepoint-history?ids=hormuz&days=365')
          const pts = r.data.series?.[0]?.points ?? []
          return pts.filter((p: any) => p.total != null).map((p: any) => ({ time: toEpoch(p.d), value: p.total }))
        },
      },
    ],
  },
  {
    group: 'Fundamentals @ time', tag: 'FMP', defs: [
      fundMetric('pe', 'P/E ratio'), fundMetric('ps', 'P/S ratio'),
      fundMetric('eps', 'EPS ttm'), fundMetric('revenue', 'Revenue'),
    ],
  },
]
const APP_OVERLAYS = (tf: TF): OverlayDef[] => APP_OVERLAY_GROUPS(tf).flatMap(g => g.defs)

// ── State machine ────────────────────────────────────────────────────────────
interface Params { bbP: number; bbK: number; rsiP: number; macdF: number; macdS: number; macdSig: number }
interface MA { kind: 'sma' | 'ema'; period: number }
const maKey = (m: MA) => `${m.kind}${m.period}`
interface State {
  ticker: string
  assetClass: AssetClass
  tf: TF
  candleWidth: CandleWidth
  ind: { bb: boolean; vwap: boolean; gflip: boolean }
  lanes: { volume: boolean; rsi: boolean; macd: boolean; gex: boolean; iv: boolean }
  mas: MA[]
  events: { earnings: boolean; dividends: boolean; splits: boolean }
  overlays: string[]
  compares: string[]
  params: Params
}
type Action =
  | { type: 'ticker'; v: string } | { type: 'assetClass'; v: AssetClass } | { type: 'tf'; v: TF }
  | { type: 'candleWidth'; v: CandleWidth }
  | { type: 'ind'; k: keyof State['ind'] } | { type: 'lane'; k: keyof State['lanes'] }
  | { type: 'event'; k: keyof State['events'] }
  | { type: 'overlay'; id: string } | { type: 'addCompare'; sym: string } | { type: 'rmCompare'; sym: string }
  | { type: 'addMA'; ma: MA } | { type: 'rmMA'; key: string }
  | { type: 'param'; k: keyof Params; v: number }

const DEFAULT: State = {
  ticker: 'SPY', assetClass: 'equities', tf: '1d', candleWidth: 'med',
  ind: { bb: true, vwap: true, gflip: true },
  lanes: { volume: true, rsi: true, macd: true, gex: true, iv: true },
  mas: [{ kind: 'sma', period: 20 }, { kind: 'ema', period: 9 }],
  events: { earnings: true, dividends: true, splits: false },
  overlays: ['us10y'], compares: ['QQQ'],
  params: { bbP: 20, bbK: 2, rsiP: 14, macdF: 12, macdS: 26, macdSig: 9 },
}

function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'ticker': return { ...s, ticker: a.v }
    case 'assetClass': return { ...s, assetClass: a.v }
    case 'tf': return { ...s, tf: a.v }
    case 'candleWidth': return { ...s, candleWidth: a.v }
    case 'ind': return { ...s, ind: { ...s.ind, [a.k]: !s.ind[a.k] } }
    case 'lane': return { ...s, lanes: { ...s.lanes, [a.k]: !s.lanes[a.k] } }
    case 'event': return { ...s, events: { ...s.events, [a.k]: !s.events[a.k] } }
    case 'overlay': return { ...s, overlays: s.overlays.includes(a.id) ? s.overlays.filter(x => x !== a.id) : [...s.overlays, a.id] }
    case 'addCompare': return s.compares.includes(a.sym) || a.sym === s.ticker ? s : { ...s, compares: [...s.compares, a.sym].slice(-4) }
    case 'rmCompare': return { ...s, compares: s.compares.filter(x => x !== a.sym) }
    case 'addMA': return s.mas.some(m => maKey(m) === maKey(a.ma)) ? s : { ...s, mas: [...s.mas, a.ma].slice(-6) }
    case 'rmMA': return { ...s, mas: s.mas.filter(m => maKey(m) !== a.key) }
    case 'param': return { ...s, params: { ...s.params, [a.k]: a.v } }
  }
}

const load = (): State => {
  try {
    const raw = JSON.parse(localStorage.getItem('unifiedOverlay') || localStorage.getItem('chartStudio') || 'null')
    if (!raw) return DEFAULT
    let mas: MA[] = Array.isArray(raw.mas) ? raw.mas.filter((m: any) => (m?.kind === 'sma' || m?.kind === 'ema') && m.period >= 2) : []
    if (!mas.length) mas = DEFAULT.mas
    // Old shape: rsi/macd/volume lived in `ind`; lanes did not exist.
    const lanes = { ...DEFAULT.lanes, ...(raw.lanes ?? {}), ...(raw.ind?.rsi != null ? { rsi: raw.ind.rsi } : {}), ...(raw.ind?.macd != null ? { macd: raw.ind.macd } : {}), ...(raw.ind?.volume != null ? { volume: raw.ind.volume } : {}) }
    const ind = { ...DEFAULT.ind, ...(raw.ind?.bb != null ? { bb: raw.ind.bb } : {}), ...(raw.ind?.vwap != null ? { vwap: raw.ind.vwap } : {}), ...(raw.ind?.gflip != null ? { gflip: raw.ind.gflip } : {}) }
    return { ...DEFAULT, ...raw, mas, ind, lanes, events: { ...DEFAULT.events, ...raw.events }, params: { ...DEFAULT.params, ...raw.params } }
  } catch { return DEFAULT }
}

// ── Theme (concrete values — canvas cannot read CSS vars) ───────────────────
function chartColors() {
  const t = (n: string, fb: string) => readToken(n, fb) || fb
  return {
    bg: t('--theme-bg', '#101c2e'), surface: t('--theme-surface', '#0d1826'),
    gold: t('--theme-primary', '#c9a84c'), text: t('--theme-secondary', '#8099b0'),
    pos: '#22c55e', neg: '#ef4444', lanePos: '#3fb6a0', laneNeg: '#cf4b3f',
    blue: t('--theme-tertiary', '#60a5fa'), violet: t('--theme-accent-violet', '#c084fc'),
    grid: 'rgba(255,255,255,0.045)',
  }
}
type Colors = ReturnType<typeof chartColors>
const OVERLAY_PALETTE = ['#5b93c9', '#d07b34', '#a3b18a', '#b88a3a', '#cf4b3f', '#4a7fa5', '#3fb6a0', '#c084fc']
const MA_PALETTE = ['#c9a84c', '#60a5fa', '#3fb6a0', '#d07b34', '#c084fc', '#cf4b3f']

// Feeds are heterogeneous: one malformed point (null value, duplicate or
// unsorted time) makes lightweight-charts throw and unmounts the page. Every
// series passes through here first.
const sanitize = (pts: { time: number; value: number }[]) => {
  const out: { time: number; value: number }[] = []
  let last = -Infinity
  for (const p of pts ?? []) {
    if (p == null || !Number.isFinite(p.time) || !Number.isFinite(p.value)) continue
    if (p.time <= last) continue
    out.push(p)
    last = p.time
  }
  return out
}

// Carry-forward lookup: the value of a series at or before a timestamp.
// Monthly and quarterly feeds hold their last release until the next one.
interface Sorted { t: number[]; v: number[] }
const toSorted = (pts: { time: number; value: number }[]): Sorted =>
  ({ t: pts.map(p => p.time), v: pts.map(p => p.value) })
const floorVal = (s: Sorted | undefined, time: number): number | null => {
  if (!s || !s.t.length) return null
  let lo = 0, hi = s.t.length - 1, ans = -1
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s.t[m] <= time) { ans = m; lo = m + 1 } else hi = m - 1 }
  return ans >= 0 ? s.v[ans] : null
}

const baseOptions = (C: Colors, h: number) => ({
  layout: { background: { type: ColorType.Solid, color: C.bg }, textColor: C.text, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, attributionLogo: false },
  grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: `${C.gold}66`, labelBackgroundColor: C.surface },
    horzLine: { color: `${C.gold}66`, labelBackgroundColor: C.surface },
  },
  rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
  timeScale: { borderColor: 'rgba(255,255,255,0.08)' },
  height: h,
})

// ── UI primitives ────────────────────────────────────────────────────────────
const MONO = 'var(--theme-mono)'
const SANS = 'var(--theme-sans)'
const eyebrow: React.CSSProperties = { fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: '#56708a' }

type GlyphStyle = 'line' | 'dash' | 'hist' | 'diamond' | 'area' | 'ring'
function Glyph({ style, color }: { style: GlyphStyle; color: string }) {
  const base: React.CSSProperties = { display: 'inline-block' }
  switch (style) {
    case 'dash': return <span style={{ ...base, width: 14, height: 0, borderTop: `2px dashed ${color}` }} />
    case 'hist': return <span style={{ ...base, width: 12, height: 9, background: `repeating-linear-gradient(90deg, ${color} 0 2px, transparent 2px 4px)` }} />
    case 'diamond': return <span style={{ ...base, width: 7, height: 7, background: color, transform: 'rotate(45deg)' }} />
    case 'area': return <span style={{ ...base, width: 14, height: 8, background: `linear-gradient(${color}55, transparent)`, borderTop: `1.5px solid ${color}` }} />
    case 'ring': return <span style={{ ...base, width: 8, height: 8, borderRadius: '50%', border: `1.5px solid ${color}` }} />
    default: return <span style={{ ...base, width: 14, height: 0, borderTop: `2px solid ${color}` }} />
  }
}

function Row({ label, on, src, color, style, onToggle }: {
  label: string; on: boolean; src?: string; color: string; style: GlyphStyle; onToggle: () => void
}) {
  return (
    <div className="cs-row" onClick={onToggle} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0', cursor: 'pointer' }}>
      <span style={{ width: 13, height: 13, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? color : 'transparent', border: on ? `1px solid ${color}` : '1px solid rgba(255,255,255,0.22)', color: '#0a0e16', fontSize: 9, fontWeight: 800 }}>{on ? '✓' : ''}</span>
      <span style={{ width: 18, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Glyph style={style} color={color} /></span>
      <span style={{ fontFamily: SANS, fontSize: 11, color: on ? 'var(--theme-text, #d7e3fc)' : '#6d8199' }}>{label}</span>
      <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 8, color: '#3f5670' }}>{src}</span>
    </div>
  )
}

function Seg<T extends string>({ options, value, onChange, ariaLabel }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div role="group" aria-label={ariaLabel} style={{ display: 'flex', border: '1px solid rgba(255,255,255,0.12)' }}>
      {options.map(o => (
        <button key={o.key} className={value === o.key ? '' : 'cs-chip'} onClick={() => onChange(o.key)} style={{
          fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', padding: '4px 10px', cursor: 'pointer', border: 'none',
          background: value === o.key ? 'var(--theme-primary, #c9a84c)' : 'transparent',
          color: value === o.key ? '#0a0e16' : 'var(--theme-secondary, #8099b0)',
        }}>{o.label}</button>
      ))}
    </div>
  )
}

const fmtClockET = () => new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/New_York' }).format(new Date())
function LiveClock() {
  const [clock, setClock] = useState(fmtClockET)
  useEffect(() => { const id = setInterval(() => setClock(fmtClockET()), 1000); return () => clearInterval(id) }, [])
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#2e9a62', boxShadow: '0 0 6px #2e9a62' }} />
      <span style={{ fontFamily: MONO, fontSize: 9, color: '#56708a' }}>LIVE · {clock} ET</span>
    </span>
  )
}

// ── Lanes ─────────────────────────────────────────────────────────────────────
const LANE_DEFS = [
  { id: 'volume' as const, h: 60, label: 'VOLUME' },
  { id: 'rsi' as const, h: 78, label: 'RSI' },
  { id: 'macd' as const, h: 92, label: 'MACD' },
  { id: 'gex' as const, h: 92, label: 'DEALER NET GEX $Bn' },
  { id: 'iv' as const, h: 78, label: 'IV RANK' },
]
type LaneId = typeof LANE_DEFS[number]['id']

// ── Main component ───────────────────────────────────────────────────────────
export function ChartStudioContent() {
  const [state, dispatch] = useReducer(reducer, undefined, load)
  const { ticker, assetClass, tf, candleWidth, ind, lanes, mas, events, overlays, compares, params } = state
  const [tickerDraft, setTickerDraft] = useState(ticker)
  const [compareDraft, setCompareDraft] = useState('')
  const [maDraft, setMaDraft] = useState<MA>({ kind: 'ema', period: 21 })
  const [windowKey, setWindowKey] = useState('3M')
  const [crossTime, setCrossTime] = useState<number | null>(null)
  const applyingSpan = useRef(false)
  const addMA = () => {
    if (maDraft.period >= 2 && maDraft.period <= 400) dispatch({ type: 'addMA', ma: { ...maDraft } })
  }

  useEffect(() => { localStorage.setItem('unifiedOverlay', JSON.stringify(state)) }, [state])
  const C = useMemo(chartColors, [])

  // ── Data ──
  const candlesQ = useQuery({ queryKey: ['cs-candles', ticker, tf], queryFn: () => fetchCandles(ticker, tf), staleTime: 60_000, retry: 1 })
  const dailyQ = useQuery({ queryKey: ['cs-daily', ticker], queryFn: () => fetchCandles(ticker, '1d'), staleTime: 3600_000, retry: 1 })
  const eventsQ = useQuery<ChartEvents>({
    queryKey: ['cs-events', ticker],
    queryFn: () => axios.get(`/api/market/chart-events?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 6 * 3600_000, retry: 1,
  })
  const gexQ = useQuery({
    queryKey: ['cs-gexprofile', ticker],
    queryFn: () => axios.get(`/api/options/gex?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    enabled: ind.gflip, staleTime: 1800_000, retry: 1,
  })
  const gexHistQ = useQuery({
    queryKey: ['cs-snap-gex', ticker],
    queryFn: () => axios.get(`/api/snapshots/series?kind=gex&ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    enabled: lanes.gex, staleTime: 1800_000, retry: 1,
  })
  const ivHistQ = useQuery({
    queryKey: ['cs-snap-iv', ticker],
    queryFn: () => axios.get(`/api/snapshots/series?kind=iv30&ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    enabled: lanes.iv, staleTime: 1800_000, retry: 1,
  })

  // Gamma flip: the per-strike net-GEX sign change nearest spot (DealerGEX logic).
  const flipLevel = useMemo(() => {
    const rows = gexQ.data?.data
    const spot = gexQ.data?.spot
    if (!rows?.length || !spot) return null
    const sorted = [...rows].sort((a: any, b: any) => a.strike - b.strike)
    let best: number | null = null, bestDist = Infinity
    for (let i = 0; i < sorted.length - 1; i++) {
      if ((sorted[i].net_gex ?? 0) * (sorted[i + 1].net_gex ?? 0) < 0) {
        const cand = Math.abs(sorted[i].strike - spot) <= Math.abs(sorted[i + 1].strike - spot) ? sorted[i].strike : sorted[i + 1].strike
        const dist = Math.abs(cand - spot)
        if (dist < bestDist) { bestDist = dist; best = cand }
      }
    }
    return best
  }, [gexQ.data])

  const overlayDefs = useMemo<OverlayDef[]>(() => {
    const app = APP_OVERLAYS(tf).map(d => {
      if (d.id.startsWith('fund:')) {
        const metric = d.id.slice(5)
        return {
          ...d,
          fetch: async () => {
            const r = await axios.get(`/api/market/fundamental-series?ticker=${encodeURIComponent(ticker)}&metric=${metric}&period=quarter`)
            return (r.data.points ?? []).filter((p: any) => p.value != null).map((p: any) => ({ time: toEpoch(p.date), value: p.value }))
          },
        }
      }
      if (d.id === 'hv30') {
        return {
          ...d,
          fetch: async () => {
            const daily = await fetchCandles(ticker, '1d')
            const hv = hvArr(daily.map(c => c.close), 30)
            return daily.map((c, i) => hv[i] == null ? null : { time: c.time, value: hv[i] as number })
              .filter(Boolean) as { time: number; value: number }[]
          },
        }
      }
      if (d.id === 'xlkrs') {
        return {
          ...d,
          fetch: async () => {
            const [xlk, spy] = await Promise.all([fetchCandles('XLK', tf), fetchCandles('SPY', tf)])
            const spyMap = new Map(spy.map(c => [c.time, c.close]))
            return xlk.map(c => {
              const s = spyMap.get(c.time)
              return s ? { time: c.time, value: +(c.close / s * 100).toFixed(3) } : null
            }).filter(Boolean) as { time: number; value: number }[]
          },
        }
      }
      return d
    })
    return [...compares.map(s => tickerOverlay(s, tf)), ...app]
  }, [tf, ticker, compares])

  const activeOverlayDefs = overlayDefs.filter(d => overlays.includes(d.id) || compares.some(s => d.id === `cmp:${s}`))
  const overlayQs = useQuery({
    queryKey: ['cs-overlays', tf, ticker, activeOverlayDefs.map(d => d.id).join(',')],
    queryFn: async () => {
      const out: Record<string, { time: number; value: number }[]> = {}
      await Promise.all(activeOverlayDefs.map(async d => {
        try { out[d.id] = await d.fetch() } catch { out[d.id] = [] }
      }))
      return out
    },
    enabled: activeOverlayDefs.length > 0, staleTime: 300_000,
  })

  const candles = candlesQ.data ?? []
  const closes = useMemo(() => candles.map(c => c.close), [candles])

  // ── Indicator series data ──
  const indData = useMemo(() => {
    if (!candles.length) return null
    const t = (i: number) => candles[i].time as Time
    const line = (arr: (number | null)[]) => arr.map((v, i) => v == null ? null : { time: t(i), value: v }).filter(Boolean) as { time: Time; value: number }[]
    const bb = bollinger(closes, params.bbP, params.bbK)
    const mc = macdArr(closes, params.macdF, params.macdS, params.macdSig)
    const maLines: Record<string, { time: Time; value: number }[]> = {}
    for (const m of mas) maLines[maKey(m)] = line((m.kind === 'sma' ? smaArr : emaArr)(closes, m.period))
    return {
      maLines,
      vwap: line(vwapArr(candles)),
      bbU: line(bb.upper), bbL: line(bb.lower), bbM: line(bb.mid),
      rsi: line(rsiArr(closes, params.rsiP)),
      macd: line(mc.line), macdSig: line(mc.signal),
      macdHist: mc.hist.map((v, i) => v == null ? null : ({ time: t(i), value: v, color: v >= 0 ? `${C.lanePos}73` : `${C.laneNeg}73` })).filter(Boolean) as any[],
    }
  }, [candles, closes, params, mas, C])

  // GEX lane data ($Bn) + IV rank lane (expanding-window percentile of IV30).
  const gexLane = useMemo(() => {
    const pts = sanitize((gexHistQ.data?.points ?? []).filter((p: any) => p.v != null)
      .map((p: any) => ({ time: toEpoch(p.d), value: +(p.v / 1000).toFixed(3) })))
    return pts
  }, [gexHistQ.data])
  const ivLane = useMemo(() => {
    const raw = sanitize((ivHistQ.data?.points ?? []).filter((p: any) => p.v != null)
      .map((p: any) => ({ time: toEpoch(p.d), value: p.v })))
    if (raw.length >= 5) {
      // Expanding-window IV rank over the accrued history.
      return {
        kind: 'rank' as const,
        pts: raw.map((p, i) => {
          const win = raw.slice(0, i + 1).map(x => x.value)
          const lo = Math.min(...win), hi = Math.max(...win)
          return { time: p.time, value: hi > lo ? +((p.value - lo) / (hi - lo) * 100).toFixed(1) : 50 }
        }),
      }
    }
    return { kind: 'iv' as const, pts: raw }
  }, [ivHistQ.data])

  // ── Chart instances: price + 5 lanes + minimap ──
  const mainRef = useRef<HTMLDivElement>(null)
  const laneRefs = useRef<Record<LaneId, HTMLDivElement | null>>({ volume: null, rsi: null, macd: null, gex: null, iv: null })
  const miniRef = useRef<HTMLDivElement>(null)
  const charts = useRef<{ main?: IChartApi; mini?: IChartApi } & Partial<Record<LaneId, IChartApi>>>({})
  const series = useRef<Record<string, ISeriesApi<any>>>({})
  const overlaySeries = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  const maSeries = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  const flipLine = useRef<IPriceLine | null>(null)
  const store = useRef<Map<string, Sorted>>(new Map())
  const candleStore = useRef<Map<number, Candle>>(new Map())
  const syncing = useRef(false)
  const [windowBox, setWindowBox] = useState<{ left: number; width: number } | null>(null)
  const miniDomain = useRef<{ t0: number; t1: number } | null>(null)

  useEffect(() => {
    if (!mainRef.current || !miniRef.current) return
    const main = createChart(mainRef.current, {
      ...baseOptions(C, 360), width: mainRef.current.clientWidth,
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, barSpacing: 9 },
      handleScroll: { mouseWheel: true, pressedMouseMove: true },
      handleScale: { mouseWheel: true, pinch: true },
    })
    const laneCharts: Partial<Record<LaneId, IChartApi>> = {}
    for (const lane of LANE_DEFS) {
      const el = laneRefs.current[lane.id]
      if (!el) continue
      laneCharts[lane.id] = createChart(el, {
        ...baseOptions(C, lane.h), width: el.clientWidth,
        timeScale: { visible: false }, rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
        // Lanes are followers: a sparse lane (one accrued GEX point) fitting
        // itself must never drag the shared range down to a single day.
        handleScroll: false as any, handleScale: false as any,
      })
    }
    const mini = createChart(miniRef.current, {
      ...baseOptions(C, 42), width: miniRef.current.clientWidth,
      timeScale: { visible: false }, rightPriceScale: { visible: false }, leftPriceScale: { visible: false },
      handleScroll: false as any, handleScale: false as any,
      crosshair: { mode: CrosshairMode.Hidden as any, vertLine: { visible: false }, horzLine: { visible: false } },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
    })

    const candle = main.addCandlestickSeries({
      upColor: C.pos, downColor: C.neg, borderUpColor: C.pos, borderDownColor: C.neg,
      wickUpColor: C.pos, wickDownColor: C.neg, priceLineColor: C.gold, priceLineWidth: 1,
    })
    const bbU = main.addLineSeries({ color: `${C.text}8c`, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const bbL = main.addLineSeries({ color: `${C.text}8c`, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const bbM = main.addLineSeries({ color: `${C.text}59`, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false })
    const vwapS = main.addLineSeries({ color: C.violet, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false })

    const volS = laneCharts.volume?.addHistogramSeries({ priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false })
    const rsiS = laneCharts.rsi?.addLineSeries({ color: C.violet, lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
    rsiS?.createPriceLine({ price: 70, color: `${C.laneNeg}66`, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' })
    rsiS?.createPriceLine({ price: 30, color: `${C.lanePos}66`, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' })
    const macdHist = laneCharts.macd?.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false })
    const macdLine = laneCharts.macd?.addLineSeries({ color: C.blue, lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
    const macdSigS = laneCharts.macd?.addLineSeries({ color: C.gold, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
    const gexS = laneCharts.gex?.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false })
    gexS?.createPriceLine({ price: 0, color: 'rgba(255,255,255,0.2)', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: '' })
    const ivS = laneCharts.iv?.addAreaSeries({ lineColor: C.gold, topColor: `${C.gold}24`, bottomColor: 'transparent', lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
    const miniArea = mini.addAreaSeries({ lineColor: C.gold, topColor: `${C.gold}1f`, bottomColor: 'transparent', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })

    charts.current = { main, mini, ...laneCharts }
    series.current = { candle, bbU, bbL, bbM, vwapS: vwapS!, volS: volS!, rsiS: rsiS!, macdHist: macdHist!, macdLine: macdLine!, macdSigS: macdSigS!, gexS: gexS!, ivS: ivS!, miniArea }

    // One-way time-range sync: the price panel drives, lanes follow. (Logical
    // sync breaks once overlays add weekend time points; two-way sync lets a
    // sparse lane hijack the range.)
    const laneList = Object.values(laneCharts) as IChartApi[]
    main.timeScale().subscribeVisibleTimeRangeChange(vr => {
      if (!vr || syncing.current) return
      syncing.current = true
      for (const t of laneList) { try { t.timeScale().setVisibleRange(vr) } catch { /* no data yet */ } }
      syncing.current = false
    })

    // Minimap window follows the main chart; user range changes flip the
    // window selector to Custom.
    main.timeScale().subscribeVisibleTimeRangeChange(vr => {
      const dom = miniDomain.current
      if (dom && vr) {
        const span = dom.t1 - dom.t0 || 1
        const l = Math.max(0, ((vr.from as number) - dom.t0) / span)
        const rgt = Math.min(1, ((vr.to as number) - dom.t0) / span)
        setWindowBox({ left: l * 100, width: Math.max(0.5, (rgt - l) * 100) })
      }
      if (!applyingSpan.current) setWindowKey('custom')
    })

    // Crosshair: drive the inspector and echo positions into every lane.
    const laneSeriesFor: Partial<Record<LaneId, ISeriesApi<any>>> = { volume: volS, rsi: rsiS, macd: macdLine, gex: gexS, iv: ivS }
    main.subscribeCrosshairMove(param => {
      const t = param.time as number | undefined
      setCrossTime(t ?? null)
      for (const lane of LANE_DEFS) {
        const ch = laneCharts[lane.id]; const ls = laneSeriesFor[lane.id]
        if (!ch || !ls) continue
        try {
          const v = t != null ? floorValExact(store.current.get(`lane:${lane.id}`), t) : null
          if (v != null) ch.setCrosshairPosition(v, t as Time, ls); else ch.clearCrosshairPosition()
        } catch { /* lane mid-swap */ }
      }
    })
    for (const lane of LANE_DEFS) {
      laneCharts[lane.id]?.subscribeCrosshairMove(param => {
        const t = param.time as number | undefined
        if (!t || syncing.current) return
        setCrossTime(t)
        const cd = candleStore.current.get(t)
        try { if (cd) main.setCrosshairPosition(cd.close, t as Time, candle) } catch { /* mid-swap */ }
      })
    }

    const ro = new ResizeObserver(() => {
      const w = mainRef.current?.clientWidth
      if (!w) return
      main.applyOptions({ width: w })
      for (const lane of LANE_DEFS) charts.current[lane.id]?.applyOptions({ width: w })
      mini.applyOptions({ width: w })
    })
    ro.observe(mainRef.current)

    return () => {
      ro.disconnect()
      main.remove(); laneList.forEach(c => c.remove()); mini.remove()
      charts.current = {}; series.current = {}; overlaySeries.current.clear(); maSeries.current.clear(); flipLine.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Exact-time lookup for lane crosshair echoes (no carry-forward: a dot on a
  // sparse lane at a bar with no point would lie).
  const floorValExact = (s: Sorted | undefined, time: number): number | null => {
    if (!s) return null
    let lo = 0, hi = s.t.length - 1
    while (lo <= hi) { const m = (lo + hi) >> 1; if (s.t[m] === time) return s.v[m]; if (s.t[m] < time) lo = m + 1; else hi = m - 1 }
    return null
  }

  // ── Candles + indicators + lanes into series ──
  useEffect(() => {
    const s = series.current
    if (!s.candle || !candles.length) return
    try {
      s.candle.setData(candles.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close })))
      candleStore.current = new Map(candles.map(c => [c.time, c]))
      store.current.set('close', toSorted(candles.map(c => ({ time: c.time, value: c.close }))))
      s.volS.setData(lanes.volume ? candles.map(c => ({ time: c.time as Time, value: c.volume, color: c.close >= c.open ? `${C.lanePos}80` : `${C.laneNeg}80` })) : [])
      store.current.set('lane:volume', lanes.volume ? toSorted(candles.map(c => ({ time: c.time, value: c.volume }))) : { t: [], v: [] })
      if (indData) {
        s.bbU.setData(ind.bb ? indData.bbU : []); s.bbL.setData(ind.bb ? indData.bbL : []); s.bbM.setData(ind.bb ? indData.bbM : [])
        s.vwapS.setData(ind.vwap ? indData.vwap : [])
        s.rsiS.setData(lanes.rsi ? indData.rsi : [])
        s.macdHist.setData(lanes.macd ? indData.macdHist : [])
        s.macdLine.setData(lanes.macd ? indData.macd : []); s.macdSigS.setData(lanes.macd ? indData.macdSig : [])
        const put = (k: string, pts: { time: Time; value: number }[], on: boolean) =>
          store.current.set(k, on ? toSorted(pts as any) : { t: [], v: [] })
        put('bbU', indData.bbU, ind.bb); put('bbL', indData.bbL, ind.bb)
        put('vwap', indData.vwap, ind.vwap)
        put('lane:rsi', indData.rsi, lanes.rsi)
        put('lane:macd', indData.macd, lanes.macd)
        for (const m of mas) put(`ma:${maKey(m)}`, indData.maLines[maKey(m)] ?? [], true)
      }
      charts.current.main?.timeScale().applyOptions({ timeVisible: INTRADAY.has(tf) })
    } catch (e) { console.warn('candle/indicator render failed', e) }
  }, [candles, indData, ind, lanes.volume, lanes.rsi, lanes.macd, mas, tf, C])

  // ── MA series lifecycle ──
  useEffect(() => {
    const main = charts.current.main
    if (!main) return
    const wanted = new Set(mas.map(maKey))
    for (const [key, srs] of maSeries.current) {
      if (!wanted.has(key)) {
        try { main.removeSeries(srs) } catch { /* torn down */ }
        maSeries.current.delete(key); store.current.delete(`ma:${key}`)
      }
    }
    mas.forEach((m, i) => {
      const key = maKey(m)
      try {
        let srs = maSeries.current.get(key)
        if (!srs) {
          srs = main.addLineSeries({ color: MA_PALETTE[i % MA_PALETTE.length], lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
          maSeries.current.set(key, srs)
        }
        srs.setData(indData?.maLines[key] ?? [])
      } catch (e) { console.warn('MA series failed', key, e) }
    })
  }, [mas, indData])

  // ── Overlay series lifecycle ──
  useEffect(() => {
    const main = charts.current.main
    if (!main) return
    const data = overlayQs.data ?? {}
    const wanted = new Set(activeOverlayDefs.map(d => d.id))
    for (const [id, srs] of overlaySeries.current) {
      if (!wanted.has(id)) {
        try { main.removeSeries(srs) } catch { /* torn down */ }
        overlaySeries.current.delete(id); store.current.delete(`ov:${id}`)
      }
    }
    const t0 = candles[0]?.time ?? 0
    const tN = candles.length ? candles[candles.length - 1].time : Infinity
    activeOverlayDefs.forEach((d, i) => {
      const raw = data[d.id]
      if (!raw) return
      try {
        const all = sanitize(raw)
        const pts = all.filter(p => p.time >= t0 && p.time <= tN)
        let srs = overlaySeries.current.get(d.id)
        if (!srs) {
          srs = main.addLineSeries({
            color: OVERLAY_PALETTE[i % OVERLAY_PALETTE.length], lineWidth: 1,
            priceScaleId: `ov-${d.id}`, priceLineVisible: false, lastValueVisible: false,
          })
          main.priceScale(`ov-${d.id}`).applyOptions({ visible: false, scaleMargins: { top: 0.12, bottom: 0.2 } })
          overlaySeries.current.set(d.id, srs)
        }
        srs.setData(pts.map(p => ({ time: p.time as Time, value: p.value })))
        srs.applyOptions({ pointMarkersVisible: pts.length < 30 } as any)
        // Inspector carries the full history forward (monthly feeds resolve
        // even between releases), so store unclamped.
        store.current.set(`ov:${d.id}`, toSorted(all))
      } catch (e) { console.warn('overlay layer failed', d.id, e) }
    })
  }, [overlayQs.data, activeOverlayDefs, candles])

  // ── GEX + IV lanes ──
  useEffect(() => {
    const s = series.current
    if (!s.gexS) return
    try {
      const pts = lanes.gex ? gexLane : []
      s.gexS.setData(pts.map(p => ({ time: p.time as Time, value: p.value, color: p.value >= 0 ? `${C.lanePos}99` : `${C.laneNeg}9e` })))
      store.current.set('lane:gex', toSorted(pts))
    } catch (e) { console.warn('gex lane failed', e) }
  }, [gexLane, lanes.gex, C])
  useEffect(() => {
    const s = series.current
    if (!s.ivS) return
    try {
      const pts = lanes.iv ? ivLane.pts : []
      s.ivS.setData(pts.map(p => ({ time: p.time as Time, value: p.value })))
      s.ivS.applyOptions({ pointMarkersVisible: pts.length < 30 } as any)
      store.current.set('lane:iv', toSorted(pts))
    } catch (e) { console.warn('iv lane failed', e) }
  }, [ivLane, lanes.iv])

  // ── Gamma-flip price line ──
  useEffect(() => {
    const candle = series.current.candle
    if (!candle) return
    if (flipLine.current) { try { candle.removePriceLine(flipLine.current) } catch { /* gone */ } flipLine.current = null }
    if (ind.gflip && flipLevel != null) {
      flipLine.current = candle.createPriceLine({
        price: flipLevel, color: C.violet, lineWidth: 1, lineStyle: LineStyle.Dashed,
        axisLabelVisible: true, title: `γ-flip ${flipLevel}`,
      })
    }
  }, [flipLevel, ind.gflip, C, candles.length > 0])

  // ── Event markers ──
  useEffect(() => {
    const s = series.current.candle
    if (!s) return
    const ev = eventsQ.data
    const markers: SeriesMarker<Time>[] = []
    if (ev) {
      if (events.earnings) for (const e of ev.earnings) markers.push({ time: toEpoch(e.date) as Time, position: 'aboveBar', color: C.gold, shape: 'circle', text: 'E' })
      if (events.dividends) for (const d of ev.dividends) markers.push({ time: toEpoch(d.date) as Time, position: 'belowBar', color: C.blue, shape: 'square', text: 'D' })
      if (events.splits) for (const sp of ev.splits) markers.push({ time: toEpoch(sp.date) as Time, position: 'belowBar', color: C.violet, shape: 'arrowUp', text: 'S' })
    }
    const t0 = candles[0]?.time ?? 0
    const tN = candles.length ? candles[candles.length - 1].time : 0
    try {
      s.setMarkers(markers.filter(m => (m.time as number) >= t0 && (m.time as number) <= tN).sort((a, b) => (a.time as number) - (b.time as number)))
    } catch (e) { console.warn('markers failed', e) }
  }, [eventsQ.data, events, candles, C])

  // ── Minimap ──
  useEffect(() => {
    const daily = dailyQ.data
    const s = series.current.miniArea
    if (!daily?.length || !s) return
    try {
      s.setData(daily.map(c => ({ time: c.time as Time, value: c.close })))
      charts.current.mini?.timeScale().fitContent()
      miniDomain.current = { t0: daily[0].time, t1: daily[daily.length - 1].time }
      const vr = charts.current.main?.timeScale().getVisibleRange()
      if (vr) {
        const span = miniDomain.current.t1 - miniDomain.current.t0 || 1
        const l = Math.max(0, ((vr.from as number) - miniDomain.current.t0) / span)
        const r = Math.min(1, ((vr.to as number) - miniDomain.current.t0) / span)
        setWindowBox({ left: l * 100, width: Math.max(0.5, (r - l) * 100) })
      }
    } catch (e) { console.warn('minimap failed', e) }
  }, [dailyQ.data])

  const dragRef = useRef<{ mode: 'pan' | 'left' | 'right'; startX: number; box: { left: number; width: number } } | null>(null)
  const onMiniPointerDown = (mode: 'pan' | 'left' | 'right') => (e: React.PointerEvent) => {
    if (!windowBox) return
    e.preventDefault(); e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    dragRef.current = { mode, startX: e.clientX, box: windowBox }
  }
  const onMiniPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current
    const dom = miniDomain.current
    const wrap = miniRef.current
    if (!drag || !dom || !wrap) return
    const dxPct = ((e.clientX - drag.startX) / wrap.clientWidth) * 100
    let { left, width } = drag.box
    if (drag.mode === 'pan') left = Math.min(100 - width, Math.max(0, left + dxPct))
    else if (drag.mode === 'left') { const r = left + width; left = Math.min(r - 1, Math.max(0, left + dxPct)); width = r - left }
    else { width = Math.min(100 - left, Math.max(1, width + dxPct)) }
    const span = dom.t1 - dom.t0
    const from = dom.t0 + (left / 100) * span
    const to = dom.t0 + ((left + width) / 100) * span
    try { charts.current.main?.timeScale().setVisibleRange({ from: from as Time, to: to as Time }) } catch { /* mid-reload */ }
  }
  const onMiniPointerUp = () => { dragRef.current = null }

  // ── Window span + candle width ──
  const applySpan = useCallback((key: string) => {
    const main = charts.current.main
    const last = candles.length ? candles[candles.length - 1].time : null
    if (!main || last == null) return
    const def = spansFor(tf).find(s => s.key === key)
    if (!def) return
    applyingSpan.current = true
    try {
      if (def.sec === 0) main.timeScale().fitContent()
      else {
        const from = Math.max(candles[0].time, last - def.sec)
        main.timeScale().setVisibleRange({ from: from as Time, to: last as Time })
      }
    } catch { /* series not populated yet */ }
    // The range-change event lands async: keep the guard up long enough that
    // our own programmatic change never flips the selector to Custom.
    setTimeout(() => { applyingSpan.current = false }, 200)
    setWindowKey(key)
  }, [candles, tf])
  const windowKeyRef = useRef(windowKey)
  useEffect(() => { windowKeyRef.current = windowKey }, [windowKey])
  useEffect(() => {
    if (!candles.length) return
    const wk = windowKeyRef.current
    const valid = spansFor(tf).some(s => s.key === wk) ? wk : (INTRADAY.has(tf) ? '1W' : '3M')
    applySpan(valid)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles])
  useEffect(() => {
    const sp = CANDLE_WIDTHS.find(w => w.key === candleWidth)?.spacing ?? 9
    charts.current.main?.timeScale().applyOptions({ barSpacing: sp })
  }, [candleWidth])

  const submitTicker = () => {
    const v = tickerDraft.trim().toUpperCase()
    if (v) dispatch({ type: 'ticker', v })
  }
  const loadSymbol = (sym: string) => { setTickerDraft(sym); dispatch({ type: 'ticker', v: sym }) }

  // ── Inspector data ──
  const lastC = candles.length ? candles[candles.length - 1] : undefined
  const inspectT = crossTime ?? lastC?.time ?? null
  const inspectC = inspectT != null ? (candleStore.current.get(inspectT) ?? lastC) : lastC
  const barIdx = inspectT != null ? candles.findIndex(c => c.time === inspectT) : candles.length - 1
  const at = (key: string) => inspectT != null ? floorVal(store.current.get(key), inspectT) : null
  const overlayColor = useCallback((id: string, i: number) =>
    overlaySeries.current.get(id)?.options().color ?? OVERLAY_PALETTE[i % OVERLAY_PALETTE.length], [])
  const fmtN = (v: number | null, dp = 2, suffix = '') => v == null ? '—' : `${v.toFixed(dp)}${suffix}`

  const activeLegend = [
    ...mas.map((m, i) => ({ label: `${m.kind.toUpperCase()} ${m.period}`, color: MA_PALETTE[i % MA_PALETTE.length], style: 'line' as GlyphStyle })),
    ...(ind.bb ? [{ label: `BB ${params.bbP}·${params.bbK}`, color: '#8099b0', style: 'dash' as GlyphStyle }] : []),
    ...(ind.vwap ? [{ label: 'VWAP', color: '#c084fc', style: 'dash' as GlyphStyle }] : []),
    ...activeOverlayDefs.map((d, i) => ({ label: d.label, color: overlayColor(d.id, i), style: d.style })),
    ...(ind.gflip && flipLevel != null ? [{ label: `γ-flip ${flipLevel}`, color: '#c084fc', style: 'dash' as GlyphStyle }] : []),
  ]

  const pct = inspectC && inspectC.open ? ((inspectC.close - inspectC.open) / inspectC.open) * 100 : 0
  const gexAt = at('lane:gex')
  const dateOf = (t: number | null) => t == null ? '' : new Date(t * 1000).toISOString().slice(0, 10)

  const inspectorGroups: { group: string; rows: { label: string; value: string; color: string }[] }[] = useMemo(() => {
    const g: { group: string; rows: { label: string; value: string; color: string }[] }[] = []
    if (inspectC) {
      g.push({
        group: `Price · ${ticker}`, rows: [
          { label: 'Open', value: inspectC.open.toFixed(2), color: '#d7e3fc' },
          { label: 'High', value: inspectC.high.toFixed(2), color: '#d7e3fc' },
          { label: 'Low', value: inspectC.low.toFixed(2), color: '#d7e3fc' },
          { label: 'Close', value: inspectC.close.toFixed(2), color: '#d7e3fc' },
          { label: 'Change', value: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, color: pct >= 0 ? C.lanePos : C.laneNeg },
        ],
      })
    }
    const tech: { label: string; value: string; color: string }[] = []
    mas.forEach((m, i) => { const v = at(`ma:${maKey(m)}`); if (v != null) tech.push({ label: `${m.kind.toUpperCase()} ${m.period}`, value: v.toFixed(2), color: MA_PALETTE[i % MA_PALETTE.length] }) })
    if (ind.bb) { const u = at('bbU'), l = at('bbL'); if (u != null) tech.push({ label: 'BB upper', value: u.toFixed(2), color: '#8099b0' }); if (l != null) tech.push({ label: 'BB lower', value: l.toFixed(2), color: '#8099b0' }) }
    if (ind.vwap) { const v = at('vwap'); if (v != null) tech.push({ label: 'VWAP', value: v.toFixed(2), color: '#c084fc' }) }
    if (lanes.rsi) { const v = at('lane:rsi'); if (v != null) tech.push({ label: `RSI ${params.rsiP}`, value: v.toFixed(1), color: '#c084fc' }) }
    if (lanes.macd) { const v = at('lane:macd'); if (v != null) tech.push({ label: 'MACD', value: v.toFixed(2), color: '#60a5fa' }) }
    if (tech.length) g.push({ group: 'Technicals', rows: tech })

    const pos: { label: string; value: string; color: string }[] = []
    if (lanes.gex && gexAt != null) {
      pos.push({ label: 'Dealer net GEX', value: `${gexAt >= 0 ? '+' : ''}${gexAt.toFixed(2)} Bn`, color: gexAt >= 0 ? C.lanePos : C.laneNeg })
      pos.push({ label: 'γ regime', value: gexAt >= 0 ? 'Positive' : 'Negative', color: gexAt >= 0 ? C.lanePos : C.laneNeg })
    }
    if (ind.gflip && flipLevel != null) pos.push({ label: 'γ-flip level', value: String(flipLevel), color: '#c084fc' })
    if (lanes.iv) {
      const v = at('lane:iv')
      if (v != null) pos.push({ label: ivLane.kind === 'rank' ? 'IV rank' : 'ATM IV30', value: ivLane.kind === 'rank' ? v.toFixed(0) : `${v.toFixed(1)}%`, color: C.gold })
      if (ivHistQ.data?.iv_percentile != null) pos.push({ label: 'IV percentile', value: String(ivHistQ.data.iv_percentile), color: C.gold })
    }
    if (pos.length) g.push({ group: 'Positioning', rows: pos })

    const other: { label: string; value: string; color: string }[] = []
    activeOverlayDefs.forEach((d, i) => {
      const v = at(`ov:${d.id}`)
      if (v == null) return
      const dp = Math.abs(v) >= 1000 ? 0 : 2
      other.push({ label: d.label, value: fmtN(v, dp), color: overlayColor(d.id, i) })
    })
    if (other.length) g.push({ group: 'Overlays', rows: other })
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // overlayQs.data/gexLane/candles are deps so the readout refreshes when
    // feeds land, not only on the next crosshair move.
  }, [inspectT, inspectC, mas, ind, lanes, activeOverlayDefs, flipLevel, gexAt, ivLane, params, C, ticker, ivHistQ.data, overlayQs.data, gexLane, candles])

  const watch = ASSET_CLASSES.find(a => a.key === assetClass)?.watch ?? []
  const gexRegime = gexLane.length ? (gexLane[gexLane.length - 1].value >= 0 ? 'POSITIVE γ' : 'NEGATIVE γ') : ''

  return (
    <div style={{ maxWidth: 1680, minWidth: 1180, margin: '0 auto', background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.12)' }}>
      <style>{`
        .cs-row:hover { background: rgba(255,255,255,0.04); }
        .cs-chip:hover { border-color: var(--theme-primary, #c9a84c) !important; color: var(--theme-text, #d7e3fc) !important; }
      `}</style>

      {/* ── Header bar ── */}
      <div style={{ padding: '12px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: '0.22em', color: 'var(--theme-primary, #c9a84c)' }}>UNIFIED CHART OVERLAY</span>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.14em', color: '#3f5670' }}>ALPHATAPE TERMINAL</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.1em', color: '#8099b0' }}>{overlayDefs.length + LANE_DEFS.length + 3} TIME-SERIES FEEDS</span>
          <LiveClock />
        </span>
      </div>

      {/* ── Toolbar ── */}
      <div style={{ padding: '9px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Seg options={ASSET_CLASSES.map(a => ({ key: a.key, label: a.label }))} value={assetClass} onChange={v => dispatch({ type: 'assetClass', v })} ariaLabel="Asset class" />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input value={tickerDraft} onChange={e => setTickerDraft(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && submitTicker()} spellCheck={false} aria-label="Chart symbol"
            style={{ width: 96, background: 'var(--theme-surface, #0d1826)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--theme-primary, #c9a84c)', fontFamily: MONO, fontSize: 15, fontWeight: 700, padding: '4px 8px' }} />
          <button className="cs-chip" onClick={submitTicker} style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', padding: '5px 9px', cursor: 'pointer', background: 'transparent', color: 'var(--theme-secondary, #8099b0)', border: '1px solid rgba(255,255,255,0.14)' }}>LOAD</button>
        </span>
        <span style={{ display: 'flex', gap: 6 }}>
          {watch.map(sym => (
            <button key={sym} className="cs-chip" onClick={() => loadSymbol(sym)} style={{
              fontFamily: MONO, fontSize: 9.5, fontWeight: 600, padding: '3px 8px', cursor: 'pointer',
              background: 'transparent', color: sym === ticker ? 'var(--theme-primary, #c9a84c)' : '#8099b0',
              border: sym === ticker ? '1px solid var(--theme-primary, #c9a84c)' : '1px solid rgba(255,255,255,0.12)',
            }}>{sym}</button>
          ))}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', gap: 4 }}>
            {TFS.map(t => (
              <button key={t} className="cs-chip" onClick={() => dispatch({ type: 'tf', v: t })} style={{
                fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', padding: '4px 8px', cursor: 'pointer',
                background: tf === t ? 'var(--theme-primary, #c9a84c)' : 'transparent',
                color: tf === t ? '#0a0e16' : 'var(--theme-secondary, #8099b0)',
                border: tf === t ? '1px solid var(--theme-primary, #c9a84c)' : '1px solid rgba(255,255,255,0.14)',
              }}>{t.toUpperCase()}</button>
            ))}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ ...eyebrow, fontSize: 8.5 }}>Candle</span>
            <Seg options={CANDLE_WIDTHS.map(w => ({ key: w.key, label: w.key.toUpperCase() }))} value={candleWidth} onChange={v => dispatch({ type: 'candleWidth', v })} ariaLabel="Candle width" />
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ ...eyebrow, fontSize: 8.5 }}>Window</span>
            <select value={windowKey} onChange={e => applySpan(e.target.value)} aria-label="Visible span"
              style={{ background: 'var(--theme-surface, #0d1826)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--theme-primary, #c9a84c)', fontFamily: MONO, fontSize: 10, padding: '3px 6px', cursor: 'pointer' }}>
              {spansFor(tf).map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              {windowKey === 'custom' && <option value="custom" disabled>CUSTOM</option>}
            </select>
          </span>
        </span>
      </div>

      {/* ── Body: rail | chart | inspector ── */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {/* Left rail */}
        <div style={{ width: 236, flex: 'none', background: 'var(--theme-surface, #0d1826)', borderRight: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ padding: '11px 16px 9px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={eyebrow}>Price overlays</span><span style={{ fontFamily: MONO, fontSize: 8, color: '#3f5670' }}>TA</span></div>
            {mas.map((m, i) => (
              <div key={maKey(m)} className="cs-row" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0' }}>
                <span style={{ width: 13, height: 13, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: MA_PALETTE[i % MA_PALETTE.length], border: `1px solid ${MA_PALETTE[i % MA_PALETTE.length]}`, color: '#0a0e16', fontSize: 9, fontWeight: 800 }}>✓</span>
                <span style={{ width: 18, flex: 'none', display: 'flex', justifyContent: 'center' }}><Glyph style="line" color={MA_PALETTE[i % MA_PALETTE.length]} /></span>
                <span style={{ fontFamily: SANS, fontSize: 11, color: 'var(--theme-text, #d7e3fc)' }}>{m.kind.toUpperCase()} {m.period}</span>
                <button onClick={() => dispatch({ type: 'rmMA', key: maKey(m) })} aria-label={`Remove ${m.kind.toUpperCase()} ${m.period}`}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: 11, color: '#56708a' }}>x</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 5, margin: '4px 0 6px' }}>
              <select value={maDraft.kind} onChange={e => setMaDraft(d => ({ ...d, kind: e.target.value as MA['kind'] }))} aria-label="Average type"
                style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--theme-text, #d7e3fc)', fontFamily: MONO, fontSize: 10, padding: '2px 3px' }}>
                <option value="sma">SMA</option><option value="ema">EMA</option>
              </select>
              <input type="number" min={2} max={400} value={maDraft.period} aria-label="Average period"
                onChange={e => setMaDraft(d => ({ ...d, period: Math.round(+e.target.value) }))}
                onKeyDown={e => e.key === 'Enter' && addMA()}
                style={{ width: 48, background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--theme-text, #d7e3fc)', fontFamily: MONO, fontSize: 10, padding: '2px 4px' }} />
              <button className="cs-chip" onClick={addMA} style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, padding: '0 8px', cursor: 'pointer', background: 'transparent', color: 'var(--theme-secondary, #8099b0)', border: '1px solid rgba(255,255,255,0.14)' }}>ADD</button>
            </div>
            <Row label={`Bollinger ${params.bbP}·${params.bbK}`} on={ind.bb} src="computed" color="#8099b0" style="dash" onToggle={() => dispatch({ type: 'ind', k: 'bb' })} />
            <Row label="VWAP" on={ind.vwap} src="computed" color="#c084fc" style="dash" onToggle={() => dispatch({ type: 'ind', k: 'vwap' })} />
            <Row label="Gamma flip" on={ind.gflip} src="Tradier" color="#c084fc" style="dash" onToggle={() => dispatch({ type: 'ind', k: 'gflip' })} />
          </div>

          <div style={{ padding: '11px 16px 9px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={eyebrow}>Sub-panel lanes</span><span style={{ fontFamily: MONO, fontSize: 8, color: '#3f5670' }}>OSC</span></div>
            <Row label="Volume" on={lanes.volume} src="OHLCV" color="#3fb6a0" style="hist" onToggle={() => dispatch({ type: 'lane', k: 'volume' })} />
            <Row label={`RSI ${params.rsiP}`} on={lanes.rsi} src="computed" color="#c084fc" style="line" onToggle={() => dispatch({ type: 'lane', k: 'rsi' })} />
            <Row label={`MACD ${params.macdF}·${params.macdS}·${params.macdSig}`} on={lanes.macd} src="computed" color="#60a5fa" style="line" onToggle={() => dispatch({ type: 'lane', k: 'macd' })} />
            <Row label="Dealer net GEX" on={lanes.gex} src="Tradier" color="#3fb6a0" style="hist" onToggle={() => dispatch({ type: 'lane', k: 'gex' })} />
            <Row label="IV rank" on={lanes.iv} src="accrues" color="#c9a84c" style="area" onToggle={() => dispatch({ type: 'lane', k: 'iv' })} />
          </div>

          {(() => {
            // Global running index so pre-activation fallback colors stay
            // distinct across groups (active series read their real color).
            let idx = compares.length
            return APP_OVERLAY_GROUPS(tf).map(g => (
              <div key={g.group} style={{ padding: '11px 16px 9px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={eyebrow}>{g.group}</span><span style={{ fontFamily: MONO, fontSize: 8, color: '#3f5670' }}>{g.tag}</span></div>
                {g.defs.map(d => {
                  const on = overlays.includes(d.id)
                  const empty = on && overlayQs.data && (overlayQs.data[d.id]?.length ?? 0) === 0 && !overlayQs.isFetching
                  return <Row key={d.id} label={d.label} on={on} src={empty ? 'NO DATA' : d.src} color={overlayColor(d.id, idx++)} style={d.style} onToggle={() => dispatch({ type: 'overlay', id: d.id })} />
                })}
              </div>
            ))
          })()}

          <div style={{ padding: '11px 16px 9px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={eyebrow}>Compare tickers</span><span style={{ fontFamily: MONO, fontSize: 8, color: '#3f5670' }}>MKT</span></div>
            <div style={{ display: 'flex', gap: 5, margin: '4px 0 6px' }}>
              <input value={compareDraft} onChange={e => setCompareDraft(e.target.value.toUpperCase())} placeholder="QQQ"
                onKeyDown={e => { if (e.key === 'Enter' && compareDraft.trim()) { dispatch({ type: 'addCompare', sym: compareDraft.trim() }); setCompareDraft('') } }}
                spellCheck={false} aria-label="Add comparison ticker"
                style={{ flex: 1, minWidth: 0, background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(255,255,255,0.14)', color: 'var(--theme-text, #d7e3fc)', fontFamily: MONO, fontSize: 11, padding: '3px 6px' }} />
              <button className="cs-chip" onClick={() => { if (compareDraft.trim()) { dispatch({ type: 'addCompare', sym: compareDraft.trim() }); setCompareDraft('') } }}
                style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, padding: '0 8px', cursor: 'pointer', background: 'transparent', color: 'var(--theme-secondary, #8099b0)', border: '1px solid rgba(255,255,255,0.14)' }}>ADD</button>
            </div>
            {compares.map((s, i) => (
              <div key={s} className="cs-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <span style={{ width: 10, height: 2, background: overlayColor(`cmp:${s}`, i), flex: 'none' }} />
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--theme-text, #d7e3fc)' }}>{s}</span>
                <button onClick={() => dispatch({ type: 'rmCompare', sym: s })} aria-label={`Remove ${s}`}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: 11, color: '#56708a' }}>x</button>
              </div>
            ))}
          </div>

          <div style={{ padding: '11px 16px 9px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={eyebrow}>Timeline events</span><span style={{ fontFamily: MONO, fontSize: 8, color: '#3f5670' }}>yf</span></div>
            <Row label="Earnings" on={events.earnings} src="yfinance" color="#c9a84c" style="ring" onToggle={() => dispatch({ type: 'event', k: 'earnings' })} />
            <Row label="Dividends" on={events.dividends} src="yfinance" color="#60a5fa" style="ring" onToggle={() => dispatch({ type: 'event', k: 'dividends' })} />
            <Row label="Splits" on={events.splits} src="yfinance" color="#c084fc" style="ring" onToggle={() => dispatch({ type: 'event', k: 'splits' })} />
            <div style={{ fontFamily: SANS, fontSize: 9.5, color: '#3f5670', marginTop: 8, lineHeight: '13px' }}>
              Layers share one timeline on their own scales. Line series ride the price panel, oscillators drop into lanes.
            </div>
          </div>
        </div>

        {/* Chart column */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '7px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', color: '#56708a' }}>ACTIVE OVERLAYS</span>
            {activeLegend.map(l => (
              <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Glyph style={l.style} color={l.color} />
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: '#a9bacf' }}>{l.label}</span>
              </span>
            ))}
          </div>

          <div style={{ position: 'relative' }}>
            <div ref={mainRef} style={{ width: '100%' }} />
            <div style={{ position: 'absolute', top: 8, left: 10, zIndex: 5, pointerEvents: 'none', background: 'rgba(10,14,22,0.74)', border: '1px solid rgba(255,255,255,0.08)', padding: '5px 11px', display: 'flex', gap: 10, fontFamily: MONO, fontSize: 10.5, flexWrap: 'wrap' }}>
              {inspectC && (
                <>
                  <span style={{ color: 'var(--theme-text, #d7e3fc)', fontWeight: 700, whiteSpace: 'nowrap' }}>{ticker} · {tf.toUpperCase()}</span>
                  <span style={{ color: '#8099b0', whiteSpace: 'nowrap' }}>O <b style={{ color: '#d7e3fc' }}>{inspectC.open.toFixed(2)}</b></span>
                  <span style={{ color: '#8099b0', whiteSpace: 'nowrap' }}>H <b style={{ color: '#d7e3fc' }}>{inspectC.high.toFixed(2)}</b></span>
                  <span style={{ color: '#8099b0', whiteSpace: 'nowrap' }}>L <b style={{ color: '#d7e3fc' }}>{inspectC.low.toFixed(2)}</b></span>
                  <span style={{ color: '#8099b0', whiteSpace: 'nowrap' }}>C <b style={{ color: '#d7e3fc' }}>{inspectC.close.toFixed(2)}</b></span>
                  <span style={{ color: pct >= 0 ? C.lanePos : C.laneNeg, fontWeight: 700, whiteSpace: 'nowrap' }}>{pct >= 0 ? '+' : ''}{pct.toFixed(2)}%</span>
                </>
              )}
            </div>
            {candlesQ.isLoading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(16,28,46,0.6)', zIndex: 6 }}>
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: '#8099b0' }}>LOADING {ticker}…</span>
              </div>
            )}
            {candlesQ.isError && !candlesQ.isLoading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 6 }}>
                <span style={{ fontFamily: SANS, fontSize: 11, color: '#8099b0' }}>No data for {ticker} at {tf.toUpperCase()}. Try another symbol or timeframe.</span>
              </div>
            )}
          </div>

          {LANE_DEFS.map(lane => {
            const on = lanes[lane.id]
            const header = lane.id === 'gex'
              ? <>DEALER NET GEX $Bn {gexRegime && <b style={{ color: gexRegime.startsWith('POS') ? C.lanePos : C.laneNeg }}> · {gexRegime}</b>}{gexLane.length < 30 && <span style={{ color: '#3f5670' }}> · accrues daily</span>}</>
              : lane.id === 'iv'
                ? <>{ivLane.kind === 'rank' ? 'IV RANK' : 'ATM IV30'}{ivLane.pts.length < 30 && <span style={{ color: '#3f5670' }}> · accrues daily</span>}</>
                : lane.id === 'rsi' ? `RSI ${params.rsiP}` : lane.id === 'macd' ? `MACD ${params.macdF}·${params.macdS}·${params.macdSig}` : lane.label
            return (
              <div key={lane.id} style={{ display: on ? 'block' : 'none', borderTop: '1px solid rgba(255,255,255,0.06)', position: 'relative' }}>
                <span style={{ position: 'absolute', top: 4, left: 10, zIndex: 5, fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.16em', color: '#56708a' }}>{header}</span>
                <div ref={el => { laneRefs.current[lane.id] = el }} style={{ width: '100%' }} />
              </div>
            )
          })}

          {/* Minimap */}
          <div style={{ borderTop: '1px solid rgba(201,168,76,0.28)', position: 'relative' }}
            onPointerMove={onMiniPointerMove} onPointerUp={onMiniPointerUp}>
            <div ref={miniRef} style={{ width: '100%' }} />
            {windowBox && (
              <>
                <div onPointerDown={onMiniPointerDown('pan')} role="slider" aria-label="Visible range" aria-valuenow={Math.round(windowBox.left)}
                  style={{ position: 'absolute', top: 0, bottom: 0, left: `${windowBox.left}%`, width: `${windowBox.width}%`, background: 'rgba(201,168,76,0.08)', border: '1px solid rgba(201,168,76,0.5)', cursor: 'grab', zIndex: 4 }} />
                <div onPointerDown={onMiniPointerDown('left')} role="slider" aria-label="Range start" aria-valuenow={Math.round(windowBox.left)} style={{ position: 'absolute', top: 0, bottom: 0, left: `calc(${windowBox.left}% - 3px)`, width: 7, cursor: 'ew-resize', zIndex: 5 }} />
                <div onPointerDown={onMiniPointerDown('right')} role="slider" aria-label="Range end" aria-valuenow={Math.round(windowBox.left + windowBox.width)} style={{ position: 'absolute', top: 0, bottom: 0, left: `calc(${windowBox.left + windowBox.width}% - 3px)`, width: 7, cursor: 'ew-resize', zIndex: 5 }} />
              </>
            )}
          </div>
        </div>

        {/* Right inspector */}
        <div style={{ width: 272, flex: 'none', background: 'var(--theme-surface, #0d1826)', borderLeft: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ padding: '12px 16px 10px', borderBottom: '1px solid rgba(201,168,76,0.3)', background: 'rgba(201,168,76,0.05)' }}>
            <div style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', color: '#56708a' }}>READOUT AT CROSSHAIR</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 3 }}>
              <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)' }}>{dateOf(inspectT) || '—'}</span>
              {barIdx >= 0 && <span style={{ fontFamily: MONO, fontSize: 10, color: '#8099b0' }}>bar {barIdx + 1} / {candles.length}</span>}
            </div>
          </div>
          {inspectorGroups.map(g => (
            <div key={g.group} style={{ padding: '9px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
              <div style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: '#56708a', marginBottom: 5 }}>{g.group}</div>
              {g.rows.map(r => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, lineHeight: '19px' }}>
                  <span style={{ fontFamily: SANS, fontSize: 10.5, color: '#7f97af' }}>{r.label}</span>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 600, color: r.color, fontVariantNumeric: 'tabular-nums' }}>{r.value}</span>
                </div>
              ))}
            </div>
          ))}
          <div style={{ padding: '9px 16px', fontFamily: SANS, fontSize: 9.5, color: '#3f5670', lineHeight: '13px' }}>
            Every active series resolves its value at the crosshair timestamp. Monthly and quarterly feeds carry forward from their last release.
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ChartStudio() {
  return <PageWrapper><ChartStudioContent /></PageWrapper>
}
