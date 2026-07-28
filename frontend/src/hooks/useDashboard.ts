import { useState, useCallback, useEffect } from 'react'
import type { Layout } from 'react-grid-layout'
import {
  DEFAULT_MACRO_STRIP_SERIES, MACRO_STRIP_SERIES,
  WIDGET_DEFINITIONS, WIDGET_DEFAULT_SIZE, WIDGET_DESCRIPTIONS, WIDGET_ICONS,
  WIDGET_LABELS, WIDGET_MIN_SIZES, isWidgetType,
  type DashboardObjective, type WidgetConfig, type WidgetType,
} from '../components/dashboard/widgetRegistry'

export {
  WIDGET_DEFINITIONS, WIDGET_DEFAULT_SIZE, WIDGET_DESCRIPTIONS, WIDGET_ICONS,
  WIDGET_LABELS, WIDGET_MIN_SIZES,
}
export type { DashboardObjective, WidgetConfig, WidgetType }

// Widget types that key off config.ticker — the dashboard-wide ticker control
// broadcasts to all of these at once, and WidgetFrame uses the same list to
// decide which widgets get a ticker title + per-widget ticker gear.
// position-sizer follows the broadcast too: its ticker drives the live spot that
// auto-defaults entry/stop, so changing the master ticker re-prices the sizer.
export const TICKER_WIDGET_TYPES: WidgetType[] = [
  'price-card', 'mini-chart', 'options-snapshot', 'options-pricer', 'delta-target',
  'tradingview-chart', 'dealer-gex', 'vol-skew', 'analyst-ratings', 'valuation',
  'insider-activity', 'time-and-sales', 'unusual-flow', 'position-sizer', 'paper-trade',
]

export interface Dashboard {
  id: string
  name: string
  widgets: WidgetConfig[]
  layouts: Layout[]
  showTicker?: boolean   // surface the top-bar ticker selector on this dashboard
  icon?: string          // icon key (see DASH_ICON_KEYS in CustomDashboard); shown when the tab is collapsed
  objective?: DashboardObjective
}

export interface StoredWorkspace {
  version: 2
  dashboards: Dashboard[]
  activeId: string
}


// ── Default layout — all 20 widget types, one each ───────────────────────────
//
// 12-col grid, rowHeight=60px:
//
//  y=0   [══════════════════ MACRO STRIP (12×2) ═══════════════════════════]
//  y=2   [ TV CHART NVDA (8×9)              ][ WATCHLIST (4×5)            ]
//        [                                  ][ NEWS FEED  (4×4)           ]
//  y=11  [ GLOBAL MACRO (3×9) ][ MACRO CAL (5×9) ][ CREDIT SPREADS (4×9) ]
//  y=20  [ CORR MATRIX (4×6)  ][ MINI CHART (4×6)][ EARNINGS CAL  (4×6)  ]
//  y=26  [ YIELD CURVE (4×7)  ][ OPT SNAP   (4×7)][ PRICE CARD    (4×7)  ]
//  y=33  [ PORTFOLIO   (4×5)  ][ OPT PRICER (4×5)][ DELTA TARGET  (4×5)  ]

export const DEFAULT_WIDGETS: WidgetConfig[] = [
  { id: 'w1',  type: 'macro-strip' },
  { id: 'w2',  type: 'tradingview-chart',  ticker: 'NVDA' },
  { id: 'w3',  type: 'watchlist',          tickers: ['SPY','NVDA','AAPL','MSFT','AMZN','META','TSLA','GOOGL'] },
  { id: 'w4',  type: 'news-feed',          tickers: ['NVDA','SPY','AAPL'] },
  { id: 'w5',  type: 'global-macro' },
  { id: 'w6',  type: 'credit-spreads' },
  { id: 'w7',  type: 'options-snapshot',   ticker: 'SPY' },
  { id: 'w8',  type: 'portfolio-summary',  tickers: ['SPY','QQQ','TLT','GLD'], weights: [0.4, 0.3, 0.2, 0.1] },
  { id: 'w9',  type: 'earnings-calendar',  tickers: ['NVDA','AAPL','MSFT','AMZN','META','GOOGL'] },
  { id: 'w10', type: 'correlation-matrix', tickers: ['SPY','QQQ','TLT','GLD','BTC-USD'] },
  { id: 'w11', type: 'macro-calendar' },
  { id: 'w12', type: 'mini-chart',         ticker: 'SPY', period: '1y' },
  { id: 'w13', type: 'options-pricer',     ticker: 'SPY' },
  { id: 'w14', type: 'delta-target',       ticker: 'SPY' },
  { id: 'w15', type: 'price-card',         ticker: 'NVDA' },
  { id: 'w16', type: 'yield-curve' },
  { id: 'w17', type: 'sector-rotation' },
  { id: 'w18', type: 'dealer-gex',         ticker: 'SPY' },
  { id: 'w19', type: 'vol-skew',           ticker: 'SPY' },
  { id: 'w20', type: 'sentiment-gauge' },
  { id: 'w21', type: 'screener' },
  { id: 'w22', type: 'pm-portfolios' },
  { id: 'w23', type: 'paper-trade', ticker: 'SPY' },
  { id: 'w24', type: 'factor-decomposition', factorModel: 'macro', lookback: 365 },
]

