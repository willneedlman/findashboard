/*
 * Bottom pane: the selected issue in depth, the book behind it, and where the
 * P&L actually came from.
 *
 * Three tabs share one pane rather than stacking, because the vertical budget
 * is fixed and a rates screen that scrolls has stopped being a dealing screen.
 */

import { useState } from 'react'
import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, TH, TD, Tabs, Canvas, useTokens, GOOD, BAD, Empty } from '../mm2/ui'
import { fmt32, fmt32Eighths } from '../../lib/fimm/bondmath'
import { fmtMoney, type FiEngine, type NodeView } from '../../lib/fimm/engine'

type Tab = 'issue' | 'depth' | 'fills' | 'attribution' | 'log'

export default function Inspector({ eng, view, tick }: {
  eng: FiEngine
  view: NodeView | null
  tick: number
}) {
  const [tab, setTab] = useState<Tab>('issue')
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0,
      background: T.surface, border: `1px solid ${T.border}`,
    }}>
      <Tabs
        tabs={[
          { key: 'issue', label: 'Issue' },
          { key: 'depth', label: 'Depth' },
          { key: 'fills', label: `Fills ${eng.stat.fillsN}` },
          { key: 'attribution', label: 'Attribution' },
          { key: 'log', label: 'Log' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '6px 8px' }}>
        {tab === 'issue' && <Issue eng={eng} view={view} />}
        {tab === 'depth' && <Depth eng={eng} view={view} />}
        {tab === 'fills' && <Fills eng={eng} />}
        {tab === 'attribution' && <AttributionGraph eng={eng} tick={tick} />}
        {tab === 'log' && <Log eng={eng} />}
      </div>
    </div>
  )
}

function Issue({ eng, view }: { eng: FiEngine; view: NodeView | null }) {
  if (!view) return <Empty>Pick an issue on the matrix.</Empty>
  const nd = view.node
  const dv = eng.dv01(nd)
  const dur = eng.modDuration(nd)
  const basis = view.modelPrice - eng.futurePrice('TY')
  const held = view.posMM
  const carry = nd.kind === 'cash' && held !== 0
    ? held * 1e6 * (nd.coupon - eng.cfg.repoRate) / 365
    : 0

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(132px, 1fr))', gap: '7px 14px' }}>
      <Cell label="Issue" value={`${nd.label}${nd.kind === 'cash' ? ' OTR' : ''}`} strong />
      <Cell label="CUSIP" value={nd.cusip} />
      <Cell label="Coupon" value={nd.kind === 'cash' ? `${(nd.coupon * 100).toFixed(3)}%` : '—'} />
      <Cell label="Maturity" value={nd.maturity} />
      <Cell label="Yield to maturity" value={`${(view.modelYield * 100).toFixed(3)}%`} strong />
      <Cell label="Clean price" value={nd.kind === 'cash' ? fmt32(view.modelPrice) : view.modelPrice.toFixed(4)} />
      <Cell label="Modified duration" value={`${dur.toFixed(2)}y`} />
      <Cell label="DV01 per unit" value={`$${Math.round(dv).toLocaleString()}`} />
      <Cell label="Convexity" value={fmtMoney(eng.convexityOf(nd))} />
      <Cell label="ASW spread" value={nd.kind === 'cash' ? `${nd.aswBp.toFixed(1)} bp` : '—'} />
      <Cell label="Basis to TY" value={nd.kind === 'cash' ? `${basis >= 0 ? '+' : ''}${basis.toFixed(3)}` : '—'} />
      <Cell label="Repo / financing" value={`${(eng.cfg.repoRate * 100).toFixed(2)}%`} />

      <Cell label="Position" value={held === 0 ? 'flat' : `${held > 0 ? '+' : ''}${held.toFixed(0)}${nd.unit === 'MM' ? 'mm' : ' lots'}`}
        color={held > 0 ? GOOD : held < 0 ? BAD : T.muted} strong />
      <Cell label="Average yield" value={held === 0 ? '—' : `${(view.avgYield * 100).toFixed(3)}%`} />
      <Cell label="Position DV01" value={fmtMoney(view.dv01)} color={view.dv01 === 0 ? T.muted : T.text} />
      <Cell label="Carry per day" value={carry === 0 ? '—' : fmtMoney(carry)}
        color={carry > 0 ? GOOD : carry < 0 ? BAD : T.muted} />
      <Cell label="Realised on issue" value={fmtMoney(view.pnl)} color={view.pnl > 0 ? GOOD : view.pnl < 0 ? BAD : T.muted} />
      <Cell label="Quote state" value={`${view.quote.bidState} / ${view.quote.askState}`}
        color={view.quote.bidState === 'active' && view.quote.askState === 'active' ? T.text : BAD} />
    </div>
  )
}

