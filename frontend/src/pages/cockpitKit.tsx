// Shared cockpit primitives for the redesigned tool screens (Pairs Trader,
// Factor Decomposition, Chokepoint Exposure). Token-driven so both themes hold.
import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { T } from '../lib/theme'

export const MONO = 'var(--theme-mono)'
export const SANS = 'var(--theme-sans)'
export const mix = (tok: string, pct: number) => `color-mix(in srgb, ${tok} ${pct}%, transparent)`
export const chg = (v: number | null | undefined) => (v == null ? T.muted : v > 0 ? T.pos : v < 0 ? T.neg : T.muted)
export const signed = (v: number, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`

// ⓘ trigger + hover popover. Body should interpret the CURRENT value, not just
// define the term. The popover renders in a portal with fixed positioning,
// clamped to the viewport, so it never gets clipped by a narrow rail's overflow
// or run off the screen edge. `align` is accepted for compat but positioning is
// automatic.
const TIP_W = 272
export function InfoTip({ title, body, source }: { title: string; body: string; source: string; align?: 'left' | 'right' }) {
  const ref = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; caret: number } | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  const show = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const pad = 8
    const left = Math.max(pad, Math.min(r.left - 8, window.innerWidth - TIP_W - pad))
    const caret = Math.max(8, Math.min(r.left + r.width / 2 - left - 4, TIP_W - 16))
    setPos({ top: r.bottom + 8, left, caret })
  }
  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setPos(null), 140)
  }
  return (
    <span ref={ref} style={{ display: 'inline-flex' }} onMouseEnter={show} onMouseLeave={hide}>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, flexShrink: 0, border: `1px solid ${pos ? T.gold : mix(T.muted, 55)}`, fontFamily: MONO, fontSize: 8, fontWeight: 700, color: pos ? T.gold : T.muted, cursor: 'help', lineHeight: 1 }}>i</span>
      {pos && createPortal(
        <div onMouseEnter={show} onMouseLeave={hide} style={{ position: 'fixed', top: pos.top, left: pos.left, width: TIP_W, zIndex: 1000, background: T.surface, border: `1px solid ${mix(T.gold, 45)}`, boxShadow: '0 10px 26px rgba(0,0,0,0.55)', padding: '12px 14px', boxSizing: 'border-box', textAlign: 'left' }}>
          <span style={{ position: 'absolute', top: -9, left: 0, right: 0, height: 9 }} />
          <span style={{ position: 'absolute', top: -5, left: pos.caret, width: 8, height: 8, background: T.surface, borderLeft: `1px solid ${mix(T.gold, 45)}`, borderTop: `1px solid ${mix(T.gold, 45)}`, transform: 'rotate(45deg)' }} />
          <span style={{ display: 'block', fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.gold, marginBottom: 6 }}>{title}</span>
          <span style={{ display: 'block', fontFamily: SANS, fontSize: 11.5, color: T.text, lineHeight: 1.6 }}>{body}</span>
          <span style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', marginTop: 9, paddingTop: 8, borderTop: `1px solid ${T.borderFaint}` }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: T.muted }}>{source}</span>
          </span>
        </div>, document.body)}
    </span>
  )
}

// Bordered output panel: tab label pinned top-left, optional meta top-right.
export function Panel({ label, meta, children, style, labelColor }: { label: string; meta?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties; labelColor?: string }) {
  return (
    <div className="ft-cockpit-panel" style={{ position: 'relative', border: `1px solid ${T.border}`, paddingTop: label ? 30 : 10, ...style }}>
      {label && <div className="ft-cockpit-panel-label" style={{ position: 'absolute', top: 0, left: 0, background: T.surface, padding: '4px 10px', fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: labelColor ?? T.text, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>{label}</div>}
      {meta != null && <div className="ft-cockpit-panel-meta" style={{ position: 'absolute', top: label ? 6 : 10, right: 12, fontFamily: MONO, fontSize: 9, color: T.muted }}>{meta}</div>}
      {children}
    </div>
  )
}

// Segmented-control cell style.
export const seg = (on: boolean, disabled = false): React.CSSProperties => ({
  flex: 1, textAlign: 'center', fontFamily: MONO, fontSize: 10, fontWeight: on ? 700 : 400, padding: '5px 0',
  cursor: disabled ? 'not-allowed' : 'pointer', background: on ? mix(T.gold, 14) : 'transparent',
  color: on ? T.gold : T.muted, border: `1px solid ${on ? T.gold : T.border}`, opacity: disabled ? 0.45 : 1,
})

export interface KpiCellSpec { label: string; value: string; vc?: string; sub?: string; sc?: string; tip?: { title: string; body: string; source: string } }
// KPI strip: flex row with ⓘ per cell.
export function KpiStrip({ cells }: { cells: KpiCellSpec[] }) {
  return (
    <div className="ft-kpi-strip" style={{ display: 'flex', alignItems: 'stretch', background: T.hover, border: `1px solid ${T.border}` }}>
      {cells.map((k, i) => (
        <div className="ft-kpi-cell" key={k.label} style={{ flex: 1, padding: '10px 14px', borderLeft: i ? `1px solid ${T.borderFaint}` : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>{k.label}</span>
            {k.tip && <InfoTip {...k.tip} />}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 17, fontWeight: 700, color: k.vc ?? T.text, marginTop: 5 }}>{k.value}</div>
          {k.sub && <div style={{ fontFamily: MONO, fontSize: 9, color: k.sc ?? T.muted, marginTop: 2 }}>{k.sub}</div>}
        </div>
      ))}
    </div>
  )
}
