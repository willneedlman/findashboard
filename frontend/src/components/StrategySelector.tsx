import { useState, useRef, useEffect } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import CustomStrategyModal, { type CustomStrategyDef } from './CustomStrategyModal'
import { loadCustomStrategies, saveCustomStrategy, deleteCustomStrategy } from '../utils/customStrategies'

export const CUSTOM_STRATEGY_KEY = "Custom Rule Strategy"

export const STRATEGIES = [
  "None (Base GBM / Buy & Hold)",
  "SMA Trend Following (50/200)",
  "RSI Mean Reversion (14)",
  "6-Month Price Momentum",
  "Bollinger Breakout (20,2)",
  "MACD Crossover (12,26,9)",
  "Value — Trailing P/E",
  "Earnings Growth Momentum",
  "EMA Micro-Scalp (3/8)",
  CUSTOM_STRATEGY_KEY,
]

export interface StrategyParams {
  sma_fast?: number; sma_slow?: number; bull_drift_adj?: number; bear_drift_adj?: number
  rsi_period?: number; overbought?: number; oversold?: number; ob_drift_adj?: number; os_drift_adj?: number
  lookback_days?: number; threshold_pct?: number; adj_scale?: number; adj_cap?: number
  pe_deep_value?: number; pe_fair_value?: number; pe_in_threshold?: number; pe_expensive?: number
  exit_threshold_pct?: number
  bb_period?: number; bb_std?: number
  macd_fast?: number; macd_slow?: number; macd_signal?: number
  ema_fast?: number; ema_slow?: number; atr_period?: number; atr_mult?: number
  // Encoded CustomStrategyDef when strategy === CUSTOM_STRATEGY_KEY
  _custom_def?: string
}

const STRATEGY_DESC: Record<string, string> = {
  "None (Base GBM / Buy & Hold)":  "Baseline — no filter applied, pure buy-and-hold returns.",
  "SMA Trend Following (50/200)":  "Buy on Golden Cross (50d > 200d), exit on Death Cross. Boosts drift in uptrend, penalises in downtrend.",
  "RSI Mean Reversion (14)":       "Mean reversion — boost drift when RSI is oversold (<30), penalise when overbought (>70).",
  "6-Month Price Momentum":        "Momentum — adjust drift proportionally to 6-month price return. Ride winners, step out of losers.",
  "Bollinger Breakout (20,2)":     "Enter long on upper-band breakout (price > BB+2σ). Exit when price falls below lower band. Drift boost while in trade.",
  "MACD Crossover (12,26,9)":      "MACD crossover — buy when MACD line crosses above signal line, sell on cross below. Trend + momentum.",
  "Value — Trailing P/E":          "Value — full drift when P/E is cheap, step to cash and penalise when P/E is expensive.",
  "Earnings Growth Momentum":      "Earnings — stay invested when EPS grows YoY, exit and penalise when earnings decline.",
  "EMA Micro-Scalp (3/8)":          "Very short-term EMA(3)/EMA(8) crossover scalp. Enter on bullish cross, exit on bearish cross. Generates many signals — best on volatile assets.",
  [CUSTOM_STRATEGY_KEY]:           "Build your own strategy using visual indicator rules — RSI, SMA, EMA, MACD, Bollinger Bands, ATR, and more.",
}

const DEFAULT_PARAMS: Record<string, StrategyParams> = {
  "SMA Trend Following (50/200)": { sma_fast: 50, sma_slow: 200, bull_drift_adj: 6, bear_drift_adj: -6 },
  "RSI Mean Reversion (14)":       { rsi_period: 14, overbought: 70, oversold: 30, ob_drift_adj: -7, os_drift_adj: 7 },
  "6-Month Price Momentum":         { lookback_days: 126, threshold_pct: 0, adj_scale: 0.25, adj_cap: 8 },
  "Bollinger Breakout (20,2)":      { bb_period: 20, bb_std: 2.0, bull_drift_adj: 5, bear_drift_adj: -3 },
  "MACD Crossover (12,26,9)":       { macd_fast: 12, macd_slow: 26, macd_signal: 9, bull_drift_adj: 5, bear_drift_adj: -4 },
  "Value — Trailing P/E":           { pe_deep_value: 12, pe_fair_value: 20, pe_in_threshold: 35, pe_expensive: 50, bull_drift_adj: 6, bear_drift_adj: -6 },
  "Earnings Growth Momentum":       { exit_threshold_pct: -5, adj_scale: 60, adj_cap: 10 },
  "EMA Micro-Scalp (3/8)":           { ema_fast: 3, ema_slow: 8, atr_period: 5, atr_mult: 0.3, bull_drift_adj: 8, bear_drift_adj: -5 },
}

interface Props {
  value: string
  params: StrategyParams
  onChange: (strategy: string, params: StrategyParams) => void
  compact?: boolean
}

// ── Standard (full-width) sub-components ────────────────────────────────────

function Num({ label, value, step, min, max, help, onChange }: {
  label: string; value: number; step: number; min?: number; max?: number; help?: string
  onChange: (v: number) => void
}) {
  return (
    <div>
      <label className="label-sm block mb-1">{label}</label>
      <input type="number" className="input-field" value={value} step={step} min={min} max={max}
        onChange={e => onChange(+e.target.value)} />
      {help && <p className="text-slate-terminal text-[10px] mt-1 leading-snug">{help}</p>}
    </div>
  )
}

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-3 p-3 rounded border border-accent-blue/30 bg-accent-blue/5 text-xs text-slate-bright leading-relaxed space-y-1.5">
      {children}
    </div>
  )
}

function Rule({ tag, children }: { tag: string; children: React.ReactNode }) {
  const colors: Record<string, string> = {
    'BUY': 'text-emerald-400', 'HOLD': 'text-gold',
    'SELL': 'text-red-400',    'NOTE': 'text-slate-terminal',
    'WEAK': 'text-amber-400',
  }
  return (
    <p>
      <span className={`font-bold mr-2 text-[10px] tracking-widest ${colors[tag] ?? 'text-slate-terminal'}`}>
        [{tag}]
      </span>
      {children}
    </p>
  )
}

// ── Compact (sidebar) sub-components ────────────────────────────────────────

