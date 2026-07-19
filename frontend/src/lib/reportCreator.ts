// Report Creator store: research clips snapped from any tool, grouped into
// report projects, persisted in localStorage and mirrored to the account via
// accountSync (its key is on that ALLOWLIST). One owner for the
// fdb_report_creator_v1 key; the "Send to Report Creator" button writes and the
// workspace reads through this module. A window event keeps every surface live
// and cross-tab, the same idiom as lib/tickerLink.ts.

import { useEffect, useState } from 'react'

const KEY = 'fdb_report_creator_v1'
const EVT = 'ft:report-creator'          // store changed
const CAPTURE_EVT = 'ft:report-capture'  // a page asked to clip something

export type ClipDataType = 'table' | 'chart' | 'kpi' | 'text'

export interface TablePayload {
  kind: 'table'
  title?: string
  columns: string[]
  rows: (string | number | null)[][]
}
export interface KpiPayload {
  kind: 'kpi'
  title?: string
  cells: { label: string; value: string; sub?: string }[]
}
export interface ChartPayload {
  kind: 'chart'
  title?: string
  chartType: 'line' | 'bar' | 'area'
  xKey: string
  data: Array<Record<string, string | number | null>>
  series: Array<{ key: string; label: string; color?: string }>
}
export interface TextPayload {
  kind: 'text'
  title?: string
  body: string
}
export type ClipPayload = TablePayload | KpiPayload | ChartPayload | TextPayload

export interface ReportClip {
  id: string
  sourceTab: string
  capturedAt: string        // ISO timestamp
  dataType: ClipDataType
  payload: ClipPayload
  userDescription?: string
  projectId: string
}

/** @deprecated Use lookbackPreset — kept for stored-project migration. */
export type TimeframePreset = 'last7' | 'last30' | 'last90' | 'qtd' | 'ytd' | 'custom'

export type LookbackPreset = 'none' | 'last7' | 'last30' | 'last90' | 'qtd' | 'ytd' | 'custom'
export type LookforwardPreset = 'none' | 'next7' | 'next30' | 'next90' | 'next180' | 'custom'

export interface ReportScope {
  /** Historical context window (what happened). */
  lookbackPreset: LookbackPreset
  /** Forward outlook window (what the report is projecting into). */
  lookforwardPreset: LookforwardPreset
  customStart?: string          // lookback custom start yyyy-mm-dd
  customEnd?: string            // lookback custom end yyyy-mm-dd
  forwardCustomStart?: string   // lookforward custom start yyyy-mm-dd
  forwardCustomEnd?: string     // lookforward custom end yyyy-mm-dd
  /** @deprecated Migrated into lookbackPreset on read. */
  timeframePreset?: TimeframePreset
  purpose: string
  goal: string
}

export interface KeyFigure { label: string; value: string }
export interface KeyResult { label: string; value: string; context?: string }
export interface ReportStance {
  lean: 'bullish' | 'bearish' | 'neutral' | string
  conviction: 'low' | 'moderate' | 'high' | string
  baseCase?: string
  thesis?: string
}
export interface GeneratedSection {
  clipId: string
  heading: string
  analysis: string
  keyFigures?: KeyFigure[]       // AI-extracted evidence actually used, not the raw dataset
}
export interface GeneratedReport {
  headline?: string              // research-note title for the masthead
  stance?: ReportStance          // directional lean + conviction (not a vol envelope)
  keyResult?: KeyResult          // the explicit answer to the goal, shown prominently
  executiveSummary: string
  sections: GeneratedSection[]   // curated, in argument order
  conclusion: string
  appendixClipIds: string[]      // down-ranked clips, shown as supporting data
  generatedAt: string            // ISO; compare with project.updatedAt for staleness
  model?: string
}

export interface ReportProject {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  scope: ReportScope
  clips: ReportClip[]      // display order
  generated?: GeneratedReport
}

interface StoreState {
  version: 1
  projects: ReportProject[]
}

// What a page hands off before the user picks a project or adds a note.
export interface ClipDraft {
  sourceTab: string
  dataType: ClipDataType
  payload: ClipPayload
}

const uid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now() + Math.random())

const nowISO = () => new Date().toISOString()

export const defaultScope = (): ReportScope => ({
  lookbackPreset: 'last30',
  lookforwardPreset: 'next90',
  purpose: '',
  goal: '',
})

