import { useEffect, useRef, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import { RailSection } from './valuationShared'

/*
 * Options Market-Making Simulator
 * -------------------------------
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
const STRIKES        = [90, 100, 110]
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
  const atm = STRIKES[(STRIKES.length / 2) | 0]
  const tilt = skew * ((atm - strike) / atm)    // +skew => lower strike, higher IV (equity skew)
  return Math.max(0.02, baseIv + tilt + (manual[strike] ?? 0))
}

// ── Simulation state ────────────────────────────────────────────────────────────
const ck = (kind: 'C' | 'P', strike: number) => `${kind}${strike}`

interface Leg { kind: 'C' | 'P'; strike: number; iv: number; theo: number; bid: number; ask: number; delta: number; gamma: number; vega: number }
type Chain = Record<string, Leg>

interface Fill { tLabel: string; clientSide: string; contract: string; size: number; fillPrice: number; edge: number }

interface SimState {
  spot: number; cash: number; stock: number
  positions: Record<string, number>
  edgeTotal: number; ledger: Fill[]
  tick: number; nextOrderTick: number
  lastOrder: Fill | null; lastOrderAt: number; lastOrderTick: number
  spotHistory: number[]
}

function freshState(): SimState {
  const positions: Record<string, number> = {}
  for (const k of STRIKES) { positions[ck('C', k)] = 0; positions[ck('P', k)] = 0 }
  return {
    spot: SPOT_START, cash: 0, stock: 0, positions, edgeTotal: 0, ledger: [],
    tick: 0, nextOrderTick: randIntInclusive(ORDER_MIN_TICKS, ORDER_MAX_TICKS),
    lastOrder: null, lastOrderAt: 0, lastOrderTick: -999, spotHistory: [SPOT_START],
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

function buildChain(s: SimState, baseIv: number, skew: number, halfSpread: number, manual: Record<number, number>): Chain {
  const chain: Chain = {}
  for (const kind of ['C', 'P'] as const) {
    for (const k of STRIKES) {
      const iv = strikeIv(k, baseIv, skew, manual)
      const q = priceOption(s.spot, k, TIME_TO_EXPIRY, RISK_FREE, iv, kind)
      const hs = Math.max(q.theo * halfSpread, 0.03)
      chain[ck(kind, k)] = {
        kind, strike: k, iv, theo: q.theo,
        bid: Math.max(0.01, q.theo - hs), ask: q.theo + hs,
        delta: q.delta, gamma: q.gamma, vega: q.vega,
      }
    }
  }
  return chain
}

function maybeGenerateOrder(s: SimState, chain: Chain, running: boolean): void {
  if (!running || s.tick < s.nextOrderTick) return
  const keys = Object.keys(s.positions)
  const key = keys[(Math.random() * keys.length) | 0]
  const leg = chain[key]
  const clientSide = Math.random() < 0.5 ? 'BUY' : 'SELL'
  const size = ORDER_SIZES[(Math.random() * ORDER_SIZES.length) | 0]
  let fill: number, edge: number
  if (clientSide === 'BUY') {
    // Client lifts our ASK -> we go short. Edge = ask - theo.
    fill = leg.ask; edge = (fill - leg.theo) * size * MULT
    s.positions[key] -= size; s.cash += fill * size * MULT
  } else {
    // Client hits our BID -> we go long. Edge = theo - bid.
    fill = leg.bid; edge = (leg.theo - fill) * size * MULT
    s.positions[key] += size; s.cash -= fill * size * MULT
  }
  s.edgeTotal += edge
  const rec: Fill = { tLabel: new Date().toLocaleTimeString('en-US', { hour12: false }), clientSide, contract: key, size, fillPrice: fill, edge }
  s.ledger.push(rec)
  s.lastOrder = rec; s.lastOrderAt = Date.now() / 1000; s.lastOrderTick = s.tick
  s.nextOrderTick = s.tick + randIntInclusive(ORDER_MIN_TICKS, ORDER_MAX_TICKS)
}

interface Portfolio { optDeltaSh: number; totalDeltaSh: number; gamma: number; vega1pct: number; netPnl: number }
function portfolioGreeks(s: SimState, chain: Chain): Portfolio {
  let optDeltaSh = 0, gamma = 0, vega1pct = 0, optValue = 0
  for (const key of Object.keys(s.positions)) {
    const pos = s.positions[key]
    if (!pos) continue
    const leg = chain[key]
    optDeltaSh += pos * leg.delta * MULT
    gamma      += pos * leg.gamma * MULT
    vega1pct   += pos * leg.vega          // vega*100 shares *1% = vega
    optValue   += pos * leg.theo * MULT
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
  positions: Record<string, number>; stock: number; edge: number
  ledger: Fill[]; lastOrder: Fill | null; lastOrderAt: number; running: boolean
}

export default function OptionsMarketMaker() {
  const sim = useRef<SimState>(freshState())
  const [paramsOpen, setParamsOpen] = useState(true)
  const [baseIv, setBaseIv]         = useState(0.25)
  const [skew, setSkew]             = useState(0.06)
  const [halfSpread, setHalfSpread] = useState(0.04)
  const [manual, setManual]         = useState<Record<number, number>>(() => Object.fromEntries(STRIKES.map(k => [k, 0])))
  const [running, setRunning]       = useState(false)
  const [speed, setSpeed]           = useState(0.5)
  const [hedgeQty, setHedgeQty]     = useState(100)
  const [rulesOpen, setRulesOpen]   = useState(false)
  const [frame, setFrame]           = useState<Frame | null>(null)

  // Latest controls available to the (single, stable) game-loop.
  const ctrl = useRef({ baseIv, skew, halfSpread, manual, running, speed })
  ctrl.current = { baseIv, skew, halfSpread, manual, running, speed }

  const snapshot = (s: SimState, c: typeof ctrl.current): Frame => {
    const chain = buildChain(s, c.baseIv, c.skew, c.halfSpread, c.manual)
    return {
      chain, greeks: portfolioGreeks(s, chain), spot: s.spot, spotHistory: [...s.spotHistory],
      positions: { ...s.positions }, stock: s.stock, edge: s.edgeTotal,
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
        advanceSpot(s)
        maybeGenerateOrder(s, buildChain(s, c.baseIv, c.skew, c.halfSpread, c.manual), c.running)
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
      {sliderRow('Base Implied Vol', `${(baseIv * 100).toFixed(0)}%`, range(baseIv, 0.05, 0.80, 0.01, setBaseIv))}
      {sliderRow('IV Skew', skew.toFixed(2), range(skew, -0.20, 0.20, 0.01, setSkew), ['High strikes', 'Low strikes'])}
      {sliderRow('Half-Spread (% of theo)', `${(halfSpread * 100).toFixed(1)}%`, range(halfSpread, 0.005, 0.20, 0.005, setHalfSpread))}

      <div style={{ ...labelStyle, marginTop: 6 }}>Manual per-strike IV nudge</div>
      {STRIKES.map(k => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 10, fontFamily: T.mono, color: T.text, width: 28 }}>{k}</span>
          {range(manual[k] ?? 0, -0.15, 0.15, 0.01, v => setManual(m => ({ ...m, [k]: v })))}
          <span style={{ fontSize: 9, fontFamily: T.mono, color: T.muted, width: 34, textAlign: 'right' }}>
            {(manual[k] ?? 0) >= 0 ? '+' : ''}{((manual[k] ?? 0) * 100).toFixed(0)}
          </span>
        </div>
      ))}

      {/* Manual hedge — trade the underlying yourself, like a real maker */}
      <div style={{ ...labelStyle, marginTop: 10 }}>Hedge — Trade Underlying</div>
      {g && (() => {
        const need = -Math.round(g.totalDeltaSh)
        const flatten = need > 0 ? `BUY ${need}` : need < 0 ? `SELL ${Math.abs(need)}` : 'flat'
        return (
          <div style={{ fontSize: 9, fontFamily: T.mono, color: T.muted, marginBottom: 5 }}>
            Net Delta {g.totalDeltaSh >= 0 ? '+' : ''}{g.totalDeltaSh.toFixed(0)} sh ·
            to flatten: <span style={{ color: need === 0 ? T.green : T.gold }}>{flatten}</span>
          </div>
        )
      })()}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, fontFamily: T.sans }}>Trade Size</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input type="number" min={0} step={25} value={hedgeQty}
            onChange={e => setHedgeQty(Math.max(0, Math.round(+e.target.value) || 0))}
            aria-label="Trade size in shares"
            style={{ width: 64, background: T.bg, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: T.gold, fontFamily: T.mono, fontSize: 11, padding: '2px 5px', outline: 'none', textAlign: 'right' }} />
          <span style={{ fontSize: 9, color: T.muted, fontFamily: T.sans }}>sh</span>
        </div>
      </div>
      {range(hedgeQty, 0, 2000, 25, setHedgeQty)}
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.sans, margin: '1px 0 6px' }}>
        @ ${f ? f.spot.toFixed(2) : '-'} = {fmtMoney(hedgeQty * (f ? f.spot : 0))} notional
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={() => onTradeStock(hedgeQty)} style={btnStyle(T.green)}>BUY</button>
        <button onClick={() => onTradeStock(-hedgeQty)} style={btnStyle(T.red)}>SELL</button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button onClick={() => setRunning(r => !r)} style={btnStyle(running ? T.text : T.green)}>{running ? 'PAUSE' : 'START'}</button>
        <button onClick={onReset} style={btnStyle(T.muted)}>RESET</button>
      </div>

      <div style={{ marginTop: 12, borderTop: `1px solid ${T.border}`, paddingTop: 8 }}>
        <button onClick={() => setRulesOpen(o => !o)}
          style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                   background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, color: T.text }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', fontFamily: T.sans }}>How the Desk Works</span>
          <span style={{ fontSize: 9, color: T.muted }}>{rulesOpen ? '▲' : '▼'}</span>
        </button>
        {rulesOpen && (
          <div style={{ marginTop: 8, fontSize: 10, lineHeight: '15px', color: T.muted, fontFamily: T.sans }}>
            1. You stream a <span style={{ color: T.green }}>BID</span> and <span style={{ color: T.red }}>ASK</span> around each option's theoretical value.<br />
            2. Clients trade against your quote — they BUY at your ask, SELL at your bid. You capture the half-spread as <span style={{ color: T.gold }}>edge</span>.<br />
            3. Every fill hands you inventory and Greeks. A short call is short Delta; the stock can move against you.<br />
            4. Watch Net Delta, then <span style={{ color: T.green }}>BUY</span> or <span style={{ color: T.red }}>SELL</span> the underlying to offset it. Buying shares adds positive delta; selling adds negative. Drive Net Delta toward 0.<br />
            5. If Net Delta blows past the limit, the desk flashes <span style={{ color: T.red }}>UNHEDGED RISK</span> — trade stock before a move wipes out your spread.
            <div style={{ color: T.text, fontWeight: 700, letterSpacing: '0.1em', margin: '8px 0 4px' }}>THE TRADE-OFF</div>
            Wider spreads earn more per fill but scare flow away. Hedging removes direction but leaves you short gamma — a delta-flat book still bleeds on large realized moves. The maker gets paid the spread, not the bet.
          </div>
        )}
      </div>
    </div>
    </RailSection>
  )

  return (
    <PageWrapper title="Options Market-Making Simulator">
      <SidebarLayout sidebarWidth={236} sidebarTitle="" sidebar={sidebar}>
        {!f ? (
          <div style={{ padding: 24, fontFamily: T.mono, color: T.muted }}>Starting desk…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* Status */}
            <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.14em', color: f.running ? T.green : T.muted }}>
              DESK STATUS: {f.running ? 'LIVE' : 'PAUSED'}
            </div>

            {/* Scoreboard — P&L split into spread (edge) vs directional (inventory move) */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {scoreCard('Net P&L', fmtMoney(g!.netPnl), g!.netPnl >= 0 ? T.green : T.red, 'directional + spread')}
              {scoreCard('Directional P&L', fmtMoney(g!.netPnl - f.edge), (g!.netPnl - f.edge) >= 0 ? T.green : T.red, 'inventory mark-to-market')}
              {scoreCard('Spread P&L', fmtMoney(f.edge), T.green, 'edge captured from fills')}
              {scoreCard('Spot', `$${f.spot.toFixed(2)}`, T.text, 'underlying')}
              {scoreCard('Stock Inventory', `${f.stock >= 0 ? '+' : ''}${f.stock.toLocaleString()}`, T.text, 'shares (hedge)')}
              {scoreCard('Net Delta', `${g!.totalDeltaSh >= 0 ? '+' : ''}${g!.totalDeltaSh.toFixed(0)}`, overLimit ? T.red : T.gold, `shares | limit ${DELTA_LIMIT}`)}
              {scoreCard('Net Gamma', `${g!.gamma >= 0 ? '+' : ''}${g!.gamma.toFixed(1)}`, T.text, 'delta / $1 move')}
              {scoreCard('Net Vega', fmtMoney(g!.vega1pct), T.text, 'PnL / +1% IV')}
            </div>

            {/* Risk status — always rendered at a fixed height so it never reflows the page */}
            <div style={{
              fontFamily: T.mono, fontSize: 13, fontWeight: overLimit ? 700 : 400, letterSpacing: '0.08em',
              textAlign: 'center', padding: '8px 12px', minHeight: 35, boxSizing: 'border-box',
              color: overLimit ? T.red : T.muted,
              border: `1px solid ${overLimit ? T.red : T.border}`,
              background: overLimit ? 'color-mix(in srgb, var(--theme-negative, #ef4444) 10%, transparent)' : 'transparent',
            }}>
              {overLimit
                ? `Unhedged Directional Risk - Net ${g!.totalDeltaSh > 0 ? 'Long' : 'Short'} ${Math.abs(g!.totalDeltaSh).toFixed(0)} shares - Hedge your Delta`
                : `Net Delta ${g!.totalDeltaSh >= 0 ? '+' : ''}${g!.totalDeltaSh.toFixed(0)} / ${DELTA_LIMIT} sh - within limits`}
            </div>

            {/* Last client order — also fixed height; highlights when fresh, dims when stale */}
            <div style={{
              fontFamily: T.mono, fontSize: 12, fontWeight: 700, padding: '8px 12px', minHeight: 33, boxSizing: 'border-box',
              color: showAlert ? T.gold : T.muted,
              border: `1px solid ${showAlert ? T.gold : T.border}`,
              background: showAlert ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)' : 'transparent',
            }}>
              {f.lastOrder
                ? `CLIENT ORDER → ${f.lastOrder.clientSide} ${f.lastOrder.size} ${f.lastOrder.contract} @ $${f.lastOrder.fillPrice.toFixed(2)} (${f.lastOrder.clientSide === 'BUY' ? 'lifted your offer' : 'hit your bid'})   edge ${fmtMoney(f.lastOrder.edge)}`
                : 'Awaiting client flow…'}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {/* Chain + tape */}
              <div style={{ flex: '1 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ background: T.bg, border: `1px solid ${T.border}` }}>
                  <div style={panelHeader}>OPTIONS CHAIN — YOUR LIVE QUOTES</div>
                  {renderChain(f)}
                </div>
                <div style={{ background: T.bg, border: `1px solid ${T.border}` }}>
                  <div style={panelHeader}>UNDERLYING TAPE</div>
                  <div style={{ height: 180, padding: '6px 4px 4px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={f.spotHistory.map((p, i) => ({ i, spot: +p.toFixed(2) }))} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(128,128,128,0.07)" />
                        <XAxis dataKey="i" hide />
                        <YAxis tick={{ fontSize: 9, fill: T.muted, fontFamily: T.mono }} orientation="right" domain={['auto', 'auto']} tickFormatter={v => `$${(+v).toFixed(0)}`} width={42} />
                        <Tooltip contentStyle={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: 0, fontFamily: T.mono, fontSize: 11 }}
                          formatter={(v: number) => [`$${(+v).toFixed(2)}`, 'spot']} labelFormatter={() => ''} />
                        {STRIKES.map(k => (
                          <ReferenceLine key={k} y={k} stroke="rgba(201,168,76,0.25)" strokeDasharray="3 4" />
                        ))}
                        <Line type="monotone" dataKey="spot" stroke={T.gold} strokeWidth={2} dot={false} isAnimationActive={false} />
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

function renderChain(f: Frame) {
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
            <th style={{ ...th, textAlign: 'left', color: G }}>CALLS</th>
            <th style={th}>Delta</th><th style={th}>Bid</th><th style={th}>Theo</th><th style={th}>Ask</th>
            <th style={{ ...th, textAlign: 'center', color: GD }}>STRIKE</th>
            <th style={{ ...th, textAlign: 'left' }}>Bid</th><th style={{ ...th, textAlign: 'left' }}>Theo</th>
            <th style={{ ...th, textAlign: 'left' }}>Ask</th><th style={{ ...th, textAlign: 'left' }}>Delta</th>
            <th style={{ ...th, textAlign: 'right', color: R }}>PUTS</th>
          </tr>
        </thead>
        <tbody>
          {STRIKES.map(k => {
            const c = f.chain[`C${k}`], p = f.chain[`P${k}`]
            const cpos = f.positions[`C${k}`], ppos = f.positions[`P${k}`]
            const money = f.spot > k ? 'ITM' : f.spot < k ? 'OTM' : 'ATM'
            const atm = Math.abs(k - f.spot) <= 5
            return (
              <tr key={k} style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.04))', background: atm ? 'rgba(201,168,76,0.05)' : 'transparent' }}>
                <td style={{ ...td, textAlign: 'left' }}>{posCell(cpos)}</td>
                <td style={td}>{c.delta >= 0 ? '+' : ''}{c.delta.toFixed(2)}</td>
                <td style={{ ...td, color: G }}>{c.bid.toFixed(2)}</td>
                <td style={{ ...td, color: M }}>{c.theo.toFixed(2)}</td>
                <td style={{ ...td, color: R }}>{c.ask.toFixed(2)}</td>
                <td style={{ ...td, textAlign: 'center', fontWeight: 700, color: GD, background: 'rgba(201,168,76,0.05)' }}>
                  {k}<span style={{ fontSize: 8, color: M, marginLeft: 4 }}>{money}</span>
                </td>
                <td style={{ ...td, textAlign: 'left', color: G }}>{p.bid.toFixed(2)}</td>
                <td style={{ ...td, textAlign: 'left', color: M }}>{p.theo.toFixed(2)}</td>
                <td style={{ ...td, textAlign: 'left', color: R }}>{p.ask.toFixed(2)}</td>
                <td style={{ ...td, textAlign: 'left' }}>{p.delta >= 0 ? '+' : ''}{p.delta.toFixed(2)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{posCell(ppos)}</td>
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
            {['Time', 'Action', 'Contract', 'Size', 'Fill', 'Edge'].map(h => <th key={h} style={th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...f.ledger].reverse().map((t, i) => {
            const isStock = t.contract === 'STOCK'
            const actionColor = isStock
              ? 'var(--theme-primary, #c9a84c)'
              : t.clientSide === 'BUY' ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'
            return (
              <tr key={i} style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.04))' }}>
                <td style={{ ...td, color: 'var(--theme-secondary, #5e768f)' }}>{t.tLabel}</td>
                <td style={{ ...td, color: actionColor }}>{t.clientSide}</td>
                <td style={td}>{t.contract}</td>
                <td style={td}>{t.size}</td>
                <td style={td}>${t.fillPrice.toFixed(2)}</td>
                <td style={{ ...td, color: t.edge ? 'var(--theme-positive, #22c55e)' : 'var(--theme-secondary, #5e768f)' }}>{t.edge ? fmtMoney(t.edge) : '-'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
