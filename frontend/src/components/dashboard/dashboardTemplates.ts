import type { Layout } from 'react-grid-layout'
import {
  WIDGET_DEFINITIONS,
  type DashboardObjective,
  type DashboardRegion,
  type WidgetConfig,
  type WidgetDensity,
  type WidgetOrientation,
  type WidgetPriority,
  type WidgetType,
  type WidgetVisualRole,
} from './widgetRegistry'
import type { WidgetContentState } from './widgetContentState'

export type DashboardTemplateId =
  | 'executive-overview'
  | 'market-monitor'
  | 'portfolio-risk'
  | 'research-workspace'
  | 'macro-dashboard'
  | 'news-events'
  | 'comparison'
  | 'compact'

export type TemplateSlotRole = 'strip' | 'kpi' | 'focal' | 'support' | 'rail' | 'table'

export interface DashboardTemplateSlot {
  id: string
  role: TemplateSlotRole
  x: number
  y: number
  w: number
  h: number
  priorities?: WidgetPriority[]
  orientations?: WidgetOrientation[]
  densities?: WidgetDensity[]
  regions?: DashboardRegion[]
  visualRoles?: WidgetVisualRole[]
  types?: WidgetType[]
}

export interface DashboardTemplate {
  id: DashboardTemplateId
  name: string
  shortName: string
  description: string
  objectives: DashboardObjective[]
  character: 'compact' | 'balanced' | 'spacious'
  slots: DashboardTemplateSlot[]
  mediumSlots: DashboardTemplateSlot[]
}

const slot = (
  id: string,
  role: TemplateSlotRole,
  x: number,
  y: number,
  w: number,
  h: number,
  traits: Omit<DashboardTemplateSlot, 'id' | 'role' | 'x' | 'y' | 'w' | 'h'> = {},
): DashboardTemplateSlot => ({ id, role, x, y, w, h, ...traits })

const stripTraits = {
  orientations: ['horizontal'] as WidgetOrientation[],
  regions: ['top', 'bottom'] as DashboardRegion[],
}
const focalTraits = {
  priorities: ['primary'] as WidgetPriority[],
  visualRoles: ['focal'] as WidgetVisualRole[],
}
const railTraits = {
  priorities: ['secondary', 'supporting'] as WidgetPriority[],
  regions: ['rail', 'top'] as DashboardRegion[],
  orientations: ['vertical', 'balanced'] as WidgetOrientation[],
}
const supportTraits = {
  priorities: ['secondary', 'supporting'] as WidgetPriority[],
  visualRoles: ['supporting'] as WidgetVisualRole[],
}

