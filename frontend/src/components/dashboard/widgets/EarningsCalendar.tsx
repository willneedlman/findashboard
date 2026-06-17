import axios from 'axios'
import { useQueries } from '@tanstack/react-query'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import TickerLogo from '../../TickerLogo'

const T = {
  bg: 'var(--theme-bg, #101c2e)',
  border: 'var(--theme-border, rgba(255,255,255,0.08))',
  headerBg: 'var(--theme-surface, #142032)',
  gold: 'var(--theme-primary, #c9a84c)',
  text: 'var(--theme-text, #d7e3fc)',
  muted: 'var(--theme-secondary, #5e768f)',
  mono: 'var(--theme-mono)',
  label: 'var(--theme-sans)',
  pos: 'var(--theme-positive, #22c55e)',
  neg: 'var(--theme-negative, #ef4444)',
}

const DEFAULT_TICKERS = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL']

interface EarningsData {
  ticker: string
  date?: string
  horizon?: string
  implied_move?: number
  consensus?: string
}

function consensusStyle(consensus?: string): React.CSSProperties {
  if (!consensus) return { color: T.muted, background: 'transparent', border: `1px solid ${T.muted}` }
  const lower = consensus.toLowerCase()
  if (lower.includes('strong buy') || lower.includes('buy')) {
    return { color: T.pos, background: 'color-mix(in srgb, var(--theme-positive) 10%, transparent)', border: `1px solid ${T.pos}` }
  }
  if (lower.includes('underperform') || lower.includes('sell')) {
    return { color: T.neg, background: 'color-mix(in srgb, var(--theme-negative) 10%, transparent)', border: `1px solid ${T.neg}` }
  }
  return { color: T.muted, background: 'rgba(94,118,143,0.12)', border: `1px solid ${T.muted}` }
}

export default function EarningsCalendar({ config }: { config: WidgetConfig }) {
  const tickers = config.tickers ?? DEFAULT_TICKERS

  const results = useQueries({
    queries: tickers.map(t => ({
      queryKey: ['earnings', t],
      queryFn: () => axios.get(`/api/corporate/hub?ticker=${t}`).then(r => r.data as EarningsData),
      staleTime: 300_000,
    })),
  })

  const containerStyle: React.CSSProperties = {
    background: T.bg,
    fontFamily: T.mono,
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  }

  if (tickers.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span style={{ color: T.muted, fontSize: 12, fontFamily: T.label }}>Configure tickers in edit mode.</span>
        </div>
      </div>
    )
  }

  const entries = tickers.map((ticker, i) => {
    const result = results[i]
    return {
      ticker,
      isLoading: result.isLoading,
      data: result.data as EarningsData | undefined,
    }
  })

  const sorted = [...entries].sort((a, b) => {
    if (a.isLoading) return 1
    if (b.isLoading) return -1
    const da = a.data?.date ? new Date(a.data.date).getTime() : Infinity
    const db = b.data?.date ? new Date(b.data.date).getTime() : Infinity
    return da - db
  })

  return (
    <div style={containerStyle}>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {sorted.map(({ ticker, isLoading, data }, i) => {
          if (isLoading) {
            return (
              <div
                key={ticker}
                style={{
                  padding: '9px 14px',
                  borderBottom: `1px solid ${T.border}`,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <TickerLogo ticker={ticker} size={20} />
                <span style={{ color: T.gold, fontWeight: 700, fontSize: 9, fontFamily: T.label, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{ticker}</span>
                <span style={{ color: T.muted, fontSize: 9, fontFamily: T.label }}>Loading…</span>
              </div>
            )
          }

          const implied = data?.implied_move
          const cs = consensusStyle(data?.consensus)

          return (
            <div
              key={ticker}
              style={{
                padding: '5px 10px',
                borderBottom: i < sorted.length - 1 ? `1px solid ${T.border}` : 'none',
                display: 'flex', alignItems: 'center', gap: 7,
                overflow: 'hidden',
              }}
            >
              <TickerLogo ticker={ticker} size={20} />

              {/* Ticker + date stacked, fixed min-width so it doesn't squeeze */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, minWidth: 52, flexShrink: 0 }}>
                <span style={{ color: T.gold, fontWeight: 700, fontSize: 9, fontFamily: T.label, letterSpacing: '0.12em', textTransform: 'uppercase' }}>{ticker}</span>
                {data?.date && (
                  <span style={{ color: T.muted, fontSize: 9, fontFamily: T.mono }}>{data.date}</span>
                )}
              </div>

              {/* Quarter badge */}
              {data?.horizon && (
                <span style={{
                  color: 'var(--theme-tertiary, #60a5fa)', background: 'rgba(96,165,250,0.1)',
                  border: '1px solid rgba(96,165,250,0.25)', borderRadius: 2,
                  padding: '0 5px', fontSize: 9, fontFamily: T.label, whiteSpace: 'nowrap', flexShrink: 0,
                }}>
                  {data.horizon}
                </span>
              )}

              {/* Implied move */}
              {implied != null && (
                <span style={{ color: T.muted, fontSize: 10, fontFamily: T.mono, whiteSpace: 'nowrap', flexShrink: 0 }}>
                  ±{implied.toFixed(1)}%
                </span>
              )}

              {/* Consensus — pushed right, truncated if needed */}
              {data?.consensus && (
                <span style={{
                  ...cs, borderRadius: 2, padding: '0 5px',
                  fontSize: 9, fontFamily: T.label,
                  marginLeft: 'auto', whiteSpace: 'nowrap', flexShrink: 0,
                }}>
                  {data.consensus}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
