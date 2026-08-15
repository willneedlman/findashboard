/*
 * Bond maths for the fixed-income market-making terminal.
 *
 * Everything here is pure and priced per 100 of face, which is how a Treasury
 * desk quotes. Dollar figures per million are derived at the edge rather than
 * carried through the maths, so a size change never rescales a price.
 *
 * Prices are semi-annual actual/actual approximated as a level 30/360 schedule.
 * The simulation does not settle real cashflows, so the difference is well
 * inside the tick the screen displays.
 */

export const COUPONS_PER_YEAR = 2

/** Clean price per 100 of face for a semi-annual coupon bond. */
export function priceFromYield(coupon: number, ytm: number, years: number): number {
  // Periods are left fractional rather than rounded up to a whole coupon. A
  // 3-month bill rounded to one semi-annual period prices as a 6-month note and
  // reports twice the DV01 it carries, which is a real position-sizing error at
  // the front of the curve.
  const n = Math.max(years * COUPONS_PER_YEAR, 1e-6)
  const c = (coupon / COUPONS_PER_YEAR) * 100
  const y = ytm / COUPONS_PER_YEAR
  if (Math.abs(y) < 1e-12) return c * n + 100
  const disc = Math.pow(1 + y, -n)
  return c * ((1 - disc) / y) + 100 * disc
}

/**
 * Yield to maturity from a clean price, by Newton with a bisection backstop.
 *
 * A pure Newton solve diverges on a deeply discounted long bond, which on this
 * screen would mean a 30Y quoting a negative yield after one bad tick. The
 * bracket is what keeps a solver failure from reaching the tape.
 */
export function yieldFromPrice(coupon: number, price: number, years: number): number {
  let lo = -0.02
  let hi = 0.50
  let y = coupon > 0 ? coupon : 0.04
  for (let i = 0; i < 40; i++) {
    const p = priceFromYield(coupon, y, years)
    const diff = p - price
    if (Math.abs(diff) < 1e-9) return y
    // Price falls as yield rises, so the bracket narrows on the sign of diff.
    if (diff > 0) lo = y
    else hi = y
    const dvdy = -durationDollar(coupon, y, years)
    const next = Math.abs(dvdy) > 1e-9 ? y - diff / dvdy : (lo + hi) / 2
    y = next > lo && next < hi ? next : (lo + hi) / 2
  }
  return y
}

/** dPrice/dYield in price points per unit yield, negated to a positive number. */
function durationDollar(coupon: number, ytm: number, years: number): number {
  const h = 1e-6
  return (priceFromYield(coupon, ytm - h, years) - priceFromYield(coupon, ytm + h, years)) / (2 * h)
}

/** Modified duration in years. */
export function modifiedDuration(coupon: number, ytm: number, years: number): number {
  const p = priceFromYield(coupon, ytm, years)
  return p > 0 ? durationDollar(coupon, ytm, years) / p : 0
}

/** Convexity in years squared. */
export function convexity(coupon: number, ytm: number, years: number): number {
  const h = 1e-4
  const p = priceFromYield(coupon, ytm, years)
  if (p <= 0) return 0
  const up = priceFromYield(coupon, ytm + h, years)
  const dn = priceFromYield(coupon, ytm - h, years)
  return (up + dn - 2 * p) / (p * h * h)
}

/**
 * Dollar value of one basis point per $1mm of face.
 *
 * Positive for a long position: the desk convention is that DV01 is the money
 * gained per basis point of yield decline, so a long book carries positive
 * DV01 and a short carries negative.
 */
export function dv01PerMM(coupon: number, ytm: number, years: number): number {
  const bp = 0.0001
  const up = priceFromYield(coupon, ytm + bp, years)
  const dn = priceFromYield(coupon, ytm - bp, years)
  return ((dn - up) / 2) * 1e6 / 100
}

/** Convexity in dollars per $1mm for a one basis point move, second order. */
export function convexityPerMM(coupon: number, ytm: number, years: number): number {
  const bp = 0.0001
  const p = priceFromYield(coupon, ytm, years)
  const up = priceFromYield(coupon, ytm + bp, years)
  const dn = priceFromYield(coupon, ytm - bp, years)
  return (up + dn - 2 * p) * 1e6 / 100
}

// ── Price display ─────────────────────────────────────────────────────────────

/**
 * Treasury 32nds: 98-16+ is 98 and 16.5 thirty-seconds.
 *
 * The plus is half a 32nd and is the finest increment a cash Treasury screen
 * shows in this format. Anything finer goes through fmt32Eighths.
 */
export function fmt32(price: number): string {
  if (!Number.isFinite(price)) return '—'
  const sign = price < 0 ? '-' : ''
  const abs = Math.abs(price)
  const whole = Math.floor(abs)
  const halves = Math.round((abs - whole) * 64)          // half-32nds
  if (halves >= 64) return `${sign}${whole + 1}-00`
  const thirtySeconds = Math.floor(halves / 2)
  const half = halves % 2 === 1
  return `${sign}${whole}-${String(thirtySeconds).padStart(2, '0')}${half ? '+' : ''}`
}

/**
 * Street format: 99-280 is 99 and 28.0 thirty-seconds, the trailing digit being
 * eighths of a 32nd. This is how an inter-dealer screen prints, and it is finer
 * than the desk's own quote increment on purpose.
 */
export function fmt32Eighths(price: number): string {
  if (!Number.isFinite(price)) return '—'
  const sign = price < 0 ? '-' : ''
  const abs = Math.abs(price)
  const whole = Math.floor(abs)
  const eighths = Math.round((abs - whole) * 256)        // eighths of a 32nd
  if (eighths >= 256) return `${sign}${whole + 1}-000`
  const thirtySeconds = Math.floor(eighths / 8)
  return `${sign}${whole}-${String(thirtySeconds).padStart(2, '0')}${eighths % 8}`
}

/** Round a price to the nearest half 32nd, the desk's quoting increment. */
export function roundTo32nd(price: number): number {
  return Math.round(price * 64) / 64
}

export const TICK_32 = 1 / 32
export const TICK_64 = 1 / 64

// ── Curve ─────────────────────────────────────────────────────────────────────

/**
 * Nelson-Siegel zero curve.
 *
 * Three factors rather than an independent random walk per node, because a
 * curve whose nodes move independently produces butterflies and slopes that no
 * dealer would ever see: the whole point of the risk screen is that a 2s10s
 * tilt and a 2s5s10s fly are the residuals of a small number of shared moves.
 */
export interface CurveFactors {
  level: number
  slope: number
  curvature: number
  tau: number
}

export function nsYield(f: CurveFactors, years: number): number {
  const t = Math.max(years, 1 / 365)
  const x = t / f.tau
  // The limit of (1 - e^-x)/x as x approaches zero is 1, and a short tenor gets
  // close enough to zero to lose all precision without the guard.
  const decay = x < 1e-6 ? 1 : (1 - Math.exp(-x)) / x
  return f.level + f.slope * decay + f.curvature * (decay - Math.exp(-x))
}

/** Basis points between two tenors, long minus short. */
export function slopeBps(f: CurveFactors, shortY: number, longY: number): number {
  return (nsYield(f, longY) - nsYield(f, shortY)) * 10_000
}

/** Butterfly in basis points: twice the belly less the two wings. */
export function flyBps(f: CurveFactors, shortY: number, bellyY: number, longY: number): number {
  return (2 * nsYield(f, bellyY) - nsYield(f, shortY) - nsYield(f, longY)) * 10_000
}
