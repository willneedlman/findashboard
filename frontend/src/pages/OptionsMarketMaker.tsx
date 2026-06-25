import { useEffect, useRef, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import { Widget, HeaderBar, RiskMeter, StatRow, PnLBar, Stepper, Chips } from '../components/mmCockpit'

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

function buildChain(s: SimState, baseIv: number, skew: number, halfSpread: number, manual: Record<number, number>, spreadAdj: Record<string, number>): Chain {
  const chain: Chain = {}
  for (const kind of ['C', 'P'] as const) {
    for (const k of STRIKES) {
      const iv = strikeIv(k, baseIv, skew, manual)
      const q = priceOption(s.spot, k, TIME_TO_EXPIRY, RISK_FREE, iv, kind)
      // Per-contract widen adds to the global half-spread, so you can quote a
      // single contract wider to discourage flow without touching the rest.
      const hs = Math.max(q.theo * (halfSpread + (spreadAdj[ck(kind, k)] ?? 0)), 0.03)
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
  const [spreadAdj, setSpreadAdj]   = useState<Record<string, number>>(() => Object.fromEntries(STRIKES.flatMap(k => [[`C${k}`, 0], [`P${k}`, 0]])))
  const [running, setRunning]       = useState(false)
  const [speed, setSpeed]           = useState(0.5)
  const [hedgeQty, setHedgeQty]     = useState(100)
  const [tapeSel, setTapeSel]       = useState<string[]>([])   // contracts overlaid on the tape
  const [frame, setFrame]           = useState<Frame | null>(null)

  const toggleTape = (key: string) =>
    setTapeSel(sel => sel.includes(key) ? sel.filter(k => k !== key) : [...sel, key])

  // Latest controls available to the (single, stable) game-loop.
  const ctrl = useRef({ baseIv, skew, halfSpread, manual, spreadAdj, running, speed })
  ctrl.current = { baseIv, skew, halfSpread, manual, spreadAdj, running, speed }

  const snapshot = (s: SimState, c: typeof ctrl.current): Frame => {
    const chain = buildChain(s, c.baseIv, c.skew, c.halfSpread, c.manual, c.spreadAdj)
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
        maybeGenerateOrder(s, buildChain(s, c.baseIv, c.skew, c.halfSpread, c.manual, c.spreadAdj), c.running)
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

  const need = g ? -Math.round(g.totalDeltaSh) : 0
  const flatten = need > 0 ? `BUY ${need}` : need < 0 ? `SELL ${Math.abs(need)}` : 'flat'
  const spotChg = f && f.spotHistory.length > 1 ? (f.spot / f.spotHistory[0] - 1) * 100 : 0
  const spread = f ? f.edge : 0
  const directional = f && g ? g.netPnl - f.edge : 0
  const maxMag = Math.max(Math.abs(spread), Math.abs(directional), 1)

  return (
    <PageWrapper>
      {!f || !g ? (
        <div style={{ padding: 24, fontFamily: T.mono, color: T.muted }}>Starting desk…</div>
      ) : (
        <div style={{ maxWidth: 1340, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <HeaderBar tool="Options MM Simulator" running={f.running} />

          {/* Metrics row */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.32fr 1fr', gap: 10 }}>
            <Widget title="Profit & Loss" bodyStyle={{ padding: '9px 14px', display: 'flex', flexDirection: 'column', gap: 9 }}>
              <div>
                <div style={{ fontFamily: T.mono, fontSize: 25, fontWeight: 700, lineHeight: 1, color: g.netPnl >= 0 ? T.green : T.red }}>{fmtMoney(g.netPnl)}</div>
                <div style={{ ...labelStyle, marginTop: 4, marginBottom: 0 }}>Net P&L</div>
              </div>
              <PnLBar label="Spread" value={fmtMoney(spread)} fill={T.green} frac={Math.abs(spread) / maxMag} />
              <PnLBar label="Directional" value={fmtMoney(directional)} fill={directional >= 0 ? T.green : T.red} frac={Math.abs(directional) / maxMag} />
            </Widget>

            <Widget title="Delta Risk">
              <RiskMeter value={g.totalDeltaSh} limit={DELTA_LIMIT} unit="sh net delta" over={overLimit}
                footerRight={<span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>Net Gamma {g.gamma >= 0 ? '+' : ''}{g.gamma.toFixed(1)}</span>} />
            </Widget>

            <Widget title="Book Greeks">
              <StatRow label="Net Gamma" hint="delta / $1 move" value={`${g.gamma >= 0 ? '+' : ''}${g.gamma.toFixed(1)}`} />
              <StatRow label="Net Vega" hint="PnL / +1% IV" value={fmtMoney(g.vega1pct)} />
              <StatRow label="Stock" hint="hedge shares" value={`${f.stock >= 0 ? '+' : ''}${f.stock.toLocaleString()}`} last />
            </Widget>
          </div>

          {/* MM Controls band */}
          <Widget title="MM Controls" bodyStyle={{ padding: '12px 16px' }}>
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ width: 150 }}>{sliderRow('Sim Speed', `${speed.toFixed(1)}x`, range(speed, SPEED_MIN, SPEED_MAX, 0.1, setSpeed))}</div>
              <div style={{ width: 150 }}>{sliderRow('Base IV', `${(baseIv * 100).toFixed(0)}%`, range(baseIv, 0.05, 0.80, 0.01, setBaseIv))}</div>
              <div style={{ width: 150 }}>{sliderRow('IV Skew', skew.toFixed(2), range(skew, -0.20, 0.20, 0.01, setSkew))}</div>
              <div style={{ width: 150 }}>{sliderRow('Half-Spread', `${(halfSpread * 100).toFixed(1)}%`, range(halfSpread, 0.005, 0.20, 0.005, setHalfSpread))}</div>
              <div style={{ width: 1, alignSelf: 'stretch', background: T.border, margin: '2px 4px' }} />
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ ...labelStyle, marginBottom: 6 }}>Per-strike IV nudge</div>
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${STRIKES.length}, 1fr)`, gap: 14 }}>
                  {STRIKES.map(k => (
                    <div key={k}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 1 }}>
                        <span style={{ fontSize: 9, fontFamily: T.mono, color: T.text }}>{k}</span>
                        <span style={{ fontSize: 9, fontFamily: T.mono, color: T.muted }}>{(manual[k] ?? 0) >= 0 ? '+' : ''}{((manual[k] ?? 0) * 100).toFixed(0)}</span>
                      </div>
                      {range(manual[k] ?? 0, -0.15, 0.15, 0.01, v => setManual(m => ({ ...m, [k]: v })))}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ width: 1, alignSelf: 'stretch', background: T.border, margin: '2px 4px' }} />
              <div style={{ flex: 1, minWidth: 280 }}>
                <div style={{ ...labelStyle, marginBottom: 6 }}>Per-contract spread widen</div>
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${STRIKES.length}, 1fr)`, gap: 14, rowGap: 6 }}>
                  {(['C', 'P'] as const).flatMap(kind => STRIKES.map(k => {
                    const key = `${kind}${k}`
                    const v = spreadAdj[key] ?? 0
                    return (
                      <div key={key}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 1 }}>
                          <span style={{ fontSize: 9, fontFamily: T.mono, color: kind === 'C' ? T.green : T.red }}>{kind} {k}</span>
                          <span style={{ fontSize: 9, fontFamily: T.mono, color: T.muted }}>+{(v * 100).toFixed(1)}</span>
                        </div>
                        {range(v, 0, 0.20, 0.005, nv => setSpreadAdj(m => ({ ...m, [key]: nv })))}
                      </div>
                    )
                  }))}
                </div>
              </div>
            </div>
          </Widget>

          {/* Body row */}
          <div style={{ display: 'grid', gridTemplateColumns: '286px 1fr 372px', gap: 10, alignItems: 'stretch' }}>
            {/* Hedge */}
            <Widget title="Hedge" bodyStyle={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 14, gap: 16 }}>
              <div style={{ background: T.bg, border: `1px solid ${T.border}`, padding: '12px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span style={{ ...labelStyle, marginBottom: 0 }}>Net Delta</span>
                  <span style={{ fontSize: 9, fontFamily: T.mono, color: overLimit ? T.red : T.muted }}>{overLimit ? 'over' : 'within'} {DELTA_LIMIT}</span>
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 700, color: overLimit ? T.red : T.text, margin: '4px 0 9px' }}>
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

              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: `1px solid ${T.border}`, paddingTop: 10, fontFamily: T.mono, fontSize: 11 }}>
                <span style={{ color: T.muted }}>Notional <span style={{ color: T.text }}>{fmtMoney(hedgeQty * f.spot)}</span></span>
                <span style={{ color: T.muted }}>Adds Δ <span style={{ color: T.text }}>±{hedgeQty}</span></span>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => onTradeStock(hedgeQty)} style={bigBtn(T.green)}>BUY</button>
                <button onClick={() => onTradeStock(-hedgeQty)} style={bigBtn(T.red)}>SELL</button>
              </div>

              <div style={{ flex: 1 }} />

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => setRunning(r => !r)} style={btnStyle(running ? T.text : T.green)}>{running ? 'PAUSE' : 'START'}</button>
                <button onClick={onReset} style={btnStyle(T.muted)}>RESET</button>
              </div>
            </Widget>

            {/* Tape */}
            <Widget title={tapeOptions ? 'Option Premiums' : 'Underlying Tape'}
              right={tapeOptions
                ? <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {tapeSel.map((k, idx) => <span key={k} style={{ fontFamily: T.mono, fontSize: 9, color: TAPE_COLORS[idx % TAPE_COLORS.length] }}>{k}</span>)}
                    <button onClick={() => setTapeSel([])} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.muted, fontFamily: T.sans }}>clear</button>
                  </span>
                : <span style={{ fontFamily: T.mono, fontSize: 12, color: spotChg >= 0 ? T.green : T.red }}>${f.spot.toFixed(2)} {spotChg >= 0 ? '+' : ''}{spotChg.toFixed(2)}%</span>}>
              <div style={{ height: 430, padding: '8px 6px 6px' }}>
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

            {/* Book cards */}
            <Widget title="Options Chain" right={<span style={{ fontFamily: T.sans, fontSize: 8, color: T.muted, letterSpacing: '0.04em' }}>click a price to plot</span>}>
              {renderChainCards(f, tapeSel, toggleTape)}
            </Widget>
          </div>

          {/* Ledger */}
          <Widget title="Trade Ledger">{renderLedger(f)}</Widget>
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
    flex: 1, padding: '14px 0', fontFamily: 'var(--theme-mono)', fontSize: 13, fontWeight: 700,
    letterSpacing: '0.1em', cursor: 'pointer', color, textTransform: 'uppercase',
    background: `color-mix(in srgb, ${color} 12%, transparent)`, border: `1px solid ${color}`,
  }
}

