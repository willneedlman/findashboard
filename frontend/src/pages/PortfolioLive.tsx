import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { useQuery } from '@tanstack/react-query'
import {
  Area, AreaChart, CartesianGrid, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import PageWrapper from '../components/PageWrapper'
import useIsMobile from '../hooks/useIsMobile'
import EmptyState from '../components/EmptyState'
import TickerLogo from '../components/TickerLogo'
import CustomSelect from '../components/portfolio/CustomSelect'
import { T } from '../lib/theme'
import { MONO, SANS, chg, mix } from './cockpitKit'
import { TOOLTIP_STYLE } from '../components/ChartTooltip'
import { stableValueDomain } from '../lib/chartDomain'
import {
  cashValue, normalizeTicker, PORTFOLIO_CONTEXT_EVENT, readActivePortfolioContext, readPMBooks,
  type PMPortfolio,
} from '../lib/pmImport'
import { MARKETS, marketStatus, PHASE_COLOR, PHASE_LABEL, type Phase } from '../lib/marketHours'

// "Session Board": a calm hero band (book value, today's delta, where the NYSE
// session is, the intraday curve — read together) over a dense detail zone
// (what's driving today, then the positions). Hierarchy comes from the
// background step bg → surface plus one gold hairline, not from panel outlines.

// Will's cadence: 10s while a US session is running. Fully closed, nothing is
// printing, so a 10s poll would burn vendor quota all night for an unchanged
// number — back off rather than pretending the book is still moving.
const LIVE_MS = 10_000
const IDLE_MS = 60_000
// Multi-day curves barely change inside a session, so only the intraday ranges
// earn the live cadence. The header still ticks at 10s off the quote poll.
const SLOW_CURVE_MS = 300_000

const NYSE = MARKETS.find(m => m.id === 'nyse') ?? MARKETS[0]
const LIVE_PHASES: Phase[] = ['pre', 'regular', 'after', 'overnight']

const SPARKS_KEY = 'pm-live-sparks'
// Mirrors the shell's own tool-page gutter (Layout.tsx: px-5 2xl:px-8).
const GUTTER_CLASS = 'px-5 2xl:px-8'

type Range = '1h' | '1d' | '1w' | '1m' | '3m' | 'ytd' | '1y'
const RANGES: { key: Range; label: string }[] = [
  { key: '1h', label: '1HR' }, { key: '1d', label: '1D' }, { key: '1w', label: '1W' },
  { key: '1m', label: '1M' }, { key: '3m', label: '3M' }, { key: 'ytd', label: 'YTD' },
  { key: '1y', label: '1Y' },
]
const INTRADAY_RANGES: Range[] = ['1h', '1d']

type SortKey = 'ticker' | 'price' | 'pct1d' | 'shares' | 'value' | 'pnl' | 'weight'

interface QuoteRow {
  current_price: number | null
  pct_change_1d: number | null
  source?: string
  session?: string
}
interface LivePoint { t: string; value: number }
interface LiveValueResponse {
  points: LivePoint[]
  value: number
  prior_value: number | null
  change_abs: number | null
  change_pct: number | null
  cash: number
  range: Range
  session: string
  session_date: string | null
  interval: string
  priced: string[]
  unpriced: string[]
  source: string
}

const usd = (v: number, digits = 2) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits })
const usdCompact = (v: number) =>
  Math.abs(v) >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : usd(v, 0)
const pct = (v: number | null | undefined, digits = 2) =>
  v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`
const signedUsd = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${usd(Math.abs(v))}`

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function liveBooks() {
  return readPMBooks().filter(candidate => candidate.holdings.length > 0 || (candidate.cash ?? []).length > 0)
}

function activeBook(books = liveBooks()): PMPortfolio | null {
  const active = readActivePortfolioContext()
  return books.find(candidate => candidate.id === active.id) ?? books[0] ?? null
}

function bookCash(book: PMPortfolio): number {
  return (book.cash ?? []).reduce((sum, c) => sum + cashValue(c), 0)
}

/** Shares per normalized symbol, duplicates merged the way the backend merges them. */
function bookShares(book: PMPortfolio): Record<string, number> {
  const out: Record<string, number> = {}
  for (const h of book.holdings ?? []) {
    const sym = normalizeTicker(h.ticker)
    if (!sym || sym === 'CASH' || !h.shares) continue
    out[sym] = (out[sym] ?? 0) + h.shares
  }
  return out
}

/** Minutes since ET midnight for a given instant. */
function etMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const h = +(parts.find(p => p.type === 'hour')?.value ?? 0)
  const m = +(parts.find(p => p.type === 'minute')?.value ?? 0)
  return (h % 24) * 60 + m
}

/** Epoch ms of 09:30 ET on the session the given points belong to. */
function sessionOpenMs(points: { ts: number }[]): number | null {
  const anchor = points.length ? new Date(points[0].ts) : new Date()
  const etDay = anchor.toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
  // Probe both offsets and keep whichever lands on 09:30 ET — avoids hardcoding
  // EDT/EST, which would shift the whole axis by an hour half the year.
  for (const offset of ['-04:00', '-05:00']) {
    const t = new Date(`${etDay}T09:30:00${offset}`).getTime()
    if (Number.isFinite(t) && etMinutes(new Date(t)) === 570) return t
  }
  return null
}

/**
 * Fixed [start, end] epoch-ms bounds for the time axis.
 *
 * A category X axis reflows every time a point is appended, which is what made a
 * small live move look like the whole book was redrawing. A numeric time axis with
 * FIXED bounds keeps every existing point exactly where it was and simply extends
 * the line rightwards. For 1D the right edge is at least an hour past the last
 * print, rounded up to the next 30-minute boundary and clamped to the close — so
 * the axis STEPS in half-hour quanta instead of the line living in the leftmost
 * fifth of an empty session-wide plot.
 */
