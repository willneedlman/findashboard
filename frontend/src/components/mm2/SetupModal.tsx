/*
 * Options MM 2 — session setup.
 *
 * Everything you configure once and then leave alone lives here rather than on
 * the trading screen: the market process, the surface, the flow mix, venue
 * mechanics, the full edge model and the risk limits. The rail keeps only the
 * handful of dials you actually turn mid-session.
 */

import { useState } from 'react'
import { T, alpha } from '../../lib/theme'
import { Overlay, Tabs, Field, Num, Seg, Canvas, useTokens, hexAlpha, MONO, LABEL } from './ui'
import { surfaceIv } from '../../lib/mm2/pricing'
import { DTES, DTE_LABELS, type Config, type Mm2Engine, type EdgeMode, type SpotProcess } from '../../lib/mm2/engine'

type Tab = 'market' | 'surface' | 'flow' | 'venue' | 'edge' | 'limits'

const TABS: { key: Tab; label: string }[] = [
  { key: 'market', label: 'Market' },
  { key: 'surface', label: 'Surface' },
  { key: 'flow', label: 'Order flow' },
  { key: 'venue', label: 'Venue' },
  { key: 'edge', label: 'Edge model' },
  { key: 'limits', label: 'Risk limits' },
]

export default function SetupModal({ eng, cfg, set, sel, onClose, initial = 'market' }: {
  eng: Mm2Engine; cfg: Config; set: (p: Partial<Config>) => void
  sel: number; onClose: () => void; initial?: Tab
}) {
  const [tab, setTab] = useState<Tab>(initial)
  const tok = useTokens()
  const q = eng.quotes[sel]
  const applied = (v: number) => (v === 0 ? '' : `${v > 0 ? '+' : ''}${v.toFixed(3)}`)
  const rtt = cfg.dataLatencyMs + cfg.decisionLatencyMs + cfg.sendLatencyMs + cfg.ackLatencyMs
  const volLift = 1 + cfg.volSens * (eng.instVol / Math.max(cfg.atmVol, 1e-6) - 1)
  const expected = cfg.arrivalRate * Math.min(3, Math.max(0.3, volLift))

  return (
    <Overlay title="Session setup" onClose={onClose} width={900}>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />

      {tab === 'market' && (
        <Cols note="Applies live, except the opening spot which takes effect on reset.">
          <Col title="Underlying process">
            <Field label="process">
              <Seg<SpotProcess> options={[
                { label: 'GBM', value: 'gbm', hint: 'Constant volatility' },
                { label: 'STOCH VOL', value: 'stochvol', hint: 'Mean-reverting vol, correlated with spot' },
                { label: 'JUMP', value: 'jump', hint: 'Stochastic vol plus jumps' },
              ]} value={cfg.process} onChange={v => set({ process: v })} size={9} />
            </Field>
            <Field label="opening spot"><Num value={cfg.spot0} onChange={v => set({ spot0: v })} step={10} min={10} /></Field>
            <Field label="drift %/yr"><Num value={cfg.drift * 100} onChange={v => set({ drift: v / 100 })} step={1} dp={1} /></Field>
            <Field label="realized vol %"><Num value={cfg.realizedVol * 100} onChange={v => set({ realizedVol: v / 100 })} step={1} dp={1} /></Field>
            <Field label="underlying spread bps"><Num value={cfg.underlyingSpreadBps} onChange={v => set({ underlyingSpreadBps: v })} step={0.1} dp={1} min={0} /></Field>
          </Col>
          <Col title="Volatility dynamics">
            <Field label="vol reversion"><Num value={cfg.volReversion} onChange={v => set({ volReversion: v })} step={0.5} dp={1} min={0} /></Field>
            <Field label="vol of vol"><Num value={cfg.volOfVol} onChange={v => set({ volOfVol: v })} step={0.1} dp={2} min={0} /></Field>
            <Field label="spot/vol correlation"><Num value={cfg.spotVolCorr} onChange={v => set({ spotVolCorr: v })} step={0.1} dp={2} min={-1} max={1} /></Field>
            <Field label="jumps per hour"><Num value={cfg.jumpPerHour} onChange={v => set({ jumpPerHour: v })} step={0.1} dp={2} min={0} /></Field>
            <Field label="jump size %"><Num value={cfg.jumpSize * 100} onChange={v => set({ jumpSize: v / 100 })} step={0.1} dp={2} min={0} /></Field>
          </Col>
          <Col title="Path preview">
            <PathPreview cfg={cfg} tok={tok} />
            <Field label="risk free %"><Num value={cfg.rate * 100} onChange={v => set({ rate: v / 100 })} step={0.1} dp={2} /></Field>
            <Field label="dividend yield %"><Num value={cfg.divYield * 100} onChange={v => set({ divYield: v / 100 })} step={0.1} dp={2} /></Field>
          </Col>
        </Cols>
      )}

      {tab === 'surface' && (
        <Cols note="The surface both the market generator and your pricer quote against.">
          <Col title="Shape">
            <Field label="ATM vol %"><Num value={cfg.atmVol * 100} onChange={v => set({ atmVol: v / 100 })} step={0.5} dp={1} min={2} /></Field>
            <Field label="put skew"><Num value={cfg.putSkew} onChange={v => set({ putSkew: v })} step={0.05} dp={2} /></Field>
            <Field label="call skew"><Num value={cfg.callSkew} onChange={v => set({ callSkew: v })} step={0.05} dp={2} /></Field>
            <Field label="term slope"><Num value={cfg.termSlope} onChange={v => set({ termSlope: v })} step={0.01} dp={2} /></Field>
            <Field label="smile curvature"><Num value={cfg.curvature} onChange={v => set({ curvature: v })} step={0.05} dp={2} /></Field>
            <Field label="event premium %"><Num value={cfg.eventPremium * 100} onChange={v => set({ eventPremium: v / 100 })} step={0.5} dp={1} min={0} /></Field>
            <Field label="surface noise %" hint="Applies on reset"><Num value={cfg.surfaceNoise * 100} onChange={v => set({ surfaceNoise: v / 100 })} step={0.1} dp={2} min={0} /></Field>
          </Col>
          <Col title="Preview" span={2}>
            <SurfacePreview eng={eng} cfg={cfg} tok={tok} />
          </Col>
        </Cols>
      )}

      {tab === 'flow' && (
        <Cols note={`${expected.toFixed(2)} orders per second expected at the current volatility.`}>
          <Col title="Arrivals">
            <Field label="arrival rate /s"><Num value={cfg.arrivalRate} onChange={v => set({ arrivalRate: v })} step={0.2} dp={2} min={0} /></Field>
            <Field label="average size"><Num value={cfg.avgSize} onChange={v => set({ avgSize: v })} step={1} min={1} /></Field>
            <Field label="buy bias" hint="0.50 is balanced"><Num value={cfg.buyBias} onChange={v => set({ buyBias: v })} step={0.05} dp={2} min={0} max={1} /></Field>
            <Field label="vol sensitivity"><Num value={cfg.volSens} onChange={v => set({ volSens: v })} step={0.1} dp={1} min={0} /></Field>
            <Field label="spread sensitivity" hint="How hard a wide quote loses the trade"><Num value={cfg.spreadSens} onChange={v => set({ spreadSens: v })} step={0.5} dp={1} min={0} /></Field>
          </Col>
          <Col title="Participant mix">
            <Field label="informed %" hint="Trade ahead of the move"><Num value={cfg.informedPct} onChange={v => set({ informedPct: v })} step={1} min={0} max={100} /></Field>
            <Field label="retail %"><Num value={cfg.retailPct} onChange={v => set({ retailPct: v })} step={1} min={0} max={100} /></Field>
            <Field label="institutional %"><Num value={cfg.instPct} onChange={v => set({ instPct: v })} step={1} min={0} max={100} /></Field>
            <Readout label="liquidity takers %" value={Math.max(0, 100 - cfg.informedPct - cfg.retailPct - cfg.instPct).toFixed(0)} />
          </Col>
          <Col title="Measured">
            <Readout label="toxicity index" value={eng.toxicity.toFixed(2)} tone={eng.toxicity > 1.4 ? T.warn : undefined} />
            <Readout label="fills to informed" value={String(eng.stat.informedFills)} />
            <Readout label="loss to informed" value={`$${Math.round(eng.stat.informedLoss).toLocaleString('en-US')}`} />
          </Col>
        </Cols>
      )}

      {tab === 'venue' && (
        <Cols note={`${rtt} ms round trip from a price change to a resting quote.`}>
          <Col title="Latency">
            <Field label="market data ms"><Num value={cfg.dataLatencyMs} onChange={v => set({ dataLatencyMs: v })} step={2} min={0} /></Field>
            <Field label="decision ms"><Num value={cfg.decisionLatencyMs} onChange={v => set({ decisionLatencyMs: v })} step={2} min={0} /></Field>
            <Field label="send ms"><Num value={cfg.sendLatencyMs} onChange={v => set({ sendLatencyMs: v })} step={2} min={0} /></Field>
            <Field label="ack ms"><Num value={cfg.ackLatencyMs} onChange={v => set({ ackLatencyMs: v })} step={2} min={0} /></Field>
            <Field label="cancel ms"><Num value={cfg.cancelLatencyMs} onChange={v => set({ cancelLatencyMs: v })} step={2} min={0} /></Field>
          </Col>
          <Col title="Fees and throttles">
            <Field label="maker rebate $/ct"><Num value={cfg.makerRebate} onChange={v => set({ makerRebate: v })} step={0.01} dp={2} min={0} /></Field>
            <Field label="taker fee $/ct"><Num value={cfg.takerFee} onChange={v => set({ takerFee: v })} step={0.05} dp={2} min={0} /></Field>
            <Field label="max messages /s"><Num value={cfg.maxMsgRate} onChange={v => set({ maxMsgRate: v })} step={50} min={1} /></Field>
          </Col>
          <Col title="Measured">
            <Readout label="messages last second" value={String(eng.msgWindow.length)} tone={eng.msgWindow.length >= cfg.maxMsgRate ? T.neg : undefined} />
            <Readout label="throttled requotes" value={eng.stat.throttled.toLocaleString('en-US')} />
            <Readout label="cancels" value={eng.stat.cancels.toLocaleString('en-US')} />
            <Readout label="rebates earned" value={`$${eng.rebates.toFixed(2)}`} />
          </Col>
        </Cols>
      )}

      {tab === 'edge' && (
        <Cols note="Applied amounts are the live dollar terms for the selected contract.">
          <Col title="Model">
            <Field label="pricer">
              <Seg options={[{ label: 'BLACK-SCHOLES', value: 'bs' }]} value="bs" onChange={() => {}} size={9} />
            </Field>
            <Field label="model error vol %" hint="Applies on reset"><Num value={cfg.modelErrorVol * 100} onChange={v => set({ modelErrorVol: v / 100 })} step={0.1} dp={2} min={0} /></Field>
            <Readout label="true IV, selected" value={`${(eng.trueIv[sel] * 100).toFixed(2)}%`} />
            <Readout label="your IV, selected" value={`${(q.modelIv * 100).toFixed(2)}%`}
              tone={Math.abs(q.modelIv - eng.trueIv[sel]) > 0.005 ? T.warn : undefined} />
            <Field label="edge units">
              <Seg<EdgeMode> options={[{ label: 'VOL', value: 'vol' }, { label: '$', value: 'dollar' }, { label: '%', value: 'pct' }]}
                value={cfg.edgeMode} onChange={v => set({ edgeMode: v })} size={9} />
            </Field>
            <Field label="min edge $"><Num value={cfg.minEdge} onChange={v => set({ minEdge: v })} step={0.05} dp={2} min={0} /></Field>
            <Field label="max edge $"><Num value={cfg.maxEdge} onChange={v => set({ maxEdge: v })} step={0.5} dp={2} min={0} /></Field>
          </Col>
          <Col title="Widen terms">
            <Adj label="distance from money" v={cfg.otmWiden} onChange={v => set({ otmWiden: v })} applied={applied(q.askBreak.moneyness)} />
            <Adj label="expiration" v={cfg.dteWiden} onChange={v => set({ dteWiden: v })} applied={applied(q.askBreak.dte)} />
            <Adj label="gamma" v={cfg.gammaWiden} onChange={v => set({ gammaWiden: v })} applied={applied(q.askBreak.gamma)} />
            <Adj label="vega" v={cfg.vegaWiden} onChange={v => set({ vegaWiden: v })} applied={applied(q.askBreak.vega)} />
            <Adj label="toxicity" v={cfg.toxicityWiden} onChange={v => set({ toxicityWiden: v })} applied={applied(q.askBreak.toxicity)} />
            <Adj label="latency" v={cfg.latencyWiden} onChange={v => set({ latencyWiden: v })} applied={applied(q.askBreak.latency)} />
            <Readout label="total half width" value={`$${q.edge.toFixed(3)}`} tone={T.gold} />
          </Col>
          <Col title="Skew, size and levels">
            <Adj label="inventory: delta" v={cfg.invSkewDelta} onChange={v => set({ invSkewDelta: v })} applied="" />
            <Adj label="inventory: vega" v={cfg.invSkewVega} onChange={v => set({ invSkewVega: v })} applied="" />
            <Adj label="inventory: contract" v={cfg.invSkewContract} onChange={v => set({ invSkewContract: v })} applied="" step={0.002} dp={3} />
            <Readout label="applied shift" value={applied(q.askBreak.inventory) || '0.000'} />
            <Field label="max per quote"><Num value={cfg.maxQuoteSize} onChange={v => set({ maxQuoteSize: v })} step={10} min={1} /></Field>
            <Field label="inventory relief"><Num value={cfg.invReliefSize} onChange={v => set({ invReliefSize: v })} step={5} min={0} /></Field>
            <Field label="levels per side"><Num value={cfg.levels} onChange={v => set({ levels: Math.round(v) })} step={1} min={1} max={4} /></Field>
            <Field label="level edge multiplier"><Num value={cfg.levelEdgeMult} onChange={v => set({ levelEdgeMult: v })} step={0.1} dp={2} min={1} /></Field>
            <Field label="level size multiplier"><Num value={cfg.levelSizeMult} onChange={v => set({ levelSizeMult: v })} step={0.1} dp={2} min={1} /></Field>
            <Field label="requote threshold $"><Num value={cfg.minTheoMove} onChange={v => set({ minTheoMove: v })} step={0.05} dp={2} min={0} /></Field>
            <Field label="max quote age ms"><Num value={cfg.maxQuoteAgeMs} onChange={v => set({ maxQuoteAgeMs: v })} step={500} min={100} /></Field>
          </Col>
        </Cols>
      )}

      {tab === 'limits' && (
        <Cols note="Soft widens quotes and cuts size. Hard cancels the side that would add exposure.">
          <Col title="Soft and hard">
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 5, ...LABEL, fontSize: 8, paddingBottom: 2 }}>
              <span style={{ width: 58, textAlign: 'right' }}>soft</span><span style={{ width: 58, textAlign: 'right' }}>hard</span>
            </div>
            <Pair label="delta" soft={cfg.deltaSoft} hard={cfg.deltaHard} onSoft={v => set({ deltaSoft: v })} onHard={v => set({ deltaHard: v })} step={100} />
            <Pair label="gamma" soft={cfg.gammaSoft} hard={cfg.gammaHard} onSoft={v => set({ gammaSoft: v })} onHard={v => set({ gammaHard: v })} step={10} />
            <Pair label="vega" soft={cfg.vegaSoft} hard={cfg.vegaHard} onSoft={v => set({ vegaSoft: v })} onHard={v => set({ vegaHard: v })} step={250} />
            <Pair label="loss $" soft={cfg.lossSoft} hard={cfg.lossHard} onSoft={v => set({ lossSoft: v })} onHard={v => set({ lossHard: v })} step={5000} />
            <Field label="max drawdown $"><Num value={cfg.drawdownHard} onChange={v => set({ drawdownHard: v })} step={5000} width={72} /></Field>
          </Col>
          <Col title="Concentration">
            <Field label="max net per strike"><Num value={cfg.perStrikeCap} onChange={v => set({ perStrikeCap: v })} step={25} min={1} /></Field>
            <Field label="max net per expiry"><Num value={cfg.perExpiryCap} onChange={v => set({ perExpiryCap: v })} step={50} min={1} /></Field>
          </Col>
          <Col title="Hedge execution">
            <Field label="min hedge"><Num value={cfg.minHedge} onChange={v => set({ minHedge: v })} step={5} min={1} /></Field>
            <Field label="max hedge"><Num value={cfg.maxHedge} onChange={v => set({ maxHedge: v })} step={100} min={1} /></Field>
            <Field label="min interval ms"><Num value={cfg.hedgeIntervalMs} onChange={v => set({ hedgeIntervalMs: v })} step={250} min={0} /></Field>
            <Field label="execution">
              <Seg options={[{ label: 'PASSIVE', value: 0 }, { label: 'AGGRESSIVE', value: 1 }]}
                value={cfg.hedgeAggressive ? 1 : 0} onChange={v => set({ hedgeAggressive: v === 1 })} size={9} />
            </Field>
            <Field label="max spread bps"><Num value={cfg.hedgeMaxSpreadBps} onChange={v => set({ hedgeMaxSpreadBps: v })} step={0.5} dp={1} min={0} /></Field>
          </Col>
        </Cols>
      )}
    </Overlay>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function Cols({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div>
      {note && <p style={{ ...MONO, fontSize: 10, color: T.muted, margin: 0, padding: '6px 11px 0' }}>{note}</p>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0, padding: 4 }}>{children}</div>
    </div>
  )
}

