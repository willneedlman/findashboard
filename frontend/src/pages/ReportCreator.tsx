import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import {
  Plus, Trash2, ChevronUp, ChevronDown, ChevronRight, Eye, EyeOff, FileText,
  FileDown, Sparkles, RefreshCw, Loader2, AlertTriangle, Check, Clock, Download,
  Circle, Database, ExternalLink, XCircle, ListFilter,
} from 'lucide-react'
import { T } from '../lib/theme'
import PageWrapper from '../components/PageWrapper'
import PageHeader from '../components/PageHeader'
import TickerLogo from '../components/TickerLogo'
import useIsMobile from '../hooks/useIsMobile'
import useActivePortfolio from '../hooks/useActivePortfolio'
import ReportWizardForm from '../components/report/ReportWizardForm'
import ReportSetupWizard from '../components/report/ReportSetupWizard'
import ClipRenderer from '../components/report/ClipRenderer'
import { assignReportBodyVisuals, reportSectionAssignmentKey } from '../components/report/SectionLayout'
import {
  useReportCreator, createProject, renameProject, deleteProject, updateScope,
  removeClip, updateClipDescription, moveClip, timeframeLabel, clipTitle, formatCaptured,
  setGenerated, updateGenerated, updateGeneratedSection, updateKeyResult, isGenerationStale, summarizeClipForAI,
  deleteSnapshot, replaceAlphaTapeClips,
  getProject,
  type ReportProject, type ReportClip, type ReportSnapshot,
} from '../lib/reportCreator'
import {
  buildReportDataBank, collectReportResearch, enhanceReportResearchPlan, planReportResearch, researchSourceProducesVisuals, screenReportSymbols,
  type ReportDataBank,
  type ReportResearchPlan, type ReportResearchProgress, type ReportResearchResult,
  type ReportResearchSourceId, type ReportScreenerSelection,
} from '../lib/reportResearch'
import type { ActivePortfolioContext } from '../lib/pmImport'
import { selectReportAppendixData } from '../lib/reportPresentation'
import { reportTickerSymbols } from '../lib/tickerLogos'
import { ReportRevise, BlockRevise } from '../components/report/ReviseControls'

const DTYPE_COLOR: Record<string, string> = { table: '#60a5fa', chart: '#c9a84c', kpi: '#34d399', text: '#c084fc' }

// Short stable hash of a field's current value, mixed into the uncontrolled
// input keys so an AI revision written to the store remounts the field with its
// new text (defaultValue only reads on mount).
const vh = (s: string): string => {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

const SPIN_CSS = `@keyframes rc-spin { to { transform: rotate(360deg) } } .rc-spin { animation: rc-spin 0.8s linear infinite }`

const primaryAction: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 7, background: T.gold, border: `1px solid ${T.gold}`,
  color: 'var(--theme-bg)', fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', padding: '8px 14px', cursor: 'pointer',
}
const subLabel: React.CSSProperties = {
  fontFamily: T.label, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em',
  textTransform: 'uppercase', color: T.muted, marginBottom: 7,
}
const genField: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.label,
  fontSize: 11.5, lineHeight: 1.6, padding: '9px 11px', width: '100%', outline: 'none', boxSizing: 'border-box', resize: 'vertical',
}

function generationStage(progress: number): string {
  if (progress < 28) return 'Structuring the thesis'
  if (progress < 56) return 'Writing the analysis'
  if (progress < 78) return 'Matching evidence and visuals'
  if (progress < 100) return 'Checking figures and layout'
  return 'Report ready'
}

function GenerationProgress({ progress }: { progress: number }) {
  const value = Math.max(0, Math.min(100, Math.round(progress)))
  return (
    <div
      role="progressbar"
      aria-label="Generating report"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={generationStage(value)}
      style={{
        border: `1px solid ${T.border}`,
        background: T.surface,
        padding: '8px 10px 9px',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        marginBottom: 6,
      }}>
        <span style={{
          fontFamily: T.label,
          fontSize: 8.5,
          fontWeight: 700,
          letterSpacing: '0.09em',
          textTransform: 'uppercase',
          color: T.gold,
        }}>
          {generationStage(value)}
        </span>
        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>{value}%</span>
      </div>
      <div style={{ height: 4, overflow: 'hidden', background: T.borderFaint }}>
        <div style={{
          width: `${value}%`,
          height: '100%',
          background: T.gold,
          transition: 'width 260ms ease-out',
        }} />
      </div>
    </div>
  )
}