function timeAxisDomain(range: Range, points: { ts: number }[]): [number, number] {
  const now = Date.now()
  if (range === '1d') {
    const open = sessionOpenMs(points)
    if (open != null) {
      const lastTs = points.length ? Math.max(points[points.length - 1].ts, now) : now
      const sinceOpen = Math.max(0, (lastTs - open) / 60_000)
      const endMin = Math.min(390, Math.max(30, Math.ceil((sinceOpen + 60) / 30) * 30))
      return [open, open + endMin * 60_000]
    }
  }
  const quantum = range === '1h' ? 5 * 60_000
    : range === '1w' || range === '1m' ? 60 * 60_000
      : 24 * 60 * 60_000
  const end = Math.ceil(now / quantum) * quantum
  const firstTs = points.length ? points[0].ts : end - quantum
  const start = range === '1h' ? end - 60 * 60_000 : firstTs
  return [start, end]
}

function axisTickFormatter(range: Range) {
  const opts: Intl.DateTimeFormatOptions = INTRADAY_RANGES.includes(range)
    ? { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' }
    : range === '1w' || range === '1m'
      ? { month: 'short', day: 'numeric', timeZone: 'America/New_York' }
      : { month: 'short', year: '2-digit', timeZone: 'America/New_York' }
  return (ts: number) => new Date(ts).toLocaleString('en-US', opts)
}

/** Tracks which symbols just moved, so the table can flash them. */
function useTickFlash(prices: Record<string, number | null>) {
  const prev = useRef<Record<string, number | null>>({})
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({})

  useEffect(() => {
    const next: Record<string, 'up' | 'down'> = {}
    for (const [sym, price] of Object.entries(prices)) {
      const before = prev.current[sym]
      if (price != null && before != null && price !== before) next[sym] = price > before ? 'up' : 'down'
    }
    prev.current = { ...prices }
    if (!Object.keys(next).length) return
    setFlash(next)
    const timer = setTimeout(() => setFlash({}), 950)
    return () => clearTimeout(timer)
  }, [prices])

  return flash
}

/**
 * Tween a changing number so the hero counts up rather than jumping. Cubic
 * ease-out over ~650ms; under reduced motion it snaps, which is the point.
 */
function useCountUp(target: number | null, ms = 650): number | null {
  const [shown, setShown] = useState<number | null>(target)
  const fromRef = useRef<number | null>(target)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (target == null) { setShown(null); fromRef.current = null; return }
    const from = fromRef.current
    if (from == null || prefersReducedMotion() || Math.abs(target - from) < 0.005) {
      fromRef.current = target
      setShown(target)
      return
    }
    const start = performance.now()
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / ms)
      const eased = 1 - Math.pow(1 - p, 3)
      const v = from + (target - from) * eased
      setShown(v)
      if (p < 1) rafRef.current = requestAnimationFrame(step)
      else fromRef.current = target
    }
    rafRef.current = requestAnimationFrame(step)
    return () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current) }
  }, [target, ms])

  return shown
}

function countdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

interface Row {
  ticker: string; name?: string | null; shares: number; price: number | null; pct1d: number | null
  value: number | null; dayPnl: number | null; source?: string
  // Only the table needs it; the tape and contribution strip read the raw rows.
  weight?: number | null
}

