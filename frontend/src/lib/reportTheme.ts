import type { Theme } from '../contexts/ThemeContext'
import { DEFAULT_THEME } from '../contexts/ThemeContext'

// Concrete colors for the research-note PDF. html2canvas/Recharts need resolved
// hex (not CSS vars). Built from the active Settings color preset.

export interface ReportPalette {
  pageBg: string
  ink: string
  muted: string
  border: string
  /** Accent for body chrome (bands, section numbers) on pageBg. */
  accent: string
  /**
   * Accent for masthead chrome (key result value, brand, gold line).
   * Always contrast-checked against masthead — never same-as-fill.
   */
  mastheadAccent: string
  masthead: string
  onMasthead: string
  onMastheadDim: string
  panel: string
  cellBg: string
  headBg: string
  gridStroke: string
  pos: string
  neg: string
  heroTint: string
  series: string[]
  mono: string
  sans: string
  isLight: boolean
}

/** ClipRenderer-compatible slice of the report palette. */
export interface ClipPalette {
  ink: string
  muted: string
  border: string
  accent: string
  pos: string
  neg: string
  gridStroke: string
  headBg: string
  cellBg: string
  series: string[]
}

function hexLuminance(hex: string): number {
  const c = hex.replace('#', '')
  if (c.length < 6) return 0.5
  const r = parseInt(c.slice(0, 2), 16) / 255
  const g = parseInt(c.slice(2, 4), 16) / 255
  const b = parseInt(c.slice(4, 6), 16) / 255
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function parseHex(hex: string): [number, number, number] | null {
  const c = hex.replace('#', '').trim()
  if (c.length === 3) {
    return [
      parseInt(c[0] + c[0], 16),
      parseInt(c[1] + c[1], 16),
      parseInt(c[2] + c[2], 16),
    ]
  }
  if (c.length < 6) return null
  return [
    parseInt(c.slice(0, 2), 16),
    parseInt(c.slice(2, 4), 16),
    parseInt(c.slice(4, 6), 16),
  ]
}

function toHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

function mixHex(a: string, b: string, t: number): string {
  const A = parseHex(a)
  const B = parseHex(b)
  if (!A || !B) return a
  return toHex(
    A[0] + (B[0] - A[0]) * t,
    A[1] + (B[1] - A[1]) * t,
    A[2] + (B[2] - A[2]) * t,
  )
}

function withAlpha(hex: string, alpha: number): string {
  const p = parseHex(hex)
  if (!p) return hex
  return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${alpha})`
}

/** WCAG relative contrast ratio (1–21). */
function contrastRatio(a: string, b: string): number {
  const L1 = hexLuminance(a)
  const L2 = hexLuminance(b)
  const hi = Math.max(L1, L2)
  const lo = Math.min(L1, L2)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Pick a color that stays readable on `bg`. Tries candidates in order, then
 * lightens/darkens toward white/black until contrast ≥ minRatio.
 */
function ensureContrast(candidate: string, bg: string, minRatio = 3.2): string {
  if (contrastRatio(candidate, bg) >= minRatio) return candidate
  const bgLum = hexLuminance(bg)
  const toward = bgLum > 0.45 ? '#0a0a0a' : '#ffffff'
  for (const t of [0.35, 0.5, 0.65, 0.8, 0.92]) {
    const mixed = mixHex(candidate, toward, t)
    if (contrastRatio(mixed, bg) >= minRatio) return mixed
  }
  return toward
}

export function buildReportPalette(theme: Theme = DEFAULT_THEME): ReportPalette {
  const isLight = hexLuminance(theme.bgColor) > 0.18
  const primary = theme.primaryColor
  const secondary = theme.secondaryColor
  const tertiary = theme.tertiaryColor
  const bg = theme.bgColor
  const surface = theme.surfaceColor
  const chartN = theme.chartNeutralColor || '#4a7fa5'

  const pos = isLight ? '#15803d' : '#22c55e'
  const neg = isLight ? '#b91c1c' : '#ef4444'

  // Body text: dark ink on light paper, light ink on dark terminal notes.
  const ink = isLight
    ? (hexLuminance(primary) < 0.12 ? primary : '#1a2332')
    : '#d7e3fc'
  const muted = secondary

  // Masthead: dark surface on dark presets; primary (usually deep) on light ones.
  const masthead = isLight
    ? (hexLuminance(primary) < 0.45 ? primary : mixHex(primary, '#0f172a', 0.55))
    : surface
  const mastheadLum = hexLuminance(masthead)
  const onMasthead = mastheadLum > 0.45 ? '#1a2332' : '#f0f4fa'
  const onMastheadDim = mastheadLum > 0.45 ? withAlpha('#1a2332', 0.62) : withAlpha('#f0f4fa', 0.62)

  // Body accent — readable on pageBg (not on masthead).
  const pageBg = isLight ? (hexLuminance(bg) > 0.9 ? '#ffffff' : bg) : bg
  const accent = ensureContrast(primary, pageBg, 3)

  // Masthead accents: primary often *is* the masthead on light presets
  // (Rosewood/Crimson) so key-result value painted in primary vanishes.
  // Prefer tertiary, then a lightened primary, then onMasthead.
  let mastheadAccent = tertiary
  if (contrastRatio(mastheadAccent, masthead) < 3.2) {
    mastheadAccent = ensureContrast(primary, masthead, 3.2)
  }
  if (contrastRatio(mastheadAccent, masthead) < 3.2) {
    mastheadAccent = onMasthead
  }

  const border = isLight ? withAlpha('#0f172a', 0.12) : withAlpha('#ffffff', 0.12)
  const panel = isLight ? mixHex(surface, '#ffffff', 0.35) : mixHex(surface, bg, 0.35)
  const cellBg = isLight ? '#ffffff' : surface
  const headBg = isLight ? mixHex(surface, '#ffffff', 0.15) : mixHex(surface, '#ffffff', 0.04)
  const gridStroke = isLight ? withAlpha('#0f172a', 0.08) : withAlpha('#ffffff', 0.08)
  const heroTint = isLight
    ? mixHex(primary, '#ffffff', 0.92)
    : mixHex(primary, surface, 0.88)

  const series = [
    primary,
    tertiary,
    chartN,
    pos,
    mixHex(primary, tertiary, 0.45),
    mixHex(tertiary, chartN, 0.4),
  ]

  const monoFamily = theme.primaryFont === 'San Francisco'
    ? 'ui-monospace, SFMono-Regular, Menlo, monospace'
    : `'${theme.primaryFont}', ui-monospace, monospace`
  const sansFamily = `'${theme.secondaryFont}', system-ui, sans-serif`

  return {
    pageBg,
    ink,
    muted,
    border,
    accent,
    mastheadAccent,
    masthead,
    onMasthead,
    onMastheadDim,
    panel,
    cellBg,
    headBg,
    gridStroke,
    pos,
    neg,
    heroTint,
    series,
    mono: monoFamily,
    sans: sansFamily,
    isLight,
  }
}

export function toClipPalette(rp: ReportPalette): ClipPalette {
  return {
    ink: rp.ink,
    muted: rp.muted,
    border: rp.border,
    accent: rp.accent,
    pos: rp.pos,
    neg: rp.neg,
    gridStroke: rp.gridStroke,
    headBg: rp.headBg,
    cellBg: rp.cellBg,
    series: rp.series,
  }
}
