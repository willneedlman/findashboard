import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import { Activity, GitBranch } from 'lucide-react'
import TickerInput from '../components/TickerInput'
import EmptyState from '../components/EmptyState'
import { loadCustomStrategies } from '../utils/customStrategies'
import {
  C, PERIODS, StatCard, inputStyle, selectStyle, railLabel,
  RailGroup, RunButton, ToolShell, ModeToggle, REG_MODES, ReturnsScatter, RollingBetaChart, type RegMode,
} from './regressionShared'

type Source = 'portfolio' | 'algo'

interface ImportResult {
  source: string; y_name: string; benchmark: string; observations: number
  alpha: number; alpha_annualized: number; alpha_p: number
  beta: number; beta_p: number; r_squared: number; adj_r_squared: number
  scatter: { x: number[]; y: number[]; line: { x: number; y: number }[] }
  rolling_beta: { window: number; dates: string[]; beta: (number | null)[] }
}

interface PMHolding { ticker: string; shares: number; avgCost: number }

// The Portfolio Manager persists a single holdings book here; weight each name by
// cost basis (shares x avgCost) exactly as the Stress Tester import does.
function loadPortfolio(): { ticker: string; weight: number }[] {
  try {
    const pm: PMHolding[] = JSON.parse(localStorage.getItem('ft-portfolio-manager') || '[]')
    if (!Array.isArray(pm) || !pm.length) return []
    const vals = pm.map(h => h.shares * (h.avgCost || 1))
    const total = vals.reduce((s, v) => s + v, 0)
    if (total <= 0) return pm.map(h => ({ ticker: h.ticker, weight: 1 }))
    return pm.map((h, i) => ({ ticker: h.ticker, weight: vals[i] / total }))
  } catch { return [] }
}

const pctp = (v: number) => `${(v * 100).toFixed(1)}%`

function SourceToggle({ value, onChange }: { value: Source; onChange: (s: Source) => void }) {
  return (
    <div style={{ padding: '14px 16px', borderBottom: `1px solid ${C.border}` }}>
      <label style={railLabel}>Source</label>
      <div style={{ display: 'flex', border: `1px solid ${C.border}` }}>
        {(['portfolio', 'algo'] as const).map(s => {
          const on = value === s
          return (
            <button key={s} onClick={() => onChange(s)} style={{
              flex: 1, padding: '7px 4px', fontSize: 10, fontFamily: 'var(--theme-sans)', fontWeight: 700,
              letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer', border: 'none',
              background: on ? C.gold : 'transparent', color: on ? C.bg : C.muted,
            }}>{s === 'portfolio' ? 'Portfolio' : 'Algo'}</button>
          )
        })}
      </div>
    </div>
  )
}

