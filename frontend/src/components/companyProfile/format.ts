// Formatting for the Company Profile surface.
//
// The brief's rule is that a figure is either printed or explained, never
// zeroed and never silently dropped. So every helper here takes a null and
// returns something a reader can act on, and the CALLER decides which absence
// it is looking at: "None declared" for a dividend that does not exist is a
// different fact from an em-dash for a quote we could not read, and only the
// call site knows which one applies.

/** Yahoo's own em-dash for a value that exists but cannot be computed. */
export const DASH = '—'

const finite = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** Money at the magnitude a reader thinks in. Never scientific notation. */
export function compact(v: unknown, dp = 2): string {
  const n = finite(v)
  if (n === null) return DASH
  const abs = Math.abs(n)
  if (abs >= 1e12) return `${(n / 1e12).toFixed(dp)}T`
  if (abs >= 1e9) return `${(n / 1e9).toFixed(dp)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(dp)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return n.toFixed(dp)
}

/** A plain price. Two decimals, because a quote is quoted that way. */
export function price(v: unknown, dp = 2): string {
  const n = finite(v)
  return n === null ? DASH : n.toFixed(dp)
}

/** A share or contract count, grouped. Volume is read by its shape. */
export function count(v: unknown): string {
  const n = finite(v)
  return n === null ? DASH : Math.round(n).toLocaleString('en-US')
}

/** A multiple. One decimal is the precision a multiple deserves. */
export function multiple(v: unknown, dp = 2): string {
  const n = finite(v)
  return n === null ? DASH : n.toFixed(dp)
}

/** A percent already expressed as a percent (12.4 means 12.4%). */
export function pct(v: unknown, dp = 1, signed = false): string {
  const n = finite(v)
  if (n === null) return DASH
  const sign = signed && n > 0 ? '+' : ''
  return `${sign}${n.toFixed(dp)}%`
}

/** A percent expressed as a rate (0.124 means 12.4%). */
export function ratePct(v: unknown, dp = 1, signed = false): string {
  const n = finite(v)
  return n === null ? DASH : pct(n * 100, dp, signed)
}

/** Two figures as a range. Absent unless BOTH ends are known: half a range is
 *  not a range, and printing "465.29 - —" reads as a broken cell. */
export function range(lo: unknown, hi: unknown, dp = 2): string {
  const a = finite(lo)
  const b = finite(hi)
  return a === null || b === null ? DASH : `${a.toFixed(dp)} - ${b.toFixed(dp)}`
}

/** A quote with its size, which is how a book is read: "448.89 x 100". */
export function quoteWithSize(p: unknown, size: unknown): string {
  const a = finite(p)
  if (a === null) return DASH
  const s = finite(size)
  // Vendor size is in round lots. A bare number here would be read as shares.
  return s === null ? a.toFixed(2) : `${a.toFixed(2)} x ${Math.round(s) * 100}`
}

/** Signed change and its percent, the way a tape prints it. */
export function change(abs: unknown, percent: unknown, dp = 2): string {
  const a = finite(abs)
  const p = finite(percent)
  if (a === null && p === null) return DASH
  const sign = (a ?? p ?? 0) > 0 ? '+' : ''
  const left = a === null ? '' : `${sign}${a.toFixed(dp)} `
  const right = p === null ? '' : `(${sign}${p.toFixed(2)}%)`
  return `${left}${right}`.trim()
}

/** The token for a directional value. Colour never carries the meaning alone,
 *  so every caller prints the number beside whatever this returns. */
export function tone(v: unknown, neutral = 'var(--theme-text)'): string {
  const n = finite(v)
  if (n === null || n === 0) return neutral
  return n > 0 ? 'var(--theme-positive)' : 'var(--theme-negative)'
}

/** A dividend cell. The absence is a fact about the company, not a gap in the
 *  data, so it is named rather than dashed. */
export function dividend(rate: unknown, yieldPct: unknown): string {
  const r = finite(rate)
  const y = finite(yieldPct)
  if (r === null && y === null) return 'None declared'
  const parts: string[] = []
  if (r !== null) parts.push(r.toFixed(2))
  if (y !== null) parts.push(`(${y.toFixed(2)}%)`)
  return parts.join(' ')
}

/** "Nov 3, 2026" from an ISO date or an epoch. */
export function shortDate(v: unknown): string {
  if (v == null) return DASH
  const d = typeof v === 'number' ? new Date(v * 1000) : new Date(String(v))
  if (Number.isNaN(d.getTime())) return DASH
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
