/*
 * Options MM Simulator — pricing engine.
 *
 * Pure Black-Scholes-Merton with a full greek set (through vanna and volga),
 * plus the parametric volatility surface both the market generator and the
 * strategy price against. Nothing here touches React or the simulation clock,
 * so it stays unit-testable and cheap enough to call a few hundred times per
 * engine step.
 */

export type Kind = 'C' | 'P'

export interface Greeks {
  theo: number
  delta: number
  gamma: number
  vega: number    // per 1.00 (100 vol points) change in sigma
  theta: number   // per year
  rho: number     // per 1.00 change in r
  vanna: number   // d delta / d sigma
  volga: number   // d vega / d sigma
}

const INV_SQRT_2PI = 0.3989422804014327

export function normPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x)
}

/** Zelen-Severo rational approximation; |error| < 8e-8, ~20x faster than erf series. */
export function normCdf(x: number): number {
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429
  const p = 0.2316419
  const t = 1 / (1 + p * Math.abs(x))
  const poly = t * (b1 + t * (b2 + t * (b3 + t * (b4 + t * b5))))
  const cdf = 1 - INV_SQRT_2PI * Math.exp(-0.5 * x * x) * poly
  return x >= 0 ? cdf : 1 - cdf
}

const ZERO: Greeks = { theo: 0, delta: 0, gamma: 0, vega: 0, theta: 0, rho: 0, vanna: 0, volga: 0 }

/** Full greek set for one European option. `t` in years, `r`/`q`/`sigma` as decimals. */
export function bsGreeks(
  spot: number, strike: number, t: number, r: number, q: number, sigma: number, kind: Kind,
): Greeks {
  if (!(spot > 0) || !(strike > 0)) return { ...ZERO }
  if (t <= 0 || sigma <= 0) {
    // At (or past) expiry the option is worth intrinsic and carries only a
    // step-function delta: every second-order greek collapses to zero.
    const intrinsic = kind === 'C' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0)
    const delta = kind === 'C' ? (spot > strike ? 1 : 0) : (spot < strike ? -1 : 0)
    return { ...ZERO, theo: intrinsic, delta }
  }
  const sqrtT = Math.sqrt(t)
  const dfR = Math.exp(-r * t)
  const dfQ = Math.exp(-q * t)
  const d1 = (Math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * t) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  const nd1 = normPdf(d1)

  const gamma = dfQ * nd1 / (spot * sigma * sqrtT)
  const vega  = spot * dfQ * nd1 * sqrtT
  const vanna = -dfQ * nd1 * d2 / sigma
  const volga = vega * d1 * d2 / sigma
  const decay = -(spot * dfQ * nd1 * sigma) / (2 * sqrtT)

  if (kind === 'C') {
    const theo  = spot * dfQ * normCdf(d1) - strike * dfR * normCdf(d2)
    const delta = dfQ * normCdf(d1)
    const theta = decay - r * strike * dfR * normCdf(d2) + q * spot * dfQ * normCdf(d1)
    const rho   = strike * t * dfR * normCdf(d2)
    return { theo, delta, gamma, vega, theta, rho, vanna, volga }
  }
  const theo  = strike * dfR * normCdf(-d2) - spot * dfQ * normCdf(-d1)
  const delta = dfQ * (normCdf(d1) - 1)
  const theta = decay + r * strike * dfR * normCdf(-d2) - q * spot * dfQ * normCdf(-d1)
  const rho   = -strike * t * dfR * normCdf(-d2)
  return { theo, delta, gamma, vega, theta, rho, vanna, volga }
}

