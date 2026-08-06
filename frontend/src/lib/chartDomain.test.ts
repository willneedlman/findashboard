import { describe, it, expect } from 'vitest'
import { snapToLadder, stableValueDomain } from './chartDomain'

describe('snapToLadder', () => {
  it('rounds up to the next rung', () => {
    expect(snapToLadder(0.1)).toBe(0.5)
    expect(snapToLadder(0.6)).toBe(0.75)
    expect(snapToLadder(1.2)).toBe(1.5)
    expect(snapToLadder(18)).toBe(20)
  })

  it('is monotonic', () => {
    let prev = 0
    for (const pct of [0.1, 0.3, 0.9, 2.2, 6, 12, 27, 88, 140]) {
      const rung = snapToLadder(pct)
      expect(rung).toBeGreaterThanOrEqual(prev)
      prev = rung
    }
  })

  it('extends past the top rung by whole multiples', () => {
    expect(snapToLadder(900)).toBe(1000)
  })

  it('degrades safely on nonsense input', () => {
    expect(snapToLadder(0)).toBe(0.5)
    expect(snapToLadder(-4)).toBe(0.5)
    expect(snapToLadder(NaN)).toBe(0.5)
  })
})

describe('stableValueDomain', () => {
  // The reported bug: a ~$20 move on a ~$19k book redrew as a full-height swing
  // because the axis re-fitted every poll.
  const BASELINE = 18_890

  it('does not move for a tick that lands inside the band', () => {
    const before = stableValueDomain([18_900, 18_950], BASELINE)
    const after = stableValueDomain([18_900, 18_950, 18_954], BASELINE)
    expect(after).toEqual(before)
  })

  it('holds the axis still across a realistic tick sequence', () => {
    // The property that matters: a live session produces very few distinct
    // domains, not a new one every poll.
    let series = [18_900]
    const seen = new Set<string>()
    for (const tick of [18_912, 18_930, 18_948, 18_955, 18_961, 18_944,
                        18_939, 18_970, 18_958, 18_949, 18_933, 18_921]) {
      series = [...series, tick]
      seen.add(JSON.stringify(stableValueDomain(series, BASELINE)))
    }
    expect(seen.size).toBeLessThanOrEqual(2)
  })

  it('never moves while the new value stays inside the existing band', () => {
    let series = [18_900, 18_950]
    let domain = stableValueDomain(series, BASELINE)
    for (const tick of [18_930, 18_910, 18_945, 18_905]) {
      const [min, max] = domain
      // Comfortably inside, so the axis has no reason to change.
      expect(tick).toBeGreaterThan(min)
      expect(tick).toBeLessThan(max)
      series = [...series, tick]
      const next = stableValueDomain(series, BASELINE)
      expect(next).toEqual(domain)
      domain = next
    }
  })

  it('does expand once the data genuinely breaks out', () => {
    const before = stableValueDomain([18_900, 18_950], BASELINE)
    const after = stableValueDomain([18_900, 18_950, 25_000], BASELINE)
    expect(after[1]).toBeGreaterThan(before[1])
  })

  it('always contains every value and the baseline', () => {
    const values = [100, 140, 90]
    const [min, max] = stableValueDomain(values, 200)
    expect(min).toBeLessThanOrEqual(90)
    expect(max).toBeGreaterThanOrEqual(200)
  })

  it('does not waste half the plot on a one-directional move', () => {
    // Up 18% with no drawdown: the downside band must stay tight, not mirror 18%.
    const [min, max] = stableValueDomain([100, 118], 100)
    expect(min).toBeGreaterThan(97)
    expect(max).toBeGreaterThanOrEqual(118)
  })

  it('gives a flat book a readable band instead of a zero-height axis', () => {
    const [min, max] = stableValueDomain([5000, 5000, 5000], 5000)
    expect(max).toBeGreaterThan(min)
    expect(min).toBeLessThanOrEqual(5000)
    expect(max).toBeGreaterThanOrEqual(5000)
  })

  it('handles a single point', () => {
    const [min, max] = stableValueDomain([1234.56], null)
    expect(max).toBeGreaterThan(min)
    expect(min).toBeLessThanOrEqual(1234.56)
    expect(max).toBeGreaterThanOrEqual(1234.56)
  })

  it('falls back sanely with no usable data', () => {
    expect(stableValueDomain([], null)).toEqual([0, 1])
    expect(stableValueDomain([NaN], null)).toEqual([0, 1])
    const [min, max] = stableValueDomain([], 1000)
    expect(min).toBeLessThan(1000)
    expect(max).toBeGreaterThan(1000)
  })

  it('ignores a non-finite baseline and anchors on the data', () => {
    const [min, max] = stableValueDomain([100, 110], NaN)
    expect(min).toBeLessThanOrEqual(100)
    expect(max).toBeGreaterThanOrEqual(110)
  })
})