export const DASHBOARD_TEMPLATES: Record<DashboardTemplateId, DashboardTemplate> = {
  'executive-overview': {
    id: 'executive-overview',
    name: 'Executive Overview',
    shortName: 'Executive',
    description: 'One decisive view, two compact signals, then a balanced analysis row.',
    objectives: ['general', 'portfolio', 'risk'],
    character: 'spacious',
    slots: [
      slot('context', 'strip', 0, 0, 12, 2, stripTraits),
      slot('lead', 'focal', 0, 2, 7, 8, focalTraits),
      slot('signal-a', 'kpi', 7, 2, 5, 4, { densities: ['compact'], ...supportTraits }),
      slot('signal-b', 'support', 7, 6, 5, 4, supportTraits),
      slot('analysis-a', 'support', 0, 10, 4, 6, supportTraits),
      slot('analysis-b', 'support', 4, 10, 4, 6, supportTraits),
      slot('analysis-c', 'support', 8, 10, 4, 6, supportTraits),
    ],
    mediumSlots: [
      slot('context', 'strip', 0, 0, 10, 2, stripTraits),
      slot('lead', 'focal', 0, 2, 7, 8, focalTraits),
      slot('signal-a', 'kpi', 7, 2, 3, 4, { densities: ['compact'], ...supportTraits }),
      slot('signal-b', 'rail', 7, 6, 3, 4, railTraits),
      slot('analysis-a', 'support', 0, 10, 5, 6, supportTraits),
      slot('analysis-b', 'support', 5, 10, 5, 6, supportTraits),
    ],
  },
  'market-monitor': {
    id: 'market-monitor',
    name: 'Market Monitor',
    shortName: 'Market',
    description: 'A dense terminal board with a live strip, lead market view, and two rails.',
    objectives: ['trading', 'screening', 'options'],
    character: 'compact',
    slots: [
      slot('tape', 'strip', 0, 0, 12, 1, stripTraits),
      slot('lead', 'focal', 0, 1, 8, 8, focalTraits),
      slot('rail-a', 'rail', 8, 1, 4, 4, { ...railTraits, regions: ['top'] }),
      slot('rail-b', 'rail', 8, 5, 4, 4, { ...railTraits, regions: ['rail'] }),
      slot('lower-a', 'support', 0, 9, 6, 6, supportTraits),
      slot('lower-b', 'support', 6, 9, 6, 6, supportTraits),
    ],
    mediumSlots: [
      slot('tape', 'strip', 0, 0, 10, 1, stripTraits),
      slot('lead', 'focal', 0, 1, 7, 8, focalTraits),
      slot('rail-a', 'rail', 7, 1, 3, 4, { ...railTraits, regions: ['top'] }),
      slot('rail-b', 'rail', 7, 5, 3, 4, { ...railTraits, regions: ['rail'] }),
      slot('lower-a', 'support', 0, 9, 5, 6, supportTraits),
      slot('lower-b', 'support', 5, 9, 5, 6, supportTraits),
    ],
  },
  'portfolio-risk': {
    id: 'portfolio-risk',
    name: 'Portfolio and Risk',
    shortName: 'Portfolio',
    description: 'Paired risk leaders with attribution, diversification, and book context.',
    objectives: ['portfolio', 'risk'],
    character: 'balanced',
    slots: [
      slot('overview', 'focal', 0, 0, 7, 6, { ...focalTraits, types: ['portfolio-summary'] }),
      slot('risk', 'focal', 7, 0, 5, 6, { ...focalTraits, types: ['risk-metrics'] }),
      slot('factors', 'focal', 0, 6, 7, 5, { ...focalTraits, types: ['factor-decomposition'] }),
      slot('correlation', 'support', 7, 6, 5, 5, { ...supportTraits, types: ['correlation-matrix'] }),
      slot('attribution', 'table', 0, 11, 7, 6, { densities: ['dense'], regions: ['body', 'bottom'], types: ['pnl-attribution'] }),
      slot('book', 'rail', 7, 11, 5, 6, { ...railTraits, types: ['pm-portfolios'] }),
    ],
    mediumSlots: [
      slot('overview', 'focal', 0, 0, 6, 6, { ...focalTraits, types: ['portfolio-summary'] }),
      slot('risk', 'focal', 6, 0, 4, 6, { ...focalTraits, types: ['risk-metrics'] }),
      slot('factors', 'focal', 0, 6, 6, 5, { ...focalTraits, types: ['factor-decomposition'] }),
      slot('correlation', 'support', 6, 6, 4, 5, { ...supportTraits, types: ['correlation-matrix'] }),
      slot('attribution', 'table', 0, 11, 6, 6, { densities: ['dense'], regions: ['body', 'bottom'], types: ['pnl-attribution'] }),
      slot('book', 'rail', 6, 11, 4, 6, { ...railTraits, types: ['pm-portfolios'] }),
    ],
  },
  'research-workspace': {
    id: 'research-workspace',
    name: 'Research Workspace',
    shortName: 'Research',
    description: 'A dominant research surface with stacked context and an asymmetric evidence row.',
    objectives: ['research', 'screening'],
    character: 'spacious',
    slots: [
      slot('lead', 'focal', 0, 0, 8, 8, focalTraits),
      slot('rail-a', 'rail', 8, 0, 4, 4, railTraits),
      slot('rail-b', 'rail', 8, 4, 4, 4, railTraits),
      slot('evidence-a', 'support', 0, 8, 5, 6, supportTraits),
      slot('evidence-b', 'support', 5, 8, 4, 6, supportTraits),
      slot('evidence-c', 'rail', 9, 8, 3, 6, railTraits),
    ],
    mediumSlots: [
      slot('lead', 'focal', 0, 0, 7, 8, focalTraits),
      slot('rail-a', 'rail', 7, 0, 3, 4, railTraits),
      slot('rail-b', 'rail', 7, 4, 3, 4, railTraits),
      slot('evidence-a', 'support', 0, 8, 5, 6, supportTraits),
      slot('evidence-b', 'support', 5, 8, 5, 6, supportTraits),
    ],
  },
  'macro-dashboard': {
    id: 'macro-dashboard',
    name: 'Macro Dashboard',
    shortName: 'Macro',
    description: 'Rates context first, then a cross-asset rail and paired macro analysis.',
    objectives: ['macro', 'risk'],
    character: 'balanced',
    slots: [
      slot('rates', 'strip', 0, 0, 12, 2, stripTraits),
      slot('global', 'rail', 0, 2, 3, 8, railTraits),
      slot('curve', 'focal', 3, 2, 5, 8, focalTraits),
      slot('credit', 'support', 8, 2, 4, 8, supportTraits),
      slot('lower-a', 'support', 0, 10, 4, 6, supportTraits),
      slot('lower-b', 'table', 4, 10, 4, 6, { densities: ['dense'], regions: ['body'] }),
      slot('lower-c', 'support', 8, 10, 4, 6, supportTraits),
    ],
    mediumSlots: [
      slot('rates', 'strip', 0, 0, 10, 2, stripTraits),
      slot('global', 'rail', 0, 2, 3, 8, railTraits),
      slot('curve', 'focal', 3, 2, 7, 8, focalTraits),
      slot('lower-a', 'support', 0, 10, 5, 6, supportTraits),
      slot('lower-b', 'support', 5, 10, 5, 6, supportTraits),
    ],
  },
  'news-events': {
    id: 'news-events',
    name: 'News and Events',
    shortName: 'News',
    description: 'A feed-led workspace with event context and compact market signals.',
    objectives: ['research', 'macro', 'trading'],
    character: 'balanced',
    slots: [
      slot('feed', 'table', 0, 0, 6, 9, { densities: ['dense'], regions: ['rail', 'body'] }),
      slot('events', 'table', 6, 0, 6, 5, { densities: ['dense'], regions: ['body'] }),
      slot('signal', 'support', 6, 5, 3, 4, supportTraits),
      slot('watch', 'rail', 9, 5, 3, 4, railTraits),
      slot('lower-a', 'support', 0, 9, 4, 6, supportTraits),
      slot('lower-b', 'support', 4, 9, 4, 6, supportTraits),
      slot('lower-c', 'support', 8, 9, 4, 6, supportTraits),
    ],
    mediumSlots: [
      slot('feed', 'table', 0, 0, 6, 9, { densities: ['dense'], regions: ['rail', 'body'] }),
      slot('events', 'table', 6, 0, 4, 5, { densities: ['dense'], regions: ['body'] }),
      slot('watch', 'rail', 6, 5, 4, 4, railTraits),
      slot('lower-a', 'support', 0, 9, 5, 6, supportTraits),
      slot('lower-b', 'support', 5, 9, 5, 6, supportTraits),
    ],
  },
  comparison: {
    id: 'comparison',
    name: 'Comparison',
    shortName: 'Compare',
    description: 'Symmetrical lead panels for side-by-side analysis with matched support.',
    objectives: ['research', 'portfolio', 'options'],
    character: 'balanced',
    slots: [
      slot('left', 'focal', 0, 0, 6, 8, focalTraits),
      slot('right', 'focal', 6, 0, 6, 8, focalTraits),
      slot('left-support', 'support', 0, 8, 6, 6, supportTraits),
      slot('right-support', 'support', 6, 8, 6, 6, supportTraits),
      slot('lower-a', 'support', 0, 14, 4, 6, supportTraits),
      slot('lower-b', 'support', 4, 14, 4, 6, supportTraits),
      slot('lower-c', 'support', 8, 14, 4, 6, supportTraits),
    ],
    mediumSlots: [
      slot('left', 'focal', 0, 0, 5, 8, focalTraits),
      slot('right', 'focal', 5, 0, 5, 8, focalTraits),
      slot('left-support', 'support', 0, 8, 5, 6, supportTraits),
      slot('right-support', 'support', 5, 8, 5, 6, supportTraits),
    ],
  },
  compact: {
    id: 'compact',
    name: 'Compact Stack',
    shortName: 'Compact',
    description: 'A vertically prioritized composition for tablets, mobile, and narrow workspaces.',
    objectives: ['general'],
    character: 'compact',
    slots: [
      slot('context', 'strip', 0, 0, 12, 2, stripTraits),
      slot('lead', 'focal', 0, 2, 6, 7, focalTraits),
      slot('support-a', 'support', 6, 2, 6, 7, supportTraits),
      slot('support-b', 'support', 0, 9, 6, 6, supportTraits),
      slot('support-c', 'support', 6, 9, 6, 6, supportTraits),
    ],
    mediumSlots: [
      slot('context', 'strip', 0, 0, 10, 2, stripTraits),
      slot('lead', 'focal', 0, 2, 10, 7, focalTraits),
      slot('support-a', 'support', 0, 9, 5, 6, supportTraits),
      slot('support-b', 'support', 5, 9, 5, 6, supportTraits),
    ],
  },
}

