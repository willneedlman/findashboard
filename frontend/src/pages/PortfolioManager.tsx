import { T } from '../lib/theme'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import axios from 'axios'
import { useQueries, useQuery } from '@tanstack/react-query'
import PageWrapper from '../components/PageWrapper'
import PortfolioIO, { type PortfolioAsset } from '../components/PortfolioIO'
import ScreenshotPortfolioImport from '../components/ScreenshotPortfolioImport'
import { usePortfolio } from '../contexts/PortfolioContext'
import { FUTURES, FUTURES_BY_GROUP, futuresSpec } from '../lib/futures'
import { normalizeTicker, notifyPortfolioContextChanged } from '../lib/pmImport'
import useIsMobile from '../hooks/useIsMobile'


const STORAGE_KEY = 'ft-portfolio-manager'

interface Holding {
  ticker:   string
  shares:   number
  avgCost:  number
  useMarketPrice?: boolean
  pendingInvestmentAmount?: number
  quantityMode?: 'shares' | 'dollars'
}

interface QuoteData {
  current_price:    number | null
  pct_change_1d:    number | null
  market_cap?:      number | null
  source?:          string
  session?:         string
  as_of?:           string | null
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
// overviewIds is the independent cross-tool pointer used by dashboards and
// analysis tools. Portfolio Manager itself only reads and writes activeId.
interface PMState { portfolios: Portfolio[]; activeId: string; overviewIds?: string[] }
const PORTFOLIOS_KEY = 'pm-portfolios-v2'
const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now() + Math.random())

