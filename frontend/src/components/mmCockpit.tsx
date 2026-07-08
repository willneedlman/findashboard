// Shared page chrome for the two market-maker simulators (Options + Fixed
// Income). Presentational only. Colors route through --theme-* tokens.
import { useEffect, useRef, useState } from 'react'
import { Minus, Plus, ChevronUp, ChevronDown } from 'lucide-react'
import HelpTip from './HelpTip'

const V = {
  surface: 'var(--theme-surface, #0d1826)',
  bg: 'var(--theme-bg, #101c2e)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))',
  gold: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)',
  sec: 'var(--theme-secondary, #8099b0)',
  tertiary: 'var(--theme-tertiary, #60a5fa)',
  pos: 'var(--theme-positive, #22c55e)',
  neg: 'var(--theme-negative, #ef4444)',
  mono: 'var(--theme-mono)',
  sans: 'var(--theme-sans)',
}

const EYEBROW: React.CSSProperties = {
  fontFamily: V.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em',
  textTransform: 'uppercase', color: V.sec,
}

export function Widget({ title, right, children, style, bodyStyle }: {
  title: string; right?: React.ReactNode; children: React.ReactNode
  style?: React.CSSProperties; bodyStyle?: React.CSSProperties
}) {
  return (
    <div style={{ background: V.surface, border: `1px solid ${V.border}`, display: 'flex', flexDirection: 'column', minWidth: 0, ...style }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        padding: '7px 12px', background: 'rgba(0,0,0,0.18)', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0,
      }}>
        <span style={{ fontFamily: V.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: V.gold }}>{title}</span>
        {right}
      </div>
      <div style={{ minWidth: 0, ...bodyStyle }}>{children}</div>
    </div>
  )
}

// Page header bar: tool name + a live DESK LIVE / PAUSED status. (The ALPHATAPE
// wordmark already lives in the terminal sidebar, so it is not repeated here.)
export function HeaderBar({ tool, running }: { tool: string; running: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 2px' }}>
      <span style={{ fontFamily: V.sans, fontSize: 13, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: V.sec }}>{tool}</span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: running ? V.pos : V.sec, boxShadow: running ? '0 0 6px rgba(34,197,94,0.7)' : 'none' }} />
        <span style={{ fontFamily: V.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: running ? V.pos : V.sec }}>{running ? 'DESK LIVE' : 'PAUSED'}</span>
      </span>
    </div>
  )
}

