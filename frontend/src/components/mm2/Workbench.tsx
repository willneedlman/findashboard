/*
 * Options MM Simulator — the bottom pane.
 *
 * One pane where there used to be two: the eight-tab workbench and the separate
 * P&L band. Four tabs now, and the P&L timeline is a fixed cell on the right
 * that never goes away, because it is the thing you glance at while reading
 * anything else.
 *
 * Alerts are folded into the log. Two lists of things-that-happened, filtered
 * differently, was one list too many.
 */

import { useState } from 'react'
import { T, alpha } from '../../lib/theme'
import { Panel, Canvas, useTokens, hexAlpha, MONO, LABEL, Seg, Btn, Empty, GOOD, BAD, WARN, pnlColor } from './ui'
import { fmtK } from './Chain'
import { ContractBody } from './Center'
import { DTE_LABELS, fmtClock, type LegView, type Mm2Engine, type Sample } from '../../lib/mm2/engine'

type Tab = 'contract' | 'fills' | 'orders' | 'log'
type LogFilter = 'all' | 'warn' | 'breach'

export default function Workbench({ eng, sel, onSel, tick, live, sample, leg, reviewT, onScrub }: {
  eng: Mm2Engine; sel: number; onSel: (ck: number) => void; tick: number
  live: boolean; sample: Sample | null; leg: LegView | null
  reviewT: number | null; onScrub: (t: number | null) => void
}) {
  void tick
  void onSel
  const [tab, setTab] = useState<Tab>('contract')
  const c = eng.contracts[sel]

  const tabs: { key: Tab; label: string }[] = [
    { key: 'contract', label: 'Contract' },
    { key: 'fills', label: `Fills ${eng.stat.fillsN}` },
    { key: 'orders', label: `Orders ${eng.orders.size}` },
    { key: 'log', label: 'Log' },
  ]

  return (
    <Panel style={{ flex: 1, minWidth: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', flexShrink: 0,
        borderBottom: `1px solid ${T.border}`, background: alpha(T.gold, 4),
      }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            ...LABEL, fontSize: 9, padding: '6px 12px', cursor: 'pointer', border: 'none',
            borderBottom: `2px solid ${tab === t.key ? T.gold : 'transparent'}`,
            background: 'transparent', color: tab === t.key ? T.gold : T.muted,
          }}>{t.label}</button>
        ))}
        <span style={{ ...MONO, fontSize: 10, color: T.muted, marginLeft: 'auto', paddingRight: 12 }}>
          selected <span style={{ color: T.gold }}>{DTE_LABELS[c.expIdx]} {c.strike} {c.kind === 'C' ? 'CALL' : 'PUT'}</span>
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {tab === 'contract' && <ContractBody eng={eng} sel={sel} live={live} sample={sample} leg={leg} />}
          {tab === 'fills' && <Fills eng={eng} sample={sample} />}
          {tab === 'orders' && <Orders eng={eng} />}
          {tab === 'log' && <Log eng={eng} sample={sample} />}
        </div>
        <div style={{ width: 230, flexShrink: 0, borderLeft: `1px solid ${T.borderFaint}`, display: 'flex', flexDirection: 'column' }}>
          <PnlCell eng={eng} reviewT={reviewT} onScrub={onScrub} />
        </div>
      </div>
    </Panel>
  )
}

// ── P&L cell ──────────────────────────────────────────────────────────────────

const PNL_SERIES = [
  { key: 'total', label: 'Total', color: (t: Record<string, string>) => t.gold },
  { key: 'realized', label: 'Realized', color: (t: Record<string, string>) => t.blue },
  { key: 'spread', label: 'Spread', color: (t: Record<string, string>) => t.pos },
  { key: 'hedge', label: 'Hedge', color: (t: Record<string, string>) => t.orange },
] as const
const INV_SERIES = [
  { key: 'netDelta', label: 'Delta', color: (t: Record<string, string>) => t.gold },
  { key: 'vega', label: 'Vega', color: (t: Record<string, string>) => t.blue },
  { key: 'stock', label: 'Stock', color: (t: Record<string, string>) => t.pos },
] as const

