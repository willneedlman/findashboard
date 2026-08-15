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
export type EvidenceDomain = 'portfolio' | 'issuer' | 'macro' | 'benchmark'
export type ChartUnit =
  | 'number'
  | 'percent'
  | 'percentage-point'
  | 'basis-point'
  | 'currency'
  | 'multiple'
  | 'index'
  | 'beta'
  | 'correlation'
  | 'shares'

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
// chartType data conventions:
// - 'bar' / 'line' / 'area' / 'histogram' / 'dot': data[i][xKey] is the category
//   (histogram: a pre-binned bucket label), data[i][series[k].key] is that
//   series' value for the category. 'histogram' and 'dot' reuse this shape —
//   histogram renders adjacent bars, dot renders markers instead of bars/lines.
// - 'pie': data[i][xKey] is the slice name, data[i][series[0].key] is its value.
//   Only series[0] is used.
// - 'scatter': data[i][xKey] is a NUMERIC x value (not a category), and
//   data[i][series[0].key] is the numeric y value. Only series[0] is used.
//   Each row may include an optional `label` field for the point's tooltip name.
// - 'range': data[i][series[k].key] is a two-element [low, high] array (not two
//   separately-named keys) — the floating bar span for that series in the
//   category at data[i][xKey]. A real high/low spread (DCF sensitivity,
//   analyst target range), not a statistical quartile box plot. Multiple
//   subjects compared on the same category share ONE row, one array per series.
// - 'box': box & whisker. data[i][xKey] is the metric name; data[i] carries the
//   numeric five-number summary min/q1/median/q3/max, plus an optional
//   markers:[{label,value}] array (the subjects' own values, drawn as points).
export interface ChartPayload {
  kind: 'chart'
  title?: string
  chartType: 'line' | 'bar' | 'area' | 'pie' | 'histogram' | 'dot' | 'range' | 'scatter' | 'box'
  /** Semantic direction of bar marks. Horizontal bars are preferred for
   * rankings and categorical labels that need room to read. */
  barOrientation?: 'vertical' | 'horizontal'
  xKey: string
  xUnit?: ChartUnit
  data: Array<Record<string, string | number | null | [number, number] | Array<{ label: string; value: number }>>>
  series: Array<{ key: string; label: string; color?: string; unit?: ChartUnit }>
  /** Supporting values shown in the tooltip without adding more plotted marks. */
  details?: Array<{ key: string; label: string; unit?: ChartUnit }>
}
export interface TextPayload {
  kind: 'text'
  title?: string
  body: string
}
export type ClipPayload = TablePayload | KpiPayload | ChartPayload | TextPayload

/** When the evidence behind a clip was last actually observed.
 *
 * A clip is a snapshot of a panel, and a panel can be showing a figure nobody
 * has refreshed in weeks. Carrying this lets the writer put the number in the
 * past tense instead of stating it as the present. */
export interface ClipFreshness {
  lastObs?: string | null
  staleDays?: number | null
  stale?: boolean
  source?: string
  coverageNote?: string
}

export interface ReportClip {
  id: string
  sourceTab: string
  capturedAt: string        // ISO timestamp
  dataType: ClipDataType
  payload: ClipPayload
  userDescription?: string
  projectId: string
  origin?: 'manual' | 'alphatape'
  researchSourceId?: string
  researchKey?: string
  sourceRoute?: string
  evidenceDomain?: EvidenceDomain
  freshness?: ClipFreshness
}

/** @deprecated Use lookbackPreset — kept for stored-project migration. */
export type TimeframePreset = 'last7' | 'last30' | 'last90' | 'qtd' | 'ytd' | 'custom'

export type LookbackPreset = 'none' | 'last7' | 'last30' | 'last90' | 'qtd' | 'ytd' | 'custom'
export type LookforwardPreset =
  | 'none'
  | 'next7'
  | 'next30'
  | 'next90'
  | 'next180'
  | 'next365'
  | 'next3y'
  | 'next5y'
  | 'next10y'
  | 'unlimited'
  | 'custom'
export type ReportLength = 'short' | 'medium' | 'long' | 'custom'
/** Prose carried per section. Independent of how many sections there are, so a
 *  six-section tight brief and a three-section deep note are both askable. */
export type ReportDepth = 'tight' | 'standard' | 'deep'
export type EvidenceMode = 'manual' | 'alphatape'
/** What the note is, which decides its argument shape and what counts as a verdict. */
export type ReportType =
  | 'equity-note'
  | 'comparison'
  | 'macro-brief'
  | 'portfolio-review'
  | 'screen-summary'
  | 'thesis'
