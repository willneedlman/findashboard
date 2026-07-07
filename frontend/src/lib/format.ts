// Shared number formatters so widgets render the same value identically.

// Abbreviated market cap: $1.23T / $45.6B / $789M.
export function fmtMarketCap(v: number | null | undefined): string {
  if (v == null) return '—'
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(1)}B`
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(0)}M`
  return `$${v.toLocaleString()}`
}

// Fixed-decimal number with an em-dash placeholder. The typeof guard also
// rejects non-number shapes from loosely-typed API responses.
export function fmtNum(v: unknown, digits = 2, suffix = ''): string {
  return typeof v !== 'number' || Number.isNaN(v) ? '—' : `${v.toFixed(digits)}${suffix}`
}
