import { useState } from 'react'
import { ChevronUp, ChevronDown, Play, X, MoreHorizontal } from 'lucide-react'
import StrategySelector, { STRATEGIES, type StrategyParams } from '../StrategySelector'
import { weightTotal, normalizeTo100 } from './weights'

export type Holding = { ticker: string; weight: number; strategy: string; stratParams: StrategyParams }

export type ConfigMode = 'backtester' | 'montecarlo'

interface RiskField { val: string; set: (v: string) => void }

interface Props {
  mode: ConfigMode
  collapsed: boolean
  onToggleCollapse: () => void

  holdings: Holding[]
  onHoldingsChange: (next: Holding[]) => void

  benchmark: string; setBenchmark: (v: string) => void
  leverage: string; setLeverage: (v: string) => void
  borrowRate: string; setBorrowRate: (v: string) => void

  // Risk controls (shared)
  sl: RiskField; tp: RiskField; trail: RiskField; pos: RiskField; cash: RiskField

  // Backtester window
  start?: string; setStart?: (v: string) => void
  end?: string; setEnd?: (v: string) => void

  // Monte Carlo parameters
  horizon?: number; setHorizon?: (v: number) => void
  nSims?: number; setNSims?: (v: number) => void
  targetPrice?: number; setTargetPrice?: (v: number) => void
  // Extra full-width control rendered below the parameter grid (e.g. MC model)
  paramExtra?: React.ReactNode

  onRun: () => void
  isRunning: boolean

  // Import / export controls, shown in the header overflow menu
  overflow?: React.ReactNode
  // e.g. a <datalist> the ticker inputs reference
  tickerListId?: string
  tickerList?: React.ReactNode
}

const T = {
  bg: 'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  card: 'color-mix(in srgb, var(--theme-surface, #0d1826) 100%, #000 8%)',
  primary: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)',
  sec: 'var(--theme-secondary, #8099b0)',
  faint: 'var(--theme-text-faint, rgba(255,255,255,0.22))',
  border: 'var(--theme-border, rgba(255,255,255,0.08))',
  pos: 'var(--theme-positive, #22c55e)',
  neg: 'var(--theme-negative, #ef4444)',
  mono: 'var(--theme-mono)',
  sans: 'var(--theme-sans)',
}

// Distinct allocation-bar tints derived from the active accent, so the bar reads
// as a sequence of holdings without hardcoding the prototype's orange shades.
const SHADES = [
  T.primary,
  'color-mix(in srgb, var(--theme-primary, #c9a84c) 76%, #000)',
  'color-mix(in srgb, var(--theme-primary, #c9a84c) 70%, #fff)',
  'color-mix(in srgb, var(--theme-primary, #c9a84c) 52%, #000)',
  'color-mix(in srgb, var(--theme-primary, #c9a84c) 88%, #000)',
  'color-mix(in srgb, var(--theme-primary, #c9a84c) 58%, #fff)',
]
const shade = (i: number) => SHADES[i % SHADES.length]

const SUBLABEL: React.CSSProperties = {
  fontFamily: T.sans, fontSize: 8, fontWeight: 700, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: T.faint, display: 'block', marginBottom: 3,
}
const SECTION: React.CSSProperties = {
  fontFamily: T.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em',
  textTransform: 'uppercase', color: T.sec,
}
export const paramInput: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: T.bg,
  border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)',
  color: T.text, fontFamily: T.mono, fontSize: 12, padding: '6px 8px', outline: 'none',
}
const inputBase = paramInput
const focusOn = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = T.primary)
const focusOff = (e: React.FocusEvent<HTMLInputElement>) =>
  (e.target.style.borderColor = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)')

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label style={SUBLABEL}>{label}</label>{children}</div>
}

export type RebalanceFreq = 'none' | 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annually'
export const REBALANCE_LABELS: Record<RebalanceFreq, string> = {
  none: 'Never (buy & hold)', daily: 'Daily', weekly: 'Weekly',
  monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Annually',
}

export function RebalanceSelect({ value, onChange }: { value: RebalanceFreq; onChange: (v: RebalanceFreq) => void }) {
  return (
    <Field label="Rebalance to Weights">
      <select value={value} onChange={e => onChange(e.target.value as RebalanceFreq)}
        style={{ ...paramInput, cursor: 'pointer' }}>
        {(Object.keys(REBALANCE_LABELS) as RebalanceFreq[]).map(f => (
          <option key={f} value={f}>{REBALANCE_LABELS[f]}</option>
        ))}
      </select>
    </Field>
  )
}