export const DEFAULT_LAYOUTS: Layout[] = [
  // Row A — full-width macro strip
  { i: 'w1',  x: 0, y: 0,  w: 12, h: 2 },

  // Row B — hero chart + watchlist/news sidebar
  { i: 'w2',  x: 0, y: 2,  w: 8,  h: 9,  minH: 6, minW: 3 },
  { i: 'w3',  x: 8, y: 2,  w: 4,  h: 5 },
  { i: 'w4',  x: 8, y: 7,  w: 4,  h: 4 },

  // Row C — macro / rates intel (all 9 rows tall)
  { i: 'w5',  x: 0, y: 11, w: 3,  h: 9 },
  { i: 'w11', x: 3, y: 11, w: 5,  h: 9 },
  { i: 'w6',  x: 8, y: 11, w: 4,  h: 9 },

  // Row D — analytics trio
  { i: 'w10', x: 0, y: 20, w: 4,  h: 6 },
  { i: 'w12', x: 4, y: 20, w: 4,  h: 6,  minH: 4 },
  { i: 'w9',  x: 8, y: 20, w: 4,  h: 6 },

  // Row E — rates tools + price card
  { i: 'w16', x: 0, y: 26, w: 4,  h: 7 },
  { i: 'w7',  x: 4, y: 26, w: 4,  h: 7,  minH: 4, minW: 3 },
  { i: 'w15', x: 8, y: 26, w: 4,  h: 7,  minH: 6, minW: 3 },

  // Row F — options tools + portfolio
  { i: 'w8',  x: 0, y: 33, w: 4,  h: 5 },
  { i: 'w13', x: 4, y: 33, w: 4,  h: 5 },
  { i: 'w14', x: 8, y: 33, w: 4,  h: 5 },

  // Row G — vol surface + sector + sentiment
  { i: 'w17', x: 0, y: 38, w: 4,  h: 7 },
  { i: 'w18', x: 4, y: 38, w: 4,  h: 6 },
  { i: 'w19', x: 8, y: 38, w: 4,  h: 6 },
  { i: 'w20', x: 0, y: 45, w: 3,  h: 5 },
  { i: 'w21', x: 3, y: 45, w: 5,  h: 6 },
  { i: 'w22', x: 8, y: 45, w: 4,  h: 6 },
  { i: 'w23', x: 0, y: 51, w: 6,  h: 8 },
  { i: 'w24', x: 6, y: 51, w: 6,  h: 8 },
]

export function applyConstraints(widgets: WidgetConfig[], layouts: Layout[]): Layout[] {
  return layouts.map(item => {
    const widget = widgets.find(w => w.id === item.i)
    if (!widget) return item
    const def = WIDGET_DEFINITIONS[widget.type]
    return {
      ...item,
      minH: def.minimum.h,
      minW: def.minimum.w,
      maxH: def.maximum.h,
      maxW: def.maximum.w,
      h: Math.min(def.maximum.h, Math.max(item.h, def.minimum.h)),
      w: Math.min(def.maximum.w, Math.max(item.w, def.minimum.w)),
    }
  })
}

// ── Presets ───────────────────────────────────────────────────────────────────

let _seq = 0
const newId = () => `w${Date.now()}_${_seq++}`
const newDashId = () => `d${Date.now()}_${_seq++}`

export type PresetKey = 'main' | 'cockpit' | 'research' | 'screening' | 'market-overview' | 'options' | 'risk' | 'blank'

