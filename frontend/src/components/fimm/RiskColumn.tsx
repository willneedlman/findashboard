/*
 * Right column: where the risk actually sits, and the engine that flattens it.
 *
 * The headline net DV01 on the command bar can read flat while the book is
 * fully exposed to the curve. That is what the bucket meters and the curve and
 * fly rows are for, and it is why they are three panels rather than one number.
 */

import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, Panel, Toggle, Btn, GOOD, BAD, WARN } from '../mm2/ui'
import {
  HEDGE_FUTURES, fmtMoney, type Bucket, type Config, type FiEngine, type RiskState,
} from '../../lib/fimm/engine'

/** At four fifths of a limit the desk wants to know before it gets there. */
const WARN_AT = 0.8

export default function RiskColumn({ eng, cfg, set, risk, tick, onTick, traced, onTrace }: {
  eng: FiEngine
  cfg: Config
  set: (patch: Partial<Config>) => void
  risk: RiskState
  tick: number
  onTick: () => void
  traced: Bucket | null
  onTrace: (b: Bucket | null) => void
}) {
  const proposal = eng.hedgeProposal()
  const buckets: { key: Bucket; label: string; note: string }[] = [
    { key: 'front', label: 'Front end', note: '3M to 3Y' },
    { key: 'belly', label: 'Belly', note: '5Y and 7Y' },
    { key: 'long', label: 'Long end', note: '10Y to 30Y' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: '100%', minHeight: 0 }}>
      <Panel title="DV01 by bucket" right={<Hint>click to trace</Hint>} style={{ flex: '0 0 auto' }}>
        {buckets.map(b => (
          <BucketMeter key={b.key} label={b.label} note={b.note}
            value={risk.byBucket[b.key]} limit={eng.bucketLimit(b.key)}
            active={traced === b.key}
            onClick={() => onTrace(traced === b.key ? null : b.key)} />
        ))}
        <div style={{ display: 'flex', alignItems: 'baseline', padding: '4px 9px' }}>
          <span style={{ ...LABEL, fontSize: 9, letterSpacing: '0.14em' }}>Net</span>
          <span style={{ ...MONO, fontSize: 13, fontWeight: 700, marginLeft: 'auto', color: tone(risk.dv01, cfg.dv01Soft) }}>
            {fmtMoney(risk.dv01)}
          </span>
          <span style={{ ...MONO, fontSize: 9, color: T.muted, marginLeft: 4 }}>/bp</span>
        </div>
      </Panel>

      <Panel title="Curve and fly" right={<Hint>DV01 equivalent</Hint>} style={{ flex: '0 0 auto' }}>
        <div style={{ padding: '6px 9px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Diverging label="2s10s" value={risk.slope2s10s} limit={cfg.slopeDv01Limit} />
          <Diverging label="5s30s" value={risk.slope5s30s} limit={cfg.slopeDv01Limit} />
          <Diverging label="2s5s10s" value={risk.fly2s5s10s} limit={cfg.flyDv01Limit} />
          {/* The sign, the value and the bar direction already say steepener or
              flattener, so the sentence says the thing they cannot. */}
          {Math.abs(risk.dv01) < cfg.hedgeThreshold && Math.abs(risk.slope2s10s) > cfg.slopeDv01Limit / 2 && (
            <div style={{ ...MONO, fontSize: 9.5, color: alpha(T.muted, 85), marginTop: 2 }}>
              Net DV01 reads flat. The book is not.
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="Hedge"
        right={<Toggle value={cfg.autoHedge} onChange={v => set({ autoHedge: v })} on="AUTO" off="MANUAL" />}
        style={{ flex: '1 1 auto', minHeight: 0, overflow: 'hidden' }}
      >
        <div style={{ padding: '5px 9px', display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ ...MONO, fontSize: 10, color: T.text, lineHeight: 1.4 }}>
            {proposal
              ? `${proposal.lots > 0 ? 'Buy' : 'Sell'} ${Math.abs(proposal.lots)} ${proposal.code} at ${proposal.price.toFixed(3)}, taking ${fmtMoney(proposal.dv01Before)} to ${fmtMoney(proposal.dv01After)} per bp.`
              : `Net DV01 is inside the ${cfg.hedgeThreshold.toLocaleString()} threshold. Nothing to hedge.`}
          </div>
          <div style={{ ...MONO, fontSize: 9.5, color: T.muted, display: 'flex', gap: 12 }}>
            <span>hedges {eng.stat.hedges}</span>
            <span>slippage {fmtMoney(eng.stat.hedgeSlippage)}</span>
          </div>

          {proposal && (
            <Btn wide tone="gold" onClick={() => { eng.executeHedge(true); onTick() }}>HEDGE NOW</Btn>
          )}

          {/* Only the lines that are actually on. The full six-contract list is
              in Metrics; six rows of em-dashes told the trader nothing. */}
          {HEDGE_FUTURES.filter(f => eng.hedges[f.code]).map(f => {
            const lots = eng.hedges[f.code]
            return (
              <div key={f.code} style={{
                display: 'flex', alignItems: 'baseline', gap: 6, paddingTop: 5,
                borderTop: `1px solid ${T.borderFaint}`,
              }}>
                <span style={{ ...MONO, fontSize: 10, color: T.muted }}>{f.code} {f.label}</span>
                <span style={{ ...MONO, fontSize: 11, fontWeight: 700, marginLeft: 'auto', color: lots > 0 ? GOOD : BAD }}>
                  {lots > 0 ? '+' : ''}{lots}
                </span>
                <span style={{ ...MONO, fontSize: 8.5, color: T.muted }}>${f.dv01}/bp</span>
              </div>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}

const Hint = ({ children }: { children: React.ReactNode }) => (
  <span style={{ ...MONO, fontSize: 9, color: T.muted }}>{children}</span>
)

const tone = (v: number, soft: number) => (Math.abs(v) > soft ? WARN : T.text)

/**
 * A bucket meter, three lines.
 *
 * The track is centred and the fill grows left for a short bucket and right for
 * a long one, which is what a signed limit is actually about: a headline
 * magnitude cannot tell you which way you are wrong.
 */
function BucketMeter({ label, note, value, limit, active, onClick }: {
  label: string; note: string; value: number; limit: number; active: boolean; onClick: () => void
}) {
  const use = Math.abs(value) / Math.max(limit, 1)
  const breach = use >= 1
  const warn = !breach && use >= WARN_AT
  const stripe = active ? T.gold : breach ? BAD : warn ? WARN : 'transparent'
  const fg = breach ? BAD : warn ? WARN : T.text

  return (
    <div onClick={onClick} style={{
      padding: '3px 9px', cursor: 'pointer',
      borderBottom: `1px solid ${T.borderFaint}`,
      borderLeft: `2px solid ${stripe}`,
      background: breach ? alpha(BAD, 7) : warn ? alpha(WARN, 7) : active ? alpha(T.gold, 8) : 'transparent',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ ...LABEL, fontSize: 9, letterSpacing: '0.14em', color: breach || warn ? fg : T.muted }}>{label}</span>
        <span style={{ ...MONO, fontSize: 9, color: T.muted, marginLeft: 'auto' }}>{note}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ ...MONO, fontSize: 14, fontWeight: 700, color: fg }}>{fmtMoney(value)}</span>
        <span style={{ ...MONO, fontSize: 9.5, color: breach || warn ? fg : T.muted, marginLeft: 'auto' }}>
          {Math.round(use * 100)}% of {short(limit)}
        </span>
      </div>
      <CenteredTrack value={value} limit={limit} height={4} fill={breach ? BAD : warn ? WARN : alpha(T.gold, 70)} />
    </div>
  )
}

function Diverging({ label, value, limit }: { label: string; value: number; limit: number }) {
  const over = Math.abs(value) > limit
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ ...MONO, fontSize: 10.5, color: T.muted, width: 52 }}>{label}</span>
        <span style={{ ...MONO, fontSize: 11.5, fontWeight: 700, marginLeft: 'auto', color: over ? WARN : T.text }}>
          {fmtMoney(value)}
        </span>
      </div>
      <CenteredTrack value={value} limit={limit} height={3}
        fill={over ? WARN : value >= 0 ? alpha(GOOD, 60) : alpha(BAD, 60)} />
    </div>
  )
}

/** Zero in the middle, so the direction of the risk is the direction of the bar. */
function CenteredTrack({ value, limit, height, fill }: {
  value: number; limit: number; height: number; fill: string
}) {
  const use = Math.min(1, Math.abs(value) / Math.max(limit, 1))
  return (
    <div style={{ position: 'relative', height, background: alpha(T.muted, 18), marginTop: 3 }}>
      <div style={{
        position: 'absolute', top: 0, bottom: 0,
        left: value >= 0 ? '50%' : `${50 - use * 50}%`,
        width: `${use * 50}%`, background: fill,
      }} />
      <div style={{ position: 'absolute', top: -1, bottom: -1, left: '50%', width: 1, background: alpha(T.text, 45) }} />
    </div>
  )
}

const short = (n: number) => (Math.abs(n) >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