export function PortfolioLiveContent({ view, onView }: { view?: string; onView?: (k: string) => void } = {}) {
  const [books, setBooks] = useState<PMPortfolio[]>(() => liveBooks())
  const [book, setBook] = useState<PMPortfolio | null>(() => activeBook())
  const [range, setRange] = useState<Range>('1d')
  const [now, setNow] = useState(() => new Date())
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'value', dir: 'desc' })
  const [openSparks, setOpenSparks] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem(SPARKS_KEY) || '{}') } catch { return {} }
  })

  useEffect(() => {
    try { localStorage.setItem(SPARKS_KEY, JSON.stringify(openSparks)) } catch { /* quota */ }
  }, [openSparks])

  useEffect(() => {
    const sync = () => {
      const next = liveBooks()
      setBooks(next)
      setBook(current => next.find(candidate => candidate.id === current?.id) ?? activeBook(next))
    }
    window.addEventListener(PORTFOLIO_CONTEXT_EVENT, sync)
    return () => window.removeEventListener(PORTFOLIO_CONTEXT_EVENT, sync)
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const status = marketStatus(NYSE, now)
  const phase = status.phase
  const isLive = LIVE_PHASES.includes(phase)
  const interval = isLive ? LIVE_MS : IDLE_MS

  const shares = useMemo(() => (book ? bookShares(book) : {}), [book])
  const symbols = useMemo(() => Object.keys(shares).sort(), [shares])
  const cash = useMemo(() => (book ? bookCash(book) : 0), [book])
  const symbolKey = symbols.join(',')

  const quotesQ = useQuery<{ quotes: Record<string, QuoteRow>; source: string }>({
    queryKey: ['pl-quotes', symbolKey],
    queryFn: () => axios.get(`/api/market/quotes?tickers=${encodeURIComponent(symbolKey)}`).then(r => r.data),
    enabled: symbols.length > 0,
    refetchInterval: interval,
    refetchIntervalInBackground: false,
    staleTime: interval / 2,
  })

  const curveInterval = INTRADAY_RANGES.includes(range) ? interval : SLOW_CURVE_MS
  const curveQ = useQuery<LiveValueResponse>({
    queryKey: ['pl-curve', symbolKey, Math.round(cash), range],
    queryFn: () => axios.post('/api/portfolio/live-value', {
      holdings: symbols.map(ticker => ({ ticker, shares: shares[ticker] })),
      cash, range,
    }).then(r => r.data),
    enabled: symbols.length > 0 || cash > 0,
    refetchInterval: curveInterval,
    refetchIntervalInBackground: false,
    staleTime: curveInterval / 2,
    retry: 1,
    placeholderData: prev => prev,   // keep the old curve while a range switch loads
  })

  // Company names for the row sub-line. Batch, cached hard, and entirely
  // optional — this source has no name for most ETFs, so a row without one just
  // shows its ticker rather than a placeholder.
  const namesQ = useQuery<{ rows: { symbol: string; companyName?: string | null }[] }>({
    queryKey: ['pl-names', symbolKey],
    queryFn: () => axios.get(`/api/earnings/profile?symbols=${encodeURIComponent(symbolKey)}`).then(r => r.data),
    enabled: symbols.length > 0,
    staleTime: 24 * 60 * 60_000,
    retry: false,
  })
  const nameBySymbol = useMemo(() => {
    const out: Record<string, string> = {}
    for (const r of namesQ.data?.rows ?? []) if (r.companyName) out[r.symbol] = r.companyName
    return out
  }, [namesQ.data])

  // Per-row intraday shapes. One batched call for the whole book, fired only
  // once a row is actually expanded, then cached — there is no per-symbol
  // intraday endpoint and N single fetches would be far worse.
  const sparkQ = useQuery<{ series: Record<string, number | string | null>[]; tickers: string[] }>({
    queryKey: ['pl-sparks', symbolKey],
    queryFn: () => axios.get(`/api/market/compare?tickers=${encodeURIComponent(symbolKey)}&period=1d&normalize=price`).then(r => r.data),
    enabled: symbols.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const sparkBySymbol = useMemo(() => {
    const series = sparkQ.data?.series ?? []
    if (!series.length) return {} as Record<string, number[]>
    // The endpoint returns several sessions; keep the latest ET date so the
    // sparkline is today's shape, not a multi-day squiggle.
    const dayOf = (r: Record<string, unknown>) => String(r.date ?? '').slice(0, 10)
    const lastDay = dayOf(series[series.length - 1])
    const today = series.filter(r => dayOf(r) === lastDay)
    const window = today.length >= 5 ? today : series.slice(-30)
    const out: Record<string, number[]> = {}
    for (const sym of symbols) {
      const vals = window.map(r => r[sym]).filter((v): v is number => typeof v === 'number')
      if (vals.length >= 2) out[sym] = vals.length > 40 ? vals.filter((_, i) => i % Math.ceil(vals.length / 40) === 0) : vals
    }
    return out
  }, [sparkQ.data, symbols])

  const quotes = quotesQ.data?.quotes ?? {}
  const priceBySymbol = useMemo(() => {
    const out: Record<string, number | null> = {}
    for (const sym of symbols) out[sym] = quotes[sym]?.current_price ?? null
    return out
  }, [symbols, quotes])
  const flash = useTickFlash(priceBySymbol)

  const baseRows = useMemo(() => symbols.map(sym => {
    const q = quotes[sym]
    const price = q?.current_price ?? null
    const qty = shares[sym]
    return {
      ticker: sym,
      name: nameBySymbol[sym] ?? null,
      shares: qty,
      price,
      pct1d: q?.pct_change_1d ?? null,
      value: price != null ? price * qty : null,
      // Back out the prior close from the 1D move rather than refetching it:
      // prior = price / (1 + pct/100), so P&L/share = price * pct / (100 + pct).
      dayPnl: price != null && q?.pct_change_1d != null && q.pct_change_1d !== -100
        ? price * qty * (q.pct_change_1d / (100 + q.pct_change_1d))
        : null,
      source: q?.source,
    }
  }), [symbols, quotes, shares, nameBySymbol])

  const equityValue = baseRows.reduce((sum, r) => sum + (r.value ?? 0), 0)
  const anyPriced = baseRows.some(r => r.value != null)
  const bookValue = (anyPriced || !symbols.length ? equityValue : 0) + cash
  const totalForWeights = equityValue + cash

  const rows: Row[] = useMemo(() => {
    // Guard the divide: nothing priced means every weight would read "—".
    const withWeight = baseRows.map(r => ({
      ...r,
      weight: r.value != null && totalForWeights > 0 ? (r.value / totalForWeights) * 100 : null,
    }))
    // Every column sorts. Nulls sink to the bottom either way rather than
    // sorting as -1, which would rank an unpriced name above a real loss.
    const val = (r: Row): number | string | null => {
      switch (sort.key) {
        case 'ticker': return r.ticker
        case 'price':  return r.price
        case 'pct1d':  return r.pct1d
        case 'shares': return r.shares
        case 'pnl':    return r.dayPnl
        case 'weight': return r.weight ?? null
        default:       return r.value
      }
    }
    const mult = sort.dir === 'desc' ? -1 : 1
    return withWeight.sort((a, b) => {
      const av = val(a), bv = val(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'string' || typeof bv === 'string') {
        return String(av).localeCompare(String(bv)) * mult
      }
      return (av - bv) * mult
    })
  }, [baseRows, totalForWeights, sort])

  const curve = curveQ.data
  // KNOWN ISSUE FIX: the header used to take prior_value from the server curve
  // while the rows backed the prior close out of each quote, so the two
  // disagreed (−$0.29 header vs −$1.00 of rows). For the session view the rows
  // are the source of truth, so the baseline is derived from them and the hero
  // delta equals the sum of Day P&L by construction.
  const rowBaseline = useMemo(() => {
    if (!anyPriced) return null
    let prior = 0
    for (const r of baseRows) {
      if (r.value == null) continue
      prior += r.dayPnl != null ? r.value - r.dayPnl : r.value
    }
    return prior + cash
  }, [baseRows, anyPriced, cash])

  const serverBaseline = curve?.prior_value ?? null
  const baseline = range === '1d' && rowBaseline != null ? rowBaseline : serverBaseline
  const gainAbs = baseline != null && anyPriced ? bookValue - baseline : curve?.change_abs ?? null
  const gainPct = baseline != null && baseline !== 0 && anyPriced
    ? (bookValue / baseline - 1) * 100
    : curve?.change_pct ?? null

  // The server curve is built from bars, so its tip can trail by minutes.
  // Appending the live mark is what makes the line actually tick.
  const chartData = useMemo(() => {
    const base = (curve?.points ?? []).map(p => ({ ts: new Date(p.t).getTime(), value: p.value }))
    if (!base.length || !anyPriced) return base
    const last = base[base.length - 1]
    if (Math.abs(last.value - bookValue) < 0.005) return base
    return [...base, { ts: Date.now(), value: bookValue }]
  }, [curve, bookValue, anyPriced])

  const yDomain = useMemo(
    () => stableValueDomain(chartData.map(p => p.value), baseline),
    [chartData, baseline],
  )
  const xDomain = useMemo(() => timeAxisDomain(range, chartData), [range, chartData])
  const tickFmt = useMemo(() => axisTickFormatter(range), [range])

  const displayValue = useCountUp(anyPriced || !symbols.length ? bookValue : null)
  const unpriced = baseRows.filter(r => r.value == null).map(r => r.ticker)
  const rangeLabel = RANGES.find(r => r.key === range)?.label ?? range
  const grossMoves = baseRows.reduce((s, r) => s + Math.abs(r.dayPnl ?? 0), 0)

  if (!book) {
    return (
      <EmptyState
        title="No portfolio to track"
        hint="Build a book in Portfolio Manager first, then come back to watch it move."
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <LiveTopBar
        books={books} book={book} onPick={setBook}
        view={view} onView={onView}
        phase={phase} isLive={isLive} interval={interval}
        source={quotesQ.data?.source} now={now}
      />

      <TickerTape rows={baseRows} />

      <HeroBand
        value={displayValue}
        gainAbs={gainAbs} gainPct={gainPct}
        rangeIsToday={range === '1d'} rangeLabel={rangeLabel}
        baseline={baseline} cash={cash} positions={symbols.length}
        phase={phase} msToNext={status.msToNext} now={now}
        range={range} onRange={setRange}
        chartData={chartData} xDomain={xDomain} yDomain={yDomain} tickFmt={tickFmt}
        loading={curveQ.isLoading} error={curveQ.isError}
      />

      <ContributionStrip rows={baseRows} gross={grossMoves} />

      <PositionsTable
        rows={rows} flash={flash} sort={sort} onSort={setSort}
        openSparks={openSparks}
        onToggleSpark={sym => setOpenSparks(p => ({ ...p, [sym]: p[sym] === false }))}
        sparks={sparkBySymbol} sparksLoading={sparkQ.isLoading}
      />

      {unpriced.length > 0 && (
        <div className={GUTTER_CLASS} style={{ fontFamily: SANS, fontSize: 10, color: T.muted, paddingTop: 10 }}>
          No live mark for {unpriced.join(', ')}. Those names are excluded from book value and the curve.
        </div>
      )}
    </div>
  )
}

// ─── 1. Header row ──────────────────────────────────────────────────────────

function LiveTopBar({ books, book, onPick, view, onView, phase, isLive, interval, source, now }: {
  books: PMPortfolio[]; book: PMPortfolio; onPick: (b: PMPortfolio) => void
  view?: string; onView?: (k: string) => void
  phase: Phase; isLive: boolean; interval: number; source?: string; now: Date
}) {
  const dot = isLive ? PHASE_COLOR[phase] : T.muted
  const sourceLabel = source
    ? source === 'realtime' ? 'REAL-TIME' : source === 'batch_history' ? 'DELAYED' : source.toUpperCase().replace(/_/g, ' ')
    : null
  return (
    <div className={GUTTER_CLASS} style={{
      display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      paddingTop: 10, paddingBottom: 8,
    }}>
      <span style={{
        fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.18em',
        textTransform: 'uppercase', color: T.gold,
      }}>Portfolio</span>

      {onView && (
        <div style={{ background: T.surface, padding: 3, display: 'flex', gap: 2 }}>
          {[{ k: 'book', l: 'Book' }, { k: 'live', l: 'Live' }].map(t => {
            const active = (view ?? 'live') === t.k
            return (
              <button key={t.k} onClick={() => onView(t.k)} aria-pressed={active} style={{
                fontFamily: SANS, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', padding: '5px 11px', border: 'none', cursor: 'pointer',
                color: active ? T.gold : T.muted,
                background: active ? T.goldTint(14) : 'transparent',
              }}>{t.l}</button>
            )
          })}
        </div>
      )}

      <div style={{ minWidth: 110, maxWidth: 200 }}>
        <CustomSelect
          ariaLabel="Book"
          value={book.id}
          onChange={id => { const next = books.find(b => b.id === id); if (next) onPick(next) }}
          options={books.map(b => ({ value: b.id, label: b.name }))}
          style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 600, color: T.text, border: 'none', background: 'transparent', padding: '2px 20px 2px 0' }}
        />
      </div>

      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <span
            className={isLive ? 'ft-live-dot' : undefined}
            style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }}
          />
          <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', color: dot }}>
            {isLive ? 'LIVE' : 'IDLE'}
          </span>
          <span style={{ fontFamily: SANS, fontSize: 10, color: T.muted }}>
            refreshing every {Math.round(interval / 1000)}s
          </span>
        </span>
        {sourceLabel && (
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: '0.08em', color: mix(T.muted, 75) }}>{sourceLabel}</span>
        )}
        <span style={{ fontFamily: MONO, fontSize: 11, color: T.text, letterSpacing: '0.04em', fontVariantNumeric: 'tabular-nums' }}>
          {now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York', hour12: false })}
          <span style={{ fontSize: 9, color: mix(T.muted, 75), marginLeft: 3 }}>ET</span>
        </span>
      </span>
    </div>
  )
}

