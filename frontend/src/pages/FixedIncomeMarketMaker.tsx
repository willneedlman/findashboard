import { useEffect, useRef, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import { RailSection } from './valuationShared'

/*
 * Fixed Income MM Simulator
 * -------------------------
 * The rates-desk analog of the Options MM Simulator. You stream two-sided quotes
 * on a strip of Treasuries, earn the bid-ask spread on client flow, take on
 * inventory measured in DV01 (dollar duration) and convexity, and hedge the rate
 * risk by trading a benchmark note. Fully client side: a 1-second game loop, a
 * mean-reverting yield level, and standard bond math in TypeScript. No backend.
 */

// ── Theme (dark terminal palette; panels use --theme-bg, not surface) ──────────
const T = {
  bg:       'var(--theme-bg, #101c2e)',
  surface:  'var(--theme-surface, #0d1826)',
  border:   'var(--theme-border, rgba(255,255,255,0.08))',
  gold:     'var(--theme-primary, #c9a84c)',
  text:     'var(--theme-text, #d7e3fc)',
  muted:    'var(--theme-secondary, #5e768f)',
  green:    'var(--theme-positive, #22c55e)',
  red:      'var(--theme-negative, #ef4444)',
  mono:     'var(--theme-mono)',
  sans:     'var(--theme-sans)',
}

// ── Market constants ────────────────────────────────────────────────────────────
interface BondDef { id: string; maturity: number; coupon: number }
// Coupons set near the starting yields so each bond opens close to par.
const BONDS: BondDef[] = [
  { id: '2Y',  maturity: 2,  coupon: 3.9 },
  { id: '5Y',  maturity: 5,  coupon: 4.0 },
  { id: '10Y', maturity: 10, coupon: 4.2 },
  { id: '30Y', maturity: 30, coupon: 4.5 },
]
const BENCH = '10Y'                      // hedge instrument: the on-the-run 10Y note
const BENCH_MAT = BONDS.find(b => b.id === BENCH)!.maturity
const CURVE0: Record<string, number> = { '2Y': 3.9, '5Y': 4.0, '10Y': 4.2, '30Y': 4.5 }  // starting yields (%)
const FACE_UNIT       = 1000             // one "bond" = $1,000 face
const DOLLARS_PER_PT  = FACE_UNIT / 100  // $10 P&L per 1.00 price point, per unit
const ORDER_MIN_TICKS = 3
const ORDER_MAX_TICKS = 5
const ORDER_SIZES     = [10, 25, 50, 100, 250]   // units of $1k face
const DV01_LIMIT      = 250              // |net DV01| ($/bp) above this flashes a warning
const MEAN_REVERT     = 0.02             // gentle pull of the yield level back toward start
const SPEED_MIN       = 0.1
const SPEED_MAX       = 3.0

const randIntInclusive = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1))

// ── Bond math (semiannual; price per $100 face) ─────────────────────────────────
interface BondMath { price: number; modDur: number; convexity: number }
function bondMath(coupon: number, maturity: number, yieldPct: number, freq = 2): BondMath {
  const n = Math.max(1, Math.round(maturity * freq))
  const c = coupon / freq                 // coupon per $100 face per period
  const y = (yieldPct / 100) / freq       // periodic yield (always > 0; bondYield floors it)
  let price = 0, dur = 0, conv = 0
  for (let t = 1; t <= n; t++) {
    const cf = c + (t === n ? 100 : 0)
    const disc = Math.pow(1 + y, t)
    const pv = cf / disc
    price += pv
    dur   += (t / freq) * pv
    conv  += cf * t * (t + 1) / Math.pow(1 + y, t + 2)
  }
  const macaulay  = dur / price
  const modDur    = macaulay / (1 + y)
  const convexity = conv / price / (freq * freq)              // years^2
  return { price, modDur, convexity }
}

// Dollars of P&L per 1bp yield move, per $1k-face unit (long-duration positive).
const perUnitDV01 = (m: BondMath) => m.modDur * m.price * 0.0001 * DOLLARS_PER_PT

// ── Simulation state ────────────────────────────────────────────────────────────
interface Fill { tLabel: string; clientSide: string; bond: string; size: number; fillPrice: number; edge: number }

