import { useQueries } from '@tanstack/react-query'
import axios from 'axios'

// One payload per symbol, carrying the price and the baseline it moved from.
// Surfaces used to take the price from /live-quote and the percentage from
// /quote, which anchored the two to different baselines: a tile could show a
// risen price beside a red percentage. Everything here comes off one response.
export interface LiveQuote {
  last: number | null
  prior_close: number | null
  pct_change_1d: number | null
  basis: string | null
}

interface BatchQuote {
  current_price: number | null
  pct_change_1d: number | null
  prior_close?: number | null
  basis?: string | null
}

// /api/market/quotes caps at 50 symbols per request.
const BATCH_SIZE = 50

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

export function useLiveQuotes(tickers: string[]): Record<string, LiveQuote | undefined> {
  // Sorted so two widgets watching the same names share one cache entry rather
  // than each fetching its own copy in a different order.
  const symbols = [...new Set(tickers.map(ticker => ticker.trim().toUpperCase()).filter(Boolean))].sort()
  const batches = chunk(symbols, BATCH_SIZE)
  const results = useQueries({
    queries: batches.map(batch => ({
      queryKey: ['live-quotes', batch.join(',')],
      queryFn: () => axios
        .get(`/api/market/quotes?tickers=${encodeURIComponent(batch.join(','))}`)
        .then(r => (r.data?.quotes ?? {}) as Record<string, BatchQuote>),
      staleTime: 4_000,
      refetchInterval: 5_000,
      retry: false,
    })),
  })
  const out: Record<string, LiveQuote | undefined> = {}
  results.forEach(result => {
    for (const [ticker, quote] of Object.entries(result?.data ?? {})) {
      const last = typeof quote.current_price === 'number' && quote.current_price > 0 ? quote.current_price : null
      out[ticker] = {
        last,
        prior_close: quote.prior_close ?? null,
        pct_change_1d: quote.pct_change_1d ?? null,
        basis: quote.basis ?? null,
      }
    }
  })
  return out
}

export function useLiveMarks(tickers: string[]): Record<string, number | undefined> {
  const quotes = useLiveQuotes(tickers)
  const marks: Record<string, number | undefined> = {}
  for (const [ticker, quote] of Object.entries(quotes)) {
    marks[ticker] = quote?.last ?? undefined
  }
  return marks
}
