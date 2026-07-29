import { describe, expect, it } from 'vitest'
import {
  applyConstraints, buildPreset, compatibleSet, composeIntelligentDashboard, composeLayouts,
  inferDashboardObjective, normalizeDashboard, normalizeWidgets, validateLayout,
  type WidgetConfig,
} from './useDashboard'
import {
  DEFAULT_MACRO_STRIP_SERIES, WIDGET_DEFINITIONS, WIDGET_TYPES, responsiveState,
} from '../components/dashboard/widgetRegistry'

const widget = (id: string, type: WidgetConfig['type'], patch: Partial<WidgetConfig> = {}): WidgetConfig => ({ id, type, ...patch })

describe('widget metadata', () => {
  it('defines complete composition metadata for every available widget', () => {
    for (const type of WIDGET_TYPES) {
      const definition = WIDGET_DEFINITIONS[type]
      expect(definition.id).toBe(type)
      expect(definition.purpose.length).toBeGreaterThan(4)
      expect(definition.dataType.length).toBeGreaterThan(2)
      expect(definition.preferred.w).toBeGreaterThanOrEqual(definition.minimum.w)
      expect(definition.preferred.h).toBeGreaterThanOrEqual(definition.minimum.h)
      expect(definition.maximum.w).toBeGreaterThanOrEqual(definition.preferred.w)
      expect(definition.maximum.w).toBeLessThanOrEqual(Math.min(12, definition.preferred.w + 2))
      expect(definition.maximum.h).toBeLessThanOrEqual(definition.preferred.h + 2)
      expect(['horizontal', 'vertical', 'balanced']).toContain(definition.orientation)
      expect(['compact', 'standard', 'dense']).toContain(definition.density)
      expect(['focal', 'supporting']).toContain(definition.visualRole)
      expect(['fixed', 'horizontal', 'vertical', 'bounded']).toContain(definition.growth)
    }
  })
})

describe('intelligent dashboard composition', () => {
  it('places the index tape first at full width and keeps paper trading primary', () => {
    const widgets = [
      widget('news', 'news-feed'),
      widget('trade', 'paper-trade'),
      widget('tape', 'index-tape'),
      widget('watch', 'watchlist'),
    ]
    const layout = composeLayouts(widgets, 'trading')
    expect(layout.find(item => item.i === 'tape')).toMatchObject({ x: 0, y: 0, w: 12 })
    expect(layout.find(item => item.i === 'trade')!.w).toBeGreaterThanOrEqual(8)
  })

  it('infers dashboard purpose from primary widgets', () => {
    expect(inferDashboardObjective([widget('risk', 'risk-metrics'), widget('factor', 'factor-decomposition')])).toBe('risk')
    expect(inferDashboardObjective([widget('trade', 'paper-trade'), widget('watch', 'watchlist')])).toBe('trading')
  })

  it('selects the internal composition from the current widget intent', () => {
    const risk = composeIntelligentDashboard([
      widget('risk', 'risk-metrics'),
      widget('factor', 'factor-decomposition'),
    ])
    const trading = composeIntelligentDashboard([
      widget('trade', 'paper-trade'),
      widget('watch', 'watchlist'),
    ])
    expect(risk).toMatchObject({ objective: 'risk', templateId: 'portfolio-risk' })
    expect(trading).toMatchObject({ objective: 'trading', templateId: 'market-monitor' })
    expect(risk.layouts).toHaveLength(2)
    expect(trading.layouts).toHaveLength(2)
  })

  it('removes conflicting and disallowed duplicate widgets from generated sets', () => {
    const set = compatibleSet([
      widget('tape-a', 'index-tape'),
      widget('tape-b', 'index-tape'),
      widget('paper', 'paper-trade'),
      widget('chart', 'tradingview-chart'),
      widget('news-a', 'news-feed', { tickers: ['SPY'] }),
      widget('news-b', 'news-feed', { tickers: ['NVDA'] }),
    ])
    expect(set.filter(item => item.type === 'index-tape')).toHaveLength(1)
    expect(set.some(item => item.type === 'tradingview-chart')).toBe(false)
    expect(set.filter(item => item.type === 'news-feed')).toHaveLength(2)
  })

  it('treats Portfolio Summary and Risk Metrics as complementary portfolio views', () => {
    const set = compatibleSet([
      widget('summary', 'portfolio-summary'),
      widget('risk', 'risk-metrics'),
    ])
    expect(set.map(item => item.type)).toEqual(['portfolio-summary', 'risk-metrics'])
  })

  it('repairs invalid configuration before removing redundant widget instances', () => {
    const normalized = normalizeWidgets([
      widget('credit-invalid', 'credit-spreads', { categories: ['made-up-series'], lookback: 999 }),
      widget('credit-default', 'credit-spreads'),
    ])
    expect(normalized).toHaveLength(1)
    expect(normalized[0].categories).toEqual(['ig', 'hy', 'vix'])
    expect(normalized[0].lookback).toBe(90)
  })
})

