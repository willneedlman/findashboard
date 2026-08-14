/*
 * Options MM 2 — risk column.
 *
 * Three meters that carry the level, the one-minute move and the headroom on one
 * line each, because "how much room is left" is the question a maker actually
 * asks. Clicking one traces that greek through the chain.
 *
 * The stress grid is gone: it was a second-screen research tool competing with
 * the chain for a laptop's worth of pixels.
 */

import { useState } from 'react'
import { T, alpha } from '../../lib/theme'
import { Panel, Toggle, Btn, MONO, LABEL, GOOD, BAD, WARN, pnlColor } from './ui'
import { fmtK } from './Chain'
import type { Highlight } from './Chain'
import { fmtMoney, type Config, type Mm2Engine } from '../../lib/mm2/engine'

export default function RightColumn({ eng, cfg, set, tick, highlight, onHighlight, live }: {
  eng: Mm2Engine; cfg: Config; set: (p: Partial<Config>) => void; tick: number
  highlight: Highlight; onHighlight: (h: Highlight) => void; live: boolean
}) {
  void tick
  const r = eng.risk()
  const back = eng.samples[Math.max(0, eng.samples.length - 61)]
  const toggle = (h: Highlight) => onHighlight(highlight === h ? 'none' : h)

  return (
    // overflowY is a safety valve, not the plan: the three panels are budgeted to
    // fit, but a hidden EXECUTE HEDGE button is far worse than a scrollbar if a
    // short viewport or a longer breach block ever pushes them over.
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', gap: 4, overflowY: 'auto' }}>
      <Panel title="Risk limits" right={<span style={{ ...MONO, fontSize: 9, color: T.muted }}>click to trace</span>}
        style={{ flex: '0 0 auto' }}>
        <Meter label="Net delta" unit="shares" value={r.delta} prior={back?.netDelta}
          soft={cfg.deltaSoft} hard={cfg.deltaHard} fmt={fmtK}
          active={highlight === 'delta'} onClick={() => toggle('delta')} />
        <Meter label="Net gamma" unit="shares/pt" value={r.gamma} prior={back?.gamma}
          soft={cfg.gammaSoft} hard={cfg.gammaHard} fmt={v => v.toFixed(1)}
          active={highlight === 'gamma'} onClick={() => toggle('gamma')} />
        <Meter label="Net vega" unit="$/vol pt" value={r.vega} prior={back?.vega}
          soft={cfg.vegaSoft} hard={cfg.vegaHard} fmt={fmtK}
          active={highlight === 'vega'} onClick={() => toggle('vega')} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
          <Cell label="Theta" value={fmtK(r.theta)} tone={pnlColor(r.theta)} onClick={() => toggle('theta')} active={highlight === 'theta'} />
          <Cell label="Options" value={String(r.contracts)} />
          <Cell label="Stock" value={fmtK(eng.stock)} />
        </div>
      </Panel>

      <Panel style={{ flex: '1 1 auto', minHeight: 90, overflow: 'hidden' }}>
        <Exposure eng={eng} metric={highlight === 'none' || highlight === 'theta' ? 'vega' : highlight} />
      </Panel>

      <Panel title="Hedge" right={<Toggle value={cfg.autoHedge} onChange={v => set({ autoHedge: v })} on="AUTO" off="MANUAL" />}
        style={{ flex: '0 0 auto' }}>
        <Hedge eng={eng} cfg={cfg} live={live} />
      </Panel>
    </div>
  )
}

/** Level, one-minute move and headroom on one line; breach treatment on the whole block. */
function Meter({ label, unit, value, prior, soft, hard, fmt, active, onClick }: {
  label: string; unit: string; value: number; prior: number | undefined
  soft: number; hard: number; fmt: (v: number) => string
  active: boolean; onClick: () => void
}) {
  const used = Math.abs(value) / Math.max(hard, 1e-9)
  const breach = Math.abs(value) > hard
  const warn = !breach && Math.abs(value) > soft
  const tone = breach ? BAD : warn ? WARN : T.text
  const delta = prior === undefined ? null : value - prior

  return (
    <div onClick={onClick} style={{
      padding: '5px 9px', cursor: 'pointer', borderBottom: `1px solid ${T.borderFaint}`,
      borderLeft: `2px solid ${breach ? BAD : warn ? WARN : active ? T.gold : 'transparent'}`,
      background: breach ? alpha(BAD, 7) : warn ? alpha(WARN, 7) : active ? alpha(T.gold, 10) : undefined,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ ...LABEL, fontSize: 9, letterSpacing: '0.14em', color: breach || warn ? tone : T.muted }}>{label}</span>
        <span style={{ ...MONO, fontSize: 9, color: T.muted }}>{unit}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ ...MONO, fontSize: 16, fontWeight: 700, color: tone }}>{fmt(value)}</span>
        {delta !== null && (
          <span style={{ ...MONO, fontSize: 9.5, color: breach || warn ? tone : T.muted }}>
            {delta >= 0 ? '↑' : '↓'}{fmt(Math.abs(delta))} in 1m
          </span>
        )}
        <span style={{ ...MONO, fontSize: 9.5, color: breach || warn ? tone : T.muted, marginLeft: 'auto' }}>
          {(used * 100).toFixed(0)}% of {warn && !breach ? 'soft' : fmt(hard)}
        </span>
      </div>
      <div style={{ position: 'relative', height: 4, background: alpha(T.muted, 18), marginTop: 3 }}>
        <div style={{ position: 'absolute', inset: 0, width: `${Math.min(100, used * 100)}%`, background: breach ? BAD : warn ? WARN : alpha(T.gold, 70) }} />
        <div style={{ position: 'absolute', top: -1, bottom: -1, left: `${Math.min(100, (soft / Math.max(hard, 1e-9)) * 100)}%`, width: 1, background: alpha(T.text, 55) }} />
      </div>
    </div>
  )
}

