/*
 * Options MM 2 — simulation engine.
 *
 * One deterministic event loop wired out of independent modules: market
 * generator, pricing, strategy, risk, matching (with real latency queues and
 * queue position), hedge, ledger, analytics and an event store. The UI never
 * computes state — it renders `frame()` snapshots and pushes config edits back
 * in, so the whole screen stays consistent with a single source of truth.
 *
 * Every step is 50ms of simulated exchange time. Speed sets how many steps run
 * per animation frame, so 1x is wall-clock real time.
 */

import { bsGreeks, bsPrice, surfaceIv, surfaceMetrics, makeRng, gauss, type Greeks, type Kind, type SurfaceParams } from './pricing'

export const STEP_MS = 50
export const MULT = 100                 // one contract = 100 shares
export const PRICE_TICK = 0.05
const YEAR_MS = 365 * 24 * 3600 * 1000

export type SpotProcess = 'gbm' | 'stochvol' | 'jump'
export type EdgeMode = 'vol' | 'dollar' | 'pct'
export type Participant = 'retail' | 'institutional' | 'informed' | 'taker'
export type OrderState = 'pending' | 'active' | 'cancelPending' | 'done'
export type QuoteState = 'active' | 'riskBlocked' | 'modelBlocked' | 'capped' | 'off'

// ── Configuration ─────────────────────────────────────────────────────────────

export interface Config {
  // Market environment
  process: SpotProcess
  spot0: number
  drift: number             // annualised
  realizedVol: number       // annualised
  volReversion: number      // speed instantaneous vol reverts to the surface anchor
  volOfVol: number
  spotVolCorr: number
  jumpPerHour: number
  jumpSize: number          // stdev of the log jump
  underlyingSpreadBps: number
  // Volatility surface
  atmVol: number
  putSkew: number
  callSkew: number
  termSlope: number
  curvature: number
  surfaceNoise: number
  eventPremium: number      // extra vol loaded onto the front expiries
  // Rates and carry
  rate: number
  divYield: number
  // Order flow
  arrivalRate: number       // orders per simulated second at neutral conditions
  avgSize: number
  buyBias: number           // 0.5 = balanced
  informedPct: number
  retailPct: number
  instPct: number
  spreadSens: number        // how hard a wide quote loses flow
  volSens: number           // how much realised vol lifts arrivals
  // Exchange mechanics
  makerRebate: number       // $ per contract earned when passive
  takerFee: number          // $ per contract paid when aggressive
  dataLatencyMs: number
  decisionLatencyMs: number
  sendLatencyMs: number
  ackLatencyMs: number
  cancelLatencyMs: number
  maxMsgRate: number        // messages per simulated second before the venue throttles
  // Strategy
  modelErrorVol: number     // stdev of the strategy's persistent per-contract vol error
  edgeMode: EdgeMode
  baseEdge: number          // vol points, dollars or % of theo depending on edgeMode
  minEdge: number           // dollars
  maxEdge: number           // dollars
  spreadMult: number
  otmWiden: number          // extra edge per unit of standardised moneyness
  dteWiden: number          // extra edge on the front expiries
  gammaWiden: number        // extra edge scaled by gamma limit usage
  vegaWiden: number
  toxicityWiden: number     // extra edge scaled by measured adverse selection
  latencyWiden: number      // extra edge scaled by round-trip latency
  invSkewDelta: number      // price shift per unit of delta limit usage
  invSkewVega: number
  invSkewContract: number   // price shift per contract of same-contract inventory
  baseSize: number
  maxQuoteSize: number
  invReliefSize: number     // extra size on the side that flattens inventory
  perStrikeCap: number
  perExpiryCap: number
  levels: number            // quote levels per side
  levelEdgeMult: number
  levelSizeMult: number
  refreshMs: number
  minTheoMove: number       // requote trigger, in dollars
  maxQuoteAgeMs: number
  quoteExpiries: number     // how many expiries from the front the strategy quotes
  quoteWidth: number        // strikes each side of the money
  quotingOn: boolean
  // Risk limits
  deltaSoft: number; deltaHard: number
  gammaSoft: number; gammaHard: number
  vegaSoft: number;  vegaHard: number
  lossSoft: number;  lossHard: number
  drawdownHard: number
  // Hedge engine
  autoHedge: boolean
  hedgeThreshold: number    // net delta shares before the hedger acts
  targetDelta: number
  minHedge: number
  maxHedge: number
  hedgeIntervalMs: number
  hedgeAggressive: boolean
  hedgeMaxSpreadBps: number
}

export const DEFAULT_CONFIG: Config = {
  process: 'stochvol', spot0: 5320, drift: 0.03, realizedVol: 0.18, volReversion: 4, volOfVol: 0.9,
  spotVolCorr: -0.7, jumpPerHour: 0.4, jumpSize: 0.004, underlyingSpreadBps: 0.9,
  atmVol: 0.19, putSkew: 0.42, callSkew: -0.10, termSlope: 0.05, curvature: 0.20,
  surfaceNoise: 0.004, eventPremium: 0.02,
  rate: 0.042, divYield: 0.013,
  arrivalRate: 2.6, avgSize: 9, buyBias: 0.5, informedPct: 14, retailPct: 46, instPct: 28,
  spreadSens: 5.5, volSens: 1.2,
  makerRebate: 0.16, takerFee: 0.55,
  dataLatencyMs: 12, decisionLatencyMs: 8, sendLatencyMs: 10, ackLatencyMs: 14, cancelLatencyMs: 16,
  maxMsgRate: 1500,
  modelErrorVol: 0.008, edgeMode: 'vol', baseEdge: 0.35, minEdge: 0.05, maxEdge: 6, spreadMult: 1,
  otmWiden: 0.35, dteWiden: 0.4, gammaWiden: 0.5, vegaWiden: 0.4, toxicityWiden: 0.6, latencyWiden: 0.25,
  invSkewDelta: 0.55, invSkewVega: 0.35, invSkewContract: 0.006,
  baseSize: 20, maxQuoteSize: 60, invReliefSize: 10, perStrikeCap: 200, perExpiryCap: 600,
  levels: 2, levelEdgeMult: 2.1, levelSizeMult: 1.8,
  refreshMs: 400, minTheoMove: 0.10, maxQuoteAgeMs: 4000,
  quoteExpiries: 3, quoteWidth: 4, quotingOn: true,
  deltaSoft: 1500, deltaHard: 3500, gammaSoft: 80, gammaHard: 200,
  vegaSoft: 1500, vegaHard: 4000, lossSoft: 40000, lossHard: 100000, drawdownHard: 80000,
  autoHedge: true, hedgeThreshold: 350, targetDelta: 0, minHedge: 25, maxHedge: 2000,
  hedgeIntervalMs: 1500, hedgeAggressive: false, hedgeMaxSpreadBps: 4,
}

// ── Static universe ───────────────────────────────────────────────────────────

export const DTES = [0.4, 1, 2, 7, 14, 30, 60, 90]
export const DTE_LABELS = ['0DTE', '1DTE', '2DTE', '7DTE', '14DTE', '30DTE', '60DTE', '90DTE']
const STRIKE_STEP = 10
const STRIKE_WING = 7

export interface Contract {
  idx: number
  key: string
  expIdx: number
  strike: number
  kind: Kind
  expT: number                      // years from session open
  modelBias: number                 // the strategy's persistent vol error on this contract
  liquidity: number                 // 0..1, drives competing-quote width and flow weight
}

export interface EdgeBreak {
  fair: number; base: number; inventory: number; toxicity: number; latency: number
  gamma: number; vega: number; moneyness: number; dte: number; final: number
}
export interface SizeBreak { base: number; relief: number; limit: number; confidence: number; final: number }

export interface Quote {
  bid: number; ask: number; bidSize: number; askSize: number
  edge: number
  bidState: QuoteState; askState: QuoteState
  bidBreak: EdgeBreak; askBreak: EdgeBreak
  bidSizeBreak: SizeBreak; askSizeBreak: SizeBreak
  modelIv: number
}

export interface Order {
  id: number
  ck: number
  side: 'B' | 'A'
  level: number
  px: number
  size: number
  remaining: number
  state: OrderState
  tCreate: number; tAck: number; tCancel: number
  queueAhead: number
  queueAtSubmit: number
  fairAtSubmit: number
  edgeAtSubmit: number
  cancelReason: string
}