export const DASHBOARD_TEMPLATE_IDS = Object.keys(DASHBOARD_TEMPLATES) as DashboardTemplateId[]

const PRIORITY_SCORE: Record<WidgetPriority, number> = { primary: 3, secondary: 2, supporting: 1 }

export function selectDashboardTemplate(
  widgets: WidgetConfig[],
  objective: DashboardObjective,
): DashboardTemplateId {
  const visible = widgets.filter(widget => widget.visible !== false)
  const denseCount = visible.filter(widget => WIDGET_DEFINITIONS[widget.type].density === 'dense').length
  const focalCount = visible.filter(widget => WIDGET_DEFINITIONS[widget.type].visualRole === 'focal').length
  const eventCount = visible.filter(widget => /calendar|news-feed/.test(widget.type)).length
  if (eventCount >= 2 && eventCount >= focalCount) return 'news-events'
  if (objective === 'portfolio' || objective === 'risk') return 'portfolio-risk'
  if (focalCount >= 2 && ['research', 'portfolio', 'options'].includes(objective)) return 'comparison'
  if (objective === 'trading' || objective === 'screening' || objective === 'options') return 'market-monitor'
  if (objective === 'macro') return 'macro-dashboard'
  if (objective === 'research') return 'research-workspace'
  if (denseCount > visible.length / 2) return 'market-monitor'
  return 'executive-overview'
}

