import { describe, expect, it } from 'vitest'
import {
  coverageNote,
  formatReportCell,
  niceAxisMax,
  normalizeFigureKey,
  peerSetNote,
  retitleToPlottedRange,
  tidyNumbersInText,
  weightBasisNote,
} from './reportFigures'
import type { ChartPayload, TablePayload } from './reportCreator'

describe('formatReportCell', () => {
  it('gives one quantity one precision wherever it appears', () => {
    // The same book printed betas at four decimals in a table, three in the
    // factor panel, two in a chart, and two in a KPI.
    expect(formatReportCell('2.3548', 'Market beta')).toBe('2.35')
    expect(formatReportCell('1.181', 'Market beta')).toBe('1.18')
    expect(formatReportCell(10.77, 'T-statistic')).toBe('10.77')
  })

  it('pads bare integers sitting in a decimal column', () => {
    expect(formatReportCell('10', 'Book variance share %')).toBe('10.0')
    expect(formatReportCell('6', 'Weight %')).toBe('6.0')
  })

  it('keeps sign, currency and unit', () => {
    expect(formatReportCell('-25.83%', 'Max drawdown %')).toBe('−25.8%')
    expect(formatReportCell('$274.481', 'Market price')).toBe('$274.48')
    expect(formatReportCell('+16.04', 'Active return %')).toBe('+16.0')
  })

  it('leaves labels, dates and unmatched columns alone', () => {
    expect(formatReportCell('NVDA', 'Ticker')).toBe('NVDA')
    expect(formatReportCell('2026-08-12', 'Report date')).toBe('2026-08-12')
    expect(formatReportCell('Corporate Hub provider classification', 'Basis'))
      .toBe('Corporate Hub provider classification')
  })

  it('reads a correlation matrix off its sibling columns', () => {
    expect(formatReportCell('1', 'NVDA', ['Correlation', 'NVDA', 'ORCL'])).toBe('1.00')
    expect(formatReportCell('-0.18', 'ORCL', ['Correlation', 'NVDA', 'ORCL'])).toBe('−0.18')
  })
})

describe('tidyNumbersInText', () => {
  it('trims false precision out of a definition cell', () => {
    expect(tidyNumbersInText('Annualized daily excess return · 3.740% risk-free rate'))
      .toBe('Annualized daily excess return · 3.74% risk-free rate')
  })
})

const allocation: TablePayload = {
  kind: 'table',
  title: 'Current allocation',
  columns: ['Ticker', 'Weight %'],
  rows: [['NVDA', '13.31'], ['MSFT', '6.8'], ['VST', '3.3'], ['CASH', '6.58']],
}

const riskTable: TablePayload = {
  kind: 'table',
  title: 'Holding-level beta and portfolio risk contribution',
  columns: ['Ticker', 'Weight %', 'Market beta'],
  rows: [['NVDA', '14.3', '2.3548'], ['MSFT', '7.3', '1.1316']],
}

describe('weightBasisNote', () => {
  it('names the basis so two weight columns cannot be read as one', () => {
    // 13.31% and 14.3% were the same position on two different bases, and
    // neither figure said so.
    const withCash: TablePayload = {
      ...allocation,
      rows: [['NVDA', '13.31'], ['MSFT', '40'], ['VST', '40.11'], ['CASH', '6.58']],
    }
    expect(weightBasisNote(withCash)).toContain('cash included')
    const exCash: TablePayload = {
      ...riskTable,
      rows: [['NVDA', '14.3'], ['MSFT', '85.7']],
    }
    expect(weightBasisNote(exCash)).toContain('cash excluded')
  })

  it('stays silent when the column is not a full allocation', () => {
    expect(weightBasisNote(riskTable)).toBeUndefined()
  })
})

describe('coverageNote', () => {
  it('names the holdings a matrix quietly leaves out', () => {
    const note = coverageNote(['NVDA', 'MSFT'], ['NVDA', 'MSFT', 'MSTR', 'TSLL', 'OWL', 'VST'])
    expect(note).toBe('Excludes 4 holdings: MSTR, TSLL, OWL, VST.')
  })

  it('says nothing when coverage is complete', () => {
    expect(coverageNote(['NVDA', 'MSFT'], ['NVDA', 'MSFT', 'CASH'])).toBeUndefined()
  })
})

describe('peerSetNote', () => {
  const chart = (categories: string[]): ChartPayload => ({
    kind: 'chart',
    chartType: 'bar',
    title: 'Consensus upside across the peer set',
    xKey: 'company',
    data: categories.map(company => ({ company, value: 20 })),
    series: [{ key: 'value', label: 'Upside', unit: 'percent' }],
  })

  it('flags a chart whose names are mostly not held', () => {
    const note = peerSetNote(chart(['NVDA', 'AVGO', 'AMD', 'INTC', 'TXN']), ['NVDA', 'MSFT'])
    expect(note).toBe('Peer set, not portfolio holdings: 4 of 5 names are not held.')
  })

  it('says nothing about a chart of the book itself', () => {
    expect(peerSetNote(chart(['NVDA', 'MSFT', 'ORCL']), ['NVDA', 'MSFT', 'ORCL'])).toBeUndefined()
  })
})

describe('retitleToPlottedRange', () => {
  it('restates a caption from the points the figure actually plots', () => {
    // The caption promised January to August over a series starting in March.
    const chart: ChartPayload = {
      kind: 'chart',
      chartType: 'line',
      title: 'Active return vs SPY · 2026-01-01 to 2026-08-09',
      xKey: 'date',
      data: [{ date: '2026-03-09', value: 0 }, { date: '2026-07-27', value: 18 }],
      series: [{ key: 'value', label: 'Active return', unit: 'percentage-point' }],
    }
    expect(retitleToPlottedRange(chart.title!, chart))
      .toBe('Active return vs SPY · 2026-03-09 to 2026-07-27')
  })
})

describe('normalizeFigureKey', () => {
  it('collapses one measurement stated three ways', () => {
    const a = normalizeFigureKey('Maximum drawdown', '-25.8%')
    expect(normalizeFigureKey('Max drawdown (portfolio)', '-25.8%')).toBe(a)
    expect(normalizeFigureKey('Historical max drawdown', '-25.8%')).toBe(a)
  })

  it('keeps the benchmark own figure separate', () => {
    expect(normalizeFigureKey('Max drawdown (SPY)', '-6.6%'))
      .not.toBe(normalizeFigureKey('Maximum drawdown', '-25.8%'))
  })
})

describe('niceAxisMax', () => {
  it('stops just past the data instead of doubling it', () => {
    // An 8.00 ceiling over a 4.20 maximum left half the plot empty.
    expect(niceAxisMax([1.83, 2.14, 4.2, 0.7])).toBe(5)
    expect(niceAxisMax([35, 72, 26, 13])).toBe(75)
    expect(niceAxisMax([])).toBeUndefined()
  })
})