export interface Fill {
  id: number
  t: number
  ck: number
  ourSide: 'BUY' | 'SELL'
  size: number
  px: number
  fair: number
  edge: number
  iv: number
  delta: number
  vega: number
  queueMs: number
  who: Participant
  rebate: number
  p1: number | null; p5: number | null; p30: number | null
  due: number[]
}

export interface EventRec { t: number; kind: string; ck: number; text: string; sev: 0 | 1 | 2 }

export interface Alert {
  t: number; sev: 1 | 2; title: string; scope: string
  value: string; limit: string; action: string; suggest: string
}

export interface Sample {
  t: number; spot: number; atmVol: number; instVol: number
  /** Flat [contractIdx, qty, ...] of the non-flat book, so the chain can be rebuilt at this instant. */
  posSnap: number[]
  total: number; realized: number; unrealized: number
  spread: number; deltaPnl: number; gammaPnl: number; vegaPnl: number; thetaPnl: number
  hedge: number; fees: number; model: number; adverse: number
  netDelta: number; gamma: number; vega: number; optContracts: number; stock: number
}

export interface RiskState {
  delta: number; deltaOpt: number; gamma: number; vega: number; theta: number
  rho: number; vanna: number; volga: number; optValue: number; contracts: number
}

export interface Marker { t: number; kind: string; text: string }

export interface LegView {
  ck: number; pos: number; pnl: number; iv: number; theo: number
  delta: number; gamma: number; vega: number; theta: number
  mktBid: number; mktAsk: number
  ourBid: number; ourAsk: number; ourBidSz: number; ourAskSz: number
  bidState: QuoteState; askState: QuoteState
  live: boolean; expired: boolean
}
export interface ChainRow { strike: number; call: LegView; put: LegView }

// ── Engine ────────────────────────────────────────────────────────────────────

export class Mm2Engine {
  cfg: Config
  seed: number
  private rng: () => number

  clock = 0
  killed = false
  riskStop = ''

  spot: number
  instVol: number
  contracts: Contract[] = []
  strikes: number[] = []

  trueIv: Float64Array
  theo: Float64Array
  delta: Float64Array; gamma: Float64Array; vega: Float64Array; theta: Float64Array
  rho: Float64Array; vanna: Float64Array; volga: Float64Array
  mktBid: Float64Array; mktAsk: Float64Array; mktBidSz: Float64Array; mktAskSz: Float64Array
  pos: Float64Array
  avgPx: Float64Array
  contractPnl: Float64Array
  fillCount: Float64Array
  private noiseSeed: Float64Array
  private index = new Map<string, number>()
  expired: Uint8Array
  quotes: Quote[] = []

  /** Live orders indexed by contract+side, so matching and requoting stay O(1). */
  private book: Order[][] = []
  private slots = new Map<number, Order>()
  orders = new Map<number, Order>()
  private orderSeq = 1
  private fillSeq = 1
  private pendingOut: { at: number; fn: () => void }[] = []

  cash = 0
  stock = 0
  stockAvg = 0
  realized = 0
  rebates = 0

  attr = { spread: 0, delta: 0, gamma: 0, vega: 0, theta: 0, hedge: 0, fees: 0, model: 0, adverse: 0 }
  peakPnl = 0
  maxDrawdown = 0

  fills: Fill[] = []
  events: EventRec[] = []
  alerts: Alert[] = []
  samples: Sample[] = []
  markers: Marker[] = []

  stat = {
    orders: 0, msgs: 0, cancels: 0, fillsN: 0, contractsTraded: 0, partials: 0,
    queueMsTotal: 0, edgeIntended: 0, edgeRealized: 0, widthSum: 0, widthN: 0,
    hedges: 0, hedgeShares: 0, hedgeCost: 0, blocked: 0, informedFills: 0, informedLoss: 0,
    winFills: 0, markedFills: 0, quotedRefreshes: 0, refreshes: 0, throttled: 0,
    quotedContracts: 0, scopeContracts: 0,
  }
  toxicity = 0
  msgWindow: number[] = []

  private stratSpot: number
  private dataDelay: { t: number; spot: number }[] = []
  private lastRefresh = -1e9
  private lastHedge = -1e9
  private lastSample = -1e9
  private lastScan = -1e9
  private impulses: { until: number; drift: number; volDrift: number }[] = []
  private tradeMarkDelta = 0

  constructor(cfg: Config, seed: number) {
    this.cfg = { ...cfg }
    this.seed = seed
    this.rng = makeRng(seed)
    this.spot = cfg.spot0
    this.stratSpot = cfg.spot0
    this.instVol = cfg.atmVol

    const atmK = Math.round(cfg.spot0 / STRIKE_STEP) * STRIKE_STEP
    for (let i = -STRIKE_WING; i <= STRIKE_WING; i++) this.strikes.push(atmK + i * STRIKE_STEP)

    let idx = 0
    for (let e = 0; e < DTES.length; e++) {
      for (const k of this.strikes) {
        for (const kind of ['C', 'P'] as Kind[]) {
          const dist = Math.abs(k - atmK) / (STRIKE_WING * STRIKE_STEP)
          this.contracts.push({
            idx, key: `${e}:${k}${kind}`, expIdx: e, strike: k, kind, expT: DTES[e] / 365,
            modelBias: gauss(this.rng) * cfg.modelErrorVol,
            liquidity: Math.max(0.12, (1 - 0.7 * dist) * (1 - 0.06 * e)),
          })
          idx++
        }
      }
    }
    const n = this.contracts.length
    const f = () => new Float64Array(n)
    this.trueIv = f(); this.theo = f(); this.delta = f(); this.gamma = f(); this.vega = f()
    this.theta = f(); this.rho = f(); this.vanna = f(); this.volga = f()
    this.mktBid = f(); this.mktAsk = f(); this.mktBidSz = f(); this.mktAskSz = f()
    this.pos = f(); this.avgPx = f(); this.contractPnl = f(); this.fillCount = f()
    this.noiseSeed = f()
    this.expired = new Uint8Array(n)
    for (let i = 0; i < n; i++) this.noiseSeed[i] = gauss(this.rng) * cfg.surfaceNoise
    this.quotes = this.contracts.map(() => emptyQuote())
    this.book = Array.from({ length: n * 2 }, () => [])
    for (const c of this.contracts) this.index.set(c.key, c.idx)

    this.reprice()
    this.sample()
    this.mark('open', `Session open. Seed ${seed}. Spot ${cfg.spot0.toFixed(2)}.`)
  }

  // ── Derived state ───────────────────────────────────────────────────────────

  timeToExpiry(c: Contract): number {
    return Math.max(c.expT - this.clock / YEAR_MS, 1 / (365 * 24 * 60))
  }

  surface(): SurfaceParams {
    const c = this.cfg
    return { atmVol: this.instVol, putSkew: c.putSkew, callSkew: c.callSkew, termSlope: c.termSlope, curvature: c.curvature, noise: c.surfaceNoise }
  }

  expiryT(expIdx: number): number {
    return Math.max(DTES[expIdx] / 365 - this.clock / YEAR_MS, 1 / (365 * 24 * 60))
  }

  atmIv(expIdx = 2): number {
    return surfaceIv(this.surface(), this.spot, this.spot, this.expiryT(expIdx), this.cfg.rate, this.cfg.divYield)
      + (expIdx <= 1 ? this.cfg.eventPremium : 0)
  }

  termMetrics(expIdx: number) {
    return surfaceMetrics(this.surface(), this.spot, this.expiryT(expIdx), this.cfg.rate, this.cfg.divYield)
  }

  optValue(): number {
    let v = 0
    for (let i = 0; i < this.pos.length; i++) if (this.pos[i]) v += this.pos[i] * this.theo[i] * MULT
    return v
  }

  totalPnl(): number { return this.cash + this.optValue() + this.stock * this.spot }

