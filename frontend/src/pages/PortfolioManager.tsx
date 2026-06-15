import { useState, useEffect, useCallback, useRef } from 'react'
import axios from 'axios'
import { useQueries, useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'
import { usePortfolio } from '../contexts/PortfolioContext'
import { FUTURES, FUTURES_BY_GROUP, futuresSpec } from '../lib/futures'

const T = {
  bg:      'var(--theme-bg, #101c2e)',
  surface: 'var(--theme-surface, #0d1826)',
  border:  'var(--theme-border, rgba(255,255,255,0.08))',
  gold:    'var(--theme-primary, #c9a84c)',
  muted:   'var(--theme-secondary, #5e768f)',
  text:    'var(--theme-text, #d7e3fc)',
  mono:    'var(--theme-mono)',
  label:   'var(--theme-sans)',
  pos:     'var(--theme-positive)',
  neg:     'var(--theme-negative)',
}

const STORAGE_KEY = 'ft-portfolio-manager'

interface Holding {
  ticker:   string
  shares:   number
  avgCost:  number
}

interface QuoteData {
  current_price:    number
  pct_change_1d:    number | null
  market_cap:       number | null
}

function loadHoldings(): Holding[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') } catch { return [] }
}

// ── Option positions (single + multi-leg) ──────────────────────────────────────
type OptType = 'call' | 'put'
type Side = 'long' | 'short'
interface OptionLeg {
  type:       OptType
  strike:     number
  expiry:     string   // YYYY-MM-DD
  side:       Side
  contracts:  number
  avgPremium: number   // per share
}
interface OptionPosition {
  id:         string
  underlying: string
  name:       string
  legs:       OptionLeg[]
}

const OPT_STORAGE_KEY = 'pm-options-v1'
function loadOptions(): OptionPosition[] {
  try { return JSON.parse(localStorage.getItem(OPT_STORAGE_KEY) ?? '[]') } catch { return [] }
}

// Presets seed each leg's type/side; the user fills strike/expiry/premium.
interface OptPreset { name: string; legs: { type: OptType; side: Side }[] }
const OPT_PRESETS: OptPreset[] = [
  { name: 'Single Call',      legs: [{ type: 'call', side: 'long' }] },
  { name: 'Single Put',       legs: [{ type: 'put',  side: 'long' }] },
  { name: 'Covered Call',     legs: [{ type: 'call', side: 'short' }] },
  { name: 'Cash-Secured Put', legs: [{ type: 'put',  side: 'short' }] },
  { name: 'Bull Call Spread', legs: [{ type: 'call', side: 'long' }, { type: 'call', side: 'short' }] },
  { name: 'Bear Put Spread',  legs: [{ type: 'put',  side: 'long' }, { type: 'put',  side: 'short' }] },
  { name: 'Long Straddle',    legs: [{ type: 'call', side: 'long' }, { type: 'put',  side: 'long' }] },
  { name: 'Long Strangle',    legs: [{ type: 'call', side: 'long' }, { type: 'put',  side: 'long' }] },
  { name: 'Iron Condor',      legs: [{ type: 'put', side: 'long' }, { type: 'put', side: 'short' }, { type: 'call', side: 'short' }, { type: 'call', side: 'long' }] },
  { name: 'Custom',           legs: [{ type: 'call', side: 'long' }] },
]

// Form-friendly leg (string fields while editing)
interface LegDraft { type: OptType; strike: string; expiry: string; side: Side; contracts: string; avgPremium: string }
const emptyLeg = (type: OptType = 'call', side: Side = 'long'): LegDraft =>
  ({ type, strike: '', expiry: '', side, contracts: '1', avgPremium: '' })

interface OptLegMark { mark: number | null; delta: number | null; source: string | null }

// ── Futures positions ───────────────────────────────────────────────────────────
interface FuturePosition {
  id:         string
  symbol:     string   // yfinance =F symbol
  side:       Side
  contracts:  number
  entryPrice: number   // price per point at entry
}
const FUT_STORAGE_KEY = 'pm-futures-v1'
function loadFutures(): FuturePosition[] {
  try { return JSON.parse(localStorage.getItem(FUT_STORAGE_KEY) ?? '[]') } catch { return [] }
}

// ── Cash positions (interest-bearing) ───────────────────────────────────────────
interface CashPosition {
  id:     string
  label:  string
  amount: number   // principal
  rate:   number   // annual % (APY)
  since:  string   // YYYY-MM-DD the balance started accruing
}

// ── Multiple portfolios (saved in tabs) ─────────────────────────────────────────
interface Portfolio {
  id:       string
  name:     string
  holdings: Holding[]
  options:  OptionPosition[]
  futures:  FuturePosition[]
  cash:     CashPosition[]
}
interface PMState { portfolios: Portfolio[]; activeId: string }
const PORTFOLIOS_KEY = 'pm-portfolios-v2'
const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random())

function loadPortfolios(): PMState {
  try {
    const raw = localStorage.getItem(PORTFOLIOS_KEY)
    if (raw) {
      const d = JSON.parse(raw)
      if (d?.portfolios?.length) {
        d.portfolios = d.portfolios.map((p: Portfolio) => ({ ...p, cash: p.cash ?? [] }))  // backfill cash
        return d
      }
    }
  } catch { /* fall through to migration */ }
  // Migrate the old single-portfolio keys into a Default tab so nothing is lost
  const def: Portfolio = { id: 'default', name: 'Default', holdings: loadHoldings(), options: loadOptions(), futures: loadFutures(), cash: [] }
  return { portfolios: [def], activeId: 'default' }
}

// Accrued value of a cash balance: principal × (1 + rate)^(years since `since`)
function cashValue(c: CashPosition): number {
  const start = new Date(c.since + 'T00:00:00').getTime()
  const years = isNaN(start) ? 0 : Math.max(0, (Date.now() - start) / (365.25 * 864e5))
  return c.amount * Math.pow(1 + c.rate / 100, years)
}

