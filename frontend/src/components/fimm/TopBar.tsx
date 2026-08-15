/*
 * Command bar for the rates desk.
 *
 * Three bands on one line: what the clock is doing, where the market is, and
 * what the book is carrying. The benchmark ticker sits between them because a
 * rates desk reads its own risk against the anchor rate, not against a spot.
 */

import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, Btn, Seg, GOOD, BAD, WARN, pnlColor } from '../mm2/ui'
import { fmtBp, fmtClock, fmtMoney, type FiEngine, type RiskState } from '../../lib/fimm/engine'

const SPEEDS = [1, 5, 10, 25, 100]

export default function TopBar({
  eng, risk, pnl, running, speed, status, statusColor,
  onRun, onSpeed, onReset, onFlatten, onKill, onClearKill,
}: {
  eng: FiEngine
  risk: RiskState
  pnl: number
  running: boolean
  speed: number
  status: string
  statusColor: string
  onRun: () => void
  onSpeed: (v: number) => void
  onReset: () => void
  onFlatten: () => void
  onKill: () => void
  onClearKill: () => void
}) {
  const bm = eng.benchmark()
  const carry = risk.carryPerDay + risk.rollPerDay
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '6px 12px', flexShrink: 0, height: 46,
      boxSizing: 'border-box', background: T.surface, border: `1px solid ${T.border}`,
      borderTop: `2px solid ${statusColor}`, overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 150 }}>
        <span style={{ ...LABEL, fontSize: 9, color: statusColor }}>{status}</span>
        <span style={{ ...MONO, fontSize: 14, fontWeight: 600, color: T.text }}>{fmtClock(eng.clock)}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Btn tone={running ? 'bad' : 'good'} onClick={onRun}>{running ? 'PAUSE' : 'RUN'}</Btn>
        <Seg options={SPEEDS.map(s => ({ label: `${s}x`, value: s }))} value={speed} onChange={onSpeed} size={9} />
        <Btn onClick={onReset}>RESET</Btn>
      </div>

      {/* Benchmark ticker: the anchor rate, the on-the-run 10Y and the curve. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingLeft: 12, borderLeft: `1px solid ${T.border}` }}>
        <Tick label="SOFR" value={`${(bm.sofr * 100).toFixed(2)}%`} />
        <Tick label="10Y" value={`${(bm.tenY * 100).toFixed(3)}%`}
          sub={fmtBp(bm.tenYChgBp)} subColor={bm.tenYChgBp >= 0 ? BAD : GOOD} />
        <Tick label="2s10s" value={`${bm.slope >= 0 ? '+' : ''}${bm.slope.toFixed(0)} bp`}
          color={bm.slope < 0 ? WARN : T.text} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginLeft: 'auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
          <span style={{ ...LABEL, fontSize: 8.5 }}>Total P&L</span>
          <span style={{ ...MONO, fontSize: 21, fontWeight: 700, color: pnlColor(pnl) }}>{fmtMoney(pnl)}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', ...MONO, fontSize: 10, lineHeight: 1.25 }}>
          <span style={{ color: T.muted }}>spread <span style={{ color: pnlColor(eng.attr.spread) }}>{fmtMoney(eng.attr.spread)}</span></span>
          <span style={{ color: T.muted }}>curve <span style={{ color: pnlColor(eng.attr.curve) }}>{fmtMoney(eng.attr.curve)}</span></span>
          <span style={{ color: T.muted }}>carry <span style={{ color: pnlColor(eng.attr.carry) }}>{fmtMoney(eng.attr.carry)}</span></span>
        </div>

        <Meter label="Net DV01" value={fmtMoney(risk.dv01)} unit="/bp"
          used={Math.abs(risk.dv01) / Math.max(eng.cfg.dv01Hard, 1)}
          soft={Math.abs(risk.dv01) > eng.cfg.dv01Soft} />
        <Meter label="Convexity" value={fmtMoney(risk.convexity)} unit="/bp²"
          used={Math.min(1, Math.abs(risk.convexity) / 40_000)} soft={false} />
        <Meter label="Carry/day" value={fmtMoney(carry)} unit=""
          used={Math.min(1, Math.abs(carry) / 30_000)} soft={carry < 0} tone={carry >= 0 ? GOOD : BAD} />

        <Btn onClick={onFlatten} title="Cross the street on every position and every hedge">FLATTEN BOOK</Btn>
        {eng.killed
          ? <Btn tone="good" onClick={onClearKill}>CLEAR KILL</Btn>
          : <button onClick={onKill} style={{
            ...MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', padding: '5px 14px',
            cursor: 'pointer', border: `1px solid ${BAD}`, background: alpha(BAD, 16), color: BAD,
          }}>KILL QUOTES</button>}
      </div>
    </header>
  )
}

function Tick({ label, value, sub, color, subColor }: {
  label: string; value: string; sub?: string; color?: string; subColor?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
      <span style={{ ...LABEL, fontSize: 8 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ ...MONO, fontSize: 12.5, fontWeight: 700, color: color ?? T.text }}>{value}</span>
        {sub && <span style={{ ...MONO, fontSize: 9, color: subColor ?? T.muted }}>{sub}</span>}
      </span>
    </div>
  )
}

/** A level and its limit usage in one chip, so the bar carries headroom too. */
function Meter({ label, value, unit, used, soft, tone }: {
  label: string; value: string; unit: string; used: number; soft: boolean; tone?: string
}) {
  const color = tone ?? (soft ? WARN : T.text)
  return (
    <div style={{ padding: '3px 9px', background: T.bg, border: `1px solid ${T.border}`, minWidth: 104 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ ...LABEL, fontSize: 8.5, color: soft ? WARN : T.muted }}>{label}</span>
        <span style={{ ...MONO, fontSize: 12, fontWeight: 700, color }}>{value}</span>
        <span style={{ ...MONO, fontSize: 8.5, color: T.muted, marginLeft: 'auto' }}>{unit}</span>
      </div>
      <div style={{ height: 2, background: alpha(T.muted, 20), marginTop: 3 }}>
        <div style={{ height: '100%', width: `${Math.min(100, used * 100)}%`, background: soft ? WARN : alpha(T.gold, 65) }} />
      </div>
    </div>
  )
}