const LOOKBACK_OK = new Set<LookbackPreset>(['none', 'last7', 'last30', 'last90', 'qtd', 'ytd', 'custom'])
const LOOKFORWARD_OK = new Set<LookforwardPreset>(['none', 'next7', 'next30', 'next90', 'next180', 'custom'])

/** Normalize stored scope: dual horizon + legacy single timeframePreset. */
export function normalizeScope(raw: Partial<ReportScope> | null | undefined): ReportScope {
  const base = defaultScope()
  if (!raw || typeof raw !== 'object') return base
  const purpose = typeof raw.purpose === 'string' ? raw.purpose : ''
  const goal = typeof raw.goal === 'string' ? raw.goal : ''

  let lookback: LookbackPreset = LOOKBACK_OK.has(raw.lookbackPreset as LookbackPreset)
    ? (raw.lookbackPreset as LookbackPreset)
    : base.lookbackPreset
  let lookforward: LookforwardPreset = LOOKFORWARD_OK.has(raw.lookforwardPreset as LookforwardPreset)
    ? (raw.lookforwardPreset as LookforwardPreset)
    : base.lookforwardPreset

  // Legacy projects only had a backward-looking timeframePreset.
  if (raw.timeframePreset && !raw.lookbackPreset) {
    const legacy = raw.timeframePreset
    if (legacy === 'last7' || legacy === 'last30' || legacy === 'last90' || legacy === 'qtd' || legacy === 'ytd' || legacy === 'custom') {
      lookback = legacy
    }
    // Keep forward empty for pure legacy so labels don't suddenly change.
    if (!raw.lookforwardPreset) lookforward = 'none'
  }

  return {
    lookbackPreset: lookback,
    lookforwardPreset: lookforward,
    customStart: raw.customStart || undefined,
    customEnd: raw.customEnd || undefined,
    forwardCustomStart: raw.forwardCustomStart || undefined,
    forwardCustomEnd: raw.forwardCustomEnd || undefined,
    purpose,
    goal,
  }
}

function emit() { window.dispatchEvent(new Event(EVT)) }

function read(): StoreState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { version: 1, projects: [] }
    const d = JSON.parse(raw)
    if (!d || !Array.isArray(d.projects)) return { version: 1, projects: [] }
    // Defensive normalize: tolerate schema drift the way readPMPortfolios does.
    const projects: ReportProject[] = d.projects.map((p: any): ReportProject => ({
      id: p.id || uid(),
      name: p.name || 'Untitled report',
      createdAt: p.createdAt || nowISO(),
      updatedAt: p.updatedAt || p.createdAt || nowISO(),
      scope: normalizeScope(p.scope),
      clips: Array.isArray(p.clips) ? p.clips.filter((c: any) => c && c.payload && c.payload.kind) : [],
      generated: p.generated && typeof p.generated === 'object' ? p.generated : undefined,
    }))
    return { version: 1, projects }
  } catch {
    return { version: 1, projects: [] }
  }
}

function write(state: StoreState) {
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch { /* quota */ }
  emit()
}

function mutate(fn: (state: StoreState) => void) {
  const state = read()
  fn(state)
  write(state)
}

export function getProjects(): ReportProject[] {
  return read().projects
}

export function getProject(id: string): ReportProject | undefined {
  return read().projects.find(p => p.id === id)
}

export function createProject(name: string): ReportProject {
  const project: ReportProject = {
    id: uid(),
    name: name.trim() || 'Untitled report',
    createdAt: nowISO(),
    updatedAt: nowISO(),
    scope: defaultScope(),
    clips: [],
  }
  mutate(s => { s.projects.unshift(project) })
  return project
}

export function renameProject(id: string, name: string) {
  mutate(s => {
    const p = s.projects.find(p => p.id === id)
    if (p) { p.name = name.trim() || p.name; p.updatedAt = nowISO() }
  })
}

export function deleteProject(id: string) {
  mutate(s => { s.projects = s.projects.filter(p => p.id !== id) })
}

export function updateScope(id: string, patch: Partial<ReportScope>) {
  mutate(s => {
    const p = s.projects.find(p => p.id === id)
    if (p) { p.scope = { ...p.scope, ...patch }; p.updatedAt = nowISO() }
  })
}

export function addClip(projectId: string, draft: ClipDraft, userDescription?: string): ReportClip | null {
  const clip: ReportClip = {
    id: uid(),
    sourceTab: draft.sourceTab,
    capturedAt: nowISO(),
    dataType: draft.dataType,
    payload: draft.payload,
    userDescription: userDescription?.trim() || undefined,
    projectId,
  }
  let ok = false
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (p) { p.clips.push(clip); p.updatedAt = nowISO(); ok = true }
  })
  return ok ? clip : null
}