// Option chain as a vertical stack of per-strike cards (Call | Put columns).
function renderChainCards(f: Frame, tapeSel: string[], onToggle: (key: string) => void) {
  const G = 'var(--theme-positive, #22c55e)', R = 'var(--theme-negative, #ef4444)', M = 'var(--theme-secondary, #5e768f)', GD = 'var(--theme-primary, #c9a84c)', B = 'var(--theme-tertiary, #60a5fa)'
  const side = (kind: 'C' | 'P', k: number) => {
    const key = `${kind}${k}`
    const leg = f.chain[key]
    const pos = f.positions[key]; const sold = f.sold[key] || 0
    const i = tapeSel.indexOf(key); const on = i >= 0
    const lineCol = on ? TAPE_COLORS[i % TAPE_COLORS.length] : B
    return (
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: kind === 'C' ? G : R }}>
          {kind === 'C' ? 'CALL' : 'PUT'} · Δ {leg.delta >= 0 ? '+' : ''}{leg.delta.toFixed(2)}
        </div>
        <div onClick={() => onToggle(key)} title="Plot on tape"
          style={{ fontFamily: 'var(--theme-mono)', fontSize: 13, margin: '3px 0', cursor: 'pointer', padding: '1px 3px', background: on ? `color-mix(in srgb, ${lineCol} 14%, transparent)` : 'transparent' }}>
          <span style={{ color: G }}>{leg.bid.toFixed(2)}</span>
          <span style={{ color: M }}> / </span>
          <span style={{ color: lineCol }}>{leg.theo.toFixed(2)}</span>
          <span style={{ color: M }}> / </span>
          <span style={{ color: R }}>{leg.ask.toFixed(2)}</span>
        </div>
        <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 9, color: M }}>
          pos <span style={{ color: pos === 0 ? M : pos > 0 ? G : R }}>{pos > 0 ? '+' : ''}{pos}</span>{sold > 0 ? ` · ${sold} sold` : ''}
        </div>
      </div>
    )
  }
  return (
    <div>
      {STRIKES.map(k => {
        const atm = Math.abs(k - f.spot) <= 5
        const money = f.spot > k ? 'ITM' : f.spot < k ? 'OTM' : 'ATM'
        return (
          <div key={k} style={{ padding: '9px 13px', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.05))', background: atm ? 'color-mix(in srgb, var(--theme-primary) 10%, transparent)' : 'transparent' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={{ fontFamily: 'var(--theme-mono)', fontSize: 16, fontWeight: 700, color: GD }}>{k}</span>
              <span style={{ fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', color: M }}>{money}</span>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>{side('C', k)}{side('P', k)}</div>
          </div>
        )
      })}
    </div>
  )
}

function renderLedger(f: Frame) {
  const th: React.CSSProperties = { fontFamily: 'var(--theme-sans)', fontSize: 8, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--theme-secondary, #5e768f)', padding: '8px 18px', textAlign: 'left' }
  const td: React.CSSProperties = { fontFamily: 'var(--theme-mono)', fontSize: 13, padding: '10px 18px', color: 'var(--theme-text, #d7e3fc)' }
  if (f.ledger.length === 0) {
    return <div style={{ padding: '14px 18px', fontFamily: 'var(--theme-mono)', fontSize: 12, color: 'var(--theme-secondary, #5e768f)' }}>No fills yet. Quotes are live. Client orders arrive every few seconds.</div>
  }
  return (
    <div style={{ overflowY: 'auto', maxHeight: 280 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))' }}>
            {['Time', 'Action', 'Contract', 'Size', 'Fill', 'Edge'].map(h => <th key={h} style={th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...f.ledger].reverse().map((t, i) => {
            const isStock = t.contract === 'STOCK'
            const actionColor = isStock ? 'var(--theme-primary, #c9a84c)' : t.clientSide === 'BUY' ? 'var(--theme-positive, #22c55e)' : 'var(--theme-negative, #ef4444)'
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