/** How the page is composed: which of prose, visuals or figures leads. */
export type LayoutPreset = 'editorial' | 'visual-first' | 'data-dense' | 'narrative'

export interface ReportScope {
  /** What kind of note this is. Set in step 1 of the setup flow. */
  reportType: ReportType
  /** Page composition preference. Steers the AI's per-section layout choice. */
  layoutPreset: LayoutPreset
  /** True once the setup steps have been answered. Until then the project opens
   * in the stepper and generation is held back, so no report is ever built from
   * an unanswered scope. Legacy projects are treated as already set up. */
  setupComplete: boolean
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
  /** How much depth the generated report should have. Defaults to 'medium'. */
  length: ReportLength
  /** Custom size only: exactly how many sections the note has. Clamped server
   *  side to what the chosen template's argument actually has to say. */
  customSections?: number
  /** Custom size only: how much prose each section carries. */
  customDepth?: ReportDepth
  /** Free-text requirements (one per line) the report must satisfy — a stat, a
   * verdict, a chart — even if the model wouldn't otherwise curate them in. */
  mustInclude: string
  evidenceMode: EvidenceMode
  researchSymbols: string
  /** Plain-English stock selection brief. Applied results are written into
   * researchSymbols so the downstream research planner stays deterministic. */
  screenerQuery: string
  /** Exact trimmed query that produced researchSymbols. A mismatch blocks
   * automated research until the edited screen is applied again. */
  screenerAppliedQuery: string
  includePortfolio: boolean
}

export interface KeyFigure { label: string; value: string }
export interface KeyResult { label: string; value: string; context?: string }
export interface ReportStance {
  lean: 'bullish' | 'bearish' | 'neutral' | string
  conviction: 'low' | 'moderate' | 'high' | string
  baseCase?: string
  thesis?: string
}
export type ReportSectionLayout =
  | 'full-width'
  | 'visual-left'
  | 'visual-right'
  | 'wrap-left'
  | 'wrap-right'
  | 'metric-rail'
  | 'metric-rail-left'
  | 'evidence-band'
  | 'analysis-first'
export interface GeneratedSection {
  templateSection?: string
  clipId: string
  heading: string
  analysis: string
  /** AI-only composition direction. The renderer may repair incompatible
   * choices after it sees the actual visual assigned to this section. */
  layout?: ReportSectionLayout
  /** Deterministic page composition chosen after generation. Paired half-width
   * sections are emitted only in complete pairs, so no blank grid cell remains. */
  placement?: 'half'
  keyFigures?: KeyFigure[]       // AI-extracted evidence actually used, not the raw dataset
  chart?: ChartPayload           // AI-synthesized chart built from this section's own figures — not sourced from a clip
}
export interface GeneratedReport {
  headline?: string              // research-note title for the masthead
  stance?: ReportStance          // directional lean + conviction (not a vol envelope)
  keyResult?: KeyResult          // the explicit answer to the goal, shown prominently
  executiveSummary: string
  sections: GeneratedSection[]   // curated, in argument order
  conclusion: string
  generatedAt: string            // ISO; compare with project.updatedAt for staleness
  model?: string
  pipeline?: {
    phase: string
    // Sections the writer planned but could not write, named so the report can
    // admit it came back short instead of looking complete.
    incompleteSections?: string[]
    templateId: string
    layoutPreset: string
    requiredSourceIds: string[]
    coverage?: {
      requestedTargets: number
      coveredTargets: number
      targetCoveragePct: number
      domainCoveragePct: Record<EvidenceDomain, number>
    }
    unresolvedGaps?: string[]
  }
}

// An immutable, self-contained copy of one generation, kept so past reports are
// never lost when a new one is generated. Carries everything ReportPrint needs
// to render it exactly as it was, independent of later clip/scope edits.
export interface ReportSnapshot {
  id: string
  generatedAt: string
  name: string
  scope: ReportScope
  clips: ReportClip[]
  generated: GeneratedReport
}

export interface ReportProject {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  scope: ReportScope
  clips: ReportClip[]      // display order
  generated?: GeneratedReport
  history?: ReportSnapshot[]  // every generation, newest first (generated === history[0].generated)
}