interface SimState {
  shift: number                    // parallel yield shift off the starting curve (%)
  cash: number; hedge: number      // hedge = benchmark units held (the rate hedge)
  positions: Record<string, number>
  edgeTotal: number; ledger: Fill[]
  tick: number; nextOrderTick: number
  lastOrder: Fill | null; lastOrderAt: number
  yldHistory: number[]             // 10Y yield level for the tape
}

function freshState(): SimState {
  const positions: Record<string, number> = {}
  for (const b of BONDS) positions[b.id] = 0
  return {
    shift: 0, cash: 0, hedge: 0, positions, edgeTotal: 0, ledger: [],
    tick: 0, nextOrderTick: randIntInclusive(ORDER_MIN_TICKS, ORDER_MAX_TICKS),
    lastOrder: null, lastOrderAt: 0, yldHistory: [CURVE0[BENCH]],
  }
}

interface Ctrl { rateVolBp: number; slopeBp: number; halfSpread: number; manual: Record<string, number>; running: boolean; speed: number }

// Yield for a given bond: starting curve + market shift + maker slope tilt + manual nudge.
function bondYield(id: string, maturity: number, s: SimState, c: Ctrl): number {
  const tilt   = (c.slopeBp / 100) * ((maturity - 10) / 10)   // steepener/flattener about the 10Y
  const manual = (c.manual[id] ?? 0) / 100
  return Math.max(0.01, CURVE0[id] + s.shift + tilt + manual)
}

function advanceCurve(s: SimState, c: Ctrl): void {
  // Mean-reverting random walk of the yield level (Box-Muller standard normal).
  const z = Math.sqrt(-2 * Math.log(Math.random() || 1e-12)) * Math.cos(2 * Math.PI * Math.random())
  s.shift = s.shift * (1 - MEAN_REVERT) + (c.rateVolBp / 100) * z
  s.yldHistory.push(bondYield(BENCH, BENCH_MAT, s, c))   // same yield the 10Y row quotes
  if (s.yldHistory.length > 120) s.yldHistory = s.yldHistory.slice(-120)
}

interface Quote { id: string; maturity: number; coupon: number; yieldPct: number; price: number; modDur: number; convexity: number; dv01: number; bid: number; ask: number }
type Book = Record<string, Quote>

function buildBook(s: SimState, c: Ctrl): Book {
  const book: Book = {}
  for (const b of BONDS) {
    const yld = bondYield(b.id, b.maturity, s, c)
    const m   = bondMath(b.coupon, b.maturity, yld)
    const hs  = c.halfSpread
    book[b.id] = {
      id: b.id, maturity: b.maturity, coupon: b.coupon, yieldPct: yld,
      price: m.price, modDur: m.modDur, convexity: m.convexity, dv01: perUnitDV01(m),
      bid: m.price - hs, ask: m.price + hs,
    }
  }
  return book
}

function maybeGenerateOrder(s: SimState, book: Book, running: boolean): void {
  if (!running || s.tick < s.nextOrderTick) return
  const b = BONDS[(Math.random() * BONDS.length) | 0]
  const q = book[b.id]
  const clientSide = Math.random() < 0.5 ? 'BUY' : 'SELL'
  const size = ORDER_SIZES[(Math.random() * ORDER_SIZES.length) | 0]
  let fill: number, edge: number
  if (clientSide === 'BUY') {
    // Client lifts our ASK -> we go short the bond. Edge = ask - theo.
    fill = q.ask; edge = (fill - q.price) * size * DOLLARS_PER_PT
    s.positions[b.id] -= size; s.cash += fill * size * DOLLARS_PER_PT
  } else {
    // Client hits our BID -> we go long the bond. Edge = theo - bid.
    fill = q.bid; edge = (q.price - fill) * size * DOLLARS_PER_PT
    s.positions[b.id] += size; s.cash -= fill * size * DOLLARS_PER_PT
  }
  s.edgeTotal += edge
  const rec: Fill = { tLabel: new Date().toLocaleTimeString('en-US', { hour12: false }), clientSide, bond: b.id, size, fillPrice: fill, edge }
  s.ledger.push(rec)
  s.lastOrder = rec; s.lastOrderAt = Date.now() / 1000
  s.nextOrderTick = s.tick + randIntInclusive(ORDER_MIN_TICKS, ORDER_MAX_TICKS)
}

