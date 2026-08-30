import { describe, expect, it } from 'vitest'
import { formatValue } from './CompanyFinancials'

describe('financial statement formatting', () => {
  it('renders money at the magnitude a reader thinks in', () => {
    expect(formatValue(416_161_000_000, '$')).toBe('416.16B')
    expect(formatValue(1_240_000_000_000, '$')).toBe('1.24T')
    expect(formatValue(42_900_000, '$')).toBe('42.9M')
  })

  it('never emits scientific notation', () => {
    for (const v of [1e12, 4.16e11, 9.9e14, 1e6]) {
      expect(formatValue(v, '$')).not.toMatch(/e[+-]/i)
    }
  })

  it('keeps a negative sign, which a cash flow statement needs', () => {
    expect(formatValue(-12_700_000_000, '$')).toBe('-12.70B')
  })

  it('renders a missing line as a gap, never as zero', () => {
    // A zero here would state a fact the filing does not.
    expect(formatValue(null, '$')).toBe('–')
    expect(formatValue(undefined, '$')).toBe('–')
    expect(formatValue(NaN, '$')).toBe('–')
    expect(formatValue('', '$')).toBe('–')
  })

  it('still renders a real zero', () => {
    expect(formatValue(0, '$')).toBe('0')
  })

  it('formats per-share, share counts, multiples and rates by unit', () => {
    expect(formatValue(6.25, '$/sh')).toBe('6.25')
    expect(formatValue(15_400_000_000, 'sh')).toBe('15.40B')
    expect(formatValue(32.5, 'x')).toBe('32.5x')
    expect(formatValue(0.031, '%')).toBe('3.1%')
  })
})