function widgetOrder(widgets: WidgetConfig[], template: DashboardTemplate): WidgetConfig[] {
  const sourceOrder = new Map(widgets.map((widget, index) => [widget.id, index]))
  return widgets.filter(widget => widget.visible !== false).sort((a, b) => {
    const da = WIDGET_DEFINITIONS[a.type]
    const db = WIDGET_DEFINITIONS[b.type]
    const stripA = da.region === 'top' && da.orientation === 'horizontal' ? 1 : 0
    const stripB = db.region === 'top' && db.orientation === 'horizontal' ? 1 : 0
    if (stripA !== stripB) return stripB - stripA
    const objectiveA = da.objectives.some(objective => template.objectives.includes(objective)) ? 1 : 0
    const objectiveB = db.objectives.some(objective => template.objectives.includes(objective)) ? 1 : 0
    if (objectiveA !== objectiveB) return objectiveB - objectiveA
    if (PRIORITY_SCORE[da.priority] !== PRIORITY_SCORE[db.priority]) return PRIORITY_SCORE[db.priority] - PRIORITY_SCORE[da.priority]
    return (sourceOrder.get(a.id) ?? 0) - (sourceOrder.get(b.id) ?? 0)
  })
}

function slotScore(widget: WidgetConfig, target: DashboardTemplateSlot, template: DashboardTemplate): number {
  const def = WIDGET_DEFINITIONS[widget.type]
  if (def.minimum.w > target.w || def.minimum.h > target.h) return Number.NEGATIVE_INFINITY
  if (target.w > def.maximum.w || target.h > def.maximum.h) return Number.NEGATIVE_INFINITY
  let score = 0
  if (target.types?.includes(widget.type)) score += 80
  else if (target.types?.length) score -= 18
  if (target.priorities?.includes(def.priority)) score += 14
  if (target.orientations?.includes(def.orientation)) score += 10
  if (target.densities?.includes(def.density)) score += 8
  if (target.regions?.includes(def.region)) score += 9
  if (target.visualRoles?.includes(def.visualRole)) score += 16
  if (def.objectives.some(objective => template.objectives.includes(objective))) score += 8
  if (target.role === 'strip' && def.region === 'top') score += 30
  if (target.role === 'focal' && def.visualRole === 'focal') score += 28
  if (target.role === 'rail' && def.region === 'rail') score += 24
  if (target.role === 'table' && def.density === 'dense') score += 22
  if (target.role === 'kpi' && def.density === 'compact') score += 20
  score -= Math.abs(target.w - def.preferred.w) * 2
  score -= Math.abs(target.h - def.preferred.h)
  return score
}

