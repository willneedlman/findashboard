import { Link, Outlet } from 'react-router-dom'
import { Calculator, Filter, Bot, GitBranch, Scale, Sigma, Briefcase, BarChart3, FileText, BookOpen, Bell } from 'lucide-react'
import AlphaMark from '../components/AlphaMark'
import './marketing.css'

/* ── Shared chrome ──────────────────────────────────────────────────────── */

type Active = 'options' | 'valuation' | 'portfolio' | 'macro' | 'trading' | null

/** α + vertical rule + ALPHATAPE / TERMINAL lockup (matches the terminal header). */
function BrandLockup({ markSize = 30 }: { markSize?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
      <AlphaMark size={markSize} style={{ display: 'block' }} />
      <span aria-hidden="true" style={{ width: 1, height: Math.round(markSize * 0.92), background: 'rgba(201,168,76,0.28)', margin: '0 13px' }} />
      <span style={{ display: 'block', lineHeight: 1, textAlign: 'left' }}>
        <span style={{ display: 'block', fontFamily: "'Cinzel', Georgia, serif", fontWeight: 700, fontSize: Math.round(markSize * 0.62), letterSpacing: '0.09em', color: 'var(--gold)' }}>ALPHATAPE</span>
        <span style={{ display: 'block', fontFamily: "'IBM Plex Sans', system-ui, sans-serif", fontWeight: 700, fontSize: Math.round(markSize * 3.1) / 10, letterSpacing: '0.34em', color: 'var(--muted)', marginTop: Math.round(markSize * 0.1) }}>TERMINAL</span>
      </span>
    </span>
  )
}

