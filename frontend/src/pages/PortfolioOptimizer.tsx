import { useState, useMemo, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerTagInput from '../components/TickerTagInput'
import { KpiCell } from '../components/mmCockpit'
import Provenance from '../components/Provenance'
import { usePortfolio } from '../contexts/PortfolioContext'

const GOLD = 'var(--theme-primary, #c9a84c)'
const BLUE = 'var(--theme-tertiary, #60a5fa)'
const POS = 'var(--theme-positive, #3fb950)'
const NEG = 'var(--theme-negative, #f85149)'
const TEXT = 'var(--theme-text, #d7e3fc)'
const SEC = 'var(--theme-secondary, #8099b0)'
const FAINT = 'var(--theme-text-faint, #5e768f)'
const MONO = 'var(--theme-mono, monospace)'
const SANS = 'var(--theme-sans, sans-serif)'
const BORDER = 'var(--theme-border, rgba(255,255,255,0.08))'
const SURFACE = 'var(--theme-surface, #0d1826)'

const STRIP: React.CSSProperties = {
  display: 'flex', alignItems: 'stretch', overflowX: 'auto',
  background: SURFACE, border: `1px solid ${BORDER}`, borderTop: `2px solid ${GOLD}`,
}
const lbl: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: FAINT, fontFamily: SANS, marginBottom: 6, display: 'block' }
const inp: React.CSSProperties = { background: 'var(--theme-bg)', border: `1px solid color-mix(in srgb, ${GOLD} 30%, transparent)`, color: TEXT, fontFamily: MONO, fontSize: 11, padding: '7px 10px', outline: 'none', width: '100%', boxSizing: 'border-box' }

const PORTFOLIOS: { key: string; label: string; blurb: string }[] = [
  { key: 'max_sharpe',   label: 'Max Sharpe',    blurb: 'best risk-adjusted return (tangency)' },
  { key: 'min_variance', label: 'Min Variance',  blurb: 'lowest possible volatility' },
  { key: 'risk_parity',  label: 'Risk Parity',   blurb: 'equal risk from every holding' },
  { key: 'equal_weight', label: 'Equal Weight',  blurb: '1/N naive baseline' },
]
const LOOKBACKS: { label: string; years: number }[] = [
  { label: '1Y', years: 1 }, { label: '3Y', years: 3 }, { label: '5Y', years: 5 }, { label: '10Y', years: 10 },
]

interface WeightRow { ticker: string; weight: number; risk_contribution: number }
interface Port { return: number; vol: number; sharpe: number; weights: WeightRow[]; var_95: number; cvar_95: number; max_drawdown: number }
interface OptResult {
  tickers: string[]; days: number; span: { start: string; end: string }; risk_free_rate: number; long_only: boolean
  portfolios: Record<string, Port>
  frontier: { vol: number; return: number; sharpe: number }[]
  assets: { ticker: string; return: number; vol: number }[]
}

const startFor = (years: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - years); return d.toISOString().slice(0, 10) }

