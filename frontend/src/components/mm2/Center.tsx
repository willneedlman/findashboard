/*
 * Options MM 2 — the chain header and the contract inspector.
 *
 * Both render without panel chrome; their parents supply the frame. The header
 * folds the old standalone underlying strip into the chain panel, which is where
 * the vertical budget for a no-scroll laptop layout came from.
 */

import { T, alpha } from '../../lib/theme'
import { Canvas, useTokens, hexAlpha, MONO, LABEL, Empty, GOOD, BAD, pnlColor } from './ui'
import { fmtK } from './Chain'
import { DTE_LABELS, MULT, type LegView, type Mm2Engine, type Sample } from '../../lib/mm2/engine'

/**
 * Chain header: spot, vol and the session plot in one 46px band.
 *
 * The standalone 52px underlying strip is folded in here — that is where the
 * vertical budget for a no-scroll laptop layout came from. The plot sits in a
 * recessed box with an area fill so it reads as present without competing with
 * the chain for attention.
 */
export function ChainHeader({ eng, tick, reviewT, onScrub, highlight, expLabel }: {
  eng: Mm2Engine; tick: number; reviewT: number | null
  onScrub: (t: number | null) => void; highlight: string; expLabel: string
}) {
  const tok = useTokens()
  void tick
  const s = eng.samples
  const first = s[0]
  const chg = s.length && first ? eng.spot - first.spot : 0
  const half = eng.spot * (eng.cfg.underlyingSpreadBps / 10000) / 2

  let rv = 0
  if (s.length > 30) {
    const rets: number[] = []
    for (let i = Math.max(1, s.length - 300); i < s.length; i++) rets.push(Math.log(s[i].spot / s[i - 1].spot))
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length
    const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1)
    rv = Math.sqrt(varr * 365 * 24 * 3600)
  }
  const lo = s.length ? Math.min(...s.map(p => p.spot)) : eng.spot
  const hi = s.length ? Math.max(...s.map(p => p.spot)) : eng.spot

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0, height: 46, boxSizing: 'border-box',
      background: T.surface, borderBottom: `1px solid ${T.border}`, padding: '0 12px',
    }}>
      <div style={{ flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
          <span style={{ ...LABEL, fontSize: 9 }}>SPX</span>
          <span style={{ ...MONO, fontSize: 20, fontWeight: 700, color: T.gold }}>{eng.spot.toFixed(2)}</span>
          <span style={{ ...MONO, fontSize: 11, color: pnlColor(chg) }}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}</span>
        </div>
        <div style={{ ...MONO, fontSize: 9.5, color: T.muted }}>
          bid <span style={{ color: alpha(T.text, 80) }}>{(eng.spot - half).toFixed(2)}</span>
          {'  '}ask <span style={{ color: alpha(T.text, 80) }}>{(eng.spot + half).toFixed(2)}</span>
        </div>
      </div>

      <div style={{ flexShrink: 0, ...MONO, fontSize: 10.5, lineHeight: 1.35 }}>
        <div style={{ color: T.muted }}>realized <span style={{ color: T.text }}>{(rv * 100).toFixed(1)}%</span></div>
        <div style={{ color: T.muted }}>implied <span style={{ color: T.text }}>{(eng.atmIv(2) * 100).toFixed(1)}%</span></div>
      </div>

      <div style={{
        flex: 1, minWidth: 200, height: 38, position: 'relative', boxSizing: 'border-box',
        background: 'rgba(0,0,0,0.16)', borderBottom: '1px solid rgba(255,255,255,0.05)',
        borderLeft: `1px solid ${T.borderFaint}`, borderRight: `1px solid ${T.borderFaint}`,
        padding: '3px 8px',
      }}>
        <Canvas height={22} onPick={xf => {
          if (s.length < 2) return
          onScrub(s[0].t + xf * (s[s.length - 1].t - s[0].t))
        }} draw={(ctx, w, h) => {
          if (!tok.gold || s.length < 2) return
          const t0 = s[0].t, span = Math.max(s[s.length - 1].t - t0, 1)
          const pad = Math.max((hi - lo) * 0.15, 0.4)
          const top = hi + pad, bot = lo - pad
          const X = (t: number) => ((t - t0) / span) * w
          const Y = (v: number) => h - ((v - bot) / Math.max(top - bot, 1e-9)) * h

          ctx.beginPath()
          ctx.moveTo(X(s[0].t), h)
          s.forEach(p => ctx.lineTo(X(p.t), Y(p.spot)))
          ctx.lineTo(X(s[s.length - 1].t), h)
          ctx.closePath()
          ctx.fillStyle = hexAlpha(tok.gold, 0.14)
          ctx.fill()

          for (const m of eng.markers) {
            const x = X(m.t)
            if (x < 0 || x > w) continue
            const c = m.kind === 'hedge' ? tok.blue : m.kind === 'shock' ? tok.warn : m.kind === 'kill' ? tok.neg : tok.muted
            ctx.strokeStyle = hexAlpha(c, 0.4)
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
          }
          ctx.beginPath()
          s.forEach((p, i) => { const x = X(p.t), y = Y(p.spot); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
          ctx.strokeStyle = tok.gold
          ctx.lineWidth = 1.8
          ctx.stroke()
          if (reviewT !== null) {
            const x = X(reviewT)
            ctx.strokeStyle = tok.text
            ctx.setLineDash([3, 3])
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
            ctx.setLineDash([])
          }
        }} />
        <span aria-hidden style={{
          position: 'absolute', right: 6, top: 6, width: 5, height: 5, background: T.gold,
        }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 1 }}>
          <span style={{ ...LABEL, fontSize: 8.5 }}>Session {lo.toFixed(2)} to {hi.toFixed(2)}</span>
          <span style={{ ...MONO, fontSize: 9, color: T.muted }}>
            {highlight !== 'none' ? `tracing ${highlight}` : 'click to rewind'}
          </span>
        </div>
      </div>

      <span style={{ ...MONO, fontSize: 9.5, color: T.muted, flexShrink: 0 }}>{expLabel}</span>
    </div>
  )
}

