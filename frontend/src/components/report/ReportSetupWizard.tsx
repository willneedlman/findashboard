import { useMemo, useState } from 'react'
import {
  FileText, GitCompare, Globe, Briefcase, ListFilter, BookOpen,
  ChevronLeft, ChevronRight, Check, Sparkles, Keyboard, Wand2, AlertTriangle,
} from 'lucide-react'
import { T } from '../../lib/theme'
import type {
  LayoutPreset, LookbackPreset, LookforwardPreset, ReportDepth, ReportLength, ReportScope, ReportType,
} from '../../lib/reportCreator'
import { REPORT_SECTION_MIN, REPORT_SECTION_MAX_BY_TYPE } from '../../lib/reportCreator'
import { readPMBooks, CASH_SYMBOL } from '../../lib/pmImport'
import {
  readSavedScreens, runSavedScreen, screenReportSymbols,
  type SavedScreen, type ReportResearchPlan, type ReportResearchSourceId,
  type ReportResearchProgress,
} from '../../lib/reportResearch'

type ResearchSourceState = ReportResearchProgress['status'] | 'queued'

// Setup runs before anything is generated: the report's kind, its question, its
// evidence and its composition are decisions the model cannot make for you, and
// a note built from an unanswered scope is the one that comes back wrong.

export const REPORT_TYPES: {
  k: ReportType; label: string; blurb: string; Icon: typeof FileText
  defaults: Partial<ReportScope>; placeholder: string
}[] = [
  {
    k: 'equity-note', label: 'Equity note', blurb: 'One issuer, one verdict', Icon: FileText,
    defaults: { length: 'medium', layoutPreset: 'editorial', lookbackPreset: 'last90', lookforwardPreset: 'next90' },
    placeholder: 'e.g. Is MSFT still worth holding after the FY2026 print?',
  },
  {
    k: 'comparison', label: 'Comparison', blurb: 'A versus B, head to head', Icon: GitCompare,
    defaults: { length: 'medium', layoutPreset: 'data-dense', lookbackPreset: 'last90', lookforwardPreset: 'next90' },
    placeholder: 'e.g. Which is the better value between NVDA and AAPL on growth and valuation?',
  },
  {
    k: 'macro-brief', label: 'Macro brief', blurb: 'Cross-asset or thematic', Icon: Globe,
    defaults: { length: 'short', layoutPreset: 'visual-first', lookbackPreset: 'last30', lookforwardPreset: 'next30' },
    placeholder: 'e.g. What do rates and credit spreads imply for risk assets into year end?',
  },
  {
    k: 'portfolio-review', label: 'Portfolio review', blurb: 'Your book, exposure and risk', Icon: Briefcase,
    defaults: { length: 'medium', layoutPreset: 'data-dense', includePortfolio: true, lookbackPreset: 'qtd', lookforwardPreset: 'next90' },
    placeholder: 'e.g. Where is the concentration risk in my book and what should I trim?',
  },
  {
    k: 'screen-summary', label: 'Screen summary', blurb: 'Write up a result set', Icon: ListFilter,
    defaults: { length: 'short', layoutPreset: 'data-dense', evidenceMode: 'alphatape', lookbackPreset: 'last30', lookforwardPreset: 'none' },
    placeholder: 'e.g. Which names from this screen deserve a closer look, and why?',
  },
  {
    k: 'thesis', label: 'Thesis', blurb: 'Long-form deep dive', Icon: BookOpen,
    defaults: { length: 'long', layoutPreset: 'narrative', lookbackPreset: 'ytd', lookforwardPreset: 'next180' },
    placeholder: 'e.g. Build the bull and bear case for the AI capex cycle over the next two years.',
  },
]

// Layout is a spatial choice, so each option is drawn rather than described: the
// glyph is a miniature of the page it produces.
function LayoutGlyph({ preset, on }: { preset: LayoutPreset; on: boolean }) {
  const ink = on ? T.gold : T.muted
  const fill = on ? T.gold : T.muted
  const line = (x: number, y: number, w: number) =>
    <rect key={`${x}-${y}`} x={x} y={y} width={w} height="2" fill={ink} opacity={0.55} />
  return (
    <svg width="56" height="38" viewBox="0 0 56 38" aria-hidden="true" style={{ display: 'block' }}>
      <rect x="0.5" y="0.5" width="55" height="37" fill="none" stroke={ink} strokeOpacity={0.35} />
      {preset === 'editorial' && <>
        <rect x="6" y="6" width="20" height="3" fill={fill} />
        {[13, 18, 23, 28].map(y => line(6, y, 20))}
        <rect x="32" y="6" width="18" height="26" fill={fill} opacity={0.3} />
      </>}
      {preset === 'visual-first' && <>
        <rect x="6" y="6" width="44" height="15" fill={fill} opacity={0.3} />
        {[25, 30].map(y => line(6, y, 44))}
      </>}
      {preset === 'data-dense' && <>
        {[6, 18, 30].map(x => <rect key={x} x={x} y="6" width="10" height="9" fill={fill} opacity={0.32} />)}
        <rect x="42" y="6" width="8" height="9" fill={fill} opacity={0.32} />
        {[20, 25, 30].map(y => line(6, y, 44))}
      </>}
      {preset === 'narrative' && <>
        <rect x="6" y="6" width="26" height="3" fill={fill} />
        {[13, 18, 23, 28].map(y => line(6, y, 44))}
      </>}
    </svg>
  )
}

