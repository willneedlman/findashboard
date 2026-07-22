import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import axios from 'axios'
import { Star } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import TickerLogo from '../components/TickerLogo'
import TickerLink from '../components/TickerLink'
import ColumnFilterMenu, { type SortState, type FilterSpec } from '../components/ColumnFilterMenu'
import useIsMobile from '../hooks/useIsMobile'
import { usePortfolio } from '../contexts/PortfolioContext'
import { localDateInputValue } from '../lib/time'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip } from '../lib/reportCaptureRegistry'

const C = {
  bg: 'var(--theme-bg, #101c2e)', border: 'var(--theme-border, rgba(255,255,255,0.08))',
  header: 'var(--theme-surface, #0d1826)', surface: 'var(--theme-bg, #101c2e)',
  gold: 'var(--theme-primary, #c9a84c)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-secondary, #5e768f)',
  dim: 'color-mix(in srgb, var(--theme-secondary, #5e768f) 62%, var(--theme-bg, #101c2e))',
  pos: 'var(--theme-positive, #22c55e)', neg: 'var(--theme-negative, #ef4444)', warn: '#f59e0b', blue: 'var(--theme-tertiary, #60a5fa)',
  mono: 'var(--theme-mono)', sans: 'var(--theme-sans)',
}

const LABEL: React.CSSProperties = { fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: C.muted, display: 'block' }

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

// Fallback used only when a row's calendar date never resolves to a real
// Result: checks whether yfinance's own confirmed schedule agrees at all.
// Prefers nextDate (a real future mismatch, e.g. the calendar says today but
// yfinance's own next date is a week out) over a merely-recent past report
// (within 5 days — a company that reported a few days ago on a date the
// calendar mislabeled as today), since the former is the more direct answer
// to "when does this actually report".
function calendarMismatchDate(e: Enriched | undefined, rowDate: string): string | null {
  if (e?.nextDate && e.nextDate !== rowDate) return e.nextDate
  if (e?.reportedEps != null && e?.priorReportDate && e.priorReportDate !== rowDate) {
    const days = Math.abs((new Date(rowDate + 'T00:00:00').getTime() - new Date(e.priorReportDate + 'T00:00:00').getTime()) / 86400000)
    if (days <= 5) return e.priorReportDate
  }
  return null
}

const WINDOWS = [{ label: 'Day', days: 1 }, { label: '3 Days', days: 3 }, { label: 'Week', days: 7 }]
const HOUR_LABEL: Record<string, string> = { bmo: 'Pre', amc: 'Post', dmh: 'Mid' }

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
function fmtDateShort(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}
function fmtQuarterLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  const q = Math.floor(d.getMonth() / 3) + 1
  return `Q${q} '${String(d.getFullYear()).slice(2)}`
}

