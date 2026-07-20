// Bridge between the Portfolio Manager and the analysis tools (Compare, Monte
// Carlo). Reads the PM's saved portfolios and converts a chosen one into the
// weighted ticker legs those tools consume, weighting equity holdings by current
// market value and folding cash into a single zero-volatility CASH sleeve.

export const CASH_SYMBOL = 'CASH'

// yfinance uses a dash for share classes (BRK-B, BF-B), never a dot or slash.
// Normalize user input so "BRK.B" / "BRK/B" resolve instead of reading as a dead
// position. Futures (ES=F), indices (^GSPC) and crypto (BTC-USD) are untouched.
export function normalizeTicker(raw: string): string {
  return raw.trim().toUpperCase().replace(/[./]/g, '-')
}

interface PMHolding { ticker: string; shares: number; avgCost: number }
interface PMCash { id: string; label: string; amount: number; rate: number; since: string }
export interface PMPortfolio {
  id: string
  name: string
  holdings: PMHolding[]
  cash: PMCash[]
  optionsCount: number
  futuresCount: number
}

const PORTFOLIOS_KEY = 'pm-portfolios-v2'

// Accrued value of a cash balance: principal × (1 + rate)^(years since `since`).
// Mirrors PortfolioManager.cashValue so imports match what the PM shows.
export function cashValue(c: PMCash): number {
  const start = new Date(c.since + 'T00:00:00').getTime()
  const years = isNaN(start) ? 0 : Math.max(0, (Date.now() - start) / (365.25 * 864e5))
  return c.amount * Math.pow(1 + c.rate / 100, years)
}

export function readPMPortfolios(): PMPortfolio[] {
  try {
    const raw = localStorage.getItem(PORTFOLIOS_KEY)
    if (!raw) return []
    const d = JSON.parse(raw)
    if (!d?.portfolios?.length) return []
    return d.portfolios.map((p: any): PMPortfolio => ({
      id: p.id,
      name: p.name || 'Portfolio',
      holdings: Array.isArray(p.holdings) ? p.holdings : [],
      cash: Array.isArray(p.cash) ? p.cash : [],
      optionsCount: Array.isArray(p.options) ? p.options.length : 0,
      futuresCount: Array.isArray(p.futures) ? p.futures.length : 0,
    }))
  } catch {
    return []
  }
}

const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random())

// Bulk-add holdings (e.g. from a Screener export) into an existing PM
// portfolio or a newly created one, and persist straight to pm-portfolios-v2 —
// the same key/shape PortfolioManager.tsx itself reads and writes. A ticker
// already held in the target portfolio is left untouched (its existing cost
// basis isn't something an external tool should silently overwrite); only
// new tickers are appended. Returns a summary for the caller to surface.
export function addHoldingsToPortfolio(
  target: { portfolioId: string } | { newName: string },
  holdings: { ticker: string; shares: number; avgCost: number }[],
): { name: string; added: number; skipped: number; notFound?: false } | { notFound: true } {
  const raw = localStorage.getItem(PORTFOLIOS_KEY)
  let state: any
  try {
    state = raw ? JSON.parse(raw) : null
  } catch {
    state = null
  }
  if (!state?.portfolios?.length) {
    const id = uid()
    state = { portfolios: [{ id, name: 'Default', holdings: [], options: [], futures: [], cash: [] }], activeId: id }
  }

  let targetId: string
  let targetName: string
  if ('newName' in target) {
    targetId = uid()
    targetName = target.newName.trim() || 'Portfolio'
    state.portfolios.push({ id: targetId, name: targetName, holdings: [], options: [], futures: [], cash: [] })
  } else {
    const found = state.portfolios.find((p: any) => p.id === target.portfolioId)
    // Distinguish "target portfolio doesn't exist" (e.g. deleted in another tab
    // since the picker was populated) from a legitimate "0 added, all already
    // held" outcome below — collapsing them into the same added:0 shape reads
    // as a false "nothing new" when the real problem is the target vanished.
    if (!found) return { notFound: true }
    targetId = found.id
    targetName = found.name
  }

  let added = 0, skipped = 0
  state.portfolios = state.portfolios.map((p: any) => {
    if (p.id !== targetId) return p
    const existing = new Set((p.holdings ?? []).map((h: any) => normalizeTicker(h.ticker)))
    const fresh: PMHolding[] = []
    for (const h of holdings) {
      const sym = normalizeTicker(h.ticker)
      if (!sym || existing.has(sym)) { skipped++; continue }
      existing.add(sym)
      fresh.push({ ticker: sym, shares: h.shares, avgCost: h.avgCost })
      added++
    }
    return { ...p, holdings: [...(p.holdings ?? []), ...fresh] }
  })
  state.activeId = targetId

  localStorage.setItem(PORTFOLIOS_KEY, JSON.stringify(state))
  return { name: targetName, added, skipped }
}

export interface WeightedLeg { ticker: string; weight: number }
export interface ImportResult {
  legs: WeightedLeg[]     // equity legs, weights in % (cash excluded here)
  cashWeight: number      // % allocated to the CASH sleeve (0 if no cash)
  totalValue: number      // total market value of the portfolio (equity + cash), $
  note: string | null     // what was excluded (options/futures), if anything
}

// Convert a PM portfolio into market-value-weighted legs plus a cash sleeve.
// `fetchPrice` returns the live price for a ticker (or null to fall back to cost
// basis). Duplicate tickers are merged. Weights sum to ~100 across legs + cash.
export async function toWeightedLegs(
  p: PMPortfolio,
  fetchPrice: (ticker: string) => Promise<number | null>,
): Promise<ImportResult> {
  const byTicker = new Map<string, number>()   // ticker -> market value
  for (const h of p.holdings) {
    const sym = normalizeTicker(h.ticker)
    if (!sym || !h.shares) continue
    let price: number | null = null
    try { price = await fetchPrice(sym) } catch { price = null }
    const value = h.shares * (price && price > 0 ? price : h.avgCost || 0)
    if (value <= 0) continue
    byTicker.set(sym, (byTicker.get(sym) ?? 0) + value)
  }

  const cashTotal = p.cash.reduce((s, c) => s + cashValue(c), 0)
  const equityTotal = [...byTicker.values()].reduce((s, v) => s + v, 0)
  const total = equityTotal + cashTotal
  if (total <= 0) return { legs: [], cashWeight: 0, totalValue: 0, note: 'No priceable holdings to import.' }

  const legs: WeightedLeg[] = [...byTicker.entries()]
    .map(([ticker, value]) => ({ ticker, weight: Math.round((value / total) * 1000) / 10 }))
    .sort((a, b) => b.weight - a.weight)
  const cashWeight = cashTotal > 0 ? Math.round((cashTotal / total) * 1000) / 10 : 0

  const excluded: string[] = []
  if (p.optionsCount) excluded.push(`${p.optionsCount} option position${p.optionsCount > 1 ? 's' : ''}`)
  if (p.futuresCount) excluded.push(`${p.futuresCount} futures position${p.futuresCount > 1 ? 's' : ''}`)
  const note = excluded.length
    ? `Excluded ${excluded.join(' and ')} (equity-return tools only).`
    : null

  return { legs, cashWeight, totalValue: total, note }
}
