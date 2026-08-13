/*
 * Options MM 2 — a single-screen options market making terminal.
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
import { T, alpha } from '../lib/theme'
import { MONO, LABEL, Panel, Btn, Seg, GOOD, BAD, WARN, pnlColor } from '../components/mm2/ui'
import StrategyRail from '../components/mm2/StrategyRail'
import RightColumn from '../components/mm2/RightColumn'
import Workbench from '../components/mm2/Workbench'
import PnlBand from '../components/mm2/PnlBand'
import SetupModal from '../components/mm2/SetupModal'
import { Chain, ExpiryStrip, fmtK, type Density, type Highlight } from '../components/mm2/Chain'
import { UnderlyingStrip } from '../components/mm2/Center'
import { Mm2Engine, DEFAULT_CONFIG, DTE_LABELS, fmtClock, fmtMoney, type Config, type Sample } from '../lib/mm2/engine'

const SPEEDS = [1, 5, 10, 25, 100]
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
  const [speed, setSpeed] = useState(10)
  const [tick, setTick] = useState(0)
  const [expIdx, setExpIdx] = useState(1)
  const [sel, setSel] = useState(() => eng.nearestAtm(1, 'C'))
  const [highlight, setHighlight] = useState<Highlight>('none')
  const [reviewT, setReviewT] = useState<number | null>(null)
  const [density, setDensity] = useState<Density>('compact')
  const [setup, setSetup] = useState<SetupTab | null>(null)

  const set = useCallback((patch: Partial<Config>) => {
    setCfg(c => {
      if (engRef.current) Object.assign(engRef.current.cfg, patch)
      return { ...c, ...patch }
    })
  }, [])

  useEffect(() => {
    const pick = () => setDensity(window.innerWidth >= 2000 ? 'full' : 'compact')
    pick()
    window.addEventListener('resize', pick)
    return () => window.removeEventListener('resize', pick)
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      if (running && engRef.current && !engRef.current.riskStop) {
        engRef.current.run(Math.max(1, Math.round((speed * FRAME_MS) / 50)))
      }
      setTick(t => t + 1)
    }, FRAME_MS)
    return () => window.clearInterval(id)
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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: 'calc(100vh - 62px)', minHeight: 600, ...MONO }}>

      {/* Command bar */}
      <header style={{
        display: 'flex', alignItems: 'center', gap: 14, padding: '5px 10px', flexShrink: 0,
        background: T.surface, border: `1px solid ${T.border}`, borderTop: `2px solid ${statusColor}`,
      }}>
        <span style={{ ...MONO, fontSize: 10, color: statusColor, fontWeight: 700, minWidth: 92 }}>{status}</span>
        <span style={{ ...MONO, fontSize: 13, color: T.text, fontWeight: 600 }}>{fmtClock(eng.clock)}</span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Btn tone={running ? 'bad' : 'good'} onClick={() => setRunning(x => !x)}>{running ? 'PAUSE' : 'RUN'}</Btn>
          <Btn onClick={() => { eng.step(); setTick(t => t + 1) }} disabled={running}>STEP</Btn>
          <Seg options={SPEEDS.map(s => ({ label: `${s}x`, value: s }))} value={speed} onChange={setSpeed} size={9} />
          <Btn onClick={() => reset()}>RESET</Btn>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginLeft: 'auto' }}>
          <Tick label="Total P&L" value={fmtMoney(pnl)} big color={pnlColor(pnl)} />
          <Tick label="realized" value={fmtK(eng.realized)} color={pnlColor(eng.realized)} />
          <Tick label="net delta" value={fmtK(r.delta)} color={Math.abs(r.delta) > cfg.deltaSoft ? WARN : T.text} />
          <Tick label="net vega" value={fmtK(r.vega)} color={Math.abs(r.vega) > cfg.vegaSoft ? WARN : T.text} />
          <Btn onClick={() => eng.flatten()} title="Cross the street on every position and go flat">FLATTEN</Btn>
          {eng.killed
            ? <Btn tone="good" onClick={() => { eng.clearKill(); setTick(t => t + 1) }}>CLEAR KILL</Btn>
            : <button onClick={() => { eng.kill(); setRunning(false); setTick(t => t + 1) }} style={{
              ...MONO, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', padding: '5px 16px',
              cursor: 'pointer', border: `1px solid ${BAD}`, background: alpha(BAD, 16), color: BAD,
            }}>KILL</button>}
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
        <div style={{ width: 196, flexShrink: 0, minHeight: 0, display: 'flex' }}>
          <StrategyRail eng={eng} cfg={cfg} set={set} onSetup={t => setSetup(t ?? 'market')} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 0, minHeight: 0 }}>
          <UnderlyingStrip eng={eng} tick={tick} reviewT={reviewT} onScrub={setReviewT} />

          <Panel
            title="Options chain"
            style={{ flex: '1 1 auto', minHeight: 200 }}
            right={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {highlight !== 'none' && <span style={{ ...MONO, fontSize: 9, color: T.gold }}>tracing {highlight}</span>}
                <span style={{ ...MONO, fontSize: 9, color: T.muted }}>{DTE_LABELS[expIdx]}</span>
                <Seg<Density> options={[{ label: 'DENSE', value: 'full' }, { label: 'SIMPLE', value: 'compact' }]}
                  value={density} onChange={setDensity} size={8.5} />
              </div>
            }
          >
            <ExpiryStrip eng={eng} expIdx={expIdx} onPick={pickExpiry} tick={tick} />
            <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
              <Chain eng={eng} rows={rows} sel={sel} onSel={setSel} expIdx={expIdx}
                density={density} highlight={highlight} live={live} spot={viewSpot} tick={tick} />
            </div>
          </Panel>

          <div style={{ height: 238, flexShrink: 0, display: 'flex', minHeight: 0 }}>
            <Workbench eng={eng} sel={sel} onSel={setSel} tick={tick} live={live} sample={sample} leg={selLeg} />
          </div>
        </div>

        <div style={{ width: 250, flexShrink: 0, minHeight: 0 }}>
          <RightColumn eng={eng} cfg={cfg} set={set} tick={tick} highlight={highlight} onHighlight={setHighlight} live={live} />
        </div>
      </div>

      {/* P&L band */}
      <div style={{ height: 128, flexShrink: 0, minHeight: 0 }}>
        <PnlBand eng={eng} tick={tick} reviewT={reviewT} onScrub={setReviewT} />
      </div>

      {setup && (
        <SetupModal eng={eng} cfg={cfg} set={set} sel={sel} initial={setup} onClose={() => setSetup(null)} />
      )}
    </div>
  )
}

function Tick({ label, value, big, color }: { label: string; value: string; big?: boolean; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.15 }}>
      <span style={{ ...LABEL, fontSize: 7.5 }}>{label}</span>
      <span style={{ ...MONO, fontSize: big ? 15 : 11.5, fontWeight: big ? 700 : 600, color: color ?? T.text }}>{value}</span>
    </div>
  )
}