export const PRESET_LABELS: Record<PresetKey, string> = {
  main: 'Everything', cockpit: 'Trading Portal', research: 'Research', screening: 'Screening', 'market-overview': 'Market Overview', options: 'Options Desk', risk: 'Risk Desk', blank: 'Custom (blank)',
}

// Default icon key per preset (keys resolve to lucide icons in CustomDashboard).
export const PRESET_ICONS: Record<PresetKey, string> = {
  main: 'grid', cockpit: 'gauge', research: 'search', screening: 'filter',
  'market-overview': 'globe', options: 'layers', risk: 'shield', blank: 'grid',
}

// A preset is a hand-placed list of tiles (12-col grid, 60px rows) so each
// layout reads as a deliberate workspace rather than an auto-packed grid.
type PItem = { type: WidgetType; config?: Partial<WidgetConfig>; x: number; y: number; w: number; h: number }

function fromItems(items: PItem[]): { widgets: WidgetConfig[]; layouts: Layout[] } {
  const widgets = items.map(it => ({ id: newId(), type: it.type, ...WIDGET_DEFINITIONS[it.type].defaultConfig, ...it.config }))
  const layouts: Layout[] = items.map((it, i) => ({ i: widgets[i].id, x: it.x, y: it.y, w: it.w, h: it.h }))
  return { widgets, layouts: applyConstraints(widgets, layouts) }
}

const W_LIST = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'META']
const EARN = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL']

