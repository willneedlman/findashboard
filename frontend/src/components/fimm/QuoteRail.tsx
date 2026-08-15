/*
 * Left rail: what the desk is showing and how it is being shown.
 *
 * Every row is one line — label, right-aligned input, fixed-width unit. The old
 * two-column grid inside a 178px rail is what produced `EDGE CAPTURE…` and
 * `NOTIONAL DO…`; no label on this screen is allowed to truncate.
 *
 * Edge is in basis points of yield rather than price, because a basis point
 * means the same thing at every point on the curve and a 32nd does not.
 */

import { T, alpha } from '../../lib/theme'
import { MONO, Panel, Toggle, GOOD, BAD } from '../mm2/ui'
import type { Config, FiEngine } from '../../lib/fimm/engine'

export default function QuoteRail({ eng, cfg, set, tick, onSetup, onMetrics }: {
  eng: FiEngine
  cfg: Config
  set: (patch: Partial<Config>) => void
  tick: number
  onSetup: () => void
  onMetrics: () => void
}) {
  const s = eng.stat
  const fillRate = s.enquiries > 0 ? (s.fillsN / s.enquiries) * 100 : 0
  const edgeKept = s.notional > 0 ? s.edgeRealizedBp / s.notional : 0
  const scope = eng.nodes.filter(n => eng.inScope(n)).length

  return (
    <Panel
      title="Quoting"
      right={<Toggle value={cfg.quotingOn} onChange={v => set({ quotingOn: v })} />}
      style={{ height: '100%', minHeight: 0 }}
      bodyStyle={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <FieldRow label="edge" value={cfg.edgeBp} onChange={v => set({ edgeBp: v })}
          step={0.02} dp={2} unit="bp" primary />
        <FieldRow label="long-end widen" value={cfg.longEndWiden} onChange={v => set({ longEndWiden: v })}
          step={0.002} dp={3} unit="bp/y" />
        <FieldRow label="quote size" value={cfg.quoteSizeMM} onChange={v => set({ quoteSizeMM: v })}
          step={5} dp={0} unit="mm" />
        <FieldRow label="inventory relief" value={cfg.invReliefMM} onChange={v => set({ invReliefMM: v })}
          step={5} dp={0} unit="mm" />
      </div>

      <div style={{ padding: '7px 8px', borderTop: `1px solid ${T.borderFaint}`, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <FieldRow label="inventory" value={cfg.invSkewBp} onChange={v => set({ invSkewBp: v })}
          step={0.05} dp={2} unit="bp" />
        <FieldRow label="curve tilt" value={cfg.curveSkewBp} onChange={v => set({ curveSkewBp: v })}
          step={0.05} dp={2} unit="bp" />
        <FieldRow label="toxicity widen" value={cfg.toxicityWiden} onChange={v => set({ toxicityWiden: v })}
          step={0.1} dp={1} unit="" />
        <MeterRow label="measured" text={`${(eng.toxicity * 100).toFixed(0)}%`}
          used={eng.toxicity} fill={eng.toxicity > 0.5 ? BAD : alpha(T.gold, 70)} />
      </div>

      <div style={{
        padding: '7px 8px', borderTop: `1px solid ${T.borderFaint}`, flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column', gap: 5,
      }}>
        <MeterRow label="quoted nodes" text={`${s.quotedNodes} / ${scope}`}
          used={scope ? s.quotedNodes / scope : 0} fill={alpha(GOOD, 70)} />
        <ReadRow label="fill rate" value={`${fillRate.toFixed(0)}%`} color={fillRate > 20 ? GOOD : T.text} />
        <ReadRow label="edge kept" value={`${edgeKept.toFixed(2)} bp`} color={edgeKept > 0 ? GOOD : T.muted} />
        <ReadRow label="notional done" value={`${Math.round(s.notional)}mm`} />
        <ReadRow label="informed hits" value={String(s.informedFills)} color={s.informedFills ? BAD : T.muted} />
      </div>

      <div style={{ padding: '7px 8px', borderTop: `1px solid ${T.borderFaint}`, display: 'flex', gap: 5 }}>
        <RailBtn onClick={onSetup}>SETUP</RailBtn>
        <RailBtn onClick={onMetrics}>METRICS</RailBtn>
      </div>
    </Panel>
  )
}

/**
 * One line: label, input, unit.
 *
 * The unit sits in a fixed 22px span so every input in the rail lines up on the
 * same right edge regardless of how long its unit is.
 */
export function FieldRow({ label, value, onChange, step, dp, unit, primary }: {
  label: string
  value: number
  onChange: (v: number) => void
  step: number
  dp: number
  unit: string
  primary?: boolean
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <span style={{ ...MONO, fontSize: 10.5, color: T.muted, flex: 1, minWidth: 0, whiteSpace: 'nowrap' }}>{label}</span>
      <input
        type="number"
        value={Number(value.toFixed(dp))}
        step={step}
        onChange={e => {
          const n = parseFloat(e.target.value)
          if (Number.isFinite(n)) onChange(n)
        }}
        style={{
          ...MONO, fontSize: 11, width: 44, textAlign: 'right', padding: '3px 5px',
          background: T.surface, color: T.text, borderRadius: 0,
          border: `1px solid ${primary ? alpha(T.gold, 30) : T.border}`,
        }}
      />
      <span style={{ ...MONO, fontSize: 9, color: T.muted, width: 22, flexShrink: 0 }}>{unit}</span>
    </div>
  )
}

function ReadRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
      <span style={{ ...MONO, fontSize: 10.5, color: T.muted, flex: 1, minWidth: 0, whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{ ...MONO, fontSize: 11, color: color ?? T.text }}>{value}</span>
    </div>
  )
}

function MeterRow({ label, text, used, fill }: {
  label: string; text: string; used: number; fill: string
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ ...MONO, fontSize: 10.5, color: T.muted, flex: 1, minWidth: 0, whiteSpace: 'nowrap' }}>{label}</span>
        <span style={{ ...MONO, fontSize: 11, color: T.text }}>{text}</span>
      </div>
      <div style={{ height: 3, background: alpha(T.muted, 20), marginTop: 3 }}>
        <div style={{ height: '100%', width: `${Math.min(100, used * 100)}%`, background: fill }} />
      </div>
    </div>
  )
}

function RailBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{
      ...MONO, flex: '1 1 0', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
      padding: '4px 0', cursor: 'pointer', borderRadius: 0,
      background: alpha(T.gold, 8), border: `1px solid ${alpha(T.gold, 40)}`, color: T.gold,
    }}>{children}</button>
  )
}
