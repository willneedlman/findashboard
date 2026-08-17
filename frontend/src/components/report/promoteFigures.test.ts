import { describe, expect, it } from 'vitest'
import { promoteKeyFiguresToChart, splitFigureLabel, promoteTableToChart } from './SectionLayout'

/**
 * From a delivered report (AI Momentum Trade, 17 Aug 2026). Three of its four
 * figures were the section's own KPI strip redrawn as the same horizontal bar
 * chart, titled "<Section> · Key Figures", printed beside a rail of the very
 * same numbers. The fourth had volume on its x axis.
 */
describe('splitFigureLabel', () => {
  it('reads the subject out of a parenthesised label', () => {
    expect(splitFigureLabel('Revenue Growth (NVDA)')).toEqual({ metric: 'Revenue Growth', subject: 'NVDA' })
    expect(splitFigureLabel('P/E (Peer Median)')).toEqual({ metric: 'P/E', subject: 'Peer Median' })
  })

  it('reads a leading ticker', () => {
    expect(splitFigureLabel('NVDA EV/EBITDA')).toEqual({ metric: 'EV/EBITDA', subject: 'NVDA' })
  })

  it('leaves a bare metric without a subject', () => {
    expect(splitFigureLabel('Spot price')).toEqual({ metric: 'Spot price' })
  })
})

describe('promoting key figures to a chart', () => {
  const fig = (label: string, value: string) => ({ label, value })

  it('refuses to plot different quantities that share a unit', () => {
    // "P/E 34.5x" beside "EV/EBITDA 32.7x" compares nothing: two different
    // measures that both end in "x". This was Figure 1.
    expect(promoteKeyFiguresToChart(
      [fig('P/E (NVDA)', '34.5x'), fig('EV/EBITDA (NVDA)', '32.7x')], 'Relative Call',
    )).toBeUndefined()
  })

  it('refuses a two-bar chart that restates the strip beside it', () => {
    expect(promoteKeyFiguresToChart(
      [fig('P/E (NVDA)', '34.5x'), fig('P/E (Peer Median)', '61.6x')], 'Valuation Comparison',
    )).toBeUndefined()
  })

  it('draws one measure across several names', () => {
    const chart = promoteKeyFiguresToChart([
      fig('P/E (NVDA)', '34.5x'), fig('P/E (AMD)', '129.4x'),
      fig('P/E (AVGO)', '65.3x'), fig('P/E (MU)', '22.9x'),
      fig('Revenue Growth (NVDA)', '85.2%'),
    ], 'Valuation Comparison')
    expect(chart).toBeDefined()
    expect(chart!.data.map(d => d.metric)).toEqual(['NVDA', 'AMD', 'AVGO', 'MU'])
    expect(chart!.title).toBe('P/E by name')
  })

  it('titles by what it compares, not by where it sits', () => {
    const chart = promoteKeyFiguresToChart([
      fig('90-day max drawdown (NVDA)', '-18.1%'),
      fig('90-day max drawdown (AMD)', '-27.0%'),
      fig('90-day max drawdown (MU)', '-42.5%'),
    ], 'Market Context')
    expect(chart!.title).not.toContain('Key Figures')
    expect(chart?.title?.toLowerCase()).toContain('drawdown')
  })

  it('keeps a real composition as a pie', () => {
    const chart = promoteKeyFiguresToChart([
      fig('Revenue share (Compute)', '75.2%'), fig('Revenue share (Networking)', '14.5%'),
      fig('Revenue share (Gaming)', '7.4%'), fig('Revenue share (Other)', '2.9%'),
    ], 'Segment Mix')
    expect(chart!.chartType).toBe('pie')
  })
})

