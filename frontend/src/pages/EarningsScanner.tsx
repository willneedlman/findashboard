import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react'
import { createPortal } from 'react-dom'
import axios from 'axios'
import { Star } from 'lucide-react'
import { useTickerParam } from '../hooks/useTickerParam'
import PageWrapper from '../components/PageWrapper'
import { calendarMismatchDate, hasReportedFigures, sourceHasGapAt } from './earningsCalendarStatus'
import EmptyState from '../components/EmptyState'
import TickerLogo from '../components/TickerLogo'
import TickerLink from '../components/TickerLink'
import ColumnFilterMenu, { type SortState, type FilterSpec } from '../components/ColumnFilterMenu'
import useIsMobile from '../hooks/useIsMobile'
import { usePortfolio } from '../contexts/PortfolioContext'
import { localDateInputValue } from '../lib/time'
import { readWatchlist, toggleWatchlist } from '../lib/watchlist'
import { readActivePortfolioContext, readPMBooks, normalizeTicker, PORTFOLIO_CONTEXT_EVENT, type PMHolding, type PMPortfolio } from '../lib/pmImport'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, textClip } from '../lib/reportCaptureRegistry'

// One earnings tool. The calendar is the spine: every row is a company on a
// date. Names you hold or watch carry their book context inline (position,
// short interest, consensus, insider, the wire) instead of living on their own
// page, and any row expands into the AI filing summary. Scanning, your book,
// and the deep dive are one continuous flow off one row selection.

const C = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))',
  header: 'var(--theme-surface, #0d1826)', surface: 'var(--theme-bg, #101c2e)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #8099b0)',
  dim: 'color-mix(in srgb, var(--theme-secondary, #8099b0) 62%, var(--theme-bg, #101c2e))',
  pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)', warn: '#f59e0b', blue: 'var(--theme-tertiary, #60a5fa)',
  mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
  // Hairline between table rows — lighter than the panel border so 500+ rows
  // read as a field rather than a grid.
  borderFaint: 'var(--theme-border-faint, rgba(255,255,255,0.05))',
  // Recessed ground for inputs, segmented controls and the meta strip. Routed
  // through --theme-hover so it inverts sensibly on light presets instead of
  // stamping a fixed black wash over them.
  inset: 'var(--theme-hover, rgba(0,0,0,0.18))',
}
const gold = (pct: number) => `color-mix(in srgb, var(--theme-primary, #c9a84c) ${pct}%, transparent)`

const LABEL: React.CSSProperties = { fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.muted, display: 'block' }

// ─── toolbar primitives ─────────────────────────────────────────────────────

function GroupLabel({ children, htmlFor, title }: { children: React.ReactNode; htmlFor?: string; title?: string }) {
  return (
    <label htmlFor={htmlFor} title={title} style={{
      fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
      textTransform: 'uppercase', color: C.muted, marginRight: 8, whiteSpace: 'nowrap', flexShrink: 0,
    }}>{children}</label>
  )
}

function Divider() {
  return <span aria-hidden style={{ width: 1, height: 24, background: C.border, margin: '0 10px', flexShrink: 0 }} />
}

function Segmented({ items, value, onPick }: {
  items: { key: string; label: string; title?: string }[]
  value: string
  onPick: (key: string) => void
}) {
  return (
    <div style={{ display: 'flex', border: `1px solid ${C.border}`, background: C.inset, flexShrink: 0 }}>
      {items.map((it, i) => {
        const on = it.key === value
        return (
          <button key={it.key} onClick={() => onPick(it.key)} aria-pressed={on} title={it.title}
            style={{
              background: on ? C.gold : 'transparent', color: on ? C.header : C.muted,
              border: 'none', borderRight: i < items.length - 1 ? `1px solid ${C.border}` : 'none',
              cursor: 'pointer', fontFamily: C.sans, fontSize: 10, fontWeight: 700,
              letterSpacing: '0.06em', textTransform: 'uppercase', padding: '7px 10px', whiteSpace: 'nowrap',
            }}>{it.label}</button>
        )
      })}
    </div>
  )
}

const Sep = () => <span aria-hidden style={{ color: C.dim, fontFamily: C.sans, fontSize: 11 }}>·</span>

function Stat({ n, word, strong, color }: { n: number; word: string; strong?: boolean; color?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{
        fontFamily: C.mono, fontSize: 12, fontWeight: strong ? 700 : 400,
        color: color ?? C.text, fontVariantNumeric: 'tabular-nums',
      }}>{n}</span>
      <span style={{ fontFamily: C.sans, fontSize: 11, color: C.muted }}>{word}</span>
    </span>
  )
}

interface Row {
  symbol: string; date: string; hour: string; quarter: number | null; year: number | null
  epsEstimate: number | null
}
interface Enriched {
  symbol: string; companyName?: string | null; marketCap?: number | null; sector?: string | null
  priorReportDate?: string | null; surprisePct?: number | null
  reportedEps?: number | null; epsEstimateAtReport?: number | null
  nextDate?: string | null   // yfinance's own nearest-future-or-current earnings date
  reactionPct?: number | null; runSincePct?: number | null
  impliedMove?: number | null; impliedMoveExpiry?: string | null
  _phase?: 1 | 2   // 1 = cheap profile-only (name/cap/sector), 2 = fully enriched
  _impliedMoveLoaded?: boolean   // lazy-fetched separately once the row scrolls into view
}

interface NewsItem { title: string; link: string; publisher: string }
interface InsiderTx {
  date: string; insider: string; title: string; transaction: string
  side: 'buy' | 'sell' | 'neutral'; shares: number; value: number
}
interface EarnDetail {
  reportTiming: string | null
  epsEst: number | null; epsPriorYear: number | null; revEst: number | null
  histAvgMovePct: number | null; beatRatePct: number | null
}
// Everything the old Portfolio Earnings page knew about one of your names,
// keyed by ticker and fetched once for the whole book — so a name showing up
// in the universe calendar carries it too, not just in the book scopes.
interface BookInfo {
  ticker: string; name: string
  date: string | null; horizon: string | null
  pe: number | null; pctChange: number | null; marketCap: number | null
  consensus: string | null
  price: number | null; week52Low: number | null; week52High: number | null
  news: NewsItem[]; sparkline: number[]
  shortPct: number | null
  insider: InsiderTx[] | null
  detail: EarnDetail | null
  // "no data" and "not fetched yet" render differently: one is a dash, the
  // other a skeleton. Without these flags every widget shows the dash first.
  loaded?: boolean
  extrasLoaded?: boolean
}

interface Position { ticker: string; shares: number; avgCost: number }

// --- AI filing summary (the old Earnings Summarizer, now a row drill-down) ---
interface KeyMetric { name: string; value: string; vs_est?: string; yoy?: string }
interface Summary {
  quarter: string; verdict: string
  bull_points: string[]; bear_points: string[]; key_metrics: KeyMetric[]
  guidance: string; management_tone: string; key_themes: string[]
  risks: string[]; analyst_questions_focus: string
}
interface MetricVal { value: string; yoy?: string | null; prior?: string | null; delta_bps?: number | null; basis?: string }
interface ReportedMetric { name: string; actual: string; estimate?: string | null; variance?: string | null; variance_pct?: string | null; yoy?: string | null }
interface Metrics { eps?: MetricVal; revenue?: MetricVal; rev_yoy?: MetricVal; gross_margin?: MetricVal; reported_vs_consensus?: ReportedMetric[] }
interface Segment { name: string; value: number }
interface Filing { form: string; date: string; url: string; accession?: string; items?: string }
interface SummaryResult {
  ticker: string; id?: string; company?: string; period?: string; form?: string; filed?: string; url?: string
  metrics?: Metrics | null; segments?: Segment[] | null; reaction?: { date: string; pct: number } | null
  summary?: Summary; error?: string; sources?: number
}
interface SummaryState { stage: string; pct: number; result: SummaryResult | null; error: string | null }

type Scope = 'covered' | 'all' | 'holdings'
type SortKey = string

const SCOPES: { key: Scope; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'covered', label: 'Covered' },
  { key: 'holdings', label: 'My Holdings' },
]
const isBookScope = (s: Scope) => s === 'holdings'

// Sentinel for "whatever the Portfolio Manager has active", as opposed to a
// pinned book id.
const ACTIVE_BOOK = '__active__'

// The universe calendar is a date window (the backend caps it at 14 days). The
// book is a countdown instead — your names report when they report, so the
// control switches to a proximity horizon rather than a start date + span.
const WINDOWS = [{ label: '1D', days: 1 }, { label: '3D', days: 3 }, { label: '1W', days: 7 }, { label: '2W', days: 14 }]
const HORIZONS: { key: HorizonKey; label: string; limit: number }[] = [
  { key: '14d', label: '14 Days', limit: 14 },
  { key: '30d', label: '30 Days', limit: 30 },
  { key: '60d', label: '60 Days', limit: 60 },
  { key: 'all', label: 'All', limit: Infinity },
]
type HorizonKey = 'all' | '14d' | '30d' | '60d'

const HOUR_LABEL: Record<string, string> = { bmo: 'Pre', amc: 'Post', dmh: 'Mid' }
const HOUR_FULL: Record<string, string> = { bmo: 'Before the open', amc: 'After the close', dmh: 'During the session' }
const TONE_COLOR: Record<string, string> = { bullish: C.pos, neutral: C.muted, cautious: C.warn, mixed: C.blue }
const CONSENSUS_COLOR: Record<string, string> = {
  'Strong Buy': 'var(--theme-positive-strong, #4fd39a)',
  'Moderate Buy': '#8fc98f',
  'Hold': '#a99f86',
  'Underperform': 'var(--theme-negative, #e0655a)',
}

// Local calendar date (YYYY-MM-DD). Never use toISOString().slice — that is UTC
// and rolls the "today" anchor forward in US evening hours, which can drop names
// reporting later in the selected window.
function today(): string { return localDateInputValue() }

// Common search terms → tickers so "google" hits GOOGL before enrichment fills companyName.
const SEARCH_ALIASES: Record<string, string[]> = {
  GOOGLE: ['GOOGL', 'GOOG'], ALPHABET: ['GOOGL', 'GOOG'],
  META: ['META'], FACEBOOK: ['META'],
  AMAZON: ['AMZN'], APPLE: ['AAPL'], MICROSOFT: ['MSFT'], NVIDIA: ['NVDA'],
  TESLA: ['TSLA'], NETFLIX: ['NFLX'], BERKSHIRE: ['BRK.B', 'BRK.A'],
  JPMORGAN: ['JPM'], 'JP MORGAN': ['JPM'], EXXON: ['XOM'],
}

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '—'
  const a = Math.abs(v)
  if (a >= 1e12) return `$${(v / 1e12).toFixed(1)}T`
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
  return `$${v.toFixed(0)}`
}
function fmtEps(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`
}
function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}%`
}
function pctColor(v: number | null | undefined): string {
  if (v == null) return C.dim
  return v >= 0 ? C.pos : C.neg
}
function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}
function fmtFullDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function fmtDateShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}
function fmtQuarterLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  const q = Math.floor(d.getMonth() / 3) + 1
  return `Q${q} '${String(d.getFullYear()).slice(2)}`
}
function fmtRev(n: number | null | undefined): string {
  if (n == null) return '—'
  return n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`
}
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(+d)) return null
  const t = new Date(); t.setHours(0, 0, 0, 0)
  return Math.round((+d - +t) / 86_400_000)
}
function safeUrl(url: string): string {
  try {
    const u = new URL(url)
    return ['https:', 'http:'].includes(u.protocol) ? url : '#'
  } catch { return '#' }
}
// Green for a positive change, red for a negative one, muted otherwise.
function signColor(s?: string | null): string {
  if (!s) return C.muted
  const value = Number.parseFloat(s.replace(/[−+,%]/g, ''))
  if (Number.isFinite(value) && Math.abs(value) < 0.5) return C.muted
  if (/^\+/.test(s)) return C.pos
  if (/^[-−]/.test(s)) return C.neg
  return C.muted
}
function fmtB(v: number): string {
  const a = Math.abs(v)
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`
  return `$${v.toFixed(0)}`
}

const shimmer: React.CSSProperties = {
  display: 'inline-block', width: 38, height: 10, borderRadius: 2,
  background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 75%)',
  backgroundSize: '200% 100%', animation: 'ec-shimmer 1.6s infinite',
}

/** Shimmer block sized to the widget it stands in for. */
function Skeleton({ w = '100%', h = 10, mt = 0 }: { w?: number | string; h?: number; mt?: number }) {
  return <span aria-hidden style={{ ...shimmer, display: 'block', width: w, height: h, marginTop: mt }} />
}
function SkeletonLines({ n, h = 10, gap = 8, widths }: { n: number; h?: number; gap?: number; widths?: (number | string)[] }) {
  return (
    <span aria-hidden style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} h={h} w={widths?.[i] ?? (i === n - 1 ? '62%' : '100%')} />
      ))}
    </span>
  )
}

