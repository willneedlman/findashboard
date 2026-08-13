/*
 * Options MM 2 — right column: risk and hedging.
 *
 * Four greek cards stay permanently visible because they are the binding
 * constraint. Clicking one traces that exposure through the chain. Exposure
 * breakdown and the stress grid share a tab so neither crowds the cards.
 */

import { useState } from 'react'
import { T, alpha } from '../../lib/theme'
import { Panel, Tabs, Field, Num, Toggle, Btn, LimitCard, MONO, LABEL, GOOD, BAD, WARN, pnlColor } from './ui'
import { fmtK } from './Chain'
import type { Highlight } from './Chain'
import { fmtMoney, type Config, type Mm2Engine } from '../../lib/mm2/engine'

const SPOT_MOVES = [-5, -3, -1, 0, 1, 3, 5]
const VOL_MOVES = [10, 5, 0, -5, -10]

export default function RightColumn({ eng, cfg, set, tick, highlight, onHighlight, live }: {
  eng: Mm2Engine; cfg: Config; set: (p: Partial<Config>) => void; tick: number
  highlight: Highlight; onHighlight: (h: Highlight) => void; live: boolean
}) {
  void tick
  const [tab, setTab] = useState<'exposure' | 'stress'>('exposure')
  const r = eng.risk()
  const back = eng.samples[Math.max(0, eng.samples.length - 61)]
  const d1m = (cur: number, prev: number | undefined) => (prev === undefined ? undefined : cur - prev)
  const toggle = (h: Highlight) => onHighlight(highlight === h ? 'none' : h)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', gap: 4 }}>
      <Panel title="Risk" right={<span style={{ ...MONO, fontSize: 8.5, color: T.muted }}>click to trace</span>} style={{ flex: '0 0 auto' }}>
        <LimitCard label="Net delta" unit="shares" value={r.delta} soft={cfg.deltaSoft} hard={cfg.deltaHard}
          fmt={fmtK} delta1m={d1m(r.delta, back?.netDelta)} onClick={() => toggle('delta')} active={highlight === 'delta'} />
        <LimitCard label="Net gamma" unit="shares/pt" value={r.gamma} soft={cfg.gammaSoft} hard={cfg.gammaHard}
          fmt={v => v.toFixed(1)} delta1m={d1m(r.gamma, back?.gamma)} onClick={() => toggle('gamma')} active={highlight === 'gamma'} />
        <LimitCard label="Net vega" unit="$/vol pt" value={r.vega} soft={cfg.vegaSoft} hard={cfg.vegaHard}
          fmt={fmtK} delta1m={d1m(r.vega, back?.vega)} onClick={() => toggle('vega')} active={highlight === 'vega'} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr' }}>
          <Minor label="Theta /day" value={fmtK(r.theta)} tone={pnlColor(r.theta)} onClick={() => toggle('theta')} active={highlight === 'theta'} />
          <Minor label="Contracts" value={String(r.contracts)} />
          <Minor label="Stock" value={fmtK(eng.stock)} />
        </div>
      </Panel>

      <Panel style={{ flex: '1 1 auto', minHeight: 130 }}>
        <Tabs tabs={[{ key: 'exposure', label: 'Exposure' }, { key: 'stress', label: 'Stress' }]}
          value={tab} onChange={setTab} />
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {tab === 'exposure'
            ? <RiskByDimension eng={eng} metric={highlight === 'none' || highlight === 'theta' ? 'delta' : highlight} />
            : <StressGrid eng={eng} />}
        </div>
      </Panel>

      <Panel title="Hedge" right={<Toggle value={cfg.autoHedge} onChange={v => set({ autoHedge: v })} on="AUTO" off="MANUAL" />}
        style={{ flex: '0 0 auto' }} scroll>
        <HedgePanel eng={eng} cfg={cfg} set={set} live={live} />
      </Panel>
    </div>
  )
}

