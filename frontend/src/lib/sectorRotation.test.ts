import { describe, expect, it } from 'vitest'
import { sectorLeadership } from './sectorRotation'

// The tape the audit caught: energy first, tech third, utilities last. Breadth
// was narrow, which is why the page called it defensive.
const CYCLICAL_TAPE = [
  { ticker: 'XLE', value: 8.07 },
  { ticker: 'XLV', value: 4.2 },
  { ticker: 'XLK', value: 3.9 },
  { ticker: 'XLY', value: 2.4 },
  { ticker: 'XLI', value: 1.8 },
  { ticker: 'XLP', value: 0.9 },
  { ticker: 'XLU', value: -2.61 },
]

describe('sectorLeadership', () => {
  it('calls energy and tech over utilities cyclical, not defensive', () => {
    const read = sectorLeadership(CYCLICAL_TAPE)

    expect(read.tone).toBe('cyclical')
    expect(read.label).toBe('Cyclical rotation')
    expect(read.spread).toBeLessThan(0)
  })

  it('calls utilities and staples over tech defensive', () => {
    const read = sectorLeadership([
      { ticker: 'XLU', value: 6 }, { ticker: 'XLP', value: 5 }, { ticker: 'XLV', value: 4 },
      { ticker: 'XLK', value: -2 }, { ticker: 'XLY', value: -1 }, { ticker: 'XLI', value: 0 }, { ticker: 'XLE', value: 1 },
    ])

    expect(read.tone).toBe('defensive')
  })

  it('refuses to call a spread too small to be a rotation', () => {
    const read = sectorLeadership([
      { ticker: 'XLU', value: 2 }, { ticker: 'XLP', value: 2 }, { ticker: 'XLV', value: 2 },
      { ticker: 'XLK', value: 1.5 }, { ticker: 'XLY', value: 1.5 }, { ticker: 'XLI', value: 1.5 }, { ticker: 'XLE', value: 1.5 },
    ])

    expect(read.tone).toBe('mixed')
    expect(read.label).toBe('Mixed leadership')
  })

  it('will not guess when a basket has no data', () => {
    const read = sectorLeadership([{ ticker: 'XLU', value: 3 }, { ticker: 'XLK', value: null }])

    expect(read.tone).toBe('mixed')
    expect(read.spread).toBeNull()
  })
})
