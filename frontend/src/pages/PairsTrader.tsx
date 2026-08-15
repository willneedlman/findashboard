import { useMemo, useState } from 'react'
import { useToolState } from '../hooks/useToolState'
import { useMutation } from '@tanstack/react-query'
import { ComposedChart, Line, Scatter, XAxis, YAxis, ReferenceLine, ResponsiveContainer, Tooltip, CartesianGrid, AreaChart, Area, LineChart } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import ErrorState from '../components/ErrorState'
import LoadingState from '../components/LoadingState'
import TickerLink from '../components/TickerLink'
import HelpTip from '../components/HelpTip'
import { INPUT, LABEL, SIDEBAR, TICK, TOOLTIP_STYLE } from './valuationShared'
import { fetchPairsAnalysis } from '../hooks/useApi'
import { T } from '../lib/theme'
import { MONO, SANS, mix, chg, signed, Panel, seg, KpiStrip } from './cockpitKit'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip, textClip } from '../lib/reportCaptureRegistry'

interface Trade { n: number; entered: string; exited: string | null; side: string; z_in: number; z_out: number | null; days: number; pnl: number; open: boolean }
interface Marker { date: string; z: number; side?: string; kind: string }
interface Resp {
  a: string; b: string; hedge_ratio: number; correlation: number | null
  adf: { stat: number | null; crit_5: number; stationary: boolean }
  half_life_days: number | null
  zscore: { current: number | null; entry: number; exit: number; window: number }
  signal: 'long_spread' | 'short_spread' | 'flat'
  hedge_method: string; costs_bps: number
  last: { a: number; b: number }; leg_return: { a: number; b: number }
  backtest: { sharpe: number | null; total_spread_return: number; trades: number; wins: number; win_rate: number | null; exposure_pct: number }
  trades: Trade[]; markers: Marker[]
  series: { date: string; z: number | null }[]
  equity: { date: string; v: number }[]
  legs: { date: string; a: number; b: number }[]
  observations: number; lookback_days: number; source: string
}

const PRESETS = ['XOM/CVX', 'KO/PEP', 'V/MA', 'GLD/SLV', 'XLE/USO', 'MS/GS']
const SIG = { long_spread: 'LONG SPREAD', short_spread: 'SHORT SPREAD', flat: 'IN RANGE' }
const railSection: React.CSSProperties = { padding: '12px 0 13px', borderBottom: `1px solid ${T.border}` }

