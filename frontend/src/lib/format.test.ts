import { describe, expect, it } from 'vitest'
import { formatScreenerFilterDisplay, parseScaledNumber, screenerFilterToApi } from './format'

describe('parseScaledNumber', () => {
  it('parses plain numbers', () => {
    expect(parseScaledNumber('10')).toBe(10)
    expect(parseScaledNumber('-1.5')).toBe(-1.5)
  })

  it('parses scale suffixes', () => {
    expect(parseScaledNumber('300M')).toBe(300_000_000)
    expect(parseScaledNumber('1.5B')).toBe(1_500_000_000)
    expect(parseScaledNumber('2T')).toBe(2_000_000_000_000)
  })
})

describe('screenerFilterToApi', () => {
  it('treats bare marketCap as billions', () => {
    expect(screenerFilterToApi('marketCap', '10')).toBe(10)
    expect(screenerFilterToApi('marketCap', '10B')).toBe(10)
    expect(screenerFilterToApi('marketCap', '300M')).toBe(0.3)
    expect(screenerFilterToApi('marketCap', '1T')).toBe(1000)
  })

  it('treats volume fields as share counts', () => {
    expect(screenerFilterToApi('avgVolume', '300M')).toBe(300_000_000)
    expect(screenerFilterToApi('volume', '1.2B')).toBe(1_200_000_000)
  })
})

describe('formatScreenerFilterDisplay', () => {
  it('formats market cap and volume readably', () => {
    expect(formatScreenerFilterDisplay('marketCap', '10')).toBe('$10B')
    expect(formatScreenerFilterDisplay('avgVolume', '300M')).toBe('300M')
  })
})