// Horizontal limit meter: red danger ends, green comfort band in the middle, a
// glowing gold marker at the current value. Used for Net Delta (Options) and
// Net DV01 (FI). fmt formats the hero and the scale labels.
export function RiskMeter({ value, limit, unit, over, fmt, footerRight }: {
  value: number; limit: number; unit: string; over: boolean
  fmt?: (n: number) => string; footerRight?: React.ReactNode
}) {
  const f = fmt || ((n: number) => `${n >= 0 ? '+' : ''}${Math.round(n)}`)
  const pct = Math.max(0, Math.min(100, ((value + limit) / (2 * limit)) * 100))
  return (
    <div style={{ padding: '9px 14px' }}>
      <div style={{ fontFamily: V.mono, fontSize: 25, fontWeight: 700, lineHeight: 1, color: over ? V.neg : V.gold, whiteSpace: 'nowrap' }}>
        {f(value)}<span style={{ fontSize: 11, color: V.sec, fontWeight: 400, marginLeft: 6 }}>{unit}</span>
      </div>
      <div style={{
        position: 'relative', height: 8, borderRadius: 5, margin: '9px 0 5px',
        background: 'linear-gradient(90deg, var(--theme-negative,#ef4444) 0%, var(--theme-negative,#ef4444) 12.5%, rgba(34,197,94,0.45) 12.5%, rgba(34,197,94,0.45) 87.5%, var(--theme-negative,#ef4444) 87.5%, var(--theme-negative,#ef4444) 100%)',
      }}>
        <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${pct}%`, width: 2, marginLeft: -1, background: V.gold, boxShadow: '0 0 6px rgba(201,168,76,0.7)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: V.mono, fontSize: 9, color: V.sec }}>
        <span>{f(-limit)}</span><span>0</span><span>{f(limit)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, ...EYEBROW, color: over ? V.neg : V.pos }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: over ? V.neg : V.pos }} />
          {over ? 'Over Limit' : 'Within Limits'}
        </span>
        {footerRight}
      </div>
    </div>
  )
}

// A labeled value row for the Greeks / Book-risk widget.
export function StatRow({ label, hint, value, last }: { label: string; hint: string; value: string; last?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 14px', borderBottom: last ? 'none' : `1px solid ${V.border}` }}>
      <span>
        <span style={{ ...EYEBROW, display: 'block' }}>{label}</span>
        <span style={{ fontFamily: V.mono, fontSize: 8, color: V.sec, opacity: 0.7 }}>{hint}</span>
      </span>
      <span style={{ fontFamily: V.mono, fontSize: 16, fontWeight: 700, color: V.text }}>{value}</span>
    </div>
  )
}

// One split bar for the P&L panel (Spread / Directional).
export function PnLBar({ label, value, fill, frac }: { label: string; value: string; fill: string; frac: number }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <span style={EYEBROW}>{label}</span>
        <span style={{ fontFamily: V.mono, fontSize: 13, fontWeight: 700, color: fill }}>{value}</span>
      </div>
      <div style={{ height: 6, background: 'rgba(255,255,255,0.06)' }}>
        <div style={{ width: `${Math.max(0, Math.min(100, frac * 100))}%`, height: '100%', background: fill }} />
      </div>
    </div>
  )
}

// Size stepper: [−] [ big gold value ] [+]. Floors at 0.
export function Stepper({ value, step, unit, onChange }: { value: number; step: number; unit: string; onChange: (v: number) => void }) {
  const btn: React.CSSProperties = {
    width: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: V.bg, border: `1px solid ${V.border}`, color: V.text, cursor: 'pointer',
  }
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 6, height: 46 }}>
      <button style={btn} onClick={() => onChange(Math.max(0, value - step))} aria-label="Decrease size"><Minus size={15} /></button>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: V.bg, border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)' }}>
        <span style={{ fontFamily: V.mono, fontSize: 24, fontWeight: 700, color: V.gold }}>{value.toLocaleString()}</span>
        <span style={{ fontFamily: V.sans, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: V.sec }}>{unit}</span>
      </div>
      <button style={btn} onClick={() => onChange(value + step)} aria-label="Increase size"><Plus size={15} /></button>
    </div>
  )
}

// Compact per-row spread-widen stepper, meant to sit under the Theo/Strike
// cell. Adds to the base half-spread for that row. `format` renders the value in
// the host sim's units (percent of theo for options, price points for FI).
// Buttons stop click propagation so they don't trigger the row's own onClick.
export function WidenControl({ value, onStep, format }: { value: number; onStep: (dir: 1 | -1) => void; format: (v: number) => string }) {
  const on = value > 1e-4
  const btn: React.CSSProperties = {
    width: 15, height: 15, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0,
    background: 'transparent', border: `1px solid ${V.border}`, color: V.sec, cursor: 'pointer',
    fontFamily: V.mono, fontSize: 12, lineHeight: 1,
  }
  const step = (e: React.MouseEvent, dir: 1 | -1) => { e.stopPropagation(); onStep(dir) }
  return (
    <div title="Widen this row's spread (adds to base half-spread)"
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3, marginTop: 3 }}>
      <button className="mm-widen-btn" style={btn} onClick={e => step(e, -1)} aria-label="Tighten spread">-</button>
      <span style={{ fontFamily: V.mono, fontSize: 9, fontWeight: 700, color: on ? V.gold : V.sec, minWidth: 34, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
        {format(value)}
      </span>
      <button className="mm-widen-btn" style={btn} onClick={e => step(e, 1)} aria-label="Widen spread">+</button>
    </div>
  )
}

// A row of preset chips; the chip matching `value` reads active (gold).
export function Chips({ options, value, onPick }: { options: { label: string; value: number }[]; value: number; onPick: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {options.map(o => {
        const on = o.value === value
        return (
          <button key={o.value} onClick={() => onPick(o.value)}
            style={{ flex: 1, padding: '5px 0', fontFamily: V.mono, fontSize: 10, fontWeight: 700, cursor: 'pointer',
              background: on ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : V.bg,
              border: `1px solid ${on ? V.gold : V.border}`, color: on ? V.gold : V.sec }}>{o.label}</button>
        )
      })}
    </div>
  )
}

// One compact KPI cell for the unified top instrument strip. Cells sit in a row
// separated by hairline borders; the strip reads as one instrument, not cards.
export function KpiCell({ label, value, color, valueSize = 13, grow = false, minWidth, sub, subColor, align = 'center', help }: {
  label: string; value: string; color?: string; valueSize?: number; grow?: boolean; minWidth?: number
  sub?: string; subColor?: string; align?: 'center' | 'top'; help?: string
}) {
  // align="top" gives every cell the same label/value baseline regardless of
  // whether it has a sub line (so a mixed strip stays aligned).
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', justifyContent: align === 'top' ? 'flex-start' : 'center', gap: 3,
      padding: align === 'top' ? '11px 14px' : '6px 13px', borderRight: `1px solid ${V.border}`,
      flex: grow ? 1 : '0 0 auto', minWidth,
    }}>
      {help ? (
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          <span style={{ ...EYEBROW, fontSize: 8 }}>{label}</span>
          <HelpTip text={help} width={240} />
        </span>
      ) : (
        <span style={{ ...EYEBROW, fontSize: 8 }}>{label}</span>
      )}
      <span style={{ fontFamily: V.mono, fontSize: valueSize, fontWeight: 700, color: color || V.text, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      {sub && <span style={{ fontFamily: V.sans, fontSize: 9, color: subColor || V.sec, whiteSpace: 'nowrap', marginTop: 1 }}>{sub}</span>}
    </div>
  )
}

// Inline risk meter for the top strip: a header row (label + value/limit, status
// on the right) over a compact red-ends / green-band gradient bar with a gold
// marker. Fills the remaining strip width. Distinct from the taller card meter.
export function RiskMeterStrip({ label, value, limit, unit, over, fmt }: {
  label: string; value: number; limit: number; unit?: string; over: boolean; fmt?: (n: number) => string
}) {
  const f = fmt || ((n: number) => `${n >= 0 ? '+' : ''}${Math.round(n)}`)
  const pct = Math.max(0, Math.min(100, ((value + limit) / (2 * limit)) * 100))
  return (
    <div style={{ flex: 1, minWidth: 320, padding: '6px 14px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 7 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ ...EYEBROW, fontSize: 8 }}>{label}</span>
          <span style={{ fontFamily: V.mono, fontSize: 11, fontWeight: 700, color: over ? V.neg : V.gold, fontVariantNumeric: 'tabular-nums' }}>{f(value)} / {f(limit)}{unit ? ` ${unit}` : ''}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, ...EYEBROW, fontSize: 8, color: over ? V.neg : V.pos }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: over ? V.neg : V.pos }} />
          {over ? 'Over Limit' : 'Within Limits'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: V.mono, fontSize: 9, color: V.sec }}>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{f(-limit)}</span>
        <div style={{
          position: 'relative', flex: 1, height: 7, borderRadius: 4,
          background: 'linear-gradient(90deg, var(--theme-negative,#ef4444) 0%, var(--theme-negative,#ef4444) 12.5%, rgba(34,197,94,0.45) 12.5%, rgba(34,197,94,0.45) 87.5%, var(--theme-negative,#ef4444) 87.5%, var(--theme-negative,#ef4444) 100%)',
        }}>
          <div style={{ position: 'absolute', top: -2, bottom: -2, left: `${pct}%`, width: 2, marginLeft: -1, background: V.gold, boxShadow: '0 0 6px rgba(201,168,76,0.7)' }} />
        </div>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{f(limit)}</span>
      </div>
    </div>
  )
}

// Editable quote cell: a tabular-nums field that reads as part of the table plus
// a vertical chevron stepper. Typing commits on blur/Enter; a chevron bumps by
// one tick. Both route to the page's existing per-instrument quote override.
export function QuoteCell({ value, side, step, decimals, onCommit, width }: {
  value: number; side: 'bid' | 'ask'; step: number; decimals: number; onCommit: (v: number) => void; width?: number
}) {
  const color = side === 'bid' ? V.pos : V.neg
  const [draft, setDraft] = useState<string | null>(null)
  // Optimistic value so a chevron click shows immediately, before the ~1s sim
  // tick re-derives `value` from the committed override.
  const [optimistic, setOptimistic] = useState<number | null>(null)
  const shown = draft ?? (optimistic != null ? optimistic.toFixed(decimals) : value.toFixed(decimals))
  // Track the live quote in a ref so consecutive chevron clicks accumulate even
  // before the next sim tick re-derives `value`; reset only when value moves.
  const liveRef = useRef(value)
  useEffect(() => { if (draft === null) liveRef.current = value; setOptimistic(null) }, [value, draft])
  const commit = (raw: string) => {
    const n = parseFloat(raw)
    if (!Number.isNaN(n)) onCommit(+n.toFixed(decimals))
    setDraft(null)
  }
  const bump = (dir: number) => {
    const next = +(liveRef.current + dir * step).toFixed(decimals)
    liveRef.current = next
    setOptimistic(next)
    onCommit(next)
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }} onClick={e => e.stopPropagation()}>
      <span style={{ display: 'flex', flexDirection: 'column' }}>
        <button className="mm-chev" onClick={() => bump(1)} aria-label={`${side} up`} style={CHEV}><ChevronUp size={11} /></button>
        <button className="mm-chev" onClick={() => bump(-1)} aria-label={`${side} down`} style={CHEV}><ChevronDown size={11} /></button>
      </span>
      <input
        className="mm-quote" value={shown} inputMode="decimal" aria-label={`${side} quote`}
        onChange={e => setDraft(e.target.value)}
        onFocus={e => { setDraft(value.toFixed(decimals)); e.currentTarget.select() }}
        onBlur={e => commit(e.currentTarget.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          else if (e.key === 'Escape') { setDraft(null); e.currentTarget.blur() }
        }}
        style={{
          width: width ?? (decimals >= 3 ? 72 : 52), textAlign: 'right', fontFamily: V.mono, fontSize: 13, fontWeight: 600,
          color, background: 'rgba(255,255,255,0.04)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 30%, transparent)',
          borderRadius: 3, padding: '2px 5px', fontVariantNumeric: 'tabular-nums', outline: 'none',
        }}
      />
    </span>
  )
}
const CHEV: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center', width: 15, height: 10,
  padding: 0, background: 'transparent', border: 'none', cursor: 'pointer', lineHeight: 0,
}

// Segmented control (FI maturity selector): active segment = gold fill, dark text.
export function Segmented({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', border: `1px solid ${V.border}` }}>
      {options.map((o, i) => {
        const on = o === value
        return (
          <button key={o} onClick={() => onChange(o)}
            style={{ flex: 1, padding: '7px 0', fontFamily: V.mono, fontSize: 11, fontWeight: 700, cursor: 'pointer',
              background: on ? V.gold : 'transparent', color: on ? V.bg : V.sec, border: 'none',
              borderRight: i < options.length - 1 ? `1px solid ${V.border}` : 'none' }}>{o}</button>
        )
      })}
    </div>
  )
}
