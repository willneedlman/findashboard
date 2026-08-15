import { describe, expect, it } from 'vitest'
import { fmtTailReturn, formatScreenerFilterDisplay, isTailLoss, parseScaledNumber, screenerAsOfLabel, screenerFilterToApi } from './format'

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

describe('screenerAsOfLabel', () => {
  const now = new Date('2026-08-15T04:20:00Z')

  it('reports the age of a bundled board instead of the wall clock', () => {
    const built = '2026-07-22T03:19:27Z'
    // The date renders in the viewer's timezone, so derive the expectation the
    // same way rather than pinning a UTC day the runner may not be in.
    const day = new Date(built).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()

    const label = screenerAsOfLabel(built, { bundled: 250 }, now)

    expect(label).toBe(`PRICES AS OF ${day} · 24D OLD · 250 STORED`)
  })

  it('counts only the rows that are not from the current session', () => {
    expect(screenerAsOfLabel('2026-08-15T04:00:00Z', { live: 200, bundled: 50 }, now)).toContain('50 STORED')
    expect(screenerAsOfLabel('2026-08-15T04:00:00Z', { live: 250 }, now)).not.toContain('STORED')
  })

  it('says so when the board carries no as-of at all', () => {
    expect(screenerAsOfLabel(null, {}, now)).toBe('AS-OF UNKNOWN')
    expect(screenerAsOfLabel('not a date', {}, now)).toBe('AS-OF UNKNOWN')
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