export default function PairsTrader() {
  const [a, setA] = useState('XOM')
  const [b, setB] = useState('CVX')
  const [lookback, setLookback] = useToolState('pairs.lookback', 730)
  const [entryZ, setEntryZ] = useState('2')
  const [exitZ, setExitZ] = useState('0.5')
  const [zWindow, setZWindow] = useState('60')
  const [costs, setCosts] = useState('5')
  const [hedge, setHedge] = useState('ols')

  const m = useMutation<Resp>({
    mutationFn: () => fetchPairsAnalysis({
      a: a.trim().toUpperCase(), b: b.trim().toUpperCase(), lookback_days: lookback,
      entry_z: Number(entryZ) || 2, exit_z: Number(exitZ) || 0.5, z_window: Number(zWindow) || 60,
      costs_bps: Number(costs) || 0, hedge_method: hedge,
    }),
  })
  const run = () => m.mutate()
  const swap = () => { setA(b); setB(a); if (m.data) setTimeout(run, 0) }
  const applyPreset = (p: string) => { const [x, y] = p.split('/'); setA(x); setB(y); setTimeout(run, 0) }

  const rail = (
    <div style={{ ...SIDEBAR, gap: 0, padding: 0 }}>
      <div style={{ ...railSection, padding: '12px 12px 13px' }}>
        <div style={{ fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.gold, marginBottom: 9 }}>Pair</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input value={a} onChange={e => setA(e.target.value.toUpperCase())} style={{ ...INPUT, flex: 1 }} />
          <button onClick={swap} title="Swap legs" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, flexShrink: 0, border: `1px solid ${T.border}`, background: 'transparent', color: T.muted, cursor: 'pointer', fontSize: 11 }}>⇄</button>
          <input value={b} onChange={e => setB(e.target.value.toUpperCase())} style={{ ...INPUT, flex: 1 }} />
        </div>
        <div style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, marginTop: 7, lineHeight: 1.5 }}>Spread = log({a || 'A'}) − β · log({b || 'B'})</div>
      </div>

      <div style={{ ...railSection, padding: '12px 12px 13px' }}>
        <div style={{ ...LABEL, marginBottom: 7 }}>Presets</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
          {PRESETS.map(p => {
            const on = `${a}/${b}` === p
            return <button key={p} onClick={() => applyPreset(p)} style={{ fontFamily: MONO, fontSize: 9.5, padding: '5px 0', cursor: 'pointer', background: on ? mix(T.gold, 10) : 'transparent', color: on ? T.gold : T.muted, border: `1px solid ${on ? T.gold : T.border}` }}>{p}</button>
          })}
        </div>
      </div>

      <div style={{ ...railSection, padding: '12px 12px 13px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 7 }}>
          <span style={LABEL as React.CSSProperties}>Hedge method</span>
          <HelpTip title="Hedge ratio method" body={`How β between the legs is fit. OLS is one static β over the full window. ROLL refits β on a trailing window so it drifts. KALMAN filters β as a random walk and trades the one-step innovation — the fastest to adapt.`} source="log(A) on log(B)" />
        </div>
        <div style={{ display: 'flex', gap: 5 }}>
          {([['ols', 'OLS'], ['roll', 'ROLL'], ['kalman', 'KALMAN']] as [string, string][]).map(([k, l]) => (
            <button key={k} onClick={() => { setHedge(k); if (m.data) setTimeout(run, 0) }} style={seg(hedge === k)}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ ...railSection, padding: '12px 12px 13px' }}>
        <div style={{ ...LABEL, marginBottom: 7 }}>Window</div>
        <div style={{ display: 'flex', gap: 5 }}>
          {([['1Y', 365], ['2Y', 730], ['3Y', 1095], ['5Y', 1826], ['10Y', 3653]] as [string, number][]).map(([l, d]) => (
            <button key={d} onClick={() => setLookback(d)} style={seg(lookback === d)}>{l}</button>
          ))}
        </div>
      </div>

      <div style={{ ...railSection, padding: '12px 12px 13px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
          {([['Entry z', entryZ, setEntryZ], ['Exit z', exitZ, setExitZ], ['Z win', zWindow, setZWindow]] as [string, string, (v: string) => void][]).map(([l, v, set]) => (
            <div key={l}><div style={{ ...LABEL, fontSize: 9, marginBottom: 4 }}>{l}</div><input value={v} onChange={e => set(e.target.value)} style={{ ...INPUT, padding: '6px 6px' }} /></div>
          ))}
        </div>
        <div style={{ marginTop: 9 }}>
          <div style={{ ...LABEL, fontSize: 9, marginBottom: 4 }}>Costs</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, ...INPUT, padding: '0 8px' }}>
            <input value={costs} onChange={e => setCosts(e.target.value)} style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: T.text, fontFamily: MONO, fontSize: 12, padding: '6px 0' }} />
            <span style={{ fontFamily: MONO, fontSize: 9, color: T.textDim }}>bps / leg</span>
          </div>
        </div>
      </div>

      <div style={{ padding: '13px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <button onClick={run} disabled={m.isPending} style={{ textAlign: 'center', fontFamily: MONO, fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.gold, border: `1px solid ${T.gold}`, background: mix(T.gold, 8), padding: '9px 8px', cursor: m.isPending ? 'wait' : 'pointer' }}>{m.isPending ? 'Testing' : 'Test Pair'}</button>
        <div style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, lineHeight: 1.5 }}>Hover any ⓘ for what a metric means.</div>
      </div>
    </div>
  )

  return (
    <PageWrapper title="Pairs Trader">
      <SidebarLayout sidebar={rail} sidebarTitle="Pair">
        {m.isPending ? <LoadingState label="Testing cointegration and backtesting the spread" />
          : m.error ? <ErrorState title="Pair analysis failed" message={(m.error as any)?.response?.data?.detail || 'This pair could not be analysed. Check both tickers have history over the window.'} onRetry={run} />
          : m.data ? <Cockpit d={m.data} />
          : <EmptyState title="Pairs Trader" hint="Enter a pair or pick a preset to test cointegration, mean reversion and z-score entries."
            keys={['Cointegration', 'Half-life', 'Z-score backtest']} action="Test Pair" />}
      </SidebarLayout>
    </PageWrapper>
  )
}