function Cell({ label, value, tone, onClick, active }: {
  label: string; value: string; tone?: string; onClick?: () => void; active?: boolean
}) {
  return (
    <div onClick={onClick} style={{
      padding: '4px 8px', borderRight: `1px solid ${T.borderFaint}`, cursor: onClick ? 'pointer' : undefined,
      background: active ? alpha(T.gold, 10) : undefined,
    }}>
      <div style={{ ...LABEL, fontSize: 8.5, letterSpacing: '0.14em' }}>{label}</div>
      <div style={{ ...MONO, fontSize: 12.5, fontWeight: 600, color: tone ?? T.text }}>{value}</div>
    </div>
  )
}

/** Where the traced greek actually sits, with the concentration called out in words. */
function Exposure({ eng, metric }: { eng: Mm2Engine; metric: 'delta' | 'gamma' | 'vega' }) {
  const [dim, setDim] = useState<'expiry' | 'strike' | 'kind'>('expiry')
  const data = eng.riskBy(dim, metric).sort((a, b) => (dim === 'strike' ? Number(a.label) - Number(b.label) : 0))
  const max = Math.max(1e-9, ...data.map(d => Math.abs(d.value)))
  const gross = data.reduce((sum, d) => sum + Math.abs(d.value), 0)
  const top = data.reduce((best, d) => (Math.abs(d.value) > Math.abs(best?.value ?? 0) ? d : best), data[0])

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
        padding: '5px 8px', borderBottom: `1px solid ${T.borderFaint}`, flexShrink: 0,
        background: alpha(T.gold, 4),
      }}>
        <span style={{ ...LABEL, fontSize: 9, color: alpha(T.gold, 70) }}>{metric} by {dim}</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {(['expiry', 'strike', 'kind'] as const).map(d => (
            <button key={d} onClick={() => setDim(d)} style={{
              ...MONO, fontSize: 8.5, padding: '1px 6px', cursor: 'pointer',
              border: `1px solid ${dim === d ? alpha(T.gold, 45) : T.border}`,
              background: dim === d ? alpha(T.gold, 12) : 'transparent',
              color: dim === d ? T.gold : T.muted,
            }}>{d === 'expiry' ? 'EXP' : d === 'strike' ? 'K' : 'C/P'}</button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '7px 9px' }}>
        {data.length === 0 ? (
          <p style={{ ...MONO, fontSize: 10, color: T.muted, margin: 0 }}>Flat book.</p>
        ) : (
          <>
            {data.map(d => (
              <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 14 }}>
                <span style={{ ...MONO, fontSize: 9.5, color: T.muted, width: 38, textAlign: 'right', flexShrink: 0 }}>{d.label}</span>
                <div style={{ flex: 1, position: 'relative', height: 8, background: alpha(T.muted, 10) }}>
                  <div style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: d.value < 0 ? `${50 - (Math.abs(d.value) / max) * 50}%` : '50%',
                    width: `${(Math.abs(d.value) / max) * 50}%`,
                    background: d.value > 0 ? alpha(GOOD, 72) : alpha(BAD, 72),
                  }} />
                  <div style={{ position: 'absolute', left: '50%', top: -1, bottom: -1, width: 1, background: alpha(T.text, 28) }} />
                </div>
                <span style={{ ...MONO, fontSize: 9.5, color: pnlColor(d.value), width: 44, textAlign: 'right', flexShrink: 0 }}>{fmtK(d.value)}</span>
              </div>
            ))}
            {top && gross > 0 && (
              <p style={{ ...MONO, fontSize: 9.5, color: alpha(T.muted, 85), margin: '5px 0 0' }}>
                {top.label} carries {((Math.abs(top.value) / gross) * 100).toFixed(0)}% of it.
              </p>
            )}
          </>
        )}
      </div>
    </>
  )
}

function Hedge({ eng, cfg, live }: { eng: Mm2Engine; cfg: Config; live: boolean }) {
  const p = eng.hedgeProposal()
  const r = eng.risk()
  return (
    <div style={{ padding: '6px 9px' }}>
      {!p ? (
        <p style={{ ...MONO, fontSize: 10, color: T.text, margin: 0, lineHeight: 1.45 }}>
          Delta {fmtK(r.delta)} is inside the {cfg.hedgeThreshold} threshold.
        </p>
      ) : (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
            <span style={{ ...MONO, fontSize: 10.5, color: T.gold, fontWeight: 700 }}>
              {p.qty > 0 ? 'BUY' : 'SELL'} {Math.abs(p.qty)} @ {p.px.toFixed(2)}
            </span>
            <span style={{ ...MONO, fontSize: 9.5, color: p.cost > 500 ? WARN : T.muted }}>{fmtMoney(p.cost, 2)}</span>
          </div>
          <div style={{ ...MONO, fontSize: 9.5, color: T.muted }}>delta {fmtK(p.deltaBefore)} to {fmtK(p.deltaAfter)}</div>
          <div style={{ marginTop: 4 }}>
            <Btn wide tone="gold" onClick={() => eng.executeHedge(true)} disabled={!live}>EXECUTE HEDGE</Btn>
          </div>
        </>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 5, ...MONO, fontSize: 9.5, color: T.muted }}>
        <span>hedges {eng.stat.hedges}</span>
        <span>slippage {fmtMoney(eng.stat.hedgeCost)}</span>
      </div>
    </div>
  )
}
