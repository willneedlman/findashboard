import { describe, expect, it } from 'vitest'
import {
  convexity, convexityPerMM, dv01PerMM, flyBps, fmt32, fmt32Eighths, modifiedDuration,
  nsYield, priceFromYield, roundTo32nd, slopeBps, yieldFromPrice, type CurveFactors,
} from './bondmath'

describe('priceFromYield', () => {
  it('prices at par when the coupon equals the yield', () => {
    expect(priceFromYield(0.04, 0.04, 10)).toBeCloseTo(100, 6)
    expect(priceFromYield(0.0625, 0.0625, 2)).toBeCloseTo(100, 6)
  })

  it('discounts when the yield is above the coupon', () => {
    expect(priceFromYield(0.04, 0.05, 10)).toBeLessThan(100)
    expect(priceFromYield(0.04, 0.03, 10)).toBeGreaterThan(100)
  })

  it('is more sensitive the longer the bond', () => {
    const short = 100 - priceFromYield(0.04, 0.05, 2)
    const long = 100 - priceFromYield(0.04, 0.05, 30)
    expect(long).toBeGreaterThan(short * 3)
  })
})

describe('yieldFromPrice', () => {
  it('inverts priceFromYield', () => {
    for (const [c, y, t] of [[0.04, 0.045, 10], [0.0625, 0.031, 2], [0.0125, 0.049, 30]]) {
      const p = priceFromYield(c, y, t)
      expect(yieldFromPrice(c, p, t)).toBeCloseTo(y, 8)
    }
  })

  it('stays bracketed on a deeply discounted long bond', () => {
    // A 1.25% 30Y at 45 is a real security in a high-rate world, and it is the
    // shape that sends an unbracketed Newton solve negative.
    const y = yieldFromPrice(0.0125, 45, 30)
    expect(y).toBeGreaterThan(0)
    expect(y).toBeLessThan(0.20)
    expect(priceFromYield(0.0125, y, 30)).toBeCloseTo(45, 6)
  })
})

describe('risk measures', () => {
  it('gives a 10Y roughly eight years of modified duration', () => {
    const d = modifiedDuration(0.04, 0.0425, 10)
    expect(d).toBeGreaterThan(7)
    expect(d).toBeLessThan(9)
  })

  it('scales DV01 with maturity the way the desk buckets do', () => {
    const two = dv01PerMM(0.04625, 0.04621, 2)
    const ten = dv01PerMM(0.04, 0.0425, 10)
    const thirty = dv01PerMM(0.0425, 0.04452, 30)
    expect(two).toBeGreaterThan(150)
    expect(two).toBeLessThan(250)
    expect(ten).toBeGreaterThan(700)
    expect(thirty).toBeGreaterThan(ten * 1.8)
  })

  it('reports DV01 positive, so a long book reads long', () => {
    expect(dv01PerMM(0.04, 0.0425, 10)).toBeGreaterThan(0)
  })

  it('gives a long bond more convexity than a short one', () => {
    expect(convexity(0.0425, 0.0445, 30)).toBeGreaterThan(convexity(0.04625, 0.0462, 2))
    expect(convexityPerMM(0.0425, 0.0445, 30)).toBeGreaterThan(0)
  })
})

describe('32nds formatting', () => {
  it('writes halves with a plus', () => {
    expect(fmt32(98.5)).toBe('98-16')
    expect(fmt32(98 + 16.5 / 32)).toBe('98-16+')
    expect(fmt32(99 + 28 / 32)).toBe('99-28')
  })

  it('pads the 32nds to two digits', () => {
    expect(fmt32(100 + 4 / 32)).toBe('100-04')
    expect(fmt32(96)).toBe('96-00')
  })

  it('rolls a full point rather than printing 32', () => {
    expect(fmt32(98.9999)).toBe('99-00')
    expect(fmt32Eighths(98.9999)).toBe('99-000')
  })

  it('writes the street format in eighths of a 32nd', () => {
    expect(fmt32Eighths(99 + 28 / 32)).toBe('99-280')
    expect(fmt32Eighths(99 + 28 / 32 + 4 / 256)).toBe('99-284')
  })

  it('keeps the sign on a negative spread price', () => {
    expect(fmt32(-1.5)).toBe('-1-16')
  })

  it('rounds to the desk increment', () => {
    expect(roundTo32nd(98.51)).toBeCloseTo(98 + 33 / 64, 10)
  })
})

describe('curve', () => {
  const f: CurveFactors = { level: 0.045, slope: -0.005, curvature: 0.01, tau: 2.5 }

  it('converges on the level at the long end', () => {
    expect(nsYield(f, 100)).toBeCloseTo(f.level, 3)
  })

  it('meets level plus slope at the short end', () => {
    expect(nsYield(f, 1 / 365)).toBeCloseTo(f.level + f.slope, 3)
  })

  it('survives a zero tenor without dividing by zero', () => {
    expect(Number.isFinite(nsYield(f, 0))).toBe(true)
  })

  it('reports an inverted front as a negative 2s10s', () => {
    const inverted: CurveFactors = { ...f, slope: 0.008 }
    expect(slopeBps(inverted, 2, 10)).toBeLessThan(0)
    expect(slopeBps({ ...f, slope: -0.012 }, 2, 10)).toBeGreaterThan(0)
  })

  it('reads curvature in the butterfly', () => {
    const humped: CurveFactors = { ...f, curvature: 0.03 }
    const flat: CurveFactors = { ...f, curvature: 0 }
    expect(flyBps(humped, 2, 5, 10)).toBeGreaterThan(flyBps(flat, 2, 5, 10))
  })
})

describe('front of the curve', () => {
  it('gives a 3-month bill about a quarter-year of DV01, not half', () => {
    // Rounding up to one whole semi-annual coupon priced a 3M as a 6M and
    // doubled its DV01, which is a real position-sizing error on the front.
    const dv = dv01PerMM(0.03875, 0.0382, 0.25)
    expect(dv).toBeGreaterThan(18)
    expect(dv).toBeLessThan(32)
  })

  it('keeps a 6-month at roughly twice a 3-month', () => {
    const three = dv01PerMM(0.04, 0.04, 0.25)
    const six = dv01PerMM(0.04, 0.04, 0.5)
    expect(six / three).toBeGreaterThan(1.7)
    expect(six / three).toBeLessThan(2.3)
  })

  it('still prices a whole-period bond at par on coupon equals yield', () => {
    expect(priceFromYield(0.04, 0.04, 0.5)).toBeCloseTo(100, 6)
  })
})