// ─── 2. Ticker tape ─────────────────────────────────────────────────────────

function TickerTape({ rows }: { rows: Row[] }) {
  const items = rows.filter(r => r.price != null)
  if (!items.length) return null
  // Rendered twice back to back so translateX(-50%) loops seamlessly.
  const doubled = [...items, ...items]
  return (
    <div style={{ height: 26, overflow: 'hidden', background: T.surface, display: 'flex', alignItems: 'center' }}>
      <div className="ft-tape-track" style={{ display: 'flex', width: 'max-content' }}>
        {doubled.map((r, i) => (
          <span key={`${r.ticker}-${i}`} style={{
            padding: '0 14px', borderRight: `1px solid ${T.borderFaint}`, whiteSpace: 'nowrap',
            fontFamily: MONO, fontVariantNumeric: 'tabular-nums', display: 'inline-flex', gap: 6, alignItems: 'baseline',
          }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, color: T.text, letterSpacing: '0.04em' }}>{r.ticker}</span>
            <span style={{ fontSize: 10.5, color: T.muted }}>{r.price == null ? '—' : usd(r.price)}</span>
            <span style={{ fontSize: 10.5, fontWeight: 600, color: chg(r.pct1d) }}>{pct(r.pct1d)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── 3. Hero band ───────────────────────────────────────────────────────────

function HeroBand(props: {
  value: number | null; gainAbs: number | null; gainPct: number | null
  rangeIsToday: boolean; rangeLabel: string
  baseline: number | null; cash: number; positions: number
  phase: Phase; msToNext: number; now: Date
  range: Range; onRange: (r: Range) => void
  chartData: { ts: number; value: number }[]
  xDomain: [number, number]; yDomain: [number, number] | undefined
  tickFmt: (ts: number) => string
  loading: boolean; error: boolean
}) {
  const {
    value, gainAbs, gainPct, rangeIsToday, rangeLabel, baseline, cash, positions,
    phase, msToNext, now, range, onRange, chartData, xDomain, yDomain, tickFmt, loading, error,
  } = props
  const isMobile = useIsMobile()
  const deltaColor = chg(gainAbs)
  const phaseColor = PHASE_COLOR[phase]
  const nextLabel = phase === 'regular' ? `closes in ${countdown(msToNext)}`
    : phase === 'pre' ? `opens in ${countdown(msToNext)}`
      : phase === 'after' ? `after-hours ends in ${countdown(msToNext)}`
        : `opens in ${countdown(msToNext)}`

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(0, 340px) minmax(0, 1fr)',
      background: T.surface, borderTop: `1px solid ${T.goldTint(28)}`,
    }}>
      {/* Left: the number, the session */}
      <div style={{
        padding: isMobile ? '14px 14px 12px' : '18px 20px 16px', minWidth: 0,
        borderRight: isMobile ? 'none' : `1px solid ${T.borderFaint}`,
        borderBottom: isMobile ? `1px solid ${T.borderFaint}` : 'none',
      }}>
        <span style={eyebrow}>Book Value</span>
        <div style={{
          fontFamily: MONO, fontSize: 34, fontWeight: 700, lineHeight: 1, letterSpacing: 'var(--theme-num-tracking, normal)',
          fontVariantNumeric: 'tabular-nums', color: T.text, marginTop: 8,
        }}>{value == null ? '—' : usd(value)}</div>

        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: deltaColor }}>
            {gainAbs == null ? '—' : signedUsd(gainAbs)}
          </span>
          {gainPct != null && (
            <span style={{
              fontFamily: MONO, fontSize: 11, fontWeight: 700, color: deltaColor,
              background: `color-mix(in srgb, ${deltaColor} 14%, transparent)`, padding: '3px 7px',
            }}>{pct(gainPct)}</span>
          )}
          <span style={{ fontFamily: SANS, fontSize: 10, color: T.muted }}>{rangeIsToday ? 'today' : rangeLabel}</span>
        </div>

        <div style={{ height: 1, background: T.borderFaint, marginTop: 16 }} />

        <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: T.text }}>NYSE</span>
            <span style={{
              fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
              color: phaseColor, background: `color-mix(in srgb, ${phaseColor} 12%, transparent)`, padding: '3px 7px',
            }}>{PHASE_LABEL[phase]}</span>
          </span>
          <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.muted, whiteSpace: 'nowrap' }}>{nextLabel}</span>
        </div>

        <SessionRail now={now} />

        <div style={{ marginTop: 16, display: 'flex', gap: 22, flexWrap: 'wrap' }}>
          <Stat label={rangeIsToday ? 'Prior Close' : 'Period Start'} value={baseline == null ? '—' : usd(baseline)} />
          <Stat label="Cash" value={usd(cash)} dim={cash === 0} />
          <Stat label="Positions" value={String(positions)} />
        </div>
      </div>

      {/* Right: the curve */}
      <div style={{ padding: '14px 16px 10px', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <span style={eyebrow}>
            {rangeIsToday
              ? `Today · 09:30 → ${tickFmt(xDomain[1])} ET`
              : `${rangeLabel} · ${tickFmt(xDomain[0])} → ${tickFmt(xDomain[1])}`}
          </span>
          <div style={{ display: 'flex', gap: 1, background: T.borderFaint }}>
            {RANGES.map(r => (
              <button key={r.key} onClick={() => onRange(r.key)} aria-pressed={range === r.key} style={{
                fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em',
                padding: '4px 9px', border: 'none', cursor: 'pointer',
                color: range === r.key ? T.gold : mix(T.muted, 75),
                background: range === r.key ? T.goldTint(16) : 'transparent',
              }}>{r.label}</button>
            ))}
          </div>
        </div>

        <div style={{ height: 208, marginTop: 8 }}>
          {error ? (
            <Centered>No price data for this book in this range.</Centered>
          ) : !chartData.length ? (
            <Centered>{loading ? 'Loading the value curve…' : 'No bars for this range.'}</Centered>
          ) : (
            <ValueChart
              data={chartData} xDomain={xDomain} yDomain={yDomain} tickFmt={tickFmt}
              baseline={baseline} rangeIsToday={rangeIsToday}
            />
          )}
        </div>
      </div>
    </div>
  )
}

