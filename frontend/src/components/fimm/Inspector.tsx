/*
 * Bottom pane (height 264): one pane doing the work of two.
 *
 * The old inspector and the separate P&L band are collapsed into a single pane
 * whose body is a flex row: the active tab, then a fixed attribution cell that
 * is always visible. Three tabs replace five.
 */

import { useState } from 'react'
import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, Canvas, useTokens, GOOD, BAD, WARN, Empty } from '../mm2/ui'
import { fmt32 } from '../../lib/fimm/bondmath'
import { fmtMoney, type FiEngine, type NodeView } from '../../lib/fimm/engine'

type Tab = 'issue' | 'fills' | 'log'
type LogFilter = 'all' | 'warn' | 'breach'

const ATTR_W = 244

export default function Inspector({ eng, view, tick }: {
  eng: FiEngine
  view: NodeView | null
  tick: number
}) {
  const [tab, setTab] = useState<Tab>('issue')
  const [logFilter, setLogFilter] = useState<LogFilter>('all')

  const tabs: { key: Tab; label: string }[] = [
    { key: 'issue', label: 'Issue' },
    { key: 'fills', label: `Fills ${eng.stat.fillsN}` },
    { key: 'log', label: 'Log' },
  ]

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0,
      background: T.bg, border: `1px solid ${T.border}`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', flexShrink: 0,
        borderBottom: `1px solid ${T.border}`, background: alpha(T.gold, 4),
      }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} style={{
            ...LABEL, fontSize: 9, letterSpacing: '0.16em', padding: '6px 12px', cursor: 'pointer',
            background: 'none', border: 'none', borderRadius: 0,
            borderBottom: `2px solid ${tab === t.key ? T.gold : 'transparent'}`,
            color: tab === t.key ? T.gold : T.muted,
          }}>{t.label}</button>
        ))}
        <span style={{ ...MONO, fontSize: 10, color: T.muted, marginLeft: 'auto', paddingRight: 12 }}>
          selected <span style={{ color: T.gold }}>{view?.node.label ?? '—'}</span>
        </span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          {tab === 'issue' && <Issue eng={eng} view={view} />}
          {tab === 'fills' && <Fills eng={eng} />}
          {tab === 'log' && <Log eng={eng} filter={logFilter} onFilter={setLogFilter} />}
        </div>
        <div style={{ width: ATTR_W, flexShrink: 0, borderLeft: `1px solid ${T.borderFaint}`, overflow: 'hidden' }}>
          <Attribution eng={eng} tick={tick} />
        </div>
      </div>
    </div>
  )
}

// ── Issue ─────────────────────────────────────────────────────────────────────

