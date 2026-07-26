import { useState } from 'react'
import axios from 'axios'
import { Wand2, Loader2, Check, X, RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { T } from '../../lib/theme'
import {
  updateGenerated, updateGeneratedSection, clipTitle, summarizeClipForAI, timeframeLabel,
  type ReportProject, type GeneratedReport,
} from '../../lib/reportCreator'

// Interactive AI revision: the user points at a block (or the whole report) and
// describes a change; the backend proposes replacement prose for only the
// affected block(s); the user implements, retries, or dismisses. Nothing is
// written to the store until Implement.

export type RevisePatch = { field: string; clipId: string; label: string; before: string; after: string }
type Scope = 'block' | 'report'

function reqClips(project: ReportProject) {
  return project.clips.map(c => ({
    id: c.id, sourceTab: c.sourceTab, dataType: c.dataType,
    title: clipTitle(c), userDescription: c.userDescription ?? '', dataSummary: summarizeClipForAI(c),
  }))
}

function genView(gen: GeneratedReport) {
  return {
    headline: gen.headline ?? '',
    stance: gen.stance,
    keyResult: gen.keyResult,
    executiveSummary: gen.executiveSummary,
    conclusion: gen.conclusion,
    sections: gen.sections.map(s => ({ clipId: s.clipId, heading: s.heading, analysis: s.analysis })),
  }
}

function describe(gen: GeneratedReport, field: string, clipId: string): { label: string; before: string } {
  const secIndex = () => gen.sections.findIndex(s => s.clipId === clipId)
  switch (field) {
    case 'headline': return { label: 'Headline', before: gen.headline ?? '' }
    case 'executiveSummary': return { label: 'Executive summary', before: gen.executiveSummary }
    case 'conclusion': return { label: 'Conclusion', before: gen.conclusion }
    case 'section.analysis': {
      const i = secIndex(); const s = gen.sections[i]
      return { label: `Section ${i + 1}${s ? ' · ' + s.heading : ''} — analysis`, before: s?.analysis ?? '' }
    }
    case 'section.heading': {
      const i = secIndex(); const s = gen.sections[i]
      return { label: `Section ${i + 1} — heading`, before: s?.heading ?? '' }
    }
    default: return { label: field, before: '' }
  }
}

function errDetail(e: unknown): string {
  const d = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
  return d || 'The AI reviser is unavailable right now. Try again in a moment.'
}

async function requestRevise(project: ReportProject, scope: Scope, instruction: string, field = '', clipId = ''): Promise<RevisePatch[]> {
  const gen = project.generated!
  const payload = {
    projectName: project.name,
    timeframe: timeframeLabel(project.scope),
    purpose: project.scope.purpose,
    goal: project.scope.goal,
    instruction, scope, field, clipId,
    generated: genView(gen),
    clips: reqClips(project),
  }
  const r = await axios.post('/api/ai/report/revise', payload)
  const raw: unknown[] = Array.isArray(r.data.patches) ? r.data.patches : []
  return raw
    .map((x) => {
      const p = x as { field?: string; clipId?: string; before?: string; after?: string }
      const d = describe(gen, String(p.field ?? ''), String(p.clipId ?? ''))
      return { field: String(p.field ?? ''), clipId: String(p.clipId ?? ''), label: d.label, before: String(p.before ?? d.before), after: String(p.after ?? '') }
    })
    .filter(p => p.after.trim() && p.after.trim() !== p.before.trim())
}

export function applyPatch(projectId: string, patch: RevisePatch) {
  switch (patch.field) {
    case 'headline': updateGenerated(projectId, { headline: patch.after }); break
    case 'executiveSummary': updateGenerated(projectId, { executiveSummary: patch.after }); break
    case 'conclusion': updateGenerated(projectId, { conclusion: patch.after }); break
    case 'section.analysis': if (patch.clipId) updateGeneratedSection(projectId, patch.clipId, { analysis: patch.after }); break
    case 'section.heading': if (patch.clipId) updateGeneratedSection(projectId, patch.clipId, { heading: patch.after }); break
  }
}

// ── shared styles ─────────────────────────────────────────────────────────────
const ghostBtn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent',
  border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label, fontSize: 8.5, fontWeight: 700,
  letterSpacing: '0.08em', textTransform: 'uppercase', padding: '5px 9px', cursor: 'pointer',
}
const goldBtn: React.CSSProperties = {
  ...ghostBtn, background: T.goldTint(12), border: `1px solid ${T.gold}`, color: T.gold,
}
const composerField: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.label,
  fontSize: 11, lineHeight: 1.5, padding: '7px 9px', width: '100%', outline: 'none', boxSizing: 'border-box', resize: 'vertical',
}