function withResponsiveConstraints(
  widget: WidgetConfig,
  layout: Layout,
  cols: number,
  contentState?: WidgetContentState,
): Layout {
  const def = WIDGET_DEFINITIONS[widget.type]
  const scale = cols / 12
  const heightScale = cols <= 2 ? 0.7 : cols <= 4 ? 0.75 : cols <= 6 ? 0.85 : 1
  const compactState = contentState === 'empty' || contentState === 'error'
  const h = compactState ? Math.min(layout.h, 3) : layout.h
  return {
    ...layout,
    h,
    minW: Math.min(cols, Math.max(1, Math.ceil(def.minimum.w * scale))),
    minH: compactState ? Math.min(h, 2) : Math.min(h, Math.max(1, Math.ceil(def.minimum.h * heightScale))),
    maxW: Math.min(cols, Math.max(layout.w, Math.ceil(def.maximum.w * scale))),
    maxH: compactState ? Math.max(h, 3) : Math.max(h, Math.ceil(def.maximum.h * heightScale)),
  }
}

interface AssignedSlot {
  widget: WidgetConfig
  target: DashboardTemplateSlot
}

interface TemplateSection {
  start: number
  end: number
  slots: DashboardTemplateSlot[]
}

function assignSlots(
  widgets: WidgetConfig[],
  slots: DashboardTemplateSlot[],
  template: DashboardTemplate,
): { assigned: AssignedSlot[]; overflow: WidgetConfig[] } {
  const memo = new Map<string, { score: number; choices: number[] }>()

  const solve = (widgetIndex: number, usedMask: number): { score: number; choices: number[] } => {
    if (widgetIndex >= widgets.length) return { score: 0, choices: [] }
    const key = `${widgetIndex}:${usedMask}`
    const cached = memo.get(key)
    if (cached) return cached

    const skipped = solve(widgetIndex + 1, usedMask)
    let best = { score: skipped.score - 12, choices: [-1, ...skipped.choices] }

    for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
      if (usedMask & (1 << slotIndex)) continue
      const score = slotScore(widgets[widgetIndex], slots[slotIndex], template)
      if (!Number.isFinite(score)) continue
      const next = solve(widgetIndex + 1, usedMask | (1 << slotIndex))
      const candidate = { score: score + next.score, choices: [slotIndex, ...next.choices] }
      if (candidate.score > best.score) best = candidate
    }

    memo.set(key, best)
    return best
  }

  const { choices } = solve(0, 0)
  const assigned: AssignedSlot[] = []
  const overflow: WidgetConfig[] = []
  widgets.forEach((widget, index) => {
    const slotIndex = choices[index] ?? -1
    if (slotIndex < 0) overflow.push(widget)
    else assigned.push({ widget, target: slots[slotIndex] })
  })
  return { assigned, overflow }
}