function Issue({ eng, view }: { eng: FiEngine; view: NodeView | null }) {
  if (!view) return <Empty>Click any issue in the matrix to inspect it.</Empty>
  const nd = view.node
  const cash = nd.kind === 'cash'
  const held = view.posMM
  const dv = eng.dv01(nd)
  const carry = cash && held !== 0 ? held * 1e6 * (nd.coupon - eng.cfg.repoRate) / 365 : 0
  const q = view.quote

  return (
    <div style={{ padding: '9px 12px', display: 'flex', flexDirection: 'column', gap: 8, height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexShrink: 0 }}>
        <span style={{ ...MONO, fontSize: 15, fontWeight: 700, color: T.gold }}>{nd.label}</span>
        <span style={{ ...MONO, fontSize: 11, color: held > 0 ? GOOD : held < 0 ? BAD : T.muted }}>
          {held === 0 ? 'flat' : `${held > 0 ? 'long' : 'short'} ${Math.abs(held).toFixed(0)}${cash ? 'mm' : ' lots'}`}
        </span>
        <span style={{ ...MONO, fontSize: 10, color: T.muted, marginLeft: 'auto' }}>
          click any issue in the matrix to inspect it
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 0 }}>
        <Col title="Issue and market" width={186}>
          <Row k="cusip" v={nd.cusip} />
          <Row k="coupon" v={cash ? `${(nd.coupon * 100).toFixed(3)}%` : '—'} />
          <Row k="maturity" v={nd.maturity} />
          <Row k="model yield" v={pct(view.modelYield)} color={T.gold} bold />
          <Row k="clean price" v={cash ? fmt32(view.modelPrice) : view.modelPrice.toFixed(4)} />
          <Row k="market" v={`${pct(view.streetBidYield)} / ${pct(view.streetAskYield)}`} />
          <Row k="your quote" v={q.bidSize || q.askSize ? `${pct(q.bidYield)} / ${pct(q.askYield)}` : 'not quoted'}
            color={T.blue} bold />
            <Note inside={view.bidInside && view.askInside} bid={view.bidInside} ask={view.askInside}
            quoted={q.bidSize > 0 || q.askSize > 0} />
        </Col>

        <Col title="Position and carry" width={186}>
          <Row k="position" v={held === 0 ? 'flat' : `${held > 0 ? '+' : ''}${held.toFixed(0)}${cash ? 'mm' : ' lots'}`}
            color={held > 0 ? GOOD : held < 0 ? BAD : undefined} />
          <Row k="average yield" v={held === 0 ? '—' : pct(view.avgYield)} />
          <Row k="position DV01" v={fmtMoney(view.dv01)} />
          <Row k="carry per day" v={carry === 0 ? '—' : fmtMoney(carry)}
            color={carry > 0 ? GOOD : carry < 0 ? BAD : undefined} />
          <Row k="realised here" v={fmtMoney(view.pnl)}
            color={view.pnl > 0 ? GOOD : view.pnl < 0 ? BAD : undefined} />
          <Row k="repo" v={`${(eng.cfg.repoRate * 100).toFixed(2)}%`} />
          <Row k="quote state" v={`${q.bidState} / ${q.askState}`}
            color={q.bidState === 'active' && q.askState === 'active' ? undefined : BAD} />
        </Col>

        <Col title="Analytics" width={186}>
          <Row k="mod duration" v={`${eng.modDuration(nd).toFixed(2)}y`} />
          <Row k="DV01 per unit" v={`$${Math.round(dv).toLocaleString()}`} />
          <Row k="convexity" v={cash ? fmtMoney(eng.convexityOf(nd)) : '—'} />
          <Row k="ASW spread" v={cash ? `${nd.aswBp.toFixed(1)} bp` : '—'} />
          <Row k="basis to TY" v={cash ? (view.modelPrice - eng.futurePrice('TY')).toFixed(3) : '—'} />
          <Row k="size resting" v={`${q.bidSize}/${q.askSize}${cash ? 'mm' : ' lots'}`} />
          <Row k="edge shown" v={`${q.edgeBp.toFixed(2)} bp`} color={T.gold} />
        </Col>

        <Ladder eng={eng} view={view} />
      </div>
    </div>
  )
}

function Note({ inside, bid, ask, quoted }: { inside: boolean; bid: boolean; ask: boolean; quoted: boolean }) {
  if (!quoted) return <div style={{ ...MONO, fontSize: 10, color: T.muted, marginTop: 4 }}>Not quoting this issue.</div>
  const text = inside ? 'You are inside the market on both sides.'
    : bid ? 'Your ask is behind the market. Only the bid is competitive.'
    : ask ? 'Your bid is behind the market. Only the ask is competitive.'
    : 'Both sides are behind the market.'
  return (
    <div style={{ ...MONO, fontSize: 10, color: inside ? T.blue : WARN, marginTop: 4, lineHeight: 1.4 }}>{text}</div>
  )
}

/**
 * The depth ladder, in yield and derived from the row's own quote.
 *
 * Two things matter. It is in yield because the matrix is, and the caption
 * states the direction so the ask sitting on top still reads as the high price.
 * And every level comes from the quote itself rather than fixed offsets around
 * theoretical, so the ladder cannot contradict the matrix.
 *
 * The step is one 32nd expressed in yield, which is about 1.6bp at the 2Y and
 * 0.2bp at the 30Y — the clearest demonstration of why the analytical space is
 * yield even though the market trades in 32nds.
 */