function Col({ title, children, span }: { title: string; children: React.ReactNode; span?: number }) {
  return (
    <div style={{ padding: '5px 9px', borderRight: `1px solid ${T.borderFaint}`, gridColumn: span ? `span ${span}` : undefined }}>
      <span style={{ ...LABEL, fontSize: 8.5, color: alpha(T.gold, 72) }}>{title}</span>
      <div style={{ marginTop: 3 }}>{children}</div>
    </div>
  )
}

function Readout({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '2px 0', minHeight: 20 }}>
      <span style={{ ...MONO, fontSize: 10, color: alpha(T.muted, 75) }}>{label}</span>
      <span style={{ ...MONO, fontSize: 10, color: tone ?? T.text }}>{value}</span>
    </div>
  )
}

function Adj({ label, v, onChange, applied, step = 0.05, dp = 2 }: {
  label: string; v: number; onChange: (n: number) => void; applied: string; step?: number; dp?: number
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '2px 0', minHeight: 20 }}>
      <span style={{ ...MONO, fontSize: 10, color: T.muted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span style={{ ...MONO, fontSize: 9, color: alpha(T.gold, 70), width: 44, textAlign: 'right' }}>{applied}</span>
      <Num value={v} onChange={onChange} step={step} dp={dp} min={0} width={52} />
    </div>
  )
}

