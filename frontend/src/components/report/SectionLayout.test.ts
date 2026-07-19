import { describe, expect, it } from 'vitest'
import { assignBodyVisuals, preferChartVisual } from './SectionLayout'
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

  it('preferChartVisual skips used chart ids', () => {
    const cone = chart('c1', 'Volatility Cone — NVDA')
    const density = chart('c2', 'Probability Density — NVDA')
    const s = kpi('k1')
    const used = new Set(['c1'])
    const { visual } = preferChartVisual(s, [s, cone, density], used, 'volatility cone upper bound')
    expect(visual?.id).toBe('c2')
  })
})