function Composer({ value, onChange, onSubmit, onCancel, loading, placeholder, submitLabel }: {
  value: string; onChange: (v: string) => void; onSubmit: () => void; onCancel: () => void
  loading: boolean; placeholder: string; submitLabel: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <textarea autoFocus rows={2} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit() }}
        style={composerField} />
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onSubmit} disabled={loading || !value.trim()} style={{ ...goldBtn, opacity: loading || !value.trim() ? 0.55 : 1, cursor: loading || !value.trim() ? 'default' : 'pointer' }}>
          {loading ? <Loader2 size={11} className="rc-spin" /> : <Wand2 size={11} />} {submitLabel}
        </button>
        <button onClick={onCancel} style={ghostBtn}>Cancel</button>
      </div>
    </div>
  )
}

function ProposalCard({ patch, showLabel }: { patch: RevisePatch; showLabel?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ border: `1px solid ${T.gold}`, background: T.goldTint(5), padding: '9px 11px' }}>
      {showLabel && (
        <div style={{ fontFamily: T.label, fontSize: 8, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, marginBottom: 5 }}>{patch.label}</div>
      )}
      <div style={{ fontFamily: T.label, fontSize: 11.5, lineHeight: 1.55, color: T.text, whiteSpace: 'pre-wrap' }}>{patch.after}</div>
      {patch.before.trim() && (
        <>
          <button onClick={() => setOpen(o => !o)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginTop: 7, background: 'transparent', border: 'none', color: T.muted, fontFamily: T.label, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer', padding: 0 }}>
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} {open ? 'Hide current' : 'Show current'}
          </button>
          {open && (
            <div style={{ fontFamily: T.label, fontSize: 10.5, lineHeight: 1.5, color: T.muted, whiteSpace: 'pre-wrap', marginTop: 5, paddingTop: 6, borderTop: `1px solid ${T.border}`, textDecoration: 'none' }}>{patch.before}</div>
          )}
        </>
      )}
    </div>
  )
}

