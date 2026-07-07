import { useEffect, useMemo, useReducer, useRef, useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  createChart, ColorType, CrosshairMode, LineStyle,
  type IChartApi, type ISeriesApi, type Time, type SeriesMarker, type IPriceLine,
} from 'lightweight-charts'
import { ChevronLeft, ChevronRight } from 'lucide-react'
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

type IndLaneId = 'volume' | 'rsi' | 'macd' | 'iv'
type LaneId = IndLaneId | 'ov0' | 'ov1' | 'ov2' | 'ov3' | 'ov4'
// Reorderable indicator lanes (the rail toggles / reorders these).
const LANE_IDS: IndLaneId[] = ['volume', 'rsi', 'macd', 'iv']
// Fixed pool of per-overlay lanes: each series set to LANE gets its own section
// below the chart (no shared overlay lane). Pre-created so charts exist on mount.
const OV_LANE_IDS: LaneId[] = ['ov0', 'ov1', 'ov2', 'ov3', 'ov4']

// Per-layer display config: how tall the series draws (scale-margin band on
// its hidden price scale) and whether it rides the price panel or drops into
// the shared overlay lane below the chart.
type LayerSize = 'S' | 'M' | 'L'
interface LayerCfg { size: LayerSize; place: 'chart' | 'lane' }
const SIZE_MARGINS: Record<LayerSize, { top: number; bottom: number }> = {
  S: { top: 0.62, bottom: 0.04 }, M: { top: 0.25, bottom: 0.08 }, L: { top: 0.04, bottom: 0.04 },
}
const GEX_WIDTHS: Record<LayerSize, number> = { S: 80, M: 140, L: 220 }

