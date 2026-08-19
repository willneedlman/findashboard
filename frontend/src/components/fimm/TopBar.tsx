/*
 * Command bar for the rates desk (height 46).
 *
 * Carries limit usage, not just levels: a headline net DV01 says nothing about
 * how much room is left before the desk has to stop. Each chip pairs the value
 * with a track showing how far into its limit the book already is.
 *
 * The benchmark ticker used to live here and now sits on the matrix header. A
 * rates desk reads its own risk against the anchor rate, so the anchor belongs
 * on the instrument panel, and folding it out is where the vertical budget for
 * the taller bottom pane came from.
 */

import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, Btn, Seg, BAD, WARN, pnlColor } from '../mm2/ui'
import { fmtClock, fmtMoney, type FiEngine, type RiskState } from '../../lib/fimm/engine'
import ShellActions from '../ShellActions'

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
  const carry = risk.carryPerDay + risk.rollPerDay
  return (
    <header style={{
      display: 'flex', alignItems: 'center', gap: 9, padding: '6px 10px', flexShrink: 0, height: 46,
      boxSizing: 'border-box', background: T.surface, border: `1px solid ${T.border}`,
      borderTop: `2px solid ${statusColor}`, overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 176 }}>
        <span style={{ ...LABEL, fontSize: 9, letterSpacing: '0.16em', color: statusColor }}>{status}</span>
        <span style={{ ...MONO, fontSize: 14, fontWeight: 600, color: T.text }}>{fmtClock(eng.clock)}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Btn tone={running ? 'bad' : 'good'} onClick={onRun}>{running ? 'PAUSE' : 'RUN'}</Btn>
        <Seg options={SPEEDS.map(s => ({ label: `${s}x`, value: s }))} value={speed} onChange={onSpeed} size={9} />
        <Btn onClick={onReset}>RESET</Btn>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginLeft: 'auto' }}>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
          <span style={{ ...LABEL, fontSize: 8.5, letterSpacing: '0.16em' }}>Total P&L</span>
          <span style={{ ...MONO, fontSize: 21, fontWeight: 700, color: pnlColor(pnl) }}>{fmtMoney(pnl)}</span>
        </div>

        {/* Where the money came from, at a glance. The full five-book split is
            on the attribution cell in the bottom pane. */}
        <div style={{ display: 'flex', flexDirection: 'column', ...MONO, fontSize: 9.5, lineHeight: 1.24, whiteSpace: 'nowrap' }}>
          <span style={{ color: T.muted }}>spread <span style={{ color: pnlColor(eng.attr.spread) }}>{fmtMoney(eng.attr.spread)}</span></span>
          <span style={{ color: T.muted }}>curve <span style={{ color: pnlColor(eng.attr.curve) }}>{fmtMoney(eng.attr.curve)}</span></span>
          <span style={{ color: T.muted }}>carry <span style={{ color: pnlColor(eng.attr.carry) }}>{fmtMoney(eng.attr.carry)}</span></span>
        </div>

        <LimitChip label="Net DV01" value={fmtMoney(risk.dv01)} unit="/bp"
          used={Math.abs(risk.dv01) / Math.max(eng.cfg.dv01Hard, 1)}
          warn={Math.abs(risk.dv01) > eng.cfg.dv01Soft} />
        <LimitChip label="Convexity" value={fmtMoney(risk.convexity)} unit="/bp²" minWidth={100}
          used={Math.min(1, Math.abs(risk.convexity) / 40_000)} warn={false} />
        {/* Negative carry is a soft-limit state in its own right: a book paying
            to be held overnight has to earn that back in spread every day. */}
        <LimitChip label="Carry/day" value={fmtMoney(carry)} unit=""
          used={Math.min(1, Math.abs(carry) / 30_000)} warn={carry < 0} />

        <Btn onClick={onFlatten} title="Cross the street on every position and every hedge">FLATTEN BOOK</Btn>
        {eng.killed
          ? <Btn tone="good" onClick={onClearKill}>CLEAR KILL</Btn>
          : <button onClick={onKill} style={{
            ...MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', padding: '5px 14px',
            cursor: 'pointer', border: `1px solid ${BAD}`, background: alpha(BAD, 16), color: BAD,
          }}>KILL</button>}
        <ShellActions />
      </div>
    </header>
  )
}

/**
 * Level and headroom in one chip.
 *
 * Over the soft limit the whole chip goes warn, panel fill included, so a
 * breach is visible from across the desk rather than needing the number read.
 */
export function LimitChip({ label, value, unit, used, warn, minWidth = 104 }: {
  label: string; value: string; unit: string; used: number; warn: boolean; minWidth?: number
}) {
  const tone = warn ? WARN : T.text
  return (
    <div style={{
      padding: '3px 9px', minWidth, boxSizing: 'border-box',
      background: warn ? alpha(WARN, 7) : T.bg,
      border: `1px solid ${warn ? alpha(WARN, 40) : T.border}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ ...LABEL, fontSize: 8.5, letterSpacing: '0.14em', color: warn ? WARN : T.muted }}>{label}</span>
        <span style={{ ...MONO, fontSize: 12, fontWeight: 700, color: tone }}>{value}</span>
        {unit && <span style={{ ...MONO, fontSize: 8.5, color: T.muted, marginLeft: 'auto' }}>{unit}</span>}
      </div>
      <div style={{ height: 2, background: alpha(T.muted, 20), marginTop: 3 }}>
        <div style={{ height: '100%', width: `${Math.min(100, used * 100)}%`, background: warn ? WARN : alpha(T.gold, 65) }} />
      </div>
    </div>
  )
}