function BeatMissBadge({ surprisePct }: { surprisePct: number | null | undefined }) {
  if (surprisePct == null) return <span style={{ color: C.dim }}>—</span>
  const beat = surprisePct >= 0
  const color = beat ? C.pos : C.neg
  return (
    <span style={{
      display: 'inline-block', fontFamily: C.sans, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em',
      color, background: `color-mix(in srgb, ${color} 16%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
      borderRadius: 3, padding: '3px 7px', whiteSpace: 'nowrap',
    }}>{beat ? 'BEAT' : 'MISS'} {beat ? '+' : '−'}{Math.abs(surprisePct).toFixed(1)}%</span>
  )
}

function HourChip({ hour }: { hour: string }) {
  const label = HOUR_LABEL[hour]
  if (!label) return <span style={{ color: C.dim, fontFamily: C.mono, fontSize: 11 }}>—</span>
  const color = hour === 'bmo' ? C.blue : hour === 'amc' ? C.warn : C.muted
  return (
    <span title={HOUR_FULL[hour]} style={{
      fontFamily: C.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
      color, border: `1px solid ${color}`, borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

function Sparkline({ data, positive, fill }: { data: number[]; positive: boolean; fill?: boolean }) {
  if (!data || data.length < 2) return null
  const min = Math.min(...data), max = Math.max(...data)
  const range = max - min || 1
  const pts = data.map((v, i) =>
    `${(i / (data.length - 1) * 100).toFixed(1)},${(25 - ((v - min) / range) * 24 + 0.5).toFixed(1)}`
  ).join(' ')
  const stroke = positive ? C.pos : C.neg
  // fill: absolutely fill the parent box. As a flex item an SVG sizes itself
  // from its own viewBox ratio and stays small no matter what width/height say,
  // so it is taken out of flow instead. preserveAspectRatio="none" would scale
  // the stroke with the box, hence the non-scaling stroke; the area under the
  // line carries the size the 1.6px line cannot.
  return (
    <svg viewBox="0 0 100 26" preserveAspectRatio="none"
      width={fill ? '100%' : 94} height={fill ? '100%' : 24}
      style={fill
        ? { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' }
        : { display: 'block', flexShrink: 0 }}>
      {fill && <polygon points={`0,26 ${pts} 100,26`} fill={stroke} opacity={0.1} />}
      <polyline points={pts} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round"
        vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// --- book fetchers (the old Portfolio Earnings data layer, unchanged shape) ---
const TIMEOUT = 10_000

/** 30d closes when the hub's own sparkline comes back empty — a name with a
 *  price always has a price series, so the widget should never read "none". */
async function fetchCloses(tk: string): Promise<number[]> {
  try {
    const { data: d } = await axios.get('/api/market/ohlcv', {
      params: { ticker: tk, period: '1mo', interval: '1d' }, timeout: TIMEOUT,
    })
    return (d.candles ?? [])
      .map((c: any) => Number(c.close))
      .filter((v: number) => Number.isFinite(v))
  } catch { return [] }
}

async function fetchHub(tk: string): Promise<Partial<BookInfo>> {
  try {
    const { data: d } = await axios.get(`/api/corporate/hub?ticker=${tk}`, { timeout: TIMEOUT })
    const spark: number[] = d.sparkline ?? []
    return {
      loaded: true,
      name: d.company_name || tk,
      date: d.date && d.date !== '—' ? d.date : null,
      horizon: d.horizon && d.horizon !== '—' ? d.horizon : null,
      pe: (d.forward_pe || d.estimated_pe || 0) > 0 ? (d.forward_pe || d.estimated_pe) : null,
      pctChange: d.pct_change_1d ?? null, marketCap: d.market_cap ?? null,
      consensus: d.consensus ?? null,
      price: d.current_price || null, week52Low: d.fifty_two_week_low || null, week52High: d.fifty_two_week_high || null,
      sparkline: spark.length > 1 ? spark : await fetchCloses(tk),
      news: (d.news || []).slice(0, 3).map((n: any) => ({
        title: n.title || 'Market Update', link: n.link || '#', publisher: n.publisher || 'Financial Wire',
      })),
    }
  } catch {
    return { name: tk, date: null, horizon: null, news: [], sparkline: await fetchCloses(tk), loaded: true }
  }
}
async function fetchShort(tk: string): Promise<number | null> {
  try {
    const { data: d } = await axios.get(`/api/corporate/hub/short?ticker=${tk}`, { timeout: TIMEOUT })
    return d.shortPercentOfFloat != null ? d.shortPercentOfFloat * 100 : null
  } catch { return null }
}
async function fetchInsider(tk: string): Promise<InsiderTx[]> {
  try {
    const { data: d } = await axios.get(`/api/corporate/hub/insider?ticker=${tk}`, { timeout: 15_000 })
    return d.transactions || []
  } catch { return [] }
}
async function fetchEarnDetail(tk: string): Promise<EarnDetail | null> {
  try {
    const { data } = await axios.get(`/api/corporate/hub/earnings-detail?ticker=${tk}`, { timeout: 20_000 })
    return data
  } catch { return null }
}

const emptyBook = (tk: string): BookInfo => ({
  ticker: tk, name: tk, date: null, horizon: null, pe: null, pctChange: null, marketCap: null,
  consensus: null, price: null, week52Low: null, week52High: null, news: [], sparkline: [],
  shortPct: null, insider: null, detail: null,
})

export function EarningsScannerContent() {
  const isMobile = useIsMobile()
  const { tickers: legacyTickers } = usePortfolio()

  // ---- the book: positions from the Portfolio Manager. Which book is a choice,
  // not an assumption — ACTIVE_BOOK follows whatever the PM has active (and the
  // combined overview when several are selected), and the picker can pin any
  // saved portfolio instead. The weight-only legacy store is the fallback so a
  // user without a PM book still gets markers.
  const [pmBooks, setPmBooks] = useState<PMPortfolio[]>(() => readPMBooks())
  const [bookId, setBookId] = useState<string>(ACTIVE_BOOK)
  const [positions, setPositions] = useState<Position[]>([])
  useEffect(() => {
    const read = () => {
      const books = readPMBooks()
      setPmBooks(books)
      const picked = bookId === ACTIVE_BOOK ? null : books.find(b => b.id === bookId)
      if (bookId !== ACTIVE_BOOK && !picked) setBookId(ACTIVE_BOOK)
      const holdings = (picked?.holdings ?? readActivePortfolioContext().holdings) as PMHolding[]
      const held = holdings
        .map(h => ({ ticker: normalizeTicker(h.ticker), shares: h.shares, avgCost: h.avgCost }))
        .filter(p => p.ticker && p.ticker !== 'CASH' && p.shares)
      if (held.length) { setPositions(held); return }
      // A pinned book that is genuinely empty must read as empty, not silently
      // fall back to the legacy weights of a different book.
      setPositions(picked ? [] : legacyTickers.map(t => ({ ticker: t.toUpperCase(), shares: 0, avgCost: 0 })))
    }
    read()
    window.addEventListener(PORTFOLIO_CONTEXT_EVENT, read)
    return () => window.removeEventListener(PORTFOLIO_CONTEXT_EVENT, read)
  }, [legacyTickers, bookId])

  const [watchlist, setWatchlist] = useState<string[]>(() => readWatchlist())
  const watchSet = useMemo(() => new Set(watchlist), [watchlist])
  const posMap = useMemo(() => new Map(positions.map(p => [p.ticker, p])), [positions])

  const [scope, setScope] = useState<Scope>('covered')
  const [date, setDate] = useState(today())
  const [days, setDays] = useState(1)
  // Defaults to All: a book's next reports are routinely 2-3 months out, so a
  // tighter default horizon reads as "nothing scheduled" on a healthy book.
  const [horizonKey, setHorizonKey] = useState<HorizonKey>('all')

  const [rows, setRows] = useState<Row[]>([])
  const [covered, setCovered] = useState(0)
  const [rangeTo, setRangeTo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [query, setQuery] = useState('')

  // This page is in TICKER_TOOLS and the drawer offers it, but it read no
  // ticker at all: arriving with NVDA in hand showed the whole unfiltered
  // calendar. The symbol seeds the search box the page already has.
  useTickerParam(setQuery)

  const [minCapStr, setMinCapStr] = useState('')   // in $B
  const [hourFilter, setHourFilter] = useState('') // '', bmo, amc, dmh
  const [sort, setSort] = useState<SortState>(null) // a user sort flattens the date grouping
  const [expanded, setExpanded] = useState<string | null>(null)  // `${symbol}|${date}`

  const minCap = (parseFloat(minCapStr) || 0) * 1e9

  const [enriched, setEnriched] = useState<Record<string, Enriched>>({})
  const profilingRef = useRef<Set<string>>(new Set())   // phase 1: cheap name/cap/sector, in flight
  const enrichingRef = useRef<Set<string>>(new Set())   // phase 2: full enrichment, in flight

  // ---- book data, loaded once per held name. A held name that turns up in the
  // universe calendar gets the same context as it does in the holdings scope —
  // that is the whole point of the merge.
  const [book, setBook] = useState<Record<string, BookInfo>>({})
  const [bookLoading, setBookLoading] = useState(false)
  const bookRef = useRef<Set<string>>(new Set())

  const bookNames = useMemo(() => [...new Set(positions.map(p => p.ticker))], [positions])

  const loadBook = useCallback((names: string[]) => {
    const fresh = names.filter(n => !bookRef.current.has(n))
    if (!fresh.length) return
    fresh.forEach(n => bookRef.current.add(n))
    setBookLoading(true)
    setBook(prev => ({ ...prev, ...Object.fromEntries(fresh.map(n => [n, emptyBook(n)])) }))
    Promise.all(fresh.map(async tk => {
      const hub = await fetchHub(tk)
      setBook(prev => ({ ...prev, [tk]: { ...(prev[tk] ?? emptyBook(tk)), ...hub } }))
      const [shortPct, detail, insider] = await Promise.all([
        fetchShort(tk), fetchEarnDetail(tk), fetchInsider(tk),
      ])
      setBook(prev => ({ ...prev, [tk]: { ...(prev[tk] ?? emptyBook(tk)), shortPct, detail, insider, extrasLoaded: true } }))
    })).finally(() => setBookLoading(false))
  }, [])

  useEffect(() => { loadBook(bookNames) }, [bookNames, loadBook])

  // Nothing fetches until SCAN is clicked — date/window/market-cap are just
  // local params until then. loadIdRef guards against an in-flight request
  // resolving after a newer SCAN click superseded it.
  const [started, setStarted] = useState(false)
  const loadIdRef = useRef(0)
  const impliedMoveRef = useRef<Set<string>>(new Set())
  const impliedMoveRetriedRef = useRef<Set<string>>(new Set())

  const loadCalendar = useCallback(() => {
    const id = ++loadIdRef.current
    setStarted(true)
    setLoading(true); setError(null); setEnriched({})
    profilingRef.current = new Set(); enrichingRef.current = new Set()
    impliedMoveRef.current = new Set(); impliedMoveRetriedRef.current = new Set()
    setRangeTo(null)
    axios.get('/api/earnings/calendar', { params: { date, days } })
      .then(r => {
        if (loadIdRef.current !== id) return
        // The calendar merges two sources, so a name can arrive twice for the
        // same date. That collides the row key (symbol|date), which React warns
        // about and which makes both copies expand as one.
        const seen = new Set<string>()
        setRows((r.data.rows || []).filter((row: Row) => {
          const k = `${row.symbol}|${row.date}`
          if (seen.has(k)) return false
          seen.add(k)
          return true
        }))
        setCovered(r.data.covered || 0)
        setRangeTo(r.data.to || null)
      })
      .catch(() => { if (loadIdRef.current !== id) return; setError('Could not load the earnings calendar. Try again shortly.') })
      .finally(() => { if (loadIdRef.current === id) setLoading(false) })
  }, [date, days])

  useEffect(() => { loadCalendar() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // The book scopes build their rows from each name's own confirmed next report
  // date rather than the window calendar, so a holding reporting in six weeks is
  // still on the agenda. Same Row shape, so everything downstream is shared.
  const bookRows = useMemo<Row[]>(() => {
    const names = positions.map(p => p.ticker)
    const limit = HORIZONS.find(h => h.key === horizonKey)?.limit ?? Infinity
    return names
      .map(tk => {
        const b = book[tk]
        if (!b?.date) return null
        const d = daysUntil(b.date)
        if (d != null && d > limit) return null
        const timing = b.detail?.reportTiming
        return {
          symbol: tk, date: b.date,
          hour: timing === 'Before Open' ? 'bmo' : timing === 'After Close' ? 'amc' : '',
          quarter: null, year: null,
          epsEstimate: b.detail?.epsEst ?? null,
        } as Row
      })
      .filter((r): r is Row => r != null)
  }, [positions, book, horizonKey])

  const scopeRows = isBookScope(scope) ? bookRows : rows

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    // Alias match only for meaningful queries (avoid "G" matching Google).
    const aliasHits = q.length >= 3
      ? Object.entries(SEARCH_ALIASES).flatMap(([name, syms]) =>
          name.startsWith(q) || q.startsWith(name) || name.includes(q) ? syms : [])
      : []
    const aliasSet = new Set(aliasHits.map(s => s.toUpperCase()))
    return scopeRows.filter(r => {
      if (scope === 'covered' && r.epsEstimate == null) return false
      if (hourFilter && r.hour !== hourFilter) return false
      if (q) {
        const sym = r.symbol.toUpperCase()
        const name = (enriched[r.symbol]?.companyName || book[r.symbol]?.name || '').toUpperCase()
        if (
          !sym.includes(q)
          && !name.includes(q)
          && !aliasSet.has(sym)
        ) return false
      }
      return true
    })
  }, [scopeRows, scope, query, hourFilter, enriched, book])

  // Phase 1 (cheap): name/cap/sector only, for EVERY row, so the market-cap
  // filter can resolve before anything expensive runs.
  // seedOnly (passed by the caller, true whenever a market-cap filter is
  // active): skips the live Finnhub fallback for symbols outside the bundled
  // seed entirely — they resolve instantly with a null cap and are naturally
  // excluded by the filter, instead of paying for a live, rate-limited call
  // to confirm what the filter would exclude anyway.
  const profileBatch = useCallback((symbols: string[], seedOnly: boolean) => {
    if (!symbols.length) return
    symbols.forEach(s => profilingRef.current.add(s))
    axios.get('/api/earnings/profile', { params: { symbols: symbols.join(','), seed_only: seedOnly } })
      .then(r => {
        const next: Record<string, Enriched> = {}
        for (const e of (r.data.rows || []) as Enriched[]) next[e.symbol] = { ...e, _phase: 1 }
        setEnriched(prev => ({ ...prev, ...next }))
      })
      .catch(() => {
        setEnriched(prev => ({ ...prev, ...Object.fromEntries(symbols.map(s => [s, { symbol: s, _phase: 1 as const }])) }))
      })
  }, [])

  // Phase 2 (expensive): earnings history + implied move, only for rows that
  // already have phase-1 data AND pass every active filter, including market
  // cap — a name filtered out on cap alone never pays for an options-chain
  // fetch it'll never show.
  const enrichBatch = useCallback((symbols: string[]) => {
    if (!symbols.length) return
    symbols.forEach(s => enrichingRef.current.add(s))
    axios.get('/api/earnings/enrich', { params: { symbols: symbols.join(',') } })
      .then(r => {
        const next: Record<string, Enriched> = {}
        for (const e of (r.data.rows || []) as Enriched[]) next[e.symbol] = { ...e, _phase: 2 }
        setEnriched(prev => ({ ...prev, ...next }))
      })
      // Mark a failed batch as attempted (empty rows) rather than clearing it, so
      // the effect does not immediately re-request it in a tight loop on a
      // persistent backend error. The row stays as a dash for this load.
      .catch(() => {
        setEnriched(prev => ({
          ...prev,
          ...Object.fromEntries(symbols.map(s => [s, { ...(prev[s] || { symbol: s }), _phase: 2 as const }])),
        }))
      })
  }, [])

  // Implied move (an options-chain fetch — the single most expensive part of
  // enrichment) is fetched lazily, only for rows that actually scroll into
  // view, via the IntersectionObserver below — not for the whole cap-filtered
  // set upfront. impliedMoveRef dedupes so a row already requested/loaded is
  // never re-fetched just because it re-enters the viewport.
  // A null result the first time through gets ONE retry after a short delay
  // before it's accepted as final — a transient blip (a busy moment on the
  // shared yfinance semaphore, a brief backend restart) would otherwise get
  // permanently stuck showing "no data" for the rest of the page session,
  // since nothing else ever re-requests a symbol once it's marked loaded.
  const fetchImpliedMove = useCallback((symbols: string[]) => {
    const fresh = symbols.filter(s => !impliedMoveRef.current.has(s))
    if (!fresh.length) return
    fresh.forEach(s => impliedMoveRef.current.add(s))
    axios.get('/api/earnings/implied-move', { params: { symbols: fresh.join(',') } })
      .then(r => {
        const got = (r.data.rows || []) as { symbol: string; impliedMove: number | null; impliedMoveExpiry: string | null }[]
        const retry: string[] = []
        setEnriched(prev => {
          const out = { ...prev }
          for (const e of got) {
            if (e.impliedMove == null && !impliedMoveRetriedRef.current.has(e.symbol)) {
              retry.push(e.symbol)
              continue   // don't mark _impliedMoveLoaded yet — leave it showing the shimmer through the retry
            }
            out[e.symbol] = { ...out[e.symbol], impliedMove: e.impliedMove, impliedMoveExpiry: e.impliedMoveExpiry, _impliedMoveLoaded: true }
          }
          return out
        })
        if (retry.length) {
          retry.forEach(s => { impliedMoveRetriedRef.current.add(s); impliedMoveRef.current.delete(s) })
          window.setTimeout(() => fetchImpliedMove(retry), 4000)
        }
      })
      .catch(() => {
        setEnriched(prev => {
          const out = { ...prev }
          for (const s of fresh) out[s] = { ...(out[s] || { symbol: s }), _impliedMoveLoaded: true }
          return out
        })
      })
  }, [])

  const rowObserverRef = useRef<IntersectionObserver | null>(null)
  useEffect(() => {
    rowObserverRef.current = new IntersectionObserver(entries => {
      const syms = entries
        .filter(en => en.isIntersecting)
        .map(en => (en.target as HTMLElement).dataset.symbol)
        .filter((s): s is string => !!s && !impliedMoveRef.current.has(s))
      if (syms.length) fetchImpliedMove(syms)
    }, { rootMargin: '400px 0px' })
    return () => rowObserverRef.current?.disconnect()
  }, [fetchImpliedMove])

  // Attached to every row's <tr ref={...}> so the observer above knows when
  // it scrolls into view.
  const registerRow = useCallback((el: HTMLTableRowElement | null, symbol: string) => {
    if (el && rowObserverRef.current) {
      el.dataset.symbol = symbol
      rowObserverRef.current.observe(el)
    }
  }, [])

  // Largest companies first within each date. Market cap arrives with phase 1,
  // so rows without it yet sort to the bottom (cap -1) and rise as it loads.
  // Date stays the primary axis so a multi-day window groups.
  const sorted = useMemo(() => {
    const cap = (s: string) => enriched[s]?.marketCap ?? book[s]?.marketCap ?? -1
    return [...filtered].sort((a, b) => {
      if ((a.date || '') !== (b.date || '')) return (a.date || '').localeCompare(b.date || '')
      const d = cap(b.symbol) - cap(a.symbol)
      return d !== 0 ? d : a.symbol.localeCompare(b.symbol)
    })
  }, [filtered, enriched, book])

  // Phase 1: 3 batches of 60 in flight at once for every row, same
  // concurrency reasoning as phase 2 below. 60 matches the backend's own
  // per-request cap (_MAX_ENRICH) — for anything already cache-warm, HTTP
  // round-trip overhead dominates over actual backend work, so fewer/larger
  // requests wins even though total data volume is unchanged.
  useEffect(() => {
    const seedOnly = !!minCap
    const pending = sorted
      .map(r => r.symbol)
      .filter(s => !(s in enriched) && !profilingRef.current.has(s))
    const BATCH_SIZE = 60
    const MAX_CONCURRENT_BATCHES = 3
    for (let i = 0; i < MAX_CONCURRENT_BATCHES; i++) {
      const chunk = pending.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
      if (chunk.length) profileBatch(chunk, seedOnly)
    }
  }, [sorted, enriched, minCap, profileBatch])

  // Phase 2: 3 batches of 60 in flight at once, not 1 — the old version
  // waited for each batch's full round trip before requesting the next
  // chunk, so a 500+-name window took many sequential requests end to end.
  // Firing several batches concurrently (each still independently
  // fault-isolated in enrichBatch) cuts that wall-clock time roughly 3x; as
  // each resolves this effect refires and refills the window with the next
  // unclaimed symbols. Eligibility requires phase-1 data AND passing the
  // market-cap filter — see the comment on enrichBatch above.
  useEffect(() => {
    const eligible = sorted.filter(r => {
      const e = enriched[r.symbol]
      if (!e || e._phase !== 1) return false
      if (minCap) {
        const c = e.marketCap
        if (c == null || c < minCap) return false
      }
      return true
    })
    const pending = eligible
      .map(r => r.symbol)
      .filter(s => !enrichingRef.current.has(s))
    const BATCH_SIZE = 60
    const MAX_CONCURRENT_BATCHES = 3
    for (let i = 0; i < MAX_CONCURRENT_BATCHES; i++) {
      const chunk = pending.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
      if (chunk.length) enrichBatch(chunk)
    }
  }, [sorted, enriched, minCap, enrichBatch])

  // Market cap resolves from phase 1, so the cap filter below can apply as
  // soon as phase 1 lands, without waiting on the expensive phase-2 fetch.
  // Unknown-cap rows are held back while a filter is on.
  const visible = useMemo(() => {
    if (!minCap) return sorted
    return sorted.filter(r => {
      const c = enriched[r.symbol]?.marketCap ?? book[r.symbol]?.marketCap
      return c != null && c >= minCap
    })
  }, [sorted, enriched, book, minCap])

  // Loading gate: `visible` grows as phase-1 data trickles in, so checking
  // phase-2 completion against `visible` alone is not enough — if only a
  // handful of rows have been profiled so far and those happen to pass the
  // cap, the gate would flip open before the rest of `sorted` even had a
  // chance to be profiled and checked against the filter, hiding names that
  // would have qualified once their turn came. Require phase 1 across EVERY
  // row first, so `visible` reflects the true final cap-qualifying set,
  // then wait for phase 2 (the expensive part) on just that set.
  const phase1Done = sorted.every(r => enriched[r.symbol]?._phase != null)
  const enrichedCount = visible.filter(r => enriched[r.symbol]?._phase === 2).length
  const fullyEnriched = phase1Done && (visible.length === 0 || enrichedCount === visible.length)

  // The book scopes are a bounded set that already has its own data, so they
  // render straight away and let enrichment fill in behind them. Only the
  // universe scan has to wait for the completeness gate above.
  const ready = isBookScope(scope) ? true : fullyEnriched

  const positionValue = useCallback((tk: string): { value: number | null; pnl: number | null; pnlPct: number | null } => {
    const p = posMap.get(tk)
    const price = book[tk]?.price
    if (!p || !p.shares || price == null) return { value: null, pnl: null, pnlPct: null }
    const value = p.shares * price
    const cost = p.shares * (p.avgCost || 0)
    if (!cost) return { value, pnl: null, pnlPct: null }
    return { value, pnl: value - cost, pnlPct: (value - cost) / cost * 100 }
  }, [posMap, book])

  // Default groups by date; a user sort flattens to one ordered list (the '' key
  // tells GroupBody to drop the date header).
  const grouped = useMemo<[string, Row[]][]>(() => {
    if (sort) {
      const rank: Record<string, number> = { bmo: 0, dmh: 1, amc: 2 }
      const val = (r: Row): number | string => {
        const e = enriched[r.symbol]
        const b = book[r.symbol]
        switch (sort.key) {
          case 'symbol':          return r.symbol
          case 'marketCap':       return e?.marketCap ?? b?.marketCap ?? -1
          case 'date':            return r.date || ''
          case 'hour':            return rank[r.hour] ?? 3
          case 'epsEstimate':     return r.epsEstimate ?? -1e18
          case 'impliedMove':     return e?.impliedMove ?? -1
          case 'surprisePct':     return e?.surprisePct ?? -1e18
          case 'reactionPct':     return e?.reactionPct ?? -1e18
          case 'runSincePct':     return e?.runSincePct ?? -1e18
          case 'shortPct':        return b?.shortPct ?? -1
          case 'pctChange':       return b?.pctChange ?? -1e18
          case 'position':        return positionValue(r.symbol).value ?? -1
          default:                return 0
        }
      }
      const flat = [...visible].sort((a, b) => {
        const av = val(a), bv = val(b)
        const cmp = typeof av === 'string' || typeof bv === 'string'
          ? String(av).localeCompare(String(bv))
          : (av as number) - (bv as number)
        return sort.dir === 'asc' ? cmp : -cmp
      })
      return [['', flat]]
    }
    const map = new Map<string, Row[]>()
    for (const r of visible) {
      const k = r.date || 'unknown'
      ;(map.get(k) || map.set(k, []).get(k)!).push(r)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [visible, sort, enriched, book, positionValue])

  // Book columns appear when the rows on screen actually carry book data —
  // either you're in a book scope, or the universe scan surfaced names you own.
  const showBookCols = useMemo(
    () => isBookScope(scope) || visible.some(r => r.symbol in book),
    [scope, visible, book],
  )
  const showPosCol = useMemo(
    () => visible.some(r => posMap.has(r.symbol) && (posMap.get(r.symbol)?.shares ?? 0) > 0),
    [visible, posMap],
  )

  const cols = isMobile
    ? ['Symbol', 'Date', 'Result', 'Impl']
    : [
        'Symbol', 'Mkt Cap', 'Date', 'Time', 'Est', 'Result', 'Reaction', 'Impl Move',
        ...(showBookCols ? ['Short %', '1D'] : []),
        ...(showPosCol ? ['Position'] : []),
      ]

  // Every column left-aligned at the symbol, centered after it.
  const colAlign = (_c: string, i: number): 'left' | 'right' | 'center' => (i === 0 ? 'left' : 'center')

  const anyFilter = !!(query || minCapStr || hourFilter || sort)
  const clearFilters = () => { setQuery(''); setMinCapStr(''); setHourFilter(''); setSort(null) }

  // ---- per-row AI filing summary (the old Earnings Summarizer, streamed)
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({})
  // filingDate targets one past filing; omitted, the backend keeps its default
  // of the most recent one.
  const fetchSummary = useCallback(async (ticker: string, filingDate?: string) => {
    setSummaries(prev => ({ ...prev, [ticker]: { stage: 'Queued', pct: 0, result: null, error: null } }))
    try {
      const response = await fetch('/api/filings/summarise-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tickers: [ticker], include_10q: true, include_10k: false, transcript_limit: 1,
          ...(filingDate ? { filing_date: filingDate } : {}),
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const reader = response.body?.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      while (true) {
        const chunk = await reader?.read()
        if (chunk?.done) break
        buffer += decoder.decode(chunk?.value, { stream: true })
        const lines = buffer.split('\n')
        for (let i = 0; i < lines.length - 1; i++) {
          const line = lines[i]
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.substring(6))
            if (ev.type === 'progress') {
              setSummaries(prev => ({ ...prev, [ticker]: { ...prev[ticker], stage: ev.stage, pct: ev.pct } }))
            } else if (ev.type === 'result') {
              setSummaries(prev => ({ ...prev, [ticker]: { stage: 'Completed', pct: 100, result: ev.data, error: ev.data?.error ?? null } }))
            }
          } catch { /* partial frame — the next chunk completes it */ }
        }
        buffer = lines[lines.length - 1]
      }
      setSummaries(prev => {
        const cur = prev[ticker]
        if (cur?.result) return prev
        return { ...prev, [ticker]: { stage: 'Failed', pct: 100, result: null, error: 'No summary returned for this filing.' } }
      })
    } catch {
      setSummaries(prev => ({ ...prev, [ticker]: { stage: 'Failed', pct: 100, result: null, error: 'Could not reach the summarizer. Try again.' } }))
    }
  }, [])

  // ---- row-level popovers. Both are single-open across every date group, so
  // they live here rather than inside a GroupBody.
  const [hover, setHover] = useState<{ sym: string; rect: DOMRect } | null>(null)
  const hoverTimer = useRef<number | null>(null)
  // Which filing each ticker's summary should read, set from the Source picker
  // or the track record. Keyed by symbol so it survives collapsing the row.
  const [aiTargets, setAiTargets] = useState<Record<string, AiTarget | null>>({})

  const clearHoverTimer = () => {
    if (hoverTimer.current != null) { window.clearTimeout(hoverTimer.current); hoverTimer.current = null }
  }
  useEffect(() => clearHoverTimer, [])

  // 400ms dwell: brushing across the table on the way somewhere else should not
  // flash a card on every row it passes.
  // The card is anchored off the row's own rect and portalled to the body: the
  // table scrolls horizontally, which clips any absolutely positioned child at
  // its bottom edge.
  const onHoverSym = useCallback((sym: string | null, rect?: DOMRect | null) => {
    clearHoverTimer()
    if (sym == null || !rect) { setHover(null); return }
    hoverTimer.current = window.setTimeout(() => setHover({ sym, rect }), 400)
  }, [])

  // The card is placed in viewport coordinates, so any scroll strands it next
  // to a row that has moved. Dismiss instead of chasing the anchor.
  useEffect(() => {
    if (!hover) return
    const drop = () => setHover(null)
    window.addEventListener('scroll', drop, true)
    window.addEventListener('resize', drop)
    return () => {
      window.removeEventListener('scroll', drop, true)
      window.removeEventListener('resize', drop)
    }
  }, [hover])

  // The row star still writes the app-wide watchlist (pe_wl) that the ticker
  // drawer and Morning Brief read — this tool just no longer scopes to it.
  const onToggleWatch = useCallback((sym: string) => { setWatchlist(toggleWatchlist(sym)) }, [])

  const windowLabel = isBookScope(scope)
    ? (HORIZONS.find(h => h.key === horizonKey)?.label ?? 'All')
    : (days === 1 ? date : `${date} + ${days}d`)

  useReportCapture(() => {
    if (!visible.length) return null
    const pieces: ClipDraft[] = []
    pieces.push(kpiClip('Earnings Scanner', `Earnings · ${SCOPES.find(s => s.key === scope)?.label} · ${windowLabel}`, [
      { label: 'Rows', value: String(visible.length) },
      { label: 'Scope', value: SCOPES.find(s => s.key === scope)?.label ?? '—' },
      { label: 'Window', value: windowLabel },
      { label: 'With Estimates', value: String(isBookScope(scope) ? visible.filter(r => r.epsEstimate != null).length : covered) },
      { label: 'Held', value: String(visible.filter(r => posMap.has(r.symbol)).length) },
    ]))
    pieces.push(tableClip(
      'Earnings Scanner',
      `Earnings Calendar · ${windowLabel}`,
      ['Symbol', 'Company', 'Date', 'Time', 'Mkt Cap', 'Est', 'Result', 'Reaction', 'Impl Move', 'Short %', 'Position'],
      visible.slice(0, 20).map(r => {
        const e = enriched[r.symbol]
        const b = book[r.symbol]
        const reported = e?.priorReportDate === r.date
        const pos = positionValue(r.symbol)
        return [
          r.symbol,
          e?.companyName ?? b?.name ?? null,
          r.date,
          HOUR_LABEL[r.hour] ?? r.hour ?? null,
          (e?.marketCap ?? b?.marketCap) != null ? fmtMoney(e?.marketCap ?? b?.marketCap) : null,
          fmtEps(r.epsEstimate),
          reported && e?.surprisePct != null ? `${e.surprisePct >= 0 ? 'Beat' : 'Miss'} ${fmtPct(e.surprisePct)}` : null,
          reported ? fmtPct(e?.reactionPct) : null,
          e?.impliedMove != null ? fmtPct(e.impliedMove) : null,
          b?.shortPct != null ? `${b.shortPct.toFixed(1)}%` : null,
          pos.value != null ? fmtMoney(pos.value) : null,
        ]
      }),
    ))
    // Whatever row is open goes into the report with the calendar it came from.
    const openSym = expanded?.split('|')[0]
    const openSummary = openSym ? summaries[openSym]?.result : null
    if (openSym && openSummary?.summary) {
      const s = openSummary.summary
      pieces.push(textClip('Earnings Scanner', `AI Summary · ${openSym}`, s.verdict))
      const bullets: string[] = []
      if (s.bull_points?.length) bullets.push('Bull case:\n' + s.bull_points.map(p => `• ${p}`).join('\n'))
      if (s.bear_points?.length) bullets.push('Bear case:\n' + s.bear_points.map(p => `• ${p}`).join('\n'))
      if (s.guidance && s.guidance !== 'N/A') bullets.push(`Guidance: ${s.guidance}`)
      if (s.key_themes?.length) bullets.push(`Themes: ${s.key_themes.join(', ')}`)
      if (s.risks?.length) bullets.push(`Risks: ${s.risks.join(', ')}`)
      if (s.analyst_questions_focus) bullets.push(`Analyst focus: ${s.analyst_questions_focus}`)
      if (bullets.length) pieces.push(textClip('Earnings Scanner', `Bull / Bear · ${openSym}`, bullets.join('\n\n')))
      if (openSummary.segments?.length) {
        pieces.push(tableClip('Earnings Scanner', `Segment Revenue · ${openSym}`, ['Segment', 'Revenue'],
          openSummary.segments.map(seg => [seg.name, fmtB(seg.value)])))
      }
    }
    return pieces
  }, { disabled: !visible.length, sourceTab: 'Earnings Scanner' })

  const SORT_KEY: Record<string, SortKey> = {
    'Symbol': 'symbol', 'Mkt Cap': 'marketCap', 'Date': 'date', 'Time': 'hour', 'Est': 'epsEstimate',
    'Impl Move': 'impliedMove', 'Impl': 'impliedMove',
    'Result': 'surprisePct', 'Reaction': 'reactionPct',
    'Short %': 'shortPct', '1D': 'pctChange', 'Position': 'position',
  }
  const colFilterSpec = (c: string): FilterSpec | undefined => {
    switch (c) {
      case 'Symbol':  return { kind: 'text', value: query, set: setQuery, placeholder: 'Ticker or company' }
      case 'Mkt Cap': return { kind: 'min', value: minCapStr, set: setMinCapStr, placeholder: '≥ $B' }
      case 'Time':    return { kind: 'select', value: hourFilter, set: setHourFilter,
                        options: [{ label: 'All', key: '' }, { label: 'Pre', key: 'bmo' }, { label: 'Post', key: 'amc' }, { label: 'Mid', key: 'dmh' }] }
      default:        return undefined
    }
  }
  const colMenu = (c: string, align: 'left' | 'right') => (
    <ColumnFilterMenu align={align} sortKey={SORT_KEY[c]} sort={sort} onSort={setSort} filter={colFilterSpec(c)} />
  )

  const bookEmpty = isBookScope(scope) && positions.length === 0

  return (
    <>
      <style>{`
        @keyframes ec-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
      `}</style>

      {/* Controls — a single toolbar line, parameter groups separated by
          hairlines, with the run counts on a meta strip inside the same panel.
          It never wraps: a narrow viewport scrolls the row instead of stacking
          it, so the control order stays the same at every width. */}
      <div style={{ background: C.header, border: `1px solid ${C.border}`, marginBottom: 14 }}>
        <div style={{
          display: 'flex', alignItems: 'center', flexWrap: 'nowrap',
          overflowX: 'auto', padding: '0 14px', minHeight: 48,
        }}>
          <GroupLabel>Scope</GroupLabel>
          <Segmented
            items={SCOPES.map(s => ({
              key: s.key, label: s.label,
              title: s.key === 'holdings' ? 'Only names in your Portfolio Manager book'
                : s.key === 'covered' ? 'Only names with a published consensus estimate'
                : 'Every name reporting in this window',
            }))}
            value={scope}
            onPick={k => setScope(k as Scope)}
          />

          <Divider />

          {isBookScope(scope) ? (
            <>
              <GroupLabel htmlFor="ec-book">Book</GroupLabel>
              <select id="ec-book" value={bookId} onChange={e => setBookId(e.target.value)}
                title="Which Portfolio Manager book this agenda reads"
                style={{
                  background: C.inset, border: `1px solid ${C.border}`, color: C.text,
                  fontFamily: C.mono, fontSize: 12, padding: '6px 8px', outline: 'none',
                  maxWidth: 190, flexShrink: 0, colorScheme: 'var(--theme-color-scheme, dark)' as React.CSSProperties['colorScheme'],
                }}>
                <option value={ACTIVE_BOOK}>Active book</option>
                {pmBooks.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>

              <Divider />

              <GroupLabel>Horizon</GroupLabel>
              <Segmented
                items={HORIZONS.map(h => ({ key: h.key, label: h.label }))}
                value={horizonKey}
                onPick={k => setHorizonKey(k as HorizonKey)}
              />
            </>
          ) : (
            <>
              <GroupLabel htmlFor="ec-date">Date</GroupLabel>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, border: `1px solid ${C.border}`, background: C.inset, padding: '0 10px', flexShrink: 0 }}>
                <input id="ec-date" type="date" value={date} onChange={e => setDate(e.target.value || today())}
                  style={{
                    background: 'transparent', border: 'none', color: C.text, fontFamily: C.mono,
                    fontSize: 12.5, fontVariantNumeric: 'tabular-nums', padding: '6px 0', outline: 'none',
                    colorScheme: 'var(--theme-color-scheme, dark)' as React.CSSProperties['colorScheme'],
                  }} />
              </div>

              <Divider />

              <GroupLabel>Window</GroupLabel>
              <Segmented
                items={WINDOWS.map(w => ({ key: String(w.days), label: w.label }))}
                value={String(days)}
                onPick={k => {
                  // Re-anchor to local today when picking a relative window so a
                  // stale date-picker value (e.g. last Monday) cannot exclude
                  // names that report later this week / next week.
                  setDate(today())
                  setDays(Number(k))
                }}
              />
            </>
          )}

          <Divider />

          <GroupLabel htmlFor="ec-mincap"
            title="Filtered results are matched against a curated list of ~1,000 major US names, IPOs, and large ADRs — a name outside that list won't appear while a cap filter is set, even if it would qualify.">
            Cap ≥
          </GroupLabel>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${C.border}`, background: C.inset, padding: '0 10px', flexShrink: 0 }}>
            <span style={{ fontFamily: C.mono, fontSize: 12, color: C.muted }}>$</span>
            <input id="ec-mincap" type="number" min={0} step="1" value={minCapStr} onChange={e => setMinCapStr(e.target.value)}
              placeholder="0" style={{
                background: 'transparent', border: 'none', color: C.text, fontFamily: C.mono,
                fontSize: 12.5, fontVariantNumeric: 'tabular-nums', padding: '6px 0', width: 54, outline: 'none',
              }} />
            <span style={{ fontFamily: C.mono, fontSize: 12, color: C.muted }}>B</span>
          </div>

          <div style={{ flex: 1, minWidth: 12 }} />

          {/* The holdings scope reads the book rather than screening, so there is nothing to run. */}
          {!isBookScope(scope) && (
            <button type="button" onClick={loadCalendar} disabled={loading}
              title="Screen the universe for the parameters above"
              style={{
                background: C.gold, border: 'none', color: C.header, cursor: loading ? 'default' : 'pointer',
                fontFamily: C.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                padding: '9px 20px', whiteSpace: 'nowrap', opacity: loading ? 0.6 : 1, flexShrink: 0,
              }}>{loading ? 'Scanning…' : 'Scan'}</button>
          )}
        </div>

        {/* Meta strip — what the current run actually returned. */}
        {(ready && !error && visible.length > 0) || anyFilter ? (
          <div style={{
            display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
            padding: '9px 14px', borderTop: `1px solid ${C.borderFaint}`, background: C.inset,
          }}>
            {ready && !error && visible.length > 0 && (
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <Stat n={visible.length} word={isBookScope(scope) ? 'on the agenda' : 'reporting'} strong />
                {!isBookScope(scope) && <><Sep /><Stat n={covered} word="with estimates" /></>}
                {showPosCol && <><Sep /><Stat n={visible.filter(r => posMap.has(r.symbol)).length} word="held" color={C.gold} /></>}
                <Sep />
                <span style={{ fontFamily: C.sans, fontSize: 11, color: C.muted }}>
                  {sort
                    ? <>sorted by <span style={{ color: C.text }}>{sort.key}</span> {sort.dir === 'asc' ? '↑' : '↓'}</>
                    : isBookScope(scope)
                      ? <>next {HORIZONS.find(h => h.key === horizonKey)?.label.toLowerCase()}</>
                      : <>{fmtDate(date)}{days > 1 ? ` → ${fmtDate(rangeTo || grouped[grouped.length - 1]?.[0] || date)}` : ''}</>}
                </span>
              </span>
            )}
            <div style={{ flex: 1, minWidth: 8 }} />
            {anyFilter && (
              <button onClick={clearFilters} style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: C.dim, whiteSpace: 'nowrap',
              }}>Clear filters</button>
            )}
          </div>
        ) : null}
      </div>

      {bookEmpty && (
        <EmptyState
          title="No Holdings"
          hint={bookId === ACTIVE_BOOK
            ? 'Add positions in the Portfolio Manager, or switch scope to All to screen the market.'
            : 'That book has no positions. Pick another book, or switch scope to All to screen the market.'} />
      )}
      {isBookScope(scope) && !bookEmpty && bookLoading && visible.length === 0 && (
        <EmptyState title="Loading…" variant="loading" hint="Resolving report dates for your book…" />
      )}
      {isBookScope(scope) && !bookEmpty && !bookLoading && visible.length === 0 && (
        <EmptyState title="Nothing Scheduled" hint="No name in this scope reports inside the horizon. Widen it, or clear filters." />
      )}
      {!isBookScope(scope) && !started && (
        <EmptyState title="Earnings Scanner" hint="Set the date, window, and market cap above, then click SCAN." action="SCAN" />
      )}
      {!isBookScope(scope) && started && !error && (loading || !ready) && (
        <EmptyState title="Loading…" variant="loading"
          hint={loading ? 'Fetching the earnings calendar…' : `Enriching companies — ${enrichedCount} / ${visible.length}…`}
          progress={loading ? undefined : (visible.length ? (enrichedCount / visible.length) * 100 : 100)} />
      )}
      {!isBookScope(scope) && started && error && (
        <EmptyState title="Could Not Load" hint={error} variant="unavailable" onRetry={loadCalendar} />
      )}
      {!isBookScope(scope) && started && !loading && !error && ready && visible.length === 0 && (
        <EmptyState title="No Matches" hint="No companies match. Widen the window or clear filters." />
      )}

      {ready && !error && !bookEmpty && visible.length > 0 && (
        <div style={{ border: `1px solid ${C.border}`, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: isMobile ? 0 : 720 }}>
            <thead>
              <tr style={{ background: C.header }}>
                {cols.map((c, i) => (
                  <th key={c} style={{
                    ...LABEL, display: 'table-cell', textAlign: colAlign(c, i), padding: '9px 14px',
                    position: 'sticky', top: 0, background: C.header, borderBottom: `1px solid ${C.border}`,
                  }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: colAlign(c, i), width: '100%', verticalAlign: 'middle' }}>
                      {c}{colMenu(c, i === 0 ? 'left' : 'right')}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map(([gdate, grows]) => (
                <GroupBody key={gdate} gdate={gdate} grows={grows} enriched={enriched} book={book}
                  colCount={cols.length} isMobile={isMobile}
                  showHeader={!sort && (isBookScope(scope) || days > 1)}
                  showBookCols={showBookCols} showPosCol={showPosCol}
                  watch={watchSet} posMap={posMap} positionValue={positionValue}
                  expanded={expanded}
                  onToggleExpand={k => {
                    setExpanded(cur => (cur === k ? null : k))
                    loadBook([k.split('|')[0]])
                  }}
                  onToggleWatch={onToggleWatch}
                  summaries={summaries} onFetchSummary={fetchSummary}
                  registerRow={registerRow}
                  pop={{ hover, onHover: onHoverSym }}
                  aiTargets={aiTargets}
                  onSetAiTarget={(sym, t) => setAiTargets(p => ({ ...p, [sym]: t }))} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ready && !error && !bookEmpty && visible.length > 0 && (
        <div style={{ fontFamily: C.sans, fontSize: 10, color: C.muted, marginTop: 10, lineHeight: 1.7 }}>
          Impl Move = expected move priced into the ATM straddle of the expiry spanning this report.
          Result and Reaction show once that report is in. Result is last EPS vs estimate, Reaction is the
          stock's one-day move. Click a row for the last 5 reports, your position, the wire, and an AI
          filing summary. Estimates from finnhub, reactions from prior-quarter prices, book context from
          your Portfolio Manager holdings.
        </div>
      )}
    </>
  )
}

interface GroupBodyProps {
  gdate: string; grows: Row[]
  enriched: Record<string, Enriched>; book: Record<string, BookInfo>
  colCount: number; isMobile: boolean; showHeader: boolean
  showBookCols: boolean; showPosCol: boolean
  watch: Set<string>; posMap: Map<string, Position>
  positionValue: (tk: string) => { value: number | null; pnl: number | null; pnlPct: number | null }
  expanded: string | null; onToggleExpand: (key: string) => void
  onToggleWatch: (sym: string) => void
  summaries: Record<string, SummaryState>; onFetchSummary: (tk: string, filingDate?: string) => void
  pop: PopoverBus
  aiTargets: Record<string, AiTarget | null>
  onSetAiTarget: (sym: string, t: AiTarget | null) => void
  registerRow: (el: HTMLTableRowElement | null, symbol: string) => void
}

function GroupBody({
  gdate, grows, enriched, book, colCount, isMobile, showHeader, showBookCols, showPosCol,
  watch, posMap, positionValue, expanded, onToggleExpand, onToggleWatch,
  summaries, onFetchSummary, registerRow, pop, aiTargets, onSetAiTarget,
}: GroupBodyProps) {
  const todayIso = today()
  return (
    <>
      {showHeader && (
        <tr>
          <td colSpan={colCount} style={{
            background: C.bg, padding: '7px 14px', borderBottom: `1px solid ${C.border}`,
            fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: C.gold,
          }}>
            {fmtDate(gdate)} · {grows.length}
            {(() => { const d = daysUntil(gdate); return d != null && d >= 0 ? ` · in ${d}d` : '' })()}
          </td>
        </tr>
      )}
      {grows.map(r => {
        const e = enriched[r.symbol]
        const b = book[r.symbol]
        const pending = !e
        const key = `${r.symbol}|${r.date}`
        const isOpen = expanded === key
        const pos = positionValue(r.symbol)
        const held = (posMap.get(r.symbol)?.shares ?? 0) > 0
        // The report for this exact row's date has landed and matches the
        // ticker's most recently known report, as opposed to an
        // upcoming/not-yet-reported row (the common case).
        const dateMatched = e?.priorReportDate === r.date
        const reported = dateMatched && hasReportedFigures(e)
        // Reported on this date, but Yahoo has not published the figures yet.
        // Distinct from "no data": the report is out, the numbers are in transit.
        const awaitingFigures = !pending
          && (dateMatched ? !hasReportedFigures(e) : sourceHasGapAt(e, r.date, todayIso))
        // Fallback only: when a row never resolves a Result, check whether
        // yfinance's own confirmed schedule agrees with the calendar's date
        // at all — occasionally it doesn't (the calendar source has the
        // wrong date), and that's a clearer explanation than a bare dash.
        const mismatch = !pending && !reported && !awaitingFigures
          ? calendarMismatchDate(e, r.date, todayIso)
          : null
        return (
          <Fragment key={key}>
            <tr ref={el => registerRow(el, r.symbol)} onClick={() => onToggleExpand(key)}
              style={{
                borderBottom: `1px solid ${C.border}`, cursor: 'pointer',
                background: isOpen ? gold(6) : held ? gold(3) : undefined,
              }}>
              <td style={{ padding: '10px 14px', position: 'relative' }}>
                <div
                  onMouseEnter={ev => pop.onHover(r.symbol, ev.currentTarget.getBoundingClientRect())}
                  onMouseLeave={() => pop.onHover(null)}
                  style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                  <span style={{ display: 'flex', flexShrink: 0 }}>
                    <TickerLogo ticker={r.symbol} size={22} />
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
                      <TickerLink ticker={r.symbol} />
                      {held && (
                        <span title="You hold this name" style={{
                          fontFamily: C.sans, fontSize: 7.5, fontWeight: 700, letterSpacing: '0.1em',
                          color: C.gold, border: `1px solid ${gold(48)}`, background: gold(12),
                          padding: '2px 5px', flexShrink: 0,
                        }}>HOLDING</span>
                      )}
                      <button
                        onClick={ev => { ev.stopPropagation(); onToggleWatch(r.symbol.toUpperCase()) }}
                        title={watch.has(r.symbol.toUpperCase()) ? 'Remove from watchlist' : 'Add to watchlist'}
                        aria-label={watch.has(r.symbol.toUpperCase()) ? `Remove ${r.symbol} from watchlist` : `Add ${r.symbol} to watchlist`}
                        aria-pressed={watch.has(r.symbol.toUpperCase())}
                        style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 0, flexShrink: 0 }}>
                        <Star size={10}
                          fill={watch.has(r.symbol.toUpperCase()) ? C.gold : 'none'}
                          stroke={watch.has(r.symbol.toUpperCase()) ? C.gold : C.dim} />
                      </button>
                    </div>
                    {!isMobile && (
                      // Plain text: the ticker itself already carries a menu
                      // (TickerLink), and picking a filing now lives on the
                      // summary's Source control inside the expanded row.
                      <span style={{
                        display: 'block', fontFamily: C.sans, fontSize: 9, color: C.muted,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200,
                      }}>{pending ? (b?.name ?? '') : (e?.companyName || b?.name || '—')}</span>
                    )}
                  </div>
                </div>

                {pop.hover?.sym === r.symbol && !isOpen && (
                  <HoverPreview symbol={r.symbol} e={e} b={b} anchor={pop.hover.rect} />
                )}
              </td>
              {!isMobile && (
                <td style={{ ...cell, color: C.dim }}>
                  {pending && b?.marketCap == null ? <span style={shimmer} /> : fmtMoney(e?.marketCap ?? b?.marketCap)}
                </td>
              )}
              <td style={{ ...cell, color: C.text }}>{fmtDateShort(r.date)}</td>
              {!isMobile && (
                <td style={cell}><HourChip hour={r.hour} /></td>
              )}
              {!isMobile && (
                <td style={{ ...cell, color: C.text }}>{fmtEps(r.epsEstimate)}</td>
              )}
              <td style={cell}>
                {pending ? <span style={shimmer} /> : mismatch ? (
                  <span style={{ fontFamily: C.sans, fontSize: 9.5, fontStyle: 'italic', color: C.warn }}
                    title={`This calendar date doesn't match the confirmed report date — yfinance shows ${fmtDate(mismatch)}.`}>
                    {mismatch < r.date ? 'reported' : 'resched.'} {fmtDateShort(mismatch)}
                  </span>
                ) : awaitingFigures ? (
                  <span style={{ fontFamily: C.sans, fontSize: 9.5, fontStyle: 'italic', color: C.dim }}
                    title="This company has reported. Yahoo has not published the EPS figures yet, usually within a day.">
                    reported · figures pending
                  </span>
                ) : <BeatMissBadge surprisePct={reported ? e?.surprisePct : null} />}
              </td>
              {!isMobile && (
                <td style={{ ...cell, color: reported && e?.reactionPct != null ? pctColor(e.reactionPct) : C.dim }}>
                  {pending ? <span style={shimmer} /> : reported
                    ? (e?.reactionPct != null
                        ? fmtPct(e.reactionPct)
                        // Reported today but the market hasn't closed since — the 1-day
                        // reaction needs a completed trading day after the report to
                        // compute against, so this fills in on its own, usually the next
                        // day. A flat "—" here reads identically to "never available",
                        // which is exactly what confused things.
                        : <span style={{ fontFamily: C.sans, fontSize: 10, fontStyle: 'italic' }}>pending</span>)
                    : '—'}
                </td>
              )}
              <td style={{ ...cell, color: C.gold }} title={e?.impliedMoveExpiry ? `Expected move by ${e.impliedMoveExpiry}` : undefined}>
                {pending || !e?._impliedMoveLoaded
                  // Not loaded yet (still off-screen or the lazy fetch is in flight) reads
                  // identically to "confirmed no options chain" otherwise — same problem
                  // as Reaction above, just for a different reason (lazy-loaded, not
                  // time-gated). Shimmer here, not a dash, until it's actually resolved.
                  ? <span style={shimmer} />
                  : (e?.impliedMove != null ? `${e.impliedMove.toFixed(1)}%` : <span style={{ color: C.dim }}>—</span>)}
              </td>
              {!isMobile && showBookCols && (
                <td style={{ ...cell, color: b?.shortPct != null ? C.text : C.dim }}>
                  {b ? (b.shortPct != null ? `${b.shortPct.toFixed(1)}%` : '—') : '—'}
                </td>
              )}
              {!isMobile && showBookCols && (
                <td style={{ ...cell, color: pctColor(b?.pctChange) }}>
                  {b?.pctChange != null ? fmtPct(b.pctChange) : '—'}
                </td>
              )}
              {!isMobile && showPosCol && (
                <td style={{ ...cell, color: pos.value != null ? C.text : C.dim }}>
                  {pos.value != null ? (
                    <span>
                      {fmtMoney(pos.value)}
                      {pos.pnlPct != null && (
                        <span style={{ color: pctColor(pos.pnlPct), fontSize: 10, marginLeft: 6 }}>{fmtPct(pos.pnlPct)}</span>
                      )}
                    </span>
                  ) : '—'}
                </td>
              )}
            </tr>
            {isOpen && (
              <tr>
                <td colSpan={colCount} style={{ padding: 0, background: C.header, borderBottom: `1px solid ${C.border}` }}>
                  <RowDetail row={r} e={e} b={b} position={posMap.get(r.symbol) ?? null} pos={pos}
                    isMobile={isMobile}
                    summary={summaries[r.symbol] ?? null}
                    onFetchSummary={(filingDate?: string) => onFetchSummary(r.symbol, filingDate)}
                    aiTarget={aiTargets[r.symbol] ?? null}
                    setAiTarget={t => onSetAiTarget(r.symbol, t)} />
                </td>
              </tr>
            )}
          </Fragment>
        )
      })}
    </>
  )
}

const popShell: React.CSSProperties = {
  position: 'absolute', top: 'calc(100% - 4px)', left: 38, zIndex: 30,
  background: C.header, border: `1px solid ${gold(34)}`, boxShadow: '0 14px 34px rgba(0,0,0,0.5)',
}

/** What each form is, so the archive reads as history rather than filing codes. */
const FORM_PURPOSE: Record<string, string> = {
  '10-Q': 'Quarterly report', '10-K': 'Annual report', '8-K': 'Material event',
  'DEF 14A': 'Proxy statement', '4': 'Insider transaction',
}

function FilingsArchive({ symbol, filings, onClose, onPick, style }: {
  symbol: string
  filings: Filing[] | 'loading' | 'error' | undefined
  onClose: () => void
  onPick: (f: Filing) => void
  style?: React.CSSProperties
}) {
  const [form, setForm] = useState('All')
  const list = Array.isArray(filings) ? filings : []
  const forms = ['All', ...Array.from(new Set(list.map(f => f.form)))]
  const shown = form === 'All' ? list : list.filter(f => f.form === form)

  return (
    <div onClick={ev => ev.stopPropagation()} style={{ ...popShell, width: 272, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', background: gold(6), borderBottom: `1px solid ${gold(16)}` }}>
        <span style={{ ...LABEL, fontSize: 8.5, color: C.gold, display: 'inline' }}>{symbol} filings</span>
        <button onClick={onClose} style={ghostBtn}>Close</button>
      </div>

      {list.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '8px 10px', borderBottom: `1px solid ${C.borderFaint}` }}>
          {forms.map(f => (
            <button key={f} onClick={() => setForm(f)} style={{
              fontFamily: C.sans, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', padding: '4px 8px', border: 'none', cursor: 'pointer',
              background: form === f ? C.gold : C.inset, color: form === f ? C.header : C.muted,
            }}>{f}</button>
          ))}
        </div>
      )}

      <div style={{ maxHeight: 252, overflowY: 'auto' }}>
        {filings === 'loading' && (
          <EmptyState variant="loading" size="compact" title="Loading filings" />
        )}
        {filings === 'error' && <div style={{ ...popNote, color: C.warn }}>Could not reach SEC EDGAR.</div>}
        {Array.isArray(filings) && shown.length === 0 && <div style={popNote}>No filings of this type.</div>}
        {shown.map((f, i) => (
          <button key={`${f.accession ?? f.date}-${i}`} onClick={() => onPick(f)} style={{
            display: 'flex', width: '100%', alignItems: 'baseline', justifyContent: 'space-between', gap: 10,
            padding: '7px 12px', border: 'none', borderBottom: `1px solid ${C.borderFaint}`,
            background: 'transparent', cursor: 'pointer', textAlign: 'left',
          }}>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontFamily: C.mono, fontSize: 11.5, fontWeight: 700, color: C.text }}>
                {f.form} · {f.date.slice(0, 7)}
              </span>
              <span style={{ display: 'block', fontFamily: C.sans, fontSize: 8.5, color: C.dim, marginTop: 2 }}>
                {FORM_PURPOSE[f.form] ?? 'Filing'}
              </span>
            </span>
            <span style={{ fontFamily: C.sans, fontSize: 9, color: C.dim, whiteSpace: 'nowrap' }}>{fmtDate(f.date)}</span>
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, padding: '8px 12px', borderTop: `1px solid ${C.border}`, background: C.inset }}>
        <span style={{ fontFamily: C.sans, fontSize: 9, color: C.dim }}>Any filing can be the summarizer's source.</span>
        {Array.isArray(filings) && (
          <span style={{ fontFamily: C.mono, fontSize: 9, color: C.muted, whiteSpace: 'nowrap' }}>{shown.length} of {list.length}</span>
        )}
      </div>
    </div>
  )
}