function Minor({ label, value, tone, onClick, active }: {
  label: string; value: string; tone?: string; onClick?: () => void; active?: boolean
}) {
  return (
    <div onClick={onClick} style={{
      padding: '4px 7px', borderRight: `1px solid ${T.borderFaint}`, cursor: onClick ? 'pointer' : undefined,
      background: active ? alpha(T.gold, 10) : undefined,
      borderLeft: onClick ? `2px solid ${active ? T.gold : 'transparent'}` : undefined,
    }}>
      <span style={{ ...LABEL, fontSize: 8 }}>{label}</span>
      <div style={{ ...MONO, fontSize: 12, fontWeight: 600, color: tone ?? T.text }}>{value}</div>
    </div>
  )
}

function RiskByDimension({ eng, metric }: { eng: Mm2Engine; metric: 'delta' | 'gamma' | 'vega' }) {
  const [dim, setDim] = useState<'strike' | 'expiry' | 'kind'>('expiry')
  const data = eng.riskBy(dim, metric).sort((a, b) => (dim === 'strike' ? Number(a.label) - Number(b.label) : 0))
  const max = Math.max(1e-9, ...data.map(d => Math.abs(d.value)))
  return (
    <div style={{ padding: '4px 7px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <span style={{ ...LABEL, fontSize: 8 }}>{metric} by</span>
        <div style={{ display: 'flex', gap: 3 }}>
          {(['expiry', 'strike', 'kind'] as const).map(d => (
            <button key={d} onClick={() => setDim(d)} style={{
              ...MONO, fontSize: 8.5, padding: '0 6px', cursor: 'pointer',
              border: `1px solid ${dim === d ? alpha(T.gold, 45) : T.border}`,
              background: dim === d ? alpha(T.gold, 12) : 'transparent',
              color: dim === d ? T.gold : T.muted,
            }}>{d}</button>
          ))}
        </div>
      </div>
      {data.length === 0
        ? <p style={{ ...MONO, fontSize: 10, color: T.muted, margin: 0 }}>Flat book.</p>
        : data.map(d => (
          <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 5, height: 14 }}>
            <span style={{ ...MONO, fontSize: 9, color: T.muted, width: 40, textAlign: 'right', flexShrink: 0 }}>{d.label}</span>
            <div style={{ flex: 1, position: 'relative', height: 7, background: alpha(T.muted, 10) }}>
              <div style={{
                position: 'absolute', top: 0, bottom: 0,
                left: d.value < 0 ? `${50 - (Math.abs(d.value) / max) * 50}%` : '50%',
                width: `${(Math.abs(d.value) / max) * 50}%`,
                background: d.value > 0 ? alpha(GOOD, 70) : alpha(BAD, 70),
              }} />
              <div style={{ position: 'absolute', left: '50%', top: -1, bottom: -1, width: 1, background: alpha(T.text, 28) }} />
            </div>
            <span style={{ ...MONO, fontSize: 9, color: pnlColor(d.value), width: 46, textAlign: 'right', flexShrink: 0 }}>{fmtK(d.value)}</span>
          </div>
        ))}
    </div>
  )
}

