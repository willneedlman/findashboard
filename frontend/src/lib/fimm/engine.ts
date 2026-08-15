/*
 * Fixed-income market-making simulation.
 *
 * The options desk quotes a strike ladder against a spot and a vol surface. A
 * rates desk quotes a handful of benchmark issues against a curve, and the risk
 * that matters is not delta and vega but DV01 by bucket, the curve tilt those
 * buckets add up to, and the carry the book earns for holding them overnight.
 *
 * Three shared factors drive the curve rather than one random walk per node.
 * Independent nodes would produce slopes and butterflies no dealer would ever
 * see, and the whole point of the risk column is that a 2s10s tilt is the
 * residual of a small number of shared moves.
 *
 * Prices are per 100 of face. Cash positions are held in millions of notional,
 * futures in contracts. Dollars appear only where the screen needs them.
 */

import {
  convexityPerMM, dv01PerMM, modifiedDuration, nsYield, priceFromYield,
  roundTo32nd, yieldFromPrice, type CurveFactors,
} from './bondmath'
import { gauss, makeRng } from '../mm2/pricing'

export const STEP_MS = 50
/** Simulated seconds in a trading day, for carry accrual. */
const SESSION_SECONDS = 6.5 * 3600

export type NodeKind = 'cash' | 'stir'
export type Participant = 'realmoney' | 'fast' | 'informed'
export type QuoteState = 'active' | 'riskBlocked' | 'capped' | 'off'
export type PriceMode = '32nds' | 'decimal' | 'yield'

export interface Config {
  // Curve dynamics
  level0: number            // long-run level, decimal
  slope0: number            // short minus long, decimal (negative = upward sloping)
  curvature0: number
  tau: number               // Nelson-Siegel decay, years
  levelVolBp: number        // daily basis-point vol of each factor
  slopeVolBp: number
  curveVolBp: number
  reversion: number         // speed factors pull back to their anchors
  shockPerHour: number      // rate of a data-print jump
  shockSizeBp: number
  // Financing and carry
  repoRate: number          // overnight financing on the book, decimal
  sofr: number              // the anchor rate on the top bar
  // Order flow
  arrivalRate: number       // enquiries per simulated second at neutral width
  avgSizeMM: number
  buyBias: number
  informedPct: number
  fastPct: number
  widthSens: number         // how hard a wide quote loses flow
  // Quoting
  edgeBp: number            // half-spread in basis points of yield
  minEdgeBp: number
  maxEdgeBp: number
  longEndWiden: number      // extra edge per year of duration
  invSkewBp: number         // yield shift per unit of DV01 limit usage
  curveSkewBp: number       // yield shift per unit of curve-tilt limit usage
  toxicityWiden: number
  quoteSizeMM: number
  maxQuoteSizeMM: number
  invReliefMM: number       // extra size on the side that flattens the book
  perNodeCapMM: number
  refreshMs: number
  quotingOn: boolean
  // Risk limits, dollars per basis point
  dv01Soft: number; dv01Hard: number
  frontDv01Limit: number
  bellyDv01Limit: number
  longDv01Limit: number
  slopeDv01Limit: number    // 2s10s tilt
  flyDv01Limit: number
  lossSoft: number; lossHard: number
  drawdownHard: number
  // Hedging
  autoHedge: boolean
  hedgeThreshold: number    // net DV01 before the hedger acts
  targetDv01: number
  hedgeIntervalMs: number
  hedgeSlippageTicks: number
}

export const DEFAULT_CONFIG: Config = {
  // Fitted to the published US Treasury par curve for 14 August 2026. A flat or
  // arbitrary curve makes every bucket limit and carry number meaningless.
  level0: 0.055665, slope0: -0.017755, curvature0: 0.0, tau: 5.5554,
  levelVolBp: 5.2, slopeVolBp: 3.4, curveVolBp: 2.6, reversion: 1.4,
  shockPerHour: 0.5, shockSizeBp: 6,
  repoRate: 0.0360, sofr: 0.0362,
  arrivalRate: 1.9, avgSizeMM: 14, buyBias: 0.5, informedPct: 13, fastPct: 30,
  widthSens: 4.5,
  edgeBp: 0.28, minEdgeBp: 0.05, maxEdgeBp: 4, longEndWiden: 0.012,
  invSkewBp: 0.45, curveSkewBp: 0.30, toxicityWiden: 0.5,
  quoteSizeMM: 25, maxQuoteSizeMM: 100, invReliefMM: 15, perNodeCapMM: 250,
  refreshMs: 400, quotingOn: true,
  dv01Soft: 40_000, dv01Hard: 90_000,
  frontDv01Limit: 25_000, bellyDv01Limit: 35_000, longDv01Limit: 45_000,
  slopeDv01Limit: 30_000, flyDv01Limit: 15_000,
  lossSoft: 60_000, lossHard: 150_000, drawdownHard: 120_000,
  autoHedge: true, hedgeThreshold: 3_000, targetDv01: 0,
  hedgeIntervalMs: 1_500, hedgeSlippageTicks: 0.5,
}

// ── Universe ──────────────────────────────────────────────────────────────────

export interface Node {
  id: number
  kind: NodeKind
  label: string             // 2Y, 10Y, SFRM6
  group: string             // Cash, Whites, Reds, Greens, Blues, Golds
  years: number             // to maturity for cash, to the reference period for a STIR
  coupon: number            // decimal, zero for a STIR
  cusip: string
  maturity: string          // display
  /** Bond-equivalent notional of one quoted unit: $1mm cash, one contract STIR. */
  unit: 'MM' | 'lots'
  /** Asset-swap spread in basis points. Cash only; a STIR has no ASW. */
  aswBp: number
  /**
   * The issue's fixed basis to the fitted curve, in basis points.
   *
   * Three Nelson-Siegel factors cannot reproduce a real par curve exactly: the
   * best weighted fit to 14 August 2026 still misses the 2Y by 10bp and puts
   * 2s10s at 67 against a published 52. Every real curve model carries a
   * per-bond residual for the same reason. Holding it here opens each node on
   * its published yield while the three factors still drive all the dynamics,
   * so the nodes keep moving together.
   */
  baseBp: number
}

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const QUARTER_CODE = ['H', 'M', 'U', 'Z']   // Mar, Jun, Sep, Dec

