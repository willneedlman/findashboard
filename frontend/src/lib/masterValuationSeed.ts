/** Seeding for the Master Valuation model.
 *
 * `/api/master-valuation/analyze` needs a complete assumption set: a multi-year
 * schedule, multiple targets, SOTP segments and method weights. Producing one is
 * business logic, not plumbing — the payout ratio is backed out of dividends per
 * share against forecast after-tax operating profit, and the multiples weight
 * depends on whether the fundamentals feed returned any current multiple at all.
 *
 * Both the Master Valuation page and the Report Creator need that same request.
 * It lives here so the two cannot drift: a report that valued a company on
 * different assumptions from the page showing the same company would be worse
 * than a report with no valuation in it.
 */

export type AnnualAssumption = {
  year: number
  growth: number
  margin: number
  tax_rate: number
  da_pct: number
  capex_pct: number
  change_nwc_pct: number
  sbc_pct: number
  cash_adjustment_pct: number
  fcf_conversion_pct: number
  net_interest_pct: number
  dilution_pct: number
  payout_pct: number
}

export type MetricKey = 'ev_revenue' | 'ev_ebitda'
export type MultipleTarget = { metric: MetricKey; multiple: number; weight: number; year: number }
export type SotpSegment = { name: string; revenue_share: number; price_to_sales_multiple: number }
export type MethodKey = 'dcf' | 'multiples' | 'ddm' | 'sotp'

export type MasterValuationFundamentals = {
  ticker: string
  revenue: number
  shares: number
  net_debt: number
  market_price: number | null
  beta: number | null
  source: string | null
  schedule: AnnualAssumption[]
  current_multiples: Record<string, number | null>
  business_segments: SotpSegment[]
  business_segments_source: string | null
  business_segments_fiscal_year: number | string | null
  dividend_per_share: number | null
  dividend_yield: number | null
}

export type MasterValuationRequest = {
  ticker: string
  revenue: number
  shares: number
  net_debt: number
  market_price: number | null
  wacc: number
  cost_of_equity: number
  schedule: AnnualAssumption[]
  terminal: { perpetual_growth: number }
  multiple_targets: MultipleTarget[]
  sotp_segments: SotpSegment[]
  weights: Record<MethodKey, number>
  dividend_terminal_growth: number
}

/** Model-level starting points, applied before the user touches anything. */
export const MASTER_VALUATION_DEFAULTS = {
  wacc: 9.5,
  costOfEquity: 10,
  terminalGrowth: 3,
  dividendGrowth: 3,
} as const

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

/** The multiple targets the fundamentals feed can support, at today's levels. */
export function seedMultipleTargets(fundamentals: MasterValuationFundamentals): MultipleTarget[] {
  const targets: MultipleTarget[] = []
  const current = fundamentals.current_multiples || {}
  if ((current.ev_revenue || 0) > 0) {
    targets.push({ metric: 'ev_revenue', multiple: clamp(current.ev_revenue!, 0.01, 200), weight: 50, year: 3 })
  }
  if ((current.ev_ebitda || 0) > 0) {
    targets.push({ metric: 'ev_ebitda', multiple: clamp(current.ev_ebitda!, 0.01, 200), weight: 50, year: 3 })
  }
  return targets
}

/** The forecast schedule, with a payout ratio only where a dividend exists.
 *
 * Payout is backed out of dividends per share against forecast after-tax
 * operating profit rather than assumed, because the DDM leg is worthless on an
 * invented payout and the API rejects anything above 100%.
 */
export function seedSchedule(fundamentals: MasterValuationFundamentals): AnnualAssumption[] {
  const schedule = (fundamentals.schedule || []).map(row => ({
    ...row,
    fcf_conversion_pct: row.fcf_conversion_pct ?? 100,
    net_interest_pct: row.net_interest_pct ?? 0,
  }))
  const dividendPerShare = fundamentals.dividend_per_share || 0
  if (dividendPerShare > 0 && schedule.length) {
    const firstMargin = Math.max(schedule[0]?.margin || 10, 1)
    const afterTaxOperatingProfit = Math.max(fundamentals.revenue * firstMargin / 100 * 0.79, 1)
    const payout = clamp((dividendPerShare * fundamentals.shares) / afterTaxOperatingProfit * 100, 0, 80)
    schedule.forEach(row => { row.payout_pct = Number(payout.toFixed(1)) })
  }
  return schedule
}

/** Method weights. Multiples only earn weight when a target could be seeded. */
export function seedWeights(targets: MultipleTarget[]): Record<MethodKey, number> {
  const multiples = targets.length ? 35 : 0
  return { dcf: 100 - multiples, multiples, ddm: 0, sotp: 0 }
}

/** The complete analyze request implied by a fundamentals response. */
export function seedMasterValuationRequest(
  fundamentals: MasterValuationFundamentals,
): MasterValuationRequest {
  const targets = seedMultipleTargets(fundamentals)
  return {
    ticker: fundamentals.ticker,
    revenue: fundamentals.revenue,
    shares: fundamentals.shares,
    net_debt: fundamentals.net_debt,
    market_price: fundamentals.market_price,
    wacc: MASTER_VALUATION_DEFAULTS.wacc,
    cost_of_equity: MASTER_VALUATION_DEFAULTS.costOfEquity,
    schedule: seedSchedule(fundamentals),
    terminal: { perpetual_growth: MASTER_VALUATION_DEFAULTS.terminalGrowth },
    multiple_targets: targets,
    sotp_segments: (fundamentals.business_segments || []).map(segment => ({ ...segment })),
    weights: seedWeights(targets),
    dividend_terminal_growth: MASTER_VALUATION_DEFAULTS.dividendGrowth,
  }
}

/** Whether the analyze call can run at all. The API 422s on any of these. */
export function masterValuationBlocker(fundamentals: MasterValuationFundamentals): string {
  if (!fundamentals.revenue || fundamentals.revenue <= 0) return 'Base revenue is unavailable.'
  if (!fundamentals.shares || fundamentals.shares <= 0) return 'Share count is unavailable.'
  if ((fundamentals.schedule || []).length < 3) return 'The forecast requires at least three annual periods.'
  return ''
}
