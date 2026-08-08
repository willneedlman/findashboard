import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceDot } from 'recharts'
import { Plus, X } from 'lucide-react'
import { TOOLTIP_STYLE } from '../components/ChartTooltip'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerInput from '../components/TickerInput'
import PMImportPicker from '../components/PMImportPicker'
import { CASH_SYMBOL, type ImportResult } from '../lib/pmImport'
import type { ClipDraft } from '../lib/reportCreator'
import { useReportCapture } from '../hooks/useReportCapture'
import { kpiClip, tableClip, chartClip } from '../lib/reportCaptureRegistry'
import { alpha } from '../lib/theme'

const C = {
  bg: 'var(--theme-bg)', surf: 'var(--theme-surface)', border: 'var(--theme-border)',
  gold: 'var(--theme-primary)', text: 'var(--theme-text, #d7e3fc)', muted: 'var(--theme-text-dim)',
  green: 'var(--theme-positive)', red: 'var(--theme-negative)',
}
const LINE_COLORS = ['#7aa2f7', 'var(--theme-primary, #c9a84c)', '#2f9a62', '#bb9af7']

interface Leg { ticker: string; weight: number }
interface Port { name: string; legs: Leg[]; leverage: string; borrow: string }
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
  background: 'var(--theme-bg)', border: '1px solid color-mix(in srgb, var(--theme-primary, #c9a84c) 35%, transparent)', color: 'var(--theme-text, #d7e3fc)',
  padding: '5px 8px', fontSize: 12, fontFamily: 'var(--theme-mono)', width: '100%', outline: 'none', boxSizing: 'border-box',
}
const labelStyle: React.CSSProperties = {
  color: 'var(--theme-secondary, #8099b0)', fontSize: 10, fontWeight: 700, letterSpacing: '0.12em',
  textTransform: 'uppercase', marginBottom: 4, display: 'block',
}
const panel: React.CSSProperties = { background: C.surf, border: `1px solid ${C.border}`, padding: 16 }
const panelTitle: React.CSSProperties = { color: C.gold, fontSize: 12, marginBottom: 12, textTransform: 'uppercase', letterSpacing: '0.1em' }