const HEDGE_LABEL: Record<string, string> = { ols: 'OLS', roll: 'ROLL', kalman: 'KALMAN' }
const HEDGE_DESC: Record<string, string> = { ols: 'OLS · full window', roll: 'ROLL · trailing β', kalman: 'KALMAN · filtered β' }
const HEDGE_TIP: Record<string, string> = {
  ols: 'from a single OLS fit over the whole window',
  roll: 'the latest value of a β that refits on a trailing window',
  kalman: 'the latest filtered β from a Kalman random-walk fit',
}

function Cockpit({ d }: { d: Resp }) {
  const z = d.zscore
  const hm = d.hedge_method
  const weeks = d.half_life_days != null ? Math.round(d.half_life_days / 5) : null

  useReportCapture(() => {
    const pair = `${d.a}/${d.b}`
    const pieces: ClipDraft[] = [
      kpiClip('Pairs Trader', `Pairs · ${pair}`, [
        { label: 'Correlation', value: d.correlation != null ? d.correlation.toFixed(2) : '—' },
        { label: 'Cointegration', value: d.adf.stationary ? 'Yes' : 'Weak' },
        { label: 'Half-life', value: d.half_life_days != null ? `${d.half_life_days}d` : '—' },
        { label: 'Hedge β', value: d.hedge_ratio.toFixed(2) },
        { label: 'Current z', value: z.current != null ? z.current.toFixed(2) : '—' },
        { label: 'Sharpe', value: d.backtest.sharpe != null ? d.backtest.sharpe.toFixed(2) : '—' },
      ]),
      kpiClip('Pairs Trader', `Backtest · ${pair}`, [
        { label: 'Spread return', value: `${signed(d.backtest.total_spread_return * 100, 1)}%` },
        { label: 'Trades', value: String(d.backtest.trades) },
        { label: 'Win rate', value: d.backtest.win_rate != null ? `${(d.backtest.win_rate * 100).toFixed(0)}%` : '—' },
        { label: 'Exposure', value: `${d.backtest.exposure_pct}%` },
        { label: 'Signal', value: SIG[d.signal] },
      ]),
    ]
    if (d.series.length) {
      const step = Math.max(1, Math.ceil(d.series.length / 80))
      const sampled = d.series.filter((_, i) => i % step === 0 || i === d.series.length - 1)
      pieces.push(chartClip(
        'Pairs Trader',
        `Spread Z-Score · ${pair}`,
        'line',
        'date',
        sampled.map(p => ({ date: p.date, z: p.z })),
        [{ key: 'z', label: 'z-score' }],
      ))
    }
    if (d.equity.length) {
      const step = Math.max(1, Math.ceil(d.equity.length / 80))
      const sampled = d.equity.filter((_, i) => i % step === 0 || i === d.equity.length - 1)
      pieces.push(chartClip(
        'Pairs Trader',
        `Spread P&L · ${pair}`,
        'area',
        'date',
        sampled.map(p => ({ date: p.date, v: p.v })),
        [{ key: 'v', label: 'P&L %' }],
      ))
    }
    if (d.trades.length) {
      pieces.push(tableClip(
        'Pairs Trader',
        `Trade Log · ${pair}`,
        ['#', 'Entered', 'Side', 'Z In', 'Exited', 'Z Out', 'Days', 'P&L %'],
        d.trades.slice(0, 20).map(t => [
          t.n, t.entered, t.side, t.z_in, t.exited ?? 'open', t.z_out ?? '—', t.days,
          `${signed(t.pnl * 100, 2)}%`,
        ]),
      ))
    }
    pieces.push(textClip('Pairs Trader', `Signal · ${pair}`,
      `z = ${z.current} · ${SIG[d.signal]} · entry ±${z.entry} · exit ±${z.exit} · hedge ${HEDGE_LABEL[hm] ?? hm} β ${d.hedge_ratio.toFixed(2)}`))
    return pieces
  }, { disabled: !d.a || !d.b, sourceTab: 'Pairs Trader' })

  const kpis = [
    { label: 'Correlation', value: d.correlation != null ? d.correlation.toFixed(2) : '—', vc: T.text, sub: 'daily log returns',
      tip: { title: 'Return correlation', body: `How tightly ${d.a} and ${d.b} move day to day. At ${d.correlation?.toFixed(2)} they share most of their direction — enough co-movement to run a spread, though correlation alone does not guarantee it mean-reverts.`, source: 'Pearson r of daily log returns' } },
    { label: 'Cointegration', value: d.adf.stationary ? 'Yes' : 'Weak', vc: d.adf.stationary ? T.pos : T.gold, sub: `ADF ${d.adf.stat} vs ${d.adf.crit_5}`,
      tip: { title: 'Cointegration (ADF)', body: `Whether the spread is statistically mean-reverting. ADF ${d.adf.stat} against the ${d.adf.crit_5} 5% critical: ${d.adf.stationary ? 'below it, so the spread is stationary — a tradeable pair.' : 'above it, so the mean-reversion is weak. Size down or shorten the window.'}`, source: 'Augmented Dickey-Fuller on the fitted spread' } },
    { label: 'Half-life', value: d.half_life_days != null ? `${d.half_life_days}d` : '—', vc: T.text, sub: 'mean reversion',
      tip: { title: 'Mean-reversion half-life', body: `How long the spread typically takes to close half its gap back to the mean. ${d.half_life_days} days ≈ ${weeks} trading weeks — trades here are multi-week holds, so the ${z.window}-day z window fits.`, source: 'From the OU fit of the spread' } },
    { label: 'Hedge ratio', value: `β ${d.hedge_ratio.toFixed(2)}`, vc: T.text, sub: HEDGE_DESC[hm] ?? hm,
      tip: { title: 'Hedge ratio', body: `${d.hedge_ratio.toFixed(2)} units of ${d.b} shorted per 1 unit of ${d.a}, ${HEDGE_TIP[hm] ?? ''}. Sizing the short leg at β keeps the pair dollar-balanced so only the spread is exposed.`, source: `${HEDGE_LABEL[hm] ?? hm} on log prices` } },
    { label: 'Current z', value: z.current != null ? z.current.toFixed(2) : '—', vc: z.current != null && Math.abs(z.current) >= z.entry ? T.gold : T.text, sub: SIG[d.signal].toLowerCase(),
      tip: { title: 'Current z-score', body: `How many rolling standard deviations the spread sits from its ${z.window}-day mean. At ${z.current}, it is ${Math.abs(z.current ?? 0) >= z.entry ? 'past' : 'inside'} the ±${z.entry} band — ${d.signal === 'flat' ? 'no entry right now.' : `a ${d.signal.replace('_', '-')} signal.`}`, source: `Rolling ${z.window}-day z-score` } },
    { label: 'Sharpe', value: d.backtest.sharpe != null ? d.backtest.sharpe.toFixed(2) : '—', vc: (d.backtest.sharpe ?? 0) > 0 ? T.pos : T.neg, sub: `${d.backtest.trades} trades · net of costs`,
      tip: { title: 'Backtest Sharpe', body: `Risk-adjusted return of the z-score backtest, net of ${d.costs_bps} bps per leg. ${d.backtest.sharpe}: ${(d.backtest.sharpe ?? 0) > 0 ? 'a positive historical edge' : 'no historical edge'} across ${d.backtest.trades} closed round-trips.`, source: 'Backtest, net of costs' } },
  ]

  // Merge markers onto the z-series for the scatter overlay.
  const zData = useMemo(() => {
    const byDate = new Map(d.series.map(p => [p.date, { ...p } as any]))
    for (const p of d.series) byDate.set(p.date, { ...p })
    for (const mk of d.markers) {
      const row = byDate.get(mk.date) ?? { date: mk.date, z: mk.z }
      if (mk.kind === 'exit') row.mExit = mk.z
      else if (mk.side === 'long') row.mLong = mk.z
      else row.mShort = mk.z
      byDate.set(mk.date, row)
    }
    return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date))
  }, [d])

  const triUp = (p: any) => p.cx == null || p.payload?.mLong == null ? <g /> : <path d={`M${p.cx} ${p.cy - 5} L${p.cx - 5} ${p.cy + 4} L${p.cx + 5} ${p.cy + 4} Z`} fill={T.pos} />
  const triDown = (p: any) => p.cx == null || p.payload?.mShort == null ? <g /> : <path d={`M${p.cx} ${p.cy + 5} L${p.cx - 5} ${p.cy - 4} L${p.cx + 5} ${p.cy - 4} Z`} fill={T.neg} />
  const sq = (p: any) => p.cx == null || p.payload?.mExit == null ? <g /> : <rect x={p.cx - 3.5} y={p.cy - 3.5} width={7} height={7} fill="none" stroke={mix(T.text, 60)} strokeWidth={1.4} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <KpiStrip cells={kpis} />

      {/* Z-score chart */}
      <Panel label="Spread Z-Score · Trades Marked" meta={`${z.window}-day z window · ${d.observations} closes · ${HEDGE_LABEL[hm] ?? hm} hedge β ${d.hedge_ratio.toFixed(2)}`} style={{ padding: '30px 12px 8px' }}>
        <div style={{ height: 236 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={zData} margin={{ top: 6, right: 10, bottom: 0, left: -20 }}>
              <CartesianGrid stroke={T.borderFaint} vertical={false} />
              <XAxis dataKey="date" tick={TICK} minTickGap={70} axisLine={{ stroke: T.border }} tickLine={false} />
              <YAxis tick={TICK} domain={[-4, 4]} axisLine={false} tickLine={false} width={40} />
              <Tooltip contentStyle={{ ...TOOLTIP_STYLE, fontFamily: 'var(--theme-mono)', fontSize: 11 }} labelStyle={{ color: T.muted }} />
              <ReferenceLine y={0} stroke={mix(T.text, 12)} />
              <ReferenceLine y={z.entry} stroke={T.gold} strokeDasharray="6 5" />
              <ReferenceLine y={-z.entry} stroke={T.gold} strokeDasharray="6 5" />
              <ReferenceLine y={z.exit} stroke={mix(T.text, 9)} strokeDasharray="2 5" />
              <ReferenceLine y={-z.exit} stroke={mix(T.text, 9)} strokeDasharray="2 5" />
              <Line type="monotone" dataKey="z" stroke={T.blue} strokeWidth={1.5} dot={false} isAnimationActive={false} />
              <Scatter dataKey="mLong" shape={triUp} isAnimationActive={false} />
              <Scatter dataKey="mShort" shape={triDown} isAnimationActive={false} />
              <Scatter dataKey="mExit" shape={sq} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 7, paddingTop: 7, borderTop: `1px solid ${T.borderFaint}` }}>
          <Legend glyph={<svg width="10" height="9"><path d="M5 0 L0 9 L10 9 Z" fill={T.pos} /></svg>} label="long-spread entry" />
          <Legend glyph={<svg width="10" height="9"><path d="M5 9 L0 0 L10 0 Z" fill={T.neg} /></svg>} label="short-spread entry" />
          <Legend glyph={<svg width="9" height="9"><rect x="1" y="1" width="7" height="7" fill="none" stroke={mix(T.text, 60)} strokeWidth="1.4" /></svg>} label="exit" />
          <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 9, color: T.muted }}>gold dashes = entry band ±{z.entry} · faint = exit ±{z.exit}</span>
        </div>
      </Panel>

      {/* Legs + P&L */}
      <div style={{ display: 'flex', gap: 10 }}>
        <Panel label="Legs, Normalized" style={{ flex: 1.25, padding: '30px 14px 10px' }}
          meta={<span style={{ display: 'flex', gap: 12 }}><span style={{ color: T.blue }}>— {d.a} {signed(d.leg_return.a, 1)}%</span><span style={{ color: T.gold }}>— {d.b} {signed(d.leg_return.b, 1)}%</span></span>}>
          <div style={{ height: 118 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={d.legs} margin={{ top: 4, right: 6, bottom: 0, left: -26 }}>
                <ReferenceLine y={100} stroke={mix(T.text, 7)} />
                <XAxis dataKey="date" hide /><YAxis domain={['auto', 'auto']} hide />
                <Tooltip contentStyle={{ ...TOOLTIP_STYLE, fontFamily: 'var(--theme-mono)', fontSize: 11 }} labelStyle={{ color: T.muted }} />
                <Line type="monotone" dataKey="b" stroke={T.gold} strokeWidth={1.3} dot={false} isAnimationActive={false} name={d.b} />
                <Line type="monotone" dataKey="a" stroke={T.blue} strokeWidth={1.3} dot={false} isAnimationActive={false} name={d.a} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, marginTop: 5 }}>Both legs indexed to 100 at window start. Divergence is what the spread trades.</div>
        </Panel>
        <Panel label="Spread P&L, Cumulative" style={{ flex: 1, padding: '30px 14px 10px' }}
          meta={<span style={{ fontSize: 13, fontWeight: 700, color: chg(d.backtest.total_spread_return) }}>{signed(d.backtest.total_spread_return * 100, 1)}%</span>}>
          <div style={{ height: 118 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={d.equity} margin={{ top: 4, right: 6, bottom: 0, left: -26 }}>
                <ReferenceLine y={0} stroke={mix(T.text, 7)} />
                <XAxis dataKey="date" hide /><YAxis domain={['auto', 'auto']} hide />
                <Tooltip contentStyle={{ ...TOOLTIP_STYLE, fontFamily: 'var(--theme-mono)', fontSize: 11 }} labelStyle={{ color: T.muted }} />
                <Area type="stepAfter" dataKey="v" stroke={T.pos} strokeWidth={1.4} fill={mix(T.pos, 10)} isAnimationActive={false} name="P&L %" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, marginTop: 5 }}>Flat between trades. Steps are closed positions, net of {d.costs_bps} bps per leg.</div>
        </Panel>
      </div>

      {/* Trade log + signal */}
      <div style={{ display: 'flex', gap: 10 }}>
        <Panel label="Trade Log" style={{ flex: 1.55, padding: '32px 0 0', overflow: 'hidden' }} meta={`${d.backtest.trades} trades · ${d.backtest.wins} wins · ${(d.lookback_days / 365).toFixed(0)}Y`}>
          <TradeLog trades={d.trades} />
        </Panel>
        <Panel label="Signal & Suggested Legs" style={{ flex: 1, padding: '32px 14px 12px', display: 'flex', flexDirection: 'column', gap: 9, overflow: 'hidden' }}>
          <SignalPanel d={d} />
        </Panel>
      </div>
    </div>
  )
}

