import { describe, expect, it } from 'vitest'
import { choosePdfSlicePlan, computePdfSlices, reportPdfBaseName } from './exportReportPdf'

describe('reportPdfBaseName', () => {
  it('uses the entered project name with the alphatape PDF suffix', () => {
    expect(reportPdfBaseName('Portfolio Analysis 7')).toBe('Portfolio Analysis 7.alphatape')
    expect(reportPdfBaseName('Portfolio Analysis 7.pdf')).toBe('Portfolio Analysis 7.alphatape')
    expect(reportPdfBaseName('Portfolio Analysis 7.alphatape.pdf')).toBe('Portfolio Analysis 7.alphatape')
  })
})

describe('computePdfSlices', () => {
  it('moves a page boundary ahead of a protected report block', () => {
    const slices = computePdfSlices(2_200, 1_000, [
      { top: 820, bottom: 1_180 },
      { top: 1_520, bottom: 1_820 },
    ])
    expect(slices[0]).toEqual({ start: 0, height: 812 })
    expect(slices[1].start).toBe(812)
    expect(slices.reduce((sum, slice) => sum + slice.height, 0)).toBe(2_200)
  })

  it('allows an oversized section to cross a page boundary', () => {
    const slices = computePdfSlices(2_100, 1_000, [
      { top: 700, bottom: 1_850 },
    ])
    expect(slices[0]).toEqual({ start: 0, height: 1_000 })
    expect(slices).toHaveLength(3)
  })

  it('does not create a mostly empty page to protect a block near the top', () => {
    const slices = computePdfSlices(1_600, 1_000, [
      { top: 300, bottom: 1_100 },
    ])
    expect(slices[0]).toEqual({ start: 0, height: 1_000 })
  })

  it('moves a labeled evidence block once the page is at least half full', () => {
    const slices = computePdfSlices(1_700, 1_000, [
      { top: 540, bottom: 1_080, preferEarlierBreak: true },
    ])
    expect(slices[0]).toEqual({ start: 0, height: 532 })
  })

  it('moves an atomic section even when the current page is mostly empty', () => {
    const slices = computePdfSlices(1_600, 1_000, [
      { top: 120, bottom: 1_050, strict: true },
    ])

    expect(slices[0]).toEqual({ start: 0, height: 112 })
    expect(slices[1].start).toBe(112)
  })

  it('keeps a page-start atomic block intact after an earlier break', () => {
    const slices = computePdfSlices(1_900, 1_000, [
      { top: 620, bottom: 1_450, strict: true },
    ])

    expect(slices[0]).toEqual({ start: 0, height: 612 })
    expect(slices[1]).toEqual({ start: 612, height: 1_000 })
    expect(slices[2]).toEqual({ start: 1_612, height: 288 })
    expect(slices.some(slice => slice.start < 1_450 && slice.start + slice.height > 1_450)).toBe(true)
    expect(slices.slice(0, -1).map(slice => slice.start + slice.height)).not.toContain(1_000)
  })

  it('keeps a block clear of the page edge when raster rounding nearly fits it', () => {
    const slices = computePdfSlices(1_700, 1_000, [
      { top: 920, bottom: 990 },
    ])
    expect(slices[0]).toEqual({ start: 0, height: 912 })
  })

  it('rechecks protected blocks after moving a boundary for the next section', () => {
    const slices = computePdfSlices(1_800, 1_000, [
      { top: 850, bottom: 950 },
      { top: 940, bottom: 1_250 },
    ])
    expect(slices[0]).toEqual({ start: 0, height: 842 })
  })

  it('does not cascade past a completed block after moving the boundary', () => {
    const slices = computePdfSlices(2_000, 1_000, [
      { top: 760, bottom: 875 },
      { top: 898, bottom: 1_080 },
    ])
    expect(slices[0]).toEqual({ start: 0, height: 890 })
  })

  it('packs a representative research report into two well-filled pages', () => {
    const slices = computePdfSlices(1_850, 1_050, [
      { top: 0, bottom: 121 },
      { top: 135, bottom: 209 },
      { top: 220, bottom: 276 },
      { top: 288, bottom: 410 },
      { top: 310, bottom: 538 },
      { top: 549, bottom: 600 },
      { top: 611, bottom: 665 },
      { top: 671, bottom: 941 },
      { top: 947, bottom: 998 },
      { top: 1_009, bottom: 1_298 },
      { top: 1_030, bottom: 1_258 },
      { top: 1_309, bottom: 1_364 },
      { top: 1_370, bottom: 1_682 },
      { top: 1_688, bottom: 1_738 },
      { top: 1_752, bottom: 1_830 },
    ])
    expect(slices).toEqual([
      { start: 0, height: 1_001 },
      { start: 1_001, height: 849 },
    ])
  })

  it('uses bounded report scaling to eliminate a nearly empty orphan page', () => {
    const plan = choosePdfSlicePlan(1_850, 1_000, [
      { top: 820, bottom: 1_080 },
    ])

    expect(plan.scaleFactor).toBe(1.05)
    expect(plan.slices).toEqual([
      { start: 0, height: 812 },
      { start: 812, height: 1_038 },
    ])
  })

  it('continues beyond three pages when the report evidence requires it', () => {
    const slices = computePdfSlices(4_600, 1_000, [])

    expect(slices).toHaveLength(5)
    expect(slices[slices.length - 1]).toEqual({ start: 4_000, height: 600 })
  })

  it('packs a four-stage portfolio report without cutting atomic evidence', () => {
    const atomic = [
      { top: 760, bottom: 1_120, strict: true },
      { top: 1_820, bottom: 2_040, strict: true },
      { top: 2_760, bottom: 3_180, strict: true },
      { top: 3_680, bottom: 3_940, strict: true },
    ]
    const plan = choosePdfSlicePlan(4_080, 1_000, atomic)
    const boundaries = plan.slices.slice(0, -1).map(slice => slice.start + slice.height)

    expect(plan.slices).toHaveLength(4)
    for (const boundary of boundaries) {
      expect(atomic.some(span => span.top < boundary && span.bottom > boundary)).toBe(false)
    }
  })

  it('moves a tight block instead of leaving a clipped fragment', () => {
    const slices = computePdfSlices(1_700, 1_000, [
      { top: 80, bottom: 1_050 },
      { top: 930, bottom: 1_050, preferEarlierBreak: true },
    ])

    expect(slices[0]).toEqual({ start: 0, height: 922 })
    expect(slices[1].start).toBe(922)
  })
})
