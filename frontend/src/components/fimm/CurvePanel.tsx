/*
 * The curve panel (height 118).
 *
 * Model against market across the whole strip, with a DV01 bar per tenor. This
 * is the one graphic a rates book actually reads: it answers where the curve
 * is, where the desk disagrees with the street, and where the risk is sitting,
 * in one picture.
 */

import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, Canvas, useTokens } from '../mm2/ui'
import type { FiEngine, NodeView } from '../../lib/fimm/engine'

export default function CurvePanel({ eng, rows, sel, onSel, tick }: {
  eng: FiEngine
  rows: NodeView[]
  sel: number
  onSel: (id: number) => void
  tick: number
}) {
  const tokens = useTokens()
  if (!rows.length) return null

  const yields = rows.map(r => r.modelYield)
  const market = rows.map(r => (r.streetBidYield + r.streetAskYield) / 2)
  const lo = Math.min(...yields, ...market)
  const hi = Math.max(...yields, ...market)
  const pad = Math.max((hi - lo) * 0.18, 0.0004)
  const yLo = lo - pad
  const yHi = hi + pad
  const maxDv01 = Math.max(1, ...rows.map(r => Math.abs(r.dv01)))

  return (
    <div style={{
      height: 118, flexShrink: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
      background: T.bg, border: `1px solid ${T.border}`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '5px 8px',
        borderBottom: `1px solid ${T.borderFaint}`,
        background: alpha(T.gold, 4),
      }}>
        <span style={{ ...LABEL, fontSize: 9, letterSpacing: '0.16em', color: alpha(T.gold, 70) }}>Curve shape</span>
        <span style={{ display: 'flex', gap: 12, marginLeft: 'auto', ...MONO, fontSize: 9.5 }}>
          <Key color={T.gold}>model yield</Key>
          <Key color={alpha(T.muted, 55)}>market</Key>
          <Key color={T.blue}>your DV01 by tenor</Key>
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', padding: '6px 10px 0', gap: 4 }}>
        {/* Axis gutter, so the plot box itself carries no text. */}
        <div style={{
          width: 34, flexShrink: 0, display: 'flex', flexDirection: 'column',
          justifyContent: 'space-between', ...MONO, fontSize: 8.5, color: T.muted, paddingBottom: 15,
        }}>
          <span>{(yHi * 100).toFixed(2)}</span>
          <span>{(yLo * 100).toFixed(2)}</span>
        </div>

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{
            flex: 1, minHeight: 0, position: 'relative',
            background: T.strip, borderBottom: `1px solid ${T.borderFaint}`,
          }}>
            <Canvas
              height={56}
              onPick={xFrac => {
                const i = Math.round(xFrac * (rows.length - 1))
                onSel(rows[Math.max(0, Math.min(rows.length - 1, i))].node.id)
              }}
              draw={(ctx, w, h) => {
                const gold = tokens['--theme-primary'] || '#c9a84c'
                const blue = tokens['--theme-tertiary'] || '#60a5fa'
                const red = tokens['--theme-negative'] || '#ef4444'
                const grey = tokens['--theme-secondary'] || '#8099b0'
                const span = Math.max(yHi - yLo, 1e-9)
                const xAt = (i: number) => (rows.length === 1 ? w / 2 : (i / (rows.length - 1)) * (w - 12) + 6)
                const yAt = (v: number) => h - ((v - yLo) / span) * h

                // DV01 bars first: they are the ground the curve sits on.
                rows.forEach((r, i) => {
                  if (!r.dv01) return
                  const barH = (Math.abs(r.dv01) / maxDv01) * (h * 0.55)
                  ctx.fillStyle = rgba(r.dv01 > 0 ? blue : red, 0.4)
                  ctx.fillRect(xAt(i) - 7, h - barH, 14, barH)
                })

                ctx.setLineDash([4, 3])
                ctx.strokeStyle = rgba(grey, 0.55)
                ctx.lineWidth = 1
                ctx.beginPath()
                market.forEach((v, i) => (i === 0 ? ctx.moveTo(xAt(i), yAt(v)) : ctx.lineTo(xAt(i), yAt(v))))
                ctx.stroke()
                ctx.setLineDash([])

                ctx.strokeStyle = gold
                ctx.lineWidth = 1.8
                ctx.beginPath()
                yields.forEach((v, i) => (i === 0 ? ctx.moveTo(xAt(i), yAt(v)) : ctx.lineTo(xAt(i), yAt(v))))
                ctx.stroke()

                rows.forEach((r, i) => {
                  const on = r.node.id === sel
                  ctx.fillStyle = on ? gold : rgba(gold, 0.6)
                  ctx.fillRect(xAt(i) - 2.5, yAt(r.modelYield) - 2.5, 5, 5)
                })
              }}
            />
          </div>

          <div style={{ display: 'flex', height: 15, alignItems: 'center' }}>
            {rows.map(r => {
              const on = r.node.id === sel
              return (
                <span key={r.node.id} onClick={() => onSel(r.node.id)} style={{
                  flex: '1 1 0', textAlign: 'center', cursor: 'pointer',
                  ...MONO, fontSize: 9, fontWeight: on ? 700 : 400, color: on ? T.gold : T.muted,
                }}>{r.node.label}</span>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function Key({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: T.muted }}>
      <span style={{ width: 10, height: 2, background: color }} />
      {children}
    </span>
  )
}

/** Canvas needs a literal, so a resolved token is converted rather than var()'d. */
function rgba(hex: string, a: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
