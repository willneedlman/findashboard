import { useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import { Activity, GitBranch } from 'lucide-react'
import TickerInput from '../components/TickerInput'
import EmptyState from '../components/EmptyState'
import { loadCustomStrategies } from '../utils/customStrategies'
import { readPMBooks, type PMPortfolio } from '../lib/pmImport'
import {
  C, PERIODS, StatCard, inputStyle, selectStyle, railLabel,
  RailGroup, RunButton, ToolShell, ModeToggle, REG_MODES, ReturnsScatter, RollingBetaChart, type RegMode, ChartPanel } from './regressionShared'

type Source = 'portfolio' | 'algo'

interface ImportResult {
  source: string; y_name: string; benchmark: string; observations: number
  alpha: number; alpha_annualized: number; alpha_p: number
  beta: number; beta_p: number; r_squared: number; adj_r_squared: number
  scatter: { x: number[]; y: number[]; line: { x: number; y: number }[] }
  rolling_beta: { window: number; dates: string[]; beta: (number | null)[] }
}

// Weight a saved book's holdings by cost basis (shares x avgCost).
function weighted(book: PMPortfolio): { ticker: string; weight: number }[] {
  if (!book.holdings.length) return []
  const vals = book.holdings.map(h => h.shares * (h.avgCost || 1))
  const total = vals.reduce((s, v) => s + v, 0)
  if (total <= 0) return book.holdings.map(h => ({ ticker: h.ticker, weight: 1 }))
  return book.holdings.map((h, i) => ({ ticker: h.ticker, weight: vals[i] / total }))
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

  const books = useMemo(() => readPMBooks().filter(p => p.holdings.length), [])
  const [bookId, setBookId] = useState(books[0]?.id ?? '')
  const holdings = useMemo(() => {
    const book = books.find(b => b.id === bookId)
    return book ? weighted(book) : []
  }, [books, bookId])
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
          {books.length ? (
            <>
              <select value={bookId} onChange={e => setBookId(e.target.value)} style={selectStyle}>
                {books.map(b => <option key={b.id} value={b.id}>{b.name} ({b.holdings.length})</option>)}
              </select>
              <div style={{ fontSize: 9, color: C.muted, marginTop: 6, lineHeight: '14px' }}>
                Cost-weighted (shares × avg cost). Options and futures excluded.
              </div>
            </>
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
        <div style={{ color: 'var(--theme-text)', background: 'color-mix(in srgb, var(--theme-negative) 8%, transparent)', borderLeft: '2px solid var(--theme-negative)', padding: '10px 14px', marginBottom: 16, fontSize: 12 }}>
          {(mutation.error as any)?.response?.data?.detail ?? mutation.error.message}
        </div>
      )}

      {r && (
        <>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 14, lineHeight: '16px' }}>
            Realized daily returns of <span style={{ color: C.text }}>{r.y_name}</span> regressed on{' '}
            {r.benchmark} over {r.observations} trading days. Beta is market exposure. Alpha is the excess return the market does not explain.
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
            <div style={{ height: 6, background: C.surf, overflow: 'hidden' }}>
              <div style={{ width: `${r.r_squared * 100}%`, height: '100%', background: r2Color }} />
            </div>
          </div>

          <ChartPanel title={<><GitBranch size={14} /> Returns vs {r.benchmark}</>} style={{ marginBottom: 20 }}>
            <ReturnsScatter x={r.scatter.x} y={r.scatter.y} line={r.scatter.line} xLabel={r.benchmark} />
          </ChartPanel>

          <ChartPanel
            title={<><Activity size={14} /> Rolling beta</>}
            hint={`${r.rolling_beta.window}-day rolling beta, showing how market exposure drifted over time.`}>
            <RollingBetaChart data={roll} xKey="date" refValue={r.beta} refLabel="full-sample beta" />
          </ChartPanel>
        </>
      )}

      {!r && !mutation.isPending && (
        <EmptyState title="Imported Regression" hint="Select a portfolio or saved strategy, then regress its realized returns against the market." action="Regress vs Market" />
      )}
    </ToolShell>
  )
}