const eyebrow: React.CSSProperties = {
  fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: T.muted, display: 'block',
}

function Stat({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div>
      <div style={{ fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: mix(T.muted, 75) }}>{label}</div>
      <div style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: dim ? mix(T.muted, 75) : T.text, marginTop: 4 }}>{value}</div>
    </div>
  )
}

/** 04:00 → 20:00 ET rail with the three session segments and a now-marker. */
function SessionRail({ now }: { now: Date }) {
  // Ticks once a minute, not once a second — the marker cannot move faster.
  const minute = Math.floor(etMinutes(now))
  const pos = Math.min(100, Math.max(0, ((minute - 240) / 960) * 100))
  const inRail = minute >= 240 && minute <= 1200
  const segs = [
    { pctW: 34.4, color: T.goldTint(30) },   // 04:00–09:30 pre
    { pctW: 40.6, color: `color-mix(in srgb, ${T.pos} 55%, transparent)` },   // 09:30–16:00 regular
    { pctW: 25.0, color: T.goldTint(30) },   // 16:00–20:00 after
  ]
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ position: 'relative', display: 'flex', height: 6 }}>
        {segs.map((s, i) => <span key={i} style={{ width: `${s.pctW}%`, background: s.color }} />)}
        {inRail && (
          <span style={{ position: 'absolute', left: `${pos}%`, top: -3, bottom: -3, width: 2, background: T.gold }} />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontFamily: MONO, fontSize: 8.5, letterSpacing: '0.06em', color: mix(T.muted, 75) }}>
        <span>04:00 PRE</span><span>09:30</span><span>16:00</span><span>20:00 AFT</span>
      </div>
    </div>
  )
}

