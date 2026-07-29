import { describe, expect, it } from 'vitest'
import {
  DASHBOARD_TEMPLATES,
  DASHBOARD_TEMPLATE_IDS,
  composeTemplateLayouts,
  selectDashboardTemplate,
  templateLayoutQuality,
  templateOccupiedRatio,
} from './dashboardTemplates'
import { WIDGET_DEFINITIONS, type WidgetConfig } from './widgetRegistry'
import { compatibleSet } from '../../hooks/useDashboard'

const widget = (id: string, type: WidgetConfig['type'], patch: Partial<WidgetConfig> = {}): WidgetConfig => ({ id, type, ...patch })

function expectValid(layouts: ReturnType<typeof composeTemplateLayouts>, cols: number) {
  for (const layout of layouts) {
    expect(layout.x).toBeGreaterThanOrEqual(0)
    expect(layout.y).toBeGreaterThanOrEqual(0)
    expect(layout.x + layout.w).toBeLessThanOrEqual(cols)
    expect(layout.w).toBeGreaterThan(0)
    expect(layout.h).toBeGreaterThan(0)
  }
  for (let first = 0; first < layouts.length; first++) {
    for (let second = first + 1; second < layouts.length; second++) {
      const a = layouts[first]
      const b = layouts[second]
      const overlaps = a.x < b.x + b.w
        && a.x + a.w > b.x
        && a.y < b.y + b.h
        && a.y + a.h > b.y
      expect(overlaps).toBe(false)
    }
  }
}

describe('dashboard template library', () => {
  it('defines eight intentional, non-overlapping wide and medium compositions', () => {
    expect(DASHBOARD_TEMPLATE_IDS).toHaveLength(8)
    for (const template of Object.values(DASHBOARD_TEMPLATES)) {
      expect(template.description.length).toBeGreaterThan(24)
      expect(template.slots.some(item => item.role === 'focal' || item.role === 'table')).toBe(true)
      expectValid(template.slots.map(item => ({ i: item.id, ...item })), 12)
      expectValid(template.mediumSlots.map(item => ({ i: item.id, ...item })), 10)
    }
  })

  it('selects templates from dashboard purpose and content shape', () => {
    expect(selectDashboardTemplate([widget('risk', 'risk-metrics'), widget('factor', 'factor-decomposition')], 'risk')).toBe('portfolio-risk')
    expect(selectDashboardTemplate([widget('trade', 'paper-trade'), widget('watch', 'watchlist')], 'trading')).toBe('market-monitor')
    expect(selectDashboardTemplate([widget('macro', 'global-macro'), widget('curve', 'yield-curve')], 'macro')).toBe('macro-dashboard')
    expect(selectDashboardTemplate([widget('news', 'news-feed'), widget('events', 'macro-calendar')], 'research')).toBe('news-events')
  })
})