function fmt(v: number, pre = '', suf = '', d = 2) {
  return `${pre}${v.toFixed(d)}${suf}`
}
function fmtMoney(v: number) {
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(2)}`
}
const fmtStrike = (s: number) => (Number.isInteger(s) ? String(s) : s.toFixed(2).replace(/\.?0+$/, ''))
function fmtExp(iso: string) {
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }).replace(' ', " '")
}

const inp: React.CSSProperties = {
  background: T.surface, border: `1px solid ${T.border}`,
  color: T.text, fontFamily: T.mono, fontSize: 11,
  padding: '5px 8px', outline: 'none', width: '100%', boxSizing: 'border-box',
}
const addBtn: React.CSSProperties = {
  background: T.gold, border: 'none', color: 'var(--theme-bg)',
  fontFamily: T.label, fontSize: 10, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase', padding: '7px 0', cursor: 'pointer',
}
const ghostBtn: React.CSSProperties = {
  background: 'transparent', border: `1px solid ${T.border}`, color: T.muted,
  fontFamily: T.label, fontSize: 9, fontWeight: 700,
  letterSpacing: '0.12em', textTransform: 'uppercase', padding: '6px 0', cursor: 'pointer',
}
const editBtn: React.CSSProperties = {
  background: 'none', border: 'none', cursor: 'pointer', fontFamily: T.label,
  fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '0 4px',
}
const editInp: React.CSSProperties = {
  background: T.bg, border: `1px solid ${T.gold}`, color: T.text, fontFamily: T.mono,
  fontSize: 10, padding: '3px 6px', width: 70, outline: 'none', boxSizing: 'border-box', textAlign: 'right',
}

type Upd<T> = T | ((prev: T) => T)

export default function PortfolioManager() {
  // Multi-portfolio store — the active tab is the working set. The position
  // setters below patch the active portfolio so the rest of the component (add/
  // remove/edit handlers, marks queries) works unchanged.
  const [pm, setPm] = useState<PMState>(loadPortfolios)
  const portfolios = pm.portfolios
  const active = portfolios.find(p => p.id === pm.activeId) ?? portfolios[0]
  const holdings = active.holdings
  const options  = active.options
  const futures  = active.futures
  const cash     = active.cash

  const patchActive = useCallback((patch: (p: Portfolio) => Partial<Portfolio>) =>
    setPm(s => ({ ...s, portfolios: s.portfolios.map(p => p.id === s.activeId ? { ...p, ...patch(p) } : p) })), [])
  const setHoldings = useCallback((u: Upd<Holding[]>) => patchActive(p => ({ holdings: typeof u === 'function' ? u(p.holdings) : u })), [patchActive])
  const setOptions  = useCallback((u: Upd<OptionPosition[]>) => patchActive(p => ({ options: typeof u === 'function' ? u(p.options) : u })), [patchActive])
  const setFutures  = useCallback((u: Upd<FuturePosition[]>) => patchActive(p => ({ futures: typeof u === 'function' ? u(p.futures) : u })), [patchActive])
  const setCash     = useCallback((u: Upd<CashPosition[]>) => patchActive(p => ({ cash: typeof u === 'function' ? u(p.cash) : u })), [patchActive])

  const [newTicker,  setNewTicker]  = useState('')
  const [newShares,  setNewShares]  = useState('')
  const [newCost,    setNewCost]    = useState('')

  const [saveFlash,  setSaveFlash]  = useState(false)
  const [dirty,      setDirty]      = useState(false)
  const { setHoldings: syncToContext } = usePortfolio()

  // Option entry form state
  const [entryMode, setEntryMode] = useState<'stock' | 'option' | 'future' | 'cash'>('stock')
  const [optUnderlying, setOptUnderlying] = useState('')
  const [optPreset, setOptPreset] = useState(OPT_PRESETS[0].name)
  const [optLegs, setOptLegs] = useState<LegDraft[]>([emptyLeg()])

  // Futures entry form state
  const [futSym, setFutSym] = useState(FUTURES[0].sym)
  const [futSide, setFutSide] = useState<Side>('long')
  const [futContracts, setFutContracts] = useState('1')
  const [futEntry, setFutEntry] = useState('')

  // Cash entry form state
  const todayISO = new Date().toISOString().split('T')[0]
  const [cashLabel, setCashLabel] = useState('')
  const [cashAmount, setCashAmount] = useState('')
  const [cashRate, setCashRate] = useState('4.5')
  const [cashSince, setCashSince] = useState(todayISO)

  // Inline edit state
  const [editStock, setEditStock] = useState<{ i: number; shares: string; avgCost: string } | null>(null)
  const [editFut, setEditFut] = useState<{ id: string; contracts: string; entry: string } | null>(null)
  const [editCash, setEditCash] = useState<{ id: string; amount: string; rate: string } | null>(null)

  // Tab management
  const clearEdits = () => { setEditStock(null); setEditFut(null); setEditCash(null) }
  const addPortfolio = () => setPm(s => { const id = uid(); return { portfolios: [...s.portfolios, { id, name: `Portfolio ${s.portfolios.length + 1}`, holdings: [], options: [], futures: [], cash: [] }], activeId: id } })
  const switchPortfolio = (id: string) => { clearEdits(); setPm(s => ({ ...s, activeId: id })) }
  const renamePortfolio = (id: string, name: string) => setPm(s => ({ ...s, portfolios: s.portfolios.map(p => p.id === id ? { ...p, name } : p) }))
  const deletePortfolio = (id: string) => { clearEdits(); setPm(s => { const rest = s.portfolios.filter(p => p.id !== id); if (!rest.length) return s; return { portfolios: rest, activeId: s.activeId === id ? rest[0].id : s.activeId } }) }
  const [renaming, setRenaming] = useState<string | null>(null)

  const mountRef = useRef(false)
  useEffect(() => {
    if (!mountRef.current) { mountRef.current = true; return }
    localStorage.setItem(PORTFOLIOS_KEY, JSON.stringify(pm))
    setDirty(true)
  }, [pm])

  // Apply a preset: reseed the leg drafts with its type/side template
  const applyPreset = useCallback((name: string) => {
    setOptPreset(name)
    const p = OPT_PRESETS.find(x => x.name === name)
    if (p) setOptLegs(p.legs.map(l => emptyLeg(l.type, l.side)))
  }, [])

  // Live marks for every option leg, in one request (aligned to flatten order)
  const allLegs = options.flatMap(p => p.legs.map(l => ({
    underlying: p.underlying, expiry: l.expiry, strike: l.strike, option_type: l.type,
  })))
  const legSig = allLegs.map(l => `${l.underlying}:${l.expiry}:${l.strike}:${l.option_type}`).join('|')
  const marksQuery = useQuery({
    queryKey: ['pm-opt-marks', legSig],
    queryFn:  () => axios.post('/api/options/marks', { legs: allLegs }).then(r => r.data.marks as OptLegMark[]),
    enabled:  allLegs.length > 0,
    staleTime: 60_000,
    retry: 1,
  })

  // Fetch live prices for all tickers
  const priceResults = useQueries({
    queries: holdings.map(h => ({
      queryKey: ['pm-quote', h.ticker],
      queryFn:  () => axios.get(`/api/market/quote/${h.ticker}`).then(r => r.data as QuoteData),
      staleTime: 60_000,
      retry: 1,
    })),
  })

  // Live marks for futures (unique symbols)
  const futSymbols = Array.from(new Set(futures.map(f => f.symbol)))
  const futQuotes = useQueries({
    queries: futSymbols.map(sym => ({
      queryKey: ['pm-fut-quote', sym],
      queryFn:  () => axios.get(`/api/market/quote/${encodeURIComponent(sym)}`).then(r => r.data as QuoteData),
      staleTime: 60_000,
      retry: 1,
    })),
  })
  const futMarkBySym: Record<string, { price: number; pct1d: number | null; loading: boolean }> = {}
  futSymbols.forEach((sym, i) => {
    const q = futQuotes[i]?.data as QuoteData | undefined
    futMarkBySym[sym] = { price: q?.current_price ?? 0, pct1d: q?.pct_change_1d ?? null, loading: !!futQuotes[i]?.isLoading }
  })

  const addFuture = useCallback(() => {
    const symbol = futSym.trim().toUpperCase()
    const contracts = parseFloat(futContracts)
    const entryPrice = parseFloat(futEntry)
    if (!symbol || isNaN(contracts) || contracts <= 0 || isNaN(entryPrice) || entryPrice <= 0) return
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now())
    setFutures(prev => [...prev, { id, symbol, side: futSide, contracts, entryPrice }])
    setFutContracts('1'); setFutEntry('')
  }, [futSym, futSide, futContracts, futEntry])
  const removeFuture = (id: string) => setFutures(prev => prev.filter(f => f.id !== id))

  // ── Inline edit handlers ──
  const saveEditStock = () => {
    if (!editStock) return
    const shares = parseFloat(editStock.shares)
    const avgCost = editStock.avgCost.trim() === '' ? 0 : parseFloat(editStock.avgCost)  // blank = auto-fill
    if (isNaN(shares) || shares <= 0 || isNaN(avgCost) || avgCost < 0) return
    setHoldings(prev => prev.map((h, j) => j === editStock.i ? { ...h, shares, avgCost } : h))
    setEditStock(null)
  }
  const saveEditFut = () => {
    if (!editFut) return
    const contracts = parseFloat(editFut.contracts), entry = parseFloat(editFut.entry)
    if (isNaN(contracts) || contracts <= 0 || isNaN(entry) || entry <= 0) return
    setFutures(prev => prev.map(f => f.id === editFut.id ? { ...f, contracts, entryPrice: entry } : f))
    setEditFut(null)
  }
  const saveEditCash = () => {
    if (!editCash) return
    const amount = parseFloat(editCash.amount), rate = parseFloat(editCash.rate)
    if (isNaN(amount) || amount < 0 || isNaN(rate)) return
    setCash(prev => prev.map(c => c.id === editCash.id ? { ...c, amount, rate } : c))
    setEditCash(null)
  }

  const addCash = useCallback(() => {
    const amount = parseFloat(cashAmount), rate = parseFloat(cashRate)
    if (isNaN(amount) || amount <= 0 || isNaN(rate)) return
    setCash(prev => [...prev, { id: uid(), label: cashLabel.trim() || 'Cash', amount, rate, since: cashSince }])
    setCashLabel(''); setCashAmount('')
  }, [cashLabel, cashAmount, cashRate, cashSince, setCash])
  const removeCash = (id: string) => setCash(prev => prev.filter(c => c.id !== id))

  const addHolding = useCallback(() => {
    const ticker  = newTicker.trim().toUpperCase()
    const shares  = parseFloat(newShares)
    const avgCost = parseFloat(newCost)
    if (!ticker || isNaN(shares) || shares <= 0 || isNaN(avgCost) || avgCost <= 0) return
    setHoldings(prev => {
      const existing = prev.findIndex(h => h.ticker === ticker)
      if (existing >= 0) {
        return prev.map((h, i) => i === existing ? { ...h, shares, avgCost } : h)
      }
      return [...prev, { ticker, shares, avgCost }]
    })
    setNewTicker(''); setNewShares(''); setNewCost('')
  }, [newTicker, newShares, newCost])

  const removeHolding = (i: number) => setHoldings(prev => prev.filter((_, j) => j !== i))

  // Import from PortfolioIO
  const handleImport = useCallback((assets: PortfolioAsset[]) => {
    // assets have ticker + weight (0-1 or 0-100); map to holding with weight as placeholder shares
    const imported: Holding[] = assets.map(a => ({
      ticker:  a.ticker,
      shares:  a.weight > 1 ? a.weight : a.weight * 100, // treat weight as share count if imported from CSV
      avgCost: 0,
    }))
    setHoldings(imported)
  }, [])

  // ── Option entry handlers ──
  const updateLeg = (i: number, patch: Partial<LegDraft>) =>
    setOptLegs(prev => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const addLeg = () => setOptLegs(prev => [...prev, emptyLeg()])
  const removeLeg = (i: number) => setOptLegs(prev => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))

  const addOption = useCallback(() => {
    const underlying = optUnderlying.trim().toUpperCase()
    if (!underlying) return
    const legs: OptionLeg[] = optLegs.map(l => ({
      type: l.type, side: l.side,
      strike: parseFloat(l.strike), expiry: l.expiry,
      contracts: parseFloat(l.contracts), avgPremium: parseFloat(l.avgPremium),
    }))
    for (const l of legs) {
      if (!l.expiry || isNaN(l.strike) || l.strike <= 0 ||
          isNaN(l.contracts) || l.contracts <= 0 ||
          isNaN(l.avgPremium) || l.avgPremium < 0) return
    }
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now())
    setOptions(prev => [...prev, { id, underlying, name: optPreset, legs }])
    setOptUnderlying('')
    const p = OPT_PRESETS.find(x => x.name === optPreset)
    setOptLegs(p ? p.legs.map(l => emptyLeg(l.type, l.side)) : [emptyLeg()])
  }, [optUnderlying, optLegs, optPreset])

  const removeOption = (id: string) => setOptions(prev => prev.filter(p => p.id !== id))

  // Compute portfolio stats
  let totalValue = 0
  let totalCost  = 0
  const rows = holdings.map((h, i) => {
    const q        = priceResults[i]?.data as QuoteData | undefined
    const price    = q?.current_price ?? 0
    // Auto-fill avg cost from current price when user didn't enter one
    const avgCost  = h.avgCost > 0 ? h.avgCost : price
    const costIsAuto = h.avgCost <= 0 && price > 0
    const value    = h.shares * price
    const cost     = h.shares * avgCost
    const pnl      = costIsAuto ? 0 : value - cost
    const pnlPct   = costIsAuto ? 0 : (cost > 0 ? (pnl / cost) * 100 : null)
    if (price > 0) totalValue += value
    if (cost > 0) totalCost += cost
    return { ...h, avgCost, costIsAuto, price, value, cost, pnl, pnlPct, loading: priceResults[i]?.isLoading, pct1d: q?.pct_change_1d }
  })
  const totalPnl    = totalValue - totalCost
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : null

  // Option position rows — marks are aligned to the flatten order of allLegs
  const marks = marksQuery.data ?? []
  let _mi = 0
  let optTotalValue = 0, optTotalCost = 0
  const optRows = options.map(p => {
    let cost = 0, value = 0, netDelta = 0, priced = true
    const legViews = p.legs.map(l => {
      const m = marks[_mi++]
      const sign = l.side === 'long' ? 1 : -1
      const mult = l.contracts * 100
      cost += sign * l.avgPremium * mult
      if (m && m.mark != null) {
        value += sign * m.mark * mult
        if (m.delta != null) netDelta += sign * m.delta * mult
      } else { priced = false }
      return { ...l, mark: m?.mark ?? null, source: m?.source ?? null }
    })
    const pnl = priced ? value - cost : null
    const pnlPct = priced && Math.abs(cost) > 1e-9 ? (pnl! / Math.abs(cost)) * 100 : null
    optTotalCost += cost
    if (priced) optTotalValue += value
    return { ...p, legViews, cost, value: priced ? value : null, pnl, pnlPct, netDelta: priced ? netDelta : null, priced }
  })

  // Futures rows — notional + mark-to-market P&L (multiplier-aware)
  let futTotalPnl = 0
  const futRows = futures.map(f => {
    const spec = futuresSpec(f.symbol)
    const mult = spec?.multiplier ?? 1
    const mk = futMarkBySym[f.symbol] || { price: 0, pct1d: null, loading: true }
    const sign = f.side === 'long' ? 1 : -1
    const notional = mk.price * mult * f.contracts
    const pnl = mk.price > 0 ? sign * (mk.price - f.entryPrice) * mult * f.contracts : null
    const pnlPct = (mk.price > 0 && f.entryPrice > 0) ? sign * (mk.price - f.entryPrice) / f.entryPrice * 100 : null
    if (pnl != null) futTotalPnl += pnl
    return { ...f, label: spec?.label ?? f.symbol, mult, price: mk.price, pct1d: mk.pct1d, loading: mk.loading, notional, pnl, pnlPct }
  })

  // Cash rows — principal accruing interest at the chosen rate
  let cashTotalValue = 0, cashTotalCost = 0
  const cashRows = cash.map(c => {
    const value = cashValue(c)
    cashTotalValue += value
    cashTotalCost += c.amount
    return { ...c, value, accrued: value - c.amount }
  })

  // Combined account equity (equities + options value + futures P&L + cash value).
  // Futures contribute only their unrealized P&L — adding full notional would dwarf
  // the cash-funded book since you post margin, not the notional.
  const combinedValue  = totalValue + optTotalValue + futTotalPnl + cashTotalValue
  const combinedCost   = totalCost + optTotalCost + cashTotalCost
  const combinedPnl    = combinedValue - combinedCost
  const combinedPnlPct = combinedCost > 0 ? (combinedPnl / combinedCost) * 100 : null

  const handleSave = useCallback(() => {
    // The active portfolio already persists via the pm effect; Save just pushes
    // the active tab's equity weights to the cross-tool portfolio context.
    localStorage.setItem(PORTFOLIOS_KEY, JSON.stringify(pm))
    const priced = rows.filter(r => r.price > 0)
    if (priced.length > 0) {
      const total = priced.reduce((s, r) => s + r.value, 0) || 1
      syncToContext(priced.map(r => ({
        ticker: r.ticker,
        weight: Math.round((r.value / total) * 100 * 10) / 10,
      })))
    } else if (holdings.length > 0) {
      const w = Math.round(1000 / holdings.length) / 10
      syncToContext(holdings.map(h => ({ ticker: h.ticker, weight: w })))
    }
    setSaveFlash(true)
    setDirty(false)
    setTimeout(() => setSaveFlash(false), 2000)
  }, [pm, holdings, rows, syncToContext])

  const lbl: React.CSSProperties = { fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted }

  return (
    <PageWrapper title="Portfolio Manager">
      <div style={{ maxWidth: 1050, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ marginBottom: 24, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
          <div>
            <h1 style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 700, color: T.gold, letterSpacing: '0.08em', margin: 0 }}>
              PORTFOLIO MANAGER
            </h1>
            <p style={{ fontFamily: T.label, fontSize: 11, color: T.muted, marginTop: 6, marginBottom: 0 }}>
              Track stocks, options, futures, and cash across multiple saved portfolios.
            </p>
          </div>
          {(holdings.length > 0 || options.length > 0 || futures.length > 0 || cash.length > 0) && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
              <button
                onClick={handleSave}
                style={{
                  background: saveFlash ? T.gold : dirty ? 'color-mix(in srgb, var(--theme-primary) 15%, transparent)' : 'transparent',
                  border: `1px solid ${saveFlash ? T.gold : dirty ? T.gold : T.border}`,
                  color: saveFlash ? 'var(--theme-bg)' : T.gold,
                  fontFamily: T.label, fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.12em', textTransform: 'uppercase',
                  padding: '8px 20px', cursor: 'pointer',
                  transition: 'all 0.2s', whiteSpace: 'nowrap',
                }}
              >
                {saveFlash ? 'Saved' : 'Save Portfolio'}
              </button>
              {dirty && !saveFlash && (
                <span style={{ fontFamily: T.mono, fontSize: 8, color: T.muted, letterSpacing: '0.08em' }}>
                  unsaved changes
                </span>
              )}
              {saveFlash && (
                <span style={{ fontFamily: T.mono, fontSize: 8, color: 'var(--theme-positive)', letterSpacing: '0.08em' }}>
                  synced to all tools
                </span>
              )}
            </div>
          )}
        </div>

        {/* Portfolio tabs */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 16, borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
          {portfolios.map(p => {
            const isActive = p.id === active.id
            return (
              <div key={p.id} onClick={() => switchPortfolio(p.id)} style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '6px 10px', cursor: 'pointer', marginBottom: -1,
                borderBottom: isActive ? `2px solid ${T.gold}` : '2px solid transparent',
                background: isActive ? 'color-mix(in srgb, var(--theme-primary) 8%, transparent)' : 'transparent',
              }}>
                {renaming === p.id ? (
                  <input autoFocus value={p.name} onChange={e => renamePortfolio(p.id, e.target.value)}
                    onBlur={() => setRenaming(null)} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setRenaming(null) }}
                    onClick={e => e.stopPropagation()} style={{ ...inp, width: 110, padding: '2px 6px', fontSize: 11 }} />
                ) : (
                  <span onDoubleClick={() => setRenaming(p.id)} title="Double-click to rename"
                    style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: isActive ? T.gold : T.muted, whiteSpace: 'nowrap' }}>{p.name}</span>
                )}
                {portfolios.length > 1 && (
                  <button onClick={e => { e.stopPropagation(); if (confirm(`Delete portfolio "${p.name}"?`)) deletePortfolio(p.id) }}
                    style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}>×</button>
                )}
              </div>
            )
          })}
          <button onClick={addPortfolio} style={{ background: 'none', border: 'none', color: T.gold, cursor: 'pointer', fontFamily: T.label, fontSize: 11, fontWeight: 700, padding: '6px 10px', letterSpacing: '0.08em' }}>+ New</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 24, alignItems: 'start' }}>

          {/* ── Left panel ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

            {/* Add position */}
            <div>
              <div style={{ display: 'flex', marginBottom: 10, border: `1px solid ${T.border}` }}>
                {(['stock', 'option', 'future', 'cash'] as const).map(m => (
                  <button key={m} onClick={() => setEntryMode(m)} style={{
                    flex: 1, padding: '6px 0', cursor: 'pointer', border: 'none',
                    background: entryMode === m ? T.gold : 'transparent',
                    color: entryMode === m ? 'var(--theme-bg)' : T.muted,
                    fontFamily: T.label, fontSize: 8.5, fontWeight: 700,
                    letterSpacing: '0.06em', textTransform: 'uppercase',
                  }}>{m}</button>
                ))}
              </div>

              {entryMode === 'stock' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input value={newTicker} onChange={e => setNewTicker(e.target.value.toUpperCase())}
                    placeholder="Ticker (e.g. AAPL)" style={inp}
                    onKeyDown={e => e.key === 'Enter' && addHolding()} />
                  <input value={newShares} onChange={e => setNewShares(e.target.value)}
                    placeholder="Shares" type="number" min="0" style={inp}
                    onKeyDown={e => e.key === 'Enter' && addHolding()} />
                  <input value={newCost} onChange={e => setNewCost(e.target.value)}
                    placeholder="Avg Cost ($)" type="number" min="0" style={inp}
                    onKeyDown={e => e.key === 'Enter' && addHolding()} />
                  <button onClick={addHolding} style={addBtn}>Add</button>
                </div>
              ) : entryMode === 'option' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <input value={optUnderlying} onChange={e => setOptUnderlying(e.target.value.toUpperCase())}
                    placeholder="Underlying (e.g. AAPL)" style={inp} />
                  <select value={optPreset} onChange={e => applyPreset(e.target.value)} style={inp}>
                    {OPT_PRESETS.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                  {optLegs.map((l, i) => (
                    <div key={i} style={{ border: `1px solid ${T.border}`, background: T.bg, padding: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ ...lbl, fontSize: 8 }}>Leg {i + 1}</span>
                        {optLegs.length > 1 && <button onClick={() => removeLeg(i)} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>}
                      </div>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <select value={l.side} onChange={e => updateLeg(i, { side: e.target.value as Side })} style={{ ...inp, flex: 1 }}>
                          <option value="long">Long</option><option value="short">Short</option>
                        </select>
                        <select value={l.type} onChange={e => updateLeg(i, { type: e.target.value as OptType })} style={{ ...inp, flex: 1 }}>
                          <option value="call">Call</option><option value="put">Put</option>
                        </select>
                      </div>
                      <div style={{ display: 'flex', gap: 5 }}>
                        <input value={l.strike} onChange={e => updateLeg(i, { strike: e.target.value })} placeholder="Strike" type="number" style={{ ...inp, flex: 1 }} />
                        <input value={l.contracts} onChange={e => updateLeg(i, { contracts: e.target.value })} placeholder="Qty" type="number" style={{ ...inp, width: 54 }} />
                      </div>
                      <input value={l.expiry} onChange={e => updateLeg(i, { expiry: e.target.value })} type="date" style={inp} />
                      <input value={l.avgPremium} onChange={e => updateLeg(i, { avgPremium: e.target.value })} placeholder="Avg premium / sh ($)" type="number" style={inp} />
                    </div>
                  ))}
                  <button onClick={addLeg} style={ghostBtn}>+ Add leg</button>
                  <button onClick={addOption} style={addBtn}>Add Position</button>
                </div>
              ) : entryMode === 'future' ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <select value={futSym} onChange={e => setFutSym(e.target.value)} style={inp}>
                    {FUTURES_BY_GROUP.map(g => (
                      <optgroup key={g.group} label={g.group}>
                        {g.items.map(f => <option key={f.sym} value={f.sym}>{f.label} ({f.sym})</option>)}
                      </optgroup>
                    ))}
                  </select>
                  <div style={{ display: 'flex', gap: 5 }}>
                    <select value={futSide} onChange={e => setFutSide(e.target.value as Side)} style={{ ...inp, flex: 1 }}>
                      <option value="long">Long</option><option value="short">Short</option>
                    </select>
                    <input value={futContracts} onChange={e => setFutContracts(e.target.value)} placeholder="Contracts" type="number" min="0" style={{ ...inp, flex: 1 }} />
                  </div>
                  <input value={futEntry} onChange={e => setFutEntry(e.target.value)} placeholder="Entry price" type="number" min="0" style={inp}
                    onKeyDown={e => e.key === 'Enter' && addFuture()} />
                  <div style={{ fontFamily: T.label, fontSize: 8, color: T.muted }}>
                    {(() => { const s = futuresSpec(futSym); return s ? `1.00 move = $${s.multiplier.toLocaleString()} per contract` : '' })()}
                  </div>
                  <button onClick={addFuture} style={addBtn}>Add Position</button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input value={cashLabel} onChange={e => setCashLabel(e.target.value)} placeholder="Label (e.g. HYSA, T-Bills)" style={inp} />
                  <input value={cashAmount} onChange={e => setCashAmount(e.target.value)} placeholder="Amount ($)" type="number" min="0" style={inp}
                    onKeyDown={e => e.key === 'Enter' && addCash()} />
                  <div style={{ display: 'flex', gap: 5 }}>
                    <input value={cashRate} onChange={e => setCashRate(e.target.value)} placeholder="Rate % APY" type="number" step="0.1" style={{ ...inp, flex: 1 }} />
                    <input value={cashSince} onChange={e => setCashSince(e.target.value)} type="date" style={{ ...inp, flex: 1.4 }} />
                  </div>
                  <div style={{ fontFamily: T.label, fontSize: 8, color: T.muted }}>Compounds at the rate from the start date.</div>
                  <button onClick={addCash} style={addBtn}>Add Cash</button>
                </div>
              )}
            </div>

            {/* Import / Export */}
            <div>
              <div style={{ ...lbl, marginBottom: 10 }}>Import / Export</div>
              <PortfolioIO
                mode="portfolio"
                assets={holdings.map(h => ({ ticker: h.ticker, weight: h.shares, strategy: String(h.avgCost) }))}
                onImportAssets={handleImport}
                name="portfolio"
              />
              <p style={{ fontFamily: T.label, fontSize: 8, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
                CSV format: <span style={{ fontFamily: T.mono }}>TICKER,SHARES,AVG_COST</span><br />
                JSON: array of <span style={{ fontFamily: T.mono }}>{`{ticker, weight, strategy}`}</span>
              </p>
            </div>


            {/* Summary card */}
            {(holdings.length > 0 || options.length > 0 || futures.length > 0) && (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, padding: '12px 14px' }}>
                <div style={{ ...lbl, marginBottom: 12 }}>Summary</div>
                {[
                  ['Total Value',    fmtMoney(combinedValue)],
                  ['Total Cost',     fmtMoney(combinedCost)],
                  ['Total P&L',      fmtMoney(combinedPnl)],
                  ['Return',         combinedPnlPct != null ? `${combinedPnlPct >= 0 ? '+' : ''}${combinedPnlPct.toFixed(2)}%` : '—'],
                  ['Stocks',         String(holdings.length)],
                  ['Options',        String(options.length)],
                  ['Futures',        String(futures.length)],
                  ['Cash',           String(cash.length)],
                ].map(([k, v]) => (
                  <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontFamily: T.label, fontSize: 10, color: T.muted }}>{k}</span>
                    <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: k === 'Total P&L' || k === 'Return' ? (combinedPnl >= 0 ? T.pos : T.neg) : T.text }}>{v}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Holdings table ── */}
          <div>
            {holdings.length === 0 && options.length === 0 && futures.length === 0 && cash.length === 0 ? (
              <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 11 }}>
                Add a stock, option, future, or cash balance — or import a portfolio file
              </div>
            ) : (<>
              {holdings.length > 0 && (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${T.border}`, background: T.bg }}>
                      {['Ticker', 'Shares', 'Avg Cost', 'Price', '1D %', 'Value', 'P&L', 'Return', 'Weight', ''].map(h => (
                        <th key={h} style={{ padding: '7px 12px', textAlign: h === 'Ticker' ? 'left' : 'right', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const weight = totalValue > 0 ? (r.value / totalValue) * 100 : 0
                      return (
                        <tr key={r.ticker} style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? 'transparent' : 'var(--theme-hover, rgba(255,255,255,0.01))' }}>
                          <td style={{ padding: '8px 12px', color: T.gold, fontFamily: T.mono, fontWeight: 700, fontSize: 10, letterSpacing: '0.08em' }}>{r.ticker}</td>
                          {editStock?.i === i ? (<>
                            <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                              <input value={editStock.shares} onChange={e => setEditStock({ ...editStock, shares: e.target.value })} type="number" style={editInp} onKeyDown={e => { if (e.key === 'Enter') saveEditStock(); if (e.key === 'Escape') setEditStock(null) }} autoFocus />
                            </td>
                            <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                              <input value={editStock.avgCost} onChange={e => setEditStock({ ...editStock, avgCost: e.target.value })} type="number" placeholder="auto" style={editInp} onKeyDown={e => { if (e.key === 'Enter') saveEditStock(); if (e.key === 'Escape') setEditStock(null) }} />
                            </td>
                          </>) : (<>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{r.shares.toLocaleString()}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: r.costIsAuto ? T.muted : T.text }}>
                              {r.loading ? '…' : r.avgCost > 0 ? `$${r.avgCost.toFixed(2)}${r.costIsAuto ? '*' : ''}` : '—'}
                            </td>
                          </>)}
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{r.loading ? '…' : r.price > 0 ? `$${r.price.toFixed(2)}` : '—'}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: r.pct1d == null ? T.muted : r.pct1d >= 0 ? T.pos : T.neg }}>
                            {r.loading ? '…' : r.pct1d != null ? `${r.pct1d >= 0 ? '+' : ''}${r.pct1d.toFixed(2)}%` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text, fontWeight: 600 }}>{r.loading ? '…' : r.price > 0 ? fmtMoney(r.value) : '—'}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: r.costIsAuto ? T.muted : r.price > 0 ? (r.pnl >= 0 ? T.pos : T.neg) : T.muted, fontWeight: 600 }}>
                            {r.loading ? '…' : r.costIsAuto ? '—' : r.price > 0 ? `${r.pnl >= 0 ? '+' : ''}${fmtMoney(r.pnl)}` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: r.costIsAuto ? T.muted : r.pnlPct == null ? T.muted : r.pnlPct >= 0 ? T.pos : T.neg }}>
                            {r.loading ? '…' : r.costIsAuto ? '—' : r.pnlPct != null ? `${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct.toFixed(2)}%` : '—'}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>
                            {r.loading ? '…' : totalValue > 0 && r.price > 0 ? `${weight.toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ padding: '8px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {editStock?.i === i ? (<>
                              <button onClick={saveEditStock} style={{ ...editBtn, color: T.gold }}>Save</button>
                              <button onClick={() => setEditStock(null)} style={{ ...editBtn, color: T.muted }}>×</button>
                            </>) : (<>
                              <button onClick={() => setEditStock({ i, shares: String(holdings[i].shares), avgCost: holdings[i].avgCost > 0 ? String(holdings[i].avgCost) : '' })} style={{ ...editBtn, color: T.muted }}>Edit</button>
                              <button onClick={() => removeHolding(i)} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
                            </>)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>

                {/* Auto-cost footnote */}
                {rows.some(r => r.costIsAuto) && (
                  <div style={{ padding: '4px 12px 6px', fontSize: 9, color: T.muted, fontFamily: T.mono }}>
                    * avg cost auto-filled from current price — enter your actual cost basis to see P&L
                  </div>
                )}

                {/* Weight bar */}
                {totalValue > 0 && (
                  <div style={{ display: 'flex', height: 4, overflow: 'hidden' }}>
                    {rows.map((r, i) => {
                      const w = (r.value / totalValue) * 100
                      const colors = ['#c9a84c','#60a5fa','#22c55e','#ef4444','#a78bfa','#f97316','#38bdf8','#fb923c','#4ade80','#f472b6','#facc15']
                      return <div key={r.ticker} style={{ width: `${w}%`, background: colors[i % colors.length], transition: 'width 0.3s' }} />
                    })}
                  </div>
                )}
              </div>
              )}

              {/* ── Options & spreads ── */}
              {options.length > 0 && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, overflow: 'hidden', marginTop: holdings.length > 0 ? 16 : 0 }}>
                  <div style={{ ...lbl, padding: '8px 12px', borderBottom: `1px solid ${T.border}`, background: T.bg }}>Options &amp; Spreads</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${T.border}`, background: T.bg }}>
                        {['Position', 'Legs', 'Net Cost', 'Value', 'P&L', 'Return', 'Δ', ''].map(h => (
                          <th key={h} style={{ padding: '7px 12px', textAlign: (h === 'Position' || h === 'Legs') ? 'left' : 'right', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {optRows.map((p, i) => {
                        const credit = p.cost < 0
                        return (
                          <tr key={p.id} style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? 'transparent' : 'var(--theme-hover, rgba(255,255,255,0.01))', verticalAlign: 'top' }}>
                            <td style={{ padding: '8px 12px' }}>
                              <div style={{ color: T.gold, fontWeight: 700, letterSpacing: '0.08em' }}>{p.underlying}</div>
                              <div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>{p.name}</div>
                            </td>
                            <td style={{ padding: '8px 12px', color: T.text, fontSize: 9, lineHeight: 1.7 }}>
                              {p.legViews.map((l, j) => (
                                <div key={j}>
                                  <span style={{ color: l.side === 'long' ? T.pos : T.neg, fontWeight: 700 }}>{l.side === 'long' ? '+' : '−'}{l.contracts}</span>{' '}
                                  {fmtStrike(l.strike)}{l.type === 'call' ? 'C' : 'P'} {fmtExp(l.expiry)}
                                  {l.mark != null && <span style={{ color: T.muted }}> @ ${l.mark.toFixed(2)}</span>}
                                </div>
                              ))}
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>
                              {credit ? `+${fmtMoney(-p.cost)}` : fmtMoney(p.cost)}
                              <div style={{ color: T.muted, fontSize: 8 }}>{credit ? 'credit' : 'debit'}</div>
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text, fontWeight: 600 }}>{p.value != null ? fmtMoney(p.value) : '…'}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: p.pnl == null ? T.muted : p.pnl >= 0 ? T.pos : T.neg }}>{p.pnl != null ? `${p.pnl >= 0 ? '+' : ''}${fmtMoney(p.pnl)}` : '…'}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: p.pnlPct == null ? T.muted : p.pnlPct >= 0 ? T.pos : T.neg }}>{p.pnlPct != null ? `${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}%` : '—'}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>{p.netDelta != null ? p.netDelta.toFixed(0) : '—'}</td>
                            <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                              <button onClick={() => removeOption(p.id)} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <div style={{ padding: '4px 12px 6px', fontSize: 9, color: T.muted, fontFamily: T.mono }}>
                    Δ = net share-equivalent delta. Marks from the live chain, Black-Scholes when a contract is unlisted.
                  </div>
                </div>
              )}

              {/* ── Futures ── */}
              {futures.length > 0 && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, overflow: 'hidden', marginTop: (holdings.length > 0 || options.length > 0) ? 16 : 0 }}>
                  <div style={{ ...lbl, padding: '8px 12px', borderBottom: `1px solid ${T.border}`, background: T.bg }}>Futures</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${T.border}`, background: T.bg }}>
                        {['Contract', 'Side', 'Qty', 'Entry', 'Mark', '1D %', 'Notional', 'P&L', 'Return', ''].map(h => (
                          <th key={h} style={{ padding: '7px 12px', textAlign: (h === 'Contract' || h === 'Side') ? 'left' : 'right', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {futRows.map((f, i) => (
                        <tr key={f.id} style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? 'transparent' : 'var(--theme-hover, rgba(255,255,255,0.01))' }}>
                          <td style={{ padding: '8px 12px' }}>
                            <div style={{ color: T.gold, fontWeight: 700, letterSpacing: '0.08em' }}>{f.symbol}</div>
                            <div style={{ color: T.muted, fontSize: 9, marginTop: 2 }}>{f.label}</div>
                          </td>
                          <td style={{ padding: '8px 12px', color: f.side === 'long' ? T.pos : T.neg, fontWeight: 700, textTransform: 'capitalize' }}>{f.side}</td>
                          {editFut?.id === f.id ? (<>
                            <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                              <input value={editFut.contracts} onChange={e => setEditFut({ ...editFut, contracts: e.target.value })} type="number" style={{ ...editInp, width: 50 }} onKeyDown={e => { if (e.key === 'Enter') saveEditFut(); if (e.key === 'Escape') setEditFut(null) }} autoFocus />
                            </td>
                            <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                              <input value={editFut.entry} onChange={e => setEditFut({ ...editFut, entry: e.target.value })} type="number" style={editInp} onKeyDown={e => { if (e.key === 'Enter') saveEditFut(); if (e.key === 'Escape') setEditFut(null) }} />
                            </td>
                          </>) : (<>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{f.contracts}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{f.entryPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                          </>)}
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{f.loading ? '…' : f.price > 0 ? f.price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: f.pct1d == null ? T.muted : f.pct1d >= 0 ? T.pos : T.neg }}>{f.pct1d != null ? `${f.pct1d >= 0 ? '+' : ''}${f.pct1d.toFixed(2)}%` : '—'}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{f.price > 0 ? fmtMoney(f.notional) : '—'}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: f.pnl == null ? T.muted : f.pnl >= 0 ? T.pos : T.neg }}>{f.pnl != null ? `${f.pnl >= 0 ? '+' : ''}${fmtMoney(f.pnl)}` : '…'}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: f.pnlPct == null ? T.muted : f.pnlPct >= 0 ? T.pos : T.neg }}>{f.pnlPct != null ? `${f.pnlPct >= 0 ? '+' : ''}${f.pnlPct.toFixed(1)}%` : '—'}</td>
                          <td style={{ padding: '8px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {editFut?.id === f.id ? (<>
                              <button onClick={saveEditFut} style={{ ...editBtn, color: T.gold }}>Save</button>
                              <button onClick={() => setEditFut(null)} style={{ ...editBtn, color: T.muted }}>×</button>
                            </>) : (<>
                              <button onClick={() => setEditFut({ id: f.id, contracts: String(f.contracts), entry: String(f.entryPrice) })} style={{ ...editBtn, color: T.muted }}>Edit</button>
                              <button onClick={() => removeFuture(f.id)} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
                            </>)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ padding: '4px 12px 6px', fontSize: 9, color: T.muted, fontFamily: T.mono }}>
                    Notional = mark × contract multiplier × contracts. P&L is mark-to-market on the continuous contract.
                  </div>
                </div>
              )}

              {/* ── Cash ── */}
              {cash.length > 0 && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, overflow: 'hidden', marginTop: (holdings.length > 0 || options.length > 0 || futures.length > 0) ? 16 : 0 }}>
                  <div style={{ ...lbl, padding: '8px 12px', borderBottom: `1px solid ${T.border}`, background: T.bg }}>Cash</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${T.border}`, background: T.bg }}>
                        {['Account', 'Principal', 'Rate', 'Since', 'Interest', 'Value', ''].map(h => (
                          <th key={h} style={{ padding: '7px 12px', textAlign: h === 'Account' ? 'left' : 'right', fontFamily: T.label, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: T.muted, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {cashRows.map((c, i) => (
                        <tr key={c.id} style={{ borderBottom: `1px solid ${T.border}`, background: i % 2 === 0 ? 'transparent' : 'var(--theme-hover, rgba(255,255,255,0.01))' }}>
                          <td style={{ padding: '8px 12px', color: T.gold, fontWeight: 700 }}>{c.label}</td>
                          {editCash?.id === c.id ? (<>
                            <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                              <input value={editCash.amount} onChange={e => setEditCash({ ...editCash, amount: e.target.value })} type="number" style={editInp} onKeyDown={e => { if (e.key === 'Enter') saveEditCash(); if (e.key === 'Escape') setEditCash(null) }} autoFocus />
                            </td>
                            <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                              <input value={editCash.rate} onChange={e => setEditCash({ ...editCash, rate: e.target.value })} type="number" step="0.1" style={{ ...editInp, width: 56 }} onKeyDown={e => { if (e.key === 'Enter') saveEditCash(); if (e.key === 'Escape') setEditCash(null) }} />
                            </td>
                          </>) : (<>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{fmtMoney(c.amount)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{c.rate.toFixed(2)}%</td>
                          </>)}
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>{fmtExp(c.since)}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: c.accrued >= 0 ? T.pos : T.neg }}>{`${c.accrued >= 0 ? '+' : ''}${fmtMoney(c.accrued)}`}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text, fontWeight: 600 }}>{fmtMoney(c.value)}</td>
                          <td style={{ padding: '8px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {editCash?.id === c.id ? (<>
                              <button onClick={saveEditCash} style={{ ...editBtn, color: T.gold }}>Save</button>
                              <button onClick={() => setEditCash(null)} style={{ ...editBtn, color: T.muted }}>×</button>
                            </>) : (<>
                              <button onClick={() => setEditCash({ id: c.id, amount: String(c.amount), rate: String(c.rate) })} style={{ ...editBtn, color: T.muted }}>Edit</button>
                              <button onClick={() => removeCash(c.id)} style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
                            </>)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ padding: '4px 12px 6px', fontSize: 9, color: T.muted, fontFamily: T.mono }}>
                    Value compounds at the APY from the start date. Interest is the accrued growth.
                  </div>
                </div>
              )}
            </>)}

            {/* Allocation visual */}
            {rows.length > 0 && totalValue > 0 && (
              <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {rows.map((r, i) => {
                  const w = (r.value / totalValue) * 100
                  const colors = ['#c9a84c','#60a5fa','#22c55e','#ef4444','#a78bfa','#f97316','#38bdf8','#fb923c','#4ade80','#f472b6','#facc15']
                  return (
                    <div key={r.ticker} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: colors[i % colors.length], flexShrink: 0 }} />
                      <span style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>{r.ticker} {w.toFixed(1)}%</span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </PageWrapper>
  )
}
