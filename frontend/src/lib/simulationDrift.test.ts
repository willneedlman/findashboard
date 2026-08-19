import { describe, it, expect } from 'vitest'
import { simulationDrift } from './simulationDrift'

// Every expected figure here was produced by running the reference
// implementation, `_simulation_drift` in backend/routers/portfolio.py, with the
// risk-free rate pinned to 4%. Two surfaces simulate the same book and they are
// only one model if they agree to the decimal, so this file is the contract
// between them rather than a description of the port.

describe('simulationDrift matches the backend engine', () => {
  const CASES = [
    { sample: 150.0, obs: 756, used: 25.00, capped: true },
    { sample: 150.0, obs: 2520, used: 25.00, capped: true },
    { sample: 80.0, obs: 252, used: 18.50, capped: false },
    { sample: 80.0, obs: 5040, used: 25.00, capped: true },
    { sample: 8.0, obs: 2520, used: 8.33, capped: false },
    { sample: 30.0, obs: 756, used: 16.44, capped: false },
    { sample: -20.0, obs: 756, used: -2.94, capped: false },
    { sample: 12.0, obs: 1260, used: 10.49, capped: false },
  ]

  for (const c of CASES) {
    it(`${c.sample}% over ${c.obs} days becomes ${c.used}%`, () => {
      const out = simulationDrift(c.sample, c.obs)
      expect(out.usedAnnualPct).toBeCloseTo(c.used, 2)
      expect(out.capped).toBe(c.capped)
    })
  }

  it('keeps the estimator in historical mode but not the cap', () => {
    const out = simulationDrift(150, 756, { mode: 'historical' })
    expect(out.usedAnnualPct).toBeCloseTo(25.0, 2)
    expect(out.capped).toBe(true)
  })

  it('ignores the sample entirely at the risk-free rate', () => {
    expect(simulationDrift(150, 756, { mode: 'risk_free' }).usedAnnualPct).toBeCloseTo(4.0, 2)
  })
})

describe('what the shrinkage is for', () => {
  it('a spectacular run is not projected forward', () => {
    // The screenshot that started this: a book up about 150% a year, projected
    // faithfully for three years into a 5th percentile of +260%.
    expect(simulationDrift(150, 756).usedAnnualPct).toBeLessThanOrEqual(25)
  })

  it('a short sample leans on the prior', () => {
    const short = simulationDrift(80, 252).usedAnnualPct
    const long = simulationDrift(80, 252 * 20).usedAnnualPct
    expect(short).toBeLessThan(long)
  })

  it('a believable number survives roughly intact', () => {
    const out = simulationDrift(8, 252 * 10).usedAnnualPct
    expect(out).toBeGreaterThan(6)
    expect(out).toBeLessThan(10)
  })

  it('a losing book is pulled up toward the prior, not left at its loss', () => {
    // Shrinkage is symmetric. A bad three years is as poor an estimate of the
    // future as a good one, and the prior is where both are pulled.
    const out = simulationDrift(-20, 756)
    expect(out.usedAnnualPct).toBeGreaterThan(-20)
    expect(out.usedAnnualPct).toBeLessThan(0)
  })

  it('reports the sample it was given so the page can show both', () => {
    const out = simulationDrift(150, 756)
    expect(out.sampleAnnualPct).toBe(150)
    expect(out.usedAnnualPct).not.toBeCloseTo(150, 0)
  })
})
