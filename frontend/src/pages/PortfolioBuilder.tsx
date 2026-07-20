import { useState, useMemo, useEffect, useRef } from 'react'
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { ScatterChart, Scatter, LineChart, Line, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { CROSSHAIR_CURSOR } from '../components/ChartTooltip'
import PageWrapper from '../components/PageWrapper'
import EmptyState from '../components/EmptyState'
import Provenance from '../components/Provenance'
import { KpiCell } from '../components/mmCockpit'
import { Lock, RefreshCw, Unlock, X } from 'lucide-react'
import PMImportPicker from '../components/PMImportPicker'
import { type ImportResult } from '../lib/pmImport'

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

const lbl: React.CSSProperties = { fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: FAINT, fontFamily: SANS, marginBottom: 6, display: 'block' }
const inp: React.CSSProperties = { background: 'var(--theme-bg)', border: `1px solid color-mix(in srgb, ${GOLD} 30%, transparent)`, color: TEXT, fontFamily: MONO, fontSize: 11, padding: '7px 10px', outline: 'none', width: '100%', boxSizing: 'border-box' }

// Same calibration as the Optimizer's risk-aversion presets — see backend
// _capital_allocation()'s docstring for why A is 20-80, not the textbook 2-10.
const RISK_PRESETS: { key: string; label: string; A: number }[] = [
  { key: 'conservative', label: 'Conservative', A: 80 },
  { key: 'moderate', label: 'Moderate', A: 45 },
  { key: 'aggressive', label: 'Aggressive', A: 20 },
]
const PERIODS: { key: string; label: string }[] = [
  { key: '1d', label: '1D' }, { key: '1w', label: '1W' }, { key: '1m', label: '1M' }, { key: '1y', label: '1Y' }, { key: '5y', label: '5Y' },
]
const PM_PORTFOLIOS_KEY = 'pm-portfolios-v2'
const genId = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random())
const startFor = (years: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - years); return d.toISOString().slice(0, 10) }
// Fractional shares — show up to 4 decimals, trimmed, no trailing zeros.
const fmtShares = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''))

interface WeightRow { ticker: string; weight: number; risk_contribution: number }
interface Port { return: number; vol: number; sharpe: number; weights: WeightRow[]; var_95: number; cvar_95: number; max_drawdown: number }
interface AssetRow { ticker: string; return: number; total_return?: number; vol: number; beta?: number | null }
interface OptResult {
  tickers: string[]; dropped?: string[]; days: number; span: { start: string; end: string }; risk_free_rate: number
  portfolios: Record<string, Port>
  frontier: { vol: number; return: number; sharpe: number }[]
  assets: AssetRow[]
  covariance?: number[][]
}