/** X tick that dims anything after "now" — the axis runs past the last print. */
function AxisTick({ x, y, payload, fmt, nowTs }: {
  x?: number; y?: number; payload?: { value: number }; fmt: (ts: number) => string; nowTs: number
}) {
  if (payload == null || x == null || y == null) return null
  const future = payload.value > nowTs
  return (
    <text x={x} y={y + 10} textAnchor="middle" fontFamily={MONO} fontSize={9}
      fill={future ? mix(T.muted, 40) : mix(T.muted, 75)}>{fmt(payload.value)}</text>
  )
}

function ValueChart({ data, xDomain, yDomain, tickFmt, baseline, rangeIsToday }: {
  data: { ts: number; value: number }[]
  xDomain: [number, number]; yDomain: [number, number] | undefined
  tickFmt: (ts: number) => string; baseline: number | null; rangeIsToday: boolean
}) {
  const last = data[data.length - 1]
  const nowTs = Math.min(last?.ts ?? Date.now(), xDomain[1])
  const up = baseline == null || last == null ? true : last.value >= baseline
  const lineColor = up ? T.pos : T.neg
  const still = prefersReducedMotion()

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 4 }}>
        <defs>
          <linearGradient id="pl-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={lineColor} stopOpacity={0.3} />
            <stop offset="100%" stopColor={lineColor} stopOpacity={0.01} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={T.borderFaint} vertical={false} />
        {/* The part of the axis the session has not reached yet. */}
        {nowTs < xDomain[1] && (
          <ReferenceArea x1={nowTs} x2={xDomain[1]} fill="rgba(255,255,255,0.018)" stroke="none" />
        )}
        <XAxis
          dataKey="ts" type="number" scale="time" domain={xDomain}
          tick={<AxisTick fmt={tickFmt} nowTs={nowTs} />}
          stroke={T.borderFaint} minTickGap={44} tickLine={false} axisLine={false}
        />
        <YAxis
          domain={yDomain} width={58} orientation="right" allowDataOverflow tickCount={5}
          tick={{ fill: mix(T.muted, 75), fontSize: 9, fontFamily: MONO }}
          stroke={T.borderFaint} tickLine={false} axisLine={false}
          tickFormatter={(v: number) => usdCompact(v)}
        />
        {baseline != null && (
          <ReferenceLine
            y={baseline} stroke={T.muted} strokeOpacity={0.7} strokeDasharray="4 4"
            label={{
              value: `${rangeIsToday ? 'prior close' : 'period start'} ${usd(baseline)}`,
              position: 'insideTopLeft', offset: 6,
              fill: T.muted, fontSize: 9, fontFamily: MONO,
            }}
          />
        )}
        {nowTs < xDomain[1] && (
          <ReferenceLine x={nowTs} stroke={T.gold} strokeOpacity={0.5} strokeDasharray="3 4" />
        )}
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          labelFormatter={(ts: number) => `${new Date(ts).toLocaleString('en-US', {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            hour12: false, timeZone: 'America/New_York',
          })} ET`}
          formatter={(v: number) => [usd(v), 'Book value']}
        />
        <Area
          type="monotone" dataKey="value" stroke={lineColor} strokeWidth={1.8}
          fill="url(#pl-fill)" isAnimationActive={false}
          dot={(p: { cx?: number; cy?: number; index?: number }) => {
            // Live tip: a breathing halo on the last print only.
            const isLast = p.index === data.length - 1
            if (!isLast || p.cx == null || p.cy == null) return <g key={`d-${p.index}`} />
            return (
              <g key="tip">
                <circle cx={p.cx} cy={p.cy} r={4} fill={lineColor} opacity={0.3}>
                  {!still && <>
                    <animate attributeName="r" values="2.4;4;2.4" dur="1.6s" repeatCount="indefinite" />
                    <animate attributeName="opacity" values="1;0.45;1" dur="1.6s" repeatCount="indefinite" />
                  </>}
                </circle>
                <circle cx={p.cx} cy={p.cy} r={2.4} fill={lineColor} />
              </g>
            )
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: SANS, fontSize: 11, color: T.muted }}>
      {children}
    </div>
  )
}

// ─── 4. Contribution strip ──────────────────────────────────────────────────