// Each snapshot clones its clips so a past report renders as it was, which is
// heavy; cap the archive so a project's history can't exhaust the localStorage
// quota (write() fails silently on overflow, which would drop a fresh report).
const HISTORY_CAP = 15
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

interface StoreState {
  version: 1
  projects: ReportProject[]
}

// What a page hands off before the user picks a project or adds a note.
export interface ClipDraft {
  sourceTab: string
  dataType: ClipDataType
  payload: ClipPayload
  origin?: 'manual' | 'alphatape'
  researchSourceId?: string
  researchKey?: string
  sourceRoute?: string
  evidenceDomain?: EvidenceDomain
  freshness?: ClipFreshness
}

const uid = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now() + Math.random())

const nowISO = () => new Date().toISOString()

export const defaultScope = (): ReportScope => ({
  reportType: 'equity-note',
  layoutPreset: 'editorial',
  setupComplete: false,
  lookbackPreset: 'last30',
  lookforwardPreset: 'next90',
  purpose: '',
  goal: '',
  length: 'medium',
  mustInclude: '',
  evidenceMode: 'manual',
  researchSymbols: '',
  screenerQuery: '',
  screenerAppliedQuery: '',
  includePortfolio: true,
})

const LOOKBACK_OK = new Set<LookbackPreset>(['none', 'last7', 'last30', 'last90', 'qtd', 'ytd', 'custom'])
const LOOKFORWARD_OK = new Set<LookforwardPreset>([
  'none', 'next7', 'next30', 'next90', 'next180', 'next365', 'next3y', 'next5y', 'next10y', 'unlimited', 'custom',
])
const LENGTH_OK = new Set<ReportLength>(['short', 'medium', 'long', 'custom'])
const DEPTH_OK = new Set<ReportDepth>(['tight', 'standard', 'deep'])
/** Section-count bounds shared with the backend contract builder. */
export const REPORT_SECTION_MIN = 2
export const REPORT_SECTION_MAX_BY_TYPE: Record<ReportType, number> = {
  'equity-note': 6, comparison: 6, 'macro-brief': 6,
  'portfolio-review': 7, 'screen-summary': 5, thesis: 6,
}
const TYPE_OK = new Set<ReportType>([
  'equity-note', 'comparison', 'macro-brief', 'portfolio-review', 'screen-summary', 'thesis',
])
const LAYOUT_OK = new Set<LayoutPreset>(['editorial', 'visual-first', 'data-dense', 'narrative'])

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

  // A project stored before the setup flow existed has already been configured by
  // hand, so never send it back through the stepper.
  const legacyProject = raw.setupComplete === undefined && (!!goal || !!purpose || !!raw.researchSymbols)

  return {
    reportType: TYPE_OK.has(raw.reportType as ReportType) ? (raw.reportType as ReportType) : base.reportType,
    layoutPreset: LAYOUT_OK.has(raw.layoutPreset as LayoutPreset) ? (raw.layoutPreset as LayoutPreset) : base.layoutPreset,
    setupComplete: raw.setupComplete === true || legacyProject,
    lookbackPreset: lookback,
    lookforwardPreset: lookforward,
    customStart: raw.customStart || undefined,
    customEnd: raw.customEnd || undefined,
    forwardCustomStart: raw.forwardCustomStart || undefined,
    forwardCustomEnd: raw.forwardCustomEnd || undefined,
    purpose,
    goal,
    length: LENGTH_OK.has(raw.length as ReportLength) ? (raw.length as ReportLength) : base.length,
    customSections: Number.isFinite(Number(raw.customSections)) && Number(raw.customSections) > 0
      ? Math.round(Number(raw.customSections)) : undefined,
    customDepth: DEPTH_OK.has(raw.customDepth as ReportDepth) ? (raw.customDepth as ReportDepth) : undefined,
    mustInclude: typeof raw.mustInclude === 'string' ? raw.mustInclude : '',
    evidenceMode: raw.evidenceMode === 'alphatape' ? 'alphatape' : 'manual',
    researchSymbols: typeof raw.researchSymbols === 'string' ? raw.researchSymbols : '',
    screenerQuery: typeof raw.screenerQuery === 'string' ? raw.screenerQuery : '',
    screenerAppliedQuery: typeof raw.screenerAppliedQuery === 'string' ? raw.screenerAppliedQuery : '',
    includePortfolio: raw.includePortfolio !== false,
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
    const projects: ReportProject[] = d.projects.map((p: any): ReportProject => {
      const generated = p.generated && typeof p.generated === 'object' ? p.generated : undefined
      let history: ReportSnapshot[] | undefined = Array.isArray(p.history)
        ? p.history.filter((h: any) => h && h.generated && h.id)
        : undefined
      const clips = Array.isArray(p.clips) ? p.clips.filter((c: any) => c && c.payload && c.payload.kind) : []
      const scope = normalizeScope(p.scope)
      // Migrate a pre-history project: seed its existing report into the archive
      // so nothing already generated is dropped from the new history view.
      if (generated && (!history || history.length === 0)) {
        history = [{
          id: uid(),
          generatedAt: generated.generatedAt || nowISO(),
          name: p.name || 'Untitled report',
          scope, clips: clone(clips), generated: clone(generated),
        }]
      }
      return {
        id: p.id || uid(),
        name: p.name || 'Untitled report',
        createdAt: p.createdAt || nowISO(),
        updatedAt: p.updatedAt || p.createdAt || nowISO(),
        scope, clips, generated, history,
      }
    })
    return { version: 1, projects }
  } catch {
    return { version: 1, projects: [] }
  }
}

