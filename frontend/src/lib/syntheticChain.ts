// Manufactured option chains for the Options Desk demo, so the layout can be
// exercised when a vendor is down or the market is closed.
//
// NOTHING HERE IS MARKET DATA. Every number is generated. The only caller is
// /options-desk-demo, which labels the whole surface as synthetic while it is
// switched on — never let one of these chains reach a surface that reads as
// live, and never mix a synthetic row into a real result set.
//
// Deterministic by (ticker, expiry): the same inputs always produce the same
// chain, so a design review sees the same picture twice and a screenshot keeps
// matching the page.

export interface SyntheticContract {
  strike: number
  lastPrice: number
  bid: number
  ask: number
  volume: number
  openInterest: number
  impliedVolatility: number
}
export interface SyntheticChain {
  ticker: string
  expiry: string
  expirations: string[]
  spot: number
  calls: SyntheticContract[]
  puts: SyntheticContract[]
}

/** Reference spots for names a reviewer is likely to type; anything else gets a
 *  stable pseudo-price from its own letters rather than a hardcoded default. */
const REFERENCE_SPOT: Record<string, number> = {
  SPY: 768, QQQ: 690, IWM: 268, DIA: 512,
  AAPL: 312, MSFT: 520, NVDA: 180, TSLA: 340, AMZN: 268, GOOGL: 214, META: 742,
  AMD: 168, NFLX: 1180, JPM: 318, XOM: 122, COP: 112,
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
/** mulberry32 — small, fast, and stable across runs. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Abramowitz-Stegun 7.1.26 — enough precision for a demo premium. */
function normCdf(x: number): number {
  const s = x < 0 ? -1 : 1
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z)
  return 0.5 * (1 + s * y)
}
function bs(spot: number, strike: number, tYears: number, iv: number, call: boolean): number {
  const T = Math.max(tYears, 1 / 365 / 8)
  const r = 0.045
  const d1 = (Math.log(spot / strike) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T))
  const d2 = d1 - iv * Math.sqrt(T)
  const disc = Math.exp(-r * T)
  return call
    ? spot * normCdf(d1) - strike * disc * normCdf(d2)
    : strike * disc * normCdf(-d2) - spot * normCdf(-d1)
}

export function syntheticSpot(ticker: string): number {
  const known = REFERENCE_SPOT[ticker.toUpperCase()]
  if (known) return known
  const r = rng(hash(ticker.toUpperCase()))
  return Math.round((18 + r() * 460) * 100) / 100
}

const strikeStep = (spot: number) => (spot >= 400 ? 5 : spot >= 100 ? 2.5 : 1)

/** The next `count` expiries: every weekday inside a week, Fridays after that. */
export function syntheticExpiries(count: number, from = new Date()): string[] {
  const out: string[] = []
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  while (out.length < count) {
    const day = d.getDay()
    const soon = out.length < 4
    if (day !== 0 && day !== 6 && (soon || day === 5)) {
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    }
    d.setDate(d.getDate() + 1)
  }
  return out
}

const dteOf = (expiry: string, from = new Date()) => {
  const e = new Date(`${expiry}T00:00:00`)
  const t = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  return Math.max(0, Math.round((+e - +t) / 86_400_000))
}

/**
 * One manufactured chain. Open interest peaks at the money and decays; volume
 * is quiet almost everywhere with a handful of deliberate bursts, so the
 * unusual-flow screen has something to find at its default thresholds.
 */
export function syntheticChain(ticker: string, expiry: string, strikes = 41): SyntheticChain {
  const sym = ticker.trim().toUpperCase()
  const spot = syntheticSpot(sym)
  const step = strikeStep(spot)
  const r = rng(hash(`${sym}|${expiry}`))
  const dte = dteOf(expiry)
  const tYears = Math.max(dte, 0.25) / 365

  const atm = Math.round(spot / step) * step
  const half = Math.floor(strikes / 2)
  const baseIv = 0.16 + r() * 0.18 + Math.max(0, 0.10 - dte / 400)   // front expiries carry more vol

  const calls: SyntheticContract[] = []
  const puts: SyntheticContract[] = []

  for (let i = -half; i <= half; i++) {
    const strike = Math.round((atm + i * step) * 100) / 100
    if (strike <= 0) continue
    const m = (strike - spot) / spot                       // moneyness

    // Skew: puts bid over calls, with a smile away from the money.
    const iv = Math.max(0.05, baseIv - 0.55 * m + 2.6 * m * m)
    // OI concentrates at the money and on round strikes.
    const round = strike % (step * 5) === 0 ? 1.7 : 1
    const shape = Math.exp(-((m / 0.055) ** 2))
    const peak = 2200 + r() * 9000

    for (const call of [true, false] as const) {
      const oi = Math.max(0, Math.round(peak * shape * round * (0.55 + r() * 0.9) * (call ? 1 : 0.86)))
      // Most strikes trade a fraction of their OI; ~6% get a burst that clears
      // the screen, which is the whole point of having a flow pane to look at.
      const burst = r() < 0.06
      const volume = Math.max(0, Math.round(
        burst ? oi * (1.6 + r() * 9) + 400 + r() * 2500 : oi * (0.02 + r() * 0.35),
      ))
      const mid = Math.max(0.01, bs(spot, strike, tYears, iv, call))
      const spread = Math.max(0.01, mid * (0.012 + r() * 0.05))
      const c: SyntheticContract = {
        strike,
        lastPrice: Math.round((mid + (r() - 0.5) * spread) * 100) / 100,
        bid: Math.round(Math.max(0, mid - spread / 2) * 100) / 100,
        ask: Math.round((mid + spread / 2) * 100) / 100,
        volume,
        openInterest: oi,
        impliedVolatility: Math.round(iv * 10000) / 10000,
      }
      ;(call ? calls : puts).push(c)
    }
  }

  return {
    ticker: sym,
    expiry,
    expirations: syntheticExpiries(6),
    spot: Math.round(spot * 100) / 100,
    calls,
    puts,
  }
}

/** Every chain the demo needs for one ticker, in the shape the page consumes. */
export function syntheticChains(ticker: string, expiryCount: number): SyntheticChain[] {
  return syntheticExpiries(Math.max(1, expiryCount)).map(e => syntheticChain(ticker, e))
}
