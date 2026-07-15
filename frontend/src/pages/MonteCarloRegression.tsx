import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import { Activity, GitBranch } from 'lucide-react'
import HelpTip from '../components/HelpTip'
import EmptyState from '../components/EmptyState'
import {
  C, PERIODS, StatCard, inputStyle, selectStyle, RailGroup, RunButton, ToolShell,
  ModeToggle, REG_MODES, ReturnsScatter, RollingBetaChart, type RegMode,
} from './regressionShared'

interface Dist {
  mean: number; std: number; min: number; p5: number; p25: number; p50: number
  p75: number; p95: number; max: number; prob_positive: number
}
interface MCResult {
  benchmark: string; n_sims: number; horizon_days: number
  calibration: { mu_annual: number; sigma_annual: number; observations: number }
  distributions: {
    n_failed: number; factor_names: string[]
    alpha: Dist; betas: Dist[]; r_squared: Dist
    per_path: { alpha: number[]; beta: number[]; r_squared: number[] }
  }
  pooled: { alpha: number; alpha_p: number; beta: number; r_squared: number }
  scatter: { x: number[]; y: number[]; line: { x: number; y: number }[] }
  rolling_beta: { window: number; end_idx: number[]; beta: number[]; alpha: number[] }
}

const ANN = 252
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`

// Lightweight SVG histogram: bins `values` and marks p5 / median / p95 as
// vertical rules positioned on the continuous value axis. preserveAspectRatio
// ="none" stretches only the x-axis (fine for bars and rule lines); text lives
// in HTML below so it never distorts.
function Histogram({ values, p5, p50, p95, color }: {
  values: number[]; p5: number; p50: number; p95: number; color: string
}) {
  if (!values.length) return null
  const W = 520, H = 132, pad = 6
  const min = Math.min(...values), max = Math.max(...values), span = (max - min) || 1
  const nb = 30, bw = span / nb
  const counts = new Array(nb).fill(0)
  for (const v of values) counts[Math.min(nb - 1, Math.max(0, Math.floor((v - min) / bw)))]++
  const cmax = Math.max(...counts) || 1
  const xOf = (v: number) => pad + ((v - min) / span) * (W - pad * 2)
  const barW = (W - pad * 2) / nb
  const markers: [string, number, boolean][] = [['p5', p5, false], ['p50', p50, true], ['p95', p95, false]]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: 'block' }}>
      {counts.map((c, i) => {
        const h = (c / cmax) * (H - 8)
        return <rect key={i} x={pad + i * barW + 0.5} y={H - h} width={Math.max(0.5, barW - 1)} height={h} fill={color} opacity={0.5} />
      })}
      {markers.map(([lbl, v, mid]) => (
        <line key={lbl} x1={xOf(v)} x2={xOf(v)} y1={4} y2={H}
          stroke={mid ? C.gold : C.muted} strokeWidth={mid ? 1.6 : 1} strokeDasharray={mid ? '' : '3 2'} />
      ))}
    </svg>
  )
}

function DistPanel({ title, tip, values, dist, fmt }: {
  title: string; tip: string; values: number[]; dist: Dist; fmt: (v: number) => string
}) {
  return (
    <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
      <div style={{ color: C.gold, fontSize: 12, marginBottom: 2 }}>{title}</div>
      <div style={{ color: C.muted, fontSize: 10, marginBottom: 10 }}>{tip}</div>
      <Histogram values={values} p5={dist.p5} p50={dist.p50} p95={dist.p95} color={C.blue} />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.muted, marginTop: 8, fontFamily: 'var(--theme-mono)' }}>
        <span>p5 {fmt(dist.p5)}</span>
        <span style={{ color: C.text }}>median {fmt(dist.p50)}</span>
        <span>p95 {fmt(dist.p95)}</span>
      </div>
    </div>
  )
}

function NumField({ label, value, onChange, step = 1, min, max, tip }: {
  label: string; value: number; onChange: (v: number) => void
  step?: number; min?: number; max?: number; tip?: string
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, color: C.muted, marginBottom: 3, display: 'flex', alignItems: 'center' }}>
        {label}{tip && <HelpTip text={tip} width={250} />}
      </div>
      <input type="number" value={value} step={step} min={min} max={max}
        onChange={e => onChange(Number(e.target.value))} style={inputStyle} />
    </div>
  )
}

export default function MonteCarloRegression({ mode, setMode }: { mode: RegMode; setMode: (m: RegMode) => void }) {
  const [benchmark, setBenchmark] = useState('SPY')
  const [period, setPeriod] = useState('2y')
  const [nSims, setNSims] = useState(1000)
  const [horizon, setHorizon] = useState(252)
  const [premiumBps, setPremiumBps] = useState(8)
  const [participation, setParticipation] = useState(0.45)
  const [shortGamma, setShortGamma] = useState(20)
  const [crashBps, setCrashBps] = useState(50)
  const [idioBps, setIdioBps] = useState(10)

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v) || lo))
  const mutation = useMutation<MCResult, Error, void>({
    mutationFn: () => axios.post('/api/regression/montecarlo', {
      benchmark: benchmark.toUpperCase(), period,
      n_sims: clamp(nSims, 50, 3000), horizon_days: clamp(horizon, 20, 1260),
      premium_bps: premiumBps, participation, short_gamma: shortGamma,
      crash_threshold_bps: crashBps, idio_bps: idioBps,
    }).then(r => r.data),
  })
  const r = mutation.data

  const rail = (
    <>
      <ModeToggle<RegMode> value={mode} onChange={setMode} options={REG_MODES} />
      <RailGroup label="Benchmark (X)">
        <input value={benchmark} onChange={e => setBenchmark(e.target.value.toUpperCase())} style={inputStyle} placeholder="e.g. SPY" />
      </RailGroup>
      <RailGroup label="Calibration period">
        <select value={period} onChange={e => setPeriod(e.target.value)} style={selectStyle}>
          {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </RailGroup>
      <RailGroup label="Simulation">
        <NumField label="Paths (N)" value={nSims} onChange={setNSims} step={100} min={50} max={3000} />
        <NumField label="Horizon (days)" value={horizon} onChange={setHorizon} step={21} min={20} max={1260} />
      </RailGroup>
      <RailGroup label="Options-selling strategy">
        <NumField label="Theta (premium/day, bps)" value={premiumBps} onChange={setPremiumBps} step={1} min={0} max={100}
          tip="Time-decay premium the book collects each day, in basis points. Selling options is being net-short optionality, so theta is the core edge and the source of alpha. 8 bps/day is roughly 20%/yr gross." />
        <NumField label="Delta (participation)" value={participation} onChange={setParticipation} step={0.05} min={-2} max={2}
          tip="Directional exposure to the benchmark: the intended beta. 0.45 means the book moves about 45% as much as the market on an ordinary day." />
        <NumField label="Gamma (short, convexity)" value={shortGamma} onChange={setShortGamma} step={5} min={0} max={200}
          tip="Negative gamma: losses accelerate (convex) once the market falls past the threshold. This is the tail cost of selling options, and it fattens the left tail and lifts realized beta on stressed paths." />
        <NumField label="Gamma threshold (bps)" value={crashBps} onChange={setCrashBps} step={10} min={0} max={1000}
          tip="The daily down-move past which the short-gamma convex loss kicks in. At 50 bps, moves worse than -0.5% start triggering accelerating losses." />
        <NumField label="Idiosyncratic vol (bps)" value={idioBps} onChange={setIdioBps} step={5} min={0} max={200}
          tip="Strategy-specific noise unrelated to the market (basis risk, execution, roll). It lowers R^2 without changing the underlying beta." />
      </RailGroup>
      <RunButton onClick={() => mutation.mutate()} disabled={!benchmark} busy={mutation.isPending} label="Run Simulation" />
    </>
  )

  const d = r?.distributions
  const roll = r ? r.rolling_beta.end_idx.map((e, i) => ({ i: e, beta: r.rolling_beta.beta[i] })) : []

  return (
    <ToolShell title="Regression" rail={rail}>
      {mutation.isError && (
        <div style={{ color: C.red, background: `${C.red}11`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 12 }}>
          {(mutation.error as any)?.response?.data?.detail ?? mutation.error.message}
        </div>
      )}

      {r && d && (
        <>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 14, lineHeight: '16px' }}>
            Options-selling strategy across {r.n_sims.toLocaleString()} Monte Carlo futures, each regressed against its own
            simulated {r.benchmark} path. The cards and distributions show how alpha, beta and R² vary across those futures.
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <StatCard label="Mean Alpha (ann)" value={pct(d.alpha.mean * ANN)} sub={`P(alpha>0) ${pct(d.alpha.prob_positive)}`}
              tip="Average annualized intercept across all simulated paths: the strategy's premium edge net of market exposure. P(alpha>0) is the share of futures with positive alpha." />
            <StatCard label="Mean Beta" value={d.betas[0].mean.toFixed(3)} sub={`p5 ${d.betas[0].p5.toFixed(2)} · p95 ${d.betas[0].p95.toFixed(2)}`}
              tip={`Average market sensitivity to ${r.benchmark}. A short-gamma book shows realized beta above its nominal delta, with a fatter right tail on stressed paths.`} />
            <StatCard label="Mean R²" value={d.r_squared.mean.toFixed(3)} sub={`p5 ${d.r_squared.p5.toFixed(2)}`}
              tip="Average share of the strategy's variance the market explains. Below 1 reflects idiosyncratic / non-linear (gamma) P&L the linear model misses." />
            <StatCard label="Calibration" value={`drift ${pct(r.calibration.mu_annual)}`} sub={`vol ${pct(r.calibration.sigma_annual)} · ${r.calibration.observations}d`}
              tip={`GBM drift and volatility estimated from ${r.calibration.observations} days of ${r.benchmark} history.`} />
            <StatCard label="Paths" value={r.n_sims} sub={`${r.horizon_days}d${d.n_failed ? ` · ${d.n_failed} dropped` : ''}`}
              tip="Number of Monte-Carlo futures regressed. Degenerate paths (zero-variance factor) are dropped." />
          </div>

          <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', marginBottom: 20 }}>
            <DistPanel title="Alpha distribution" tip="Annualized alpha per simulated path" fmt={v => pct(v * ANN)}
              values={d.per_path.alpha.map(a => a * ANN)} dist={scale(d.alpha, ANN)} />
            <DistPanel title="Beta distribution" tip={`Market beta vs ${r.benchmark} per path`} fmt={v => v.toFixed(2)}
              values={d.per_path.beta} dist={d.betas[0]} />
            <DistPanel title="R² distribution" tip="Model fit per path" fmt={v => v.toFixed(2)}
              values={d.per_path.r_squared} dist={d.r_squared} />
          </div>

          <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ color: C.gold, fontSize: 12, marginBottom: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
              <GitBranch size={14} /> Strategy returns vs {r.benchmark}
            </div>
            <div style={{ color: C.muted, fontSize: 10, marginBottom: 12 }}>
              Daily simulated strategy returns regressed on market returns (1,500-point sample). Line slope is beta, intercept is alpha. The short-gamma tail bends the cloud below the fit on big down days.
            </div>
            <ReturnsScatter x={r.scatter.x} y={r.scatter.y} line={r.scatter.line} xLabel={r.benchmark} />
          </div>

          <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ color: C.gold, fontSize: 12, marginBottom: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Activity size={14} /> Rolling beta (sample path)
            </div>
            <div style={{ color: C.muted, fontSize: 10, marginBottom: 12 }}>
              {r.rolling_beta.window}-day rolling beta on one simulated future, showing intra-path regime drift.
            </div>
            <RollingBetaChart data={roll} xKey="i" xLabel="trading day"
              refValue={d.betas[0].mean} refLabel="mean beta" />
          </div>

          <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 16px', fontSize: 11, color: C.muted, fontFamily: 'var(--theme-mono)' }}>
            <span style={{ color: C.text }}>Pooled OLS</span> (all paths stacked):
            {' '}alpha {pct(r.pooled.alpha * ANN)} (p {r.pooled.alpha_p.toExponential(1)}) ·
            {' '}beta {r.pooled.beta.toFixed(3)} · R² {r.pooled.r_squared.toFixed(3)}
          </div>
        </>
      )}

      {!r && !mutation.isPending && (
        <EmptyState title="Monte Carlo Regression" hint={`Set a benchmark and strategy parameters, then run ${nSims.toLocaleString()} simulated futures.`}
          kpis={['Mean Alpha', 'Mean Beta', 'Mean R²', 'Paths']}
          preview="chart" previewLabel="Alpha Distribution" action="Run Simulation" />
      )}
    </ToolShell>
  )
}

function scale(dist: Dist, f: number): Dist {
  return {
    ...dist, mean: dist.mean * f, std: dist.std * f, min: dist.min * f, max: dist.max * f,
    p5: dist.p5 * f, p25: dist.p25 * f, p50: dist.p50 * f, p75: dist.p75 * f, p95: dist.p95 * f,
  }
}