function deriveSections(slots: DashboardTemplateSlot[]): TemplateSection[] {
  const boundaries = [...new Set(slots.flatMap(item => [item.y, item.y + item.h]))].sort((a, b) => a - b)
  const seams = boundaries.filter(boundary => !slots.some(item => item.y < boundary && item.y + item.h > boundary))
  const sections: TemplateSection[] = []
  for (let index = 0; index < seams.length - 1; index++) {
    const start = seams[index]
    const end = seams[index + 1]
    const sectionSlots = slots.filter(item => item.y >= start && item.y + item.h <= end)
    if (sectionSlots.length) sections.push({ start, end, slots: sectionSlots })
  }
  return sections
}

function scaledWidth(value: number, cols: number, mode: 'ceil' | 'round' = 'round'): number {
  const scaled = value * cols / 12
  return Math.max(1, mode === 'ceil' ? Math.ceil(scaled) : Math.round(scaled))
}

function widthBounds(widget: WidgetConfig, cols: number) {
  const def = WIDGET_DEFINITIONS[widget.type]
  const min = Math.min(cols, scaledWidth(def.minimum.w, cols, 'ceil'))
  const max = Math.min(cols, Math.max(min, scaledWidth(def.maximum.w, cols, 'ceil')))
  return {
    min,
    preferred: Math.min(max, Math.max(min, scaledWidth(def.preferred.w, cols))),
    max,
  }
}

function allocateRowWidths(widgets: WidgetConfig[], cols: number): number[] | null {
  const bounds = widgets.map(widget => widthBounds(widget, cols))
  if (bounds.reduce((sum, item) => sum + item.min, 0) > cols) return null
  const widths = bounds.map(item => item.preferred)

  while (widths.reduce((sum, width) => sum + width, 0) > cols) {
    let candidate = -1
    for (let index = 0; index < widths.length; index++) {
      if (widths[index] <= bounds[index].min) continue
      if (candidate < 0 || widths[index] - bounds[index].min > widths[candidate] - bounds[candidate].min) candidate = index
    }
    if (candidate < 0) return null
    widths[candidate]--
  }

  const growthRank = (widget: WidgetConfig) => {
    const def = WIDGET_DEFINITIONS[widget.type]
    if (def.growth === 'fixed' || def.growth === 'vertical') return 0
    if (def.growth === 'horizontal') return 3
    return def.visualRole === 'focal' ? 2 : 1
  }
  const candidates = widgets
    .map((widget, index) => ({ index, rank: growthRank(widget) }))
    .filter(({ index, rank }) => rank > 0 && widths[index] < bounds[index].max)
    .sort((a, b) => b.rank - a.rank || a.index - b.index)

  let remaining = cols - widths.reduce((sum, width) => sum + width, 0)
  while (remaining > 0 && candidates.length) {
    let changed = false
    for (const candidate of candidates) {
      if (!remaining) break
      if (widths[candidate.index] >= bounds[candidate.index].max) continue
      widths[candidate.index]++
      remaining--
      changed = true
    }
    if (!changed) break
  }
  return widths
}

function naturalHeight(
  widget: WidgetConfig,
  target: DashboardTemplateSlot,
  contentState?: WidgetContentState,
): number {
  if (contentState === 'empty' || contentState === 'error') return Math.min(3, target.h)
  const def = WIDGET_DEFINITIONS[widget.type]
  return Math.max(def.minimum.h, Math.min(def.maximum.h, def.preferred.h, target.h))
}

