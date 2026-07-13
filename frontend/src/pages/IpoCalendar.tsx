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
  symbol: string; name: string; date: string; exchange: string
  price: string; shares: number | null; dealValue: number | null; status: string
}
interface Enriched { symbol: string; shares: number | null; logo: string | null; foreign: boolean }

const WINDOWS = [
  { label: '1 Week', days: 7 }, { label: '1 Month', days: 30 }, { label: '3 Months', days: 90 },
  { label: '6 Months', days: 180 }, { label: '12 Months', days: 365 },
]
// Finnhub status → display label + chip color. "Released" is a priced deal now
// trading; "Pending" is expected to price soon.
const STATUS: Record<string, { label: string; color: string }> = {
  expected:  { label: 'Pending',   color: C.blue },
  filed:     { label: 'Filed',     color: C.gold },
  priced:    { label: 'Released',  color: C.pos },
  withdrawn: { label: 'Withdrawn', color: C.neg },
}
const STATUS_FILTERS = [
  { label: 'All', key: '' },
  { label: 'Pending', key: 'expected' },
  { label: 'Filed', key: 'filed' },
  { label: 'Released', key: 'priced' },
  { label: 'Withdrawn', key: 'withdrawn' },
]

// Finnhub returns granular venue strings ("NASDAQ Global Select", "NYSE American");
// collapse to a family so the filter has a handful of options, not dozens.
function exchangeFamily(ex: string): string {
  const e = (ex || '').toUpperCase()
  if (e.includes('NASDAQ')) return 'NASDAQ'
  if (e.includes('NYSE')) return 'NYSE'
  if (e.includes('CBOE') || e.includes('BATS')) return 'CBOE'
  return ex ? 'Other' : ''
}

function today(): string { return new Date().toISOString().slice(0, 10) }

function fmtMoney(v: number | null | undefined): string {
  if (v == null) return '—'
  const a = Math.abs(v)
  if (a >= 1e12) return `$${(v / 1e12).toFixed(1)}T`
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`
  return `$${v.toFixed(0)}`
}
function fmtShares(v: number | null | undefined): string {
  if (v == null) return '—'
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(0)}K`
  return `${v}`
}
function fmtPrice(p: string): string {
  if (!p) return '—'
  const one = (x: string) => { const v = parseFloat(x); return isNaN(v) ? x : `$${v.toFixed(2)}` }
  const parts = p.split('-').map(s => s.trim()).filter(Boolean)
  return parts.length === 2 ? `${one(parts[0])}–${one(parts[1])}` : one(parts[0] || p)
}
// Mid of the offer range (single value if not a range), for the market-cap math.
function midPrice(p: string): number | null {
  const nums = (p || '').split('-').map(s => parseFloat(s.trim())).filter(v => !isNaN(v))
  if (!nums.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}
// A SPAC/blank-check vehicle floats essentially the whole public company, so its
// public market cap is shares offered x offer price (not the money-raised figure).
function isSpac(name: string): boolean {
  return /\bacquisition\b|\bblank[ -]?check\b|\bcapital corp\b|\bmerger corp\b|\bspac\b/i.test(name || '')
}
// Listing method. SPAC and an explicit ADR/depositary name resolve instantly from
// the issuer name (SPAC stays in sync with isSpac so the market-cap path agrees).
// Foreign-issuer status — the reliable ADR tell that a name like "SK hynix" hides
// — only lands with enrichment (SEC foreign forms + finnhub domicile), so until a
// row is enriched its method is "pending" rather than a wrong "IPO".
type MethodKey = 'spac' | 'adr' | 'ipo'
const METHODS: { key: MethodKey; label: string; color: string }[] = [
  { key: 'ipo',  label: 'IPO',  color: C.muted },
  { key: 'spac', label: 'SPAC', color: C.blue },
  { key: 'adr',  label: 'ADR',  color: C.warn },
]
const METHOD_META = Object.fromEntries(METHODS.map(m => [m.key, m])) as Record<MethodKey, typeof METHODS[number]>

function nameMethod(name: string): MethodKey | null {
  const n = name || ''
  if (isSpac(n)) return 'spac'
  if (/american depositary|\bADSs?\b|\bADRs?\b/i.test(n)) return 'adr'
  return null
}
// Resolved method, or null while a non-name-detectable row awaits its domicile.
function ipoMethod(name: string, e: Enriched | undefined): MethodKey | null {
  const nm = nameMethod(name)
  if (nm) return nm
  if (!e) return null                                  // pending enrichment
  return e.foreign ? 'adr' : 'ipo'
}
// Reliable IPO market cap, or null for "unavailable". Prospectus post-offering
// shares x offer price when parsed; for SPACs the fully-floated public value;
// never the money-raised total.
function ipoMktCap(r: Row, e: Enriched | undefined): number | null {
  const mid = midPrice(r.price)
  if (!e || mid == null) return null
  if (e.shares != null) return e.shares * mid
  if (isSpac(r.name) && r.shares != null) return r.shares * mid
  return null
}
function fmtDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

const shimmer: React.CSSProperties = {
  display: 'inline-block', width: 38, height: 10, borderRadius: 2,
  background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 75%)',
  backgroundSize: '200% 100%', animation: 'ipo-shimmer 1.6s infinite',
}

