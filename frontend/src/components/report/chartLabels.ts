export interface HorizontalCategoryLabel {
  primary: string
  secondary?: string
}

const TICKER = /^[A-Z0-9][A-Z0-9.-]{0,7}$/

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

export function formatHorizontalCategoryLabel(
  value: unknown,
  maxPrimaryLength = 20,
): HorizontalCategoryLabel {
  const label = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!label) return { primary: '—' }

  const parts = label.split(/\s+·\s+/).map(part => part.trim()).filter(Boolean)
  if (parts.length < 2) return { primary: truncate(label, maxPrimaryLength) }

  const first = parts[0]
  const last = parts[parts.length - 1]
  const firstIsTicker = TICKER.test(first)
  const lastIsTicker = TICKER.test(last)
  const primary = firstIsTicker && !lastIsTicker ? last : first
  const secondary = lastIsTicker ? last : firstIsTicker ? first : parts.slice(1).join(' · ')

  return {
    primary: truncate(primary, maxPrimaryLength),
    secondary: truncate(secondary, 12),
  }
}

export function horizontalCategoryAxisWidth(values: unknown[], print: boolean): number {
  const maxPrimaryLength = print ? 26 : 22
  const primaryGlyphWidth = print ? 4.1 : 5
  const secondaryGlyphWidth = print ? 4 : 4.6
  const contentWidth = Math.max(
    0,
    ...values.map(value => {
      const label = formatHorizontalCategoryLabel(value, maxPrimaryLength)
      return (
        label.primary.length * primaryGlyphWidth
        + (label.secondary?.length ?? 0) * secondaryGlyphWidth
        + (label.secondary ? (print ? 7 : 9) : 0)
      )
    }),
  )
  return Math.min(
    print ? 168 : 164,
    Math.max(print ? 112 : 120, contentWidth + (print ? 14 : 18)),
  )
}

/** Where a diverging horizontal bar's value label goes, and which way it reads.
 *
 *  Recharts gives a bar's rect as [x, x + width] with width always positive, so
 *  for a NEGATIVE bar `x + width` is the ZERO line and `x` is the outer tip.
 *  Placing every label at `x + width` therefore anchored negative labels to the
 *  wrong end: they read back across their own bar and, on the long ones, out of
 *  the plot and into the category axis, which printed as
 *  "XLU Utiliti-4.41 pp".
 *
 *  `plotLeft` is where the plotting area starts (the category axis boundary). A
 *  label that would cross it flips inside the bar instead, because a label
 *  sitting on the axis text is worse than one sitting on its own bar.
 */
export function divergingBarLabel(
  { x, width, value, plotLeft = 0, charWidth = 4.6, text = '' }:
  { x: number; width: number; value: number; plotLeft?: number; charWidth?: number; text?: string },
): { x: number; anchor: 'start' | 'end'; inside: boolean } {
  const negative = value < 0
  const tip = negative ? x : x + width
  if (!negative) return { x: tip + 4, anchor: 'start', inside: false }

  const needed = text.length * charWidth
  const wouldCrossAxis = tip - 4 - needed < plotLeft
  return wouldCrossAxis
    ? { x: tip + 4, anchor: 'start', inside: true }
    : { x: tip - 4, anchor: 'end', inside: false }
}