/** Inline "suggest a change" control attached to one editable block. */
export function BlockRevise({ project, field, clipId = '' }: { project: ReportProject; field: string; clipId?: string }) {
  const [mode, setMode] = useState<'idle' | 'composing' | 'loading' | 'result' | 'error'>('idle')
  const [instruction, setInstruction] = useState('')
  const [patch, setPatch] = useState<RevisePatch | null>(null)
  const [err, setErr] = useState('')

  const run = async () => {
    const ins = instruction.trim()
    if (!ins) return
    setMode('loading'); setErr('')
    try {
      const patches = await requestRevise(project, 'block', ins, field, clipId)
      const mine = patches.find(p => p.field === field && (!clipId || p.clipId === clipId)) ?? patches[0]
      if (!mine) { setErr('The AI did not propose a different version. Try rephrasing the request.'); setMode('error'); return }
      setPatch(mine); setMode('result')
    } catch (e) { setErr(errDetail(e)); setMode('error') }
  }

  const reset = () => { setMode('idle'); setPatch(null); setErr('') }

  if (mode === 'idle') {
    return (
      <button onClick={() => setMode('composing')} style={{ ...ghostBtn, alignSelf: 'flex-start' }} title="Ask the AI to revise this block">
        <Wand2 size={11} /> Suggest a change
      </button>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, border: `1px solid ${T.border}`, background: T.surface, padding: 10 }}>
      {(mode === 'composing' || mode === 'loading') && (
        <Composer value={instruction} onChange={setInstruction} onSubmit={run} onCancel={reset}
          loading={mode === 'loading'} submitLabel="Propose"
          placeholder="What should change here? e.g. state the swing as a percent of price, or tighten this paragraph." />
      )}
      {mode === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.neg }}>{err}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={run} style={goldBtn}><RefreshCw size={11} /> Try again</button>
            <button onClick={reset} style={ghostBtn}>Dismiss</button>
          </div>
        </div>
      )}
      {mode === 'result' && patch && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ProposalCard patch={patch} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => { applyPatch(project.id, patch); reset() }} style={goldBtn}><Check size={11} /> Implement</button>
            <button onClick={run} style={ghostBtn}><RefreshCw size={11} /> Try again</button>
            <button onClick={reset} style={ghostBtn}><X size={11} /> Dismiss</button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Report-level revision box: one instruction can touch several blocks at once. */
export function ReportRevise({ project }: { project: ReportProject }) {
  const [mode, setMode] = useState<'idle' | 'composing' | 'loading' | 'result' | 'error'>('idle')
  const [instruction, setInstruction] = useState('')
  const [patches, setPatches] = useState<RevisePatch[]>([])
  const [err, setErr] = useState('')

  const run = async () => {
    const ins = instruction.trim()
    if (!ins) return
    setMode('loading'); setErr('')
    try {
      const result = await requestRevise(project, 'report', ins)
      if (!result.length) { setErr('The AI did not propose any changes for that request. Try being more specific.'); setMode('error'); return }
      setPatches(result); setMode('result')
    } catch (e) { setErr(errDetail(e)); setMode('error') }
  }

  const reset = () => { setMode('idle'); setPatches([]); setErr('') }
  const implementAll = () => { patches.forEach(p => applyPatch(project.id, p)); reset() }

  if (mode === 'idle') {
    return (
      <div style={{ border: `1px dashed ${T.border}`, background: T.bg, padding: '9px 11px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted, lineHeight: 1.5 }}>
          Point out anything to improve across the whole report and let the AI propose the edits.
        </span>
        <button onClick={() => setMode('composing')} style={{ ...goldBtn, flexShrink: 0 }}><Wand2 size={11} /> Revise with AI</button>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 9, border: `1px solid ${T.gold}`, background: T.goldTint(4), padding: 12 }}>
      <div style={{ fontFamily: T.label, fontSize: 9, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold }}>Revise report with AI</div>
      {(mode === 'composing' || mode === 'loading') && (
        <Composer value={instruction} onChange={setInstruction} onSubmit={run} onCancel={reset}
          loading={mode === 'loading'} submitLabel="Propose changes"
          placeholder="e.g. express every price swing as a percent of the current price, and sharpen the executive summary." />
      )}
      {mode === 'error' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.neg }}>{err}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={run} style={goldBtn}><RefreshCw size={11} /> Try again</button>
            <button onClick={reset} style={ghostBtn}>Dismiss</button>
          </div>
        </div>
      )}
      {mode === 'result' && patches.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
          <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>
            {patches.length} block{patches.length === 1 ? '' : 's'} proposed. Review, then implement or discard.
          </div>
          {patches.map((p, i) => <ProposalCard key={`${p.field}-${p.clipId}-${i}`} patch={p} showLabel />)}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={implementAll} style={goldBtn}><Check size={11} /> Implement all</button>
            <button onClick={run} style={ghostBtn}><RefreshCw size={11} /> Try again</button>
            <button onClick={reset} style={ghostBtn}><X size={11} /> Dismiss</button>
          </div>
        </div>
      )}
    </div>
  )
}
