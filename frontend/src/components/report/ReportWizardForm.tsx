import { T } from '../../lib/theme'
import type { LookbackPreset, LookforwardPreset, ReportScope } from '../../lib/reportCreator'

// Scope form: dual horizon (lookback + lookforward), purpose, and goal.

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

export default function ReportWizardForm({ scope, onChange }: { scope: ReportScope; onChange: (patch: Partial<ReportScope>) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
        <label style={label}>Purpose</label>
        <textarea value={scope.purpose} onChange={e => onChange({ purpose: e.target.value })} rows={2}
          placeholder="Quarterly risk assessment and portfolio rebalancing review" style={field} />
      </div>

      <div>
        <label style={label}>Goal</label>
        <textarea value={scope.goal} onChange={e => onChange({ goal: e.target.value })} rows={2}
          placeholder="Identify capital allocation adjustments and hedge tail risk" style={field} />
      </div>
    </div>
  )
}
