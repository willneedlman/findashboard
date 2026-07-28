import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import UniversePicker from '../components/UniversePicker'
import { useState, useEffect, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import axios from 'axios'
import TickerLogo from '../components/TickerLogo'
import { fmtMarketCap } from '../lib/format'
import useIsMobile from '../hooks/useIsMobile'
import { readPMBooks, normalizeTicker } from '../lib/pmImport'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, textClip } from '../lib/reportCaptureRegistry'

interface TickerRow {
  ticker: string; name: string
  date: string; horizon: string
  pe: number | null
  pctChange: number | null
  marketCap: number | null
  consensus: string | null
  price: number | null; week52Low: number | null; week52High: number | null
  news: { title: string; link: string; publisher: string }[]
  sparkline: number[]
}

interface ShortRow { display: string; raw: number | null }

interface InsiderTx {
  date: string; insider: string; title: string; transaction: string
  side: 'buy' | 'sell' | 'neutral'; shares: number; value: number
}

interface EarnDetail {
  reportTiming: string | null
  epsEst: number | null; epsPriorYear: number | null; revEst: number | null
  histAvgMovePct: number | null; beatRatePct: number | null
}

type SortKey = 'proximity' | 'implied' | 'short' | 'move'
type WindowKey = 'all' | '14d' | '30d' | '60d'
type MenuKey = 'sort' | 'window' | 'add' | null

const TIMEOUT = 10_000
const WL_KEY = 'pe_wl'

// Handoff hexes are the fallbacks so custom themes restyle the page coherently.
const GOLD    = 'var(--theme-primary, #c9a84c)'
const TEXT    = 'var(--theme-text, #dbe6f7)'
const TEXT2   = 'color-mix(in srgb, var(--theme-text, #dbe6f7) 88%, transparent)'
const MUTED   = 'var(--theme-secondary, #8ba0b8)'
const FAINT   = 'color-mix(in srgb, var(--theme-secondary, #8ba0b8) 72%, transparent)'
const DIM     = 'color-mix(in srgb, var(--theme-secondary, #8ba0b8) 60%, transparent)'
const POS     = 'var(--theme-positive, #46c88f)'
const NEG     = 'var(--theme-negative, #e0655a)'
const BLUE    = 'var(--theme-tertiary, #6aa8f0)'
// The design wants the panel darker than the cards on it; --theme-surface is
// the darker tier and --theme-bg the lighter one, so panel=surface, card=bg.
const PANEL   = 'var(--theme-surface, #0a1424)'
const SURFACE = 'var(--theme-bg, #0d1826)'
const NEWS_GOLD = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 82%, white)'
const HAIRLINE  = 'color-mix(in srgb, var(--theme-text, #dbe6f7) 7%, transparent)'
const TRACK     = 'color-mix(in srgb, var(--theme-text, #dbe6f7) 11%, transparent)'
const MONO    = 'var(--theme-mono)'
const SANS    = 'var(--theme-sans)'
const gold = (pct: number) => `color-mix(in srgb, var(--theme-primary, #c9a84c) ${pct}%, transparent)`

const TIERS = [
  { id: 'IMMINENT',       sub: 'Within 2 weeks', color: '#e6cf7a', max: 14 },
  { id: 'APPROACHING',    sub: 'This month',     color: '#c9a84c', max: 30 },
  { id: 'ON THE HORIZON', sub: 'Next 45 days',   color: '#a99163', max: 60 },
  { id: 'LATER',          sub: 'Beyond 60 days', color: '#6f88a4', max: Infinity },
]
const tierOf = (days: number | null) =>
  days == null ? TIERS[3] : TIERS.find(t => days <= t.max) ?? TIERS[3]

const SORT_LABEL: Record<SortKey, string> = {
  proximity: 'Proximity', implied: 'Implied move', short: 'Short interest', move: '1-Day move',
}
const RANKED_TITLE: Record<Exclude<SortKey, 'proximity'>, string> = {
  implied: 'BY IMPLIED MOVE', short: 'BY SHORT INTEREST', move: 'BY 1-DAY MOVE',
}
const WINDOW_LABEL: Record<WindowKey, string> = { all: 'All', '14d': '14 days', '30d': '30 days', '60d': '60 days' }
const WINDOW_LIMIT: Record<WindowKey, number> = { all: Infinity, '14d': 14, '30d': 30, '60d': 60 }

const CONSENSUS_COLOR: Record<string, string> = {
  'Strong Buy': 'var(--theme-positive-strong, #4fd39a)',
  'Moderate Buy': '#8fc98f',
  'Hold': '#a99f86',
  'Underperform': 'var(--theme-negative, #e0655a)',
}

const LABEL: React.CSSProperties = { fontFamily: MONO, fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: FAINT }
const MENU: React.CSSProperties = { position: 'absolute', zIndex: 50, background: SURFACE, border: `1px solid ${gold(34)}`, borderRadius: 4, boxShadow: '0 12px 30px rgba(0,0,0,0.5)', padding: 5, minWidth: 148 }
const MENU_ITEM: React.CSSProperties = { display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', padding: '7px 9px', borderRadius: 3, fontFamily: MONO, fontSize: 10, fontWeight: 700 }

function safeUrl(url: string): string {
  try {
    const u = new URL(url)
    return ['https:', 'http:'].includes(u.protocol) ? url : '#'
  } catch { return '#' }
}

function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  if (!data || data.length < 2) return <div style={{ width: 94, height: 24 }} />
  const min = Math.min(...data), max = Math.max(...data)
  const range = max - min || 1
  const pts = data.map((v, i) =>
    `${(i / (data.length - 1) * 100).toFixed(1)},${(25 - ((v - min) / range) * 24 + 0.5).toFixed(1)}`
  ).join(' ')
  return (
    <svg width={94} height={24} viewBox="0 0 100 26" preserveAspectRatio="none" style={{ display: 'block', flexShrink: 0 }}>
      <polyline points={pts} fill="none" stroke={positive ? POS : NEG} strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  )
}

