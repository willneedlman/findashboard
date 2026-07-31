import { describe, expect, it } from 'vitest'
import { formatHorizontalCategoryLabel, horizontalCategoryAxisWidth } from './chartLabels'

describe('horizontal chart category labels', () => {
  it('keeps the sector and ticker as deterministic label parts', () => {
    expect(formatHorizontalCategoryLabel('Consumer Staples · XLP')).toEqual({
      primary: 'Consumer Staples',
      secondary: 'XLP',
    })
  })

  it('normalizes ticker-first labels to the same hierarchy', () => {
    expect(formatHorizontalCategoryLabel('XLRE · Real Estate')).toEqual({
      primary: 'Real Estate',
      secondary: 'XLRE',
    })
  })

  it('preserves the ticker while constraining unusually long category names', () => {
    expect(formatHorizontalCategoryLabel('Communication Services and Media · XLC', 18)).toEqual({
      primary: 'Communication Ser…',
      secondary: 'XLC',
    })
  })

  it('provides a visible fallback for empty labels', () => {
    expect(formatHorizontalCategoryLabel('')).toEqual({ primary: '—' })
  })

  it('reserves label padding so the longest sector is not clipped', () => {
    const denseWidth = horizontalCategoryAxisWidth([
      'Energy · XLE',
      'Communication Services · XLC',
      'Consumer Staples · XLP',
      'Consumer Discretionary · XLY',
      'Health Care · XLV',
    ], true)
    expect(denseWidth).toBeGreaterThanOrEqual(112)
    expect(denseWidth).toBeLessThanOrEqual(168)
    expect(horizontalCategoryAxisWidth([
      'Communication Services and Media · XLC',
    ], false)).toBeLessThanOrEqual(164)
  })

  it('keeps common report metric labels complete in print', () => {
    expect(formatHorizontalCategoryLabel('Annual Volatility', 26).primary).toBe('Annual Volatility')
    expect(formatHorizontalCategoryLabel('Systematic Variance Share', 26).primary).toBe('Systematic Variance Share')
  })
})
