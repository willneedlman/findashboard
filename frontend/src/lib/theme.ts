// Single source of truth for theme color strings used in inline styles / charts.
// Every value routes through a --theme-* custom property (set per-user in
// ThemeContext) with the dark default as the fallback, so colors adapt to the
// active theme. Per-file `const C/T/S = {...}` color maps should collapse into
// this import.
export const T = {
  bg:          'var(--theme-bg, #101c2e)',
  surface:     'var(--theme-surface, #0d1826)',
  border:      'var(--theme-border, rgba(255,255,255,0.08))',
  borderFaint: 'var(--theme-border-faint, rgba(255,255,255,0.05))',
  hover:       'var(--theme-hover, rgba(0,0,0,0.12))',
  strip:       'var(--theme-strip, rgba(0,0,0,0.16))',
  gold:        'var(--theme-primary, #c9a84c)',
  blue:        'var(--theme-tertiary, #60a5fa)',
  muted:       'var(--theme-secondary, #8099b0)',
  text:        'var(--theme-text, #d7e3fc)',
  textDim:     'var(--theme-text-dim)',
  mono:        'var(--theme-mono)',
  label:       'var(--theme-sans)',
  pos:         'var(--theme-positive, #22c55e)',
  neg:         'var(--theme-negative, #ef4444)',
  warn:        'var(--theme-warn, #e8c04a)',
  chartNeutral:'var(--theme-chart-neutral, #4a7fa5)',
  violet:      'var(--theme-accent-violet, #a78bfa)',
  orange:      'var(--theme-accent-orange, #f97316)',
  goldTint:  (pct: number) => `color-mix(in srgb, var(--theme-primary) ${pct}%, transparent)`,
  posTint:   (pct: number) => `color-mix(in srgb, var(--theme-positive) ${pct}%, transparent)`,
  negTint:   (pct: number) => `color-mix(in srgb, var(--theme-negative) ${pct}%, transparent)`,
}

/** A translucent version of any colour, hex or `var()`.
 *
 *  Use this instead of appending an alpha-hex suffix. `${color}22` produced a
 *  valid 8-digit hex back when the colour was a literal, and the day the
 *  literal became `var(--theme-negative)` it started producing
 *  `var(--theme-negative)22` — not a colour, so the browser drops the whole
 *  declaration and the element renders with no fill at all. */
export const alpha = (color: string, pct: number) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`

// Resolve a --theme-* token to a concrete value where a string is required at
// call time (e.g. lightweight-charts series options). Re-read on theme change.
export const readToken = (name: string, fallback = '') =>
  (typeof document !== 'undefined'
    ? getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    : '') || fallback