function Pair({ k, v }: { k: string; v: string }) {
  return <span style={{ color: T.muted }}>{k} <span style={{ color: T.text }}>{v}</span></span>
}

// ── Contract inspector ────────────────────────────────────────────────────────

/**
 * Four columns: what the model says, what you own, the greeks, and the ladder.
 *
 * The old quote-math stack is gone. Ten rows of `0.000` per side told the reader
 * almost nothing; `edge each side` carries the same fact, and the widen terms
 * that produce it live in Setup.
 */
export function ContractBody({ eng, sel, live, sample, leg }: {
  eng: Mm2Engine; sel: number; live: boolean; sample: Sample | null; leg: LegView | null
}) {
  const c = eng.contracts[sel]
  const q = eng.quotes[sel]
  const view = !live && leg ? leg : null
  const pos = view ? view.pos : eng.pos[sel]
  const theo = view ? view.theo : eng.theo[sel]
  const iv = view ? view.iv : eng.trueIv[sel]
  const mktBid = view ? view.mktBid : eng.mktBid[sel]
  const mktAsk = view ? view.mktAsk : eng.mktAsk[sel]
  const expired = view ? view.expired : !!eng.expired[sel]
  const pnl = eng.contractPnl[sel] + (pos ? (theo - eng.avgPx[sel]) * pos * MULT : 0)
  const fills = eng.fills.filter(f => f.ck === sel && (sample === null || f.t <= sample.t))
  const last = fills[fills.length - 1]
  const quoted = live && q.bidState === 'active' && q.bidSize > 0
  const insideBoth = quoted && q.bid >= mktBid - 1e-9 && q.ask <= mktAsk + 1e-9

  const dl = view ? view.delta : eng.delta[sel]
  const gm = view ? view.gamma : eng.gamma[sel]
  const vg = view ? view.vega : eng.vega[sel]
  const th = view ? view.theta : eng.theta[sel] / 365
  const greeks: [string, number, number, boolean][] = [
    ['delta', dl, pos * dl * MULT, false],
    ['gamma', gm, pos * gm * MULT, false],
    ['vega', vg, pos * vg, false],
    ['theta', th, pos * th * MULT, true],
    ['vanna', eng.vanna[sel], pos * eng.vanna[sel] * MULT / 100, false],
    ['rho', eng.rho[sel], pos * eng.rho[sel] * MULT, false],
  ]

  return (
    <div style={{ padding: '10px 12px', height: '100%', overflow: 'hidden', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
        <span style={{ ...MONO, fontSize: 15, fontWeight: 700, color: T.gold }}>
          {DTE_LABELS[c.expIdx]} {c.strike} {c.kind === 'C' ? 'CALL' : 'PUT'}
        </span>
        <span style={{ ...MONO, fontSize: 11, color: pos > 0 ? GOOD : pos < 0 ? BAD : T.muted }}>
          {pos === 0 ? 'flat' : `${pos > 0 ? 'long' : 'short'} ${Math.abs(pos)} at ${eng.avgPx[sel].toFixed(2)} average`}
        </span>
        <span style={{ ...MONO, fontSize: 10, color: T.muted, marginLeft: 'auto' }}>
          click any strike in the chain to inspect it
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', minHeight: 0 }}>
        <Col title="Model and market">
          <Row k="theoretical" v={expired ? '—' : theo.toFixed(2)} tone={T.gold} bold />
          <Row k="implied vol" v={expired ? '—' : `${(iv * 100).toFixed(1)}%`} />
          <Row k="market" v={expired ? '—' : `${mktBid.toFixed(2)} – ${mktAsk.toFixed(2)}`} />
          <Row k="your quote" v={quoted ? `${q.bid.toFixed(2)} – ${q.ask.toFixed(2)}` : 'not quoted'}
            tone={quoted ? T.blue : undefined} bold={quoted} />
          <Row k="edge each side" v={quoted ? `$${q.edge.toFixed(2)}` : '—'} />
          <Row k="size resting" v={quoted ? `${q.bidSize} bid, ${q.askSize} ask` : '—'} />
          {quoted && (
            <p style={{ ...MONO, fontSize: 10, color: insideBoth ? T.blue : T.muted, margin: '5px 0 0', lineHeight: 1.4 }}>
              {insideBoth ? 'You are inside the market on both sides.' : 'One side is resting outside the market.'}
            </p>
          )}
        </Col>

        <Col title="Your position" divide>
          <Row k="position" v={String(pos)} tone={pos > 0 ? GOOD : pos < 0 ? BAD : undefined} bold={!!pos} />
          <Row k="average price" v={pos ? eng.avgPx[sel].toFixed(2) : '—'} />
          <Row k="contract P&L" v={live ? fmtK(pnl) : '—'} tone={live ? pnlColor(pnl) : undefined} bold />
          <Row k="contracts traded" v={String(eng.fillCount[sel])} />
          <Row k="fills here" v={String(fills.length)} />
          <Row k="last fill" v={last ? `${last.ourSide === 'BUY' ? 'bought' : 'sold'} ${last.size} at ${last.px.toFixed(2)}` : 'none'} />
        </Col>

        <Col title="Greeks" divide caption="each / book">
          {greeks.map(([name, per, tot, flip]) => (
            <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ ...MONO, fontSize: 11, color: T.muted }}>{name}</span>
              <span style={{ ...MONO, fontSize: 11, color: alpha(T.text, 62), width: 48, textAlign: 'right' }}>
                {expired ? '—' : fmtSmall(per)}
              </span>
              <span style={{
                ...MONO, fontSize: 11, fontWeight: 600, width: 50, textAlign: 'right',
                color: tot === 0 ? alpha(T.muted, 55) : flip ? pnlColor(tot) : T.text,
              }}>{tot ? fmtK(tot) : '0'}</span>
            </div>
          ))}
        </Col>

        <Col title="Depth" divide caption="you versus the street" grow={1.35}>
          <DepthLadder eng={eng} sel={sel} live={live} />
        </Col>
      </div>
    </div>
  )
}

