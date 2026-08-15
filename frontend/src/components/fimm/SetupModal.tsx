/*
 * Setup and Metrics, the two overlays the rail's footer buttons open.
 *
 * Setup is a real editor, not a stats view: the fields that came out of the
 * rail live here. Every field is bound to something the engine actually reads —
 * the handoff's inventory listed roughly a dozen dials the simulation has no
 * concept of, and a control that looks live and does nothing is worse than an
 * absent one.
 */

import { useState } from 'react'
import { T, alpha } from '../../lib/theme'
import { MONO, LABEL, Overlay, Seg, GOOD, BAD, WARN } from '../mm2/ui'
import {
  DEFAULT_CONFIG, HEDGE_FUTURES, fmtMoney, type Config, type FiEngine,
} from '../../lib/fimm/engine'

type SetupTab = 'market' | 'curve' | 'flow' | 'financing' | 'edge' | 'limits'

const TABS: { key: SetupTab; label: string; note: string }[] = [
  { key: 'market', label: 'Market', note: 'How hard the curve moves, and how often a print jolts it.' },
  { key: 'curve', label: 'Curve', note: 'Where the curve starts. Shape changes need a reset to take hold.' },
  { key: 'flow', label: 'Order flow', note: 'Who is asking, how big, and how hard a wide quote loses them.' },
  { key: 'financing', label: 'Financing', note: 'What the book costs to hold and what crossing the screen costs.' },
  { key: 'edge', label: 'Edge model', note: 'The half-spread and everything that widens or shades it.' },
  { key: 'limits', label: 'Risk limits', note: 'Soft limits are the left field, hard limits the right.' },
]