const C_INPUT: React.CSSProperties = {
  // Gold-tinted border to match the ticker/weight inputs (Compare aesthetic).
  background: 'var(--theme-bg, #0a1628)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: 'var(--theme-text, #d7e3fc)',
  fontFamily: 'var(--theme-mono)', fontSize: 11, padding: '4px 6px',
  width: '100%', outline: 'none', boxSizing: 'border-box',
}
const C_LABEL: React.CSSProperties = {
  fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
  textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)', marginBottom: 3, display: 'block',
}

function CNum({ label, value, step, min, max, help, onChange }: {
  label: string; value: number; step: number; min?: number; max?: number; help?: string
  onChange: (v: number) => void
}) {
  const [showTip, setShowTip] = useState(false)
  const focus = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'var(--theme-primary, #c9a84c)')
  const blur  = (e: React.FocusEvent<HTMLInputElement>) => (e.target.style.borderColor = 'color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)')
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-secondary, #99907e)' }}>
          {label}
        </span>
        {help && (
          <span
            style={{ fontSize: 10, color: 'var(--theme-text-faint, var(--theme-text-faint, rgba(255,255,255,0.22)))', cursor: 'help', lineHeight: 1, flexShrink: 0 }}
            onMouseEnter={() => setShowTip(true)}
            onMouseLeave={() => setShowTip(false)}
          >ⓘ</span>
        )}
      </div>
      {showTip && help && (
        <div style={{
          position: 'absolute', bottom: '100%', left: 0, marginBottom: 4, zIndex: 50,
          background: 'var(--theme-bg, #0a1628)', border: '1px solid var(--theme-border, rgba(255,255,255,0.10))', padding: '6px 8px',
          width: 190, fontSize: 10, color: 'var(--theme-text, #d7e3fc)', lineHeight: '14px', pointerEvents: 'none',
        }}>
          {help}
        </div>
      )}
      <input type="number" style={C_INPUT} value={value} step={step} min={min} max={max}
        onChange={e => onChange(+e.target.value)} onFocus={focus} onBlur={blur} />
    </div>
  )
}

function CRule({ tag, children }: { tag: string; children: React.ReactNode }) {
  const color: Record<string, string> = {
    BUY: '#4caf7d', HOLD: 'var(--theme-primary, #c9a84c)', SELL: '#e05c6e', NOTE: 'var(--theme-text-faint, rgba(255,255,255,0.18))', WEAK: '#d97736',
  }
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
      <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: color[tag] ?? '#4d4637', flexShrink: 0 }}>
        [{tag}]
      </span>
      <span style={{ fontSize: 10, color: 'var(--theme-secondary, #99907e)', lineHeight: '13px' }}>{children}</span>
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

// Prefix for saved custom strategies in the <select> value, invisible to parents
const SAVED_PREFIX = '__saved__:'