function Cell({ label, value, color, strong }: {
  label: string; value: string; color?: string; strong?: boolean
}) {
  return (
    <div style={{ lineHeight: 1.25 }}>
      <div style={{ ...LABEL, fontSize: 8 }}>{label}</div>
      <div style={{ ...MONO, fontSize: strong ? 13 : 11.5, fontWeight: strong ? 700 : 500, color: color ?? T.text }}>{value}</div>
    </div>
  )
}

/**
 * Level 2 ladder around the selected issue.
 *
 * The desk's own resting quote is marked on its side, so the trader can see
 * where they sit against the street rather than inferring it from two numbers.
 */
function Depth({ eng, view }: { eng: FiEngine; view: NodeView | null }) {
  if (!view) return <Empty>Pick an issue on the matrix.</Empty>
  const nd = view.node
  const tick = nd.kind === 'cash' ? 1 / 64 : 0.0025
  const fmtP = (p: number) => nd.kind === 'cash' ? fmt32Eighths(p) : p.toFixed(4)
  const mid = view.modelPrice
  const levels = 6

  const rows: { price: number; bidSz: number; askSz: number; ours: 'B' | 'A' | null }[] = []
  for (let i = levels; i >= -levels; i--) {
    const price = mid + i * tick
    const isAsk = i > 0
    // Street depth thins as it walks away from the mid, which is why sweeping
    // the book costs more than the top-of-book spread implies.
    const depth = Math.round(40 / (1 + Math.abs(i) * 0.8))
    const ours = !isAsk && Math.abs(price - view.quote.bid) < tick / 2 ? 'B'
      : isAsk && Math.abs(price - view.quote.ask) < tick / 2 ? 'A' : null
    rows.push({
      price,
      bidSz: isAsk ? 0 : depth,
      askSz: isAsk ? depth : 0,
      ours,
    })
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {['Bid size', 'Price', 'Ask size', 'Yield'].map((c, i) => (
            <th key={c} style={{ ...TH, textAlign: i === 1 ? 'center' : 'right' }}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const y = nd.kind === 'stir' ? (100 - r.price) / 100 : null
          return (
            <tr key={i} style={{ background: r.ours ? alpha(T.gold, 14) : 'transparent' }}>
              <td style={{ ...TD, color: r.bidSz ? GOOD : T.muted }}>
                {r.bidSz ? `${r.bidSz}mm` : ''}{r.ours === 'B' ? ` (${view.quote.bidSize})` : ''}
              </td>
              <td style={{ ...TD, textAlign: 'center', color: r.ours ? T.gold : T.text, fontWeight: r.ours ? 700 : 500 }}>
                {fmtP(r.price)}
              </td>
              <td style={{ ...TD, color: r.askSz ? BAD : T.muted }}>
                {r.askSz ? `${r.askSz}mm` : ''}{r.ours === 'A' ? ` (${view.quote.askSize})` : ''}
              </td>
              <td style={{ ...TD, color: T.muted }}>
                {y != null ? `${(y * 100).toFixed(3)}%` : ''}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Fills({ eng }: { eng: FiEngine }) {
  if (!eng.fills.length) return <Empty>No trades yet. Run the session and the desk will start getting hit.</Empty>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          {['Issue', 'Side', 'Size', 'Price', 'Yield', 'Edge', 'Counterparty', 'Marked'].map((c, i) => (
            <th key={c} style={{ ...TH, textAlign: i < 2 ? 'left' : 'right' }}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {eng.fills.slice(0, 60).map(f => {
          const nd = eng.nodes[f.nodeId]
          return (
            <tr key={f.id}>
              <td style={{ ...TD, textAlign: 'left', color: T.text }}>{nd.label}</td>
              <td style={{ ...TD, textAlign: 'left', color: f.side === 'B' ? GOOD : BAD }}>
                {f.side === 'B' ? 'BOUGHT' : 'SOLD'}
              </td>
              <td style={TD}>{f.size}{nd.unit === 'MM' ? 'mm' : ''}</td>
              <td style={TD}>{nd.kind === 'cash' ? fmt32(f.price) : f.price.toFixed(4)}</td>
              <td style={TD}>{(f.yield * 100).toFixed(3)}%</td>
              <td style={{ ...TD, color: T.gold }}>{f.edgeBp.toFixed(2)} bp</td>
              <td style={{ ...TD, color: f.participant === 'informed' ? BAD : T.muted }}>{f.participant}</td>
              <td style={{ ...TD, color: f.markPnl > 0 ? GOOD : f.markPnl < 0 ? BAD : T.muted }}>
                {f.markPnl === 0 ? '—' : fmtMoney(f.markPnl)}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/**
 * Where the money came from, over the session.
 *
 * Spread capture, curve delta and carry are drawn as separate lines rather than
 * a single P&L, because on a rates book they are three different businesses and
 * a desk that is only making money on curve delta is not market making.
 */
function AttributionGraph({ eng, tick }: { eng: FiEngine; tick: number }) {
  const tokens = useTokens()
  const s = eng.samples
  if (s.length < 2) return <Empty>Run the session and the attribution builds as it goes.</Empty>

  const series = [
    // Every bucket the engine books into is drawn. The five add up to total
    // P&L exactly, which is the only reason this graph can be trusted.
    { key: 'spread' as const, label: 'Spread capture', color: tokens['--theme-positive'] || '#22c55e' },
    { key: 'curve' as const, label: 'Curve delta', color: tokens['--theme-tertiary'] || '#60a5fa' },
    { key: 'carry' as const, label: 'Carry and roll', color: tokens['--theme-primary'] || '#c9a84c' },
    { key: 'convexity' as const, label: 'Convexity', color: tokens['--theme-secondary'] || '#8099b0' },
    { key: 'hedge' as const, label: 'Hedge cost', color: tokens['--theme-negative'] || '#ef4444' },
  ]

  return (
    <div>
      <div style={{ display: 'flex', gap: 14, marginBottom: 4, flexWrap: 'wrap' }}>
        {series.map(x => (
          <span key={x.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 2, background: x.color }} />
            <span style={{ ...LABEL, fontSize: 8 }}>{x.label}</span>
            <span style={{ ...MONO, fontSize: 10, color: T.text }}>{fmtMoney(eng.attr[x.key])}</span>
          </span>
        ))}
      </div>
      <Canvas
        height={116}
        draw={(ctx, w, h) => {
          const pad = 4
          let lo = 0
          let hi = 0
          for (const p of s) for (const x of series) {
            lo = Math.min(lo, p.attr[x.key])
            hi = Math.max(hi, p.attr[x.key])
          }
          const span = Math.max(hi - lo, 1)
          const xAt = (i: number) => pad + (i / Math.max(s.length - 1, 1)) * (w - pad * 2)
          const yAt = (v: number) => h - pad - ((v - lo) / span) * (h - pad * 2)

          ctx.strokeStyle = tokens['--theme-border'] || 'rgba(255,255,255,0.1)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(pad, yAt(0))
          ctx.lineTo(w - pad, yAt(0))
          ctx.stroke()

          for (const x of series) {
            ctx.strokeStyle = x.color
            ctx.lineWidth = 1.4
            ctx.beginPath()
            s.forEach((p, i) => {
              const px = xAt(i)
              const py = yAt(p.attr[x.key])
              if (i === 0) ctx.moveTo(px, py)
              else ctx.lineTo(px, py)
            })
            ctx.stroke()
          }
        }}
      />
    </div>
  )
}

function Log({ eng }: { eng: FiEngine }) {
  if (!eng.events.length) return <Empty>Nothing logged yet.</Empty>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {eng.events.slice(0, 60).map((e, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, ...MONO, fontSize: 10 }}>
          <span style={{ color: T.muted, width: 62 }}>{e.kind}</span>
          <span style={{ color: e.sev === 2 ? BAD : e.sev === 1 ? T.gold : T.text }}>{e.text}</span>
        </div>
      ))}
    </div>
  )
}
