import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  TrendingUp, LineChart, Landmark, Bitcoin, BarChart2, Dices,
  GitBranch, Activity, Building2, Calculator, Network, Shuffle, Zap,
  ArrowUpRight, LayoutGrid, Filter, FileText, Upload, X,
} from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import useIsMobile from '../hooks/useIsMobile'
import { usePortfolio, type PortfolioHolding } from '../contexts/PortfolioContext'

// ── Portfolio import strip ────────────────────────────────────────────────────
function parsePortfolioText(text: string, filename: string): PortfolioHolding[] | null {
  const lower = filename.toLowerCase()

  if (lower.endsWith('.json')) {
    try {
      const obj = JSON.parse(text)
      const arr = Array.isArray(obj) ? obj : (obj.assets ?? obj.tickers ?? null)
      if (!arr) return null
      if (typeof arr[0] === 'string')
        return (arr as string[]).map(t => ({ ticker: t.trim().toUpperCase(), weight: Math.round(100 / arr.length) }))
      return (arr as { ticker: string; weight?: number; strategy?: string }[]).map(a => ({
        ticker: String(a.ticker).toUpperCase().trim(),
        weight: Number(a.weight ?? 0),
        strategy: a.strategy,
      }))
    } catch { return null }
  }

  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const HEADER_WORDS = new Set(['ticker', 'symbol', 'weight', 'allocation', 'pct', 'percent', 'name', 'stock'])
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    const holdings: PortfolioHolding[] = []
    for (const line of lines) {
      const parts = line.split(',')
      const col1 = parts[0].trim()
      // Skip header rows: col1 is a known header word or col2 is non-numeric text
      if (HEADER_WORDS.has(col1.toLowerCase())) continue
      const ticker = col1.toUpperCase()
      if (!ticker) continue
      const weight = parseFloat(parts[1])
      holdings.push({ ticker, weight: isNaN(weight) ? 0 : weight, strategy: parts[2]?.trim() })
    }
    if (holdings.length === 0) return null
    // If weights are all 0 (ticker-only list), distribute evenly
    if (holdings.every(h => h.weight === 0))
      holdings.forEach(h => { h.weight = Math.round(100 / holdings.length) })
    return holdings
  }

  return null
}

function PortfolioImportStrip() {
  const { holdings, tickers, setHoldings, clearPortfolio } = usePortfolio()
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const parsed = parsePortfolioText(ev.target?.result as string, file.name)
      if (!parsed || parsed.length === 0) { alert('Could not parse file. Use CSV (ticker,weight) or JSON.'); return }
      setHoldings(parsed)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const S = {
    wrap: {
      background: 'var(--theme-bg, #080f1d)',
      border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)',
      borderLeft: '2px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)',
      padding: '10px 14px',
      marginBottom: 18,
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexWrap: 'wrap' as const,
    } as React.CSSProperties,
    label: { fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)' } as React.CSSProperties,
    btn: { background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)', color: 'var(--theme-primary, #c9a84c)', fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '5px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 } as React.CSSProperties,
    chip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: 'var(--theme-primary, #c9a84c)' } as React.CSSProperties,
    hint: { fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 9, color: 'var(--theme-secondary, #5e768f)', lineHeight: 1.4 } as React.CSSProperties,
  }

  return (
    <div style={S.wrap}>
      <input ref={fileRef} type="file" accept=".json,.csv,.txt" style={{ display: 'none' }} onChange={handleFile} />
      <span style={S.label}>Portfolio</span>

      {tickers.length === 0 ? (
        <>
          <button style={S.btn} onClick={() => fileRef.current?.click()}>
            <Upload size={10} /> Import
          </button>
          <span style={S.hint}>
            CSV col 1: <span style={{ color: 'var(--theme-secondary, #7a9ab8)', fontFamily: 'JetBrains Mono, monospace' }}>TICKER</span> · col 2: <span style={{ color: 'var(--theme-secondary, #7a9ab8)', fontFamily: 'JetBrains Mono, monospace' }}>WEIGHT</span> · header rows auto-skipped · JSON: array of {'{ticker, weight}'}
          </span>
        </>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', flex: 1 }}>
            {holdings.map(h => (
              <span key={h.ticker} style={S.chip}>
                {h.ticker}{h.weight > 0 ? <span style={{ color: 'var(--theme-secondary, #5e768f)', fontSize: 8 }}> {h.weight}%</span> : null}
              </span>
            ))}
          </div>
          <button style={S.btn} onClick={() => fileRef.current?.click()}><Upload size={10} /> Replace</button>
          <button
            onClick={clearPortfolio}
            style={{ ...S.btn, background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)', color: '#ef4444' }}
          >
            <X size={10} /> Clear
          </button>
        </>
      )}
    </div>
  )
}

