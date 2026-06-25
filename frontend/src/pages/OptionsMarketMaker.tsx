import { useEffect, useRef, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { Widget, HeaderBar, KpiCell, RiskMeterStrip, QuoteCell, Stepper, Chips } from '../components/mmCockpit'

/*
 * Options MM Simulator
 * --------------------
 * Teaches how a sell-side maker earns the bid-ask spread, takes on inventory and
 * Greeks from client flow, and delta-hedges away directional risk. Fully client
 * side: Black-Scholes in TypeScript, a 1-second game loop, no backend calls.
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
const SPOT_START     = 100
const STRIKES        = [90, 100, 110, 120]
const RISK_FREE      = 0.04
const TIME_TO_EXPIRY = 30 / 365        // fixed so Greeks stay stable for teaching
const MULT           = 100             // one contract = 100 shares
const SPOT_TICK_VOL  = 0.0018          // realized move per tick, separate from quoted IV
const ORDER_MIN_TICKS = 3              // client orders arrive every 3-5 ticks
const ORDER_MAX_TICKS = 5
const ORDER_SIZES    = [1, 2, 5, 10, 15, 20, 25]
const DELTA_LIMIT    = 200             // |net delta shares| above this flashes a warning
const SPEED_MIN      = 0.1             // ticks/sec multiplier; interval = 1000 / speed ms
const SPEED_MAX      = 3.0

// The "true" market vol surface your quotes are measured against. You don't set
// this — it's where the rest of the Street values the options. Quote a strike
// below it (cheap) and clients lift your offers; quote it above (rich) and they
// hit your bids. Mismarking shows up as adverse fills and a hit to fair-value P&L.
const MKT_BASE_IV    = 0.25
const MKT_SKEW       = 0.06
const FLOW_SIDE_SENS = 45              // how hard a vol mispricing tilts the BUY/SELL side
const FLOW_PICK_SENS = 10              // how much a mispriced strike pulls extra flow
const SPREAD_FLOW_SENS = 5             // wider quotes win less flow — clients balk at the price
const TAPE_COLORS    = ['#c9a84c', '#60a5fa', '#22c55e', '#ef4444', '#a78bfa', '#f97316']

const randIntInclusive = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1))

// ── Black-Scholes (pure TS; normCdf via Zelen-Severo, error < 8e-8) ─────────────
const NPDF_C = 0.3989422804014327
function normPdf(x: number): number { return NPDF_C * Math.exp(-0.5 * x * x) }
function normCdf(x: number): number {
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429, p = 0.2316419
  const t = 1 / (1 + p * Math.abs(x))
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))))
  const cdf = 1 - NPDF_C * Math.exp(-0.5 * x * x) * poly
  return x >= 0 ? cdf : 1 - cdf
}

interface Greeks { theo: number; delta: number; gamma: number; vega: number }

function priceOption(spot: number, strike: number, t: number, r: number, sigma: number, kind: 'C' | 'P'): Greeks {
  if (t <= 0 || sigma <= 0 || spot <= 0) {
    const intrinsic = kind === 'C' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0)
    const delta = kind === 'C' ? (spot > strike ? 1 : 0) : (spot < strike ? -1 : 0)
    return { theo: intrinsic, delta, gamma: 0, vega: 0 }
  }
  const sqrtT = Math.sqrt(t)
  const d1 = (Math.log(spot / strike) + (r + 0.5 * sigma * sigma) * t) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  const disc = Math.exp(-r * t)
  let theo: number, delta: number
  if (kind === 'C') {
    theo = spot * normCdf(d1) - strike * disc * normCdf(d2)
    delta = normCdf(d1)
  } else {
    theo = strike * disc * normCdf(-d2) - spot * normCdf(-d1)
    delta = normCdf(d1) - 1
  }
  const gamma = normPdf(d1) / (spot * sigma * sqrtT)
  const vega  = spot * normPdf(d1) * sqrtT      // per 1.00 (100%) change in IV
  return { theo, delta, gamma, vega }
}

function strikeIv(strike: number, baseIv: number, skew: number, manual: Record<number, number>): number {
  const atm = SPOT_START   // pivot the skew at the money, independent of strike count
  const tilt = skew * ((atm - strike) / atm)    // +skew => lower strike, higher IV (equity skew)
  return Math.max(0.02, baseIv + tilt + (manual[strike] ?? 0))
}

// The market's fair IV per strike — the surface your quotes are judged against.
function marketIv(strike: number): number {
  const atm = SPOT_START
  return Math.max(0.02, MKT_BASE_IV + MKT_SKEW * ((atm - strike) / atm))
}
// Fair value + true greeks of a contract at the market surface, for P&L and risk.
function marketLeg(spot: number, strike: number, kind: 'C' | 'P'): Greeks {
  return priceOption(spot, strike, TIME_TO_EXPIRY, RISK_FREE, marketIv(strike), kind)
}

// ── Simulation state ────────────────────────────────────────────────────────────
const ck = (kind: 'C' | 'P', strike: number) => `${kind}${strike}`

interface Leg { kind: 'C' | 'P'; strike: number; iv: number; theo: number; bid: number; ask: number; delta: number; gamma: number; vega: number }
type Chain = Record<string, Leg>

interface Fill { tLabel: string; clientSide: string; contract: string; size: number; fillPrice: number; edge: number }

interface SimState {
  spot: number; cash: number; stock: number
  positions: Record<string, number>
  sold: Record<string, number>          // cumulative contracts sold to clients, per contract
  edgeTotal: number; ledger: Fill[]
  tick: number; nextOrderTick: number
  spotHistory: number[]
}

function freshState(): SimState {
  const positions: Record<string, number> = {}
  const sold: Record<string, number> = {}
  for (const k of STRIKES) { positions[ck('C', k)] = 0; positions[ck('P', k)] = 0; sold[ck('C', k)] = 0; sold[ck('P', k)] = 0 }
  return {
    spot: SPOT_START, cash: 0, stock: 0, positions, sold, edgeTotal: 0, ledger: [],
    tick: 0, nextOrderTick: randIntInclusive(ORDER_MIN_TICKS, ORDER_MAX_TICKS),
    spotHistory: [SPOT_START],
  }
}

function advanceSpot(s: SimState): void {
  // One GBM step per tick (Box-Muller standard normal). Real-time pace is set by
  // the loop interval, which the Sim Speed slider controls.
  const z = Math.sqrt(-2 * Math.log(Math.random() || 1e-12)) * Math.cos(2 * Math.PI * Math.random())
  s.spot = Math.max(1, s.spot * Math.exp(-0.5 * SPOT_TICK_VOL ** 2 + SPOT_TICK_VOL * z))
  s.spotHistory.push(s.spot)
  if (s.spotHistory.length > 120) s.spotHistory = s.spotHistory.slice(-120)
}

function buildChain(s: SimState, baseIv: number, skew: number, halfSpread: number, manual: Record<number, number>, bidAdj: Record<string, number>, askAdj: Record<string, number>, strikeWiden: Record<number, number>): Chain {
  const chain: Chain = {}
  for (const kind of ['C', 'P'] as const) {
    for (const k of STRIKES) {
      const iv = strikeIv(k, baseIv, skew, manual)
      const q = priceOption(s.spot, k, TIME_TO_EXPIRY, RISK_FREE, iv, kind)
      // Bid and ask are quoted independently: each side's distance from theo =
      // global base + that side's own edit + this strike's widen. So you can skew
      // a quote (asymmetric spread, mid off theo) and widening keeps both edits.
      const key = ck(kind, k), w = strikeWiden[k] ?? 0
      const bidHs = Math.max(q.theo * (halfSpread + (bidAdj[key] ?? 0) + w), 0.03)
      const askHs = Math.max(q.theo * (halfSpread + (askAdj[key] ?? 0) + w), 0.03)
      chain[key] = {
        kind, strike: k, iv, theo: q.theo,
        bid: Math.max(0.01, q.theo - bidHs), ask: q.theo + askHs,
        delta: q.delta, gamma: q.gamma, vega: q.vega,
      }
    }
  }
  return chain
}

function maybeGenerateOrder(s: SimState, chain: Chain, running: boolean): void {
  if (!running || s.tick < s.nextOrderTick) return
  const keys = Object.keys(s.positions)

  // Flow follows mispricing. For each contract, ivEdge = your IV minus the
  // market's: negative means you're quoting it cheap, positive means rich.
  const ivEdge: Record<string, number> = {}
  for (const k of keys) ivEdge[k] = chain[k].iv - marketIv(chain[k].strike)

  // A mispriced strike attracts more interest (clients shop the cheapest offers
  // and the richest bids), so weight contract selection by |ivEdge|.
  const weights = keys.map(k => 1 + Math.abs(ivEdge[k]) * FLOW_PICK_SENS)
  const total = weights.reduce((a, b) => a + b, 0)
  let roll = Math.random() * total, idx = 0
  while (idx < keys.length - 1 && (roll -= weights[idx]) > 0) idx++
  const key = keys[idx]
  const leg = chain[key]

  // Spread sets how much flow you win: the wider you quote relative to value,
  // the more often the client balks and no trade prints this slot.
  const relSpread = leg.theo > 0 ? (leg.ask - leg.theo) / leg.theo : 0
  if (Math.random() > Math.exp(-relSpread * SPREAD_FLOW_SENS)) {
    s.nextOrderTick = s.tick + randIntInclusive(ORDER_MIN_TICKS, ORDER_MAX_TICKS)
    return
  }

  // Side tilts with the mispricing: quote cheap (ivEdge < 0) and they BUY (lift
  // your offer); quote rich (ivEdge > 0) and they SELL (hit your bid).
  const pBuy = 1 / (1 + Math.exp(ivEdge[key] * FLOW_SIDE_SENS))
  const clientSide = Math.random() < pBuy ? 'BUY' : 'SELL'
  const size = ORDER_SIZES[(Math.random() * ORDER_SIZES.length) | 0]

  // Edge is realized against fair value, not your own mark — so selling a
  // contract you marked below the market books a loss the moment it trades.
  const fair = marketLeg(s.spot, leg.strike, leg.kind).theo
  let fill: number, edge: number
  if (clientSide === 'BUY') {
    // Client lifts the offer, so you sell: track the cumulative contracts sold.
    fill = leg.ask; edge = (fill - fair) * size * MULT
    s.positions[key] -= size; s.sold[key] += size; s.cash += fill * size * MULT
  } else {
    fill = leg.bid; edge = (fair - fill) * size * MULT
    s.positions[key] += size; s.cash -= fill * size * MULT
  }
  s.edgeTotal += edge
  const rec: Fill = { tLabel: new Date().toLocaleTimeString('en-US', { hour12: false }), clientSide, contract: key, size, fillPrice: fill, edge }
  s.ledger.push(rec)
  s.nextOrderTick = s.tick + randIntInclusive(ORDER_MIN_TICKS, ORDER_MAX_TICKS)
}

interface Portfolio { optDeltaSh: number; totalDeltaSh: number; gamma: number; vega1pct: number; netPnl: number }
function portfolioGreeks(s: SimState, chain: Chain): Portfolio {
  // Risk and P&L are marked at the market surface (true value), not your own
  // quotes — otherwise mismarking would never show up as a loss.
  let optDeltaSh = 0, gamma = 0, vega1pct = 0, optValue = 0
  for (const key of Object.keys(s.positions)) {
    const pos = s.positions[key]
    if (!pos) continue
    const leg = chain[key]
    const m = marketLeg(s.spot, leg.strike, leg.kind)
    optDeltaSh += pos * m.delta * MULT
    gamma      += pos * m.gamma * MULT
    vega1pct   += pos * m.vega            // vega*100 shares *1% = vega
    optValue   += pos * m.theo * MULT
  }
  const totalDeltaSh = optDeltaSh + s.stock
  const netPnl = s.cash + optValue + s.stock * s.spot
  return { optDeltaSh, totalDeltaSh, gamma, vega1pct, netPnl }
}

function tradeStock(s: SimState, qty: number): void {
  // Manual hedge: buy (qty > 0) or sell (qty < 0) the underlying at the current
  // spot. Each share carries +1 / -1 delta, offsetting option inventory.
  if (!qty) return
  s.cash -= qty * s.spot
  s.stock += qty
  s.ledger.push({
    tLabel: new Date().toLocaleTimeString('en-US', { hour12: false }),
    clientSide: qty > 0 ? 'BUY STOCK' : 'SELL STOCK', contract: 'STOCK',
    size: Math.abs(qty), fillPrice: s.spot, edge: 0,
  })
}

function fmtMoney(x: number): string {
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
}

// ── Component ─────────────────────────────────────────────────────────────────
interface Frame {
  chain: Chain; greeks: Portfolio; spot: number; spotHistory: number[]
  positions: Record<string, number>; sold: Record<string, number>; stock: number; edge: number
  ledger: Fill[]; running: boolean
}

export default function OptionsMarketMaker() {
  const sim = useRef<SimState>(freshState())
  const [baseIv, setBaseIv]         = useState(0.25)
  const [skew, setSkew]             = useState(0.06)
  const [halfSpread, setHalfSpread] = useState(0.04)
  const [manual, setManual]         = useState<Record<number, number>>(() => Object.fromEntries(STRIKES.map(k => [k, 0])))
  // Bid and ask edits live in independent per-contract layers, so quoting one
  // side never moves the other (asymmetric / skewed markets).
  const zeroAdj = () => Object.fromEntries(STRIKES.flatMap(k => [[`C${k}`, 0], [`P${k}`, 0]]))
  const [bidAdj, setBidAdj]         = useState<Record<string, number>>(zeroAdj)
  const [askAdj, setAskAdj]         = useState<Record<string, number>>(zeroAdj)
  // Per-strike widen sits in its own layer so it composes with (rather than
  // overwrites) the per-contract bid/ask edits.
  const [strikeWiden, setStrikeWiden] = useState<Record<number, number>>(() => Object.fromEntries(STRIKES.map(k => [k, 0])))
  const [running, setRunning]       = useState(false)
  const [speed, setSpeed]           = useState(0.5)
  const [hedgeQty, setHedgeQty]     = useState(100)
  const [tapeSel, setTapeSel]       = useState<string[]>([])   // contracts overlaid on the tape
  const [frame, setFrame]           = useState<Frame | null>(null)
  const [flash, setFlash]           = useState<{ k: number; side: string } | null>(null)
  const lastFillSig = useRef('')
  const flashTimer = useRef<ReturnType<typeof setTimeout>>()

  const toggleTape = (key: string) =>
    setTapeSel(sel => sel.includes(key) ? sel.filter(k => k !== key) : [...sel, key])

  // Flash the strike row green/red when a new client order prints there.
  useEffect(() => {
    const lg = frame?.ledger
    if (!lg || !lg.length) return
    const last = lg[lg.length - 1]
    const sig = `${last.tLabel}|${last.contract}|${last.size}`
    if (sig === lastFillSig.current) return
    lastFillSig.current = sig
    if (last.contract === 'STOCK') return
    setFlash({ k: parseInt(last.contract.slice(1), 10), side: last.clientSide })
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 650)
  }, [frame])

  // Latest controls available to the (single, stable) game-loop.
  const ctrl = useRef({ baseIv, skew, halfSpread, manual, bidAdj, askAdj, strikeWiden, running, speed })
  ctrl.current = { baseIv, skew, halfSpread, manual, bidAdj, askAdj, strikeWiden, running, speed }

  const snapshot = (s: SimState, c: typeof ctrl.current): Frame => {
    const chain = buildChain(s, c.baseIv, c.skew, c.halfSpread, c.manual, c.bidAdj, c.askAdj, c.strikeWiden)
    return {
      chain, greeks: portfolioGreeks(s, chain), spot: s.spot, spotHistory: [...s.spotHistory],
      positions: { ...s.positions }, sold: { ...s.sold }, stock: s.stock, edge: s.edgeTotal,
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
        advanceSpot(s)
        maybeGenerateOrder(s, buildChain(s, c.baseIv, c.skew, c.halfSpread, c.manual, c.bidAdj, c.askAdj, c.strikeWiden), c.running)
      }
      setFrame(snapshot(s, c))
      timer = setTimeout(loop, Math.round(1000 / c.speed))
    }
    setFrame(snapshot(sim.current, ctrl.current))
    timer = setTimeout(loop, Math.round(1000 / ctrl.current.speed))
    return () => clearTimeout(timer)
  }, [])

  const onTradeStock = (qty: number) => {
    const s = sim.current
    tradeStock(s, qty)
    setFrame(snapshot(s, ctrl.current))
  }
  const onReset = () => {
    sim.current = freshState()
    setFrame(snapshot(sim.current, ctrl.current))
  }

  const f = frame
  const g = f?.greeks
  const overLimit = g ? Math.abs(g.totalDeltaSh) > DELTA_LIMIT : false

  // Tape series: with no selection it plots the underlying; selecting contracts
  // in the chain overlays each one's premium, repriced across the spot history
  // at the current quoted IV so you can watch your options move with the tape.
  const tapeOptions = tapeSel.length > 0
  const tapeData = (f ? f.spotHistory : []).map((spot, i) => {
    const row: Record<string, number> = { i }
    if (tapeOptions) {
      for (const key of tapeSel) {
        const kind = key[0] as 'C' | 'P'; const strike = +key.slice(1)
        row[key] = +priceOption(spot, strike, TIME_TO_EXPIRY, RISK_FREE, strikeIv(strike, baseIv, skew, manual), kind).theo.toFixed(3)
      }
    } else {
      row.spot = +spot.toFixed(2)
    }
    return row
  })

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

  const need = g ? -Math.round(g.totalDeltaSh) : 0
  const flatten = need > 0 ? `BUY ${need}` : need < 0 ? `SELL ${Math.abs(need)}` : 'flat'
  const spotChg = f && f.spotHistory.length > 1 ? (f.spot / f.spotHistory[0] - 1) * 100 : 0
  const spread = f ? f.edge : 0
  const directional = f && g ? g.netPnl - f.edge : 0

  // Editing a bid/ask requotes only that side of the contract; the other side
  // stays put, so you can quote a skewed (asymmetric) market. The base
  // half-spread and strike widen stay in their own layers and keep scaling it.
  const onQuote = (key: string, side: 'bid' | 'ask', price: number) => {
    const leg = f?.chain[key]
    if (!leg || leg.theo <= 0) return
    const k = parseInt(key.slice(1), 10)
    const hs = Math.max(0, side === 'bid' ? leg.theo - price : price - leg.theo)
    const adj = Math.max(-0.09, Math.min(0.5, hs / leg.theo - halfSpread - (strikeWiden[k] ?? 0)))
    if (side === 'bid') setBidAdj(m => ({ ...m, [key]: adj }))
    else setAskAdj(m => ({ ...m, [key]: adj }))
  }

  // Per-strike widen: steps this strike's own widen layer, leaving each leg's
  // bid/ask edit untouched so customized quotes stay intact and widen with it.
  const WIDEN_STEP = 0.01
  const onWiden = (k: number, dir: 1 | -1) => {
    setStrikeWiden(prev => {
      const next = Math.max(0, Math.min(0.5, +((prev[k] ?? 0) + dir * WIDEN_STEP).toFixed(4)))
      return { ...prev, [k]: next }
    })
  }
  // Repaint the chain the moment any spread override changes (widen stepper or a
  // bid/ask requote) so the bid/ask columns react at once even while paused,
  // instead of waiting for the next sim tick.
  useEffect(() => { setFrame(snapshot(sim.current, ctrl.current)) }, [bidAdj, askAdj, strikeWiden]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <PageWrapper>
      {!f || !g ? (
        <div style={{ padding: 24, fontFamily: T.mono, color: T.muted }}>Starting desk…</div>
      ) : (
        <div style={{ maxWidth: 1340, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <HeaderBar tool="Options MM Simulator" running={f.running} />

          {/* Unified top instrument strip: KPI cells + inline risk meter */}
          <div style={{ display: 'flex', alignItems: 'stretch', background: T.surface, border: `1px solid ${T.border}`, overflowX: 'auto' }}>
            <KpiCell label="Net P&L" value={fmtMoney(g.netPnl)} color={g.netPnl >= 0 ? T.green : T.red} valueSize={16} />
            <KpiCell label="Spread" value={fmtMoney(spread)} color={T.green} />
            <KpiCell label="Directional" value={fmtMoney(directional)} color={directional >= 0 ? T.green : T.red} />
            <KpiCell label="Net Gamma" value={`${g.gamma >= 0 ? '+' : ''}${g.gamma.toFixed(1)}`} />
            <KpiCell label="Net Vega" value={fmtMoney(g.vega1pct)} />
            <KpiCell label="Stock" value={`${f.stock >= 0 ? '+' : ''}${f.stock.toLocaleString()}`} />
            <KpiCell label="Spot" value={`$${f.spot.toFixed(2)} ${spotChg >= 0 ? '+' : ''}${spotChg.toFixed(2)}%`} color={spotChg >= 0 ? T.green : T.red} />
            <RiskMeterStrip label="Delta Risk" value={g.totalDeltaSh} limit={DELTA_LIMIT} unit="sh" over={overLimit} />
          </div>

          {/* Middle row: slim Controls | tall Tape | Hedge */}
          <div style={{ display: 'grid', gridTemplateColumns: '250px 1fr 230px', gap: 8, alignItems: 'stretch' }}>
            {/* MM Controls */}
            <Widget title="MM Controls" bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '10px 12px' }}>
              <div>
                {sliderRow('Sim Speed', `${speed.toFixed(1)}x`, range(speed, SPEED_MIN, SPEED_MAX, 0.1, setSpeed))}
                {sliderRow('Base IV', `${(baseIv * 100).toFixed(0)}%`, range(baseIv, 0.05, 0.80, 0.01, setBaseIv))}
                {sliderRow('IV Skew', skew.toFixed(2), range(skew, -0.20, 0.20, 0.01, setSkew))}
                {sliderRow('Half-Spread', `${(halfSpread * 100).toFixed(1)}%`, range(halfSpread, 0.005, 0.20, 0.005, setHalfSpread))}
              </div>
              <div>
                <div style={{ height: 1, background: T.border, margin: '2px 0 8px' }} />
                <div style={{ ...labelStyle, marginBottom: 6 }}>Per-strike IV nudge</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 12 }}>
                  {STRIKES.map(k => <div key={k}>{sliderRow(`${k}`, `${(manual[k] ?? 0) >= 0 ? '+' : ''}${((manual[k] ?? 0) * 100).toFixed(0)}`, range(manual[k] ?? 0, -0.15, 0.15, 0.01, v => setManual(m => ({ ...m, [k]: v }))))}</div>)}
                </div>
              </div>
            </Widget>

            {/* Tape */}
            <Widget title={tapeOptions ? 'Option Premiums' : 'Underlying Tape'}
              right={tapeOptions
                ? <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {tapeSel.map((k, idx) => <span key={k} style={{ fontFamily: T.mono, fontSize: 9, color: TAPE_COLORS[idx % TAPE_COLORS.length] }}>{k}</span>)}
                    <button onClick={() => setTapeSel([])} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, fontFamily: T.sans }}>clear</button>
                  </span>
                : <span style={{ fontFamily: T.mono, fontSize: 12, color: spotChg >= 0 ? T.green : T.red }}>${f.spot.toFixed(2)} {spotChg >= 0 ? '+' : ''}{spotChg.toFixed(2)}%</span>}
              bodyStyle={{ flex: 1, display: 'flex', minHeight: 0 }}>
              <div style={{ flex: 1, minHeight: 200, padding: '8px 6px 6px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={tapeData} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                    <XAxis dataKey="i" hide />
                    <YAxis tick={{ fontSize: 9, fill: T.muted, fontFamily: T.mono }} orientation="right" domain={['auto', 'auto']} tickFormatter={v => tapeOptions ? `$${(+v).toFixed(1)}` : `$${(+v).toFixed(0)}`} width={42} />
                    <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 0, fontFamily: T.mono, fontSize: 11 }}
                      formatter={(v: number, name: string) => [`$${(+v).toFixed(tapeOptions ? 3 : 2)}`, tapeOptions ? name : 'spot']} labelFormatter={() => ''} />
                    {tapeOptions
                      ? tapeSel.map((k, idx) => <Line key={k} type="monotone" dataKey={k} stroke={TAPE_COLORS[idx % TAPE_COLORS.length]} strokeWidth={2} dot={false} isAnimationActive={false} />)
                      : <>
                          {STRIKES.map(k => <ReferenceLine key={k} y={k} stroke="color-mix(in srgb, var(--theme-primary) 25%, transparent)" strokeDasharray="3 4" />)}
                          <Line type="monotone" dataKey="spot" stroke="var(--theme-tertiary, #60a5fa)" strokeWidth={2} dot={false} isAnimationActive={false} />
                        </>}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Widget>

            {/* Hedge */}
            <Widget title="Hedge" bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 12, gap: 10 }}>
              <div style={{ background: T.bg, border: `1px solid ${T.border}`, padding: '10px 12px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ ...labelStyle, marginBottom: 0 }}>Net Delta</span>
                  <span style={{ fontSize: 9, fontFamily: T.mono, color: overLimit ? T.red : T.muted }}>{overLimit ? 'over' : 'within'} {DELTA_LIMIT}</span>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 24, fontWeight: 700, color: overLimit ? T.red : T.text, margin: '3px 0 8px' }}>
                  {g.totalDeltaSh >= 0 ? '+' : ''}{g.totalDeltaSh.toFixed(0)}<span style={{ fontSize: 10, color: T.muted, marginLeft: 5 }}>sh</span>
                </div>
                <button onClick={() => onTradeStock(need)} disabled={need === 0}
                  style={{ width: '100%', padding: '8px 0', fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', cursor: need === 0 ? 'default' : 'pointer', background: 'transparent', border: `1px solid ${need === 0 ? T.border : T.gold}`, color: need === 0 ? T.muted : T.gold, opacity: need === 0 ? 0.6 : 1, textTransform: 'uppercase' }}>
                  Flatten · {flatten}
                </button>
              </div>

              <div>
                <div style={{ ...labelStyle, marginBottom: 6 }}>Trade Size (shares)</div>
                <Stepper value={hedgeQty} step={25} unit="sh" onChange={v => setHedgeQty(Math.max(0, v))} />
                <div style={{ marginTop: 8 }}>
                  <Chips options={[{ label: '100', value: 100 }, { label: '200', value: 200 }, { label: '500', value: 500 }, { label: '1k', value: 1000 }]} value={hedgeQty} onPick={setHedgeQty} />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => onTradeStock(hedgeQty)} style={bigBtn(T.green)}>BUY</button>
                <button onClick={() => onTradeStock(-hedgeQty)} style={bigBtn(T.red)}>SELL</button>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setRunning(rr => !rr)} style={btnStyle(running ? T.text : T.green)}>{running ? 'PAUSE' : 'START'}</button>
                <button onClick={onReset} style={btnStyle(T.muted)}>RESET</button>
              </div>
            </Widget>
          </div>

          {/* Options chain: wide table with editable quotes */}
          <Widget title="Options Chain" right={<span style={{ fontFamily: T.sans, fontSize: 8, color: T.muted, letterSpacing: '0.04em' }}>edit bid / ask to requote · click Theo to plot · click strike for underlying</span>}>
            {renderChainTable(f, tapeSel, toggleTape, onQuote, () => setTapeSel([]), flash, strikeWiden, onWiden)}
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

