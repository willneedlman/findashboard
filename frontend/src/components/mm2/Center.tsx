/*
 * Options MM 2 — the underlying strip and the workbench bodies.
 *
 * These render without panel chrome; the workbench supplies the tabs and the
 * frame. Keeping them bare is what lets one pane host the book, the surface and
 * the quote explanation instead of three competing for the same width.
 */

import { useState } from 'react'
import { T, alpha } from '../../lib/theme'
import { Canvas, useTokens, hexAlpha, MONO, LABEL, Seg, Empty, GOOD, BAD, WARN, pnlColor } from './ui'
import { fmtK } from './Chain'
import { DTES, DTE_LABELS, MULT, fmtClock, type LegView, type Mm2Engine, type Order, type Sample } from '../../lib/mm2/engine'

// ── Underlying strip ──────────────────────────────────────────────────────────

export function UnderlyingStrip({ eng, tick, reviewT, onScrub }: {
  eng: Mm2Engine; tick: number; reviewT: number | null; onScrub: (t: number | null) => void
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

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
      background: T.bg, border: `1px solid ${T.border}`, padding: '0 10px', height: 52,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, flexShrink: 0 }}>
        <span style={{ ...MONO, fontSize: 19, fontWeight: 700, color: T.gold }}>{eng.spot.toFixed(2)}</span>
        <span style={{ ...MONO, fontSize: 11, color: pnlColor(chg) }}>{chg >= 0 ? '+' : ''}{chg.toFixed(2)}</span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexShrink: 0, ...MONO, fontSize: 10 }}>
        <Pair k="bid" v={(eng.spot - half).toFixed(2)} />
        <Pair k="ask" v={(eng.spot + half).toFixed(2)} />
        <Pair k="realized" v={`${(rv * 100).toFixed(1)}%`} />
        <Pair k="implied" v={`${(eng.atmIv(2) * 100).toFixed(1)}%`} />
      </div>
      <div style={{ flex: 1, minWidth: 60 }}>
        <Canvas height={44} onPick={xf => {
          if (s.length < 2) return
          onScrub(s[0].t + xf * (s[s.length - 1].t - s[0].t))
        }} draw={(ctx, w, h) => {
          if (!tok.gold || s.length < 2) return
          const t0 = s[0].t, t1 = s[s.length - 1].t, span = Math.max(t1 - t0, 1)
          let lo = Infinity, hi = -Infinity
          for (const p of s) { lo = Math.min(lo, p.spot); hi = Math.max(hi, p.spot) }
          const pad = Math.max((hi - lo) * 0.15, 0.4)
          lo -= pad; hi += pad
          const X = (t: number) => ((t - t0) / span) * w
          const Y = (v: number) => h - 4 - ((v - lo) / Math.max(hi - lo, 1e-9)) * (h - 8)

          for (const m of eng.markers) {
            const x = X(m.t)
            if (x < 0 || x > w) continue
            const c = m.kind === 'hedge' ? tok.blue : m.kind === 'shock' ? tok.warn : m.kind === 'kill' ? tok.neg : tok.muted
            ctx.strokeStyle = hexAlpha(c, m.kind === 'hedge' ? 0.3 : 0.55)
            ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, h - 2); ctx.stroke()
          }
          ctx.beginPath()
          s.forEach((p, i) => { const x = X(p.t), y = Y(p.spot); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
          ctx.strokeStyle = tok.gold
          ctx.lineWidth = 1.3
          ctx.stroke()
          if (reviewT !== null) {
            const x = X(reviewT)
            ctx.strokeStyle = tok.text
            ctx.setLineDash([3, 3])
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke()
            ctx.setLineDash([])
          }
        }} />
      </div>
      <span style={{ ...MONO, fontSize: 9, color: alpha(T.muted, 65), flexShrink: 0 }}>click to rewind</span>
    </div>
  )
}

function Pair({ k, v }: { k: string; v: string }) {
  return <span style={{ color: T.muted }}>{k} <span style={{ color: T.text }}>{v}</span></span>
}

