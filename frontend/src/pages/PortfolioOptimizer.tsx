import { useState, useMemo, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import axios from 'axios'
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import PageWrapper from '../components/PageWrapper'
import SidebarLayout from '../components/SidebarLayout'
import EmptyState from '../components/EmptyState'
import TickerTagInput from '../components/TickerTagInput'
import { KpiCell } from '../components/mmCockpit'
import Provenance from '../components/Provenance'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'
import PMImportPicker from '../components/PMImportPicker'
import { type ImportResult } from '../lib/pmImport'
import { Check, ChevronDown, ChevronUp, Play, X } from 'lucide-react'

const GOLD = 'var(--theme-primary, #c9a84c)'
const BLUE = 'var(--theme-tertiary, #60a5fa)'
const PURPLE = '#a78bfa'
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
interface AssetRow { ticker: string; return: number; total_return?: number; vol: number; beta?: number | null }
interface OptResult {
  tickers: string[]; dropped?: string[]; days: number; span: { start: string; end: string }; risk_free_rate: number; market_return?: number
  constraint_mode: string; bounds: Record<string, [number, number]>; return_model?: string
  portfolios: Record<string, Port>
  frontier: { vol: number; return: number; sharpe: number }[]
  assets: AssetRow[]
}

type ConstraintMode = 'long_only' | 'unconstrained' | 'concentrated' | 'custom'
// Presets for the risk-aversion coefficient A. Calibrated for this module's
// decimal-return implementation of the WRDS Efficient Portfolio Module
// appendix (w_Tang = (r_Tang-rf)/(0.1*A*sigma_Tang^2)) — NOT the ~2-10 range
// "risk aversion coefficient" conventionally means in textbook treatments
// of this same formula family with percent-scale returns. See the backend's
// _capital_allocation() docstring for the derivation.
const RISK_PRESETS: { key: string; label: string; A: number }[] = [
  { key: 'conservative', label: 'Conservative', A: 80 },
  { key: 'moderate', label: 'Moderate', A: 45 },
  { key: 'aggressive', label: 'Aggressive', A: 20 },
]

// Mirrors the backend's _capital_allocation() exactly, so the risk-aversion
// slider/presets recompute live without re-hitting the optimizer. Tangency,
// rf, and maxFrontierVol arrive in PERCENT (matching the API response); the
// WRDS 0.1/0.05 coefficients are applied in decimal internally, same as the
// backend.
function computeCapitalAllocation(
  tangency: { return: number; vol: number }, rfPct: number, riskAversion: number,
  allowLeverage: boolean, maxFrontierVolPct: number,
) {
  const A = riskAversion
  const rTang = tangency.return / 100, sigmaTang = tangency.vol / 100, rf = rfPct / 100
  let wTang = sigmaTang > 1e-9 ? (rTang - rf) / (0.1 * A * sigmaTang * sigmaTang) : 0
  wTang = Math.max(0, Math.min(wTang, allowLeverage ? 3.0 : 1.0))
  const rComplete = (1 - wTang) * rf + wTang * rTang
  const sigmaComplete = wTang * sigmaTang

  const calLine: { vol: number; return: number }[] = [
    { vol: 0, return: rf * 100 },
    { vol: sigmaTang * 100, return: rTang * 100 },
  ]
  if (allowLeverage && wTang > 1.0) {
    // Reach at least sigmaComplete, whatever wTang turns out to be — not a
    // fixed multiplier of sigmaTang — keeping the CAL visible beyond the
    // drawn line instead of floating past its end.
    const extVol = Math.max(sigmaTang * 1.5, sigmaComplete * 1.15)
    calLine.push({ vol: extVol * 100, return: (rf + (rTang - rf) / sigmaTang * extVol) * 100 })
  }

  const uStar = rComplete - 0.05 * A * sigmaComplete * sigmaComplete
  const span = Math.max(maxFrontierVolPct / 100, sigmaComplete * 1.3, sigmaTang * 1.2, 0.01)
  const indifferenceCurve = Array.from({ length: 30 }, (_, i) => {
    const v = (span / 29) * i
    return { vol: v * 100, return: (uStar + 0.05 * A * v * v) * 100 }
  })

  return {
    weightTangency: wTang * 100, weightRiskFree: (1 - wTang) * 100,
    completeReturn: rComplete * 100, completeVol: sigmaComplete * 100,
    calLine, indifferenceCurve,
  }
}

const startFor = (years: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - years); return d.toISOString().slice(0, 10) }