const popNote: React.CSSProperties = { padding: '12px', fontFamily: C.sans, fontSize: 10.5, color: C.muted }

/** Dwell-triggered peek at a row. Portalled to the body and anchored off the
 *  row's rect: the table is a horizontal scroll container, which clips any
 *  absolutely positioned child at its own bottom edge. pointer-events:none so
 *  it never eats the click. */
function HoverPreview({ symbol, e, b, anchor }: { symbol: string; e?: Enriched; b?: BookInfo; anchor: DOMRect }) {
  const cells: { label: string; value: string; color?: string }[] = [
    { label: 'Implied move', value: e?.impliedMove != null ? `${e.impliedMove.toFixed(1)}%` : '—', color: e?.impliedMove != null ? C.gold : C.dim },
    { label: 'Hist. move', value: b?.detail?.histAvgMovePct != null ? `±${b.detail.histAvgMovePct.toFixed(1)}%` : '—' },
    { label: 'Beat rate', value: b?.detail?.beatRatePct != null ? `${b.detail.beatRatePct}%` : '—', color: b?.detail?.beatRatePct != null ? C.pos : C.dim },
    { label: 'Fwd P/E', value: b?.pe != null ? `${b.pe.toFixed(2)}x` : '—' },
  ]
  const W = 308
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const below = vh - anchor.bottom
  // Flip above when the room below can't hold the card and there is more of it
  // overhead. Anchoring the flipped card by its bottom edge means the height
  // never has to be measured.
  const flip = below < 250 && anchor.top > below
  const pos: React.CSSProperties = flip
    ? { bottom: vh - anchor.top + 6, maxHeight: anchor.top - 14 }
    : { top: anchor.bottom + 6, maxHeight: below - 14 }

  const card = (
    <div style={{
      position: 'fixed', left: Math.min(Math.max(8, anchor.left), vw - W - 8), width: W,
      zIndex: 1200, pointerEvents: 'none', overflow: 'hidden',
      background: C.header, border: `1px solid ${gold(34)}`, boxShadow: '0 14px 34px rgba(0,0,0,0.5)',
      ...pos,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', background: C.inset, borderBottom: `1px solid ${C.border}` }}>
        <TickerLogo ticker={symbol} size={20} />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontFamily: C.mono, fontSize: 12.5, fontWeight: 700, color: C.gold }}>{symbol}</span>
          <span style={{ display: 'block', fontFamily: C.sans, fontSize: 9.5, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {e?.sector || e?.companyName || b?.name || '—'}
          </span>
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: C.border }}>
        {cells.map(c => (
          <div key={c.label} style={{ background: C.header, padding: '9px 12px' }}>
            <div style={{ ...LABEL, fontSize: 8, display: 'block', marginBottom: 4 }}>{c.label}</div>
            <div style={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: c.color ?? C.text }}>{c.value}</div>
          </div>
        ))}
      </div>
      {b && b.sparkline.length > 1 && (
        <div style={{ padding: '10px 12px 12px' }}>
          <div style={{ ...LABEL, fontSize: 8, marginBottom: 6 }}>Recent price</div>
          <Sparkline data={b.sparkline} positive={(b.pctChange ?? 0) >= 0} />
        </div>
      )}
      <div style={{ padding: '0 12px 11px', fontFamily: C.sans, fontSize: 9.5, color: C.dim, lineHeight: 1.4 }}>
        Click the row for the full report · the ticker for its tools.
      </div>
    </div>
  )
  return typeof document !== 'undefined' ? createPortal(card, document.body) : card
}