// ── Order book ────────────────────────────────────────────────────────────────

export function BookBody({ eng, sel, live }: { eng: Mm2Engine; sel: number; live: boolean }) {
  const [pick, setPick] = useState<number | null>(null)
  const rows = live ? eng.depth(sel) : []
  const order = pick !== null ? eng.orders.get(pick) : undefined

  if (!live) return <Empty>Depth is not recorded historically. Return to live to inspect the book.</Empty>
  if (!rows.length) return <Empty>This contract has expired.</Empty>

  return (
    <div style={{ display: 'flex', minHeight: 0, height: '100%' }}>
      <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Bid', 'Ours', 'Price', 'Ours', 'Ask', 'Queue', 'Fill'].map(h => (
                <th key={h} style={{ ...LABEL, fontSize: 8, padding: '3px 6px', textAlign: 'right', position: 'sticky', top: 0, background: T.surface, borderBottom: `1px solid ${T.border}` }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const ourBid = r.ours.filter(o => o.side === 'B').reduce((a, o) => a + o.remaining, 0)
              const ourAsk = r.ours.filter(o => o.side === 'A').reduce((a, o) => a + o.remaining, 0)
              const mine = r.ours[0]
              const queueAhead = mine ? mine.queueAhead : 0
              const fillProb = mine ? Math.max(0, Math.min(1, 1 - queueAhead / Math.max(20, mine.size * 4))) : 0
              const isTouch = Math.abs(r.px - eng.mktBid[sel]) < 1e-9 || Math.abs(r.px - eng.mktAsk[sel]) < 1e-9
              return (
                <tr key={r.px.toFixed(2)} onClick={() => mine && setPick(mine.id)} style={{
                  borderTop: `1px solid ${T.borderFaint}`, cursor: mine ? 'pointer' : undefined,
                  background: mine ? alpha(mine.side === 'B' ? T.blue : '#a78bfa', 12) : isTouch ? alpha(T.text, 5) : undefined,
                }}>
                  <td style={cell(alpha(GOOD, 75))}>{r.bidSize || ''}</td>
                  <td style={cell(T.blue, 700)}>{ourBid || ''}</td>
                  <td style={{ ...cell(isTouch ? T.text : alpha(T.text, 68), isTouch ? 700 : 400), textAlign: 'center' }}>{r.px.toFixed(2)}</td>
                  <td style={cell('#a78bfa', 700)}>{ourAsk || ''}</td>
                  <td style={cell(alpha(BAD, 75))}>{r.askSize || ''}</td>
                  <td style={cell(T.muted)}>{mine ? queueAhead : ''}</td>
                  <td style={cell(mine ? (fillProb > 0.6 ? GOOD : WARN) : T.muted)}>{mine ? `${(fillProb * 100).toFixed(0)}%` : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div style={{ width: 240, flexShrink: 0, borderLeft: `1px solid ${T.borderFaint}`, overflow: 'auto' }}>
        {order
          ? <OrderDetail eng={eng} o={order} onClose={() => setPick(null)} />
          : <Empty>Click one of your resting orders to see why it has or has not filled.</Empty>}
      </div>
    </div>
  )
}

const cell = (color: string, weight = 400) => ({
  ...MONO, fontSize: 10.5, padding: '2px 6px', textAlign: 'right' as const, color, fontWeight: weight,
})

function OrderDetail({ eng, o, onClose }: { eng: Mm2Engine; o: Order; onClose: () => void }) {
  const fairNow = eng.modelFair(o.ck).fair
  const edgeNow = o.side === 'B' ? fairNow - o.px : o.px - fairNow
  const lines: [string, string][] = [
    ['order', `#${o.id} ${o.side === 'B' ? 'BID' : 'ASK'} ${o.remaining}/${o.size} @ ${o.px.toFixed(2)}`],
    ['state', o.state],
    ['submitted', fmtClock(o.tCreate).slice(0, 12)],
    ['acknowledged', o.tAck ? `+${o.tAck - o.tCreate} ms` : 'in flight'],
    ['fair at submit', o.fairAtSubmit.toFixed(2)],
    ['fair now', fairNow.toFixed(2)],
    ['edge at submit', `$${o.edgeAtSubmit.toFixed(3)}`],
    ['edge now', `$${edgeNow.toFixed(3)}`],
    ['queue at submit', String(o.queueAtSubmit)],
    ['queue now', String(o.queueAhead)],
    ['age', `${eng.clock - o.tCreate} ms`],
  ]
  if (o.cancelReason) lines.push(['cancel reason', o.cancelReason])
  return (
    <div style={{ padding: '5px 7px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ ...LABEL, fontSize: 8.5, color: T.gold }}>Order inspector</span>
        <button onClick={onClose} style={{ ...MONO, fontSize: 9, background: 'none', border: 'none', color: T.muted, cursor: 'pointer' }}>close</button>
      </div>
      {lines.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ ...MONO, fontSize: 9.5, color: T.muted }}>{k}</span>
          <span style={{ ...MONO, fontSize: 9.5, color: T.text }}>{v}</span>
        </div>
      ))}
      <p style={{ ...MONO, fontSize: 9.5, color: edgeNow < 0 ? BAD : T.muted, margin: '5px 0 0', lineHeight: 1.45 }}>
        {edgeNow < 0
          ? 'Fair value has moved through this order. Filling here now books a loss against fair.'
          : o.queueAhead > 0
            ? `${o.queueAhead} contracts must trade ahead of you at this price before you fill.`
            : 'You are at the front of the queue at this price.'}
      </p>
    </div>
  )
}

// ── Volatility surface ────────────────────────────────────────────────────────

type SurfMetric = 'iv' | 'edge' | 'pos' | 'vega' | 'gamma' | 'pnl'

export function SurfaceBody({ eng, sel, onSel }: { eng: Mm2Engine; sel: number; onSel: (ck: number) => void }) {
  const tok = useTokens()
  const [metric, setMetric] = useState<SurfMetric>('iv')
  const [kind, setKind] = useState<'C' | 'P'>('C')
  const strikes = eng.strikes
  const term = eng.termMetrics(Math.min(5, DTES.length - 1))

  const valueOf = (e: number, kIdx: number): number | null => {
    const i = eng.idxOf(e, strikes[kIdx], kind)
    if (i < 0 || eng.expired[i]) return null
    switch (metric) {
      case 'iv': return eng.trueIv[i] * 100
      case 'edge': return eng.quotes[i].edge
      case 'pos': return eng.pos[i]
      case 'vega': return eng.pos[i] * eng.vega[i]
      case 'gamma': return eng.pos[i] * eng.gamma[i] * MULT
      case 'pnl': return eng.contractPnl[i] + (eng.pos[i] ? (eng.theo[i] - eng.avgPx[i]) * eng.pos[i] * MULT : 0)
    }
  }
  const diverging = metric !== 'iv' && metric !== 'edge'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
      <div style={{ display: 'flex', gap: 5, padding: '4px 7px', borderBottom: `1px solid ${T.borderFaint}`, flexShrink: 0 }}>
        <Seg options={[{ label: 'CALLS', value: 'C' }, { label: 'PUTS', value: 'P' }]} value={kind} onChange={v => setKind(v as 'C' | 'P')} size={9} />
        <Seg<SurfMetric> options={[
          { label: 'IV', value: 'iv' }, { label: 'EDGE', value: 'edge' }, { label: 'POS', value: 'pos' },
          { label: 'VEGA', value: 'vega' }, { label: 'GAMMA', value: 'gamma' }, { label: 'P&L', value: 'pnl' },
        ]} value={metric} onChange={setMetric} size={9} />
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: '4px 7px' }}>
        <Canvas height={148} onPick={(xf, yf) => {
          const kIdx = Math.min(strikes.length - 1, Math.floor(xf * strikes.length))
          const e = Math.min(DTES.length - 1, Math.floor(yf * DTES.length))
          const i = eng.idxOf(e, strikes[kIdx], kind)
          if (i >= 0) onSel(i)
        }} draw={(ctx, w, h) => {
          if (!tok.gold) return
          const cw = w / strikes.length, ch = h / DTES.length
          let lo = Infinity, hi = -Infinity
          const grid = DTES.map((_, e) => strikes.map((_, k) => {
            const v = valueOf(e, k)
            if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v) }
            return v
          }))
          if (!Number.isFinite(lo)) { lo = 0; hi = 1 }
          const mag = Math.max(Math.abs(lo), Math.abs(hi), 1e-9)
          const span = Math.max(hi - lo, 1e-9)

          grid.forEach((row, e) => row.forEach((v, k) => {
            const x = k * cw, y = e * ch
            if (v === null) { ctx.fillStyle = hexAlpha(tok.muted, 0.06) }
            else if (diverging) {
              const f = v / mag
              ctx.fillStyle = f === 0 ? hexAlpha(tok.muted, 0.07) : hexAlpha(f > 0 ? tok.pos : tok.neg, Math.min(0.75, 0.1 + 0.65 * Math.abs(f)))
            } else {
              const f = (v - lo) / span
              ctx.fillStyle = `rgba(${Math.round(60 + 165 * f)}, ${Math.round(120 - 40 * f)}, ${Math.round(190 - 130 * f)}, ${0.24 + 0.62 * f})`
            }
            ctx.fillRect(x, y, cw + 0.5, ch + 0.5)
          }))

          const selC = eng.contracts[sel]
          if (selC && selC.kind === kind) {
            const kIdx = strikes.indexOf(selC.strike)
            if (kIdx >= 0) {
              ctx.strokeStyle = tok.gold
              ctx.lineWidth = 1.5
              ctx.strokeRect(kIdx * cw + 0.75, selC.expIdx * ch + 0.75, cw - 1.5, ch - 1.5)
            }
          }
          ctx.font = '9px ui-monospace, monospace'
          ctx.fillStyle = hexAlpha(tok.text, 0.82)
          DTES.forEach((_, e) => ctx.fillText(DTE_LABELS[e], 3, e * ch + ch / 2 + 3))
          const atmX = ((strikes.findIndex(k => k >= eng.spot) + 0.5) / strikes.length) * w
          ctx.strokeStyle = hexAlpha(tok.text, 0.55)
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.moveTo(atmX, 0); ctx.lineTo(atmX, h); ctx.stroke()
        }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', ...MONO, fontSize: 9, color: T.muted, paddingTop: 2 }}>
          <span>{strikes[0]}</span><span>click a cell to select it</span><span>{strikes[strikes.length - 1]}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, padding: '4px 8px', borderTop: `1px solid ${T.borderFaint}`, flexShrink: 0, ...MONO, fontSize: 10, flexWrap: 'wrap' }}>
        <Pair k="ATM 30d" v={`${(term.atm * 100).toFixed(2)}%`} />
        <Pair k="25d put" v={`${(term.put25 * 100).toFixed(2)}%`} />
        <Pair k="25d call" v={`${(term.call25 * 100).toFixed(2)}%`} />
        <span style={{ color: T.muted }}>risk rev <span style={{ color: term.rr < 0 ? BAD : GOOD }}>{(term.rr * 100).toFixed(2)}</span></span>
        <Pair k="butterfly" v={(term.fly * 100).toFixed(2)} />
        <span style={{ color: T.muted }}>since open <span style={{ color: pnlColor(eng.atmIv(2) - eng.cfg.atmVol) }}>{((eng.atmIv(2) - eng.cfg.atmVol) * 100).toFixed(2)} pts</span></span>
      </div>
    </div>
  )
}