describe('configuration persistence and migration', () => {
  it('hydrates placed configurable widgets with useful default selections', () => {
    expect(WIDGET_DEFINITIONS['macro-strip'].defaultConfig.tickers).toEqual(DEFAULT_MACRO_STRIP_SERIES)
    expect(WIDGET_DEFINITIONS['macro-calendar'].defaultConfig.categories).toHaveLength(6)
    expect(WIDGET_DEFINITIONS['earnings-calendar'].defaultConfig.tickers).toContain('AAPL')
    expect(WIDGET_DEFINITIONS['correlation-matrix'].defaultConfig.tickers).toContain('SPY')
    expect(WIDGET_DEFINITIONS['portfolio-summary'].defaultConfig.weights).toEqual([0.4, 0.3, 0.2, 0.1])
  })

  it('repairs invalid Macro Strip selections from generated or saved layouts', () => {
    const [macro] = normalizeWidgets([widget('macro', 'macro-strip', { tickers: ['SPY', 'NOT_A_YIELD'] })])
    expect(macro.tickers).toEqual(DEFAULT_MACRO_STRIP_SERIES)
  })

  it('preserves independent configuration for duplicate widget instances', () => {
    const dashboard = normalizeDashboard({
      id: 'd1',
      name: 'Macro',
      widgets: [
        widget('macro-a', 'global-macro', { macroSymbols: ['SPY', 'DGS10'], categories: ['equity', 'bond'] }),
        widget('macro-b', 'global-macro', { macroSymbols: ['EURUSD=X', 'GC=F'], categories: ['fx', 'commodity'] }),
      ],
      layouts: [],
    })
    const restored = JSON.parse(JSON.stringify(dashboard)) as typeof dashboard
    expect(restored.widgets[0].macroSymbols).toEqual(['SPY', 'DGS10'])
    expect(restored.widgets[1].macroSymbols).toEqual(['EURUSD=X', 'GC=F'])
  })

  it('drops removed exposure widgets and repairs invalid saved layouts', () => {
    const dashboard = normalizeDashboard({
      id: 'd1',
      name: 'Old Risk',
      widgets: [
        widget('risk', 'risk-metrics'),
        { id: 'old-exposure', type: 'exposure-map' } as unknown as WidgetConfig,
      ],
      layouts: [
        { i: 'risk', x: -4, y: -1, w: 30, h: 1 },
        { i: 'orphan', x: 0, y: 0, w: 4, h: 4 },
      ],
    })
    expect(dashboard.widgets.map(item => item.type)).toEqual(['risk-metrics'])
    expect(dashboard.layouts).toHaveLength(1)
    expect(dashboard.layouts[0].x).toBeGreaterThanOrEqual(0)
    expect(dashboard.layouts[0].w).toBeLessThanOrEqual(12)
    expect(dashboard.layouts[0].h).toBeGreaterThanOrEqual(WIDGET_DEFINITIONS['risk-metrics'].minimum.h)
    expect(dashboard.templateId).toBe('portfolio-risk')
    expect(dashboard.layoutMode).toBe('template')
  })
})

describe('responsive and preset behavior', () => {
  it('maps dimensions to usable responsive states', () => {
    expect(responsiveState('global-macro', 3, 6)).toBe('minimum')
    expect(responsiveState('global-macro', 3, 8)).toBe('compact')
    expect(responsiveState('global-macro', 6, 11)).toBe('full')
    expect(responsiveState('global-macro', 3, 6, 'summary')).toBe('summary')
  })

  it('enforces min and max dimensions and repairs missing layouts', () => {
    const widgets = [widget('factor', 'factor-decomposition')]
    const constrained = applyConstraints(widgets, [{ i: 'factor', x: 0, y: 0, w: 1, h: 1 }])
    expect(constrained[0]).toMatchObject({ minW: 5, minH: 5, w: 5, h: 5 })
    expect(validateLayout(widgets, [])).toHaveLength(1)
  })

  it('uses factor decomposition in Risk Desk without exposure or historical stress widgets', () => {
    const preset = buildPreset('risk')
    const types = preset.widgets.map(item => item.type)
    expect(types).toContain('portfolio-summary')
    expect(types).toContain('risk-metrics')
    expect(types).toContain('factor-decomposition')
    expect(types).not.toContain('exposure-map')
    expect(WIDGET_DEFINITIONS['risk-metrics'].description.toLowerCase()).not.toContain('stress')
    expect(preset.layouts.find(layout => preset.widgets.find(widget => widget.id === layout.i)?.type === 'factor-decomposition')?.h)
      .toBe(WIDGET_DEFINITIONS['factor-decomposition'].preferred.h)
  })
})
