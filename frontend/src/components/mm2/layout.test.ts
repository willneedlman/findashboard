import { describe, it, expect } from 'vitest'
import {
  BOTTOM_H, COMMAND_H, CURVE_H, DESIGN_H, GAP, GUTTER, MIDDLE_H, MIN_VIEWPORT_H,
  RISK_COL_MIN, middleHeight,
} from './layout'

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