export function PortfolioCompareContent() {
  const [ports, setPorts] = useState<Port[]>([
    { name: 'Portfolio A', legs: [{ ticker: 'SPY', weight: 100 }], leverage: '1', borrow: '0' },
    { name: 'Portfolio B', legs: [{ ticker: 'QQQ', weight: 60 }, { ticker: 'TLT', weight: 40 }], leverage: '1', borrow: '0' },
  ])
  const [start, setStart] = useState('2020-01-01')
  const [end, setEnd] = useState(() => new Date().toISOString().split('T')[0])
  const [mode, setMode] = useState<'dollar' | 'pct'>('dollar')   // $100 growth vs % change

  const m = useMutation<CompareResult, Error, void>({
    mutationFn: () => axios.post('/api/portfolio/compare', {
      start, end,
      portfolios: ports.map(p => {
        const legs = p.legs.filter(l => l.ticker.trim())
        return { name: p.name || 'Portfolio', tickers: legs.map(l => l.ticker.trim().toUpperCase()),
                 weights: legs.map(l => l.weight || 0),
                 leverage: Number(p.leverage) || 1, borrow_rate: Number(p.borrow) || 0 }
      }),
    }).then(r => r.data),
  })

  const update = (i: number, k: 'name' | 'leverage' | 'borrow', v: string) => setPorts(p => p.map((x, j) => j === i ? { ...x, [k]: v } : x))
  const updateLeg = (i: number, li: number, k: keyof Leg, v: string) =>
    setPorts(p => p.map((x, j) => j === i ? { ...x, legs: x.legs.map((l, m) => m === li ? { ...l, [k]: k === 'weight' ? (Number(v) || 0) : v.toUpperCase() } : l) } : x))
  const addLeg = (i: number) => setPorts(p => p.map((x, j) => j === i ? { ...x, legs: [...x.legs, { ticker: '', weight: 0 }] } : x))
  const removeLeg = (i: number, li: number) => setPorts(p => p.map((x, j) => j === i && x.legs.length > 1 ? { ...x, legs: x.legs.filter((_, m) => m !== li) } : x))
  const addPort = () => ports.length < 4 && setPorts(p => [...p, { name: `Portfolio ${String.fromCharCode(65 + p.length)}`, legs: [{ ticker: '', weight: 100 }], leverage: '1', borrow: '0' }])
  const removePort = (i: number) => ports.length > 2 && setPorts(p => p.filter((_, j) => j !== i))

  // Bring a Portfolio Manager portfolio in as a new comparison slot (equity legs
  // by market value + a CASH sleeve). At the 4-portfolio cap, replace the last.
  const importFromPM = (res: ImportResult, name: string) => {
    const legs: Leg[] = res.legs.map(l => ({ ticker: l.ticker, weight: l.weight }))
    if (res.cashWeight > 0) legs.push({ ticker: CASH_SYMBOL, weight: res.cashWeight })
    if (legs.length === 0) return
    const port: Port = { name, legs, leverage: '1', borrow: '0' }
    setPorts(prev => (prev.length < 4 ? [...prev, port] : [...prev.slice(0, 3), port]))
  }

  const r = m.data
  // Backend returns each series indexed to 100. % mode rebases to cumulative
  // return (value - 100); $ mode keeps the growth-of-$100 value.
  const toMode = (v: number) => (mode === 'pct' ? v - 100 : v)
  const floorY = mode === 'pct' ? -100 : 0   // a wiped-out portfolio's floored value
  const chartData = r ? (() => {
    const map: Record<string, any> = {}
    for (const s of r.series) for (const pt of s.points) (map[pt.date] ??= { date: pt.date })[s.name] = toMode(pt.value)
    return Object.values(map).sort((a: any, b: any) => (a.date < b.date ? -1 : 1))
  })() : []

  // Mark where a leveraged portfolio was wiped out (equity floored to 0)
  const liquidations = r
    ? r.series.map((s, i) => {
        const mt = r.metrics.find(x => x.name === s.name)
        if (!mt?.liquidated) return null
        const pt = s.points.find(p => p.value <= 0)
        return pt ? { name: s.name, date: pt.date, color: LINE_COLORS[i] } : null
      }).filter(Boolean) as { name: string; date: string; color: string }[]
    : []

  useReportCapture(() => {
    if (!r?.metrics?.length) return null
    const pieces: ClipDraft[] = [
      kpiClip('Portfolio Compare', 'Portfolio Comparison Snapshot', r.metrics.map(mt => ({
        label: mt.name,
        value: `${mt.cagr >= 0 ? '+' : ''}${mt.cagr}% CAGR`,
        sub: `Sharpe ${mt.sharpe} · DD ${mt.max_drawdown}%`,
      }))),
      tableClip(
        'Portfolio Compare',
        'Metrics',
        ['Portfolio', 'Lev', 'CAGR %', 'Vol %', 'Sharpe', 'Max DD %', 'Sortino', 'Calmar'],
        r.metrics.map(mt => [
          mt.liquidated ? `${mt.name} (LIQ)` : mt.name,
          `${mt.leverage}x`,
          mt.cagr,
          mt.vol,
          mt.sharpe,
          mt.max_drawdown,
          mt.sortino,
          mt.calmar,
        ]),
      ),
    ]
    if (chartData.length && r.series.length) {
      const step = Math.max(1, Math.ceil(chartData.length / 80))
      const sampled = chartData.filter((_, i) => i % step === 0 || i === chartData.length - 1) as Record<string, string | number>[]
      pieces.push(chartClip(
        'Portfolio Compare',
        mode === 'pct' ? 'Cumulative Return' : 'Growth of $100',
        'line',
        'date',
        sampled.map(row => {
          const out: Record<string, string | number | null> = { date: String(row.date) }
          for (const s of r.series) out[s.name] = (row[s.name] as number) ?? null
          return out
        }),
        r.series.map(s => ({ key: s.name, label: s.name })),
      ))
    }
    return pieces
  }, { disabled: !r?.metrics?.length, sourceTab: 'Portfolio Compare' })

  return (
    <>
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
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <label style={labelStyle}>Holdings</label>
                  <label style={{ ...labelStyle, marginRight: 22 }}>Weight</label>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {p.legs.map((leg, li) => (
                    <div key={li} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <TickerInput style={{ ...inputStyle, flex: 1 }} placeholder="Ticker or company" value={leg.ticker}
                        onChange={v => updateLeg(i, li, 'ticker', v)} />
                      <input type="number" min={0} step={1} style={{ ...inputStyle, width: 52, textAlign: 'right' }} value={leg.weight}
                        onChange={e => updateLeg(i, li, 'weight', e.target.value)} />
                      <X size={13} style={{ cursor: 'pointer', color: p.legs.length > 1 ? C.muted : 'transparent', flexShrink: 0 }}
                        onClick={() => removeLeg(i, li)} />
                    </div>
                  ))}
                </div>
                <button onClick={() => addLeg(i)} style={{ ...inputStyle, cursor: 'pointer', color: C.muted, marginTop: 4, padding: '3px 0', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <Plus size={11} /> Add ticker
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Leverage (x)</label>
                  <input type="number" step={0.25} min={1} style={inputStyle} value={p.leverage} onChange={e => update(i, 'leverage', e.target.value)} />
                </div>
                {(Number(p.leverage) || 1) > 1 && (
                  <div style={{ flex: 1 }}>
                    <label style={labelStyle}>Borrow %</label>
                    <input type="number" step={0.5} min={0} max={30} style={inputStyle} value={p.borrow} onChange={e => update(i, 'borrow', e.target.value)} />
                  </div>
                )}
              </div>
            </div>
          ))}
          {ports.length < 4 && (
            <button onClick={addPort} style={{ ...inputStyle, cursor: 'pointer', color: C.gold, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <Plus size={13} /> Add Portfolio
            </button>
          )}
          <PMImportPicker style={{ ...inputStyle, cursor: 'pointer' }} onImport={importFromPM} />
          <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
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
          <EmptyState title="Portfolio Compare" hint="Define two to four portfolios, then compare return, risk and drawdown."
            action="Compare" />
        )}
        {r && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={panel}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ ...panelTitle, marginBottom: 0 }}>{mode === 'pct' ? 'Cumulative Return' : 'Growth of $100'}</div>
                <div style={{ display: 'flex', border: `1px solid ${C.border}` }}>
                  {([['dollar', '$100'], ['pct', '% Change']] as const).map(([k, lbl]) => (
                    <button key={k} onClick={() => setMode(k)} style={{
                      background: mode === k ? C.gold : 'transparent',
                      color: mode === k ? 'var(--theme-bg)' : C.muted,
                      border: 'none', cursor: 'pointer', fontFamily: 'var(--theme-mono)',
                      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', padding: '4px 11px',
                    }}>{lbl}</button>
                  ))}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={340}>
                <LineChart data={chartData} margin={{ top: 6, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="date" stroke={C.muted} tick={{ fill: C.muted, fontSize: 9 }} minTickGap={60} />
                  <YAxis stroke={C.muted} tick={{ fill: C.muted, fontSize: 10 }} width={52}
                    tickFormatter={(v: number) => (mode === 'pct' ? `${v}%` : `$${v}`)} />
                  <Tooltip contentStyle={{ ...TOOLTIP_STYLE, color: C.text }}
                    formatter={(v: number) => (mode === 'pct' ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : `$${v.toFixed(2)}`)} />
                  <Legend wrapperStyle={{ color: C.muted, fontSize: 11 }} />
                  {r.series.map((s, i) => (
                    <Line key={s.name} type="monotone" dataKey={s.name} name={s.name} stroke={LINE_COLORS[i]} strokeWidth={2} dot={false} />
                  ))}
                  {liquidations.map(liq => (
                    <ReferenceDot key={liq.name} x={liq.date} y={floorY} r={5} isFront
                      fill={C.red} stroke={C.bg} strokeWidth={1.5}
                      label={{ value: 'Liquidated', position: 'top', fill: C.red, fontSize: 9, fontFamily: 'var(--theme-mono)' }} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
              {liquidations.length > 0 && (
                <div style={{ fontFamily: 'var(--theme-mono)', fontSize: 10, color: C.red, marginTop: 8 }}>
                  {liquidations.map(l => l.name).join(', ')} wiped out at this leverage. Equity floored to {mode === 'pct' ? '-100%' : '$0'} from the liquidation date.
                </div>
              )}
            </div>
            <div style={{ ...panel, overflowX: 'auto' }}>
              <div style={panelTitle}>Metrics</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'var(--theme-mono)' }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}`, color: C.muted }}>
                    {['Portfolio', 'Lev', 'CAGR %', 'Vol %', 'Sharpe', 'Max DD %', 'Sortino', 'Calmar'].map(h => (
                      <th key={h} style={{ padding: '6px 10px', textAlign: h === 'Portfolio' ? 'left' : 'right', fontWeight: 500 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.metrics.map((mt, i) => (
                    <tr key={mt.name} style={{ borderBottom: `1px solid ${alpha(C.border, 20)}` }}>
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
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </SidebarLayout>
    </>
  )
}

export default function PortfolioCompare() {
  return <PageWrapper title="Portfolio Compare"><PortfolioCompareContent /></PageWrapper>
}
