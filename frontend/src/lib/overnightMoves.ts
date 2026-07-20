// Pure helpers for the Morning Brief's Overnight section: merge book +
// watchlist into one scan universe, tag a gapping name with an earnings
// cause, and detect an overnight cross of the dealer gamma-flip level.

import { daysUntil } from './morningBriefInsights'

export interface OvernightRow {
  ticker: string
  priorClose: number | null
  last: number | null
  changePct: number | null
}

export interface EarningsRow {
  symbol: string
  date: string
  hour?: string
}

export type EarningsCause =
  | { kind: 'reported-amc-yesterday' }
  | { kind: 'reports-bmo-today' }
  | { kind: 'reports-amc-today' }
  | { kind: 'reports-soon'; days: number }

/** Book tickers first (priority), then watchlist, deduped uppercase, capped
 * so the overnight scan can't balloon past what the endpoint budgets for. */
export function buildOvernightUniverse(
  bookTickers: string[],
  watchlistTickers: string[],
  cap = 40,
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of [...bookTickers, ...watchlistTickers]) {
    const sym = t.trim().toUpperCase()
    if (!sym || seen.has(sym)) continue
    seen.add(sym)
    out.push(sym)
    if (out.length >= cap) break
  }
  return out
}

/** Earnings-driven cause tag for a gapping name, or null if none applies. */
export function earningsCause(symbol: string, rows: EarningsRow[], from = new Date()): EarningsCause | null {
  const sym = symbol.toUpperCase()
  const row = rows.find(r => r.symbol.toUpperCase() === sym)
  if (!row || !row.date) return null
  const days = daysUntil(row.date, from)
  if (days === -1 && row.hour === 'amc') return { kind: 'reported-amc-yesterday' }
  if (days === 0 && row.hour === 'bmo') return { kind: 'reports-bmo-today' }
  if (days === 0 && row.hour === 'amc') return { kind: 'reports-amc-today' }
  if (days >= 1 && days <= 3) return { kind: 'reports-soon', days }
  return null
}

/** True when the overnight move carried price across the dealer gamma-flip
 * level recorded in the latest GEX snapshot — the same cross test the
 * price_cross_gex_flip alert condition uses (routers/alerts.py). */
export function crossedGammaFlip(
  priorClose: number | null,
  last: number | null,
  flip: number | null | undefined,
): boolean {
  if (priorClose == null || last == null || flip == null) return false
  return (priorClose - flip) * (last - flip) < 0
}

/** Rows with a computed % move, largest absolute move first. Rows with no
 * move yet (endpoint still loading, or no data for that ticker) drop out. */
export function sortByAbsMove(rows: OvernightRow[]): OvernightRow[] {
  return [...rows]
    .filter((r): r is OvernightRow & { changePct: number } => r.changePct != null)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
}