function DetailRow({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, padding: '7px 0', borderBottom: `1px solid ${C.border}` }}>
      <span style={{ ...LABEL, marginBottom: 0 }}>{label}</span>
      <span style={{ fontFamily: C.mono, fontSize: 12.5, fontWeight: 600, color: color ?? C.text, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

interface HistoryReport { date: string; estimate: number | null; actual: number | null; surprisePct: number | null }

/** The filing the AI summary should read, chosen from the archive or the track record. */
interface AiTarget { form: string; period: string; filed: string }

/** Row-level popover wiring, owned by the page so only one is ever open. */
interface PopoverBus {
  hover: { sym: string; rect: DOMRect } | null
  onHover: (sym: string | null, rect?: DOMRect | null) => void
}

// Estimate-vs-actual EPS bars for the last n reports, oldest first — two bars
// per report (muted estimate, colored actual) sharing one scale so a beat/miss
// pattern reads at a glance instead of one column of surprise% figures.
function EstActualBars({ reports, picked, onPick }: {
  reports: HistoryReport[]
  picked?: number | null
  onPick?: (index: number) => void
}) {
  const BAR_H = 100
  const maxAbs = Math.max(0.01, ...reports.flatMap(r => [r.estimate, r.actual].filter((v): v is number => v != null).map(Math.abs)))
  const barHeight = (v: number | null) => v == null ? 0 : Math.max(4, Math.round(Math.abs(v) / maxAbs * BAR_H))
  const valueLabel: React.CSSProperties = { fontFamily: C.mono, fontSize: 9.5, marginBottom: 5, whiteSpace: 'nowrap' }
  // Bars and their quarter label live in ONE column so the whole quarter is a
  // single hit target, rather than a bar row sitting above an unrelated label row.
  return (
    <div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end' }}>
        {reports.map((r, i) => {
          const on = picked === i
          const clickable = !!onPick
          return (
            <div
              key={r.date}
              onClick={clickable ? () => onPick!(i) : undefined}
              role={clickable ? 'button' : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-pressed={clickable ? on : undefined}
              onKeyDown={clickable ? ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPick!(i) } } : undefined}
              style={{
                flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
                cursor: clickable ? 'pointer' : 'default', padding: '2px 2px 0',
                background: on ? gold(7) : 'transparent',
                borderBottom: `2px solid ${on ? gold(45) : 'transparent'}`,
                transition: 'background 0.12s, border-color 0.12s',
              }}>
              <div style={{ display: 'flex', gap: 9, alignItems: 'flex-end', height: BAR_H + 22 }}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                  <span style={{ ...valueLabel, color: C.muted }}>{fmtEps(r.estimate)}</span>
                  <div title={`Estimate ${fmtEps(r.estimate)}`} style={{ width: 16, height: barHeight(r.estimate), background: C.muted, opacity: 0.5, borderRadius: '2px 2px 0 0' }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                  <span style={{ ...valueLabel, color: C.gold }}>{fmtEps(r.actual)}</span>
                  <div title={`Actual ${fmtEps(r.actual)}`} style={{ width: 16, height: barHeight(r.actual), borderRadius: '2px 2px 0 0', background: C.gold }} />
                </div>
              </div>
              <div style={{
                width: '100%', textAlign: 'center', fontFamily: C.sans, fontSize: 10,
                color: on ? C.gold : C.muted, margin: '6px 0 4px',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{fmtQuarterLabel(r.date)}</div>
            </div>
          )
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 12, fontFamily: C.sans, fontSize: 9.5, color: C.muted }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 9, height: 9, background: C.muted, opacity: 0.5, display: 'inline-block' }} /> Estimate
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span style={{ width: 9, height: 9, background: C.gold, display: 'inline-block' }} /> Actual
        </span>
      </div>
    </div>
  )
}

function InsiderTable({ txs }: { txs: InsiderTx[] }) {
  return (
    <div style={{ marginTop: 10, maxHeight: 210, overflowY: 'auto', border: `1px solid ${C.border}` }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Date', 'Insider', 'Title', 'Type', 'Shares', 'Value'].map((h, i) => (
              <th key={h} style={{ ...LABEL, display: 'table-cell', textAlign: i >= 4 ? 'right' : 'left', padding: '6px 8px', borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, background: C.bg }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {txs.map((tx, i) => {
            const kind = tx.side === 'sell' ? 'Sale' : tx.side === 'buy' ? 'Purchase' : null
            return (
              <tr key={i}>
                <td style={{ fontFamily: C.mono, fontSize: 10, color: C.muted, padding: '5px 8px', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{tx.date}</td>
                <td style={{ fontFamily: C.sans, fontSize: 10.5, color: C.text, padding: '5px 8px', borderBottom: `1px solid ${C.border}` }}>{tx.insider}</td>
                <td style={{ fontFamily: C.sans, fontSize: 10, color: C.dim, padding: '5px 8px', borderBottom: `1px solid ${C.border}` }}>{tx.title || '—'}</td>
                <td style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 700, color: kind === 'Sale' ? C.neg : kind === 'Purchase' ? C.pos : C.muted, padding: '5px 8px', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{kind ?? (tx.transaction || 'Other')}</td>
                <td style={{ fontFamily: C.mono, fontSize: 10, color: C.text, textAlign: 'right', padding: '5px 8px', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{tx.shares > 0 ? tx.shares.toLocaleString() : '—'}</td>
                <td style={{ fontFamily: C.mono, fontSize: 10, color: C.text, textAlign: 'right', padding: '5px 8px', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{tx.value > 0 ? `$${(tx.value / 1e6).toFixed(2)}M` : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function insiderDetail90d(txs: InsiderTx[] | null): { text: string; color: string } {
  if (txs == null) return { text: 'Loading Form 4 activity…', color: C.dim }
  const cutoff = Date.now() - 90 * 86_400_000
  const recent = txs.filter(t => { const d = new Date(`${t.date}T00:00:00`); return !isNaN(+d) && +d >= cutoff })
  if (recent.length === 0) return { text: 'No Form 4 activity filed (90d)', color: C.dim }
  const sales = recent.filter(t => t.side === 'sell')
  const buys = recent.filter(t => t.side === 'buy')
  const sold = sales.length >= buys.length
  const set = sold ? sales : buys
  if (set.length === 0) return { text: `${recent.length} Form 4 filing${recent.length > 1 ? 's' : ''} (90d)`, color: C.dim }
  const value = set.reduce((s, t) => s + (t.value || 0), 0)
  const n = new Set(set.map(t => t.insider)).size
  const last = set[0]
  const who = last.title ? last.title.replace(/^Officer\s*/i, '') : 'insider'
  return {
    text: `${n} insider${n > 1 ? 's' : ''} ${sold ? 'sold' : 'bought'} $${(value / 1e6).toFixed(1)}M · last ${who}, ${last.date}`,
    color: sold ? C.neg : C.pos,
  }
}

function RowDetail({ row, e, b, position, pos, isMobile, summary, onFetchSummary, aiTarget, setAiTarget }: {
  row: Row; e?: Enriched; b?: BookInfo
  position: Position | null
  pos: { value: number | null; pnl: number | null; pnlPct: number | null }
  isMobile: boolean
  summary: SummaryState | null; onFetchSummary: (filingDate?: string) => void
  // Which filing the summarizer reads. Held per-symbol by the page so picking
  // from the filings archive survives collapsing and reopening the row.
  aiTarget: AiTarget | null; setAiTarget: (t: AiTarget | null) => void
}) {
  const [history, setHistory] = useState<HistoryReport[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)
  const [showTrades, setShowTrades] = useState(false)
  const [barPick, setBarPick] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    setHistory(null); setHistoryLoading(true)
    axios.get('/api/earnings/history', { params: { symbol: row.symbol } })
      .then(r => { if (!cancelled) setHistory(r.data.reports || []) })
      .catch(() => { if (!cancelled) setHistory([]) })
      .finally(() => { if (!cancelled) setHistoryLoading(false) })
    return () => { cancelled = true }
  }, [row.symbol])

  const reported = e?.priorReportDate === row.date && hasReportedFigures(e)
  const det = b?.detail
  const wkPos = b && b.price != null && b.week52Low != null && b.week52High != null && b.week52High > b.week52Low
    ? Math.round(Math.min(Math.max((b.price - b.week52Low) / (b.week52High - b.week52Low), 0), 1) * 100)
    : null
  const ins = insiderDetail90d(b?.insider ?? null)
  const dte = daysUntil(row.date)

  const notReportedExplainer = () => {
    if (e?.priorReportDate === row.date || sourceHasGapAt(e, row.date, today())) {
      return 'This company has reported. Yahoo has not published the EPS figures yet, usually within a day.'
    }
    const mismatch = calendarMismatchDate(e, row.date, today())
    if (mismatch) {
      return mismatch < row.date
        ? `This calendar date doesn't match the confirmed report — yfinance shows it already reported on ${fmtDate(mismatch)}${e?.surprisePct != null ? ` (${fmtPct(e.surprisePct)} surprise)` : ''}.`
        : `This calendar date doesn't match the confirmed report — yfinance shows the next report on ${fmtDate(mismatch)}.`
    }
    if (row.date < today()) {
      return e?.priorReportDate
        ? `No confirmed figures for this date yet. The ticker's last confirmed report was ${fmtDate(e.priorReportDate)}${e.surprisePct != null ? ` (${fmtPct(e.surprisePct)} surprise)` : ''}.`
        : 'No confirmed figures for this date yet.'
    }
    return e?.priorReportDate
      ? `Not yet reported. Last report was ${fmtDate(e.priorReportDate)}${e.surprisePct != null ? ` (${fmtPct(e.surprisePct)} surprise)` : ''}.`
      : 'No report history available for this ticker.'
  }

  const held = position && position.shares > 0
  const picked = barPick != null && history ? history[barPick] : null
  // Expanding a row kicks off its book fetch, so these panels open empty. A
  // dash there reads as "no data"; a skeleton reads as "still coming".
  const hubPending = !b?.loaded
  const extrasPending = !b?.extrasLoaded

  return (
    <div style={{ padding: isMobile ? '14px 14px 18px' : '16px 18px 20px', display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* THE REPORT — the expanded row is as wide as the table, so this reads
          across rather than down a 300px column. */}
      <div>
        <span style={sectionLabel}>The Report</span>
        <Band cols={isMobile ? 2 : 6}>
          <BandCell label="Report date" sub={dte != null ? (dte >= 0 ? `in ${dte}d` : `${Math.abs(dte)}d ago`) : undefined} subColor={C.gold}
            after={<HourChip hour={row.hour} />}>
            {fmtFullDate(row.date)}
          </BandCell>
          <BandCell label="EPS estimate" sub={det?.epsPriorYear != null ? `vs ${fmtEps(det.epsPriorYear)} yr ago` : undefined}>
            {row.epsEstimate == null && extrasPending ? <Skeleton w={62} h={13} /> : fmtEps(row.epsEstimate ?? det?.epsEst ?? null)}
          </BandCell>
          <BandCell label="Revenue estimate" sub={det?.revEst != null ? 'consensus' : undefined}>
            {extrasPending ? <Skeleton w={72} h={13} /> : fmtRev(det?.revEst ?? null)}
          </BandCell>
          <BandCell label="Implied move" color={e?.impliedMove != null ? C.gold : C.dim}
            sub={e?.impliedMove == null ? 'no chain spanning' : e?.impliedMoveExpiry ? `by ${e.impliedMoveExpiry}` : undefined}>
            {e?.impliedMove != null ? `${e.impliedMove.toFixed(1)}%` : '—'}
          </BandCell>
          <BandCell label="Hist. move" sub={det?.histAvgMovePct != null ? 'last reports' : undefined}>
            {extrasPending ? <Skeleton w={62} h={13} /> : det?.histAvgMovePct != null ? `±${det.histAvgMovePct.toFixed(1)}%` : '—'}
          </BandCell>
          {reported ? (
            <BandCell label="Result" sub={e?.reactionPct != null ? `${fmtPct(e.reactionPct)} 1-day` : undefined}
              subColor={pctColor(e?.reactionPct)}>
              <BeatMissBadge surprisePct={e!.surprisePct} />
            </BandCell>
          ) : (
            <BandCell label="Beat rate" color={det?.beatRatePct != null ? C.pos : C.dim}
              sub={det?.beatRatePct != null ? 'beat consensus' : undefined}>
              {extrasPending ? <Skeleton w={54} h={13} /> : det?.beatRatePct != null ? `${det.beatRatePct}%` : '—'}
            </BandCell>
          )}
        </Band>
        {reported ? (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 9, fontFamily: C.sans, fontSize: 11, color: C.muted }}>
            <span>Move since report <span style={{ fontFamily: C.mono, color: pctColor(e?.runSincePct) }}>{fmtPct(e?.runSincePct)}</span></span>
          </div>
        ) : (
          <div style={{ fontFamily: C.sans, fontSize: 11, color: C.muted, lineHeight: 1.55, marginTop: 9 }}>
            {notReportedExplainer()}
          </div>
        )}
      </div>

      {/* POSITIONING */}
      {(b || hubPending) && (
        <div>
          <span style={sectionLabel}>Positioning</span>
          <Band cols={isMobile ? 2 : 4}>
            <BandCell label="Analyst consensus" size={14.5} color={b?.consensus ? CONSENSUS_COLOR[b.consensus] ?? C.text : C.dim}>
              {hubPending ? <Skeleton w={92} h={13} /> : b?.consensus ?? '—'}
            </BandCell>
            <BandCell label="Forward P/E" size={14.5}>
              {hubPending ? <Skeleton w={62} h={13} /> : b?.pe != null ? `${b.pe.toFixed(2)}x` : '—'}
            </BandCell>
            <BandCell label="Short % of float" size={14.5}>
              {extrasPending ? <Skeleton w={62} h={13} /> : b?.shortPct != null ? `${b.shortPct.toFixed(1)}%` : '—'}
            </BandCell>
            <BandCell label="1-day move" size={14.5} color={pctColor(b?.pctChange)}>
              {hubPending ? <Skeleton w={62} h={13} /> : b?.pctChange != null ? fmtPct(b.pctChange) : '—'}
            </BandCell>
            <BandCell label="Your position" size={14.5} color={held ? C.text : C.dim}>
              {held ? `${position!.shares.toLocaleString()} sh` : '—'}
            </BandCell>
            <BandCell label="Market value" size={14.5} color={pos.value != null ? C.text : C.dim}>
              {pos.value != null ? fmtMoney(pos.value) : '—'}
            </BandCell>
            <BandCell label="Unrealized P&L" size={14.5} color={pos.pnl != null ? pctColor(pos.pnlPct) : C.dim}
              sub={pos.pnlPct != null ? fmtPct(pos.pnlPct) : undefined} subColor={pctColor(pos.pnlPct)}>
              {pos.pnl != null ? fmtMoney(pos.pnl) : '—'}
            </BandCell>
            <BandCell label="Cost basis" size={14.5} color={held && position!.avgCost ? C.text : C.dim}>
              {held && position!.avgCost ? fmtMoney(position!.avgCost) : '—'}
            </BandCell>

            <BandCell label="52-week range" span={2} plain
              headerRight={<span style={{ fontFamily: C.mono, fontWeight: 700, fontSize: 9, color: C.muted }}>{wkPos != null ? `${wkPos}% of range` : '—'}</span>}>
              <div style={{ position: 'relative', height: 5, marginTop: 4, background: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 11%, transparent)' }}>
                {wkPos != null && <span style={{ position: 'absolute', top: -2, left: `${wkPos}%`, width: 2, height: 9, background: C.gold }} />}
              </div>
            </BandCell>
            <BandCell label="Insider 90d" span={2} plain>
              {extrasPending
                ? <Skeleton w={150} h={11} mt={3} />
                : <span style={{ fontFamily: C.sans, fontSize: 11, color: ins.color }}>{ins.text}</span>}
              {(b?.insider?.length ?? 0) > 0 && (
                <button onClick={() => setShowTrades(v => !v)} style={{
                  marginLeft: 10, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                  fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
                  color: showTrades ? C.gold : C.muted,
                }}>{showTrades ? 'Hide trades' : 'View trades'}</button>
              )}
            </BandCell>
          </Band>
          {showTrades && b?.insider && b.insider.length > 0 && <InsiderTable txs={b.insider} />}
        </div>
      )}

      {/* Track record · price · wire */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={{ ...panel, flex: '1.6 1 320px' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
            <span style={{ ...LABEL, display: 'inline' }}>Last 5 reports · est vs actual</span>
            {history && history.length > 0 && (
              <span style={{ fontFamily: C.sans, fontSize: 9, color: C.dim }}>click a quarter to summarize it</span>
            )}
          </div>
          {historyLoading ? (
            <div aria-label="Loading report history" style={{ height: 140, display: 'flex', alignItems: 'flex-end', gap: 10, padding: '0 4px' }}>
              {[46, 62, 38, 54, 30, 48, 58, 70, 42, 66].map((h, i) => (
                <span key={i} style={{ ...shimmer, display: 'block', flex: 1, width: 'auto', height: `${h}%`, borderRadius: 0 }} />
              ))}
            </div>
          ) : history && history.length ? (
            <EstActualBars reports={history} picked={barPick} onPick={i => setBarPick(p => (p === i ? null : i))} />
          ) : (
            <div style={{ fontFamily: C.sans, fontSize: 11, color: C.muted, padding: '8px 0' }}>No report history available.</div>
          )}
          {/* In flow, not floated — an absolute popover here covered Positioning. */}
          {picked && (
            <div style={{ marginTop: 12, border: `1px solid ${gold(34)}`, background: gold(5) }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, padding: '7px 12px', borderBottom: `1px solid ${gold(16)}` }}>
                <span style={{ fontFamily: C.mono, fontSize: 11.5, fontWeight: 700, color: C.gold }}>
                  {fmtQuarterLabel(picked.date)} · reported {fmtDate(picked.date)}
                </span>
                <button onClick={() => setBarPick(null)} style={ghostBtn}>Close</button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', padding: '10px 12px' }}>
                <Pair label="Estimate" value={fmtEps(picked.estimate)} />
                <Pair label="Actual" value={fmtEps(picked.actual)} />
                <Pair label="Surprise" value={picked.surprisePct != null ? fmtPct(picked.surprisePct) : '—'}
                  color={picked.surprisePct == null ? C.text : picked.surprisePct >= 0 ? C.pos : C.neg} />
                <button
                  onClick={() => { setAiTarget({ form: '10-Q', period: fmtQuarterLabel(picked.date), filed: picked.date }); setBarPick(null) }}
                  style={{ ...goldBtn, marginLeft: 'auto' }}>Summarize with AI</button>
              </div>
            </div>
          )}
        </div>

        <div style={{ ...panel, flex: '1 1 200px', display: 'flex', flexDirection: 'column' }}>
          <span style={{ ...LABEL, marginBottom: 10 }}>Recent price · 30d</span>
          <div style={{ flex: 1, minHeight: 112, position: 'relative' }}>
            {hubPending
              ? <Skeleton h={112} />
              : b && b.sparkline.length > 1
                ? <Sparkline data={b.sparkline} positive={(b.pctChange ?? 0) >= 0} fill />
                : <span style={{
                    position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                    fontFamily: C.sans, fontSize: 11, color: C.dim,
                  }}>No price series for this symbol.</span>}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, borderTop: `1px solid ${C.borderFaint}`, marginTop: 10, paddingTop: 9 }}>
            <span style={{ ...LABEL, display: 'inline' }}>1-day move</span>
            {hubPending
              ? <Skeleton w={54} h={12} />
              : <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, color: pctColor(b?.pctChange) }}>
                  {b?.pctChange != null ? fmtPct(b.pctChange) : '—'}
                </span>}
          </div>
        </div>

        <div style={{ ...panel, flex: '1.3 1 240px' }}>
          <span style={{ ...LABEL, marginBottom: 10 }}>{row.symbol} wire</span>
          {hubPending ? (
            <SkeletonLines n={4} h={11} gap={12} widths={['100%', '78%', '100%', '64%']} />
          ) : b && b.news.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              {b.news.map((n, i) => (
                <div key={i}>
                  <a href={safeUrl(n.link)} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'block', fontFamily: C.sans, fontWeight: 600, fontSize: 11.5, lineHeight: 1.35, color: C.gold, textDecoration: 'none' }}>
                    {n.title}
                  </a>
                  <div style={{ fontFamily: C.sans, fontSize: 9.5, color: C.dim, marginTop: 2 }}>Source: {n.publisher}</div>
                </div>
              ))}
            </div>
          ) : (
            <span style={{ fontFamily: C.sans, fontSize: 11, color: C.dim }}>No wire items for this name.</span>
          )}
        </div>
      </div>

      {/* The deep dive: the AI filing summary for this one name */}
      <SummarySection ticker={row.symbol} state={summary} aiTarget={aiTarget}
        onFetch={() => onFetchSummary(aiTarget?.filed)} onClearTarget={() => setAiTarget(null)}
        onPickFiling={f => setAiTarget({ form: f.form, period: f.date.slice(0, 7), filed: f.date })} />
    </div>
  )
}

const sectionLabel: React.CSSProperties = { ...LABEL, color: C.gold, marginBottom: 8 }
const panel: React.CSSProperties = {
  border: `1px solid ${C.border}`, background: C.bg, padding: '12px 14px 14px', minWidth: 0,
}
const ghostBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
  fontFamily: C.sans, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: C.dim,
}
const goldBtn: React.CSSProperties = {
  background: C.gold, border: 'none', color: C.header, cursor: 'pointer',
  fontFamily: C.sans, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', padding: '7px 14px', whiteSpace: 'nowrap',
}

function Pair({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 7 }}>
      <span style={{ fontFamily: C.sans, fontSize: 11, color: C.muted }}>{label}</span>
      <span style={{ fontFamily: C.mono, fontSize: 11, fontWeight: 700, color: color ?? C.text }}>{value}</span>
    </span>
  )
}

// The 1px grid gap over a border-coloured ground IS the cell divider — one rule
// instead of per-cell borders that double up at the seams.
function Band({ cols, children }: { cols: number; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
      gap: 1, background: C.border, border: `1px solid ${C.border}`,
    }}>{children}</div>
  )
}

function BandCell({ label, children, sub, subColor, color, span, size, plain, after, headerRight }: {
  label: string; children: React.ReactNode
  sub?: string; subColor?: string; color?: string; span?: number; size?: number
  plain?: boolean   // free-form body (a bar, a sentence) instead of a big number
  after?: React.ReactNode
  headerRight?: React.ReactNode
}) {
  return (
    <div style={{
      gridColumn: span ? `span ${span}` : undefined,
      background: C.bg, padding: '8px 12px 9px', minWidth: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <span style={{ ...LABEL, fontSize: 8.5, display: 'inline' }}>{label}</span>
        {headerRight}
      </div>
      {plain ? children : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{
            fontFamily: C.mono, fontSize: size ?? 15, fontWeight: 700, color: color ?? C.text,
            fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{children}</span>
          {after}
        </div>
      )}
      {sub && <div style={{ fontFamily: C.mono, fontSize: 10.5, color: subColor ?? C.dim, marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

function MetricTile({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div style={{ minWidth: 0, padding: '11px 18px 14px', borderRight: `1px solid ${C.border}` }}>
      <div style={{ ...LABEL, marginBottom: 7 }}>{label}</div>
      <div style={{ fontFamily: C.mono, fontSize: 21, fontWeight: 700, color: C.text, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ fontFamily: C.mono, fontSize: 10, color: subColor ?? C.muted, marginTop: 7, fontVariantNumeric: 'tabular-nums' }}>{sub}</div>}
    </div>
  )
}

function MetricStrip({ m }: { m: Metrics }) {
  const tiles: React.ReactNode[] = []
  if (m.eps) tiles.push(<MetricTile key="eps" label="EPS" value={m.eps.value} sub={m.eps.yoy ? `${m.eps.yoy} YoY` : undefined} subColor={signColor(m.eps.yoy)} />)
  if (m.revenue) tiles.push(<MetricTile key="revenue" label="Revenue" value={m.revenue.value} sub={m.revenue.yoy ? `${m.revenue.yoy} YoY` : undefined} subColor={signColor(m.revenue.yoy)} />)
  if (m.rev_yoy) {
    const slowing = m.rev_yoy.prior && Number.parseFloat(m.rev_yoy.value) < Number.parseFloat(m.rev_yoy.prior)
    tiles.push(<MetricTile key="growth" label="Revenue Growth" value={m.rev_yoy.value} sub={m.rev_yoy.prior ? `${slowing ? 'slowing from' : 'from'} ${m.rev_yoy.prior}` : undefined} subColor={slowing ? C.warn : signColor(m.rev_yoy.value)} />)
  }
  if (m.gross_margin) {
    const delta = m.gross_margin.delta_bps
    const flat = delta != null && Math.abs(delta) < 5
    const sub = delta == null ? undefined
      : flat ? `flat, ${delta >= 0 ? '+' : ''}${delta} bps ${m.gross_margin.basis ?? ''}`
      : `${delta >= 0 ? '+' : ''}${delta} bps ${m.gross_margin.basis ?? ''}`
    tiles.push(<MetricTile key="margin" label="Gross Margin" value={m.gross_margin.value} sub={sub?.trim()} subColor={flat || delta == null ? C.muted : delta > 0 ? C.pos : C.neg} />)
  }
  if (!tiles.length) return null
  return (
    <div style={{ borderBottom: `1px solid ${C.border}` }}>
      <div style={{ padding: '10px 18px 4px', ...LABEL, color: C.gold }}>Snapshot</div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}>{tiles}</div>
    </div>
  )
}

function surpriseLabel(value?: string | null): string {
  if (!value) return '—'
  const numeric = Number.parseFloat(value.replace(/[−+,%]/g, ''))
  if (!Number.isFinite(numeric) || Math.abs(numeric) < 0.1) return 'In line'
  return numeric > 0 ? `beat ${value}` : `miss ${value}`
}

function ReportedVsConsensus({ metrics }: { metrics: ReportedMetric[] }) {
  if (!metrics.length) return null
  return (
    <section>
      <div style={{ padding: '1px 0 9px', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ ...LABEL, display: 'inline', color: C.gold }}>Reported Results vs Consensus</span>
        <span style={{ fontFamily: C.mono, fontSize: 9, color: C.dim }}>Consensus = Wall Street expectation ahead of the report. Surprise = actual vs expectation.</span>
      </div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.border}` }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1fr 0.85fr', minWidth: 560, background: 'color-mix(in srgb, var(--theme-surface, #0d1826) 62%, transparent)' }}>
          {['Metric', 'Consensus', 'Actual', 'Surprise', 'YoY'].map((column, index) => (
            <div key={column} style={{ ...LABEL, fontSize: 8, padding: '7px 12px', color: index === 2 ? C.gold : C.dim, textAlign: index === 0 ? 'left' : 'right' }}>{column}</div>
          ))}
          {metrics.map(metric => {
            const varianceText = metric.variance_pct ?? metric.variance
            const varianceColor = signColor(varianceText)
            return (
              <div key={metric.name} style={{ display: 'contents' }}>
                <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, fontFamily: C.sans, fontSize: 10, fontWeight: 700, color: C.muted }}>{metric.name}</div>
                <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, fontFamily: C.mono, fontSize: 10, color: C.muted, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{metric.estimate ?? '—'}</div>
                <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: C.text, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{metric.actual}</div>
                <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, fontFamily: C.mono, fontSize: 10, fontWeight: 700, color: varianceText ? varianceColor : C.dim, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{surpriseLabel(varianceText)}</div>
                <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, fontFamily: C.mono, fontSize: 11, color: metric.yoy ? signColor(metric.yoy) : C.dim, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{metric.yoy ?? '—'}</div>
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}

function SegmentBars({ segments }: { segments: Segment[] }) {
  const max = Math.max(...segments.map(s => s.value), 1)
  return (
    <div>
      <div style={{ ...LABEL, marginBottom: 10 }}>Segment Revenue</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {segments.map(s => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.muted, width: 96, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={s.name}>{s.name}</span>
            <div style={{ flex: 1, height: 9, background: C.header, border: `1px solid ${C.border}` }}>
              <div style={{ width: `${Math.max(2, (s.value / max) * 100)}%`, height: '100%', background: C.blue }} />
            </div>
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.text, width: 56, flexShrink: 0, textAlign: 'right' }}>{fmtB(s.value)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Pill({ label, color = C.muted }: { label: string; color?: string }) {
  return <span style={{ fontFamily: C.sans, fontSize: 9, color, background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`, padding: '2px 7px', whiteSpace: 'nowrap' }}>{label}</span>
}

function SummarySection({ ticker, state, onFetch, aiTarget, onClearTarget, onPickFiling }: {
  ticker: string; state: SummaryState | null; onFetch: () => void
  aiTarget?: AiTarget | null; onClearTarget?: () => void
  onPickFiling: (f: Filing) => void
}) {
  // The archive lives here, on the control that says which filing gets read,
  // rather than on the company name — the ticker already owns a click.
  const [filings, setFilings] = useState<Filing[] | 'loading' | 'error' | undefined>()
  const [pickerOpen, setPickerOpen] = useState(false)

  const openPicker = () => {
    setPickerOpen(o => !o)
    if (Array.isArray(filings)) return
    setFilings('loading')
    axios.get(`/api/filings/filings/${ticker}`)
      .then(r => setFilings(r.data.filings ?? []))
      .catch(() => setFilings('error'))
  }

  useEffect(() => {
    if (!pickerOpen) return
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') setPickerOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickerOpen])

  const running = !!state && !state.result && !state.error
  const result = state?.result
  const s = result?.summary

  return (
    <div style={{ borderTop: `1px solid ${gold(24)}`, paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ ...LABEL, display: 'inline', color: C.gold }}>AI Filing Summary</span>
        {!state && (
          <button onClick={onFetch} style={{
            background: C.gold, border: 'none', color: C.header, cursor: 'pointer',
            fontFamily: C.sans, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
            padding: '7px 14px',
          }}>FETCH SUMMARY</button>
        )}
        {running && (
          <EmptyState variant="loading" size="compact" title={`${state!.stage} (${state!.pct}%)`} progress={state!.pct} />
        )}
        {state && !running && (
          <button onClick={onFetch} style={{
            background: 'transparent', border: `1px solid ${C.border}`, color: C.muted, cursor: 'pointer',
            fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
            padding: '6px 12px',
          }}>Re-run</button>
        )}
        {/* Which filing FETCH SUMMARY will read — and where you change it. */}
        <span style={{
          display: 'inline-flex', alignItems: 'baseline', gap: 8,
          border: `1px solid ${gold(34)}`, background: gold(6), padding: '6px 11px',
        }}>
          <span style={{ ...LABEL, fontSize: 8, display: 'inline' }}>Source</span>
          <button onClick={openPicker} aria-expanded={pickerOpen}
            title={`Pick which ${ticker} filing the summary reads`}
            style={{
              background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
              fontFamily: C.mono, fontSize: 11, fontWeight: 700, color: C.gold,
              textDecoration: 'underline', textUnderlineOffset: 3,
              textDecorationColor: gold(45),
            }}>
            {aiTarget
              ? `${aiTarget.form} · ${aiTarget.period} · filed ${fmtDate(aiTarget.filed)}`
              : 'Latest 10-Q'}
            <span style={{ marginLeft: 6, fontSize: 9 }}>{pickerOpen ? '▲' : '▼'}</span>
          </button>
          {aiTarget && onClearTarget && (
            <button onClick={onClearTarget} style={ghostBtn} title="Back to the latest 10-Q">Reset</button>
          )}
        </span>
      </div>

      {/* In flow, not floated — the table scroll container clips a popover. */}
      {pickerOpen && (
        <div style={{ marginTop: 10, maxWidth: 420 }}>
          <FilingsArchive
            symbol={ticker}
            filings={filings}
            onClose={() => setPickerOpen(false)}
            onPick={f => { onPickFiling(f); setPickerOpen(false) }}
            style={{ position: 'static', width: '100%' }}
          />
        </div>
      )}

      {!state && (
        <p style={{ margin: '9px 0 0', fontFamily: C.sans, fontSize: 11, color: C.muted, lineHeight: 1.55, maxWidth: 620 }}>
          Reads {ticker}'s latest 10-Q and earnings commentary, then returns the verdict, bull and bear
          case, reported results against consensus, guidance, and management tone.
        </p>
      )}

      {state?.error && (
        <div style={{ marginTop: 10, fontFamily: C.sans, fontSize: 11, color: C.neg }}>{state.error}</div>
      )}

      {result && s && (
        <div style={{ marginTop: 12, border: `1px solid ${C.border}`, background: C.bg }}>
          <div style={{ background: C.header, borderBottom: `1px solid ${C.border}`, padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: C.text }}>{result.ticker}</span>
                {result.company && <span style={{ fontFamily: C.sans, fontSize: 11.5, color: C.muted }}>{result.company}</span>}
              </div>
              <div style={{ fontFamily: C.mono, fontSize: 9.5, color: C.dim, marginTop: 3 }}>
                {[result.period, result.form && result.filed ? `${result.form} · filed ${result.filed}` : null].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'flex-start', gap: 20, flexShrink: 0 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ ...LABEL, fontSize: 8, marginBottom: 3 }}>Tone</div>
                <div style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, lineHeight: 1, color: s.management_tone && s.management_tone !== 'N/A' ? TONE_COLOR[s.management_tone.toLowerCase()] ?? C.muted : C.dim }}>
                  {s.management_tone && s.management_tone !== 'N/A' ? s.management_tone : 'Not rated'}
                </div>
              </div>
              {result.reaction && (
                <div style={{ textAlign: 'right', borderLeft: `1px solid ${C.border}`, paddingLeft: 20 }}>
                  <div style={{ ...LABEL, fontSize: 8, marginBottom: 3 }}>1-Day Reaction</div>
                  <div style={{ fontFamily: C.mono, fontSize: 15, fontWeight: 700, lineHeight: 1, color: pctColor(result.reaction.pct) }}>
                    {fmtPct(result.reaction.pct)}
                  </div>
                </div>
              )}
            </div>
          </div>

          {result.metrics && <MetricStrip m={result.metrics} />}

          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {result.metrics?.reported_vs_consensus && <ReportedVsConsensus metrics={result.metrics.reported_vs_consensus} />}
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
              <div style={{ flex: '1.5 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <div style={{ ...LABEL, color: C.gold, marginBottom: 8 }}>Verdict</div>
                  <div style={{ fontFamily: C.sans, fontSize: 12.5, color: C.text, lineHeight: 1.6 }}>{s.verdict}</div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <div>
                    <div style={{ ...LABEL, color: C.pos, marginBottom: 6 }}>Bull Case</div>
                    <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {s.bull_points?.map((p, i) => <li key={i} style={{ fontFamily: C.sans, fontSize: 11, color: C.text, lineHeight: 1.5 }}>{p}</li>)}
                    </ul>
                  </div>
                  <div>
                    <div style={{ ...LABEL, color: C.neg, marginBottom: 6 }}>Bear Case</div>
                    <ul style={{ margin: 0, paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {s.bear_points?.map((p, i) => <li key={i} style={{ fontFamily: C.sans, fontSize: 11, color: C.text, lineHeight: 1.5 }}>{p}</li>)}
                    </ul>
                  </div>
                </div>
                {s.key_metrics?.length > 0 && (
                  <div>
                    <div style={{ ...LABEL, marginBottom: 6 }}>Key Metrics</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {s.key_metrics.map((m, i) => (
                        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontFamily: C.sans, fontSize: 11, color: C.text }}>
                          <span style={{ color: C.muted, minWidth: 130 }}>{m.name}</span>
                          <span style={{ fontFamily: C.mono, fontWeight: 700 }}>{m.value}</span>
                          {m.vs_est && <span style={{ fontFamily: C.mono, fontSize: 10, color: signColor(m.vs_est) }}>{m.vs_est} vs est</span>}
                          {m.yoy && <span style={{ fontFamily: C.mono, fontSize: 10, color: signColor(m.yoy) }}>{m.yoy} YoY</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
                {result.segments && result.segments.length > 0 && <SegmentBars segments={result.segments} />}
                {s.guidance && s.guidance !== 'N/A' && (
                  <div style={{ background: C.header, border: `1px solid ${gold(40)}`, padding: '10px 12px' }}>
                    <div style={{ ...LABEL, color: C.gold, marginBottom: 5 }}>Management Guidance</div>
                    <div style={{ fontFamily: C.sans, fontSize: 11, color: C.text, lineHeight: 1.5 }}>{s.guidance}</div>
                  </div>
                )}
                {(s.key_themes?.length > 0 || s.risks?.length > 0) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {s.key_themes?.length > 0 && (
                      <div>
                        <div style={{ ...LABEL, marginBottom: 6 }}>Key Themes</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{s.key_themes.map((t, i) => <Pill key={i} label={t} color={C.blue} />)}</div>
                      </div>
                    )}
                    {s.risks?.length > 0 && (
                      <div>
                        <div style={{ ...LABEL, marginBottom: 6 }}>Risks</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{s.risks.map((r, i) => <Pill key={i} label={r} color={C.warn} />)}</div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {s.analyst_questions_focus && (
              <div style={{ fontFamily: C.sans, fontSize: 10.5, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                <span style={{ color: C.dim, marginRight: 6, textTransform: 'uppercase', fontSize: 9, letterSpacing: '0.1em' }}>Analyst focus:</span>
                {s.analyst_questions_focus}
              </div>
            )}

            {/* This summary's own filing links directly; the archive itself
                lives on the Source control at the top of the section. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {result.url && (
                <a href={safeUrl(result.url)} target="_blank" rel="noopener noreferrer"
                  style={{ fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: C.gold, border: `1px solid ${gold(40)}`, padding: '5px 12px', textDecoration: 'none' }}>
                  View {result.form ?? 'filing'} on SEC →
                </a>
              )}
              <button onClick={() => { if (!pickerOpen) openPicker() }}
                style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.muted, fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '5px 12px', cursor: 'pointer' }}>
                Summarize a different filing
              </button>
            </div>
          </div>
        </div>
      )}

      {result && !s && !state?.error && (
        <div style={{ marginTop: 10, fontFamily: C.sans, fontSize: 11, color: C.muted }}>
          No filing summary available for {ticker}.
        </div>
      )}
    </div>
  )
}

const cell: React.CSSProperties = {
  padding: '10px 14px', textAlign: 'center', fontFamily: C.mono,
  fontSize: 12.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

export default function EarningsScanner() {
  return <PageWrapper title="Earnings Scanner"><EarningsScannerContent /></PageWrapper>
}