function loadPortfolios(): PMState {
  try {
    const raw = localStorage.getItem(PORTFOLIOS_KEY)
    if (raw) {
      const d = JSON.parse(raw)
      if (d?.portfolios?.length) {
        // Backfill every position array so portfolios saved before a field
        // existed (e.g. options/futures) don't crash downstream consumers.
        d.portfolios = d.portfolios.map((p: Portfolio) => ({
          ...p, holdings: p.holdings ?? [], options: p.options ?? [], futures: p.futures ?? [], cash: p.cash ?? [],
        }))
        const activeId = d.portfolios.some((p: Portfolio) => p.id === d.activeId) ? d.activeId : d.portfolios[0].id
        return { ...d, activeId }
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

export function PortfolioManagerContent() {
  const isMobile = useIsMobile()
  const navigate = useNavigate()
  // Multi-portfolio store — the active tab is the working set. The position
  // setters below patch the active portfolio so the rest of the component (add/
  // remove/edit handlers, marks queries) works unchanged.
  const [pm, setPm] = useState<PMState>(loadPortfolios)
  const portfolios = pm.portfolios
  const active = portfolios.find(p => p.id === pm.activeId) ?? portfolios[0]
  const validOverviewIds = (pm.overviewIds ?? []).filter(id => portfolios.some(p => p.id === id))
  const overviewIds = validOverviewIds.length ? validOverviewIds : [active.id]

  const holdings = active.holdings
  const options = active.options
  const futures = active.futures
  const cash = active.cash

  const patchActive = useCallback((patch: (p: Portfolio) => Partial<Portfolio>) =>
    setPm(s => ({ ...s, portfolios: s.portfolios.map(p => p.id === s.activeId ? { ...p, ...patch(p) } : p) })), [])
  const setHoldings = useCallback((u: Upd<Holding[]>) => patchActive(p => ({ holdings: typeof u === 'function' ? u(p.holdings) : u })), [patchActive])
  const setOptions  = useCallback((u: Upd<OptionPosition[]>) => patchActive(p => ({ options: typeof u === 'function' ? u(p.options) : u })), [patchActive])
  const setFutures  = useCallback((u: Upd<FuturePosition[]>) => patchActive(p => ({ futures: typeof u === 'function' ? u(p.futures) : u })), [patchActive])
  const setCash     = useCallback((u: Upd<CashPosition[]>) => patchActive(p => ({ cash: typeof u === 'function' ? u(p.cash) : u })), [patchActive])

  const [newTicker,  setNewTicker]  = useState('')
  const [newShares,  setNewShares]  = useState('')
  const [newCost,    setNewCost]    = useState('')
  const [newCostMode, setNewCostMode] = useState<'manual' | 'market'>('manual')
  const [newQuantityMode, setNewQuantityMode] = useState<'shares' | 'dollars'>('shares')

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
  const [editStock, setEditStock] = useState<{ i: number; quantity: string; quantityMode: 'shares' | 'dollars'; avgCost: string; costMode: 'manual' | 'market' } | null>(null)
  const [fetchingMarketCosts, setFetchingMarketCosts] = useState(false)
  const [marketCostResult, setMarketCostResult] = useState<string | null>(null)
  const [editFut, setEditFut] = useState<{ id: string; contracts: string; entry: string } | null>(null)
  const [editCash, setEditCash] = useState<{ id: string; amount: string; rate: string } | null>(null)
  const [portfolioName, setPortfolioName] = useState(() => localStorage.getItem('pmPortfolioName') || 'Portfolio')

  // Tab management
  const clearEdits = () => { setEditStock(null); setEditFut(null); setEditCash(null) }
  const addPortfolio = () => setPm(s => { const id = uid(); return { ...s, portfolios: [...s.portfolios, { id, name: `Portfolio ${s.portfolios.length + 1}`, holdings: [], options: [], futures: [], cash: [] }], activeId: id } })
  const switchPortfolio = (id: string) => { clearEdits(); setPm(s => ({ ...s, activeId: id })) }
  const renamePortfolio = (id: string, name: string) => setPm(s => ({ ...s, portfolios: s.portfolios.map(p => p.id === id ? { ...p, name } : p) }))
  const deletePortfolio = (id: string) => { clearEdits(); setPm(s => { const rest = s.portfolios.filter(p => p.id !== id); if (!rest.length) return s; const activeId = s.activeId === id ? rest[0].id : s.activeId; return { ...s, portfolios: rest, activeId, overviewIds: (s.overviewIds ?? []).filter(x => rest.some(p => p.id === x)) } }) }
  const toggleOverviewPortfolio = (id: string) => setPm(s => {
    const valid = (s.overviewIds ?? []).filter(candidate => s.portfolios.some(p => p.id === candidate))
    const selected = new Set(valid.length ? valid : [s.activeId])
    if (selected.has(id)) {
      if (selected.size > 1) selected.delete(id)
    } else selected.add(id)
    return { ...s, overviewIds: s.portfolios.filter(p => selected.has(p.id)).map(p => p.id) }
  })
  const selectAllForOverview = () => setPm(s => ({
    ...s,
    overviewIds: overviewIds.length === s.portfolios.length ? [s.activeId] : s.portfolios.map(p => p.id),
  }))
  const [renaming, setRenaming] = useState<string | null>(null)

  const mountRef = useRef(false)
  useEffect(() => {
    localStorage.setItem(PORTFOLIOS_KEY, JSON.stringify(pm))
    if (!mountRef.current) { mountRef.current = true; return }
    notifyPortfolioContextChanged()
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

  // Heal legacy share-class symbols (BRK.B -> BRK-B) so they resolve and quote;
  // runs only when a stored ticker actually differs from its normalized form.
  useEffect(() => {
    if (holdings.some(h => h.ticker !== normalizeTicker(h.ticker))) {
      setHoldings(prev => prev.map(h => ({ ...h, ticker: normalizeTicker(h.ticker) })))
    }
  }, [holdings, setHoldings])

  // Fetch live prices for all tickers (normalize so a legacy BRK.B never 404s
  // in the render before the heal effect above persists BRK-B).
  const stockSymbols = Array.from(new Set(holdings.map(h => normalizeTicker(h.ticker)))).sort()
  const portfolioQuotes = useQuery<{ quotes: Record<string, QuoteData> }>({
    queryKey: ['pm-quotes', stockSymbols.join(',')],
    queryFn: () => axios.get(`/api/market/quotes?tickers=${encodeURIComponent(stockSymbols.join(','))}`)
      .then(r => r.data as { quotes: Record<string, QuoteData> }),
    enabled: stockSymbols.length > 0,
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    retry: 1,
  })

  // Dividend snapshot (yield + $/share) for every distinct holding, batched.
  const divTickers = Array.from(new Set(holdings.map(h => normalizeTicker(h.ticker)))).sort()
  const dividendsQuery = useQuery({
    queryKey: ['pm-dividends', divTickers.join(',')],
    queryFn:  () => axios.get(`/api/market/dividends?tickers=${divTickers.join(',')}`)
                      .then(r => r.data as Record<string, { annual_dividend: number; dividend_yield: number }>),
    enabled:  divTickers.length > 0,
    staleTime: 6 * 60 * 60_000,   // dividends move slowly; refetch a few times a day
  })
  const divData = dividendsQuery.data ?? {}

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
  const changeEditQuantityMode = (quantityMode: 'shares' | 'dollars') => {
    setEditStock(current => {
      if (!current || current.quantityMode === quantityMode) return current
      const holding = holdings[current.i]
      const quote = portfolioQuotes.data?.quotes[normalizeTicker(holding.ticker)]?.current_price ?? 0
      const basis = current.costMode === 'manual' ? parseFloat(current.avgCost) : (holding.avgCost || quote)
      const quantity = parseFloat(current.quantity)
      const converted = Number.isFinite(quantity) && quantity > 0 && Number.isFinite(basis) && basis > 0
        ? (quantityMode === 'dollars' ? quantity * basis : quantity / basis)
        : 0
      return { ...current, quantityMode, quantity: converted > 0 ? String(Number(converted.toFixed(6))) : '' }
    })
  }

  const saveEditStock = () => {
    if (!editStock) return
    const quantity = parseFloat(editStock.quantity)
    const avgCost = editStock.costMode === 'market' ? (holdings[editStock.i]?.avgCost ?? 0) : parseFloat(editStock.avgCost)
    if (isNaN(quantity) || quantity <= 0 || isNaN(avgCost) || avgCost < 0 || (editStock.costMode === 'manual' && avgCost <= 0)) return
    const pendingInvestmentAmount = editStock.quantityMode === 'dollars' && editStock.costMode === 'market' ? quantity : undefined
    const shares = editStock.quantityMode === 'dollars'
      ? (editStock.costMode === 'manual' ? quantity / avgCost : 0)
      : quantity
    setHoldings(prev => prev.map((h, j) => j === editStock.i ? {
      ...h, shares, avgCost, useMarketPrice: editStock.costMode === 'market', pendingInvestmentAmount,
      quantityMode: editStock.quantityMode,
    } : h))
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
    if (isNaN(amount) || isNaN(rate)) return
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
    const ticker  = normalizeTicker(newTicker)
    const quantity = parseFloat(newShares)
    const avgCost = newCostMode === 'market' ? 0 : parseFloat(newCost)
    if (!ticker || isNaN(quantity) || quantity <= 0 || isNaN(avgCost) || (newCostMode === 'manual' && avgCost <= 0)) return
    const pendingInvestmentAmount = newQuantityMode === 'dollars' && newCostMode === 'market' ? quantity : undefined
    const shares = newQuantityMode === 'dollars'
      ? (newCostMode === 'manual' ? quantity / avgCost : 0)
      : quantity
    setHoldings(prev => {
      const existing = prev.findIndex(h => h.ticker === ticker)
      if (existing >= 0) {
        return prev.map((h, i) => i === existing ? { ...h, shares, avgCost, useMarketPrice: newCostMode === 'market', pendingInvestmentAmount, quantityMode: newQuantityMode } : h)
      }
      return [...prev, { ticker, shares, avgCost, useMarketPrice: newCostMode === 'market', pendingInvestmentAmount, quantityMode: newQuantityMode }]
    })
    setNewTicker(''); setNewShares(''); setNewCost('')
  }, [newTicker, newShares, newCost, newCostMode, newQuantityMode, setHoldings])

  const fetchSelectedMarketCosts = useCallback(async () => {
    const selected = holdings.filter(h => h.useMarketPrice)
    if (!selected.length) return
    setFetchingMarketCosts(true)
    setMarketCostResult(null)
    try {
      const refreshed = await portfolioQuotes.refetch()
      if (refreshed.error) throw refreshed.error
      const quotes = refreshed.data?.quotes ?? portfolioQuotes.data?.quotes ?? {}
      const updated = selected.filter(h => {
        const price = quotes[normalizeTicker(h.ticker)]?.current_price
        return price != null && price > 0
      }).length
      setHoldings(prev => prev.map(h => {
        if (!h.useMarketPrice) return h
        const price = quotes[normalizeTicker(h.ticker)]?.current_price
        if (price == null || price <= 0) return h
        const shares = h.pendingInvestmentAmount && h.pendingInvestmentAmount > 0
          ? h.pendingInvestmentAmount / price
          : h.shares
        return { ...h, shares, avgCost: price, pendingInvestmentAmount: undefined }
      }))
      setMarketCostResult(updated === selected.length ? `${updated} UPDATED` : `${updated}/${selected.length} UPDATED`)
    } catch {
      setMarketCostResult('FETCH FAILED')
    } finally {
      setFetchingMarketCosts(false)
    }
  }, [holdings, portfolioQuotes, setHoldings])

  const removeHolding = (i: number) => setHoldings(prev => prev.filter((_, j) => j !== i))

  // Import from PortfolioIO
  const handleImport = useCallback((assets: PortfolioAsset[]) => {
    // assets have ticker + weight (0-1 or 0-100); map to holding with weight as placeholder shares
    const imported: Holding[] = assets.map(a => ({
      ticker:  a.ticker,
      // A real portfolio export carries avg_cost, so weight is a literal share count
      // (may be fractional/1). Only the legacy weight-only format uses the 0-1 heuristic.
      shares:  (a.avgCost != null || a.weight > 1) ? a.weight : a.weight * 100,
      avgCost: a.avgCost ?? 0,                           // restore per-share cost when present
    }))
    setHoldings(imported)
  }, [])

  // Merge holdings parsed from a screenshot (see ScreenshotPortfolioImport): a
  // ticker already held gets its shares/cost updated (null avgCost keeps the
  // existing cost basis), a new ticker is appended — same semantics as addHolding,
  // just batched for however many rows the user confirmed.
  const importScreenshot = useCallback((payload: {
    holdings: { ticker: string; shares: number; avgCost: number | null }[]
    options: { underlying: string; type: OptType; strike: number; expiry: string; side: Side; contracts: number; avgPremium: number | null }[]
    cash?: { label: string; amount: number }[]
  }) => {
    const { holdings, options } = payload
    const cashRows = payload.cash ?? []
    if (holdings.length) {
      setHoldings(prev => {
        let next = [...prev]
        for (const row of holdings) {
          const ticker = normalizeTicker(row.ticker)
          if (!ticker || !(row.shares > 0)) continue
          const existing = next.findIndex(h => h.ticker === ticker)
          const avgCost = row.avgCost ?? (existing >= 0 ? next[existing].avgCost : 0)
          if (existing >= 0) next[existing] = { ...next[existing], shares: row.shares, avgCost }
          else next.push({ ticker, shares: row.shares, avgCost })
        }
        return next
      })
    }
    // Each parsed contract lands as its own single-leg option position (the same
    // shape the manual Add-Option form produces); the user can merge legs later.
    if (options.length) {
      setOptions(prev => [
        ...prev,
        ...options
          .filter(o => o.underlying.trim() && o.strike > 0 && o.expiry.trim() && o.contracts > 0)
          .map(o => ({
            id: uid(),
            underlying: normalizeTicker(o.underlying),
            name: `${o.side === 'long' ? 'Long' : 'Short'} ${o.type === 'call' ? 'Call' : 'Put'}`,
            legs: [{ type: o.type, strike: o.strike, expiry: o.expiry, side: o.side, contracts: o.contracts, avgPremium: o.avgPremium ?? 0 }],
          })),
      ])
    }
    // Cash is matched on label so re-importing the same screenshot updates the
    // balance rather than stacking a second copy of it. Rate stays zero: a
    // screenshot shows a balance, never the yield it accrues at.
    if (cashRows.length) {
      setCash(prev => {
        const next = [...prev]
        for (const row of cashRows) {
          const label = row.label.trim()
          if (!label) continue
          const existing = next.findIndex(c => c.label.trim().toLowerCase() === label.toLowerCase())
          if (existing >= 0) next[existing] = { ...next[existing], amount: row.amount }
          else next.push({ id: uid(), label, amount: row.amount, rate: 0, since: todayISO })
        }
        return next
      })
    }
  }, [setHoldings, setOptions, setCash])

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
  let totalAnnualIncome = 0   // sum of (annual $/share dividend × shares)
  const rows = holdings.map((h, i) => {
    const q        = portfolioQuotes.data?.quotes[normalizeTicker(h.ticker)]
    const price    = q?.current_price ?? 0
    // Auto-fill avg cost from current price when user didn't enter one
    const avgCost  = h.avgCost > 0 ? h.avgCost : price
    const costIsAuto = h.avgCost <= 0 && price > 0
    const value    = h.shares * price
    const cost     = h.shares * avgCost
    const pnl      = costIsAuto ? 0 : value - cost
    const pnlPct   = costIsAuto ? 0 : (cost > 0 ? (pnl / cost) * 100 : null)
    const div      = divData[normalizeTicker(h.ticker)]
    const divYield = div?.dividend_yield ?? 0
    const annualIncome = (div?.annual_dividend ?? 0) * h.shares
    if (price > 0) totalValue += value
    if (cost > 0) totalCost += cost
    totalAnnualIncome += annualIncome
    return { ...h, avgCost, costIsAuto, costIsMarket: !!h.useMarketPrice, price, value, cost, pnl, pnlPct, divYield, annualIncome, loading: portfolioQuotes.isLoading, pct1d: q?.pct_change_1d, quoteSource: q?.source, quoteSession: q?.session, quoteAsOf: q?.as_of }
  })
  const totalPnl    = totalValue - totalCost
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : null
  // Portfolio income metrics: blended yield on current equity value, and
  // yield-on-cost against what was paid for the dividend-paying holdings.
  const portfolioYield   = totalValue > 0 ? (totalAnnualIncome / totalValue) * 100 : null
  const yieldOnCost      = totalCost  > 0 ? (totalAnnualIncome / totalCost)  * 100 : null

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

  // Proceeds join the cash you already hold rather than littering the book with a
  // "TSLL close" line per exit. The largest existing balance is the one treated as
  // the account's cash — a money market sweep is where a real broker would credit
  // it — and a book with no cash position at all gets one created.
  const creditCash = useCallback((amount: number, fallbackLabel: string) => {
    setCash(prev => {
      if (!prev.length) {
        return [{ id: uid(), label: fallbackLabel, amount, rate: 0, since: todayISO }]
      }
      let target = 0
      for (let i = 1; i < prev.length; i++) {
        if (Math.abs(prev[i].amount) > Math.abs(prev[target].amount)) target = i
      }
      return prev.map((c, i) => (i === target ? { ...c, amount: c.amount + amount } : c))
    })
  }, [setCash])

  const closeHoldingToCash = (row: (typeof rows)[number], index: number) => {
    // Proceeds are the live mark, not cost basis: closing realises what the
    // position is worth now. Without a quote there is no proceeds figure to
    // post, so the action stays disabled rather than booking a guess.
    if (!(row.price > 0)) return
    const amount = Number((row.shares * row.price).toFixed(2))
    const realised = row.costIsAuto ? null : Number((row.value - row.cost).toFixed(2))
    const pnlNote = realised == null ? '' : ` Realised P&L ${realised >= 0 ? '+' : ''}${fmtMoney(realised)}.`
    if (!confirm(
      `Close ${row.shares} ${normalizeTicker(row.ticker)} at ${fmtMoney(row.price)} and add ${fmtMoney(amount)} to ${cash.length ? 'your cash balance' : 'cash'}?${pnlNote}`
    )) return
    creditCash(amount, 'Cash')
    setHoldings(prev => prev.filter((_, j) => j !== index))
  }

  const closeOptionToCash = (position: (typeof optRows)[number]) => {
    if (position.value == null) return
    const amount = Number(position.value.toFixed(2))
    const direction = amount >= 0 ? 'credit' : 'debit'
    if (!confirm(`Close ${position.underlying} ${position.name} at the current marked value and ${direction === 'credit' ? 'add' : 'deduct'} ${fmtMoney(Math.abs(amount))} ${direction === 'credit' ? 'to' : 'from'} ${cash.length ? 'your cash balance' : 'cash'}?`)) return
    creditCash(amount, 'Cash')
    setOptions(prev => prev.filter(p => p.id !== position.id))
  }

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
  const cashRows = cash.filter((c): c is CashPosition => c != null).map(c => {
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
    <>
      <div className="w-full">

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginBottom: 16, paddingBottom: 10, borderBottom: `1px solid ${T.border}`, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ ...lbl, fontSize: 8.5 }}>Portfolio</span>
            <select value={active.id} onChange={e => switchPortfolio(e.target.value)} style={{ ...inp, minWidth: 190, padding: '6px 28px 6px 9px', fontSize: 11, cursor: 'pointer' }}>
              {portfolios.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {renaming === active.id ? (
            <input autoFocus value={active.name} onChange={e => renamePortfolio(active.id, e.target.value)}
              onBlur={() => setRenaming(null)} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') setRenaming(null) }}
              aria-label="Portfolio name" style={{ ...inp, width: 150, padding: '6px 9px', fontSize: 11 }} />
          ) : (
            <button onClick={() => setRenaming(active.id)} style={{ background: 'none', border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer', fontFamily: T.label, fontSize: 9, fontWeight: 700, padding: '6px 9px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Rename</button>
          )}
          {portfolios.length > 1 && (
            <button onClick={() => { if (confirm(`Delete portfolio "${active.name}"?`)) deletePortfolio(active.id) }}
              style={{ background: 'none', border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer', fontFamily: T.label, fontSize: 9, fontWeight: 700, padding: '6px 9px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Delete</button>
          )}
          <button onClick={addPortfolio} style={{ background: 'none', border: `1px solid ${T.gold}`, color: T.gold, cursor: 'pointer', fontFamily: T.label, fontSize: 9, fontWeight: 700, padding: '6px 10px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>+ New Portfolio</button>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'flex-end', gap: 6, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginRight: 2 }}>
              <span style={{ ...lbl, fontSize: 8.5 }}>Overview output</span>
              <span style={{ fontFamily: T.mono, fontSize: 8.5, color: T.muted }}>Feeds dashboards and analysis tools</span>
            </div>
            {portfolios.map(p => {
              const selected = overviewIds.includes(p.id)
              return <button key={p.id} type="button" aria-pressed={selected} onClick={() => toggleOverviewPortfolio(p.id)} title="Include this portfolio in the shared Overview output" style={{ height: 29, padding: '0 9px', background: selected ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent', border: `1px solid ${selected ? T.gold : T.border}`, color: selected ? T.gold : T.muted, cursor: 'pointer', fontFamily: T.mono, fontSize: 9.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{p.name}</button>
            })}
            {portfolios.length > 1 && <button type="button" onClick={selectAllForOverview} style={{ height: 29, padding: '0 9px', background: 'transparent', border: `1px solid ${T.border}`, color: T.muted, cursor: 'pointer', fontFamily: T.label, fontSize: 8.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{overviewIds.length === portfolios.length ? 'Active only' : 'All'}</button>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : '260px 1fr', gap: isMobile ? 16 : 24, alignItems: 'start' }}>

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
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', border: `1px solid ${T.border}` }}>
                    {([
                      ['shares', 'SHARES'],
                      ['dollars', 'DOLLAR AMOUNT'],
                    ] as const).map(([mode, label]) => (
                      <button key={mode} type="button" onClick={() => setNewQuantityMode(mode)} style={{
                        height: 30, border: 'none', borderRight: mode === 'shares' ? `1px solid ${T.border}` : 'none',
                        background: newQuantityMode === mode ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                        color: newQuantityMode === mode ? T.gold : T.muted, cursor: 'pointer', fontFamily: T.label,
                        fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em',
                      }}>{label}</button>
                    ))}
                  </div>
                  <input value={newShares} onChange={e => setNewShares(e.target.value)}
                    placeholder={newQuantityMode === 'shares' ? 'Shares' : 'Investment amount ($)'} type="number" min="0" style={inp}
                    onKeyDown={e => e.key === 'Enter' && addHolding()} />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', border: `1px solid ${T.border}` }}>
                    {([
                      ['manual', 'AVG COST'],
                      ['market', 'MKT PRICE'],
                    ] as const).map(([mode, label]) => (
                      <button key={mode} type="button" onClick={() => setNewCostMode(mode)} style={{
                        height: 30, border: 'none', borderRight: mode === 'manual' ? `1px solid ${T.border}` : 'none',
                        background: newCostMode === mode ? 'color-mix(in srgb, var(--theme-primary, #c9a84c) 14%, transparent)' : 'transparent',
                        color: newCostMode === mode ? T.gold : T.muted, cursor: 'pointer', fontFamily: T.label,
                        fontSize: 8.5, fontWeight: 700, letterSpacing: '0.08em',
                      }}>{label}</button>
                    ))}
                  </div>
                  {newCostMode === 'manual' ? (
                    <input value={newCost} onChange={e => setNewCost(e.target.value)}
                      placeholder="Avg Cost ($)" type="number" min="0" style={inp}
                      onKeyDown={e => e.key === 'Enter' && addHolding()} />
                  ) : (
                    <div style={{ ...inp, height: 32, display: 'flex', alignItems: 'center', color: T.muted }}>
                      {newQuantityMode === 'dollars'
                        ? 'FETCH converts this amount to fractional shares at the current price.'
                        : 'Add now, then FETCH current market prices in the portfolio table.'}
                    </div>
                  )}
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
              <input
                value={portfolioName}
                onChange={e => { setPortfolioName(e.target.value); localStorage.setItem('pmPortfolioName', e.target.value) }}
                placeholder="Portfolio name"
                aria-label="Portfolio name (used for the export filename)"
                style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.text, fontFamily: T.label, fontSize: 11, padding: '5px 8px', width: '100%', outline: 'none', boxSizing: 'border-box', marginBottom: 8 }}
                onFocus={e => (e.target.style.borderColor = T.gold)}
                onBlur={e => (e.target.style.borderColor = T.border)}
              />
              <PortfolioIO
                mode="portfolio"
                assets={holdings.map(h => ({ ticker: h.ticker, weight: h.shares, avgCost: h.avgCost }))}
                onImportAssets={handleImport}
                name={portfolioName.trim() || 'Portfolio'}
              />
              <p style={{ fontFamily: T.label, fontSize: 8, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
                Exports as <span style={{ fontFamily: T.mono }}>{(portfolioName.trim() || 'Portfolio').replace(/\s+/g, '-')}-{new Date().toISOString().split('T')[0]}</span><br />
                CSV columns: <span style={{ fontFamily: T.mono }}>TICKER,SHARES,AVG_COST</span>
              </p>
              <ScreenshotPortfolioImport onImport={importScreenshot} />
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

                {/* Dividend income — only when the book actually pays */}
                {totalAnnualIncome > 0 && (
                  <div style={{ marginTop: 6, paddingTop: 10, borderTop: `1px solid ${T.border}` }}>
                    <div style={{ ...lbl, marginBottom: 10, color: T.gold }}>Dividend Income</div>
                    {[
                      ['Annual Income',  fmtMoney(totalAnnualIncome)],
                      ['Monthly Avg',    fmtMoney(totalAnnualIncome / 12)],
                      ['Portfolio Yield', portfolioYield != null ? `${portfolioYield.toFixed(2)}%` : '—'],
                      ['Yield on Cost',  yieldOnCost != null ? `${yieldOnCost.toFixed(2)}%` : '—'],
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                        <span style={{ fontFamily: T.label, fontSize: 10, color: T.muted }}>{k}</span>
                        <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: k === 'Annual Income' || k === 'Monthly Avg' ? T.pos : T.text }}>{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Holdings table ── */}
          <div>
            {holdings.length === 0 && options.length === 0 && futures.length === 0 && cash.length === 0 ? (
              <div style={{ height: 240, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 11 }}>
                Add a stock, option, future, or cash balance, or import a portfolio file
              </div>
            ) : (<>
              {holdings.length > 0 && (
              <div style={{ background: T.surface, border: `1px solid ${T.border}`, overflow: 'hidden' }}>
                <div style={{ minHeight: 38, padding: '5px 10px 5px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottom: `1px solid ${T.border}`, background: T.bg }}>
                  <div style={{ fontFamily: T.mono, fontSize: 9, color: T.muted }}>
                    {holdings.filter(h => h.useMarketPrice).length
                      ? `${holdings.filter(h => h.useMarketPrice).length} MKT PRICE ${holdings.filter(h => h.useMarketPrice).length === 1 ? 'POSITION' : 'POSITIONS'}`
                      : 'MARK COST BASIS AS MKT PRICE TO FETCH LIVE VALUES'}
                    {marketCostResult && <span style={{ marginLeft: 10, color: marketCostResult === 'FETCH FAILED' ? T.neg : T.pos }}>{marketCostResult}</span>}
                  </div>
                  <button type="button" onClick={fetchSelectedMarketCosts}
                    disabled={fetchingMarketCosts || !holdings.some(h => h.useMarketPrice)}
                    style={{ minWidth: 76, height: 28, padding: '0 12px', background: 'transparent', border: `1px solid ${T.gold}`,
                      color: T.gold, opacity: fetchingMarketCosts || !holdings.some(h => h.useMarketPrice) ? 0.42 : 1,
                      cursor: fetchingMarketCosts || !holdings.some(h => h.useMarketPrice) ? 'default' : 'pointer',
                      fontFamily: T.label, fontSize: 8.5, fontWeight: 700, letterSpacing: '0.12em' }}>
                    {fetchingMarketCosts ? 'FETCHING…' : 'FETCH'}
                  </button>
                </div>
                <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', minWidth: 720, borderCollapse: 'collapse', fontFamily: T.mono, fontSize: 10 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${T.border}`, background: T.bg }}>
                      {['Ticker', 'Shares', 'Avg Cost', 'Price', '1D %', 'Value', 'P&L', 'Return', 'Income/yr', 'Weight', ''].map(h => (
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
                              <select value={editStock.quantityMode} onChange={e => changeEditQuantityMode(e.target.value as 'shares' | 'dollars')} style={{ ...editInp, width: 96, marginBottom: 4, textAlign: 'left' }}>
                                <option value="shares">SHARES</option>
                                <option value="dollars">DOLLAR AMOUNT</option>
                              </select>
                              <input value={editStock.quantity} onChange={e => setEditStock({ ...editStock, quantity: e.target.value })} type="number"
                                placeholder={editStock.quantityMode === 'shares' ? 'Shares' : 'Amount ($)'} style={{ ...editInp, width: 96 }}
                                onKeyDown={e => { if (e.key === 'Enter') saveEditStock(); if (e.key === 'Escape') setEditStock(null) }} autoFocus />
                            </td>
                            <td style={{ padding: '4px 8px', textAlign: 'right' }}>
                              <select value={editStock.costMode} onChange={e => setEditStock({ ...editStock, costMode: e.target.value as 'manual' | 'market' })} style={{ ...editInp, width: 86, textAlign: 'left' }}>
                                <option value="manual">AVG COST</option>
                                <option value="market">MKT PRICE</option>
                              </select>
                              {editStock.costMode === 'manual' && (
                                <input value={editStock.avgCost} onChange={e => setEditStock({ ...editStock, avgCost: e.target.value })} type="number" placeholder="Avg cost" style={{ ...editInp, marginLeft: 4 }} onKeyDown={e => { if (e.key === 'Enter') saveEditStock(); if (e.key === 'Escape') setEditStock(null) }} />
                              )}
                            </td>
                          </>) : (<>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>
                              {r.pendingInvestmentAmount
                                ? <span title="Select FETCH to convert this dollar allocation into fractional shares at the current market price" style={{ color: T.gold, whiteSpace: 'nowrap' }}>${r.pendingInvestmentAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} PENDING</span>
                                : r.shares.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: r.costIsAuto ? T.muted : T.text }}>
                              {r.loading ? '…' : r.avgCost > 0 ? <>{`$${r.avgCost.toFixed(2)}${r.costIsAuto ? '*' : ''}`}{r.costIsMarket && <span title="Cost basis is managed by MKT PRICE. Use FETCH above to refresh it." style={{ marginLeft: 5, color: T.gold, fontSize: 8, border: `1px solid ${T.gold}`, padding: '0 3px' }}>MKT</span>}</> : '—'}
                            </td>
                          </>)}
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.text }}>{r.loading ? '…' : r.price > 0 ? <>{`$${r.price.toFixed(2)}`}{(r.quoteSource === 'extended_hours' || r.quoteSource === 'alpaca_extended' || r.quoteSource === 'alpaca_overnight_indicative') && <span title={`${r.quoteSource === 'alpaca_overnight_indicative' ? 'Alpaca free overnight quote midpoint — not a BOATS trade' : r.quoteSource === 'alpaca_extended' ? 'Live Alpaca extended-hours trade' : 'Extended-hours print'}${r.quoteAsOf ? ` as of ${r.quoteAsOf}` : ''}`} style={{ color: 'var(--theme-tertiary, #60a5fa)', fontSize: 8, marginLeft: 5, border: '1px solid var(--theme-tertiary, #60a5fa)', padding: '0 3px', letterSpacing: '0.06em' }}>{r.quoteSource === 'alpaca_overnight_indicative' ? 'OVERNIGHT' : r.quoteSession === 'pre-market' ? 'PRE' : 'AH'}</span>}</> : '—'}</td>
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
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: r.annualIncome > 0 ? T.text : T.muted, whiteSpace: 'nowrap' }}>
                            {dividendsQuery.isLoading ? '…' : r.annualIncome > 0
                              ? <>{fmtMoney(r.annualIncome)}<span style={{ color: T.muted, fontSize: 9 }}> · {r.divYield.toFixed(2)}%</span></>
                              : '—'}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: T.muted }}>
                            {r.loading ? '…' : totalValue > 0 && r.price > 0 ? `${weight.toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ padding: '8px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {editStock?.i === i ? (<>
                              <button onClick={saveEditStock} style={{ ...editBtn, color: T.gold }}>Save</button>
                              <button onClick={() => setEditStock(null)} style={{ ...editBtn, color: T.muted }}>×</button>
                            </>) : (<>
                              <button onClick={() => {
                                const holding = holdings[i]
                                const quantityMode = holding.quantityMode ?? (holding.pendingInvestmentAmount ? 'dollars' : 'shares')
                                const quantity = quantityMode === 'dollars'
                                  ? holding.pendingInvestmentAmount ?? holding.shares * holding.avgCost
                                  : holding.shares
                                setEditStock({ i, quantity: String(quantity), quantityMode, avgCost: holding.avgCost > 0 ? String(holding.avgCost) : '', costMode: holding.useMarketPrice ? 'market' : 'manual' })
                              }} style={{ ...editBtn, color: T.muted }}>Edit</button>
                              <button
                                onClick={() => closeHoldingToCash(r, i)}
                                disabled={!(r.price > 0)}
                                title={r.price > 0
                                  ? 'Close at the current mark and post the proceeds to cash'
                                  : 'A live quote is required before closing'}
                                style={{ ...editBtn, color: r.price > 0 ? T.gold : T.muted, opacity: r.price > 0 ? 1 : 0.45, cursor: r.price > 0 ? 'pointer' : 'not-allowed' }}
                              >Close</button>
                              <button onClick={() => removeHolding(i)} title="Remove without posting cash" style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
                            </>)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>

                {/* Auto-cost footnote */}
                {rows.some(r => r.costIsAuto) && (
                  <div style={{ padding: '4px 12px 6px', fontSize: 9, color: T.muted, fontFamily: T.mono }}>
                    * temporary current-price preview — select MKT PRICE and press FETCH to store the quote as average cost
                  </div>
                )}

                {/* Weight bar */}
                {totalValue > 0 && (
                  <div style={{ display: 'flex', height: 4, overflow: 'hidden' }}>
                    {rows.map((r, i) => {
                      const w = (r.value / totalValue) * 100
                      const colors = ['var(--theme-primary, #c9a84c)','#60a5fa','var(--theme-positive, #22c55e)','var(--theme-negative, #ef4444)','#a78bfa','#f97316','#38bdf8','#fb923c','#4ade80','#f472b6','#facc15']
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
                        {['Position', 'Legs', 'Net Cost', 'Value', 'P&L', 'Return', 'Δ', 'Action'].map(h => (
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
                                  {/* A model price is not a traded price — say so. */}
                                  {l.mark != null && l.source?.startsWith('bs') && (
                                    <span title={l.source === 'bs-overnight'
                                      ? "Market closed. Black-Scholes off Alpaca's free overnight quote midpoint, at the chain's implied volatility."
                                      : l.source === 'bs-extended'
                                      ? "Market closed. Black-Scholes off the extended-hours underlying, at the chain's implied volatility."
                                      : 'Contract not quoted. Black-Scholes off the chain spot and implied volatility.'}
                                      style={{ color: T.muted, fontSize: 8, marginLeft: 4, border: `1px solid ${T.border}`, padding: '0 3px', letterSpacing: '0.06em' }}>
                                      {l.source === 'bs-overnight' ? 'BS OVERNIGHT' : l.source === 'bs-extended' ? 'BS AH' : 'BS'}
                                    </span>
                                  )}
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
                              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6 }}>
                                <button onClick={() => closeOptionToCash(p)} disabled={!p.priced}
                                  title={p.priced ? 'Close at the current marked liquidation value and post the proceeds to cash' : 'A live mark is required before closing'}
                                  style={{ ...editBtn, color: p.priced ? T.gold : T.muted, opacity: p.priced ? 1 : 0.45, cursor: p.priced ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap' }}>
                                  Close to Cash
                                </button>
                                <button onClick={() => removeOption(p.id)} title="Remove without posting cash"
                                  style={{ background: 'none', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
                              </div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <div style={{ padding: '4px 12px 6px', fontSize: 9, color: T.muted, fontFamily: T.mono }}>
                    Close to Cash posts the current net marked value. Short-option liabilities create a cash debit. Δ = net share-equivalent delta. BS AH and BS OVERNIGHT reprice an option from the labeled underlying mark and the chain's implied volatility.
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
                  const colors = ['var(--theme-primary, #c9a84c)','#60a5fa','var(--theme-positive, #22c55e)','var(--theme-negative, #ef4444)','#a78bfa','#f97316','#38bdf8','#fb923c','#4ade80','#f472b6','#facc15']
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

        {/* Actions — save + paper trade, anchored at the bottom */}
        {(holdings.length > 0 || options.length > 0 || futures.length > 0 || cash.length > 0) && (
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: `1px solid ${T.border}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', gap: 16 }}>
            {holdings.length > 0 && (
              <button
                onClick={() => navigate('/paper-trading')}
                title="Open Paper Trading, then Import Portfolio to mirror this book"
                style={{
                  background: 'transparent', border: `1px solid ${T.border}`, color: T.muted,
                  fontFamily: T.label, fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                  padding: '8px 20px', cursor: 'pointer', whiteSpace: 'nowrap', transition: 'background 0.2s var(--ease-out), border-color 0.2s var(--ease-out), color 0.2s var(--ease-out)',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = T.gold; e.currentTarget.style.color = T.gold }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.muted }}
              >
                Trade on Paper
              </button>
            )}
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
                  transition: 'background 0.2s var(--ease-out), border-color 0.2s var(--ease-out), color 0.2s var(--ease-out)', whiteSpace: 'nowrap',
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
          </div>
        )}
      </div>
    </>
  )
}

// Portfolio Manager and Portfolio Live are two views of the SAME book, so they
// live behind one route as tabs. This default export keeps /portfolio-manager
// working on its own; PortfolioWorkspace is what the route actually renders.
export default function PortfolioManager() {
  return (
    <PageWrapper title="Portfolio Manager">
      <PortfolioManagerContent />
    </PageWrapper>
  )
}