/**
 * Persist, and say whether it actually persisted.
 *
 * Returning false matters more than it looks. Every read goes back to
 * localStorage, so a write that quietly fails does not leave the app holding
 * newer state in memory — it leaves it showing the OLD state with no error. A
 * research run that collected ninety clips then looks to the user exactly like
 * a run that collected none, and the only visible symptom is that the button
 * never advances and re-running never helps.
 */
function write(state: StoreState): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
    emit()
    return true
  } catch {
    // Quota exceeded — history snapshots (with their cloned clips) are the bulk.
    // Drop the oldest snapshot from whichever project has the most, and retry a
    // few times, so a fresh report is never silently lost to old history.
    for (let i = 0; i < 8; i++) {
      let target: ReportProject | undefined
      for (const p of state.projects) {
        if ((p.history?.length ?? 0) > 1 && (!target || p.history!.length > target.history!.length)) target = p
      }
      if (!target?.history) break
      target.history = target.history.slice(0, -1)
      try { localStorage.setItem(KEY, JSON.stringify(state)); emit(); return true } catch { /* keep trimming */ }
    }
  }
  // Nothing left to trim and it still will not fit. Resync the UI to what is
  // actually stored rather than leaving it describing state that was lost.
  emit()
  return false
}

function mutate(fn: (state: StoreState) => void): boolean {
  const state = read()
  fn(state)
  return write(state)
}

/** How close the store is to its quota, for a message that can name the cause. */
export function reportStorageUsage(): { chars: number; projects: number; snapshots: number } {
  const state = read()
  let snapshots = 0
  for (const p of state.projects) snapshots += p.history?.length ?? 0
  let chars = 0
  try { chars = (localStorage.getItem(KEY) ?? '').length } catch { /* unavailable */ }
  return { chars, projects: state.projects.length, snapshots }
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

export function evidenceDomainForCapture(sourceTab: string, title = ''): EvidenceDomain {
  const source = `${sourceTab} ${title}`.toLowerCase()
  if (/portfolio manager|portfolio analysis|portfolio compare|factor decomposition|correlation/.test(source)) return 'portfolio'
  if (/asset overlay|regression|sector rotation|benchmark|relative performance/.test(source)) return 'benchmark'
  if (/global market|macro|fed|rate engine|credit spread|yield curve|sentiment/.test(source)) return 'macro'
  return 'issuer'
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
    origin: draft.origin ?? 'manual',
    researchSourceId: draft.researchSourceId,
    researchKey: draft.researchKey,
    sourceRoute: draft.sourceRoute,
    evidenceDomain: draft.evidenceDomain ?? evidenceDomainForCapture(draft.sourceTab, draft.payload.title),
  }
  let ok = false
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (p) { p.clips.push(clip); p.updatedAt = nowISO(); ok = true }
  })
  return ok ? clip : null
}