export function SetupOverlay({ eng, cfg, set, onClose, onReset }: {
  eng: FiEngine
  cfg: Config
  set: (patch: Partial<Config>) => void
  onClose: () => void
  onReset: () => void
}) {
  const [tab, setTab] = useState<SetupTab>('market')
  const note = TABS.find(t => t.key === tab)!.note
  const r = eng.risk()

  return (
    <Overlay title="Setup" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div style={{ display: 'flex', flexShrink: 0, borderBottom: `1px solid ${T.border}` }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              ...LABEL, fontSize: 9, letterSpacing: '0.16em', padding: '7px 14px', cursor: 'pointer',
              background: 'none', border: 'none', borderRadius: 0,
              borderBottom: `2px solid ${tab === t.key ? T.gold : 'transparent'}`,
              color: tab === t.key ? T.gold : T.muted,
            }}>{t.label}</button>
          ))}
        </div>

        <div style={{ ...MONO, fontSize: 10.5, color: T.muted, padding: '7px 14px 0' }}>{note}</div>

        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', padding: '8px 0' }}>
          {tab === 'market' && (
            <>
              <Group>
                <Num label="level vol" value={cfg.levelVolBp} onChange={v => set({ levelVolBp: v })} step={0.2} dp={1} unit="bp/day" />
                <Num label="slope vol" value={cfg.slopeVolBp} onChange={v => set({ slopeVolBp: v })} step={0.2} dp={1} unit="bp/day" />
                <Num label="curvature vol" value={cfg.curveVolBp} onChange={v => set({ curveVolBp: v })} step={0.2} dp={1} unit="bp/day" />
                <Num label="mean reversion" value={cfg.reversion} onChange={v => set({ reversion: v })} step={0.1} dp={2} unit="" />
              </Group>
              <Group>
                <Num label="prints per hour" value={cfg.shockPerHour} onChange={v => set({ shockPerHour: v })} step={0.1} dp={1} unit="/h" />
                <Num label="print size" value={cfg.shockSizeBp} onChange={v => set({ shockSizeBp: v })} step={1} dp={0} unit="bp" />
              </Group>
              <Group last>
                <Read label="10Y now" value={`${((eng.yieldOf('10Y') ?? 0) * 100).toFixed(3)}%`} color={T.gold} />
                <Read label="2s10s now" value={`${eng.slopeOf('2Y', '10Y').toFixed(0)} bp`} />
                <Read label="2s5s10s now" value={`${eng.flyOf('2Y', '5Y', '10Y').toFixed(0)} bp`} />
                <Read label="quoted nodes" value={String(eng.stat.quotedNodes)} />
              </Group>
            </>
          )}

          {tab === 'curve' && (
            <>
              <Group>
                <Num label="level" value={cfg.level0 * 100} onChange={v => set({ level0: v / 100 })} step={0.05} dp={3} unit="%" />
                <Num label="slope" value={cfg.slope0 * 100} onChange={v => set({ slope0: v / 100 })} step={0.05} dp={3} unit="%" />
                <Num label="curvature" value={cfg.curvature0 * 100} onChange={v => set({ curvature0: v / 100 })} step={0.05} dp={3} unit="%" />
                <Num label="decay" value={cfg.tau} onChange={v => set({ tau: v })} step={0.1} dp={2} unit="y" />
              </Group>
              <Group>
                {/* The issues are read-only here: each one's basis to the fitted
                    curve is calibration, and editing it would move the desk off
                    the published levels it opened on. */}
                {['3M', '2Y', '5Y', '10Y', '30Y'].map(l => (
                  <Read key={l} label={`${l} yield`} value={`${((eng.yieldOf(l) ?? 0) * 100).toFixed(3)}%`} />
                ))}
              </Group>
              <Group last>
                <Read label="richest" value={extreme(eng, 'rich')} />
                <Read label="cheapest" value={extreme(eng, 'cheap')} />
                <Read label="widest ASW" value={widestAsw(eng)} />
                <Read label="5s30s" value={`${eng.slopeOf('5Y', '30Y').toFixed(0)} bp`} />
              </Group>
            </>
          )}

          {tab === 'flow' && (
            <>
              <Group>
                <Num label="enquiry rate" value={cfg.arrivalRate} onChange={v => set({ arrivalRate: v })} step={0.1} dp={1} unit="/s" />
                <Num label="average size" value={cfg.avgSizeMM} onChange={v => set({ avgSizeMM: v })} step={1} dp={0} unit="mm" />
                <Num label="width sensitivity" value={cfg.widthSens} onChange={v => set({ widthSens: v })} step={0.5} dp={1} unit="" />
                <Num label="buy bias" value={cfg.buyBias} onChange={v => set({ buyBias: v })} step={0.05} dp={2} unit="" />
              </Group>
              <Group>
                <Num label="informed" value={cfg.informedPct} onChange={v => set({ informedPct: v })} step={1} dp={0} unit="%" />
                <Num label="fast money" value={cfg.fastPct} onChange={v => set({ fastPct: v })} step={1} dp={0} unit="%" />
                <Read label="real money" value={`${Math.max(0, 100 - cfg.informedPct - cfg.fastPct).toFixed(0)}%`} />
              </Group>
              <Group last>
                <Read label="toxicity" value={`${(eng.toxicity * 100).toFixed(0)}%`} color={eng.toxicity > 0.5 ? BAD : undefined} />
                <Read label="informed hits" value={String(eng.stat.informedFills)} color={eng.stat.informedFills ? BAD : undefined} />
                <Read label="adverse cost" value={fmtMoney(-eng.stat.informedLoss)} color={BAD} />
                <Read label="fill rate" value={`${eng.stat.enquiries ? ((eng.stat.fillsN / eng.stat.enquiries) * 100).toFixed(0) : 0}%`} />
              </Group>
            </>
          )}

          {tab === 'financing' && (
            <>
              <Group>
                <Num label="repo" value={cfg.repoRate * 100} onChange={v => set({ repoRate: v / 100 })} step={0.05} dp={2} unit="%" />
                <Num label="SOFR" value={cfg.sofr * 100} onChange={v => set({ sofr: v / 100 })} step={0.05} dp={2} unit="%" />
                <Btn onClick={() => set({ repoRate: cfg.sofr })}>MATCH REPO TO SOFR</Btn>
              </Group>
              <Group>
                <Num label="hedge slippage" value={cfg.hedgeSlippageTicks} onChange={v => set({ hedgeSlippageTicks: v })} step={0.25} dp={2} unit="ticks" />
                {HEDGE_FUTURES.slice(0, 3).map(f => <Read key={f.code} label={`${f.code} DV01`} value={`$${f.dv01}`} />)}
              </Group>
              <Group last>
                <Read label="coupon less repo" value={fmtMoney(r.carryPerDay)} color={r.carryPerDay >= 0 ? GOOD : BAD} />
                <Read label="roll-down" value={fmtMoney(r.rollPerDay)} color={r.rollPerDay >= 0 ? GOOD : BAD} />
                <Read label="hedges done" value={String(eng.stat.hedges)} />
                <Read label="hedge slippage" value={fmtMoney(-eng.stat.hedgeSlippage)} color={BAD} />
              </Group>
            </>
          )}

          {tab === 'edge' && (
            <>
              <Group>
                <Num label="edge" value={cfg.edgeBp} onChange={v => set({ edgeBp: v })} step={0.02} dp={2} unit="bp" />
                <Num label="long-end widen" value={cfg.longEndWiden} onChange={v => set({ longEndWiden: v })} step={0.002} dp={3} unit="bp/y" />
                <Num label="min edge" value={cfg.minEdgeBp} onChange={v => set({ minEdgeBp: v })} step={0.01} dp={2} unit="bp" />
                <Num label="max edge" value={cfg.maxEdgeBp} onChange={v => set({ maxEdgeBp: v })} step={0.25} dp={2} unit="bp" />
              </Group>
              <Group>
                <Num label="inventory skew" value={cfg.invSkewBp} onChange={v => set({ invSkewBp: v })} step={0.05} dp={2} unit="bp" />
                <Num label="curve tilt" value={cfg.curveSkewBp} onChange={v => set({ curveSkewBp: v })} step={0.05} dp={2} unit="bp" />
                <Num label="toxicity widen" value={cfg.toxicityWiden} onChange={v => set({ toxicityWiden: v })} step={0.1} dp={1} unit="" />
                <Num label="refresh" value={cfg.refreshMs} onChange={v => set({ refreshMs: v })} step={100} dp={0} unit="ms" />
              </Group>
              <Group last>
                <Num label="quote size" value={cfg.quoteSizeMM} onChange={v => set({ quoteSizeMM: v })} step={5} dp={0} unit="mm" />
                <Num label="inventory relief" value={cfg.invReliefMM} onChange={v => set({ invReliefMM: v })} step={5} dp={0} unit="mm" />
                <Num label="max per enquiry" value={cfg.maxQuoteSizeMM} onChange={v => set({ maxQuoteSizeMM: v })} step={10} dp={0} unit="mm" />
                <Num label="per-node cap" value={cfg.perNodeCapMM} onChange={v => set({ perNodeCapMM: v })} step={25} dp={0} unit="mm" />
              </Group>
            </>
          )}

          {tab === 'limits' && (
            <>
              <Group>
                <Pair label="net DV01" soft={cfg.dv01Soft} hard={cfg.dv01Hard}
                  onSoft={v => set({ dv01Soft: v })} onHard={v => set({ dv01Hard: v })} />
                <Pair label="loss" soft={cfg.lossSoft} hard={cfg.lossHard}
                  onSoft={v => set({ lossSoft: v })} onHard={v => set({ lossHard: v })} />
                <Num label="max drawdown" value={cfg.drawdownHard} onChange={v => set({ drawdownHard: v })} step={10_000} dp={0} unit="$" />
              </Group>
              <Group>
                <Num label="front bucket" value={cfg.frontDv01Limit} onChange={v => set({ frontDv01Limit: v })} step={1_000} dp={0} unit="/bp" />
                <Num label="belly bucket" value={cfg.bellyDv01Limit} onChange={v => set({ bellyDv01Limit: v })} step={1_000} dp={0} unit="/bp" />
                <Num label="long bucket" value={cfg.longDv01Limit} onChange={v => set({ longDv01Limit: v })} step={1_000} dp={0} unit="/bp" />
                <Num label="slope DV01" value={cfg.slopeDv01Limit} onChange={v => set({ slopeDv01Limit: v })} step={1_000} dp={0} unit="/bp" />
                <Num label="fly DV01" value={cfg.flyDv01Limit} onChange={v => set({ flyDv01Limit: v })} step={1_000} dp={0} unit="/bp" />
              </Group>
              <Group last>
                <Num label="hedge threshold" value={cfg.hedgeThreshold} onChange={v => set({ hedgeThreshold: v })} step={250} dp={0} unit="/bp" />
                <Num label="target DV01" value={cfg.targetDv01} onChange={v => set({ targetDv01: v })} step={1_000} dp={0} unit="/bp" />
                <Num label="hedge interval" value={cfg.hedgeIntervalMs} onChange={v => set({ hedgeIntervalMs: v })} step={250} dp={0} unit="ms" />
                <Read label="long end used" value={`${pctOf(r.byBucket.long, cfg.longDv01Limit)}%`}
                  color={Math.abs(r.byBucket.long) > cfg.longDv01Limit * 0.8 ? WARN : undefined} />
                <Read label="belly used" value={`${pctOf(r.byBucket.belly, cfg.bellyDv01Limit)}%`}
                  color={Math.abs(r.byBucket.belly) > cfg.bellyDv01Limit * 0.8 ? WARN : undefined} />
              </Group>
            </>
          )}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', flexShrink: 0,
          borderTop: `1px solid ${T.borderFaint}`, background: T.surface,
        }}>
          <span style={{ ...MONO, fontSize: 10.5, color: T.muted }}>
            Curve shape and decay only take hold on a reset. Everything else applies live.
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Btn onClick={() => set({ ...DEFAULT_CONFIG })}>RESTORE DEFAULTS</Btn>
            <Btn gold onClick={() => { onReset(); onClose() }}>APPLY AND RESET</Btn>
          </span>
        </div>
      </div>
    </Overlay>
  )
}

