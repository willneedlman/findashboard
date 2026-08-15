/*
 * Right column: where the risk actually sits, and the engine that flattens it.
 *
 * The headline net DV01 on the top bar can read flat while the book is fully
 * exposed to the curve, which is why the buckets and the slope and fly lines
 * are here rather than folded into one number.
 */

import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, Panel, Field, Num, Toggle, Btn, GOOD, BAD, WARN } from '../mm2/ui'
import {
  HEDGE_FUTURES, fmtMoney, type Bucket, type Config, type FiEngine, type RiskState,
} from '../../lib/fimm/engine'

export default function RiskColumn({ eng, cfg, set, risk, tick, onTick }: {
  eng: FiEngine
  cfg: Config
  set: (patch: Partial<Config>) => void
  risk: RiskState
  tick: number
  onTick: () => void
}) {
  const proposal = eng.hedgeProposal()
  const buckets: { key: Bucket; label: string; note: string }[] = [
    { key: 'front', label: 'Front end', note: '3M to 3Y' },
    { key: 'belly', label: 'Belly', note: '5Y and 7Y' },
    { key: 'long', label: 'Long end', note: '10Y to 30Y' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: '100%', minHeight: 0, overflow: 'auto' }}>
      <Panel title="DV01 by bucket">
        {buckets.map(b => (
          <BucketBar key={b.key} label={b.label} note={b.note}
            value={risk.byBucket[b.key]} limit={eng.bucketLimit(b.key)} />
        ))}
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between' }}>
          <span style={{ ...LABEL, fontSize: 8.5 }}>Net</span>
          <span style={{ ...MONO, fontSize: 12, fontWeight: 700, color: tone(risk.dv01, cfg.dv01Soft) }}>
            {fmtMoney(risk.dv01)}/bp
          </span>
        </div>
      </Panel>

      <Panel title="Curve and fly">
        <Exposure label="2s10s" value={risk.slope2s10s} limit={cfg.slopeDv01Limit}
          hint={risk.slope2s10s > 0 ? 'net steepener' : risk.slope2s10s < 0 ? 'net flattener' : 'flat'} />
        <Exposure label="5s30s" value={risk.slope5s30s} limit={cfg.slopeDv01Limit}
          hint={risk.slope5s30s > 0 ? 'net steepener' : risk.slope5s30s < 0 ? 'net flattener' : 'flat'} />
        <Exposure label="2s5s10s" value={risk.fly2s5s10s} limit={cfg.flyDv01Limit}
          hint={risk.fly2s5s10s > 0 ? 'long the belly' : risk.fly2s5s10s < 0 ? 'short the belly' : 'flat'} />
        <div style={{ marginTop: 6, ...MONO, fontSize: 9, color: T.muted, lineHeight: 1.4 }}>
          Net convexity {fmtMoney(risk.convexity)} per basis point squared.
        </div>
      </Panel>

      <Panel title="Carry">
        <Line label="Coupon less repo" value={fmtMoney(risk.carryPerDay)} tone={risk.carryPerDay >= 0 ? GOOD : BAD} />
        <Line label="Roll-down" value={fmtMoney(risk.rollPerDay)} tone={risk.rollPerDay >= 0 ? GOOD : BAD} />
        <Line label="Net per day" value={fmtMoney(risk.carryPerDay + risk.rollPerDay)}
          tone={risk.carryPerDay + risk.rollPerDay >= 0 ? GOOD : BAD} strong />
      </Panel>

      <Panel title="Hedge engine" right={<Toggle value={cfg.autoHedge} onChange={v => set({ autoHedge: v })} on="AUTO" off="MANUAL" />}>
        <Field label="Threshold" hint="Net DV01 the hedger tolerates before acting">
          <Num value={cfg.hedgeThreshold} onChange={v => set({ hedgeThreshold: v })} step={250} min={0} max={40_000} suffix="/bp" />
        </Field>
        <Field label="Target DV01">
          <Num value={cfg.targetDv01} onChange={v => set({ targetDv01: v })} step={1_000} min={-50_000} max={50_000} suffix="/bp" />
        </Field>
        <Field label="Slippage" hint="Ticks paid crossing the futures screen">
          <Num value={cfg.hedgeSlippageTicks} onChange={v => set({ hedgeSlippageTicks: v })} step={0.25} min={0} max={4} dp={2} />
        </Field>

        <div style={{
          marginTop: 6, padding: '5px 7px', background: T.bg,
          border: `1px solid ${proposal ? alpha(T.gold, 45) : T.border}`,
        }}>
          {proposal ? (
            <>
              <div style={{ ...MONO, fontSize: 10.5, color: T.text }}>
                {proposal.lots > 0 ? 'Buy' : 'Sell'} {Math.abs(proposal.lots)} {proposal.code} at {proposal.price.toFixed(3)}
              </div>
              <div style={{ ...MONO, fontSize: 9, color: T.muted, marginTop: 2 }}>
                {fmtMoney(proposal.dv01Before)} to {fmtMoney(proposal.dv01After)} per bp
              </div>
            </>
          ) : (
            <div style={{ ...MONO, fontSize: 9.5, color: T.muted }}>
              Inside the threshold. Nothing to hedge.
            </div>
          )}
        </div>
        <div style={{ marginTop: 4 }}>
          <Btn wide tone="gold" disabled={!proposal}
            onClick={() => { eng.executeHedge(true); onTick() }}>HEDGE NOW</Btn>
        </div>
      </Panel>

      <Panel title="Futures held">
        {HEDGE_FUTURES.map(f => {
          const lots = eng.hedges[f.code] ?? 0
          return (
            <div key={f.code} style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '1px 0' }}>
              <span style={{ ...MONO, fontSize: 10, color: lots ? T.text : T.muted, width: 34 }}>{f.code}</span>
              <span style={{ ...MONO, fontSize: 9, color: T.muted, flex: 1 }}>{f.label}</span>
              <span style={{ ...MONO, fontSize: 10, color: lots > 0 ? GOOD : lots < 0 ? BAD : T.muted }}>
                {lots ? `${lots > 0 ? '+' : ''}${lots}` : '—'}
              </span>
              <span style={{ ...MONO, fontSize: 8.5, color: T.muted, width: 46, textAlign: 'right' }}>
                ${f.dv01}/bp
              </span>
            </div>
          )
        })}
        <div style={{ marginTop: 6, ...MONO, fontSize: 9, color: T.muted, lineHeight: 1.4 }}>
          {eng.stat.hedges} hedges, {fmtMoney(-eng.stat.hedgeSlippage)} in slippage.
        </div>
      </Panel>
    </div>
  )
}

