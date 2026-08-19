/*
 * Fixed Income MM Simulator — a single-screen rates market making terminal.
 *
 * Same layout rule as the options desk: the issue matrix is the tool and takes
 * every pixel left over, while the rail, the risk column and the inspector are
 * fixed-height supports. Nothing scrolls the page itself.
 *
 * Simulation lives in lib/fimm/engine.ts. This file owns layout, the frame loop
 * and the selection that keeps every panel talking about the same issue.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { T } from '../lib/theme'
import { MONO, Panel, GOOD, BAD, WARN } from '../components/mm2/ui'
import { BOTTOM_H_RATES, GAP } from '../components/mm2/layout'
import TopBar from '../components/fimm/TopBar'
import QuoteRail from '../components/fimm/QuoteRail'
import Matrix, { MatrixHeader, ScopeLine } from '../components/fimm/Matrix'
import CurvePanel from '../components/fimm/CurvePanel'
import RiskColumn from '../components/fimm/RiskColumn'
import Inspector from '../components/fimm/Inspector'
import { SetupOverlay, MetricsOverlay } from '../components/fimm/SetupModal'
import { DEFAULT_CONFIG, FiEngine, STEP_MS, type Bucket, type Config } from '../lib/fimm/engine'

// The options desk runs its clock a quarter as fast as the labelled speed so a
// human can read the tape. A rates book moves more slowly still, so the same
// divisor leaves the curve legible at 1x.
const TIME_DIVISOR = 4
const FRAME_MS = 100

export default function FixedIncomeMM2() {
  const [sp, setSp] = useSearchParams()
  const [seed, setSeed] = useState(() => Number(sp.get('seed')) || 20260815)
  const [cfg, setCfg] = useState<Config>(DEFAULT_CONFIG)
  // Lazy: constructing the engine inline would rebuild and reprice the whole
  // universe on every one of the ten renders a second.
  const engRef = useRef<FiEngine | null>(null)
  if (!engRef.current) engRef.current = new FiEngine(DEFAULT_CONFIG, Number(sp.get('seed')) || 20260815)
  const eng = engRef.current

  const [running, setRunning] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [tick, setTick] = useState(0)
  const [sel, setSel] = useState(() => eng.nodes.find(n => n.label === '10Y')?.id ?? 0)
  const [reviewT, setReviewT] = useState<number | null>(null)
  const [overlay, setOverlay] = useState<'setup' | 'metrics' | null>(null)
  const [traced, setTraced] = useState<Bucket | null>(null)

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
    const fresh = new FiEngine(cfg, s)
    engRef.current = fresh
    setSeed(s)
    setRunning(false)
    setSel(fresh.nodes.find(n => n.label === '10Y')?.id ?? 0)
    setTick(t => t + 1)
  }, [cfg, seed])

  // The board is the eight on-the-run cash issues. The SOFR strip is still
  // built by the engine, but a group tab that does not filter reads as stale
  // data, so the tabs and the filtering come back together or not at all.
  const rows = useMemo(() => eng.rows('Cash'), [eng, tick])
  const view = useMemo(() => {
    const nd = eng.nodes[sel]
    return nd ? eng.view(nd) : null
  }, [eng, sel, tick])

  // Every panel describing a row the trader cannot see is the bug this guard
  // exists to prevent.
  useEffect(() => {
    if (rows.length && !rows.some(r => r.node.id === sel)) setSel(rows[0].node.id)
  }, [rows, sel])

  const risk = eng.risk()
  const pnl = eng.totalPnl()
  const status = eng.killed ? 'KILLED' : eng.riskStop ? 'RISK STOPPED' : running ? 'RUNNING' : 'PAUSED'
  const statusColor = eng.killed || eng.riskStop ? BAD : running ? GOOD : WARN

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, height: '100%', minHeight: 560, ...MONO }}>
      <TopBar
        eng={eng} risk={risk} pnl={pnl} running={running} speed={speed}
        status={status} statusColor={statusColor}
        onRun={() => setRunning(x => !x)}
        onSpeed={setSpeed}
        onReset={() => reset()}
        onFlatten={() => { eng.flatten(); setTick(t => t + 1) }}
        onKill={() => { eng.kill(); setRunning(false); setTick(t => t + 1) }}
        onClearKill={() => { eng.clearKill(); setTick(t => t + 1) }}
      />

      {eng.riskStop && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '3px 10px', flexShrink: 0,
          background: 'color-mix(in srgb, var(--theme-negative) 12%, transparent)',
          border: `1px solid ${BAD}`,
        }}>
          <span style={{ ...MONO, fontSize: 10, color: BAD }}>
            Desk stopped. {eng.riskStop}. Flatten the book or clear the kill to resume.
          </span>
        </div>
      )}

      <div style={{ display: 'flex', gap: 4, flex: 1, minHeight: 0 }}>
        <div style={{ width: 190, flexShrink: 0, minHeight: 0, display: 'flex' }}>
          <QuoteRail eng={eng} cfg={cfg} set={set} tick={tick}
            onSetup={() => setOverlay('setup')} onMetrics={() => setOverlay('metrics')} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP, flex: 1, minWidth: 0, minHeight: 0 }}>
          <Panel style={{ flex: '1 1 auto', minHeight: 0 }}>
            <MatrixHeader eng={eng} tick={tick} reviewT={reviewT} onScrub={setReviewT} />
            <ScopeLine quoted={rows.filter(r => r.inScope).length} total={rows.length} />
            <Matrix eng={eng} rows={rows} sel={sel} onSel={setSel} traced={traced} />
          </Panel>
          <CurvePanel eng={eng} rows={rows} sel={sel} onSel={setSel} tick={tick} />
        </div>

        <div style={{ width: 244, flexShrink: 0, minHeight: 0 }}>
          <RiskColumn eng={eng} cfg={cfg} set={set} risk={risk} tick={tick}
            onTick={() => setTick(t => t + 1)} traced={traced} onTrace={setTraced} />
        </div>
      </div>

      <div style={{ height: BOTTOM_H_RATES, flexShrink: 0, minHeight: 0, display: 'flex' }}>
        <Inspector eng={eng} view={view} tick={tick} />
      </div>

      {overlay === 'setup' && (
        <SetupOverlay eng={eng} cfg={cfg} set={set}
          onClose={() => setOverlay(null)} onReset={() => reset()} />
      )}
      {overlay === 'metrics' && <MetricsOverlay eng={eng} onClose={() => setOverlay(null)} />}
    </div>
  )
}