// ── Bento card sizes ─────────────────────────────────────────────────────────
// 'wide' spans 2 columns, 'tall' spans 2 rows, 'hero' spans 2×2
type CardSize = 'normal' | 'wide' | 'tall' | 'hero'

interface Card {
  to: string
  icon: React.ElementType
  title: string
  body: string
  accent: string
  size?: CardSize
  tag?: string
}

// Layout: 4-col grid, each row sums to exactly 4 cols
// Row 1: [wide=2][wide=2]
// Row 2: [wide=2][wide=2]
// Row 3: [1][1][1][1]
// Row 4: [1][1][1][1]
// Row 5: [1][1][1][1]
// Row 6: [full=4]
const BENTO_CARDS: Card[] = [
  // Row 1 — AI & Screening
  { to: '/screener', icon: Filter,    size: 'wide', accent: '#2f6b4b', tag: 'SCREENER',
    title: 'Stock Screener',
    body: 'Filter the market by valuation, growth, profitability, and financial health across 25+ variables. Sortable results with full fundamentals.' },
  { to: '/earnings', icon: FileText,  size: 'wide', accent: '#7b5ea7', tag: 'AI RESEARCH',
    title: 'Earnings AI',
    body: 'Claude-powered earnings call summarizer — transcripts, 10-Q/10-K financials, and SEC filings turned into bull/bear points, key metrics, and guidance in seconds.' },

  // Row 2 — Core data
  { to: '/market',    icon: TrendingUp, size: 'wide', accent: 'var(--theme-tertiary, #1f5673)', tag: 'PRICE & VOL',
    title: 'Market Data',
    body: 'Historical price action, rolling 30-day volatility, and peak drawdown structural analysis. Entry point for any equity research session.' },

  // Row 3 — Valuation & Quant
  { to: '/corporate',   icon: Building2,  size: 'normal', accent: 'var(--theme-primary, #c9a84c)', tag: 'CORP',        title: 'Corporate Hub',       body: 'Earnings scanner, insider flow, short interest, and live news aggregator.' },
  { to: '/dcf',         icon: Calculator, size: 'normal', accent: '#7b5ea7', tag: 'VALUATION',   title: 'DCF Engine',          body: 'Intrinsic value via DCF with WACC, terminal value, and sensitivity tables.' },
  { to: '/correlation', icon: Network,    size: 'normal', accent: 'var(--theme-tertiary, #1f5673)', tag: 'QUANT',        title: 'Correlation Matrix',  body: 'Rolling return correlation heatmap across any custom ticker basket.' },
  { to: '/montecarlo',  icon: Dices,      size: 'normal', accent: '#2f6b4b', tag: 'SIMULATION',  title: 'Monte Carlo',         body: 'GBM path simulation with VaR, CVaR, and percentile fan charts.' },

  // Row 4 — Options suite
  { to: '/options',     icon: LineChart,  size: 'normal', accent: 'var(--theme-tertiary, #1f5673)', tag: 'OPTIONS',      title: 'Options Pricer',      body: 'Black-Scholes pricing with full Greeks, payoff diagrams, and IV surface.' },
  { to: '/chain',       icon: BarChart2,  size: 'normal', accent: '#7b5ea7', tag: 'CHAIN',        title: 'Chain Scanner',       body: 'Live options chains with IV rank, OI skew, and put/call ratios by strike.' },
  { to: '/probability', icon: Activity,   size: 'normal', accent: '#7b5ea7', tag: 'PROB',         title: 'Implied Probability', body: 'Market-implied risk-neutral distributions derived from live options chains.' },
  { to: '/strategy',    icon: Shuffle,    size: 'normal', accent: '#d97736', tag: 'STRATEGY',     title: 'Strategy Builder',    body: 'Multi-leg options strategy builder with live P&L profiles and breakevens.' },

  // Row 5 — Macro & Fixed Income
  { to: '/gex',  icon: Zap,       size: 'normal', accent: 'var(--theme-primary, #c9a84c)', tag: 'GEX',         title: 'Dealer GEX',        body: 'Gamma exposure aggregated across all strikes and expiries.' },
  { to: '/bond', icon: Landmark,  size: 'normal', accent: '#2f6b4b', tag: 'FIXED INCOME', title: 'Bond Analytics',    body: 'YTM, modified duration, convexity, and full cash flow schedules.' },
  { to: '/fed',  icon: GitBranch, size: 'normal', accent: 'var(--theme-tertiary, #1f5673)', tag: 'MACRO',        title: 'Macro Rate Engine', body: 'Implied Fed path projections and rate scenario analysis across FOMC meetings.' },
  { to: '/nav',  icon: Bitcoin,   size: 'normal', accent: 'var(--theme-primary, #c9a84c)', tag: 'NAV',          title: 'NAV Tracker',       body: 'SOTP NAV engine with live MSTR Bitcoin holdings fetched from EDGAR.' },

  // Row 6 — Dashboard (full width)
  { to: '/dashboard', icon: LayoutGrid, size: 'full' as CardSize, accent: 'var(--theme-primary, #c9a84c)', tag: 'CUSTOM',
    title: 'My Dashboard',
    body: 'Build your own terminal. Drag and arrange price cards, charts, news feeds, options snapshots, portfolio summaries, and macro strips. Layout persists per user account.' },
  { to: '/portfolio', icon: BarChart2,  size: 'wide', accent: '#2f6b4b', tag: 'BACKTEST',
    title: 'Portfolio Backtester',
    body: 'Backtest weighted equity baskets against any benchmark. Per-leg strategy overlays, Sharpe, Sortino, Calmar, and rolling beta.' },
]