const LAYOUTS: { k: LayoutPreset; label: string; blurb: string }[] = [
  { k: 'editorial', label: 'Editorial', blurb: 'Prose leads, one visual beside each argument' },
  { k: 'visual-first', label: 'Visual first', blurb: 'Chart or table opens each section, analysis follows' },
  { k: 'data-dense', label: 'Data dense', blurb: 'Figure rails and tables carry the page' },
  { k: 'narrative', label: 'Narrative', blurb: 'Full-width prose, visuals only where they decide something' },
]

const LENGTH: { k: ReportLength; label: string; hint: string }[] = [
  { k: 'short', label: 'Short', hint: '1-2 sections · headline verdict only' },
  { k: 'medium', label: 'Medium', hint: '3-6 sections · expands when evidence requires' },
  { k: 'long', label: 'Long', hint: '6-12 sections · full supporting detail' },
  { k: 'custom', label: 'Custom', hint: 'Set the section count and the prose depth separately' },
]

const DEPTH: { k: ReportDepth; label: string; hint: string }[] = [
  { k: 'tight', label: 'Tight', hint: '2-3 sentences and 2-3 figures per section' },
  { k: 'standard', label: 'Standard', hint: '1-2 paragraphs and 2-4 figures per section' },
  { k: 'deep', label: 'Deep', hint: '2-4 paragraphs, secondary drivers and sensitivities' },
]
const LOOKBACK: { k: LookbackPreset; label: string }[] = [
  { k: 'none', label: 'None' }, { k: 'last7', label: '7D' }, { k: 'last30', label: '30D' },
  { k: 'last90', label: '90D' }, { k: 'qtd', label: 'QTD' }, { k: 'ytd', label: 'YTD' }, { k: 'custom', label: 'Custom' },
]
const LOOKFORWARD: { k: LookforwardPreset; label: string }[] = [
  { k: 'none', label: 'None' }, { k: 'next7', label: '7D' }, { k: 'next30', label: '30D' },
  { k: 'next90', label: '90D' }, { k: 'next180', label: '180D' }, { k: 'next365', label: '1Y' },
  { k: 'next3y', label: '3Y' }, { k: 'next5y', label: '5Y' }, { k: 'next10y', label: '10Y' },
  { k: 'unlimited', label: 'No limit' }, { k: 'custom', label: 'Custom' },
]

const STEPS = ['Type', 'Question', 'Data', 'Layout', 'Evidence'] as const

const label: React.CSSProperties = {
  display: 'block', fontFamily: T.label, fontSize: 8.5, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 7,
}
const field: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.label,
  fontSize: 11.5, lineHeight: 1.55, padding: '8px 10px', width: '100%', outline: 'none',
  boxSizing: 'border-box', resize: 'vertical',
}
const dateInp: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.mono,
  fontSize: 10.5, padding: '5px 8px', outline: 'none',
  colorScheme: 'var(--theme-color-scheme, dark)' as React.CSSProperties['colorScheme'],
}
const chipOn = (on: boolean): React.CSSProperties => ({
  fontFamily: T.mono, fontSize: 10, fontWeight: on ? 700 : 400, padding: '5px 11px', cursor: 'pointer',
  background: on ? T.goldTint(14) : 'transparent', color: on ? T.gold : T.muted,
  border: `1px solid ${on ? T.gold : T.border}`,
})
const cardOn = (on: boolean): React.CSSProperties => ({
  display: 'flex', flexDirection: 'column', gap: 7, alignItems: 'flex-start', textAlign: 'left',
  padding: '13px 14px', cursor: 'pointer', minWidth: 0,
  background: on ? T.goldTint(10) : T.bg,
  border: `1px solid ${on ? T.gold : T.border}`,
})

function ChipRow<K extends string>({ options, value, onPick }: {
  options: { k: K; label: string }[]; value: K; onPick: (k: K) => void
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {options.map(p => (
        <button key={p.k} type="button" onClick={() => onPick(p.k)} style={chipOn(value === p.k)}>{p.label}</button>
      ))}
    </div>
  )
}

/** Bounded numeric picker. Buttons rather than a number input: the range is
 *  small, the bounds are template-dependent, and a typed value out of range
 *  would have to be silently clamped, which reads as the control ignoring you. */
