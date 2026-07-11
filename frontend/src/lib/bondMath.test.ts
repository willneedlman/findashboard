import { describe, it, expect } from 'vitest'
import { solveBondYtm } from './bondMath'

describe('solveBondYtm', () => {
  it('yields the coupon exactly when priced at par', () => {
    expect(solveBondYtm(5, 3, 100)).toBe(5)
  })

  it('lifts a low-coupon discount bond to a market yield', () => {
    // 1.05% coupon due <1y, marked at 96.847 -> ~4.3% real yield
    const y = solveBondYtm(1.05, 0.95, 96.847)
    expect(y).not.toBeNull()
    expect(y!).toBeGreaterThan(4)
    expect(y!).toBeLessThan(4.6)
  })

  it('pushes a premium bond below its coupon', () => {
    const y = solveBondYtm(4.8291, 1.54, 100.383)!
    expect(y).toBeLessThan(4.8291)
  })

  it('returns null without a price mark', () => {
    expect(solveBondYtm(4, 2, null)).toBeNull()
    expect(solveBondYtm(4, 2, undefined)).toBeNull()
  })

  it('returns null on missing coupon or tenor', () => {
    expect(solveBondYtm(null, 2, 100)).toBeNull()
    expect(solveBondYtm(4, 0, 100)).toBeNull()
    expect(solveBondYtm(4, null, 100)).toBeNull()
  })
})