function Legend({ glyph, label }: { glyph: React.ReactNode; label: string }) {
  return <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontFamily: MONO, fontSize: 9, color: T.muted }}>{glyph}{label}</span>
}

const LOG_COLS = '30px 78px 58px 52px 78px 52px 48px 1fr'
function TradeLog({ trades }: { trades: Trade[] }) {
  const head = [['#', 'left'], ['ENTERED', 'left'], ['SIDE', 'left'], ['Z IN', 'right'], ['EXITED', 'left'], ['Z OUT', 'right'], ['DAYS', 'right'], ['P&L', 'right']] as [string, string][]
  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: LOG_COLS, padding: '0 12px' }}>
        {head.map(([t, ta]) => <div key={t} style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted, padding: '7px 4px', textAlign: ta as any, borderBottom: `1px solid ${T.border}` }}>{t}</div>)}
      </div>
      {trades.length === 0 && <div style={{ fontFamily: MONO, fontSize: 11, color: T.muted, padding: 14 }}>No closed trades in this window.</div>}
      {trades.map(r => (
        <div key={r.n} style={{ display: 'grid', gridTemplateColumns: LOG_COLS, padding: '0 12px', borderBottom: `1px solid ${mix(T.text, 4)}` }}>
          <Cell v={r.n} c={T.textDim} />
          <Cell v={r.entered} c={T.text} />
          <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', color: r.side === 'long' ? T.pos : T.neg, padding: '7px 4px' }}>{r.side.toUpperCase()}</div>
          <Cell v={r.z_in} c={T.muted} r />
          <Cell v={r.exited ?? 'open'} c={r.open ? T.gold : T.text} pl={12} />
          <Cell v={r.z_out ?? '—'} c={T.muted} r />
          <Cell v={r.days} c={T.muted} r />
          <div style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: chg(r.pnl), padding: '7px 4px', textAlign: 'right' }}>{signed(r.pnl * 100, 2)}%</div>
        </div>
      ))}
    </div>
  )
}
function Cell({ v, c, r, pl }: { v: any; c: string; r?: boolean; pl?: number }) {
  return <div style={{ fontFamily: MONO, fontSize: 10.5, color: c, padding: '7px 4px', paddingLeft: pl, textAlign: r ? 'right' : 'left' }}>{v}</div>
}

