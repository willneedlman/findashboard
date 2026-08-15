/*
 * Options MM Simulator — the quoting rail.
 *
 * Only the dials a maker actually turns while the session is running. Anything
 * configured once and left alone lives in the setup overlay instead, which is
 * what keeps this column readable at a glance.
 */

import { T, alpha } from '../../lib/theme'
import { Panel, Field, Num, Toggle, Btn, Seg, MONO, GOOD, WARN } from './ui'
import { fmtK } from './Chain'
import { DTES, type Config, type Mm2Engine, type EdgeMode } from '../../lib/mm2/engine'

export default function StrategyRail({ eng, cfg, set, onSetup, onMetrics }: {
  eng: Mm2Engine; cfg: Config; set: (p: Partial<Config>) => void
  onSetup: () => void; onMetrics: () => void
}) {
  const quoted = eng.stat.quotedContracts
  const scope = Math.max(1, eng.stat.scopeContracts)
  const width = eng.stat.widthN ? eng.stat.widthSum / eng.stat.widthN : 0

  // How much of what you quote is actually competitive. Quoting a lot badly and
  // quoting a little well look identical on a count alone.
  let inside = 0, quotedNow = 0
  for (let i = 0; i < eng.contracts.length; i++) {
    const q = eng.quotes[i]
    if (q.bidState !== 'active' || q.bidSize <= 0) continue
    quotedNow++
    if (q.bid >= eng.mktBid[i] - 1e-9 || q.ask <= eng.mktAsk[i] + 1e-9) inside++
  }
  const insidePct = quotedNow ? inside / quotedNow : 0

  return (
    <Panel title="Quoting" right={<Toggle value={cfg.quotingOn} onChange={v => set({ quotingOn: v })} />}>
      <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5 }}>
          <span style={{ ...MONO, fontSize: 10.5, color: T.muted }}>edge</span>
          <Seg<EdgeMode>
            options={[{ label: 'VOL', value: 'vol' }, { label: '$', value: 'dollar' }, { label: '%', value: 'pct' }]}
            value={cfg.edgeMode} onChange={v => set({ edgeMode: v })} size={8.5}
          />
          <Num value={cfg.baseEdge} onChange={v => set({ baseEdge: v })} step={0.05} dp={2} min={0} width={46} />
        </div>
        <Field label="spread ×"><Num value={cfg.spreadMult} onChange={v => set({ spreadMult: v })} step={0.1} dp={2} min={0} width={46} /></Field>
        <Field label="size"><Num value={cfg.baseSize} onChange={v => set({ baseSize: v })} step={5} min={1} width={46} /></Field>
        <Field label="inventory skew"><Num value={cfg.invSkewDelta} onChange={v => set({ invSkewDelta: v })} step={0.05} dp={2} min={0} width={46} /></Field>
      </div>

      <div style={{ padding: '7px 8px', borderTop: `1px solid ${T.borderFaint}` }}>
        <Field label="expiries"><Num value={cfg.quoteExpiries} onChange={v => set({ quoteExpiries: Math.round(v) })} step={1} min={1} max={DTES.length} width={46} /></Field>
        <Field label="strikes each side"><Num value={cfg.quoteWidth} onChange={v => set({ quoteWidth: Math.round(v) })} step={1} min={1} max={7} width={46} /></Field>
      </div>

      <div style={{ padding: '5px 8px', borderTop: `1px solid ${T.borderFaint}`, flex: 1, minHeight: 0 }}>
        <MeterRow label="quoted" value={`${quoted} / ${scope}`} frac={quoted / scope} color={GOOD} />
        <MeterRow label="inside market" value={`${(insidePct * 100).toFixed(0)}%`} frac={insidePct} color={T.blue} />
        <Live label="avg width" value={`$${width.toFixed(2)}`} />
        <Live label="toxicity" value={eng.toxicity.toFixed(2)} tone={eng.toxicity > 1.4 ? WARN : undefined} />
        <Live label="edge captured" value={fmtK(eng.attr.spread)} tone={eng.attr.spread >= 0 ? GOOD : undefined} />
      </div>

      <div style={{ padding: '7px 8px', borderTop: `1px solid ${T.borderFaint}`, display: 'flex', gap: 5 }}>
        <div style={{ flex: '1 1 0' }}><Btn wide tone="gold" onClick={onSetup}>SETUP</Btn></div>
        <div style={{ flex: '1 1 0' }}><Btn wide tone="gold" onClick={onMetrics}>METRICS</Btn></div>
      </div>
    </Panel>
  )
}

function MeterRow({ label, value, frac, color }: { label: string; value: string; frac: number; color: string }) {
  return (
    <div style={{ paddingBottom: 4 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
        <span style={{ ...MONO, fontSize: 10.5, color: T.muted }}>{label}</span>
        <span style={{ ...MONO, fontSize: 10.5, color: T.text }}>{value}</span>
      </div>
      <div style={{ height: 3, background: alpha(T.muted, 16), marginTop: 2 }}>
        <div style={{ height: '100%', width: `${Math.min(100, Math.max(0, frac) * 100)}%`, background: alpha(color, 70) }} />
      </div>
    </div>
  )
}

function Live({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, padding: '1px 0' }}>
      <span style={{ ...MONO, fontSize: 10.5, color: T.muted }}>{label}</span>
      <span style={{ ...MONO, fontSize: 10.5, color: tone ?? T.text }}>{value}</span>
    </div>
  )
}
