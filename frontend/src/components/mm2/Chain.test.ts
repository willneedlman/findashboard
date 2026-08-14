import { describe, it, expect } from 'vitest'
import { CALL_COLS, STRIKE_COLS, PUT_COLS } from './Chain'

/**
 * The MM2 redesign is authored to fit a 1440x900 laptop with no horizontal
 * scrolling in the chain. That holds only while the column widths are
 * percentages that total exactly 100 against `table-layout: fixed`.
 */
describe('chain column geometry', () => {
  const all = [...CALL_COLS, ...STRIKE_COLS, ...PUT_COLS]

  it('totals exactly 100 percent so the table can never scroll sideways', () => {
    const total = all.reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(100, 6)
  })

  it('mirrors the two sides, so calls and puts read symmetrically', () => {
    expect(CALL_COLS).toEqual([...PUT_COLS].reverse())
  })

  it('renders the header groups it claims: 7 + 2 + 7 columns', () => {
    expect(CALL_COLS).toHaveLength(7)
    expect(STRIKE_COLS).toHaveLength(2)
    expect(PUT_COLS).toHaveLength(7)
  })

  it('uses no zero or negative widths', () => {
    expect(all.every(w => w > 0)).toBe(true)
  })
})

import { BAND_H, GROUP_H, GROUP_TOP, COL_TOP, HEADER_H } from './Chain'

/**
 * The three header rows are sticky at fixed offsets, and the offsets must be
 * exactly cumulative.
 *
 * Overlapping them looks safer and is not: sticking a row a pixel high shrinks
 * the band the three of them cover, leaving a transparent window at the BOTTOM
 * of the header that body rows scroll straight through. That is the bug these
 * assertions exist to catch, so they check both directions.
 */
describe('sticky header geometry', () => {
  it('stacks the rows contiguously, with no gap between them', () => {
    expect(GROUP_TOP).toBe(BAND_H)
    expect(COL_TOP).toBe(BAND_H + GROUP_H)
  })

  it('covers the full header height, leaving no window at the bottom', () => {
    const natural = BAND_H + GROUP_H + GROUP_H
    expect(HEADER_H).toBe(natural)
    expect(COL_TOP + GROUP_H).toBeGreaterThanOrEqual(natural)
  })

  it('never overlaps, which would shrink the covered band', () => {
    expect(GROUP_TOP).toBeGreaterThanOrEqual(BAND_H)
    expect(COL_TOP).toBeGreaterThanOrEqual(GROUP_TOP + GROUP_H)
  })

  it('keeps the rows in order and off the top edge', () => {
    expect(GROUP_TOP).toBeGreaterThan(0)
    expect(COL_TOP).toBeGreaterThan(GROUP_TOP)
  })
})
