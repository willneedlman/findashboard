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

export type Highlight = 'none' | 'delta' | 'gamma' | 'vega' | 'theta'

/**
 * Chain column widths, as percentages of the table.
 *
 * Percentages, never pixels: this is the single thing that makes horizontal
 * scrolling impossible at laptop width, which is why the total is asserted in
 * Chain.test.ts rather than left to arithmetic in a review.
 * Order is calls (pos, iv, theo, your bid/ask, market bid/ask), strike, then
 * puts mirrored.
 */
export const CALL_COLS = [5, 5.4, 6.4, 7, 6.2, 6.2, 7]
export const STRIKE_COLS = [8, 5.6]
export const PUT_COLS = [7, 6.2, 6.2, 7, 6.4, 5.4, 5]

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

export function Chain({ eng, rows, sel, onSel, expIdx, highlight, live, spot, tick }: {
  eng: Mm2Engine; rows: ChainRow[]; sel: number; onSel: (ck: number) => void
  expIdx: number; highlight: Highlight; live: boolean; spot: number; tick: number
}) {
  void tick
  const flash = useFlash(eng, live)
  const selStrike = eng.contracts[sel]?.strike
  const selExp = eng.contracts[sel]?.expIdx
  const maxContribution = Math.max(1e-9, ...rows.flatMap(r =>
    [contribution(r.call, highlight), contribution(r.put, highlight)].map(Math.abs)))

  const atmK = Math.round(spot / 10) * 10
  const inScope = (k: number) => Math.abs(k - atmK) <= eng.cfg.quoteWidth * 10

  return (
    <div style={{ height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        {/* Percentages, never pixels: this is what makes sideways scrolling impossible. */}
        <colgroup>
          {CALL_COLS.map((w, i) => <col key={`c${i}`} style={{ width: `${w}%` }} />)}
          {STRIKE_COLS.map((w, i) => <col key={`k${i}`} style={{ width: `${w}%` }} />)}
          {PUT_COLS.map((w, i) => <col key={`p${i}`} style={{ width: `${w}%` }} />)}
        </colgroup>
        <thead>
          <tr>
            <th colSpan={7} style={{ ...BAND, textAlign: 'left', background: '#16202f', color: T.blue }}>Calls</th>
            <th colSpan={2} style={{ ...BAND, textAlign: 'center', background: '#1a2438', color: T.text }}>Strike</th>
            <th colSpan={7} style={{ ...BAND, textAlign: 'right', background: '#1b1c33', color: VIOLET }}>Puts</th>
          </tr>
          <tr>
            <th style={{ ...GROUP, top: 21 }}>pos</th>
            <th colSpan={2} style={{ ...GROUP, top: 21, borderLeft: `1px solid ${T.border}` }}>Model</th>
            <th colSpan={2} style={{ ...GROUP, top: 21, borderLeft: `1px solid ${T.border}`, background: quoteTint(T.blue), color: T.blue }}>Your quote</th>
            <th colSpan={2} style={{ ...GROUP, top: 21, borderLeft: `1px solid ${T.border}` }}>Market</th>
            <th colSpan={2} style={{ ...GROUP, top: 21, borderLeft: `1px solid ${T.border}` }} />
            <th colSpan={2} style={{ ...GROUP, top: 21, borderLeft: `1px solid ${T.border}` }}>Market</th>
            <th colSpan={2} style={{ ...GROUP, top: 21, borderLeft: `1px solid ${T.border}`, background: quoteTint(VIOLET), color: VIOLET }}>Your quote</th>
            <th colSpan={2} style={{ ...GROUP, top: 21, borderLeft: `1px solid ${T.border}` }}>Model</th>
            <th style={{ ...GROUP, top: 21, borderLeft: `1px solid ${T.border}` }}>pos</th>
          </tr>
          <tr>
            <th style={{ ...COL, top: 38 }} />
            <th style={{ ...COL, top: 38 }}>iv</th><th style={{ ...COL, top: 38 }}>theo</th>
            <th style={{ ...COL, top: 38, background: quoteTint(T.blue), color: T.blue }}>bid</th>
            <th style={{ ...COL, top: 38, background: quoteTint(T.blue), color: T.blue }}>ask</th>
            <th style={{ ...COL, top: 38 }}>bid</th><th style={{ ...COL, top: 38 }}>ask</th>
            <th style={{ ...COL, top: 38, background: '#1a2438', textAlign: 'center' }}>K</th>
            <th style={{ ...COL, top: 38, background: '#1a2438' }}>%</th>
            <th style={{ ...COL, top: 38 }}>bid</th><th style={{ ...COL, top: 38 }}>ask</th>
            <th style={{ ...COL, top: 38, background: quoteTint(VIOLET), color: VIOLET }}>bid</th>
            <th style={{ ...COL, top: 38, background: quoteTint(VIOLET), color: VIOLET }}>ask</th>
            <th style={{ ...COL, top: 38 }}>theo</th><th style={{ ...COL, top: 38 }}>iv</th>
            <th style={{ ...COL, top: 38 }} />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const atm = Math.abs(r.strike - spot) < 6
            const rowSel = r.strike === selStrike && expIdx === selExp
            const scoped = inScope(r.strike)
            return (
              <tr key={r.strike} style={{
                background: rowSel ? alpha(T.gold, 9) : atm ? alpha(T.gold, 9) : undefined,
                borderTop: atm ? `1px solid ${alpha(T.gold, 30)}` : `1px solid ${T.borderFaint}`,
              }}>
                {legCells(r.call, 'C', sel, onSel, flash, highlight, maxContribution, live)}
                <td onClick={() => onSel(r.call.ck)} style={{
                  ...MONO, fontSize: 12, fontWeight: 700, padding: '4px 6px', textAlign: 'center', cursor: 'pointer',
                  color: atm ? T.gold : T.text, background: scoped ? alpha(T.gold, 6) : undefined,
                }}>{r.strike}</td>
                <td style={{
                  ...MONO, fontSize: 9.5, padding: '4px 6px', textAlign: 'right', color: T.muted,
                  background: scoped ? alpha(T.gold, 6) : undefined, borderRight: `1px solid ${T.border}`,
                }}>{((r.strike / spot - 1) * 100).toFixed(1)}</td>
                {legCells(r.put, 'P', sel, onSel, flash, highlight, maxContribution, live)}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const VIOLET = T.violet
const quoteTint = (c: string) => `color-mix(in srgb, ${c} 10%, ${T.surface})`

// Sticky offsets sit 1-3px tighter than the natural row heights so no sliver of
// a scrolling row can show between the three header rows.
const BAND: React.CSSProperties = {
  ...LABEL, fontSize: 9, letterSpacing: '0.18em', padding: '3px 8px',
  position: 'sticky', top: 0, zIndex: 4,
}
const GROUP: React.CSSProperties = {
  ...LABEL, fontSize: 8, letterSpacing: '0.14em', padding: '2px 6px', textAlign: 'center',
  background: T.surface, position: 'sticky', zIndex: 3,
}
const COL: React.CSSProperties = {
  ...MONO, fontSize: 9, fontWeight: 600, color: T.muted, padding: '2px 6px', textAlign: 'right',
  background: T.surface, position: 'sticky', zIndex: 3, borderBottom: `1px solid ${T.border}`,
}

function contribution(leg: LegView, h: Highlight): number {
  if (h === 'none' || !leg.pos) return 0
  if (h === 'delta') return leg.pos * leg.delta * MULT
  if (h === 'gamma') return leg.pos * leg.gamma * MULT
  if (h === 'vega') return leg.pos * leg.vega
  return leg.pos * leg.theta * MULT
}

function legCells(
  leg: LegView, kind: 'C' | 'P', sel: number, onSel: (ck: number) => void,
  flash: Map<number, number>, highlight: Highlight, maxContribution: number, live: boolean,
) {
  const isSel = leg.ck === sel
  const flashed = flash.get(leg.ck)
  const contrib = contribution(leg, highlight)
  const contribBg = highlight !== 'none' && contrib !== 0
    ? alpha(contrib > 0 ? GOOD : BAD, Math.min(22, 6 + 16 * Math.abs(contrib) / maxContribution))
    : undefined
  const hue = kind === 'C' ? T.blue : VIOLET
  const kp = leg.ck
  const ring = isSel ? { boxShadow: `inset 0 1px 0 ${T.gold}, inset 0 -1px 0 ${T.gold}` } : null
  const base: React.CSSProperties = {
    ...MONO, fontSize: 11, padding: '4px 6px', textAlign: 'right', cursor: 'pointer',
    background: flashed ? alpha(flashed > 0 ? GOOD : BAD, 26) : contribBg,
    opacity: leg.expired ? 0.4 : 1, ...ring,
  }
  const click = () => onSel(leg.ck)
  const dash = leg.expired ? '—' : null

  const pos = (
    <td key={`${kp}pos`} onClick={click} style={{ ...base, color: leg.pos > 0 ? GOOD : leg.pos < 0 ? BAD : alpha(T.muted, 50), fontWeight: leg.pos ? 700 : 400 }}>
      {leg.pos || '·'}
    </td>
  )
  const model = [
    <td key={`${kp}iv`} onClick={click} style={{ ...base, color: alpha(T.text, 78) }}>{dash ?? (leg.iv * 100).toFixed(1)}</td>,
    <td key={`${kp}th`} onClick={click} style={{ ...base, color: T.gold, fontWeight: 600 }}>{dash ?? leg.theo.toFixed(2)}</td>,
  ]
  const ours = [
    <QuoteCell key={`${kp}ob`} leg={leg} side="B" hue={hue} onClick={click} live={live} ring={ring} />,
    <QuoteCell key={`${kp}oa`} leg={leg} side="A" hue={hue} onClick={click} live={live} ring={ring} />,
  ]
  // Market is deliberately recessed: the surface fill is what makes it read as
  // the backdrop your own quote sits against.
  const market = [
    <td key={`${kp}mb`} onClick={click} style={{ ...base, color: alpha(T.text, 58), background: base.background ?? T.surface }}>{dash ?? leg.mktBid.toFixed(2)}</td>,
    <td key={`${kp}ma`} onClick={click} style={{ ...base, color: alpha(T.text, 58), background: base.background ?? T.surface }}>{dash ?? leg.mktAsk.toFixed(2)}</td>,
  ]
  return kind === 'C'
    ? [pos, ...model, ...ours, ...market]
    : [...market, ...ours, ...model.reverse(), pos]
}

/** Your quote: hue by side, and inside-versus-outside the market is the loudest signal. */
function QuoteCell({ leg, side, hue, onClick, live, ring }: {
  leg: LegView; side: 'B' | 'A'; hue: string; onClick: () => void
  live: boolean; ring: React.CSSProperties | null
}) {
  const px = side === 'B' ? leg.ourBid : leg.ourAsk
  const state: QuoteState = side === 'B' ? leg.bidState : leg.askState
  const size = side === 'B' ? leg.ourBidSz : leg.ourAskSz
  const inside = side === 'B' ? px >= leg.mktBid - 1e-9 : px <= leg.mktAsk + 1e-9
  const quoted = live && size > 0 && px > 0 && state === 'active'

  return (
    <td onClick={onClick} style={{
      ...MONO, fontSize: 11, padding: '4px 6px', textAlign: 'right', cursor: 'pointer',
      color: !quoted ? alpha(T.muted, 42) : inside ? hue : alpha(hue, 62),
      background: !quoted ? undefined : alpha(hue, inside ? 13 : 5),
      fontWeight: quoted && inside ? 700 : 400,
      opacity: leg.expired ? 0.4 : 1, ...ring,
    }}>
      {!live ? '—' : quoted ? px.toFixed(2) : '·'}
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
