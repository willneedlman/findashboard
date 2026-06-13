import { useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import {
  TrendingUp, LineChart, Landmark, Bitcoin, BarChart2, Dices,
  GitBranch, Activity, Building2, Calculator, Network, Shuffle, Zap,
  ArrowUpRight, LayoutGrid, Filter, FileText, Upload, X,
  PieChart, Scale, Globe, BookOpen, Terminal, Brain, Bell,
  Briefcase, Layers, Compass, Search, Waves, Gauge, GitCompare,
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
    label: { fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)' } as React.CSSProperties,
    btn: { background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)', color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '5px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 } as React.CSSProperties,
    chip: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 7px', background: 'var(--theme-hover, rgba(255,255,255,0.04))', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-primary, #c9a84c)' } as React.CSSProperties,
    hint: { fontFamily: 'var(--theme-sans)', fontSize: 9, color: 'var(--theme-secondary, #5e768f)', lineHeight: 1.4 } as React.CSSProperties,
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
            CSV col 1: <span style={{ color: 'var(--theme-secondary, #7a9ab8)', fontFamily: 'var(--theme-mono)' }}>TICKER</span> · col 2: <span style={{ color: 'var(--theme-secondary, #7a9ab8)', fontFamily: 'var(--theme-mono)' }}>WEIGHT</span> · header rows auto-skipped · JSON: array of {'{ticker, weight}'}
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
            style={{ ...S.btn, background: 'color-mix(in srgb, var(--theme-negative) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-negative) 20%, transparent)', color: 'var(--theme-negative)' }}
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