function Nav({ active }: { active: Active }) {
  const link = (to: string, key: Active, label: string) => (
    <Link to={to} className={active === key ? 'active' : undefined}>{label}</Link>
  )
  return (
    <nav><div className="nav-in">
      <Link to="/" aria-label="AlphaTape Terminal" style={{ textDecoration: 'none' }}><BrandLockup markSize={30} /></Link>
      <div className="nav-links">
        {link('/product/options', 'options', 'Options')}
        {link('/product/valuation', 'valuation', 'Valuation')}
        {link('/product/portfolio', 'portfolio', 'Portfolio')}
        {link('/product/macro', 'macro', 'Macro')}
        {link('/product/trading', 'trading', 'Trading')}
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
        <p className="disc">Market analytics for independent traders. Not investment advice — for research and educational use only.</p>
      </div>
      <div className="col"><h4>Product</h4>
        <Link to="/product/options">Options</Link>
        <Link to="/product/valuation">Valuation</Link>
        <Link to="/product/portfolio">Portfolio</Link>
        <Link to="/product/macro">Macro</Link>
        <Link to="/product/trading">Trading</Link>
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

/* ── Landing visual elements ─────────────────────────────────────────────── */

const TAPE_FEATURES = [
  'Abnormal Options Flow', 'Dealer Gamma', 'Implied Probability', 'Options Pricer', 'Strategy Builder',
  'DCF Valuation', 'Reverse DCF', 'Relative Value', 'Corporate Hub', 'Monte Carlo',
  'Correlation Matrix', 'NAV Tracker', 'Fed Path', 'Credit Spreads', 'Yield Curve',
  'Sector Rotation', 'Paper Trading', 'Trade Journal', 'Price Alerts',
]
function TickerTape() {
  const seq = (p: string) => TAPE_FEATURES.map(f => (
    <span className="tape-cell" key={p + f}><span className="tape-item">{f}</span><span className="tape-dot">·</span></span>
  ))
  return <div className="tape" aria-hidden="true"><div className="tape-track">{seq('a')}{seq('b')}</div></div>
}

const WORKFLOW = [
  { t: 'Research', d: 'Scan macro, sectors, and abnormal options flow for an edge.' },
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
    <polyline points="4,40 92,33 180,19 256,5" fill="none" stroke="#3fb950" strokeWidth="1.6" />
    <polyline points="4,40 92,38 180,30 256,22" fill="none" stroke="rgba(108,140,255,0.75)" strokeWidth="1.2" />
    <polyline points="4,40 92,42 180,45 256,44" fill="none" stroke="rgba(126,147,173,0.6)" strokeWidth="1.2" />
    <polyline points="4,40 92,46 180,52 256,55" fill="none" stroke="rgba(248,81,73,0.6)" strokeWidth="1.2" />
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

/* ── Extended viz library (product pages) ────────────────────────────────── */

const vizBox: React.CSSProperties = { width: '100%', height: 96, display: 'block' }

function MiniFlow() {
  const rows: [string, string, string, 'pos' | 'neg'][] = [
    ['NVDA 1300C', '8.4', '$18.4M', 'pos'], ['SPY 605C', '3.1', '$9.1M', 'pos'],
    ['TSLA 400P', '2.0', '$6.2M', 'neg'], ['AAPL 230C', '1.9', '$4.0M', 'pos'],
  ]
  const th: React.CSSProperties = { fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--dim)', padding: '6px 4px', borderBottom: '1px solid var(--line)' }
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)' }}>
      <thead><tr><th style={{ ...th, textAlign: 'left' }}>Contract</th><th style={{ ...th, textAlign: 'right' }}>Vol/OI</th><th style={{ ...th, textAlign: 'right' }}>Premium</th></tr></thead>
      <tbody>{rows.map(([c, vo, p, d]) => (
        <tr key={c}>
          <td style={{ fontSize: 11, padding: '6px 4px', color: 'var(--text)', fontWeight: 700 }}>{c}</td>
          <td className={d} style={{ fontSize: 11, padding: '6px 4px', textAlign: 'right' }}>{vo}</td>
          <td style={{ fontSize: 11, padding: '6px 4px', textAlign: 'right', color: 'var(--muted)' }}>{p}</td>
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

const PayoffDiagram = () => (
  <svg viewBox="0 0 240 96" style={vizBox} role="img" aria-label="Strategy payoff diagram">
    <line x1="0" y1="60" x2="240" y2="60" stroke="rgba(255,255,255,0.12)" />
    <polyline points="8,82 96,82 232,12" fill="none" stroke="#3fb950" strokeWidth="2" strokeLinejoin="round" />
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

const EquityCurve = () => (
  <svg viewBox="0 0 240 80" style={{ width: '100%', height: 80, display: 'block' }} role="img" aria-label="Equity curve">
    <defs><linearGradient id="eqg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="rgba(63,185,80,0.28)" /><stop offset="1" stopColor="rgba(63,185,80,0)" /></linearGradient></defs>
    <path d="M4,68 L40,60 L76,64 L112,46 L148,50 L184,30 L236,12 L236,80 L4,80 Z" fill="url(#eqg)" />
    <polyline points="4,68 40,60 76,64 112,46 148,50 184,30 236,12" fill="none" stroke="#3fb950" strokeWidth="1.8" />
  </svg>
)

const YieldCurveBig = () => (
  <svg viewBox="0 0 280 120" style={{ width: '100%', height: 120, display: 'block' }} role="img" aria-label="UST yield curve">
    {[26, 53, 80].map(y => <line key={y} x1="0" y1={y} x2="280" y2={y} stroke="rgba(255,255,255,0.04)" />)}
    <line x1="0" y1="106" x2="280" y2="106" stroke="rgba(255,255,255,0.08)" />
    <polyline points="14,80 70,84 122,70 178,48 232,38 270,32" fill="none" stroke="#c9a84c" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    {([[14, 80], [70, 84], [122, 70], [178, 48], [232, 38], [270, 32]] as [number, number][]).map(([x, y]) => <circle key={x} cx={x} cy={y} r="2.8" fill="#0a1320" stroke="#c9a84c" strokeWidth="1.5" />)}
  </svg>
)

/* ── Landing ────────────────────────────────────────────────────────────── */

export function Landing() {
  return (
    <Shell active={null}>
      <TickerTape />
      <header className="hero">
        <div className="wrap hero-grid">
          <div>
            <div className="eyebrow">Institutional-style analytics</div>
            <h1>The whole desk,<br />in one <span className="g">terminal</span>.</h1>
            <p className="lede">Options flow, dealer gamma, DCF valuation, macro rates, backtesting and paper trading — 30+ analytics tools in a single dark terminal, from first idea to sized position.</p>
            <LaunchCTAs secondary={{ to: '/product/options', label: 'Explore the tools' }} />
          </div>
          <div className="term float">
            <div className="tbar"><i></i><i></i><i></i><span className="name">abnormal options flow</span></div>
            <div className="thead"><span className="t">Options flow</span><span className="tag-prev">preview</span></div>
            <table>
              <thead><tr><th>Contract</th><th>Vol</th><th>Vol/OI</th><th>IV</th><th>Premium</th></tr></thead>
              <tbody>
                <tr><td>NVDA 1300C 0DTE</td><td>41,208</td><td className="pos">8.4</td><td>62.1</td><td>$18.4M</td></tr>
                <tr><td>SPY 605C 2DTE</td><td>22,510</td><td className="pos">3.1</td><td>11.8</td><td>$9.1M</td></tr>
                <tr><td>TSLA 400P 9DTE</td><td>9,940</td><td className="neg">2.0</td><td>54.3</td><td>$6.2M</td></tr>
                <tr><td>AAPL 230C 16DTE</td><td>7,330</td><td className="pos">1.9</td><td>24.6</td><td>$4.0M</td></tr>
                <tr><td>MSFT 500C 23DTE</td><td>5,120</td><td className="pos">2.7</td><td>21.0</td><td>$3.3M</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </header>

      <div className="strip"><div className="strip-in">
        <div className="stat"><div className="n"><span className="g">30+</span></div><div className="l">analytics tools</div></div>
        <div className="stat"><div className="n">8</div><div className="l">options modules</div></div>
        <div className="stat"><div className="n">5</div><div className="l">macro &amp; rates views</div></div>
        <div className="stat"><div className="n">100%</div><div className="l">browser-based</div></div>
      </div></div>

      <section className="blk" id="tools"><div className="wrap">
        <div className="sec-head">
          <div className="eyebrow">One terminal, every workflow</div>
          <h2>Built like a trading desk, not a toy dashboard.</h2>
          <p>Each module is a real analytical surface with live data — not a static chart. Move from a macro thesis to an options structure to a paper fill without leaving the terminal.</p>
        </div>
        <div className="bento">
          <Link className="card c-tall glow-gold" to="/product/options">
            <div className="k">Options intelligence</div>
            <h3>See the flow before it moves price.</h3>
            <p>Abnormal options activity, dealer gamma exposure, IV rank, implied probability, and a full market-maker simulator.</p>
            <div className="mini">
              <div className="row"><span>Dealer GEX</span><span className="pos mono">+2.1B</span></div>
              <div className="row"><span>IV Rank · SPX</span><span className="mono">18%</span></div>
              <div className="row"><span>Put/Call</span><span className="neg mono">0.92</span></div>
            </div>
            <div className="tags"><span className="tag">GEX</span><span className="tag">Abnormal flow</span><span className="tag">IV surface</span><span className="tag">MM sim</span></div>
          </Link>
          <Link className="card c-2" to="/product/valuation">
            <div className="k">Valuation</div><h3>Find what it's worth.</h3>
            <p>Discounted cash flow, reverse-DCF, and peer comparison to judge fair value against the market price.</p>
            <ValuationViz />
          </Link>
          <Link className="card c-2 glow-blue" to="/product/portfolio">
            <div className="k">Portfolio &amp; risk</div><h3>Backtest, simulate, analyze.</h3>
            <p>Monte Carlo paths, correlation analysis, and net-greek exposure across the book.</p>
            <PortfolioViz />
          </Link>
          <Link className="card c-wide" to="/product/macro">
            <div className="k">Macro &amp; rates</div><h3>Top-down context, wired into every ticker.</h3>
            <p>Fed-path probabilities, credit spreads, the yield curve and sector rotation — the regime backdrop for every trade you size.</p>
            <MacroViz />
            <div className="tags"><span className="tag">Fed path</span><span className="tag">Credit spreads</span><span className="tag">Yield curve</span><span className="tag">Sector rotation</span></div>
          </Link>
        </div>
      </div></section>

      <section className="blk" id="depth" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg2)' }}>
        <div className="wrap split">
          <div>
            <div className="eyebrow">Signal, not noise</div>
            <h2 style={{ fontSize: 32, fontWeight: 700, letterSpacing: '-0.02em', margin: '12px 0 14px' }}>Catch the print soon after it hits the tape.</h2>
            <p style={{ color: 'var(--muted)', fontSize: 15.5, lineHeight: 1.65 }}>The flow scanner sweeps liquid chains for volume spikes and volume/open-interest surges, ranks by traded premium, and flags freshly-opened positioning. Sort by DTE, moneyness, or premium and drill straight into the contract.</p>
            <div className="cta" style={{ marginTop: 24 }}><Link to="/product/options" className="btn btn-ghost btn-lg">Open Options →</Link></div>
          </div>
          <div className="term">
            <div className="tbar"><i></i><i></i><i></i><span className="name">portfolio · risk</span></div>
            <div className="thead"><span className="t">Portfolio</span><span className="tag-prev">preview</span></div>
            <table>
              <thead><tr><th>Symbol</th><th>Day%</th><th>Value</th><th>Weight</th></tr></thead>
              <tbody>
                <tr><td>NVDA</td><td className="pos">+2.14</td><td>$260,128</td><td><span className="bar7"><i style={{ width: '100%' }}></i></span></td></tr>
                <tr><td>MSFT</td><td className="pos">+0.88</td><td>$149,436</td><td><span className="bar7"><i style={{ width: '57%' }}></i></span></td></tr>
                <tr><td>AAPL</td><td className="neg">-0.42</td><td>$146,470</td><td><span className="bar7"><i style={{ width: '56%' }}></i></span></td></tr>
                <tr><td>SPY</td><td className="pos">+0.31</td><td>$108,819</td><td><span className="bar7"><i style={{ width: '42%' }}></i></span></td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)' }}><div className="wrap">
        <div className="sec-head">
          <div className="eyebrow">One continuous workflow</div>
          <h2>From idea to reviewed trade.</h2>
          <p>The whole loop lives in one terminal — no exporting to three other tabs to reach a decision.</p>
        </div>
        <div className="flow">
          {WORKFLOW.map((s, i) => (
            <div className="step" key={s.t}><div className="node">{i + 1}</div><h4>{s.t}</h4><p>{s.d}</p></div>
          ))}
        </div>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <div className="eyebrow">Built for independent traders</div>
          <h2>Open the terminal.</h2>
          <p>An institutional-style analytics desk that runs in your browser. Bring your own thesis.</p>
          <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
        </div>
      </div></section>
    </Shell>
  )
}

/* ── Options ────────────────────────────────────────────────────────────── */

const Frow = ({ idx, title, badge, children, tags }: { idx: string; title: string; badge?: string; children: React.ReactNode; tags: string[] }) => (
  <div className="frow"><div className="idx">{idx}</div><div>
    <h3>{title}{badge && <span className="badge">{badge}</span>}</h3>
    <p>{children}</p>
    <div className="tags">{tags.map(t => <span className="tag" key={t}>{t}</span>)}</div>
  </div></div>
)

export function OptionsPage() {
  return (
    <Shell active="options">
      <header className="phero"><div className="wrap">
        <div className="eyebrow">Options intelligence</div>
        <h1>Trade the second derivative.</h1>
        <p className="lede">Eight modules covering flow, positioning, volatility and pricing. See where the money is, what dealers are forced to hedge, and exactly what you're paying for convexity.</p>
        <div className="cta"><LaunchCTAs secondary={{ to: '/', label: 'Overview' }} /></div>
      </div></header>

      <section className="blk"><div className="wrap">
        <div className="sec-head">
          <div className="eyebrow">Flow · gamma · vol · probability</div>
          <h2>Four surfaces on the options chain.</h2>
        </div>
        <div className="showcase">
          <div className="vpanel">
            <div className="vh"><span className="vt">Abnormal Options Flow</span><span className="vtag">preview</span></div>
            <div className="vb"><MiniFlow /></div>
            <p className="vd">Sweep liquid chains for volume and volume/open-interest surges, ranked by traded premium, with freshly-opened positioning flagged automatically.</p>
            <div className="vtags"><span className="tag">Vol/OI surge</span><span className="tag">Premium rank</span><span className="tag">New positioning</span></div>
          </div>
          <div className="vpanel">
            <div className="vh"><span className="vt">Dealer Gamma Exposure</span><span className="vtag">preview</span></div>
            <div className="vb"><GammaProfile /></div>
            <p className="vd">Net dealer gamma by strike, the zero-gamma flip, and the pin and acceleration zones that shape intraday behavior.</p>
            <div className="vtags"><span className="tag">GEX profile</span><span className="tag">Flip point</span><span className="tag">Pin risk</span></div>
          </div>
          <div className="vpanel">
            <div className="vh"><span className="vt">IV Tracker &amp; Surface</span><span className="vtag">preview</span></div>
            <div className="vb"><SkewCurve /></div>
            <p className="vd">IV rank and percentile, term structure and skew, plus implied versus realized vol — spot rich or cheap premium before you put on a structure.</p>
            <div className="vtags"><span className="tag">IV rank</span><span className="tag">Term structure</span><span className="tag">Skew</span></div>
          </div>
          <div className="vpanel">
            <div className="vh"><span className="vt">Implied Probability</span><span className="vtag">preview</span></div>
            <div className="vb"><ProbDist /></div>
            <p className="vd">The option-implied risk-neutral distribution for any expiry, with probability of touch and of expiring in the money at every strike.</p>
            <div className="vtags"><span className="tag">Risk-neutral PDF</span><span className="tag">P(touch)</span><span className="tag">P(ITM)</span></div>
          </div>
        </div>
        <div className="modgrid">
          <div className="mod"><div className="mh"><span className="mi"><Calculator size={15} /></span><h4>Options Pricer</h4></div><p>Black-Scholes with the full greek set — delta, gamma, theta, vega, rho — and instant what-if on spot, vol and time.</p></div>
          <div className="mod"><div className="mh"><span className="mi"><Filter size={15} /></span><h4>Chain Scanner</h4></div><p>The full chain with greeks, bid/ask and open interest. Filter by delta, DTE and moneyness to isolate the contracts you trade.</p></div>
          <div className="mod"><div className="mh"><span className="mi"><Bot size={15} /></span><h4>Market-Maker Simulator</h4></div><p>Quote two-sided markets, absorb simulated flow, and manage inventory and delta hedging — see the other side of your trade.</p></div>
          <div className="mod"><div className="mh"><span className="mi"><GitBranch size={15} /></span><h4>Strategy &amp; Payoff Builder</h4></div><p>Compose multi-leg structures and read payoff, breakevens and P&L both at expiry and right now.</p></div>
        </div>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>All eight options modules, in the terminal.</h2>
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
      <header className="phero"><div className="wrap">
        <div className="eyebrow">Valuation</div>
        <h1>Know what it's worth,<br />not just what it costs.</h1>
        <p className="lede">Discounted cash flow, peer comps, and reverse-DCF — every model resolves to an answer, even when a company's reported data is thin.</p>
        <div className="cta"><LaunchCTAs secondary={{ to: '/', label: 'Overview' }} /></div>
      </div></header>

      <section className="blk"><div className="wrap">
        <div className="sec-head">
          <div className="eyebrow">Valuation methods</div>
          <h2>Intrinsic value, and how sensitive it is.</h2>
        </div>
        <div className="showcase">
          <div className="vpanel">
            <div className="vh"><span className="vt">DCF · NVDA</span><span className="vtag">preview</span></div>
            <div className="vb">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11.5 }}><tbody>
                {([['Revenue (TTM)', '$148.5B', ''], ['Operating margin', '61.2%', ''], ['WACC', '9.4%', ''], ['Terminal growth', '2.5%', ''], ['Intrinsic / share', '$1,206', 'pos'], ['Market price', '$1,182', ''], ['Upside', '+2.0%', 'pos']] as [string, string, string][]).map(([k, v, cls]) => (
                  <tr key={k}><td style={{ padding: '6px 2px', color: 'var(--muted)' }}>{k}</td><td className={cls} style={{ padding: '6px 2px', textAlign: 'right', color: cls ? undefined : 'var(--text)' }}>{v}</td></tr>
                ))}
              </tbody></table>
            </div>
            <p className="vd">Project free cash flow, set WACC and terminal growth, and read intrinsic value per share against the market price.</p>
          </div>
          <div className="vpanel">
            <div className="vh"><span className="vt">Sensitivity · WACC × growth</span><span className="vtag">upside %</span></div>
            <div className="vb"><SensitivityGrid /></div>
            <p className="vd">The same model across a grid of discount-rate and growth assumptions — see how much the call depends on its inputs, not just the point estimate.</p>
          </div>
        </div>
        <div className="modgrid">
          <div className="mod"><div className="mh"><span className="mi"><BarChart3 size={15} /></span><h4>DCF Valuation</h4></div><p>Free-cash-flow model with WACC and terminal growth. When a company's beta or margins are missing, it resolves from industry data instead of stalling.</p></div>
          <div className="mod"><div className="mh"><span className="mi"><Scale size={15} /></span><h4>Relative Valuation</h4></div><p>Peer comparison across P/E, EV/EBITDA, EV/Sales and P/B against sector medians — green where a name beats the set, red where it lags.</p></div>
          <div className="mod"><div className="mh"><span className="mi"><Sigma size={15} /></span><h4>Reverse DCF</h4></div><p>Solve for the growth and margins the current price already implies, and judge whether the market's expectations are reasonable.</p></div>
          <div className="mod"><div className="mh"><span className="mi"><Briefcase size={15} /></span><h4>Corporate Hub</h4></div><p>Statements, revenue by segment and geography, company profile and peers — the qualitative context behind the numbers.</p></div>
        </div>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>The full valuation suite, in the terminal.</h2>
          <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
        </div>
      </div></section>
    </Shell>
  )
}

/* ── Portfolio ──────────────────────────────────────────────────────────── */

export function PortfolioPage() {
  return (
    <Shell active="portfolio">
      <header className="phero"><div className="wrap">
        <div className="eyebrow">Portfolio &amp; risk</div>
        <h1>Know your risk before<br />the market tells you.</h1>
        <p className="lede">Track the book, then pressure-test it: backtests, thousands of Monte Carlo paths, and correlation analysis — so the drawdown is a number you've already modeled, not a surprise.</p>
        <div className="cta"><LaunchCTAs secondary={{ to: '/', label: 'Overview' }} /></div>
      </div></header>

      <section className="blk"><div className="wrap">
        <div className="sec-head">
          <div className="eyebrow">Portfolio &amp; risk</div>
          <h2>Track the book, model the risk.</h2>
        </div>
        <div className="bento">
          <div className="card c-3">
            <div className="k">01 · Portfolio Manager</div>
            <h3>The whole book, live.</h3>
            <p>Holdings, P&amp;L, position weights and aggregated option greeks across every leg — net delta, gamma, theta and vega at a glance.</p>
            <div className="mini">
              <div className="row"><span>Net Liq</span><span className="mono">$1,284,930</span></div>
              <div className="row"><span>Day P&amp;L</span><span className="pos mono">+$8,412</span></div>
              <div className="row"><span>Net delta</span><span className="mono">+1,940</span></div>
              <div className="row"><span>Net theta</span><span className="neg mono">-318</span></div>
            </div>
          </div>
          <div className="card c-3 glow-blue">
            <div className="k">02 · Backtester</div>
            <h3>Test the rule, not the hunch.</h3>
            <p>Run allocation and strategy rules over history with CAGR, Sharpe and max-drawdown.</p>
            <EquityCurve />
            <div className="tags"><span className="tag">CAGR</span><span className="tag">Sharpe</span><span className="tag">Max drawdown</span></div>
          </div>
          <div className="card c-2 glow-gold">
            <div className="k">03 · Monte Carlo</div><h3>Thousands of futures.</h3>
            <p>Forward paths into percentile cones and value-at-risk.</p>
            <PortfolioViz />
          </div>
          <div className="card c-2">
            <div className="k">04 · Correlation Matrix</div><h3>What moves together.</h3>
            <p>Rolling correlations across holdings and benchmarks.</p>
            <div style={{ marginTop: 14 }}><CorrHeatmap /></div>
          </div>
          <div className="card c-2">
            <div className="k">05 · NAV Tracker</div><h3>NAV over time.</h3>
            <p>NAV, contributions and time-weighted returns — deposits stripped out.</p>
            <EquityCurve />
          </div>
        </div>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>Track and model your book in the terminal.</h2>
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
      <header className="phero"><div className="wrap">
        <div className="eyebrow">Macro &amp; rates</div>
        <h1>Top-down context for<br />every trade you size.</h1>
        <p className="lede">The regime backdrop — Fed path, credit, the curve, and sector leadership — wired alongside your tickers. Trade with the cycle, not against it.</p>
        <div className="cta"><LaunchCTAs secondary={{ to: '/', label: 'Overview' }} /></div>
      </div></header>

      <section className="blk"><div className="wrap">
        <div className="sec-head">
          <div className="eyebrow">Rates · credit · curve</div>
          <h2>The regime board.</h2>
        </div>
        <div className="showcase">
          <div className="vpanel">
            <div className="vh"><span className="vt">Rate &amp; credit board</span><span className="tag-prev">preview</span></div>
            <div className="vb">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                <thead><tr>{['Series', 'Level', 'Δ 1M'].map((h, i) => <th key={h} style={{ fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--dim)', padding: '6px 2px', textAlign: i === 0 ? 'left' : 'right', borderBottom: '1px solid var(--line)' }}>{h}</th>)}</tr></thead>
                <tbody>
                  {([['Fed funds (mid)', '4.13', '-0.25', 'neg'], ['2Y UST', '3.71', '-0.18', 'neg'], ['10Y UST', '4.05', '+0.06', 'pos'], ['2s10s', '+0.34', '+0.24', 'pos'], ['IG OAS', '92', '+4', 'pos'], ['HY OAS', '318', '+19', 'pos']] as [string, string, string, string][]).map(([s, l, d, cls]) => (
                    <tr key={s}><td style={{ padding: '6px 2px', color: 'var(--text)', fontWeight: 700 }}>{s}</td><td style={{ padding: '6px 2px', textAlign: 'right', color: 'var(--muted)' }}>{l}</td><td className={cls} style={{ padding: '6px 2px', textAlign: 'right' }}>{d}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="vpanel">
            <div className="vh"><span className="vt">Yield curve · UST</span><span className="tag-prev">preview</span></div>
            <div className="vb">
              <YieldCurveBig />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--dim)' }}>
                <span>2Y</span><span>5Y</span><span>10Y</span><span>20Y</span><span>30Y</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)', fontFamily: 'var(--mono)', fontSize: 11 }}>
                {([['2Y', '3.71'], ['10Y', '4.05'], ['30Y', '4.42'], ['2s10s', '+0.34']] as [string, string][]).map(([l, v]) => (
                  <div key={l}><span style={{ color: 'var(--dim)', fontSize: 9, display: 'block', letterSpacing: '0.06em' }}>{l}</span><span style={{ color: 'var(--text)' }}>{v}</span></div>
                ))}
              </div>
            </div>
            <p className="vd">Curve shape and the 2s10s spread at a glance — the recession-signal context behind every position.</p>
          </div>
        </div>

        <div style={{ marginTop: 40 }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>Sector rotation · 1M relative to SPY</div>
          <div className="sectors">
            {([['Tech', '+4.2', 'pos'], ['Comm', '+2.1', 'pos'], ['Disc', '+1.4', 'pos'], ['Fin', '+0.6', 'pos'], ['Indu', '+0.2', 'pos'], ['Health', '-0.3', 'neg'], ['Energy', '-1.1', 'neg'], ['Staples', '-0.8', 'neg'], ['Util', '-1.6', 'neg'], ['REIT', '-2.0', 'neg'], ['Mat', '-0.5', 'neg']] as [string, string, string][]).map(([l, v, d]) => (
              <div className="sct" key={l} style={{ background: d === 'pos' ? 'rgba(63,185,80,0.06)' : 'rgba(248,81,73,0.06)' }}><div className="scl">{l}</div><div className={`scv ${d}`}>{v}%</div></div>
            ))}
          </div>
        </div>

        <div className="modgrid">
          <div className="mod"><div className="mh"><span className="mi"><Scale size={15} /></span><h4>Fed Rates</h4></div><p>Market-implied policy path, the dot plot, and the odds of cuts or hikes at upcoming meetings.</p></div>
          <div className="mod"><div className="mh"><span className="mi"><Sigma size={15} /></span><h4>Credit Spreads</h4></div><p>IG and HY option-adjusted spreads against equity vol — the market's earliest stress signal.</p></div>
          <div className="mod"><div className="mh"><span className="mi"><BarChart3 size={15} /></span><h4>Yield Curve &amp; Bonds</h4></div><p>Curve shape, the 2s10s inversion, plus duration and convexity for fixed-income positioning.</p></div>
          <div className="mod"><div className="mh"><span className="mi"><Briefcase size={15} /></span><h4>Macro Hub</h4></div><p>Growth, inflation and employment on one board — CPI, NFP, GDP and more.</p></div>
          <div className="mod"><div className="mh"><span className="mi"><GitBranch size={15} /></span><h4>Sector Rotation</h4></div><p>Relative strength and momentum across the eleven S&P sectors versus SPY.</p></div>
        </div>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>The macro and rates board, in the terminal.</h2>
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
      <header className="phero"><div className="wrap">
        <div className="eyebrow">Trading &amp; execution</div>
        <h1>From thesis to fill.</h1>
        <p className="lede">Build the strategy, paper-trade it with live prices, and journal every result — the full loop from idea to reviewed outcome, without leaving the terminal.</p>
        <div className="cta"><LaunchCTAs secondary={{ to: '/', label: 'Overview' }} /></div>
      </div></header>

      <section className="blk"><div className="wrap">
        <div className="sec-head">
          <div className="eyebrow">Trading workflow</div>
          <h2>From strategy to journaled fill.</h2>
        </div>
        <div className="loop">
          <div className="lp"><div className="lpn"><b><GitBranch size={13} /></b> Strategy Builder</div><h4>Define the rules.</h4><p>Compose entry and exit rules, parameters and signals into a repeatable strategy — no code required.</p><div className="lptags"><span className="tag">Rules</span><span className="tag">Signals</span></div></div>
          <div className="lp"><div className="lpn"><b><FileText size={13} /></b> Paper Trading</div><h4>Trade it, risk-free.</h4><p>Simulated order execution with live prices — equities and options, position tracking and P&L.</p><div className="lptags"><span className="tag">Live prices</span><span className="tag">Equities + options</span></div></div>
          <div className="lp"><div className="lpn"><b><BookOpen size={13} /></b> Trade Journal</div><h4>Review the result.</h4><p>Log every trade, tag the setup, and track win-rate and expectancy over time.</p><div className="lptags"><span className="tag">Win rate</span><span className="tag">Expectancy</span></div></div>
          <div className="lp"><div className="lpn"><b><Bell size={13} /></b> Price Alerts</div><h4>Never miss the trigger.</h4><p>Set price and 1-day % change alerts, pushed to your browser the moment they fire.</p><div className="lptags"><span className="tag">Price</span><span className="tag">% change</span></div></div>
        </div>
      </div></section>

      <section className="blk" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg2)' }}><div className="wrap split">
        <div>
          <div className="eyebrow">Trade journal</div>
          <h2 style={{ fontSize: 30, fontWeight: 700, letterSpacing: '-0.02em', margin: '12px 0 14px' }}>Win-rate and expectancy over time.</h2>
          <p style={{ color: 'var(--muted)', fontSize: 15, lineHeight: 1.65 }}>Log every trade and tag the setup. The journal tracks win-rate, average expectancy, and which setups actually carry their weight.</p>
          <div className="statline">
            <div className="statbox"><div className="sbv pos">58%</div><div className="sbl">Win rate</div></div>
            <div className="statbox"><div className="sbv">1.9R</div><div className="sbl">Avg. expectancy</div></div>
            <div className="statbox"><div className="sbv">142</div><div className="sbl">Trades logged</div></div>
          </div>
        </div>
        <div className="vpanel">
          <div className="vh"><span className="vt">Journal · equity curve</span><span className="tag-prev">preview</span></div>
          <div className="vb"><EquityCurve /></div>
        </div>
      </div></section>

      <section className="blk"><div className="wrap">
        <div className="final">
          <h2>Build, paper-trade, and journal in the terminal.</h2>
          <Link to="/app" className="btn btn-gold btn-lg">Launch Terminal →</Link>
        </div>
      </div></section>
    </Shell>
  )
}