/** DV01 of one SOFR future, fixed by contract terms at $25 a basis point. */
export const STIR_DV01 = 25
/** DV01 per contract for the Treasury futures the hedger uses. */
export const HEDGE_FUTURES = [
  { code: 'TU', label: '2Y Note',  dv01: 39,  tenor: 2 },
  { code: 'FV', label: '5Y Note',  dv01: 42,  tenor: 5 },
  { code: 'TY', label: '10Y Note', dv01: 66,  tenor: 7.5 },
  { code: 'UXY', label: 'Ultra 10Y', dv01: 92, tenor: 10 },
  { code: 'US', label: '30Y Bond', dv01: 128, tenor: 20 },
  { code: 'WN', label: 'Ultra Bond', dv01: 196, tenor: 27 },
] as const
export type HedgeCode = typeof HEDGE_FUTURES[number]['code']

// Published levels for 14 August 2026, with 3Y, 7Y and 20Y interpolated between
// the Treasury's own points. `open` is the yield the node must start on.
const CASH_TENORS = [
  { label: '3M',  years: 0.25, asw: -4,    open: 0.0372 },
  { label: '2Y',  years: 2,    asw: -18.2, open: 0.0418 },
  { label: '3Y',  years: 3,    asw: -20.0, open: 0.0425 },
  { label: '5Y',  years: 5,    asw: -22.5, open: 0.0437 },
  { label: '7Y',  years: 7,    asw: -26.0, open: 0.0452 },
  { label: '10Y', years: 10,   asw: -31.0, open: 0.0470 },
  { label: '20Y', years: 20,   asw: -40.0, open: 0.0510 },
  { label: '30Y', years: 30,   asw: -45.0, open: 0.0526 },
]

export const GROUPS = ['Cash', 'Whites', 'Reds', 'Greens', 'Blues', 'Golds'] as const
export type Group = typeof GROUPS[number]

/** Risk buckets. The front/belly/long split is the one the limits are set on. */
export type Bucket = 'front' | 'belly' | 'long'
export function bucketOf(years: number): Bucket {
  if (years <= 3) return 'front'
  if (years <= 7) return 'belly'
  return 'long'
}

// ── Records ───────────────────────────────────────────────────────────────────

export interface Quote {
  bid: number; ask: number             // price per 100
  bidYield: number; askYield: number
  bidSize: number; askSize: number     // MM or lots
  edgeBp: number
  bidState: QuoteState; askState: QuoteState
  skewBp: number                       // total inventory + curve shading applied
}

export interface Fill {
  id: number
  t: number
  nodeId: number
  side: 'B' | 'A'                      // our side: B = we bought
  size: number
  price: number
  yield: number
  edgeBp: number
  participant: Participant
  markPnl: number                      // marked against model a moment later
}

export interface EventRec { t: number; kind: string; text: string; sev: 0 | 1 | 2 }

export interface Sample {
  t: number
  pnl: number
  dv01: number
  level: number
  tenY: number
  slope: number
  fly: number
  carry: number
  attr: Attribution
}

export interface Attribution {
  spread: number
  curve: number
  carry: number
  convexity: number
  hedge: number
}

export interface RiskState {
  dv01: number
  convexity: number
  byBucket: Record<Bucket, number>
  slope2s10s: number
  slope5s30s: number
  fly2s5s10s: number
  carryPerDay: number
  rollPerDay: number
}

