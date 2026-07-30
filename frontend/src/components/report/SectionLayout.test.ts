import { describe, expect, it } from 'vitest'
import {
  assignBodyVisuals,
  assignReportBodyVisuals,
  preferChartVisual,
  promoteKeyFiguresToChart,
  promoteTableToChart,
  reportSectionAssignmentKey,
  normalizeReportSectionLayout,
  resolveReportSectionLayout,
} from './SectionLayout'
import type { ReportClip } from '../../lib/reportCreator'

function chart(id: string, title: string, sourceTab = 'Implied Probability'): ReportClip {
  return {
    id,
    sourceTab,
    dataType: 'chart',
    capturedAt: '',
    projectId: 'p1',
    payload: {
      kind: 'chart',
      title,
      chartType: 'line',
      xKey: 'x',
      data: [{ x: 1, a: 2 }],
      series: [{ key: 'a', label: 'a' }],
    },
  }
}

function kpi(id: string, sourceTab = 'Implied Probability'): ReportClip {
  return {
    id,
    sourceTab,
    dataType: 'kpi',
    capturedAt: '',
    projectId: 'p1',
    payload: {
      kind: 'kpi',
      title: 'Metrics',
      cells: [{ label: 'A', value: '1' }],
    },
  }
}

describe('report section composition', () => {
  it('accepts only the internal layout vocabulary', () => {
    expect(normalizeReportSectionLayout('wrap-left')).toBe('wrap-left')
    expect(normalizeReportSectionLayout('evidence-band')).toBe('evidence-band')
    expect(normalizeReportSectionLayout('hero-grid')).toBeUndefined()
    expect(normalizeReportSectionLayout(null)).toBeUndefined()
  })

  it('lets compact categorical visuals use wrapped editorial layouts', () => {
    const compact = chart('compact', 'Peer Upside')
    compact.payload = {
      kind: 'chart',
      title: 'Peer Upside',
      chartType: 'bar',
      barOrientation: 'horizontal',
      xKey: 'company',
      data: [
        { company: 'MCD', upside: 4 },
        { company: 'YUM', upside: 8 },
        { company: 'WEN', upside: 12 },
      ],
      series: [{ key: 'upside', label: 'Upside %' }],
    }
    expect(resolveReportSectionLayout({
      requested: 'wrap-right',
      visual: compact,
      analysis: 'The compact peer comparison supports the valuation conclusion.',
      keyFigures: [{ label: 'Leader', value: 'WEN' }],
    })).toBe('wrap-right')
  })

  it('repairs a narrow preset when the actual ranking is too dense', () => {
    const dense = chart('dense', 'Sector Momentum')
    dense.payload = {
      kind: 'chart',
      title: 'Sector Momentum',
      chartType: 'bar',
      barOrientation: 'horizontal',
      xKey: 'sector',
      data: Array.from({ length: 11 }, (_, index) => ({ sector: `Sector ${index + 1}`, score: 10 - index })),
      series: [{ key: 'score', label: 'Momentum score (pp)' }],
    }
    expect(resolveReportSectionLayout({
      requested: 'wrap-left',
      visual: dense,
      analysis: 'The full ranking needs enough width for every category label.',
      keyFigures: [{ label: 'Leader', value: 'Energy' }],
    })).toBe('full-width')
  })

  it('does not let the AI waste a full row on a compact visual', () => {
    const compact = chart('compact', 'Small Comparison')
    compact.payload = {
      kind: 'chart',
      title: 'Small Comparison',
      chartType: 'bar',
      barOrientation: 'horizontal',
      xKey: 'company',
      data: [{ company: 'MCD', score: 8 }, { company: 'YUM', score: 6 }, { company: 'WEN', score: 4 }],
      series: [{ key: 'score', label: 'Score' }],
    }
    expect(resolveReportSectionLayout({
      requested: 'full-width',
      visual: compact,
      analysis: 'A concise comparison should sit beside its interpretation.',
      index: 1,
    })).toBe('visual-right')
  })

  it('turns a repetitive split into text wrap when the prose can reclaim the visual depth', () => {
    const compact = chart('compact', 'Peer Multiples')
    compact.payload = {
      kind: 'chart',
      title: 'Peer Multiples',
      chartType: 'bar',
      barOrientation: 'horizontal',
      xKey: 'company',
      data: [{ company: 'MCD', multiple: 19 }, { company: 'YUM', multiple: 20 }, { company: 'WEN', multiple: 12 }],
      series: [{ key: 'multiple', label: 'Forward P/E (x)' }],
    }
    expect(resolveReportSectionLayout({
      requested: 'visual-left',
      visual: compact,
      analysis: Array.from({ length: 52 }, (_, index) => `word${index}`).join(' '),
      keyFigures: [{ label: 'Lowest', value: 'WEN 12x' }],
    })).toBe('wrap-left')
  })

  it('keeps an evidence band only when a real metric rail can fill it', () => {
    const compact = chart('compact', 'Quality Comparison')
    compact.payload = {
      kind: 'chart',
      title: 'Quality Comparison',
      chartType: 'bar',
      xKey: 'company',
      data: [{ company: 'MCD', score: 82 }, { company: 'YUM', score: 78 }],
      series: [{ key: 'score', label: 'Quality score' }],
    }
    expect(resolveReportSectionLayout({
      requested: 'evidence-band',
      visual: compact,
      analysis: 'Quality supports the conclusion.',
      keyFigures: [{ label: 'Leader', value: 'MCD' }, { label: 'Beta', value: '0.42' }],
    })).toBe('evidence-band')
    expect(resolveReportSectionLayout({
      requested: 'evidence-band',
      visual: compact,
      analysis: 'Quality supports the conclusion.',
      keyFigures: [],
      index: 1,
    })).toBe('visual-right')
  })

  it('uses a metric rail for evidence-heavy prose without a visual', () => {
    expect(resolveReportSectionLayout({
      requested: 'visual-left',
      analysis: 'The supplied figures are sufficient to state the conclusion without manufacturing a chart.',
      keyFigures: [
        { label: 'Beta', value: '0.42' },
        { label: '1M return', value: '-3.96%' },
      ],
    })).toBe('metric-rail')
  })

  it('chooses deterministic alternating fallbacks when the AI omits a preset', () => {
    const visual = chart('compact', 'Compact Evidence')
    expect(resolveReportSectionLayout({ visual, analysis: 'Short analysis.', index: 0 })).toBe('visual-left')
    expect(resolveReportSectionLayout({ visual, analysis: 'Short analysis.', index: 1 })).toBe('visual-right')
  })
})