function materializeCompactSection(
  assignments: AssignedSlot[],
  cols: number,
  baseY: number,
  contentStates: Record<string, WidgetContentState>,
): Layout[] {
  const ordered = [...assignments].sort((a, b) => a.target.x - b.target.x || a.target.y - b.target.y)
  if (ordered.length === 1) {
    const { widget, target } = ordered[0]
    const def = WIDGET_DEFINITIONS[widget.type]
    const bounds = widthBounds(widget, cols)
    const fullStrip = target.role === 'strip' || (def.region === 'top' && def.orientation === 'horizontal')
    const focalWidth = def.visualRole === 'focal' ? Math.min(bounds.max, Math.max(bounds.preferred, Math.round(cols * 0.66))) : bounds.preferred
    return [withResponsiveConstraints(widget, {
      i: widget.id,
      x: 0,
      y: baseY,
      w: fullStrip ? cols : focalWidth,
      h: naturalHeight(widget, target, contentStates[widget.id]),
    }, cols, contentStates[widget.id])]
  }

  const widths = allocateRowWidths(ordered.map(item => item.widget), cols)
  if (!widths) {
    return packOverflow(ordered.map(item => item.widget), cols, baseY, contentStates)
  }

  let x = 0
  return ordered.map(({ widget, target }, index) => {
    const layout = withResponsiveConstraints(widget, {
      i: widget.id,
      x,
      y: baseY,
      w: widths[index],
      h: naturalHeight(widget, target, contentStates[widget.id]),
    }, cols, contentStates[widget.id])
    x += widths[index]
    return layout
  })
}

function packOverflow(
  widgets: WidgetConfig[],
  cols: number,
  baseY: number,
  contentStates: Record<string, WidgetContentState> = {},
): Layout[] {
  const layouts: Layout[] = []
  let cursor = 0
  let y = baseY

  while (cursor < widgets.length) {
    const firstWidget = widgets[cursor]
    const firstDefinition = WIDGET_DEFINITIONS[firstWidget.type]
    const fullStrip = firstDefinition.region === 'top' && firstDefinition.orientation === 'horizontal'
    const remaining = widgets.length - cursor
    const targetRows = Math.ceil(remaining / 3)
    let count = fullStrip ? 1 : Math.ceil(remaining / targetRows)
    let rowWidgets = widgets.slice(cursor, cursor + count)
    let widths = fullStrip ? [cols] : allocateRowWidths(rowWidgets, cols)
    while (!widths && count > 1) {
      count--
      rowWidgets = widgets.slice(cursor, cursor + count)
      widths = allocateRowWidths(rowWidgets, cols)
    }
    if (!widths) {
      rowWidgets = widgets.slice(cursor, cursor + 1)
      widths = [Math.min(cols, widthBounds(rowWidgets[0], cols).preferred)]
    }

    let x = 0
    const rowLayouts = rowWidgets.map((widget, index) => {
      const def = WIDGET_DEFINITIONS[widget.type]
      const contentState = contentStates[widget.id]
      const layout = withResponsiveConstraints(widget, {
        i: widget.id,
        x,
        y,
        w: widths[index],
        h: contentState === 'empty' || contentState === 'error'
          ? 3
          : Math.max(def.minimum.h, Math.min(def.preferred.h, def.maximum.h)),
      }, cols, contentState)
      x += widths[index]
      return layout
    })
    layouts.push(...rowLayouts)
    y = Math.max(...rowLayouts.map(layout => layout.y + layout.h))
    cursor += rowWidgets.length
  }
  return layouts
}

function composeNarrowLayouts(
  widgets: WidgetConfig[],
  template: DashboardTemplate,
  cols: number,
  contentStates: Record<string, WidgetContentState>,
): Layout[] {
  let y = 0
  return widgetOrder(widgets, template).map(widget => {
    const def = WIDGET_DEFINITIONS[widget.type]
    const isStrip = def.region === 'top' && def.orientation === 'horizontal'
    const heightScale = cols <= 2 ? 0.7 : cols <= 4 ? 0.75 : 0.85
    const natural = isStrip
      ? def.preferred.h
      : Math.max(2, Math.ceil(Math.min(def.maximum.h, Math.max(def.minimum.h, def.preferred.h)) * heightScale))
    const state = contentStates[widget.id]
    const h = state === 'empty' || state === 'error' ? Math.min(3, natural) : natural
    const layout = withResponsiveConstraints(widget, { i: widget.id, x: 0, y, w: cols, h }, cols, state)
    y += layout.h
    return layout
  })
}