function ContributionStrip({ rows, gross }: { rows: Row[]; gross: number }) {
  const barRef = useRef<HTMLDivElement>(null)
  // Most segments are too narrow to carry their ticker, so the whole point of
  // the bar is lost without this — the small ones on the right are unreadable
  // otherwise. Measured off the DOM rather than the raw share, because the 1.2%
  // minimum width means the segments flex-shrink away from their nominal sizes.
  const [hover, setHover] = useState<{ row: Row; x: number } | null>(null)
  const show = (row: Row) => (e: React.MouseEvent<HTMLElement> | React.FocusEvent<HTMLElement>) => {
    const el = e.currentTarget
    const barWidth = barRef.current?.offsetWidth ?? 0
    const centre = el.offsetLeft + el.offsetWidth / 2
    setHover({ row, x: Math.min(Math.max(centre, 62), Math.max(62, barWidth - 62)) })
  }

  const ranked = useMemo(
    () => rows.filter(r => r.dayPnl != null && r.dayPnl !== 0)
      .sort((a, b) => Math.abs(b.dayPnl!) - Math.abs(a.dayPnl!)),
    [rows],
  )

  // A segment gets its ticker whenever the ticker actually fits, which is a
  // question about rendered pixels, not about share of gross — so measure the
  // bar. Widths carry a 1.2% floor, so they can sum past 100% and flex shrinks
  // them proportionally; the rendered width is w/sumW of the space left after
  // the 2px gaps, not w% of the bar.
  const [barW, setBarW] = useState(0)
  useLayoutEffect(() => {
    const el = barRef.current
    if (!el) return
    setBarW(el.clientWidth)
    const ro = new ResizeObserver(entries => setBarW(entries[0].contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ranked.length])

  const segs = useMemo(() => {
    const base = ranked.map(r => ({ r, w: Math.max(1.2, Math.abs(r.dayPnl!) / gross * 100) }))
    const sumW = base.reduce((s, x) => s + x.w, 0) || 1
    const inner = Math.max(0, barW - Math.max(0, base.length - 1) * 2)
    return base.map(({ r, w }) => ({
      r, w,
      // 8.5px mono runs ~5.3px/char; 8px of breathing room either side.
      fits: (w / sumW) * inner >= r.ticker.length * 5.3 + 8,
    }))
  }, [ranked, gross, barW])

  if (!ranked.length || gross <= 0) return null
  return (
    <div className={GUTTER_CLASS} style={{ marginTop: 12 }}>
      <div style={{ background: T.surface, padding: '11px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <span style={eyebrow}>What's driving today</span>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: mix(T.muted, 75) }}>gross moves · {usd(gross)}</span>
      </div>
      <div ref={barRef} onMouseLeave={() => setHover(null)}
        style={{ position: 'relative', display: 'flex', height: 18, gap: 2, marginTop: 10 }}>
        {segs.map(({ r, w, fits }) => {
          const share = Math.abs(r.dayPnl!) / gross * 100
          const color = r.dayPnl! >= 0 ? T.pos : T.neg
          const active = hover?.row.ticker === r.ticker
          return (
            <button
              key={r.ticker}
              onMouseEnter={show(r)}
              onFocus={show(r)}
              onBlur={() => setHover(null)}
              aria-label={`${r.ticker} ${signedUsd(r.dayPnl!)}, ${share.toFixed(1)}% of today's gross moves`}
              style={{
                width: `${w}%`, background: `color-mix(in srgb, ${color} ${active ? 85 : 55}%, transparent)`,
                border: 'none', padding: 0, cursor: 'default', display: 'grid', placeItems: 'center',
                overflow: 'hidden', transition: 'background 120ms ease-out',
              }}>
              {fits && (
                <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, color: T.text }}>{r.ticker}</span>
              )}
            </button>
          )
        })}
        {hover && (
          <div style={{
            position: 'absolute', left: hover.x, bottom: 'calc(100% + 7px)', transform: 'translateX(-50%)',
            zIndex: 5, pointerEvents: 'none', whiteSpace: 'nowrap',
            background: T.bg, border: `1px solid ${T.border}`, padding: '6px 9px',
            boxShadow: '0 8px 22px rgba(0,0,0,0.4)',
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: T.text }}>{hover.row.ticker}</span>
              <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: chg(hover.row.dayPnl) }}>
                {signedUsd(hover.row.dayPnl!)}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 10, color: chg(hover.row.pct1d) }}>{pct(hover.row.pct1d)}</span>
            </div>
            <div style={{ fontFamily: MONO, fontSize: 9, color: mix(T.muted, 75), marginTop: 3 }}>
              {(Math.abs(hover.row.dayPnl!) / gross * 100).toFixed(1)}% of gross
              {hover.row.value != null && ` · ${usd(hover.row.value)} held`}
            </div>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 9 }}>
        {ranked.slice(0, 6).map(r => (
          <span key={r.ticker} style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: T.text }}>{r.ticker}</span>
            <span style={{ fontFamily: MONO, fontSize: 10.5, color: chg(r.dayPnl) }}>{signedUsd(r.dayPnl!)}</span>
          </span>
        ))}
        </div>
      </div>
    </div>
  )
}

// ─── 5. Positions ───────────────────────────────────────────────────────────

function RowSparkline({ points, positive }: { points: number[]; positive: boolean }) {
  const W = 84, H = 18
  const min = Math.min(...points), max = Math.max(...points)
  const range = max - min || 1
  const xy = points.map((v, i) => [
    (i / (points.length - 1)) * W,
    H - 2 - ((v - min) / range) * (H - 4),
  ] as const)
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const color = positive ? T.pos : T.neg
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }} aria-hidden>
      <path d={`${line} L${W},${H} L0,${H} Z`} fill={color} fillOpacity={0.16} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth={1.2} strokeLinejoin="round" />
    </svg>
  )
}

