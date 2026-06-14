import { useRef, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import {
  TrendingUp, LineChart, Landmark, Bitcoin, BarChart2, Dices,
  GitBranch, Activity, Building2, Calculator, Shuffle, Zap,
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

// ── Module catalog ────────────────────────────────────────────────────────────
// Grouped to match the sidebar taxonomy. Descriptors are terse on purpose: this
// is a launcher for a user who knows the tools, not a marketing page.
interface Mod { to: string; icon: React.ElementType; title: string; desc: string; accent: string }
interface Section { label: string; mods: Mod[] }

const FEATURED: Mod = {
  to: '/dashboard', icon: LayoutGrid, accent: 'var(--theme-primary, #c9a84c)',
  title: 'My Dashboard',
  desc: 'Build your own terminal. Drag price cards, charts, news, options snapshots, and macro strips into a layout that persists per account.',
}

const SECTIONS: Section[] = [
  {
    label: 'Research & Data',
    mods: [
      { to: '/screener',     icon: Filter,     title: 'Stock Screener',          desc: '25+ fundamental filters',        accent: '#2f6b4b' },
      { to: '/market',       icon: TrendingUp, title: 'Market Data',             desc: 'Price, volatility, drawdown',    accent: 'var(--theme-tertiary, #1f5673)' },
      { to: '/sentiment',    icon: Brain,      title: 'Sentiment Tracker',       desc: 'AI news across 7 sources',       accent: '#7aa2f7' },
      { to: '/research-hub', icon: Search,     title: 'Research Hub',            desc: 'Filings, fundamentals, news, AI', accent: '#7b5ea7' },
      { to: '/earnings',     icon: FileText,   title: 'Earnings AI',             desc: 'AI call and filing summaries',   accent: '#7b5ea7' },
      { to: '/regression',   icon: Activity,   title: 'Regression & Correlation', desc: 'OLS, correlation, beta',        accent: '#7aa2f7' },
      { to: '/compare',      icon: GitCompare, title: 'Asset Comparison',        desc: 'Overlay assets on one chart',    accent: '#60a5fa' },
      { to: '/sector-rotation', icon: PieChart, title: 'Sector Rotation',        desc: 'GICS performance heatmap',       accent: '#d97736' },
    ],
  },
  {
    label: 'Valuation & Company',
    mods: [
      { to: '/valuation',          icon: Calculator, title: 'Stock Valuation',  desc: 'DCF, DDM, SOTP, multiples',      accent: '#7b5ea7' },
      { to: '/relative-valuation', icon: Scale,      title: 'Peer Comparison',  desc: 'Multiples vs sector peers',      accent: '#d97736' },
      { to: '/supply-chain',       icon: Globe,      title: 'Company Profile',  desc: 'Revenue, supply chain, geo',     accent: '#2f6b4b' },
      { to: '/corporate',          icon: Building2,  title: 'Corporate Hub',    desc: 'Earnings, insiders, short interest', accent: 'var(--theme-primary, #c9a84c)' },
    ],
  },
  {
    label: 'Options & Derivatives',
    mods: [
      { to: '/options-hub',     icon: Layers,    title: 'Options Hub',           desc: 'Pricing, chains, IV, flow',     accent: 'var(--theme-tertiary, #1f5673)' },
      { to: '/options',         icon: LineChart, title: 'Options Pricer',        desc: 'Black-Scholes greeks, payoff',  accent: 'var(--theme-tertiary, #1f5673)' },
      { to: '/chain',           icon: BarChart2, title: 'Options Chain Scanner', desc: 'Live chains, IV rank, skew',    accent: '#7b5ea7' },
      { to: '/iv-tracker',      icon: Waves,     title: 'IV Tracker',            desc: 'IV rank, term structure',       accent: '#7aa2f7' },
      { to: '/unusual-options', icon: Activity,  title: 'Options Flow',          desc: 'Volume and OI surges',          accent: '#d97736' },
      { to: '/probability',     icon: Activity,  title: 'Implied Probability',   desc: 'Risk-neutral distributions',    accent: '#7b5ea7' },
      { to: '/strategy',        icon: Shuffle,   title: 'Strategy Builder',      desc: 'Multi-leg P&L profiles',        accent: '#d97736' },
      { to: '/gex',             icon: Zap,       title: 'Dealer GEX',            desc: 'Gamma exposure by strike',      accent: 'var(--theme-primary, #c9a84c)' },
      { to: '/market-maker',    icon: Gauge,     title: 'Options MM Simulator',  desc: 'Two-sided quoting, hedging',    accent: '#2f6b4b' },
    ],
  },
  {
    label: 'Macro & Rates',
    mods: [
      { to: '/fed',            icon: GitBranch, title: 'Fed Rates',             desc: 'Implied FOMC path',             accent: 'var(--theme-tertiary, #1f5673)' },
      { to: '/macro-hub',      icon: Compass,   title: 'Macro Hub',             desc: 'Growth, inflation, jobs',       accent: 'var(--theme-tertiary, #1f5673)' },
      { to: '/bond',           icon: Landmark,  title: 'Bond Analytics',        desc: 'YTM, duration, convexity',      accent: '#2f6b4b' },
      { to: '/credit-spreads', icon: Activity,  title: 'Credit Spread Monitor', desc: 'IG and HY spreads',             accent: '#ef4444' },
      { to: '/nav',            icon: Bitcoin,   title: 'NAV Tracker',           desc: 'Premium/discount on proxies',   accent: 'var(--theme-primary, #c9a84c)' },
    ],
  },
  {
    label: 'Portfolio & Simulation',
    mods: [
      { to: '/portfolio',         icon: BarChart2, title: 'Portfolio Backtester', desc: 'Sharpe, Sortino, Calmar',    accent: '#2f6b4b' },
      { to: '/montecarlo',        icon: Dices,     title: 'Monte Carlo',          desc: 'GBM paths, VaR, CVaR',       accent: '#2f6b4b' },
      { to: '/portfolio-compare', icon: Scale,     title: 'Compare Portfolios',   desc: '2-4 books side by side',     accent: '#7aa2f7' },
      { to: '/portfolio-manager', icon: Briefcase, title: 'Portfolio Manager',    desc: 'Holdings, P&L, greeks',      accent: 'var(--theme-primary, #c9a84c)' },
    ],
  },
  {
    label: 'Trading & Journal',
    mods: [
      { to: '/paper-trading', icon: Terminal, title: 'Paper Trading', desc: 'Simulated live execution',    accent: '#2f6b4b' },
      { to: '/trade-journal', icon: BookOpen, title: 'Trade Journal', desc: 'Entry/exit, P&L, win rate',   accent: '#7b5ea7' },
      { to: '/alerts',        icon: Bell,     title: 'Price Alerts',  desc: 'Price and % change alerts',   accent: 'var(--theme-primary, #c9a84c)' },
    ],
  },
]

const TILE_EASE: [number, number, number, number] = [0.23, 1, 0.32, 1]
const gridStagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.02, delayChildren: 0.03 } },
}
const tileReveal = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: TILE_EASE } },
}

