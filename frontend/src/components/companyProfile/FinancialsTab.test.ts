import { describe, expect, it } from 'vitest'
import { barHeights } from './FinancialsTab'

// Reported on NVDA: the 401M bar rendered taller than the 4.89B bar beside it.
// A bar that contradicts the number printed above it is worse than no chart.
describe('trend bar geometry', () => {
  const VALUES = [3.65e9, 1.26e9, 4.01e8, 1.9e9, 4.89e9]

  it('scales every bar to the largest value in its own row', () => {
    const h = barHeights(VALUES)
    expect(Math.max(...h)).toBe(h[4])          // 4.89B is the tallest
    expect(Math.min(...h)).toBe(h[2])          // 401M is the shortest
  })

  it('orders bar heights the same way the values order', () => {
    const h = barHeights(VALUES)
    const byValue = [...VALUES.keys()].sort((a, b) => VALUES[a] - VALUES[b])
    const byHeight = [...h.keys()].sort((a, b) => h[a] - h[b])
    expect(byHeight).toEqual(byValue)
  })

  it('keeps the tallest bar at the cap and nothing above it', () => {
    const h = barHeights(VALUES, 68)
    expect(h[4]).toBeCloseTo(68, 6)
    expect(Math.max(...h)).toBeLessThanOrEqual(68)
  })

  it('gives an absent period the floor, not a full-height bar', () => {
    const h = barHeights([1e9, null, 2e9])
    expect(h[1]).toBe(3)
  })

  it('survives a row with no usable values at all', () => {
    expect(barHeights([null, null])).toEqual([3, 3])
    expect(barHeights([NaN, Infinity] as unknown as (number | null)[])).toEqual([3, 3])
  })

  it('scales a series that crosses zero by absolute size', () => {
    // A capex row is all negative; a swing row has both signs.
    const h = barHeights([-4e9, 1e9, -2e9])
    expect(Math.max(...h)).toBe(h[0])
  })

  it('never returns a zero-height bar for a real number', () => {
    const h = barHeights([1e12, 1])
    expect(h[1]).toBeGreaterThanOrEqual(3)
  })
})