const shimmer: React.CSSProperties = {
  display: 'inline-block', width: 38, height: 10, borderRadius: 2,
  background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 75%)',
  backgroundSize: '200% 100%', animation: 'ec-shimmer 1.6s infinite',
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
    <span style={{
      fontFamily: C.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
      color, border: `1px solid ${color}`, borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

export function EarningsCalendarContent() {
  const isMobile = useIsMobile()
  const { tickers: watchTickers } = usePortfolio()
  const watchSet = useMemo(() => new Set(watchTickers.map(t => t.toUpperCase())), [watchTickers])

  const [date, setDate] = useState(today())
  const [days, setDays] = useState(1)
  const [rows, setRows] = useState<Row[]>([])
  const [covered, setCovered] = useState(0)
  const [rangeTo, setRangeTo] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [coveredOnly, setCoveredOnly] = useState(true)
  const [watchOnly, setWatchOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [minCapStr, setMinCapStr] = useState('')   // in $B
  const [hourFilter, setHourFilter] = useState('') // '', bmo, amc, dmh
  const [sort, setSort] = useState<SortState>(null) // a user sort flattens the date grouping
  const [detail, setDetail] = useState<Row | null>(null) // row whose result popup is open

  const minCap = (parseFloat(minCapStr) || 0) * 1e9

  const [enriched, setEnriched] = useState<Record<string, Enriched>>({})
  const profilingRef = useRef<Set<string>>(new Set())   // phase 1: cheap name/cap/sector, in flight
  const enrichingRef = useRef<Set<string>>(new Set())   // phase 2: full enrichment, in flight

  // Nothing fetches until Load is clicked — date/window/market-cap are just
  // local params until then. loadIdRef guards against an in-flight request
  // resolving after a newer Load click superseded it.
  const [started, setStarted] = useState(false)
  const loadIdRef = useRef(0)
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
        setRows(r.data.rows || [])
        setCovered(r.data.covered || 0)
        setRangeTo(r.data.to || null)
      })
      .catch(() => { if (loadIdRef.current !== id) return; setError('Could not load the earnings calendar. Try again shortly.') })
      .finally(() => { if (loadIdRef.current === id) setLoading(false) })
  }, [date, days])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    // Alias match only for meaningful queries (avoid "G" matching Google).
    const aliasHits = q.length >= 3
      ? Object.entries(SEARCH_ALIASES).flatMap(([name, syms]) =>
          name.startsWith(q) || q.startsWith(name) || name.includes(q) ? syms : [])
      : []
    const aliasSet = new Set(aliasHits.map(s => s.toUpperCase()))
    return rows.filter(r => {
      if (coveredOnly && r.epsEstimate == null) return false
      if (watchOnly && !watchSet.has(r.symbol.toUpperCase())) return false
      if (hourFilter && r.hour !== hourFilter) return false
      if (q) {
        const sym = r.symbol.toUpperCase()
        const name = (enriched[r.symbol]?.companyName || '').toUpperCase()
        if (
          !sym.includes(q)
          && !name.includes(q)
          && !aliasSet.has(sym)
        ) return false
      }
      return true
    })
  }, [rows, coveredOnly, watchOnly, watchSet, query, hourFilter, enriched])

  // Phase 1 (cheap): name/cap/sector only, for EVERY row, so the market-cap
  // filter can resolve before anything expensive runs.
  // seedOnly (passed by the caller, true whenever a market-cap filter is
  // active): skips the live Finnhub fallback for symbols outside the bundled
  // seed entirely — they resolve instantly with a null cap and are naturally
  // excluded by the filter, instead of paying for a live, rate-limited call
  // to confirm what the filter would exclude anyway. Trade-off: a genuine
  // match outside the curated seed won't show until the filter is cleared
  // and the page reloaded.
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
  const impliedMoveRef = useRef<Set<string>>(new Set())
  // A null result the first time through gets ONE retry after a short delay
  // before it's accepted as final — a transient blip (a busy moment on the
  // shared yfinance semaphore, a brief backend restart) would otherwise get
  // permanently stuck showing "no data" for the rest of the page session,
  // since nothing else ever re-requests a symbol once it's marked loaded.
  const impliedMoveRetriedRef = useRef<Set<string>>(new Set())
  const fetchImpliedMove = useCallback((symbols: string[]) => {
    const fresh = symbols.filter(s => !impliedMoveRef.current.has(s))
    if (!fresh.length) return
    fresh.forEach(s => impliedMoveRef.current.add(s))
    axios.get('/api/earnings/implied-move', { params: { symbols: fresh.join(',') } })
      .then(r => {
        const rows = (r.data.rows || []) as { symbol: string; impliedMove: number | null; impliedMoveExpiry: string | null }[]
        const retry: string[] = []
        setEnriched(prev => {
          const out = { ...prev }
          for (const e of rows) {
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
    const cap = (s: string) => enriched[s]?.marketCap ?? -1
    return [...filtered].sort((a, b) => {
      if ((a.date || '') !== (b.date || '')) return (a.date || '').localeCompare(b.date || '')
      const d = cap(b.symbol) - cap(a.symbol)
      return d !== 0 ? d : a.symbol.localeCompare(b.symbol)
    })
  }, [filtered, enriched])

  // Phase 1: 3 batches of 60 in flight at once for every row, same
  // concurrency reasoning as phase 2 below. 60 matches the backend's own
  // per-request cap (_MAX_ENRICH) — for anything already cache-warm, HTTP
  // round-trip overhead dominates over actual backend work, so fewer/larger
  // requests wins even though total data volume is unchanged.
  // seedOnly follows minCap at fetch time — a cap filter means every row
  // needs *some* profile result before the filter can be treated as final
  // (see phase1Done below), and paying for a live, rate-limited Finnhub call
  // just to confirm a name the filter would exclude anyway is exactly the
  // cost this mode skips.
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
    return sorted.filter(r => { const c = enriched[r.symbol]?.marketCap; return c != null && c >= minCap })
  }, [sorted, enriched, minCap])

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

  // Default groups by date; a user sort flattens to one ordered list (the '' key
  // tells GroupBody to drop the date header).
  const grouped = useMemo<[string, Row[]][]>(() => {
    if (sort) {
      const rank: Record<string, number> = { bmo: 0, dmh: 1, amc: 2 }
      const val = (r: Row): number | string => {
        const e = enriched[r.symbol]
        switch (sort.key) {
          case 'symbol':          return r.symbol
          case 'marketCap':       return e?.marketCap ?? -1
          case 'date':            return r.date || ''
          case 'hour':            return rank[r.hour] ?? 3
          case 'epsEstimate':     return r.epsEstimate ?? -1e18
          case 'impliedMove':     return e?.impliedMove ?? -1
          case 'surprisePct':     return e?.surprisePct ?? -1e18
          case 'reactionPct':     return e?.reactionPct ?? -1e18
          case 'runSincePct':     return e?.runSincePct ?? -1e18
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
  }, [visible, sort, enriched])

  const cols = isMobile
    ? ['Symbol', 'Date', 'Result', 'Impl']
    : ['Symbol', 'Mkt Cap', 'Date', 'Time', 'Est', 'Result', 'Reaction', 'Impl Move']

  // Every column left-aligned, headers and cells alike.
  const colAlign = (_c: string, i: number): 'left' | 'right' | 'center' => {
    return i === 0 ? 'left' : 'center'
  }

  const anyFilter = !!(query || minCapStr || hourFilter || sort)
  const clearFilters = () => { setQuery(''); setMinCapStr(''); setHourFilter(''); setSort(null) }

  useReportCapture(() => {
    if (!visible.length) return null
    const pieces: ClipDraft[] = []
    const windowLabel = days === 1 ? date : `${date} + ${days}d`
    pieces.push(kpiClip('Earnings Scanner', `Earnings Window · ${windowLabel}`, [
      { label: 'Visible', value: String(visible.length), sub: rows.length ? `${rows.length} total loaded` : undefined },
      { label: 'Covered', value: String(covered) },
      { label: 'Window', value: days === 1 ? '1 day' : `${days} days` },
      { label: 'Start', value: date },
    ]))
    pieces.push(tableClip(
      'Earnings Scanner',
      `Earnings Calendar · ${windowLabel}`,
      ['Symbol', 'Company', 'Date', 'Time', 'Mkt Cap', 'Est', 'Result', 'Reaction', 'Impl Move'],
      visible.slice(0, 20).map(r => {
        const e = enriched[r.symbol]
        const reported = e?.priorReportDate === r.date
        return [
          r.symbol,
          e?.companyName ?? null,
          r.date,
          HOUR_LABEL[r.hour] ?? r.hour ?? null,
          e?.marketCap != null ? fmtMoney(e.marketCap) : null,
          fmtEps(r.epsEstimate),
          reported && e?.surprisePct != null ? `${e.surprisePct >= 0 ? 'Beat' : 'Miss'} ${fmtPct(e.surprisePct)}` : null,
          reported ? fmtPct(e?.reactionPct) : null,
          e?.impliedMove != null ? fmtPct(e.impliedMove) : null,
        ]
      }),
    ))
    return pieces
  }, { disabled: !visible.length, sourceTab: 'Earnings Scanner' })

  const SORT_KEY: Record<string, string> = {
    'Symbol': 'symbol', 'Mkt Cap': 'marketCap', 'Date': 'date', 'Time': 'hour', 'Est': 'epsEstimate',
    'Impl Move': 'impliedMove', 'Impl': 'impliedMove',
    'Result': 'surprisePct', 'Reaction': 'reactionPct',
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

  return (
    <>
      <style>{`@keyframes ec-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Controls */}
      <div style={{
        background: C.header, border: `1px solid ${C.border}`, padding: '14px 16px',
        display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16, marginBottom: 14,
      }}>
        <div>
          <label htmlFor="ec-date" style={{ ...LABEL, marginBottom: 5 }}>Date</label>
          <input id="ec-date" type="date" value={date} onChange={e => setDate(e.target.value || today())}
            style={{
              background: C.bg, border: `1px solid ${C.border}`, color: C.text, fontFamily: C.mono,
              fontSize: 13, padding: '7px 10px',
              colorScheme: 'var(--theme-color-scheme, dark)' as React.CSSProperties['colorScheme'],
            }} />
        </div>
        <div>
          <label style={{ ...LABEL, marginBottom: 5 }}>Window</label>
          <div style={{ display: 'flex', border: `1px solid ${C.border}` }}>
            {WINDOWS.map(w => (
              <button
                key={w.days}
                onClick={() => {
                  // Re-anchor to local today when picking a relative window so a
                  // stale date-picker value (e.g. last Monday) cannot exclude
                  // names that report later this week / next week.
                  setDate(today())
                  setDays(w.days)
                }}
                style={{
                  background: days === w.days ? C.gold : 'transparent',
                  color: days === w.days ? C.header : C.muted,
                  border: 'none', borderRight: `1px solid ${C.border}`, cursor: 'pointer',
                  fontFamily: C.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
                  textTransform: 'uppercase', padding: '8px 12px',
                }}>{w.label}</button>
            ))}
          </div>
        </div>
        <div title="Filtered results are matched against a curated list of ~1,000 major US names, IPOs, and large ADRs — a name outside that list won't appear while a cap filter is set, even if it would qualify.">
          <label htmlFor="ec-mincap" style={{ ...LABEL, marginBottom: 5 }}>Market Cap ≥</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, border: `1px solid ${C.border}`, background: C.bg, padding: '0 10px' }}>
            <span style={{ fontFamily: C.mono, fontSize: 12, color: C.muted }}>$</span>
            <input id="ec-mincap" type="number" min={0} step="1" value={minCapStr} onChange={e => setMinCapStr(e.target.value)}
              placeholder="0" style={{
                background: 'transparent', border: 'none', color: C.text, fontFamily: C.mono,
                fontSize: 13, padding: '7px 0', width: 64, outline: 'none',
              }} />
            <span style={{ fontFamily: C.mono, fontSize: 12, color: C.muted }}>B</span>
          </div>
        </div>
        <div style={{ alignSelf: 'flex-end' }}>
          <button
            type="button"
            onClick={loadCalendar}
            disabled={loading}
            title="Fetch the earnings calendar for the parameters above"
            style={{
              background: C.gold, border: 'none', color: C.header, cursor: loading ? 'default' : 'pointer',
              fontFamily: C.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '9px 18px', whiteSpace: 'nowrap', opacity: loading ? 0.6 : 1,
            }}
          >{loading ? 'Loading…' : started ? 'Reload' : 'Load'}</button>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <Toggle label="Covered" active={coveredOnly} onClick={() => setCoveredOnly(v => !v)} />
          {watchSet.size > 0 && (
            <Toggle label="Watchlist" active={watchOnly} onClick={() => setWatchOnly(v => !v)} />
          )}
          {anyFilter && (
            <button onClick={clearFilters} style={{
              background: 'transparent', border: `1px solid ${C.border}`, color: C.muted, cursor: 'pointer',
              fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase',
              padding: '8px 12px', whiteSpace: 'nowrap',
            }}>Clear filters</button>
          )}
        </div>
      </div>

      {/* Summary */}
      {started && !loading && !error && fullyEnriched && (
        <div style={{ fontFamily: C.sans, fontSize: 11, color: C.muted, marginBottom: 10 }}>
          <span style={{ color: C.text, fontWeight: 700 }}>{minCap ? visible.length : filtered.length}</span> {minCap ? 'shown' : 'reporting'}
          {' · '}<span style={{ color: C.text }}>{covered}</span> with estimates
          {sort
            ? <>{' · sorted by '}<span style={{ color: C.text }}>{sort.key}</span> {sort.dir === 'asc' ? '↑' : '↓'}</>
            : <>{' · '}{fmtDate(date)}{days > 1 ? ` → ${fmtDate(rangeTo || grouped[grouped.length - 1]?.[0] || date)}` : ''}</>}
          {days > 1 && (
            <span style={{ color: C.dim }}> · {days} day window</span>
          )}
        </div>
      )}

      {!started && (
        <EmptyState title="Earnings Scanner" hint="Set the date, window, and market cap above, then click Load." action="Load" />
      )}
      {started && !error && (loading || !fullyEnriched) && (
        <EmptyState title="Loading…" variant="loading"
          hint={loading ? 'Fetching the earnings calendar…' : `Enriching companies — ${enrichedCount} / ${visible.length}…`}
          progress={loading ? undefined : (visible.length ? (enrichedCount / visible.length) * 100 : 100)} />
      )}
      {started && error && (
        <EmptyState title="Could Not Load" hint={error} variant="unavailable" onRetry={loadCalendar} />
      )}
      {started && !loading && !error && fullyEnriched && visible.length === 0 && (
        <EmptyState title="No Matches" hint="No companies match. Widen the window or clear filters." />
      )}

      {started && !loading && !error && fullyEnriched && visible.length > 0 && (
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
                <GroupBody key={gdate} gdate={gdate} grows={grows} enriched={enriched}
                  cols={cols.length} isMobile={isMobile} showHeader={!sort && days > 1} watch={watchSet}
                  onRowClick={setDetail} registerRow={registerRow} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {started && !loading && !error && fullyEnriched && visible.length > 0 && (
        <div style={{ fontFamily: C.sans, fontSize: 10, color: C.muted, marginTop: 10, lineHeight: 1.7 }}>
          Impl Move = expected move priced into the ATM straddle of the expiry spanning this report.
          Result/Reaction show once that report is in — Result is last EPS vs estimate, Reaction is the
          stock's one-day move. Click a row for the last 5 reports and full detail. Estimates from finnhub,
          reactions from prior-quarter prices.
        </div>
      )}

      {detail && (
        <EarningsResultModal row={detail} e={enriched[detail.symbol]} onClose={() => setDetail(null)} />
      )}
    </>
  )
}

function GroupBody({ gdate, grows, enriched, cols, isMobile, showHeader, watch, onRowClick, registerRow }: {
  gdate: string; grows: Row[]; enriched: Record<string, Enriched>
  cols: number; isMobile: boolean; showHeader: boolean; watch: Set<string>; onRowClick: (row: Row) => void
  registerRow: (el: HTMLTableRowElement | null, symbol: string) => void
}) {
  return (
    <>
      {showHeader && (
        <tr>
          <td colSpan={cols} style={{
            background: C.bg, padding: '7px 14px', borderBottom: `1px solid ${C.border}`,
            fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
            textTransform: 'uppercase', color: C.gold,
          }}>{fmtDate(gdate)} · {grows.length}</td>
        </tr>
      )}
      {grows.map(r => {
        const e = enriched[r.symbol]
        const pending = !e
        // The report for this exact row's date has landed and matches the
        // ticker's most recently known report, as opposed to an
        // upcoming/not-yet-reported row (the common case).
        const reported = e?.priorReportDate === r.date && e?.reportedEps != null
        // Fallback only: when a row never resolves a Result, check whether
        // yfinance's own confirmed schedule agrees with the calendar's date
        // at all — occasionally it doesn't (the calendar source has the
        // wrong date), and that's a clearer explanation than a bare dash.
        const mismatch = !pending && !reported ? calendarMismatchDate(e, r.date) : null
        return (
          <tr key={r.symbol + r.date} ref={el => registerRow(el, r.symbol)} onClick={() => onRowClick(r)}
            style={{ borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}>
            <td style={{ padding: '10px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                <TickerLogo ticker={r.symbol} size={22} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: C.text, whiteSpace: 'nowrap' }}>
                    <TickerLink ticker={r.symbol} />
                    {watch.has(r.symbol.toUpperCase()) && (
                      <Star size={10} fill={C.gold} stroke={C.gold}
                        style={{ marginLeft: 6, verticalAlign: 'middle', display: 'inline', flexShrink: 0 }}
                        aria-label="on your watchlist" />
                    )}
                  </div>
                  {!isMobile && (
                    <div style={{
                      fontFamily: C.sans, fontSize: 9, color: C.muted, whiteSpace: 'nowrap',
                      overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200,
                    }}>{pending ? '' : (e?.companyName || '—')}</div>
                  )}
                </div>
              </div>
            </td>
            {!isMobile && (
              <td style={{ ...cell, color: C.dim }}>{pending ? <span style={shimmer} /> : fmtMoney(e?.marketCap)}</td>
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
          </tr>
        )
      })}
    </>
  )
}

function DetailRow({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
      <span style={{ ...LABEL, marginBottom: 0 }}>{label}</span>
      <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: color ?? C.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}

interface HistoryReport { date: string; estimate: number | null; actual: number | null; surprisePct: number | null }

// Estimate-vs-actual EPS bars for the last n reports, oldest first — two bars
// per report (muted estimate, colored actual) sharing one scale so a beat/miss
// pattern reads at a glance instead of one column of surprise% figures.
function EstActualBars({ reports }: { reports: HistoryReport[] }) {
  const BAR_H = 110
  const maxAbs = Math.max(0.01, ...reports.flatMap(r => [r.estimate, r.actual].filter((v): v is number => v != null).map(Math.abs)))
  const barHeight = (v: number | null) => v == null ? 0 : Math.max(4, Math.round(Math.abs(v) / maxAbs * BAR_H))
  const valueLabel: React.CSSProperties = {
    fontFamily: C.mono, fontSize: 10, marginBottom: 5, whiteSpace: 'nowrap',
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end', height: BAR_H + 22, padding: '2px 2px 0' }}>
        {reports.map(r => (
          <div key={r.date} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', height: BAR_H + 22 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                <span style={{ ...valueLabel, color: C.muted }}>{fmtEps(r.estimate)}</span>
                <div title={`Estimate ${fmtEps(r.estimate)}`} style={{ width: 18, height: barHeight(r.estimate), background: C.muted, opacity: 0.5, borderRadius: '2px 2px 0 0' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                <span style={{ ...valueLabel, color: C.gold }}>{fmtEps(r.actual)}</span>
                <div title={`Actual ${fmtEps(r.actual)}`} style={{ width: 18, height: barHeight(r.actual), borderRadius: '2px 2px 0 0', background: C.gold }} />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 20 }}>
        {reports.map(r => (
          <div key={r.date} style={{
            flex: 1, minWidth: 0, textAlign: 'center', fontFamily: C.sans, fontSize: 10.5, color: C.muted,
            marginTop: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{fmtQuarterLabel(r.date)}</div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 14, fontFamily: C.sans, fontSize: 10, color: C.muted }}>
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

function EarningsResultModal({ row, e, onClose }: { row: Row; e?: Enriched; onClose: () => void }) {
  const [history, setHistory] = useState<HistoryReport[] | null>(null)
  const [historyLoading, setHistoryLoading] = useState(true)

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let cancelled = false
    setHistory(null); setHistoryLoading(true)
    axios.get('/api/earnings/history', { params: { symbol: row.symbol } })
      .then(r => { if (!cancelled) setHistory(r.data.reports || []) })
      .catch(() => { if (!cancelled) setHistory([]) })
      .finally(() => { if (!cancelled) setHistoryLoading(false) })
    return () => { cancelled = true }
  }, [row.symbol])

  const reported = e?.priorReportDate === row.date && e?.reportedEps != null

  return (
    <div onClick={onClose} role="dialog" aria-modal="true" aria-label={`${row.symbol} earnings detail`}
      style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={ev => ev.stopPropagation()}
        style={{ width: 'min(780px, 95vw)', background: C.header, border: `1px solid ${C.border}`, boxShadow: '0 24px 70px rgba(0,0,0,0.55)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px', borderBottom: `1px solid ${C.border}` }}>
          <TickerLogo ticker={row.symbol} size={22} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: C.text }}>
              <TickerLink ticker={row.symbol} caret={false} />
            </div>
            <div style={{ fontFamily: C.sans, fontSize: 9, color: C.muted }}>{e?.companyName || '—'}</div>
          </div>
          <button onClick={onClose} aria-label="Close"
            style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', fontFamily: C.mono, fontSize: 18, lineHeight: 1, color: C.muted, padding: '0 2px' }}>×</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap' }}>
          <div style={{ width: 240, flexShrink: 0, padding: '4px 16px 16px', borderRight: `1px solid ${C.border}` }}>
            <DetailRow label={`Report · ${fmtDate(row.date)}`} value={<HourChip hour={row.hour} />} />
            <DetailRow label="EPS Estimate" value={fmtEps(row.epsEstimate)} />
            <DetailRow label="Implied Move"
              value={e?.impliedMove != null ? `${e.impliedMove.toFixed(1)}%` : '—'} color={C.gold} />
            {reported ? (
              <>
                <DetailRow label="Result" value={<BeatMissBadge surprisePct={e!.surprisePct} />} />
                <DetailRow label="1-Day Reaction" value={fmtPct(e!.reactionPct)} color={pctColor(e!.reactionPct)} />
                <DetailRow label="Move Since Report" value={fmtPct(e!.runSincePct)} color={pctColor(e!.runSincePct)} />
              </>
            ) : (
              <div style={{ fontFamily: C.sans, fontSize: 11, color: C.muted, padding: '10px 0' }}>
                {(() => {
                  const mismatch = calendarMismatchDate(e, row.date)
                  if (mismatch) {
                    return mismatch < row.date
                      ? `This calendar date doesn't match the confirmed report — yfinance shows it already reported on ${fmtDate(mismatch)}${e?.surprisePct != null ? ` (${fmtPct(e.surprisePct)} surprise)` : ''}.`
                      : `This calendar date doesn't match the confirmed report — yfinance shows the next report on ${fmtDate(mismatch)}.`
                  }
                  return e?.priorReportDate
                    ? `Not yet reported. Last report was ${fmtDate(e.priorReportDate)}${e.surprisePct != null ? ` (${fmtPct(e.surprisePct)} surprise)` : ''}.`
                    : 'No report history available for this ticker.'
                })()}
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 280, padding: '16px 20px' }}>
            <span style={{ ...LABEL, marginBottom: 12 }}>Last 5 Reports · Est vs Actual</span>
            {historyLoading ? (
              <div style={{ height: 150, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <span style={shimmer} />
              </div>
            ) : history && history.length ? (
              <EstActualBars reports={history} />
            ) : (
              <div style={{ fontFamily: C.sans, fontSize: 11, color: C.muted, padding: '8px 0' }}>No report history available.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const cell: React.CSSProperties = {
  padding: '10px 14px', textAlign: 'center', fontFamily: C.mono,
  fontSize: 12.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
}

function Toggle({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={active} style={{
      background: active ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
      border: `1px solid ${active ? C.gold : C.border}`, color: active ? C.gold : C.muted,
      cursor: 'pointer', fontFamily: C.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
      textTransform: 'uppercase', padding: '8px 12px', whiteSpace: 'nowrap',
    }}>{label}</button>
  )
}


export default function EarningsCalendar() {
  return <PageWrapper title="Earnings Scanner"><EarningsCalendarContent /></PageWrapper>
}