export function composeTemplateLayouts(
  widgets: WidgetConfig[],
  templateId: DashboardTemplateId,
  cols = 12,
  contentStates: Record<string, WidgetContentState> = {},
): Layout[] {
  const template = DASHBOARD_TEMPLATES[templateId]
  const ordered = widgetOrder(widgets, template)
  if (cols <= 6) return composeNarrowLayouts(ordered, template, cols, contentStates)
  const slots = cols === 10 ? template.mediumSlots : template.slots
  const { assigned, overflow } = assignSlots(ordered, slots, template)
  const sections = deriveSections(slots)
  const placed: Layout[] = []
  let baseY = 0

  for (const section of sections) {
    const slotIds = new Set(section.slots.map(item => item.id))
    const sectionAssignments = assigned.filter(item => slotIds.has(item.target.id))
    if (!sectionAssignments.length) continue
    const simpleRow = section.slots.every(item => item.y === section.start && item.y + item.h === section.end)
    const compact = simpleRow || sectionAssignments.length < section.slots.length
    const layouts = compact
      ? materializeCompactSection(sectionAssignments, cols, baseY, contentStates)
      : sectionAssignments.map(({ widget, target }) => withResponsiveConstraints(widget, {
        i: widget.id,
        x: target.x,
        y: baseY + target.y - section.start,
        w: target.w,
        h: target.h,
      }, cols, contentStates[widget.id]))
    placed.push(...layouts)
    baseY = Math.max(...layouts.map(layout => layout.y + layout.h))
  }

  const candidate = [...placed, ...packOverflow(overflow, cols, baseY, contentStates)]
  if (overflow.some(widget => {
    const state = contentStates[widget.id]
    return WIDGET_DEFINITIONS[widget.type].visualRole === 'focal' && state !== 'empty' && state !== 'error'
  })) {
    return packOverflow(ordered, cols, 0, contentStates)
  }
  if (templateLayoutQuality(ordered, candidate, cols) >= 25) return candidate
  return packOverflow(ordered, cols, 0, contentStates)
}

export function templateOccupiedRatio(layouts: Layout[], cols = 12): number {
  if (!layouts.length) return 1
  const height = Math.max(...layouts.map(layout => layout.y + layout.h))
  const occupied = layouts.reduce((sum, layout) => sum + layout.w * layout.h, 0)
  return occupied / (cols * height)
}

export function templateLayoutQuality(widgets: WidgetConfig[], layouts: Layout[], cols = 12): number {
  if (!layouts.length) return 100
  const byId = new Map(widgets.map(widget => [widget.id, widget]))
  const stretchPenalty = layouts.reduce((sum, layout) => {
    const widget = byId.get(layout.i)
    if (!widget) return sum
    const def = WIDGET_DEFINITIONS[widget.type]
    const preferredArea = Math.max(1, scaledWidth(def.preferred.w, cols) * def.preferred.h)
    const ratio = layout.w * layout.h / preferredArea
    const allowance = def.visualRole === 'focal' || def.density === 'dense' ? 1.6 : 1.3
    return sum + Math.max(0, ratio - allowance) * 12
  }, 0)
  const leadingVoidPenalty = [...new Set(layouts.map(layout => layout.y))].reduce((sum, y) => {
    const minX = Math.min(...layouts.filter(layout => layout.y === y).map(layout => layout.x))
    return sum + minX * 2
  }, 0)
  return templateOccupiedRatio(layouts, cols) * 100 - stretchPenalty - leadingVoidPenalty
}
