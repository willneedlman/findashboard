import { useNavigate } from 'react-router-dom'
import {
  TrendingUp, LineChart, Landmark, Bitcoin, BarChart2, Dices,
  GitBranch, Activity, Building2, Calculator, Network, Shuffle, Zap,
  ArrowUpRight, LayoutGrid,
} from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import useIsMobile from '../hooks/useIsMobile'

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
  // Row 1
  {
    to: '/market', icon: TrendingUp, size: 'hero', accent: '#1f5673', tag: 'PRICE & VOL',
    title: 'Market Data',
    body: 'Historical price action, rolling 30-day volatility, and peak drawdown structural analysis. Entry point for any equity research session.',
  },
  {
    to: '/portfolio', icon: BarChart2, size: 'tall', accent: '#2f6b4b', tag: 'BACKTEST',
    title: 'Portfolio Backtester',
    body: 'Backtest weighted equity baskets against any benchmark. Per-leg strategy overlays, Sharpe, Sortino, Calmar, and rolling beta.',
  },
  {
    to: '/corporate', icon: Building2, size: 'normal', accent: '#c9a84c', tag: 'CORP',
    title: 'Corporate Hub',
    body: 'Earnings scanner, insider flow, short interest, and news aggregator.',
  },
  {
    to: '/dcf', icon: Calculator, size: 'normal', accent: '#7b5ea7', tag: 'VALUATION',
    title: 'DCF Engine',
    body: 'DCF with WACC, terminal value, and intrinsic price.',
  },
  // Row 2
  {
    to: '/options', icon: LineChart, size: 'wide', accent: '#1f5673', tag: 'OPTIONS',
    title: 'Options Pricer',
    body: 'Black-Scholes pricing with full Greek calculator and payoff diagrams. IV surface viewer.',
  },
  {
    to: '/montecarlo', icon: Dices, size: 'normal', accent: '#2f6b4b', tag: 'SIMULATION',
    title: 'Monte Carlo',
    body: 'GBM path simulation with VaR, CVaR, and percentile distribution.',
  },
  {
    to: '/correlation', icon: Network, size: 'normal', accent: '#1f5673', tag: 'QUANT',
    title: 'Correlation Matrix',
    body: 'Rolling correlation heatmap across any custom basket.',
  },
  // Row 3
  {
    to: '/chain', icon: BarChart2, size: 'normal', accent: '#7b5ea7', tag: 'CHAIN',
    title: 'Chain Scanner',
    body: 'Live chains with IV rank, OI skew, and put/call ratio by strike.',
  },
  {
    to: '/probability', icon: Activity, size: 'normal', accent: '#7b5ea7', tag: 'PROB',
    title: 'Implied Probability',
    body: 'Risk-neutral distributions from live options chains.',
  },
  {
    to: '/strategy', icon: Shuffle, size: 'wide', accent: '#d97736', tag: 'STRATEGY',
    title: 'Strategy Builder',
    body: 'Build and visualise multi-leg options strategies with live P&L profiles and breakeven analysis.',
  },
  // Row 4
  {
    to: '/gex', icon: Zap, size: 'normal', accent: '#c9a84c', tag: 'GEX',
    title: 'Dealer GEX',
    body: 'Gamma exposure aggregated across all expiries.',
  },
  {
    to: '/bond', icon: Landmark, size: 'normal', accent: '#2f6b4b', tag: 'FIXED INCOME',
    title: 'Bond Analytics',
    body: 'YTM, duration, convexity, and cash flow schedules.',
  },
  {
    to: '/fed', icon: GitBranch, size: 'normal', accent: '#1f5673', tag: 'MACRO',
    title: 'Macro Rate Engine',
    body: 'Implied Fed path projections across FOMC meetings.',
  },
  {
    to: '/nav', icon: Bitcoin, size: 'normal', accent: '#c9a84c', tag: 'NAV',
    title: 'NAV Tracker',
    body: 'SOTP NAV engine with live MSTR Bitcoin holdings from EDGAR.',
  },
  {
    to: '/dashboard', icon: LayoutGrid, size: 'wide', accent: '#c9a84c', tag: 'CUSTOM',
    title: 'My Dashboard',
    body: 'Build your own terminal. Add price cards, charts, news feeds, watchlists, and macro data — drag to arrange, persists across sessions.',
  },
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
        background: '#0d1b30',
        border: '1px solid rgba(255,255,255,0.06)',
        borderTop: `2px solid ${card.accent}`,
        padding: isMobile ? 12 : isHero ? 20 : 14,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        // On mobile let content determine height; on desktop enforce minimums
        minHeight: isMobile ? 0 : isHero ? 220 : isTall ? 220 : 120,
        position: 'relative',
        overflow: 'hidden',
        transition: 'background 0.15s',
      }}
      onMouseEnter={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = '#142032'
        el.style.borderTopColor = card.accent
      }}
      onMouseLeave={e => {
        const el = e.currentTarget as HTMLElement
        el.style.background = '#0d1b30'
      }}
    >
      {/* Tag chip */}
      <div style={{
        position: 'absolute', top: 10, right: 10,
        fontSize: 8, fontWeight: 700, letterSpacing: '0.16em',
        color: card.accent, fontFamily: 'IBM Plex Sans, sans-serif',
        opacity: 0.7,
      }}>
        {card.tag}
      </div>

      {/* Content */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: isHero ? 10 : 6 }}>
          <card.icon size={isHero ? 18 : 14} style={{ color: card.accent, flexShrink: 0 }} />
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
        <p style={{
          fontSize: isHero ? 12 : 11,
          color: '#5e768f',
          lineHeight: '16px',
          maxWidth: isHero ? 340 : '100%',
        }}>
          {card.body}
        </p>
      </div>

      {/* CTA */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, color: card.accent, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', fontFamily: 'IBM Plex Sans, sans-serif' }}>
          OPEN <ArrowUpRight size={10} />
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  return (
    <PageWrapper>
      {/* Hero strip */}
      <div style={{ marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid rgba(201,168,76,0.15)' }}>
        <h1 style={{
          fontFamily: 'Cinzel, Georgia, serif',
          fontSize: 22, fontWeight: 700, letterSpacing: '0.08em',
          color: '#c9a84c', marginBottom: 4,
        }}>
          Financial Research Terminal
        </h1>
        <p style={{ fontFamily: 'IBM Plex Sans, sans-serif', fontSize: 12, color: '#5e768f', letterSpacing: '0.04em' }}>
          14 modules · Select a tile to launch
        </p>
      </div>

      {/* Bento grid */}
      <div className="bento-grid">
        {BENTO_CARDS.map(card => (
          <BentoCard key={card.to} card={card} />
        ))}
      </div>
    </PageWrapper>
  )
}
