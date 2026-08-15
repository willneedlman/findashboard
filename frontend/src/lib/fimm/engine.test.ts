import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, FiEngine, HEDGE_FUTURES, bucketOf, type Config } from './engine'

const make = (patch: Partial<Config> = {}, seed = 4242) =>
  new FiEngine({ ...DEFAULT_CONFIG, ...patch }, seed)

describe('universe', () => {
  it('builds the cash curve and the SOFR packs', () => {
    const e = make()
    const cash = e.nodes.filter(n => n.kind === 'cash')
    const stir = e.nodes.filter(n => n.kind === 'stir')
    expect(cash.map(n => n.label)).toEqual(['3M', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y'])
    expect(stir).toHaveLength(20)
    expect(new Set(stir.map(n => n.group))).toEqual(new Set(['Whites', 'Reds', 'Greens', 'Blues', 'Golds']))
  })

  it('strikes on-the-run coupons near the opening yield, so cash prices near par', () => {
    const e = make()
    for (const nd of e.nodes.filter(n => n.kind === 'cash' && n.years >= 2)) {
      expect(Math.abs(e.modelPrice[nd.id] - 100)).toBeLessThan(2)
    }
  })

  it('buckets by the limits the desk actually sets', () => {
    expect(bucketOf(2)).toBe('front')
    expect(bucketOf(5)).toBe('belly')
    expect(bucketOf(7)).toBe('belly')
    expect(bucketOf(10)).toBe('long')
    expect(bucketOf(30)).toBe('long')
  })
})

describe('curve shape', () => {
  it('produces a rising DV01 profile along the curve', () => {
    const e = make()
    const two = e.nodes.find(n => n.label === '2Y')!
    const ten = e.nodes.find(n => n.label === '10Y')!
    const thirty = e.nodes.find(n => n.label === '30Y')!
    expect(e.dv01(two)).toBeLessThan(e.dv01(ten))
    expect(e.dv01(ten)).toBeLessThan(e.dv01(thirty))
  })

  it('gives every SOFR contract the fixed $25 DV01 its terms specify', () => {
    const e = make()
    for (const nd of e.nodes.filter(n => n.kind === 'stir')) {
      expect(e.dv01(nd)).toBe(25)
    }
  })

  it('moves every node together, because the factors are shared', () => {
    const e = make()
    const before = Float64Array.from(e.modelYield)
    e.run(400)
    const moved = e.nodes.filter(n => Math.abs(e.modelYield[n.id] - before[n.id]) > 1e-6)
    expect(moved.length).toBe(e.nodes.length)
  })
})

describe('quoting', () => {
  it('quotes a two-sided market inside the model on both sides', () => {
    const e = make()
    const ten = e.nodes.find(n => n.label === '10Y')!
    const q = e.quotes[ten.id]
    expect(q.bid).toBeLessThan(q.ask)
    // We buy at a higher yield than model and sell at a lower one. That is the
    // edge, and it is the only reason the desk makes money on a round trip.
    expect(q.bidYield).toBeGreaterThan(q.askYield)
  })

  it('widens with duration, so a 30Y is never quoted as tight as a 2Y', () => {
    const e = make()
    const two = e.nodes.find(n => n.label === '2Y')!
    const thirty = e.nodes.find(n => n.label === '30Y')!
    expect(e.quotes[thirty.id].edgeBp).toBeGreaterThan(e.quotes[two.id].edgeBp)
  })

  it('quotes nothing at all once killed', () => {
    const e = make()
    e.kill()
    expect(e.quotes.every(q => q.bidSize === 0 && q.askSize === 0)).toBe(true)
  })

  it('blocks only the side that would make a breached limit worse', () => {
    const e = make({ dv01Hard: 1_000 })
    const ten = e.nodes.find(n => n.label === '10Y')!
    e.pos[ten.id] = 50                                  // long, so net DV01 is well past the limit
    const r = e.risk()
    expect(r.dv01).toBeGreaterThan(1_000)
    const q = e.computeQuote(ten, r)
    expect(q.bidState).toBe('riskBlocked')
    expect(q.bidSize).toBe(0)
    // The offer stays up: that is the side that flattens the book.
    expect(q.askState).not.toBe('riskBlocked')
    expect(q.askSize).toBeGreaterThan(0)
  })

  it('shades the quote against inventory rather than pulling it', () => {
    const e = make()
    const ten = e.nodes.find(n => n.label === '10Y')!
    const flat = e.computeQuote(ten, e.risk())
    e.pos[ten.id] = 40
    const long = e.computeQuote(ten, e.risk())
    // Long the bond, the desk shades the yield up, which is the price down.
    expect(long.skewBp).toBeGreaterThan(flat.skewBp)
    expect(long.bid).toBeLessThan(flat.bid)
    expect(long.ask).toBeLessThan(flat.ask)
    expect(long.askSize).toBeGreaterThan(0)
  })

  it('offers more size on the side that flattens the book', () => {
    const e = make()
    const ten = e.nodes.find(n => n.label === '10Y')!
    e.pos[ten.id] = 30
    const q = e.computeQuote(ten, e.risk())
    expect(q.askSize).toBeGreaterThan(q.bidSize)
  })

  it('caps a node rather than letting one issue absorb the whole book', () => {
    const e = make({ perNodeCapMM: 30 })
    const ten = e.nodes.find(n => n.label === '10Y')!
    e.pos[ten.id] = 30
    const q = e.computeQuote(ten, e.risk())
    expect(q.bidSize).toBe(0)
  })
})

describe('risk', () => {
  it('reads a long book as positive DV01 and a short as negative', () => {
    const e = make()
    const ten = e.nodes.find(n => n.label === '10Y')!
    e.pos[ten.id] = 10
    expect(e.risk().dv01).toBeGreaterThan(0)
    e.pos[ten.id] = -10
    expect(e.risk().dv01).toBeLessThan(0)
  })

  it('sees a curve tilt that nets to zero outright', () => {
    const e = make()
    const two = e.nodes.find(n => n.label === '2Y')!
    const ten = e.nodes.find(n => n.label === '10Y')!
    // Long the front and short the back in equal DV01: flat outright, and fully
    // exposed to the curve. A headline net DV01 alone would call this no risk.
    const size = 20
    e.pos[two.id] = size
    e.pos[ten.id] = -size * e.dv01(two) / e.dv01(ten)
    const r = e.risk()
    expect(Math.abs(r.dv01)).toBeLessThan(1)
    expect(Math.abs(r.slope2s10s)).toBeGreaterThan(1_000)
  })

  it('splits DV01 into the buckets the limits are set on', () => {
    const e = make()
    e.pos[e.nodes.find(n => n.label === '2Y')!.id] = 10
    e.pos[e.nodes.find(n => n.label === '5Y')!.id] = 10
    e.pos[e.nodes.find(n => n.label === '30Y')!.id] = 10
    const b = e.risk().byBucket
    expect(b.front).toBeGreaterThan(0)
    expect(b.belly).toBeGreaterThan(0)
    expect(b.long).toBeGreaterThan(b.belly)
    expect(b.front + b.belly + b.long).toBeCloseTo(e.risk().dv01, 6)
  })

  it('reads a long belly against the wings as positive butterfly', () => {
    const e = make()
    e.pos[e.nodes.find(n => n.label === '5Y')!.id] = 40
    expect(e.risk().fly2s5s10s).toBeGreaterThan(0)
  })

  it('carries negative when the coupon is below the repo rate', () => {
    const e = make({ repoRate: 0.09 })
    e.pos[e.nodes.find(n => n.label === '10Y')!.id] = 50
    expect(e.risk().carryPerDay).toBeLessThan(0)
  })

  it('carries positive when the book is financed below its coupon', () => {
    const e = make({ repoRate: 0.001 })
    e.pos[e.nodes.find(n => n.label === '10Y')!.id] = 50
    expect(e.risk().carryPerDay).toBeGreaterThan(0)
  })
})

describe('hedging', () => {
  it('proposes nothing while the book is inside the threshold', () => {
    const e = make()
    expect(e.hedgeProposal()).toBeNull()
  })

  it('hedges the bucket carrying the risk, not just any contract', () => {
    const e = make({ autoHedge: false })
    e.pos[e.nodes.find(n => n.label === '30Y')!.id] = 40
    const p = e.hedgeProposal()!
    expect(p).not.toBeNull()
    // Long-end risk wants a long-end contract.
    const f = HEDGE_FUTURES.find(x => x.code === p.code)!
    expect(f.tenor).toBeGreaterThan(10)
    expect(p.lots).toBeLessThan(0)
  })

  it('moves net DV01 toward the target', () => {
    const e = make({ autoHedge: false })
    e.pos[e.nodes.find(n => n.label === '10Y')!.id] = 40
    const before = Math.abs(e.risk().dv01)
    e.executeHedge(true)
    expect(Math.abs(e.risk().dv01)).toBeLessThan(before)
  })

  it('charges slippage for crossing the screen', () => {
    const e = make({ autoHedge: false })
    e.pos[e.nodes.find(n => n.label === '10Y')!.id] = 40
    e.executeHedge(true)
    expect(e.attr.hedge).toBeLessThan(0)
    expect(e.stat.hedgeSlippage).toBeGreaterThan(0)
  })
})

describe('book controls', () => {
  it('flatten leaves no position and no hedge behind', () => {
    const e = make()
    e.run(600)
    e.pos[e.nodes.find(n => n.label === '5Y')!.id] = 25
    e.flatten()
    expect(e.nodes.every(n => e.pos[n.id] === 0)).toBe(true)
    expect(HEDGE_FUTURES.every(f => (e.hedges[f.code] ?? 0) === 0)).toBe(true)
    expect(e.risk().dv01).toBe(0)
  })

  it('stops the desk when net DV01 breaches the hard limit', () => {
    const e = make({ dv01Hard: 500, autoHedge: false })
    e.pos[e.nodes.find(n => n.label === '30Y')!.id] = 60
    e.run(20)
    expect(e.riskStop).toContain('DV01')
  })

  it('stops the desk on a hard loss', () => {
    const e = make({ lossHard: 1, autoHedge: false })
    e.pos[e.nodes.find(n => n.label === '30Y')!.id] = 100
    e.avgYield[e.nodes.find(n => n.label === '30Y')!.id] = 0.001
    e.run(20)
    expect(e.riskStop).not.toBe('')
  })
})

describe('simulation', () => {
  it('is deterministic for a seed', () => {
    const a = make({}, 99)
    const b = make({}, 99)
    a.run(1200)
    b.run(1200)
    expect(a.totalPnl()).toBe(b.totalPnl())
    expect(a.stat.fillsN).toBe(b.stat.fillsN)
    expect(a.factors.level).toBe(b.factors.level)
  })

  it('trades when it is left running', () => {
    const e = make({}, 7)
    e.run(4000)
    expect(e.stat.enquiries).toBeGreaterThan(0)
    expect(e.stat.fillsN).toBeGreaterThan(0)
  })

  it('makes money on the spread across a session', () => {
    const e = make({}, 11)
    e.run(4000)
    expect(e.fills.length).toBeGreaterThan(0)
    expect(e.attr.spread).toBeGreaterThan(0)
    // Most trades earn the edge. A few pay it, which is what shedding risk
    // through your own model costs, and the sign on those has to survive.
    const paid = e.fills.filter(f => f.edgeBp < 0)
    expect(paid.length).toBeLessThan(e.fills.length / 2)
  })

  // The identity the attribution graph rests on. Every dollar the desk has made
  // or lost is spread captured, curve delta on open risk, carry accrued, or the
  // cost of the hedges, and nothing else.
  const attrSum = (e: FiEngine) =>
    e.attr.spread + e.attr.curve + e.attr.convexity + e.attr.carry + e.attr.hedge

  it('accounts for every dollar of P&L in exactly one bucket', () => {
    for (const seed of [21, 77, 512]) {
      const e = make({}, seed)
      e.run(3000)
      expect(Math.abs(attrSum(e) - e.totalPnl())).toBeLessThan(1)
    }
  })

  it('holds the identity across a flatten', () => {
    const e = make({}, 33)
    e.run(2500)
    e.flatten()
    expect(Math.abs(attrSum(e) - e.totalPnl())).toBeLessThan(1)
    // Flat means realised is the whole of it.
    expect(Math.abs(e.totalPnl() - e.realized)).toBeLessThan(1)
  })

  it('does not book a trade edge twice', () => {
    const e = make({ arrivalRate: 0, autoHedge: false }, 9)
    const ten = e.nodes.find(n => n.label === '10Y')!
    const before = e.totalPnl()
    // One trade at the desk's own bid. The edge shows up once, in the open mark.
    e.pos[ten.id] = 10
    e.avgYield[ten.id] = e.quotes[ten.id].bidYield
    const edgeBp = (e.quotes[ten.id].bidYield - e.modelYield[ten.id]) * 10_000
    expect(e.totalPnl() - before).toBeCloseTo(edgeBp * 10 * e.dv01(ten), 6)
  })

  it('accrues carry every step, not only on a trade', () => {
    const e = make({ arrivalRate: 0, autoHedge: false }, 5)
    e.pos[e.nodes.find(n => n.label === '10Y')!.id] = 50
    e.run(500)
    expect(e.attr.carry).not.toBe(0)
  })

  it('samples the session for the attribution graph', () => {
    const e = make({}, 3)
    e.run(2000)
    expect(e.samples.length).toBeGreaterThan(5)
    expect(e.samples[0]).toHaveProperty('dv01')
    expect(e.samples[0].attr).toHaveProperty('carry')
  })
})
