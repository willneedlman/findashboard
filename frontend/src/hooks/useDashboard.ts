import { useState, useCallback, useEffect } from 'react'
import type { Layout } from 'react-grid-layout'
import {
  CREDIT_SPREAD_SERIES, DEFAULT_MACRO_STRIP_SERIES, MACRO_CALENDAR_CATEGORIES,
  MACRO_STRIP_SERIES, SECTOR_ROTATION_PERIODS,
  WIDGET_DEFINITIONS, WIDGET_DEFAULT_SIZE, WIDGET_DESCRIPTIONS, WIDGET_ICONS,
  WIDGET_LABELS, WIDGET_MIN_SIZES, isWidgetType,
  type DashboardObjective, type WidgetConfig, type WidgetType,
} from '../components/dashboard/widgetRegistry'
import {
  composeTemplateLayouts, selectDashboardTemplate,
  type DashboardTemplateId,
} from '../components/dashboard/dashboardTemplates'

export {
  WIDGET_DEFINITIONS, WIDGET_DEFAULT_SIZE, WIDGET_DESCRIPTIONS, WIDGET_ICONS,
  WIDGET_LABELS, WIDGET_MIN_SIZES,
}
export type { DashboardObjective, WidgetConfig, WidgetType }
export type { DashboardTemplateId }

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
  templateId?: DashboardTemplateId
  layoutMode?: 'template' | 'custom'
}

export interface StoredWorkspace {
  version: 3
  dashboards: Dashboard[]
  activeId: string
}


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

type PItem = { type: WidgetType; config?: Partial<WidgetConfig> }

function fromItems(items: PItem[], templateId: DashboardTemplateId): { widgets: WidgetConfig[]; layouts: Layout[]; templateId: DashboardTemplateId } {
  const widgets = items.map(it => ({ id: newId(), type: it.type, ...WIDGET_DEFINITIONS[it.type].defaultConfig, ...it.config }))
  return { widgets, layouts: composeTemplateLayouts(widgets, templateId), templateId }
}

const W_LIST = ['SPY', 'QQQ', 'NVDA', 'AAPL', 'TSLA', 'MSFT', 'AMZN', 'META']
const EARN = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL']