function NumberInput({ value, onChange, placeholder, step, min }:
  { value: number | string; onChange: (v: string) => void; placeholder?: string; step?: number; min?: number }) {
  return (
    <input type="number" value={value} placeholder={placeholder} step={step} min={min}
      onChange={e => onChange(e.target.value)} onFocus={focusOn} onBlur={focusOff}
      style={{ ...inputBase, MozAppearance: 'textfield' } as React.CSSProperties} />
  )
}

function HoldingCard({ holding, index, maxWeight, onChange, onRemove, tickerListId, hideDrift }: {
  holding: Holding; index: number; maxWeight: number
  onChange: (patch: Partial<Holding>) => void; onRemove: () => void; tickerListId?: string; hideDrift?: boolean
}) {
  const [hover, setHover] = useState(false)
  const barPct = maxWeight > 0 ? Math.max(0, (holding.weight / maxWeight) * 100) : 0
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', background: T.card,
        border: `1px solid ${hover ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 40%, transparent)' : T.border}`,
        padding: '8px 9px', boxShadow: '0 1px 5px rgba(0,0,0,0.45)',
      }}>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <input value={holding.ticker} placeholder="TICKER" list={tickerListId}
          onChange={e => onChange({ ticker: e.target.value.toUpperCase() })}
          onFocus={focusOn} onBlur={focusOff}
          style={{ ...inputBase, flex: 1, minWidth: 0, fontWeight: 700, padding: '3px 6px' }} />
        <button onClick={onRemove} aria-label={`Remove ${holding.ticker || 'holding'}`}
          onMouseEnter={e => (e.currentTarget.style.color = T.neg)}
          onMouseLeave={e => (e.currentTarget.style.color = T.faint)}
          style={{ background: 'none', border: 'none', color: T.faint, cursor: 'pointer', padding: 0, display: 'flex', flexShrink: 0 }}>
          <X size={14} />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
        <input type="number" value={holding.weight} step={1}
          onChange={e => onChange({ weight: +e.target.value })} onFocus={focusOn} onBlur={focusOff}
          style={{ ...inputBase, width: 50, flex: 'none', textAlign: 'center', fontWeight: 700, color: T.primary, padding: '3px 4px', MozAppearance: 'textfield' } as React.CSSProperties} />
        <div style={{ flex: 1, height: 4, background: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 10%, transparent)' }}>
          <div style={{ width: `${barPct}%`, height: '100%', background: shade(index) }} />
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <StrategySelector value={holding.strategy} params={holding.stratParams}
          onChange={(s, p) => onChange({ strategy: s, stratParams: p })} compact hideDrift={hideDrift} />
      </div>
    </div>
  )
}

const RISK_PRESETS = [
  { label: 'Conservative', sl: '8', tp: '20', trail: '6', pos: '25' },
  { label: 'Moderate', sl: '15', tp: '35', trail: '10', pos: '50' },
  { label: 'Aggressive', sl: '25', tp: '80', trail: '15', pos: '100' },
  { label: 'Uncapped', sl: '', tp: '', trail: '', pos: '100' },
] as const

