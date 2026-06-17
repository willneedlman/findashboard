import { T } from '../../../lib/theme'
import axios from 'axios'
import { useQueries } from '@tanstack/react-query'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import TickerLogo from '../../TickerLogo'


interface HubData {
  ticker: string
  company_name: string | null
  current_price: number | null
  pct_change_1d: number | null
}

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.09) 50%, rgba(255,255,255,0.04) 75%)',
  backgroundSize: '200% 100%', animation: 'wl-shimmer 1.6s infinite', borderRadius: 3, height: 11,
}

export default function Watchlist({ config }: { config: WidgetConfig }) {
  const tickers = config.tickers?.length ? config.tickers : ['SPY', 'QQQ', 'IWM']

  const results = useQueries({
    queries: tickers.map(t => ({
      queryKey: ['watchlist-row-v3', t],
      queryFn: () => axios.get(`/api/corporate/hub?ticker=${encodeURIComponent(t)}`).then(r => r.data as HubData),
      staleTime: 600_000,
    })),
  })

  return (
    <div style={{ background: T.bg, width: '100%', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <style>{`@keyframes wl-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {tickers.map((ticker, i) => {
          const result = results[i]
          const data = result?.data
          const loading = result?.isLoading || !data
          const pct = data?.pct_change_1d ?? null
          const chgColor = pct == null ? T.muted : pct >= 0 ? T.pos : T.neg

          return (
            <div key={ticker} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 13px', borderBottom: `1px solid ${T.border}`, gap: 10,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                <TickerLogo ticker={ticker} size={22} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: T.label, fontSize: 12, fontWeight: 600, color: T.text }}>{ticker}</div>
                  <div style={{ fontFamily: T.label, fontSize: 9, color: T.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130 }}>
                    {loading ? '' : (data?.company_name || '—')}
                  </div>
                </div>
              </div>
              <div style={{ textAlign: 'right', fontFamily: T.mono, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {loading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                    <div style={{ ...shimmer, width: 56 }} />
                    <div style={{ ...shimmer, width: 38, height: 9 }} />
                  </div>
                ) : (
                  <>
                    <div style={{ fontSize: 12, color: T.text }}>
                      {data?.current_price != null ? data.current_price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
                    </div>
                    <div style={{ fontSize: 10, color: chgColor }}>
                      {pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
                    </div>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
