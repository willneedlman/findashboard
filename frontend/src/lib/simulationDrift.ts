// The drift a simulation is allowed to project forward.
//
// A sample mean return is a terrible estimate of an expected one. Its standard
// error is sigma/sqrt(n), so three years of a 30%-vol book leaves about 17
// percentage points a year of uncertainty around it, wider than any plausible
// expected return. Volatility, estimated from squared deviations, converges far
// faster. So keep the measured volatility and refuse to take the measured drift
// at face value.
//
// This is a port of `_simulation_drift` in backend/routers/portfolio.py, which
// stays the reference implementation. Portfolio Analysis runs its paths on the
// server and got this discipline; Monte Carlo runs its portfolio paths in the
// browser and did not, so the same book projected +150% a year on one page and
// a believable number on the other. simulationDrift.test.ts pins both to the
// same figures so they cannot drift apart again.

export type DriftMode = 'shrunk' | 'historical' | 'risk_free'

export interface DriftResult {
  /** Annualized percent actually simulated. */
  usedAnnualPct: number
  /** Annualized percent the sample showed, before any shrinkage. */
  sampleAnnualPct: number
  priorAnnualPct: number
  /** True when the cap bound, meaning the sample was not merely shrunk. */
  capped: boolean
  observations: number
  mode: DriftMode
}

/** Five years of trading days: the weight at which a sample stops being noise. */
const PRIOR_WINDOW = 252 * 5
const TRADING_DAYS = 252

/**
 * @param sampleAnnualPct  drift the history showed, annualized percent
 * @param observations     trading days behind that estimate
 * @param riskFreePct      annualized percent
 * @param capAnnualPct     hard ceiling on what may be projected forward
 */
export function simulationDrift(
  sampleAnnualPct: number,
  observations: number,
  { mode = 'shrunk', riskFreePct = 4, capAnnualPct = 25 }: {
    mode?: DriftMode; riskFreePct?: number; capAnnualPct?: number
  } = {},
): DriftResult {
  const rf = riskFreePct / 100
  const priorAnnual = rf + 0.05                        // a market-ish equity return
  const priorDaily = Math.log1p(priorAnnual) / TRADING_DAYS
  const sampleDaily = Math.log1p(sampleAnnualPct / 100) / TRADING_DAYS

  let used: number
  if (mode === 'historical') used = sampleDaily
  else if (mode === 'risk_free') used = Math.log1p(rf) / TRADING_DAYS
  else {
    const weight = observations > 0 ? observations / (observations + PRIOR_WINDOW) : 0
    used = weight * sampleDaily + (1 - weight) * priorDaily
  }

  // The cap binds in every mode. "historical" keeps the estimator, it is not a
  // licence for any number the sample happens to contain.
  const capDaily = Math.log1p(capAnnualPct / 100) / TRADING_DAYS
  const capped = Math.min(used, capDaily)

  return {
    usedAnnualPct: Math.expm1(capped * TRADING_DAYS) * 100,
    sampleAnnualPct,
    priorAnnualPct: priorAnnual * 100,
    capped: capped < used - 1e-12,
    observations,
    mode,
  }
}