// ── Contract detail and quote explanation ─────────────────────────────────────

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
  const t = view && sample
    ? Math.max(c.expT - sample.t / (365 * 24 * 3600 * 1000), 1 / (365 * 24 * 60))
    : eng.timeToExpiry(c)
  const fills = eng.fills.filter(f => f.ck === sel && (sample === null || f.t <= sample.t)).slice(-5).reverse()
  const expired = view ? view.expired : !!eng.expired[sel]
  const pnl = eng.contractPnl[sel] + (pos ? (theo - eng.avgPx[sel]) * pos * MULT : 0)

  const dl = view ? view.delta : eng.delta[sel]
  const gm = view ? view.gamma : eng.gamma[sel]
  const vg = view ? view.vega : eng.vega[sel]
  const th = view ? view.theta : eng.theta[sel] / 365
  const greeks: [string, number, number][] = [
    ['delta', dl, pos * dl * MULT],
    ['gamma', gm, pos * gm * MULT],
    ['vega', vg, pos * vg],
    ['theta', th, pos * th * MULT],
    ['vanna', eng.vanna[sel], pos * eng.vanna[sel] * MULT / 100],
    ['volga', eng.volga[sel] / 100, pos * eng.volga[sel] / 100],
  ]

  return (
    <div style={{ display: 'flex', minHeight: 0, height: '100%', overflow: 'auto' }}>
      <div style={{ flex: '0 0 44%', minWidth: 0, borderRight: `1px solid ${T.borderFaint}`, padding: '5px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
          <span style={{ ...MONO, fontSize: 13, fontWeight: 700, color: T.gold }}>
            {DTE_LABELS[c.expIdx]} {c.strike} {c.kind === 'C' ? 'CALL' : 'PUT'}
          </span>
          <span style={{ ...MONO, fontSize: 10, color: T.muted }}>{expired ? 'expired' : `${(t * 365).toFixed(3)}d left`}</span>
        </div>
        <Line k="theoretical" v={expired ? '—' : theo.toFixed(2)} tone={T.gold} />
        <Line k="market" v={expired ? '—' : `${mktBid.toFixed(2)} / ${mktAsk.toFixed(2)}`} />
        <Line k="implied vol" v={expired ? '—' : `${(iv * 100).toFixed(2)}%`} />
        <Line k="position" v={String(pos)} tone={pos > 0 ? GOOD : pos < 0 ? BAD : undefined} />
        <Line k="average price" v={pos ? eng.avgPx[sel].toFixed(2) : '—'} />
        <Line k="contract P&L" v={live ? fmtK(pnl) : '—'} tone={live ? pnlColor(pnl) : undefined} />
        <Line k="contracts traded" v={String(eng.fillCount[sel])} />

        <div style={{ marginTop: 6, borderTop: `1px solid ${T.borderFaint}`, paddingTop: 4 }}>
          <span style={{ ...LABEL, fontSize: 8 }}>Greeks: per contract / position</span>
          {greeks.map(([name, per, tot]) => (
            <div key={name} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ ...MONO, fontSize: 10, color: T.muted }}>{name}</span>
              <span style={{ ...MONO, fontSize: 10, color: alpha(T.text, 72) }}>{expired ? '—' : fmtSmall(per)}</span>
              <span style={{ ...MONO, fontSize: 10, color: tot ? T.text : alpha(T.muted, 55), width: 62, textAlign: 'right', fontWeight: tot ? 600 : 400 }}>
                {tot ? fmtK(tot) : '0'}
              </span>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 6, borderTop: `1px solid ${T.borderFaint}`, paddingTop: 4 }}>
          <span style={{ ...LABEL, fontSize: 8 }}>Recent fills here</span>
          {fills.length === 0
            ? <p style={{ ...MONO, fontSize: 10, color: T.muted, margin: '3px 0' }}>No fills yet.</p>
            : fills.map(f => (
              <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, ...MONO, fontSize: 10 }}>
                <span style={{ color: f.ourSide === 'BUY' ? GOOD : BAD }}>{f.ourSide} {f.size}</span>
                <span style={{ color: T.text }}>{f.px.toFixed(2)}</span>
                <span style={{ color: pnlColor(f.edge) }}>{fmtK(f.edge)}</span>
                <span style={{ color: f.p30 === null ? T.muted : pnlColor(f.p30) }}>{f.p30 === null ? '···' : fmtK(f.p30)}</span>
                <span style={{ color: T.muted }}>{f.who}</span>
              </div>
            ))}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, padding: '5px 8px' }}>
        {!live ? <Empty>Resting quotes are not recorded historically.</Empty> : (
          <>
            <div style={{ display: 'flex', gap: 12 }}>
              <QuoteMath title="Bid" b={q.bidBreak} state={q.bidState} />
              <QuoteMath title="Ask" b={q.askBreak} state={q.askState} />
            </div>
            <div style={{ marginTop: 6, borderTop: `1px solid ${T.borderFaint}`, paddingTop: 4 }}>
              <span style={{ ...LABEL, fontSize: 8 }}>Ask size</span>
              <MathRow label="default size" value={String(q.askSizeBreak.base)} />
              <MathRow label="inventory relief" value={q.askSizeBreak.relief ? `+${q.askSizeBreak.relief}` : '0'} dim={!q.askSizeBreak.relief} />
              <MathRow label="limit reduction" value={String(q.askSizeBreak.limit)} dim={!q.askSizeBreak.limit} />
              <MathRow label="model confidence" value={`x${q.askSizeBreak.confidence.toFixed(2)}`} dim={q.askSizeBreak.confidence === 1} />
              <MathRow label="final ask size" value={String(q.askSizeBreak.final)} bold />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function Line({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ ...MONO, fontSize: 10, color: T.muted }}>{k}</span>
      <span style={{ ...MONO, fontSize: 10.5, color: tone ?? T.text, fontWeight: tone ? 700 : 400 }}>{v}</span>
    </div>
  )
}

