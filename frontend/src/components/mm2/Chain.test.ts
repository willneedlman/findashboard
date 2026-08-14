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