export interface NodeView {
  node: Node
  modelYield: number
  modelPrice: number
  streetBid: number
  streetAsk: number
  /**
   * The street's two-sided market in yield.
   *
   * Yields invert against prices, so the street's bid price is the higher of
   * the two yields. Carrying both here keeps every consumer from re-deriving
   * it and getting the inversion backwards.
   */
  streetBidYield: number
  streetAskYield: number
  /**
   * Whether each side of our quote betters the street.
   *
   * Yields invert against prices, so bettering the street's bid means quoting a
   * *lower* yield than it will pay. Derived once here because the matrix and
   * the inspector both render it, and two copies of an inverted comparison is
   * how they end up disagreeing.
   */
  bidInside: boolean
  askInside: boolean
  quote: Quote
  posMM: number
  avgYield: number
  dv01: number
  pnl: number
  inScope: boolean
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class FiEngine {
  cfg: Config
  seed: number
  private rng: () => number

  clock = 0
  killed = false
  riskStop = ''

  factors: CurveFactors
  private anchor: CurveFactors
  nodes: Node[] = []

  /** Per node, aligned to nodes[].id. */
  modelYield: Float64Array
  modelPrice: Float64Array
  streetBid: Float64Array
  streetAsk: Float64Array
  pos: Float64Array                    // MM for cash, lots for STIR
  avgYield: Float64Array
  nodePnl: Float64Array
  quotes: Quote[] = []

  cash = 0
  realized = 0
  /** Futures hedges held, by contract code. */
  hedges: Record<string, number> = {}
  private hedgeAvg: Record<string, number> = {}

  attr: Attribution = { spread: 0, curve: 0, carry: 0, convexity: 0, hedge: 0 }
  peakPnl = 0
  maxDrawdown = 0

  fills: Fill[] = []
  events: EventRec[] = []
  samples: Sample[] = []

  stat = {
    enquiries: 0, fillsN: 0, notional: 0, edgeIntendedBp: 0, edgeRealizedBp: 0,
    hedges: 0, hedgeSlippage: 0, blocked: 0, informedFills: 0, informedLoss: 0,
    quotedNodes: 0, insideFills: 0,
  }
  toxicity = 0

  private fillSeq = 1
  private lastRefresh = -1e9
  private lastHedge = -1e9
  private lastSample = -1e9
  private lastCarry = 0
  private hedgeMarkPrev = 0

  constructor(cfg: Config, seed: number) {
    this.cfg = { ...cfg }
    this.seed = seed
    this.rng = makeRng(seed)
    this.anchor = { level: cfg.level0, slope: cfg.slope0, curvature: cfg.curvature0, tau: cfg.tau }
    this.factors = { ...this.anchor }

    this.buildUniverse()
    const n = this.nodes.length
    this.modelYield = new Float64Array(n)
    this.modelPrice = new Float64Array(n)
    this.streetBid = new Float64Array(n)
    this.streetAsk = new Float64Array(n)
    this.pos = new Float64Array(n)
    this.avgYield = new Float64Array(n)
    this.nodePnl = new Float64Array(n)
    this.quotes = this.nodes.map(() => emptyQuote())
    this.reprice()
    // Coupons are struck at the opening yield rounded to an eighth, which is how
    // an on-the-run issue actually comes to market and is why it prices near par.
    for (const nd of this.nodes) {
      if (nd.kind !== 'cash') continue
      nd.coupon = Math.round(this.modelYield[nd.id] * 800) / 800
    }
    this.reprice()
    this.runStrategy()
  }

  private buildUniverse(): void {
    let id = 0
    const now = new Date(Date.UTC(2026, 7, 15))
    for (const t of CASH_TENORS) {
      const mat = new Date(now)
      mat.setUTCFullYear(mat.getUTCFullYear() + Math.floor(t.years), mat.getUTCMonth() + Math.round((t.years % 1) * 12))
      this.nodes.push({
        id: id++, kind: 'cash', label: t.label, group: 'Cash', years: t.years,
        coupon: 0.04, cusip: `912810${String(30 + id).padStart(2, '0')}`,
        maturity: `${MONTH[mat.getUTCMonth()]}-${mat.getUTCFullYear()}`,
        unit: 'MM', aswBp: t.asw,
        // Whatever the fitted curve and the ASW spread do not already explain.
        baseBp: (t.open - nsYield(this.anchor, t.years)) * 10_000 - t.asw,
      })
    }
    // SOFR futures, four to a pack. A pack is how the strip is actually traded:
    // the whites move with policy, the golds with the terminal rate.
    const packs: Group[] = ['Whites', 'Reds', 'Greens', 'Blues', 'Golds']
    for (let p = 0; p < packs.length; p++) {
      for (let q = 0; q < 4; q++) {
        const seq = p * 4 + q
        const years = 0.25 + seq * 0.25
        const mat = new Date(now)
        mat.setUTCMonth(mat.getUTCMonth() + 3 * (seq + 1))
        this.nodes.push({
          id: id++, kind: 'stir', label: `SFR${QUARTER_CODE[mat.getUTCMonth() % 4]}${String(mat.getUTCFullYear() % 100)}`,
          group: packs[p], years, coupon: 0,
          cusip: `SR3${QUARTER_CODE[q]}${mat.getUTCFullYear() % 100}`,
          maturity: `${MONTH[mat.getUTCMonth()]}-${mat.getUTCFullYear()}`,
          unit: 'lots', aswBp: 0, baseBp: 0,
        })
      }
    }
  }

  // ── Pricing ─────────────────────────────────────────────────────────────────

  /** Fair yield of a node: the curve, plus its asset-swap spread for cash. */
  fairYield(nd: Node): number {
    const base = nsYield(this.factors, nd.years) + nd.baseBp / 10_000
    return nd.kind === 'cash' ? base + nd.aswBp / 10_000 : base
  }

  fairPrice(nd: Node, y: number): number {
    if (nd.kind === 'stir') return 100 - y * 100
    return priceFromYield(nd.coupon, y, nd.years)
  }

  private reprice(): void {
    for (const nd of this.nodes) {
      const y = this.fairYield(nd)
      const p = this.fairPrice(nd, y)
      this.modelYield[nd.id] = y
      this.modelPrice[nd.id] = p
      // The street is wider than the desk on purpose: an inter-dealer screen is
      // where the desk lifts a hedge, not where it makes its edge.
      const half = this.streetHalfSpread(nd)
      this.streetBid[nd.id] = p - half
      this.streetAsk[nd.id] = p + half
    }
  }

  /**
   * Half the street's width, in basis points of yield.
   *
   * Quoted in yield rather than 32nds because a tick is worth wildly different
   * amounts along the curve: a quarter of a 32nd is 1.6bp on a bill and 0.1bp
   * on a 30Y. Expressed in ticks the desk's own 0.28bp edge came out wider than
   * the street on seven of eight issues, which would have left every quote on
   * the matrix rendered as outside the market.
   *
   * Tightest around the benchmark belly and wider at both wings: the bill has
   * almost no duration, and the long bond is simply less liquid.
   */
  streetHalfBp(nd: Node): number {
    if (nd.kind === 'stir') return 0.25
    if (nd.years <= 0.5) return 1.6
    return 0.45 + Math.abs(nd.years - 7) * 0.012
  }

  /** The same width in price points, for the two street quotes. */
  private streetHalfSpread(nd: Node): number {
    const perBp = this.dv01(nd) / 1e6 * 100      // price points per basis point
    return this.streetHalfBp(nd) * perBp
  }

  /** Invert a price back to a yield, in the node's own convention. */
  yieldAtPrice(nd: Node, price: number): number {
    if (nd.kind === 'stir') return (100 - price) / 100
    return yieldFromPrice(nd.coupon, price, nd.years)
  }

  dv01(nd: Node): number {
    if (nd.kind === 'stir') return STIR_DV01
    return dv01PerMM(nd.coupon, this.modelYield[nd.id], nd.years)
  }

  convexityOf(nd: Node): number {
    if (nd.kind === 'stir') return 0
    return convexityPerMM(nd.coupon, this.modelYield[nd.id], nd.years)
  }

  modDuration(nd: Node): number {
    if (nd.kind === 'stir') return nd.years
    return modifiedDuration(nd.coupon, this.modelYield[nd.id], nd.years)
  }

  // ── Risk ────────────────────────────────────────────────────────────────────

  risk(): RiskState {
    const byBucket: Record<Bucket, number> = { front: 0, belly: 0, long: 0 }
    let dv01 = 0
    let convex = 0
    let carry = 0
    let roll = 0
    for (const nd of this.nodes) {
      const q = this.pos[nd.id]
      if (!q) continue
      const d = q * this.dv01(nd)
      dv01 += d
      byBucket[bucketOf(nd.years)] += d
      convex += q * this.convexityOf(nd)
      if (nd.kind === 'cash') {
        // Carry is the coupon earned less the repo paid to finance the position.
        const notional = q * 1e6
        carry += notional * (nd.coupon - this.cfg.repoRate) / 365
        // Roll-down: a year from now the bond sits one node lower on the curve,
        // and that yield change is worth its DV01.
        const rollBp = (this.fairYield(nd) - nsYield(this.factors, Math.max(0.25, nd.years - 1))) * 10_000
        roll += (rollBp / 365) * q * this.dv01(nd)
      }
    }
    for (const f of HEDGE_FUTURES) {
      const lots = this.hedges[f.code] ?? 0
      if (!lots) continue
      const d = lots * f.dv01
      dv01 += d
      byBucket[bucketOf(f.tenor)] += d
    }
    return {
      dv01, convexity: convex, byBucket,
      slope2s10s: this.slopeDv01(2, 10),
      slope5s30s: this.slopeDv01(5, 30),
      fly2s5s10s: this.flyDv01(),
      carryPerDay: carry, rollPerDay: roll,
    }
  }

  /**
   * Net DV01 tilt between two points on the curve.
   *
   * A book long the 2Y and short the 10Y is flat outright and still fully
   * exposed to the curve, which is the exposure a headline net DV01 hides.
   */
  private slopeDv01(shortY: number, longY: number): number {
    let short = 0
    let long = 0
    const mid = (shortY + longY) / 2
    for (const nd of this.nodes) {
      const d = this.pos[nd.id] * this.dv01(nd)
      if (!d) continue
      if (nd.years <= mid) short += d
      else long += d
    }
    for (const f of HEDGE_FUTURES) {
      const d = (this.hedges[f.code] ?? 0) * f.dv01
      if (!d) continue
      if (f.tenor <= mid) short += d
      else long += d
    }
    return long - short
  }

  /** Belly against the wings: positive is long the belly. */
  private flyDv01(): number {
    let wings = 0
    let belly = 0
    const add = (years: number, d: number) => {
      if (years >= 4 && years <= 7) belly += d
      else wings += d
    }
    for (const nd of this.nodes) add(nd.years, this.pos[nd.id] * this.dv01(nd))
    for (const f of HEDGE_FUTURES) add(f.tenor, (this.hedges[f.code] ?? 0) * f.dv01)
    return belly - wings / 2
  }

  /** A futures price proxy: the curve at the contract's tenor, in price terms. */
  futurePrice(code: string): number {
    const f = HEDGE_FUTURES.find(x => x.code === code)
    if (!f) return 100
    return 100 - nsYield(this.factors, f.tenor) * 100
  }

  totalPnl(): number {
    let open = 0
    for (const nd of this.nodes) {
      const q = this.pos[nd.id]
      if (!q) continue
      // Marked in yield against the average execution yield, converted at DV01.
      open += (this.avgYield[nd.id] - this.modelYield[nd.id]) * 10_000 * q * this.dv01(nd)
    }
    for (const f of HEDGE_FUTURES) {
      const lots = this.hedges[f.code] ?? 0
      if (!lots) continue
      open += lots * (this.futurePrice(f.code) - (this.hedgeAvg[f.code] ?? 0)) * f.dv01
    }
    return this.realized + open
  }

  // ── Quoting ─────────────────────────────────────────────────────────────────

  inScope(nd: Node): boolean {
    if (!this.cfg.quotingOn || this.killed) return false
    return nd.kind === 'cash' || nd.group === 'Whites' || nd.group === 'Reds'
  }

  computeQuote(nd: Node, r: RiskState): Quote {
    const y = this.modelYield[nd.id]
    if (!this.inScope(nd)) {
      const p = this.modelPrice[nd.id]
      return { ...emptyQuote(), bid: p, ask: p, bidYield: y, askYield: y }
    }
    const c = this.cfg
    const dur = this.modDuration(nd)
    let edge = c.edgeBp
    edge += dur * c.longEndWiden
    edge += c.toxicityWiden * this.toxicity * c.edgeBp
    edge = clamp(edge, c.minEdgeBp, c.maxEdgeBp)

    // Shade the whole two-sided quote in yield rather than widening it. A book
    // already long DV01 wants to be hit, not to stop trading, so it lowers the
    // price it will pay and the price it will sell at together.
    const dv01Use = r.dv01 / Math.max(c.dv01Hard, 1)
    const slopeUse = r.slope2s10s / Math.max(c.slopeDv01Limit, 1)
    const bucketUse = r.byBucket[bucketOf(nd.years)] / Math.max(this.bucketLimit(bucketOf(nd.years)), 1)
    // Long inventory shades the offered yield up, which is the same as marking
    // the price down and is what makes someone lift the desk out of its risk.
    let skew = dv01Use * c.invSkewBp + bucketUse * c.invSkewBp * 0.6
    skew += (nd.years >= 7 ? slopeUse : -slopeUse) * c.curveSkewBp
    skew = clamp(skew, -c.maxEdgeBp, c.maxEdgeBp)

    // Edge and skew are both basis points and the yield is a decimal, so they
    // convert on the way in. Adding them raw quoted the 30Y at a 28% yield.
    const bidYield = y + (edge + skew) / 10_000    // we buy at a higher yield, a lower price
    const askYield = y - (edge - skew) / 10_000
    const bid = roundQuote(nd, this.fairPrice(nd, bidYield))
    const ask = roundQuote(nd, this.fairPrice(nd, askYield))

    const posNow = this.pos[nd.id]
    const cap = nd.kind === 'cash' ? c.perNodeCapMM : c.perNodeCapMM * 4
    let bidSize = c.quoteSizeMM
    let askSize = c.quoteSizeMM
    if (posNow > 0) askSize += c.invReliefMM
    if (posNow < 0) bidSize += c.invReliefMM
    bidSize = Math.min(bidSize, c.maxQuoteSizeMM)
    askSize = Math.min(askSize, c.maxQuoteSizeMM)

    let bidState: QuoteState = 'active'
    let askState: QuoteState = 'active'
    // A hard limit blocks only the side that would make it worse. Pulling both
    // sides at a limit is how a desk turns a risk problem into a flow problem.
    if (r.dv01 >= c.dv01Hard || posNow >= cap) { bidState = 'riskBlocked'; bidSize = 0 }
    if (r.dv01 <= -c.dv01Hard || posNow <= -cap) { askState = 'riskBlocked'; askSize = 0 }
    if (this.riskStop) { bidState = 'off'; askState = 'off'; bidSize = 0; askSize = 0 }
    if (posNow + bidSize > cap) { bidSize = Math.max(0, cap - posNow); if (!bidSize) bidState = 'capped' }
    if (posNow - askSize < -cap) { askSize = Math.max(0, cap + posNow); if (!askSize) askState = 'capped' }

    return {
      bid, ask, bidYield, askYield, bidSize, askSize, edgeBp: edge,
      bidState, askState, skewBp: skew,
    }
  }

  bucketLimit(b: Bucket): number {
    return b === 'front' ? this.cfg.frontDv01Limit
      : b === 'belly' ? this.cfg.bellyDv01Limit
      : this.cfg.longDv01Limit
  }

  private runStrategy(): void {
    const r = this.risk()
    let quoted = 0
    for (const nd of this.nodes) {
      this.quotes[nd.id] = this.computeQuote(nd, r)
      if (this.quotes[nd.id].bidSize > 0 || this.quotes[nd.id].askSize > 0) quoted++
    }
    this.stat.quotedNodes = quoted
  }

  // ── Market ──────────────────────────────────────────────────────────────────

  private advanceCurve(): void {
    const c = this.cfg
    const dt = STEP_MS / 1000 / SESSION_SECONDS          // fraction of a session
    const sq = Math.sqrt(Math.max(dt, 0));
    const bp = 1 / 10_000
    const f = this.factors
    f.level += c.reversion * (this.anchor.level - f.level) * dt + gauss(this.rng) * c.levelVolBp * bp * sq
    f.slope += c.reversion * (this.anchor.slope - f.slope) * dt + gauss(this.rng) * c.slopeVolBp * bp * sq
    f.curvature += c.reversion * (this.anchor.curvature - f.curvature) * dt + gauss(this.rng) * c.curveVolBp * bp * sq

    // A data print moves the front of the curve hardest, which is a level and a
    // slope move together rather than a parallel shift.
    if (this.rng() < (c.shockPerHour / 3600) * (STEP_MS / 1000)) {
      const g = gauss(this.rng) * c.shockSizeBp * bp
      f.level += g * 0.6
      f.slope += g * 0.9
      this.log('shock', `Data print moved the front ${(g * 0.9 * 10_000).toFixed(1)} bp`, 1)
    }
    // ASW spreads drift on their own: a swap spread is a different market from
    // the curve it hangs off, and it is where a cash desk actually gets picked off.
    for (const nd of this.nodes) {
      if (nd.kind !== 'cash') continue
      nd.aswBp += gauss(this.rng) * 0.05
    }
  }

  private accrueCarry(): void {
    const dt = STEP_MS / 1000 / SESSION_SECONDS
    const r = this.risk()
    const amount = (r.carryPerDay + r.rollPerDay) * dt
    this.cash += amount
    this.realized += amount
    this.attr.carry += amount
    this.lastCarry = r.carryPerDay + r.rollPerDay
  }

  // ── Flow ────────────────────────────────────────────────────────────────────

  private generateFlow(): void {
    const c = this.cfg
    const scope = this.nodes.filter(n => this.inScope(n))
    if (!scope.length) return
    const lambda = c.arrivalRate * (STEP_MS / 1000)
    if (this.rng() > lambda) return

    const nd = scope[Math.floor(this.rng() * scope.length)]
    const q = this.quotes[nd.id]
    this.stat.enquiries++

    const roll = this.rng() * 100
    const participant: Participant = roll < c.informedPct ? 'informed'
      : roll < c.informedPct + c.fastPct ? 'fast' : 'realmoney'

    // A wide quote loses the enquiry. Real money is the least width-sensitive
    // and the informed the most, because they are shopping the same axe around.
    const widthBp = q.edgeBp * 2
    const sens = participant === 'informed' ? c.widthSens * 1.6
      : participant === 'fast' ? c.widthSens : c.widthSens * 0.5
    if (this.rng() > Math.exp(-sens * widthBp / 100)) return

    // The informed lean against where the curve is about to go, which is what
    // makes them expensive: they buy the desk's offer just before yields fall.
    const drift = this.factors.level - this.anchor.level
    const bias = participant === 'informed'
      ? clamp(0.5 - drift * 40, 0.12, 0.88)
      : c.buyBias
    const clientBuys = this.rng() < bias
    // The client buying means we sell, which is our ask.
    const side: 'B' | 'A' = clientBuys ? 'A' : 'B'
    const avail = side === 'A' ? q.askSize : q.bidSize
    if (avail <= 0) { this.stat.blocked++; return }

    const size = Math.min(avail, Math.max(1, Math.round(c.avgSizeMM * (0.4 + this.rng() * 1.6))))
    this.execute(nd, side, size, participant)
  }

  private execute(nd: Node, side: 'B' | 'A', size: number, participant: Participant): void {
    const q = this.quotes[nd.id]
    const px = side === 'B' ? q.bid : q.ask
    const yld = side === 'B' ? q.bidYield : q.askYield
    const signed = side === 'B' ? size : -size
    const dv = this.dv01(nd)

    const prevPos = this.pos[nd.id]
    const nextPos = prevPos + signed
    // Closing against an existing position realises the yield difference.
    const closed = prevPos !== 0 && Math.sign(prevPos) !== Math.sign(signed)
      ? Math.min(Math.abs(prevPos), Math.abs(signed)) * Math.sign(prevPos)
      : 0
    if (closed !== 0) {
      const gain = (this.avgYield[nd.id] - yld) * 10_000 * closed * dv
      this.realized += gain
      this.nodePnl[nd.id] += gain
    }
    if (nextPos === 0) {
      this.avgYield[nd.id] = 0
    } else if (prevPos === 0 || Math.sign(nextPos) !== Math.sign(prevPos)) {
      // Flat, or flipped clean through zero: the residual is a new position.
      this.avgYield[nd.id] = yld
    } else if (Math.abs(nextPos) > Math.abs(prevPos)) {
      this.avgYield[nd.id] = (this.avgYield[nd.id] * prevPos + yld * signed) / nextPos
    }
    // Reducing without flipping leaves the average alone. Re-blending it on the
    // way out rewrote the entry price of the part still held, which quietly
    // moved P&L between realised and open and broke the attribution identity.
    this.pos[nd.id] = nextPos

    // Edge is the distance from model in basis points, always in our favour at
    // the moment of the trade.
    //
    // It is attributed but not realised. Transacting away from fair shows up on
    // its own in the open mark the instant the position exists, so booking it
    // into realised as well counted every trade's edge twice.
    //
    // Signed, not absolute. When inventory skew is shading hard the desk will
    // deliberately offer through its own model to shed risk, and that trade is
    // a cost. Taking the magnitude booked it as a gain and left the attribution
    // claiming edge on the trades that were paying to get flat.
    const edgeBp = (side === 'B' ? yld - this.modelYield[nd.id] : this.modelYield[nd.id] - yld) * 10_000
    this.attr.spread += edgeBp * size * dv
    this.stat.fillsN++
    this.stat.notional += size
    this.stat.edgeIntendedBp += q.edgeBp * size
    this.stat.edgeRealizedBp += edgeBp * size
    if (participant === 'informed') this.stat.informedFills++

    const fill: Fill = {
      id: this.fillSeq++, t: this.clock, nodeId: nd.id, side, size,
      price: px, yield: yld, edgeBp, participant, markPnl: 0,
    }
    this.fills.unshift(fill)
    if (this.fills.length > 400) this.fills.length = 400
  }

  /** Mark recent fills against the model a moment later, which is the toxicity read. */
  private markFills(): void {
    let adverse = 0
    let n = 0
    for (const f of this.fills) {
      if (this.clock - f.t < 2000) continue
      if (f.markPnl !== 0) continue
      const nd = this.nodes[f.nodeId]
      const dv = this.dv01(nd)
      const signed = f.side === 'B' ? f.size : -f.size
      f.markPnl = (f.yield - this.modelYield[nd.id]) * 10_000 * signed * dv
      if (f.participant === 'informed' && f.markPnl < 0) this.stat.informedLoss += -f.markPnl
      n++
      if (f.markPnl < 0) adverse++
    }
    if (n > 0) this.toxicity = clamp(this.toxicity * 0.9 + (adverse / n) * 0.1, 0, 1)
  }

  // ── Hedging ─────────────────────────────────────────────────────────────────

  /** The contract whose tenor best matches where the risk actually sits. */
  hedgeProposal(): { code: HedgeCode; lots: number; dv01Before: number; dv01After: number; price: number } | null {
    const r = this.risk()
    const gap = r.dv01 - this.cfg.targetDv01
    if (Math.abs(gap) < this.cfg.hedgeThreshold) return null
    // Hedge in the bucket carrying the most risk, so the trade flattens the
    // curve tilt rather than adding one.
    const worst = (Object.entries(r.byBucket) as [Bucket, number][])
      .reduce((a, b) => Math.abs(b[1]) > Math.abs(a[1]) ? b : a)
    const target = worst[0] === 'front' ? 2 : worst[0] === 'belly' ? 5 : 20
    const f = HEDGE_FUTURES.reduce((a, b) =>
      Math.abs(b.tenor - target) < Math.abs(a.tenor - target) ? b : a)
    const lots = -Math.round(gap / f.dv01)
    if (lots === 0) return null
    return {
      code: f.code, lots, dv01Before: r.dv01, dv01After: r.dv01 + lots * f.dv01,
      price: this.futurePrice(f.code),
    }
  }

  executeHedge(manual = false): void {
    const p = this.hedgeProposal()
    if (!p) return
    const f = HEDGE_FUTURES.find(x => x.code === p.code)!
    const prev = this.hedges[p.code] ?? 0
    const next = prev + p.lots
    // Crossing the screen costs the slippage the desk configured, in ticks.
    const slip = this.cfg.hedgeSlippageTicks * (1 / 64) * Math.abs(p.lots) * f.dv01
    this.cash -= slip
    this.realized -= slip
    this.attr.hedge -= slip
    this.stat.hedges++
    this.stat.hedgeSlippage += slip

    // A hedge that reverses closes the old one, and that has to be realised.
    // Leaving it in the average silently discarded the mark the running
    // attribution had already accrued on the lots being closed.
    const closedLots = prev !== 0 && Math.sign(prev) !== Math.sign(p.lots)
      ? Math.min(Math.abs(prev), Math.abs(p.lots)) * Math.sign(prev)
      : 0
    if (closedLots !== 0) {
      this.realized += closedLots * (p.price - (this.hedgeAvg[p.code] ?? p.price)) * f.dv01
    }
    if (next === 0) {
      this.hedgeAvg[p.code] = 0
    } else if (prev === 0 || Math.sign(next) !== Math.sign(prev)) {
      this.hedgeAvg[p.code] = p.price
    } else if (Math.abs(next) > Math.abs(prev)) {
      this.hedgeAvg[p.code] = ((this.hedgeAvg[p.code] ?? p.price) * prev + p.price * p.lots) / next
    }
    this.hedges[p.code] = next
    // The mark just moved from open to realised, so the running accrual has to
    // start from where it now stands rather than book the drop again.
    this.hedgeMarkPrev = this.hedgeMark()
    this.log('hedge', `${manual ? 'Manual' : 'Auto'} hedge ${p.lots > 0 ? '+' : ''}${p.lots} ${p.code} at ${p.price.toFixed(3)}`, 0)
  }

  private runHedger(): void {
    if (!this.cfg.autoHedge || this.killed || this.riskStop) return
    if (this.clock - this.lastHedge < this.cfg.hedgeIntervalMs) return
    this.lastHedge = this.clock
    this.executeHedge(false)
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  flatten(): void {
    for (const nd of this.nodes) {
      const q = this.pos[nd.id]
      if (!q) continue
      // Going flat means crossing the street, so the exit pays the wide side.
      const half = this.streetHalfSpread(nd)
      const exitPrice = q > 0 ? this.modelPrice[nd.id] - half : this.modelPrice[nd.id] + half
      const exitYield = nd.kind === 'stir'
        ? (100 - exitPrice) / 100
        : yieldFromPrice(nd.coupon, exitPrice, nd.years)
      const gain = (this.avgYield[nd.id] - exitYield) * 10_000 * q * this.dv01(nd)
      // Crossing the street costs the difference between the mark and the fill.
      // That is a spread paid, so it lands in the same bucket the spread earned
      // on the way in did, and the attribution identity survives a flatten.
      const markGain = (this.avgYield[nd.id] - this.modelYield[nd.id]) * 10_000 * q * this.dv01(nd)
      this.attr.spread += gain - markGain
      this.realized += gain
      this.nodePnl[nd.id] += gain
      this.pos[nd.id] = 0
      this.avgYield[nd.id] = 0
    }
    for (const f of HEDGE_FUTURES) {
      const lots = this.hedges[f.code] ?? 0
      if (!lots) continue
      const px = this.futurePrice(f.code)
      const gain = lots * (px - (this.hedgeAvg[f.code] ?? px)) * f.dv01
      // The running mark already carries this in attr.hedge, so closing only
      // moves it from open to realised.
      this.realized += gain
      this.hedges[f.code] = 0
      this.hedgeAvg[f.code] = 0
    }
    this.hedgeMarkPrev = 0
    this.log('flatten', 'Book flattened against the street', 1)
    this.runStrategy()
  }

  kill(): void {
    this.killed = true
    for (const nd of this.nodes) this.quotes[nd.id] = emptyQuote()
    this.log('kill', 'Quotes killed', 2)
  }

  clearKill(): void {
    this.killed = false
    this.riskStop = ''
    this.log('kill', 'Quoting resumed', 0)
    this.runStrategy()
  }

  private log(kind: string, text: string, sev: 0 | 1 | 2): void {
    this.events.unshift({ t: this.clock, kind, text, sev })
    if (this.events.length > 300) this.events.length = 300
  }

  private scanRisk(): void {
    const pnl = this.totalPnl()
    this.peakPnl = Math.max(this.peakPnl, pnl)
    this.maxDrawdown = Math.max(this.maxDrawdown, this.peakPnl - pnl)
    if (this.riskStop) return
    const r = this.risk()
    if (Math.abs(r.dv01) >= this.cfg.dv01Hard) {
      this.riskStop = `Net DV01 ${Math.round(r.dv01).toLocaleString()} past the hard limit`
    } else if (pnl <= -this.cfg.lossHard) {
      this.riskStop = `Loss ${Math.round(-pnl).toLocaleString()} past the hard limit`
    } else if (this.maxDrawdown >= this.cfg.drawdownHard) {
      this.riskStop = `Drawdown ${Math.round(this.maxDrawdown).toLocaleString()} past the hard limit`
    }
    if (this.riskStop) this.log('risk', this.riskStop, 2)
  }

  private sample(): void {
    const r = this.risk()
    this.samples.push({
      t: this.clock, pnl: this.totalPnl(), dv01: r.dv01,
      level: this.factors.level, tenY: this.yieldOf('10Y') ?? this.factors.level,
      slope: this.slopeOf('2Y', '10Y'),
      fly: this.flyOf('2Y', '5Y', '10Y'), carry: r.carryPerDay,
      attr: { ...this.attr },
    })
    if (this.samples.length > 900) this.samples.shift()
  }

  /**
   * Attribution accrues on the mark, not on the trade.
   *
   * The identity the whole bottom-left graph rests on is
   * totalPnl === spread + curve + carry + hedge. Booking a closing trade into a
   * bucket as well as accruing its mark while it was open would count the same
   * move twice, so closes move money between realised and open without ever
   * touching attribution.
   */
  private attributeCurve(prevYields: Float64Array, prevDv01: Float64Array): void {
    let curve = 0
    let convex = 0
    for (const nd of this.nodes) {
      const q = this.pos[nd.id]
      if (!q) continue
      const dv = this.dv01(nd)
      curve += (prevYields[nd.id] - this.modelYield[nd.id]) * 10_000 * q * dv
      // The rest of the move is DV01 itself changing as yields moved, which is
      // convexity and is the entire reason a long bond behaves differently from
      // a short one. Folding it into curve delta would have left the graph
      // adding up to slightly the wrong number all session.
      convex += (this.avgYield[nd.id] - prevYields[nd.id]) * 10_000 * q * (dv - prevDv01[nd.id])
    }
    this.attr.curve += curve
    this.attr.convexity += convex
    const mark = this.hedgeMark()
    this.attr.hedge += mark - this.hedgeMarkPrev
    this.hedgeMarkPrev = mark
  }

  /** Open mark on the futures hedges, against their average execution price. */
  private hedgeMark(): number {
    let v = 0
    for (const f of HEDGE_FUTURES) {
      const lots = this.hedges[f.code] ?? 0
      if (!lots) continue
      v += lots * (this.futurePrice(f.code) - (this.hedgeAvg[f.code] ?? 0)) * f.dv01
    }
    return v
  }

  // ── Views ───────────────────────────────────────────────────────────────────

  view(nd: Node): NodeView {
    const q = this.quotes[nd.id]
    const streetBidYield = this.yieldAtPrice(nd, this.streetBid[nd.id])
    const streetAskYield = this.yieldAtPrice(nd, this.streetAsk[nd.id])
    return {
      node: nd,
      modelYield: this.modelYield[nd.id],
      modelPrice: this.modelPrice[nd.id],
      streetBid: this.streetBid[nd.id],
      streetAsk: this.streetAsk[nd.id],
      streetBidYield,
      streetAskYield,
      bidInside: q.bidSize > 0 && q.bidYield < streetBidYield,
      askInside: q.askSize > 0 && q.askYield > streetAskYield,
      quote: this.quotes[nd.id],
      posMM: this.pos[nd.id],
      avgYield: this.avgYield[nd.id],
      dv01: this.pos[nd.id] * this.dv01(nd),
      pnl: this.nodePnl[nd.id],
      inScope: this.inScope(nd),
    }
  }

  rows(group: Group | 'All'): NodeView[] {
    return this.nodes
      .filter(n => group === 'All' || n.group === group)
      .map(n => this.view(n))
  }

  /** A node's live yield by tenor label, or null when the strip does not carry it. */
  yieldOf(label: string): number | null {
    const nd = this.nodes.find(n => n.label === label)
    return nd ? this.modelYield[nd.id] : null
  }

  /**
   * Curve spreads off the issues, not off the raw factors.
   *
   * Each node carries a fixed basis to the fitted curve, so the factor-only
   * slope is not the one the trader reads on screen: it said 67bp where the
   * 2Y and 10Y rows themselves are 52bp apart.
   */
  slopeOf(shortLabel: string, longLabel: string): number {
    const a = this.yieldOf(shortLabel)
    const b = this.yieldOf(longLabel)
    return a == null || b == null ? 0 : (b - a) * 10_000
  }

  flyOf(shortLabel: string, bellyLabel: string, longLabel: string): number {
    const a = this.yieldOf(shortLabel)
    const m = this.yieldOf(bellyLabel)
    const b = this.yieldOf(longLabel)
    return a == null || m == null || b == null ? 0 : (2 * m - a - b) * 10_000
  }

  benchmark(): { sofr: number; tenY: number; tenYChgBp: number; slope: number } {
    const y = this.yieldOf('10Y') ?? this.factors.level
    const prior = this.samples.length ? this.samples[this.samples.length - 1].tenY : y
    return {
      sofr: this.cfg.sofr,
      tenY: y,
      tenYChgBp: (y - prior) * 10_000,
      slope: this.slopeOf('2Y', '10Y'),
    }
  }

  // ── Loop ────────────────────────────────────────────────────────────────────

  step(): void {
    const prevYields = Float64Array.from(this.modelYield)
    const prevDv01 = new Float64Array(this.nodes.length)
    for (const nd of this.nodes) prevDv01[nd.id] = this.dv01(nd)

    this.clock += STEP_MS
    this.advanceCurve()
    this.reprice()
    this.attributeCurve(prevYields, prevDv01)
    this.accrueCarry()

    if (this.clock - this.lastRefresh >= this.cfg.refreshMs) {
      this.lastRefresh = this.clock
      this.runStrategy()
    }

    this.generateFlow()
    this.markFills()
    this.runHedger()
    this.scanRisk()

    if (this.clock - this.lastSample >= 1000) { this.lastSample = this.clock; this.sample() }
  }

  run(steps: number): void {
    for (let i = 0; i < steps; i++) this.step()
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyQuote(): Quote {
  return {
    bid: 0, ask: 0, bidYield: 0, askYield: 0, bidSize: 0, askSize: 0,
    edgeBp: 0, bidState: 'off', askState: 'off', skewBp: 0,
  }
}

/** Cash trades in half 32nds, a SOFR future in half ticks of a quarter basis point. */
function roundQuote(nd: Node, price: number): number {
  return nd.kind === 'cash' ? roundTo32nd(price) : Math.round(price * 400) / 400
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

export function fmtMoney(x: number, dp = 0): string {
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}

export function fmtBp(x: number, dp = 1): string {
  return `${x > 0 ? '+' : ''}${x.toFixed(dp)} bp`
}

export function fmtClock(ms: number): string {
  const base = 7 * 3600 * 1000 + ms                      // the rates session opens at 07:00 ET
  const h = Math.floor(base / 3_600_000) % 24
  const m = Math.floor(base / 60_000) % 60
  const s = Math.floor(base / 1000) % 60
  return `${p2(h)}:${p2(m)}:${p2(s)}`
}
const p2 = (n: number) => String(n).padStart(2, '0')