const BENTO_CARDS: Card[] = [
  // ── Row 1: AI & Screening (wide+wide)
  { to: '/screener', icon: Filter,    size: 'wide', accent: '#2f6b4b', tag: 'SCREENER',
    title: 'Stock Screener',
    body: 'Filter the market by valuation, growth, profitability, and financial health across 25+ variables. Sortable results with full fundamentals.' },
  { to: '/earnings', icon: FileText,  size: 'wide', accent: '#7b5ea7', tag: 'AI RESEARCH',
    title: 'Earnings AI',
    body: 'Claude-powered earnings call summarizer. Turns transcripts, 10-Q/10-K financials, and SEC filings into bull/bear points, key metrics, and guidance in seconds.' },

  // ── Row 2: Core data + sentiment (wide+wide)
  { to: '/market',    icon: TrendingUp, size: 'wide', accent: 'var(--theme-tertiary, #1f5673)', tag: 'PRICE & VOL',
    title: 'Market Data',
    body: 'Historical price action, rolling 30-day volatility, and peak drawdown structural analysis. Entry point for any equity research session.' },
  { to: '/sentiment', icon: Brain,      size: 'wide', accent: '#7aa2f7', tag: 'SENTIMENT',
    title: 'Sentiment Tracker',
    body: 'AI-scored financial news across 7 sources with market-session filtering, entity extraction, macro impact tiers, and velocity tracking.' },
  { to: '/research-hub', icon: Search, size: 'wide', accent: '#7b5ea7', tag: 'RESEARCH HUB',
    title: 'Research Hub',
    body: 'One-stop research surface. Filings, fundamentals, news, and AI summaries tabbed into a single workspace.' },
  { to: '/compare', icon: GitCompare, size: 'wide', accent: '#60a5fa', tag: 'COMPARE',
    title: 'Asset Comparison',
    body: 'Overlay any assets on one normalized chart: stocks, ETFs, crypto, indices, FX, futures. Compare performance across price scales and timeframes.' },

  // ── Row 3: Valuation & Quant (4×normal)
  { to: '/corporate',          icon: Building2,  size: 'normal', accent: 'var(--theme-primary, #c9a84c)', tag: 'CORP',       title: 'Corporate Hub',       body: 'Earnings scanner, insider flow, short interest, and live news aggregator.' },
  { to: '/dcf',                icon: Calculator, size: 'normal', accent: '#7b5ea7',                       tag: 'VALUATION',  title: 'DCF Valuation',          body: 'Intrinsic value via DCF with WACC, terminal value, and sensitivity tables.' },
  { to: '/relative-valuation', icon: Scale,      size: 'normal', accent: '#d97736',                       tag: 'PEERS',      title: 'Peer Comparison',      body: 'Compare valuation multiples against sector peers. EV/EBITDA, P/E, P/S, forward estimates.' },
  { to: '/supply-chain',       icon: Globe,      size: 'normal', accent: '#2f6b4b',                       tag: 'PROFILE',    title: 'Company Profile',     body: 'Revenue breakdown, supplier exposure, geographic risk, and supply chain dependency map.' },

  // ── Row 4: Options suite (4×normal)
  { to: '/options',     icon: LineChart, size: 'normal', accent: 'var(--theme-tertiary, #1f5673)', tag: 'OPTIONS',   title: 'Options Pricer',       body: 'Black-Scholes pricing with full Greeks, payoff diagrams, and IV surface.' },
  { to: '/chain',       icon: BarChart2, size: 'normal', accent: '#7b5ea7',                       tag: 'CHAIN',     title: 'Options Chain Scanner',        body: 'Live options chains with IV rank, OI skew, and put/call ratios by strike.' },
  { to: '/probability', icon: Activity,  size: 'normal', accent: '#7b5ea7',                       tag: 'PROB',      title: 'Implied Probability',  body: 'Market-implied risk-neutral distributions derived from live options chains.' },
  { to: '/strategy',    icon: Shuffle,   size: 'normal', accent: '#d97736',                       tag: 'STRATEGY',  title: 'Strategy Builder',     body: 'Multi-leg options strategy builder with live P&L profiles and breakevens.' },
  { to: '/options-hub',     icon: Layers,   size: 'normal', accent: 'var(--theme-tertiary, #1f5673)', tag: 'OPTIONS HUB', title: 'Options Hub',          body: 'Unified options workspace. Pricing, chains, IV, and flow in one tabbed surface.' },
  { to: '/iv-tracker',      icon: Waves,    size: 'normal', accent: '#7aa2f7',                       tag: 'IV',          title: 'IV Tracker',           body: 'Implied volatility rank and percentile, term structure, and IV-vs-realized over time.' },
  { to: '/unusual-options', icon: Activity, size: 'normal', accent: '#d97736',                       tag: 'FLOW',        title: 'Options Flow',         body: 'Scan chains for volume and volume/OI surges, ranked by traded premium. Flags freshly-opened positioning.' },
  { to: '/market-maker',    icon: Gauge,    size: 'normal', accent: '#2f6b4b',                       tag: 'MM SIM',      title: 'Options MM Simulator',     body: 'Quote two-sided markets, manage inventory, and delta-hedge under simulated order flow.' },

  // ── Row 5: Derivatives & Rates (4×normal)
  { to: '/gex',               icon: Zap,        size: 'normal', accent: 'var(--theme-primary, #c9a84c)',  tag: 'GEX',          title: 'Dealer GEX',          body: 'Gamma exposure aggregated across all strikes and expiries.' },
  { to: '/bond',              icon: Landmark,   size: 'normal', accent: '#2f6b4b',                        tag: 'FIXED INCOME', title: 'Bond Analytics',      body: 'YTM, modified duration, convexity, and full cash flow schedules.' },
  { to: '/fed',               icon: GitBranch,  size: 'normal', accent: 'var(--theme-tertiary, #1f5673)', tag: 'MACRO',        title: 'Fed Rates',   body: 'Implied Fed path projections and rate scenario analysis across FOMC meetings.' },
  { to: '/macro-hub',         icon: Compass,    size: 'normal', accent: 'var(--theme-tertiary, #1f5673)', tag: 'MACRO HUB',    title: 'Macro Hub',           body: 'Key macro series on a single board: growth, inflation, and employment.' },

  // ── Row 6: Macro & Data (4×normal)
  { to: '/sector-rotation', icon: PieChart,   size: 'normal', accent: '#d97736',                       tag: 'SECTORS',      title: 'Sector Rotation',     body: 'Rolling performance heatmap across GICS sectors. Identify rotation leaders and laggards.' },
  { to: '/credit-spreads',  icon: Activity,   size: 'normal', accent: '#ef4444',                       tag: 'CREDIT',       title: 'Credit Spread Monitor',      body: 'IG and HY spread monitoring with historical context and risk-on/off signals.' },
  { to: '/correlation',     icon: Network,    size: 'normal', accent: 'var(--theme-tertiary, #1f5673)', tag: 'QUANT',        title: 'Correlation Matrix',  body: 'Rolling return correlation heatmap across any custom ticker basket.' },
  { to: '/nav',             icon: Bitcoin,    size: 'normal', accent: 'var(--theme-primary, #c9a84c)', tag: 'NAV',          title: 'NAV Tracker',         body: 'SOTP NAV engine with live MSTR Bitcoin holdings fetched from EDGAR.' },

  // ── Row 7: Portfolio & Simulation (4×normal)
  { to: '/montecarlo',     icon: Dices,     size: 'normal', accent: '#2f6b4b',                       tag: 'SIMULATION',  title: 'Monte Carlo',           body: 'GBM path simulation with VaR, CVaR, and percentile fan charts.' },
  { to: '/portfolio',      icon: BarChart2, size: 'normal', accent: '#2f6b4b',                       tag: 'BACKTEST',    title: 'Portfolio Backtester',  body: 'Backtest weighted equity baskets against any benchmark with Sharpe, Sortino, Calmar.' },
  { to: '/portfolio-manager', icon: Briefcase,   size: 'normal', accent: 'var(--theme-primary, #c9a84c)', tag: 'PORTFOLIO', title: 'Portfolio Manager',     body: 'Holdings, live P&L, position weights, and aggregated option greeks across the book.' },
  { to: '/alerts',         icon: Bell,      size: 'normal', accent: 'var(--theme-primary, #c9a84c)', tag: 'ALERTS',      title: 'Price Alerts',          body: 'Set price and 1-day % change alerts. Push to browser on trigger.' },

  // ── Row 8: Trading tools (4×normal)
  { to: '/trade-journal', icon: BookOpen,  size: 'normal', accent: '#7b5ea7',                       tag: 'JOURNAL',   title: 'Trade Journal',      body: 'Log and analyze your trades. Entry/exit tracking, P&L attribution, and win-rate stats.' },
  { to: '/paper-trading', icon: Terminal,  size: 'normal', accent: '#2f6b4b',                       tag: 'PAPER',     title: 'Paper Trading',      body: 'Simulated order execution with live prices, position tracking, and P&L.' },

  // ── Dashboard — full width
  { to: '/dashboard', icon: LayoutGrid, size: 'full' as CardSize, accent: 'var(--theme-primary, #c9a84c)', tag: 'CUSTOM',
    title: 'My Dashboard',
    body: 'Build your own terminal. Drag and arrange price cards, charts, news feeds, options snapshots, portfolio summaries, and macro strips. Layout persists per user account.' },
]

