import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { Activity } from 'lucide-react'
import {
  C, PERIODS, StatCard, inputStyle, selectStyle, RailGroup, RunButton, ToolShell, ModeToggle,
} from './regressionShared'

type Mode = 'ols' | 'mc'

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

function NumField({ label, value, onChange, step = 1, min, max }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number
}) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>{label}</div>
      <input type="number" value={value} step={step} min={min} max={max}
        onChange={e => onChange(Number(e.target.value))} style={inputStyle} />
    </div>
  )
}

export default function MonteCarloRegression({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
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
      <ModeToggle<Mode> value={mode} onChange={setMode}
        options={[{ id: 'ols', label: 'Asset OLS' }, { id: 'mc', label: 'Strategy MC' }]} />
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
        <NumField label="Daily premium (bps)" value={premiumBps} onChange={setPremiumBps} step={1} min={0} max={100} />
        <NumField label="Participation (beta)" value={participation} onChange={setParticipation} step={0.05} min={-2} max={2} />
        <NumField label="Short gamma (convexity)" value={shortGamma} onChange={setShortGamma} step={5} min={0} max={200} />
        <NumField label="Crash threshold (bps)" value={crashBps} onChange={setCrashBps} step={10} min={0} max={1000} />
        <NumField label="Idiosyncratic vol (bps)" value={idioBps} onChange={setIdioBps} step={5} min={0} max={200} />
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

          <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', marginBottom: 20 }}>
            <DistPanel title="Alpha distribution" tip="Annualized alpha per simulated path" fmt={v => pct(v * ANN)}
              values={d.per_path.alpha.map(a => a * ANN)} dist={scale(d.alpha, ANN)} />
            <DistPanel title="Beta distribution" tip={`Market beta vs ${r.benchmark} per path`} fmt={v => v.toFixed(2)}
              values={d.per_path.beta} dist={d.betas[0]} />
            <DistPanel title="R² distribution" tip="Model fit per path" fmt={v => v.toFixed(2)}
              values={d.per_path.r_squared} dist={d.r_squared} />
          </div>

          <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ color: C.gold, fontSize: 12, marginBottom: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Activity size={14} /> Rolling beta (sample path)
            </div>
            <div style={{ color: C.muted, fontSize: 10, marginBottom: 12 }}>
              {r.rolling_beta.window}-day rolling beta on one simulated future, showing intra-path regime drift.
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={roll} margin={{ top: 6, right: 16, left: 0, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="i" stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
                  label={{ value: 'trading day', fill: C.muted, fontSize: 11, position: 'insideBottom', offset: -8 }} />
                <YAxis stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }} domain={['auto', 'auto']} />
                <ReferenceLine y={d.betas[0].mean} stroke={C.gold} strokeDasharray="4 2"
                  label={{ value: 'mean beta', fill: C.gold, fontSize: 10, position: 'right' }} />
                <Tooltip contentStyle={{ background: C.surf, border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }} formatter={(v: number) => v.toFixed(3)} />
                <Line type="monotone" dataKey="beta" stroke={C.blue} strokeWidth={1.6} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 16px', fontSize: 11, color: C.muted, fontFamily: 'var(--theme-mono)' }}>
            <span style={{ color: C.text }}>Pooled OLS</span> (all paths stacked):
            {' '}alpha {pct(r.pooled.alpha * ANN)} (p {r.pooled.alpha_p.toExponential(1)}) ·
            {' '}beta {r.pooled.beta.toFixed(3)} · R² {r.pooled.r_squared.toFixed(3)}
          </div>
        </>
      )}

      {!r && !mutation.isPending && (
        <div style={{ textAlign: 'center', color: C.muted, padding: '60px 24px', fontSize: 13, border: `1px dashed ${C.border}` }}>
          Set a benchmark and strategy parameters, then click <span style={{ color: C.gold }}>Run Simulation</span> to see the
          alpha, beta and R² distributions across {nSims.toLocaleString()} simulated futures.
        </div>
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