export function MetricsOverlay({ eng, onClose }: { eng: FiEngine; onClose: () => void }) {
  const s = eng.stat
  const r = eng.risk()
  return (
    <Overlay title="Metrics" onClose={onClose}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr' }}>
        <MGroup title="Quoting">
          <Read label="quoted nodes" value={String(s.quotedNodes)} />
          <Read label="enquiries" value={String(s.enquiries)} />
          <Read label="blocked by limit" value={String(s.blocked)} />
          <Read label="edge shown" value={`${s.notional ? (s.edgeIntendedBp / s.notional).toFixed(2) : '0.00'} bp`} />
        </MGroup>
        <MGroup title="Execution">
          <Read label="fills" value={String(s.fillsN)} />
          <Read label="notional done" value={`${Math.round(s.notional)}mm`} />
          <Read label="fill rate" value={`${s.enquiries ? ((s.fillsN / s.enquiries) * 100).toFixed(0) : 0}%`} />
          <Read label="edge kept" value={`${s.notional ? (s.edgeRealizedBp / s.notional).toFixed(2) : '0.00'} bp`} color={GOOD} />
          <Read label="of intended" value={`${s.edgeIntendedBp ? ((s.edgeRealizedBp / s.edgeIntendedBp) * 100).toFixed(0) : 0}%`} />
        </MGroup>
        <MGroup title="Adverse selection">
          <Read label="toxicity" value={`${(eng.toxicity * 100).toFixed(0)}%`} color={eng.toxicity > 0.5 ? BAD : undefined} />
          <Read label="informed hits" value={String(s.informedFills)} color={s.informedFills ? BAD : undefined} />
          <Read label="adverse cost" value={fmtMoney(-s.informedLoss)} color={BAD} />
          <Read label="net DV01" value={fmtMoney(r.dv01)} />
        </MGroup>
        <MGroup title="Futures held">
          {HEDGE_FUTURES.map(f => {
            const lots = eng.hedges[f.code] ?? 0
            return (
              <Read key={f.code} label={`${f.code} ${f.label}`}
                value={`${lots ? (lots > 0 ? '+' : '') + lots : '—'} · $${f.dv01}/bp`}
                color={lots > 0 ? GOOD : lots < 0 ? BAD : undefined} />
            )
          })}
        </MGroup>
      </div>
    </Overlay>
  )
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function Group({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{
      flex: '1 1 0', padding: '4px 14px', display: 'flex', flexDirection: 'column', gap: 4,
      borderRight: last ? undefined : `1px solid ${T.borderFaint}`,
    }}>{children}</div>
  )
}

function MGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 3,
      borderRight: `1px solid ${T.borderFaint}`, borderBottom: `1px solid ${T.borderFaint}`,
    }}>
      <div style={{ ...LABEL, fontSize: 9, letterSpacing: '0.16em', color: alpha(T.gold, 75), marginBottom: 3 }}>{title}</div>
      {children}
    </div>
  )
}

function Num({ label, value, onChange, step, dp, unit }: {
  label: string; value: number; onChange: (v: number) => void; step: number; dp: number; unit: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 22 }}>
      <span style={{ ...MONO, fontSize: 11, color: T.muted, flex: 1, minWidth: 0 }}>{label}</span>
      <input
        type="number" value={Number(value.toFixed(dp))} step={step}
        onChange={e => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) onChange(n) }}
        style={{
          ...MONO, fontSize: 11, width: 62, textAlign: 'right', padding: '2px 5px', borderRadius: 0,
          background: T.surface, color: T.text, border: `1px solid ${T.border}`,
        }}
      />
      <span style={{ ...MONO, fontSize: 9, color: T.muted, width: 30, flexShrink: 0 }}>{unit}</span>
    </div>
  )
}

/** Soft on the left, hard on the right, and the hard one wears the warning. */
function Pair({ label, soft, hard, onSoft, onHard }: {
  label: string; soft: number; hard: number; onSoft: (v: number) => void; onHard: (v: number) => void
}) {
  const input = (v: number, on: (n: number) => void, danger: boolean) => (
    <input
      type="number" value={Math.round(v)} step={1000}
      onChange={e => { const n = parseFloat(e.target.value); if (Number.isFinite(n)) on(n) }}
      style={{
        ...MONO, fontSize: 11, width: 58, textAlign: 'right', padding: '2px 5px', borderRadius: 0,
        background: T.surface, color: T.text,
        border: `1px solid ${danger ? alpha(BAD, 40) : T.border}`,
      }}
    />
  )
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, minHeight: 22 }}>
      <span style={{ ...MONO, fontSize: 11, color: T.muted, flex: 1, minWidth: 0 }}>{label}</span>
      {input(soft, onSoft, false)}
      {input(hard, onHard, true)}
    </div>
  )
}

