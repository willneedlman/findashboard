import { useQueries } from '@tanstack/react-query'
import axios from 'axios'

interface LiveQuote {
  ticker: string
  last: number
}

export function useLiveMarks(tickers: string[]): Record<string, number | undefined> {
  const symbols = [...new Set(tickers.map(ticker => ticker.trim().toUpperCase()).filter(Boolean))]
  const results = useQueries({
    queries: symbols.map(ticker => ({
      queryKey: ['live-mark', ticker],
      queryFn: () => axios.get(`/api/market/live-quote?ticker=${encodeURIComponent(ticker)}`).then(r => r.data as LiveQuote),
      staleTime: 4_000,
      refetchInterval: 5_000,
      retry: false,
    })),
  })
  const marks: Record<string, number | undefined> = {}
  symbols.forEach((ticker, index) => {
    const last = results[index]?.data?.last
    marks[ticker] = typeof last === 'number' && last > 0 ? last : undefined
  })
  return marks
}
