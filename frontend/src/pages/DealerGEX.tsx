import { useEffect, useMemo, useState } from 'react'
import useIsMobile from '../hooks/useIsMobile'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Bar, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import { fetchDealerExposure, fetchSnapshotSeries } from '../hooks/useApi'
import { useChartColors } from '../hooks/useChartColors'
import { T } from '../lib/theme'
import { MONO, SANS, mix } from './cockpitKit'
import { TICK, TOOLTIP_STYLE, TOOLTIP_LABEL, TOOLTIP_ITEM } from './valuationShared'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, chartClip, tableClip } from '../lib/reportCaptureRegistry'

// Dealer GEX — aligned stack. One price axis, read top to bottom: where dealer
// exposure sits by strike, what traded into it today, and how that exposure is
// distributed across the term structure.
//
// The rule the layout depends on: the strike profile, the flow ribbon and the
// expiry x strike heatmap are all rendered from ONE filtered strike array and
// ONE column geometry, so a wall, a flow print and a term-structure
// concentration line up vertically instead of forcing the reader to re-anchor
// on three separate x-axes. Recharts computes its own plot inset per chart, so
// three stacked ResponsiveContainers would not register — those three regions
// are positioned divs on a percentage grid. Recharts stays for the history
// pane, which has no alignment requirement.

// Gutter and plot sizes, narrowed on a phone. The profile, ribbon and heatmap
// share one column geometry, so they cannot be reflowed independently — the
// frame stays horizontally scrollable and these just buy back width inside it.
const GUTTER_L_WIDE = 92     // row labels (expiry code + DTE), "flow today" caption
const GUTTER_L_NARROW = 56
const GUTTER_R_WIDE = 64     // profile y-labels, heatmap row totals
const GUTTER_R_NARROW = 44
const PLOT_H_WIDE = 270
const PLOT_H_NARROW = 200
const CHIP_LANE = 17         // lane pitch for the level markers above the profile
const CHIP_H = 15            // rendered chip height, where its own rule starts
const CHIP_MIN = 46
const RIBBON_H = 34
const heatRowH = (n: number) => (n > 16 ? 20 : n > 10 ? 24 : 30)
const BAR_INSET = 11         // % of column, each side — bars fill 78%
const HISTORY_W = 520        // history pane; full width once the row wraps

/** Panel headers / KPI strip. */
const SURFACE = T.surface
/** Regime band, flow ribbon, level KPI cells. */
const QUIET = `color-mix(in srgb, ${T.surface} 50%, ${T.bg})`

type Metric = 'gex' | 'dex' | 'vanna' | 'charm'

interface StrikeRow {
  strike: number
  call_gex: number; put_gex: number; net_gex: number
  net_dex: number; net_vanna: number; net_charm: number
  call_oi: number; put_oi: number; call_vol: number; put_vol: number
}
interface Summary {
  net_gex: number; call_gex: number; put_gex: number
  net_dex: number; net_vanna: number; net_charm: number
  call_oi: number; put_oi: number; call_vol: number; put_vol: number
  flip: number | null; call_wall: number | null; put_wall: number | null
}
interface ExpiryRow extends Summary { expiry: string; dte: number }
interface FlowRow {
  expiry: string; dte: number; type: 'call' | 'put'; strike: number
  volume: number; oi: number; vol_oi: number; iv: number | null; mid: number
  premium: number; moneyness: number
}
interface Exposure {
  ticker: string; spot: number
  expirations: string[]; processed: string[]
  per_expiry: ExpiryRow[]
  by_strike: StrikeRow[]
  by_expiry_strike: Record<string, StrikeRow[]>
  flow: FlowRow[]
  totals: Summary
  screen: { min_volume: number; min_vol_oi: number }
  source: string; delayed: boolean; quote_time: string | null
}

const METRICS: Record<Metric, { field: keyof StrikeRow; tab: string; noun: string; unit: string }> = {
  gex:   { field: 'net_gex',   tab: 'Gamma', noun: 'Gamma', unit: '$M per 1% move' },
  dex:   { field: 'net_dex',   tab: 'Delta', noun: 'Delta', unit: '$M of delta' },
  vanna: { field: 'net_vanna', tab: 'Vanna', noun: 'Vanna', unit: '$M delta / vol pt' },
  charm: { field: 'net_charm', tab: 'Charm', noun: 'Charm', unit: '$M delta / day' },
}

const fmtM = (v: number | null | undefined, d = 2) => {
  if (v == null) return '—'
  const s = v > 0 ? '+' : v < 0 ? '−' : ''
  const a = Math.abs(v)
  return a >= 1000 ? `${s}$${(a / 1000).toFixed(2)}B` : `${s}$${a.toFixed(d)}M`
}
const axisM = (v: number) => {
  const a = Math.abs(v)
  const s = v < 0 ? '−' : ''
  return a >= 1000 ? `${s}${(a / 1000).toFixed(1)}B` : `${s}${a.toFixed(0)}M`
}
const fmtK = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const fmtPrem = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`
/** Third Friday — the monthly OPEX, worth calling out on a chip. */
const isOpex = (iso: string) => {
  const d = new Date(`${iso}T00:00:00`)
  return d.getDay() === 5 && d.getDate() >= 15 && d.getDate() <= 21
}
const usd0 = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
const pct2 = (v: number) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(2)}%`