function GeneratedEditor({ project }: { project: ReportProject }) {
  const gen = project.generated!
  const clipById = useMemo(() => new Map(project.clips.map(c => [c.id, c])), [project.clips])
  const appendixClips = useMemo(
    () => selectReportAppendixData(gen.appendixClipIds, project.clips),
    [gen.appendixClipIds, project.clips],
  )
  const reportTickers = useMemo(
    () => {
      const multiSubject = /\b(compare|comparison|versus|vs\.?|screen|ranking|rank|portfolio|holdings|book)\b/i
        .test(`${project.scope.goal} ${project.scope.purpose}`)
      return reportTickerSymbols(
        project.scope.researchSymbols,
        project.clips.map(clip => clip.researchKey),
        multiSubject ? 4 : 1,
      )
    },
    [project.clips, project.scope.goal, project.scope.purpose, project.scope.researchSymbols],
  )
  const bodyVisuals = useMemo(
    () => assignReportBodyVisuals(gen.sections, clipById, project.clips, {
      projectId: project.id,
      generatedAt: gen.generatedAt,
      objective: `${project.scope.goal} ${project.scope.purpose}`,
      domainCoveragePct: gen.pipeline?.coverage?.domainCoveragePct,
    }),
    [clipById, gen.generatedAt, gen.sections, project.clips, project.id, project.scope.goal, project.scope.purpose],
  )
  const kr = gen.keyResult
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <ReportRevise project={project} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={subLabel}>AI title</div>
        <input key={`hl-${gen.generatedAt}-${vh(gen.headline ?? '')}`} defaultValue={gen.headline ?? ''} onBlur={e => updateGenerated(project.id, { headline: e.target.value })}
          placeholder="AI-generated report title" style={{ ...genField, fontFamily: T.mono, fontSize: 14, fontWeight: 700, resize: 'none' }} />
        <BlockRevise project={project} field="headline" />
      </div>
      {reportTickers.length > 0 && (
        <div aria-label="Report companies" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 9 }}>
          {reportTickers.map(ticker => (
            <span key={ticker} title={ticker}>
              <TickerLogo
                ticker={ticker}
                size={28}
                fit="cover"
                cornerRadius="50%"
                showFallbackText={false}
              />
            </span>
          ))}
        </div>
      )}
      {gen.stance && (
        <div style={{ border: `1px solid ${T.border}`, background: T.bg, padding: 12 }}>
          <div style={subLabel}>Stance</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontFamily: T.mono, fontSize: 11, color: T.text }}>
            <span><span style={{ color: T.muted }}>Lean </span>{gen.stance.lean}</span>
            <span><span style={{ color: T.muted }}>Conviction </span>{gen.stance.conviction}</span>
            {gen.stance.baseCase && <span><span style={{ color: T.muted }}>Base </span>{gen.stance.baseCase}</span>}
          </div>
          {gen.stance.thesis && (
            <div style={{ marginTop: 8, fontFamily: T.label, fontSize: 12, color: T.text, lineHeight: 1.5 }}>{gen.stance.thesis}</div>
          )}
        </div>
      )}
      {kr && (
        <div style={{ border: `1px solid ${T.gold}`, background: T.goldTint(7), padding: 12 }}>
          <div style={subLabel}>Bottom line · answers the goal</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input key={`kl-${gen.generatedAt}`} defaultValue={kr.label} onBlur={e => updateKeyResult(project.id, { label: e.target.value })}
              placeholder="Result label" style={{ flex: '2 1 180px', minWidth: 0, background: T.bg, border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '6px 9px', outline: 'none', boxSizing: 'border-box' }} />
            <input key={`kv-${gen.generatedAt}`} defaultValue={kr.value} onBlur={e => updateKeyResult(project.id, { value: e.target.value })}
              placeholder="Result value" style={{ flex: '1 1 140px', minWidth: 0, background: T.bg, border: `1px solid ${T.gold}`, color: T.gold, fontFamily: T.mono, fontSize: 15, fontWeight: 700, padding: '5px 9px', outline: 'none', boxSizing: 'border-box' }} />
          </div>
          <input key={`kc-${gen.generatedAt}`} defaultValue={kr.context ?? ''} onBlur={e => updateKeyResult(project.id, { context: e.target.value })}
            placeholder="Supporting context (optional)" style={{ ...genField, marginTop: 8, fontFamily: T.mono, fontSize: 10.5, resize: 'none' }} />
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={subLabel}>Executive summary</div>
        <textarea key={`es-${gen.generatedAt}-${vh(gen.executiveSummary)}`} defaultValue={gen.executiveSummary} rows={4}
          onBlur={e => updateGenerated(project.id, { executiveSummary: e.target.value })} style={genField} />
        <BlockRevise project={project} field="executiveSummary" />
      </div>
      {gen.sections.map((s, i) => {
        const clip = clipById.get(s.clipId)
        const sectionKey = reportSectionAssignmentKey(gen.sections, i)
        const visual = bodyVisuals.get(sectionKey)?.visual
        return (
          <div key={sectionKey} style={{ border: `1px solid ${T.border}`, background: T.bg, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: T.mono, fontSize: 11, color: T.gold }}>{String(i + 1).padStart(2, '0')}</span>
              <input key={`h-${gen.generatedAt}-${s.clipId}-${vh(s.heading)}`} defaultValue={s.heading}
                onBlur={e => updateGeneratedSection(project.id, s.clipId, { heading: e.target.value })}
                style={{ flex: 1, background: 'transparent', border: 'none', borderBottom: `1px solid ${T.border}`, color: T.text, fontFamily: T.label, fontSize: 12.5, fontWeight: 700, padding: '3px 0', outline: 'none' }} />
              <span style={{ fontFamily: T.mono, fontSize: 8, color: clip ? T.muted : T.neg }}>{clip ? clip.sourceTab : 'clip removed'}</span>
            </div>
            <textarea key={`a-${gen.generatedAt}-${s.clipId}-${vh(s.analysis)}`} defaultValue={s.analysis} rows={4}
              onBlur={e => updateGeneratedSection(project.id, s.clipId, { analysis: e.target.value })} style={genField} />
            {s.keyFigures && s.keyFigures.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {s.keyFigures.map((f, j) => (
                  <span key={j} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5, border: `1px solid ${T.border}`, padding: '3px 8px' }}>
                    <span style={{ fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.muted }}>{f.label}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.text }}>{f.value}</span>
                  </span>
                ))}
              </div>
            )}
            {visual && visual.payload.kind !== 'text' && (
              <div style={{ border: `1px solid ${T.border}`, background: T.surface }}>
                <div style={{ borderBottom: `1px solid ${T.border}`, padding: '5px 8px', fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.09em', textTransform: 'uppercase', color: T.gold }}>
                  Visual evidence · {visual.sourceTab}
                </div>
                <div style={{ padding: 8 }}>
                  <ClipRenderer payload={visual.payload} mode="dark" />
                </div>
              </div>
            )}
            <BlockRevise project={project} field="section.analysis" clipId={s.clipId} />
          </div>
        )
      })}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={subLabel}>Conclusion and recommendations</div>
        <textarea key={`cc-${gen.generatedAt}-${vh(gen.conclusion)}`} defaultValue={gen.conclusion} rows={4}
          onBlur={e => updateGenerated(project.id, { conclusion: e.target.value })} style={genField} />
        <BlockRevise project={project} field="conclusion" />
      </div>
      {appendixClips.length > 0 && (
        <div>
          <div style={subLabel}>Appendix · supporting data (not central to the thesis)</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {appendixClips.map(clip => (
              <span key={clip.id} style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, border: `1px solid ${T.border}`, padding: '3px 7px' }}>
                {clipTitle(clip)}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Section({ label, meta, children, collapsible, defaultOpen = true, collapseSignal = 0 }: { label: string; meta?: React.ReactNode; children: React.ReactNode; collapsible?: boolean; defaultOpen?: boolean; collapseSignal?: number }) {
  const [open, setOpen] = useState(defaultOpen)
  useEffect(() => {
    if (collapsible && collapseSignal > 0) setOpen(false)
  }, [collapseSignal, collapsible])
  const showBody = !collapsible || open
  return (
    <section style={{ border: `1px solid ${T.border}`, background: T.surface }}>
      <div onClick={collapsible ? () => setOpen(o => !o) : undefined}
        style={{ minHeight: 34, padding: '0 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: showBody ? `1px solid ${T.border}` : 'none', cursor: collapsible ? 'pointer' : 'default', userSelect: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.text }}>
          {collapsible && (open ? <ChevronDown size={12} color={T.muted} /> : <ChevronRight size={12} color={T.muted} />)}
          {label}
        </span>
        {meta != null && <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>{meta}</span>}
      </div>
      {showBody && <div style={{ padding: 14 }}>{children}</div>}
    </section>
  )
}

function ClipCard({ project, clip, index, count }: { project: ReportProject; clip: ReportClip; index: number; count: number }) {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const color = DTYPE_COLOR[clip.dataType] ?? T.muted
  const researched = clip.origin === 'alphatape'
  return (
    <div style={{ border: `1px solid ${T.border}`, background: T.bg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderBottom: open ? `1px solid ${T.borderFaint}` : 'none' }}>
        <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, width: 18, textAlign: 'right' }}>{index + 1}</span>
        <span style={{ fontFamily: T.label, fontSize: 7.5, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color, border: `1px solid ${color}`, padding: '2px 5px', flexShrink: 0 }}>{clip.dataType}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: T.label, fontSize: 11.5, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{clipTitle(clip)}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>
            <span style={{ color: researched ? T.gold : T.muted }}>{researched ? 'AlphaTape research' : 'Manual clip'}</span>
            <span>·</span>
            <span>{clip.sourceTab}</span>
            <span>·</span>
            <span>{formatCaptured(clip.capturedAt)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          {clip.sourceRoute && (
            <IconBtn title={`Open ${clip.sourceTab}`} onClick={() => navigate(clip.sourceRoute!)}><ExternalLink size={12} /></IconBtn>
          )}
          <IconBtn title="Move up" disabled={index === 0} onClick={() => moveClip(project.id, clip.id, -1)}><ChevronUp size={13} /></IconBtn>
          <IconBtn title="Move down" disabled={index === count - 1} onClick={() => moveClip(project.id, clip.id, 1)}><ChevronDown size={13} /></IconBtn>
          <IconBtn title={open ? 'Hide preview' : 'Show preview'} onClick={() => setOpen(o => !o)}>{open ? <EyeOff size={13} /> : <Eye size={13} />}</IconBtn>
          <IconBtn title="Remove clip" danger onClick={() => removeClip(project.id, clip.id)}><Trash2 size={13} /></IconBtn>
        </div>
      </div>
      {open && (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ClipRenderer payload={clip.payload} mode="dark" />
          <textarea key={clip.id} defaultValue={clip.userDescription ?? ''} rows={2}
            placeholder="Add analytical commentary shown beside this data in the report..."
            onBlur={e => updateClipDescription(project.id, clip.id, e.target.value)}
            style={{ background: T.surface, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.label, fontSize: 11, lineHeight: 1.5, padding: '7px 9px', width: '100%', outline: 'none', boxSizing: 'border-box', resize: 'vertical' }} />
        </div>
      )}
    </div>
  )
}

type ResearchSourceState = ReportResearchProgress['status'] | 'queued'

const screenOperatorLabel: Record<string, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'between',
}

const screenPercentFields = new Set([
  'priceChange', 'change52wHiPct', 'revenueGrowth', 'epsGrowth', 'grossMargin',
  'operatingMargin', 'netMargin', 'roe', 'roa', 'roic', 'dividendYield',
  'payoutRatio', 'smaDist50', 'smaDist200', 'vol30',
])
const screenMultipleFields = new Set(['peRatio', 'pbRatio', 'psRatio', 'evEbitda', 'pegRatio'])

function screenFieldLabel(value: string): string {
  const label = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, first => first.toUpperCase())
  return label
    .replace(/\bPe\b/, 'P/E')
    .replace(/\bPb\b/, 'P/B')
    .replace(/\bPs\b/, 'P/S')
    .replace(/\bRoe\b/, 'ROE')
    .replace(/\bRoa\b/, 'ROA')
    .replace(/\bRoic\b/, 'ROIC')
    .replace(/\bRsi14\b/, 'RSI 14')
    .replace(/\bEv Ebitda\b/, 'EV/EBITDA')
    .replace(/\bSma\b/g, 'SMA')
}

function screenValue(field: string, value: number): string {
  if (field === 'marketCap') return `$${value}B`
  if (field === 'price') return `$${value}`
  if (field === 'volume' || field === 'avgVolume') return `${value.toLocaleString()} shares`
  if (field === 'cashConversionCycle') return `${value} days`
  if (screenPercentFields.has(field)) return `${value}%`
  if (screenMultipleFields.has(field)) return `${value}×`
  return String(value)
}

function screenCriteria(selection: ReportScreenerSelection): string[] {
  const scope = [
    selection.sector,
    selection.universe?.toUpperCase(),
    selection.exchange,
    selection.region,
  ].filter((value): value is string => !!value)
  const filters = selection.filters.map(filter => {
    const first = `${screenFieldLabel(filter.field)} ${screenOperatorLabel[filter.operator] ?? filter.operator} ${screenValue(filter.field, filter.value)}`
    const range = filter.operator === 'between' && filter.value2 != null ? `${first} and ${screenValue(filter.field, filter.value2)}` : first
    return filter.param ? `${range} (${filter.param})` : range
  })
  return [...scope, ...filters, `Sort ${screenFieldLabel(selection.sortBy)} ${selection.sortDir === 'asc' ? 'low to high' : 'high to low'}`]
}

function ResearchPanel({
  project,
  portfolio,
  plan,
  researching,
  statuses,
  result,
  error,
  planning,
  planningError,
  onEnhance,
  onRun,
  isMobile,
}: {
  project: ReportProject
  portfolio: ActivePortfolioContext
  plan: ReportResearchPlan
  researching: boolean
  statuses: Partial<Record<ReportResearchSourceId, ResearchSourceState>>
  result: ReportResearchResult | null
  error: string | null
  planning: boolean
  planningError: string | null
  onEnhance: () => void
  onRun: (baselineOnly?: boolean) => void
  isMobile: boolean
}) {
  const navigate = useNavigate()
  const [screening, setScreening] = useState(false)
  const [screenSelection, setScreenSelection] = useState<ReportScreenerSelection | null>(null)
  const [screenError, setScreenError] = useState<string | null>(null)
  const screenOperationRef = useRef(0)
  const automaticCount = project.clips.filter(clip => clip.origin === 'alphatape').length
  const failedSourceCount = new Set(result?.failed.map(failure => failure.sourceId) ?? []).size
  const dataBank = useMemo(
    () => result ? buildReportDataBank(plan, result, project.clips) : null,
    [plan, project.clips, result],
  )
  const mode = project.scope.evidenceMode
  const screenQuery = project.scope.screenerQuery.trim()
  const screenNeedsApply = !!screenQuery && screenQuery !== project.scope.screenerAppliedQuery.trim()
  const researchActionsLocked = planning || researching || !!plan.blockedReason || screenNeedsApply
  const modeButton = (active: boolean): React.CSSProperties => ({
    flex: '1 1 180px',
    display: 'flex', alignItems: 'flex-start', gap: 9, textAlign: 'left',
    background: active ? T.goldTint(9) : T.bg,
    border: `1px solid ${active ? T.gold : T.border}`,
    color: active ? T.text : T.muted,
    padding: '10px 11px', cursor: 'pointer',
  })

  useEffect(() => {
    screenOperationRef.current += 1
    setScreening(false)
    setScreenSelection(null)
    setScreenError(null)
  }, [project.id])

  const applyScreen = async () => {
    const query = project.scope.screenerQuery.trim()
    if (!query || screening || researching || planning) return
    const operation = ++screenOperationRef.current
    setScreening(true)
    setScreenSelection(null)
    setScreenError(null)
    try {
      const selection = await screenReportSymbols(query)
      if (screenOperationRef.current !== operation) return
      if (!selection.symbols.length) {
        setScreenError('The screen returned no matches. Broaden the criteria and try again.')
        return
      }
      updateScope(project.id, {
        researchSymbols: selection.symbols.join(', '),
        screenerAppliedQuery: query,
      })
      setScreenSelection(selection)
    } catch (cause) {
      if (screenOperationRef.current !== operation) return
      const detail = (cause as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      const message = cause instanceof Error ? cause.message : ''
      setScreenError(detail || message || 'The AI could not translate or run this screen. Adjust the wording and retry.')
    } finally {
      if (screenOperationRef.current === operation) setScreening(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
      <div role="group" aria-label="Evidence sourcing method" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button type="button" aria-pressed={mode === 'manual'} onClick={() => updateScope(project.id, { evidenceMode: 'manual' })} style={modeButton(mode === 'manual')}>
          <FileText size={14} color={mode === 'manual' ? T.gold : T.muted} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            <span style={{ display: 'block', fontFamily: T.label, fontSize: 10.5, fontWeight: 700 }}>Clip tools manually</span>
            <span style={{ display: 'block', fontFamily: T.mono, fontSize: 8.5, lineHeight: 1.45, marginTop: 3 }}>Choose exact tables, charts, and metrics from any tool.</span>
          </span>
        </button>
        <button type="button" aria-pressed={mode === 'alphatape'} onClick={() => updateScope(project.id, { evidenceMode: 'alphatape' })} style={modeButton(mode === 'alphatape')}>
          <Database size={14} color={mode === 'alphatape' ? T.gold : T.muted} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            <span style={{ display: 'block', fontFamily: T.label, fontSize: 10.5, fontWeight: 700 }}>Research with AlphaTape</span>
            <span style={{ display: 'block', fontFamily: T.mono, fontSize: 8.5, lineHeight: 1.45, marginTop: 3 }}>Build a baseline, then let AI add useful tools and visuals.</span>
          </span>
        </button>
      </div>

      {mode === 'manual' ? (
        <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 11, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontFamily: T.label, fontSize: 10.5, color: T.muted, lineHeight: 1.5, maxWidth: 650 }}>
            Use Send to Report inside a tool. AlphaTape research clips already in this project stay available until you remove them.
          </div>
          <span style={{ fontFamily: T.mono, fontSize: 9, color: automaticCount ? T.gold : T.muted }}>
            {automaticCount} AlphaTape clip{automaticCount === 1 ? '' : 's'} retained
          </span>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'minmax(220px, 1.2fr) minmax(220px, 0.8fr)', gap: 8 }}>
            <label style={{ display: 'block', minWidth: 0 }}>
              <span style={subLabel}>Research symbols</span>
              <input
                value={project.scope.researchSymbols}
                onChange={event => {
                  setScreenSelection(null)
                  updateScope(project.id, {
                    researchSymbols: event.target.value,
                    screenerQuery: '',
                    screenerAppliedQuery: '',
                  })
                }}
                placeholder="AAPL, MSFT"
                aria-label="Research symbols"
                style={{
                  width: '100%', boxSizing: 'border-box', background: T.bg, border: `1px solid ${T.border}`,
                  color: T.text, fontFamily: T.mono, fontSize: 10.5, padding: '8px 9px', outline: 'none',
                }}
              />
              <span style={{ display: 'block', fontFamily: T.mono, fontSize: 8.5, color: T.muted, marginTop: 5 }}>
                Optional when the objective names uppercase tickers or the active book supplies them.
              </span>
            </label>
            <div>
              <span style={subLabel}>Portfolio context</span>
              <button
                type="button"
                aria-pressed={project.scope.includePortfolio}
                onClick={() => updateScope(project.id, { includePortfolio: !project.scope.includePortfolio })}
                style={{
                  width: '100%', minHeight: 34, display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                  background: project.scope.includePortfolio ? T.goldTint(8) : T.bg,
                  border: `1px solid ${project.scope.includePortfolio ? T.gold : T.border}`,
                  color: project.scope.includePortfolio ? T.text : T.muted,
                  padding: '7px 9px', cursor: 'pointer',
                }}
              >
                <span style={{
                  width: 13, height: 13, flexShrink: 0, display: 'grid', placeItems: 'center',
                  border: `1px solid ${project.scope.includePortfolio ? T.gold : T.muted}`,
                  color: T.gold,
                }}>
                  {project.scope.includePortfolio && <Check size={10} />}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontFamily: T.label, fontSize: 9.5, fontWeight: 700 }}>Use active portfolio</span>
                  <span style={{ display: 'block', fontFamily: T.mono, fontSize: 8.5, color: T.muted, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {portfolio.hasData ? `${portfolio.name} · ${portfolio.positionCount} positions` : 'No active portfolio'}
                  </span>
                </span>
              </button>
            </div>
          </div>

          <div style={{ border: `1px solid ${screenSelection ? T.gold : T.border}`, background: T.bg }}>
            <div style={{
              minHeight: 34, padding: '0 10px', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', gap: 10, borderBottom: `1px solid ${T.border}`,
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: T.label, fontSize: 9, fontWeight: 700, color: T.text }}>
                <ListFilter size={12} color={T.gold} /> Describe the screen
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted }}>AI → Stock Screener → research symbols</span>
            </div>
            <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', alignItems: 'stretch', gap: 7 }}>
                <textarea
                  value={project.scope.screenerQuery}
                  onChange={event => {
                    const nextQuery = event.target.value
                    setScreenSelection(null)
                    setScreenError(null)
                    updateScope(project.id, {
                      screenerQuery: nextQuery,
                      screenerAppliedQuery: nextQuery.trim() ? project.scope.screenerAppliedQuery : '',
                    })
                  }}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void applyScreen()
                    }
                  }}
                  rows={2}
                  disabled={screening || researching || planning}
                  aria-label="Plain-English stock screen"
                  aria-describedby="report-screener-help"
                  placeholder="Example: profitable US software companies with revenue growth above 15%, P/E below 30, and beta under 1.2. Show the eight largest."
                  style={{
                    flex: 1, minWidth: 0, boxSizing: 'border-box', resize: 'vertical',
                    background: T.surface, border: `1px solid ${T.border}`, color: T.text,
                    fontFamily: T.label, fontSize: 10.5, lineHeight: 1.5, padding: '8px 9px',
                    outline: 'none', opacity: screening || researching || planning ? 0.7 : 1,
                  }}
                />
                <button
                  type="button"
                  onClick={() => void applyScreen()}
                  disabled={!project.scope.screenerQuery.trim() || screening || researching || planning}
                  style={{
                    ...primaryAction,
                    minWidth: isMobile ? undefined : 126,
                    justifyContent: 'center',
                    background: project.scope.screenerQuery.trim() && !screening && !researching && !planning ? T.goldTint(12) : 'transparent',
                    borderColor: project.scope.screenerQuery.trim() && !screening && !researching && !planning ? T.gold : T.border,
                    color: project.scope.screenerQuery.trim() && !screening && !researching && !planning ? T.gold : T.muted,
                    cursor: project.scope.screenerQuery.trim() && !screening && !researching && !planning ? 'pointer' : 'default',
                  }}
                >
                  {screening ? <Loader2 size={13} className="rc-spin" /> : <ListFilter size={13} />}
                  {screening ? 'Screening…' : 'Apply screen'}
                </button>
              </div>
              <span id="report-screener-help" style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted, lineHeight: 1.45 }}>
                Describe fundamentals, valuation, growth, sector, geography, technicals, ranking, and count. AlphaTape applies supported filters and selects up to eight names.
              </span>
              {screenNeedsApply && !screening && !screenError && (
                <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: T.warn, fontFamily: T.label, fontSize: 9.5, lineHeight: 1.4 }}>
                  <AlertTriangle size={12} style={{ flexShrink: 0 }} />
                  Apply this screen before running research, or clear the brief to keep the symbols above.
                </span>
              )}
              {!screenSelection && !screenNeedsApply && screenQuery && (
                <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: T.pos, fontFamily: T.label, fontSize: 9.5, lineHeight: 1.4 }}>
                  <Check size={12} style={{ flexShrink: 0 }} />
                  This screen produced the current research symbols. Apply again to refresh the matches.
                </span>
              )}
              {screenError && (
                <span role="alert" style={{ display: 'inline-flex', alignItems: 'center', gap: 7, color: T.neg, fontFamily: T.label, fontSize: 9.5, lineHeight: 1.4 }}>
                  <AlertTriangle size={12} style={{ flexShrink: 0 }} /> {screenError}
                </span>
              )}
              {screenSelection && (
                <div aria-live="polite" style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 2 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: T.label, fontSize: 9.5, color: T.text, lineHeight: 1.4 }}>
                    <Check size={12} color={T.pos} style={{ flexShrink: 0 }} />
                    <span>
                      Selected {screenSelection.symbols.length} symbols from {screenSelection.total} screen matches: <span style={{ color: T.gold, fontFamily: T.mono }}>{screenSelection.symbols.join(', ')}</span>
                    </span>
                  </div>
                  <span style={{ fontFamily: T.label, fontSize: 9, color: T.muted, lineHeight: 1.45 }}>{screenSelection.explanation}</span>
                  <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                    {screenCriteria(screenSelection).map(item => (
                      <span key={item} style={{
                        border: `1px solid ${T.border}`, background: T.surface, color: T.muted,
                        fontFamily: T.mono, fontSize: 7.5, padding: '3px 5px',
                      }}>{item}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div style={{ border: `1px solid ${T.border}`, background: T.bg }}>
            <div style={{ minHeight: 31, padding: '0 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontFamily: T.label, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.text }}>
                {plan.aiEnhanced ? 'AI-expanded sources' : 'Baseline sources'}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>
                {plan.sources.length} tool{plan.sources.length === 1 ? '' : 's'} · {plan.symbols.length ? plan.symbols.join(', ') : 'market scope'}
              </span>
            </div>
            {plan.blockedReason ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '11px 12px', color: T.warn, fontFamily: T.label, fontSize: 10.5, lineHeight: 1.45 }}>
                <AlertTriangle size={13} style={{ flexShrink: 0 }} />
                <span>{plan.blockedReason}</span>
              </div>
            ) : (
              <div>
                {plan.sources.map((source, index) => {
                  const status = statuses[source.id] ?? 'queued'
                  const statusColor = status === 'complete' ? T.pos
                    : status === 'partial' ? T.warn
                      : status === 'failed' ? T.neg
                        : status === 'running' ? T.gold
                          : T.muted
                  const failedSources = result?.failed.filter(failure => failure.sourceId === source.id) ?? []
                  return (
                    <div key={source.id} style={{
                      display: 'grid',
                      gridTemplateColumns: isMobile ? '18px minmax(0, 1fr) auto' : '18px minmax(132px, 0.55fr) minmax(180px, 1fr) auto',
                      alignItems: 'center', gap: 9, minHeight: 43, padding: '6px 10px',
                      borderBottom: index < plan.sources.length - 1 ? `1px solid ${T.borderFaint}` : 'none',
                    }}>
                      <span style={{ display: 'inline-flex', color: statusColor }}>
                        {status === 'running' ? <Loader2 size={12} className="rc-spin" />
                          : status === 'complete' ? <Check size={12} />
                            : status === 'partial' ? <AlertTriangle size={12} />
                            : status === 'failed' ? <XCircle size={12} />
                              : <Circle size={10} />}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap', fontFamily: T.label, fontSize: 10, fontWeight: 700, color: T.text }}>
                          {source.label}
                          {source.selectionOrigin === 'ai' && <span style={{ color: T.gold, fontFamily: T.mono, fontSize: 7.5, fontWeight: 700 }}>AI added</span>}
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontFamily: T.mono, fontSize: 8, color: T.muted, marginTop: 2 }}>
                          {source.tool}
                          {researchSourceProducesVisuals(source.id) && <span style={{ color: T.blue }}>· visual output</span>}
                        </span>
                      </span>
                      <span style={{
                        gridColumn: isMobile ? '2 / -1' : undefined,
                        gridRow: isMobile ? 2 : undefined,
                        fontFamily: T.label, fontSize: 9.5,
                        color: failedSources.length ? (status === 'partial' ? T.warn : T.neg) : T.muted, lineHeight: 1.4,
                      }}>
                        {failedSources.length
                          ? `${failedSources.map(failure => failure.message).join(' ')} Retry the research run.`
                          : source.reason}
                      </span>
                      <button
                        type="button"
                        onClick={() => navigate(source.route)}
                        title={`Open ${source.tool}`}
                        aria-label={`Open ${source.tool}`}
                        style={{
                          gridColumn: isMobile ? 3 : undefined,
                          gridRow: isMobile ? 1 : undefined,
                          background: 'transparent', border: 'none', color: T.muted,
                          padding: 4, cursor: 'pointer', display: 'inline-flex',
                        }}
                      >
                        <ExternalLink size={11} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {plan.aiEnhanced && plan.aiSummary && (
            <div style={{ borderLeft: `2px solid ${T.gold}`, padding: '7px 9px', background: T.goldTint(5), fontFamily: T.label, fontSize: 9.5, lineHeight: 1.5, color: T.muted }}>
              <span style={{ color: T.gold, fontWeight: 700 }}>AI research strategy</span> · {plan.aiSummary}
            </div>
          )}

          {planningError && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, border: `1px solid ${T.warn}`, background: T.goldTint(5), color: T.warn, fontFamily: T.label, fontSize: 10.5, padding: '8px 10px' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <AlertTriangle size={13} style={{ flexShrink: 0 }} /> {planningError}
              </span>
              <button type="button" onClick={() => onRun(true)} disabled={researchActionsLocked}
                style={{ background: 'transparent', border: `1px solid ${T.warn}`, color: T.warn, fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 8px', cursor: researchActionsLocked ? 'default' : 'pointer' }}>
                Run baseline only
              </button>
            </div>
          )}

          {error && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${T.neg}`, background: T.negTint(7), color: T.neg, fontFamily: T.label, fontSize: 10.5, padding: '8px 10px' }}>
              <AlertTriangle size={13} style={{ flexShrink: 0 }} /> {error}
            </div>
          )}

          {result && result.clips.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
                border: `1px solid ${dataBank?.phase === 'blocked' ? T.neg : result.failed.length ? T.warn : T.pos}`,
                background: dataBank?.phase === 'blocked' ? T.negTint(6) : result.failed.length ? T.goldTint(5) : T.posTint(5),
                padding: '8px 10px',
              }}>
                <span style={{ fontFamily: T.label, fontSize: 10.5, color: T.text }}>
                  DataBank {dataBank?.phase === 'ready' ? 'ready' : 'blocked'} · {dataBank?.coverage.targetCoveragePct.toFixed(1)}% target coverage.
                  {` ${result.clips.length} clip${result.clips.length === 1 ? '' : 's'} from ${result.completed.length} tool${result.completed.length === 1 ? '' : 's'}.`}
                  {failedSourceCount ? ` ${failedSourceCount} source${failedSourceCount === 1 ? '' : 's'} had missing evidence.` : ''}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>
                  {dataBank?.runs.filter(run => run.critical && run.status === 'complete').length}/{dataBank?.runs.filter(run => run.critical).length} critical sources complete
                </span>
              </div>
              {!!dataBank?.unresolvedGaps.length && (
                <div style={{ borderLeft: `2px solid ${T.warn}`, padding: '5px 9px', fontFamily: T.mono, fontSize: 9, color: T.muted, lineHeight: 1.5 }}>
                  Unresolved · {dataBank.unresolvedGaps.slice(0, 5).join(' · ')}
                  {dataBank.unresolvedGaps.length > 5 ? ` · +${dataBank.unresolvedGaps.length - 5} more` : ''}
                </div>
              )}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted, lineHeight: 1.45 }}>
              {automaticCount ? 'Refresh replaces completed AlphaTape sources. Manual clips, notes, and prior evidence from failed sources stay.' : 'Research adds ordinary clips. Nothing is generated until you review them.'}
            </span>
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={onEnhance}
                disabled={researchActionsLocked}
                style={{
                  ...primaryAction,
                  background: 'transparent',
                  borderColor: plan.aiEnhanced ? T.gold : T.border,
                  color: plan.aiEnhanced ? T.gold : T.muted,
                  cursor: researchActionsLocked ? 'default' : 'pointer',
                  opacity: researchActionsLocked ? 0.62 : 1,
                }}
              >
                {planning ? <Loader2 size={13} className="rc-spin" /> : <Sparkles size={13} />}
                {planning ? 'AI planning…' : plan.aiEnhanced ? 'Rethink with AI' : 'Improve plan with AI'}
              </button>
              <button
                type="button"
                onClick={() => onRun()}
                disabled={researchActionsLocked}
                style={{
                  ...primaryAction,
                  background: researchActionsLocked ? 'transparent' : T.gold,
                  borderColor: researchActionsLocked ? T.border : T.gold,
                  color: researchActionsLocked ? T.muted : 'var(--theme-bg)',
                  cursor: researchActionsLocked ? 'default' : 'pointer',
                  opacity: researchActionsLocked ? 0.62 : 1,
                }}
              >
                {researching || planning ? <Loader2 size={13} className="rc-spin" /> : plan.aiEnhanced ? <Database size={13} /> : <Sparkles size={13} />}
                {planning ? 'AI planning…'
                  : researching ? 'Researching…'
                    : plan.aiEnhanced
                      ? automaticCount ? 'Refresh AlphaTape research' : 'Run AlphaTape research'
                      : automaticCount ? 'Plan and refresh with AI' : 'Plan and run with AI'}
              </button>
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function IconBtn({ children, onClick, title, disabled, danger }: { children: React.ReactNode; onClick: () => void; title: string; disabled?: boolean; danger?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={title}
      style={{ background: 'transparent', border: 'none', cursor: disabled ? 'default' : 'pointer', color: disabled ? T.borderFaint : danger ? T.neg : T.muted, padding: 4, display: 'inline-flex', opacity: disabled ? 0.5 : 1 }}>
      {children}
    </button>
  )
}

function HistoryCard({ project, snap, isLatest }: { project: ReportProject; snap: ReportSnapshot; isLatest: boolean }) {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const g = snap.generated
  const lean = g.stance?.lean
  const leanColor = lean === 'bullish' ? T.pos : lean === 'bearish' ? T.neg : T.muted
  const verdict = g.keyResult?.value || g.headline || 'Report'
  const previewPath = `/report-creator/print/${project.id}?snapshot=${snap.id}`
  const btn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: T.label, fontSize: 8.5, fontWeight: 700,
    letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 9px', cursor: 'pointer',
  }
  return (
    <div style={{ border: `1px solid ${isLatest ? T.gold : T.border}`, background: isLatest ? T.goldTint(6) : T.bg, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {lean && <span style={{ fontFamily: T.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: leanColor }}>{lean}</span>}
            <span style={{ fontFamily: T.mono, fontSize: 12.5, fontWeight: 700, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{verdict}</span>
            {isLatest && <span style={{ fontFamily: T.label, fontSize: 7.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, border: `1px solid ${T.gold}`, padding: '1px 5px' }}>Latest</span>}
          </div>
          {g.headline && verdict !== g.headline && (
            <div style={{ fontFamily: T.label, fontSize: 10.5, color: T.muted, marginTop: 3, lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.headline}</div>
          )}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: T.mono, fontSize: 8.5, color: T.muted, marginTop: 5 }}>
            <Clock size={10} /> {formatCaptured(snap.generatedAt)}
            <span style={{ color: T.borderFaint }}>·</span>
            {g.sections.length} section{g.sections.length === 1 ? '' : 's'}
          </div>
        </div>
        {confirming ? (
          <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
            <button onClick={() => { deleteSnapshot(project.id, snap.id); setConfirming(false) }} style={{ ...btn, background: 'transparent', border: `1px solid ${T.neg}`, color: T.neg }}>Delete</button>
            <button onClick={() => setConfirming(false)} style={{ ...btn, background: 'transparent', border: `1px solid ${T.border}`, color: T.muted }}>No</button>
          </span>
        ) : (
          <IconBtn onClick={() => setConfirming(true)} title="Delete this report" danger><Trash2 size={12} /></IconBtn>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 9 }}>
        <button onClick={() => navigate(previewPath)} style={{ ...btn, background: 'transparent', border: `1px solid ${T.border}`, color: T.text }}>
          <Eye size={11} /> Preview
        </button>
        <button onClick={() => navigate(`${previewPath}&download=1`)} style={{ ...btn, background: T.goldTint(12), border: `1px solid ${T.gold}`, color: T.gold }}>
          <Download size={11} /> Download PDF
        </button>
      </div>
    </div>
  )
}

export default function ReportCreator() {
  const projects = useReportCreator()
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const activePortfolio = useActivePortfolio()
  const [activeId, setActiveId] = useState('')
  const [newName, setNewName] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [generationProgress, setGenerationProgress] = useState(0)
  const [genError, setGenError] = useState<string | null>(null)
  const [justDone, setJustDone] = useState(false)
  const [researching, setResearching] = useState(false)
  const [researchStatuses, setResearchStatuses] = useState<Partial<Record<ReportResearchSourceId, ResearchSourceState>>>({})
  const [researchResult, setResearchResult] = useState<ReportResearchResult | null>(null)
  const [researchError, setResearchError] = useState<string | null>(null)
  const [planningResearch, setPlanningResearch] = useState(false)
  const [planningError, setPlanningError] = useState<string | null>(null)
  const [aiResearchPlan, setAiResearchPlan] = useState<ReportResearchPlan | null>(null)
  const [selectionCollapseSignal, setSelectionCollapseSignal] = useState(0)
  const researchOperationRef = useRef(0)
  const activeProjectRef = useRef<HTMLDivElement>(null)

  const active = projects.find(p => p.id === activeId) ?? projects[0]
  const baselineResearchPlan = useMemo(
    () => active ? planReportResearch(active.scope, activePortfolio) : null,
    [active, activePortfolio],
  )
  const researchPlan = aiResearchPlan ?? baselineResearchPlan
  const researchPlanSignature = baselineResearchPlan
    ? JSON.stringify({
      projectId: active?.id,
      objective: baselineResearchPlan.objective,
      symbols: baselineResearchPlan.symbols,
      sources: baselineResearchPlan.sources.map(source => source.id),
      lookback: active?.scope.lookbackPreset,
      customStart: active?.scope.customStart,
      customEnd: active?.scope.customEnd,
      lookforward: active?.scope.lookforwardPreset,
      forwardCustomStart: active?.scope.forwardCustomStart,
      forwardCustomEnd: active?.scope.forwardCustomEnd,
      includePortfolio: active?.scope.includePortfolio,
      portfolioId: activePortfolio.id,
      portfolio: activePortfolio.holdings.map(holding => [holding.ticker, holding.shares, holding.avgCost]),
      portfolioCash: activePortfolio.cashValue,
    })
    : ''
  const researchSignatureRef = useRef(researchPlanSignature)
  researchSignatureRef.current = researchPlanSignature

  useEffect(() => {
    researchOperationRef.current += 1
    setPlanningResearch(false)
    setResearching(false)
    setAiResearchPlan(null)
    setResearchStatuses({})
    setResearchResult(null)
    setResearchError(null)
    setPlanningError(null)
  }, [researchPlanSignature])

  useEffect(() => {
    if (!generating) return
    const startedAt = Date.now()
    setGenerationProgress(6)
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startedAt
      const target = elapsed < 2500
        ? 6 + (elapsed / 2500) * 22
        : elapsed < 7500
          ? 28 + ((elapsed - 2500) / 5000) * 28
          : elapsed < 14000
            ? 56 + ((elapsed - 7500) / 6500) * 22
            : Math.min(94, 78 + ((elapsed - 14000) / 1000) * 1.4)
      setGenerationProgress(current => Math.max(current, target))
    }, 250)
    return () => window.clearInterval(timer)
  }, [generating])

  useEffect(() => {
    if (!selectionCollapseSignal) return
    const frame = window.requestAnimationFrame(() => {
      activeProjectRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [selectionCollapseSignal])

  const generate = async () => {
    if (!active || researching || planningResearch) return
    setSelectionCollapseSignal(signal => signal + 1)
    setGenerating(true); setGenError(null); setJustDone(false)
    try {
      let clipsForGeneration = active.clips
      let dataBank: ReportDataBank | undefined
      if (active.scope.evidenceMode === 'alphatape') {
        if (!baselineResearchPlan || baselineResearchPlan.blockedReason) {
          throw new Error(baselineResearchPlan?.blockedReason || 'AlphaTape research needs a valid objective and subject.')
        }
        let planToRun = researchPlan ?? baselineResearchPlan
        if (!planToRun.aiEnhanced) {
          setPlanningResearch(true)
          try {
            planToRun = await enhanceReportResearchPlan(baselineResearchPlan, active.scope, activePortfolio)
            setAiResearchPlan(planToRun)
          } finally {
            setPlanningResearch(false)
          }
        }
        const requiredIds = planToRun.requiredSourceIds?.length
          ? planToRun.requiredSourceIds
          : planToRun.sources.map(source => source.id)
        const terminalIds = new Set([
          ...(researchResult?.completed.map(item => item.sourceId) ?? []),
          ...(researchResult?.failed.map(item => item.sourceId) ?? []),
        ])
        let result = researchResult
        if (!result || requiredIds.some(sourceId => !terminalIds.has(sourceId))) {
          setResearching(true)
          setResearchResult(null)
          setResearchStatuses(Object.fromEntries(planToRun.sources.map(source => [source.id, 'queued'])))
          try {
            result = await collectReportResearch(
              planToRun,
              active.scope,
              activePortfolio,
              progress => setResearchStatuses(current => ({ ...current, [progress.sourceId]: progress.status })),
            )
          } finally {
            setResearching(false)
          }
          if (!result.clips.length) throw new Error('No AlphaTape tool returned usable evidence.')
          replaceAlphaTapeClips(active.id, result.clips, {
            sourceIds: result.failed.filter(failure => !failure.researchKey).map(failure => failure.sourceId),
            researchKeys: result.failed.flatMap(failure => failure.researchKey ? [failure.researchKey] : []),
          })
          setResearchResult(result)
        }
        if (!result) throw new Error('AlphaTape research did not reach a terminal state.')
        clipsForGeneration = getProject(active.id)?.clips ?? active.clips
        dataBank = buildReportDataBank(planToRun, result, clipsForGeneration)
        if (dataBank.phase === 'blocked') {
          const gaps = dataBank.unresolvedGaps.slice(0, 4).join(' ')
          throw new Error(`Research is incomplete. ${gaps || 'Retry the critical AlphaTape sources before generating.'}`)
        }
      }
      if (!clipsForGeneration.length) throw new Error('Add evidence before generating the report.')
      const payload = {
        projectName: active.name,
        timeframe: timeframeLabel(active.scope),
        purpose: active.scope.purpose,
        goal: active.scope.goal,
        length: active.scope.length,
        reportType: active.scope.reportType,
        layoutPreset: active.scope.layoutPreset,
        evidenceMode: active.scope.evidenceMode,
        mustInclude: active.scope.mustInclude,
        dataBank,
        clips: clipsForGeneration.map(c => ({
          id: c.id,
          sourceTab: c.sourceTab,
          dataType: c.dataType,
          title: clipTitle(c),
          userDescription: c.userDescription ?? '',
          dataSummary: summarizeClipForAI(c),
          evidenceDomain: c.evidenceDomain ?? 'issuer',
        })),
      }
      const r = await axios.post('/api/ai/report', payload)
      const activeClipById = new Map(clipsForGeneration.map(clip => [clip.id, clip]))
      const appendixClipIds = Array.isArray(r.data.appendixClipIds)
        ? [...new Set<string>(r.data.appendixClipIds)]
          .filter(id => activeClipById.get(id)?.payload.kind !== 'chart')
        : []
      setGenerated(active.id, {
        headline: r.data.headline ?? '',
        stance: r.data.stance ?? undefined,
        keyResult: r.data.keyResult ?? undefined,
        executiveSummary: r.data.executiveSummary ?? '',
        sections: Array.isArray(r.data.sections) ? r.data.sections : [],
        conclusion: r.data.conclusion ?? '',
        appendixClipIds,
        model: r.data.model,
      })
      setGenerationProgress(100)
      setJustDone(true)
      window.setTimeout(() => setJustDone(false), 6000)
    } catch (e) {
      const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail
      const detailRecord = detail && typeof detail === 'object' ? detail as { message?: unknown; errors?: unknown } : null
      const detailErrors = Array.isArray(detailRecord?.errors)
        ? detailRecord.errors.map(String).filter(Boolean)
        : []
      const serverMessage = typeof detail === 'string'
        ? detail
        : typeof detailRecord?.message === 'string'
          ? [detailRecord.message, ...detailErrors].join(': ')
          : ''
      const message = e instanceof Error ? e.message : ''
      setGenError(serverMessage || message || 'The AI writer is unavailable right now. You can still export the data as a plain report.')
    } finally {
      setGenerating(false)
    }
  }

  const create = () => {
    const name = newName.trim()
    const p = createProject(name || 'Untitled report')
    setActiveId(p.id)
    setNewName('')
  }

  const enhanceResearchPlan = async () => {
    if (!active || !baselineResearchPlan || baselineResearchPlan.blockedReason) return
    const operation = ++researchOperationRef.current
    const signature = researchPlanSignature
    setPlanningResearch(true)
    setPlanningError(null)
    try {
      const enhanced = await enhanceReportResearchPlan(baselineResearchPlan, active.scope, activePortfolio)
      if (researchOperationRef.current !== operation || researchSignatureRef.current !== signature) return
      setAiResearchPlan(enhanced)
    } catch {
      if (researchOperationRef.current !== operation || researchSignatureRef.current !== signature) return
      setPlanningError('AI planning is unavailable. The baseline sources remain ready to run.')
    } finally {
      if (researchOperationRef.current === operation && researchSignatureRef.current === signature) {
        setPlanningResearch(false)
      }
    }
  }

  const runResearch = async (baselineOnly = false) => {
    if (!active || !baselineResearchPlan || baselineResearchPlan.blockedReason) return
    const operation = ++researchOperationRef.current
    const signature = researchPlanSignature
    const projectId = active.id
    const projectScope = active.scope
    const portfolioContext = activePortfolio
    let planToRun = baselineOnly ? baselineResearchPlan : researchPlan ?? baselineResearchPlan
    setPlanningError(null)
    if (!baselineOnly && !planToRun.aiEnhanced) {
      setPlanningResearch(true)
      try {
        planToRun = await enhanceReportResearchPlan(baselineResearchPlan, projectScope, portfolioContext)
        if (researchOperationRef.current !== operation || researchSignatureRef.current !== signature) return
        setAiResearchPlan(planToRun)
      } catch {
        if (researchOperationRef.current !== operation || researchSignatureRef.current !== signature) return
        setPlanningError('AI planning is unavailable. Run the visible baseline only, or retry AI planning.')
        return
      } finally {
        if (researchOperationRef.current === operation && researchSignatureRef.current === signature) {
          setPlanningResearch(false)
        }
      }
    }
    if (researchOperationRef.current !== operation || researchSignatureRef.current !== signature) return
    setResearching(true)
    setResearchError(null)
    setResearchResult(null)
    setResearchStatuses(Object.fromEntries(planToRun.sources.map(source => [source.id, 'queued'])))
    try {
      const result = await collectReportResearch(
        planToRun,
        projectScope,
        portfolioContext,
        progress => {
          if (researchOperationRef.current === operation && researchSignatureRef.current === signature) {
            setResearchStatuses(current => ({ ...current, [progress.sourceId]: progress.status }))
          }
        },
      )
      if (researchOperationRef.current !== operation || researchSignatureRef.current !== signature) return
      if (!result.clips.length) {
        setResearchError('No source returned usable evidence. Check the symbols, then retry.')
        setResearchResult(result)
        return
      }
      replaceAlphaTapeClips(projectId, result.clips, {
        sourceIds: result.failed.filter(failure => !failure.researchKey).map(failure => failure.sourceId),
        researchKeys: result.failed.flatMap(failure => failure.researchKey ? [failure.researchKey] : []),
      })
      setResearchResult(result)
    } catch {
      if (researchOperationRef.current === operation && researchSignatureRef.current === signature) {
        setResearchError('AlphaTape research could not finish. Existing clips were not changed.')
      }
    } finally {
      if (researchOperationRef.current === operation && researchSignatureRef.current === signature) {
        setResearching(false)
      }
    }
  }

  const clips = active?.clips ?? []
  const inSetup = !!active && !active.scope.setupComplete
  const canGenerate = !!active
    && (clips.length > 0 || (active.scope.evidenceMode === 'alphatape' && !baselineResearchPlan?.blockedReason))
    && !researching && !planningResearch && !inSetup
  const scopeIncomplete = !!active && !active.scope.goal.trim() && !active.scope.purpose.trim()
  const researchedClipCount = clips.filter(clip => clip.origin === 'alphatape').length
  const manualClipCount = clips.length - researchedClipCount

  return (
    <PageWrapper>
      <style>{SPIN_CSS}</style>
      <PageHeader title="Report Creator" actions={
        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
          {projects.length} project{projects.length === 1 ? '' : 's'}
        </span>
      } />

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '250px 1fr', gap: 16, alignItems: 'start' }}>
        {/* Project rail */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New project" onKeyDown={e => { if (e.key === 'Enter') create() }}
              style={{ flex: 1, minWidth: 0, background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.label, fontSize: 11, padding: '7px 9px', outline: 'none', boxSizing: 'border-box' }} />
            <button onClick={create} title="Create project" aria-label="Create project"
              style={{ background: T.goldTint(14), border: `1px solid ${T.gold}`, color: T.gold, cursor: 'pointer', padding: '0 10px', display: 'inline-flex', alignItems: 'center' }}><Plus size={14} /></button>
          </div>

          {projects.length === 0 ? (
            <div style={{ border: `1px dashed ${T.border}`, padding: 16, fontFamily: T.mono, fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
              No projects yet. Name one above, or click Send to Report on any tool to start collecting.
            </div>
          ) : projects.map(p => {
            const on = p.id === active?.id
            const confirming = pendingDelete === p.id
            return (
              <div key={p.id} onClick={() => setActiveId(p.id)}
                style={{ border: `1px solid ${on ? T.gold : T.border}`, background: on ? T.goldTint(8) : T.surface, padding: '9px 11px', cursor: 'pointer' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <span style={{ fontFamily: T.label, fontSize: 11.5, fontWeight: on ? 700 : 500, color: on ? T.gold : T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
                  {confirming ? (
                    <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                      <button onClick={() => { deleteProject(p.id); setPendingDelete(null) }} style={{ background: 'transparent', border: `1px solid ${T.neg}`, color: T.neg, fontFamily: T.label, fontSize: 8, fontWeight: 700, padding: '2px 5px', cursor: 'pointer', textTransform: 'uppercase' }}>Delete</button>
                      <button onClick={() => setPendingDelete(null)} style={{ background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label, fontSize: 8, fontWeight: 700, padding: '2px 5px', cursor: 'pointer', textTransform: 'uppercase' }}>No</button>
                    </span>
                  ) : (
                    <button onClick={e => { e.stopPropagation(); setPendingDelete(p.id) }} title="Delete project" aria-label="Delete project"
                      style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', padding: 2, display: 'inline-flex', flexShrink: 0 }}><Trash2 size={12} /></button>
                  )}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted, marginTop: 3 }}>{p.clips.length} clip{p.clips.length === 1 ? '' : 's'} · {timeframeLabel(p.scope)}</div>
              </div>
            )
          })}
        </div>

        {/* Active project */}
        {!active ? (
          <div style={{ border: `1px solid ${T.border}`, background: T.surface, padding: 40, textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <FileText size={26} color={T.muted} />
            <div style={{ fontFamily: T.label, fontSize: 13, fontWeight: 700, color: T.text, letterSpacing: '0.04em' }}>Build a research report</div>
            <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, lineHeight: 1.6, maxWidth: 440 }}>
              Create a project, define the question, then let AlphaTape gather evidence or clip exact tool outputs yourself. Review the clips before generating a print-ready PDF.
            </div>
          </div>
        ) : (
          <div ref={activeProjectRef} style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <input key={active.id} defaultValue={active.name}
                onBlur={e => renameProject(active.id, e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                aria-label="Report name"
                style={{ flex: 1, minWidth: 200, background: 'transparent', border: 'none', borderBottom: `1px solid transparent`, color: T.gold, fontFamily: T.mono, fontSize: 15, fontWeight: 700, letterSpacing: '0.06em', padding: '2px 0', outline: 'none' }}
                onFocus={e => { e.target.style.borderBottomColor = T.border }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {inSetup && (
                  <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, border: `1px solid ${T.border}`, padding: '6px 9px' }}>
                    Setting up
                  </span>
                )}
                {!inSetup && justDone && !generating && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: T.pos, border: `1px solid ${T.pos}`, background: T.posTint(8), padding: '6px 9px' }}>
                    <Check size={12} /> Report ready
                  </span>
                )}
                {!inSetup && active.generated && (
                  <button onClick={generate} disabled={generating || !canGenerate} title="Regenerate from the current clips and scope"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 12px', cursor: (generating || !canGenerate) ? 'default' : 'pointer', opacity: (generating || !canGenerate) ? 0.6 : 1 }}>
                    {!generating && <RefreshCw size={12} />} {generating ? 'Regenerating…' : 'Regenerate'}
                  </button>
                )}
                {inSetup ? null : active.generated ? (
                  <button onClick={() => navigate(`/report-creator/print/${active.id}`)} style={primaryAction}>
                    <FileDown size={13} /> Export PDF
                  </button>
                ) : (
                  <button onClick={generate} disabled={generating || !canGenerate}
                    style={{ ...primaryAction, background: canGenerate ? T.gold : 'transparent', border: `1px solid ${canGenerate ? T.gold : T.border}`, color: canGenerate ? 'var(--theme-bg)' : T.muted, cursor: (generating || !canGenerate) ? 'default' : 'pointer', opacity: (generating || !canGenerate) ? 0.6 : 1 }}>
                    {generating ? 'Generating report…' : <><Sparkles size={13} /> Generate AI report</>}
                  </button>
                )}
              </div>
            </div>

            {generating && <GenerationProgress progress={generationProgress} />}

            {genError && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${T.neg}`, background: T.negTint(8), color: T.neg, fontFamily: T.mono, fontSize: 10.5, padding: '8px 12px' }}>
                <AlertTriangle size={13} style={{ flexShrink: 0 }} /> <span style={{ flex: 1 }}>{genError}</span>
                <button onClick={() => navigate(`/report-creator/print/${active.id}`)} style={{ background: 'transparent', border: `1px solid ${T.neg}`, color: T.neg, fontFamily: T.label, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '4px 8px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Export data only</button>
              </div>
            )}

            {inSetup && (
              <ReportSetupWizard
                scope={active.scope}
                clipCount={clips.length}
                generating={generating}
                isMobile={isMobile}
                onChange={patch => updateScope(active.id, patch)}
                onFinish={() => updateScope(active.id, { setupComplete: true })}
                onGenerate={generate}
                evidence={{
                  plan: researchPlan,
                  planning: planningResearch,
                  running: researching,
                  statuses: researchStatuses,
                  error: researchError,
                  planningError,
                  onRun: () => void runResearch(),
                }}
              />
            )}

            {!inSetup && (
            <Section label="Report scope" meta={timeframeLabel(active.scope)} collapsible defaultOpen={!active.generated} collapseSignal={selectionCollapseSignal}>
              <ReportWizardForm
                scope={active.scope}
                onChange={patch => updateScope(active.id, patch)}
                onEditSetup={() => updateScope(active.id, { setupComplete: false })}
              />
            </Section>
            )}

            {!inSetup && researchPlan && (
              <Section label="Evidence sourcing" meta={active.scope.evidenceMode === 'alphatape' ? 'AlphaTape research' : 'Manual clips'} collapsible defaultOpen={!active.generated} collapseSignal={selectionCollapseSignal}>
                <ResearchPanel
                  project={active}
                  portfolio={activePortfolio}
                  plan={researchPlan}
                  researching={researching}
                  statuses={researchStatuses}
                  result={researchResult}
                  error={researchError}
                  planning={planningResearch}
                  planningError={planningError}
                  onEnhance={enhanceResearchPlan}
                  onRun={runResearch}
                  isMobile={isMobile}
                />
              </Section>
            )}

            {!inSetup && (
            <Section
              label="Clips"
              meta={researchedClipCount ? `${researchedClipCount} researched · ${manualClipCount} manual` : `${clips.length} in order`}
              collapsible
              defaultOpen={!active.generated}
              collapseSignal={selectionCollapseSignal}
            >
              {clips.length === 0 ? (
                <div style={{ padding: '20px 8px', textAlign: 'center', fontFamily: T.mono, fontSize: 10.5, color: T.muted, lineHeight: 1.6 }}>
                  {active.scope.evidenceMode === 'alphatape'
                    ? 'No clips yet. Run AlphaTape research above to collect a first evidence set.'
                    : 'No clips yet. Open any tool and click Send to Report to add its tables, charts, or metrics here.'}
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {clips.map((c, i) => <ClipCard key={c.id} project={active} clip={c} index={i} count={clips.length} />)}
                </div>
              )}
            </Section>
            )}

            {!inSetup && !active.generated && canGenerate && scopeIncomplete && (
              <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.warn }}>
                Add an objective so the AI can anchor the report to your intent.
              </div>
            )}

            {active.generated && (
              <Section label="Generated report" meta={`AI draft · ${formatCaptured(active.generated.generatedAt)}`} collapsible defaultOpen>
                {isGenerationStale(active) && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 12, fontFamily: T.mono, fontSize: 9.5, color: T.warn }}>
                    <AlertTriangle size={12} /> Clips or scope changed since this draft. Regenerate to refresh the analysis.
                  </div>
                )}
                <p style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted, lineHeight: 1.5, margin: '0 0 14px' }}>
                  Edit any section below. Your edits are saved and used in the exported PDF.
                </p>
                <GeneratedEditor project={active} />
              </Section>
            )}

            {!!active.history?.length && (
              <Section label="Report history" meta={`${active.history.length} generated`} collapsible defaultOpen={!active.generated}>
                <p style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted, lineHeight: 1.5, margin: '0 0 12px' }}>
                  Every report you generate is kept here. Preview or download any past version.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {active.history.map((snap, i) => (
                    <HistoryCard key={snap.id} project={active} snap={snap} isLatest={i === 0} />
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}
      </div>
    </PageWrapper>
  )
}
