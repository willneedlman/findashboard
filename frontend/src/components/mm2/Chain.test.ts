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

import { BAND_H, GROUP_H, GROUP_TOP, COL_TOP } from './Chain'

/**
 * The three header rows are sticky at fixed offsets. If a row's offset lands
 * below where the previous row ends, the gap is transparent and scrolling body
 * rows show straight through it.
 */
describe('sticky header geometry', () => {
  it('sticks each header row above where the previous one ends', () => {
    expect(GROUP_TOP).toBeLessThan(BAND_H)
    expect(COL_TOP).toBeLessThan(GROUP_TOP + GROUP_H)
  })

  it('never leaves a vertical gap between the rows', () => {
    expect(BAND_H - GROUP_TOP).toBeGreaterThanOrEqual(1)
    expect(GROUP_TOP + GROUP_H - COL_TOP).toBeGreaterThanOrEqual(1)
  })

  it('keeps the rows in order, so none can render above the band', () => {
    expect(GROUP_TOP).toBeGreaterThan(0)
    expect(COL_TOP).toBeGreaterThan(GROUP_TOP)
  })
})