interface Risk { netDV01: number; convexity: number; grossNotional: number; netPnl: number; benchPrice: number; benchDV01: number }
function portfolioRisk(s: SimState, book: Book): Risk {
  let netDV01 = 0, convexity = 0, grossNotional = 0, bondValue = 0
  for (const b of BONDS) {
    const pos = s.positions[b.id]
    const q = book[b.id]
    if (pos) {
      const mv = pos * q.price * DOLLARS_PER_PT
      netDV01       += pos * q.dv01
      convexity     += 0.5 * q.convexity * mv * 0.01 * 0.01     // P&L from curvature on a 100bp move
      grossNotional += Math.abs(pos) * FACE_UNIT
      bondValue     += mv
    }
  }
  const bench = book[BENCH]
  const benchDV01 = bench.dv01
  const hedgeValue = s.hedge * bench.price * DOLLARS_PER_PT
  netDV01   += s.hedge * benchDV01
  convexity += 0.5 * bench.convexity * hedgeValue * 0.01 * 0.01
  const netPnl = s.cash + bondValue + hedgeValue
  return { netDV01, convexity, grossNotional, netPnl, benchPrice: bench.price, benchDV01 }
}

function tradeHedge(s: SimState, book: Book, qty: number): void {
  // Manual rate hedge: buy (qty > 0) / sell (qty < 0) the benchmark note. Long
  // benchmark adds positive DV01 (gains as yields fall), offsetting short inventory.
  if (!qty) return
  const px = book[BENCH].price
  s.cash -= qty * px * DOLLARS_PER_PT
  s.hedge += qty
  s.ledger.push({
    tLabel: new Date().toLocaleTimeString('en-US', { hour12: false }),
    clientSide: qty > 0 ? 'BUY BENCH' : 'SELL BENCH', bond: BENCH,
    size: Math.abs(qty), fillPrice: px, edge: 0,
  })
}

