import { useRef, useState, useEffect } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { motion, useReducedMotion, useScroll, useTransform, useSpring, useMotionValue, useInView, animate, type Variants } from 'framer-motion'
import { Calculator, GitBranch, BarChart3, BookOpen, Bell, Activity, Clock, ArrowLeftRight, Landmark, Terminal, Workflow } from 'lucide-react'
import AlphaMark from '../components/AlphaMark'
import './marketing.css'

/* ── Motion layer (strong ease-out, reduced-motion aware) ── */

const EASE: [number, number, number, number] = [0.23, 1, 0.32, 1]
const MLink = motion(Link)   // motion-enabled router Link (defined once)

// Reliable "in view once" with a guaranteed-visible fallback. IntersectionObserver
// drives the reveal on scroll; a timeout safety-net ensures content is never left
// hidden if the observer never fires (reveals must enhance a visible default).
function useInViewOnce<T extends Element>() {
  const ref = useRef<T>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') { setShown(true); return }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setShown(true); io.disconnect() } }, { threshold: 0.12 })
    io.observe(el)
    const t = window.setTimeout(() => setShown(true), 1400)   // safety net
    return () => { io.disconnect(); clearTimeout(t) }
  }, [])
  return { ref, shown }
}

// Scroll-reveal: fade + rise as it enters the viewport. Movement is dropped under
// reduced-motion; the opacity fade (which aids comprehension) is kept.
function Reveal({ children, y = 24, delay = 0, className, style }: { children: React.ReactNode; y?: number; delay?: number; className?: string; style?: React.CSSProperties }) {
  const reduce = useReducedMotion()
  const { ref, shown } = useInViewOnce<HTMLDivElement>()
  return (
    <motion.div ref={ref} className={className} style={style}
      initial={false}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: reduce ? 0 : y }}
      transition={{ duration: 0.7, ease: EASE, delay }}>
      {children}
    </motion.div>
  )
}

// Staggered container that triggers reliably in view. Children carry `variants={item}`.
function StaggerGroup({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  const { ref, shown } = useInViewOnce<HTMLDivElement>()
  const container: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } } }
  return (
    <motion.div ref={ref} className={className} style={style} variants={container} initial={false} animate={shown ? 'show' : 'hidden'}>
      {children}
    </motion.div>
  )
}

// Staggered container/item variants for orchestrated reveals.
const useStagger = (): { container: Variants; item: Variants } => {
  const reduce = useReducedMotion()
  return {
    container: { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } } },
    item: { hidden: { opacity: 0, y: reduce ? 0 : 18 }, show: { opacity: 1, y: 0, transition: { duration: 0.65, ease: EASE } } },
  }
}

// Numbers that count up from zero when scrolled into view.
function CountUp({ to, suffix = '', prefix = '', className }: { to: number; suffix?: string; prefix?: string; className?: string }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-60px' })
  const [val, setVal] = useState(reduce ? to : 0)
  useEffect(() => {
    if (!inView || reduce) { setVal(to); return }
    const controls = animate(0, to, { duration: 1.1, ease: EASE, onUpdate: v => setVal(Math.round(v)) })
    return () => controls.stop()
  }, [inView, to, reduce])
  return <span ref={ref} className={className}>{prefix}{val}{suffix}</span>
}

// Magnetic hover: element eases toward the cursor with spring momentum (decorative,
// desktop-pointer only, touch never fires mousemove). Disabled under reduced motion.
function Magnetic({ children, strength = 0.35 }: { children: React.ReactNode; strength?: number }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLSpanElement>(null)
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const sx = useSpring(x, { stiffness: 160, damping: 12, mass: 0.4 })
  const sy = useSpring(y, { stiffness: 160, damping: 12, mass: 0.4 })
  if (reduce) return <span style={{ display: 'inline-block' }}>{children}</span>
  return (
    <motion.span ref={ref} style={{ x: sx, y: sy, display: 'inline-block' }}
      onMouseMove={e => { const r = ref.current!.getBoundingClientRect(); x.set((e.clientX - (r.left + r.width / 2)) * strength); y.set((e.clientY - (r.top + r.height / 2)) * strength) }}
      onMouseLeave={() => { x.set(0); y.set(0) }}>
      {children}
    </motion.span>
  )
}

// 3D tilt card: rotates toward the cursor on a spring, with a quiet lift. Replaces
// the CSS hover-lift so transforms don't fight. Reduced motion → static.
function TiltCard({ to, className, children, item }: { to: string; className: string; children: React.ReactNode; item?: Variants }) {
  const reduce = useReducedMotion()
  const ref = useRef<HTMLAnchorElement>(null)
  const rx = useSpring(useMotionValue(0), { stiffness: 200, damping: 18 })
  const ry = useSpring(useMotionValue(0), { stiffness: 200, damping: 18 })
  const lift = useSpring(useMotionValue(0), { stiffness: 200, damping: 22 })
  const onMove = (e: React.MouseEvent) => {
    if (reduce) return
    const r = ref.current!.getBoundingClientRect()
    const px = (e.clientX - r.left) / r.width - 0.5
    const py = (e.clientY - r.top) / r.height - 0.5
    ry.set(px * 6); rx.set(-py * 6); lift.set(20)
  }
  const onLeave = () => { rx.set(0); ry.set(0); lift.set(0) }
  return (
    <MLink ref={ref} to={to} className={className} variants={item}
      onMouseMove={onMove} onMouseLeave={onLeave}
      style={{ rotateX: rx, rotateY: ry, z: lift, transformPerspective: 900, transformStyle: 'preserve-3d' }}>
      {children}
    </MLink>
  )
}

/* ── Shared chrome ──────────────────────────────────────────────────────── */

type Active = 'research' | 'options' | 'macro' | 'charting' | 'trading' | 'valuation' | null

/** α + vertical rule + ALPHATAPE / TERMINAL lockup (matches the terminal header). */
function BrandLockup({ markSize = 30 }: { markSize?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      {/* Fixed brand gold: the marketing site must not inherit the user's
          terminal theme preset (AlphaMark defaults to --theme-primary). */}
      <AlphaMark size={markSize} color="#c9a84c" style={{ display: 'block' }} />
      <span aria-hidden="true" style={{ width: 1, height: Math.round(markSize * 0.92), background: 'rgba(201,168,76,0.28)', margin: '0 13px' }} />
      <span style={{ display: 'block', lineHeight: 1, textAlign: 'left' }}>
        <span style={{ display: 'block', fontFamily: "'Cinzel', Georgia, serif", fontWeight: 700, fontSize: Math.round(markSize * 0.62), letterSpacing: '0.09em', color: 'var(--gold)' }}>ALPHATAPE</span>
        <span style={{ display: 'block', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontWeight: 700, fontSize: Math.round(markSize * 3.1) / 10, letterSpacing: '0.34em', color: 'var(--muted)', marginTop: Math.round(markSize * 0.1) }}>TERMINAL</span>
      </span>
    </span>
  )
}

const HUB_LINKS: { to: string; key: Active; label: string }[] = [
  { to: '/product/research', key: 'research', label: 'Research' },
  { to: '/product/options', key: 'options', label: 'Options' },
  { to: '/product/macro', key: 'macro', label: 'Macro' },
  { to: '/product/charting', key: 'charting', label: 'Charting' },
  { to: '/product/trading', key: 'trading', label: 'Trading' },
  { to: '/product/valuation', key: 'valuation', label: 'Valuation' },
]

function Nav({ active }: { active: Active }) {
  return (
    <nav><div className="nav-in">
      <Link to="/" aria-label="AlphaTape Terminal" style={{ textDecoration: 'none' }}><BrandLockup markSize={30} /></Link>
      <div className="nav-links">
        {HUB_LINKS.map(l => <Link key={l.key} to={l.to} className={active === l.key ? 'active' : undefined}>{l.label}</Link>)}
        <Link to="/app" className="btn btn-gold">Launch Terminal →</Link>
      </div>
    </div></nav>
  )
}

function Footer() {
  return (
    <footer><div className="wrap foot">
      <div className="col">
        <Link to="/" aria-label="AlphaTape Terminal" style={{ display: 'inline-block', marginBottom: 14, textDecoration: 'none' }}><BrandLockup markSize={28} /></Link>
        <p className="disc">Market analytics for independent traders. Not investment advice. For research and educational use only.</p>
      </div>
      <div className="col"><h4>Hubs</h4>
        {HUB_LINKS.map(l => <Link key={l.key} to={l.to}>{l.label}</Link>)}
      </div>
      <div className="col"><h4>Resources</h4>
        <Link to="/data-sources">Data sources</Link>
        <Link to="/app">Launch terminal</Link>
      </div>
      <div className="col"><h4>Legal</h4>
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
        <Link to="/risk-disclosure">Risk disclosure</Link>
      </div>
    </div></footer>
  )
}

function Shell({ active, children }: { active: Active; children: React.ReactNode }) {
  return (
    <div className="mkt">
      <Nav active={active} />
      {children}
      <Footer />
    </div>
  )
}

// Layout route: wraps legal pages in the marketing chrome (no terminal sidebar).
export function MarketingShell() {
  return (
    <div className="mkt">
      <Nav active={null} />
      <Outlet />
      <Footer />
    </div>
  )
}

const LaunchCTAs = ({ secondary }: { secondary?: { to: string; label: string } }) => (
  <div className="cta">
    <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
    {secondary && <Link to={secondary.to} className="btn btn-ghost btn-lg">{secondary.label}</Link>}
  </div>
)

/* Page hero shared by the six hub pages. */
function PageHero({ eyebrow, h1, lede, back }: { eyebrow: string; h1: string; lede: string; back?: string }) {
  return (
    <header className="phero"><div className="wrap">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{h1}</h1>
      <p className="lede">{lede}</p>
      <div className="cta"><LaunchCTAs secondary={{ to: back ?? '/', label: 'Overview' }} /></div>
    </div></header>
  )
}

/* Reusable preview panel. */
function VPanel({ title, tag = 'preview', desc, tags, children }: { title: string; tag?: string; desc?: string; tags?: string[]; children: React.ReactNode }) {
  return (
    <div className="vpanel">
      <div className="vh"><span className="vt">{title}</span><span className="vtag">{tag}</span></div>
      <div className="vb">{children}</div>
      {desc && <p className="vd">{desc}</p>}
      {tags && <div className="vtags">{tags.map(t => <span className="tag" key={t}>{t}</span>)}</div>}
    </div>
  )
}