function PositionsTable({ rows, flash, sort, onSort, openSparks, onToggleSpark, sparks, sparksLoading }: {
  rows: Row[]; flash: Record<string, 'up' | 'down'>
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  onSort: (s: { key: SortKey; dir: 'asc' | 'desc' }) => void
  openSparks: Record<string, boolean>; onToggleSpark: (sym: string) => void
  sparks: Record<string, number[]>; sparksLoading: boolean
}) {
  const th: React.CSSProperties = {
    padding: '7px 12px', fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em',
    textTransform: 'uppercase', color: mix(T.muted, 75), borderBottom: `1px solid ${T.border}`,
    whiteSpace: 'nowrap',
  }
  const td: React.CSSProperties = {
    padding: '7px 12px', fontFamily: MONO, fontSize: 11.5, color: T.text,
    fontVariantNumeric: 'tabular-nums', borderBottom: `1px solid ${T.borderFaint}`, whiteSpace: 'nowrap',
  }
  const sortable = (key: SortKey, label: string) => {
    const active = sort.key === key
    return (
      <button
        onClick={() => onSort({ key, dir: active && sort.dir === 'desc' ? 'asc' : 'desc' })}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit',
          letterSpacing: 'inherit', textTransform: 'inherit', color: active ? T.gold : 'inherit',
        }}>
        {label}{active && (sort.dir === 'desc' ? ' ▼' : ' ▲')}
      </button>
    )
  }

  return (
    <div className={GUTTER_CLASS} style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16, paddingBottom: 8, flexWrap: 'wrap' }}>
        <span style={eyebrow}>Positions · {rows.length} names</span>
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: mix(T.muted, 75) }}>tap ∿ on a row for its intraday shape</span>
      </div>

      {!rows.length ? (
        <div style={{ background: T.surface, padding: 12, fontFamily: SANS, fontSize: 11, color: T.muted }}>
          This book holds cash only.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', background: T.surface, minWidth: 720 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>{sortable('ticker', 'Position')}</th>
                <th style={{ ...th, textAlign: 'center', width: 108 }}>Intraday</th>
                <th style={{ ...th, textAlign: 'right' }}>{sortable('price', 'Last')}</th>
                <th style={{ ...th, textAlign: 'right' }}>{sortable('pct1d', '1D')}</th>
                <th style={{ ...th, textAlign: 'right' }}>{sortable('shares', 'Shares')}</th>
                <th style={{ ...th, textAlign: 'right' }}>{sortable('value', 'Value')}</th>
                <th style={{ ...th, textAlign: 'right' }}>{sortable('pnl', 'Day P&L')}</th>
                <th style={{ ...th, textAlign: 'right', width: 160 }}>{sortable('weight', 'Weight')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const tick = flash[r.ticker]
                const tickColor = tick === 'up' ? T.pos : tick === 'down' ? T.neg : null
                // Shown by default; the toggle collapses rather than reveals, so
                // the column carries its shape without a click per row.
                const open = openSparks[r.ticker] !== false
                const pts = sparks[r.ticker]
                return (
                  <tr key={r.ticker} style={{
                    background: tickColor ? `color-mix(in srgb, ${tickColor} 10%, transparent)` : 'transparent',
                    transition: 'background 700ms ease-out',
                  }}>
                    <td style={{ ...td, textAlign: 'left' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <TickerLogo ticker={r.ticker} size={20} />
                        <span style={{ minWidth: 0 }}>
                          <span style={{ display: 'block', fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: T.text }}>{r.ticker}</span>
                          {r.name && (
                            <span style={{ display: 'block', fontFamily: SANS, fontSize: 8.5, color: mix(T.muted, 75), overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 150 }}>{r.name}</span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td style={{ ...td, textAlign: 'center' }}>
                      <button
                        onClick={() => onToggleSpark(r.ticker)}
                        aria-pressed={open}
                        aria-label={open ? `Hide ${r.ticker} intraday shape` : `Show ${r.ticker} intraday shape`}
                        style={{
                          background: open ? 'transparent' : mix(T.text, 4), border: 'none', cursor: 'pointer',
                          padding: open ? 0 : '2px 6px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          fontFamily: MONO, fontSize: 12, color: mix(T.muted, 75), lineHeight: 1,
                        }}>
                        {open
                          ? (pts ? <RowSparkline points={pts} positive={(r.pct1d ?? 0) >= 0} />
                            : <span style={{ fontSize: 9.5 }}>{sparksLoading ? '…' : 'no data'}</span>)
                          : '∿'}
                      </button>
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: tickColor ?? T.text, transition: 'color 600ms ease-out' }}>
                      {r.price == null ? '—' : usd(r.price)}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: chg(r.pct1d) }}>{pct(r.pct1d)}</td>
                    <td style={{ ...td, textAlign: 'right', fontSize: 11, color: mix(T.muted, 75) }}>
                      {r.shares.toLocaleString('en-US', { maximumFractionDigits: 4 })}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{r.value == null ? '—' : usd(r.value)}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: chg(r.dayPnl) }}>
                      {r.dayPnl == null ? '—' : signedUsd(r.dayPnl)}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                        <span style={{ width: 88, height: 4, background: T.borderFaint, flexShrink: 0 }}>
                          {r.weight != null && (
                            // Normalized against a 35% ceiling so the largest realistic
                            // holding fills the track; floored so sub-1% names still show.
                            <span style={{
                              display: 'block', height: '100%',
                              width: `${Math.min(100, Math.max(2, (r.weight / 35) * 100))}%`,
                              background: T.goldTint(75),
                            }} />
                          )}
                        </span>
                        <span style={{ minWidth: 40, textAlign: 'right' }}>
                          {r.weight == null ? '—' : `${r.weight.toFixed(1)}%`}
                        </span>
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function PortfolioLive() {
  return (
    <PageWrapper title="Portfolio Live">
      <PortfolioLiveContent />
    </PageWrapper>
  )
}
