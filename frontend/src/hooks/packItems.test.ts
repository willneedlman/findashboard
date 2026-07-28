import { describe, expect, it } from 'vitest'
import { composeLayouts, packItems, reflowLayouts, type WidgetConfig } from './useDashboard'

const item = (i: string, w: number, h: number) => ({ i, w, h })

function expectValidLayout(layouts: { x: number; y: number; w: number; h: number }[], cols: number, baseY = 0) {
  for (const layout of layouts) {
    expect(layout.x).toBeGreaterThanOrEqual(0)
    expect(layout.y).toBeGreaterThanOrEqual(baseY)
    expect(layout.x + layout.w).toBeLessThanOrEqual(cols)
  }
  for (let a = 0; a < layouts.length; a++) {
    for (let b = a + 1; b < layouts.length; b++) {
      const first = layouts[a]
      const second = layouts[b]
      const overlaps = first.x < second.x + second.w
        && first.x + first.w > second.x
        && first.y < second.y + second.h
        && first.y + first.h > second.y
      expect(overlaps).toBe(false)
    }
  }
}

describe('packItems — natural skyline packing', () => {
  it('preserves requested widths instead of stretching widgets to fill a row', () => {
    const out = packItems([item('a', 6, 6), item('b', 4, 6)])
    expect(out.find(layout => layout.i === 'a')).toMatchObject({ w: 6, h: 6 })
    expect(out.find(layout => layout.i === 'b')).toMatchObject({ w: 4, h: 6 })
    expectValidLayout(out, 12)
  })

  it('preserves natural heights for widgets sharing a row', () => {
    const out = packItems([item('tall', 8, 8), item('short', 4, 3)])
    expect(out.find(layout => layout.i === 'tall')).toMatchObject({ x: 0, y: 0, h: 8 })
    expect(out.find(layout => layout.i === 'short')).toMatchObject({ x: 8, y: 0, h: 3 })
    expectValidLayout(out, 12)
  })

  it('stacks supporting widgets vertically beside a taller panel', () => {
    const out = packItems([item('primary', 8, 8), item('top', 4, 3), item('bottom', 4, 4)])
    expect(out.find(layout => layout.i === 'top')).toMatchObject({ x: 8, y: 0 })
    expect(out.find(layout => layout.i === 'bottom')).toMatchObject({ x: 8, y: 3 })
    expectValidLayout(out, 12)
  })

  it('gives a full-width strip its own shallow row', () => {
    const out = packItems([item('strip', 12, 2), item('a', 6, 6), item('b', 6, 4)])
    expect(out.find(layout => layout.i === 'strip')).toMatchObject({ x: 0, y: 0, w: 12, h: 2 })
    expect(out.find(layout => layout.i === 'a')?.y).toBe(2)
    expect(out.find(layout => layout.i === 'b')?.y).toBe(2)
    expectValidLayout(out, 12)
  })

  it('keeps a lone narrow widget concise', () => {
    const out = packItems([item('solo', 4, 5)])
    expect(out[0]).toMatchObject({ x: 0, y: 0, w: 4, h: 5 })
    expectValidLayout(out, 12)
  })

  it('honors baseY for appended widgets', () => {
    const out = packItems([item('a', 6, 5), item('b', 6, 4)], 12, 20)
    expect(Math.min(...out.map(layout => layout.y))).toBe(20)
    expectValidLayout(out, 12, 20)
  })
})

describe('responsive dashboard reflow', () => {
  it('scales a primary panel and rail into a natural 10-column pairing', () => {
    const widgets: WidgetConfig[] = [
      { id: 'tape', type: 'index-tape' },
      { id: 'trade', type: 'paper-trade' },
      { id: 'hours', type: 'market-hours' },
      { id: 'watch', type: 'watchlist' },
    ]
    const desktop = composeLayouts(widgets, 'trading')
    const medium = reflowLayouts(widgets, desktop, 10)
    const trade = medium.find(layout => layout.i === 'trade')!
    const hours = medium.find(layout => layout.i === 'hours')!
    expect(trade.w + hours.w).toBe(10)
    expect(trade.y).toBe(hours.y)
    expectValidLayout(medium, 10)
  })

  it('keeps full-width context strips full width at every breakpoint', () => {
    const widgets: WidgetConfig[] = [
      { id: 'tape', type: 'index-tape' },
      { id: 'macro', type: 'macro-strip' },
      { id: 'risk', type: 'risk-metrics' },
    ]
    const desktop = composeLayouts(widgets, 'risk')
    const small = reflowLayouts(widgets, desktop, 6)
    expect(small.find(layout => layout.i === 'tape')?.w).toBe(6)
    expect(small.find(layout => layout.i === 'macro')?.w).toBe(6)
    expectValidLayout(small, 6)
  })
})