const Mod = ({ icon: Icon, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) => (
  <div className="mod"><div className="mh"><span className="mi"><Icon size={15} /></span><h4>{title}</h4></div><p>{children}</p></div>
)

/* ── Viz library ─────────────────────────────────────────────────────────── */

const vizBox: React.CSSProperties = { width: '100%', height: 96, display: 'block' }
const miniTh: React.CSSProperties = { fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--dim)', padding: '6px 4px', borderBottom: '1px solid var(--line)' }
const miniTd: React.CSSProperties = { fontSize: 11, padding: '6px 4px' }

function MiniFlow() {
  const rows: [string, string, string, 'pos' | 'neg'][] = [
    ['NVDA 1300C', '8.4', '$18.4M', 'pos'], ['SPY 605C', '3.1', '$9.1M', 'pos'],
    ['TSLA 400P', '2.0', '$6.2M', 'neg'], ['AAPL 230C', '1.9', '$4.0M', 'pos'],
  ]
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)' }}>
      <thead><tr><th style={{ ...miniTh, textAlign: 'left' }}>Contract</th><th style={{ ...miniTh, textAlign: 'right' }}>Vol/OI</th><th style={{ ...miniTh, textAlign: 'right' }}>Premium</th></tr></thead>
      <tbody>{rows.map(([c, vo, p, d]) => (
        <tr key={c}>
          <td style={{ ...miniTd, color: 'var(--text)', fontWeight: 700 }}>{c}</td>
          <td className={d} style={{ ...miniTd, textAlign: 'right' }}>{vo}</td>
          <td style={{ ...miniTd, textAlign: 'right', color: 'var(--muted)' }}>{p}</td>
        </tr>
      ))}</tbody>
    </table>
  )
}

const GammaProfile = () => {
  const bars = [-7, -13, -19, -9, 5, 17, 25, 15, 8, -4]
  return (
    <svg viewBox="0 0 240 96" style={vizBox} role="img" aria-label="Dealer gamma by strike">
      <line x1="0" y1="48" x2="240" y2="48" stroke="rgba(255,255,255,0.12)" />
      {bars.map((v, i) => { const x = 9 + i * 23, h = Math.abs(v) * 1.55, y = v >= 0 ? 48 - h : 48; return <rect key={i} x={x} y={y} width="15" height={h} rx="1.5" fill={v >= 0 ? 'rgba(63,185,80,0.7)' : 'rgba(248,81,73,0.7)'} /> })}
    </svg>
  )
}

const SkewCurve = () => (
  <svg viewBox="0 0 240 96" style={vizBox} role="img" aria-label="Implied volatility skew">
    <line x1="120" y1="10" x2="120" y2="86" stroke="rgba(255,255,255,0.08)" strokeDasharray="2 3" />
    <polyline points="10,26 58,50 116,66 172,54 230,30" fill="none" stroke="#6c8cff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ProbDist = () => (
  <svg viewBox="0 0 240 96" style={vizBox} role="img" aria-label="Implied probability distribution">
    <path d="M8,86 C66,86 86,16 120,16 C154,16 174,86 232,86" fill="rgba(201,168,76,0.12)" stroke="#c9a84c" strokeWidth="1.8" />
    <line x1="156" y1="16" x2="156" y2="86" stroke="rgba(255,255,255,0.12)" />
  </svg>
)

const heat = (v: number) => v >= 0 ? `rgba(63,185,80,${0.16 + 0.55 * v})` : `rgba(248,81,73,${0.16 + 0.55 * Math.abs(v)})`

const SensitivityGrid = () => {
  const cells = []
  for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) { const v = ((c + (4 - r)) / 8) * 2 - 1; cells.push({ k: `${r}-${c}`, v }) }
  return <div className="heat" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>{cells.map(({ k, v }) => <div key={k} className="hc" style={{ background: heat(v) }}>{(v >= 0 ? '+' : '') + Math.round(v * 28)}</div>)}</div>
}

const CorrHeatmap = () => {
  const m = [[1, .62, .55, .78, -.41], [.62, 1, .60, .81, -.38], [.55, .60, 1, .74, -.30], [.78, .81, .74, 1, -.52], [-.41, -.38, -.30, -.52, 1]]
  const cc = (v: number) => v >= 0 ? `rgba(108,140,255,${0.14 + 0.6 * v})` : `rgba(248,81,73,${0.14 + 0.6 * Math.abs(v)})`
  return <div className="heat" style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>{m.flatMap((row, r) => row.map((v, c) => <div key={`${r}-${c}`} className="hc" style={{ background: v > 0.999 ? 'rgba(201,168,76,0.5)' : cc(v) }}>{v.toFixed(2)}</div>))}</div>
}