function ModTile({ mod, reduce, featured = false }: { mod: Mod; reduce: boolean; featured?: boolean }) {
  const navigate = useNavigate()
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const active = hover || focus
  const Icon = mod.icon

  return (
    <motion.div
      variants={reduce ? undefined : tileReveal}
      whileHover={reduce ? undefined : { y: -2 }}
      whileTap={reduce ? undefined : { scale: 0.995 }}
      transition={{ duration: 0.16, ease: TILE_EASE }}
      onClick={() => navigate(mod.to)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      role="button"
      aria-label={`${mod.title}. ${mod.desc}`}
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(mod.to) } }}
      style={{
        gridColumn: featured ? '1 / -1' : undefined,
        background: featured
          ? (active
              ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 10%, var(--theme-surface, #0d1826))'
              : 'color-mix(in srgb, var(--theme-primary, #c9a84c) 6%, var(--theme-surface, #0d1826))')
          : (active
              ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 5%, var(--theme-surface, #0d1826))'
              : 'var(--theme-surface, #0d1826)'),
        border: '1px solid ' + (
          active
            ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 42%, transparent)'
            : featured
              ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)'
              : 'var(--theme-border, rgba(255,255,255,0.08))'
        ),
        boxShadow: focus ? '0 0 0 2px color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)' : 'none',
        padding: featured ? '14px 16px' : '11px 13px',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: featured ? 6 : 4,
        position: 'relative',
        outline: 'none',
        transition: 'background 0.14s ease, border-color 0.14s ease, box-shadow 0.14s ease',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Icon size={featured ? 16 : 14} style={{ color: mod.accent, flexShrink: 0 }} />
        <h3 style={{
          fontSize: featured ? 14 : 12.5,
          fontWeight: 700,
          color: 'var(--theme-text, #d7e3fc)',
          letterSpacing: '0.01em',
          fontFamily: 'var(--theme-sans)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          minWidth: 0,
        }}>
          {mod.title}
        </h3>
        <ArrowUpRight
          size={13}
          style={{
            marginLeft: 'auto',
            flexShrink: 0,
            color: 'var(--theme-primary, #c9a84c)',
            opacity: active ? 0.9 : 0,
            transform: active ? 'translate(1px, -1px)' : 'none',
            transition: 'opacity 0.14s ease, transform 0.14s ease',
          }}
        />
      </div>
      <p style={{
        fontSize: featured ? 11.5 : 11,
        color: 'var(--theme-secondary, #8099b0)',
        lineHeight: 1.45,
        fontFamily: 'var(--theme-sans)',
        margin: 0,
        maxWidth: featured ? 460 : '100%',
      }}>
        {mod.desc}
      </p>
    </motion.div>
  )
}