function Stepper({ value, min, max, onChange }: {
  value: number; min: number; max: number; onChange: (n: number) => void
}) {
  const nudge = (delta: number) => onChange(Math.max(min, Math.min(max, value + delta)))
  const btn = (enabled: boolean) => ({
    fontFamily: T.mono, fontSize: 13, fontWeight: 700, lineHeight: 1,
    width: 26, minHeight: 26, cursor: enabled ? 'pointer' : 'default',
    background: 'transparent', border: `1px solid ${T.border}`,
    color: enabled ? T.text : T.muted, opacity: enabled ? 1 : 0.45,
  } as const)
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center' }}>
      <button type="button" aria-label="One fewer section" disabled={value <= min}
        onClick={() => nudge(-1)} style={btn(value > min)}>-</button>
      <span style={{
        fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text,
        minWidth: 34, minHeight: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        borderTop: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}`,
        fontVariantNumeric: 'tabular-nums',
      }}>{value}</span>
      <button type="button" aria-label="One more section" disabled={value >= max}
        onClick={() => nudge(1)} style={btn(value < max)}>+</button>
    </div>
  )
}

function StepRail({ step, furthest, onJump }: { step: number; furthest: number; onJump: (i: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, marginBottom: 22, flexWrap: 'wrap' }}>
      {STEPS.map((name, i) => {
        const done = i < furthest
        const here = i === step
        const reachable = i <= furthest
        const ink = here ? T.gold : done ? T.text : T.muted
        return (
          <div key={name} style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
            <button type="button" disabled={!reachable} onClick={() => reachable && onJump(i)}
              aria-current={here ? 'step' : undefined}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: '2px 8px',
                background: 'transparent', border: 'none', cursor: reachable ? 'pointer' : 'default',
              }}>
              <span style={{
                width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: '50%', border: `1px solid ${here ? T.gold : done ? T.text : T.border}`,
                background: here ? T.goldTint(16) : 'transparent',
                fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: ink,
              }}>
                {done ? <Check size={11} /> : i + 1}
              </span>
              <span style={{
                fontFamily: T.label, fontSize: 8.5, fontWeight: here ? 700 : 500, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: ink, whiteSpace: 'nowrap',
              }}>{name}</span>
            </button>
            {i < STEPS.length - 1 && (
              <span style={{ width: 26, height: 1, background: i < furthest ? T.text : T.border, opacity: i < furthest ? 0.5 : 1, marginBottom: 14 }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// Subjects can come from four places. Whichever you use, the result lands in the
// same researchSymbols string, so everything downstream stays deterministic.
type SubjectSource = 'manual' | 'portfolio' | 'saved-screen' | 'ai-screen'

const SUBJECT_SOURCES: { k: SubjectSource; label: string; Icon: typeof Keyboard }[] = [
  { k: 'manual', label: 'Type tickers', Icon: Keyboard },
  { k: 'portfolio', label: 'From a portfolio', Icon: Briefcase },
  { k: 'saved-screen', label: 'From a saved screen', Icon: ListFilter },
  { k: 'ai-screen', label: 'AI runs a screen', Icon: Wand2 },
]

function SubjectPicker({ scope, onChange, isMobile }: {
  scope: ReportScope; onChange: (patch: Partial<ReportScope>) => void; isMobile: boolean
}) {
  const [source, setSource] = useState<SubjectSource>(() => (scope.screenerQuery.trim() ? 'ai-screen' : 'manual'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const books = useMemo(() => readPMBooks(), [])
  const screens = useMemo(() => readSavedScreens(), [])

  const symbols = scope.researchSymbols.split(',').map(s => s.trim()).filter(Boolean)

  // Importing from a book or a saved screen must clear the AI brief, or the
  // research panel would still block on an unapplied query that no longer
  // produced these symbols.
  const setSymbols = (list: string[], why: string) => {
    onChange({ researchSymbols: list.join(', '), screenerQuery: '', screenerAppliedQuery: '' })
    setNote(why)
    setError(null)
  }

  const importPortfolio = (id: string) => {
    const book = books.find(b => b.id === id)
    if (!book) return
    const tickers = [...new Set(book.holdings
      .filter(h => h.shares > 0 && h.ticker && h.ticker.toUpperCase() !== CASH_SYMBOL)
      .map(h => h.ticker.toUpperCase()))]
    if (!tickers.length) {
      setError(`${book.name} has no share positions to import.`)
      return
    }
    setSymbols(tickers, `${tickers.length} holding${tickers.length === 1 ? '' : 's'} from ${book.name}.`)
  }

  const importSavedScreen = async (screen: SavedScreen) => {
    setBusy(true); setError(null); setNote(null)
    try {
      const sel = await runSavedScreen(screen)
      if (!sel.symbols.length) {
        setError(`"${screen.name}" returned no matches. Widen it in the Stock Screener and try again.`)
        return
      }
      setSymbols(sel.symbols, `${sel.symbols.length} of ${sel.total} matches from "${screen.name}".`)
    } catch {
      setError('Could not run that screen. It may use criteria the screener no longer supports.')
    } finally {
      setBusy(false)
    }
  }

  const runAiScreen = async () => {
    const query = scope.screenerQuery.trim()
    if (!query || busy) return
    setBusy(true); setError(null); setNote(null)
    try {
      const sel = await screenReportSymbols(query)
      if (!sel.symbols.length) {
        setError('That screen returned no matches. Broaden the criteria and try again.')
        return
      }
      onChange({ researchSymbols: sel.symbols.join(', '), screenerAppliedQuery: query })
      setNote(`${sel.symbols.length} of ${sel.total} matches. ${sel.explanation}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not run that screen.')
    } finally {
      setBusy(false)
    }
  }

  const pickerStyle: React.CSSProperties = {
    ...field, fontFamily: T.mono, fontSize: 11, cursor: 'pointer',
    appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
    backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238099b0' stroke-width='2.5'><path d='M6 9l6 6 6-6'/></svg>")`,
    backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30,
  }

  return (
    <div>
      <span style={label}>Subjects</span>
      <div style={{ display: 'grid', gap: 5, gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', marginBottom: 10 }}>
        {SUBJECT_SOURCES.map(s => {
          const on = source === s.k
          return (
            <button key={s.k} type="button" onClick={() => { setSource(s.k); setError(null); setNote(null) }}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                fontFamily: T.mono, fontSize: 9.5, fontWeight: on ? 700 : 400, padding: '7px 6px', cursor: 'pointer',
                background: on ? T.goldTint(14) : 'transparent', color: on ? T.gold : T.muted,
                border: `1px solid ${on ? T.gold : T.border}`,
              }}>
              <s.Icon size={12} /> {s.label}
            </button>
          )
        })}
      </div>

      {source === 'manual' && (
        <input value={scope.researchSymbols} onChange={e => onChange({ researchSymbols: e.target.value })}
          placeholder="Tickers, comma separated, e.g. MSFT, NVDA" style={{ ...field, fontFamily: T.mono, fontSize: 11 }} />
      )}

      {source === 'portfolio' && (
        books.length ? (
          <select defaultValue="" onChange={e => e.target.value && importPortfolio(e.target.value)} style={pickerStyle}>
            <option value="">Pick a portfolio to import…</option>
            {books.map(b => (
              <option key={b.id} value={b.id}>
                {b.name} · {b.holdings.filter(h => h.shares > 0).length} positions
              </option>
            ))}
          </select>
        ) : (
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
            No saved portfolios. Build one in Portfolio Manager, then import it here.
          </div>
        )
      )}

      {source === 'saved-screen' && (
        screens.length ? (
          <select defaultValue="" disabled={busy}
            onChange={e => {
              const screen = screens.find(s => s.id === e.target.value)
              if (screen) void importSavedScreen(screen)
            }} style={pickerStyle}>
            <option value="">{busy ? 'Running screen…' : 'Pick a saved screen to run…'}</option>
            {screens.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ) : (
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
            No saved screens. Save one in the Stock Screener, then run it here.
          </div>
        )
      )}

      {source === 'ai-screen' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea value={scope.screenerQuery} rows={2}
            onChange={e => onChange({ screenerQuery: e.target.value })}
            placeholder="Describe the screen, e.g. profitable US software names under 25x earnings growing revenue over 20%"
            style={field} />
          <button type="button" onClick={() => void runAiScreen()} disabled={busy || !scope.screenerQuery.trim()}
            style={{
              alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'transparent', border: `1px solid ${scope.screenerQuery.trim() ? T.gold : T.border}`,
              color: scope.screenerQuery.trim() ? T.gold : T.muted,
              fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', padding: '7px 11px',
              cursor: (busy || !scope.screenerQuery.trim()) ? 'default' : 'pointer',
              opacity: busy ? 0.6 : 1,
            }}>
            <Wand2 size={12} /> {busy ? 'Running…' : 'Run screen'}
          </button>
        </div>
      )}

      {error && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontFamily: T.mono, fontSize: 9.5, color: T.warn, lineHeight: 1.55, marginTop: 8 }}>
          <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{error}</span>
        </div>
      )}
      {note && !error && (
        <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted, lineHeight: 1.55, marginTop: 8 }}>{note}</div>
      )}

      {symbols.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 10 }}>
          {symbols.map(s => (
            <span key={s} style={{
              fontFamily: T.mono, fontSize: 9.5, color: T.text,
              border: `1px solid ${T.border}`, background: T.bg, padding: '3px 7px',
            }}>{s}</span>
          ))}
        </div>
      )}
    </div>
  )
}