const tone = (v: number, soft: number) => Math.abs(v) > soft ? WARN : T.text

function BucketBar({ label, note, value, limit }: {
  label: string; note: string; value: number; limit: number
}) {
  const used = Math.min(1, Math.abs(value) / Math.max(limit, 1))
  const over = Math.abs(value) > limit
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ ...LABEL, fontSize: 8.5, color: over ? WARN : T.muted }}>{label}</span>
        <span style={{ ...MONO, fontSize: 8, color: T.muted }}>{note}</span>
        <span style={{ ...MONO, fontSize: 11, fontWeight: 700, marginLeft: 'auto', color: over ? WARN : value >= 0 ? T.text : BAD }}>
          {fmtMoney(value)}
        </span>
      </div>
      {/* The track is centred so a short bucket reads left and a long reads
          right, which is what a bucketed limit is actually about. */}
      <div style={{ position: 'relative', height: 4, background: alpha(T.muted, 18), marginTop: 3 }}>
        <div style={{ position: 'absolute', left: '50%', top: -1, bottom: -1, width: 1, background: alpha(T.muted, 45) }} />
        <div style={{
          position: 'absolute', top: 0, bottom: 0,
          left: value >= 0 ? '50%' : `${50 - used * 50}%`,
          width: `${used * 50}%`,
          background: over ? WARN : alpha(T.gold, 65),
        }} />
      </div>
    </div>
  )
}

function Exposure({ label, value, limit, hint }: {
  label: string; value: number; limit: number; hint: string
}) {
  const over = Math.abs(value) > limit
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '2px 0' }}>
      <span style={{ ...MONO, fontSize: 10.5, color: T.text, width: 58 }}>{label}</span>
      <span style={{ ...MONO, fontSize: 9, color: T.muted, flex: 1 }}>{hint}</span>
      <span style={{ ...MONO, fontSize: 11, fontWeight: 700, color: over ? WARN : T.text }}>{fmtMoney(value)}</span>
    </div>
  )
}

function Line({ label, value, tone: c, strong }: {
  label: string; value: string; tone: string; strong?: boolean
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '2px 0',
      borderTop: strong ? `1px solid ${T.border}` : undefined, marginTop: strong ? 4 : 0, paddingTop: strong ? 5 : 2,
    }}>
      <span style={{ ...LABEL, fontSize: 8.5 }}>{label}</span>
      <span style={{ ...MONO, fontSize: strong ? 12 : 11, fontWeight: strong ? 700 : 500, color: c }}>{value}</span>
    </div>
  )
}