export function mergeAlphaTapeClips(
  existing: ReportClip[],
  projectId: string,
  drafts: ClipDraft[],
  capturedAt = nowISO(),
  preserve: { sourceIds?: string[]; researchKeys?: string[] } = {},
): ReportClip[] {
  const preserveSources = new Set(preserve.sourceIds ?? [])
  const preserveKeys = new Set(preserve.researchKeys ?? [])
  const prior = new Map(
    existing
      .filter(clip => clip.origin === 'alphatape' && clip.researchKey)
      .map(clip => [clip.researchKey!, clip]),
  )
  const fresh = drafts.map((draft): ReportClip => {
    const old = draft.researchKey ? prior.get(draft.researchKey) : undefined
    return {
      id: old?.id ?? uid(),
      sourceTab: draft.sourceTab,
      capturedAt,
      dataType: draft.dataType,
      payload: draft.payload,
      userDescription: old?.userDescription,
      projectId,
      origin: 'alphatape',
      researchSourceId: draft.researchSourceId,
      researchKey: draft.researchKey,
      sourceRoute: draft.sourceRoute,
      evidenceDomain: draft.evidenceDomain ?? evidenceDomainForCapture(draft.sourceTab, draft.payload.title),
    }
  })
  const freshByKey = new Map(
    fresh
      .filter(clip => clip.researchKey)
      .map(clip => [clip.researchKey!, clip]),
  )
  const consumed = new Set<string>()
  const merged = existing.flatMap(clip => {
    if (clip.origin !== 'alphatape') return [clip]
    if (clip.researchKey && freshByKey.has(clip.researchKey)) {
      consumed.add(clip.researchKey)
      return [freshByKey.get(clip.researchKey)!]
    }
    const researchKey = clip.researchKey
    const preservesResearchKey = !!researchKey && [...preserveKeys].some(
      key => researchKey === key || researchKey.startsWith(`${key}:`),
    )
    if (
      preservesResearchKey
      || (!!clip.researchSourceId && preserveSources.has(clip.researchSourceId))
    ) return [clip]
    return []
  })
  return [
    ...merged,
    ...fresh.filter(clip => !clip.researchKey || !consumed.has(clip.researchKey)),
  ]
}

export function replaceAlphaTapeClips(
  projectId: string,
  drafts: ClipDraft[],
  preserve: { sourceIds?: string[]; researchKeys?: string[] } = {},
): { added: number; persisted: boolean } {
  let added = 0
  const persisted = mutate(state => {
    const project = state.projects.find(candidate => candidate.id === projectId)
    if (!project) return
    project.clips = mergeAlphaTapeClips(project.clips, projectId, drafts, nowISO(), preserve)
    project.updatedAt = nowISO()
    added = drafts.length
  })
  return { added, persisted }
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

// Keep the newest history snapshot in lockstep with edits to `generated`, so a
// preview/download of the latest report always reflects the workspace edits.
// Older snapshots stay frozen as generated.
function syncLatestSnapshot(p: ReportProject) {
  const latest = p.history?.[0]
  if (latest && p.generated && latest.generatedAt === p.generated.generatedAt) {
    latest.generated = clone(p.generated)
    latest.name = p.name
  }
}

export function setGenerated(projectId: string, gen: Omit<GeneratedReport, 'generatedAt'> & { generatedAt?: string }) {
  // Stores the AI report as an OUTPUT — deliberately does not bump updatedAt, so
  // updatedAt > generatedAt reliably signals the inputs changed since generation.
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (!p) return
    const generated: GeneratedReport = { ...gen, generatedAt: gen.generatedAt || nowISO() }
    p.generated = generated
    const snapshot: ReportSnapshot = {
      id: uid(),
      generatedAt: generated.generatedAt,
      name: p.name,
      scope: clone(p.scope),
      clips: clone(p.clips),
      generated: clone(generated),
    }
    p.history = [snapshot, ...(p.history ?? [])].slice(0, HISTORY_CAP)
  })
}

export function updateGenerated(projectId: string, patch: Partial<Pick<GeneratedReport, 'headline' | 'executiveSummary' | 'conclusion'>>) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (p?.generated) { p.generated = { ...p.generated, ...patch }; syncLatestSnapshot(p) }
  })
}

export function updateKeyResult(projectId: string, patch: Partial<KeyResult>) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (p?.generated) {
      const base = p.generated.keyResult ?? { label: '', value: '', context: '' }
      p.generated = { ...p.generated, keyResult: { ...base, ...patch } }
      syncLatestSnapshot(p)
    }
  })
}

export function updateGeneratedSection(projectId: string, clipId: string, patch: Partial<Pick<GeneratedSection, 'heading' | 'analysis'>>) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    const sec = p?.generated?.sections.find(x => x.clipId === clipId)
    if (sec && p) { Object.assign(sec, patch); syncLatestSnapshot(p) }
  })
}

export function clearGenerated(projectId: string) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (p) p.generated = undefined
  })
}

