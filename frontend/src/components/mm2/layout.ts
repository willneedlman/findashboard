/**
 * Options MM Simulator — the vertical budget, in one place.
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
/**
 * Bottom pane: tab strip, the tallest tab body, and the pinned chart cell that
 * absorbed the old separate P&L band. One pane doing the work of two is where
 * the redesign spends the height it saved folding the market strip into the
 * instrument header.
 *
 * Cut from 264. At that height the bottom read looser than the top: the tab
 * body ended well short of the floor and the P&L chart was mostly empty
 * plot area, while the quoting rail above it was pressed tight. The chart only
 * needs enough height to show the shape of a curve, and the height it gives up
 * goes to the middle row, which is where the reading happens.
 */
export const BOTTOM_H = 218

/**
 * What the risk column needs with all three panels whole: the meters, the
 * exposure floor and the hedge ticket including its buttons.
 */
// Carries deliberate slack over the measured ~383: every previous estimate of
// these panel heights ran optimistic, and the failure mode is a clipped button
// rather than a visible overflow.
export const RISK_COL_MIN = 420

/** The design frame both desks are authored against: a 1440x900 laptop. */
export const DESIGN_W = 1220
export const DESIGN_H = 800
/**
 * Middle row at the design frame, from the budget in the handoff.
 *
 * Grew by the 46 the bottom pane released. This is where it was wanted: the
 * quoting rail, the book and the risk column all read tight while the pane
 * below them ended in empty space.
 */
export const MIDDLE_H = 496
/** Rates only: the curve panel pinned under the matrix. */
export const CURVE_H = 118

/**
 * Smallest window the screen is expected to hold without clipping.
 *
 * Was raised to 760 when the bottom pane grew to 264 to absorb the P&L band.
 * The bottom has since given 46 back, so the same risk column now clears at
 * 714; the floor stays at 720, the round number the handoff started from and
 * the point below which the risk column collapses first, its headline numbers
 * already being chips on the command bar.
 */
export const MIN_VIEWPORT_H = 720

/** Height the middle row (rail, chain, risk) receives at a given window height. */
export const middleHeight = (viewportH: number) =>
  viewportH - GUTTER * 2 - COMMAND_H - GAP * 2 - BOTTOM_H