export function buildPreset(key: PresetKey): { widgets: WidgetConfig[]; layouts: Layout[]; templateId: DashboardTemplateId } {
  if (key === 'main') {
    const widgets = normalizeWidgets(DEFAULT_WIDGETS)
    const templateId: DashboardTemplateId = 'executive-overview'
    return { widgets, layouts: composeTemplateLayouts(widgets, templateId), templateId }
  }
  if (key === 'blank') return { widgets: [], layouts: [], templateId: 'executive-overview' }

  if (key === 'research') return fromItems([
    { type: 'screener' },
    { type: 'analyst-ratings', config: { ticker: 'AAPL' } },
    { type: 'sentiment-gauge' },
    { type: 'valuation', config: { ticker: 'AAPL' } },
    { type: 'pm-portfolios' },
    { type: 'insider-activity', config: { ticker: 'AAPL' } },
    { type: 'sector-rotation' },
    { type: 'correlation-matrix', config: { tickers: ['SPY', 'QQQ', 'TLT', 'GLD', 'BTC-USD'] } },
    { type: 'earnings-calendar', config: { tickers: EARN } },
    { type: 'news-feed', config: { tickers: ['SPY', 'AAPL', 'NVDA'] } },
  ], 'research-workspace')

  if (key === 'screening') return fromItems([
    { type: 'screener' },
    { type: 'watchlist', config: { tickers: W_LIST } },
    { type: 'mini-chart', config: { ticker: 'SPY', period: '1y' } },
    { type: 'sector-rotation' },
    { type: 'earnings-calendar', config: { tickers: EARN } },
    { type: 'heatmap' },
  ], 'market-monitor')

  if (key === 'market-overview') return fromItems([
    { type: 'index-tape', config: { tickers: ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', 'BTC-USD'] } },
    { type: 'global-macro' },
    { type: 'yield-curve' },
    { type: 'credit-spreads' },
    { type: 'sector-rotation' },
    { type: 'macro-calendar' },
    { type: 'news-feed', config: { tickers: ['SPY', 'AAPL', 'NVDA'] } },
    { type: 'sentiment-gauge' },
    { type: 'heatmap' },
  ], 'macro-dashboard')

  if (key === 'risk') return fromItems([
    { type: 'portfolio-summary' },
    { type: 'risk-metrics' },
    { type: 'factor-decomposition', config: { factorModel: 'macro', lookback: 365 } },
    { type: 'pnl-attribution' },
    { type: 'correlation-matrix', config: { tickers: ['SPY', 'QQQ', 'TLT', 'GLD', 'BTC-USD'] } },
    { type: 'pm-portfolios' },
  ], 'portfolio-risk')

  if (key === 'options') return fromItems([
    { type: 'options-snapshot', config: { ticker: 'AAPL' } },
    { type: 'options-pricer', config: { ticker: 'AAPL' } },
    { type: 'delta-target', config: { ticker: 'AAPL' } },
    { type: 'dealer-gex', config: { ticker: 'AAPL' } },
    { type: 'vol-skew', config: { ticker: 'AAPL' } },
    { type: 'sentiment-gauge' },
    { type: 'unusual-flow', config: { ticker: 'AAPL' } },
  ], 'market-monitor')

  if (key === 'cockpit') return fromItems([
    { type: 'index-tape', config: { tickers: ['SPY', 'QQQ', 'DIA', 'IWM', '^VIX', 'BTC-USD'] } },
    { type: 'market-hours', config: { layout: 'clock' } },
    { type: 'watchlist', config: { tickers: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'SPY', 'AMD', 'META'] } },
    { type: 'paper-trade', config: { ticker: 'BTC-USD' } },
    { type: 'pm-portfolios' },
  ], 'market-monitor')

  // Every PresetKey is handled above; fall back to the default workspace.
  const widgets = normalizeWidgets(DEFAULT_WIDGETS)
  return { widgets, layouts: composeTemplateLayouts(widgets, 'executive-overview'), templateId: 'executive-overview' }
}

// ── Storage (v3: template identity plus multiple named dashboards) ────────────

const BASE_KEY = 'finance-terminal-dashboard-v3'

function storageKey(userId?: string | null) {
  return userId ? `${BASE_KEY}-user-${userId}` : BASE_KEY
}

function defaultWorkspace(): StoredWorkspace {
  const id = newDashId()
  // New users land on the Trading Portal cockpit as the default dashboard.
  const p = buildPreset('cockpit')
  return { version: 3, dashboards: [{ id, name: 'Trading Portal', objective: 'trading', templateId: p.templateId, layoutMode: 'template', widgets: p.widgets, layouts: p.layouts }], activeId: id }
}

export function normalizeDashboard(dashboard: Dashboard): Dashboard {
  const widgets = normalizeWidgets(dashboard.widgets ?? [])
  const objective = dashboard.objective ?? inferDashboardObjective(widgets)
  const templateId = dashboard.templateId ?? selectDashboardTemplate(widgets, objective)
  const migrateToTemplate = !dashboard.templateId
  return {
    ...dashboard,
    objective,
    templateId,
    layoutMode: migrateToTemplate ? 'template' : dashboard.layoutMode ?? 'custom',
    widgets,
    layouts: migrateToTemplate
      ? composeTemplateLayouts(widgets, templateId)
      : validateLayout(widgets, dashboard.layouts ?? []),
  }
}

function load(userId?: string | null): StoredWorkspace {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    if (raw) {
      const parsed = JSON.parse(raw)
      if ((parsed?.version === 2 || parsed?.version === 3) && Array.isArray(parsed.dashboards) && parsed.dashboards.length) {
        const dashboards: Dashboard[] = parsed.dashboards.map(normalizeDashboard)
        const activeId = dashboards.some(d => d.id === parsed.activeId) ? parsed.activeId : dashboards[0].id
        return { version: 3, dashboards, activeId }
      }
      // Migrate a v1 single dashboard into the new workspace shape.
      if (parsed?.version === 1 && parsed.widgets && parsed.layouts) {
        const id = newDashId()
        const migrated = normalizeDashboard({ id, name: 'Main', widgets: parsed.widgets, layouts: parsed.layouts })
        return { version: 3, dashboards: [migrated], activeId: id }
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

const OBJECTIVE_ICONS: Record<DashboardObjective, string> = {
  trading: 'gauge',
  portfolio: 'briefcase',
  macro: 'globe',
  risk: 'shield',
  research: 'search',
  screening: 'filter',
  options: 'layers',
  general: 'grid',
}

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
  const objective = inferDashboardObjective(widgets)
  return composeTemplateLayouts(widgets, selectDashboardTemplate(widgets, objective), cols)
}

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
  const seenComposition = new Set<string>()
  return widgets.flatMap(widget => {
    if (!isWidgetType(widget.type) || widget.type === 'ticker-control') return []
    const def = WIDGET_DEFINITIONS[widget.type]
    if (!def.multiple && seenSingleton.has(widget.type)) return []
    const normalized = { ...def.defaultConfig, ...widget, visible: widget.visible !== false, displayState: widget.displayState ?? 'auto' } as WidgetConfig
    if (normalized.type === 'macro-strip') {
      const validSeries = normalized.tickers?.filter(series => MACRO_STRIP_SERIES.includes(series)) ?? []
      normalized.tickers = validSeries.length ? validSeries : [...DEFAULT_MACRO_STRIP_SERIES]
    }
    if (normalized.type === 'credit-spreads') {
      const validSeries = normalized.categories?.filter(series => CREDIT_SPREAD_SERIES.includes(series)) ?? []
      normalized.categories = validSeries.length ? validSeries : [...(def.defaultConfig.categories ?? [])]
      if (![30, 90, 180, 365].includes(normalized.lookback ?? 0)) normalized.lookback = 90
    }
    if (normalized.type === 'macro-calendar') {
      const validCategories = normalized.categories?.filter(category => MACRO_CALENDAR_CATEGORIES.includes(category)) ?? []
      normalized.categories = validCategories.length ? validCategories : [...MACRO_CALENDAR_CATEGORIES]
    }
    if (normalized.type === 'global-macro') {
      const validCategories = normalized.categories?.filter(category => ['equity', 'fx', 'bond', 'commodity', 'vol', 'crypto'].includes(category)) ?? []
      normalized.categories = validCategories.length ? validCategories : [...(def.defaultConfig.categories ?? [])]
    }
    if (normalized.type === 'sector-rotation' && !SECTOR_ROTATION_PERIODS.includes(normalized.sectorPeriod ?? '')) {
      normalized.sectorPeriod = '1M'
    }
    if (normalized.ticker) normalized.ticker = normalized.ticker.trim().toUpperCase()
    if (normalized.tickers) normalized.tickers = normalized.tickers.map(ticker => ticker.trim().toUpperCase()).filter(Boolean)
    const identity = compositionIdentity(normalized)
    if (seenComposition.has(identity)) return []
    seenComposition.add(identity)
    if (!def.multiple) seenSingleton.add(widget.type)
    return [normalized]
  })
}

export function compositionIdentity(widget: WidgetConfig): string {
  const def = WIDGET_DEFINITIONS[widget.type]
  const material = def.configOptions.map(option => [option, widget[option] ?? def.defaultConfig[option] ?? null])
  return JSON.stringify([widget.type, material])
}

export function compatibilityIssue(existing: WidgetConfig[], type: WidgetType, config: Partial<WidgetConfig> = {}): string | null {
  const def = WIDGET_DEFINITIONS[type]
  if (!def.multiple && existing.some(widget => widget.type === type)) return `${def.name} allows one instance per dashboard.`
  const candidate = { id: 'candidate', type, ...def.defaultConfig, ...config } as WidgetConfig
  if (existing.some(widget => compositionIdentity(widget) === compositionIdentity(candidate))) {
    return `${def.name} with the same configuration is already on this dashboard.`
  }
  const conflict = existing.find(widget => def.conflicts.includes(widget.type) || WIDGET_DEFINITIONS[widget.type].conflicts.includes(type))
  return conflict ? `${def.name} overlaps with ${WIDGET_DEFINITIONS[conflict.type].name}.` : null
}

export function compatibleSet(widgets: WidgetConfig[]): WidgetConfig[] {
  return normalizeWidgets(widgets).reduce<WidgetConfig[]>((accepted, widget) => {
    return compatibilityIssue(accepted, widget.type, widget) ? accepted : [...accepted, widget]
  }, [])
}

export function composeLayouts(widgets: WidgetConfig[], objective: DashboardObjective = inferDashboardObjective(widgets), cols = 12): Layout[] {
  const visible = normalizeWidgets(widgets).filter(widget => widget.visible !== false)
  return composeTemplateLayouts(visible, selectDashboardTemplate(visible, objective), cols)
}

export function composeIntelligentDashboard(widgets: WidgetConfig[], cols = 12) {
  const objective = inferDashboardObjective(widgets)
  const templateId = selectDashboardTemplate(widgets, objective)
  return {
    objective,
    templateId,
    layouts: composeTemplateLayouts(widgets, templateId, cols),
  }
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
    if (compatibilityIssue(active.widgets, type, config)) return
    const id = newId()
    const nw: WidgetConfig = { id, type, ...WIDGET_DEFINITIONS[type].defaultConfig, ...config }
    patchActive(d => {
      const widgets = [...d.widgets, nw]
      const composition = composeIntelligentDashboard(widgets)
      return { ...d, ...composition, layoutMode: 'template', widgets }
    })
  }, [active.widgets, patchActive])

  const removeWidget = useCallback((id: string) => {
    patchActive(d => ({ ...d, widgets: d.widgets.filter(w => w.id !== id), layouts: d.layouts.filter(l => l.i !== id) }))
  }, [patchActive])

  const updateWidget = useCallback((id: string, patch: Partial<WidgetConfig>) => {
    patchActive(d => ({ ...d, widgets: d.widgets.map(w => w.id === id ? { ...w, ...patch } : w) }))
  }, [patchActive])

  const updateLayouts = useCallback((layouts: readonly Layout[]) => {
    patchActive(d => ({ ...d, layoutMode: 'custom', layouts: validateLayout(d.widgets, [...layouts]) }))
  }, [patchActive])

  const duplicateWidget = useCallback((id: string) => {
    patchActive(d => {
      const source = d.widgets.find(widget => widget.id === id)
      if (!source || !WIDGET_DEFINITIONS[source.type].multiple) return d
      const duplicate = { ...source, id: newId(), title: source.title ? `${source.title} copy` : undefined }
      const widgets = [...d.widgets, duplicate]
      const composition = composeIntelligentDashboard(widgets)
      return { ...d, ...composition, layoutMode: 'template', widgets }
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
    patchActive(d => {
      const composition = composeIntelligentDashboard(d.widgets)
      return { ...d, ...composition, layoutMode: 'template' }
    })
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
    patchActive(d => ({ ...d, objective: 'trading', templateId: p.templateId, layoutMode: 'template', widgets: p.widgets, layouts: p.layouts }))
  }, [patchActive])

  // Apply an AI-proposed set of widgets: 'replace' the active dashboard's tiles,
  // 'append' them below what's there, or open a 'new' dashboard tab. Template
  // selection and registry constraints own the final geometry.
  const applyAiDashboard = useCallback((items: AiDashboardItem[], mode: 'replace' | 'append' | 'new', name?: string, requestedObjective?: DashboardObjective) => {
    const built = items.filter(it => isWidgetType(it.type) && it.type !== 'ticker-control').map(it => {
      const def = WIDGET_DEFAULT_SIZE[it.type] ?? { w: 4, h: 5 }
      const id = newId()
      return { widget: { id, type: it.type, ...WIDGET_DEFINITIONS[it.type].defaultConfig, ...(it.config ?? {}) } as WidgetConfig, i: id, w: it.w ?? def.w, h: it.h ?? def.h }
    })
    const newWidgets = compatibleSet(built.map(b => b.widget))
    if (mode === 'append') {
      patchActive(d => {
        const widgets = compatibleSet([...d.widgets, ...newWidgets])
        const composition = composeIntelligentDashboard(widgets)
        return { ...d, ...composition, layoutMode: 'template', widgets }
      })
      return
    }
    const objective = requestedObjective ?? inferDashboardObjective(newWidgets)
    const templateId = selectDashboardTemplate(newWidgets, objective)
    const layouts = composeTemplateLayouts(newWidgets, templateId)
    const dashboardName = (name || 'AI Dashboard').slice(0, 40)
    const icon = OBJECTIVE_ICONS[objective]
    if (mode === 'new') {
      const id = newDashId()
      persist({ ...ws, dashboards: [...ws.dashboards, { id, name: dashboardName, icon, objective, templateId, layoutMode: 'template', widgets: newWidgets, layouts }], activeId: id })
    } else {
      patchActive(d => ({ ...d, name: dashboardName, icon, objective, templateId, layoutMode: 'template', widgets: newWidgets, layouts }))
    }
  }, [ws, persist, patchActive])

  const switchDashboard = useCallback((id: string) => {
    if (ws.dashboards.some(d => d.id === id)) persist({ ...ws, activeId: id })
  }, [ws, persist])

  const createDashboard = useCallback((preset: PresetKey) => {
    const p = buildPreset(preset)
    const id = newDashId()
    const objective: DashboardObjective = preset === 'cockpit' ? 'trading' : preset === 'market-overview' ? 'macro' : preset === 'options' ? 'options' : preset === 'risk' ? 'risk' : preset === 'blank' || preset === 'main' ? 'general' : preset
    persist({ ...ws, dashboards: [...ws.dashboards, { id, name: PRESET_LABELS[preset], icon: PRESET_ICONS[preset], objective, templateId: p.templateId, layoutMode: 'template', widgets: p.widgets, layouts: p.layouts }], activeId: id })
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
    templateId: active.templateId ?? selectDashboardTemplate(active.widgets, active.objective ?? inferDashboardObjective(active.widgets)),
    layoutMode: active.layoutMode ?? 'custom',
    objective: active.objective ?? inferDashboardObjective(active.widgets),
    showTicker: active.showTicker ?? false, setShowTicker,
    dashboards: ws.dashboards.map(d => ({ id: d.id, name: d.name, icon: d.icon })),
    activeId: ws.activeId,
    switchDashboard, createDashboard, renameDashboard, deleteDashboard, setDashboardIcon,
  }
}
