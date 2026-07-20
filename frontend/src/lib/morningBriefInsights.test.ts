import { describe, expect, it } from 'vitest'
import { buildBookInsights, type BriefPosition } from './morningBriefInsights'

function pos(partial: Partial<BriefPosition> & { ticker: string }): BriefPosition {
  return {
    shares: 10,
    value: 1000,
    cost: 900,
    pnl: 100,
    pnlPct: 0.11,
    dayPnl: 10,
    pct1d: 1,
    price: 100,
    ...partial,
  }
}

describe('buildBookInsights', () => {
  it('attributes day P&L and flags concentration', () => {
    const positions = [
      pos({ ticker: 'NFLX', value: 5000, dayPnl: -80, pct1d: -1.6, shares: 20, price: 250, cost: 4000, pnl: 1000, pnlPct: 0.25 }),
      pos({ ticker: 'RVI', value: 2000, dayPnl: 20, pct1d: 1, shares: 50, price: 40, cost: 1800, pnl: 200, pnlPct: 0.11 }),
      pos({ ticker: 'NBIS', value: 1000, dayPnl: 5, pct1d: 0.5, shares: 10, price: 100, cost: 1100, pnl: -100, pnlPct: -0.09 }),
    ]
    const ins = buildBookInsights(positions, 500, 0.2)
    expect(ins.dayAttribution[0].ticker).toBe('NFLX')
    expect(ins.dayAttribution[0].impactShare).toBeGreaterThan(0.5)
    expect(ins.concentration[0].ticker).toBe('NFLX')
    expect(ins.vsSpy?.alphaPct).toBeDefined()
    // Plain-language headline — not a jammed % dump
    expect(ins.headline.toLowerCase()).toMatch(/nflx|down|up|ahead|lag|quiet|higher|lower/)
    expect(ins.headline).not.toMatch(/\bpp\b/)
    expect(ins.takeaways.length).toBeGreaterThan(0)
  })

  it('lists underwater names by dollar loss', () => {
    const positions = [
      pos({ ticker: 'BAD', value: 500, cost: 1000, pnl: -500, pnlPct: -0.5, price: 50, shares: 10, dayPnl: 0, pct1d: 0 }),
      pos({ ticker: 'OK', value: 1000, cost: 800, pnl: 200, pnlPct: 0.25, price: 100, shares: 10, dayPnl: 0, pct1d: 0 }),
    ]
    const ins = buildBookInsights(positions, 0, null)
    expect(ins.underwater[0].ticker).toBe('BAD')
    expect(ins.underwater[0].recoveryPct).toBeGreaterThan(0)
  })

  it('empty book has explicit headline', () => {
    const ins = buildBookInsights([], 0, 0)
    expect(ins.headline.toLowerCase()).toMatch(/no position/)
  })

  it('writes a readable relative-performance headline', () => {
    // Spread day P&L so no single name hits the 40% impact threshold.
    const positions = [
      pos({ ticker: 'A', value: 1000, dayPnl: -3, pct1d: -0.3 }),
      pos({ ticker: 'B', value: 1000, dayPnl: -3, pct1d: -0.3 }),
      pos({ ticker: 'C', value: 1000, dayPnl: -4, pct1d: -0.4 }),
    ]
    // book soft vs spy -0.99% → ahead of market while down
    const ins = buildBookInsights(positions, 0, -0.99)
    expect(ins.headline).toMatch(/Down on the day, but still ahead of SPY/i)
    expect(ins.headline).not.toMatch(/\(|pp|%/)
  })
})
