import { describe, it, expect } from 'vitest'
import { wordMatch, tickerFromQuery } from './search'

describe('wordMatch', () => {
  it('matches at the start of a word', () => {
    expect(wordMatch('Earnings AI', 'earn')).toBe(true)
    expect(wordMatch('Portfolio Manager', 'port')).toBe(true)
    expect(wordMatch('DCF Valuation', 'dcf')).toBe(true)
  })

  it('does NOT match inside a word (the GS bug)', () => {
    expect(wordMatch('Earnings AI', 'gs')).toBe(false)
    expect(wordMatch('Holdings, P&L', 'gs')).toBe(false)
    expect(wordMatch('Corporate Calendar earnings dates', 'gs')).toBe(false)
  })

  it('requires every term to match (multi-word query)', () => {
    expect(wordMatch('Market Data price history', 'market data')).toBe(true)
    expect(wordMatch('Market Data', 'market trading')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(wordMatch('Sector Rotation', 'SECTOR')).toBe(true)
  })
})

describe('tickerFromQuery', () => {
  it('upper-cases valid symbols', () => {
    expect(tickerFromQuery('gs')).toBe('GS')
    expect(tickerFromQuery('  aapl ')).toBe('AAPL')
    expect(tickerFromQuery('BRK.B')).toBe('BRK.B')
  })

  it('rejects non-tickers', () => {
    expect(tickerFromQuery('market data')).toBeNull()
    expect(tickerFromQuery('toolong')).toBeNull()
    expect(tickerFromQuery('')).toBeNull()
    expect(tickerFromQuery('123')).toBeNull()
  })
})