export function buildPreset(key: PresetKey): { widgets: WidgetConfig[]; layouts: Layout[] } {
  if (key === 'main') {
    const widgets = normalizeWidgets(DEFAULT_WIDGETS)
    return { widgets, layouts: applyConstraints(widgets, DEFAULT_LAYOUTS) }
  }
  if (key === 'blank') return { widgets: [], layouts: [] }

  // Research — screener + analyst + sentiment / valuation + portfolios + insider /
  // sector + correlation + earnings / full-width news (Trading Portal design).
  if (key === 'research') return fromItems([
    { type: 'screener',                                                 x: 0, y: 0,  w: 5, h: 7 },
    { type: 'analyst-ratings',    config: { ticker: 'AAPL' },           x: 5, y: 0,  w: 4, h: 7 },
    { type: 'sentiment-gauge',                                          x: 9, y: 0,  w: 3, h: 7 },
    { type: 'valuation',          config: { ticker: 'AAPL' },           x: 0, y: 7,  w: 5, h: 6 },
    { type: 'pm-portfolios',                                            x: 5, y: 7,  w: 4, h: 6 },
    { type: 'insider-activity',   config: { ticker: 'AAPL' },           x: 9, y: 7,  w: 3, h: 6 },
    { type: 'sector-rotation',                                          x: 0, y: 13, w: 4, h: 7 },
    { type: 'correlation-matrix', config: { tickers: ['SPY', 'QQQ', 'TLT', 'GLD', 'BTC-USD'] }, x: 4, y: 13, w: 4, h: 7 },
    { type: 'earnings-calendar',  config: { tickers: EARN },           x: 8, y: 13, w: 4, h: 7 },
    { type: 'news-feed',          config: { tickers: ['SPY', 'AAPL', 'NVDA'] }, x: 0, y: 20, w: 12, h: 4 },
  ])

  // Screening — large screener + watchlist + mini chart / sector + earnings /
  // full-width market heatmap (Trading Portal design).
  if (key === 'screening') return fromItems([
    { type: 'screener',                                                 x: 0, y: 0,  w: 7, h: 9 },
    { type: 'watchlist',          config: { tickers: W_LIST },          x: 7, y: 0,  w: 5, h: 6 },
    { type: 'mini-chart',         config: { ticker: 'SPY', period: '1y' }, x: 7, y: 6, w: 5, h: 3 },
    { type: 'sector-rotation',                                          x: 0, y: 9,  w: 6, h: 7 },
    { type: 'earnings-calendar',  config: { tickers: EARN },           x: 6, y: 9,  w: 6, h: 7 },
    { type: 'heatmap',                                                 x: 0, y: 16, w: 12, h: 8 },
  ])

  // Market Overview — index tape / global macro + yield curve + credit spreads /
  // sector + news + sentiment / full-width market heatmap (Trading Portal design).
  if (key === 'market-overview') return fromItems([
    { type: 'index-tape',   config: { tickers: ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', 'BTC-USD'] }, x: 0, y: 0, w: 12, h: 1 },
    { type: 'global-macro',                                             x: 0, y: 1,  w: 3, h: 9 },
    { type: 'yield-curve',                                              x: 3, y: 1,  w: 5, h: 9 },
    { type: 'credit-spreads',                                           x: 8, y: 1,  w: 4, h: 9 },
    { type: 'sector-rotation',                                          x: 0, y: 10, w: 4, h: 7 },
    { type: 'macro-calendar',                                           x: 4, y: 10, w: 4, h: 7 },
    { type: 'news-feed',          config: { tickers: ['SPY', 'AAPL', 'NVDA'] }, x: 8, y: 10, w: 4, h: 7 },
    { type: 'sentiment-gauge',                                          x: 0, y: 17, w: 3, h: 7 },
    { type: 'heatmap',                                                 x: 3, y: 17, w: 9, h: 7 },
  ])

  // Risk Desk: risk metrics and factor decomposition lead, with attribution,
  // diversification, portfolio context, and the order ledger below.
  if (key === 'risk') return fromItems([
    { type: 'risk-metrics',                                             x: 0, y: 0,  w: 5, h: 6 },
    { type: 'factor-decomposition', config: { factorModel: 'macro', lookback: 365 }, x: 5, y: 0, w: 7, h: 6 },
    { type: 'pnl-attribution',                                         x: 0, y: 6,  w: 12, h: 6 },
    { type: 'correlation-matrix', config: { tickers: ['SPY', 'QQQ', 'TLT', 'GLD', 'BTC-USD'] }, x: 0, y: 12, w: 4, h: 7 },
    { type: 'pm-portfolios',                                           x: 4, y: 12, w: 4, h: 7 },
    { type: 'trade-blotter',                                           x: 8, y: 12, w: 4, h: 7 },
  ])

  // Options Desk — snapshot + pricer + delta-target / dealer GEX + vol skew +
  // sentiment / full-width unusual options flow (Trading Portal design).
  if (key === 'options') return fromItems([
    { type: 'options-snapshot', config: { ticker: 'AAPL' },             x: 0, y: 0,  w: 7, h: 9 },
    { type: 'options-pricer',   config: { ticker: 'AAPL' },             x: 7, y: 0,  w: 5, h: 5 },
    { type: 'delta-target',     config: { ticker: 'AAPL' },             x: 7, y: 5,  w: 5, h: 6 },
    { type: 'dealer-gex',       config: { ticker: 'AAPL' },             x: 0, y: 9,  w: 4, h: 7 },
    { type: 'vol-skew',         config: { ticker: 'AAPL' },             x: 4, y: 9,  w: 3, h: 7 },
    { type: 'sentiment-gauge',                                          x: 7, y: 11, w: 5, h: 5 },
    { type: 'unusual-flow',     config: { ticker: 'AAPL' },             x: 0, y: 16, w: 12, h: 6 },
  ])

  if (key === 'cockpit') return fromItems([
    // Trading Portal "cockpit": ticker-tape strip; a market-hours dial over the
    // watchlist on the left, a wide chart + order ticket as the main panel, and
    // the portfolios ledger full-width underneath.
    { type: 'index-tape',    config: { tickers: ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', 'BTC-USD'] }, x: 0, y: 0, w: 12, h: 1 },
    { type: 'market-hours',  config: { layout: 'clock' },              x: 0, y: 1,  w: 3,  h: 5 },
    { type: 'watchlist',     config: { tickers: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'SPY', 'AMD', 'META'] }, x: 0, y: 6, w: 3, h: 5 },
    { type: 'paper-trade',   config: { ticker: 'BTC-USD' },             x: 3, y: 1,  w: 9,  h: 10 },
    { type: 'pm-portfolios',                                            x: 0, y: 11, w: 12, h: 6 },
  ])

  // Every PresetKey is handled above; fall back to the default workspace.
  return { widgets: DEFAULT_WIDGETS, layouts: DEFAULT_LAYOUTS }
}

// ── Storage (v2: multiple named dashboards, per-user when a userId is given) ─────

const BASE_KEY = 'finance-terminal-dashboard-v3'

function storageKey(userId?: string | null) {
  return userId ? `${BASE_KEY}-user-${userId}` : BASE_KEY
}

function defaultWorkspace(): StoredWorkspace {
  const id = newDashId()
  // New users land on the Trading Portal cockpit as the default dashboard.
  const p = buildPreset('cockpit')
  return { version: 2, dashboards: [{ id, name: 'Trading Portal', objective: 'trading', widgets: p.widgets, layouts: p.layouts }], activeId: id }
}

export function normalizeDashboard(dashboard: Dashboard): Dashboard {
  const widgets = normalizeWidgets(dashboard.widgets ?? [])
  const objective = dashboard.objective ?? inferDashboardObjective(widgets)
  return {
    ...dashboard,
    objective,
    widgets,
    layouts: validateLayout(widgets, dashboard.layouts ?? []),
  }
}

function load(userId?: string | null): StoredWorkspace {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.version === 2 && Array.isArray(parsed.dashboards) && parsed.dashboards.length) {
        const dashboards: Dashboard[] = parsed.dashboards.map(normalizeDashboard)
        const activeId = dashboards.some(d => d.id === parsed.activeId) ? parsed.activeId : dashboards[0].id
        return { version: 2, dashboards, activeId }
      }
      // Migrate a v1 single dashboard into the new workspace shape.
      if (parsed?.version === 1 && parsed.widgets && parsed.layouts) {
        const id = newDashId()
        const migrated = normalizeDashboard({ id, name: 'Main', widgets: parsed.widgets, layouts: parsed.layouts })
        return { version: 2, dashboards: [migrated], activeId: id }
      }
    }
  } catch { /* ignore */ }
  return defaultWorkspace()
}