export default function StrategySelector({ value, params, onChange, compact }: Props) {
  const [open, setOpen] = useState(false)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [savedCustoms, setSavedCustoms] = useState<CustomStrategyDef[]>(loadCustomStrategies)
  const [editingDef, setEditingDef] = useState<CustomStrategyDef | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!dropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node))
        setDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dropdownOpen])

  const currentCustomDef: CustomStrategyDef | null = (() => {
    try { return params._custom_def ? JSON.parse(params._custom_def) : null } catch { return null }
  })()

  const activeSavedName = currentCustomDef?.name ?? null

  const applyCustomDef = (def: CustomStrategyDef) => {
    onChange(CUSTOM_STRATEGY_KEY, { _custom_def: JSON.stringify(def) })
    setOpen(true)
  }

  const setStrategy = (s: string) => {
    if (s === CUSTOM_STRATEGY_KEY) {
      setEditingDef(null)
      setModalOpen(true)
      return
    }
    if (s.startsWith(SAVED_PREFIX)) {
      const name = s.slice(SAVED_PREFIX.length)
      const def = savedCustoms.find(d => d.name === name)
      if (def) applyCustomDef(def)
      return
    }
    onChange(s, DEFAULT_PARAMS[s] ?? {})
    setOpen(s !== STRATEGIES[0])
  }

  const handleCustomSave = (def: CustomStrategyDef) => {
    saveCustomStrategy(def)
    setSavedCustoms(loadCustomStrategies())
    applyCustomDef(def)
    setModalOpen(false)
  }

  const handleDeleteSaved = (name: string, e: React.MouseEvent) => {
    e.stopPropagation()
    deleteCustomStrategy(name)
    setSavedCustoms(loadCustomStrategies())
    if (activeSavedName === name) onChange(STRATEGIES[0], {})
  }

  const setParam = (key: keyof StrategyParams, val: number) =>
    onChange(value, { ...params, [key]: val })

  const p = { ...DEFAULT_PARAMS[value], ...params }

  // ── Compact (sidebar) layout ─────────────────────────────────────────────
  if (compact) {
    return (
      <div>
        {/* Custom dropdown with descriptions */}
        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setDropdownOpen(o => !o)}
            style={{
              ...C_INPUT, cursor: 'pointer', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', gap: 4, textAlign: 'left',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {value === CUSTOM_STRATEGY_KEY && activeSavedName ? activeSavedName : value}
            </span>
            <ChevronDown size={11} style={{ flexShrink: 0, color: 'var(--theme-secondary, #99907e)' }} />
          </button>

          {dropdownOpen && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
              background: 'var(--theme-bg, #0a1628)', border: '1px solid var(--theme-border, rgba(255,255,255,0.10))', marginTop: 1,
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            }}>
              {STRATEGIES.map(s => (
                <button
                  key={s}
                  onClick={() => { setStrategy(s); setDropdownOpen(false) }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    background: s === value && !(s === CUSTOM_STRATEGY_KEY && activeSavedName) ? 'var(--theme-surface, #142032)' : 'none',
                    border: 'none', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
                    padding: '7px 9px', cursor: 'pointer',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#0f1e30' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'none' }}
                >
                  <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: s === value && !(s === CUSTOM_STRATEGY_KEY && activeSavedName) ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text, #d7e3fc)', marginBottom: 2 }}>
                    {s}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', lineHeight: '12px', letterSpacing: '0.03em' }}>
                    {STRATEGY_DESC[s]}
                  </div>
                </button>
              ))}
              {savedCustoms.length > 0 && (
                <>
                  <div style={{ padding: '5px 9px 3px', fontSize: 8, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--theme-primary, #c9a84c)', background: 'rgba(201,168,76,0.06)', borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))', fontFamily: 'var(--theme-mono)' }}>
                    Saved Custom
                  </div>
                  {savedCustoms.map(def => {
                    const isActive = value === CUSTOM_STRATEGY_KEY && activeSavedName === def.name
                    const buyCount = def.buy.groups.reduce((s, g) => s + g.conditions.length, 0)
                    const sellCount = def.sell.groups.reduce((s, g) => s + g.conditions.length, 0)
                    return (
                      <div
                        key={def.name}
                        onClick={() => { setStrategy(SAVED_PREFIX + def.name); setDropdownOpen(false) }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '6px 9px', cursor: 'pointer',
                          background: isActive ? 'var(--theme-surface, #142032)' : 'none',
                          borderBottom: '1px solid var(--theme-border, rgba(255,255,255,0.06))',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#0f1e30' }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isActive ? 'var(--theme-surface, #142032)' : 'none' }}
                      >
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 11, color: isActive ? 'var(--theme-primary, #c9a84c)' : 'var(--theme-text, #d7e3fc)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {def.name}
                          </div>
                          <div style={{ fontSize: 9, color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', lineHeight: '12px' }}>
                            B:{buyCount} S:{sellCount}
                          </div>
                        </div>
                        <button
                          onClick={e => handleDeleteSaved(def.name, e)}
                          style={{ background: 'none', border: 'none', color: 'rgba(239,68,68,0.5)', cursor: 'pointer', fontSize: 13, padding: '0 2px', flexShrink: 0 }}
                          title="Remove from library"
                        >×</button>
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          )}
        </div>

        <div style={{ fontSize: 10, color: 'var(--theme-text-faint, var(--theme-text-faint, rgba(255,255,255,0.22)))', marginTop: 5, lineHeight: '13px' }}>
          {STRATEGY_DESC[value]}
        </div>

        {value !== STRATEGIES[0] && (
          <>
            <button
              onClick={() => setOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, marginTop: 6,
                fontSize: 10, color: 'var(--theme-primary, #c9a84c)', background: 'none', border: 'none',
                cursor: 'pointer', padding: 0, letterSpacing: '0.08em',
              }}
            >
              {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              {open ? 'Hide' : 'Show'} parameters
            </button>

            {open && (
              <div style={{ marginTop: 8, borderTop: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.08)))', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>

                {value === "SMA Trend Following (50/200)" && (<>
                  <CNum label="Fast SMA (days)" value={p.sma_fast!} step={5} min={5} max={100} onChange={v => setParam('sma_fast', v)}
                    help="Short moving average — reacts quickly to price changes. Common values: 20 or 50 days." />
                  <CNum label="Slow SMA (days)" value={p.sma_slow!} step={10} min={50} max={400} onChange={v => setParam('sma_slow', v)}
                    help="Long moving average — reflects the broader trend. Must be greater than the Fast SMA." />
                  <CNum label="Bull drift adj (%)" value={p.bull_drift_adj!} step={0.5} min={0} max={15} onChange={v => setParam('bull_drift_adj', v)}
                    help="Extra annualised drift added when the Golden Cross is active (fast SMA above slow SMA)." />
                  <CNum label="Bear drift adj (%)" value={p.bear_drift_adj!} step={0.5} max={0} min={-15} onChange={v => setParam('bear_drift_adj', v)}
                    help="Drift penalty during a Death Cross (fast SMA below slow SMA). Keep this negative." />
                  <div style={{ borderTop: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))', paddingTop: 6 }}>
                    <CRule tag="BUY">Price above both SMAs — drift +{p.bull_drift_adj}%/yr.</CRule>
                    <CRule tag="SELL">Death Cross — drift {p.bear_drift_adj}%/yr.</CRule>
                    <CRule tag="NOTE">Weak signals get a partial adjustment.</CRule>
                  </div>
                </>)}

                {value === "RSI Mean Reversion (14)" && (<>
                  <CNum label="RSI period (days)" value={p.rsi_period!} step={1} min={5} max={30} onChange={v => setParam('rsi_period', v)}
                    help="Lookback window for RSI calculation. 14 is standard. Lower = noisier signals; higher = smoother." />
                  <CNum label="Overbought level" value={p.overbought!} step={1} min={55} max={90} onChange={v => setParam('overbought', v)}
                    help="RSI above this signals the asset has risen too fast — drift penalty is applied to reflect likely pullback." />
                  <CNum label="Oversold level" value={p.oversold!} step={1} min={10} max={45} onChange={v => setParam('oversold', v)}
                    help="RSI below this signals the asset has fallen hard — drift boost is applied to reflect likely bounce." />
                  <CNum label="Overbought drift adj (%)" value={p.ob_drift_adj!} step={0.5} max={0} min={-15} onChange={v => setParam('ob_drift_adj', v)}
                    help="Drift penalty when RSI is overbought. Keep negative — a high RSI suggests mean reversion risk." />
                  <CNum label="Oversold drift adj (%)" value={p.os_drift_adj!} step={0.5} min={0} max={15} onChange={v => setParam('os_drift_adj', v)}
                    help="Drift boost when RSI is oversold. Keep positive — a low RSI suggests a likely recovery." />
                  <div style={{ borderTop: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))', paddingTop: 6 }}>
                    <CRule tag="BUY">RSI &lt; {p.oversold} → +{p.os_drift_adj}% drift.</CRule>
                    <CRule tag="SELL">RSI &gt; {p.overbought} → {p.ob_drift_adj}% drift.</CRule>
                    <CRule tag="HOLD">RSI {p.oversold}–{p.overbought} — no adjustment.</CRule>
                  </div>
                </>)}

                {value === "6-Month Price Momentum" && (<>
                  <CNum label="Lookback (days)" value={p.lookback_days!} step={5} min={21} max={252} onChange={v => setParam('lookback_days', v)}
                    help="How far back to measure price return. 126 ≈ 6 months, 252 = 1 year. Longer windows smooth out noise." />
                  <CNum label="Entry threshold (%)" value={p.threshold_pct!} step={0.5} min={-20} max={20} onChange={v => setParam('threshold_pct', v)}
                    help="Minimum return over the lookback window to stay invested. 0% = any positive momentum qualifies." />
                  <CNum label="Drift sensitivity" value={p.adj_scale!} step={0.05} min={0.05} max={0.5} onChange={v => setParam('adj_scale', v)}
                    help="Scales how strongly momentum converts into a drift adjustment. 0.25 means a 20% return → +5% drift." />
                  <CNum label="Max drift adj (%)" value={p.adj_cap!} step={0.5} min={1} max={20} onChange={v => setParam('adj_cap', v)}
                    help="Hard cap on the drift adjustment in either direction. Prevents extreme momentum from dominating." />
                  <div style={{ borderTop: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))', paddingTop: 6 }}>
                    <CRule tag="BUY">{p.lookback_days}d return &gt; {p.threshold_pct}% → up to +{p.adj_cap}%.</CRule>
                    <CRule tag="SELL">Return &lt; {p.threshold_pct}% → up to -{p.adj_cap}%.</CRule>
                  </div>
                </>)}

                {value === "Bollinger Breakout (20,2)" && (<>
                  <CNum label="BB Period (days)" value={p.bb_period!} step={1} min={5} max={50} onChange={v => setParam('bb_period', v)}
                    help="Lookback for BB midline (SMA) and standard deviation. 20 is standard." />
                  <CNum label="Std Dev multiplier" value={p.bb_std!} step={0.1} min={1} max={4} onChange={v => setParam('bb_std', v)}
                    help="Width of the bands. 2.0 means ±2 standard deviations. Higher = fewer but stronger signals." />
                  <CNum label="Bull drift adj (%)" value={p.bull_drift_adj!} step={0.5} min={0} max={15} onChange={v => setParam('bull_drift_adj', v)}
                    help="Drift boost while in an active breakout trade." />
                  <CNum label="Bear drift adj (%)" value={p.bear_drift_adj!} step={0.5} max={0} min={-10} onChange={v => setParam('bear_drift_adj', v)}
                    help="Drift penalty when not in a breakout (in cash)." />
                  <div style={{ borderTop: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))', paddingTop: 6 }}>
                    <CRule tag="BUY">Price closes above upper band → enter long, drift +{p.bull_drift_adj}%.</CRule>
                    <CRule tag="SELL">Price falls below lower band → exit to cash, drift {p.bear_drift_adj}%.</CRule>
                  </div>
                </>)}

                {value === "MACD Crossover (12,26,9)" && (<>
                  <CNum label="Fast EMA (days)" value={p.macd_fast!} step={1} min={3} max={30} onChange={v => setParam('macd_fast', v)}
                    help="Short exponential moving average period. Default 12." />
                  <CNum label="Slow EMA (days)" value={p.macd_slow!} step={1} min={10} max={60} onChange={v => setParam('macd_slow', v)}
                    help="Long exponential moving average period. Default 26." />
                  <CNum label="Signal EMA (days)" value={p.macd_signal!} step={1} min={3} max={20} onChange={v => setParam('macd_signal', v)}
                    help="EMA of the MACD line — acts as the trigger line. Default 9." />
                  <CNum label="Bull drift adj (%)" value={p.bull_drift_adj!} step={0.5} min={0} max={15} onChange={v => setParam('bull_drift_adj', v)}
                    help="Drift boost when MACD line is above the signal line." />
                  <CNum label="Bear drift adj (%)" value={p.bear_drift_adj!} step={0.5} max={0} min={-15} onChange={v => setParam('bear_drift_adj', v)}
                    help="Drift penalty when MACD line is below the signal line." />
                  <div style={{ borderTop: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))', paddingTop: 6 }}>
                    <CRule tag="BUY">MACD above signal → bullish crossover, drift +{p.bull_drift_adj}%.</CRule>
                    <CRule tag="SELL">MACD below signal → bearish crossover, drift {p.bear_drift_adj}%.</CRule>
                  </div>
                </>)}

                {value === "Value — Trailing P/E" && (<>
                  <CNum label="Deep value P/E" value={p.pe_deep_value!} step={1} min={1} max={25} onChange={v => setParam('pe_deep_value', v)}
                    help="P/E below this is considered deep value — maximum bullish drift is applied. Historically below 10–15 is cheap." />
                  <CNum label="Fair value P/E" value={p.pe_fair_value!} step={1} min={5} max={50} onChange={v => setParam('pe_fair_value', v)}
                    help="P/E below this is fairly valued — half the bullish drift is applied. S&P 500 long-run average is ~15–20." />
                  <CNum label="Exit above P/E" value={p.pe_in_threshold!} step={1} min={10} max={100} onChange={v => setParam('pe_in_threshold', v)}
                    help="Step to cash and apply bearish drift when trailing P/E exceeds this. Stock is considered expensive." />
                  <CNum label="Very expensive P/E" value={p.pe_expensive!} step={5} min={20} max={200} onChange={v => setParam('pe_expensive', v)}
                    help="P/E above this triggers the maximum bearish drift penalty. Represents extreme overvaluation." />
                  <CNum label="Bull drift adj (%)" value={p.bull_drift_adj!} step={0.5} min={0} max={15} onChange={v => setParam('bull_drift_adj', v)}
                    help="Drift boost added when P/E is in deep-value or fair-value territory. Keep positive." />
                  <CNum label="Bear drift adj (%)" value={p.bear_drift_adj!} step={0.5} max={0} min={-15} onChange={v => setParam('bear_drift_adj', v)}
                    help="Drift penalty when P/E is expensive. Keep this negative to reflect overvaluation risk." />
                  <div style={{ borderTop: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))', paddingTop: 6 }}>
                    <CRule tag="BUY">P/E &lt; {p.pe_deep_value} → +{p.bull_drift_adj}%/yr.</CRule>
                    <CRule tag="HOLD">P/E {p.pe_deep_value}–{p.pe_in_threshold} → partial or none.</CRule>
                    <CRule tag="SELL">P/E &gt; {p.pe_expensive} → {p.bear_drift_adj}%/yr.</CRule>
                  </div>
                </>)}

                {value === "Earnings Growth Momentum" && (<>
                  <CNum label="Exit when EPS growth below (%)" value={p.exit_threshold_pct!} step={0.5} min={-30} max={0} onChange={v => setParam('exit_threshold_pct', v)}
                    help="Step to cash when quarterly EPS growth (year-over-year) falls below this. -5% means exit if earnings are down more than 5%." />
                  <CNum label="Drift sensitivity" value={p.adj_scale!} step={5} min={10} max={120} onChange={v => setParam('adj_scale', v)}
                    help="Multiplies EPS growth rate into a drift adjustment. E.g. sensitivity 60 × 10% EPS growth = +6% drift boost." />
                  <CNum label="Max drift adj (%)" value={p.adj_cap!} step={0.5} min={1} max={20} onChange={v => setParam('adj_cap', v)}
                    help="Hard cap on the drift adjustment in either direction. Prevents extreme EPS swings from dominating." />
                  <div style={{ borderTop: '1px solid var(--theme-border, var(--theme-border, rgba(255,255,255,0.06)))', paddingTop: 6 }}>
                    <CRule tag="BUY">EPS growth &gt; {p.exit_threshold_pct}% → up to +{p.adj_cap}%.</CRule>
                    <CRule tag="SELL">EPS growth &lt; {p.exit_threshold_pct}% → up to -{p.adj_cap}%.</CRule>
                    <CRule tag="NOTE">Uses live Yahoo Finance data.</CRule>
                  </div>
                </>)}

                {value === "EMA Micro-Scalp (3/8)" && (<>
                  <CNum label="Fast EMA (days)" value={p.ema_fast!} step={1} min={2} max={10} onChange={v => setParam('ema_fast', v)}
                    help="Very short EMA — reacts within days. Default 3. Lower = more signals but more noise." />
                  <CNum label="Slow EMA (days)" value={p.ema_slow!} step={1} min={4} max={30} onChange={v => setParam('ema_slow', v)}
                    help="Reference EMA trend baseline. Default 8. Must be greater than Fast EMA." />
                  <CNum label="ATR period" value={p.atr_period!} step={1} min={2} max={20} onChange={v => setParam('atr_period', v)}
                    help="Bars used to compute Average True Range. Filters out low-volatility noise." />
                  <CNum label="Min ATR % (0=off)" value={p.atr_mult!} step={0.1} min={0} max={2} onChange={v => setParam('atr_mult', v)}
                    help="Skip signals when ATR is below this % of price. 0 disables the filter. 0.3 requires the stock to move at least 0.3% per bar on average." />
                  <CNum label="Bull drift adj (%)" value={p.bull_drift_adj!} step={0.5} min={0} max={20} onChange={v => setParam('bull_drift_adj', v)}
                    help="Drift boost when EMA(fast) is above EMA(slow)." />
                  <CNum label="Bear drift adj (%)" value={p.bear_drift_adj!} step={0.5} max={0} min={-15} onChange={v => setParam('bear_drift_adj', v)}
                    help="Drift penalty when EMA(fast) is below EMA(slow). Keep negative." />
                  <div style={{ borderTop: '1px solid var(--theme-border, rgba(255,255,255,0.06))', paddingTop: 6 }}>
                    <CRule tag="BUY">EMA({p.ema_fast}) crosses above EMA({p.ema_slow}) — enter, drift +{p.bull_drift_adj}%.</CRule>
                    <CRule tag="SELL">EMA({p.ema_fast}) crosses below EMA({p.ema_slow}) — exit, drift {p.bear_drift_adj}%.</CRule>
                    <CRule tag="NOTE">ATR filter active when Min ATR &gt; 0. Very active strategy — many round trips.</CRule>
                  </div>
                </>)}

                {value === CUSTOM_STRATEGY_KEY && (
                  <div>
                    {currentCustomDef ? (
                      <div style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-secondary, #99907e)', marginBottom: 6, lineHeight: '14px' }}>
                        <span style={{ color: 'var(--theme-primary, #c9a84c)', fontWeight: 700 }}>{currentCustomDef.name}</span>
                        {' · '}BUY: {currentCustomDef.buy.groups.reduce((s, g) => s + g.conditions.length, 0)} condition{currentCustomDef.buy.groups.reduce((s, g) => s + g.conditions.length, 0) !== 1 ? 's' : ''} in {currentCustomDef.buy.groups.length} group{currentCustomDef.buy.groups.length !== 1 ? 's' : ''}
                        {' · '}SELL: {currentCustomDef.sell.groups.reduce((s, g) => s + g.conditions.length, 0)} condition{currentCustomDef.sell.groups.reduce((s, g) => s + g.conditions.length, 0) !== 1 ? 's' : ''} in {currentCustomDef.sell.groups.length} group{currentCustomDef.sell.groups.length !== 1 ? 's' : ''}
                        {' · '}drift {currentCustomDef.bull_drift > 0 ? '+' : ''}{currentCustomDef.bull_drift}% / {currentCustomDef.bear_drift}%
                      </div>
                    ) : (
                      <div style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', color: 'var(--theme-text-faint, rgba(255,255,255,0.22))', marginBottom: 6 }}>
                        No rules defined yet — click Edit to build your strategy.
                      </div>
                    )}
                    <button
                      onClick={() => { setEditingDef(currentCustomDef); setModalOpen(true) }}
                      style={{ fontSize: 9, fontFamily: 'var(--theme-mono)', cursor: 'pointer',
                        background: 'none', border: '1px solid var(--theme-primary, #c9a84c)',
                        color: 'var(--theme-primary, #c9a84c)', padding: '3px 10px', letterSpacing: '0.08em' }}
                    >{currentCustomDef ? 'Edit Rules' : 'Build Rules'}</button>
                  </div>
                )}

              </div>
            )}
          </>
        )}
        <CustomStrategyModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onSave={handleCustomSave}
          initialDef={editingDef}
        />
      </div>
    )
  }

  // ── Standard (full-width) layout ─────────────────────────────────────────
  return (
    <div>
      <label className="label-sm block mb-1">Strategy Overlay</label>
      <select
        className="input-field mb-2"
        value={value === CUSTOM_STRATEGY_KEY && activeSavedName ? SAVED_PREFIX + activeSavedName : value}
        onChange={e => setStrategy(e.target.value)}
      >
        {STRATEGIES.map(s => <option key={s} value={s}>{s}</option>)}
        {savedCustoms.length > 0 && (
          <optgroup label="── Saved Custom ──">
            {savedCustoms.map(def => (
              <option key={def.name} value={SAVED_PREFIX + def.name}>{def.name}</option>
            ))}
          </optgroup>
        )}
      </select>

      {/* Always-visible description */}
      <p className="text-slate-terminal text-xs mb-3">
        {value === CUSTOM_STRATEGY_KEY && activeSavedName
          ? `Custom strategy: "${activeSavedName}" — ${STRATEGY_DESC[CUSTOM_STRATEGY_KEY]}`
          : (STRATEGY_DESC[value] ?? '')}
      </p>

      {value !== STRATEGIES[0] && (
        <>
          <button onClick={() => setOpen(o => !o)}
            className="flex items-center gap-1.5 text-xs text-gold hover:text-gold/80 transition-colors mb-3">
            {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {open ? 'Hide' : 'Show'} parameters & how it works
          </button>

          {open && (
            <div className="space-y-4 border-t border-white/7 pt-3">

              {value === "SMA Trend Following (50/200)" && (<>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Num label="Fast SMA (days)" value={p.sma_fast!} step={5} min={5} max={100}
                    help="Short moving average — reacts quickly to recent price changes. Common: 20, 50."
                    onChange={v => setParam('sma_fast', v)} />
                  <Num label="Slow SMA (days)" value={p.sma_slow!} step={10} min={50} max={400}
                    help="Long moving average — reflects the broader trend. Must be greater than Fast SMA."
                    onChange={v => setParam('sma_slow', v)} />
                  <Num label="Bull drift adj (%)" value={p.bull_drift_adj!} step={0.5} min={0} max={15}
                    help="Extra annualised drift added to GBM when in an uptrend (Golden Cross)."
                    onChange={v => setParam('bull_drift_adj', v)} />
                  <Num label="Bear drift adj (%)" value={p.bear_drift_adj!} step={0.5} max={0} min={-15}
                    help="Drift penalty applied when in a downtrend (Death Cross). Keep negative."
                    onChange={v => setParam('bear_drift_adj', v)} />
                </div>
                <InfoBox>
                  <Rule tag="BUY">Price above {p.sma_fast}-day AND {p.sma_fast}-day above {p.sma_slow}-day (Golden Cross). Drift boosted by +{p.bull_drift_adj}%/yr.</Rule>
                  <Rule tag="WEAK">Price above {p.sma_slow}-day but {p.sma_fast}-day not yet above. Half boost (+{((p.bull_drift_adj ?? 0) * 0.4).toFixed(1)}%/yr).</Rule>
                  <Rule tag="SELL">{p.sma_fast}-day crosses below {p.sma_slow}-day (Death Cross). Drift penalised by {p.bear_drift_adj}%/yr.</Rule>
                  <Rule tag="NOTE">Weak downtrend applies a reduced {((p.bear_drift_adj ?? 0) * 0.4).toFixed(1)}% penalty.</Rule>
                </InfoBox>
              </>)}

              {value === "RSI Mean Reversion (14)" && (<>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <Num label="RSI period (days)" value={p.rsi_period!} step={1} min={5} max={30}
                    help="14 is standard. Lower = more sensitive and noisier. Higher = smoother signals."
                    onChange={v => setParam('rsi_period', v)} />
                  <Num label="Overbought level" value={p.overbought!} step={1} min={55} max={90}
                    help="RSI above this means the stock has risen too fast. Signal steps toward cash."
                    onChange={v => setParam('overbought', v)} />
                  <Num label="Oversold level" value={p.oversold!} step={1} min={10} max={45}
                    help="RSI below this means the stock has fallen hard. Signal re-enters position."
                    onChange={v => setParam('oversold', v)} />
                  <Num label="Overbought drift adj (%)" value={p.ob_drift_adj!} step={0.5} max={0} min={-15}
                    help="Drift penalty when RSI is overbought. Keep negative to reflect mean-reversion risk."
                    onChange={v => setParam('ob_drift_adj', v)} />
                  <Num label="Oversold drift adj (%)" value={p.os_drift_adj!} step={0.5} min={0} max={15}
                    help="Drift boost when RSI is oversold. Keep positive to reflect likely bounce."
                    onChange={v => setParam('os_drift_adj', v)} />
                </div>
                <InfoBox>
                  <Rule tag="HOLD">RSI between {p.oversold} and {p.overbought} — neutral zone, no drift adjustment applied.</Rule>
                  <Rule tag="BUY">RSI drops below {p.oversold} (oversold): +{p.os_drift_adj}% drift boost. Works best in range-bound markets.</Rule>
                  <Rule tag="SELL">RSI rises above {p.overbought} (overbought): {p.ob_drift_adj}% drift penalty. Severely overbought gets the full penalty; mildly overbought gets 43%.</Rule>
                </InfoBox>
              </>)}

              {value === "6-Month Price Momentum" && (<>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Num label="Lookback (days)" value={p.lookback_days!} step={5} min={21} max={252}
                    help="126 days is approximately 6 months. 252 is one year. Longer windows capture larger trends."
                    onChange={v => setParam('lookback_days', v)} />
                  <Num label="Entry threshold (%)" value={p.threshold_pct!} step={0.5} min={-20} max={20}
                    help="Minimum return over the lookback period required to stay invested. 0% = any positive momentum."
                    onChange={v => setParam('threshold_pct', v)} />
                  <Num label="Drift sensitivity" value={p.adj_scale!} step={0.05} min={0.05} max={0.5}
                    help="Scales how strongly momentum translates into a drift adjustment. 0.25 means a 20% return adds +5% drift."
                    onChange={v => setParam('adj_scale', v)} />
                  <Num label="Max drift adj (%)" value={p.adj_cap!} step={0.5} min={1} max={20}
                    help="Maximum absolute drift adjustment allowed in either direction. Prevents extreme momentum dominating."
                    onChange={v => setParam('adj_cap', v)} />
                </div>
                <InfoBox>
                  <Rule tag="BUY">{p.lookback_days}-day return above {p.threshold_pct}%. Drift boosted proportionally, capped at +{p.adj_cap}%/yr.</Rule>
                  <Rule tag="SELL">{p.lookback_days}-day return below {p.threshold_pct}%. Drift penalised symmetrically, capped at -{p.adj_cap}%/yr.</Rule>
                  <Rule tag="NOTE">Signal resets daily — switches back as soon as momentum recovers above the threshold.</Rule>
                </InfoBox>
              </>)}

              {value === "Bollinger Breakout (20,2)" && (<>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <Num label="BB Period (days)" value={p.bb_period!} step={1} min={5} max={50}
                    help="Lookback for SMA midline and std dev. 20 is standard."
                    onChange={v => setParam('bb_period', v)} />
                  <Num label="Std Dev multiplier" value={p.bb_std!} step={0.1} min={1} max={4}
                    help="Band width. 2.0 = ±2σ. Higher = fewer, stronger signals."
                    onChange={v => setParam('bb_std', v)} />
                  <Num label="Bull drift adj (%)" value={p.bull_drift_adj!} step={0.5} min={0} max={15}
                    help="Drift boost while in an active breakout trade."
                    onChange={v => setParam('bull_drift_adj', v)} />
                  <Num label="Bear drift adj (%)" value={p.bear_drift_adj!} step={0.5} max={0} min={-10}
                    help="Drift penalty while in cash (no breakout)."
                    onChange={v => setParam('bear_drift_adj', v)} />
                </div>
                <InfoBox>
                  <Rule tag="BUY">Price closes above upper band ({p.bb_period}-day SMA +{p.bb_std}σ) → enter long. Drift +{p.bull_drift_adj}%/yr.</Rule>
                  <Rule tag="SELL">Price falls below lower band → exit to cash. Drift {p.bear_drift_adj}%/yr.</Rule>
                  <Rule tag="NOTE">Trade persists until lower-band breach — no stop-loss unless you add one via risk controls.</Rule>
                </InfoBox>
              </>)}

              {value === "MACD Crossover (12,26,9)" && (<>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <Num label="Fast EMA (days)" value={p.macd_fast!} step={1} min={3} max={30}
                    help="Short EMA period. Standard: 12."
                    onChange={v => setParam('macd_fast', v)} />
                  <Num label="Slow EMA (days)" value={p.macd_slow!} step={1} min={10} max={60}
                    help="Long EMA period. Standard: 26. Must be greater than Fast."
                    onChange={v => setParam('macd_slow', v)} />
                  <Num label="Signal EMA (days)" value={p.macd_signal!} step={1} min={3} max={20}
                    help="EMA of the MACD line used as the trigger. Standard: 9."
                    onChange={v => setParam('macd_signal', v)} />
                  <Num label="Bull drift adj (%)" value={p.bull_drift_adj!} step={0.5} min={0} max={15}
                    help="Drift boost when MACD is above the signal line."
                    onChange={v => setParam('bull_drift_adj', v)} />
                  <Num label="Bear drift adj (%)" value={p.bear_drift_adj!} step={0.5} max={0} min={-15}
                    help="Drift penalty when MACD is below the signal line."
                    onChange={v => setParam('bear_drift_adj', v)} />
                </div>
                <InfoBox>
                  <Rule tag="BUY">MACD(EMA{p.macd_fast}–EMA{p.macd_slow}) crosses above Signal(EMA{p.macd_signal}). Drift +{p.bull_drift_adj}%/yr.</Rule>
                  <Rule tag="SELL">MACD crosses below Signal line. Drift {p.bear_drift_adj}%/yr.</Rule>
                  <Rule tag="NOTE">Histogram = MACD − Signal. Positive histogram = bullish; negative = bearish.</Rule>
                </InfoBox>
              </>)}

              {value === "Value — Trailing P/E" && (<>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <Num label="Deep value P/E (below)" value={p.pe_deep_value!} step={1} min={1} max={25}
                    help="P/E below this is deep value. Maximum bullish drift applied."
                    onChange={v => setParam('pe_deep_value', v)} />
                  <Num label="Fair value P/E (below)" value={p.pe_fair_value!} step={1} min={5} max={50}
                    help="P/E below this is fairly valued. Half bullish drift."
                    onChange={v => setParam('pe_fair_value', v)} />
                  <Num label="Exit above this P/E" value={p.pe_in_threshold!} step={1} min={10} max={100}
                    help="Step to cash and apply bearish drift when trailing P/E exceeds this."
                    onChange={v => setParam('pe_in_threshold', v)} />
                  <Num label="Very expensive P/E (above)" value={p.pe_expensive!} step={5} min={20} max={200}
                    help="P/E above this level triggers the maximum bearish drift penalty."
                    onChange={v => setParam('pe_expensive', v)} />
                  <Num label="Max bull drift adj (%)" value={p.bull_drift_adj!} step={0.5} min={0} max={15}
                    help="Drift boost added when P/E is in deep-value territory."
                    onChange={v => setParam('bull_drift_adj', v)} />
                  <Num label="Max bear drift adj (%)" value={p.bear_drift_adj!} step={0.5} max={0} min={-15}
                    help="Drift penalty applied when P/E is expensive. Keep negative."
                    onChange={v => setParam('bear_drift_adj', v)} />
                </div>
                <InfoBox>
                  <Rule tag="BUY">P/E below {p.pe_deep_value} (deep value): fully invested, +{p.bull_drift_adj}%/yr drift.</Rule>
                  <Rule tag="HOLD">P/E {p.pe_deep_value}-{p.pe_fair_value} (fair value): invested, +{((p.bull_drift_adj ?? 0) * 0.5).toFixed(1)}%/yr.</Rule>
                  <Rule tag="HOLD">P/E {p.pe_fair_value}-{p.pe_in_threshold} (neutral): invested, no drift adjustment.</Rule>
                  <Rule tag="WEAK">P/E {p.pe_in_threshold}-{p.pe_expensive} (expensive): cash, {((p.bear_drift_adj ?? 0) * 0.5).toFixed(1)}%/yr penalty.</Rule>
                  <Rule tag="SELL">P/E above {p.pe_expensive} (very expensive): cash, {p.bear_drift_adj}%/yr full penalty.</Rule>
                  <Rule tag="NOTE">P/E is a snapshot from live data and does not change day-to-day within a single run.</Rule>
                </InfoBox>
              </>)}

              {value === "Earnings Growth Momentum" && (<>
                <div className="grid grid-cols-3 gap-3">
                  <Num label="Exit when EPS growth below (%)" value={p.exit_threshold_pct!} step={0.5} min={-30} max={0}
                    help="Step to cash when quarterly EPS growth (year-over-year) falls below this."
                    onChange={v => setParam('exit_threshold_pct', v)} />
                  <Num label="Drift sensitivity" value={p.adj_scale!} step={5} min={10} max={120}
                    help="Multiplies the EPS growth rate to produce a drift adjustment."
                    onChange={v => setParam('adj_scale', v)} />
                  <Num label="Max drift adj (%)" value={p.adj_cap!} step={0.5} min={1} max={20}
                    help="Hard cap on the drift adjustment in either direction."
                    onChange={v => setParam('adj_cap', v)} />
                </div>
                <InfoBox>
                  <Rule tag="BUY">Quarterly EPS growth above {p.exit_threshold_pct}%. Drift boosted proportionally, capped at +{p.adj_cap}%/yr.</Rule>
                  <Rule tag="SELL">EPS growth falls below {p.exit_threshold_pct}%. Drift penalised, capped at -{p.adj_cap}%/yr.</Rule>
                  <Rule tag="NOTE">Uses live Yahoo Finance data — reflects the most recently reported quarter.</Rule>
                </InfoBox>
              </>)}

              {value === "EMA Micro-Scalp (3/8)" && (<>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <Num label="Fast EMA (days)" value={p.ema_fast!} step={1} min={2} max={10}
                    help="Very short EMA — reacts within days. Default 3."
                    onChange={v => setParam('ema_fast', v)} />
                  <Num label="Slow EMA (days)" value={p.ema_slow!} step={1} min={4} max={30}
                    help="Reference EMA. Must be greater than Fast EMA. Default 8."
                    onChange={v => setParam('ema_slow', v)} />
                  <Num label="ATR period" value={p.atr_period!} step={1} min={2} max={20}
                    help="Bars used to compute Average True Range for the volatility filter."
                    onChange={v => setParam('atr_period', v)} />
                  <Num label="Min ATR % (0=off)" value={p.atr_mult!} step={0.1} min={0} max={2}
                    help="Suppress signals when daily ATR is below this % of price. 0 disables. 0.3 is a reasonable threshold."
                    onChange={v => setParam('atr_mult', v)} />
                  <Num label="Bull drift adj (%)" value={p.bull_drift_adj!} step={0.5} min={0} max={20}
                    help="Annualised drift boost when EMA(fast) is above EMA(slow)."
                    onChange={v => setParam('bull_drift_adj', v)} />
                  <Num label="Bear drift adj (%)" value={p.bear_drift_adj!} step={0.5} max={0} min={-15}
                    help="Drift penalty when EMA(fast) is below EMA(slow). Keep negative."
                    onChange={v => setParam('bear_drift_adj', v)} />
                </div>
                <InfoBox>
                  <Rule tag="BUY">EMA({p.ema_fast}) crosses above EMA({p.ema_slow}) — enter long, drift +{p.bull_drift_adj}%/yr.</Rule>
                  <Rule tag="SELL">EMA({p.ema_fast}) crosses below EMA({p.ema_slow}) — exit to cash, drift {p.bear_drift_adj}%/yr.</Rule>
                  <Rule tag="NOTE">ATR({p.atr_period}) filter: signals suppressed when daily move &lt; {p.atr_mult}% of price{p.atr_mult === 0 ? ' (disabled)' : ''}.</Rule>
                  <Rule tag="NOTE">Very active — frequent round trips. Best on volatile, trending assets (e.g. high-beta equities or ETFs).</Rule>
                </InfoBox>
              </>)}

              {value === CUSTOM_STRATEGY_KEY && (
                <div className="space-y-3">
                  {currentCustomDef ? (
                    <InfoBox>
                      <Rule tag="STRATEGY">{currentCustomDef.name}</Rule>
                      <Rule tag="BUY">{currentCustomDef.buy.groups.reduce((s, g) => s + g.conditions.length, 0)} cond{currentCustomDef.buy.groups.length > 1 ? ` in ${currentCustomDef.buy.groups.length} groups (${currentCustomDef.buy.logic})` : ` (${currentCustomDef.buy.groups[0]?.logic ?? 'AND'})`}</Rule>
                      <Rule tag="SELL">{currentCustomDef.sell.groups.reduce((s, g) => s + g.conditions.length, 0)} cond{currentCustomDef.sell.groups.length > 1 ? ` in ${currentCustomDef.sell.groups.length} groups (${currentCustomDef.sell.logic})` : ` (${currentCustomDef.sell.groups[0]?.logic ?? 'AND'})`}</Rule>
                    </InfoBox>
                  ) : (
                    <p className="text-slate-terminal text-xs">No rules defined yet — click Build to create your strategy.</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => { setEditingDef(currentCustomDef); setModalOpen(true) }}
                      className="text-xs text-gold border border-gold/50 px-3 py-1.5 hover:bg-gold/10 transition-colors cursor-pointer"
                      style={{ fontFamily: 'var(--theme-mono)', letterSpacing: '0.08em' }}
                    >{currentCustomDef ? 'Edit Strategy Rules' : 'Build Strategy Rules'}</button>
                    <button
                      onClick={() => { setEditingDef(null); setModalOpen(true) }}
                      className="text-xs text-slate-terminal border border-white/10 px-3 py-1.5 hover:bg-white/5 transition-colors cursor-pointer"
                      style={{ fontFamily: 'var(--theme-mono)', letterSpacing: '0.08em' }}
                    >Build New</button>
                  </div>
                </div>
              )}

            </div>
          )}
        </>
      )}
      <CustomStrategyModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSave={handleCustomSave}
        initialDef={editingDef}
      />
    </div>
  )
}
