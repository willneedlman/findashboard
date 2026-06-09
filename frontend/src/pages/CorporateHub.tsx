import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { usePortfolio } from '../contexts/PortfolioContext'
import PageWrapper from '../components/PageWrapper'
import axios from 'axios'
import TickerTagInput from '../components/TickerTagInput'
import PortfolioIO from '../components/PortfolioIO'

interface TickerRow {
  ticker: string
  date: string; horizon: string
  impliedMove: number
  pe: number | null
  pctChange: number | null
  marketCap: number | null
  consensus: string; isConfirmed: boolean
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
  const color = positive ? '#22C55E' : '#EF4444'
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
  'Strong Buy':    { color: '#22C55E', border: '#22C55E' },
  'Moderate Buy':  { color: '#86efac', border: '#86efac' },
  'Hold':          { color: 'var(--theme-secondary, #99907e)', border: 'var(--theme-text-faint, rgba(255,255,255,0.18))' },
  'Underperform':  { color: '#EF4444', border: '#EF4444' },
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
      src={`https://assets.parqet.com/logos/symbol/${ticker}?format=png`}
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
      ticker: tk, date: d.date || '—', horizon: d.horizon || '—',
      impliedMove: d.implied_move ?? 4.5, pe: d.estimated_pe ?? null,
      pctChange: d.pct_change_1d ?? null, marketCap: d.market_cap ?? null,
      consensus: d.consensus || 'Hold', isConfirmed: d.is_confirmed ?? false,
      sparkline: d.sparkline ?? [],
      news: (d.news || []).slice(0, 2).map((n: any) => ({
        title: n.title || 'Market Update', link: n.link || '#', publisher: n.publisher || 'Financial Wire',
      })),
    }
  } catch {
    return { ticker: tk, date: '—', horizon: '—', impliedMove: 4.5, pe: null,
             pctChange: null, marketCap: null, consensus: 'Hold', isConfirmed: false, news: [], sparkline: [] }
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

function InsiderPanel({ sorted, insiderData, insiderPending }: {
  sorted: TickerRow[]
  insiderData: Record<string, InsiderTx[]>
  insiderPending: boolean
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const toggle = (tk: string) => setExpanded(p => ({ ...p, [tk]: !p[tk] }))

  return (
    <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ ...LABEL_S, color: '#ffffff' }}>Insider Transaction Flow</span>
        {insiderPending && <span style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)', letterSpacing: '0.1em' }}>FETCHING…</span>}
      </div>

      {/* Summary header */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 110px 90px 90px 24px', padding: '5px 10px', background: 'var(--theme-bg, #0a1628)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
        {['Ticker', 'Txns', 'Latest Move', 'Last Date', 'Total Value', ''].map(h => (
          <div key={h} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>{h}</div>
        ))}
      </div>

      {sorted.map(row => {
        const txs = insiderData[row.ticker]
        const isLoading = insiderPending && !txs
        const isOpen = expanded[row.ticker]

        // Summary stats
        const latest   = txs?.[0]
        const totalVal = txs?.reduce((s, t) => s + (t.value || 0), 0) ?? 0
        const latestTx = latest?.transaction ?? '—'
        const txColor  = latestTx === 'Sale' ? '#EF4444' : latestTx === 'Purchase' ? '#22C55E' : 'var(--theme-text, #d7e3fc)'

        return (
          <div key={row.ticker}>
            {/* Collapsed summary row */}
            <div
              onClick={() => txs && txs.length > 0 && toggle(row.ticker)}
              style={{
                display: 'grid', gridTemplateColumns: '1fr 90px 110px 90px 90px 24px',
                padding: '6px 10px', borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))',
                cursor: txs && txs.length > 0 ? 'pointer' : 'default', alignItems: 'center',
              }}
              onMouseEnter={e => { if (txs?.length) (e.currentTarget as HTMLElement).style.background = 'var(--theme-hover, rgba(255,255,255,0.03))' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <TickerLogo ticker={row.ticker} />
                <span style={{ fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', fontSize: 12 }}>{row.ticker}</span>
              </div>
              <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text, #d7e3fc)' }}>
                {isLoading ? <span style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>…</span> : (txs?.length ?? '—')}
              </div>
              <div>
                {isLoading ? <span style={{ fontSize: 11, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>…</span>
                  : latest ? <span style={{ fontSize: 11, fontWeight: 600, color: txColor }}>{latestTx}</span>
                  : <span style={{ fontSize: 11, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>No data</span>}
              </div>
              <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-secondary, #99907e)' }}>
                {isLoading ? '…' : (latest?.date ?? '—')}
              </div>
              <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text, #d7e3fc)' }}>
                {isLoading ? '…' : totalVal > 0 ? `$${(totalVal / 1e6).toFixed(1)}M` : '—'}
              </div>
              <div style={{ fontSize: 10, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', textAlign: 'center' }}>
                {txs && txs.length > 0 ? (isOpen ? '▲' : '▼') : ''}
              </div>
            </div>

            {/* Expanded detail table */}
            {isOpen && txs && txs.length > 0 && (
              <div style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: 520, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--theme-bg, #0a1628)' }}>
                      {['Date', 'Insider', 'Title', 'Transaction', 'Shares', 'Value'].map(h => (
                        <th key={h} style={TH_S}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {txs.map((tx, i) => {
                      const c = tx.transaction === 'Sale' ? '#EF4444' : tx.transaction === 'Purchase' ? '#22C55E' : 'var(--theme-text, #d7e3fc)'
                      return (
                        <tr key={i}
                          onMouseEnter={e => (e.currentTarget.style.background = 'var(--theme-hover, rgba(255,255,255,0.03))')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          <td style={TD_S}>{tx.date}</td>
                          <td style={TD_S}>{tx.insider}</td>
                          <td style={{ ...TD_S, color: 'var(--theme-secondary, #99907e)' }}>{tx.title || 'Unknown'}</td>
                          <td style={TD_S}><span style={{ color: c, fontWeight: 600 }}>{tx.transaction}</span></td>
                          <td style={{ ...TD_S, fontFamily: 'var(--theme-mono)' }}>{tx.shares > 0 ? tx.shares.toLocaleString() : '—'}</td>
                          <td style={{ ...TD_S, fontFamily: 'var(--theme-mono)' }}>{tx.value > 0 ? `$${(tx.value / 1e6).toFixed(2)}M` : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const LABEL_S: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }
const TH_S: React.CSSProperties    = { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', whiteSpace: 'nowrap' }
const TD_S: React.CSSProperties    = { padding: '5px 10px', borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.03))', fontSize: 11, color: 'var(--theme-text, #d7e3fc)', verticalAlign: 'middle' }

const LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }
const INPUT: React.CSSProperties = { background: 'var(--theme-bg, #0a1628)', border: '1px solid var(--theme-border, rgba(255,255,255,0.10))', color: 'var(--theme-text, #d7e3fc)', fontSize: 12, padding: '5px 8px', width: '100%', outline: 'none', fontFamily: 'inherit' }
const TH: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', whiteSpace: 'nowrap' }
const TD: React.CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--theme-hover, rgba(255,255,255,0.04))', fontSize: 12, color: 'var(--theme-text, #d7e3fc)', verticalAlign: 'middle' }

const DEFAULT_TICKERS = ['NVDA', 'AAPL', 'SLS', 'MSTR', 'TOST', 'VST', 'OWL', 'AMZN']

export function CorporateHubContent() {
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

  const [sortBy, setSortBy] = useState('ticker')
  const [fiscalFilter, setFiscalFilter] = useState('All Horizons')
  const [showShort, setShowShort]       = useState(true)
  const [showInsider, setShowInsider]   = useState(false)

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
    // Lazy supplemental fetches in parallel
    const extras: Promise<void>[] = []
    if (showShort) {
      extras.push((async () => {
        setShortPending(true)
        const pairs = await Promise.all(tickers.map(fetchShortTicker))
        setShortData(Object.fromEntries(pairs))
        setShortPending(false)
      })())
    }
    if (showInsider) {
      extras.push((async () => {
        setInsiderPending(true)
        const pairs = await Promise.all(tickers.map(fetchInsiderTicker))
        setInsiderData(Object.fromEntries(pairs))
        setInsiderPending(false)
      })())
    }
    await Promise.all(extras)
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

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>

        {/* Left sidebar */}
        <div style={{ width: 190, flexShrink: 0, background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)' }}>
            <div style={{ ...LABEL, color: '#ffffff' }}>Scan Parameters</div>
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
                    border: '1px solid rgba(201,168,76,0.35)', color: 'var(--theme-primary, #c9a84c)',
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showShort} onChange={e => setShowShort(e.target.checked)} style={{ accentColor: 'var(--theme-primary, #c9a84c)' }} />
                <span style={{ ...LABEL, color: 'var(--theme-text, #d7e3fc)' }}>Short Interest</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showInsider} onChange={e => setShowInsider(e.target.checked)} style={{ accentColor: 'var(--theme-primary, #c9a84c)' }} />
                <span style={{ ...LABEL, color: 'var(--theme-text, #d7e3fc)' }}>Insider Activity</span>
              </label>
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
              {isPending ? 'Scanning…' : '⬢ Execute Scan'}
            </button>
          </div>
        </div>

        {/* Center: tables */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Main table */}
          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ ...LABEL, color: '#ffffff' }}>Upcoming Catalysts & Valuation</span>
              {isPending && <span style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)', letterSpacing: '0.1em' }}>SCANNING…</span>}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 700, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--theme-bg, #0a1628)' }}>
                    {['Ticker', '30D', 'Date', 'Horizon', 'Implied Move', '1D %', 'Market Cap', 'Fwd P/E', 'Consensus', '✓'].map(h => (
                      <th key={h} style={TH}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(row => {
                    const cs = CONSENSUS_STYLE[row.consensus] ?? CONSENSUS_STYLE['Hold']
                    return (
                      <tr key={row.ticker} style={{ background: 'transparent' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--theme-hover, rgba(255,255,255,0.03))')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <td style={TD}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <TickerLogo ticker={row.ticker} />
                            <span style={{ fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', fontSize: 13 }}>{row.ticker}</span>
                          </div>
                        </td>
                        <td style={{ ...TD, padding: '4px 10px' }}>
                          <Sparkline data={row.sparkline} positive={(row.pctChange ?? 0) >= 0} />
                        </td>
                        <td style={{ ...TD, fontFamily: 'var(--theme-mono)', fontSize: 11 }}>{row.date}</td>
                        <td style={TD}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-tertiary, #9bcdef)', letterSpacing: '0.08em' }}>{row.horizon}</span>
                        </td>
                        <td style={TD}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <div style={{ width: 64, height: 4, background: 'var(--theme-hover, rgba(255,255,255,0.08))', borderRadius: 0, overflow: 'hidden' }}>
                              <div style={{ width: `${Math.min(row.impliedMove / 20 * 100, 100)}%`, height: '100%', background: 'var(--theme-tertiary, #1f5673)' }} />
                            </div>
                            <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 11 }}>{row.impliedMove.toFixed(1)}%</span>
                          </div>
                        </td>
                        <td style={{ ...TD, fontFamily: 'var(--theme-mono)', fontSize: 11,
                          color: row.pctChange == null ? '#4d4637' : row.pctChange >= 0 ? '#22C55E' : '#EF4444' }}>
                          {row.pctChange != null ? `${row.pctChange >= 0 ? '+' : ''}${row.pctChange.toFixed(2)}%` : '—'}
                        </td>
                        <td style={{ ...TD, fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-text, #d7e3fc)' }}>
                          {row.marketCap != null
                            ? row.marketCap >= 1e12 ? `$${(row.marketCap / 1e12).toFixed(2)}T`
                            : row.marketCap >= 1e9  ? `$${(row.marketCap / 1e9).toFixed(1)}B`
                            : `$${(row.marketCap / 1e6).toFixed(0)}M`
                            : '—'}
                        </td>
                        <td style={{ ...TD, fontFamily: 'var(--theme-mono)', fontSize: 11 }}>{row.pe != null ? `${row.pe.toFixed(2)}x` : '—'}</td>
                        <td style={TD}>
                          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: cs.color, border: `1px solid ${cs.border}`, padding: '2px 5px', textTransform: 'uppercase', whiteSpace: 'nowrap', display: 'inline-block' }}>
                            {row.consensus}
                          </span>
                        </td>
                        <td style={{ ...TD, textAlign: 'center', color: row.isConfirmed ? '#22C55E' : 'var(--theme-text-faint, rgba(255,255,255,0.18))' }}>
                          {row.isConfirmed ? '✓' : '—'}
                        </td>
                      </tr>
                    )
                  })}
                  {isPending && rows.length === 0 && (
                    <tr><td colSpan={9} style={{ ...TD, textAlign: 'center', color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', letterSpacing: '0.1em' }}>SCANNING…</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Short interest table */}
          {showShort && rows.length > 0 && (
            <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))' }}>
              <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))', background: 'var(--theme-surface, #142032)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ ...LABEL, color: '#ffffff' }}>Short Interest Monitor</span>
                {shortPending && <span style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)', letterSpacing: '0.1em' }}>FETCHING…</span>}
              </div>
              <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', minWidth: 400, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--theme-bg, #0a1628)' }}>
                    {['Ticker', 'Short % Float', 'Short Ratio (Days)', 'Shares Short'].map(h => (
                      <th key={h} style={TH}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(row => {
                    const s = shortData[row.ticker]
                    const dash = <span style={{ color: 'var(--theme-text-faint, rgba(255,255,255,0.22))' }}>—</span>
                    return (
                      <tr key={row.ticker}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--theme-hover, rgba(255,255,255,0.03))')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <td style={TD}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <TickerLogo ticker={row.ticker} />
                            <span style={{ fontWeight: 700, color: 'var(--theme-primary, #c9a84c)', fontSize: 13 }}>{row.ticker}</span>
                          </div>
                        </td>
                        <td style={{ ...TD, fontFamily: 'var(--theme-mono)', fontSize: 11 }}>{shortPending && !s ? '…' : (s?.shortPctFloat ?? dash)}</td>
                        <td style={{ ...TD, fontFamily: 'var(--theme-mono)', fontSize: 11 }}>{shortPending && !s ? '…' : (s?.shortRatio ?? dash)}</td>
                        <td style={{ ...TD, fontFamily: 'var(--theme-mono)', fontSize: 11 }}>{shortPending && !s ? '…' : (s?.sharesShort ?? dash)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>
          )}
          {/* Insider transactions */}
          {showInsider && rows.length > 0 && (
            <InsiderPanel sorted={sorted} insiderData={insiderData} insiderPending={insiderPending} />
          )}
        </div>

        {/* Right: news panel */}
        <div style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 0, maxHeight: 700 }}>

          {/* AI Brief section */}
          <div style={{ background: 'var(--theme-bg, #101c2e)', border: '1px solid rgba(201,168,76,0.25)', marginBottom: 8 }}>
            <div style={{ padding: '6px 10px', borderBottom: '1px solid rgba(201,168,76,0.15)', background: 'rgba(201,168,76,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: '#c9a84c' }}>⬢ AI Intelligence</span>
              <button onClick={fetchAiBrief} disabled={aiBriefPending || rows.length === 0} style={{
                background: aiBriefPending ? 'rgba(201,168,76,0.08)' : 'rgba(201,168,76,0.15)',
                border: '1px solid rgba(201,168,76,0.4)', color: '#c9a84c',
                fontFamily: 'var(--theme-mono)', fontSize: 9,
                padding: '2px 8px', cursor: (aiBriefPending || rows.length === 0) ? 'default' : 'pointer',
                opacity: (aiBriefPending || rows.length === 0) ? 0.5 : 1,
                letterSpacing: '0.08em',
              }}>{aiBriefPending ? 'Thinking…' : 'Generate'}</button>
            </div>
            <div style={{ padding: '8px 10px' }}>
              {!aiBrief && !aiBriefPending && !aiBriefError && (
                <div style={{ fontSize: 10, color: 'rgba(215,227,252,0.3)', fontFamily: 'var(--theme-mono)', lineHeight: '15px' }}>
                  Click Generate for an AI-written market brief on your tracked tickers.
                </div>
              )}
              {aiBriefError && (
                <div style={{ fontSize: 9, color: '#ef4444', fontFamily: 'var(--theme-mono)', lineHeight: '14px' }}>
                  {aiBriefError}
                </div>
              )}
              {aiBriefPending && (
                <div style={{ fontSize: 9, color: 'rgba(201,168,76,0.5)', fontFamily: 'var(--theme-mono)' }}>Generating…</div>
              )}
              {aiBrief && !aiBriefPending && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 9, padding: '1px 5px', border: '1px solid rgba(201,168,76,0.3)', color: aiBrief.tone === 'bullish' ? '#22c55e' : aiBrief.tone === 'bearish' ? '#ef4444' : '#c9a84c', fontFamily: 'var(--theme-mono)', textTransform: 'uppercase' }}>{aiBrief.tone}</span>
                  </div>
                  {aiBrief.bullets.map((b, i) => (
                    <div key={i} style={{ fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '15px', paddingLeft: 8, borderLeft: '2px solid rgba(201,168,76,0.3)' }}>
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
              <div style={{ ...LABEL, color: '#ffffff', marginBottom: 0 }}>Terminal Intelligence Brief</div>
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
                      <a href={safeUrl(n.link)} target="_blank" rel="noopener noreferrer" style={{ color: '#d97736', fontSize: 11, fontWeight: 600, textDecoration: 'none', lineHeight: '15px', display: 'block' }}>
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
  )
}

export default function CorporateHub() {
  return <PageWrapper><CorporateHubContent /></PageWrapper>
}
