import { describe, expect, it } from 'vitest'
import { compactMagnitude, formatReportCell } from './reportFigures'

/**
 * From a delivered report (AI Momentum Trade, 16 Aug 2026). The segment table
 * printed "162361000000.00" in its VALUE column and filled its YoY column with
 * em dashes, which is what made the page read as broken.
 */
describe('report cell formatting', () => {
  it('compacts a magnitude instead of printing every digit', () => {
    expect(formatReportCell(162361000000, 'Value')).toBe('162.4B')
    expect(formatReportCell(31376000000, 'Value')).toBe('31.4B')
    expect(formatReportCell(619000000, 'Value')).toBe('619M')
  })

  it('keeps a currency marker when the source had one', () => {
    expect(formatReportCell('$4200000000', 'Market cap')).toBe('$4.2B')
  })

  it('leaves measurements that are meant to read literally', () => {
    expect(formatReportCell(75.2, 'Share %')).toBe('75.2')
    expect(formatReportCell('27.1%', 'Implied volatility')).toBe('27.1%')
    expect(formatReportCell(1.42, 'Sharpe')).toBe('1.42')
    // No decimals rule for a multiple column, so it passes through as written.
    expect(formatReportCell('55x', 'Forward P/E')).toBe('55x')
  })

  it('does not compact a year or a small count', () => {
    // The floor is a million precisely so these stay literal.
    expect(formatReportCell(2026, 'Value')).toBe('2026.00')
    expect(formatReportCell('2026-08-26', 'Report date')).toBe('2026-08-26')
  })

  it('uses a hyphen for an absent cell, never an em dash', () => {
    expect(formatReportCell(null, 'YoY %')).toBe('-')
    expect(formatReportCell(null, 'YoY %')).not.toContain('—')
  })

  it('keeps the sign on a negative magnitude', () => {
    expect(formatReportCell(-2349000000, 'Value')).toBe('−2.35B')
  })

  it('scales decimals with size so a label never runs long', () => {
    expect(compactMagnitude(1234)).toBe('1.23K')
    expect(compactMagnitude(12340)).toBe('12.3K')
    expect(compactMagnitude(123400)).toBe('123.4K')
  })
})
