// Shared cockpit primitives for the redesigned tool screens (Pairs Trader,
// Factor Decomposition, Chokepoint Exposure). Token-driven so both themes hold.
import { useState } from 'react'
import { T } from '../lib/theme'

export const MONO = 'var(--theme-mono)'
export const SANS = 'var(--theme-sans)'
export const mix = (tok: string, pct: number) => `color-mix(in srgb, ${tok} ${pct}%, transparent)`
export const chg = (v: number | null | undefined) => (v == null ? T.muted : v > 0 ? T.pos : v < 0 ? T.neg : T.muted)
export const signed = (v: number, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`

// ⓘ trigger + hover popover. Body should interpret the CURRENT value, not just
// define the term.
export function InfoTip({ title, body, source, align = 'left' }: { title: string; body: string; source: string; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, flexShrink: 0, border: `1px solid ${open ? T.gold : mix(T.muted, 55)}`, fontFamily: MONO, fontSize: 8, fontWeight: 700, color: open ? T.gold : T.muted, cursor: 'help', lineHeight: 1 }}>i</span>
      {open && (
        <span style={{ position: 'absolute', [align === 'right' ? 'right' : 'left']: -8, top: 'calc(100% + 8px)', width: 272, zIndex: 20, background: T.surface, border: `1px solid ${mix(T.gold, 45)}`, boxShadow: '0 10px 26px rgba(0,0,0,0.55)', padding: '12px 14px', boxSizing: 'border-box', textAlign: 'left', pointerEvents: 'none' } as React.CSSProperties}>
          <span style={{ position: 'absolute', top: -5, [align === 'right' ? 'right' : 'left']: 14, width: 8, height: 8, background: T.surface, borderLeft: `1px solid ${mix(T.gold, 45)}`, borderTop: `1px solid ${mix(T.gold, 45)}`, transform: 'rotate(45deg)' } as React.CSSProperties} />
          <span style={{ display: 'block', fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: T.gold, marginBottom: 6 }}>{title}</span>
          <span style={{ display: 'block', fontFamily: SANS, fontSize: 11.5, color: T.text, lineHeight: 1.6 }}>{body}</span>
          <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 9, paddingTop: 8, borderTop: `1px solid ${T.borderFaint}` }}>
            <span style={{ fontFamily: MONO, fontSize: 9, color: T.muted }}>{source}</span>
            <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: T.gold }}>FULL METHOD ↗</span>
          </span>
        </span>
      )}
    </span>
  )
}

// Bordered output panel: tab label pinned top-left, optional meta top-right.
export function Panel({ label, meta, children, style, labelColor }: { label: string; meta?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties; labelColor?: string }) {
  return (
    <div style={{ position: 'relative', border: `1px solid ${T.border}`, paddingTop: 30, ...style }}>
      <div style={{ position: 'absolute', top: 0, left: 0, background: T.surface, padding: '4px 10px', fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: labelColor ?? T.text, borderRight: `1px solid ${T.border}`, borderBottom: `1px solid ${T.border}` }}>{label}</div>
      {meta != null && <div style={{ position: 'absolute', top: 6, right: 12, fontFamily: MONO, fontSize: 9, color: T.muted }}>{meta}</div>}
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
    <div style={{ display: 'flex', alignItems: 'stretch', background: T.hover, border: `1px solid ${T.border}` }}>
      {cells.map((k, i) => (
        <div key={k.label} style={{ flex: 1, padding: '10px 14px', borderLeft: i ? `1px solid ${T.borderFaint}` : 'none' }}>
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