describe('template assignment', () => {
  it('builds a complete portfolio-risk hierarchy with no empty columns', () => {
    const widgets = [
      widget('summary', 'portfolio-summary'),
      widget('risk', 'risk-metrics'),
      widget('factor', 'factor-decomposition'),
      widget('correlation', 'correlation-matrix'),
      widget('pnl', 'pnl-attribution'),
      widget('books', 'pm-portfolios'),
    ]
    const layouts = composeTemplateLayouts(widgets, 'portfolio-risk')
    expect(layouts.find(item => item.i === 'summary')).toMatchObject({ x: 0, y: 0, w: 7, h: 6 })
    expect(layouts.find(item => item.i === 'risk')).toMatchObject({ x: 7, y: 0, w: 5, h: 6 })
    expect(layouts.find(item => item.i === 'factor')).toMatchObject({ x: 0, y: 6, w: 7, h: 5 })
    expect(layouts.find(item => item.i === 'correlation')).toMatchObject({ x: 7, y: 6, w: 5, h: 5 })
    expect(layouts.find(item => item.i === 'pnl')).toMatchObject({ x: 0, y: 11, w: 7, h: 6 })
    expect(layouts.find(item => item.i === 'books')).toMatchObject({ x: 7, y: 11, w: 5, h: 5 })
    expect(templateOccupiedRatio(layouts)).toBeGreaterThan(0.9)
    expectValid(layouts, 12)
  })

  it('compacts unavailable portfolio panels without disturbing live risk context', () => {
    const widgets = [
      widget('summary', 'portfolio-summary'),
      widget('risk', 'risk-metrics'),
      widget('factor', 'factor-decomposition'),
      widget('correlation', 'correlation-matrix'),
      widget('pnl', 'pnl-attribution'),
      widget('books', 'pm-portfolios'),
    ]
    const layouts = composeTemplateLayouts(widgets, 'portfolio-risk', 12, {
      summary: 'empty',
      risk: 'empty',
      factor: 'empty',
      correlation: 'ready',
      pnl: 'empty',
      books: 'empty',
    })
    for (const id of ['summary', 'risk', 'factor', 'pnl', 'books']) {
      expect(layouts.find(item => item.i === id)?.h).toBeLessThanOrEqual(3)
    }
    expect(layouts.find(item => item.i === 'correlation')?.h).toBe(5)
    expectValid(layouts, 12)
  })

  it('places strips and focal widgets into the leading structural slots', () => {
    const widgets = [
      widget('news', 'news-feed'),
      widget('trade', 'paper-trade'),
      widget('tape', 'index-tape'),
      widget('watch', 'watchlist'),
    ]
    const layouts = composeTemplateLayouts(widgets, 'market-monitor')
    expect(layouts.find(item => item.i === 'tape')).toMatchObject({ x: 0, y: 0, w: 12, h: 1 })
    expect(layouts.find(item => item.i === 'trade')).toMatchObject({ x: 0, y: 1, w: 8, h: 8 })
    expectValid(layouts, 12)
  })

  it('retains every widget and its configuration when remapping templates', () => {
    const widgets = [
      widget('chart', 'tradingview-chart', { ticker: 'NVDA', period: '1y' }),
      widget('news', 'news-feed', { tickers: ['NVDA'], newsExpand: 'all' }),
      widget('analyst', 'analyst-ratings', { ticker: 'NVDA' }),
      widget('valuation', 'valuation', { ticker: 'NVDA' }),
    ]
    const before = JSON.stringify(widgets)
    const research = composeTemplateLayouts(widgets, 'research-workspace')
    const comparison = composeTemplateLayouts(widgets, 'comparison')
    expect(JSON.stringify(widgets)).toBe(before)
    expect(new Set(research.map(item => item.i))).toEqual(new Set(widgets.map(item => item.id)))
    expect(new Set(comparison.map(item => item.i))).toEqual(new Set(widgets.map(item => item.id)))
  })

  it('keeps unmatched widgets in compact overflow without pathological empty space', () => {
    const widgets = Array.from({ length: 10 }, (_, index) => widget(`news-${index}`, 'news-feed', { tickers: [`T${index}`] }))
    const layouts = composeTemplateLayouts(widgets, 'news-events')
    expect(layouts).toHaveLength(widgets.length)
    expectValid(layouts, 12)
    expect(templateOccupiedRatio(layouts)).toBeGreaterThan(0.45)
  })

  it('uses deliberate full-width ordering on tablet and mobile', () => {
    const widgets = [
      widget('chart', 'tradingview-chart'),
      widget('watch', 'watchlist'),
      widget('news', 'news-feed'),
      widget('events', 'earnings-calendar'),
    ]
    for (const cols of [6, 4, 2]) {
      const layouts = composeTemplateLayouts(widgets, 'research-workspace', cols)
      expect(layouts.every(item => item.x === 0 && item.w === cols)).toBe(true)
      expectValid(layouts, cols)
    }
  })

  it('keeps desktop slots inside each widget natural bounds', () => {
    const widgets = [
      widget('risk', 'risk-metrics'),
      widget('factor', 'factor-decomposition'),
      widget('pnl', 'pnl-attribution'),
      widget('books', 'pm-portfolios'),
      widget('corr', 'correlation-matrix'),
    ]
    const layouts = composeTemplateLayouts(widgets, 'portfolio-risk')
    for (const layout of layouts) {
      const definition = WIDGET_DEFINITIONS[widgets.find(item => item.id === layout.i)!.type]
      expect(layout.w).toBeGreaterThanOrEqual(definition.minimum.w)
      expect(layout.w).toBeLessThanOrEqual(definition.maximum.w)
      expect(layout.h).toBeGreaterThanOrEqual(definition.minimum.h)
      expect(layout.h).toBeLessThanOrEqual(definition.maximum.h)
    }
  })

  it('repairs the sparse macro composition from the visual regression fixture', () => {
    const widgets = compatibleSet([
      widget('strip', 'macro-strip'),
      widget('credit-primary', 'credit-spreads'),
      widget('curve', 'yield-curve'),
      widget('credit-duplicate', 'credit-spreads', { categories: ['not-a-series'] }),
      widget('calendar', 'macro-calendar'),
      widget('sectors', 'sector-rotation'),
    ])
    const layouts = composeTemplateLayouts(widgets, 'macro-dashboard')
    const creditLayouts = layouts.filter(layout => widgets.find(item => item.id === layout.i)?.type === 'credit-spreads')
    const main = layouts.filter(layout => ['credit-primary', 'curve'].includes(layout.i))
    const lower = layouts.filter(layout => ['calendar', 'sectors'].includes(layout.i))

    expect(creditLayouts).toHaveLength(1)
    expect(Math.min(...main.map(layout => layout.x))).toBe(0)
    expect(Math.max(...main.map(layout => layout.x + layout.w))).toBe(12)
    expect(Math.min(...lower.map(layout => layout.x))).toBe(0)
    expect(Math.max(...lower.map(layout => layout.x + layout.w))).toBe(12)
    expect(layouts.find(layout => layout.i === 'calendar')?.h).toBeLessThanOrEqual(4)
    expect(templateOccupiedRatio(layouts, 12)).toBeGreaterThan(0.72)
    expect(templateLayoutQuality(widgets, layouts, 12)).toBeGreaterThan(60)
    expectValid(layouts, 12)
  })

  it('uses global assignment so macro widgets take their semantically strongest slots', () => {
    const widgets = [
      widget('curve', 'yield-curve'),
      widget('credit', 'credit-spreads'),
      widget('global', 'global-macro'),
    ]
    const layouts = composeTemplateLayouts(widgets, 'macro-dashboard')
    expect(layouts.find(layout => layout.i === 'global')).toMatchObject({ x: 0, w: 3 })
    expect(layouts.find(layout => layout.i === 'curve')).toMatchObject({ x: 3, w: 5 })
    expect(layouts.find(layout => layout.i === 'credit')).toMatchObject({ x: 8, w: 4 })
  })

  it('collapses empty and error states without shrinking populated peers', () => {
    const widgets = [
      widget('heatmap', 'heatmap'),
      widget('global', 'global-macro'),
      widget('calendar', 'macro-calendar'),
    ]
    const layouts = composeTemplateLayouts(widgets, 'macro-dashboard', 12, {
      heatmap: 'empty',
      global: 'ready',
      calendar: 'error',
    })
    expect(layouts.find(layout => layout.i === 'heatmap')?.h).toBeLessThanOrEqual(3)
    expect(layouts.find(layout => layout.i === 'calendar')?.h).toBeLessThanOrEqual(3)
    expect(layouts.find(layout => layout.i === 'global')?.h).toBeGreaterThanOrEqual(6)
    expectValid(layouts, 12)
  })
})
