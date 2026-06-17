import { T } from '../../../lib/theme'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import type { WidgetConfig } from '../../../hooks/useDashboard'
import { hhmmss } from './usePortfolio'


interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

// Real intraday "prints" built from 1-minute bars. We don't license the OPRA/
// consolidated trade tape, so each row is one 1-min bar (close = print price,
// volume = print size); uptick/downtick is bar-over-bar.
export default function TimeAndSalesWidget({ config }: { config: WidgetConfig }) {
  const ticker = (config.ticker || 'AAPL').toUpperCase()

  const { data, isLoading } = useQuery<{ candles: Candle[] }>({
    queryKey: ['tns-ohlcv', ticker],
    queryFn: () => axios.get(`/api/market/ohlcv?ticker=${encodeURIComponent(ticker)}&interval=1m`).then(r => r.data),
    staleTime: 30_000,
    refetchInterval: 30_000,
  })

  // Header last/1D from the quote endpoint — day change is vs the prior session
  // close, which the intraday bars alone can't give.
  const { data: quote } = useQuery<{ current_price: number; pct_change_1d: number | null }>({
    queryKey: ['tns-quote', ticker],
    queryFn: () => axios.get(`/api/market/quote/${encodeURIComponent(ticker)}`).then(r => r.data),
    staleTime: 30_000,
    refetchInterval: 30_000,
  })

  const candles = data?.candles ?? []
  const recent = candles.slice(-80).reverse()
  const last = quote?.current_price ?? recent[0]?.close ?? 0
  const dayChg = quote?.pct_change_1d ?? 0
  const maxVol = Math.max(...recent.map(c => c.volume), 1)

  const lbl: React.CSSProperties = { fontFamily: T.label, fontSize: 7.5, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: T.muted }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: T.bg }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <div style={{ padding: '5px 8px', borderRight: `1px solid ${T.border}` }}>
          <div style={lbl}>{ticker}</div>
          <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.text, fontVariantNumeric: 'tabular-nums' }}>{last ? last.toFixed(2) : '—'}</div>
        </div>
        <div style={{ padding: '5px 8px', borderRight: `1px solid ${T.border}` }}>
          <div style={lbl}>1D</div>
          <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: dayChg >= 0 ? T.pos : T.neg, fontVariantNumeric: 'tabular-nums' }}>{last ? `${dayChg >= 0 ? '+' : ''}${dayChg.toFixed(2)}%` : '—'}</div>
        </div>
        <div style={{ padding: '5px 8px' }}>
          <div style={lbl}>Prints</div>
          <div style={{ fontFamily: T.mono, fontSize: 12, fontWeight: 700, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{recent.length}</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, padding: '3px 8px', borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        {['Time', 'Price', 'Size'].map((h, i) => (
          <span key={h} style={{ ...lbl, flex: i === 0 ? '0 0 62px' : 1, textAlign: i === 0 ? 'left' : 'right' }}>{h}</span>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {recent.length === 0 ? (
          <div style={{ padding: 16, textAlign: 'center', fontFamily: T.label, fontSize: 10, color: T.muted, lineHeight: 1.6 }}>
            {isLoading ? 'Loading prints…' : 'Market closed — no data available.'}
          </div>
        ) : recent.map((p, i) => {
          const prev = recent[i + 1]?.close ?? p.open
          const dir = p.close > prev ? 1 : p.close < prev ? -1 : 0
          const c = dir === 1 ? T.pos : dir === -1 ? T.neg : T.muted
          const big = p.volume >= maxVol * 0.6
          return (
            <div key={p.time} style={{ display: 'flex', gap: 8, padding: '2px 8px', borderBottom: `1px solid rgba(255,255,255,0.03)`, background: big ? 'color-mix(in srgb, var(--theme-primary) 6%, transparent)' : 'transparent' }}>
              <span style={{ flex: '0 0 62px', fontFamily: T.mono, fontSize: 9, color: T.muted, fontVariantNumeric: 'tabular-nums' }}>{hhmmss(p.time)}</span>
              <span style={{ flex: 1, textAlign: 'right', fontFamily: T.mono, fontSize: 10, fontWeight: big ? 700 : 400, color: c, fontVariantNumeric: 'tabular-nums' }}>{p.close.toFixed(2)}</span>
              <span style={{ flex: 1, textAlign: 'right', fontFamily: T.mono, fontSize: 10, color: big ? T.text : T.muted, fontVariantNumeric: 'tabular-nums' }}>{p.volume.toLocaleString()}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
