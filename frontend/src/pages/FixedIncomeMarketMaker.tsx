import { useEffect, useRef, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { Widget, HeaderBar, KpiCell, RiskMeterStrip, QuoteCell, Stepper, Chips, Segmented, WidenControl } from '../components/mmCockpit'

/*
 * Fixed Income MM Simulator
 * -------------------------
 * The rates-desk analog of the Options MM Simulator. You stream two-sided quotes
 * on a strip of Treasuries, earn the bid-ask spread on client flow, take on
 * inventory measured per-maturity in DV01 (key-rate dollar duration), and hedge
 * each bucket with its own note. The curve moves on two factors — a parallel
 * level and a slope/twist — so a net-DV01-flat book still carries curve risk
 * unless every maturity bucket is hedged. Fully client side; no backend.
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
const CURVE0: Record<string, number> = { '2Y': 3.9, '5Y': 4.0, '10Y': 4.2, '30Y': 4.5 }  // starting yields (%)
const FACE_UNIT       = 1000             // one "bond" = $1,000 face
const DOLLARS_PER_PT  = FACE_UNIT / 100  // $10 P&L per 1.00 price point, per unit
const ORDER_MIN_TICKS = 3
const ORDER_MAX_TICKS = 5
const ORDER_SIZES     = [10, 25, 50, 100, 250]   // units of $1k face
const DV01_LIMIT      = 250              // |net DV01| ($/bp) above this flags risk
const BUCKET_LIMIT    = 120              // |per-maturity DV01| ($/bp) above this flags risk
const MEAN_REVERT     = 0.02             // gentle pull of the curve factors back toward start
// How volatile rates are is a property of the market, not a trader dial, so the
// curve's vol is intrinsic to the model. RATE_VOL_BP is the parallel level move
// per tick; the curve also twists, with the slope factor at a fixed fraction of
// it (level moves dominate curve variance, slope is the second factor).
const RATE_VOL_BP     = 3
const CURVE_TWIST     = 0.45
// Flow responds to your marks, like a real desk. Richening a bond (marking its
// yield below fair) pulls in sellers; cheapening it (yield above fair) pulls in
// buyers; and a wider half-spread wins less flow overall.
const FLOW_SIDE_SENS  = 0.10           // per bp of yield mark vs fair: tilts BUY/SELL
const FLOW_PICK_SENS  = 0.04           // per bp: how much a mispriced bond pulls extra flow
const SPREAD_FLOW_SENS = 3             // per price point of half-spread: clients balk at wide quotes
const SPEED_MIN       = 0.1
const SPEED_MAX       = 3.0

// Slope sensitivity: long maturities move up, short maturities down, as the curve
// steepens — the curve pivots around the 10Y.
const slopeKey = (maturity: number) => (maturity - 10) / 10

const randIntInclusive = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1))
const normal = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-12)) * Math.cos(2 * Math.PI * Math.random())

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
  level: number; slope: number          // two curve factors: parallel shift + twist (%)
  cash: number
  positions: Record<string, number>     // client-driven inventory, per bond
  sold: Record<string, number>          // cumulative quantity sold to clients, per bond
  hedge: Record<string, number>         // your hedges, per bond (matched-maturity notes)
  edgeTotal: number; ledger: Fill[]
  tick: number; nextOrderTick: number
  yldHistory: Record<string, number[]>  // yield level per bond, for the tape
}

function freshState(): SimState {
  const positions: Record<string, number> = {}
  const sold: Record<string, number> = {}
  const hedge: Record<string, number> = {}
  const yldHistory: Record<string, number[]> = {}
  for (const b of BONDS) { positions[b.id] = 0; sold[b.id] = 0; hedge[b.id] = 0; yldHistory[b.id] = [CURVE0[b.id]] }
  return {
    level: 0, slope: 0, cash: 0, positions, sold, hedge, edgeTotal: 0, ledger: [],
    tick: 0, nextOrderTick: randIntInclusive(ORDER_MIN_TICKS, ORDER_MAX_TICKS),
    yldHistory,
  }
}

interface Ctrl { halfSpread: number; manual: Record<string, number>; bidAdj: Record<string, number>; askAdj: Record<string, number>; bondWiden: Record<string, number>; running: boolean; speed: number }

// Yield for a bond: starting curve + parallel level + slope twist + manual nudge.
function bondYield(id: string, maturity: number, s: SimState, c: Ctrl): number {
  const manual = (c.manual[id] ?? 0) / 100
  return Math.max(0.01, CURVE0[id] + s.level + s.slope * slopeKey(maturity) + manual)
}

// The market's fair yield (level + twist, without your manual lean) — the value
// your quotes are judged against for flow direction and mark-to-market P&L.
function fairYield(id: string, maturity: number, s: SimState): number {
  return Math.max(0.01, CURVE0[id] + s.level + s.slope * slopeKey(maturity))
}
const fairMath = (b: BondDef, s: SimState) => bondMath(b.coupon, b.maturity, fairYield(b.id, b.maturity, s))

function advanceCurve(s: SimState, c: Ctrl): void {
  // Two mean-reverting factors: a parallel level move and an independent slope
  // twist. With twist > 0 the curve moves non-parallel, so net DV01 alone does
  // not capture the risk — each maturity bucket must be hedged.
  s.level = s.level * (1 - MEAN_REVERT) + (RATE_VOL_BP / 100) * normal()
  s.slope = s.slope * (1 - MEAN_REVERT) + (RATE_VOL_BP / 100) * CURVE_TWIST * normal()
  for (const b of BONDS) {
    const h = s.yldHistory[b.id]
    h.push(bondYield(b.id, b.maturity, s, c))
    if (h.length > 120) s.yldHistory[b.id] = h.slice(-120)
  }
}

interface Quote { id: string; maturity: number; coupon: number; yieldPct: number; price: number; modDur: number; convexity: number; dv01: number; bid: number; ask: number }
type Book = Record<string, Quote>

function buildBook(s: SimState, c: Ctrl): Book {
  const book: Book = {}
  for (const b of BONDS) {
    const yld = bondYield(b.id, b.maturity, s, c)
    const m   = bondMath(b.coupon, b.maturity, yld)
    // Bid and ask are quoted independently off the mid (model price): each side's
    // distance = global half-spread + that side's own edit + this bond's widen.
    // Lets you skew a bond's market and widen it without the sides moving in step.
    const w = c.bondWiden[b.id] ?? 0
    const bidHs = Math.max(c.halfSpread + (c.bidAdj[b.id] ?? 0) + w, 0.001)
    const askHs = Math.max(c.halfSpread + (c.askAdj[b.id] ?? 0) + w, 0.001)
    book[b.id] = {
      id: b.id, maturity: b.maturity, coupon: b.coupon, yieldPct: yld,
      price: m.price, modDur: m.modDur, convexity: m.convexity, dv01: perUnitDV01(m),
      bid: m.price - bidHs, ask: m.price + askHs,
    }
  }
  return book
}

function maybeGenerateOrder(s: SimState, book: Book, running: boolean): void {
  if (!running || s.tick < s.nextOrderTick) return

  // yldEdge (bp) = your quoted yield minus fair. Positive means you mark the
  // bond at a higher yield (cheaper price) than the market — that pulls buyers.
  const yldEdge: Record<string, number> = {}
  for (const b of BONDS) yldEdge[b.id] = (book[b.id].yieldPct - fairYield(b.id, b.maturity, s)) * 100

  // A mispriced bond attracts more interest — weight selection by |yldEdge|.
  const weights = BONDS.map(b => 1 + Math.abs(yldEdge[b.id]) * FLOW_PICK_SENS)
  const totalW = weights.reduce((a, w) => a + w, 0)
  let roll = Math.random() * totalW, idx = 0
  while (idx < BONDS.length - 1 && (roll -= weights[idx]) > 0) idx++
  const b = BONDS[idx]
  const q = book[b.id]

  // Half-spread gates volume: a wider quote balks more clients, no print.
  if (Math.random() > Math.exp(-(q.ask - q.price) * SPREAD_FLOW_SENS)) {
    s.nextOrderTick = s.tick + randIntInclusive(ORDER_MIN_TICKS, ORDER_MAX_TICKS)
    return
  }

  // Side tilts with the mark: cheap (yldEdge > 0) -> they BUY (lift offer);
  // rich (yldEdge < 0) -> they SELL (hit bid).
  const pBuy = 1 / (1 + Math.exp(-yldEdge[b.id] * FLOW_SIDE_SENS))
  const clientSide = Math.random() < pBuy ? 'BUY' : 'SELL'
  const size = ORDER_SIZES[(Math.random() * ORDER_SIZES.length) | 0]

  // Edge is realized against fair value — sell a bond you marked cheap and you
  // book a loss the instant it trades.
  const fairPrice = fairMath(b, s).price
  let fill: number, edge: number
  if (clientSide === 'BUY') {
    // Client lifts the offer, so you sell: track the cumulative quantity sold.
    fill = q.ask; edge = (fill - fairPrice) * size * DOLLARS_PER_PT
    s.positions[b.id] -= size; s.sold[b.id] += size; s.cash += fill * size * DOLLARS_PER_PT
  } else {
    fill = q.bid; edge = (fairPrice - fill) * size * DOLLARS_PER_PT
    s.positions[b.id] += size; s.cash -= fill * size * DOLLARS_PER_PT
  }
  s.edgeTotal += edge
  const rec: Fill = { tLabel: new Date().toLocaleTimeString('en-US', { hour12: false }), clientSide, bond: b.id, size, fillPrice: fill, edge }
  s.ledger.push(rec)
  s.nextOrderTick = s.tick + randIntInclusive(ORDER_MIN_TICKS, ORDER_MAX_TICKS)
}

interface Risk {
  buckets: Record<string, number>        // net DV01 per maturity ($/bp, long-positive)
  netDV01: number; curveDV01: number; convexity: number; grossNotional: number; netPnl: number
  worstId: string; worstDV01: number
}
function portfolioRisk(s: SimState): Risk {
  // Risk and P&L are marked at the market (fair) surface, not your own quotes,
  // so leaning a bond's yield doesn't fake your book — it shows up as edge.
  const buckets: Record<string, number> = {}
  let netDV01 = 0, curveDV01 = 0, convexity = 0, grossNotional = 0, value = 0
  for (const b of BONDS) {
    const fm = fairMath(b, s)
    const net = (s.positions[b.id] || 0) + (s.hedge[b.id] || 0)   // client inventory + your hedge
    const dv01 = net * perUnitDV01(fm)
    buckets[b.id]  = dv01
    netDV01       += dv01
    curveDV01     += dv01 * slopeKey(b.maturity)                  // exposure to a 1bp steepening
    const mv = net * fm.price * DOLLARS_PER_PT
    convexity     += 0.5 * fm.convexity * mv * 0.01 * 0.01        // P&L from curvature on a 100bp move
    grossNotional += Math.abs(net) * FACE_UNIT
    value         += mv
  }
  let worstId = BONDS[0].id, worstDV01 = 0
  for (const b of BONDS) if (Math.abs(buckets[b.id]) > Math.abs(worstDV01)) { worstDV01 = buckets[b.id]; worstId = b.id }
  return { buckets, netDV01, curveDV01, convexity, grossNotional, netPnl: s.cash + value, worstId, worstDV01 }
}

function tradeHedge(s: SimState, id: string, qty: number): void {
  // Manual rate hedge: buy (qty > 0) / sell (qty < 0) the matched-maturity note
  // at the market (fair) price. Long the note adds positive DV01 (gains as
  // yields fall), offsetting a short bucket. Hedging only the net leaves the
  // other buckets exposed to a twist.
  if (!qty) return
  const def = BONDS.find(x => x.id === id)!
  const px = fairMath(def, s).price
  s.cash -= qty * px * DOLLARS_PER_PT
  s.hedge[id] = (s.hedge[id] || 0) + qty
  s.ledger.push({
    tLabel: new Date().toLocaleTimeString('en-US', { hour12: false }),
    clientSide: qty > 0 ? 'HEDGE BUY' : 'HEDGE SELL', bond: id,
    size: Math.abs(qty), fillPrice: px, edge: 0,
  })
}

function fmtMoney(x: number): string {
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Frame {
  book: Book; risk: Risk; yldHistory: Record<string, number[]>
  positions: Record<string, number>; sold: Record<string, number>; hedge: Record<string, number>; edge: number
  ledger: Fill[]; running: boolean
}

export default function FixedIncomeMarketMaker() {
  const sim = useRef<SimState>(freshState())
  const [halfSpread, setHalfSpread] = useState(0.06)
  const [manual, setManual]         = useState<Record<string, number>>(() => Object.fromEntries(BONDS.map(b => [b.id, 0])))
  const zeroBondAdj = () => Object.fromEntries(BONDS.map(b => [b.id, 0]))
  const [bidAdj, setBidAdj]         = useState<Record<string, number>>(zeroBondAdj)
  const [askAdj, setAskAdj]         = useState<Record<string, number>>(zeroBondAdj)
  const [bondWiden, setBondWiden]   = useState<Record<string, number>>(zeroBondAdj)
  const [running, setRunning]       = useState(false)
  const [speed, setSpeed]           = useState(0.5)
  const [hedgeQty, setHedgeQty]     = useState(50)
  const [selected, setSelected]     = useState('10Y')   // bond driving the tape + hedge panel
  const [frame, setFrame]           = useState<Frame | null>(null)
  const [flash, setFlash]           = useState<{ bond: string; side: string } | null>(null)
  const lastFillSig = useRef('')
  const flashTimer = useRef<ReturnType<typeof setTimeout>>()

  // Flash the bond row green/red when a new client order prints there.
  useEffect(() => {
    const lg = frame?.ledger
    if (!lg || !lg.length) return
    const last = lg[lg.length - 1]
    const sig = `${last.tLabel}|${last.bond}|${last.size}`
    if (sig === lastFillSig.current) return
    lastFillSig.current = sig
    if (last.clientSide.includes('HEDGE')) return
    setFlash({ bond: last.bond, side: last.clientSide })
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 650)
  }, [frame])

  // Latest controls available to the (single, stable) game-loop.
  const ctrl = useRef<Ctrl>({ halfSpread, manual, bidAdj, askAdj, bondWiden, running, speed })
  ctrl.current = { halfSpread, manual, bidAdj, askAdj, bondWiden, running, speed }

  const snapshot = (s: SimState, c: Ctrl): Frame => {
    const book = buildBook(s, c)
    const yldHistory: Record<string, number[]> = {}
    for (const b of BONDS) yldHistory[b.id] = [...s.yldHistory[b.id]]
    return {
      book, risk: portfolioRisk(s), yldHistory,
      positions: { ...s.positions }, sold: { ...s.sold }, hedge: { ...s.hedge }, edge: s.edgeTotal,
      ledger: s.ledger.slice(-18), running: c.running,
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
    tradeHedge(s, selected, qty)
    setFrame(snapshot(s, ctrl.current))
  }
  const onReset = () => {
    sim.current = freshState()
    setFrame(snapshot(sim.current, ctrl.current))
  }

  const f = frame
  const r = f?.risk
  const overLimit = r ? (Math.abs(r.netDV01) > DV01_LIMIT || Math.abs(r.worstDV01) > BUCKET_LIMIT) : false
  const selQuote = f?.book[selected]

  // ── Sidebar: controls + rules ────────────────────────────────────────────
  const labelStyle: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, marginBottom: 3, fontFamily: T.sans }
  const sliderRow = (label: string, value: string, slider: React.ReactNode, ends?: [string, string]) => (
    <div style={{ marginBottom: 5 }}>
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

  const selBucket = r ? r.buckets[selected] : 0
  const selNetUnits = f ? (f.positions[selected] + f.hedge[selected]) : 0

  const hedgeNeed = -Math.round(selNetUnits)
  const flatten = hedgeNeed > 0 ? `BUY ${hedgeNeed}` : hedgeNeed < 0 ? `SELL ${Math.abs(hedgeNeed)}` : 'flat'
  const yHist = f ? f.yldHistory[selected] : []
  const yChgBp = yHist.length > 1 ? (yHist[yHist.length - 1] - yHist[0]) * 100 : 0
  const spread = f ? f.edge : 0
  const directional = f && r ? r.netPnl - f.edge : 0
  const dvFmt = (n: number) => `${n >= 0 ? '+' : ''}$${Math.round(n)}`

  // Editing a bid/ask requotes only that side off the bond's mid (model price);
  // the other side stays put, so you can quote a skewed market. The yield-nudge
  // sliders re-mark the bond (move the mid) separately.
  const onQuote = (id: string, side: 'bid' | 'ask', price: number) => {
    const q = f?.book[id]
    if (!q || q.price <= 0) return
    const dist = Math.max(0, side === 'bid' ? q.price - price : price - q.price)
    // Back out only this side's own layer; the base half-spread and bond widen
    // stay separate so they keep scaling this quote afterward.
    const adj = Math.min(5, dist - halfSpread - (bondWiden[id] ?? 0))
    if (side === 'bid') setBidAdj(m => ({ ...m, [id]: adj }))
    else setAskAdj(m => ({ ...m, [id]: adj }))
  }
  // Per-bond widen: steps this bond's own widen layer (in price points), leaving
  // each side's bid/ask edit intact so customized quotes stay put and widen too.
  const WIDEN_STEP = 0.01
  const onWiden = (id: string, dir: 1 | -1) => {
    setBondWiden(prev => {
      const next = Math.max(0, Math.min(2, +((prev[id] ?? 0) + dir * WIDEN_STEP).toFixed(4)))
      return { ...prev, [id]: next }
    })
  }
  // Repaint the book the moment a quote/widen edit lands so the bid/ask react at
  // once even while the sim is paused, instead of waiting for the next tick.
  useEffect(() => { setFrame(snapshot(sim.current, ctrl.current)) }, [bidAdj, askAdj, bondWiden]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PageWrapper>
      {!f || !r || !selQuote ? (
        <div style={{ padding: 24, fontFamily: T.mono, color: T.muted }}>Starting desk…</div>
      ) : (
        <div style={{ maxWidth: 1340, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <HeaderBar tool="Fixed Income MM Simulator" running={f.running} />

          {/* Unified top instrument strip: KPI cells + inline risk meter */}
          <div style={{ display: 'flex', alignItems: 'stretch', background: T.surface, border: `1px solid ${T.border}`, overflowX: 'auto' }}>
            <KpiCell label="Net P&L" value={fmtMoney(r.netPnl)} color={r.netPnl >= 0 ? T.green : T.red} valueSize={16} />
            <KpiCell label="Spread" value={fmtMoney(spread)} color={T.green} />
            <KpiCell label="Directional" value={fmtMoney(directional)} color={directional >= 0 ? T.green : T.red} />
            <KpiCell label="Curve DV01" value={dvFmt(r.curveDV01)} />
            <KpiCell label="Convexity" value={`${r.convexity >= 0 ? '+' : ''}${fmtMoney(r.convexity)}`} />
            <KpiCell label="Notional" value={fmtMoney(r.grossNotional)} />
            <KpiCell label="10Y" value={`${f.book['10Y'].yieldPct.toFixed(2)}%`} />
            <RiskMeterStrip label="DV01 Risk" value={r.netDV01} limit={DV01_LIMIT} unit="/bp" over={overLimit} fmt={dvFmt} />
          </div>

          {/* Middle row: slim Controls | tall Tape | Hedge */}
          <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr 230px', gap: 8, alignItems: 'stretch' }}>
            {/* MM Controls */}
            <Widget title="MM Controls" bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '10px 12px' }}>
              <div>
                {sliderRow('Sim Speed', `${speed.toFixed(1)}x`, range(speed, SPEED_MIN, SPEED_MAX, 0.1, setSpeed))}
                {sliderRow('Half-Spread', `${halfSpread.toFixed(2)} pts`, range(halfSpread, 0.01, 0.5, 0.01, setHalfSpread))}
              </div>
              <div>
                <div style={{ height: 1, background: T.border, margin: '2px 0 8px' }} />
                <div style={{ ...labelStyle, marginBottom: 6 }}>Per-bond yield nudge (bp)</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 12 }}>
                  {BONDS.map(b => <div key={b.id}>{sliderRow(b.id, `${(manual[b.id] ?? 0) >= 0 ? '+' : ''}${manual[b.id] ?? 0}`, range(manual[b.id] ?? 0, -25, 25, 1, v => setManual(m => ({ ...m, [b.id]: v }))))}</div>)}
                </div>
              </div>
            </Widget>

            {/* Tape */}
            <Widget title={`${selected} Yield Tape`}
              right={<span style={{ fontFamily: T.mono, fontSize: 12, color: yChgBp <= 0 ? T.green : T.red }}>{selQuote.yieldPct.toFixed(2)}% {yChgBp >= 0 ? '+' : ''}{yChgBp.toFixed(1)}bp</span>}
              bodyStyle={{ flex: 1, display: 'flex', minHeight: 0 }}>
              <div style={{ flex: 1, minHeight: 200, padding: '8px 6px 6px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={yHist.map((y, i) => ({ i, y: +y.toFixed(3) }))} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="i" hide />
                    <YAxis tick={{ fontSize: 9, fill: T.muted, fontFamily: T.mono }} orientation="right" domain={['auto', 'auto']} tickFormatter={v => `${(+v).toFixed(2)}%`} width={46} />
                    <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 0, fontFamily: T.mono, fontSize: 11 }}
                      formatter={(v: number) => [`${(+v).toFixed(3)}%`, selected]} labelFormatter={() => ''} />
                    <ReferenceLine y={CURVE0[selected]} stroke="color-mix(in srgb, var(--theme-primary) 25%, transparent)" strokeDasharray="3 4" />
                    <Line type="monotone" dataKey="y" stroke="var(--theme-tertiary, #60a5fa)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Widget>

            {/* Hedge */}
            <Widget title="Hedge" bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 12, gap: 10 }}>
              <Segmented options={BONDS.map(b => b.id)} value={selected} onChange={setSelected} />

              <div style={{ background: T.bg, border: `1px solid ${T.border}`, padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ ...labelStyle, marginBottom: 0 }}>{selected} Bucket DV01</span>
                  <span style={{ fontSize: 9, fontFamily: T.mono, color: Math.abs(selBucket) > BUCKET_LIMIT ? T.red : T.muted }}>{Math.abs(selBucket) > BUCKET_LIMIT ? 'over' : 'within'} {BUCKET_LIMIT}</span>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 24, fontWeight: 700, color: Math.abs(selBucket) > BUCKET_LIMIT ? T.red : T.text, margin: '3px 0 8px' }}>
                  {selBucket >= 0 ? '+' : ''}{selBucket.toFixed(0)}<span style={{ fontSize: 10, color: T.muted, marginLeft: 5 }}>$/bp</span>
                </div>
                <button onClick={() => onTradeHedge(hedgeNeed)} disabled={hedgeNeed === 0}
                  style={{ width: '100%', padding: '8px 0', fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', cursor: hedgeNeed === 0 ? 'default' : 'pointer', background: 'transparent', border: `1px solid ${hedgeNeed === 0 ? T.border : T.gold}`, color: hedgeNeed === 0 ? T.muted : T.gold, opacity: hedgeNeed === 0 ? 0.6 : 1, textTransform: 'uppercase' }}>
                  Flatten · {flatten}
                </button>
              </div>

              <div>
                <div style={{ ...labelStyle, marginBottom: 6 }}>Trade Size (×$1k)</div>
                <Stepper value={hedgeQty} step={25} unit="×$1k" onChange={v => setHedgeQty(Math.max(0, v))} />
                <div style={{ marginTop: 8 }}>
                  <Chips options={[{ label: '25', value: 25 }, { label: '50', value: 50 }, { label: '100', value: 100 }, { label: '250', value: 250 }]} value={hedgeQty} onPick={setHedgeQty} />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => onTradeHedge(hedgeQty)} style={bigBtn(T.green)}>BUY {selected}</button>
                <button onClick={() => onTradeHedge(-hedgeQty)} style={bigBtn(T.red)}>SELL {selected}</button>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setRunning(x => !x)} style={btnStyle(running ? T.text : T.green)}>{running ? 'PAUSE' : 'START'}</button>
                <button onClick={onReset} style={btnStyle(T.muted)}>RESET</button>
              </div>
            </Widget>
          </div>

          {/* Treasury book: wide table with editable quotes */}
          <Widget title="Treasury Book" right={<span style={{ fontFamily: T.sans, fontSize: 8, color: T.muted, letterSpacing: '0.04em' }}>edit any bid / ask to requote · click a row to select</span>}>
            {renderBookTable(f, selected, setSelected, onQuote, flash, bondWiden, onWiden)}
          </Widget>

          {/* Ledger strip */}
          {renderLedgerStrip(f)}
        </div>
      )}
    </PageWrapper>
  )
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function btnStyle(color: string): React.CSSProperties {
  return {
    width: '100%', padding: '7px 8px', fontFamily: 'var(--theme-mono)', fontSize: 10, fontWeight: 700,
    letterSpacing: '0.1em', cursor: 'pointer', color, background: 'transparent',
    border: `1px solid ${color}`, textTransform: 'uppercase',
  }
}