// Remove one archived generation. If it was the latest (the one mirrored into
// the workspace editor), the editor's `generated` follows to the new newest.
export function deleteSnapshot(projectId: string, snapshotId: string) {
  mutate(s => {
    const p = s.projects.find(p => p.id === projectId)
    if (!p?.history) return
    const wasLatest = p.history[0]?.id === snapshotId
    p.history = p.history.filter(h => h.id !== snapshotId)
    if (wasLatest) p.generated = p.history[0] ? clone(p.history[0].generated) : undefined
  })
}

export function getSnapshot(projectId: string, snapshotId: string): ReportSnapshot | undefined {
  return getProject(projectId)?.history?.find(h => h.id === snapshotId)
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
    const portfolioWide = clip.evidenceDomain === 'portfolio'
      || /\b(current allocation|current option positions|correlation matrix|scenario losses)\b/i.test(p.title || '')
    const maxRows = portfolioWide ? p.rows.length : 15
    const body = p.rows.slice(0, maxRows).map(r => r.map(v => (v == null ? '' : String(v))).join(' | ')).join('\n')
    const more = p.rows.length > maxRows ? `\n(+${p.rows.length - maxRows} more rows)` : ''
    return cap(`Columns: ${head}\n${body}${more}`, portfolioWide ? 6000 : 1400)
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
    // Emit the raw series so the server can rebuild real overlays (e.g. a
    // dual-line revenue trajectory across a synchronized timeline) rather than
    // only see summary stats. Bounded to a short, parseable line.
    let points = ''
    if (p.data.length >= 2 && p.data.length <= 16 && p.series.length <= 3) {
      const xList = xs.join(',')
      const seriesLines = p.series.map(s =>
        `${s.label}=[${p.data.map(d => { const v = Number(d[s.key]); return Number.isFinite(v) ? v : '' }).join(',')}]`)
      points = `\nPOINTS: ${p.xKey}=[${xList}]; ${seriesLines.join('; ')}`
    }
    return cap(`${p.chartType} chart${span}. ${parts.join('. ')}${points}`, 1600)
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
    case 'next365': return 'Next 1 year'
    case 'next3y':  return 'Next 3 years'
    case 'next5y':  return 'Next 5 years'
    case 'next10y': return 'Next 10 years'
    case 'unlimited': return 'Open-ended outlook'
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

export function toTitleCase(s: string | undefined | null): string {
  if (!s) return ''
  const str = s.trim()
  if (!str) return ''
  const ACRONYMS = new Set(['DCF', 'WACC', 'PE', 'P/E', 'PEG', 'ROE', 'ROA', 'FCF', 'IV', 'GEX', 'EV/EBITDA', 'EBITDA', 'CAGR', 'GAAP', 'EPS', 'P/S', 'P/B', 'M&A', 'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA'])
  const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'en', 'for', 'if', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'vs.', 'via', 'with', 'per'])

  const parts = str.split(/(\s+)/)
  const wordIndices: number[] = []
  parts.forEach((p, idx) => {
    if (p.trim() && !/\s+/.test(p)) wordIndices.push(idx)
  })

  return parts.map((part, idx) => {
    if (!part.trim() || /\s+/.test(part)) return part
    const isFirst = idx === wordIndices[0]
    const isLast = idx === wordIndices[wordIndices.length - 1]

    const prefix = part.match(/^[^a-zA-Z0-9]+/)?.[0] || ''
    const suffix = part.match(/[^a-zA-Z0-9]+$/)?.[0] || ''
    const core = part.slice(prefix.length, part.length - suffix.length || undefined)
    if (!core) return part

    const upper = core.toUpperCase()
    if (ACRONYMS.has(upper) || /^[A-Z]{2,5}$/.test(core)) {
      return `${prefix}${upper}${suffix}`
    }

    const lower = core.toLowerCase()
    if (!isFirst && !isLast && SMALL_WORDS.has(lower)) {
      return `${prefix}${lower}${suffix}`
    }

    if (core.includes('-') && !core.startsWith('-')) {
      const casedCore = core.split('-').map(p => {
        const pUpper = p.toUpperCase()
        if (ACRONYMS.has(pUpper) || (p === p.toUpperCase() && p.length <= 5)) return pUpper
        return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : ''
      }).join('-')
      return `${prefix}${casedCore}${suffix}`
    }

    return `${prefix}${core.charAt(0).toUpperCase()}${core.slice(1).toLowerCase()}${suffix}`
  }).join('')
}