export default function ImportRegression({ mode, setMode }: { mode: RegMode; setMode: (m: RegMode) => void }) {
  const [source, setSource] = useState<Source>('portfolio')
  const [benchmark, setBenchmark] = useState('SPY')
  const [period, setPeriod] = useState('2y')
  const [rollWindow, setRollWindow] = useState(60)

  const holdings = useMemo(loadPortfolio, [])
  const strategies = useMemo(loadCustomStrategies, [])
  const [algoName, setAlgoName] = useState(strategies[0]?.name ?? '')
  const [algoTicker, setAlgoTicker] = useState('AAPL')
  const [start, setStart] = useState('2022-01-01')
  const [end, setEnd] = useState('')
  const activeDef = strategies.find(s => s.name === algoName) ?? null

  const mutation = useMutation<ImportResult, Error, void>({
    mutationFn: () => {
      const body = source === 'portfolio'
        ? { source, benchmark: benchmark.toUpperCase(), period, rolling_window: rollWindow, holdings }
        : {
            source, benchmark: benchmark.toUpperCase(), rolling_window: rollWindow,
            ticker: algoTicker.toUpperCase(),
            rules: activeDef ? { buy: activeDef.buy, sell: activeDef.sell } : {},
            start, end: end || undefined,
          }
      return axios.post('/api/regression/import', body).then(r => r.data)
    },
  })
  const r = mutation.data
  const canRun = !!benchmark && (source === 'portfolio' ? holdings.length > 0 : !!activeDef && !!algoTicker)
  const roll = r ? r.rolling_beta.dates.map((dt, i) => ({ i, date: dt, beta: r.rolling_beta.beta[i] })) : []

  const rail = (
    <>
      <ModeToggle<RegMode> value={mode} onChange={setMode} options={REG_MODES} />
      <SourceToggle value={source} onChange={setSource} />

      {source === 'portfolio' ? (
        <RailGroup label="Portfolio">
          {holdings.length ? (
            <div style={{ fontSize: 11, color: C.text, fontFamily: 'var(--theme-mono)', lineHeight: '16px' }}>
              {holdings.length} holdings, cost-weighted
              <div style={{ color: C.muted, fontSize: 10, marginTop: 4 }}>
                {holdings.slice(0, 6).map(h => h.ticker).join(', ')}{holdings.length > 6 ? '...' : ''}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 10, color: C.muted, lineHeight: '15px' }}>
              No saved portfolio. Add holdings in the Portfolio Manager first.
            </div>
          )}
        </RailGroup>
      ) : (
        <>
          <RailGroup label="Saved strategy">
            {strategies.length ? (
              <select value={algoName} onChange={e => setAlgoName(e.target.value)} style={selectStyle}>
                {strategies.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
              </select>
            ) : (
              <div style={{ fontSize: 10, color: C.muted, lineHeight: '15px' }}>
                No saved strategies. Build one in the Algo Strategy Builder first.
              </div>
            )}
          </RailGroup>
          <RailGroup label="Backtest on">
            <TickerInput value={algoTicker} onChange={setAlgoTicker} onEnter={() => canRun && mutation.mutate()} style={inputStyle} placeholder="Ticker" />
            {/* Native date inputs have a wide intrinsic min-width, so two never fit
                side by side in the rail; stack them full-width. */}
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 9, color: C.muted, marginBottom: 2 }}>Start</div>
              <input type="date" value={start} onChange={e => setStart(e.target.value)} style={{ ...inputStyle, fontSize: 11 }} />
            </div>
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 9, color: C.muted, marginBottom: 2 }}>End (optional)</div>
              <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={{ ...inputStyle, fontSize: 11 }} />
            </div>
          </RailGroup>
        </>
      )}

      <RailGroup label="Benchmark (X)">
        <input value={benchmark} onChange={e => setBenchmark(e.target.value.toUpperCase())} style={inputStyle} placeholder="e.g. SPY" />
      </RailGroup>
      {source === 'portfolio' && (
        <RailGroup label="Period">
          <select value={period} onChange={e => setPeriod(e.target.value)} style={selectStyle}>
            {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </RailGroup>
      )}
      <RailGroup label="Rolling window (days)">
        <input type="number" value={rollWindow} min={10} max={252} step={5}
          onChange={e => setRollWindow(Math.max(10, Math.min(252, Number(e.target.value) || 60)))} style={inputStyle} />
      </RailGroup>
      <RunButton onClick={() => mutation.mutate()} disabled={!canRun} busy={mutation.isPending} label="Regress vs Market" />
    </>
  )

  const r2Color = r ? (r.r_squared > 0.7 ? C.green : r.r_squared > 0.4 ? C.gold : C.red) : C.muted

  return (
    <ToolShell title="Regression" rail={rail}>
      {mutation.isError && (
        <div style={{ color: C.red, background: `${C.red}11`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 12 }}>
          {(mutation.error as any)?.response?.data?.detail ?? mutation.error.message}
        </div>
      )}

      {r && (
        <>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 14, lineHeight: '16px' }}>
            Realized daily returns of <span style={{ color: C.text }}>{r.y_name}</span> regressed on{' '}
            {r.benchmark} over {r.observations} trading days. Beta is market exposure; alpha is the excess return the market does not explain.
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <StatCard label="Beta" value={r.beta.toFixed(3)} sub={`p = ${r.beta_p.toExponential(1)}`}
              tip={`Market sensitivity: ${r.y_name} moves this much per 1% move in ${r.benchmark}. Above 1 is more volatile than the market, below 1 is less.`} />
            <StatCard label="Alpha (ann)" value={pctp(r.alpha_annualized)} sub={`p = ${r.alpha_p.toExponential(1)}`}
              tip="Annualized excess return not explained by market exposure. A p-value below 0.05 means it is statistically distinguishable from zero." />
            <StatCard label="R²" value={r.r_squared.toFixed(3)} sub={`Adj ${r.adj_r_squared.toFixed(3)}`}
              tip={`Share of ${r.y_name}'s variance the market explains. The rest is idiosyncratic (stock-picking or strategy-specific) risk.`} />
            <StatCard label="Observations" value={r.observations} tip="Overlapping daily returns used in the regression." />
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.muted, marginBottom: 4 }}>
              <span>Market explains</span>
              <span style={{ color: r2Color }}>{(r.r_squared * 100).toFixed(1)}%</span>
            </div>
            <div style={{ height: 6, background: C.surf, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${r.r_squared * 100}%`, height: '100%', background: r2Color, borderRadius: 3 }} />
            </div>
          </div>

          <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ color: C.gold, fontSize: 12, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <GitBranch size={14} /> Returns vs {r.benchmark}
            </div>
            <ReturnsScatter x={r.scatter.x} y={r.scatter.y} line={r.scatter.line} xLabel={r.benchmark} />
          </div>

          <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
            <div style={{ color: C.gold, fontSize: 12, marginBottom: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Activity size={14} /> Rolling beta
            </div>
            <div style={{ color: C.muted, fontSize: 10, marginBottom: 12 }}>
              {r.rolling_beta.window}-day rolling beta, showing how market exposure drifted over time.
            </div>
            <RollingBetaChart data={roll} xKey="date" refValue={r.beta} refLabel="full-sample beta" />
          </div>
        </>
      )}

      {!r && !mutation.isPending && (
        <EmptyState title="Imported Regression" hint="Select a portfolio or saved strategy, then regress its realized returns against the market."
          kpis={['Beta', 'Alpha', 'R²', 'Observations']}
          preview="chart" previewLabel="Returns vs Market" action="Regress vs Market" />
      )}
    </ToolShell>
  )
}
