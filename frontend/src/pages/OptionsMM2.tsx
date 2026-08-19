/*
 * Options MM Simulator — a single-screen options market making terminal.
 *
 * Layout rule: the chain is the tool and takes every pixel left over; the rail,
 * the risk column, the workbench and the P&L band are fixed-height supports.
 * Nothing scrolls the page itself, so the whole desk stays on one screen.
 *
 * Simulation lives in lib/mm2/engine.ts. This file owns layout, the frame loop
 * and the selection that keeps every panel talking about the same contract.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import axios from 'axios'
import { T, alpha } from '../lib/theme'
import { MONO, LABEL, Panel, Btn, Seg, GOOD, BAD, WARN, pnlColor } from '../components/mm2/ui'
import StrategyRail from '../components/mm2/StrategyRail'
import RightColumn from '../components/mm2/RightColumn'
import Workbench from '../components/mm2/Workbench'
import SetupModal from '../components/mm2/SetupModal'
import MetricsOverlay from '../components/mm2/MetricsOverlay'
import { Chain, ExpiryStrip, fmtK, type Highlight } from '../components/mm2/Chain'
import { ChainHeader } from '../components/mm2/Center'
import { Mm2Engine, DEFAULT_CONFIG, DTE_LABELS, STEP_MS, fmtClock, fmtMoney, type Config, type Sample } from '../lib/mm2/engine'
import { BOTTOM_H } from '../components/mm2/layout'
import ShellActions from '../components/ShellActions'

const SPEEDS = [1, 5, 10, 25, 100]
// Everything ran four times too quickly to read. Each labelled speed now
// advances a quarter as much simulated time, and the underlying slows with it
// because the whole clock does.
const TIME_DIVISOR = 4
const FRAME_MS = 100
type SetupTab = 'market' | 'flow' | 'edge' | 'limits'

export default function OptionsMM2() {
  const [sp, setSp] = useSearchParams()
  const [seed, setSeed] = useState(() => Number(sp.get('seed')) || 20260813)
  const [cfg, setCfg] = useState<Config>(DEFAULT_CONFIG)
  // Lazy: `useRef(new Mm2Engine(...))` would construct and price a fresh
  // 200-contract universe on every one of the 10 renders per second.
  const engRef = useRef<Mm2Engine | null>(null)
  if (!engRef.current) engRef.current = new Mm2Engine(DEFAULT_CONFIG, Number(sp.get('seed')) || 20260813)
  const eng = engRef.current

  const [running, setRunning] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [tick, setTick] = useState(0)
  const [expIdx, setExpIdx] = useState(1)
  const [sel, setSel] = useState(() => eng.nearestAtm(1, 'C'))
  const [highlight, setHighlight] = useState<Highlight>('none')
  const [reviewT, setReviewT] = useState<number | null>(null)
  const [setup, setSetup] = useState<SetupTab | null>(null)
  const [metricsOpen, setMetricsOpen] = useState(false)

  // Open on the real index level. A hardcoded 5320 was wrong the day it was
  // written and drifts further every session, and the strike ladder is built
  // from the opening spot, so the whole chain inherits the error.
  const seedRef = useRef(seed)
  seedRef.current = seed
  useEffect(() => {
    let cancelled = false
    axios.get('/api/market/quotes', { params: { tickers: '^GSPC' } })
      .then(res => {
        const px = Number(res.data?.quotes?.['^GSPC']?.current_price)
        if (cancelled || !Number.isFinite(px) || px <= 0) return
        // A session already under way is left alone rather than reset under you.
        if (engRef.current && engRef.current.clock > 0) return
        const open = Math.round(px / 10) * 10
        const next = { ...DEFAULT_CONFIG, spot0: open }
        const fresh = new Mm2Engine(next, seedRef.current)
        engRef.current = fresh
        setCfg(next)
        setSel(fresh.nearestAtm(1, 'C'))
        setTick(t => t + 1)
      })
      .catch(() => { /* the default opening level stands */ })
    return () => { cancelled = true }
  }, [])

  const set = useCallback((patch: Partial<Config>) => {
    setCfg(c => {
      if (engRef.current) Object.assign(engRef.current.cfg, patch)
      return { ...c, ...patch }
    })
  }, [])

  // Fractional steps carry across frames: at 1x the budget is half a step per
  // frame, and rounding that up to one would silently run at double speed.
  const stepDebt = useRef(0)
  useEffect(() => {
    const id = window.setInterval(() => {
      if (running && engRef.current && !engRef.current.riskStop) {
        stepDebt.current += (speed * FRAME_MS) / STEP_MS / TIME_DIVISOR
        const steps = Math.floor(stepDebt.current)
        if (steps > 0) {
          stepDebt.current -= steps
          engRef.current.run(steps)
        }
      }
      setTick(t => t + 1)
    }, FRAME_MS)
    return () => { window.clearInterval(id); stepDebt.current = 0 }
  }, [running, speed])

  useEffect(() => { if (eng.riskStop && running) setRunning(false) }, [eng.riskStop, running, tick, eng])

  useEffect(() => {
    setSp(prev => {
      const n = new URLSearchParams(prev)
      n.set('seed', String(seed))
      return n
    }, { replace: true })
  }, [seed, setSp])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      if (e.code === 'Space') { e.preventDefault(); setRunning(r => !r) }
      if (e.key === 's' || e.key === 'S') { engRef.current?.step(); setTick(t => t + 1) }
      if (e.key === 'k' || e.key === 'K') { engRef.current?.kill(); setRunning(false); setTick(t => t + 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const reset = useCallback((newSeed?: number) => {
    const s = newSeed ?? seed
    const fresh = new Mm2Engine(cfg, s)
    engRef.current = fresh
    setSeed(s)
    setRunning(false)
    setReviewT(null)
    setSel(fresh.nearestAtm(Math.min(expIdx, cfg.quoteExpiries - 1), 'C'))
    setTick(t => t + 1)
  }, [cfg, seed, expIdx])

  const pickExpiry = useCallback((e: number) => {
    setExpIdx(e)
    const cur = engRef.current
    if (cur) setSel(cur.nearestAtm(e, cur.contracts[sel]?.kind ?? 'C'))
  }, [sel])

  const sample: Sample | null = useMemo(() => {
    if (reviewT === null || !eng.samples.length) return null
    let best = eng.samples[0]
    for (const s of eng.samples) if (Math.abs(s.t - reviewT) < Math.abs(best.t - reviewT)) best = s
    return best
  }, [reviewT, eng.samples, tick])

  const live = sample === null
  const viewSpot = sample?.spot ?? eng.spot
  const rows = useMemo(() => eng.chainRows(expIdx, sample ?? undefined), [eng, expIdx, sample, tick])
  const selLeg = useMemo(
    () => rows.flatMap(r => [r.call, r.put]).find(l => l.ck === sel) ?? null,
    [rows, sel],
  )

  const r = eng.risk()
  const pnl = eng.totalPnl()
  const status = eng.killed ? 'KILLED' : eng.riskStop ? 'RISK STOPPED' : running ? 'RUNNING' : 'PAUSED'
  const statusColor = eng.killed || eng.riskStop ? BAD : running ? GOOD : WARN

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: '100%', minHeight: 560, ...MONO }}>

      {/* Command bar (46) */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '6px 12px', flexShrink: 0, height: 46,
        boxSizing: 'border-box', background: T.surface, border: `1px solid ${T.border}`,
        borderTop: `2px solid ${statusColor}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 176 }}>
          <span style={{ ...LABEL, fontSize: 9, color: statusColor }}>{status}</span>
          <span style={{ ...MONO, fontSize: 14, fontWeight: 600, color: T.text }}>{fmtClock(eng.clock)}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Btn tone={running ? 'bad' : 'good'} onClick={() => setRunning(x => !x)}>{running ? 'PAUSE' : 'RUN'}</Btn>
          <Seg options={SPEEDS.map(sp2 => ({ label: `${sp2}x`, value: sp2 }))} value={speed} onChange={setSpeed} size={9} />
          <Btn onClick={() => reset()}>RESET</Btn>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginLeft: 'auto' }}>
          <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
            <span style={{ ...LABEL, fontSize: 8.5 }}>Total P&L</span>
            <span style={{ ...MONO, fontSize: 21, fontWeight: 700, color: pnlColor(pnl) }}>{fmtMoney(pnl)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', ...MONO, fontSize: 10, lineHeight: 1.25 }}>
            <span style={{ color: T.muted }}>realized <span style={{ color: pnlColor(eng.realized) }}>{fmtK(eng.realized)}</span></span>
            <span style={{ color: T.muted }}>open <span style={{ color: pnlColor(pnl - eng.realized) }}>{fmtK(pnl - eng.realized)}</span></span>
          </div>
          <LimitChip label="Delta" value={fmtK(r.delta)} used={Math.abs(r.delta) / Math.max(cfg.deltaHard, 1)} soft={Math.abs(r.delta) > cfg.deltaSoft} />
          <LimitChip label="Gamma" value={r.gamma.toFixed(1)} used={Math.abs(r.gamma) / Math.max(cfg.gammaHard, 1)} soft={Math.abs(r.gamma) > cfg.gammaSoft} />
          <LimitChip label="Vega" value={fmtK(r.vega)} used={Math.abs(r.vega) / Math.max(cfg.vegaHard, 1)} soft={Math.abs(r.vega) > cfg.vegaSoft} />
          <Btn onClick={() => eng.flatten()} title="Cross the street on every position and go flat">FLATTEN</Btn>
          {eng.killed
            ? <Btn tone="good" onClick={() => { eng.clearKill(); setTick(t => t + 1) }}>CLEAR KILL</Btn>
            : <button onClick={() => { eng.kill(); setRunning(false); setTick(t => t + 1) }} style={{
              ...MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', padding: '5px 16px',
              cursor: 'pointer', border: `1px solid ${BAD}`, background: alpha(BAD, 16), color: BAD,
            }}>KILL</button>}
          <ShellActions />
        </div>
      </header>

      {reviewT !== null && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '3px 10px', flexShrink: 0,
          background: alpha(T.gold, 12), border: `1px solid ${alpha(T.gold, 35)}`,
        }}>
          <span style={{ ...LABEL, fontSize: 9, color: T.gold }}>Review</span>
          <span style={{ ...MONO, fontSize: 10, color: T.text }}>
            Rewound to {fmtClock(sample?.t ?? reviewT).slice(0, 8)}. Chain, risk, fills and log are as of that instant.
            Resting quotes are not recorded historically.
          </span>
          <Btn tone="gold" onClick={() => setReviewT(null)}>RETURN TO LIVE</Btn>
        </div>
      )}

      {/* Rail, workspace, risk */}
      <div style={{ display: 'flex', gap: 4, flex: 1, minHeight: 0 }}>
        <div style={{ width: 178, flexShrink: 0, minHeight: 0, display: 'flex' }}>
          <StrategyRail eng={eng} cfg={cfg} set={set}
            onSetup={() => setSetup('market')} onMetrics={() => setMetricsOpen(true)} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0, minHeight: 0 }}>
          <Panel style={{ flex: '1 1 auto', minHeight: 0 }}>
            <ChainHeader eng={eng} tick={tick} reviewT={reviewT} onScrub={setReviewT}
              highlight={highlight} expLabel={DTE_LABELS[expIdx]} />
            <ExpiryStrip eng={eng} expIdx={expIdx} onPick={pickExpiry} tick={tick} />
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <Chain eng={eng} rows={rows} sel={sel} onSel={setSel} expIdx={expIdx}
                highlight={highlight} live={live} spot={viewSpot} tick={tick} />
            </div>
          </Panel>


        </div>

        <div style={{ width: 236, flexShrink: 0, minHeight: 0 }}>
          <RightColumn eng={eng} cfg={cfg} set={set} tick={tick} highlight={highlight}
            onHighlight={setHighlight} live={live} onTick={() => setTick(t => t + 1)} />
        </div>
      </div>

      {/* Bottom pane: inspector tabs and the P&L cell, one pane not two */}
      <div style={{ height: BOTTOM_H, flexShrink: 0, minHeight: 0, display: 'flex' }}>
        <Workbench eng={eng} sel={sel} onSel={setSel} tick={tick} live={live}
          sample={sample} leg={selLeg} reviewT={reviewT} onScrub={setReviewT} />
      </div>

      {setup && (
        <SetupModal eng={eng} cfg={cfg} set={set} sel={sel} initial={setup} onClose={() => setSetup(null)} />
      )}
      {metricsOpen && <MetricsOverlay eng={eng} onClose={() => setMetricsOpen(false)} />}
    </div>
  )
}

/** Level and limit usage in one chip, so the bar carries headroom, not just a number. */
function LimitChip({ label, value, used, soft }: { label: string; value: string; used: number; soft: boolean }) {
  const tone = soft ? WARN : T.text
  return (
    <div style={{ padding: '3px 9px', background: T.bg, border: `1px solid ${T.border}`, minWidth: 92 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ ...LABEL, fontSize: 8.5, color: soft ? WARN : T.muted }}>{label}</span>
        <span style={{ ...MONO, fontSize: 12.5, fontWeight: 700, color: tone }}>{value}</span>
        <span style={{ ...MONO, fontSize: 9, color: soft ? WARN : T.muted, marginLeft: 'auto' }}>
          {(used * 100).toFixed(0)}%{soft ? ' soft' : ''}
        </span>
      </div>
      <div style={{ height: 2, background: alpha(T.muted, 20), marginTop: 3 }}>
        <div style={{ height: '100%', width: `${Math.min(100, used * 100)}%`, background: soft ? WARN : alpha(T.gold, 65) }} />
      </div>
    </div>
  )
}