function PnlCell({ eng, reviewT, onScrub }: {
  eng: Mm2Engine; reviewT: number | null; onScrub: (t: number | null) => void
}) {
  const tok = useTokens()
  const [mode, setMode] = useState<'pnl' | 'inventory'>('pnl')
  const s = eng.samples
  const list = mode === 'pnl' ? PNL_SERIES : INV_SERIES
  const latest = s[s.length - 1]

  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
        padding: '5px 8px', borderBottom: `1px solid ${T.borderFaint}`, flexShrink: 0,
      }}>
        <span style={{ ...LABEL, fontSize: 9, color: alpha(T.gold, 70) }}>P&L timeline</span>
        <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          {reviewT !== null && <Btn tone="gold" onClick={() => onScrub(null)}>LIVE</Btn>}
          <Seg options={[{ label: 'P&L', value: 'pnl' }, { label: 'INV', value: 'inventory' }]}
            value={mode} onChange={v => setMode(v as 'pnl' | 'inventory')} size={8.5} />
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: '2px 4px' }}>
        <Canvas height={78} onPick={xf => {
          if (s.length < 2) return
          onScrub(s[0].t + xf * (s[s.length - 1].t - s[0].t))
        }} draw={(ctx, w, h) => {
          if (!tok.gold || s.length < 2) return
          let lo = 0, hi = 0
          for (const p of s) for (const ser of list) {
            const v = p[ser.key] as number
            lo = Math.min(lo, v); hi = Math.max(hi, v)
          }
          if (lo === hi) { lo -= 1; hi += 1 }
          const pad = (hi - lo) * 0.1
          lo -= pad; hi += pad
          const t0 = s[0].t, span = Math.max(s[s.length - 1].t - t0, 1)
          const X = (t: number) => ((t - t0) / span) * w
          const Y = (v: number) => h - 6 - ((v - lo) / (hi - lo)) * (h - 12)

          ctx.strokeStyle = hexAlpha(tok.muted, 0.38)
          ctx.beginPath(); ctx.moveTo(0, Y(0)); ctx.lineTo(w, Y(0)); ctx.stroke()
          for (const ser of list) {
            ctx.beginPath()
            s.forEach((p, i) => {
              const x = X(p.t), y = Y(p[ser.key] as number)
              i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
            })
            ctx.strokeStyle = ser.color(tok)
            ctx.lineWidth = ser.key === 'total' || ser.key === 'netDelta' ? 1.7 : 1
            ctx.stroke()
          }
          if (reviewT !== null) {
            const x = X(reviewT)
            ctx.strokeStyle = tok.text
            ctx.setLineDash([3, 3])
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
            ctx.setLineDash([])
          }
        }} />
      </div>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '0 10px', padding: '3px 8px 5px',
        borderTop: `1px solid ${T.borderFaint}`, flexShrink: 0,
      }}>
        {list.map(ser => (
          <span key={ser.key} style={{ ...MONO, fontSize: 9, whiteSpace: 'nowrap' }}>
            <span style={{ color: tok.gold ? ser.color(tok) : T.muted }}>{ser.label}</span>
            {' '}
            <span style={{ color: T.text }}>{latest ? fmtK(latest[ser.key] as number) : '—'}</span>
          </span>
        ))}
      </div>
    </>
  )
}

// ── Tables ────────────────────────────────────────────────────────────────────

const th = {
  ...LABEL, fontSize: 8.5, letterSpacing: '0.14em', padding: '4px 10px', textAlign: 'right' as const,
  position: 'sticky' as const, top: 0, background: T.surface,
  borderBottom: `1px solid ${T.border}`, whiteSpace: 'nowrap' as const, zIndex: 1,
}
const td = { ...MONO, fontSize: 11, padding: '4px 10px', textAlign: 'right' as const, whiteSpace: 'nowrap' as const }