export function removeClip(projectId: string, clipId: string) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (p) { p.clips = p.clips.filter(c => c.id !== clipId); p.updatedAt = nowISO() }
  })
}

export function updateClipDescription(projectId: string, clipId: string, desc: string) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    const c = p?.clips.find(c => c.id === clipId)
    if (p && c) { c.userDescription = desc.trim() || undefined; p.updatedAt = nowISO() }
  })
}

// Reorder by one step. dir -1 moves the clip earlier, +1 later.
export function moveClip(projectId: string, clipId: string, dir: -1 | 1) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (!p) return
    const i = p.clips.findIndex(c => c.id === clipId)
    const j = i + dir
    if (i < 0 || j < 0 || j >= p.clips.length) return
    ;[p.clips[i], p.clips[j]] = [p.clips[j], p.clips[i]]
    p.updatedAt = nowISO()
  })
}

// Apply an explicit clip order (drag-and-drop). Ids not present are dropped;
// missing ids keep their prior relative order at the end.
export function reorderClips(projectId: string, orderedIds: string[]) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (!p) return
    const byId = new Map(p.clips.map(c => [c.id, c]))
    const next: ReportClip[] = []
    for (const id of orderedIds) { const c = byId.get(id); if (c) { next.push(c); byId.delete(id) } }
    for (const c of byId.values()) next.push(c)
    p.clips = next
    p.updatedAt = nowISO()
  })
}

export function setGenerated(projectId: string, gen: Omit<GeneratedReport, 'generatedAt'> & { generatedAt?: string }) {
  // Stores the AI report as an OUTPUT — deliberately does not bump updatedAt, so
  // updatedAt > generatedAt reliably signals the inputs changed since generation.
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (p) p.generated = { ...gen, generatedAt: gen.generatedAt || nowISO() }
  })
}

export function updateGenerated(projectId: string, patch: Partial<Pick<GeneratedReport, 'headline' | 'executiveSummary' | 'conclusion'>>) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (p?.generated) p.generated = { ...p.generated, ...patch }
  })
}

export function updateKeyResult(projectId: string, patch: Partial<KeyResult>) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (p?.generated) {
      const base = p.generated.keyResult ?? { label: '', value: '', context: '' }
      p.generated = { ...p.generated, keyResult: { ...base, ...patch } }
    }
  })
}

export function updateGeneratedSection(projectId: string, clipId: string, patch: Partial<Pick<GeneratedSection, 'heading' | 'analysis'>>) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    const sec = p?.generated?.sections.find(x => x.clipId === clipId)
    if (sec) Object.assign(sec, patch)
  })
}

export function clearGenerated(projectId: string) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (p) p.generated = undefined
  })
}

export const isGenerationStale = (p: ReportProject): boolean =>
  !!p.generated && new Date(p.updatedAt).getTime() > new Date(p.generated.generatedAt).getTime()

// A page dispatches this to open the global capture modal with one or more
// capturable pieces. Passing the full set lets the modal show a preview selector.
export function sendToReportCreator(drafts: ClipDraft | ClipDraft[]) {
  const list = (Array.isArray(drafts) ? drafts : [drafts]).filter(d => d && d.payload && d.payload.kind)
  if (list.length) window.dispatchEvent(new CustomEvent(CAPTURE_EVT, { detail: list }))
}

// The global host subscribes to capture requests. Returns a cleanup fn.
export function onReportCapture(cb: (drafts: ClipDraft[]) => void): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as ClipDraft[] | undefined
    if (Array.isArray(detail) && detail.length) cb(detail)
  }
  window.addEventListener(CAPTURE_EVT, handler)
  return () => window.removeEventListener(CAPTURE_EVT, handler)
}