export function DealerGEXContent() {
  const cc = useChartColors()
  const isMobile = useIsMobile()
  const GUTTER_L = isMobile ? GUTTER_L_NARROW : GUTTER_L_WIDE
  const GUTTER_R = isMobile ? GUTTER_R_NARROW : GUTTER_R_WIDE
  const PLOT_H = isMobile ? PLOT_H_NARROW : PLOT_H_WIDE
  const [sp] = useSearchParams()
  const urlTicker = (sp.get('ticker') || 'SPY').trim().toUpperCase()

  const [tickerDraft, setTickerDraft] = useState(urlTicker)
  const [submitted, setSubmitted] = useState({ ticker: urlTicker, expiries: 24, minVolume: 500, minVolOi: 1.5 })
  const [metric, setMetric] = useState<Metric>('gex')
  const [selExpiry, setSelExpiry] = useState<string>('ALL')
  const [selStrike, setSelStrike] = useState<number | null>(null)
  const [screenOpen, setScreenOpen] = useState(false)
  const [volDraft, setVolDraft] = useState(500)
  const [voiDraft, setVoiDraft] = useState(1.5)

  const BAND = 5   // ±% of spot. Fixed for now; the prototype exposes it as a prop.
  // A count of "nearest expiries" is a poor proxy for coverage on a name with
  // daily expiries: ten of them close inside a few weeks. 24 reaches ~8 months
  // on SPY, which covers every monthly and quarterly that carries real open
  // interest. The backend also merges the monthly OPEX in regardless.
  const EXPIRIES = 24

  // Same-route ?ticker= navigations (palette, drawer, linked mode) change only
  // the search string — no remount, so sync from the URL when it changes.
  useEffect(() => {
    const t = (sp.get('ticker') || '').trim().toUpperCase()
    if (t && t !== submitted.ticker) {
      setTickerDraft(t)
      setSubmitted(s => ({ ...s, ticker: t }))
      setSelExpiry('ALL'); setSelStrike(null)
    }
  }, [sp])   // eslint-disable-line react-hooks/exhaustive-deps

  const { data, isFetching, error, refetch } = useQuery<Exposure>({
    queryKey: ['dealer-gex', submitted],
    queryFn: () => fetchDealerExposure(submitted.ticker, submitted.expiries, submitted.minVolume, submitted.minVolOi),
  })

  // Separate query on purpose: it can compute today's point on first view of
  // the day, and the page must not block on it.
  const { data: hist } = useQuery({
    queryKey: ['dealer-gex-hist', submitted.ticker],
    queryFn: () => fetchSnapshotSeries('gex', submitted.ticker),
    staleTime: 60 * 60_000,
  })

  const load = () => {
    const next = { ticker: tickerDraft.trim().toUpperCase() || 'SPY', expiries: EXPIRIES, minVolume: volDraft, minVolOi: voiDraft }
    setSelStrike(null)
    // Same params must still force a refetch — setSubmitted alone is a key no-op.
    if (JSON.stringify(next) === JSON.stringify(submitted)) refetch()
    else { setSubmitted(next); setSelExpiry('ALL') }
  }

  const spot = data?.spot ?? null
  const field = METRICS[metric].field
  const sliced = selExpiry !== 'ALL'

  const view: Summary | null = useMemo(() => {
    if (!data) return null
    return sliced ? data.per_expiry.find(p => p.expiry === selExpiry) ?? data.totals : data.totals
  }, [data, selExpiry, sliced])

  // ── The one column geometry every aligned region reads ───────────────────
  // Built from the AGGREGATE strikes so the columns hold still when you slice
  // to an expiry — otherwise the heatmap rows would re-register under a
  // profile that had changed width.
  const cols = useMemo(() => {
    if (!data || !spot) return [] as number[]
    const lo = spot * (1 - BAND / 100), hi = spot * (1 + BAND / 100)
    return data.by_strike.map(r => r.strike).filter(s => s >= lo && s <= hi).sort((a, b) => a - b)
  }, [data, spot])
  const colW = cols.length ? 100 / cols.length : 0
  const colIndex = useMemo(() => new Map(cols.map((s, i) => [s, i])), [cols])
  /** Percent-of-track position for a price. Interpolated between the two
   *  columns it falls between rather than snapped to the nearer one: strikes
   *  are ordinal here, and snapping collapsed distinct levels onto one column
   *  (spot 768.56 and a 769 flip drew a single line). */
  const xOf = (price: number): number | null => {
    if (!cols.length) return null
    if (price <= cols[0]) return 0.5 * colW
    if (price >= cols[cols.length - 1]) return (cols.length - 0.5) * colW
    let i = 0
    while (i < cols.length - 2 && cols[i + 1] < price) i++
    const span = cols[i + 1] - cols[i] || 1
    return (i + 0.5 + (price - cols[i]) / span) * colW
  }

  /** Metric value per column for the active slice, with a clipping ceiling.
   *  The spec's 99th percentile assumed a big sample: over the ~70 bars a ±5%
   *  band actually holds, the 99th percentile IS the maximum, so it clipped
   *  nothing and one OPEX strike at 47x the median flattened the profile into a
   *  line. Clip at the 95th, and never let the ceiling exceed 3x the upper
   *  quartile. `raw` is kept so a tooltip reports the real number. */
  const profile = useMemo(() => {
    const empty = { values: [] as number[], raw: [] as number[], ceiling: 0 }
    if (!data || !cols.length) return empty
    const rows = sliced ? (data.by_expiry_strike[selExpiry] ?? []) : data.by_strike
    const byStrike = new Map(rows.map(r => [r.strike, r[field] as number]))
    const raw = cols.map(s => byStrike.get(s) ?? 0)
    const abs = raw.map(Math.abs).filter(v => v > 0).sort((a, b) => a - b)
    if (!abs.length) return { values: raw, raw, ceiling: 0 }
    const q = (p: number) => abs[Math.min(abs.length - 1, Math.floor(abs.length * p))]
    const ceiling = Math.min(q(0.95), q(0.75) * 3) || q(0.95)
    return { raw, ceiling, values: raw.map(v => Math.sign(v) * Math.min(Math.abs(v), ceiling)) }
  }, [data, cols, sliced, selExpiry, field])

  const domain = useMemo(() => {
    const hi = Math.max(0, ...profile.values), lo = Math.min(0, ...profile.values)
    if (hi === 0 && lo === 0) return { hi: 1, lo: -1, span: 2 }
    const span = hi - lo || 1
    return { hi, lo, span }
  }, [profile.values])   // eslint-disable-line react-hooks/exhaustive-deps
  const zeroY = (domain.hi / domain.span) * PLOT_H

  const flow = useMemo(() => {
    if (!data) return [] as FlowRow[]
    return sliced ? data.flow.filter(f => f.expiry === selExpiry) : data.flow
  }, [data, sliced, selExpiry])
  // Only prints that land on a plotted column can be drawn on the shared axis.
  const ribbon = useMemo(() => {
    const inBand = flow.filter(f => colIndex.has(f.strike))
    const max = Math.max(1, ...inBand.map(f => f.premium))
    return inBand.map(f => ({ ...f, h: Math.max(14, (f.premium / max) * 100) }))
  }, [flow, colIndex])

  // ── Level markers, lane-packed so no two chips ever overlap ──────────────
  const markers = useMemo(() => {
    if (!spot || !view) return [] as { key: string; label: string; x: number; color: string; lane: number; dashed?: boolean }[]
    const raw = [
      { key: 'spot', label: `SPOT ${usd0(spot)}`, price: spot, color: T.text, dashed: false },
      view.flip != null ? { key: 'flip', label: `FLIP ${usd0(view.flip)}`, price: view.flip, color: T.warn, dashed: true } : null,
      view.call_wall != null ? { key: 'cw', label: `CALL WALL ${usd0(view.call_wall)}`, price: view.call_wall, color: cc.gain, dashed: false } : null,
      view.put_wall != null ? { key: 'pw', label: `PUT WALL ${usd0(view.put_wall)}`, price: view.put_wall, color: cc.loss, dashed: false } : null,
    ].filter(Boolean) as { key: string; label: string; price: number; color: string; dashed: boolean }[]

    const placed: { key: string; label: string; x: number; color: string; lane: number; dashed: boolean }[] = []
    const laneRight: number[] = []
    for (const m of raw.slice().sort((a, b) => a.price - b.price)) {
      const x = xOf(m.price)
      if (x == null) continue
      const half = (m.label.length * 1.0) / 2 + 0.8   // label half-width in track %
      let lane = 0
      while (laneRight[lane] != null && laneRight[lane] > x - half) lane++
      laneRight[lane] = x + half
      placed.push({ key: m.key, label: m.label, x, color: m.color, lane, dashed: m.dashed })
    }
    return placed
  }, [spot, view, cols, cc.gain, cc.loss])   // eslint-disable-line react-hooks/exhaustive-deps

  const chipBand = Math.max(CHIP_MIN, 26 + CHIP_LANE * (Math.max(0, ...markers.map(m => m.lane)) + 1))
  // Two levels can land on the same column (a call wall and a put wall often
  // do). Their chips stack in lanes, but the rule underneath is one line —
  // drawing it twice just darkens it.
  const rules = useMemo(() => {
    const groups = new Map<number, typeof markers>()
    for (const m of markers) {
      const k = Math.round(m.x * 100)
      groups.set(k, [...(groups.get(k) ?? []), m])
    }
    return [...groups.values()].flatMap(g =>
      g.map((m, i) => ({ ...m, nudge: (i - (g.length - 1) / 2) * 2 })))
  }, [markers])

  // ── Regime read ──────────────────────────────────────────────────────────
  const flipGap = view?.flip != null && spot ? ((spot - view.flip) / spot) * 100 : null
  const long = (view?.net_gex ?? 0) > 0
  const regime = long
    ? 'Dealers are long gamma — the book absorbs moves, not amplifies them.'
    : 'Dealers are short gamma — hedging chases price and amplifies moves.'
  const regimeDetail = useMemo(() => {
    if (!view || !data) return ''
    const parts = [`${fmtM(view.net_gex)} net γ across ${sliced ? selExpiry : `${data.processed.length} expiries`}`]
    if (view.flip != null && flipGap != null) {
      parts.push(`flip ${usd0(view.flip)} sits ${Math.abs(flipGap).toFixed(2)}% ${flipGap >= 0 ? 'below' : 'above'} spot`)
    }
    if (view.put_wall != null && view.call_wall != null) {
      parts.push(`pin band ${usd0(view.put_wall)}–${usd0(view.call_wall)}`)
    }
    parts.push(`${fmtM(view.net_charm)} of delta bleeds per day`)
    return parts.join(' · ')
  }, [view, data, sliced, selExpiry, flipGap])

  // ── History ──────────────────────────────────────────────────────────────
  const history = useMemo(() => {
    const pts: any[] = hist?.points ?? []
    return pts.filter(p => p.spot != null).slice(-90)
      .map(p => ({ d: p.d.slice(5), spot: p.spot, flip: p.flip ?? null, net: p.v ?? null }))
  }, [hist])
  const defended = useMemo(() => {
    const withFlip = history.filter(h => h.flip != null)
    if (!withFlip.length) return null
    return { held: withFlip.filter(h => h.spot >= (h.flip as number)).length, total: withFlip.length }
  }, [history])
  // The endpoint carries no day change; the accrued series does, one row back.
  const dayChange = useMemo(() => {
    if (!spot || history.length < 2) return null
    const prev = history[history.length - 2].spot as number
    if (!prev) return null
    return { abs: spot - prev, pct: ((spot - prev) / prev) * 100 }
  }, [spot, history])

  const heatRows = useMemo(() => {
    if (!data || !cols.length) return [] as { exp: string; dte: number; cells: number[]; rowMax: number; total: number }[]
    return data.per_expiry.map(p => {
      const byStrike = new Map((data.by_expiry_strike[p.expiry] ?? []).map(r => [r.strike, r[field] as number]))
      const cells = cols.map(s => byStrike.get(s) ?? 0)
      return {
        exp: p.expiry, dte: p.dte, cells,
        rowMax: Math.max(1e-9, ...cells.map(Math.abs)),
        total: p[field as keyof ExpiryRow] as number,
      }
    })
  }, [data, cols, field])
  const globalMax = useMemo(() => Math.max(1e-9, ...heatRows.flatMap(r => r.cells.map(Math.abs))), [heatRows])

  const TAB = 'Dealer GEX'
  useReportCapture(() => {
    if (!data || !view) return null
    const pieces: ClipDraft[] = [
      kpiClip(TAB, `Dealer GEX · ${data.ticker} · ${sliced ? selExpiry : `${data.processed.length} expiries`}`, [
        { label: 'Net Gamma', value: fmtM(view.net_gex), sub: long ? 'Moves get pinned' : 'Moves get amplified' },
        { label: 'Net Delta', value: fmtM(view.net_dex) },
        { label: 'Vanna', value: fmtM(view.net_vanna) },
        { label: 'Charm', value: fmtM(view.net_charm) },
        { label: 'Gamma Flip', value: view.flip != null ? usd0(view.flip) : '—' },
        { label: 'Call Wall', value: view.call_wall != null ? usd0(view.call_wall) : '—' },
        { label: 'Put Wall', value: view.put_wall != null ? usd0(view.put_wall) : '—' },
      ]),
    ]
    if (cols.length) {
      pieces.push(chartClip(TAB, `${METRICS[metric].noun} by strike (${METRICS[metric].unit})`, 'bar', 'strike',
        cols.map((s, i) => ({ strike: s, value: profile.raw[i] })), [{ key: 'value', label: METRICS[metric].noun }]))
    }
    if (history.length > 1) {
      pieces.push(chartClip(TAB, 'Flip vs spot · accrued history', 'line', 'd',
        history, [{ key: 'spot', label: 'Spot' }, { key: 'flip', label: 'Flip' }]))
    }
    if (flow.length) {
      pieces.push(tableClip(TAB, `Flow into this book · ${flow.length} contracts`,
        ['Expiry', 'Type', 'Strike', 'OTM%', 'Volume', 'OI', 'Vol/OI', 'Premium'],
        flow.slice(0, 40).map(f => [
          f.expiry, f.type.toUpperCase(), String(f.strike), `${f.moneyness >= 0 ? '+' : ''}${f.moneyness.toFixed(1)}%`,
          f.volume.toLocaleString(), f.oi.toLocaleString(), `${f.vol_oi.toFixed(1)}×`, fmtPrem(f.premium),
        ])))
    }
    return pieces
  }, { disabled: !data, sourceTab: TAB })

  // Strike spacing is not uniform — SPY prints $1 near the money and $5 in the
  // wings — so "every $5" put three labels in three adjacent columns out there.
  // Round strikes are candidates; a minimum column stride does the thinning.
  const ticks = useMemo(() => {
    if (!cols.length) return [] as { i: number; s: number }[]
    const step = cols.length < 50 ? 2 : 5
    const stride = Math.max(1, Math.ceil(cols.length / 18))
    const out: { i: number; s: number }[] = []
    cols.forEach((s, i) => {
      if (Math.abs(s - Math.round(s)) > 0.01 || Math.round(s) % step !== 0) return
      if (out.length && i - out[out.length - 1].i < stride) return
      out.push({ i, s })
    })
    return out
  }, [cols])

  return (
    <div>
     <div style={{ minWidth: isMobile ? 0 : 900 }}>
      {/* ── Command bar ─────────────────────────────────────────────────── */}
      {/* One row: identity, the expiry strip, then the entry. The strip takes
          the slack and scrolls inside itself, so eleven expiries never push the
          controls off the bar. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 14, minHeight: 54, padding: '6px 16px',
        background: SURFACE, border: `1px solid ${T.border}`, borderBottom: 'none',
      }}>
        <span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, color: T.text, flexShrink: 0 }}>
          {data?.ticker ?? submitted.ticker}
        </span>
        {spot != null && (
          <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, color: T.text, flexShrink: 0 }}>
            ${spot.toFixed(2)}
          </span>
        )}
        {dayChange && (
          <span style={{
            fontFamily: MONO, fontSize: 11, fontWeight: 700, flexShrink: 0,
            color: dayChange.abs >= 0 ? 'var(--theme-positive-strong, #15803D)' : 'var(--theme-negative-strong, #991B1B)',
          }}>
            {dayChange.abs >= 0 ? '+' : '−'}{Math.abs(dayChange.abs).toFixed(2)} · {pct2(dayChange.pct)}
          </span>
        )}

        <span aria-hidden style={{ width: 1, height: 24, background: T.border, flexShrink: 0 }} />

        <div style={{ flex: 1, minWidth: 90, display: 'flex', gap: 5, overflowX: 'auto', paddingBottom: 2 }}>
          <Chip on={selExpiry === 'ALL'} onClick={() => { setSelExpiry('ALL'); setSelStrike(null) }}>
            All {data?.processed.length ?? EXPIRIES}
          </Chip>
          {(data?.per_expiry ?? []).map(p => (
            <Chip key={p.expiry} on={selExpiry === p.expiry}
              title={`${p.expiry} · ${p.dte}d${isOpex(p.expiry) ? ' · monthly OPEX' : ''}`}
              onClick={() => { setSelExpiry(p.expiry); setSelStrike(null) }}>
              {p.expiry.slice(5)}{isOpex(p.expiry) ? ' ·' : ''}
            </Chip>
          ))}
        </div>

        {data && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: 10,
            color: data.delayed ? T.warn : T.pos, whiteSpace: 'nowrap', flexShrink: 0,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: data.delayed ? T.warn : T.pos }} />
            <span style={{ fontWeight: 700, letterSpacing: '0.08em' }}>{data.delayed ? 'DELAYED' : 'LIVE'}</span>
            <span style={{ color: T.muted }}>· {data.source}</span>
          </span>
        )}
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <input id="gex-ticker" value={tickerDraft} placeholder="SPY" aria-label="Ticker"
            onChange={e => setTickerDraft(e.target.value.toUpperCase())}
            onKeyDown={e => { if (e.key === 'Enter') load() }}
            style={{ ...INP, width: 92, height: 32, padding: '0 10px', textTransform: 'uppercase' }} />
          <button onClick={load} disabled={isFetching} style={{
            height: 32, padding: '0 18px', background: T.text, border: `1px solid ${T.text}`, color: T.bg,
            cursor: isFetching ? 'wait' : 'pointer', fontFamily: SANS, fontSize: 10, fontWeight: 700,
            letterSpacing: '0.12em', textTransform: 'uppercase', opacity: isFetching ? 0.6 : 1,
          }}>{isFetching ? 'Loading' : 'Load'}</button>
        </div>
      </div>

      {error && (
        <div style={{ border: `1px solid ${T.border}`, padding: 14, fontFamily: MONO, fontSize: 11, color: T.neg }}>
          {(error as any)?.response?.data?.detail ?? (error as any)?.message ?? 'Exposure fetch failed.'}
        </div>
      )}
      {isFetching && !data && (
        <div style={{ border: `1px solid ${T.border}` }}>
          <EmptyState title="Loading…" variant="loading" hint="One pass over every chain in the window…" />
        </div>
      )}
      {!isFetching && !data && !error && (
        <div style={{ border: `1px solid ${T.border}` }}>
          <EmptyState title="Dealer GEX" action="LOAD"
            hint="Enter a ticker and press LOAD." />
        </div>
      )}

      {data && view && (
        <>
          {/* ── Regime band ───────────────────────────────────────────────── */}
          <div style={{
            background: QUIET, border: `1px solid ${T.border}`, borderLeft: `3px solid ${long ? cc.gain : cc.loss}`,
            padding: '14px 16px',
          }}>
            <div style={{
              fontFamily: SANS, fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em',
              lineHeight: 1.2, color: T.text, textWrap: 'pretty' as any,
            }}>{regime}</div>
            <div style={{ fontFamily: MONO, fontSize: 11, color: T.muted, marginTop: 6 }}>{regimeDetail}</div>
          </div>

          {/* ── KPI strip: four exposures, then four levels ───────────────── */}
          <div style={{ display: 'flex', border: `1px solid ${T.border}`, borderTop: 'none' }}>
            <Kpi label="Net gamma" value={fmtM(view.net_gex)} big first
              color={view.net_gex >= 0 ? 'var(--theme-positive-strong, #15803D)' : 'var(--theme-negative-strong, #991B1B)'}
              sub={long ? 'Moves get pinned' : 'Moves get amplified'} />
            <Kpi label="Net delta" value={fmtM(view.net_dex)}
              color={view.net_dex >= 0 ? 'var(--theme-positive-strong, #15803D)' : 'var(--theme-negative-strong, #991B1B)'}
              sub={view.net_dex >= 0 ? 'Call-heavy book' : 'Put-heavy book'} />
            <Kpi label="Vanna" value={fmtM(view.net_vanna)}
              color={view.net_vanna >= 0 ? 'var(--theme-positive-strong, #15803D)' : 'var(--theme-negative-strong, #991B1B)'}
              sub="per vol point" />
            <Kpi label="Charm" value={fmtM(view.net_charm)}
              color={view.net_charm >= 0 ? 'var(--theme-positive-strong, #15803D)' : 'var(--theme-negative-strong, #991B1B)'}
              sub="per calendar day" />
            <Kpi label="Gamma flip" value={view.flip != null ? usd0(view.flip) : '—'} quiet divide color={T.warn}
              sub={flipGap == null ? 'no sign change' : `spot ${flipGap >= 0 ? 'above' : 'below'} by ${Math.abs(flipGap).toFixed(2)}%`}
              subColor={flipGap == null ? undefined : flipGap >= 0 ? 'var(--theme-positive-strong, #15803D)' : 'var(--theme-negative-strong, #991B1B)'} />
            <Kpi label="Call wall" value={view.call_wall != null ? usd0(view.call_wall) : '—'} quiet color={cc.gain}
              sub={view.call_wall != null && spot ? `resistance · ${pct2(((view.call_wall - spot) / spot) * 100)}` : 'resistance'} />
            <Kpi label="Put wall" value={view.put_wall != null ? usd0(view.put_wall) : '—'} quiet color={cc.loss}
              sub={view.put_wall != null && spot ? `support · ${pct2(((view.put_wall - spot) / spot) * 100)}` : 'support'} />
            <Kpi label="Open interest" value={fmtK(view.call_oi + view.put_oi)} quiet
              sub={`${fmtK(view.call_vol + view.put_vol)} traded today`} />
          </div>

          {/* ── Aligned stack: profile, ribbon, axis, heatmap ─────────────── */}
          {/* One scroller around all three registered regions. They share a
              single column geometry, so they must scroll together or not at
              all — reflowing any one of them breaks the alignment the whole
              layout exists for. */}
          <div style={{ overflowX: isMobile ? 'auto' : 'visible' }}>
           <div style={{ minWidth: isMobile ? 720 : 0 }}>
          <div style={{ border: `1px solid ${T.border}`, borderTop: 'none' }}>
            <PanelHead
              title={`${METRICS[metric].noun} by strike · ${sliced ? selExpiry : `${data.processed.length} expiries`}`}
              right={<span style={{ fontFamily: MONO, fontSize: 9, color: T.textDim }}>
                {metric !== 'gex' && <span style={{ marginRight: 10 }}>levels are gamma-derived</span>}
                {METRICS[metric].unit}
              </span>}
            >
              <div style={{ display: 'flex', gap: 4 }}>
                {(Object.keys(METRICS) as Metric[]).map(m => (
                  <button key={m} onClick={() => setMetric(m)} style={{
                    fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em',
                    padding: '4px 10px', cursor: 'pointer',
                    background: metric === m ? T.text : 'transparent',
                    color: metric === m ? T.bg : T.muted,
                    border: `1px solid ${metric === m ? T.text : T.border}`,
                  }}>{METRICS[m].tab}</button>
                ))}
              </div>
            </PanelHead>

            {cols.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', fontFamily: SANS, fontSize: 11, color: T.muted }}>
                No strikes with open interest inside ±{BAND}% of spot.
              </div>
            ) : (
              <>
                {/* Chip band + plot, one track */}
                <div style={{ display: 'flex' }}>
                  <div style={{ width: GUTTER_L, flexShrink: 0 }} />
                  <div style={{ flex: 1, position: 'relative', height: chipBand + PLOT_H }}>
                    {/* level chips, lane-packed above the plot */}
                    {markers.map(m => (
                      <span key={m.key} style={{
                        position: 'absolute', left: `${m.x}%`, transform: 'translateX(-50%)',
                        top: chipBand - 20 - m.lane * CHIP_LANE, zIndex: 2,
                        background: m.color, color: T.bg, whiteSpace: 'nowrap',
                        fontFamily: MONO, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.06em',
                        padding: '2px 6px',
                      }}>{m.label}</span>
                    ))}
                    {/* gridlines */}
                    {[0, 1, 2, 3, 4].map(i => (
                      <div key={i} aria-hidden style={{
                        position: 'absolute', left: 0, right: 0, top: chipBand + (i / 4) * PLOT_H,
                        borderTop: `1px solid ${mix(T.text, 5)}`,
                      }} />
                    ))}
                    {/* vertical rules */}
                    {rules.map(m => {
                      const from = chipBand - 20 - m.lane * CHIP_LANE + CHIP_H
                      return (
                        <div key={`r-${m.key}`} aria-hidden style={{
                          position: 'absolute', left: `${m.x}%`, marginLeft: m.nudge, zIndex: 1,
                          top: from, height: chipBand + PLOT_H - from,
                          borderLeft: `1px ${m.dashed ? 'dashed' : 'solid'} ${m.color}`,
                        }} />
                      )
                    })}
                    {/* bars */}
                    {profile.values.map((v, i) => {
                      const h = (Math.abs(v) / domain.span) * PLOT_H
                      const on = selStrike === cols[i]
                      const clipped = Math.abs(profile.raw[i]) > Math.abs(v) + 1e-9
                      return (
                        <div key={cols[i]}
                          title={`${usd0(cols[i])} · ${fmtM(profile.raw[i])}${clipped ? ' (bar clipped)' : ''}`}
                          style={{
                          position: 'absolute',
                          left: `${i * colW + colW * (BAR_INSET / 100)}%`,
                          width: `${colW * (1 - 2 * BAR_INSET / 100)}%`,
                          top: chipBand + (v >= 0 ? zeroY - h : zeroY),
                          height: Math.max(1, h),
                          background: v >= 0 ? cc.gain : cc.loss,
                          opacity: 0.85,
                          outline: on ? `1px solid ${T.text}` : undefined,
                          // a clipped bar shows a broken end rather than pretending to be its height
                          ...(clipped ? (v >= 0
                            ? { borderTop: `2px dotted ${T.bg}` }
                            : { borderBottom: `2px dotted ${T.bg}` }) : null),
                        }} />
                      )
                    })}
                  </div>
                  {/* y labels */}
                  <div style={{ width: GUTTER_R, flexShrink: 0, position: 'relative', height: chipBand + PLOT_H }}>
                    {[0, 1, 2, 3, 4].map(i => (
                      <span key={i} style={{
                        position: 'absolute', left: 8, top: chipBand + (i / 4) * PLOT_H,
                        transform: i === 0 ? 'none' : i === 4 ? 'translateY(-100%)' : 'translateY(-50%)',
                        fontFamily: MONO, fontSize: 8.5, color: T.textDim,
                      }}>{axisM(domain.hi - (i / 4) * domain.span)}</span>
                    ))}
                  </div>
                </div>

                {/* Flow ribbon — same columns, directly under the profile */}
                <div style={{ display: 'flex', background: QUIET, borderTop: `1px solid ${T.borderFaint}`, borderBottom: `1px solid ${T.borderFaint}` }}>
                  <div style={{
                    width: GUTTER_L, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                    paddingRight: 10, fontFamily: SANS, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em',
                    textTransform: 'uppercase', color: T.muted, textAlign: 'right', lineHeight: 1.25,
                  }}>Flow<br />today</div>
                  <div style={{ flex: 1, position: 'relative', height: RIBBON_H }}>
                    {rules.map(m => (
                      <div key={`rb-${m.key}`} aria-hidden style={{
                        position: 'absolute', left: `${m.x}%`, marginLeft: m.nudge, top: 0, bottom: 0,
                        borderLeft: `1px ${m.dashed ? 'dashed' : 'solid'} ${mix(m.color, 55)}`,
                      }} />
                    ))}
                    {ribbon.map((f, i) => {
                      const idx = colIndex.get(f.strike)!
                      const on = selStrike === f.strike
                      return (
                        <div key={`${f.expiry}-${f.type}-${f.strike}-${i}`}
                          title={`${f.expiry} ${f.type.toUpperCase()} ${usd0(f.strike)} · ${fmtPrem(f.premium)}`}
                          style={{
                            position: 'absolute',
                            left: `${idx * colW + colW * (BAR_INSET / 100)}%`,
                            width: `${colW * (1 - 2 * BAR_INSET / 100)}%`,
                            bottom: 0, height: `${f.h}%`,
                            background: f.type === 'call' ? cc.gain : cc.loss, opacity: 0.85,
                            outline: on ? `1px solid ${T.text}` : undefined,
                          }} />
                      )
                    })}
                  </div>
                  <div style={{
                    width: GUTTER_R, flexShrink: 0, display: 'flex', alignItems: 'center',
                    paddingLeft: 8, fontFamily: SANS, fontSize: 8, fontWeight: 700,
                    letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted,
                  }}>Premium</div>
                </div>

                {/* Shared x axis */}
                <div style={{ display: 'flex' }}>
                  <div style={{ width: GUTTER_L, flexShrink: 0 }} />
                  <div style={{ flex: 1, position: 'relative', height: 18 }}>
                    {ticks.map(t => (
                      <span key={t.s} style={{
                        position: 'absolute', left: `${(t.i + 0.5) * colW}%`, transform: 'translateX(-50%)',
                        top: 4, fontFamily: MONO, fontSize: 8.5, color: T.textDim, whiteSpace: 'nowrap',
                      }}>${t.s}</span>
                    ))}
                  </div>
                  <div style={{ width: GUTTER_R, flexShrink: 0 }} />
                </div>
              </>
            )}
          </div>

          {/* ── Expiry × strike heatmap ───────────────────────────────────── */}
          {cols.length > 0 && (
            <div style={{ border: `1px solid ${T.border}`, borderTop: 'none' }}>
              <PanelHead title="Expiry × strike · where the book is stacked"
                right={<span style={{ fontFamily: SANS, fontSize: 9.5, color: T.muted }}>
                  same price axis and levels as the profile above · click a row to slice
                </span>} />
              {heatRows.map(row => {
                const active = selExpiry === row.exp
                return (
                  <div key={row.exp}
                    onClick={() => { setSelExpiry(active ? 'ALL' : row.exp); setSelStrike(null) }}
                    style={{
                      display: 'flex', cursor: 'pointer', background: active ? SURFACE : 'transparent',
                      borderTop: `1px solid ${T.borderFaint}`,
                    }}>
                    <div style={{
                      width: GUTTER_L, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
                      paddingLeft: 12, fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: T.text,
                    }}>
                      {row.exp.slice(5)}
                      <span style={{ fontWeight: 400, fontSize: 9, color: T.muted }}>{row.dte}d</span>
                    </div>
                    <div style={{ flex: 1, position: 'relative', height: heatRowH(heatRows.length) }}>
                      {row.cells.map((v, i) => {
                        // Normalised per row so a far-dated expiry still shows its
                        // shape next to a 0DTE book; absolute size lives in the total.
                        const a = Math.min(Math.abs(v) / Math.max(row.rowMax * 0.62, globalMax * 0.05), 1) * 0.92
                        return (
                          <div key={cols[i]} title={`${row.exp} · ${usd0(cols[i])} · ${fmtM(v)}`} style={{
                            position: 'absolute', left: `${i * colW}%`, width: `${colW}%`,
                            top: 3, bottom: 3,
                            background: a < 0.02 ? mix(T.text, 3) : `color-mix(in srgb, ${v >= 0 ? cc.gain : cc.loss} ${Math.round(a * 100)}%, transparent)`,
                          }} />
                        )
                      })}
                      {rules.map(m => (
                        <div key={`h-${row.exp}-${m.key}`} aria-hidden style={{
                          position: 'absolute', left: `${m.x}%`, marginLeft: m.nudge, top: 0, bottom: 0,
                          // four lines over 24 rows: quieter than in the profile
                          borderLeft: `1px ${m.dashed ? 'dashed' : 'solid'} ${mix(m.color, 42)}`,
                        }} />
                      ))}
                    </div>
                    <div style={{
                      width: GUTTER_R, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                      paddingRight: 10, fontFamily: MONO, fontSize: 10, fontWeight: 700,
                      color: row.total >= 0 ? 'var(--theme-positive-strong, #15803D)' : 'var(--theme-negative-strong, #991B1B)',
                    }}>{fmtM(row.total)}</div>
                  </div>
                )
              })}
            </div>
          )}
           </div>
          </div>

          {/* ── History · flow table ──────────────────────────────────────── */}
          <div style={{
            display: 'flex', flexWrap: 'wrap', border: `1px solid ${T.border}`,
            borderTop: 'none', alignItems: 'stretch',
          }}>
            <div style={{
              width: isMobile ? '100%' : HISTORY_W, flex: isMobile ? '1 1 100%' : `0 0 ${HISTORY_W}px`,
              borderRight: isMobile ? 'none' : `1px solid ${T.border}`,
              borderBottom: isMobile ? `1px solid ${T.border}` : 'none',
            }}>
              <PanelHead title="Flip vs spot · accrued history"
                right={<span style={{ fontFamily: MONO, fontSize: 9.5, color: T.muted }}>
                  {defended ? `${defended.held}/${defended.total} sessions closed above flip` : 'no flip recorded yet'}
                </span>} />
              {history.length < 2 ? (
                <div style={{ padding: 30, textAlign: 'center', fontFamily: SANS, fontSize: 11, color: T.muted }}>
                  History accrues one point per trading day from first use. {history.length} point(s) so far for {submitted.ticker}.
                </div>
              ) : (
                <div style={{ padding: '10px 8px 4px' }}>
                  <ResponsiveContainer width="100%" height={228}>
                    <ComposedChart data={history} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke={mix(T.text, 6)} />
                      <XAxis dataKey="d" tick={TICK} interval="preserveStartEnd" minTickGap={26} />
                      <YAxis yAxisId="p" tick={TICK} width={50} tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
                      <YAxis yAxisId="g" orientation="right" hide />
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={TOOLTIP_LABEL} itemStyle={TOOLTIP_ITEM}
                        formatter={(v: number, n: string) => [n === 'Net GEX' ? fmtM(v) : `$${v.toFixed(2)}`, n]} />
                      <Legend wrapperStyle={{ fontSize: 10 }} />
                      <Bar yAxisId="g" dataKey="net" name="Net GEX" fill={T.chartNeutral} />
                      <Line yAxisId="p" dataKey="spot" name="Spot" stroke={T.text} dot={false} strokeWidth={1.5} />
                      <Line yAxisId="p" dataKey="flip" name="Flip" stroke={T.warn} dot={false} strokeWidth={1.5}
                        strokeDasharray="4 3" connectNulls />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
              <PanelHead title={`Flow into this book · ${flow.length} contracts`}
                right={
                  <button onClick={() => setScreenOpen(o => !o)} aria-expanded={screenOpen} style={{
                    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                    fontFamily: MONO, fontSize: 9.5, color: T.muted, textDecoration: 'underline',
                    textUnderlineOffset: 3, textDecorationColor: mix(T.muted, 45),
                  }}>vol ≥ {data.screen.min_volume} · vol/OI ≥ {data.screen.min_vol_oi}</button>
                } />
              {screenOpen && (
                <div style={{
                  position: 'absolute', right: 10, top: 34, zIndex: 30, background: T.bg,
                  border: `1px solid ${T.border}`, boxShadow: '0 14px 34px rgba(0,0,0,0.28)', padding: 12,
                  display: 'flex', alignItems: 'flex-end', gap: 10,
                }}>
                  <label style={{ display: 'block' }}>
                    <span style={LBL}>Min volume</span>
                    <input type="number" min={0} step={100} value={volDraft} onChange={e => setVolDraft(+e.target.value)}
                      style={INP} />
                  </label>
                  <label style={{ display: 'block' }}>
                    <span style={LBL}>Min vol/OI</span>
                    <input type="number" min={0} step={0.5} value={voiDraft} onChange={e => setVoiDraft(+e.target.value)}
                      style={INP} />
                  </label>
                  <button onClick={() => { setScreenOpen(false); load() }} style={{
                    background: T.text, border: 'none', color: T.bg, cursor: 'pointer', fontFamily: SANS,
                    fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '7px 14px',
                  }}>Apply</button>
                </div>
              )}
              {flow.length === 0 ? (
                <div style={{ padding: 30, textAlign: 'center', fontFamily: SANS, fontSize: 11, color: T.muted }}>
                  No contract in this slice cleared the screen.
                </div>
              ) : (
                <div style={{ maxHeight: 268, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11 }}>
                    <thead>
                      <tr>
                        {['Expiry', 'Type', 'Strike', 'OTM%', 'Volume', 'OI', 'Vol/OI', 'Premium'].map((h, i) => (
                          <th key={h} style={{ ...TH, textAlign: i < 2 ? 'left' : 'right' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {flow.slice(0, 120).map((f, i) => {
                        const on = selStrike === f.strike
                        return (
                          <tr key={`${f.expiry}-${f.type}-${f.strike}-${i}`}
                            onClick={() => setSelStrike(on ? null : f.strike)}
                            style={{
                              cursor: 'pointer', borderBottom: `1px solid ${T.borderFaint}`,
                              background: on ? SURFACE : 'transparent',
                            }}>
                            <td style={{ ...TD, textAlign: 'left', color: T.muted }}>{f.expiry.slice(5)}</td>
                            <td style={{
                              ...TD, textAlign: 'left', fontWeight: 700, fontSize: 10,
                              color: f.type === 'call' ? cc.gain : cc.loss,
                            }}>{f.type.toUpperCase()}</td>
                            <td style={{ ...TD, fontWeight: 700 }}>{f.strike}</td>
                            <td style={{
                              ...TD,
                              color: f.moneyness >= 0 ? 'var(--theme-positive-strong, #15803D)' : 'var(--theme-negative-strong, #991B1B)',
                            }}>{f.moneyness >= 0 ? '+' : '−'}{Math.abs(f.moneyness).toFixed(1)}%</td>
                            <td style={TD}>{f.volume.toLocaleString('en-US')}</td>
                            <td style={{ ...TD, color: T.muted }}>{f.oi.toLocaleString('en-US')}</td>
                            <td style={{ ...TD, fontWeight: f.vol_oi >= 5 ? 700 : 400 }}>{f.vol_oi.toFixed(1)}×</td>
                            <td style={{ ...TD, fontWeight: 700 }}>{fmtPrem(f.premium)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}
     </div>
    </div>
  )
}

function PanelHead({ title, right, children }: { title: string; right?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '8px 12px',
      background: SURFACE, borderBottom: `1px solid ${T.border}`,
    }}>
      <span style={{
        fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em',
        textTransform: 'uppercase', color: T.text, whiteSpace: 'nowrap',
      }}>{title}</span>
      {children}
      {right && <span style={{ marginLeft: 'auto' }}>{right}</span>}
    </div>
  )
}

function Kpi({ label, value, sub, subColor, color, big, quiet, divide, first }: {
  label: string; value: string; sub?: string; subColor?: string; color?: string
  big?: boolean; quiet?: boolean; divide?: boolean; first?: boolean
}) {
  return (
    <div style={{
      flex: 1, minWidth: 0, padding: '11px 16px',
      background: quiet ? QUIET : T.bg,
      borderLeft: first ? 'none' : divide ? `1px solid ${mix(T.text, 28)}` : `1px solid ${T.borderFaint}`,
    }}>
      <div style={{
        fontFamily: SANS, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap',
      }}>{label}</div>
      <div style={{
        fontFamily: MONO, fontSize: big ? 16 : 14, fontWeight: 700, marginTop: 5,
        color: color ?? T.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
      }}>{value}</div>
      {sub && <div style={{
        fontFamily: SANS, fontSize: 9, color: subColor ?? T.muted, marginTop: 3, whiteSpace: 'nowrap',
        overflow: 'hidden', textOverflow: 'ellipsis',
      }}>{sub}</div>}
    </div>
  )
}

function Chip({ on, onClick, children, title }: {
  on: boolean; onClick: () => void; children: React.ReactNode; title?: string
}) {
  return (
    <button onClick={onClick} title={title} style={{
      fontFamily: MONO, fontSize: 10, fontWeight: on ? 700 : 400, padding: '4px 9px', cursor: 'pointer',
      whiteSpace: 'nowrap', background: on ? T.text : 'transparent', color: on ? T.bg : T.muted,
      border: `1px solid ${on ? T.text : T.border}`,
    }}>{children}</button>
  )
}

const LBL: React.CSSProperties = {
  display: 'block', fontFamily: SANS, fontSize: 8, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: T.muted, marginBottom: 4,
}
const INP: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: MONO,
  fontSize: 11.5, padding: '6px 8px', width: 92, outline: 'none', boxSizing: 'border-box',
}
const TH: React.CSSProperties = {
  fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
  color: T.muted, padding: '7px 12px', borderBottom: `1px solid ${mix(T.text, 28)}`, whiteSpace: 'nowrap',
  position: 'sticky', top: 0, background: T.bg,
}
const TD: React.CSSProperties = {
  padding: '6px 12px', textAlign: 'right', color: T.text,
  fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

export default function DealerGEX() {
  return <PageWrapper title="Dealer GEX"><DealerGEXContent /></PageWrapper>
}