// Mirrors the backend's _capital_allocation() exactly — the risk-tolerance
// buttons recompute this instantly client-side, no re-fetch needed.
function computeCapitalAllocation(
  tangency: { return: number; vol: number }, rfPct: number, riskAversion: number, maxFrontierVolPct: number,
) {
  const A = riskAversion
  const rTang = tangency.return / 100, sigmaTang = tangency.vol / 100, rf = rfPct / 100
  let wTang = sigmaTang > 1e-9 ? (rTang - rf) / (0.1 * A * sigmaTang * sigmaTang) : 0
  wTang = Math.max(0, Math.min(wTang, 1.0))
  const rComplete = (1 - wTang) * rf + wTang * rTang
  const sigmaComplete = wTang * sigmaTang
  const calLine = [{ vol: 0, return: rf * 100 }, { vol: sigmaTang * 100, return: rTang * 100 }]
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

function FrontierTip({ active, payload }: { active?: boolean; payload?: { payload: { ticker?: string; label?: string; return?: number; vol?: number; sharpe?: number } }[] }) {
  if (!active || !payload?.length) return null
  const p = payload[0].payload
  const name = p.ticker || p.label || 'Efficient frontier'
  return (
    <div style={{ background: SURFACE, border: `1px solid ${GOLD}`, padding: '6px 9px', fontFamily: MONO, fontSize: 10 }}>
      <div style={{ color: GOLD, fontWeight: 700, marginBottom: 2 }}>{name}</div>
      {p.return != null && <div style={{ color: TEXT }}>Return {p.return.toFixed(1)}%</div>}
      {p.vol != null && <div style={{ color: SEC }}>Vol {p.vol.toFixed(1)}%</div>}
      {p.sharpe != null && <div style={{ color: SEC }}>Sharpe {p.sharpe.toFixed(2)}</div>}
    </div>
  )
}

function PriceTip({ active, payload, label, period }: { active?: boolean; payload?: { name: string; value: number; color: string }[]; label?: string; period: string }) {
  if (!active || !payload?.length) return null
  const isIntraday = period === '1d' || period === '1w'
  const d = new Date(label ?? '')
  const when = isNaN(d.getTime()) ? label : (isIntraday ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))
  return (
    <div style={{ background: SURFACE, border: `1px solid ${GOLD}`, padding: '6px 9px', fontFamily: MONO, fontSize: 10 }}>
      <div style={{ color: FAINT, marginBottom: 3 }}>{when}</div>
      {payload.map(p => (
        <div key={p.name} style={{ color: p.color, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
          <span>{p.name}</span><span>{p.name === 'Price' ? `$${p.value.toFixed(2)}` : `${p.value >= 0 ? '+' : ''}${p.value.toFixed(2)}%`}</span>
        </div>
      ))}
    </div>
  )
}

export function PortfolioBuilderContent() {
  const [tickers, setTickers] = useState<string[]>(['AAPL', 'MSFT', 'NVDA', 'TLT', 'GLD'])
  const [tickerDraft, setTickerDraft] = useState('')
  const [cashAmount, setCashAmount] = useState('100000')
  const [rf, setRf] = useState('4.00')
  const [riskPreset, setRiskPreset] = useState('moderate')
  const [weights, setWeights] = useState<Record<string, number>>({})
  const [locked, setLocked] = useState<Record<string, boolean>>({})
  const [period, setPeriod] = useState('1y')
  const [chartTicker, setChartTicker] = useState<string | null>(tickers[0] ?? null)
  const [exportMsg, setExportMsg] = useState('')
  const [importMsg, setImportMsg] = useState('')
  // Raw in-progress text for the $ / shares boxes — kept separate from the
  // derived weight so mid-typing keystrokes never fight a recomputed value;
  // committed (and cleared) on blur/Enter.
  const [cashDraft, setCashDraft] = useState<Record<string, string>>({})
  const [sharesDraft, setSharesDraft] = useState<Record<string, string>>({})
  const navigate = useNavigate()
  const riskAversion = RISK_PRESETS.find(p => p.key === riskPreset)?.A ?? 45

  // Keep the chart's selection valid — default to the first ticker, and fall
  // back to it if the one showing gets removed.
  useEffect(() => {
    if (tickers.length === 0) { setChartTicker(null); return }
    if (!chartTicker || !tickers.includes(chartTicker)) setChartTicker(tickers[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers])

  useEffect(() => {
    axios.get('/api/rates/risk-free').then(r => {
      const v = r.data?.rate
      if (typeof v === 'number') setRf((v * 100).toFixed(2))
    }).catch(() => { /* keep the default */ })
  }, [])

  const addTicker = () => {
    const sym = tickerDraft.trim().toUpperCase()
    setTickerDraft('')
    if (!sym || tickers.includes(sym)) return
    setTickers(t => [...t, sym])
  }
  // Load a saved Portfolio Manager portfolio (value-weighted equity legs) —
  // skips the next auto-equal-weight pass so the imported weights stick.
  const loadFromPM = (result: ImportResult, name: string) => {
    const legs = result.legs.filter(l => l.ticker && l.ticker.toUpperCase() !== 'CASH')
    if (legs.length < 2) { setImportMsg(`"${name}" needs 2+ equity holdings to build a portfolio.`); return }
    skipNextLevelRef.current = true
    setTickers(legs.map(l => l.ticker.toUpperCase()))
    setWeights(Object.fromEntries(legs.map(l => [l.ticker.toUpperCase(), l.weight])))
    setLocked({})
    // Carry over the portfolio's total value (equity + cash) instead of
    // leaving the default $100,000 — if it held a cash sleeve, the equity
    // legs' weights won't sum to 100% of it, which correctly shows up as
    // leftover cash here rather than being silently dropped.
    if (result.totalValue > 0) setCashAmount(String(Math.round(result.totalValue)))
    setImportMsg(`Loaded "${name}" — ${legs.length} holdings.`)
  }
  const removeTicker = (sym: string) => {
    setTickers(t => t.filter(x => x !== sym))
    setWeights(w => { const n = { ...w }; delete n[sym]; return n })
    setLocked(l => { const n = { ...l }; delete n[sym]; return n })
  }
  const toggleLock = (sym: string) => setLocked(l => ({ ...l, [sym]: !l[sym] }))

  // Dragging one ticker's slider redistributes the capital OUTSIDE it equally
  // across every other unlocked ticker; locked tickers keep their weight fixed.
  const setDeployWeight = (t: string, v: number) => {
    setWeights(w => {
      const lockedSum = tickers.filter(x => x !== t && locked[x]).reduce((s, x) => s + (w[x] || 0), 0)
      // Cap at what's actually left after locked tickers' fixed share — without
      // this, dragging past that point pushed the total over 100%, which diluted
      // (and visibly moved) every locked ticker's normalized $/share display even
      // though its own weight never changed.
      const clamped = Math.max(0, Math.min(100 - lockedSum, v))
      const others = tickers.filter(x => x !== t && !locked[x])
      const remainder = Math.max(0, 100 - clamped - lockedSum)
      const share = others.length > 0 ? +(remainder / others.length).toFixed(3) : 0
      const next: Record<string, number> = { ...w, [t]: clamped }
      others.forEach(o => { next[o] = share })
      return next
    })
  }

  // Starts at (and re-levels on any ticker add/remove to) equal weight across
  // unlocked tickers, splitting whatever capital locked tickers don't claim.
  const prevTickersRef = useRef<string[] | null>(null)
  const skipNextLevelRef = useRef(false)
  useEffect(() => {
    if (skipNextLevelRef.current) { skipNextLevelRef.current = false; prevTickersRef.current = tickers; return }
    const prev = prevTickersRef.current
    const changed = !prev || prev.length !== tickers.length || prev.some((p, idx) => p !== tickers[idx])
    if (changed && tickers.length > 0) {
      setWeights(w => {
        const unlockedTs = tickers.filter(t => !locked[t])
        const lockedSum = tickers.filter(t => locked[t]).reduce((s, t) => s + (w[t] || 0), 0)
        const share = unlockedTs.length > 0 ? +(Math.max(0, 100 - lockedSum) / unlockedTs.length).toFixed(3) : 0
        const next: Record<string, number> = { ...w }
        unlockedTs.forEach(t => { next[t] = share })
        return next
      })
    }
    prevTickersRef.current = tickers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers])

  const totalW = tickers.reduce((s, t) => s + (weights[t] || 0), 0)
  const hasWeights = totalW > 0

  // Live prices for cash → share-count conversion — same per-ticker quote
  // endpoint Portfolio Manager uses for its own holdings.
  const priceResults = useQueries({
    queries: tickers.map(t => ({
      queryKey: ['pb-quote', t],
      queryFn: () => axios.get(`/api/market/quote/${encodeURIComponent(t)}`).then(r => r.data as { current_price: number }),
      enabled: !!t, staleTime: 60_000,
    })),
  })
  const priceMap = useMemo(() => Object.fromEntries(
    tickers.map((t, i) => [t, priceResults[i]?.data?.current_price as number | undefined]),
  ), [tickers, priceResults])
  const cashNum = parseFloat(cashAmount) || 0
  // Typing a dollar amount for a ticker converts it to a weight and runs the
  // same rebalance-the-rest-equally logic the slider uses.
  const setDeployCash = (t: string, dollars: number) => {
    if (cashNum <= 0) return
    setDeployWeight(t, (Math.max(0, dollars) / cashNum) * 100)
  }
  // Typing a share count converts to dollars at the live price, then reuses
  // the same cash → weight conversion above.
  const setDeployShares = (t: string, shares: number) => {
    const price = priceMap[t]
    if (!price) return
    setDeployCash(t, Math.max(0, shares) * price)
  }
  // Fractional shares — most brokers support them now, and rounding down was
  // both losing precision in the $/weight round-trip and stranding cash.
  //
  // Each ticker's dollar/share figure comes straight from its OWN weight ÷ 100,
  // never from weights[t] / totalW. Normalizing by totalW made every ticker's
  // displayed $ amount depend on what every OTHER ticker was doing — including
  // locked ones — because totalW dips below 100 whenever weight is released
  // with nowhere unlocked to receive it (e.g. shrinking one ticker while
  // everything else is locked). Dividing by a fixed 100 means a locked
  // ticker's dollar figure only moves if its own weight moves; any gap from
  // under-allocation shows up as leftover cash instead of quietly inflating
  // everyone else's numbers.
  const shareRows = useMemo(() => tickers.map(t => {
    const w = (weights[t] || 0) / 100
    const price = priceMap[t]
    const shares = price ? +((cashNum * w) / price).toFixed(4) : 0
    return { ticker: t, weight: w, price, shares, dollarActual: price ? shares * price : 0 }
  }), [tickers, weights, priceMap, cashNum])
  const totalDeployed = shareRows.reduce((s, r) => s + r.dollarActual, 0)
  const leftoverCash = cashNum - totalDeployed
  const canExport = cashNum > 0 && shareRows.some(r => r.shares > 0)
  const sendToPortfolioManager = () => {
    const holdings = shareRows.filter(r => r.shares > 0 && r.price).map(r => ({ ticker: r.ticker, shares: r.shares, avgCost: r.price as number }))
    if (!holdings.length) { setExportMsg('No priced holdings to export yet — wait for quotes to load.'); return }
    let state: { portfolios: { id: string; name: string }[]; activeId: string } | null = null
    try { state = JSON.parse(localStorage.getItem(PM_PORTFOLIOS_KEY) ?? 'null') } catch { state = null }
    const id = genId()
    const name = `Portfolio Builder — ${new Date().toLocaleDateString()}`
    const newPortfolio = { id, name, holdings, options: [], futures: [], cash: [] }
    const next = state?.portfolios?.length
      ? { portfolios: [...state.portfolios, newPortfolio], activeId: id }
      : { portfolios: [newPortfolio], activeId: id }
    localStorage.setItem(PM_PORTFOLIOS_KEY, JSON.stringify(next))
    navigate('/portfolio-manager')
  }

  // Always CAPM, fixed 3Y estimation window and 10% expected market return —
  // this tool is about sizing an allocation, not choosing a return model.
  const { mutate, data, isPending, isError, error } = useMutation<OptResult>({
    mutationFn: async () => (await axios.post('/api/portfolio-opt/optimize', {
      tickers, start: startFor(3), end: new Date().toISOString().slice(0, 10),
      risk_free_rate: parseFloat(rf) || 0, constraint_mode: 'long_only',
      risk_aversion: riskAversion, return_model: 'capm', market_return: 10,
      weights: hasWeights ? weights : undefined,
    })).data,
  })
  const errMsg = (error as { response?: { data?: { detail?: string } } })?.response?.data?.detail

  // Auto re-solve whenever the ticker SET changes (add/remove/rename); rf and
  // risk tolerance recompute the CAL client-side instantly and don't need a
  // re-fetch, so they're deliberately left out of this dependency list — the
  // Recalculate button next to rf covers that case explicitly.
  useEffect(() => {
    if (tickers.length >= 2) mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tickers.join(',')])

  // Instant client-side score of the CURRENT slider weights against the
  // covariance matrix the backend already returned — recomputes on every
  // drag with no re-fetch.
  const clientCurrent = useMemo(() => {
    if (!data?.covariance?.length) return null
    const n = data.tickers.length
    const wRaw = data.tickers.map(t => weights[t] || 0)
    const wSum = wRaw.reduce((a, b) => a + b, 0)
    if (wSum <= 0) return null
    const w = wRaw.map(x => x / wSum)
    const mu = data.assets.map(a => a.return)
    const cov = data.covariance
    let ret = 0
    for (let i = 0; i < n; i++) ret += w[i] * mu[i]
    let variance = 0
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) variance += w[i] * w[j] * cov[i][j]
    const vol = Math.sqrt(Math.max(variance, 0))
    const sharpe = vol > 0 ? (ret - data.risk_free_rate) / vol : 0
    return { return: ret, vol, sharpe }
  }, [data, weights])

  const currentScatter = useMemo(() => clientCurrent ? [{ ...clientCurrent, label: 'Your Portfolio', key: 'current' }] : [], [clientCurrent])
  const portScatter = useMemo(() => data ? [
    { ...data.portfolios.max_sharpe, label: 'Max Sharpe', key: 'max_sharpe' },
    { ...data.portfolios.min_variance, label: 'Min Variance', key: 'min_variance' },
  ] : [], [data])

  const maxFrontierVol = useMemo(() => data?.frontier.length ? Math.max(...data.frontier.map(f => f.vol)) : 20, [data])
  const capitalAllocation = useMemo(() => {
    if (!data?.portfolios.max_sharpe) return null
    return computeCapitalAllocation(data.portfolios.max_sharpe, data.risk_free_rate, riskAversion, maxFrontierVol)
  }, [data, riskAversion, maxFrontierVol])

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

  // Multi-ticker price comparison chart — same endpoint Asset Overlay uses.
  // Fetched as raw price so both the left (price) and right (% change) axes
  // can be derived from the one series client-side.
  const { data: cmp, isFetching: cmpLoading } = useQuery({
    queryKey: ['pb-compare', tickers.join(','), period],
    queryFn: () => axios.get(`/api/market/compare?tickers=${encodeURIComponent(tickers.join(','))}&period=${period}&normalize=price`).then(r => r.data as {
      series: Record<string, number | string | null>[]; tickers: string[]; meta: Record<string, { change_pct: number | null }>
    }),
    enabled: tickers.length > 0,
  })
  // Price (left axis) + % change off the first point in the window (right axis)
  // for whichever ticker is selected on its tile. % change is just price
  // rescaled around the starting price, so the two lines are the same curve —
  // they only look like two different lines if the axes aren't kept in sync.
  const [chartSeries, chartBase] = useMemo(() => {
    if (!cmp?.series?.length || !chartTicker) return [[] as { date: string; price: number | null; pct: number | null }[], null as number | null]
    let base: number | null = null
    const rows = cmp.series.map(r => {
      const price = r[chartTicker] as number | null | undefined
      if (price != null && base == null) base = price
      const pct = price != null && base ? (price / base - 1) * 100 : null
      return { date: r.date as string, price: price ?? null, pct }
    })
    return [rows, base]
  }, [cmp, chartTicker])

  // Derive the price axis domain FROM the % domain (not independently, which
  // is what let the two "auto" axes drift apart) so both scales always agree
  // pixel-for-pixel with the underlying price/% relationship.
  const [priceDom, pctDom] = useMemo(() => {
    const auto: ['auto', 'auto'] = ['auto', 'auto']
    const vals = chartSeries.map(r => r.pct).filter((v): v is number => v != null)
    if (!vals.length || !chartBase) return [auto, auto] as const
    const lo = Math.min(...vals), hi = Math.max(...vals)
    const pad = Math.max((hi - lo) * 0.08, 1)
    const pctLo = lo - pad, pctHi = hi + pad
    return [
      [chartBase * (1 + pctLo / 100), chartBase * (1 + pctHi / 100)] as [number, number],
      [pctLo, pctHi] as [number, number],
    ] as const
  }, [chartSeries, chartBase])

  return (
    <PageWrapper title="Portfolio Builder">
      <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12, minHeight: 'calc(100vh - 160px)' }}>
        {/* Parameters bar */}
        <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderTop: `2px solid ${GOLD}`, display: 'flex', alignItems: 'flex-end', gap: 18, padding: '12px 16px', flexWrap: 'wrap' }}>
          <div>
            <label style={lbl}>Cash to deploy</label>
            <input type="number" min={0} step="1000" value={cashAmount} onChange={e => setCashAmount(e.target.value)} style={{ ...inp, width: 140 }} />
          </div>
          <div>
            <label style={lbl}>Risk-free rate %</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input type="number" step="0.25" value={rf} onChange={e => setRf(e.target.value)} style={{ ...inp, width: 90 }} />
              <button onClick={() => mutate()} disabled={isPending} title="Recompute the frontier with this risk-free rate" style={{ background: 'none', border: `1px solid ${BORDER}`, color: SEC, cursor: 'pointer', padding: '0 8px', display: 'flex', alignItems: 'center' }}><RefreshCw size={13} /></button>
            </div>
          </div>
          <div>
            <label style={lbl}>Risk tolerance</label>
            <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
              {RISK_PRESETS.map((p, i) => (
                <button key={p.key} onClick={() => setRiskPreset(p.key)} title="Drives the Capital Allocation Line — updates instantly, no re-run needed."
                  style={{ flex: 1, background: riskPreset === p.key ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent', border: 'none', borderRight: i < RISK_PRESETS.length - 1 ? `1px solid ${BORDER}` : 'none', cursor: 'pointer', color: riskPreset === p.key ? GOLD : SEC, fontFamily: MONO, fontSize: 10, fontWeight: 700, padding: '7px 10px', whiteSpace: 'nowrap' }}>{p.label}</button>
              ))}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>
              Deployed <span style={{ color: TEXT }}>${totalDeployed.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span> · Leftover <span style={{ color: leftoverCash > 0 ? TEXT : NEG }}>${leftoverCash.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
            </span>
            <button onClick={sendToPortfolioManager} disabled={!canExport} title="Creates a new Portfolio Manager tab with these share counts at current prices"
              style={{ background: canExport ? GOLD : 'transparent', border: `1px solid ${GOLD}`, color: canExport ? 'var(--theme-bg)' : GOLD, fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', padding: '9px 14px', cursor: canExport ? 'pointer' : 'default', opacity: canExport ? 1 : 0.5 }}>
              Send to Portfolio Manager
            </button>
          </div>
          {exportMsg && <div style={{ width: '100%', fontFamily: MONO, fontSize: 9, color: NEG }}>{exportMsg}</div>}
          {data?.dropped && data.dropped.length > 0 && <div style={{ width: '100%', fontFamily: MONO, fontSize: 9, color: NEG }}>dropped (too little history): {data.dropped.join(', ')}</div>}
          {isError && <div style={{ width: '100%', fontFamily: MONO, fontSize: 9, color: NEG }}>{errMsg ?? 'Could not solve the frontier for this ticker set'}</div>}
        </div>

        {/* Body: ticker column + charts */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Left: tickers + sliders */}
          <div style={{ width: 300, flexShrink: 0, background: SURFACE, border: `1px solid ${BORDER}`, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '10px 12px', borderBottom: `1px solid ${BORDER}`, display: 'flex', justifyContent: 'space-between', fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GOLD }}>
              <span>Tickers</span><span style={{ color: FAINT }}>{tickers.length}</span>
            </div>
            <div style={{ padding: 10, display: 'flex', gap: 6 }}>
              <input value={tickerDraft} onChange={e => setTickerDraft(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTicker()}
                placeholder="Add ticker…" style={{ ...inp, textTransform: 'uppercase' }} />
              <button onClick={addTicker} style={{ background: GOLD, border: `1px solid ${GOLD}`, color: 'var(--theme-bg)', fontFamily: SANS, fontSize: 10, fontWeight: 700, padding: '0 12px', cursor: 'pointer' }}>Add</button>
            </div>
            <div style={{ padding: '0 10px 10px' }}>
              <PMImportPicker onImport={loadFromPM} style={{ ...inp, appearance: 'none', cursor: 'pointer' }} />
              {importMsg && <div style={{ fontSize: 9, color: importMsg.startsWith('Loaded') ? POS : NEG, fontFamily: SANS, marginTop: 5, lineHeight: 1.4 }}>{importMsg}</div>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 10px 10px' }}>
              {tickers.map((t, i) => {
                const isLocked = !!locked[t]
                const row = shareRows[i]
                const isChartSel = t === chartTicker
                const lockedSumOther = tickers.filter(x => x !== t && locked[x]).reduce((s, x) => s + (weights[x] || 0), 0)
                const sliderMax = Math.max(0, 100 - lockedSumOther)
                return (
                  <div key={i} style={{ background: 'color-mix(in srgb, var(--theme-surface, #0d1826) 100%, #000 8%)', border: `1px solid ${isChartSel ? GOLD : BORDER}`, padding: '8px 9px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                      <button onClick={() => setChartTicker(t)} title={`Show ${t} on the price chart`} aria-pressed={isChartSel}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left', flex: 1, fontFamily: MONO, fontSize: 12, fontWeight: 700, color: isChartSel ? GOLD : TEXT }}>{t}</button>
                      <button onClick={() => toggleLock(t)} aria-label={isLocked ? `Unlock ${t}` : `Lock ${t}`} title={isLocked ? 'Locked — excluded from auto-rebalance. Click to unlock.' : 'Lock to exclude this ticker from auto-rebalance'} style={{ background: 'none', border: 'none', color: isLocked ? GOLD : FAINT, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}>{isLocked ? <Lock size={13} /> : <Unlock size={13} />}</button>
                      <button onClick={() => removeTicker(t)} aria-label={`Remove ${t}`} style={{ background: 'none', border: 'none', color: FAINT, cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center' }}><X size={14} /></button>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input type="range" min={0} max={isLocked ? 100 : sliderMax} step={0.5} disabled={isLocked} value={weights[t] || 0} onChange={e => setDeployWeight(t, parseFloat(e.target.value))}
                        title={!isLocked && lockedSumOther > 0 ? `Capped at ${sliderMax.toFixed(0)}% — ${lockedSumOther.toFixed(0)}% is held by locked tickers` : undefined}
                        style={{ flex: 1, accentColor: GOLD, opacity: isLocked ? 0.5 : 1 }} aria-label={`${t} weight`} />
                      <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: GOLD, width: 40, textAlign: 'right' }}>{(weights[t] || 0).toFixed(0)}%</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                        <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>$</span>
                        <input type="number" min={0} step="100" disabled={isLocked || cashNum <= 0}
                          value={cashDraft[t] ?? (cashNum > 0 ? String(Math.round(row?.dollarActual ?? 0)) : '')}
                          onChange={e => setCashDraft(d => ({ ...d, [t]: e.target.value }))}
                          onFocus={e => setCashDraft(d => ({ ...d, [t]: e.target.value }))}
                          onBlur={e => { setDeployCash(t, parseFloat(e.target.value) || 0); setCashDraft(d => { const n = { ...d }; delete n[t]; return n }) }}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                          placeholder={cashNum > 0 ? '0' : 'set cash above'}
                          title={`Type a dollar amount to set ${t}'s weight directly`}
                          style={{ ...inp, width: 0, flex: 1, padding: '3px 5px', fontSize: 10, opacity: isLocked || cashNum <= 0 ? 0.5 : 1 }} />
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
                        <input type="number" min={0} step="0.01" disabled={isLocked || cashNum <= 0 || !priceMap[t]}
                          value={sharesDraft[t] ?? (priceMap[t] && cashNum > 0 ? fmtShares(row?.shares ?? 0) : '')}
                          onChange={e => setSharesDraft(d => ({ ...d, [t]: e.target.value }))}
                          onFocus={e => setSharesDraft(d => ({ ...d, [t]: e.target.value }))}
                          onBlur={e => { setDeployShares(t, parseFloat(e.target.value) || 0); setSharesDraft(d => { const n = { ...d }; delete n[t]; return n }) }}
                          onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                          placeholder={priceMap[t] ? '0' : 'no price'}
                          title={`Type a share count to set ${t}'s weight directly`}
                          style={{ ...inp, width: 0, flex: 1, padding: '3px 5px', fontSize: 10, opacity: isLocked || cashNum <= 0 || !priceMap[t] ? 0.5 : 1 }} />
                        <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>sh</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 5, fontFamily: MONO, fontSize: 9, color: FAINT }}>
                      <span>{row?.price != null ? `$${row.price.toFixed(2)}` : '…'}</span>
                      <span style={{ color: TEXT }}>{fmtShares(row?.shares ?? 0)} sh · ${(row?.dollarActual ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                    </div>
                  </div>
                )
              })}
              {tickers.length === 0 && <div style={{ fontFamily: SANS, fontSize: 10, color: FAINT, padding: '8px 0', textAlign: 'center' }}>Add at least 2 tickers to build a portfolio.</div>}
            </div>
          </div>

          {/* Right: price chart + frontier */}
          <div style={{ flex: '1 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 12px', borderBottom: `1px solid ${BORDER}` }}>
                <span style={{ fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GOLD }}>{chartTicker ?? 'Selected Ticker'} <span style={{ color: FAINT, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>· click a tile to switch</span></span>
                <div style={{ display: 'flex', border: `1px solid ${BORDER}` }}>
                  {PERIODS.map((p, i) => (
                    <button key={p.key} onClick={() => setPeriod(p.key)} style={{ background: period === p.key ? `color-mix(in srgb, ${GOLD} 16%, transparent)` : 'transparent', border: 'none', borderRight: i < PERIODS.length - 1 ? `1px solid ${BORDER}` : 'none', cursor: 'pointer', color: period === p.key ? GOLD : SEC, fontFamily: MONO, fontSize: 9.5, fontWeight: 700, padding: '5px 10px' }}>{p.label}</button>
                  ))}
                </div>
              </div>
              <div style={{ padding: '10px 8px 4px' }}>
                {tickers.length === 0 ? <div style={{ height: 220, display: 'grid', placeItems: 'center', color: FAINT, fontFamily: SANS, fontSize: 11 }}>Add tickers to see performance.</div> : (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={chartSeries} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                      <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="date" tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }}
                        tickFormatter={(v: string) => {
                          const d = new Date(v)
                          if (isNaN(d.getTime())) return v
                          return (period === '1d' || period === '1w')
                            ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                            : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                        }} minTickGap={40} />
                      <YAxis yAxisId="price" orientation="left" domain={priceDom} allowDataOverflow tick={{ fontFamily: MONO, fontSize: 9, fill: BLUE }} tickLine={false} axisLine={{ stroke: BORDER }} width={52} tickFormatter={(v: number) => `$${v.toFixed(0)}`} />
                      <YAxis yAxisId="pct" orientation="right" domain={pctDom} allowDataOverflow tick={{ fontFamily: MONO, fontSize: 9, fill: GOLD }} tickLine={false} axisLine={{ stroke: BORDER }} width={44} tickFormatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`} />
                      <Tooltip cursor={CROSSHAIR_CURSOR} content={<PriceTip period={period} />} />
                      <Line yAxisId="price" type="monotone" dataKey="price" name="Price" stroke={BLUE} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
                      <Line yAxisId="pct" type="monotone" dataKey="pct" name="% Change" stroke={GOLD} strokeWidth={1.8} dot={false} isAnimationActive={false} connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                )}
                <div style={{ display: 'flex', gap: 12, padding: '4px 10px 8px', fontFamily: MONO, fontSize: 9, flexWrap: 'wrap', alignItems: 'center' }}>
                  {chartTicker && (() => {
                    const chg = cmp?.meta?.[chartTicker]?.change_pct
                    return <span style={{ color: chg != null && chg >= 0 ? POS : NEG, fontSize: 11, fontWeight: 700 }}>{chartTicker} {chg != null ? `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%` : '—'}</span>
                  })()}
                  {cmpLoading && <span style={{ color: FAINT }}>loading…</span>}
                </div>
              </div>
            </div>

            <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, flex: 1 }}>
              <div style={{ padding: '6px 12px', borderBottom: `1px solid ${BORDER}`, fontFamily: SANS, fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GOLD }}>Efficient Frontier</div>
              {!data && !isPending && <div style={{ height: 300, display: 'grid' }}><EmptyState title="Portfolio Builder" hint="Add 2+ tickers to see the efficient frontier and where your allocation sits on it." /></div>}
              {isPending && <div style={{ height: 300, display: 'grid' }}><EmptyState title="Solving…" hint="Fetching aligned history and the efficient frontier." variant="loading" /></div>}
              {data && (
                <>
                  <div style={{ display: 'flex', gap: 0, borderBottom: `1px solid ${BORDER}` }}>
                    <KpiCell grow align="top" label="Your Return" value={clientCurrent ? `${clientCurrent.return >= 0 ? '+' : ''}${clientCurrent.return.toFixed(1)}%` : '—'} valueSize={18} color={clientCurrent && clientCurrent.return >= 0 ? POS : NEG} sub="CAPM · forward" />
                    <KpiCell grow align="top" label="Your Volatility" value={clientCurrent ? `${clientCurrent.vol.toFixed(1)}%` : '—'} valueSize={18} sub="annualized" />
                    <KpiCell grow align="top" label="Your Sharpe" value={clientCurrent ? clientCurrent.sharpe.toFixed(2) : '—'} valueSize={18} color={clientCurrent && clientCurrent.sharpe >= 1 ? POS : GOLD} sub={`rf ${data.risk_free_rate}%`} />
                  </div>
                  <div style={{ padding: '10px 8px 4px' }}>
                    <ResponsiveContainer width="100%" height={300}>
                      <ScatterChart margin={{ top: 8, right: 12, bottom: 24, left: 4 }}>
                        <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                        <XAxis type="number" dataKey="vol" name="Volatility" domain={xDom} allowDataOverflow tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }} tickFormatter={(v: number) => `${v.toFixed(0)}%`} label={{ value: 'Volatility (annual %)', position: 'insideBottom', offset: -12, fontFamily: SANS, fontSize: 9, fill: FAINT }} />
                        <YAxis type="number" dataKey="return" name="Return" domain={yDom} allowDataOverflow tick={{ fontFamily: MONO, fontSize: 9, fill: SEC }} tickLine={false} axisLine={{ stroke: BORDER }} width={40} tickFormatter={(v: number) => `${v.toFixed(0)}%`} label={{ value: 'Return', angle: -90, position: 'insideLeft', fontFamily: SANS, fontSize: 9, fill: FAINT }} />
                        <ZAxis range={[60, 60]} />
                        <Tooltip cursor={CROSSHAIR_CURSOR} content={<FrontierTip />} />
                        <Scatter isAnimationActive={false} name="Frontier" data={data.frontier} line={{ stroke: GOLD, strokeWidth: 1.5 }} fill="transparent" />
                        {capitalAllocation && <Scatter isAnimationActive={false} name="Capital Allocation Line" data={capitalAllocation.calLine} line={{ stroke: GOLD, strokeWidth: 1.5, strokeDasharray: '5 3' }} fill="transparent" />}
                        {capitalAllocation && <Scatter isAnimationActive={false} name="Indifference Curve" data={capitalAllocation.indifferenceCurve} line={{ stroke: GOLD, strokeWidth: 1.2, strokeDasharray: '2 3' }} fill="transparent" />}
                        <Scatter isAnimationActive={false} name="Assets" data={data.assets} fill="var(--theme-bg, #101c2e)" stroke={GOLD} strokeWidth={2} shape="circle" />
                        <Scatter isAnimationActive={false} name="Portfolios" data={portScatter} fill="var(--theme-bg, #101c2e)" stroke={GOLD} strokeWidth={2} shape="diamond" />
                        {currentScatter.length > 0 && <Scatter isAnimationActive={false} name="Your Portfolio" data={currentScatter} fill="var(--theme-bg, #101c2e)" stroke={GOLD} strokeWidth={2} shape="star" />}
                      </ScatterChart>
                    </ResponsiveContainer>
                    <div style={{ display: 'flex', gap: 10, padding: '4px 10px 8px', fontFamily: SANS, fontSize: 9, color: FAINT, flexWrap: 'wrap' }}>
                      <span><span style={{ color: GOLD }}>─</span> frontier</span>
                      <span><span style={{ color: GOLD }}>- -</span> capital allocation line</span>
                      <span><span style={{ color: GOLD }}>··</span> indifference curve</span>
                      <span><span style={{ color: GOLD }}>●</span> assets</span>
                      <span><span style={{ color: GOLD }}>◆</span> max sharpe / min variance</span>
                      {currentScatter.length > 0 && <span><span style={{ color: GOLD }}>★</span> your portfolio</span>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px 10px', borderTop: `1px solid ${BORDER}`, flexWrap: 'wrap' }}>
                      <span style={{ fontFamily: MONO, fontSize: 10, color: FAINT }}>{data.days} days · {data.span.start} → {data.span.end}</span>
                      <Provenance kind="live" source="yfinance · daily" />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </PageWrapper>
  )
}

export default function PortfolioBuilder() {
  return <PortfolioBuilderContent />
}