function save(w: StoredWorkspace, userId?: string | null) {
  try { localStorage.setItem(storageKey(userId), JSON.stringify(w)) } catch { /* ignore */ }
}

// One AI-proposed widget: type + config + a suggested size. Positions are
// derived by the packer, so the AI never has to get x/y exactly right.
export interface AiDashboardItem { type: WidgetType; config?: Partial<WidgetConfig>; w?: number; h?: number }

// Skyline packing preserves each widget's purposeful size and fills the lowest
// available slot. Short supporting widgets can stack beside a tall primary
// panel without either dimension being inflated just to complete a row.
export function packItems(sized: { i: string; w: number; h: number }[], cols = 12, baseY = 0): Layout[] {
  const skyline = Array.from({ length: cols }, () => baseY)
  const layouts: Layout[] = []

  for (const it of sized) {
    const w = Math.max(1, Math.min(Math.round(it.w) || 1, cols))
    const h = Math.max(1, Math.round(it.h) || 1)
    let bestX = 0
    let bestY = Number.POSITIVE_INFINITY
    let bestWaste = Number.POSITIVE_INFINITY

    for (let x = 0; x <= cols - w; x++) {
      const span = skyline.slice(x, x + w)
      const y = Math.max(...span)
      const waste = span.reduce((sum, columnY) => sum + y - columnY, 0)
      if (y < bestY || (y === bestY && waste < bestWaste)) {
        bestX = x
        bestY = y
        bestWaste = waste
      }
    }

    layouts.push({ i: it.i, x: bestX, y: bestY, w, h })
    for (let x = bestX; x < bestX + w; x++) skyline[x] = bestY + h
  }

  return layouts
}

export function reflowLayouts(widgets: WidgetConfig[], layouts: Layout[], cols: number, sourceCols = 12): Layout[] {
  if (cols === sourceCols) return layouts
  const widgetById = new Map(widgets.map(widget => [widget.id, widget]))
  const ordered = [...layouts]
    .filter(layout => widgetById.get(layout.i)?.visible !== false)
    .sort((a, b) => a.y - b.y || a.x - b.x)
  const sizes = ordered.map(layout => {
    const widget = widgetById.get(layout.i)!
    const def = WIDGET_DEFINITIONS[widget.type]
    const fullWidth = layout.w >= sourceCols || widget.type === 'index-tape' || widget.type === 'macro-strip'
    const scaledMinimum = Math.max(1, Math.ceil(def.minimum.w * cols / sourceCols))
    const scaledWidth = fullWidth
      ? cols
      : Math.max(scaledMinimum, Math.min(cols, Math.floor(layout.w * cols / sourceCols)))
    return { i: layout.i, w: scaledWidth, h: layout.h }
  })
  const packed = packItems(sizes, cols)
  return packed.map(layout => {
    const widget = widgetById.get(layout.i)!
    const def = WIDGET_DEFINITIONS[widget.type]
    return {
      ...layout,
      minW: Math.max(1, Math.ceil(def.minimum.w * cols / sourceCols)),
      minH: def.minimum.h,
      maxW: Math.max(1, Math.min(cols, Math.ceil(def.maximum.w * cols / sourceCols))),
      maxH: def.maximum.h,
    }
  })
}

