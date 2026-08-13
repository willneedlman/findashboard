import { describe, it, expect } from 'vitest'
import { bsGreeks, bsPrice, impliedVol, surfaceIv, surfaceMetrics, makeRng } from './pricing'

const S = 100, K = 100, T = 0.5, R = 0.03, Q = 0.01, V = 0.25

describe('bsGreeks', () => {
  it('satisfies put-call parity', () => {
    const c = bsGreeks(S, K, T, R, Q, V, 'C').theo
    const p = bsGreeks(S, K, T, R, Q, V, 'P').theo
    expect(c - p).toBeCloseTo(S * Math.exp(-Q * T) - K * Math.exp(-R * T), 8)
  })

  it('matches a finite-difference delta, gamma, vega and theta', () => {
    const g = bsGreeks(S, K, T, R, Q, V, 'C')
    // Differencing the price re-differentiates the CDF approximation's own error
    // term, which S/(sigma*sqrt(T)) amplifies to ~1e-5 — a floor on the FD check
    // that no step size removes, so delta is only asserted to 1e-4.
    const h = 1e-2
    const fdDelta = (bsPrice(S + h, K, T, R, Q, V, 'C') - bsPrice(S - h, K, T, R, Q, V, 'C')) / (2 * h)
    const fdGamma = (bsPrice(S + h, K, T, R, Q, V, 'C') - 2 * bsPrice(S, K, T, R, Q, V, 'C') + bsPrice(S - h, K, T, R, Q, V, 'C')) / (h * h)
    const fdVega = (bsPrice(S, K, T, R, Q, V + h, 'C') - bsPrice(S, K, T, R, Q, V - h, 'C')) / (2 * h)
    const fdTheta = -(bsPrice(S, K, T + h, R, Q, V, 'C') - bsPrice(S, K, T - h, R, Q, V, 'C')) / (2 * h)
    expect(g.delta).toBeCloseTo(fdDelta, 4)
    expect(g.gamma).toBeCloseTo(fdGamma, 4)
    expect(g.vega).toBeCloseTo(fdVega, 3)
    expect(g.theta).toBeCloseTo(fdTheta, 3)
  })

  it('matches finite-difference vanna and volga', () => {
    const g = bsGreeks(S, 110, T, R, Q, V, 'C')
    const h = 1e-3
    const dUp = bsGreeks(S, 110, T, R, Q, V + h, 'C')
    const dDn = bsGreeks(S, 110, T, R, Q, V - h, 'C')
    expect(g.vanna).toBeCloseTo((dUp.delta - dDn.delta) / (2 * h), 3)
    expect(g.volga).toBeCloseTo((dUp.vega - dDn.vega) / (2 * h), 2)
  })

  it('collapses to intrinsic at expiry', () => {
    expect(bsGreeks(110, 100, 0, R, Q, V, 'C').theo).toBe(10)
    expect(bsGreeks(110, 100, 0, R, Q, V, 'P').theo).toBe(0)
    expect(bsGreeks(110, 100, 0, R, Q, V, 'C').gamma).toBe(0)
  })
})

describe('impliedVol', () => {
  it('round-trips a price back to its vol', () => {
    for (const strike of [80, 100, 130]) {
      for (const vol of [0.1, 0.25, 0.8]) {
        const px = bsPrice(S, strike, T, R, Q, vol, 'C')
        expect(impliedVol(px, S, strike, T, R, Q, 'C')).toBeCloseTo(vol, 5)
      }
    }
  })

  it('returns zero when the price is at or below intrinsic', () => {
    expect(impliedVol(0.0001, S, 50, T, R, Q, 'C')).toBe(0)
  })
})

describe('surfaceIv', () => {
  const p = { atmVol: 0.2, putSkew: 0.4, callSkew: -0.1, termSlope: 0.05, curvature: 0.2, noise: 0 }

  it('prices downside above the money and keeps the call wing lower', () => {
    const down = surfaceIv(p, 100, 85, 0.25, R, Q)
    const atm = surfaceIv(p, 100, 100, 0.25, R, Q)
    const up = surfaceIv(p, 100, 115, 0.25, R, Q)
    expect(down).toBeGreaterThan(atm)
    expect(up).toBeLessThan(down)
  })

  it('keeps the skew steeper in the front expiry than the back', () => {
    const frontSlope = surfaceIv(p, 100, 90, 1 / 365, R, Q) - surfaceIv(p, 100, 100, 1 / 365, R, Q)
    const backSlope = surfaceIv(p, 100, 90, 1, R, Q) - surfaceIv(p, 100, 100, 1, R, Q)
    expect(frontSlope).toBeGreaterThan(backSlope)
  })

  it('never returns a non-positive vol', () => {
    const flat = { ...p, atmVol: 0.05, putSkew: -5, callSkew: -5, curvature: -5 }
    expect(surfaceIv(flat, 100, 200, 0.5, R, Q)).toBeGreaterThan(0)
  })

  it('reports a negative risk reversal for a put-skewed surface', () => {
    const m = surfaceMetrics(p, 100, 0.25, R, Q)
    expect(m.rr).toBeLessThan(0)
    expect(m.atm).toBeCloseTo(surfaceIv(p, 100, 100 * Math.exp((R - Q) * 0.25), 0.25, R, Q), 8)
  })
})

describe('makeRng', () => {
  it('is deterministic per seed and different across seeds', () => {
    const a = makeRng(42), b = makeRng(42), c = makeRng(43)
    const draw = (r: () => number) => Array.from({ length: 5 }, r)
    expect(draw(a)).toEqual(draw(b))
    expect(draw(makeRng(42))).not.toEqual(draw(c))
  })

  it('stays inside the unit interval', () => {
    const r = makeRng(7)
    for (let i = 0; i < 5000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
