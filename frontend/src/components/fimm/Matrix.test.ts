import { describe, it, expect } from 'vitest'
import { BAND_H, HEADER_H, NAME_H, NAMES } from './Matrix'
import { CURVE_H, GAP, MIDDLE_H } from '../mm2/layout'

/**
 * The matrix is the hero and has to fill its panel: eight issues sitting at
 * their natural line height left a band of empty space under the 30Y, which
 * reads as missing data on a board whose whole job is completeness.
 *
 * The table takes height 100%, which for a table is a floor rather than a cap,
 * so the body shares out whatever the panel has left and still overflows into a
 * scroll when there is more than fits.
 */
describe('matrix geometry', () => {
  it('totals exactly 100 percent so the table can never scroll sideways', () => {
    const total = NAMES.reduce((a, n) => a + parseFloat(n.w), 0)
    expect(total).toBeCloseTo(100, 6)
  })

  it('names every one of the twelve columns', () => {
    expect(NAMES).toHaveLength(12)
    expect(NAMES.every(n => n.label.length > 0)).toBe(true)
  })

  it('mirrors the quote and market columns around the model spine', () => {
    // asset · market · yours · yield · yours · market · …
    const [, marketBid, yourBid, yieldCol, yourAsk, marketAsk] = NAMES
    expect(marketBid.w).toBe(marketAsk.w)
    expect(yourBid.w).toBe(yourAsk.w)
    expect(yieldCol.kind).toBe('model')
    expect(yourBid.kind).toBe('yours')
    expect(yourAsk.kind).toBe('yours')
  })

  it('sticks the name row at exactly the band row height', () => {
    // A guessed offset shows body rows scrolling through the seam.
    expect(HEADER_H).toBe(BAND_H + NAME_H)
  })

  it('leaves the eight issues room to fill the panel at the design frame', () => {
    // Matrix panel is the middle row less the pinned curve panel and its gap.
    const panel = MIDDLE_H - CURVE_H - GAP
    const body = panel - 46 - 22 - 2 - HEADER_H     // header, scope line, border
    expect(body).toBeGreaterThanOrEqual(8 * 25)
    // And the rows grow rather than leaving a gap.
    expect(body / 8).toBeGreaterThan(25)
  })
})