const EquityCurve = ({ grow }: { grow?: boolean }) => {
  const svg = (
    <svg viewBox="0 0 240 80" preserveAspectRatio={grow ? 'none' : 'xMidYMid meet'}
      style={grow ? { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' } : { width: '100%', height: 80, display: 'block' }}
      role="img" aria-label="Equity curve">
      <defs><linearGradient id="eqg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgba(63,185,80,0.28)" /><stop offset="1" stopColor="rgba(63,185,80,0)" /></linearGradient></defs>
      <path d="M4,68 L40,60 L76,64 L112,46 L148,50 L184,30 L236,12 L236,80 L4,80 Z" fill="url(#eqg)" />
      <polyline points="4,68 40,60 76,64 112,46 148,50 184,30 236,12" fill="none" stroke="#3fb950" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
    </svg>
  )
  return grow ? <div style={{ position: 'relative', flex: 1, minHeight: 90, marginTop: 14 }}>{svg}</div> : svg
}

// Monte Carlo: percentile cone (gold median inside a widening blue band).
const PercentileCone = ({ grow }: { grow?: boolean }) => {
  const svg = (
    <svg viewBox="0 0 260 80" preserveAspectRatio={grow ? 'none' : 'xMidYMid meet'}
      style={grow ? { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' } : { width: '100%', height: 80, display: 'block' }}
      role="img" aria-label="Monte Carlo percentile cone">
      <path d="M6,40 L70,30 L134,21 L200,13 L256,7 L256,73 L200,67 L134,59 L70,50 Z" fill="rgba(108,140,255,0.16)" />
      <polyline points="6,40 70,30 134,21 200,13 256,7" fill="none" stroke="rgba(108,140,255,0.5)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <polyline points="6,40 70,50 134,59 200,67 256,73" fill="none" stroke="rgba(108,140,255,0.5)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <polyline points="6,40 70,37 134,33 200,30 256,27" fill="none" stroke="#c9a84c" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      <circle cx="6" cy="40" r="2.6" fill="#c9a84c" />
    </svg>
  )
  return grow ? <div style={{ position: 'relative', flex: 1, minHeight: 90, marginTop: 16 }}>{svg}</div> : svg
}

// NAV Tracker: net-contribution bars (blue) with the NAV line (gold) on top.
const NavBars = ({ grow }: { grow?: boolean }) => {
  const bars = [22, 30, 26, 38, 34, 46, 42, 58]
  const svg = (
    <svg viewBox="0 0 240 80" preserveAspectRatio={grow ? 'none' : 'xMidYMid meet'}
      style={grow ? { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' } : { width: '100%', height: 80, display: 'block' }}
      role="img" aria-label="NAV over net contributions">
      <line x1="0" y1="68" x2="240" y2="68" stroke="rgba(255,255,255,0.08)" />
      {bars.map((h, i) => { const x = 10 + i * 28; return <rect key={i} x={x} y={68 - h} width="15" height={h} rx="1.5" fill="rgba(108,140,255,0.3)" /> })}
      <polyline points="17,54 45,49 73,50 101,40 129,41 157,28 185,30 213,16" fill="none" stroke="#c9a84c" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
      {([[17, 54], [73, 50], [129, 41], [185, 30], [213, 16]] as [number, number][]).map(([x, y]) => <circle key={x} cx={x} cy={y} r="2.2" fill="#0a1320" stroke="#c9a84c" strokeWidth="1.3" vectorEffect="non-scaling-stroke" />)}
    </svg>
  )
  return grow ? <div style={{ position: 'relative', flex: 1, minHeight: 90, marginTop: 14 }}>{svg}</div> : svg
}

// Trade journal: distribution of closed-trade P&L.
const PnlHistogram = ({ grow }: { grow?: boolean }) => {
  const buckets = [4, 9, 17, 23, 13, 21, 29, 22, 12, 6]
  const zero = 4
  const max = Math.max(...buckets)
  const line = 8 + zero * 23 - 3.5
  const svg = (
    <svg viewBox="0 0 240 80" preserveAspectRatio={grow ? 'none' : 'xMidYMid meet'}
      style={grow ? { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block' } : { width: '100%', height: 80, display: 'block' }}
      role="img" aria-label="Distribution of closed-trade profit and loss">
      <line x1="0" y1="70" x2="240" y2="70" stroke="rgba(255,255,255,0.08)" />
      {buckets.map((v, i) => { const x = 8 + i * 23, h = (v / max) * 56; return <rect key={i} x={x} y={70 - h} width="16" height={h} rx="1.5" fill={i >= zero ? 'rgba(63,185,80,0.7)' : 'rgba(248,81,73,0.7)'} /> })}
      <line x1={line} y1="8" x2={line} y2="72" stroke="rgba(255,255,255,0.16)" strokeDasharray="2 3" />
    </svg>
  )
  return grow ? <div style={{ position: 'relative', flex: 1, minHeight: 90, marginTop: 14 }}>{svg}</div> : svg
}

const YieldCurveBig = () => (
  <svg viewBox="0 0 520 150" preserveAspectRatio="none" style={{ width: '100%', height: 150, display: 'block' }} role="img" aria-label="UST yield curve">
    <defs><linearGradient id="ycg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgba(201,168,76,0.22)" /><stop offset="1" stopColor="rgba(201,168,76,0)" /></linearGradient></defs>
    {[34, 74, 114].map(y => <line key={y} x1="0" y1={y} x2="520" y2={y} stroke="rgba(255,255,255,0.04)" />)}
    <line x1="0" y1="136" x2="520" y2="136" stroke="rgba(255,255,255,0.08)" />
    <path d="M10,118 L100,112 L200,74 L300,52 L410,34 L510,22 L510,136 L10,136 Z" fill="url(#ycg)" />
    <polyline points="10,118 100,112 200,74 300,52 410,34 510,22" fill="none" stroke="#c9a84c" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    {([[10, 118], [100, 112], [200, 74], [300, 52], [410, 34], [510, 22]] as [number, number][]).map(([x, y]) => <circle key={x} cx={x} cy={y} r="3.4" fill="#0a1320" stroke="#c9a84c" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />)}
  </svg>
)

// SEP projections as median tick + range band per horizon. Deliberately no
// per-participant dots: the terminal itself only plots FRED medians and ranges.
const SepBands = () => {
  const cols: [string, number, number, number][] = [['2025', 30, 58, 44], ['2026', 38, 66, 52], ['2027', 44, 72, 58], ['LR', 50, 74, 62]]
  return (
    <svg viewBox="0 0 240 96" style={vizBox} role="img" aria-label="SEP rate projections, median and range">
      {cols.map(([l, top, bot, med], i) => {
        const x = 36 + i * 56
        return (
          <g key={l}>
            <line x1={x} y1={top} x2={x} y2={bot} stroke="rgba(108,140,255,0.45)" strokeWidth="7" strokeLinecap="round" />
            <line x1={x - 9} y1={med} x2={x + 9} y2={med} stroke="#c9a84c" strokeWidth="2.4" />
            <text x={x} y="92" textAnchor="middle" style={{ fontFamily: 'var(--mono)', fontSize: 8.5, fill: 'var(--dim)' }}>{l}</text>
          </g>
        )
      })}
    </svg>
  )
}

// FX matrix corner: spot crosses with day change.
const FxGrid = () => {
  const rows: [string, string, 'pos' | 'neg'][] = [['EUR/USD', '1.082', 'pos'], ['USD/JPY', '156.4', 'neg'], ['GBP/USD', '1.268', 'pos'], ['DXY', '104.9', 'neg']]
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)' }}>
      <tbody>{rows.map(([p, v, d]) => (
        <tr key={p}>
          <td style={{ ...miniTd, color: 'var(--text)', fontWeight: 700 }}>{p}</td>
          <td style={{ ...miniTd, textAlign: 'right', color: 'var(--muted)' }}>{v}</td>
          <td className={d} style={{ ...miniTd, textAlign: 'right' }}>{d === 'pos' ? '+0.3%' : '-0.4%'}</td>
        </tr>
      ))}</tbody>
    </table>
  )
}

// Asset Overlay: two normalized series from a common base.
const CompareViz = () => (
  <svg viewBox="0 0 240 96" style={vizBox} role="img" aria-label="Two assets rebased to 100">
    <line x1="0" y1="58" x2="240" y2="58" stroke="rgba(255,255,255,0.08)" strokeDasharray="2 3" />
    <polyline points="6,58 44,52 82,44 120,48 158,32 196,26 234,14" fill="none" stroke="#c9a84c" strokeWidth="1.8" strokeLinejoin="round" />
    <polyline points="6,58 44,60 82,54 120,62 158,56 196,64 234,58" fill="none" stroke="#6c8cff" strokeWidth="1.6" strokeLinejoin="round" />
    <circle cx="6" cy="58" r="2.6" fill="var(--text)" />
    <text x="8" y="78" style={{ fontFamily: 'var(--mono)', fontSize: 8.5, fill: 'var(--dim)' }}>REBASED TO 100</text>
  </svg>
)

// Chart Studio: candles + two overlays on their own scales, wide.
const OverlayChartBig = () => (
  <svg viewBox="0 0 520 170" preserveAspectRatio="none" style={{ width: '100%', height: 170, display: 'block' }} role="img" aria-label="Candlestick chart with overlay series on independent axes">
    {[40, 85, 130].map(y => <line key={y} x1="0" y1={y} x2="520" y2={y} stroke="rgba(255,255,255,0.04)" />)}
    <line x1="0" y1="150" x2="520" y2="150" stroke="rgba(255,255,255,0.08)" />
    {([[30, 78, 112, 'p'], [70, 68, 104, 'p'], [110, 74, 118, 'n'], [150, 60, 96, 'p'], [190, 50, 88, 'p'], [230, 58, 100, 'n'], [270, 44, 82, 'p'], [310, 36, 72, 'p'], [350, 44, 84, 'n'], [390, 30, 66, 'p'], [430, 22, 58, 'p'], [470, 28, 64, 'n'], [500, 18, 50, 'p']] as [number, number, number, string][]).map(([x, t, b, d]) => (
      <g key={x}>
        <line x1={x} y1={t - 9} x2={x} y2={b + 9} stroke={d === 'p' ? '#3fb950' : '#f85149'} strokeWidth="1.2" />
        <rect x={x - 6} y={t} width="12" height={b - t} fill={d === 'p' ? 'rgba(63,185,80,0.85)' : 'rgba(248,81,73,0.85)'} rx="1.5" />
      </g>
    ))}
    <polyline points="10,128 90,118 170,122 250,104 330,108 410,88 510,80" fill="none" stroke="#6c8cff" strokeWidth="1.8" strokeLinejoin="round" />
    <polyline points="10,52 90,60 170,46 250,52 330,38 410,44 510,30" fill="none" stroke="rgba(192,132,252,0.85)" strokeWidth="1.6" strokeDasharray="5 4" strokeLinejoin="round" />
  </svg>
)

// Market Maker: your two-sided quote around mid with a working inventory row.
const LadderRows = () => {
  const rows: [string, string, string][] = [['ASK', '101.42', 'x 240'], ['MID', '101.38', ''], ['BID', '101.34', 'x 180']]
  return (
    <div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)' }}>
        <tbody>{rows.map(([s, p, q]) => (
          <tr key={s}>
            <td style={{ ...miniTd, color: s === 'MID' ? 'var(--dim)' : 'var(--text)', fontWeight: 700, fontSize: 10 }}>{s}</td>
            <td className={s === 'ASK' ? 'neg' : s === 'BID' ? 'pos' : ''} style={{ ...miniTd, textAlign: 'right', color: s === 'MID' ? 'var(--muted)' : undefined }}>{p}</td>
            <td style={{ ...miniTd, textAlign: 'right', color: 'var(--dim)', fontSize: 10 }}>{q}</td>
          </tr>
        ))}</tbody>
      </table>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 4px 0', borderTop: '1px solid var(--line)', fontFamily: 'var(--mono)', fontSize: 10.5 }}>
        <span style={{ color: 'var(--dim)' }}>INVENTORY</span><span className="neg">-120 Δ</span>
      </div>
    </div>
  )
}

/* Chain Scanner: the live chain around the money, in a terminal window. */
function ChainTerm() {
  const rows: [string, string, string, string, string, boolean][] = [
    ['600 C', '0.72', '14.2', '18.40 / 18.55', '41,208', false],
    ['605 C', '0.58', '13.1', '14.90 / 15.05', '62,340', false],
    ['610 C', '0.46', '12.4', '11.85 / 12.00', '88,102', true],
    ['615 C', '0.35', '12.0', '9.10 / 9.25', '54,881', false],
    ['620 C', '0.26', '11.8', '6.80 / 6.95', '47,210', false],
  ]
  return (
    <div className="term">
      <div className="tbar"><i></i><i></i><i></i><span className="name">chain scanner · spy</span></div>
      <div className="thead"><span className="t">Chain Scanner</span><span className="tag-prev">preview</span></div>
      <table>
        <thead><tr><th>Strike</th><th>Delta</th><th>IV</th><th>Bid / Ask</th><th>Open int</th></tr></thead>
        <tbody>
          {rows.map(([s, d, iv, ba, oi, atm]) => (
            <tr key={s} style={atm ? { background: 'rgba(201,168,76,0.06)' } : undefined}>
              <td>{s}{atm ? ' · ATM' : ''}</td><td>{d}</td><td>{iv}</td><td>{ba}</td><td>{oi}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* Stock Screener: active filters plus the result set, in a terminal window. */
function ScreenerTerm() {
  const rows: [string, string, string, string, string, 'pos' | 'neg'][] = [
    ['NVDA', 'Technology', '39.9', '60.4%', '+65.5%', 'pos'],
    ['MSFT', 'Technology', '25.9', '45.6%', '+14.9%', 'pos'],
    ['LLY', 'Healthcare', '41.9', '43.6%', '+47.4%', 'pos'],
    ['AVGO', 'Technology', '61.7', '43.4%', '+32.3%', 'pos'],
    ['JPM', 'Financials', '15.5', '41.2%', '+109.0%', 'pos'],
    ['TSLA', 'Cons. cyclical', '364.8', '5.0%', '+2.3%', 'neg'],
  ]
  return (
    <div className="term">
      <div className="tbar"><i></i><i></i><i></i><span className="name">stock screener</span></div>
      <div className="thead"><span className="t">Stock Screener</span><span className="tag-prev">preview · 250 matches</span></div>
      <div className="filterchips">
        {['Market cap > $10B', 'Op margin > 40%', 'Rev growth > 10%', 'All sectors'].map(f => <span className="fc" key={f}>{f}</span>)}
      </div>
      <table>
        <thead><tr><th>Ticker</th><th>Sector</th><th>P/E</th><th>Op margin</th><th>Rev growth</th></tr></thead>
        <tbody>
          {rows.map(([t, s, pe, m, g, d]) => (
            <tr key={t}><td>{t}</td><td style={{ color: 'var(--muted)', fontWeight: 400 }}>{s}</td><td>{pe}</td><td>{m}</td><td className={d}>{g}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* Regression: scatter with an OLS fit line. */
const RegressionViz = () => {
  const pts: [number, number][] = [[18, 70], [34, 58], [48, 64], [62, 50], [76, 54], [92, 40], [108, 46], [124, 32], [140, 38], [156, 26], [172, 30], [188, 18], [204, 24], [220, 12]]
  return (
    <svg viewBox="0 0 240 96" style={{ width: '100%', height: 96, display: 'block' }} role="img" aria-label="Scatter plot with regression fit">
      <line x1="8" y1="88" x2="236" y2="88" stroke="rgba(255,255,255,0.08)" />
      <line x1="8" y1="8" x2="8" y2="88" stroke="rgba(255,255,255,0.08)" />
      {pts.map(([x, y]) => <circle key={x} cx={x} cy={y} r="2.4" fill="rgba(108,140,255,0.75)" />)}
      <line x1="14" y1="74" x2="226" y2="14" stroke="#c9a84c" strokeWidth="1.7" />
    </svg>
  )
}

/* Hero preview: the Global Energy Flows cockpit on real geography. Coastlines
   come from the same Natural Earth geojson the terminal map uses, projected
   equirectangular into a lon -105..150 / lat 62..-42 window. Chokepoints,
   ports, and lanes sit at true coordinates. Transit figures are static preview
   data mirroring real PortWatch magnitudes. */
const MAP_W = 520, MAP_H = 240
const LON0 = -105, LON1 = 150, LAT0 = 62, LAT1 = -42
const gx = (lon: number) => (lon - LON0) / (LON1 - LON0) * MAP_W
const gy = (lat: number) => (LAT0 - lat) / (LAT0 - LAT1) * MAP_H
const gp = (lon: number, lat: number) => `${gx(lon).toFixed(1)},${gy(lat).toFixed(1)}`

let worldPathCache = ''
function useWorldPath() {
  const [d, setD] = useState(worldPathCache)
  useEffect(() => {
    if (worldPathCache) return
    let alive = true
    fetch('/world-countries.geo.json')
      .then(r => r.json())
      .then(gj => {
        const parts: string[] = []
        for (const f of gj.features ?? []) {
          const g = f.geometry
          if (!g) continue
          const polys: [number, number][][][] = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
          for (const poly of polys) {
            const outer = poly[0]
            if (!outer || outer.length < 8) continue   // drop micro-islands
            let s = ''
            for (let i = 0; i < outer.length; i++) {
              const [lon, lat] = outer[i]
              s += (i === 0 ? 'M' : 'L') + gx(lon).toFixed(1) + ',' + gy(lat).toFixed(1)
            }
            parts.push(s + 'Z')
          }
        }
        worldPathCache = parts.join('')
        if (alive) setD(worldPathCache)
      })
      .catch(() => { /* land layer is decorative: lanes render without it */ })
    return () => { alive = false }
  }, [])
  return d
}

function FlowsMapPreview({ float = true }: { float?: boolean }) {
  const world = useWorldPath()
  const ports: [number, number][] = [
    [-95.0, 29.2], [-74.0, 39.0], [-46.3, -24.0], [4.0, 51.9], [3.4, 6.4], [18.4, -33.9],
    [50.1, 26.6], [72.8, 18.9], [103.8, 1.3], [121.5, 31.2], [139.7, 35.4], [116.7, -20.6],
  ]
  const chokes: { lon: number; lat: number; label: string; anchor?: 'end'; dy?: number }[] = [
    { lon: -5.6, lat: 35.9, label: 'GIBRALTAR', anchor: 'end' },
    { lon: 32.3, lat: 30.2, label: 'SUEZ', anchor: 'end' },
    { lon: 43.4, lat: 12.5, label: 'BAB EL-MANDEB', dy: 16 },
    { lon: 56.5, lat: 26.4, label: 'HORMUZ' },
    { lon: 101.8, lat: 2.2, label: 'MALACCA', dy: 16 },
    { lon: 119.8, lat: 24.2, label: 'TAIWAN' },
    { lon: -79.7, lat: 9.1, label: 'PANAMA' },
  ]
  return (
    <div className={float ? 'term float' : 'term'}>
      <div className="tbar"><i></i><i></i><i></i><span className="name">global energy flows</span></div>
      <div className="thead"><span className="t">Global Energy Flows</span><span className="tag-prev">preview</span></div>
      <svg className="mapviz" viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label="World map with shipping lanes and labeled chokepoints">
        {/* land */}
        {world && <path d={world} fill="#101f33" stroke="rgba(230,238,252,0.09)" strokeWidth="0.5" />}
        {/* graticule */}
        {[30, 0, -30].map(lat => <line key={`gy${lat}`} x1="0" y1={gy(lat)} x2={MAP_W} y2={gy(lat)} stroke="rgba(255,255,255,0.04)" strokeDasharray={lat === 0 ? '1 5' : undefined} />)}
        {[-90, -60, -30, 0, 30, 60, 90, 120].map(lon => <line key={`gx${lon}`} x1={gx(lon)} y1="0" x2={gx(lon)} y2={MAP_H} stroke="rgba(255,255,255,0.04)" />)}
        {/* oil artery: US Gulf → Gibraltar → Suez → Red Sea → Hormuz → Malacca → Taiwan → Japan */}
        <path className="lane" d={`M${gp(-93, 27)} C${gp(-60, 30)} ${gp(-30, 34)} ${gp(-5.6, 35.9)}`} stroke="rgba(108,140,255,0.55)" strokeWidth="1.4" />
        <path className="lane slow" d={`M${gp(-5.6, 35.9)} C${gp(10, 34.5)} ${gp(22, 33)} ${gp(32.3, 30.2)}`} stroke="#c9a84c" strokeWidth="1.8" />
        <path className="lane" d={`M${gp(32.3, 30.2)} C${gp(36, 24)} ${gp(40, 17)} ${gp(43.4, 12.5)}`} stroke="#c9a84c" strokeWidth="1.8" />
        <path className="lane slow" d={`M${gp(43.4, 12.5)} C${gp(52, 11)} ${gp(60, 18)} ${gp(56.5, 26.4)}`} stroke="#c9a84c" strokeWidth="1.8" />
        <path className="lane" d={`M${gp(56.5, 26.4)} C${gp(66, 16)} ${gp(84, 6)} ${gp(101.8, 2.2)}`} stroke="#c9a84c" strokeWidth="1.8" />
        <path className="lane slow" d={`M${gp(101.8, 2.2)} C${gp(110, 8)} ${gp(115, 17)} ${gp(119.8, 24.2)}`} stroke="#c9a84c" strokeWidth="1.6" />
        <path className="lane" d={`M${gp(119.8, 24.2)} C${gp(127, 28)} ${gp(133, 32)} ${gp(139.7, 35.4)}`} stroke="rgba(63,185,80,0.6)" strokeWidth="1.4" />
        {/* cape route (LNG blue): Europe → West Africa → Cape → Indian Ocean → Malacca */}
        <path className="lane slow" d={`M${gp(-8, 34)} C${gp(-14, 18)} ${gp(-10, 2)} ${gp(2, -12)} C${gp(10, -24)} ${gp(14, -32)} ${gp(19.5, -35.5)} C${gp(40, -34)} ${gp(70, -14)} ${gp(101.8, 2.2)}`} stroke="rgba(108,140,255,0.4)" strokeWidth="1.2" />
        {/* Americas: Panama → US Gulf, Panama → Pacific, Brazil → Gibraltar */}
        <path className="lane" d={`M${gp(-79.7, 9.1)} C${gp(-86, 18)} ${gp(-91, 23)} ${gp(-93, 27)}`} stroke="rgba(63,185,80,0.5)" strokeWidth="1.3" />
        <path className="lane slow" d={`M${gp(-79.7, 9.1)} C${gp(-90, 6)} ${gp(-98, 4)} ${gp(-104.8, 3)}`} stroke="rgba(108,140,255,0.3)" strokeWidth="1.1" />
        <path className="lane" d={`M${gp(-46.3, -24)} C${gp(-38, -12)} ${gp(-30, 6)} ${gp(-20, 20)} C${gp(-14, 28)} ${gp(-10, 32)} ${gp(-5.6, 35.9)}`} stroke="rgba(108,140,255,0.3)" strokeWidth="1.1" />
        {/* Australia LNG → Malacca */}
        <path className="lane slow" d={`M${gp(116.7, -20.6)} C${gp(112, -12)} ${gp(107, -4)} ${gp(101.8, 2.2)}`} stroke="rgba(108,140,255,0.4)" strokeWidth="1.2" />
        {/* Japan → Pacific exit */}
        <path className="lane" d={`M${gp(139.7, 35.4)} C${gp(144, 36)} ${gp(147, 36.5)} ${gp(149.8, 37)}`} stroke="rgba(108,140,255,0.3)" strokeWidth="1.1" />
        {/* vessels (at sea) */}
        {([[-45, 32.5, 82], [13, 34.2, 95], [38.5, 19.5, 155], [66, 16, 118], [88, 4.5, 100], [112, 12, 30], [2, -13, 160], [130, 30, 55]] as [number, number, number][]).map(([lon, lat, r], i) => (
          <path key={`v${i}`} d="M0,-4.2 L3.2,3.2 L-3.2,3.2 Z" transform={`translate(${gx(lon)},${gy(lat)}) rotate(${r})`} fill={i % 2 ? '#3fb950' : '#c9a84c'} opacity="0.92" />
        ))}
        {/* ports */}
        {ports.map(([lon, lat], i) => <circle key={`p${i}`} cx={gx(lon)} cy={gy(lat)} r="2" fill="rgba(230,238,252,0.55)" />)}
        {/* chokepoints */}
        {chokes.map(c => (
          <g key={c.label}>
            <circle className="ckring" cx={gx(c.lon)} cy={gy(c.lat)} r="7.5" fill="none" stroke="#c9a84c" strokeWidth="1.3" />
            <circle cx={gx(c.lon)} cy={gy(c.lat)} r="2.6" fill="#c9a84c" />
            <text className="maplabel" x={c.anchor === 'end' ? gx(c.lon) - 12 : gx(c.lon) + 12} y={gy(c.lat) + (c.dy ?? -8)} textAnchor={c.anchor ?? 'start'}>{c.label}</text>
          </g>
        ))}
        {/* legend */}
        <g transform="translate(12,226)">
          <rect x="-6" y="-10" width="230" height="20" fill="rgba(10,19,32,0.72)" />
          <line x1="0" y1="0" x2="16" y2="0" stroke="#c9a84c" strokeWidth="1.7" strokeDasharray="3 3" />
          <text className="maplabel" x="22" y="3">OIL</text>
          <line x1="52" y1="0" x2="68" y2="0" stroke="rgba(108,140,255,0.7)" strokeWidth="1.4" strokeDasharray="3 3" />
          <text className="maplabel" x="74" y="3">LNG · GAS</text>
          <circle cx="136" cy="0" r="3.4" fill="none" stroke="#c9a84c" strokeWidth="1.2" />
          <text className="maplabel" x="144" y="3">CHOKEPOINT</text>
        </g>
      </svg>
      <div className="chokestrip">
        <div className="ck"><div className="ckn"><i style={{ background: '#c9a84c' }} />HORMUZ</div><div className="ckv">21.0 Mb/d<span className="pos">+113.1%</span></div></div>
        <div className="ck"><div className="ckn"><i style={{ background: '#3fb950' }} />MALACCA</div><div className="ckv">23.0 Mb/d<span className="pos">+7.2%</span></div></div>
        <div className="ck"><div className="ckn"><i style={{ background: '#3fb950' }} />SUEZ</div><div className="ckv">9.2 Mb/d<span className="pos">+12.5%</span></div></div>
      </div>
    </div>
  )
}

/* Chart Studio: candles with two overlay series on their own scales, small. */
const OverlayChartViz = () => (
  <svg viewBox="0 0 240 96" style={{ width: '100%', height: 96, display: 'block', marginTop: 14 }} role="img" aria-label="Candlestick chart with overlay series">
    <line x1="0" y1="80" x2="240" y2="80" stroke="rgba(255,255,255,0.08)" />
    {([[16, 44, 62, 'p'], [44, 38, 58, 'p'], [72, 42, 66, 'n'], [100, 34, 54, 'p'], [128, 28, 50, 'p'], [156, 33, 57, 'n'], [184, 24, 46, 'p'], [212, 18, 40, 'p']] as [number, number, number, string][]).map(([x, t, b, d]) => (
      <g key={x}>
        <line x1={x} y1={t - 6} x2={x} y2={b + 6} stroke={d === 'p' ? '#3fb950' : '#f85149'} strokeWidth="1" />
        <rect x={x - 3.5} y={t} width="7" height={b - t} fill={d === 'p' ? 'rgba(63,185,80,0.85)' : 'rgba(248,81,73,0.85)'} rx="1" />
      </g>
    ))}
    <polyline points="8,70 48,64 88,66 128,56 168,58 208,48 236,44" fill="none" stroke="#6c8cff" strokeWidth="1.4" strokeLinejoin="round" />
    <polyline points="8,30 48,34 88,26 128,30 168,22 208,26 236,18" fill="none" stroke="rgba(192,132,252,0.8)" strokeWidth="1.3" strokeDasharray="4 3" strokeLinejoin="round" />
  </svg>
)

/* Sentiment: composite score over a 0-100 regime meter. */
const SentimentViz = ({ pad }: { pad?: boolean }) => (
  <div style={{ marginTop: pad ? 16 : 0 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>52.8</span>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.14em', color: 'var(--muted)' }}>NEUTRAL · 24H</span>
    </div>
    <div style={{ position: 'relative', height: 5, background: 'rgba(255,255,255,0.07)', borderRadius: 3, margin: '13px 0 6px' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, height: '100%', width: '52.8%', borderRadius: 3, background: 'linear-gradient(90deg,#f85149,#c9a84c 50%,#3fb950)', opacity: 0.8 }} />
      <div style={{ position: 'absolute', left: '52.8%', top: -3, width: 2, height: 11, background: 'var(--text)', borderRadius: 1 }} />
    </div>
    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--mono)', fontSize: 8.5, color: 'var(--dim)' }}>
      <span>BEARISH</span><span>50</span><span>BULLISH</span>
    </div>
    <div style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--dim)', marginTop: 12 }}>85 headlines · 24h window · fwd/back split</div>
  </div>
)

const SectorStrip = () => (
  <div className="sectors">
    {([['Tech', '+4.2', 'pos'], ['Comm', '+2.1', 'pos'], ['Disc', '+1.4', 'pos'], ['Fin', '+0.6', 'pos'], ['Indu', '+0.2', 'pos'], ['Health', '-0.3', 'neg'], ['Energy', '-1.1', 'neg'], ['Staples', '-0.8', 'neg'], ['Util', '-1.6', 'neg'], ['REIT', '-2.0', 'neg'], ['Mat', '-0.5', 'neg']] as [string, string, string][]).map(([l, v, d]) => (
      <div className="sct" key={l} style={{ background: d === 'pos' ? 'rgba(63,185,80,0.06)' : 'rgba(248,81,73,0.06)' }}><div className="scl">{l}</div><div className={`scv ${d}`}>{v}%</div></div>
    ))}
  </div>
)

/* ── Landing ────────────────────────────────────────────────────────────── */

const TAPE_FEATURES = [
  'Global Energy Flows', 'Chart Studio', 'Dealer GEX', 'Market Maker Simulator', 'Sentiment Tracker',
  'Options Flow', 'Volatility Skew', 'IV Rank', 'Implied Probability', 'Strategy Builder', 'Rate Engine',
  'DCF Valuation', 'Reverse DCF', 'Stock Screener', 'Monte Carlo', 'Credit Spreads',
  'Currency Matrix', 'Paper Trading', 'Trade Journal', 'Price Alerts',
]
function TickerTape() {
  const seq = (p: string) => TAPE_FEATURES.map(f => (
    <span className="tape-cell" key={p + f}><span className="tape-item">{f}</span><span className="tape-dot">·</span></span>
  ))
  return <div className="tape" aria-hidden="true"><div className="tape-track">{seq('a')}{seq('b')}</div></div>
}

const WORKFLOW = [
  { t: 'Research', d: 'Scan macro, energy flows, sentiment, and options positioning for an edge.' },
  { t: 'Analyze', d: 'Value it with DCF, read the dealer gamma, gauge the implied odds.' },
  { t: 'Structure', d: 'Build the multi-leg trade and check payoff and breakevens.' },
  { t: 'Size', d: 'Model the risk with Monte Carlo and correlation across the book.' },
  { t: 'Review', d: 'Paper-trade the fill, then journal the result for next time.' },
]

const ValuationViz = () => (
  <svg className="cardviz" viewBox="0 0 260 58" role="img" aria-label="Intrinsic value versus market price">
    <line x1="0" y1="50" x2="260" y2="50" stroke="rgba(255,255,255,0.08)" />
    <rect x="58" y="24" width="52" height="26" rx="2" fill="rgba(126,147,173,0.45)" />
    <rect x="150" y="12" width="52" height="38" rx="2" fill="#c9a84c" />
  </svg>
)
const PortfolioViz = () => (
  <svg className="cardviz" viewBox="0 0 260 58" role="img" aria-label="Simulated forward paths">
    <polyline points="4,40 92,33 180,19 256,5" fill="none" stroke="#3fb950" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    <polyline points="4,40 92,38 180,30 256,22" fill="none" stroke="rgba(108,140,255,0.75)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    <polyline points="4,40 92,42 180,45 256,44" fill="none" stroke="rgba(126,147,173,0.6)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    <polyline points="4,40 92,46 180,52 256,55" fill="none" stroke="rgba(248,81,73,0.6)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    <circle cx="4" cy="40" r="2.6" fill="#c9a84c" />
  </svg>
)
const MacroViz = () => (
  <svg className="cardviz" viewBox="0 0 260 58" role="img" aria-label="Yield curve">
    <line x1="0" y1="52" x2="260" y2="52" stroke="rgba(255,255,255,0.08)" />
    <polyline points="8,32 70,35 130,29 195,17 252,10" fill="none" stroke="#c9a84c" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    {[[8, 32], [70, 35], [130, 29], [195, 17], [252, 10]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="2.4" fill="#0a1320" stroke="#c9a84c" strokeWidth="1.4" />)}
  </svg>
)

export function Landing() {
  const reduce = useReducedMotion()
  const { container, item } = useStagger()
  const heroRef = useRef<HTMLElement>(null)
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] })
  const termY = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : -70])

  return (
    <Shell active={null}>
      <TickerTape />
      <header className="hero" ref={heroRef}>
        <div className="wrap hero-grid">
          <motion.div variants={container} initial="hidden" animate="show">
            <motion.div className="eyebrow" variants={item}>Institutional-style analytics</motion.div>
            <motion.h1 variants={item}>Options, valuation, macro, and trading<br />in one <span className="g">terminal</span>.</motion.h1>
            <motion.p className="lede" variants={item}>Options flow, dealer gamma, live energy flows, DCF valuation, macro rates, paper trading. 44 tools across six hubs in one dark terminal. Go from first idea to sized position.</motion.p>
            <motion.div className="cta" variants={item}>
              <Magnetic><Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link></Magnetic>
              <Link to="/product/research" className="btn btn-ghost btn-lg">Explore the tools</Link>
            </motion.div>
          </motion.div>
          <motion.div style={{ y: termY }}>
            <motion.div initial={{ opacity: 0, x: reduce ? 0 : 46, scale: reduce ? 1 : 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }} transition={{ duration: 0.9, ease: EASE, delay: 0.3 }}>
              <FlowsMapPreview />
            </motion.div>
          </motion.div>
        </div>
      </header>

      <Reveal className="strip" y={0}><div className="strip-in">
        <div className="stat"><div className="n g"><CountUp to={43} /></div><div className="l">analytics tools</div></div>
        <div className="stat"><div className="n"><CountUp to={6} /></div><div className="l">workspace hubs</div></div>
        <div className="stat"><div className="n"><CountUp to={20} suffix="+" /></div><div className="l">feeds on one chart</div></div>
        <div className="stat"><div className="n"><CountUp to={100} suffix="%" /></div><div className="l">browser-based</div></div>
      </div></Reveal>

      <section className="blk" id="tools"><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">One terminal, every workflow</div>
          <h2>Shared live data, one workspace.</h2>
          <p>The tools draw from the same live feeds: prices, option chains, yield curves, credit spreads, news, and vessel positions. You move from a macro thesis to an options structure to a paper fill without leaving the terminal.</p>
        </Reveal>
        <StaggerGroup className="bento">
          <TiltCard className="card c-tall glow-gold" to="/product/trading" item={item}>
            <div className="k">Market Maker Simulator</div>
            <h3>Quote both sides of the market.</h3>
            <p>Make markets on simulated options and Treasury desks: absorb flow, manage inventory, and hedge. A timed five-minute challenge scores your net P&amp;L on a global leaderboard.</p>
            <div className="mini">
              <div className="row"><span>Your market</span><span className="mono">101.34 / 101.42</span></div>
              <div className="row"><span>Fill</span><span className="pos mono">SOLD 120 @ .42</span></div>
              <div className="row"><span>Inventory</span><span className="neg mono">-120 Δ</span></div>
              <div className="row"><span>Board #1</span><span className="mono g">$8.4k net</span></div>
            </div>
            <div className="tags"><span className="tag">Two-sided quotes</span><span className="tag">Delta hedging</span><span className="tag">5-min challenge</span><span className="tag">Leaderboard</span></div>
            <PnlHistogram grow />
          </TiltCard>
          <TiltCard className="card c-2" to="/product/research" item={item}>
            <div className="k">Sentiment Tracker</div><h3>AI-scored news sentiment.</h3>
            <p>Headlines scored by AI and rolled into a composite reading, split into forward and backward looking.</p>
            <SentimentViz pad />
          </TiltCard>
          <TiltCard className="card c-2 glow-blue" to="/product/charting" item={item}>
            <div className="k">Chart Studio</div><h3>Every feed on one chart.</h3>
            <p>Candlesticks plus 20+ overlays: rates, credit, volatility, energy flows, and fundamentals. Each series plots on its own axis.</p>
            <OverlayChartViz />
          </TiltCard>
          <TiltCard className="card c-2" to="/product/valuation" item={item}>
            <div className="k">Valuation</div><h3>Value a company five ways.</h3>
            <p>DCF, reverse DCF, dividend discount, sum of the parts, and multiples against the current price.</p>
            <ValuationViz />
          </TiltCard>
          <TiltCard className="card c-2" to="/product/trading" item={item}>
            <div className="k">Trading &amp; portfolio</div><h3>Backtest and stress-test the book.</h3>
            <p>Historical backtests, Monte Carlo simulation, and portfolio-level greeks.</p>
            <PortfolioViz />
          </TiltCard>
          <TiltCard className="card c-wide" to="/product/macro" item={item}>
            <div className="k">Macro &amp; rates</div><h3>Rates, credit, and physical flows.</h3>
            <p>The implied FOMC path, the yield curve, credit spreads, FX crosses, and live tanker traffic through the world's chokepoints.</p>
            <MacroViz />
            <div className="tags"><span className="tag">Rate Engine</span><span className="tag">Credit spreads</span><span className="tag">Currency matrix</span><span className="tag">Energy flows</span></div>
          </TiltCard>
          <TiltCard className="card c-2" to="/product/options" item={item}>
            <div className="k">Options intelligence</div><h3>Flow, gamma, and volatility.</h3>
            <p>Unusual activity, dealer GEX, IV rank and skew, and the option-implied odds at every strike.</p>
            <div className="mini">
              <div className="row"><span>Dealer GEX</span><span className="pos mono">+2.1B</span></div>
              <div className="row"><span>IV Rank · SPX</span><span className="mono">18%</span></div>
              <div className="row"><span>Put/Call</span><span className="neg mono">0.92</span></div>
            </div>
          </TiltCard>
        </StaggerGroup>
      </div></section>

      <section className="blk" id="depth" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg2)' }}>
        <div className="wrap split">
          <Reveal>
            <div className="eyebrow">Unusual options flow</div>
            <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em', margin: '12px 0 14px' }}>Scan liquid chains for unusual options activity.</h2>
            <p style={{ color: 'var(--muted)', fontSize: 15.5, lineHeight: 1.65 }}>The flow scanner sweeps liquid chains for volume spikes and volume/open-interest surges. Volume running ahead of open interest points to positioning opened that session. Sort by DTE, moneyness, or premium, ranked by traded premium by default.</p>
            <div className="cta" style={{ marginTop: 24 }}><Link to="/product/options" className="btn btn-ghost btn-lg">Open Options →</Link></div>
          </Reveal>
          <Reveal delay={0.12}>
            <div className="term">
              <div className="tbar"><i></i><i></i><i></i><span className="name">options · flow</span></div>
              <div className="thead"><span className="t">Unusual flow</span><span className="tag-prev">preview</span></div>
              <table>
                <thead><tr><th>Contract</th><th>Vol/OI</th><th>Premium</th><th>Rank</th></tr></thead>
                <tbody>
                  <tr><td>NVDA 1300C</td><td className="pos">8.4x</td><td>$18.4M</td><td><span className="bar7"><i style={{ width: '100%' }}></i></span></td></tr>
                  <tr><td>SPY 605C</td><td className="pos">3.1x</td><td>$9.1M</td><td><span className="bar7"><i style={{ width: '49%' }}></i></span></td></tr>
                  <tr><td>TSLA 400P</td><td className="neg">2.0x</td><td>$6.2M</td><td><span className="bar7"><i style={{ width: '34%' }}></i></span></td></tr>
                  <tr><td>AAPL 230C</td><td className="pos">1.9x</td><td>$4.0M</td><td><span className="bar7"><i style={{ width: '22%' }}></i></span></td></tr>
                </tbody>
              </table>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)' }}><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">Six hubs</div>
          <h2>44 tools, each with one home.</h2>
          <p>Every tool lives in exactly one hub, so you always know where to look. A command palette jumps anywhere.</p>
        </Reveal>
        <StaggerGroup className="hubband">
          {([
            ['11', 'Research', 'Screener · Sentiment · Earnings AI', '/product/research'],
            ['7', 'Options', 'Dealer GEX · Flow · Implied Vol', '/product/options'],
            ['9', 'Macro', 'Rate Engine · Energy Flows · Global Markets', '/product/macro'],
            ['2', 'Charting', 'Chart Studio · Asset Overlay', '/product/charting'],
            ['9', 'Trading', 'Paper Trading · MM Sim · Journal', '/product/trading'],
            ['6', 'Valuation', 'DCF · Reverse DCF · Multiples', '/product/valuation'],
          ] as [string, string, string, string][]).map(([n, l, t, to]) => (
            <MLink key={l} to={to} className="hubcell" variants={item}>
              <div className="hn">{n}</div>
              <div className="hl">{l}</div>
              <div className="ht">{t}</div>
            </MLink>
          ))}
        </StaggerGroup>
      </div></section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)' }}><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">One continuous workflow</div>
          <h2>Research, analyze, size, and review in one place.</h2>
          <p>The whole loop lives in one terminal. You reach a decision without exporting to three other tabs.</p>
        </Reveal>
        <StaggerGroup className="flow">
          {WORKFLOW.map((s, i) => (
            <motion.div className="step" key={s.t} variants={item}><div className="node">{i + 1}</div><h4>{s.t}</h4><p>{s.d}</p></motion.div>
          ))}
        </StaggerGroup>
      </div></section>

      <section className="blk"><div className="wrap">
        <Reveal>
          <div className="final">
            <div className="eyebrow">Built for independent traders</div>
            <h2>Open the terminal.</h2>
            <p>An institutional-style analytics desk that runs in your browser. Nothing to install.</p>
            <Magnetic><Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link></Magnetic>
          </div>
        </Reveal>
      </div></section>
    </Shell>
  )
}

/* ── Research ───────────────────────────────────────────────────────────── */

export function ResearchPage() {
  return (
    <Shell active="research">
      <PageHero eyebrow="Research · 11 tools" h1="Find and vet the name."
        lede="Screen the universe, read the company, and track the news flow. Ten tools cover discovery, single-name work, and the statistics behind the idea." />

      <section className="blk"><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">Stock Screener</div>
          <h2>25+ filters across the universe.</h2>
          <p>Fundamental and technical filters across US and international names, with a region filter and saved screens. Export the result set to CSV.</p>
        </Reveal>
        <Reveal><ScreenerTerm /></Reveal>
      </div></section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg2)' }}>
        <div className="wrap split">
          <Reveal>
            <div className="eyebrow">Sentiment Tracker</div>
            <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em', margin: '12px 0 14px' }}>A composite score for the news flow.</h2>
            <p style={{ color: 'var(--muted)', fontSize: 15.5, lineHeight: 1.65 }}>AI scores each headline on direction and confidence, then rolls the sources into one composite reading. Forward-looking and backward-looking stories split into separate subscores, and syndicated duplicates collapse into one story.</p>
            <div className="cta" style={{ marginTop: 24 }}><Link to="/app" className="btn btn-ghost btn-lg">Open Sentiment →</Link></div>
          </Reveal>
          <Reveal delay={0.12}>
            <VPanel title="Sentiment Tracker" tags={['Composite score', 'Forward / backward', 'Source weighting']}>
              <SentimentViz />
            </VPanel>
          </Reveal>
        </div>
      </section>

      <section className="blk"><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">Single-name work</div>
          <h2>Read the company behind the ticker.</h2>
        </Reveal>
        <div className="flist">
          <div className="frow"><div className="idx">01</div><div>
            <h3>Company Profile</h3>
            <p>One page per name: price history with volatility and drawdown, revenue mix by segment and geography, institutional ownership, credit quality, and analyst ratings.</p>
            <div className="tags"><span className="tag">Price history</span><span className="tag">Revenue mix</span><span className="tag">Ownership</span><span className="tag">Credit</span></div>
          </div></div>
          <div className="frow"><div className="idx">02</div><div>
            <h3>Earnings AI</h3>
            <p>Call transcripts and filing summaries on demand.</p>
            <div className="tags"><span className="tag">Transcripts</span><span className="tag">Filing summaries</span></div>
          </div></div>
          <div className="frow"><div className="idx">03</div><div>
            <h3>Peer Comparison</h3>
            <p>Trading multiples against sector peers, green where a name beats the set and red where it lags.</p>
            <div className="tags"><span className="tag">P/E</span><span className="tag">EV/EBITDA</span><span className="tag">Sector medians</span></div>
          </div></div>
          <div className="frow"><div className="idx">04</div><div>
            <h3>ETF Analyzer</h3>
            <p>Look-through holdings, overlap between funds, and concentration.</p>
            <div className="tags"><span className="tag">Look-through</span><span className="tag">Overlap</span><span className="tag">Concentration</span></div>
          </div></div>
          <div className="frow"><div className="idx">05</div><div>
            <h3>Portfolio Earnings</h3>
            <p>Your holdings counting down to their next report, with valuation, positioning and the wire.</p>
            <div className="tags"><span className="tag">Countdown agenda</span><span className="tag">Earnings wire</span></div>
          </div></div>
          <div className="frow"><div className="idx">06</div><div>
            <h3>Earnings Scanner</h3>
            <p>Confirmed and estimated report dates with past price reactions.</p>
            <div className="tags"><span className="tag">Report dates</span><span className="tag">Reactions</span></div>
          </div></div>
        </div>
      </div></section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)' }}><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">Statistics</div>
          <h2>Correlation, rotation, and regression.</h2>
        </Reveal>
        <div className="showcase three">
          <VPanel title="Correlation" desc="Correlation matrix, rolling drift, and beta across any set of tickers.">
            <CorrHeatmap />
          </VPanel>
          <VPanel title="Sector Rotation" tag="1M vs SPY" desc="GICS sector performance relative to SPY over time.">
            <SectorStrip />
          </VPanel>
          <VPanel title="Regression" desc="OLS and polynomial fits with diagnostics.">
            <RegressionViz />
          </VPanel>
        </div>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>All ten research tools, in the terminal.</h2>
          <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
        </div>
      </div></section>
    </Shell>
  )
}

/* ── Options ────────────────────────────────────────────────────────────── */

export function OptionsPage() {
  return (
    <Shell active="options">
      <PageHero eyebrow="Options · 7 tools" h1="Options flow, gamma, and volatility."
        lede="Seven tools on the options chain: large-trade activity, dealer hedging pressure, volatility levels, and the cost of premium." />

      <section className="blk"><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">Chain Scanner</div>
          <h2>The live chain with greeks.</h2>
          <p>Every strike with delta, implied volatility, bid/ask, and open interest. Filter by delta, DTE, and moneyness to isolate the contracts you trade.</p>
        </Reveal>
        <Reveal><ChainTerm /></Reveal>
      </div></section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg2)' }}>
        <div className="wrap split">
          <Reveal>
            <div className="eyebrow">Dealer GEX</div>
            <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em', margin: '12px 0 14px' }}>Dealer gamma by strike.</h2>
            <p style={{ color: 'var(--muted)', fontSize: 15.5, lineHeight: 1.65 }}>Net dealer gamma at each strike and expiry, the zero-gamma flip level, and the pin zones that shape intraday behavior. Above the flip dealers dampen moves, below it they amplify them.</p>
            <div className="cta" style={{ marginTop: 24 }}><Link to="/app" className="btn btn-ghost btn-lg">Open Dealer GEX →</Link></div>
          </Reveal>
          <Reveal delay={0.12}>
            <VPanel title="Dealer GEX" tags={['GEX profile', 'Flip point', 'Pin risk']}>
              <GammaProfile />
            </VPanel>
          </Reveal>
        </div>
      </section>

      <section className="blk">
        <div className="wrap split">
          <Reveal>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
              <VPanel title="Volatility Skew" desc="Put/call skew and the smile across strikes, with IV rank and term structure alongside.">
                <SkewCurve />
              </VPanel>
              <VPanel title="Implied Probability" desc="The option-implied distribution for any expiry, with P(ITM) at every strike.">
                <ProbDist />
              </VPanel>
            </div>
          </Reveal>
          <Reveal delay={0.12}>
            <div className="eyebrow">Volatility and probability</div>
            <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em', margin: '12px 0 14px' }}>What premium costs, and what it implies.</h2>
            <p style={{ color: 'var(--muted)', fontSize: 15.5, lineHeight: 1.65 }}>IV rank tells you whether premium is rich or cheap against its own history. The risk-neutral distribution turns the same chain into the market's odds for every strike.</p>
          </Reveal>
        </div>
      </section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)' }}><div className="wrap">
        <div className="loop" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
          <div className="lp"><div className="lpn"><b><Activity size={13} /></b> Options Flow</div><h4>Watch the large trades.</h4><p>Volume spikes and volume/open-interest surges across liquid chains, ranked by traded premium.</p><div className="lptags"><span className="tag">Vol/OI</span><span className="tag">Premium rank</span></div></div>
          <div className="lp"><div className="lpn"><b><Calculator size={13} /></b> Options Pricer</div><h4>Price the contract.</h4><p>Black-Scholes with the full greek set. Run what-if on spot, vol, and time.</p><div className="lptags"><span className="tag">Greeks</span><span className="tag">What-if</span></div></div>
          <div className="lp"><div className="lpn"><b><GitBranch size={13} /></b> Strategy Builder</div><h4>Compose the structure.</h4><p>Multi-leg structures with payoff, breakevens, and P&amp;L at expiry and now.</p><div className="lptags"><span className="tag">Multi-leg</span><span className="tag">Breakevens</span></div></div>
        </div>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>All seven options tools, in the terminal.</h2>
          <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
        </div>
      </div></section>
    </Shell>
  )
}

/* ── Macro ──────────────────────────────────────────────────────────────── */

export function MacroPage() {
  return (
    <Shell active="macro">
      <PageHero eyebrow="Macro · 9 tools" h1="Rates, credit, and physical flows."
        lede="The implied FOMC path, the yield curve, credit spreads, FX crosses, and live tanker traffic through the world's chokepoints. Nine tools across rates, credit, FX, energy, and world markets." />

      <section className="blk"><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">Rate Engine</div>
          <h2>The policy path and the curve.</h2>
        </Reveal>
        <div className="showcase">
          <VPanel title="Rate & credit board" desc="Futures-implied policy odds, Treasury yields, curve spreads, and credit OAS on one screen.">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
              <thead><tr>{['Series', 'Level', 'Δ 1M'].map((h, i) => <th key={h} style={{ ...miniTh, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>)}</tr></thead>
              <tbody>
                {([['Fed funds (mid)', '4.13', '-0.25', 'neg'], ['2Y UST', '3.71', '-0.18', 'neg'], ['10Y UST', '4.05', '+0.06', 'pos'], ['2s10s', '+0.34', '+0.24', 'pos'], ['IG OAS', '92', '+4', 'pos'], ['HY OAS', '318', '+19', 'pos']] as [string, string, string, string][]).map(([s, l, d, cls]) => (
                  <tr key={s}><td style={{ padding: '6px 2px', color: 'var(--text)', fontWeight: 700 }}>{s}</td><td style={{ padding: '6px 2px', textAlign: 'right', color: 'var(--muted)' }}>{l}</td><td className={cls} style={{ padding: '6px 2px', textAlign: 'right' }}>{d}</td></tr>
                ))}
              </tbody>
            </table>
          </VPanel>
          <VPanel title="SEP projections" desc="FOMC rate projections as published: the median and the range for each horizon, from FRED.">
            <SepBands />
          </VPanel>
        </div>
        <div style={{ marginTop: 18 }}>
          <VPanel title="Yield curve · UST" desc="Curve shape, the 2s10s spread, and a 1-day, 1-month, and 6-month historical overlay.">
            <YieldCurveBig />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)' }}>
              <span>2Y</span><span>5Y</span><span>10Y</span><span>20Y</span><span>30Y</span>
            </div>
          </VPanel>
        </div>
      </div></section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg2)' }}>
        <div className="wrap split">
          <Reveal>
            <div className="eyebrow">Global Energy Flows</div>
            <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em', margin: '12px 0 14px' }}>Live tankers, pipelines, and chokepoints.</h2>
            <p style={{ color: 'var(--muted)', fontSize: 15.5, lineHeight: 1.65 }}>A live map of AIS vessel positions, energy pipelines, export terminals, and the world's shipping chokepoints. Transit counts per chokepoint come from IMF PortWatch, with a 30-day history and congestion status. A 24-hour replay scrubs vessel movement.</p>
            <div className="cta" style={{ marginTop: 24 }}><Link to="/app" className="btn btn-ghost btn-lg">Open the map →</Link></div>
          </Reveal>
          <Reveal delay={0.12}>
            <FlowsMapPreview float={false} />
          </Reveal>
        </div>
      </section>

      <section className="blk"><div className="wrap">
        <div className="showcase" style={{ marginBottom: 18 }}>
          <VPanel title="Currency Matrix" desc="Spot cross-rates, forward points, cross-currency basis, and FX vol.">
            <FxGrid />
          </VPanel>
          <VPanel title="Credit Spreads" desc="Investment-grade and high-yield option-adjusted spreads, an early signal of market stress.">
            <svg viewBox="0 0 240 96" style={vizBox} role="img" aria-label="IG and HY credit spreads">
              <line x1="0" y1="80" x2="240" y2="80" stroke="rgba(255,255,255,0.08)" />
              <polyline points="8,64 48,60 88,66 128,58 168,50 208,42 232,38" fill="none" stroke="#f85149" strokeWidth="1.7" strokeLinejoin="round" />
              <polyline points="8,74 48,72 88,74 128,70 168,68 208,64 232,62" fill="none" stroke="#6c8cff" strokeWidth="1.5" strokeLinejoin="round" />
              <text x="8" y="24" style={{ fontFamily: 'var(--mono)', fontSize: 8.5, fill: 'var(--dim)' }}>HY 318 · IG 92</text>
            </svg>
          </VPanel>
        </div>
        <div className="modgrid">
          <Mod icon={GitBranch} title="Rate Engine">The implied FOMC path, SEP projections, and the full yield curve with history.</Mod>
          <Mod icon={BarChart3} title="Macro Monitor">Growth, inflation, and labor-market dashboards. CPI, NFP, GDP.</Mod>
          <Mod icon={Landmark} title="Global Markets">World indices, FX, commodities, yields, and crypto on one board.</Mod>
          <Mod icon={Landmark} title="Bond Analytics">Yield-to-maturity, duration, and convexity.</Mod>
          <Mod icon={BookOpen} title="Bond Lookup">Resolve a CUSIP or issuer to bond reference data.</Mod>
          <Mod icon={ArrowLeftRight} title="Currency Matrix">Spot crosses, forwards, basis, and FX volatility.</Mod>
          <Mod icon={Clock} title="Market Hours">A live global session clock across futures, US, Europe, and Asia.</Mod>
        </div>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>All nine macro tools, in the terminal.</h2>
          <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
        </div>
      </div></section>
    </Shell>
  )
}

/* ── Charting ───────────────────────────────────────────────────────────── */

export function ChartingPage() {
  return (
    <Shell active="charting">
      <PageHero eyebrow="Charting · 2 tools" h1="Plot any series on one timeline."
        lede="Two chart surfaces: a candlestick studio that overlays any data series in the app, and multi-asset comparison." />

      <section className="blk"><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">Chart Studio</div>
          <h2>Candles plus 20+ overlays, each on its own axis.</h2>
        </Reveal>
        <Reveal>
          <VPanel title="Chart Studio" desc="Timeframes from 1 minute to 1 week. Overlay rates, credit, volatility, energy flows, and fundamentals over price. Sub-panel lanes for RSI, MACD, volume, and IV. Dealer gamma plots by strike on the price axis, and earnings, dividends, and splits mark the timeline.">
            <OverlayChartBig />
          </VPanel>
        </Reveal>
        <div className="flist" style={{ marginTop: 40 }}>
          <div className="frow"><div className="idx">01</div><div>
            <h3>Chart Studio</h3>
            <p>One candlestick chart that overlays any data series in the app. Each overlay autoscales on its own hidden axis, so a 4% yield and a $700 stock fit on the same timeline without distortion. A crosshair readout shows the value of every active series at the hovered bar.</p>
            <div className="tags"><span className="tag">1m to 1wk</span><span className="tag">20+ overlays</span><span className="tag">Own axes</span><span className="tag">Event markers</span><span className="tag">GEX by strike</span></div>
          </div></div>
          <div className="frow"><div className="idx">02</div><div>
            <h3>Asset Overlay</h3>
            <p>Any set of assets rebased to a common start and drawn on one chart. The clean way to compare a stock, an index, and a commodity.</p>
            <div className="tags"><span className="tag">Rebased to 100</span><span className="tag">Multi-asset</span></div>
          </div></div>
        </div>
        <div className="showcase" style={{ marginTop: 40 }}>
          <VPanel title="Asset Overlay" desc="Two assets from a common base of 100.">
            <CompareViz />
          </VPanel>
          <VPanel title="Chart Studio · GEX by strike" desc="Dealer gamma plots as price-aligned bars on the price axis.">
            <GammaProfile />
          </VPanel>
        </div>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>Both chart surfaces, in the terminal.</h2>
          <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
        </div>
      </div></section>
    </Shell>
  )
}

/* ── Trading ────────────────────────────────────────────────────────────── */

export function TradingPage() {
  return (
    <Shell active="trading">
      <PageHero eyebrow="Trading · 9 tools" h1="Build, test, execute, and track."
        lede="Compose a strategy, test it against history, run it on a simulated desk, and track every trade and holding. Nine tools cover the loop from rules to reviewed result." />

      <section className="blk"><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">The loop</div>
          <h2>Strategy, paper trade, journal, alerts.</h2>
        </Reveal>
        <div className="loop">
          <div className="lp"><div className="lpn"><b><Workflow size={13} /></b> Algo Strategy Builder</div><h4>Define the rules.</h4><p>Compose entry and exit rules and risk parameters into a strategy, then save and backtest it. No code required.</p><div className="lptags"><span className="tag">Rules</span><span className="tag">Backtest</span></div></div>
          <div className="lp"><div className="lpn"><b><Terminal size={13} /></b> Paper Trading</div><h4>Trade it, risk-free.</h4><p>Simulated order execution with live prices. Equities and options, with position tracking and P&amp;L.</p><div className="lptags"><span className="tag">Live prices</span><span className="tag">Equities + options</span></div></div>
          <div className="lp"><div className="lpn"><b><BookOpen size={13} /></b> Trade Journal</div><h4>Review the result.</h4><p>Log every trade, tag the setup, and track win rate and profit factor over time.</p><div className="lptags"><span className="tag">Win rate</span><span className="tag">Profit factor</span></div></div>
          <div className="lp"><div className="lpn"><b><Bell size={13} /></b> Price Alerts</div><h4>Catch the trigger.</h4><p>Price, percent-change, RSI, and price-versus-SMA alerts, pushed to your browser when they fire.</p><div className="lptags"><span className="tag">Price</span><span className="tag">RSI + SMA</span></div></div>
        </div>
      </div></section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg2)' }}><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">The book</div>
          <h2>Backtest, simulate, and track the book.</h2>
        </Reveal>
        <div className="showcase">
          <VPanel title="Backtester" desc="Allocation and strategy rules over history with CAGR, Sharpe, Sortino, and max drawdown."
            tags={['CAGR', 'Sharpe', 'Max drawdown']}>
            <EquityCurve />
          </VPanel>
          <VPanel title="Monte Carlo" desc="Forward path simulation with GBM, Student-t, or block-bootstrap models, into percentile cones and value-at-risk."
            tags={['3 models', 'VaR + CVaR']}>
            <PercentileCone />
          </VPanel>
          <VPanel title="Market Maker Simulator" desc="Quote two-sided markets on options and Treasury desks. A five-minute challenge scores net P&L on a global leaderboard."
            tags={['Options desk', 'Treasury desk', 'Leaderboard']}>
            <LadderRows />
          </VPanel>
          <VPanel title="Portfolio Manager" desc="Holdings, P&L, and portfolio-level greeks, with two to four books compared side by side.">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11.5 }}><tbody>
              {([['Net Liq', '$1,284,930', ''], ['Day P&L', '+$8,412', 'pos'], ['Net delta', '+1,940', ''], ['Net theta', '-318', 'neg']] as [string, string, string][]).map(([k, v, cls]) => (
                <tr key={k}><td style={{ padding: '6px 2px', color: 'var(--muted)' }}>{k}</td><td className={cls} style={{ padding: '6px 2px', textAlign: 'right', color: cls ? undefined : 'var(--text)' }}>{v}</td></tr>
              ))}
            </tbody></table>
          </VPanel>
        </div>
      </div></section>

      <section className="blk"><div className="wrap split">
        <div>
          <div className="eyebrow">Trade journal</div>
          <h2 style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', margin: '12px 0 14px' }}>Win rate, profit factor, and per-trade P&L.</h2>
          <p style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.65 }}>Log every trade and tag the setup. The journal tracks win rate, average win and loss, profit factor, and the P&L on each closed position.</p>
          <div className="statline">
            <div className="statbox"><div className="sbv pos">58%</div><div className="sbl">Win rate</div></div>
            <div className="statbox"><div className="sbv">1.7</div><div className="sbl">Profit factor</div></div>
            <div className="statbox"><div className="sbv">142</div><div className="sbl">Trades logged</div></div>
          </div>
        </div>
        <VPanel title="Journal · closed-trade P&L">
          <PnlHistogram />
        </VPanel>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>All nine trading tools, in the terminal.</h2>
          <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
        </div>
      </div></section>
    </Shell>
  )
}