// Names the hovered point — a ticker for asset dots, the portfolio label for the
// diamonds/star, or "Frontier" for the frontier line.
function ChartTip({ active, payload }: { active?: boolean; payload?: { payload: { ticker?: string; label?: string; key?: string; return?: number; vol?: number; sharpe?: number } }[] }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const name = p.ticker || p.label || 'Efficient frontier'
  const color = GOLD
  return (
    <div style={{ background: SURFACE, border: `1px solid ${GOLD}`, padding: '6px 9px', fontFamily: MONO, fontSize: 10 }}>
      <div style={{ color, fontWeight: 700, marginBottom: 2 }}>{name}</div>
      {p.return != null && <div style={{ color: TEXT }}>Return {p.return.toFixed(1)}%</div>}
      {p.vol != null && <div style={{ color: SEC }}>Vol {p.vol.toFixed(1)}%</div>}
      {p.sharpe != null && <div style={{ color: SEC }}>Sharpe {p.sharpe.toFixed(2)}</div>}
    </div>
  )
}

export function PortfolioOptimizerContent() {
  const [tickers, setTickers] = useState<string[]>(['AAPL', 'MSFT', 'NVDA', 'TLT', 'GLD'])
  const [lookback, setLookback] = useState(3)
  const [rf, setRf] = useState('4.00')
  const [constraintMode, setConstraintMode] = useState<ConstraintMode>('long_only')
  const [customBounds, setCustomBounds] = useState<Record<string, [number, number]>>({})
  const [riskPreset, setRiskPreset] = useState('moderate')
  const [returnModel, setReturnModel] = useState<'historical' | 'capm'>('historical')
  const [marketReturn, setMarketReturn] = useState('10')
  const [selected, setSelected] = useState('max_sharpe')
  const [controlsCollapsed, setControlsCollapsed] = useState(false)
  const [series, setSeries] = useState({ frontier: true, cal: true, indifference: true, holdings: true, portfolios: true })
  const [asset, setAsset] = useState<AssetRow | null>(null)   // clicked frontier dot → popup
  // Per-ticker weights (%) define the CURRENT portfolio, plotted against the optimum.
  const [weights, setWeights] = useState<Record<string, number>>({})
  const [importMsg, setImportMsg] = useState('')
  const riskAversion = RISK_PRESETS.find(p => p.key === riskPreset)?.A ?? 45

  // Auto-populate the risk-free rate from the live Treasury curve (3-month bill).
  useEffect(() => {
    axios.get('/api/rates/risk-free').then(r => {
      const v = r.data?.rate
      if (typeof v === 'number') setRf((v * 100).toFixed(2))
    }).catch(() => { /* keep the default */ })
  }, [])

  // Load any saved Portfolio Manager portfolio (value-weighted equity legs), same
  // as Monte Carlo / the Backtester. Sets the basket AND the weights so the current
  // portfolio is plotted against the optimum.
  const loadFromPM = (result: ImportResult, name: string) => {
    const legs = result.legs.filter(l => l.ticker && l.ticker.toUpperCase() !== 'CASH')
    if (legs.length < 2) { setImportMsg(`"${name}" needs 2+ equity holdings to optimize.`); return }
    setTickers(legs.map(l => l.ticker.toUpperCase()))
    setWeights(Object.fromEntries(legs.map(l => [l.ticker.toUpperCase(), l.weight])))
    setImportMsg(`Loaded "${name}" — ${legs.length} holdings.`)
  }
  const onTickers = (t: string[]) => {
    setTickers(t)
    // Keep weights only for tickers still in the set.
    setWeights(w => Object.fromEntries(Object.entries(w).filter(([k]) => t.includes(k))))
    setImportMsg('')
  }
  // Full import screen (CSV/JSON file, paste) — same PortfolioIO the other tools use.
  const importAssets = (imported: PortfolioAsset[]) => {
    const valid = imported.filter(a => a.ticker)
    if (!valid.length) return
    setTickers(valid.map(a => a.ticker.toUpperCase()))
    setWeights(Object.fromEntries(valid.map(a => [a.ticker.toUpperCase(), Number(a.weight) || 0])))
    setImportMsg(`Imported ${valid.length} holdings.`)
  }
  const setWeight = (t: string, v: number) => setWeights(w => ({ ...w, [t]: Math.max(0, v) }))
  const evenWeights = () => setWeights(Object.fromEntries(tickers.map(t => [t, +(100 / tickers.length).toFixed(1)])))
  const totalW = tickers.reduce((s, t) => s + (weights[t] || 0), 0)
  const hasWeights = totalW > 0

  const { mutate, data, isPending, isError, error } = useMutation<OptResult>({
    mutationFn: async () => (await axios.post('/api/portfolio-opt/optimize', {
      tickers, start: startFor(lookback), end: new Date().toISOString().slice(0, 10),
      risk_free_rate: parseFloat(rf) || 0, constraint_mode: constraintMode,
      custom_bounds: constraintMode === 'custom'
        ? Object.fromEntries(tickers.map(t => { const [lo, hi] = customBounds[t] ?? [0, 100]; return [t, [lo / 100, hi / 100]] }))
        : undefined,
      risk_aversion: riskAversion,
      return_model: returnModel, market_return: parseFloat(marketReturn) || 10,
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

  // Capital Allocation Line + indifference curve,
  // recomputed CLIENT-SIDE from the tangency portfolio the backend already
  // returned — the risk-preset buttons update this instantly with no re-fetch.
  const allowLeverage = data ? data.constraint_mode !== 'long_only' : false
  const maxFrontierVol = useMemo(() => data?.frontier.length ? Math.max(...data.frontier.map(f => f.vol)) : 20, [data])
  const capitalAllocation = useMemo(() => {
    if (!data?.portfolios.max_sharpe) return null
    return computeCapitalAllocation(data.portfolios.max_sharpe, data.risk_free_rate, riskAversion, allowLeverage, maxFrontierVol)
  }, [data, riskAversion, allowLeverage, maxFrontierVol])
  // Axis domains fitted to the data (padded) so the frontier always fills the
  // chart instead of hugging a corner of a 0-anchored axis.
  const [xDom, yDom] = useMemo(() => {
    const def: [[number, number], [number, number]] = [[0, 1], [0, 1]]
    if (!data) return def
    const calPts = capitalAllocation?.calLine ?? []
    const pts = [...data.frontier, ...data.assets, ...portScatter, ...currentScatter, ...calPts]
    if (!pts.length) return def
    const fit = (arr: number[], clampLo?: number): [number, number] => {
      const lo = Math.min(...arr), hi = Math.max(...arr)
      const pad = (Math.abs(hi - lo) || Math.abs(hi) || 1) * 0.1
      const a = lo - pad
      return [clampLo != null ? Math.max(clampLo, a) : a, hi + pad]
    }
    return [fit(pts.map(p => p.vol), 0), fit(pts.map(p => p.return))]
  }, [data, portScatter, currentScatter, capitalAllocation])

  return (
    <SidebarLayout sidebarWidth={0} sidebarTitle="" sidebar={<div style={{ display: 'none', padding: 14, flexDirection: 'column', gap: 12 }}>
      <div>
        <label style={lbl}>Tickers · {tickers.length}</label>
        <TickerTagInput tickers={tickers} onChange={onTickers} placeholder="Add ticker…" maxTags={20} />
        {importMsg && <div style={{ fontSize: 9, color: importMsg.startsWith('Loaded') ? POS : FAINT, fontFamily: SANS, marginTop: 4, lineHeight: 1.4 }}>{importMsg}</div>}
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
      {/* Load a saved Portfolio Manager portfolio + full CSV/JSON import/export. */}
      <div>
        <label style={lbl}>Load / Import</label>
        <PMImportPicker style={{ ...inp, appearance: 'none', cursor: 'pointer' }} onImport={loadFromPM} />
        <div style={{ marginTop: 8 }}>
          <PortfolioIO mode="portfolio" name="optimizer"
            assets={tickers.map(t => ({ ticker: t, weight: weights[t] || 0 }))}
            onImportAssets={importAssets} />
        </div>
      </div>
      <div>
        <label style={lbl}>Lookback</label>
        <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
          {LOOKBACKS.map((l, i) => (
            <button key={l.years} onClick={() => setLookback(l.years)} style={{ flex: 1, background: lookback === l.years ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent', border: 'none', borderRight: i < LOOKBACKS.length - 1 ? `1px solid ${BORDER}` : 'none', cursor: 'pointer', color: lookback === l.years ? GOLD : SEC, fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: '6px 0' }}>{l.label}</button>
          ))}
        </div>
      </div>
      <div>
        <label style={lbl}>Expected returns</label>
        <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
          {([['historical', 'Historical'], ['capm', 'CAPM']] as const).map(([k, lab], i) => (
            <button key={k} onClick={() => setReturnModel(k)} title={k === 'capm' ? 'Forward-looking: rf + beta × equity-risk-premium' : 'Realized geometric return over the window'}
              style={{ flex: 1, background: returnModel === k ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent', border: 'none', borderRight: i === 0 ? `1px solid ${BORDER}` : 'none', cursor: 'pointer', color: returnModel === k ? GOLD : SEC, fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: '6px 0' }}>{lab}</button>
          ))}
        </div>
        <div style={{ fontSize: 9, color: FAINT, fontFamily: SANS, marginTop: 4, lineHeight: 1.4 }}>
          {returnModel === 'capm' ? 'rf + β × (market return − rf), β vs SPY — forward-looking.' : 'Realized compound return over the window.'}
        </div>
      </div>
      {returnModel === 'capm' && (
        <div>
          <label style={lbl}>Expected market return (annual %)</label>
          <input value={marketReturn} onChange={e => setMarketReturn(e.target.value)} type="number" step="0.5" style={inp} />
          <div style={{ fontSize: 9, color: FAINT, fontFamily: SANS, marginTop: 3 }}>Premium = {marketReturn || '10'}% − {rf || '4'}% rf = {(( parseFloat(marketReturn) || 10) - (parseFloat(rf) || 4)).toFixed(1)}%</div>
        </div>
      )}
      <div>
        <label style={lbl}>Risk-free rate (annual %)</label>
        <input value={rf} onChange={e => setRf(e.target.value)} type="number" step="0.25" style={inp} />
      </div>
      <div>
        <label style={lbl}>Weight bounds</label>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', border: `1px solid ${BORDER}` }}>
          {([['long_only', 'Long-only'], ['unconstrained', 'Shorts OK'], ['concentrated', '±10%'], ['custom', 'Custom']] as [ConstraintMode, string][]).map(([k, lab]) => (
            <button key={k} onClick={() => setConstraintMode(k)} title={
              k === 'long_only' ? 'No shorts, each holding 0-100%' :
              k === 'unconstrained' ? 'Shorts allowed, each holding -100% to 100%' :
              k === 'concentrated' ? 'WRDS-style preset: each holding capped at ±10% — needs 10+ names to reach 100%' :
              'Set your own min/max % per holding below'
            } style={{ background: constraintMode === k ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent', border: 'none', borderBottom: `1px solid ${BORDER}`, cursor: 'pointer', color: constraintMode === k ? GOLD : SEC, fontFamily: MONO, fontSize: 9.5, fontWeight: 700, padding: '6px 2px' }}>{lab}</button>
          ))}
        </div>
        {constraintMode === 'custom' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
            {tickers.map(t => {
              const [lo, hi] = customBounds[t] ?? [0, 100]
              return (
                <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: GOLD, width: 34, flexShrink: 0 }}>{t}</span>
                  <input type="number" value={lo} onChange={e => setCustomBounds(cb => ({ ...cb, [t]: [parseFloat(e.target.value) || 0, hi] }))}
                    style={{ width: 0, flex: 1, background: 'var(--theme-bg)', border: `1px solid ${BORDER}`, color: TEXT, fontFamily: MONO, fontSize: 9, padding: '3px', outline: 'none', textAlign: 'right' }} />
                  <span style={{ color: FAINT, fontSize: 9 }}>–</span>
                  <input type="number" value={hi} onChange={e => setCustomBounds(cb => ({ ...cb, [t]: [lo, parseFloat(e.target.value) || 0] }))}
                    style={{ width: 0, flex: 1, background: 'var(--theme-bg)', border: `1px solid ${BORDER}`, color: TEXT, fontFamily: MONO, fontSize: 9, padding: '3px', outline: 'none', textAlign: 'right' }} />
                  <span style={{ color: FAINT, fontSize: 9 }}>%</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
      <div>
        <label style={lbl}>Risk tolerance</label>
        <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
          {RISK_PRESETS.map((p, i) => (
            <button key={p.key} onClick={() => setRiskPreset(p.key)} title="Drives the Capital Allocation Line — how much of the tangency portfolio vs. cash. Updates instantly, no re-run needed."
              style={{ flex: 1, background: riskPreset === p.key ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent', border: 'none', borderRight: i < RISK_PRESETS.length - 1 ? `1px solid ${BORDER}` : 'none', cursor: 'pointer', color: riskPreset === p.key ? GOLD : SEC, fontFamily: MONO, fontSize: 9.5, fontWeight: 700, padding: '6px 0' }}>{p.label}</button>
          ))}
        </div>
      </div>
      <button onClick={() => mutate()} disabled={!canRun} style={{ width: '100%', background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-bg)', fontFamily: SANS, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '9px 0', cursor: canRun ? 'pointer' : 'default', opacity: canRun ? 1 : 0.5 }}>
        {isPending ? 'Optimizing…' : 'Optimize'}
      </button>
      {tickers.length < 2 && <div style={{ fontSize: 9, color: FAINT, fontFamily: SANS, textAlign: 'center' }}>Enter at least 2 tickers.</div>}
      {isError && <div style={{ fontSize: 9, color: NEG, fontFamily: SANS, textAlign: 'center', lineHeight: 1.4 }}>{errMsg ?? 'Optimization failed'}</div>}
    </div>}>
      <div style={{ width: '100%', maxWidth: 1320, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: 'rgba(0,0,0,0.12)', borderBottom: `1px solid ${BORDER}`, flexWrap: 'wrap' }}>
            <span style={{ ...lbl, margin: 0, color: GOLD }}>Portfolio Controls</span>
            {Math.abs(totalW - 100) < .05 ? <span style={{ fontFamily: MONO, fontSize: 10, color: POS, fontWeight: 700 }}>100%</span> : <button onClick={evenWeights} style={{ background: 'none', border: 'none', color: NEG, cursor: 'pointer', fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: 0 }}>{totalW.toFixed(0)}% → equal weight</button>}
            {importMsg && <span style={{ fontFamily: MONO, fontSize: 9, color: importMsg.startsWith('Loaded') ? POS : FAINT }}>{importMsg}</span>}
            <button onClick={() => setControlsCollapsed(v => !v)} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: SEC, cursor: 'pointer', fontFamily: MONO, fontSize: 10, padding: 0 }}>{controlsCollapsed ? <ChevronDown size={12} /> : <ChevronUp size={12} />}{controlsCollapsed ? 'Expand' : 'Collapse'}</button>
            <span style={{ marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: FAINT }}>{lookback}Y · {returnModel === 'capm' ? 'CAPM' : 'Historical'} · rf {rf}%</span>
            <PMImportPicker onImport={loadFromPM} style={{ ...inp, width: 'auto', minWidth: 190, padding: '7px 9px', cursor: 'pointer' }} />
            <button onClick={() => mutate()} disabled={!canRun} style={{ display: 'flex', alignItems: 'center', gap: 6, background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-bg)', fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '8px 13px', cursor: canRun ? 'pointer' : 'default', opacity: canRun ? 1 : .5 }}><Play size={11} fill="currentColor" />{isPending ? 'Optimizing' : 'Optimize'}</button>
          </div>
          <div style={{ display: 'flex', height: 4, background: 'rgba(255,255,255,.05)' }}>{tickers.map((t, i) => <div key={t} style={{ flex: Math.max(weights[t] || 1, 1), background: i % 2 ? `color-mix(in srgb, ${GOLD} 70%, #000)` : GOLD }} />)}</div>
          {controlsCollapsed ? <div style={{ padding: '11px 16px', color: SEC, fontFamily: MONO, fontSize: 10 }}>{tickers.join(' · ')} · {lookback}Y · {constraintMode.replace('_', ' ')}</div> : <div style={{ display: 'flex', flexWrap: 'wrap' }}>
            <div style={{ flex: '1.4 1 420px', minWidth: 0, padding: '14px 16px', borderRight: `1px solid ${BORDER}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}><span style={lbl}>Holdings · Constraint</span><span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{tickers.length} assets</span></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: 8 }}>
                {tickers.map((t, i) => <div key={t} style={{ background: 'color-mix(in srgb, var(--theme-surface, #0d1826) 100%, #000 8%)', border: `1px solid ${BORDER}`, padding: '8px 9px', boxShadow: '0 1px 5px rgba(0,0,0,.35)' }}>
                  <div style={{ display: 'flex', gap: 4 }}><input value={t} onChange={e => onTickers(tickers.map(x => x === t ? e.target.value.toUpperCase() : x))} style={{ ...inp, padding: '3px 6px', fontWeight: 700 }} /><button onClick={() => onTickers(tickers.filter(x => x !== t))} aria-label={`Remove ${t}`} style={{ background: 'none', border: 'none', color: FAINT, cursor: 'pointer', padding: 0 }}><X size={14} /></button></div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}><input type="number" value={weights[t] || ''} onChange={e => setWeight(t, parseFloat(e.target.value) || 0)} style={{ ...inp, width: 52, padding: '3px 4px', color: GOLD, textAlign: 'center', fontWeight: 700 }} /><div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,.08)' }}><div style={{ width: `${hasWeights ? Math.min(100, ((weights[t] || 0) / totalW) * 100) : 0}%`, height: '100%', background: i % 2 ? `color-mix(in srgb, ${GOLD} 70%, #000)` : GOLD }} /></div></div>
                  <select value={constraintMode} onChange={e => setConstraintMode(e.target.value as ConstraintMode)} style={{ ...inp, marginTop: 7, padding: '4px 6px', cursor: 'pointer' }}><option value="long_only">No bound, 0 to 100%</option><option value="concentrated">Long-only cap 10%</option><option value="custom">Custom range</option><option value="unconstrained">Shorts allowed</option></select>
                </div>)}
                <button onClick={() => onTickers([...tickers, ''])} style={{ minHeight: 100, background: 'none', border: `1px dashed ${BORDER}`, color: SEC, cursor: 'pointer', fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>+ Add asset</button>
              </div>
            </div>
            <div style={{ flex: '1 1 300px', padding: '14px 16px' }}>
              <span style={lbl}>Parameters</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={lbl}>Lookback<select value={lookback} onChange={e => setLookback(+e.target.value)} style={inp}>{LOOKBACKS.map(l => <option key={l.years} value={l.years}>{l.label}</option>)}</select></label>
                <label style={lbl}>Expected returns<select value={returnModel} onChange={e => setReturnModel(e.target.value as 'historical' | 'capm')} style={inp}><option value="historical">Historical</option><option value="capm">CAPM</option></select></label>
                <label style={lbl}>Risk-free %<input value={rf} onChange={e => setRf(e.target.value)} type="number" style={inp} /></label>
                <label style={lbl}>Risk tolerance<select value={riskPreset} onChange={e => setRiskPreset(e.target.value)} style={inp}>{RISK_PRESETS.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
                {returnModel === 'capm' && <label style={lbl}>Market return %<input value={marketReturn} onChange={e => setMarketReturn(e.target.value)} type="number" style={inp} /></label>}
              </div>
            </div>
          </div>}
        </div>

      {!data && !isPending && <EmptyState title="Portfolio Optimizer" hint="Enter a basket of tickers, then compare optimized allocations and portfolio risk."
        action="Optimize" />}
      {isPending && <EmptyState title="Optimizing…" hint="Fetching aligned history and solving the frontier." variant="loading" />}

      {data && sel && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0, background: SURFACE, border: `1px solid ${BORDER}`, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', minHeight: 36, padding: '4px 12px', gap: 12, borderBottom: `1px solid ${BORDER}`, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <span style={{ ...lbl, margin: '0 5px 0 0' }}>Portfolio</span>
              {portList.map(p => <button key={p.key} onClick={() => setSelected(p.key)} title={p.blurb} style={{ background: selected === p.key ? `color-mix(in srgb, ${GOLD} 14%, transparent)` : 'transparent', border: `1px solid ${selected === p.key ? `color-mix(in srgb, ${GOLD} 55%, transparent)` : BORDER}`, cursor: 'pointer', color: selected === p.key ? GOLD : p.key === 'current' ? NEG : SEC, fontFamily: MONO, fontSize: 9, fontWeight: 700, padding: '4px 7px' }}>{p.label}</button>)}
            </div>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              {data.dropped && data.dropped.length > 0 && <span title="Dropped from the optimization because the available history was too short." style={{ fontFamily: MONO, fontSize: 9, fontWeight: 700, color: NEG }}>dropped: {data.dropped.join(', ')}</span>}
              <span style={{ fontFamily: MONO, fontSize: 9, color: FAINT }}>{data.days} days · {data.span.start} → {data.span.end}</span>
              <Provenance kind="live" source="yfinance · daily" />
            </div>
          </div>

          {/* Selected-portfolio KPI strip */}
          <div style={STRIP}>
            <KpiCell grow align="top" label="Expected Return" value={`${sel.return >= 0 ? '+' : ''}${sel.return.toFixed(1)}%`} valueSize={20} color={sel.return >= 0 ? POS : NEG} sub={data.return_model === 'capm' ? 'CAPM · forward' : 'realized · annualized'} />
            <KpiCell grow align="top" label="Volatility" value={`${sel.vol.toFixed(1)}%`} valueSize={20} sub="annualized" />
            <KpiCell grow align="top" label="Sharpe" value={sel.sharpe.toFixed(2)} valueSize={20} color={sel.sharpe >= 1 ? POS : GOLD} sub={`rf ${data.risk_free_rate}%`} />
            <KpiCell grow align="top" label="VaR 95%" value={`${sel.var_95.toFixed(2)}%`} valueSize={20} color={NEG} sub="1-day historical" help="Value at Risk. On a normal day the portfolio should not lose more than this. Read as: 95% of days lose less, 1 day in 20 loses more. Based on the actual daily returns over the window, not a bell curve." />
            <KpiCell grow align="top" label="CVaR 95%" value={`${sel.cvar_95.toFixed(2)}%`} valueSize={20} color={NEG} sub="expected shortfall" help="Conditional VaR, or expected shortfall. On the worst 1 day in 20 (the days past VaR), this is the average loss. Always at least as large as VaR and captures how deep the tail goes." />
            <KpiCell grow align="top" label="Max Drawdown" value={`${sel.max_drawdown.toFixed(1)}%`} valueSize={20} color={NEG} sub="over window" />
          </div>

          <div style={{ display: 'flex', gap: 0, flexWrap: 'wrap', alignItems: 'stretch', borderTop: `1px solid ${BORDER}` }}>
            {/* Efficient frontier */}
            <div style={{ flex: '1.3 1 440px', background: SURFACE, minWidth: 0 }}>
              <div style={{ padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GOLD }}>Efficient Frontier</div>
              <div style={{ padding: '10px 8px 4px' }}>
                <ResponsiveContainer width="100%" height={300}>
                  <ScatterChart margin={{ top: 8, right: 12, bottom: 24, left: 4 }}>
                    <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                    <XAxis type="number" dataKey="vol" name="Volatility" domain={xDom} allowDataOverflow tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }} tickFormatter={(v: number) => `${v.toFixed(0)}%`} label={{ value: 'Volatility (annual %)', position: 'insideBottom', offset: -12, fontFamily: SANS, fontSize: 9, fill: FAINT }} />
                    <YAxis type="number" dataKey="return" name="Return" domain={yDom} allowDataOverflow tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }} width={40} tickFormatter={(v: number) => `${v.toFixed(0)}%`} label={{ value: 'Return', angle: -90, position: 'insideLeft', fontFamily: SANS, fontSize: 9, fill: FAINT }} />
                    <ZAxis range={[60, 60]} />
                    <Tooltip cursor={{ strokeDasharray: '3 3' }} content={<ChartTip />} />
                    {series.frontier && <Scatter isAnimationActive={false} name="Frontier" data={data.frontier} line={{ stroke: GOLD, strokeWidth: 1.5 }} fill="transparent" />}
                    {series.cal && capitalAllocation && <Scatter isAnimationActive={false} name="Capital Allocation Line" data={capitalAllocation.calLine} line={{ stroke: GOLD, strokeWidth: 1.5, strokeDasharray: '5 3' }} fill="transparent" />}
                    {series.indifference && capitalAllocation && <Scatter isAnimationActive={false} name="Indifference Curve" data={capitalAllocation.indifferenceCurve} line={{ stroke: GOLD, strokeWidth: 1.2, strokeDasharray: '2 3' }} fill="transparent" />}
                    {series.holdings && <Scatter isAnimationActive={false} name="Assets" data={data.assets} fill="var(--theme-bg, #101c2e)" stroke={GOLD} strokeWidth={2} shape="circle" cursor="pointer" onClick={(pt: unknown) => { const p = (pt as { payload?: AssetRow })?.payload ?? (pt as AssetRow); if (p?.ticker) setAsset(p) }} />}
                    {series.portfolios && <Scatter isAnimationActive={false} name="Portfolios" data={portScatter} fill="var(--theme-bg, #101c2e)" stroke={GOLD} strokeWidth={2} shape="diamond" />}
                    {series.portfolios && currentScatter.length > 0 && <Scatter isAnimationActive={false} name="Your Portfolio" data={currentScatter} fill="var(--theme-bg, #101c2e)" stroke={GOLD} strokeWidth={2} shape="star" />}
                  </ScatterChart>
                </ResponsiveContainer>
                <div style={{ display: 'flex', gap: 10, padding: '4px 10px 8px', fontFamily: SANS, fontSize: 9, color: FAINT, flexWrap: 'wrap' }}>
                  {series.frontier && <span><span style={{ color: GOLD }}>─</span> frontier</span>}
                  {series.cal && <span><span style={{ color: GOLD }}>- -</span> capital allocation line</span>}
                  {series.indifference && <span><span style={{ color: GOLD }}>··</span> indifference curve</span>}
                  {series.holdings && <span title="Click an asset for its beta and expected return"><span style={{ color: GOLD }}>●</span> assets</span>}
                  {series.portfolios && <span><span style={{ color: GOLD }}>◆</span> portfolios</span>}
                  {series.portfolios && currentScatter.length > 0 && <span><span style={{ color: GOLD }}>★</span> your portfolio</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 10px 9px', borderTop: `1px solid ${BORDER}`, flexWrap: 'wrap' }}>
                  <span style={{ ...lbl, margin: '0 6px 0 0' }}>Series</span>
                  {(Object.entries(series) as [keyof typeof series, boolean][]).map(([key, on]) => {
                    const label = key === 'holdings' ? 'Assets' : key === 'indifference' ? 'Indifference' : key === 'cal' ? 'Capital Allocation' : key[0].toUpperCase() + key.slice(1)
                    return <button key={key} type="button" aria-pressed={on} onClick={() => setSeries(s => ({ ...s, [key]: !s[key] }))} style={{ display: 'flex', alignItems: 'center', gap: 5, minHeight: 24, padding: '0 7px', background: on ? `color-mix(in srgb, ${GOLD} 9%, transparent)` : 'transparent', border: `1px solid ${on ? `color-mix(in srgb, ${GOLD} 34%, transparent)` : 'transparent'}`, color: on ? TEXT : SEC, cursor: 'pointer', fontFamily: MONO, fontSize: 9, fontWeight: 700 }}>
                      <span aria-hidden="true" style={{ width: 12, height: 12, display: 'grid', placeItems: 'center', background: on ? GOLD : 'transparent', border: `1px solid ${on ? GOLD : BORDER}`, color: 'var(--theme-bg, #101c2e)', flexShrink: 0 }}>{on && <Check size={10} strokeWidth={3} />}</span>
                      {label}
                    </button>
                  })}
                </div>
                {capitalAllocation && (
                  <div style={{ margin: '2px 10px 8px', padding: '9px 2px 2px', borderTop: `1px solid ${BORDER}` }}>
                    <div style={{ fontFamily: SANS, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: GOLD, marginBottom: 4 }}>Optimal mix · {RISK_PRESETS.find(p => p.key === riskPreset)?.label}</div>
                    <div style={{ fontFamily: MONO, fontSize: 12, color: TEXT }}>
                      {capitalAllocation.weightRiskFree < 0
                        ? <>{capitalAllocation.weightTangency.toFixed(0)}% Tangency Portfolio <span style={{ color: FAINT }}>(borrowing {Math.abs(capitalAllocation.weightRiskFree).toFixed(0)}% at the risk-free rate)</span></>
                        : <>{capitalAllocation.weightTangency.toFixed(0)}% Tangency Portfolio / {capitalAllocation.weightRiskFree.toFixed(0)}% Cash</>}
                      <span style={{ color: FAINT }}> — </span>
                      {capitalAllocation.completeReturn.toFixed(1)}% return, {capitalAllocation.completeVol.toFixed(1)}% vol
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Weights + risk contribution for the selected portfolio */}
            <div style={{ flex: '1 1 320px', background: SURFACE, borderLeft: `1px solid ${BORDER}`, minWidth: 0 }}>
              <div style={{ padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GOLD }}>
                <span>Allocation · {portList.find(p => p.key === selected)?.label}</span>
                <span style={{ color: FAINT, letterSpacing: '0.04em' }}>weight · risk</span>
              </div>
              <div style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {sel.weights.filter(w => Math.abs(w.weight) > 0.01).map(w => (
                  <div key={w.ticker}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: MONO, fontSize: 11, marginBottom: 3 }}>
                      <span style={{ fontWeight: 700, color: GOLD }}>{w.ticker}</span>
                      <span style={{ color: TEXT }}>{w.weight.toFixed(1)}% <span style={{ color: FAINT }}>· {w.risk_contribution.toFixed(1)}% risk</span></span>
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
          <div style={{ background: SURFACE, borderTop: `1px solid ${BORDER}`, overflowX: 'auto' }}>
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

          {/* Per-asset popup: beta + how E(r) is computed. */}
          {asset && (() => {
            const rf0 = data.risk_free_rate
            const mkt = data.market_return ?? 10
            const capm = data.return_model === 'capm' && asset.beta != null
            return (
              <div onClick={() => setAsset(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 90, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div onClick={e => e.stopPropagation()} style={{ background: SURFACE, border: `1px solid ${GOLD}`, minWidth: 300, maxWidth: '92vw' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: `1px solid ${BORDER}` }}>
                    <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: GOLD }}>{asset.ticker}</span>
                    <button onClick={() => setAsset(null)} aria-label="Close" style={{ background: 'none', border: 'none', color: SEC, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
                  </div>
                  <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: MONO, fontSize: 11 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: SEC }}>Beta (vs SPY)</span><span style={{ color: TEXT, fontWeight: 700 }}>{asset.beta != null ? asset.beta.toFixed(2) : '—'}</span></div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: SEC }}>Volatility (annual)</span><span style={{ color: TEXT, fontWeight: 700 }}>{asset.vol.toFixed(1)}%</span></div>
                    <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 9, marginTop: 2 }}>
                      <div style={{ ...lbl, marginBottom: 6 }}>Expected return · {capm ? 'CAPM' : 'Historical'}</div>
                      {capm ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, color: SEC, lineHeight: 1.5 }}>
                          <div>E(r) = r_f + β × (E[R_m] − r_f)</div>
                          <div>= {rf0}% + {asset.beta!.toFixed(2)} × ({mkt}% − {rf0}%)</div>
                          <div>= {rf0}% + {asset.beta!.toFixed(2)} × {(mkt - rf0).toFixed(1)}%</div>
                          <div style={{ color: asset.return >= 0 ? POS : NEG, fontWeight: 700, fontSize: 15, marginTop: 4 }}>= {asset.return.toFixed(1)}%</div>
                        </div>
                      ) : (
                        <div style={{ color: SEC, lineHeight: 1.5 }}>
                          Expected return here is the realized return annualized (geometric),
                          not the raw total. Total return over the window is compounded down to a
                          per-year rate:
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                            {asset.total_return != null && (
                              <div>Total return over {data.days}d = <span style={{ color: asset.total_return >= 0 ? POS : NEG }}>{asset.total_return.toFixed(1)}%</span></div>
                            )}
                            <div>E(r) = (1 + total)<sup>252 / {data.days}</sup> − 1</div>
                            <div style={{ color: asset.return >= 0 ? POS : NEG, fontWeight: 700, fontSize: 15, marginTop: 4 }}>= {asset.return.toFixed(1)}% / yr</div>
                          </div>
                          <div style={{ color: FAINT, fontSize: 9, marginTop: 6 }}>Beta shown for reference; it does not drive the historical return.</div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })()}
        </div>
      )}
      </div>
    </SidebarLayout>
  )
}

export default function PortfolioOptimizer() {
  return <PageWrapper title="Portfolio Optimizer"><PortfolioOptimizerContent /></PageWrapper>
}