function fmtMoney(x: number): string {
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Frame {
  book: Book; risk: Risk; tenY: number; yldHistory: number[]
  positions: Record<string, number>; hedge: number; edge: number
  ledger: Fill[]; lastOrder: Fill | null; lastOrderAt: number; running: boolean
}

export default function FixedIncomeMarketMaker() {
  const sim = useRef<SimState>(freshState())
  const [paramsOpen, setParamsOpen] = useState(true)
  const [rateVolBp, setRateVolBp]   = useState(3)
  const [slopeBp, setSlopeBp]       = useState(0)
  const [halfSpread, setHalfSpread] = useState(0.06)
  const [manual, setManual]         = useState<Record<string, number>>(() => Object.fromEntries(BONDS.map(b => [b.id, 0])))
  const [running, setRunning]       = useState(false)
  const [speed, setSpeed]           = useState(0.5)
  const [hedgeQty, setHedgeQty]     = useState(50)
  const [rulesOpen, setRulesOpen]   = useState(false)
  const [frame, setFrame]           = useState<Frame | null>(null)

  // Latest controls available to the (single, stable) game-loop.
  const ctrl = useRef<Ctrl>({ rateVolBp, slopeBp, halfSpread, manual, running, speed })
  ctrl.current = { rateVolBp, slopeBp, halfSpread, manual, running, speed }

  const snapshot = (s: SimState, c: Ctrl): Frame => {
    const book = buildBook(s, c)
    return {
      book, risk: portfolioRisk(s, book),
      tenY: bondYield(BENCH, BENCH_MAT, s, c), yldHistory: [...s.yldHistory],
      positions: { ...s.positions }, hedge: s.hedge, edge: s.edgeTotal,
      ledger: s.ledger.slice(-18), lastOrder: s.lastOrder, lastOrderAt: s.lastOrderAt, running: c.running,
    }
  }

  // Self-scheduling loop so the Sim Speed slider can change cadence live.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const loop = () => {
      const s = sim.current, c = ctrl.current
      if (c.running) {
        s.tick += 1
        advanceCurve(s, c)
        maybeGenerateOrder(s, buildBook(s, c), c.running)
      }
      setFrame(snapshot(s, c))
      timer = setTimeout(loop, Math.round(1000 / c.speed))
    }
    setFrame(snapshot(sim.current, ctrl.current))
    timer = setTimeout(loop, Math.round(1000 / ctrl.current.speed))
    return () => clearTimeout(timer)
  }, [])

  const onTradeHedge = (qty: number) => {
    const s = sim.current
    tradeHedge(s, buildBook(s, ctrl.current), qty)
    setFrame(snapshot(s, ctrl.current))
  }
  const onReset = () => {
    sim.current = freshState()
    setFrame(snapshot(sim.current, ctrl.current))
  }

  const f = frame
  const r = f?.risk
  const overLimit = r ? Math.abs(r.netDV01) > DV01_LIMIT : false
  const nowSec = Date.now() / 1000
  const showAlert = f?.lastOrder && (nowSec - f.lastOrderAt) < 4

  // ── Sidebar: controls + rules ────────────────────────────────────────────
  const labelStyle: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, marginBottom: 3, fontFamily: T.sans }
  const sliderRow = (label: string, value: string, slider: React.ReactNode, ends?: [string, string]) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={labelStyle}>{label}</span>
        <span style={{ fontSize: 10, fontFamily: T.mono, color: T.gold }}>{value}</span>
      </div>
      {slider}
      {ends && (
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 1 }}>
          <span style={{ fontSize: 8, fontFamily: T.sans, letterSpacing: '0.08em', color: T.muted }}>{ends[0]}</span>
          <span style={{ fontSize: 8, fontFamily: T.sans, letterSpacing: '0.08em', color: T.muted }}>{ends[1]}</span>
        </div>
      )}
    </div>
  )
  const range = (val: number, min: number, max: number, step: number, onChange: (v: number) => void) => (
    <input type="range" min={min} max={max} step={step} value={val}
      onChange={e => onChange(+e.target.value)}
      style={{ width: '100%', accentColor: T.gold }} />
  )

  const sidebar = (
    <RailSection title="MM Controls" open={paramsOpen} onToggle={() => setParamsOpen(o => !o)}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: T.mono }}>
      {sliderRow('Sim Speed', `${speed.toFixed(1)}x`, range(speed, SPEED_MIN, SPEED_MAX, 0.1, setSpeed))}
      {sliderRow('Rate Volatility', `${rateVolBp.toFixed(1)} bp/tick`, range(rateVolBp, 0.5, 10, 0.5, setRateVolBp))}
      {sliderRow('Curve Slope', `${slopeBp >= 0 ? '+' : ''}${slopeBp} bp`, range(slopeBp, -20, 20, 1, setSlopeBp), ['Flatten', 'Steepen'])}
      {sliderRow('Half-Spread', `${halfSpread.toFixed(2)} pts`, range(halfSpread, 0.01, 0.5, 0.01, setHalfSpread))}

      <div style={{ ...labelStyle, marginTop: 6 }}>Manual per-bond yield nudge (bp)</div>
      {BONDS.map(b => (
        <div key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 10, fontFamily: T.mono, color: T.text, width: 32 }}>{b.id}</span>
          {range(manual[b.id] ?? 0, -25, 25, 1, v => setManual(m => ({ ...m, [b.id]: v })))}
          <span style={{ fontSize: 9, fontFamily: T.mono, color: T.muted, width: 34, textAlign: 'right' }}>
            {(manual[b.id] ?? 0) >= 0 ? '+' : ''}{manual[b.id] ?? 0}
          </span>
        </div>
      ))}

      {/* Manual hedge — trade the benchmark note yourself, like a real maker */}
      <div style={{ ...labelStyle, marginTop: 10 }}>Hedge — Trade {BENCH} Benchmark</div>
      {r && (() => {
        const need = -Math.round(r.netDV01 / r.benchDV01)   // bench units to flatten net DV01
        const flatten = need > 0 ? `BUY ${need}` : need < 0 ? `SELL ${Math.abs(need)}` : 'flat'
        return (
          <div style={{ fontSize: 9, fontFamily: T.mono, color: T.muted, marginBottom: 5 }}>
            Net DV01 {r.netDV01 >= 0 ? '+' : ''}{r.netDV01.toFixed(0)} $/bp ·
            to flatten: <span style={{ color: need === 0 ? T.green : T.gold }}>{flatten}</span>
          </div>
        )
      })()}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, fontFamily: T.sans }}>Trade Size</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="number" min={0} step={25} value={hedgeQty}
            onChange={e => setHedgeQty(Math.max(0, Math.round(+e.target.value) || 0))}
            aria-label="Hedge trade size in bonds"
            style={{ width: 64, background: T.bg, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: T.gold, fontFamily: T.mono, fontSize: 11, padding: '2px 5px', outline: 'none', textAlign: 'right' }} />
          <span style={{ fontSize: 9, color: T.muted, fontFamily: T.sans }}>×$1k</span>
        </div>
      </div>
      {range(hedgeQty, 0, 1000, 25, setHedgeQty)}
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.sans, margin: '1px 0 6px' }}>
        {fmtMoney(hedgeQty * FACE_UNIT)} face · {r ? fmtMoney(hedgeQty * r.benchDV01) : '-'}/bp DV01
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => onTradeHedge(hedgeQty)} style={btnStyle(T.green)}>BUY</button>
        <button onClick={() => onTradeHedge(-hedgeQty)} style={btnStyle(T.red)}>SELL</button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button onClick={() => setRunning(x => !x)} style={btnStyle(running ? T.text : T.green)}>{running ? 'PAUSE' : 'START'}</button>
        <button onClick={onReset} style={btnStyle(T.muted)}>RESET</button>
      </div>

      <div style={{ marginTop: 12, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
        <button onClick={() => setRulesOpen(o => !o)}
          style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                   background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: T.text }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: T.sans }}>How the Desk Works</span>
          <span style={{ fontSize: 9, color: T.muted }}>{rulesOpen ? '↑' : '↓'}</span>
        </button>
        {rulesOpen && (
          <div style={{ marginTop: 8, fontSize: 10, lineHeight: '15px', color: T.muted, fontFamily: T.sans }}>
            1. You stream a <span style={{ color: T.green }}>BID</span> and <span style={{ color: T.red }}>ASK</span> around each bond's theoretical price.<br />
            2. Clients trade against your quote — they BUY at your ask, SELL at your bid. You capture the half-spread as <span style={{ color: T.gold }}>edge</span>.<br />
            3. Every fill hands you inventory and rate risk. A long bond gains when yields fall and bleeds when they rise.<br />
            4. Watch Net DV01 (P&L per 1bp), then <span style={{ color: T.green }}>BUY</span> or <span style={{ color: T.red }}>SELL</span> the {BENCH} benchmark to offset it. Drive Net DV01 toward 0.<br />
            5. If Net DV01 blows past the limit, the desk flashes <span style={{ color: T.red }}>UNHEDGED RISK</span> — hedge before a rate move wipes out your spread.
            <div style={{ color: T.text, fontWeight: 700, letterSpacing: '0.1em', margin: '8px 0 4px' }}>THE TRADE-OFF</div>
            Wider spreads earn more per fill but scare flow away. Hedging removes parallel rate risk but leaves convexity and curve risk — a DV01-flat book still moves on large or non-parallel rate shifts. The maker gets paid the spread, not the bet.
          </div>
        )}
      </div>
    </div>
    </RailSection>
  )

  return (
    <PageWrapper title="Fixed Income MM Simulator">
      <SidebarLayout sidebarWidth={236} sidebarTitle="" sidebar={sidebar}>
        {!f || !r ? (
          <div style={{ padding: 24, fontFamily: T.mono, color: T.muted }}>Starting desk…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Status */}
            <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.14em', color: f.running ? T.green : T.muted }}>
              DESK STATUS: {f.running ? 'LIVE' : 'PAUSED'}
            </div>

            {/* Scoreboard — P&L split into spread (edge) vs directional (inventory mark) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {scoreCard('Net P&L', fmtMoney(r.netPnl), r.netPnl >= 0 ? T.green : T.red, 'directional + spread')}
              {scoreCard('Directional P&L', fmtMoney(r.netPnl - f.edge), (r.netPnl - f.edge) >= 0 ? T.green : T.red, 'rate move on inventory')}
              {scoreCard('Spread P&L', fmtMoney(f.edge), T.green, 'edge captured from fills')}
              {scoreCard('10Y Yield', `${f.tenY.toFixed(2)}%`, T.text, 'benchmark level')}
              {scoreCard('Hedge Inventory', `${f.hedge >= 0 ? '+' : ''}${f.hedge.toLocaleString()}`, T.text, `${BENCH} units (hedge)`)}
              {scoreCard('Net DV01', `${r.netDV01 >= 0 ? '+' : ''}${fmtMoney(r.netDV01)}`, overLimit ? T.red : T.gold, `$/bp | limit ${DV01_LIMIT}`)}
              {scoreCard('Net Convexity', `${r.convexity >= 0 ? '+' : ''}${fmtMoney(r.convexity)}`, T.text, 'P&L per 100bp curve')}
              {scoreCard('Gross Notional', fmtMoney(r.grossNotional), T.text, 'face warehoused')}
            </div>

            {/* Risk status — fixed height so it never reflows the page */}
            <div style={{
              fontFamily: T.mono, fontSize: 13, fontWeight: overLimit ? 700 : 400, letterSpacing: '0.08em',
              textAlign: 'center', padding: '8px 12px', minHeight: 35, boxSizing: 'border-box',
              color: overLimit ? T.red : T.muted,
              border: `1px solid ${overLimit ? T.red : T.border}`,
              background: overLimit ? 'color-mix(in srgb, var(--theme-negative, #ef4444) 10%, transparent)' : 'transparent',
            }}>
              {overLimit
                ? `Unhedged Rate Risk - Net ${r.netDV01 > 0 ? 'Long' : 'Short'} ${fmtMoney(Math.abs(r.netDV01))}/bp - Hedge your DV01`
                : `Net DV01 ${r.netDV01 >= 0 ? '+' : ''}${fmtMoney(r.netDV01)} / ${fmtMoney(DV01_LIMIT)} per bp - within limits`}
            </div>

            {/* Last client order — fixed height; highlights when fresh, dims when stale */}
            <div style={{
              fontFamily: T.mono, fontSize: 12, fontWeight: 700, padding: '8px 12px', minHeight: 33, boxSizing: 'border-box',
              color: showAlert ? T.gold : T.muted,
              border: `1px solid ${showAlert ? T.gold : T.border}`,
              background: showAlert ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)' : 'transparent',
            }}>
              {f.lastOrder
                ? `CLIENT ORDER → ${f.lastOrder.clientSide} ${f.lastOrder.size} ${f.lastOrder.bond} @ ${f.lastOrder.fillPrice.toFixed(3)} (${f.lastOrder.clientSide === 'BUY' ? 'lifted your offer' : 'hit your bid'})   edge ${fmtMoney(f.lastOrder.edge)}`
                : 'Awaiting client flow…'}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {/* Book + tape */}
              <div style={{ flex: '1 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ background: T.bg, border: `1px solid ${T.border}` }}>
                  <div style={panelHeader}>TREASURY BOOK — YOUR LIVE QUOTES</div>
                  {renderBook(f)}
                </div>
                <div style={{ background: T.bg, border: `1px solid ${T.border}` }}>
                  <div style={panelHeader}>10Y YIELD TAPE</div>
                  <div style={{ height: 180, padding: '6px 4px 4px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={f.yldHistory.map((y, i) => ({ i, y: +y.toFixed(3) }))} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                        <XAxis dataKey="i" hide />
                        <YAxis tick={{ fontSize: 9, fill: T.muted, fontFamily: T.mono }} orientation="right" domain={['auto', 'auto']} tickFormatter={v => `${(+v).toFixed(2)}%`} width={46} />
                        <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 0, fontFamily: T.mono, fontSize: 11 }}
                          formatter={(v: number) => [`${(+v).toFixed(3)}%`, '10Y']} labelFormatter={() => ''} />
                        <ReferenceLine y={CURVE0[BENCH]} stroke="color-mix(in srgb, var(--theme-primary) 25%, transparent)" strokeDasharray="3 4" />
                        <Line type="monotone" dataKey="y" stroke={T.gold} strokeWidth={2} dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>

              {/* Ledger */}
              <div style={{ flex: '1 1 320px', minWidth: 0, background: T.bg, border: `1px solid ${T.border}` }}>
                <div style={panelHeader}>TRADE LEDGER</div>
                {renderLedger(f)}
              </div>
            </div>
          </div>
        )}
      </SidebarLayout>
    </PageWrapper>
  )
}