function sizeClass(size?: CardSize) {
  if (size === 'hero') return 'bento-hero'
  if (size === 'wide') return 'bento-wide'
  if (size === 'tall') return 'bento-tall'
  return ''
}

const TILE_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1]
const gridStagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.05 } },
}
const tileReveal = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.34, ease: TILE_EASE } },
}

function BentoCard({ card, reduce }: { card: Card; reduce: boolean }) {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const isHero = card.size === 'hero'
  const isTall = card.size === 'tall'

  return (
    <motion.div
      variants={reduce ? undefined : tileReveal}
      whileHover={reduce ? undefined : {
        y: -3,
        boxShadow: '0 10px 26px rgba(0,0,0,0.32)',
        backgroundColor: 'color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface, #0d1b30))',
      }}
      whileTap={reduce ? undefined : { y: -1, scale: 0.994 }}
      transition={{ duration: 0.18, ease: TILE_EASE }}
      onClick={() => navigate(card.to)}
      className={sizeClass(card.size)}
      style={{
        background: 'var(--theme-surface, #0d1b30)',
        border: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
        borderTop: '2px solid var(--theme-primary, #c9a84c)',
        padding: isMobile ? 12 : isHero ? 20 : 14,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        minHeight: isMobile ? 0 : isHero ? 220 : isTall ? 220 : 120,
        position: 'relative',
        overflow: 'hidden',
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
              color: 'var(--theme-text)',
              letterSpacing: '0.02em',
              fontFamily: 'var(--theme-sans)',
            }}>
              {card.title}
            </h3>
          </div>
          {card.tag && (
            <span style={{
              fontSize: 8, fontWeight: 700, letterSpacing: '0.16em',
              color: 'var(--theme-primary, #c9a84c)', fontFamily: 'var(--theme-sans)',
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: 'var(--theme-primary, #c9a84c)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'var(--theme-sans)' }}>
          OPEN <ArrowUpRight size={10} />
        </div>
      </div>
    </motion.div>
  )
}

export default function Home() {
  const isMobile = useIsMobile()
  const reduce = !!useReducedMotion()
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
          Alphatape Terminal
        </h1>
        <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, color: 'var(--theme-secondary, #7a9ab8)', letterSpacing: '0.04em' }}>
          {visibleCards.length} modules · Select a tile to launch
        </p>
      </div>

      {/* Bento grid */}
      <motion.div
        className="bento-grid"
        variants={reduce ? undefined : gridStagger}
        initial={reduce ? undefined : 'hidden'}
        animate={reduce ? undefined : 'show'}
      >
        {visibleCards.map(card => (
          <BentoCard key={card.to} card={card} reduce={reduce} />
        ))}
      </motion.div>

    </PageWrapper>
  )
}