function Ladder({ eng, view }: { eng: FiEngine; view: NodeView }) {
  const nd = view.node
  const q = view.quote
  const price = view.modelPrice || 100
  const tickYield = nd.kind === 'cash'
    ? (1 / 32) / Math.max(eng.modDuration(nd) * price / 10_000, 1e-6) / 10_000
    : 0.000025
  const rows: { y: number; bid?: number; ask?: number; kind: 'street' | 'touch' | 'ours' | 'theo' }[] = [
    { y: view.streetAskYield - 2 * tickYield, ask: 12, kind: 'street' },
    { y: view.streetAskYield - tickYield, ask: 22, kind: 'street' },
    { y: view.streetAskYield, ask: 40, kind: 'touch' },
    { y: q.askYield, ask: q.askSize, kind: 'ours' },
    { y: view.modelYield, kind: 'theo' },
    { y: q.bidYield, bid: q.bidSize, kind: 'ours' },
    { y: view.streetBidYield, bid: 40, kind: 'touch' },
    { y: view.streetBidYield + tickYield, bid: 22, kind: 'street' },
    { y: view.streetBidYield + 2 * tickYield, bid: 12, kind: 'street' },
  ]
  const unit = nd.kind === 'cash' ? 'mm' : ''

  return (
    <div style={{ flex: 1, minWidth: 0, borderLeft: `1px solid ${T.borderFaint}`, paddingLeft: 16, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ ...LABEL, fontSize: 9, letterSpacing: '0.16em', color: alpha(T.gold, 75) }}>Depth</span>
        <span style={{ ...MONO, fontSize: 9, color: T.muted }}>yours in colour · low yield is high price</span>
      </div>
      <div style={{ display: 'flex', ...LABEL, fontSize: 8.5, letterSpacing: '0.14em', color: T.muted }}>
        <span style={{ flex: 1, textAlign: 'right', padding: '0 6px' }}>Bid</span>
        <span style={{ flex: 1, textAlign: 'center', padding: '0 6px' }}>Yield</span>
        <span style={{ flex: 1, textAlign: 'left', padding: '0 6px' }}>Ask</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {rows.map((r, i) => {
          const ours = r.kind === 'ours'
          const theo = r.kind === 'theo'
          const touch = r.kind === 'touch'
          return (
            <div key={i} style={{
              display: 'flex', ...MONO, fontSize: 11, lineHeight: '17px',
              background: ours ? alpha(T.blue, 12) : theo ? alpha(T.gold, 10) : touch ? alpha(T.text, 5) : 'transparent',
            }}>
              <span style={{ flex: 1, textAlign: 'right', padding: '0 6px', color: alpha(GOOD, 78) }}>
                {r.bid ? `${r.bid}${unit}` : ''}
              </span>
              <span style={{
                flex: 1, textAlign: 'center', padding: '0 6px',
                color: ours ? T.blue : theo ? T.gold : T.text,
                fontWeight: ours || theo || touch ? 700 : 400,
              }}>{pct(r.y)}</span>
              <span style={{ flex: 1, textAlign: 'left', padding: '0 6px', color: alpha(BAD, 78) }}>
                {r.ask ? `${r.ask}${unit}` : ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Col({ title, width, children }: { title: string; width: number; children: React.ReactNode }) {
  return (
    <div style={{ width, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
      <div style={{ ...LABEL, fontSize: 9, letterSpacing: '0.16em', color: alpha(T.gold, 75), marginBottom: 3 }}>{title}</div>
      {children}
    </div>
  )
}

function Row({ k, v, color, bold }: { k: string; v: string; color?: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, ...MONO, fontSize: 11 }}>
      <span style={{ color: T.muted }}>{k}</span>
      <span style={{ color: color ?? T.text, fontWeight: bold ? 700 : 400 }}>{v}</span>
    </div>
  )
}

// ── Fills ─────────────────────────────────────────────────────────────────────

function Fills({ eng }: { eng: FiEngine }) {
  if (!eng.fills.length) return <Empty>No trades yet. Run the session and the desk will start getting hit.</Empty>
  const cols = ['Time', 'Issue', 'Side', 'Size', 'Price', 'Yield', 'Edge', 'Counterparty', 'Marked']
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {cols.map((c, i) => (
            <th key={c} style={{
              position: 'sticky', top: 0, zIndex: 2, background: T.surface,
              ...LABEL, fontSize: 8.5, letterSpacing: '0.14em', color: T.muted,
              textAlign: i < 3 ? 'left' : 'right', padding: '4px 10px',
              borderBottom: `1px solid ${T.border}`,
            }}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {eng.fills.slice(0, 80).map(f => {
          const nd = eng.nodes[f.nodeId]
          const informed = f.participant === 'informed'
          return (
            <tr key={f.id} style={{ background: informed ? alpha(BAD, 7) : 'transparent' }}>
              <Td left>{clock(f.t)}</Td>
              <Td left color={T.text}>{nd.label}</Td>
              <Td left color={f.side === 'B' ? GOOD : BAD} bold>{f.side === 'B' ? 'BOUGHT' : 'SOLD'}</Td>
              <Td>{f.size}{nd.unit === 'MM' ? 'mm' : ''}</Td>
              <Td>{nd.kind === 'cash' ? fmt32(f.price) : f.price.toFixed(4)}</Td>
              <Td>{pct(f.yield)}</Td>
              <Td color={T.gold} bold>{f.edgeBp.toFixed(2)}</Td>
              <Td color={informed ? BAD : T.muted}>{f.participant}</Td>
              <Td color={f.markPnl > 0 ? GOOD : f.markPnl < 0 ? BAD : T.muted}>
                {f.markPnl === 0 ? '—' : fmtMoney(f.markPnl)}
              </Td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Td({ children, left, color, bold }: {
  children: React.ReactNode; left?: boolean; color?: string; bold?: boolean
}) {
  return (
    <td style={{
      ...MONO, fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap',
      textAlign: left ? 'left' : 'right', color: color ?? T.text, fontWeight: bold ? 700 : 400,
    }}>{children}</td>
  )
}

// ── Log ───────────────────────────────────────────────────────────────────────

/**
 * One timeline for everything that happened.
 *
 * Alerts used to live in their own view, which meant reading two lists to
 * reconstruct one session. Severity is a filter here, not a separate tab.
 */
function Log({ eng, filter, onFilter }: {
  eng: FiEngine; filter: LogFilter; onFilter: (f: LogFilter) => void
}) {
  const warns = eng.events.filter(e => e.sev === 1).length
  const breaches = eng.events.filter(e => e.sev === 2).length
  const shown = eng.events.filter(e =>
    filter === 'all' ? true : filter === 'warn' ? e.sev === 1 : e.sev === 2)

  const chips: { key: LogFilter; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'warn', label: `Warnings ${warns}` },
    { key: 'breach', label: `Breaches ${breaches}` },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', flexShrink: 0,
        borderBottom: `1px solid ${T.borderFaint}`,
      }}>
        <span style={{ ...LABEL, fontSize: 9, letterSpacing: '0.16em' }}>Show</span>
        {chips.map(c => (
          <button key={c.key} onClick={() => onFilter(c.key)} style={{
            ...MONO, fontSize: 9.5, padding: '2px 8px', cursor: 'pointer', borderRadius: 0,
            background: filter === c.key ? alpha(T.gold, 12) : 'transparent',
            border: `1px solid ${filter === c.key ? alpha(T.gold, 45) : T.border}`,
            color: filter === c.key ? T.gold : T.muted,
          }}>{c.label}</button>
        ))}
        <span style={{ ...MONO, fontSize: 9.5, color: T.muted, marginLeft: 'auto' }}>
          Alerts appear here with the action the engine took.
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {!shown.length && <Empty>Nothing logged at this severity.</Empty>}
        {shown.map((e, i) => {
          const sev = e.sev
          return (
            <div key={i} style={{
              display: 'flex', gap: 12, padding: '4px 12px',
              borderTop: `1px solid ${T.borderFaint}`,
              borderLeft: `2px solid ${sev === 2 ? BAD : sev === 1 ? WARN : 'transparent'}`,
              background: sev === 2 ? alpha(BAD, 8) : sev === 1 ? alpha(WARN, 6) : 'transparent',
            }}>
              <span style={{ ...MONO, fontSize: 10, color: T.muted, width: 54, flexShrink: 0 }}>{clock(e.t)}</span>
              <span style={{
                ...MONO, fontSize: 10, width: 62, flexShrink: 0, fontWeight: sev ? 700 : 400,
                color: sev === 2 ? BAD : sev === 1 ? WARN : alpha(T.gold, 68),
              }}>{sev === 2 ? 'BREACH' : sev === 1 ? 'WARN' : e.kind}</span>
              <span style={{ ...MONO, fontSize: 10.5, color: sev ? T.text : alpha(T.text, 74) }}>{e.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Attribution ───────────────────────────────────────────────────────────────

/**
 * The pinned cell. Five books, and they sum to total P&L exactly, which is the
 * only reason the graph can be trusted.
 */
function Attribution({ eng, tick }: { eng: FiEngine; tick: number }) {
  const tokens = useTokens()
  const s = eng.samples
  const r = eng.risk()
  const series = [
    { key: 'spread' as const, label: 'Spread capture', color: tokens['--theme-positive'] || '#22c55e', w: 1.4 },
    { key: 'curve' as const, label: 'Curve delta', color: tokens['--theme-tertiary'] || '#60a5fa', w: 1.4 },
    { key: 'carry' as const, label: 'Carry and roll', color: tokens['--theme-primary'] || '#c9a84c', w: 1.4 },
    { key: 'convexity' as const, label: 'Convexity', color: tokens['--theme-secondary'] || '#8099b0', w: 1 },
    { key: 'hedge' as const, label: 'Hedge cost', color: tokens['--theme-negative'] || '#ef4444', w: 1 },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 8px', flexShrink: 0,
        borderBottom: `1px solid ${T.borderFaint}`, background: alpha(T.gold, 4),
      }}>
        <span style={{ ...LABEL, fontSize: 9, letterSpacing: '0.16em', color: alpha(T.gold, 70) }}>Attribution</span>
        <span style={{ ...MONO, fontSize: 9, color: T.muted, marginLeft: 'auto' }}>five books</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '4px 8px' }}>
        {s.length < 2
          ? <div style={{ ...MONO, fontSize: 9.5, color: T.muted, padding: '8px 0' }}>Run the session and it builds as it goes.</div>
          : (
            <Canvas
              height={72}
              draw={(ctx, w, h) => {
                let lo = 0
                let hi = 0
                for (const p of s) for (const x of series) {
                  lo = Math.min(lo, p.attr[x.key])
                  hi = Math.max(hi, p.attr[x.key])
                }
                const span = Math.max(hi - lo, 1)
                const xAt = (i: number) => (i / Math.max(s.length - 1, 1)) * w
                const yAt = (v: number) => h - ((v - lo) / span) * h
                ctx.strokeStyle = tokens['--theme-secondary'] || '#8099b0'
                ctx.globalAlpha = 0.38
                ctx.lineWidth = 1
                ctx.beginPath(); ctx.moveTo(0, yAt(0)); ctx.lineTo(w, yAt(0)); ctx.stroke()
                ctx.globalAlpha = 1
                for (const x of series) {
                  ctx.strokeStyle = x.color
                  ctx.lineWidth = x.w
                  ctx.beginPath()
                  s.forEach((p, i) => (i === 0 ? ctx.moveTo(xAt(i), yAt(p.attr[x.key])) : ctx.lineTo(xAt(i), yAt(p.attr[x.key]))))
                  ctx.stroke()
                }
              }}
            />
          )}

        <div style={{ marginTop: 4 }}>
          {series.map(x => (
            <div key={x.key} style={{ display: 'flex', alignItems: 'center', gap: 7, ...MONO, fontSize: 10 }}>
              <span style={{ width: 10, height: 2, background: x.color, flexShrink: 0 }} />
              <span style={{ color: T.muted, flex: 1, minWidth: 0 }}>{x.label}</span>
              <span style={{ fontSize: 10.5, fontWeight: 600, color: eng.attr[x.key] >= 0 ? GOOD : BAD }}>
                {fmtMoney(eng.attr[x.key])}
              </span>
            </div>
          ))}
        </div>

        {/* The carry breakdown that came out of the risk column. */}
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${T.borderFaint}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <span style={{ ...LABEL, fontSize: 8.5, letterSpacing: '0.14em' }}>Carry today</span>
            <span style={{
              ...MONO, fontSize: 11, fontWeight: 700, marginLeft: 'auto',
              color: r.carryPerDay + r.rollPerDay >= 0 ? GOOD : BAD,
            }}>{fmtMoney(r.carryPerDay + r.rollPerDay)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', ...MONO, fontSize: 10, color: T.muted }}>
            <span>coupon less repo</span><span style={{ color: r.carryPerDay >= 0 ? GOOD : BAD }}>{fmtMoney(r.carryPerDay)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', ...MONO, fontSize: 10, color: T.muted }}>
            <span>roll-down</span><span style={{ color: r.rollPerDay >= 0 ? GOOD : BAD }}>{fmtMoney(r.rollPerDay)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

const pct = (y: number) => `${(y * 100).toFixed(3)}`
const clock = (ms: number) => {
  const base = 7 * 3600 * 1000 + ms
  const h = Math.floor(base / 3_600_000) % 24
  const m = Math.floor(base / 60_000) % 60
  const s = Math.floor(base / 1000) % 60
  return `${p2(h)}:${p2(m)}:${p2(s)}`
}
const p2 = (n: number) => String(n).padStart(2, '0')