/* ── Valuation ──────────────────────────────────────────────────────────── */

export function ValuationPage() {
  return (
    <Shell active="valuation">
      <PageHero eyebrow="Valuation · 6 tools" h1="Value a company five ways."
        lede="DCF, reverse DCF, dividend discount, sum of the parts, and multiples, plus a NAV tracker. Every model leads with its answer and shows the assumptions behind it." />

      <section className="blk" style={{ paddingTop: 40, paddingBottom: 40 }}><div className="wrap">
        <Reveal>
          <div className="statline" style={{ marginTop: 0 }}>
            <div className="statbox"><div className="sbv">$1,206</div><div className="sbl">Intrinsic / share · DCF</div></div>
            <div className="statbox"><div className="sbv">$1,182</div><div className="sbl">Market price</div></div>
            <div className="statbox"><div className="sbv pos">+2.0%</div><div className="sbl">Upside</div></div>
          </div>
          <p style={{ fontFamily: 'var(--mono)', fontSize: 10.5, color: 'var(--dim)', marginTop: 10 }}>Every valuation tool leads with its verdict. The assumptions sit directly below it.</p>
        </Reveal>
      </div></section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg2)' }}>
        <div className="wrap split">
          <Reveal>
            <div className="eyebrow">DCF Valuation</div>
            <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em', margin: '12px 0 14px' }}>Start from the cash flow.</h2>
            <p style={{ color: 'var(--muted)', fontSize: 15.5, lineHeight: 1.65 }}>A ten-year free-cash-flow model with margin and growth glide paths. Set WACC and terminal growth, and read intrinsic value per share against the market price. Missing beta or margins resolve from industry data instead of stalling the model.</p>
            <div className="cta" style={{ marginTop: 24 }}><Link to="/app" className="btn btn-ghost btn-lg">Open DCF →</Link></div>
          </Reveal>
          <Reveal delay={0.12}>
            <VPanel title="DCF · NVDA">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11.5 }}><tbody>
                {([['Revenue (TTM)', '$148.5B', ''], ['Operating margin', '61.2%', ''], ['WACC', '9.4%', ''], ['Terminal growth', '2.5%', ''], ['Intrinsic / share', '$1,206', 'pos'], ['Market price', '$1,182', ''], ['Upside', '+2.0%', 'pos']] as [string, string, string][]).map(([k, v, cls]) => (
                  <tr key={k}><td style={{ padding: '6px 2px', color: 'var(--muted)' }}>{k}</td><td className={cls} style={{ padding: '6px 2px', textAlign: 'right', color: cls ? undefined : 'var(--text)' }}>{v}</td></tr>
                ))}
              </tbody></table>
            </VPanel>
          </Reveal>
        </div>
      </section>

      <section className="blk"><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">Stress the assumptions</div>
          <h2>The same model under different inputs.</h2>
        </Reveal>
        <div className="showcase">
          <VPanel title="Sensitivity · WACC × growth" tag="upside %" desc="The model across a grid of discount-rate and growth assumptions. See how much the result depends on its inputs.">
            <SensitivityGrid />
          </VPanel>
          <VPanel title="Reverse DCF" desc="Solve for the growth the current price already implies, then judge whether the market's expectation is reasonable.">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11.5 }}><tbody>
              {([['Market price', '$1,182', ''], ['Implied growth', '14.2% / yr', ''], ['Implied margin', '58.0%', ''], ['5y historical growth', '39.1% / yr', 'pos']] as [string, string, string][]).map(([k, v, cls]) => (
                <tr key={k}><td style={{ padding: '6px 2px', color: 'var(--muted)' }}>{k}</td><td className={cls} style={{ padding: '6px 2px', textAlign: 'right', color: cls ? undefined : 'var(--text)' }}>{v}</td></tr>
              ))}
            </tbody></table>
          </VPanel>
        </div>
      </div></section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)' }}><div className="wrap">
        <Reveal className="sec-head">
          <div className="eyebrow">More models</div>
          <h2>Dividends, segments, and multiples.</h2>
        </Reveal>
        <div className="flist">
          <div className="frow"><div className="idx">01</div><div>
            <h3>Dividend Discount</h3>
            <p>Gordon and multi-stage dividend discount models for income names.</p>
            <div className="tags"><span className="tag">Gordon</span><span className="tag">Multi-stage</span></div>
          </div></div>
          <div className="frow"><div className="idx">02</div><div>
            <h3>Sum of the Parts</h3>
            <p>Value each business segment from SEC filing data, then sum the parts.</p>
            <div className="tags"><span className="tag">SEC segments</span><span className="tag">Per-segment multiples</span></div>
          </div></div>
          <div className="frow"><div className="idx">03</div><div>
            <h3>Multiples</h3>
            <p>Implied price from target P/E, EV/Sales, and more.</p>
            <div className="tags"><span className="tag">P/E</span><span className="tag">EV/Sales</span></div>
          </div></div>
        </div>
      </div></section>

      <section className="blk" style={{ background: 'var(--bg2)', borderTop: '1px solid var(--line)' }}>
        <div className="wrap split">
          <Reveal>
            <div className="eyebrow">NAV Tracker</div>
            <h2 style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', margin: '12px 0 14px' }}>NAV against net contributions.</h2>
            <p style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.65 }}>Track net asset value with deposits stripped out, and the premium or discount on asset-backed names.</p>
          </Reveal>
          <Reveal delay={0.12}>
            <VPanel title="NAV Tracker">
              <NavBars />
            </VPanel>
          </Reveal>
        </div>
      </section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>The full valuation suite, in the terminal.</h2>
          <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
        </div>
      </div></section>
    </Shell>
  )
}
