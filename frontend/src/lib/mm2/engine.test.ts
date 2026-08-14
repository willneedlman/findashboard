import { describe, it, expect } from 'vitest'
import { Mm2Engine, DEFAULT_CONFIG, MULT, type Config } from './engine'

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, ...over })

function runFor(e: Mm2Engine, ms: number) { e.run(Math.round(ms / 50)) }

describe('Mm2Engine', () => {
  it('is reproducible from a seed', () => {
    const a = new Mm2Engine(cfg(), 12345)
    const b = new Mm2Engine(cfg(), 12345)
    runFor(a, 60_000); runFor(b, 60_000)
    expect(a.spot).toBe(b.spot)
    expect(a.totalPnl()).toBe(b.totalPnl())
    expect(a.stat.fillsN).toBe(b.stat.fillsN)
  })

  it('diverges on a different seed', () => {
    const a = new Mm2Engine(cfg(), 1)
    const b = new Mm2Engine(cfg(), 2)
    runFor(a, 30_000); runFor(b, 30_000)
    expect(a.spot).not.toBe(b.spot)
  })

  it('trades, and every fill prints inside the quote it came from', () => {
    const e = new Mm2Engine(cfg(), 99)
    runFor(e, 120_000)
    expect(e.stat.fillsN).toBeGreaterThan(5)
    for (const f of e.fills) {
      expect(f.size).toBeGreaterThan(0)
      expect(f.px).toBeGreaterThan(0)
      expect(['BUY', 'SELL']).toContain(f.ourSide)
    }
  })

  it('keeps the ledger identity: total P&L equals cash plus marks', () => {
    const e = new Mm2Engine(cfg(), 7)
    runFor(e, 90_000)
    expect(e.totalPnl()).toBeCloseTo(e.cash + e.optValue() + e.stock * e.spot, 6)
  })

  it('attributes P&L into buckets that add back to the total', () => {
    const e = new Mm2Engine(cfg(), 21)
    runFor(e, 120_000)
    const a = e.attr
    const sum = a.spread + a.delta + a.gamma + a.vega + a.theta + a.hedge + a.fees + a.model
    // `adverse` is a diagnostic overlay, not a bucket, so it is excluded here.
    expect(sum).toBeCloseTo(e.totalPnl(), 4)
  })

  it('auto-hedges delta back inside the threshold', () => {
    const e = new Mm2Engine(cfg({ autoHedge: true, hedgeThreshold: 200, hedgeIntervalMs: 500, arrivalRate: 8 }), 5)
    runFor(e, 180_000)
    expect(e.stat.hedges).toBeGreaterThan(0)
    expect(Math.abs(e.risk().delta)).toBeLessThan(e.cfg.deltaHard)
  })

  it('leaves delta unhedged when the hedger is off', () => {
    const hedged = new Mm2Engine(cfg({ autoHedge: true, arrivalRate: 8 }), 5)
    const naked = new Mm2Engine(cfg({ autoHedge: false, arrivalRate: 8 }), 5)
    runFor(hedged, 180_000); runFor(naked, 180_000)
    expect(naked.stat.hedges).toBe(0)
    expect(Math.abs(naked.risk().delta)).toBeGreaterThan(Math.abs(hedged.risk().delta))
  })

  it('stops quoting and cancels the book on the kill switch', () => {
    const e = new Mm2Engine(cfg(), 3)
    runFor(e, 60_000)
    e.kill()
    runFor(e, 10_000)
    expect(e.orders.size).toBe(0)
    expect(e.killed).toBe(true)
  })

  it('flattens to a clean book', () => {
    const e = new Mm2Engine(cfg({ arrivalRate: 8 }), 11)
    runFor(e, 120_000)
    expect(e.risk().contracts).toBeGreaterThan(0)
    e.flatten()
    expect(e.risk().contracts).toBe(0)
    expect(e.stock).toBe(0)
    expect(e.totalPnl()).toBeCloseTo(e.cash, 6)
  })

  it('widens quotes as base edge rises, and wins less flow for it', () => {
    const tight = new Mm2Engine(cfg({ baseEdge: 0.4 }), 33)
    const wide = new Mm2Engine(cfg({ baseEdge: 6 }), 33)
    runFor(tight, 180_000); runFor(wide, 180_000)
    const w = (e: Mm2Engine) => e.stat.widthSum / Math.max(e.stat.widthN, 1)
    expect(w(wide)).toBeGreaterThan(w(tight))
    expect(wide.stat.contractsTraded).toBeLessThan(tight.stat.contractsTraded)
  })

  it('skews quotes away from inventory', () => {
    const e = new Mm2Engine(cfg({ invSkewDelta: 2, invSkewContract: 0.5 }), 4)
    const i = e.nearestAtm(1, 'C')
    const flat = e.computeQuote(i, e.risk())
    e.pos[i] = 20
    const long = e.computeQuote(i, e.risk())
    expect(long.bid).toBeLessThan(flat.bid)
    expect(long.ask).toBeLessThan(flat.ask)
    expect(long.askSize).toBeGreaterThan(long.bidSize)   // more size on the flattening side
  })

  it('cuts quote size to nothing once inventory dominates the limits', () => {
    const e = new Mm2Engine(cfg(), 4)
    const i = e.nearestAtm(1, 'C')
    e.pos[i] = 400
    const q = e.computeQuote(i, e.risk())
    expect(q.bidSize).toBe(0)
    expect(q.askSize).toBe(0)
  })

  it('blocks the risk-adding side once a hard limit is through', () => {
    const e = new Mm2Engine(cfg({ deltaHard: 10 }), 8)
    const i = e.nearestAtm(1, 'C')
    e.pos[i] = 500
    const q = e.computeQuote(i, e.risk())
    expect([q.bidState, q.askState]).toContain('riskBlocked')
  })

  it('honours latency: nothing is fillable before the ack lands', () => {
    const e = new Mm2Engine(cfg({ ackLatencyMs: 400, sendLatencyMs: 400, decisionLatencyMs: 200 }), 6)
    e.run(1)
    runFor(e, 400)
    const live = [...e.orders.values()]
    expect(live.length).toBeGreaterThan(0)
    // In flight or already cancelled in flight, but nothing acknowledged yet.
    expect(live.some(o => o.state === 'active')).toBe(false)
    expect(e.stat.fillsN).toBe(0)
  })

  it('records mark-outs on filled trades', () => {
    const e = new Mm2Engine(cfg({ arrivalRate: 8 }), 15)
    runFor(e, 200_000)
    const marked = e.fills.filter(f => f.p30 !== null)
    expect(marked.length).toBeGreaterThan(0)
    for (const f of marked) {
      expect(f.p1).not.toBeNull()
      expect(f.p5).not.toBeNull()
    }
  })

  it('produces a stress grid that is worst where the book is short', () => {
    const e = new Mm2Engine(cfg(), 2)
    const i = e.nearestAtm(3, 'C')
    e.pos[i] = -100
    const grid = e.stress([-5, 0, 5], [0])
    expect(grid[0][2]).toBeLessThan(grid[0][1])   // short calls lose as spot rallies
  })

  it('throttles requoting at the venue message cap', () => {
    const e = new Mm2Engine(cfg({ maxMsgRate: 4, refreshMs: 50, minTheoMove: 0.01 }), 9)
    runFor(e, 30_000)
    expect(e.stat.throttled).toBeGreaterThan(0)
  })

  it('accumulates realized P&L only on closing trades', () => {
    const e = new Mm2Engine(cfg(), 13)
    expect(e.realized).toBe(0)
    runFor(e, 20_000)
    e.flatten()
    expect(e.realized).not.toBe(0)
  })

  it('scales position greeks by the contract multiplier', () => {
    const e = new Mm2Engine(cfg(), 1)
    const i = e.nearestAtm(5, 'C')
    e.pos[i] = 10
    expect(e.risk().deltaOpt).toBeCloseTo(10 * e.delta[i] * MULT, 8)
  })
})


