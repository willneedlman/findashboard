import { Settings2 } from 'lucide-react'
import { T } from '../../lib/theme'
import type { LookbackPreset, LookforwardPreset, ReportLength, ReportScope } from '../../lib/reportCreator'
import { REPORT_TYPES } from './ReportSetupWizard'

// Scope form: dual horizon (lookback + lookforward), purpose, and goal. The type
// and layout chosen during setup are shown but not edited here — changing either
// re-seeds the other answers, so it belongs back in the stepper.

const LAYOUT_LABEL: Record<string, string> = {
  editorial: 'Editorial', 'visual-first': 'Visual first', 'data-dense': 'Data dense', narrative: 'Narrative',
}

const LOOKBACK: { k: LookbackPreset; label: string }[] = [
  { k: 'none', label: 'None' },
  { k: 'last7', label: '7D' },
  { k: 'last30', label: '30D' },
  { k: 'last90', label: '90D' },
  { k: 'qtd', label: 'QTD' },
  { k: 'ytd', label: 'YTD' },
  { k: 'custom', label: 'Custom' },
]

const LOOKFORWARD: { k: LookforwardPreset; label: string }[] = [
  { k: 'none', label: 'None' },
  { k: 'next7', label: '7D' },
  { k: 'next30', label: '30D' },
  { k: 'next90', label: '90D' },
  { k: 'next180', label: '180D' },
  { k: 'custom', label: 'Custom' },
]

const LENGTH: { k: ReportLength; label: string; hint: string }[] = [
  { k: 'short', label: 'Short', hint: '1-2 sections · headline verdict only' },
  { k: 'medium', label: 'Medium', hint: '3-6 sections normally · expands when evidence requires' },
  { k: 'long', label: 'Long', hint: '6-12 sections · full supporting detail' },
]

const label: React.CSSProperties = {
  display: 'block', fontFamily: T.label, fontSize: 8.5, fontWeight: 700,
  letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, marginBottom: 7,
}
const field: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.label,
  fontSize: 11.5, lineHeight: 1.55, padding: '8px 10px', width: '100%', outline: 'none', boxSizing: 'border-box', resize: 'vertical',
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

function ChipRow<K extends string>({
  options, value, onPick,
}: {
  options: { k: K; label: string }[]
  value: K
  onPick: (k: K) => void
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {options.map(p => (
        <button key={p.k} type="button" onClick={() => onPick(p.k)} style={chipOn(value === p.k)}>
          {p.label}
        </button>
      ))}
    </div>
  )
}

export default function ReportWizardForm({ scope, onChange, onEditSetup }: {
  scope: ReportScope; onChange: (patch: Partial<ReportScope>) => void; onEditSetup?: () => void
}) {
  const type = REPORT_TYPES.find(t => t.k === scope.reportType)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {onEditSetup && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          flexWrap: 'wrap', border: `1px solid ${T.border}`, background: T.bg, padding: '9px 11px',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
            {type && <type.Icon size={14} color={T.gold} />}
            <span style={{ fontFamily: T.label, fontSize: 11.5, fontWeight: 700, color: T.text }}>{type?.label ?? 'Report'}</span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>
              {LAYOUT_LABEL[scope.layoutPreset] ?? scope.layoutPreset} layout
            </span>
          </span>
          <button type="button" onClick={onEditSetup} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, background: 'transparent',
            border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.label, fontSize: 8.5,
            fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '5px 9px', cursor: 'pointer',
          }}>
            <Settings2 size={11} /> Change
          </button>
        </div>
      )}
      <div>
        <span style={label}>Horizon</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
              Lookback · historical context
            </div>
            <ChipRow
              options={LOOKBACK}
              value={scope.lookbackPreset}
              onPick={k => onChange({ lookbackPreset: k })}
            />
            {scope.lookbackPreset === 'custom' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <input type="date" value={scope.customStart ?? ''} max={scope.customEnd || undefined}
                  onChange={e => onChange({ customStart: e.target.value })} aria-label="Lookback start"
                  style={dateInp} />
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>to</span>
                <input type="date" value={scope.customEnd ?? ''} min={scope.customStart || undefined}
                  onChange={e => onChange({ customEnd: e.target.value })} aria-label="Lookback end"
                  style={dateInp} />
              </div>
            )}
          </div>

          <div>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
              Lookforward · outlook window
            </div>
            <ChipRow
              options={LOOKFORWARD}
              value={scope.lookforwardPreset}
              onPick={k => onChange({ lookforwardPreset: k })}
            />
            {scope.lookforwardPreset === 'custom' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <input type="date" value={scope.forwardCustomStart ?? ''} max={scope.forwardCustomEnd || undefined}
                  onChange={e => onChange({ forwardCustomStart: e.target.value })} aria-label="Lookforward start"
                  style={dateInp} />
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>to</span>
                <input type="date" value={scope.forwardCustomEnd ?? ''} min={scope.forwardCustomStart || undefined}
                  onChange={e => onChange({ forwardCustomEnd: e.target.value })} aria-label="Lookforward end"
                  style={dateInp} />
              </div>
            )}
          </div>
        </div>
      </div>

      <div>
        <span style={label}>Length</span>
        <ChipRow options={LENGTH} value={scope.length} onPick={k => onChange({ length: k })} />
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 6 }}>
          {LENGTH.find(l => l.k === scope.length)?.hint}
        </div>
      </div>

      <div>
        <label style={label}>Objective</label>
        <textarea value={scope.goal || scope.purpose} onChange={e => onChange({ goal: e.target.value, purpose: '' })} rows={3}
          placeholder="What should this report determine? e.g. Which is the better value between NVDA and AAPL on growth and valuation" style={field} />
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 6 }}>
          The question the report answers. Be specific about the subjects and what you want decided.
        </div>
      </div>

      <div>
        <label style={label}>Must Include</label>
        <textarea value={scope.mustInclude} onChange={e => onChange({ mustInclude: e.target.value })} rows={3}
          placeholder={'One requirement per line — a stat, a verdict, a chart\ne.g. PEG ratio comparison chart\nstate the analyst price target explicitly'}
          style={field} />
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted, marginTop: 6 }}>
          Forces these into the report even if the model would otherwise cut them. If the data isn't in your clips, it says so instead of making it up.
        </div>
      </div>
    </div>
  )
}