type AssetClass = 'equities' | 'index' | 'futures' | 'fx'
const ASSET_CLASSES: { key: AssetClass; label: string }[] = [
  { key: 'equities', label: 'EQUITIES' },
  { key: 'index', label: 'INDEX' },
  { key: 'futures', label: 'FUTURES' },
  { key: 'fx', label: 'FX' },
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

// `cadence` is the honest update rhythm of the underlying feed, surfaced in
// the inspector so the user knows how fresh each displayed series is.
interface OverlayDef { id: string; label: string; src: string; style: GlyphStyle; cadence: string; fetch: () => Promise<{ time: number; value: number }[]> }

const tickerOverlay = (sym: string, tf: TF): OverlayDef => ({
  id: `cmp:${sym}`, label: sym, src: 'OHLCV', style: 'line', cadence: 'per bar',
  fetch: async () => (await fetchCandles(sym, tf)).map(c => ({ time: c.time, value: c.close })),
})

const curveSpread = (name: string): OverlayDef => ({
  id: `spread:${name}`, label: `${name} spread`, src: 'FRED', style: 'line', cadence: 'daily · 1h cache',
  fetch: async () => {
    const r = await axios.get('/api/rates/curve-spreads')
    const s = r.data.spreads.find((x: any) => x.name === name)
    return (s?.history ?? []).map((p: any) => ({ time: toEpoch(p.date), value: p.bp }))
  },
})

const creditOas = (key: 'ig_oas' | 'hy_oas', label: string): OverlayDef => ({
  id: key, label, src: 'FRED', style: 'line', cadence: 'daily · 1h cache',
  fetch: async () => {
    const r = await axios.get('/api/rates/credit-spreads?lookback=365')
    return (r.data.series?.[key]?.history ?? []).filter((p: any) => p.value != null)
      .map((p: any) => ({ time: toEpoch(p.date), value: p.value }))
  },
})

// `fund:*`, `hv30` and `snap:*` are re-bound to the active primary
// ticker inside the component; placeholder fetches keep the registry uniform.
const fundMetric = (metric: string, label: string): OverlayDef => ({
  id: `fund:${metric}`, label, src: 'FMP', style: 'diamond', cadence: 'quarterly', fetch: async () => [],
})

interface OverlayGroup { group: string; tag: string; defs: OverlayDef[] }
const APP_OVERLAY_GROUPS = (tf: TF, hvP = 30): OverlayGroup[] => [
  {
    group: 'Rates & macro', tag: 'FRED', defs: [
      { ...tickerOverlay('^TNX', tf), id: 'us10y', label: 'US 10Y yield', src: 'CBOE' },
      { ...tickerOverlay('^IRX', tf), id: 'us3m', label: 'US 3M yield', src: 'CBOE' },
      curveSpread('2s10s'), curveSpread('3M10Y'),
      {
        id: 'cpi', label: 'CPI YoY', src: 'FRED', style: 'diamond', cadence: 'monthly',
        fetch: async () => {
          const r = await axios.get('/api/rates/economy')
          return (r.data.inflation?.trend ?? []).filter((p: any) => p.cpi != null).map((p: any) => ({ time: monthEpoch(p.d), value: p.cpi }))
        },
      },
      {
        id: 'unemp', label: 'Unemployment', src: 'FRED', style: 'diamond', cadence: 'monthly',
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
      { ...tickerOverlay('^VIX', tf), id: 'vix', label: 'VIX', src: 'CBOE' },
      { id: 'hv30', label: `HV ${hvP}d`, src: 'Computed', style: 'line', cadence: 'daily', fetch: async () => [] },
      {
        id: 'hormuz', label: 'Hormuz transits', src: 'PortWatch', style: 'diamond', cadence: 'daily · 4d lag',
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
const APP_OVERLAYS = (tf: TF, hvP = 30): OverlayDef[] => APP_OVERLAY_GROUPS(tf, hvP).flatMap(g => g.defs)

// ── State machine ────────────────────────────────────────────────────────────
interface Params { bbP: number; bbK: number; rsiP: number; macdF: number; macdS: number; macdSig: number; hvP: number }
interface MA { kind: 'sma' | 'ema'; period: number }
const maKey = (m: MA) => `${m.kind}${m.period}`
interface State {
  ticker: string
  assetClass: AssetClass
  tf: TF
  candleWidth: CandleWidth
  ind: { bb: boolean; vwap: boolean; gflip: boolean; gexProfile: boolean }
  lanes: { volume: boolean; rsi: boolean; macd: boolean; iv: boolean }
  laneOrder: IndLaneId[]
  layerCfg: Record<string, Partial<LayerCfg>>
  railOpen: boolean
  inspectorOpen: boolean
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
  | { type: 'moveLane'; id: IndLaneId; dir: 'up' | 'down' }
  | { type: 'layerCfg'; id: string; patch: Partial<LayerCfg> }
  | { type: 'toggleRail' } | { type: 'toggleInspector' }
  | { type: 'param'; k: keyof Params; v: number }

// Clean slate by default: candles and volume only, every overlay opt-in.
const DEFAULT: State = {
  ticker: 'SPY', assetClass: 'equities', tf: '1d', candleWidth: 'med',
  ind: { bb: false, vwap: false, gflip: false, gexProfile: false },
  lanes: { volume: true, rsi: false, macd: false, iv: false },
  laneOrder: [...LANE_IDS],
  layerCfg: {}, railOpen: true, inspectorOpen: true,
  mas: [],
  events: { earnings: false, dividends: false, splits: false },
  overlays: [], compares: [],
  params: { bbP: 20, bbK: 2, rsiP: 14, macdF: 12, macdS: 26, macdSig: 9, hvP: 30 },
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
    case 'moveLane': {
      const order = [...s.laneOrder]
      const i = order.indexOf(a.id)
      const j = i + (a.dir === 'up' ? -1 : 1)
      if (i < 0 || j < 0 || j >= order.length) return s
      ;[order[i], order[j]] = [order[j], order[i]]
      return { ...s, laneOrder: order }
    }
    case 'layerCfg': return { ...s, layerCfg: { ...s.layerCfg, [a.id]: { ...s.layerCfg[a.id], ...a.patch } } }
    case 'toggleRail': return { ...s, railOpen: !s.railOpen }
    case 'toggleInspector': return { ...s, inspectorOpen: !s.inspectorOpen }
    case 'param': return { ...s, params: { ...s.params, [a.k]: a.v } }
  }
}

const load = (): State => {
  try {
    // v2 key: earlier keys carried the old default-on overlay set, and the
    // tool now starts clean for everyone.
    const raw = JSON.parse(localStorage.getItem('unifiedOverlay2') || 'null')
    if (!raw) return DEFAULT
    const mas: MA[] = Array.isArray(raw.mas) ? raw.mas.filter((m: any) => (m?.kind === 'sma' || m?.kind === 'ema') && m.period >= 2) : []
    const stored: IndLaneId[] = Array.isArray(raw.laneOrder) ? raw.laneOrder.filter((id: any) => (LANE_IDS as string[]).includes(id)) : []
    const laneOrder = [...stored, ...LANE_IDS.filter(id => !stored.includes(id))]
    // Old shape: rsi/macd/volume lived in `ind`; lanes did not exist.
    const lanes = { ...DEFAULT.lanes, ...(raw.lanes ?? {}), ...(raw.ind?.rsi != null ? { rsi: raw.ind.rsi } : {}), ...(raw.ind?.macd != null ? { macd: raw.ind.macd } : {}), ...(raw.ind?.volume != null ? { volume: raw.ind.volume } : {}) }
    const ind = { ...DEFAULT.ind, ...(raw.ind?.bb != null ? { bb: raw.ind.bb } : {}), ...(raw.ind?.vwap != null ? { vwap: raw.ind.vwap } : {}), ...(raw.ind?.gflip != null ? { gflip: raw.ind.gflip } : {}), ...(raw.ind?.gexProfile != null ? { gexProfile: raw.ind.gexProfile } : {}) }
    return { ...DEFAULT, ...raw, mas, ind, lanes, laneOrder, events: { ...DEFAULT.events, ...raw.events }, params: { ...DEFAULT.params, ...raw.params } }
  } catch { return DEFAULT }
}

// ── Theme (concrete values — canvas cannot read CSS vars) ───────────────────
function chartColors() {
  const t = (n: string, fb: string) => readToken(n, fb) || fb
  const bg = t('--theme-bg', '#101c2e')
  // White hairlines vanish on light presets: derive grid/borders from the
  // background's own luminance instead.
  const hex = bg.replace('#', '')
  const [r, g, b] = hex.length >= 6 ? [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) : [16, 28, 46]
  const isLight = (0.299 * r + 0.587 * g + 0.114 * b) > 140
  return {
    bg, surface: t('--theme-surface', '#0d1826'),
    gold: t('--theme-primary', '#c9a84c'), text: t('--theme-secondary', '#8099b0'),
    pos: '#22c55e', neg: '#ef4444', lanePos: '#3fb6a0', laneNeg: '#cf4b3f',
    blue: t('--theme-tertiary', '#60a5fa'), violet: t('--theme-accent-violet', '#c084fc'),
    grid: isLight ? 'rgba(40,20,20,0.07)' : 'rgba(255,255,255,0.045)',
    axisBorder: isLight ? 'rgba(40,20,20,0.16)' : 'rgba(255,255,255,0.08)',
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

// Main chart height is user-draggable and persisted per-device.
const MAIN_H_KEY = 'cs_main_height'
const MAIN_H_MIN = 240
const MAIN_H_MAX = 900
const MAIN_H_DEFAULT = 360

const baseOptions = (C: Colors, h: number) => ({
  layout: { background: { type: ColorType.Solid, color: C.bg }, textColor: C.text, fontFamily: "ui-monospace, monospace", fontSize: 10, attributionLogo: false },
  grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: `${C.gold}66`, labelBackgroundColor: C.surface },
    horzLine: { color: `${C.gold}66`, labelBackgroundColor: C.surface },
  },
  rightPriceScale: { borderColor: C.axisBorder },
  timeScale: { borderColor: C.axisBorder },
  height: h,
})

// ── UI primitives ────────────────────────────────────────────────────────────
const MONO = 'var(--theme-mono)'
const SANS = 'var(--theme-sans)'
const eyebrow: React.CSSProperties = { fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)' }

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
      <span style={{ width: 13, height: 13, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: on ? color : 'transparent', border: on ? `1px solid ${color}` : '1px solid var(--theme-border, rgba(255,255,255,0.22))', color: 'var(--theme-bg, #0a0e16)', fontSize: 9, fontWeight: 800 }}>{on ? '✓' : ''}</span>
      <span style={{ width: 18, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Glyph style={style} color={color} /></span>
      <span style={{ fontFamily: SANS, fontSize: 11, color: on ? 'var(--theme-text, #d7e3fc)' : 'var(--theme-secondary, #8099b0)' }}>{label}</span>
      <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 8, color: 'var(--theme-secondary, #8099b0)' }}>{src}</span>
    </div>
  )
}

// Compact per-layer controls shown under an active row: scale-band size on the
// price panel, and where the series draws (price panel vs the overlay lane).
function CfgChips({ label, cfg, showPlace, onPatch }: {
  label: string; cfg: LayerCfg; showPlace: boolean; onPatch: (p: Partial<LayerCfg>) => void
}) {
  const chip = (on: boolean): React.CSSProperties => ({
    fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', padding: '1px 5px', cursor: 'pointer',
    background: on ? 'var(--theme-primary, #c9a84c)' : 'transparent',
    color: on ? 'var(--theme-bg, #0a0e16)' : 'var(--theme-secondary, #8099b0)',
    border: on ? '1px solid var(--theme-primary, #c9a84c)' : '1px solid var(--theme-border, rgba(255,255,255,0.14))',
  })
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '0 0 4px 40px' }}>
      {(!showPlace || cfg.place === 'chart') && (['S', 'M', 'L'] as LayerSize[]).map(s => (
        <button key={s} onClick={() => onPatch({ size: s })} aria-label={`${label} size ${s}`} style={chip(cfg.size === s)}>{s}</button>
      ))}
      {showPlace && (
        <>
          <span style={{ width: 5 }} />
          <button onClick={() => onPatch({ place: 'chart' })} aria-label={`Draw ${label} on the price chart`} style={chip(cfg.place === 'chart')}>CHART</button>
          <button onClick={() => onPatch({ place: 'lane' })} aria-label={`Draw ${label} in the lane below`} style={chip(cfg.place === 'lane')}>LANE</button>
        </>
      )}
    </div>
  )
}

// Inline numeric parameter editor shown under an active indicator row, same
// pattern as the SMA/EMA period input.
function NumParam({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
      <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', color: 'var(--theme-secondary, #8099b0)' }}>{label}</span>
      <input type="number" value={value} min={min} max={max} step={step ?? 1} aria-label={`${label} parameter`}
        onChange={e => {
          const v = +e.target.value
          if (Number.isFinite(v) && v >= min && v <= max) onChange(step && step < 1 ? v : Math.round(v))
        }}
        style={{ width: 44, background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', color: 'var(--theme-text, #d7e3fc)', fontFamily: MONO, fontSize: 10, padding: '1px 3px' }} />
    </span>
  )
}

const paramRow: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'center', padding: '0 0 4px 40px' }

function Seg<T extends string>({ options, value, onChange, ariaLabel }: { options: { key: T; label: string }[]; value: T; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div role="group" aria-label={ariaLabel} style={{ display: 'flex', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))' }}>
      {options.map(o => (
        <button key={o.key} className={value === o.key ? '' : 'cs-chip'} onClick={() => onChange(o.key)} style={{
          fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', padding: '4px 10px', cursor: 'pointer', border: 'none',
          background: value === o.key ? 'var(--theme-primary, #c9a84c)' : 'transparent',
          color: value === o.key ? 'var(--theme-bg, #0a0e16)' : 'var(--theme-secondary, #8099b0)',
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
      <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--theme-secondary, #8099b0)' }}>LIVE · {clock} ET</span>
    </span>
  )
}

// ── Lanes ─────────────────────────────────────────────────────────────────────
const LANE_DEFS: { id: LaneId; h: number; label: string }[] = [
  { id: 'volume', h: 60, label: 'VOLUME' },
  { id: 'rsi', h: 78, label: 'RSI' },
  { id: 'macd', h: 92, label: 'MACD' },
  { id: 'iv', h: 78, label: 'IV RANK' },
  ...OV_LANE_IDS.map(id => ({ id, h: 96, label: 'OVERLAY' })),
]

// ── Main component ───────────────────────────────────────────────────────────
export function ChartStudioContent() {
  const [state, dispatch] = useReducer(reducer, undefined, load)
  const { ticker, assetClass, tf, candleWidth, ind, lanes, laneOrder, layerCfg, railOpen, inspectorOpen, mas, events, overlays, compares, params } = state
  const cfgOf = (id: string): LayerCfg => ({ size: 'M', place: 'chart', ...layerCfg[id] })
  const [tickerDraft, setTickerDraft] = useState(ticker)
  const [compareDraft, setCompareDraft] = useState('')
  const [maDraft, setMaDraft] = useState<MA>({ kind: 'ema', period: 21 })
  const [windowKey, setWindowKey] = useState('3M')
  const [crossTime, setCrossTime] = useState<number | null>(null)
  const [scaleTick, setScaleTick] = useState(0)   // bumps when the price scale can have moved
  const applyingSpan = useRef(false)
  const addMA = () => {
    if (maDraft.period >= 2 && maDraft.period <= 400) dispatch({ type: 'addMA', ma: { ...maDraft } })
  }
  const setParam = (k: keyof Params) => (v: number) => dispatch({ type: 'param', k, v })

  useEffect(() => { localStorage.setItem('unifiedOverlay2', JSON.stringify(state)) }, [state])
  const C = useMemo(chartColors, [])

  // ── Data ──
  const candleRefreshMs = INTRADAY.has(tf) ? 60_000 : 300_000
  // refetchIntervalInBackground keeps candles ticking while the tab is not
  // focused (react-query pauses interval refetches in the background by default).
  const candlesQ = useQuery({ queryKey: ['cs-candles', ticker, tf], queryFn: () => fetchCandles(ticker, tf), staleTime: candleRefreshMs, refetchInterval: candleRefreshMs, refetchIntervalInBackground: true, retry: 1 })
  const eventsQ = useQuery<ChartEvents>({
    queryKey: ['cs-events', ticker],
    queryFn: () => axios.get(`/api/market/chart-events?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 6 * 3600_000, retry: 1,
  })
  const gexQ = useQuery({
    queryKey: ['cs-gexprofile', ticker],
    queryFn: () => axios.get(`/api/options/gex?ticker=${encodeURIComponent(ticker)}`).then(r => r.data),
    enabled: ind.gflip || ind.gexProfile, staleTime: 1800_000, retry: 1,
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
    const app = APP_OVERLAYS(tf, params.hvP).map(d => {
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
            const hv = hvArr(daily.map(c => c.close), params.hvP)
            return daily.map((c, i) => hv[i] == null ? null : { time: c.time, value: hv[i] as number })
              .filter(Boolean) as { time: number; value: number }[]
          },
        }
      }
      return d
    })
    return [...compares.map(s => tickerOverlay(s, tf)), ...app]
  }, [tf, ticker, compares, params.hvP])

  const activeOverlayDefs = overlayDefs.filter(d => overlays.includes(d.id) || compares.some(s => d.id === `cmp:${s}`))
  const overlayQs = useQuery({
    queryKey: ['cs-overlays', tf, ticker, params.hvP, activeOverlayDefs.map(d => d.id).join(',')],
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
      vwap: line(vwapArr(candles, INTRADAY.has(tf))),
      bbU: line(bb.upper), bbL: line(bb.lower), bbM: line(bb.mid),
      rsi: line(rsiArr(closes, params.rsiP)),
      macd: line(mc.line), macdSig: line(mc.signal),
      macdHist: mc.hist.map((v, i) => v == null ? null : ({ time: t(i), value: v, color: v >= 0 ? `${C.lanePos}73` : `${C.laneNeg}73` })).filter(Boolean) as any[],
    }
  }, [candles, closes, params, mas, C])

  // GEX lane data ($Bn) + IV rank lane (expanding-window percentile of IV30).
  // Net dealer GEX ($Bn) from the live by-strike profile.
  const gexNet = useMemo(() => {
    const rows = gexQ.data?.data
    if (!rows?.length) return null
    return rows.reduce((a: number, r: any) => a + (r.net_gex ?? 0), 0) / 1000
  }, [gexQ.data])

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
  const laneRefs = useRef<Record<LaneId, HTMLDivElement | null>>({ volume: null, rsi: null, macd: null, iv: null, ov0: null, ov1: null, ov2: null, ov3: null, ov4: null })
  const charts = useRef<{ main?: IChartApi } & Partial<Record<LaneId, IChartApi>>>({})
  const series = useRef<Record<string, ISeriesApi<any>>>({})
  // Each overlay tracks its owner chart and price scale so it can move between
  // the price panel and the overlay lane when the user changes placement.
  const overlaySeries = useRef<Map<string, { srs: ISeriesApi<'Line'>; owner: IChartApi; scaleId: string }>>(new Map())
  const maSeries = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  const flipLine = useRef<IPriceLine | null>(null)
  const store = useRef<Map<string, Sorted>>(new Map())
  const candleStore = useRef<Map<number, Candle>>(new Map())
  const syncing = useRef(false)
  const echoing = useRef(false)

  // Draggable main-chart height (persisted). The chart is created once; height
  // changes are pushed via applyOptions so state is never lost on resize.
  const [mainHeight, setMainHeight] = useState<number>(() => {
    const v = Number(localStorage.getItem(MAIN_H_KEY))
    return v >= MAIN_H_MIN && v <= MAIN_H_MAX ? v : MAIN_H_DEFAULT
  })
  const [handleHover, setHandleHover] = useState(false)
  const dragState = useRef<{ startY: number; startH: number } | null>(null)
  const onHandleDown = (e: React.PointerEvent) => {
    e.preventDefault()
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* older browser */ }
    dragState.current = { startY: e.clientY, startH: mainHeight }
  }
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragState.current) return
    const next = dragState.current.startH + (e.clientY - dragState.current.startY)
    setMainHeight(Math.max(MAIN_H_MIN, Math.min(MAIN_H_MAX, Math.round(next))))
  }
  const onHandleUp = (e: React.PointerEvent) => {
    dragState.current = null
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  }
  useEffect(() => {
    if (!mainRef.current) return
    const main = createChart(mainRef.current, {
      ...baseOptions(C, mainHeight), width: mainRef.current.clientWidth,
      timeScale: { borderColor: C.axisBorder, timeVisible: true, secondsVisible: false, barSpacing: 9 },
      handleScroll: { mouseWheel: false, pressedMouseMove: true },
      // Native wheel zoom is sluggish: replaced by the amplified cursor-pivot
      // handler below (same pattern as PaperChart, higher coefficient).
      handleScale: { mouseWheel: false, pinch: true },
    })
    const wheelEl = mainRef.current
    const onWheel = (e: WheelEvent) => {
      const ts = main.timeScale()
      const range = ts.getVisibleLogicalRange()
      if (!range) return
      e.preventDefault()
      const rect = wheelEl.getBoundingClientRect()
      const width = range.to - range.from
      // Trackpad horizontal swipe pans; vertical wheel zooms.
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const shift = e.deltaX * (width / rect.width)
        try { ts.setVisibleLogicalRange({ from: range.from + shift, to: range.to + shift }) } catch { /* no data */ }
        return
      }
      const pivot = ts.coordinateToLogical(e.clientX - rect.left)
      const factor = Math.exp(e.deltaY * (e.ctrlKey ? 0.02 : 0.003))
      const newWidth = Math.min(Math.max(6, width * factor), 60000)
      const p = pivot == null ? range.from + width / 2 : pivot
      const newFrom = p - (p - range.from) * (newWidth / width)
      try { ts.setVisibleLogicalRange({ from: newFrom, to: newFrom + newWidth }) } catch { /* no data yet */ }
    }
    wheelEl.addEventListener('wheel', onWheel, { passive: false })
    const laneCharts: Partial<Record<LaneId, IChartApi>> = {}
    for (const lane of LANE_DEFS) {
      const el = laneRefs.current[lane.id]
      if (!el) continue
      laneCharts[lane.id] = createChart(el, {
        ...baseOptions(C, lane.h), width: el.clientWidth,
        timeScale: { visible: false }, rightPriceScale: { borderColor: C.axisBorder },
        // Lanes are followers: a sparse lane (one accrued GEX point) fitting
        // itself must never drag the shared range down to a single day.
        handleScroll: false as any, handleScale: false as any,
      })
    }
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
    const ivS = laneCharts.iv?.addAreaSeries({ lineColor: C.gold, topColor: `${C.gold}24`, bottomColor: 'transparent', lineWidth: 2, priceLineVisible: false, lastValueVisible: false })
    charts.current = { main, ...laneCharts }
    series.current = { candle, bbU, bbL, bbM, vwapS: vwapS!, volS: volS!, rsiS: rsiS!, macdHist: macdHist!, macdLine: macdLine!, macdSigS: macdSigS!, ivS: ivS! }

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

    // User range changes flip the window selector to Custom.
    main.timeScale().subscribeVisibleTimeRangeChange(() => {
      if (!applyingSpan.current) setWindowKey('custom')
      setScaleTick(t => t + 1)
    })

    // Crosshair: drive the inspector and echo positions into every lane.
    // Programmatic setCrosshairPosition fires the same subscription as a real
    // mouse move, so echoes must be guarded (like range sync) or the handlers
    // feed back — clearing the crosshair on the very lane being hovered, which
    // flickers against the native one on every mousemove.
    const laneSeriesFor: Partial<Record<LaneId, ISeriesApi<any>>> = { volume: volS, rsi: rsiS, macd: macdLine, iv: ivS }
    const echoLanes = (t: number | undefined, exclude?: LaneId) => {
      for (const lane of LANE_DEFS) {
        if (lane.id === exclude) continue
        const ch = laneCharts[lane.id]; const ls = laneSeriesFor[lane.id]
        if (!ch || !ls) continue
        try {
          const v = t != null ? floorValExact(store.current.get(`lane:${lane.id}`), t) : null
          if (v != null) ch.setCrosshairPosition(v, t as Time, ls); else ch.clearCrosshairPosition()
        } catch { /* lane mid-swap */ }
      }
    }
    main.subscribeCrosshairMove(param => {
      if (echoing.current) return
      const t = param.time as number | undefined
      setCrossTime(t ?? null)
      echoing.current = true
      echoLanes(t)
      echoing.current = false
    })
    for (const lane of LANE_DEFS) {
      laneCharts[lane.id]?.subscribeCrosshairMove(param => {
        const t = param.time as number | undefined
        if (!t || syncing.current || echoing.current) return
        setCrossTime(t)
        echoing.current = true
        const cd = candleStore.current.get(t)
        try { if (cd) main.setCrosshairPosition(cd.close, t as Time, candle) } catch { /* mid-swap */ }
        echoLanes(t, lane.id)
        echoing.current = false
      })
    }

    const ro = new ResizeObserver(() => {
      const w = mainRef.current?.clientWidth
      if (!w) return
      main.applyOptions({ width: w })
      for (const lane of LANE_DEFS) charts.current[lane.id]?.applyOptions({ width: w })
      setScaleTick(t => t + 1)
    })
    ro.observe(mainRef.current)

    return () => {
      ro.disconnect()
      wheelEl.removeEventListener('wheel', onWheel)
      main.remove(); laneList.forEach(c => c.remove())
      charts.current = {}; series.current = {}; overlaySeries.current.clear(); maSeries.current.clear(); flipLine.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Push height changes to the existing chart (no recreation) + persist. The
  // scale tick nudges the GEX overlay to recompute against the new pane height.
  useEffect(() => {
    charts.current.main?.applyOptions({ height: mainHeight })
    localStorage.setItem(MAIN_H_KEY, String(mainHeight))
    setScaleTick(t => t + 1)
  }, [mainHeight])

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
    // Each series set to LANE gets its OWN lane chart (own visible axis), in
    // placement order; overflow past the pool shares the last slot.
    const lanePlaced = activeOverlayDefs.filter(d => cfgOf(d.id).place === 'lane').map(d => d.id)
    const targetFor = (id: string): { owner: IChartApi; scaleId: string } => {
      const idx = lanePlaced.indexOf(id)
      if (idx < 0) return { owner: main, scaleId: `ov-${id}` }
      const laneChart = charts.current[OV_LANE_IDS[Math.min(idx, OV_LANE_IDS.length - 1)]]
      return laneChart ? { owner: laneChart, scaleId: 'right' } : { owner: main, scaleId: `ov-${id}` }
    }
    for (const [id, meta] of overlaySeries.current) {
      const t = targetFor(id)
      if (!wanted.has(id) || meta.owner !== t.owner || meta.scaleId !== t.scaleId) {
        try { meta.owner.removeSeries(meta.srs) } catch { /* torn down */ }
        overlaySeries.current.delete(id)
        if (!wanted.has(id)) store.current.delete(`ov:${id}`)
      }
    }
    const t0 = candles[0]?.time ?? 0
    const tN = candles.length ? candles[candles.length - 1].time : Infinity
    activeOverlayDefs.forEach((d, i) => {
      const raw = data[d.id]
      if (!raw) return
      try {
        const cfg = cfgOf(d.id)
        const target = targetFor(d.id)
        const inLane = target.owner !== main
        const all = sanitize(raw)
        const pts = all.filter(p => p.time >= t0 && p.time <= tN)
        let meta = overlaySeries.current.get(d.id)
        if (!meta) {
          const srs = target.owner.addLineSeries({
            color: OVERLAY_PALETTE[i % OVERLAY_PALETTE.length], lineWidth: inLane ? 2 : 1,
            priceScaleId: target.scaleId, priceLineVisible: false, lastValueVisible: false,
          })
          meta = { srs, owner: target.owner, scaleId: target.scaleId }
          overlaySeries.current.set(d.id, meta)
        }
        target.owner.priceScale(target.scaleId).applyOptions(target.scaleId === 'right'
          ? { scaleMargins: { top: 0.14, bottom: 0.1 } }
          : { visible: false, scaleMargins: inLane ? { top: 0.14, bottom: 0.1 } : SIZE_MARGINS[cfg.size] })
        meta.srs.setData(pts.map(p => ({ time: p.time as Time, value: p.value })))
        meta.srs.applyOptions({ pointMarkersVisible: pts.length < 30 } as any)
        // Inspector carries the full history forward (monthly feeds resolve
        // even between releases), so store unclamped.
        store.current.set(`ov:${d.id}`, toSorted(all))
      } catch (e) { console.warn('overlay layer failed', d.id, e) }
    })
    // Lanes that just gained a series have no range yet: seed each used slot.
    if (lanePlaced.length) {
      try {
        const vr = main.timeScale().getVisibleRange()
        if (vr) for (let i = 0; i < lanePlaced.length; i++) charts.current[OV_LANE_IDS[Math.min(i, OV_LANE_IDS.length - 1)]]?.timeScale().setVisibleRange(vr)
      } catch { /* no data yet */ }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayQs.data, activeOverlayDefs, candles, layerCfg])

  // ── IV lane ──
  useEffect(() => {
    const s = series.current
    if (!s.ivS) return
    try {
      const pts = lanes.iv ? ivLane.pts : []
      // Pad with whitespace on the candle skeleton: a sparse snapshot series
      // (one accrued point) gives the lane no time density, so setVisibleRange
      // stretches it arbitrarily across the pane. Sharing the main chart's
      // timebase pins every point to its true date.
      const vals = new Map(pts.map(p => [p.time, p.value]))
      const times = new Set<number>(candles.map(c => c.time))
      pts.forEach(p => times.add(p.time))
      const merged = [...times].sort((a, b) => a - b)
        .map(t => vals.has(t) ? { time: t as Time, value: vals.get(t)! } : { time: t as Time })
      s.ivS.setData(pts.length ? merged : [])
      s.ivS.applyOptions({ pointMarkersVisible: pts.length < 30 } as any)
      store.current.set('lane:iv', toSorted(pts))
    } catch (e) { console.warn('iv lane failed', e) }
  }, [ivLane, lanes.iv, candles])

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

  // GEX-by-strike profile geometry: horizontal bars anchored at the right edge
  // of the price pane, each at its strike's y-coordinate (a volume profile
  // rotated 90 degrees). Recomputed whenever the price scale can have moved.
  const gexProfile = useMemo(() => {
    if (!ind.gexProfile) return null
    const rows = gexQ.data?.data
    const candle = series.current.candle
    const main = charts.current.main
    if (!rows?.length || !candle || !main) return null
    let pane: { width: number; height: number }
    try { pane = (main as any).paneSize() } catch { return null }
    if (!pane?.width) return null
    const maxAbs = Math.max(...rows.map((r: any) => Math.abs(r.net_gex ?? 0))) || 1
    const bars: { y: number; frac: number; pos: boolean; strike: number }[] = []
    for (const r of rows) {
      const g = r.net_gex ?? 0
      if (!g) continue
      let y: number | null = null
      try { y = candle.priceToCoordinate(r.strike) as number | null } catch { continue }
      if (y == null || y < 0 || y > pane.height) continue
      bars.push({ y, frac: Math.abs(g) / maxAbs, pos: g >= 0, strike: r.strike })
    }
    if (!bars.length) return null
    bars.sort((a, b) => a.y - b.y)
    const gaps = bars.slice(1).map((b, i) => b.y - bars[i].y).filter(g => g > 0).sort((a, b) => a - b)
    const thick = Math.max(2, Math.min(8, (gaps[gaps.length >> 1] ?? 6) - 1))
    return { bars, paneW: pane.width, paneH: pane.height, thick }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ind.gexProfile, gexQ.data, scaleTick, candles])

  // The price scale can move without any time-range event firing (dragging the
  // Y axis, autoscale shifts on new data). Watch the pane's actual price→pixel
  // mapping — the prices at the top and bottom edges — and re-anchor the
  // profile when it changes. Bumps state only on real movement, so it idles.
  useEffect(() => {
    if (!ind.gexProfile) return
    let last = ''
    const id = setInterval(() => {
      const candle = series.current.candle
      const main = charts.current.main
      if (!candle || !main) return
      try {
        const h = (main as any).paneSize()?.height ?? 0
        const top = candle.coordinateToPrice(0)
        const bot = candle.coordinateToPrice(h)
        const key = `${top}:${bot}:${h}`
        if (last && key !== last) setScaleTick(t => t + 1)
        last = key
      } catch { /* chart mid-swap */ }
    }, 120)
    return () => clearInterval(id)
  }, [ind.gexProfile])

  // ── Inspector data ──
  const lastC = candles.length ? candles[candles.length - 1] : undefined
  const inspectT = crossTime ?? lastC?.time ?? null
  const inspectC = inspectT != null ? (candleStore.current.get(inspectT) ?? lastC) : lastC
  const barIdx = inspectT != null ? candles.findIndex(c => c.time === inspectT) : candles.length - 1
  const at = (key: string) => inspectT != null ? floorVal(store.current.get(key), inspectT) : null
  const overlayColor = useCallback((id: string, i: number) =>
    overlaySeries.current.get(id)?.srs.options().color ?? OVERLAY_PALETTE[i % OVERLAY_PALETTE.length], [])
  const fmtN = (v: number | null, dp = 2, suffix = '') => v == null ? '—' : `${v.toFixed(dp)}${suffix}`

  const activeLegend = [
    ...mas.map((m, i) => ({ label: `${m.kind.toUpperCase()} ${m.period}`, color: MA_PALETTE[i % MA_PALETTE.length], style: 'line' as GlyphStyle })),
    ...(ind.bb ? [{ label: `BB ${params.bbP}·${params.bbK}`, color: 'var(--theme-secondary, #8099b0)', style: 'dash' as GlyphStyle }] : []),
    ...(ind.vwap ? [{ label: 'VWAP', color: '#c084fc', style: 'dash' as GlyphStyle }] : []),
    ...activeOverlayDefs.map((d, i) => ({ label: d.label, color: overlayColor(d.id, i), style: d.style })),
    ...(ind.gflip && flipLevel != null ? [{ label: `γ-flip ${flipLevel}`, color: '#c084fc', style: 'dash' as GlyphStyle }] : []),
    ...(ind.gexProfile ? [{ label: 'GEX by strike', color: '#3fb6a0', style: 'hist' as GlyphStyle }] : []),
  ]

  const pct = inspectC && inspectC.open ? ((inspectC.close - inspectC.open) / inspectC.open) * 100 : 0
  const dateOf = (t: number | null) => t == null ? '' : new Date(t * 1000).toISOString().slice(0, 10)
  const gexW = GEX_WIDTHS[cfgOf('gexprofile').size]
  const lanePlacedIds = activeOverlayDefs.filter(d => cfgOf(d.id).place === 'lane').map(d => d.id)
  const laneOverlayCount = lanePlacedIds.length

  const inspectorGroups: { group: string; rows: { label: string; value: string; color: string }[] }[] = useMemo(() => {
    const g: { group: string; rows: { label: string; value: string; color: string }[] }[] = []
    if (inspectC) {
      g.push({
        group: `Price · ${ticker}`, rows: [
          { label: 'Open', value: inspectC.open.toFixed(2), color: 'var(--theme-text, #d7e3fc)' },
          { label: 'High', value: inspectC.high.toFixed(2), color: 'var(--theme-text, #d7e3fc)' },
          { label: 'Low', value: inspectC.low.toFixed(2), color: 'var(--theme-text, #d7e3fc)' },
          { label: 'Close', value: inspectC.close.toFixed(2), color: 'var(--theme-text, #d7e3fc)' },
          { label: 'Change', value: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`, color: pct >= 0 ? C.lanePos : C.laneNeg },
        ],
      })
    }
    const tech: { label: string; value: string; color: string }[] = []
    mas.forEach((m, i) => { const v = at(`ma:${maKey(m)}`); if (v != null) tech.push({ label: `${m.kind.toUpperCase()} ${m.period}`, value: v.toFixed(2), color: MA_PALETTE[i % MA_PALETTE.length] }) })
    if (ind.bb) { const u = at('bbU'), l = at('bbL'); if (u != null) tech.push({ label: 'BB upper', value: u.toFixed(2), color: 'var(--theme-secondary, #8099b0)' }); if (l != null) tech.push({ label: 'BB lower', value: l.toFixed(2), color: 'var(--theme-secondary, #8099b0)' }) }
    if (ind.vwap) { const v = at('vwap'); if (v != null) tech.push({ label: 'VWAP', value: v.toFixed(2), color: '#c084fc' }) }
    if (lanes.rsi) { const v = at('lane:rsi'); if (v != null) tech.push({ label: `RSI ${params.rsiP}`, value: v.toFixed(1), color: '#c084fc' }) }
    if (lanes.macd) { const v = at('lane:macd'); if (v != null) tech.push({ label: 'MACD', value: v.toFixed(2), color: '#60a5fa' }) }
    if (tech.length) g.push({ group: 'Technicals', rows: tech })

    const pos: { label: string; value: string; color: string }[] = []
    if ((ind.gexProfile || ind.gflip) && gexNet != null) {
      pos.push({ label: 'Dealer net GEX', value: `${gexNet >= 0 ? '+' : ''}${gexNet.toFixed(2)} Bn`, color: gexNet >= 0 ? C.lanePos : C.laneNeg })
      pos.push({ label: 'γ regime', value: gexNet >= 0 ? 'Positive' : 'Negative', color: gexNet >= 0 ? C.lanePos : C.laneNeg })
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
  }, [inspectT, inspectC, mas, ind, lanes, activeOverlayDefs, flipLevel, gexNet, ivLane, params, C, ticker, ivHistQ.data, overlayQs.data, candles])


  return (
    <div style={{ maxWidth: 1680, minWidth: 1180, margin: '0 auto', background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.12))' }}>
      <style>{`
        .cs-row:hover { background: var(--theme-hover, rgba(255,255,255,0.04)); }
        .cs-chip:hover { border-color: var(--theme-primary, #c9a84c) !important; color: var(--theme-text, #d7e3fc) !important; }
      `}</style>

      {/* ── Header bar ── */}
      <div style={{ padding: '12px 20px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: '0.22em', color: 'var(--theme-primary, #c9a84c)' }}>CHART STUDIO</span>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.14em', color: 'var(--theme-secondary, #8099b0)' }}>ALPHATAPE TERMINAL</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.1em', color: 'var(--theme-secondary, #8099b0)' }}>{overlayDefs.length + LANE_IDS.length + 3} TIME-SERIES FEEDS</span>
          <LiveClock />
        </span>
      </div>

      {/* ── Toolbar ── */}
      <div style={{ padding: '9px 20px', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <Seg options={ASSET_CLASSES.map(a => ({ key: a.key, label: a.label }))} value={assetClass} onChange={v => dispatch({ type: 'assetClass', v })} ariaLabel="Asset class" />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input value={tickerDraft} onChange={e => setTickerDraft(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && submitTicker()} spellCheck={false} aria-label="Chart symbol"
            style={{ width: 96, height: 32, boxSizing: 'border-box', background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', color: 'var(--theme-primary, #c9a84c)', fontFamily: MONO, fontSize: 15, fontWeight: 700, padding: '0 8px' }} />
          <button className="cs-chip" onClick={submitTicker} style={{ height: 32, boxSizing: 'border-box', fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', padding: '0 10px', cursor: 'pointer', background: 'transparent', color: 'var(--theme-secondary, #8099b0)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))' }}>LOAD</button>
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', gap: 4 }}>
            {TFS.map(t => (
              <button key={t} className="cs-chip" onClick={() => dispatch({ type: 'tf', v: t })} style={{
                fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em', padding: '4px 8px', cursor: 'pointer',
                background: tf === t ? 'var(--theme-primary, #c9a84c)' : 'transparent',
                color: tf === t ? 'var(--theme-bg, #0a0e16)' : 'var(--theme-secondary, #8099b0)',
                border: tf === t ? '1px solid var(--theme-primary, #c9a84c)' : '1px solid var(--theme-border, rgba(255,255,255,0.14))',
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
              style={{ background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', color: 'var(--theme-primary, #c9a84c)', fontFamily: MONO, fontSize: 10, padding: '3px 6px', cursor: 'pointer' }}>
              {spansFor(tf).map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              {windowKey === 'custom' && <option value="custom" disabled>CUSTOM</option>}
            </select>
          </span>
        </span>
      </div>

      {/* ── Body: rail | chart | inspector ── */}
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        {/* Left rail */}
        {!railOpen ? (
          <button onClick={() => dispatch({ type: 'toggleRail' })} aria-label="Expand layer rail"
            style={{ width: 26, flex: 'none', background: 'var(--theme-surface, #0d1826)', border: 'none', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10, gap: 10 }}>
            <ChevronRight size={12} color="var(--theme-secondary, #8099b0)" />
            <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.18em', color: 'var(--theme-secondary, #8099b0)', writingMode: 'vertical-rl' }}>LAYERS</span>
          </button>
        ) : (
        <div style={{ width: 236, flex: 'none', background: 'var(--theme-surface, #0d1826)', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
          <div style={{ padding: '11px 16px 9px', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
              <span style={eyebrow}>Price overlays</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontFamily: MONO, fontSize: 8, color: 'var(--theme-secondary, #8099b0)' }}>TA</span>
                <button onClick={() => dispatch({ type: 'toggleRail' })} aria-label="Collapse layer rail"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                  <ChevronLeft size={11} color="var(--theme-secondary, #8099b0)" />
                </button>
              </span>
            </div>
            {mas.map((m, i) => (
              <div key={maKey(m)} className="cs-row" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 0' }}>
                <span style={{ width: 13, height: 13, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: MA_PALETTE[i % MA_PALETTE.length], border: `1px solid ${MA_PALETTE[i % MA_PALETTE.length]}`, color: 'var(--theme-bg, #0a0e16)', fontSize: 9, fontWeight: 800 }}>✓</span>
                <span style={{ width: 18, flex: 'none', display: 'flex', justifyContent: 'center' }}><Glyph style="line" color={MA_PALETTE[i % MA_PALETTE.length]} /></span>
                <span style={{ fontFamily: SANS, fontSize: 11, color: 'var(--theme-text, #d7e3fc)' }}>{m.kind.toUpperCase()} {m.period}</span>
                <button onClick={() => dispatch({ type: 'rmMA', key: maKey(m) })} aria-label={`Remove ${m.kind.toUpperCase()} ${m.period}`}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: 11, color: 'var(--theme-secondary, #8099b0)' }}>x</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 5, margin: '4px 0 6px' }}>
              <select value={maDraft.kind} onChange={e => setMaDraft(d => ({ ...d, kind: e.target.value as MA['kind'] }))} aria-label="Average type"
                style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', color: 'var(--theme-text, #d7e3fc)', fontFamily: MONO, fontSize: 10, padding: '2px 3px' }}>
                <option value="sma">SMA</option><option value="ema">EMA</option>
              </select>
              <input type="number" min={2} max={400} value={maDraft.period} aria-label="Average period"
                onChange={e => setMaDraft(d => ({ ...d, period: Math.round(+e.target.value) }))}
                onKeyDown={e => e.key === 'Enter' && addMA()}
                style={{ width: 48, background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', color: 'var(--theme-text, #d7e3fc)', fontFamily: MONO, fontSize: 10, padding: '2px 4px' }} />
              <button className="cs-chip" onClick={addMA} style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, padding: '0 8px', cursor: 'pointer', background: 'transparent', color: 'var(--theme-secondary, #8099b0)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))' }}>ADD</button>
            </div>
            <Row label={`Bollinger ${params.bbP}·${params.bbK}`} on={ind.bb} src="computed" color="#8099b0" style="dash" onToggle={() => dispatch({ type: 'ind', k: 'bb' })} />
            {ind.bb && (
              <div style={paramRow}>
                <NumParam label="LEN" value={params.bbP} min={5} max={200} onChange={setParam('bbP')} />
                <NumParam label="K" value={params.bbK} min={1} max={4} step={0.5} onChange={setParam('bbK')} />
              </div>
            )}
            <Row label="VWAP" on={ind.vwap} src="computed" color="#c084fc" style="dash" onToggle={() => dispatch({ type: 'ind', k: 'vwap' })} />
            <Row label="Gamma flip" on={ind.gflip} src="Tradier" color="#c084fc" style="dash" onToggle={() => dispatch({ type: 'ind', k: 'gflip' })} />
            <Row label="GEX by strike" on={ind.gexProfile} src="Tradier" color="#3fb6a0" style="hist" onToggle={() => dispatch({ type: 'ind', k: 'gexProfile' })} />
            {ind.gexProfile && <CfgChips label="GEX by strike" cfg={cfgOf('gexprofile')} showPlace={false} onPatch={p => dispatch({ type: 'layerCfg', id: 'gexprofile', patch: p })} />}
          </div>

          <div style={{ padding: '11px 16px 9px', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={eyebrow}>Sub-panel lanes</span><span style={{ fontFamily: MONO, fontSize: 8, color: 'var(--theme-secondary, #8099b0)' }}>OSC</span></div>
            {laneOrder.map((id, oi) => {
              const cfg: Record<string, { label: string; src: string; color: string; style: GlyphStyle }> = {
                volume: { label: 'Volume', src: 'OHLCV', color: '#3fb6a0', style: 'hist' },
                rsi: { label: `RSI ${params.rsiP}`, src: 'computed', color: '#c084fc', style: 'line' },
                macd: { label: `MACD ${params.macdF}·${params.macdS}·${params.macdSig}`, src: 'computed', color: '#60a5fa', style: 'line' },
                iv: { label: 'IV rank', src: 'accrues', color: '#c9a84c', style: 'area' },
              }
              const c = cfg[id]
              return (
                <div key={id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Row label={c.label} on={lanes[id]} src={c.src} color={c.color} style={c.style} onToggle={() => dispatch({ type: 'lane', k: id })} />
                  </div>
                  <button onClick={() => dispatch({ type: 'moveLane', id, dir: 'up' })} disabled={oi === 0} aria-label={`Move ${c.label} up`}
                    style={{ background: 'none', border: 'none', cursor: oi === 0 ? 'default' : 'pointer', fontFamily: MONO, fontSize: 10, color: oi === 0 ? 'var(--theme-border, #2c3d52)' : 'var(--theme-secondary, #8099b0)', padding: '0 2px' }}>↑</button>
                  <button onClick={() => dispatch({ type: 'moveLane', id, dir: 'down' })} disabled={oi === laneOrder.length - 1} aria-label={`Move ${c.label} down`}
                    style={{ background: 'none', border: 'none', cursor: oi === laneOrder.length - 1 ? 'default' : 'pointer', fontFamily: MONO, fontSize: 10, color: oi === laneOrder.length - 1 ? 'var(--theme-border, #2c3d52)' : 'var(--theme-secondary, #8099b0)', padding: '0 2px' }}>↓</button>
                </div>
                {id === 'rsi' && lanes.rsi && (
                  <div style={paramRow}><NumParam label="LEN" value={params.rsiP} min={2} max={100} onChange={setParam('rsiP')} /></div>
                )}
                {id === 'macd' && lanes.macd && (
                  <div style={paramRow}>
                    <NumParam label="F" value={params.macdF} min={2} max={50} onChange={setParam('macdF')} />
                    <NumParam label="S" value={params.macdS} min={3} max={100} onChange={setParam('macdS')} />
                    <NumParam label="SIG" value={params.macdSig} min={2} max={50} onChange={setParam('macdSig')} />
                  </div>
                )}
                </div>
              )
            })}
          </div>

          {(() => {
            // Global running index so pre-activation fallback colors stay
            // distinct across groups (active series read their real color).
            let idx = compares.length
            return APP_OVERLAY_GROUPS(tf, params.hvP).map(g => (
              <div key={g.group} style={{ padding: '11px 16px 9px', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={eyebrow}>{g.group}</span><span style={{ fontFamily: MONO, fontSize: 8, color: 'var(--theme-secondary, #8099b0)' }}>{g.tag}</span></div>
                {g.defs.map(d => {
                  const on = overlays.includes(d.id)
                  const empty = on && overlayQs.data && (overlayQs.data[d.id]?.length ?? 0) === 0 && !overlayQs.isFetching
                  return (
                    <div key={d.id}>
                      <Row label={d.label} on={on} src={empty ? 'NO DATA' : d.src} color={overlayColor(d.id, idx++)} style={d.style} onToggle={() => dispatch({ type: 'overlay', id: d.id })} />
                      {on && d.id === 'hv30' && (
                        <div style={paramRow}><NumParam label="WIN" value={params.hvP} min={5} max={252} onChange={setParam('hvP')} /></div>
                      )}
                      {on && <CfgChips label={d.label} cfg={cfgOf(d.id)} showPlace onPatch={p => dispatch({ type: 'layerCfg', id: d.id, patch: p })} />}
                    </div>
                  )
                })}
              </div>
            ))
          })()}

          <div style={{ padding: '11px 16px 9px', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={eyebrow}>Compare tickers</span><span style={{ fontFamily: MONO, fontSize: 8, color: 'var(--theme-secondary, #8099b0)' }}>MKT</span></div>
            <div style={{ display: 'flex', gap: 5, margin: '4px 0 6px' }}>
              <input value={compareDraft} onChange={e => setCompareDraft(e.target.value.toUpperCase())} placeholder="QQQ"
                onKeyDown={e => { if (e.key === 'Enter' && compareDraft.trim()) { dispatch({ type: 'addCompare', sym: compareDraft.trim() }); setCompareDraft('') } }}
                spellCheck={false} aria-label="Add comparison ticker"
                style={{ flex: 1, minWidth: 0, background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))', color: 'var(--theme-text, #d7e3fc)', fontFamily: MONO, fontSize: 11, padding: '3px 6px' }} />
              <button className="cs-chip" onClick={() => { if (compareDraft.trim()) { dispatch({ type: 'addCompare', sym: compareDraft.trim() }); setCompareDraft('') } }}
                style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, padding: '0 8px', cursor: 'pointer', background: 'transparent', color: 'var(--theme-secondary, #8099b0)', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))' }}>ADD</button>
            </div>
            {compares.map((s, i) => (
              <div key={s} className="cs-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                <span style={{ width: 10, height: 2, background: overlayColor(`cmp:${s}`, i), flex: 'none' }} />
                <span style={{ fontFamily: MONO, fontSize: 11, color: 'var(--theme-text, #d7e3fc)' }}>{s}</span>
                <button onClick={() => dispatch({ type: 'rmCompare', sym: s })} aria-label={`Remove ${s}`}
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontFamily: MONO, fontSize: 11, color: 'var(--theme-secondary, #8099b0)' }}>x</button>
              </div>
            ))}
          </div>

          <div style={{ padding: '11px 16px 9px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}><span style={eyebrow}>Timeline events</span><span style={{ fontFamily: MONO, fontSize: 8, color: 'var(--theme-secondary, #8099b0)' }}>yf</span></div>
            <Row label="Earnings" on={events.earnings} src="yfinance" color="#c9a84c" style="ring" onToggle={() => dispatch({ type: 'event', k: 'earnings' })} />
            <Row label="Dividends" on={events.dividends} src="yfinance" color="#60a5fa" style="ring" onToggle={() => dispatch({ type: 'event', k: 'dividends' })} />
            <Row label="Splits" on={events.splits} src="yfinance" color="#c084fc" style="ring" onToggle={() => dispatch({ type: 'event', k: 'splits' })} />
            <div style={{ fontFamily: SANS, fontSize: 9.5, color: 'var(--theme-secondary, #8099b0)', marginTop: 8, lineHeight: '13px' }}>
              Layers share one timeline on their own scales. Line series ride the price panel, oscillators drop into lanes.
            </div>
          </div>
        </div>
        )}

        {/* Chart column */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '7px 16px', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--theme-secondary, #8099b0)' }}>ACTIVE OVERLAYS</span>
            {activeLegend.length === 0 && (
              <span style={{ fontFamily: SANS, fontSize: 9.5, color: 'var(--theme-secondary, #8099b0)' }}>None. Toggle layers in the left rail.</span>
            )}
            {activeLegend.map(l => (
              <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <Glyph style={l.style} color={l.color} />
                <span style={{ fontFamily: MONO, fontSize: 9.5, color: 'var(--theme-secondary, #a9bacf)' }}>{l.label}</span>
              </span>
            ))}
            <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 8.5, letterSpacing: '0.08em', color: 'var(--theme-secondary, #8099b0)', whiteSpace: 'nowrap' }}>
              BARS · REFRESH {INTRADAY.has(tf) ? '60S' : '5M'}{candlesQ.dataUpdatedAt ? ` · AS OF ${new Date(candlesQ.dataUpdatedAt).toLocaleTimeString('en-US', { hour12: false })}` : ''}
            </span>
          </div>

          <div style={{ position: 'relative' }}>
            <div ref={mainRef} style={{ width: '100%' }} />
            {gexProfile && (
              <svg width={gexProfile.paneW} height={gexProfile.paneH} style={{ position: 'absolute', top: 0, left: 0, zIndex: 3, pointerEvents: 'none' }}>
                {gexProfile.bars.map(b => (
                  <rect key={b.strike} x={gexProfile.paneW - b.frac * gexW} y={b.y - gexProfile.thick / 2}
                    width={b.frac * gexW} height={gexProfile.thick}
                    fill={b.pos ? 'rgba(63,182,160,0.42)' : 'rgba(207,75,63,0.45)'} />
                ))}
                <text x={gexProfile.paneW - 4} y={12} textAnchor="end" fontFamily="var(--theme-mono)" fontSize={8.5} fontWeight={700} letterSpacing="0.1em" fill="var(--theme-secondary, #8099b0)">GEX BY STRIKE</text>
              </svg>
            )}
            {candlesQ.isLoading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in srgb, var(--theme-bg, #101c2e) 70%, transparent)', zIndex: 6 }}>
                <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: '0.14em', color: 'var(--theme-secondary, #8099b0)' }}>LOADING {ticker}…</span>
              </div>
            )}
            {candlesQ.isError && !candlesQ.isLoading && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 6 }}>
                <span style={{ fontFamily: SANS, fontSize: 11, color: 'var(--theme-secondary, #8099b0)' }}>No data for {ticker} at {tf.toUpperCase()}. Try another symbol or timeframe.</span>
              </div>
            )}
          </div>

          {/* Drag to make the chart taller/shorter; double-click resets. */}
          <div
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            onDoubleClick={() => setMainHeight(MAIN_H_DEFAULT)}
            onMouseEnter={() => setHandleHover(true)}
            onMouseLeave={() => setHandleHover(false)}
            title="Drag to resize chart · double-click to reset"
            style={{
              height: 8, cursor: 'ns-resize', display: 'flex', alignItems: 'center', justifyContent: 'center',
              touchAction: 'none', userSelect: 'none', transition: 'background 0.12s',
              background: handleHover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)' : 'var(--theme-surface, #0d1826)',
              borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
              borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))',
            }}
          >
            <div style={{ width: 34, height: 2, borderRadius: 2, transition: 'background 0.12s',
              background: handleHover ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-border, rgba(255,255,255,0.28))' }} />
          </div>

          {laneOrder.map(id => {
            const lane = LANE_DEFS.find(l => l.id === id)!
            const on = lanes[id]
            const header = id === 'iv'
              ? <>{ivLane.kind === 'rank' ? 'IV RANK' : 'ATM IV30'}{ivLane.pts.length < 30 && <span style={{ color: 'var(--theme-secondary, #8099b0)' }}> · {ivLane.pts.length} pt{ivLane.pts.length === 1 ? '' : 's'} · accrues daily</span>}</>
              : id === 'rsi' ? `RSI ${params.rsiP}` : id === 'macd' ? `MACD ${params.macdF}·${params.macdS}·${params.macdSig}` : lane.label
            return (
              <div key={id} style={{ display: on ? 'block' : 'none', borderTop: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))', position: 'relative' }}>
                <span style={{ position: 'absolute', top: 4, left: 10, zIndex: 5, fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.16em', color: 'var(--theme-secondary, #8099b0)' }}>{header}</span>
                <div ref={el => { laneRefs.current[id] = el }} style={{ width: '100%' }} />
              </div>
            )
          })}

          {/* Per-overlay lanes: each series set to LANE gets its own section. */}
          {OV_LANE_IDS.map((slot, i) => {
            const ovId = lanePlacedIds[i]
            const on = i < lanePlacedIds.length
            const header = (ovId && overlayDefs.find(d => d.id === ovId)?.label) || 'Overlay'
            return (
              <div key={slot} style={{ display: on ? 'block' : 'none', borderTop: '1px solid var(--theme-border-faint, rgba(255,255,255,0.06))', position: 'relative' }}>
                <span style={{ position: 'absolute', top: 4, left: 10, zIndex: 5, fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.16em', color: 'var(--theme-secondary, #8099b0)' }}>{header}</span>
                <div ref={el => { laneRefs.current[slot] = el }} style={{ width: '100%' }} />
              </div>
            )
          })}

        </div>

        {/* Right inspector */}
        {!inspectorOpen ? (
          <button onClick={() => dispatch({ type: 'toggleInspector' })} aria-label="Expand readout inspector"
            style={{ width: 26, flex: 'none', background: 'var(--theme-surface, #0d1826)', border: 'none', borderLeft: '1px solid var(--theme-border, rgba(255,255,255,0.08))', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 10, gap: 10 }}>
            <ChevronLeft size={12} color="var(--theme-secondary, #8099b0)" />
            <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.18em', color: 'var(--theme-secondary, #8099b0)', writingMode: 'vertical-rl' }}>READOUT</span>
          </button>
        ) : (
        <div style={{ width: 188, flex: 'none', background: 'var(--theme-surface, #0d1826)', borderLeft: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
          <div style={{ padding: '10px 12px 8px', borderBottom: '1px solid rgba(201,168,76,0.3)', background: 'rgba(201,168,76,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--theme-secondary, #8099b0)' }}>READOUT AT CROSSHAIR</span>
              <button onClick={() => dispatch({ type: 'toggleInspector' })} aria-label="Collapse readout inspector"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex' }}>
                <ChevronRight size={11} color="var(--theme-secondary, #8099b0)" />
              </button>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', marginTop: 3 }}>{dateOf(inspectT) || '—'}</div>
            {barIdx >= 0 && <div style={{ fontFamily: MONO, fontSize: 9, color: 'var(--theme-secondary, #8099b0)', marginTop: 1 }}>bar {barIdx + 1} / {candles.length}</div>}
          </div>
          {inspectorGroups.map(g => (
            <div key={g.group} style={{ padding: '8px 12px', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' }}>
              <div style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 4 }}>{g.group}</div>
              {g.rows.map(r => (
                <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, lineHeight: '17px' }}>
                  <span style={{ fontFamily: SANS, fontSize: 10, color: 'var(--theme-secondary, #7f97af)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
                  <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 600, color: r.color, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r.value}</span>
                </div>
              ))}
            </div>
          ))}
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))' }}>
            <div style={{ fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)', marginBottom: 4 }}>Feed cadence</div>
            {[
              { label: `Candles ${tf.toUpperCase()}`, value: INTRADAY.has(tf) ? 'refresh 60s' : 'refresh 5m' },
              ...(ind.gexProfile || ind.gflip ? [{ label: 'Dealer GEX', value: '30m cache' }] : []),
              ...(lanes.iv ? [{ label: 'IV rank', value: 'daily snapshot' }] : []),
              ...activeOverlayDefs.map(d => ({ label: d.label, value: d.cadence })),
            ].map(r => (
              <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, lineHeight: '17px' }}>
                <span style={{ fontFamily: SANS, fontSize: 10, color: 'var(--theme-secondary, #7f97af)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</span>
                <span style={{ fontFamily: MONO, fontSize: 9, color: 'var(--theme-secondary, #8099b0)', whiteSpace: 'nowrap' }}>{r.value}</span>
              </div>
            ))}
          </div>
          <div style={{ padding: '8px 12px', fontFamily: SANS, fontSize: 9, color: 'var(--theme-secondary, #8099b0)', lineHeight: '12px' }}>
            Values resolve at the crosshair timestamp. Monthly and quarterly feeds carry forward.
          </div>
        </div>
        )}
      </div>
    </div>
  )
}

export default function ChartStudio() {
  return <PageWrapper><ChartStudioContent /></PageWrapper>
}