function bigBtn(color: string): React.CSSProperties {
  return {
    flex: 1, padding: '12px 0', fontFamily: 'var(--theme-mono)', fontSize: 13, fontWeight: 700,
    letterSpacing: '0.1em', cursor: 'pointer', color, textTransform: 'uppercase',
    background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid ${color}`,
  }
}

// Treasury book as a compact wide table. Bid/Ask are editable quote cells; the
// row is clickable to drive the tape + hedge panel.
const fmtWidenPts = (v: number) => (v > 1e-4 ? `+${v.toFixed(2)}` : '0.00')

function renderBookTable(f: Frame, selected: string, onSelect: (id: string) => void, onQuote: (id: string, side: 'bid' | 'ask', price: number) => void, flash: { bond: string; side: string } | null, bondWiden: Record<string, number>, onWiden: (id: string, dir: 1 | -1) => void) {
  const G = 'var(--theme-positive, #22c55e)', R = 'var(--theme-negative, #ef4444)', M = 'var(--theme-secondary, #5e768f)', GD = 'var(--theme-primary, #c9a84c)', T2 = 'var(--theme-text, #d7e3fc)'
  const th: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: M, padding: '6px 12px', textAlign: 'right', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 13, padding: '5px 12px', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }
  const signed = (v: number, fmt: (n: number) => string) => v === 0
    ? <span style={{ color: M }}>{fmt(0)}</span>
    : <span style={{ color: v > 0 ? G : R, fontWeight: 700 }}>{v > 0 ? '+' : ''}{fmt(v)}</span>
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: `1px solid var(--theme-border, rgba(255,255,255,0.06))` }}>
            <th style={{ ...th, textAlign: 'left' }}>Bond</th>
            <th style={th}>Yield</th><th style={th}>Bid</th><th style={th}>Theo</th><th style={th}>Ask</th>
            <th style={th}>Pos</th><th style={th}>Sold</th><th style={th}>Hedge</th><th style={th}>Bucket DV01</th>
          </tr>
        </thead>
        <tbody>
          {BONDS.map(b => {
            const q = f.book[b.id]
            const pos = f.positions[b.id], hedge = f.hedge[b.id], bucket = f.risk.buckets[b.id], sold = f.sold[b.id] || 0
            const isSel = b.id === selected
            return (
              <tr key={b.id} onClick={() => onSelect(b.id)}
                style={{ cursor: 'pointer', borderBottom: `1px solid var(--theme-border, rgba(255,255,255,0.04))`, transition: 'background 0.5s ease-out', background: flash?.bond === b.id ? `color-mix(in srgb, var(--theme-${flash.side === 'BUY' ? 'positive' : 'negative'}) 32%, transparent)` : isSel ? 'color-mix(in srgb, var(--theme-primary) 10%, transparent)' : 'transparent' }}>
                <td style={{ ...td, textAlign: 'left', fontSize: 15, fontWeight: 700, color: GD }}>
                  {b.id}{isSel && <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: M, marginLeft: 6 }}>TAPE</span>}
                </td>
                <td style={{ ...td, color: T2 }}>{q.yieldPct.toFixed(2)}%</td>
                <td style={td}><QuoteCell value={q.bid} side="bid" step={0.001} decimals={3} onCommit={v => onQuote(b.id, 'bid', v)} /></td>
                <td style={{ ...td, padding: '3px 12px' }}>
                  <div style={{ color: M }}>{q.price.toFixed(3)}</div>
                  <WidenControl value={bondWiden[b.id] ?? 0} onStep={dir => onWiden(b.id, dir)} format={fmtWidenPts} />
                </td>
                <td style={td}><QuoteCell value={q.ask} side="ask" step={0.001} decimals={3} onCommit={v => onQuote(b.id, 'ask', v)} /></td>
                <td style={td}>{signed(pos, n => `${n}`)}</td>
                <td style={{ ...td, color: sold > 0 ? R : M }}>{sold}</td>
                <td style={td}>{signed(hedge, n => `${n}`)}</td>
                <td style={td}>{signed(bucket, n => `$${Math.round(n)}`)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Ledger as a single thin strip: a gold tag cell then the latest fills inline.
function renderLedgerStrip(f: Frame) {
  const M = 'var(--theme-secondary, #5e768f)', GD = 'var(--theme-primary, #c9a84c)', T2 = 'var(--theme-text, #d7e3fc)'
  const last = [...f.ledger].slice(-3).reverse()
  const tag: React.CSSProperties = { display: 'flex', alignItems: 'center', padding: '0 14px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.08))', fontFamily: 'var(--theme-sans)', fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: GD, flexShrink: 0 }
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', background: 'var(--theme-surface, #0d1826)', border: '1px solid var(--theme-border, rgba(255,255,255,0.08))', overflowX: 'auto', minHeight: 38 }}>
      <div style={tag}>Ledger</div>
      {last.length === 0
        ? <div style={{ display: 'flex', alignItems: 'center', padding: '0 14px', fontFamily: 'var(--theme-mono)', fontSize: 12, color: M }}>No fills yet. Quotes are live. Client orders arrive every few seconds.</div>
        : last.map((t, i) => {
          const isHedge = t.clientSide.includes('HEDGE')
          const ac = isHedge ? GD : t.clientSide === 'BUY' ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.05))', fontFamily: 'var(--theme-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
              <span style={{ color: M }}>{t.tLabel}</span>
              <span style={{ color: ac, fontWeight: 700 }}>{t.clientSide}</span>
              <span style={{ color: T2 }}>{t.bond}</span>
              <span style={{ color: M }}>{t.size}</span>
              <span style={{ color: M }}>@</span>
              <span style={{ color: T2 }}>{t.fillPrice.toFixed(3)}</span>
              {t.edge ? <span style={{ color: 'var(--theme-positive, #22c55e)' }}>{fmtMoney(t.edge)}</span> : null}
            </div>
          )
        })}
    </div>
  )
}
