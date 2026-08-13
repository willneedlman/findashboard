/*
 * Options MM 2 — the workbench.
 *
 * One pane, eight views. The book, the surface, the quote explanation and every
 * execution table used to fight for width simultaneously; putting them behind
 * tabs gives each one room to be readable, and selection stays shared so a tab
 * switch never loses your place.
 */

import { useState } from 'react'
import { T, alpha } from '../../lib/theme'
import { Panel, Tabs, MONO, LABEL, Empty, GOOD, BAD, WARN, pnlColor } from './ui'
import { fmtK } from './Chain'
import { BookBody, SurfaceBody, ContractBody } from './Center'
import { MULT, fmtClock, fmtMoney, type LegView, type Mm2Engine, type Sample } from '../../lib/mm2/engine'

type Tab = 'contract' | 'book' | 'surface' | 'fills' | 'orders' | 'metrics' | 'alerts' | 'log'

export default function Workbench({ eng, sel, onSel, tick, live, sample, leg }: {
  eng: Mm2Engine; sel: number; onSel: (ck: number) => void; tick: number
  live: boolean; sample: Sample | null; leg: LegView | null
}) {
  void tick
  const [tab, setTab] = useState<Tab>('contract')
  const alerts = eng.alerts.length
  const tabs: { key: Tab; label: string }[] = [
    { key: 'contract', label: 'Quote math' },
    { key: 'book', label: 'Book' },
    { key: 'surface', label: 'Surface' },
    { key: 'fills', label: `Fills ${eng.stat.fillsN}` },
    { key: 'orders', label: `Orders ${eng.orders.size}` },
    { key: 'metrics', label: 'Metrics' },
    { key: 'alerts', label: alerts ? `Alerts ${alerts}` : 'Alerts' },
    { key: 'log', label: 'Log' },
  ]

  return (
    <Panel style={{ minHeight: 0 }}>
      <Tabs tabs={tabs} value={tab} onChange={setTab}
        right={<span style={{ ...MONO, fontSize: 9, color: T.muted }}>{eng.label(sel)}</span>} />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'contract' && <ContractBody eng={eng} sel={sel} live={live} sample={sample} leg={leg} />}
        {tab === 'book' && <BookBody eng={eng} sel={sel} live={live} />}
        {tab === 'surface' && <SurfaceBody eng={eng} sel={sel} onSel={onSel} />}
        {tab === 'fills' && <Fills eng={eng} sample={sample} />}
        {tab === 'orders' && <Orders eng={eng} />}
        {tab === 'metrics' && <Metrics eng={eng} />}
        {tab === 'alerts' && <Alerts eng={eng} />}
        {tab === 'log' && <EventLog eng={eng} sample={sample} />}
      </div>
    </Panel>
  )
}

