import { describe, expect, it } from 'vitest'
import { DEFAULT_THEME, type Theme } from '../contexts/ThemeContext'
import { buildReportPalette } from './reportTheme'

function lum(hex: string): number {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16) / 255
  const g = parseInt(c.slice(2, 4), 16) / 255
  const b = parseInt(c.slice(4, 6), 16) / 255
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: string, b: string): number {
  const L1 = lum(a)
  const L2 = lum(b)
  const hi = Math.max(L1, L2)
  const lo = Math.min(L1, L2)
  return (hi + 0.05) / (lo + 0.05)
}

const ROSEWOOD: Theme = {
  ...DEFAULT_THEME,
  primaryColor: '#881337',
  secondaryColor: '#5a1c1c',
  tertiaryColor: '#c47878',
  bgColor: '#fdf4f4',
  surfaceColor: '#e8d5d5',
}

const CRIMSON: Theme = {
  ...DEFAULT_THEME,
  primaryColor: '#e11d48',
  secondaryColor: '#c99caa',
  tertiaryColor: '#fda4af',
  bgColor: '#2c0216',
  surfaceColor: '#160310',
}

describe('buildReportPalette masthead contrast', () => {
  it('keeps key-result accent readable on Rosewood masthead', () => {
    const p = buildReportPalette(ROSEWOOD)
    // Masthead is primary — same-color accent would vanish
    expect(p.masthead.toLowerCase()).toBe('#881337')
    expect(contrast(p.mastheadAccent, p.masthead)).toBeGreaterThanOrEqual(3)
  })

  it('keeps key-result accent readable on Crimson Night masthead', () => {
    const p = buildReportPalette(CRIMSON)
    expect(contrast(p.mastheadAccent, p.masthead)).toBeGreaterThanOrEqual(3)
  })

  it('keeps Terminal Gold accent readable on dark surface masthead', () => {
    const p = buildReportPalette(DEFAULT_THEME)
    expect(contrast(p.mastheadAccent, p.masthead)).toBeGreaterThanOrEqual(3)
  })
})
