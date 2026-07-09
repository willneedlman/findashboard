import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import axios from 'axios'
import { Star } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import TickerLogo from '../components/TickerLogo'
import TickerLink from '../components/TickerLink'
import ColumnFilterMenu, { type SortState, type FilterSpec } from '../components/ColumnFilterMenu'
import useIsMobile from '../hooks/useIsMobile'
import { usePortfolio } from '../contexts/PortfolioContext'

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
  epsEstimate: number | null; revenueEstimate: number | null
}
interface Enriched {
  symbol: string; companyName?: string | null; marketCap?: number | null; sector?: string | null
  priorReportDate?: string | null; surprisePct?: number | null
  reactionPct?: number | null; runSincePct?: number | null
  impliedMove?: number | null; impliedMoveExpiry?: string | null
}

const WINDOWS = [{ label: 'Day', days: 1 }, { label: '3 Days', days: 3 }, { label: 'Week', days: 7 }]
const HOUR_LABEL: Record<string, string> = { bmo: 'Pre', amc: 'Post', dmh: 'Mid' }

function today(): string { return new Date().toISOString().slice(0, 10) }

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

const shimmer: React.CSSProperties = {
  display: 'inline-block', width: 38, height: 10, borderRadius: 2,
  background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 75%)',
  backgroundSize: '200% 100%', animation: 'ec-shimmer 1.6s infinite',
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [coveredOnly, setCoveredOnly] = useState(true)
  const [watchOnly, setWatchOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [minCapStr, setMinCapStr] = useState('')   // in $B
  const [hourFilter, setHourFilter] = useState('') // '', bmo, amc, dmh
  const [sort, setSort] = useState<SortState>(null) // a user sort flattens the date grouping

  const minCap = (parseFloat(minCapStr) || 0) * 1e9

  const [enriched, setEnriched] = useState<Record<string, Enriched>>({})
  const enrichingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setEnriched({}); enrichingRef.current = new Set()
    axios.get('/api/earnings/calendar', { params: { date, days } })
      .then(r => { if (cancelled) return; setRows(r.data.rows || []); setCovered(r.data.covered || 0) })
      .catch(() => { if (cancelled) return; setError('Could not load the earnings calendar. Try again shortly.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [date, days])

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (coveredOnly && r.epsEstimate == null) return false
      if (watchOnly && !watchSet.has(r.symbol.toUpperCase())) return false
      if (hourFilter && r.hour !== hourFilter) return false
      if (q) {
        const name = (enriched[r.symbol]?.companyName || '').toUpperCase()
        if (!r.symbol.toUpperCase().includes(q) && !name.includes(q)) return false
      }
      return true
    })
  }, [rows, coveredOnly, watchOnly, watchSet, query, hourFilter, enriched])

  // Enrich the visible rows in small batches so the table fills progressively
  // and no single request blocks on a long list of yfinance lookups.
  const enrichBatch = useCallback((symbols: string[]) => {
    if (!symbols.length) return
    symbols.forEach(s => enrichingRef.current.add(s))
    axios.get('/api/earnings/enrich', { params: { symbols: symbols.join(',') } })
      .then(r => {
        const next: Record<string, Enriched> = {}
        for (const e of (r.data.rows || []) as Enriched[]) next[e.symbol] = e
        setEnriched(prev => ({ ...prev, ...next }))
      })
      // Mark a failed batch as attempted (empty rows) rather than clearing it, so
      // the effect does not immediately re-request it in a tight loop on a
      // persistent backend error. The row stays as a dash for this load.
      .catch(() => {
        setEnriched(prev => ({ ...prev, ...Object.fromEntries(symbols.map(s => [s, { symbol: s }])) }))
      })
  }, [])

  // Largest companies first within each date. Market cap arrives with
  // enrichment, so rows not yet enriched sort to the bottom (cap -1) and rise as
  // their data loads. Date stays the primary axis so a multi-day window groups.
  const sorted = useMemo(() => {
    const cap = (s: string) => enriched[s]?.marketCap ?? -1
    return [...filtered].sort((a, b) => {
      if ((a.date || '') !== (b.date || '')) return (a.date || '').localeCompare(b.date || '')
      const d = cap(b.symbol) - cap(a.symbol)
      return d !== 0 ? d : a.symbol.localeCompare(b.symbol)
    })
  }, [filtered, enriched])

  useEffect(() => {
    const pending = sorted
      .map(r => r.symbol)
      .filter(s => !(s in enriched) && !enrichingRef.current.has(s))
    if (pending.length) enrichBatch(pending.slice(0, 10))
  }, [sorted, enriched, enrichBatch])

  // Market-cap filter applies AFTER enrichment is driven off `sorted`, so a row
  // filtered out here is still enriched (no deadlock) and rows appear as their
  // cap loads and qualifies. Unknown-cap rows are held back while a filter is on.
  const visible = useMemo(() => {
    if (!minCap) return sorted
    return sorted.filter(r => { const c = enriched[r.symbol]?.marketCap; return c != null && c >= minCap })
  }, [sorted, enriched, minCap])

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
          case 'hour':            return rank[r.hour] ?? 3
          case 'epsEstimate':     return r.epsEstimate ?? -1e18
          case 'revenueEstimate': return r.revenueEstimate ?? -1
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
    ? ['Symbol', 'Time', 'EPS Est', 'Impl', 'React']
    : ['Symbol', 'Mkt Cap', 'Time', 'EPS Est', 'Rev Est', 'Impl Move', 'Surprise', 'React', 'Since']

  const anyFilter = !!(query || minCapStr || hourFilter || sort)
  const clearFilters = () => { setQuery(''); setMinCapStr(''); setHourFilter(''); setSort(null) }

  const SORT_KEY: Record<string, string> = {
    'Symbol': 'symbol', 'Mkt Cap': 'marketCap', 'Time': 'hour', 'EPS Est': 'epsEstimate',
    'Rev Est': 'revenueEstimate', 'Impl Move': 'impliedMove', 'Impl': 'impliedMove',
    'Surprise': 'surprisePct', 'React': 'reactionPct', 'Since': 'runSincePct',
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
              fontSize: 13, padding: '7px 10px', colorScheme: 'dark',
            }} />
        </div>
        <div>
          <label style={{ ...LABEL, marginBottom: 5 }}>Window</label>
          <div style={{ display: 'flex', border: `1px solid ${C.border}` }}>
            {WINDOWS.map(w => (
              <button key={w.days} onClick={() => setDays(w.days)}
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
      {!loading && !error && (
        <div style={{ fontFamily: C.sans, fontSize: 11, color: C.muted, marginBottom: 10 }}>
          <span style={{ color: C.text, fontWeight: 700 }}>{minCap ? visible.length : filtered.length}</span> {minCap ? 'shown' : 'reporting'}
          {' · '}<span style={{ color: C.text }}>{covered}</span> with estimates
          {sort
            ? <>{' · sorted by '}<span style={{ color: C.text }}>{sort.key}</span> {sort.dir === 'asc' ? '↑' : '↓'}</>
            : <>{' · '}{fmtDate(date)}{days > 1 ? ` → ${fmtDate(grouped[grouped.length - 1]?.[0] || date)}` : ''}</>}
        </div>
      )}

      {loading && <Centered>Loading earnings…</Centered>}
      {error && <Centered tone={C.neg}>{error}</Centered>}
      {!loading && !error && visible.length === 0 && (
        <Centered>No companies match. Widen the window or clear filters.</Centered>
      )}

      {!loading && !error && visible.length > 0 && (
        <div style={{ border: `1px solid ${C.border}`, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: isMobile ? 0 : 720 }}>
            <thead>
              <tr style={{ background: C.header }}>
                {cols.map((c, i) => (
                  <th key={c} style={{
                    ...LABEL, display: 'table-cell', textAlign: i === 0 ? 'left' : 'right', padding: '9px 14px',
                    position: 'sticky', top: 0, background: C.header, borderBottom: `1px solid ${C.border}`,
                  }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle' }}>
                      {c}{colMenu(c, i === 0 ? 'left' : 'right')}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map(([gdate, grows]) => (
                <GroupBody key={gdate} gdate={gdate} grows={grows} enriched={enriched}
                  cols={cols.length} isMobile={isMobile} showHeader={!sort && days > 1} watch={watchSet} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && visible.length > 0 && (
        <div style={{ fontFamily: C.sans, fontSize: 10, color: C.muted, marginTop: 10, lineHeight: 1.7 }}>
          Impl Move = expected move priced into the ATM straddle of the expiry spanning this report.
          Surprise = last EPS vs estimate. React = stock's one-day move on its last report.
          Since = move from that report to now. Estimates from finnhub, reactions from prior-quarter prices.
        </div>
      )}
    </>
  )
}

function GroupBody({ gdate, grows, enriched, cols, isMobile, showHeader, watch }: {
  gdate: string; grows: Row[]; enriched: Record<string, Enriched>
  cols: number; isMobile: boolean; showHeader: boolean; watch: Set<string>
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
        return (
          <tr key={r.symbol + r.date} style={{ borderBottom: `1px solid ${C.border}` }}>
            <td style={{ padding: '10px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                <TickerLogo ticker={r.symbol} size={22} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 600, color: C.text }}>
                    <TickerLink ticker={r.symbol} />
                    {watch.has(r.symbol.toUpperCase()) && (
                      <Star size={10} fill={C.gold} stroke={C.gold}
                        style={{ marginLeft: 6, verticalAlign: 'middle' }}
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
            <td style={{ ...cell, textAlign: isMobile ? 'right' : 'right' }}><HourChip hour={r.hour} /></td>
            <td style={{ ...cell, color: C.text }}>{fmtEps(r.epsEstimate)}</td>
            {!isMobile && (
              <td style={{ ...cell, color: C.text }}>{fmtMoney(r.revenueEstimate)}</td>
            )}
            <td style={{ ...cell, color: C.gold }} title={e?.impliedMoveExpiry ? `Expected move by ${e.impliedMoveExpiry}` : undefined}>
              {pending ? <span style={shimmer} /> : (e?.impliedMove != null ? `${e.impliedMove.toFixed(1)}%` : '—')}
            </td>
            {!isMobile && (
              <td style={{ ...cell, color: pctColor(e?.surprisePct) }}>
                {pending ? <span style={shimmer} /> : fmtPct(e?.surprisePct)}
              </td>
            )}
            <td style={{ ...cell, color: pctColor(e?.reactionPct) }}>
              {pending ? <span style={shimmer} /> : fmtPct(e?.reactionPct)}
            </td>
            {!isMobile && (
              <td style={{ ...cell, color: pctColor(e?.runSincePct) }}>
                {pending ? <span style={shimmer} /> : fmtPct(e?.runSincePct)}
              </td>
            )}
          </tr>
        )
      })}
    </>
  )
}

const cell: React.CSSProperties = {
  padding: '10px 14px', textAlign: 'right', fontFamily: C.mono,
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

function Centered({ children, tone }: { children: React.ReactNode; tone?: string }) {
  return (
    <div style={{
      padding: '48px 20px', textAlign: 'center', fontFamily: C.sans, fontSize: 12,
      color: tone || C.muted, border: `1px solid ${C.border}`,
    }}>{children}</div>
  )
}

export default function EarningsCalendar() {
  return <PageWrapper title="Earnings Scanner"><EarningsCalendarContent /></PageWrapper>
}
