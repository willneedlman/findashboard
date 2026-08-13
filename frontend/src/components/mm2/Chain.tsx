/*
 * Options MM 2 — expiry strip and the options chain.
 *
 * Calls left, puts right, strike down the middle. This is the tool; everything
 * else on the screen supports it, so it gets the space and the fewest columns
 * that still let you read the market, your quote and your position at a glance.
 */

import { useRef } from 'react'
import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, pnlColor, GOOD, BAD, WARN } from './ui'
import { DTE_LABELS, DTES, MULT, type ChainRow, type LegView, type Mm2Engine, type QuoteState } from '../../lib/mm2/engine'

export type Density = 'full' | 'compact'
export type Highlight = 'none' | 'delta' | 'gamma' | 'vega' | 'theta'

// ── Expiry strip ──────────────────────────────────────────────────────────────

export function ExpiryStrip({ eng, expIdx, onPick, tick }: {
  eng: Mm2Engine; expIdx: number; onPick: (e: number) => void; tick: number
}) {
  void tick
  const per = DTES.map((_, e) => {
    let pnl = 0, contracts = 0
    for (let i = 0; i < eng.pos.length; i++) {
      if (eng.contracts[i].expIdx !== e) continue
      const p = eng.pos[i]
      pnl += eng.contractPnl[i] + (p ? (eng.theo[i] - eng.avgPx[i]) * p * MULT : 0)
      contracts += Math.abs(p)
    }
    const expired = eng.expired[eng.idxOf(e, eng.strikes[0], 'C')] === 1
    return { e, pnl, contracts, expired, atm: expired ? 0 : eng.atmIv(e) }
  })

  return (
    <div style={{ display: 'flex', borderBottom: `1px solid ${T.border}`, background: T.surface, flexShrink: 0 }}>
      {per.map(p => {
        const on = p.e === expIdx
        const quoting = p.e < eng.cfg.quoteExpiries && !p.expired
        return (
          <button key={p.e} onClick={() => onPick(p.e)} style={{
            flex: '1 1 0', minWidth: 0, padding: '4px 7px', cursor: 'pointer', textAlign: 'left',
            border: 'none', borderRight: `1px solid ${T.borderFaint}`,
            borderTop: `2px solid ${on ? T.gold : 'transparent'}`,
            background: on ? alpha(T.gold, 10) : 'transparent',
            opacity: p.expired ? 0.4 : 1,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
              <span style={{ ...MONO, fontSize: 11.5, fontWeight: 700, color: on ? T.gold : T.text }}>{DTE_LABELS[p.e]}</span>
              {quoting && <span style={{ ...MONO, fontSize: 8, color: alpha(GOOD, 85) }}>quoting</span>}
            </div>
            <div style={{ display: 'flex', gap: 8, ...MONO, fontSize: 9.5 }}>
              <span style={{ color: T.muted }}>{p.expired ? 'expired' : `${(p.atm * 100).toFixed(1)}%`}</span>
              {p.contracts > 0 && <span style={{ color: pnlColor(p.pnl) }}>{fmtK(p.pnl)}</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ── Chain ─────────────────────────────────────────────────────────────────────

export function Chain({ eng, rows, sel, onSel, expIdx, density, highlight, live, spot, tick }: {
  eng: Mm2Engine; rows: ChainRow[]; sel: number; onSel: (ck: number) => void
  expIdx: number; density: Density; highlight: Highlight; live: boolean; spot: number; tick: number
}) {
  void tick
  const flash = useFlash(eng, live)
  const full = density === 'full'
  const selStrike = eng.contracts[sel]?.strike
  const selExp = eng.contracts[sel]?.expIdx

  const t = eng.expiryT(expIdx)
  const move = spot * eng.atmIv(expIdx) * Math.sqrt(Math.max(t, 0))

  const maxContribution = Math.max(1e-9, ...rows.flatMap(r =>
    [contribution(r.call, highlight), contribution(r.put, highlight)].map(Math.abs)))

  return (
    <div style={{ overflow: 'auto', height: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <colgroup>
          {sideCols(full, false, 'c')}
          <col style={{ width: 52 }} /><col style={{ width: 42 }} />
          {sideCols(full, true, 'p')}
        </colgroup>
        <thead>
          <tr>
            <th colSpan={full ? 11 : 7} style={groupHead(T.blue)}>Calls</th>
            <th colSpan={2} style={{ ...groupHead(T.muted), background: T.surface }}>Strike</th>
            <th colSpan={full ? 11 : 7} style={groupHead(T.gold)}>Puts</th>
          </tr>
          <tr>
            {headCells(full, false, 'c')}
            <th style={hSt}>K</th><th style={hSt}>%</th>
            {headCells(full, true, 'p')}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const atm = Math.abs(r.strike - spot) < 5
            const inBand = Math.abs(r.strike - spot) <= move
            const rowSel = r.strike === selStrike && expIdx === selExp
            return (
              <tr key={r.strike} style={{
                background: rowSel ? alpha(T.gold, 9) : atm ? alpha(T.text, 4) : undefined,
                borderTop: atm ? `1px solid ${alpha(T.gold, 26)}` : `1px solid ${T.borderFaint}`,
              }}>
                {legCells(r.call, full, sel, onSel, flash, highlight, maxContribution, live)}
                <td onClick={() => onSel(r.call.ck)} style={{
                  ...MONO, fontSize: 11.5, fontWeight: 700, padding: '3px 5px', textAlign: 'center', cursor: 'pointer',
                  color: rowSel ? T.gold : T.text, background: inBand ? alpha(T.gold, 7) : undefined,
                  borderLeft: `1px solid ${T.border}`,
                }}>{r.strike}</td>
                <td style={{ ...MONO, fontSize: 9.5, padding: '3px 5px', textAlign: 'right', color: T.muted, borderRight: `1px solid ${T.border}` }}>
                  {((r.strike / spot - 1) * 100).toFixed(1)}
                </td>
                {legCells(r.put, full, sel, onSel, flash, highlight, maxContribution, live, true)}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Header cells use plain mono: LABEL's 0.16em tracking runs adjacent short
// headings together at these column widths.
const hSt: React.CSSProperties = {
  ...MONO, fontSize: 9, fontWeight: 600, color: T.muted, padding: '3px 5px',
  textAlign: 'right', background: T.surface, borderBottom: `1px solid ${T.border}`,
  whiteSpace: 'nowrap', position: 'sticky', top: 22, zIndex: 1,
}
const groupHead = (c: string): React.CSSProperties => ({
  ...LABEL, fontSize: 8.5, padding: '3px 5px', textAlign: 'center', color: alpha(c, 80),
  background: alpha(c, 7), borderBottom: `1px solid ${T.border}`,
  position: 'sticky', top: 0, zIndex: 2,
})

function sideCols(full: boolean, mirror = false, tag = 'c') {
  const w = full
    ? [38, 52, 38, 44, 50, 32, 50, 48, 48, 50, 32]
    : [42, 46, 52, 54, 52, 52, 54]
  const list = mirror ? [...w].reverse() : w
  return list.map((x, i) => <col key={`${tag}${i}`} style={{ width: x }} />)
}

function headCells(full: boolean, mirror: boolean, tag: string) {
  const labels = full
    ? ['pos', 'p&l', 'delta', 'iv', 'theo', 'sz', 'bid', 'mkt bid', 'mkt ask', 'ask', 'sz']
    : ['pos', 'iv', 'theo', 'bid', 'mkt bid', 'mkt ask', 'ask']
  const list = mirror ? [...labels].reverse() : labels
  return list.map((l, i) => <th key={`${tag}${i}`} style={hSt}>{l}</th>)
}

function contribution(leg: LegView, h: Highlight): number {
  if (h === 'none' || !leg.pos) return 0
  if (h === 'delta') return leg.pos * leg.delta * MULT
  if (h === 'gamma') return leg.pos * leg.gamma * MULT
  if (h === 'vega') return leg.pos * leg.vega
  return leg.pos * leg.theta * MULT
}

function legCells(
  leg: LegView, full: boolean, sel: number, onSel: (ck: number) => void,
  flash: Map<number, number>, highlight: Highlight, maxContribution: number,
  live: boolean, mirror = false,
) {
  const isSel = leg.ck === sel
  const flashed = flash.get(leg.ck)
  const contrib = contribution(leg, highlight)
  const contribBg = highlight !== 'none' && contrib !== 0
    ? alpha(contrib > 0 ? GOOD : BAD, Math.min(22, 6 + 16 * Math.abs(contrib) / maxContribution))
    : undefined

  const kp = leg.ck
  const selRing = isSel ? { boxShadow: `inset 0 1px 0 ${T.gold}, inset 0 -1px 0 ${T.gold}` } : null
  const base: React.CSSProperties = {
    ...MONO, fontSize: 10.5, padding: '3px 5px', textAlign: 'right', cursor: 'pointer',
    background: flashed ? alpha(flashed > 0 ? GOOD : BAD, 26) : contribBg,
    opacity: leg.expired ? 0.4 : 1,
    ...selRing,
  }
  const click = () => onSel(leg.ck)
  const dash = leg.expired ? '—' : null

  const cells = [
    <td key={`${kp}pos`} onClick={click} style={{ ...base, color: leg.pos > 0 ? GOOD : leg.pos < 0 ? BAD : alpha(T.muted, 50), fontWeight: leg.pos ? 700 : 400 }}>
      {leg.pos || '·'}
    </td>,
    full && <td key={`${kp}pnl`} onClick={click} style={{ ...base, color: pnlColor(leg.pnl) }}>{leg.pnl ? fmtK(leg.pnl) : '·'}</td>,
    full && <td key={`${kp}dl`} onClick={click} style={{ ...base, color: alpha(T.text, 68) }}>{dash ?? leg.delta.toFixed(2)}</td>,
    <td key={`${kp}iv`} onClick={click} style={{ ...base, color: T.text }}>{dash ?? (leg.iv * 100).toFixed(1)}</td>,
    <td key={`${kp}th`} onClick={click} style={{ ...base, color: T.gold, fontWeight: 600, borderRight: `1px solid ${T.borderFaint}` }}>{dash ?? leg.theo.toFixed(2)}</td>,
    full && <td key={`${kp}bs`} onClick={click} style={{ ...base, color: alpha(T.muted, 80), fontSize: 9 }}>{leg.live && leg.ourBidSz ? leg.ourBidSz : '·'}</td>,
    <QuoteCell key={`${kp}ob`} leg={leg} side="B" onClick={click} live={live} ring={selRing} />,
    <td key={`${kp}mb`} onClick={click} style={{ ...base, color: alpha(T.text, 60) }}>{dash ?? leg.mktBid.toFixed(2)}</td>,
    <td key={`${kp}ma`} onClick={click} style={{ ...base, color: alpha(T.text, 60) }}>{dash ?? leg.mktAsk.toFixed(2)}</td>,
    <QuoteCell key={`${kp}oa`} leg={leg} side="A" onClick={click} live={live} ring={selRing} />,
    full && <td key={`${kp}as`} onClick={click} style={{ ...base, color: alpha(T.muted, 80), fontSize: 9 }}>{leg.live && leg.ourAskSz ? leg.ourAskSz : '·'}</td>,
  ].filter(Boolean) as React.ReactElement[]

  return mirror ? [...cells].reverse() : cells
}

/** Own-quote cell: colour carries the state, so a glance reads the whole book. */
function QuoteCell({ leg, side, onClick, live, ring }: {
  leg: LegView; side: 'B' | 'A'; onClick: () => void; live: boolean; ring: React.CSSProperties | null
}) {
  const px = side === 'B' ? leg.ourBid : leg.ourAsk
  const state: QuoteState = side === 'B' ? leg.bidState : leg.askState
  const size = side === 'B' ? leg.ourBidSz : leg.ourAskSz
  const sideColor = side === 'B' ? T.blue : '#a78bfa'
  const inside = side === 'B' ? px >= leg.mktBid - 1e-9 : px <= leg.mktAsk + 1e-9

  let color = alpha(T.text, 55)
  let border = '1px solid transparent'
  let bg: string | undefined

  if (!live) color = alpha(T.muted, 45)
  else if (state === 'riskBlocked') { color = BAD; bg = alpha(BAD, 12) }
  else if (state === 'capped') { color = WARN; bg = alpha(WARN, 10) }
  else if (state === 'modelBlocked' || state === 'off') color = alpha(T.muted, 42)
  else if (size > 0) {
    color = inside ? sideColor : alpha(sideColor, 60)
    border = `1px solid ${alpha(sideColor, inside ? 55 : 20)}`
    bg = inside ? alpha(sideColor, 9) : undefined
  }

  return (
    <td onClick={onClick} style={{
      ...MONO, fontSize: 10.5, padding: '2px 5px', textAlign: 'right', cursor: 'pointer',
      color, background: bg, border, fontWeight: inside && size > 0 && live ? 700 : 400,
      opacity: leg.expired ? 0.4 : 1, ...ring,
    }}>
      {!live ? '—' : state === 'off' || px <= 0 ? '·' : px.toFixed(2)}
    </td>
  )
}

/** Briefly tint the contract that just traded; sign carries which way it went. */
function useFlash(eng: Mm2Engine, live: boolean): Map<number, number> {
  const store = useRef(new Map<number, { dir: number; at: number }>())
  const lastId = useRef(0)
  // Derived during render rather than in an effect: the component already
  // repaints every frame, and an effect-scheduled timeout was being cancelled
  // by the next frame before it could ever clear the highlight.
  if (live) {
    const now = performance.now()
    let top = lastId.current
    for (const f of eng.fills) {
      if (f.id <= lastId.current) continue
      store.current.set(f.ck, { dir: f.edge >= 0 ? 1 : -1, at: now })
      top = Math.max(top, f.id)
    }
    lastId.current = top
    for (const [k, v] of store.current) if (now - v.at > 700) store.current.delete(k)
  } else if (store.current.size) {
    store.current.clear()
  }
  const out = new Map<number, number>()
  for (const [k, v] of store.current) out.set(k, v.dir)
  return out
}

export function fmtK(v: number): string {
  const a = Math.abs(v)
  if (a < 1000) return v.toFixed(0)
  if (a < 1_000_000) return `${(v / 1000).toFixed(a < 10_000 ? 1 : 0)}k`
  return `${(v / 1_000_000).toFixed(2)}m`
}