// Option chain as a compact wide table. Bid/Ask are editable quote cells; Theo
// is clickable to overlay that contract's premium on the tape.
// Compact per-strike spread-widen stepper, stacked under the strike. Adds to the
// base Half-Spread for that strike's call and put together. Buttons stop click
// propagation so they don't also plot the underlying on the tape.
function WidenControl({ value, onStep }: { value: number; onStep: (dir: 1 | -1) => void }) {
  const M = 'var(--theme-secondary, #5e768f)', GD = 'var(--theme-primary, #c9a84c)'
  const on = value > 0.0001
  const btn: React.CSSProperties = {
    width: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
    background: 'transparent', border: '1px solid var(--theme-border, rgba(255,255,255,0.14))',
    color: M, cursor: 'pointer', fontFamily: 'var(--theme-mono)', fontSize: 12, lineHeight: 1,
  }
  const step = (e: React.MouseEvent, dir: 1 | -1) => { e.stopPropagation(); onStep(dir) }
  return (
    <div title="Widen this strike's spread (adds to base half-spread)"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, marginTop: 3 }}>
      <button style={btn} onClick={e => step(e, -1)} aria-label="Tighten strike spread">-</button>
      <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, fontWeight: 700, color: on ? GD : M, minWidth: 30, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
        {on ? `+${(value * 100).toFixed(1)}%` : '0%'}
      </span>
      <button style={btn} onClick={e => step(e, 1)} aria-label="Widen strike spread">+</button>
    </div>
  )
}

