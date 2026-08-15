// Whether the tape is paying for defensives or cyclicals.
//
// The page used to answer this with breadth: how many sectors beat SPY. Narrow
// leadership got labelled "Defensive rotation" regardless of who was leading, so
// a ranking of XLE first, XLK third and XLU last (the textbook cyclical shape)
// printed DEFENSIVE ROTATION over its own table. Breadth is a real measurement
// and it stays on the page; it is just not this measurement.

export const DEFENSIVE_SECTORS = ['XLU', 'XLP', 'XLV']
export const CYCLICAL_SECTORS = ['XLK', 'XLY', 'XLI', 'XLE']

// Below this the two baskets are not meaningfully apart and the honest label is
// Mixed. Percentage points of period return.
const DECISIVE_SPREAD_PP = 1.5

export type LeadershipTone = 'defensive' | 'cyclical' | 'mixed'

export interface Leadership {
  tone: LeadershipTone
  label: string
  spread: number | null
  defensive: number | null
  cyclical: number | null
}

function basketMean(
  rows: { ticker: string; value: number | null }[],
  tickers: string[],
): number | null {
  const values = rows
    .filter(r => tickers.includes(r.ticker) && r.value != null)
    .map(r => r.value as number)
  if (!values.length) return null
  return values.reduce((sum, v) => sum + v, 0) / values.length
}

export function sectorLeadership(rows: { ticker: string; value: number | null }[]): Leadership {
  const defensive = basketMean(rows, DEFENSIVE_SECTORS)
  const cyclical = basketMean(rows, CYCLICAL_SECTORS)
  if (defensive == null || cyclical == null) {
    return { tone: 'mixed', label: 'Mixed leadership', spread: null, defensive, cyclical }
  }
  const spread = defensive - cyclical
  if (spread >= DECISIVE_SPREAD_PP) {
    return { tone: 'defensive', label: 'Defensive rotation', spread, defensive, cyclical }
  }
  if (spread <= -DECISIVE_SPREAD_PP) {
    return { tone: 'cyclical', label: 'Cyclical rotation', spread, defensive, cyclical }
  }
  return { tone: 'mixed', label: 'Mixed leadership', spread, defensive, cyclical }
}
