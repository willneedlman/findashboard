/*
 * Left rail: what the desk is showing and how it is being shown.
 *
 * Edge is in basis points of yield rather than in price, because a basis point
 * means the same thing at every point on the curve and a 32nd does not. Size is
 * in millions of notional for cash and lots for the strip.
 */

import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, Panel, Field, Num, Toggle, Btn, Stat, GOOD, BAD } from '../mm2/ui'
import { fmtMoney, type Config, type FiEngine } from '../../lib/fimm/engine'

export default function QuoteRail({ eng, cfg, set, tick }: {
  eng: FiEngine
  cfg: Config
  set: (patch: Partial<Config>) => void
  tick: number
}) {
  const s = eng.stat
  const fillRate = s.enquiries > 0 ? (s.fillsN / s.enquiries) * 100 : 0
  const avgEdge = s.notional > 0 ? s.edgeRealizedBp / s.notional : 0
  const capture = s.edgeIntendedBp > 0 ? (s.edgeRealizedBp / s.edgeIntendedBp) * 100 : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: '100%', minHeight: 0, overflow: 'auto' }}>
      <Panel title="Quoting" right={<Toggle value={cfg.quotingOn} onChange={v => set({ quotingOn: v })} />}>
        <Field label="Edge" hint="Half-spread in basis points of yield">
          <Num value={cfg.edgeBp} onChange={v => set({ edgeBp: v })} step={0.02} min={0.01} max={5} dp={2} suffix="bp" />
        </Field>
        <Field label="Long-end widen" hint="Extra edge per year of modified duration">
          <Num value={cfg.longEndWiden} onChange={v => set({ longEndWiden: v })} step={0.002} min={0} max={0.2} dp={3} suffix="bp/y" />
        </Field>
        <Field label="Quote size" hint="Millions of notional, or lots on the strip">
          <Num value={cfg.quoteSizeMM} onChange={v => set({ quoteSizeMM: v })} step={5} min={1} max={200} suffix="mm" />
        </Field>
        <Field label="Inventory relief" hint="Extra size on the side that flattens the book">
          <Num value={cfg.invReliefMM} onChange={v => set({ invReliefMM: v })} step={5} min={0} max={100} suffix="mm" />
        </Field>
        <Field label="Per-node cap">
          <Num value={cfg.perNodeCapMM} onChange={v => set({ perNodeCapMM: v })} step={25} min={10} max={2000} suffix="mm" />
        </Field>
      </Panel>

      <Panel title="Skew">
        <Field label="Inventory" hint="Yield shading per unit of DV01 limit used">
          <Num value={cfg.invSkewBp} onChange={v => set({ invSkewBp: v })} step={0.05} min={0} max={3} dp={2} suffix="bp" />
        </Field>
        <Field label="Curve tilt" hint="Shades the front against the back when 2s10s is lopsided">
          <Num value={cfg.curveSkewBp} onChange={v => set({ curveSkewBp: v })} step={0.05} min={0} max={3} dp={2} suffix="bp" />
        </Field>
        <Field label="Toxicity widen" hint="Extra edge as measured adverse selection rises">
          <Num value={cfg.toxicityWiden} onChange={v => set({ toxicityWiden: v })} step={0.1} min={0} max={3} dp={1} />
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <span style={{ ...LABEL, fontSize: 8 }}>Measured toxicity</span>
          <div style={{ flex: 1, height: 3, background: alpha(T.muted, 20) }}>
            <div style={{ height: '100%', width: `${eng.toxicity * 100}%`, background: eng.toxicity > 0.5 ? BAD : alpha(T.gold, 70) }} />
          </div>
          <span style={{ ...MONO, fontSize: 9, color: T.muted }}>{(eng.toxicity * 100).toFixed(0)}%</span>
        </div>
      </Panel>

      <Panel title="Execution">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <Stat label="Quoted nodes" value={String(s.quotedNodes)} size={12} />
          <Stat label="Fill rate" value={`${fillRate.toFixed(0)}%`} size={12}
            color={fillRate > 20 ? GOOD : T.text} />
          <Stat label="Edge captured" value={`${avgEdge.toFixed(2)} bp`} size={12}
            color={avgEdge > 0 ? GOOD : T.muted} />
          <Stat label="Of intended" value={`${capture.toFixed(0)}%`} size={12} />
          <Stat label="Notional done" value={`${Math.round(s.notional)}mm`} size={12} />
          <Stat label="Informed hits" value={String(s.informedFills)} size={12}
            color={s.informedFills > 0 ? BAD : T.muted} />
        </div>
        <div style={{ marginTop: 6, ...MONO, fontSize: 9, color: T.muted, lineHeight: 1.4 }}>
          Adverse selection cost {fmtMoney(-s.informedLoss)} across {s.informedFills} informed trades.
        </div>
      </Panel>

      <Panel title="Flow">
        <Field label="Enquiry rate" hint="Requests per simulated second at a neutral width">
          <Num value={cfg.arrivalRate} onChange={v => set({ arrivalRate: v })} step={0.1} min={0} max={12} dp={1} />
        </Field>
        <Field label="Average size">
          <Num value={cfg.avgSizeMM} onChange={v => set({ avgSizeMM: v })} step={1} min={1} max={100} suffix="mm" />
        </Field>
        <Field label="Informed share">
          <Num value={cfg.informedPct} onChange={v => set({ informedPct: v })} step={1} min={0} max={60} suffix="%" />
        </Field>
        <Field label="Width sensitivity" hint="How hard a wide quote loses the enquiry">
          <Num value={cfg.widthSens} onChange={v => set({ widthSens: v })} step={0.5} min={0} max={20} dp={1} />
        </Field>
      </Panel>

      <Panel title="Financing">
        <Field label="Repo" hint="Overnight financing paid on the book">
          <Num value={cfg.repoRate * 100} onChange={v => set({ repoRate: v / 100 })} step={0.05} min={0} max={15} dp={2} suffix="%" />
        </Field>
        <Field label="SOFR">
          <Num value={cfg.sofr * 100} onChange={v => set({ sofr: v / 100 })} step={0.05} min={0} max={15} dp={2} suffix="%" />
        </Field>
        <div style={{ marginTop: 4 }}>
          <Btn wide onClick={() => set({ repoRate: cfg.sofr })}>MATCH REPO TO SOFR</Btn>
        </div>
      </Panel>
    </div>
  )
}
