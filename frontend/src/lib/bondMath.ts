// Client-side bond math, kept in step with backend/math_engine.py so an inline
// card figure matches the detail panel's server-solved YTM. Semiannual
// (frequency 2), face 1000, maturity rounded to whole years — the same
// convention deriveFor() sends to /api/bond analytics.

const FREQ = 2
const FACE = 1000

// Present value of a bond given a yield (percent). Mirrors bond_price().
function priceAtYtm(couponRate: number, maturityYears: number, ytmPct: number): number {
  const periods = Math.max(1, Math.round(maturityYears * FREQ))
  const coupon = (couponRate / 100 / FREQ) * FACE
  const rate = ytmPct / 100 / FREQ
  if (rate === 0) return coupon * periods + FACE
  const pvCoupons = coupon * (1 - Math.pow(1 + rate, -periods)) / rate
  const pvFace = FACE / Math.pow(1 + rate, periods)
  return pvCoupons + pvFace
}

// Solve YTM (percent) from a per-100 market price. Price is monotonically
// decreasing in yield, so a bisection on [0, 200]% converges cleanly. Returns
// null when inputs are missing or the price sits outside the solvable band.
export function solveBondYtm(
  couponRate: number | null | undefined,
  maturityYears: number | null | undefined,
  marketPrice: number | null | undefined,
): number | null {
  if (couponRate == null || !maturityYears || maturityYears <= 0 || marketPrice == null || marketPrice <= 0) return null
  const target = (marketPrice / 100) * FACE
  const mat = Math.max(1, Math.round(maturityYears))
  let lo = 0, hi = 200
  if (priceAtYtm(couponRate, mat, hi) > target) return null // price too low to solve in band
  if (priceAtYtm(couponRate, mat, lo) < target) return null // price above zero-yield PV
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (priceAtYtm(couponRate, mat, mid) > target) lo = mid
    else hi = mid
  }
  return Math.round(((lo + hi) / 2) * 100) / 100
}