describe('assignBodyVisuals', () => {
  it('never reuses the same chart across two sections', () => {
    const cone = chart('c1', 'Volatility Cone — NVDA')
    const density = chart('c2', 'Probability Density — NVDA')
    const cum = chart('c3', 'Cumulative P(Finish Above)')
    const s03 = kpi('k1')
    const s04 = kpi('k2')
    const clips = [s03, s04, cone, density, cum]
    const byId = new Map(clips.map(c => [c.id, c]))

    const assigned = assignBodyVisuals(
      [
        { clipId: 'k1', heading: 'Implied Probability Anchors Near $203', analysis: 'modal strike P50' },
        { clipId: 'k2', heading: 'Volatility Cone Sets Upper Bound', analysis: '85th percentile cone envelope' },
      ],
      byId,
      clips,
    )

    const v1 = assigned.get('k1')?.visual
    const v2 = assigned.get('k2')?.visual
    expect(v1?.payload.kind).toBe('chart')
    expect(v2?.payload.kind).toBe('chart')
    expect(v1!.id).not.toBe(v2!.id)
    expect(v2!.id).toBe('c1') // cone section gets the cone chart
  })

  it('deduplicates equivalent native charts even when research created separate clip ids', () => {
    const consensusA = chart('c1', 'Consensus Upside Across the Peer Set', 'Peer Comparison')
    const consensusB = chart('c2', 'Consensus Upside Across the Peer Set', 'Peer Comparison')
    const first = kpi('k1', 'Peer Comparison')
    const second = kpi('k2', 'Peer Comparison')
    const assigned = assignBodyVisuals(
      [
        { clipId: 'k1', heading: 'Valuation and Analyst Upside', analysis: 'consensus upside target' },
        { clipId: 'k2', heading: 'Revenue Growth', analysis: 'growth trajectory' },
      ],
      new Map([['k1', first], ['k2', second]]),
      [first, second, consensusA, consensusB],
    )
    const visuals = [...assigned.values()].map(item => item.visual).filter(Boolean)
    expect(visuals).toHaveLength(1)
  })

  it('preferChartVisual skips used chart ids', () => {
    const cone = chart('c1', 'Volatility Cone — NVDA')
    const density = chart('c2', 'Probability Density — NVDA')
    const s = kpi('k1')
    const used = new Set(['c1'])
    const { visual } = preferChartVisual(s, [s, cone, density], used, 'volatility cone upper bound')
    expect(visual?.id).toBe('c2')
  })

  it('does not hand an unrelated sibling chart to a section on a bare ticker mention alone', () => {
    // Comparison reports mention both tickers by name in nearly every section,
    // so a chart title matching only on "NVDA" must not be treated as evidence
    // it's actually about this section's point (the "Valuation Gap" bug).
    const revenueProjection = chart('c1', 'Revenue Projection · NVDA', 'DCF Valuation')
    const dcfVerdict = kpi('k1', 'DCF Valuation')
    const assigned = assignBodyVisuals(
      [{
        clipId: 'k1',
        heading: 'Valuation Gap',
        analysis: "NVDA's DCF intrinsic of $172.15 is only 16% below its market price of $206.84, versus AAPL's 44% discount.",
      }],
      new Map([['k1', dcfVerdict]]),
      [dcfVerdict, revenueProjection],
    )
    expect(assigned.get('k1')?.visual).toBeUndefined()
  })

  it('prioritizes a native source visual over a generated fallback chart', () => {
    const native = chart('c1', 'AAPL Price History', 'Chart Studio')
    const sections = [{
      clipId: 'c1',
      heading: 'Price Trend',
      analysis: 'The trend supports the conclusion.',
      chart: {
        kind: 'chart' as const,
        chartType: 'bar' as const,
        title: 'Generated fallback',
        xKey: 'metric',
        data: [{ metric: 'Return', value: 4 }],
        series: [{ key: 'value', label: 'Value' }],
      },
    }]
    const assigned = assignReportBodyVisuals(
      sections,
      new Map([['c1', native]]),
      [native],
      { projectId: 'p1', generatedAt: '2026-07-29T00:00:00Z' },
    )
    expect(assigned.get('c1')?.visual?.id).toBe('c1')
    expect(assigned.get('c1')?.visual?.payload.title).toBe('AAPL Price History')
  })

  it('promotes a composition table into a labeled pie chart', () => {
    const promoted = promoteTableToChart({
      kind: 'table',
      title: 'Portfolio Allocation',
      columns: ['Ticker', 'Weight %'],
      rows: [['MCD', '42%'], ['YUM', '31%'], ['WEN', '18%'], ['QSR', '9%']],
    })
    expect(promoted?.chartType).toBe('pie')
    expect(promoted?.series[0].label).toBe('Weight %')
    expect(promoted?.data).toEqual([
      { category: 'MCD', value: 42 },
      { category: 'YUM', value: 31 },
      { category: 'WEN', value: 18 },
      { category: 'QSR', value: 9 },
    ])
  })

  it('promotes a categorical ranking into horizontal bars', () => {
    const promoted = promoteTableToChart({
      kind: 'table',
      title: 'Analyst Upside',
      columns: ['Company', 'Upside %', 'Analysts'],
      rows: [
        ['McDonald’s', '12.5%', 31],
        ['Yum Brands', '8.2%', 27],
        ['Wendy’s', '-3.4%', 18],
        ['Restaurant Brands', '5.1%', 22],
        ['Domino’s Pizza', '9.7%', 25],
      ],
    })
    expect(promoted?.chartType).toBe('bar')
    expect(promoted?.barOrientation).toBe('horizontal')
    expect(promoted?.series[0].label).toBe('Upside %')
  })

  it('turns sector leadership tables into a momentum ranking with supporting horizons', () => {
    const promoted = promoteTableToChart({
      kind: 'table',
      title: 'Sector Leadership · 2026-07-29',
      columns: ['Ticker', 'Sector', '1W %', '1M %', '3M %', 'vs SPY 1M', 'Momentum'],
      rows: [
        ['XLE', 'Energy', -2.75, 7.45, -2.79, 7.47, 8.38],
        ['XLF', 'Financials', 2.77, 7.22, 10.88, 7.24, 3.59],
        ['XLV', 'Health Care', 4.91, 4.06, 15.07, 4.08, -0.96],
      ],
    })
    expect(promoted).toMatchObject({
      chartType: 'bar',
      barOrientation: 'horizontal',
      xKey: 'sector',
      series: [{ key: 'momentum', label: 'Momentum score (pp)' }],
      details: [
        { key: 'oneWeek', label: '1W return %' },
        { key: 'oneMonth', label: '1M return %' },
        { key: 'threeMonth', label: '3M return %' },
        { key: 'vsSpyOneMonth', label: 'Vs SPY · 1M %' },
      ],
    })
    expect(promoted?.data.map(row => row.sector)).toEqual([
      'Energy · XLE',
      'Financials · XLF',
      'Health Care · XLV',
    ])
    expect(promoted?.data[0]).toMatchObject({
      momentum: 8.38,
      oneWeek: -2.75,
      oneMonth: 7.45,
      threeMonth: -2.79,
      vsSpyOneMonth: 7.47,
    })
  })

  it('promotes unused same-unit key figures into a labeled comparison bar', () => {
    const promoted = promoteKeyFiguresToChart([
      { label: 'WEN DCF upside', value: '106%' },
      { label: 'WEN consensus upside', value: '+1.3%' },
      { label: 'WEN P/E vs median', value: '9.9x vs 36.1x' },
    ], 'Valuation Discount')
    expect(promoted?.chartType).toBe('bar')
    expect(promoted?.barOrientation).toBe('horizontal')
    expect(promoted?.series[0].label).toBe('Percent (%)')
    expect(promoted?.data).toEqual([
      { metric: 'WEN DCF Upside', value: 106 },
      { metric: 'WEN Consensus Upside', value: 1.3 },
    ])
  })

  it('uses a site-built chart instead of exposing its source table as raw data', () => {
    const tableClip: ReportClip = {
      id: 'segments',
      sourceTab: 'Company Profile',
      dataType: 'table',
      capturedAt: '',
      projectId: 'p1',
      payload: {
        kind: 'table',
        title: 'Revenue Mix',
        columns: ['Segment', 'Share %'],
        rows: [['US', 65], ['International', 35]],
      },
    }
    const assigned = assignReportBodyVisuals(
      [{
        clipId: 'segments',
        heading: 'Revenue Concentration',
        analysis: 'The business remains concentrated in the US.',
        chart: {
          kind: 'chart',
          chartType: 'pie',
          title: 'Revenue Mix by Region',
          xKey: 'region',
          data: [{ region: 'US', share: 65 }, { region: 'International', share: 35 }],
          series: [{ key: 'share', label: 'Revenue Share %' }],
        },
      }],
      new Map([['segments', tableClip]]),
      [tableClip],
      { projectId: 'p1', generatedAt: '2026-07-29T00:00:00Z' },
    )
    expect(assigned.get('segments')?.visual?.payload.kind).toBe('chart')
    expect(assigned.get('segments')?.visual?.payload.title).toBe('Revenue Mix by Region')
  })

  it('uses a purpose-built comparison chart over an unrelated sibling from the same tool', () => {
    const verdict = kpi('wen-dcf', 'DCF Valuation')
    const unrelated = chart('mcd-sensitivity', 'MCD Value-Driver Sensitivity', 'DCF Valuation')
    const assigned = assignReportBodyVisuals(
      [{
        clipId: 'wen-dcf',
        heading: 'DCF Intrinsic Valuation Comparison',
        analysis: 'WEN intrinsic value versus the other restaurant companies.',
        chart: {
          kind: 'chart',
          chartType: 'bar',
          title: 'DCF Intrinsic vs Market Price',
          xKey: 'company',
          data: [{ company: 'WEN', intrinsic: 15.76, market: 7.65 }, { company: 'YUM', intrinsic: 88.15, market: 151.92 }],
          series: [{ key: 'intrinsic', label: 'DCF Intrinsic' }, { key: 'market', label: 'Market Price' }],
        },
      }],
      new Map([['wen-dcf', verdict]]),
      [verdict, unrelated],
      { projectId: 'p1', generatedAt: '2026-07-29T00:00:00Z' },
    )
    expect(assigned.get('wen-dcf')?.visual?.payload.title).toBe('DCF Intrinsic vs Market Price')
  })

  it('keeps a relevant native sibling when a generated fallback explains the section less well', () => {
    const valuation = kpi('valuation', 'Peer Comparison')
    const consensus = chart('consensus', 'Consensus Upside Across the Peer Set', 'Peer Comparison')
    const assigned = assignReportBodyVisuals(
      [{
        clipId: 'valuation',
        heading: 'Valuation Discount and Analyst Upside',
        analysis: 'Consensus upside and the analyst target reinforce the valuation case.',
        chart: {
          kind: 'chart',
          chartType: 'line',
          title: 'Relative Price Performance',
          xKey: 'month',
          data: [{ month: 'Jan', WEN: 100 }, { month: 'Feb', WEN: 95 }],
          series: [{ key: 'WEN', label: 'WEN' }],
        },
      }],
      new Map([['valuation', valuation]]),
      [valuation, consensus],
      { projectId: 'p1', generatedAt: '2026-07-29T00:00:00Z' },
    )
    expect(assigned.get('valuation')?.visual?.payload.title).toBe('Consensus Upside Across the Peer Set')
  })

  it('keeps a duplicate generated visual only under the section it explains best', () => {
    const first = kpi('valuation', 'Peer Comparison')
    const second = kpi('performance', 'Compare')
    const duplicateChart = {
      kind: 'chart' as const,
      chartType: 'line' as const,
      title: 'Relative Price Performance',
      xKey: 'month',
      data: [{ month: 'Jan', MCD: 100 }, { month: 'Feb', MCD: 103 }],
      series: [{ key: 'MCD', label: 'MCD' }],
    }
    const assigned = assignReportBodyVisuals(
      [
        { clipId: 'valuation', heading: 'Valuation Discount', analysis: 'P/E and intrinsic value support the thesis.', chart: duplicateChart },
        { clipId: 'performance', heading: 'Relative Price Performance', analysis: 'Relative performance and momentum confirm the setup.', chart: duplicateChart },
      ],
      new Map([['valuation', first], ['performance', second]]),
      [first, second],
      { projectId: 'p1', generatedAt: '2026-07-29T00:00:00Z' },
    )
    expect(assigned.get('valuation')?.visual).toBeUndefined()
    expect(assigned.get('performance')?.visual?.payload.kind).toBe('chart')
  })

  it('keeps repeated source clip ids distinct across generated sections', () => {
    const shared = kpi('shared', 'Peer Comparison')
    const sections = [
      {
        clipId: 'shared',
        heading: 'Valuation Upside',
        analysis: 'Valuation comparison.',
        keyFigures: [{ label: 'DCF upside', value: '106%' }, { label: 'Consensus upside', value: '1.3%' }],
      },
      {
        clipId: 'shared',
        heading: 'Revenue Growth',
        analysis: 'Growth comparison.',
        keyFigures: [{ label: 'WEN growth', value: '3.3%' }, { label: 'Peer growth', value: '4.3%' }],
      },
    ]
    const assigned = assignReportBodyVisuals(
      sections,
      new Map([['shared', shared]]),
      [shared],
      { projectId: 'p1', generatedAt: '2026-07-29T00:00:00Z' },
    )
    const firstKey = reportSectionAssignmentKey(sections, 0)
    const secondKey = reportSectionAssignmentKey(sections, 1)
    expect(firstKey).not.toBe(secondKey)
    expect(assigned.get(firstKey)?.visual?.payload.title).toContain('Valuation Upside')
    expect(assigned.get(secondKey)?.visual?.payload.title).toContain('Revenue Growth')
  })

  it('keeps visuals paired with the same automated research output', () => {
    const metrics = {
      ...kpi('k1', 'Portfolio Compare'),
      researchSourceId: 'portfolio-risk',
      researchKey: 'portfolio-risk:book:metrics',
    } satisfies ReportClip
    const performance = {
      ...chart('c1', 'Core vs SPY', 'Portfolio Compare'),
      researchSourceId: 'portfolio-risk',
      researchKey: 'portfolio-risk:book:performance',
    } satisfies ReportClip
    const assigned = assignBodyVisuals(
      [{ clipId: 'k1', heading: 'Risk Metrics', analysis: 'Volatility and drawdown define the risk profile.' }],
      new Map([['k1', metrics]]),
      [metrics, performance],
    )
    expect(assigned.get('k1')?.visual?.id).toBe('c1')
  })
})