function Pair({ label, soft, hard, onSoft, onHard, step }: {
  label: string; soft: number; hard: number; onSoft: (v: number) => void; onHard: (v: number) => void; step: number
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 5, padding: '2px 0' }}>
      <span style={{ ...MONO, fontSize: 10, color: T.muted, flex: 1 }}>{label}</span>
      <Num value={soft} onChange={onSoft} step={step} width={58} />
      <Num value={hard} onChange={onHard} step={step} width={58} />
    </div>
  )
}

function PathPreview({ cfg, tok }: { cfg: Config; tok: Record<string, string> }) {
  return (
    <Canvas height={70} draw={(ctx, w, h) => {
      if (!tok.gold) return
      const N = 90
      for (let path = 0; path < 12; path++) {
        let s = 1, v = cfg.atmVol
        let seed = path * 7919 + 13
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
        const pts: number[] = [1]
        for (let i = 0; i < N; i++) {
          const dt = 1 / (252 * 78)
          const z = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd())
          if (cfg.process !== 'gbm') v = Math.max(0.03, v + cfg.volReversion * (cfg.atmVol - v) * dt + cfg.volOfVol * v * Math.sqrt(dt) * z * cfg.spotVolCorr)
          const vol = cfg.process === 'gbm' ? cfg.realizedVol : v
          let r = (cfg.drift - 0.5 * vol * vol) * dt + vol * Math.sqrt(dt) * z
          if (cfg.process === 'jump' && rnd() < cfg.jumpPerHour / 78) r += (rnd() - 0.5) * 2 * cfg.jumpSize * 3
          s *= Math.exp(r)
          pts.push(s)
        }
        const lo = Math.min(...pts), hi = Math.max(...pts)
        const span = Math.max(hi - lo, 1e-6)
        ctx.beginPath()
        pts.forEach((p, i) => {
          const x = (i / N) * w
          const y = h - 2 - ((p - lo) / span) * (h - 4)
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
        })
        ctx.strokeStyle = hexAlpha(tok.gold, 0.26)
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }} />
  )
}