function renderChainTable(f: Frame, tapeSel: string[], onToggle: (key: string) => void, onQuote: (key: string, side: 'bid' | 'ask', price: number) => void, onPlotUnderlying: () => void, flash: { k: number; side: string } | null, strikeWiden: Record<number, number>, onWiden: (k: number, dir: 1 | -1) => void) {
  const G = 'var(--theme-positive, #22c55e)', R = 'var(--theme-negative, #ef4444)', M = 'var(--theme-secondary, #5e768f)', GD = 'var(--theme-primary, #c9a84c)', B = 'var(--theme-tertiary, #60a5fa)'
  const th: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: M, padding: '6px 10px', textAlign: 'right', whiteSpace: 'nowrap' }
  const td: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 13, padding: '5px 10px', textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }
  const deltaCell = (key: string) => {
    const d = f.chain[key].delta
    return <span style={{ color: M }}>{d >= 0 ? '+' : ''}{d.toFixed(2)}</span>
  }
  const theoCell = (key: string) => {
    const i = tapeSel.indexOf(key); const on = i >= 0
    const col = on ? TAPE_COLORS[i % TAPE_COLORS.length] : B
    return <span onClick={() => onToggle(key)} title="Plot on tape" style={{ cursor: 'pointer', color: col, padding: '1px 4px', background: on ? `color-mix(in srgb, ${col} 16%, transparent)` : 'transparent' }}>{f.chain[key].theo.toFixed(2)}</span>
  }
  const posCell = (key: string) => {
    const p = f.positions[key]; const sold = f.sold[key] || 0
    return <span style={{ color: M }}><span style={{ color: p === 0 ? M : p > 0 ? G : R }}>{p > 0 ? '+' : ''}{p}</span>{sold > 0 ? ` · ${sold}s` : ''}</span>
  }
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: `1px solid var(--theme-border, rgba(255,255,255,0.06))` }}>
            <th style={{ ...th, textAlign: 'left' }}>Calls</th>
            <th style={th}>&#916;</th><th style={th}>Bid</th><th style={th}>Theo</th><th style={th}>Ask</th>
            <th style={{ ...th, textAlign: 'center', color: GD }}>Strike</th>
            <th style={th}>Bid</th><th style={th}>Theo</th><th style={th}>Ask</th><th style={th}>&#916;</th>
            <th style={{ ...th, textAlign: 'left' }}>Puts</th>
          </tr>
        </thead>
        <tbody>
          {STRIKES.map(k => {
            const cKey = `C${k}`, pKey = `P${k}`
            const atm = Math.abs(k - f.spot) <= 5
            return (
              <tr key={k} style={{ borderBottom: `1px solid var(--theme-border, rgba(255,255,255,0.04))`, transition: 'background 0.5s ease-out', background: flash?.k === k ? `color-mix(in srgb, var(--theme-${flash.side === 'BUY' ? 'positive' : 'negative'}) 32%, transparent)` : atm ? 'color-mix(in srgb, var(--theme-primary) 10%, transparent)' : 'transparent' }}>
                <td style={{ ...td, textAlign: 'left' }}>{posCell(cKey)}</td>
                <td style={td}>{deltaCell(cKey)}</td>
                <td style={td}><QuoteCell value={f.chain[cKey].bid} side="bid" step={0.01} decimals={2} onCommit={v => onQuote(cKey, 'bid', v)} /></td>
                <td style={td}>{theoCell(cKey)}</td>
                <td style={td}><QuoteCell value={f.chain[cKey].ask} side="ask" step={0.01} decimals={2} onCommit={v => onQuote(cKey, 'ask', v)} /></td>
                <td style={{ ...td, textAlign: 'center', padding: '3px 6px' }}>
                  <div onClick={onPlotUnderlying} title="Plot underlying on tape" style={{ fontSize: 16, fontWeight: 700, color: GD, cursor: 'pointer', lineHeight: 1 }}>{k}</div>
                  <WidenControl value={strikeWiden[k] ?? 0} onStep={dir => onWiden(k, dir)} />
                </td>
                <td style={td}><QuoteCell value={f.chain[pKey].bid} side="bid" step={0.01} decimals={2} onCommit={v => onQuote(pKey, 'bid', v)} /></td>
                <td style={td}>{theoCell(pKey)}</td>
                <td style={td}><QuoteCell value={f.chain[pKey].ask} side="ask" step={0.01} decimals={2} onCommit={v => onQuote(pKey, 'ask', v)} /></td>
                <td style={td}>{deltaCell(pKey)}</td>
                <td style={{ ...td, textAlign: 'left' }}>{posCell(pKey)}</td>
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
          const isStock = t.contract === 'STOCK'
          const ac = isStock ? GD : t.clientSide === 'BUY' ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRight: '1px solid var(--theme-border, rgba(255,255,255,0.05))', fontFamily: 'var(--theme-mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
              <span style={{ color: M }}>{t.tLabel}</span>
              <span style={{ color: ac, fontWeight: 700 }}>{t.clientSide}</span>
              <span style={{ color: T2 }}>{t.contract}</span>
              <span style={{ color: M }}>{t.size}</span>
              <span style={{ color: M }}>@</span>
              <span style={{ color: T2 }}>${t.fillPrice.toFixed(2)}</span>
              {t.edge ? <span style={{ color: 'var(--theme-positive, #22c55e)' }}>{fmtMoney(t.edge)}</span> : null}
            </div>
          )
        })}
    </div>
  )
}
