/*
 * Options MM 2 — the quoting rail.
 *
 * Only the dials a maker actually turns while the session is running. Anything
 * configured once and left alone lives in the setup overlay instead, which is
 * what keeps this column readable at a glance.
 */

import { T, alpha } from '../../lib/theme'
import { Panel, Field, Num, Toggle, Btn, Seg, MONO, LABEL, GOOD, WARN } from './ui'
import { fmtK } from './Chain'
import { DTES, type Config, type Mm2Engine, type EdgeMode } from '../../lib/mm2/engine'

export default function StrategyRail({ eng, cfg, set, onSetup }: {
  eng: Mm2Engine; cfg: Config; set: (p: Partial<Config>) => void
  onSetup: (tab?: 'market' | 'flow' | 'edge' | 'limits') => void
}) {
  const quoted = eng.stat.quotedContracts
  const scope = Math.max(1, eng.stat.scopeContracts)
  const width = eng.stat.widthN ? eng.stat.widthSum / eng.stat.widthN : 0
  const throttled = eng.msgWindow.length >= cfg.maxMsgRate

  return (
    <Panel title="Quoting" right={<Toggle value={cfg.quotingOn} onChange={v => set({ quotingOn: v })} />} scroll>
      <div style={{ padding: '6px 8px' }}>
        <Field label="edge" hint="Base edge, in the units selected below">
          <Num value={cfg.baseEdge} onChange={v => set({ baseEdge: v })} step={0.05} dp={2} min={0} width={58} />
        </Field>
        <Field label="units">
          <Seg<EdgeMode>
            options={[{ label: 'VOL', value: 'vol' }, { label: '$', value: 'dollar' }, { label: '%', value: 'pct' }]}
            value={cfg.edgeMode} onChange={v => set({ edgeMode: v })} size={9}
          />
        </Field>
        <Field label="spread ×" hint="Scales every widen term at once">
          <Num value={cfg.spreadMult} onChange={v => set({ spreadMult: v })} step={0.1} dp={2} min={0} width={58} />
        </Field>
        <Field label="size"><Num value={cfg.baseSize} onChange={v => set({ baseSize: v })} step={5} min={1} width={58} /></Field>
        <Field label="inventory skew" hint="How hard inventory pushes your whole market">
          <Num value={cfg.invSkewDelta} onChange={v => set({ invSkewDelta: v })} step={0.05} dp={2} min={0} width={58} />
        </Field>
        <Field label="refresh ms"><Num value={cfg.refreshMs} onChange={v => set({ refreshMs: v })} step={50} min={50} width={58} /></Field>
      </div>

      <div style={{ padding: '5px 8px', borderTop: `1px solid ${T.borderFaint}` }}>
        <span style={{ ...LABEL, fontSize: 8 }}>Scope</span>
        <Field label="expiries"><Num value={cfg.quoteExpiries} onChange={v => set({ quoteExpiries: Math.round(v) })} step={1} min={1} max={DTES.length} width={58} /></Field>
        <Field label="strikes each side"><Num value={cfg.quoteWidth} onChange={v => set({ quoteWidth: Math.round(v) })} step={1} min={1} max={7} width={58} /></Field>
      </div>

      <div style={{ padding: '5px 8px', borderTop: `1px solid ${T.borderFaint}` }}>
        <span style={{ ...LABEL, fontSize: 8 }}>Live</span>
        <Live label="quoted" value={`${quoted}/${scope}`} tone={quoted === 0 ? WARN : GOOD} />
        <Live label="avg width" value={`$${width.toFixed(2)}`} />
        <Live label="messages /s" value={String(eng.msgWindow.length)} tone={throttled ? WARN : undefined} />
        <Live label="toxicity" value={eng.toxicity.toFixed(2)} tone={eng.toxicity > 1.4 ? WARN : undefined} />
        <Live label="fills" value={String(eng.stat.fillsN)} />
        <Live label="edge captured" value={fmtK(eng.attr.spread)} />
      </div>

      <div style={{ padding: '6px 8px', borderTop: `1px solid ${T.borderFaint}`, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Btn wide onClick={() => onSetup('market')}>MARKET SETUP</Btn>
        <Btn wide onClick={() => onSetup('edge')}>EDGE MODEL</Btn>
        <Btn wide onClick={() => onSetup('limits')}>RISK LIMITS</Btn>
      </div>
    </Panel>
  )
}

function Live({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, padding: '1px 0' }}>
      <span style={{ ...MONO, fontSize: 10, color: alpha(T.muted, 78) }}>{label}</span>
      <span style={{ ...MONO, fontSize: 10, color: tone ?? T.text }}>{value}</span>
    </div>
  )
}