/** Price only — used on the hot paths (stress grids, book repricing) where greeks are wasted work. */
export function bsPrice(spot: number, strike: number, t: number, r: number, q: number, sigma: number, kind: Kind): number {
  if (t <= 0 || sigma <= 0) return kind === 'C' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0)
  const sqrtT = Math.sqrt(t)
  const dfR = Math.exp(-r * t), dfQ = Math.exp(-q * t)
  const d1 = (Math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * t) / (sigma * sqrtT)
  const d2 = d1 - sigma * sqrtT
  return kind === 'C'
    ? spot * dfQ * normCdf(d1) - strike * dfR * normCdf(d2)
    : strike * dfR * normCdf(-d2) - spot * dfQ * normCdf(-d1)
}

/** Newton on vega with a bisection guard, so a wide/illiquid quote can't send it to NaN. */
export function impliedVol(
  price: number, spot: number, strike: number, t: number, r: number, q: number, kind: Kind,
): number {
  const intrinsic = kind === 'C'
    ? Math.max(spot * Math.exp(-q * t) - strike * Math.exp(-r * t), 0)
    : Math.max(strike * Math.exp(-r * t) - spot * Math.exp(-q * t), 0)
  if (t <= 0 || price <= intrinsic) return 0
  let lo = 0.001, hi = 5, sigma = 0.25
  for (let i = 0; i < 40; i++) {
    const g = bsGreeks(spot, strike, t, r, q, sigma, kind)
    const diff = g.theo - price
    if (Math.abs(diff) < 1e-6) return sigma
    if (diff > 0) hi = sigma; else lo = sigma
    const next = g.vega > 1e-8 ? sigma - diff / g.vega : NaN
    sigma = Number.isFinite(next) && next > lo && next < hi ? next : 0.5 * (lo + hi)
  }
  return sigma
}

// ── Volatility surface ────────────────────────────────────────────────────────

export interface SurfaceParams {
  atmVol: number        // at-the-money vol at the 30d anchor
  putSkew: number       // vol added per unit of standardised log-moneyness below the forward
  callSkew: number      // same above the forward (negative = call wing rolls off)
  termSlope: number     // vol added per unit of sqrt(T) away from the 30d anchor
  curvature: number     // smile: vol added per unit of squared standardised moneyness
  noise: number         // per-contract idiosyncratic surface noise, in vol points
}

const TERM_ANCHOR = Math.sqrt(30 / 365)

/**
 * Standardised log-moneyness keeps the skew shape stable across expiries: the
 * same `putSkew` produces a steep short-dated wing and a flat long-dated one,
 * which is what real surfaces do and what makes short-dated inventory dangerous.
 */
export function surfaceIv(p: SurfaceParams, spot: number, strike: number, t: number, r: number, q: number): number {
  const tt = Math.max(t, 1 / (365 * 24))
  const fwd = spot * Math.exp((r - q) * tt)
  const u = Math.log(strike / fwd) / Math.sqrt(tt)
  const wing = u < 0 ? p.putSkew * -u : p.callSkew * u
  const atmT = p.atmVol + p.termSlope * (Math.sqrt(tt) - TERM_ANCHOR)
  return Math.max(0.02, atmT + wing + p.curvature * u * u)
}

/** 25-delta risk reversal and butterfly, read off the surface for the term-structure readouts. */
export function surfaceMetrics(p: SurfaceParams, spot: number, t: number, r: number, q: number) {
  const fwd = spot * Math.exp((r - q) * t)
  const atm = surfaceIv(p, spot, fwd, t, r, q)
  const shift = 0.674 * atm * Math.sqrt(Math.max(t, 1e-6))   // ~25-delta strike distance in log space
  const put25 = surfaceIv(p, spot, fwd * Math.exp(-shift), t, r, q)
  const call25 = surfaceIv(p, spot, fwd * Math.exp(shift), t, r, q)
  return { atm, put25, call25, rr: call25 - put25, fly: 0.5 * (put25 + call25) - atm }
}

// ── Deterministic RNG ─────────────────────────────────────────────────────────

/** mulberry32 — one seed reproduces a run exactly, which the session bar advertises. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller, single draw. */
export function gauss(rng: () => number): number {
  const u = rng() || 1e-12
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}