// ── UI helpers ────────────────────────────────────────────────────────────────
const panelHeader: React.CSSProperties = {
  padding: '5px 10px', fontFamily: 'var(--theme-sans)', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--theme-text, #d7e3fc)',
  background: 'var(--theme-surface, #0d1826)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.08))',
}

function btnStyle(color: string): React.CSSProperties {
  return {
    width: '100%', padding: '7px 8px', fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700,
    letterSpacing: '0.1em', cursor: 'pointer', color, background: 'transparent',
    border: `1px solid ${color}`, textTransform: 'uppercase',
  }
}

function scoreCard(label: string, value: string, color: string, sub: string) {
  return (
    <div key={label} style={{ background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', padding: '8px 10px' }}>
      <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 19, fontWeight: 700, color, lineHeight: 1.2, marginTop: 2 }}>{value}</div>
      <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 8, color: 'var(--theme-secondary, #5e768f)' }}>{sub}</div>
    </div>
  )
}

function renderBook(f: Frame) {
  const th: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', padding: '6px 8px', textAlign: 'right' }
  const td: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 12, padding: '5px 8px', textAlign: 'right', color: 'var(--theme-text, #d7e3fc)' }
  const posCell = (pos: number) => pos === 0
    ? <span style={{ color: 'var(--theme-secondary, #5e768f)' }}>0</span>
    : <span style={{ color: pos > 0 ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)', fontWeight: 700 }}>{pos > 0 ? '+' : ''}{pos}</span>
  const G = 'var(--theme-positive, #22c55e)', R = 'var(--theme-negative, #ef4444)', M = 'var(--theme-secondary, #5e768f)', GD = 'var(--theme-primary, #c9a84c)'

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
            <th style={{ ...th, textAlign: 'left', color: GD }}>BOND</th>
            <th style={th}>Coupon</th><th style={th}>Yield</th>
            <th style={{ ...th, color: G }}>Bid</th><th style={th}>Theo</th><th style={{ ...th, color: R }}>Ask</th>
            <th style={th}>DV01</th><th style={th}>Mod Dur</th>
            <th style={th}>Position</th>
          </tr>
        </thead>
        <tbody>
          {BONDS.map(b => {
            const q = f.book[b.id]
            const pos = f.positions[b.id]
            const isBench = b.id === BENCH
            return (
              <tr key={b.id} style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.04))', background: isBench ? 'color-mix(in srgb, var(--theme-primary) 5%, transparent)' : 'transparent' }}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 700, color: GD }}>
                  {b.id}{isBench && <span style={{ fontSize: 8, color: M, marginLeft: 4 }}>HEDGE</span>}
                </td>
                <td style={{ ...td, color: M }}>{b.coupon.toFixed(2)}%</td>
                <td style={td}>{q.yieldPct.toFixed(2)}%</td>
                <td style={{ ...td, color: G }}>{q.bid.toFixed(3)}</td>
                <td style={{ ...td, color: M }}>{q.price.toFixed(3)}</td>
                <td style={{ ...td, color: R }}>{q.ask.toFixed(3)}</td>
                <td style={td}>${q.dv01.toFixed(2)}</td>
                <td style={{ ...td, color: M }}>{q.modDur.toFixed(2)}</td>
                <td style={td}>{posCell(pos)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function renderLedger(f: Frame) {
  const th: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', padding: '5px 8px', textAlign: 'left' }
  const td: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 11, padding: '4px 8px', color: 'var(--theme-text, #d7e3fc)' }
  if (f.ledger.length === 0) {
    return <div style={{ padding: 14, fontFamily: 'var(--theme-mono)', fontSize: 11, color: 'var(--theme-secondary, #5e768f)' }}>No fills yet. Quotes are live — client orders arrive every few seconds.</div>
  }
  return (
    <div style={{ overflowY: 'auto', maxHeight: 420 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
            {['Time', 'Action', 'Bond', 'Size', 'Fill', 'Edge'].map(h => <th key={h} style={th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...f.ledger].reverse().map((t, i) => {
            const isHedge = t.clientSide.includes('BENCH')
            const actionColor = isHedge
              ? 'var(--theme-primary, #c9a84c)'
              : t.clientSide === 'BUY' ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'
            return (
              <tr key={i} style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.04))' }}>
                <td style={{ ...td, color: 'var(--theme-secondary, #5e768f)' }}>{t.tLabel}</td>
                <td style={{ ...td, color: actionColor }}>{t.clientSide}</td>
                <td style={td}>{t.bond}</td>
                <td style={td}>{t.size}</td>
                <td style={td}>{t.fillPrice.toFixed(3)}</td>
                <td style={{ ...td, color: t.edge ? 'var(--theme-positive, #22c55e)' : 'var(--theme-secondary, #5e768f)' }}>{t.edge ? fmtMoney(t.edge) : '-'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