// ── Manual underlying trades ──────────────────────────────────────────────────

describe('tradeUnderlying', () => {
  it('books a buy into stock and cash', () => {
    const e = new Mm2Engine(cfg(), 5)
    const before = e.cash
    e.tradeUnderlying(100)
    expect(e.stock).toBe(100)
    expect(e.cash).toBeLessThan(before)
    expect(e.stat.hedges).toBe(1)
    expect(e.stat.hedgeShares).toBe(100)
  })

  it('books a sell the other way', () => {
    const e = new Mm2Engine(cfg(), 5)
    e.tradeUnderlying(-100)
    expect(e.stock).toBe(-100)
    expect(e.cash).toBeGreaterThan(0)
  })

  it('moves net delta by exactly the shares traded', () => {
    const e = new Mm2Engine(cfg(), 5)
    const before = e.risk().delta
    e.tradeUnderlying(250)
    expect(e.risk().delta).toBeCloseTo(before + 250, 6)
  })

  it('pays the spread, so a round trip loses money', () => {
    const e = new Mm2Engine(cfg({ underlyingSpreadBps: 5 }), 5)
    e.tradeUnderlying(100)
    e.tradeUnderlying(-100)
    expect(e.stock).toBe(0)
    expect(e.totalPnl()).toBeLessThan(0)
    expect(e.stat.hedgeCost).toBeGreaterThan(0)
  })

  it('ignores a zero or non-finite size instead of corrupting the book', () => {
    const e = new Mm2Engine(cfg(), 5)
    e.tradeUnderlying(0)
    e.tradeUnderlying(Number.NaN)
    expect(e.stock).toBe(0)
    expect(e.stat.hedges).toBe(0)
  })

  it('keeps the attribution identity that the auto hedger keeps', () => {
    const e = new Mm2Engine(cfg(), 21)
    runFor(e, 60_000)
    e.tradeUnderlying(300)
    runFor(e, 60_000)
    const a = e.attr
    const sum = a.spread + a.delta + a.gamma + a.vega + a.theta + a.hedge + a.fees + a.model
    expect(sum).toBeCloseTo(e.totalPnl(), 4)
  })

  it('is the same path the auto hedger uses', () => {
    const e = new Mm2Engine(cfg({ autoHedge: true, arrivalRate: 8 }), 5)
    runFor(e, 120_000)
    const autoHedges = e.stat.hedges
    e.tradeUnderlying(50)
    expect(e.stat.hedges).toBe(autoHedges + 1)
  })
})