const STATUS_INK: Record<ResearchSourceState, string> = {
  complete: 'var(--theme-positive, #22c55e)',
  partial: 'var(--theme-primary, #c9a84c)',
  running: 'var(--theme-primary, #c9a84c)',
  failed: 'var(--theme-negative, #ef4444)',
  queued: T.muted,
}
const STATUS_WORD: Record<ResearchSourceState, string> = {
  complete: 'collected', partial: 'partial', running: 'running', failed: 'failed', queued: 'queued',
}

// The research pass runs inside the flow rather than after it. Leaving it to a
// panel further down the page meant the last step's only real option was to skip.
function EvidenceStep({ evidence, clipCount, isMobile }: {
  evidence: WizardEvidence; clipCount: number; isMobile: boolean
}) {
  const { plan, planning, running, statuses, error, planningError } = evidence
  const blocked = plan?.blockedReason

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
      {planning && (
        <div style={{ fontFamily: T.mono, fontSize: 10.5, color: T.gold }}>
          Choosing the tools your objective needs...
        </div>
      )}

      {blocked && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontFamily: T.mono, fontSize: 10, color: T.warn, lineHeight: 1.55 }}>
          <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{blocked}</span>
        </div>
      )}

      {plan && !blocked && plan.sources.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
            <span style={{ ...label, marginBottom: 0 }}>Research plan</span>
            <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>
              {plan.sources.length} tool{plan.sources.length === 1 ? '' : 's'}
              {plan.aiEnhanced ? ' · AI selected' : ' · baseline'}
              {plan.symbols.length ? ` · ${plan.symbols.join(', ')}` : ' · market scope'}
            </span>
          </div>
          <div style={{ display: 'grid', gap: 5, gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
            {plan.sources.map(s => {
              const state = statuses[s.id] ?? (running ? 'queued' : undefined)
              return (
                <div key={s.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
                  border: `1px solid ${T.border}`, background: T.bg, padding: '6px 9px',
                }}>
                  <span style={{
                    width: 5, height: 5, flexShrink: 0, borderRadius: '50%',
                    background: state ? STATUS_INK[state] ?? T.muted : T.border,
                  }} />
                  <span style={{ fontFamily: T.label, fontSize: 10.5, color: T.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {s.label}
                  </span>
                  <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginLeft: 'auto', flexShrink: 0 }}>
                    {state ? STATUS_WORD[state] : s.tool}
                  </span>
                </div>
              )
            })}
          </div>
          {plan.aiSummary && (
            <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted, lineHeight: 1.55, marginTop: 8 }}>{plan.aiSummary}</div>
          )}
        </div>
      )}

      {(error || planningError) && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontFamily: T.mono, fontSize: 10, color: T.neg, lineHeight: 1.55 }}>
          <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{error || planningError}</span>
        </div>
      )}

      {clipCount > 0 && !running && (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: T.mono, fontSize: 10, color: T.pos }}>
          <Check size={12} /> {clipCount} clip{clipCount === 1 ? '' : 's'} collected. Run again to refresh, or generate.
        </div>
      )}
    </div>
  )
}

