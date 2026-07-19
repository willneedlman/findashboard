import { useState, Fragment } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import {
  ScatterChart, Scatter, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { TrendingUp, Plus, BarChart2, LayoutGrid } from 'lucide-react'
import EmptyState from '../components/EmptyState'
import { TOOLTIP_STYLE, CROSSHAIR_CURSOR } from '../components/ChartTooltip'
import {
  C, PERIODS, StatCard, inputStyle, selectStyle, btnStyle,
  RailGroup, RunButton, TickerTags, ToolShell,
} from './regressionShared'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip } from '../lib/reportCaptureRegistry'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CorrPair { a: string; b: string; value: number }
interface CorrelationResult {
  tickers:      string[]
  benchmark:    string | null
  period:       string
  use_returns:  boolean
  observations: number
  matrix:       { row: string; col: string; value: number }[]
  pairs:        CorrPair[]
  summary: { avg_abs_correlation: number; strongest_pair: CorrPair | null; most_negative_pair: CorrPair | null }
  betas:   { ticker: string; beta: number; r_squared: number }[] | null
  rolling: { pair: [string, string]; window: number; dates: string[]; corr: number[] } | null
  scatter: { pair: [string, string]; x: number[]; y: number[] } | null
}

// ── Sub-components ────────────────────────────────────────────────────────────

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
                  style={{ background: rowT === colT ? `color-mix(in srgb, ${C.gold} 30%, transparent)` : corrCell(v), color: C.text, fontSize: 11, fontFamily: 'var(--theme-mono)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 2px', border: `1px solid ${C.border}` }}>
                  {v.toFixed(2)}
                </div>
              )
            })}
          </Fragment>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 10, color: C.muted }}>
        <span>−1</span>
        <div style={{ flex: 1, maxWidth: 240, height: 8, borderRadius: 2, background: `linear-gradient(to right, ${C.red}, transparent, ${C.green})`, border: `1px solid ${C.border}` }} />
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
        <Tooltip contentStyle={{ ...TOOLTIP_STYLE, color: C.text }} formatter={(v: number) => v.toFixed(3)} />
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
        <Tooltip cursor={CROSSHAIR_CURSOR} contentStyle={{ ...TOOLTIP_STYLE, color: C.text }} formatter={(v: number) => v.toFixed(4)} />
        <Scatter name={`${pair[0]} vs ${pair[1]}`} data={data} fill={C.blue} opacity={0.5} r={3} />
      </ScatterChart>
    </ResponsiveContainer>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CorrelationAnalysis() {
  const [tickers,    setTickers]    = useState<string[]>(['SPY', 'QQQ', 'GLD', 'BTC-USD'])
  const [tColors,    setTColors]    = useState<Record<string, string>>({})
  const [tInput,     setTInput]     = useState('')
  const [period,     setPeriod]     = useState('2y')
  const [useReturns, setUseReturns] = useState(true)
  const [benchmark,  setBenchmark]  = useState('SPY')
  const [rollWindow, setRollWindow] = useState(60)
  const [pairA,      setPairA]      = useState('')
  const [pairB,      setPairB]      = useState('')

  const mutation = useMutation<CorrelationResult, Error, void>({
    mutationFn: () => axios.post('/api/regression/correlation', {
      tickers, period, use_returns: useReturns,
      benchmark: benchmark.trim() || null, rolling_window: rollWindow,
      pair: pairA && pairB && pairA !== pairB ? [pairA, pairB] : null,
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

  useReportCapture(() => {
    if (!r) return null
    const pieces: ClipDraft[] = []
    pieces.push(kpiClip('Correlation', 'Correlation Summary', [
      { label: 'Avg |correlation|', value: avg.toFixed(3), sub: divLabel },
      ...(r.summary.strongest_pair ? [{ label: 'Most correlated', value: `+${r.summary.strongest_pair.value.toFixed(2)}`, sub: `${r.summary.strongest_pair.a} ↔ ${r.summary.strongest_pair.b}` }] : []),
      ...(r.summary.most_negative_pair ? [{ label: 'Most negative', value: r.summary.most_negative_pair.value.toFixed(2), sub: `${r.summary.most_negative_pair.a} ↔ ${r.summary.most_negative_pair.b}` }] : []),
      { label: 'Observations', value: String(r.observations), sub: `${r.period} · ${r.use_returns ? 'returns' : 'prices'}` },
    ]))
    const lookup = new Map(r.matrix.map(m => [`${m.row}|${m.col}`, m.value]))
    pieces.push(tableClip(
      'Correlation',
      'Correlation Matrix',
      ['', ...r.tickers],
      r.tickers.map(rowT => [
        rowT,
        ...r.tickers.map(colT => {
          const v = lookup.get(`${rowT}|${colT}`)
          return v == null ? null : v.toFixed(2)
        }),
      ]),
    ))
    if (r.pairs?.length) {
      pieces.push(tableClip(
        'Correlation',
        'Pair Correlations',
        ['Asset A', 'Asset B', 'Correlation'],
        r.pairs.slice(0, 20).map(p => [p.a, p.b, p.value.toFixed(3)]),
      ))
    }
    if (r.rolling?.dates?.length) {
      const step = Math.max(1, Math.floor(r.rolling.dates.length / 60))
      const series = r.rolling.dates
        .map((d, i) => ({ date: d, corr: r.rolling!.corr[i] }))
        .filter((_, i) => i % step === 0 || i === r.rolling!.dates.length - 1)
      pieces.push(chartClip(
        'Correlation',
        `Rolling Correlation · ${r.rolling.pair[0]} ↔ ${r.rolling.pair[1]}`,
        'line',
        'date',
        series,
        [{ key: 'corr', label: `${r.rolling.window}-day corr` }],
      ))
    }
    if (r.betas?.length) {
      pieces.push(tableClip(
        'Correlation',
        `Beta vs ${r.benchmark ?? 'benchmark'}`,
        ['Asset', 'Beta', 'R²', 'Reading'],
        r.betas.map(b => [
          b.ticker,
          b.beta.toFixed(3),
          b.r_squared.toFixed(3),
          b.ticker === r.benchmark ? 'benchmark' : b.r_squared < 0.2 ? 'largely independent' : b.beta < 0 ? 'moves opposite' : b.beta > 1.2 ? 'amplifies' : b.beta < 0.8 ? 'dampens' : 'tracks closely',
        ]),
      ))
    }
    return pieces
  }, { disabled: !r, sourceTab: 'Correlation' })

  const rail = (
    <>
      <RailGroup label="Assets">
        <TickerTags tickers={tickers} onRemove={t => setTickers(p => p.filter(x => x !== t))}
          colors={tColors} onColorChange={(t, c) => setTColors(p => ({ ...p, [t]: c }))} />
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={tInput} onChange={e => setTInput(e.target.value.toUpperCase())} onKeyDown={e => e.key === 'Enter' && addT()} style={inputStyle} placeholder="Add e.g. BTC-USD" />
          <button onClick={addT} style={{ ...btnStyle, padding: '6px 10px', flexShrink: 0 }}><Plus size={14} /></button>
        </div>
      </RailGroup>

      <RailGroup label="Period">
        <select value={period} onChange={e => setPeriod(e.target.value)} style={selectStyle}>
          {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </RailGroup>

      <RailGroup label="Benchmark (β vs)">
        <input value={benchmark} onChange={e => setBenchmark(e.target.value.toUpperCase())} style={inputStyle} placeholder="SPY" />
      </RailGroup>

      <RailGroup label="Rolling window (days)">
        <input type="number" min={5} max={252} value={rollWindow} onChange={e => setRollWindow(Number(e.target.value))} style={inputStyle} />
      </RailGroup>

      <RailGroup label="Focus pair (rolling + scatter)">
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
      </RailGroup>

      <RailGroup label="Input">
        <button onClick={() => setUseReturns(p => !p)} style={{ ...btnStyle, width: '100%', background: useReturns ? `${C.blue}22` : C.surf, borderColor: useReturns ? C.blue : C.border }}>
          {useReturns ? 'Log Returns' : 'Raw Prices'}
        </button>
      </RailGroup>

      <RunButton onClick={() => tickers.length >= 2 && mutation.mutate()} disabled={tickers.length < 2} busy={mutation.isPending} label="Run Correlation" />
    </>
  )

  return (
    <ToolShell title="Correlation" rail={rail}>
      {mutation.isError && (
        <div style={{ color: C.red, background: `${C.red}11`, border: `1px solid ${C.red}44`, borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 12 }}>
          {(mutation.error as any)?.response?.data?.detail ?? mutation.error.message}
        </div>
      )}

      {r && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            <StatCard label="Avg |correlation|" value={avg.toFixed(3)} sub={divLabel} />
            {r.summary.strongest_pair && (
              <StatCard label="Most correlated" value={`+${r.summary.strongest_pair.value.toFixed(2)}`} sub={`${r.summary.strongest_pair.a} ↔ ${r.summary.strongest_pair.b}`} />
            )}
            {r.summary.most_negative_pair && (
              <StatCard label="Most negative" value={r.summary.most_negative_pair.value.toFixed(2)} sub={`${r.summary.most_negative_pair.a} ↔ ${r.summary.most_negative_pair.b}`} />
            )}
            <StatCard label="Observations" value={r.observations} sub={`${r.period} · ${r.use_returns ? 'returns' : 'prices'}`} />
          </div>

          <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ color: C.gold, fontSize: 12, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}><LayoutGrid size={14} /> Correlation Matrix</div>
            <CorrHeatmap result={r} />
          </div>

          {r.rolling && (
            <div style={{ display: 'grid', gap: 20, gridTemplateColumns: '1fr', marginBottom: 20 }}>
              <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
                <div style={{ color: C.gold, fontSize: 12, marginBottom: 4, display: 'flex', gap: 8, alignItems: 'center' }}><TrendingUp size={14} /> Rolling Correlation: {r.rolling.pair[0]} ↔ {r.rolling.pair[1]}</div>
                <div style={{ color: C.muted, fontSize: 10, marginBottom: 12 }}>How their {r.rolling.window}-day correlation drifts over time. Spikes toward +1 mean they are converging; dips show the link breaking down.</div>
                <RollingChart result={r} />
              </div>
              <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
                <div style={{ color: C.gold, fontSize: 12, marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}><BarChart2 size={14} /> Pairwise Scatter: {r.scatter?.pair[0]} vs {r.scatter?.pair[1]}</div>
                <CorrScatter result={r} />
              </div>
            </div>
          )}

          {r.betas && (
            <div style={{ background: C.surf, border: `1px solid ${C.border}`, borderRadius: 8, padding: 16 }}>
              <div style={{ color: C.gold, fontSize: 12, marginBottom: 4 }}>Beta vs {r.benchmark}</div>
              <div style={{ color: C.muted, fontSize: 10, marginBottom: 12 }}>Beta &gt; 1 means the asset amplifies {r.benchmark} moves; &lt; 1 means it dampens them; negative means it moves opposite. R² is how much of the asset is explained by {r.benchmark}.</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--theme-mono)' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.muted }}>
                    {['Asset', 'Beta', 'R²', 'Reading'].map(h => <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontWeight: 500 }}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {r.betas.map(b => (
                    <tr key={b.ticker} style={{ borderBottom: `1px solid ${C.border}22` }}>
                      <td style={{ padding: '6px 10px', color: C.blue }}>{b.ticker}</td>
                      <td style={{ padding: '6px 10px', color: b.beta < 0 ? C.red : C.text }}>{b.beta.toFixed(3)}</td>
                      <td style={{ padding: '6px 10px', color: C.text }}>{b.r_squared.toFixed(3)}</td>
                      <td style={{ padding: '6px 10px', color: C.muted, fontSize: 11 }}>
                        {b.ticker === r.benchmark ? 'benchmark' : b.r_squared < 0.2 ? 'largely independent (low R²)' : b.beta < 0 ? 'moves opposite' : b.beta > 1.2 ? 'amplifies' : b.beta < 0.8 ? 'dampens' : 'tracks closely'}
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
        <EmptyState title="Correlation" hint="Add two or more assets, then run the correlation analysis."
          action="Run Correlation"
          keys={['Enter']} kpis={['Avg |Corr|', 'Strongest Pair', 'Most Negative', 'Observations']}
          preview="table" previewLabel="Correlation Matrix" columns={['Asset Pair', 'Correlation', 'Beta', 'R²']} />
      )}
    </ToolShell>
  )
}
