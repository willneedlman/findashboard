import { describe, expect, it } from 'vitest'
import {
  isTickerSymbol, parseTickerSymbols, reportTickerSymbols, tickerLogoVisualScale,
} from './tickerLogos'

describe('ticker logo helpers', () => {
  it('normalizes and deduplicates report symbols', () => {
    expect(parseTickerSymbols('aapl, MSFT  brk/b;AAPL')).toEqual(['AAPL', 'MSFT', 'BRK.B'])
  })

  it('fills missing report subjects from researched clip keys', () => {
    expect(reportTickerSymbols('', ['AAPL:profile', 'MSFT:dcf', 'market:overview']))
      .toEqual(['AAPL', 'MSFT'])
  })

  it('does not mix source-family keys into explicit report subjects', () => {
    expect(reportTickerSymbols('AAPL, MSFT', ['company:snapshot', 'news:recent']))
      .toEqual(['AAPL', 'MSFT'])
  })

  it('rejects prose and malformed ticker values', () => {
    expect(isTickerSymbol('AAPL')).toBe(true)
    expect(isTickerSymbol('BRK-B')).toBe(true)
    expect(isTickerSymbol('Forward P/E')).toBe(false)
  })

  it('normalizes visual weight for logos with unusually tight artwork', () => {
    expect(tickerLogoVisualScale('MCD')).toBeLessThan(tickerLogoVisualScale('YUM'))
    expect(tickerLogoVisualScale('AAPL')).toBe(0.9)
  })
})