function SignalPanel({ d }: { d: Resp }) {
  const z = d.zscore
  const long = d.signal === 'long_spread', short = d.signal === 'short_spread', flat = d.signal === 'flat'
  const gross = 25000
  const dollarA = gross / (1 + d.hedge_ratio), dollarB = gross - dollarA
  const shA = Math.round(dollarA / d.last.a), shB = Math.round(dollarB / d.last.b)
  const copy = flat
    ? `The spread sits ${Math.abs(z.current ?? 0).toFixed(2)}σ ${(z.current ?? 0) < 0 ? 'below' : 'above'} its ${z.window}-day mean — inside the entry band, so no pair entry right now. A long-spread signal fires at z ≤ −${z.entry}: buy ${d.a}, sell ${d.b}. A short-spread fires at z ≥ +${z.entry}.`
    : long ? `z is ${z.current} — past −${z.entry}. Long-spread fires: buy ${d.a}, sell ${d.b}, and exit as z reverts inside ±${z.exit}.`
    : `z is ${z.current} — past +${z.entry}. Short-spread fires: sell ${d.a}, buy ${d.b}, and exit as z reverts inside ±${z.exit}.`
  const legs = [
    { side: short ? 'SHORT' : 'LONG', c: short ? T.neg : T.pos, t: d.a, sh: shA, usd: dollarA },
    { side: short ? 'LONG' : 'SHORT', c: short ? T.pos : T.neg, t: d.b, sh: shB, usd: dollarB },
  ]
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, color: T.text }}>z = {z.current}</span>
        <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', color: flat ? T.muted : T.gold, border: `1px solid ${flat ? mix(T.muted, 55) : T.gold}`, padding: '3px 8px' }}>{SIG[d.signal]}</span>
      </div>
      <div style={{ fontFamily: SANS, fontSize: 11, color: T.muted, lineHeight: 1.6 }}>{copy}</div>
      <div style={{ border: `1px solid ${T.border}`, marginTop: 2 }}>
        <div style={{ fontFamily: SANS, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: T.muted, padding: '6px 10px', borderBottom: `1px solid ${T.borderFaint}`, background: T.hover }}>At entry · per $25K gross · β-balanced</div>
        {legs.map(l => (
          <div key={l.t} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderBottom: `1px solid ${mix(T.text, 4)}` }}>
            <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.08em', color: l.c, width: 42 }}>{l.side}</span>
            <TickerLink ticker={l.t} style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: T.text }} />
            <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 11, color: T.text }}>{l.sh} sh</span>
            <span style={{ fontFamily: MONO, fontSize: 11, color: T.muted, width: 64, textAlign: 'right' }}>${l.usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
          </div>
        ))}
      </div>
      <div style={{ fontFamily: MONO, fontSize: 9, color: T.textDim, lineHeight: 1.5, marginTop: 'auto' }}>Fires when |z| ≥ {z.entry}. Sizes refresh at the entry print.</div>
    </>
  )
}
