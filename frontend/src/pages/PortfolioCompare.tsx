import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Plus, X } from 'lucide-react'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'

const C = {
  bg: 'var(--theme-bg)', surf: 'var(--theme-surface)', border: 'var(--theme-border)',
  gold: 'var(--theme-primary)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-text-dim)',
  green: 'var(--theme-positive)', red: 'var(--theme-negative)',
}
const LINE_COLORS = ['#7aa2f7', '#c9a84c', '#2f9a62', '#bb9af7']
const BENCH_COLOR = 'var(--theme-text-faint, rgba(255,255,255,0.4))'

interface Port { name: string; tickers: string; leverage: string; borrow: string }
interface Metric {
  name: string; leverage: number; borrow_rate: number; liquidated: boolean
  cagr: number; vol: number; sharpe: number; max_drawdown: number; sortino: number; calmar: number; beta: number
}
interface CompareResult {
  benchmark: string
  benchmark_points: { date: string; value: number }[]
  series: { name: string; points: { date: string; value: number }[] }[]
  metrics: Metric[]
}

const inputStyle: React.CSSProperties = {
  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', color: 'var(--theme-text, #d7e3fc)',
  padding: '5px 8px', fontSize: 12, fontFamily: 'var(--theme-mono)', width: '100%', outline: 'none', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = {
  color: 'var(--theme-secondary, #99907e)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
  textTransform: 'uppercase', marginBottom: 4, display: 'block',
}
const panel: React.CSSProperties = { background: C.surf, border: `1px solid ${C.border}`, padding: 16 }
const panelTitle: React.CSSProperties = { color: C.gold, fontSize: 12, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.1em' }

export default function PortfolioCompare() {
  const [ports, setPorts] = useState<Port[]>([
    { name: 'Portfolio A', tickers: 'SPY', leverage: '1', borrow: '0' },
    { name: 'Portfolio B', tickers: 'QQQ, TLT', leverage: '1', borrow: '0' },
  ])
  const [benchmark, setBenchmark] = useState('SPY')
  const [start, setStart] = useState('2020-01-01')
  const [end, setEnd] = useState(() => new Date().toISOString().split('T')[0])

  const m = useMutation<CompareResult, Error, void>({
    mutationFn: () => axios.post('/api/portfolio/compare', {
      benchmark, start, end,
      portfolios: ports.map(p => {
        const ts = p.tickers.split(/[,\s]+/).map(t => t.trim().toUpperCase()).filter(Boolean)
        return { name: p.name || 'Portfolio', tickers: ts, weights: ts.map(() => 1),
                 leverage: Number(p.leverage) || 1, borrow_rate: Number(p.borrow) || 0 }
      }),
    }).then(r => r.data),
  })

  const update = (i: number, k: keyof Port, v: string) => setPorts(p => p.map((x, j) => j === i ? { ...x, [k]: v } : x))
  const addPort = () => ports.length < 4 && setPorts(p => [...p, { name: `Portfolio ${String.fromCharCode(65 + p.length)}`, tickers: '', leverage: '1', borrow: '0' }])
  const removePort = (i: number) => ports.length > 2 && setPorts(p => p.filter((_, j) => j !== i))

  const r = m.data
  const chartData = r ? (() => {
    const map: Record<string, any> = {}
    for (const s of r.series) for (const pt of s.points) (map[pt.date] ??= { date: pt.date })[s.name] = pt.value
    for (const pt of r.benchmark_points) (map[pt.date] ??= { date: pt.date })['_bench'] = pt.value
    return Object.values(map).sort((a: any, b: any) => (a.date < b.date ? -1 : 1))
  })() : []

  return (
    <PageWrapper title="Compare Portfolios">
      <SidebarLayout sidebarWidth={264} sidebarTitle="Portfolios" sidebar={
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {ports.map((p, i) => (
            <div key={i} style={{ border: `1px solid ${C.border}`, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 10, height: 10, background: LINE_COLORS[i], flexShrink: 0 }} />
                <input style={{ ...inputStyle, fontWeight: 700 }} value={p.name} onChange={e => update(i, 'name', e.target.value)} />
                {ports.length > 2 && <X size={14} style={{ cursor: 'pointer', color: C.muted, flexShrink: 0 }} onClick={() => removePort(i)} />}
              </div>
              <div>
                <label style={labelStyle}>Tickers (equal-weight)</label>
                <input style={inputStyle} placeholder="AAPL, MSFT, NVDA" value={p.tickers}
                  onChange={e => update(i, 'tickers', e.target.value.toUpperCase())} />
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Leverage (x)</label>
                  <input type="number" step={0.25} min={1} max={5} style={inputStyle} value={p.leverage} onChange={e => update(i, 'leverage', e.target.value)} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Borrow %</label>
                  <input type="number" step={0.5} min={0} max={30} style={inputStyle} value={p.borrow} onChange={e => update(i, 'borrow', e.target.value)} />
                </div>
              </div>
            </div>
          ))}
          {ports.length < 4 && (
            <button onClick={addPort} style={{ ...inputStyle, cursor: 'pointer', color: C.gold, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Plus size={13} /> Add Portfolio
            </button>
          )}
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div><label style={labelStyle}>Benchmark</label><input style={inputStyle} value={benchmark} onChange={e => setBenchmark(e.target.value.toUpperCase())} /></div>
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ flex: 1 }}><label style={labelStyle}>Start</label><input type="date" style={inputStyle} value={start} onChange={e => setStart(e.target.value)} /></div>
              <div style={{ flex: 1 }}><label style={labelStyle}>End</label><input type="date" style={inputStyle} value={end} onChange={e => setEnd(e.target.value)} /></div>
            </div>
          </div>
          <button onClick={() => m.mutate()} disabled={m.isPending}
            style={{ ...inputStyle, cursor: 'pointer', background: C.gold, color: 'var(--theme-bg)', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 0' }}>
            {m.isPending ? 'Running…' : 'Compare'}
          </button>
        </div>
      }>
        {m.isError && (
          <div style={{ color: C.red, fontFamily: 'var(--theme-mono)', fontSize: 12, marginBottom: 12 }}>
            {(m.error as any)?.response?.data?.detail ?? m.error.message}
          </div>
        )}
        {!r && !m.isPending && (
          <EmptyState title="Compare Portfolios" hint="Define 2-4 portfolios (each with its own assets and leverage), then press Compare." />
        )}
        {r && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={panel}>
              <div style={panelTitle}>Growth of $100</div>
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={chartData} margin={{ top: 6, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="date" stroke={C.muted} tick={{ fill: C.muted, fontSize: 9 }} minTickGap={60} />
                  <YAxis stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }} />
                  <Tooltip contentStyle={{ background: 'var(--theme-surface)', border: `1px solid ${C.border}`, color: C.text, fontSize: 11 }} />
                  <Legend wrapperStyle={{ color: C.muted, fontSize: 11 }} />
                  <Line type="monotone" dataKey="_bench" name={`${r.benchmark} (bench)`} stroke={BENCH_COLOR} strokeWidth={1.5} strokeDasharray="5 3" dot={false} />
                  {r.series.map((s, i) => (
                    <Line key={s.name} type="monotone" dataKey={s.name} name={s.name} stroke={LINE_COLORS[i]} strokeWidth={2} dot={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div style={{ ...panel, overflowX: 'auto' }}>
              <div style={panelTitle}>Metrics</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--theme-mono)' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.muted }}>
                    {['Portfolio', 'Lev', 'CAGR %', 'Vol %', 'Sharpe', 'Max DD %', 'Sortino', 'Calmar', 'Beta'].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: h === 'Portfolio' ? 'left' : 'right', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.metrics.map((mt, i) => (
                    <tr key={mt.name} style={{ borderBottom: `1px solid ${C.border}33` }}>
                      <td style={{ padding: '6px 10px', color: LINE_COLORS[i], fontWeight: 700 }}>
                        {mt.name}{mt.liquidated && <span style={{ color: C.red, marginLeft: 6, fontWeight: 700 }}>LIQUIDATED</span>}
                      </td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.text }}>{mt.leverage}x</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: mt.cagr >= 0 ? C.green : C.red }}>{mt.cagr}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.text }}>{mt.vol}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.text }}>{mt.sharpe}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.red }}>{mt.max_drawdown}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.text }}>{mt.sortino}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.text }}>{mt.calmar}</td>
                      <td style={{ padding: '6px 10px', textAlign: 'right', color: C.text }}>{mt.beta}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </SidebarLayout>
    </PageWrapper>
  )
}
