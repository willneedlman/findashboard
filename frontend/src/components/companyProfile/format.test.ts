import { describe, expect, it } from 'vitest'
import {
  DASH, change, compact, count, dividend, multiple, pct, price,
  quoteWithSize, range, ratePct, shortDate, tone,
} from './format'

describe('company profile formatting', () => {
  it('prints money at the magnitude a reader thinks in', () => {
    expect(compact(760_050_000_000)).toBe('760.05B')
    expect(compact(1_240_000_000_000)).toBe('1.24T')
    expect(compact(15_351_151)).toBe('15.35M')
  })

  it('never emits scientific notation', () => {
    for (const v of [1e12, 7.6e11, 9.9e14]) expect(compact(v)).not.toMatch(/e[+-]/i)
  })

  it('groups a volume so its shape is readable', () => {
    expect(count(15_351_151)).toBe('15,351,151')
    expect(count(27_545_658)).toBe('27,545,658')
  })

  it('refuses half a range, which reads as a broken cell', () => {
    expect(range(465.29, 478.75)).toBe('465.29 - 478.75')
    expect(range(465.29, null)).toBe(DASH)
    expect(range(null, 478.75)).toBe(DASH)
  })

  it('reads a quote with its size in shares, not lots', () => {
    // Vendor size is round lots, so a bare 1 would print as one share.
    expect(quoteWithSize(448.89, 1)).toBe('448.89 x 100')
    expect(quoteWithSize(470, 2)).toBe('470.00 x 200')
    expect(quoteWithSize(470, null)).toBe('470.00')
  })

  it('signs a change the way a tape prints it', () => {
    expect(change(-11.09, -2.33)).toBe('-11.09 (-2.33%)')
    expect(change(11.09, 2.33)).toBe('+11.09 (+2.33%)')
  })

  it('names a dividend that does not exist rather than dashing it', () => {
    // The absence is a fact about the company, not a gap in the data.
    expect(dividend(null, null)).toBe('None declared')
    expect(dividend(2.4, 0.51)).toBe('2.40 (0.51%)')
  })

  it('returns a neutral tone for zero and for absent, never a colour', () => {
    expect(tone(0)).toBe('var(--theme-text)')
    expect(tone(null)).toBe('var(--theme-text)')
    expect(tone(1)).toBe('var(--theme-positive)')
    expect(tone(-1)).toBe('var(--theme-negative)')
  })

  it('dashes every absent value rather than printing a zero', () => {
    for (const fn of [compact, price, count, multiple, pct, ratePct]) {
      expect(fn(null)).toBe(DASH)
      expect(fn(undefined)).toBe(DASH)
      expect(fn(NaN)).toBe(DASH)
    }
  })

  it('still prints a real zero', () => {
    expect(price(0)).toBe('0.00')
    expect(count(0)).toBe('0')
  })

  it('converts a rate to a percent and a percent to itself', () => {
    expect(ratePct(0.124)).toBe('12.4%')
    expect(pct(12.4)).toBe('12.4%')
    expect(pct(12.4, 1, true)).toBe('+12.4%')
  })

  it('formats a date, and refuses a junk one', () => {
    expect(shortDate('2026-11-03')).toMatch(/Nov 3, 2026|Nov 2, 2026/)
    expect(shortDate('not a date')).toBe(DASH)
    expect(shortDate(null)).toBe(DASH)
  })
})
