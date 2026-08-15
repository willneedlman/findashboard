import { useQueries, useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { useTheme } from '../../../contexts/ThemeContext'
import { useLiveQuotes } from '../../../hooks/useLiveMarks'

// Shared formatters used across the portfolio/flow widgets.
export const money = (v: number) => `${v < 0 ? '-' : ''}$${Math.abs(Math.round(v)).toLocaleString()}`
export const hhmmss = (epoch?: number) => epoch ? new Date(epoch * 1000).toTimeString().slice(0, 8) : '—'

export interface PaperOrder {
  id: string; symbol: string; option_symbol?: string; side: string; status: string
  fill_price: number | null; quantity?: number; order_type?: string; created_at?: number; filled_at?: number
}
export interface PaperAccount {
  cash?: number; equity?: number; buying_power?: number; realized_pnl?: number; orders?: PaperOrder[]
}

// One shared, deduped paper-account query (auth headers + session token in one
// place) for every widget that needs the user's account/orders/equity.
export function usePaperAccount(enabled = true) {
  const { user } = useTheme()
  const token = typeof window !== 'undefined' ? (localStorage.getItem('ft-session-token') || '') : ''
  const query = useQuery<PaperAccount>({
    queryKey: ['paper-account-shared', user?.id],
    enabled: enabled && !!user?.id && !!token,
    staleTime: 20_000,
    refetchInterval: 20_000,
    queryFn: () => axios.get(`/api/paper/account?user_id=${user!.id}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-session-token': token },
    }).then(r => r.data),
  })
  return { ...query, user }
}

// Shared read layer for the portfolio-driven dashboard widgets (risk, P/L,
// exposure). Holdings come from the Portfolio Manager store (pm-portfolios-v2);
// live marks come from /api/market/quote. No auth needed — this is local data
// plus public quotes.

export interface Holding { ticker: string; shares: number; avgCost: number }
export interface Quote { current_price: number; pct_change_1d: number | null; prior_close?: number | null }

interface CashPos { amount: number; rate: number; since: string }
interface Portfolio { id: string; name: string; holdings?: Holding[]; cash?: CashPos[] }
// overviewIds: the "primary" selection set in Portfolio Manager. Drives what the
// homescreen Overview and the portfolio-driven widgets auto-load.
interface PMState { portfolios: Portfolio[]; activeId: string; overviewIds?: string[] }

// Merge holdings across portfolios: same ticker sums shares, share-weighted cost.
function mergeHoldings(ps: Portfolio[]): Holding[] {
  const map = new Map<string, { ticker: string; shares: number; costSum: number }>()
  for (const p of ps) for (const h of (p.holdings ?? [])) {
    const ticker = (h.ticker || '').trim().toUpperCase()
    if (!ticker) continue
    const e = map.get(ticker) ?? { ticker, shares: 0, costSum: 0 }
    e.shares += h.shares; e.costSum += h.shares * (h.avgCost || 0)
    map.set(ticker, e)
  }
  return [...map.values()].map(e => ({ ticker: e.ticker, shares: e.shares, avgCost: e.shares > 0 ? e.costSum / e.shares : 0 }))
}

function cashValue(c: CashPos): number {
  const start = new Date((c.since || '') + 'T00:00:00').getTime()
  const years = isNaN(start) ? 0 : Math.max(0, (Date.now() - start) / (365.25 * 864e5))
  return c.amount * Math.pow(1 + (c.rate || 0) / 100, years)
}

export interface ActivePortfolio { name: string; holdings: Holding[]; cash: number }

// Load a saved portfolio. With no id (or an id that no longer exists) it falls
// back to the globally active portfolio so widgets keep working after a rename.
export function loadActivePortfolio(portfolioId?: string): ActivePortfolio {
  try {
    const raw = localStorage.getItem('pm-portfolios-v2')
    if (raw) {
      const d: PMState = JSON.parse(raw)
      const all = d.portfolios ?? []
      // Explicit id wins; else the persisted Overview selection; else active; else first.
      let ids: string[] = []
      if (portfolioId) ids = [portfolioId]
      else if (d.overviewIds?.length) ids = d.overviewIds.filter(id => all.some(p => p.id === id))
      let ps = all.filter(p => ids.includes(p.id))
      if (!ps.length) { const a = all.find(x => x.id === d.activeId) || all[0]; ps = a ? [a] : [] }
      if (ps.length === 1) {
        const p = ps[0]
        const cash = (p.cash ?? []).reduce((s, c) => s + cashValue(c), 0)
        return { name: p.name || 'Portfolio', holdings: (p.holdings ?? []).filter(h => h.shares > 0), cash }
      }
      if (ps.length > 1) {
        const cash = ps.reduce((s, p) => s + (p.cash ?? []).reduce((t, c) => t + cashValue(c), 0), 0)
        return { name: `${ps.length} portfolios`, holdings: mergeHoldings(ps).filter(h => h.shares > 0), cash }
      }
    }
  } catch { /* fall through to empty */ }
  return { name: '', holdings: [], cash: 0 }
}

// Saved portfolios for a picker, plus which one is currently active.
export function listPortfolios(): { portfolios: { id: string; name: string }[]; activeId: string } {
  try {
    const raw = localStorage.getItem('pm-portfolios-v2')
    if (raw) {
      const d: PMState = JSON.parse(raw)
      return { portfolios: (d.portfolios ?? []).map(p => ({ id: p.id, name: p.name || 'Portfolio' })), activeId: d.activeId }
    }
  } catch { /* none */ }
  return { portfolios: [], activeId: '' }
}

export function useQuotes(tickers: string[]): Record<string, Quote | undefined> {
  // One batched call for the whole book. This used to fire /quote per ticker on
  // top of the per-ticker live tick, so Home issued 24 requests for 12 names and
  // then paired a price from one with a percentage from the other.
  const live = useLiveQuotes(tickers)
  const out: Record<string, Quote | undefined> = {}
  tickers.forEach(t => {
    const quote = live[t.toUpperCase()]
    if (!quote || quote.last == null) return
    out[t] = {
      current_price: quote.last,
      pct_change_1d: quote.pct_change_1d,
      prior_close: quote.prior_close,
    }
  })
  return out
}

export interface PricedPosition extends Holding {
  price: number
  value: number
  cost: number
  pnl: number
  pnlPct: number
  dayPnl: number
  pct1d: number
}

// Holdings priced at live marks, with cost basis auto-filled to mark when the
// user left avgCost blank (matches Portfolio Manager behaviour).
export function priceHoldings(holdings: Holding[], quotes: Record<string, Quote | undefined>): PricedPosition[] {
  return holdings.map(h => {
    const q = quotes[h.ticker]
    const price = q?.current_price ?? h.avgCost
    const cost = (h.avgCost > 0 ? h.avgCost : price) * h.shares
    const value = price * h.shares
    const pnl = value - cost
    const pct1d = q?.pct_change_1d ?? 0
    return {
      ...h, price, value, cost, pnl,
      pnlPct: cost > 0 ? pnl / cost : 0,
      dayPnl: value * (pct1d / 100),
      pct1d,
    }
  })
}