export default function ConfigHeader(p: Props) {
  const [menuOpen, setMenuOpen] = useState(false)
  const isBT = p.mode === 'backtester'

  const weights = p.holdings.map(h => h.weight)
  const total = weightTotal(weights)
  const maxWeight = Math.max(0, ...weights)

  const updateHolding = (i: number, patch: Partial<Holding>) =>
    p.onHoldingsChange(p.holdings.map((h, j) => (j === i ? { ...h, ...patch } : h)))
  const rescale = () => {
    const w = normalizeTo100(weights)
    p.onHoldingsChange(p.holdings.map((h, i) => ({ ...h, weight: w[i] })))
  }

  const noun = isBT ? 'asset' : 'leg'
  const eyebrow = isBT ? 'Portfolio Controls' : 'Simulation Parameters'
  const leftLabel = isBT ? 'Holdings · Strategy' : 'Portfolio Legs · Strategy'
  const runLabel = isBT ? 'Run Portfolio Engine' : 'Run Simulation'
  const summary = isBT
    ? `${p.holdings.length} holdings · ${(p.start || '').slice(0, 4)}-${(p.end || '').slice(0, 4)} · ${p.leverage || 1}x · bench ${p.benchmark}`
    : `${p.holdings.length} legs · ${p.horizon}d horizon · ${p.nSims} sims · bench ${p.benchmark}`

  const riskFields: { label: string; f: RiskField; ph: string }[] = [
    { label: 'Stop-Loss %', f: p.sl, ph: 'off' },
    { label: 'Take-Profit %', f: p.tp, ph: 'off' },
    { label: 'Trailing %', f: p.trail, ph: 'off' },
    { label: 'Position %', f: p.pos, ph: '100' },
    { label: 'Cash Yield %', f: p.cash, ph: '4.5' },
  ]

  return (
    <div style={{ border: `1px solid ${T.border}`, background: T.surface }}>
      {/* Header bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '10px 16px', borderBottom: `1px solid ${T.border}` }}>
        <span style={SECTION}>{eyebrow}</span>
        {total === 100 ? (
          <span style={{ fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.pos }}>100%</span>
        ) : (
          <button onClick={rescale} title="Rescale weights to total 100%"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: T.mono, fontSize: 10, fontWeight: 700, color: T.neg }}>
            {total}% → 100%
          </button>
        )}
        <button onClick={p.onToggleCollapse}
          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: T.mono, fontSize: 10, color: T.sec }}>
          {p.collapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          {p.collapsed ? 'Expand' : 'Collapse'}
        </button>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {p.overflow && (
            <div style={{ position: 'relative' }}>
              <button onClick={() => setMenuOpen(o => !o)} aria-label="Import and export"
                style={{ display: 'flex', background: 'none', border: `1px solid ${T.border}`, color: T.sec, cursor: 'pointer', padding: 5 }}>
                <MoreHorizontal size={14} />
              </button>
              {menuOpen && (
                <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 200, width: 230, background: T.bg, border: `1px solid ${T.border}`, boxShadow: '0 10px 30px rgba(0,0,0,0.8)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {p.overflow}
                </div>
              )}
            </div>
          )}
          <button onClick={p.onRun} disabled={p.isRunning}
            style={{ display: 'flex', alignItems: 'center', gap: 6, background: T.primary, border: `1px solid ${T.primary}`, color: T.bg, fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 18px', cursor: p.isRunning ? 'default' : 'pointer', opacity: p.isRunning ? 0.6 : 1, whiteSpace: 'nowrap' }}>
            <Play size={11} fill="currentColor" />{p.isRunning ? 'Running…' : runLabel}
          </button>
        </div>
      </div>

      {/* Allocation bar */}
      <div style={{ display: 'flex', height: 4, background: 'color-mix(in srgb, var(--theme-text, #d7e3fc) 6%, transparent)' }}>
        {p.holdings.map((h, i) => (
          <div key={i} style={{ flexGrow: Math.max(h.weight, 0), flexBasis: 0, background: shade(i) }} />
        ))}
      </div>

      {p.tickerList}

      {p.collapsed ? (
        <div style={{ padding: '11px 16px', fontFamily: T.mono, fontSize: 11, letterSpacing: '0.04em', color: T.sec }}>{summary}</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'stretch', flexWrap: 'wrap' }}>
          {/* Holdings + strategy */}
          <div style={{ flex: 1.7, minWidth: 'min(420px, 100%)', padding: '14px 16px', borderRight: `1px solid ${T.border}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <span style={SECTION}>{leftLabel}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.faint }}>{p.holdings.length} {noun}{p.holdings.length === 1 ? '' : 's'}</span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(166px, 1fr))', gap: 8 }}>
              {p.holdings.map((h, i) => (
                <HoldingCard key={i} holding={h} index={i} maxWeight={maxWeight} tickerListId={p.tickerListId}
                  hideDrift={p.mode === 'backtester'}
                  onChange={patch => updateHolding(i, patch)}
                  onRemove={() => p.onHoldingsChange(p.holdings.filter((_, j) => j !== i))} />
              ))}
              <button onClick={() => p.onHoldingsChange([...p.holdings, { ticker: '', weight: 0, strategy: STRATEGIES[0], stratParams: {} as StrategyParams }])}
                onMouseEnter={e => (e.currentTarget.style.borderColor = T.primary, e.currentTarget.style.color = T.primary)}
                onMouseLeave={e => (e.currentTarget.style.borderColor = T.border, e.currentTarget.style.color = T.sec)}
                style={{ minHeight: 96, background: 'none', border: `1px dashed ${T.border}`, color: T.sec, cursor: 'pointer', fontFamily: T.sans, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                + Add {noun}
              </button>
            </div>
          </div>

          {/* Window / parameters + risk */}
          <div style={{ flex: 1, minWidth: 'min(300px, 100%)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <span style={SECTION}>{isBT ? 'Window' : 'Parameters'}</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                {isBT ? (
                  <>
                    <Field label="Start"><input type="date" value={p.start} onChange={e => p.setStart?.(e.target.value)} onFocus={focusOn} onBlur={focusOff} style={{ ...inputBase, colorScheme: 'dark' } as React.CSSProperties} /></Field>
                    <Field label="End"><input type="date" value={p.end} onChange={e => p.setEnd?.(e.target.value)} onFocus={focusOn} onBlur={focusOff} style={{ ...inputBase, colorScheme: 'dark' } as React.CSSProperties} /></Field>
                    <Field label="Leverage (x)"><NumberInput value={p.leverage} onChange={p.setLeverage} step={0.25} min={1} /></Field>
                    {(Number(p.leverage) || 1) > 1
                      ? <Field label="Borrow Rate %"><NumberInput value={p.borrowRate} onChange={p.setBorrowRate} step={0.5} min={0} /></Field>
                      : <Field label="Benchmark"><input value={p.benchmark} onChange={e => p.setBenchmark(e.target.value.toUpperCase())} onFocus={focusOn} onBlur={focusOff} style={inputBase} /></Field>}
                    {p.paramExtra && <div style={{ gridColumn: '1 / -1' }}>{p.paramExtra}</div>}
                  </>
                ) : (
                  <>
                    <Field label="Horizon (days)"><NumberInput value={p.horizon ?? 0} onChange={v => p.setHorizon?.(+v)} step={1} min={1} /></Field>
                    <Field label="Simulations"><NumberInput value={p.nSims ?? 0} onChange={v => p.setNSims?.(+v)} step={1} min={1} /></Field>
                    <Field label="Benchmark"><input value={p.benchmark} onChange={e => p.setBenchmark(e.target.value.toUpperCase())} onFocus={focusOn} onBlur={focusOff} style={inputBase} /></Field>
                    <Field label="Leverage (x)"><NumberInput value={p.leverage} onChange={p.setLeverage} step={0.25} min={1} /></Field>
                    <div style={{ gridColumn: '1 / -1' }}>
                      <Field label="Target Endpoint ($)"><NumberInput value={p.targetPrice || ''} onChange={v => p.setTargetPrice?.(v === '' ? 0 : +v)} placeholder="e.g. 120 = +20%" /></Field>
                    </div>
                    {p.paramExtra && <div style={{ gridColumn: '1 / -1' }}>{p.paramExtra}</div>}
                  </>
                )}
              </div>
              {isBT && (Number(p.leverage) || 1) > 1 && (
                // Borrow Rate took the 4th cell above, so Benchmark drops below.
                <div style={{ marginTop: 8 }}>
                  <Field label="Benchmark"><input value={p.benchmark} onChange={e => p.setBenchmark(e.target.value.toUpperCase())} onFocus={focusOn} onBlur={focusOff} style={inputBase} /></Field>
                </div>
              )}
            </div>

            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ ...SECTION, color: T.primary }}>Risk Controls</span>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {RISK_PRESETS.map(preset => (
                  <button key={preset.label} type="button"
                    onClick={() => { p.sl.set(preset.sl); p.tp.set(preset.tp); p.trail.set(preset.trail); p.pos.set(preset.pos) }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 18%, transparent)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)')}
                    style={{ background: 'color-mix(in srgb, var(--theme-primary, #c9a84c) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: T.primary, fontFamily: T.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.07em', padding: '3px 7px', cursor: 'pointer', borderRadius: 2 }}>
                    {preset.label.toUpperCase()}
                  </button>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                {riskFields.map(({ label, f, ph }) => (
                  <Field key={label} label={label}>
                    <NumberInput value={f.val} onChange={f.set} placeholder={ph} min={0} step={1} />
                  </Field>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