const REGION_ORDER = { top: 0, center: 1, rail: 2, body: 3, bottom: 4 }
const PRIORITY_ORDER = { primary: 0, secondary: 1, supporting: 2 }

export function inferDashboardObjective(widgets: WidgetConfig[]): DashboardObjective {
  const scores = new Map<DashboardObjective, number>()
  for (const widget of widgets) {
    const def = WIDGET_DEFINITIONS[widget.type]
    for (const objective of def.objectives) {
      scores.set(objective, (scores.get(objective) ?? 0) + (def.priority === 'primary' ? 3 : def.priority === 'secondary' ? 2 : 1))
    }
  }
  return [...scores].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'general'
}

export function normalizeWidgets(widgets: WidgetConfig[]): WidgetConfig[] {
  const seenSingleton = new Set<WidgetType>()
  return widgets.flatMap(widget => {
    if (!isWidgetType(widget.type) || widget.type === 'ticker-control') return []
    const def = WIDGET_DEFINITIONS[widget.type]
    if (!def.multiple && seenSingleton.has(widget.type)) return []
    if (!def.multiple) seenSingleton.add(widget.type)
    const normalized = { ...def.defaultConfig, ...widget, visible: widget.visible !== false, displayState: widget.displayState ?? 'auto' } as WidgetConfig
    if (normalized.type === 'macro-strip') {
      const validSeries = normalized.tickers?.filter(series => MACRO_STRIP_SERIES.includes(series)) ?? []
      normalized.tickers = validSeries.length ? validSeries : [...DEFAULT_MACRO_STRIP_SERIES]
    }
    return [normalized]
  })
}

export function compatibilityIssue(existing: WidgetConfig[], type: WidgetType): string | null {
  const def = WIDGET_DEFINITIONS[type]
  if (!def.multiple && existing.some(widget => widget.type === type)) return `${def.name} allows one instance per dashboard.`
  const conflict = existing.find(widget => def.conflicts.includes(widget.type) || WIDGET_DEFINITIONS[widget.type].conflicts.includes(type))
  return conflict ? `${def.name} overlaps with ${WIDGET_DEFINITIONS[conflict.type].name}.` : null
}

export function compatibleSet(widgets: WidgetConfig[]): WidgetConfig[] {
  return normalizeWidgets(widgets).reduce<WidgetConfig[]>((accepted, widget) => {
    return compatibilityIssue(accepted, widget.type) ? accepted : [...accepted, widget]
  }, [])
}

export function composeLayouts(widgets: WidgetConfig[], objective: DashboardObjective = inferDashboardObjective(widgets), cols = 12): Layout[] {
  const visible = normalizeWidgets(widgets).filter(widget => widget.visible !== false)
  const ordered = [...visible].sort((a, b) => {
    const da = WIDGET_DEFINITIONS[a.type]
    const db = WIDGET_DEFINITIONS[b.type]
    const topRank = (widget: WidgetConfig) => widget.type === 'index-tape' ? 0 : widget.type === 'macro-strip' ? 1 : 2
    const topDelta = topRank(a) - topRank(b)
    if (topDelta) return topDelta
    const objectiveDelta = Number(!da.objectives.includes(objective)) - Number(!db.objectives.includes(objective))
    if (objectiveDelta) return objectiveDelta
    const regionDelta = REGION_ORDER[da.region] - REGION_ORDER[db.region]
    if (regionDelta) return regionDelta
    const priorityDelta = PRIORITY_ORDER[da.priority] - PRIORITY_ORDER[db.priority]
    if (priorityDelta) return priorityDelta
    return da.category.localeCompare(db.category)
  })

  const sizes = ordered.map(widget => {
    const def = WIDGET_DEFINITIONS[widget.type]
    let { w, h } = def.preferred
    if (widget.type === 'index-tape' || widget.type === 'macro-strip') w = cols
    if (objective === 'trading' && widget.type === 'paper-trade') {
      w = 9
      h = Math.max(h, 10)
    }
    return { i: widget.id, w: Math.min(cols, w), h }
  })
  return applyConstraints(ordered, packItems(sizes, cols))
}

