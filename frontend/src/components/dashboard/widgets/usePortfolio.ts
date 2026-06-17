import { useQueries } from '@tanstack/react-query'
import axios from 'axios'

// Shared read layer for the portfolio-driven dashboard widgets (risk, P/L,
// exposure). Holdings come from the Portfolio Manager store (pm-portfolios-v2);
// live marks come from /api/market/quote. No auth needed — this is local data
// plus public quotes.

export interface Holding { ticker: string; shares: number; avgCost: number }
export interface Quote { current_price: number; pct_change_1d: number | null }

interface CashPos { amount: number; rate: number; since: string }
interface Portfolio { id: string; name: string; holdings?: Holding[]; cash?: CashPos[] }
interface PMState { portfolios: Portfolio[]; activeId: string }

function cashValue(c: CashPos): number {
  const start = new Date((c.since || '') + 'T00:00:00').getTime()
  const years = isNaN(start) ? 0 : Math.max(0, (Date.now() - start) / (365.25 * 864e5))
  return c.amount * Math.pow(1 + (c.rate || 0) / 100, years)
}

export interface ActivePortfolio { name: string; holdings: Holding[]; cash: number }

export function loadActivePortfolio(): ActivePortfolio {
  try {
    const raw = localStorage.getItem('pm-portfolios-v2')
    if (raw) {
      const d: PMState = JSON.parse(raw)
      const p = d.portfolios?.find(x => x.id === d.activeId) ?? d.portfolios?.[0]
      if (p) {
        const cash = (p.cash ?? []).reduce((s, c) => s + cashValue(c), 0)
        const holdings = (p.holdings ?? []).filter(h => h.shares > 0)
        return { name: p.name || 'Portfolio', holdings, cash }
      }
    }
  } catch { /* fall through to empty */ }
  return { name: '', holdings: [], cash: 0 }
}

export function useQuotes(tickers: string[]): Record<string, Quote | undefined> {
  const results = useQueries({
    queries: tickers.map(t => ({
      queryKey: ['pm-widget-quote', t],
      queryFn: () => axios.get(`/api/market/quote/${encodeURIComponent(t)}`).then(r => r.data as Quote),
      staleTime: 60_000,
      enabled: !!t,
    })),
  })
  const out: Record<string, Quote | undefined> = {}
  tickers.forEach((t, i) => { out[t] = results[i]?.data })
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
