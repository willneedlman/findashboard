/**
 * Options MM 2 — the vertical budget, in one place.
 *
 * The screen is authored to fit a laptop with nothing scrolling but the chain,
 * which only holds while these add up. They lived as scattered literals and
 * drifted three times, each time silently clipping whichever panel happened to
 * be last in the risk column. layout.test.ts asserts the arithmetic instead.
 */

/** Gutter the route's layout branch puts around the whole terminal. */
export const GUTTER = 6
/** Command bar, fixed. */
export const COMMAND_H = 46
/** Gap between every region. */
export const GAP = 4
/** Bottom pane: tab strip plus the tallest tab body and the P&L cell. */
export const BOTTOM_H = 218

/**
 * What the risk column needs with all three panels whole: the meters, the
 * exposure floor and the hedge ticket including its buttons.
 */
// Carries deliberate slack over the measured ~383: every previous estimate of
// these panel heights ran optimistic, and the failure mode is a clipped button
// rather than a visible overflow.
export const RISK_COL_MIN = 420

/** Smallest window the screen is expected to hold without clipping. */
export const MIN_VIEWPORT_H = 720

/** Height the middle row (rail, chain, risk) receives at a given window height. */
export const middleHeight = (viewportH: number) =>
  viewportH - GUTTER * 2 - COMMAND_H - GAP * 2 - BOTTOM_H
