// Stable axis domains for live-updating charts.
//
// Recharts' domain={['auto','auto']} refits bounds on every data change. On a
// 10s-polling portfolio chart that made a $20 move on a $19k book redraw as a
// full-height swing, because the axis kept re-fitting to the new min/max. A real
// broker overview chart holds its axis still and lets the line move inside it.
//
// Deriving the bounds from the data's own span does not fix this: the span itself
// changes every tick, so any step computed from it keeps shifting. Instead the
// band is anchored to the BASELINE (the prior close, or the first plotted point)
// and sized by snapping the observed deviation up to a fixed percentage ladder.
// The lattice therefore does not depend on the latest tick at all, and the axis
// only moves when the data pushes past a rung.

// Percentage rungs. Fine at the bottom so a quiet session is not over-padded,
// coarse at the top so a multi-year chart still lands on round bounds.
const LADDER = [
  0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 7.5, 10, 15, 20, 25, 30, 40, 50,
  65, 80, 100, 125, 150, 200, 300, 500,
]

// Never band tighter than this. Subdividing below half a percent made the axis
// step through several rungs in the first minutes of a session while the day's
// range was still establishing, which is the jitter this module exists to remove.
const MIN_BAND_PCT = 0.5

/** Smallest ladder rung >= pct. Falls back to the largest rung's multiples. */
export function snapToLadder(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return LADDER[0]
  for (const rung of LADDER) if (rung >= pct) return rung
  const top = LADDER[LADDER.length - 1]
  return Math.ceil(pct / top) * top
}

/**
 * Padded [min, max] anchored on `baseline`, stable against small live updates.
 *
 * Upside and downside are snapped independently so a one-directional move does
 * not waste half the plot area. `baseline` is always inside the result, so a
 * reference line drawn on it is always visible.
 */
export function stableValueDomain(
  values: number[], baseline?: number | null,
): [number, number] {
  const pool = values.filter(Number.isFinite)
  if (!pool.length) {
    return baseline != null && Number.isFinite(baseline) && baseline !== 0
      ? [baseline * 0.9975, baseline * 1.0025]
      : [0, 1]
  }

  const anchor = baseline != null && Number.isFinite(baseline) && baseline !== 0
    ? baseline
    : pool[0]
  if (!Number.isFinite(anchor) || anchor === 0) {
    const lo = Math.min(...pool), hi = Math.max(...pool)
    const pad = Math.max((hi - lo) * 0.15, 1e-6)
    return [lo - pad, hi + pad]
  }

  const hi = Math.max(...pool, anchor)
  const lo = Math.min(...pool, anchor)
  // 1.25x headroom so the line does not ride the edge, and so the next few ticks
  // land inside the existing band instead of tripping the next rung immediately.
  const upPct = snapToLadder(Math.max((hi / anchor - 1) * 100 * 1.25, MIN_BAND_PCT))
  const downPct = snapToLadder(Math.max((1 - lo / anchor) * 100 * 1.25, MIN_BAND_PCT))

  const min = anchor * (1 - downPct / 100)
  const max = anchor * (1 + upPct / 100)
  return max > min ? [min, max] : [min, min + Math.abs(anchor) * 0.005]
}