function Summary({ rows }: { rows: [string, string][] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', border: `1px solid ${T.border}` }}>
      {rows.map(([k, v], i) => (
        <div key={k} style={{
          display: 'flex', gap: 14, padding: '9px 12px',
          borderTop: i === 0 ? 'none' : `1px solid ${T.border}`,
        }}>
          <span style={{ fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, width: 108, flexShrink: 0 }}>{k}</span>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.text, lineHeight: 1.5, minWidth: 0 }}>{v}</span>
        </div>
      ))}
    </div>
  )
}

export interface WizardEvidence {
  plan: ReportResearchPlan | null
  planning: boolean
  running: boolean
  statuses: Partial<Record<ReportResearchSourceId, ResearchSourceState>>
  error: string | null
  planningError: string | null
  onRun: () => void
}

export default function ReportSetupWizard({
  scope, clipCount, generating, onChange, onFinish, onGenerate, isMobile, evidence,
}: {
  scope: ReportScope
  clipCount: number
  generating: boolean
  onChange: (patch: Partial<ReportScope>) => void
  onFinish: () => void
  onGenerate: () => void
  isMobile: boolean
  evidence: WizardEvidence
}) {
  const [step, setStep] = useState(0)
  // The ceiling is the template's own argument arc: asking for more sections
  // than it has purposes for would mean inventing one the writer then pads.
  const maxSections = REPORT_SECTION_MAX_BY_TYPE[scope.reportType] ?? 6
  const sections = Math.max(REPORT_SECTION_MIN, Math.min(scope.customSections ?? 4, maxSections))
  // Re-entering setup on a configured project (the Change button) should not make
  // you click Next through answers you already gave — open every step at once.
  const [furthest, setFurthest] = useState(
    () => ((scope.goal || scope.purpose).trim() ? STEPS.length - 1 : 0),
  )

  const type = REPORT_TYPES.find(t => t.k === scope.reportType) ?? REPORT_TYPES[0]
  const goal = (scope.goal || scope.purpose).trim()
  // Only the question is truly required — everything else has a defensible default.
  const canAdvance = step !== 1 || goal.length > 0

  const go = (next: number) => {
    const clamped = Math.max(0, Math.min(STEPS.length - 1, next))
    setStep(clamped)
    setFurthest(f => Math.max(f, clamped))
  }

  // Picking a type re-seeds the choices that type usually implies. Later steps
  // stay editable, so this is a starting point rather than a lock-in — but only
  // on a real change, or re-clicking the current type would silently discard the
  // layout, length and horizon you set in the steps after this one.
  const pickType = (t: typeof REPORT_TYPES[number]) => {
    if (t.k === scope.reportType) return
    onChange({ reportType: t.k, ...t.defaults })
  }

  const researchBusy = evidence.planning || evidence.running
  const researchIsNext = scope.evidenceMode === 'alphatape' && (clipCount === 0 || researchBusy)

  const subjectsText = () => {
    const list = scope.researchSymbols.split(',').map(s => s.trim()).filter(Boolean)
    if (!list.length) return 'Taken from the question'
    const shown = list.join(', ')
    return list.length > 8 ? `${list.length} subjects — ${shown}, +${list.length - 8} more` : shown
  }

  const horizonText = () => {
    const b = LOOKBACK.find(l => l.k === scope.lookbackPreset)?.label ?? '—'
    const f = LOOKFORWARD.find(l => l.k === scope.lookforwardPreset)?.label ?? '—'
    return `${b} back · ${f} forward`
  }

  return (
    <div style={{ border: `1px solid ${T.border}`, background: T.surface, padding: isMobile ? '18px 16px' : '22px 24px' }}>
      <StepRail step={step} furthest={furthest} onJump={go} />

      {step === 0 && (
        <div>
          <h2 style={{ fontFamily: T.label, fontSize: 14, fontWeight: 700, color: T.text, margin: '0 0 5px' }}>What kind of report?</h2>
          <p style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, lineHeight: 1.6, margin: '0 0 16px' }}>
            This sets the argument shape and what counts as a verdict. It also seeds the horizon, length and layout, all of which you can change later.
          </p>
          <div style={{ display: 'grid', gap: 10, gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)' }}>
            {REPORT_TYPES.map(t => {
              const on = scope.reportType === t.k
              return (
                <button key={t.k} type="button" onClick={() => pickType(t)} style={cardOn(on)}>
                  <t.Icon size={17} color={on ? T.gold : T.muted} />
                  <span style={{ fontFamily: T.label, fontSize: 12, fontWeight: 700, color: on ? T.gold : T.text }}>{t.label}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted, lineHeight: 1.45 }}>{t.blurb}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <h2 style={{ fontFamily: T.label, fontSize: 14, fontWeight: 700, color: T.text, margin: '0 0 5px' }}>What should it answer?</h2>
          <p style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, lineHeight: 1.6, margin: '0 0 16px' }}>
            One specific question, naming the subjects and what you want decided. This is the only answer the report is graded against.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={label}>Objective</label>
              <textarea value={scope.goal || scope.purpose} rows={3} autoFocus
                onChange={e => onChange({ goal: e.target.value, purpose: '' })}
                placeholder={type.placeholder} style={field} />
              {!goal && (
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.warn, marginTop: 6 }}>
                  Required. Without it the report has nothing to conclude.
                </div>
              )}
            </div>
            <div>
              <label style={label}>Must include</label>
              <textarea value={scope.mustInclude} rows={3}
                onChange={e => onChange({ mustInclude: e.target.value })}
                placeholder={'One requirement per line — a stat, a verdict, a chart\ne.g. PEG ratio comparison chart\nstate the analyst price target explicitly'}
                style={field} />
              <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 6 }}>
                Forced in even if the model would cut them. If the data is not in your evidence, it says so instead of inventing it.
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div>
          <h2 style={{ fontFamily: T.label, fontSize: 14, fontWeight: 700, color: T.text, margin: '0 0 5px' }}>Where does the evidence come from?</h2>
          <p style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, lineHeight: 1.6, margin: '0 0 16px' }}>
            Nothing is written from the model's own memory. Every figure in the report traces to evidence you supply here.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'grid', gap: 10, gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr' }}>
              {([
                ['alphatape', 'AlphaTape gathers it', 'Plans a research run across the terminal tools and collects the clips for you.'],
                ['manual', 'My clips only', `Uses what you send with Send to Report. ${clipCount} clip${clipCount === 1 ? '' : 's'} so far.`],
              ] as const).map(([mode, title, blurb]) => {
                const on = scope.evidenceMode === mode
                return (
                  <button key={mode} type="button" onClick={() => onChange({ evidenceMode: mode })} style={cardOn(on)}>
                    <span style={{ fontFamily: T.label, fontSize: 12, fontWeight: 700, color: on ? T.gold : T.text }}>{title}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted, lineHeight: 1.45 }}>{blurb}</span>
                  </button>
                )
              })}
            </div>

            <SubjectPicker scope={scope} onChange={onChange} isMobile={isMobile} />

            <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' }}>
              <span style={{
                width: 15, height: 15, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                border: `1px solid ${scope.includePortfolio ? T.gold : T.muted}`,
                background: scope.includePortfolio ? T.goldTint(14) : 'transparent', color: T.gold,
              }}>{scope.includePortfolio && <Check size={10} />}</span>
              <input type="checkbox" checked={scope.includePortfolio} onChange={e => onChange({ includePortfolio: e.target.checked })}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
              <span style={{ fontFamily: T.label, fontSize: 11.5, color: T.text }}>Include my portfolio as context</span>
            </label>

            <div>
              <span style={label}>Horizon</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div>
                  <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Lookback · historical context</div>
                  <ChipRow options={LOOKBACK} value={scope.lookbackPreset} onPick={k => onChange({ lookbackPreset: k })} />
                  {scope.lookbackPreset === 'custom' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                      <input type="date" value={scope.customStart ?? ''} max={scope.customEnd || undefined}
                        onChange={e => onChange({ customStart: e.target.value })} aria-label="Lookback start" style={dateInp} />
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>to</span>
                      <input type="date" value={scope.customEnd ?? ''} min={scope.customStart || undefined}
                        onChange={e => onChange({ customEnd: e.target.value })} aria-label="Lookback end" style={dateInp} />
                    </div>
                  )}
                </div>
                <div>
                  <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>Lookforward · outlook window</div>
                  <ChipRow options={LOOKFORWARD} value={scope.lookforwardPreset} onPick={k => onChange({ lookforwardPreset: k })} />
                  {scope.lookforwardPreset === 'custom' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                      <input type="date" value={scope.forwardCustomStart ?? ''} max={scope.forwardCustomEnd || undefined}
                        onChange={e => onChange({ forwardCustomStart: e.target.value })} aria-label="Lookforward start" style={dateInp} />
                      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>to</span>
                      <input type="date" value={scope.forwardCustomEnd ?? ''} min={scope.forwardCustomStart || undefined}
                        onChange={e => onChange({ forwardCustomEnd: e.target.value })} aria-label="Lookforward end" style={dateInp} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div>
          <h2 style={{ fontFamily: T.label, fontSize: 14, fontWeight: 700, color: T.text, margin: '0 0 5px' }}>How should it read?</h2>
          <p style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, lineHeight: 1.6, margin: '0 0 16px' }}>
            Composition preference and depth. The renderer still adapts a section when its actual visual will not fit the chosen shape.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div>
              <span style={label}>Layout</span>
              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)' }}>
                {LAYOUTS.map(l => {
                  const on = scope.layoutPreset === l.k
                  return (
                    <button key={l.k} type="button" onClick={() => onChange({ layoutPreset: l.k })} style={{ ...cardOn(on), alignItems: 'stretch' }}>
                      <LayoutGlyph preset={l.k} on={on} />
                      <span style={{ fontFamily: T.label, fontSize: 11.5, fontWeight: 700, color: on ? T.gold : T.text }}>{l.label}</span>
                      <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, lineHeight: 1.45 }}>{l.blurb}</span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div>
              <span style={label}>Length</span>
              <ChipRow options={LENGTH} value={scope.length} onPick={k => onChange({
                length: k,
                // Seed the custom dials from the current preset so switching to
                // Custom starts where the note already was, not at a default.
                ...(k === 'custom' && !scope.customSections ? {
                  customSections: scope.length === 'short' ? 2 : scope.length === 'long' ? maxSections : 4,
                  customDepth: scope.length === 'short' ? 'tight' : scope.length === 'long' ? 'deep' : 'standard',
                } : {}),
              })} />
              <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 6 }}>
                {LENGTH.find(l => l.k === scope.length)?.hint}
              </div>
              {scope.length === 'custom' && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.borderFaint}`, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <span style={label}>Sections</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Stepper
                        value={sections}
                        min={REPORT_SECTION_MIN}
                        max={maxSections}
                        onChange={n => onChange({ customSections: n })}
                      />
                      <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
                        {REPORT_SECTION_MIN} to {maxSections} for a {REPORT_TYPES.find(entry => entry.k === scope.reportType)?.label.toLowerCase() ?? 'note'}
                      </span>
                    </div>
                    <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>
                      {/* Trimming happens in the middle: the opening states the call
                          and the closing argues against it, so neither is ever cut. */}
                      The verdict and the counter-case always stay. Fewer sections drop supporting detail between them.
                    </div>
                  </div>
                  <div>
                    <span style={label}>Depth per section</span>
                    <ChipRow options={DEPTH} value={scope.customDepth ?? 'standard'} onPick={k => onChange({ customDepth: k })} />
                    <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 6 }}>
                      {DEPTH.find(d => d.k === (scope.customDepth ?? 'standard'))?.hint}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {step === 4 && (
        <div>
          <h2 style={{ fontFamily: T.label, fontSize: 14, fontWeight: 700, color: T.text, margin: '0 0 5px' }}>Gather the evidence</h2>
          <p style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, lineHeight: 1.6, margin: '0 0 16px' }}>
            {scope.evidenceMode === 'alphatape'
              ? 'AlphaTape picks the tools your objective needs and collects them as clips. Nothing is written until you review what came back.'
              : 'Your report will use the clips you send with Send to Report. Collect them, then generate.'}
          </p>

          {scope.evidenceMode === 'alphatape' && <EvidenceStep evidence={evidence} clipCount={clipCount} isMobile={isMobile} />}

          <Summary rows={[
            ['Type', `${type.label} — ${type.blurb}`],
            ['Question', goal || 'Not set'],
            ['Must include', scope.mustInclude.trim() || 'Nothing forced'],
            ['Evidence', scope.evidenceMode === 'alphatape' ? 'AlphaTape research run' : `Manual clips (${clipCount})`],
            ['Subjects', subjectsText()],
            ['Portfolio', scope.includePortfolio ? 'Included as context' : 'Excluded'],
            ['Horizon', horizonText()],
            ['Layout', `${LAYOUTS.find(l => l.k === scope.layoutPreset)?.label} · ${
              scope.length === 'custom'
                ? `${sections} sections, ${scope.customDepth ?? 'standard'}`
                : LENGTH.find(l => l.k === scope.length)?.label
            }`],
          ]} />
          {clipCount === 0 && scope.evidenceMode === 'manual' && (
            <div style={{ fontFamily: T.mono, fontSize: 10, color: T.warn, lineHeight: 1.6, marginTop: 12 }}>
              No clips yet. Open any tool and use Send to Report, then come back and generate.
            </div>
          )}
        </div>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        marginTop: 22, paddingTop: 16, borderTop: `1px solid ${T.border}`,
      }}>
        <button type="button" onClick={() => go(step - 1)} disabled={step === 0}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent',
            border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label, fontSize: 9,
            fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 12px',
            cursor: step === 0 ? 'default' : 'pointer', opacity: step === 0 ? 0.4 : 1,
          }}>
          <ChevronLeft size={12} /> Back
        </button>

        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>Step {step + 1} of {STEPS.length}</span>

        {step < STEPS.length - 1 ? (
          <button type="button" onClick={() => canAdvance && go(step + 1)} disabled={!canAdvance}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: canAdvance ? T.gold : 'transparent',
              border: `1px solid ${canAdvance ? T.gold : T.border}`,
              color: canAdvance ? 'var(--theme-bg)' : T.muted,
              fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', padding: '8px 14px',
              cursor: canAdvance ? 'pointer' : 'default', opacity: canAdvance ? 1 : 0.5,
            }}>
            Next <ChevronRight size={12} />
          </button>
        ) : (
          <span style={{ display: 'inline-flex', gap: 8 }}>
            <button type="button" onClick={onFinish}
              style={{
                background: 'transparent', border: `1px solid ${T.border}`, color: T.muted,
                fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                textTransform: 'uppercase', padding: '8px 12px', cursor: 'pointer',
              }}>
              Do it manually
            </button>
            {/* AlphaTape mode with nothing collected yet: running the research IS
                the next step, so it takes the primary action rather than sitting
                in a panel the user had to skip ahead to. */}
            {researchIsNext ? (
              <button type="button" onClick={evidence.onRun} disabled={researchBusy || !!evidence.plan?.blockedReason}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: researchBusy || evidence.plan?.blockedReason ? 'transparent' : T.gold,
                  border: `1px solid ${researchBusy || evidence.plan?.blockedReason ? T.border : T.gold}`,
                  color: researchBusy || evidence.plan?.blockedReason ? T.muted : 'var(--theme-bg)',
                  fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '8px 14px',
                  cursor: researchBusy ? 'default' : 'pointer', opacity: researchBusy ? 0.6 : 1,
                }}>
                <Wand2 size={12} /> {evidence.planning ? 'Planning...' : evidence.running ? 'Researching...' : 'Run AlphaTape research'}
              </button>
            ) : (
              <button type="button" onClick={() => { onFinish(); onGenerate() }} disabled={generating || clipCount === 0}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: clipCount === 0 ? 'transparent' : T.gold,
                  border: `1px solid ${clipCount === 0 ? T.border : T.gold}`,
                  color: clipCount === 0 ? T.muted : 'var(--theme-bg)',
                  fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
                  textTransform: 'uppercase', padding: '8px 14px',
                  cursor: (generating || clipCount === 0) ? 'default' : 'pointer',
                  opacity: (generating || clipCount === 0) ? 0.55 : 1,
                }}>
                <Sparkles size={12} /> {generating ? 'Generating...' : 'Generate report'}
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  )
}