function QuoteMath({ title, b, state }: {
  title: string
  b: { fair: number; base: number; inventory: number; toxicity: number; latency: number; gamma: number; vega: number; moneyness: number; dte: number; final: number }
  state: string
}) {
  const terms: [string, number][] = [
    ['base edge', b.base], ['inventory skew', b.inventory], ['from the money', b.moneyness],
    ['expiration', b.dte], ['gamma', b.gamma], ['vega', b.vega], ['toxicity', b.toxicity], ['latency', b.latency],
  ]
  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 5 }}>
        <span style={{ ...LABEL, fontSize: 8 }}>{title}</span>
        {state !== 'active' && <span style={{ ...MONO, fontSize: 8.5, color: state === 'riskBlocked' ? BAD : WARN }}>{stateLabel(state)}</span>}
      </div>
      <MathRow label="model fair value" value={b.fair.toFixed(2)} />
      {terms.map(([k, v]) => <MathRow key={k} label={k} value={v === 0 ? '0.000' : `${v > 0 ? '+' : ''}${v.toFixed(3)}`} dim={v === 0} />)}
      <MathRow label={`final ${title.toLowerCase()}`} value={b.final.toFixed(2)} bold />
    </div>
  )
}

function stateLabel(s: string): string {
  return s === 'riskBlocked' ? 'risk blocked'
    : s === 'capped' ? 'position cap'
      : s === 'modelBlocked' ? 'no model value'
        : s === 'off' ? 'quoting off' : s
}

function MathRow({ label, value, bold, dim }: { label: string; value: string; bold?: boolean; dim?: boolean }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 8,
      borderTop: bold ? `1px solid ${T.border}` : undefined, marginTop: bold ? 2 : 0, paddingTop: bold ? 2 : 0,
    }}>
      <span style={{ ...MONO, fontSize: 10, color: dim ? alpha(T.muted, 45) : T.muted }}>{label}</span>
      <span style={{ ...MONO, fontSize: 10, color: dim ? alpha(T.muted, 45) : bold ? T.gold : T.text, fontWeight: bold ? 700 : 400 }}>{value}</span>
    </div>
  )
}

function fmtSmall(v: number): string {
  const a = Math.abs(v)
  if (a === 0) return '0'
  if (a < 0.001) return v.toExponential(1)
  if (a < 1) return v.toFixed(4)
  return v.toFixed(2)
}
