import axios from 'axios'
import { useQueries } from '@tanstack/react-query'
import { T } from '../../../lib/theme'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import TickerLogo from '../../TickerLogo'
import EmptyState from '../../EmptyState'

interface Quote {
  current_price: number | null
  pct_change_1d: number | null
}

export default function Watchlist({ config }: { config: WidgetConfig }) {
  const tickers = config.tickers?.length ? config.tickers : ['SPY', 'QQQ', 'IWM']
  const results = useQueries({
    queries: tickers.map(ticker => ({
      queryKey: ['watchlist-quote', ticker],
      queryFn: () => axios.get(`/api/market/quote/${encodeURIComponent(ticker)}`).then(r => r.data as Quote),
      staleTime: 60_000,
      refetchInterval: 60_000,
    })),
  })

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: T.bg }}>
      {tickers.map((ticker, index) => {
        const result = results[index]
        const quote = result.data
        const change = quote?.pct_change_1d
        return (
          <div key={ticker} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 13px', borderBottom: `1px solid ${T.border}` }}>
            <TickerLogo ticker={ticker} size={22} />
            <span style={{ flex: 1, color: T.text, fontFamily: T.label, fontSize: 12, fontWeight: 600 }}>{ticker}</span>
            {result.isLoading ? (
              <EmptyState variant="loading" size="compact" title="Loading quote" />
            ) : (
              <div style={{ textAlign: 'right', fontFamily: T.mono }}>
                <div style={{ color: T.text, fontSize: 12 }}>{quote?.current_price == null ? '-' : quote.current_price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                <div style={{ color: change == null ? T.muted : change >= 0 ? T.pos : T.neg, fontSize: 10 }}>
                  {change == null ? '-' : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