function StressGrid({ eng }: { eng: Mm2Engine }) {
  const grid = eng.stress(SPOT_MOVES, VOL_MOVES)
  let worst = Infinity, wr = 0, wc = 0
  grid.forEach((row, i) => row.forEach((v, j) => { if (v < worst) { worst = v; wr = i; wc = j } }))
  const mag = Math.max(1e-9, ...grid.flat().map(Math.abs))

  return (
    <div style={{ padding: '3px 5px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...LABEL, fontSize: 7.5, padding: '2px 3px', textAlign: 'left', color: T.muted }}>vol</th>
            {SPOT_MOVES.map(s => (
              <th key={s} style={{ ...MONO, fontSize: 8.5, padding: '2px 3px', textAlign: 'right', color: T.muted }}>{s > 0 ? `+${s}` : s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, i) => (
            <tr key={VOL_MOVES[i]}>
              <td style={{ ...MONO, fontSize: 8.5, padding: '2px 3px', color: T.muted }}>{VOL_MOVES[i] > 0 ? `+${VOL_MOVES[i]}` : VOL_MOVES[i]}</td>
              {row.map((v, j) => {
                const isWorst = i === wr && j === wc
                return (
                  <td key={j} style={{
                    ...MONO, fontSize: 8.5, padding: '2px 3px', textAlign: 'right',
                    color: isWorst ? T.text : pnlColor(v), fontWeight: isWorst ? 700 : 400,
                    background: isWorst ? alpha(BAD, 40) : alpha(v >= 0 ? GOOD : BAD, Math.min(24, (Math.abs(v) / mag) * 24)),
                  }}>{fmtK(v)}</td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ ...MONO, fontSize: 9, color: T.muted, margin: '3px 2px' }}>
        Worst {fmtMoney(worst)} at {SPOT_MOVES[wc] > 0 ? '+' : ''}{SPOT_MOVES[wc]}% spot, {VOL_MOVES[wr] > 0 ? '+' : ''}{VOL_MOVES[wr]} vol.
      </p>
      <div style={{ borderTop: `1px solid ${T.borderFaint}`, paddingTop: 3 }}>
        {eng.scenarios().map(s => (
          <div key={s.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
            <span style={{ ...MONO, fontSize: 9, color: T.muted }}>{s.name}</span>
            <span style={{ ...MONO, fontSize: 9, color: pnlColor(s.pnl) }}>{fmtMoney(s.pnl)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function HedgePanel({ eng, cfg, set, live }: {
  eng: Mm2Engine; cfg: Config; set: (p: Partial<Config>) => void; live: boolean
}) {
  const p = eng.hedgeProposal()
  const ideas = eng.hedgeIdeas()
  const r = eng.risk()

  return (
    <div style={{ padding: '5px 8px' }}>
      <Field label="threshold shares"><Num value={cfg.hedgeThreshold} onChange={v => set({ hedgeThreshold: v })} step={50} min={0} width={58} /></Field>
      <Field label="target delta"><Num value={cfg.targetDelta} onChange={v => set({ targetDelta: v })} step={50} width={58} /></Field>

      <div style={{ marginTop: 4, borderTop: `1px solid ${T.borderFaint}`, paddingTop: 4 }}>
        {!p ? (
          <p style={{ ...MONO, fontSize: 9.5, color: T.muted, margin: 0, lineHeight: 1.45 }}>
            Net delta {fmtK(r.delta)} is inside the {cfg.minHedge} share minimum. Nothing to hedge.
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ ...MONO, fontSize: 10, color: T.gold, fontWeight: 700 }}>
                {p.qty > 0 ? 'BUY' : 'SELL'} {Math.abs(p.qty)} @ {p.px.toFixed(2)}
              </span>
              <span style={{ ...MONO, fontSize: 9.5, color: p.cost > 500 ? WARN : T.muted }}>{fmtMoney(p.cost, 2)}</span>
            </div>
            <div style={{ ...MONO, fontSize: 9.5, color: T.muted }}>
              delta {fmtK(p.deltaBefore)} to {fmtK(p.deltaAfter)}
            </div>
            <div style={{ marginTop: 4 }}>
              <Btn wide tone="gold" onClick={() => eng.executeHedge(true)} disabled={!live}>EXECUTE HEDGE</Btn>
            </div>
          </>
        )}
      </div>

      {ideas.length > 0 && (
        <div style={{ marginTop: 5, borderTop: `1px solid ${T.borderFaint}`, paddingTop: 4 }}>
          <span style={{ ...LABEL, fontSize: 8 }}>Option hedges</span>
          {ideas.map(i => (
            <div key={i.label} style={{ paddingTop: 2 }}>
              <div style={{ ...MONO, fontSize: 9.5, color: T.gold }}>{i.label}</div>
              <div style={{ ...MONO, fontSize: 9, color: T.muted }}>{i.risk} to {i.after}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 9, marginTop: 5, ...MONO, fontSize: 9, color: T.muted }}>
        <span>hedges {eng.stat.hedges}</span>
        <span>slippage {fmtMoney(eng.stat.hedgeCost)}</span>
      </div>
    </div>
  )
}
