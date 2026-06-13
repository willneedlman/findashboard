import { useState, Fragment } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import {
  ScatterChart, Scatter, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { TrendingUp, Download, Plus, X, BarChart2, LayoutGrid, GitCompare } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface RegressionRequest {
  y_ticker:      string
  x_tickers:    string[]
  period:        string
  model_type:    'linear' | 'polynomial'
  degree:        number
  use_returns:   boolean
  include_chart: boolean
}

interface RegressionResult {
  model_type:    string
  y_ticker:      string
  x_tickers:    string[]
  feature_names: string[]
  r_squared:     number
  adj_r_squared: number
  intercept:     number
  intercept_p:   number
  coefficients:  number[]
  std_errors:    number[]
  t_stats:       number[]
  p_values:      number[]
  f_statistic:   number | null
  observations:  number
  mse:           number
  sse:           number
  residuals:     number[]
  data: {
    dates:  string[]
    y:      number[]
    x:      number[]
    y_pred: number[]
  }
  chart_b64: string | null
}

interface CorrPair { a: string; b: string; value: number }
interface CorrelationResult {
  tickers:      string[]
  benchmark:    string | null
  period:       string
  use_returns:  boolean
  observations: number
  matrix:       { row: string; col: string; value: number }[]
  pairs:        CorrPair[]
  summary: {
    avg_abs_correlation: number
    strongest_pair:      CorrPair | null
    most_negative_pair:  CorrPair | null
  }
  betas:   { ticker: string; beta: number; r_squared: number }[] | null
  rolling: { pair: [string, string]; window: number; dates: string[]; corr: number[] } | null
  scatter: { pair: [string, string]; x: number[]; y: number[] } | null
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PERIODS  = ['1mo', '3mo', '6mo', '1y', '2y', '3y', '5y']

const C = {
  bg:      'var(--theme-bg)',
  surf:    'var(--theme-surface)',
  border:  'var(--theme-border)',
  gold:    'var(--theme-primary)',
  text:    'var(--theme-text, #d7e3fc)',
  muted:   'var(--theme-text-dim)',
  blue:    'var(--theme-tertiary)',
  green:   'var(--theme-positive)',
  red:     'var(--theme-negative)',
  purple:  '#bb9af7',
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div style={{
      background: C.surf, border: `1px solid ${C.border}`, borderRadius: 6,
      padding: '10px 14px', minWidth: 120,
    }}>
      <div style={{ color: C.muted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
      <div style={{ color: C.gold, fontSize: 18, fontWeight: 700, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ color: C.muted, fontSize: 10, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function PValBadge({ p }: { p: number }) {
  const sig = p < 0.001 ? '***' : p < 0.01 ? '**' : p < 0.05 ? '*' : p < 0.1 ? '.' : ''
  const color = p < 0.05 ? C.green : p < 0.1 ? C.gold : C.muted
  return (
    <span style={{ color, fontFamily: 'var(--theme-mono)', fontSize: 12 }}>
      {p.toExponential(2)}{sig && <span style={{ color: C.gold, marginLeft: 3 }}>{sig}</span>}
    </span>
  )
}

function CoefTable({ result }: { result: RegressionResult }) {
  const rows = [
    {
      name: '(Intercept)',
      coef: result.intercept,
      se:   result.std_errors[0] ?? null,
      t:    result.t_stats[0]   ?? null,
      p:    result.intercept_p,
    },
    ...result.feature_names.map((name, i) => ({
      name,
      coef: result.coefficients[i],
      se:   result.std_errors[i],
      t:    result.t_stats[i],
      p:    result.p_values[i],
    })),
  ]
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--theme-mono)' }}>
      <thead>
        <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.muted }}>
          {['Feature', 'Coef', 'Std Err', 't-stat', 'p-value'].map(h => (
            <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderBottom: `1px solid ${C.border}22` }}>
            <td style={{ padding: '6px 10px', color: C.blue }}>{r.name}</td>
            <td style={{ padding: '6px 10px', color: C.text }}>{r.coef?.toFixed(6)}</td>
            <td style={{ padding: '6px 10px', color: C.text }}>{r.se?.toFixed(6) ?? 'n/a'}</td>
            <td style={{ padding: '6px 10px', color: r.t && Math.abs(r.t) > 2 ? C.green : C.text }}>
              {r.t?.toFixed(3) ?? 'n/a'}
            </td>
            <td style={{ padding: '6px 10px' }}>{r.p != null ? <PValBadge p={r.p} /> : 'n/a'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function ScatterPlot({ result }: { result: RegressionResult }) {
  const { x, y, y_pred } = result.data
  const scatterData = x.map((xi, i) => ({ x: xi, y: y[i] }))
  const lineData = x
    .map((xi, i) => ({ x: xi, y: y_pred[i] }))
    .sort((a, b) => a.x - b.x)

  return (
    <ResponsiveContainer width="100%" height={300}>
      <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="x" type="number" name={result.x_tickers[0]}
          stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: result.x_tickers[0], fill: C.muted, fontSize: 11, position: 'insideBottom', offset: -10 }} />
        <YAxis dataKey="y" type="number" name={result.y_ticker}
          stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: result.y_ticker, fill: C.muted, fontSize: 11, angle: -90, position: 'insideLeft' }} />
        <Tooltip
          cursor={{ strokeDasharray: '3 3' }}
          contentStyle={{ background: C.surf, border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }}
          formatter={(v: number) => v.toFixed(4)}
        />
        <Scatter name="Data" data={scatterData} fill={C.blue} opacity={0.5} r={3} />
        <Scatter name="Fit" data={lineData} fill={C.gold} opacity={0.9} r={2}
          line={{ stroke: C.gold, strokeWidth: 2 }} shape={() => null as any} />
        <Legend verticalAlign="top" align="center" wrapperStyle={{ color: C.muted, fontSize: 11, paddingBottom: 10 }} />
      </ScatterChart>
    </ResponsiveContainer>
  )
}

function ResidualPlot({ result }: { result: RegressionResult }) {
  const data = result.data.y_pred.map((pred, i) => ({ x: pred, r: result.residuals[i] }))
  return (
    <ResponsiveContainer width="100%" height={240}>
      <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="x" type="number" name="Fitted"
          stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: 'Fitted values', fill: C.muted, fontSize: 11, position: 'insideBottom', offset: -5 }} />
        <YAxis dataKey="r" type="number" name="Residual"
          stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: 'Residuals', fill: C.muted, fontSize: 11, angle: -90, position: 'insideLeft' }} />
        <ReferenceLine y={0} stroke={C.gold} strokeDasharray="4 2" />
        <Tooltip
          contentStyle={{ background: C.surf, border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }}
          formatter={(v: number) => v.toFixed(4)}
        />
        <Scatter name="Residuals" data={data} fill={C.purple} opacity={0.5} r={3} />
      </ScatterChart>
    </ResponsiveContainer>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

function RegressionMode() {
  const [yTicker,    setYTicker]    = useState('SPY')
  const [xTickers,   setXTickers]   = useState<string[]>(['QQQ'])
  const [xInput,     setXInput]     = useState('')
  const [period,     setPeriod]     = useState('2y')
  const [modelType,  setModelType]  = useState<'linear' | 'polynomial'>('linear')
  const [degree,     setDegree]     = useState(2)
  const [useReturns, setUseReturns] = useState(true)
  const [activeTab,  setActiveTab]  = useState<'charts' | 'table'>('charts')

  const mutation = useMutation<RegressionResult, Error, RegressionRequest>({
    mutationFn: req => axios.post('/api/regression/analyze', req).then(r => r.data),
  })

  const run = () => {
    if (!yTicker || xTickers.length === 0) return
    mutation.mutate({
      y_ticker:      yTicker.toUpperCase(),
      x_tickers:    xTickers.map(t => t.toUpperCase()),
      period,
      model_type:    modelType,
      degree,
      use_returns:   useReturns,
      include_chart: true,
    })
  }

  const addX = () => {
    const t = xInput.trim().toUpperCase()
    if (t && !xTickers.includes(t)) setXTickers(prev => [...prev, t])
    setXInput('')
  }

  const r = mutation.data

  const r2Color = r ? (r.r_squared > 0.7 ? C.green : r.r_squared > 0.4 ? C.gold : C.red) : C.muted

  return (
    <>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20, alignItems: 'flex-end' }}>

        {/* Y ticker */}
        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>Y (DEPENDENT)</div>
          <input value={yTicker} onChange={e => setYTicker(e.target.value.toUpperCase())}
            style={inputStyle} placeholder="e.g. SPY" />
        </div>

        {/* X tickers */}
        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>X VARIABLES</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
            {xTickers.map(t => (
              <span key={t} style={{ background: `${C.blue}22`, border: `1px solid ${C.blue}55`,
                borderRadius: 4, padding: '2px 8px', fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
                {t}
                <X size={10} color={C.muted} style={{ cursor: 'pointer' }}
                  onClick={() => setXTickers(p => p.filter(x => x !== t))} />
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={xInput} onChange={e => setXInput(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && addX()}
              style={{ ...inputStyle, width: 100 }} placeholder="Add ticker" />
            <button onClick={addX} style={{ ...btnStyle, padding: '6px 10px' }}>
              <Plus size={14} />
            </button>
          </div>
        </div>

        {/* Period */}
        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>PERIOD</div>
          <select value={period} onChange={e => setPeriod(e.target.value)} style={selectStyle}>
            {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        {/* Model */}
        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>MODEL</div>
          <select value={modelType} onChange={e => setModelType(e.target.value as any)} style={selectStyle}>
            <option value="linear">Linear / OLS</option>
            <option value="polynomial">Polynomial</option>
          </select>
        </div>

        {modelType === 'polynomial' && (
          <div>
            <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>DEGREE</div>
            <input type="number" min={2} max={6} value={degree} onChange={e => setDegree(Number(e.target.value))}
              style={{ ...inputStyle, width: 60 }} />
          </div>
        )}

        {/* Returns toggle */}
        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>INPUT</div>
          <button onClick={() => setUseReturns(p => !p)} style={{
            ...btnStyle,
            background: useReturns ? `${C.blue}22` : C.surf,
            borderColor: useReturns ? C.blue : C.border,
          }}>
            {useReturns ? 'Log Returns' : 'Raw Prices'}
          </button>
        </div>

        <button onClick={run} disabled={mutation.isPending}
          style={{ ...btnStyle, background: C.gold, color: 'var(--theme-bg)', fontWeight: 700, padding: '8px 20px' }}>
          {mutation.isPending ? 'Running…' : 'Run Regression'}
        </button>
      </div>

      {/* Error */}
      {mutation.isError && (
        <div style={{ color: C.red, background: `${C.red}11`, border: `1px solid ${C.red}44`,
          borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 12 }}>
          {(mutation.error as any)?.response?.data?.detail ?? mutation.error.message}
        </div>
      )}

      {/* Results */}
      {r && (
        <>
          {/* Summary stats row */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <StatCard label="R²" value={r.r_squared.toFixed(4)} sub={`Adj R²: ${r.adj_r_squared.toFixed(4)}`} />
            <StatCard label="Observations" value={r.observations} />
            <StatCard label="F-Statistic" value={r.f_statistic?.toFixed(2) ?? 'n/a'} />
            <StatCard label="MSE" value={r.mse.toExponential(3)} />
            <StatCard label="Intercept" value={r.intercept.toFixed(6)} sub={`p = ${r.intercept_p.toExponential(2)}`} />
            {r.coefficients.map((c, i) => (
              <StatCard key={i} label={`β(${r.feature_names[i]})`}
                value={c.toFixed(6)} sub={`p = ${r.p_values[i].toExponential(2)}`} />
            ))}
          </div>

          {/* R² bar */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.muted, marginBottom: 4 }}>
              <span>R² fit quality</span>
              <span style={{ color: r2Color }}>
                {r.r_squared > 0.7 ? 'Strong' : r.r_squared > 0.4 ? 'Moderate' : 'Weak'} ({(r.r_squared * 100).toFixed(1)}%)
              </span>
            </div>
            <div style={{ height: 6, background: C.surf, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${r.r_squared * 100}%`, height: '100%', background: r2Color, borderRadius: 3 }} />
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: `1px solid ${C.border}` }}>
            {(['charts', 'table'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                padding: '8px 18px', fontSize: 12, background: 'none', border: 'none',
                cursor: 'pointer', fontFamily: 'inherit',
                color: activeTab === tab ? C.gold : C.muted,
                borderBottom: activeTab === tab ? `2px solid ${C.gold}` : '2px solid transparent',
                textTransform: 'uppercase', letterSpacing: 1,
              }}>{tab}</button>
            ))}

            {r.chart_b64 && (
              <button onClick={() => {
                const a = document.createElement('a')
                a.href = `data:image/png;base64,${r.chart_b64}`
                a.download = `regression_${r.y_ticker}_${r.x_tickers.join('_')}.png`
                a.click()
              }} style={{ ...btnStyle, marginLeft: 'auto', fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}>
                <Download size={12} /> PNG
              </button>
            )}
          </div>

          {activeTab === 'charts' && (
            <div style={{ display: 'grid', gap: 20 }}>
              <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
                <div style={{ color: C.gold, fontSize: 12, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <BarChart2 size={14} /> Scatter + Regression Line
                </div>
                <ScatterPlot result={r} />
              </div>
              <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
                <div style={{ color: C.gold, fontSize: 12, marginBottom: 12 }}>Residual Diagnostics</div>
                <ResidualPlot result={r} />
              </div>
            </div>
          )}

          {activeTab === 'table' && (
            <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, overflowX: 'auto' }}>
              <div style={{ color: C.gold, fontSize: 12, marginBottom: 12 }}>Coefficient Table</div>
              <CoefTable result={r} />
              <div style={{ marginTop: 10, fontSize: 10, color: C.muted }}>
                Significance: *** p&lt;0.001 &nbsp; ** p&lt;0.01 &nbsp; * p&lt;0.05 &nbsp; . p&lt;0.1
              </div>
            </div>
          )}
        </>
      )}

      {!r && !mutation.isPending && (
        <div style={{ textAlign: 'center', color: C.muted, padding: '60px 0', fontSize: 13 }}>
          Select tickers and click <span style={{ color: C.gold }}>Run Regression</span> to analyze.
        </div>
      )}
    </>
  )
}

// ── Correlation mode ────────────────────────────────────────────────────────────

// |r| → strength band + sign, the basis for every plain-English line.
function strength(v: number): { word: string; color: string } {
  const a = Math.abs(v)
  const word = a > 0.7 ? 'strong' : a > 0.4 ? 'moderate' : a > 0.2 ? 'weak' : 'little'
  const color = a > 0.7 ? (v > 0 ? C.green : C.red) : a > 0.4 ? C.gold : C.muted
  return { word, color }
}

function pairSentence(p: CorrPair): string {
  const { word } = strength(p.value)
  const dir = p.value >= 0 ? 'positive' : 'negative'
  if (Math.abs(p.value) <= 0.2)
    return `${p.a} and ${p.b} (${p.value.toFixed(2)}): little linear relationship. They move largely independently.`
  if (p.value >= 0.7)
    return `${p.a} and ${p.b} (+${p.value.toFixed(2)}): ${word} positive link. They move almost in lockstep, so holding both adds little diversification.`
  if (p.value <= -0.4)
    return `${p.a} and ${p.b} (${p.value.toFixed(2)}): ${word} negative link. They tend to move in opposite directions, a natural hedge.`
  return `${p.a} and ${p.b} (${p.value >= 0 ? '+' : ''}${p.value.toFixed(2)}): ${word} ${dir} relationship.`
}

// Divergent cell color: red for negative, green for positive, transparent near zero.
function corrCell(v: number): string {
  const pct = Math.round(Math.abs(v) * 70)
  const base = v >= 0 ? C.green : C.red
  return `color-mix(in srgb, ${base} ${pct}%, transparent)`
}

function CorrHeatmap({ result }: { result: CorrelationResult }) {
  const { tickers, matrix } = result
  const lookup = new Map(matrix.map(m => [`${m.row}|${m.col}`, m.value]))
  const cell = 'minmax(48px, 1fr)'
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `64px repeat(${tickers.length}, ${cell})`, gap: 2, minWidth: 'fit-content' }}>
        <div />
        {tickers.map(t => (
          <div key={t} style={{ color: C.muted, fontSize: 10, textAlign: 'center', padding: '4px 2px', fontWeight: 600 }}>{t}</div>
        ))}
        {tickers.map(rowT => (
          <Fragment key={rowT}>
            <div style={{ color: C.muted, fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', paddingRight: 6, fontWeight: 600 }}>{rowT}</div>
            {tickers.map(colT => {
              const v = lookup.get(`${rowT}|${colT}`) ?? 0
              return (
                <div key={colT} title={`${rowT} ↔ ${colT}: ${v.toFixed(4)}`}
                  style={{
                    background: rowT === colT ? `color-mix(in srgb, ${C.gold} 30%, transparent)` : corrCell(v),
                    color: C.text, fontSize: 11, fontFamily: 'var(--theme-mono)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    padding: '8px 2px', border: `1px solid ${C.border}`,
                  }}>
                  {v.toFixed(2)}
                </div>
              )
            })}
          </Fragment>
        ))}
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 10, color: C.muted }}>
        <span>−1</span>
        <div style={{ flex: 1, maxWidth: 240, height: 8, borderRadius: 2,
          background: `linear-gradient(to right, ${C.red}, transparent, ${C.green})`, border: `1px solid ${C.border}` }} />
        <span>+1</span>
        <span style={{ marginLeft: 12 }}>Red = move opposite · Green = move together</span>
      </div>
    </div>
  )
}

function RollingChart({ result }: { result: CorrelationResult }) {
  if (!result.rolling) return null
  const { pair, window, dates, corr } = result.rolling
  const data = dates.map((d, i) => ({ date: d, corr: corr[i] }))
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="date" stroke={C.muted} tick={{ fill: C.muted, fontSize: 9 }} minTickGap={48} />
        <YAxis domain={[-1, 1]} stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: `${window}-day corr`, fill: C.muted, fontSize: 11, angle: -90, position: 'insideLeft' }} />
        <ReferenceLine y={0} stroke={C.muted} strokeDasharray="4 2" />
        <Tooltip contentStyle={{ background: C.surf, border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }}
          formatter={(v: number) => v.toFixed(3)} />
        <Line type="monotone" dataKey="corr" name={`${pair[0]} ↔ ${pair[1]}`} stroke={C.gold} strokeWidth={2} dot={false} />
        <Legend wrapperStyle={{ color: C.muted, fontSize: 11 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}

function CorrScatter({ result }: { result: CorrelationResult }) {
  if (!result.scatter) return null
  const { pair, x, y } = result.scatter
  const data = x.map((xi, i) => ({ x: xi, y: y[i] }))
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="x" type="number" name={pair[0]} stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: pair[0], fill: C.muted, fontSize: 11, position: 'insideBottom', offset: -5 }} />
        <YAxis dataKey="y" type="number" name={pair[1]} stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: pair[1], fill: C.muted, fontSize: 11, angle: -90, position: 'insideLeft' }} />
        <Tooltip cursor={{ strokeDasharray: '3 3' }}
          contentStyle={{ background: C.surf, border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }}
          formatter={(v: number) => v.toFixed(4)} />
        <Scatter name={`${pair[0]} vs ${pair[1]}`} data={data} fill={C.blue} opacity={0.5} r={3} />
      </ScatterChart>
    </ResponsiveContainer>
  )
}

function CorrelationMode() {
  const [tickers,    setTickers]    = useState<string[]>(['SPY', 'QQQ', 'GLD', 'BTC-USD'])
  const [tInput,     setTInput]     = useState('')
  const [period,     setPeriod]     = useState('2y')
  const [useReturns, setUseReturns] = useState(true)
  const [benchmark,  setBenchmark]  = useState('SPY')
  const [rollWindow, setRollWindow] = useState(60)
  const [pairA,      setPairA]      = useState('')
  const [pairB,      setPairB]      = useState('')

  const mutation = useMutation<CorrelationResult, Error, void>({
    mutationFn: () => axios.post('/api/regression/correlation', {
      tickers,
      period,
      use_returns:    useReturns,
      benchmark:      benchmark.trim() || null,
      rolling_window: rollWindow,
      pair:           pairA && pairB && pairA !== pairB ? [pairA, pairB] : null,
    }).then(r => r.data),
  })

  const addT = () => {
    const t = tInput.trim().toUpperCase()
    if (t && !tickers.includes(t)) setTickers(prev => [...prev, t])
    setTInput('')
  }

  const r = mutation.data
  const avg = r?.summary.avg_abs_correlation ?? 0
  const divLabel = avg > 0.6 ? 'Highly correlated basket' : avg > 0.35 ? 'Moderately correlated' : 'Well diversified'
  const divColor = avg > 0.6 ? C.red : avg > 0.35 ? C.gold : C.green

  return (
    <>
      {/* Controls */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20, alignItems: 'flex-end' }}>
        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>ASSETS (stock / ETF / crypto / index)</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4, maxWidth: 420 }}>
            {tickers.map(t => (
              <span key={t} style={{ background: `${C.blue}22`, border: `1px solid ${C.blue}55`,
                borderRadius: 4, padding: '2px 8px', fontSize: 11, display: 'flex', gap: 4, alignItems: 'center' }}>
                {t}
                <X size={10} color={C.muted} style={{ cursor: 'pointer' }}
                  onClick={() => setTickers(p => p.filter(x => x !== t))} />
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={tInput} onChange={e => setTInput(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && addT()}
              style={{ ...inputStyle, width: 130 }} placeholder="Add e.g. BTC-USD" />
            <button onClick={addT} style={{ ...btnStyle, padding: '6px 10px' }}><Plus size={14} /></button>
          </div>
        </div>

        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>PERIOD</div>
          <select value={period} onChange={e => setPeriod(e.target.value)} style={selectStyle}>
            {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>BENCHMARK (β vs)</div>
          <input value={benchmark} onChange={e => setBenchmark(e.target.value.toUpperCase())}
            style={{ ...inputStyle, width: 90 }} placeholder="SPY" />
        </div>

        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>ROLLING WINDOW</div>
          <input type="number" min={5} max={252} value={rollWindow} onChange={e => setRollWindow(Number(e.target.value))}
            style={{ ...inputStyle, width: 70 }} />
        </div>

        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>FOCUS PAIR (rolling + scatter)</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <select value={pairA} onChange={e => setPairA(e.target.value)} style={selectStyle}>
              <option value="">auto</option>
              {tickers.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select value={pairB} onChange={e => setPairB(e.target.value)} style={selectStyle}>
              <option value="">auto</option>
              {tickers.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>

        <div>
          <div style={{ color: C.muted, fontSize: 10, marginBottom: 4 }}>INPUT</div>
          <button onClick={() => setUseReturns(p => !p)} style={{
            ...btnStyle, background: useReturns ? `${C.blue}22` : C.surf, borderColor: useReturns ? C.blue : C.border,
          }}>{useReturns ? 'Log Returns' : 'Raw Prices'}</button>
        </div>

        <button onClick={() => tickers.length >= 2 && mutation.mutate()} disabled={mutation.isPending}
          style={{ ...btnStyle, background: C.gold, color: 'var(--theme-bg)', fontWeight: 700, padding: '8px 20px' }}>
          {mutation.isPending ? 'Running…' : 'Run Correlation'}
        </button>
      </div>

      {mutation.isError && (
        <div style={{ color: C.red, background: `${C.red}11`, border: `1px solid ${C.red}44`,
          borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 12 }}>
          {(mutation.error as any)?.response?.data?.detail ?? mutation.error.message}
        </div>
      )}

      {r && (
        <>
          {/* Summary cards */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Avg |correlation|" value={avg.toFixed(3)} sub={divLabel} />
            {r.summary.strongest_pair && (
              <StatCard label="Most correlated" value={`+${r.summary.strongest_pair.value.toFixed(2)}`}
                sub={`${r.summary.strongest_pair.a} ↔ ${r.summary.strongest_pair.b}`} />
            )}
            {r.summary.most_negative_pair && (
              <StatCard label="Most negative" value={r.summary.most_negative_pair.value.toFixed(2)}
                sub={`${r.summary.most_negative_pair.a} ↔ ${r.summary.most_negative_pair.b}`} />
            )}
            <StatCard label="Observations" value={r.observations} sub={`${r.period} · ${r.use_returns ? 'returns' : 'prices'}`} />
          </div>

          {/* Diversification interpretation */}
          <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderLeft: `3px solid ${divColor}`,
            borderRadius: 6, padding: '12px 16px', marginBottom: 20 }}>
            <div style={{ color: divColor, fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
              {divLabel} (avg |r| = {avg.toFixed(2)})
            </div>
            <div style={{ color: C.text, fontSize: 12, lineHeight: 1.6 }}>
              {avg > 0.6
                ? 'These assets mostly rise and fall together, so combining them gives limited diversification. In a drawdown they will tend to fall as one.'
                : avg > 0.35
                ? 'A mix of shared and independent movement. Some diversification benefit, but watch the strongly linked pairs below.'
                : 'Low average correlation: these assets move fairly independently, which is what you want for diversification.'}
            </div>
            <ul style={{ margin: '10px 0 0', paddingLeft: 18, color: C.muted, fontSize: 11, lineHeight: 1.7 }}>
              {r.summary.strongest_pair && <li>{pairSentence(r.summary.strongest_pair)}</li>}
              {r.summary.most_negative_pair && r.summary.most_negative_pair.value < 0 &&
                <li>{pairSentence(r.summary.most_negative_pair)}</li>}
            </ul>
          </div>

          {/* Heatmap */}
          <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ color: C.gold, fontSize: 12, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <LayoutGrid size={14} /> Correlation Matrix
            </div>
            <CorrHeatmap result={r} />
          </div>

          {/* Rolling + scatter for the focus pair */}
          {r.rolling && (
            <div style={{ display: 'grid', gap: 20, gridTemplateColumns: '1fr', marginBottom: 20 }}>
              <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
                <div style={{ color: C.gold, fontSize: 12, marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <TrendingUp size={14} /> Rolling Correlation: {r.rolling.pair[0]} ↔ {r.rolling.pair[1]}
                </div>
                <div style={{ color: C.muted, fontSize: 10, marginBottom: 12 }}>
                  How their {r.rolling.window}-day correlation drifts over time. Spikes toward +1 mean they are converging; dips show the link breaking down.
                </div>
                <RollingChart result={r} />
              </div>
              <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
                <div style={{ color: C.gold, fontSize: 12, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <BarChart2 size={14} /> Pairwise Scatter: {r.scatter?.pair[0]} vs {r.scatter?.pair[1]}
                </div>
                <CorrScatter result={r} />
              </div>
            </div>
          )}

          {/* Beta table */}
          {r.betas && (
            <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
              <div style={{ color: C.gold, fontSize: 12, marginBottom: 4 }}>Beta vs {r.benchmark}</div>
              <div style={{ color: C.muted, fontSize: 10, marginBottom: 12 }}>
                Beta &gt; 1 means the asset amplifies {r.benchmark} moves; &lt; 1 means it dampens them; negative means it moves opposite. R² is how much of the asset is explained by {r.benchmark}.
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--theme-mono)' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.muted }}>
                    {['Asset', 'Beta', 'R²', 'Reading'].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.betas.map(b => (
                    <tr key={b.ticker} style={{ borderBottom: `1px solid ${C.border}22` }}>
                      <td style={{ padding: '6px 10px', color: C.blue }}>{b.ticker}</td>
                      <td style={{ padding: '6px 10px', color: b.beta < 0 ? C.red : C.text }}>{b.beta.toFixed(3)}</td>
                      <td style={{ padding: '6px 10px', color: C.text }}>{b.r_squared.toFixed(3)}</td>
                      <td style={{ padding: '6px 10px', color: C.muted, fontSize: 11 }}>
                        {b.ticker === r.benchmark ? 'benchmark'
                          : b.r_squared < 0.2 ? 'largely independent (low R²)'
                          : b.beta < 0 ? 'moves opposite'
                          : b.beta > 1.2 ? 'amplifies' : b.beta < 0.8 ? 'dampens' : 'tracks closely'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {!r && !mutation.isPending && (
        <div style={{ textAlign: 'center', color: C.muted, padding: '60px 0', fontSize: 13 }}>
          Add 2+ assets and click <span style={{ color: C.gold }}>Run Correlation</span> to analyze.
        </div>
      )}
    </>
  )
}

// ── Page wrapper (mode switch) ───────────────────────────────────────────────────

export default function RegressionAnalysis() {
  const [mode, setMode] = useState<'regression' | 'correlation'>('correlation')
  return (
    <div style={{ padding: '24px 28px', color: C.text, fontFamily: 'var(--theme-mono)', minHeight: '100vh' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <TrendingUp size={20} color={C.gold} />
        <span style={{ fontSize: 18, fontWeight: 700, color: C.gold, letterSpacing: 1 }}>REGRESSION &amp; CORRELATION</span>
      </div>

      {/* Mode switch */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: `1px solid ${C.border}` }}>
        {([['correlation', 'Correlation', GitCompare], ['regression', 'Regression', BarChart2]] as const).map(([m, label, Icon]) => (
          <button key={m} onClick={() => setMode(m)} style={{
            padding: '8px 18px', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer',
            fontFamily: 'inherit', display: 'flex', gap: 7, alignItems: 'center',
            color: mode === m ? C.gold : C.muted,
            borderBottom: mode === m ? `2px solid ${C.gold}` : '2px solid transparent',
            textTransform: 'uppercase', letterSpacing: 1,
          }}><Icon size={14} /> {label}</button>
        ))}
      </div>

      {mode === 'correlation' ? <CorrelationMode /> : <RegressionMode />}
    </div>
  )
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 4,
  color: 'var(--theme-text, #d7e3fc)', padding: '6px 10px', fontSize: 12,
  fontFamily: 'var(--theme-mono)', width: 130, outline: 'none',
}

const selectStyle: React.CSSProperties = {
  ...inputStyle, width: 'auto', cursor: 'pointer',
}

const btnStyle: React.CSSProperties = {
  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 4,
  color: 'var(--theme-text, #d7e3fc)', padding: '6px 14px', fontSize: 12,
  fontFamily: 'var(--theme-mono)', cursor: 'pointer',
}
