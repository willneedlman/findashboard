import { describe, expect, it } from 'vitest'
import { fmtTailReturn, formatScreenerFilterDisplay, isTailLoss, parseScaledNumber, screenerFilterToApi } from './format'

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

describe('fmtTailReturn', () => {
  it('renders a loss-positive VaR as a negative return', () => {
    expect(fmtTailReturn(19.8)).toBe('-19.8%')
  })

  it('renders a tail that finishes ahead as a gain', () => {
    expect(fmtTailReturn(-19.8)).toBe('+19.8%')
  })

  it('never emits a signed zero', () => {
    expect(fmtTailReturn(0)).toBe('0.0%')
  })

  it('placeholders missing values', () => {
    expect(fmtTailReturn(null)).toBe('—')
    expect(fmtTailReturn(NaN)).toBe('—')
  })
})

describe('isTailLoss', () => {
  it('is true only when the tail actually loses', () => {
    expect(isTailLoss(19.8)).toBe(true)
    expect(isTailLoss(-19.8)).toBe(false)
    expect(isTailLoss(null)).toBe(false)
  })
})