function Col({ title, grow = 1, divide, caption, children }: {
  title: string; grow?: number; divide?: boolean
  caption?: string; children: React.ReactNode
}) {
  return (
    <div style={{
      flex: `${grow} 1 0`, minWidth: 0,
      borderLeft: divide ? `1px solid ${T.borderFaint}` : undefined,
      paddingLeft: divide ? 16 : undefined,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        <span style={{ ...LABEL, fontSize: 9, color: alpha(T.gold, 75) }}>{title}</span>
        {caption && <span style={{ ...MONO, fontSize: 9.5, color: T.muted }}>{caption}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </div>
  )
}

function Row({ k, v, tone, bold }: { k: string; v: string; tone?: string; bold?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ ...MONO, fontSize: 11, color: T.muted }}>{k}</span>
      <span style={{ ...MONO, fontSize: 11, color: tone ?? T.text, fontWeight: bold ? 700 : 400 }}>{v}</span>
    </div>
  )
}

/**
 * Depth around the touch, with your own resting size in its own column.
 *
 * The handoff put your size in the same cell as the street's. In practice that
 * was unreadable — a second number in a cell gives no clue whose it is — so the
 * two get separate, labelled columns.
 *
 * Slicing the top eight prices also hid your bids: the rows come back sorted
 * high to low, so eight rows is the whole ask side and nothing else. The ladder
 * is now built outwards from the touch instead.
 */
function DepthLadder({ eng, sel, live }: { eng: Mm2Engine; sel: number; live: boolean }) {
  if (!live) return <Empty>Depth is not recorded historically.</Empty>
  const all = eng.depth(sel)
  if (!all.length) return <Empty>This contract has expired.</Empty>

  const mktBid = eng.mktBid[sel]
  const mktAsk = eng.mktAsk[sel]
  const asks = all.filter(r => r.px >= mktAsk - 1e-9)
  const bids = all.filter(r => r.px <= mktBid + 1e-9)
  const inside = all.filter(r => r.px < mktAsk - 1e-9 && r.px > mktBid + 1e-9)
  // Nearest the touch on both sides, plus every level where we are resting.
  const rows = [...asks.slice(-3), ...inside, ...bids.slice(0, 3)]

  const mineOf = (r: typeof all[number], side: 'B' | 'A') =>
    r.ours.filter(o => o.side === side).reduce((a, o) => a + o.remaining, 0)
  const resting = rows.reduce((n, r) => n + mineOf(r, 'B') + mineOf(r, 'A'), 0)

  const head: React.CSSProperties = {
    ...LABEL, fontSize: 8.5, letterSpacing: '0.14em', padding: '1px 6px', whiteSpace: 'nowrap',
  }
  const cell: React.CSSProperties = { ...MONO, fontSize: 11, padding: '0 6px', lineHeight: '15px', whiteSpace: 'nowrap' }

  return (
    <>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...head, textAlign: 'right', color: T.blue }}>You</th>
            <th style={{ ...head, textAlign: 'right' }}>Bid</th>
            <th style={{ ...head, textAlign: 'center' }}>Price</th>
            <th style={{ ...head, textAlign: 'left' }}>Ask</th>
            <th style={{ ...head, textAlign: 'left', color: T.violet }}>You</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const mineBid = mineOf(r, 'B')
            const mineAsk = mineOf(r, 'A')
            const mine = mineBid || mineAsk
            const touch = Math.abs(r.px - mktBid) < 1e-9 || Math.abs(r.px - mktAsk) < 1e-9
            const hue = mineBid ? T.blue : mineAsk ? T.violet : null
            return (
              <tr key={r.px.toFixed(2)} style={{
                background: hue ? alpha(hue, 12) : touch ? alpha(T.text, 5) : undefined,
                borderLeft: `2px solid ${hue ?? 'transparent'}`,
              }}>
                <td style={{ ...cell, textAlign: 'right', color: T.blue, fontWeight: 700 }}>{mineBid || ''}</td>
                <td style={{ ...cell, textAlign: 'right', color: alpha(GOOD, 78) }}>{r.bidSize || ''}</td>
                <td style={{ ...cell, textAlign: 'center', color: T.text, fontWeight: touch || mine ? 700 : 400 }}>{r.px.toFixed(2)}</td>
                <td style={{ ...cell, textAlign: 'left', color: alpha(BAD, 78) }}>{r.askSize || ''}</td>
                <td style={{ ...cell, textAlign: 'left', color: T.violet, fontWeight: 700 }}>{mineAsk || ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p style={{ ...MONO, fontSize: 9.5, color: T.muted, margin: '4px 0 0' }}>
        {resting > 0
          ? `${resting} of yours resting here.`
          : 'Nothing of yours resting in this contract.'}
      </p>
    </>
  )
}

function fmtSmall(v: number): string {
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a < 0.001) return v.toExponential(1)
  if (a < 1) return v.toFixed(4)
  return v.toFixed(2)
}