  risk(): RiskState {
    let d = 0, g = 0, v = 0, th = 0, rh = 0, vn = 0, vg = 0, val = 0, ct = 0
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i]
      if (!p) continue
      d += p * this.delta[i] * MULT
      g += p * this.gamma[i] * MULT
      v += p * this.vega[i]
      th += p * this.theta[i] * MULT / 365
      rh += p * this.rho[i] * MULT
      vn += p * this.vanna[i] * MULT / 100
      vg += p * this.volga[i] / 100
      val += p * this.theo[i] * MULT
      ct += Math.abs(p)
    }
    return { delta: d + this.stock, deltaOpt: d, gamma: g, vega: v, theta: th, rho: rh, vanna: vn, volga: vg, optValue: val, contracts: ct }
  }

  /** Positions grouped for the risk-by-dimension charts. */
  riskBy(dim: 'strike' | 'expiry' | 'kind', metric: 'delta' | 'gamma' | 'vega'): { label: string; value: number }[] {
    const acc = new Map<string, number>()
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i]
      if (!p) continue
      const c = this.contracts[i]
      const key = dim === 'strike' ? String(c.strike) : dim === 'expiry' ? DTE_LABELS[c.expIdx] : (c.kind === 'C' ? 'Calls' : 'Puts')
      const val = metric === 'delta' ? p * this.delta[i] * MULT : metric === 'gamma' ? p * this.gamma[i] * MULT : p * this.vega[i]
      acc.set(key, (acc.get(key) ?? 0) + val)
    }
    return [...acc.entries()].map(([label, value]) => ({ label, value }))
  }

  // ── Market generator ────────────────────────────────────────────────────────

  private advanceMarket(): void {
    const c = this.cfg
    const dt = STEP_MS / 1000 / (365 * 24 * 3600)
    const sqdt = Math.sqrt(dt)

    this.impulses = this.impulses.filter(im => im.until > this.clock)
    let extraDrift = 0, extraVolDrift = 0
    for (const im of this.impulses) { extraDrift += im.drift; extraVolDrift += im.volDrift }

    const z1 = gauss(this.rng)
    const z2raw = gauss(this.rng)
    const z2 = c.spotVolCorr * z1 + Math.sqrt(Math.max(0, 1 - c.spotVolCorr ** 2)) * z2raw

    if (c.process === 'stochvol') {
      // Vol mean-reverts to the surface anchor and is correlated with spot, so a
      // sell-off genuinely lifts the whole surface and your short vega bleeds.
      const dv = c.volReversion * (c.atmVol - this.instVol) * dt + c.volOfVol * this.instVol * sqdt * z2
      this.instVol = clamp(this.instVol + dv + extraVolDrift * dt, 0.03, 2)
    } else {
      this.instVol = clamp(this.instVol + c.volReversion * (c.atmVol - this.instVol) * dt + extraVolDrift * dt, 0.03, 2)
    }
    const vol = c.process === 'gbm' ? c.realizedVol : this.instVol

    let logRet = (c.drift + extraDrift - 0.5 * vol * vol) * dt + vol * sqdt * z1
    if (c.process === 'jump' && this.rng() < c.jumpPerHour * (STEP_MS / 3_600_000)) {
      const j = gauss(this.rng) * c.jumpSize
      logRet += j
      this.instVol = Math.min(2, this.instVol * 1.25)
      this.mark('shock', `Jump ${(j * 100).toFixed(2)}% — front vol marked up`, 1)
    }
    this.spot = Math.max(1, this.spot * Math.exp(logRet))

    this.dataDelay.push({ t: this.clock, spot: this.spot })
    const cut = this.clock - c.dataLatencyMs
    while (this.dataDelay.length > 1 && this.dataDelay[1].t <= cut) this.dataDelay.shift()
    this.stratSpot = this.dataDelay[0].spot     // what the strategy can actually see
  }

  /**
   * Cash-settle anything that has reached expiry. Without this the front
   * expiries pin at the time floor and their gamma and theta run away to
   * numbers that swamp every risk readout on the screen.
   */
  private settleExpired(): void {
    const nowY = this.clock / YEAR_MS
    for (let i = 0; i < this.contracts.length; i++) {
      const ct = this.contracts[i]
      if (this.expired[i] || nowY < ct.expT) continue
      this.expired[i] = 1
      const p = this.pos[i]
      if (p) {
        const intrinsic = ct.kind === 'C' ? Math.max(this.spot - ct.strike, 0) : Math.max(ct.strike - this.spot, 0)
        this.cash += p * intrinsic * MULT
        this.realized += (intrinsic - this.avgPx[i]) * p * MULT
        this.contractPnl[i] += (intrinsic - this.avgPx[i]) * p * MULT
        this.attr.model += p * (intrinsic - this.theo[i]) * MULT
        this.tradeMarkDelta -= p * this.theo[i] * MULT
        this.mark('expiry', `${this.label(i)} settled ${p > 0 ? 'long' : 'short'} ${Math.abs(p)} at ${intrinsic.toFixed(2)} intrinsic`, 1)
        this.pos[i] = 0
        this.avgPx[i] = 0
      }
      this.cancelSide(i, 'B', 'expired'); this.cancelSide(i, 'A', 'expired')
      this.theo[i] = 0; this.delta[i] = 0; this.gamma[i] = 0; this.vega[i] = 0
      this.theta[i] = 0; this.rho[i] = 0; this.vanna[i] = 0; this.volga[i] = 0
      this.mktBid[i] = 0; this.mktAsk[i] = 0; this.mktBidSz[i] = 0; this.mktAskSz[i] = 0
      this.quotes[i] = emptyQuote()
    }
  }

  /** True values, greeks and the competing two-sided market for every contract. */
  private reprice(): void {
    const c = this.cfg
    const surf = this.surface()
    for (let i = 0; i < this.contracts.length; i++) {
      if (this.expired[i]) continue
      const ct = this.contracts[i]
      const t = this.timeToExpiry(ct)
      const evt = ct.expIdx <= 1 ? c.eventPremium : 0
      const iv = Math.max(0.02, surfaceIv(surf, this.spot, ct.strike, t, c.rate, c.divYield) + evt + this.noiseSeed[i])
      const g: Greeks = bsGreeks(this.spot, ct.strike, t, c.rate, c.divYield, iv, ct.kind)
      this.trueIv[i] = iv
      this.theo[i] = g.theo
      this.delta[i] = g.delta; this.gamma[i] = g.gamma; this.vega[i] = g.vega / 100
      this.theta[i] = g.theta; this.rho[i] = g.rho / 100
      this.vanna[i] = g.vanna; this.volga[i] = g.volga

      const w = (0.010 + 0.05 * (1 - ct.liquidity)) * Math.max(g.theo, 0.5) + 0.025
      const half = Math.max(PRICE_TICK, Math.min(w, Math.max(g.theo * 0.6, PRICE_TICK)))
      this.mktBid[i] = Math.max(PRICE_TICK, roundTick(g.theo - half))
      this.mktAsk[i] = roundTick(g.theo + half)
      this.mktBidSz[i] = Math.round(12 + 140 * ct.liquidity)
      this.mktAskSz[i] = Math.round(12 + 140 * ct.liquidity)
    }
  }

  // ── Strategy ────────────────────────────────────────────────────────────────

  /** The strategy's own view: its (delayed) spot, its own surface, plus model error. */
  modelFair(i: number): { fair: number; iv: number; vega: number; gamma: number } {
    const ct = this.contracts[i]
    const t = this.timeToExpiry(ct)
    const iv = Math.max(0.02, this.trueIv[i] + ct.modelBias)
    const g = bsGreeks(this.stratSpot, ct.strike, t, this.cfg.rate, this.cfg.divYield, iv, ct.kind)
    return { fair: g.theo, iv, vega: g.vega / 100, gamma: g.gamma }
  }

  inScope(i: number): boolean {
    const ct = this.contracts[i]
    if (this.expired[i] || ct.expIdx >= this.cfg.quoteExpiries) return false
    const atmK = Math.round(this.spot / STRIKE_STEP) * STRIKE_STEP
    return Math.abs(ct.strike - atmK) <= this.cfg.quoteWidth * STRIKE_STEP
  }

  private edgeDollars(mf: { fair: number; vega: number }): number {
    const c = this.cfg
    if (c.edgeMode === 'dollar') return c.baseEdge
    if (c.edgeMode === 'pct') return mf.fair * c.baseEdge / 100
    return c.baseEdge * mf.vega                    // vol points converted through vega
  }

  /** The desired two-sided market for one contract, with the full arithmetic kept. */
  computeQuote(i: number, r: RiskState): Quote {
    const c = this.cfg
    const ct = this.contracts[i]
    const mf = this.modelFair(i)
    const t = this.timeToExpiry(ct)

    const deltaUse = clamp(Math.abs(r.delta) / Math.max(c.deltaHard, 1), 0, 2)
    const gammaUse = clamp(Math.abs(r.gamma) / Math.max(c.gammaHard, 1), 0, 2)
    const vegaUse = clamp(Math.abs(r.vega) / Math.max(c.vegaHard, 1), 0, 2)

    const base = this.edgeDollars(mf) * c.spreadMult
    const fwd = this.stratSpot * Math.exp((c.rate - c.divYield) * t)
    const u = Math.abs(Math.log(ct.strike / fwd)) / Math.max(mf.iv * Math.sqrt(t), 1e-4)
    const moneyness = base * c.otmWiden * clamp(u, 0, 3)
    const dteTerm = base * c.dteWiden * (ct.expIdx === 0 ? 1 : ct.expIdx === 1 ? 0.6 : ct.expIdx === 2 ? 0.3 : 0.1)
    const gammaTerm = base * c.gammaWiden * gammaUse
    const vegaTerm = base * c.vegaWiden * vegaUse
    const toxTerm = base * c.toxicityWiden * clamp(this.toxicity, 0, 2)
    const rtt = c.dataLatencyMs + c.decisionLatencyMs + c.sendLatencyMs + c.ackLatencyMs
    const latTerm = base * c.latencyWiden * clamp(rtt / 60, 0, 3)

    const width = clamp(base + moneyness + dteTerm + gammaTerm + vegaTerm + toxTerm + latTerm, c.minEdge, c.maxEdge)

    // Inventory skew shifts BOTH sides toward flat: long delta or long vega
    // pushes the whole market down so clients lift less and hit more.
    const shift = -(
      c.invSkewDelta * (r.delta / Math.max(c.deltaHard, 1)) * base * 2 +
      c.invSkewVega * (r.vega / Math.max(c.vegaHard, 1)) * base * 2 +
      c.invSkewContract * this.pos[i] * base
    )

    let bid = Math.max(PRICE_TICK, roundTick(mf.fair - width + shift))
    let ask = Math.max(bid + PRICE_TICK, roundTick(mf.fair + width + shift))

    const bidBreak: EdgeBreak = { fair: mf.fair, base: -base, inventory: shift, toxicity: -toxTerm, latency: -latTerm, gamma: -gammaTerm, vega: -vegaTerm, moneyness: -moneyness, dte: -dteTerm, final: bid }
    const askBreak: EdgeBreak = { fair: mf.fair, base: base, inventory: shift, toxicity: toxTerm, latency: latTerm, gamma: gammaTerm, vega: vegaTerm, moneyness: moneyness, dte: dteTerm, final: ask }

    const limitCut = Math.round(c.baseSize * Math.max(gammaUse, vegaUse, deltaUse) * 0.8)
    const conf = 1 - clamp(Math.abs(ct.modelBias) / Math.max(c.modelErrorVol * 3, 1e-9), 0, 0.6)
    const strikeFull = this.strikeInventory(ct.strike) >= c.perStrikeCap
    const expiryFull = this.expiryInventory(ct.expIdx) >= c.perExpiryCap
    const capped = strikeFull || expiryFull

    const mkSize = (relief: number): SizeBreak => ({
      base: c.baseSize, relief, limit: -limitCut, confidence: conf,
      final: capped ? 0 : clamp(Math.round((c.baseSize + relief - limitCut) * conf), 0, c.maxQuoteSize),
    })
    const bidSizeBreak = mkSize(this.pos[i] < 0 ? c.invReliefSize : 0)
    const askSizeBreak = mkSize(this.pos[i] > 0 ? c.invReliefSize : 0)

    let bidState: QuoteState = 'active', askState: QuoteState = 'active'
    if (!Number.isFinite(mf.fair) || mf.fair <= PRICE_TICK || this.expired[i]) { bidState = askState = 'modelBlocked' }
    else if (this.killed || !c.quotingOn || this.riskStop) { bidState = askState = 'off' }
    else if (capped) { bidState = askState = 'capped' }
    else {
      // A hard breach blocks only the side that would push the exposure further
      // out. Blocking both would trap the desk in the breach: quoting is the
      // only way inventory ever comes back, so it must stay able to trade out.
      const blockAdding = (bookVal: number, hard: number, buyAdds: boolean) => {
        if (Math.abs(bookVal) <= hard) return
        if (bookVal > 0 ? buyAdds : !buyAdds) bidState = 'riskBlocked'
        else askState = 'riskBlocked'
      }
      blockAdding(r.delta, c.deltaHard, this.delta[i] > 0)
      blockAdding(r.gamma, c.gammaHard, true)     // every long option is long gamma
      blockAdding(r.vega, c.vegaHard, true)       // and long vega
    }

    return { bid, ask, bidSize: bidSizeBreak.final, askSize: askSizeBreak.final, edge: width, bidState, askState, bidBreak, askBreak, bidSizeBreak, askSizeBreak, modelIv: mf.iv }
  }

  private strikeInv = new Map<number, number>()
  private expiryInv = new Map<number, number>()
  strikeInventory(strike: number): number { return this.strikeInv.get(strike) ?? 0 }
  expiryInventory(expIdx: number): number { return this.expiryInv.get(expIdx) ?? 0 }
  /**
   * Concentration is measured NET, not gross. A gross count pins at the cap as
   * soon as the desk has traded enough round turns and then blocks quoting
   * forever, even on a book carrying no actual exposure.
   */
  private recountInventory(): void {
    this.strikeInv.clear(); this.expiryInv.clear()
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i]
      if (!p) continue
      const c = this.contracts[i]
      this.strikeInv.set(c.strike, (this.strikeInv.get(c.strike) ?? 0) + p)
      this.expiryInv.set(c.expIdx, (this.expiryInv.get(c.expIdx) ?? 0) + p)
    }
    for (const [k, v] of this.strikeInv) this.strikeInv.set(k, Math.abs(v))
    for (const [k, v] of this.expiryInv) this.expiryInv.set(k, Math.abs(v))
  }

  private runStrategy(): void {
    const c = this.cfg
    const r = this.risk()
    this.recountInventory()
    this.stat.refreshes++
    if (c.quotingOn && !this.killed && !this.riskStop) this.stat.quotedRefreshes++
    let quoted = 0, scope = 0

    for (let i = 0; i < this.contracts.length; i++) {
      if (!this.inScope(i)) {
        if (this.quotes[i].bidState !== 'off' || this.quotes[i].askState !== 'off') {
          this.quotes[i] = emptyQuote()
          this.cancelSide(i, 'B', 'out of scope'); this.cancelSide(i, 'A', 'out of scope')
        }
        continue
      }
      scope++
      const q = this.computeQuote(i, r)
      this.quotes[i] = q
      this.stat.widthSum += q.ask - q.bid; this.stat.widthN++
      let live = false

      for (const side of ['B', 'A'] as const) {
        const state = side === 'B' ? q.bidState : q.askState
        const px = side === 'B' ? q.bid : q.ask
        const sz = side === 'B' ? q.bidSize : q.askSize
        if (state !== 'active' || sz <= 0) {
          if (state !== 'active') this.stat.blocked++
          this.cancelSide(i, side, state)
          continue
        }
        live = true
        for (let lv = 0; lv < c.levels; lv++) {
          const back = lv > 0 ? q.edge * (Math.pow(c.levelEdgeMult, lv) - 1) : 0
          const lvPx = Math.max(PRICE_TICK, roundTick(side === 'B' ? px - back : px + back))
          const lvSz = Math.min(c.maxQuoteSize, Math.round(sz * Math.pow(c.levelSizeMult, lv)))
          // Budget is checked per order, not once per pass: at the venue cap the
          // desk keeps whatever it can still send up rather than going dark.
          if (this.msgBudgetLeft() <= 0) { this.stat.throttled++; continue }
          this.syncOrder(i, side, lv, lvPx, lvSz, q.bidBreak.fair)
        }
      }
      if (live) quoted++
    }
    this.stat.quotedContracts = quoted
    this.stat.scopeContracts = scope
  }

  // ── Order handling ──────────────────────────────────────────────────────────

  private slotKey = (ck: number, side: 'B' | 'A', level: number) => ck * 16 + (side === 'B' ? 0 : 8) + level
  private bookKey = (ck: number, side: 'B' | 'A') => ck * 2 + (side === 'B' ? 0 : 1)

  ordersFor(ck: number, side: 'B' | 'A'): Order[] { return this.book[this.bookKey(ck, side)] }

  private cancelSide(ck: number, side: 'B' | 'A', reason: string): void {
    for (const o of [...this.book[this.bookKey(ck, side)]]) this.cancel(o, reason)
  }

  private cancel(o: Order, reason: string): void {
    if (o.state === 'cancelPending' || o.state === 'done') return
    o.state = 'cancelPending'
    o.tCancel = this.clock
    o.cancelReason = reason
    this.slots.delete(this.slotKey(o.ck, o.side, o.level))
    this.stat.cancels++; this.pushMsg()
    const at = this.clock + this.cfg.decisionLatencyMs + this.cfg.cancelLatencyMs
    this.pendingOut.push({ at, fn: () => { if (o.state === 'cancelPending') this.retire(o) } })
  }

  private retire(o: Order): void {
    o.state = 'done'
    this.orders.delete(o.id)
    const arr = this.book[this.bookKey(o.ck, o.side)]
    const ix = arr.indexOf(o)
    if (ix >= 0) arr.splice(ix, 1)
  }

  private pushMsg(): void { this.stat.msgs++; this.msgWindow.push(this.clock) }

  private msgBudgetLeft(): number {
    const cut = this.clock - 1000
    while (this.msgWindow.length && this.msgWindow[0] < cut) this.msgWindow.shift()
    return this.cfg.maxMsgRate - this.msgWindow.length
  }

  private syncOrder(ck: number, side: 'B' | 'A', level: number, px: number, size: number, fair: number): void {
    const c = this.cfg
    const key = this.slotKey(ck, side, level)
    const cur = this.slots.get(key)
    if (cur && cur.state !== 'done') {
      const moved = Math.abs(cur.px - px) >= Math.max(PRICE_TICK, c.minTheoMove)
      const resized = Math.abs(cur.remaining - size) > Math.max(2, size * 0.35)
      const stale = this.clock - cur.tCreate > c.maxQuoteAgeMs
      if (!moved && !resized && !stale) return
      this.cancel(cur, moved ? 'reprice' : resized ? 'resize' : 'max age')
    }
    if (this.killed || size <= 0) return
    const o: Order = {
      id: this.orderSeq++, ck, side, level, px, size, remaining: size, state: 'pending',
      tCreate: this.clock, tAck: 0, tCancel: 0, queueAhead: 0, queueAtSubmit: 0,
      fairAtSubmit: fair, edgeAtSubmit: side === 'B' ? fair - px : px - fair, cancelReason: '',
    }
    this.slots.set(key, o)
    this.orders.set(o.id, o)
    this.book[this.bookKey(ck, side)].push(o)
    this.stat.orders++; this.pushMsg()
    const at = this.clock + c.decisionLatencyMs + c.sendLatencyMs + c.ackLatencyMs
    this.pendingOut.push({
      at, fn: () => {
        if (o.state !== 'pending') return
        o.state = 'active'
        o.tAck = this.clock
        // Queue position: through the touch we are alone, at the touch we join
        // behind the resting crowd, behind it we are effectively unfillable.
        const touch = o.side === 'B' ? this.mktBid[ck] : this.mktAsk[ck]
        const better = o.side === 'B' ? o.px > touch + 1e-9 : o.px < touch - 1e-9
        const equal = Math.abs(o.px - touch) < 1e-9
        const depth = o.side === 'B' ? this.mktBidSz[ck] : this.mktAskSz[ck]
        o.queueAhead = better ? 0 : equal ? Math.round(depth * (0.3 + 0.55 * this.rng())) : Math.round(depth * 1.5)
        o.queueAtSubmit = o.queueAhead
      },
    })
  }

  // ── Order flow and matching ─────────────────────────────────────────────────

  private pickParticipant(): Participant {
    const c = this.cfg
    const roll = this.rng() * 100
    if (roll < c.informedPct) return 'informed'
    if (roll < c.informedPct + c.retailPct) return 'retail'
    if (roll < c.informedPct + c.retailPct + c.instPct) return 'institutional'
    return 'taker'
  }

  private generateFlow(): void {
    const c = this.cfg
    const volLift = 1 + c.volSens * (this.instVol / Math.max(c.atmVol, 1e-6) - 1)
    const lambda = Math.max(0, c.arrivalRate * clamp(volLift, 0.3, 3)) * (STEP_MS / 1000)
    if (this.rng() > lambda) return

    const scoped: number[] = []
    for (let i = 0; i < this.contracts.length; i++) if (this.inScope(i)) scoped.push(i)
    if (!scoped.length) return
    let wTotal = 0
    const w = scoped.map(i => {
      const ct = this.contracts[i]
      const val = ct.liquidity * (1 + 0.5 / (1 + ct.expIdx))
      wTotal += val
      return val
    })
    let roll = this.rng() * wTotal, pick = 0
    while (pick < scoped.length - 1 && (roll -= w[pick]) > 0) pick++
    const ck = scoped[pick]

    const who = this.pickParticipant()
    const sizeMult = who === 'institutional' ? 3.2 : who === 'informed' ? 2.1 : who === 'taker' ? 1.2 : 0.7
    const size = Math.max(1, Math.round(c.avgSize * sizeMult * (0.4 + 1.2 * this.rng())))
    let buy = this.rng() < c.buyBias

    if (who === 'informed') {
      // Informed flow trades ahead of the move: the impulse is scheduled now so
      // the mark-out genuinely goes against whoever filled them.
      buy = this.rng() < 0.5
      const dir = (buy ? 1 : -1) * (this.contracts[ck].kind === 'C' ? 1 : -1)
      this.impulses.push({ until: this.clock + 4000, drift: dir * 1.1, volDrift: 0.22 })
    }

    const orders = this.book[this.bookKey(ck, buy ? 'A' : 'B')].filter(o => o.state === 'active' || o.state === 'cancelPending')
    if (!orders.length) return

    const mktPx = buy ? this.mktAsk[ck] : this.mktBid[ck]
    const ourBest = buy ? Math.min(...orders.map(o => o.px)) : Math.max(...orders.map(o => o.px))
    const best = buy ? Math.min(ourBest, mktPx) : Math.max(ourBest, mktPx)
    const fair = this.theo[ck]
    // Clients balk at a wide market: the further the best price sits from fair,
    // the more often the order simply never prints.
    const rel = fair > 0.05 ? Math.abs(best - fair) / fair : 0
    if (this.rng() > Math.exp(-rel * c.spreadSens)) return

    orders.sort((a, b) => buy ? a.px - b.px : b.px - a.px)
    let want = size
    for (const o of orders) {
      if (want <= 0) break
      const worseThanStreet = buy ? o.px > mktPx + 1e-9 : o.px < mktPx - 1e-9
      if (worseThanStreet) continue                       // the street is better; they trade away
      if (o.queueAhead > 0) {
        const eaten = Math.min(o.queueAhead, want)
        o.queueAhead -= eaten
        want -= eaten
        if (want <= 0) break
      }
      const qty = Math.min(want, o.remaining)
      if (qty <= 0) continue
      this.execute(o, qty, who)
      want -= qty
      if (o.remaining <= 0) { this.slots.delete(this.slotKey(o.ck, o.side, o.level)); this.retire(o) }
      else this.stat.partials++
    }
  }

  private execute(o: Order, qty: number, who: Participant): void {
    const ck = o.ck
    const ourSide: 'BUY' | 'SELL' = o.side === 'B' ? 'BUY' : 'SELL'
    const signed = ourSide === 'BUY' ? qty : -qty
    const px = o.px
    const fair = this.theo[ck]

    const prev = this.pos[ck]
    const next = prev + signed
    if (prev !== 0 && Math.sign(prev) !== Math.sign(signed)) {
      const closed = Math.min(Math.abs(prev), qty)
      const pnl = (prev > 0 ? px - this.avgPx[ck] : this.avgPx[ck] - px) * closed * MULT
      this.realized += pnl
      this.contractPnl[ck] += pnl
      if (Math.abs(signed) > Math.abs(prev)) this.avgPx[ck] = px
    } else {
      this.avgPx[ck] = next === 0 ? 0 : (this.avgPx[ck] * Math.abs(prev) + px * qty) / (Math.abs(prev) + qty)
    }
    this.pos[ck] = next
    this.cash += ourSide === 'BUY' ? -px * qty * MULT : px * qty * MULT
    this.tradeMarkDelta += signed * fair * MULT       // book value added at fair, not a mark move

    const rebate = this.cfg.makerRebate * qty
    this.cash += rebate
    this.rebates += rebate
    this.attr.fees += rebate

    const edge = (ourSide === 'SELL' ? px - fair : fair - px) * qty * MULT
    this.attr.spread += edge
    this.stat.edgeRealized += edge
    this.stat.edgeIntended += o.edgeAtSubmit * qty * MULT
    this.stat.fillsN++
    this.stat.contractsTraded += qty
    this.stat.queueMsTotal += Math.max(0, this.clock - o.tAck)
    this.fillCount[ck] += qty
    o.remaining -= qty

    this.fills.push({
      id: this.fillSeq++, t: this.clock, ck, ourSide, size: qty, px, fair, edge,
      iv: this.trueIv[ck], delta: signed * this.delta[ck] * MULT, vega: signed * this.vega[ck],
      queueMs: Math.max(0, this.clock - o.tAck), who, rebate,
      p1: null, p5: null, p30: null, due: [this.clock + 1000, this.clock + 5000, this.clock + 30000],
    })
    if (this.fills.length > 400) this.fills.splice(0, this.fills.length - 400)
    this.log('fill', ck, `${ourSide} ${qty} ${this.label(ck)} @ ${px.toFixed(2)} vs fair ${fair.toFixed(2)} — ${who}`, edge < 0 ? 1 : 0)
  }

  /** Mark-outs at 1s / 5s / 30s: the measurement that exposes adverse selection. */
  private markOuts(): void {
    for (let k = this.fills.length - 1; k >= 0; k--) {
      const f = this.fills[k]
      if (!f.due.length) { if (f.t < this.clock - 35000) break; continue }
      const sign = f.ourSide === 'BUY' ? 1 : -1
      while (f.due.length && this.clock >= f.due[0]) {
        const mv = (this.theo[f.ck] - f.fair) * sign * f.size * MULT
        if (f.p1 === null) f.p1 = mv
        else if (f.p5 === null) f.p5 = mv
        else {
          f.p30 = mv
          this.stat.markedFills++
          if (mv + f.edge > 0) this.stat.winFills++
          if (f.who === 'informed') { this.stat.informedFills++; this.stat.informedLoss += Math.min(0, mv) }
          this.attr.adverse += Math.min(0, mv)
          this.toxicity = 0.94 * this.toxicity + 0.06 * clamp(-mv / Math.max(Math.abs(f.edge), 1), 0, 4)
        }
        f.due.shift()
      }
    }
  }

  // ── Hedge engine ────────────────────────────────────────────────────────────

  hedgeProposal(): { need: number; qty: number; px: number; cost: number; deltaBefore: number; deltaAfter: number } | null {
    const c = this.cfg
    const r = this.risk()
    const need = r.delta - c.targetDelta
    if (Math.abs(need) < c.minHedge) return null
    const raw = -Math.sign(need) * Math.min(Math.abs(need), c.maxHedge)
    const qty = Math.round(raw)
    if (!qty) return null
    const halfSpread = this.spot * (c.underlyingSpreadBps / 10000) / 2
    const px = this.spot + Math.sign(qty) * halfSpread * (c.hedgeAggressive ? 1 : 0.35)
    return { need, qty, px, cost: Math.abs(qty) * Math.abs(px - this.spot), deltaBefore: r.delta, deltaAfter: r.delta + qty }
  }

  executeHedge(manual = false): void {
    const p = this.hedgeProposal()
    if (!p) return
    if (!manual && this.cfg.underlyingSpreadBps > this.cfg.hedgeMaxSpreadBps) {
      this.pushAlert(1, 'Hedge cost too high', 'underlying', `${this.cfg.underlyingSpreadBps.toFixed(1)} bps`,
        `${this.cfg.hedgeMaxSpreadBps.toFixed(1)} bps`, 'auto hedge skipped this cycle', 'raise the max spread or hedge manually')
      this.lastHedge = this.clock
      return
    }
    const slip = (p.px - this.spot) * p.qty
    const prevStock = this.stock
    this.cash -= p.qty * p.px
    this.stock += p.qty
    if (prevStock !== 0 && Math.sign(prevStock) !== Math.sign(p.qty)) {
      const closed = Math.min(Math.abs(prevStock), Math.abs(p.qty))
      this.realized += (prevStock > 0 ? p.px - this.stockAvg : this.stockAvg - p.px) * closed
    }
    const denom = Math.abs(prevStock) + Math.abs(p.qty)
    this.stockAvg = this.stock === 0 ? 0 : (this.stockAvg * Math.abs(prevStock) + p.px * Math.abs(p.qty)) / denom
    this.attr.hedge -= slip
    this.stat.hedges++
    this.stat.hedgeShares += Math.abs(p.qty)
    this.stat.hedgeCost += Math.abs(slip)
    this.lastHedge = this.clock
    this.mark('hedge', `${p.qty > 0 ? 'BUY' : 'SELL'} ${Math.abs(p.qty)} underlying @ ${p.px.toFixed(2)} — delta ${fmt0(p.deltaBefore)} to ${fmt0(p.deltaAfter)}`)
  }

  private runHedger(): void {
    const c = this.cfg
    if (!c.autoHedge || this.killed) return
    if (this.clock - this.lastHedge < c.hedgeIntervalMs) return
    if (Math.abs(this.risk().delta - c.targetDelta) < c.hedgeThreshold) return
    this.executeHedge()
  }

  /** Vega, gamma and expiry-concentration hedges the desk could put on, priced at the street. */
  hedgeIdeas(): { label: string; detail: string; risk: string; after: string }[] {
    const r = this.risk()
    const out: { label: string; detail: string; risk: string; after: string }[] = []
    if (Math.abs(r.vega) > this.cfg.vegaSoft * 0.5) {
      const atmIdx = this.nearestAtm(Math.min(3, this.cfg.quoteExpiries), 'C')
      const perContract = this.vega[atmIdx]
      const n = Math.round(-r.vega / Math.max(perContract, 1e-6))
      out.push({
        label: `${n > 0 ? 'BUY' : 'SELL'} ${Math.abs(n)} ${this.label(atmIdx)}`,
        detail: `straddle-equivalent vega hedge at ${this.theo[atmIdx].toFixed(2)}`,
        risk: `vega ${fmt0(r.vega)}`, after: `vega ${fmt0(r.vega + n * perContract)}`,
      })
    }
    if (Math.abs(r.gamma) > this.cfg.gammaSoft * 0.5) {
      const atmIdx = this.nearestAtm(0, 'C')
      const perContract = this.gamma[atmIdx] * MULT
      const n = Math.round(-r.gamma / Math.max(Math.abs(perContract), 1e-9)) * Math.sign(perContract || 1)
      out.push({
        label: `${n > 0 ? 'BUY' : 'SELL'} ${Math.abs(n)} ${this.label(atmIdx)}`,
        detail: 'front-expiry gamma hedge at the nearest strike',
        risk: `gamma ${fmt0(r.gamma)}`, after: `gamma ${fmt0(r.gamma + n * perContract)}`,
      })
    }
    return out
  }

  /** Contract lookup by coordinates; the surface grid would otherwise rescan every cell. */
  idxOf(expIdx: number, strike: number, kind: Kind): number {
    return this.index.get(`${expIdx}:${strike}${kind}`) ?? -1
  }

  nearestAtm(expIdx: number, kind: Kind): number {
    let best = 0, bestD = Infinity
    for (let i = 0; i < this.contracts.length; i++) {
      const c = this.contracts[i]
      if (c.expIdx !== expIdx || c.kind !== kind) continue
      const d = Math.abs(c.strike - this.spot)
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  // ── Risk, alerts, attribution ───────────────────────────────────────────────

  private pushAlert(sev: 1 | 2, title: string, scope: string, value: string, limit: string, action: string, suggest: string): void {
    const last = this.alerts[this.alerts.length - 1]
    if (last && last.title === title && this.clock - last.t < 8000) return
    this.alerts.push({ t: this.clock, sev, title, scope, value, limit, action, suggest })
    if (this.alerts.length > 60) this.alerts.shift()
    this.log('alert', -1, `${title} — ${value} against ${limit}. ${action}`, sev)
  }

  private scanRisk(): void {
    const c = this.cfg
    const r = this.risk()
    const pnl = this.totalPnl()
    this.peakPnl = Math.max(this.peakPnl, pnl)
    this.maxDrawdown = Math.max(this.maxDrawdown, this.peakPnl - pnl)

    const checks: [string, number, number, number, string, string][] = [
      ['Delta', r.delta, c.deltaSoft, c.deltaHard, 'shares', 'hedge the underlying now'],
      ['Gamma', r.gamma, c.gammaSoft, c.gammaHard, 'sh/pt', 'buy back front-expiry inventory'],
      ['Vega', r.vega, c.vegaSoft, c.vegaHard, '$/pt', 'trade the vega hedge in the panel'],
    ]
    for (const [name, val, soft, hard, unit, fix] of checks) {
      const a = Math.abs(val)
      if (a > hard) {
        this.pushAlert(2, `${name} hard limit breached`, 'portfolio', `${fmt0(val)} ${unit}`, `${fmt0(hard)} ${unit}`, 'risk-adding quotes cancelled', fix)
      } else if (a > soft) {
        this.pushAlert(1, `${name} soft limit reached`, 'portfolio', `${fmt0(val)} ${unit}`, `${fmt0(soft)} ${unit}`, 'quotes widened and size cut', 'let the inventory skew work, or hedge')
      }
    }
    if (-pnl > c.lossHard && !this.riskStop) {
      this.riskStop = 'daily loss'
      this.pushAlert(2, 'Daily loss limit reached', 'session', fmtMoney(pnl), fmtMoney(-c.lossHard), 'all quoting stopped', 'reset, or raise the loss limit and restart')
      this.cancelAll('risk stop')
    } else if (-pnl > c.lossSoft) {
      this.pushAlert(1, 'Daily loss soft limit', 'session', fmtMoney(pnl), fmtMoney(-c.lossSoft), 'size reduced', 'check attribution: spread capture or inventory?')
    }
    if (this.maxDrawdown > c.drawdownHard && !this.riskStop) {
      this.riskStop = 'drawdown'
      this.pushAlert(2, 'Max drawdown breached', 'session', fmtMoney(-this.maxDrawdown), fmtMoney(-c.drawdownHard), 'all quoting stopped', 'reset the session')
      this.cancelAll('drawdown stop')
    }
    if (this.msgBudgetLeft() <= 0) {
      this.pushAlert(1, 'Message rate limit', 'venue', `${this.msgWindow.length}/s`, `${c.maxMsgRate}/s`, 'requotes throttled by the venue', 'raise the refresh interval or the requote threshold')
    }
    if (this.toxicity > 1.4) {
      this.pushAlert(1, 'Repeated adverse fills', 'flow', `toxicity ${this.toxicity.toFixed(2)}`, '1.40', 'quotes widened by the toxicity term', 'cut size, or stop quoting the expiry taking the hits')
    }
    if (c.dataLatencyMs > 40) {
      this.pushAlert(1, 'Market data delayed', 'venue', `${c.dataLatencyMs} ms`, '40 ms', 'quotes priced off a stale spot', 'widen base edge until the feed recovers')
    }
  }

  /** Greek-explained mark-to-market, so every dollar lands in exactly one bucket. */
  private attribute(prev: RiskState, prevOptValue: number, prevStock: number, dSpot: number, dVol: number): void {
    const dtYears = STEP_MS / 1000 / (365 * 24 * 3600)
    const deltaPnl = prev.deltaOpt * dSpot
    const gammaPnl = 0.5 * prev.gamma * dSpot * dSpot
    const vegaPnl = prev.vega * dVol * 100
    const thetaPnl = prev.theta * dtYears * 365
    // The move is earned by the stock held DURING it, not by shares the hedger
    // bought at the end of the step — using the post-hedge count leaks P&L.
    const hedgePnl = prevStock * dSpot
    const actual = this.optValue() - prevOptValue - this.tradeMarkDelta
    this.attr.delta += deltaPnl
    this.attr.gamma += gammaPnl
    this.attr.vega += vegaPnl
    this.attr.theta += thetaPnl
    this.attr.hedge += hedgePnl
    this.attr.model += actual - (deltaPnl + gammaPnl + vegaPnl + thetaPnl)
    this.tradeMarkDelta = 0
  }

  cancelAll(reason: string): void {
    for (const o of [...this.orders.values()]) this.cancel(o, reason)
  }

  kill(): void {
    this.killed = true
    this.cancelAll('kill switch')
    this.cfg.quotingOn = false
    this.mark('kill', 'Kill switch — every quote pulled, order entry disabled', 2)
    this.pushAlert(2, 'Kill switch activated', 'session', 'manual', 'n/a', 'every quote cancelled, entry disabled', 'clear the kill switch to resume quoting')
  }

  clearKill(): void {
    this.killed = false
    this.riskStop = ''
    this.cfg.quotingOn = true
    this.mark('kill', 'Kill switch cleared — quoting re-enabled', 1)
  }

  flatten(): void {
    // Cross the street on every option position and take delta to zero. This is
    // the "get me out" button, so it pays the full width rather than resting.
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i]
      if (!p) continue
      const px = p > 0 ? this.mktBid[i] : this.mktAsk[i]
      const fee = this.cfg.takerFee * Math.abs(p)
      const pnl = (p > 0 ? px - this.avgPx[i] : this.avgPx[i] - px) * Math.abs(p) * MULT
      this.realized += pnl - fee
      this.contractPnl[i] += pnl
      this.cash += (p > 0 ? px * Math.abs(p) : -px * Math.abs(p)) * MULT - fee
      this.attr.spread += (p > 0 ? px - this.theo[i] : this.theo[i] - px) * Math.abs(p) * MULT
      this.attr.fees -= fee
      this.tradeMarkDelta -= p * this.theo[i] * MULT
      this.pos[i] = 0
      this.avgPx[i] = 0
    }
    if (this.stock) {
      const px = this.spot - Math.sign(this.stock) * this.spot * (this.cfg.underlyingSpreadBps / 10000) / 2
      this.cash += this.stock * px
      this.realized += (px - this.stockAvg) * this.stock
      this.attr.hedge += this.stock * (px - this.spot)
      this.stock = 0
      this.stockAvg = 0
    }
    this.cancelAll('flatten')
    this.mark('flatten', 'Book flattened at the street price', 1)
  }

  // ── Sampling, logging, stress ───────────────────────────────────────────────

  private sample(): void {
    const r = this.risk()
    const total = this.totalPnl()
    const posSnap: number[] = []
    for (let i = 0; i < this.pos.length; i++) if (this.pos[i]) posSnap.push(i, this.pos[i])
    this.samples.push({
      t: this.clock, spot: this.spot, atmVol: this.atmIv(2), instVol: this.instVol, posSnap,
      total, realized: this.realized, unrealized: total - this.realized,
      spread: this.attr.spread, deltaPnl: this.attr.delta, gammaPnl: this.attr.gamma,
      vegaPnl: this.attr.vega, thetaPnl: this.attr.theta, hedge: this.attr.hedge,
      fees: this.attr.fees, model: this.attr.model, adverse: this.attr.adverse,
      netDelta: r.delta, gamma: r.gamma, vega: r.vega, optContracts: r.contracts, stock: this.stock,
    })
    if (this.samples.length > 3600) this.samples.shift()
  }

  private log(kind: string, ck: number, text: string, sev: 0 | 1 | 2): void {
    this.events.push({ t: this.clock, kind, ck, text, sev })
    if (this.events.length > 600) this.events.shift()
  }

  private mark(kind: string, text: string, sev: 0 | 1 | 2 = 0): void {
    this.markers.push({ t: this.clock, kind, text })
    if (this.markers.length > 120) this.markers.shift()
    this.log(kind, -1, text, sev)
  }

  label(ck: number): string {
    const c = this.contracts[ck]
    return `${DTE_LABELS[c.expIdx]} ${c.strike}${c.kind}`
  }

  /**
   * One expiry's chain. With a `sample` it is rebuilt from that instant's spot,
   * vol and book instead of the live arrays, which is what lets the P&L chart
   * rewind the whole screen. Resting quotes are not snapshotted, so a rebuilt
   * row reports `live: false` and the quote columns read as unavailable rather
   * than showing today's quotes against yesterday's market.
   */
  chainRows(expIdx: number, sample?: Sample): ChainRow[] {
    const c = this.cfg
    const posMap = sample ? new Map<number, number>() : null
    if (sample && posMap) for (let k = 0; k < sample.posSnap.length; k += 2) posMap.set(sample.posSnap[k], sample.posSnap[k + 1])
    const surf: SurfaceParams | null = sample
      ? { atmVol: sample.instVol, putSkew: c.putSkew, callSkew: c.callSkew, termSlope: c.termSlope, curvature: c.curvature, noise: c.surfaceNoise }
      : null

    const leg = (i: number): LegView => {
      const ct = this.contracts[i]
      if (sample && surf) {
        const t = Math.max(ct.expT - sample.t / YEAR_MS, 1 / (365 * 24 * 60))
        const iv = Math.max(0.02, surfaceIv(surf, sample.spot, ct.strike, t, c.rate, c.divYield) + (ct.expIdx <= 1 ? c.eventPremium : 0) + this.noiseSeed[i])
        const g = bsGreeks(sample.spot, ct.strike, t, c.rate, c.divYield, iv, ct.kind)
        const pos = posMap?.get(i) ?? 0
        return {
          ck: i, pos, pnl: 0, iv, theo: g.theo, delta: g.delta, gamma: g.gamma, vega: g.vega / 100, theta: g.theta / 365,
          mktBid: Math.max(0, roundTick(g.theo - 0.3)), mktAsk: roundTick(g.theo + 0.3),
          ourBid: 0, ourAsk: 0, ourBidSz: 0, ourAskSz: 0, bidState: 'off', askState: 'off', live: false,
          expired: sample.t / YEAR_MS >= ct.expT,
        }
      }
      const q = this.quotes[i]
      return {
        ck: i, pos: this.pos[i], pnl: this.contractPnl[i] + (this.pos[i] ? (this.theo[i] - this.avgPx[i]) * this.pos[i] * MULT : 0),
        iv: this.trueIv[i], theo: this.theo[i], delta: this.delta[i], gamma: this.gamma[i], vega: this.vega[i], theta: this.theta[i] / 365,
        mktBid: this.mktBid[i], mktAsk: this.mktAsk[i],
        ourBid: q.bid, ourAsk: q.ask, ourBidSz: q.bidSize, ourAskSz: q.askSize,
        bidState: q.bidState, askState: q.askState, live: true, expired: !!this.expired[i],
      }
    }

    const byStrike = new Map<number, ChainRow>()
    for (let i = 0; i < this.contracts.length; i++) {
      const ct = this.contracts[i]
      if (ct.expIdx !== expIdx) continue
      let row = byStrike.get(ct.strike)
      if (!row) { row = { strike: ct.strike, call: null as never, put: null as never }; byStrike.set(ct.strike, row) }
      if (ct.kind === 'C') row.call = leg(i); else row.put = leg(i)
    }
    return [...byStrike.values()].sort((a, b) => a.strike - b.strike)
  }

  /** Resting depth for one contract: the street's ladder with our own orders slotted in. */
  depth(ck: number): { px: number; bidSize: number; askSize: number; ours: Order[]; traded: number }[] {
    const rows: { px: number; bidSize: number; askSize: number; ours: Order[]; traded: number }[] = []
    if (this.expired[ck]) return rows
    const mid = this.theo[ck]
    const levels = new Set<number>()
    for (let k = 0; k < 5; k++) {
      levels.add(roundTick(this.mktBid[ck] - k * PRICE_TICK))
      levels.add(roundTick(this.mktAsk[ck] + k * PRICE_TICK))
    }
    const mine = [...this.ordersFor(ck, 'B'), ...this.ordersFor(ck, 'A')].filter(o => o.state !== 'done')
    for (const o of mine) levels.add(roundTick(o.px))
    const sorted = [...levels].filter(p => p > 0).sort((a, b) => b - a)
    for (const px of sorted) {
      const isBid = px <= this.mktBid[ck] + 1e-9
      const isAsk = px >= this.mktAsk[ck] - 1e-9
      const dist = Math.round(Math.abs(px - (isBid ? this.mktBid[ck] : this.mktAsk[ck])) / PRICE_TICK)
      const streetSz = dist <= 4 ? Math.round((isBid ? this.mktBidSz[ck] : this.mktAskSz[ck]) * Math.pow(0.72, dist)) : 0
      rows.push({
        px,
        bidSize: isBid ? streetSz : 0,
        askSize: isAsk ? streetSz : 0,
        ours: mine.filter(o => Math.abs(o.px - px) < 1e-9),
        traded: Math.round(this.fillCount[ck] * Math.exp(-Math.abs(px - mid) * 2)),
      })
    }
    return rows
  }

  stress(spotPcts: number[], volPts: number[]): number[][] {
    const c = this.cfg
    const base = this.optValue() + this.stock * this.spot
    return volPts.map(dv => spotPcts.map(ds => {
      const s = this.spot * (1 + ds / 100)
      let v = 0
      for (let i = 0; i < this.pos.length; i++) {
        if (!this.pos[i]) continue
        const ct = this.contracts[i]
        const iv = Math.max(0.02, this.trueIv[i] + dv / 100)
        v += this.pos[i] * bsPrice(s, ct.strike, this.timeToExpiry(ct), c.rate, c.divYield, iv, ct.kind) * MULT
      }
      return v + this.stock * s - base
    }))
  }

  /** Named scenarios beyond the grid — the ones that actually kill option desks. */
  scenarios(): { name: string; pnl: number }[] {
    const grid = (ds: number, dv: number) => this.stress([ds], [dv])[0][0]
    return [
      { name: 'Vol collapse -5pt', pnl: grid(0, -5) },
      { name: 'Vol spike +8pt', pnl: grid(0, 8) },
      { name: 'Spot gap -3%', pnl: grid(-3, 4) },
      { name: 'Spot gap +3%', pnl: grid(3, -1) },
      { name: 'Quiet drift', pnl: grid(0.2, -1) },
      { name: 'Crash -5% / vol +10', pnl: grid(-5, 10) },
    ]
  }

  // ── The loop ────────────────────────────────────────────────────────────────

  step(): void {
    const prevRisk = this.risk()
    const prevOptValue = this.optValue()
    const prevSpot = this.spot
    const prevStock = this.stock
    const prevAtm = this.atmIv(2)

    this.clock += STEP_MS
    this.advanceMarket()
    this.settleExpired()
    this.reprice()

    if (this.pendingOut.length) {
      const keep: typeof this.pendingOut = []
      for (const p of this.pendingOut) {
        if (p.at <= this.clock) p.fn()
        else keep.push(p)
      }
      this.pendingOut = keep
    }

    if (this.clock - this.lastRefresh >= this.cfg.refreshMs) {
      this.lastRefresh = this.clock
      this.runStrategy()
    }

    this.generateFlow()
    this.markOuts()
    this.runHedger()
    this.attribute(prevRisk, prevOptValue, prevStock, this.spot - prevSpot, this.atmIv(2) - prevAtm)

    if (this.clock - this.lastScan >= 500) { this.lastScan = this.clock; this.scanRisk() }
    if (this.clock - this.lastSample >= 1000) { this.lastSample = this.clock; this.sample() }
  }

  run(steps: number): void {
    for (let i = 0; i < steps; i++) this.step()
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyQuote(): Quote {
  const z: EdgeBreak = { fair: 0, base: 0, inventory: 0, toxicity: 0, latency: 0, gamma: 0, vega: 0, moneyness: 0, dte: 0, final: 0 }
  const s: SizeBreak = { base: 0, relief: 0, limit: 0, confidence: 1, final: 0 }
  return {
    bid: 0, ask: 0, bidSize: 0, askSize: 0, edge: 0, bidState: 'off', askState: 'off',
    bidBreak: z, askBreak: { ...z }, bidSizeBreak: s, askSizeBreak: { ...s }, modelIv: 0,
  }
}

export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))
export const roundTick = (x: number) => Math.round(x / PRICE_TICK) * PRICE_TICK
export const fmt0 = (x: number) => Math.round(x).toLocaleString('en-US')
export function fmtMoney(x: number, dp = 0): string {
  return `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}
export function fmtClock(ms: number): string {
  const base = 9.5 * 3600 * 1000 + ms                 // the simulated session opens at 09:30:00.000
  const h = Math.floor(base / 3_600_000) % 24
  const m = Math.floor(base / 60_000) % 60
  const s = Math.floor(base / 1000) % 60
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(Math.floor(base % 1000)).padStart(3, '0')}`
}
const p2 = (n: number) => String(n).padStart(2, '0')
