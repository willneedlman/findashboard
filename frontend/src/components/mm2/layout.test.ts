import { describe, it, expect } from 'vitest'
import { BOTTOM_H, BOTTOM_H_RATES, COMMAND_H, CURVE_H, DESIGN_H, GAP, GUTTER, MIDDLE_H, MIN_VIEWPORT_H, RISK_COL_MIN, middleHeight } from './layout'

/**
 * The screen must fit with nothing scrolling but the chain. These numbers drifted
 * three separate times and each time the hedge panel lost its buttons off the
 * bottom, which is invisible in a diff and obvious on screen.
 */
describe('vertical budget', () => {
  it('leaves the risk column room for every panel at the smallest supported window', () => {
    expect(middleHeight(MIN_VIEWPORT_H)).toBeGreaterThanOrEqual(RISK_COL_MIN)
  })

  it('only grows the middle row as the window grows', () => {
    for (const h of [800, 900, 1080, 1440]) {
      expect(middleHeight(h)).toBeGreaterThan(middleHeight(h - 80))
      expect(middleHeight(h)).toBeGreaterThanOrEqual(RISK_COL_MIN)
    }
  })

  it('spends the window on exactly the regions it accounts for', () => {
    const h = 900
    const accounted = GUTTER * 2 + COMMAND_H + GAP * 2 + BOTTOM_H + middleHeight(h)
    expect(accounted).toBe(h)
  })

  it('keeps the bottom pane tall enough for its tab strip and content', () => {
    // 27px tab strip, and the contract inspector needs ~165 under it.
    expect(BOTTOM_H - 27).toBeGreaterThanOrEqual(165)
  })

  it('adds up exactly at the design frame, with no reliance on flex shrink', () => {
    // 768 inner = 46 command + 4 + 450 middle + 4 + 264 bottom. The handoff is
    // explicit that overflow must not be rescued by shrink, so the arithmetic
    // is asserted rather than trusted.
    const inner = DESIGN_H - GUTTER * 2 - 20
    expect(COMMAND_H + GAP + MIDDLE_H + GAP + BOTTOM_H).toBe(inner)
  })

  it('leaves the rates matrix room once the curve panel is pinned under it', () => {
    // Matrix header 46 + scope line 22 + curve panel + its gap must still leave
    // a body that holds eight 25px rows without scrolling.
    const matrix = MIDDLE_H - CURVE_H - GAP
    expect(matrix - 46 - 22).toBeGreaterThanOrEqual(8 * 25)
  })
})

/**
 * The bottom pane read looser than the top: its tab body ended well short of
 * the floor and the P&L chart was mostly empty plot area, while the quoting
 * rail above was pressed tight. Height moved from one to the other.
 */
describe('the bottom is tighter than the top, not looser', () => {
  it('gives the middle row more height than the bottom pane', () => {
    expect(MIDDLE_H).toBeGreaterThan(BOTTOM_H * 2)
  })

  it('keeps the risk column whole at the stated floor, on BOTH desks', () => {
    // The rates desk has the taller bottom pane, so it is the binding one. A
    // floor checked against the options desk alone passed while the rates risk
    // column clipped by ten pixels.
    expect(middleHeight(MIN_VIEWPORT_H)).toBeGreaterThanOrEqual(RISK_COL_MIN)
    expect(middleHeight(MIN_VIEWPORT_H, BOTTOM_H_RATES)).toBeGreaterThanOrEqual(RISK_COL_MIN)
  })

  it('gives the rates inspector room for its three-column read', () => {
    // Tab strip, padding, the instrument line, and a column of seven rows with
    // its heading. At 218 the last row was cut off and the pane scrolled.
    const tallestBody = 24 + 18 + 21 + 8 + (13 + 3 + 7 * 15) + 8 + 28
    expect(BOTTOM_H_RATES).toBeGreaterThanOrEqual(tallestBody)
  })

  it('leaves the P&L chart enough to show a shape', () => {
    // Tab strip, the 78px canvas, its legend and the panel's own chrome.
    const chartChrome = 24 + 78 + 20
    expect(BOTTOM_H).toBeGreaterThan(chartChrome)
  })
})