async function fetchTicker(tk: string): Promise<TickerRow> {
  try {
    const { data: d } = await axios.get(`/api/corporate/hub?ticker=${tk}`, { timeout: TIMEOUT })
    return {
      ticker: tk, name: d.company_name || tk, date: d.date || '—', horizon: d.horizon || '—',
      pe: (d.forward_pe || d.estimated_pe || 0) > 0 ? (d.forward_pe || d.estimated_pe) : null,
      pctChange: d.pct_change_1d ?? null, marketCap: d.market_cap ?? null,
      consensus: d.consensus ?? null,
      price: d.current_price || null, week52Low: d.fifty_two_week_low || null, week52High: d.fifty_two_week_high || null,
      sparkline: d.sparkline ?? [],
      news: (d.news || []).slice(0, 2).map((n: any) => ({
        title: n.title || 'Market Update', link: n.link || '#', publisher: n.publisher || 'Financial Wire',
      })),
    }
  } catch {
    return { ticker: tk, name: tk, date: '—', horizon: '—', pe: null,
             pctChange: null, marketCap: null, consensus: null, price: null, week52Low: null,
             week52High: null, news: [], sparkline: [] }
  }
}

async function fetchImplied(ts: string[]): Promise<Record<string, number | null>> {
  try {
    const { data } = await axios.get(`/api/corporate/hub/implied?tickers=${ts.join(',')}`, { timeout: 90_000 })
    return data.implied || {}
  } catch {
    return Object.fromEntries(ts.map(t => [t, null]))
  }
}

async function fetchShortTicker(tk: string): Promise<[string, ShortRow]> {
  try {
    const { data: d } = await axios.get(`/api/corporate/hub/short?ticker=${tk}`, { timeout: TIMEOUT })
    const raw = d.shortPercentOfFloat != null ? d.shortPercentOfFloat * 100 : null
    return [tk, { display: raw != null ? `${raw.toFixed(1)}%` : '—', raw }]
  } catch {
    return [tk, { display: '—', raw: null }]
  }
}

async function fetchInsiderTicker(tk: string): Promise<[string, InsiderTx[]]> {
  try {
    const { data: d } = await axios.get(`/api/corporate/hub/insider?ticker=${tk}`, { timeout: 15_000 })
    return [tk, d.transactions || []]
  } catch {
    return [tk, []]
  }
}

