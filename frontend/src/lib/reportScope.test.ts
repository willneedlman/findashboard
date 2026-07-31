import { describe, it, expect } from 'vitest'
import { defaultScope, normalizeScope, timeframeLabel } from './reportCreator'

describe('report setup scope', () => {
  it('starts a new project in the setup flow', () => {
    const s = defaultScope()
    expect(s.setupComplete).toBe(false)
    expect(s.reportType).toBe('equity-note')
    expect(s.layoutPreset).toBe('editorial')
  })

  it('treats a project stored before setup existed as already configured', () => {
    // It was configured by hand, so sending it back through the stepper would be
    // a regression for every existing project.
    const legacy = normalizeScope({ goal: 'Compare NVDA and AAPL', lookbackPreset: 'last90' })
    expect(legacy.setupComplete).toBe(true)

    const legacyBySymbols = normalizeScope({ researchSymbols: 'MSFT' })
    expect(legacyBySymbols.setupComplete).toBe(true)
  })

  it('sends a genuinely empty project through setup', () => {
    expect(normalizeScope({}).setupComplete).toBe(false)
    expect(normalizeScope(null).setupComplete).toBe(false)
  })

  it('honours an explicit setupComplete over the legacy inference', () => {
    expect(normalizeScope({ goal: 'x', setupComplete: false }).setupComplete).toBe(false)
    expect(normalizeScope({ setupComplete: true }).setupComplete).toBe(true)
  })

  it('falls back to defaults on unknown type or layout', () => {
    const s = normalizeScope({ reportType: 'nope' as never, layoutPreset: 'nope' as never })
    expect(s.reportType).toBe('equity-note')
    expect(s.layoutPreset).toBe('editorial')
  })

  it('round-trips every valid type and layout', () => {
    for (const t of ['equity-note', 'comparison', 'macro-brief', 'portfolio-review', 'screen-summary', 'thesis'] as const) {
      expect(normalizeScope({ reportType: t }).reportType).toBe(t)
    }
    for (const l of ['editorial', 'visual-first', 'data-dense', 'narrative'] as const) {
      expect(normalizeScope({ layoutPreset: l }).layoutPreset).toBe(l)
    }
  })

  it('supports fixed long-range and open-ended outlooks', () => {
    for (const lookforwardPreset of ['next365', 'next3y', 'next5y', 'next10y', 'unlimited'] as const) {
      expect(normalizeScope({ lookforwardPreset }).lookforwardPreset).toBe(lookforwardPreset)
    }
    expect(timeframeLabel({ ...defaultScope(), lookbackPreset: 'none', lookforwardPreset: 'next10y' })).toBe('Next 10 years')
    expect(timeframeLabel({ ...defaultScope(), lookbackPreset: 'none', lookforwardPreset: 'unlimited' })).toBe('Open-ended outlook')
  })
})
