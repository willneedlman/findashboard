// Shared cockpit primitives for the redesigned tool screens (Pairs Trader,
// Factor Decomposition, Chokepoint Exposure). Token-driven so both themes hold.
import { T } from '../lib/theme'
import { Info } from 'lucide-react'
import HelpTip from '../components/HelpTip'

export const MONO = 'var(--theme-mono)'
export const SANS = 'var(--theme-sans)'
export const mix = (tok: string, pct: number) => `color-mix(in srgb, ${tok} ${pct}%, transparent)`
export const chg = (v: number | null | undefined) => (v == null ? T.muted : v > 0 ? T.pos : v < 0 ? T.neg : T.muted)
export const signed = (v: number, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`

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
// KPI strip: flex row with an info affordance per cell.
/** `dense` trades vertical presence for space on boards that have to fit a
 *  viewport. Everything else keeps the original geometry. */
export function KpiStrip({ cells, cellHeight, dense }: { cells: KpiCellSpec[]; cellHeight?: number; dense?: boolean }) {
  return (
    <div className="ft-kpi-strip" style={{ display: 'flex', alignItems: 'stretch', background: T.surface, border: `1px solid ${T.border}` }}>
      {cells.map((k, i) => (
        <div className="ft-kpi-cell ft-metric-tile" key={k.label} style={{ flex: 1, height: cellHeight, boxSizing: 'border-box', padding: dense ? '9px 13px' : '10px 14px', borderLeft: i ? `1px solid ${T.borderFaint}` : 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>{k.label}</span>
            {k.tip && <HelpTip title={k.tip.title} body={k.tip.body} source={k.tip.source} />}
          </div>
          <div style={{ fontFamily: MONO, fontSize: dense ? 16 : 17, fontWeight: 700, color: k.vc ?? T.text, marginTop: dense ? 3 : 5, lineHeight: dense ? 1.2 : undefined, fontVariantNumeric: 'tabular-nums' }}>{k.value}</div>
          {k.sub && <div style={{ fontFamily: MONO, fontSize: dense ? 9 : 9, color: k.sc ?? T.muted, marginTop: dense ? 2 : 2, lineHeight: dense ? 1.3 : undefined }}>{k.sub}</div>}
        </div>
      ))}
    </div>
  )
}
