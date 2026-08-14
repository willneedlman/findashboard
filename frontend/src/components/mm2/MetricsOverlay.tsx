/*
 * Options MM 2 — the metrics overlay.
 *
 * Everything that answers "how did the session go" rather than "what do I do
 * now". It was a workbench tab competing with the chain for permanent space;
 * behind a button it can be read properly when it is actually wanted.
 */

import { T, alpha } from '../../lib/theme'
import { Overlay, MONO, LABEL } from './ui'
import { MULT, fmtMoney, type Mm2Engine } from '../../lib/mm2/engine'

export default function MetricsOverlay({ eng, onClose }: { eng: Mm2Engine; onClose: () => void }) {
  const s = eng.stat
  const n = Math.max(1, s.fillsN)
  const ct = Math.max(1, s.contractsTraded)
  const marked = Math.max(1, s.markedFills)
  const r = eng.risk()

  let vol = 0
  if (eng.samples.length > 5) {
    const d: number[] = []
    for (let i = 1; i < eng.samples.length; i++) d.push(eng.samples[i].total - eng.samples[i - 1].total)
    const m = d.reduce((a, b) => a + b, 0) / d.length
    vol = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length)
  }

  const groups: [string, [string, string][]][] = [
    ['Quoting', [
      ['Average quoted width', `$${(s.widthSum / Math.max(1, s.widthN)).toFixed(3)}`],
      ['Average intended edge', `$${(s.edgeIntended / ct / MULT).toFixed(3)}`],
      ['Average realized edge', `$${(s.edgeRealized / ct / MULT).toFixed(3)}`],
      ['Quote uptime', `${((s.quotedRefreshes / Math.max(1, s.refreshes)) * 100).toFixed(0)}%`],
      ['Chain quoted', `${s.quotedContracts} of ${s.scopeContracts}`],
      ['Messages sent', s.msgs.toLocaleString('en-US')],
      ['Throttled requotes', s.throttled.toLocaleString('en-US')],
      ['Quotes blocked by risk', s.blocked.toLocaleString('en-US')],
    ]],
    ['Execution', [
      ['Fills', String(s.fillsN)],
      ['Contracts traded', s.contractsTraded.toLocaleString('en-US')],
      ['Fill rate per order', `${((s.fillsN / Math.max(1, s.orders)) * 100).toFixed(1)}%`],
      ['Partial fills', `${((s.partials / n) * 100).toFixed(0)}%`],
      ['Average queue time', `${(s.queueMsTotal / n).toFixed(0)} ms`],
      ['Maker rebates', fmtMoney(eng.rebates, 2)],
      ['Cancel to fill ratio', (s.cancels / n).toFixed(1)],
      ['Hedge slippage paid', fmtMoney(s.hedgeCost, 2)],
    ]],
    ['Adverse selection', [
      ['Profitable fills', `${((s.winFills / marked) * 100).toFixed(0)}%`],
      ['Mark-out total, 30s', fmtMoney(eng.attr.adverse)],
      ['Fills to informed flow', String(s.informedFills)],
      ['Loss to informed flow', fmtMoney(s.informedLoss)],
      ['Toxicity index', eng.toxicity.toFixed(2)],
      ['Edge kept after 30s', `${(((s.edgeRealized + eng.attr.adverse) / Math.max(1, s.edgeRealized)) * 100).toFixed(0)}%`],
    ]],
    ['Performance', [
      ['Total P&L', fmtMoney(eng.totalPnl())],
      ['Realized', fmtMoney(eng.realized)],
      ['Unrealized', fmtMoney(eng.totalPnl() - eng.realized)],
      ['Max drawdown', fmtMoney(-eng.maxDrawdown)],
      ['P&L volatility per second', fmtMoney(vol, 2)],
      ['Profit per contract', fmtMoney(eng.totalPnl() / ct, 2)],
      ['Profit per vega unit', r.vega ? fmtMoney(eng.totalPnl() / Math.abs(r.vega), 2) : 'flat'],
      ['Spread capture', fmtMoney(eng.attr.spread)],
    ]],
  ]

  return (
    <Overlay title="Session metrics" onClose={onClose} width={880}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        {groups.map(([title, rows]) => (
          <div key={title} style={{
            padding: '10px 14px',
            borderRight: `1px solid ${T.borderFaint}`, borderBottom: `1px solid ${T.borderFaint}`,
          }}>
            <span style={{ ...LABEL, fontSize: 9, color: alpha(T.gold, 75) }}>{title}</span>
            <div style={{ marginTop: 4 }}>
              {rows.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '1.5px 0' }}>
                  <span style={{ ...MONO, fontSize: 11, color: T.muted }}>{k}</span>
                  <span style={{ ...MONO, fontSize: 11, color: T.text }}>{v}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Overlay>
  )
}
