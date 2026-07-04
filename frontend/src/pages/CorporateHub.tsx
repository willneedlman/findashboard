import PageWrapper from '../components/PageWrapper'
import { useState, useEffect, useRef, Fragment } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Radar, CalendarClock } from 'lucide-react'
import { usePortfolio } from '../contexts/PortfolioContext'
import axios from 'axios'
import TickerTagInput from '../components/TickerTagInput'
import { tickerLogoUrl } from '../lib/tickerLogos'
import useIsMobile from '../hooks/useIsMobile'
import PortfolioIO from '../components/PortfolioIO'

interface TickerRow {
  ticker: string; name: string
  date: string; horizon: string
  impliedMove: number
  pe: number | null
  pctChange: number | null
  marketCap: number | null
  consensus: string | null; isConfirmed: boolean
  news: { title: string; link: string; publisher: string }[]
  sparkline: number[]
}

function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  if (!data || data.length < 2) return <div style={{ width: 80, height: 24 }} />
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const W = 80, H = 24, pad = 1
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (W - pad * 2)
    const y = H - pad - ((v - min) / range) * (H - pad * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const color = positive ? 'var(--theme-positive)' : 'var(--theme-negative)'
  return (
    <svg width={W} height={H} style={{ display: 'block', overflow: 'visible' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" opacity={0.85} />
    </svg>
  )
}

interface ShortRow {
  shortPctFloat: string; shortRatio: string; sharesShort: string
}

interface InsiderTx {
  date: string; insider: string; title: string; transaction: string; shares: number; value: number
}

function safeUrl(url: string): string {
  try {
    const u = new URL(url)
    return ['https:', 'http:'].includes(u.protocol) ? url : '#'
  } catch { return '#' }
}

const CONSENSUS_STYLE: Record<string, { color: string; border: string }> = {
  'Strong Buy':    { color: 'var(--theme-positive-strong)', border: 'var(--theme-positive-strong)' },
  'Moderate Buy':  { color: 'var(--theme-positive)', border: 'var(--theme-positive)' },
  'Hold':          { color: 'var(--theme-secondary, #99907e)', border: 'var(--theme-text-faint, rgba(255,255,255,0.18))' },
  'Underperform':  { color: 'var(--theme-negative)', border: 'var(--theme-negative)' },
}

const TIMEOUT = 10_000

// Company logo via Parqet CDN with initials fallback
function TickerLogo({ ticker }: { ticker: string }) {
  const [failed, setFailed] = useState(false)
  const initials = ticker.slice(0, 2)
  const hue = (ticker.charCodeAt(0) * 37 + ticker.charCodeAt(1) * 17) % 360

  if (failed) {
    return (
      <div style={{
        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
        background: `hsl(${hue},35%,22%)`, border: `1px solid hsl(${hue},35%,35%)`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 9, fontWeight: 700, color: `hsl(${hue},60%,70%)`, letterSpacing: '0.05em',
      }}>
        {initials}
      </div>
    )
  }

  return (
    <img
      src={tickerLogoUrl(ticker, 'png')}
      alt={ticker}
      onError={() => setFailed(true)}
      style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, objectFit: 'contain', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}
    />
  )
}

async function fetchTicker(tk: string): Promise<TickerRow> {
  try {
    const { data: d } = await axios.get(`/api/corporate/hub?ticker=${tk}`, { timeout: TIMEOUT })
    return {
      ticker: tk, name: d.company_name || tk, date: d.date || '—', horizon: d.horizon || '—',
      impliedMove: d.implied_move ?? 4.5, pe: d.estimated_pe ?? null,
      pctChange: d.pct_change_1d ?? null, marketCap: d.market_cap ?? null,
      consensus: d.consensus ?? null, isConfirmed: d.is_confirmed ?? false,
      sparkline: d.sparkline ?? [],
      news: (d.news || []).slice(0, 2).map((n: any) => ({
        title: n.title || 'Market Update', link: n.link || '#', publisher: n.publisher || 'Financial Wire',
      })),
    }
  } catch {
    return { ticker: tk, name: tk, date: '—', horizon: '—', impliedMove: 4.5, pe: null,
             pctChange: null, marketCap: null, consensus: null, isConfirmed: false, news: [], sparkline: [] }
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

async function fetchShortTicker(tk: string): Promise<[string, ShortRow]> {
  try {
    const { data: d } = await axios.get(`/api/corporate/hub/short?ticker=${tk}`, { timeout: TIMEOUT })
    return [tk, {
      shortPctFloat: d.shortPercentOfFloat != null ? `${(d.shortPercentOfFloat * 100).toFixed(1)}%` : '—',
      shortRatio: d.shortRatio != null ? d.shortRatio.toFixed(1) : '—',
      sharesShort: d.sharesShort != null ? (d.sharesShort / 1e6).toFixed(1) + 'M' : '—',
    }]
  } catch {
    return [tk, { shortPctFloat: '—', shortRatio: '—', sharesShort: '—' }]
  }
}

const TH_S: React.CSSProperties    = { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', whiteSpace: 'nowrap' }
const TD_S: React.CSSProperties    = { padding: '5px 10px', borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.03))', fontSize: 11, color: 'var(--theme-text, #d7e3fc)', verticalAlign: 'middle' }

const LABEL: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }
const INPUT: React.CSSProperties = { background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: 'var(--theme-text, #d7e3fc)', fontSize: 12, padding: '5px 8px', width: '100%', outline: 'none', fontFamily: 'var(--theme-mono)' }
const TH: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))', fontSize: 12, color: 'var(--theme-text, #d7e3fc)', verticalAlign: 'middle' }

const DEFAULT_TICKERS = ['NVDA', 'AAPL', 'SLS', 'MSTR', 'TOST', 'VST', 'OWL', 'AMZN']

export function CorporateHubContent() {
  const isMobile = useIsMobile()
  const [searchParams, setSearchParams] = useSearchParams()
  const { tickers: portfolioTickers } = usePortfolio()
  const [tickers, setTickersRaw] = useState<string[]>(() => {
    const raw = searchParams.get('tickers')
    if (raw) return raw.split(',').map(t => t.trim()).filter(Boolean)
    return portfolioTickers.length > 0 ? portfolioTickers : DEFAULT_TICKERS
  })
  const setTickers = (ts: string[]) => {
    setTickersRaw(ts)
    setSearchParams(p => { p.set('tickers', ts.join(',')); return p })
  }
  const updateTicker = (i: number, val: string) =>
    setTickers(tickers.map((t, idx) => idx === i ? val.toUpperCase() : t))
  const addTicker = () => setTickers([...tickers, ''])
  const removeTicker = (i: number) => setTickers(tickers.filter((_, idx) => idx !== i))

  const [view, setView] = useState<'radar' | 'timeline'>(() => searchParams.get('view') === 'timeline' ? 'timeline' : 'radar')
  const changeView = (v: 'radar' | 'timeline') => { setView(v); setSearchParams(p => { p.set('view', v); return p }) }
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggleExpand = (tk: string) => setExpanded(p => ({ ...p, [tk]: !p[tk] }))

  const [sortBy, setSortBy] = useState('ticker')
  const [fiscalFilter, setFiscalFilter] = useState('All Horizons')

  const [rows, setRows]                   = useState<TickerRow[]>([])
  const [shortData, setShortData]         = useState<Record<string, ShortRow>>({})
  const [insiderData, setInsiderData]     = useState<Record<string, InsiderTx[]>>({})
  const [isPending, setIsPending]         = useState(false)
  const [shortPending, setShortPending]   = useState(false)
  const [insiderPending, setInsiderPending] = useState(false)
  const [aiBrief, setAiBrief]             = useState<{ bullets: string[]; tone: string } | null>(null)
  const [aiBriefPending, setAiBriefPending] = useState(false)
  const [aiBriefError, setAiBriefError]   = useState<string | null>(null)
  const hasMounted    = useRef(false)
  const portfolioUsed = useRef(false)

  // If portfolio loads after mount (e.g. server sync), auto-import it once
  useEffect(() => {
    if (portfolioUsed.current) return
    if (portfolioTickers.length === 0) return
    if (searchParams.get('tickers')) return  // URL param takes precedence
    portfolioUsed.current = true
    setTickers(portfolioTickers)
    runScan(portfolioTickers)
  }, [portfolioTickers]) // eslint-disable-line

  const runScan = async (tickers: string[]) => {
    setIsPending(true); setRows([]); setShortData({}); setInsiderData({})
    const results = await Promise.all(tickers.map(fetchTicker))
    setRows(results); setIsPending(false)
    // Short interest + insider activity always load (in parallel, after the main rows)
    await Promise.all([
      (async () => {
        setShortPending(true)
        const pairs = await Promise.all(tickers.map(fetchShortTicker))
        setShortData(Object.fromEntries(pairs))
        setShortPending(false)
      })(),
      (async () => {
        setInsiderPending(true)
        const pairs = await Promise.all(tickers.map(fetchInsiderTicker))
        setInsiderData(Object.fromEntries(pairs))
        setInsiderPending(false)
      })(),
    ])
  }

  const fetchAiBrief = async () => {
    if (rows.length === 0) return
    setAiBriefPending(true)
    setAiBriefError(null)
    try {
      const payload = {
        tickers: rows.map(r => r.ticker),
        rows: rows.map(r => ({
          ticker: r.ticker, pctChange: r.pctChange, marketCap: r.marketCap,
          consensus: r.consensus, pe: r.pe,
          news: (r.news ?? []).slice(0, 2).map(n => ({ title: n.title })),
        })),
      }
      const { data: res } = await axios.post('/api/ai/corporate-brief', payload)
      if (res.bullets) {
        setAiBrief(res)
      } else {
        setAiBriefError('Unexpected response from AI')
      }
    } catch (err: any) {
      const msg = err?.response?.data?.detail ?? err?.message ?? 'Request failed'
      setAiBriefError(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }
    setAiBriefPending(false)
  }

  useEffect(() => {
    if (hasMounted.current) return
    hasMounted.current = true
    runScan(tickers.filter(Boolean))
  }, []) // eslint-disable-line

  const handleScan = () => runScan(tickers.filter(Boolean))

  let sorted = [...rows]
  if (fiscalFilter === 'Confirmed Future Releases') sorted = sorted.filter(r => r.isConfirmed)
  sorted.sort((a, b) =>
    sortBy === 'impliedMove' ? b.impliedMove - a.impliedMove
    : sortBy === 'pe'        ? (a.pe ?? 999) - (b.pe ?? 999)
    : sortBy === 'pctChange' ? (b.pctChange ?? -999) - (a.pctChange ?? -999)
    : sortBy === 'marketCap' ? (b.marketCap ?? 0) - (a.marketCap ?? 0)
    : a.ticker.localeCompare(b.ticker)
  )

  // ── Catalyst date helpers (backend dates arrive ISO "YYYY-MM-DD" or "—") ──
  const today0 = new Date(); today0.setHours(0, 0, 0, 0)
  const parseDate = (s: string) => { if (!s || s === '—') return null; const d = new Date(`${s}T00:00:00`); return isNaN(+d) ? null : d }
  const daysToEvent = (s: string) => { const d = parseDate(s); return d ? Math.round((+d - +today0) / 86_400_000) : null }
  // Proximity color rides the gold accent: nearest events brightest, fading to muted.
  const proximityColor = (days: number | null) =>
    days == null ? 'var(--theme-text-faint, rgba(255,255,255,0.25))'
    : days <= 21 ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 70%, #ffffff)'
    : days <= 35 ? 'var(--theme-primary, #c9a84c)'
    : 'var(--theme-secondary, #8099b0)'
  const fmtMonthDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const fmtCap = (n: number | null) => n == null ? '—' : n >= 1e12 ? `$${(n / 1e12).toFixed(2)}T` : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(0)}M`
  const pctTone = (p: number | null) => p == null ? 'var(--theme-text-faint, rgba(255,255,255,0.35))' : p >= 0 ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'
  const pctStr = (p: number | null) => p == null ? '—' : `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`
  const BLUE = 'var(--theme-tertiary, #60a5fa)'

  const insiderSummary = (tk: string): { label: string; color: string } => {
    const txs = insiderData[tk]
    if (!txs || txs.length === 0) return { label: insiderPending ? '…' : 'No data', color: 'var(--theme-text-faint, rgba(255,255,255,0.35))' }
    const t = txs[0].transaction
    return { label: t, color: t === 'Sale' ? 'var(--theme-negative, #ef4444)' : t === 'Purchase' ? 'var(--theme-positive, #22c55e)' : 'var(--theme-text, #d7e3fc)' }
  }

  // Proximity-sorted catalysts (Sort By preserved as the stable tie-break)
  const withDays = sorted.map(r => ({ r, days: daysToEvent(r.date) }))
  const catalystsSorted = [...withDays].sort((a, b) =>
    a.days == null && b.days == null ? 0 : a.days == null ? 1 : b.days == null ? -1 : a.days - b.days)

  // Month-bucketed catalysts for the timeline (+ a trailing Unscheduled bucket)
  const monthBuckets = (() => {
    const map = new Map<string, { label: string; items: { r: TickerRow; days: number | null; d: Date | null }[] }>()
    const undated: { r: TickerRow; days: number | null; d: Date | null }[] = []
    for (const { r, days } of withDays) {
      const d = parseDate(r.date)
      if (!d) { undated.push({ r, days, d: null }); continue }
      const key = `${d.getFullYear()}-${String(d.getMonth()).padStart(2, '0')}`
      if (!map.has(key)) map.set(key, { label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), items: [] })
      map.get(key)!.items.push({ r, days, d })
    }
    const ordered = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, v]) => {
      v.items.sort((a, b) => (a.days ?? 0) - (b.days ?? 0)); return v
    })
    if (undated.length) ordered.push({ label: 'Unscheduled', items: undated })
    return ordered
  })()

  const panel: React.CSSProperties = { background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }
  const panelHead = (title: string, caption?: React.ReactNode) => (
    <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <span style={{ ...LABEL, fontSize: 10, letterSpacing: '0.16em', color: 'var(--theme-text, #d7e3fc)' }}>{title}</span>
      {caption != null && <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, letterSpacing: '0.1em', color: 'var(--theme-secondary, #8099b0)' }}>{caption}</span>}
    </div>
  )
  const chip = (text: string) => {
    const cs = CONSENSUS_STYLE[text] ?? CONSENSUS_STYLE['Hold']
    return <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', border: `1px solid ${cs.border}`, color: cs.color, padding: '2px 5px', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{text}</span>
  }
  const faint = 'var(--theme-text-faint, rgba(255,255,255,0.35))'
  // Consensus is loaded with the main scan: show "…" while pending, never a fake
  // rating; a genuinely uncovered name (null) reads as "—".
  const consensusNode = (c: string | null) =>
    isPending ? <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: faint }}>…</span>
    : c ? chip(c)
    : <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: faint }}>—</span>
  const tlMetric = (label: string, value: string, color = 'var(--theme-text, #d7e3fc)') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ ...LABEL, fontSize: 8, letterSpacing: '0.1em' }}>{label}</span>
      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, color }}>{value}</span>
    </div>
  )

  // ── Tab header (live caption + view toggle; the page title lives on the
  // page shell, so no wordmark here) ──
  const pageHeader = (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', paddingBottom: 12, marginBottom: 18, flexWrap: 'wrap', gap: 10 }}>
      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, letterSpacing: '0.14em', color: 'var(--theme-secondary, #8099b0)' }}>{tickers.filter(Boolean).length} TICKERS TRACKED</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--theme-secondary, #8099b0)' }}>View</span>
        <div style={{ display: 'flex', border: '1px solid rgba(255,255,255,0.12)', background: 'var(--theme-surface, #0d1826)' }}>
          {([['radar', 'Catalyst Radar', Radar], ['timeline', 'Timeline', CalendarClock]] as const).map(([v, label, Icon], i) => {
            const on = view === v
            return (
              <button key={v} onClick={() => changeView(v)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 15px', border: 'none', borderLeft: i === 1 ? '1px solid rgba(255,255,255,0.12)' : 'none', cursor: 'pointer', background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)' : 'transparent', color: on ? 'var(--theme-primary, #c9a84c)' : '#7d8ea0', fontFamily: 'var(--theme-sans)', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                <Icon size={13} />{label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )

  // ── View 1: Catalyst Radar (proximity strip + one unified table) ──
  const radarCenter = (
    <>
      <div style={panel}>
        {panelHead('Catalyst Radar', isPending ? 'SCANNING…' : 'SORTED BY PROXIMITY')}
        <div style={{ display: 'flex', gap: 10, overflowX: 'auto', padding: '13px 12px' }}>
          {catalystsSorted.map(({ r, days }) => {
            const col = proximityColor(days)
            const d = parseDate(r.date)
            return (
              <div key={r.ticker} style={{ minWidth: 148, flex: '1 0 148px', background: 'var(--theme-surface, #0d1826)', border: '1px solid rgba(255,255,255,0.07)', borderTop: `2px solid ${col}`, padding: '11px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 26, fontWeight: 700, lineHeight: 1, color: col }}>{days == null ? '—' : `${days}d`}</span>
                  <span style={{ fontSize: 9, color: 'var(--theme-secondary, #8099b0)' }}>{d ? fmtMonthDay(d) : 'Unscheduled'}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 9 }}>
                  <TickerLogo ticker={r.ticker} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', fontSize: 12 }}>{r.ticker}</div>
                    <div style={{ fontSize: 9, color: 'var(--theme-secondary, #8099b0)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 108 }}>{r.name}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ ...LABEL, fontSize: 8 }}>Implied</span>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: BLUE }}>{r.impliedMove.toFixed(1)}%</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ ...LABEL, fontSize: 8 }}>1D</span>
                  <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: pctTone(r.pctChange) }}>{pctStr(r.pctChange)}</span>
                </div>
                <span style={{ alignSelf: 'flex-start' }}>{consensusNode(r.consensus)}</span>
              </div>
            )
          })}
          {catalystsSorted.length === 0 && <div style={{ padding: '8px 4px', fontSize: 11, color: 'var(--theme-text-faint, rgba(255,255,255,0.35))', letterSpacing: '0.1em' }}>{isPending ? 'SCANNING…' : 'No tickers.'}</div>}
        </div>
      </div>

      <div style={panel}>
        {panelHead('Upcoming Catalysts & Valuation', 'CATALYST · VALUATION · SHORT · INSIDER')}
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', minWidth: 820, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--theme-bg, #0a1628)' }}>
                {['Ticker', 'Trend', 'Next Catalyst', 'Implied', '1D %', 'Mkt Cap', 'Fwd P/E', 'Short %', 'Insider', 'Consensus'].map((h, i) => (
                  <th key={h} style={{ ...TH, textAlign: i >= 4 && i <= 7 ? 'right' : 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {withDays.map(({ r, days }) => {
                const col = proximityColor(days)
                const d = parseDate(r.date)
                const s = shortData[r.ticker]
                const ins = insiderSummary(r.ticker)
                const txs = insiderData[r.ticker]
                const isOpen = expanded[r.ticker]
                return (
                  <Fragment key={r.ticker}>
                    <tr onClick={() => txs && txs.length > 0 && toggleExpand(r.ticker)}
                      style={{ background: 'transparent', cursor: txs && txs.length > 0 ? 'pointer' : 'default' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--theme-hover, rgba(255,255,255,0.03))')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <td style={TD}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <TickerLogo ticker={r.ticker} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', fontSize: 13 }}>{r.ticker}</div>
                            <div style={{ fontSize: 9, color: 'var(--theme-secondary, #8099b0)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>{r.name}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ ...TD, padding: '4px 10px' }}><Sparkline data={r.sparkline} positive={(r.pctChange ?? 0) >= 0} /></td>
                      <td style={TD}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                          <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 12, fontWeight: 700, color: col }}>{days == null ? '—' : `${days}d`}</span>
                          <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-secondary, #8099b0)' }}>{d ? fmtMonthDay(d) : 'Unscheduled'}</span>
                        </div>
                        <div style={{ fontSize: 9, fontWeight: 700, color: BLUE, letterSpacing: '0.08em', marginTop: 2 }}>{r.horizon}</div>
                      </td>
                      <td style={TD}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{ width: 48, height: 4, background: 'var(--theme-hover, rgba(255,255,255,0.08))', overflow: 'hidden' }}>
                            <div style={{ width: `${Math.min(r.impliedMove / 8 * 100, 100)}%`, height: '100%', background: BLUE }} />
                          </div>
                          <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11 }}>{r.impliedMove.toFixed(1)}%</span>
                        </div>
                      </td>
                      <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--theme-mono)', fontSize: 11, color: pctTone(r.pctChange) }}>{pctStr(r.pctChange)}</td>
                      <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--theme-mono)', fontSize: 11 }}>{fmtCap(r.marketCap)}</td>
                      <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--theme-mono)', fontSize: 11 }}>{r.pe != null ? `${r.pe.toFixed(2)}x` : '—'}</td>
                      <td style={{ ...TD, textAlign: 'right', fontFamily: 'var(--theme-mono)', fontSize: 11 }}>{shortPending && !s ? '…' : (s?.shortPctFloat ?? '—')}</td>
                      <td style={{ ...TD, fontSize: 11, color: ins.color, fontWeight: 600 }}>
                        {ins.label}{txs && txs.length > 0 && <span style={{ marginLeft: 6, color: 'var(--theme-text-faint, rgba(255,255,255,0.3))', fontSize: 9 }}>{isOpen ? '▲' : '▼'}</span>}
                      </td>
                      <td style={TD}>{consensusNode(r.consensus)}</td>
                    </tr>
                    {isOpen && txs && txs.length > 0 && (
                      <tr>
                        <td colSpan={10} style={{ padding: 0, background: 'var(--theme-bg, #0a1628)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead><tr style={{ background: 'var(--theme-bg, #0a1628)' }}>{['Date', 'Insider', 'Title', 'Transaction', 'Shares', 'Value'].map(h => <th key={h} style={TH_S}>{h}</th>)}</tr></thead>
                            <tbody>
                              {txs.map((tx, i) => {
                                const c = tx.transaction === 'Sale' ? 'var(--theme-negative)' : tx.transaction === 'Purchase' ? 'var(--theme-positive)' : 'var(--theme-text, #d7e3fc)'
                                return (
                                  <tr key={i} onMouseEnter={e => (e.currentTarget.style.background = 'var(--theme-hover, rgba(255,255,255,0.03))')} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                                    <td style={TD_S}>{tx.date}</td>
                                    <td style={TD_S}>{tx.insider}</td>
                                    <td style={{ ...TD_S, color: 'var(--theme-secondary, #8099b0)' }}>{tx.title || 'Unknown'}</td>
                                    <td style={TD_S}><span style={{ color: c, fontWeight: 600 }}>{tx.transaction}</span></td>
                                    <td style={{ ...TD_S, fontFamily: 'var(--theme-mono)' }}>{tx.shares > 0 ? tx.shares.toLocaleString() : '—'}</td>
                                    <td style={{ ...TD_S, fontFamily: 'var(--theme-mono)' }}>{tx.value > 0 ? `$${(tx.value / 1e6).toFixed(2)}M` : '—'}</td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {isPending && rows.length === 0 && <tr><td colSpan={10} style={{ ...TD, textAlign: 'center', color: 'var(--theme-text-faint, rgba(255,255,255,0.35))', letterSpacing: '0.1em' }}>SCANNING…</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )

  // ── View 2: Timeline (month-grouped agenda) ──
  const timelineCenter = (
    <div style={panel}>
      {panelHead('Catalyst Timeline', 'UPCOMING · BY MONTH')}
      <div style={{ padding: '8px 16px 18px' }}>
        {monthBuckets.map(group => (
          <div key={group.label} style={{ marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <span style={{ ...LABEL, fontSize: 11, letterSpacing: '0.14em', color: 'var(--theme-primary, #c9a84c)' }}>{group.label}</span>
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: 'var(--theme-secondary, #8099b0)' }}>{group.items.length} event{group.items.length === 1 ? '' : 's'}</span>
              <span style={{ flex: 1, height: 1, background: 'var(--theme-border, rgba(255,255,255,0.08))' }} />
            </div>
            <div style={{ paddingLeft: 22, borderLeft: '1px solid rgba(255,255,255,0.1)', marginLeft: 6 }}>
              {group.items.map(({ r, days, d }) => {
                const col = proximityColor(days)
                const s = shortData[r.ticker]
                return (
                  <div key={r.ticker} style={{ position: 'relative', marginTop: 12 }}>
                    <span style={{ position: 'absolute', left: -27, top: 18, width: 9, height: 9, borderRadius: '50%', background: col, border: '2px solid var(--theme-bg, #101c2e)' }} />
                    <div style={{ background: 'var(--theme-surface, #0d1826)', border: '1px solid rgba(255,255,255,0.07)', borderLeft: `2px solid ${col}`, display: 'flex', alignItems: 'stretch' }}>
                      <div style={{ width: 74, flexShrink: 0, borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '10px 0', gap: 1 }}>
                        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 22, fontWeight: 700, color: 'var(--theme-text, #d7e3fc)', lineHeight: 1 }}>{d ? d.getDate() : '—'}</span>
                        <span style={{ ...LABEL, fontSize: 9, letterSpacing: '0.14em', color: 'var(--theme-secondary, #8099b0)' }}>{d ? d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase() : ''}</span>
                        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700, color: col }}>{days == null ? '' : `${days}d`}</span>
                      </div>
                      <div style={{ flex: 1, padding: '11px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <TickerLogo ticker={r.ticker} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <span style={{ fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', fontSize: 14 }}>{r.ticker}</span>
                              <span style={{ fontSize: 9, fontWeight: 700, color: BLUE, letterSpacing: '0.08em' }}>{r.horizon}</span>
                            </div>
                            <div style={{ fontSize: 9, color: 'var(--theme-secondary, #8099b0)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 170 }}>{r.name} · earnings</div>
                          </div>
                        </div>
                        <Sparkline data={r.sparkline} positive={(r.pctChange ?? 0) >= 0} />
                        <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                          {tlMetric('Implied', `${r.impliedMove.toFixed(1)}%`, BLUE)}
                          {tlMetric('1D', pctStr(r.pctChange), pctTone(r.pctChange))}
                          {tlMetric('Mkt Cap', fmtCap(r.marketCap))}
                          {tlMetric('Fwd P/E', r.pe != null ? `${r.pe.toFixed(2)}x` : '—')}
                          {tlMetric('Short %', shortPending && !s ? '…' : (s?.shortPctFloat ?? '—'))}
                          {consensusNode(r.consensus)}
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {rows.length === 0 && <div style={{ padding: '12px 2px', fontSize: 11, color: 'var(--theme-text-faint, rgba(255,255,255,0.35))', letterSpacing: '0.1em' }}>{isPending ? 'SCANNING…' : 'No tickers.'}</div>}
      </div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {pageHeader}
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', gap: 14, alignItems: isMobile ? 'stretch' : 'flex-start' }}>

        {/* Left sidebar */}
        <div style={{ width: isMobile ? '100%' : 196, flexShrink: 0, background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)' }}>
            <div style={{ ...LABEL, color: 'var(--theme-text, #d7e3fc)' }}>Scan Parameters</div>
          </div>
          <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
            <div>
              <div style={{ ...LABEL, marginBottom: 4 }}>Ticker Symbols</div>
              <TickerTagInput tickers={tickers} onChange={setTickers} />
              {portfolioTickers.length > 0 && (
                <button
                  onClick={() => { setTickers(portfolioTickers); runScan(portfolioTickers) }}
                  style={{
                    marginTop: 6, width: '100%', background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 12%, transparent)',
                    border: '1px solid color-mix(in srgb, var(--theme-primary) 35%, transparent)', color: 'var(--theme-primary, #c9a84c)',
                    fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700,
                    letterSpacing: '0.1em', textTransform: 'uppercase', padding: '5px 0', cursor: 'pointer',
                  }}
                >
                  ↓ Import Portfolio ({portfolioTickers.length})
                </button>
              )}
            </div>
            <div>
              <div style={{ ...LABEL, marginBottom: 4 }}>Sort By</div>
              <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...INPUT, cursor: 'pointer' }}>
                <option value="ticker">Ticker</option>
                <option value="impliedMove">Implied Move</option>
                <option value="pctChange">% Change</option>
                <option value="marketCap">Market Cap</option>
                <option value="pe">Forward P/E</option>
              </select>
            </div>
            <div>
              <div style={{ ...LABEL, marginBottom: 4 }}>Reporting Window</div>
              <select value={fiscalFilter} onChange={e => setFiscalFilter(e.target.value)} style={{ ...INPUT, cursor: 'pointer' }}>
                <option>All Horizons</option>
                <option>Confirmed Future Releases</option>
              </select>
            </div>
          </div>
          <div style={{ padding: 10, borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <PortfolioIO
              mode="tickers"
              tickers={tickers}
              onImportTickers={ts => setTickers(ts)}
              name="watchlist"
            />
            <button onClick={handleScan} disabled={isPending} style={{
              width: '100%', background: 'var(--theme-surface, #1f2a3d)', border: '1px solid var(--theme-primary, #c9a84c)', color: 'var(--theme-primary, #c9a84c)',
              fontFamily: 'inherit', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em',
              textTransform: 'uppercase', padding: '8px 0', cursor: isPending ? 'default' : 'pointer',
              opacity: isPending ? 0.6 : 1,
            }}>
              {isPending ? 'Scanning…' : 'Execute Scan'}
            </button>
          </div>
        </div>

        {/* Center: switchable view */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {view === 'radar' ? radarCenter : timelineCenter}
        </div>

        {/* Right: news panel */}
        <div style={{ width: isMobile ? '100%' : 248, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 0, maxHeight: isMobile ? undefined : 700 }}>

          {/* AI Brief section */}
          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid color-mix(in srgb, var(--theme-primary) 25%, transparent)', marginBottom: 8 }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid color-mix(in srgb, var(--theme-primary) 15%, transparent)', background: 'color-mix(in srgb, var(--theme-primary) 6%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)' }}>AI Intelligence</span>
              <button onClick={fetchAiBrief} disabled={aiBriefPending || rows.length === 0} style={{
                background: aiBriefPending ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)' : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)',
                border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)', color: 'var(--theme-primary, #c9a84c)',
                fontFamily: 'var(--theme-mono)', fontSize: 9,
                padding: '2px 8px', cursor: (aiBriefPending || rows.length === 0) ? 'default' : 'pointer',
                opacity: (aiBriefPending || rows.length === 0) ? 0.5 : 1,
                letterSpacing: '0.08em',
              }}>{aiBriefPending ? 'Thinking…' : 'Generate'}</button>
            </div>
            <div style={{ padding: '8px 10px' }}>
              {!aiBrief && !aiBriefPending && !aiBriefError && (
                <div style={{ fontSize: 10, color: 'var(--theme-secondary, #5e768f)', fontFamily: 'var(--theme-mono)', lineHeight: '15px' }}>
                  Click Generate for an AI-written market brief on your tracked tickers.
                </div>
              )}
              {aiBriefError && (
                <div style={{ fontSize: 9, color: 'var(--theme-negative)', fontFamily: 'var(--theme-mono)', lineHeight: '14px' }}>
                  {aiBriefError}
                </div>
              )}
              {aiBriefPending && (
                <div style={{ fontSize: 9, color: 'var(--theme-primary, #c9a84c)', opacity: 0.6, fontFamily: 'var(--theme-mono)' }}>Generating…</div>
              )}
              {aiBrief && !aiBriefPending && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 9, padding: '1px 5px', border: '1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent)', color: aiBrief.tone === 'bullish' ? 'var(--theme-positive)' : aiBrief.tone === 'bearish' ? 'var(--theme-negative)' : 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-mono)', textTransform: 'uppercase' }}>{aiBrief.tone}</span>
                  </div>
                  {aiBrief.bullets.map((b, i) => (
                    <div key={i} style={{ fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '15px', paddingLeft: 8, borderLeft: '2px solid color-mix(in srgb, var(--theme-primary) 30%, transparent)' }}>
                      {b}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* News feed */}
          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)' }}>
              <div style={{ ...LABEL, color: 'var(--theme-text, #d7e3fc)', marginBottom: 0 }}>Terminal Intelligence Brief</div>
              <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginTop: 2 }}>
                Live Desk — {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
            <div style={{ overflowY: 'auto', flex: 1, padding: 10 }}>
              {isPending && <div style={{ fontSize: 11, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', letterSpacing: '0.08em' }}>Loading feeds…</div>}
              {sorted.filter(r => r.news.length > 0).map(row => (
                <div key={row.ticker} style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <TickerLogo ticker={row.ticker} />
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', color: 'var(--theme-primary, #c9a84c)', textTransform: 'uppercase' }}>
                      {row.ticker} Wire
                    </span>
                  </div>
                  {row.news.map((n, i) => (
                    <div key={i} style={{ marginBottom: 8 }}>
                      <a href={safeUrl(n.link)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--theme-primary, #c9a84c)', fontSize: 11, fontWeight: 600, textDecoration: 'none', lineHeight: '15px', display: 'block' }}>
                        {n.title}
                      </a>
                      <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginTop: 2 }}>Source: {n.publisher}</div>
                    </div>
                  ))}
                  <div style={{ borderTop: '1px solid var(--theme-border-faint, rgba(255,255,255,0.05))', paddingTop: 4 }} />
                </div>
              ))}
            </div>
          </div>
        </div>

      </div>
    </div>
  )
}

export default function CorporateHub() {
  return <PageWrapper title="Corporate Catalysts"><CorporateHubContent /></PageWrapper>
}