// Compact, token-frugal text form of a clip's data for the AI report call. The
// model reasons over these strings, so keep the real figures but bound the size.
export function summarizeClipForAI(clip: ReportClip): string {
  const p = clip.payload
  const cap = (s: string, n = 1100) => (s.length > n ? s.slice(0, n) + ' …[truncated]' : s)
  if (p.kind === 'kpi') {
    return cap(p.cells.map(c => `${c.label}: ${c.value}${c.sub ? ` (${c.sub})` : ''}`).join('; '))
  }
  if (p.kind === 'table') {
    const head = p.columns.join(' | ')
    const maxRows = 15
    const body = p.rows.slice(0, maxRows).map(r => r.map(v => (v == null ? '' : String(v))).join(' | ')).join('\n')
    const more = p.rows.length > maxRows ? `\n(+${p.rows.length - maxRows} more rows)` : ''
    return cap(`Columns: ${head}\n${body}${more}`, 1400)
  }
  if (p.kind === 'chart') {
    const parts = p.series.map(s => {
      const nums = p.data.map(d => Number(d[s.key])).filter(v => Number.isFinite(v))
      if (!nums.length) return `${s.label}: no numeric data`
      const first = nums[0], last = nums[nums.length - 1]
      const min = Math.min(...nums), max = Math.max(...nums)
      const chg = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0
      return `${s.label}: first ${first.toFixed(2)}, last ${last.toFixed(2)} (${chg >= 0 ? '+' : ''}${chg.toFixed(1)}% over window), min ${min.toFixed(2)}, max ${max.toFixed(2)}`
    })
    const xs = p.data.map(d => String(d[p.xKey]))
    const span = xs.length ? ` over ${xs[0]} to ${xs[xs.length - 1]} (${xs.length} points)` : ''
    return cap(`${p.chartType} chart${span}. ${parts.join('. ')}`)
  }
  return cap(p.body)
}

// Reactive project list for chrome and pages. Re-reads on store change and on
// cross-tab 'storage' events.
export function useReportCreator(): ReportProject[] {
  const [projects, setProjects] = useState<ReportProject[]>(getProjects)
  useEffect(() => {
    const read = () => setProjects(getProjects())
    window.addEventListener(EVT, read)
    window.addEventListener('storage', read)
    return () => { window.removeEventListener(EVT, read); window.removeEventListener('storage', read) }
  }, [])
  return projects
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function fmtDate(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

function lookbackLabel(scope: ReportScope): string | null {
  switch (scope.lookbackPreset) {
    case 'none':   return null
    case 'last7':  return 'Last 7 days'
    case 'last30': return 'Last 30 days'
    case 'last90': return 'Last 90 days'
    case 'qtd':    return 'Quarter to date'
    case 'ytd':    return 'Year to date'
    case 'custom': {
      const s = scope.customStart ? new Date(scope.customStart + 'T00:00:00') : null
      const e = scope.customEnd ? new Date(scope.customEnd + 'T00:00:00') : null
      if (s && e && !isNaN(s.getTime()) && !isNaN(e.getTime())) return `${fmtDate(s)} – ${fmtDate(e)}`
      if (s && !isNaN(s.getTime())) return `From ${fmtDate(s)}`
      if (e && !isNaN(e.getTime())) return `Through ${fmtDate(e)}`
      return 'Custom lookback'
    }
  }
}

function lookforwardLabel(scope: ReportScope): string | null {
  switch (scope.lookforwardPreset) {
    case 'none':    return null
    case 'next7':   return 'Next 7 days'
    case 'next30':  return 'Next 30 days'
    case 'next90':  return 'Next 90 days'
    case 'next180': return 'Next 180 days'
    case 'custom': {
      const s = scope.forwardCustomStart ? new Date(scope.forwardCustomStart + 'T00:00:00') : null
      const e = scope.forwardCustomEnd ? new Date(scope.forwardCustomEnd + 'T00:00:00') : null
      if (s && e && !isNaN(s.getTime()) && !isNaN(e.getTime())) return `${fmtDate(s)} – ${fmtDate(e)}`
      if (s && !isNaN(s.getTime())) return `From ${fmtDate(s)}`
      if (e && !isNaN(e.getTime())) return `Through ${fmtDate(e)}`
      return 'Custom lookforward'
    }
  }
}

// Human label for the dual horizon, e.g. "Last 30 days · Next 90 days".
export function timeframeLabel(scope: ReportScope): string {
  const s = normalizeScope(scope)
  const back = lookbackLabel(s)
  const fwd = lookforwardLabel(s)
  if (back && fwd) return `${back} · ${fwd}`
  if (back) return back
  if (fwd) return fwd
  return 'No horizon set'
}

export const clipTitle = (clip: ReportClip): string =>
  clip.payload.title?.trim() || clip.sourceTab

export const formatCaptured = (iso: string): string => {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${fmtDate(d)} ${hh}:${mm}`
}