function sizeClass(size?: CardSize) {
  if (size === 'hero') return 'bento-hero'
  if (size === 'wide') return 'bento-wide'
  if (size === 'tall') return 'bento-tall'
  return ''
}

function BentoCard({ card }: { card: Card }) {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const isHero = card.size === 'hero'
  const isTall = card.size === 'tall'

  return (
    <div
      onClick={() => navigate(card.to)}
      className={sizeClass(card.size)}
      style={{
        background: 'var(--theme-surface, #0d1b30)',
        border: '1px solid rgba(255,255,255,0.06)',
        borderTop: '2px solid var(--theme-primary, #c9a84c)',
        padding: isMobile ? 12 : isHero ? 20 : 14,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: isMobile ? 0 : isHero ? 220 : isTall ? 220 : 120,
        position: 'relative',
        overflow: 'hidden',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => {
        (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface, #0d1b30))'
      }}
      onMouseLeave={e => {
        (e.currentTarget as HTMLElement).style.background = 'var(--theme-surface, #0d1b30)'
      }}
    >
      {/* Content */}
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, marginBottom: isHero ? 10 : 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <card.icon size={isHero ? 18 : 14} style={{ color: 'var(--theme-primary, #c9a84c)', flexShrink: 0 }} />
            <h3 style={{
              fontSize: isHero ? 15 : 13,
              fontWeight: 700,
              color: '#e2e8f0',
              letterSpacing: '0.02em',
              fontFamily: 'IBM Plex Sans, sans-serif',
            }}>
              {card.title}
            </h3>
          </div>
          {card.tag && (
            <span style={{
              fontSize: 8, fontWeight: 700, letterSpacing: '0.16em',
              color: 'var(--theme-primary, #c9a84c)', fontFamily: 'IBM Plex Sans, sans-serif',
              opacity: 0.7, flexShrink: 0, paddingTop: 2,
            }}>
              {card.tag}
            </span>
          )}
        </div>
        <p style={{
          fontSize: isHero ? 12 : 11,
          color: 'var(--theme-secondary, #7a9ab8)',
          lineHeight: '16px',
          maxWidth: isHero ? 340 : '100%',
        }}>
          {card.body}
        </p>
      </div>

      {/* CTA */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: 'var(--theme-primary, #c9a84c)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'IBM Plex Sans, sans-serif' }}>
          OPEN <ArrowUpRight size={10} />
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  const isMobile = useIsMobile()
  const visibleCards = isMobile ? BENTO_CARDS.filter(c => c.to !== '/dashboard') : BENTO_CARDS

  return (
    <PageWrapper>
      {/* Hero strip */}
      <div style={{ marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)' }}>
        <h1 style={{
          fontFamily: 'Cinzel, Georgia, serif',
          fontSize: 22, fontWeight: 700, letterSpacing: '0.08em',
          color: 'var(--theme-primary, #c9a84c)', marginBottom: 4,
        }}>
          Financial Research Terminal
        </h1>
        <p style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 12, color: 'var(--theme-secondary, #7a9ab8)', letterSpacing: '0.04em' }}>
          {visibleCards.length} modules · Select a tile to launch
        </p>
      </div>

      {/* Bento grid */}
      <div className="bento-grid">
        {visibleCards.map(card => (
          <BentoCard key={card.to} card={card} />
        ))}
      </div>

    </PageWrapper>
  )
}