const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }
const parseDate = (s: string) => { if (!s || s === '—') return null; const d = new Date(`${s}T00:00:00`); return isNaN(+d) ? null : d }
const daysToEvent = (s: string) => { const d = parseDate(s); return d ? Math.round((+d - +today0()) / 86_400_000) : null }
const fmtMonthDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const fmtFullDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const fmtRev = (n: number | null) => n == null ? '—' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`
const pctStr = (p: number | null) => p == null ? '—' : `${p >= 0 ? '+' : '−'}${Math.abs(p).toFixed(2)}%`
const pctTone = (p: number | null) => p == null ? FAINT : p >= 0 ? POS : NEG

export function PortfolioEarningsContent() {
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()

  const [watchlist, setWatchlistRaw] = useState<string[]>(() => {
    const raw = searchParams.get('tickers')
    if (raw) return raw.split(',').map(t => t.trim().toUpperCase()).filter(Boolean)
    return []
  })
  const setWatchlist = (ts: string[]) => {
    setWatchlistRaw(ts)
    try { localStorage.setItem(WL_KEY, JSON.stringify(ts)) } catch { /* quota */ }
    setSearchParams(p => { p.set('tickers', ts.join(',')); return p }, { replace: true })
  }

  const [sort, setSort] = useState<SortKey>('proximity')
  const [windowKey, setWindowKey] = useState<WindowKey>('all')
  const [openMenu, setOpenMenu] = useState<MenuKey>(null)
  // Re-read PM books each time the add menu opens so renames/new books show up.
  const pmBooks = useMemo(
    () => readPMBooks().filter(p => p.holdings.some(h => h.ticker && h.shares)),
    [openMenu],
  )
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [showTrades, setShowTrades] = useState<Record<string, boolean>>({})

  const [rows, setRows] = useState<TickerRow[]>([])
  const [shortData, setShortData] = useState<Record<string, ShortRow>>({})
  const [impliedData, setImpliedData] = useState<Record<string, number | null>>({})
  const [impliedPending, setImpliedPending] = useState(false)
  const [insiderData, setInsiderData] = useState<Record<string, InsiderTx[]>>({})
  const [details, setDetails] = useState<Record<string, EarnDetail | 'loading' | 'error'>>({})
  const [isPending, setIsPending] = useState(false)
  const [insiderPending, setInsiderPending] = useState(false)
  const [asOf, setAsOf] = useState<Date | null>(null)

  const [aiBrief, setAiBrief] = useState<{ bullets: string[]; tone: string } | null>(null)
  const [aiBriefPending, setAiBriefPending] = useState(false)
  const [aiBriefError, setAiBriefError] = useState<string | null>(null)

  const [addQuery, setAddQuery] = useState('')
  const [addResults, setAddResults] = useState<{ ticker: string; name: string }[]>([])
  const addInputRef = useRef<HTMLInputElement>(null)
  const hasMounted = useRef(false)

  // Rows merge instead of replacing so an add that resolves while a full scan
  // is in flight is not clobbered; display filters rows to the live watchlist.
  const loadTickers = async (ts: string[], fullScan: boolean) => {
    if (ts.length === 0) { if (fullScan) { setRows([]); setAsOf(new Date()) }; return }
    if (fullScan) setIsPending(true)
    const [main] = await Promise.all([
      Promise.all(ts.map(fetchTicker)),
      (async () => {
        const pairs = await Promise.all(ts.map(fetchShortTicker))
        setShortData(prev => ({ ...prev, ...Object.fromEntries(pairs) }))
      })(),
    ])
    setRows(prev => [...prev.filter(r => !ts.includes(r.ticker)), ...main])
    if (fullScan) setIsPending(false)
    setAsOf(new Date())
    setInsiderPending(true)
    setImpliedPending(true)
    await Promise.all([
      (async () => {
        const pairs = await Promise.all(ts.map(fetchInsiderTicker))
        setInsiderData(prev => ({ ...prev, ...Object.fromEntries(pairs) }))
        setInsiderPending(false)
      })(),
      (async () => {
        const implied = await fetchImplied(ts)
        setImpliedData(prev => ({ ...prev, ...implied }))
        setImpliedPending(false)
      })(),
    ])
  }

  useEffect(() => {
    if (hasMounted.current) return
    hasMounted.current = true
    loadTickers(watchlist, true)
  }, []) // eslint-disable-line

  useEffect(() => {
    if (openMenu !== 'add') { setAddQuery(''); setAddResults([]) }
    else addInputRef.current?.focus()
    if (!openMenu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openMenu])

  useEffect(() => {
    const q = addQuery.trim()
    if (q.length < 2) { setAddResults([]); return }
    const t = setTimeout(async () => {
      try {
        const { data } = await axios.get(`/api/corporate/search?q=${encodeURIComponent(q)}`, { timeout: 8000 })
        setAddResults((data.results || []).slice(0, 8))
      } catch { setAddResults([]) }
    }, 250)
    return () => clearTimeout(t)
  }, [addQuery])

  const addTicker = (tk: string) => {
    const sym = tk.trim().toUpperCase()
    if (!sym || watchlist.includes(sym)) { setOpenMenu(null); return }
    setWatchlist([...watchlist, sym])
    setOpenMenu(null)
    loadTickers([sym], false)
  }
  const removeTicker = (tk: string) => setWatchlist(watchlist.filter(t => t !== tk))
  const importPmBook = (bookId: string) => {
    const book = pmBooks.find(b => b.id === bookId)
    if (!book) return
    const seen = new Set<string>()
    const tickers: string[] = []
    for (const h of book.holdings) {
      const sym = normalizeTicker(h.ticker)
      if (!sym || sym === 'CASH' || seen.has(sym)) continue
      seen.add(sym)
      tickers.push(sym)
    }
    setOpenMenu(null)
    if (tickers.length === 0) return
    setWatchlist(tickers)
    loadTickers(tickers, true)
  }

  const toggleExpand = (tk: string) => {
    setExpanded(p => ({ ...p, [tk]: !p[tk] }))
    if (!details[tk]) {
      setDetails(p => ({ ...p, [tk]: 'loading' }))
      axios.get(`/api/corporate/hub/earnings-detail?ticker=${tk}`, { timeout: 20_000 })
        .then(({ data }) => setDetails(p => ({ ...p, [tk]: data })))
        .catch(() => setDetails(p => ({ ...p, [tk]: 'error' })))
    }
  }

  const fetchAiBrief = async () => {
    if (items.length === 0) return
    setAiBriefPending(true)
    setAiBriefError(null)
    try {
      const payload = {
        tickers: items.map(({ r }) => r.ticker),
        rows: items.map(({ r, days }) => ({
          ticker: r.ticker, daysToReport: days, impliedMove: impliedData[r.ticker] ?? null,
          shortPct: shortData[r.ticker]?.display ?? null,
          pctChange: r.pctChange, marketCap: r.marketCap, consensus: r.consensus, pe: r.pe,
          news: (r.news ?? []).slice(0, 2).map(n => ({ title: n.title })),
        })),
      }
      const { data: res } = await axios.post('/api/ai/corporate-brief', payload)
      if (res.bullets?.length) setAiBrief(res)
      else setAiBriefError('Unexpected response from AI')
    } catch (err: any) {
      const msg = err?.response?.data?.detail ?? err?.message ?? 'Request failed'
      setAiBriefError(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }
    setAiBriefPending(false)
  }

  const limit = WINDOW_LIMIT[windowKey]
  const items = useMemo(() => {
    const withDays = rows.filter(r => watchlist.includes(r.ticker)).map(r => ({ r, days: daysToEvent(r.date) }))
    return withDays.filter(({ days }) => windowKey === 'all' || (days != null && days <= limit))
  }, [rows, watchlist, windowKey, limit])

  const buckets = useMemo(() => {
    if (sort === 'proximity') {
      return TIERS.map(tier => ({
        title: tier.id, sub: tier.sub, color: tier.color,
        items: items
          .filter(({ days }) => tierOf(days) === tier)
          .sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity)),
      })).filter(b => b.items.length > 0)
    }
    const sortValue = ({ r }: { r: TickerRow }) =>
      sort === 'implied' ? (impliedData[r.ticker] ?? -1)
      : sort === 'short' ? (shortData[r.ticker]?.raw ?? -1)
      : r.pctChange == null ? -1 : Math.abs(r.pctChange)
    return [{
      title: RANKED_TITLE[sort], sub: 'Ranked', color: '#c9a84c',
      items: [...items].sort((a, b) => sortValue(b) - sortValue(a)),
    }]
  }, [items, sort, shortData, impliedData])

  const TAB = 'Portfolio Earnings'
  useReportCapture(() => {
    if (!items.length) return null
    const imminent = items.filter(({ days }) => days != null && days <= 14).length
    const withImpl = items.filter(({ r }) => impliedData[r.ticker] != null)
    const avgImpl = withImpl.length
      ? withImpl.reduce((s, { r }) => s + (impliedData[r.ticker] ?? 0), 0) / withImpl.length
      : null
    const pieces: ClipDraft[] = [
      kpiClip(TAB, 'Earnings Watchlist', [
        { label: 'Names', value: String(items.length) },
        { label: 'Within 14d', value: String(imminent) },
        { label: 'Avg Impl. Move', value: avgImpl != null ? `${avgImpl.toFixed(1)}%` : '—' },
        { label: 'Sort', value: SORT_LABEL[sort] },
        { label: 'Window', value: WINDOW_LABEL[windowKey] },
      ]),
      tableClip(TAB, 'Upcoming Reports',
        ['Ticker', 'Date', 'Days', '1D %', 'Impl. Move', 'Short %', 'P/E', 'Mkt Cap', 'Consensus'],
        items.slice(0, 20).map(({ r, days }) => [
          r.ticker,
          r.date || '—',
          days != null ? days : null,
          r.pctChange != null ? +r.pctChange.toFixed(2) : null,
          impliedData[r.ticker] != null ? +Number(impliedData[r.ticker]).toFixed(2) : null,
          shortData[r.ticker]?.display ?? null,
          r.pe != null ? +r.pe.toFixed(1) : null,
          r.marketCap != null ? Math.round(r.marketCap) : null,
          r.consensus || '—',
        ]),
      ),
    ]
    if (aiBrief?.bullets?.length) {
      pieces.push(textClip(TAB, 'AI Brief', aiBrief.bullets.map(b => `• ${b}`).join('\n')))
    }
    return pieces
  }, { disabled: !items.length, sourceTab: TAB })

  const wireGroups = useMemo(() =>
    [...items].sort((a, b) => (a.days ?? Infinity) - (b.days ?? Infinity))
      .filter(({ r }) => r.news.length > 0),
  [items])

  const insiderSummary = (tk: string): { label: string; color: string } => {
    const txs = insiderData[tk]
    if (!txs || txs.length === 0) return { label: insiderPending ? '…' : 'No data', color: FAINT }
    const side = txs.map(x => x.side).find(s => s !== 'neutral')
    if (!side) return { label: 'Activity', color: TEXT }
    return side === 'sell' ? { label: 'Sale', color: NEG } : { label: 'Purchase', color: POS }
  }

  const insiderDetail90d = (tk: string): { text: string; color: string } => {
    const txs = insiderData[tk] || []
    const cutoff = Date.now() - 90 * 86_400_000
    const recent = txs.filter(t => { const d = new Date(`${t.date}T00:00:00`); return !isNaN(+d) && +d >= cutoff })
    if (recent.length === 0) return { text: 'No Form 4 activity filed (90d)', color: FAINT }
    const sales = recent.filter(t => t.side === 'sell')
    const buys = recent.filter(t => t.side === 'buy')
    const sold = sales.length >= buys.length
    const set = sold ? sales : buys
    if (set.length === 0) return { text: `${recent.length} Form 4 filing${recent.length > 1 ? 's' : ''} (90d)`, color: FAINT }
    const value = set.reduce((s, t) => s + (t.value || 0), 0)
    const n = new Set(set.map(t => t.insider)).size
    const last = set[0]
    const lastDate = parseDate(last.date)
    const who = last.title ? last.title.replace(/^Officer\s*/i, '') : 'insider'
    return {
      text: `${n} insider${n > 1 ? 's' : ''} ${sold ? 'sold' : 'bought'} $${(value / 1e6).toFixed(1)}M · last ${who}${lastDate ? `, ${fmtMonthDay(lastDate)}` : ''}`,
      color: sold ? NEG : POS,
    }
  }

  const metric = (label: string, node: React.ReactNode) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={LABEL}>{label}</span>
      {node}
    </div>
  )
  const mVal = (v: string, color = TEXT) => (
    <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color, whiteSpace: 'nowrap' }}>{v}</span>
  )
  const xLabel: React.CSSProperties = { ...LABEL, marginBottom: 4, display: 'block' }
  const detailOf = (tk: string): EarnDetail | null => {
    const d = details[tk]
    return d && d !== 'loading' && d !== 'error' ? d : null
  }

  const pill = (menu: Exclude<MenuKey, null>, label: string, value: string) => (
    <button className="pe-pill" onClick={() => setOpenMenu(openMenu === menu ? null : menu)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: MUTED, border: `1px solid ${gold(22)}`, background: SURFACE, padding: '6px 11px', borderRadius: 3, cursor: 'pointer' }}>
      <span style={{ color: DIM }}>{label}</span>
      <span style={{ textTransform: 'uppercase' }}>{value}</span>
      <span style={{ color: GOLD, fontSize: 8 }}>▾</span>
    </button>
  )

  const menuList = <K extends string>(current: K, entries: [K, string][], onPick: (k: K) => void) => (
    <div style={{ ...MENU, top: 'calc(100% + 5px)', right: 0 }}>
      {entries.map(([k, label]) => (
        <button key={k} className="pe-menu-item" onClick={() => { onPick(k); setOpenMenu(null) }}
          style={{ ...MENU_ITEM, color: k === current ? GOLD : MUTED, display: 'flex', justifyContent: 'space-between', gap: 14 }}>
          {label}{k === current && <span style={{ color: GOLD }}>✓</span>}
        </button>
      ))}
    </div>
  )

  const addSuggestions = addResults.filter(r => !watchlist.includes(r.ticker)).slice(0, 6)
  const nHoldings = watchlist.length
  const asOfStr = asOf
    ? `${String(asOf.getUTCHours()).padStart(2, '0')}:${String(asOf.getUTCMinutes()).padStart(2, '0')} UTC`
    : '…'

  return (
    <div style={{ width: '100%' }}>
      <style>{`
        @keyframes pe-spin { to { transform: rotate(360deg) } }
        @keyframes pe-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.4 } }
        .pe-spinner { animation: pe-spin 0.7s linear infinite; }
        .pe-loading-text { animation: pe-pulse 1.1s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .pe-spinner, .pe-loading-text { animation: none; }
        }
        .pe-card { transition: border-color 0.12s; }
        .pe-card:hover { border-top-color: ${gold(34)}; border-right-color: ${gold(34)}; border-bottom-color: ${gold(34)}; }
        .pe-chip-x { background: transparent; border: none; cursor: pointer; transition: color 0.1s, background 0.1s; }
        .pe-chip-x:hover { color: #e0655a !important; background: rgba(224,101,90,0.14); }
        .pe-add:hover { color: var(--theme-primary, #c9a84c) !important; border-color: var(--theme-primary, #c9a84c) !important; }
        .pe-menu-item:hover { background: ${gold(10)}; }
        .pe-news-title { transition: color 0.1s; }
        .pe-news-title:hover { color: color-mix(in srgb, var(--theme-primary, #c9a84c) 62%, white) !important; }
      `}</style>

      <div style={{ background: PANEL, border: `1px solid ${gold(22)}`, borderRadius: 0, padding: isMobile ? '18px 16px 24px' : '24px 26px 30px', position: 'relative' }}>

        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', paddingBottom: 14, marginBottom: 15, borderBottom: `1px solid ${gold(40)}` }}>
          <div>
            <h2 style={{ margin: 0, fontFamily: MONO, fontWeight: 700, fontSize: 16, letterSpacing: '0.24em', color: GOLD }}>PORTFOLIO EARNINGS</h2>
            <p style={{ margin: '7px 0 0', fontFamily: MONO, fontSize: 10, letterSpacing: '0.02em', color: FAINT }}>
              Your holdings, counting down to their next report · valuation, positioning & the wire in one pass
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: MONO, fontSize: 9.5, letterSpacing: '0.12em', textTransform: 'uppercase', color: DIM }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: POS, boxShadow: `0 0 8px ${POS}` }} />
            {isPending ? 'SCANNING…' : `${nHoldings} holdings · As of ${asOfStr}`}
          </div>
        </div>

        {/* Toolbar row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap', marginBottom: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
            <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 8.5, letterSpacing: '0.12em', color: DIM, marginRight: 3 }}>WATCHLIST</span>
            {watchlist.map(tk => (
              <span key={tk} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: MONO, fontWeight: 700, fontSize: 9.5, letterSpacing: '0.05em', color: MUTED, border: `1px solid ${gold(22)}`, background: gold(5), padding: '3px 4px 3px 7px', borderRadius: 3 }}>
                {tk}
                <button className="pe-chip-x" onClick={() => removeTicker(tk)} title="Remove"
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 13, height: 13, borderRadius: 2, color: FAINT, fontSize: 11, lineHeight: 1, padding: 0 }}>×</button>
              </span>
            ))}
            <span style={{ position: 'relative' }}>
              <button className="pe-add" onClick={() => setOpenMenu(openMenu === 'add' ? null : 'add')}
                style={{ fontFamily: MONO, fontWeight: 700, fontSize: 9.5, letterSpacing: '0.06em', color: MUTED, border: `1px dashed ${gold(34)}`, background: 'transparent', padding: '3px 9px', borderRadius: 3, cursor: 'pointer' }}>+ ADD</button>
              {openMenu === 'add' && (
                <div style={{ ...MENU, top: 'calc(100% + 5px)', left: 0, minWidth: 230 }}>
                  <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 8, letterSpacing: '0.12em', color: DIM, padding: '6px 8px 5px' }}>ADD A HOLDING</div>
                  <input ref={addInputRef} value={addQuery}
                    onChange={e => setAddQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addTicker(addSuggestions[0]?.ticker ?? addQuery) }}
                    placeholder="Ticker or company"
                    style={{ width: '100%', boxSizing: 'border-box', margin: '0 0 4px', background: PANEL, border: `1px solid ${gold(22)}`, borderRadius: 3, color: TEXT, fontFamily: MONO, fontSize: 11, padding: '6px 8px', outline: 'none' }} />
                  {addSuggestions.map(r => (
                    <button key={r.ticker} className="pe-menu-item" onClick={() => addTicker(r.ticker)}
                      style={{ ...MENU_ITEM, display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 8px' }}>
                      <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 11, color: GOLD, minWidth: 44 }}>{r.ticker}</span>
                      <span style={{ fontFamily: SANS, fontWeight: 400, fontSize: 10.5, color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                    </button>
                  ))}
                  {addQuery.trim().length >= 2 && addSuggestions.length === 0 && (
                    <div style={{ fontFamily: SANS, fontSize: 10.5, color: FAINT, padding: '6px 8px' }}>Press Enter to add "{addQuery.trim().toUpperCase()}"</div>
                  )}
                  {pmBooks.length > 0 && (
                    <div style={{ borderTop: `1px solid ${HAIRLINE}`, marginTop: 4, paddingTop: 4 }}>
                      <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 8, letterSpacing: '0.12em', color: DIM, padding: '6px 8px 4px' }}>
                        IMPORT FROM PORTFOLIO MANAGER
                      </div>
                      {pmBooks.map(b => {
                        const n = new Set(
                          b.holdings
                            .map(h => normalizeTicker(h.ticker))
                            .filter(t => t && t !== 'CASH'),
                        ).size
                        return (
                          <button
                            key={b.id}
                            className="pe-menu-item"
                            onClick={() => importPmBook(b.id)}
                            style={{ ...MENU_ITEM, color: MUTED, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}
                          >
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                            <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT, flexShrink: 0 }}>{n}</span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </span>
            <UniversePicker
              mode="tickers"
              onImportTickers={list => {
                const fresh = list.filter(t => !watchlist.includes(t))
                if (fresh.length === 0) return
                setWatchlist([...watchlist, ...fresh])
                loadTickers(fresh, false)
              }}
              style={{ fontFamily: MONO, fontWeight: 700, fontSize: 9.5, letterSpacing: '0.05em', padding: '4px 9px' }}
            />
          </div>

          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <span style={{ position: 'relative' }}>
              {pill('sort', 'SORT', SORT_LABEL[sort])}
              {openMenu === 'sort' && menuList(sort, (Object.entries(SORT_LABEL) as [SortKey, string][]), setSort)}
            </span>
            <span style={{ position: 'relative' }}>
              {pill('window', 'WINDOW', WINDOW_LABEL[windowKey])}
              {openMenu === 'window' && menuList(windowKey, (Object.entries(WINDOW_LABEL) as [WindowKey, string][]), setWindowKey)}
            </span>
          </div>
        </div>

        {openMenu && <div onClick={() => setOpenMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />}

        {/* Main grid */}
        {!isPending && rows.length === 0 ? (
          <EmptyState title="Portfolio Earnings" hint="Add holdings or import your portfolio to monitor upcoming earnings, positioning and the wire."
            kpis={['Next Report', 'Implied Move', 'Short Interest', 'Consensus', 'Market Cap']}
            preview="table" previewLabel="Earnings Watchlist" columns={['Ticker', 'Report Date', 'Implied Move', 'Consensus']} />
        ) : (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 356px', gap: 24, alignItems: 'start' }}>

          {/* Agenda */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
            {buckets.map(bucket => (
              <div key={bucket.title}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, paddingBottom: 9, borderBottom: `1px solid ${gold(24)}` }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: bucket.color, boxShadow: `0 0 8px ${bucket.color}`, flexShrink: 0 }} />
                  <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 11, letterSpacing: '0.18em', color: bucket.color }}>{bucket.title}</span>
                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: FAINT }}>{bucket.sub} · {bucket.items.length}</span>
                  <span style={{ flex: 1, height: 1, background: HAIRLINE }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                  {bucket.items.map(({ r, days }) => {
                    const tier = tierOf(days)
                    const d = parseDate(r.date)
                    const isOpen = expanded[r.ticker]
                    const det = detailOf(r.ticker)
                    const detLoading = details[r.ticker] === 'loading'
                    const ins = insiderSummary(r.ticker)
                    const insDetail = isOpen ? insiderDetail90d(r.ticker) : null
                    const s = shortData[r.ticker]
                    const wkPos = isOpen && r.price != null && r.week52Low != null && r.week52High != null && r.week52High > r.week52Low
                      ? Math.round(Math.min(Math.max((r.price - r.week52Low) / (r.week52High - r.week52Low), 0), 1) * 100)
                      : null
                    return (
                      <div key={r.ticker} className="pe-card"
                        style={{ background: SURFACE, border: `1px solid ${gold(14)}`, borderLeft: `2px solid ${tier.color}`, borderRadius: 4, padding: '13px 16px 12px' }}>
                        <div onClick={() => toggleExpand(r.ticker)} style={{ display: 'flex', alignItems: 'center', gap: 16, cursor: 'pointer' }}>
                          <div style={{ width: 70, flexShrink: 0 }}>
                            <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 26, lineHeight: 1, color: tier.color }}>{days == null ? '—' : `${days}d`}</div>
                            <div style={{ fontFamily: MONO, fontSize: 10, color: MUTED, marginTop: 4 }}>{d ? fmtMonthDay(d) : 'Unscheduled'}</div>
                            <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 8.5, letterSpacing: '0.1em', color: BLUE, marginTop: 2 }}>{r.horizon}</div>
                          </div>
                          <div style={{ width: 1, alignSelf: 'stretch', background: HAIRLINE, flexShrink: 0 }} />
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                            <TickerLogo ticker={r.ticker} />
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 14, color: GOLD }}>{r.ticker}</div>
                              <div style={{ fontFamily: SANS, fontSize: 11, color: MUTED, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                            </div>
                          </div>
                          {!isMobile && <Sparkline data={r.sparkline} positive={(r.pctChange ?? 0) >= 0} />}
                          {r.consensus
                            ? <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: CONSENSUS_COLOR[r.consensus] ?? MUTED, border: `1px solid ${CONSENSUS_COLOR[r.consensus] ?? MUTED}`, padding: '4px 8px', borderRadius: 3, whiteSpace: 'nowrap', flexShrink: 0 }}>{r.consensus}</span>
                            : <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT, flexShrink: 0 }}>{isPending ? '…' : '—'}</span>}
                          <span style={{ fontFamily: MONO, fontSize: 12, color: isOpen ? GOLD : DIM, transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s', flexShrink: 0 }}>▸</span>
                        </div>

                        <div style={{ display: 'flex', gap: isMobile ? 18 : 28, flexWrap: 'wrap', marginTop: 12, paddingTop: 11, borderTop: `1px solid ${HAIRLINE}` }}>
                          {metric('IMPLIED', (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                              <span style={{ width: 44, height: 4, background: TRACK, borderRadius: 2, overflow: 'hidden', flexShrink: 0 }}>
                                <span style={{ display: 'block', width: `${Math.min((impliedData[r.ticker] ?? 0) / 9 * 100, 100)}%`, height: '100%', background: BLUE }} />
                              </span>
                              {mVal(impliedData[r.ticker] != null ? `${impliedData[r.ticker]!.toFixed(1)}%`
                                : impliedPending && !(r.ticker in impliedData) ? '…' : '—')}
                            </span>
                          ))}
                          {metric('1D', mVal(pctStr(r.pctChange), pctTone(r.pctChange)))}
                          {metric('MKT CAP', mVal(fmtMarketCap(r.marketCap)))}
                          {metric('FWD P/E', mVal(r.pe != null ? `${r.pe.toFixed(2)}x` : '—'))}
                          {metric('SHORT %', mVal(s?.display ?? '…'))}
                          {metric('INSIDER', <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: ins.color }}>{ins.label}</span>)}
                        </div>

                        {isOpen && (
                          <div style={{ marginTop: 13, paddingTop: 13, borderTop: `1px dashed ${gold(22)}` }}>
                            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, auto)', gap: '14px 20px', justifyContent: 'start' }}>
                              <div>
                                <span style={xLabel}>REPORT DATE</span>
                                <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 500, color: TEXT2 }}>
                                  {d ? fmtFullDate(d) : '—'}{det?.reportTiming ? ` · ${det.reportTiming}` : ''}
                                </span>
                              </div>
                              <div>
                                <span style={xLabel}>EPS EST</span>
                                <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: TEXT }}>
                                  {detLoading ? '…' : det?.epsEst != null ? `$${det.epsEst.toFixed(2)}` : '—'}
                                  {det?.epsPriorYear != null && <span style={{ fontWeight: 400, color: FAINT }}> vs ${det.epsPriorYear.toFixed(2)} yr</span>}
                                </span>
                              </div>
                              <div>
                                <span style={xLabel}>REV EST</span>
                                <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: TEXT }}>{detLoading ? '…' : fmtRev(det?.revEst ?? null)}</span>
                              </div>
                              <div>
                                <span style={xLabel}>HIST. MOVE · BEAT</span>
                                <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: TEXT }}>
                                  {detLoading ? '…' : det?.histAvgMovePct != null ? `±${det.histAvgMovePct.toFixed(1)}%` : '—'}
                                  {det?.beatRatePct != null && <> · <span style={{ color: 'var(--theme-positive-strong, #4fd39a)' }}>{det.beatRatePct}% beat</span></>}
                                </span>
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 14, alignItems: 'flex-end' }}>
                              <div style={{ flex: 1, minWidth: 200 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 }}>
                                  <span style={LABEL}>52-WEEK RANGE</span>
                                  <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 9, color: MUTED }}>{wkPos != null ? `${wkPos}% of range` : '—'}</span>
                                </div>
                                <div style={{ position: 'relative', height: 5, background: TRACK, borderRadius: 3 }}>
                                  {wkPos != null && <span style={{ position: 'absolute', top: -2, left: `${wkPos}%`, width: 2, height: 9, background: GOLD }} />}
                                </div>
                              </div>
                              <div style={{ minWidth: 200 }}>
                                <span style={xLabel}>INSIDER 90D</span>
                                <span style={{ fontFamily: SANS, fontSize: 11, color: insiderPending ? FAINT : insDetail?.color }}>
                                  {insiderPending ? '…' : insDetail?.text}
                                </span>
                                {(insiderData[r.ticker]?.length ?? 0) > 0 && (
                                  <button onClick={() => setShowTrades(p => ({ ...p, [r.ticker]: !p[r.ticker] }))}
                                    style={{ display: 'block', marginTop: 6, background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, fontFamily: MONO, fontWeight: 700, fontSize: 8.5, letterSpacing: '0.1em', color: showTrades[r.ticker] ? GOLD : MUTED }}>
                                    {showTrades[r.ticker] ? 'HIDE TRADES ▾' : 'VIEW TRADES ▸'}
                                  </button>
                                )}
                              </div>
                            </div>
                            {showTrades[r.ticker] && (insiderData[r.ticker]?.length ?? 0) > 0 && (
                              <div style={{ marginTop: 12, maxHeight: 230, overflowY: 'auto', border: `1px solid ${HAIRLINE}`, borderRadius: 3 }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                                  <thead>
                                    <tr>
                                      {['DATE', 'INSIDER', 'TITLE', 'TYPE', 'SHARES', 'VALUE'].map((h, i) => (
                                        <th key={h} style={{ ...LABEL, textAlign: i >= 4 ? 'right' : 'left', padding: '6px 8px', borderBottom: `1px solid ${HAIRLINE}`, position: 'sticky', top: 0, background: SURFACE }}>{h}</th>
                                      ))}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {insiderData[r.ticker].map((tx, i) => {
                                      const kind = tx.side === 'sell' ? 'Sale' : tx.side === 'buy' ? 'Purchase' : null
                                      return (
                                        <tr key={i}>
                                          <td style={{ fontFamily: MONO, fontSize: 10, color: MUTED, padding: '5px 8px', borderBottom: `1px solid ${HAIRLINE}`, whiteSpace: 'nowrap' }}>{tx.date}</td>
                                          <td style={{ fontFamily: SANS, fontSize: 10.5, color: TEXT2, padding: '5px 8px', borderBottom: `1px solid ${HAIRLINE}` }}>{tx.insider}</td>
                                          <td style={{ fontFamily: SANS, fontSize: 10, color: FAINT, padding: '5px 8px', borderBottom: `1px solid ${HAIRLINE}` }}>{tx.title || '—'}</td>
                                          <td style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: kind === 'Sale' ? NEG : kind === 'Purchase' ? POS : MUTED, padding: '5px 8px', borderBottom: `1px solid ${HAIRLINE}`, whiteSpace: 'nowrap' }}>{kind ?? (tx.transaction || 'Other')}</td>
                                          <td style={{ fontFamily: MONO, fontSize: 10, color: TEXT, textAlign: 'right', padding: '5px 8px', borderBottom: `1px solid ${HAIRLINE}`, whiteSpace: 'nowrap' }}>{tx.shares > 0 ? tx.shares.toLocaleString() : '—'}</td>
                                          <td style={{ fontFamily: MONO, fontSize: 10, color: TEXT, textAlign: 'right', padding: '5px 8px', borderBottom: `1px solid ${HAIRLINE}`, whiteSpace: 'nowrap' }}>{tx.value > 0 ? `$${(tx.value / 1e6).toFixed(2)}M` : '—'}</td>
                                        </tr>
                                      )
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
            {buckets.length === 0 && (
              <div style={{ padding: 40, textAlign: 'center', fontFamily: MONO, fontSize: 11, color: FAINT, border: `1px dashed ${gold(20)}`, borderRadius: 4 }}>
                {isPending ? 'SCANNING…' : 'No holdings report within this window. Widen the WINDOW filter.'}
              </div>
            )}
          </div>

          {/* Intelligence rail */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>

            <div style={{ background: PANEL, border: `1px solid ${gold(28)}`, borderRadius: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '9px 12px', background: gold(6), borderBottom: `1px solid ${gold(16)}` }}>
                <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 10, letterSpacing: '0.16em', color: GOLD }}>AI INTELLIGENCE</span>
                {aiBrief && !aiBriefPending && (
                  <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 8.5, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--theme-positive-strong, #4fd39a)', border: '1px solid rgba(79,211,154,0.5)', padding: '2px 6px', borderRadius: 3 }}>{aiBrief.tone}</span>
                )}
              </div>
              <div style={{ padding: '14px 12px' }}>
                {aiBriefPending ? (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9, padding: '14px 0' }}>
                    <span className="pe-spinner" style={{ width: 13, height: 13, borderRadius: '50%', border: `2px solid ${gold(30)}`, borderTopColor: GOLD, flexShrink: 0 }} />
                    <span className="pe-loading-text" style={{ fontFamily: MONO, fontSize: 10.5, color: GOLD }}>Reading the tape…</span>
                  </div>
                ) : aiBrief ? (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {aiBrief.bullets.map((b, i) => (
                        <div key={i} style={{ fontFamily: SANS, fontSize: 11, lineHeight: '16px', color: TEXT2, paddingLeft: 10, borderLeft: `2px solid ${gold(32)}` }}>{b}</div>
                      ))}
                    </div>
                    <button className="pe-add" onClick={fetchAiBrief}
                      style={{ marginTop: 12, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: MONO, fontWeight: 700, fontSize: 8.5, letterSpacing: '0.1em', color: MUTED, padding: 0 }}>
                      REGENERATE
                    </button>
                  </>
                ) : (
                  <div style={{ textAlign: 'center', padding: '8px 6px 10px' }}>
                    <p style={{ margin: '0 0 12px', fontFamily: SANS, fontSize: 11, lineHeight: '16px', color: MUTED }}>
                      Synthesize a desk brief across your {nHoldings} holdings: timing, implied-move outliers, short-interest risk.
                    </p>
                    {aiBriefError && <p style={{ margin: '0 0 10px', fontFamily: MONO, fontSize: 9, lineHeight: '14px', color: NEG }}>{aiBriefError}</p>}
                    <button onClick={fetchAiBrief} disabled={items.length === 0}
                      style={{ fontFamily: MONO, fontWeight: 700, fontSize: 10, letterSpacing: '0.1em', color: PANEL, background: GOLD, border: 'none', padding: '8px 16px', borderRadius: 3, cursor: items.length === 0 ? 'default' : 'pointer', opacity: items.length === 0 ? 0.5 : 1 }}>
                      GENERATE BRIEF
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div style={{ background: PANEL, border: `1px solid ${gold(14)}`, borderRadius: 4 }}>
              <div style={{ padding: '9px 12px', borderBottom: `1px solid ${HAIRLINE}` }}>
                <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 10, letterSpacing: '0.16em', color: TEXT }}>EARNINGS WIRE</div>
                <div style={{ fontFamily: MONO, fontSize: 10, color: DIM, marginTop: 3 }}>
                  Live Desk · {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              </div>
              <div style={{ padding: '4px 12px 12px', maxHeight: isMobile ? undefined : 560, overflowY: 'auto' }}>
                {wireGroups.map(({ r }, gi) => (
                  <div key={r.ticker} style={{ paddingTop: 12, marginTop: gi === 0 ? 0 : 12, borderTop: gi === 0 ? 'none' : `1px solid ${HAIRLINE}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                      <TickerLogo ticker={r.ticker} size={22} />
                      <span style={{ fontFamily: MONO, fontWeight: 700, fontSize: 10, letterSpacing: '0.14em', color: GOLD }}>{r.ticker} WIRE</span>
                    </div>
                    {r.news.map((n, i) => (
                      <div key={i} style={{ marginBottom: 9 }}>
                        <a className="pe-news-title" href={safeUrl(n.link)} target="_blank" rel="noopener noreferrer"
                          style={{ display: 'block', fontFamily: SANS, fontWeight: 600, fontSize: 11.5, lineHeight: '15px', color: NEWS_GOLD, textDecoration: 'none' }}>
                          {n.title}
                        </a>
                        <div style={{ fontFamily: SANS, fontSize: 9.5, color: DIM, marginTop: 2 }}>Source: {n.publisher}</div>
                      </div>
                    ))}
                  </div>
                ))}
                {wireGroups.length === 0 && (
                  <div style={{ padding: '14px 0 6px', fontFamily: MONO, fontSize: 10, color: FAINT }}>
                    {isPending ? 'Loading feeds…' : 'No wire items for this window.'}
                  </div>
                )}
              </div>
            </div>

          </div>
        </div>
        )}
      </div>
    </div>
  )
}

export default function CorporateHub() {
  return <PageWrapper><PortfolioEarningsContent /></PageWrapper>
}