function Read({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 22 }}>
      <span style={{ ...MONO, fontSize: 11, color: T.muted, flex: 1, minWidth: 0 }}>{label}</span>
      <span style={{ ...MONO, fontSize: 11, fontWeight: 600, color: color ?? T.text }}>{value}</span>
    </div>
  )
}

function Btn({ children, onClick, gold }: { children: React.ReactNode; onClick: () => void; gold?: boolean }) {
  return (
    <button onClick={onClick} style={{
      ...MONO, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', padding: '4px 12px',
      cursor: 'pointer', borderRadius: 0,
      background: gold ? alpha(T.gold, 12) : 'transparent',
      border: `1px solid ${gold ? alpha(T.gold, 55) : alpha(T.muted, 45)}`,
      color: gold ? T.gold : T.muted,
    }}>{children}</button>
  )
}

const pctOf = (v: number, limit: number) => Math.round((Math.abs(v) / Math.max(limit, 1)) * 100)

function extreme(eng: FiEngine, which: 'rich' | 'cheap'): string {
  const cash = eng.nodes.filter(n => n.kind === 'cash')
  if (!cash.length) return '—'
  const pick = cash.reduce((a, b) =>
    which === 'rich' ? (b.aswBp < a.aswBp ? b : a) : (b.aswBp > a.aswBp ? b : a))
  return `${pick.label} ${pick.aswBp.toFixed(1)} bp`
}

function widestAsw(eng: FiEngine): string {
  const cash = eng.nodes.filter(n => n.kind === 'cash')
  if (!cash.length) return '—'
  const pick = cash.reduce((a, b) => (Math.abs(b.aswBp) > Math.abs(a.aswBp) ? b : a))
  return `${pick.label} ${pick.aswBp.toFixed(1)} bp`
}
