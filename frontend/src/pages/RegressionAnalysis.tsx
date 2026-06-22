import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import {
  ScatterChart, Scatter, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { Download, Plus, BarChart2 } from 'lucide-react'
import {
  C, PERIODS, StatCard, inputStyle, selectStyle, btnStyle,
  RailGroup, RunButton, TickerTags, ToolShell,
} from './regressionShared'

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
  data: { dates: string[]; y: number[]; x: number[]; y_pred: number[] }
  chart_b64: string | null
}

// ── Sub-components ────────────────────────────────────────────────────────────

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
    { name: '(Intercept)', coef: result.intercept, se: result.std_errors[0] ?? null, t: result.t_stats[0] ?? null, p: result.intercept_p },
    ...result.feature_names.map((name, i) => ({ name, coef: result.coefficients[i], se: result.std_errors[i], t: result.t_stats[i], p: result.p_values[i] })),
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
            <td style={{ padding: '6px 10px', color: r.t && Math.abs(r.t) > 2 ? C.green : C.text }}>{r.t?.toFixed(3) ?? 'n/a'}</td>
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
  const lineData = x.map((xi, i) => ({ x: xi, y: y_pred[i] })).sort((a, b) => a.x - b.x)
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ScatterChart margin={{ top: 10, right: 20, left: 0, bottom: 24 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
        <XAxis dataKey="x" type="number" name={result.x_tickers[0]} stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: result.x_tickers[0], fill: C.muted, fontSize: 11, position: 'insideBottom', offset: -10 }} />
        <YAxis dataKey="y" type="number" name={result.y_ticker} stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: result.y_ticker, fill: C.muted, fontSize: 11, angle: -90, position: 'insideLeft' }} />
        <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ background: C.surf, border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }} formatter={(v: number) => v.toFixed(4)} />
        <Scatter name="Data" data={scatterData} fill={C.blue} opacity={0.5} r={3} />
        <Scatter name="Fit" data={lineData} fill={C.gold} opacity={0.9} r={2} line={{ stroke: C.gold, strokeWidth: 2 }} shape={() => null as any} />
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
        <XAxis dataKey="x" type="number" name="Fitted" stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: 'Fitted values', fill: C.muted, fontSize: 11, position: 'insideBottom', offset: -5 }} />
        <YAxis dataKey="r" type="number" name="Residual" stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }}
          label={{ value: 'Residuals', fill: C.muted, fontSize: 11, angle: -90, position: 'insideLeft' }} />
        <ReferenceLine y={0} stroke={C.gold} strokeDasharray="4 2" />
        <Tooltip contentStyle={{ background: C.surf, border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }} formatter={(v: number) => v.toFixed(4)} />
        <Scatter name="Residuals" data={data} fill={C.purple} opacity={0.5} r={3} />
      </ScatterChart>
    </ResponsiveContainer>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RegressionAnalysis() {
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
      y_ticker: yTicker.toUpperCase(), x_tickers: xTickers.map(t => t.toUpperCase()),
      period, model_type: modelType, degree, use_returns: useReturns, include_chart: true,
    })
  }

  const addX = () => {
    const t = xInput.trim().toUpperCase()
    if (t && !xTickers.includes(t)) setXTickers(prev => [...prev, t])
    setXInput('')
  }

  const r = mutation.data
  const r2Color = r ? (r.r_squared > 0.7 ? C.green : r.r_squared > 0.4 ? C.gold : C.red) : C.muted

  const rail = (
    <>
      <RailGroup label="Y (dependent)">
        <input value={yTicker} onChange={e => setYTicker(e.target.value.toUpperCase())} style={inputStyle} placeholder="e.g. SPY" />
      </RailGroup>

      <RailGroup label="X variables">
        <TickerTags tickers={xTickers} onRemove={t => setXTickers(p => p.filter(x => x !== t))} color={C.blue} />
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={xInput} onChange={e => setXInput(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && addX()} style={inputStyle} placeholder="Add ticker" />
          <button onClick={addX} style={{ ...btnStyle, padding: '6px 10px', flexShrink: 0 }}><Plus size={14} /></button>
        </div>
      </RailGroup>

      <RailGroup label="Period">
        <select value={period} onChange={e => setPeriod(e.target.value)} style={selectStyle}>
          {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </RailGroup>

      <RailGroup label="Model">
        <select value={modelType} onChange={e => setModelType(e.target.value as any)} style={{ ...selectStyle, marginBottom: modelType === 'polynomial' ? 8 : 0 }}>
          <option value="linear">Linear / OLS</option>
          <option value="polynomial">Polynomial</option>
        </select>
        {modelType === 'polynomial' && (
          <input type="number" min={2} max={6} value={degree} onChange={e => setDegree(Number(e.target.value))} style={inputStyle} placeholder="Degree" />
        )}
      </RailGroup>

      <RailGroup label="Input">
        <button onClick={() => setUseReturns(p => !p)} style={{ ...btnStyle, width: '100%', background: useReturns ? `${C.blue}22` : C.surf, borderColor: useReturns ? C.blue : C.border }}>
          {useReturns ? 'Log Returns' : 'Raw Prices'}
        </button>
      </RailGroup>

      <RunButton onClick={run} disabled={!yTicker || xTickers.length === 0} busy={mutation.isPending} label="Run Regression" />
    </>
  )

  return (
    <ToolShell title="Regression" rail={rail}>
      {mutation.isError && (
        <div style={{ color: C.red, background: `${C.red}11`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 12 }}>
          {(mutation.error as any)?.response?.data?.detail ?? mutation.error.message}
        </div>
      )}

      {r && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 20 }}>
            <StatCard label="R²" value={r.r_squared.toFixed(4)} sub={`Adj R²: ${r.adj_r_squared.toFixed(4)}`}
              tip={`Share of ${r.y_ticker}'s variation explained by the model (0 to 1). Higher is a tighter fit. Adj R² penalizes extra variables.`} />
            <StatCard label="Observations" value={r.observations} tip="Number of data points (days) used in the regression. More is a more stable estimate." />
            <StatCard label="F-Statistic" value={r.f_statistic?.toFixed(2) ?? 'n/a'}
              tip="Tests whether the model as a whole beats just guessing the average. Above ~4 is significant at the 5% level (one predictor); dozens or more is very strong. Pair it with R², since large samples inflate F." />
            <StatCard label="MSE" value={r.mse.toExponential(3)} tip="Mean squared residual. Its square root is the typical prediction error, in the dependent variable's units." />
            <StatCard label="Intercept" value={r.intercept.toFixed(6)} sub={`p = ${r.intercept_p.toExponential(2)}`}
              tip={`Expected ${r.y_ticker} when every input is zero (alpha). A p-value above 0.05 means it is not distinguishable from zero.`} />
            {r.coefficients.map((c, i) => (
              <StatCard key={i} label={`Beta (${r.feature_names[i]})`} value={c.toFixed(6)} sub={`p = ${r.p_values[i].toExponential(2)}`}
                tip={`Slope: ${r.y_ticker} moves this much per 1-unit move in ${r.feature_names[i]}, holding others fixed. A p-value below 0.05 means it is statistically significant.`} />
            ))}
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.muted, marginBottom: 4 }}>
              <span>R² fit quality</span>
              <span style={{ color: r2Color }}>{r.r_squared > 0.7 ? 'Strong' : r.r_squared > 0.4 ? 'Moderate' : 'Weak'} ({(r.r_squared * 100).toFixed(1)}%)</span>
            </div>
            <div style={{ height: 6, background: C.surf, borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ width: `${r.r_squared * 100}%`, height: '100%', background: r2Color, borderRadius: 3 }} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 0, marginBottom: 16, borderBottom: `1px solid ${C.border}` }}>
            {(['charts', 'table'] as const).map(tab => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{
                padding: '8px 18px', fontSize: 12, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                color: activeTab === tab ? C.gold : C.muted, borderBottom: activeTab === tab ? `2px solid ${C.gold}` : '2px solid transparent',
                textTransform: 'uppercase', letterSpacing: 1,
              }}>{tab}</button>
            ))}
            {r.chart_b64 && (
              <button onClick={() => { const a = document.createElement('a'); a.href = `data:image/png;base64,${r.chart_b64}`; a.download = `regression_${r.y_ticker}_${r.x_tickers.join('_')}.png`; a.click() }}
                style={{ ...btnStyle, marginLeft: 'auto', fontSize: 11, display: 'flex', gap: 6, alignItems: 'center' }}>
                <Download size={12} /> PNG
              </button>
            )}
          </div>

          {activeTab === 'charts' && (
            <div style={{ display: 'grid', gap: 20 }}>
              <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
                <div style={{ color: C.gold, fontSize: 12, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}><BarChart2 size={14} /> Scatter + Regression Line</div>
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
              <div style={{ marginTop: 10, fontSize: 10, color: C.muted }}>Significance: *** p&lt;0.001 &nbsp; ** p&lt;0.01 &nbsp; * p&lt;0.05 &nbsp; . p&lt;0.1</div>
            </div>
          )}
        </>
      )}

      {!r && !mutation.isPending && (
        <div style={{ textAlign: 'center', color: C.muted, padding: '60px 24px', fontSize: 13, border: `1px dashed ${C.border}` }}>
          Set a dependent ticker and one or more predictors, then click <span style={{ color: C.gold }}>Run Regression</span>.
        </div>
      )}
    </ToolShell>
  )
}
