/*
 * Options MM 2 — the P&L band.
 *
 * A single slim strip across the foot of the screen: the timeline on the left,
 * the attribution that explains it on the right. Attribution earns permanent
 * space because a desk can look profitable while losing on quoting and being
 * rescued by directional inventory.
 */

import { useState } from 'react'
import { T, alpha } from '../../lib/theme'
import { Panel, Canvas, useTokens, hexAlpha, MONO, LABEL, Seg, Btn, GOOD, BAD, pnlColor } from './ui'
import { fmtK } from './Chain'
import { type Mm2Engine, type Sample } from '../../lib/mm2/engine'

type Mode = 'pnl' | 'inventory'

const PNL_SERIES: { key: keyof Sample; label: string; color: (t: Record<string, string>) => string }[] = [
  { key: 'total', label: 'Total', color: t => t.gold },
  { key: 'realized', label: 'Realized', color: t => t.blue },
  { key: 'spread', label: 'Spread', color: t => t.pos },
  { key: 'hedge', label: 'Hedge', color: t => '#f97316' },
  { key: 'adverse', label: 'Adverse', color: t => '#f43f5e' },
]
const INV_SERIES: { key: keyof Sample; label: string; color: (t: Record<string, string>) => string }[] = [
  { key: 'netDelta', label: 'Net delta', color: t => t.gold },
  { key: 'vega', label: 'Vega', color: t => '#38bdf8' },
  { key: 'stock', label: 'Stock', color: t => t.blue },
]

export default function PnlBand({ eng, tick, reviewT, onScrub }: {
  eng: Mm2Engine; tick: number; reviewT: number | null; onScrub: (t: number | null) => void
}) {
  void tick
  const tok = useTokens()
  const [mode, setMode] = useState<Mode>('pnl')
  const s = eng.samples
  const list = mode === 'pnl' ? PNL_SERIES : INV_SERIES
  const a = eng.attr

  const rows: [string, number][] = [
    ['Spread capture', a.spread],
    ['Inventory delta', a.delta],
    ['Gamma', a.gamma],
    ['Vol move', a.vega],
    ['Theta', a.theta],
    ['Delta hedge', a.hedge],
    ['Fees and rebates', a.fees],
    ['Model repricing', a.model],
  ]
  const max = Math.max(1e-9, ...rows.map(r => Math.abs(r[1])))

  return (
    <Panel
      title={mode === 'pnl' ? 'P&L timeline' : 'Inventory timeline'}
      style={{ height: '100%' }}
      right={
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ ...MONO, fontSize: 9, color: T.muted }}>
            {list.map(x => x.label).join(' · ')}
          </span>
          {reviewT !== null && <Btn tone="gold" onClick={() => onScrub(null)}>RETURN TO LIVE</Btn>}
          <Seg<Mode> options={[{ label: 'P&L', value: 'pnl' }, { label: 'INVENTORY', value: 'inventory' }]} value={mode} onChange={setMode} size={9} />
        </div>
      }
    >
      <div style={{ display: 'flex', minHeight: 0, height: '100%' }}>
        <div style={{ flex: 1, minWidth: 0, padding: '2px 4px' }}>
          <Canvas height={96} onPick={xf => {
            if (s.length < 2) return
            onScrub(s[0].t + xf * (s[s.length - 1].t - s[0].t))
          }} draw={(ctx, w, h) => {
            if (!tok.gold || s.length < 2) return
            let lo = 0, hi = 0
            for (const p of s) for (const ser of list) {
              const v = p[ser.key] as number
              lo = Math.min(lo, v); hi = Math.max(hi, v)
            }
            if (lo === hi) { lo -= 1; hi += 1 }
            const pad = (hi - lo) * 0.1
            lo -= pad; hi += pad
            const t0 = s[0].t, span = Math.max(s[s.length - 1].t - t0, 1)
            const X = (t: number) => ((t - t0) / span) * w
            const Y = (v: number) => h - 10 - ((v - lo) / (hi - lo)) * (h - 18)

            ctx.strokeStyle = hexAlpha(tok.muted, 0.38)
            ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke()

            for (const ser of list) {
              ctx.beginPath()
              s.forEach((p, i) => {
                const x = X(p.t), y = Y(p[ser.key] as number)
                i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
              })
              ctx.strokeStyle = ser.color(tok)
              ctx.lineWidth = ser.key === 'total' || ser.key === 'netDelta' ? 1.7 : 1
              ctx.stroke()
            }
            if (reviewT !== null) {
              const x = X(reviewT)
              ctx.strokeStyle = tok.text
              ctx.setLineDash([3, 3])
              ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
              ctx.setLineDash([])
            }
            ctx.font = '9px ui-monospace, monospace'
            ctx.fillStyle = hexAlpha(tok.muted, 0.85)
            ctx.fillText(fmtK(hi), 2, 9)
            ctx.fillText(fmtK(lo), 2, h - 2)
          }} />
        </div>

        <div style={{ width: 300, flexShrink: 0, borderLeft: `1px solid ${T.borderFaint}`, padding: '4px 8px', overflow: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ ...LABEL, fontSize: 8 }}>Attribution</span>
            <span style={{ ...MONO, fontSize: 9, color: T.muted }}>adverse {fmtK(a.adverse)}</span>
          </div>
          {rows.map(([label, v]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 13 }}>
              <span style={{ ...MONO, fontSize: 9, color: T.muted, width: 92, flexShrink: 0 }}>{label}</span>
              <div style={{ flex: 1, position: 'relative', height: 6, background: alpha(T.muted, 8) }}>
                <div style={{
                  position: 'absolute', top: 0, bottom: 0,
                  left: v < 0 ? `${50 - (Math.abs(v) / max) * 50}%` : '50%',
                  width: `${(Math.abs(v) / max) * 50}%`,
                  background: v > 0 ? alpha(GOOD, 72) : alpha(BAD, 72),
                }} />
                <div style={{ position: 'absolute', left: '50%', top: -1, bottom: -1, width: 1, background: alpha(T.text, 26) }} />
              </div>
              <span style={{ ...MONO, fontSize: 9.5, color: pnlColor(v), width: 52, textAlign: 'right', flexShrink: 0 }}>{fmtK(v)}</span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  )
}