export function PortfolioOptimizerContent() {
  const [tickers, setTickers] = useState<string[]>(['AAPL', 'MSFT', 'NVDA', 'TLT', 'GLD'])
  const [lookback, setLookback] = useState(3)
  const [rf, setRf] = useState('4.00')
  const [longOnly, setLongOnly] = useState(true)
  const [selected, setSelected] = useState('max_sharpe')
  // Per-ticker weights (%) define the CURRENT portfolio, plotted against the optimum.
  const [weights, setWeights] = useState<Record<string, number>>({})
  const [importMsg, setImportMsg] = useState('')
  const { holdings } = usePortfolio()   // shared portfolio (weights), same as Monte Carlo

  // Auto-populate the risk-free rate from the live Treasury curve (3-month bill).
  useEffect(() => {
    axios.get('/api/rates/risk-free').then(r => {
      const v = r.data?.rate
      if (typeof v === 'number') setRf((v * 100).toFixed(2))
    }).catch(() => { /* keep the default */ })
  }, [])

  // Import the shared portfolio (the one Monte Carlo / Portfolio IO use): set the
  // basket AND the current weights so the backend can plot it against the optimum.
  const importPortfolio = () => {
    const hold = (holdings ?? []).filter(h => h.ticker && Number(h.weight) > 0)
    if (hold.length < 2) { setImportMsg('No saved portfolio found (add holdings in Monte Carlo or import a portfolio first).'); return }
    setTickers(hold.map(h => h.ticker.toUpperCase()))
    setWeights(Object.fromEntries(hold.map(h => [h.ticker.toUpperCase(), Number(h.weight)])))
    setImportMsg(`Imported ${hold.length} holdings with weights.`)
  }
  const onTickers = (t: string[]) => {
    setTickers(t)
    // Keep weights only for tickers still in the set.
    setWeights(w => Object.fromEntries(Object.entries(w).filter(([k]) => t.includes(k))))
    setImportMsg('')
  }
  const setWeight = (t: string, v: number) => setWeights(w => ({ ...w, [t]: Math.max(0, v) }))
  const evenWeights = () => setWeights(Object.fromEntries(tickers.map(t => [t, +(100 / tickers.length).toFixed(1)])))
  const totalW = tickers.reduce((s, t) => s + (weights[t] || 0), 0)
  const hasWeights = totalW > 0

  const { mutate, data, isPending, isError, error } = useMutation<OptResult>({
    mutationFn: async () => (await axios.post('/api/portfolio-opt/optimize', {
      tickers, start: startFor(lookback), end: new Date().toISOString().slice(0, 10),
      risk_free_rate: parseFloat(rf) || 0, long_only: longOnly,
      weights: hasWeights ? weights : undefined,
    })).data,
  })
  const canRun = tickers.length >= 2 && !isPending
  const sel = data?.portfolios[selected]
  const errMsg = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail

  // Add the current portfolio to the selectable set when the backend returns it.
  const portList = useMemo(() => data?.portfolios.current
    ? [...PORTFOLIOS, { key: 'current', label: 'Your Portfolio', blurb: 'your current allocation' }]
    : PORTFOLIOS, [data])
  const portScatter = useMemo(() => data ? PORTFOLIOS.map(p => ({ ...data.portfolios[p.key], label: p.label, key: p.key })) : [], [data])
  const currentScatter = useMemo(() => data?.portfolios.current
    ? [{ ...data.portfolios.current, label: 'Your Portfolio', key: 'current' }] : [], [data])

  return (
    <SidebarLayout sidebarWidth={230} sidebarTitle="" sidebar={<div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <label style={lbl}>Tickers · {tickers.length}</label>
          <button onClick={importPortfolio} title="Import your saved portfolio (weights)" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: BLUE }}>Import ↓</button>
        </div>
        <TickerTagInput tickers={tickers} onChange={onTickers} placeholder="Add ticker…" maxTags={20} />
        {importMsg && <div style={{ fontSize: 9, color: importMsg.startsWith('Imported') ? POS : FAINT, fontFamily: SANS, marginTop: 4, lineHeight: 1.4 }}>{importMsg}</div>}
      </div>
      {tickers.length > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <label style={lbl}>Current weights · optional</label>
            <button onClick={evenWeights} title="Set equal weights" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: BLUE }}>Even</button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {tickers.map(t => {
              const wv = weights[t] || 0
              return (
                <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, border: `1px solid ${BORDER}`, padding: '5px 7px' }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: GOLD, width: 42, flexShrink: 0 }}>{t}</span>
                  <div style={{ flex: 1, height: 5, background: 'rgba(255,255,255,0.06)', minWidth: 0 }}>
                    <div style={{ width: `${hasWeights ? Math.min(100, (wv / totalW) * 100) : 0}%`, height: '100%', background: GOLD }} />
                  </div>
                  <input type="number" min={0} step="1" value={wv || ''} onChange={e => setWeight(t, parseFloat(e.target.value) || 0)}
                    style={{ width: 46, background: 'var(--theme-bg)', border: `1px solid ${BORDER}`, color: TEXT, fontFamily: MONO, fontSize: 10, padding: '3px 5px', outline: 'none', textAlign: 'right' }} />
                </div>
              )
            })}
          </div>
          <div style={{ fontSize: 9, color: FAINT, fontFamily: SANS, marginTop: 5, lineHeight: 1.5 }}>
            {hasWeights ? `Total ${totalW.toFixed(0)}% — normalized and plotted as Your Portfolio ★` : 'Set weights (or Import) to plot your current portfolio against the optimum.'}
          </div>
        </div>
      )}
      <div>
        <label style={lbl}>Lookback</label>
        <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
          {LOOKBACKS.map((l, i) => (
            <button key={l.years} onClick={() => setLookback(l.years)} style={{ flex: 1, background: lookback === l.years ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent', border: 'none', borderRight: i < LOOKBACKS.length - 1 ? `1px solid ${BORDER}` : 'none', cursor: 'pointer', color: lookback === l.years ? GOLD : SEC, fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: '6px 0' }}>{l.label}</button>
          ))}
        </div>
      </div>
      <div>
        <label style={lbl}>Risk-free rate (annual %)</label>
        <input value={rf} onChange={e => setRf(e.target.value)} type="number" step="0.25" style={inp} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontFamily: SANS, fontSize: 11, color: TEXT }}>
        <input type="checkbox" checked={longOnly} onChange={e => setLongOnly(e.target.checked)} />
        Long-only (no shorts)
      </label>
      <button onClick={() => mutate()} disabled={!canRun} style={{ width: '100%', background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-bg)', fontFamily: SANS, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '9px 0', cursor: canRun ? 'pointer' : 'default', opacity: canRun ? 1 : 0.5 }}>
        {isPending ? 'Optimizing…' : 'Optimize'}
      </button>
      {tickers.length < 2 && <div style={{ fontSize: 9, color: FAINT, fontFamily: SANS, textAlign: 'center' }}>Enter at least 2 tickers.</div>}
      {isError && <div style={{ fontSize: 9, color: NEG, fontFamily: SANS, textAlign: 'center', lineHeight: 1.4 }}>{errMsg ?? 'Optimization failed'}</div>}
    </div>}>
      {!data && !isPending && <EmptyState title="Portfolio Optimizer" hint="Enter a basket of tickers and optimize. You get the max-Sharpe, minimum-variance, risk-parity and equal-weight portfolios, the efficient frontier, per-holding risk contribution, and tail risk (VaR/CVaR)." />}
      {isPending && <EmptyState title="Optimizing…" hint="Fetching aligned history and solving the frontier." />}

      {data && sel && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {portList.map(p => (
                <button key={p.key} onClick={() => setSelected(p.key)} title={p.blurb} style={{ background: selected === p.key ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent', border: `1px solid ${selected === p.key ? GOLD : p.key === 'current' ? NEG : BORDER}`, cursor: 'pointer', color: selected === p.key ? GOLD : p.key === 'current' ? NEG : SEC, fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: '5px 10px' }}>{p.label}</button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT }}>{data.days} days · {data.span.start} → {data.span.end}</span>
              <Provenance kind="live" source="yfinance · daily" />
            </div>
          </div>

          {/* Selected-portfolio KPI strip */}
          <div style={STRIP}>
            <KpiCell grow label="Expected Return" value={`${sel.return >= 0 ? '+' : ''}${sel.return.toFixed(1)}%`} valueSize={22} color={sel.return >= 0 ? POS : NEG} sub="annualized" />
            <KpiCell grow label="Volatility" value={`${sel.vol.toFixed(1)}%`} valueSize={22} sub="annualized" />
            <KpiCell grow label="Sharpe" value={sel.sharpe.toFixed(2)} valueSize={22} color={sel.sharpe >= 1 ? POS : GOLD} sub={`rf ${data.risk_free_rate}%`} />
            <KpiCell grow label="VaR 95%" value={`${sel.var_95.toFixed(2)}%`} valueSize={22} color={NEG} sub="1-day historical" />
            <KpiCell grow label="CVaR 95%" value={`${sel.cvar_95.toFixed(2)}%`} valueSize={22} color={NEG} sub="expected shortfall" />
            <KpiCell grow label="Max Drawdown" value={`${sel.max_drawdown.toFixed(1)}%`} valueSize={22} color={NEG} sub="over window" />
          </div>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {/* Efficient frontier */}
            <div style={{ flex: '1.3 1 440px', background: SURFACE, border: `1px solid ${BORDER}`, minWidth: 0 }}>
              <div style={{ padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GOLD }}>Efficient Frontier</div>
              <div style={{ padding: '10px 8px 4px' }}>
                <ResponsiveContainer width="100%" height={300}>
                  <ScatterChart margin={{ top: 8, right: 12, bottom: 24, left: 4 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                    <XAxis type="number" dataKey="vol" name="Volatility" unit="%" tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }} label={{ value: 'Volatility (annual %)', position: 'insideBottom', offset: -12, fontFamily: SANS, fontSize: 9, fill: FAINT }} />
                    <YAxis type="number" dataKey="return" name="Return" unit="%" tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }} width={38} label={{ value: 'Return', angle: -90, position: 'insideLeft', fontFamily: SANS, fontSize: 9, fill: FAINT }} />
                    <ZAxis range={[60, 60]} />
                    <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ background: SURFACE, border: `1px solid ${GOLD}`, fontFamily: MONO, fontSize: 10 }}
                      formatter={(v: number, n: string) => [`${v.toFixed(2)}%`, n]}
                      labelFormatter={() => ''} />
                    <Scatter name="Frontier" data={data.frontier} line={{ stroke: FAINT, strokeWidth: 1 }} fill={FAINT} shape="circle" />
                    <Scatter name="Assets" data={data.assets} fill={BLUE} shape="circle" />
                    <Scatter name="Portfolios" data={portScatter} fill={GOLD} shape="diamond">
                      {portScatter.map((p) => <Cell key={p.key} fill={p.key === selected ? GOLD : 'rgba(201,168,76,0.45)'} />)}
                    </Scatter>
                    {currentScatter.length > 0 && <Scatter name="Your Portfolio" data={currentScatter} fill={NEG} shape="star" />}
                  </ScatterChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', gap: 14, padding: '4px 10px 8px', fontFamily: SANS, fontSize: 9, color: FAINT, flexWrap: 'wrap' }}>
                  <span><span style={{ color: FAINT }}>●</span> frontier</span>
                  <span><span style={{ color: BLUE }}>●</span> each asset</span>
                  <span><span style={{ color: GOLD }}>◆</span> portfolios</span>
                  {currentScatter.length > 0 && <span><span style={{ color: NEG }}>★</span> your portfolio</span>}
                </div>
              </div>
            </div>

            {/* Weights + risk contribution for the selected portfolio */}
            <div style={{ flex: '1 1 320px', background: SURFACE, border: `1px solid ${BORDER}`, minWidth: 0 }}>
              <div style={{ padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GOLD }}>
                <span>Allocation · {portList.find(p => p.key === selected)?.label}</span>
                <span style={{ color: FAINT, letterSpacing: '0.04em' }}>weight · risk</span>
              </div>
              <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sel.weights.filter(w => Math.abs(w.weight) > 0.01).map(w => (
                  <div key={w.ticker}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 11, marginBottom: 3 }}>
                      <span style={{ fontWeight: 700, color: GOLD }}>{w.ticker}</span>
                      <span style={{ color: TEXT }}>{w.weight.toFixed(1)}% <span style={{ color: FAINT }}>· {w.risk_contribution.toFixed(0)}% risk</span></span>
                    </div>
                    <div style={{ height: 6, background: 'rgba(255,255,255,0.05)', position: 'relative' }}>
                      <div style={{ width: `${Math.min(100, Math.abs(w.weight))}%`, height: '100%', background: w.weight >= 0 ? GOLD : NEG }} />
                      <div title="risk contribution" style={{ position: 'absolute', top: 0, left: `${Math.min(100, Math.max(0, w.risk_contribution))}%`, width: 2, height: '100%', background: BLUE }} />
                    </div>
                  </div>
                ))}
                <div style={{ fontFamily: SANS, fontSize: 9, color: FAINT, marginTop: 2, lineHeight: 1.5 }}>Gold bar = capital weight; blue tick = share of portfolio risk. Risk parity aligns the two.</div>
              </div>
            </div>
          </div>

          {/* Portfolio comparison table */}
          <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, overflowX: 'auto' }}>
            <div style={{ padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GOLD }}>Portfolios Compared</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11 }}>
              <thead>
                <tr style={{ color: FAINT, fontFamily: SANS, fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
                  {['Portfolio', 'Return', 'Vol', 'Sharpe', 'VaR 95%', 'Max DD'].map((h, i) => (
                    <th key={h} style={{ textAlign: i === 0 ? 'left' : 'right', padding: '7px 12px', fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {portList.map(p => {
                  const pp = data.portfolios[p.key]
                  const on = selected === p.key
                  return (
                    <tr key={p.key} onClick={() => setSelected(p.key)} style={{ cursor: 'pointer', borderTop: `1px solid rgba(255,255,255,0.05)`, background: on ? `color-mix(in srgb, ${GOLD} 8%, transparent)` : 'transparent' }}>
                      <td style={{ padding: '8px 12px', color: on ? GOLD : TEXT, fontWeight: 700 }}>{p.label}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: pp.return >= 0 ? POS : NEG }}>{pp.return >= 0 ? '+' : ''}{pp.return.toFixed(1)}%</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: TEXT }}>{pp.vol.toFixed(1)}%</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: pp.sharpe >= 1 ? POS : TEXT }}>{pp.sharpe.toFixed(2)}</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: NEG }}>{pp.var_95.toFixed(2)}%</td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', color: NEG }}>{pp.max_drawdown.toFixed(1)}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </SidebarLayout>
  )
}

export default function PortfolioOptimizer() {
  return <PageWrapper title="Portfolio Optimizer"><PortfolioOptimizerContent /></PageWrapper>
}
