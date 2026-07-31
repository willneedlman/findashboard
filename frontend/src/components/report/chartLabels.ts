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
