import { useTheme } from '../contexts/ThemeContext'

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function withAlpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${a})`
}

// Darken a hex color by a ratio (0=black, 1=unchanged)
function darken(hex: string, ratio: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgb(${Math.round(r * ratio)},${Math.round(g * ratio)},${Math.round(b * ratio)})`
}

export function useChartColors() {
  const { theme } = useTheme()
  const primary   = theme.primaryColor    // gold accent
  const tertiary  = theme.tertiaryColor   // blue accent
  const secondary = theme.secondaryColor  // muted

  // Semantic fixed colors — red stays red (loss/negative), green stays green (gain/positive)
  const LOSS = '#8c2e36'
  const GAIN = '#2e7d4f'

  return {
    // Primary series — uses theme primary (e.g. gold)
    c1:       primary,
    c1Muted:  withAlpha(primary, 0.5),
    c1Dim:    withAlpha(primary, 0.18),

    // Secondary series — uses theme tertiary (e.g. blue)
    c2:       tertiary,
    c2Muted:  withAlpha(tertiary, 0.6),
    c2Dim:    withAlpha(tertiary, 0.18),

    // Tertiary series — darkened primary for contrast
    c3:       darken(primary, 0.65),
    c3Muted:  withAlpha(darken(primary, 0.65), 0.6),

    // Semantic colors (semantic meaning overrides theme)
    gain:       GAIN,
    gainMuted:  withAlpha(GAIN, 0.75),
    loss:       LOSS,
    lossMuted:  withAlpha(LOSS, 0.75),

    // Muted grid / secondary text
    muted:    secondary,
    gridLine: 'rgba(128,128,128,0.07)',

    // Raw theme values for direct use
    primary,
    tertiary,
    secondary,

    // Tooltip style
    tooltipStyle: {
      background: 'var(--theme-surface, #142032)',
      border: `1px solid color-mix(in srgb, ${primary} 35%, transparent)`,
      borderRadius: 0,
    } as React.CSSProperties,
  }
}
