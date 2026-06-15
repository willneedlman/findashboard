// Weight math shared by Compare / Monte Carlo / Backtester.
//
// Two problems this solves:
//  1. Summing float weights (2.3 + 2.1 + 1.9 …) shows 99.99999999999999%.
//     `weightTotal` rounds the displayed total so it reads cleanly.
//  2. "Weights should always total 100%." `normalizeTo100` rescales any set of
//     weights to sum to exactly 100 using the largest-remainder method, so the
//     parts add up with no rounding drift.

const sum = (xs: number[]) => xs.reduce((s, x) => s + (Number.isFinite(x) ? x : 0), 0)

/** Clean total for display — avoids float noise like 99.99999999999999. */
export function weightTotal(weights: number[], decimals = 0): number {
  const f = Math.pow(10, decimals)
  return Math.round(sum(weights) * f) / f
}

/** Round `values` so they sum to exactly `target`, distributing the rounding
 *  remainder to the entries with the largest fractional parts (largest-remainder
 *  / Hamilton method). Keeps `decimals` places. */
export function roundToSum(values: number[], target: number, decimals = 0): number[] {
  const f = Math.pow(10, decimals)
  const scaledTarget = Math.round(target * f)
  const floored = values.map(v => Math.floor((Number.isFinite(v) ? v : 0) * f))
  if (values.length === 0) return []
  let remainder = scaledTarget - floored.reduce((s, v) => s + v, 0)
  const order = values
    .map((v, i) => ({ i, frac: ((Number.isFinite(v) ? v : 0) * f) - floored[i] }))
    .sort((a, b) => b.frac - a.frac)
  const out = [...floored]
  // Distribute the whole remainder by cycling through entries (largest fraction
  // first), so the result sums to exactly the target even when the remainder is
  // larger than the array length.
  for (let k = 0; remainder > 0; k++, remainder--) out[order[k % order.length].i] += 1
  for (let k = 0; remainder < 0; k++, remainder++) out[order[order.length - 1 - (k % order.length)].i] -= 1
  return out.map(v => v / f)
}

/** Rescale weights to sum to exactly 100 (proportional + largest-remainder). An
 *  all-zero set returns all zeros (nothing to scale). */
export function normalizeTo100(weights: number[], decimals = 0): number[] {
  const total = sum(weights)
  if (total <= 0) return weights.map(() => 0)
  return roundToSum(weights.map(w => (Number.isFinite(w) ? w : 0) / total * 100), 100, decimals)
}

/** True when the weights already total 100 (within display precision). */
export function isBalanced(weights: number[], decimals = 0): boolean {
  return weightTotal(weights, decimals) === 100
}