function SectionBlock({ section, reduce }: { section: Section; reduce: boolean }) {
  return (
    <div style={{ marginTop: 22 }}>
      {/* Section header: tiny gold tick (the scalpel), label, count, hairline rule */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ width: 5, height: 5, background: 'var(--theme-primary, #c9a84c)', flexShrink: 0 }} />
        <span style={{
          fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700,
          letterSpacing: '0.16em', textTransform: 'uppercase',
          color: 'var(--theme-secondary, #8099b0)', whiteSpace: 'nowrap',
        }}>
          {section.label}
        </span>
        <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: 'var(--theme-secondary, #5e768f)', opacity: 0.7 }}>
          {section.mods.length}
        </span>
        <div style={{ flex: 1, height: 1, background: 'var(--theme-border, rgba(255,255,255,0.07))' }} />
      </div>

      <motion.div
        variants={reduce ? undefined : gridStagger}
        initial={reduce ? undefined : 'hidden'}
        animate={reduce ? undefined : 'show'}
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(212px, 1fr))',
          gap: 10,
        }}
      >
        {section.mods.map(m => <ModTile key={m.to} mod={m} reduce={reduce} />)}
      </motion.div>
    </div>
  )
}

export default function Home() {
  const isMobile = useIsMobile()
  const reduce = !!useReducedMotion()
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)

  const ql = q.trim().toLowerCase()
  const totalCount = useMemo(() => SECTIONS.reduce((n, s) => n + s.mods.length, 0) + 1, [])

  const sections = useMemo(() => {
    if (!ql) return SECTIONS
    return SECTIONS
      .map(s => ({ ...s, mods: s.mods.filter(m => `${m.title} ${m.desc} ${s.label}`.toLowerCase().includes(ql)) }))
      .filter(s => s.mods.length > 0)
  }, [ql])

  const matchCount = sections.reduce((n, s) => n + s.mods.length, 0)
  const featuredMatches = !isMobile && (!ql || `${FEATURED.title} ${FEATURED.desc}`.toLowerCase().includes(ql))

  return (
    <PageWrapper>
      {/* Hero: wordmark + filter */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between',
        gap: 16, flexWrap: 'wrap',
        marginBottom: 14, paddingBottom: 14,
        borderBottom: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 15%, transparent)',
      }}>
        <div>
          <h1 style={{
            fontFamily: 'Cinzel, Georgia, serif',
            fontSize: 22, fontWeight: 700, letterSpacing: '0.08em',
            color: 'var(--theme-primary, #c9a84c)', marginBottom: 4,
          }}>
            Alphatape Terminal
          </h1>
          <p style={{ fontFamily: 'var(--theme-sans)', fontSize: 12, color: 'var(--theme-secondary, #8099b0)', letterSpacing: '0.04em' }}>
            {ql ? `${matchCount} of ${totalCount} modules` : `${totalCount} modules · ${SECTIONS.length} categories`}
          </p>
        </div>

        {/* Filter */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--theme-bg, #101c2e)',
          border: `1px solid ${focused ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 55%, transparent)' : 'var(--theme-border, rgba(255,255,255,0.09))'}`,
          padding: '7px 11px', minWidth: 240, transition: 'border-color 0.15s ease',
        }}>
          <Search size={13} style={{ color: 'var(--theme-secondary, #5e768f)', flexShrink: 0 }} />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            aria-label="Filter modules"
            placeholder="Filter modules…"
            style={{
              background: 'transparent', border: 'none', outline: 'none',
              color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-sans)', fontSize: 12,
              width: '100%', letterSpacing: '0.02em',
            }}
          />
          {q && (
            <button
              onClick={() => setQ('')}
              aria-label="Clear filter"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--theme-secondary, #5e768f)', display: 'flex', padding: 0 }}
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Featured workspace */}
      {featuredMatches && (
        <motion.div
          variants={reduce ? undefined : gridStagger}
          initial={reduce ? undefined : 'hidden'}
          animate={reduce ? undefined : 'show'}
          style={{ display: 'grid', gridTemplateColumns: '1fr' }}
        >
          <ModTile mod={FEATURED} reduce={reduce} featured />
        </motion.div>
      )}

      {/* Sections */}
      {sections.map(s => <SectionBlock key={s.label} section={s} reduce={reduce} />)}

      {/* Empty state */}
      {ql && matchCount === 0 && !featuredMatches && (
        <div style={{
          marginTop: 40, textAlign: 'center',
          fontFamily: 'var(--theme-sans)', fontSize: 12,
          color: 'var(--theme-secondary, #8099b0)',
        }}>
          No modules match <span style={{ color: 'var(--theme-text, #d7e3fc)', fontFamily: 'var(--theme-mono)' }}>{q}</span>
        </div>
      )}

      {/* Portfolio import — page footer */}
      <div style={{ marginTop: 26 }}>
        <PortfolioImportStrip />
      </div>
    </PageWrapper>
  )
}