function MethodChip({ name, e }: { name: string; e: Enriched | undefined }) {
  const key = ipoMethod(name, e)
  if (!key) return <span style={shimmer} />            // domicile not resolved yet
  const m = METHOD_META[key]
  return (
    <span style={{
      fontFamily: C.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
      color: m.color, border: `1px solid ${m.color}`, borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap',
    }}>{m.label}</span>
  )
}

function Facet<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: { label: string; key: T }[]; onChange: (k: T) => void
}) {
  return (
    <div>
      <label style={{ ...LABEL, marginBottom: 5 }}>{label}</label>
      <div style={{ display: 'flex', maxWidth: '100%', overflowX: 'auto', border: `1px solid ${C.border}` }}>
        {options.map(o => (
          <button key={String(o.key)} onClick={() => onChange(o.key)}
            style={{
              background: value === o.key ? C.gold : 'transparent',
              color: value === o.key ? C.header : C.muted,
              border: 'none', borderRight: `1px solid ${C.border}`, cursor: 'pointer',
              fontFamily: C.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
              textTransform: 'uppercase', padding: '8px 12px', whiteSpace: 'nowrap',
            }}>{o.label}</button>
        ))}
      </div>
    </div>
  )
}

function StatusChip({ status }: { status: string }) {
  const s = STATUS[status]
  if (!s) return <span style={{ color: C.dim, fontFamily: C.mono, fontSize: 11 }}>—</span>
  return (
    <span style={{
      fontFamily: C.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
      color: s.color, border: `1px solid ${s.color}`, borderRadius: 3, padding: '2px 6px', whiteSpace: 'nowrap',
    }}>{s.label}</span>
  )
}