export function validateLayout(widgets: WidgetConfig[], layouts: Layout[], cols = 12): Layout[] {
  const ids = new Set(widgets.map(widget => widget.id))
  const valid = layouts.filter(layout => ids.has(layout.i)).map(layout => ({
    ...layout,
    x: Math.max(0, Math.min(cols - 1, Math.round(layout.x))),
    y: Math.max(0, Math.round(layout.y)),
    w: Math.max(1, Math.min(cols, Math.round(layout.w))),
    h: Math.max(1, Math.round(layout.h)),
  })).map(layout => ({ ...layout, x: Math.min(layout.x, cols - layout.w) }))
  const represented = new Set(valid.map(layout => layout.i))
  const missing = widgets.filter(widget => !represented.has(widget.id))
  if (!missing.length) return applyConstraints(widgets, valid)
  const baseY = valid.reduce((max, layout) => Math.max(max, layout.y + layout.h), 0)
  const appended = composeLayouts(missing, inferDashboardObjective(widgets), cols).map(layout => ({ ...layout, y: layout.y + baseY }))
  return applyConstraints(widgets, [...valid, ...appended])
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useDashboard(userId?: string | null) {
  const [ws, setWs] = useState<StoredWorkspace>(() => load(userId))

  // When user changes (login / logout), reload that user's workspace
  useEffect(() => { setWs(load(userId)) }, [userId])

  const persist = useCallback((next: StoredWorkspace) => {
    setWs(next)
    save(next, userId)
  }, [userId])

  const active = ws.dashboards.find(d => d.id === ws.activeId) ?? ws.dashboards[0]

  const patchActive = useCallback((fn: (d: Dashboard) => Dashboard) => {
    persist({ ...ws, dashboards: ws.dashboards.map(d => d.id === ws.activeId ? fn(d) : d) })
  }, [ws, persist])

  const addWidget = useCallback((type: WidgetType, config: Partial<WidgetConfig> = {}) => {
    if (compatibilityIssue(active.widgets, type)) return
    const id = newId()
    const nw: WidgetConfig = { id, type, ...WIDGET_DEFINITIONS[type].defaultConfig, ...config }
    patchActive(d => {
      const widgets = [...d.widgets, nw]
      return { ...d, widgets, layouts: composeLayouts(widgets, d.objective) }
    })
  }, [active.widgets, patchActive])

  const removeWidget = useCallback((id: string) => {
    patchActive(d => ({ ...d, widgets: d.widgets.filter(w => w.id !== id), layouts: d.layouts.filter(l => l.i !== id) }))
  }, [patchActive])

  const updateWidget = useCallback((id: string, patch: Partial<WidgetConfig>) => {
    patchActive(d => ({ ...d, widgets: d.widgets.map(w => w.id === id ? { ...w, ...patch } : w) }))
  }, [patchActive])

  const updateLayouts = useCallback((layouts: readonly Layout[]) => {
    patchActive(d => ({ ...d, layouts: validateLayout(d.widgets, [...layouts]) }))
  }, [patchActive])

  const duplicateWidget = useCallback((id: string) => {
    patchActive(d => {
      const source = d.widgets.find(widget => widget.id === id)
      if (!source || !WIDGET_DEFINITIONS[source.type].multiple) return d
      const duplicate = { ...source, id: newId(), title: source.title ? `${source.title} copy` : undefined }
      const widgets = [...d.widgets, duplicate]
      return { ...d, widgets, layouts: composeLayouts(widgets, d.objective) }
    })
  }, [patchActive])

  const resetWidget = useCallback((id: string) => {
    patchActive(d => ({
      ...d,
      widgets: d.widgets.map(widget => widget.id === id
        ? { id: widget.id, type: widget.type, ...WIDGET_DEFINITIONS[widget.type].defaultConfig }
        : widget),
    }))
  }, [patchActive])

  const autoOrganize = useCallback(() => {
    patchActive(d => ({ ...d, layouts: composeLayouts(d.widgets, d.objective) }))
  }, [patchActive])

  // Retarget every ticker-driven widget in one pass — looping updateWidget would
  // race on the captured workspace snapshot (last write wins).
  const setShowTicker = useCallback((show: boolean) => {
    patchActive(d => ({ ...d, showTicker: show }))
  }, [patchActive])

  const setAllTickers = useCallback((ticker: string) => {
    // Clear any per-widget expiry too: expiries are ticker-specific, so a stale
    // one (e.g. dealer-gex / vol-skew) would point at a chain the new ticker may
    // not have. Empty expiry makes those widgets re-aggregate / auto-select.
    patchActive(d => ({ ...d, widgets: d.widgets.map(w => TICKER_WIDGET_TYPES.includes(w.type) ? { ...w, ticker, expiry: '' } : w) }))
  }, [patchActive])

  const resetDashboard = useCallback(() => {
    const p = buildPreset('cockpit')
    patchActive(d => ({ ...d, objective: 'trading', widgets: p.widgets, layouts: p.layouts }))
  }, [patchActive])

  // Apply an AI-proposed set of widgets: 'replace' the active dashboard's tiles,
  // 'append' them below what's there, or open a 'new' dashboard tab. The packer
  // derives clean, non-overlapping positions from each item's size + order.
  const applyAiDashboard = useCallback((items: AiDashboardItem[], mode: 'replace' | 'append' | 'new', name?: string) => {
    const built = items.filter(it => isWidgetType(it.type) && it.type !== 'ticker-control').map(it => {
      const def = WIDGET_DEFAULT_SIZE[it.type] ?? { w: 4, h: 5 }
      const id = newId()
      return { widget: { id, type: it.type, ...WIDGET_DEFINITIONS[it.type].defaultConfig, ...(it.config ?? {}) } as WidgetConfig, i: id, w: it.w ?? def.w, h: it.h ?? def.h }
    })
    const newWidgets = compatibleSet(built.map(b => b.widget))
    if (mode === 'append') {
      patchActive(d => {
        const widgets = compatibleSet([...d.widgets, ...newWidgets])
        return { ...d, widgets, layouts: composeLayouts(widgets, d.objective) }
      })
      return
    }
    const objective = inferDashboardObjective(newWidgets)
    const layouts = composeLayouts(newWidgets, objective)
    if (mode === 'new') {
      const id = newDashId()
      persist({ ...ws, dashboards: [...ws.dashboards, { id, name: (name || 'AI Dashboard').slice(0, 40), objective, widgets: newWidgets, layouts }], activeId: id })
    } else {
      patchActive(d => ({ ...d, objective, widgets: newWidgets, layouts }))
    }
  }, [ws, persist, patchActive])

  const switchDashboard = useCallback((id: string) => {
    if (ws.dashboards.some(d => d.id === id)) persist({ ...ws, activeId: id })
  }, [ws, persist])

  const createDashboard = useCallback((preset: PresetKey) => {
    const p = buildPreset(preset)
    const id = newDashId()
    const objective: DashboardObjective = preset === 'cockpit' ? 'trading' : preset === 'market-overview' ? 'macro' : preset === 'options' ? 'options' : preset === 'risk' ? 'risk' : preset === 'blank' || preset === 'main' ? 'general' : preset
    persist({ ...ws, dashboards: [...ws.dashboards, { id, name: PRESET_LABELS[preset], icon: PRESET_ICONS[preset], objective, widgets: p.widgets, layouts: p.layouts }], activeId: id })
  }, [ws, persist])

  const renameDashboard = useCallback((id: string, name: string) => {
    persist({ ...ws, dashboards: ws.dashboards.map(d => d.id === id ? { ...d, name } : d) })
  }, [ws, persist])

  const setDashboardIcon = useCallback((id: string, icon: string) => {
    persist({ ...ws, dashboards: ws.dashboards.map(d => d.id === id ? { ...d, icon } : d) })
  }, [ws, persist])

  const deleteDashboard = useCallback((id: string) => {
    if (ws.dashboards.length <= 1) return
    const dashboards = ws.dashboards.filter(d => d.id !== id)
    persist({ ...ws, dashboards, activeId: ws.activeId === id ? dashboards[0].id : ws.activeId })
  }, [ws, persist])

  return {
    widgets: active.widgets, layouts: active.layouts,
    addWidget, removeWidget, duplicateWidget, resetWidget, autoOrganize, updateWidget, updateLayouts, resetDashboard, setAllTickers, applyAiDashboard,
    showTicker: active.showTicker ?? false, setShowTicker,
    dashboards: ws.dashboards.map(d => ({ id: d.id, name: d.name, icon: d.icon })),
    activeId: ws.activeId,
    switchDashboard, createDashboard, renameDashboard, deleteDashboard, setDashboardIcon,
  }
}