function Fills({ eng, sample }: { eng: Mm2Engine; sample: Sample | null }) {
  const list = eng.fills.filter(f => sample === null || f.t <= sample.t).slice(-200).reverse()
  if (!list.length) return <Empty>No fills yet. Run the session and wait for flow to arrive.</Empty>
  const cols = ['Time', 'Contract', 'Side', 'Qty', 'Price', 'Fair', 'Edge', 'Counterparty', 'After 30s']
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
            <td style={{ ...td, textAlign: 'left', color: f.who === 'informed' ? BAD : T.muted }}>{f.who}</td>
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
            <td style={{ ...td, color: o.side === 'B' ? T.blue : T.violet, fontWeight: 700 }}>{o.side === 'B' ? 'BID' : 'ASK'}</td>
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

/** Events and alerts on one timeline. An alert is just an event that carries a limit. */
function Log({ eng, sample }: { eng: Mm2Engine; sample: Sample | null }) {
  const [filter, setFilter] = useState<LogFilter>('all')
  const cut = sample?.t ?? Infinity

  const merged = [
    ...eng.events.filter(e => e.t <= cut).map(e => ({
      t: e.t, sev: e.sev, kind: e.kind.toUpperCase(), text: e.text,
    })),
    ...eng.alerts.filter(a => a.t <= cut).map(a => ({
      t: a.t, sev: a.sev, kind: a.sev === 2 ? 'BREACH' : 'WARN',
      text: `${a.title}. ${a.value} against ${a.limit}. ${a.action}.`,
    })),
  ].sort((a, b) => b.t - a.t)

  const warnings = merged.filter(r => r.sev === 1).length
  const breaches = merged.filter(r => r.sev === 2).length
  const shown = merged.filter(r => filter === 'all' || (filter === 'warn' ? r.sev === 1 : r.sev === 2)).slice(0, 300)

  const chips: { key: LogFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'warn', label: `Warnings ${warnings}` },
    { key: 'breach', label: `Breaches ${breaches}` },
  ]

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px',
        borderBottom: `1px solid ${T.borderFaint}`, position: 'sticky', top: 0, background: T.bg, zIndex: 1,
      }}>
        <span style={{ ...LABEL, fontSize: 9 }}>Show</span>
        {chips.map(chip => (
          <button key={chip.key} onClick={() => setFilter(chip.key)} style={{
            ...MONO, fontSize: 9.5, padding: '2px 8px', cursor: 'pointer',
            border: `1px solid ${filter === chip.key ? alpha(T.gold, 45) : T.border}`,
            background: filter === chip.key ? alpha(T.gold, 12) : 'transparent',
            color: filter === chip.key ? T.gold : T.muted,
          }}>{chip.label}</button>
        ))}
        <span style={{ ...MONO, fontSize: 9.5, color: T.muted, marginLeft: 'auto' }}>
          Alerts appear here with the action the engine took.
        </span>
      </div>
      {shown.length === 0 ? <Empty>Nothing logged yet.</Empty> : shown.map((r, i) => {
        const tone = r.sev === 2 ? BAD : r.sev === 1 ? WARN : null
        return (
          <div key={i} style={{
            display: 'flex', gap: 12, padding: '4px 12px', borderTop: `1px solid ${T.borderFaint}`,
            borderLeft: `2px solid ${tone ?? 'transparent'}`,
            background: r.sev === 2 ? alpha(BAD, 8) : r.sev === 1 ? alpha(WARN, 6) : undefined,
          }}>
            <span style={{ ...MONO, fontSize: 10, color: T.muted, width: 54, flexShrink: 0 }}>{fmtClock(r.t).slice(0, 8)}</span>
            <span style={{ ...MONO, fontSize: 10, fontWeight: tone ? 700 : 400, color: tone ?? alpha(T.gold, 68), width: 62, flexShrink: 0 }}>{r.kind}</span>
            <span style={{ ...MONO, fontSize: 10, color: tone ? T.text : alpha(T.text, 74) }}>{r.text}</span>
          </div>
        )
      })}
    </div>
  )
}