export function IpoCalendarContent() {
  const isMobile = useIsMobile()
  const { tickers: watchTickers } = usePortfolio()
  const watchSet = useMemo(() => new Set(watchTickers.map(t => t.toUpperCase())), [watchTickers])

  const [days, setDays] = useState(90)
  const [rows, setRows] = useState<Row[]>([])
  const [priced, setPriced] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [status, setStatus] = useState('')
  const [method, setMethod] = useState<'' | MethodKey>('')
  const [exchange, setExchange] = useState('')
  const [watchOnly, setWatchOnly] = useState(false)
  const [query, setQuery] = useState('')
  // Per-column numeric floors, kept as raw strings; money/shares are entered in the
  // column's own display unit ($M, M) and scaled at compare time.
  const [minMktCap, setMinMktCap] = useState('')
  const [minPrice, setMinPrice] = useState('')
  const [minShares, setMinShares] = useState('')
  const [minDeal, setMinDeal] = useState('')
  // A user sort flattens the date-grouped agenda into one globally ordered list.
  const [sort, setSort] = useState<SortState>(null)

  const [enriched, setEnriched] = useState<Record<string, Enriched>>({})
  const enrichingRef = useRef<Set<string>>(new Set())

  // Window is always trailing from today, so the anchor never needs a control.
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(null); setEnriched({}); enrichingRef.current = new Set()
    axios.get('/api/ipo/calendar', { params: { date: today(), days } })
      .then(r => { if (cancelled) return; setRows(r.data.rows || []); setPriced(r.data.priced || 0) })
      .catch(() => { if (cancelled) return; setError('Could not load the IPO calendar. Try again shortly.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days])

  const exchanges = useMemo(() => {
    const seen = new Set<string>()
    for (const r of rows) { const f = exchangeFamily(r.exchange); if (f) seen.add(f) }
    return Array.from(seen).sort()
  }, [rows])

  const minMktCapUsd = (parseFloat(minMktCap) || 0) * 1e6
  const minPriceVal  = parseFloat(minPrice) || 0
  const minSharesVal = (parseFloat(minShares) || 0) * 1e6
  const minDealUsd   = (parseFloat(minDeal) || 0) * 1e6

  // Row-level filters (everything computable without enrichment). Enrichment runs
  // over this set, so the Method and Mkt Cap floors — which need enriched data —
  // never starve the very rows they hide before those rows resolve.
  const baseFiltered = useMemo(() => {
    const q = query.trim().toUpperCase()
    return rows.filter(r => {
      if (status && r.status !== status) return false
      if (exchange && exchangeFamily(r.exchange) !== exchange) return false
      if (watchOnly && !watchSet.has(r.symbol.toUpperCase())) return false
      if (q && !r.symbol.toUpperCase().includes(q) && !(r.name || '').toUpperCase().includes(q)) return false
      if (minPriceVal > 0) { const p = midPrice(r.price); if (p == null || p < minPriceVal) return false }
      if (minDealUsd > 0 && (r.dealValue == null || r.dealValue < minDealUsd)) return false
      if (minSharesVal > 0 && (r.shares == null || r.shares < minSharesVal)) return false
      return true
    })
  }, [rows, status, exchange, watchOnly, watchSet, query, minPriceVal, minDealUsd, minSharesVal])

  const filtered = useMemo(() => baseFiltered.filter(r => {
    const e = enriched[r.symbol]
    if (method && ipoMethod(r.name, e) !== method) return false
    if (minMktCapUsd > 0) { const cap = ipoMktCap(r, e); if (cap == null || cap < minMktCapUsd) return false }
    return true
  }), [baseFiltered, method, minMktCapUsd, enriched])

  // Newest date first (upcoming pipeline leads), largest deals first within a
  // date. Deal size is known immediately, so the sort never waits on enrichment.
  const byDateThenDeal = (a: Row, b: Row) => {
    if ((a.date || '') !== (b.date || '')) return (b.date || '').localeCompare(a.date || '')
    const d = (b.dealValue ?? -1) - (a.dealValue ?? -1)
    return d !== 0 ? d : a.symbol.localeCompare(b.symbol)
  }
  const sorted = useMemo(() => [...filtered].sort(byDateThenDeal), [filtered])
  const sortedForEnrich = useMemo(() => [...baseFiltered].sort(byDateThenDeal), [baseFiltered])

  // Post-offering shares (for the IPO market cap) + logo arrive on demand for the
  // rows on screen, in small batches so the table fills progressively rather than
  // blocking on a long list of SEC prospectus lookups.
  const enrichBatch = useCallback((items: { symbol: string; name: string }[]) => {
    if (!items.length) return
    items.forEach(i => enrichingRef.current.add(i.symbol))
    axios.post('/api/ipo/enrich', { rows: items })
      .then(r => {
        const next: Record<string, Enriched> = {}
        for (const e of (r.data.rows || []) as Enriched[]) next[e.symbol] = e
        setEnriched(prev => ({ ...prev, ...next }))
      })
      .catch(() => {
        setEnriched(prev => ({ ...prev, ...Object.fromEntries(items.map(i => [i.symbol, { symbol: i.symbol, shares: null, logo: null, foreign: false }])) }))
      })
  }, [])

  useEffect(() => {
    const pending = sortedForEnrich
      .filter(r => !(r.symbol in enriched) && !enrichingRef.current.has(r.symbol))
      .map(r => ({ symbol: r.symbol, name: r.name }))
    if (pending.length) enrichBatch(pending.slice(0, 12))
  }, [sortedForEnrich, enriched, enrichBatch])

  // Default view groups by date; a user sort flattens to one ordered list (the
  // synthetic '' group key tells GroupBody to drop the date header).
  const grouped = useMemo<[string, Row[]][]>(() => {
    if (sort) {
      const val = (r: Row): number | string => {
        const e = enriched[r.symbol]
        switch (sort.key) {
          case 'symbol':   return r.symbol
          case 'mktcap':   return ipoMktCap(r, e) ?? -1
          case 'exchange': return exchangeFamily(r.exchange)
          case 'method':   return ipoMethod(r.name, e) ?? 'zzz'
          case 'price':    return midPrice(r.price) ?? -1
          case 'shares':   return r.shares ?? -1
          case 'deal':     return r.dealValue ?? -1
          case 'status':   return STATUS[r.status]?.label ?? r.status
          default:         return 0
        }
      }
      const flat = [...filtered].sort((a, b) => {
        const av = val(a), bv = val(b)
        const cmp = typeof av === 'string' || typeof bv === 'string'
          ? String(av).localeCompare(String(bv))
          : (av as number) - (bv as number)
        return sort.dir === 'asc' ? cmp : -cmp
      })
      return [['', flat]]
    }
    const map = new Map<string, Row[]>()
    for (const r of sorted) {
      const k = r.date || 'unknown'
      ;(map.get(k) || map.set(k, []).get(k)!).push(r)
    }
    return Array.from(map.entries()).sort((a, b) => b[0].localeCompare(a[0]))
  }, [sort, filtered, sorted, enriched])

  const cols = isMobile
    ? ['Symbol', 'Price', 'Status']
    : ['Symbol', 'IPO Mkt Cap', 'Exchange', 'Method', 'Price', 'Shares', 'Deal Size', 'Status']

  const anyFilter = !!(status || method || exchange || query || minMktCap || minPrice || minShares || minDeal || watchOnly || sort)
  const clearFilters = () => {
    setStatus(''); setMethod(''); setExchange(''); setQuery('')
    setMinMktCap(''); setMinPrice(''); setMinShares(''); setMinDeal(''); setWatchOnly(false); setSort(null)
  }

  // Sort key per column, and the filter each column's menu exposes. Row-level
  // columns filter instantly; Method and Mkt Cap resolve as enrichment lands.
  const SORT_KEY: Record<string, string> = {
    'Symbol': 'symbol', 'IPO Mkt Cap': 'mktcap', 'Exchange': 'exchange', 'Method': 'method',
    'Price': 'price', 'Shares': 'shares', 'Deal Size': 'deal', 'Status': 'status',
  }
  const colFilterSpec = (c: string): FilterSpec | undefined => {
    switch (c) {
      case 'Symbol':      return { kind: 'text', value: query, set: setQuery, placeholder: 'Ticker or company' }
      case 'IPO Mkt Cap': return { kind: 'min', value: minMktCap, set: setMinMktCap, placeholder: '≥ $M' }
      case 'Exchange':    return { kind: 'select', value: exchange, set: setExchange, options: [{ label: 'All', key: '' }, ...exchanges.map(e => ({ label: e, key: e }))] }
      case 'Method':      return { kind: 'select', value: method, set: v => setMethod(v as '' | MethodKey), options: [{ label: 'All', key: '' }, ...METHODS.map(m => ({ label: m.label, key: m.key }))] }
      case 'Price':       return { kind: 'min', value: minPrice, set: setMinPrice, placeholder: '≥ $' }
      case 'Shares':      return { kind: 'min', value: minShares, set: setMinShares, placeholder: '≥ M' }
      case 'Deal Size':   return { kind: 'min', value: minDeal, set: setMinDeal, placeholder: '≥ $M' }
      // Status lives as a prominent top-bar facet (the primary lifecycle filter),
      // so its column menu is sort-only.
      default:            return undefined
    }
  }
  const colMenu = (c: string, align: 'left' | 'right') => (
    <ColumnFilterMenu align={align} sortKey={SORT_KEY[c]} sort={sort} onSort={setSort} filter={colFilterSpec(c)} />
  )

  return (
    <>
      <style>{`@keyframes ipo-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>

      {/* Controls: window scopes the fetch; per-column filters live in the header row */}
      <div style={{
        background: C.header, border: `1px solid ${C.border}`, padding: '14px 16px',
        display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 16, marginBottom: 14,
      }}>
        <Facet label="Window" value={days} onChange={setDays}
          options={WINDOWS.map(w => ({ label: w.label, key: w.days }))} />
        <Facet label="Status" value={status} onChange={setStatus} options={STATUS_FILTERS} />
        <div style={{ flex: 1, minWidth: 180, textAlign: 'right', paddingBottom: 7, fontFamily: C.sans, fontSize: 11, color: C.muted, lineHeight: 1.5 }}>
          {!loading && !error && (
            <>
              <span style={{ color: C.text, fontWeight: 700 }}>{filtered.length}</span> listing{filtered.length === 1 ? '' : 's'}
              {' · '}<span style={{ color: C.text }}>{priced}</span> released
              {!sort && grouped.length > 0 && <>{' · '}{fmtDate(grouped[grouped.length - 1][0])} → {fmtDate(grouped[0][0])}</>}
              {sort && <>{' · sorted by '}<span style={{ color: C.text }}>{sort.key}</span> {sort.dir === 'asc' ? '↑' : '↓'}</>}
            </>
          )}
        </div>
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

      {loading && <Centered>Loading IPOs…</Centered>}
      {error && <Centered tone={C.neg}>{error}</Centered>}
      {!loading && !error && sorted.length === 0 && (
        <Centered>No IPOs match. Widen the window or clear filters.</Centered>
      )}

      {!loading && !error && sorted.length > 0 && (
        <div style={{ border: `1px solid ${C.border}`, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: isMobile ? 0 : 780 }}>
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
                  cols={cols.length} isMobile={isMobile} watch={watchSet} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && sorted.length > 0 && (
        <div style={{ fontFamily: C.sans, fontSize: 10, color: C.muted, marginTop: 10, lineHeight: 1.7 }}>
          Window is trailing from today and reaches ~30 days ahead for the pipeline.
          Price = expected offer range set by the underwriters (single value once priced).
          Deal size = shares offered times the mid of the range. IPO Mkt Cap = post-offering shares
          outstanding from the S-1/424B prospectus times the offer price, or for a SPAC the fully-floated
          public value; it reads "unavailable" when it cannot be sourced reliably (never the money-raised
          figure). Method: SPAC is a blank-check/acquisition vehicle, ADR is a non-US issuer listing via
          depositary shares (from the company's domicile), IPO is a standard offering. Status: Pending is
          expected to price, Filed is on file with the SEC, Released has priced and is trading, Withdrawn was
          pulled. Calendar from finnhub, share counts from SEC EDGAR.
        </div>
      )}
    </>
  )
}

function GroupBody({ gdate, grows, enriched, cols, isMobile, watch }: {
  gdate: string; grows: Row[]; enriched: Record<string, Enriched>
  cols: number; isMobile: boolean; watch: Set<string>
}) {
  return (
    <>
      {gdate && (
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
        const cap = ipoMktCap(r, e)
        return (
          <tr key={r.symbol + r.date} style={{ borderBottom: `1px solid ${C.border}` }}>
            <td style={{ padding: '10px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                <TickerLogo ticker={r.symbol} size={22} logoUrl={e?.logo || undefined} />
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
                    }}>{r.name || '—'}</div>
                  )}
                </div>
              </div>
            </td>
            {!isMobile && (
              <td style={{ ...cell, color: cap != null ? C.text : C.dim }}>
                {pending ? <span style={shimmer} />
                  : cap != null ? fmtMoney(cap)
                  : <span style={{ fontFamily: C.sans, fontSize: 10, letterSpacing: '0.04em' }}>unavailable</span>}
              </td>
            )}
            {!isMobile && (
              <td style={{ ...cell, color: C.dim }}>{r.exchange || '—'}</td>
            )}
            {!isMobile && (
              <td style={{ ...cell, textAlign: 'right' }}><MethodChip name={r.name} e={e} /></td>
            )}
            <td style={{ ...cell, color: C.text }}>{fmtPrice(r.price)}</td>
            {!isMobile && (
              <td style={{ ...cell, color: C.text }}>{fmtShares(r.shares)}</td>
            )}
            {!isMobile && (
              <td style={{ ...cell, color: C.gold }}>{fmtMoney(r.dealValue)}</td>
            )}
            <td style={{ ...cell, textAlign: 'right' }}><StatusChip status={r.status} /></td>
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

export default function IpoCalendar() {
  return <PageWrapper title="IPO Scanner"><IpoCalendarContent /></PageWrapper>
}