const th = {
  ...LABEL, fontSize: 8, padding: '4px 7px', textAlign: 'right' as const,
  position: 'sticky' as const, top: 0, background: T.surface,
  borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' as const, zIndex: 1,
}
const td = { ...MONO, fontSize: 10, padding: '2px 7px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const }

function Fills({ eng, sample }: { eng: Mm2Engine; sample: Sample | null }) {
  const list = eng.fills.filter(f => sample === null || f.t <= sample.t).slice(-200).reverse()
  if (!list.length) return <Empty>No fills yet. Run the session and wait for flow to arrive.</Empty>
  const cols = ['Time', 'Contract', 'Side', 'Qty', 'Price', 'Fair', 'Edge', 'Queue', 'Counterparty', '+1s', '+5s', '+30s']
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>{cols.map(h => (
        <th key={h} style={{ ...th, textAlign: h === 'Contract' || h === 'Counterparty' ? 'left' : 'right' }}>{h}</th>
      ))}</tr></thead>
      <tbody>
        {list.map(f => (
          <tr key={f.id} style={{ borderTop: `1px solid ${T.borderFaint}`, background: f.who === 'informed' ? alpha(BAD, 7) : undefined }}>
            <td style={{ ...td, color: T.muted }}>{fmtClock(f.t).slice(0, 8)}</td>
            <td style={{ ...td, textAlign: 'left', color: T.text }}>{eng.label(f.ck)}</td>
            <td style={{ ...td, color: f.ourSide === 'BUY' ? GOOD : BAD, fontWeight: 700 }}>{f.ourSide}</td>
            <td style={td}>{f.size}</td>
            <td style={{ ...td, color: T.text }}>{f.px.toFixed(2)}</td>
            <td style={{ ...td, color: T.muted }}>{f.fair.toFixed(2)}</td>
            <td style={{ ...td, color: pnlColor(f.edge), fontWeight: 600 }}>{fmtK(f.edge)}</td>
            <td style={{ ...td, color: T.muted }}>{f.queueMs}ms</td>
            <td style={{ ...td, textAlign: 'left', color: f.who === 'informed' ? BAD : T.muted }}>{f.who}</td>
            <td style={{ ...td, color: f.p1 === null ? alpha(T.muted, 40) : pnlColor(f.p1) }}>{f.p1 === null ? '···' : fmtK(f.p1)}</td>
            <td style={{ ...td, color: f.p5 === null ? alpha(T.muted, 40) : pnlColor(f.p5) }}>{f.p5 === null ? '···' : fmtK(f.p5)}</td>
            <td style={{ ...td, color: f.p30 === null ? alpha(T.muted, 40) : pnlColor(f.p30) }}>{f.p30 === null ? '···' : fmtK(f.p30)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Orders({ eng }: { eng: Mm2Engine }) {
  const list = [...eng.orders.values()].sort((a, b) => b.id - a.id).slice(0, 200)
  if (!list.length) return <Empty>No live orders. The strategy quotes while the session runs and quoting is on.</Empty>
  const cols = ['ID', 'Contract', 'Side', 'Level', 'Price', 'Size', 'Left', 'State', 'Queue', 'Edge sent', 'Age']
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>{cols.map(h => (
        <th key={h} style={{ ...th, textAlign: h === 'Contract' || h === 'State' ? 'left' : 'right' }}>{h}</th>
      ))}</tr></thead>
      <tbody>
        {list.map(o => (
          <tr key={o.id} style={{ borderTop: `1px solid ${T.borderFaint}` }}>
            <td style={{ ...td, color: T.muted }}>{o.id}</td>
            <td style={{ ...td, textAlign: 'left', color: T.text }}>{eng.label(o.ck)}</td>
            <td style={{ ...td, color: o.side === 'B' ? T.blue : '#a78bfa', fontWeight: 700 }}>{o.side === 'B' ? 'BID' : 'ASK'}</td>
            <td style={td}>{o.level + 1}</td>
            <td style={{ ...td, color: T.text }}>{o.px.toFixed(2)}</td>
            <td style={td}>{o.size}</td>
            <td style={td}>{o.remaining}</td>
            <td style={{ ...td, textAlign: 'left', color: o.state === 'active' ? GOOD : o.state === 'pending' ? WARN : T.muted }}>{o.state}</td>
            <td style={{ ...td, color: o.queueAhead ? T.muted : GOOD }}>{o.queueAhead}</td>
            <td style={{ ...td, color: T.muted }}>{o.edgeAtSubmit.toFixed(3)}</td>
            <td style={{ ...td, color: T.muted }}>{eng.clock - o.tCreate}ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Metrics({ eng }: { eng: Mm2Engine }) {
  const s = eng.stat
  const n = Math.max(1, s.fillsN)
  const ct = Math.max(1, s.contractsTraded)
  const r = eng.risk()
  const samples = eng.samples
  let vol = 0
  if (samples.length > 5) {
    const d: number[] = []
    for (let i = 1; i < samples.length; i++) d.push(samples[i].total - samples[i - 1].total)
    const m = d.reduce((a, b) => a + b, 0) / d.length
    vol = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length)
  }
  const marked = Math.max(1, s.markedFills)

  const groups: [string, [string, string][]][] = [
    ['Quoting', [
      ['Average quoted width', `$${(s.widthSum / Math.max(1, s.widthN)).toFixed(3)}`],
      ['Average intended edge', `$${(s.edgeIntended / ct / MULT).toFixed(3)}`],
      ['Average realized edge', `$${(s.edgeRealized / ct / MULT).toFixed(3)}`],
      ['Quote uptime', `${((s.quotedRefreshes / Math.max(1, s.refreshes)) * 100).toFixed(0)}%`],
      ['Chain quoted', `${s.quotedContracts} of ${s.scopeContracts}`],
      ['Messages sent', s.msgs.toLocaleString('en-US')],
      ['Throttled requotes', s.throttled.toLocaleString('en-US')],
    ]],
    ['Execution', [
      ['Fills', String(s.fillsN)],
      ['Contracts traded', s.contractsTraded.toLocaleString('en-US')],
      ['Fill rate per order', `${((s.fillsN / Math.max(1, s.orders)) * 100).toFixed(1)}%`],
      ['Partial fills', `${((s.partials / n) * 100).toFixed(0)}%`],
      ['Average queue time', `${(s.queueMsTotal / n).toFixed(0)} ms`],
      ['Maker rebates', fmtMoney(eng.rebates, 2)],
      ['Cancel to fill ratio', (s.cancels / n).toFixed(1)],
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
      ['Hedge slippage paid', fmtMoney(s.hedgeCost, 2)],
    ]],
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
      {groups.map(([title, rows]) => (
        <div key={title} style={{ borderRight: `1px solid ${T.borderFaint}`, padding: '6px 10px' }}>
          <span style={{ ...LABEL, fontSize: 8.5, color: alpha(T.gold, 75) }}>{title}</span>
          <div style={{ marginTop: 3 }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '1.5px 0' }}>
                <span style={{ ...MONO, fontSize: 10, color: T.muted }}>{k}</span>
                <span style={{ ...MONO, fontSize: 10, color: T.text }}>{v}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function Alerts({ eng }: { eng: Mm2Engine }) {
  const list = [...eng.alerts].reverse()
  if (!list.length) return <Empty>No alerts. Limits, latency and flow toxicity are all inside tolerance.</Empty>
  const cols = ['Time', 'Severity', 'Alert', 'Value', 'Limit', 'Automatic action', 'Suggested']
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr>{cols.map(h => (
        <th key={h} style={{ ...th, textAlign: h === 'Time' || h === 'Severity' ? 'right' : 'left' }}>{h}</th>
      ))}</tr></thead>
      <tbody>
        {list.map((a, i) => (
          <tr key={i} style={{ borderTop: `1px solid ${T.borderFaint}`, background: a.sev === 2 ? alpha(BAD, 8) : undefined }}>
            <td style={{ ...td, color: T.muted }}>{fmtClock(a.t).slice(0, 8)}</td>
            <td style={{ ...td, color: a.sev === 2 ? BAD : WARN, fontWeight: 700 }}>{a.sev === 2 ? 'BREACH' : 'WARN'}</td>
            <td style={{ ...td, textAlign: 'left', color: T.text }}>{a.title}</td>
            <td style={{ ...td, textAlign: 'left', color: a.sev === 2 ? BAD : T.text }}>{a.value}</td>
            <td style={{ ...td, textAlign: 'left', color: T.muted }}>{a.limit}</td>
            <td style={{ ...td, textAlign: 'left', color: T.text }}>{a.action}</td>
            <td style={{ ...td, textAlign: 'left', color: T.muted }}>{a.suggest}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function EventLog({ eng, sample }: { eng: Mm2Engine; sample: Sample | null }) {
  const [filter, setFilter] = useState('')
  const kinds = [...new Set(eng.events.map(e => e.kind))]
  const list = eng.events
    .filter(e => sample === null || e.t <= sample.t)
    .filter(e => !filter || e.kind === filter)
    .slice(-300).reverse()
  return (
    <div>
      <div style={{
        display: 'flex', gap: 4, padding: '4px 7px', flexWrap: 'wrap',
        borderBottom: `1px solid ${T.borderFaint}`, position: 'sticky', top: 0, background: T.bg, zIndex: 1,
      }}>
        <Chip label="all" on={filter === ''} onClick={() => setFilter('')} />
        {kinds.map(k => <Chip key={k} label={k} on={filter === k} onClick={() => setFilter(k)} />)}
      </div>
      {list.length === 0 ? <Empty>Nothing logged yet.</Empty> : list.map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 9, padding: '2px 8px', borderTop: `1px solid ${T.borderFaint}` }}>
          <span style={{ ...MONO, fontSize: 9.5, color: T.muted, width: 62, flexShrink: 0 }}>{fmtClock(e.t).slice(0, 8)}</span>
          <span style={{ ...MONO, fontSize: 9.5, color: e.sev === 2 ? BAD : e.sev === 1 ? WARN : alpha(T.gold, 68), width: 48, flexShrink: 0 }}>{e.kind}</span>
          <span style={{ ...MONO, fontSize: 9.5, color: e.sev ? T.text : alpha(T.text, 74) }}>{e.text}</span>
        </div>
      ))}
    </div>
  )
}

function Chip({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      ...MONO, fontSize: 9, padding: '1px 7px', cursor: 'pointer',
      border: `1px solid ${on ? alpha(T.gold, 45) : T.border}`,
      background: on ? alpha(T.gold, 12) : 'transparent', color: on ? T.gold : T.muted,
    }}>{label}</button>
  )
}