function SurfacePreview({ eng, cfg, tok }: { eng: Mm2Engine; cfg: Config; tok: Record<string, string> }) {
  return (
    <div>
      <Canvas height={160} draw={(ctx, w, h) => {
        if (!tok.gold) return
        const strikes = eng.strikes
        const cw = w / strikes.length
        const ch = h / DTES.length
        const surf = { atmVol: eng.instVol, putSkew: cfg.putSkew, callSkew: cfg.callSkew, termSlope: cfg.termSlope, curvature: cfg.curvature, noise: 0 }
        let lo = Infinity, hi = -Infinity
        const grid = DTES.map((_, e) => strikes.map(k => {
          const iv = surfaceIv(surf, eng.spot, k, eng.expiryT(e), cfg.rate, cfg.divYield) + (e <= 1 ? cfg.eventPremium : 0)
          lo = Math.min(lo, iv); hi = Math.max(hi, iv)
          return iv
        }))
        const span = Math.max(hi - lo, 1e-6)
        grid.forEach((row, e) => row.forEach((iv, s) => {
          const f = (iv - lo) / span
          ctx.fillStyle = `rgba(${Math.round(60 + 165 * f)}, ${Math.round(120 - 40 * f)}, ${Math.round(190 - 130 * f)}, ${0.28 + 0.6 * f})`
          ctx.fillRect(s * cw, e * ch, Math.ceil(cw) + 0.5, Math.ceil(ch) + 0.5)
        }))
        ctx.font = '9px ui-monospace, monospace'
        ctx.fillStyle = hexAlpha(tok.text, 0.85)
        DTES.forEach((_, e) => ctx.fillText(DTE_LABELS[e], 3, e * ch + ch / 2 + 3))
        const atmX = ((strikes.findIndex(k => k >= eng.spot) + 0.5) / strikes.length) * w
        ctx.strokeStyle = hexAlpha(tok.text, 0.5)
        ctx.beginPath(); ctx.moveTo(atmX, 0); ctx.lineTo(atmX, h); ctx.stroke()
      }} />
      <div style={{ display: 'flex', justifyContent: 'space-between', ...MONO, fontSize: 9, color: T.muted, padding: '2px 3px' }}>
        <span>{eng.strikes[0]}</span><span>strike, with the forward marked</span><span>{eng.strikes[eng.strikes.length - 1]}</span>
      </div>
    </div>
  )
}
